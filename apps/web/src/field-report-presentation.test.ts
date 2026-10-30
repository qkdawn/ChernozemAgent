import type { AnalysisResult } from "@chernozem/contracts";
import { describe, expect, it } from "vitest";
import { fieldReportPresentation } from "./field-report-presentation.js";

describe("field report presentation", () => {
  it("selects the NDVI hero and builds real stats and zones from task results", () => {
    const report = fieldReportPresentation([optical({ std: 0.12 })], [layer("ndvi_contrast"), layer("ndvi")], "task-1");

    expect(report.heroMap?.metric).toBe("ndvi");
    expect(report).toMatchObject({ mean: 0.72, std: 0.12, min: 0.31, max: 0.91, coverageFraction: 0.84 });
    expect(report.zones).toEqual([{
      id: "weak-1", label: "偏弱区", areaHa: 1.4, meanNdvi: 0.52, deviation: -0.2, rateKgHa: null,
    }]);
  });

  it("omits standard deviation when historical result data does not contain it", () => {
    const report = fieldReportPresentation([optical({})], [], "task-1");
    expect(report.std).toBeNull();
    expect(report.heroMap).toBeNull();
  });
});

function optical(ndviOverrides: Record<string, number>): AnalysisResult<unknown> {
  return {
    id: "optical-1", taskId: "task-1", kind: "optical_condition", status: "succeeded", toolVersion: "test",
    createdAt: "2026-06-20T00:00:00.000Z", execution: {} as AnalysisResult<unknown>["execution"], summary: "",
    result: { current: { observationDate: "2026-06-20", quality: { validFraction: 0.84 }, metrics: { ndvi: {
      mean: 0.72, min: 0.31, max: 0.91, ...ndviOverrides,
    } } }, zones: [{ id: "weak-1", class: "below_average", areaHa: 1.4, meanNdvi: 0.52, deviation: -0.2 }] },
    sources: [], findings: [], artifacts: [], limitations: [], nextActions: [], error: null,
  };
}

function layer(metric: "ndvi" | "ndvi_contrast") {
  return { ref: `analysis/${metric}.png`, taskId: "task-1", type: "raster" as const, source: "sentinel-2", metric,
    date: "2026-06-20", bounds: [[0, 0], [1, 0], [1, 1], [0, 1]] as [[number, number], [number, number], [number, number], [number, number]],
    min: 0, max: 1, resolutionMeters: 10, unit: "index", label: "NDVI" };
}
