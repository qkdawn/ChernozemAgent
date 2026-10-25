import type { AcquiredAsset, DataAcquisitionRun, FieldSummary, SourceAcquisitionResult } from "@chernozem/contracts";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RasterDownloadRequest } from "./acquisition-downloaders.js";
import { SentinelHubProcessDownloader, SENTINEL_2_BANDS } from "./acquisition-downloaders.js";
import { CopernicusDemProvider, createEra5LandRequests, DataAcquisitionService, demGridIds, EcmwfIfsProvider, Era5LandProvider, matchAcquisitionDate, SentinelStacProvider, SoilGridsProvider } from "./data-acquisition.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("ERA5-Land request construction", () => {
  it("splits a time window by month without requesting extra dates", () => {
    const requests = createEra5LandRequests(
      { start: "2026-07-30T12:00:00.000Z", end: "2026-08-02T03:00:00.000Z" },
      [
        { longitude: 123.801, latitude: 42.301 },
        { longitude: 123.819, latitude: 42.301 },
        { longitude: 123.819, latitude: 42.319 },
        { longitude: 123.801, latitude: 42.319 },
      ],
    );

    expect(requests).toEqual([
      { year: "2026", month: "07", days: ["30", "31"], area: [42.4, 123.8, 42.3, 123.9] },
      { year: "2026", month: "08", days: ["01", "02"], area: [42.4, 123.8, 42.3, 123.9] },
    ]);
  });

  it("expands a point-like field to at least one ERA5 grid cell", () => {
    const request = createEra5LandRequests(
      { start: "2026-08-01T00:00:00.000Z", end: "2026-08-01T23:59:59.000Z" },
      [
        { longitude: 123.8, latitude: 42.3 },
        { longitude: 123.8, latitude: 42.3 },
        { longitude: 123.8, latitude: 42.3 },
      ],
    )[0]!;

    expect(request.area).toEqual([42.3, 123.8, 42.2, 123.9]);
  });
});

