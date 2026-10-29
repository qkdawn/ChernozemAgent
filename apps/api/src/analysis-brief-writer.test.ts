import type { CodexStructuredRequest } from "@chernozem/agent-runtime";
import type { AnalysisBrief, AnalysisResult } from "@chernozem/contracts";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMemoryAnalysisResultStore } from "./analysis-store.js";
import { describe, expect, it } from "vitest";

import { createCodexAnalysisBriefWriter, publishAnalysisBrief, type AnalysisBriefWritingInput } from "./analysis-brief-writer.js";

// Synthetic fixtures test contracts, not agronomic validity or a real model's reasoning.
describe("analysis document writer", () => {
  it("writes the complete document from domain results without a template or character whitelist", async () => {
    const input = writingInput();
    const model = runtime(JSON.stringify(document()), input);
    const { brief: generated } = await createCodexAnalysisBriefWriter(model).write(input);

    expect(generated.document?.sections[0]?.paragraphs).toEqual(["先比较同一天的田内差异，再看地块整体变化；两者对应不同的问题。"]);
    expect(generated.overview).toBe("这片田存在空间差异，可以先做分区对照。");
    expect(generated.actions[0]?.label).toBe("比较冠层完整度");
    expect(generated.actions[0]?.decisionEffect).toContain("现场叶色");
    expect(generated.generation).toMatchObject({ mode: "model_generated", fallbackReason: null, modelId: "test-model" });
    expect(generated.generation.promptVersion).toBe("analysis-brief-writer-v8");
    expect(generated.evidence[0]).toMatchObject({
      references: [{ resultId: "optical-1", path: "/current/metrics/ndvi/mean" }],
      sourceDates: [{ source: "sentinel-2", date: "2026-07-31" }],
    });
    const request = model.requests[0]!;
    expect(request.input).toMatchObject({
      task: input.task,
      results: [{ id: "optical-1", kind: "optical_condition", availablePaths: ["/current", "/zones", "/missing"] }],
    });
    expect(JSON.stringify(request.input)).not.toContain("这是固定底稿");
    expect(JSON.stringify(request.input)).not.toContain("无条件先看低洼处");
    expect(request.systemPrompt).toContain("没有现场记录时");
    expect(request.systemPrompt).toContain("时效/窗口结束/写作日≠田况/历史不可回验/无同期作物/不能用后茬或残茬替代");
    expect(request.systemPrompt).toContain("不计入限制句配额");
    expect(request.systemPrompt).toContain("距任务结束日期");
    expect(request.systemPrompt).toContain("不能靠文字推断");
    expect(request.systemPrompt).toContain("决策框架");
    expect(request.systemPrompt).toContain("/spatialPrioritySummary");
    expect(request.systemPrompt).toContain("overview 和 document 必须明确说出雷达/低洼地形交集是否改变");
    expect(request.systemPrompt).toContain("若成果目录没有 spatialPrioritySummary");
    expect(request.systemPrompt).toContain("无法据此调整先看哪一块");
    expect(request.systemPrompt).toContain("禁止写成「无水分问题」");
    expect(request.systemPrompt).toContain("禁止写成「无水分问题」");
    expect(request.systemPrompt).toContain("zoneRef 只能填写成果 zones/weakZones 中真实存在的分区 ID");
  });

  it.each([
    ["foreign result", { resultId: "other-task-result", path: "/current/metrics/ndvi/mean" }],
    ["invented field", { resultId: "optical-1", path: "/rainfallMm" }],
    ["missing value", { resultId: "optical-1", path: "/missing" }],
    ["malformed pointer", { resultId: "optical-1", path: "/bad~2key" }],
    ["entire result", { resultId: "optical-1", path: "" }],
  ])("does not publish an unresolvable reference: %s", async (_label, reference) => {
    const output = document();
    output.evidence[0]!.references = [reference];
    const { brief: generated } = await createCodexAnalysisBriefWriter(runtime(JSON.stringify(output))).write(writingInput());
    expect(generated.generation.mode).toBe("deterministic");
    expect(generated.document).toBeUndefined();
    expect(generated.generation.fallbackReason).not.toBeNull();
  });

  it.each(["task", "field", "boundary"])("rejects %s scope mismatch before model invocation", async (kind) => {
    const input = writingInput();
    const result = input.results[0]!;
    if (kind === "task") result.taskId = "foreign-task";
    if (kind === "field") result.execution.scope.fieldId = "foreign-field";
    if (kind === "boundary") result.execution.scope.boundaryVersion = 2;
    const model = runtime(JSON.stringify(document()));
    const { brief: generated } = await createCodexAnalysisBriefWriter(model).write(input);
    expect(generated.generation.fallbackReason).toBe("unsafe_output");
    expect(model.requests).toHaveLength(0);
  });

  it("requires map object references to exist", async () => {
    const output = document();
    output.actions[0]!.zoneRef = "invented-zone";
    const { brief: generated } = await createCodexAnalysisBriefWriter(runtime(JSON.stringify(output))).write(writingInput());
    expect(generated.generation.fallbackReason).toBe("unsafe_output");
  });

  it("keeps partial and missing data explicit and accepts supported array pointers", async () => {
    const input = writingInput();
    input.results[0]!.status = "partial";
    const output = document();
    output.evidence[0]!.references = [{ resultId: "optical-1", path: "/zones/0/areaHa" }];
    const model = runtime(JSON.stringify(output), input);
    const { brief: generated } = await createCodexAnalysisBriefWriter(model).write(input);
    expect(generated.generation.mode).toBe("model_generated");
    expect(model.requests[0]!.input).toMatchObject({ results: [{ status: "partial" }] });
  });

  it("does not use failed calculations as observation evidence", async () => {
    const input = writingInput();
    input.results[0]!.status = "failed";
    const { brief: generated } = await createCodexAnalysisBriefWriter(runtime(JSON.stringify(document()), input)).write(input);
    expect(generated.generation.fallbackReason).toBe("unsafe_output");
  });

  it("preserves the explicit professional review requirement", async () => {
    const output = { ...document(), reviewRequired: true };
    const { brief: generated } = await createCodexAnalysisBriefWriter(runtime(JSON.stringify(output))).write(writingInput());
    expect(generated.reviewRequired).toBe(true);
  });

  it.each(["action", "paragraph"])("requires review for an explicit intervention in the %s even if the model marks it safe", async (where) => {
    const output = document();
    if (where === "action") output.actions[0]!.label = "每公顷追肥 50 公斤";
    else output.document.sections[0]!.paragraphs = ["建议对这片区域立即灌溉。"];
    const { brief: generated } = await createCodexAnalysisBriefWriter(runtime(JSON.stringify(output))).write(writingInput());
    expect(generated.reviewRequired).toBe(true);
  });

  it("keeps reading agronomic records at inspection level", async () => {
    const output = document();
    output.actions[0]!.label = "核对施肥记录和灌溉日期";
    const { brief: generated } = await createCodexAnalysisBriefWriter(runtime(JSON.stringify(output))).write(writingInput());
    expect(generated.reviewRequired).toBe(false);
  });

  it("keeps an explicit non-intervention from becoming a prescription review", async () => {
    const output = document();
    output.actions[0]!.checklist = ["核对降雨灌溉记录，不据此调整灌溉。"];
    const { brief: generated } = await createCodexAnalysisBriefWriter(runtime(JSON.stringify(output))).write(writingInput());
    expect(generated.reviewRequired).toBe(false);
  });

  it("does not require prescription review for diagnostic irrigation checks", async () => {
    const output = document();
    output.document.sections[0]!.paragraphs = ["先检查土壤湿度，核对排水、灌溉和根系环境，再决定是否需要专业复核。"];
    const { brief: generated } = await createCodexAnalysisBriefWriter(runtime(JSON.stringify(output))).write(writingInput());
    expect(generated.reviewRequired).toBe(false);
  });

  it.each(["不据此调整灌溉，但建议立即追肥。", "不要停止灌溉。", "不要不施肥。"])("retains review for an actual or double-negated intervention: %s", async (text) => {
    const output = document();
    output.actions[0]!.checklist = [text];
    const { brief: generated } = await createCodexAnalysisBriefWriter(runtime(JSON.stringify(output))).write(writingInput());
    expect(generated.reviewRequired).toBe(true);
  });

  it.each(["not-json", JSON.stringify({ headline: "不完整文档" }), JSON.stringify({ ...document(), reviewRequired: undefined })])("falls back on malformed output", async (response) => {
    const { brief: generated } = await createCodexAnalysisBriefWriter(runtime(response)).write(writingInput());
    expect(generated.generation).toMatchObject({ mode: "deterministic", fallbackReason: "malformed_output" });
  });

  it.each([undefined, "", "   "])("rejects missing or blank decisionEffect", async (decisionEffect) => {
    const output = document();
    if (decisionEffect === undefined) delete output.actions[0]!.decisionEffect;
    else output.actions[0]!.decisionEffect = decisionEffect;
    const { brief } = await createCodexAnalysisBriefWriter(runtime(JSON.stringify(output))).write(writingInput());
    expect(brief.generation).toMatchObject({ mode: "deterministic", fallbackReason: "malformed_output" });
  });

  it("returns computed results on model error or timeout", async () => {
    const failed = runtime("");
    failed.runtime.runStructured = async () => { throw new Error("offline"); };
    const never = runtime("");
    never.runtime.runStructured = async () => new Promise(() => undefined);
    for (const writer of [createCodexAnalysisBriefWriter(failed), createCodexAnalysisBriefWriter({ ...never, timeoutMs: 5 })]) {
      const { brief: generated } = await writer.write(writingInput());
      expect(generated.generation).toMatchObject({ mode: "deterministic", fallbackReason: "model_error" });
      expect(generated.overview).toBe("这是固定底稿，仅供生成失败时显示。");
    }
  });

  it("aborts the model request at the writing deadline", async () => {
    const model = runtime("");
    let signal: AbortSignal | undefined;
    model.runtime.runStructured = async (request) => {
      signal = request.signal;
      return new Promise(() => undefined);
    };
    await createCodexAnalysisBriefWriter({ ...model, timeoutMs: 5 }).write(writingInput());
    expect(signal?.aborted).toBe(true);
  });

  it("rejects a field reference the model never read", async () => {
    const input = writingInput();
    const { brief } = await createCodexAnalysisBriefWriter(runtime(JSON.stringify(document()), input, false)).write(input);
    expect(brief.generation.fallbackReason).toBe("unsafe_output");
  });

  it("rejects unsaved handoffs before invoking the model", async () => {
    const model = runtime(JSON.stringify(document()));
    const { brief } = await createCodexAnalysisBriefWriter({ ...model, store: createMemoryAnalysisResultStore() }).write(writingInput());
    expect(brief.generation.fallbackReason).toBe("unsafe_output");
    expect(model.requests).toHaveLength(0);
  });

  it("returns newly computed evidence with its document rather than losing it after writing", async () => {
    const input = writingInput();
    const model = runtime(JSON.stringify(document()), input, async (client) => {
      const response = await client.callTool({ name: "analyze_weather_event", arguments: {} });
      expect(response.isError).not.toBe(true);
    });
    const weather: AnalysisResult<unknown> = { ...input.results[0]!, id: "weather-1", kind: "weather_event",
      execution: { ...input.results[0]!.execution, toolName: "analyze_weather_event" }, result: { historical: { totalRainfallMm: 25 } } };
    input.investigationTools = [{ name: "analyze_weather_event", execute: async () => weather }];
    const publication = await createCodexAnalysisBriefWriter(model).write(input);
    expect(publication.brief.generation.mode).toBe("model_generated");
    expect(publication.results.map((result) => result.id)).toContain("weather-1");
    expect(await model.store.get("weather-1")).toEqual(weather);
  });

  it("cites a retrieved original separately from dated field observations", async () => {
    const input = writingInput();
    const citation = { sourceId: "source-1", title: "Synthetic agronomy source", locator: "paragraph 3", sourceUrl: "https://example.org/agronomy", identifier: null, version: "v1" };
    const model = runtime("", input, async (client) => {
      const response = await client.callTool({ name: "search_agronomy_knowledge", arguments: { query: "玉米红边指标的适用范围" } });
      const result = (response.structuredContent as { result: { id: string } }).result;
      const output = document();
      output.evidence.push({ statement: "原文说明红边指标的适用范围，未证明该田缺氮。", references: [{ resultId: result.id, path: "/matches/0/excerpt" }] });
      return JSON.stringify(output);
    });
    const publication = await createCodexAnalysisBriefWriter({ ...model, knowledgeSearch: { search: async () => ({ status: "succeeded", indexRunRef: "index-v1", answer: "不继承生成答案",
      matches: [{ citation, excerpt: "Synthetic source text for contract tests.", textUnitIds: ["text-1"], relatedEntities: [], applicability: { crops: ["corn"], regions: [], stages: [] } }], limitations: [], error: null }) } }).write(input);
    expect(publication.brief.generation.mode).toBe("model_generated");
    expect(publication.brief.evidence[1]).toMatchObject({ knowledgeCitations: [citation], sourceDates: [] });
    expect(publication.results.some((result) => result.kind === "knowledge_context")).toBe(true);
  });

  it("can finish field analysis when knowledge lookup has no matches, without citing absent knowledge", async () => {
    const input = writingInput();
    const model = runtime(JSON.stringify(document()), input, async (client) => {
      const result = await client.callTool({ name: "search_agronomy_knowledge", arguments: { query: "玉米区域背景" } });
      expect(result.structuredContent).toMatchObject({ result: { status: "needs_data", data: [{ value: { status: "no_matches", matches: [] } }] } });
    });
    const publication = await createCodexAnalysisBriefWriter({ ...model, knowledgeSearch: { search: async () => ({ status: "no_matches", indexRunRef: "index-1", answer: null, matches: [], limitations: [], error: null }) } }).write(input);
    expect(publication.brief.generation.mode).toBe("model_generated");
    expect(publication.brief.evidence.every((item) => !item.knowledgeCitations)).toBe(true);
  });

  it("retains observation roles for an out-of-window comparison baseline", async () => {
    const input = writingInput();
    input.task.timeRange.start = "2026-07-24T00:00:00Z";
    input.results[0]!.sources.push({ source: "sentinel-2", date: "2026-07-16", role: "comparison", quality: "usable", note: "历史比较基线" });
    const model = runtime(JSON.stringify(document()), input);
    await createCodexAnalysisBriefWriter(model).write(input);
    expect(model.requests[0]!.input).toMatchObject({ results: [{ sources: [
      { date: "2026-07-31" }, { date: "2026-07-16", role: "comparison" },
    ] }] });
  });

  it("keeps computed evidence when final model generation fails", async () => {
    const input = writingInput();
    const weather: AnalysisResult<unknown> = { ...input.results[0]!, id: "weather-failed-turn", kind: "weather_event",
      execution: { ...input.results[0]!.execution, toolName: "analyze_weather_event" }, result: { historical: null } };
    input.investigationTools = [{ name: "analyze_weather_event", execute: async () => weather }];
    const model = runtime("", input, async (client) => {
      await client.callTool({ name: "analyze_weather_event", arguments: {} });
      throw new Error("model disconnected after tool execution");
    });
    const publication = await createCodexAnalysisBriefWriter(model).write(input);
    expect(publication.brief.generation.fallbackReason).toBe("model_error");
    expect(publication.results.map(({ id }) => id)).toContain(weather.id);
  });

  it("preserves an existing professional review boundary", async () => {
    const input = writingInput();
    input.brief.reviewRequired = true;
    const { brief } = await createCodexAnalysisBriefWriter(runtime(JSON.stringify(document()), input)).write(input);
    expect(brief.reviewRequired).toBe(true);
  });

  it("logs unknown zoneRefs separately from evidence failures on unsafe fallback", async () => {
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { errors.push(args[0]); };
    try {
      const output = document();
      output.actions[0]!.zoneRef = "invented-zone";
      await createCodexAnalysisBriefWriter(runtime(JSON.stringify(output))).write(writingInput());
    } finally {
      console.error = original;
    }
    const line = errors.map(String).find((entry) => entry.includes("analysis_brief_writer_fallback"));
    expect(line).toBeDefined();
    expect(JSON.parse(line!)).toMatchObject({
      event: "analysis_brief_writer_fallback",
      reason: "unsafe_output",
      cause: "unknown_zone_refs",
      evidenceRefsFailed: false,
      unknownZoneRefs: ["invented-zone"],
      knownZoneIds: ["zone-1"],
      zoneRefs: ["invented-zone"],
      taskId: "task-1",
    });
  });

  it("logs evidence_refs_failed when references were never read", async () => {
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { errors.push(args[0]); };
    try {
      const input = writingInput();
      await createCodexAnalysisBriefWriter(runtime(JSON.stringify(document()), input, false)).write(input);
    } finally {
      console.error = original;
    }
    const line = errors.map(String).find((entry) => entry.includes("analysis_brief_writer_fallback"));
    expect(JSON.parse(line!)).toMatchObject({
      event: "analysis_brief_writer_fallback",
      reason: "unsafe_output",
      cause: "evidence_refs_failed",
      evidenceRefsFailed: true,
      unknownZoneRefs: [],
      knownZoneIds: ["zone-1"],
    });
  });

  it("logs parseFailure detail on malformed_output", async () => {
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { errors.push(args[0]); };
    try {
      await createCodexAnalysisBriefWriter(runtime("not-json")).write(writingInput());
    } finally {
      console.error = original;
    }
    const line = errors.map(String).find((entry) => entry.includes("analysis_brief_writer_fallback"));
    expect(JSON.parse(line!)).toMatchObject({
      event: "analysis_brief_writer_fallback",
      reason: "malformed_output",
      cause: "parse_failure",
      parseFailure: "json_parse_error",
      taskId: "task-1",
    });
  });

  it("publishes the computed summary when no writer is configured", async () => {
    const input = writingInput();
    expect(await publishAnalysisBrief(input)).toEqual({ brief: input.brief, results: input.results });
  });

  it("retains computed results if a writer unexpectedly throws", async () => {
    const input = writingInput();
    const { brief: generated } = await publishAnalysisBrief({ ...input, writer: {
      provider: "test", modelId: "test-model", promptVersion: "test", async write() { throw new Error("unexpected"); },
    } });
    expect(generated.generation).toMatchObject({ mode: "deterministic", fallbackReason: "model_error" });
  });
});

