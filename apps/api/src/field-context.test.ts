import type { AnalysisTask, DataAcquisitionRun, FieldSummary, SourceAcquisitionResult } from "@chernozem/contracts";
import { describe, expect, it } from "vitest";

import { FieldContextService } from "./field-context.js";
import { createMemoryAnalysisTaskStore } from "./task-store.js";

describe("FieldContextService", () => {
  it("returns current-boundary data and the latest three tasks without geometry", async () => {
    const tasks = createMemoryAnalysisTaskStore();
    await tasks.save(task({ id: "task-new", createdAt: "2026-08-22T00:00:00.000Z" }));
    await tasks.save(task({ id: "task-old", objective: "frost_risk_warning", createdAt: "2026-08-20T00:00:00.000Z" }));
    const runs = [
      acquisition({ id: "current", boundaryVersion: 2, source: source({ source: "sentinel-2", status: "partial" }) }),
      acquisition({ id: "old-boundary", boundaryVersion: 1, source: source({ source: "sentinel-1", status: "succeeded" }) }),
    ];
    const service = new FieldContextService(tasks, { async list() { return runs; } }, () => new Date("2026-08-26T12:00:00.000Z"));

    const result = await service.get({ field: field(), focus: "data" });

    expect(result).toMatchObject({
      tool: "get_field_context", status: "found", requestedFocus: "data", checkedAt: "2026-08-26T12:00:00.000Z",
      field: { name: "北田", crop: "corn", boundaryVersion: 2 },
      data: { currentBoundaryRunCount: 1, sources: [{ source: "sentinel-2", status: "partial", retrievedAssetCount: 1 }] },
      recentTasks: [{ id: "task-new" }, { id: "task-old" }],
      missingInputs: ["播种日期"],
    });
    expect(result.message).toContain("Sentinel-2 光学（部分可用，最近 8月20日）");
    expect(result.data.sources).toHaveLength(1);
    expect(result).not.toHaveProperty("field.boundary");
  });

  it("states explicit gaps when the field has no acquisition or task history", async () => {
    const result = await new FieldContextService(
      createMemoryAnalysisTaskStore(),
      { async list() { return []; } },
    ).get({ field: { ...field(), plantingDate: "2026-05-05" }, focus: "summary" });

    expect(result.message).toContain("5月5日播种");
    expect(result.message).toContain("当前边界还没有数据采集记录");
    expect(result.message).toContain("这块农田还没有分析任务");
    expect(result.missingInputs).toEqual(["当前边界的数据采集记录"]);
  });
});

function field(): FieldSummary {
  return {
    id: "field-1", organizationId: "org-1", code: "F-1", name: "北田", crop: "corn", seasonYear: 2026,
    plantingDate: null, variety: "先玉 335", areaHa: 12.345, village: "", boundary: [],
    centroid: { longitude: 123.8, latitude: 42.3 }, boundaryVersion: 2, seasonCount: 1,
    latestStatus: "not_analyzed", latestAnalyzedAt: null,
  };
}

function task(overrides: Partial<AnalysisTask>): AnalysisTask {
  return {
    id: "task-1", fieldId: "field-1", objective: "growth_stage_monitoring",
    timeRange: { start: "2026-08-01", end: "2026-08-20" }, status: "completed", progress: 100, stage: "已完成",
    createdAt: "2026-08-20T00:00:00.000Z", completedAt: "2026-08-20T00:01:00.000Z", demoData: false,
    summary: "长势分析完成。", brief: null, findings: [], sources: [], analysisResults: [], limitations: [], nextActions: [], failure: null,
    ...overrides,
  };
}

function acquisition(input: { id: string; boundaryVersion: number; source: SourceAcquisitionResult }): DataAcquisitionRun {
  return {
    id: input.id, fieldId: "field-1", boundaryVersion: input.boundaryVersion,
    period: { start: "2026-08-01", end: "2026-08-20" }, dataProfile: "growth_stage_v1", dataProfileVersion: "1",
    status: "partial", createdAt: "2026-08-21T00:00:00.000Z", completedAt: "2026-08-21T00:01:00.000Z",
    manifestVersion: "1", sources: [input.source], progress: [], error: null,
  };
}

function source(overrides: Partial<SourceAcquisitionResult>): SourceAcquisitionResult {
  return {
    sourceType: "optical", source: "sentinel-2", provider: "Copernicus", product: "L2A", status: "succeeded",
    requestedPeriod: { start: "2026-08-01", end: "2026-08-20" }, discoveredAt: "2026-08-21T00:00:00.000Z", retrievedAt: "2026-08-21T00:01:00.000Z",
    availableDates: ["2026-08-18", "2026-08-20"], selectedObservationDates: ["2026-08-20"],
    selectedAssets: [{
      id: "asset-1", providerAssetId: "provider-1", role: "spectral", capturedAt: "2026-08-20", validFrom: null, validTo: null,
      generatedAt: null, retrievedAt: "2026-08-21T00:01:00.000Z", spatialResolutionMeters: 10, crs: "EPSG:32651",
      format: "image/tiff", byteSize: 100, checksum: "abc", artifactRef: "runtime/test.tif", accessStatus: "retrieved",
    }],
    coverage: { requestedAreaHa: 12.345, coveredAreaFraction: 0.8 }, quality: { flags: [], metadata: {} },
    license: { access: "public", downloadAllowed: true, attribution: null }, limitations: ["部分覆盖。"],
    error: { code: null, retryable: false, message: null },
    ...overrides,
  };
}