describe("acquisition download workers", () => {
  it("matches the nearest satellite date and covering weather period without substituting distant imagery", () => {
    const run: DataAcquisitionRun = {
      id: "run-1", fieldId: "field-1", boundaryVersion: 1, period: { start: "2026-08-01T00:00:00Z", end: "2026-08-12T00:00:00Z" },
      dataProfile: "field_baseline_v1", dataProfileVersion: "test", status: "completed", createdAt: "2026-08-12T01:00:00Z", completedAt: "2026-08-12T02:00:00Z", manifestVersion: "1.2", progress: [],
      sources: [
        sourceForDate("sentinel-1", ["2026-08-04", "2026-08-11"], [{ capturedAt: "2026-08-11T03:00:00Z" }]),
        sourceForDate("sentinel-2", ["2026-07-20"], []),
        sourceForDate("era5-land", [], [{ validFrom: "2026-08-01T00:00:00Z", validTo: "2026-08-06T23:00:00Z" }]),
      ],
    };

    const matches = matchAcquisitionDate([run], "2026-08-12");

    expect(matches.find((item) => item.source === "sentinel-1")).toMatchObject({ matchedDate: "2026-08-11", offsetDays: -1, status: "retrieved" });
    expect(matches.find((item) => item.source === "sentinel-2")).toMatchObject({ matchType: "none", status: "unavailable" });
    expect(matches.find((item) => item.source === "era5-land")).toMatchObject({
      matchType: "nearest", matchedDate: "2026-08-06", offsetDays: -6, status: "retrieved",
    });
  });

  it("reuses an in-progress run for the same field, boundary, and profile", async () => {
    let saved: DataAcquisitionRun | null = null;
    const store = {
      async save(run: DataAcquisitionRun) { saved = structuredClone(run); },
      async get() { return saved; },
      async latest() { return saved; },
      async list() { return saved ? [saved] : []; },
    };
    const service = new DataAcquisitionService(store, [{
      source: "sentinel-2" as const,
      discover: async (context) => {
        await context.reportProgress("downloading", "正在下载测试影像");
        return new Promise<never>(() => undefined);
      },
    }]);
    const first = await service.start(field(), {
      fieldId: "field-1", boundaryVersion: 1, dataProfile: "field_baseline_v1",
      period: { start: "2026-07-13T00:00:00.000Z", end: "2026-08-12T00:00:00.000Z" },
    });
    const second = await service.start(field(), {
      fieldId: "field-1", boundaryVersion: 1, dataProfile: "field_baseline_v1",
      period: { start: "2026-07-13T00:00:01.000Z", end: "2026-08-12T00:00:01.000Z" },
    });

    expect(second.id).toBe(first.id);
    expect(first.progress).toHaveLength(6);
    expect(first.progress.every((item) => item.stage === "queued")).toBe(true);
    await vi.waitFor(() => {
      expect(saved?.progress.find((item) => item.source === "sentinel-2")).toMatchObject({
        stage: "downloading",
        message: "正在下载测试影像",
      });
    });
  });

  it("selects every native GLO-30 tile touched by a field", () => {
    expect(demGridIds([
      { longitude: 123.99, latitude: 42.99 },
      { longitude: 124.01, latitude: 42.99 },
      { longitude: 124.01, latitude: 43.01 },
      { longitude: 123.99, latitude: 43.01 },
    ])).toEqual(["N42_E123", "N42_E124", "N43_E123", "N43_E124"]);
  });

  it("requests the fixed Sentinel-2 band contract including true color and red-edge bands", async () => {
    const target = resolve(import.meta.dirname, "../../../runtime/test-acquisitions/sentinel-2.tif");
    cleanupPaths.push(resolve(import.meta.dirname, "../../../runtime/test-acquisitions"));
    const requests: Array<{ url: string; body: string | null }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, body: typeof init?.body === "string" ? init.body : null });
      if (url.includes("openid-connect/token")) return new Response(JSON.stringify({ access_token: "token", expires_in: 600 }), { status: 200 });
      return new Response(fieldQualityGeoTiff(), { status: 200, headers: { "content-type": "image/tiff" } });
    }));

    const downloader = new SentinelHubProcessDownloader("client", "secret");
    const result = await downloader.retrieve("sentinel-2", {
      providerAssetId: "scene-1",
      capturedAt: "2026-08-05T02:00:00.000Z",
      period: { start: "2026-08-01T00:00:00.000Z", end: "2026-08-10T00:00:00.000Z" },
      boundary: field().boundary,
      target,
    });

    expect(new Set(result.outputs.flatMap((output) => output.bands))).toEqual(new Set(SENTINEL_2_BANDS));
    expect(requests.filter((request) => request.url.includes("process/v1"))).toHaveLength(3);
    const allEvalscripts = requests.filter((request) => request.url.includes("process/v1")).map((request) => (JSON.parse(request.body!) as { evalscript: string }).evalscript).join("\n");
    expect(allEvalscripts).toContain("B06");
    expect(allEvalscripts).toContain("B07");
    expect(allEvalscripts).toContain("B02");
    expect(result.outputs.find((output) => output.spatialResolutionMeters === 10)?.bands).toEqual(["B02", "B03", "B04", "B08"]);
    const processBody = JSON.parse(requests.find((request) => request.url.includes("process/v1"))!.body!) as {
      input: { data: Array<{ dataFilter: { timeRange: { from: string; to: string } } }> };
    };
    expect(processBody.input.data[0]!.dataFilter.timeRange).toEqual({
      from: "2026-08-05T00:00:00.000Z",
      to: "2026-08-05T23:59:59.999Z",
    });
    expect(result.outputs.find((output) => output.role === "quality-mask")?.pixelQuality).toMatchObject({
      totalPixelCount: 3,
      validPixelCount: 2,
      validPixelFraction: 2 / 3,
      cloudAffectedPixelCount: 1,
      cloudAffectedFraction: 1 / 3,
      sclClassHistogram: { "4": 2, "9": 1 },
    });
  });

  it("rejects and removes a valid GeoTIFF that contains no Sentinel-2 pixels", async () => {
    const targetRoot = resolve(import.meta.dirname, "../../../runtime/test-acquisitions-empty");
    const target = resolve(targetRoot, "sentinel-2.tif");
    cleanupPaths.push(targetRoot);
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes("openid-connect/token")) return new Response(JSON.stringify({ access_token: "token", expires_in: 600 }), { status: 200 });
      return new Response(zeroGeoTiff(), { status: 200, headers: { "content-type": "image/tiff" } });
    }));

    const downloader = new SentinelHubProcessDownloader("client", "secret");
    await expect(downloader.retrieve("sentinel-2", {
      providerAssetId: "scene-empty",
      capturedAt: "2026-08-05T02:00:00.000Z",
      period: { start: "2026-08-01T00:00:00.000Z", end: "2026-08-10T00:00:00.000Z" },
      boundary: field().boundary,
      target,
    })).rejects.toThrow("Sentinel-2 返回了全零空栅格");
    expect(existsSync(target.replace(".tif", "_spectral-10m.tif"))).toBe(false);
  });

  it("registers retrieved artifacts for Sentinel, DEM, IFS, and SoilGrids", async () => {
    const runId = `test-${Date.now()}`;
    const runtimeRoot = resolve(import.meta.dirname, "../../../runtime/artifacts/acquisitions", runId);
    cleanupPaths.push(runtimeRoot);
    const context = { runId, field: field(), period: { start: "2026-08-01T00:00:00.000Z", end: "2026-08-10T00:00:00.000Z" }, now: new Date("2026-08-12T00:00:00.000Z"), reportProgress: async () => undefined };
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("stac.dataspace")) return new Response(JSON.stringify(stacResponse()), { status: 200 });
      if (url.includes("odata/v1/Products")) return new Response(JSON.stringify({ value: [{ Id: "dem-product", ContentLength: 1234, PublicationDate: "2026-01-01T00:00:00Z" }] }), { status: 200 });
      if (url.includes("maps.isric.org")) return new Response("coverage", { status: 200 });
      if (url.includes("data.ecmwf.int")) return new Response("20260812000000-0h-oper-fc.grib2", { status: 200 });
      return new Response("not found", { status: 404 });
    }));
    const rasterDownloader = { async retrieve(source: "sentinel-1" | "sentinel-2", request: { target: string }) {
      const target = request.target.replace(".tif", `_${source}.tif`);
      await mkdir(resolve(target, ".."), { recursive: true });
      await writeFile(target, `raster-${source}`);
      return { outputs: [{
        target, format: "GeoTIFF" as const, spatialResolutionMeters: 10, crs: "EPSG:4326" as const,
        bands: source === "sentinel-2" ? ["SCL"] : ["VV", "VH", "dataMask"],
        role: source === "sentinel-2" ? "quality-mask" as const : "radar" as const,
        pixelQuality: source === "sentinel-2"
          ? { totalPixelCount: 100, validPixelCount: 95, validPixelFraction: 0.95, cloudAffectedPixelCount: 5, cloudAffectedFraction: 0.05, sclClassHistogram: { "4": 95, "9": 5 } }
          : null,
      }] };
    } };
    const demDownloader = { async retrieve(request: { target: string }) { await mkdir(resolve(request.target, ".."), { recursive: true }); await writeFile(request.target, "dem"); } };
    const ifsDownloader = { async retrieve(request: { target: string }) { await mkdir(resolve(request.target, ".."), { recursive: true }); await writeFile(request.target, JSON.stringify({ values: [] })); } };
    const soilDownloader = { async retrieve(request: { targetDirectory: string }) {
      await mkdir(request.targetDirectory, { recursive: true });
      await writeFile(resolve(request.targetDirectory, "nitrogen_5-15cm_Q0.5.tif"), "soil");
      return [{ providerAssetId: "nitrogen_5-15cm_Q0.5", fileName: "nitrogen_5-15cm_Q0.5.tif", property: "nitrogen", depth: "5-15cm", quantile: "Q0.5", spatialResolutionMeters: 250, crs: "EPSG:152160" }];
    } };
    const results = await Promise.all([
      new SentinelStacProvider("sentinel-2", "sentinel-2-l2a", "optical", "Sentinel-2 Level-2A", rasterDownloader).discover(context),
      new SentinelStacProvider("sentinel-1", "sentinel-1-grd", "radar", "Sentinel-1 IW GRD", rasterDownloader).discover(context),
      new CopernicusDemProvider(demDownloader).discover(context),
      new EcmwfIfsProvider(ifsDownloader).discover(context),
      new SoilGridsProvider(soilDownloader).discover(context),
    ]);

    for (const result of results) {
      expect(result.status).toBe("succeeded");
      expect(result.retrievedAt).not.toBeNull();
      expect(result.selectedAssets.length).toBeGreaterThan(0);
      expect(result.selectedAssets.every((asset) => asset.accessStatus === "retrieved" && asset.artifactRef && asset.checksum)).toBe(true);
    }
  });

  it("downloads a fully covered Sentinel-2 scene and judges quality only from field SCL", async () => {
    const runId = `cloudy-${Date.now()}`;
    const runtimeRoot = resolve(import.meta.dirname, "../../../runtime/artifacts/acquisitions", runId);
    cleanupPaths.push(runtimeRoot);
    const context = { runId, field: field(), period: { start: "2026-08-01T00:00:00.000Z", end: "2026-08-10T00:00:00.000Z" }, now: new Date("2026-08-12T00:00:00.000Z"), reportProgress: async () => undefined };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(stacResponse(28.39)), { status: 200 })));
    const rasterDownloader = { async retrieve(_source: "sentinel-1" | "sentinel-2", request: { target: string }) {
      const target = request.target.replace(".tif", "_scl-20m.tif");
      await mkdir(resolve(target, ".."), { recursive: true });
      await writeFile(target, "cloud-quality-pending");
      return { outputs: [{
        target, format: "GeoTIFF" as const, spatialResolutionMeters: 20, crs: "EPSG:4326" as const, bands: ["SCL"], role: "quality-mask" as const,
        pixelQuality: { totalPixelCount: 100, validPixelCount: 31, validPixelFraction: 0.31, cloudAffectedPixelCount: 69, cloudAffectedFraction: 0.69, sclClassHistogram: { "4": 31, "9": 69 } },
      }] };
    } };

    const result = await new SentinelStacProvider("sentinel-2", "sentinel-2-l2a", "optical", "Sentinel-2 Level-2A", rasterDownloader).discover(context);

    expect(result.status).toBe("partial");
    expect(result.quality.flags).toContain("cloud_contaminated");
    expect(result.quality.metadata).toMatchObject({
      cloudCoverPercent: 28.39,
      cloudAssessmentScope: "field_scl",
      fieldValidPixelFraction: 0.31,
      fieldCloudAffectedFraction: 0.69,
    });
    expect(result.selectedAssets).toHaveLength(1);
    expect(result.selectedAssets[0]).toMatchObject({ role: "quality-mask", accessStatus: "retrieved" });
    expect(result.error).toMatchObject({ code: "cloud_contaminated", retryable: false });
  });

  it("downloads one Sentinel-2 asset group per observation date and keeps per-date quality", async () => {
    const runId = `optical-series-${Date.now()}`;
    cleanupPaths.push(resolve(import.meta.dirname, "../../../runtime/artifacts/acquisitions", runId));
    const polygon = { type: "Polygon", coordinates: [[[123.7, 42.2], [123.9, 42.2], [123.9, 42.4], [123.7, 42.4], [123.7, 42.2]]] };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ features: [
      { id: "scene-latest", geometry: polygon, properties: { datetime: "2026-08-10T02:00:00.000Z", "eo:cloud_cover": 30 }, assets: { data: { type: "image/tiff", gsd: 10, roles: ["data"] } } },
      { id: "scene-middle", geometry: polygon, properties: { datetime: "2026-08-05T02:00:00.000Z", "eo:cloud_cover": 5 }, assets: { data: { type: "image/tiff", gsd: 10, roles: ["data"] } } },
      { id: "scene-middle-duplicate", geometry: polygon, properties: { datetime: "2026-08-05T01:00:00.000Z", "eo:cloud_cover": 2 }, assets: { data: { type: "image/tiff", gsd: 10, roles: ["data"] } } },
      { id: "scene-oldest", geometry: polygon, properties: { datetime: "2026-07-31T02:00:00.000Z", "eo:cloud_cover": 8 }, assets: { data: { type: "image/tiff", gsd: 10, roles: ["data"] } } },
    ] }), { status: 200 })));
    const retrieve = vi.fn(async (_source: "sentinel-1" | "sentinel-2", request: RasterDownloadRequest) => {
      expect(request.capturedAt).not.toBeNull();
      const capturedAt = request.capturedAt ?? "";
      const validFraction = capturedAt.startsWith("2026-08-10") ? 0.45 : 0.94;
      const outputs = [
        { suffix: "_spectral-10m.tif", bands: ["B03", "B04", "B08"], role: "spectral" as const, resolution: 10 },
        { suffix: "_spectral-20m.tif", bands: ["B05", "B06", "B07", "B8A", "B11", "B12"], role: "spectral" as const, resolution: 20 },
        { suffix: "_scl-20m.tif", bands: ["SCL"], role: "quality-mask" as const, resolution: 20 },
      ];
      return { outputs: await Promise.all(outputs.map(async (output) => {
        const target = request.target.replace(".tif", output.suffix);
        await mkdir(resolve(target, ".."), { recursive: true });
        await writeFile(target, `${capturedAt}-${output.role}`);
        return {
          target, format: "GeoTIFF" as const, spatialResolutionMeters: output.resolution, crs: "EPSG:4326" as const,
          bands: output.bands, role: output.role,
          pixelQuality: output.role === "quality-mask" ? { totalPixelCount: 100, validPixelCount: validFraction * 100, validPixelFraction: validFraction, cloudAffectedPixelCount: (1 - validFraction) * 100, cloudAffectedFraction: 1 - validFraction, sclClassHistogram: { "4": validFraction * 100, "9": (1 - validFraction) * 100 } } : null,
        };
      })) };
    });

    const result = await new SentinelStacProvider("sentinel-2", "sentinel-2-l2a", "optical", "Sentinel-2 Level-2A", { retrieve }).discover({
      ...acquisitionContext(runId),
      period: { start: "2026-07-25T00:00:00.000Z", end: "2026-08-12T00:00:00.000Z" },
    });

    expect(retrieve).toHaveBeenCalledTimes(3);
    expect(result.selectedObservationDates).toEqual(["2026-08-10", "2026-08-05", "2026-07-31"]);
    expect(result.selectedAssets).toHaveLength(9);
    expect(result.status).toBe("partial");
    expect(result.quality.metadata).toMatchObject({ fieldUsableSceneCount: 2, fieldCloudContaminatedSceneCount: 1, fieldQualityPendingSceneCount: 0 });
    expect(JSON.parse(String(result.quality.metadata.sceneQualityByDate))).toMatchObject({
      "2026-08-10": { validPixelFraction: 0.45 },
      "2026-08-05": { validPixelFraction: 0.94 },
      "2026-07-31": { validPixelFraction: 0.94 },
    });
  });

  it("downloads two comparable Sentinel-1 scenes for the waterlogging profile", async () => {
    const runId = `waterlogging-pair-${Date.now()}`;
    const runtimeRoot = resolve(import.meta.dirname, "../../../runtime/artifacts/acquisitions", runId);
    cleanupPaths.push(runtimeRoot);
    const context = {
      ...acquisitionContext(runId),
      dataProfile: "waterlogging_v1" as const,
      period: { start: "2026-08-01T00:00:00.000Z", end: "2026-08-20T00:00:00.000Z" },
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      features: [
        { id: "radar-after", geometry: { type: "Polygon", coordinates: [[[123.7, 42.2], [123.9, 42.2], [123.9, 42.4], [123.7, 42.4], [123.7, 42.2]]] }, properties: { datetime: "2026-08-11T05:00:00.000Z", "sar:instrument_mode": "IW", "sar:polarizations": ["VV", "VH"], "sat:orbit_state": "descending", "sat:relative_orbit": 105 }, assets: { data: { type: "image/tiff", gsd: 10, roles: ["data"] } } },
        { id: "radar-before", geometry: { type: "Polygon", coordinates: [[[123.7, 42.2], [123.9, 42.2], [123.9, 42.4], [123.7, 42.4], [123.7, 42.2]]] }, properties: { datetime: "2026-08-02T05:00:00.000Z", "sar:instrument_mode": "IW", "sar:polarizations": ["VV", "VH"], "sat:orbit_state": "descending", "sat:relative_orbit": 105 }, assets: { data: { type: "image/tiff", gsd: 10, roles: ["data"] } } },
      ],
    }), { status: 200 })));
    const retrieve = vi.fn(async (_source: "sentinel-1" | "sentinel-2", request: { target: string }) => {
      const target = request.target.replace(".tif", "_radar-10m.tif");
      await mkdir(resolve(target, ".."), { recursive: true });
      await writeFile(target, "radar");
      return { outputs: [{ target, format: "GeoTIFF" as const, spatialResolutionMeters: 10, crs: "EPSG:4326" as const, bands: ["VV", "VH", "dataMask"], role: "radar" as const, pixelQuality: null }] };
    });

    const result = await new SentinelStacProvider("sentinel-1", "sentinel-1-grd", "radar", "Sentinel-1 IW GRD", { retrieve }).discover(context);

    expect(retrieve).toHaveBeenCalledTimes(2);
    expect(result.status).toBe("succeeded");
    expect(result.selectedObservationDates).toEqual(["2026-08-02", "2026-08-11"]);
    expect(result.selectedAssets).toHaveLength(2);
    expect(result.quality.metadata).toMatchObject({ requiredSceneCount: 2, selectedSceneCount: 2, observationGapDays: 9 });
  });

  it("reuses the complete Sentinel-2 asset group selected by discovery", async () => {
    const cachedRunId = `cached-sentinel-${Date.now()}`;
    const cachedAssets = await createCachedAssets(cachedRunId, [
      { fileName: "spectral-10m.tif", providerAssetId: "scene-1:B02+B03+B04+B08", role: "spectral", capturedAt: "2026-08-05T02:00:00.000Z" },
      { fileName: "spectral-20m.tif", providerAssetId: "scene-1:B05+B06+B07+B8A+B11+B12", role: "spectral", capturedAt: "2026-08-05T02:00:00.000Z" },
      { fileName: "scl-20m.tif", providerAssetId: "scene-1:SCL", role: "quality-mask", capturedAt: "2026-08-05T02:00:00.000Z" },
    ]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(stacResponse()), { status: 200 })));
    const retrieve = vi.fn(async () => { throw new Error("downloader must not be called"); });
    const cachedResult = cachedSource("sentinel-2", cachedAssets, {
      assetCount: 3,
      fieldValidPixelFraction: 0.92,
      fieldCloudAffectedFraction: 0.08,
    });

    const result = await new SentinelStacProvider("sentinel-2", "sentinel-2-l2a", "optical", "Sentinel-2 Level-2A", { retrieve }).discover({
      ...acquisitionContext(`new-sentinel-${Date.now()}`),
      cachedResults: [{ runId: cachedRunId, result: cachedResult }],
    });

    expect(retrieve).not.toHaveBeenCalled();
    expect(result.selectedAssets.map((asset) => asset.artifactRef)).toEqual(cachedAssets.map((asset) => asset.artifactRef));
    expect(result.quality.metadata).toMatchObject({ cacheHit: true, reusedFromRunId: cachedRunId, reusedAssetCount: 3, downloadedAssetCount: 0 });
    expect(result.quality.metadata.fieldValidPixelFraction).toBe(0.92);
  });

  it("downloads Sentinel-2 again when a registered asset file is missing", async () => {
    const cachedRunId = `missing-sentinel-${Date.now()}`;
    const cachedAssets = await createCachedAssets(cachedRunId, [
      { fileName: "spectral-10m.tif", providerAssetId: "scene-1:B02+B03+B04+B08", role: "spectral", capturedAt: "2026-08-05T02:00:00.000Z" },
      { fileName: "spectral-20m.tif", providerAssetId: "scene-1:B05+B06+B07+B8A+B11+B12", role: "spectral", capturedAt: "2026-08-05T02:00:00.000Z" },
    ]);
    cachedAssets.push(cachedAsset(cachedRunId, "missing-scl.tif", "scene-1:SCL", "quality-mask", "2026-08-05T02:00:00.000Z"));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(stacResponse()), { status: 200 })));
    const retrieve = vi.fn(async (_source: "sentinel-1" | "sentinel-2", request: { target: string }) => {
      const outputs = [
        { suffix: "_10m.tif", bands: ["B02", "B03", "B04", "B08"], role: "spectral" as const, resolution: 10 },
        { suffix: "_20m.tif", bands: ["B05", "B06", "B07", "B8A", "B11", "B12"], role: "spectral" as const, resolution: 20 },
        { suffix: "_scl.tif", bands: ["SCL"], role: "quality-mask" as const, resolution: 20 },
      ];
      return { outputs: await Promise.all(outputs.map(async (output) => {
        const target = request.target.replace(".tif", output.suffix);
        await mkdir(resolve(target, ".."), { recursive: true });
        await writeFile(target, output.suffix);
        return {
          target, format: "GeoTIFF" as const, spatialResolutionMeters: output.resolution, crs: "EPSG:4326" as const,
          bands: output.bands, role: output.role,
          pixelQuality: output.role === "quality-mask"
            ? { totalPixelCount: 100, validPixelCount: 90, validPixelFraction: 0.9, cloudAffectedPixelCount: 10, cloudAffectedFraction: 0.1, sclClassHistogram: { "4": 90, "9": 10 } }
            : null,
        };
      })) };
    });
    const newRunId = `redownload-sentinel-${Date.now()}`;
    cleanupPaths.push(resolve(import.meta.dirname, "../../../runtime/artifacts/acquisitions", newRunId));

    const result = await new SentinelStacProvider("sentinel-2", "sentinel-2-l2a", "optical", "Sentinel-2 Level-2A", { retrieve }).discover({
      ...acquisitionContext(newRunId),
      cachedResults: [{ runId: cachedRunId, result: cachedSource("sentinel-2", cachedAssets, { assetCount: 3 }) }],
    });

    expect(retrieve).toHaveBeenCalledOnce();
    expect(result.quality.metadata.cacheHit).not.toBe(true);
    expect(result.selectedAssets.every((asset) => asset.artifactRef?.includes(newRunId))).toBe(true);
  });

  it("reuses ERA5-Land only when the registered month covers all requested days", async () => {
    const cachedRunId = `cached-era5-${Date.now()}`;
    const asset = (await createCachedAssets(cachedRunId, [{
      fileName: "era5-land_2026-08.nc", providerAssetId: "reanalysis-era5-land:2026-08", role: "weather-series",
      validFrom: "2026-08-01T00:00:00.000Z", validTo: "2026-08-12T23:00:00.000Z",
    }]))[0]!;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(era5Catalogue()), { status: 200 })));
    const retrieve = vi.fn(async () => { throw new Error("downloader must not be called"); });
    const cachedResult = cachedSource("era5-land", [asset], { dataset: "reanalysis-era5-land" });

    const result = await new Era5LandProvider("token", { retrieve }).discover({
      ...acquisitionContext(`new-era5-${Date.now()}`),
      cachedResults: [{ runId: cachedRunId, result: cachedResult }],
    });

    expect(retrieve).not.toHaveBeenCalled();
    expect(result.selectedAssets[0]?.artifactRef).toBe(asset.artifactRef);
    expect(result.quality.metadata).toMatchObject({ cacheHit: true, reusedAssetCount: 1, downloadedAssetCount: 0 });
  });

  it("downloads an ERA5-Land month again when its cached validity ends too early", async () => {
    const cachedRunId = `partial-era5-${Date.now()}`;
    const asset = (await createCachedAssets(cachedRunId, [{
      fileName: "era5-land_2026-08.nc", providerAssetId: "reanalysis-era5-land:2026-08", role: "weather-series",
      validFrom: "2026-08-01T00:00:00.000Z", validTo: "2026-08-05T23:00:00.000Z",
    }]))[0]!;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(era5Catalogue()), { status: 200 })));
    const retrieve = vi.fn(async (_request: unknown, _variables: readonly string[], target: string) => {
      await mkdir(resolve(target, ".."), { recursive: true });
      await writeFile(target, "complete-month");
    });
    const newRunId = `download-era5-${Date.now()}`;
    cleanupPaths.push(resolve(import.meta.dirname, "../../../runtime/artifacts/acquisitions", newRunId));

    const result = await new Era5LandProvider("token", { retrieve }).discover({
      ...acquisitionContext(newRunId),
      cachedResults: [{ runId: cachedRunId, result: cachedSource("era5-land", [asset], { dataset: "reanalysis-era5-land" }) }],
    });

    expect(retrieve).toHaveBeenCalledOnce();
    expect(result.quality.metadata).toMatchObject({ cacheHit: false, reusedAssetCount: 0, downloadedAssetCount: 1 });
    expect(result.selectedAssets[0]?.validTo).toBe("2026-08-10T23:00:00.000Z");
  });

  it("keeps overlapping ERA5-Land cache when credentials are missing", async () => {
    const cachedRunId = `cached-era5-no-key-${Date.now()}`;
    const asset = (await createCachedAssets(cachedRunId, [{
      fileName: "era5-land_2026-07.nc", providerAssetId: "reanalysis-era5-land:2026-07", role: "weather-series",
      validFrom: "2026-07-30T00:00:00.000Z", validTo: "2026-07-31T23:00:00.000Z",
    }]))[0]!;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(era5Catalogue()), { status: 200 })));
    const retrieve = vi.fn(async () => { throw new Error("download must not be called without a key"); });

    const result = await new Era5LandProvider(null, { retrieve }).discover({
      ...acquisitionContext(`no-key-era5-${Date.now()}`),
      period: { start: "2026-07-30T00:00:00.000Z", end: "2026-08-02T23:59:59.000Z" },
      cachedResults: [{ runId: cachedRunId, result: cachedSource("era5-land", [asset], { dataset: "reanalysis-era5-land" }) }],
    });

    expect(retrieve).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "partial", error: { code: "weather_incomplete", retryable: true } });
    expect(result.selectedAssets).toEqual([asset]);
    expect(result.quality.metadata).toMatchObject({ cacheHit: true, reusedAssetCount: 1, downloadedAssetCount: 0 });
  });

  it("checkpoints each completed ERA5-Land month before downloading the next month", async () => {
    const runId = `checkpoint-era5-${Date.now()}`;
    cleanupPaths.push(resolve(import.meta.dirname, "../../../runtime/artifacts/acquisitions", runId));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(era5Catalogue()), { status: 200 })));
    let requestCount = 0;
    const retrieve = vi.fn(async (_request: unknown, _variables: readonly string[], target: string) => {
      requestCount += 1;
      if (requestCount === 2) throw new Error("second month failed");
      await mkdir(resolve(target, ".."), { recursive: true });
      await writeFile(target, "completed-first-month");
    });
    const checkpoints: SourceAcquisitionResult[] = [];

    await expect(new Era5LandProvider("token", { retrieve }).discover({
      ...acquisitionContext(runId),
      period: { start: "2026-07-30T00:00:00.000Z", end: "2026-08-02T23:59:59.000Z" },
      reportCheckpoint: async (result) => { checkpoints.push(structuredClone(result)); },
    })).rejects.toThrow("second month failed");

    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]).toMatchObject({ status: "partial", error: { code: "weather_incomplete" } });
    expect(checkpoints[0]?.selectedAssets[0]).toMatchObject({
      providerAssetId: "reanalysis-era5-land:2026-07",
      validFrom: "2026-07-30T00:00:00.000Z",
      validTo: "2026-07-31T23:00:00.000Z",
      accessStatus: "retrieved",
    });
  });

  it("preserves checkpointed source assets when the remaining provider work fails", async () => {
    const checkpointAsset = cachedAsset("checkpoint-run", "era5-land_2026-07.nc", "reanalysis-era5-land:2026-07", "weather-series", undefined, "2026-07-30T00:00:00.000Z", "2026-07-31T23:00:00.000Z");
    const runs = new Map<string, DataAcquisitionRun>();
    const service = new DataAcquisitionService({
      async save(run) { runs.set(run.id, structuredClone(run)); },
      async get(id) { return runs.get(id) ?? null; },
      async latest(fieldId) { return [...runs.values()].filter((run) => run.fieldId === fieldId).sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ?? null; },
      async list(fieldId, limit) { return [...runs.values()].filter((run) => run.fieldId === fieldId).slice(0, limit); },
    }, [{
      source: "era5-land",
      async discover(context) {
        await context.reportCheckpoint?.(cachedSource("era5-land", [checkpointAsset], { dataset: "reanalysis-era5-land" }));
        throw new Error("remaining month failed");
      },
    }]);

    const result = await service.create(field(), {
      fieldId: "field-1", boundaryVersion: 1, dataProfile: "field_baseline_v1",
      period: { start: "2026-07-30T00:00:00.000Z", end: "2026-08-02T23:59:59.000Z" },
    });
    const era5 = result.sources.find((source) => source.source === "era5-land");

    expect(era5).toMatchObject({ status: "partial", error: { code: "provider_unavailable" } });
    expect(era5?.selectedAssets).toEqual([checkpointAsset]);
  });

  it("reuses the exact discovered DEM product and keeps boundary versions isolated", async () => {
    const cachedRunId = `cached-dem-${Date.now()}`;
    const asset = (await createCachedAssets(cachedRunId, [{ fileName: "dem.tif", providerAssetId: "dem-product", role: "dem" }]))[0]!;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      value: [{ Id: "dem-product", ContentLength: 1234, PublicationDate: "2026-01-01T00:00:00Z" }],
    }), { status: 200 })));
    const retrieve = vi.fn(async () => { throw new Error("downloader must not be called"); });
    const result = await new CopernicusDemProvider({ retrieve }).discover({
      ...acquisitionContext(`new-dem-${Date.now()}`),
      cachedResults: [{ runId: cachedRunId, result: cachedSource("copernicus-dem", [asset], { dataset: "COP-DEM_GLO-30-DGED/2024_1" }) }],
    });

    expect(retrieve).not.toHaveBeenCalled();
    expect(result.quality.metadata).toMatchObject({ cacheHit: true, reusedFromRunId: cachedRunId });

    const oldRun: DataAcquisitionRun = {
      id: "old-boundary", fieldId: "field-1", boundaryVersion: 1,
      period: acquisitionContext("unused").period, dataProfile: "field_baseline_v1", dataProfileVersion: "test",
      status: "completed", createdAt: "2026-08-10T00:00:00.000Z", completedAt: "2026-08-10T01:00:00.000Z", manifestVersion: "1.2",
      sources: [cachedSource("sentinel-2", [], {})], progress: [],
    };
    const runs = new Map([[oldRun.id, oldRun]]);
    let receivedCachedCount = -1;
    const service = new DataAcquisitionService({
      async save(run) { runs.set(run.id, structuredClone(run)); },
      async get(id) { return runs.get(id) ?? null; },
      async latest(fieldId) { return [...runs.values()].filter((run) => run.fieldId === fieldId).sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ?? null; },
      async list(fieldId, limit) { return [...runs.values()].filter((run) => run.fieldId === fieldId).slice(0, limit); },
    }, [{
      source: "sentinel-2",
      async discover(context) {
        receivedCachedCount = context.cachedResults?.length ?? 0;
        return cachedSource("sentinel-2", [], {});
      },
    }]);
    const changedField = { ...field(), boundaryVersion: 2 };
    await service.create(changedField, { fieldId: changedField.id, boundaryVersion: 2, dataProfile: "field_baseline_v1", period: acquisitionContext("unused").period });
    expect(receivedCachedCount).toBe(0);
  });
});

