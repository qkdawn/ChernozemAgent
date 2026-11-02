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
    expect(report.modules.find((item) => item.id === "persistent-low-vigor")).toMatchObject({ status: "insufficient_evidence", body: expect.stringContaining("未识别") });
    expect(report.aiReport.summary).toContain("未识别可排序偏弱区");
    expect(report.aiReport.summary).not.toMatch(/西南|暗区|偏弱带/);
    expect(report.recommendedNextStep.summary).toContain("全田");
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
