import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';
import { createObservability, createRateLimiter } from './observability.js';

test('rate limiter allows a bounded window and resets it', () => {
  let current = 0;
  const limiter = createRateLimiter({ max: 2, windowMs: 1000, now: () => current });
  assert.equal(limiter.consume('user').allowed, true);
  assert.equal(limiter.consume('user').allowed, true);
  assert.equal(limiter.consume('user').allowed, false);
  current = 1001;
  assert.equal(limiter.consume('user').allowed, true);
});

test('observability assigns request IDs and rate-limits V1 endpoints', async () => {
  const app = express();
  const observability = createObservability({ rateLimitMax: 1, logger: { info() {} } });
  app.use(observability.middleware);
  app.get('/v1/memories', (_, res) => res.json({ ok: true }));
  const server = createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  try {
    const first = await fetch(`http://127.0.0.1:${address.port}/v1/memories`);
    assert.equal(first.status, 200);
    assert.ok(first.headers.get('x-request-id'));
    const second = await fetch(`http://127.0.0.1:${address.port}/v1/memories`);
    assert.equal(second.status, 429);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('observability exposes bounded latency percentiles and status counts', async () => {
  const app = express();
  const observability = createObservability({ rateLimitMax: 10, logger: { info() {} } });
  app.use(observability.middleware);
  app.get('/health', (_, res) => res.status(200).json({ ok: true }));
  app.get('/failure', (_, res) => res.status(503).json({ ok: false }));
  const server = createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  try {
    await fetch(`http://127.0.0.1:${address.port}/health`);
    await fetch(`http://127.0.0.1:${address.port}/failure`);
    const metrics = observability.getMetrics();
    assert.equal(metrics.requests, 2);
    assert.equal(metrics.errors, 1);
    assert.equal(metrics.statusCounts['200'], 1);
    assert.equal(metrics.statusCounts['503'], 1);
    assert.equal(metrics.latencySampleCount, 2);
    assert.equal(Number.isFinite(metrics.p50LatencyMs), true);
    assert.equal(Number.isFinite(metrics.p95LatencyMs), true);
    assert.equal(Number.isFinite(metrics.p99LatencyMs), true);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
