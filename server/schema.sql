-- Initial PostgreSQL storage for the current aggregate state.
-- The application also runs this CREATE TABLE statement automatically.
CREATE TABLE IF NOT EXISTS cochpia_state (
  id integer PRIMARY KEY CHECK (id = 1),
  state jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
