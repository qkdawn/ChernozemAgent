import type { AnalysisTask, DataAcquisitionRun, FieldSummary } from "@chernozem/contracts";
import { CornSkillRunner } from "@chernozem/agent-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { createMemoryAnalysisResultStore } from "./analysis-store.js";
import { createMemoryAcquisitionStore } from "./acquisition-store.js";
import { GrowthAnalysisService, type OpticalPythonResult } from "./analysis-tools.js";
import type { FieldStore } from "./field-store.js";
import { reanalyzeGrowthOptical } from "./reanalyze-growth-optical.js";
import { createMemoryAnalysisTaskStore } from "./task-store.js";

const taskId = "11111111-1111-4111-8111-111111111111";

afterEach(async () => {
  await rm(resolve(import.meta.dirname, "../../../runtime/artifacts", taskId), { recursive: true, force: true });
});

describe("growth analysis tools", () => {
  it("persists NDVI preview references and finite std on optical and assessment results", async () => {
    const store = createMemoryAnalysisResultStore();
    const service = new GrowthAnalysisService(store, "python", async (input) => {
      const { outputDir, sourceDate } = input as { outputDir: string; sourceDate: string };
      await mkdir(outputDir, { recursive: true });
      await writeFile(resolve(outputDir, `${sourceDate}-ndvi.png`), Buffer.from("synthetic-test-image"));
      const payload = opticalPayload("succeeded", 0.7);
      payload.metrics!.ndvi.std = 0.125;
      payload.visualizations = [{ fileName: `${sourceDate}-ndvi.png`, metric: "ndvi", label: "NDVI", bounds: [[123.8, 42.31], [123.81, 42.31], [123.81, 42.3], [123.8, 42.3]], min: 0, max: 1, resolutionMeters: 20 }];
      return payload;
    });
    const results = await new CornSkillRunner(service.createTools(field(), [acquisition()])).run("growth_stage_monitoring", taskId);
    const stored = await store.list(taskId);
    for (const result of [results[0], results[2], stored.find((item) => item.kind === "optical_condition"), stored.find((item) => item.kind === "assessment")]) {
      expect(result?.artifacts).toEqual(expect.arrayContaining([expect.objectContaining({
        ref: expect.stringMatching(new RegExp(`^analysis/${taskId}/.+/2026-06-26-ndvi\\.png$`)),
        kind: "map", visualization: expect.objectContaining({ metric: "ndvi" }),
      })]));
    }
    expect((stored.find((item) => item.kind === "optical_condition")?.result as { current: { metrics: { ndvi: { std: number } } } }).current.metrics.ndvi.std).toBe(0.125);
  });

  it("omits an unavailable std and rejects missing preview files", async () => {
    const store = createMemoryAnalysisResultStore();
    const withoutStd = new GrowthAnalysisService(store, "python", async () => opticalPayload("succeeded", 0.7));
    const result = await withoutStd.createTools(field(), [acquisition()])[0]!.execute({ taskId });
    expect((result.result as { current: { metrics: { ndvi: { std?: number } } } }).current.metrics.ndvi).not.toHaveProperty("std");

    const missingImage = new GrowthAnalysisService(store, "python", async () => ({
      ...opticalPayload("succeeded", 0.7),
      visualizations: [{ fileName: "missing-ndvi.png", metric: "ndvi", label: "NDVI", bounds: [[123.8, 42.31], [123.81, 42.31], [123.81, 42.3], [123.8, 42.3]], min: 0, max: 1, resolutionMeters: 20 }],
    }));
    const failed = await missingImage.createTools(field(), [acquisition()])[0]!.execute({ taskId });
    expect(failed).toMatchObject({ status: "failed", result: null, error: { code: "optical_processing_failed" } });
  });

  it("backfills an existing growth task from its acquisition IDs without changing writer actions", async () => {
    const resultsStore = createMemoryAnalysisResultStore();
    const acquisitionStore = createMemoryAcquisitionStore();
    const taskStore = createMemoryAnalysisTaskStore();
    const original = await new CornSkillRunner(new GrowthAnalysisService(resultsStore, "python", async () => opticalPayload("succeeded", 0.7))
      .createTools(field(), [acquisition()])).run("growth_stage_monitoring", taskId);
    await acquisitionStore.save(acquisition());
    const task: AnalysisTask = {
      id: taskId, fieldId: field().id, boundaryVersion: 1, objective: "growth_stage_monitoring",
      timeRange: { start: "2026-06-01T00:00:00.000Z", end: "2026-06-30T23:59:59.000Z" },
      status: "completed", progress: 100, stage: "完成", createdAt: "2026-06-30T00:00:00.000Z", completedAt: "2026-06-30T01:00:00.000Z",
      demoData: false, summary: "原始分析", brief: null, findings: [], sources: [], analysisResults: original,
      limitations: [], nextActions: [{ code: "inspect", label: "现场核查" }], failure: null,
    };
    await taskStore.save(task);
    const stores = { tasks: taskStore, results: resultsStore, acquisitions: acquisitionStore,
      fields: { async get() { return field(); } } as unknown as FieldStore };
    const rerun = await reanalyzeGrowthOptical(taskId, stores, async (input) => {
      const { outputDir, sourceDate } = input as { outputDir: string; sourceDate: string };
      await writeFile(resolve(outputDir, `${sourceDate}-ndvi.png`), Buffer.from("synthetic-test-image"));
      const payload = opticalPayload("succeeded", 0.7);
      payload.metrics!.ndvi.std = 0.125;
      payload.visualizations = [{ fileName: `${sourceDate}-ndvi.png`, metric: "ndvi", label: "NDVI", bounds: [[123.8, 42.31], [123.81, 42.31], [123.81, 42.3], [123.8, 42.3]], min: 0, max: 1, resolutionMeters: 20 }];
      return payload;
    });
    expect(rerun).toMatchObject({ resultId: original[0]?.id, std: 0.125 });
    const updated = (await taskStore.get(taskId))!;
    expect(updated.nextActions).toEqual(task.nextActions);
    expect(updated.summary).toBe(task.summary);
    expect(updated.analysisResults.find((item) => item.kind === "assessment")?.artifacts.some((artifact) => artifact.visualization?.metric === "ndvi")).toBe(true);
    expect((updated.analysisResults.find((item) => item.kind === "optical_condition")?.result as { current: { metrics: { ndvi: { std: number } } } }).current.metrics.ndvi.std).toBe(0.125);
  });
  it("separates comparison dates outside the request and names the area denominator", async () => {
    const store = createMemoryAnalysisResultStore();
    const service = new GrowthAnalysisService(store, "python", async () => opticalPayload("succeeded", 0.7));
    const requestedPeriod = { start: "2026-06-20T12:00:00Z", end: "2026-06-30T12:00:00Z" };
    const observationRange = { start: "2026-06-10T00:00:00Z", end: requestedPeriod.end };
    const results = await new CornSkillRunner(service.createTools(field(), [acquisition("2026-06-16"), acquisition("2026-06-26")], observationRange, requestedPeriod))
      .run("growth_stage_monitoring", taskId);
    expect(results.at(-1)?.result).toMatchObject({
      observationCount: 2,
      observationWindow: { requestedPeriod, datesWithinPeriod: ["2026-06-26"], comparisonDatesOutsidePeriod: ["2026-06-16"] },
      areaBasis: { fieldAreaHa: field().areaHa, belowAverageAreaFractionDenominator: "field_area" },
    });
  });

  it("composes optical condition, crop stage, and growth assessment results", async () => {
    const store = createMemoryAnalysisResultStore();
    let observation = 0;
    const runner = async (): Promise<OpticalPythonResult> => ({
      status: "succeeded",
      sourceDate: "2026-06-26",
      quality: { flags: [], totalPixelCount: 90, validPixelCount: 90, validFraction: 1, cloudAffectedFraction: 0 },
      zoningMethod: "ndvi-quantile-connected-v2",
      zoningQuality: { robustRange: 0.28, minimumRobustRange: 0.05, variationVisible: true },
      metrics: {
        ndvi: { mean: observation++ === 0 ? 0.62 : 0.72, min: 0.4, max: 0.88, validPixelCount: 90, totalPixelCount: 90, coverageFraction: 1 },
        ndre: { mean: 0.41, min: 0.2, max: 0.6, validPixelCount: 90, totalPixelCount: 90, coverageFraction: 1 },
        reci: { mean: 2.1, min: 0.6, max: 3.2, validPixelCount: 90, totalPixelCount: 90, coverageFraction: 1 },
        msavi: { mean: 0.68, min: 0.35, max: 0.82, validPixelCount: 90, totalPixelCount: 90, coverageFraction: 1 },
        ndmi: { mean: 0.31, min: -0.1, max: 0.55, validPixelCount: 90, totalPixelCount: 90, coverageFraction: 1 },
        ndwi: { mean: -0.58, min: -0.8, max: -0.3, validPixelCount: 90, totalPixelCount: 90, coverageFraction: 1 },
      },
      zones: [
        { id: "zone-1", row: 0, column: 0, meanNdvi: 0.52, deviation: -0.2, class: "below_average", validPixelCount: 30, zone: [[123.8, 42.3], [123.81, 42.3], [123.81, 42.305], [123.8, 42.305], [123.8, 42.3]] },
        { id: "zone-2", row: 0, column: 1, meanNdvi: 0.76, deviation: 0.04, class: "near_average", validPixelCount: 30, zone: [[123.8, 42.305], [123.81, 42.305], [123.81, 42.31], [123.8, 42.31], [123.8, 42.305]] },
      ],
      error: { code: null, message: null, retryable: false },
    });
    const service = new GrowthAnalysisService(store, "python", runner);
    const tools = service.createTools(field(), [acquisition("2026-06-26"), acquisition("2026-06-16")]);
    const results = await new CornSkillRunner(tools).run("growth_stage_monitoring", taskId);
    expect(results.map((result) => result.kind)).toEqual(["optical_condition", "crop_stage", "assessment"]);
    expect(results.map((result) => result.execution.toolName)).toEqual(["analyze_optical_condition", "estimate_crop_stage", "assess_growth_status"]);
    expect(results[0]!.execution).toMatchObject({
      scope: { fieldId: "field-1", boundaryVersion: 1 },
      inputs: { acquisitionIds: ["acquisition-2026-06-16", "acquisition-2026-06-26"], resultIds: [] },
      parameters: { minimumComparableDates: 2, zoningMethod: "ndvi-quantile-connected-v2", minimumNdviRobustRange: 0.05 },
    });
    expect(results[1]!.execution.inputs.resultIds).toEqual([results[0]!.id]);
    expect(results[2]!.execution.inputs.resultIds).toEqual([results[0]!.id, results[1]!.id].sort());
    expect(results[0]).toMatchObject({ status: "succeeded", result: { observations: [{ observationDate: "2026-06-16" }, { observationDate: "2026-06-26" }], changes: [{ fromDate: "2026-06-16", toDate: "2026-06-26", ndviDelta: 0.1 }] } });
    expect(results.at(-1)).toMatchObject({
      status: "succeeded",
      result: {
        status: "watch",
        trend: "increasing",
        stage: { stage: "jointing" },
        observationCount: 2,
        validCoverageFraction: 1,
        belowAverageAreaHa: 3.3333,
        belowAverageAreaFraction: 0.3333,
      },
    });
    expect((await store.list(taskId))).toHaveLength(3);
    expect(results[0]!.artifacts[0]!.kind).toBe("map");
    expect(results[0]!.artifacts.filter((artifact) => artifact.chart)).toHaveLength(6);
    expect(results[0]!.artifacts.find((artifact) => artifact.chart?.title === "NDVI 时序")?.chart?.series[0]?.points).toEqual([
      { label: "2026-06-16", value: 0.62 },
      { label: "2026-06-26", value: 0.72 },
    ]);
    const replay = await new CornSkillRunner(tools).run("growth_stage_monitoring", taskId);
    expect(replay.map((result) => result.id)).toEqual(results.map((result) => result.id));
    expect(replay.map((result) => result.execution.inputFingerprint)).toEqual(results.map((result) => result.execution.inputFingerprint));
    expect(await store.list(taskId)).toHaveLength(3);
  });

  it("changes replay fingerprints when an acquisition manifest or asset changes", async () => {
    const store = createMemoryAnalysisResultStore();
    const service = new GrowthAnalysisService(store, "python", async () => opticalPayload("succeeded", 0.7));
    const firstRun = acquisition("2026-06-26");
    const first = await new CornSkillRunner(service.createTools(field(), [firstRun])).run("growth_stage_monitoring", taskId);
    const changedRun = structuredClone(firstRun);
    changedRun.manifestVersion = "1.3";
    changedRun.sources[0]!.selectedAssets[0]!.checksum = "sha256:changed";

    const changed = await new CornSkillRunner(service.createTools(field(), [changedRun])).run("growth_stage_monitoring", taskId);

    expect(changed.map((result) => result.id)).toEqual(first.map((result) => result.id));
    expect(changed[0]!.execution.inputFingerprint).not.toBe(first[0]!.execution.inputFingerprint);
    expect(changed[1]!.execution.inputFingerprint).not.toBe(first[1]!.execution.inputFingerprint);
    expect(changed[2]!.execution.inputFingerprint).not.toBe(first[2]!.execution.inputFingerprint);
    expect(await store.list(taskId)).toHaveLength(3);
  });

  it("returns explicit input and data gaps instead of inventing a growth result", async () => {
    const service = new GrowthAnalysisService(createMemoryAnalysisResultStore(), "python", async () => { throw new Error("runner should not be called"); });
    const results = await new CornSkillRunner(service.createTools({ ...field(), plantingDate: null }, [])).run("growth_stage_monitoring", taskId);
    expect(results[0]).toMatchObject({ kind: "optical_condition", status: "needs_data", error: { code: "optical_assets_missing" } });
    expect(results[1]).toMatchObject({ kind: "crop_stage", status: "needs_input", error: { code: "planting_date_missing" } });
    expect(results[2]).toMatchObject({ kind: "assessment", status: "needs_data", result: null });
  });

  it("keeps the optical growth observation when planting date is missing", async () => {
    const service = new GrowthAnalysisService(createMemoryAnalysisResultStore(), "python", async () => opticalPayload("succeeded", 0.7));
    const results = await new CornSkillRunner(service.createTools({ ...field(), plantingDate: null }, [acquisition("2026-06-26")])).run("growth_stage_monitoring", taskId);

    expect(results[1]).toMatchObject({ status: "needs_input", error: { code: "planting_date_missing" } });
    expect(results[2]).toMatchObject({
      status: "partial",
      result: { stage: null, latestObservationDate: "2026-06-26", meanNdvi: 0.7 },
      nextActions: [{ code: "add_planting_date" }],
    });
    expect(results[2]?.limitations).toContain("生育期估计需要播种日期；单幅影像不能替代生育期记录。");
  });

  it("does not turn a future planting date into an emergence-stage result", async () => {
    const service = new GrowthAnalysisService(createMemoryAnalysisResultStore(), "python", async () => opticalPayload("succeeded", 0.7));
    const results = await new CornSkillRunner(service.createTools({ ...field(), plantingDate: "2027-05-01" }, [acquisition("2026-06-26")])).run("growth_stage_monitoring", taskId);

    expect(results[1]).toMatchObject({
      kind: "crop_stage",
      status: "needs_input",
      result: null,
      error: { code: "planting_date_after_reference", retryable: false },
      nextActions: [{ code: "fix_planting_date" }],
    });
    expect(results[2]).toMatchObject({ kind: "assessment", status: "partial", result: { stage: null, latestObservationDate: "2026-06-26" } });
    expect(results[2]?.nextActions).toEqual([
      { code: "fix_planting_date", label: "核对地块播种日期或选择正确种植季" },
    ]);
  });

  it("rejects an invalid planting date instead of silently using day zero", async () => {
    const service = new GrowthAnalysisService(createMemoryAnalysisResultStore(), "python", async () => opticalPayload("succeeded", 0.7));
    const results = await new CornSkillRunner(service.createTools({ ...field(), plantingDate: "not-a-date" }, [acquisition("2026-06-26")])).run("growth_stage_monitoring", taskId);

    expect(results[1]).toMatchObject({ kind: "crop_stage", status: "needs_input", error: { code: "planting_date_invalid" } });
  });

  it("rejects a normalized but nonexistent planting date", async () => {
    const service = new GrowthAnalysisService(createMemoryAnalysisResultStore(), "python", async () => opticalPayload("succeeded", 0.7));
    const results = await new CornSkillRunner(service.createTools({ ...field(), plantingDate: "2026-02-30" }, [acquisition("2026-06-26")])).run("growth_stage_monitoring", taskId);

    expect(results[1]).toMatchObject({ status: "needs_input", error: { code: "planting_date_invalid" } });
    expect(results[2]).toMatchObject({ status: "partial", result: { stage: null, latestObservationDate: "2026-06-26" }, error: null });
  });

  it("does not estimate crop stage from the system clock when no reference date exists", async () => {
    const service = new GrowthAnalysisService(createMemoryAnalysisResultStore(), "python", async () => { throw new Error("runner should not be called"); });
    const results = await new CornSkillRunner(service.createTools(field(), [])).run("growth_stage_monitoring", taskId);

    expect(results[1]).toMatchObject({ status: "needs_data", result: null, error: { code: "stage_reference_date_missing" } });
    expect(results[2]).toMatchObject({ status: "needs_data", result: null, error: { code: "growth_assessment_inputs_missing", retryable: true } });
  });

  it("uses the coldest forecast window as the frost crop-stage reference", async () => {
    const store = createMemoryAnalysisResultStore();
    await store.save({
      id: "weather-result", taskId, kind: "weather_event", status: "succeeded", toolVersion: "weather-event-v1", createdAt: "2026-08-18T00:00:00Z",
      execution: { toolName: "analyze_weather_event", scope: { fieldId: "field-1", boundaryVersion: 1, timeRange: null }, inputs: { acquisitionIds: [], assetIds: [], resultIds: [] }, parameters: {}, inputFingerprint: "weather-test" },
      summary: "test", result: { forecast: { start: "2026-08-19T00:00:00Z", coldWindows: [{ start: "2026-08-19T03:00:00Z", minTemperatureC: 1 }, { start: "2026-08-20T03:00:00Z", minTemperatureC: -2 }] } },
      sources: [{ source: "ecmwf-ifs", date: "2026-08-18", quality: "usable", note: "forecast batch" }], findings: [], artifacts: [], limitations: [], nextActions: [], error: null,
    } as any);
    const service = new GrowthAnalysisService(store, "python", async () => { throw new Error("optical runner should not be called"); });
    const stageTool = service.createTools({ ...field(), plantingDate: "2026-05-05" }, [], { start: "2026-08-19T00:00:00Z", end: "2026-08-21T00:00:00Z" }).find((tool) => tool.name === "estimate_crop_stage")!;

    const result = await stageTool.execute({ taskId });

    expect(result).toMatchObject({ status: "succeeded", result: { referenceDate: "2026-08-20", daysAfterPlanting: 107 }, sources: [
      { source: "field_record", date: "2026-05-05" },
      { source: "ecmwf-ifs", date: "2026-08-18", role: "context" },
    ] });
    expect(result.execution.inputs.resultIds).toEqual(["weather-result"]);
  });

  it("keeps a single usable date partial and does not invent a change", async () => {
    const service = new GrowthAnalysisService(createMemoryAnalysisResultStore(), "python", async () => ({
      status: "succeeded", sourceDate: "2026-06-26",
      quality: { flags: [], totalPixelCount: 20, validPixelCount: 20, validFraction: 1, cloudAffectedFraction: 0 },
      zoningMethod: "ndvi-quantile-connected-v2",
      zoningQuality: { robustRange: 0.2, minimumRobustRange: 0.05, variationVisible: true },
      metrics: {
        ndvi: { mean: 0.7, min: 0.4, max: 0.8, validPixelCount: 20, totalPixelCount: 20, coverageFraction: 1 },
        ndre: { mean: 0.4, min: 0.2, max: 0.6, validPixelCount: 20, totalPixelCount: 20, coverageFraction: 1 },
        reci: { mean: 2, min: 0.5, max: 3, validPixelCount: 20, totalPixelCount: 20, coverageFraction: 1 },
        msavi: { mean: 0.66, min: 0.35, max: 0.8, validPixelCount: 20, totalPixelCount: 20, coverageFraction: 1 },
        ndmi: { mean: 0.3, min: -0.1, max: 0.5, validPixelCount: 20, totalPixelCount: 20, coverageFraction: 1 },
        ndwi: { mean: -0.6, min: -0.8, max: -0.3, validPixelCount: 20, totalPixelCount: 20, coverageFraction: 1 },
      },
      zones: [{ id: "zone-low", row: 0, column: 0, meanNdvi: 0.6, deviation: -0.1, class: "below_average", validPixelCount: 12, zone: [[123.8, 42.3], [123.805, 42.3], [123.805, 42.305], [123.8, 42.305], [123.8, 42.3]] }], error: { code: null, message: null, retryable: false },
    }));
    const results = await new CornSkillRunner(service.createTools(field(), [acquisition()])).run("growth_stage_monitoring", taskId);
    expect(results[0]).toMatchObject({ status: "partial", result: { observations: [{ observationDate: "2026-06-26" }], changes: [] }, limitations: ["当前只有一个可用光学时相，不能判断历史变化日期。"] });
    expect(results[2]).toMatchObject({
      status: "partial",
      summary: "2026-06-26 光学观测估计处于拔节期，识别到 1 个需要关注的长势偏弱区；当前只有一个可用时相，暂不能判断历史变化。",
      result: { status: "watch", trend: "insufficient_timeseries", latestChange: null },
      nextActions: [],
    });
  });

  it("does not prescribe a routine field visit when the field is uniform", async () => {
    const service = new GrowthAnalysisService(createMemoryAnalysisResultStore(), "python", async () => opticalPayload("succeeded", 0.7));
    const results = await new CornSkillRunner(service.createTools(field(), [acquisition("2026-06-16"), acquisition("2026-06-26")])).run("growth_stage_monitoring", taskId);

    expect(results.at(-1)).toMatchObject({
      status: "succeeded",
      result: { belowAverageZoneCount: 0, belowAverageAreaHa: 0, belowAverageAreaFraction: 0 },
      nextActions: [],
    });
  });

  it("delivers the latest low-quality observation when it is the only date with valid pixels", async () => {
    const service = new GrowthAnalysisService(createMemoryAnalysisResultStore(), "python", async () => opticalPayload("partial", 0.67));
    const result = await service.createTools(field(), [acquisition("2026-06-26")])[0]!.execute({ taskId });

    expect(result).toMatchObject({
      status: "partial",
      result: { current: { observationDate: "2026-06-26", metrics: { ndvi: { mean: 0.67 } } }, observations: [{ observationDate: "2026-06-26" }], changes: [] },
      sources: [{ date: "2026-06-26", quality: "partial" }],
      error: null,
    });
    expect(result.limitations).toEqual(expect.arrayContaining(["当前只有一个可用光学时相，不能判断历史变化日期。"]));
  });

  it("uses only optical observations inside the task time range", async () => {
    let calls = 0;
    const service = new GrowthAnalysisService(createMemoryAnalysisResultStore(), "python", async () => {
      calls += 1;
      return {
        status: "succeeded", sourceDate: "2026-06-26",
        quality: { flags: [], totalPixelCount: 20, validPixelCount: 20, validFraction: 1, cloudAffectedFraction: 0 },
        zoningMethod: "ndvi-quantile-connected-v2",
        zoningQuality: { robustRange: 0.2, minimumRobustRange: 0.05, variationVisible: true },
        metrics: {
          ndvi: { mean: 0.7, min: 0.4, max: 0.8, validPixelCount: 20, totalPixelCount: 20, coverageFraction: 1 },
          ndre: { mean: 0.4, min: 0.2, max: 0.6, validPixelCount: 20, totalPixelCount: 20, coverageFraction: 1 },
          reci: { mean: 2, min: 0.5, max: 3, validPixelCount: 20, totalPixelCount: 20, coverageFraction: 1 },
          msavi: { mean: 0.66, min: 0.35, max: 0.8, validPixelCount: 20, totalPixelCount: 20, coverageFraction: 1 },
          ndmi: { mean: 0.3, min: -0.1, max: 0.5, validPixelCount: 20, totalPixelCount: 20, coverageFraction: 1 },
          ndwi: { mean: -0.6, min: -0.8, max: -0.3, validPixelCount: 20, totalPixelCount: 20, coverageFraction: 1 },
        },
        zones: [], error: { code: null, message: null, retryable: false },
      };
    });
    const timeRange = { start: "2026-06-20T00:00:00.000Z", end: "2026-06-30T23:59:59.000Z" };
    const results = await new CornSkillRunner(service.createTools(field(), [acquisition("2026-06-26"), acquisition("2026-06-16")], timeRange)).run("growth_stage_monitoring", taskId);
    expect(calls).toBe(1);
    expect(results[0]).toMatchObject({ status: "partial", result: { observations: [{ observationDate: "2026-06-26" }], changes: [] } });
  });

  it("keeps cloud-affected dates out of the usable time series", async () => {
    let calls = 0;
    const service = new GrowthAnalysisService(createMemoryAnalysisResultStore(), "python", async () => {
      calls += 1;
      return opticalPayload(calls === 1 ? "succeeded" : "partial", calls === 1 ? 0.68 : 0.73);
    });

    const results = await new CornSkillRunner(service.createTools(field(), [acquisition("2026-06-26"), acquisition("2026-07-01")])).run("growth_stage_monitoring", taskId);

    expect(results[0]).toMatchObject({
      status: "partial",
      result: { current: { observationDate: "2026-06-26" }, observations: [{ observationDate: "2026-06-26" }], changes: [] },
      sources: [
        { date: "2026-06-26", quality: "usable" },
        { date: "2026-07-01", quality: "partial", note: expect.stringContaining("不参与田况时序") },
      ],
    });
  });

  it("returns the latest season observation as historical when the requested window is newer", async () => {
    const service = new GrowthAnalysisService(createMemoryAnalysisResultStore(), "python", async () => ({
      status: "succeeded", sourceDate: "2026-06-26",
      quality: { flags: [], totalPixelCount: 20, validPixelCount: 20, validFraction: 1, cloudAffectedFraction: 0 },
      zoningMethod: "ndvi-quantile-connected-v2",
      zoningQuality: { robustRange: 0.2, minimumRobustRange: 0.05, variationVisible: true },
      metrics: {
        ndvi: { mean: 0.7, min: 0.4, max: 0.8, validPixelCount: 20, totalPixelCount: 20, coverageFraction: 1 },
        ndre: { mean: 0.4, min: 0.2, max: 0.6, validPixelCount: 20, totalPixelCount: 20, coverageFraction: 1 },
        reci: { mean: 2, min: 0.5, max: 3, validPixelCount: 20, totalPixelCount: 20, coverageFraction: 1 },
        msavi: { mean: 0.66, min: 0.35, max: 0.8, validPixelCount: 20, totalPixelCount: 20, coverageFraction: 1 },
        ndmi: { mean: 0.3, min: -0.1, max: 0.5, validPixelCount: 20, totalPixelCount: 20, coverageFraction: 1 },
        ndwi: { mean: -0.6, min: -0.8, max: -0.3, validPixelCount: 20, totalPixelCount: 20, coverageFraction: 1 },
      },
      zones: [], error: { code: null, message: null, retryable: false },
    }));
    const observationRange = { start: "2026-05-04T00:00:00.000Z", end: "2026-08-19T23:59:59.000Z" };
    const targetRange = { start: "2026-07-21T00:00:00.000Z", end: "2026-08-19T23:59:59.000Z" };

    const results = await new CornSkillRunner(service.createTools(field(), [acquisition("2026-06-26")], observationRange, targetRange)).run("growth_stage_monitoring", taskId);

    expect(results.at(-1)).toMatchObject({
      status: "partial",
      result: { latestObservationDate: "2026-06-26", observationAgeDays: 54, observationStatus: "stale" },
      nextActions: [],
    });
    expect(results.at(-1)?.sources.map((source) => source.date)).toEqual(["2026-06-26", "2026-05-04"]);
  });

  it.each([
    { code: "cloud_contaminated", message: "地块内像元受云污染，当前日期不可用于光学分析。", flag: "cloud_contaminated" },
    { code: "no_field_coverage", message: "当前影像不覆盖该地块。", flag: "no_coverage" },
  ])("preserves the explicit $code reason", async ({ code, message, flag }) => {
    const service = new GrowthAnalysisService(createMemoryAnalysisResultStore(), "python", async () => ({
      status: "needs_data", sourceDate: "2026-06-26",
      quality: { flags: [flag], totalPixelCount: code === "no_field_coverage" ? 0 : 20, validPixelCount: 0, validFraction: 0, cloudAffectedFraction: code === "cloud_contaminated" ? 1 : 0 },
      metrics: null, zones: [], error: { code, message, retryable: false },
    }));
    const results = await new CornSkillRunner(service.createTools(field(), [acquisition()])).run("growth_stage_monitoring", taskId);
    expect(results[0]).toMatchObject({ status: "needs_data", summary: message, error: { code }, sources: [{ note: message }] });
    expect(results[2]).toMatchObject({ status: "needs_data", result: null, nextActions: [{ code: "collect_optical_data" }] });
  });

  it("fails explicitly when a successful optical processor returns an obsolete zoning contract", async () => {
    const obsolete = opticalPayload("succeeded", 0.7) as OpticalPythonResult & { zoningMethod?: undefined; zoningQuality?: undefined };
    delete obsolete.zoningMethod;
    delete obsolete.zoningQuality;
    const service = new GrowthAnalysisService(createMemoryAnalysisResultStore(), "python", async () => obsolete);

    const result = await service.createTools(field(), [acquisition()])[0]!.execute({ taskId });

    expect(result).toMatchObject({ status: "failed", result: null, error: { code: "optical_processing_failed", retryable: true } });
    expect(result.sources[0]?.note).toContain("缺少当前版本的分区质量信息");
  });
});

