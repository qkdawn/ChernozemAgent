import type { AnalysisResult } from "@chernozem/contracts";
import pg from "pg";

const { Pool } = pg;

export interface AnalysisResultStore {
  save(result: AnalysisResult<unknown>): Promise<void>;
  get(id: string): Promise<AnalysisResult<unknown> | null>;
  list(taskId: string): Promise<AnalysisResult<unknown>[]>;
}

export function createMemoryAnalysisResultStore(): AnalysisResultStore {
  const results = new Map<string, AnalysisResult<unknown>>();
  return {
    async save(result) { results.set(result.id, structuredClone(result)); },
    async get(id) { return results.has(id) ? structuredClone(results.get(id)!) : null; },
    async list(taskId) {
      return [...results.values()]
        .filter((result) => result.taskId === taskId)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .map((result) => structuredClone(result));
    },
  };
}

export function createPostgresAnalysisResultStore(databaseUrl: string): AnalysisResultStore {
  const pool = new Pool({ connectionString: databaseUrl });
  return {
    async save(result) {
      await pool.query(
        `INSERT INTO analysis_results (id, task_id, kind, status, tool_version, created_at, result, document)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb)
         ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, result = EXCLUDED.result, document = EXCLUDED.document`,
        [result.id, result.taskId, result.kind, result.status, result.toolVersion, result.createdAt, JSON.stringify(result.result), JSON.stringify(result)],
      );
    },
    async get(id) {
      const response = await pool.query("SELECT document FROM analysis_results WHERE id = $1", [id]);
      return response.rows[0] ? response.rows[0].document as AnalysisResult<unknown> : null;
    },
    async list(taskId) {
      const response = await pool.query("SELECT document FROM analysis_results WHERE task_id = $1 ORDER BY created_at DESC", [taskId]);
      return response.rows.map((row) => row.document as AnalysisResult<unknown>);
    },
  };
}
