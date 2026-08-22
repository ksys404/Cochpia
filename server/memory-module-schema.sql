-- Cochpia Memory Module V1 canonical schema.
-- PostgreSQL is the source of truth. Search indexes and caches are rebuildable derivatives.

CREATE TABLE IF NOT EXISTS memory_sessions (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  caller_agent_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'closed', 'expired')),
  started_at timestamptz NOT NULL,
  closed_at timestamptz,
  expires_at timestamptz NOT NULL,
  profile_snapshot_id text NOT NULL,
  grant_version bigint NOT NULL DEFAULT 0,
  privacy_epoch bigint NOT NULL DEFAULT 0,
  resource_revision bigint NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, user_id, id)
);

CREATE INDEX IF NOT EXISTS memory_sessions_user_idx ON memory_sessions (tenant_id, user_id, status, expires_at);

CREATE TABLE IF NOT EXISTS raw_events (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  event_id text NOT NULL,
  source_revision text NOT NULL,
  session_id text,
  turn_id text,
  sequence_no bigint,
  event_role text NOT NULL CHECK (event_role IN ('user', 'agent', 'system', 'tool', 'imported')),
  content_type text NOT NULL CHECK (content_type IN ('plain_text', 'structured', 'tool_output', 'imported')),
  content text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL,
  is_stream_final boolean NOT NULL DEFAULT true,
  retention_policy text NOT NULL,
  delete_after timestamptz NOT NULL,
  commit_seq bigint NOT NULL,
  resource_revision bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id, event_id, source_revision),
  CONSTRAINT raw_events_subject_key UNIQUE (tenant_id, id, user_id),
  CONSTRAINT raw_events_session_subject_fk FOREIGN KEY (tenant_id, user_id, session_id) REFERENCES memory_sessions (tenant_id, user_id, id)
);

CREATE INDEX IF NOT EXISTS raw_events_user_time_idx ON raw_events (tenant_id, user_id, occurred_at DESC);

ALTER TABLE raw_events ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE raw_events ADD COLUMN IF NOT EXISTS resource_revision bigint NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS memory_assertions (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  scope_type text NOT NULL CHECK (scope_type IN ('user', 'relationship', 'session')),
  relationship_agent_id text,
  session_id text,
  memory_type text NOT NULL,
  assertion_type text NOT NULL CHECK (assertion_type IN ('observed_fact', 'inferred_fact', 'relationship_signal')),
  canonical_key text NOT NULL,
  status text NOT NULL CHECK (status IN ('candidate', 'pending_confirmation', 'active', 'rejected', 'superseded', 'expired', 'revoked', 'forgotten')),
  subject_type text NOT NULL CHECK (subject_type IN ('user', 'agent', 'third_party')),
  subject_id text NOT NULL,
  sensitivity text NOT NULL CHECK (sensitivity IN ('S0', 'S1', 'S2', 'S3')),
  confidence real NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  importance real NOT NULL CHECK (importance >= 0 AND importance <= 1),
  retention_policy text NOT NULL,
  recall_policy text NOT NULL,
  auto_recall_allowed boolean NOT NULL DEFAULT false,
  mention_policy text NOT NULL CHECK (mention_policy IN ('mentionable', 'contextualizable_only', 'do_not_mention')),
  direct_query_policy text NOT NULL CHECK (direct_query_policy IN ('allow', 'require_confirmation', 'deny')),
  expires_at timestamptz,
  current_version_id text,
  resource_revision bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CONSTRAINT memory_assertions_subject_key UNIQUE (tenant_id, id, user_id),
  UNIQUE (tenant_id, id, current_version_id),
  CHECK (
    (scope_type = 'user' AND relationship_agent_id IS NULL AND session_id IS NULL)
    OR (scope_type = 'relationship' AND relationship_agent_id IS NOT NULL AND session_id IS NULL)
    OR (scope_type = 'session' AND session_id IS NOT NULL AND expires_at IS NOT NULL)
  ),
  CONSTRAINT memory_assertions_session_subject_fk FOREIGN KEY (tenant_id, user_id, session_id) REFERENCES memory_sessions (tenant_id, user_id, id)
);

CREATE INDEX IF NOT EXISTS memory_assertions_visibility_idx ON memory_assertions (tenant_id, user_id, scope_type, status, sensitivity);
CREATE INDEX IF NOT EXISTS memory_assertions_relationship_idx ON memory_assertions (tenant_id, user_id, relationship_agent_id, status);