function field(): FieldSummary {
  return {
    id: "field-1", organizationId: "org-1", code: "TL-001", name: "测试地块", areaHa: 4.5, village: "测试村",
    crop: "corn", seasonYear: 2026, plantingDate: "2026-05-01", variety: null, boundaryVersion: 1, seasonCount: 1,
    centroid: { longitude: 123.805, latitude: 42.305 },
    boundary: [
      { longitude: 123.8, latitude: 42.3 }, { longitude: 123.81, latitude: 42.3 },
      { longitude: 123.81, latitude: 42.31 }, { longitude: 123.8, latitude: 42.31 }, { longitude: 123.8, latitude: 42.3 },
    ],
    latestStatus: "not_analyzed", latestAnalyzedAt: null,
  };
}

function sourceForDate(source: SourceAcquisitionResult["source"], availableDates: string[], assets: Array<{ capturedAt?: string; validFrom?: string; validTo?: string }>): SourceAcquisitionResult {
  return {
    sourceType: source === "sentinel-1" ? "radar" : source === "sentinel-2" ? "optical" : "weather-historical",
    source, provider: "test", product: "test", status: "succeeded", requestedPeriod: null, discoveredAt: "2026-08-12T00:00:00Z", retrievedAt: "2026-08-12T00:00:00Z",
    availableDates, selectedObservationDates: [], selectedAssets: assets.map((asset, index) => ({
      id: `asset-${index}`, providerAssetId: `provider-${index}`, role: source === "sentinel-1" ? "radar" : source === "sentinel-2" ? "spectral" : "weather-series",
      capturedAt: asset.capturedAt ?? null, validFrom: asset.validFrom ?? null, validTo: asset.validTo ?? null, generatedAt: null, retrievedAt: "2026-08-12T00:00:00Z",
      spatialResolutionMeters: null, crs: null, format: "test", byteSize: 1, checksum: "sha256:test", artifactRef: "test", accessStatus: "retrieved",
    })),
    coverage: { requestedAreaHa: 1, coveredAreaFraction: 1 }, quality: { flags: [], metadata: {} }, license: { access: "public", downloadAllowed: true, attribution: "test" }, limitations: [], error: { code: null, retryable: false, message: null },
  };
}

