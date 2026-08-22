import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryModuleState } from './memory-module.js';
import { replayRedactionLedger } from './memory-module-recovery.js';

test('replaying a memory tombstone prevents restored snapshot and outbox resurrection', () => {
  const state = createMemoryModuleState();
  state.indexDocuments = [];
  state.episodes = [];
  state.episodeMembers = [];
  state.assertions.push({ id: 'm-1', tenantId: 'tenant-a', userId: 'user-a', status: 'active', updatedAt: '2026-01-01T00:00:00.000Z' });
  state.assertionVersions.push({ id: 'v-1', assertionId: 'm-1' });
  state.profileSnapshotItems.push({ snapshotId: 'snapshot-1', assertionId: 'm-1' });
  state.indexDocuments.push({ id: 'index-1', sourceId: 'm-1', sourceVersion: 'v-1' });
  state.episodes = [{ id: 'episode-1', status: 'active' }];
  state.episodeMembers = [{ id: 'member-1', episodeId: 'episode-1', assertionVersionId: 'v-1' }];
  state.outboxEvents.push({ id: 'outbox-1', aggregateId: 'm-1', status: 'pending' });
  state.tombstones.push({ id: 't-1', tenantId: 'tenant-a', userId: 'user-a', targetType: 'memory', targetId: 'm-1', action: 'forget', redactionEpoch: 4 });
  const result = replayRedactionLedger(state);
  assert.equal(result.applied, 1);
  assert.equal(state.assertions[0].status, 'forgotten');
  assert.equal(state.profileSnapshotItems.length, 0);
  assert.equal(state.indexDocuments.length, 0);
  assert.equal(state.episodeMembers.length, 0);
  assert.equal(state.episodes.length, 0);
  assert.equal(state.outboxEvents[0].result, 'redacted_during_recovery');
  assert.equal(state.redactionEpochs['tenant-a:user-a'], 4);
});

test('replaying a source-event tombstone invalidates derived assertions', () => {
  const state = createMemoryModuleState();
  state.assertions.push({ id: 'm-2', tenantId: 'tenant-a', userId: 'user-a', status: 'active', updatedAt: '2026-01-01T00:00:00.000Z' });
  state.assertionVersions.push({ id: 'v-2', assertionId: 'm-2' });
  state.assertionVersionSources.push({ versionId: 'v-2', sourceType: 'raw_event', sourceId: 'raw-2' });
  state.outboxEvents.push({ id: 'outbox-2', aggregateId: 'raw-2', status: 'processing' });
  state.tombstones.push({ id: 't-2', tenantId: 'tenant-a', userId: 'user-a', targetType: 'source_event', targetId: 'raw-2', action: 'forget', redactionEpoch: 2 });
  replayRedactionLedger(state);
  assert.equal(state.assertions[0].status, 'forgotten');
  assert.equal(state.outboxEvents[0].result, 'redacted_during_recovery');
});

test('replaying a physical source-event tombstone removes restored raw and derived data', () => {
  const state = createMemoryModuleState();
  state.rawEvents.push({ id: 'raw-delete', tenantId: 'tenant-a', userId: 'user-a', sessionId: null });
  state.assertions.push({ id: 'memory-delete', tenantId: 'tenant-a', userId: 'user-a', status: 'active' });
  state.assertionVersions.push({ id: 'version-delete', assertionId: 'memory-delete' });
  state.assertionVersionSources.push({ versionId: 'version-delete', sourceType: 'raw_event', sourceId: 'raw-delete' });
  state.profileSnapshotItems.push({ snapshotId: 'snapshot-delete', assertionId: 'memory-delete' });
  state.outboxEvents.push({ id: 'outbox-delete', aggregateId: 'raw-delete', status: 'pending' });
  state.tombstones.push({ id: 't-delete', tenantId: 'tenant-a', userId: 'user-a', targetType: 'source_event', targetId: 'raw-delete', action: 'delete', redactionEpoch: 8 });
  replayRedactionLedger(state);
  assert.equal(state.rawEvents.length, 0);
  assert.equal(state.assertions.length, 0);
  assert.equal(state.assertionVersions.length, 0);
  assert.equal(state.profileSnapshotItems.length, 0);
  assert.equal(state.outboxEvents.length, 0);
});

test('replaying a physical session tombstone removes restored episodes and members', () => {
  const state = createMemoryModuleState();
  state.episodes = [];
  state.episodeMembers = [];
  state.sessions.push({ id: 'session-delete', tenantId: 'tenant-a', userId: 'user-a', profileSnapshotId: 'snapshot-session-delete' });
  state.rawEvents.push({ id: 'raw-session-delete', tenantId: 'tenant-a', userId: 'user-a', sessionId: 'session-delete' });
  state.assertions.push({ id: 'memory-session-delete', tenantId: 'tenant-a', userId: 'user-a', sessionId: 'session-delete', status: 'active' });
  state.assertionVersions.push({ id: 'version-session-delete', assertionId: 'memory-session-delete' });
  state.episodes.push({ id: 'episode-session-delete', tenantId: 'tenant-a', userId: 'user-a', sessionId: 'session-delete', status: 'active' });
  state.episodeMembers.push({ id: 'member-session-delete', episodeId: 'episode-session-delete', rawEventId: 'raw-session-delete', assertionVersionId: 'version-session-delete' });
  state.tombstones.push({ id: 't-session-delete', tenantId: 'tenant-a', userId: 'user-a', targetType: 'session', targetId: 'session-delete', action: 'delete', redactionEpoch: 9 });

  replayRedactionLedger(state);

  assert.equal(state.sessions.length, 0);
  assert.equal(state.rawEvents.length, 0);
  assert.equal(state.assertions.length, 0);
  assert.equal(state.assertionVersions.length, 0);
  assert.equal(state.episodes.length, 0);
  assert.equal(state.episodeMembers.length, 0);
});

