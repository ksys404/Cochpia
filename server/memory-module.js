import { randomUUID } from 'node:crypto';
import { bm25Search, detectConflicts, hybridSearch, vectorSearch } from './memory-module-retrieval.js';
import { routeMemoryQuery } from './memory-module-query-router.js';
import { PaginationCursorError, assertCursorBinding, decodeOpaqueCursor, pageNewestFirst } from './memory-module-pagination.js';
import { numericSourceRevision } from './memory-module-event-order.js';

export const MEMORY_SCOPES = Object.freeze(['user', 'relationship', 'session']);
export const MEMORY_STATUSES = Object.freeze([
  'candidate',
  'pending_confirmation',
  'active',
  'rejected',
  'superseded',
  'expired',
  'revoked',
  'forgotten'
]);
export const SENSITIVITY_LEVELS = Object.freeze(['S0', 'S1', 'S2', 'S3']);

const sensitivityRank = { S0: 0, S1: 1, S2: 2, S3: 3 };
const allowedRoles = new Set(['user', 'agent', 'system', 'tool', 'imported']);
const allowedContentTypes = new Set(['plain_text', 'structured', 'tool_output', 'imported']);
const allowedAssertionContentTypes = new Set([...allowedContentTypes, 'quoted_content']);
const allowedPurposes = new Set(['answer_user_query', 'proactive_mention', 'profile_view', 'governance']);
const allowedDirectQueryPolicies = new Set(['allow', 'require_confirmation', 'deny']);
const allowedMentionPolicies = new Set(['mentionable', 'contextualizable_only', 'do_not_mention']);
const allowedStorageDirectives = new Set(['default', 'do_not_store']);
const allowedVersionStatuses = new Set(['proposed', 'current', 'superseded', 'invalidated']);

export class MemoryModuleError extends Error {
  constructor(code, message, { status = 400, retryable = false, currentResourceRevision = null } = {}) {
    super(message);
    this.name = 'MemoryModuleError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.currentResourceRevision = currentResourceRevision;
  }
}

export function createMemoryModuleState() {
  return {
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
    accessConfirmations: [],
    mentionCooldowns: [],
    pins: [],
    scopeGrants: [],
    deletionOperations: [],
    tombstones: [],
    redactionEpochs: {},
    auditEvents: [],
    idempotencyRecords: [],
    sequence: 0,
    persistenceBaseSequence: 0,
    grantVersion: 0,
    policyVersion: 'memory-policy-v1'
  };
}

const nowIso = () => new Date().toISOString();
const clone = value => structuredClone(value);
const normalizeText = (value, max = 4000) => String(value ?? '').trim().slice(0, max);
const normalizeId = (value, field) => {
  const result = normalizeText(value, 200);
  if (!result) throw new MemoryModuleError(`INVALID_${field.toUpperCase()}`, `${field} is required`);
  return result;
};
const toFiniteNumber = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, min, max) => Math.max(min, Math.min(max, toFiniteNumber(value, min)));

function assertEnum(value, allowed, code, field) {
  if (!allowed.has(value)) throw new MemoryModuleError(code, `Invalid ${field}`);
  return value;
}

function asDate(value, field, { required = false } = {}) {
  if (value == null || value === '') {
    if (required) throw new MemoryModuleError(`INVALID_${field.toUpperCase()}`, `${field} is required`);
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new MemoryModuleError(`INVALID_${field.toUpperCase()}`, `Invalid ${field}`);
  return date.toISOString();
}

const MUTATION_IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60 * 1000;

function detectS3(content) {
  const text = String(content || '');
  return /(?:sk|rk)-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b\d{13,19}\b|\b\d{3}-\d{2}-\d{4}\b/i.test(text);
}

function containsS3Content(value) {
  if (typeof value === 'string') return detectS3(value);
  if (Array.isArray(value)) return value.some(containsS3Content);
  if (value && typeof value === 'object') return Object.values(value).some(containsS3Content);
  return false;
}

function contentCarrierHasS3(input = {}) {
  return containsS3Content([
    input.content,
    input.summary,
    input.value,
    input.structuredData,
    input.structured_data,
    input.proposedContent,
    input.proposed_content
  ]);
}

function canonicalizeFingerprint(value) {
  if (Array.isArray(value)) return value.map(canonicalizeFingerprint);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !['idempotency_key', 'idempotencyKey', 'tenant_id', 'tenantId', 'user_id', 'userId'].includes(key))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalizeFingerprint(item)]));
  }
  return value;
}

function fingerprintForMutation(input, context, resourceId = null) {
  return JSON.stringify(canonicalizeFingerprint({
    actor: { actorType: context.actorType, actorId: context.actorId, callerAgentId: context.callerAgentId },
    resourceId: resourceId || null,
    request: input || {}
  }));
}

function detectS2(content) {
  return /健康|创伤|病史|诊断|医疗|药物|性取向|性生活|银行卡|财务|收入|债务|身份证|家庭冲突|trauma|diagnos|medical|medication|sexual|bank account|finance|income|debt|identity document/i.test(String(content || ''));
}

function sanitizeMetadata(metadata) {
  if (metadata == null) return {};
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new MemoryModuleError('INVALID_METADATA', 'metadata must be an object');
  const allowed = new Set(['language', 'channel', 'source_label', 'client_revision', 'turn_id', 'sequence_no']);
  if (Object.keys(metadata).some(key => !allowed.has(key))) throw new MemoryModuleError('INVALID_METADATA', 'metadata contains unsupported fields');
  return Object.fromEntries(Object.entries(metadata).map(([key, value]) => [key, normalizeText(value, 200)]));
}

function maxSensitivity(a, b) {
  return sensitivityRank[a] >= sensitivityRank[b] ? a : b;
}

function classifySensitivity(input) {
  const requested = SENSITIVITY_LEVELS.includes(input.sensitivity) ? input.sensitivity : 'S0';
  if (detectS3(input.content)) return 'S3';
  if (detectS2(input.content)) return maxSensitivity(requested, 'S2');
  return requested;
}

export function classifyMemorySensitivity(input) {
  return classifySensitivity(input);
}

export function isSecretMemoryContent(content) {
  return detectS3(content);
}

function contextOf(context = {}) {
  const tenantId = normalizeId(context.tenantId ?? context.tenant_id, 'tenant_id');
  const subjectUserId = normalizeId(context.subjectUserId ?? context.userId ?? context.user_id, 'user_id');
  const actorType = context.actorType || context.actor_type || 'user';
  assertEnum(actorType, new Set(['user', 'agent', 'system']), 'INVALID_ACTOR_TYPE', 'actor_type');
  const actorId = normalizeId(context.actorId ?? (actorType === 'user' ? subjectUserId : context.callerAgentId ?? context.caller_agent_id), 'actor_id');
  const callerAgentId = context.callerAgentId ?? context.caller_agent_id ?? (actorType === 'agent' ? actorId : null);
  return { tenantId, subjectUserId, actorType, actorId, callerAgentId: callerAgentId ? normalizeId(callerAgentId, 'caller_agent_id') : null, sessionId: context.sessionId ?? context.session_id ?? null, requestId: context.requestId ?? context.request_id ?? null };
}

function scopeOf(input, context, { requireExpiresAt = false } = {}) {
  const scopeType = input.scopeType ?? input.scope_type ?? input.scope?.type ?? 'user';
  assertEnum(scopeType, new Set(MEMORY_SCOPES), 'INVALID_SCOPE', 'scope');
  const relationshipAgentId = input.relationshipAgentId ?? input.relationship_agent_id ?? input.scope?.agent_id ?? (scopeType === 'session' ? context.callerAgentId : null);
  const sessionId = input.sessionId ?? input.session_id ?? input.scope?.session_id ?? (scopeType === 'session' ? context.sessionId : null);
  if (scopeType === 'user' && (relationshipAgentId || sessionId)) throw new MemoryModuleError('INVALID_SCOPE', 'user scope cannot include relationship_agent_id or session_id');
  if (scopeType === 'relationship' && !relationshipAgentId) throw new MemoryModuleError('INVALID_SCOPE', 'relationship scope requires relationship_agent_id');
  if (scopeType === 'session' && !sessionId) throw new MemoryModuleError('INVALID_SCOPE', 'session scope requires session_id');
  const expiresAt = asDate(input.expiresAt ?? input.expires_at, 'expires_at', { required: scopeType === 'session' || requireExpiresAt });
  return {
    type: scopeType,
    relationshipAgentId: relationshipAgentId ? normalizeId(relationshipAgentId, 'relationship_agent_id') : null,
    sessionId: sessionId ? normalizeId(sessionId, 'session_id') : null,
    expiresAt
  };
}

function scopeKey(scope) {
  return [scope.type, scope.relationshipAgentId || '', scope.sessionId || ''].join(':');
}

function userKey(context) {
  return `${context.tenantId}:${context.subjectUserId}`;
}

function requestPayloadTenantMatches(context, input) {
  const payloadTenant = input.tenantId ?? input.tenant_id;
  const payloadUser = input.userId ?? input.user_id;
  if (payloadTenant && payloadTenant !== context.tenantId) throw new MemoryModuleError('TENANT_CONTEXT_MISMATCH', 'Tenant is bound to the authentication context', { status: 403 });
  if (payloadUser && payloadUser !== context.subjectUserId) throw new MemoryModuleError('USER_CONTEXT_MISMATCH', 'User is bound to the authentication context', { status: 403 });
}

function visibleByTime(item, at = Date.now()) {
  if (item.expiresAt && new Date(item.expiresAt).getTime() <= at) return false;
  if (item.validFrom && new Date(item.validFrom).getTime() > at) return false;
  if (item.validTo && new Date(item.validTo).getTime() <= at) return false;
  return true;
}

function purposePermission(purpose) {
  if (purpose === 'governance') return 'govern';
  if (purpose === 'proactive_mention') return 'mention';
  if (purpose === 'answer_user_query') return 'contextualize';
  return 'retrieve';
}

function defaultPolicies(sensitivity) {
  if (sensitivity === 'S2') return { mentionPolicy: 'do_not_mention', directQueryPolicy: 'require_confirmation', autoRecallAllowed: false };
  return { mentionPolicy: 'mentionable', directQueryPolicy: 'allow', autoRecallAllowed: true };
}

function tokenFor(state, context) {
  return {
    token: randomUUID(),
    sourceCommitSeq: state.sequence,
    privacyEpoch: state.redactionEpochs[userKey(context)] || 0,
    grantVersion: state.grantVersion
  };
}

function audit(state, context, action, details = {}) {
  const auditDetails = { ...details, requestId: context.requestId || null };
  state.auditEvents.unshift({
    id: randomUUID(),
    tenantId: context.tenantId,
    subjectUserId: context.subjectUserId,
    actorId: context.actorId,
    action,
    details: auditDetails,
    ...auditDetails,
    createdAt: nowIso()
  });
}

function findAssertion(state, id, context) {
  return state.assertions.find(item => item.id === id && item.tenantId === context.tenantId && item.userId === context.subjectUserId) || null;
}

function findVersion(state, id) {
  return state.assertionVersions.find(item => item.id === id) || null;
}

function currentVersion(state, assertion) {
  return assertion ? findVersion(state, assertion.currentVersionId) : null;
}

function hasGrant(state, context, assertion, permission) {
  if (context.actorType === 'user' && context.actorId === context.subjectUserId) return true;
  if (context.actorType !== 'agent' || !context.callerAgentId) return false;
  if (assertion.scopeType === 'relationship') return assertion.relationshipAgentId === context.callerAgentId;
  if (assertion.scopeType === 'session') return assertion.relationshipAgentId === context.callerAgentId && assertion.sessionId === context.sessionId;
  return state.scopeGrants.some(grant => grant.tenantId === context.tenantId
    && grant.subjectUserId === context.subjectUserId
    && grant.granteeType === 'agent'
    && grant.granteeId === context.callerAgentId
    && grant.scopeType === 'user'
    && grant.permissions.includes(permission)
    && !grant.revokedAt
    && (!grant.expiresAt || new Date(grant.expiresAt).getTime() > Date.now()));
}

function canSee(state, context, assertion, purpose, { allowGovernance = false } = {}) {
  if (!assertion || assertion.tenantId !== context.tenantId || assertion.userId !== context.subjectUserId) return false;
  if (!MEMORY_STATUSES.includes(assertion.status)) return false;
  if (!['active'].includes(assertion.status) && !(allowGovernance && purpose === 'governance')) return false;
  if (!visibleByTime(assertion)) return false;
  if (assertion.scopeType === 'session') {
    const session = state.sessions.find(item => item.tenantId === context.tenantId && item.userId === context.subjectUserId && item.id === assertion.sessionId);
    if (!session || session.status !== 'active' || (session.expiresAt && new Date(session.expiresAt).getTime() <= Date.now()) || context.sessionId !== assertion.sessionId) return false;
  }
  if (purpose === 'proactive_mention' && assertion.mentionPolicy !== 'mentionable') return false;
  if (assertion.scopeType === 'relationship' && assertion.relationshipAgentId !== context.callerAgentId && context.actorType === 'agent') return false;
  if (assertion.scopeType === 'session' && (assertion.sessionId !== context.sessionId || assertion.relationshipAgentId !== context.callerAgentId) && context.actorType === 'agent') return false;
  return hasGrant(state, context, assertion, purposePermission(purpose));
}

function serializeAssertion(state, assertion, { includeGovernance = false, pinVersion = false, versionIdOverride = null, versionOverride = null, sourceRefsOverride = null } = {}) {
  const pinned = state.pins.find(item => item.assertionId === assertion.id && !item.revokedAt);
  const current = currentVersion(state, assertion);
  const version = pinVersion && pinned && !pinned.followCurrent
    ? findVersion(state, pinned.pinnedVersionId)
    : versionIdOverride
      ? findVersion(state, versionIdOverride)
      : versionOverride || current;
  const contentVisible = assertion.status === 'active';
  return {
    memoryId: assertion.id,
    versionId: version?.id || null,
    content: contentVisible ? version?.content || null : null,
    structuredData: contentVisible ? version?.structuredData || {} : {},
    scope: {
      type: assertion.scopeType,
      agentId: assertion.relationshipAgentId || null,
      sessionId: assertion.sessionId || null
    },
    memoryType: assertion.memoryType,
    assertionType: assertion.assertionType,
    status: includeGovernance ? assertion.status : undefined,
    sensitivity: assertion.sensitivity,
    trustLevel: version?.trustLevel || null,
    sourceRefs: contentVisible ? sourceRefsOverride || state.assertionVersionSources.filter(item => item.versionId === version?.id).map(item => item.sourceId) : [],
    validFrom: version?.validFrom || null,
    validTo: version?.validTo || null,
    confidence: assertion.confidence,
    importance: assertion.importance,
    mentionPolicy: assertion.mentionPolicy,
    directQueryPolicy: assertion.directQueryPolicy,
    autoRecallAllowed: assertion.autoRecallAllowed,
    resourceRevision: assertion.resourceRevision,
    pinned: Boolean(pinned),
    pinnedVersionId: pinned?.pinnedVersionId || null,
    createdAt: assertion.createdAt,
    updatedAt: assertion.updatedAt
  };
}

function serializeCurrentState(state, currentState) {
  return {
    memoryId: currentState.id,
    versionId: null,
    content: currentState.value,
    structuredData: { stateType: currentState.stateType },
    scope: { type: 'session', agentId: currentState.agentId, sessionId: currentState.sessionId },
    memoryType: 'current_state',
    assertionType: 'observed_fact',
    status: currentState.status,
    sensitivity: 'S1',
    trustLevel: 'user_observed',
    sourceRefs: state.currentStateSources.filter(item => item.currentStateId === currentState.id).map(item => item.rawEventId),
    validFrom: currentState.createdAt,
    validTo: currentState.expiresAt,
    confidence: currentState.confidence,
    importance: 0.5,
    mentionPolicy: 'contextualizable_only',
    directQueryPolicy: 'allow',
    autoRecallAllowed: false,
    resourceRevision: currentState.resourceRevision,
    pinned: false,
    pinnedVersionId: null,
    createdAt: currentState.createdAt,
    updatedAt: currentState.updatedAt
  };
}

function assertRevision(resource, input) {
  const requested = input.resourceRevision ?? input.resource_revision;
  if (requested == null) throw new MemoryModuleError('RESOURCE_REVISION_REQUIRED', 'resource_revision is required');
  if (Number(requested) !== Number(resource.resourceRevision)) throw new MemoryModuleError('RESOURCE_REVISION_CONFLICT', 'Resource revision is stale', { status: 409, currentResourceRevision: resource.resourceRevision });
}

function assertUserGovernanceActor(context) {
  if (context.actorType !== 'user' || context.actorId !== context.subjectUserId) throw new MemoryModuleError('GOVERNANCE_FORBIDDEN', 'Only the subject user can perform this governance mutation', { status: 403 });
}

function findSession(state, id, context) {
  return state.sessions.find(session => session.id === id && session.tenantId === context.tenantId && session.userId === context.subjectUserId) || null;
}

