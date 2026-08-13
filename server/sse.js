export function createSseEvent(run, event, data) {
  const id = `${run.id}:${run.sequence + 1}`;
  run.sequence += 1;
  const entry = { id, event, data };
  run.events.push(entry);
  return entry;
}

export function formatSseEvent(entry) {
  return `id: ${entry.id}\nevent: ${entry.event}\ndata: ${JSON.stringify(entry.data)}\n\n`;
}

export function replaySseEvents(events, lastEventId = '') {
  const afterSequence = Number(String(lastEventId).split(':').at(-1)) || 0;
  return events.filter(entry => Number(entry.id.split(':').at(-1)) > afterSequence);
}