CREATE TABLE IF NOT EXISTS assertion_versions (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  assertion_id text NOT NULL,
  content text NOT NULL,
  structured_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  content_type text NOT NULL CONSTRAINT assertion_versions_content_type_check CHECK (content_type IN ('plain_text', 'structured', 'tool_output', 'imported', 'quoted_content')),
  trust_level text NOT NULL CHECK (trust_level IN ('user_explicit', 'user_observed', 'agent_inferred', 'tool_untrusted', 'imported')),
  observed_at timestamptz NOT NULL,
  valid_from timestamptz,
  valid_to timestamptz,
  supersedes_version_id text,
  version_status text NOT NULL CHECK (version_status IN ('proposed', 'current', 'superseded', 'invalidated')),
  created_by text NOT NULL CHECK (created_by IN ('user', 'agent', 'model', 'system', 'imported')),
  promotion_reason text NOT NULL,
  promotion_policy_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, assertion_id, id),
  FOREIGN KEY (tenant_id, assertion_id) REFERENCES memory_assertions (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, assertion_id, supersedes_version_id) REFERENCES assertion_versions (tenant_id, assertion_id, id)
);

DO $$
DECLARE
  existing_definition text;
BEGIN
  SELECT pg_get_constraintdef(oid)
    INTO existing_definition
    FROM pg_constraint
   WHERE conrelid = 'assertion_versions'::regclass
     AND conname = 'assertion_versions_content_type_check';
  IF existing_definition IS NOT NULL
     AND (existing_definition NOT LIKE '%tool_output%'
       OR existing_definition NOT LIKE '%imported%'
       OR existing_definition NOT LIKE '%quoted_content%') THEN
    ALTER TABLE assertion_versions DROP CONSTRAINT assertion_versions_content_type_check;
  END IF;
  IF existing_definition IS NULL
     OR (existing_definition NOT LIKE '%tool_output%'
       OR existing_definition NOT LIKE '%imported%'
       OR existing_definition NOT LIKE '%quoted_content%') THEN
    ALTER TABLE assertion_versions
      ADD CONSTRAINT assertion_versions_content_type_check
      CHECK (content_type IN ('plain_text', 'structured', 'tool_output', 'imported', 'quoted_content'));
  END IF;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'memory_assertions_current_version_fk'
  ) THEN
    ALTER TABLE memory_assertions
      ADD CONSTRAINT memory_assertions_current_version_fk
      FOREIGN KEY (tenant_id, id, current_version_id)
      REFERENCES assertion_versions (tenant_id, assertion_id, id)
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION memory_validate_assertion_version_state()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  assertion_status text;
  target_assertion_id text;
  current_version_id text;
  current_version_status text;
BEGIN
  IF TG_TABLE_NAME = 'memory_assertions' THEN
    target_assertion_id := NEW.id;
    SELECT assertion.status, assertion.current_version_id
      INTO assertion_status, current_version_id
      FROM memory_assertions assertion
     WHERE assertion.tenant_id = NEW.tenant_id AND assertion.id = NEW.id;
  ELSE
    target_assertion_id := NEW.assertion_id;
    SELECT assertion.status, assertion.current_version_id
      INTO assertion_status, current_version_id
      FROM memory_assertions assertion
     WHERE assertion.tenant_id = NEW.tenant_id AND assertion.id = NEW.assertion_id;
  END IF;

  IF NOT FOUND THEN RETURN NEW; END IF;
  IF current_version_id IS NULL THEN
    IF assertion_status = 'active' THEN
      RAISE EXCEPTION 'active assertion must reference a current version' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  SELECT version_status
    INTO current_version_status
   FROM assertion_versions
   WHERE tenant_id = NEW.tenant_id
     AND assertion_id = target_assertion_id
     AND id = current_version_id;
  IF current_version_status IS DISTINCT FROM 'current' THEN
    RAISE EXCEPTION 'assertion current_version_id must reference a current version' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'memory_assertions_current_version_status_guard') THEN
    CREATE CONSTRAINT TRIGGER memory_assertions_current_version_status_guard
      AFTER INSERT OR UPDATE OF status, current_version_id ON memory_assertions
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION memory_validate_assertion_version_state();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'assertion_versions_current_status_guard') THEN
    CREATE CONSTRAINT TRIGGER assertion_versions_current_status_guard
      AFTER INSERT OR UPDATE OF version_status, assertion_id ON assertion_versions
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION memory_validate_assertion_version_state();
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS assertion_versions_current_idx ON assertion_versions (tenant_id, assertion_id, version_status);

