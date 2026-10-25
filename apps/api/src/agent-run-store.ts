import type { AgentEventRecord, AgentEventSink } from "@chernozem/agent-runtime";
import type { AgentRunStatus, AgentRunTrace, AgentToolRun } from "@chernozem/contracts";
import pg from "pg";

const { Pool } = pg;

export interface AgentRunStart {
  id: string;
  organizationId: string;
  taskId: string;
  provider: string;
  modelId: string;
  startedAt: string;
}

export interface AgentRunStore extends AgentEventSink {
  start(run: AgentRunStart): Promise<void>;
  complete(runId: string, finalMessage: string, completedAt: string): Promise<void>;
  fail(runId: string, errorMessage: string, completedAt: string): Promise<void>;
  getLatestForTask(taskId: string): Promise<AgentRunTrace | null>;
}

interface StoredAgentRun extends AgentRunStart {
  status: AgentRunStatus;
  completedAt: string | null;
  finalMessage: string | null;
  errorMessage: string | null;
}

export function createMemoryAgentRunStore(): AgentRunStore & { runs: Map<string, StoredAgentRun>; events: AgentEventRecord[] } {
  const runs = new Map<string, StoredAgentRun>();
  const events: AgentEventRecord[] = [];
  return {
    runs,
    events,
    async start(run) {
      runs.set(run.id, {
        ...structuredClone(run), status: "running", completedAt: null, finalMessage: null, errorMessage: null,
      });
    },
    async append(event) { events.push(structuredClone(event)); },
    async complete(runId, finalMessage, completedAt) {
      const run = runs.get(runId);
      if (run) runs.set(runId, { ...run, status: "completed", completedAt, finalMessage, errorMessage: null });
    },
    async fail(runId, errorMessage, completedAt) {
      const run = runs.get(runId);
      if (run) runs.set(runId, { ...run, status: "failed", completedAt, finalMessage: null, errorMessage });
    },
    async getLatestForTask(taskId) {
      const run = [...runs.values()]
        .filter((candidate) => candidate.taskId === taskId)
        .sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0];
      return run ? toAgentRunTrace(run, events.filter((event) => event.runId === run.id)) : null;
    },
  };
}

export function createPostgresAgentRunStore(databaseUrl: string): AgentRunStore {
  const pool = new Pool({ connectionString: databaseUrl });
  return {
    async start(run) {
      await pool.query(
        `INSERT INTO agent_runs (id, organization_id, task_id, provider, model_id, status, started_at)
         VALUES ($1, $2, $3, $4, $5, 'running', $6)`,
        [run.id, run.organizationId, run.taskId, run.provider, run.modelId, run.startedAt],
      );
    },
    async append(event) {
      await pool.query(
        `INSERT INTO agent_run_events
          (run_id, sequence, type, occurred_at, tool_call_id, tool_name, is_error, result_id, result_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [event.runId, event.sequence, event.type, event.occurredAt, event.toolCallId ?? null, event.toolName ?? null, event.isError ?? null, event.resultId ?? null, event.resultStatus ?? null],
      );
    },
    async complete(runId, finalMessage, completedAt) {
      await pool.query(
        "UPDATE agent_runs SET status = 'completed', final_message = $2, completed_at = $3 WHERE id = $1",
        [runId, finalMessage, completedAt],
      );
    },
    async fail(runId, errorMessage, completedAt) {
      await pool.query(
        "UPDATE agent_runs SET status = 'failed', error_message = $2, completed_at = $3 WHERE id = $1",
        [runId, errorMessage, completedAt],
      );
    },
    async getLatestForTask(taskId) {
      const runResponse = await pool.query(
        `SELECT id, organization_id, task_id, provider, model_id, status, started_at, completed_at, final_message, error_message
         FROM agent_runs
         WHERE task_id = $1
         ORDER BY started_at DESC
         LIMIT 1`,
        [taskId],
      );
      const row = runResponse.rows[0];
      if (!row) return null;
      const eventResponse = await pool.query(
        `SELECT run_id, sequence, type, occurred_at, tool_call_id, tool_name, is_error, result_id, result_status
         FROM agent_run_events
         WHERE run_id = $1
         ORDER BY sequence`,
        [row.id],
      );
      return toAgentRunTrace({
        id: row.id as string,
        organizationId: row.organization_id as string,
        taskId: row.task_id as string,
        provider: row.provider as string,
        modelId: row.model_id as string,
        status: row.status as AgentRunStatus,
        startedAt: new Date(row.started_at as string | Date).toISOString(),
        completedAt: row.completed_at ? new Date(row.completed_at as string | Date).toISOString() : null,
        finalMessage: row.final_message as string | null,
        errorMessage: row.error_message as string | null,
      }, eventResponse.rows.map(toAgentEventRecord));
    },
  };
}

function toAgentEventRecord(row: Record<string, unknown>): AgentEventRecord {
  const event: AgentEventRecord = {
    runId: row.run_id as string,
    sequence: row.sequence as number,
    type: row.type as AgentEventRecord["type"],
    occurredAt: new Date(row.occurred_at as string | Date).toISOString(),
  };
  if (row.tool_call_id) event.toolCallId = row.tool_call_id as string;
  if (row.tool_name) event.toolName = row.tool_name as string;
  if (row.is_error !== null && row.is_error !== undefined) event.isError = row.is_error as boolean;
  if (row.result_id) event.resultId = row.result_id as string;
  if (row.result_status) event.resultStatus = row.result_status as NonNullable<AgentEventRecord["resultStatus"]>;
  return event;
}

function toAgentRunTrace(run: StoredAgentRun, events: AgentEventRecord[]): AgentRunTrace {
  return {
    id: run.id,
    taskId: run.taskId,
    provider: run.provider,
    modelId: run.modelId,
    status: run.status,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    finalMessage: run.finalMessage,
    errorMessage: run.errorMessage,
    tools: toolRuns(events),
  };
}

function toolRuns(events: AgentEventRecord[]): AgentToolRun[] {
  const tools = new Map<string, AgentToolRun>();
  for (const event of events) {
    if (!event.toolCallId || !event.toolName) continue;
    if (event.type === "tool_execution_start") {
      tools.set(event.toolCallId, {
        sequence: event.sequence,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        status: "running",
        startedAt: event.occurredAt,
        completedAt: null,
        resultId: null,
        resultStatus: null,
      });
    }
    if (event.type === "tool_execution_end") {
      const current = tools.get(event.toolCallId);
      tools.set(event.toolCallId, {
        sequence: current?.sequence ?? event.sequence,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        status: event.isError ? "failed" : "completed",
        startedAt: current?.startedAt ?? event.occurredAt,
        completedAt: event.occurredAt,
        resultId: event.resultId ?? null,
        resultStatus: event.resultStatus ?? null,
      });
    }
  }
  return [...tools.values()].sort((left, right) => left.sequence - right.sequence);
}
