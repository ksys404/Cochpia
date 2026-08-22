import { toPgvectorLiteral } from './memory-module-pgvector.js';

const PURPOSE_PERMISSIONS = Object.freeze({
  answer_user_query: 'contextualize',
  proactive_mention: 'mention',
  profile_view: 'retrieve',
  governance: 'govern'
});

function boundedLimit(value) {
  return Math.max(1, Math.min(100, Number.isInteger(Number(value)) ? Number(value) : 50));
}

function addParameter(params, value) {
  params.push(value);
  return `$${params.length}`;
}

export function buildPostgresIndexCandidateQuery({
  tenantId,
  subjectUserId,
  actorType = 'user',
  callerAgentId = null,
  sessionId = null,
  purpose = 'answer_user_query',
  query,
  queryVector = null,
  mode = 'lexical',
  policyVersion = 'memory-policy-v1',
  now = new Date(),
  limit = 50
} = {}) {
  if (!tenantId || !subjectUserId) throw new TypeError('tenantId and subjectUserId are required');
  if (!Object.hasOwn(PURPOSE_PERMISSIONS, purpose)) throw new TypeError('Unsupported retrieval purpose');
  if (!['lexical', 'vector'].includes(mode)) throw new TypeError('Unsupported PostgreSQL retrieval mode');
  const normalizedQuery = String(query || '').trim();
  if (!normalizedQuery) throw new TypeError('query is required');

  const params = [tenantId, subjectUserId];
  const conditions = [
    'd.tenant_id = $1',
    'd.user_id = $2',
    "d.index_status = 'active'",
    "a.status = 'active'",
    "v.version_status = 'current'",
    'd.source_id = a.id',
    'd.source_version = v.id',
    'v.assertion_id = a.id',
    '(a.expires_at IS NULL OR a.expires_at > $3::timestamptz)',
    '(v.valid_from IS NULL OR v.valid_from <= $3::timestamptz)',
    '(v.valid_to IS NULL OR v.valid_to > $3::timestamptz)',
    "d.redaction_epoch = COALESCE(redaction.privacy_epoch, 0)",
    `d.policy_epoch = $4`
  ];
  params.push(new Date(now).toISOString(), policyVersion);

  if (actorType === 'agent') {
    if (!callerAgentId) throw new TypeError('callerAgentId is required for agent retrieval');
    const agentParam = addParameter(params, callerAgentId);
    const permissionParam = addParameter(params, PURPOSE_PERMISSIONS[purpose]);
    const sessionParam = sessionId ? addParameter(params, sessionId) : 'NULL';
    conditions.push(`(
      (d.scope_type = 'relationship' AND d.relationship_agent_id = ${agentParam})
      OR (d.scope_type = 'session' AND d.relationship_agent_id = ${agentParam} AND d.session_id = ${sessionParam})
      OR (d.scope_type = 'user' AND EXISTS (
        SELECT 1 FROM scope_grants grant_row
         WHERE grant_row.tenant_id = d.tenant_id
           AND grant_row.subject_user_id = d.user_id
           AND grant_row.grantee_type = 'agent'
           AND grant_row.grantee_id = ${agentParam}
           AND grant_row.scope_type = 'user'
           AND grant_row.permissions @> ARRAY[${permissionParam}]::text[]
           AND grant_row.revoked_at IS NULL
           AND (grant_row.expires_at IS NULL OR grant_row.expires_at > $3::timestamptz)
      ))
    )`);
  }
  if (purpose === 'proactive_mention') conditions.push("a.mention_policy = 'mentionable'");

  let scoreExpression;
  let orderBy;
  if (mode === 'vector') {
    if (!Array.isArray(queryVector)) throw new TypeError('queryVector is required for vector retrieval');
    const vectorParam = addParameter(params, toPgvectorLiteral(queryVector));
    scoreExpression = `1 - (d.embedding_vector <=> ${vectorParam}::vector)`;
    conditions.push('d.embedding_vector IS NOT NULL');
    orderBy = `d.embedding_vector <=> ${vectorParam}::vector ASC, d.id ASC`;
  } else {
    const queryParam = addParameter(params, normalizedQuery);
    scoreExpression = `ts_rank_cd(to_tsvector('simple', d.search_text), websearch_to_tsquery('simple', ${queryParam}))
      + CASE WHEN d.search_text ILIKE '%' || ${queryParam} || '%' THEN 0.1 ELSE 0 END`;
    conditions.push(`(
      to_tsvector('simple', d.search_text) @@ websearch_to_tsquery('simple', ${queryParam})
      OR d.search_text ILIKE '%' || ${queryParam} || '%'
    )`);
    orderBy = `candidate_score DESC, d.id ASC`;
  }
  const limitParam = addParameter(params, boundedLimit(limit));
  const sql = `
    SELECT
      d.id AS document_id,
      d.tenant_id,
      d.user_id,
      d.source_id AS memory_id,
      d.source_version AS version_id,
      d.source_refs,
      d.scope_type,
      d.relationship_agent_id,
      d.session_id,
      d.sensitivity AS indexed_sensitivity,
      d.contextualizable,
      d.mentionable,
      d.redaction_epoch,
      d.policy_epoch,
      d.grant_version,
      d.embedding_version,
      d.lexical_version,
      a.status AS assertion_status,
      a.memory_type,
      a.assertion_type,
      a.canonical_key,
      a.subject_type,
      a.subject_id,
      a.sensitivity,
      a.confidence,
      a.importance,
      a.retention_policy,
      a.recall_policy,
      a.auto_recall_allowed,
      a.mention_policy,
      a.direct_query_policy,
      a.expires_at,
      a.resource_revision,
      a.created_at AS assertion_created_at,
      a.updated_at AS assertion_updated_at,
      v.content,
      v.structured_data,
      v.content_type,
      v.trust_level,
      v.observed_at,
      v.valid_from,
      v.valid_to,
      v.supersedes_version_id,
      v.version_status,
      v.created_by,
      v.promotion_reason,
      v.promotion_policy_version,
      v.created_at AS version_created_at,
      ${scoreExpression} AS candidate_score
    FROM index_documents d
    JOIN memory_assertions a ON a.tenant_id = d.tenant_id AND a.user_id = d.user_id AND a.id = d.source_id
    JOIN assertion_versions v ON v.tenant_id = d.tenant_id AND v.assertion_id = a.id AND v.id = d.source_version
    LEFT JOIN redaction_epochs redaction ON redaction.tenant_id = d.tenant_id AND redaction.user_id = d.user_id
    WHERE ${conditions.join('\n      AND ')}
    ORDER BY ${orderBy}
    LIMIT ${limitParam}
  `;
  return { sql, params, mode, limit: boundedLimit(limit) };
}

export function mapPostgresIndexCandidate(row) {
  return {
    id: row.memory_id,
    documentId: row.document_id,
    memoryId: row.memory_id,
    versionId: row.version_id,
    score: Number(row.candidate_score || 0),
    sourceRefs: row.source_refs || [],
    assertion: {
      id: row.memory_id,
      tenantId: row.tenant_id,
      userId: row.user_id,
      scopeType: row.scope_type,
      relationshipAgentId: row.relationship_agent_id,
      sessionId: row.session_id,
      memoryType: row.memory_type,
      assertionType: row.assertion_type,
      canonicalKey: row.canonical_key,
      status: row.assertion_status,
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
      currentVersionId: row.version_id,
      resourceRevision: Number(row.resource_revision),
      createdAt: row.assertion_created_at,
      updatedAt: row.assertion_updated_at
    },
    version: {
      id: row.version_id,
      assertionId: row.memory_id,
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
      createdAt: row.version_created_at
    }
  };
}
