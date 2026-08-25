import { InteractionEventError, normalizeInteractionEvent, toMemoryRecordInput } from './interaction-events.js';

export function createInteractionCollector({ contextFromRequest, appendEvent, now = () => new Date() } = {}) {
  if (typeof appendEvent !== 'function') throw new TypeError('Interaction Collector requires appendEvent');
  if (contextFromRequest != null && typeof contextFromRequest !== 'function') throw new TypeError('contextFromRequest must be a function');

  const collect = async (input = {}, options = {}) => {
    const request = options.request || null;
    const resolvedContext = options.context || (contextFromRequest ? await contextFromRequest(request) : null);
    if (!resolvedContext || typeof resolvedContext !== 'object') throw new InteractionEventError('IDENTITY_CONTEXT_REQUIRED', 'Verified identity context is required', { status: 401 });
    const envelope = normalizeInteractionEvent(input, resolvedContext, {
      ...options,
      now: options.now || now()
    });
    const storageInput = toMemoryRecordInput(envelope, { sessionId: options.storageSessionId ?? null });
    const stored = await appendEvent(resolvedContext, storageInput, { request, envelope });
    return {
      envelope,
      storage: stored || null,
      result: stored?.result || 'accepted',
      rawEventId: stored?.rawEventId || null,
      commitSeq: stored?.commitSeq ?? null
    };
  };

  return { collect };
}
