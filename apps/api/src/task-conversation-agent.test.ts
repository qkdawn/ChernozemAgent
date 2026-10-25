import type { AnalysisBrief, AnalysisTask, FieldSummary } from "@chernozem/contracts";
import { describe, expect, it } from "vitest";

import { createDeterministicFieldConversationAgent, createDeterministicTaskConversationAgent } from "./task-conversation-agent.js";

describe("deterministic conversation fallback", () => {
  it("answers a task follow-up from the professional brief", async () => {
    const reply = await createDeterministicTaskConversationAgent().reply({ task: task(), history: [], userMessage: "结果是什么？" });
    expect(reply).toContain("西南区域近期长势下降");
    expect(reply).not.toContain("底层摘要");
  });

  it("uses the professional brief in field-level recent task context", async () => {
    const reply = await createDeterministicFieldConversationAgent().reply({ field: field(), history: [], recentTasks: [task()], userMessage: "最近怎么样？" });
    expect(reply).toContain("西南区域近期长势下降");
    expect(reply).not.toContain("底层摘要");
  });
});

function task(): AnalysisTask {
  return {
    id: "task-1", fieldId: "field-1", objective: "growth_stage_monitoring",
    timeRange: { start: "2026-06-01T00:00:00.000Z", end: "2026-06-21T00:00:00.000Z" },
    status: "completed", progress: 100, stage: "已完成", createdAt: "2026-06-21T00:00:00.000Z",
    completedAt: "2026-06-21T00:01:00.000Z", demoData: false, summary: "底层摘要", brief: brief(),
    findings: [], sources: [], analysisResults: [], limitations: [], nextActions: [{ code: "inspect_growth_zones", label: "核查下降区域" }], failure: null,
  };
}

function brief(): AnalysisBrief {
  return {
    version: "analysis-brief-v2", headline: "西南区域近期长势下降", overview: "变化集中在 6 月 12 日后。",
    reasoning: "两期可比光学观测支持该变化。", uncertainty: null, evidence: [], actions: [],
    generation: { mode: "deterministic", generatedAt: "2026-06-21T00:01:00.000Z", provider: null, modelId: null, promptVersion: null, fallbackReason: null },
  };
}

function field(): FieldSummary {
  return {
    id: "field-1", organizationId: "org-1", code: "TL-001", name: "北田", areaHa: 8.2,
    village: "示范村", crop: "corn", seasonYear: 2026, plantingDate: "2026-05-05", variety: null,
    boundaryVersion: 1, seasonCount: 1, centroid: { longitude: 123.805, latitude: 42.305 },
    boundary: [{ longitude: 123.8, latitude: 42.3 }, { longitude: 123.81, latitude: 42.3 }, { longitude: 123.81, latitude: 42.31 }],
    latestStatus: "watch", latestAnalyzedAt: "2026-06-21T00:01:00.000Z",
  };
}
