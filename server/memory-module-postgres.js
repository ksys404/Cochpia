import { parsePgvectorVector, toPgvectorLiteral } from './memory-module-pgvector.js';
import { buildPostgresIndexCandidateQuery, mapPostgresIndexCandidate } from './memory-module-postgres-retrieval.js';

const userKey = context => `${context.tenantId}:${context.subjectUserId}`;

const mapSession = row => ({
  id: row.id,
  tenantId: row.tenant_id,
  userId: row.user_id,
  callerAgentId: row.caller_agent_id,
  status: row.status,
  startedAt: row.started_at,
  closedAt: row.closed_at,
  expiresAt: row.expires_at,
  profileSnapshotId: row.profile_snapshot_id,
  grantVersion: Number(row.grant_version),
  privacyEpoch: Number(row.privacy_epoch),
  resourceRevision: Number(row.resource_revision)
});

const mapProfileSnapshot = row => ({
  id: row.id,
  tenantId: row.tenant_id,
  userId: row.user_id,
  sessionId: row.session_id,
  grantVersion: Number(row.grant_version),
  privacyEpoch: Number(row.privacy_epoch),
  resourceRevision: Number(row.resource_revision),
  createdAt: row.created_at
});

const mapProfileProjection = row => ({
  id: row.id,
  tenantId: row.tenant_id,
  userId: row.user_id,
  scopeType: row.scope_type,
  relationshipAgentId: row.relationship_agent_id,
  projectionType: row.projection_type,
  sourceCommitSeq: Number(row.source_commit_seq),
  promotionPolicyVersion: row.promotion_policy_version,
  modelVersion: row.model_version,
  status: row.status,
  createdAt: row.created_at,
  activatedAt: row.activated_at,
  resourceRevision: Number(row.resource_revision)
});

const mapIndexDocument = row => ({
  id: row.id,
  tenantId: row.tenant_id,
  sourceType: row.source_type,
  sourceId: row.source_id,
  sourceVersion: row.source_version,
  userId: row.user_id,
  scopeType: row.scope_type,
  relationshipAgentId: row.relationship_agent_id,
  sessionId: row.session_id,
  searchText: row.search_text,
  sensitivity: row.sensitivity,
  contextualizable: row.contextualizable,
  mentionable: row.mentionable,
  redactionEpoch: Number(row.redaction_epoch),
  policyEpoch: row.policy_epoch,
  grantVersion: Number(row.grant_version),
  embedding: parsePgvectorVector(row.embedding_vector ?? row.embedding),
  embeddingVersion: row.embedding_version,
  lexicalVersion: row.lexical_version,
  indexStatus: row.index_status,
  sourceRefs: row.source_refs || [],
  createdAt: row.created_at
});

const mapEpisode = row => ({
  id: row.id,
  tenantId: row.tenant_id,
  userId: row.user_id,
  scopeType: row.scope_type,
  relationshipAgentId: row.relationship_agent_id,
  sessionId: row.session_id,
  title: row.title,
  summary: row.summary,
  observedStart: row.observed_start,
  observedEnd: row.observed_end,
  groupingRuleVersion: row.grouping_rule_version,
  summaryModelVersion: row.summary_model_version,
  status: row.status,
  resourceRevision: Number(row.resource_revision),
  createdAt: row.created_at,
  updatedAt: row.updated_at
});

const mapRawEvent = row => ({
  id: row.id,
  eventId: row.event_id,
  sourceRevision: row.source_revision,
  tenantId: row.tenant_id,
  userId: row.user_id,
  sessionId: row.session_id,
  turnId: row.turn_id,
  sequenceNo: row.sequence_no,
  eventRole: row.event_role,
  contentType: row.content_type,
  content: row.content,
  metadata: row.metadata || {},
  occurredAt: row.occurred_at,
  isStreamFinal: row.is_stream_final,
  retentionPolicy: row.retention_policy,
  deleteAfter: row.delete_after,
  resourceRevision: Number(row.resource_revision || 1),
  createdAt: row.created_at,
  commitSeq: Number(row.commit_seq)
});

const mapAssertion = row => ({
  id: row.id,
  tenantId: row.tenant_id,
  userId: row.user_id,
  scopeType: row.scope_type,
  relationshipAgentId: row.relationship_agent_id,
  sessionId: row.session_id,
  memoryType: row.memory_type,
  assertionType: row.assertion_type,
  canonicalKey: row.canonical_key,
  status: row.status,
  subjectType: row.subject_type,
  subjectId: row.subject_id,
  sensitivity: row.sensitivity,
  confidence: Number(row.confidence),
  importance: Number(row.importance),
  retentionPolicy: row.retention_policy,
  recallPolicy: row.recall_policy,
  autoRecallAllowed: row.auto_recall_allowed,
  mentionPolicy: row.mention_policy,
  directQueryPolicy: row.direct_query_policy,
  expiresAt: row.expires_at,
  currentVersionId: row.current_version_id,
  resourceRevision: Number(row.resource_revision),
  createdAt: row.created_at,
  updatedAt: row.updated_at
});

const mapVersion = row => ({
  id: row.id,
  assertionId: row.assertion_id,
  content: row.content,
  structuredData: row.structured_data || {},
  contentType: row.content_type,
  trustLevel: row.trust_level,
  observedAt: row.observed_at,
  validFrom: row.valid_from,
  validTo: row.valid_to,
  supersedesVersionId: row.supersedes_version_id,
  versionStatus: row.version_status,
  createdBy: row.created_by,
  promotionReason: row.promotion_reason,
  promotionPolicyVersion: row.promotion_policy_version,
  createdAt: row.created_at
});

const mapCurrentState = row => ({
  id: row.id,
  tenantId: row.tenant_id,
  userId: row.user_id,
  agentId: row.agent_id,
  sessionId: row.session_id,
  stateType: row.state_type,
  value: row.value,
  confidence: Number(row.confidence),
  expiresAt: row.expires_at,
  allowPersist: row.allow_persist,
  requiresConfirmation: row.requires_confirmation,
  promotedFrom: row.promoted_from,
  promotionActor: row.promotion_actor,
  status: row.status,
  resourceRevision: Number(row.resource_revision),
  createdAt: row.created_at,
  updatedAt: row.updated_at
});

const mapGrant = row => ({
  grantId: row.grant_id,
  tenantId: row.tenant_id,
  subjectUserId: row.subject_user_id,
  granteeType: row.grantee_type,
  granteeId: row.grantee_id,
  scopeType: row.scope_type,
  permissions: row.permissions || [],
  purpose: row.purpose,
  issuer: row.issuer,
  issuedAt: row.issued_at,
  expiresAt: row.expires_at,
  revokedAt: row.revoked_at,
  grantVersion: Number(row.grant_version),
  resourceRevision: Number(row.resource_revision)
});

const mapConfirmation = row => ({
  id: row.id,
  tenantId: row.tenant_id,
  userId: row.user_id,
  candidateAssertionId: row.candidate_assertion_id,
  candidateVersionId: row.candidate_version_id,
  proposedContent: row.proposed_content,
  structuredData: row.structured_data || {},
  scopeType: row.scope_type,
  relationshipAgentId: row.relationship_agent_id,
  sessionId: row.session_id,
  sensitivity: row.sensitivity,
  retentionPolicy: row.retention_policy,
  mentionPolicy: row.mention_policy,
  resourceRevision: Number(row.resource_revision),
  createdAt: row.created_at,
  expiresAt: row.expires_at,
  status: row.status,
  decidedBy: row.decided_by,
  decidedAt: row.decided_at
});

const mapAccessConfirmation = row => ({
  id: row.id,
  tenantId: row.tenant_id,
  userId: row.user_id,
  actorId: row.actor_id,
  callerAgentId: row.caller_agent_id,
  sessionId: row.session_id,
  purpose: row.purpose,
  memoryIds: row.memory_ids || [],
  status: row.status,
  token: row.token,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
  confirmedAt: row.confirmed_at
});