function acquisitionContext(runId: string) {
  return {
    runId,
    field: field(),
    period: { start: "2026-08-01T00:00:00.000Z", end: "2026-08-10T00:00:00.000Z" },
    now: new Date("2026-08-12T00:00:00.000Z"),
    reportProgress: async () => undefined,
  };
}

interface CachedAssetInput {
  fileName: string;
  providerAssetId: string;
  role: AcquiredAsset["role"];
  capturedAt?: string;
  validFrom?: string;
  validTo?: string;
}

async function createCachedAssets(runId: string, inputs: CachedAssetInput[]): Promise<AcquiredAsset[]> {
  const root = resolve(import.meta.dirname, "../../../runtime/artifacts/acquisitions", runId);
  cleanupPaths.push(root);
  await mkdir(resolve(root, "cache"), { recursive: true });
  return Promise.all(inputs.map(async (input) => {
    await writeFile(resolve(root, "cache", input.fileName), `cached-${input.fileName}`);
    return cachedAsset(runId, input.fileName, input.providerAssetId, input.role, input.capturedAt, input.validFrom, input.validTo);
  }));
}

function cachedAsset(
  runId: string,
  fileName: string,
  providerAssetId: string,
  role: AcquiredAsset["role"],
  capturedAt?: string,
  validFrom?: string,
  validTo?: string,
): AcquiredAsset {
  return {
    id: `${runId}-${fileName}`, providerAssetId, role, capturedAt: capturedAt ?? null, validFrom: validFrom ?? null, validTo: validTo ?? null,
    generatedAt: null, retrievedAt: "2026-08-11T00:00:00.000Z", spatialResolutionMeters: null, crs: null, format: "test",
    byteSize: 10, checksum: "sha256:cached", artifactRef: `acquisitions/${runId}/cache/${fileName}`, accessStatus: "retrieved",
  };
}