function field(): FieldSummary {
  return {
    id: "field-1", organizationId: "org-1", code: "F-001", name: "北田", areaHa: 10, village: "铁岭", crop: "corn", seasonYear: 2026,
    plantingDate: "2026-05-04", variety: "先玉 335", boundaryVersion: 1, seasonCount: 1, centroid: { longitude: 123.805, latitude: 42.305 },
    boundary: [{ longitude: 123.8, latitude: 42.3 }, { longitude: 123.81, latitude: 42.3 }, { longitude: 123.81, latitude: 42.31 }, { longitude: 123.8, latitude: 42.31 }, { longitude: 123.8, latitude: 42.3 }],
    latestStatus: "not_analyzed", latestAnalyzedAt: null,
  };
}

function acquisition(date = "2026-06-26"): DataAcquisitionRun {
  return {
    id: `acquisition-${date}`, fieldId: "field-1", boundaryVersion: 1, period: { start: `${date}T00:00:00.000Z`, end: `${date}T23:59:59.000Z` },
    dataProfile: "growth_stage_v1", dataProfileVersion: "test", status: "completed", createdAt: "2026-06-30T00:00:00.000Z", completedAt: "2026-06-30T01:00:00.000Z", manifestVersion: "1.2", progress: [],
    sources: [{ sourceType: "optical", source: "sentinel-2", provider: "test", product: "test", status: "succeeded", requestedPeriod: null, discoveredAt: "2026-06-30T00:00:00.000Z", retrievedAt: "2026-06-30T01:00:00.000Z", availableDates: [date], selectedObservationDates: [date],
      selectedAssets: [
        asset("scene:B02+B03+B04+B08", "spectral", "spectral-10m.tif", date), asset("scene:B05+B06+B07+B8A+B11+B12", "spectral", "spectral-20m.tif", date), asset("scene:SCL", "quality-mask", "scl-20m.tif", date),
      ], coverage: { requestedAreaHa: 10, coveredAreaFraction: 1 }, quality: { flags: [], metadata: {} }, license: { access: "public", downloadAllowed: true, attribution: "test" }, limitations: [], error: { code: null, retryable: false, message: null } }],
  };
}

