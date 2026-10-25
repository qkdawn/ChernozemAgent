import type {
  AcquisitionPeriod,
  AcquisitionDateMatch,
  AcquiredAsset,
  CreateDataAcquisitionRequest,
  DataAcquisitionRun,
  DataProfile,
  DataSource,
  AcquisitionSourceStage,
  FieldSummary,
  Position,
  SourceAcquisitionResult,
} from "@chernozem/contracts";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { spawn } from "node:child_process";

import type { AcquisitionStore } from "./acquisition-store.js";
import { PROFILE_SOURCES } from "./data-profiles.js";
import {
  type CdseRasterDownloader,
  type CopernicusDemDownloader,
  DownloadError,
  fileMetadata,
  type IfsPointDownloader,
  NativeCopernicusDemDownloader,
  PythonIfsPointDownloader,
  PythonSoilGridsDownloader,
  type RasterPixelQuality,
  SENTINEL_1_BANDS,
  SENTINEL_2_BANDS,
  SentinelHubProcessDownloader,
  type SoilGridsDownloader,
} from "./acquisition-downloaders.js";

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_OPTICAL_SCENES_PER_RUN = 12;
const PROFILE_VERSION = "2026-08-19";

export interface AcquisitionProvider {
  readonly source: DataSource;
  discover(context: AcquisitionContext): Promise<SourceAcquisitionResult>;
}

export interface AcquisitionContext {
  runId: string;
  field: FieldSummary;
  period: AcquisitionPeriod;
  dataProfile?: DataProfile;
  now: Date;
  cachedResults?: CachedSourceResult[];
  reportCheckpoint?(result: SourceAcquisitionResult): Promise<void>;
  reportProgress(stage: AcquisitionSourceStage, message: string): Promise<void>;
}

export interface CachedSourceResult {
  runId: string;
  result: SourceAcquisitionResult;
}

export class DataAcquisitionService {
  private readonly providersBySource: Map<DataSource, AcquisitionProvider>;
  private readonly pendingStarts = new Map<string, Promise<DataAcquisitionRun>>();

  constructor(private readonly store: AcquisitionStore, providers: AcquisitionProvider[]) {
    this.providersBySource = new Map(providers.map((provider) => [provider.source, provider]));
  }

  async create(field: FieldSummary, request: CreateDataAcquisitionRequest): Promise<DataAcquisitionRun> {
    const run = await this.initialize(field, request);
    return this.execute(run, field, request);
  }

  start(field: FieldSummary, request: CreateDataAcquisitionRequest): Promise<DataAcquisitionRun> {
    const scope = `${field.id}:${field.boundaryVersion}:${request.dataProfile}`;
    const pending = this.pendingStarts.get(scope);
    if (pending) return pending;
    const operation = this.startOnce(field, request).finally(() => {
      if (this.pendingStarts.get(scope) === operation) this.pendingStarts.delete(scope);
    });
    this.pendingStarts.set(scope, operation);
    return operation;
  }

  private async startOnce(field: FieldSummary, request: CreateDataAcquisitionRequest): Promise<DataAcquisitionRun> {
    const latest = await this.store.latest(field.id);
    if (latest && latest.status === "running"
      && latest.boundaryVersion === field.boundaryVersion
      && latest.dataProfile === request.dataProfile) {
      return latest;
    }
    const run = await this.initialize(field, request);
    void this.execute(run, field, request).catch(async (error: unknown) => {
      const message = error instanceof Error ? error.message : "采集后台任务意外终止。";
      const failed: DataAcquisitionRun = {
        ...run,
        status: "failed",
        completedAt: new Date().toISOString(),
        sources: PROFILE_SOURCES[request.dataProfile].map((source) => sourceResult({
          ...sourceMetadata(source), source, status: "failed", period: request.period, discoveredAt: run.createdAt,
          areaHa: field.areaHa, flags: ["acquisition_worker_failed"], metadata: {},
          limitations: ["后台采集任务未完成，本次没有登记该来源资产。"],
          error: { code: "acquisition_worker_failed", retryable: true, message },
          license: { access: "unknown", downloadAllowed: false, attribution: null },
        })),
        progress: PROFILE_SOURCES[request.dataProfile].map((source) => ({
          source, stage: "failed", message: "采集进程意外终止", updatedAt: new Date().toISOString(),
        })),
      };
      try { await this.store.save(failed); } catch { /* The store outage remains observable in service logs. */ }
    });
    return run;
  }

  private async initialize(field: FieldSummary, request: CreateDataAcquisitionRequest): Promise<DataAcquisitionRun> {
    const now = new Date();
    const run: DataAcquisitionRun = {
      id: randomUUID(),
      fieldId: field.id,
      boundaryVersion: field.boundaryVersion,
      period: request.period,
      dataProfile: request.dataProfile,
      dataProfileVersion: PROFILE_VERSION,
      status: "running",
      createdAt: now.toISOString(),
      completedAt: null,
      manifestVersion: "1.3",
      sources: [],
      progress: PROFILE_SOURCES[request.dataProfile].map((source) => ({
        source, stage: "queued", message: "等待开始", updatedAt: now.toISOString(),
      })),
    };
    await this.store.save(run);
    return run;
  }

  private async execute(run: DataAcquisitionRun, field: FieldSummary, request: CreateDataAcquisitionRequest): Promise<DataAcquisitionRun> {
    const now = new Date(run.createdAt);
    const cachedResults = (await this.store.list(field.id, 100))
      .filter((candidate) => candidate.id !== run.id && candidate.boundaryVersion === field.boundaryVersion)
      .flatMap((candidate) => candidate.sources.map((result) => ({ runId: candidate.id, result })));
    const progress = new Map(run.progress.map((item) => [item.source, item]));
    const results = new Map<DataSource, SourceAcquisitionResult>();
    let saveChain = Promise.resolve();
    const saveProgress = (source: DataSource, stage: AcquisitionSourceStage, message: string): Promise<void> => {
      progress.set(source, { source, stage, message, updatedAt: new Date().toISOString() });
      const snapshot: DataAcquisitionRun = {
        ...run,
        sources: PROFILE_SOURCES[request.dataProfile].flatMap((item) => results.has(item) ? [results.get(item)!] : []),
        progress: PROFILE_SOURCES[request.dataProfile].map((item) => progress.get(item)!),
      };
      saveChain = saveChain.then(() => this.store.save(snapshot));
      return saveChain;
    };
    const sources = await Promise.all(PROFILE_SOURCES[request.dataProfile].map(async (source) => {
      await saveProgress(source, "discovering", "正在检索可用数据");
      const provider = this.providersBySource.get(source);
      if (!provider) {
        const result = unavailableProviderResult(source, field, request.period, now);
        results.set(source, result);
        await saveProgress(source, "failed", "数据来源未注册");
        return result;
      }
      try {
        const result = await provider.discover({
          runId: run.id, field, period: request.period, dataProfile: request.dataProfile, now,
          cachedResults: cachedResults.filter((cached) => cached.result.source === source),
          reportCheckpoint: async (checkpoint) => {
            results.set(source, checkpoint);
            await saveProgress(source, "downloading", `已保存 ${checkpoint.selectedAssets.length} 个文件，继续获取剩余数据`);
          },
          reportProgress: (stage, message) => saveProgress(source, stage, message),
        });
        results.set(source, result);
        await saveProgress(source, result.status === "failed" ? "failed" : "completed", sourceCompletionMessage(result));
        return result;
      } catch (error) {
        const failure = failedProviderResult(provider.source, field, request.period, now, error);
        const checkpoint = results.get(source);
        const result: SourceAcquisitionResult = checkpoint?.selectedAssets.some((asset) => asset.accessStatus === "retrieved")
          ? {
              ...checkpoint,
              status: "partial",
              quality: { ...checkpoint.quality, flags: [...new Set([...checkpoint.quality.flags, ...failure.quality.flags])] },
              limitations: [...checkpoint.limitations, "后续数据获取失败，已完成文件仍然保留。"],
              error: failure.error,
            }
          : failure;
        results.set(source, result);
        await saveProgress(source, "failed", result.error.message ?? "获取失败");
        return result;
      }
    }));

    const completed: DataAcquisitionRun = {
      ...run,
      status: runStatus(sources),
      completedAt: new Date().toISOString(),
      sources,
      progress: PROFILE_SOURCES[request.dataProfile].map((source) => progress.get(source)!),
    };
    await this.store.save(completed);
    return completed;
  }

  get(id: string) { return this.store.get(id); }
  latest(fieldId: string) { return this.store.latest(fieldId); }
  list(fieldId: string, limit = 20) { return this.store.list(fieldId, limit); }
  async matchDate(fieldId: string, targetDate: string): Promise<AcquisitionDateMatch[]> {
    return matchAcquisitionDate(await this.store.list(fieldId, 20), targetDate);
  }
}

export function createDefaultAcquisitionProviders(env: NodeJS.ProcessEnv = process.env): AcquisitionProvider[] {
  const pythonExecutable = env.PYTHON_EXECUTABLE ?? "python";
  const sentinelDownloader = env.CDSE_CLIENT_ID && env.CDSE_CLIENT_SECRET
    ? new SentinelHubProcessDownloader(env.CDSE_CLIENT_ID, env.CDSE_CLIENT_SECRET, pythonExecutable)
    : null;
  return [
    new SentinelStacProvider("sentinel-2", "sentinel-2-l2a", "optical", "Sentinel-2 Level-2A", sentinelDownloader),
    new SentinelStacProvider("sentinel-1", "sentinel-1-grd", "radar", "Sentinel-1 IW GRD", sentinelDownloader),
    new CopernicusDemProvider(env.CDSE_USERNAME && env.CDSE_PASSWORD ? new NativeCopernicusDemDownloader(env.CDSE_USERNAME, env.CDSE_PASSWORD, pythonExecutable) : null),
    new Era5LandProvider(env.CDS_API_KEY ?? null, new PythonCdsDownloader(pythonExecutable)),
    new EcmwfIfsProvider(new PythonIfsPointDownloader(pythonExecutable)),
    new SoilGridsProvider(new PythonSoilGridsDownloader(pythonExecutable)),
  ];
}

export class SentinelStacProvider implements AcquisitionProvider {
  constructor(
    readonly source: "sentinel-1" | "sentinel-2",
    private readonly collection: string,
    private readonly sourceType: "optical" | "radar",
    private readonly product: string,
    private readonly downloader: CdseRasterDownloader | null,
  ) {}

