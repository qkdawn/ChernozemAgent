import type { FieldScoutingNote } from "@chernozem/contracts";
import pg from "pg";

import { DEMO_ORGANIZATION_ID } from "./field-store.js";

const { Pool } = pg;

export interface ScoutingNoteStore {
  save(note: FieldScoutingNote): Promise<void>;
  get(id: string): Promise<FieldScoutingNote | null>;
  list(fieldId: string, limit?: number): Promise<FieldScoutingNote[]>;
}

export function createMemoryScoutingNoteStore(): ScoutingNoteStore {
  const notes = new Map<string, FieldScoutingNote>();
  return {
    async save(note) { notes.set(note.id, structuredClone(note)); },
    async get(id) { return notes.has(id) ? structuredClone(notes.get(id)!) : null; },
    async list(fieldId, limit = 100) {
      return [...notes.values()]
        .filter((note) => note.fieldId === fieldId)
        .sort((left, right) => right.observedAt.localeCompare(left.observedAt) || right.createdAt.localeCompare(left.createdAt))
        .slice(0, limit)
        .map((note) => structuredClone(note));
    },
  };
}

export function createPostgresScoutingNoteStore(databaseUrl: string, organizationId = DEMO_ORGANIZATION_ID): ScoutingNoteStore {
  const pool = new Pool({ connectionString: databaseUrl });
  return {
    async save(note) {
      await pool.query(
        `INSERT INTO field_scouting_notes
          (id, organization_id, field_id, observed_at, longitude, latitude, water_condition, leaf_color, disease_or_pest, note, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [note.id, organizationId, note.fieldId, note.observedAt, note.location.longitude, note.location.latitude, note.waterCondition, note.leafColor, note.diseaseOrPest, note.note, note.createdAt],
      );
    },
    async get(id) {
      const response = await pool.query(
        "SELECT * FROM field_scouting_notes WHERE id = $1 AND organization_id = $2",
        [id, organizationId],
      );
      return response.rows[0] ? toScoutingNote(response.rows[0]) : null;
    },
    async list(fieldId, limit = 100) {
      const response = await pool.query(
        "SELECT * FROM field_scouting_notes WHERE organization_id = $1 AND field_id = $2 ORDER BY observed_at DESC, created_at DESC LIMIT $3",
        [organizationId, fieldId, limit],
      );
      return response.rows.map(toScoutingNote);
    },
  };
}

function toScoutingNote(row: Record<string, unknown>): FieldScoutingNote {
  return {
    id: String(row.id),
    fieldId: String(row.field_id),
    observedAt: calendarDate(row.observed_at),
    location: { longitude: Number(row.longitude), latitude: Number(row.latitude) },
    waterCondition: row.water_condition as FieldScoutingNote["waterCondition"],
    leafColor: row.leaf_color as FieldScoutingNote["leafColor"],
    diseaseOrPest: row.disease_or_pest as FieldScoutingNote["diseaseOrPest"],
    note: String(row.note ?? ""),
    createdAt: isoDate(row.created_at),
  };
}

function calendarDate(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function isoDate(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}
