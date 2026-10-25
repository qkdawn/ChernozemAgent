import type { FieldHistory, FieldInput, FieldSummary, FieldUpdateInput, Position } from "@chernozem/contracts";
import { randomUUID } from "node:crypto";
import pg from "pg";

const { Pool } = pg;

export const DEMO_ORGANIZATION_ID = "00000000-0000-0000-0000-000000000001";

export interface FieldStore {
  list(): Promise<FieldSummary[]>;
  get(id: string): Promise<FieldSummary | null>;
  history(id: string): Promise<FieldHistory | null>;
  create(input: FieldInput): Promise<FieldSummary>;
  update(id: string, input: FieldUpdateInput): Promise<FieldSummary | null>;
  archive(id: string): Promise<boolean>;
}

export class FieldGeometryError extends Error {}

export function createPostgresFieldStore(databaseUrl: string, organizationId = DEMO_ORGANIZATION_ID): FieldStore {
  const pool = new Pool({ connectionString: databaseUrl });

  return {
    async list() {
      const result = await pool.query(`${FIELD_SELECT} AND f.organization_id = $1 ORDER BY f.updated_at DESC`, [organizationId]);
      return result.rows.map(toFieldSummary);
    },
    async get(id) {
      const result = await pool.query(`${FIELD_SELECT} AND f.organization_id = $1 AND f.id = $2`, [organizationId, id]);
      return result.rows[0] ? toFieldSummary(result.rows[0]) : null;
    },
    async history(id) {
      const field = await pool.query("SELECT id FROM fields WHERE id = $1 AND organization_id = $2 AND archived_at IS NULL", [id, organizationId]);
      if (!field.rows[0]) return null;
      const [boundaries, seasons] = await Promise.all([
        pool.query("SELECT version, created_at FROM field_boundary_versions WHERE field_id = $1 ORDER BY version DESC", [id]),
        pool.query("SELECT id, crop, season_year, to_char(planting_date, 'YYYY-MM-DD') AS planting_date, variety, updated_at FROM field_seasons WHERE field_id = $1 AND archived_at IS NULL ORDER BY season_year DESC", [id]),
      ]);
      return {
        fieldId: id,
        boundaryVersions: boundaries.rows.map((row) => ({ version: Number(row.version), createdAt: new Date(row.created_at).toISOString() })),
        seasons: seasons.rows.map((row) => ({ id: String(row.id), crop: row.crop, seasonYear: Number(row.season_year), plantingDate: row.planting_date ? String(row.planting_date) : null, variety: row.variety ?? null, updatedAt: new Date(row.updated_at).toISOString() })),
      };
    },
    async create(input) {
      const boundary = normalizeBoundary(input.boundary);
      const boundaryJson = polygonGeoJson(boundary);
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await assertWithinAuthorizedArea(client, organizationId, boundaryJson);
        const id = randomUUID();
        await client.query(
          `INSERT INTO fields (id, organization_id, name, crop, season_year, planting_date, variety, boundary, boundary_version)
           VALUES ($1, $2, $3, $4, $5, $6, $7, ST_SetSRID(ST_GeomFromGeoJSON($8), 4326), 1)`,
          [id, organizationId, input.name, input.crop, input.seasonYear, input.plantingDate ?? null, input.variety ?? null, boundaryJson],
        );
        await client.query(
          "INSERT INTO field_boundary_versions (id, field_id, version, boundary) VALUES ($1, $2, 1, ST_SetSRID(ST_GeomFromGeoJSON($3), 4326))",
          [randomUUID(), id, boundaryJson],
        );
        await client.query(
          "INSERT INTO field_seasons (id, field_id, crop, season_year, planting_date, variety) VALUES ($1, $2, $3, $4, $5, $6)",
          [randomUUID(), id, input.crop, input.seasonYear, input.plantingDate ?? null, input.variety ?? null],
        );
        await client.query("COMMIT");
        return readField(pool, id, organizationId);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    async update(id, input) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const current = await client.query(`${FIELD_SELECT} AND f.organization_id = $1 AND f.id = $2 FOR UPDATE`, [organizationId, id]);
        if (!current.rows[0]) {
          await client.query("ROLLBACK");
          return null;
        }
        const row = current.rows[0]!;
        const nextName = input.name ?? String(row.name);
        const nextCrop = input.crop ?? row.crop;
        const nextSeasonYear = input.seasonYear ?? Number(row.season_year);
        const nextPlantingDate = input.plantingDate !== undefined ? input.plantingDate : row.planting_date ? String(row.planting_date) : null;
        const nextVariety = input.variety !== undefined ? input.variety : row.variety ?? null;

        const currentBoundary = boundaryFromGeoJson(row.boundary);
        const nextBoundary = input.boundary ? normalizeBoundary(input.boundary) : null;
        const boundaryChanged = nextBoundary !== null && !sameBoundary(currentBoundary, nextBoundary);
        if (boundaryChanged) {
          const boundaryJson = polygonGeoJson(nextBoundary);
          await assertWithinAuthorizedArea(client, organizationId, boundaryJson);
          const version = Number(row.boundary_version) + 1;
          await client.query(
            `UPDATE fields SET name = $3, boundary = ST_SetSRID(ST_GeomFromGeoJSON($4), 4326), boundary_version = $5, updated_at = now()
             WHERE id = $1 AND organization_id = $2`,
            [id, organizationId, nextName, boundaryJson, version],
          );
          await client.query(
            "INSERT INTO field_boundary_versions (id, field_id, version, boundary) VALUES ($1, $2, $3, ST_SetSRID(ST_GeomFromGeoJSON($4), 4326))",
            [randomUUID(), id, version, boundaryJson],
          );
        } else {
          await client.query("UPDATE fields SET name = $3, updated_at = now() WHERE id = $1 AND organization_id = $2", [id, organizationId, nextName]);
        }

        await client.query(
          `INSERT INTO field_seasons (id, field_id, crop, season_year, planting_date, variety)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (field_id, season_year) DO UPDATE
           SET crop = EXCLUDED.crop, planting_date = EXCLUDED.planting_date, variety = EXCLUDED.variety, updated_at = now()`,
          [randomUUID(), id, nextCrop, nextSeasonYear, nextPlantingDate, nextVariety],
        );
        // These columns keep the original migration readable while field_seasons owns historical records.
        await client.query(
          "UPDATE fields SET crop = $3, season_year = $4, planting_date = $5, variety = $6 WHERE id = $1 AND organization_id = $2",
          [id, organizationId, nextCrop, nextSeasonYear, nextPlantingDate, nextVariety],
        );
        await client.query("COMMIT");
        return readField(pool, id, organizationId);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    async archive(id) {
      const result = await pool.query("UPDATE fields SET archived_at = now(), updated_at = now() WHERE id = $1 AND organization_id = $2 AND archived_at IS NULL", [id, organizationId]);
      return result.rowCount === 1;
    },
  };
}

export function createMemoryFieldStore(organizationId = DEMO_ORGANIZATION_ID): FieldStore {
  const fields = new Map<string, FieldSummary>();
  const histories = new Map<string, FieldHistory>();
  return {
    async list() { return [...fields.values()]; },
    async get(id) { return fields.get(id) ?? null; },
    async history(id) { return histories.get(id) ?? null; },
    async create(input) {
      const boundary = normalizeBoundary(input.boundary);
      const id = randomUUID();
      const now = new Date().toISOString();
      const field: FieldSummary = {
        id, organizationId, code: "", name: input.name, crop: input.crop, seasonYear: input.seasonYear, plantingDate: input.plantingDate ?? null, variety: input.variety ?? null,
        areaHa: polygonAreaHectares(boundary), village: "", boundary, centroid: polygonCentroid(boundary), boundaryVersion: 1, seasonCount: 1,
        latestStatus: "not_analyzed", latestAnalyzedAt: null,
      };
      fields.set(id, field);
      histories.set(id, { fieldId: id, boundaryVersions: [{ version: 1, createdAt: now }], seasons: [{ id: randomUUID(), crop: input.crop, seasonYear: input.seasonYear, plantingDate: input.plantingDate ?? null, variety: input.variety ?? null, updatedAt: now }] });
      return field;
    },
    async update(id, input) {
      const current = fields.get(id);
      const history = histories.get(id);
      if (!current || !history) return null;
      const candidateBoundary = input.boundary ? normalizeBoundary(input.boundary) : null;
      const boundaryChanged = candidateBoundary !== null && !sameBoundary(current.boundary, candidateBoundary);
      const boundary = boundaryChanged ? candidateBoundary : current.boundary;
      const seasonYear = input.seasonYear ?? current.seasonYear;
      const crop = input.crop ?? current.crop;
      const plantingDate = input.plantingDate !== undefined ? input.plantingDate : current.plantingDate;
      const variety = input.variety !== undefined ? input.variety : current.variety;
      const now = new Date().toISOString();
      const existingSeason = history.seasons.find((season) => season.seasonYear === seasonYear);
      const seasons = existingSeason
        ? history.seasons.map((season) => season.seasonYear === seasonYear ? { ...season, crop, plantingDate, variety, updatedAt: now } : season)
        : [{ id: randomUUID(), crop, seasonYear, plantingDate, variety, updatedAt: now }, ...history.seasons];
      const boundaryVersions = boundaryChanged ? [{ version: current.boundaryVersion + 1, createdAt: now }, ...history.boundaryVersions] : history.boundaryVersions;
      const updated: FieldSummary = { ...current, ...input, boundary, crop, seasonYear, plantingDate, variety, areaHa: polygonAreaHectares(boundary), centroid: polygonCentroid(boundary), boundaryVersion: boundaryVersions[0]!.version, seasonCount: seasons.length };
      fields.set(id, updated);
      histories.set(id, { fieldId: id, boundaryVersions, seasons: seasons.sort((left, right) => right.seasonYear - left.seasonYear) });
      return updated;
    },
    async archive(id) { histories.delete(id); return fields.delete(id); },
  };
}

export function normalizeBoundary(boundary: Position[]): Position[] {
  if (boundary.length < 3) throw new FieldGeometryError("地块边界至少需要 3 个点。");
  const points = boundary.map((point) => {
    if (!Number.isFinite(point.longitude) || !Number.isFinite(point.latitude) || Math.abs(point.longitude) > 180 || Math.abs(point.latitude) > 90) throw new FieldGeometryError("地块边界包含无效坐标。");
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

export function pointInBoundary(point: Position, boundary: Position[]): boolean {
  const ring = boundary.at(-1)?.longitude === boundary[0]?.longitude && boundary.at(-1)?.latitude === boundary[0]?.latitude
    ? boundary.slice(0, -1)
    : boundary;
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const current = ring[index]!;
    const prior = ring[previous]!;
    const intersects = ((current.latitude > point.latitude) !== (prior.latitude > point.latitude))
      && point.longitude < (prior.longitude - current.longitude) * (point.latitude - current.latitude) / (prior.latitude - current.latitude) + current.longitude;
    if (intersects) inside = !inside;
  }
  return inside;
}

async function assertWithinAuthorizedArea(client: pg.PoolClient, organizationId: string, boundaryJson: string) {
  const result = await client.query(
    `SELECT EXISTS (
      SELECT 1 FROM authorized_areas
      WHERE organization_id = $1
        AND ST_Covers(boundary, ST_SetSRID(ST_GeomFromGeoJSON($2), 4326))
    ) AS permitted`,
    [organizationId, boundaryJson],
  );
  if (!result.rows[0]?.permitted) throw new FieldGeometryError("地块边界不在当前账户的授权范围内。");
}

function hasSelfIntersection(points: Position[]): boolean {
  for (let index = 0; index < points.length - 1; index += 1) for (let other = index + 1; other < points.length - 1; other += 1) {
    if (Math.abs(index - other) <= 1 || (index === 0 && other === points.length - 2)) continue;
    if (segmentsIntersect(points[index]!, points[index + 1]!, points[other]!, points[other + 1]!)) return true;
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

function boundaryFromGeoJson(value: unknown): Position[] {
  const coordinates = (value as { coordinates: Array<Array<[number, number]>> }).coordinates[0] ?? [];
  return coordinates.map(([longitude, latitude]) => ({ longitude, latitude }));
}

function sameBoundary(left: Position[], right: Position[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((point, index) => {
    const other = right[index]!;
    return Math.abs(point.longitude - other.longitude) <= 1e-8 && Math.abs(point.latitude - other.latitude) <= 1e-8;
  });
}

function polygonGeoJson(boundary: Position[]) { return JSON.stringify({ type: "Polygon", coordinates: [boundary.map((point) => [point.longitude, point.latitude])] }); }

const FIELD_SELECT = `SELECT f.id, f.organization_id, f.name, f.boundary_version,
  ST_AsGeoJSON(f.boundary)::json AS boundary, ST_Area(f.boundary::geography) / 10000 AS area_ha,
  ST_X(ST_Centroid(f.boundary)) AS longitude, ST_Y(ST_Centroid(f.boundary)) AS latitude,
  s.crop, s.season_year, to_char(s.planting_date, 'YYYY-MM-DD') AS planting_date, s.variety,
  (SELECT count(*) FROM field_seasons active_season WHERE active_season.field_id = f.id AND active_season.archived_at IS NULL) AS season_count
  FROM fields f
  JOIN LATERAL (
    SELECT crop, season_year, planting_date, variety FROM field_seasons
    WHERE field_id = f.id AND archived_at IS NULL
    ORDER BY season_year DESC, updated_at DESC LIMIT 1
  ) s ON true
  WHERE f.archived_at IS NULL`;

async function readField(pool: pg.Pool, id: string, organizationId: string): Promise<FieldSummary> {
  const result = await pool.query(`${FIELD_SELECT} AND f.organization_id = $1 AND f.id = $2`, [organizationId, id]);
  return toFieldSummary(result.rows[0]!);
}

function toFieldSummary(row: Record<string, unknown>): FieldSummary {
  const boundary = (row.boundary as { coordinates: Array<Array<[number, number]>> }).coordinates[0]!.map(([longitude, latitude]) => ({ longitude, latitude }));
  return {
    id: String(row.id), organizationId: String(row.organization_id), code: `FIELD-${String(row.id).slice(0, 8).toUpperCase()}`,
    name: String(row.name), crop: row.crop as FieldSummary["crop"], seasonYear: Number(row.season_year), plantingDate: row.planting_date ? String(row.planting_date) : null, variety: row.variety ? String(row.variety) : null,
    areaHa: Number(row.area_ha), village: "", boundary, centroid: { longitude: Number(row.longitude), latitude: Number(row.latitude) }, boundaryVersion: Number(row.boundary_version), seasonCount: Number(row.season_count), latestStatus: "not_analyzed", latestAnalyzedAt: null,
  };
}
