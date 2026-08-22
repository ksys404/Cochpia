import { randomUUID } from 'node:crypto';

const nowMs = value => value instanceof Date ? value.getTime() : new Date(value || Date.now()).getTime();

function ensureWorkerState(state) {
  state.outboxEvents ||= [];
  state.jobAttempts ||= [];
  return state;
}

function unsupportedSchemaError(event, supportedSchemaVersions) {
  // Legacy in-memory fixtures/events predate the explicit field and are
  // treated as V1; an explicitly supplied unknown version is still rejected.
  const version = Number(event?.schemaVersion ?? 1);
  if (Number.isInteger(version) && supportedSchemaVersions.includes(version)) return null;
  const error = new Error('Outbox event schema version is not supported by this worker');
  error.code = 'UNSUPPORTED_OUTBOX_SCHEMA';
  error.retryable = false;
  error.eventSchemaVersion = Number.isFinite(version) ? version : null;
  return error;
}

function isRedacted(state, event) {
  const sourceEvent = state.rawEvents?.find(rawEvent => rawEvent.id === event.aggregateId);
  if (sourceEvent && state.tombstones?.some(tombstone => tombstone.targetType === 'account' && tombstone.tenantId === sourceEvent.tenantId && tombstone.userId === sourceEvent.userId)) return true;
  if (sourceEvent && sourceEvent.sessionId && state.tombstones?.some(tombstone => tombstone.targetType === 'session' && tombstone.targetId === sourceEvent.sessionId && tombstone.tenantId === sourceEvent.tenantId && tombstone.userId === sourceEvent.userId)) return true;
  if (event.type === 'raw_event.created') {
    return state.tombstones?.some(tombstone => tombstone.targetType === 'source_event' && tombstone.targetId === event.aggregateId)
      || !state.rawEvents?.some(rawEvent => rawEvent.id === event.aggregateId);
  }
  if (event.type === 'assertion.active') {
    const assertion = state.assertions?.find(item => item.id === event.aggregateId);
    return !assertion || ['revoked', 'forgotten', 'rejected', 'expired'].includes(assertion.status);
  }
  return false;
}

function claim(state, workerId, { now = new Date(), leaseMs = 30_000 } = {}) {
  const timestamp = nowMs(now);
  const event = state.outboxEvents.find(item => item.status === 'pending'
    || (item.status === 'processing' && item.leaseUntil && nowMs(item.leaseUntil) <= timestamp));
  if (!event) return null;
  event.status = 'processing';
  event.leaseOwner = workerId;
  event.leaseUntil = new Date(timestamp + leaseMs).toISOString();
  event.attempts = Number(event.attempts || 0) + 1;
  const attempt = { id: randomUUID(), outboxEventId: event.id, workerId, attempt: event.attempts, startedAt: new Date(timestamp).toISOString(), status: 'processing', errorCode: null };
  state.jobAttempts.push(attempt);
  return { event, attempt };
}

function assertLease(event, workerId, now = new Date()) {
  if (event.leaseOwner !== workerId || !event.leaseUntil || nowMs(event.leaseUntil) <= nowMs(now)) {
    const error = new Error('Outbox lease is no longer owned by this worker');
    error.code = 'WORKER_FENCED';
    throw error;
  }
}

export function createMemoryModuleWorker({ state, persist = async () => {}, workerId = randomUUID(), processEvent = async () => ({ status: 'processed' }), maxAttempts = 5, leaseMs = 30_000, supportedSchemaVersions = [1] } = {}) {
  if (!state) throw new TypeError('Worker state is required');
  ensureWorkerState(state);
  if (!Array.isArray(supportedSchemaVersions) || !supportedSchemaVersions.length || supportedSchemaVersions.some(version => !Number.isInteger(Number(version)) || Number(version) < 1)) throw new TypeError('supportedSchemaVersions must contain positive integers');
  const acceptedSchemaVersions = [...new Set(supportedSchemaVersions.map(Number))];

  const runClaimed = async ({ event, attempt = null, now = new Date(), clock = () => new Date() } = {}) => {
    if (!event) return { status: 'idle' };
    const currentAttempt = attempt || { id: randomUUID(), outboxEventId: event.id, workerId, attempt: event.attempts || 1, startedAt: new Date(nowMs(now)).toISOString(), status: 'processing', errorCode: null };
    if (!attempt) state.jobAttempts.push(currentAttempt);
    try {
      assertLease(event, workerId, now);
      const schemaError = unsupportedSchemaError(event, acceptedSchemaVersions);
      if (schemaError) {
        event.status = 'dead_letter';
        event.result = 'unsupported_schema';
        event.lastErrorCode = schemaError.code;
        event.deliveredAt = new Date().toISOString();
        event.leaseOwner = null;
        event.leaseUntil = null;
        currentAttempt.status = 'failed';
        currentAttempt.errorCode = schemaError.code;
        currentAttempt.completedAt = new Date().toISOString();
        await persist();
        return { status: 'dead_letter', eventId: event.id, result: event.result, errorCode: schemaError.code, retryable: false };
      }
      if (isRedacted(state, event)) {
        event.status = 'completed';
        event.result = 'redacted_before_processing';
      } else {
        const checkLiveLease = () => assertLease(event, workerId, clock());
        const result = await processEvent({ event, state, workerId, assertLease: checkLiveLease });
        checkLiveLease();
        event.status = result?.status === 'feature_disabled' ? 'pending' : 'completed';
        event.result = result?.status || 'processed';
      }
      event.deliveredAt = new Date().toISOString();
      event.leaseOwner = null;
      event.leaseUntil = null;
      currentAttempt.status = 'completed';
      currentAttempt.completedAt = new Date().toISOString();
      await persist();
      return { status: 'completed', eventId: event.id, result: event.result };
    } catch (error) {
      const code = error.code || 'WORKER_PROCESSING_FAILED';
      currentAttempt.status = code === 'WORKER_FENCED' ? 'fenced' : 'failed';
      currentAttempt.errorCode = code;
      currentAttempt.completedAt = new Date().toISOString();
      event.lastErrorCode = code;
      event.leaseOwner = null;
      event.leaseUntil = null;
      if (code === 'WORKER_FENCED' || event.attempts >= maxAttempts) event.status = code === 'WORKER_FENCED' ? 'pending' : 'dead_letter';
      else event.status = 'pending';
      await persist();
      if (code === 'WORKER_FENCED') return { status: 'fenced', eventId: event.id, retryable: true };
      return { status: event.status, eventId: event.id, errorCode: code, retryable: event.status === 'pending' };
    }
  };

  const runOnce = async ({ now = new Date(), clock = () => new Date() } = {}) => {
    const claimed = claim(state, workerId, { now, leaseMs });
    if (!claimed) return { status: 'idle' };
    const { event, attempt } = claimed;
    await persist();
    return runClaimed({ event, attempt, now, clock });
  };

  return { workerId, runOnce, runClaimed, claim: options => claim(state, workerId, options), state };
}