function cachedSource(
  source: SourceAcquisitionResult["source"],
  assets: AcquiredAsset[],
  metadata: SourceAcquisitionResult["quality"]["metadata"],
): SourceAcquisitionResult {
  const sourceType: SourceAcquisitionResult["sourceType"] = source === "sentinel-1" ? "radar"
    : source === "sentinel-2" ? "optical"
      : source === "copernicus-dem" ? "terrain"
        : source === "soilgrids-250m" ? "soil"
          : source === "ecmwf-ifs" ? "weather-forecast"
            : "weather-historical";
  return {
    sourceType, source, provider: "test",
    product: source === "soilgrids-250m" ? "SoilGrids 250m 2.0" : source === "copernicus-dem" ? "Copernicus DEM GLO-30" : "test",
    status: "succeeded", requestedPeriod: null, discoveredAt: "2026-08-11T00:00:00.000Z", retrievedAt: "2026-08-11T00:00:00.000Z",
    availableDates: [], selectedObservationDates: [], selectedAssets: assets,
    coverage: { requestedAreaHa: 4.5, coveredAreaFraction: 1 }, quality: { flags: [], metadata },
    license: { access: "public", downloadAllowed: true, attribution: "test" }, limitations: [],
    error: { code: null, retryable: false, message: null },
  };
}

