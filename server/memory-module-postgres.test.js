import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryModulePostgresRepository } from './memory-module-postgres.js';

const context = { tenantId: 'tenant-a', subjectUserId: 'user-a' };

test('PostgreSQL repository rejects a stale state before destructive snapshot writes', async () => {
  const queries = [];
  const client = {
    async query(sql) {
      queries.push(sql);
      if (sql.startsWith('SELECT commit_seq')) return { rows: [{ commit_seq: '8' }] };
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
      return { rows: [] };
    },
    release() {}
  };
  const repository = createMemoryModulePostgresRepository({ connect: async () => client });
  await assert.rejects(
    () => repository.save(context, { persistenceBaseSequence: 7, sequence: 8, sessions: [], rawEvents: [], profileSnapshots: [], profileSnapshotItems: [], assertions: [], assertionVersions: [], assertionVersionSources: [], currentStates: [], grants: [], scopeGrants: [], confirmations: [], pins: [], deletionOperations: [], tombstones: [], redactionEpochs: {}, auditEvents: [], idempotencyRecords: [], outboxEvents: [] }),
    error => error.code === 'MEMORY_STORAGE_CONFLICT' && error.status === 409 && error.retryable === true
  );
  assert.equal(queries.some(sql => sql.startsWith('DELETE FROM')), false);
});

test('PostgreSQL repository persists subject-bound normalized source columns', async () => {
  const queries = [];
  const client = {
    async query(sql) {
      queries.push(sql);
      if (sql.startsWith('SELECT commit_seq')) return { rows: [] };
      return { rows: [] };
    },
    release() {}
  };
  const repository = createMemoryModulePostgresRepository({ connect: async () => client });
  const state = {
    persistenceBaseSequence: 0,
    sequence: 1,
    sessions: [],
    rawEvents: [],
    profileSnapshots: [],
    profileSnapshotItems: [{ snapshotId: 'snapshot-a', userId: 'user-a', assertionId: 'memory-a', versionId: 'version-a', scopeType: 'user', createdAt: new Date().toISOString() }],
    profileProjections: [],
    profileProjectionItems: [],
    profileProjectionSources: [{ projectionId: 'projection-a', userId: 'user-a', assertionId: 'memory-a', versionId: 'version-a', sourceId: 'event-a', createdAt: new Date().toISOString() }],
    indexDocuments: [],
    episodes: [],
    episodeMembers: [],
    assertions: [],
    assertionVersions: [],
    assertionVersionSources: [],
    currentStates: [],
    currentStateSources: [{ currentStateId: 'state-a', userId: 'user-a', rawEventId: 'event-a', sourceRole: 'observed', createdAt: new Date().toISOString() }],
    grants: [],
    scopeGrants: [],
    confirmations: [],
    accessConfirmations: [],
    pins: [],
    deletionOperations: [],
    tombstones: [],
    redactionEpochs: {},
    auditEvents: [],
    idempotencyRecords: [],
    outboxEvents: []
  };
  await repository.save({ tenantId: 'tenant-a', subjectUserId: 'user-a' }, state);
  assert.ok(queries.some(sql => sql.includes('INSERT INTO profile_snapshot_items (tenant_id,snapshot_id,user_id,assertion_id')));
  assert.ok(queries.some(sql => sql.includes('INSERT INTO profile_projection_sources (tenant_id,projection_id,user_id,assertion_id')));
  assert.ok(queries.some(sql => sql.includes('INSERT INTO current_state_sources (tenant_id,current_state_id,user_id,raw_event_id')));
});

