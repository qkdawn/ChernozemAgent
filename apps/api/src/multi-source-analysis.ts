import { WATER_NITROGEN_METHOD_VERSION } from "@chernozem/contracts";
import type { AcquiredAsset, AnalysisArtifact, AnalysisResult, AnalysisTimeRange, DataAcquisitionRun, FieldSummary, SourceAcquisitionResult } from "@chernozem/contracts";
import type { ControlledAnalysisTool } from "@chernozem/agent-runtime";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { createAnalysisResultBase } from "./analysis-result-base.js";
import type { AnalysisResultStore } from "./analysis-store.js";
import type { CropStagePayload, OpticalConditionPayload } from "./analysis-tools.js";
import { resolveAcquisitionArtifact } from "./data-acquisition.js";
import { runPythonTool } from "./python-tool-runner.js";
import { measureSpatialOverlap, observationInsideZone, type SpatialOverlap } from "./spatial-evidence.js";

const RADAR_TOOL_VERSION = "radar-change-v1";
const WEATHER_TOOL_VERSION = "weather-event-v1";
const TERRAIN_TOOL_VERSION = "terrain-susceptibility-v1";
const SOIL_TOOL_VERSION = "soil-background-v1";
const WATER_NITROGEN_TOOL_VERSION = "water-nitrogen-assessment-v3";
const WATERLOGGING_TOOL_VERSION = "waterlogging-assessment-v2";
const FROST_TOOL_VERSION = "frost-assessment-v2";
export const MAX_RADAR_PAIR_DAYS = 24;
const WATER_NITROGEN_MAX_OPTICAL_AGE_DAYS = 21;
const WATER_NITROGEN_INSPECTION_MATCH_DAYS = 3;
const WATER_NITROGEN_SUPPORT_WINDOW_DAYS = 14;
const WATERLOGGING_RAIN_EVENT_THRESHOLD_MM = 20;
const MAX_FROST_FORECAST_LEAD_HOURS = 240;
const FROST_METHOD_VERSION = "stage-temperature-duration-terrain-v2";

type ZoneClass = "strong_decrease" | "strong_increase" | "stable";

export interface RadarZone {
  id: string;
  row: number;
  column: number;
  class: ZoneClass;
  meanVvDeltaDb: number;
  meanVhDeltaDb: number;
  meanAfterVvDb: number;
  validPixelCount: number;
  zone: number[][];
}

export interface RadarChangePayload {
  beforeDate: string | null;
  afterDate: string;
  intervalDays: number | null;
  comparable: boolean;
  orbitDirection: string | null;
  relativeOrbitNumber: number | null;
  quality: RadarPythonResult["quality"];
  metrics: RadarPythonResult["metrics"];
  observations: RadarObservationSummary[];
  zones: RadarZone[];
}

export interface RadarObservationSummary {
  date: string;
  orbitDirection: string | null;
  relativeOrbitNumber: number | null;
  quality: RadarPythonResult["quality"];
  meanVvDb: number;
  meanVhDb: number;
}

export interface WeatherEventPayload {
  historical: {
    start: string;
    end: string;
    totalRainfallMm: number;
    max24hRainfallMm: number;
    minTemperatureC: number | null;
    rainEvents: Array<{ start: string; end: string; rainfallMm: number }>;
    hourCount: number;
    coverage: { expectedHourCount: number; observedHourCount: number; fraction: number };
    daily: WeatherDailyPoint[];
  } | null;
  forecast: {
    runAt: string;
    start: string | null;
    end: string | null;
    minTemperatureC: number | null;
    cumulativeRainfallMm: number;
    coldWindows: Array<{ start: string; end: string; minTemperatureC: number }>;
    gridDistanceKm: number | null;
    coverage: { validPointCount: number; fraction: number };
    daily: WeatherDailyPoint[];
  } | null;
}

export interface WeatherDailyPoint {
  date: string;
  rainfallMm: number;
  minTemperatureC: number | null;
  maxTemperatureC: number | null;
}

export interface TerrainZone {
  id: string;
  row: number;
  column: number;
  class: "low" | "normal";
  meanElevationM: number;
  relativeElevationM: number;
  meanSlopeDegrees: number;
  validPixelCount: number;
  zone: number[][];
}

export interface TerrainPayload {
  metrics: NonNullable<TerrainPythonResult["metrics"]>;
  zones: TerrainZone[];
}

export interface WaterloggingZone {
  id: string;
  priority: "high" | "normal";
  areaHa: number;
  areaFraction: number;
  meanVvDeltaDb: number;
  relativeElevationM: number | null;
  zone: number[][];
}

export interface WaterloggingAssessmentPayload {
  methodVersion: "radar-rainfall-terrain-v2";
  status: "suspected" | "not_detected" | "radar_change_only";
  beforeDate: string;
  afterDate: string;
  intervalDays: number;
  radarCoverageFraction: number;
  changedAreaHa: number;
  changedAreaFraction: number;
  rainfallThresholdMm: number;
  rainfallMm: number | null;
  rainEvent: { start: string; end: string; rainfallMm: number } | null;
  affectedAreaHa: number;
  affectedAreaFraction: number;
  zones: WaterloggingZone[];
}

export type WaterNitrogenAssessment = "variation_visible" | "uniform";
export interface WaterNitrogenZone {
  id: string;
  opticalZoneId: string;
  meanNdvi: number | null;
  ndviDeviation: number | null;
  metricDeviations: OpticalConditionPayload["zones"][number]["metricDeviations"] | null;
  areaHa: number | null;
  areaFraction: number | null;
  radarOverlap: SpatialOverlap;
  lowlandOverlap: SpatialOverlap;
  inspectionRefs: Array<{ taskId: string; findingId: string }>;
  inspectionLocationStatus: "computed" | "invalid_input" | "not_evaluated";
  zone: number[][];
  holes?: number[][][];
}

export interface SoilBackgroundPayload {
  available: boolean;
  properties: string[];
  resolutionMeters: number;
  assetCount: number;
  measurements: SoilMeasurement[];
}

export interface SoilMeasurement {
  property: string;
  label: string;
  depth: string;
  unit: string;
  mean: number;
  min: number;
  max: number;
  validPixelCount: number;
  totalPixelCount: number;
  validFraction: number;
}

export interface WaterNitrogenEvidencePayload {
  methodVersion: typeof WATER_NITROGEN_METHOD_VERSION;
  assessment: WaterNitrogenAssessment;
  referenceDate: string;
  cropStage: CropStagePayload | null;
  observationCount: number;
  validCoverageFraction: number | null;
  latestChange: OpticalConditionPayload["changes"][number] | null;
  attentionAreaHa: number | null;
  attentionAreaFraction: number | null;
  observationAgeDays: number | null;
  observationStatus: "current" | "stale";
  observation: {
    ndvi: number | null;
    ndre: number | null;
    reci: number | null;
    msavi: number | null;
    ndmi: number | null;
    ndwi: number | null;
    variationStatus: "visible" | "uniform";
  };
  zones: WaterNitrogenZone[];
  previousInspections: WaterNitrogenInspectionContext[];
  inspectionMatches: WaterNitrogenInspectionMatch[];
  evidenceLevel: "optical_only" | "multi_source" | "field_comparison";
  sourceAlignment: Array<{
    resultId: string;
    kind: AnalysisResult<unknown>["kind"];
    status: "aligned" | "outside_window" | "unusable";
    offsetDays: number | null;
  }>;
  fieldComparison: {
    status: "absent" | "unpaired" | "paired";
    lowValueRecords: Array<{ taskId: string; findingId: string }>;
    referenceRecords: Array<{ taskId: string; findingId: string }>;
    generalRecords: Array<{ taskId: string; findingId: string }>;
    pairs: Array<{
      lowValue: { taskId: string; findingId: string };
      reference: { taskId: string; findingId: string };
      offsetDays: number;
    }>;
  };
}

export interface WaterNitrogenInspectionMatch {
  taskId: string;
  findingId: string;
  observedAt: string;
  matchedImageDate: string | null;
  offsetDays: number | null;
  status: "aligned" | "historical" | "unmatched";
}

export interface WaterNitrogenInspectionContext {
  taskId: string;
  findingId: string;
  findingTitle: string;
  scoutingRole: "low_value" | "reference" | "general";
  observationDates: string[];
  checkedAt: string;
  observedAt: string;
  location: { longitude: number; latitude: number };
  waterCondition: "dry" | "normal" | "wet" | "standing_water" | "unknown";
  leafColor: "normal" | "pale" | "dark_green" | "unknown";
  diseaseOrPest: "none_seen" | "suspected" | "unknown";
  note: string;
}

export interface FrostRiskZone {
  id: string;
  risk: "high" | "watch";
  relativeElevationM: number;
  areaHa: number;
  areaFraction: number;
  zone: number[][];
}

export interface FrostRiskPayload {
  methodVersion: typeof FROST_METHOD_VERSION;
  risk: "high" | "watch" | "normal" | "undetermined";
  forecastRunAt: string;
  forecastCoverageFraction: number;
  forecastGridDistanceKm: number | null;
  forecastMinTemperatureC: number;
  forecastWindow: { start: string | null; end: string | null };
  coldDurationHours: number;
  cropStage: CropStagePayload | null;
  stageSensitivity: "high" | "medium" | "low" | "unknown";
  terrainStatus: "available" | "limited" | "missing";
  zones: FrostRiskZone[];
}

export interface MultiSourceRunners {
  radar(input: unknown): Promise<RadarPythonResult>;
  weather(input: unknown): Promise<WeatherPythonResult>;
  terrain(input: unknown): Promise<TerrainPythonResult>;
  soil?(input: unknown): Promise<SoilPythonResult>;
}

export class MultiSourceAnalysisService {
  private readonly runners: MultiSourceRunners;

  constructor(private readonly store: AnalysisResultStore, pythonExecutable = process.env.PYTHON_EXECUTABLE ?? "python", runners?: MultiSourceRunners) {
    this.runners = runners ?? {
      radar: (input) => runPythonTool<RadarPythonResult>("analyze-radar.py", input, pythonExecutable),
      weather: (input) => runPythonTool<WeatherPythonResult>("analyze-weather.py", input, pythonExecutable),
      terrain: (input) => runPythonTool<TerrainPythonResult>("analyze-terrain.py", input, pythonExecutable),
      soil: (input) => runPythonTool<SoilPythonResult>("analyze-soil.py", input, pythonExecutable),
    };
  }

