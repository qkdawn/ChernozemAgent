CREATE TABLE IF NOT EXISTS variable_nitrogen_prescriptions (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  field_id uuid NOT NULL REFERENCES fields(id),
  boundary_version integer NOT NULL,
  status text NOT NULL CHECK (status = 'needs_review'),
  source_task_id uuid NOT NULL REFERENCES analysis_tasks(id),
  source_date date NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  document jsonb NOT NULL
);

CREATE INDEX IF NOT EXISTS variable_nitrogen_prescriptions_field_created_idx
  ON variable_nitrogen_prescriptions (organization_id, field_id, created_at DESC);

COMMENT ON TABLE variable_nitrogen_prescriptions IS
  'User-authored candidate variable nitrogen prescriptions derived from a selected NDVI observation.';