const mapMentionCooldown = row => ({
  id: row.id,
  tenantId: row.tenant_id,
  userId: row.user_id,
  actorId: row.actor_id,
  callerAgentId: row.caller_agent_id,
  memoryId: row.memory_id,
  topicKey: row.topic_key || '',
  lastMentionedAt: row.last_mentioned_at,
  cooldownUntil: row.cooldown_until,
  resourceRevision: Number(row.resource_revision || 1),
  createdAt: row.created_at,
  updatedAt: row.updated_at
});

const mapPin = row => ({
  id: row.id,
  tenantId: row.tenant_id,
  userId: row.user_id,
  assertionId: row.assertion_id,
  pinnedVersionId: row.pinned_version_id,
  followCurrent: row.follow_current,
  scopeType: row.scope_type,
  resourceRevision: Number(row.resource_revision),
  createdAt: row.created_at,
  revokedAt: row.revoked_at
});

const mapDeletionOperation = row => ({
  id: row.id,
  tenantId: row.tenant_id,
  subjectUserId: row.subject_user_id,
  targetType: row.target_type,
  targetId: row.target_id,
  requestedScope: row.requested_scope || {},
  action: row.action,
  status: row.status,
  requestedBy: row.requested_by,
  requestedAt: row.requested_at,
  canonicalHiddenAt: row.canonical_hidden_at,
  completedAt: row.completed_at,
  redactionEpoch: Number(row.redaction_epoch),
  resourceRevision: Number(row.resource_revision),
  lastErrorCode: row.last_error_code
});

const mapTombstone = row => ({
  id: row.id,
  tenantId: row.tenant_id,
  userId: row.user_id,
  targetType: row.target_type,
  targetId: row.target_id,
  action: row.action,
  redactionEpoch: Number(row.redaction_epoch),
  createdAt: row.created_at
});

const mapOutbox = row => ({
  id: row.id,
  tenantId: row.tenant_id,
  userId: row.user_id,
  consumerName: row.consumer_name || 'memory-derived',
  type: row.event_type,
  aggregateId: row.aggregate_id,
  schemaVersion: Number(row.schema_version),
  commitSeq: Number(row.commit_seq),
  status: row.status,
  leaseOwner: row.lease_owner,
  leaseUntil: row.lease_until,
  attempts: Number(row.attempts || 0),
  lastErrorCode: row.last_error_code,
  createdAt: row.created_at,
  deliveredAt: row.delivered_at
});

