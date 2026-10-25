import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { access } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { loadEnvFile } from "node:process";

import pg from "pg";

import { buildKnowledgeIndexPlan } from "./knowledge-index-plan.js";

const { Pool } = pg;
const workspaceRoot = resolve(import.meta.dirname, "../../..");
const envPath = resolve(workspaceRoot, ".env");
if (existsSync(envPath)) loadEnvFile(envPath);

const [indexRunId, rootArgument] = process.argv.slice(2).filter((argument) => argument !== "--");
if (!indexRunId) throw new Error("Usage: pnpm knowledge:index -- <indexRunId> [GraphRAG root]");
const graphRagRoot = resolve(workspaceRoot, rootArgument ?? process.env.GRAPHRAG_ROOT ?? "runtime/knowledge/graphrag");
const python = resolve(workspaceRoot, process.env.GRAPHRAG_PYTHON ?? "runtime/graphrag-venv/Scripts/python.exe");
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required to run a knowledge index plan.");

const plan = await buildKnowledgeIndexPlan(
  graphRagRoot,
  resolve(workspaceRoot, "apps/knowledge-mcp/requirements.txt"),
  workspaceRoot,
);
const apiBase = process.env.GRAPHRAG_API_BASE ?? process.env.OPENAI_BASE_URL;
const apiKey = process.env.GRAPHRAG_API_KEY ?? process.env.OPENAI_API_KEY;
if (!apiBase) throw new Error("GRAPHRAG_API_BASE or OPENAI_BASE_URL is required to run GraphRAG.");
if (!apiKey) throw new Error("GRAPHRAG_API_KEY or OPENAI_API_KEY is required to run GraphRAG.");
const pool = new Pool({ connectionString: databaseUrl });
try {
  await claimRun(pool, indexRunId, plan);
  const execution = await runGraphRag(python, graphRagRoot, apiKey);
  if (execution.exitCode !== 0) {
    await failRun(pool, indexRunId, execution.exitCode, execution.failureMessage);
    throw new Error(`GraphRAG index failed with exit code ${execution.exitCode}.`);
  }
  const artifacts = await validateGraphRagOutput(graphRagRoot, workspaceRoot);
  await completeRun(pool, indexRunId, artifacts);
  console.log(JSON.stringify({ indexRunId, status: "completed", ...artifacts }));
} catch (error) {
  if (await isRunRunning(pool, indexRunId)) await failRun(pool, indexRunId, null, "GraphRAG process did not complete.");
  throw error;
} finally {
  await pool.end();
}

interface PlanIdentity {
  graphragVersion: string;
  configSha256: string;
  promptVersion: string;
  sourceSetSha256: string;
}

async function claimRun(pool: pg.Pool, id: string, plan: PlanIdentity): Promise<void> {
  const result = await pool.query<{ status: string }>(
    `UPDATE knowledge_index_runs
       SET status = 'running', started_at = now(), completed_at = NULL, error = NULL
     WHERE id = $1
       AND status IN ('planned', 'failed')
       AND graphrag_version = $2 AND config_sha256 = $3 AND prompt_version = $4 AND source_set_sha256 = $5
     RETURNING status`,
    [id, plan.graphragVersion, plan.configSha256, plan.promptVersion, plan.sourceSetSha256],
  );
  if (result.rowCount !== 1) {
    const existing = await pool.query<{ status: string }>("SELECT status FROM knowledge_index_runs WHERE id = $1", [id]);
    const status = existing.rows[0]?.status;
    throw new Error(status
      ? `Knowledge index run ${id} is ${status} or no longer matches the current immutable inputs.`
      : `Knowledge index run ${id} does not exist.`);
  }
}

function runGraphRag(python: string, root: string, apiKey: string): Promise<{ exitCode: number; failureMessage: string | null }> {
  return new Promise((resolveExit, reject) => {
    const child = spawn(python, ["-m", "graphrag", "index", "--root", root], {
      cwd: workspaceRoot,
      env: {
        ...process.env,
        GRAPHRAG_API_BASE: process.env.GRAPHRAG_API_BASE ?? process.env.OPENAI_BASE_URL,
        GRAPHRAG_API_KEY: process.env.GRAPHRAG_API_KEY ?? process.env.OPENAI_API_KEY,
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      const safe = redactProviderOutput(chunk, apiKey);
      process.stdout.write(safe);
      output = `${output}${safe}`.slice(-4_000);
    });
    child.stderr.on("data", (chunk: string) => {
      const safe = redactProviderOutput(chunk, apiKey);
      process.stderr.write(safe);
      output = `${output}${safe}`.slice(-4_000);
    });
    child.on("error", reject);
    child.on("close", (code) => resolveExit({
      exitCode: code ?? 1,
      failureMessage: output.trim() ? output.trim().slice(-1_000) : null,
    }));
  });
}

export async function validateGraphRagOutput(root: string, repositoryRoot: string): Promise<{
  outputTablesRef: string;
  vectorStoreRef: string;
}> {
  const output = resolve(root, "output");
  const required = ["documents.parquet", "text_units.parquet", "entities.parquet", "relationships.parquet"];
  await Promise.all(required.map((name) => access(resolve(output, name))));
  const vectorStore = resolve(output, "lancedb");
  await access(vectorStore);
  return {
    outputTablesRef: repositoryRelative(output, repositoryRoot),
    vectorStoreRef: repositoryRelative(vectorStore, repositoryRoot),
  };
}

async function completeRun(
  pool: pg.Pool,
  id: string,
  artifacts: { outputTablesRef: string; vectorStoreRef: string },
): Promise<void> {
  const result = await pool.query(
    `UPDATE knowledge_index_runs
       SET status = 'completed', output_tables_ref = $2, vector_store_ref = $3, completed_at = now(), error = NULL
     WHERE id = $1 AND status = 'running'`,
    [id, artifacts.outputTablesRef, artifacts.vectorStoreRef],
  );
  if (result.rowCount !== 1) throw new Error(`Knowledge index run ${id} left the running state before publication.`);
}

async function failRun(pool: pg.Pool, id: string, exitCode: number | null, message: string | null): Promise<void> {
  await pool.query(
    `UPDATE knowledge_index_runs
       SET status = 'failed', completed_at = now(), error = $2
     WHERE id = $1 AND status = 'running'`,
    [id, {
      code: "graphrag_index_failed",
      ...(exitCode === null ? {} : { exitCode }),
      ...(message ? { message } : {}),
    }],
  );
}

function redactProviderOutput(value: string, apiKey: string): string {
  return value
    .replaceAll(apiKey, "[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~-]{8,}/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "[REDACTED]");
}

async function isRunRunning(pool: pg.Pool, id: string): Promise<boolean> {
  const result = await pool.query<{ running: boolean }>(
    "SELECT status = 'running' AS running FROM knowledge_index_runs WHERE id = $1",
    [id],
  );
  return result.rows[0]?.running === true;
}

function repositoryRelative(path: string, root: string): string {
  const result = relative(resolve(root), path).replaceAll("\\", "/");
  if (!result || result.startsWith("../") || result === ".." || /^[a-z]:\//i.test(result)) {
    throw new Error(`GraphRAG artifact is outside the repository: ${path}`);
  }
  return result;
}
