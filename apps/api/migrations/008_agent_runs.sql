CREATE TABLE IF NOT EXISTS agent_runs (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  task_id uuid NOT NULL REFERENCES analysis_tasks(id) ON DELETE CASCADE,
  provider text NOT NULL,
  model_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  final_message text,
  error_message text
);

CREATE INDEX IF NOT EXISTS agent_runs_task_started_idx
  ON agent_runs (organization_id, task_id, started_at DESC);

CREATE TABLE IF NOT EXISTS agent_run_events (
  run_id uuid NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  sequence integer NOT NULL CHECK (sequence > 0),
  type text NOT NULL,
  occurred_at timestamptz NOT NULL,
  tool_call_id text,
  tool_name text,
  is_error boolean,
  result_id text,
  result_status text,
  PRIMARY KEY (run_id, sequence)
);

COMMENT ON TABLE agent_runs IS
  'Auditable workflow executions bound to one validated analysis task.';

COMMENT ON TABLE agent_run_events IS
  'Ordered workflow lifecycle and controlled-tool events; prompts and provider payloads are not stored here.';
