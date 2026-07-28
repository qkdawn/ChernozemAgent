import type { FieldInput, FieldSummary, FieldUpdateInput, Position } from "@chernozem/contracts";
import { randomUUID } from "node:crypto";
import pg from "pg";

const { Pool } = pg;

export interface FieldStore {
  list(): Promise<FieldSummary[]>;
  get(id: string): Promise<FieldSummary | null>;
  create(input: FieldInput): Promise<FieldSummary>;
  update(id: string, input: FieldUpdateInput): Promise<FieldSummary | null>;
  archive(id: string): Promise<boolean>;
}

export class FieldGeometryError extends Error {}

export function createPostgresFieldStore(databaseUrl: string): FieldStore {
  const pool = new Pool({ connectionString: databaseUrl });
  return {
    async list() {
      const result = await pool.query(FIELD_SELECT);
      return result.rows.map(toFieldSummary);
    },
    async get(id) {
      const result = await pool.query(`${FIELD_SELECT} AND f.id = $1`, [id]);
      return result.rows[0] ? toFieldSummary(result.rows[0]) : null;
    },
    async create(input) {
      const boundary = normalizeBoundary(input.boundary);
      const result = await pool.query(
        `INSERT INTO fields (id, name, crop, season_year, planting_date, variety, boundary)
         VALUES ($1, $2, $3, $4, $5, $6, ST_SetSRID(ST_GeomFromGeoJSON($7), 4326))
         RETURNING id`,
        [randomUUID(), input.name, input.crop, input.seasonYear, input.plantingDate ?? null, input.variety ?? null, polygonGeoJson(boundary)],
      );
      return readField(pool, result.rows[0]!.id);
    },
    async update(id, input) {
      const result = await pool.query(
        `UPDATE fields
         SET name = COALESCE($2, name), crop = COALESCE($3, crop), season_year = COALESCE($4, season_year),
             planting_date = CASE WHEN $5 THEN $6::date ELSE planting_date END,
             variety = CASE WHEN $7 THEN $8 ELSE variety END,
             boundary = CASE WHEN $9 THEN ST_SetSRID(ST_GeomFromGeoJSON($10), 4326) ELSE boundary END,
             updated_at = now()
         WHERE id = $1 AND archived_at IS NULL
         RETURNING id`,
        [id, input.name ?? null, input.crop ?? null, input.seasonYear ?? null, input.plantingDate !== undefined, input.plantingDate ?? null, input.variety !== undefined, input.variety ?? null, input.boundary !== undefined, input.boundary ? polygonGeoJson(normalizeBoundary(input.boundary)) : null],
      );
      return result.rows[0] ? readField(pool, result.rows[0].id) : null;
    },
    async archive(id) {
      const result = await pool.query("UPDATE fields SET archived_at = now(), updated_at = now() WHERE id = $1 AND archived_at IS NULL", [id]);
      return result.rowCount === 1;
    },
  };
}

export function createMemoryFieldStore(): FieldStore {
  const fields = new Map<string, FieldSummary>();
  return {
    async list() { return [...fields.values()]; },
    async get(id) { return fields.get(id) ?? null; },
    async create(input) {
      const boundary = normalizeBoundary(input.boundary);
      const field: FieldSummary = {
        id: randomUUID(), code: "", name: input.name, crop: input.crop, seasonYear: input.seasonYear, plantingDate: input.plantingDate ?? null, variety: input.variety ?? null,
        areaHa: polygonAreaHectares(boundary), village: "", boundary, centroid: polygonCentroid(boundary),
        latestStatus: "not_analyzed", latestAnalyzedAt: null,
      };
      fields.set(field.id, field);
      return field;
    },
    async update(id, input) {
      const current = fields.get(id);
      if (!current) return null;
      const boundary = input.boundary ? normalizeBoundary(input.boundary) : current.boundary;
      const updated: FieldSummary = { ...current, ...input, boundary, areaHa: polygonAreaHectares(boundary), centroid: polygonCentroid(boundary) };
      fields.set(id, updated);
      return updated;
    },
    async archive(id) { return fields.delete(id); },
  };
}

