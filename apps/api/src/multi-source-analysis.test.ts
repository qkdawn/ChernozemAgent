import type { DataAcquisitionRun, FieldSummary } from "@chernozem/contracts";
import { CornSkillRunner } from "@chernozem/agent-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { createMemoryAnalysisResultStore } from "./analysis-store.js";
import { MultiSourceAnalysisService, type MultiSourceRunners, type WaterNitrogenEvidencePayload, type WaterNitrogenInspectionContext } from "./multi-source-analysis.js";

const taskId = "22222222-2222-4222-8222-222222222222";

afterEach(async () => {
  await rm(resolve(import.meta.dirname, "../../../runtime/artifacts", `analysis/${taskId}`), { recursive: true, force: true });
});

describe("waterlogging analysis tools", () => {
  it("combines a comparable radar pair, heavy rain, and terrain into suspected zones", async () => {
    const store = createMemoryAnalysisResultStore();
    const service = new MultiSourceAnalysisService(store, "python", runners());
    const results = await new CornSkillRunner(service.createWaterloggingTools(field(), [acquisition("2026-06-10", "2026-06-20")], range())).run("waterlogging_detection", taskId);

    expect(results.map((result) => result.kind)).toEqual(["radar_change", "weather_event", "terrain_susceptibility", "assessment"]);
    expect(results.map((result) => result.execution.toolName)).toEqual(["analyze_radar_change", "analyze_weather_event", "analyze_terrain_susceptibility", "detect_waterlogging"]);
    expect(results.at(-1)?.execution.inputs.resultIds).toEqual(results.slice(0, 3).map((result) => result.id).sort());
    expect(results.at(-1)?.execution.scope).toMatchObject({ fieldId: "field-1", boundaryVersion: 1, timeRange: range() });
    expect(results[0]).toMatchObject({ status: "succeeded", result: { comparable: true, intervalDays: 10 } });
    expect(results.at(-1)).toMatchObject({ status: "succeeded", result: { status: "suspected", rainfallMm: 56, zones: [{ id: "zone-1-1", priority: "high" }] } });
    expect(results.at(-1)?.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "sentinel-1", date: "2026-06-10" }),
      expect.objectContaining({ source: "sentinel-1", date: "2026-06-20" }),
      expect.objectContaining({ source: "era5-land", date: "2026-06-15" }),
      expect.objectContaining({ source: "copernicus-dem", date: null }),
    ]));
    expect(results.at(-1)?.sources).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "era5-land", date: "2026-06-30" }),
    ]));
    expect(results.at(-1)?.artifacts[0]).toMatchObject({ kind: "map" });
    const weatherResult = results.find((result) => result.kind === "weather_event");
    expect(weatherResult?.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ chart: expect.objectContaining({ title: "历史降雨", series: [{ label: "每日降雨", points: [{ label: "2026-06-15", value: 56 }] }] }) }),
      expect.objectContaining({ chart: expect.objectContaining({ title: "历史气温" }) }),
    ]));
    expect(await store.list(taskId)).toHaveLength(4);
  });

  it("returns radar change observations without calling them waterlogging when rainfall coverage is missing", async () => {
    const service = new MultiSourceAnalysisService(createMemoryAnalysisResultStore(), "python", runners());
    const augustRange = { start: "2026-08-01T00:00:00Z", end: "2026-08-19T23:59:59Z" };
    const results = await new CornSkillRunner(service.createWaterloggingTools(field(), [acquisition("2026-08-04", "2026-08-16")], augustRange)).run("waterlogging_detection", taskId);

    expect(results[0]).toMatchObject({ status: "succeeded", result: { comparable: true, beforeDate: "2026-08-04", afterDate: "2026-08-16" } });
    expect(results[1]).toMatchObject({ status: "needs_data", result: null });
    expect(results.at(-1)).toMatchObject({
      status: "partial",
      result: { status: "radar_change_only", rainfallMm: null, zones: [{ id: "zone-1-1", priority: "high" }] },
      error: null,
    });
    expect(results.at(-1)?.summary).toContain("暂不判定为积水");
    expect(results.at(-1)?.findings[0]?.summary).toContain("不等于已发生积水");
    expect(results.at(-1)?.sources.map((source) => source.source)).toEqual(["sentinel-1", "sentinel-1", "copernicus-dem"]);
  });

  it("does not turn partial historical weather coverage into a waterlogging conclusion", async () => {
    const store = createMemoryAnalysisResultStore();
    const service = new MultiSourceAnalysisService(store, "python", runners());
    await store.save({ ...resultBase("radar_change"), kind: "radar_change", status: "succeeded", result: {
      beforeDate: "2026-06-10", afterDate: "2026-06-20", intervalDays: 10, comparable: true,
      quality: { totalPixelCount: 100, validPixelCount: 100, validFraction: 1 }, metrics: { beforeVvDb: -8, afterVvDb: -11, vvDeltaDb: -3, beforeVhDb: -14, afterVhDb: -15, vhDeltaDb: -1, changedPixelFraction: 0.4 }, observations: [],
      zones: [{ id: "zone-1", row: 0, column: 0, class: "strong_decrease", meanVvDeltaDb: -3, meanVhDeltaDb: -1, meanAfterVvDb: -11, validPixelCount: 40, zone: [[123.8, 42.3]] }],
    }, artifacts: [], sources: [{ source: "sentinel-1", date: "2026-06-10", quality: "usable", note: "before" }, { source: "sentinel-1", date: "2026-06-20", quality: "usable", note: "after" }] } as any);
    await store.save({ ...resultBase("weather_event"), kind: "weather_event", status: "partial", result: { historical: {
      start: "2026-06-01T00:00:00Z", end: "2026-06-30T23:00:00Z", totalRainfallMm: 56, max24hRainfallMm: 56, minTemperatureC: 15,
      rainEvents: [{ start: "2026-06-15T00:00:00Z", end: "2026-06-15T23:00:00Z", rainfallMm: 56 }], hourCount: 240, coverage: { expectedHourCount: 720, observedHourCount: 240, fraction: 1 / 3 }, daily: [],
    }, forecast: null }, artifacts: [], sources: [{ source: "era5-land", date: "2026-06-30", quality: "partial", note: "incomplete" }] } as any);

    const result = await service.createWaterloggingTools(field(), [], range()).find((tool) => tool.name === "detect_waterlogging")!.execute({ taskId });

    expect(result).toMatchObject({ status: "partial", result: { status: "radar_change_only", rainfallMm: null } });
    expect(result.summary).toContain("暂不判定为积水");
    expect(result.limitations.join(" ")).toContain("有效覆盖率");
  });

  it("does not use partial terrain coverage to raise waterlogging priority", async () => {
    const store = createMemoryAnalysisResultStore();
    const service = new MultiSourceAnalysisService(store, "python", runners());
    const zone = [[123.8, 42.3], [123.81, 42.3], [123.81, 42.31], [123.8, 42.31], [123.8, 42.3]];
    await store.save({ ...resultBase("radar_change"), kind: "radar_change", status: "succeeded", result: {
      beforeDate: "2026-06-10", afterDate: "2026-06-20", intervalDays: 10, comparable: true,
      quality: { totalPixelCount: 100, validPixelCount: 100, validFraction: 1 }, metrics: { beforeVvDb: -8, afterVvDb: -11, vvDeltaDb: -3, beforeVhDb: -14, afterVhDb: -15, vhDeltaDb: -1, changedPixelFraction: 0.4 }, observations: [],
      zones: [{ id: "radar-low", row: 0, column: 0, class: "strong_decrease", meanVvDeltaDb: -3, meanVhDeltaDb: -1, meanAfterVvDb: -11, validPixelCount: 40, zone }],
    }, artifacts: [], sources: [{ source: "sentinel-1", date: "2026-06-10", quality: "usable", note: "before" }, { source: "sentinel-1", date: "2026-06-20", quality: "usable", note: "after" }] } as any);
    await store.save({ ...resultBase("weather_event"), kind: "weather_event", status: "succeeded", result: { historical: {
      start: "2026-06-01T00:00:00Z", end: "2026-06-30T23:00:00Z", totalRainfallMm: 56, max24hRainfallMm: 56, minTemperatureC: 15,
      rainEvents: [{ start: "2026-06-15T00:00:00Z", end: "2026-06-15T23:00:00Z", rainfallMm: 56 }], hourCount: 720, coverage: { expectedHourCount: 720, observedHourCount: 720, fraction: 1 }, daily: [],
    }, forecast: null }, artifacts: [], sources: [{ source: "era5-land", date: "2026-06-15", quality: "usable", note: "complete" }] } as any);
    await store.save({ ...resultBase("terrain_susceptibility"), kind: "terrain_susceptibility", status: "partial", result: {
      zones: [{ id: "terrain-low", row: 0, column: 0, class: "low", relativeElevationM: -1, zone }],
    }, artifacts: [], sources: [{ source: "copernicus-dem", date: null, quality: "partial", note: "limited coverage" }], limitations: ["DEM coverage limited"] } as any);

    const result = await service.createWaterloggingTools(field(), [], range()).find((tool) => tool.name === "detect_waterlogging")!.execute({ taskId });

    expect(result).toMatchObject({ status: "succeeded", result: { status: "suspected", zones: [{ id: "radar-low", priority: "normal", relativeElevationM: null }] } });
    expect(result.sources.map((source) => source.source)).not.toContain("copernicus-dem");
    expect(result.limitations).toContain("DEM 覆盖受限，本次不使用地形调整积水核查优先级。");
  });

  it("stops before a waterlogging conclusion when the radar interval is too long", async () => {
    const service = new MultiSourceAnalysisService(createMemoryAnalysisResultStore(), "python", runners());
    const results = await new CornSkillRunner(service.createWaterloggingTools(field(), [acquisition("2026-05-01", "2026-06-20")], range())).run("waterlogging_detection", taskId);

    expect(results[0]).toMatchObject({ status: "partial", result: { comparable: false, intervalDays: 50 } });
    expect(results.at(-1)).toMatchObject({ status: "needs_data", result: null, error: { code: "radar_pair_not_comparable" } });
  });

  it("delivers a single radar observation as partial without inventing change metrics", async () => {
    const run = acquisition("2026-06-10", "2026-06-20");
    const radarSource = run.sources.find((source) => source.source === "sentinel-1")!;
    radarSource.selectedAssets = radarSource.selectedAssets.slice(-1);
    const base = runners();
    const custom: MultiSourceRunners = {
      ...base,
      async radar(input) {
        if ((input as { mode?: string }).mode !== "observation") return base.radar(input);
        return {
          status: "succeeded",
          quality: { totalPixelCount: 100, validPixelCount: 92, validFraction: 0.92 },
          metrics: null,
          observation: { meanVvDb: -8.4, meanVhDb: -14.2 },
          zones: [],
          visualizations: [],
          error: { code: null, message: null },
        };
      },
    };
    const service = new MultiSourceAnalysisService(createMemoryAnalysisResultStore(), "python", custom);

    const result = await service.createWaterloggingTools(field(), [run], range()).find((tool) => tool.name === "analyze_radar_change")!.execute({ taskId });

    expect(result).toMatchObject({
      status: "partial",
      result: {
        beforeDate: null,
        afterDate: "2026-06-20",
        intervalDays: null,
        comparable: false,
        metrics: null,
        observations: [{ date: "2026-06-20", meanVvDb: -8.4, meanVhDb: -14.2 }],
        zones: [],
      },
      error: null,
    });
    expect(result.summary).toContain("缺少同轨基线，未计算变化");
  });

  it("ignores heavy rain events outside the selected radar interval", async () => {
    const store = createMemoryAnalysisResultStore();
    const service = new MultiSourceAnalysisService(store, "python", runners());
    await store.save({ ...resultBase("radar_change"), kind: "radar_change", status: "succeeded", result: {
      beforeDate: "2026-06-10", afterDate: "2026-06-20", intervalDays: 10, comparable: true,
      quality: { totalPixelCount: 100, validPixelCount: 100, validFraction: 1 },
      metrics: { beforeVvDb: -8, afterVvDb: -11, vvDeltaDb: -3, beforeVhDb: -14, afterVhDb: -15, vhDeltaDb: -1, changedPixelFraction: 0.4 },
      zones: [{ id: "zone-1", row: 0, column: 0, class: "strong_decrease", meanVvDeltaDb: -3, meanVhDeltaDb: -1, meanAfterVvDb: -11, validPixelCount: 40, zone: [[123.8, 42.3]] }],
    }, artifacts: [], sources: [{ source: "sentinel-1", date: "2026-06-10", quality: "usable", note: "before" }, { source: "sentinel-1", date: "2026-06-20", quality: "usable", note: "after" }] } as any);
    await store.save({ ...resultBase("weather_event"), kind: "weather_event", status: "succeeded", result: {
      historical: { start: "2026-06-01T00:00:00Z", end: "2026-06-30T23:00:00Z", totalRainfallMm: 80, max24hRainfallMm: 56, minTemperatureC: 15, rainEvents: [{ start: "2026-06-25T00:00:00Z", end: "2026-06-25T23:00:00Z", rainfallMm: 56 }], hourCount: 720, coverage: { expectedHourCount: 720, observedHourCount: 720, fraction: 1 }, daily: [] }, forecast: null,
    }, artifacts: [], sources: [{ source: "era5-land", date: "2026-06-30", quality: "usable", note: "full task window" }] } as any);

    const result = await service.createWaterloggingTools(field(), [], range()).find((tool) => tool.name === "detect_waterlogging")!.execute({ taskId });

    expect(result).toMatchObject({ status: "succeeded", toolVersion: "waterlogging-assessment-v2", result: { methodVersion: "radar-rainfall-terrain-v2", status: "not_detected", rainfallMm: 0, affectedAreaHa: 0, zones: [] } });
    expect(result.sources.map((source) => source.source)).toEqual(["sentinel-1", "sentinel-1"]);
    expect(result.summary).toContain("未达到 20 毫米事件门槛");
  });

  it("keeps sub-threshold rain and radar change as observations without calling them waterlogging", async () => {
    const store = createMemoryAnalysisResultStore();
    const service = new MultiSourceAnalysisService(store, "python", runners());
    await store.save({ ...resultBase("radar_change"), kind: "radar_change", status: "succeeded", result: {
      beforeDate: "2026-06-10", afterDate: "2026-06-20", intervalDays: 10, comparable: true,
      quality: { totalPixelCount: 100, validPixelCount: 100, validFraction: 1 },
      metrics: { beforeVvDb: -8, afterVvDb: -11, vvDeltaDb: -3, beforeVhDb: -14, afterVhDb: -15, vhDeltaDb: -1, changedPixelFraction: 0.4 }, observations: [],
      zones: [{ id: "zone-1", row: 0, column: 0, class: "strong_decrease", meanVvDeltaDb: -3, meanVhDeltaDb: -1, meanAfterVvDb: -11, validPixelCount: 40, zone: [[123.8, 42.3]] }],
    }, artifacts: [], sources: [{ source: "sentinel-1", date: "2026-06-10", quality: "usable", note: "before" }, { source: "sentinel-1", date: "2026-06-20", quality: "usable", note: "after" }] } as any);
    await store.save({ ...resultBase("weather_event"), kind: "weather_event", status: "succeeded", result: { historical: {
      start: "2026-06-01T00:00:00Z", end: "2026-06-30T23:00:00Z", totalRainfallMm: 8, max24hRainfallMm: 8, minTemperatureC: 15,
      rainEvents: [{ start: "2026-06-15T00:00:00Z", end: "2026-06-15T23:00:00Z", rainfallMm: 8 }], hourCount: 720, coverage: { expectedHourCount: 720, observedHourCount: 720, fraction: 1 }, daily: [],
    }, forecast: null }, artifacts: [], sources: [{ source: "era5-land", date: "2026-06-15", quality: "usable", note: "complete" }] } as any);

    const result = await service.createWaterloggingTools(field(), [], range()).find((tool) => tool.name === "detect_waterlogging")!.execute({ taskId });

    expect(result).toMatchObject({
      status: "succeeded",
      result: {
        status: "not_detected",
        rainfallThresholdMm: 20,
        rainfallMm: 8,
        rainEvent: null,
        changedAreaHa: 4,
        changedAreaFraction: 0.4,
        affectedAreaHa: 0,
        affectedAreaFraction: 0,
        zones: [],
      },
    });
    expect(result.summary).toContain("未达到 20 毫米事件门槛");
  });

  it("renders every radar observation separately from the selected change pair", async () => {
    const calls: unknown[] = [];
    const base = runners();
    const visualizationBounds: [[number, number], [number, number], [number, number], [number, number]] = [[123.8, 42.31], [123.81, 42.31], [123.81, 42.3], [123.8, 42.3]];
    const custom: MultiSourceRunners = {
      ...base,
      async radar(input) {
        calls.push(input);
        const request = input as { mode?: string };
        const result = await base.radar(input);
        if (request.mode === "observation") return { ...result, metrics: null, zones: [], visualizations: [
          { fileName: "vv.png", metric: "vv", label: "VV 后向散射", bounds: visualizationBounds, min: -25, max: 0, resolutionMeters: 10 },
          { fileName: "vh.png", metric: "vh", label: "VH 后向散射", bounds: visualizationBounds, min: -35, max: -2, resolutionMeters: 10 },
        ] };
        return { ...result, visualizations: [{ fileName: "vv-change.png", metric: "radar_change", label: "VV 变化", bounds: visualizationBounds, min: -5, max: 5, resolutionMeters: 10 }] };
      },
    };
    const service = new MultiSourceAnalysisService(createMemoryAnalysisResultStore(), "python", custom);
    const radarTool = service.createWaterloggingTools(field(), [acquisition("2026-06-10", "2026-06-20")], range()).find((tool) => tool.name === "analyze_radar_change")!;
    const result = await radarTool.execute({ taskId });

    expect(calls.filter((input) => (input as { mode?: string }).mode === "observation")).toHaveLength(2);
    expect(result.artifacts.flatMap((artifact) => artifact.visualization ? [{ metric: artifact.visualization.metric, date: artifact.visualization.date }] : [])).toEqual([
      { metric: "vv", date: "2026-06-10" }, { metric: "vh", date: "2026-06-10" },
      { metric: "vv", date: "2026-06-20" }, { metric: "vh", date: "2026-06-20" },
      { metric: "radar_change", date: "2026-06-20" },
    ]);
  });
});

