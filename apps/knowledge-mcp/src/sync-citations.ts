import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import pg from "pg";

const { Pool } = pg;

const envPath = resolve(import.meta.dirname, "../../../.env");
if (existsSync(envPath)) loadEnvFile(envPath);

interface ManifestEntry {
  documentTitle: string;
  sourceId: string;
  locator: string;
}

interface CitationRow {
  textUnitId: string;
  sourceId: string;
  locator: string;
  excerpt: string;
  relatedEntities: string[];
}

const [indexRunId, dataDirectory, manifestPath] = process.argv.slice(2).filter((argument) => argument !== "--");
if (!indexRunId || !dataDirectory || !manifestPath) {
  throw new Error("Usage: pnpm knowledge:sync -- <indexRunId> <GraphRAG output directory> <manifest.json>");
}
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");
const python = process.env.GRAPHRAG_PYTHON;
if (!python) throw new Error("GRAPHRAG_PYTHON is required.");

const manifest = parseManifest(JSON.parse(await readFile(resolve(manifestPath), "utf8")));
const rows = await extractRows(python, resolve(dataDirectory), manifest);
const pool = new Pool({ connectionString: databaseUrl });
const client = await pool.connect();
try {
  await client.query("BEGIN");
  const run = await client.query("SELECT status FROM knowledge_index_runs WHERE id = $1 FOR UPDATE", [indexRunId]);
  if (run.rows[0]?.status !== "completed") throw new Error("Knowledge index run must exist and be completed.");
  const existing = await client.query("SELECT count(*)::integer AS count FROM knowledge_text_units WHERE index_run_id = $1", [indexRunId]);
  if (Number(existing.rows[0]?.count ?? 0) > 0) throw new Error("Knowledge citation map already exists for this immutable index run.");
  const registered = await client.query(
    "SELECT source_id::text FROM knowledge_index_run_sources WHERE index_run_id = $1",
    [indexRunId],
  );
  const registeredSources = new Set(registered.rows.map((row) => String(row.source_id)));
  const unknownSources = [...new Set(rows.map((row) => row.sourceId))].filter((sourceId) => !registeredSources.has(sourceId));
  if (unknownSources.length) throw new Error(`Manifest contains sources outside the index run: ${unknownSources.join(", ")}`);

  for (const row of rows) {
    await client.query(
      `INSERT INTO knowledge_text_units
        (index_run_id, text_unit_id, source_id, locator, excerpt, related_entities)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [indexRunId, row.textUnitId, row.sourceId, row.locator, row.excerpt, row.relatedEntities],
    );
  }
  await client.query("COMMIT");
  console.log(JSON.stringify({ indexRunId, textUnits: rows.length, sources: new Set(rows.map((row) => row.sourceId)).size }));
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
  await pool.end();
}

function parseManifest(value: unknown): ManifestEntry[] {
  const entries = (value as { entries?: unknown })?.entries;
  if (!Array.isArray(entries) || entries.length === 0) throw new Error("Manifest entries are required.");
  return entries.map((entry, index) => {
    const candidate = entry as Partial<ManifestEntry>;
    if (!candidate || typeof candidate.documentTitle !== "string" || typeof candidate.sourceId !== "string" || typeof candidate.locator !== "string") {
      throw new Error(`Manifest entry ${index + 1} is invalid.`);
    }
    return { documentTitle: candidate.documentTitle.trim(), sourceId: candidate.sourceId.trim(), locator: candidate.locator.trim() };
  });
}

function extractRows(python: string, data: string, manifest: ManifestEntry[]): Promise<CitationRow[]> {
  const script = resolve(import.meta.dirname, "../scripts/extract-citation-map.py");
  return new Promise((resolveRows, reject) => {
    const child = spawn(python, [script], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(stderr.trim().slice(0, 500) || `Citation extractor exited with code ${code}.`));
      try {
        const rows = JSON.parse(stdout) as unknown;
        if (!Array.isArray(rows) || rows.length === 0) throw new Error("Citation extractor returned no rows.");
        resolveRows(rows as CitationRow[]);
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(JSON.stringify({ data, manifest }));
  });
}