  createWaterloggingTools(field: FieldSummary, acquisitions: DataAcquisitionRun[], timeRange: AnalysisTimeRange): ControlledAnalysisTool[] {
    return [
      { name: "analyze_radar_change", execute: async ({ taskId }) => this.save(await this.analyzeRadarChange(taskId, field, acquisitions, timeRange)) },
      { name: "analyze_weather_event", execute: async ({ taskId }) => this.save(await this.analyzeWeatherEvent(taskId, field, acquisitions, timeRange)) },
      { name: "analyze_terrain_susceptibility", execute: async ({ taskId }) => this.save(await this.analyzeTerrain(taskId, field, acquisitions)) },
      { name: "detect_waterlogging", execute: async ({ taskId }) => this.save(await this.detectWaterlogging(taskId, field, timeRange)) },
    ];
  }

  createWaterNitrogenTools(field: FieldSummary, acquisitions: DataAcquisitionRun[], timeRange: AnalysisTimeRange, previousInspections: WaterNitrogenInspectionContext[] = []): ControlledAnalysisTool[] {
    return [
      { name: "analyze_radar_change", execute: async ({ taskId }) => {
        const referenceDate = await this.opticalReferenceDate(taskId);
        return this.save(await this.analyzeRadarChange(taskId, field, acquisitions, supportRangeAround(referenceDate, timeRange, MAX_RADAR_PAIR_DAYS, WATER_NITROGEN_SUPPORT_WINDOW_DAYS), referenceDate));
      } },
      { name: "analyze_weather_event", execute: async ({ taskId }) => this.save(await this.analyzeWeatherEvent(taskId, field, acquisitions, supportRangeBefore(await this.opticalReferenceDate(taskId), timeRange, WATER_NITROGEN_SUPPORT_WINDOW_DAYS))) },
      { name: "analyze_terrain_susceptibility", execute: async ({ taskId }) => this.save(await this.analyzeTerrain(taskId, field, acquisitions)) },
      { name: "get_soil_background", execute: async ({ taskId }) => this.save(await this.getSoilBackground(taskId, field, acquisitions)) },
      { name: "assess_water_nitrogen_evidence", execute: async ({ taskId }) => this.save(await this.assessWaterNitrogenEvidence(taskId, field, timeRange, previousInspections)) },
    ];
  }

  createFrostRiskTools(field: FieldSummary, acquisitions: DataAcquisitionRun[], timeRange: AnalysisTimeRange): ControlledAnalysisTool[] {
    return [
      { name: "analyze_weather_event", execute: async ({ taskId }) => this.save(await this.analyzeWeatherEvent(taskId, field, acquisitions, timeRange)) },
      { name: "analyze_terrain_susceptibility", execute: async ({ taskId }) => this.save(await this.analyzeTerrain(taskId, field, acquisitions)) },
      { name: "assess_frost_risk", execute: async ({ taskId }) => this.save(await this.assessFrostRisk(taskId, field, timeRange)) },
    ];
  }

  private async save<T>(result: AnalysisResult<T>): Promise<AnalysisResult<T>> {
    await this.store.save(result as AnalysisResult<unknown>);
    return result;
  }

  private async opticalReferenceDate(taskId: string): Promise<string | undefined> {
    const optical = (await this.store.list(taskId)).find((result) => result.kind === "optical_condition") as AnalysisResult<OpticalConditionPayload> | undefined;
    return optical?.result?.current.observationDate;
  }

  private async analyzeRadarChange(taskId: string, field: FieldSummary, acquisitions: DataAcquisitionRun[], timeRange: AnalysisTimeRange, targetDate?: string): Promise<AnalysisResult<RadarChangePayload>> {
    const base = createAnalysisResultBase({ taskId, toolName: "analyze_radar_change", toolVersion: RADAR_TOOL_VERSION, kind: "radar_change", field, acquisitions, timeRange,
      parameters: { maximumPairIntervalDays: MAX_RADAR_PAIR_DAYS, targetDate: targetDate ?? null, minimumValidFraction: 0.8 } });
    const { id } = base;
    const observations = collectRadarObservations(acquisitions, timeRange);
    const visualizationRef = `analysis/${taskId}/${id}`;
    const renderedObservations = await this.renderRadarObservations(field, observations, visualizationRef);
    const observationArtifacts = renderedObservations.artifacts;
    const pair = selectRadarPair(observations, targetDate);
    if (!pair && renderedObservations.observations.length) {
      const latest = renderedObservations.observations.at(-1)!;
      const result: RadarChangePayload = { beforeDate: null, afterDate: latest.date, intervalDays: null, comparable: false, orbitDirection: latest.orbitDirection, relativeOrbitNumber: latest.relativeOrbitNumber, quality: latest.quality, metrics: null, observations: renderedObservations.observations, zones: [] };
      const sources = renderedObservations.observations.map((item) => ({ source: "sentinel-1", date: item.date, quality: "partial" as const, role: "observation" as const, note: `单期后向散射观测，轨道 ${item.relativeOrbitNumber ?? "未知"}，${item.orbitDirection ?? "方向未知"}；缺少可比基线。` }));
      return { ...base, status: "partial", summary: `已读取 ${latest.date} Sentinel-1 单期观测，地块平均 VV ${latest.meanVvDb.toFixed(2)} dB、VH ${latest.meanVhDb.toFixed(2)} dB；缺少同轨基线，未计算变化。`, result,
        sources, findings: renderedObservations.observations.map((item) => ({ id: `radar-observation-${item.date}`, summary: `${item.date} 地块平均 VV ${item.meanVvDb.toFixed(2)} dB、VH ${item.meanVhDb.toFixed(2)} dB；这是单期观测，不代表积水或土壤湿度。`, sourceDates: [{ source: "sentinel-1", date: item.date }], zoneRef: observationArtifactRef(observationArtifacts, item.date) })), artifacts: observationArtifacts,
        limitations: ["只有单期或不同轨道 Sentinel-1 观测，不能计算可比变化。", "单期后向散射不直接表示积水或土壤湿度。"], nextActions: [{ code: "collect_radar_pair", label: "采集同轨道灾前和灾后 Sentinel-1 影像" }], error: null };
    }
    if (!pair) return { ...base, status: renderedObservations.failureCount === observations.length && observations.length > 0 ? "failed" : "needs_data", summary: renderedObservations.failureCount === observations.length && observations.length > 0 ? "Sentinel-1 单期观测处理未完成。" : "缺少同轨道条件可比的两期 Sentinel-1 影像。", result: null,
      sources: observations.map((item) => ({ source: "sentinel-1", date: item.date, quality: "missing", note: `轨道 ${item.relativeOrbitNumber ?? "未知"}，${item.orbitDirection ?? "方向未知"}，未形成可用单期统计。` })), findings: [], artifacts: observationArtifacts,
      limitations: ["积水识别至少需要两期同轨道、同极化 Sentinel-1 观测。"], nextActions: [{ code: "collect_radar_pair", label: "采集同轨道灾前和灾后 Sentinel-1 影像" }],
      error: { code: renderedObservations.failureCount === observations.length && observations.length > 0 ? "radar_processing_failed" : "radar_pair_missing", message: renderedObservations.failureCount === observations.length && observations.length > 0 ? "雷达单期处理进程失败。" : "没有找到同轨道雷达前后时相。", retryable: true } };
    const beforePath = assetPath(pair.before.asset);
    const afterPath = assetPath(pair.after.asset);
    if (!beforePath || !afterPath) return { ...base, status: "needs_data", summary: "雷达采集记录存在，但影像文件不可读取。", result: null,
      sources: pairSources(pair, "missing"), findings: [], artifacts: observationArtifacts, limitations: ["需要可读取的 Sentinel-1 VV、VH 和 dataMask 地块影像。"], nextActions: [{ code: "redownload_radar", label: "重新获取雷达影像" }],
      error: { code: "radar_assets_missing", message: "雷达文件不可读取。", retryable: true } };
    const visualizationDir = resolve(import.meta.dirname, "../../../runtime/artifacts", visualizationRef);
    await mkdir(visualizationDir, { recursive: true });
    let processed: RadarPythonResult;
    try {
      processed = await this.runners.radar({ beforePath, afterPath, boundary: field.boundary, outputDir: visualizationDir, includeObservationVisualizations: false });
    } catch (error) {
      return { ...base, status: "failed", summary: "Sentinel-1 雷达变化处理未完成。", result: null,
        sources: pairSources(pair, "missing"), findings: [], artifacts: observationArtifacts, limitations: ["本次未形成可用于判断的雷达变化结果。"], nextActions: [{ code: "retry_radar_analysis", label: "重试雷达变化分析" }],
        error: { code: "radar_processing_failed", message: compactProcessingError(error, "雷达处理进程失败。"), retryable: true } };
    }
    if (!processed.metrics || processed.status !== "succeeded") return { ...base, status: "needs_data", summary: processed.error.message ?? "地块内没有有效雷达像元。", result: null,
      sources: pairSources(pair, "missing"), findings: [], artifacts: observationArtifacts, limitations: ["雷达影像未形成共同有效覆盖。"], nextActions: [{ code: "collect_radar_pair", label: "采集覆盖完整的同轨雷达影像" }],
      error: { code: processed.error.code ?? "radar_processing_failed", message: processed.error.message ?? "雷达处理失败。", retryable: true } };
    const intervalDays = Math.round((Date.parse(pair.after.date) - Date.parse(pair.before.date)) / 86_400_000);
    const comparable = intervalDays <= MAX_RADAR_PAIR_DAYS && processed.quality.validFraction >= 0.8;
    const result: RadarChangePayload = { beforeDate: pair.before.date, afterDate: pair.after.date, intervalDays, comparable,
      orbitDirection: pair.after.orbitDirection!, relativeOrbitNumber: pair.after.relativeOrbitNumber!, quality: processed.quality, metrics: processed.metrics, observations: renderedObservations.observations, zones: processed.zones };
    const artifact = await writeZonesArtifact(taskId, id, field, processed.zones, "radar-change");
    const visualizations = (processed.visualizations ?? []).filter((visualization) => visualization.metric === "radar_change");
    const visualizationArtifacts = visualizations.map((visualization) => ({
      ref: `${visualizationRef}/${visualization.fileName}`,
      kind: "map" as const,
      visualization: { type: "raster" as const, source: "sentinel-1", metric: visualization.metric, date: pair.after.date, bounds: visualization.bounds, min: visualization.min, max: visualization.max, resolutionMeters: visualization.resolutionMeters, unit: "dB", label: visualization.label },
    }));
    return { ...base, status: comparable ? "succeeded" : "partial", summary: `已比较 ${pair.before.date} 与 ${pair.after.date} 的同轨雷达观测，地块平均 VV 变化 ${processed.metrics.vvDeltaDb.toFixed(2)} dB。`, result,
      sources: pairSources(pair, comparable ? "usable" : "partial"), findings: [{ id: "radar-change", summary: `两期相隔 ${intervalDays} 天，显著变化像元占 ${(processed.metrics.changedPixelFraction * 100).toFixed(1)}%。`, sourceDates: [{ source: "sentinel-1", date: pair.before.date }, { source: "sentinel-1", date: pair.after.date }], zoneRef: artifact }],
      artifacts: [{ ref: artifact, kind: "map" }, ...observationArtifacts, ...visualizationArtifacts], limitations: comparable ? [] : [intervalDays > MAX_RADAR_PAIR_DAYS ? `两期雷达间隔 ${intervalDays} 天，超过 ${MAX_RADAR_PAIR_DAYS} 天，作物生长和耕作变化可能干扰积水判断。` : "雷达共同有效覆盖不足 80%。"], nextActions: [], error: null };
  }