describe("water nitrogen and frost assessment tools", () => {
  it("registers the multi-source support tools for water-nitrogen analysis", () => {
    const service = new MultiSourceAnalysisService(createMemoryAnalysisResultStore(), "python", runners());
    expect(service.createWaterNitrogenTools(field(), [waterNitrogenAcquisition()], range()).map((tool) => tool.name)).toEqual(["analyze_radar_change", "analyze_weather_event", "analyze_terrain_susceptibility", "get_soil_background", "assess_water_nitrogen_evidence"]);
  });

  it("keeps the same multi-source chain when field observations are selected", () => {
    const service = new MultiSourceAnalysisService(createMemoryAnalysisResultStore(), "python", runners());
    const inspection: WaterNitrogenInspectionContext = {
      taskId: "prior-task", findingId: "zone-1", findingTitle: "田况观测", scoutingRole: "low_value", observationDates: ["2026-06-20"], checkedAt: "2026-06-21T00:00:00Z", observedAt: "2026-06-20", location: { longitude: 123.805, latitude: 42.305 }, waterCondition: "wet", leafColor: "pale", diseaseOrPest: "none_seen", note: "西南角偏湿。",
    };
    expect(service.createWaterNitrogenTools(field(), [waterNitrogenAcquisition()], range(), [inspection]).map((tool) => tool.name)).toEqual(["analyze_radar_change", "analyze_weather_event", "analyze_terrain_susceptibility", "get_soil_background", "assess_water_nitrogen_evidence"]);
  });

  it("keeps support tools available while the assessment selects the latest usable optical date", () => {
    const service = new MultiSourceAnalysisService(createMemoryAnalysisResultStore(), "python", runners());
    const usableRun = waterNitrogenAcquisition();
    const cloudyRun = waterNitrogenAcquisition();
    cloudyRun.id = "cloudy-optical-run";
    const cloudyOptical = cloudyRun.sources.find((source) => source.source === "sentinel-2")!;
    cloudyOptical.selectedAssets = cloudyOptical.selectedAssets.map((asset) => ({
      ...asset,
      id: asset.id.replace("2026-06-20", "2026-08-15"),
      providerAssetId: asset.providerAssetId.replace("2026-06-20", "2026-08-15"),
      capturedAt: asset.capturedAt?.replace("2026-06-20", "2026-08-15") ?? null,
    }));
    cloudyOptical.quality.metadata.fieldValidPixelCount = 0;
    const cloudyRadar = cloudyRun.sources.find((source) => source.source === "sentinel-1")!;
    const juneAfter = cloudyRadar.selectedAssets.find((asset) => asset.capturedAt?.startsWith("2026-06-20"))!;
    const juneBefore = cloudyRadar.selectedAssets.find((asset) => asset.capturedAt?.startsWith("2026-06-10"))!;
    cloudyRadar.selectedAssets.push(
      { ...juneBefore, id: "radar-aug-04", providerAssetId: "radar-aug-04", capturedAt: "2026-08-04T02:00:00Z", artifactRef: "test/radar-aug-04" },
      { ...juneAfter, id: "radar-aug-16", providerAssetId: "radar-aug-16", capturedAt: "2026-08-16T02:00:00Z", artifactRef: "test/radar-aug-16" },
    );
    const inspection: WaterNitrogenInspectionContext = {
      taskId: "prior-task", findingId: "zone-1", findingTitle: "田况观测", scoutingRole: "low_value", observationDates: ["2026-06-20"], checkedAt: "2026-06-21T00:00:00Z", observedAt: "2026-06-20", location: { longitude: 123.805, latitude: 42.305 }, waterCondition: "wet", leafColor: "pale", diseaseOrPest: "none_seen", note: "西南角偏湿。",
    };
    const analysisRange = { start: "2026-05-01T00:00:00Z", end: "2026-08-19T23:59:59Z" };
    const tools = service.createWaterNitrogenTools(field(), [usableRun, cloudyRun], analysisRange, [inspection]);
    expect(tools.map((tool) => tool.name)).toEqual(["analyze_radar_change", "analyze_weather_event", "analyze_terrain_susceptibility", "get_soil_background", "assess_water_nitrogen_evidence"]);
  });

  it("does not let a historical field observation change the support-tool chain", () => {
    const service = new MultiSourceAnalysisService(createMemoryAnalysisResultStore(), "python", runners());
    const inspection: WaterNitrogenInspectionContext = {
      taskId: "prior-task", findingId: "zone-1", findingTitle: "田况观测", scoutingRole: "general", observationDates: ["2026-05-01"], checkedAt: "2026-05-02T00:00:00Z", observedAt: "2026-05-01", location: { longitude: 123.805, latitude: 42.305 }, waterCondition: "wet", leafColor: "pale", diseaseOrPest: "none_seen", note: "历史记录。",
    };
    expect(service.createWaterNitrogenTools(field(), [waterNitrogenAcquisition()], range(), [inspection]).map((tool) => tool.name)).toEqual(["analyze_radar_change", "analyze_weather_event", "analyze_terrain_susceptibility", "get_soil_background", "assess_water_nitrogen_evidence"]);
  });

  it("returns observations without predetermined causes or field-check tasks", async () => {
    const store = createMemoryAnalysisResultStore();
    const service = new MultiSourceAnalysisService(store, "python", runners());
    const zone = [[123.8, 42.3], [123.81, 42.3], [123.81, 42.31], [123.8, 42.31], [123.8, 42.3]];
    await store.save({ ...resultBase("optical_condition"), kind: "optical_condition", status: "succeeded", result: { current: { observationDate: "2026-06-20", metrics: { ndre: { mean: 0.2 } }, quality: { validFraction: 0.9 } }, observations: [{ observationDate: "2026-06-10" }, { observationDate: "2026-06-20" }], changes: [{ fromDate: "2026-06-10", toDate: "2026-06-20", ndviDelta: -0.1, ndreDelta: -0.05 }], zones: [{ id: "optical-low", class: "below_average", areaHa: 2, zone }] }, artifacts: [], sources: [{ source: "sentinel-2", date: "2026-06-20", quality: "usable", note: "test" }] } as any);
    await store.save({ ...resultBase("crop_stage"), kind: "crop_stage", status: "succeeded", result: { stage: "jointing", label: "拔节期", referenceDate: "2026-06-20", daysAfterPlanting: 46, confidence: "medium", ruleVersion: "corn-days-after-planting-v1" }, artifacts: [], sources: [{ source: "field_record", date: "2026-05-05", quality: "usable", note: "test" }] } as any);
    await store.save({ ...resultBase("radar_change"), kind: "radar_change", status: "succeeded", result: { comparable: true, metrics: { vvDeltaDb: -2 } }, artifacts: [], sources: [{ source: "sentinel-1", date: "2026-06-20", quality: "usable", note: "test" }] } as any);
    await store.save({ ...resultBase("weather_event"), kind: "weather_event", status: "succeeded", result: { historical: { max24hRainfallMm: 40 }, forecast: null }, artifacts: [], sources: [{ source: "era5-land", date: "2026-06-20", quality: "usable", note: "test" }] } as any);
    await store.save({ ...resultBase("soil_background"), kind: "soil_background", status: "succeeded", result: { available: true }, artifacts: [], sources: [{ source: "soilgrids-250m", date: null, quality: "usable", note: "test" }] } as any);
    const tool = service.createWaterNitrogenTools(field(), [], range()).find((item) => item.name === "assess_water_nitrogen_evidence")!;
    const result = await tool.execute({ taskId });
    expect(result).toMatchObject({ status: "succeeded", toolVersion: "water-nitrogen-assessment-v3", result: { methodVersion: "water-nitrogen-v4", assessment: "variation_visible", cropStage: { label: "拔节期" }, observationCount: 2, validCoverageFraction: 0.9, attentionAreaHa: 2, attentionAreaFraction: 0.2, latestChange: { fromDate: "2026-06-10", toDate: "2026-06-20", ndviDelta: -0.1 }, zones: [{ areaHa: 2, areaFraction: 0.2 }], fieldComparison: { status: "absent" } } });
    expect(result.result).not.toHaveProperty("interpretation");
    expect(result.result).not.toHaveProperty("investigation");
    expect(result.result).not.toHaveProperty("checks");
    expect((result.result as WaterNitrogenEvidencePayload).zones[0]).not.toHaveProperty("pattern");
    expect(result.nextActions).toEqual([]);
    expect(result.limitations).toEqual([]);
  });

  it("uses supporting sources only through the registered water-nitrogen chain", () => {
    const service = new MultiSourceAnalysisService(createMemoryAnalysisResultStore(), "python", runners());
    expect(service.createWaterNitrogenTools(field(), [], range()).map((tool) => tool.name)).toEqual(["analyze_radar_change", "analyze_weather_event", "analyze_terrain_susceptibility", "get_soil_background", "assess_water_nitrogen_evidence"]);
  });

  it("keeps the water-nitrogen chain running when an optional weather file cannot be read", async () => {
    const store = createMemoryAnalysisResultStore();
    const configuredRunners = runners();
    configuredRunners.weather = async () => { throw new Error("rasterio failed to open stale-weather.nc"); };
    const service = new MultiSourceAnalysisService(store, "python", configuredRunners);
    const run = waterNitrogenAcquisition();
    const weatherRef = `analysis/${taskId}/stale-weather.nc`;
    const weatherPath = resolve(import.meta.dirname, "../../../runtime/artifacts", weatherRef);
    await mkdir(resolve(weatherPath, ".."), { recursive: true });
    await writeFile(weatherPath, "not-a-netcdf");
    run.sources.unshift({
      sourceType: "weather-historical", source: "era5-land", provider: "test", product: "test", status: "succeeded", requestedPeriod: null, discoveredAt: "2026-06-20T00:00:00Z", retrievedAt: "2026-06-20T00:00:00Z", availableDates: [], selectedObservationDates: [],
      selectedAssets: [{ id: "weather", providerAssetId: "weather", role: "weather-series", capturedAt: null, validFrom: "2026-06-01T00:00:00Z", validTo: "2026-06-30T23:59:59Z", generatedAt: null, retrievedAt: "2026-06-20T00:00:00Z", spatialResolutionMeters: 9000, crs: "EPSG:4326", format: "NetCDF", byteSize: 1, checksum: null, artifactRef: weatherRef, accessStatus: "retrieved" }],
      coverage: { requestedAreaHa: 10, coveredAreaFraction: 1 }, quality: { flags: [], metadata: {} }, license: { access: "public", downloadAllowed: true, attribution: "test" }, limitations: [], error: { code: null, retryable: false, message: null },
    });
    const tools = service.createWaterNitrogenTools(field(), [run], range());
    const weather = await tools.find((tool) => tool.name === "analyze_weather_event")!.execute({ taskId });
    expect(weather).toMatchObject({ status: "failed", result: null, error: { code: "weather_processing_failed", retryable: true } });
    expect(weather.summary).not.toContain("Traceback");

    await store.save({ ...resultBase("optical_condition"), kind: "optical_condition", status: "succeeded", result: { current: { observationDate: "2026-06-20", metrics: { ndvi: { mean: 0.7 } } }, changes: [], zones: [] }, artifacts: [], sources: [{ source: "sentinel-2", date: "2026-06-20", quality: "usable", note: "test" }] } as any);
    const assessment = await tools.find((tool) => tool.name === "assess_water_nitrogen_evidence")!.execute({ taskId });
    expect(assessment).toMatchObject({ status: "succeeded", result: { methodVersion: "water-nitrogen-v4", assessment: "uniform" } });
    expect(assessment.sources.map((source) => source.source)).toEqual(["sentinel-2"]);
  });

  it("returns failed domain results when radar, terrain, or soil processors crash", async () => {
    const broken = runners();
    broken.radar = async () => { throw new Error("radar traceback\ninternal detail"); };
    broken.terrain = async () => { throw new Error("terrain traceback\ninternal detail"); };
    broken.soil = async () => { throw new Error("soil traceback\ninternal detail"); };
    const service = new MultiSourceAnalysisService(createMemoryAnalysisResultStore(), "python", broken);
    const run = acquisition("2026-06-10", "2026-06-20");
    run.sources.push(soilSource());

    const waterloggingTools = service.createWaterloggingTools(field(), [run], range());
    const radar = await waterloggingTools.find((tool) => tool.name === "analyze_radar_change")!.execute({ taskId });
    const terrain = await waterloggingTools.find((tool) => tool.name === "analyze_terrain_susceptibility")!.execute({ taskId });
    const soil = await service.createWaterNitrogenTools(field(), [run], range()).find((tool) => tool.name === "get_soil_background")!.execute({ taskId });

    expect(radar).toMatchObject({ status: "failed", result: null, error: { code: "radar_processing_failed", message: "radar traceback" } });
    expect(terrain).toMatchObject({ status: "failed", result: null, error: { code: "terrain_processing_failed", message: "terrain traceback" } });
    expect(soil).toMatchObject({ status: "failed", result: null, error: { code: "soil_processing_failed", message: "soil traceback" } });
  });

  it("preserves partial SoilGrids coverage in the domain result", async () => {
    const partial = runners();
    partial.soil = async () => ({
      status: "partial",
      measurements: [{ property: "nitrogen", label: "全氮", depth: "5-15cm", unit: "g/kg", mean: 1.4, min: 1.2, max: 1.6, validPixelCount: 6, totalPixelCount: 10, validFraction: 0.6 }],
      error: { code: null, message: null },
    });
    const service = new MultiSourceAnalysisService(createMemoryAnalysisResultStore(), "python", partial);
    const run = acquisition("2026-06-10", "2026-06-20");
    run.sources.push(soilSource());

    const soil = await service.createWaterNitrogenTools(field(), [run], range()).find((tool) => tool.name === "get_soil_background")!.execute({ taskId });

    expect(soil).toMatchObject({
      status: "partial",
      toolVersion: "soil-background-v1",
      result: { measurements: [{ property: "nitrogen", validFraction: 0.6 }] },
      sources: [{ source: "soilgrids-250m", quality: "partial" }],
      error: null,
    });
  });

  it("requires a normal-area reference before a low-value observation changes the diagnosis", async () => {
    const store = createMemoryAnalysisResultStore();
    const service = new MultiSourceAnalysisService(store, "python", runners());
    await store.save({ ...resultBase("optical_condition"), kind: "optical_condition", status: "succeeded", result: { current: { observationDate: "2026-06-20", metrics: { ndvi: { mean: 0.72 } } }, changes: [], zones: [{ id: "zone-1", class: "below_average", areaHa: 2, zone: [[123.8, 42.3], [123.81, 42.3], [123.81, 42.31], [123.8, 42.31], [123.8, 42.3]] }] }, artifacts: [], sources: [{ source: "sentinel-2", date: "2026-06-20", quality: "usable", note: "test" }] } as any);
    const previousInspection = {
      taskId: "prior-task", findingId: "prior-zone", findingTitle: "长势偏弱区", scoutingRole: "low_value" as const, observationDates: ["2026-06-20"], checkedAt: "2026-06-21T08:00:00.000Z",
      observedAt: "2026-06-19", location: { longitude: 123.805, latitude: 42.305 },
      waterCondition: "normal" as const, leafColor: "pale" as const, diseaseOrPest: "none_seen" as const, note: "叶色偏浅。",
    };

    const result = await service.createWaterNitrogenTools(field(), [], range(), [previousInspection]).find((item) => item.name === "assess_water_nitrogen_evidence")!.execute({ taskId });

    expect(result.result).toMatchObject({ previousInspections: [previousInspection], inspectionMatches: [{ taskId: "prior-task", findingId: "prior-zone", matchedImageDate: "2026-06-20", offsetDays: 1, status: "aligned" }], evidenceLevel: "optical_only", fieldComparison: { status: "unpaired", lowValueRecords: [{ taskId: "prior-task", findingId: "prior-zone" }], referenceRecords: [], pairs: [] } });
    expect(result.summary).toContain("已关联 1 条同期现场记录");
    expect(result.summary).not.toContain("缺氮");
  });

  it("preserves paired field values without prioritizing a cause", async () => {
    const store = createMemoryAnalysisResultStore();
    const service = new MultiSourceAnalysisService(store, "python", runners());
    await store.save({ ...resultBase("optical_condition"), kind: "optical_condition", status: "succeeded", result: {
      current: { observationDate: "2026-06-20", metrics: { ndvi: { mean: 0.72 } } }, observations: [], changes: [], zones: [{ id: "zone-1", class: "below_average", areaHa: 2, zone: [[123.8, 42.3], [123.81, 42.3], [123.81, 42.31], [123.8, 42.31], [123.8, 42.3]] }],
    }, artifacts: [], sources: [{ source: "sentinel-2", date: "2026-06-20", quality: "usable", note: "test" }] } as any);
    const inspections: WaterNitrogenInspectionContext[] = [
      { taskId: "low-task", findingId: "low", findingTitle: "任意低值标题", scoutingRole: "low_value", observationDates: ["2026-06-20"], checkedAt: "2026-06-20T08:00:00Z", observedAt: "2026-06-20", location: { longitude: 123.805, latitude: 42.305 }, waterCondition: "dry", leafColor: "pale", diseaseOrPest: "none_seen", note: "低值点。" },
      { taskId: "reference-task", findingId: "reference", findingTitle: "任意对照标题", scoutingRole: "reference", observationDates: ["2026-06-20"], checkedAt: "2026-06-20T08:10:00Z", observedAt: "2026-06-20", location: { longitude: 123.806, latitude: 42.306 }, waterCondition: "normal", leafColor: "normal", diseaseOrPest: "none_seen", note: "正常对照点。" },
    ];

    const result = await service.createWaterNitrogenTools(field(), [], range(), inspections).find((item) => item.name === "assess_water_nitrogen_evidence")!.execute({ taskId });

    expect(result).toMatchObject({ status: "succeeded", result: { evidenceLevel: "field_comparison", fieldComparison: { status: "paired", pairs: [{ lowValue: { taskId: "low-task", findingId: "low" }, reference: { taskId: "reference-task", findingId: "reference" }, offsetDays: 0 }] }, previousInspections: inspections } });
    expect(result.result).not.toHaveProperty("investigation");
    expect(result.nextActions).toEqual([]);
  });

  it("does not use a note aligned to an older seasonal image to explain the current observation", async () => {
    const store = createMemoryAnalysisResultStore();
    const service = new MultiSourceAnalysisService(store, "python", runners());
    await store.save({ ...resultBase("optical_condition"), kind: "optical_condition", status: "succeeded", result: {
      current: { observationDate: "2026-06-20", metrics: { ndvi: { mean: 0.68 } } },
      observations: [{ observationDate: "2026-06-10" }, { observationDate: "2026-06-20" }],
      changes: [{ fromDate: "2026-06-10", toDate: "2026-06-20", ndviDelta: -0.08 }],
      zones: [{ id: "zone-1", class: "below_average", areaHa: 2, zone: [[123.8, 42.3], [123.81, 42.3], [123.81, 42.31], [123.8, 42.31], [123.8, 42.3]] }],
    }, artifacts: [], sources: [{ source: "sentinel-2", date: "2026-06-10", quality: "usable", note: "old" }, { source: "sentinel-2", date: "2026-06-20", quality: "usable", note: "current" }] } as any);
    const oldInspection: WaterNitrogenInspectionContext = {
      taskId: "old-note", findingId: "old-zone", findingTitle: "旧田况", scoutingRole: "general", observationDates: ["2026-06-10"], checkedAt: "2026-06-10T08:00:00Z", observedAt: "2026-06-10", location: { longitude: 123.805, latitude: 42.305 }, waterCondition: "wet", leafColor: "pale", diseaseOrPest: "none_seen", note: "旧日期记录。",
    };

    const result = await service.createWaterNitrogenTools(field(), [], range(), [oldInspection]).find((item) => item.name === "assess_water_nitrogen_evidence")!.execute({ taskId });

    expect(result).toMatchObject({ status: "succeeded", result: { inspectionMatches: [{ status: "historical", matchedImageDate: "2026-06-20", offsetDays: 10 }], fieldComparison: { status: "absent", pairs: [] } } });
    expect(result.sources.some((source) => source.source === "field_observation")).toBe(false);
  });

  it("treats a paired normal field comparison as field-supported without inventing a cause", async () => {
    const store = createMemoryAnalysisResultStore();
    const service = new MultiSourceAnalysisService(store, "python", runners());
    await store.save({ ...resultBase("optical_condition"), kind: "optical_condition", status: "succeeded", result: {
      current: { observationDate: "2026-06-20", metrics: { ndvi: { mean: 0.68 } } }, observations: [], changes: [], zones: [{ id: "zone-1", class: "below_average", areaHa: 2, zone: [[123.8, 42.3], [123.81, 42.3], [123.81, 42.31], [123.8, 42.31], [123.8, 42.3]] }],
    }, artifacts: [], sources: [{ source: "sentinel-2", date: "2026-06-20", quality: "usable", note: "current" }] } as any);
    const inspections: WaterNitrogenInspectionContext[] = [
      { taskId: "pair-task", findingId: "low", findingTitle: "低值区", scoutingRole: "low_value", observationDates: [], checkedAt: "2026-06-20T08:00:00Z", observedAt: "2026-06-20", location: { longitude: 123.805, latitude: 42.305 }, waterCondition: "normal", leafColor: "normal", diseaseOrPest: "none_seen", note: "未见明显异常。" },
      { taskId: "pair-task", findingId: "reference", findingTitle: "正常区", scoutingRole: "reference", observationDates: [], checkedAt: "2026-06-20T08:10:00Z", observedAt: "2026-06-20", location: { longitude: 123.806, latitude: 42.306 }, waterCondition: "normal", leafColor: "normal", diseaseOrPest: "none_seen", note: "对照区正常。" },
    ];

    const result = await service.createWaterNitrogenTools(field(), [], range(), inspections).find((item) => item.name === "assess_water_nitrogen_evidence")!.execute({ taskId });

    expect(result).toMatchObject({ status: "succeeded", result: { evidenceLevel: "field_comparison", fieldComparison: { status: "paired" }, previousInspections: inspections } });
    expect(result.result).not.toHaveProperty("interpretation");
    expect(result.sources).toEqual(expect.arrayContaining([expect.objectContaining({ source: "field_observation", role: "field_check" })]));
  });

  it("marks field observations outside the optical window as historical or unmatched", async () => {
    const store = createMemoryAnalysisResultStore();
    const service = new MultiSourceAnalysisService(store, "python", runners());
    await store.save({ ...resultBase("optical_condition"), kind: "optical_condition", status: "succeeded", result: {
      current: { observationDate: "2026-06-20", metrics: {} }, observations: [], changes: [], zones: [],
    }, artifacts: [], sources: [{ source: "sentinel-2", date: "2026-06-20", quality: "usable", note: "test" }] } as any);
    const inspections = [
      { taskId: "old-task", findingId: "old-zone", findingTitle: "旧区域", scoutingRole: "general" as const, observationDates: [], checkedAt: "2026-05-02T08:00:00.000Z", observedAt: "2026-05-01", location: { longitude: 123.805, latitude: 42.305 }, waterCondition: "unknown" as const, leafColor: "unknown" as const, diseaseOrPest: "unknown" as const, note: "" },
      { taskId: "bad-task", findingId: "bad-zone", findingTitle: "无效日期", scoutingRole: "general" as const, observationDates: [], checkedAt: "2026-05-02T08:00:00.000Z", observedAt: "not-a-date", location: { longitude: 123.805, latitude: 42.305 }, waterCondition: "unknown" as const, leafColor: "unknown" as const, diseaseOrPest: "unknown" as const, note: "" },
    ];
    const result = await service.createWaterNitrogenTools(field(), [], range(), inspections).find((item) => item.name === "assess_water_nitrogen_evidence")!.execute({ taskId });
    expect(result.result).toMatchObject({ fieldComparison: { status: "absent", pairs: [] }, inspectionMatches: [
      { taskId: "old-task", status: "historical", matchedImageDate: "2026-06-20" },
      { taskId: "bad-task", status: "unmatched", matchedImageDate: null },
    ] });
  });

  it("does not promote a single low-value observation without its reference", async () => {
    const store = createMemoryAnalysisResultStore();
    const service = new MultiSourceAnalysisService(store, "python", runners());
    await store.save({ ...resultBase("optical_condition"), kind: "optical_condition", status: "succeeded", result: {
      current: { observationDate: "2026-06-20", metrics: {}, quality: { validPixelCount: 100 } }, observations: [], changes: [], zones: [{ id: "zone-1", class: "below_average", areaHa: 2, meanNdvi: 0.4, deviation: -0.1, validPixelCount: 20, metricDeviations: { ndre: -0.08, reci: -0.08, ndmi: -0.08, ndwi: -0.04 }, zone: [[123.8, 42.3], [123.81, 42.3], [123.81, 42.31], [123.8, 42.31], [123.8, 42.3]] }],
    }, artifacts: [], sources: [{ source: "sentinel-2", date: "2026-06-20", quality: "usable", note: "test" }] } as any);
    await store.save({ ...resultBase("radar_change"), kind: "radar_change", status: "succeeded", result: { beforeDate: "2026-06-10", afterDate: "2026-06-20", comparable: true, metrics: {}, zones: [] }, artifacts: [], sources: [{ source: "sentinel-1", date: "2026-06-20", quality: "usable", note: "test" }] } as any);
    await store.save({ ...resultBase("weather_event"), kind: "weather_event", status: "succeeded", result: { historical: { max24hRainfallMm: 40, rainEvents: [{ start: "2026-06-19T00:00:00Z", end: "2026-06-19T23:00:00Z", rainfallMm: 40 }] } }, artifacts: [], sources: [{ source: "era5-land", date: "2026-06-30", quality: "usable", note: "月度文件结束日期，不是事件日期" }] } as any);
    const inspection = { taskId: "prior-task", findingId: "prior-zone", findingTitle: "相对低值区", scoutingRole: "low_value" as const, observationDates: [], checkedAt: "2026-06-20T08:00:00.000Z", observedAt: "2026-06-20", location: { longitude: 123.805, latitude: 42.305 }, waterCondition: "wet" as const, leafColor: "pale" as const, diseaseOrPest: "none_seen" as const, note: "叶色偏浅。" };
    const result = await service.createWaterNitrogenTools(field(), [], range(), [inspection]).find((item) => item.name === "assess_water_nitrogen_evidence")!.execute({ taskId });
    expect(result.result).toMatchObject({ evidenceLevel: "multi_source", fieldComparison: { status: "unpaired", referenceRecords: [], pairs: [] }, sourceAlignment: expect.arrayContaining([expect.objectContaining({ kind: "weather_event", status: "unusable" })]) });
    expect(result.summary).toContain("已关联 1 条同期现场记录");
    expect(result.sources.some((source) => source.source === "era5-land")).toBe(false);
  });

  it("measures spatially aligned radar overlap without assigning a cause", async () => {
    const store = createMemoryAnalysisResultStore();
    const service = new MultiSourceAnalysisService(store, "python", runners());
    const alignedZone = [[123.8, 42.3], [123.81, 42.3], [123.81, 42.31], [123.8, 42.31], [123.8, 42.3]];
    await store.save({ ...resultBase("optical_condition"), kind: "optical_condition", status: "succeeded", result: {
      current: { observationDate: "2026-06-20", metrics: { ndre: { mean: 0.2 } } },
      changes: [{ fromDate: "2026-06-10", toDate: "2026-06-20", ndviDelta: -0.1, ndreDelta: -0.05 }],
      zones: [{ id: "zone-1-1", class: "below_average", areaHa: 2, zone: alignedZone, metricDeviations: { ndre: -0.08, reci: -0.1, msavi: -0.04, ndmi: -0.09, ndwi: -0.06 } }],
    }, artifacts: [], sources: [{ source: "sentinel-2", date: "2026-06-20", quality: "usable", note: "test" }] } as any);
    await store.save({ ...resultBase("radar_change"), kind: "radar_change", status: "succeeded", result: {
      beforeDate: "2026-06-10", afterDate: "2026-06-20", comparable: true, metrics: { vvDeltaDb: -2 }, zones: [{ id: "zone-1-1", class: "strong_decrease", meanVvDeltaDb: -2, meanVhDeltaDb: -1, meanAfterVvDb: -11, validPixelCount: 10, row: 0, column: 0, zone: alignedZone }],
    }, artifacts: [], sources: [{ source: "sentinel-1", date: "2026-06-20", quality: "usable", note: "test" }, { source: "sentinel-1", date: "2026-08-04", quality: "usable", note: "未对齐日期" }] } as any);
    await store.save({ ...resultBase("weather_event"), kind: "weather_event", status: "succeeded", result: {
      historical: { max24hRainfallMm: 40, rainEvents: [{ start: "2026-06-20T00:00:00Z", end: "2026-06-20T23:00:00Z", rainfallMm: 40 }] }, forecast: null,
    }, artifacts: [], sources: [{ source: "era5-land", date: "2026-06-20", quality: "usable", note: "test" }, { source: "era5-land", date: "2026-08-04", quality: "usable", note: "未对齐日期" }] } as any);
    await store.save({ ...resultBase("soil_background"), kind: "soil_background", status: "succeeded", result: { available: true }, artifacts: [], sources: [{ source: "soilgrids-250m", date: null, quality: "usable", note: "test" }] } as any);
    const tool = service.createWaterNitrogenTools(field(), [], range()).find((item) => item.name === "assess_water_nitrogen_evidence")!;
    const result = await tool.execute({ taskId });
    expect(result).toMatchObject({ status: "succeeded", result: { evidenceLevel: "multi_source", zones: [{ radarOverlap: { status: "computed", overlapFraction: 1, contributingZoneIds: ["zone-1-1"] }, metricDeviations: { ndre: -0.08, ndmi: -0.09 } }] } });
    expect((result.result as WaterNitrogenEvidencePayload).zones[0]!.radarOverlap.overlapAreaHa).toBeGreaterThan(0);
    expect(result.sources).toEqual(expect.arrayContaining([expect.objectContaining({ source: "sentinel-1", date: "2026-06-20", role: "context" })]));
    expect(result.sources).not.toContainEqual(expect.objectContaining({ date: "2026-08-04" }));
    expect(result.findings[0]?.sourceDates).toEqual([{ source: "sentinel-2", date: "2026-06-20" }]);
    expect(result.result).not.toHaveProperty("interpretation");
  });

  it("does not promote partial weather and terrain into a water-related cause", async () => {
    const store = createMemoryAnalysisResultStore();
    const service = new MultiSourceAnalysisService(store, "python", runners());
    const zone = [[123.8, 42.3], [123.81, 42.3], [123.81, 42.31], [123.8, 42.31], [123.8, 42.3]];
    await store.save({ ...resultBase("optical_condition"), kind: "optical_condition", status: "succeeded", result: {
      current: { observationDate: "2026-06-20", metrics: { ndvi: { mean: 0.7 }, ndmi: { mean: 0.25 }, ndwi: { mean: -0.5 } } }, changes: [],
      zones: [{ id: "optical-low", class: "below_average", areaHa: 2, zone, metricDeviations: { ndre: -0.01, reci: -0.01, msavi: -0.02, ndmi: -0.08, ndwi: -0.06 } }],
    }, artifacts: [], sources: [{ source: "sentinel-2", date: "2026-06-20", quality: "usable", note: "test" }] } as any);
    await store.save({ ...resultBase("weather_event"), kind: "weather_event", status: "partial", result: { historical: {
      start: "2026-06-01T00:00:00Z", end: "2026-06-30T23:00:00Z", max24hRainfallMm: 50,
      rainEvents: [{ start: "2026-06-19T00:00:00Z", end: "2026-06-20T00:00:00Z", rainfallMm: 50 }], coverage: { expectedHourCount: 720, observedHourCount: 360, fraction: 0.5 },
    }, forecast: null }, artifacts: [], sources: [{ source: "era5-land", date: "2026-06-20", quality: "partial", note: "incomplete" }] } as any);
    await store.save({ ...resultBase("terrain_susceptibility"), kind: "terrain_susceptibility", status: "partial", result: {
      zones: [{ id: "terrain-low", row: 0, column: 0, class: "low", relativeElevationM: -1, zone }],
    }, artifacts: [], sources: [{ source: "copernicus-dem", date: null, quality: "partial", note: "limited coverage" }] } as any);

    const result = await service.createWaterNitrogenTools(field(), [], range()).find((tool) => tool.name === "assess_water_nitrogen_evidence")!.execute({ taskId });

    expect(result).toMatchObject({ status: "partial", result: { zones: [{ id: "water-nitrogen-optical-low", lowlandOverlap: { status: "computed", overlapFraction: 1 } }], sourceAlignment: expect.arrayContaining([expect.objectContaining({ kind: "weather_event", status: "unusable" })]) } });
    expect(result.sources.map((source) => source.source)).toEqual(["sentinel-2", "copernicus-dem"]);
    expect(result.result).not.toHaveProperty("interpretation");
  });

  it("does not infer water limitation from a field-level radar change", async () => {
    const store = createMemoryAnalysisResultStore();
    const service = new MultiSourceAnalysisService(store, "python", runners());
    await store.save({ ...resultBase("optical_condition"), kind: "optical_condition", status: "succeeded", result: { current: { observationDate: "2026-06-20", metrics: { ndre: { mean: 0.2 } } }, changes: [{ fromDate: "2026-06-10", toDate: "2026-06-20", ndviDelta: -0.02, ndreDelta: -0.01 }], zones: [] }, artifacts: [], sources: [{ source: "sentinel-2", date: "2026-06-20", quality: "usable", note: "test" }] } as any);
    await store.save({ ...resultBase("radar_change"), kind: "radar_change", status: "succeeded", result: { comparable: true, metrics: { vvDeltaDb: -2 } }, artifacts: [], sources: [{ source: "sentinel-1", date: "2026-06-20", quality: "usable", note: "test" }] } as any);
    await store.save({ ...resultBase("weather_event"), kind: "weather_event", status: "succeeded", result: { historical: { max24hRainfallMm: 0, rainEvents: [] }, forecast: null }, artifacts: [], sources: [{ source: "era5-land", date: "2026-06-20", quality: "usable", note: "test" }] } as any);
    await store.save({ ...resultBase("soil_background"), kind: "soil_background", status: "succeeded", result: { available: true }, artifacts: [], sources: [{ source: "soilgrids-250m", date: null, quality: "usable", note: "test" }] } as any);
    const tool = service.createWaterNitrogenTools(field(), [], range()).find((item) => item.name === "assess_water_nitrogen_evidence")!;
    const result = await tool.execute({ taskId });
    expect(result).toMatchObject({ status: "succeeded", result: { assessment: "uniform", observation: { variationStatus: "uniform" }, zones: [] } });
    expect(result.sources.map((source) => source.source)).toEqual(["sentinel-2", "soilgrids-250m"]);
    expect(result.result).not.toHaveProperty("interpretation");
  });

  it("does not infer nitrogen limitation from a declining field-level NDRE", async () => {
    const store = createMemoryAnalysisResultStore();
    const service = new MultiSourceAnalysisService(store, "python", runners());
    await store.save({ ...resultBase("optical_condition"), kind: "optical_condition", status: "succeeded", result: { current: { observationDate: "2026-06-20", metrics: { ndre: { mean: 0.2 } } }, changes: [{ fromDate: "2026-06-10", toDate: "2026-06-20", ndviDelta: -0.05, ndreDelta: -0.05 }], zones: [] }, artifacts: [], sources: [{ source: "sentinel-2", date: "2026-06-20", quality: "usable", note: "test" }] } as any);
    await store.save({ ...resultBase("radar_change"), kind: "radar_change", status: "succeeded", result: { comparable: true, metrics: { vvDeltaDb: 0 } }, artifacts: [], sources: [{ source: "sentinel-1", date: "2026-06-20", quality: "usable", note: "test" }] } as any);
    await store.save({ ...resultBase("weather_event"), kind: "weather_event", status: "succeeded", result: { historical: { max24hRainfallMm: 0, rainEvents: [] }, forecast: null }, artifacts: [], sources: [{ source: "era5-land", date: "2026-06-20", quality: "usable", note: "test" }] } as any);
    await store.save({ ...resultBase("soil_background"), kind: "soil_background", status: "succeeded", result: { available: true }, artifacts: [], sources: [{ source: "soilgrids-250m", date: null, quality: "usable", note: "test" }] } as any);
    const tool = service.createWaterNitrogenTools(field(), [], range()).find((item) => item.name === "assess_water_nitrogen_evidence")!;
    const result = await tool.execute({ taskId });
    expect(result).toMatchObject({ status: "succeeded", result: { assessment: "uniform", observation: { variationStatus: "uniform" }, latestChange: { ndreDelta: -0.05 } } });
    expect(result.summary).not.toContain("缺氮");
    expect(result.result).not.toHaveProperty("interpretation");
  });

  it("does not attribute a current optical anomaly to rainfall and radar from different dates", async () => {
    const store = createMemoryAnalysisResultStore();
    const service = new MultiSourceAnalysisService(store, "python", runners());
    await store.save({ ...resultBase("optical_condition"), kind: "optical_condition", status: "partial", result: { current: { observationDate: "2026-06-26", metrics: { ndre: { mean: 0.2 } } }, changes: [], zones: [{ id: "zone-1", class: "below_average", areaHa: 2, zone: [[123.8, 42.3], [123.81, 42.3], [123.81, 42.31], [123.8, 42.31], [123.8, 42.3]] }] }, artifacts: [], sources: [{ source: "sentinel-2", date: "2026-06-26", quality: "usable", note: "test" }, { source: "sentinel-2", date: "2026-08-15", quality: "missing", note: "cloud contaminated" }] } as any);
    await store.save({ ...resultBase("radar_change"), kind: "radar_change", status: "succeeded", result: { comparable: true, metrics: { vvDeltaDb: -2 } }, artifacts: [], sources: [{ source: "sentinel-1", date: "2026-08-04", quality: "usable", note: "test" }] } as any);
    await store.save({ ...resultBase("weather_event"), kind: "weather_event", status: "succeeded", result: { historical: { max24hRainfallMm: 62, rainEvents: [{ start: "2026-07-13T00:00:00Z", end: "2026-07-13T23:00:00Z", rainfallMm: 62 }] }, forecast: null }, artifacts: [], sources: [{ source: "era5-land", date: "2026-07-13", quality: "usable", note: "test" }] } as any);
    await store.save({ ...resultBase("soil_background"), kind: "soil_background", status: "succeeded", result: { available: true }, artifacts: [], sources: [{ source: "soilgrids-250m", date: null, quality: "usable", note: "test" }] } as any);
    const tool = service.createWaterNitrogenTools(field(), [], range()).find((item) => item.name === "assess_water_nitrogen_evidence")!;
    const result = await tool.execute({ taskId });
    expect(result).toMatchObject({ status: "partial", result: { assessment: "variation_visible", zones: [{ radarOverlap: { status: "unavailable", overlapAreaHa: null } }], sourceAlignment: expect.arrayContaining([expect.objectContaining({ kind: "weather_event", status: "unusable" }), expect.objectContaining({ kind: "radar_change", status: "unusable" })]) } });
    expect(result.findings[0]?.zoneRef).toBeNull();
    expect(result.sources).not.toContainEqual(expect.objectContaining({ source: "era5-land" }));
    expect(result.sources).not.toContainEqual(expect.objectContaining({ source: "sentinel-1" }));
  });

  it("retains aligned radar with zero overlap as counterevidence", async () => {
    const store = createMemoryAnalysisResultStore();
    const service = new MultiSourceAnalysisService(store, "python", runners());
    const alignedZone = [[123.8, 42.3], [123.81, 42.3], [123.81, 42.31], [123.8, 42.31], [123.8, 42.3]];
    await store.save({ ...resultBase("optical_condition"), kind: "optical_condition", status: "succeeded", result: {
      current: { observationDate: "2026-06-20", metrics: { ndvi: { mean: 0.7 } } }, changes: [],
      zones: [{ id: "zone-1", class: "below_average", areaHa: 2, zone: alignedZone, metricDeviations: { ndre: -0.08, reci: -0.1, msavi: -0.02, ndmi: -0.01, ndwi: -0.01 } }],
    }, artifacts: [], sources: [{ source: "sentinel-2", date: "2026-06-20", quality: "usable", note: "test" }] } as any);
    await store.save({ ...resultBase("radar_change"), kind: "radar_change", status: "succeeded", result: {
      beforeDate: "2026-06-10", afterDate: "2026-06-20", comparable: true, metrics: { vvDeltaDb: -2 }, zones: [{ id: "radar-1", class: "strong_decrease", meanVvDeltaDb: -2, meanVhDeltaDb: -1, meanAfterVvDb: -11, validPixelCount: 10, row: 0, column: 0, zone: alignedZone.map(([x, y]) => [x! + 1, y!]) }],
    }, artifacts: [], sources: [{ source: "sentinel-1", date: "2026-06-10", quality: "usable", note: "before" }, { source: "sentinel-1", date: "2026-06-20", quality: "usable", note: "after" }] } as any);
    const result = await service.createWaterNitrogenTools(field(), [], range()).find((tool) => tool.name === "assess_water_nitrogen_evidence")!.execute({ taskId });
    expect(result).toMatchObject({ status: "succeeded", result: { evidenceLevel: "multi_source", zones: [{ radarOverlap: { status: "computed", overlapAreaHa: 0, overlapFraction: 0, contributingZoneIds: [] } }] } });
    expect(result.sources).toContainEqual(expect.objectContaining({ source: "sentinel-1" }));
    expect(result.result).not.toHaveProperty("interpretation");
  });

  it("does not use a stale optical observation as the current water-nitrogen state", async () => {
    const store = createMemoryAnalysisResultStore();
    const service = new MultiSourceAnalysisService(store, "python", runners());
    await store.save({ ...resultBase("optical_condition"), kind: "optical_condition", status: "partial", result: { current: { observationDate: "2026-06-01", metrics: { ndre: { mean: 0.2 } } }, changes: [], zones: [{ id: "zone-1", class: "below_average", areaHa: 2, zone: [[123.8, 42.3], [123.81, 42.3], [123.81, 42.31], [123.8, 42.31], [123.8, 42.3]] }] }, artifacts: [], sources: [{ source: "sentinel-2", date: "2026-06-01", quality: "usable", note: "test" }] } as any);
    const tool = service.createWaterNitrogenTools(field(), [], range()).find((item) => item.name === "assess_water_nitrogen_evidence")!;
    const result = await tool.execute({ taskId });
    expect(result).toMatchObject({ status: "partial", result: { assessment: "variation_visible", observationStatus: "stale", observationAgeDays: 29 }, error: null, nextActions: [] });
    expect(result.summary).toContain("历史观测日期 2026-06-01");
    expect(result.limitations.join(" ")).toContain("距任务结束日期 29 天");
    expect(result.findings[0]?.sourceDates).toEqual([{ source: "sentinel-2", date: "2026-06-01" }]);
  });

  it("keeps a partially covered optical observation visible and does not upgrade its status", async () => {
    const store = createMemoryAnalysisResultStore();
    const service = new MultiSourceAnalysisService(store, "python", runners());
    await store.save({ ...resultBase("optical_condition"), kind: "optical_condition", status: "partial", result: {
      current: { observationDate: "2026-06-20", metrics: { ndvi: { mean: 0.7 } } }, changes: [], zones: [],
    }, artifacts: [], sources: [{ source: "sentinel-2", date: "2026-06-20", quality: "partial", note: "地块内有效覆盖不足。" }] } as any);

    const result = await service.createWaterNitrogenTools(field(), [], range()).find((item) => item.name === "assess_water_nitrogen_evidence")!.execute({ taskId });

    expect(result).toMatchObject({
      status: "partial",
      toolVersion: "water-nitrogen-assessment-v3",
      result: { assessment: "uniform", referenceDate: "2026-06-20" },
      sources: [{ source: "sentinel-2", date: "2026-06-20", quality: "partial", role: "observation" }],
      error: null,
    });
    expect(result.findings[0]?.sourceDates).toEqual([{ source: "sentinel-2", date: "2026-06-20" }]);
  });

  it("describes same-date multi-index patterns without assigning a cause", async () => {
    const store = createMemoryAnalysisResultStore();
    const service = new MultiSourceAnalysisService(store, "python", runners());
    await store.save({ ...resultBase("optical_condition"), kind: "optical_condition", status: "succeeded", result: {
      current: { observationDate: "2026-06-20", metrics: { ndvi: { mean: 0.72 }, ndre: { mean: 0.34 }, reci: { mean: 2.1 }, ndmi: { mean: 0.28 }, ndwi: { mean: -0.55 } } },
      changes: [],
      zones: [{ id: "zone-optical", class: "below_average", areaHa: 2, meanNdvi: 0.58, deviation: -0.14, validPixelCount: 20, zone: [[123.8, 42.3], [123.81, 42.3], [123.81, 42.31], [123.8, 42.31], [123.8, 42.3]], metricDeviations: { ndre: -0.08, reci: -0.09, msavi: -0.03, ndmi: -0.08, ndwi: -0.05 } }],
    }, artifacts: [], sources: [{ source: "sentinel-2", date: "2026-06-20", quality: "usable", note: "test" }] } as any);
    await store.save({ ...resultBase("radar_change"), kind: "radar_change", status: "succeeded", result: { comparable: true, metrics: { vvDeltaDb: -2 }, zones: [] }, artifacts: [], sources: [{ source: "sentinel-1", date: "2026-08-04", quality: "usable", note: "not aligned" }] } as any);
    await store.save({ ...resultBase("soil_background"), kind: "soil_background", status: "succeeded", result: { available: true }, artifacts: [], sources: [{ source: "soilgrids-250m", date: null, quality: "usable", note: "context only" }] } as any);

    const result = await service.createWaterNitrogenTools(field(), [], range()).find((item) => item.name === "assess_water_nitrogen_evidence")!.execute({ taskId });

    expect(result.result).toMatchObject({ assessment: "variation_visible", zones: [{ meanNdvi: 0.58, ndviDeviation: -0.14, metricDeviations: { ndre: -0.08, ndmi: -0.08 } }] });
    expect(result.sources.map((source) => source.source)).toEqual(["sentinel-2", "soilgrids-250m"]);
    expect(result.result).not.toHaveProperty("interpretation");
  });

  it("preserves every conflicting field observation instead of choosing the first cause", async () => {
    const { service } = await waterNitrogenFixture();
    const inspections = [inspection("dry-point", "low_value", "2026-06-20", "dry"), inspection("wet-point", "low_value", "2026-06-20", "wet"), inspection("control", "reference", "2026-06-20", "normal")];
    const result = await service.createWaterNitrogenTools(field(), [], range(), inspections).find((tool) => tool.name === "assess_water_nitrogen_evidence")!.execute({ taskId });
    const data = result.result as WaterNitrogenEvidencePayload;
    expect(data.previousInspections.map((record) => record.waterCondition)).toEqual(["dry", "wet", "normal"]);
    expect(data.fieldComparison).toMatchObject({ status: "paired", lowValueRecords: [{ taskId: "notes", findingId: "dry-point" }, { taskId: "notes", findingId: "wet-point" }], pairs: [{ lowValue: { findingId: "dry-point" } }, { lowValue: { findingId: "wet-point" } }] });
    expect(data.zones[0]!.inspectionRefs).toHaveLength(3);
    expect(data).not.toHaveProperty("investigation");
  });

  it("does not pair observations six days apart even if each is near the image date", async () => {
    const { service } = await waterNitrogenFixture();
    const result = await service.createWaterNitrogenTools(field(), [], range(), [inspection("low", "low_value", "2026-06-17", "dry"), inspection("control", "reference", "2026-06-23", "normal")]).find((tool) => tool.name === "assess_water_nitrogen_evidence")!.execute({ taskId });
    expect(result.result).toMatchObject({ inspectionMatches: [{ status: "aligned", offsetDays: 3 }, { status: "aligned", offsetDays: 3 }], fieldComparison: { status: "unpaired", pairs: [] }, evidenceLevel: "optical_only" });
  });

  it("keeps missing valid-pixel area unknown instead of substituting polygon footprint or zero", async () => {
    const { service } = await waterNitrogenFixture({ missingArea: true });
    const result = await service.createWaterNitrogenTools(field(), [], range()).find((tool) => tool.name === "assess_water_nitrogen_evidence")!.execute({ taskId });
    expect(result).toMatchObject({ status: "partial", result: { attentionAreaHa: null, attentionAreaFraction: null, zones: [{ areaHa: null, areaFraction: null }] }, nextActions: [] });
    expect(result.summary).toContain("面积未计算");
  });

  it("retains a real but temporally distant radar result without treating it as spatial support", async () => {
    const { store, service } = await waterNitrogenFixture();
    await store.save({ ...resultBase("radar_change"), kind: "radar_change", status: "succeeded", result: { beforeDate: "2026-07-10", afterDate: "2026-07-20", comparable: true, zones: [] }, artifacts: [], sources: [] } as any);
    const result = await service.createWaterNitrogenTools(field(), [], range()).find((tool) => tool.name === "assess_water_nitrogen_evidence")!.execute({ taskId });
    expect(result.result).toMatchObject({ sourceAlignment: [{ kind: "radar_change", status: "outside_window", offsetDays: 30 }], zones: [{ radarOverlap: { status: "unavailable", overlapAreaHa: null } }] });
  });

  it("records invalid source geometry as an unavailable comparison with a partial result", async () => {
    const { store, service } = await waterNitrogenFixture();
    await store.save({ ...resultBase("radar_change"), kind: "radar_change", status: "succeeded", result: { beforeDate: "2026-06-10", afterDate: "2026-06-20", comparable: true, zones: [{ id: "broken", class: "strong_decrease", zone: [[123.8, 42.3]] }] }, artifacts: [], sources: [] } as any);
    const result = await service.createWaterNitrogenTools(field(), [], range()).find((tool) => tool.name === "assess_water_nitrogen_evidence")!.execute({ taskId });
    expect(result).toMatchObject({ status: "partial", result: { zones: [{ radarOverlap: { status: "invalid_geometry", overlapAreaHa: null } }] } });
    expect(result.limitations.join(" ")).toContain("空间交集未计算成功");
  });

  it("does not count stable radar polygons as radar change overlap", async () => {
    const { store, service } = await waterNitrogenFixture();
    const optical = (await store.list(taskId))[0]!.result as { zones: Array<{ zone: number[][] }> };
    await store.save({ ...resultBase("radar_change"), kind: "radar_change", status: "succeeded", result: { beforeDate: "2026-06-10", afterDate: "2026-06-20", comparable: true, zones: [{ id: "stable", class: "stable", zone: optical.zones[0]!.zone }] }, artifacts: [], sources: [] } as any);
    const result = await service.createWaterNitrogenTools(field(), [], range()).find((tool) => tool.name === "assess_water_nitrogen_evidence")!.execute({ taskId });
    expect(result.result).toMatchObject({ evidenceLevel: "multi_source", zones: [{ radarOverlap: { status: "computed", overlapAreaHa: 0, contributingZoneIds: [] } }] });
  });

  it("returns forecast frost risk with terrain attention zones", async () => {
    const store = createMemoryAnalysisResultStore();
    const service = new MultiSourceAnalysisService(store, "python", runners());
    await store.save({ ...resultBase("weather_event"), kind: "weather_event", status: "succeeded", result: { historical: null, forecast: { runAt: "2026-08-18T00:00:00Z", start: "2026-08-19T00:00:00Z", end: "2026-08-20T00:00:00Z", minTemperatureC: -1, cumulativeRainfallMm: 0, coldWindows: [{ start: "2026-08-19T00:00:00Z", end: "2026-08-20T00:00:00Z", minTemperatureC: -1 }], gridDistanceKm: 8, coverage: { validPointCount: 16, fraction: 1 } } }, artifacts: [], sources: [{ source: "ecmwf-ifs", date: "2026-08-18", quality: "usable", note: "test" }, { source: "era5-land", date: "2026-06-30", quality: "usable", note: "未参与霜冻预报" }] } as any);
    await store.save({ ...resultBase("terrain_susceptibility"), kind: "terrain_susceptibility", status: "succeeded", result: { zones: [{ id: "low-1", class: "low", relativeElevationM: -1, zone: [[1, 1]] }] }, artifacts: [{ ref: "terrain.geojson", kind: "map" }], sources: [{ source: "copernicus-dem", date: null, quality: "usable", note: "test" }] } as any);
    await store.save({ ...resultBase("crop_stage"), kind: "crop_stage", status: "succeeded", result: { stage: "emergence", label: "出苗期", referenceDate: "2026-08-18", daysAfterPlanting: 10, confidence: "medium" }, artifacts: [], sources: [{ source: "field_record", date: "2026-08-08", quality: "usable", note: "test" }] } as any);
    const tool = service.createFrostRiskTools(field(), [], augustFrostRange()).find((item) => item.name === "assess_frost_risk")!;
    const result = await tool.execute({ taskId });
    expect(result).toMatchObject({ status: "succeeded", toolVersion: "frost-assessment-v2", result: { risk: "high", forecastRunAt: "2026-08-18T00:00:00Z", forecastCoverageFraction: 1, forecastGridDistanceKm: 8, terrainStatus: "available", forecastMinTemperatureC: -1, stageSensitivity: "high", zones: [{ id: "low-1", risk: "high" }] }, nextActions: [{ code: "inspect_frost_risk" }] });
    expect(result.sources.map((source) => source.source)).toEqual(["ecmwf-ifs", "copernicus-dem", "field_record"]);
  });

  it("rejects a forecast window outside the frost task period", async () => {
    const store = createMemoryAnalysisResultStore();
    const service = new MultiSourceAnalysisService(store, "python", runners());
    await store.save({ ...resultBase("weather_event"), kind: "weather_event", status: "partial", result: { historical: null, forecast: { runAt: "2026-08-01T00:00:00Z", start: "2026-08-02T00:00:00Z", end: "2026-08-03T00:00:00Z", minTemperatureC: -4, cumulativeRainfallMm: 0, coldWindows: [], gridDistanceKm: 8, coverage: { validPointCount: 16, fraction: 1 } } }, artifacts: [], sources: [{ source: "ecmwf-ifs", date: "2026-08-01", quality: "usable", note: "stale batch" }] } as any);
    await store.save({ ...resultBase("crop_stage"), kind: "crop_stage", status: "succeeded", result: { stage: "emergence", label: "出苗期", referenceDate: "2026-08-19", daysAfterPlanting: 10, confidence: "medium" }, artifacts: [], sources: [{ source: "field_record", date: "2026-08-09", quality: "usable", note: "test" }] } as any);
    const frostRange = { start: "2026-08-19T00:00:00Z", end: "2026-08-20T23:59:59Z" };

    const result = await service.createFrostRiskTools(field(), [], frostRange).find((item) => item.name === "assess_frost_risk")!.execute({ taskId });

    expect(result).toMatchObject({ status: "needs_data", result: null, error: { code: "frost_forecast_invalid", retryable: true } });
    expect(result.summary).toContain("缺少有效的未来低温预报");
  });

  it("keeps frost risk partial when terrain coverage is partial", async () => {
    const store = createMemoryAnalysisResultStore();
    const service = new MultiSourceAnalysisService(store, "python", runners());
    await store.save({ ...resultBase("weather_event"), kind: "weather_event", status: "partial", result: { historical: null, forecast: { runAt: "2026-08-18T00:00:00Z", start: "2026-08-19T00:00:00Z", end: "2026-08-20T00:00:00Z", minTemperatureC: -1, cumulativeRainfallMm: 0, coldWindows: [{ start: "2026-08-19T00:00:00Z", end: "2026-08-20T00:00:00Z", minTemperatureC: -1 }], gridDistanceKm: 8, coverage: { validPointCount: 16, fraction: 1 } } }, artifacts: [], sources: [{ source: "ecmwf-ifs", date: "2026-08-18", quality: "usable", note: "test" }] } as any);
    await store.save({ ...resultBase("terrain_susceptibility"), kind: "terrain_susceptibility", status: "partial", result: { zones: [{ id: "low-1", class: "low", relativeElevationM: -1, zone: [[1, 1]] }] }, artifacts: [], sources: [{ source: "copernicus-dem", date: null, quality: "partial", note: "limited coverage" }] } as any);
    await store.save({ ...resultBase("crop_stage"), kind: "crop_stage", status: "succeeded", result: { stage: "emergence", label: "出苗期", referenceDate: "2026-08-18", daysAfterPlanting: 10, confidence: "medium" }, artifacts: [], sources: [{ source: "field_record", date: "2026-08-08", quality: "usable", note: "test" }] } as any);

    const result = await service.createFrostRiskTools(field(), [], augustFrostRange()).find((item) => item.name === "assess_frost_risk")!.execute({ taskId });

    expect(result).toMatchObject({ status: "partial", result: { methodVersion: "stage-temperature-duration-terrain-v2", risk: "high", coldDurationHours: 24, forecastWindow: { start: "2026-08-19T00:00:00Z", end: "2026-08-20T00:00:00Z" }, zones: [{ id: "low-1" }] } });
    expect(result.limitations).toContain("DEM 有效覆盖受限，低洼关注区不完整。");
  });

  it("preserves the low-temperature process when the planting date is invalid", async () => {
    const store = createMemoryAnalysisResultStore();
    const service = new MultiSourceAnalysisService(store, "python", runners());
    await store.save({ ...resultBase("weather_event"), kind: "weather_event", status: "succeeded", result: { historical: null, forecast: { runAt: "2026-08-18T00:00:00Z", start: "2026-08-19T00:00:00Z", end: "2026-08-20T00:00:00Z", minTemperatureC: -1, cumulativeRainfallMm: 0, coldWindows: [], gridDistanceKm: 8, coverage: { validPointCount: 16, fraction: 1 } } }, artifacts: [], sources: [{ source: "ecmwf-ifs", date: "2026-08-18", quality: "usable", note: "test" }] } as any);
    await store.save({ ...resultBase("crop_stage"), kind: "crop_stage", status: "needs_input", result: null, summary: "播种日期晚于参考观测日，暂不能估计玉米生育期。", artifacts: [], sources: [{ source: "field_record", date: "2027-05-01", quality: "partial", note: "future" }], limitations: ["参考观测日必须位于播种日期之后。"], nextActions: [{ code: "fix_planting_date", label: "核对地块播种日期或选择正确种植季" }], error: { code: "planting_date_after_reference", message: "播种日期晚于参考观测日。", retryable: false } } as any);

    const result = await service.createFrostRiskTools(field(), [], augustFrostRange()).find((item) => item.name === "assess_frost_risk")!.execute({ taskId });

    expect(result).toMatchObject({
      status: "partial",
      result: { risk: "undetermined", cropStage: null, stageSensitivity: "unknown", forecastMinTemperatureC: -1 },
      summary: expect.stringContaining("暂不发布霜冻风险等级"),
      nextActions: [{ code: "fix_planting_date", label: "核对地块播种日期或选择正确种植季" }],
      error: null,
    });
  });

  it("combines temperature with crop-stage sensitivity instead of treating every cold window equally", async () => {
    const store = createMemoryAnalysisResultStore();
    const service = new MultiSourceAnalysisService(store, "python", runners());
    await store.save({ ...resultBase("weather_event"), kind: "weather_event", status: "succeeded", result: { historical: null, forecast: { runAt: "2026-05-01T00:00:00Z", start: "2026-05-02T00:00:00Z", end: "2026-05-03T00:00:00Z", minTemperatureC: 1, cumulativeRainfallMm: 0, coldWindows: [{ start: "2026-05-02T00:00:00Z", end: "2026-05-03T00:00:00Z", minTemperatureC: 1 }], gridDistanceKm: 8, coverage: { validPointCount: 16, fraction: 1 } } }, artifacts: [], sources: [{ source: "ecmwf-ifs", date: "2026-05-01", quality: "usable", note: "test" }] } as any);
    await store.save({ ...resultBase("terrain_susceptibility"), kind: "terrain_susceptibility", status: "succeeded", result: { zones: [{ id: "low-1", class: "low", relativeElevationM: -1, zone: [[1, 1]] }] }, artifacts: [{ ref: "terrain.geojson", kind: "map" }], sources: [{ source: "copernicus-dem", date: null, quality: "usable", note: "test" }] } as any);
    await store.save({ ...resultBase("crop_stage"), kind: "crop_stage", status: "succeeded", result: { stage: "sowing", label: "播种期", referenceDate: "2026-05-01", daysAfterPlanting: 0, confidence: "medium" }, artifacts: [], sources: [{ source: "field_record", date: "2026-05-01", quality: "usable", note: "test" }] } as any);
    const tool = service.createFrostRiskTools(field(), [], range()).find((item) => item.name === "assess_frost_risk")!;
    const result = await tool.execute({ taskId });
    expect(result).toMatchObject({ status: "succeeded", result: { risk: "normal", stageSensitivity: "low", zones: [] } });
  });

  it("keeps a short marginal cold pulse at watch instead of high risk", async () => {
    const store = createMemoryAnalysisResultStore();
    const service = new MultiSourceAnalysisService(store, "python", runners());
    await store.save({ ...resultBase("weather_event"), kind: "weather_event", status: "succeeded", result: { historical: null, forecast: { runAt: "2026-08-18T00:00:00Z", start: "2026-08-19T00:00:00Z", end: "2026-08-20T00:00:00Z", minTemperatureC: -1, cumulativeRainfallMm: 0, coldWindows: [{ start: "2026-08-19T03:00:00Z", end: "2026-08-19T03:00:00Z", minTemperatureC: -1 }], gridDistanceKm: 8, coverage: { validPointCount: 16, fraction: 1 } } }, artifacts: [], sources: [{ source: "ecmwf-ifs", date: "2026-08-18", quality: "usable", note: "test" }] } as any);
    await store.save({ ...resultBase("terrain_susceptibility"), kind: "terrain_susceptibility", status: "succeeded", result: { zones: [] }, artifacts: [], sources: [{ source: "copernicus-dem", date: null, quality: "usable", note: "test" }] } as any);
    await store.save({ ...resultBase("crop_stage"), kind: "crop_stage", status: "succeeded", result: { stage: "emergence", label: "出苗期", referenceDate: "2026-08-19", daysAfterPlanting: 10, confidence: "medium" }, artifacts: [], sources: [{ source: "field_record", date: "2026-08-09", quality: "usable", note: "test" }] } as any);

    const result = await service.createFrostRiskTools(field(), [], augustFrostRange()).find((item) => item.name === "assess_frost_risk")!.execute({ taskId });

    expect(result).toMatchObject({ status: "succeeded", result: { risk: "watch", coldDurationHours: 0, stageSensitivity: "high" } });
  });
});

