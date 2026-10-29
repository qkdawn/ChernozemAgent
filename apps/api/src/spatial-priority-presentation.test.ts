import { describe, expect, it } from "vitest";
import { WATER_NITROGEN_METHOD_VERSION } from "@chernozem/contracts";
import type { WaterNitrogenEvidencePayload } from "./multi-source-analysis.js";
import { overlapTextImpliesForbiddenMoistureClaim, summarizeSpatialPriorityForBrief } from "./spatial-priority-presentation.js";

function result(overlapAreaHa: number | null, changesPriority: boolean | null, preferredBecause: "radar_overlap" | "none" | null, status = "computed"): WaterNitrogenEvidencePayload {
  const overlap = { sourceResultId: "radar-1", status, geometryAreaHa: 1, overlapAreaHa, overlapFraction: overlapAreaHa === null ? null : overlapAreaHa, contributingZoneIds: [] };
  return {
    methodVersion: WATER_NITROGEN_METHOD_VERSION, assessment: "variation_visible", referenceDate: "2026-07-31", cropStage: null,
    observationCount: 1, validCoverageFraction: 1, latestChange: null, attentionAreaHa: 1, attentionAreaFraction: 0.1,
    observationAgeDays: 0, observationStatus: "current", observation: { ndvi: null, ndre: null, reci: null, msavi: null, ndmi: null, ndwi: null, variationStatus: "visible" },
    zones: [{ id: "zone-1", opticalZoneId: "weak-1", meanNdvi: null, ndviDeviation: null, metricDeviations: null, areaHa: 1, areaFraction: 0.1,
      radarOverlap: overlap, lowlandOverlap: { ...overlap, sourceResultId: null, status: "unavailable", overlapAreaHa: null, overlapFraction: null },
      spatialPriority: { status: status === "computed" ? "computed" : "unavailable", changesPriority, preferredBecause, note: changesPriority ? "与雷达变化区相交，应优先核查。" : "多源空间证据未改变先看哪块弱区。" },
      inspectionRefs: [], inspectionLocationStatus: "not_evaluated", zone: [] }],
    spatialPrioritySummary: { changesAnyPriority: changesPriority, orderedZoneIds: ["zone-1"] }, previousInspections: [], inspectionMatches: [], evidenceLevel: "multi_source",
    sourceAlignment: [], fieldComparison: { status: "absent", lowValueRecords: [], referenceRecords: [], generalRecords: [], pairs: [] },
  } as WaterNitrogenEvidencePayload;
}

describe("spatial priority presentation", () => {
  it("describes positive overlap as a change to check order", () => {
    const summary = summarizeSpatialPriorityForBrief(result(0.2, true, "radar_overlap"));
    expect(summary.overviewClause).toContain("已调整先看顺序");
    expect(summary.firstLookZoneId).toBe("zone-1");
  });

  it("keeps measured zero overlap separate from moisture conclusions", () => {
    const summary = summarizeSpatialPriorityForBrief(result(0, false, "none"));
    expect(overlapTextImpliesForbiddenMoistureClaim(`${summary.overviewClause}${summary.reasoningClause}`)).toBe(false);
    expect(summary.reasoningClause).toContain("已测零交");
  });

  it("states when overlap is unavailable", () => {
    const summary = summarizeSpatialPriorityForBrief(result(null, null, null, "unavailable"));
    expect(summary.overviewClause).toContain("不可计算");
    expect(summary.overviewClause).toContain("无法据此调整先看哪一块");
  });
});
