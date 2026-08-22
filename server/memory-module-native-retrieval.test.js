import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryModuleNativeRetriever } from './memory-module-native-retrieval.js';

const context = { tenantId: 'tenant-a', subjectUserId: 'user-a', actorType: 'agent', callerAgentId: 'agent-a', sessionId: null };

function fakeRepository() {
  const calls = [];
  const lexical = [{ id: 'lexical-a', score: 2, assertion: {}, version: {} }];
  const vector = [{ id: 'vector-a', score: 0.9, assertion: {}, version: {} }];
  return {
    calls,
    async searchIndexDocuments(_context, input) {
      calls.push(input);
      return input.mode === 'vector' ? vector : lexical;
    }
  };
}

test('native retriever keeps lexical-only mode when vector flags are disabled', async () => {
  const repository = fakeRepository();
  let embedded = false;
  const retriever = createMemoryModuleNativeRetriever({ repository, pgvectorEnabled: true, embeddingGateway: { embed: async () => { embedded = true; return [1, 0]; } } });
  const result = await retriever(context, { query: 'tea', purpose: 'profile_view' });
  assert.equal(result.retrievalMode, 'postgres_lexical');
  assert.equal(embedded, false);
  assert.deepEqual(result.items.map(item => item.id), ['lexical-a']);
  assert.equal(repository.calls.length, 1);
  assert.equal(repository.calls[0].mode, 'lexical');
});

test('native hybrid retriever generates the query vector server-side and fuses native candidates', async () => {
  const repository = fakeRepository();
  const embeddedInputs = [];
  const retriever = createMemoryModuleNativeRetriever({
    repository,
    pgvectorEnabled: true,
    hybridRetrieval: true,
    embeddingGateway: { embed: async (query, options) => { embeddedInputs.push({ query, options }); return [0.1, 0.2]; } }
  });
  const result = await retriever(context, { query: 'tea', purpose: 'answer_user_query' });
  assert.equal(result.retrievalMode, 'postgres_hybrid_rrf');
  assert.deepEqual(embeddedInputs[0], { query: 'tea', options: { purpose: 'memory_retrieval', policyVersion: 'memory-policy-v1', timeoutMs: undefined } });
  assert.deepEqual(repository.calls.map(call => call.mode), ['lexical', 'vector']);
  assert.deepEqual(repository.calls[1].queryVector, [0.1, 0.2]);
  assert.deepEqual(result.items.map(item => item.id).sort(), ['lexical-a', 'vector-a']);
});

test('native vector retriever falls back to lexical when pgvector is disabled or embedding fails', async () => {
  const disabledRepository = fakeRepository();
  const disabled = createMemoryModuleNativeRetriever({
    repository: disabledRepository,
    vectorRetrieval: true,
    pgvectorEnabled: false,
    embeddingGateway: { embed: async () => { throw new Error('must not call'); } }
  });
  const disabledResult = await disabled(context, { query: 'tea', purpose: 'profile_view' });
  assert.equal(disabledResult.retrievalMode, 'postgres_lexical_pgvector_disabled');
  assert.deepEqual(disabledRepository.calls.map(call => call.mode), ['lexical']);

  const failedRepository = fakeRepository();
  const failed = createMemoryModuleNativeRetriever({
    repository: failedRepository,
    vectorRetrieval: true,
    pgvectorEnabled: true,
    embeddingGateway: { embed: async () => { const error = new Error('timeout'); error.code = 'EMBEDDING_TIMEOUT'; throw error; } }
  });
  const failedResult = await failed(context, { query: 'tea', purpose: 'profile_view' });
  assert.equal(failedResult.retrievalMode, 'postgres_lexical_embedding_timeout');
  assert.deepEqual(failedResult.items.map(item => item.id), ['lexical-a']);
  assert.deepEqual(failedRepository.calls.map(call => call.mode), ['lexical']);
});