test('PostgreSQL repository writes the optional pgvector column only when enabled', async () => {
  const queries = [];
  const params = [];
  const client = {
    async query(sql, values = []) {
      queries.push(sql);
      params.push(values);
      if (sql.startsWith('SELECT commit_seq')) return { rows: [] };
      return { rows: [] };
    },
    release() {}
  };
  const repository = createMemoryModulePostgresRepository({ connect: async () => client }, { pgvector: true });
  await repository.save(context, {
    persistenceBaseSequence: 0,
    sequence: 1,
    sessions: [],
    rawEvents: [],
    profileSnapshots: [],
    profileSnapshotItems: [],
    profileProjections: [],
    profileProjectionItems: [],
    profileProjectionSources: [],
    indexDocuments: [{ id: 'index-a', sourceType: 'assertion_version', sourceId: 'memory-a', sourceVersion: 'version-a', scopeType: 'user', searchText: 'safe', sensitivity: 'S0', contextualizable: true, mentionable: true, redactionEpoch: 0, policyEpoch: 'memory-policy-v1', grantVersion: 0, embedding: [1, 2], embeddingVersion: 'gateway-v1', lexicalVersion: 'bm25-v1', indexStatus: 'active', sourceRefs: [], createdAt: new Date().toISOString() }],
    episodes: [],
    episodeMembers: [],
    assertions: [],
    assertionVersions: [],
    assertionVersionSources: [],
    currentStates: [],
    currentStateSources: [],
    scopeGrants: [],
    confirmations: [],
    accessConfirmations: [],
    pins: [],
    deletionOperations: [],
    tombstones: [],
    redactionEpochs: {},
    auditEvents: [],
    idempotencyRecords: [],
    outboxEvents: []
  });
  const insertIndex = queries.findIndex(sql => sql.includes('INSERT INTO index_documents') && sql.includes('embedding_vector'));
  assert.notEqual(insertIndex, -1);
  assert.equal(params[insertIndex][17], '[1,2]');
});

test('PostgreSQL repository exposes native vector candidate search only in pgvector mode', async () => {
  const queries = [];
  const client = {
    async query(sql) {
      queries.push(sql);
      if (sql.includes('FROM index_documents d')) return { rows: [{ document_id: 'doc-a', tenant_id: 'tenant-a', user_id: 'user-a', memory_id: 'memory-a', version_id: 'version-a', source_refs: [], scope_type: 'user', assertion_status: 'active', memory_type: 'fact', assertion_type: 'observed_fact', subject_type: 'user', subject_id: 'user-a', sensitivity: 'S0', confidence: 1, importance: 0.5, mention_policy: 'mentionable', direct_query_policy: 'allow', resource_revision: 1, content: 'safe', structured_data: {}, content_type: 'plain_text', trust_level: 'user_explicit', version_status: 'current', candidate_score: 0.9 }] };
      return { rows: [] };
    },
    release() {}
  };
  const repository = createMemoryModulePostgresRepository({ connect: async () => client }, { pgvector: true });
  const results = await repository.searchIndexDocuments(context, { mode: 'vector', query: 'safe', queryVector: [1, 0] });
  assert.equal(results[0].memoryId, 'memory-a');
  assert.match(queries[0], /embedding_vector <=>/);

  const nonVectorRepository = createMemoryModulePostgresRepository({ connect: async () => client });
  await assert.rejects(() => nonVectorRepository.searchIndexDocuments(context, { mode: 'vector', query: 'safe', queryVector: [1, 0] }), error => error.code === 'PGVECTOR_NOT_ENABLED');
});

test('PostgreSQL repository supports lightweight retrieve metadata and confirmation side effects', async () => {
  const queries = [];
  const client = {
    async query(sql) {
      queries.push(sql);
      if (sql.includes('FROM memory_commit_sequences')) return { rows: [{ commit_seq: '12' }] };
      if (sql.includes('FROM redaction_epochs')) return { rows: [{ privacy_epoch: '3' }] };
      if (sql.includes('MAX(grant_version)')) return { rows: [{ grant_version: '7' }] };
      if (sql.includes('FROM access_confirmations')) return { rows: [{ id: 'access-a', tenant_id: 'tenant-a', user_id: 'user-a', actor_id: 'user-a', caller_agent_id: 'cochpia', session_id: null, purpose: 'answer_user_query', memory_ids: ['memory-a'], status: 'pending', token: null, created_at: '2026-08-22T00:00:00.000Z', expires_at: '2026-08-22T00:05:00.000Z', confirmed_at: null }] };
      return { rows: [] };
    },
    release() {}
  };
  const repository = createMemoryModulePostgresRepository({ connect: async () => client });
  const metadata = await repository.loadReadMetadata(context);
  assert.equal(metadata.sequence, 12);
  assert.equal(metadata.grantVersion, 7);
  assert.equal(metadata.redactionEpochs['tenant-a:user-a'], 3);
  assert.equal(metadata.accessConfirmations[0].id, 'access-a');
  await repository.saveAccessConfirmations(context, [{ ...metadata.accessConfirmations[0], status: 'confirmed', token: 'token-a' }]);
  assert.ok(queries.some(sql => sql.includes('INSERT INTO access_confirmations')));
  assert.ok(queries.some(sql => sql.includes('ON CONFLICT (id) DO UPDATE')));
});