test('replaying a physical account tombstone preserves other subjects and the deletion ledger', () => {
  const state = createMemoryModuleState();
  state.rawEvents.push(
    { id: 'raw-account-target', tenantId: 'tenant-a', userId: 'user-a' },
    { id: 'raw-account-other-user', tenantId: 'tenant-a', userId: 'user-b' },
    { id: 'raw-account-other-tenant', tenantId: 'tenant-b', userId: 'user-b' }
  );
  state.assertions.push(
    { id: 'memory-account-target', tenantId: 'tenant-a', userId: 'user-a', status: 'active' },
    { id: 'memory-account-other-user', tenantId: 'tenant-a', userId: 'user-b', status: 'active' },
    { id: 'memory-account-other-tenant', tenantId: 'tenant-b', userId: 'user-b', status: 'active' }
  );
  state.assertionVersions.push(
    { id: 'version-account-target', assertionId: 'memory-account-target' },
    { id: 'version-account-other-user', assertionId: 'memory-account-other-user' },
    { id: 'version-account-other-tenant', assertionId: 'memory-account-other-tenant' }
  );
  state.assertionVersionSources.push(
    { versionId: 'version-account-target', sourceType: 'raw_event', sourceId: 'raw-account-target' },
    { versionId: 'version-account-other-user', sourceType: 'raw_event', sourceId: 'raw-account-other-user' },
    { versionId: 'version-account-other-tenant', sourceType: 'raw_event', sourceId: 'raw-account-other-tenant' }
  );
  state.outboxEvents.push(
    { id: 'outbox-account-target', tenantId: 'tenant-a', userId: 'user-a', aggregateId: 'raw-account-target', status: 'pending' },
    { id: 'outbox-account-other-user', tenantId: 'tenant-a', userId: 'user-b', aggregateId: 'raw-account-other-user', status: 'pending' },
    { id: 'outbox-account-other-tenant', tenantId: 'tenant-b', userId: 'user-b', aggregateId: 'raw-account-other-tenant', status: 'pending' }
  );
  state.tombstones.push({ id: 't-account-target', tenantId: 'tenant-a', userId: 'user-a', targetType: 'account', targetId: 'user-a', action: 'delete', redactionEpoch: 12 });

  replayRedactionLedger(state);

  assert.equal(state.rawEvents.some(item => item.id === 'raw-account-target'), false);
  assert.equal(state.assertions.some(item => item.id === 'memory-account-target'), false);
  assert.equal(state.assertionVersions.some(item => item.id === 'version-account-target'), false);
  assert.equal(state.rawEvents.some(item => item.id === 'raw-account-other-user'), true);
  assert.equal(state.assertions.some(item => item.id === 'memory-account-other-user'), true);
  assert.equal(state.rawEvents.some(item => item.id === 'raw-account-other-tenant'), true);
  assert.equal(state.assertions.some(item => item.id === 'memory-account-other-tenant'), true);
  assert.equal(state.outboxEvents.some(item => item.id === 'outbox-account-other-user'), true);
  assert.equal(state.outboxEvents.some(item => item.id === 'outbox-account-other-tenant'), true);
  assert.equal(state.tombstones.some(item => item.id === 't-account-target'), true);
  assert.equal(state.redactionEpochs['tenant-a:user-a'], 12);
});

test('replaying forget tombstones closes affected sessions without touching other subjects', () => {
  const state = createMemoryModuleState();
  state.sessions.push(
    { id: 'session-forgotten', tenantId: 'tenant-a', userId: 'user-a', status: 'active', resourceRevision: 2 },
    { id: 'session-preserved', tenantId: 'tenant-a', userId: 'user-b', status: 'active', resourceRevision: 3 }
  );
  state.tombstones.push(
    { id: 't-session-forget', tenantId: 'tenant-a', userId: 'user-a', targetType: 'session', targetId: 'session-forgotten', action: 'forget', redactionEpoch: 13 },
    { id: 't-account-forget', tenantId: 'tenant-a', userId: 'user-a', targetType: 'account', targetId: 'user-a', action: 'forget', redactionEpoch: 14 }
  );

  replayRedactionLedger(state);

  assert.equal(state.sessions.find(item => item.id === 'session-forgotten').status, 'closed');
  assert.equal(state.sessions.find(item => item.id === 'session-forgotten').resourceRevision, 4);
  assert.equal(state.sessions.find(item => item.id === 'session-preserved').status, 'active');
  assert.equal(state.redactionEpochs['tenant-a:user-a'], 14);
});