  async discover(context: AcquisitionContext): Promise<SourceAcquisitionResult> {
    const discoveredAt = new Date().toISOString();
    const response = await fetchJson<StacSearchResponse>("https://stac.dataspace.copernicus.eu/v1/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        collections: [this.collection],
        // STAC requires RFC 3339 instants for interval bounds; the UI stores calendar dates.
        datetime: `${context.period.start}T00:00:00Z/${context.period.end}T23:59:59Z`,
        intersects: toGeoJsonPolygon(context.field.boundary),
        limit: 50,
      }),
    });
    const candidates = response.features
      .map(normalizeStacFeature)
      .filter((feature): feature is NormalizedStacFeature => feature !== null)
      .sort((left, right) => right.capturedAt.localeCompare(left.capturedAt));
    const withCoverage = candidates.map((candidate) => ({ ...candidate, coverage: fieldCoverage(context.field.boundary, candidate.geometry) }));
    const fullyCovered = withCoverage.filter((candidate) => candidate.coverage === 1);
    const selectable = fullyCovered.filter((candidate) => this.source === "sentinel-2"
      || (candidate.acquisitionMode === "IW" && candidate.polarizations.includes("VV") && candidate.polarizations.includes("VH")));
    const selectedScenes = selectSentinelScenes(this.source, context.dataProfile, selectable);
    const selected = selectedScenes[0] ?? null;
    const availableDates = uniqueDates(withCoverage.map((candidate) => candidate.capturedAt));
    const bestCloudCover = this.source === "sentinel-2"
      ? minimum(withCoverage.map((candidate) => candidate.cloudCover).filter((value): value is number => value !== null))
      : null;

    if (withCoverage.length === 0) {
      return sourceResult({
        sourceType: this.sourceType,
        source: this.source,
        provider: "Copernicus Data Space STAC",
        product: this.product,
        status: "partial",
        period: context.period,
        discoveredAt,
        areaHa: context.field.areaHa,
        flags: ["no_scenes"],
        metadata: { candidateSceneCount: 0 },
        limitations: ["所选时间窗口内没有发现覆盖该地块的场景。"],
        error: { code: "no_scenes", retryable: false, message: "所选时间窗口内没有可用场景。" },
        license: publicCopernicusLicense(false),
      });
    }

    if (!selected) {
      return sourceResult({
        sourceType: this.sourceType,
        source: this.source,
        provider: "Copernicus Data Space STAC",
        product: this.product,
        status: "partial",
        period: context.period,
        discoveredAt,
        availableDates,
        areaHa: context.field.areaHa,
        coverageFraction: maximum(withCoverage.map((candidate) => candidate.coverage).filter((value): value is number => value !== null)),
        flags: ["partial_coverage"],
        metadata: { candidateSceneCount: withCoverage.length, bestCloudCover, coverageThresholdPercent: 95 },
        limitations: ["候选场景未确认完整覆盖地块。"],
        error: { code: "no_coverage", retryable: false, message: "没有确认完整覆盖的场景。" },
        license: publicCopernicusLicense(false),
      });
    }

    const selectedDates = selectedScenes.map((scene) => scene.capturedAt.slice(0, 10));
    const selectedAssetGroups: AcquiredAsset[][] = [];
    const cachedAssetGroups = new Map<string, AcquiredAsset[]>();
    const cachedRuns: string[] = [];
    const cachedResults: SourceAcquisitionResult[] = [];
    const missingScenes: NormalizedStacFeature[] = [];
    for (const scene of selectedScenes) {
      const cached = await findReusableAssets(context, (result) => {
        if (result.source !== this.source) return null;
        const assets = result.selectedAssets.filter((asset) => asset.capturedAt === scene.capturedAt && asset.providerAssetId.startsWith(`${scene.id}:`));
        if (this.source === "sentinel-2") {
          const complete = assets.some((asset) => asset.role === "spectral" && asset.providerAssetId.endsWith(":B02+B03+B04+B08"))
            && assets.some((asset) => asset.role === "spectral" && asset.providerAssetId.endsWith(":B05+B06+B07+B8A+B11+B12"))
            && assets.some((asset) => asset.role === "quality-mask" && asset.providerAssetId.endsWith(":SCL"));
          return complete ? assets : null;
        }
        return assets.length > 0 && assets.every((asset) => asset.role === "radar") ? assets : null;
      });
      if (cached) {
        selectedAssetGroups.push(cached.assets);
        cachedAssetGroups.set(scene.capturedAt, cached.assets);
        cachedRuns.push(cached.runId);
        cachedResults.push(cached.result);
      } else {
        missingScenes.push(scene);
      }
    }
    if (missingScenes.length > 0 && !this.downloader) {
      const discoveredAssets = missingScenes.map((scene) => ({
        id: randomUUID(), providerAssetId: scene.id, role: this.source === "sentinel-2" ? "spectral" as const : "radar" as const,
        capturedAt: scene.capturedAt, validFrom: null, validTo: null, generatedAt: scene.generatedAt, retrievedAt: null,
        spatialResolutionMeters: scene.resolution, crs: scene.crs, format: scene.format, byteSize: scene.byteSize, checksum: null,
        artifactRef: null, accessStatus: "discovered" as const,
      }));
      const assets = [...selectedAssetGroups.flat(), ...discoveredAssets];
      const pairState = radarPairState(this.source, selectedScenes, requiresRadarPair(context.dataProfile));
      return sourceResult({
        sourceType: this.sourceType, source: this.source, provider: "Copernicus Data Space STAC + Sentinel Hub Process API", product: this.product,
        status: "needs_input", period: context.period, discoveredAt, availableDates, selectedDates, assets,
        areaHa: context.field.areaHa, coverageFraction: selected.coverage,
        flags: ["asset_authorization_required", ...(pairState.flags)],
        metadata: { ...sentinelMetadata(this.source, selectedScenes, withCoverage.length, selectable.length, bestCloudCover), requiredSceneCount: this.source === "sentinel-1" && requiresRadarPair(context.dataProfile) ? 2 : 1, selectedSceneCount: selectedScenes.length },
        limitations: ["目录可公开检索；按地块下载影像需要配置 CDSE_CLIENT_ID 和 CDSE_CLIENT_SECRET。", ...pairState.limitations],
        error: { code: "provider_unauthorized", retryable: false, message: "请配置 CDSE Sentinel Hub OAuth client。" }, license: publicCopernicusLicense(selectedAssetGroups.length > 0),
      });
    }

    const relativeDirectory = this.source === "sentinel-2" ? "optical/sentinel-2" : "radar/sentinel-1";
    const downloadedGroups: AcquiredAsset[][] = [];
    const sceneQualities = new Map<string, RasterPixelQuality>();
    for (const scene of selectedScenes) {
      const cached = cachedResults.find((result) => result.selectedAssets.some((asset) => asset.capturedAt === scene.capturedAt));
      const qualityAsset = cachedAssetGroups.get(scene.capturedAt)?.find((asset) => asset.role === "quality-mask" && asset.artifactRef);
      const qualityPath = qualityAsset?.artifactRef ? resolveAcquisitionArtifact(qualityAsset.artifactRef) : null;
      const quality = qualityPath && this.downloader?.inspectQualityMask
        ? await this.downloader.inspectQualityMask(qualityPath)
        : cached ? cachedSceneQuality(cached, scene.capturedAt) : null;
      if (quality) sceneQualities.set(scene.capturedAt, quality);
    }
    for (const scene of missingScenes) {
      const fileName = `${scene.capturedAt.replaceAll(":", "-")}_${safeFilePart(scene.id)}.tif`;
      const target = acquisitionArtifactPath(context.runId, relativeDirectory, fileName);
      await context.reportProgress("downloading", `正在下载 ${this.product}（${scene.capturedAt.slice(0, 10)}）`);
      const raster = await this.downloader!.retrieve(this.source, { providerAssetId: scene.id, boundary: context.field.boundary, capturedAt: scene.capturedAt, period: context.period, target, orbitDirection: scene.orbitDirection });
      const pixelQuality = raster.outputs.find((output) => output.role === "quality-mask")?.pixelQuality ?? null;
      if (pixelQuality) sceneQualities.set(scene.capturedAt, pixelQuality);
      await context.reportProgress("validating", "正在校验影像文件与像元质量");
      const retrievedAt = new Date().toISOString();
      downloadedGroups.push(await Promise.all(raster.outputs.map(async (output) => {
        const file = await fileMetadata(output.target);
        const outputFileName = output.target.split(/[\\/]/).at(-1)!;
        return { id: randomUUID(), providerAssetId: `${scene.id}:${output.bands.join("+")}`, role: output.role, capturedAt: scene.capturedAt, validFrom: null, validTo: null, generatedAt: scene.generatedAt, retrievedAt, spatialResolutionMeters: output.spatialResolutionMeters, crs: output.crs, format: output.format, byteSize: file.byteSize, checksum: file.checksum, artifactRef: `acquisitions/${context.runId}/${relativeDirectory}/${outputFileName}`, accessStatus: "retrieved" as const };
      })));
    }
    const assets = [...selectedAssetGroups.flat(), ...downloadedGroups.flat()];
    const qualitySummary = summarizeSceneQualities(selectedScenes, sceneQualities);
    const fieldCloudContaminated = this.source === "sentinel-2" && qualitySummary.contaminatedSceneCount > 0;
    const opticalQualityPending = this.source === "sentinel-2" && qualitySummary.pendingSceneCount > 0;
    const pairState = radarPairState(this.source, selectedScenes, requiresRadarPair(context.dataProfile));
    const sourceIsPartial = fieldCloudContaminated || opticalQualityPending || pairState.partial;
    return sourceResult({
      sourceType: this.sourceType,
      source: this.source,
      provider: "Copernicus Data Space STAC + Sentinel Hub Process API",
      product: this.product,
      status: sourceIsPartial ? "partial" : "succeeded",
      period: context.period,
      discoveredAt,
      retrievedAt: latestAssetRetrievedAt(assets),
      availableDates,
      selectedDates,
      assets,
      areaHa: context.field.areaHa,
      coverageFraction: selected.coverage,
      flags: [...(fieldCloudContaminated ? ["cloud_contaminated"] : []), ...(opticalQualityPending ? ["cloud_mask_unavailable"] : []), ...pairState.flags],
      metadata: {
        ...sentinelMetadata(this.source, selectedScenes, withCoverage.length, selectable.length, bestCloudCover),
        assetCount: assets.length, requiredSceneCount: this.source === "sentinel-1" && requiresRadarPair(context.dataProfile) ? 2 : 1, selectedSceneCount: selectedScenes.length,
        cloudAssessmentScope: this.source === "sentinel-2" ? "field_scl" : "not_applicable",
        fieldTotalPixelCount: qualitySummary.totalPixelCount,
        fieldValidPixelCount: qualitySummary.validPixelCount,
        fieldValidPixelFraction: qualitySummary.minimumValidPixelFraction,
        fieldCloudAffectedPixelCount: qualitySummary.cloudAffectedPixelCount,
        fieldCloudAffectedFraction: qualitySummary.maximumCloudAffectedFraction,
        fieldSclClassHistogram: qualitySummary.sclClassHistogram,
        fieldUsableSceneCount: qualitySummary.usableSceneCount,
        fieldCloudContaminatedSceneCount: qualitySummary.contaminatedSceneCount,
        fieldQualityPendingSceneCount: qualitySummary.pendingSceneCount,
        sceneQualityByDate: qualitySummary.sceneQualityByDate,
        cacheHit: missingScenes.length === 0, reusedFromRunId: cachedRuns[0] ?? null, reusedAssetCount: selectedAssetGroups.flat().length, downloadedAssetCount: downloadedGroups.flat().length,
      },
      limitations: [...(fieldCloudContaminated ? [`${qualitySummary.contaminatedSceneCount} 个光学日期的地块 SCL 有效像元低于 80%；资产仍保留，并在分析时逐日期判定。`] : []), ...(opticalQualityPending ? [`${qualitySummary.pendingSceneCount} 个光学日期缺少地块 SCL 质量摘要，不能作为完整光学证据。`] : []), ...pairState.limitations],
      error: fieldCloudContaminated ? { code: "cloud_contaminated", retryable: false, message: `${qualitySummary.contaminatedSceneCount} 个光学日期受云影响。` } : opticalQualityPending ? { code: "cloud_mask_unavailable", retryable: true, message: `${qualitySummary.pendingSceneCount} 个光学日期缺少地块 SCL 质量摘要。` } : pairState.error ?? { code: null, retryable: false, message: null },
      license: publicCopernicusLicense(true),
    });
  }
}