  private async renderRadarObservations(field: FieldSummary, observations: RadarObservation[], visualizationRef: string): Promise<{ artifacts: AnalysisArtifact[]; observations: RadarObservationSummary[]; failureCount: number }> {
    const artifacts: AnalysisArtifact[] = [];
    const summaries: RadarObservationSummary[] = [];
    let failureCount = 0;
    for (const observation of observations) {
      const path = assetPath(observation.asset);
      if (!path) continue;
      const directoryName = `${observation.date}-${observation.orbitDirection ?? "unknown"}-${observation.relativeOrbitNumber ?? "unknown"}`.toLowerCase();
      const directoryRef = `${visualizationRef}/observations/${directoryName}`;
      const outputDir = resolve(import.meta.dirname, "../../../runtime/artifacts", directoryRef);
      try {
        const processed = await this.runners.radar({ mode: "observation", path, boundary: field.boundary, outputDir });
        if (processed.status !== "succeeded") continue;
        if (processed.observation) summaries.push({ date: observation.date, orbitDirection: observation.orbitDirection, relativeOrbitNumber: observation.relativeOrbitNumber, quality: processed.quality, meanVvDb: processed.observation.meanVvDb, meanVhDb: processed.observation.meanVhDb });
        artifacts.push(...(processed.visualizations ?? []).filter((visualization) => visualization.metric === "vv" || visualization.metric === "vh").map((visualization) => ({
          ref: `${directoryRef}/${visualization.fileName}`,
          kind: "map" as const,
          visualization: { type: "raster" as const, source: "sentinel-1", metric: visualization.metric, date: observation.date, bounds: visualization.bounds, min: visualization.min, max: visualization.max, resolutionMeters: visualization.resolutionMeters, unit: "dB", label: visualization.label },
        })));
      } catch {
        failureCount += 1;
      }
    }
    return { artifacts, observations: summaries, failureCount };
  }

  private async analyzeWeatherEvent(taskId: string, field: FieldSummary, acquisitions: DataAcquisitionRun[], timeRange: AnalysisTimeRange): Promise<AnalysisResult<WeatherEventPayload>> {
    const base = createAnalysisResultBase({ taskId, toolName: "analyze_weather_event", toolVersion: WEATHER_TOOL_VERSION, kind: "weather_event", field, acquisitions, timeRange,
      parameters: { spatialSampling: "nearest-centroid-grid" } });
    const { id } = base;
    const historicalAssets = collectAssets(acquisitions, "era5-land", "weather-series", timeRange).filter((asset) => asset.format === "NetCDF");
    const forecastAssets = collectAssets(acquisitions, "ecmwf-ifs", "weather-series").filter((asset) => asset.format.includes("JSON"));
    const historicalPaths = historicalAssets.flatMap((asset) => assetPath(asset) ? [assetPath(asset)!] : []);
    const forecastPaths = forecastAssets.flatMap((asset) => assetPath(asset) ? [assetPath(asset)!] : []);
    if (!historicalPaths.length && !forecastPaths.length) return { ...base, status: "needs_data", summary: "没有可读取的历史天气或天气预报资产。", result: null, sources: [], findings: [], artifacts: [], limitations: ["需要已采集的 ERA5-Land 或 ECMWF IFS 数据。"], nextActions: [{ code: "collect_weather", label: "采集任务时间范围内的天气数据" }], error: { code: "weather_assets_missing", message: "天气文件不可读取。", retryable: true } };
    let processed: WeatherPythonResult;
    try {
      processed = await this.runners.weather({ historicalPaths, forecastPaths, centroid: field.centroid, timeRange });
    } catch (error) {
      return {
        ...base,
        status: "failed",
        summary: "天气数据处理未完成。",
        result: null,
        sources: [],
        findings: [],
        artifacts: [],
        limitations: ["天气背景未参与本次判断；已有的光学、雷达或地形结果仍可继续交付。"],
        nextActions: [{ code: "redownload_weather", label: "重新获取任务时间范围内的天气数据" }],
        error: { code: "weather_processing_failed", message: compactProcessingError(error, "天气处理进程失败。"), retryable: true },
      };
    }
    if (processed.status === "needs_data" || (!processed.historical && !processed.forecast)) return { ...base, status: "needs_data", summary: processed.error.message ?? "天气处理没有形成可用结果。", result: null, sources: [], findings: [], artifacts: [], limitations: ["天气资产未覆盖任务时间范围。"], nextActions: [{ code: "collect_weather", label: "补充天气数据" }], error: { code: processed.error.code ?? "weather_processing_failed", message: processed.error.message ?? "天气处理失败。", retryable: true } };
    const result: WeatherEventPayload = { historical: processed.historical, forecast: processed.forecast };
    const usedForecastAssets = processed.forecast
      ? forecastAssets.filter((asset) => sameInstant(asset.generatedAt ?? asset.validFrom, processed.forecast!.runAt))
      : [];
    const forecastSourceAssets = usedForecastAssets.length ? usedForecastAssets : processed.forecast ? forecastAssets.slice(0, 1) : [];
    const sources: AnalysisResult<unknown>["sources"] = [
      ...historicalAssets.map((asset) => ({ source: "era5-land", date: asset.validTo?.slice(0, 10) ?? null, quality: processed.historical && processed.historical.coverage.fraction >= 0.8 ? "usable" as const : "partial" as const, note: "ERA5-Land 地块周边历史天气背景。" })),
      ...forecastSourceAssets.map((asset) => ({ source: "ecmwf-ifs", date: asset.generatedAt?.slice(0, 10) ?? asset.validFrom?.slice(0, 10) ?? null, quality: processed.forecast && processed.forecast.coverage.fraction >= 0.8 ? "usable" as const : "partial" as const, note: "本次采用的 ECMWF IFS 0.25°地块邻近格点预报批次。" })),
    ];
    const summary = processed.historical ? `历史窗口累计降雨 ${processed.historical.totalRainfallMm.toFixed(1)} 毫米，最大 24 小时 ${processed.historical.max24hRainfallMm.toFixed(1)} 毫米。` : `最新预报最低气温 ${processed.forecast?.minTemperatureC?.toFixed(1) ?? "未知"}℃。`;
    const artifacts = weatherCharts(taskId, id, processed);
    const coverageLimitations = [
      ...(processed.historical && processed.historical.coverage.fraction < 0.8 ? [`ERA5-Land 在任务窗口内的小时覆盖率为 ${(processed.historical.coverage.fraction * 100).toFixed(1)}%。`] : []),
      ...(processed.forecast && processed.forecast.coverage.fraction < 0.8 ? [`IFS 在任务窗口内的预报时间覆盖率为 ${(processed.forecast.coverage.fraction * 100).toFixed(1)}%。`] : []),
    ];
    return { ...base, status: processed.status, summary, result, sources,
      findings: [{ id: "weather-event", summary, sourceDates: sources.map((source) => ({ source: source.source, date: source.date })), zoneRef: null }], artifacts, limitations: [...coverageLimitations, "天气数据是地块周边粗分辨率背景，不能表达田内微气候差异。"], nextActions: [], error: null };
  }

  private async analyzeTerrain(taskId: string, field: FieldSummary, acquisitions: DataAcquisitionRun[]): Promise<AnalysisResult<TerrainPayload>> {
    const base = createAnalysisResultBase({ taskId, toolName: "analyze_terrain_susceptibility", toolVersion: TERRAIN_TOOL_VERSION, kind: "terrain_susceptibility", field, acquisitions,
      parameters: { dataset: "copernicus-dem-glo-30", minimumLowlandRelativeDepthM: 0.5 } });
    const { id } = base;
    const asset = collectAssets(acquisitions, "copernicus-dem", "dem")[0];
    const path = asset ? assetPath(asset) : null;
    if (!asset || !path) return { ...base, status: "needs_data", summary: "没有可读取的 Copernicus DEM 地块资产。", result: null, sources: [], findings: [], artifacts: [], limitations: ["需要覆盖当前地块的 DEM。"], nextActions: [{ code: "collect_dem", label: "采集地形数据" }], error: { code: "dem_asset_missing", message: "DEM 文件不可读取。", retryable: true } };
    const visualizationRef = `analysis/${taskId}/${id}`;
    const visualizationDir = resolve(import.meta.dirname, "../../../runtime/artifacts", visualizationRef);
    await mkdir(visualizationDir, { recursive: true });
    let processed: TerrainPythonResult;
    try {
      processed = await this.runners.terrain({ path, boundary: field.boundary, outputDir: visualizationDir });
    } catch (error) {
      return { ...base, status: "failed", summary: "地形易发性处理未完成。", result: null,
        sources: [{ source: "copernicus-dem", date: null, quality: "missing", note: "DEM 已登记，但本次处理未完成。" }], findings: [], artifacts: [], limitations: ["本次未形成低洼和坡度分区。"], nextActions: [{ code: "retry_terrain_analysis", label: "重试地形分析" }],
        error: { code: "terrain_processing_failed", message: compactProcessingError(error, "地形处理进程失败。"), retryable: true } };
    }
    if (processed.status === "needs_data" || !processed.metrics) return { ...base, status: "needs_data", summary: processed.error.message ?? "DEM 未形成地块地形结果。", result: null, sources: [{ source: "copernicus-dem", date: null, quality: "missing", note: "DEM 未形成有效像元。" }], findings: [], artifacts: [], limitations: ["DEM 未覆盖地块或文件不可用。"], nextActions: [{ code: "collect_dem", label: "重新采集地形数据" }], error: { code: processed.error.code ?? "terrain_processing_failed", message: processed.error.message ?? "地形处理失败。", retryable: true } };
    const result: TerrainPayload = { metrics: processed.metrics, zones: processed.zones };
    const artifact = await writeZonesArtifact(taskId, id, field, processed.zones, "terrain");
    const visualizationArtifacts = (processed.visualizations ?? []).map((visualization) => ({
      ref: `${visualizationRef}/${visualization.fileName}`,
      kind: "map" as const,
      visualization: { type: "raster" as const, source: "copernicus-dem", metric: visualization.metric, date: "static", bounds: visualization.bounds, min: visualization.min, max: visualization.max, resolutionMeters: visualization.resolutionMeters, unit: visualization.metric === "slope" ? "degrees" : "m", label: visualization.label },
    }));
    const partial = processed.status === "partial" || processed.metrics.validFraction < 0.8;
    return { ...base, status: partial ? "partial" : "succeeded", summary: `地块高程 ${processed.metrics.minElevationM.toFixed(1)} 至 ${processed.metrics.maxElevationM.toFixed(1)} 米，已识别 ${processed.zones.filter((zone) => zone.class === "low").length} 个相对低洼分区。`, result,
      sources: [{ source: "copernicus-dem", date: null, quality: partial ? "partial" : "usable", note: "Copernicus DEM GLO-30 地形背景。" }], findings: [{ id: "terrain-low-zones", summary: "低洼分区只用于巡查排序，不代表已发生积水。", sourceDates: [{ source: "copernicus-dem", date: null }], zoneRef: artifact }], artifacts: [{ ref: artifact, kind: "map" }, ...visualizationArtifacts], limitations: [...(partial ? [`DEM 在地块内的有效像元覆盖率为 ${(processed.metrics.validFraction * 100).toFixed(1)}%。`] : []), "30 米 DEM 不能表达田埂、排水沟和微小地表起伏。"], nextActions: [], error: null };
  }

