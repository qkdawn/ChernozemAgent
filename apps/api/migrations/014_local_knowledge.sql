-- Extractive retrieval is an explicit engine, independent of GraphRAG runs.
CREATE TABLE IF NOT EXISTS knowledge_local_indexes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pack_id text NOT NULL,
  fingerprint text NOT NULL UNIQUE CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  engine_version text NOT NULL,
  manifest jsonb NOT NULL,
  passage_count integer NOT NULL CHECK (passage_count > 0),
  published_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS knowledge_local_passages (
  index_id uuid NOT NULL REFERENCES knowledge_local_indexes(id) ON DELETE CASCADE,
  passage_id text NOT NULL,
  source_id uuid NOT NULL REFERENCES knowledge_sources(id) ON DELETE RESTRICT,
  source_version text NOT NULL,
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  locator text NOT NULL,
  excerpt text NOT NULL CHECK (char_length(excerpt) BETWEEN 1 AND 1800),
  keywords text[] NOT NULL,
  applicability_note text NOT NULL,
  PRIMARY KEY (index_id, passage_id)
);
CREATE INDEX IF NOT EXISTS knowledge_local_passages_source_idx
  ON knowledge_local_passages(index_id, source_id);
COMMENT ON TABLE knowledge_local_indexes IS
  'Atomically published, hashed original-text collections; no generated answer or model dependency.';
