import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPostgresIndexCandidateQuery, mapPostgresIndexCandidate } from './memory-module-postgres-retrieval.js';

test('PostgreSQL lexical candidate query applies subject, lifecycle, epoch, and policy filters', () => {
  const query = buildPostgresIndexCandidateQuery({
    tenantId: 'tenant-a',
    subjectUserId: 'user-a',
    purpose: 'answer_user_query',
    query: '红茶',
    now: '2026-08-22T00:00:00.000Z',
    limit: 12
  });
  assert.equal(query.params[0], 'tenant-a');
  assert.equal(query.params[1], 'user-a');
  assert.equal(query.params.at(-1), 12);
  assert.match(query.sql, /JOIN memory_assertions/);
  assert.match(query.sql, /JOIN assertion_versions/);
  assert.match(query.sql, /redaction\.privacy_epoch/);
  assert.match(query.sql, /d\.policy_epoch/);
  assert.match(query.sql, /v\.version_status = 'current'/);
  assert.match(query.sql, /to_tsvector\('simple', d\.search_text\)/);
  assert.match(query.sql, /ILIKE/);
});

test('PostgreSQL vector candidate query hard-filters an Agent grant and uses pgvector distance', () => {
  const query = buildPostgresIndexCandidateQuery({
    tenantId: 'tenant-a',
    subjectUserId: 'user-a',
    actorType: 'agent',
    callerAgentId: 'agent-a',
    sessionId: 'session-a',
    purpose: 'profile_view',
    query: 'preference',
    queryVector: [1, 0],
    mode: 'vector'
  });
  assert.ok(query.params.includes('agent-a'));
  assert.ok(query.params.includes('[1,0]'));
  assert.match(query.sql, /scope_grants/);
  assert.match(query.sql, /permissions @> ARRAY/);
  assert.match(query.sql, /embedding_vector <=>/);
  assert.match(query.sql, /d\.embedding_vector IS NOT NULL/);
});

test('native candidate rows preserve assertion and version evidence', () => {
  const item = mapPostgresIndexCandidate({
    document_id: 'doc-a',
    tenant_id: 'tenant-a',
    user_id: 'user-a',
    memory_id: 'memory-a',
    version_id: 'version-a',
    source_refs: ['event-a'],
    scope_type: 'user',
    assertion_status: 'active',
    memory_type: 'preference',
    assertion_type: 'observed_fact',
    canonical_key: 'drink',
    subject_type: 'user',
    subject_id: 'user-a',
    sensitivity: 'S0',
    confidence: '0.9',
    importance: '0.5',
    mention_policy: 'mentionable',
    direct_query_policy: 'allow',
    resource_revision: '2',
    content: '喜欢红茶',
    structured_data: { value: 'tea' },
    content_type: 'plain_text',
    trust_level: 'user_explicit',
    version_status: 'current',
    candidate_score: '0.8'
  });
  assert.equal(item.memoryId, 'memory-a');
  assert.equal(item.score, 0.8);
  assert.equal(item.assertion.confidence, 0.9);
  assert.equal(item.version.content, '喜欢红茶');
  assert.deepEqual(item.sourceRefs, ['event-a']);
});