async function waterNitrogenFixture(options: { missingArea?: boolean } = {}) {
  const store = createMemoryAnalysisResultStore();
  const service = new MultiSourceAnalysisService(store, "python", runners());
  await store.save({ ...resultBase("optical_condition"), kind: "optical_condition", status: "succeeded", result: {
    current: { observationDate: "2026-06-20", metrics: { ndvi: { mean: 0.7 } }, quality: { validFraction: 0.9 } },
    observations: [{ observationDate: "2026-06-20" }], changes: [],
    zones: [{ id: "low", class: "below_average", ...(options.missingArea ? {} : { areaHa: 2 }), meanNdvi: 0.6, deviation: -0.1, zone: [[123.8, 42.3], [123.81, 42.3], [123.81, 42.31], [123.8, 42.31], [123.8, 42.3]] }],
  }, sources: [{ source: "sentinel-2", date: "2026-06-20", quality: "usable", note: "synthetic test observation" }], artifacts: [] } as any);
  return { store, service };
}

function inspection(findingId: string, scoutingRole: WaterNitrogenInspectionContext["scoutingRole"], observedAt: string, waterCondition: WaterNitrogenInspectionContext["waterCondition"]): WaterNitrogenInspectionContext {
  return { taskId: "notes", findingId, findingTitle: findingId, scoutingRole, observedAt, observationDates: [], checkedAt: `${observedAt}T08:00:00Z`, location: { longitude: 123.805, latitude: 42.305 }, waterCondition, leafColor: "pale", diseaseOrPest: "none_seen", note: "synthetic test record" };
}

