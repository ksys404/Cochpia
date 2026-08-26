import { randomUUID } from 'node:crypto';
import { normalizeInteractionEvent } from './interaction-events.js';

export const INTERACTION_OUTBOX_STATUSES = Object.freeze(['pending', 'processing', 'completed', 'dead_letter']);
export const DEFAULT_INTERACTION_OUTBOX_LEASE_MS = 30_000;
export const DEFAULT_INTERACTION_OUTBOX_MAX_ATTEMPTS = 5;

const clone = value => value == null ? value : structuredClone(value);
const nowIso = value => new Date(value || Date.now()).toISOString();
const pendingContext = Object.freeze({
  tenantId: 'interaction-outbox-pending-tenant',
  subjectUserId: 'interaction-outbox-pending-user',
  actorType: 'user',
  actorId: 'interaction-outbox-pending-user',
  callerAgentId: 'cochpia'
});

function canonicalInput(input, now) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Interaction outbox input must be an object');
  const normalized = normalizeInteractionEvent(input, pendingContext, {
    now: nowIso(now),
    sourceId: input.source_id ?? input.sourceId,
    sessionId: input.session_id ?? input.sessionId ?? undefined,
    producer: input.producer
  });
  if (normalized.event_class !== 'ingress') throw new TypeError('Interaction outbox only accepts ingress events');
  return {
    schema_version: normalized.schema_version,
    event_id: normalized.event_id,
    event_type: normalized.event_type,
    source_type: normalized.source_type,
    source_id: normalized.source_id,
    session_id: normalized.session_id,
    occurred_at: normalized.occurred_at,
    source_revision: normalized.source_revision,
    is_final: normalized.is_final,
    event_status: normalized.event_status,
    content_type: normalized.content_type,
    content: normalized.content,
    structured_data: normalized.structured_data,
    privacy_directive: normalized.privacy_directive,
    idempotency_key: normalized.idempotency_key,
    correlation_id: normalized.correlation_id,
    causation_id: normalized.causation_id,
    producer: normalized.producer,
    run_id: normalized.run_id,
    parent_event_id: normalized.parent_event_id,
    chunk_seq: normalized.chunk_seq,
    attempt: normalized.attempt,
    completion_reason: normalized.completion_reason,
    resume_cursor: normalized.resume_cursor
  };
}

export function ensureInteractionOutbox(state) {
  if (!state || typeof state !== 'object') throw new TypeError('Interaction outbox state is required');
  state.companion ||= {};
  state.companion.interactionOutbox ||= [];
  return state.companion.interactionOutbox;
}

export function enqueueInteractionEvent(state, input, { now = new Date() } = {}) {
  const outbox = ensureInteractionOutbox(state);
  const eventInput = canonicalInput(input, now);
  const existing = outbox.find(entry => entry.idempotencyKey === eventInput.idempotency_key);
  if (existing) return { entry: clone(existing), duplicate: true };
  const timestamp = nowIso(now);
  const entry = {
    id: randomUUID(),
    idempotencyKey: eventInput.idempotency_key,
    eventInput,
    status: 'pending',
    attempts: 0,
    leaseOwner: null,
    leaseUntil: null,
    nextAttemptAt: timestamp,
    lastErrorCode: null,
    rawEventId: null,
    commitSeq: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    completedAt: null
  };
  outbox.push(entry);
  return { entry: clone(entry), duplicate: false };
}

export function reconcileInteractionOutbox(state, inputs = [], { now = new Date(), limit = 100 } = {}) {
  if (!Array.isArray(inputs)) throw new TypeError('Interaction outbox reconciliation inputs must be an array');
  const boundedLimit = Math.max(1, Math.min(500, Number(limit) || 100));
  const candidates = inputs.slice(0, boundedLimit);
  const repaired = [];
  const existing = [];
  const rejected = [];
  for (const input of candidates) {
    try {
      const result = enqueueInteractionEvent(state, input, { now });
      const entry = result.entry;
      const summary = { id: entry.id, idempotencyKey: entry.idempotencyKey, status: entry.status };
      (result.duplicate ? existing : repaired).push(summary);
    } catch (error) {
      rejected.push({
        eventId: input?.event_id || input?.eventId || null,
        idempotencyKey: input?.idempotency_key || input?.idempotencyKey || null,
        code: error?.code || 'INTERACTION_OUTBOX_RECONCILIATION_REJECTED'
      });
    }
  }
  return { considered: candidates.length, truncated: inputs.length > candidates.length, repaired, existing, rejected };
}