export function removeAccountDataForSubject(state, { tenantId, userId }, { preserveDeletionLedger = false } = {}) {
  if (!state || !tenantId || !userId) throw new TypeError('state, tenantId, and userId are required');
  const belongs = item => item?.tenantId === tenantId && (item.userId === userId || item.subjectUserId === userId);
  const rawEventIds = new Set((state.rawEvents || []).filter(belongs).map(item => item.id));
  const sessionIds = new Set((state.sessions || []).filter(belongs).map(item => item.id));
  const assertionIds = new Set((state.assertions || []).filter(belongs).map(item => item.id));
  const versionIds = new Set((state.assertionVersions || []).filter(item => assertionIds.has(item.assertionId)).map(item => item.id));
  const snapshotIds = new Set((state.profileSnapshots || []).filter(belongs).map(item => item.id));
  const projectionIds = new Set((state.profileProjections || []).filter(belongs).map(item => item.id));
  const currentStateIds = new Set((state.currentStates || []).filter(belongs).map(item => item.id));
  const episodeIds = new Set((state.episodes || []).filter(belongs).map(item => item.id));
  const memoryIds = assertionIds;

  state.rawEvents = (state.rawEvents || []).filter(item => !rawEventIds.has(item.id) && !belongs(item));
  state.sessions = (state.sessions || []).filter(item => !sessionIds.has(item.id) && !belongs(item));
  state.profileSnapshots = (state.profileSnapshots || []).filter(item => !snapshotIds.has(item.id) && !belongs(item));
  state.profileSnapshotItems = (state.profileSnapshotItems || []).filter(item => !belongs(item) && !snapshotIds.has(item.snapshotId) && !memoryIds.has(item.assertionId) && !versionIds.has(item.versionId));
  state.profileProjections = (state.profileProjections || []).filter(item => !projectionIds.has(item.id) && !belongs(item));
  state.profileProjectionItems = (state.profileProjectionItems || []).filter(item => !belongs(item) && !projectionIds.has(item.projectionId) && !memoryIds.has(item.assertionId) && !versionIds.has(item.versionId));
  state.profileProjectionSources = (state.profileProjectionSources || []).filter(item => !belongs(item) && !projectionIds.has(item.projectionId) && !memoryIds.has(item.assertionId) && !versionIds.has(item.versionId));
  state.assertions = (state.assertions || []).filter(item => !assertionIds.has(item.id) && !belongs(item));
  state.assertionVersions = (state.assertionVersions || []).filter(item => !versionIds.has(item.id));
  state.assertionVersionSources = (state.assertionVersionSources || []).filter(item => !versionIds.has(item.versionId) && !(item.sourceType === 'raw_event' && rawEventIds.has(item.sourceId)));
  state.currentStates = (state.currentStates || []).filter(item => !currentStateIds.has(item.id) && !belongs(item));
  state.currentStateSources = (state.currentStateSources || []).filter(item => !belongs(item) && !currentStateIds.has(item.currentStateId) && !rawEventIds.has(item.rawEventId));
  state.confirmations = (state.confirmations || []).filter(item => !belongs(item) && !memoryIds.has(item.candidateAssertionId) && !versionIds.has(item.candidateVersionId));
  state.accessConfirmations = (state.accessConfirmations || []).filter(item => !belongs(item) && !item.memoryIds?.some(id => memoryIds.has(id)));
  state.mentionCooldowns = (state.mentionCooldowns || []).filter(item => !belongs(item) && !memoryIds.has(item.memoryId));
  state.pins = (state.pins || []).filter(item => !belongs(item) && !memoryIds.has(item.assertionId) && !versionIds.has(item.pinnedVersionId));
  state.indexDocuments = (state.indexDocuments || []).filter(item => !belongs(item) && !memoryIds.has(item.sourceId) && !versionIds.has(item.sourceVersion));
  state.episodes = (state.episodes || []).filter(item => !episodeIds.has(item.id) && !belongs(item));
  state.episodeMembers = (state.episodeMembers || []).filter(item => !belongs(item) && !episodeIds.has(item.episodeId) && !rawEventIds.has(item.rawEventId) && !versionIds.has(item.assertionVersionId));
  state.scopeGrants = (state.scopeGrants || []).filter(item => !belongs(item));
  state.outboxEvents = (state.outboxEvents || []).filter(item => !belongs(item) && !rawEventIds.has(item.aggregateId) && !memoryIds.has(item.aggregateId) && !versionIds.has(item.aggregateId) && !currentStateIds.has(item.aggregateId) && !sessionIds.has(item.aggregateId));
  state.idempotencyRecords = (state.idempotencyRecords || []).filter(item => !belongs(item));
  state.auditEvents = (state.auditEvents || []).filter(item => !belongs(item));
  if (!preserveDeletionLedger) {
    state.deletionOperations = (state.deletionOperations || []).filter(item => !belongs(item));
    state.tombstones = (state.tombstones || []).filter(item => !belongs(item));
  }
}

function assertSessionAccess(state, context, sessionId) {
  const session = findSession(state, sessionId, context);
  if (!session) throw new MemoryModuleError('SESSION_NOT_FOUND', 'Session not found', { status: 404 });
  if (context.actorType === 'agent' && (session.callerAgentId !== context.callerAgentId || session.status !== 'active')) throw new MemoryModuleError('SESSION_FORBIDDEN', 'Session is not available', { status: 403 });
  if (session.expiresAt && new Date(session.expiresAt).getTime() <= Date.now()) {
    session.status = 'expired';
    throw new MemoryModuleError('SESSION_EXPIRED', 'Session has expired', { status: 410 });
  }
  return session;
}

function addVersion(state, assertion, input, context, source) {
  const version = {
    id: randomUUID(),
    assertionId: assertion.id,
    content: normalizeText(input.content ?? input.summary, 4000),
    structuredData: input.structuredData ?? input.structured_data ?? {},
    contentType: input.contentType ?? input.content_type ?? 'plain_text',
    trustLevel: input.trustLevel ?? input.trust_level ?? (context.actorType === 'user' ? 'user_explicit' : 'agent_inferred'),
    confidence: clamp(input.confidence, 0, 1),
    observedAt: asDate(input.observedAt ?? input.observed_at, 'observed_at') || nowIso(),
    validFrom: asDate(input.validFrom ?? input.valid_from, 'valid_from'),
    validTo: asDate(input.validTo ?? input.valid_to, 'valid_to'),
    supersedesVersionId: assertion.currentVersionId || null,
    versionStatus: input.versionStatus ?? input.version_status ?? 'current',
    createdBy: input.createdBy ?? input.created_by ?? context.actorType,
    promotionReason: input.promotionReason ?? input.promotion_reason ?? 'explicit_memory_api',
    promotionPolicyVersion: state.policyVersion,
    createdAt: nowIso()
  };
  assertEnum(version.contentType, allowedAssertionContentTypes, 'INVALID_CONTENT_TYPE', 'content_type');
  assertEnum(version.versionStatus, allowedVersionStatuses, 'INVALID_VERSION_STATUS', 'version_status');
  if (!version.content) throw new MemoryModuleError('INVALID_MEMORY_CONTENT', 'content is required');
  state.assertionVersions.push(version);
  if (source) state.assertionVersionSources.push({ versionId: version.id, ...source });
  return version;
}

function makeAssertion(state, context, input, scope, sensitivity, status) {
  const policies = defaultPolicies(sensitivity);
  const mentionPolicy = input.mentionPolicy ?? input.mention_policy ?? policies.mentionPolicy;
  const directQueryPolicy = input.directQueryPolicy ?? input.direct_query_policy ?? policies.directQueryPolicy;
  assertEnum(mentionPolicy, allowedMentionPolicies, 'INVALID_MENTION_POLICY', 'mention_policy');
  assertEnum(directQueryPolicy, allowedDirectQueryPolicies, 'INVALID_DIRECT_QUERY_POLICY', 'direct_query_policy');
  const assertion = {
    id: randomUUID(),
    tenantId: context.tenantId,
    userId: context.subjectUserId,
    scopeType: scope.type,
    relationshipAgentId: scope.relationshipAgentId,
    sessionId: scope.sessionId,
    memoryType: normalizeText(input.memoryType ?? input.memory_type ?? input.type ?? 'fact', 80),
    assertionType: input.assertionType ?? input.assertion_type ?? 'observed_fact',
    canonicalKey: normalizeText(input.canonicalKey ?? input.canonical_key ?? `${scopeKey(scope)}:${normalizeText(input.key ?? input.memoryType ?? input.type ?? 'fact', 120)}`, 300),
    status,
    subjectType: input.subjectType ?? input.subject_type ?? 'user',
    subjectId: input.subjectId ?? input.subject_id ?? context.subjectUserId,
    sensitivity,
    confidence: clamp(input.confidence, 0, 1),
    importance: clamp(input.importance, 0, 1),
    retentionPolicy: input.retentionPolicy ?? input.retention_policy ?? `default_${sensitivity}`,
    recallPolicy: input.recallPolicy ?? input.recall_policy ?? 'default',
    autoRecallAllowed: input.autoRecallAllowed ?? input.auto_recall_allowed ?? policies.autoRecallAllowed,
    mentionPolicy,
    directQueryPolicy,
    expiresAt: scope.expiresAt,
    currentVersionId: null,
    resourceRevision: 1,
    createdAt: nowIso(),
    updatedAt: nowIso()
  };
  state.assertions.push(assertion);
  return assertion;
}

