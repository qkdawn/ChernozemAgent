import type { AnalysisTask } from "@chernozem/contracts";
import { describe, expect, it } from "vitest";

import { workflowActionButtonLabel, workflowPrimaryAction } from "./workflow-action-presentation.js";

describe("workflow primary action presentation", () => {
  it.each([
    ["growth planting date", "add_planting_date", "edit_field"],
    ["growth current imagery", "inspect_growth_zones", "inspect_task_zone"],
    ["growth representative observation", "record_growth_observation", "record_field_note"],
    ["growth stale imagery", "collect_recent_optical_data", "open_data"],
    ["water nitrogen field pair", "add_field_note", "inspect_task_zone"],
    ["water nitrogen monitoring", "monitor_supported_zone", "open_data"],
    ["waterlogging weather", "collect_weather", "open_data"],
    ["waterlogging zone", "inspect_waterlogging_zones", "inspect_task_zone"],
    ["waterlogging routine record", "record_waterlogging_event", "record_field_note"],
    ["frost planting date", "fix_planting_date", "edit_field"],
    ["frost zone", "inspect_frost_risk", "inspect_task_zone"],
    ["processing retry", "retry_radar_analysis", "rerun"],
    ["new period", "select_reference_period", "new_analysis"],
  ] as const)("routes %s", (_name, code, expected) => {
    expect(workflowPrimaryAction(task(code))?.kind).toBe(expected);
  });

  it("does not invent an action for a completed task without next actions", () => {
    expect(workflowPrimaryAction(task(null))).toBeNull();
  });

  it("keeps data action labels short and specific", () => {
    const weather = workflowPrimaryAction(task("collect_weather"));
    const optical = workflowPrimaryAction(task("wait_for_new_optical"));
    expect(weather && workflowActionButtonLabel(weather)).toBe("补充天气");
    expect(optical && workflowActionButtonLabel(optical)).toBe("补充光学影像");
  });
});

function task(code: string | null): AnalysisTask {
  return {
    id: "task-1", fieldId: "field-1", objective: "growth_stage_monitoring",
    timeRange: { start: "2026-08-01T00:00:00.000Z", end: "2026-08-20T00:00:00.000Z" },
    status: "completed", progress: 100, stage: "已完成", createdAt: "2026-08-20T00:00:00.000Z",
    completedAt: "2026-08-20T00:01:00.000Z", demoData: false, summary: "完成", brief: null,
    findings: [], sources: [], analysisResults: [], limitations: [],
    nextActions: code ? [{ code, label: "下一步" }] : [], failure: null,
  };
}
