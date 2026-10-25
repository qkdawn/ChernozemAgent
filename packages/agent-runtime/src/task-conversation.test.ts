import type { AnalysisTask, FieldSummary } from "@chernozem/contracts";
import { describe, expect, it } from "vitest";

import type { CodexConversationRequest, CodexConversationRuntime } from "./model-runtime.js";
import { runFieldConversation, runTaskConversation } from "./task-conversation.js";

describe("Codex-backed conversation", () => {
  it.each(["玉米霜冻", "积水后怎么办", "红边和缺氮", "生育期与积温"])("retrieves original knowledge for a direct agronomy question: %s", async (userMessage) => {
    const runtime = fakeRuntime("中文解释并引用来源。", []);
    const search = async () => ({ status: "succeeded" as const, indexRunRef: "local-index", answer: null,
      matches: [{ excerpt: "Original English evidence.", textUnitIds: ["p1"], relatedEntities: [],
        applicability: { regions: ["通用方法"], crops: ["corn" as const], stages: [] },
        citation: { sourceId: "s1", title: "Verified paper", locator: "Results", sourceUrl: "https://example.com/paper", identifier: null, version: "v1" } }],
      limitations: ["异地试验，不能套用阈值。"], error: null });
    await runFieldConversation({ runtime, field: fieldFixture(), history: [], recentTasks: [], userMessage, knowledgeSearch: { search } });
    expect(runtime.requests[0]?.systemPrompt).toContain("Original English evidence.");
    expect(runtime.requests[0]?.systemPrompt).toContain("异地试验，不能套用阈值。");
    expect(runtime.requests[0]?.systemPrompt).toContain("不补造实测");
  });
  it("keeps ordinary field chat separate from analysis workflows", async () => {
    const runtime = fakeRuntime("你好，我在。", []);
    const answer = await runFieldConversation({ runtime, field: fieldFixture(), history: [], recentTasks: [], userMessage: "你好" });

    expect(answer).toBe("你好，我在。");
    expect(runtime.requests[0]?.systemPrompt).toContain("不要把普通消息解释成分析任务");
    expect(runtime.requests[0]?.systemPrompt).toContain('"name":"俺的田"');
  });

  it("retrieves field-scoped agronomy knowledge for an ordinary explanation question", async () => {
    const runtime = fakeRuntime("拔节期一般要结合株高和叶色观察。", []);
    const calls: Array<{ fieldId?: string; taskId?: string; query: string }> = [];
    await runFieldConversation({
      runtime,
      field: fieldFixture(),
      history: [],
      recentTasks: [],
      userMessage: "拔节期为什么要看叶色？",
      knowledgeSearch: { async search(input) {
        calls.push(input);
        return {
          status: "succeeded", indexRunRef: "index-1", answer: "叶色可作为植株氮素和生长状态的现场线索。",
          matches: [], limitations: [], error: null,
        };
      } },
    });

    expect(calls).toEqual([{ fieldId: "field-001", query: "拔节期为什么要看叶色？" }]);
    expect(runtime.requests[0]?.systemPrompt).toContain("不代表当前地块事实");
    expect(runtime.requests[0]?.systemPrompt).toContain("叶色可作为植株氮素和生长状态的现场线索");
  });

  it("keeps field chat available when knowledge search throws", async () => {
    const runtime = fakeRuntime("这轮没有取得可引用的知识来源。", []);
    await runFieldConversation({
      runtime,
      field: fieldFixture(),
      history: [],
      recentTasks: [],
      userMessage: "这个判断有什么出处？",
      knowledgeSearch: { async search() { throw new Error("offline"); } },
    });

    expect(runtime.requests[0]?.systemPrompt).toContain("知识检索当前不可用");
    expect(runtime.requests[0]?.systemPrompt).toContain("不要补造来源");
  });

  it("passes bounded history and compact task facts to the harness", async () => {
    const runtime = fakeRuntime("优先巡查西南区域。", []);
    await runTaskConversation({
      runtime,
      task: taskFixture(),
      history: [{ id: "m1", taskId: "task-001", sequence: 1, role: "assistant", kind: "analysis_result", content: "西南区域偏弱。", createdAt: "2026-08-19T00:01:00.000Z" }],
      userMessage: "先去哪里看？",
    });

    expect(runtime.requests[0]?.history).toHaveLength(1);
    expect(runtime.requests[0]?.userMessage).toBe("先去哪里看？");
    expect(runtime.requests[0]?.systemPrompt).toContain('"taskId":"task-001"');
    expect(runtime.requests[0]?.systemPrompt).toContain("西南区域长势下降");
    expect(runtime.requests[0]?.systemPrompt).toContain("简单追问只回答对应部分");
    expect(runtime.requests[0]?.systemPrompt).toContain("没有同位置时序证据就不说偏弱区持续恶化");
    expect(runtime.requests[0]?.systemPrompt).toContain("现场反馈是可选补充");
  });

  it("retrieves scoped agronomy evidence only for explanation questions", async () => {
    const runtime = fakeRuntime("任务事实与农学解释已分开。", []);
    const calls: string[] = [];
    await runTaskConversation({
      runtime,
      task: taskFixture(),
      history: [],
      userMessage: "为什么还要看叶色？",
      knowledgeSearch: { async search({ query }) {
        calls.push(query);
        return { status: "succeeded", indexRunRef: "index-1", answer: "现场叶色用于交叉核查。", matches: [], limitations: [], error: null };
      } },
    });

    expect(calls).toEqual(["为什么还要看叶色？"]);
    expect(runtime.requests[0]?.systemPrompt).toContain("现场叶色用于交叉核查");
  });
});

function fakeRuntime(answer: string, requests: CodexConversationRequest[]): CodexConversationRuntime & { requests: CodexConversationRequest[] } {
  return {
    modelId: "test-codex",
    requests,
    async runConversation(request) {
      requests.push(structuredClone(request));
      return { threadId: "thread-test", finalResponse: answer };
    },
  };
}

function taskFixture(): AnalysisTask {
  return {
    id: "task-001", fieldId: "field-001", objective: "growth_stage_monitoring",
    timeRange: { start: "2026-07-01", end: "2026-07-31" }, status: "partial", progress: 100,
    stage: "关键生育期长势监测已完成", createdAt: "2026-08-19T00:00:00.000Z", completedAt: "2026-08-19T00:01:00.000Z",
    demoData: false, summary: "7 月 31 日西南区域长势下降。", brief: null,
    findings: [{ id: "finding-1", title: "西南区域", summary: "NDVI 较地块均值偏低。", severity: "watch", areaHa: 0.8, sourceDates: ["2026-07-31"], zone: null }],
    sources: [{ source: "sentinel-2", observedAt: "2026-07-31", quality: "usable", note: "地块有效像元满足分析。" }],
    analysisResults: [], limitations: ["尚无同期现场记录。"], nextActions: [{ code: "inspect", label: "巡查西南区域" }], failure: null,
  };
}

function fieldFixture(): FieldSummary {
  return {
    id: "field-001", organizationId: "org-001", code: "TL-CORN-001", name: "俺的田", village: "铁岭", crop: "corn",
    seasonYear: 2026, plantingDate: "2026-05-04", variety: "先玉 335", areaHa: 19.49, boundaryVersion: 1, seasonCount: 1,
    centroid: { longitude: 123.8, latitude: 42.3 }, boundary: [], latestStatus: "normal", latestAnalyzedAt: null,
  };
}
