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

export function parseSseCursor(lastEventId = '', runId = null) {
  const raw = String(lastEventId || '').trim();
  if (!raw) return { cursor: null, sequence: 0 };
  const prefix = runId == null ? '' : `${runId}:`;
  if (prefix && !raw.startsWith(prefix)) return null;
  const token = prefix ? raw.slice(prefix.length) : raw.split(':').at(-1);
  if (!/^(0|[1-9]\d*)$/.test(token)) return null;
  const sequence = Number(token);
  if (!Number.isSafeInteger(sequence)) return null;
  return { cursor: raw, sequence };
}

export function replaySseEvents(events, lastEventId = '') {
  const afterSequence = parseSseCursor(lastEventId)?.sequence || 0;
  return events.filter(entry => Number(entry.id.split(':').at(-1)) > afterSequence);
}
