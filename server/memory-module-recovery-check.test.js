import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryModuleState } from './memory-module.js';
import { checkRecoveryState } from './memory-module-recovery-check.js';

test('recovery artifact check replays a memory tombstone and verifies negative references', () => {
  const state = createMemoryModuleState();
  state.assertions.push({ id: 'memory-recovery', tenantId: 'tenant-a', userId: 'user-a', status: 'active', updatedAt: '2026-01-01T00:00:00.000Z' });
  state.assertionVersions.push({ id: 'version-recovery', assertionId: 'memory-recovery' });
  state.profileSnapshotItems.push({ snapshotId: 'snapshot-recovery', assertionId: 'memory-recovery', tenantId: 'tenant-a', userId: 'user-a' });
  state.indexDocuments.push({ id: 'index-recovery', sourceId: 'memory-recovery', sourceVersion: 'version-recovery', tenantId: 'tenant-a', userId: 'user-a' });
  state.outboxEvents.push({ id: 'outbox-recovery', aggregateId: 'memory-recovery', tenantId: 'tenant-a', userId: 'user-a', status: 'pending' });
  const result = checkRecoveryState(state, [{ id: 'tombstone-recovery', tenantId: 'tenant-a', userId: 'user-a', targetType: 'memory', targetId: 'memory-recovery', action: 'forget', redactionEpoch: 4 }]);
  assert.deepEqual(result, { replayApplied: 1, tombstoneCount: 1 });
  assert.equal(state.assertions[0].status, 'forgotten');
  assert.equal(state.indexDocuments.length, 0);
  assert.equal(state.profileSnapshotItems.length, 0);
  assert.equal(state.outboxEvents[0].result, 'redacted_during_recovery');
});

test('recovery artifact check rejects a restored visible index reference', () => {
  const state = createMemoryModuleState();
  state.indexDocuments.push({ id: 'index-leak', sourceId: 'unrelated-memory', sourceRefs: ['raw-leak'], tenantId: 'tenant-a', userId: 'user-a' });
  assert.throws(() => checkRecoveryState(state, [{ id: 'tombstone-leak', tenantId: 'tenant-a', userId: 'user-a', targetType: 'source_event', targetId: 'raw-leak', action: 'forget', redactionEpoch: 1 }]), error => error.code === 'MEMORY_RECOVERY_LEAK_DETECTED');
});