  private async detectWaterlogging(taskId: string, field: FieldSummary, timeRange: AnalysisTimeRange): Promise<AnalysisResult<WaterloggingAssessmentPayload>> {
    const available = await this.store.list(taskId);
    const radar = available.find((item) => item.kind === "radar_change") as AnalysisResult<RadarChangePayload> | undefined;
    const weather = available.find((item) => item.kind === "weather_event") as AnalysisResult<WeatherEventPayload> | undefined;
    const terrain = available.find((item) => item.kind === "terrain_susceptibility") as AnalysisResult<TerrainPayload> | undefined;
    const base = createAnalysisResultBase({ taskId, toolName: "detect_waterlogging", toolVersion: WATERLOGGING_TOOL_VERSION, kind: "assessment", field, timeRange,
      inputResults: [...(radar ? [radar] : []), ...(weather ? [weather] : []), ...(terrain ? [terrain] : [])], parameters: { requiresComparableRadarPair: true, requiresAssociatedRainfall: true, rainfallEventThresholdMm: WATERLOGGING_RAIN_EVENT_THRESHOLD_MM } });
    const sources = dedupeSources([...(radar?.sources ?? []), ...(weather?.sources ?? []), ...(terrain?.sources ?? [])]);
    if (!radar?.result || !radar.result.comparable || !radar.result.beforeDate || !radar.result.metrics) return { ...base, status: "needs_data", summary: "当前雷达前后时相不满足积水识别条件。", result: null, sources, findings: [], artifacts: radar?.artifacts ?? [], limitations: [...(radar?.limitations ?? []), "不能用单期、时间间隔过长或不同轨道的雷达观测确认积水。"], nextActions: [{ code: "collect_radar_pair", label: "补充间隔不超过 24 天的同轨灾前和灾后影像" }], error: { code: "radar_pair_not_comparable", message: "雷达前后时相不可比。", retryable: true } };
    const beforeDate = radar.result.beforeDate;
    const terrainComplete = terrain?.status === "succeeded" && Boolean(terrain.result);
    const terrainByCell = new Map((terrainComplete ? terrain.result!.zones : []).map((zone) => [`${zone.row}:${zone.column}`, zone]));
    const radarChangeZones = radar.result.zones.filter((zone) => zone.class === "strong_decrease").map((zone) => {
      const terrainZone = terrainByCell.get(`${zone.row}:${zone.column}`);
      const areaHa = roundMetric(field.areaHa * zone.validPixelCount / radar.result!.quality.validPixelCount);
      return { id: zone.id, priority: terrainZone?.class === "low" ? "high" as const : "normal" as const, areaHa, areaFraction: field.areaHa > 0 ? roundMetric(areaHa / field.areaHa) : 0, meanVvDeltaDb: zone.meanVvDeltaDb, relativeElevationM: terrainZone?.relativeElevationM ?? null, zone: zone.zone };
    });
    const radarAffectedAreaHa = roundMetric(radarChangeZones.reduce((sum, zone) => sum + zone.areaHa, 0));
    const radarAffectedAreaFraction = field.areaHa > 0 ? roundMetric(radarAffectedAreaHa / field.areaHa) : 0;
    const resultBase = {
      methodVersion: "radar-rainfall-terrain-v2" as const,
      beforeDate,
      afterDate: radar.result.afterDate,
      intervalDays: radar.result.intervalDays!,
      radarCoverageFraction: radar.result.quality.validFraction,
      changedAreaHa: radarAffectedAreaHa,
      changedAreaFraction: radarAffectedAreaFraction,
      rainfallThresholdMm: WATERLOGGING_RAIN_EVENT_THRESHOLD_MM,
    };
    const radarTerrainSources = dedupeSources([
      ...(radar.sources ?? []).filter((source) => source.source === "sentinel-1" && (source.date === radar.result!.beforeDate || source.date === radar.result!.afterDate)),
      ...(terrainComplete ? terrain?.sources ?? [] : []),
    ]);
    const radarOnlyResult = (reason: string, actionLabel: string): AnalysisResult<WaterloggingAssessmentPayload> => ({
      ...base,
      status: "partial",
      summary: radarChangeZones.length
        ? `${radar.result!.afterDate} 雷达观测发现 ${radarChangeZones.length} 个显著变化区；同期连续降雨资料不完整，暂不判定为积水。`
        : `${beforeDate} 至 ${radar.result!.afterDate} 的雷达对比未发现显著下降区；同期连续降雨资料仍不完整。`,
      result: { ...resultBase, status: "radar_change_only", rainfallMm: null, rainEvent: null, affectedAreaHa: 0, affectedAreaFraction: 0, zones: radarChangeZones },
      sources: radarTerrainSources,
      findings: radarChangeZones.map((zone) => ({ id: zone.id, summary: `${zone.priority === "high" ? "地形相对低洼，" : ""}VV 后向散射变化 ${zone.meanVvDeltaDb.toFixed(2)} dB；这是雷达变化区，不等于已发生积水。`, sourceDates: radarTerrainSources.map((source) => ({ source: source.source, date: source.date })), zoneRef: radar.artifacts[0]?.ref ?? null })),
      artifacts: radar.artifacts,
      limitations: [reason, "当前只交付雷达变化观测；没有同期连续降雨时，不生成积水结论。", ...(terrain?.limitations ?? [])],
      nextActions: [
        { code: "collect_weather", label: actionLabel },
        ...(radarChangeZones.length ? [{ code: "inspect_radar_change_zones", label: radarChangeZones.some((zone) => zone.priority === "high") ? "优先核查低洼且雷达变化明显的区域" : "优先核查雷达变化明显的区域", ...(radar.artifacts[0]?.ref ? { zoneRef: radar.artifacts[0].ref } : {}) }] : []),
      ],
      error: null,
    });
    if (!weather?.result?.historical) return radarOnlyResult("缺少覆盖雷达前后时相的历史降雨数据。", "补充雷达观测期间的历史天气");
    if (weather.status !== "succeeded" || weather.result.historical.coverage.fraction < 0.8) return radarOnlyResult(`历史天气有效覆盖率为 ${(weather.result.historical.coverage.fraction * 100).toFixed(1)}%，不足以关联积水事件。`, "补充覆盖雷达观测期间的连续历史天气");
    const beforeTime = Date.parse(`${beforeDate}T00:00:00Z`);
    const afterTime = Date.parse(`${radar.result.afterDate}T23:59:59Z`);
    if (Date.parse(weather.result.historical.start) > beforeTime || Date.parse(weather.result.historical.end) < afterTime) return radarOnlyResult("历史天气没有完整覆盖雷达前后时相。", "补充覆盖雷达前后时相的连续降雨数据");
    const rainEvents = weather.result.historical.rainEvents.filter((event) => Date.parse(event.end) >= beforeTime && Date.parse(event.start) <= afterTime);
    const strongestRainEvent = rainEvents.reduce<(typeof rainEvents)[number] | null>((strongest, event) => !strongest || event.rainfallMm > strongest.rainfallMm ? event : strongest, null);
    const rainfallMm = strongestRainEvent?.rainfallMm ?? 0;
    const qualifyingRainEvent = rainfallMm >= WATERLOGGING_RAIN_EVENT_THRESHOLD_MM ? strongestRainEvent : null;
    const evidenceSources = dedupeSources([
      ...(radar.sources ?? []).filter((source) => source.source === "sentinel-1" && (source.date === radar.result!.beforeDate || source.date === radar.result!.afterDate)),
      ...rainEventSourceDates(rainEvents).map((date) => ({ source: "era5-land", date, quality: "usable" as const, note: "雷达前后时相内的实际降雨事件日期。" })),
      ...(terrainComplete ? terrain?.sources ?? [] : []),
    ]);
    const zones: WaterloggingZone[] = qualifyingRainEvent ? radarChangeZones : [];
    const affectedAreaHa = roundMetric(zones.reduce((sum, zone) => sum + zone.areaHa, 0));
    const affectedAreaFraction = field.areaHa > 0 ? roundMetric(affectedAreaHa / field.areaHa) : 0;
    const result: WaterloggingAssessmentPayload = { ...resultBase, status: zones.length ? "suspected" : "not_detected", rainfallMm, rainEvent: qualifyingRainEvent, affectedAreaHa, affectedAreaFraction, zones };
    const summary = zones.length
      ? `${radar.result.afterDate} 雷达观测中发现 ${zones.length} 个与 ${rainfallMm.toFixed(1)} 毫米降雨事件关联的疑似积水区，估算影响 ${affectedAreaHa.toFixed(2)} 公顷。`
      : rainfallMm < WATERLOGGING_RAIN_EVENT_THRESHOLD_MM
        ? `雷达前后时相内最大降雨事件为 ${rainfallMm.toFixed(1)} 毫米，未达到 ${WATERLOGGING_RAIN_EVENT_THRESHOLD_MM} 毫米事件门槛，本次不判定积水。`
        : "达到降雨事件门槛后，未发现符合当前雷达变化门槛的疑似积水区。";
    return { ...base, status: "succeeded", summary, result, sources: evidenceSources, findings: zones.map((zone) => ({ id: zone.id, summary: `${zone.priority === "high" ? "低洼优先区，" : ""}VV 后向散射变化 ${zone.meanVvDeltaDb.toFixed(2)} dB。`, sourceDates: evidenceSources.map((source) => ({ source: source.source, date: source.date })), zoneRef: radar.artifacts[0]?.ref ?? null })), artifacts: radar.artifacts,
      limitations: [...(terrain?.limitations ?? []), ...(terrain?.status === "partial" ? ["DEM 覆盖受限，本次不使用地形调整积水核查优先级。"] : []), "疑似积水由雷达变化与降雨关联识别，仍需现场核查；未计算积水深度。"], nextActions: zones.length
        ? [{ code: "inspect_waterlogging_zones", label: "优先核查雷达变化明显的分区", ...(radar.artifacts[0]?.ref ? { zoneRef: radar.artifacts[0].ref } : {}) }]
        : [{ code: "record_waterlogging_event", label: "记录本次事件，按常规巡田检查排水情况" }], error: null };
  }

