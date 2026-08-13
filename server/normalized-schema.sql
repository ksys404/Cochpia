-- Normalized schema for the next multi-user storage stage.
-- The current application still uses cochpia_state until this migration is verified.
CREATE TABLE IF NOT EXISTS cochpia_state (
  id integer PRIMARY KEY CHECK (id = 1),
  state jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cochpia_users (
  id uuid PRIMARY KEY,
  external_id text UNIQUE NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cochpia_sessions (
  id text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES cochpia_users(id),
  title text NOT NULL,
  model_provider text NOT NULL,
  model_name text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS cochpia_messages (
  id text PRIMARY KEY,
  session_id text NOT NULL REFERENCES cochpia_sessions(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz
);

CREATE INDEX IF NOT EXISTS cochpia_messages_session_created_idx ON cochpia_messages(session_id, created_at);

CREATE TABLE IF NOT EXISTS cochpia_memories (
  id text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES cochpia_users(id),
  type text NOT NULL,
  summary text NOT NULL,
  confidence real NOT NULL,
  source text NOT NULL,
  visibility text NOT NULL,
  strength real NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS cochpia_personality_versions (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES cochpia_users(id),
  version integer NOT NULL,
  summary text NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (user_id, version)
);

CREATE TABLE IF NOT EXISTS cochpia_personality_traits (
  version_id bigint NOT NULL REFERENCES cochpia_personality_versions(id) ON DELETE CASCADE,
  trait_key text NOT NULL,
  label text NOT NULL,
  value real NOT NULL,
  PRIMARY KEY (version_id, trait_key)
);

CREATE TABLE IF NOT EXISTS cochpia_growth_evidence (
  id text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES cochpia_users(id),
  type text NOT NULL,
  claim text NOT NULL,
  evidence text NOT NULL,
  source_message_id text,
  status text NOT NULL CHECK (status IN ('draft', 'approved', 'rejected')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz
);
