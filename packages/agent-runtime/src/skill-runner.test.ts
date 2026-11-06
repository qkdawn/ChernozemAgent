import type { AnalysisResult } from "@chernozem/contracts";
import { describe, expect, it } from "vitest";

import { CornSkillRunner, type ControlledAnalysisTool } from "./skill-runner.js";

describe("CornSkillRunner", () => {
  it("runs acquired-source evidence before the growth assessment in fixed order", async () => {
    const calls: string[] = [];
    const names = ["analyze_optical_condition", "estimate_crop_stage", "analyze_radar_change", "analyze_weather_event", "analyze_terrain_susceptibility", "get_soil_background", "assess_growth_status"] as const;
    const tools = names.map((name) => ({
      name,
      async execute(input: { taskId: string }) {
        calls.push(`${name}:${input.taskId}`);
        const kind = name === "assess_growth_status" ? "assessment"
          : name === "estimate_crop_stage" ? "crop_stage"
          : name === "analyze_optical_condition" ? "optical_condition"
          : name === "analyze_radar_change" ? "radar_change"
          : name === "analyze_weather_event" ? "weather_event"
          : name === "analyze_terrain_susceptibility" ? "terrain_susceptibility"
          : "soil_background";
        return result(input.taskId, name, kind);
      },
    })) as ControlledAnalysisTool[];

    const results = await new CornSkillRunner(tools).run("growth_stage_monitoring", "task-1");
    expect(calls).toEqual([
      "analyze_optical_condition:task-1",
      "estimate_crop_stage:task-1",
      "analyze_radar_change:task-1",
      "analyze_weather_event:task-1",
      "analyze_terrain_susceptibility:task-1",
      "get_soil_background:task-1",
      "assess_growth_status:task-1",
    ]);
    expect(results.at(-1)?.kind).toBe("assessment");
  });

  it("refuses to run a skill when its required tools are not registered", async () => {
    await expect(new CornSkillRunner([]).run("waterlogging_detection", "task-1")).rejects.toThrow("缺少受控工具");
  });

  it("rejects a tool result whose execution identity does not match the registered tool", async () => {
    const names = ["analyze_optical_condition", "estimate_crop_stage", "analyze_radar_change", "analyze_weather_event", "analyze_terrain_susceptibility", "get_soil_background", "assess_growth_status"] as const;
    const tools = names.map((name) => ({
      name,
      async execute(input: { taskId: string }) {
        return result(input.taskId, "analyze_optical_condition", name === "assess_growth_status" ? "assessment" : name === "estimate_crop_stage" ? "crop_stage" : "optical_condition");
      },
    })) as ControlledAnalysisTool[];

    await expect(new CornSkillRunner(tools).run("growth_stage_monitoring", "task-1"))
      .rejects.toThrow("返回了 analyze_optical_condition 的执行记录");
  });

  it("runs the water-nitrogen skill as a multi-source investigation", async () => {
    const calls: string[] = [];
    const names = [
      "analyze_optical_condition",
      "estimate_crop_stage",
      "analyze_radar_change",
      "analyze_weather_event",
      "analyze_terrain_susceptibility",
      "get_soil_background",
      "assess_water_nitrogen_evidence",
    ] as const;
    const tools = names.map((name) => ({
      name,
      async execute(input: { taskId: string }) {
        calls.push(name);
        const kind = name === "assess_water_nitrogen_evidence" ? "assessment"
          : name === "analyze_optical_condition" ? "optical_condition"
          : name === "estimate_crop_stage" ? "crop_stage"
          : name === "analyze_radar_change" ? "radar_change"
          : name === "analyze_weather_event" ? "weather_event"
          : name === "analyze_terrain_susceptibility" ? "terrain_susceptibility"
          : "soil_background";
        return result(input.taskId, name, kind);
      },
    })) as ControlledAnalysisTool[];

    await new CornSkillRunner(tools).run("water_nitrogen_diagnosis", "task-water-nitrogen");
    expect(calls).toEqual([...names]);
  });
});

function result(taskId: string, toolName: ControlledAnalysisTool["name"], kind: AnalysisResult<unknown>["kind"]): AnalysisResult<unknown> {
  return { id: `${kind}-1`, taskId, kind, status: "succeeded", toolVersion: "test", createdAt: "2026-08-17T00:00:00.000Z",
    execution: { toolName, scope: { fieldId: "field-1", boundaryVersion: 1, timeRange: null }, inputs: { acquisitionIds: [], assetIds: [], resultIds: [] }, parameters: {}, inputFingerprint: "test" },
    summary: "test", result: {}, sources: [], findings: [], artifacts: [], limitations: [], nextActions: [], error: null };
}
