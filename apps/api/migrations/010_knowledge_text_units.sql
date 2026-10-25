CREATE TABLE IF NOT EXISTS knowledge_text_units (
  index_run_id uuid NOT NULL,
  text_unit_id text NOT NULL CHECK (char_length(trim(text_unit_id)) BETWEEN 1 AND 240),
  source_id uuid NOT NULL,
  locator text NOT NULL CHECK (char_length(trim(locator)) BETWEEN 1 AND 240),
  excerpt text NOT NULL CHECK (char_length(trim(excerpt)) BETWEEN 1 AND 2000),
  related_entities text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (index_run_id, text_unit_id, source_id),
  FOREIGN KEY (index_run_id, source_id)
    REFERENCES knowledge_index_run_sources(index_run_id, source_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS knowledge_text_units_source_idx
  ON knowledge_text_units (source_id, index_run_id);

COMMENT ON TABLE knowledge_text_units IS
  'Citation bridge from a GraphRAG text unit to the licensed source and page or section locator used by Agent answers.';
