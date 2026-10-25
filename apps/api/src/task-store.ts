import type { AnalysisBrief, AnalysisObjective, AnalysisTask } from "@chernozem/contracts";
import pg from "pg";

import { DEMO_ORGANIZATION_ID } from "./field-store.js";

const { Pool } = pg;

export interface AnalysisTaskStore {
  save(task: AnalysisTask): Promise<void>;
  get(id: string): Promise<AnalysisTask | null>;
  list(fieldId: string, limit?: number): Promise<AnalysisTask[]>;
  listRecent(limit?: number, objective?: AnalysisObjective): Promise<AnalysisTask[]>;
}

export function createMemoryAnalysisTaskStore(): AnalysisTaskStore {
  const tasks = new Map<string, AnalysisTask>();
  return {
    async save(task) { tasks.set(task.id, structuredClone(task)); },
    async get(id) { return tasks.has(id) ? structuredClone(tasks.get(id)!) : null; },
    async list(fieldId, limit = 50) {
      return [...tasks.values()]
        .filter((task) => task.fieldId === fieldId)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .slice(0, limit)
        .map((task) => structuredClone(task));
    },
    async listRecent(limit = 20, objective) {
      return [...tasks.values()]
        .filter((task) => !objective || task.objective === objective)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .slice(0, limit)
        .map((task) => structuredClone(task));
    },
  };
}

function normalizeTask(task: AnalysisTask): AnalysisTask {
  const storedBrief = task.brief as (Omit<AnalysisBrief, "generation"> & { generation?: AnalysisBrief["generation"] }) | null | undefined;
  const brief = storedBrief ? {
    ...storedBrief,
    generation: storedBrief.generation ?? {
      mode: "deterministic" as const,
      generatedAt: task.completedAt ?? task.createdAt,
      provider: null,
      modelId: null,
      promptVersion: null,
      fallbackReason: null,
    },
  } : null;
  return { ...task, brief, failure: task.failure ?? null };
}

export function createPostgresAnalysisTaskStore(databaseUrl: string, organizationId = DEMO_ORGANIZATION_ID): AnalysisTaskStore {
  const pool = new Pool({ connectionString: databaseUrl });
  return {
    async save(task) {
      await pool.query(
        `INSERT INTO analysis_tasks
          (id, organization_id, field_id, objective, status, created_at, completed_at, document)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
         ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, completed_at = EXCLUDED.completed_at, document = EXCLUDED.document`,
        [task.id, organizationId, task.fieldId, task.objective, task.status, task.createdAt, task.completedAt, JSON.stringify(task)],
      );
    },
    async get(id) {
      const response = await pool.query("SELECT document FROM analysis_tasks WHERE id = $1 AND organization_id = $2", [id, organizationId]);
      return response.rows[0] ? normalizeTask(response.rows[0].document as AnalysisTask) : null;
    },
    async list(fieldId, limit = 50) {
      const response = await pool.query(
        "SELECT document FROM analysis_tasks WHERE organization_id = $1 AND field_id = $2 ORDER BY created_at DESC LIMIT $3",
        [organizationId, fieldId, limit],
      );
      return response.rows.map((row) => normalizeTask(row.document as AnalysisTask));
    },
    async listRecent(limit = 20, objective) {
      const response = objective
        ? await pool.query(
          "SELECT document FROM analysis_tasks WHERE organization_id = $1 AND objective = $2 ORDER BY created_at DESC LIMIT $3",
          [organizationId, objective, limit],
        )
        : await pool.query(
          "SELECT document FROM analysis_tasks WHERE organization_id = $1 ORDER BY created_at DESC LIMIT $2",
          [organizationId, limit],
        );
      return response.rows.map((row) => normalizeTask(row.document as AnalysisTask));
    },
  };
}
