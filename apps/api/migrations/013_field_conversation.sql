CREATE TABLE IF NOT EXISTS field_conversation_messages (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  field_id uuid NOT NULL REFERENCES fields(id) ON DELETE CASCADE,
  sequence integer NOT NULL CHECK (sequence > 0),
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  content text NOT NULL CHECK (char_length(content) BETWEEN 1 AND 4000),
  created_at timestamptz NOT NULL,
  UNIQUE (field_id, sequence)
);

CREATE INDEX IF NOT EXISTS field_conversation_field_sequence_idx
  ON field_conversation_messages (organization_id, field_id, sequence);

COMMENT ON TABLE field_conversation_messages IS
  'User-visible Codex conversation bound to a field and kept separate from deterministic analysis tasks.';
