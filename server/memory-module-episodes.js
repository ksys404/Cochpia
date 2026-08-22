import { randomUUID } from 'node:crypto';
import { classifyMemorySensitivity } from './memory-module.js';

function eventIsRedacted(state, event) {
  return (state.tombstones || []).some(tombstone => tombstone.tenantId === event.tenantId
    && tombstone.userId === event.userId
    && (tombstone.targetType === 'account'
      || (tombstone.targetType === 'source_event' && tombstone.targetId === event.id)
      || (tombstone.targetType === 'session' && event.sessionId && tombstone.targetId === event.sessionId)));
}

export function rebuildEpisodes(state, { tenantId, userId, sessionId = null, windowMs = 30 * 60 * 1000 } = {}) {
  if (!tenantId || !userId) throw new TypeError('tenantId and userId are required');
  state.episodes ||= [];
  state.episodeMembers ||= [];
  if (sessionId) {
    const session = (state.sessions || []).find(item => item.id === sessionId && item.tenantId === tenantId && item.userId === userId);
    if (!session || session.status !== 'active' || (session.expiresAt && new Date(session.expiresAt).getTime() <= Date.now())) return [];
  }
  state.episodeMembers = state.episodeMembers.filter(member => {
    const episode = state.episodes.find(item => item.id === member.episodeId);
    return !(episode && episode.tenantId === tenantId && episode.userId === userId && (!sessionId || episode.sessionId === sessionId));
  });
  state.episodes = state.episodes.filter(episode => !(episode.tenantId === tenantId && episode.userId === userId && (!sessionId || episode.sessionId === sessionId)));
  const events = (state.rawEvents || [])
    .filter(event => event.tenantId === tenantId && event.userId === userId)
    .filter(event => sessionId ? event.sessionId === sessionId : !event.sessionId)
    .filter(event => event.isStreamFinal !== false)
    .filter(event => classifyMemorySensitivity({ content: event.content }) !== 'S2')
    .filter(event => !eventIsRedacted(state, event))
    .sort((a, b) => new Date(a.occurredAt).getTime() - new Date(b.occurredAt).getTime());
  const groups = [];
  for (const event of events) {
    const previous = groups.at(-1);
    if (!previous || new Date(event.occurredAt).getTime() - new Date(previous.at(-1).occurredAt).getTime() > windowMs) groups.push([event]);
    else previous.push(event);
  }
  for (const members of groups) {
    const episode = { id: randomUUID(), tenantId, userId, scopeType: sessionId ? 'session' : 'user', relationshipAgentId: null, sessionId: sessionId || members[0].sessionId || null, title: String(members[0].content || 'Episode').slice(0, 80), summary: members.slice(0, 3).map(event => String(event.content || '').slice(0, 240)).join('；'), observedStart: members[0].occurredAt, observedEnd: members.at(-1).occurredAt, groupingRuleVersion: 'temporal-window-v1', summaryModelVersion: 'deterministic-v1', status: 'active', resourceRevision: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    state.episodes.push(episode);
    for (const event of members) state.episodeMembers.push({ id: randomUUID(), episodeId: episode.id, tenantId, userId, rawEventId: event.id, assertionVersionId: null, memberRole: 'event', joinReason: 'temporal_adjacent', createdAt: new Date().toISOString() });
  }
  return state.episodes.filter(episode => episode.tenantId === tenantId && episode.userId === userId && (!sessionId || episode.sessionId === sessionId));
}