function era5Catalogue() {
  return {
    id: "reanalysis-era5-land",
    title: "ERA5-Land hourly data",
    extent: { temporal: { interval: [["1950-01-01T00:00:00.000Z", "2026-08-15T00:00:00.000Z"]] } },
  };
}

function stacResponse(cloudCover = 5) {
  return {
    features: [{
      id: "scene-1",
      geometry: { type: "Polygon", coordinates: [[[123.7, 42.2], [123.9, 42.2], [123.9, 42.4], [123.7, 42.4], [123.7, 42.2]]] },
      properties: { datetime: "2026-08-05T02:00:00.000Z", "eo:cloud_cover": cloudCover, "sar:instrument_mode": "IW", "sar:polarizations": ["VV", "VH"], "sat:orbit_state": "ascending", "sat:relative_orbit": 69 },
      assets: { data: { type: "image/tiff", gsd: 10, roles: ["data"] } },
    }],
  };
}

function nonzeroGeoTiff(): ArrayBuffer {
  return decodedArrayBuffer("SUkqAAgAAAAQAAABAwABAAAAAQAAAAEBAwABAAAAAQAAAAIBAwABAAAACAAAAAMBAwABAAAAAQAAAAYBAwABAAAAAQAAABEBBAABAAAAbgEAABUBAwABAAAAAQAAABYBAwABAAAAAQAAABcBBAABAAAAAQAAABwBAwABAAAAAQAAAFMBAwABAAAAAQAAAA6DDAADAAAAzgAAAIKEDAAGAAAA5gAAAK+HAwAgAAAAFgEAALCHDAACAAAAVgEAALGHAgAIAAAAZgEAAAAAAAAAAAAAAADwPwAAAAAAAPA/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPA/AAAAAAAAAAABAAEAAAAHAAAEAAABAAIAAQQAAAEAAQAACAAAAQDmEAEIsYcHAAAABggAAAEAjiMJCLCHAQABAAsIsIcBAAAAiG10lh2kckAAAABAplRYQVdHUyA4NHwAAQ==");
}

