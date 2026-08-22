import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const schemaPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'memory-module-schema.sql');

test('Memory Module schema declares referenced tables before dependent tables', async () => {
  const schema = await readFile(schemaPath, 'utf8');
  const position = name => schema.indexOf(`CREATE TABLE IF NOT EXISTS ${name}`);
  assert.ok(position('memory_sessions') >= 0);
  assert.ok(position('raw_events') > position('memory_sessions'));
  assert.ok(position('memory_assertions') > position('memory_sessions'));
  assert.ok(position('assertion_versions') > position('memory_assertions'));
  assert.ok(position('profile_snapshots') > position('assertion_versions'));
  assert.ok(position('profile_snapshot_items') > position('profile_snapshots'));
  assert.ok(position('profile_projection_sources') > position('profile_projection_items'));
  assert.ok(position('current_states') > position('memory_sessions'));
  assert.ok(position('current_state_sources') > position('current_states'));
  assert.ok(position('confirmation_requests') > position('assertion_versions'));
  assert.ok(position('pins') > position('assertion_versions'));
  assert.ok(position('memory_mention_cooldowns') > position('assertion_versions'));
  assert.ok(schema.indexOf('memory_assertions_current_version_fk') > position('assertion_versions'));
});

test('Memory Module schema contains tenant, redaction, outbox, and idempotency controls', async () => {
  const schema = await readFile(schemaPath, 'utf8');
  for (const table of ['redaction_epochs', 'memory_commit_sequences', 'memory_outbox_events', 'memory_audit_events', 'memory_idempotency_records', 'memory_mention_cooldowns', 'current_state_sources', 'profile_projection_sources']) {
    assert.match(schema, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
  assert.match(schema, /UNIQUE \(tenant_id, user_id, event_id, source_revision\)/);
  assert.match(schema, /scope_type = 'session' AND session_id IS NOT NULL AND expires_at IS NOT NULL/);
  assert.match(schema, /lease_until timestamptz/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS memory_outbox_events[\s\S]*user_id text,[\s\S]*event_type text/);
  assert.match(schema, /consumer_name text NOT NULL DEFAULT 'memory-derived'/);
  assert.match(schema, /memory_outbox_subject_pending_idx/);
  assert.match(schema, /index_documents_search_tsv_idx/);
  assert.match(schema, /index_documents_search_trgm_idx/);
  assert.match(schema, /UNIQUE \(tenant_id, user_id, mutation_namespace, idempotency_key\)/);
  assert.match(schema, /resource_type text/);
  assert.match(schema, /resource_id text/);
  assert.match(schema, /response_contains_content boolean/);
  assert.match(schema, /expires_at timestamptz/);
  assert.match(schema, /memory_mention_cooldowns[\s\S]*UNIQUE \(tenant_id, user_id, actor_id, memory_id, topic_key\)/);
  assert.match(schema, /mention_cooldown_memory_subject_fk/);
  assert.match(schema, /embedding jsonb/);
  assert.match(schema, /metadata jsonb/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS assertion_versions[\s\S]*content_type text NOT NULL CONSTRAINT assertion_versions_content_type_check CHECK \(content_type IN \('plain_text', 'structured', 'tool_output', 'imported', 'quoted_content'\)\)/);
  assert.match(schema, /assertion_versions_content_type_check[\s\S]*DROP CONSTRAINT assertion_versions_content_type_check/);
  assert.match(schema, /ADD CONSTRAINT assertion_versions_content_type_check/);
  for (const constraint of [
    'raw_events_session_subject_fk',
    'memory_assertions_session_subject_fk',
    'profile_snapshots_session_subject_fk',
    'index_documents_session_subject_fk',
    'episodes_session_subject_fk',
    'current_states_session_subject_fk',
    'current_state_sources_state_subject_fk',
    'current_state_sources_raw_subject_fk',
    'profile_projection_sources_assertion_subject_fk',
    'profile_projection_sources_version_assertion_fk'
  ]) assert.match(schema, new RegExp(constraint));
  assert.match(schema, /profile_snapshot_items[\s\S]*user_id text NOT NULL/);
  assert.match(schema, /profile_projection_sources[\s\S]*user_id text NOT NULL/);
  assert.match(schema, /current_state_sources[\s\S]*user_id text NOT NULL/);
  assert.match(schema, /memory_validate_assertion_version_state/);
  assert.match(schema, /memory_assertions_current_version_status_guard/);
  assert.match(schema, /assertion_versions_current_status_guard/);
});