function resultBase(kind: string) {
  const toolName = kind === "optical_condition" ? "analyze_optical_condition"
    : kind === "radar_change" ? "analyze_radar_change"
      : kind === "weather_event" ? "analyze_weather_event"
        : kind === "terrain_susceptibility" ? "analyze_terrain_susceptibility"
          : kind === "soil_background" ? "get_soil_background"
            : kind === "crop_stage" ? "estimate_crop_stage" : "assess_growth_status";
  return { id: `${kind}-test`, taskId, toolVersion: "test", createdAt: "2026-08-18T00:00:00Z",
    execution: { toolName, scope: { fieldId: "field-1", boundaryVersion: 1, timeRange: null }, inputs: { acquisitionIds: [], assetIds: [], resultIds: [] }, parameters: {}, inputFingerprint: `test-${kind}` },
    summary: "test", limitations: [], nextActions: [], findings: [], error: null };
}

function runners(): MultiSourceRunners {
  const zone = [[123.8, 42.3], [123.805, 42.3], [123.805, 42.305], [123.8, 42.305], [123.8, 42.3]];
  return {
    async radar() {
      return {
        status: "succeeded", quality: { totalPixelCount: 100, validPixelCount: 100, validFraction: 1 },
        metrics: { beforeVvDb: -8, afterVvDb: -11, vvDeltaDb: -3, beforeVhDb: -14, afterVhDb: -15, vhDeltaDb: -1, changedPixelFraction: 0.4 },
        zones: [{ id: "zone-1-1", row: 0, column: 0, class: "strong_decrease", meanVvDeltaDb: -3, meanVhDeltaDb: -1, meanAfterVvDb: -11, validPixelCount: 40, zone }],
        error: { code: null, message: null },
      };
    },
    async weather() {
      return { status: "succeeded", historical: { start: "2026-06-01T00:00:00Z", end: "2026-06-30T23:00:00Z", totalRainfallMm: 80, max24hRainfallMm: 56, minTemperatureC: 15, rainEvents: [{ start: "2026-06-15T00:00:00Z", end: "2026-06-15T23:00:00Z", rainfallMm: 56 }], hourCount: 720, coverage: { expectedHourCount: 720, observedHourCount: 720, fraction: 1 }, daily: [{ date: "2026-06-15", rainfallMm: 56, minTemperatureC: 15, maxTemperatureC: 25 }] }, forecast: null, error: { code: null, message: null } };
    },
    async terrain() {
      return { status: "succeeded", metrics: { minElevationM: 55, meanElevationM: 56, maxElevationM: 57, meanSlopeDegrees: 0.4, lowElevationThresholdM: 55.5, minimumLowlandRelativeDepthM: 0.5, validPixelCount: 25, totalPixelCount: 25, validFraction: 1 }, zones: [{ id: "zone-1-1", row: 0, column: 0, class: "low", meanElevationM: 55, relativeElevationM: -1, meanSlopeDegrees: 0.2, validPixelCount: 10, zone }], error: { code: null, message: null } };
    },
  };
}

