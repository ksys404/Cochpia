import { randomUUID } from 'node:crypto';
import { createInteractionOutboxDispatcher, enqueueInteractionEvent, reconcileInteractionOutbox } from './interaction-outbox.js';

const redactInteractionText = value => String(value ?? '')
  .replace(/(?:sk|rk)-[A-Za-z0-9_-]{16,}/gi, '[redacted]')
  .replace(/AKIA[0-9A-Z]{16}/gi, '[redacted]')
  .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gi, '[redacted]')
  .replace(/\b\d{13,19}\b/g, '[redacted]')
  .replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[redacted]')
  .slice(0, 500);

const productInteractionInput = ({
  eventType,
  producer,
  sourceType,
  sourceId,
  sessionId = null,
  content,
  structuredData,
  correlationId = sourceId,
  eventId = `${sourceType}:${sourceId}:${randomUUID()}`,
  idempotencyKey = eventId
}) => ({
  event_id: eventId,
  event_type: eventType,
  source_type: sourceType,
  source_id: sourceId,
  session_id: sessionId,
  source_revision: '1',
  is_final: true,
  event_status: 'final',
  content_type: 'structured',
  content: redactInteractionText(content),
  structured_data: structuredData,
  privacy_directive: 'default',
  idempotency_key: idempotencyKey,
  correlation_id: correlationId,
  producer
});

