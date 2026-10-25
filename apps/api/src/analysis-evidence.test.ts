import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { AgronomyKnowledgeSearchResult, AnalysisResult } from "@chernozem/contracts";
import { describe, expect, it, vi } from "vitest";

import { AnalysisEvidence, valueAtPointer, type AnalysisEvidenceTask } from "./analysis-evidence.js";
import { openAnalysisEvidenceMcp } from "./analysis-evidence-mcp.js";
import { createMemoryAnalysisResultStore } from "./analysis-store.js";

describe("task evidence investigation", () => {
  it("reads persisted fields, preserves missing values, and records actual read scope", async () => {
    const store = createMemoryAnalysisResultStore();
    await store.save(result());
    const evidence = new AnalysisEvidence({ task: task(), store });
    expect(await evidence.catalog()).toMatchObject([{ id: "optical-1", availablePaths: ["/observations", "/missing"] }]);
    expect(JSON.stringify(await evidence.catalog())).not.toContain("模板核查文案");
    expect(await evidence.readResult({ resultId: "optical-1", paths: ["/observations/0", "/missing"] })).toMatchObject({ data: [
      { path: "/observations/0", value: { observationDate: "2026-07-31", ndvi: 0.71 } },
      { path: "/missing", value: null },
    ] });
    expect(evidence.wasRead("optical-1", "/observations/0/ndvi")).toBe(true);
    expect(evidence.wasRead("optical-1", "/observations/1/ndvi")).toBe(false);
  });

  it.each(["task", "field", "boundary"])("isolates another %s scope", async (kind) => {
    const store = createMemoryAnalysisResultStore();
    const foreign = result();
    if (kind === "task") foreign.taskId = "foreign-task";
    if (kind === "field") foreign.execution.scope.fieldId = "foreign-field";
    if (kind === "boundary") foreign.execution.scope.boundaryVersion = 2;
    await store.save(foreign);
    const evidence = new AnalysisEvidence({ task: task(), store });
    expect(await evidence.catalog()).toEqual([]);
    await expect(evidence.readResult({ resultId: foreign.id })).rejects.toMatchObject({ code: "result_not_available" });
  });

  it("persists a computation before exposing it and deduplicates concurrent calls", async () => {
    const store = createMemoryAnalysisResultStore();
    const execute = vi.fn(async () => result());
    const evidence = new AnalysisEvidence({ task: task(), store, tools: [{ name: "analyze_optical_condition", execute }] });
    const [first, second] = await Promise.all([evidence.compute("analyze_optical_condition"), evidence.compute("analyze_optical_condition")]);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
    expect(await store.get("optical-1")).toMatchObject({ id: "optical-1" });
    expect(evidence.wasRead("optical-1", "/observations/0/ndvi")).toBe(true);
    await expect(evidence.compute("detect_waterlogging")).rejects.toMatchObject({ code: "tool_not_available" });
  });

  it("does not convert a failed calculation into a successful observation", async () => {
    const store = createMemoryAnalysisResultStore();
    const failed = { ...result(), status: "failed" as const, result: null, error: { code: "cloud_contaminated", message: "云污染", retryable: false } };
    const evidence = new AnalysisEvidence({ task: task(), store, tools: [{ name: "analyze_optical_condition", execute: async () => failed }] });
    expect(await evidence.compute("analyze_optical_condition")).toMatchObject({ status: "failed", data: [{ value: null }], error: { code: "cloud_contaminated" } });
  });

  it("rejects a computation that returns another field", async () => {
    const foreign = result();
    foreign.execution.scope.fieldId = "foreign";
    const store = createMemoryAnalysisResultStore();
    const evidence = new AnalysisEvidence({ task: task(), store, tools: [{ name: "analyze_optical_condition", execute: async () => foreign }] });
    await expect(evidence.compute("analyze_optical_condition")).rejects.toMatchObject({ code: "invalid_tool_result" });
    expect(await store.list(task().id)).toHaveLength(0);
  });

  it("persists knowledge as cited original context rather than a field observation or generated answer", async () => {
    const search = vi.fn(async () => knowledge());
    const store = createMemoryAnalysisResultStore();
    const evidence = new AnalysisEvidence({ task: task(), store, knowledgeSearch: { search } });
    const output = await evidence.searchKnowledge("红边与氮素");
    expect(output).toMatchObject({ kind: "knowledge_context", data: [{ value: { matches: [{ excerpt: "Original published passage." }] } }] });
    expect(search).toHaveBeenCalledWith({ taskId: task().id, query: "红边与氮素" });
    const saved = (await store.list(task().id))[0]!;
    expect(saved.execution.parameters.indexRunRef).toBe("published-index-1");
    expect(JSON.stringify(saved.result)).not.toContain("不应继承的生成答案");
    expect(evidence.wasRead(saved.id, "/matches/0/excerpt")).toBe(true);
    await evidence.searchKnowledge("红边与氮素");
    expect(search).toHaveBeenCalledTimes(1);
  });

  it.each(["no_matches", "unavailable"] as const)("keeps %s knowledge distinct from usable evidence", async (status) => {
    const store = createMemoryAnalysisResultStore();
    const evidence = new AnalysisEvidence({ task: task(), store, knowledgeSearch: { search: async () => ({ ...knowledge(), status, matches: [] }) } });
    await evidence.searchKnowledge("红边与氮素");
    expect((await store.list(task().id))[0]).toMatchObject({ status: status === "no_matches" ? "needs_data" : "failed", result: { matches: [] } });
  });

  it("supports escaped JSON pointers and excludes prototype properties", () => {
    expect(valueAtPointer({ "a/b": { "~key": 3 } }, "/a~1b/~0key")).toEqual({ found: true, value: 3 });
    expect(valueAtPointer({}, "/toString").found).toBe(false);
    expect(valueAtPointer({}, "/bad~2key").found).toBe(false);
  });
});