function writingInput(): AnalysisBriefWritingInput {
  const brief: AnalysisBrief = {
    version: "analysis-brief-v2", headline: "旧摘要", overview: "这是固定底稿，仅供生成失败时显示。",
    reasoning: "旧依据", uncertainty: null, evidence: [], actions: [],
    generation: { mode: "deterministic", generatedAt: "2026-08-01T00:00:00Z", provider: null, modelId: null, promptVersion: null, fallbackReason: null },
  };
  const result: AnalysisResult<unknown> = {
    id: "optical-1", taskId: "task-1", kind: "optical_condition", status: "succeeded", toolVersion: "test",
    createdAt: "2026-08-01T00:00:00Z",
    execution: { toolName: "analyze_optical_condition", scope: { fieldId: "field-1", boundaryVersion: 1, timeRange: { start: "2026-07-01T00:00:00Z", end: "2026-08-01T00:00:00Z" } },
      inputs: { acquisitionIds: [], assetIds: [], resultIds: [] }, parameters: {}, inputFingerprint: "test" },
    summary: "无条件先看低洼处", findings: [], limitations: ["不要把模板限制交给写作模型"], nextActions: [], artifacts: [], error: null,
    result: { current: { observationDate: "2026-07-31", metrics: { ndvi: { mean: 0.71 } } }, zones: [{ id: "zone-1", areaHa: 1.2 }], missing: null },
    sources: [{ source: "sentinel-2", date: "2026-07-31", quality: "usable", note: "test" }],
  };
  return { brief, results: [result], task: { id: "task-1", fieldId: "field-1", boundaryVersion: 1,
    objective: "growth_stage_monitoring", timeRange: result.execution.scope.timeRange!, requestMessage: "比较这块田的长势变化" } };
}

