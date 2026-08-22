import { randomUUID } from 'node:crypto';

export function rebuildIndexDocuments(state, { tenantId = null, userId = null } = {}) {
  state.indexDocuments ||= [];
  const previousEmbeddings = new Map(state.indexDocuments.map(document => [`${document.sourceId}:${document.sourceVersion}`, document.embedding || null]));
  state.indexDocuments = state.indexDocuments.filter(document => (tenantId && document.tenantId !== tenantId) || (userId && document.userId !== userId));
  const assertions = (state.assertions || []).filter(assertion => assertion.status === 'active'
    && (!tenantId || assertion.tenantId === tenantId)
    && (!userId || assertion.userId === userId));
  for (const assertion of assertions) {
    const version = state.assertionVersions.find(item => item.id === assertion.currentVersionId);
    if (!version) continue;
    const sources = state.assertionVersionSources.filter(item => item.versionId === version.id).map(item => item.sourceId);
    if (!sources.length) continue;
    state.indexDocuments.push({
      id: randomUUID(),
      tenantId: assertion.tenantId,
      sourceType: 'assertion_version',
      sourceId: assertion.id,
      sourceVersion: version.id,
      userId: assertion.userId,
      scopeType: assertion.scopeType,
      relationshipAgentId: assertion.relationshipAgentId,
      sessionId: assertion.sessionId,
      searchText: `${version.content} ${JSON.stringify(version.structuredData || {})}`.slice(0, 8000),
      sensitivity: assertion.sensitivity,
      contextualizable: true,
      mentionable: assertion.mentionPolicy === 'mentionable',
      redactionEpoch: Number(state.redactionEpochs?.[`${assertion.tenantId}:${assertion.userId}`] || 0),
      policyEpoch: state.policyVersion || 'memory-policy-v1',
      grantVersion: Number(state.grantVersion || 0),
      embedding: previousEmbeddings.get(`${assertion.id}:${version.id}`) || null,
      embeddingVersion: previousEmbeddings.has(`${assertion.id}:${version.id}`) ? 'stored-v1' : null,
      lexicalVersion: 'bm25-v1',
      indexStatus: 'active',
      sourceRefs: sources,
      createdAt: new Date().toISOString()
    });
  }
  return state.indexDocuments.filter(document => (!tenantId || document.tenantId === tenantId) && (!userId || document.userId === userId));
}

export async function rebuildIndexDocumentsAsync(state, { tenantId = null, userId = null, embeddingGateway = null, embeddingTimeoutMs = 150 } = {}) {
  const documents = rebuildIndexDocuments(state, { tenantId, userId });
  const embed = typeof embeddingGateway === 'function' ? embeddingGateway : embeddingGateway?.embed;
  if (typeof embed !== 'function') return documents;
  for (const document of documents) {
    if (document.embedding) continue;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), embeddingTimeoutMs);
    try {
      const vector = await embed(document.searchText, { signal: controller.signal, purpose: 'memory_index' });
      if (Array.isArray(vector) && vector.length && vector.every(value => Number.isFinite(Number(value)))) {
        document.embedding = vector.map(Number);
        document.embeddingVersion = 'gateway-v1';
      }
    } catch {
      // Embedding is a rebuildable derivative; leave it null and preserve BM25 fallback.
    } finally {
      clearTimeout(timeout);
    }
  }
  return documents;
}
