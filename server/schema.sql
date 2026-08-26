-- Initial PostgreSQL storage for the current aggregate state.
-- The application also runs this CREATE TABLE statement automatically.
CREATE TABLE IF NOT EXISTS cochpia_state (
  id integer PRIMARY KEY CHECK (id = 1),
  state jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cochpia_chat_stream_runs (
  user_id text NOT NULL,
  run_id text NOT NULL,
  session_id text NOT NULL,
  attempt integer NOT NULL DEFAULT 1,
  state text NOT NULL,
  events jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, run_id)
);

CREATE INDEX IF NOT EXISTS cochpia_chat_stream_runs_expiry_idx ON cochpia_chat_stream_runs (expires_at);
