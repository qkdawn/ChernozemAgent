import type { ControlledAnalysisTool, ControlledToolName } from "@chernozem/agent-runtime";
import type { AnalysisResult, AnalysisTimeRange, DataAcquisitionRun, FieldSummary } from "@chernozem/contracts";
import { describe, expect, it } from "vitest";

import { AnalysisToolsetFactory } from "./analysis-toolset.js";
import type { WaterNitrogenInspectionContext } from "./multi-source-analysis.js";

describe("AnalysisToolsetFactory", () => {
  it("uses the planting-season optical window and returns growth tools in Skill order", () => {
    const services = providers();
    const factory = new AnalysisToolsetFactory(services.growth, services.multiSource, () => true);
    const toolset = factory.create({
      objective: "growth_stage_monitoring",
      field: field(),
      timeRange: range("2026-08-01", "2026-08-18"),
      acquisitions: [run("june", "2026-06-10", "2026-06-20"), run("old", "2025-08-01", "2025-08-10")],
    });

    expect(toolset.tools.map((tool) => tool.name)).toEqual(["analyze_optical_condition", "estimate_crop_stage", "assess_growth_status"]);
    expect(toolset.investigationTools.map((tool) => tool.name)).toEqual([
      "analyze_optical_condition", "estimate_crop_stage", "analyze_radar_change", "analyze_weather_event", "analyze_terrain_susceptibility", "get_soil_background",
    ]);
    expect(toolset.investigationTools.some((tool) => tool.name.startsWith("assess_"))).toBe(false);
    expect(toolset.context.opticalObservationRange).toEqual(range("2026-05-04", "2026-08-18"));
    expect(toolset.context.opticalAcquisitionIds).toEqual(["june"]);
    expect(toolset.availability).toMatchObject({ status: "ready", canRun: true, relevantAcquisition: { id: "june" } });
  });

  it("expands a selected waterlogging day backward for a comparable radar pair", () => {
    const services = providers();
    const toolset = new AnalysisToolsetFactory(services.growth, services.multiSource, () => true).create({
      objective: "waterlogging_detection",
      field: field(),
      timeRange: range("2026-08-16", "2026-08-16"),
      acquisitions: [run("before", "2026-08-04", "2026-08-04"), run("target", "2026-08-16", "2026-08-16")],
    });

    expect(toolset.context.evidenceTimeRange).toEqual(range("2026-07-23", "2026-08-16"));
    expect(toolset.context.evidenceAcquisitionIds).toEqual(["before", "target"]);
    expect(toolset.tools.map((tool) => tool.name)).toEqual(["analyze_radar_change", "analyze_weather_event", "analyze_terrain_susceptibility", "detect_waterlogging"]);
  });

  it("combines optical and multisource providers without exposing unrelated growth assessment", () => {
    const services = providers();
    const toolset = new AnalysisToolsetFactory(services.growth, services.multiSource, () => true).create({
      objective: "water_nitrogen_diagnosis",
      field: field(),
      timeRange: range("2026-08-16", "2026-08-16"),
      acquisitions: [run("season", "2026-06-10", "2026-06-20"), run("target", "2026-08-16", "2026-08-16")],
      inspections: [{ taskId: "task-1", findingId: "zone-1", findingTitle: "低值区", scoutingRole: "low_value", observationDates: ["2026-08-16"], checkedAt: "2026-08-16T08:00:00.000Z", observedAt: "2026-08-16", location: { longitude: 123.8, latitude: 42.3 }, waterCondition: "dry", leafColor: "pale", diseaseOrPest: "none_seen", note: "叶色偏浅" }],
    });

    expect(toolset.context.evidenceTimeRange).toEqual(range("2026-07-23", "2026-08-30"));
    expect(toolset.tools.map((tool) => tool.name)).toEqual([
      "analyze_optical_condition", "estimate_crop_stage", "analyze_radar_change", "analyze_weather_event",
      "analyze_terrain_susceptibility", "get_soil_background", "assess_water_nitrogen_evidence",
    ]);
    expect(services.receivedInspections).toHaveLength(1);
  });

  it("returns an explicit missing-period state and no executable tools", () => {
    const services = providers();
    const toolset = new AnalysisToolsetFactory(services.growth, services.multiSource, () => true).create({
      objective: "waterlogging_detection",
      field: field(),
      timeRange: range("2026-08-16", "2026-08-16"),
      acquisitions: [run("old", "2026-05-01", "2026-05-10")],
    });

    expect(toolset.availability).toEqual({
      status: "missing_period_data",
      canRun: false,
      relevantAcquisition: null,
      gap: {
        dataProfile: "waterlogging_v1",
        sources: ["sentinel-1", "copernicus-dem", "era5-land"],
        message: "所选时段没有匹配的采集批次；需要 Sentinel-1 雷达、Copernicus DEM、ERA5-Land 历史天气。",
        nextAction: {
          code: "collect_waterlogging_v1",
          label: "打开地块数据并开始采集",
          acquisitionRequest: {
            fieldId: "field-1",
            boundaryVersion: 1,
            dataProfile: "waterlogging_v1",
            period: range("2026-07-23", "2026-08-16"),
          },
        },
      },
    });
    expect(toolset.tools).toEqual([]);
  });

  it("does not start the Agent when matching runs lack complete optical assets", () => {
    const services = providers();
    const toolset = new AnalysisToolsetFactory(services.growth, services.multiSource, () => false).create({
      objective: "growth_stage_monitoring",
      field: field(),
      timeRange: range("2026-08-01", "2026-08-18"),
      acquisitions: [run("incomplete", "2026-08-01", "2026-08-18")],
    });

    expect(toolset.availability).toEqual({
      status: "missing_analysis_assets",
      canRun: false,
      relevantAcquisition: expect.objectContaining({ id: "incomplete" }),
      gap: {
        dataProfile: "growth_stage_v1",
        sources: ["sentinel-2"],
        message: "已有采集记录，但没有同一观测日期的完整 Sentinel-2 光谱与质量资产。",
        nextAction: {
          code: "collect_growth_stage_v1",
          label: "打开地块数据并开始采集",
          acquisitionRequest: {
            fieldId: "field-1",
            boundaryVersion: 1,
            dataProfile: "growth_stage_v1",
            period: range("2026-08-01", "2026-08-18"),
          },
        },
      },
    });
    expect(toolset.tools).toEqual([]);
  });

  it("rejects a provider composition that omits a required tool", () => {
    const services = providers();
    services.multiSource.createFrostRiskTools = () => [tool("analyze_weather_event"), tool("analyze_terrain_susceptibility")];
    const factory = new AnalysisToolsetFactory(services.growth, services.multiSource, () => true);

    expect(() => factory.create({
      objective: "frost_risk_warning",
      field: field(),
      timeRange: range("2026-08-01", "2026-08-18"),
      acquisitions: [run("forecast", "2026-08-01", "2026-08-18")],
    })).toThrow("缺少受控工具：assess_frost_risk");
  });
});