export class CopernicusDemProvider implements AcquisitionProvider {
  readonly source = "copernicus-dem" as const;
  constructor(private readonly downloader: CopernicusDemDownloader | null) {}

  async discover(context: AcquisitionContext): Promise<SourceAcquisitionResult> {
    const discoveredAt = new Date().toISOString();
    const gridIds = demGridIds(context.field.boundary);
    const dataset = "COP-DEM_GLO-30-DGED/2024_1";
    const products = await Promise.all(gridIds.map(async (gridId) => ({ gridId, product: await discoverDemProduct(dataset, gridId) })));
    const missingGridIds = products.filter((item) => !item.product).map((item) => item.gridId);
    if (missingGridIds.length > 0) {
      return sourceResult({
        sourceType: "terrain", source: this.source, provider: "Copernicus Data Space OData", product: "Copernicus DEM GLO-30",
        status: "partial", period: null, discoveredAt, areaHa: context.field.areaHa, flags: ["dem_incomplete"], metadata: { gridIds: gridIds.join(","), missingGridIds: missingGridIds.join(","), dataset },
        limitations: ["没有发现完整覆盖地块的 GLO-30 原生瓦片。"], error: { code: "dem_incomplete", retryable: false, message: "部分 DEM 瓦片未找到。" }, license: publicDemLicense(false),
      });
    }
    const availableProducts = products.map((item) => ({ gridId: item.gridId, product: item.product! }));
    const expectedProductIds = new Set(availableProducts.map(({ product }) => product.Id));
    const cached = await findReusableAssets(context, (result) => {
      if (result.source !== this.source || result.quality.metadata.dataset !== dataset) return null;
      const assets = result.selectedAssets.filter((asset) => expectedProductIds.has(asset.providerAssetId));
      return assets.length === expectedProductIds.size
        && new Set(assets.map((asset) => asset.providerAssetId)).size === expectedProductIds.size
        ? assets
        : null;
    });
    if (cached) {
      return sourceResult({
        sourceType: "terrain", source: this.source, provider: "Copernicus Data Space OData", product: "Copernicus DEM GLO-30",
        status: "succeeded", period: null, discoveredAt, retrievedAt: latestAssetRetrievedAt(cached.assets), assets: cached.assets,
        areaHa: context.field.areaHa, coverageFraction: 1, flags: [],
        metadata: {
          gridIds: gridIds.join(","), tileCount: cached.assets.length, dataset, resolutionMeters: 30,
          cacheHit: true, reusedFromRunId: cached.runId, reusedAssetCount: cached.assets.length, downloadedAssetCount: 0,
        },
        limitations: [], error: { code: null, retryable: false, message: null }, license: publicDemLicense(true),
      });
    }
    if (!this.downloader) {
      const assets: AcquiredAsset[] = availableProducts.map(({ product }) => ({
        id: randomUUID(), providerAssetId: product.Id, role: "dem", capturedAt: null, validFrom: null, validTo: null,
        generatedAt: product.PublicationDate ?? null, retrievedAt: null, spatialResolutionMeters: 30, crs: null, format: "GeoTIFF package",
        byteSize: numericValue(product.ContentLength), accessStatus: "discovered" as const, checksum: null, artifactRef: null,
      }));
      return sourceResult({
        sourceType: "terrain", source: this.source, provider: "Copernicus Data Space OData", product: "Copernicus DEM GLO-30",
        status: "needs_input", period: null, discoveredAt, assets, areaHa: context.field.areaHa, coverageFraction: 1,
        flags: ["asset_authorization_required"], metadata: { gridIds: gridIds.join(","), tileCount: assets.length, dataset, resolutionMeters: 30 },
        limitations: ["GLO-30 原生瓦片已定位；下载需要配置 CDSE_USERNAME 和 CDSE_PASSWORD，并具备 CCM 权限。"],
        error: { code: "provider_unauthorized", retryable: false, message: "请配置并授权 CDSE CCM 账户。" }, license: publicDemLicense(false),
      });
    }
    const retrievedAt = new Date().toISOString();
    const assets: AcquiredAsset[] = [];
    await context.reportProgress("downloading", `正在下载 ${availableProducts.length} 个 DEM 瓦片`);
    for (const { gridId, product } of availableProducts) {
      const fileName = `${gridId}_${safeFilePart(product.Id)}.tif`;
      const target = acquisitionArtifactPath(context.runId, "terrain/copernicus-dem", fileName);
      await this.downloader.retrieve({ providerAssetId: product.Id, boundary: context.field.boundary, target });
      await context.reportProgress("validating", `正在校验 DEM 瓦片 ${gridId}`);
      const file = await fileMetadata(target);
      assets.push({
        id: randomUUID(), providerAssetId: product.Id, role: "dem", capturedAt: null, validFrom: null, validTo: null,
        generatedAt: product.PublicationDate ?? null, retrievedAt, spatialResolutionMeters: 30, crs: null, format: "GeoTIFF",
        byteSize: file.byteSize, accessStatus: "retrieved", checksum: file.checksum,
        artifactRef: `acquisitions/${context.runId}/terrain/copernicus-dem/${fileName}`,
      });
    }
    return sourceResult({
      sourceType: "terrain", source: this.source, provider: "Copernicus Data Space OData", product: "Copernicus DEM GLO-30",
      status: "succeeded", period: null, discoveredAt, retrievedAt, assets, areaHa: context.field.areaHa,
      coverageFraction: 1, flags: [], metadata: { gridIds: gridIds.join(","), tileCount: assets.length, dataset, resolutionMeters: 30 },
      limitations: [], error: { code: null, retryable: false, message: null }, license: publicDemLicense(true),
    });
  }
}

const ERA5_LAND_VARIABLES = [
  "2m_temperature",
  "2m_dewpoint_temperature",
  "total_precipitation",
  "surface_solar_radiation_downwards",
  "potential_evaporation",
  "volumetric_soil_water_layer_1",
  "volumetric_soil_water_layer_2",
  "volumetric_soil_water_layer_3",
] as const;

const SOILGRIDS_EXPECTED_ASSET_COUNT = 144;

export interface Era5LandRequest {
  year: string;
  month: string;
  days: string[];
  area: [number, number, number, number];
}

export interface CdsDownloader {
  retrieve(request: Era5LandRequest, variables: readonly string[], target: string, apiKey: string): Promise<void>;
}

export class Era5LandProvider implements AcquisitionProvider {
  readonly source = "era5-land" as const;
  constructor(private readonly apiKey: string | null, private readonly downloader: CdsDownloader) {}