  private async getSoilBackground(taskId: string, field: FieldSummary, acquisitions: DataAcquisitionRun[]): Promise<AnalysisResult<SoilBackgroundPayload>> {
    const base = createAnalysisResultBase({ taskId, toolName: "get_soil_background", toolVersion: SOIL_TOOL_VERSION, kind: "soil_background", field, acquisitions,
      parameters: { quantile: "Q0.5", resolutionMeters: 250 } });
    const { id } = base;
    const assets = collectAssets(acquisitions, "soilgrids-250m", "soil");
    if (!assets.length) return { ...base, status: "needs_data", summary: "没有可读取的 SoilGrids 土壤背景资产。", result: null, sources: [{ source: "soilgrids-250m", date: null, quality: "missing", note: "尚未采集地块土壤背景。" }], findings: [], artifacts: [], limitations: ["需要已采集的 SoilGrids 250 米土壤背景；它只能作为地块级背景，不能表达田内小尺度差异。"], nextActions: [{ code: "collect_soil_background", label: "采集 SoilGrids 土壤背景" }], error: { code: "soil_assets_missing", message: "土壤背景资产不可读取。", retryable: true } };
    const properties = [...new Set(assets.map((asset) => asset.providerAssetId.split("_")[0]).filter((value): value is string => Boolean(value)))];
    const medianAssets = assets.filter((asset) => asset.providerAssetId.endsWith("_Q0.5")).flatMap((asset) => {
      const path = assetPath(asset);
      const match = asset.providerAssetId.match(/^([^_]+)_([^_]+)_Q0\.5$/);
      return path && match ? [{ path, property: match[1]!, depth: match[2]! }] : [];
    });
    let processed: SoilPythonResult | null = null;
    if (this.runners.soil && medianAssets.length) {
      try {
        processed = await this.runners.soil({ assets: medianAssets, boundary: field.boundary });
      } catch (error) {
        return { ...base, status: "failed", summary: "SoilGrids 土壤背景处理未完成。", result: null,
          sources: [{ source: "soilgrids-250m", date: null, quality: "missing", note: "土壤资产已登记，但本次处理未完成。" }], findings: [], artifacts: [], limitations: ["本次未形成可用的地块土壤背景均值。"], nextActions: [{ code: "retry_soil_analysis", label: "重试土壤背景分析" }],
          error: { code: "soil_processing_failed", message: compactProcessingError(error, "土壤处理进程失败。"), retryable: true } };
      }
    }
    if ((processed?.status !== "succeeded" && processed?.status !== "partial") || !processed.measurements.length) return { ...base, status: "needs_data", summary: processed?.error.message ?? "土壤资产未形成可用的地块背景结果。", result: null,
      sources: [{ source: "soilgrids-250m", date: null, quality: "missing", note: "土壤背景资产未形成有效地块统计。" }], findings: [], artifacts: [], limitations: ["需要可读取的 SoilGrids Q0.5 属性资产；250 米数据只作为地块背景。"], nextActions: [{ code: "collect_soil_background", label: "重新采集土壤背景" }],
      error: { code: processed?.error.code ?? "soil_measurements_missing", message: processed?.error.message ?? "没有可用的土壤背景地块统计。", retryable: true } };
    const measurements = processed.measurements;
    const result: SoilBackgroundPayload = { available: true, properties, resolutionMeters: 250, assetCount: assets.length, measurements };
    const artifacts = soilCharts(taskId, id, measurements);
    const partial = processed.status === "partial";
    return { ...base, status: partial ? "partial" : "succeeded", summary: `已读取 SoilGrids 地块土壤背景（${properties.join("、") || "属性未标注"}）。`, result, sources: [{ source: "soilgrids-250m", date: null, quality: partial ? "partial" : "usable", note: partial ? "部分 SoilGrids 属性在地块内有效覆盖不足。" : "SoilGrids 250 米地块级土壤背景。" }], findings: [{ id: "soil-background", summary: "土壤背景用于解释水氮模式，不用于生成田内施肥分区。", sourceDates: [{ source: "soilgrids-250m", date: null }], zoneRef: null }], artifacts, limitations: ["SoilGrids 250 米分辨率不足以判断田内小尺度差异。", ...(partial ? ["部分土壤属性在地块范围内的有效像元不足，已保留各测量项的覆盖率。"] : [])], nextActions: [], error: null };
  }