export function createMemoryModule(state = createMemoryModuleState(), persistNow = async () => {}, options = {}) {
  state.rawEvents ||= [];
  state.outboxEvents ||= [];
  state.sessions ||= [];
  state.profileSnapshots ||= [];
  state.profileSnapshotItems ||= [];
  state.profileProjections ||= [];
  state.profileProjectionItems ||= [];
  state.indexDocuments ||= [];
  state.episodes ||= [];
  state.episodeMembers ||= [];
  state.assertions ||= [];
  state.assertionVersions ||= [];
  state.assertionVersionSources ||= [];
  state.currentStates ||= [];
  state.currentStateSources ||= [];
  state.profileProjectionSources ||= [];
  state.confirmations ||= [];
  state.accessConfirmations ||= [];
  state.mentionCooldowns ||= [];
  state.pins ||= [];
  state.scopeGrants ||= [];
  state.deletionOperations ||= [];
  state.tombstones ||= [];
  state.redactionEpochs ||= {};
  state.auditEvents ||= [];
  state.idempotencyRecords ||= [];
  state.sequence ||= 0;
  state.persistenceBaseSequence ??= state.sequence;
  state.grantVersion ||= 0;
  state.policyVersion ||= 'memory-policy-v1';
  const featureFlags = options.featureFlags || state.featureFlags || {};
  const proactiveMentionEnabled = Object.hasOwn(featureFlags, 'proactiveMention')
    ? featureFlags.proactiveMention === true
    : options.proactiveMentionEnabled !== false;
  const mentionCooldownMs = Math.max(0, Math.min(
    30 * 24 * 60 * 60 * 1000,
    Number(options.mentionCooldownMs ?? 6 * 60 * 60 * 1000) || 0
  ));
  const embeddingGateway = options.embeddingGateway || null;
  const nativeRetriever = typeof options.nativeRetriever === 'function' ? options.nativeRetriever : null;
  const embeddingTimeoutMs = Number(options.embeddingTimeoutMs || 150);
  const retrievedOverride = Symbol('retrieved_override');
  const mutationLocks = new Map();
  let persistenceSuppressed = 0;

  const persist = async () => {
    if (persistenceSuppressed > 0) return;
    await persistNow();
  };

  const withSubjectMutationLock = async (context, callback) => {
    const lockKey = userKey(context);
    const previous = mutationLocks.get(lockKey) || Promise.resolve();
    let release;
    const current = new Promise(resolve => { release = resolve; });
    mutationLocks.set(lockKey, current);
    await previous;
    try {
      return await callback();
    } finally {
      release();
      if (mutationLocks.get(lockKey) === current) mutationLocks.delete(lockKey);
    }
  };

  const bumpSequence = () => { state.sequence += 1; return state.sequence; };
  const bumpEpoch = context => {
    const key = userKey(context);
    state.redactionEpochs[key] = Number(state.redactionEpochs[key] || 0) + 1;
    return state.redactionEpochs[key];
  };

  const mutationNamespaceOf = record => record.mutationNamespace || record.namespace || 'event';

  const mutationKeyOf = input => {
    const supplied = input?.idempotencyKey ?? input?.idempotency_key;
    if (supplied == null || supplied === '') return null;
    const key = String(supplied).trim();
    if (!key || key.length > 200) throw new MemoryModuleError('INVALID_IDEMPOTENCY_KEY', 'idempotency_key must be 1-200 characters');
    return key;
  };

  const mutationResponseContainsContent = value => {
    if (Array.isArray(value)) return value.some(mutationResponseContainsContent);
    if (!value || typeof value !== 'object') return false;
    return Object.entries(value).some(([key, item]) => {
      if (['content', 'proposedContent', 'value'].includes(key) && typeof item === 'string' && item.length > 0) return true;
      if (key === 'structuredData' && item && typeof item === 'object' && Object.keys(item).length > 0) return true;
      return mutationResponseContainsContent(item);
    });
  };

  const mutationResourceExists = (context, record) => {
    if (!record.resourceType || !record.resourceId) return true;
    const resourceId = record.resourceId;
    if (record.resourceType === 'memory') return state.assertions.some(item => item.tenantId === context.tenantId && item.userId === context.subjectUserId && item.id === resourceId && item.status !== 'forgotten');
    if (record.resourceType === 'source_event') return state.rawEvents.some(item => item.tenantId === context.tenantId && item.userId === context.subjectUserId && item.id === resourceId);
    if (record.resourceType === 'session') return state.sessions.some(item => item.tenantId === context.tenantId && item.userId === context.subjectUserId && item.id === resourceId);
    if (record.resourceType === 'current_state') return state.currentStates.some(item => item.tenantId === context.tenantId && item.userId === context.subjectUserId && item.id === resourceId && item.status !== 'forgotten');
    if (record.resourceType === 'confirmation') return state.confirmations.some(item => item.tenantId === context.tenantId && item.userId === context.subjectUserId && item.id === resourceId && item.status !== 'expired');
    if (record.resourceType === 'access_confirmation') return state.accessConfirmations.some(item => item.tenantId === context.tenantId && item.userId === context.subjectUserId && item.id === resourceId);
    if (record.resourceType === 'grant') return state.scopeGrants.some(item => item.tenantId === context.tenantId && item.subjectUserId === context.subjectUserId && item.grantId === resourceId);
    if (record.resourceType === 'relationship') return state.assertions.some(item => item.tenantId === context.tenantId && item.userId === context.subjectUserId && item.scopeType === 'relationship' && item.relationshipAgentId === resourceId && item.status !== 'forgotten');
    return true;
  };

  const invalidateMutationRecords = ({ resourceType, resourceIds = [] } = {}) => {
    const ids = new Set(resourceIds.filter(Boolean));
    if (!ids.size || !resourceType) return;
    state.idempotencyRecords = state.idempotencyRecords.filter(record => mutationNamespaceOf(record) === 'event'
      || record.resourceType !== resourceType
      || !ids.has(record.resourceId));
  };

  const inferMutationResource = (namespace, result, resourceType, resourceId) => {
    if (resourceType && resourceId) return { resourceType, resourceId };
    const candidates = [
      ['memory', result?.memory?.memoryId],
      ['session', result?.session?.id || (namespace === 'session.create' ? result?.id : null)],
      ['grant', result?.grantId],
      ['confirmation', result?.confirmation?.id],
      ['current_state', result?.currentState?.id],
      ['access_confirmation', namespace === 'access_confirmation.confirm' ? resourceId : null],
      ['deletion_operation', result?.deletionOperationId]
    ];
    const match = candidates.find(([, id]) => id);
    return match ? { resourceType: match[0], resourceId: match[1] } : { resourceType: resourceType || null, resourceId: resourceId || null };
  };

  const executeMutation = async (rawContext, { namespace, input = {}, resourceType = null, resourceId = null, invoke } = {}) => {
    if (!namespace || typeof invoke !== 'function') throw new TypeError('Mutation namespace and invoke callback are required');
    const context = contextOf(rawContext);
    const key = mutationKeyOf(input);
    if (!key) return invoke();

    return withSubjectMutationLock(context, async () => {
      const now = Date.now();
      state.idempotencyRecords = state.idempotencyRecords.filter(record => mutationNamespaceOf(record) === 'event'
        || !record.expiresAt
        || new Date(record.expiresAt).getTime() > now);
      const requestFingerprint = fingerprintForMutation(input, context, resourceId);
      const existing = state.idempotencyRecords.find(record => record.tenantId === context.tenantId
        && record.userId === context.subjectUserId
        && mutationNamespaceOf(record) === namespace
        && record.key === key);
      if (existing) {
        if (existing.requestFingerprint !== requestFingerprint) throw new MemoryModuleError('IDEMPOTENCY_CONFLICT', 'The same idempotency key was already used with a different payload', { status: 409 });
        if (existing.responseContainsContent && !mutationResourceExists(context, existing)) {
          state.idempotencyRecords = state.idempotencyRecords.filter(record => record !== existing);
        } else {
          return clone(existing.response);
        }
      }

      const beforeState = clone(state);
      const sequenceBefore = state.sequence;
      const unsafeInput = input.storageDirective === 'do_not_store'
        || input.storage_directive === 'do_not_store'
        || containsS3Content(input);
      let result;
      try {
        persistenceSuppressed += 1;
        try {
          result = await invoke();
        } finally {
          persistenceSuppressed -= 1;
        }
      } catch (error) {
        if (state.sequence !== sequenceBefore) await persistNow();
        throw error;
      }

      if (unsafeInput) {
        await persistNow();
        return result;
      }

      const resolvedResource = inferMutationResource(namespace, result, resourceType, resourceId);
      const responseContainsContent = mutationResponseContainsContent(result);
      const record = {
        id: randomUUID(),
        tenantId: context.tenantId,
        userId: context.subjectUserId,
        mutationNamespace: namespace,
        key,
        requestFingerprint,
        response: null,
        result: 'succeeded',
        contentLength: null,
        contentType: 'application/json',
        resourceType: resolvedResource.resourceType,
        resourceId: resolvedResource.resourceId,
        responseContainsContent,
        expiresAt: new Date(now + MUTATION_IDEMPOTENCY_RETENTION_MS).toISOString(),
        createdAt: nowIso()
      };
      bumpSequence();
      if (result && typeof result === 'object' && result.consistencyToken) result.consistencyToken = tokenFor(state, context);
      record.response = clone(result);
      state.idempotencyRecords.push(record);
      try {
        await persistNow();
      } catch (error) {
        for (const key of Object.keys(state)) delete state[key];
        Object.assign(state, beforeState);
        throw error;
      }
      return result;
    });
  };

  const createSession = async (rawContext, input = {}) => {
    const context = contextOf(rawContext);
    requestPayloadTenantMatches(context, input);
    const callerAgentId = normalizeId(input.callerAgentId ?? input.caller_agent_id ?? context.callerAgentId ?? 'cochpia', 'caller_agent_id');
    const expiresAt = asDate(input.expiresAt ?? input.expires_at, 'expires_at') || new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const session = {
      id: randomUUID(), tenantId: context.tenantId, userId: context.subjectUserId, callerAgentId,
      status: 'active', startedAt: nowIso(), closedAt: null, expiresAt,
      profileSnapshotId: randomUUID(), grantVersion: state.grantVersion, privacyEpoch: state.redactionEpochs[userKey(context)] || 0,
      resourceRevision: 1
    };
    state.sessions.push(session);
    state.profileSnapshots.push({ id: session.profileSnapshotId, tenantId: context.tenantId, userId: context.subjectUserId, sessionId: session.id, grantVersion: session.grantVersion, privacyEpoch: session.privacyEpoch, createdAt: nowIso(), resourceRevision: 1 });
    for (const assertion of state.assertions.filter(item => item.tenantId === context.tenantId
      && item.userId === context.subjectUserId
      && item.status === 'active'
      && visibleByTime(item)
      && (item.scopeType === 'user' || (item.scopeType === 'relationship' && item.relationshipAgentId === callerAgentId)))) {
      state.profileSnapshotItems.push({ snapshotId: session.profileSnapshotId, tenantId: context.tenantId, userId: context.subjectUserId, assertionId: assertion.id, versionId: assertion.currentVersionId, scopeType: assertion.scopeType, createdAt: nowIso() });
    }
    bumpSequence();
    await persist();
    return { ...clone(session), consistencyToken: tokenFor(state, context) };
  };

  const recordEvent = async (rawContext, input = {}) => {
    const context = contextOf(rawContext);
    requestPayloadTenantMatches(context, input);
    const eventId = normalizeId(input.eventId ?? input.event_id, 'event_id');
    const sourceRevision = normalizeId(input.sourceRevision ?? input.source_revision ?? '1', 'source_revision');
    const content = normalizeText(input.content, 12000);
    const contentType = input.contentType ?? input.content_type ?? 'plain_text';
    const eventRole = input.eventRole ?? input.event_role ?? 'user';
    const storageDirective = input.storageDirective ?? input.storage_directive ?? 'default';
    const sessionId = input.sessionId ?? input.session_id ?? context.sessionId ?? null;
    const metadata = sanitizeMetadata(input.metadata);
    const isStreamFinal = input.isStreamFinal ?? input.is_stream_final ?? true;
    assertEnum(contentType, allowedContentTypes, 'INVALID_CONTENT_TYPE', 'content_type');
    assertEnum(eventRole, allowedRoles, 'INVALID_EVENT_ROLE', 'event_role');
    assertEnum(storageDirective, allowedStorageDirectives, 'INVALID_STORAGE_DIRECTIVE', 'storage_directive');
    if (typeof isStreamFinal !== 'boolean') throw new MemoryModuleError('INVALID_STREAM_FINAL', 'is_stream_final must be a boolean');
    if (!content) throw new MemoryModuleError('INVALID_EVENT_CONTENT', 'content is required');
    const duplicate = state.rawEvents.find(event => event.tenantId === context.tenantId && event.userId === context.subjectUserId && event.eventId === eventId && event.sourceRevision === sourceRevision);
    const duplicateRecord = state.idempotencyRecords.find(record => record.tenantId === context.tenantId && record.userId === context.subjectUserId && mutationNamespaceOf(record) === 'event' && record.key === `${eventId}:${sourceRevision}`);
    if (duplicate) {
      if (duplicate.content !== content || duplicate.contentType !== contentType || duplicate.eventRole !== eventRole) throw new MemoryModuleError('IDEMPOTENCY_CONFLICT', 'The same event key was already used with a different payload', { status: 409 });
      return { result: 'duplicate', eventId, sourceRevision, consistencyToken: tokenFor(state, context) };
    }
    if (duplicateRecord) {
      if (duplicateRecord.result === 'accepted_no_store') return { result: 'duplicate', eventId, sourceRevision, consistencyToken: tokenFor(state, context) };
      throw new MemoryModuleError('IDEMPOTENCY_CONFLICT', 'The same event key was already used with a different payload', { status: 409 });
    }
    const incomingRevision = numericSourceRevision(sourceRevision);
    const latestRevision = state.rawEvents
      .filter(event => event.tenantId === context.tenantId && event.userId === context.subjectUserId && event.eventId === eventId)
      .map(event => numericSourceRevision(event.sourceRevision))
      .filter(revision => revision != null)
      .reduce((latest, revision) => latest == null || revision > latest ? revision : latest, null);
    if (incomingRevision != null && latestRevision != null && incomingRevision < latestRevision) {
      return { result: 'duplicate', eventId, sourceRevision, reason: 'superseded_revision', consistencyToken: tokenFor(state, context) };
    }
    if (sessionId) assertSessionAccess(state, context, sessionId);
    const implicitNoStore = eventRole === 'system' || eventRole === 'tool';
    const blocked = storageDirective === 'do_not_store' || detectS3(content) || implicitNoStore;
    const noStoreReason = detectS3(content) ? 's3_policy' : storageDirective === 'do_not_store' ? 'caller_directive' : implicitNoStore ? 'untrusted_event_role_default' : null;
    audit(state, context, blocked ? 'event_accepted_no_store' : 'event_received', { eventId, sourceRevision, noStoreReason });
    if (blocked) {
      state.idempotencyRecords.push({ id: randomUUID(), tenantId: context.tenantId, userId: context.subjectUserId, mutationNamespace: 'event', key: `${eventId}:${sourceRevision}`, result: 'accepted_no_store', contentLength: content.length, contentType, createdAt: nowIso() });
      bumpSequence();
      await persist();
      return { result: 'accepted_no_store', eventId, sourceRevision, consistencyToken: tokenFor(state, context) };
    }
    const occurredAt = asDate(input.occurredAt ?? input.occurred_at, 'occurred_at') || nowIso();
    const rawEvent = {
      id: randomUUID(), eventId, sourceRevision, tenantId: context.tenantId, userId: context.subjectUserId,
      sessionId,
      turnId: normalizeText(input.turnId ?? input.turn_id, 200) || null,
      sequenceNo: input.sequenceNo ?? input.sequence_no ?? null,
      eventRole, contentType, content, metadata, occurredAt,
      isStreamFinal,
      retentionPolicy: input.retentionPolicy ?? input.retention_policy ?? 'default_event',
      deleteAfter: new Date(Date.now() + 35 * 24 * 60 * 60 * 1000).toISOString(),
      resourceRevision: 1,
      createdAt: nowIso(), commitSeq: bumpSequence()
    };
    state.rawEvents.push(rawEvent);
    if (isStreamFinal) state.outboxEvents.push({ id: randomUUID(), tenantId: context.tenantId, userId: context.subjectUserId, consumerName: 'memory-derived', type: 'raw_event.created', aggregateId: rawEvent.id, schemaVersion: 1, commitSeq: rawEvent.commitSeq, status: 'pending', createdAt: nowIso() });
    state.idempotencyRecords.push({ id: randomUUID(), tenantId: context.tenantId, userId: context.subjectUserId, mutationNamespace: 'event', key: `${eventId}:${sourceRevision}`, result: 'accepted_stored', contentLength: content.length, contentType, createdAt: nowIso() });
    await persist();
    return { result: 'accepted_stored', eventId, sourceRevision, rawEventId: rawEvent.id, commitSeq: rawEvent.commitSeq, consistencyToken: tokenFor(state, context) };
  };

  const grantUserScope = async (rawContext, input = {}) => {
    const context = contextOf(rawContext);
    if (context.actorType !== 'user' || context.actorId !== context.subjectUserId) throw new MemoryModuleError('GOVERNANCE_FORBIDDEN', 'Only the user can grant access', { status: 403 });
    requestPayloadTenantMatches(context, input);
    const agentId = normalizeId(input.agentId ?? input.agent_id, 'agent_id');
    const permissions = Array.isArray(input.permissions) ? [...new Set(input.permissions.map(String))] : ['retrieve', 'contextualize'];
    if (permissions.some(permission => !['retrieve', 'contextualize', 'mention', 'govern', 'view_source'].includes(permission))) throw new MemoryModuleError('INVALID_GRANT', 'Invalid grant permission');
    const grant = { grantId: randomUUID(), tenantId: context.tenantId, subjectUserId: context.subjectUserId, granteeType: 'agent', granteeId: agentId, scopeType: 'user', permissions, purpose: input.purpose || 'memory_access', issuer: context.actorId, issuedAt: nowIso(), expiresAt: asDate(input.expiresAt ?? input.expires_at, 'expires_at'), revokedAt: null, grantVersion: ++state.grantVersion, resourceRevision: 1 };
    state.scopeGrants.push(grant);
    audit(state, context, 'grant_created', { grantId: grant.grantId });
    bumpSequence();
    await persist();
    return { ...clone(grant), consistencyToken: tokenFor(state, context) };
  };

  const hold = async (rawContext, input = {}) => {
    const context = contextOf(rawContext);
    requestPayloadTenantMatches(context, input);
    const storageDirective = input.storageDirective ?? input.storage_directive ?? 'default';
    assertEnum(storageDirective, allowedStorageDirectives, 'INVALID_STORAGE_DIRECTIVE', 'storage_directive');
    if (storageDirective === 'do_not_store') {
      audit(state, context, 'memory_accepted_no_store', { noStoreReason: 'caller_directive' });
      bumpSequence();
      await persist();
      return { status: 'accepted_no_store', consistencyToken: tokenFor(state, context) };
    }
    if (contentCarrierHasS3(input)) {
      audit(state, context, 'memory_rejected_s3');
      bumpSequence();
      await persist();
      throw new MemoryModuleError('S3_CONTENT_REJECTED', 'Sensitive content cannot be stored', { status: 422 });
    }
    const content = normalizeText(input.content ?? input.summary, 4000);
    if (!content) throw new MemoryModuleError('INVALID_MEMORY_CONTENT', 'content is required');
    const sensitivity = classifySensitivity({ ...input, content });
    if (sensitivity === 'S3') {
      audit(state, context, 'memory_rejected_s3');
      bumpSequence();
      await persist();
      throw new MemoryModuleError('S3_CONTENT_REJECTED', 'Sensitive content cannot be stored', { status: 422 });
    }
    const scope = scopeOf(input, context, { requireExpiresAt: sensitivity === 'S1' });
    if (scope.type === 'session') assertSessionAccess(state, context, scope.sessionId);
    if (scope.type === 'relationship' && context.actorType === 'agent' && scope.relationshipAgentId !== context.callerAgentId) throw new MemoryModuleError('SCOPE_FORBIDDEN', 'Relationship scope is bound to the caller agent', { status: 403 });
    if (sensitivity === 'S1') {
      if (scope.type !== 'session' || !scope.expiresAt) throw new MemoryModuleError('S1_CURRENT_STATE_REQUIRED', 'S1 memory must be written as a TTL-bound session state');
      const currentState = await writeCurrentState(context, { ...input, value: content, sessionId: scope.sessionId, expiresAt: scope.expiresAt, allowPersist: false });
      return { status: 'current_state', currentState: currentState.currentState, consistencyToken: currentState.consistencyToken };
    }
    const status = sensitivity === 'S2' ? 'pending_confirmation' : 'active';
    const assertion = makeAssertion(state, context, { ...input, content }, scope, sensitivity, status);
    const sourceId = normalizeText(input.sourceEventId ?? input.source_event_id, 200) || randomUUID();
    const version = addVersion(state, assertion, { ...input, content }, context, { sourceType: input.sourceEventId || input.source_event_id ? 'raw_event' : 'explicit_request', sourceId });
    assertion.currentVersionId = version.id;
    if (status === 'pending_confirmation') {
      const confirmation = { id: randomUUID(), tenantId: context.tenantId, userId: context.subjectUserId, candidateAssertionId: assertion.id, candidateVersionId: version.id, proposedContent: content, structuredData: version.structuredData, scopeType: assertion.scopeType, relationshipAgentId: assertion.relationshipAgentId, sessionId: assertion.sessionId, sensitivity, retentionPolicy: assertion.retentionPolicy, mentionPolicy: assertion.mentionPolicy, resourceRevision: assertion.resourceRevision, createdAt: nowIso(), expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(), status: 'pending', decidedBy: null, decidedAt: null };
      state.confirmations.push(confirmation);
      audit(state, context, 'memory_pending_confirmation', { memoryId: assertion.id, confirmationId: confirmation.id });
      bumpSequence();
      await persist();
      return { status: 'pending_confirmation', memory: serializeAssertion(state, assertion, { includeGovernance: true }), confirmation: clone(confirmation), consistencyToken: tokenFor(state, context) };
    }
    bumpSequence();
    state.outboxEvents.push({ id: randomUUID(), tenantId: context.tenantId, userId: context.subjectUserId, consumerName: 'memory-derived', type: 'assertion.active', aggregateId: assertion.id, schemaVersion: 1, commitSeq: state.sequence, status: 'pending', createdAt: nowIso() });
    audit(state, context, 'memory_activated', { memoryId: assertion.id });
    await persist();
    return { status: 'active', memory: serializeAssertion(state, assertion, { includeGovernance: true }), consistencyToken: tokenFor(state, context) };
  };

  const createCandidate = async (rawContext, input = {}) => {
    const context = contextOf(rawContext);
    requestPayloadTenantMatches(context, input);
    const sourceEventId = normalizeId(input.sourceEventId ?? input.source_event_id, 'source_event_id');
    const sourceEvent = state.rawEvents.find(event => event.id === sourceEventId && event.tenantId === context.tenantId && event.userId === context.subjectUserId);
    if (!sourceEvent) throw new MemoryModuleError('SOURCE_EVENT_NOT_FOUND', 'Source event not found', { status: 404 });
    if (state.tombstones.some(tombstone => tombstone.targetType === 'source_event' && tombstone.targetId === sourceEventId)) throw new MemoryModuleError('SOURCE_EVENT_REDACTED', 'Source event is no longer available', { status: 409 });
    const existingSource = state.assertionVersionSources.find(source => source.sourceType === 'raw_event' && source.sourceId === sourceEventId);
    if (existingSource) return { status: 'duplicate', memory: null, confirmation: null, consistencyToken: tokenFor(state, context) };
    const content = normalizeText(input.content, 4000);
    if (!content) throw new MemoryModuleError('INVALID_CANDIDATE_CONTENT', 'Candidate content is required');
    if (contentCarrierHasS3(input)) throw new MemoryModuleError('S3_CONTENT_REJECTED', 'Sensitive content cannot be stored', { status: 422 });
    const sensitivity = classifySensitivity({ ...input, content });
    if (sensitivity === 'S3') throw new MemoryModuleError('S3_CONTENT_REJECTED', 'Sensitive content cannot be stored', { status: 422 });
    if (sensitivity === 'S1') return { status: 'quarantined_current_state', candidate: null, consistencyToken: tokenFor(state, context) };
    const scope = scopeOf(input, context);
    if (scope.type === 'session') assertSessionAccess(state, context, scope.sessionId);
    const status = sensitivity === 'S2' ? 'pending_confirmation' : 'candidate';
    const assertion = makeAssertion(state, context, { ...input, content, promotionReason: input.promotionReason ?? input.promotion_reason ?? 'async_extraction' }, scope, sensitivity, status);
    const version = addVersion(state, { ...assertion, currentVersionId: null }, { ...input, content, promotionReason: 'async_extraction', createdBy: 'model', trustLevel: input.trustLevel ?? 'agent_inferred' }, context, { sourceType: 'raw_event', sourceId: sourceEvent.id });
    assertion.currentVersionId = version.id;
    let confirmation = null;
    if (status === 'pending_confirmation') {
      confirmation = { id: randomUUID(), tenantId: context.tenantId, userId: context.subjectUserId, candidateAssertionId: assertion.id, candidateVersionId: version.id, proposedContent: content, structuredData: version.structuredData, scopeType: assertion.scopeType, relationshipAgentId: assertion.relationshipAgentId, sessionId: assertion.sessionId, sensitivity, retentionPolicy: assertion.retentionPolicy, mentionPolicy: assertion.mentionPolicy, resourceRevision: assertion.resourceRevision, createdAt: nowIso(), expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(), status: 'pending', decidedBy: null, decidedAt: null };
      state.confirmations.push(confirmation);
    }
    bumpSequence();
    audit(state, context, status === 'candidate' ? 'candidate_created' : 'candidate_pending_confirmation', { memoryId: assertion.id, sourceEventId: sourceEvent.id });
    await persist();
    return { status, memory: serializeAssertion(state, assertion, { includeGovernance: true }), confirmation: confirmation ? clone(confirmation) : null, consistencyToken: tokenFor(state, context) };
  };

  const promoteCandidate = async (rawContext, id, input = {}) => {
    const context = contextOf(rawContext);
    assertUserGovernanceActor(context);
    const assertion = findAssertion(state, normalizeId(id, 'memory_id'), context);
    if (!assertion || assertion.status !== 'candidate') throw new MemoryModuleError('CANDIDATE_NOT_FOUND', 'Candidate not found', { status: 404 });
    assertRevision(assertion, input);
    assertion.status = 'active';
    assertion.resourceRevision += 1;
    assertion.updatedAt = nowIso();
    bumpSequence();
    state.outboxEvents.push({ id: randomUUID(), tenantId: context.tenantId, userId: context.subjectUserId, consumerName: 'memory-derived', type: 'assertion.active', aggregateId: assertion.id, schemaVersion: 1, commitSeq: state.sequence, status: 'pending', createdAt: nowIso() });
    audit(state, context, 'candidate_promoted', { memoryId: assertion.id, policyVersion: state.policyVersion });
    await persist();
    return { status: 'active', memory: serializeAssertion(state, assertion, { includeGovernance: true }), consistencyToken: tokenFor(state, context) };
  };

  const list = (rawContext, options = {}) => {
    const context = contextOf(rawContext);
    const purpose = options.purpose || 'profile_view';
    const scopeType = options.scopeType ?? options.scope_type ?? null;
    const sensitivity = options.sensitivity ?? null;
    const status = options.status ?? null;
    assertEnum(purpose, allowedPurposes, 'INVALID_PURPOSE', 'purpose');
    let cursor = null;
    const cursorValue = options.cursor ?? options.nextCursor ?? options.next_cursor;
    if (cursorValue) {
      try {
        cursor = decodeOpaqueCursor(cursorValue);
        assertCursorBinding(cursor, { resource: 'memories', tenantId: context.tenantId, subjectUserId: context.subjectUserId, purpose, scopeType, sensitivity, status });
      } catch (error) {
        if (error instanceof PaginationCursorError || error?.code === 'INVALID_CURSOR') throw new MemoryModuleError('INVALID_CURSOR', 'Invalid pagination cursor');
        throw error;
      }
    }
    const visible = state.assertions
      .filter(assertion => canSee(state, context, assertion, purpose, { allowGovernance: purpose === 'governance' }))
      .filter(assertion => !scopeType || assertion.scopeType === scopeType)
      .filter(assertion => !sensitivity || assertion.sensitivity === sensitivity)
      .filter(assertion => !status || assertion.status === status)
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt) || String(b.id).localeCompare(String(a.id)));
    const page = pageNewestFirst(visible.map(assertion => ({ assertion, id: assertion.id, sortValue: assertion.updatedAt })), {
      cursor,
      limit: options.limit,
      cursorPayload: { resource: 'memories', tenantId: context.tenantId, subjectUserId: context.subjectUserId, purpose, scopeType, sensitivity, status }
    });
    const items = page.items.map(item => serializeAssertion(state, item.assertion, { includeGovernance: purpose === 'governance' }));
    return options.returnPage ? { items, nextCursor: page.nextCursor } : items;
  };

  const get = (rawContext, id, options = {}) => {
    const context = contextOf(rawContext);
    const assertion = findAssertion(state, normalizeId(id, 'memory_id'), context);
    const purpose = options.purpose || 'profile_view';
    if (!canSee(state, context, assertion, purpose, { allowGovernance: purpose === 'governance' })) return null;
    return serializeAssertion(state, assertion, { includeGovernance: purpose === 'governance' });
  };

  const retrieveInputs = (rawContext, input = {}) => {
    const context = contextOf(rawContext);
    const purpose = input.purpose || 'answer_user_query';
    assertEnum(purpose, allowedPurposes, 'INVALID_PURPOSE', 'purpose');
    const query = normalizeText(input.query, 1000).toLowerCase();
    if (!query) throw new MemoryModuleError('INVALID_QUERY', 'query is required');
    return { context, purpose, query, queryRoute: routeMemoryQuery(query) };
  };

  const activeSessionForContext = context => {
    if (!context.sessionId) return null;
    const session = findSession(state, context.sessionId, context);
    if (!session || session.status !== 'active' || (session.expiresAt && new Date(session.expiresAt).getTime() <= Date.now())) return null;
    if (context.actorType === 'agent' && session.callerAgentId !== context.callerAgentId) return null;
    return session;
  };

  const mentionTopicKey = input => normalizeText(input?.topicKey ?? input?.topic_key, 200).toLowerCase();

  const mentionCooldownActive = (context, assertion, topicKey = '', at = Date.now()) => {
    if (!assertion) return false;
    return state.mentionCooldowns.some(record => record.tenantId === context.tenantId
      && record.userId === context.subjectUserId
      && record.actorId === context.actorId
      && record.memoryId === assertion.id
      && (!record.topicKey || !topicKey || record.topicKey === topicKey)
      && record.cooldownUntil
      && new Date(record.cooldownUntil).getTime() > at);
  };

  const proactiveMentionDisabledResult = (context, input, reason = 'feature_disabled') => ({
    answerability: 'not_found',
    consistency: 'fresh',
    serviceMode: reason,
    queryRoute: input.queryRoute || 'unknown',
    policyResult: reason === 'feature_disabled' ? 'disabled' : 'filtered',
    retrievalMode: 'proactive_mention',
    items: [],
    blocks: [],
    uncertainties: [],
    consistencyToken: tokenFor(state, context)
  });

  const filterProactiveMentionItems = (context, input, rankedItems) => {
    if (input.purpose !== 'proactive_mention') return rankedItems;
    if (!proactiveMentionEnabled) return [];
    const topicKey = mentionTopicKey(input);
    return rankedItems.filter(item => !mentionCooldownActive(context, item.assertion, topicKey));
  };

  const retrievalDocuments = (context, purpose, queryRoute = 'unknown') => {
    if (queryRoute === 'state_current') {
      if (purpose === 'proactive_mention') return [];
      const activeSession = activeSessionForContext(context);
      if (!activeSession) return [];
      return state.currentStates
        .filter(currentState => currentState.tenantId === context.tenantId && currentState.userId === context.subjectUserId)
        .filter(currentState => currentState.status === 'active' && new Date(currentState.expiresAt).getTime() > Date.now())
        .filter(currentState => currentState.sessionId === activeSession.id)
        .filter(currentState => context.actorType !== 'agent' || currentState.agentId === context.callerAgentId)
        .map(currentState => ({ id: currentState.id, text: `${currentState.stateType} ${currentState.value}`, currentState }));
    }
    return state.assertions.filter(assertion => canSee(state, context, assertion, purpose)).map(assertion => {
      const version = currentVersion(state, assertion);
      const indexDocument = (state.indexDocuments || []).find(item => item.sourceId === assertion.id && item.sourceVersion === version?.id && item.indexStatus === 'active');
      return { id: assertion.id, text: `${version?.content || ''} ${JSON.stringify(version?.structuredData || {})}`, embedding: indexDocument?.embedding || null, assertion };
    });
  };

  const finalizeRetrieve = (context, input, rankedItems, retrievalMode) => {
    const purpose = input.purpose || 'answer_user_query';
    if (purpose === 'proactive_mention' && !proactiveMentionEnabled) return proactiveMentionDisabledResult(context, input);
    rankedItems = filterProactiveMentionItems(context, input, rankedItems);
    const accessToken = String(input.accessToken ?? input.access_token ?? '').trim();
    const activeAccess = purpose === 'answer_user_query' && accessToken
      ? state.accessConfirmations.find(item => item.token === accessToken && item.status === 'confirmed' && item.tenantId === context.tenantId && item.userId === context.subjectUserId && item.actorId === context.actorId && item.sessionId === (context.sessionId || null) && new Date(item.expiresAt).getTime() > Date.now())
      : null;
    const allowedAccessIds = new Set(activeAccess?.memoryIds || []);
    const requiresAccess = rankedItems.filter(item => item.assertion?.directQueryPolicy === 'require_confirmation' && purpose === 'answer_user_query' && !allowedAccessIds.has(item.id));
    const blocks = requiresAccess.length ? [{ type: 'access_confirmation', accessConfirmationId: randomUUID() }] : [];
    if (requiresAccess.length) {
      const block = blocks[0];
      state.accessConfirmations.push({ id: block.accessConfirmationId, tenantId: context.tenantId, userId: context.subjectUserId, actorId: context.actorId, callerAgentId: context.callerAgentId, sessionId: context.sessionId || null, purpose, memoryIds: requiresAccess.map(item => item.id), status: 'pending', token: null, createdAt: nowIso(), expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString() });
    }
    const candidates = rankedItems.filter(item => !item.assertion || (item.assertion.directQueryPolicy !== 'deny' && (item.assertion.directQueryPolicy !== 'require_confirmation' || purpose !== 'answer_user_query' || allowedAccessIds.has(item.id))));
    const conflicts = detectConflicts(candidates.filter(item => item.assertion).map(item => ({ canonicalKey: item.assertion.canonicalKey, content: item.version?.content || currentVersion(state, item.assertion)?.content, structuredData: item.version?.structuredData || currentVersion(state, item.assertion)?.structuredData })));
    const items = candidates.map(item => ({ ...(item.assertion ? serializeAssertion(state, item.assertion, { versionOverride: item.version, versionIdOverride: item.version?.id, sourceRefsOverride: item.sourceRefs }) : serializeCurrentState(state, item.currentState)), score: item.score }));
    const result = { answerability: conflicts.length ? 'conflict' : items.length ? 'known' : 'not_found', consistency: 'fresh', serviceMode: 'normal', queryRoute: input.queryRoute || 'unknown', retrievalMode, policyResult: blocks.length && !items.length ? 'filtered' : 'allowed', items, blocks, uncertainties: conflicts, consistencyToken: tokenFor(state, context) };
    if (activeAccess && items.length) {
      activeAccess.status = 'consumed';
      activeAccess.consumedAt = nowIso();
      Object.defineProperty(result, '__persist', { value: true, enumerable: false });
    }
    return result;
  };

  const retrieve = (rawContext, input = {}) => {
    const { context, purpose, query, queryRoute } = retrieveInputs(rawContext, input);
    if (purpose === 'proactive_mention' && !proactiveMentionEnabled) return proactiveMentionDisabledResult(context, { ...input, queryRoute });
    const lexical = bm25Search(retrievalDocuments(context, purpose, queryRoute), query, { limit: 50 });
    return finalizeRetrieve(context, { ...input, queryRoute }, lexical, 'bm25');
  };

  const retrieveAsync = async (rawContext, input = {}) => {
    const { context, purpose, query, queryRoute } = retrieveInputs(rawContext, input);
    if (purpose === 'proactive_mention' && !proactiveMentionEnabled) return proactiveMentionDisabledResult(context, { ...input, queryRoute });
    if (nativeRetriever) {
      try {
        const native = await nativeRetriever(context, { ...input, purpose, query, queryRoute });
        if (native && Array.isArray(native.items)) {
          const consistencyToken = input.consistency_token || input.consistencyToken;
          const hasConsistencyToken = consistencyToken
            && Number.isInteger(Number(consistencyToken.sourceCommitSeq ?? consistencyToken.source_commit_seq))
            && Number(consistencyToken.sourceCommitSeq ?? consistencyToken.source_commit_seq) > 0;
          let rankedItems = native.items;
          let retrievalMode = native.retrievalMode || 'postgres_native';
          if (hasConsistencyToken) {
            const canonicalItems = bm25Search(retrievalDocuments(context, purpose, queryRoute), query, { limit: 50 });
            if (canonicalItems.length) {
              const merged = new Map(native.items.map(item => [item.id || item.memoryId, item]));
              for (const item of canonicalItems) {
                const key = item.id || item.memoryId;
                if (key && !merged.has(key)) merged.set(key, item);
              }
              rankedItems = [...merged.values()];
              retrievalMode = `${retrievalMode}_canonical_fallback`;
            }
          }
          const result = finalizeRetrieve(context, { ...input, purpose, queryRoute }, rankedItems, retrievalMode);
          if (result.blocks.length || result.__persist) await persist();
          return result;
        }
      } catch (error) {
        if (input.requireNativeRetrieval === true) throw error;
      }
    }
    const documents = retrievalDocuments(context, purpose, queryRoute);
    const hybridEnabled = featureFlags.hybridRetrieval === true;
    const vectorEnabled = featureFlags.vectorRetrieval === true;
    let result;
    const embed = typeof embeddingGateway === 'function' ? embeddingGateway : embeddingGateway?.embed;
    if (!hybridEnabled && !vectorEnabled) result = finalizeRetrieve(context, { ...input, queryRoute }, bm25Search(documents, query, { limit: 50 }), 'bm25');
    else if (hybridEnabled) {
      const hybrid = await hybridSearch(documents, query, { embed, limit: 50, timeoutMs: embeddingTimeoutMs });
      result = finalizeRetrieve(context, { ...input, queryRoute }, hybrid.items, hybrid.mode);
    } else {
      const vector = await vectorSearch(documents, query, embed, { limit: 50, timeoutMs: embeddingTimeoutMs });
      const lexical = bm25Search(documents, query, { limit: 50 });
      result = finalizeRetrieve(context, { ...input, queryRoute }, vector.items.length ? vector.items : lexical, vector.items.length ? 'vector' : `bm25_${vector.mode}`);
    }
    if (result.blocks.length || result.__persist) await persist();
    return result;
  };

  const relevantEpisodes = (context, query = '', purpose = 'answer_user_query') => {
    const isAgent = context.actorType === 'agent';
    const canContextualize = !isAgent || state.scopeGrants.some(grant => grant.tenantId === context.tenantId
      && grant.subjectUserId === context.subjectUserId
      && grant.granteeType === 'agent'
      && grant.granteeId === context.callerAgentId
      && grant.scopeType === 'user'
      && grant.permissions.includes('contextualize')
      && !grant.revokedAt
      && (!grant.expiresAt || new Date(grant.expiresAt).getTime() > Date.now()));
    if (!canContextualize) return [];
    const activeSession = activeSessionForContext(context);
    const episodes = (state.episodes || [])
      .filter(episode => episode.tenantId === context.tenantId && episode.userId === context.subjectUserId && episode.status === 'active')
      .filter(episode => episode.scopeType !== 'relationship' || !isAgent || episode.relationshipAgentId === context.callerAgentId)
      .filter(episode => episode.scopeType !== 'session' || (activeSession && episode.sessionId === activeSession.id))
      .filter(episode => !(state.episodeMembers || []).some(member => {
        if (member.episodeId !== episode.id || !member.rawEventId) return false;
        const event = (state.rawEvents || []).find(candidate => candidate.id === member.rawEventId);
        return event
          && event.tenantId === context.tenantId
          && event.userId === context.subjectUserId
          && classifySensitivity({ content: event.content }) === 'S2';
      }));
    const sourceEventHasHiddenAssertion = eventId => (state.assertionVersionSources || []).some(source => {
      if (source.sourceType !== 'raw_event' || source.sourceId !== eventId) return false;
      const version = (state.assertionVersions || []).find(candidate => candidate.id === source.versionId);
      const assertion = version && (state.assertions || []).find(candidate => candidate.id === version.assertionId);
      return Boolean(assertion
        && assertion.tenantId === context.tenantId
        && assertion.userId === context.subjectUserId
        && assertion.status === 'active'
        && (assertion.mentionPolicy === 'do_not_mention' || assertion.directQueryPolicy !== 'allow'));
    });
    const episodesWithHiddenSources = new Set((state.episodeMembers || [])
      .filter(member => member.rawEventId && sourceEventHasHiddenAssertion(member.rawEventId))
      .map(member => member.episodeId));
    const visibleEpisodes = episodes.filter(episode => !episodesWithHiddenSources.has(episode.id));
    const documents = visibleEpisodes.map(episode => ({ id: episode.id, text: `${episode.title} ${episode.summary}`, episode }));
    const ranked = query ? bm25Search(documents, normalizeText(query, 1000), { limit: 20 }) : documents.slice().sort((left, right) => new Date(right.episode.observedEnd) - new Date(left.episode.observedEnd)).slice(0, 20);
    return ranked.map(item => {
      const members = (state.episodeMembers || []).filter(member => member.episodeId === item.episode.id);
      const memberEventIds = members
        .filter(member => {
          if (!member.rawEventId) return false;
          const event = (state.rawEvents || []).find(candidate => candidate.id === member.rawEventId);
          if (!event || event.tenantId !== context.tenantId || event.userId !== context.subjectUserId || event.isStreamFinal === false) return false;
          return !(state.tombstones || []).some(tombstone => tombstone.tenantId === event.tenantId
            && tombstone.userId === event.userId
            && (tombstone.targetType === 'account'
              || (tombstone.targetType === 'source_event' && tombstone.targetId === event.id)
              || (tombstone.targetType === 'session' && event.sessionId && tombstone.targetId === event.sessionId)));
        })
        .map(member => member.rawEventId);
      const memberVersionIds = members
        .filter(member => {
          if (!member.assertionVersionId) return false;
          const version = (state.assertionVersions || []).find(candidate => candidate.id === member.assertionVersionId);
          const assertion = version && (state.assertions || []).find(candidate => candidate.id === version.assertionId);
          return Boolean(assertion
            && assertion.tenantId === context.tenantId
            && assertion.userId === context.subjectUserId
            && assertion.status === 'active'
            && assertion.directQueryPolicy === 'allow'
            && canSee(state, context, assertion, purpose));
        })
        .map(member => member.assertionVersionId);
      if (!memberEventIds.length && !memberVersionIds.length) return null;
      return {
        episodeId: item.episode.id,
        title: item.episode.title,
        summary: item.episode.summary,
        score: item.score || 0,
        observedStart: item.episode.observedStart,
        observedEnd: item.episode.observedEnd,
        groupingRuleVersion: item.episode.groupingRuleVersion,
        memberEventIds,
        memberVersionIds,
        sourceRefs: [...memberEventIds, ...memberVersionIds]
      };
    }).filter(Boolean);
  };

  const confirmAccess = async (rawContext, id, input = {}) => {
    const context = contextOf(rawContext);
    const access = state.accessConfirmations.find(item => item.id === normalizeId(id, 'access_confirmation_id') && item.tenantId === context.tenantId && item.userId === context.subjectUserId && item.actorId === context.actorId && item.sessionId === (context.sessionId || null));
    if (!access || access.status !== 'pending' || new Date(access.expiresAt).getTime() <= Date.now()) throw new MemoryModuleError('ACCESS_CONFIRMATION_EXPIRED', 'Access confirmation is no longer pending', { status: 409 });
    access.status = 'confirmed';
    access.token = randomUUID();
    access.confirmedAt = nowIso();
    audit(state, context, 'access_confirmation_granted', { accessConfirmationId: access.id });
    bumpSequence();
    await persist();
    return { accessToken: access.token, expiresAt: access.expiresAt, purpose: access.purpose, consistencyToken: tokenFor(state, context) };
  };

  const contextBundle = (rawContext, input = {}) => {
    const context = contextOf(rawContext);
    const purpose = input.purpose || 'answer_user_query';
    const retrieved = input[retrievedOverride] || (input.query ? retrieve(context, input) : { answerability: 'not_found', consistency: 'fresh', serviceMode: 'normal', retrievalMode: 'bm25', policyResult: 'allowed', items: [], blocks: [], uncertainties: [], consistencyToken: tokenFor(state, context) });
    const episodes = relevantEpisodes(context, input.query || '', purpose);
    const activeSession = activeSessionForContext(context);
    const snapshot = activeSession?.profileSnapshotId
      ? state.profileSnapshots.find(item => item.id === activeSession.profileSnapshotId
        && item.tenantId === context.tenantId
        && item.userId === context.subjectUserId
        && item.sessionId === activeSession.id)
      : null;
    const directlyAuthorizedMemoryIds = new Set((retrieved.items || []).map(item => item.memoryId).filter(Boolean));
    const bundlePolicyAllows = item => directlyAuthorizedMemoryIds.has(item.memoryId)
      || (item.mentionPolicy !== 'do_not_mention' && item.directQueryPolicy === 'allow');
    const all = (activeSession
      ? snapshot
      ? state.profileSnapshotItems
        .filter(item => item.snapshotId === snapshot.id)
        .map(item => {
          const assertion = findAssertion(state, item.assertionId, context);
          if (!canSee(state, context, assertion, purpose, { allowGovernance: purpose === 'governance' })) return null;
          return serializeAssertion(state, assertion, { includeGovernance: purpose === 'governance', versionIdOverride: item.versionId });
        })
        .filter(Boolean)
      : []
      : list(context, { purpose, limit: 100 })).filter(bundlePolicyAllows);
    const pinned = all.filter(item => item.pinned);
    const core = pinned.map(item => serializeAssertion(state, state.assertions.find(assertion => assertion.id === item.memoryId), { pinVersion: true, versionIdOverride: item.versionId }));
    const profile = all.filter(item => item.scope.type === 'user' && !item.pinned);
    const relationships = all.filter(item => item.scope.type === 'relationship');
    const currentState = activeSession
      ? state.currentStates
        .filter(item => item.tenantId === context.tenantId && item.userId === context.subjectUserId && item.sessionId === activeSession.id)
        .filter(item => item.status === 'active' && (!item.expiresAt || new Date(item.expiresAt).getTime() > Date.now()))
        .filter(item => context.actorType !== 'agent' || item.agentId === context.callerAgentId)
        .map(clone)
      : [];
    const tokenBudget = Math.min(1800, Math.max(1, Number(input.tokenBudget ?? input.token_budget) || 1200));
    const estimate = value => Math.ceil(JSON.stringify(value).length / 4);
    const clip = (value, maxChars) => {
      const text = String(value ?? '');
      return text.length > maxChars ? `${text.slice(0, Math.max(0, maxChars - 1))}…` : text;
    };
    const bundle = { answerability: retrieved.answerability, consistency: retrieved.consistency, serviceMode: retrieved.serviceMode, queryRoute: retrieved.queryRoute || 'unknown', policyResult: retrieved.policyResult, coreMemory: core, userProfile: profile, relationshipProfile: relationships, currentState, relevantEpisodes: episodes, evidence: [...retrieved.items.map(item => ({ memoryId: item.memoryId, versionId: item.versionId, sourceRefs: item.sourceRefs })), ...episodes.map(episode => ({ episodeId: episode.episodeId, sourceRefs: episode.sourceRefs }))], uncertainties: retrieved.uncertainties || [], blocks: retrieved.blocks, snapshotId: randomUUID(), profileSnapshotId: snapshot?.id || (activeSession ? null : randomUUID()), privacyEpoch: state.redactionEpochs[userKey(context)] || 0, grantVersion: state.grantVersion, consistencyToken: retrieved.consistencyToken, sourceVersions: retrieved.items.map(item => item.versionId).filter(Boolean), indexWatermarks: { canonical: state.sequence }, tokenBudget, tokenCount: 0, truncated: false, tokenizerId: 'approx-json-v1' };
    for (const key of ['userProfile', 'relationshipProfile', 'relevantEpisodes']) {
      while (bundle[key].length && estimate(bundle) > tokenBudget) {
        bundle[key].pop();
        bundle.truncated = true;
      }
    }
    for (let maxChars = 512; estimate(bundle) > tokenBudget && maxChars >= 16; maxChars = Math.floor(maxChars / 2)) {
      bundle.coreMemory = bundle.coreMemory.map(item => ({ ...item, content: clip(item.content, maxChars), structuredData: maxChars < 64 ? {} : item.structuredData }));
      bundle.currentState = bundle.currentState.map(item => ({ ...item, value: clip(item.value, maxChars) }));
      bundle.relevantEpisodes = bundle.relevantEpisodes.map(item => ({ ...item, title: clip(item.title, maxChars), summary: clip(item.summary, maxChars) }));
      bundle.uncertainties = bundle.uncertainties.map(item => ({ ...item, values: Array.isArray(item.values) ? item.values.map(value => clip(value, maxChars)) : item.values }));
      bundle.truncated = true;
    }
    if (estimate(bundle) > tokenBudget) {
      throw new MemoryModuleError('TOKEN_BUDGET_TOO_SMALL', 'token_budget is too small to preserve governance, Core/Pin, and evidence metadata', { status: 400 });
    }
    bundle.tokenCount = estimate(bundle);
    if (bundle.tokenCount > tokenBudget) {
      throw new MemoryModuleError('TOKEN_BUDGET_TOO_SMALL', 'token_budget is too small to preserve the final Bundle envelope', { status: 400 });
    }
    return bundle;
  };

  const contextBundleAsync = async (rawContext, input = {}) => {
    const retrieved = input.query ? await retrieveAsync(rawContext, input) : null;
    const bundleInput = retrieved ? { ...input, [retrievedOverride]: retrieved } : input;
    const bundle = contextBundle(rawContext, bundleInput);
    if (bundle.blocks.length) await persist();
    return bundle;
  };

  const recordMention = async (rawContext, input = {}) => {
    const context = contextOf(rawContext);
    if (!['agent', 'system'].includes(context.actorType)) throw new MemoryModuleError('MENTION_ACTOR_REQUIRED', 'Only an Agent or system actor can record a proactive mention', { status: 403 });
    if (!proactiveMentionEnabled) return { status: 'feature_disabled', recordedMemoryIds: [], consistencyToken: tokenFor(state, context) };
    const rawMemoryIds = input.memoryIds ?? input.memory_ids ?? (input.memoryId ?? input.memory_id ? [input.memoryId ?? input.memory_id] : []);
    if (!Array.isArray(rawMemoryIds) || rawMemoryIds.length < 1 || rawMemoryIds.length > 50) throw new MemoryModuleError('INVALID_MENTION_MEMORY_IDS', 'memory_ids must contain 1-50 memory IDs');
    const memoryIds = [...new Set(rawMemoryIds.map(id => normalizeId(id, 'memory_id')))];
    const topicKey = mentionTopicKey(input);
    if (topicKey && !/^[a-z0-9:_-]+$/.test(topicKey)) throw new MemoryModuleError('INVALID_MENTION_TOPIC_KEY', 'topic_key must be a stable non-content identifier');
    const cooldownMs = Math.max(0, Math.min(30 * 24 * 60 * 60 * 1000, Number(input.cooldownMs ?? input.cooldown_ms ?? mentionCooldownMs) || 0));
    const mentionedAt = nowIso();
    const cooldownUntil = new Date(Date.now() + cooldownMs).toISOString();
    const recordedMemoryIds = [];
    for (const memoryId of memoryIds) {
      const assertion = findAssertion(state, memoryId, context);
      if (!canSee(state, context, assertion, 'proactive_mention')) continue;
      const existing = state.mentionCooldowns.find(record => record.tenantId === context.tenantId
        && record.userId === context.subjectUserId
        && record.actorId === context.actorId
        && record.memoryId === assertion.id
        && record.topicKey === topicKey);
      if (existing) {
        Object.assign(existing, { lastMentionedAt: mentionedAt, cooldownUntil, resourceRevision: Number(existing.resourceRevision || 1) + 1, updatedAt: mentionedAt });
      } else {
        state.mentionCooldowns.push({ id: randomUUID(), tenantId: context.tenantId, userId: context.subjectUserId, actorId: context.actorId, callerAgentId: context.callerAgentId, memoryId: assertion.id, topicKey, lastMentionedAt: mentionedAt, cooldownUntil, resourceRevision: 1, createdAt: mentionedAt, updatedAt: mentionedAt });
      }
      recordedMemoryIds.push(assertion.id);
    }
    if (!recordedMemoryIds.length) return { status: 'filtered', recordedMemoryIds: [], consistencyToken: tokenFor(state, context) };
    bumpSequence();
    audit(state, context, 'proactive_mention_recorded', { memoryCount: recordedMemoryIds.length, topicKey, cooldownMs });
    await persist();
    return { status: 'recorded', recordedMemoryIds, topicKey: topicKey || null, cooldownUntil, consistencyToken: tokenFor(state, context) };
  };

  const correct = async (rawContext, id, input = {}) => {
    const context = contextOf(rawContext);
    assertUserGovernanceActor(context);
    const assertion = findAssertion(state, normalizeId(id, 'memory_id'), context);
    if (!assertion || assertion.status !== 'active') throw new MemoryModuleError('MEMORY_NOT_FOUND', 'Memory not found', { status: 404 });
    assertRevision(assertion, input);
    const storageDirective = input.storageDirective ?? input.storage_directive ?? 'default';
    assertEnum(storageDirective, allowedStorageDirectives, 'INVALID_STORAGE_DIRECTIVE', 'storage_directive');
    if (storageDirective === 'do_not_store') {
      audit(state, context, 'memory_correction_accepted_no_store', { memoryId: assertion.id, noStoreReason: 'caller_directive' });
      bumpSequence();
      await persist();
      return { status: 'accepted_no_store', memoryId: assertion.id, consistencyToken: tokenFor(state, context) };
    }
    if (contentCarrierHasS3(input)) {
      audit(state, context, 'memory_correction_rejected_s3', { memoryId: assertion.id });
      bumpSequence();
      await persist();
      throw new MemoryModuleError('S3_CONTENT_REJECTED', 'Sensitive content cannot be stored', { status: 422 });
    }
    const content = normalizeText(input.content ?? input.summary, 4000);
    if (!content) throw new MemoryModuleError('INVALID_MEMORY_CONTENT', 'content is required');
    const sensitivity = classifySensitivity({ ...input, content, sensitivity: input.sensitivity || assertion.sensitivity });
    if (sensitivity === 'S3') throw new MemoryModuleError('S3_CONTENT_REJECTED', 'Sensitive content cannot be stored', { status: 422 });
    if (sensitivity === 'S1') throw new MemoryModuleError('S1_CURRENT_STATE_REQUIRED', 'S1 correction must be written as a TTL-bound session state');
    const oldVersion = currentVersion(state, assertion);
    if (sensitivity === 'S2') {
      const version = addVersion(state, assertion, { ...input, content, versionStatus: 'proposed' }, context, { sourceType: 'correction_request', sourceId: randomUUID() });
      const policies = defaultPolicies(sensitivity);
      assertion.resourceRevision += 1;
      assertion.updatedAt = nowIso();
      const confirmation = { id: randomUUID(), tenantId: context.tenantId, userId: context.subjectUserId, candidateAssertionId: assertion.id, candidateVersionId: version.id, proposedContent: content, structuredData: version.structuredData, scopeType: assertion.scopeType, relationshipAgentId: assertion.relationshipAgentId, sessionId: assertion.sessionId, sensitivity, retentionPolicy: assertion.retentionPolicy, mentionPolicy: policies.mentionPolicy, resourceRevision: assertion.resourceRevision, createdAt: nowIso(), expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(), status: 'pending', decidedBy: null, decidedAt: null };
      state.confirmations.push(confirmation);
      bumpSequence();
      audit(state, context, 'memory_correction_pending_confirmation', { memoryId: assertion.id, supersedesVersionId: oldVersion?.id || null, versionId: version.id, confirmationId: confirmation.id });
      await persist();
      return { status: 'pending_confirmation', memory: serializeAssertion(state, assertion, { includeGovernance: true }), confirmation: clone(confirmation), consistencyToken: tokenFor(state, context) };
    }
    oldVersion.versionStatus = 'superseded';
    const version = addVersion(state, assertion, { ...input, content }, context, { sourceType: 'correction_request', sourceId: randomUUID() });
    assertion.currentVersionId = version.id;
    assertion.sensitivity = sensitivity;
    assertion.resourceRevision += 1;
    assertion.updatedAt = nowIso();
    state.indexDocuments = (state.indexDocuments || []).filter(document => document.sourceId !== assertion.id);
    bumpSequence();
    state.outboxEvents.push({ id: randomUUID(), tenantId: context.tenantId, userId: context.subjectUserId, consumerName: 'memory-derived', type: 'assertion.active', aggregateId: assertion.id, schemaVersion: 1, commitSeq: state.sequence, status: 'pending', createdAt: nowIso() });
    audit(state, context, 'memory_corrected', { memoryId: assertion.id, supersedesVersionId: oldVersion.id, versionId: version.id });
    await persist();
    return { memory: serializeAssertion(state, assertion, { includeGovernance: true }), consistencyToken: tokenFor(state, context) };
  };

  const pin = async (rawContext, id, input = {}) => {
    const context = contextOf(rawContext);
    assertUserGovernanceActor(context);
    const assertion = findAssertion(state, normalizeId(id, 'memory_id'), context);
    if (!assertion || assertion.status !== 'active') throw new MemoryModuleError('MEMORY_NOT_FOUND', 'Memory not found', { status: 404 });
    assertRevision(assertion, input);
    const pinnedVersionId = input.pinnedVersionId ?? input.pinned_version_id ?? assertion.currentVersionId;
    if (!findVersion(state, pinnedVersionId) || findVersion(state, pinnedVersionId).assertionId !== assertion.id) throw new MemoryModuleError('INVALID_PIN_VERSION', 'Pinned version does not belong to memory');
    const existing = state.pins.find(item => item.assertionId === assertion.id && !item.revokedAt);
    if (existing) { existing.pinnedVersionId = pinnedVersionId; existing.followCurrent = input.followCurrent ?? input.follow_current ?? false; existing.resourceRevision += 1; }
    else state.pins.push({ id: randomUUID(), tenantId: context.tenantId, userId: context.subjectUserId, assertionId: assertion.id, pinnedVersionId, followCurrent: input.followCurrent ?? input.follow_current ?? false, scopeType: assertion.scopeType, resourceRevision: 1, createdAt: nowIso(), revokedAt: null });
    assertion.resourceRevision += 1;
    assertion.updatedAt = nowIso();
    audit(state, context, 'memory_pinned', { memoryId: assertion.id, pinnedVersionId });
    bumpSequence();
    await persist();
    return { memory: serializeAssertion(state, assertion, { includeGovernance: true }), consistencyToken: tokenFor(state, context) };
  };

  const unpin = async (rawContext, id, input = {}) => {
    const context = contextOf(rawContext);
    assertUserGovernanceActor(context);
    const assertion = findAssertion(state, normalizeId(id, 'memory_id'), context);
    if (!assertion) throw new MemoryModuleError('MEMORY_NOT_FOUND', 'Memory not found', { status: 404 });
    assertRevision(assertion, input);
    const pinRecord = state.pins.find(item => item.assertionId === assertion.id && !item.revokedAt);
    if (pinRecord) { pinRecord.revokedAt = nowIso(); pinRecord.resourceRevision += 1; }
    assertion.resourceRevision += 1;
    assertion.updatedAt = nowIso();
    state.indexDocuments = (state.indexDocuments || []).filter(document => document.sourceId !== assertion.id);
    audit(state, context, 'memory_unpinned', { memoryId: assertion.id });
    bumpSequence();
    await persist();
    return { memory: serializeAssertion(state, assertion, { includeGovernance: true }), consistencyToken: tokenFor(state, context) };
  };

  const revoke = async (rawContext, id, input = {}) => {
    const context = contextOf(rawContext);
    assertUserGovernanceActor(context);
    const assertion = findAssertion(state, normalizeId(id, 'memory_id'), context);
    if (!assertion) throw new MemoryModuleError('MEMORY_NOT_FOUND', 'Memory not found', { status: 404 });
    assertRevision(assertion, input);
    assertion.status = 'revoked';
    assertion.resourceRevision += 1;
    assertion.updatedAt = nowIso();
    bumpEpoch(context);
    state.indexDocuments = (state.indexDocuments || []).filter(document => document.sourceId !== assertion.id);
    audit(state, context, 'memory_revoked', { memoryId: assertion.id });
    bumpSequence();
    await persist();
    return { memoryId: assertion.id, status: 'revoked', consistencyToken: tokenFor(state, context) };
  };

  const forget = async (rawContext, id, input = {}) => {
    const context = contextOf(rawContext);
    assertUserGovernanceActor(context);
    const assertion = findAssertion(state, normalizeId(id, 'memory_id'), context);
    if (!assertion) throw new MemoryModuleError('MEMORY_NOT_FOUND', 'Memory not found', { status: 404 });
    assertRevision(assertion, input);
    assertion.status = 'forgotten';
    assertion.resourceRevision += 1;
    assertion.updatedAt = nowIso();
    const epoch = bumpEpoch(context);
    state.indexDocuments = (state.indexDocuments || []).filter(document => document.sourceId !== assertion.id);
    const versionIds = state.assertionVersions.filter(item => item.assertionId === assertion.id).map(item => item.id);
    cleanDerivedForDeletion({ assertionIds: [assertion.id], versionIds, preserveRedactedOutbox: true });
    invalidateMutationRecords({ resourceType: 'memory', resourceIds: [assertion.id] });
    state.tombstones.push({ id: randomUUID(), tenantId: context.tenantId, userId: context.subjectUserId, targetType: 'memory', targetId: assertion.id, action: 'forget', redactionEpoch: epoch, createdAt: nowIso() });
    audit(state, context, 'memory_forgotten', { memoryId: assertion.id, redactionEpoch: epoch });
    bumpSequence();
    await persist();
    return { memoryId: assertion.id, status: 'forgotten', redactionEpoch: epoch, consistencyToken: tokenFor(state, context) };
  };

  const forgetSourceEvent = async (rawContext, id, input = {}) => {
    const context = contextOf(rawContext);
    assertUserGovernanceActor(context);
    const sourceEventId = normalizeId(id, 'source_event_id');
    const event = state.rawEvents.find(item => item.id === sourceEventId && item.tenantId === context.tenantId && item.userId === context.subjectUserId);
    if (!event) throw new MemoryModuleError('SOURCE_EVENT_NOT_FOUND', 'Source event not found', { status: 404 });
    assertRevision({ resourceRevision: event.resourceRevision || 1 }, input);
    const sourceVersionIds = state.assertionVersionSources.filter(source => source.sourceType === 'raw_event' && source.sourceId === sourceEventId).map(source => source.versionId);
    const assertionIds = state.assertionVersions.filter(version => sourceVersionIds.includes(version.id)).map(version => version.assertionId);
    invalidateMutationRecords({ resourceType: 'source_event', resourceIds: [sourceEventId] });
    invalidateMutationRecords({ resourceType: 'memory', resourceIds: assertionIds });
    for (const assertion of state.assertions.filter(item => assertionIds.includes(item.id))) {
      assertion.status = 'forgotten';
      assertion.updatedAt = nowIso();
      assertion.resourceRevision += 1;
    }
    state.profileSnapshotItems = state.profileSnapshotItems.filter(item => !assertionIds.includes(item.assertionId));
    state.indexDocuments = (state.indexDocuments || []).filter(item => !assertionIds.includes(item.sourceId));
    state.episodes = (state.episodes || []).map(episode => state.episodeMembers?.some(member => member.rawEventId === sourceEventId && member.episodeId === episode.id) ? { ...episode, status: 'invalidated', updatedAt: nowIso() } : episode);
    state.outboxEvents = state.outboxEvents.map(item => item.aggregateId === sourceEventId || assertionIds.includes(item.aggregateId) ? { ...item, status: 'completed', result: 'redacted', leaseOwner: null, leaseUntil: null } : item);
    cleanDerivedForDeletion({ rawEventIds: [sourceEventId], assertionIds, versionIds: sourceVersionIds, preserveRedactedOutbox: true });
    const epoch = bumpEpoch(context);
    const operation = { id: randomUUID(), tenantId: context.tenantId, subjectUserId: context.subjectUserId, targetType: 'source_event', targetId: sourceEventId, requestedScope: { sourceEventId }, action: 'forget', status: 'completed', requestedBy: context.actorId, requestedAt: nowIso(), canonicalHiddenAt: nowIso(), completedAt: nowIso(), redactionEpoch: epoch, resourceRevision: 1, lastErrorCode: null };
    state.deletionOperations.push(operation);
    state.tombstones.push({ id: randomUUID(), tenantId: context.tenantId, userId: context.subjectUserId, targetType: 'source_event', targetId: sourceEventId, action: 'forget', redactionEpoch: epoch, createdAt: nowIso() });
    bumpSequence();
    audit(state, context, 'source_event_forgotten', { sourceEventId, deletionOperationId: operation.id });
    await persist();
    return { sourceEventId, deletionOperationId: operation.id, status: 'forgotten', redactionEpoch: epoch, consistencyToken: tokenFor(state, context) };
  };

  const forgetSession = async (rawContext, id, input = {}) => {
    const context = contextOf(rawContext);
    assertUserGovernanceActor(context);
    const session = findSession(state, normalizeId(id, 'session_id'), context);
    if (!session) throw new MemoryModuleError('SESSION_NOT_FOUND', 'Session not found', { status: 404 });
    assertRevision(session, input);
    session.status = 'closed';
    session.closedAt = nowIso();
    session.resourceRevision += 1;
    const assertionIds = state.assertions.filter(item => item.sessionId === session.id).map(item => item.id);
    const rawEventIds = state.rawEvents.filter(item => item.sessionId === session.id).map(item => item.id);
    const versionIds = state.assertionVersions.filter(item => assertionIds.includes(item.assertionId)).map(item => item.id);
    invalidateMutationRecords({ resourceType: 'session', resourceIds: [session.id] });
    invalidateMutationRecords({ resourceType: 'memory', resourceIds: assertionIds });
    for (const assertion of state.assertions.filter(item => assertionIds.includes(item.id))) {
      assertion.status = 'forgotten';
      assertion.updatedAt = nowIso();
      assertion.resourceRevision += 1;
    }
    state.currentStates = state.currentStates.map(item => item.sessionId === session.id ? { ...item, status: 'forgotten', updatedAt: nowIso(), resourceRevision: item.resourceRevision + 1 } : item);
    state.profileSnapshotItems = state.profileSnapshotItems.filter(item => item.snapshotId !== session.profileSnapshotId);
    state.episodes = (state.episodes || []).map(episode => episode.sessionId === session.id ? { ...episode, status: 'invalidated', updatedAt: nowIso() } : episode);
    cleanDerivedForDeletion({ rawEventIds, assertionIds, versionIds, preserveRedactedOutbox: true });
    const epoch = bumpEpoch(context);
    const operation = { id: randomUUID(), tenantId: context.tenantId, subjectUserId: context.subjectUserId, targetType: 'session', targetId: session.id, requestedScope: { sessionId: session.id }, action: 'forget', status: 'completed', requestedBy: context.actorId, requestedAt: nowIso(), canonicalHiddenAt: nowIso(), completedAt: nowIso(), redactionEpoch: epoch, resourceRevision: 1, lastErrorCode: null };
    state.deletionOperations.push(operation);
    state.tombstones.push({ id: randomUUID(), tenantId: context.tenantId, userId: context.subjectUserId, targetType: 'session', targetId: session.id, action: 'forget', redactionEpoch: epoch, createdAt: nowIso() });
    bumpSequence();
    audit(state, context, 'session_forgotten', { sessionId: session.id, deletionOperationId: operation.id });
    await persist();
    return { sessionId: session.id, deletionOperationId: operation.id, status: 'forgotten', redactionEpoch: epoch, consistencyToken: tokenFor(state, context) };
  };

  const forgetRelationship = async (rawContext, agentId, input = {}) => {
    const context = contextOf(rawContext);
    assertUserGovernanceActor(context);
    const relationshipAgentId = normalizeId(agentId, 'relationship_agent_id');
    const assertionIds = state.assertions.filter(item => item.tenantId === context.tenantId && item.userId === context.subjectUserId && item.scopeType === 'relationship' && item.relationshipAgentId === relationshipAgentId).map(item => item.id);
    invalidateMutationRecords({ resourceType: 'relationship', resourceIds: [relationshipAgentId] });
    invalidateMutationRecords({ resourceType: 'memory', resourceIds: assertionIds });
    for (const assertion of state.assertions.filter(item => assertionIds.includes(item.id))) {
      assertion.status = 'forgotten';
      assertion.updatedAt = nowIso();
      assertion.resourceRevision += 1;
    }
    const versionIds = state.assertionVersions.filter(item => assertionIds.includes(item.assertionId)).map(item => item.id);
    state.profileSnapshotItems = state.profileSnapshotItems.filter(item => !assertionIds.includes(item.assertionId));
    state.profileProjections = (state.profileProjections || []).map(item => item.scopeType === 'relationship' && item.relationshipAgentId === relationshipAgentId ? { ...item, status: 'invalidated' } : item);
    state.indexDocuments = (state.indexDocuments || []).filter(item => !(item.scopeType === 'relationship' && item.relationshipAgentId === relationshipAgentId));
    cleanDerivedForDeletion({ assertionIds, versionIds, preserveRedactedOutbox: true });
    const epoch = bumpEpoch(context);
    const operation = { id: randomUUID(), tenantId: context.tenantId, subjectUserId: context.subjectUserId, targetType: 'relationship', targetId: relationshipAgentId, requestedScope: { relationshipAgentId }, action: 'forget', status: 'completed', requestedBy: context.actorId, requestedAt: nowIso(), canonicalHiddenAt: nowIso(), completedAt: nowIso(), redactionEpoch: epoch, resourceRevision: 1, lastErrorCode: null };
    state.deletionOperations.push(operation);
    state.tombstones.push({ id: randomUUID(), tenantId: context.tenantId, userId: context.subjectUserId, targetType: 'relationship', targetId: relationshipAgentId, action: 'forget', redactionEpoch: epoch, createdAt: nowIso() });
    bumpSequence();
    audit(state, context, 'relationship_forgotten', { relationshipAgentId, deletionOperationId: operation.id });
    await persist();
    return { relationshipAgentId, deletionOperationId: operation.id, status: 'forgotten', redactionEpoch: epoch, consistencyToken: tokenFor(state, context) };
  };

  const forgetAccount = async (rawContext, input = {}) => {
    const context = contextOf(rawContext);
    assertUserGovernanceActor(context);
    const accountAssertions = state.assertions.filter(item => item.tenantId === context.tenantId && item.userId === context.subjectUserId);
    const accountAssertionIds = accountAssertions.map(item => item.id);
    const accountRawEventIds = state.rawEvents.filter(item => item.tenantId === context.tenantId && item.userId === context.subjectUserId).map(item => item.id);
    const accountVersionIds = state.assertionVersions.filter(item => accountAssertionIds.includes(item.assertionId)).map(item => item.id);
    for (const assertion of accountAssertions) {
      assertion.status = 'forgotten';
      assertion.updatedAt = nowIso();
      assertion.resourceRevision += 1;
    }
    state.currentStates = state.currentStates.map(item => item.tenantId === context.tenantId && item.userId === context.subjectUserId ? { ...item, status: 'forgotten', updatedAt: nowIso(), resourceRevision: item.resourceRevision + 1 } : item);
    state.sessions = state.sessions.map(session => session.tenantId === context.tenantId && session.userId === context.subjectUserId ? { ...session, status: 'closed', closedAt: nowIso(), resourceRevision: session.resourceRevision + 1 } : session);
    state.profileSnapshotItems = state.profileSnapshotItems.filter(item => !state.profileSnapshots.some(snapshot => snapshot.id === item.snapshotId && snapshot.tenantId === context.tenantId && snapshot.userId === context.subjectUserId));
    state.profileProjections = (state.profileProjections || []).map(item => item.tenantId === context.tenantId && item.userId === context.subjectUserId ? { ...item, status: 'invalidated' } : item);
    state.indexDocuments = (state.indexDocuments || []).filter(item => !(item.tenantId === context.tenantId && item.userId === context.subjectUserId));
    state.episodes = (state.episodes || []).map(item => item.tenantId === context.tenantId && item.userId === context.subjectUserId ? { ...item, status: 'invalidated' } : item);
    cleanDerivedForDeletion({ rawEventIds: accountRawEventIds, assertionIds: accountAssertionIds, versionIds: accountVersionIds, preserveRedactedOutbox: true });
    const epoch = bumpEpoch(context);
    const operation = { id: randomUUID(), tenantId: context.tenantId, subjectUserId: context.subjectUserId, targetType: 'account', targetId: context.subjectUserId, requestedScope: { userId: context.subjectUserId }, action: 'forget', status: 'completed', requestedBy: context.actorId, requestedAt: nowIso(), canonicalHiddenAt: nowIso(), completedAt: nowIso(), redactionEpoch: epoch, resourceRevision: 1, lastErrorCode: null };
    state.deletionOperations.push(operation);
    state.tombstones.push({ id: randomUUID(), tenantId: context.tenantId, userId: context.subjectUserId, targetType: 'account', targetId: context.subjectUserId, action: 'forget', redactionEpoch: epoch, createdAt: nowIso() });
    const userAggregateIds = new Set([
      ...state.rawEvents.filter(item => item.tenantId === context.tenantId && item.userId === context.subjectUserId).map(item => item.id),
      ...state.assertions.filter(item => item.tenantId === context.tenantId && item.userId === context.subjectUserId).map(item => item.id)
    ]);
    state.outboxEvents = state.outboxEvents.map(item => userAggregateIds.has(item.aggregateId) ? { ...item, status: 'completed', result: 'redacted', leaseOwner: null, leaseUntil: null } : item);
    bumpSequence();
    audit(state, context, 'account_forgotten', { deletionOperationId: operation.id });
    await persist();
    return { deletionOperationId: operation.id, status: 'forgotten', redactionEpoch: epoch, consistencyToken: tokenFor(state, context) };
  };

  const cleanDerivedForDeletion = ({ rawEventIds = [], assertionIds = [], versionIds = [], preserveRedactedOutbox = false } = {}) => {
    state.profileSnapshots ||= [];
    state.profileSnapshotItems ||= [];
    state.profileProjections ||= [];
    state.profileProjectionItems ||= [];
    state.profileProjectionSources ||= [];
    state.currentStateSources ||= [];
    state.indexDocuments ||= [];
    state.mentionCooldowns ||= [];
    state.episodes ||= [];
    state.episodeMembers ||= [];
    const rawIds = new Set(rawEventIds);
    const memoryIds = new Set(assertionIds);
    const versionIdSet = new Set(versionIds);
    const affectedProjectionIds = new Set(state.profileProjectionItems
      .filter(item => memoryIds.has(item.assertionId) || versionIdSet.has(item.versionId))
      .map(item => item.projectionId));
    state.profileSnapshotItems = state.profileSnapshotItems.filter(item => !memoryIds.has(item.assertionId) && !versionIdSet.has(item.versionId));
    state.profileProjectionItems = state.profileProjectionItems.filter(item => !memoryIds.has(item.assertionId) && !versionIdSet.has(item.versionId));
    state.profileProjectionSources = state.profileProjectionSources.filter(item => !memoryIds.has(item.assertionId) && !versionIdSet.has(item.versionId));
    state.profileProjections = state.profileProjections.map(projection => affectedProjectionIds.has(projection.id) ? { ...projection, status: 'invalidated', updatedAt: nowIso() } : projection);
    state.indexDocuments = state.indexDocuments.filter(document => !memoryIds.has(document.sourceId) && !versionIdSet.has(document.sourceVersion));
    state.pins = state.pins.filter(pinRecord => !memoryIds.has(pinRecord.assertionId));
    state.confirmations = state.confirmations.filter(confirmation => !memoryIds.has(confirmation.candidateAssertionId) && !versionIdSet.has(confirmation.candidateVersionId));
    state.accessConfirmations = state.accessConfirmations.filter(access => !access.memoryIds?.some(memoryId => memoryIds.has(memoryId)));
    state.mentionCooldowns = state.mentionCooldowns.filter(record => !memoryIds.has(record.memoryId));
    const affectedEpisodeIds = new Set(state.episodeMembers
      .filter(member => rawIds.has(member.rawEventId) || versionIdSet.has(member.assertionVersionId))
      .map(member => member.episodeId));
    state.episodeMembers = state.episodeMembers.filter(member => !rawIds.has(member.rawEventId) && !versionIdSet.has(member.assertionVersionId));
    const episodeIdsWithMembers = new Set(state.episodeMembers.map(member => member.episodeId));
    state.episodes = state.episodes
      .filter(episode => episodeIdsWithMembers.has(episode.id) || !affectedEpisodeIds.has(episode.id))
      .map(episode => affectedEpisodeIds.has(episode.id) ? { ...episode, status: 'invalidated', updatedAt: nowIso() } : episode);
    state.outboxEvents = preserveRedactedOutbox
      ? state.outboxEvents.map(event => rawIds.has(event.aggregateId) || memoryIds.has(event.aggregateId) ? { ...event, status: 'completed', result: 'redacted', leaseOwner: null, leaseUntil: null } : event)
      : state.outboxEvents.filter(event => !rawIds.has(event.aggregateId) && !memoryIds.has(event.aggregateId));
    state.currentStateSources = state.currentStateSources.filter(item => !rawIds.has(item.rawEventId));
  };

  const physicallyRemoveAssertions = assertionIds => {
    const memoryIds = new Set(assertionIds);
    const versionIds = new Set(state.assertionVersions.filter(version => memoryIds.has(version.assertionId)).map(version => version.id));
    state.assertions = state.assertions.filter(assertion => !memoryIds.has(assertion.id));
    state.assertionVersions = state.assertionVersions.filter(version => !versionIds.has(version.id));
    state.assertionVersionSources = state.assertionVersionSources.filter(source => !versionIds.has(source.versionId));
    state.mentionCooldowns = (state.mentionCooldowns || []).filter(record => !memoryIds.has(record.memoryId));
    cleanDerivedForDeletion({ assertionIds: [...memoryIds], versionIds: [...versionIds] });
    invalidateMutationRecords({ resourceType: 'memory', resourceIds: [...memoryIds] });
    return { assertionIds: [...memoryIds], versionIds: [...versionIds] };
  };

  const physicallyRemoveSourceEvents = sourceEventIds => {
    const rawIds = new Set(sourceEventIds);
    const removedEventKeys = new Set(state.rawEvents
      .filter(event => rawIds.has(event.id))
      .map(event => `${event.eventId}:${event.sourceRevision}`));
    const sourceRows = state.assertionVersionSources.filter(source => source.sourceType === 'raw_event' && rawIds.has(source.sourceId));
    const affectedVersionIds = new Set(sourceRows.map(source => source.versionId));
    const affectedAssertionIds = new Set(state.assertionVersions.filter(version => affectedVersionIds.has(version.id)).map(version => version.assertionId));
    state.assertionVersionSources = state.assertionVersionSources.filter(source => !(source.sourceType === 'raw_event' && rawIds.has(source.sourceId)));
    const orphanVersionIds = new Set(state.assertionVersions
      .filter(version => affectedVersionIds.has(version.id) && !state.assertionVersionSources.some(source => source.versionId === version.id))
      .map(version => version.id));
    const orphanAssertionIds = new Set(state.assertionVersions.filter(version => orphanVersionIds.has(version.id)).map(version => version.assertionId));
    state.assertionVersions = state.assertionVersions.filter(version => !orphanVersionIds.has(version.id));
    state.assertionVersionSources = state.assertionVersionSources.filter(source => !orphanVersionIds.has(source.versionId));
    for (const assertion of state.assertions.filter(item => affectedAssertionIds.has(item.id) && !orphanAssertionIds.has(item.id))) {
      const remaining = state.assertionVersions.filter(version => version.assertionId === assertion.id).sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt));
      assertion.currentVersionId = remaining[0]?.id || null;
      if (remaining[0]) remaining[0].versionStatus = 'current';
    }
    state.assertions = state.assertions.filter(assertion => !orphanAssertionIds.has(assertion.id));
    state.rawEvents = state.rawEvents.filter(event => !rawIds.has(event.id));
    cleanDerivedForDeletion({ rawEventIds: [...rawIds], assertionIds: [...affectedAssertionIds], versionIds: [...orphanVersionIds] });
    invalidateMutationRecords({ resourceType: 'source_event', resourceIds: [...rawIds] });
    invalidateMutationRecords({ resourceType: 'memory', resourceIds: [...affectedAssertionIds] });
    state.idempotencyRecords = state.idempotencyRecords.filter(record => mutationNamespaceOf(record) !== 'event' || !removedEventKeys.has(record.key));
    return { rawEventIds: [...rawIds], assertionIds: [...affectedAssertionIds], versionIds: [...orphanVersionIds] };
  };

  const sweepRetention = async (rawContext, input = {}) => {
    const context = contextOf(rawContext);
    const at = asDate(input.now ?? input.at, 'now') || nowIso();
    const timestamp = new Date(at).getTime();
    const limit = Math.max(1, Math.min(1000, Number(input.limit) || 100));
    const stats = { rawEvents: 0, sessions: 0, assertions: 0, currentStates: 0, confirmations: 0, mentionCooldowns: 0, idempotencyRecords: 0 };
    const expiredRawEvents = state.rawEvents
      .filter(event => event.tenantId === context.tenantId && event.userId === context.subjectUserId && event.deleteAfter && new Date(event.deleteAfter).getTime() <= timestamp)
      .slice(0, limit);
    if (expiredRawEvents.length) {
      const removed = physicallyRemoveSourceEvents(expiredRawEvents.map(event => event.id));
      stats.rawEvents = removed.rawEventIds.length;
    }

    const expiredSessionIds = new Set(state.sessions
      .filter(session => session.tenantId === context.tenantId && session.userId === context.subjectUserId && session.status === 'active' && session.expiresAt && new Date(session.expiresAt).getTime() <= timestamp)
      .slice(0, limit)
      .map(session => session.id));
    for (const session of state.sessions.filter(item => expiredSessionIds.has(item.id))) {
      session.status = 'expired';
      session.closedAt = at;
      session.resourceRevision += 1;
      stats.sessions += 1;
    }

    const expirationAssertionIds = new Set(state.assertions
      .filter(assertion => assertion.tenantId === context.tenantId && assertion.userId === context.subjectUserId)
      .filter(assertion => ['active', 'candidate', 'pending_confirmation'].includes(assertion.status)
        && ((assertion.expiresAt && new Date(assertion.expiresAt).getTime() <= timestamp) || expiredSessionIds.has(assertion.sessionId)))
      .slice(0, limit)
      .map(assertion => assertion.id));
    const expirationVersionIds = new Set();
    for (const assertion of state.assertions.filter(item => expirationAssertionIds.has(item.id))) {
      assertion.status = 'expired';
      assertion.resourceRevision += 1;
      assertion.updatedAt = at;
      if (assertion.currentVersionId) expirationVersionIds.add(assertion.currentVersionId);
      for (const version of state.assertionVersions.filter(item => item.assertionId === assertion.id && item.versionStatus === 'current')) {
        version.versionStatus = 'invalidated';
        expirationVersionIds.add(version.id);
      }
      stats.assertions += 1;
    }

    const expiredConfirmations = state.confirmations
      .filter(confirmation => confirmation.tenantId === context.tenantId && confirmation.userId === context.subjectUserId && confirmation.status === 'pending' && confirmation.expiresAt && new Date(confirmation.expiresAt).getTime() <= timestamp)
      .slice(0, limit);
    for (const confirmation of expiredConfirmations) {
      confirmation.status = 'expired';
      confirmation.decidedAt = at;
      stats.confirmations += 1;
      const assertion = state.assertions.find(item => item.id === confirmation.candidateAssertionId);
      if (assertion && assertion.status === 'pending_confirmation') expirationAssertionIds.add(assertion.id);
    }
    invalidateMutationRecords({ resourceType: 'confirmation', resourceIds: expiredConfirmations.map(item => item.id) });
    for (const assertion of state.assertions.filter(item => expirationAssertionIds.has(item.id) && item.status === 'pending_confirmation')) {
      assertion.status = 'expired';
      assertion.resourceRevision += 1;
      assertion.updatedAt = at;
      if (assertion.currentVersionId) expirationVersionIds.add(assertion.currentVersionId);
      for (const version of state.assertionVersions.filter(item => item.assertionId === assertion.id && item.versionStatus === 'current')) {
        version.versionStatus = 'invalidated';
        expirationVersionIds.add(version.id);
      }
      stats.assertions += 1;
    }

    const expiredCurrentStateIds = new Set(state.currentStates
      .filter(current => current.tenantId === context.tenantId && current.userId === context.subjectUserId && current.status === 'active'
        && (new Date(current.expiresAt).getTime() <= timestamp || expiredSessionIds.has(current.sessionId)))
      .slice(0, limit)
      .map(current => current.id));
    for (const current of state.currentStates.filter(item => expiredCurrentStateIds.has(item.id))) {
      current.status = 'expired';
      current.resourceRevision += 1;
      current.updatedAt = at;
      stats.currentStates += 1;
    }

    const beforeMentionCooldownCount = state.mentionCooldowns.length;
    state.mentionCooldowns = state.mentionCooldowns.filter(record => !record.cooldownUntil || new Date(record.cooldownUntil).getTime() > timestamp);
    stats.mentionCooldowns = beforeMentionCooldownCount - state.mentionCooldowns.length;

    if (expirationAssertionIds.size) {
      const assertionIds = new Set(expirationAssertionIds);
      const versionIds = new Set([...expirationVersionIds, ...state.assertionVersions.filter(version => assertionIds.has(version.assertionId)).map(version => version.id)]);
      const affectedProjectionIds = new Set(state.profileProjectionItems.filter(item => assertionIds.has(item.assertionId) || versionIds.has(item.versionId)).map(item => item.projectionId));
      state.profileSnapshotItems = state.profileSnapshotItems.filter(item => !assertionIds.has(item.assertionId) && !versionIds.has(item.versionId));
      state.profileProjectionItems = state.profileProjectionItems.filter(item => !assertionIds.has(item.assertionId) && !versionIds.has(item.versionId));
      state.profileProjectionSources = state.profileProjectionSources.filter(item => !assertionIds.has(item.assertionId) && !versionIds.has(item.versionId));
      state.profileProjections = state.profileProjections.map(projection => affectedProjectionIds.has(projection.id) ? { ...projection, status: 'invalidated', updatedAt: at } : projection);
      state.indexDocuments = state.indexDocuments.filter(document => !assertionIds.has(document.sourceId) && !versionIds.has(document.sourceVersion));
      state.pins = state.pins.filter(pinRecord => !assertionIds.has(pinRecord.assertionId));
      state.accessConfirmations = state.accessConfirmations.filter(access => !access.memoryIds?.some(memoryId => assertionIds.has(memoryId)));
      const affectedEpisodeIds = new Set(state.episodeMembers.filter(member => versionIds.has(member.assertionVersionId)).map(member => member.episodeId));
      state.episodeMembers = state.episodeMembers.filter(member => !versionIds.has(member.assertionVersionId));
      state.episodes = state.episodes.map(episode => affectedEpisodeIds.has(episode.id) ? { ...episode, status: 'invalidated', updatedAt: at } : episode);
      state.outboxEvents = state.outboxEvents.map(event => assertionIds.has(event.aggregateId) ? { ...event, status: 'completed', result: 'expired', leaseOwner: null, leaseUntil: null } : event);
      invalidateMutationRecords({ resourceType: 'memory', resourceIds: [...assertionIds] });
    }

    const beforeIdempotencyCount = state.idempotencyRecords.length;
    state.idempotencyRecords = state.idempotencyRecords.filter(record => mutationNamespaceOf(record) === 'event' || !record.expiresAt || new Date(record.expiresAt).getTime() > timestamp);
    stats.idempotencyRecords = beforeIdempotencyCount - state.idempotencyRecords.length;
    const changed = Object.values(stats).some(value => value > 0);
    if (!changed) return { ...stats, status: 'noop', consistencyToken: tokenFor(state, context) };
    if (stats.rawEvents || stats.sessions || stats.assertions || stats.currentStates || stats.confirmations) bumpEpoch(context);
    bumpSequence();
    audit(state, context, 'retention_sweep', { at, ...stats });
    await persist();
    return { ...stats, status: 'swept', consistencyToken: tokenFor(state, context) };
  };

  const newDeletionOperation = (context, targetType, targetId, requestedScope) => {
    const at = nowIso();
    const operation = { id: randomUUID(), tenantId: context.tenantId, subjectUserId: context.subjectUserId, targetType, targetId, requestedScope, action: 'delete', status: 'completed', requestedBy: context.actorId, requestedAt: at, canonicalHiddenAt: at, completedAt: at, redactionEpoch: bumpEpoch(context), resourceRevision: 1, lastErrorCode: null };
    state.deletionOperations.push(operation);
    state.tombstones.push({ id: randomUUID(), tenantId: context.tenantId, userId: context.subjectUserId, targetType, targetId, action: 'delete', redactionEpoch: operation.redactionEpoch, createdAt: at });
    return operation;
  };

  const deleteSourceEvent = async (rawContext, id, input = {}) => {
    const context = contextOf(rawContext);
    assertUserGovernanceActor(context);
    const sourceEventId = normalizeId(id, 'source_event_id');
    const event = state.rawEvents.find(item => item.id === sourceEventId && item.tenantId === context.tenantId && item.userId === context.subjectUserId);
    if (!event) throw new MemoryModuleError('SOURCE_EVENT_NOT_FOUND', 'Source event not found', { status: 404 });
    assertRevision({ resourceRevision: event.resourceRevision || 1 }, input);
    const removed = physicallyRemoveSourceEvents([sourceEventId]);
    state.idempotencyRecords = state.idempotencyRecords.filter(record => mutationNamespaceOf(record) !== 'event' || record.key !== `${event.eventId}:${event.sourceRevision}`);
    const operation = newDeletionOperation(context, 'source_event', sourceEventId, { sourceEventId });
    bumpSequence();
    audit(state, context, 'source_event_deleted', { sourceEventId, deletionOperationId: operation.id, removedAssertionCount: removed.assertionIds.length });
    await persist();
    return { sourceEventId, deletionOperationId: operation.id, status: operation.status, redactionEpoch: operation.redactionEpoch, consistencyToken: tokenFor(state, context) };
  };

  const deleteSession = async (rawContext, id, input = {}) => {
    const context = contextOf(rawContext);
    assertUserGovernanceActor(context);
    const sessionId = normalizeId(id, 'session_id');
    const session = findSession(state, sessionId, context);
    if (!session) throw new MemoryModuleError('SESSION_NOT_FOUND', 'Session not found', { status: 404 });
    assertRevision(session, input);
    const rawEvents = state.rawEvents.filter(event => event.sessionId === sessionId);
    const removedSources = physicallyRemoveSourceEvents(rawEvents.map(event => event.id));
    const sessionAssertions = state.assertions.filter(assertion => assertion.sessionId === sessionId).map(assertion => assertion.id);
    const removedAssertions = physicallyRemoveAssertions(sessionAssertions);
    state.currentStates = state.currentStates.filter(item => item.sessionId !== sessionId);
    state.profileSnapshots = state.profileSnapshots.filter(snapshot => snapshot.id !== session.profileSnapshotId);
    state.sessions = state.sessions.filter(item => item.id !== sessionId);
    state.idempotencyRecords = state.idempotencyRecords.filter(record => mutationNamespaceOf(record) !== 'event' || !rawEvents.some(event => record.key === `${event.eventId}:${event.sourceRevision}`));
    state.episodes = state.episodes.filter(episode => episode.sessionId !== sessionId);
    state.episodeMembers = state.episodeMembers.filter(member => !rawEvents.some(event => event.id === member.rawEventId));
    const operation = newDeletionOperation(context, 'session', sessionId, { sessionId });
    bumpSequence();
    audit(state, context, 'session_deleted', { sessionId, deletionOperationId: operation.id, removedAssertionCount: removedAssertions.assertionIds.length + removedSources.assertionIds.length });
    await persist();
    return { sessionId, deletionOperationId: operation.id, status: operation.status, redactionEpoch: operation.redactionEpoch, consistencyToken: tokenFor(state, context) };
  };

  const deleteRelationship = async (rawContext, agentId, input = {}) => {
    const context = contextOf(rawContext);
    assertUserGovernanceActor(context);
    const relationshipAgentId = normalizeId(agentId, 'relationship_agent_id');
    const assertionIds = state.assertions.filter(item => item.tenantId === context.tenantId && item.userId === context.subjectUserId && item.scopeType === 'relationship' && item.relationshipAgentId === relationshipAgentId).map(item => item.id);
    const removed = physicallyRemoveAssertions(assertionIds);
    const removedProjectionIds = new Set((state.profileProjections || []).filter(projection => projection.scopeType === 'relationship' && projection.relationshipAgentId === relationshipAgentId).map(projection => projection.id));
    state.profileProjections = (state.profileProjections || []).filter(projection => !removedProjectionIds.has(projection.id));
    state.profileProjectionItems = (state.profileProjectionItems || []).filter(item => state.profileProjections.some(projection => projection.id === item.projectionId));
    state.profileProjectionSources = (state.profileProjectionSources || []).filter(item => !removedProjectionIds.has(item.projectionId));
    const operation = newDeletionOperation(context, 'relationship', relationshipAgentId, { relationshipAgentId });
    bumpSequence();
    audit(state, context, 'relationship_deleted', { relationshipAgentId, deletionOperationId: operation.id, removedAssertionCount: removed.assertionIds.length });
    await persist();
    return { relationshipAgentId, deletionOperationId: operation.id, status: operation.status, redactionEpoch: operation.redactionEpoch, consistencyToken: tokenFor(state, context) };
  };

  const deleteAccount = async (rawContext, input = {}) => {
    const context = contextOf(rawContext);
    assertUserGovernanceActor(context);
    removeAccountDataForSubject(state, { tenantId: context.tenantId, userId: context.subjectUserId });
    const operation = newDeletionOperation(context, 'account', context.subjectUserId, { userId: context.subjectUserId });
    bumpSequence();
    audit(state, context, 'account_deleted', { deletionOperationId: operation.id });
    await persist();
    return { deletionOperationId: operation.id, status: operation.status, redactionEpoch: operation.redactionEpoch, consistencyToken: tokenFor(state, context) };
  };

  const remove = async (rawContext, id, input = {}) => {
    const context = contextOf(rawContext);
    assertUserGovernanceActor(context);
    const assertion = findAssertion(state, normalizeId(id, 'memory_id'), context);
    if (!assertion) throw new MemoryModuleError('MEMORY_NOT_FOUND', 'Memory not found', { status: 404 });
    assertRevision(assertion, input);
    const operation = { id: randomUUID(), tenantId: context.tenantId, subjectUserId: context.subjectUserId, targetType: 'memory', targetId: assertion.id, requestedScope: { scopeType: assertion.scopeType }, action: 'delete', status: 'accepted', requestedBy: context.actorId, requestedAt: nowIso(), canonicalHiddenAt: null, completedAt: null, redactionEpoch: bumpEpoch(context), resourceRevision: 1, lastErrorCode: null };
    physicallyRemoveAssertions([assertion.id]);
    operation.status = 'completed';
    operation.canonicalHiddenAt = nowIso();
    operation.completedAt = nowIso();
    state.deletionOperations.push(operation);
    state.tombstones.push({ id: randomUUID(), tenantId: context.tenantId, userId: context.subjectUserId, targetType: 'memory', targetId: assertion.id, action: 'delete', redactionEpoch: operation.redactionEpoch, createdAt: nowIso() });
    audit(state, context, 'memory_deleted', { memoryId: assertion.id, deletionOperationId: operation.id });
    bumpSequence();
    await persist();
    return { deletionOperationId: operation.id, status: operation.status, redactionEpoch: operation.redactionEpoch, consistencyToken: tokenFor(state, context) };
  };

  const decideConfirmation = async (rawContext, id, input = {}, decision) => {
    const context = contextOf(rawContext);
    assertUserGovernanceActor(context);
    const confirmation = state.confirmations.find(item => item.id === normalizeId(id, 'confirmation_id') && item.tenantId === context.tenantId && item.userId === context.subjectUserId);
    if (!confirmation) throw new MemoryModuleError('CONFIRMATION_NOT_FOUND', 'Confirmation not found', { status: 404 });
    assertRevision(confirmation, input);
    if (confirmation.status !== 'pending' || new Date(confirmation.expiresAt).getTime() <= Date.now()) throw new MemoryModuleError('CONFIRMATION_EXPIRED', 'Confirmation is no longer pending', { status: 409 });
    const assertion = findAssertion(state, confirmation.candidateAssertionId, context);
    if (!assertion) throw new MemoryModuleError('MEMORY_NOT_FOUND', 'Memory not found', { status: 404 });
    if (Number(confirmation.resourceRevision) !== Number(assertion.resourceRevision)) throw new MemoryModuleError('RESOURCE_REVISION_CONFLICT', 'The assertion changed after this confirmation was created', { status: 409, currentResourceRevision: assertion.resourceRevision });
    const candidateVersion = findVersion(state, confirmation.candidateVersionId);
    if (!candidateVersion || candidateVersion.assertionId !== assertion.id) throw new MemoryModuleError('MEMORY_VERSION_NOT_FOUND', 'Confirmation version not found', { status: 404 });
    const switchesVersion = assertion.currentVersionId !== candidateVersion.id;
    confirmation.status = decision === 'confirm' ? 'confirmed' : 'rejected';
    confirmation.decidedBy = context.actorId;
    confirmation.decidedAt = nowIso();
    confirmation.resourceRevision += 1;
    if (decision === 'confirm') {
      if (switchesVersion) {
        const oldVersion = currentVersion(state, assertion);
        if (oldVersion) oldVersion.versionStatus = 'superseded';
        candidateVersion.versionStatus = 'current';
        assertion.currentVersionId = candidateVersion.id;
        assertion.sensitivity = confirmation.sensitivity;
        const policies = defaultPolicies(confirmation.sensitivity);
        assertion.mentionPolicy = policies.mentionPolicy;
        assertion.directQueryPolicy = policies.directQueryPolicy;
        assertion.autoRecallAllowed = policies.autoRecallAllowed;
        state.indexDocuments = (state.indexDocuments || []).filter(document => document.sourceId !== assertion.id);
      }
      assertion.status = 'active';
      assertion.resourceRevision += 1;
      assertion.updatedAt = nowIso();
      bumpSequence();
      state.outboxEvents.push({ id: randomUUID(), tenantId: context.tenantId, userId: context.subjectUserId, consumerName: 'memory-derived', type: 'assertion.active', aggregateId: assertion.id, schemaVersion: 1, commitSeq: state.sequence, status: 'pending', createdAt: nowIso() });
    } else {
      candidateVersion.versionStatus = 'invalidated';
      if (!switchesVersion) assertion.status = 'rejected';
      assertion.resourceRevision += 1;
      assertion.updatedAt = nowIso();
      bumpSequence();
    }
    audit(state, context, `memory_${decision}d`, { memoryId: assertion.id, confirmationId: confirmation.id });
    await persist();
    return { confirmation: clone(confirmation), memory: serializeAssertion(state, assertion, { includeGovernance: true }), consistencyToken: tokenFor(state, context) };
  };

  const writeCurrentState = async (rawContext, input = {}) => {
    const context = contextOf(rawContext);
    requestPayloadTenantMatches(context, input);
    const storageDirective = input.storageDirective ?? input.storage_directive ?? 'default';
    assertEnum(storageDirective, allowedStorageDirectives, 'INVALID_STORAGE_DIRECTIVE', 'storage_directive');
    if (storageDirective === 'do_not_store') {
      audit(state, context, 'state_accepted_no_store', { noStoreReason: 'caller_directive' });
      bumpSequence();
      await persist();
      return { status: 'accepted_no_store', consistencyToken: tokenFor(state, context) };
    }
    const sessionId = normalizeId(input.sessionId ?? input.session_id ?? context.sessionId, 'session_id');
    const session = assertSessionAccess(state, context, sessionId);
    const expiresAt = asDate(input.expiresAt ?? input.expires_at, 'expires_at', { required: true });
    if (new Date(expiresAt).getTime() <= Date.now()) throw new MemoryModuleError('INVALID_EXPIRES_AT', 'expires_at must be in the future');
    const content = normalizeText(input.value ?? input.content, 2000);
    if (!content) throw new MemoryModuleError('INVALID_STATE_VALUE', 'value is required');
    const sensitivity = classifySensitivity({ ...input, content });
    if (sensitivity === 'S3') {
      audit(state, context, 'state_rejected_s3');
      bumpSequence();
      await persist();
      throw new MemoryModuleError('S3_CONTENT_REJECTED', 'Sensitive content cannot be stored', { status: 422 });
    }
    if (sensitivity === 'S2') throw new MemoryModuleError('S2_CURRENT_STATE_REQUIRES_CONFIRMATION', 'S2 state requires confirmation before storage');
    const sourceEventId = input.sourceEventId ?? input.source_event_id;
    const sourceEvent = sourceEventId
      ? state.rawEvents.find(item => item.id === String(sourceEventId) && item.tenantId === context.tenantId && item.userId === context.subjectUserId && item.sessionId === session.id)
      : null;
    if (sourceEventId && !sourceEvent) throw new MemoryModuleError('SOURCE_EVENT_NOT_FOUND', 'Current state source event not found', { status: 404 });
    const current = state.currentStates.find(item => item.tenantId === context.tenantId && item.userId === context.subjectUserId && item.sessionId === session.id && item.stateType === (input.stateType ?? input.state_type ?? 'current'));
    if (current) assertRevision(current, input);
    const record = current || { id: randomUUID(), tenantId: context.tenantId, userId: context.subjectUserId, agentId: session.callerAgentId, sessionId: session.id, stateType: input.stateType ?? input.state_type ?? 'current', resourceRevision: 1, createdAt: nowIso() };
    Object.assign(record, { value: content, confidence: clamp(input.confidence, 0, 1), expiresAt, allowPersist: Boolean(input.allowPersist ?? input.allow_persist), requiresConfirmation: sensitivity === 'S2', promotedFrom: input.promotedFrom ?? input.promoted_from ?? null, promotionActor: context.actorId, status: 'active', updatedAt: nowIso() });
    if (!current) state.currentStates.push(record); else record.resourceRevision += 1;
    if (sourceEventId) {
      state.currentStateSources = state.currentStateSources.filter(item => item.currentStateId !== record.id);
      state.currentStateSources.push({ tenantId: context.tenantId, currentStateId: record.id, userId: context.subjectUserId, rawEventId: sourceEvent.id, sourceRole: 'observed', createdAt: nowIso() });
    }
    audit(state, context, 'current_state_written', { stateId: record.id, sessionId: session.id });
    bumpSequence();
    await persist();
    return { currentState: clone(record), consistencyToken: tokenFor(state, context) };
  };

  const getDeletionOperation = (rawContext, id) => {
    const context = contextOf(rawContext);
    const operation = state.deletionOperations.find(item => item.id === normalizeId(id, 'deletion_operation_id') && item.tenantId === context.tenantId && item.subjectUserId === context.subjectUserId);
    return operation ? clone(operation) : null;
  };

  const listConfirmations = (rawContext, options = {}) => {
    const context = contextOf(rawContext);
    const status = options.status || 'pending';
    let cursor = null;
    const cursorValue = options.cursor ?? options.nextCursor ?? options.next_cursor;
    if (cursorValue) {
      try {
        cursor = decodeOpaqueCursor(cursorValue);
        assertCursorBinding(cursor, { resource: 'confirmations', tenantId: context.tenantId, subjectUserId: context.subjectUserId, status });
      } catch (error) {
        if (error instanceof PaginationCursorError || error?.code === 'INVALID_CURSOR') throw new MemoryModuleError('INVALID_CURSOR', 'Invalid pagination cursor');
        throw error;
      }
    }
    const visible = state.confirmations
      .filter(item => item.tenantId === context.tenantId && item.userId === context.subjectUserId)
      .filter(item => !status || item.status === status)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt) || String(b.id).localeCompare(String(a.id)));
    const page = pageNewestFirst(visible.map(item => ({ item, id: item.id, sortValue: item.createdAt })), {
      cursor,
      limit: options.limit,
      cursorPayload: { resource: 'confirmations', tenantId: context.tenantId, subjectUserId: context.subjectUserId, status }
    });
    const items = page.items.map(item => clone(item.item));
    return options.returnPage ? { items, nextCursor: page.nextCursor } : items;
  };

  const wrapMutation = (namespace, method, { inputIndex = 1, resourceType = null, resourceIdIndex = null } = {}) => (...args) => {
    const input = args[inputIndex] && typeof args[inputIndex] === 'object' ? args[inputIndex] : {};
    const resourceId = resourceIdIndex == null ? null : args[resourceIdIndex];
    return executeMutation(args[0], {
      namespace,
      input,
      resourceType,
      resourceId,
      invoke: () => method(...args)
    });
  };

  const idempotentCreateSession = wrapMutation('session.create', createSession, { resourceType: 'session' });
  const idempotentGrantUserScope = wrapMutation('grant.create', grantUserScope, { resourceType: 'grant' });
  const idempotentHold = wrapMutation('memory.create', hold, { resourceType: 'memory' });
  const idempotentCorrect = wrapMutation('memory.correct', correct, { inputIndex: 2, resourceType: 'memory', resourceIdIndex: 1 });
  const idempotentPromoteCandidate = wrapMutation('memory.promote', promoteCandidate, { inputIndex: 2, resourceType: 'memory', resourceIdIndex: 1 });
  const idempotentPin = wrapMutation('memory.pin', pin, { inputIndex: 2, resourceType: 'memory', resourceIdIndex: 1 });
  const idempotentUnpin = wrapMutation('memory.unpin', unpin, { inputIndex: 2, resourceType: 'memory', resourceIdIndex: 1 });
  const idempotentRevoke = wrapMutation('memory.revoke', revoke, { inputIndex: 2, resourceType: 'memory', resourceIdIndex: 1 });
  const idempotentForget = wrapMutation('memory.forget', forget, { inputIndex: 2, resourceType: 'memory', resourceIdIndex: 1 });
  const idempotentForgetSourceEvent = wrapMutation('governance.forget.source_event', forgetSourceEvent, { inputIndex: 2, resourceType: 'source_event', resourceIdIndex: 1 });
  const idempotentForgetSession = wrapMutation('governance.forget.session', forgetSession, { inputIndex: 2, resourceType: 'session', resourceIdIndex: 1 });
  const idempotentForgetRelationship = wrapMutation('governance.forget.relationship', forgetRelationship, { inputIndex: 2, resourceType: 'relationship', resourceIdIndex: 1 });
  const idempotentForgetAccount = wrapMutation('governance.forget.account', forgetAccount, { resourceType: 'account' });
  const idempotentDeleteSourceEvent = wrapMutation('governance.delete.source_event', deleteSourceEvent, { inputIndex: 2, resourceType: 'source_event', resourceIdIndex: 1 });
  const idempotentDeleteSession = wrapMutation('governance.delete.session', deleteSession, { inputIndex: 2, resourceType: 'session', resourceIdIndex: 1 });
  const idempotentDeleteRelationship = wrapMutation('governance.delete.relationship', deleteRelationship, { inputIndex: 2, resourceType: 'relationship', resourceIdIndex: 1 });
  const idempotentDeleteAccount = wrapMutation('governance.delete.account', deleteAccount, { resourceType: 'account' });
  const idempotentRemove = wrapMutation('memory.delete', remove, { inputIndex: 2, resourceType: 'memory', resourceIdIndex: 1 });
  const idempotentConfirm = wrapMutation('confirmation.confirm', (context, id, input) => decideConfirmation(context, id, input, 'confirm'), { inputIndex: 2, resourceType: 'confirmation', resourceIdIndex: 1 });
  const idempotentReject = wrapMutation('confirmation.reject', (context, id, input) => decideConfirmation(context, id, input, 'reject'), { inputIndex: 2, resourceType: 'confirmation', resourceIdIndex: 1 });
  const idempotentConfirmAccess = wrapMutation('access_confirmation.confirm', confirmAccess, { inputIndex: 2, resourceType: 'access_confirmation', resourceIdIndex: 1 });
  const idempotentWriteCurrentState = wrapMutation('current_state.write', writeCurrentState, { resourceType: 'current_state' });
  const idempotentRecordMention = wrapMutation('mention.record', recordMention);

  return {
    state,
    createSession: idempotentCreateSession,
    recordEvent,
    grantUserScope: idempotentGrantUserScope,
    hold: idempotentHold,
    createCandidate,
    promoteCandidate: idempotentPromoteCandidate,
    list,
    get,
    retrieve,
    retrieveAsync,
    contextBundle,
    contextBundleAsync,
    recordMention: idempotentRecordMention,
    correct: idempotentCorrect,
    pin: idempotentPin,
    unpin: idempotentUnpin,
    revoke: idempotentRevoke,
    forget: idempotentForget,
    forgetSourceEvent: idempotentForgetSourceEvent,
    forgetSession: idempotentForgetSession,
    forgetRelationship: idempotentForgetRelationship,
    forgetAccount: idempotentForgetAccount,
    deleteSourceEvent: idempotentDeleteSourceEvent,
    deleteSession: idempotentDeleteSession,
    deleteRelationship: idempotentDeleteRelationship,
    deleteAccount: idempotentDeleteAccount,
    sweepRetention,
    remove: idempotentRemove,
    confirm: idempotentConfirm,
    reject: idempotentReject,
    confirmAccess: idempotentConfirmAccess,
    writeCurrentState: idempotentWriteCurrentState,
    getDeletionOperation,
    listConfirmations
  };
}