function document() {
  return {
    headline: "田内差异值得做分区对照", overview: "这片田存在空间差异，可以先做分区对照。",
    reasoning: "同日空间差异与跨期整体变化分开分析。", uncertainty: null,
    document: { title: "田内长势差异分析", subtitle: "截至 2026-07-31 的观测", sections: [
      { id: "comparison", title: "差异发生在哪里", paragraphs: ["先比较同一天的田内差异，再看地块整体变化；两者对应不同的问题。"] },
    ] },
    evidence: [{ statement: "本期有地块内的植被观测。", references: [{ resultId: "optical-1", path: "/current/metrics/ndvi/mean" }] }],
    actions: [{ label: "比较冠层完整度", purpose: "区分群体差异与水分压力", decisionEffect: "如果现场叶色正常，优先核对群体差异；如果叶色和墒情同时偏弱，再排查水分压力。", where: "地图分区", timing: null, checklist: ["与邻近区域对照冠层缺口"], zoneRef: "zone-1" }],
    reviewRequired: false,
  };
}

function runtime(response: string, input = writingInput(), investigate: false | ((client: Client) => Promise<string | void>) = async () => undefined) {
  const requests: CodexStructuredRequest[] = [];
  const store = createMemoryAnalysisResultStore();
  // The in-memory save implementation clones synchronously before its resolved promise.
  for (const result of input.results) void store.save(result);
  return { provider: "test", modelId: "test-model", requests, store, runtime: {
    modelId: "test-model", async runStructured(request: CodexStructuredRequest) {
      requests.push(request);
      if (investigate !== false) {
        const source = request.evidenceSource!;
        const client = new Client({ name: "fixture-model", version: "1.0.0" });
        try {
          await client.connect(new StreamableHTTPClientTransport(new URL(source.url), { requestInit: { headers: { Authorization: `Bearer ${source.token}` } } }));
          for (const result of input.results) await client.callTool({ name: "read_analysis_result", arguments: { resultId: result.id } });
          response = await investigate(client) ?? response;
        } finally { await client.close(); }
      }
      return { threadId: "test-thread", finalResponse: response };
    },
  } };
}
