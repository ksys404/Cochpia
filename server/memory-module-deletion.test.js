import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDeletionCoordinator, removeAccountDataForSubject } from './memory-module-deletion.js';

function state() {
  return {
    rawEvents: [
      { id: 'raw-1', tenantId: 'tenant-1', userId: 'user-1' },
      { id: 'raw-2', tenantId: 'tenant-1', userId: 'user-2' }
    ],
    sessions: [
      { id: 'session-1', tenantId: 'tenant-1', userId: 'user-1' },
      { id: 'session-2', tenantId: 'tenant-1', userId: 'user-2' }
    ],
    assertions: [
      { id: 'memory-1', tenantId: 'tenant-1', userId: 'user-1' },
      { id: 'memory-2', tenantId: 'tenant-1', userId: 'user-2' }
    ],
    assertionVersions: [
      { id: 'version-1', assertionId: 'memory-1' },
      { id: 'version-2', assertionId: 'memory-2' }
    ],
    profileSnapshots: [],
    profileSnapshotItems: [],
    profileProjections: [],
    profileProjectionItems: [],
    profileProjectionSources: [],
    currentStates: [],
    currentStateSources: [],
    confirmations: [],
    accessConfirmations: [],
    mentionCooldowns: [],
    pins: [],
    indexDocuments: [],
    episodes: [],
    episodeMembers: [],
    scopeGrants: [],
    outboxEvents: [],
    exportOperations: [],
    idempotencyRecords: [],
    auditEvents: [],
    deletionOperations: [{ id: 'keep-ledger', tenantId: 'tenant-1', subjectUserId: 'user-1' }],
    tombstones: [{ id: 'keep-tombstone', tenantId: 'tenant-1', userId: 'user-1' }]
  };
}

test('memory deletion boundary removes only the target subject and can preserve the deletion ledger', () => {
  const current = state();
  removeAccountDataForSubject(current, { tenantId: 'tenant-1', userId: 'user-1' }, { preserveDeletionLedger: true });
  assert.deepEqual(current.rawEvents.map(item => item.id), ['raw-2']);
  assert.deepEqual(current.sessions.map(item => item.id), ['session-2']);
  assert.deepEqual(current.assertions.map(item => item.id), ['memory-2']);
  assert.deepEqual(current.assertionVersions.map(item => item.id), ['version-2']);
  assert.equal(current.deletionOperations[0].id, 'keep-ledger');
  assert.equal(current.tombstones[0].id, 'keep-tombstone');
});

test('memory deletion coordinator creates a subject-bound tombstone operation', () => {
  const current = state();
  const coordinator = createMemoryDeletionCoordinator({
    state: current,
    nowIso: () => '2026-08-25T00:00:00.000Z',
    bumpEpoch: () => 7,
    audit() {},
    invalidateMutationRecords() {},
    mutationNamespaceOf: record => record.mutationNamespace || 'event'
  });
  const operation = coordinator.newDeletionOperation(
    { tenantId: 'tenant-1', subjectUserId: 'user-1', actorId: 'user-1' },
    'session',
    'session-1',
    { sessionId: 'session-1' }
  );
  assert.equal(operation.status, 'completed');
  assert.equal(operation.redactionEpoch, 7);
  assert.equal(current.tombstones.at(-1).targetId, 'session-1');
});
