import { createMemoryModuleWorker } from './memory-module-worker.js';
import { extractCandidates } from './memory-module-extraction.js';
import { featureEnabled } from './memory-module-flags.js';
import { isSupersededSourceEvent } from './memory-module-event-order.js';

export async function processExtractionEvent({ state, memory, event, workerId, modelGateway = null, allowSensitiveModelInput = false, featureFlags = { autoExtract: true }, assertLease = () => {} } = {}) {
  if (!event) return { status: 'invalid_event', candidateCount: 0 };
  if (!featureEnabled(featureFlags, 'autoExtract')) return { status: 'feature_disabled', candidateCount: 0 };
  const sourceEvent = state.rawEvents?.find(item => item.id === event.aggregateId);
  if (!sourceEvent || sourceEvent.isStreamFinal === false) return { status: 'awaiting_finalization', candidateCount: 0 };
  if (isSupersededSourceEvent(state.rawEvents, sourceEvent)) return { status: 'superseded_revision', candidateCount: 0 };
  const extracted = await extractCandidates({ event: sourceEvent, modelGateway, allowSensitiveModelInput });
  assertLease();
  if (extracted.status === 'blocked_s3' || extracted.status === 'quarantined_sensitive_input' || extracted.status === 'invalid_event') return { status: extracted.status, candidateCount: 0 };
  const context = { tenantId: sourceEvent.tenantId, subjectUserId: sourceEvent.userId, actorType: 'system', actorId: workerId, callerAgentId: 'cochpia', sessionId: sourceEvent.sessionId };
  let candidateCount = 0;
  for (const candidate of extracted.candidates) {
    assertLease();
    const result = await memory.createCandidate(context, candidate);
    if (result.status !== 'duplicate') candidateCount += 1;
  }
  return { status: extracted.status, candidateCount };
}

export function createMemoryExtractionWorker({ state, memory, workerId, modelGateway = null, allowSensitiveModelInput = false, featureFlags = { autoExtract: true }, persist = async () => {}, maxAttempts = 5, leaseMs = 30_000 } = {}) {
  if (!memory) throw new TypeError('Memory domain service is required');
  return createMemoryModuleWorker({
    state,
    workerId,
    persist,
    maxAttempts,
    leaseMs,
    processEvent: args => processExtractionEvent({ state, memory, workerId, modelGateway, allowSensitiveModelInput, featureFlags, event: args.event, assertLease: args.assertLease })
  });
}
