import type { VariableNitrogenPrescription } from "@chernozem/contracts";
import pg from "pg";

import { DEMO_ORGANIZATION_ID } from "./field-store.js";

const { Pool } = pg;

export interface NitrogenPrescriptionStore {
  save(prescription: VariableNitrogenPrescription): Promise<void>;
  get(id: string): Promise<VariableNitrogenPrescription | null>;
  list(fieldId: string, limit?: number): Promise<VariableNitrogenPrescription[]>;
}

export function createMemoryNitrogenPrescriptionStore(): NitrogenPrescriptionStore {
  const prescriptions = new Map<string, VariableNitrogenPrescription>();
  return {
    async save(prescription) { prescriptions.set(prescription.id, structuredClone(prescription)); },
    async get(id) { return prescriptions.has(id) ? structuredClone(prescriptions.get(id)!) : null; },
    async list(fieldId, limit = 50) {
      return [...prescriptions.values()]
        .filter((item) => item.fieldId === fieldId)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .slice(0, limit)
        .map((item) => structuredClone(item));
    },
  };
}

export function createPostgresNitrogenPrescriptionStore(databaseUrl: string, organizationId = DEMO_ORGANIZATION_ID): NitrogenPrescriptionStore {
  const pool = new Pool({ connectionString: databaseUrl });
  return {
    async save(prescription) {
      await pool.query(
        `INSERT INTO variable_nitrogen_prescriptions
          (id, organization_id, field_id, boundary_version, status, source_task_id, source_date, created_at, updated_at, document)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
         ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, updated_at = EXCLUDED.updated_at, document = EXCLUDED.document`,
        [prescription.id, organizationId, prescription.fieldId, prescription.boundaryVersion, prescription.status, prescription.sourceTaskId, prescription.sourceDate, prescription.createdAt, prescription.updatedAt, JSON.stringify(prescription)],
      );
    },
    async get(id) {
      const response = await pool.query(
        "SELECT document FROM variable_nitrogen_prescriptions WHERE id = $1 AND organization_id = $2",
        [id, organizationId],
      );
      return response.rows[0]?.document as VariableNitrogenPrescription | null ?? null;
    },
    async list(fieldId, limit = 50) {
      const response = await pool.query(
        "SELECT document FROM variable_nitrogen_prescriptions WHERE organization_id = $1 AND field_id = $2 ORDER BY created_at DESC LIMIT $3",
        [organizationId, fieldId, limit],
      );
      return response.rows.map((row) => row.document as VariableNitrogenPrescription);
    },
  };
}
