import { describe, expect, it } from "vitest";
import { WATER_NITROGEN_METHOD_VERSION, type AnalysisResult } from "@chernozem/contracts";
import { getWaterNitrogenObservation, waterNitrogenObservationStatus, type WaterNitrogenObservationViewModel } from "./water-nitrogen-presentation.js";

const payload: WaterNitrogenObservationViewModel = {
  methodVersion: WATER_NITROGEN_METHOD_VERSION, assessment: "variation_visible", referenceDate: "2026-07-31",
  cropStage: null, observationCount: 1, validCoverageFraction: null, latestChange: null,
  attentionAreaHa: null, attentionAreaFraction: null, observationAgeDays: 23, observationStatus: "stale",
  observation: { variationStatus: "visible" }, evidenceLevel: "optical_only", zones: [],
};

const result = (value: unknown) => ({ kind: "assessment", result: value } as AnalysisResult<unknown>);

describe("water nitrogen observation presentation", () => {
  it("accepts optical-only results without field records and retains unknown measurements", () => {
    expect(getWaterNitrogenObservation([result(payload)])).toEqual(payload);
    expect(getWaterNitrogenObservation([result(payload)])?.attentionAreaHa).toBeNull();
    expect(getWaterNitrogenObservation([result(payload)])?.validCoverageFraction).toBeNull();
  });

  it("preserves both overlap measurements and per-zone priority with the task summary", () => {
    const rich: WaterNitrogenObservationViewModel = {
      ...payload,
      spatialPrioritySummary: { changesAnyPriority: true, orderedZoneIds: ["zone-1"] },
      zones: [{ id: "zone-1", opticalZoneId: "weak-1", meanNdvi: 0.5, ndviDeviation: -0.1,
        radarOverlap: { status: "computed", overlapAreaHa: 0.2, overlapFraction: 0.1 },
        lowlandOverlap: { status: "computed", overlapAreaHa: 0, overlapFraction: 0 },
        spatialPriority: { status: "computed", changesPriority: true, preferredBecause: "radar_overlap", note: "雷达相交，先行核查" } }],
    };
    expect(getWaterNitrogenObservation([result(rich)])).toMatchObject({
      spatialPrioritySummary: { changesAnyPriority: true },
      zones: [{ radarOverlap: { overlapAreaHa: 0.2 }, lowlandOverlap: { overlapAreaHa: 0 }, spatialPriority: { preferredBecause: "radar_overlap" } }],
    });
  });

  it("does not invent zero hectares when an area field is absent", () => {
    const { attentionAreaHa: _area, ...withoutArea } = payload;
    expect(getWaterNitrogenObservation([result(withoutArea)])).toBeNull();
  });

  it("does not reinterpret old cause-priority contracts as current evidence", () => {
    expect(getWaterNitrogenObservation([result({ ...payload, methodVersion: "water-nitrogen-v3", interpretation: { level: "multi_source" } })])).toBeNull();
  });

  it("finds the assessment when new knowledge results were appended afterward", () => {
    const knowledge = { kind: "knowledge_context", result: { matches: [] } } as unknown as AnalysisResult<unknown>;
    expect(getWaterNitrogenObservation([result(payload), knowledge])).toEqual(payload);
  });

  it.each(["optical_only", "multi_source", "field_comparison"])("preserves the %s data-availability state", (evidenceLevel) => {
    expect(getWaterNitrogenObservation([result({ ...payload, evidenceLevel })])?.evidenceLevel).toBe(evidenceLevel);
  });

  it("keeps review and quality status visible even with multiple sources", () => {
    const current: WaterNitrogenObservationViewModel = { ...payload, observationStatus: "current", evidenceLevel: "multi_source" };
    expect(waterNitrogenObservationStatus(current, "needs_review")).toEqual({ label: "等待专业复核", tone: "partial" });
    expect(waterNitrogenObservationStatus(current, "partial")).toEqual({ label: "部分数据可用", tone: "partial" });
    expect(waterNitrogenObservationStatus({ ...current, observationStatus: "stale" }, "completed")).toEqual({ label: "历史田况", tone: "partial" });
    expect(waterNitrogenObservationStatus({ ...current, evidenceLevel: "optical_only" }, "completed")).toEqual({ label: "光学差异已计算", tone: "complete" });
  });
});
