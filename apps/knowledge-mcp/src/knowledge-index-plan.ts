import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { relative, resolve } from "node:path";

import type { Pool } from "pg";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const SnapshotSchema = z.object({
  schemaVersion: z.literal("1.0"),
  packId: z.string().min(1),
  sources: z.array(z.object({
    id: z.string().uuid(),
    version: z.string().min(1),
    contentSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
    documentCount: z.number().int().nonnegative(),
  })).min(1),
});

const ManifestSchema = z.object({
  schemaVersion: z.literal("1.0"),
  packId: z.string().min(1),
  entries: z.array(z.object({
    documentTitle: z.string().min(1),
    sourceId: z.string().uuid(),
    locator: z.string().min(1),
    contentSha256: z.string().regex(/^[0-9a-f]{64}$/),
  })).min(1),
});

const ModelSchema = z.object({
  model_provider: z.string().min(1),
  model: z.string().min(1),
});

const SettingsSchema = z.object({
  completion_models: z.object({ default_completion_model: ModelSchema }),
  embedding_models: z.object({ default_embedding_model: ModelSchema }),
});

export interface KnowledgeIndexPlan {
  graphragVersion: string;
  configSha256: string;
  promptVersion: string;
  chatModelRef: string;
  embeddingModelRef: string;
  sourceSetSha256: string;
  inputManifestRef: string;
  sources: Array<{ id: string; version: string; contentSha256: string }>;
  documentCount: number;
}

export interface RegisteredKnowledgeIndexPlan extends KnowledgeIndexPlan {
  id: string;
  status: string;
  created: boolean;
}

