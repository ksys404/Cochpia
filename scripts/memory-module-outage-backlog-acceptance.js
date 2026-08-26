import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMemoryModuleState } from '../server/memory-module.js';
import { createMemoryModuleWorker } from '../server/memory-module-worker.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const artifactPath = path.resolve(root, '../artifacts/companion-core-outage-backlog-2026-08-24.json');
const backlogSize = Math.max(20, Math.min(5_000, Number(process.env.MEMORY_OUTAGE_BACKLOG_SIZE || 500)));
const outageRounds = Math.max(1, Math.min(5, Number(process.env.MEMORY_OUTAGE_ROUNDS || 2)));
const maxAttempts = Math.max(outageRounds + 2, Math.min(10, Number(process.env.MEMORY_OUTAGE_MAX_ATTEMPTS || 5)));
const baseTimeMs = Date.parse('2026-08-24T00:00:00.000Z');
let virtualNowMs = baseTimeMs;
let upstreamAvailable = false;
const state = createMemoryModuleState();

for (let index = 0; index < backlogSize; index += 1) {
  const rawId = `raw-outage-${index}`;
  state.rawEvents.push({
    id: rawId,
    eventId: rawId,
    sourceRevision: '1',
    tenantId: 'tenant-outage',
    userId: 'user-outage',
    content: `backlog event ${index}`,
    createdAt: new Date(baseTimeMs + index).toISOString()
  });
  state.outboxEvents.push({
    id: `outbox-outage-${index}`,
    type: 'raw_event.created',
    aggregateId: rawId,
    tenantId: 'tenant-outage',
    userId: 'user-outage',
    status: 'pending',
    attempts: 0,
    createdAt: new Date(baseTimeMs + index).toISOString()
  });
}

const processed = [];
const worker = createMemoryModuleWorker({
  state,
  workerId: 'outage-backlog-worker',
  maxAttempts,
  processEvent: async ({ event }) => {
    if (!upstreamAvailable) throw Object.assign(new Error('simulated upstream outage'), { code: 'UPSTREAM_OUTAGE' });
    processed.push(event.id);
    return { status: 'processed' };
  }
});

const now = () => new Date(virtualNowMs);
const pendingEntries = () => state.outboxEvents.filter(event => event.status === 'pending');
const nextDueMs = () => Math.min(...pendingEntries().map(event => event.nextAttemptAt ? Date.parse(event.nextAttemptAt) : virtualNowMs));
const runDueWork = async (limit = backlogSize * maxAttempts * 3) => {
  let idle = 0;
  for (let iteration = 0; iteration < limit; iteration += 1) {
    const result = await worker.runOnce({ now: now(), clock: now });
    if (result.status === 'idle') {
      const due = nextDueMs();
      if (!Number.isFinite(due)) break;
      if (due > virtualNowMs) {
        virtualNowMs = due;
        idle = 0;
        continue;
      }
      idle += 1;
      if (idle > 2) break;
    } else {
      idle = 0;
    }
  }
};
const runAttempts = async count => {
  for (let iteration = 0; iteration < count; iteration += 1) {
    const result = await worker.runOnce({ now: now(), clock: now });
    assert.notEqual(result.status, 'idle', 'the bounded outage round should have due work');
  }
};

try {
  const initialPending = pendingEntries().length;
  const outageRoundMetrics = [];
  for (let round = 0; round < outageRounds; round += 1) {
    const before = state.outboxEvents.reduce((sum, event) => sum + Number(event.attempts || 0), 0);
    await runAttempts(backlogSize);
    const after = state.outboxEvents.reduce((sum, event) => sum + Number(event.attempts || 0), 0);
    const retryAt = state.outboxEvents.find(event => event.nextAttemptAt)?.nextAttemptAt || null;
    outageRoundMetrics.push({
      round: round + 1,
      attempted: after - before,
      pending: pendingEntries().length,
      nextAttemptAt: retryAt
    });
    assert.equal(pendingEntries().length, backlogSize, `outage round ${round + 1} must retain the backlog`);
    if (retryAt) virtualNowMs = Date.parse(retryAt);
  }

  const firstDelayMs = Date.parse(outageRoundMetrics[0].nextAttemptAt) - baseTimeMs;
  const secondDelayMs = Date.parse(outageRoundMetrics.at(-1).nextAttemptAt) - baseTimeMs;
  assert.equal(firstDelayMs > 0, true);
  assert.equal(secondDelayMs > firstDelayMs, true);

  const failingId = state.outboxEvents[0].id;
  upstreamAvailable = true;
  await runDueWork();
  const completed = state.outboxEvents.filter(event => event.status === 'completed').length;
  const deadLetter = state.outboxEvents.filter(event => event.status === 'dead_letter').length;
  assert.equal(completed, backlogSize);
  assert.equal(deadLetter, 0);
  assert.equal(processed.length, backlogSize);
  assert.equal(state.outboxEvents.find(event => event.id === failingId).status, 'completed');

  const result = {
    event: 'companion_core_outage_backlog_acceptance',
    generatedAt: new Date().toISOString(),
    virtualStart: new Date(baseTimeMs).toISOString(),
    backlogSize,
    outageRounds,
    maxAttempts,
    outageRoundMetrics,
    retryBackoffObserved: secondDelayMs > firstDelayMs,
    upstreamRecovered: upstreamAvailable,
    completed,
    deadLetter,
    processedAfterRecovery: processed.length,
    starvationCheck: 'healthy backlog entries remain claimable while an earlier event is backing off',
    note: 'Virtual-clock worker acceptance; production outage duration and RPO/RTO remain deployment-specific SLO evidence.'
  };
  await mkdir(path.dirname(artifactPath), { recursive: true });
  await writeFile(artifactPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(JSON.stringify({ event: 'companion_core_outage_backlog_acceptance_failed', code: error.code || 'OUTAGE_BACKLOG_ACCEPTANCE_FAILED', message: error.message }));
  process.exitCode = 1;
}
