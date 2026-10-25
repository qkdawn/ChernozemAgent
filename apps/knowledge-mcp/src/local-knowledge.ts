import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { AgronomyKnowledgeSearchInput, AgronomyKnowledgeSearchResult, AnalysisObjective } from "@chernozem/contracts";
import type { Pool } from "pg";
import { z } from "zod";
import type { PreparedKnowledgePack } from "./knowledge-pack.js";

// Change this when passage splitting or ranking changes, so published versions remain replayable.
export const LOCAL_ENGINE_VERSION = "extractive-bilingual-v2";
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const ManifestSchema = z.object({
  packId: z.string(),
  entries: z.array(z.object({
    documentTitle: z.string().regex(/^[a-z0-9][a-z0-9._-]*\.txt$/),
    sourceId: z.string().uuid(), locator: z.string().min(1), contentSha256: z.string().regex(/^[0-9a-f]{64}$/),
  })).min(1),
});

export interface LocalPassage {
  passageId: string; sourceId: string; sourceVersion: string; sourceSha256: string;
  locator: string; excerpt: string; keywords: string[]; applicabilityNote: string;
}
export interface LocalCollection {
  packId: string; fingerprint: string; manifest: unknown; passages: LocalPassage[];
}

/** Only verified chapter inputs are consumed; metadata headers never become evidence excerpts. */
export async function buildLocalCollection(pack: PreparedKnowledgePack): Promise<LocalCollection> {
  const manifest = ManifestSchema.parse(JSON.parse(await readFile(pack.manifestPath, "utf8")));
  if (manifest.packId !== pack.packId) throw new Error("Knowledge manifest pack mismatch.");
  const sources = new Map(pack.sources.map((source) => [source.spec.id, source]));
  const seen = new Set<string>();
  for (const source of pack.sources) {
    if (!source.spec.content) continue;
    const xml = await readFile(resolve(pack.root, "sources", source.spec.content.fileName));
    if (sha256(xml) !== source.contentSha256) throw new Error("Knowledge source hash mismatch.");
  }
  const passages: LocalPassage[] = [];
  for (const entry of manifest.entries) {
    if (seen.has(entry.documentTitle)) throw new Error("Duplicate knowledge document.");
    seen.add(entry.documentTitle);
    const source = sources.get(entry.sourceId);
    if (!source?.spec.content || !source.contentSha256) throw new Error("Unlicensed or unknown knowledge source.");
    const text = await readFile(resolve(pack.root, "input", entry.documentTitle), "utf8");
    if (sha256(text) !== entry.contentSha256) throw new Error("Knowledge document hash mismatch.");
    const bodyStart = text.indexOf("\n\n");
    if (bodyStart < 0) throw new Error("Knowledge document has no original body.");
    const body = text.slice(bodyStart + 2).trim();
    // Exact substrings; offsets make long paragraphs independently locatable.
    for (let start = 0; start < body.length;) {
      let end = Math.min(start + 1800, body.length);
      if (end < body.length) {
        const paragraph = body.lastIndexOf("\n\n", end);
        const sentence = body.lastIndexOf(". ", end - 1);
        const boundary = paragraph > start + 600 ? paragraph : sentence > start + 900 ? sentence + 1 : body.lastIndexOf(" ", end);
        if (boundary > start + 600) end = boundary;
      }
      const excerpt = body.slice(start, end).trim();
      if (excerpt) passages.push({
        passageId: sha256(`${entry.documentTitle}:${start}:${end}`),
        sourceId: source.spec.id, sourceVersion: source.spec.version, sourceSha256: source.contentSha256,
        locator: `${entry.locator} · extracted text chars ${start + 1}–${end}`,
        excerpt, keywords: source.spec.retrievalKeywords, applicabilityNote: source.spec.applicabilityNote,
      });
      start = end;
    }
  }
  for (const source of pack.sources) {
    const count = manifest.entries.filter((entry) => entry.sourceId === source.spec.id).length;
    if (count !== source.documentCount) throw new Error("Knowledge source chapter count mismatch.");
  }
  const snapshot = pack.sources.map((source) => ({
    source: source.spec, contentSha256: source.contentSha256,
  }));
  return {
    packId: pack.packId,
    fingerprint: sha256(JSON.stringify({ engine: LOCAL_ENGINE_VERSION, manifest, snapshot })),
    manifest: { ...manifest, sources: snapshot }, passages,
  };
}