  async discover(context: AcquisitionContext): Promise<SourceAcquisitionResult> {
    const discoveredAt = new Date().toISOString();
    const catalogue = await fetchJson<CdsCollection>("https://cds.climate.copernicus.eu/api/catalogue/v1/collections/reanalysis-era5-land");
    const latestAvailable = cdsLatestAvailable(catalogue);
    const requestedEnd = new Date(context.period.end);
    if (!latestAvailable || latestAvailable < new Date(context.period.start)) {
      return sourceResult({
        sourceType: "weather-historical", source: this.source, provider: "Copernicus Climate Data Store", product: catalogue.title ?? "ERA5-Land hourly data",
        status: "partial", period: context.period, discoveredAt, areaHa: context.field.areaHa, flags: ["weather_incomplete"],
        metadata: { dataset: catalogue.id ?? "reanalysis-era5-land", latestAvailableDate: latestAvailable?.toISOString().slice(0, 10) ?? null, variableCount: ERA5_LAND_VARIABLES.length },
        limitations: ["请求时间窗口尚未进入 ERA5-Land 已发布范围，本次没有生成历史天气文件。"],
        error: { code: "weather_incomplete", retryable: true, message: "ERA5-Land 尚未发布该时间窗口的数据。" },
        license: { access: "public", downloadAllowed: true, attribution: "Copernicus Climate Change Service / ECMWF, CC BY 4.0" },
      });
    }
    const effectivePeriod = requestedEnd > latestAvailable ? { ...context.period, end: latestAvailable.toISOString() } : context.period;
    const requests = createEra5LandRequests(effectivePeriod, context.field.boundary);
    const artifactDirectory = resolve(import.meta.dirname, "../../../runtime/artifacts/acquisitions", context.runId, "weather");
    const assets: AcquiredAsset[] = [];
    const reusedFromRunIds = new Set<string>();
    let downloadedAssetCount = 0;
    let authorizationGap = false;
    const buildResult = (checkpoint: boolean): SourceAcquisitionResult => {
      const publicationIncomplete = requestedEnd > latestAvailable;
      const reusedAssetCount = assets.length - downloadedAssetCount;
      return sourceResult({
        sourceType: "weather-historical", source: this.source, provider: "Copernicus Climate Data Store", product: catalogue.title ?? "ERA5-Land hourly data",
        status: checkpoint || publicationIncomplete ? "partial" : "succeeded", period: context.period, discoveredAt,
        retrievedAt: latestAssetRetrievedAt(assets), assets: [...assets], areaHa: context.field.areaHa, coverageFraction: 1,
        flags: checkpoint || publicationIncomplete ? ["coarse_background", "weather_incomplete"] : ["coarse_background"],
        metadata: {
          dataset: catalogue.id ?? "reanalysis-era5-land", spatialSampling: "field_grid_window", gridResolutionDegrees: 0.1,
          variableCount: ERA5_LAND_VARIABLES.length, fileCount: assets.length, latestAvailableDate: latestAvailable.toISOString().slice(0, 10),
          cacheHit: reusedAssetCount > 0, reusedFromRunId: [...reusedFromRunIds].join(",") || null,
          reusedAssetCount, downloadedAssetCount,
        },
        limitations: checkpoint
          ? ["已保存完成月份，其余请求月份仍在获取。", "ERA5-Land 约 9 公里分辨率，只作为地块天气背景，不能表达田内微气候差异。"]
          : publicationIncomplete
            ? ["已下载 ERA5-Land 已发布部分；请求窗口末尾仍处于发布延迟期。", "ERA5-Land 约 9 公里分辨率，只作为地块天气背景，不能表达田内微气候差异。"]
            : ["ERA5-Land 约 9 公里分辨率，只作为地块天气背景，不能表达田内微气候差异。"],
        error: checkpoint
          ? { code: "weather_incomplete", retryable: true, message: "历史天气已完成部分月份，其余月份仍在获取。" }
          : publicationIncomplete
            ? { code: "weather_incomplete", retryable: true, message: "请求窗口末尾的 ERA5-Land 数据尚未发布。" }
            : { code: null, retryable: false, message: null },
        license: { access: "public", downloadAllowed: true, attribution: "Copernicus Climate Change Service / ECMWF, CC BY 4.0" },
      });
    };
    for (const [index, request] of requests.entries()) {
      const providerAssetId = `reanalysis-era5-land:${request.year}-${request.month}`;
      const requiredFrom = `${request.year}-${request.month}-${request.days[0]}T00:00:00.000Z`;
      const requiredTo = `${request.year}-${request.month}-${request.days.at(-1)}T23:00:00.000Z`;
      const cached = await findReusableAsset(context, (result, asset) =>
        result.source === this.source
        && result.quality.metadata.dataset === (catalogue.id ?? "reanalysis-era5-land")
        && asset.providerAssetId === providerAssetId
        && asset.validFrom !== null
        && asset.validTo !== null
        && asset.validFrom <= requiredFrom
        && asset.validTo >= requiredTo);
      if (cached) {
        assets.push(cached.asset);
        reusedFromRunIds.add(cached.runId);
        await context.reportProgress("downloading", `已复用 ${request.year}-${request.month} 历史天气文件`);
        await context.reportCheckpoint?.(buildResult(true));
        continue;
      }
      if (!this.apiKey) {
        // Preserve an overlapping cached month when the requested window extends
        // beyond its validity; only the uncovered portion needs authorization.
        const overlapping = await findReusableAsset(context, (result, asset) =>
          result.source === this.source
          && result.quality.metadata.dataset === (catalogue.id ?? "reanalysis-era5-land")
          && asset.providerAssetId === providerAssetId
          && asset.validFrom !== null
          && asset.validTo !== null
          && asset.validTo >= requiredFrom
          && asset.validFrom <= requiredTo);
        if (overlapping && !assets.some((asset) => asset.providerAssetId === overlapping.asset.providerAssetId)) {
          assets.push(overlapping.asset);
          reusedFromRunIds.add(overlapping.runId);
          await context.reportProgress("downloading", `已保留 ${request.year}-${request.month} 已有历史天气文件`);
          await context.reportCheckpoint?.(buildResult(true));
        }
        authorizationGap = true;
        continue;
      }
      const fileName = `era5-land_${request.year}-${request.month}.nc`;
      const target = resolve(artifactDirectory, fileName);
      await mkdir(artifactDirectory, { recursive: true });
      await context.reportProgress("downloading", `正在下载 ERA5-Land（${index + 1}/${requests.length}）`);
      await this.downloader.retrieve(request, ERA5_LAND_VARIABLES, target, this.apiKey);
      await context.reportProgress("validating", `正在校验 ${request.year}-${request.month} 天气文件`);
      const fileStat = await stat(target);
      const retrievedAt = new Date().toISOString();
      assets.push({
        id: randomUUID(), providerAssetId, role: "weather-series",
        capturedAt: null, validFrom: requiredFrom,
        validTo: requiredTo, generatedAt: null, retrievedAt,
        spatialResolutionMeters: 9000, crs: "EPSG:4326", format: "NetCDF", byteSize: fileStat.size,
        checksum: await sha256File(target), artifactRef: `acquisitions/${context.runId}/weather/${fileName}`, accessStatus: "retrieved",
      });
      downloadedAssetCount += 1;
      await context.reportCheckpoint?.(buildResult(true));
    }
    if (authorizationGap) {
      return sourceResult({
        sourceType: "weather-historical", source: this.source, provider: "Copernicus Climate Data Store", product: catalogue.title ?? "ERA5-Land hourly data",
        status: assets.length > 0 ? "partial" : "needs_input", period: context.period, discoveredAt,
        retrievedAt: latestAssetRetrievedAt(assets), assets, areaHa: context.field.areaHa, coverageFraction: assets.length > 0 ? 1 : null,
        flags: assets.length > 0 ? ["coarse_background", "weather_incomplete"] : ["asset_authorization_required"],
        metadata: { dataset: catalogue.id ?? "reanalysis-era5-land", gridResolutionDegrees: 0.1, variableCount: ERA5_LAND_VARIABLES.length, fileCount: assets.length, cacheHit: assets.length > 0, reusedFromRunId: [...reusedFromRunIds].join(",") || null, reusedAssetCount: assets.length, downloadedAssetCount: 0 },
        limitations: assets.length > 0
          ? ["已保留本地已有历史天气文件；请求窗口仍有日期缺少授权，未继续下载。", "ERA5-Land 约 9 公里分辨率，只作为地块天气背景，不能表达田内微气候差异。"]
          : ["ERA5-Land 目录可访问；下载需要配置 CDS_API_KEY 并接受数据集条款。"],
        error: assets.length > 0
          ? { code: "weather_incomplete", retryable: true, message: "历史天气已保留已有文件，其余请求日期需要 CDS_API_KEY。" }
          : { code: "provider_unauthorized", retryable: false, message: "请配置 CDS_API_KEY 并接受 ERA5-Land 数据集条款。" },
        license: { access: "public", downloadAllowed: assets.length > 0, attribution: "Copernicus Climate Change Service / ECMWF, CC BY 4.0" },
      });
    }
    return buildResult(false);
  }
}

class PythonCdsDownloader implements CdsDownloader {
  constructor(private readonly pythonExecutable: string) {}

  retrieve(request: Era5LandRequest, variables: readonly string[], target: string, apiKey: string): Promise<void> {
    const script = resolve(import.meta.dirname, "../scripts/download-era5-land.py");
    return new Promise((resolvePromise, reject) => {
      const child = spawn(this.pythonExecutable, [script, target], {
        env: { ...process.env, CDS_API_KEY: apiKey },
        stdio: ["pipe", "ignore", "pipe"],
        windowsHide: true,
      });
      let errorOutput = "";
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, 60 * 60_000);
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => { errorOutput = `${errorOutput}${chunk}`.slice(-4_000); });
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(new ProviderResponseError(503, `无法启动 CDS 下载器：${error.message}`));
      });
      child.once("close", (code, signal) => {
        clearTimeout(timeout);
        if (code === 0) return resolvePromise();
        if (timedOut || signal) return reject(new ProviderResponseError(504, "CDS 下载超过 60 分钟，已停止本次请求。"));
        const normalized = errorOutput.toLowerCase();
        if (normalized.includes("licence") || normalized.includes("license") || normalized.includes("terms of use")) {
          return reject(new ProviderResponseError(403, "CDS 账户尚未接受 ERA5-Land 数据集条款。"));
        }
        if (normalized.includes("401") || normalized.includes("unauthorized") || normalized.includes("invalid token")) {
          return reject(new ProviderResponseError(401, "CDS Personal Access Token 无效。"));
        }
        reject(new ProviderResponseError(503, "CDS 下载失败，请稍后重试。"));
      });
      child.stdin.end(JSON.stringify({ ...request, variables }));
    });
  }
}

interface CdsCollection {
  id?: string;
  title?: string;
  extent?: { temporal?: { interval?: Array<[string | null, string | null]> } };
}

function cdsLatestAvailable(collection: CdsCollection): Date | null {
  const value = collection.extent?.temporal?.interval?.[0]?.[1];
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function createEra5LandRequests(period: AcquisitionPeriod, boundary: Position[]): Era5LandRequest[] {
  const start = dateOnly(period.start);
  const end = dateOnly(period.end);
  const area = era5Area(boundary);
  const requests = new Map<string, Era5LandRequest>();
  for (let cursor = start; cursor <= end; cursor = addUtcDays(cursor, 1)) {
    const year = String(cursor.getUTCFullYear());
    const month = String(cursor.getUTCMonth() + 1).padStart(2, "0");
    const day = String(cursor.getUTCDate()).padStart(2, "0");
    const key = `${year}-${month}`;
    const request = requests.get(key) ?? { year, month, days: [], area };
    request.days.push(day);
    requests.set(key, request);
  }
  return [...requests.values()];
}

function dateOnly(value: string): Date {
  const parsed = new Date(value);
  return new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate()));
}

function addUtcDays(value: Date, days: number): Date {
  return new Date(value.getTime() + days * 86_400_000);
}

function era5Area(boundary: Position[]): [number, number, number, number] {
  const latitudes = boundary.map((point) => point.latitude);
  const longitudes = boundary.map((point) => point.longitude);
  const north = Math.ceil(Math.max(...latitudes) * 10) / 10;
  const west = Math.floor(Math.min(...longitudes) * 10) / 10;
  let south = Math.floor(Math.min(...latitudes) * 10) / 10;
  let east = Math.ceil(Math.max(...longitudes) * 10) / 10;
  if (south === north) south = Number((south - 0.1).toFixed(1));
  if (west === east) east = Number((east + 0.1).toFixed(1));
  return [north, west, south, east];
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return `sha256:${hash.digest("hex")}`;
}

