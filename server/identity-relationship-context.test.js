import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIdentityRelationshipContext } from './identity-relationship-context.js';

test('identity relationship context keeps server-derived user and relationship fields together', () => {
  const context = buildIdentityRelationshipContext({
    tenantId: 'tenant-1',
    subjectUserId: 'user-1',
    actorType: 'user',
    actorId: 'user-1',
    callerAgentId: 'cochpia',
    relationshipId: 'relationship:cochpia',
    sessionId: 'session-1',
    requestId: 'request-1'
  });
  assert.deepEqual(context, {
    tenantId: 'tenant-1',
    subjectUserId: 'user-1',
    actorType: 'user',
    actorId: 'user-1',
    callerAgentId: 'cochpia',
    relationshipId: 'relationship:cochpia',
    sessionId: 'session-1',
    requestId: 'request-1',
    traceId: null,
    grant: null
  });
});

test('identity relationship context rejects subject impersonation and malformed agent context', () => {
  assert.throws(() => buildIdentityRelationshipContext({ tenantId: 'tenant-1', subjectUserId: 'user-1', actorId: 'user-2' }), error => error.code === 'IDENTITY_ACTOR_SUBJECT_MISMATCH');
  assert.throws(() => buildIdentityRelationshipContext({ tenantId: 'tenant-1', subjectUserId: 'user-1', actorType: 'agent', actorId: 'agent-a', callerAgentId: 'agent-b' }), error => error.code === 'IDENTITY_AGENT_CONTEXT_INVALID');
});
