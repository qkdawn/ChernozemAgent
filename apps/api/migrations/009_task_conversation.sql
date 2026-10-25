CREATE TABLE IF NOT EXISTS task_conversation_messages (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  task_id uuid NOT NULL REFERENCES analysis_tasks(id) ON DELETE CASCADE,
  sequence integer NOT NULL CHECK (sequence > 0),
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  kind text NOT NULL CHECK (kind IN ('analysis_result', 'chat')),
  content text NOT NULL CHECK (char_length(content) BETWEEN 1 AND 4000),
  created_at timestamptz NOT NULL,
  UNIQUE (task_id, sequence)
);

CREATE UNIQUE INDEX IF NOT EXISTS task_conversation_initial_idx
  ON task_conversation_messages (task_id)
  WHERE kind = 'analysis_result';

CREATE INDEX IF NOT EXISTS task_conversation_task_sequence_idx
  ON task_conversation_messages (organization_id, task_id, sequence);

COMMENT ON TABLE task_conversation_messages IS
  'User-visible messages attached to one immutable analysis task; system prompts and provider payloads are not stored.';