function asset(providerAssetId: string, role: "spectral" | "quality-mask", fileName: string, date: string) {
  return { id: providerAssetId, providerAssetId, role, capturedAt: `${date}T02:00:00.000Z`, validFrom: null, validTo: null, generatedAt: null, retrievedAt: "2026-06-30T01:00:00.000Z", spatialResolutionMeters: 20, crs: "EPSG:4326", format: "GeoTIFF", byteSize: 10, checksum: "sha256:test", artifactRef: `test/${date}-${fileName}`, accessStatus: "retrieved" as const };
}

function opticalPayload(status: "succeeded" | "partial", ndvi: number): OpticalPythonResult {
  const metric = (mean: number) => ({ mean, min: mean - 0.1, max: mean + 0.1, validPixelCount: status === "succeeded" ? 90 : 60, totalPixelCount: 100, coverageFraction: status === "succeeded" ? 0.9 : 0.6 });
  return {
    status,
    sourceDate: null,
    quality: { flags: status === "partial" ? ["cloud_contaminated"] : [], totalPixelCount: 100, validPixelCount: status === "succeeded" ? 90 : 60, validFraction: status === "succeeded" ? 0.9 : 0.6, cloudAffectedFraction: status === "succeeded" ? 0.1 : 0.4 },
    zoningMethod: "ndvi-quantile-connected-v2",
    zoningQuality: { robustRange: 0.2, minimumRobustRange: 0.05, variationVisible: true },
    metrics: { ndvi: metric(ndvi), ndre: metric(0.4), reci: metric(2), msavi: metric(0.65), ndmi: metric(0.3), ndwi: metric(-0.5) },
    zones: [],
    error: { code: null, message: null, retryable: false },
  };
}
