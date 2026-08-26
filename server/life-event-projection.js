const clone = value => structuredClone(value);

export function redactLifeEventProvenance(state, { rawEventId = null, eventId = null, now = new Date() } = {}) {
  if (!state || typeof state !== 'object') throw new TypeError('Life event projection state is required');
  const rawId = rawEventId == null ? null : String(rawEventId).trim();
  const requestedEventId = eventId == null ? null : String(eventId).trim();
  if (!rawId && !requestedEventId) throw new Error('rawEventId or eventId is required');
  const lifeState = state.lifeState || {};
  const commandMatches = (state.lifeState?.commandLog || []).filter(command => (rawId && command.rawEventId === rawId) || (requestedEventId && command.eventId === requestedEventId));
  const redactedEventIds = new Set(commandMatches.map(command => command.eventId).filter(Boolean));
  if (requestedEventId) redactedEventIds.add(requestedEventId);

  const previousCurrentEventId = lifeState.currentEvent?.id || null;
  const currentEventWasRedacted = previousCurrentEventId && redactedEventIds.has(previousCurrentEventId);
  const previousRecentCount = Array.isArray(lifeState.recentEvents) ? lifeState.recentEvents.length : 0;
  const previousCommandCount = Array.isArray(lifeState.commandLog) ? lifeState.commandLog.length : 0;

  if (Array.isArray(lifeState.commandLog)) {
    lifeState.commandLog = lifeState.commandLog.filter(command => !((rawId && command.rawEventId === rawId) || (requestedEventId && command.eventId === requestedEventId)));
  }
  if (Array.isArray(lifeState.recentEvents)) lifeState.recentEvents = lifeState.recentEvents.filter(event => !redactedEventIds.has(event.id));
  if (currentEventWasRedacted) {
    lifeState.currentEvent = null;
    lifeState.lastAction = null;
    lifeState.lastChanges = [];
    lifeState.pendingDecision = null;
  }
  lifeState.redactedEventIds = [...new Set([...(lifeState.redactedEventIds || []), ...redactedEventIds])].slice(-200);
  lifeState.updatedAt = new Date(now).toISOString();

  const removedEvidenceIds = [];
  state.evidence = (state.evidence || []).filter(evidence => {
    if (!rawId || evidence.sourceEventId !== rawId) return true;
    removedEvidenceIds.push(evidence.id);
    return false;
  });

  return {
    rawEventId: rawId,
    eventIds: [...redactedEventIds],
    removedCommandCount: previousCommandCount - (lifeState.commandLog || []).length,
    removedEventCount: previousRecentCount - (lifeState.recentEvents || []).length,
    removedEvidenceIds,
    currentEventRedacted: Boolean(currentEventWasRedacted),
    state: clone(lifeState)
  };
}
