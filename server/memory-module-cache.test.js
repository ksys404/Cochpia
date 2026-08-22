import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryModuleCache } from './memory-module-cache.js';

function fakeRedis() {
  const values = new Map();
  return {
    values,
    async get(key) { return values.get(key) ?? null; },
    async set(key, value, options) { values.set(key, value); assert.equal(options.EX, 30); },
    async incr(key) { const next = Number(values.get(key) || 0) + 1; values.set(key, String(next)); return next; }
  };
}

test('versioned ContextBundle cache is tenant/user bound and invalidated by subject generation', async () => {
  const redis = fakeRedis();
  const cache = createMemoryModuleCache({ client: redis, ttlSeconds: 30 });
  const context = { tenantId: 'tenant-a', subjectUserId: 'user-a' };
  const state = { assertions: [{ id: 'memory-a' }], accessConfirmations: [], mentionCooldowns: [] };
  assert.equal(await cache.setContextBundle(context, { purpose: 'profile_view', readVersion: '1:2:3', state }), true);
  assert.deepEqual(await cache.getContextBundle(context, { purpose: 'profile_view', readVersion: '1:2:3' }), state);
  await cache.bumpSubjectGeneration(context);
  assert.equal(await cache.getContextBundle(context, { purpose: 'profile_view', readVersion: '1:2:3' }), null);
  assert.equal([...redis.values.keys()].some(key => key.includes('tenant-a') && key.includes('user-a')), true);
  assert.equal([...redis.values.keys()].some(key => key.includes('user-b')), false);
});

test('cache does not place query content in Redis keys', async () => {
  const redis = fakeRedis();
  const cache = createMemoryModuleCache({ client: redis });
  const context = { tenantId: 'tenant-a', subjectUserId: 'user-a' };
  assert.equal(await cache.setContextBundle(context, { query: '敏感查询正文', state: { safe: true } }), false);
  assert.equal(await cache.getContextBundle(context, { query: '敏感查询正文' }), null);
  assert.equal(redis.values.size, 0);
});

test('cache backend failures are best effort and never become a retrieval failure', async () => {
  const broken = {
    async get() { throw new Error('backend down'); },
    async set() { throw new Error('backend down'); },
    async incr() { throw new Error('backend down'); }
  };
  const cache = createMemoryModuleCache({ client: broken });
  const context = { tenantId: 'tenant-a', subjectUserId: 'user-a' };
  assert.equal(await cache.getContextBundle(context, { state: {} }), null);
  assert.equal(await cache.setContextBundle(context, { state: {} }), false);
  assert.equal(await cache.bumpSubjectGeneration(context), null);
});
