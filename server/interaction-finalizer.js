import { InteractionEventError } from './interaction-events.js';

export const FINALIZER_STATES = Object.freeze(['pending', 'event_committed', 'committed', 'projection_failed']);

export function createInteractionFinalizer({ collector } = {}) {
  if (!collector || typeof collector.collect !== 'function') throw new TypeError('Interaction Finalizer requires an Interaction Collector');

  const finalize = async ({
    request = null,
    context,
    sessionId,
    runId = null,
    parentEventId = null,
    attempt = 1,
    assistantMessage,
    correlationId = null,
    sourceRevision = '1',
    channel = '默认',
    producer = 'chat-finalizer',
    chunkSeq = null,
    resumeCursor = null,
    completionReason = 'completed',
    commit = async () => null,
    dispatch = async () => null
  } = {}) => {
    if (!assistantMessage || !String(assistantMessage.content || '').trim()) throw new InteractionEventError('EMPTY_ASSISTANT_RESULT', 'Assistant result is required');
    const state = { status: 'pending' };
    const event = await collector.collect({
      event_id: `chat:${sessionId}:${assistantMessage.id}`,
      event_type: 'conversation.assistant_message.completed',
      source_type: 'chat',
      source_id: sessionId,
      session_id: sessionId,
      source_revision: sourceRevision,
      is_final: true,
      event_status: 'final',
      run_id: runId,
      parent_event_id: parentEventId,
      content_type: 'plain_text',
      content: assistantMessage.content,
      correlation_id: correlationId || assistantMessage.id,
      producer,
      attempt,
      chunk_seq: chunkSeq,
      resume_cursor: resumeCursor,
      completion_reason: completionReason,
      structured_data: { message_id: assistantMessage.id, channel: String(channel || '默认').slice(0, 60) }
    }, { request, context, allowInternal: true, sourceId: sessionId, sessionId, producer, storageSessionId: sessionId });
    state.status = 'event_committed';

    const commitResult = await commit({ assistantMessage, event, state });
    state.status = 'committed';

    let projection = null;
    try {
      projection = await dispatch({ assistantMessage, event, state });
    } catch (error) {
      state.status = 'projection_failed';
      projection = { status: 'failed', code: error.code || 'PROJECTION_FAILED' };
    }
    return { status: state.status, event, commit: commitResult, projection };
  };

  const recordFailure = async ({
    request = null,
    context,
    sessionId,
    runId = null,
    parentEventId = null,
    attempt = 1,
    stage = 'unknown',
    code = 'CHAT_TURN_FAILED',
    retryable = false,
    chunkSeq = null,
    resumeCursor = null
  } = {}) => {
    const safeToken = (value, fallback, maxLength) => String(value || fallback).replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, maxLength);
    const safeStage = safeToken(stage, 'unknown', 80);
    const safeCode = safeToken(code, 'CHAT_TURN_FAILED', 120);
    return collector.collect({
      event_id: `chat:${sessionId}:failure:${runId || 'no-run'}:${safeStage}`,
      event_type: 'conversation.turn.failed',
      source_type: 'chat',
      source_id: sessionId,
      session_id: sessionId,
      source_revision: String(attempt),
      is_final: true,
      event_status: 'failed',
      run_id: runId,
      parent_event_id: parentEventId,
      content_type: 'plain_text',
      content: 'conversation turn failed',
      privacy_directive: 'do_not_store',
      completion_reason: safeStage,
      producer: 'chat-finalizer',
      attempt,
      chunk_seq: chunkSeq,
      resume_cursor: resumeCursor,
      structured_data: { failure_stage: safeStage, error_code: safeCode, retryable: Boolean(retryable) }
    }, { request, context, allowInternal: true, sourceId: sessionId, sessionId, producer: 'chat-finalizer', storageSessionId: sessionId });
  };

  const recordSuperseded = async ({
    request = null,
    context,
    sessionId,
    runId = null,
    parentEventId = null,
    previousMessageId,
    supersededBy,
    attempt = 1,
    chunkSeq = null,
    resumeCursor = null
  } = {}) => {
    const previousId = String(previousMessageId || '').trim();
    const nextId = String(supersededBy || '').trim();
    if (!previousId || !nextId) throw new InteractionEventError('SUPERSEDE_TARGET_REQUIRED', 'Both superseded message ids are required');
    return collector.collect({
      event_id: `chat:${sessionId}:superseded:${previousId}:${nextId}`,
      event_type: 'conversation.assistant_message.completed',
      source_type: 'chat',
      source_id: sessionId,
      session_id: sessionId,
      source_revision: String(attempt),
      is_final: true,
      event_status: 'superseded',
      run_id: runId,
      parent_event_id: parentEventId,
      content_type: 'plain_text',
      content: 'assistant event superseded',
      privacy_directive: 'do_not_store',
      completion_reason: 'regenerated',
      producer: 'chat-finalizer',
      attempt,
      chunk_seq: chunkSeq,
      resume_cursor: resumeCursor,
      structured_data: { message_id: previousId, superseded_by: nextId }
    }, { request, context, allowInternal: true, sourceId: sessionId, sessionId, producer: 'chat-finalizer', storageSessionId: sessionId });
  };

  return { finalize, recordFailure, recordSuperseded };
}
