import type { AnalysisTask, FieldSummary } from "@chernozem/contracts";
import { describe, expect, it } from "vitest";

import { collectNitrogenSourceOptions, createVariableNitrogenPrescription, NitrogenPrescriptionError, prescriptionGeoJson } from "./nitrogen-prescription.js";

const field: FieldSummary = {
  id: "field-1",
  organizationId: "org-1",
  code: "TL-001",
  name: "测试玉米田",
  areaHa: 8.5,
  village: "测试村",
  crop: "corn",
  seasonYear: 2026,
  plantingDate: "2026-05-05",
  variety: null,
  boundaryVersion: 2,
  seasonCount: 1,
  centroid: { longitude: 123.8, latitude: 42.3 },
  boundary: square(123.8, 42.3, 0.004),
  latestStatus: "normal",
  latestAnalyzedAt: null,
};

describe("variable nitrogen prescription", () => {
  it("groups valid NDVI zones into three management levels and calculates totals", () => {
    const task = opticalTask();
    const options = collectNitrogenSourceOptions([task], field.boundaryVersion);
    expect(options).toHaveLength(1);
    expect(options[0]!.zones.map((zone) => zone.level)).toEqual(["low", "medium", "high"]);
    expect(options[0]!.zones.every((zone) => zone.polygons.length === 3)).toBe(true);

    const prescription = createVariableNitrogenPrescription(field, task, {
      sourceTaskId: task.id,
      sourceDate: "2026-07-18",
      fertilizerName: "测试肥料",
      nitrogenPercent: 40,
      standardRateKgHa: 300,
      rates: { low: 260, medium: 300, high: 340 },
    }, new Date("2026-08-20T00:00:00Z"));

    expect(prescription.status).toBe("needs_review");
    expect(prescription.zones).toHaveLength(3);
    expect(prescription.zones[0]!.meanNdvi).toBeLessThan(prescription.zones[1]!.meanNdvi);
    expect(prescription.zones[1]!.meanNdvi).toBeLessThan(prescription.zones[2]!.meanNdvi);
    expect(prescription.zones[0]!.nitrogenRateKgHa).toBe(104);
    expect(prescription.totalProductKg).toBeCloseTo(prescription.zones.reduce((total, zone) => total + zone.totalProductKg, 0), 1);
    expect(prescription.productDifferenceKg).toBeCloseTo(prescription.totalProductKg - prescription.uniformProductKg, 1);

    const geoJson = prescriptionGeoJson(prescription);
    expect(geoJson.features).toHaveLength(9);
    expect(geoJson.features[0]!.properties).toMatchObject({ managementLevel: "low", productRateKgHa: 260, sourceDate: "2026-07-18" });
  });

  it("rejects a stale boundary version", () => {
    const task = { ...opticalTask(), boundaryVersion: 1 };
    expect(() => createVariableNitrogenPrescription(field, task, validRequest())).toThrowError(NitrogenPrescriptionError);
    expect(collectNitrogenSourceOptions([task], field.boundaryVersion)).toEqual([]);
  });

  it("rejects a source date that is not the task's zoned observation", () => {
    expect(() => createVariableNitrogenPrescription(field, opticalTask(), { ...validRequest(), sourceDate: "2026-07-10" })).toThrow("所选日期与光学分析结果不一致");
  });

  it("does not expose legacy grid zones as prescription sources", () => {
    const task = opticalTask();
    const result = task.analysisResults[0]!.result as { zoningMethod?: string };
    delete result.zoningMethod;
    expect(collectNitrogenSourceOptions([task], field.boundaryVersion)).toEqual([]);
  });

  it("rejects a uniform field without visible within-field variation", () => {
    const task = opticalTask();
    const result = task.analysisResults[0]!.result as { zoningQuality?: { variationVisible: boolean } };
    result.zoningQuality = { variationVisible: false };

    expect(collectNitrogenSourceOptions([task], field.boundaryVersion)).toEqual([]);
    expect(() => createVariableNitrogenPrescription(field, task, validRequest())).toThrow("田内差异不足");
  });

  it("rejects invalid nitrogen percentages and rates", () => {
    expect(() => createVariableNitrogenPrescription(field, opticalTask(), { ...validRequest(), nitrogenPercent: 120 })).toThrow("含氮率");
    expect(() => createVariableNitrogenPrescription(field, opticalTask(), { ...validRequest(), rates: { low: -1, medium: 300, high: 300 } })).toThrow("0 至 2000");
  });
});

function validRequest() {
  return {
    sourceTaskId: "task-1",
    sourceDate: "2026-07-18",
    fertilizerName: "测试肥料",
    nitrogenPercent: 40,
    standardRateKgHa: 300,
    rates: { low: 300, medium: 300, high: 300 },
  } as const;
}

function opticalTask(): AnalysisTask {
  return {
    id: "task-1",
    fieldId: field.id,
    boundaryVersion: field.boundaryVersion,
    objective: "growth_stage_monitoring",
    timeRange: { start: "2026-07-01", end: "2026-07-20" },
    status: "completed",
    progress: 100,
    stage: "分析完成",
    createdAt: "2026-07-18T12:00:00Z",
    completedAt: "2026-07-18T12:01:00Z",
    demoData: false,
    summary: "测试",
    brief: null,
    findings: [],
    sources: [],
    limitations: [],
    nextActions: [],
    failure: null,
    analysisResults: [{
      id: "result-1",
      taskId: "task-1",
      kind: "optical_condition",
      status: "succeeded",
      toolVersion: "test",
      createdAt: "2026-07-18T12:00:30Z",
      execution: { toolName: "analyze_optical_condition", scope: { fieldId: field.id, boundaryVersion: field.boundaryVersion, timeRange: null }, inputs: { acquisitionIds: [], assetIds: [], resultIds: [] }, parameters: {}, inputFingerprint: "test" },
      summary: "测试",
      result: {
        current: { observationDate: "2026-07-18", metrics: { ndvi: { mean: 0.66 } } },
        zoningMethod: "ndvi-quantile-connected-v2",
        zoningQuality: { robustRange: 0.24, minimumRobustRange: 0.05, variationVisible: true },
        zones: Array.from({ length: 9 }, (_, index) => ({ id: `zone-${index}`, meanNdvi: 0.45 + index * 0.05, class: index < 3 ? "below_average" : index < 6 ? "near_average" : "above_average", zone: squareCoordinates(123.8 + (index % 3) * 0.001, 42.3 + Math.floor(index / 3) * 0.001, 0.0008) })),
      },
      sources: [],
      findings: [],
      artifacts: [],
      limitations: [],
      nextActions: [],
      error: null,
    }],
  };
}

function square(longitude: number, latitude: number, size: number) {
  return squareCoordinates(longitude, latitude, size).map(([lng, lat]) => ({ longitude: lng!, latitude: lat! }));
}

function squareCoordinates(longitude: number, latitude: number, size: number): number[][] {
  return [[longitude, latitude], [longitude + size, latitude], [longitude + size, latitude + size], [longitude, latitude + size], [longitude, latitude]];
}
