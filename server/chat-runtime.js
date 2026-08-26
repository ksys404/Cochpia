import { createChatStreamJournal } from './chat-stream-journal.js';
import { createSseEvent, formatSseEvent, replaySseEvents } from './sse.js';
import { isChatRunTerminal, transitionChatRun } from './chat-run-state.js';
import { appendChatStreamEventRecord, createChatStreamRunRecord, finishChatStreamRunRecord, loadChatStreamRunRecord, pruneChatStreamRunRecords, removeChatStreamRunRecords } from './store.js';

export function createCompanionChatRuntime({
  state,
  storageProvider = 'json',
  retentionMs = Math.max(30_000, Number(process.env.SSE_RUN_RETENTION_MS || 300_000)),
  maxEvents = Number(process.env.SSE_JOURNAL_MAX_EVENTS || 5_000)
} = {}) {
  if (!state || typeof state !== 'object') throw new TypeError('Chat runtime state is required');

  const activeRuns = new Map();
  const activeGroupRuns = new Set();
  const pendingRunReservations = new Set();
  const streamRuns = new Map();
  const pendingApprovals = new Map();
  const waitForApproval = (runId, toolCallId) => new Promise(resolve => { pendingApprovals.set(`${runId}:${toolCallId}`, resolve); });
  const chatStreamJournal = createChatStreamJournal({
    retentionMs,
    maxEvents,
    storage: storageProvider === 'postgres' ? {
      create: createChatStreamRunRecord,
      append: appendChatStreamEventRecord,
      finish: finishChatStreamRunRecord,
      load: loadChatStreamRunRecord,
      remove: removeChatStreamRunRecords,
      prune: pruneChatStreamRunRecords
    } : null
  });
  void chatStreamJournal.prune().catch(error => console.error(JSON.stringify({ event: 'chat_stream_journal_prune_failed', code: error.code || 'CHAT_STREAM_JOURNAL_PRUNE_FAILED' })));

  const streamProvenance = run => {
    if (!run?.id || !Number.isSafeInteger(run.sequence)) return { chunkSeq: null, resumeCursor: null };
    return { chunkSeq: run.sequence, resumeCursor: `${run.id}:${run.sequence}` };
  };

  const send = (res, event, data, run) => {
    if (!run) return false;
    const entry = createSseEvent(run, event, data);
    if (!run.journalDisabled) {
      run.journalWrite = (run.journalWrite || Promise.resolve())
        .then(() => chatStreamJournal.append({ userId: run.userId, runId: run.id, entry }))
        .catch(error => {
          run.journalError = error.code || 'CHAT_STREAM_JOURNAL_APPEND_FAILED';
          console.error(JSON.stringify({ event: 'chat_stream_journal_append_failed', code: run.journalError, runId: run.id }));
        });
    }
    const target = run.response || res;
    if (!target || target.writableEnded || target.destroyed) return false;
    target.write(formatSseEvent(entry));
    return true;
  };

  const hasActiveUserInteraction = userId => [...activeRuns.values()].some(run => run.userId === userId)
    || [...activeGroupRuns].some(key => key.startsWith(`${userId}:`))
    || state.sessions.some(session => pendingRunReservations.has(`${userId}:${session.id}`));

  const disableChatStreamJournals = ({ userId, sessionId = null } = {}) => {
    for (const run of streamRuns.values()) {
      if (run.userId !== userId || (sessionId && run.sessionId !== sessionId)) continue;
      run.journalDisabled = true;
      run.cancelled = true;
      run.controller.abort();
    }
  };

  const finishRun = async (run, terminalState = 'completed') => {
    if (run.finished) return;
    const nextState = run.cancelled ? 'cancelled' : terminalState;
    if (!isChatRunTerminal(run)) transitionChatRun(run, nextState, { resumeCursor: streamProvenance(run).resumeCursor });
    run.finished = true;
    if (activeRuns.get(run.key) === run) activeRuns.delete(run.key);
    if (run.heartbeat) clearInterval(run.heartbeat);
    try {
      await run.journalWrite;
      await chatStreamJournal.finish({ userId: run.userId, runId: run.id, state: run.state });
    } catch (error) {
      run.journalError = error.code || 'CHAT_STREAM_JOURNAL_FINISH_FAILED';
      console.error(JSON.stringify({ event: 'chat_stream_journal_finish_failed', code: run.journalError, runId: run.id }));
    }
    setTimeout(() => { if (streamRuns.get(run.id) === run) streamRuns.delete(run.id); }, retentionMs).unref?.();
  };

  const attachStreamResponse = (run, res, afterId = '') => {
    if (!run.finished && run.state === 'created') transitionChatRun(run, 'streaming');
    else if (!run.finished && run.state === 'disconnected') transitionChatRun(run, 'streaming');
    run.response = res;
    run.connected = true;
    res.status(200).set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    for (const entry of replaySseEvents(run.events, afterId)) {
      if (!res.writableEnded && !res.destroyed) res.write(formatSseEvent(entry));
    }
    const heartbeat = setInterval(() => {
      if (run.finished || run.response !== res) return clearInterval(heartbeat);
      send(res, 'heartbeat', { runId: run.id, at: new Date().toISOString() }, run);
    }, 15_000);
    res.on('close', () => {
      clearInterval(heartbeat);
      if (run.response === res) {
        run.response = null;
        run.connected = false;
        if (!run.finished && run.state === 'streaming') transitionChatRun(run, 'disconnected', { resumeCursor: run.events.at(-1)?.id || null });
      }
    });
  };

  const hydrateDurableStreamRun = record => {
    const sequence = record.events.reduce((max, entry) => Math.max(max, Number(String(entry.id).split(':').at(-1)) || 0), 0);
    return {
      id: record.runId,
      key: `${record.userId}:${record.sessionId}`,
      userId: record.userId,
      sessionId: record.sessionId,
      attempt: record.attempt,
      failureContext: null,
      parentEventId: null,
      controller: new AbortController(),
      cancelled: record.state === 'cancelled',
      finished: true,
      state: record.state,
      stateRevision: 1,
      stateChangedAt: record.updatedAt,
      stateReason: 'durable_replay',
      lastResumeCursor: record.events.at(-1)?.id || null,
      sequence,
      events: record.events,
      response: null,
      connected: false,
      journalWrite: Promise.resolve(),
      journalError: null,
      journalDisabled: false
    };
  };

  return {
    activeGroupRuns,
    activeRuns,
    attachStreamResponse,
    chatStreamJournal,
    disableChatStreamJournals,
    finishRun,
    hasActiveUserInteraction,
    hydrateDurableStreamRun,
    pendingApprovals,
    pendingRunReservations,
    send,
    streamProvenance,
    streamRuns,
    waitForApproval
  };
}