function field(): FieldSummary {
  return { id: "field-1", organizationId: "org-1", code: "F-1", name: "测试田", areaHa: 10, village: "铁岭", crop: "corn", seasonYear: 2026, plantingDate: "2026-05-05", variety: null, boundaryVersion: 1, seasonCount: 1, centroid: { longitude: 123.805, latitude: 42.305 }, boundary: [{ longitude: 123.8, latitude: 42.3 }, { longitude: 123.81, latitude: 42.3 }, { longitude: 123.81, latitude: 42.31 }, { longitude: 123.8, latitude: 42.31 }, { longitude: 123.8, latitude: 42.3 }], latestStatus: "not_analyzed", latestAnalyzedAt: null };
}

function range() { return { start: "2026-05-01T00:00:00Z", end: "2026-06-30T23:59:59Z" }; }
function augustFrostRange() { return { start: "2026-08-19T00:00:00Z", end: "2026-08-20T23:59:59Z" }; }

function acquisition(beforeDate: string, afterDate: string): DataAcquisitionRun {
  const now = "2026-06-30T00:00:00Z";
  const asset = (id: string, role: "radar" | "weather-series" | "dem", capturedAt: string | null, validFrom: string | null, validTo: string | null, format: string) => ({ id, providerAssetId: id, role, capturedAt, validFrom, validTo, generatedAt: null, retrievedAt: now, spatialResolutionMeters: 10, crs: "EPSG:4326", format, byteSize: 10, checksum: "sha256:test", artifactRef: `test/${id}`, accessStatus: "retrieved" as const });
  const source = (name: "sentinel-1" | "era5-land" | "copernicus-dem", type: "radar" | "weather-historical" | "terrain", assets: ReturnType<typeof asset>[], metadata: Record<string, string | number | boolean | null> = {}) => ({ sourceType: type, source: name, provider: "test", product: "test", status: "succeeded" as const, requestedPeriod: null, discoveredAt: now, retrievedAt: now, availableDates: [], selectedObservationDates: assets.flatMap((item) => item.capturedAt ? [item.capturedAt.slice(0, 10)] : []), selectedAssets: assets, coverage: { requestedAreaHa: 10, coveredAreaFraction: 1 }, quality: { flags: [], metadata }, license: { access: "public" as const, downloadAllowed: true, attribution: "test" }, limitations: [], error: { code: null, retryable: false, message: null } });
  return { id: "run-1", fieldId: "field-1", boundaryVersion: 1, period: range(), dataProfile: "waterlogging_v1", dataProfileVersion: "test", status: "completed", createdAt: now, completedAt: now, manifestVersion: "test", progress: [], sources: [
    source("sentinel-1", "radar", [asset(`radar-${beforeDate}`, "radar", `${beforeDate}T02:00:00Z`, null, null, "GeoTIFF"), asset(`radar-${afterDate}`, "radar", `${afterDate}T02:00:00Z`, null, null, "GeoTIFF")], { orbitDirection: "DESCENDING", relativeOrbitNumber: 105 }),
    source("era5-land", "weather-historical", [asset("weather.nc", "weather-series", null, range().start, range().end, "NetCDF")]),
    source("copernicus-dem", "terrain", [asset("dem.tif", "dem", null, null, null, "GeoTIFF")]),
  ] };
}

