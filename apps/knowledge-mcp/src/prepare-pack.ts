import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";

import pg from "pg";

import { prepareKnowledgePack, readKnowledgePackSpec, registerKnowledgeSources } from "./knowledge-pack.js";

const { Pool } = pg;
const workspaceRoot = resolve(import.meta.dirname, "../../..");
const envPath = resolve(workspaceRoot, ".env");
if (existsSync(envPath)) loadEnvFile(envPath);

const [specArgument, rootArgument] = process.argv.slice(2).filter((argument) => argument !== "--");
const specPath = resolve(workspaceRoot, specArgument ?? "docs/knowledge-sources/growth-monitoring-v1.json");
const rootPath = resolve(workspaceRoot, rootArgument ?? process.env.GRAPHRAG_ROOT ?? "runtime/knowledge/graphrag");
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required to register the immutable knowledge source snapshot.");

const spec = await readKnowledgePackSpec(specPath);
const prepared = await prepareKnowledgePack(spec, rootPath, fetch, workspaceRoot);
const pool = new Pool({ connectionString: databaseUrl });
try {
  await registerKnowledgeSources(pool, prepared);
} finally {
  await pool.end();
}
console.log(JSON.stringify({
  packId: prepared.packId,
  sources: prepared.sources.length,
  indexedSources: prepared.sources.filter((source) => source.documentCount > 0).length,
  citationOnlySources: prepared.sources.filter((source) => source.documentCount === 0).length,
  documents: prepared.documents,
  manifest: prepared.manifestPath,
}));
