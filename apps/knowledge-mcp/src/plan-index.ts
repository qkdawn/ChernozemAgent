import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";

import pg from "pg";

import { buildKnowledgeIndexPlan, registerKnowledgeIndexPlan } from "./knowledge-index-plan.js";

const { Pool } = pg;
const workspaceRoot = resolve(import.meta.dirname, "../../..");
const envPath = resolve(workspaceRoot, ".env");
if (existsSync(envPath)) loadEnvFile(envPath);

const rootArgument = process.argv.slice(2).filter((argument) => argument !== "--")[0];
const graphRagRoot = resolve(workspaceRoot, rootArgument ?? process.env.GRAPHRAG_ROOT ?? "runtime/knowledge/graphrag");
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required to register the knowledge index plan.");

const plan = await buildKnowledgeIndexPlan(
  graphRagRoot,
  resolve(workspaceRoot, "apps/knowledge-mcp/requirements.txt"),
  workspaceRoot,
);
const pool = new Pool({ connectionString: databaseUrl });
try {
  const registered = await registerKnowledgeIndexPlan(pool, plan);
  console.log(JSON.stringify({
    indexRunId: registered.id,
    status: registered.status,
    created: registered.created,
    sources: registered.sources.length,
    documents: registered.documentCount,
    chatModel: registered.chatModelRef,
    embeddingModel: registered.embeddingModelRef,
  }));
} finally {
  await pool.end();
}
