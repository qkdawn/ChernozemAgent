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
    expect(module).toMatchObject({ status: "ready", body: expect.stringContaining("未识别") });
    expect(module.body).toContain("代表性样段");
    expect(module.body).not.toMatch(/标准差|偏弱区面积|分区门槛/);
    expect(module.evidenceNotes?.join(" ")).toMatch(/分区门槛|平均 NDVI/);
    expect(report.aiReport.summary).toContain("未识别可排序偏弱区");
    expect(report.aiReport.summary).not.toMatch(/西南|暗区|偏弱带/);
    expect(report.recommendedNextStep.summary).toContain("全田");
  });
  it("densifies an optical no-weak-zone report with absolute paths and evidence", () => {
    const observations = ["2026-10-09", "2026-10-14", "2026-10-19", "2026-10-24", "2026-10-29"].map((date, index) => ({ observationDate: date, metrics: { ndvi: { mean: [0.24, 0.281, 0.22, 0.144, 0.198][index] }, ndre: { mean: 0.2 + index * 0.01 }, ndmi: { mean: 0.1 - index * 0.01 }, ndwi: { mean: 0.2 - index * 0.02 } }, quality: { validFraction: 0.92 } }));
    const optical: AnalysisResult<unknown> = { ...assessment({}), kind: "optical_condition", result: { current: observations.at(-1), observations, changes: [{ fromDate: "2026-10-24", toDate: "2026-10-29", ndviDelta: 0.0546, ndreDelta: 0.0325, ndmiDelta: -0.0409, ndwiDelta: -0.119 }], zones: [{ class: "near_average" }], zoningQuality: { robustRange: 0.03, minimumRobustRange: 0.05, variationVisible: false } } };
    const report = buildDiagnosticReport("growth_stage_monitoring", [assessment({ ...base, meanNdvi: 0.198, validCoverageFraction: 0.92, areaBasis: { fieldAreaHa: 19.49 }, stage: { label: "成熟期", daysAfterPlanting: 177, confidence: "medium" }, latestChange: { fromDate: "2026-10-24", toDate: "2026-10-29", ndviDelta: 0.0546, ndreDelta: 0.0325, ndmiDelta: -0.0409, ndwiDelta: -0.119 } }), optical])!;
    expect(report.aiReport.summary).toContain("未识别可排序偏弱区");
    expect(report.aiReport.summary).toContain("全田绿度回升");
    expect(report.aiReport.summary).not.toMatch(/标准差|分区门槛|NDVI 时序为|2026-10-09 0\.240/);
    expect(report.timeSeries).toHaveLength(5);
    expect(report.modules.find((item) => item.id === "satellite-greening-trend")?.body).toMatch(/回升|全田均值/);
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
    expect(greening.body).toContain("全田均值回落");
    expect(greening.body).not.toContain("NDVI 变化 -0.040");
    expect(greening.evidenceNotes?.join(" ")).toContain("-0.040");
    const moisture = report.modules.find((item) => item.id === "moisture-pattern")!;
    expect(moisture.body).toMatch(/冠层水分相关信号|不能单凭指数/);
    expect(moisture.body).toContain("交叉核验");
    expect(moisture.evidenceNotes?.join(" ")).toContain("-0.020");
    expect(report.modules.find((item) => item.id === "water-disease-risk")).toMatchObject({ status: "insufficient_evidence", body: expect.stringContaining("缺少直接证据") });
    expect(report.modules).toHaveLength(6);
  });
  it("attaches the report to a deterministic growth brief", () => {
    expect(buildAnalysisBrief("growth_stage_monitoring", [assessment(base)])?.diagnosticReport?.aiReport.generatedOn).toBe("2026-10-29");
  });
});