  private async assessWaterNitrogenEvidence(taskId: string, field: FieldSummary, timeRange: AnalysisTimeRange, previousInspections: WaterNitrogenInspectionContext[]): Promise<AnalysisResult<WaterNitrogenEvidencePayload>> {
    const available = await this.store.list(taskId);
    const optical = available.find((item) => item.kind === "optical_condition") as AnalysisResult<OpticalConditionPayload> | undefined;
    const radar = available.find((item) => item.kind === "radar_change") as AnalysisResult<RadarChangePayload> | undefined;
    const weather = available.find((item) => item.kind === "weather_event") as AnalysisResult<WeatherEventPayload> | undefined;
    const terrain = available.find((item) => item.kind === "terrain_susceptibility") as AnalysisResult<TerrainPayload> | undefined;
    const soil = available.find((item) => item.kind === "soil_background") as AnalysisResult<SoilBackgroundPayload> | undefined;
    const stage = available.find((item) => item.kind === "crop_stage") as AnalysisResult<CropStagePayload> | undefined;
    const base = createAnalysisResultBase({ taskId, toolName: "assess_water_nitrogen_evidence", toolVersion: WATER_NITROGEN_TOOL_VERSION, kind: "assessment", field, timeRange,
      inputResults: [...(optical ? [optical] : []), ...(stage ? [stage] : []), ...(radar ? [radar] : []), ...(weather ? [weather] : []), ...(terrain ? [terrain] : []), ...(soil ? [soil] : [])], parameters: { methodVersion: WATER_NITROGEN_METHOD_VERSION, radarSupportWindowDays: WATER_NITROGEN_SUPPORT_WINDOW_DAYS, inspectionMatchDays: WATER_NITROGEN_INSPECTION_MATCH_DAYS, selectedInspectionCount: previousInspections.length } });
    const availableSources = dedupeSources(optical?.sources ?? []);
    if (!optical?.result || !optical.result.current || !["succeeded", "partial"].includes(optical.status)) return { ...base, status: "needs_data", summary: "没有可展示的近期田况观测。", result: null, sources: availableSources, findings: [], artifacts: optical?.artifacts ?? [], limitations: ["水氮任务至少需要地块内有效 Sentinel-2 观测，才能展示田况和田内差异。"], nextActions: [{ code: "collect_optical_data", label: "采集可用 Sentinel-2 光学日期" }], error: { code: "optical_evidence_missing", message: "缺少光学观测。", retryable: true } };
    const opticalReferenceDate = optical.result.current.observationDate;
    const latestChange = [...optical.result.changes].reverse().find((change) => change.toDate === opticalReferenceDate) ?? null;
    const opticalAgeDays = dateDistanceDays(opticalReferenceDate, timeRange.end.slice(0, 10));
    const observationSources = optical.sources
      .filter((source) => source.source === "sentinel-2" && source.date === opticalReferenceDate && (source.quality === "usable" || source.quality === "partial"))
      .map((source) => ({ ...source, role: "observation" as const }));
    const comparisonSources = latestChange ? optical.sources
      .filter((source) => source.source === "sentinel-2" && source.date === latestChange.fromDate && (source.quality === "usable" || source.quality === "partial"))
      .map((source) => ({ ...source, role: "comparison" as const })) : [];
    const hasRelativeVariation = optical.result.zones.some((zone) => zone.class === "below_average");
    const observation = {
      ndvi: metricMean(optical.result.current.metrics, "ndvi"),
      ndre: metricMean(optical.result.current.metrics, "ndre"),
      reci: metricMean(optical.result.current.metrics, "reci"),
      msavi: metricMean(optical.result.current.metrics, "msavi"),
      ndmi: metricMean(optical.result.current.metrics, "ndmi"),
      ndwi: metricMean(optical.result.current.metrics, "ndwi"),
      variationStatus: hasRelativeVariation ? "visible" as const : "uniform" as const,
    };
    const inspectionMatches = matchWaterNitrogenInspections(previousInspections, [opticalReferenceDate]);
    const alignedInspections = previousInspections.filter((inspection) => inspectionMatches.some((match) => match.status === "aligned" && match.taskId === inspection.taskId && match.findingId === inspection.findingId));
    const refsFor = (role: WaterNitrogenInspectionContext["scoutingRole"]) => alignedInspections.filter((inspection) => inspection.scoutingRole === role).map(({ taskId, findingId }) => ({ taskId, findingId }));
    const lowValueRecords = refsFor("low_value");
    const referenceRecords = refsFor("reference");
    const pairs = alignedInspections.filter((inspection) => inspection.scoutingRole === "low_value").flatMap((low) => alignedInspections
      .filter((reference) => reference.scoutingRole === "reference")
      .map((reference) => ({ lowValue: { taskId: low.taskId, findingId: low.findingId }, reference: { taskId: reference.taskId, findingId: reference.findingId }, offsetDays: dateDistanceDaysEitherDirection(low.observedAt, reference.observedAt) }))
      .filter((pair) => pair.offsetDays <= WATER_NITROGEN_INSPECTION_MATCH_DAYS));
    const fieldComparison: WaterNitrogenEvidencePayload["fieldComparison"] = {
      status: pairs.length ? "paired" : alignedInspections.length ? "unpaired" : "absent",
      lowValueRecords, referenceRecords, generalRecords: refsFor("general"), pairs,
    };
    const usable = (source: AnalysisResult<unknown> | undefined) => source?.result != null && ["succeeded", "partial"].includes(source.status);
    const radarOffset = radar?.result ? dateDistanceDaysEitherDirection(radar.result.afterDate, opticalReferenceDate) : Infinity;
    const radarUsable = usable(radar) && radar?.result?.comparable === true && Boolean(radar.result.beforeDate) && Number.isFinite(radarOffset);
    const radarAligned = radarUsable && radarOffset <= WATER_NITROGEN_SUPPORT_WINDOW_DAYS;
    const historicalWeather = weather?.result?.historical;
    const weatherAligned = usable(weather) && Boolean(historicalWeather?.start && historicalWeather.end && historicalWeather.coverage?.fraction >= 0.8 && inTimeRange(opticalReferenceDate, { start: historicalWeather.start, end: historicalWeather.end }));
    const terrainAligned = usable(terrain);
    const soilAligned = usable(soil) && soil?.result?.available === true;
    const sourceAlignment: WaterNitrogenEvidencePayload["sourceAlignment"] = [
      ...(radar ? [{ resultId: radar.id, kind: radar.kind, status: radarAligned ? "aligned" as const : radarUsable ? "outside_window" as const : "unusable" as const, offsetDays: Number.isFinite(radarOffset) ? radarOffset : null }] : []),
      ...(weather ? [{ resultId: weather.id, kind: weather.kind, status: weatherAligned ? "aligned" as const : usable(weather) && historicalWeather?.coverage?.fraction && historicalWeather.coverage.fraction >= 0.8 ? "outside_window" as const : "unusable" as const, offsetDays: null }] : []),
      ...([terrain, soil].filter((source): source is NonNullable<typeof source> => Boolean(source)).map((source) => ({ resultId: source.id, kind: source.kind, status: (source === terrain ? terrainAligned : soilAligned) ? "aligned" as const : "unusable" as const, offsetDays: null }))),
    ];
    const zones: WaterNitrogenZone[] = optical.result.zones.filter((zone) => zone.class === "below_average").map((zone) => {
      const locations = alignedInspections.map((inspection) => ({ inspection, inside: observationInsideZone([inspection.location.longitude, inspection.location.latitude], zone.zone, zone.holes) }));
      const areaHa = finiteNumber(zone.areaHa);
      return {
        id: `water-nitrogen-${zone.id}`, opticalZoneId: zone.id,
        meanNdvi: finiteNumber(zone.meanNdvi), ndviDeviation: finiteNumber(zone.deviation), metricDeviations: zone.metricDeviations ?? null,
        areaHa, areaFraction: areaHa !== null && field.areaHa > 0 ? areaHa / field.areaHa : null,
        radarOverlap: measureSpatialOverlap(zone.zone, radarAligned && radar?.result ? { resultId: radar.id, zones: radar.result.zones.filter((candidate) => candidate.class === "strong_decrease" || candidate.class === "strong_increase") } : null, zone.holes),
        lowlandOverlap: measureSpatialOverlap(zone.zone, terrainAligned && terrain?.result ? { resultId: terrain.id, zones: terrain.result.zones.filter((candidate) => candidate.class === "low") } : null, zone.holes),
        inspectionRefs: locations.filter((location) => location.inside === true).map(({ inspection: { taskId, findingId } }) => ({ taskId, findingId })),
        inspectionLocationStatus: !locations.length ? "not_evaluated" : locations.some((location) => location.inside === null) ? "invalid_input" : "computed",
        zone: zone.zone,
        ...(zone.holes ? { holes: zone.holes } : {}),
      };
    });
    const attentionAreaHa = zones.every((zone) => zone.areaHa !== null) ? zones.reduce((sum, zone) => sum + zone.areaHa!, 0) : null;
    const attentionAreaFraction = attentionAreaHa !== null && field.areaHa > 0 ? attentionAreaHa / field.areaHa : null;
    const observationStatus = opticalAgeDays !== null && opticalAgeDays <= WATER_NITROGEN_MAX_OPTICAL_AGE_DAYS ? "current" : "stale";
    const evidenceLevel = fieldComparison.status === "paired" ? "field_comparison" : sourceAlignment.some((source) => source.status === "aligned") ? "multi_source" : "optical_only";
    const result: WaterNitrogenEvidencePayload = {
      methodVersion: WATER_NITROGEN_METHOD_VERSION, assessment: hasRelativeVariation ? "variation_visible" : "uniform", referenceDate: opticalReferenceDate,
      cropStage: usable(stage) ? stage!.result ?? null : null, observationCount: optical.result.observations?.length ?? 1,
      validCoverageFraction: optical.result.current.quality?.validFraction ?? null, latestChange,
      attentionAreaHa, attentionAreaFraction, observationAgeDays: opticalAgeDays, observationStatus,
      observation, zones, previousInspections, inspectionMatches, evidenceLevel, sourceAlignment, fieldComparison,
    };
    const alignedResults = [radar, weather, terrain, soil].filter((source): source is NonNullable<typeof source> => Boolean(source && sourceAlignment.some((alignment) => alignment.resultId === source.id && alignment.status === "aligned")));
    const fieldSources: AnalysisResult<unknown>["sources"] = alignedInspections.map((inspection) => ({ source: "field_observation", date: inspection.observedAt, quality: "usable", role: "field_check", note: `现场记录 ${inspection.taskId}/${inspection.findingId}` }));
    const contextSources: AnalysisResult<unknown>["sources"] = alignedResults.flatMap((source) => {
      if (source.kind === "radar_change") return source.sources.filter((item) => item.source === "sentinel-1" && (item.date === radar!.result!.beforeDate || item.date === radar!.result!.afterDate)).map((item) => ({ ...item, role: "context" as const }));
      if (source.kind === "weather_event") return [{ source: "era5-land", date: historicalWeather!.end.slice(0, 10), quality: source.status === "partial" ? "partial" as const : "usable" as const, role: "context" as const, note: `气象窗口 ${historicalWeather!.start} 至 ${historicalWeather!.end}` }];
      return source.sources.map((item) => ({ ...item, role: "context" as const }));
    });
    const sources = dedupeSources([...observationSources, ...comparisonSources, ...contextSources, ...(usable(stage) ? stage!.sources : []), ...fieldSources]);
    const spatialFailures = zones.flatMap((zone) => [["雷达", zone.radarOverlap], ["低洼地形", zone.lowlandOverlap]] as const)
      .filter(([, overlap]) => overlap.status === "invalid_geometry" || overlap.status === "calculation_failed");
    const limitations = [
      ...(observationStatus === "stale" ? [`影像距任务结束日期 ${opticalAgeDays ?? "未知"} 天，观测时间为 ${opticalReferenceDate}。`] : []),
      ...(optical.status === "partial" ? optical.limitations : []),
      ...alignedResults.filter((source) => source.status === "partial").flatMap((source) => source.limitations),
      ...(attentionAreaHa === null ? ["光学分区缺少有效像元面积，关注区面积未计算。"] : []),
      ...(spatialFailures.length ? ["部分分区空间交集未计算成功，对应面积为缺测。"] : []),
    ];
    const summary = `${observationStatus === "stale" ? "历史观测日期" : "观测日期"} ${opticalReferenceDate}，${zones.length} 个同日相对低值区${attentionAreaHa === null ? "，面积未计算" : `，合计 ${attentionAreaHa.toFixed(2)} 公顷`}。已关联 ${alignedInspections.length} 条同期现场记录。`;
    const findings = zones.length ? zones.map((zone) => ({ id: zone.id, summary: `${opticalReferenceDate} 同日相对低值区${zone.meanNdvi === null ? "" : `，NDVI ${zone.meanNdvi.toFixed(3)}`}${zone.areaHa === null ? "" : `，有效像元面积 ${zone.areaHa.toFixed(2)} 公顷`}。`, sourceDates: observationSources.map(({ source, date }) => ({ source, date })), zoneRef: optical.artifacts[0]?.ref ?? null }))
      : [{ id: "water-nitrogen-observation", summary: `${opticalReferenceDate} 可用观测范围内未检出相对低值区。`, sourceDates: observationSources.map(({ source, date }) => ({ source, date })), zoneRef: null }];
    return { ...base, status: optical.status === "partial" || alignedResults.some((source) => source.status === "partial") || observationStatus === "stale" || attentionAreaHa === null || spatialFailures.length > 0 ? "partial" : "succeeded", summary, result, sources, findings,
      artifacts: [...optical.artifacts, ...alignedResults.flatMap((source) => source.artifacts)], limitations, nextActions: [], error: null };
  }

