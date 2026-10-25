CREATE TABLE IF NOT EXISTS acquisition_runs (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  field_id uuid NOT NULL REFERENCES fields(id),
  boundary_version integer NOT NULL,
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  data_profile text NOT NULL,
  status text NOT NULL CHECK (status IN ('planned', 'running', 'needs_input', 'partial', 'completed', 'failed')),
  created_at timestamptz NOT NULL,
  completed_at timestamptz,
  manifest jsonb NOT NULL
);

CREATE INDEX IF NOT EXISTS acquisition_runs_field_created_idx
  ON acquisition_runs (organization_id, field_id, created_at DESC);
