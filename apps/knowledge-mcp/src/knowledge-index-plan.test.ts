import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { buildKnowledgeIndexPlan } from "./knowledge-index-plan.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("knowledge index planning", () => {
  it("derives a stable credential-free plan from a verified pack", async () => {
    const repository = await mkdtemp(resolve(tmpdir(), "chernozem-index-plan-"));
    cleanup.push(repository);
    const root = resolve(repository, "runtime/knowledge/graphrag");
    await mkdir(resolve(root, "prompts"), { recursive: true });
    await writeFile(resolve(root, "settings.yaml"), settings("first-secret"), "utf8");
    await writeFile(resolve(root, "prompts", "extract.txt"), "Extract maize facts.", "utf8");
    await writeFile(resolve(root, "source-snapshot.json"), JSON.stringify(snapshot()), "utf8");
    await mkdir(resolve(root, "input"), { recursive: true });
    await writeFile(resolve(root, "input", "source__01.txt"), "Verified input", "utf8");
    await writeFile(resolve(root, "input-manifest.json"), JSON.stringify(manifest()), "utf8");
    const requirements = resolve(repository, "requirements.txt");
    await writeFile(requirements, "graphrag==3.1.1\n", "utf8");

    const first = await buildKnowledgeIndexPlan(root, requirements, repository, { OPENAI_BASE_URL: "https://first.example/v1" });
    await writeFile(resolve(root, "settings.yaml"), settings("different-secret"), "utf8");
    const second = await buildKnowledgeIndexPlan(root, requirements, repository, { OPENAI_BASE_URL: "https://first.example/v1" });
    const differentGateway = await buildKnowledgeIndexPlan(root, requirements, repository, { GRAPHRAG_API_BASE: "https://second.example/v1" });

    expect(first).toMatchObject({
      graphragVersion: "3.1.1",
      chatModelRef: "openai:gpt-test",
      embeddingModelRef: "openai:embedding-test",
      inputManifestRef: "runtime/knowledge/graphrag/input-manifest.json",
      documentCount: 1,
    });
    expect(second.configSha256).toBe(first.configSha256);
    expect(differentGateway.configSha256).not.toBe(first.configSha256);
    expect(first.sources).toHaveLength(1);
  });

  it("rejects a manifest whose document count differs from the verified snapshot", async () => {
    const repository = await mkdtemp(resolve(tmpdir(), "chernozem-index-plan-"));
    cleanup.push(repository);
    const root = resolve(repository, "runtime/knowledge/graphrag");
    await mkdir(resolve(root, "prompts"), { recursive: true });
    await writeFile(resolve(root, "settings.yaml"), settings("secret"), "utf8");
    await writeFile(resolve(root, "prompts", "extract.txt"), "Prompt", "utf8");
    await writeFile(resolve(root, "source-snapshot.json"), JSON.stringify(snapshot()), "utf8");
    await mkdir(resolve(root, "input"), { recursive: true });
    await writeFile(resolve(root, "input", "source__01.txt"), "Verified input", "utf8");
    await writeFile(resolve(root, "input-manifest.json"), JSON.stringify({ ...manifest(), entries: [] }), "utf8");
    const requirements = resolve(repository, "requirements.txt");
    await writeFile(requirements, "graphrag==3.1.1\n", "utf8");

    await expect(buildKnowledgeIndexPlan(root, requirements, repository, { GRAPHRAG_API_BASE: "https://example.com/v1" })).rejects.toThrow();
  });
});

function settings(secret: string): string {
  return `completion_models:\n  default_completion_model:\n    model_provider: openai\n    model: gpt-test\n    api_base: \${GRAPHRAG_API_BASE}\n    api_key: ${secret}\nembedding_models:\n  default_embedding_model:\n    model_provider: openai\n    model: embedding-test\n    api_base: \${GRAPHRAG_API_BASE}\n    api_key: ${secret}\nextract_graph:\n  prompt: prompts/extract.txt\n`;
}

function snapshot() {
  return {
    schemaVersion: "1.0",
    packId: "test-pack",
    sources: [{
      id: "11111111-1111-4111-8111-111111111111",
      version: "1",
      contentSha256: "a".repeat(64),
      documentCount: 1,
    }, {
      id: "22222222-2222-4222-8222-222222222222",
      version: "1",
      contentSha256: null,
      documentCount: 0,
    }],
  };
}

function manifest() {
  return {
    schemaVersion: "1.0",
    packId: "test-pack",
    entries: [{
      documentTitle: "source__01.txt",
      sourceId: "11111111-1111-4111-8111-111111111111",
      locator: "Results",
      contentSha256: "7b90ad525c5c89e93b486fc39737062d067e03dfbf4d57a3f614941b1e66e370",
    }],
  };
}