function providers() {
  const state = { receivedInspections: [] as unknown[] };
  return {
    get receivedInspections() { return state.receivedInspections; },
    growth: {
      createTools: () => [tool("analyze_optical_condition"), tool("estimate_crop_stage"), tool("assess_growth_status")],
    },
    multiSource: {
      createWaterloggingTools: () => [tool("analyze_radar_change"), tool("analyze_weather_event"), tool("analyze_terrain_susceptibility"), tool("detect_waterlogging")],
      createWaterNitrogenTools: (_field: FieldSummary, _runs: DataAcquisitionRun[], _range: AnalysisTimeRange, inspections: WaterNitrogenInspectionContext[] = []) => {
        state.receivedInspections = inspections;
        return [tool("analyze_radar_change"), tool("analyze_weather_event"), tool("analyze_terrain_susceptibility"), tool("get_soil_background"), tool("assess_water_nitrogen_evidence")];
      },
      createFrostRiskTools: () => [tool("analyze_weather_event"), tool("analyze_terrain_susceptibility"), tool("assess_frost_risk")],
    },
  };
}

function tool(name: ControlledToolName): ControlledAnalysisTool {
  return {
    name,
    async execute({ taskId }) {
      return { id: `${name}-result`, taskId, kind: "assessment", status: "succeeded", toolVersion: "test", createdAt: "2026-08-19T00:00:00.000Z", execution: testExecution(name), summary: "test", result: {}, sources: [], findings: [], artifacts: [], limitations: [], nextActions: [], error: null } satisfies AnalysisResult<unknown>;
    },
  };
}

function testExecution(toolName: ControlledToolName) {
  return { toolName, scope: { fieldId: "field-1", boundaryVersion: 1, timeRange: null }, inputs: { acquisitionIds: [], assetIds: [], resultIds: [] }, parameters: {}, inputFingerprint: "test" };
}

function field(): FieldSummary {
  return {
    id: "field-1", organizationId: "org-1", code: "TL-001", name: "测试田", areaHa: 10, village: "铁岭",
    crop: "corn", seasonYear: 2026, plantingDate: "2026-05-04", variety: null, boundaryVersion: 1, seasonCount: 1,
    centroid: { longitude: 123.8, latitude: 42.3 }, boundary: [], latestStatus: "not_analyzed", latestAnalyzedAt: null,
  };
}

function run(id: string, start: string, end: string): DataAcquisitionRun {
  return {
    id, fieldId: "field-1", boundaryVersion: 1, period: range(start, end), dataProfile: "field_baseline_v1", dataProfileVersion: "1",
    status: "completed", createdAt: `${end}T12:00:00.000Z`, completedAt: `${end}T12:01:00.000Z`, manifestVersion: "1", sources: [], progress: [], error: null,
  };
}

function range(start: string, end: string): AnalysisTimeRange {
  return { start: `${start}T00:00:00.000Z`, end: `${end}T23:59:59.999Z` };
}
