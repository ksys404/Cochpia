const ACTOR_TYPES = new Set(['user', 'agent', 'system']);

export class IdentityRelationshipContextError extends Error {
  constructor(code, message, { status = 400 } = {}) {
    super(message);
    this.name = 'IdentityRelationshipContextError';
    this.code = code;
    this.status = status;
  }
}

function requiredId(value, field) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new IdentityRelationshipContextError(`IDENTITY_${field.toUpperCase()}_REQUIRED`, `${field} is required`, { status: 401 });
  if (normalized.length > 200) throw new IdentityRelationshipContextError(`IDENTITY_${field.toUpperCase()}_TOO_LONG`, `${field} is too long`, { status: 400 });
  return normalized;
}

function optionalId(value, field) {
  if (value == null || value === '') return null;
  return requiredId(value, field);
}

export function buildIdentityRelationshipContext(input = {}) {
  const tenantId = requiredId(input.tenantId ?? input.tenant_id, 'tenant_id');
  const subjectUserId = requiredId(input.subjectUserId ?? input.subject_user_id ?? input.userId ?? input.user_id, 'subject_user_id');
  const actorType = String(input.actorType ?? input.actor_type ?? 'user').trim();
  if (!ACTOR_TYPES.has(actorType)) throw new IdentityRelationshipContextError('IDENTITY_ACTOR_TYPE_INVALID', 'Invalid actor type', { status: 403 });

  const callerAgentId = optionalId(input.callerAgentId ?? input.caller_agent_id, 'caller_agent_id');
  const actorId = requiredId(input.actorId ?? input.actor_id ?? (actorType === 'user' ? subjectUserId : callerAgentId), 'actor_id');
  if (actorType === 'user' && actorId !== subjectUserId) {
    throw new IdentityRelationshipContextError('IDENTITY_ACTOR_SUBJECT_MISMATCH', 'User actor must be the authenticated subject', { status: 403 });
  }
  if (actorType === 'agent' && (!callerAgentId || actorId !== callerAgentId)) {
    throw new IdentityRelationshipContextError('IDENTITY_AGENT_CONTEXT_INVALID', 'Agent actor and caller agent must match', { status: 403 });
  }

  return {
    tenantId,
    subjectUserId,
    actorType,
    actorId,
    callerAgentId,
    relationshipId: optionalId(input.relationshipId ?? input.relationship_id, 'relationship_id'),
    sessionId: optionalId(input.sessionId ?? input.session_id, 'session_id'),
    requestId: optionalId(input.requestId ?? input.request_id, 'request_id'),
    traceId: optionalId(input.traceId ?? input.trace_id, 'trace_id'),
    grant: input.grant == null ? null : structuredClone(input.grant)
  };
}

export { ACTOR_TYPES };
