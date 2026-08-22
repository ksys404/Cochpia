import { reciprocalRankFusion } from './memory-module-retrieval.js';

function gatewayEmbed(gateway) {
  return typeof gateway === 'function' ? gateway : gateway?.embed;
}

function fallbackMode(errorCode) {
  if (errorCode === 'PGVECTOR_NOT_ENABLED') return 'postgres_lexical_pgvector_disabled';
  if (errorCode === 'EMBEDDING_GATEWAY_UNAVAILABLE') return 'postgres_lexical_embedding_unavailable';
  if (errorCode === 'EMBEDDING_TIMEOUT' || errorCode === 'MODEL_EMBEDDING_TIMEOUT') return 'postgres_lexical_embedding_timeout';
  return 'postgres_lexical_embedding_error';
}

/**
 * Builds the independent service's native candidate retriever. Query vectors
 * are always generated server-side through the model gateway; callers cannot
 * provide a trusted vector directly.
 */
export function createMemoryModuleNativeRetriever({
  repository,
  embeddingGateway = null,
  pgvectorEnabled = false,
  hybridRetrieval = false,
  vectorRetrieval = false,
  policyVersion = 'memory-policy-v1',
  limit = 50
} = {}) {
  if (!repository || typeof repository.searchIndexDocuments !== 'function') throw new TypeError('A repository with searchIndexDocuments is required');
  const wantsVector = hybridRetrieval === true || vectorRetrieval === true;
  return async (context, input = {}) => {
    const lexical = await repository.searchIndexDocuments(context, {
      query: input.query,
      purpose: input.purpose,
      mode: 'lexical',
      policyVersion,
      limit
    });
    if (!wantsVector) return { items: lexical, retrievalMode: 'postgres_lexical' };
    if (!pgvectorEnabled) return { items: lexical, retrievalMode: fallbackMode('PGVECTOR_NOT_ENABLED') };
    const embed = gatewayEmbed(embeddingGateway);
    if (typeof embed !== 'function') return { items: lexical, retrievalMode: fallbackMode('EMBEDDING_GATEWAY_UNAVAILABLE') };

    let queryVector;
    try {
      queryVector = await embed(input.query, {
        purpose: 'memory_retrieval',
        policyVersion,
        timeoutMs: input.embeddingTimeoutMs
      });
    } catch (error) {
      if (input.requireNativeRetrieval === true) throw error;
      return { items: lexical, retrievalMode: fallbackMode(error?.code) };
    }

    let vector;
    try {
      vector = await repository.searchIndexDocuments(context, {
        query: input.query,
        queryVector,
        purpose: input.purpose,
        mode: 'vector',
        policyVersion,
        limit
      });
    } catch (error) {
      if (input.requireNativeRetrieval === true) throw error;
      return { items: lexical, retrievalMode: fallbackMode(error?.code) };
    }
    if (!vector.length) return { items: lexical, retrievalMode: 'postgres_lexical_vector_empty' };
    if (vectorRetrieval === true && hybridRetrieval !== true) return { items: vector, retrievalMode: 'postgres_vector' };
    return {
      items: reciprocalRankFusion([lexical, vector], { limit }),
      retrievalMode: 'postgres_hybrid_rrf'
    };
  };
}