export function normalizeBoundary(boundary: Position[]): Position[] {
  if (boundary.length < 3) throw new FieldGeometryError("地块边界至少需要 3 个点。");
  const points = boundary.map((point) => {
    if (!Number.isFinite(point.longitude) || !Number.isFinite(point.latitude) || Math.abs(point.longitude) > 180 || Math.abs(point.latitude) > 90) {
      throw new FieldGeometryError("地块边界包含无效坐标。");
    }
    return { longitude: point.longitude, latitude: point.latitude };
  });
  const first = points[0]!;
  const last = points.at(-1)!;
  if (first.longitude !== last.longitude || first.latitude !== last.latitude) points.push({ ...first });
  if (hasSelfIntersection(points)) throw new FieldGeometryError("地块边界不能自相交。");
  const areaHa = polygonAreaHectares(points);
  if (areaHa <= 0.01) throw new FieldGeometryError("地块面积过小，无法保存。");
  if (areaHa > 20_000) throw new FieldGeometryError("地块面积异常，请检查绘制范围。");
  return points;
}

function hasSelfIntersection(points: Position[]): boolean {
  for (let index = 0; index < points.length - 1; index += 1) {
    for (let other = index + 1; other < points.length - 1; other += 1) {
      if (Math.abs(index - other) <= 1 || (index === 0 && other === points.length - 2)) continue;
      if (segmentsIntersect(points[index]!, points[index + 1]!, points[other]!, points[other + 1]!)) return true;
    }
  }
  return false;
}

function segmentsIntersect(a: Position, b: Position, c: Position, d: Position): boolean {
  const orientation = (p: Position, q: Position, r: Position) => (q.longitude - p.longitude) * (r.latitude - p.latitude) - (q.latitude - p.latitude) * (r.longitude - p.longitude);
  const abC = orientation(a, b, c); const abD = orientation(a, b, d); const cdA = orientation(c, d, a); const cdB = orientation(c, d, b);
  return ((abC > 0 && abD < 0) || (abC < 0 && abD > 0)) && ((cdA > 0 && cdB < 0) || (cdA < 0 && cdB > 0));
}

function polygonAreaHectares(points: Position[]): number {
  const radius = 6_378_137;
  let area = 0;
  for (let index = 0; index < points.length - 1; index += 1) {
    const current = points[index]!; const next = points[index + 1]!;
    area += (next.longitude - current.longitude) * Math.PI / 180 * (2 + Math.sin(current.latitude * Math.PI / 180) + Math.sin(next.latitude * Math.PI / 180));
  }
  return Math.abs(area * radius * radius / 2) / 10_000;
}

function polygonCentroid(points: Position[]): Position {
  const vertices = points.slice(0, -1);
  if (vertices.length === 0) throw new FieldGeometryError("地块边界为空。");
  return { longitude: vertices.reduce((sum, point) => sum + point.longitude, 0) / vertices.length, latitude: vertices.reduce((sum, point) => sum + point.latitude, 0) / vertices.length };
}

function polygonGeoJson(boundary: Position[]) { return JSON.stringify({ type: "Polygon", coordinates: [boundary.map((point) => [point.longitude, point.latitude])] }); }

const FIELD_SELECT = `SELECT f.id, f.name, f.crop, f.season_year, f.planting_date, f.variety,
  ST_AsGeoJSON(f.boundary)::json AS boundary, ST_Area(f.boundary::geography) / 10000 AS area_ha,
  ST_X(ST_Centroid(f.boundary)) AS longitude, ST_Y(ST_Centroid(f.boundary)) AS latitude
  FROM fields f WHERE f.archived_at IS NULL`;

async function readField(pool: pg.Pool, id: string): Promise<FieldSummary> {
  const result = await pool.query(`${FIELD_SELECT} AND f.id = $1`, [id]);
  return toFieldSummary(result.rows[0]!);
}

function toFieldSummary(row: Record<string, unknown>): FieldSummary {
  const boundary = (row.boundary as { coordinates: Array<Array<[number, number]>> }).coordinates[0]!.map(([longitude, latitude]) => ({ longitude, latitude }));
  return { id: String(row.id), code: `FIELD-${String(row.id).slice(0, 8).toUpperCase()}`, name: String(row.name), crop: row.crop as FieldSummary["crop"], seasonYear: Number(row.season_year), plantingDate: row.planting_date ? String(row.planting_date).slice(0, 10) : null, variety: row.variety ? String(row.variety) : null, areaHa: Number(row.area_ha), village: "", boundary, centroid: { longitude: Number(row.longitude), latitude: Number(row.latitude) }, latestStatus: "not_analyzed", latestAnalyzedAt: null };
}
