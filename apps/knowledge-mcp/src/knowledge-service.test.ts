import type { AgronomyKnowledgeMatch } from "@chernozem/contracts";
import { describe, expect, it } from "vitest";

import { AgronomyKnowledgeService, graphRagProcessEnvironment, type GraphRagQueryRunner, type KnowledgeRepository } from "./knowledge-service.js";

describe("agronomy knowledge service", () => {
  it("returns cited GraphRAG context for the current task index", async () => {
    const service = new AgronomyKnowledgeService(repository([match()]), runner());

    const result = await service.search({ taskId: "task-001", query: "拔节期为什么核查叶色？" });

    expect(result).toMatchObject({
      status: "succeeded",
      indexRunRef: "index-001",
      answer: "拔节期需要结合现场叶色核查。",
      matches: [{ citation: { title: "东北春玉米田间调查方法", locator: "第 3 章" } }],
    });
  });

  it("resolves the latest published index for an authorized field", async () => {
    const scopes: unknown[] = [];
    const fieldRepository: KnowledgeRepository = {
      async resolveIndex(input) {
        scopes.push(input);
        return { indexRunRef: "index-001", objective: null };
      },
      async findCitations() { return [match()]; },
    };

    const result = await new AgronomyKnowledgeService(fieldRepository, runner()).search({ fieldId: "field-001", query: "拔节期为什么核查叶色？" });

    expect(scopes).toEqual([{ fieldId: "field-001" }]);
    expect(result).toMatchObject({ status: "succeeded", indexRunRef: "index-001" });
  });

  it("does not fail the task when no completed knowledge index exists", async () => {
    const noIndex: KnowledgeRepository = {
      async resolveIndex() { return null; },
      async findCitations() { return []; },
    };
    const result = await new AgronomyKnowledgeService(noIndex, runner()).search({ taskId: "task-001", query: "解释一下" });

    expect(result).toMatchObject({ status: "unavailable", indexRunRef: null, error: { code: "knowledge_index_missing" } });
  });

  it("rejects uncited GraphRAG output as no matches", async () => {
    const result = await new AgronomyKnowledgeService(repository([]), runner()).search({ taskId: "task-001", query: "解释一下" });

    expect(result).toMatchObject({ status: "no_matches", answer: null, matches: [] });
  });

  it("reuses the Pi gateway credentials for GraphRAG queries without exposing new configuration", () => {
    const environment = graphRagProcessEnvironment({
      OPENAI_BASE_URL: "https://gateway.example/v1",
      OPENAI_API_KEY: "test-secret",
      PATH: "test-path",
    });

    expect(environment).toMatchObject({
      GRAPHRAG_API_BASE: "https://gateway.example/v1",
      GRAPHRAG_API_KEY: "test-secret",
      PATH: "test-path",
    });
  });
});

function repository(matches: AgronomyKnowledgeMatch[]): KnowledgeRepository {
  return {
    async resolveIndex() { return { indexRunRef: "index-001", objective: "growth_stage_monitoring" }; },
    async findCitations(scope, ids) {
      expect(scope.indexRunRef).toBe("index-001");
      expect(ids).toEqual(["text-unit-001"]);
      return matches;
    },
  };
}

function runner(): GraphRagQueryRunner {
  return {
    async query() {
      return { answer: "拔节期需要结合现场叶色核查。", textUnitIds: ["text-unit-001"], relatedEntities: ["拔节期"] };
    },
  };
}

function match(): AgronomyKnowledgeMatch {
  return {
    excerpt: "拔节期应调查株高、叶色及群体生长一致性。",
    textUnitIds: ["text-unit-001"],
    relatedEntities: [],
    applicability: { regions: ["东北黑土区"], crops: ["corn"], stages: ["拔节期"] },
    citation: {
      sourceId: "source-001",
      title: "东北春玉米田间调查方法",
      locator: "第 3 章",
      sourceUrl: null,
      identifier: { type: "internal", value: "field-guide-001" },
      version: "1.0",
    },
  };
}
