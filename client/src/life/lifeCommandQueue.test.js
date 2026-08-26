import test from 'node:test';
import assert from 'node:assert/strict';
import { createLifeCommandQueue, isRetryableLifeError, STORAGE_KEY, storageKeyForScope } from './lifeCommandQueue.js';

function storage() {
  const values = new Map();
  return { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value), values };
}

test('life command queue persists commands and deduplicates idempotency keys', () => {
  const backing = storage();
  const queue = createLifeCommandQueue(backing);
  const command = { path: '/api/life/actions', body: { actionId: 'walk' }, idempotencyKey: 'life-1' };
  queue.enqueue(command);
  queue.enqueue(command);
  assert.equal(queue.size(), 1);
  assert.equal(JSON.parse(backing.values.get(STORAGE_KEY)).length, 1);
  const restored = createLifeCommandQueue(backing);
  assert.equal(restored.list()[0].idempotencyKey, 'life-1');
  restored.remove('life-1');
  assert.equal(restored.size(), 0);
});

test('life command queues are isolated by authenticated subject', () => {
  const backing = storage();
  const userA = createLifeCommandQueue(backing, 'user-a');
  const userB = createLifeCommandQueue(backing, 'user-b');
  userA.enqueue({ path: '/api/life/actions', body: { actionId: 'walk' }, idempotencyKey: 'life-a' });
  assert.equal(userA.size(), 1);
  assert.equal(userB.size(), 0);
  assert.equal(createLifeCommandQueue(backing, 'user-a').list()[0].idempotencyKey, 'life-a');
  assert.equal(backing.values.has(storageKeyForScope('user-a')), true);
  assert.equal(backing.values.has(storageKeyForScope('user-b')), false);
});

test('life command queue only retries transport/service failures', () => {
  assert.equal(isRetryableLifeError({ status: 503 }), true);
  assert.equal(isRetryableLifeError({ status: 503, code: 'LIFE_EVENT_DEAD_LETTER' }), false);
  assert.equal(isRetryableLifeError({ status: 409 }), false);
  assert.equal(isRetryableLifeError({ status: 400 }), false);
  assert.equal(isRetryableLifeError(new TypeError('offline')), true);
});
