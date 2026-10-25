import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import pg from "pg";
import { prepareKnowledgePack, readKnowledgePackSpec, registerKnowledgeSources } from "./knowledge-pack.js";
import { buildLocalCollection, publishLocalCollection, LOCAL_ENGINE_VERSION } from "./local-knowledge.js";

const workspace = resolve(import.meta.dirname, "../../..");
if (existsSync(resolve(workspace, ".env"))) loadEnvFile(resolve(workspace, ".env"));
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required.");
const [specArg, rootArg] = process.argv.slice(2).filter((arg) => arg !== "--");
const spec = await readKnowledgePackSpec(resolve(workspace, specArg ?? "docs/knowledge-sources/maize-evidence-v1.json"));
const root = resolve(workspace, rootArg ?? `runtime/knowledge/${spec.packId}`);
const pack = await prepareKnowledgePack(spec, root, fetch, workspace);
const collection = await buildLocalCollection(pack);
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
try {
  await registerKnowledgeSources(pool, pack);
  const result = await publishLocalCollection(pool, collection);
  console.log(JSON.stringify({ engine: LOCAL_ENGINE_VERSION, ...result, sources: pack.sources.length,
    indexedSources: pack.sources.filter((s) => s.documentCount).length, chapters: pack.documents, fingerprint: collection.fingerprint }));
} finally { await pool.end(); }