export function createCompanionInteractionAdapters({
  state,
  persist = async () => {},
  memoryRuntime,
  interactionCollector,
  relationships,
  lifeState,
  growthEvidence
} = {}) {
  if (!state || typeof state !== 'object') throw new TypeError('Interaction adapters require state');
  if (typeof persist !== 'function') throw new TypeError('Interaction adapters require persist');
  if (!memoryRuntime?.contextFromRequest || !memoryRuntime?.ensureChatSession) throw new TypeError('Interaction adapters require Memory Module runtime');
  if (!interactionCollector?.collect) throw new TypeError('Interaction adapters require Interaction Collector');
  if (!relationships?.relationshipId || !relationships?.observe) throw new TypeError('Interaction adapters require Relationship state');
  if (!lifeState?.markEventStatus) throw new TypeError('Interaction adapters require LifeState');
  if (!growthEvidence?.growFromSourceEvent) throw new TypeError('Interaction adapters require growth evidence');

  const queueProductInteraction = (input, { required = false } = {}) => {
    try {
      const result = enqueueInteractionEvent(state, input);
      return result.entry ? { ...result.entry, newlyEnqueued: !result.duplicate } : null;
    } catch (error) {
      const outboxError = Object.assign(error, {
        code: error.code || 'INTERACTION_OUTBOX_ENQUEUE_FAILED',
        status: error.status || 503,
        retryable: error.retryable ?? true
      });
      console.error(JSON.stringify({ event: 'interaction_outbox_enqueue_failed', code: outboxError.code }));
      if (required) throw outboxError;
      return null;
    }
  };

  const rollbackInteractionOutbox = async ({ notification } = {}) => {
    if (!notification?.newlyEnqueued || !notification.id) return;
    const outbox = state.companion?.interactionOutbox || [];
    const index = outbox.findIndex(item => item.id === notification.id);
    if (index !== -1) outbox.splice(index, 1);
  };

  const taskInteractionInput = ({ action, task, mutationId = null }) => productInteractionInput({
    eventType: `task.${action}`,
    producer: 'task-adapter',
    sourceType: 'task',
    sourceId: task.id,
    sessionId: task.sessionId || null,
    eventId: `task:${task.id}:${action}:${mutationId || task.updatedAt || task.createdAt}`,
    content: `Task ${action}`,
    structuredData: {
      task_id: task.id,
      title: redactInteractionText(task.title),
      status: task.status,
      due_at: task.dueAt,
      session_id: task.sessionId || null
    }
  });

  const calendarInteractionInput = ({ action, event, mutationId = null }) => productInteractionInput({
    eventType: `calendar.event.${action}`,
    producer: 'calendar-adapter',
    sourceType: 'calendar',
    sourceId: event.id,
    eventId: `calendar:${event.id}:${action}:${mutationId || event.updatedAt || event.createdAt}`,
    content: `Calendar event ${action}`,
    structuredData: {
      calendar_event_id: event.id,
      type: event.type,
      title: redactInteractionText(event.title),
      date: event.date,
      visibility: redactInteractionText(event.visibility)
    }
  });

  const pendingLifeInteractionInputs = ({ context } = {}) => {
    const fallbackSourceId = `life:${context?.subjectUserId}`;
    return (state.lifeState?.commandLog || [])
      .filter(command => command?.eventStatus === 'pending' && command.eventId && command.idempotencyKey && command.eventType)
      .map(command => {
        const sessionId = command.sessionId || null;
        return productInteractionInput({
          eventType: command.eventType,
          producer: 'life-adapter',
          sourceType: 'game',
          sourceId: sessionId || fallbackSourceId,
          sessionId,
          eventId: command.eventId,
          idempotencyKey: command.idempotencyKey,
          correlationId: command.eventId,
          content: command.content,
          structuredData: command.structuredData
        });
      });
  };

  const interactionOutbox = createInteractionOutboxDispatcher({
    state,
    persist,
    dispatch: async ({ entry, request }) => {
      if (!request) throw Object.assign(new Error('Request context is required to dispatch product interaction events'), { code: 'INTERACTION_REQUEST_REQUIRED' });
      const input = entry.eventInput;
      const applicationSessionId = input.session_id || null;
      const memorySessionId = applicationSessionId ? await memoryRuntime.ensureChatSession(request, applicationSessionId) : null;
      const context = { ...memoryRuntime.contextFromRequest(request, { chat: true, sessionId: memorySessionId }), relationshipId: relationships.relationshipId('cochpia') };
      return interactionCollector.collect(input, {
        request,
        context,
        sourceId: input.source_id,
        sessionId: applicationSessionId,
        producer: input.producer,
        storageSessionId: memorySessionId
      });
    }
  });

  const flushProductInteractionOutbox = async request => {
    try {
      return await interactionOutbox.flush({ request });
    } catch (error) {
      console.error(JSON.stringify({ event: 'interaction_outbox_flush_failed', code: error.code || 'INTERACTION_OUTBOX_FLUSH_FAILED' }));
      return { skipped: false, processed: 0, completed: 0, failed: 1, pending: state.companion?.interactionOutbox?.length || 0 };
    }
  };

  const collectLifeEvent = async (req, applicationSessionId, lifeEvent) => {
    const memorySessionId = applicationSessionId ? await memoryRuntime.ensureChatSession(req, applicationSessionId) : null;
    const context = { ...memoryRuntime.contextFromRequest(req, { chat: true, sessionId: memorySessionId }), relationshipId: relationships.relationshipId('cochpia') };
    const eventSessionId = lifeEvent.sessionId || applicationSessionId || null;
    const sourceId = eventSessionId || `life:${context.subjectUserId}`;
    const reconciliation = reconcileInteractionOutbox(state, pendingLifeInteractionInputs({ context }));
    if (reconciliation.rejected.length) {
      console.error(JSON.stringify({ event: 'life_interaction_outbox_reconciliation_rejected', count: reconciliation.rejected.length, codes: reconciliation.rejected.map(item => item.code) }));
    }
    const entry = queueProductInteraction(productInteractionInput({
      eventType: lifeEvent.eventType,
      producer: 'life-adapter',
      sourceType: 'game',
      sourceId,
      sessionId: eventSessionId,
      eventId: lifeEvent.eventId,
      idempotencyKey: lifeEvent.idempotencyKey,
      correlationId: lifeEvent.eventId,
      content: lifeEvent.content,
      structuredData: lifeEvent.structuredData
    }));
    if (!entry) {
      await lifeState.markEventStatus(lifeEvent.idempotencyKey, { status: 'pending' }).catch(() => {});
      return { status: 'pending', errorCode: 'LIFE_EVENT_OUTBOX_ENQUEUE_FAILED' };
    }
    try {
      await persist();
    } catch (error) {
      await lifeState.markEventStatus(lifeEvent.idempotencyKey, { status: 'pending' }).catch(() => {});
      return { status: 'pending', errorCode: error.code || 'LIFE_EVENT_OUTBOX_PERSIST_FAILED' };
    }
    await flushProductInteractionOutbox(req);
    const currentEntry = (state.companion?.interactionOutbox || []).find(item => item.idempotencyKey === lifeEvent.idempotencyKey)
      || (state.companion?.interactionOutbox || []).find(item => item.id === entry.id);
    const outboxStatus = currentEntry?.status || entry.status || 'pending';
    const rawEventId = currentEntry?.rawEventId || null;
    const status = outboxStatus === 'completed' ? 'accepted_stored' : outboxStatus;
    let statusErrorCode = currentEntry?.lastErrorCode || null;
    try {
      await lifeState.markEventStatus(lifeEvent.idempotencyKey, { status, rawEventId });
    } catch (error) {
      statusErrorCode = error.code || 'LIFE_EVENT_STATUS_UPDATE_FAILED';
      console.error(JSON.stringify({ event: 'life_event_status_projection_failed', code: statusErrorCode }));
    }
    if (outboxStatus !== 'completed') return { status, rawEventId, errorCode: statusErrorCode || 'LIFE_EVENT_COLLECTION_PENDING', outboxId: currentEntry?.id || entry.id };
    const relationshipDelta = Number(lifeEvent.structuredData?.relationshipDelta || 0);
    let evidence = null;
    if (rawEventId) {
      try {
        evidence = await growthEvidence.growFromSourceEvent(rawEventId, {
          claim: '一段来自共生人生的共同经历已形成可追溯成长证据。',
          evidence: lifeEvent.content,
          proposedChange: relationshipDelta > 0 ? { traitKey: 'warmth', delta: 0.002 } : null
        });
      } catch (error) {
        console.error(JSON.stringify({ event: 'life_growth_evidence_failed', code: error.code || 'LIFE_GROWTH_EVIDENCE_FAILED' }));
      }
    }
    if (relationshipDelta) {
      try {
        await relationships.observe('cochpia', { eventId: lifeEvent.eventId, sourceEventId: rawEventId || lifeEvent.eventId, signalType: lifeEvent.eventType, delta: relationshipDelta, evidence: lifeEvent.content });
      } catch (error) {
        console.error(JSON.stringify({ event: 'relationship_projection_failed', code: error.code || 'RELATIONSHIP_PROJECTION_FAILED' }));
      }
    }
    return { status, rawEventId, evidenceId: evidence?.id || null, statusErrorCode, outboxId: currentEntry?.id || entry.id };
  };

  return {
    calendarInteractionInput,
    collectLifeEvent,
    flushProductInteractionOutbox,
    productInteractionInput,
    queueProductInteraction,
    redactInteractionText,
    rollbackInteractionOutbox,
    taskInteractionInput
  };
}

export { productInteractionInput, redactInteractionText };