export class EcmwfIfsProvider implements AcquisitionProvider {
  readonly source = "ecmwf-ifs" as const;
  constructor(private readonly downloader: IfsPointDownloader) {}

  async discover(context: AcquisitionContext): Promise<SourceAcquisitionResult> {
    const discoveredAt = new Date().toISOString();
    const modelRun = await discoverLatestIfsRun(context.now);
    if (!modelRun) {
      return sourceResult({
        sourceType: "weather-forecast", source: this.source, provider: "ECMWF Open Data", product: "IFS 0.25 degree forecast", status: "failed",
        period: context.period, discoveredAt, areaHa: context.field.areaHa, flags: ["forecast_model_unavailable"], metadata: { spatialSampling: "centroid", gridResolutionDegrees: 0.25 },
        limitations: ["没有发现可用的最新 IFS 模型批次。"], error: { code: "forecast_model_unavailable", retryable: true, message: "ECMWF 最新模型批次暂不可用。" },
        license: { access: "public", downloadAllowed: true, attribution: "ECMWF Open Data, CC BY 4.0" },
      });
    }
    const runDate = modelRun.runAt.slice(0, 10).replaceAll("-", "");
    const runHour = modelRun.runAt.slice(11, 13);
    const maximumHours = Number(runHour) === 0 || Number(runHour) === 12 ? 240 : 90;
    const validTo = new Date(new Date(modelRun.runAt).getTime() + maximumHours * 3_600_000).toISOString();
    const cached = await findReusableAsset(context, (result, asset) =>
      result.source === this.source
      && asset.providerAssetId === modelRun.assetId
      && asset.validFrom === modelRun.runAt
      && asset.validTo === validTo);
    if (cached) {
      return sourceResult({
        sourceType: "weather-forecast", source: this.source, provider: "ECMWF Open Data", product: "IFS 0.25 degree forecast", status: "succeeded",
        period: context.period, discoveredAt, retrievedAt: cached.asset.retrievedAt, availableDates: [modelRun.runAt.slice(0, 10)], selectedDates: [modelRun.runAt.slice(0, 10)],
        assets: [cached.asset], areaHa: context.field.areaHa, coverageFraction: 1, flags: ["coarse_background"],
        metadata: {
          modelRun: modelRun.runAt, spatialSampling: "nearest_centroid_grid", gridResolutionDegrees: 0.25, maxForecastHours: maximumHours,
          parameters: "2t,2d,10u,10v,tp,tcc,ssrd", cacheHit: true, reusedFromRunId: cached.runId, reusedAssetCount: 1, downloadedAssetCount: 0,
        },
        limitations: ["IFS 0.25°网格只表示地块附近预报背景，不能表达田内微气候差异。"], error: { code: null, retryable: false, message: null },
        license: { access: "public", downloadAllowed: true, attribution: "ECMWF Open Data, CC BY 4.0" },
      });
    }
    const fileName = `ifs_${runDate}_${runHour}z_${context.field.centroid.longitude.toFixed(4)}_${context.field.centroid.latitude.toFixed(4)}.json`;
    const target = acquisitionArtifactPath(context.runId, "weather/forecast/ecmwf-ifs", fileName);
    await mkdir(resolve(target, ".."), { recursive: true });
    await context.reportProgress("downloading", `正在下载 IFS ${modelRun.runAt.slice(0, 13)} 时次`);
    await this.downloader.retrieve({ runAt: modelRun.runAt, longitude: context.field.centroid.longitude, latitude: context.field.centroid.latitude, target });
    await context.reportProgress("validating", "正在校验天气预报文件");
    const file = await fileMetadata(target);
    const retrievedAt = new Date().toISOString();
    const asset: AcquiredAsset = {
      id: randomUUID(), providerAssetId: modelRun.assetId, role: "weather-series", capturedAt: null, validFrom: modelRun.runAt,
      validTo, generatedAt: modelRun.runAt, retrievedAt,
      spatialResolutionMeters: 27_750, crs: "EPSG:4326", format: "JSON point time series", byteSize: file.byteSize, accessStatus: "retrieved",
      checksum: file.checksum, artifactRef: `acquisitions/${context.runId}/weather/forecast/ecmwf-ifs/${fileName}`,
    };
    return sourceResult({
      sourceType: "weather-forecast", source: this.source, provider: "ECMWF Open Data", product: "IFS 0.25 degree forecast", status: "succeeded",
      period: context.period, discoveredAt, retrievedAt, availableDates: [modelRun.runAt.slice(0, 10)], selectedDates: [modelRun.runAt.slice(0, 10)], assets: [asset], areaHa: context.field.areaHa,
      coverageFraction: 1, flags: ["coarse_background"], metadata: { modelRun: modelRun.runAt, spatialSampling: "nearest_centroid_grid", gridResolutionDegrees: 0.25, maxForecastHours: maximumHours, parameters: "2t,2d,10u,10v,tp,tcc,ssrd" },
      limitations: ["IFS 0.25°网格只表示地块附近预报背景，不能表达田内微气候差异。"], error: { code: null, retryable: false, message: null },
      license: { access: "public", downloadAllowed: true, attribution: "ECMWF Open Data, CC BY 4.0" },
    });
  }
}

export class SoilGridsProvider implements AcquisitionProvider {
  readonly source = "soilgrids-250m" as const;
  constructor(private readonly downloader: SoilGridsDownloader) {}

  async discover(context: AcquisitionContext): Promise<SourceAcquisitionResult> {
    const discoveredAt = new Date().toISOString();
    const url = new URL("https://maps.isric.org/mapserv");
    url.searchParams.set("map", "/map/nitrogen.map");
    url.searchParams.set("SERVICE", "WCS");
    url.searchParams.set("VERSION", "2.0.1");
    url.searchParams.set("REQUEST", "DescribeCoverage");
    url.searchParams.set("COVERAGEID", "nitrogen_5-15cm_Q0.5");
    const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!response.ok) throw new ProviderResponseError(response.status, "SoilGrids WCS 元数据请求失败。");
    await response.arrayBuffer();
    const cached = await findReusableAssets(context, (result) => {
      if (result.source !== this.source || result.product !== "SoilGrids 250m 2.0" || result.quality.metadata.version !== "2.0") return null;
      const assets = result.selectedAssets.filter((asset) => asset.role === "soil");
      return assets.length === SOILGRIDS_EXPECTED_ASSET_COUNT
        && new Set(assets.map((asset) => asset.providerAssetId)).size === SOILGRIDS_EXPECTED_ASSET_COUNT
        ? assets
        : null;
    });
    if (cached) {
      return sourceResult({
        sourceType: "soil", source: this.source, provider: "ISRIC SoilGrids WCS", product: "SoilGrids 250m 2.0", status: "succeeded", period: null,
        discoveredAt, retrievedAt: latestAssetRetrievedAt(cached.assets), assets: cached.assets, areaHa: context.field.areaHa, coverageFraction: 1,
        flags: ["coarse_background"],
        metadata: {
          version: "2.0", resolutionMeters: 250, propertyCount: 8, depthLayers: 6, quantileLayers: 3,
          fileCount: cached.assets.length, spatialRole: "background", cacheHit: true, reusedFromRunId: cached.runId,
          reusedAssetCount: cached.assets.length, downloadedAssetCount: 0,
        },
        limitations: ["SoilGrids 250 米数据只作为土壤背景，不能表示地块化验或田内精细养分差异。"],
        error: { code: null, retryable: false, message: null },
        license: { access: "public", downloadAllowed: true, attribution: "SoilGrids by ISRIC, CC BY 4.0" },
      });
    }
    const relativeDirectory = "soil/soilgrids-250m";
    const targetDirectory = acquisitionArtifactPath(context.runId, relativeDirectory);
    await mkdir(targetDirectory, { recursive: true });
    await context.reportProgress("downloading", "正在裁取 SoilGrids 土壤栅格");
    const files = await this.downloader.retrieve({ boundary: context.field.boundary, targetDirectory });
    await context.reportProgress("validating", `正在校验 ${files.length} 个土壤文件`);
    const retrievedAt = new Date().toISOString();
    const assets: AcquiredAsset[] = await Promise.all(files.map(async (file) => {
      const metadata = await fileMetadata(resolve(targetDirectory, file.fileName));
      return {
        id: randomUUID(), providerAssetId: file.providerAssetId, role: "soil", capturedAt: null, validFrom: null, validTo: null,
        generatedAt: null, retrievedAt, spatialResolutionMeters: file.spatialResolutionMeters, crs: file.crs, format: "GeoTIFF",
        byteSize: metadata.byteSize, checksum: metadata.checksum, artifactRef: `acquisitions/${context.runId}/${relativeDirectory}/${file.fileName}`, accessStatus: "retrieved",
      };
    }));
    return sourceResult({
      sourceType: "soil", source: this.source, provider: "ISRIC SoilGrids WCS", product: "SoilGrids 250m 2.0", status: "succeeded", period: null,
      discoveredAt, retrievedAt, assets, areaHa: context.field.areaHa, coverageFraction: 1, flags: ["coarse_background"],
      metadata: { version: "2.0", resolutionMeters: 250, propertyCount: 8, depthLayers: 6, quantileLayers: 3, fileCount: assets.length, spatialRole: "background" },
      limitations: ["SoilGrids 250 米数据只作为土壤背景，不能表示地块化验或田内精细养分差异。"],
      error: { code: null, retryable: false, message: null },
      license: { access: "public", downloadAllowed: true, attribution: "SoilGrids by ISRIC, CC BY 4.0" },
    });
  }
}

interface SourceResultInput {
  sourceType: SourceAcquisitionResult["sourceType"];
  source: DataSource;
  provider: string;
  product: string;
  status: SourceAcquisitionResult["status"];
  period: AcquisitionPeriod | null;
  discoveredAt: string;
  retrievedAt?: string | null;
  availableDates?: string[];
  selectedDates?: string[];
  assets?: AcquiredAsset[];
  areaHa: number | null;
  coverageFraction?: number | null;
  flags: string[];
  metadata: Record<string, string | number | boolean | null>;
  limitations: string[];
  error: SourceAcquisitionResult["error"];
  license: SourceAcquisitionResult["license"];
}