function waterNitrogenAcquisition(): DataAcquisitionRun {
  const now = "2026-06-30T00:00:00Z";
  const asset = (id: string, role: "spectral" | "quality-mask" | "radar" | "weather-series", capturedAt: string | null, validFrom: string | null = null, validTo: string | null = null) => ({ id, providerAssetId: id, role, capturedAt, validFrom, validTo, generatedAt: null, retrievedAt: now, spatialResolutionMeters: 10, crs: "EPSG:4326", format: "GeoTIFF", byteSize: 10, checksum: "sha256:test", artifactRef: `test/${id}`, accessStatus: "retrieved" as const });
  const opticalAssets = [
    asset("scene-2026-06-20:B02+B03+B04+B08", "spectral", "2026-06-20T02:00:00Z"),
    asset("scene-2026-06-20:B05+B06+B07+B8A+B11+B12", "spectral", "2026-06-20T02:00:00Z"),
    asset("scene-2026-06-20:SCL", "quality-mask", "2026-06-20T02:00:00Z"),
  ];
  const radarAssets = [asset("radar-before", "radar", "2026-06-10T02:00:00Z"), asset("radar-after", "radar", "2026-06-20T02:00:00Z")];
  const weatherAsset = asset("weather-june", "weather-series", null, "2026-06-01T00:00:00Z", "2026-06-30T23:00:00Z");
  const source = (source: "sentinel-2" | "sentinel-1" | "era5-land", sourceType: "optical" | "radar" | "weather-historical", selectedAssets: ReturnType<typeof asset>[], metadata: Record<string, string | number> = {}) => ({ sourceType, source, provider: "test", product: "test", status: "succeeded" as const, requestedPeriod: null, discoveredAt: now, retrievedAt: now, availableDates: [], selectedObservationDates: selectedAssets.flatMap((item) => item.capturedAt ? [item.capturedAt.slice(0, 10)] : []), selectedAssets, coverage: { requestedAreaHa: 10, coveredAreaFraction: 1 }, quality: { flags: [], metadata }, license: { access: "public" as const, downloadAllowed: true, attribution: "test" }, limitations: [], error: { code: null, retryable: false, message: null } });
  return { id: "water-nitrogen-run", fieldId: "field-1", boundaryVersion: 1, period: range(), dataProfile: "water_nitrogen_v1", dataProfileVersion: "test", status: "completed", createdAt: now, completedAt: now, manifestVersion: "test", progress: [], sources: [
    source("sentinel-2", "optical", opticalAssets),
    source("sentinel-1", "radar", radarAssets, { orbitDirection: "DESCENDING", relativeOrbitNumber: 105 }),
    source("era5-land", "weather-historical", [weatherAsset]),
  ] };
}

function soilSource(): DataAcquisitionRun["sources"][number] {
  const now = "2026-06-30T00:00:00Z";
  return {
    sourceType: "soil", source: "soilgrids-250m", provider: "test", product: "test", status: "succeeded", requestedPeriod: null,
    discoveredAt: now, retrievedAt: now, availableDates: [], selectedObservationDates: [],
    selectedAssets: [{ id: "soil-nitrogen", providerAssetId: "nitrogen_5-15cm_Q0.5", role: "soil", capturedAt: null, validFrom: null, validTo: null, generatedAt: null, retrievedAt: now, spatialResolutionMeters: 250, crs: "EPSG:4326", format: "GeoTIFF", byteSize: 10, checksum: "sha256:soil", artifactRef: "test/soil-nitrogen.tif", accessStatus: "retrieved" }],
    coverage: { requestedAreaHa: 10, coveredAreaFraction: 1 }, quality: { flags: [], metadata: {} }, license: { access: "public", downloadAllowed: true, attribution: "test" }, limitations: [], error: { code: null, retryable: false, message: null },
  };
}
