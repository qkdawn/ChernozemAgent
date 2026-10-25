import type { DataAcquisitionRun } from "@chernozem/contracts";
import pg from "pg";

import { DEMO_ORGANIZATION_ID } from "./field-store.js";

const { Pool } = pg;

export interface AcquisitionStore {
  save(run: DataAcquisitionRun): Promise<void>;
  get(id: string): Promise<DataAcquisitionRun | null>;
  latest(fieldId: string): Promise<DataAcquisitionRun | null>;
  list(fieldId: string, limit: number): Promise<DataAcquisitionRun[]>;
}

export function createMemoryAcquisitionStore(): AcquisitionStore {
  const runs = new Map<string, DataAcquisitionRun>();
  const serviceStartedAt = Date.now();
  return {
    async save(run) { runs.set(run.id, structuredClone(run)); },
    async get(id) { return runs.has(id) ? recoverInterruptedRun(structuredClone(runs.get(id)!), serviceStartedAt) : null; },
    async latest(fieldId) {
      return [...runs.values()]
        .filter((run) => run.fieldId === fieldId)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .map((run) => recoverInterruptedRun(structuredClone(run), serviceStartedAt))[0] ?? null;
    },
    async list(fieldId, limit) {
      return [...runs.values()]
        .filter((run) => run.fieldId === fieldId)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .slice(0, limit)
        .map((run) => recoverInterruptedRun(structuredClone(run), serviceStartedAt));
    },
  };
}

export function createPostgresAcquisitionStore(databaseUrl: string, organizationId = DEMO_ORGANIZATION_ID): AcquisitionStore {
  const pool = new Pool({ connectionString: databaseUrl });
  const serviceStartedAt = Date.now();
  async function recoverAndPersist(run: DataAcquisitionRun): Promise<DataAcquisitionRun> {
    const recovered = recoverInterruptedRun(run, serviceStartedAt);
    if (recovered !== run) {
      await pool.query(
        "UPDATE acquisition_runs SET status = $1, completed_at = $2, manifest = $3::jsonb WHERE id = $4 AND organization_id = $5",
        [recovered.status, recovered.completedAt, JSON.stringify(recovered), recovered.id, organizationId],
      );
    }
    return recovered;
  }
  return {
    async save(run) {
      await pool.query(
        `INSERT INTO acquisition_runs
          (id, organization_id, field_id, boundary_version, period_start, period_end, data_profile, status, created_at, completed_at, manifest)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
         ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, completed_at = EXCLUDED.completed_at, manifest = EXCLUDED.manifest`,
        [run.id, organizationId, run.fieldId, run.boundaryVersion, run.period.start, run.period.end, run.dataProfile, run.status, run.createdAt, run.completedAt, JSON.stringify(run)],
      );
    },
    async get(id) {
      const result = await pool.query("SELECT manifest FROM acquisition_runs WHERE id = $1 AND organization_id = $2", [id, organizationId]);
      return result.rows[0] ? recoverAndPersist(result.rows[0].manifest as DataAcquisitionRun) : null;
    },
    async latest(fieldId) {
      const result = await pool.query(
        "SELECT manifest FROM acquisition_runs WHERE field_id = $1 AND organization_id = $2 ORDER BY created_at DESC LIMIT 1",
        [fieldId, organizationId],
      );
      return result.rows[0] ? recoverAndPersist(result.rows[0].manifest as DataAcquisitionRun) : null;
    },
    async list(fieldId, limit) {
      const result = await pool.query(
        "SELECT manifest FROM acquisition_runs WHERE field_id = $1 AND organization_id = $2 ORDER BY created_at DESC LIMIT $3",
        [fieldId, organizationId, limit],
      );
      return Promise.all(result.rows.map((row) => recoverAndPersist(row.manifest as DataAcquisitionRun)));
    },
  };
}

function recoverInterruptedRun(run: DataAcquisitionRun, serviceStartedAt: number, now = Date.now()): DataAcquisitionRun {
  if (run.status !== "running" || Date.parse(run.createdAt) >= serviceStartedAt) return run;
  return {
    ...run,
    status: "failed",
    completedAt: new Date(now).toISOString(),
    sources: run.sources,
    manifestVersion: run.manifestVersion,
    error: {
      code: "acquisition_worker_interrupted",
      retryable: true,
      message: "数据采集进程已中断，请重新检查。",
    },
  };
}