function sourceResult(input: SourceResultInput): SourceAcquisitionResult {
  return {
    sourceType: input.sourceType,
    source: input.source,
    provider: input.provider,
    product: input.product,
    status: input.status,
    requestedPeriod: input.period,
    discoveredAt: input.discoveredAt,
    retrievedAt: input.retrievedAt ?? null,
    availableDates: input.availableDates ?? [],
    selectedObservationDates: input.selectedDates ?? [],
    selectedAssets: input.assets ?? [],
    coverage: { requestedAreaHa: input.areaHa, coveredAreaFraction: input.coverageFraction ?? null },
    quality: { flags: input.flags, metadata: input.metadata },
    license: input.license,
    limitations: input.limitations,
    error: input.error,
  };
}

function sourceCompletionMessage(result: SourceAcquisitionResult): string {
  if (result.quality.metadata.cacheHit === true) {
    const reused = typeof result.quality.metadata.reusedAssetCount === "number" ? result.quality.metadata.reusedAssetCount : result.selectedAssets.length;
    const downloaded = typeof result.quality.metadata.downloadedAssetCount === "number" ? result.quality.metadata.downloadedAssetCount : 0;
    return downloaded > 0 ? `已复用 ${reused} 个已有文件，另下载 ${downloaded} 个文件` : `已复用 ${reused} 个已有文件`;
  }
  if (result.status === "succeeded") return result.selectedAssets.length > 0 ? `已完成，登记 ${result.selectedAssets.length} 个文件` : "已完成数据检查";
  if (result.status === "partial") return result.error.message ?? "部分数据可用";
  if (result.status === "needs_input") return result.error.message ?? "需要补充访问权限";
  return result.error.message ?? "获取失败";
}

function sentinelMetadata(
  source: "sentinel-1" | "sentinel-2",
  selected: NormalizedStacFeature[],
  candidateSceneCount: number,
  usableSceneCount: number,
  bestCloudCover: number | null,
): SourceResultInput["metadata"] {
  const first = selected[0] ?? null;
  const orbitDirections = [...new Set(selected.map((scene) => scene.orbitDirection).filter((value): value is NonNullable<typeof value> => value !== null))];
  const relativeOrbits = [...new Set(selected.map((scene) => scene.relativeOrbitNumber).filter((value): value is number => value !== null))];
  return {
    candidateSceneCount,
    usableSceneCount,
    cloudCoverPercent: first?.cloudCover ?? null,
    bestCloudCover,
    coverageThresholdPercent: 95,
    configuredBands: (source === "sentinel-2" ? SENTINEL_2_BANDS : SENTINEL_1_BANDS).join(","),
    acquisitionMode: first?.acquisitionMode ?? null,
    polarizations: first?.polarizations.join(",") ?? "",
    orbitDirection: orbitDirections.join(",") || null,
    relativeOrbitNumber: relativeOrbits.length === 1 ? relativeOrbits[0]! : relativeOrbits.join(",") || null,
    selectedSceneIds: selected.map((scene) => scene.id).join(","),
    selectedSceneDates: selected.map((scene) => scene.capturedAt.slice(0, 10)).join(","),
    observationGapDays: selected.length >= 2 ? Number(daysBetween(selected[0]!.capturedAt, selected[1]!.capturedAt).toFixed(1)) : null,
  };
}

function selectSentinelScenes<T extends NormalizedStacFeature>(
  source: "sentinel-1" | "sentinel-2",
  dataProfile: DataProfile | undefined,
  candidates: T[],
): T[] {
  if (source === "sentinel-2") {
    const dates = new Set<string>();
    return candidates.filter((candidate) => {
      const date = candidate.capturedAt.slice(0, 10);
      if (dates.has(date)) return false;
      dates.add(date);
      return true;
    }).slice(0, MAX_OPTICAL_SCENES_PER_RUN);
  }
  if (!requiresRadarPair(dataProfile)) return candidates.slice(0, 1);
  const groups = new Map<string, T[]>();
  for (const candidate of candidates) {
    if (!candidate.orbitDirection || candidate.relativeOrbitNumber === null) continue;
    const key = `${candidate.orbitDirection}:${candidate.relativeOrbitNumber}`;
    groups.set(key, [...(groups.get(key) ?? []), candidate]);
  }
  const pairs = [...groups.values()].flatMap((items) => {
    const sorted = [...items].sort((left, right) => left.capturedAt.localeCompare(right.capturedAt));
    return sorted.slice(1).map((after, index) => ({ before: sorted[index]!, after, gap: daysBetween(sorted[index]!.capturedAt, after.capturedAt) }));
  });
  const withinWindow = pairs.filter((pair) => pair.gap <= 24).sort((left, right) => right.after.capturedAt.localeCompare(left.after.capturedAt));
  const selected = (withinWindow[0] ?? [...pairs].sort((left, right) => right.after.capturedAt.localeCompare(left.after.capturedAt))[0]);
  return selected ? [selected.before, selected.after] : candidates.slice(0, 1);
}

function cachedSceneQuality(result: SourceAcquisitionResult, capturedAt: string): RasterPixelQuality | null {
  const date = capturedAt.slice(0, 10);
  const sceneQuality = parseSceneQualityMap(result.quality.metadata.sceneQualityByDate)[date];
  if (sceneQuality) return sceneQuality;
  const metadata = result.quality.metadata;
  if (typeof metadata.fieldValidPixelFraction !== "number" || typeof metadata.fieldCloudAffectedFraction !== "number") return null;
  return {
    totalPixelCount: numberMetadata(metadata.fieldTotalPixelCount),
    validPixelCount: numberMetadata(metadata.fieldValidPixelCount),
    validPixelFraction: metadata.fieldValidPixelFraction,
    cloudAffectedPixelCount: numberMetadata(metadata.fieldCloudAffectedPixelCount),
    cloudAffectedFraction: metadata.fieldCloudAffectedFraction,
    sclClassHistogram: parseHistogram(metadata.fieldSclClassHistogram),
  };
}

function summarizeSceneQualities(selected: NormalizedStacFeature[], qualities: Map<string, RasterPixelQuality>) {
  const byDate = Object.fromEntries(selected.flatMap((scene) => {
    const quality = qualities.get(scene.capturedAt);
    return quality ? [[scene.capturedAt.slice(0, 10), quality]] : [];
  }));
  const values = Object.values(byDate);
  const histogram = values.reduce<Record<string, number>>((sum, quality) => {
    for (const [key, value] of Object.entries(quality.sclClassHistogram)) sum[key] = (sum[key] ?? 0) + value;
    return sum;
  }, {});
  return {
    totalPixelCount: values.length ? values.reduce((sum, quality) => sum + quality.totalPixelCount, 0) : null,
    validPixelCount: values.length ? values.reduce((sum, quality) => sum + quality.validPixelCount, 0) : null,
    minimumValidPixelFraction: values.length ? Math.min(...values.map((quality) => quality.validPixelFraction)) : null,
    cloudAffectedPixelCount: values.length ? values.reduce((sum, quality) => sum + quality.cloudAffectedPixelCount, 0) : null,
    maximumCloudAffectedFraction: values.length ? Math.max(...values.map((quality) => quality.cloudAffectedFraction)) : null,
    sclClassHistogram: values.length ? JSON.stringify(histogram) : null,
    usableSceneCount: values.filter((quality) => quality.validPixelFraction >= 0.8).length,
    contaminatedSceneCount: values.filter((quality) => quality.validPixelFraction < 0.8).length,
    pendingSceneCount: Math.max(0, selected.length - values.length),
    sceneQualityByDate: values.length ? JSON.stringify(byDate) : null,
  };
}

function parseSceneQualityMap(value: unknown): Record<string, RasterPixelQuality> {
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as Record<string, Partial<RasterPixelQuality>>;
    return Object.fromEntries(Object.entries(parsed).flatMap(([date, quality]) => typeof quality.validPixelFraction === "number" && typeof quality.cloudAffectedFraction === "number"
      ? [[date, {
        totalPixelCount: numberMetadata(quality.totalPixelCount),
        validPixelCount: numberMetadata(quality.validPixelCount),
        validPixelFraction: quality.validPixelFraction,
        cloudAffectedPixelCount: numberMetadata(quality.cloudAffectedPixelCount),
        cloudAffectedFraction: quality.cloudAffectedFraction,
        sclClassHistogram: quality.sclClassHistogram && typeof quality.sclClassHistogram === "object" ? quality.sclClassHistogram : {},
      }]]
      : []));
  } catch {
    return {};
  }
}

function parseHistogram(value: unknown): Record<string, number> {
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, number] => typeof entry[1] === "number"));
  } catch {
    return {};
  }
}

function numberMetadata(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function radarPairState(source: "sentinel-1" | "sentinel-2", selected: NormalizedStacFeature[], required: boolean): { partial: boolean; flags: string[]; limitations: string[]; error: SourceResultInput["error"] | null } {
  if (source !== "sentinel-1" || !required) return { partial: false, flags: [], limitations: [], error: null };
  if (selected.length < 2) return { partial: true, flags: ["radar_pair_unavailable"], limitations: ["当前采集只找到一景同轨雷达观测，积水识别需要灾前和灾后两期影像。"], error: { code: "radar_pair_unavailable", retryable: true, message: "缺少可比的同轨雷达前后时相。" } };
  const gap = daysBetween(selected[0]!.capturedAt, selected[1]!.capturedAt);
  if (gap > 24) return { partial: true, flags: ["radar_pair_interval_exceeded"], limitations: [`两期同轨雷达观测间隔 ${gap.toFixed(1)} 天，超过 24 天积水变化分析窗口。影像已保留，当前不能据此确认积水。`], error: { code: "radar_pair_interval_exceeded", retryable: true, message: "同轨雷达前后时相间隔超过 24 天。" } };
  return { partial: false, flags: [], limitations: [], error: null };
}

function requiresRadarPair(dataProfile: DataProfile | undefined): boolean {
  return dataProfile === "waterlogging_v1" || dataProfile === "water_nitrogen_v1";
}

function daysBetween(left: string, right: string): number {
  return Math.abs(Date.parse(right) - Date.parse(left)) / 86_400_000;
}

function acquisitionArtifactPath(runId: string, ...parts: string[]): string {
  return resolve(import.meta.dirname, "../../../runtime/artifacts/acquisitions", runId, ...parts);
}

interface ReusableAssets {
  runId: string;
  result: SourceAcquisitionResult;
  assets: AcquiredAsset[];
}

async function findReusableAssets(
  context: AcquisitionContext,
  select: (result: SourceAcquisitionResult) => AcquiredAsset[] | null,
): Promise<ReusableAssets | null> {
  for (const cached of context.cachedResults ?? []) {
    const assets = select(cached.result);
    if (!assets || assets.length === 0) continue;
    if (await everyAssetAvailable(assets)) {
      return { runId: cached.runId, result: cached.result, assets: structuredClone(assets) };
    }
  }
  return null;
}

async function findReusableAsset(
  context: AcquisitionContext,
  matches: (result: SourceAcquisitionResult, asset: AcquiredAsset) => boolean,
): Promise<{ runId: string; result: SourceAcquisitionResult; asset: AcquiredAsset } | null> {
  for (const cached of context.cachedResults ?? []) {
    for (const asset of cached.result.selectedAssets) {
      if (matches(cached.result, asset) && await assetIsAvailable(asset)) {
        return { runId: cached.runId, result: cached.result, asset: structuredClone(asset) };
      }
    }
  }
  return null;
}

async function everyAssetAvailable(assets: AcquiredAsset[]): Promise<boolean> {
  const available = await Promise.all(assets.map(assetIsAvailable));
  return available.every(Boolean);
}

async function assetIsAvailable(asset: AcquiredAsset): Promise<boolean> {
  if (asset.accessStatus !== "retrieved" || !asset.checksum || !asset.artifactRef) return false;
  const path = resolveAcquisitionArtifact(asset.artifactRef);
  if (!path) return false;
  try {
    const file = await stat(path);
    return file.isFile() && file.size > 0;
  } catch {
    return false;
  }
}

export function resolveAcquisitionArtifact(artifactRef: string): string | null {
  const root = resolve(import.meta.dirname, "../../../runtime/artifacts");
  const path = resolve(root, artifactRef);
  const relativePath = relative(root, path);
  if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) return null;
  return path;
}