/** Publish the entire collection in one transaction. Concurrent identical builds reuse one id. */
export async function publishLocalCollection(pool: Pool, collection: LocalCollection) {
  if (!collection.passages.length) throw new Error("Cannot publish an empty knowledge collection.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [collection.fingerprint]);
    const existing = await client.query("SELECT id, passage_count FROM knowledge_local_indexes WHERE fingerprint = $1", [collection.fingerprint]);
    if (existing.rows[0]) {
      await client.query("COMMIT");
      return { indexId: String(existing.rows[0].id), passages: Number(existing.rows[0].passage_count), reused: true };
    }
    const inserted = await client.query(
      `INSERT INTO knowledge_local_indexes(pack_id, fingerprint, engine_version, manifest, passage_count)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [collection.packId, collection.fingerprint, LOCAL_ENGINE_VERSION, JSON.stringify(collection.manifest), collection.passages.length],
    );
    const indexId = String(inserted.rows[0].id);
    for (const passage of collection.passages) {
      const result = await client.query(
        `INSERT INTO knowledge_local_passages
         (index_id, passage_id, source_id, source_version, source_sha256, locator, excerpt, keywords, applicability_note)
         SELECT $1,$2,id,$4,$5,$6,$7,$8,$9 FROM knowledge_sources
         WHERE id=$3 AND status='published' AND license_status='public'
           AND version=$4 AND content_sha256=$5 AND license_ref LIKE 'https://creativecommons.org/licenses/by/%'`,
        [indexId, passage.passageId, passage.sourceId, passage.sourceVersion, passage.sourceSha256,
          passage.locator, passage.excerpt, passage.keywords, passage.applicabilityNote],
      );
      if (result.rowCount !== 1) throw new Error("Knowledge source snapshot is not published or has changed.");
    }
    await client.query("COMMIT");
    return { indexId, passages: collection.passages.length, reused: false };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}

export interface SearchablePassage extends LocalPassage {
  title: string; regions: string[]; stages: string[]; sourceUrl: string | null;
  identifierType: "doi" | "isbn" | "standard" | "internal"; identifier: string;
}
export interface LocalKnowledgeRepository {
  resolveScope(input: AgronomyKnowledgeSearchInput): Promise<{ indexId: string; objective: AnalysisObjective | null } | null>;
  passages(indexId: string, objective: AnalysisObjective | null): Promise<SearchablePassage[]>;
}

export class LocalKnowledgeService {
  constructor(private readonly repository: LocalKnowledgeRepository) {}
  async search(input: AgronomyKnowledgeSearchInput): Promise<AgronomyKnowledgeSearchResult> {
    let indexId: string | null = null;
    try {
      const scope = await this.repository.resolveScope(input);
      if (!scope) return unavailable("knowledge_scope_unavailable", "该范围没有可用的已发布玉米知识索引。", false);
      indexId = scope.indexId;
      const candidates = await this.repository.passages(indexId, scope.objective);
      const ranked = rankPassages(input.query, candidates);
      return {
        status: ranked.length ? "succeeded" : "no_matches", indexRunRef: indexId, answer: null,
        matches: ranked.map((p) => ({
          excerpt: p.excerpt, textUnitIds: [p.passageId], relatedEntities: [],
          applicability: { regions: p.regions, crops: ["corn"], stages: p.stages },
          citation: { sourceId: p.sourceId, title: p.title, locator: p.locator, sourceUrl: p.sourceUrl,
            identifier: { type: p.identifierType, value: p.identifier }, version: p.sourceVersion },
        })),
        limitations: ranked.length
          ? [...new Set(ranked.map((p) => `${p.title}：${p.applicabilityNote}`))]
          : ["已发布材料中未检索到适用于当前任务的原文；请补充具体农学问题。"],
        error: null,
      };
    } catch {
      return { ...unavailable("local_knowledge_query_failed", "本地知识检索暂时不可用。", true), indexRunRef: indexId };
    }
  }
}

function unavailable(code: string, message: string, retryable: boolean): AgronomyKnowledgeSearchResult {
  return { status: "unavailable", indexRunRef: null, answer: null, matches: [], limitations: [], error: { code, message, retryable } };
}

export function createLocalKnowledgeRepository(pool: Pool, organizationId: string): LocalKnowledgeRepository {
  return {
    async resolveScope(input) {
      const response = await pool.query(
        "taskId" in input
          ? `SELECT t.objective, i.id FROM analysis_tasks t
             JOIN fields f ON f.id=t.field_id AND f.organization_id=t.organization_id
             CROSS JOIN LATERAL (SELECT id FROM knowledge_local_indexes WHERE engine_version=$3
               ORDER BY published_at DESC, id DESC LIMIT 1) i
             WHERE t.id::text=$1 AND t.organization_id=$2 AND f.crop='corn' AND f.archived_at IS NULL`
          : `SELECT NULL::text AS objective, i.id FROM fields f
             CROSS JOIN LATERAL (SELECT id FROM knowledge_local_indexes WHERE engine_version=$3
               ORDER BY published_at DESC, id DESC LIMIT 1) i
             WHERE f.id::text=$1 AND f.organization_id=$2 AND f.crop='corn' AND f.archived_at IS NULL`,
        ["taskId" in input ? input.taskId : input.fieldId, organizationId, LOCAL_ENGINE_VERSION],
      );
      const row = response.rows[0];
      return row ? { indexId: String(row.id), objective: row.objective as AnalysisObjective | null } : null;
    },
    async passages(indexId, objective) {
      const result = await pool.query(
        `SELECT p.*, s.title, s.regions, s.stages, s.source_url, s.identifier_type, s.identifier
         FROM knowledge_local_passages p JOIN knowledge_sources s ON s.id=p.source_id
         WHERE p.index_id=$1 AND s.status='published' AND s.crop='corn' AND s.license_status='public'
           AND s.version=p.source_version AND s.content_sha256=p.source_sha256
           AND ($2::text IS NULL OR $2=ANY(s.capabilities))
           AND s.regions && ARRAY['通用方法','东北中国','东北平原','东北黑土区','辽宁','辽宁省','铁岭','铁岭市']::text[]
         ORDER BY p.passage_id`, [indexId, objective],
      );
      return result.rows.map((row) => ({
        passageId: row.passage_id, sourceId: row.source_id, sourceVersion: row.source_version,
        sourceSha256: row.source_sha256, locator: row.locator, excerpt: row.excerpt, keywords: row.keywords,
        applicabilityNote: row.applicability_note, title: row.title, regions: row.regions, stages: row.stages,
        sourceUrl: row.source_url, identifierType: row.identifier_type, identifier: row.identifier,
      }));
    },
  };
}

// Curated query vocabulary only translates concepts, never produces agricultural claims or thresholds.
const CONCEPTS = [
  ["红边", "ndre", "red edge", "red-edge"],
  ["叶绿素", "叶色", "chlorophyll"],
  ["缺氮", "氮素", "氮肥", "施肥", "nitrogen", "fertilization", "nni"],
  ["土壤", "soil", "ph"],
  ["干旱", "缺水", "水分", "drought", "water stress", "moisture"],
  ["积水", "内涝", "涝害", "淹水", "waterlogging", "inundated", "inundation", "flood"],
  ["雷达", "sar", "sentinel-1", "backscatter", "极化"],
  ["冠层", "lai", "canopy", "vegetation optical depth"],
  ["生育期", "物候", "phenolog", "developmental stage"],
  ["积温", "播期", "播种", "成熟", "sowing", "maturity", "growing degree", "thermal time"],
  ["霜冻", "冻害", "冷害", "低温", "chilling", "cold", "frost", "low temperature"],
  ["长势", "生长", "growth", "ndvi", "vegetation index", "vegetation indices"],
  ["云污染", "多云", "云量", "cloud"],
];

export function rankPassages(query: string, passages: SearchablePassage[]): SearchablePassage[] {
  const normalized = query.toLowerCase();
  const groups = CONCEPTS.filter((group) => group.some((term) => containsTerm(normalized, term)));
  const english = normalized.match(/[a-z][a-z0-9-]{2,}/g) ?? [];
  const terms = [...new Set(english.filter((term) => !["the", "why", "how", "maize", "corn", "and", "can", "does", "what"].includes(term)))];
  if (!groups.length && !terms.length) return [];
  const scored = passages.map((p) => {
    const body = p.excerpt.toLowerCase();
    const heading = `${p.title} ${p.keywords.join(" ")}`.toLowerCase();
    // A source-level keyword is insufficient: at least one concept must occur in the original passage.
    const bodyGroups = groups.filter((g) => g.some((t) => containsTerm(body, t))).length;
    const literal = terms.filter((t) => containsTerm(body, t)).length;
    const headingGroups = groups.filter((g) => g.some((t) => containsTerm(heading, t))).length;
    const sufficientCoverage = groups.length ? bodyGroups >= Math.ceil(groups.length * 0.6) : literal > 0;
    const score = bodyGroups * 4 + literal * 2 + headingGroups * 3;
    return { p, score: sufficientCoverage ? score : 0 };
  }).filter((item) => item.score > 0).sort((a, b) => b.score - a.score || a.p.passageId.localeCompare(b.p.passageId));
  const counts = new Map<string, number>();
  const results: SearchablePassage[] = [];
  const threshold = (scored[0]?.score ?? 0) * 0.8;
  for (const { p, score } of scored) {
    if (score < threshold) break;
    if ((counts.get(p.sourceId) ?? 0) >= 2) continue;
    counts.set(p.sourceId, (counts.get(p.sourceId) ?? 0) + 1);
    results.push(p);
    if (results.length === 5) break;
  }
  return results;
}

function containsTerm(text: string, term: string): boolean {
  if (/[\u4e00-\u9fff]/u.test(term)) return text.includes(term);
  // Avoid matching SAR in unrelated words, pH in physiology, or cold in scaffold names.
  return new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}${term === "phenolog" ? "[a-z]*" : ""}\\b`, "i").test(text);
}