export async function buildKnowledgeIndexPlan(
  graphRagRoot: string,
  requirementsPath: string,
  repositoryRoot: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<KnowledgeIndexPlan> {
  const root = resolve(graphRagRoot);
  const settingsPath = resolve(root, "settings.yaml");
  const snapshotPath = resolve(root, "source-snapshot.json");
  const manifestPath = resolve(root, "input-manifest.json");
  const [settingsText, snapshotText, manifestText, requirementsText, promptFiles] = await Promise.all([
    readFile(settingsPath, "utf8"),
    readFile(snapshotPath, "utf8"),
    readFile(manifestPath, "utf8"),
    readFile(resolve(requirementsPath), "utf8"),
    readPromptFiles(resolve(root, "prompts")),
  ]);
  const settingsValue = parseYaml(resolveSettingsEnvironment(settingsText, environment)) as unknown;
  const settings = SettingsSchema.parse(settingsValue);
  const snapshot = SnapshotSchema.parse(JSON.parse(snapshotText));
  const manifest = ManifestSchema.parse(JSON.parse(manifestText));
  if (snapshot.packId !== manifest.packId) throw new Error("Knowledge source snapshot and input manifest use different pack IDs.");
  await verifyConfiguredPromptFiles(settingsValue, root);

  const sources = snapshot.sources
    .filter((source): source is typeof source & { contentSha256: string } => source.contentSha256 !== null)
    .map((source) => ({ id: source.id, version: source.version, contentSha256: source.contentSha256 }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const sourceIds = new Set(sources.map((source) => source.id));
  const manifestCounts = new Map<string, number>();
  const documentTitles = new Set<string>();
  for (const entry of manifest.entries) {
    if (!sourceIds.has(entry.sourceId)) throw new Error(`Manifest document ${entry.documentTitle} has no indexable source snapshot.`);
    if (documentTitles.has(entry.documentTitle)) throw new Error(`Manifest contains duplicate document title ${entry.documentTitle}.`);
    documentTitles.add(entry.documentTitle);
    const document = await readFile(resolve(root, "input", entry.documentTitle));
    if (sha256(document) !== entry.contentSha256) {
      throw new Error(`GraphRAG input document hash mismatch: ${entry.documentTitle}.`);
    }
    manifestCounts.set(entry.sourceId, (manifestCounts.get(entry.sourceId) ?? 0) + 1);
  }
  for (const source of snapshot.sources) {
    const actual = manifestCounts.get(source.id) ?? 0;
    if (actual !== source.documentCount) {
      throw new Error(`Knowledge source ${source.id} expects ${source.documentCount} documents but manifest contains ${actual}.`);
    }
  }

  const graphragVersion = requirementsText.match(/^graphrag==([^\s]+)$/m)?.[1];
  if (!graphragVersion) throw new Error("requirements.txt must pin an exact graphrag version.");
  const safeSettings = removeCredentialFields(settingsValue);
  const promptVersion = `sha256:${sha256(canonicalJson(promptFiles))}`;
  return {
    graphragVersion,
    configSha256: sha256(canonicalJson(safeSettings)),
    promptVersion,
    chatModelRef: `${settings.completion_models.default_completion_model.model_provider}:${settings.completion_models.default_completion_model.model}`,
    embeddingModelRef: `${settings.embedding_models.default_embedding_model.model_provider}:${settings.embedding_models.default_embedding_model.model}`,
    sourceSetSha256: sha256(canonicalJson(sources)),
    inputManifestRef: repositoryRelative(manifestPath, repositoryRoot),
    sources,
    documentCount: manifest.entries.length,
  };
}

export async function registerKnowledgeIndexPlan(pool: Pool, plan: KnowledgeIndexPlan): Promise<RegisteredKnowledgeIndexPlan> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const inserted = await client.query<{ id: string; status: string }>(
      `INSERT INTO knowledge_index_runs
        (graphrag_version, config_sha256, prompt_version, chat_model_ref, embedding_model_ref,
         source_set_sha256, input_manifest_ref, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'planned')
       ON CONFLICT (graphrag_version, config_sha256, prompt_version, source_set_sha256) DO NOTHING
       RETURNING id::text, status`,
      [
        plan.graphragVersion, plan.configSha256, plan.promptVersion, plan.chatModelRef,
        plan.embeddingModelRef, plan.sourceSetSha256, plan.inputManifestRef,
      ],
    );
    const created = inserted.rowCount === 1;
    const existing = created ? inserted : await client.query<{ id: string; status: string }>(
      `SELECT id::text, status FROM knowledge_index_runs
       WHERE graphrag_version = $1 AND config_sha256 = $2 AND prompt_version = $3 AND source_set_sha256 = $4
       FOR UPDATE`,
      [plan.graphragVersion, plan.configSha256, plan.promptVersion, plan.sourceSetSha256],
    );
    const row = existing.rows[0];
    if (!row) throw new Error("Unable to create or locate the immutable knowledge index plan.");

    for (const source of plan.sources) {
      await client.query(
        `INSERT INTO knowledge_index_run_sources (index_run_id, source_id, source_version, content_sha256)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (index_run_id, source_id) DO NOTHING`,
        [row.id, source.id, source.version, source.contentSha256],
      );
    }
    const linked = await client.query<{ count: number }>(
      "SELECT count(*)::integer AS count FROM knowledge_index_run_sources WHERE index_run_id = $1",
      [row.id],
    );
    if (Number(linked.rows[0]?.count ?? 0) !== plan.sources.length) {
      throw new Error("Knowledge index plan source snapshot is incomplete.");
    }
    await client.query("COMMIT");
    return { ...plan, id: row.id, status: row.status, created };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function readPromptFiles(directory: string): Promise<Array<{ name: string; content: string }>> {
  const names = (await readdir(directory)).filter((name) => name.endsWith(".txt")).sort();
  if (!names.length) throw new Error("GraphRAG prompt directory contains no .txt files.");
  return Promise.all(names.map(async (name) => ({ name, content: await readFile(resolve(directory, name), "utf8") })));
}

async function verifyConfiguredPromptFiles(value: unknown, root: string): Promise<void> {
  const paths = collectPromptPaths(value);
  if (!paths.length) throw new Error("GraphRAG settings contain no configured prompt files.");
  for (const path of paths) {
    const target = resolve(root, path);
    if (!repositoryRelative(target, root).startsWith("prompts/")) {
      throw new Error(`GraphRAG prompt path must remain inside the prompt directory: ${path}`);
    }
    try {
      await readFile(target, "utf8");
    } catch {
      throw new Error(`GraphRAG configured prompt does not exist: ${path}`);
    }
  }
}

function collectPromptPaths(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectPromptPaths);
  if (!value || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => {
    if ((key === "prompt" || key.endsWith("_prompt")) && typeof child === "string") return [child];
    return collectPromptPaths(child);
  });
}

function removeCredentialFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(removeCredentialFields);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !["api_key", "token", "password"].includes(key.toLowerCase()))
    .map(([key, child]) => [key, removeCredentialFields(child)]));
}

function resolveSettingsEnvironment(settings: string, environment: NodeJS.ProcessEnv): string {
  return settings.replace(/\$\{([A-Z][A-Z0-9_]*)\}/g, (_match, name: string) => {
    if (name.toLowerCase().includes("key") || name.toLowerCase().includes("token") || name.toLowerCase().includes("password")) {
      return "__credential_not_hashed__";
    }
    const value = environment[name] ?? (name === "GRAPHRAG_API_BASE"
      ? environment.OPENAI_BASE_URL
      : undefined);
    if (!value) throw new Error(`GraphRAG settings require environment variable ${name} before the index can be planned.`);
    return JSON.stringify(value);
  });
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function repositoryRelative(path: string, root: string): string {
  const result = relative(resolve(root), path).replaceAll("\\", "/");
  if (!result || result.startsWith("../") || result === ".." || /^[a-z]:\//i.test(result)) {
    throw new Error(`Knowledge artifact is outside the repository: ${path}`);
  }
  return result;
}
