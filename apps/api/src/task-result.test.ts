import type { AnalysisTask } from "@chernozem/contracts";
import { describe, expect, it } from "vitest";

import { createMemoryAnalysisTaskStore } from "./task-store.js";
import { TaskResultService } from "./task-result.js";

describe("TaskResultService", () => {
  it("returns the latest matching field result with structured evidence and actions", async () => {
    const store = createMemoryAnalysisTaskStore();
    await store.save(task({ id: "growth-new", objective: "growth_stage_monitoring", createdAt: "2026-08-22T00:00:00.000Z" }));
    await store.save(task({ id: "frost-old", objective: "frost_risk_warning", createdAt: "2026-08-20T00:00:00.000Z" }));
    await store.save(task({ id: "frost-other", fieldId: "field-2", objective: "frost_risk_warning", createdAt: "2026-08-23T00:00:00.000Z" }));
    const service = new TaskResultService(store, () => new Date("2026-08-26T12:00:00.000Z"));

    const result = await service.get({ fieldId: "field-1", objective: "frost_risk_warning", focus: "evidence" });

    expect(result).toMatchObject({
      tool: "get_task_result", status: "found", requestedObjective: "frost_risk_warning", requestedFocus: "evidence",
      checkedAt: "2026-08-26T12:00:00.000Z", task: { id: "frost-old", headline: "西南区域需要关注" },
    });
    expect(result.message).toContain("ECMWF IFS 2026-08-20");
  });

  it("answers location and action questions from the same published result", async () => {
    const store = createMemoryAnalysisTaskStore();
    await store.save(task({}));
    const service = new TaskResultService(store);

    const locations = await service.get({ fieldId: "field-1", objective: null, focus: "locations" });
    const actions = await service.get({ fieldId: "field-1", objective: null, focus: "actions" });

    expect(locations.message).toContain("约 1.25 公顷");
    expect(locations.message).toBe("地图上标出了1处关注区：西南关注区，约 1.25 公顷：连续观测偏弱。");
    expect(actions.message).toContain("24 小时内");
    expect(actions.message).toContain("西南区域");
  });

  it("does not repeat source evidence as synthesized reasoning when no brief exists", async () => {
    const store = createMemoryAnalysisTaskStore();
    await store.save(task({
      brief: null,
      sources: [{ source: "sentinel-2", observedAt: "2026-08-20", quality: "missing", note: "当前窗口没有可用光学观测。" }],
    }));

    const result = await new TaskResultService(store).get({ fieldId: "field-1", objective: null, focus: "evidence" });

    expect(result.message).toBe("当前窗口没有可用光学观测。（sentinel-2 2026-08-20）");
  });

  it("does not skip a newer running task or invent a result", async () => {
    const store = createMemoryAnalysisTaskStore();
    await store.save(task({ id: "older", createdAt: "2026-08-20T00:00:00.000Z" }));
    await store.save(task({
      id: "running", createdAt: "2026-08-21T00:00:00.000Z", status: "running", stage: "读取光学观测",
      summary: null, brief: null, findings: [], analysisResults: [], sources: [], limitations: [], nextActions: [], completedAt: null,
    }));

    const result = await new TaskResultService(store).get({ fieldId: "field-1", objective: null, focus: "summary" });

    expect(result).toMatchObject({ status: "not_ready", task: { id: "running", status: "running" } });
    expect(result.message).toContain("读取光学观测");
  });

  it("returns an explicit not-found result within the requested field", async () => {
    const result = await new TaskResultService(createMemoryAnalysisTaskStore()).get({ fieldId: "field-1", objective: "waterlogging_detection", focus: "summary" });
    expect(result).toMatchObject({ status: "not_found", task: null, message: "这块农田还没有可读取的积水识别结果。" });
  });
});

function task(overrides: Partial<AnalysisTask>): AnalysisTask {
  return {
    id: "task-1", fieldId: "field-1", objective: "growth_stage_monitoring",
    timeRange: { start: "2026-08-01", end: "2026-08-20" }, status: "completed", progress: 100, stage: "已完成",
    createdAt: "2026-08-20T00:00:00.000Z", completedAt: "2026-08-20T00:01:00.000Z", demoData: false,
    summary: "西南区域需要关注。",
    brief: {
      version: "analysis-brief-v2", headline: "西南区域需要关注", overview: "西南区域出现持续低值。",
      reasoning: "低温预报与地形背景共同支持当前判断。", uncertainty: "预报仍可能更新。",
      evidence: [{ statement: "未来窗口最低温低于阈值。", sourceDates: [{ source: "ECMWF IFS", date: "2026-08-20" }] }],
      actions: [{ label: "核查西南区域", where: "西南区域", timing: "24 小时内", checklist: ["叶片状态"] }],
      generation: { mode: "deterministic", generatedAt: "2026-08-20T00:01:00.000Z", provider: null, modelId: null, promptVersion: null, fallbackReason: null },
    },
    findings: [{ id: "zone-1", title: "西南关注区", summary: "连续观测偏弱。", severity: "watch", areaHa: 1.25, sourceDates: ["2026-08-20"], zone: [{ longitude: 123.8, latitude: 42.3 }, { longitude: 123.801, latitude: 42.3 }, { longitude: 123.801, latitude: 42.301 }] }],
    sources: [{ source: "ECMWF IFS", observedAt: "2026-08-20", quality: "usable", note: "预报有效。" }], analysisResults: [], limitations: ["预报仍可能更新。"],
    nextActions: [{ code: "inspect", label: "核查西南区域", zoneRef: "zone-1" }], failure: null,
    ...overrides,
  };
}