function latestAssetRetrievedAt(assets: AcquiredAsset[]): string | null {
  return assets.map((asset) => asset.retrievedAt).filter((value): value is string => value !== null).sort().at(-1) ?? null;
}

function safeFilePart(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
}

function unavailableProviderResult(source: DataSource, field: FieldSummary, period: AcquisitionPeriod, now: Date): SourceAcquisitionResult {
  const metadata = sourceMetadata(source);
  return sourceResult({ ...metadata, source, status: "failed", period, discoveredAt: now.toISOString(), areaHa: field.areaHa, flags: ["provider_unavailable"], metadata: {}, limitations: ["当前运行环境没有注册该数据来源。"], error: { code: "provider_unavailable", retryable: false, message: "数据来源未注册。" }, license: { access: "unknown", downloadAllowed: false, attribution: null } });
}

function failedProviderResult(source: DataSource, field: FieldSummary, period: AcquisitionPeriod, now: Date, error: unknown): SourceAcquisitionResult {
  const metadata = sourceMetadata(source);
  const statusCode = error instanceof ProviderResponseError || error instanceof DownloadError ? error.status : null;
  const code = providerFailureCode(source, statusCode);
  const message = providerFailureMessage(source, code);
  return sourceResult({ ...metadata, source, status: code === "provider_unauthorized" ? "needs_input" : "failed", period, discoveredAt: now.toISOString(), areaHa: field.areaHa, flags: [code], metadata: { httpStatus: statusCode }, limitations: ["本次没有取得该来源的可用目录结果。"], error: { code, retryable: code !== "provider_unauthorized", message }, license: { access: "unknown", downloadAllowed: false, attribution: null } });
}

function providerFailureMessage(source: DataSource, code: string): string {
  if (code === "provider_rate_limited") return "数据服务请求较多，可稍后重试。";
  if (code === "provider_unauthorized") return "数据来源尚未授权。";
  if (code === "asset_integrity_failed") return "下载文件校验失败，可重新采集。";
  if (source === "ecmwf-ifs") return "天气预报下载失败，可稍后重试。";
  if (source === "soilgrids-250m") return "土壤背景下载失败，可稍后重试。";
  if (source === "sentinel-2") return "光学影像获取失败，可稍后重试。";
  if (source === "sentinel-1") return "雷达影像获取失败，可稍后重试。";
  if (source === "copernicus-dem") return "地形数据获取失败，可稍后重试。";
  return "外部数据服务暂不可用。";
}

function providerFailureCode(source: DataSource, statusCode: number | null): string {
  if (statusCode === 429) return "provider_rate_limited";
  if (statusCode === 401 || statusCode === 403) return "provider_unauthorized";
  if (statusCode === 502) return "asset_integrity_failed";
  if (source === "soilgrids-250m") return "soil_service_unavailable";
  if (source === "ecmwf-ifs") return "forecast_model_unavailable";
  if (source === "copernicus-dem" && statusCode === 404) return "dem_incomplete";
  return "provider_unavailable";
}

function sourceMetadata(source: DataSource): Pick<SourceResultInput, "sourceType" | "provider" | "product"> {
  switch (source) {
    case "sentinel-2": return { sourceType: "optical", provider: "Copernicus Data Space STAC", product: "Sentinel-2 Level-2A" };
    case "sentinel-1": return { sourceType: "radar", provider: "Copernicus Data Space STAC", product: "Sentinel-1 IW GRD" };
    case "copernicus-dem": return { sourceType: "terrain", provider: "Copernicus Data Space OData", product: "Copernicus DEM GLO-30" };
    case "era5-land": return { sourceType: "weather-historical", provider: "Copernicus Climate Data Store", product: "ERA5-Land hourly data" };
    case "ecmwf-ifs": return { sourceType: "weather-forecast", provider: "ECMWF Open Data", product: "IFS 0.25 degree forecast" };
    case "soilgrids-250m": return { sourceType: "soil", provider: "ISRIC SoilGrids WCS", product: "SoilGrids 250m 2.0" };
  }
}

function runStatus(sources: SourceAcquisitionResult[]): DataAcquisitionRun["status"] {
  if (sources.every((source) => source.status === "succeeded")) return "completed";
  if (sources.every((source) => source.status === "failed")) return "failed";
  if (sources.every((source) => source.status === "needs_input" || source.status === "failed") && sources.some((source) => source.status === "needs_input")) return "needs_input";
  return "partial";
}

const DATE_MATCH_SOURCES: DataSource[] = ["sentinel-2", "sentinel-1", "copernicus-dem", "era5-land", "ecmwf-ifs", "soilgrids-250m"];

export function matchAcquisitionDate(runs: DataAcquisitionRun[], targetDate: string): AcquisitionDateMatch[] {
  const target = dateAtUtcNoon(targetDate);
  return DATE_MATCH_SOURCES.map((source) => {
    const results = runs.flatMap((run) => {
      const result = run.sources.find((item) => item.source === source);
      return result ? [{ run, result }] : [];
    });
    if (source === "copernicus-dem" || source === "soilgrids-250m") return matchStaticSource(source, targetDate, results);
    if (source === "era5-land" || source === "ecmwf-ifs") return matchTemporalCoverage(source, targetDate, target, results);
    return matchNearestObservation(source, targetDate, target, results);
  });
}

function matchNearestObservation(source: "sentinel-1" | "sentinel-2", targetDate: string, target: Date, results: Array<{ run: DataAcquisitionRun; result: SourceAcquisitionResult }>): AcquisitionDateMatch {
  const maximumOffsetDays = source === "sentinel-1" ? 7 : 10;
  const candidates = results.flatMap(({ run, result }) => [...new Set([...result.availableDates, ...result.selectedObservationDates])].map((date) => ({ run, result, date, offsetDays: dayDifference(dateAtUtcNoon(date), target) })));
  candidates.sort((left, right) => Math.abs(left.offsetDays) - Math.abs(right.offsetDays) || right.date.localeCompare(left.date));
  const selected = candidates[0];
  if (!selected || Math.abs(selected.offsetDays) > maximumOffsetDays) return unmatchedDate(source, targetDate, `目标日前后 ${maximumOffsetDays} 天内没有发现影像。`);
  const retrieved = selected.result.selectedAssets.some((asset) => asset.accessStatus === "retrieved" && asset.capturedAt?.slice(0, 10) === selected.date);
  const limited = retrieved && selected.result.status === "partial";
  return {
    source, targetDate, matchType: "nearest", matchedDate: selected.date, validPeriod: null, offsetDays: selected.offsetDays,
    status: limited ? "limited" : retrieved ? "retrieved" : selected.result.status === "failed" ? "failed" : "available",
    runId: selected.run.id,
    detail: limited ? selected.result.error.message ?? "数据质量受限。" : retrieved ? "最近影像已下载。" : "已发现最近影像，尚未下载到本地。",
  };
}

function matchTemporalCoverage(source: "era5-land" | "ecmwf-ifs", targetDate: string, target: Date, results: Array<{ run: DataAcquisitionRun; result: SourceAcquisitionResult }>): AcquisitionDateMatch {
  const candidates = results.flatMap(({ run, result }) => result.selectedAssets.flatMap((asset) => {
    if (!asset.validFrom || !asset.validTo) return [];
    const start = new Date(asset.validFrom);
    const end = new Date(asset.validTo);
    return target >= start && target <= end ? [{ run, result, asset }] : [];
  }));
  const selected = candidates.sort((left, right) => right.run.createdAt.localeCompare(left.run.createdAt))[0];
  if (!selected && source === "era5-land") {
    const nearest = results.flatMap(({ run, result }) => result.selectedAssets.flatMap((asset) => {
      if (asset.accessStatus !== "retrieved" || !asset.validFrom || !asset.validTo) return [];
      const startDate = asset.validFrom.slice(0, 10);
      const endDate = asset.validTo.slice(0, 10);
      const matchedDate = target < new Date(asset.validFrom) ? startDate : endDate;
      return [{ run, asset, matchedDate, offsetDays: dayDifference(dateAtUtcNoon(matchedDate), target) }];
    })).sort((left, right) => Math.abs(left.offsetDays) - Math.abs(right.offsetDays) || right.run.createdAt.localeCompare(left.run.createdAt))[0];
    if (nearest) {
      return {
        source, targetDate, matchType: "nearest", matchedDate: nearest.matchedDate,
        validPeriod: { start: nearest.asset.validFrom!, end: nearest.asset.validTo! }, offsetDays: nearest.offsetDays,
        status: "retrieved", runId: nearest.run.id,
        detail: `目标日尚无 ERA5-Land 数据，最近已下载历史天气截至 ${nearest.matchedDate}。`,
      };
    }
  }
  if (!selected) return unmatchedDate(source, targetDate, source === "era5-land" ? "尚未取得可用的历史天气文件。" : "没有覆盖目标日的天气预报。" );
  const retrieved = selected.asset.accessStatus === "retrieved";
  const limited = retrieved && selected.result.status === "partial";
  return {
    source, targetDate, matchType: "covering", matchedDate: source === "ecmwf-ifs" ? selected.asset.generatedAt?.slice(0, 10) ?? null : targetDate,
    validPeriod: { start: selected.asset.validFrom!, end: selected.asset.validTo! }, offsetDays: 0,
    status: limited ? "limited" : retrieved ? "retrieved" : "available", runId: selected.run.id,
    detail: limited ? selected.result.error.message ?? "数据范围不完整。" : source === "era5-land" ? "历史天气文件覆盖目标日。" : "该预报批次有效期覆盖目标日。",
  };
}

