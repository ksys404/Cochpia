export function numericSourceRevision(value) {
  const text = String(value ?? '').trim();
  return /^\d+$/.test(text) ? BigInt(text) : null;
}

export function isSupersededSourceEvent(rawEvents = [], sourceEvent) {
  if (!sourceEvent) return false;
  const revision = numericSourceRevision(sourceEvent.sourceRevision);
  if (revision == null) return false;
  return rawEvents.some(event => event !== sourceEvent
    && event.tenantId === sourceEvent.tenantId
    && event.userId === sourceEvent.userId
    && event.eventId === sourceEvent.eventId
    && numericSourceRevision(event.sourceRevision) != null
    && numericSourceRevision(event.sourceRevision) > revision);
}
