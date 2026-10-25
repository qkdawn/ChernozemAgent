import type { AnalysisTask } from "@chernozem/contracts";
import { describe, expect, it } from "vitest";

import { createMemoryAnalysisTaskStore } from "./task-store.js";
import { WorkflowStatusService } from "./workflow-status.js";

describe("WorkflowStatusService", () => {
  it("returns the latest task for the requested workflow within the field", async () => {
    const store = createMemoryAnalysisTaskStore();
    await store.save(task({ id: "growth-new", fieldId: "field-1", objective: "growth_stage_monitoring", createdAt: "2026-08-20T10:00:00.000Z" }));
    await store.save(task({ id: "frost-old", fieldId: "field-1", objective: "frost_risk_warning", createdAt: "2026-08-19T10:00:00.000Z", status: "running", progress: 45, stage: "读取天气预报" }));
    await store.save(task({ id: "frost-other-field", fieldId: "field-2", objective: "frost_risk_warning", createdAt: "2026-08-21T10:00:00.000Z" }));
    const service = new WorkflowStatusService(store, () => new Date("2026-08-26T12:00:00.000Z"));

    const result = await service.get({ fieldId: "field-1", objective: "frost_risk_warning" });

    expect(result).toMatchObject({
      tool: "get_workflow_status", status: "found", fieldId: "field-1", requestedObjective: "frost_risk_warning",
      checkedAt: "2026-08-26T12:00:00.000Z", task: { id: "frost-old", status: "running", progress: 45 },
    });
    expect(result.message).toContain("读取天气预报");
    expect(result.message).toContain("45%");
  });

  it("uses the latest field workflow when no objective is requested", async () => {
    const store = createMemoryAnalysisTaskStore();
    await store.save(task({ id: "older", fieldId: "field-1", createdAt: "2026-08-19T10:00:00.000Z" }));
    await store.save(task({ id: "latest", fieldId: "field-1", objective: "waterlogging_detection", createdAt: "2026-08-20T10:00:00.000Z", status: "partial", summary: "雷达变化已定位，天气覆盖不足。" }));

    const result = await new WorkflowStatusService(store).get({ fieldId: "field-1", objective: null });

    expect(result.task?.id).toBe("latest");
    expect(result.message).toBe("积水识别已经完成受限分析。 雷达变化已定位，天气覆盖不足。");
  });

  it("returns an explicit not-found result instead of inventing a task", async () => {
    const result = await new WorkflowStatusService(createMemoryAnalysisTaskStore()).get({ fieldId: "field-1", objective: "water_nitrogen_diagnosis" });

    expect(result).toMatchObject({ status: "not_found", task: null, message: "这块农田还没有水氮排查任务。" });
  });
});

function task(overrides: Partial<AnalysisTask>): AnalysisTask {
  return {
    id: "task-1", fieldId: "field-1", objective: "growth_stage_monitoring",
    timeRange: { start: "2026-08-01", end: "2026-08-20" }, status: "completed", progress: 100, stage: "已完成",
    createdAt: "2026-08-20T00:00:00.000Z", completedAt: "2026-08-20T00:01:00.000Z", demoData: false,
    summary: "长势总体稳定。", brief: null, findings: [], sources: [], analysisResults: [], limitations: [], nextActions: [], failure: null,
    ...overrides,
  };
}
