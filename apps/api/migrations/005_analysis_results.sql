CREATE TABLE IF NOT EXISTS analysis_results (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL,
  kind text NOT NULL,
  status text NOT NULL CHECK (status IN ('succeeded', 'partial', 'needs_input', 'needs_data', 'needs_review', 'failed')),
  tool_version text NOT NULL,
  created_at timestamptz NOT NULL,
  result jsonb,
  document jsonb NOT NULL
);

CREATE INDEX IF NOT EXISTS analysis_results_task_kind_created_idx
  ON analysis_results (task_id, kind, created_at DESC);

COMMENT ON TABLE analysis_results IS
  'Single persisted contract for deterministic analysis tools and business assessments.';
