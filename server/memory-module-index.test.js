import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryModule, createMemoryModuleState } from './memory-module.js';
import { rebuildIndexDocuments, rebuildIndexDocumentsAsync } from './memory-module-index.js';

const context = { tenantId: 'tenant-a', subjectUserId: 'user-a', actorType: 'user', actorId: 'user-a' };

test('index rebuild includes active sourced assertions and preserves policy/source metadata', async () => {
  const state = createMemoryModuleState();
  const memory = createMemoryModule(state);
  await memory.hold(context, { content: '喜欢红茶', sensitivity: 'S0', mentionPolicy: 'do_not_mention' });
  const documents = rebuildIndexDocuments(state, { tenantId: 'tenant-a', userId: 'user-a' });
  assert.equal(documents.length, 1);
  assert.equal(documents[0].mentionable, false);
  assert.equal(documents[0].lexicalVersion, 'bm25-v1');
  assert.ok(documents[0].sourceVersion);
  assert.ok(documents[0].sourceRefs.length > 0);
});

test('rebuild after forget removes the old derived index document', async () => {
  const state = createMemoryModuleState();
  const memory = createMemoryModule(state);
  const created = await memory.hold(context, { content: '待忘记的事实', sensitivity: 'S0' });
  assert.equal(rebuildIndexDocuments(state, { tenantId: 'tenant-a', userId: 'user-a' }).length, 1);
  await memory.forget(context, created.memory.memoryId, { resourceRevision: created.memory.resourceRevision });
  assert.equal(rebuildIndexDocuments(state, { tenantId: 'tenant-a', userId: 'user-a' }).length, 0);
});

test('async index rebuild stores embeddings when available and keeps BM25 fallback on gateway failure', async () => {
  const state = createMemoryModuleState();
  const memory = createMemoryModule(state);
  await memory.hold(context, { content: '喜欢红茶', sensitivity: 'S0' });
  const documents = await rebuildIndexDocumentsAsync(state, { tenantId: 'tenant-a', userId: 'user-a', embeddingGateway: { embed: async () => [1, 0] } });
  assert.deepEqual(documents[0].embedding, [1, 0]);
  assert.equal(documents[0].embeddingVersion, 'gateway-v1');
  state.indexDocuments = [];
  await memory.hold(context, { content: '喜欢咖啡', sensitivity: 'S0' });
  const fallback = await rebuildIndexDocumentsAsync(state, { tenantId: 'tenant-a', userId: 'user-a', embeddingGateway: { embed: async () => { throw new Error('embedding down'); } } });
  assert.equal(fallback.every(document => !document.embedding), true);
});
