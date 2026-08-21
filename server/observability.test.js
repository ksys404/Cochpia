import test from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimiter } from './observability.js';

test('rate limiter allows a bounded window and resets it', () => {
  let current = 0;
  const limiter = createRateLimiter({ max: 2, windowMs: 1000, now: () => current });
  assert.equal(limiter.consume('user').allowed, true);
  assert.equal(limiter.consume('user').allowed, true);
  assert.equal(limiter.consume('user').allowed, false);
  current = 1001;
  assert.equal(limiter.consume('user').allowed, true);
});
