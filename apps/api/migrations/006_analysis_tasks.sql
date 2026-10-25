CREATE TABLE IF NOT EXISTS analysis_tasks (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  field_id uuid NOT NULL REFERENCES fields(id),
  objective text NOT NULL CHECK (objective IN ('growth_stage_monitoring', 'water_nitrogen_diagnosis', 'waterlogging_detection', 'frost_risk_warning')),
  status text NOT NULL CHECK (status IN ('planned', 'running', 'needs_input', 'needs_data', 'needs_review', 'partial', 'completed', 'failed', 'cancelled')),
  created_at timestamptz NOT NULL,
  completed_at timestamptz,
  document jsonb NOT NULL
);

CREATE INDEX IF NOT EXISTS analysis_tasks_field_created_idx
  ON analysis_tasks (organization_id, field_id, created_at DESC);

COMMENT ON TABLE analysis_tasks IS
  'Persisted user-facing corn analysis tasks; deterministic tool results remain in analysis_results.';