  private async assessFrostRisk(taskId: string, field: FieldSummary, timeRange: AnalysisTimeRange): Promise<AnalysisResult<FrostRiskPayload>> {
    const available = await this.store.list(taskId);
    const weather = available.find((item) => item.kind === "weather_event") as AnalysisResult<WeatherEventPayload> | undefined;
    const terrain = available.find((item) => item.kind === "terrain_susceptibility") as AnalysisResult<TerrainPayload> | undefined;
    const stage = available.find((item) => item.kind === "crop_stage") as AnalysisResult<CropStagePayload> | undefined;
    const base = createAnalysisResultBase({ taskId, toolName: "assess_frost_risk", toolVersion: FROST_TOOL_VERSION, kind: "assessment", field, timeRange,
      inputResults: [...(weather ? [weather] : []), ...(terrain ? [terrain] : []), ...(stage ? [stage] : [])], parameters: { method: FROST_METHOD_VERSION, maximumForecastLeadHours: MAX_FROST_FORECAST_LEAD_HOURS } });
    const forecastSources = (weather?.sources ?? []).filter((source) => source.source === "ecmwf-ifs");
    const sources = dedupeSources([...forecastSources, ...(terrain?.sources ?? []), ...(stage?.sources ?? [])]);
    const forecast = weather?.result?.forecast;
    const forecastIssue = frostForecastIssue(forecast, timeRange);
    if (forecastIssue) {
      return { ...base, status: "needs_data", summary: "缺少有效的未来低温预报，暂不能形成霜冻风险预警。", result: null, sources, findings: [], artifacts: terrain?.artifacts ?? [],
        limitations: ["霜冻预警需要带生成时间和有效期的 ECMWF IFS 低温预报。"],
        nextActions: [{ code: "collect_weather_forecast", label: "采集最新天气预报" }],
        error: { code: "frost_forecast_invalid", message: forecastIssue, retryable: true } };
    }
    const validForecast = forecast!;
    const triggerWindow = coldestForecastWindow(validForecast);
    const minimum = triggerWindow?.minTemperatureC ?? validForecast.minTemperatureC!;
    const coldDurationHours = triggerWindow ? durationHours(triggerWindow.start, triggerWindow.end) : 0;
    const forecastWindow = { start: triggerWindow?.start ?? validForecast.start, end: triggerWindow?.end ?? validForecast.end };
    const forecastComplete = validForecast.coverage.fraction >= 0.8;
    const terrainComplete = terrain?.status === "succeeded" && Boolean(terrain.result);
    const terrainStatus: FrostRiskPayload["terrainStatus"] = terrainComplete ? "available" : terrain?.result ? "limited" : "missing";
    const frostZones = (risk: "high" | "watch"): FrostRiskZone[] => {
      const terrainValidPixels = terrain?.result?.metrics?.validPixelCount ?? 0;
      return (terrain?.result?.zones ?? []).filter((zone) => zone.class === "low").map((zone) => {
        const areaHa = terrainValidPixels > 0 ? roundMetric(field.areaHa * zone.validPixelCount / terrainValidPixels) : 0;
        return { id: zone.id, risk, relativeElevationM: zone.relativeElevationM, areaHa, areaFraction: field.areaHa > 0 ? roundMetric(areaHa / field.areaHa) : 0, zone: zone.zone };
      });
    };
    const forecastFacts = { forecastRunAt: validForecast.runAt, forecastCoverageFraction: validForecast.coverage.fraction, forecastGridDistanceKm: validForecast.gridDistanceKm, terrainStatus };
    if (!stage?.result) {
      const zones = frostZones("watch");
      const result: FrostRiskPayload = { methodVersion: FROST_METHOD_VERSION, risk: "undetermined", ...forecastFacts, forecastMinTemperatureC: minimum, forecastWindow, coldDurationHours, cropStage: null, stageSensitivity: "unknown", zones };
      const stageLimitations = stage?.limitations?.length ? stage.limitations : ["缺少有效播种日期，当前不能判断玉米生育期敏感性。"];
      const stageActions = stage?.nextActions?.length ? stage.nextActions : [{ code: "add_planting_date", label: "补充播种日期以完成霜冻风险判断" }];
      return { ...base, status: "partial", summary: `已识别未来低温过程：最低气温 ${minimum.toFixed(1)}℃，持续约 ${coldDurationHours.toFixed(0)} 小时；缺少有效生育期，暂不发布霜冻风险等级。`, result, sources,
        findings: [{ id: "frost-weather-hazard", summary: `预报最低气温 ${minimum.toFixed(1)}℃、持续约 ${coldDurationHours.toFixed(0)} 小时；${zones.length ? `已标出 ${zones.length} 个低洼关注区。` : "未形成低洼空间关注区。"}`, sourceDates: sources.map((source) => ({ source: source.source, date: source.date })), zoneRef: terrain?.artifacts[0]?.ref ?? null }],
        artifacts: terrain?.artifacts ?? [], limitations: [...stageLimitations, "当前只发布低温过程，不把未知生育期解释为作物霜冻风险。", ...(!forecastComplete ? [`IFS 在任务窗口内的预报时间覆盖率为 ${(validForecast.coverage.fraction * 100).toFixed(1)}%。`] : []), ...(!terrainComplete ? ["地形数据不完整，低洼关注区可能缺失。"] : [])], nextActions: stageActions, error: null };
    }
    const stageSensitivity = frostStageSensitivity(stage.result.stage);
    const risk = frostRiskLevel(minimum, stageSensitivity, coldDurationHours);
    const zones = risk === "normal" ? [] : frostZones(risk === "high" ? "high" : "watch");
    const result: FrostRiskPayload = { methodVersion: FROST_METHOD_VERSION, risk, ...forecastFacts, forecastMinTemperatureC: minimum, forecastWindow, coldDurationHours, cropStage: stage.result, stageSensitivity, zones };
    const label = risk === "high" ? "高风险" : risk === "watch" ? "关注" : "当前预报未触发霜冻关注门槛";
    const sensitivityLabel = stageSensitivity === "high" ? "高敏感" : stageSensitivity === "medium" ? "中等敏感" : "低敏感";
    return { ...base, status: terrainComplete && forecastComplete ? "succeeded" : "partial", summary: `${label}：触发窗口最低气温 ${minimum.toFixed(1)}℃，低温持续约 ${coldDurationHours.toFixed(0)} 小时，当前${stage.result.label}为${sensitivityLabel}阶段。`, result, sources, findings: [{ id: "frost-risk", summary: `预报最低气温 ${minimum.toFixed(1)}℃、持续约 ${coldDurationHours.toFixed(0)} 小时，生育期敏感性${sensitivityLabel}；${zones.length ? `已标出 ${zones.length} 个低洼关注区。` : "未形成低洼空间关注区。"}`, sourceDates: sources.map((source) => ({ source: source.source, date: source.date })), zoneRef: terrain?.artifacts[0]?.ref ?? null }], artifacts: terrain?.artifacts ?? [], limitations: ["这是未来预报风险，不是已发生霜冻；IFS 约 0.25° 网格不能表达田内微气候。", ...(!forecastComplete ? [`IFS 在任务窗口内的预报时间覆盖率为 ${(validForecast.coverage.fraction * 100).toFixed(1)}%。`] : []), ...(!terrain?.result ? ["缺少 DEM，暂不能形成地形易发区。"] : terrain.status === "partial" ? ["DEM 有效覆盖受限，低洼关注区不完整。"] : [])], nextActions: risk === "normal" ? [] : [{ code: "inspect_frost_risk", label: zones.length ? "优先核查低洼区和当前生育期敏感区域的最低温与霜冻迹象" : "核查当前生育期敏感区域的最低温与霜冻迹象" }], error: null };
  }
}

function dateDistanceDays(left: string, right: string): number | null {
  const leftTime = Date.parse(`${left}T00:00:00Z`);
  const rightTime = Date.parse(`${right}T00:00:00Z`);
  if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) return null;
  return Math.max(0, Math.floor((rightTime - leftTime) / 86_400_000));
}

function frostForecastIssue(forecast: WeatherEventPayload["forecast"] | undefined, timeRange: AnalysisTimeRange): string | null {
  if (!forecast || forecast.minTemperatureC === null || !Number.isFinite(forecast.minTemperatureC)) return "缺少有效的未来低温预报。";
  const runAt = Date.parse(forecast.runAt);
  const start = forecast.start ? Date.parse(forecast.start) : Number.NaN;
  const end = forecast.end ? Date.parse(forecast.end) : Number.NaN;
  const taskStart = Date.parse(timeRange.start);
  const taskEnd = Date.parse(timeRange.end);
  if (![runAt, start, end, taskStart, taskEnd].every(Number.isFinite) || start > end) return "天气预报缺少合法的生成时间或有效窗口。";
  if (runAt > start) return "天气预报生成时间晚于其有效窗口起点。";
  if ((start - runAt) / 3_600_000 > MAX_FROST_FORECAST_LEAD_HOURS) return `天气预报提前量超过 ${MAX_FROST_FORECAST_LEAD_HOURS} 小时。`;
  if (end < taskStart || start > taskEnd) return "天气预报有效窗口不覆盖本次霜冻任务时段。";
  return null;
}

function coldestForecastWindow(forecast: NonNullable<WeatherEventPayload["forecast"]>): { start: string; end: string; minTemperatureC: number } | null {
  return [...forecast.coldWindows].filter((window) => Number.isFinite(window.minTemperatureC) && Number.isFinite(Date.parse(window.start)) && Number.isFinite(Date.parse(window.end))).sort((left, right) => left.minTemperatureC - right.minTemperatureC)[0] ?? null;
}

function durationHours(start: string, end: string): number {
  return Math.max(0, (Date.parse(end) - Date.parse(start)) / 3_600_000);
}

function dateDistanceDaysEitherDirection(left: string, right: string): number {
  const leftTime = Date.parse(`${left}T00:00:00Z`);
  const rightTime = Date.parse(`${right}T00:00:00Z`);
  if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) return Number.POSITIVE_INFINITY;
  return Math.floor(Math.abs(rightTime - leftTime) / 86_400_000);
}

function roundMetric(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function matchWaterNitrogenInspections(inspections: WaterNitrogenInspectionContext[], imageDates: string[]): WaterNitrogenInspectionMatch[] {
  return inspections.map((inspection) => {
    const nearest = imageDates.map((date) => ({ date, offsetDays: dateDistanceDaysEitherDirection(inspection.observedAt, date) }))
      .filter((candidate) => Number.isFinite(candidate.offsetDays)).sort((left, right) => left.offsetDays - right.offsetDays)[0];
    return { taskId: inspection.taskId, findingId: inspection.findingId, observedAt: inspection.observedAt, matchedImageDate: nearest?.date ?? null, offsetDays: nearest?.offsetDays ?? null,
      status: !nearest ? "unmatched" : nearest.offsetDays <= WATER_NITROGEN_INSPECTION_MATCH_DAYS ? "aligned" : "historical" };
  });
}

function metricMean(metrics: OpticalConditionPayload["current"]["metrics"], key: keyof OpticalConditionPayload["current"]["metrics"]): number | null {
  const value = metrics[key]?.mean;
  return finiteNumber(value);
}

function finiteNumber(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) ? value : null; }

function supportRangeAround(referenceDate: string | undefined, fallback: AnalysisTimeRange, beforeDays: number, afterDays: number): AnalysisTimeRange {
  if (!referenceDate) return fallback;
  const reference = Date.parse(`${referenceDate}T12:00:00.000Z`);
  return {
    start: new Date(reference - beforeDays * 86_400_000).toISOString(),
    end: new Date(reference + afterDays * 86_400_000).toISOString(),
  };
}

function supportRangeBefore(referenceDate: string | undefined, fallback: AnalysisTimeRange, days: number): AnalysisTimeRange {
  if (!referenceDate) return fallback;
  const reference = Date.parse(`${referenceDate}T23:59:59.999Z`);
  return {
    start: new Date(reference - days * 86_400_000).toISOString(),
    end: new Date(reference).toISOString(),
  };
}

function frostStageSensitivity(stage: CropStagePayload["stage"]): "high" | "medium" | "low" {
  if (stage === "emergence" || stage === "silking" || stage === "grain_fill") return "high";
  if (stage === "jointing" || stage === "tasseling") return "medium";
  return "low";
}

function frostRiskLevel(minimumTemperatureC: number, sensitivity: "high" | "medium" | "low", duration: number): "high" | "watch" | "normal" {
  if (minimumTemperatureC <= -2) return "high";
  if (minimumTemperatureC <= 0) {
    if (sensitivity === "high" && duration >= 3) return "high";
    if (sensitivity === "medium" && duration >= 6) return "high";
    return "watch";
  }
  if (minimumTemperatureC <= 2) {
    if (sensitivity === "high" && duration >= 3) return "watch";
    if (sensitivity === "medium" && duration >= 6) return "watch";
  }
  return "normal";
}

interface RadarPythonResult {
  status: "succeeded" | "needs_data";
  quality: { totalPixelCount: number; validPixelCount: number; validFraction: number };
  metrics: { beforeVvDb: number; afterVvDb: number; vvDeltaDb: number; beforeVhDb: number; afterVhDb: number; vhDeltaDb: number; changedPixelFraction: number } | null;
  observation?: { meanVvDb: number; meanVhDb: number } | null;
  zones: RadarZone[];
  visualizations?: VisualizationOutput[];
  error: { code: string | null; message: string | null };
}

interface WeatherPythonResult extends WeatherEventPayload {
  status: "succeeded" | "partial" | "needs_data";
  error: { code: string | null; message: string | null };
}

interface TerrainPythonResult {
  status: "succeeded" | "partial" | "needs_data";
  metrics: { minElevationM: number; meanElevationM: number; maxElevationM: number; meanSlopeDegrees: number; lowElevationThresholdM: number; minimumLowlandRelativeDepthM: number; validPixelCount: number; totalPixelCount: number; validFraction: number } | null;
  zones: TerrainZone[];
  visualizations?: VisualizationOutput[];
  error: { code: string | null; message: string | null };
}