test('PostgreSQL repository builds a bounded ContextBundle read model without full state loading', async () => {
  const client = {
    async query(sql) {
      if (sql.includes('FROM memory_commit_sequences')) return { rows: [{ commit_seq: '4' }] };
      if (sql.includes('FROM redaction_epochs')) return { rows: [{ privacy_epoch: '1' }] };
      if (sql.includes('MAX(grant_version)')) return { rows: [{ grant_version: '2' }] };
      if (sql.includes('FROM access_confirmations')) return { rows: [] };
      if (sql.includes("scope_type IN ('user', 'relationship')")) return { rows: [{ id: 'memory-a', tenant_id: 'tenant-a', user_id: 'user-a', scope_type: 'user', relationship_agent_id: null, session_id: null, memory_type: 'preference', assertion_type: 'observed_fact', canonical_key: 'drink', status: 'active', subject_type: 'user', subject_id: 'user-a', sensitivity: 'S0', confidence: '0.9', importance: '0.5', retention_policy: 'default_s0', recall_policy: 'default', auto_recall_allowed: true, mention_policy: 'mentionable', direct_query_policy: 'allow', expires_at: null, current_version_id: 'version-a', resource_revision: '1', created_at: '2026-08-22T00:00:00.000Z', updated_at: '2026-08-22T00:00:00.000Z' }] };
      if (sql.includes('FROM episodes')) return { rows: [{ id: 'episode-a', tenant_id: 'tenant-a', user_id: 'user-a', scope_type: 'user', relationship_agent_id: null, session_id: null, title: '茶饮', summary: '讨论红茶', observed_start: '2026-08-22T00:00:00.000Z', observed_end: '2026-08-22T00:10:00.000Z', grouping_rule_version: 'rule-v1', summary_model_version: 'model-v1', status: 'active', resource_revision: '1', created_at: '2026-08-22T00:00:00.000Z', updated_at: '2026-08-22T00:10:00.000Z' }] };
      if (sql.includes('FROM episode_members')) return { rows: [{ id: 'member-a', tenant_id: 'tenant-a', episode_id: 'episode-a', raw_event_id: 'raw-a', assertion_version_id: null, member_role: 'event', join_reason: 'temporal_adjacent', created_at: '2026-08-22T00:10:00.000Z' }] };
      if (sql.includes('FROM raw_events')) return { rows: [{ id: 'raw-a', tenant_id: 'tenant-a', user_id: 'user-a', event_id: 'event-a', source_revision: '1', session_id: null, turn_id: null, sequence_no: 1, event_role: 'user', content_type: 'plain_text', content: '讨论红茶', metadata: {}, occurred_at: '2026-08-22T00:00:00.000Z', is_stream_final: true, retention_policy: 'default_event', delete_after: '2026-08-23T00:00:00.000Z', resource_revision: '1', created_at: '2026-08-22T00:00:00.000Z', commit_seq: '4' }] };
      if (sql.includes('FROM assertion_versions')) return { rows: [{ id: 'version-a', tenant_id: 'tenant-a', assertion_id: 'memory-a', content: '喜欢红茶', structured_data: {}, content_type: 'plain_text', trust_level: 'user_explicit', observed_at: '2026-08-22T00:00:00.000Z', valid_from: null, valid_to: null, supersedes_version_id: null, version_status: 'current', created_by: 'user', promotion_reason: 'explicit', promotion_policy_version: 'policy-v1', created_at: '2026-08-22T00:00:00.000Z' }] };
      return { rows: [] };
    },
    release() {}
  };
  const repository = createMemoryModulePostgresRepository({ connect: async () => client });
  const state = await repository.loadContextBundleState(context, { query: '红茶' });
  assert.equal(state.assertions[0].id, 'memory-a');
  assert.equal(state.assertionVersions[0].id, 'version-a');
  assert.equal(state.episodes[0].id, 'episode-a');
  assert.equal(state.episodeMembers[0].rawEventId, 'raw-a');
  assert.equal(state.rawEvents[0].content, '讨论红茶');
  assert.equal(state.indexDocuments.length, 0);
});