describe("native MCP investigation transport", () => {
  it("serves a scoped tool catalog over the SDK transport and closes after the model turn", async () => {
    const store = createMemoryAnalysisResultStore();
    await store.save(result());
    const server = await openAnalysisEvidenceMcp(new AnalysisEvidence({ task: task(), store }));
    const client = new Client({ name: "test-investigation", version: "1.0.0" });
    try {
      expect((await fetch(server.url)).status).toBe(403);
      await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { Authorization: `Bearer ${server.token}` } } }));
      const tools = (await client.listTools()).tools;
      expect(tools.map(({ name }) => name)).toEqual(["list_analysis_results", "read_analysis_result"]);
      expect(tools.every((tool) => tool.annotations?.readOnlyHint === true && tool.annotations.openWorldHint === false)).toBe(true);
      const response = await client.callTool({ name: "read_analysis_result", arguments: { resultId: "optical-1", paths: ["/observations/0/ndvi"] } });
      expect(response.isError).not.toBe(true);
      expect(response.structuredContent).toMatchObject({ result: { data: [{ value: 0.71 }] } });
      const invalid = await client.callTool({ name: "read_analysis_result", arguments: { resultId: "optical-1", taskId: "foreign-task" } });
      expect(invalid.isError).toBe(true);
      const foreign = await client.callTool({ name: "read_analysis_result", arguments: { resultId: "foreign" } });
      expect(foreign.isError).toBe(true);
    } finally { await client.close(); await server.close(); }
    await expect(fetch(server.url)).rejects.toThrow();
  });
});

function task(): AnalysisEvidenceTask { return { id: "task-1", fieldId: "field-1", boundaryVersion: 1,
  objective: "growth_stage_monitoring", timeRange: { start: "2026-07-01T00:00:00Z", end: "2026-08-01T00:00:00Z" } }; }

function result(): AnalysisResult<unknown> { return { id: "optical-1", taskId: "task-1", kind: "optical_condition", status: "succeeded",
  toolVersion: "fixture", createdAt: "2026-08-01T00:00:00Z", execution: { toolName: "analyze_optical_condition",
    scope: { fieldId: "field-1", boundaryVersion: 1, timeRange: task().timeRange }, parameters: {}, inputs: { acquisitionIds: [], assetIds: [], resultIds: [] }, inputFingerprint: "fixture" },
  summary: "模板核查文案", findings: [], sources: [{ source: "sentinel-2", date: "2026-07-31", quality: "usable", note: "fixture" }],
  result: { observations: [{ observationDate: "2026-07-31", ndvi: 0.71 }], missing: null }, limitations: [], nextActions: [], artifacts: [], error: null }; }

function knowledge(): AgronomyKnowledgeSearchResult { return { status: "succeeded", indexRunRef: "published-index-1", answer: "不应继承的生成答案",
  matches: [{ excerpt: "Original published passage.", textUnitIds: ["text-1"], relatedEntities: [], applicability: { regions: ["Northeast China"], crops: ["corn"], stages: [] },
    citation: { sourceId: "paper-1", title: "Fixture paper", locator: "Results, paragraph 1", sourceUrl: "https://example.org/paper", identifier: null, version: "v1" } }], limitations: [], error: null }; }
