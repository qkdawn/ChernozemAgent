import type { AnalysisResult, AnalysisToolName } from "@chernozem/contracts";
import { describe, expect, it } from "vitest";

import type { ControlledAnalysisTool } from "./skill-runner.js";
import { runCornWorkflow } from "./workflow-runtime.js";

describe("runCornWorkflow", () => {
  it("rejects a tool result outside the task field scope", async () => {
    await expect(runCornWorkflow({
      objective: "growth_stage_monitoring",
      scope: { organizationId: "org-1", taskId: "task-1", fieldIds: ["field-1"], crop: "corn", period: { start: "2026-06-01", end: "2026-06-30" } },
      tools: growthTools("field-2"),
      eventSink: { async append() {} },
    })).rejects.toThrow("任务范围外的地块结果");
  });
});

function growthTools(fieldId: string): ControlledAnalysisTool[] {
  return [
    tool("analyze_optical_condition", "optical_condition", fieldId),
    tool("estimate_crop_stage", "crop_stage", fieldId),
    tool("assess_growth_status", "assessment", fieldId),
  ];
}

function tool(name: AnalysisToolName, kind: AnalysisResult<unknown>["kind"], fieldId: string): ControlledAnalysisTool {
  return {
    name,
    async execute({ taskId }) {
      return {
        id: `${name}-result`, taskId, kind, status: "succeeded", toolVersion: "test", createdAt: "2026-08-23T00:00:00.000Z",
        execution: { toolName: name, scope: { fieldId, boundaryVersion: 1, timeRange: null }, inputs: { acquisitionIds: [], assetIds: [], resultIds: [] }, parameters: {}, inputFingerprint: "test" },
        summary: "test", result: {}, sources: [], findings: [], artifacts: [], limitations: [], nextActions: [], error: null,
      };
    },
  };
}