CREATE TABLE IF NOT EXISTS profile_snapshots (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  session_id text NOT NULL,
  grant_version bigint NOT NULL DEFAULT 0,
  privacy_epoch bigint NOT NULL DEFAULT 0,
  resource_revision bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CONSTRAINT profile_snapshots_subject_key UNIQUE (tenant_id, id, user_id),
  CONSTRAINT profile_snapshots_session_subject_fk FOREIGN KEY (tenant_id, user_id, session_id) REFERENCES memory_sessions (tenant_id, user_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS profile_snapshot_items (
  tenant_id text NOT NULL,
  snapshot_id text NOT NULL,
  user_id text NOT NULL,
  assertion_id text NOT NULL,
  version_id text NOT NULL,
  scope_type text NOT NULL CHECK (scope_type IN ('user', 'relationship')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, snapshot_id, assertion_id),
  CONSTRAINT profile_snapshot_items_snapshot_subject_fk FOREIGN KEY (tenant_id, snapshot_id, user_id) REFERENCES profile_snapshots (tenant_id, id, user_id) ON DELETE CASCADE,
  CONSTRAINT profile_snapshot_items_assertion_subject_fk FOREIGN KEY (tenant_id, assertion_id, user_id) REFERENCES memory_assertions (tenant_id, id, user_id),
  CONSTRAINT profile_snapshot_items_version_assertion_fk FOREIGN KEY (tenant_id, assertion_id, version_id) REFERENCES assertion_versions (tenant_id, assertion_id, id)
);

CREATE INDEX IF NOT EXISTS profile_snapshot_items_lookup_idx ON profile_snapshot_items (tenant_id, snapshot_id);

CREATE TABLE IF NOT EXISTS profile_projections (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  scope_type text NOT NULL CHECK (scope_type IN ('user', 'relationship')),
  relationship_agent_id text,
  projection_type text NOT NULL,
  source_commit_seq bigint NOT NULL,
  promotion_policy_version text NOT NULL,
  model_version text NOT NULL,
  status text NOT NULL CHECK (status IN ('building', 'active', 'superseded', 'invalidated')),
  created_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz,
  resource_revision bigint NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  CONSTRAINT profile_projections_subject_key UNIQUE (tenant_id, id, user_id)
);

CREATE TABLE IF NOT EXISTS profile_projection_items (
  tenant_id text NOT NULL,
  projection_id text NOT NULL,
  user_id text NOT NULL,
  assertion_id text NOT NULL,
  version_id text NOT NULL,
  display_text text NOT NULL,
  structured_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_refs text[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, projection_id, assertion_id),
  CONSTRAINT profile_projection_items_projection_subject_fk FOREIGN KEY (tenant_id, projection_id, user_id) REFERENCES profile_projections (tenant_id, id, user_id) ON DELETE CASCADE,
  CONSTRAINT profile_projection_items_assertion_subject_fk FOREIGN KEY (tenant_id, assertion_id, user_id) REFERENCES memory_assertions (tenant_id, id, user_id),
  CONSTRAINT profile_projection_items_version_assertion_fk FOREIGN KEY (tenant_id, assertion_id, version_id) REFERENCES assertion_versions (tenant_id, assertion_id, id)
);

CREATE TABLE IF NOT EXISTS profile_projection_sources (
  tenant_id text NOT NULL,
  projection_id text NOT NULL,
  user_id text NOT NULL,
  assertion_id text NOT NULL,
  version_id text NOT NULL,
  source_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, projection_id, assertion_id, version_id, source_id),
  CONSTRAINT profile_projection_sources_projection_subject_fk FOREIGN KEY (tenant_id, projection_id, user_id) REFERENCES profile_projections (tenant_id, id, user_id) ON DELETE CASCADE,
  CONSTRAINT profile_projection_sources_assertion_subject_fk FOREIGN KEY (tenant_id, assertion_id, user_id) REFERENCES memory_assertions (tenant_id, id, user_id) ON DELETE CASCADE,
  CONSTRAINT profile_projection_sources_version_assertion_fk FOREIGN KEY (tenant_id, assertion_id, version_id) REFERENCES assertion_versions (tenant_id, assertion_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS profile_projection_sources_lookup_idx ON profile_projection_sources (tenant_id, projection_id, assertion_id);

CREATE TABLE IF NOT EXISTS index_documents (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  source_type text NOT NULL,
  source_id text NOT NULL,
  source_version text NOT NULL,
  user_id text NOT NULL,
  scope_type text NOT NULL CHECK (scope_type IN ('user', 'relationship', 'session')),
  relationship_agent_id text,
  session_id text,
  search_text text NOT NULL,
  sensitivity text NOT NULL CHECK (sensitivity IN ('S0', 'S1', 'S2')),
  contextualizable boolean NOT NULL,
  mentionable boolean NOT NULL,
  redaction_epoch bigint NOT NULL,
  policy_epoch text NOT NULL,
  grant_version bigint NOT NULL,
  embedding jsonb,
  embedding_version text,
  lexical_version text NOT NULL,
  index_status text NOT NULL CHECK (index_status IN ('building', 'active', 'stale', 'invalidated')),
  source_refs text[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, source_type, source_id, source_version),
  CONSTRAINT index_documents_session_subject_fk FOREIGN KEY (tenant_id, user_id, session_id) REFERENCES memory_sessions (tenant_id, user_id, id)
);

CREATE INDEX IF NOT EXISTS index_documents_filter_idx ON index_documents (tenant_id, user_id, scope_type, index_status, sensitivity);

-- Native lexical retrieval must not fall back to a full table scan at scale.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS index_documents_search_tsv_idx
  ON index_documents USING gin (to_tsvector('simple', search_text))
  WHERE index_status = 'active';
CREATE INDEX IF NOT EXISTS index_documents_search_trgm_idx
  ON index_documents USING gin (search_text gin_trgm_ops)
  WHERE index_status = 'active';

CREATE TABLE IF NOT EXISTS episodes (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  scope_type text NOT NULL CHECK (scope_type IN ('user', 'relationship', 'session')),
  relationship_agent_id text,
  session_id text,
  title text NOT NULL,
  summary text NOT NULL,
  observed_start timestamptz NOT NULL,
  observed_end timestamptz NOT NULL,
  grouping_rule_version text NOT NULL,
  summary_model_version text NOT NULL,
  status text NOT NULL CHECK (status IN ('building', 'active', 'superseded', 'invalidated')),
  resource_revision bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CONSTRAINT episodes_session_subject_fk FOREIGN KEY (tenant_id, user_id, session_id) REFERENCES memory_sessions (tenant_id, user_id, id)
);

CREATE TABLE IF NOT EXISTS episode_members (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  episode_id text NOT NULL,
  raw_event_id text,
  assertion_version_id text,
  member_role text NOT NULL,
  join_reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, episode_id, raw_event_id, assertion_version_id),
  FOREIGN KEY (tenant_id, episode_id) REFERENCES episodes (tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS episodes_lookup_idx ON episodes (tenant_id, user_id, scope_type, status, observed_start DESC);

CREATE TABLE IF NOT EXISTS assertion_version_sources (
  tenant_id text NOT NULL,
  version_id text NOT NULL,
  source_type text NOT NULL CHECK (source_type IN ('raw_event', 'explicit_request', 'correction_request', 'imported')),
  source_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, version_id, source_type, source_id),
  FOREIGN KEY (tenant_id, version_id) REFERENCES assertion_versions (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS current_states (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  agent_id text NOT NULL,
  session_id text NOT NULL,
  state_type text NOT NULL,
  value text NOT NULL,
  confidence real NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  expires_at timestamptz NOT NULL,
  allow_persist boolean NOT NULL DEFAULT false,
  requires_confirmation boolean NOT NULL DEFAULT false,
  promoted_from text,
  promotion_actor text,
  status text NOT NULL CHECK (status IN ('active', 'expired', 'revoked', 'forgotten')),
  resource_revision bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CONSTRAINT current_states_subject_key UNIQUE (tenant_id, id, user_id),
  CONSTRAINT current_states_session_subject_fk FOREIGN KEY (tenant_id, user_id, session_id) REFERENCES memory_sessions (tenant_id, user_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS current_states_active_idx ON current_states (tenant_id, user_id, session_id, status, expires_at);

CREATE TABLE IF NOT EXISTS current_state_sources (
  tenant_id text NOT NULL,
  current_state_id text NOT NULL,
  user_id text NOT NULL,
  raw_event_id text NOT NULL,
  source_role text NOT NULL DEFAULT 'observed',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, current_state_id, raw_event_id),
  CONSTRAINT current_state_sources_state_subject_fk FOREIGN KEY (tenant_id, current_state_id, user_id) REFERENCES current_states (tenant_id, id, user_id) ON DELETE CASCADE,
  CONSTRAINT current_state_sources_raw_subject_fk FOREIGN KEY (tenant_id, raw_event_id, user_id) REFERENCES raw_events (tenant_id, id, user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS current_state_sources_lookup_idx ON current_state_sources (tenant_id, current_state_id);

CREATE TABLE IF NOT EXISTS scope_grants (
  grant_id text PRIMARY KEY,
  tenant_id text NOT NULL,
  subject_user_id text NOT NULL,
  grantee_type text NOT NULL CHECK (grantee_type IN ('agent', 'user', 'service')),
  grantee_id text NOT NULL,
  scope_type text NOT NULL CHECK (scope_type IN ('user', 'relationship', 'session')),
  permissions text[] NOT NULL,
  purpose text NOT NULL,
  issuer text NOT NULL,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz,
  revoked_at timestamptz,
  grant_version bigint NOT NULL,
  resource_revision bigint NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, grant_id),
  CHECK (cardinality(permissions) > 0),
  CHECK (scope_type <> 'relationship' OR grantee_type = 'agent')
);

CREATE INDEX IF NOT EXISTS scope_grants_lookup_idx ON scope_grants (tenant_id, subject_user_id, grantee_type, grantee_id, scope_type);

CREATE TABLE IF NOT EXISTS confirmation_requests (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  candidate_assertion_id text NOT NULL,
  candidate_version_id text NOT NULL,
  proposed_content text NOT NULL,
  structured_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  scope_type text NOT NULL CHECK (scope_type IN ('user', 'relationship', 'session')),
  relationship_agent_id text,
  session_id text,
  sensitivity text NOT NULL CHECK (sensitivity IN ('S0', 'S1', 'S2', 'S3')),
  retention_policy text NOT NULL,
  mention_policy text NOT NULL,
  resource_revision bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'confirmed', 'rejected', 'expired', 'superseded')),
  decided_by text,
  decided_at timestamptz,
  UNIQUE (tenant_id, id),
  CONSTRAINT confirmation_candidate_subject_fk FOREIGN KEY (tenant_id, candidate_assertion_id, user_id) REFERENCES memory_assertions (tenant_id, id, user_id) ON DELETE CASCADE,
  CONSTRAINT confirmation_candidate_version_fk FOREIGN KEY (tenant_id, candidate_assertion_id, candidate_version_id) REFERENCES assertion_versions (tenant_id, assertion_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS access_confirmations (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  actor_id text NOT NULL,
  caller_agent_id text,
  session_id text,
  purpose text NOT NULL CHECK (purpose IN ('answer_user_query', 'profile_view', 'governance')),
  memory_ids text[] NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'confirmed', 'expired', 'consumed')),
  token text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  confirmed_at timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (token)
);

CREATE INDEX IF NOT EXISTS access_confirmations_lookup_idx ON access_confirmations (tenant_id, user_id, actor_id, status, expires_at);

CREATE TABLE IF NOT EXISTS memory_mention_cooldowns (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  actor_id text NOT NULL,
  caller_agent_id text,
  memory_id text NOT NULL,
  topic_key text NOT NULL DEFAULT '',
  last_mentioned_at timestamptz NOT NULL,
  cooldown_until timestamptz NOT NULL,
  resource_revision bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id, actor_id, memory_id, topic_key),
  CONSTRAINT mention_cooldown_memory_subject_fk FOREIGN KEY (tenant_id, memory_id, user_id) REFERENCES memory_assertions (tenant_id, id, user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS memory_mention_cooldowns_lookup_idx
  ON memory_mention_cooldowns (tenant_id, user_id, actor_id, memory_id, topic_key, cooldown_until);

CREATE TABLE IF NOT EXISTS pins (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  assertion_id text NOT NULL,
  pinned_version_id text NOT NULL,
  follow_current boolean NOT NULL DEFAULT false,
  scope_type text NOT NULL CHECK (scope_type IN ('user', 'relationship', 'session')),
  resource_revision bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  UNIQUE (tenant_id, assertion_id),
  CONSTRAINT pin_assertion_subject_fk FOREIGN KEY (tenant_id, assertion_id, user_id) REFERENCES memory_assertions (tenant_id, id, user_id) ON DELETE CASCADE,
  CONSTRAINT pin_version_assertion_fk FOREIGN KEY (tenant_id, assertion_id, pinned_version_id) REFERENCES assertion_versions (tenant_id, assertion_id, id)
);

CREATE TABLE IF NOT EXISTS deletion_operations (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  subject_user_id text NOT NULL,
  target_type text NOT NULL CHECK (target_type IN ('memory', 'source_event', 'session', 'relationship', 'account')),
  target_id text NOT NULL,
  requested_scope jsonb NOT NULL,
  action text NOT NULL CHECK (action IN ('forget', 'delete')),
  status text NOT NULL CHECK (status IN ('accepted', 'canonical_hidden', 'propagating', 'completed', 'failed')),
  requested_by text NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  canonical_hidden_at timestamptz,
  completed_at timestamptz,
  redaction_epoch bigint NOT NULL,
  last_error_code text,
  resource_revision bigint NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS memory_tombstones (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  target_type text NOT NULL,
  target_id text NOT NULL,
  action text NOT NULL CHECK (action IN ('forget', 'delete')),
  redaction_epoch bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, target_type, target_id, action, redaction_epoch)
);

CREATE TABLE IF NOT EXISTS redaction_epochs (
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  privacy_epoch bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);

CREATE TABLE IF NOT EXISTS memory_commit_sequences (
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  commit_seq bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);

CREATE TABLE IF NOT EXISTS memory_outbox_events (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  user_id text,
  consumer_name text NOT NULL DEFAULT 'memory-derived',
  event_type text NOT NULL,
  aggregate_id text NOT NULL,
  schema_version integer NOT NULL,
  commit_seq bigint NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'processing', 'completed', 'dead_letter')),
  lease_owner text,
  lease_until timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz
);

ALTER TABLE memory_outbox_events ADD COLUMN IF NOT EXISTS lease_owner text;
ALTER TABLE memory_outbox_events ADD COLUMN IF NOT EXISTS lease_until timestamptz;
ALTER TABLE memory_outbox_events ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;
ALTER TABLE memory_outbox_events ADD COLUMN IF NOT EXISTS last_error_code text;
ALTER TABLE memory_outbox_events ADD COLUMN IF NOT EXISTS user_id text;
ALTER TABLE memory_outbox_events ADD COLUMN IF NOT EXISTS consumer_name text NOT NULL DEFAULT 'memory-derived';
ALTER TABLE index_documents ADD COLUMN IF NOT EXISTS embedding jsonb;

CREATE INDEX IF NOT EXISTS memory_outbox_pending_idx ON memory_outbox_events (status, created_at);
CREATE INDEX IF NOT EXISTS memory_outbox_subject_pending_idx ON memory_outbox_events (tenant_id, user_id, status, created_at);

CREATE TABLE IF NOT EXISTS memory_audit_events (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  subject_user_id text,
  actor_id text NOT NULL,
  action text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS memory_idempotency_records (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  mutation_namespace text NOT NULL DEFAULT 'event',
  idempotency_key text NOT NULL,
  request_fingerprint text NOT NULL,
  response jsonb NOT NULL,
  result text,
  content_length integer,
  content_type text,
  resource_type text,
  resource_id text,
  response_contains_content boolean NOT NULL DEFAULT false,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id, mutation_namespace, idempotency_key)
);

ALTER TABLE memory_idempotency_records ADD COLUMN IF NOT EXISTS mutation_namespace text NOT NULL DEFAULT 'event';
ALTER TABLE memory_idempotency_records ADD COLUMN IF NOT EXISTS result text;
ALTER TABLE memory_idempotency_records ADD COLUMN IF NOT EXISTS content_length integer;
ALTER TABLE memory_idempotency_records ADD COLUMN IF NOT EXISTS content_type text;
ALTER TABLE memory_idempotency_records ADD COLUMN IF NOT EXISTS resource_type text;
ALTER TABLE memory_idempotency_records ADD COLUMN IF NOT EXISTS resource_id text;
ALTER TABLE memory_idempotency_records ADD COLUMN IF NOT EXISTS response_contains_content boolean NOT NULL DEFAULT false;
ALTER TABLE memory_idempotency_records ADD COLUMN IF NOT EXISTS expires_at timestamptz;
ALTER TABLE memory_idempotency_records DROP CONSTRAINT IF EXISTS memory_idempotency_records_tenant_id_user_id_idempotency_key_key;
CREATE UNIQUE INDEX IF NOT EXISTS memory_idempotency_scope_key_idx
  ON memory_idempotency_records (tenant_id, user_id, mutation_namespace, idempotency_key);

-- Subject-bound foreign keys are also applied to installations created before
-- the normalized source relations were introduced. Existing rows are backfilled
-- from their canonical parent before the new NOT NULL/FOREIGN KEY constraints.
ALTER TABLE profile_snapshot_items ADD COLUMN IF NOT EXISTS user_id text;
UPDATE profile_snapshot_items item
SET user_id = snapshot.user_id
FROM profile_snapshots snapshot
WHERE snapshot.tenant_id = item.tenant_id
  AND snapshot.id = item.snapshot_id
  AND item.user_id IS NULL;
ALTER TABLE profile_snapshot_items ALTER COLUMN user_id SET NOT NULL;

ALTER TABLE profile_projection_sources ADD COLUMN IF NOT EXISTS user_id text;
UPDATE profile_projection_sources source
SET user_id = projection.user_id
FROM profile_projections projection
WHERE projection.tenant_id = source.tenant_id
  AND projection.id = source.projection_id
  AND source.user_id IS NULL;
ALTER TABLE profile_projection_sources ALTER COLUMN user_id SET NOT NULL;

ALTER TABLE current_state_sources ADD COLUMN IF NOT EXISTS user_id text;
UPDATE current_state_sources source
SET user_id = current_state.user_id
FROM current_states current_state
WHERE current_state.tenant_id = source.tenant_id
  AND current_state.id = source.current_state_id
  AND source.user_id IS NULL;
ALTER TABLE current_state_sources ALTER COLUMN user_id SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'raw_events_subject_key') THEN
    ALTER TABLE raw_events ADD CONSTRAINT raw_events_subject_key UNIQUE (tenant_id, id, user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'memory_assertions_subject_key') THEN
    ALTER TABLE memory_assertions ADD CONSTRAINT memory_assertions_subject_key UNIQUE (tenant_id, id, user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'profile_snapshots_subject_key') THEN
    ALTER TABLE profile_snapshots ADD CONSTRAINT profile_snapshots_subject_key UNIQUE (tenant_id, id, user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'profile_projections_subject_key') THEN
    ALTER TABLE profile_projections ADD CONSTRAINT profile_projections_subject_key UNIQUE (tenant_id, id, user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'current_states_subject_key') THEN
    ALTER TABLE current_states ADD CONSTRAINT current_states_subject_key UNIQUE (tenant_id, id, user_id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'raw_events_session_subject_fk') THEN
    ALTER TABLE raw_events ADD CONSTRAINT raw_events_session_subject_fk
      FOREIGN KEY (tenant_id, user_id, session_id) REFERENCES memory_sessions (tenant_id, user_id, id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'memory_assertions_session_subject_fk') THEN
    ALTER TABLE memory_assertions ADD CONSTRAINT memory_assertions_session_subject_fk
      FOREIGN KEY (tenant_id, user_id, session_id) REFERENCES memory_sessions (tenant_id, user_id, id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'profile_snapshots_session_subject_fk') THEN
    ALTER TABLE profile_snapshots ADD CONSTRAINT profile_snapshots_session_subject_fk
      FOREIGN KEY (tenant_id, user_id, session_id) REFERENCES memory_sessions (tenant_id, user_id, id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'index_documents_session_subject_fk') THEN
    ALTER TABLE index_documents ADD CONSTRAINT index_documents_session_subject_fk
      FOREIGN KEY (tenant_id, user_id, session_id) REFERENCES memory_sessions (tenant_id, user_id, id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'episodes_session_subject_fk') THEN
    ALTER TABLE episodes ADD CONSTRAINT episodes_session_subject_fk
      FOREIGN KEY (tenant_id, user_id, session_id) REFERENCES memory_sessions (tenant_id, user_id, id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'current_states_session_subject_fk') THEN
    ALTER TABLE current_states ADD CONSTRAINT current_states_session_subject_fk
      FOREIGN KEY (tenant_id, user_id, session_id) REFERENCES memory_sessions (tenant_id, user_id, id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'profile_snapshot_items_snapshot_subject_fk') THEN
    ALTER TABLE profile_snapshot_items ADD CONSTRAINT profile_snapshot_items_snapshot_subject_fk
      FOREIGN KEY (tenant_id, snapshot_id, user_id) REFERENCES profile_snapshots (tenant_id, id, user_id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'profile_snapshot_items_assertion_subject_fk') THEN
    ALTER TABLE profile_snapshot_items ADD CONSTRAINT profile_snapshot_items_assertion_subject_fk
      FOREIGN KEY (tenant_id, assertion_id, user_id) REFERENCES memory_assertions (tenant_id, id, user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'profile_snapshot_items_version_assertion_fk') THEN
    ALTER TABLE profile_snapshot_items ADD CONSTRAINT profile_snapshot_items_version_assertion_fk
      FOREIGN KEY (tenant_id, assertion_id, version_id) REFERENCES assertion_versions (tenant_id, assertion_id, id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'profile_projection_items_projection_subject_fk') THEN
    ALTER TABLE profile_projection_items ADD CONSTRAINT profile_projection_items_projection_subject_fk
      FOREIGN KEY (tenant_id, projection_id, user_id) REFERENCES profile_projections (tenant_id, id, user_id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'profile_projection_items_assertion_subject_fk') THEN
    ALTER TABLE profile_projection_items ADD CONSTRAINT profile_projection_items_assertion_subject_fk
      FOREIGN KEY (tenant_id, assertion_id, user_id) REFERENCES memory_assertions (tenant_id, id, user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'profile_projection_items_version_assertion_fk') THEN
    ALTER TABLE profile_projection_items ADD CONSTRAINT profile_projection_items_version_assertion_fk
      FOREIGN KEY (tenant_id, assertion_id, version_id) REFERENCES assertion_versions (tenant_id, assertion_id, id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'profile_projection_sources_projection_subject_fk') THEN
    ALTER TABLE profile_projection_sources ADD CONSTRAINT profile_projection_sources_projection_subject_fk
      FOREIGN KEY (tenant_id, projection_id, user_id) REFERENCES profile_projections (tenant_id, id, user_id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'profile_projection_sources_assertion_subject_fk') THEN
    ALTER TABLE profile_projection_sources ADD CONSTRAINT profile_projection_sources_assertion_subject_fk
      FOREIGN KEY (tenant_id, assertion_id, user_id) REFERENCES memory_assertions (tenant_id, id, user_id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'profile_projection_sources_version_assertion_fk') THEN
    ALTER TABLE profile_projection_sources ADD CONSTRAINT profile_projection_sources_version_assertion_fk
      FOREIGN KEY (tenant_id, assertion_id, version_id) REFERENCES assertion_versions (tenant_id, assertion_id, id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'current_state_sources_state_subject_fk') THEN
    ALTER TABLE current_state_sources ADD CONSTRAINT current_state_sources_state_subject_fk
      FOREIGN KEY (tenant_id, current_state_id, user_id) REFERENCES current_states (tenant_id, id, user_id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'current_state_sources_raw_subject_fk') THEN
    ALTER TABLE current_state_sources ADD CONSTRAINT current_state_sources_raw_subject_fk
      FOREIGN KEY (tenant_id, raw_event_id, user_id) REFERENCES raw_events (tenant_id, id, user_id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'confirmation_candidate_subject_fk') THEN
    ALTER TABLE confirmation_requests ADD CONSTRAINT confirmation_candidate_subject_fk
      FOREIGN KEY (tenant_id, candidate_assertion_id, user_id) REFERENCES memory_assertions (tenant_id, id, user_id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'confirmation_candidate_version_fk') THEN
    ALTER TABLE confirmation_requests ADD CONSTRAINT confirmation_candidate_version_fk
      FOREIGN KEY (tenant_id, candidate_assertion_id, candidate_version_id) REFERENCES assertion_versions (tenant_id, assertion_id, id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pin_assertion_subject_fk') THEN
    ALTER TABLE pins ADD CONSTRAINT pin_assertion_subject_fk
      FOREIGN KEY (tenant_id, assertion_id, user_id) REFERENCES memory_assertions (tenant_id, id, user_id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pin_version_assertion_fk') THEN
    ALTER TABLE pins ADD CONSTRAINT pin_version_assertion_fk
      FOREIGN KEY (tenant_id, assertion_id, pinned_version_id) REFERENCES assertion_versions (tenant_id, assertion_id, id);
  END IF;
END $$;