export function createMemoryModulePostgresRepository(pool, { pgvector = false, cache = null } = {}) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('A pg Pool is required');
  const usePgvector = pgvector === true;

  return {
    async loadReadMetadata(context) {
      const client = await pool.connect();
      try {
        const [sequence, redaction, grants, accessConfirmations, mentionCooldowns] = await Promise.all([
          client.query('SELECT commit_seq FROM memory_commit_sequences WHERE tenant_id=$1 AND user_id=$2', [context.tenantId, context.subjectUserId]),
          client.query('SELECT privacy_epoch FROM redaction_epochs WHERE tenant_id=$1 AND user_id=$2', [context.tenantId, context.subjectUserId]),
          client.query('SELECT COALESCE(MAX(grant_version), 0) AS grant_version FROM scope_grants WHERE tenant_id=$1 AND subject_user_id=$2', [context.tenantId, context.subjectUserId]),
          client.query('SELECT * FROM access_confirmations WHERE tenant_id=$1 AND user_id=$2 ORDER BY created_at', [context.tenantId, context.subjectUserId]),
          client.query('SELECT * FROM memory_mention_cooldowns WHERE tenant_id=$1 AND user_id=$2 ORDER BY created_at', [context.tenantId, context.subjectUserId])
        ]);
        const commitSeq = Number(sequence.rows[0]?.commit_seq || 0);
        return {
          sequence: commitSeq,
          persistenceBaseSequence: commitSeq,
          grantVersion: Number(grants.rows[0]?.grant_version || 0),
          policyVersion: 'memory-policy-v1',
          redactionEpochs: { [userKey(context)]: Number(redaction.rows[0]?.privacy_epoch || 0) },
          accessConfirmations: accessConfirmations.rows.map(mapAccessConfirmation),
          mentionCooldowns: mentionCooldowns.rows.map(mapMentionCooldown)
        };
      } finally {
        client.release();
      }
    },

    async loadContextBundleState(context, { purpose = 'answer_user_query', query = '' } = {}) {
      const metadata = await this.loadReadMetadata(context);
      const readVersion = [
        metadata.sequence,
        metadata.grantVersion,
        metadata.redactionEpochs[userKey(context)] || 0
      ].join(':');
      if (cache?.getContextBundle) {
        const cached = await cache.getContextBundle(context, { purpose, query, readVersion });
        if (cached) {
          return {
            ...cached,
            accessConfirmations: metadata.accessConfirmations,
            mentionCooldowns: metadata.mentionCooldowns,
            sequence: metadata.sequence,
            persistenceBaseSequence: metadata.persistenceBaseSequence,
            grantVersion: metadata.grantVersion,
            redactionEpochs: metadata.redactionEpochs,
            policyVersion: metadata.policyVersion
          };
        }
      }
      const client = await pool.connect();
      const state = {
        rawEvents: [],
        outboxEvents: [],
        sessions: [],
        profileSnapshots: [],
        profileSnapshotItems: [],
        profileProjections: [],
        profileProjectionItems: [],
        indexDocuments: [],
        episodes: [],
        episodeMembers: [],
        assertions: [],
        assertionVersions: [],
        assertionVersionSources: [],
        currentStates: [],
        currentStateSources: [],
        profileProjectionSources: [],
        confirmations: [],
        accessConfirmations: metadata.accessConfirmations,
        mentionCooldowns: metadata.mentionCooldowns,
        pins: [],
        scopeGrants: [],
        deletionOperations: [],
        tombstones: [],
        redactionEpochs: metadata.redactionEpochs,
        auditEvents: [],
        idempotencyRecords: [],
        sequence: metadata.sequence,
        persistenceBaseSequence: metadata.persistenceBaseSequence,
        grantVersion: metadata.grantVersion,
        policyVersion: metadata.policyVersion
      };
      const queryRows = async (sql, values) => (await client.query(sql, values)).rows;
      const rowsForIds = async (table, column, ids) => ids.length
        ? queryRows(`SELECT * FROM ${table} WHERE tenant_id=$1 AND ${column} = ANY($2::text[])`, [context.tenantId, ids])
        : [];
      try {
        const activeSessionRows = context.sessionId
          ? await queryRows(`
              SELECT * FROM memory_sessions
               WHERE tenant_id=$1 AND user_id=$2 AND id=$3 AND status='active' AND expires_at > now()
            `, [context.tenantId, context.subjectUserId, context.sessionId])
          : [];
        state.sessions = activeSessionRows.map(mapSession);
        const activeSession = state.sessions[0] || null;

        let profileAssertionIds = [];
        let profileSnapshotVersionIds = [];
        if (activeSession?.profileSnapshotId) {
          const snapshots = await queryRows('SELECT * FROM profile_snapshots WHERE tenant_id=$1 AND user_id=$2 AND id=$3', [context.tenantId, context.subjectUserId, activeSession.profileSnapshotId]);
          state.profileSnapshots = snapshots.map(mapProfileSnapshot);
          const snapshotItems = await queryRows('SELECT * FROM profile_snapshot_items WHERE tenant_id=$1 AND user_id=$2 AND snapshot_id=$3', [context.tenantId, context.subjectUserId, activeSession.profileSnapshotId]);
          state.profileSnapshotItems = snapshotItems.map(row => ({ tenantId: row.tenant_id, snapshotId: row.snapshot_id, userId: row.user_id, assertionId: row.assertion_id, versionId: row.version_id, scopeType: row.scope_type, createdAt: row.created_at }));
          profileAssertionIds = snapshotItems.map(row => row.assertion_id);
          profileSnapshotVersionIds = snapshotItems.map(row => row.version_id).filter(Boolean);
        } else {
          const profileAssertions = await queryRows(`
            SELECT * FROM memory_assertions
             WHERE tenant_id=$1 AND user_id=$2 AND status='active'
               AND scope_type IN ('user', 'relationship')
             ORDER BY updated_at DESC, id DESC
             LIMIT 100
          `, [context.tenantId, context.subjectUserId]);
          state.assertions = profileAssertions.map(mapAssertion);
          profileAssertionIds = profileAssertions.map(row => row.id);
        }

        const episodeRows = await queryRows(`
          SELECT * FROM episodes
           WHERE tenant_id=$1 AND user_id=$2 AND status='active'
             AND (
               scope_type='user'
               OR (scope_type='relationship' AND ($3::text IS NULL OR relationship_agent_id=$3))
               OR (scope_type='session' AND session_id=$4)
             )
           ORDER BY observed_end DESC, id DESC
           LIMIT 50
        `, [context.tenantId, context.subjectUserId, context.actorType === 'agent' ? context.callerAgentId : null, activeSession?.id || null]);
        state.episodes = episodeRows.map(mapEpisode);
        const episodeIds = episodeRows.map(row => row.id);
        const memberRows = await rowsForIds('episode_members', 'episode_id', episodeIds);
        state.episodeMembers = memberRows.map(row => ({ id: row.id, tenantId: row.tenant_id, episodeId: row.episode_id, rawEventId: row.raw_event_id, assertionVersionId: row.assertion_version_id, memberRole: row.member_role, joinReason: row.join_reason, createdAt: row.created_at }));
        const rawEventIds = memberRows.map(row => row.raw_event_id).filter(Boolean);
        const rawRows = await rowsForIds('raw_events', 'id', rawEventIds);
        state.rawEvents = rawRows.map(mapRawEvent);

        const memberVersionIds = memberRows.map(row => row.assertion_version_id).filter(Boolean);
        const rawSourceRows = rawEventIds.length
          ? await queryRows('SELECT * FROM assertion_version_sources WHERE tenant_id=$1 AND source_type=\'raw_event\' AND source_id = ANY($2::text[])', [context.tenantId, rawEventIds])
          : [];
        const rawSourceVersionIds = rawSourceRows.map(row => row.version_id);
        const allReferencedVersionIds = [...new Set([...profileSnapshotVersionIds, ...memberVersionIds, ...rawSourceVersionIds])];
        const versionRows = profileAssertionIds.length
          ? await queryRows('SELECT * FROM assertion_versions WHERE tenant_id=$1 AND assertion_id = ANY($2::text[]) AND version_status=\'current\'', [context.tenantId, profileAssertionIds])
          : [];
        const referencedVersionRows = allReferencedVersionIds.length
          ? await rowsForIds('assertion_versions', 'id', allReferencedVersionIds)
          : [];
        const versionById = new Map([...versionRows, ...referencedVersionRows].map(row => [row.id, row]));
        state.assertionVersions = [...versionById.values()].map(mapVersion);
        const assertionIds = [...new Set([...profileAssertionIds, ...referencedVersionRows.map(row => row.assertion_id)])];
        if (assertionIds.length && state.assertions.length < assertionIds.length) {
          const assertionRows = await rowsForIds('memory_assertions', 'id', assertionIds);
          const assertionById = new Map(state.assertions.map(item => [item.id, item]));
          for (const row of assertionRows) assertionById.set(row.id, mapAssertion(row));
          state.assertions = [...assertionById.values()];
        }
        const sourceVersionIds = [...versionById.keys()];
        const sourceRows = sourceVersionIds.length
          ? await queryRows('SELECT * FROM assertion_version_sources WHERE tenant_id=$1 AND version_id = ANY($2::text[])', [context.tenantId, sourceVersionIds])
          : [];
        state.assertionVersionSources = sourceRows.map(row => ({ tenantId: row.tenant_id, versionId: row.version_id, sourceType: row.source_type, sourceId: row.source_id, createdAt: row.created_at }));

        if (activeSession) {
          const currentRows = await queryRows(`
            SELECT * FROM current_states
             WHERE tenant_id=$1 AND user_id=$2 AND session_id=$3 AND status='active' AND expires_at > now()
          `, [context.tenantId, context.subjectUserId, activeSession.id]);
          state.currentStates = currentRows.map(mapCurrentState);
          const currentStateIds = currentRows.map(row => row.id);
          const currentSourceRows = currentStateIds.length
            ? await queryRows('SELECT * FROM current_state_sources WHERE tenant_id=$1 AND current_state_id = ANY($2::text[])', [context.tenantId, currentStateIds])
            : [];
          state.currentStateSources = currentSourceRows.map(row => ({ tenantId: row.tenant_id, currentStateId: row.current_state_id, userId: row.user_id, rawEventId: row.raw_event_id, sourceRole: row.source_role, createdAt: row.created_at }));
        }

        const pinRows = profileAssertionIds.length
          ? await queryRows('SELECT * FROM pins WHERE tenant_id=$1 AND user_id=$2 AND assertion_id = ANY($3::text[]) AND revoked_at IS NULL', [context.tenantId, context.subjectUserId, profileAssertionIds])
          : [];
        state.pins = pinRows.map(mapPin);
        const grantRows = await queryRows(`
          SELECT * FROM scope_grants
           WHERE tenant_id=$1 AND subject_user_id=$2 AND revoked_at IS NULL
             AND (expires_at IS NULL OR expires_at > now())
        `, [context.tenantId, context.subjectUserId]);
        state.scopeGrants = grantRows.map(mapGrant);
        const tombstoneRows = await queryRows('SELECT * FROM memory_tombstones WHERE tenant_id=$1 AND user_id=$2', [context.tenantId, context.subjectUserId]);
        state.tombstones = tombstoneRows.map(mapTombstone);
        if (cache?.setContextBundle) {
          await cache.setContextBundle(context, {
            purpose,
            query,
            readVersion,
            state: { ...state, accessConfirmations: [], mentionCooldowns: [] }
          });
        }
        return state;
      } finally {
        client.release();
      }
    },

    async saveAccessConfirmations(context, accessConfirmations = []) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const access of accessConfirmations) {
          if (access.tenantId !== context.tenantId || access.userId !== context.subjectUserId) continue;
          await client.query(`
            INSERT INTO access_confirmations (id,tenant_id,user_id,actor_id,caller_agent_id,session_id,purpose,memory_ids,status,token,created_at,expires_at,confirmed_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
            ON CONFLICT (id) DO UPDATE SET
              memory_ids=EXCLUDED.memory_ids,
              status=EXCLUDED.status,
              token=EXCLUDED.token,
              expires_at=EXCLUDED.expires_at,
              confirmed_at=EXCLUDED.confirmed_at
            WHERE access_confirmations.tenant_id=EXCLUDED.tenant_id
              AND access_confirmations.user_id=EXCLUDED.user_id
          `, [access.id, context.tenantId, context.subjectUserId, access.actorId, access.callerAgentId, access.sessionId, access.purpose, access.memoryIds || [], access.status, access.token, access.createdAt, access.expiresAt, access.confirmedAt || null]);
        }
        await client.query('COMMIT');
        await cache?.bumpSubjectGeneration?.(context);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },

    async searchIndexDocuments(context, input = {}) {
      if (input.mode === 'vector' && !usePgvector) {
        const error = new Error('Vector retrieval requires the pgvector repository mode');
        error.code = 'PGVECTOR_NOT_ENABLED';
        error.status = 503;
        error.retryable = false;
        throw error;
      }
      const client = await pool.connect();
      try {
        const query = buildPostgresIndexCandidateQuery({
          ...input,
          tenantId: context.tenantId,
          subjectUserId: context.subjectUserId,
          actorType: context.actorType,
          callerAgentId: context.callerAgentId,
          sessionId: context.sessionId
        });
        const result = await client.query(query.sql, query.params);
        return result.rows.map(mapPostgresIndexCandidate);
      } finally {
        client.release();
      }
    },

    async load(context) {
      const client = await pool.connect();
      try {
        const [sessions, snapshots, projections, indexDocuments, episodes, rawEvents, assertions, versions, currentStates, grants, confirmations, accessConfirmations, mentionCooldowns, pins, deletions, tombstones, redaction, audits, idempotency, sequence] = await Promise.all([
          client.query('SELECT * FROM memory_sessions WHERE tenant_id=$1 AND user_id=$2 ORDER BY started_at', [context.tenantId, context.subjectUserId]),
          client.query('SELECT * FROM profile_snapshots WHERE tenant_id=$1 AND user_id=$2 ORDER BY created_at', [context.tenantId, context.subjectUserId]),
          client.query('SELECT * FROM profile_projections WHERE tenant_id=$1 AND user_id=$2 ORDER BY created_at', [context.tenantId, context.subjectUserId]),
          client.query('SELECT * FROM index_documents WHERE tenant_id=$1 AND user_id=$2 ORDER BY created_at', [context.tenantId, context.subjectUserId]),
          client.query('SELECT * FROM episodes WHERE tenant_id=$1 AND user_id=$2 ORDER BY observed_start', [context.tenantId, context.subjectUserId]),
          client.query('SELECT * FROM raw_events WHERE tenant_id=$1 AND user_id=$2 ORDER BY occurred_at', [context.tenantId, context.subjectUserId]),
          client.query('SELECT * FROM memory_assertions WHERE tenant_id=$1 AND user_id=$2 ORDER BY created_at', [context.tenantId, context.subjectUserId]),
          client.query('SELECT * FROM assertion_versions WHERE tenant_id=$1 AND assertion_id IN (SELECT id FROM memory_assertions WHERE tenant_id=$1 AND user_id=$2) ORDER BY created_at', [context.tenantId, context.subjectUserId]),
          client.query('SELECT * FROM current_states WHERE tenant_id=$1 AND user_id=$2 ORDER BY created_at', [context.tenantId, context.subjectUserId]),
          client.query('SELECT * FROM scope_grants WHERE tenant_id=$1 AND subject_user_id=$2 ORDER BY issued_at', [context.tenantId, context.subjectUserId]),
          client.query('SELECT * FROM confirmation_requests WHERE tenant_id=$1 AND user_id=$2 ORDER BY created_at', [context.tenantId, context.subjectUserId]),
          client.query('SELECT * FROM access_confirmations WHERE tenant_id=$1 AND user_id=$2 ORDER BY created_at', [context.tenantId, context.subjectUserId]),
          client.query('SELECT * FROM memory_mention_cooldowns WHERE tenant_id=$1 AND user_id=$2 ORDER BY created_at', [context.tenantId, context.subjectUserId]),
          client.query('SELECT * FROM pins WHERE tenant_id=$1 AND user_id=$2 ORDER BY created_at', [context.tenantId, context.subjectUserId]),
          client.query('SELECT * FROM deletion_operations WHERE tenant_id=$1 AND subject_user_id=$2 ORDER BY requested_at', [context.tenantId, context.subjectUserId]),
          client.query('SELECT * FROM memory_tombstones WHERE tenant_id=$1 AND user_id=$2 ORDER BY created_at', [context.tenantId, context.subjectUserId]),
          client.query('SELECT * FROM redaction_epochs WHERE tenant_id=$1 AND user_id=$2', [context.tenantId, context.subjectUserId]),
          client.query('SELECT id,tenant_id,subject_user_id,actor_id,action,details,created_at FROM memory_audit_events WHERE tenant_id=$1 AND subject_user_id=$2 ORDER BY created_at', [context.tenantId, context.subjectUserId]),
          client.query('SELECT * FROM memory_idempotency_records WHERE tenant_id=$1 AND user_id=$2 ORDER BY created_at', [context.tenantId, context.subjectUserId]),
          client.query('SELECT commit_seq FROM memory_commit_sequences WHERE tenant_id=$1 AND user_id=$2', [context.tenantId, context.subjectUserId])
        ]);
        const assertionIds = assertions.rows.map(row => row.id);
        const versionIds = versions.rows.map(row => row.id);
        const snapshotIds = snapshots.rows.map(row => row.id);
        const projectionIds = projections.rows.map(row => row.id);
        const episodeIds = episodes.rows.map(row => row.id);
        const currentStateIds = currentStates.rows.map(row => row.id);
        const [sources, snapshotItems, projectionItems, projectionSources, currentStateSources, episodeMembers, outbox] = await Promise.all([
          versionIds.length ? client.query('SELECT * FROM assertion_version_sources WHERE tenant_id=$1 AND version_id = ANY($2::text[])', [context.tenantId, versionIds]) : { rows: [] },
          snapshotIds.length ? client.query('SELECT * FROM profile_snapshot_items WHERE tenant_id=$1 AND snapshot_id = ANY($2::text[])', [context.tenantId, snapshotIds]) : { rows: [] },
          projectionIds.length ? client.query('SELECT * FROM profile_projection_items WHERE tenant_id=$1 AND projection_id = ANY($2::text[])', [context.tenantId, projectionIds]) : { rows: [] },
          projectionIds.length ? client.query('SELECT * FROM profile_projection_sources WHERE tenant_id=$1 AND projection_id = ANY($2::text[])', [context.tenantId, projectionIds]) : { rows: [] },
          currentStateIds.length ? client.query('SELECT * FROM current_state_sources WHERE tenant_id=$1 AND current_state_id = ANY($2::text[])', [context.tenantId, currentStateIds]) : { rows: [] },
          episodeIds.length ? client.query('SELECT * FROM episode_members WHERE tenant_id=$1 AND episode_id = ANY($2::text[])', [context.tenantId, episodeIds]) : { rows: [] },
          client.query(`
            SELECT o.*
            FROM memory_outbox_events o
            LEFT JOIN raw_events raw ON raw.tenant_id = o.tenant_id AND raw.id = o.aggregate_id
            LEFT JOIN memory_assertions assertion ON assertion.tenant_id = o.tenant_id AND assertion.id = o.aggregate_id
            WHERE o.tenant_id=$1
              AND (o.user_id=$2 OR (o.user_id IS NULL AND COALESCE(raw.user_id, assertion.user_id)=$2))
            ORDER BY o.created_at
          `, [context.tenantId, context.subjectUserId])
        ]);
        const maxSequence = Math.max(0, ...rawEvents.rows.map(row => Number(row.commit_seq)), ...outbox.rows.map(row => Number(row.commit_seq)));
        return {
          rawEvents: rawEvents.rows.map(mapRawEvent),
          outboxEvents: outbox.rows.map(mapOutbox),
          sessions: sessions.rows.map(mapSession),
          profileSnapshots: snapshots.rows.map(mapProfileSnapshot),
          profileSnapshotItems: snapshotItems.rows.map(row => ({ tenantId: row.tenant_id, snapshotId: row.snapshot_id, userId: row.user_id, assertionId: row.assertion_id, versionId: row.version_id, scopeType: row.scope_type, createdAt: row.created_at })),
          profileProjections: projections.rows.map(mapProfileProjection),
          profileProjectionItems: projectionItems.rows.map(row => ({ tenantId: row.tenant_id, projectionId: row.projection_id, userId: row.user_id, assertionId: row.assertion_id, versionId: row.version_id, displayText: row.display_text, structuredData: row.structured_data || {}, sourceRefs: row.source_refs || [], createdAt: row.created_at })),
          profileProjectionSources: projectionSources.rows.map(row => ({ tenantId: row.tenant_id, projectionId: row.projection_id, userId: row.user_id, assertionId: row.assertion_id, versionId: row.version_id, sourceId: row.source_id, createdAt: row.created_at })),
          indexDocuments: indexDocuments.rows.map(mapIndexDocument),
          episodes: episodes.rows.map(mapEpisode),
          episodeMembers: episodeMembers.rows.map(row => ({ id: row.id, tenantId: row.tenant_id, episodeId: row.episode_id, rawEventId: row.raw_event_id, assertionVersionId: row.assertion_version_id, memberRole: row.member_role, joinReason: row.join_reason, createdAt: row.created_at })),
          assertions: assertions.rows.map(mapAssertion),
          assertionVersions: versions.rows.map(mapVersion),
          assertionVersionSources: sources.rows.map(row => ({ tenantId: row.tenant_id, versionId: row.version_id, sourceType: row.source_type, sourceId: row.source_id, createdAt: row.created_at })),
          currentStates: currentStates.rows.map(mapCurrentState),
          currentStateSources: currentStateSources.rows.map(row => ({ tenantId: row.tenant_id, currentStateId: row.current_state_id, userId: row.user_id, rawEventId: row.raw_event_id, sourceRole: row.source_role, createdAt: row.created_at })),
          confirmations: confirmations.rows.map(mapConfirmation),
          accessConfirmations: accessConfirmations.rows.map(mapAccessConfirmation),
          mentionCooldowns: mentionCooldowns.rows.map(mapMentionCooldown),
          pins: pins.rows.map(mapPin),
          scopeGrants: grants.rows.map(mapGrant),
          deletionOperations: deletions.rows.map(mapDeletionOperation),
          tombstones: tombstones.rows.map(mapTombstone),
          redactionEpochs: Object.fromEntries(redaction.rows.map(row => [userKey(context), Number(row.privacy_epoch)])),
          auditEvents: audits.rows.map(row => ({ id: row.id, tenantId: row.tenant_id, subjectUserId: row.subject_user_id, actorId: row.actor_id, action: row.action, details: row.details || {}, ...row.details, createdAt: row.created_at })),
          idempotencyRecords: idempotency.rows.map(row => ({ id: row.id, tenantId: row.tenant_id, userId: row.user_id, mutationNamespace: row.mutation_namespace || 'event', key: row.idempotency_key, requestFingerprint: row.request_fingerprint, response: row.response || {}, result: row.result, contentLength: row.content_length, contentType: row.content_type, resourceType: row.resource_type, resourceId: row.resource_id, responseContainsContent: row.response_contains_content === true, expiresAt: row.expires_at, createdAt: row.created_at })),
          sequence: Math.max(maxSequence, Number(sequence.rows[0]?.commit_seq || 0)),
          persistenceBaseSequence: Math.max(maxSequence, Number(sequence.rows[0]?.commit_seq || 0)),
          grantVersion: Math.max(0, ...grants.rows.map(row => Number(row.grant_version))),
          policyVersion: 'memory-policy-v1'
        };
      } finally {
        client.release();
      }
    },

    async save(context, state, { fenceEventId = null, fenceWorkerId = null } = {}) {
      if (Boolean(fenceEventId) !== Boolean(fenceWorkerId)) throw new TypeError('fenceEventId and fenceWorkerId must be provided together');
      const client = await pool.connect();
      const legacyOwnedAggregateIds = [...state.rawEvents.map(item => item.id), ...state.assertions.map(item => item.id)];
      try {
        await client.query('BEGIN');
        await client.query('SET CONSTRAINTS memory_assertions_current_version_fk DEFERRED');
        const currentSequence = await client.query('SELECT commit_seq FROM memory_commit_sequences WHERE tenant_id=$1 AND user_id=$2 FOR UPDATE', [context.tenantId, context.subjectUserId]);
        const databaseSequence = Number(currentSequence.rows[0]?.commit_seq || 0);
        const baseSequence = Number(state.persistenceBaseSequence ?? 0);
        if (databaseSequence !== baseSequence) {
          const error = new Error('Memory state changed since it was read');
          error.code = 'MEMORY_STORAGE_CONFLICT';
          error.status = 409;
          error.retryable = true;
          throw error;
        }
        if (fenceEventId) {
          const lease = await client.query(`
            SELECT o.id
            FROM memory_outbox_events o
            LEFT JOIN raw_events raw ON raw.tenant_id = o.tenant_id AND raw.id = o.aggregate_id
            LEFT JOIN memory_assertions assertion ON assertion.tenant_id = o.tenant_id AND assertion.id = o.aggregate_id
            WHERE o.id=$1
              AND o.tenant_id=$2
              AND COALESCE(o.user_id, raw.user_id, assertion.user_id)=$3
              AND o.lease_owner=$4
              AND o.status='processing'
            FOR UPDATE OF o
          `, [fenceEventId, context.tenantId, context.subjectUserId, fenceWorkerId]);
          if (!lease.rowCount) {
            const error = new Error('Outbox lease is no longer owned by this worker');
            error.code = 'WORKER_FENCED';
            error.status = 409;
            error.retryable = true;
            throw error;
          }
        }
        await client.query('DELETE FROM current_state_sources WHERE tenant_id=$1 AND current_state_id IN (SELECT id FROM current_states WHERE tenant_id=$1 AND user_id=$2)', [context.tenantId, context.subjectUserId]);
        await client.query('DELETE FROM current_states WHERE tenant_id=$1 AND user_id=$2', [context.tenantId, context.subjectUserId]);
        await client.query('DELETE FROM raw_events WHERE tenant_id=$1 AND user_id=$2', [context.tenantId, context.subjectUserId]);
        await client.query('DELETE FROM profile_snapshot_items WHERE tenant_id=$1 AND snapshot_id IN (SELECT id FROM profile_snapshots WHERE tenant_id=$1 AND user_id=$2)', [context.tenantId, context.subjectUserId]);
        await client.query('DELETE FROM profile_snapshots WHERE tenant_id=$1 AND user_id=$2', [context.tenantId, context.subjectUserId]);
        await client.query('DELETE FROM profile_projection_sources WHERE tenant_id=$1 AND projection_id IN (SELECT id FROM profile_projections WHERE tenant_id=$1 AND user_id=$2)', [context.tenantId, context.subjectUserId]);
        await client.query('DELETE FROM profile_projection_items WHERE tenant_id=$1 AND projection_id IN (SELECT id FROM profile_projections WHERE tenant_id=$1 AND user_id=$2)', [context.tenantId, context.subjectUserId]);
        await client.query('DELETE FROM profile_projections WHERE tenant_id=$1 AND user_id=$2', [context.tenantId, context.subjectUserId]);
        await client.query('DELETE FROM index_documents WHERE tenant_id=$1 AND user_id=$2', [context.tenantId, context.subjectUserId]);
        await client.query('DELETE FROM episode_members WHERE tenant_id=$1 AND episode_id IN (SELECT id FROM episodes WHERE tenant_id=$1 AND user_id=$2)', [context.tenantId, context.subjectUserId]);
        await client.query('DELETE FROM episodes WHERE tenant_id=$1 AND user_id=$2', [context.tenantId, context.subjectUserId]);
        await client.query('DELETE FROM scope_grants WHERE tenant_id=$1 AND subject_user_id=$2', [context.tenantId, context.subjectUserId]);
        await client.query('DELETE FROM confirmation_requests WHERE tenant_id=$1 AND user_id=$2', [context.tenantId, context.subjectUserId]);
        await client.query('DELETE FROM access_confirmations WHERE tenant_id=$1 AND user_id=$2', [context.tenantId, context.subjectUserId]);
        await client.query('DELETE FROM memory_mention_cooldowns WHERE tenant_id=$1 AND user_id=$2', [context.tenantId, context.subjectUserId]);
        await client.query('DELETE FROM pins WHERE tenant_id=$1 AND user_id=$2', [context.tenantId, context.subjectUserId]);
        await client.query('DELETE FROM deletion_operations WHERE tenant_id=$1 AND subject_user_id=$2', [context.tenantId, context.subjectUserId]);
        await client.query('DELETE FROM memory_tombstones WHERE tenant_id=$1 AND user_id=$2', [context.tenantId, context.subjectUserId]);
        await client.query('DELETE FROM redaction_epochs WHERE tenant_id=$1 AND user_id=$2', [context.tenantId, context.subjectUserId]);
        await client.query('DELETE FROM memory_audit_events WHERE tenant_id=$1 AND subject_user_id=$2', [context.tenantId, context.subjectUserId]);
        await client.query('DELETE FROM memory_idempotency_records WHERE tenant_id=$1 AND user_id=$2', [context.tenantId, context.subjectUserId]);
        await client.query('DELETE FROM memory_outbox_events WHERE tenant_id=$1 AND (user_id=$2 OR (user_id IS NULL AND aggregate_id = ANY($3::text[])))', [context.tenantId, context.subjectUserId, legacyOwnedAggregateIds]);
        await client.query('DELETE FROM memory_assertions WHERE tenant_id=$1 AND user_id=$2', [context.tenantId, context.subjectUserId]);
        await client.query('DELETE FROM memory_sessions WHERE tenant_id=$1 AND user_id=$2', [context.tenantId, context.subjectUserId]);

        for (const session of state.sessions) await client.query('INSERT INTO memory_sessions (id,tenant_id,user_id,caller_agent_id,status,started_at,closed_at,expires_at,profile_snapshot_id,grant_version,privacy_epoch,resource_revision) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)', [session.id, context.tenantId, context.subjectUserId, session.callerAgentId, session.status, session.startedAt, session.closedAt, session.expiresAt, session.profileSnapshotId, session.grantVersion, session.privacyEpoch, session.resourceRevision]);
        for (const event of state.rawEvents) await client.query('INSERT INTO raw_events (id,tenant_id,user_id,event_id,source_revision,session_id,turn_id,sequence_no,event_role,content_type,content,metadata,occurred_at,is_stream_final,retention_policy,delete_after,commit_seq,resource_revision,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)', [event.id, context.tenantId, context.subjectUserId, event.eventId, event.sourceRevision, event.sessionId, event.turnId, event.sequenceNo, event.eventRole, event.contentType, event.content, event.metadata || {}, event.occurredAt, event.isStreamFinal, event.retentionPolicy, event.deleteAfter, event.commitSeq, event.resourceRevision || 1, event.createdAt]);
        for (const assertion of state.assertions) await client.query('INSERT INTO memory_assertions (id,tenant_id,user_id,scope_type,relationship_agent_id,session_id,memory_type,assertion_type,canonical_key,status,subject_type,subject_id,sensitivity,confidence,importance,retention_policy,recall_policy,auto_recall_allowed,mention_policy,direct_query_policy,expires_at,current_version_id,resource_revision,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,NULL,$22,$23,$24)', [assertion.id, context.tenantId, context.subjectUserId, assertion.scopeType, assertion.relationshipAgentId, assertion.sessionId, assertion.memoryType, assertion.assertionType, assertion.canonicalKey, assertion.status, assertion.subjectType, assertion.subjectId, assertion.sensitivity, assertion.confidence, assertion.importance, assertion.retentionPolicy, assertion.recallPolicy, assertion.autoRecallAllowed, assertion.mentionPolicy, assertion.directQueryPolicy, assertion.expiresAt, assertion.resourceRevision, assertion.createdAt, assertion.updatedAt]);
        for (const version of state.assertionVersions) await client.query('INSERT INTO assertion_versions (id,tenant_id,assertion_id,content,structured_data,content_type,trust_level,observed_at,valid_from,valid_to,supersedes_version_id,version_status,created_by,promotion_reason,promotion_policy_version,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NULL,$11,$12,$13,$14,$15)', [version.id, context.tenantId, version.assertionId, version.content, version.structuredData || {}, version.contentType, version.trustLevel, version.observedAt, version.validFrom, version.validTo, version.versionStatus, version.createdBy, version.promotionReason, version.promotionPolicyVersion, version.createdAt]);
        for (const version of state.assertionVersions) if (version.supersedesVersionId) await client.query('UPDATE assertion_versions SET supersedes_version_id=$1 WHERE tenant_id=$2 AND id=$3', [version.supersedesVersionId, context.tenantId, version.id]);
        for (const assertion of state.assertions) if (assertion.currentVersionId) await client.query('UPDATE memory_assertions SET current_version_id=$1 WHERE tenant_id=$2 AND id=$3', [assertion.currentVersionId, context.tenantId, assertion.id]);
        for (const source of state.assertionVersionSources) await client.query('INSERT INTO assertion_version_sources (tenant_id,version_id,source_type,source_id,created_at) VALUES ($1,$2,$3,$4,$5)', [context.tenantId, source.versionId, source.sourceType || 'explicit_request', source.sourceId, source.createdAt || new Date().toISOString()]);
        for (const snapshot of state.profileSnapshots) await client.query('INSERT INTO profile_snapshots (id,tenant_id,user_id,session_id,grant_version,privacy_epoch,resource_revision,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [snapshot.id, context.tenantId, context.subjectUserId, snapshot.sessionId, snapshot.grantVersion, snapshot.privacyEpoch, snapshot.resourceRevision, snapshot.createdAt]);
        for (const item of state.profileSnapshotItems) await client.query('INSERT INTO profile_snapshot_items (tenant_id,snapshot_id,user_id,assertion_id,version_id,scope_type,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)', [context.tenantId, item.snapshotId, item.userId || context.subjectUserId, item.assertionId, item.versionId, item.scopeType, item.createdAt]);
        for (const projection of state.profileProjections) await client.query('INSERT INTO profile_projections (id,tenant_id,user_id,scope_type,relationship_agent_id,projection_type,source_commit_seq,promotion_policy_version,model_version,status,created_at,activated_at,resource_revision) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)', [projection.id, context.tenantId, context.subjectUserId, projection.scopeType, projection.relationshipAgentId, projection.projectionType, projection.sourceCommitSeq, projection.promotionPolicyVersion, projection.modelVersion, projection.status, projection.createdAt, projection.activatedAt, projection.resourceRevision]);
        for (const item of state.profileProjectionItems) await client.query('INSERT INTO profile_projection_items (tenant_id,projection_id,user_id,assertion_id,version_id,display_text,structured_data,source_refs,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [context.tenantId, item.projectionId, context.subjectUserId, item.assertionId, item.versionId, item.displayText, item.structuredData || {}, item.sourceRefs || [], item.createdAt]);
        for (const source of state.profileProjectionSources) await client.query('INSERT INTO profile_projection_sources (tenant_id,projection_id,user_id,assertion_id,version_id,source_id,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)', [context.tenantId, source.projectionId, source.userId || context.subjectUserId, source.assertionId, source.versionId, source.sourceId, source.createdAt]);
        for (const document of state.indexDocuments) {
          if (usePgvector) {
            await client.query('INSERT INTO index_documents (id,tenant_id,source_type,source_id,source_version,user_id,scope_type,relationship_agent_id,session_id,search_text,sensitivity,contextualizable,mentionable,redaction_epoch,policy_epoch,grant_version,embedding,embedding_vector,embedding_version,lexical_version,index_status,source_refs,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)', [document.id, context.tenantId, document.sourceType, document.sourceId, document.sourceVersion, context.subjectUserId, document.scopeType, document.relationshipAgentId, document.sessionId, document.searchText, document.sensitivity, document.contextualizable, document.mentionable, document.redactionEpoch, document.policyEpoch, document.grantVersion, document.embedding ? JSON.stringify(document.embedding) : null, document.embedding ? toPgvectorLiteral(document.embedding) : null, document.embeddingVersion, document.lexicalVersion, document.indexStatus, document.sourceRefs || [], document.createdAt]);
          } else {
            await client.query('INSERT INTO index_documents (id,tenant_id,source_type,source_id,source_version,user_id,scope_type,relationship_agent_id,session_id,search_text,sensitivity,contextualizable,mentionable,redaction_epoch,policy_epoch,grant_version,embedding,embedding_version,lexical_version,index_status,source_refs,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)', [document.id, context.tenantId, document.sourceType, document.sourceId, document.sourceVersion, context.subjectUserId, document.scopeType, document.relationshipAgentId, document.sessionId, document.searchText, document.sensitivity, document.contextualizable, document.mentionable, document.redactionEpoch, document.policyEpoch, document.grantVersion, document.embedding || null, document.embeddingVersion, document.lexicalVersion, document.indexStatus, document.sourceRefs || [], document.createdAt]);
          }
        }
        for (const episode of state.episodes) await client.query('INSERT INTO episodes (id,tenant_id,user_id,scope_type,relationship_agent_id,session_id,title,summary,observed_start,observed_end,grouping_rule_version,summary_model_version,status,resource_revision,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)', [episode.id, context.tenantId, context.subjectUserId, episode.scopeType, episode.relationshipAgentId, episode.sessionId, episode.title, episode.summary, episode.observedStart, episode.observedEnd, episode.groupingRuleVersion, episode.summaryModelVersion, episode.status, episode.resourceRevision, episode.createdAt, episode.updatedAt]);
        for (const member of state.episodeMembers) await client.query('INSERT INTO episode_members (id,tenant_id,episode_id,raw_event_id,assertion_version_id,member_role,join_reason,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [member.id, context.tenantId, member.episodeId, member.rawEventId || null, member.assertionVersionId || null, member.memberRole, member.joinReason, member.createdAt]);
        for (const current of state.currentStates) await client.query('INSERT INTO current_states (id,tenant_id,user_id,agent_id,session_id,state_type,value,confidence,expires_at,allow_persist,requires_confirmation,promoted_from,promotion_actor,status,resource_revision,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)', [current.id, context.tenantId, context.subjectUserId, current.agentId, current.sessionId, current.stateType, current.value, current.confidence, current.expiresAt, current.allowPersist, current.requiresConfirmation, current.promotedFrom, current.promotionActor, current.status, current.resourceRevision, current.createdAt, current.updatedAt]);
        for (const source of state.currentStateSources) await client.query('INSERT INTO current_state_sources (tenant_id,current_state_id,user_id,raw_event_id,source_role,created_at) VALUES ($1,$2,$3,$4,$5,$6)', [context.tenantId, source.currentStateId, source.userId || context.subjectUserId, source.rawEventId, source.sourceRole || 'observed', source.createdAt]);
        for (const grant of state.scopeGrants) await client.query('INSERT INTO scope_grants (grant_id,tenant_id,subject_user_id,grantee_type,grantee_id,scope_type,permissions,purpose,issuer,issued_at,expires_at,revoked_at,grant_version,resource_revision) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)', [grant.grantId, context.tenantId, context.subjectUserId, grant.granteeType, grant.granteeId, grant.scopeType, grant.permissions, grant.purpose, grant.issuer, grant.issuedAt, grant.expiresAt, grant.revokedAt, grant.grantVersion, grant.resourceRevision]);
        for (const confirmation of state.confirmations) await client.query('INSERT INTO confirmation_requests (id,tenant_id,user_id,candidate_assertion_id,candidate_version_id,proposed_content,structured_data,scope_type,relationship_agent_id,session_id,sensitivity,retention_policy,mention_policy,resource_revision,created_at,expires_at,status,decided_by,decided_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)', [confirmation.id, context.tenantId, context.subjectUserId, confirmation.candidateAssertionId, confirmation.candidateVersionId, confirmation.proposedContent, confirmation.structuredData || {}, confirmation.scopeType, confirmation.relationshipAgentId, confirmation.sessionId, confirmation.sensitivity, confirmation.retentionPolicy, confirmation.mentionPolicy, confirmation.resourceRevision, confirmation.createdAt, confirmation.expiresAt, confirmation.status, confirmation.decidedBy, confirmation.decidedAt]);
        for (const access of state.accessConfirmations) await client.query('INSERT INTO access_confirmations (id,tenant_id,user_id,actor_id,caller_agent_id,session_id,purpose,memory_ids,status,token,created_at,expires_at,confirmed_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)', [access.id, context.tenantId, context.subjectUserId, access.actorId, access.callerAgentId, access.sessionId, access.purpose, access.memoryIds, access.status, access.token, access.createdAt, access.expiresAt, access.confirmedAt || null]);
        for (const mention of state.mentionCooldowns || []) await client.query('INSERT INTO memory_mention_cooldowns (id,tenant_id,user_id,actor_id,caller_agent_id,memory_id,topic_key,last_mentioned_at,cooldown_until,resource_revision,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)', [mention.id, context.tenantId, context.subjectUserId, mention.actorId, mention.callerAgentId, mention.memoryId, mention.topicKey || '', mention.lastMentionedAt, mention.cooldownUntil, mention.resourceRevision || 1, mention.createdAt, mention.updatedAt]);
        for (const pin of state.pins) await client.query('INSERT INTO pins (id,tenant_id,user_id,assertion_id,pinned_version_id,follow_current,scope_type,resource_revision,created_at,revoked_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [pin.id, context.tenantId, context.subjectUserId, pin.assertionId, pin.pinnedVersionId, pin.followCurrent, pin.scopeType, pin.resourceRevision, pin.createdAt, pin.revokedAt]);
        for (const operation of state.deletionOperations) await client.query('INSERT INTO deletion_operations (id,tenant_id,subject_user_id,target_type,target_id,requested_scope,action,status,requested_by,requested_at,canonical_hidden_at,completed_at,redaction_epoch,last_error_code,resource_revision) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)', [operation.id, context.tenantId, context.subjectUserId, operation.targetType, operation.targetId, operation.requestedScope || {}, operation.action, operation.status, operation.requestedBy, operation.requestedAt, operation.canonicalHiddenAt, operation.completedAt, operation.redactionEpoch, operation.lastErrorCode, operation.resourceRevision]);
        for (const tombstone of state.tombstones) await client.query('INSERT INTO memory_tombstones (id,tenant_id,user_id,target_type,target_id,action,redaction_epoch,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [tombstone.id, context.tenantId, context.subjectUserId, tombstone.targetType, tombstone.targetId, tombstone.action, tombstone.redactionEpoch, tombstone.createdAt]);
        const epoch = state.redactionEpochs[userKey(context)] || 0;
        await client.query('INSERT INTO redaction_epochs (tenant_id,user_id,privacy_epoch,updated_at) VALUES ($1,$2,$3,now())', [context.tenantId, context.subjectUserId, epoch]);
        for (const event of state.outboxEvents) await client.query('INSERT INTO memory_outbox_events (id,tenant_id,user_id,consumer_name,event_type,aggregate_id,schema_version,commit_seq,status,lease_owner,lease_until,attempts,last_error_code,created_at,delivered_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)', [event.id, context.tenantId, event.userId || context.subjectUserId, event.consumerName || 'memory-derived', event.type, event.aggregateId, event.schemaVersion, event.commitSeq, event.status, event.leaseOwner || null, event.leaseUntil || null, event.attempts || 0, event.lastErrorCode || null, event.createdAt, event.deliveredAt || null]);
        for (const event of state.auditEvents) await client.query('INSERT INTO memory_audit_events (id,tenant_id,subject_user_id,actor_id,action,details,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)', [event.id, context.tenantId, context.subjectUserId, event.actorId, event.action, event.details || {}, event.createdAt]);
        for (const record of state.idempotencyRecords) await client.query('INSERT INTO memory_idempotency_records (id,tenant_id,user_id,mutation_namespace,idempotency_key,request_fingerprint,response,result,content_length,content_type,resource_type,resource_id,response_contains_content,expires_at,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)', [record.id, context.tenantId, context.subjectUserId, record.mutationNamespace || 'event', record.key, record.requestFingerprint || '', record.response || {}, record.result || null, record.contentLength ?? null, record.contentType || null, record.resourceType || null, record.resourceId || null, Boolean(record.responseContainsContent), record.expiresAt || null, record.createdAt]);
        await client.query('INSERT INTO memory_commit_sequences (tenant_id,user_id,commit_seq,updated_at) VALUES ($1,$2,$3,now()) ON CONFLICT (tenant_id,user_id) DO UPDATE SET commit_seq=EXCLUDED.commit_seq, updated_at=now()', [context.tenantId, context.subjectUserId, state.sequence]);
        await client.query('COMMIT');
        state.persistenceBaseSequence = state.sequence;
        await cache?.bumpSubjectGeneration?.(context);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },

    async claimOutboxEvent({ workerId, leaseMs = 30_000, now = new Date(), eventTypes = null, consumerName = 'memory-derived' } = {}) {
      if (!workerId) throw new TypeError('workerId is required');
      const client = await pool.connect();
      try {
        const result = await client.query(`
          WITH candidate AS (
            SELECT o.id,
                   o.tenant_id,
                   COALESCE(o.user_id, raw.user_id, assertion.user_id) AS resolved_user_id
            FROM memory_outbox_events o
            LEFT JOIN raw_events raw ON raw.tenant_id = o.tenant_id AND raw.id = o.aggregate_id
            LEFT JOIN memory_assertions assertion ON assertion.tenant_id = o.tenant_id AND assertion.id = o.aggregate_id
            WHERE (o.status = 'pending' OR (o.status = 'processing' AND o.lease_until IS NOT NULL AND o.lease_until <= $2::timestamptz))
              AND ($4::text[] IS NULL OR o.event_type = ANY($4::text[]))
              AND o.consumer_name = $5
              AND COALESCE(o.user_id, raw.user_id, assertion.user_id) IS NOT NULL
            ORDER BY o.created_at, o.id
            FOR UPDATE OF o SKIP LOCKED
            LIMIT 1
          )
          UPDATE memory_outbox_events o
          SET status = 'processing',
              lease_owner = $1,
              lease_until = $2::timestamptz + ($3::bigint * interval '1 millisecond'),
              attempts = o.attempts + 1
          FROM candidate
          WHERE o.id = candidate.id
          RETURNING o.*, candidate.resolved_user_id AS resolved_user_id
        `, [workerId, new Date(now).toISOString(), leaseMs, eventTypes?.length ? eventTypes : null, consumerName]);
        const row = result.rows[0];
        if (!row) return null;
        return {
          event: mapOutbox({ ...row, user_id: row.user_id || row.resolved_user_id }),
          context: { tenantId: row.tenant_id, subjectUserId: row.resolved_user_id }
        };
      } finally {
        client.release();
      }
    },

    async finishOutboxEvent({ eventId, workerId, status = 'completed', result = null, errorCode = null } = {}) {
      if (!eventId || !workerId) throw new TypeError('eventId and workerId are required');
      const client = await pool.connect();
      try {
        const response = await client.query('UPDATE memory_outbox_events SET status=$1, last_error_code=$2, delivered_at=CASE WHEN $1 = \'completed\' THEN now() ELSE delivered_at END, lease_owner=NULL, lease_until=NULL WHERE id=$3 AND lease_owner=$4 AND status=\'processing\' RETURNING id', [status, errorCode, eventId, workerId]);
        return { updated: response.rowCount === 1, eventId, status, result };
      } finally {
        client.release();
      }
    },

    async listRetentionSubjects({ now = new Date(), limit = 100 } = {}) {
      const client = await pool.connect();
      try {
        const result = await client.query(`
          SELECT tenant_id, user_id
          FROM (
            SELECT tenant_id, user_id
            FROM raw_events
            WHERE delete_after IS NOT NULL AND delete_after <= $1::timestamptz
            UNION
            SELECT tenant_id, user_id
            FROM memory_sessions
            WHERE status = 'active' AND expires_at <= $1::timestamptz
            UNION
            SELECT tenant_id, user_id
            FROM memory_assertions
            WHERE expires_at IS NOT NULL AND expires_at <= $1::timestamptz
            UNION
            SELECT tenant_id, user_id
            FROM current_states
            WHERE status = 'active' AND expires_at <= $1::timestamptz
            UNION
            SELECT tenant_id, user_id
            FROM confirmation_requests
            WHERE status = 'pending' AND expires_at <= $1::timestamptz
            UNION
            SELECT tenant_id, user_id
            FROM memory_idempotency_records
            WHERE mutation_namespace <> 'event' AND expires_at IS NOT NULL AND expires_at <= $1::timestamptz
          ) due
          ORDER BY tenant_id, user_id
          LIMIT $2
        `, [new Date(now).toISOString(), Math.max(1, Math.min(1000, Number(limit) || 100))]);
        return result.rows.map(row => ({ tenantId: row.tenant_id, subjectUserId: row.user_id }));
      } finally {
        client.release();
      }
    },

    async getOperationalMetrics({ now = new Date() } = {}) {
      const client = await pool.connect();
      try {
        const [outbox, index, deletions] = await Promise.all([
          client.query(`
            SELECT status,
                   COUNT(*)::bigint AS count,
                   COALESCE(EXTRACT(EPOCH FROM ($1::timestamptz - MIN(created_at)))::bigint, 0) AS oldest_age_seconds
              FROM memory_outbox_events
             GROUP BY status
          `, [new Date(now).toISOString()]),
          client.query(`
            SELECT
              COUNT(*)::bigint AS total,
              COUNT(*) FILTER (WHERE d.index_status='active')::bigint AS active,
              COUNT(*) FILTER (WHERE d.index_status='building')::bigint AS building,
              COUNT(*) FILTER (WHERE d.index_status='stale')::bigint AS stale,
              COUNT(*) FILTER (WHERE d.index_status='invalidated')::bigint AS invalidated,
              COUNT(*) FILTER (WHERE a.updated_at > d.created_at)::bigint AS stale_by_canonical_update,
              COALESCE(MAX(GREATEST(0, EXTRACT(EPOCH FROM (a.updated_at - d.created_at))))::bigint, 0) AS max_freshness_lag_seconds,
              COUNT(*) FILTER (WHERE d.redaction_epoch <> COALESCE(redaction.privacy_epoch, 0))::bigint AS privacy_epoch_mismatch
            FROM index_documents d
            LEFT JOIN memory_assertions a ON a.tenant_id=d.tenant_id AND a.id=d.source_id
            LEFT JOIN redaction_epochs redaction ON redaction.tenant_id=d.tenant_id AND redaction.user_id=d.user_id
          `),
          client.query(`
            SELECT status,
                   COUNT(*)::bigint AS count,
                   COALESCE(EXTRACT(EPOCH FROM ($1::timestamptz - MIN(requested_at)))::bigint, 0) AS oldest_age_seconds
              FROM deletion_operations
             GROUP BY status
          `, [new Date(now).toISOString()])
        ]);
        const byStatus = rows => Object.fromEntries(rows.map(row => [row.status, { count: Number(row.count || 0), oldestAgeSeconds: Number(row.oldest_age_seconds || 0) }]));
        const indexRow = index.rows[0] || {};
        return {
          collectedAt: new Date(now).toISOString(),
          outbox: byStatus(outbox.rows),
          index: {
            total: Number(indexRow.total || 0),
            active: Number(indexRow.active || 0),
            building: Number(indexRow.building || 0),
            stale: Number(indexRow.stale || 0),
            invalidated: Number(indexRow.invalidated || 0),
            staleByCanonicalUpdate: Number(indexRow.stale_by_canonical_update || 0),
            maxFreshnessLagSeconds: Number(indexRow.max_freshness_lag_seconds || 0),
            privacyEpochMismatch: Number(indexRow.privacy_epoch_mismatch || 0)
          },
          deletions: byStatus(deletions.rows)
        };
      } finally {
        client.release();
      }
    }
  };
}
