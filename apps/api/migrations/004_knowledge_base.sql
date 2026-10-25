CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS knowledge_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL CHECK (char_length(trim(title)) BETWEEN 1 AND 240),
  source_type text NOT NULL
    CHECK (source_type IN ('standard', 'extension_guidance', 'paper', 'book', 'station_material', 'product_documentation')),
  crop text,
  regions text[] NOT NULL DEFAULT '{}',
  varieties text[] NOT NULL DEFAULT '{}',
  stages text[] NOT NULL DEFAULT '{}',
  capabilities text[] NOT NULL DEFAULT '{}',
  authors text[] NOT NULL DEFAULT '{}',
  publisher text,
  source_url text,
  identifier_type text CHECK (identifier_type IN ('doi', 'isbn', 'standard', 'internal')),
  identifier text,
  publication_year integer CHECK (publication_year BETWEEN 1800 AND 2100),
  version text NOT NULL,
  effective_at date,
  license_status text NOT NULL
    CHECK (license_status IN ('public', 'licensed', 'citation_only', 'internal_authorized')),
  status text NOT NULL DEFAULT 'catalogued'
    CHECK (status IN ('catalogued', 'draft', 'published', 'archived')),
  content_ref text,
  content_sha256 text CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((identifier_type IS NULL) = (identifier IS NULL)),
  CHECK ((content_ref IS NULL) = (content_sha256 IS NULL)),
  CHECK (status <> 'published' OR content_ref IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS knowledge_sources_identifier_version_uidx
  ON knowledge_sources (identifier_type, identifier, version)
  WHERE identifier IS NOT NULL;
CREATE INDEX IF NOT EXISTS knowledge_sources_scope_idx
  ON knowledge_sources (status, crop, source_type);
CREATE INDEX IF NOT EXISTS knowledge_sources_regions_gin
  ON knowledge_sources USING gin (regions);
CREATE INDEX IF NOT EXISTS knowledge_sources_capabilities_gin
  ON knowledge_sources USING gin (capabilities);

CREATE TABLE IF NOT EXISTS knowledge_index_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  graphrag_version text NOT NULL,
  config_sha256 text NOT NULL CHECK (config_sha256 ~ '^[0-9a-f]{64}$'),
  prompt_version text NOT NULL,
  chat_model_ref text NOT NULL,
  embedding_model_ref text NOT NULL,
  source_set_sha256 text NOT NULL CHECK (source_set_sha256 ~ '^[0-9a-f]{64}$'),
  input_manifest_ref text NOT NULL,
  output_tables_ref text,
  vector_store_type text NOT NULL DEFAULT 'lancedb'
    CHECK (vector_store_type IN ('lancedb', 'azure_ai_search', 'cosmosdb', 'custom')),
  vector_store_ref text,
  status text NOT NULL
    CHECK (status IN ('planned', 'running', 'completed', 'failed')),
  started_at timestamptz,
  completed_at timestamptz,
  error jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'completed' OR (output_tables_ref IS NOT NULL AND vector_store_ref IS NOT NULL)),
  UNIQUE (graphrag_version, config_sha256, prompt_version, source_set_sha256)
);

CREATE INDEX IF NOT EXISTS knowledge_index_runs_created_idx
  ON knowledge_index_runs (created_at DESC);
CREATE INDEX IF NOT EXISTS knowledge_index_runs_completed_idx
  ON knowledge_index_runs (completed_at DESC)
  WHERE status = 'completed';

CREATE TABLE IF NOT EXISTS knowledge_index_run_sources (
  index_run_id uuid NOT NULL REFERENCES knowledge_index_runs(id) ON DELETE CASCADE,
  source_id uuid NOT NULL REFERENCES knowledge_sources(id) ON DELETE RESTRICT,
  source_version text NOT NULL,
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (index_run_id, source_id)
);

COMMENT ON TABLE knowledge_sources IS
  'Versioned and licensed source catalog for Northeast China black-soil maize knowledge.';
COMMENT ON TABLE knowledge_index_runs IS
  'Reproducible Microsoft GraphRAG indexing runs and references to Parquet and vector-store outputs.';
COMMENT ON TABLE knowledge_index_run_sources IS
  'Source snapshot used by a GraphRAG indexing run; GraphRAG graph tables remain external derived artifacts.';
