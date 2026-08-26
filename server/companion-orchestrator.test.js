import test from 'node:test';
import assert from 'node:assert/strict';
import { createCompanionOrchestrator } from './companion-orchestrator.js';

test('Orchestrator prepares a chat turn through Collector, retrieval, and Context Builder', async () => {
  const calls = [];
  const orchestrator = createCompanionOrchestrator({
    collector: { collect: async input => { calls.push(['collect', input.event_type]); return { envelope: input, rawEventId: 'raw-user' }; } },
    contextBuilder: { build: input => ({ ...input, built: true }) },
    finalizer: { finalize: async input => ({ input }) }
  });
  const result = await orchestrator.prepareChatTurn({
    context: { tenantId: 'tenant-orchestrator', subjectUserId: 'user-orchestrator', actorType: 'user', actorId: 'user-orchestrator' },
    sessionId: 'session-1',
    userMessage: { id: 'user-1', content: 'hello' },
    retrieve: async () => ({ bundle: { answerability: 'not_found' }, recalled: [] }),
    contextInput: { identity: { userId: 'user-orchestrator' } }
  });
  assert.deepEqual(calls, [['collect', 'conversation.user_message.created']]);
  assert.equal(result.userEvent.rawEventId, 'raw-user');
  assert.equal(result.runtimeContext.built, true);
  assert.equal(result.retrievalError, null);
});

test('Orchestrator keeps collection authoritative when retrieval is temporarily unavailable', async () => {
  const calls = [];
  const retrievalError = Object.assign(new Error('memory unavailable'), { code: 'MEMORY_UNAVAILABLE', status: 503, retryable: true });
  const orchestrator = createCompanionOrchestrator({
    collector: { collect: async input => { calls.push(['collect', input.event_type]); return { envelope: input, rawEventId: 'raw-user' }; } },
    contextBuilder: { build: input => ({ recalled: input.recalled, built: true }) },
    finalizer: { finalize: async input => ({ input }) }
  });
  const result = await orchestrator.prepareChatTurn({
    context: { tenantId: 'tenant-orchestrator', subjectUserId: 'user-orchestrator', actorType: 'user', actorId: 'user-orchestrator' },
    sessionId: 'session-2',
    userMessage: { id: 'user-2', content: 'hello' },
    retrieve: async () => { throw retrievalError; }
  });
  assert.deepEqual(calls, [['collect', 'conversation.user_message.created']]);
  assert.equal(result.userEvent.rawEventId, 'raw-user');
  assert.equal(result.runtimeContext.built, true);
  assert.equal(result.retrievalError, retrievalError);
  assert.deepEqual(result.retrieved, { bundle: null, recalled: [] });
});

test('Orchestrator does not build context after collection fails', async () => {
  let retrieved = false;
  let built = false;
  const error = Object.assign(new Error('collector unavailable'), { code: 'COLLECTOR_UNAVAILABLE', status: 503 });
  const orchestrator = createCompanionOrchestrator({
    collector: { collect: async () => { throw error; } },
    contextBuilder: { build: () => { built = true; return {}; } },
    finalizer: { finalize: async input => ({ input }) }
  });
  await assert.rejects(() => orchestrator.prepareChatTurn({
    context: { tenantId: 'tenant-orchestrator', subjectUserId: 'user-orchestrator', actorType: 'user', actorId: 'user-orchestrator' },
    sessionId: 'session-3',
    userMessage: { id: 'user-3', content: 'hello' },
    retrieve: async () => { retrieved = true; return { bundle: null, recalled: [] }; }
  }), candidate => candidate === error);
  assert.equal(retrieved, false);
  assert.equal(built, false);
});

test('Orchestrator replays the message source revision when preparing an edited turn', async () => {
  let collected = null;
  const orchestrator = createCompanionOrchestrator({
    collector: { collect: async input => { collected = input; return { envelope: input, rawEventId: 'raw-edited-user' }; } },
    contextBuilder: { build: input => input },
    finalizer: { finalize: async input => ({ input }) }
  });
  await orchestrator.prepareChatTurn({
    context: { tenantId: 'tenant-orchestrator', subjectUserId: 'user-orchestrator', actorType: 'user', actorId: 'user-orchestrator' },
    sessionId: 'session-1',
    userMessage: { id: 'user-1', content: 'edited hello', sourceRevision: '2' }
  });
  assert.equal(collected.source_revision, '2');
});