function fieldQualityGeoTiff(): ArrayBuffer {
  return decodedArrayBuffer("SUkqAAgAAAAQAAABAwABAAAAAgAAAAEBAwABAAAAAgAAAAIBAwABAAAACAAAAAMBAwABAAAAAQAAAAYBAwABAAAAAQAAABEBBAABAAAAbgEAABUBAwABAAAAAQAAABYBAwABAAAAAgAAABcBBAABAAAABAAAABwBAwABAAAAAQAAAFMBAwABAAAAAQAAAA6DDAADAAAAzgAAAIKEDAAGAAAA5gAAAK+HAwAgAAAAFgEAALCHDAACAAAAVgEAALGHAgAIAAAAZgEAAAAAAAAAAAAAAADwPwAAAAAAAPA/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAABAAEAAAAHAAAEAAABAAIAAQQAAAEAAQAACAAAAQDmEAEIsYcHAAAABggAAAEAjiMJCLCHAQABAAsIsIcBAAAAiG10lh2kckAAAABAplRYQVdHUyA4NHwABAQACQ==");
}

function zeroGeoTiff(): ArrayBuffer {
  return decodedArrayBuffer("SUkqAAgAAAAQAAABAwABAAAAAQAAAAEBAwABAAAAAQAAAAIBAwABAAAACAAAAAMBAwABAAAAAQAAAAYBAwABAAAAAQAAABEBBAABAAAAbgEAABUBAwABAAAAAQAAABYBAwABAAAAAQAAABcBBAABAAAAAQAAABwBAwABAAAAAQAAAFMBAwABAAAAAQAAAA6DDAADAAAAzgAAAIKEDAAGAAAA5gAAAK+HAwAgAAAAFgEAALCHDAACAAAAVgEAALGHAgAIAAAAZgEAAAAAAAAAAAAAAADwPwAAAAAAAPA/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPA/AAAAAAAAAAABAAEAAAAHAAAEAAABAAIAAQQAAAEAAQAACAAAAQDmEAEIsYcHAAAABggAAAEAjiMJCLCHAQABAAsIsIcBAAAAiG10lh2kckAAAABAplRYQVdHUyA4NHwAAA==");
}

function decodedArrayBuffer(value: string): ArrayBuffer {
  const buffer = Buffer.from(value, "base64");
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}