test('PostgreSQL ContextBundle read model uses versioned cache and refreshes governed metadata', async () => {
  let cacheReads = 0;
  let cacheWrites = 0;
  const cache = {
    async getContextBundle() {
      cacheReads += 1;
      return cacheReads === 1 ? null : { cached: true, accessConfirmations: [], mentionCooldowns: [] };
    },
    async setContextBundle() {
      cacheWrites += 1;
      return true;
    }
  };
  const client = {
    async query(sql) {
      if (sql.includes('FROM memory_commit_sequences')) return { rows: [{ commit_seq: '4' }] };
      if (sql.includes('FROM redaction_epochs')) return { rows: [{ privacy_epoch: '1' }] };
      if (sql.includes('MAX(grant_version)')) return { rows: [{ grant_version: '2' }] };
      return { rows: [] };
    },
    release() {}
  };
  const repository = createMemoryModulePostgresRepository({ connect: async () => client }, { cache });
  const first = await repository.loadContextBundleState(context, { purpose: 'profile_view' });
  assert.equal(first.sequence, 4);
  assert.equal(cacheWrites, 1);
  const second = await repository.loadContextBundleState(context, { purpose: 'profile_view' });
  assert.equal(second.cached, true);
  assert.equal(second.sequence, 4);
  assert.equal(cacheReads, 2);
});

