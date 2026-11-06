import type { AnalysisResult } from "@chernozem/contracts";
import { describe, expect, it } from "vitest";
import { buildAnalysisBrief } from "./analysis-brief.js";
import { buildDiagnosticReport } from "./diagnostic-report.js";

const assessment = (data: Record<string, unknown>): AnalysisResult<unknown> => ({
  id: "growth-1", taskId: "task-1", kind: "assessment", status: "succeeded", toolVersion: "test", createdAt: "2026-10-29T00:00:00Z",
  execution: { toolName: "assess_growth_status", scope: { fieldId: "field-1", boundaryVersion: 1, timeRange: null }, inputs: { acquisitionIds: [], assetIds: [], resultIds: [] }, parameters: {}, inputFingerprint: "test" },
  summary: "", findings: [], limitations: [], nextActions: [], artifacts: [], error: null, sources: [], result: data,
});

describe("buildDiagnosticReport", () => {
  const base = { latestObservationDate: "2026-10-29", meanNdvi: 0.7, observationCount: 2, validCoverageFraction: 0.9, trend: "stable", observationStatus: "current", belowAverageZoneCount: 0, belowAverageAreaHa: 0, belowAverageAreaFraction: 0, weakZones: [] };
  it("does not invent a weak band when the field has none", () => {
    const report = buildDiagnosticReport("growth_stage_monitoring", [assessment(base)])!;
    const module = report.modules.find((item) => item.id === "persistent-low-vigor")!;
    expect(module).toMatchObject({ status: "ready", body: expect.stringContaining("未检出可排序偏弱区") });
    expect(module.body).toMatch(/未检出不等于田内没有|田间无重点/);
    expect(module.body).toContain("差异未过门槛不等于均匀健康");
    expect(module.body).toContain("代表性样段");
    expect(module.body).not.toMatch(/标准差|偏弱区面积|分区门槛/);
    expect(module.evidenceNotes?.join(" ")).toMatch(/分区门槛|平均 NDVI/);
    expect(report.aiReport.summary).toContain("未检出可排序偏弱区");
    expect(report.aiReport.summary).toMatch(/指数读数，不是田间诊断/);
    expect(report.aiReport.summary).toContain("不能据此认定无需进一步核对");
    expect(report.aiReport.summary).not.toMatch(/西南|暗区|偏弱带/);
    expect(report.recommendedNextStep.summary).toContain("全田");
    expect(report.recommendedNextStep.summary).toContain("证据不足");
    expect(report.recommendedNextStep.bullets.join(" ")).toContain("不等于田间决策");
    expect(module.evidenceNotes?.join(" ")).toMatch(/播期来源未核验/);
    expect(module.evidenceNotes?.join(" ")).toMatch(/影像质量与覆盖核验/);
    expect(module.evidenceNotes?.join(" ")).toMatch(/分区门槛依据/);
    expect(module.evidenceNotes?.join(" ")).toMatch(/成熟\/收获状态未核验/);
  });
  it("densifies an optical no-weak-zone report with absolute paths and evidence", () => {
    const observations = ["2026-10-09", "2026-10-14", "2026-10-19", "2026-10-24", "2026-10-29"].map((date, index) => ({ observationDate: date, metrics: { ndvi: { mean: [0.24, 0.281, 0.22, 0.144, 0.198][index] }, ndre: { mean: 0.2 + index * 0.01 }, ndmi: { mean: 0.1 - index * 0.01 }, ndwi: { mean: 0.2 - index * 0.02 } }, quality: { validFraction: 0.92 } }));
    const optical: AnalysisResult<unknown> = { ...assessment({}), kind: "optical_condition", result: { current: observations.at(-1), observations, changes: [{ fromDate: "2026-10-24", toDate: "2026-10-29", ndviDelta: 0.0546, ndreDelta: 0.0325, ndmiDelta: -0.0409, ndwiDelta: -0.119 }], zones: [{ class: "near_average" }], zoningQuality: { robustRange: 0.03, minimumRobustRange: 0.05, variationVisible: false } } };
    const report = buildDiagnosticReport("growth_stage_monitoring", [assessment({ ...base, meanNdvi: 0.198, validCoverageFraction: 0.92, areaBasis: { fieldAreaHa: 19.49 }, stage: { label: "成熟期", daysAfterPlanting: 177, confidence: "medium" }, latestChange: { fromDate: "2026-10-24", toDate: "2026-10-29", ndviDelta: 0.0546, ndreDelta: 0.0325, ndmiDelta: -0.0409, ndwiDelta: -0.119 } }), optical])!;
    expect(report.aiReport.summary).toContain("未检出可排序偏弱区");
    expect(report.aiReport.summary).toContain("待核验的指数上升");
    expect(report.aiReport.summary).not.toContain("全田绿度回升");
    expect(report.aiReport.summary).toContain("不是田间诊断");
    expect(report.aiReport.summary).not.toMatch(/标准差|分区门槛|NDVI 时序为|2026-10-09 0\.240/);
    expect(report.timeSeries).toHaveLength(5);
    expect(report.modules.find((item) => item.id === "satellite-greening-trend")?.body).toContain("待核验的指数上升");
    expect(report.modules.find((item) => item.id === "satellite-greening-trend")?.body).toContain("更不能解读为长势已恢复");
    expect(report.modules.find((item) => item.id === "satellite-greening-trend")?.evidenceNotes?.join(" ")).toContain("2026-10-09");
    expect(report.modules.find((item) => item.id === "satellite-greening-trend")?.metricDeltas?.[0]).toMatchObject({ fromValue: 0.144, toValue: 0.198 });
    expect(report.modules.every((item) => item.evidenceNotes?.length)).toBe(true);
    expect(report.modules.find((item) => item.id === "moisture-pattern")?.body).toMatch(/水分相关指数回落|不能单凭指数/);
    expect(report.modules.find((item) => item.id === "moisture-pattern")?.evidenceNotes?.join(" ")).toContain("0.060");
    expect(report.aiReport.summary).not.toMatch(/西南|暗区|偏弱带/);
  });
  it("keeps greening and moisture interpretation in body and changes in evidence", () => {
    const report = buildDiagnosticReport("growth_stage_monitoring", [assessment({ ...base, latestChange: { fromDate: "2026-10-19", toDate: "2026-10-29", ndviDelta: -0.04, ndmiDelta: -0.02, ndwiDelta: 0.01 } })])!;
    const greening = report.modules.find((item) => item.id === "satellite-greening-trend")!;
    expect(greening.body).toContain("全田均值指数回落");
    expect(greening.body).not.toContain("NDVI 变化 -0.040");
    expect(greening.evidenceNotes?.join(" ")).toContain("-0.040");
    const moisture = report.modules.find((item) => item.id === "moisture-pattern")!;
    expect(moisture.body).toMatch(/冠层水分相关信号|不能单凭指数/);
    expect(moisture.body).toContain("交叉核验");
    expect(moisture.evidenceNotes?.join(" ")).toContain("-0.020");
    expect(report.modules.find((item) => item.id === "water-disease-risk")).toMatchObject({ status: "insufficient_evidence", body: expect.stringContaining("缺少直接证据") });
    expect(report.modules).toHaveLength(6);
  });
  it("uses acquired multi-source evidence with source-specific limits and keeps scouting gaps", () => {
    const sourceResult = (kind: AnalysisResult<unknown>["kind"], data: unknown, status: AnalysisResult<unknown>["status"] = "succeeded"): AnalysisResult<unknown> => ({
      ...assessment({}), kind, status, summary: `${kind} summary`, result: data,
      sources: [{ source: kind === "weather_event" ? "era5-land" : kind === "terrain_susceptibility" ? "copernicus-dem" : kind === "soil_background" ? "soilgrids-250m" : kind === "radar_change" ? "sentinel-1" : "field_record", date: "2026-06-01", quality: "usable", note: "test source" }],
    });
    const weather = sourceResult("weather_event", {
      historical: { start: "2026-06-01", end: "2026-06-30", totalRainfallMm: 40, max24hRainfallMm: 18, minTemperatureC: 8 },
      forecast: { runAt: "2026-07-01T00:00:00Z", start: "2026-07-01", end: "2026-07-05", minTemperatureC: 5, cumulativeRainfallMm: 12 },
    });
    const terrain = sourceResult("terrain_susceptibility", { metrics: { minElevationM: 100, maxElevationM: 120 }, zones: [{ class: "low" }] });
    const soil = sourceResult("soil_background", { available: true, resolutionMeters: 250, properties: ["pH", "SOC"], measurements: [{ label: "pH", mean: 6.4, unit: "" }] });
    const radar = sourceResult("radar_change", { comparable: false, afterDate: "2026-06-20", observations: [{ date: "2026-06-20", meanVvDb: -12 }], zones: [] }, "partial");
    const stage = sourceResult("crop_stage", { label: "拔节期", referenceDate: "2026-06-20", daysAfterPlanting: 46, confidence: "medium", ruleVersion: "corn-days-after-planting-v1" });
    const optical = sourceResult("optical_condition", { current: { quality: { validFraction: 0.8, cloudAffectedFraction: 0.2, flags: ["cloud_contaminated"] } } });
    const report = buildDiagnosticReport("growth_stage_monitoring", [assessment(base), weather, terrain, soil, radar, stage, optical])!;
    const conditions = report.modules.find((item) => item.id === "current-conditions")!;
    expect(conditions.status).toBe("ready");
    expect(conditions.body).toContain("ERA5-Land");
    expect(conditions.body).toContain("不是预报");
    expect(conditions.body).toContain("ECMWF IFS 预报");
    expect(conditions.body).toContain("不混作历史事实");
    expect(conditions.body).toContain("DEM 约 30 米");
    expect(conditions.body).toContain("微地形");
    expect(conditions.body).toContain("SoilGrids 约 250 米");
    expect(conditions.body).toContain("不替代土壤化验");
    expect(conditions.body).toContain("Sentinel-1");
    expect(conditions.body).toContain("没有可比变化对");
    expect(conditions.body).toContain("现场巡田、土壤化验和农事操作记录仍缺失");
    expect(conditions.evidenceNotes?.join(" ")).toContain("cloud_contaminated");
    const stageModule = report.modules.find((item) => item.id === "growth-stage-estimate")!;
    expect(stageModule.evidenceNotes?.join(" ")).toContain("corn-days-after-planting-v1");
    expect(stageModule.evidenceNotes?.join(" ")).toContain("播期来源：field_record（2026-06-01）");
  });
  it("retains honest gaps when acquired-source analysis results are absent", () => {
    const failedWeather: AnalysisResult<unknown> = { ...assessment({}), kind: "weather_event", status: "failed", summary: "天气数据处理未完成。", result: null };
    const report = buildDiagnosticReport("growth_stage_monitoring", [assessment(base), failedWeather])!;
    const conditions = report.modules.find((item) => item.id === "current-conditions")!;
    expect(conditions.status).toBe("insufficient_evidence");
    expect(conditions.body).toMatch(/缺少可用的气象与环境分析结果/);
    expect(conditions.body).toContain("天气分析失败");
    expect(conditions.body).toContain("现场巡田、土壤化验和农事操作记录仍是缺口");
  });
  it("attaches the report to a deterministic growth brief", () => {
    expect(buildAnalysisBrief("growth_stage_monitoring", [assessment(base)])?.diagnosticReport?.aiReport.generatedOn).toBe("2026-10-29");
  });
});