function recoverExpiredLeases(outbox, now) {
  const timestamp = new Date(now).getTime();
  for (const entry of outbox) {
    if (entry.status !== 'processing' || !entry.leaseUntil) continue;
    if (new Date(entry.leaseUntil).getTime() <= timestamp) {
      entry.status = 'pending';
      entry.leaseOwner = null;
      entry.leaseUntil = null;
      entry.nextAttemptAt = nowIso(now);
      entry.updatedAt = nowIso(now);
    }
  }
}

function claimNext(outbox, { now, workerId, leaseMs, maxAttempts }) {
  recoverExpiredLeases(outbox, now);
  const timestamp = new Date(now).getTime();
  const entry = outbox
    .filter(item => item.status === 'pending' && (!item.nextAttemptAt || new Date(item.nextAttemptAt).getTime() <= timestamp))
    .sort((left, right) => new Date(left.createdAt) - new Date(right.createdAt))[0];
  if (!entry) return null;
  if (entry.attempts >= maxAttempts) {
    entry.status = 'dead_letter';
    entry.updatedAt = nowIso(now);
    return null;
  }
  entry.status = 'processing';
  entry.attempts += 1;
  entry.leaseOwner = workerId;
  entry.leaseUntil = new Date(timestamp + leaseMs).toISOString();
  entry.updatedAt = nowIso(now);
  return entry;
}

function markCompleted(entry, result, now) {
  entry.status = 'completed';
  entry.leaseOwner = null;
  entry.leaseUntil = null;
  entry.lastErrorCode = null;
  entry.rawEventId = result?.rawEventId || result?.storage?.rawEventId || null;
  entry.commitSeq = result?.commitSeq ?? result?.storage?.commitSeq ?? null;
  entry.completedAt = nowIso(now);
  entry.updatedAt = entry.completedAt;
}

function markFailed(entry, error, { now, maxAttempts }) {
  const code = error?.code || 'INTERACTION_EVENT_DISPATCH_FAILED';
  entry.status = entry.attempts >= maxAttempts ? 'dead_letter' : 'pending';
  entry.leaseOwner = null;
  entry.leaseUntil = null;
  entry.lastErrorCode = code;
  entry.nextAttemptAt = new Date(new Date(now).getTime() + Math.min(300_000, 1_000 * (2 ** Math.max(0, entry.attempts - 1)))).toISOString();
  entry.updatedAt = nowIso(now);
}

export function createInteractionOutboxDispatcher({
  state,
  dispatch,
  persist = async () => {},
  now = () => new Date(),
  leaseMs = DEFAULT_INTERACTION_OUTBOX_LEASE_MS,
  maxAttempts = DEFAULT_INTERACTION_OUTBOX_MAX_ATTEMPTS,
  workerId = `companion-outbox-${randomUUID()}`
} = {}) {
  if (!state || typeof state !== 'object') throw new TypeError('Interaction outbox dispatcher state is required');
  if (typeof dispatch !== 'function') throw new TypeError('Interaction outbox dispatcher requires dispatch');
  if (typeof persist !== 'function') throw new TypeError('Interaction outbox dispatcher persist must be a function');
  let running = false;

  const flush = async ({ request = null, limit = 20 } = {}) => {
    if (running) return { skipped: true, processed: 0, completed: 0, failed: 0, pending: ensureInteractionOutbox(state).filter(item => item.status === 'pending').length };
    running = true;
    const stats = { skipped: false, processed: 0, completed: 0, failed: 0, pending: 0 };
    try {
      const boundedLimit = Math.max(1, Math.min(100, Number(limit) || 20));
      for (let index = 0; index < boundedLimit; index += 1) {
        const timestamp = now();
        const entry = claimNext(ensureInteractionOutbox(state), {
          now: timestamp,
          workerId,
          leaseMs: Math.max(1000, Number(leaseMs) || DEFAULT_INTERACTION_OUTBOX_LEASE_MS),
          maxAttempts: Math.max(1, Number(maxAttempts) || DEFAULT_INTERACTION_OUTBOX_MAX_ATTEMPTS)
        });
        if (!entry) break;
        await persist();
        stats.processed += 1;
        try {
          const result = await dispatch({ entry: clone(entry), request });
          markCompleted(entry, result, now());
          stats.completed += 1;
        } catch (error) {
          markFailed(entry, error, { now: now(), maxAttempts: Math.max(1, Number(maxAttempts) || DEFAULT_INTERACTION_OUTBOX_MAX_ATTEMPTS) });
          stats.failed += 1;
        }
        await persist();
      }
      stats.pending = ensureInteractionOutbox(state).filter(item => item.status === 'pending' || item.status === 'processing').length;
      return stats;
    } finally {
      running = false;
    }
  };

  return { flush };
}

export { canonicalInput };