test('ContextBundle read model preserves the exact historical version from an active snapshot', async () => {
  const client = {
    async query(sql) {
      if (sql.includes('FROM memory_commit_sequences')) return { rows: [{ commit_seq: '9' }] };
      if (sql.includes('FROM redaction_epochs')) return { rows: [{ privacy_epoch: '2' }] };
      if (sql.includes('MAX(grant_version)')) return { rows: [{ grant_version: '4' }] };
      if (sql.includes('FROM access_confirmations')) return { rows: [] };
      if (sql.includes('FROM memory_sessions') && sql.includes("status='active'")) return { rows: [{ id: 'session-a', tenant_id: 'tenant-a', user_id: 'user-a', caller_agent_id: 'cochpia', status: 'active', started_at: '2026-08-22T00:00:00.000Z', closed_at: null, expires_at: '2026-08-23T00:00:00.000Z', profile_snapshot_id: 'snapshot-a', grant_version: '4', privacy_epoch: '2', resource_revision: '1' }] };
      if (sql.includes('FROM profile_snapshots')) return { rows: [{ id: 'snapshot-a', tenant_id: 'tenant-a', user_id: 'user-a', session_id: 'session-a', grant_version: '4', privacy_epoch: '2', resource_revision: '1', created_at: '2026-08-22T00:00:00.000Z' }] };
      if (sql.includes('FROM profile_snapshot_items')) return { rows: [{ tenant_id: 'tenant-a', snapshot_id: 'snapshot-a', user_id: 'user-a', assertion_id: 'memory-a', version_id: 'version-old', scope_type: 'user', created_at: '2026-08-22T00:00:00.000Z' }] };
      if (sql.includes('FROM episodes')) return { rows: [] };
      if (sql.includes("version_status='current'")) return { rows: [{ id: 'version-current', tenant_id: 'tenant-a', assertion_id: 'memory-a', content: '当前版本', structured_data: {}, content_type: 'plain_text', trust_level: 'user_explicit', observed_at: '2026-08-22T00:00:00.000Z', valid_from: null, valid_to: null, supersedes_version_id: 'version-old', version_status: 'current', created_by: 'user', promotion_reason: 'correction', promotion_policy_version: 'policy-v1', created_at: '2026-08-22T00:00:00.000Z' }] };
      if (sql.includes('FROM assertion_versions') && sql.includes('id = ANY')) return { rows: [{ id: 'version-old', tenant_id: 'tenant-a', assertion_id: 'memory-a', content: 'snapshot 固定版本', structured_data: {}, content_type: 'plain_text', trust_level: 'user_explicit', observed_at: '2026-08-21T00:00:00.000Z', valid_from: null, valid_to: null, supersedes_version_id: null, version_status: 'superseded', created_by: 'user', promotion_reason: 'explicit', promotion_policy_version: 'policy-v1', created_at: '2026-08-21T00:00:00.000Z' }] };
      if (sql.includes('FROM memory_assertions') && sql.includes('id = ANY')) return { rows: [{ id: 'memory-a', tenant_id: 'tenant-a', user_id: 'user-a', scope_type: 'user', relationship_agent_id: null, session_id: null, memory_type: 'preference', assertion_type: 'observed_fact', canonical_key: 'drink', status: 'active', subject_type: 'user', subject_id: 'user-a', sensitivity: 'S0', confidence: '0.9', importance: '0.5', retention_policy: 'default_s0', recall_policy: 'default', auto_recall_allowed: true, mention_policy: 'mentionable', direct_query_policy: 'allow', expires_at: null, current_version_id: 'version-current', resource_revision: '1', created_at: '2026-08-21T00:00:00.000Z', updated_at: '2026-08-22T00:00:00.000Z' }] };
      if (sql.includes('FROM current_states')) return { rows: [{ id: 'state-a', tenant_id: 'tenant-a', user_id: 'user-a', agent_id: 'cochpia', session_id: 'session-a', state_type: 'mood', value: '平静', confidence: '0.8', expires_at: '2026-08-22T23:00:00.000Z', allow_persist: false, requires_confirmation: false, promoted_from: null, promotion_actor: null, status: 'active', resource_revision: '1', created_at: '2026-08-22T00:00:00.000Z', updated_at: '2026-08-22T00:00:00.000Z' }] };
      return { rows: [] };
    },
    release() {}
  };
  const repository = createMemoryModulePostgresRepository({ connect: async () => client });
  const state = await repository.loadContextBundleState({ ...context, sessionId: 'session-a' });
  assert.equal(state.profileSnapshotItems[0].versionId, 'version-old');
  assert.equal(state.assertionVersions.find(item => item.id === 'version-old').content, 'snapshot 固定版本');
  assert.equal(state.currentStates[0].id, 'state-a');
});

test('PostgreSQL outbox load and save remain subject-bound for legacy aggregate rows', async () => {
  const queries = [];
  const params = [];
  const client = {
    async query(sql, values = []) {
      queries.push(sql);
      params.push(values);
      if (sql.startsWith('SELECT commit_seq')) return { rows: [] };
      return { rows: [] };
    },
    release() {}
  };
  const repository = createMemoryModulePostgresRepository({ connect: async () => client });

  await repository.load(context);
  const loadOutbox = queries.find(sql => sql.includes('FROM memory_outbox_events o'));
  assert.match(loadOutbox, /LEFT JOIN raw_events raw/);
  assert.match(loadOutbox, /LEFT JOIN memory_assertions assertion/);
  assert.match(loadOutbox, /o\.user_id IS NULL/);
  assert.match(loadOutbox, /COALESCE\(raw\.user_id, assertion\.user_id\)=\$2/);

  queries.length = 0;
  params.length = 0;
  await repository.save(context, {
    persistenceBaseSequence: 0,
    sequence: 1,
    sessions: [],
    rawEvents: [{ id: 'owned-raw' }],
    profileSnapshots: [],
    profileSnapshotItems: [],
    profileProjections: [],
    profileProjectionItems: [],
    profileProjectionSources: [],
    indexDocuments: [],
    episodes: [],
    episodeMembers: [],
    assertions: [],
    assertionVersions: [],
    assertionVersionSources: [],
    currentStates: [],
    currentStateSources: [],
    scopeGrants: [],
    confirmations: [],
    accessConfirmations: [],
    pins: [],
    deletionOperations: [{ targetId: 'arbitrary-account-target' }],
    tombstones: [{ targetId: 'arbitrary-tombstone-target' }],
    redactionEpochs: {},
    auditEvents: [],
    idempotencyRecords: [],
    outboxEvents: []
  });
  const deleteOutboxIndex = queries.findIndex(sql => sql.startsWith('DELETE FROM memory_outbox_events'));
  assert.notEqual(deleteOutboxIndex, -1);
  assert.deepEqual(params[deleteOutboxIndex], ['tenant-a', 'user-a', ['owned-raw']]);
});

