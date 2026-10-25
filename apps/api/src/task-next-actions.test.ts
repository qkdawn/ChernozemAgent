import type { AnalysisTask } from "@chernozem/contracts";
import { describe, expect, it } from "vitest";

import { attachTaskAcquisitionRequests } from "./task-next-actions.js";

describe("task next action acquisition requests", () => {
  it("attaches the workflow profile and task period to a missing evidence action", () => {
    const task = baseTask();
    task.objective = "waterlogging_detection";
    const [action] = attachTaskAcquisitionRequests(task, [{ code: "collect_weather", label: "补充连续降雨" }]);
    expect(action?.acquisitionRequest).toEqual({
      fieldId: "field-1", boundaryVersion: 3, dataProfile: "waterlogging_v1", period: task.timeRange,
    });
  });

  it("uses a fresh 30 day window when the next step needs new optical imagery", () => {
    const task = baseTask();
    const [action] = attachTaskAcquisitionRequests(task, [{ code: "collect_recent_optical_data", label: "等待新影像" }]);
    expect(action?.acquisitionRequest).toMatchObject({
      dataProfile: "growth_stage_v1",
      period: { start: "2026-07-27T00:00:00.000Z", end: "2026-08-26T00:00:00.000Z" },
    });
  });

  it("does not turn analysis retries or field edits into acquisition requests", () => {
    const actions = attachTaskAcquisitionRequests(baseTask(), [
      { code: "retry_radar_analysis", label: "重试" },
      { code: "add_planting_date", label: "补播期" },
    ]);
    expect(actions.every((action) => action.acquisitionRequest === undefined)).toBe(true);
  });
});

function baseTask(): AnalysisTask {
  return {
    id: "task-1", fieldId: "field-1", boundaryVersion: 3, objective: "growth_stage_monitoring",
    timeRange: { start: "2026-06-01T00:00:00.000Z", end: "2026-06-30T00:00:00.000Z" },
    status: "partial", progress: 100, stage: "已完成", createdAt: "2026-06-30T00:00:00.000Z",
    completedAt: "2026-08-26T00:00:00.000Z", demoData: false, summary: "完成", brief: null,
    findings: [], sources: [], analysisResults: [], limitations: [], nextActions: [], failure: null,
  };
}
