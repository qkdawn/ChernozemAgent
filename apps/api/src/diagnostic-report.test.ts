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
    expect(report.modules.find((item) => item.id === "persistent-low-vigor")).toMatchObject({ status: "ready", body: expect.stringContaining("未识别") });
    expect(report.aiReport.summary).toContain("未识别可排序偏弱区");
    expect(report.aiReport.summary).not.toMatch(/西南|暗区|偏弱带/);
    expect(report.recommendedNextStep.summary).toContain("全田");
  });
  it("densifies an optical no-weak-zone report with absolute paths and evidence", () => {
    const observations = ["2026-10-09", "2026-10-14", "2026-10-19", "2026-10-24", "2026-10-29"].map((date, index) => ({ observationDate: date, metrics: { ndvi: { mean: [0.24, 0.281, 0.22, 0.144, 0.198][index] }, ndre: { mean: 0.2 + index * 0.01 }, ndmi: { mean: 0.1 - index * 0.01 }, ndwi: { mean: 0.2 - index * 0.02 } }, quality: { validFraction: 0.92 } }));
    const optical: AnalysisResult<unknown> = { ...assessment({}), kind: "optical_condition", result: { current: observations.at(-1), observations, changes: [{ fromDate: "2026-10-24", toDate: "2026-10-29", ndviDelta: 0.0546, ndreDelta: 0.0325, ndmiDelta: -0.0409, ndwiDelta: -0.119 }], zones: [{ class: "near_average" }], zoningQuality: { robustRange: 0.03, minimumRobustRange: 0.05, variationVisible: false } } };
    const report = buildDiagnosticReport("growth_stage_monitoring", [assessment({ ...base, meanNdvi: 0.198, validCoverageFraction: 0.92, areaBasis: { fieldAreaHa: 19.49 }, stage: { label: "成熟期", daysAfterPlanting: 177, confidence: "medium" }, latestChange: { fromDate: "2026-10-24", toDate: "2026-10-29", ndviDelta: 0.0546, ndreDelta: 0.0325, ndmiDelta: -0.0409, ndwiDelta: -0.119 } }), optical])!;
    expect(report.aiReport.summary).toMatch(/0\.198|平均 NDVI/);
    expect(report.timeSeries).toHaveLength(5);
    expect(report.modules.find((item) => item.id === "satellite-greening-trend")?.body).toContain("2026-10-09");
    expect(report.modules.find((item) => item.id === "satellite-greening-trend")?.metricDeltas?.[0]).toMatchObject({ fromValue: 0.144, toValue: 0.198 });
    expect(report.modules.every((item) => item.evidenceNotes?.length)).toBe(true);
    expect(report.modules.find((item) => item.id === "moisture-pattern")?.body).toContain("0.060");
    expect(report.aiReport.summary).not.toMatch(/西南|暗区|偏弱带/);
  });
  it("includes numeric greening and provisional moisture changes", () => {
    const report = buildDiagnosticReport("growth_stage_monitoring", [assessment({ ...base, latestChange: { fromDate: "2026-10-19", toDate: "2026-10-29", ndviDelta: -0.04, ndmiDelta: -0.02, ndwiDelta: 0.01 } })])!;
    expect(report.modules.find((item) => item.id === "satellite-greening-trend")?.body).toContain("NDVI 变化 -0.040");
    expect(report.modules.find((item) => item.id === "moisture-pattern")?.body).toContain("待交叉验证");
    expect(report.modules.find((item) => item.id === "water-disease-risk")).toMatchObject({ status: "insufficient_evidence", body: expect.stringContaining("缺少直接证据") });
    expect(report.modules).toHaveLength(6);
  });
  it("attaches the report to a deterministic growth brief", () => {
    expect(buildAnalysisBrief("growth_stage_monitoring", [assessment(base)])?.diagnosticReport?.aiReport.generatedOn).toBe("2026-10-29");
  });
});