test('PostgreSQL repository discovers due retention subjects with a bounded union query', async () => {
  const queries = [];
  const client = {
    async query(sql) {
      queries.push(sql);
      if (sql.includes('FROM raw_events') && sql.includes('FROM memory_idempotency_records')) return { rows: [{ tenant_id: 'tenant-a', user_id: 'user-a' }] };
      return { rows: [] };
    },
    release() {}
  };
  const repository = createMemoryModulePostgresRepository({ connect: async () => client });
  const subjects = await repository.listRetentionSubjects({ now: '2026-08-22T00:00:00.000Z', limit: 3 });
  assert.deepEqual(subjects, [{ tenantId: 'tenant-a', subjectUserId: 'user-a' }]);
  assert.match(queries[0], /LIMIT \$2/);
});

test('PostgreSQL repository exposes privacy, index freshness, backlog, and deletion metrics without content', async () => {
  const responses = [
    { rows: [{ status: 'pending', count: '3', oldest_age_seconds: '42' }] },
    { rows: [{ total: '10', active: '8', building: '1', stale: '1', invalidated: '0', stale_by_canonical_update: '1', max_freshness_lag_seconds: '17', privacy_epoch_mismatch: '2' }] },
    { rows: [{ status: 'propagating', count: '1', oldest_age_seconds: '9' }] }
  ];
  const client = {
    async query(sql) {
      assert.match(sql, /memory_outbox_events|index_documents|deletion_operations/);
      return responses.shift() || { rows: [] };
    },
    release() {}
  };
  const repository = createMemoryModulePostgresRepository({ connect: async () => client });
  const metrics = await repository.getOperationalMetrics({ now: new Date('2026-08-22T00:00:00.000Z') });
  assert.equal(metrics.outbox.pending.count, 3);
  assert.equal(metrics.outbox.pending.oldestAgeSeconds, 42);
  assert.equal(metrics.index.privacyEpochMismatch, 2);
  assert.equal(metrics.index.maxFreshnessLagSeconds, 17);
  assert.equal(metrics.deletions.propagating.count, 1);
  assert.equal(Object.hasOwn(metrics, 'content'), false);
});

test('PostgreSQL state save fences stale worker leases before destructive writes', async () => {
  const queries = [];
  const client = {
    async query(sql, values = []) {
      queries.push({ sql, values });
      if (sql.startsWith('SELECT commit_seq')) return { rows: [{ commit_seq: '0' }] };
      if (sql.includes('FROM memory_outbox_events o') && sql.includes("o.status='processing'")) return { rows: [] };
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
      return { rows: [] };
    },
    release() {}
  };
  const repository = createMemoryModulePostgresRepository({ connect: async () => client });
  await assert.rejects(
    () => repository.save(context, { persistenceBaseSequence: 0, sequence: 1, rawEvents: [], assertions: [], sessions: [], profileSnapshots: [], profileSnapshotItems: [], profileProjections: [], profileProjectionItems: [], profileProjectionSources: [], indexDocuments: [], episodes: [], episodeMembers: [], assertionVersions: [], assertionVersionSources: [], currentStates: [], currentStateSources: [], scopeGrants: [], confirmations: [], accessConfirmations: [], pins: [], deletionOperations: [], tombstones: [], redactionEpochs: {}, auditEvents: [], idempotencyRecords: [], outboxEvents: [] }, { fenceEventId: 'outbox-1', fenceWorkerId: 'worker-old' }),
    error => error.code === 'WORKER_FENCED' && error.status === 409 && error.retryable === true
  );
  assert.equal(queries.some(item => item.sql.startsWith('DELETE FROM')), false);
  assert.ok(queries.some(item => item.sql.includes('FOR UPDATE OF o')));
});
