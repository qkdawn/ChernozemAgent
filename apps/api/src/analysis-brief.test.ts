import type { AnalysisResult, AnalysisToolName } from "@chernozem/contracts";
import { describe, expect, it } from "vitest";

import { buildAnalysisBrief } from "./analysis-brief.js";

describe("buildAnalysisBrief", () => {
  it("presents a growth calculation summary with actual zone differences", () => {
    const brief = buildAnalysisBrief("growth_stage_monitoring", [assessment("assess_growth_status", {
      stage: { label: "拔节期", daysAfterPlanting: 54 }, status: "watch", trend: "declining", meanNdvi: 0.71,
      latestObservationDate: "2026-07-31", observationCount: 2, validCoverageFraction: 0.92, observationAgeDays: 2, observationStatus: "current",
      latestChange: { fromDate: "2026-07-21", toDate: "2026-07-31", ndviDelta: -0.05 },
      belowAverageZoneCount: 2, belowAverageAreaHa: 1.24, belowAverageAreaFraction: 0.151, aboveAverageZoneCount: 1,
      weakZones: [
        { id: "zone-2", areaHa: 0.44, meanNdvi: 0.64, deviation: -0.07, rank: 1 },
        { id: "zone-1", areaHa: 0.8, meanNdvi: 0.68, deviation: -0.03, rank: 2 },
      ],
    })]);

    expect(brief).toMatchObject({
      version: "analysis-brief-v2",
      headline: "2026-07-31 长势观测：约 1.24 公顷相对偏弱",
      uncertainty: null,
      generation: { mode: "deterministic", fallbackReason: null },
    });
    expect(brief?.overview).toContain("1.24 公顷（占 15.1%）");
    expect(brief?.overview).toContain("覆盖地块 92.0%");
    expect(brief?.reasoning).toContain("偏弱分区 1：0.44 公顷，NDVI 0.640，与全田同日均值相差 -0.070");
    expect(brief?.actions).toEqual([]);
    expect(brief?.reasoning).toContain("2026-07-21 到 2026-07-31");
    expect(brief?.document).toBeUndefined();
  });

  it("finds the assessment by domain kind when investigation adds later results", () => {
    const growth = assessment("assess_growth_status", {
      stage: null, status: "observed", trend: "insufficient_timeseries", meanNdvi: 0.66,
      latestObservationDate: "2026-07-31", observationCount: 1, validCoverageFraction: 0.9, observationAgeDays: 2, observationStatus: "current",
      latestChange: null, belowAverageZoneCount: 1, belowAverageAreaHa: 0.6, belowAverageAreaFraction: 0.073, aboveAverageZoneCount: 0,
    });
    const extra: AnalysisResult<unknown> = { ...growth, id: "extra-weather", kind: "weather_event", status: "needs_data", result: null };
    expect(buildAnalysisBrief("growth_stage_monitoring", [growth, extra])?.overview).toContain("0.60 公顷");
  });

  it("keeps missing stage and single-date limits visible without discarding growth observations", () => {
    const brief = buildAnalysisBrief("growth_stage_monitoring", [assessment("assess_growth_status", {
      stage: null, status: "watch", trend: "insufficient_timeseries", meanNdvi: 0.66,
      latestObservationDate: "2026-07-31", observationCount: 1, validCoverageFraction: 0.76, observationAgeDays: 2, observationStatus: "current",
      latestChange: null, belowAverageZoneCount: 1, belowAverageAreaHa: 0.6, belowAverageAreaFraction: 0.073, aboveAverageZoneCount: 0,
    }, [
      { code: "inspect_growth_zones", label: "优先查看地图上的长势偏弱区" },
      { code: "add_planting_date", label: "补充播种日期以完善生育期解释" },
    ])]);

    expect(brief?.headline).toContain("0.60 公顷相对偏弱");
    expect(brief?.reasoning).toContain("当前只有一个可用观测日期");
    expect(brief?.uncertainty).toContain("只覆盖地块的 76.0%");
    expect(brief?.actions).toEqual([]);
    expect(brief?.document).toBeUndefined();
  });

  it("explains when the latest weak area can be followed across dates", () => {
    const brief = buildAnalysisBrief("growth_stage_monitoring", [assessment("assess_growth_status", {
      stage: { label: "拔节期", daysAfterPlanting: 54 }, status: "watch", trend: "declining", meanNdvi: 0.71,
      latestObservationDate: "2026-07-31", observationCount: 2, validCoverageFraction: 0.92, observationAgeDays: 2, observationStatus: "current",
      latestChange: { fromDate: "2026-07-21", toDate: "2026-07-31", ndviDelta: -0.05 }, belowAverageZoneCount: 2, belowAverageAreaHa: 1.24,
      belowAverageAreaFraction: 0.151, aboveAverageZoneCount: 1,
      zoneChange: { status: "computed", fromDate: "2026-07-21", toDate: "2026-07-31", previousBelowZoneCount: 2, currentBelowZoneCount: 2, previousBelowAreaHa: 1.1, currentBelowAreaHa: 1.24,
        areas: { commonObservedHa: 7.8, belowOnBothDatesHa: 0.7, newlyBelowWithinCommonHa: 0.54, noLongerBelowWithinCommonHa: 0.4, currentBelowUnobservedPreviouslyHa: 0.1, previousBelowUnobservedCurrentlyHa: 0.2 } },
    })]);
    expect(brief?.reasoning).toContain("共同可观测范围的几何面积为 7.80 公顷，其中 0.70 公顷在两期均相对偏弱");
    expect(brief?.reasoning).toContain("0.54 公顷由非偏弱转为相对偏弱");
    expect(brief?.reasoning).toContain("0.40 公顷由相对偏弱转为非偏弱");
    expect(brief?.reasoning).toContain("本期偏弱区另有 0.10 公顷在前期没有可用观测");
    expect(brief?.reasoning).toContain("前期偏弱区另有 0.20 公顷在本期没有可用观测");
    expect(brief?.reasoning).not.toContain("持续");
  });

  it("describes sub-threshold negative growth change as stable rather than declining", () => {
    const result = assessment("assess_growth_status", {
      stage: { label: "拔节期", daysAfterPlanting: 54 }, status: "observed", trend: "stable", meanNdvi: 0.71,
      latestObservationDate: "2026-07-31", observationCount: 2, validCoverageFraction: 0.92, observationAgeDays: 2, observationStatus: "current",
      latestChange: { fromDate: "2026-07-21", toDate: "2026-07-31", ndviDelta: -0.001 },
      belowAverageZoneCount: 0, belowAverageAreaHa: 0, belowAverageAreaFraction: 0, aboveAverageZoneCount: 0,
    });
    result.execution.parameters.meaningfulNdviChange = 0.03;

    const brief = buildAnalysisBrief("growth_stage_monitoring", [result]);

    expect(brief?.reasoning).toContain("NDVI 变化 -0.001");
    expect(brief?.reasoning).not.toContain("NDVI 下降");
  });

  it.each(["optical_only", "multi_source", "field_comparison"])("keeps the %s fallback factual and does not invent an action priority", (evidenceLevel) => {
    const brief = buildAnalysisBrief("water_nitrogen_diagnosis", [assessment("assess_water_nitrogen_evidence", {
      referenceDate: "2026-07-31", observationAgeDays: 1, observationStatus: "current", evidenceLevel, sourceAlignment: [],
      cropStage: { label: "拔节期" }, observationCount: 3, validCoverageFraction: 0.91,
      latestChange: { fromDate: "2026-07-21", toDate: "2026-07-31", ndviDelta: -0.04 }, attentionAreaHa: 1.2, attentionAreaFraction: 0.15,
      observation: { variationStatus: "visible" }, zones: [],
    })]);
    expect(brief?.headline).toContain("约 1.20 公顷");
    expect(brief?.overview).toContain("估计处于拔节期");
    expect(brief?.reasoning).toContain("有效覆盖 91.0%");
    expect(brief?.reasoning).toContain("NDVI 变化 -0.040");
    expect(brief?.overview).not.toMatch(/持续|缺氮|缺水/);
    expect(brief?.uncertainty).toBeNull();
    expect(brief?.actions).toEqual([]);
  });

  it("keeps uniform vegetation as an observation without claiming adequate water and nitrogen", () => {
    const brief = buildAnalysisBrief("water_nitrogen_diagnosis", [assessment("assess_water_nitrogen_evidence", {
      referenceDate: "2026-07-31", observationStatus: "current", observationCount: 2, validCoverageFraction: 0.91,
      evidenceLevel: "optical_only", sourceAlignment: [], attentionAreaHa: 0, attentionAreaFraction: 0,
      observation: { variationStatus: "uniform" }, zones: [],
    })]);
    expect(brief?.overview).toContain("可用影像范围内的植被表现较均匀");
    expect(brief?.overview).not.toMatch(/充足|正常供水|无需施肥/);
  });

  it("does not silently describe missing water-nitrogen area as zero hectares", () => {
    const result = assessment("assess_water_nitrogen_evidence", {
      referenceDate: "2026-07-31", observationStatus: "current", observationCount: 1, validCoverageFraction: 0.91,
      evidenceLevel: "optical_only", sourceAlignment: [], observation: { variationStatus: "visible" }, zones: [],
    });
    expect(buildAnalysisBrief("water_nitrogen_diagnosis", [result])).toBeNull();
  });

  it("still summarizes measured observations when area is explicitly unavailable", () => {
    const result = assessment("assess_water_nitrogen_evidence", {
      referenceDate: "2026-07-31", observationStatus: "current", observationCount: 1, validCoverageFraction: 0.91,
      evidenceLevel: "optical_only", sourceAlignment: [], attentionAreaHa: null, attentionAreaFraction: null,
      observation: { variationStatus: "visible" }, zones: [],
    });
    const brief = buildAnalysisBrief("water_nitrogen_diagnosis", [result]);
    expect(brief?.headline).toContain("面积未计算");
    expect(brief?.overview).not.toContain("0.00 公顷");
    expect(brief?.actions).toEqual([]);
  });

  it("keeps unknown coverage explicit instead of reporting zero coverage", () => {
    const brief = buildAnalysisBrief("water_nitrogen_diagnosis", [assessment("assess_water_nitrogen_evidence", {
      referenceDate: "2026-07-31", observationStatus: "current", observationCount: 1, validCoverageFraction: null,
      evidenceLevel: "optical_only", sourceAlignment: [], attentionAreaHa: 1.2, attentionAreaFraction: 0.15, observation: { variationStatus: "visible" }, zones: [],
    })]);
    expect(brief?.reasoning).toContain("有效覆盖尚未记录");
    expect(brief?.reasoning).not.toContain("覆盖 0.0%");
  });

  it("does not turn an unremarkable radar comparison into an all-period absence of waterlogging", () => {
    const brief = buildAnalysisBrief("waterlogging_detection", [assessment("detect_waterlogging", {
      status: "not_detected", beforeDate: "2026-07-23", afterDate: "2026-08-04", radarCoverageFraction: 0.96,
      changedAreaHa: 0, affectedAreaHa: 0, affectedAreaFraction: 0, rainfallMm: 12, rainfallThresholdMm: 20, zones: [],
    })]);

    expect(brief?.overview).toContain("2026-07-23 至 2026-08-04");
    expect(brief?.uncertainty).toContain("不代表整个时段从未发生积水");
  });

  it("does not promote radar-only change to waterlogging", () => {
    const brief = buildAnalysisBrief("waterlogging_detection", [assessment("detect_waterlogging", {
      methodVersion: "radar-rainfall-terrain-v2", intervalDays: 12, radarCoverageFraction: 0.96, changedAreaHa: 0.7, changedAreaFraction: 0.08, rainfallThresholdMm: 20,
      status: "radar_change_only", beforeDate: "2026-07-23", afterDate: "2026-08-04",
      rainfallMm: null, rainEvent: null, affectedAreaHa: 0, affectedAreaFraction: 0, zones: [{ id: "zone-1", priority: "high" }],
    })]);

    expect(brief?.headline).toContain("还不能说是积水");
    expect(brief?.uncertainty).toContain("连续降雨资料");
  });

  it("separates weather completion from field inspection for radar-only changes", () => {
    const brief = buildAnalysisBrief("waterlogging_detection", [assessment("detect_waterlogging", {
      methodVersion: "radar-rainfall-terrain-v2", intervalDays: 12, radarCoverageFraction: 0.96, changedAreaHa: 0.7, changedAreaFraction: 0.08, rainfallThresholdMm: 20,
      status: "radar_change_only", beforeDate: "2026-07-23", afterDate: "2026-08-04",
      rainfallMm: null, rainEvent: null, affectedAreaHa: 0, affectedAreaFraction: 0, zones: [{ id: "zone-1", priority: "high" }],
    }, [
      { code: "collect_weather", label: "补充雷达观测期间的历史天气" },
      { code: "inspect_radar_change_zones", label: "优先核查低洼且雷达变化明显的区域" },
    ])]);

    expect(brief?.actions[0]).toMatchObject({ where: null, timing: "重新判定积水前", checklist: ["覆盖雷达前后时相", "核对连续降雨量和事件日期"] });
    expect(brief?.actions[1]).toMatchObject({ where: "优先检查低洼且雷达变化明显的区域" });
  });

  it("does not describe a radar change zone as lowland without terrain evidence", () => {
    const brief = buildAnalysisBrief("waterlogging_detection", [assessment("detect_waterlogging", {
      methodVersion: "radar-rainfall-terrain-v2", intervalDays: 12, radarCoverageFraction: 0.96, changedAreaHa: 0.7, changedAreaFraction: 0.08, rainfallThresholdMm: 20,
      status: "radar_change_only", beforeDate: "2026-07-23", afterDate: "2026-08-04",
      rainfallMm: null, rainEvent: null, affectedAreaHa: 0, affectedAreaFraction: 0, zones: [{ id: "zone-1", priority: "normal" }],
    }, [{ code: "inspect_radar_change_zones", label: "优先核查雷达变化明显的区域" }])]);

    expect(brief?.actions[0]).toMatchObject({ where: "优先检查雷达变化明显的区域" });
  });

  it("states the frost risk window and action deadline", () => {
    const brief = buildAnalysisBrief("frost_risk_warning", [assessment("assess_frost_risk", {
      methodVersion: "stage-temperature-duration-terrain-v2", risk: "high", forecastRunAt: "2026-09-18T00:00:00Z", forecastCoverageFraction: 1, forecastGridDistanceKm: 8, terrainStatus: "available", forecastMinTemperatureC: -2.4,
      forecastWindow: { start: "2026-09-18T20:00:00Z", end: "2026-09-19T06:00:00Z" },
      coldDurationHours: 10, cropStage: { label: "灌浆期" }, stageSensitivity: "high", zones: [{ id: "low-1" }],
    }, [{ code: "inspect_frost_risk", label: "检查低洼关注区" }])]);

    expect(brief?.headline).toContain("霜冻风险较高");
    expect(brief?.overview).toContain("-2.4℃");
    expect(brief?.uncertainty).toContain("还不是已经发生冻害");
    expect(brief?.actions[0]?.timing).toBe("9月18日 20:00前完成");
  });

  it("delivers the cold process but keeps crop risk undetermined when stage is missing", () => {
    const brief = buildAnalysisBrief("frost_risk_warning", [assessment("assess_frost_risk", {
      methodVersion: "stage-temperature-duration-terrain-v2", risk: "undetermined", forecastRunAt: "2026-09-18T00:00:00Z", forecastCoverageFraction: 1, forecastGridDistanceKm: 8, terrainStatus: "available", forecastMinTemperatureC: -1.2,
      forecastWindow: { start: "2026-09-18T20:00:00Z", end: "2026-09-19T04:00:00Z" },
      coldDurationHours: 8, cropStage: null, stageSensitivity: "unknown", zones: [{ id: "low-1" }],
    }, [{ code: "add_planting_date", label: "补充播种日期以完成霜冻风险判断" }])]);

    expect(brief?.headline).toContain("还需结合生育期判断");
    expect(brief?.uncertainty).toContain("补充播种日期并核对实际生育期");
    expect(brief?.actions[0]).toMatchObject({ where: null, timing: "9月18日 20:00前完成", checklist: ["核对本季播种日期", "确认当前实际生育期"] });
  });

  it("does not claim a lowland frost target when terrain is missing", () => {
    const brief = buildAnalysisBrief("frost_risk_warning", [assessment("assess_frost_risk", {
      methodVersion: "stage-temperature-duration-terrain-v2", risk: "watch", forecastRunAt: "2026-09-18T00:00:00Z", forecastCoverageFraction: 0.92, forecastGridDistanceKm: 8, terrainStatus: "missing", forecastMinTemperatureC: 0.5,
      forecastWindow: { start: "2026-09-18T20:00:00Z", end: "2026-09-19T04:00:00Z" },
      coldDurationHours: 8, cropStage: { label: "灌浆期" }, stageSensitivity: "high", zones: [],
    }, [{ code: "inspect_frost_risk", label: "核查当前生育期敏感区域的最低温与霜冻迹象" }])]);

    expect(brief?.reasoning).toContain("9月18日 00:00生成的预报");
    expect(brief?.actions[0]).toMatchObject({ where: "当前生育期敏感区域" });
  });
});

function assessment(toolName: AnalysisToolName, result: unknown, nextActions: AnalysisResult<unknown>["nextActions"] = []): AnalysisResult<unknown> {
  return {
    id: `${toolName}-result`, taskId: "task-1", kind: "assessment", status: "succeeded", toolVersion: "test", createdAt: "2026-08-01T00:00:00Z",
    execution: { toolName, scope: { fieldId: "field-1", boundaryVersion: 1, timeRange: null }, inputs: { acquisitionIds: [], assetIds: [], resultIds: [] }, parameters: {}, inputFingerprint: "test" },
    summary: "测试评估。", result,
    sources: [{ source: "sentinel-2", date: "2026-07-31", quality: "usable", note: "测试来源" }],
    findings: [{ id: "finding-1", summary: "测试证据。", sourceDates: [{ source: "sentinel-2", date: "2026-07-31" }], zoneRef: null }],
    artifacts: [], limitations: [], nextActions, error: null,
  };
}