interface SoilPythonResult {
  status: "succeeded" | "partial" | "needs_data";
  measurements: SoilMeasurement[];
  error: { code: string | null; message: string | null };
}

interface VisualizationOutput {
  fileName: string;
  metric: "vv" | "vh" | "radar_change" | "elevation" | "slope" | "lowland";
  label: string;
  bounds: [[number, number], [number, number], [number, number], [number, number]];
  min: number;
  max: number;
  resolutionMeters: number;
}

interface RadarObservation {
  date: string;
  asset: AcquiredAsset;
  orbitDirection: string | null;
  relativeOrbitNumber: number | null;
}

interface RadarPair { before: RadarObservation; after: RadarObservation }

function compactProcessingError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : fallback;
  const firstLine = message.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim();
  return firstLine && firstLine.length <= 240 ? firstLine : fallback;
}

function weatherCharts(taskId: string, resultId: string, result: WeatherPythonResult): AnalysisArtifact[] {
  const artifacts: AnalysisArtifact[] = [];
  if (result.historical) {
    const daily = result.historical.daily ?? [];
    artifacts.push({
      ref: `analysis/${taskId}/${resultId}-historical-weather`,
      kind: "chart",
      chart: { source: "era5-land", title: "历史降雨", unit: "mm", series: [{ label: "每日降雨", points: daily.length ? daily.map((item) => ({ label: item.date, value: item.rainfallMm })) : [{ label: "累计", value: result.historical.totalRainfallMm }, { label: "最大24小时", value: result.historical.max24hRainfallMm }] }] },
    });
    const historicalTemperatureSeries = daily.length ? [
      { label: "最低气温", points: daily.filter((item) => item.minTemperatureC !== null).map((item) => ({ label: item.date, value: item.minTemperatureC! })) },
      { label: "最高气温", points: daily.filter((item) => item.maxTemperatureC !== null).map((item) => ({ label: item.date, value: item.maxTemperatureC! })) },
    ].filter((series) => series.points.length) : [];
    if (historicalTemperatureSeries.length || result.historical.minTemperatureC !== null) artifacts.push({
      ref: `analysis/${taskId}/${resultId}-historical-temperature`,
      kind: "chart",
      chart: { source: "era5-land", title: "历史气温", unit: "℃", series: historicalTemperatureSeries.length ? historicalTemperatureSeries : [{ label: "气温", points: [{ label: "窗口最低", value: result.historical.minTemperatureC! }] }] },
    });
  }
  if (result.forecast) {
    const daily = result.forecast.daily ?? [];
    artifacts.push({
      ref: `analysis/${taskId}/${resultId}-forecast-rainfall`,
      kind: "chart",
      chart: { source: "ecmwf-ifs", title: "预报降雨", unit: "mm", series: [{ label: "每日降雨", points: daily.length ? daily.map((item) => ({ label: item.date, value: item.rainfallMm })) : [{ label: "预报窗口", value: result.forecast.cumulativeRainfallMm }] }] },
    });
    const forecastTemperatureSeries = daily.length ? [
      { label: "最低气温", points: daily.filter((item) => item.minTemperatureC !== null).map((item) => ({ label: item.date, value: item.minTemperatureC! })) },
      { label: "最高气温", points: daily.filter((item) => item.maxTemperatureC !== null).map((item) => ({ label: item.date, value: item.maxTemperatureC! })) },
    ].filter((series) => series.points.length) : [];
    if (forecastTemperatureSeries.length || result.forecast.minTemperatureC !== null) artifacts.push({
      ref: `analysis/${taskId}/${resultId}-forecast-temperature`,
      kind: "chart",
      chart: { source: "ecmwf-ifs", title: "预报气温", unit: "℃", series: forecastTemperatureSeries.length ? forecastTemperatureSeries : [{ label: "气温", points: [{ label: "预报窗口", value: result.forecast.minTemperatureC! }] }] },
    });
  }
  return artifacts;
}

function soilCharts(taskId: string, resultId: string, measurements: SoilMeasurement[]): AnalysisArtifact[] {
  const byProperty = new Map<string, SoilMeasurement[]>();
  for (const measurement of measurements) byProperty.set(measurement.property, [...(byProperty.get(measurement.property) ?? []), measurement]);
  const depthOrder = ["0-5cm", "5-15cm", "15-30cm", "30-60cm", "60-100cm", "100-200cm"];
  return [...byProperty.entries()].map(([property, values]) => {
    const sorted = values.sort((left, right) => depthOrder.indexOf(left.depth) - depthOrder.indexOf(right.depth));
    const first = sorted[0]!;
    return {
      ref: `analysis/${taskId}/${resultId}-soil-${property}`,
      kind: "chart",
      chart: { source: "soilgrids-250m", title: first.label, unit: first.unit, series: [{ label: "Q0.5 地块均值", points: sorted.map((item) => ({ label: item.depth, value: item.mean })) }] },
    };
  });
}

function collectRadarObservations(acquisitions: DataAcquisitionRun[], timeRange: AnalysisTimeRange): RadarObservation[] {
  const observations = new Map<string, RadarObservation>();
  for (const run of acquisitions) {
    const source = run.sources.find((item) => item.source === "sentinel-1");
    if (!source) continue;
    for (const asset of source.selectedAssets) {
      const date = asset.capturedAt?.slice(0, 10);
      if (asset.role !== "radar" || asset.accessStatus !== "retrieved" || !date || !inTimeRange(date, timeRange)) continue;
      observations.set(asset.providerAssetId, { date, asset, orbitDirection: metadataString(source, "orbitDirection"), relativeOrbitNumber: metadataNumber(source, "relativeOrbitNumber") });
    }
  }
  return [...observations.values()].sort((left, right) => left.date.localeCompare(right.date));
}

function selectRadarPair(observations: RadarObservation[], targetDate?: string): RadarPair | null {
  const groups = new Map<string, RadarObservation[]>();
  for (const item of observations) {
    if (!item.orbitDirection || item.relativeOrbitNumber === null) continue;
    const key = `${item.orbitDirection}:${item.relativeOrbitNumber}`;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  const pairs = [...groups.values()].filter((items) => items.length >= 2).flatMap((items) => {
    const sorted = items.sort((left, right) => left.date.localeCompare(right.date));
    return sorted.slice(1).map((after, index) => ({ before: sorted[index]!, after }));
  });
  if (targetDate) return pairs.sort((left, right) => dateDistanceDaysEitherDirection(left.after.date, targetDate) - dateDistanceDaysEitherDirection(right.after.date, targetDate) || right.after.date.localeCompare(left.after.date))[0] ?? null;
  return pairs.sort((left, right) => right.after.date.localeCompare(left.after.date))[0] ?? null;
}

function collectAssets(acquisitions: DataAcquisitionRun[], sourceName: SourceAcquisitionResult["source"], role: AcquiredAsset["role"], timeRange?: AnalysisTimeRange): AcquiredAsset[] {
  const assets = new Map<string, AcquiredAsset>();
  for (const run of acquisitions) {
    const source = run.sources.find((item) => item.source === sourceName);
    for (const asset of source?.selectedAssets ?? []) {
      if (asset.role !== role || asset.accessStatus !== "retrieved" || !asset.artifactRef) continue;
      const assetStart = asset.validFrom ?? asset.capturedAt;
      const assetEnd = asset.validTo ?? asset.capturedAt;
      if (timeRange && assetStart && assetEnd && (Date.parse(assetEnd) < Date.parse(timeRange.start) || Date.parse(assetStart) > Date.parse(timeRange.end))) continue;
      assets.set(asset.artifactRef, asset);
    }
  }
  return [...assets.values()].sort((left, right) => (right.validTo ?? right.capturedAt ?? "").localeCompare(left.validTo ?? left.capturedAt ?? ""));
}

function pairSources(pair: RadarPair, quality: "usable" | "partial" | "missing"): AnalysisResult<unknown>["sources"] {
  return [{ source: "sentinel-1", date: pair.before.date, quality, note: `同轨灾前观测，轨道 ${pair.before.relativeOrbitNumber}。` }, { source: "sentinel-1", date: pair.after.date, quality, note: `同轨灾后观测，轨道 ${pair.after.relativeOrbitNumber}。` }];
}

function observationArtifactRef(artifacts: AnalysisArtifact[], date: string): string | null {
  return artifacts.find((artifact) => artifact.visualization?.source === "sentinel-1" && artifact.visualization.date === date)?.ref ?? null;
}

function assetPath(asset: AcquiredAsset): string | null { return asset.artifactRef ? resolveAcquisitionArtifact(asset.artifactRef) : null; }
function inTimeRange(date: string, range: AnalysisTimeRange): boolean { return date >= range.start.slice(0, 10) && date <= range.end.slice(0, 10); }
function sameInstant(left: string | null, right: string | null): boolean { return left !== null && right !== null && Date.parse(left) === Date.parse(right); }
function metadataString(source: SourceAcquisitionResult, key: string): string | null { const value = source.quality.metadata[key]; return typeof value === "string" ? value : null; }
function metadataNumber(source: SourceAcquisitionResult, key: string): number | null { const value = source.quality.metadata[key]; return typeof value === "number" && Number.isFinite(value) ? value : null; }

function dedupeSources(sources: AnalysisResult<unknown>["sources"]): AnalysisResult<unknown>["sources"] {
  const unique = new Map(sources.map((source) => [`${source.source}:${source.date}:${source.note}`, source]));
  return [...unique.values()];
}

function dedupeSourceDates(sources: Array<{ source: string; date: string | null }>): Array<{ source: string; date: string | null }> {
  const unique = new Map(sources.map((source) => [`${source.source}:${source.date}`, source]));
  return [...unique.values()];
}

function rainEventSourceDates(events: Array<{ start: string; end: string; rainfallMm: number }>): string[] {
  return [...new Set(events.flatMap((event) => [event.start.slice(0, 10), event.end.slice(0, 10)]).filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)))].sort();
}

async function writeZonesArtifact<T extends { id: string; zone: number[][]; holes?: number[][][] }>(taskId: string, resultId: string, field: FieldSummary, zones: T[], label: string): Promise<string> {
  const ref = `analysis/${taskId}/${resultId}-${label}.geojson`;
  const target = resolve(import.meta.dirname, "../../../runtime/artifacts", ref);
  await mkdir(resolve(target, ".."), { recursive: true });
  const features = zones.map(({ zone, holes, ...properties }) => ({ type: "Feature", properties, geometry: { type: "Polygon", coordinates: [zone, ...(holes ?? [])] } }));
  await writeFile(target, JSON.stringify({ type: "FeatureCollection", fieldId: field.id, features }));
  return ref;
}