function matchStaticSource(source: "copernicus-dem" | "soilgrids-250m", targetDate: string, results: Array<{ run: DataAcquisitionRun; result: SourceAcquisitionResult }>): AcquisitionDateMatch {
  const selected = results.find(({ result }) => result.selectedAssets.some((asset) => asset.accessStatus === "retrieved")) ?? results[0];
  if (!selected) return unmatchedDate(source, targetDate, "尚未登记静态数据版本。");
  const retrieved = selected.result.selectedAssets.some((asset) => asset.accessStatus === "retrieved");
  return {
    source, targetDate, matchType: "static", matchedDate: null, validPeriod: null, offsetDays: null,
    status: retrieved ? selected.result.status === "partial" ? "limited" : "retrieved" : selected.result.status === "failed" ? "failed" : "available",
    runId: selected.run.id,
    detail: source === "copernicus-dem" ? `静态地形版本：${String(selected.result.quality.metadata.dataset ?? selected.result.product)}` : `静态土壤版本：${String(selected.result.quality.metadata.version ?? selected.result.product)}`,
  };
}

function unmatchedDate(source: DataSource, targetDate: string, detail: string): AcquisitionDateMatch {
  return { source, targetDate, matchType: "none", matchedDate: null, validPeriod: null, offsetDays: null, status: "unavailable", runId: null, detail };
}

function dateAtUtcNoon(value: string): Date { return new Date(`${value.slice(0, 10)}T12:00:00.000Z`); }
function dayDifference(left: Date, right: Date): number { return Math.round((left.getTime() - right.getTime()) / 86_400_000); }

function publicCopernicusLicense(downloadAllowed: boolean): SourceAcquisitionResult["license"] {
  return { access: "public", downloadAllowed, attribution: "Copernicus Sentinel data, European Union" };
}

function publicDemLicense(downloadAllowed: boolean): SourceAcquisitionResult["license"] {
  return { access: "licensed", downloadAllowed, attribution: "Copernicus DEM, European Union" };
}

async function fetchJson<T>(input: string | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) throw new ProviderResponseError(response.status, `外部数据目录请求失败（HTTP ${response.status}）。`);
  return await response.json() as T;
}

class ProviderResponseError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

interface StacSearchResponse { features: StacFeature[]; }
interface StacFeature {
  id?: string;
  geometry?: GeoJsonGeometry | null;
  assets?: Record<string, StacAsset>;
  properties?: Record<string, unknown>;
}
interface StacAsset {
  href?: string;
  type?: string;
  gsd?: number;
  "proj:code"?: string;
  "file:size"?: number;
  roles?: string[];
}
type GeoJsonGeometry = { type: "Polygon"; coordinates: unknown } | { type: "MultiPolygon"; coordinates: unknown };
interface NormalizedStacFeature {
  id: string;
  capturedAt: string;
  generatedAt: string | null;
  cloudCover: number | null;
  geometry: number[][][][];
  resolution: number | null;
  crs: string | null;
  format: string;
  byteSize: number | null;
  acquisitionMode: string | null;
  polarizations: string[];
  orbitDirection: "ASCENDING" | "DESCENDING" | null;
  relativeOrbitNumber: number | null;
}

function normalizeStacFeature(feature: StacFeature): NormalizedStacFeature | null {
  const properties = feature.properties ?? {};
  const capturedAt = stringValue(properties.datetime) ?? stringValue(properties.start_datetime);
  const geometry = normalizeGeometry(feature.geometry);
  if (!feature.id || !capturedAt || !geometry) return null;
  const preferredAsset = Object.values(feature.assets ?? {}).find((asset) => asset.roles?.includes("data")) ?? Object.values(feature.assets ?? {})[0];
  return {
    id: feature.id,
    capturedAt,
    generatedAt: stringValue(properties.created) ?? stringValue(properties.published) ?? null,
    cloudCover: numericValue(properties["eo:cloud_cover"]),
    geometry,
    resolution: numericValue(preferredAsset?.gsd) ?? numericValue(properties.gsd),
    crs: preferredAsset?.["proj:code"] ?? null,
    format: preferredAsset?.type ?? "remote asset",
    byteSize: numericValue(preferredAsset?.["file:size"]),
    acquisitionMode: stringValue(properties["sar:instrument_mode"]),
    polarizations: Array.isArray(properties["sar:polarizations"])
      ? properties["sar:polarizations"].filter((value): value is string => typeof value === "string").map((value) => value.toUpperCase())
      : [],
    orbitDirection: normalizeOrbitDirection(properties["sat:orbit_state"]),
    relativeOrbitNumber: numericValue(properties["sat:relative_orbit"]),
  };
}

function normalizeOrbitDirection(value: unknown): "ASCENDING" | "DESCENDING" | null {
  if (typeof value !== "string") return null;
  const normalized = value.toUpperCase();
  return normalized === "ASCENDING" || normalized === "DESCENDING" ? normalized : null;
}

function normalizeGeometry(geometry: GeoJsonGeometry | null | undefined): number[][][][] | null {
  if (!geometry || !Array.isArray(geometry.coordinates)) return null;
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  const normalized: number[][][][] = [];
  for (const polygon of polygons) {
    if (!Array.isArray(polygon)) continue;
    const rings: number[][][] = [];
    for (const ring of polygon) {
      if (!Array.isArray(ring)) continue;
      const points = ring.map((point) => Array.isArray(point) && point.length >= 2 ? [Number(point[0]), Number(point[1])] : null).filter((point): point is number[] => point !== null && point.every(Number.isFinite));
      if (points.length >= 4) rings.push(points);
    }
    if (rings.length > 0) normalized.push(rings);
  }
  return normalized.length > 0 ? normalized : null;
}

function fieldCoverage(boundary: Position[], geometry: number[][][][]): number | null {
  const vertices = boundary.slice(0, -1);
  if (vertices.length === 0) return null;
  return vertices.every((point) => geometry.some((polygon) => polygon[0] && pointInRing(point, polygon[0]))) ? 1 : null;
}

function pointInRing(point: Position, ring: number[][]): boolean {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const current = ring[index]!;
    const prior = ring[previous]!;
    const intersects = current[1]! > point.latitude !== prior[1]! > point.latitude
      && point.longitude < ((prior[0]! - current[0]!) * (point.latitude - current[1]!)) / (prior[1]! - current[1]!) + current[0]!;
    if (intersects) inside = !inside;
  }
  return inside;
}

function toGeoJsonPolygon(boundary: Position[]) {
  return { type: "Polygon", coordinates: [boundary.map((point) => [point.longitude, point.latitude])] };
}

export function demGridId(position: Position): string {
  const latitude = Math.floor(position.latitude);
  const longitude = Math.floor(position.longitude);
  return `${latitude >= 0 ? "N" : "S"}${Math.abs(latitude).toString().padStart(2, "0")}_${longitude >= 0 ? "E" : "W"}${Math.abs(longitude).toString().padStart(3, "0")}`;
}

export function demGridIds(boundary: Position[]): string[] {
  const longitudes = boundary.map((point) => point.longitude);
  const latitudes = boundary.map((point) => point.latitude);
  const minLongitude = Math.floor(Math.min(...longitudes));
  const maxLongitude = Math.ceil(Math.max(...longitudes)) - 1;
  const minLatitude = Math.floor(Math.min(...latitudes));
  const maxLatitude = Math.ceil(Math.max(...latitudes)) - 1;
  const ids: string[] = [];
  for (let latitude = minLatitude; latitude <= maxLatitude; latitude += 1) {
    for (let longitude = minLongitude; longitude <= maxLongitude; longitude += 1) ids.push(demGridId({ latitude, longitude }));
  }
  return ids;
}

interface ODataProductsResponse { value: Array<{ Id: string; ContentLength?: number | string; PublicationDate?: string }>; }

async function discoverDemProduct(dataset: string, gridId: string): Promise<ODataProductsResponse["value"][number] | null> {
  const filter = `Attributes/OData.CSC.StringAttribute/any(att:att/Name eq 'dataset' and att/OData.CSC.StringAttribute/Value eq '${dataset}') and Attributes/OData.CSC.StringAttribute/any(att:att/Name eq 'gridId' and att/OData.CSC.StringAttribute/Value eq '${gridId}')`;
  const url = new URL("https://catalogue.dataspace.copernicus.eu/odata/v1/Products");
  url.searchParams.set("$filter", filter);
  url.searchParams.set("$top", "5");
  return (await fetchJson<ODataProductsResponse>(url)).value[0] ?? null;
}

async function discoverLatestIfsRun(now: Date): Promise<{ runAt: string; assetId: string } | null> {
  const candidates: Array<{ date: string; hour: number }> = [];
  for (let dayOffset = 0; dayOffset <= 2; dayOffset += 1) {
    const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - dayOffset));
    const date = day.toISOString().slice(0, 10).replaceAll("-", "");
    for (const hour of [18, 12, 6, 0]) candidates.push({ date, hour });
  }
  for (const candidate of candidates) {
    const hour = candidate.hour.toString().padStart(2, "0");
    const directory = `https://data.ecmwf.int/forecasts/${candidate.date}/${hour}z/ifs/0p25/oper/`;
    const response = await fetch(directory, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!response.ok) continue;
    const html = await response.text();
    const assetId = `${candidate.date}${hour}0000-0h-oper-fc.grib2`;
    if (!html.includes(assetId)) continue;
    return { runAt: `${candidate.date.slice(0, 4)}-${candidate.date.slice(4, 6)}-${candidate.date.slice(6, 8)}T${hour}:00:00.000Z`, assetId };
  }
  return null;
}

function uniqueDates(values: string[]): string[] { return [...new Set(values.map((value) => value.slice(0, 10)))].sort(); }
function stringValue(value: unknown): string | null { return typeof value === "string" && value.length > 0 ? value : null; }
function numericValue(value: unknown): number | null { const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN; return Number.isFinite(number) ? number : null; }
function minimum(values: number[]): number | null { return values.length > 0 ? Math.min(...values) : null; }
function maximum(values: number[]): number | null { return values.length > 0 ? Math.max(...values) : null; }
