import type { AnalysisArtifact, AnalysisResult, AnalysisTimeRange, DataAcquisitionRun, FieldSummary, AcquiredAsset, VisualizationMetric } from "@chernozem/contracts";
import type { ControlledAnalysisTool } from "@chernozem/agent-runtime";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { createAnalysisResultBase } from "./analysis-result-base.js";
import type { AnalysisResultStore } from "./analysis-store.js";
import { resolveAcquisitionArtifact } from "./data-acquisition.js";
import { runPythonTool } from "./python-tool-runner.js";
import { compareRelativeZoneCoverage, type RelativeZoneCoverageChange } from "./spatial-evidence.js";

const OPTICAL_TOOL_VERSION = "optical-condition-v8";
const OPTICAL_ZONING_METHOD = "ndvi-quantile-connected-v2" as const;
const MIN_NDVI_ROBUST_RANGE = 0.05;
const CROP_STAGE_TOOL_VERSION = "crop-stage-v1";
const GROWTH_ASSESSMENT_TOOL_VERSION = "growth-assessment-v2";
const GROWTH_ZONE_COMPARISON_METHOD = "relative-class-footprint-overlap-v1" as const;
const CROP_STAGE_RULE_VERSION = "corn-days-after-planting-v1";
const MEANINGFUL_NDVI_CHANGE = 0.03;
const MAX_GROWTH_OBSERVATION_AGE_DAYS = 21;

export interface OpticalConditionPayload {
  current: OpticalObservation;
  observations: OpticalObservation[];
  changes: OpticalChange[];
  zoningMethod: typeof OPTICAL_ZONING_METHOD;
  zoningQuality: OpticalZoningQuality;
  zones: OpticalZone[];
  zoneSnapshots?: OpticalZoneSnapshot[];
}

export interface OpticalZoneSnapshot {
  observationDate: string;
  zones: OpticalZone[];
}

export interface OpticalZoningQuality {
  robustRange: number;
  minimumRobustRange: number;
  variationVisible: boolean;
}

interface OpticalObservation {
  observationDate: string;
  metrics: {
    ndvi: MetricSummary;
    ndre: MetricSummary;
    reci: MetricSummary;
    msavi: MetricSummary;
    ndmi: MetricSummary;
    ndwi: MetricSummary;
  };
  quality: {
    totalPixelCount: number;
    validPixelCount: number;
    validFraction: number;
    cloudAffectedFraction: number;
    flags: string[];
  };
}

interface OpticalChange {
  fromDate: string;
  toDate: string;
  ndviDelta: number;
  ndreDelta: number;
  reciDelta: number;
  msaviDelta: number;
  ndmiDelta: number;
  ndwiDelta: number;
}

interface MetricSummary {
  mean: number;
  min: number;
  max: number;
  validPixelCount: number;
  totalPixelCount: number;
  coverageFraction: number;
}

interface OpticalZone {
  id: string;
  row: number;
  column: number;
  meanNdvi: number;
  deviation: number;
  areaHa?: number;
  metricDeviations?: {
    ndre: number;
    reci: number;
    msavi: number;
    ndmi: number;
    ndwi: number;
  };
  class: "below_average" | "near_average" | "above_average";
  validPixelCount: number;
  zone: number[][];
  /** Interior rings retain cloud/no-data gaps and enclosed components. */
  holes?: number[][][];
}

export interface CropStagePayload {
  stage: "sowing" | "emergence" | "jointing" | "tasseling" | "silking" | "grain_fill" | "maturity";
  label: string;
  referenceDate: string;
  daysAfterPlanting: number;
  confidence: "medium" | "low";
  ruleVersion: typeof CROP_STAGE_RULE_VERSION;
}

export interface GrowthAssessmentPayload {
  stage: CropStagePayload | null;
  status: "observed" | "watch";
  trend: "increasing" | "stable" | "declining" | "insufficient_timeseries";
  meanNdvi: number;
  latestObservationDate: string;
  observationCount: number;
  observationWindow: {
    requestedPeriod: AnalysisTimeRange | null;
    datesWithinPeriod: string[];
    comparisonDatesOutsidePeriod: string[];
  };
  areaBasis: {
    fieldAreaHa: number;
    belowAverageAreaFractionDenominator: "field_area";
  };
  validCoverageFraction: number;
  observationAgeDays: number | null;
  observationStatus: "current" | "stale";
  latestChange: OpticalChange | null;
  belowAverageZoneCount: number;
  belowAverageAreaHa: number | null;
  belowAverageAreaFraction: number | null;
  aboveAverageZoneCount: number;
  /** Small, user-facing region summary; geometry remains in the map artifact. */
  weakZones?: Array<{
    id: string;
    areaHa: number | null;
    meanNdvi: number | null;
    deviation: number | null;
    rank: number;
  }>;
  zoneChange?: GrowthZoneChange;
}

export interface GrowthZoneChange extends Omit<RelativeZoneCoverageChange, "status"> {
  method: typeof GROWTH_ZONE_COMPARISON_METHOD;
  status: RelativeZoneCoverageChange["status"] | "not_comparable";
  reason: "missing_current_snapshot" | "missing_previous_snapshot" | "ambiguous_snapshot_date" | "empty_observed_coverage" | null;
  fromDate: string | null;
  toDate: string;
  previousBelowZoneCount: number | null;
  currentBelowZoneCount: number | null;
  previousBelowAreaHa: number | null;
  currentBelowAreaHa: number | null;
}

export type OpticalRunner = (input: unknown) => Promise<OpticalPythonResult>;

export class GrowthAnalysisService {
  constructor(
    private readonly store: AnalysisResultStore,
    pythonExecutable = process.env.PYTHON_EXECUTABLE ?? "python",
    opticalRunner?: OpticalRunner,
  ) {
    this.opticalRunner = opticalRunner ?? ((input) => runPythonTool<OpticalPythonResult>("analyze-optical.py", input, pythonExecutable));
  }

  private readonly opticalRunner: OpticalRunner;

  createTools(field: FieldSummary, acquisitions: DataAcquisitionRun[], observationRange?: AnalysisTimeRange, targetRange: AnalysisTimeRange | undefined = observationRange): ControlledAnalysisTool[] {
    return [
      {
        name: "analyze_optical_condition",
        execute: async ({ taskId }) => this.save(await this.analyzeOpticalCondition(taskId, field, acquisitions, observationRange)),
      },
      {
        name: "estimate_crop_stage",
        execute: async ({ taskId }) => this.save(await this.estimateCropStage(taskId, field, acquisitions, observationRange)),
      },
      {
        name: "assess_growth_status",
        execute: async ({ taskId }) => this.save(await this.assessGrowthStatus(taskId, field, targetRange)),
      },
    ];
  }

  private async save<T>(result: AnalysisResult<T>): Promise<AnalysisResult<T>> {
    await this.store.save(result as AnalysisResult<unknown>);
    return result;
  }

  private async analyzeOpticalCondition(taskId: string, field: FieldSummary, acquisitions: DataAcquisitionRun[], timeRange?: AnalysisTimeRange): Promise<AnalysisResult<OpticalConditionPayload>> {
    const base = createAnalysisResultBase({
      taskId,
      toolName: "analyze_optical_condition",
      toolVersion: OPTICAL_TOOL_VERSION,
      kind: "optical_condition",
      field,
      acquisitions,
      timeRange,
      parameters: { minimumComparableDates: 2, zoningMethod: OPTICAL_ZONING_METHOD, minimumNdviRobustRange: MIN_NDVI_ROBUST_RANGE },
    });
    const { id } = base;
    const candidates = collectOpticalCandidates(acquisitions, timeRange);
    const complete = candidates.filter((candidate): candidate is CompleteOpticalCandidate => Boolean(candidate.spectral10 && candidate.spectral20 && candidate.scl));
    const emptyArtifacts: AnalysisArtifact[] = [];
    const emptyActions: Array<{ code: string; label: string; zoneRef?: string }> = [];
    if (!complete.length) {
      const sourceDate = candidates.at(-1)?.date ?? null;
      return { ...base, status: "needs_data", summary: "当前没有完整的 Sentinel-2 光学分析资产。", result: null,
        sources: [{ source: "sentinel-2", date: sourceDate, quality: "missing", note: candidates.length ? "已登记的观测日期缺少完整光谱或 SCL 资产。" : "没有找到 Sentinel-2 采集结果。" }],
        findings: [], artifacts: emptyArtifacts, limitations: ["需要同一观测日期的 10 米光谱、20 米光谱和 SCL 质量层。"], nextActions: emptyActions,
        error: { code: "optical_assets_missing", message: "缺少可读取的 Sentinel-2 光学资产。", retryable: true } };
    }
    const observations: OpticalObservation[] = [];
    const zoneSnapshots: OpticalZoneSnapshot[] = [];
    const partialObservations: OpticalObservation[] = [];
    const sources: AnalysisResult<unknown>["sources"] = [];
    const unavailableErrors: Array<{ code: string; message: string; retryable: boolean }> = [];
    const visualizationArtifacts: AnalysisArtifact[] = [];
    const visualizationDirectoryRef = `analysis/${taskId}/${id}`;
    const visualizationDirectory = resolve(import.meta.dirname, "../../../runtime/artifacts", visualizationDirectoryRef);
    await mkdir(visualizationDirectory, { recursive: true });
    let processingFailureCount = 0;
    for (const candidate of complete) {
      const paths = [candidate.spectral10, candidate.spectral20, candidate.scl].map((asset) => assetPath(asset));
      if (paths.some((path) => path === null)) {
        sources.push({ source: "sentinel-2", date: candidate.date, quality: "missing", note: "采集清单中的影像文件不可读取。" });
        continue;
      }
      try {
        const payload = await this.opticalRunner({ spectral10: paths[0], spectral20: paths[1], scl: paths[2], boundary: field.boundary, sourceDate: candidate.date, outputDir: visualizationDirectory });
        if (payload.metrics && (payload.status === "succeeded" || payload.status === "partial")) {
          if (payload.zoningMethod !== OPTICAL_ZONING_METHOD || !isOpticalZoningQuality(payload.zoningQuality)) {
            throw new Error("光学处理结果缺少当前版本的分区质量信息。");
          }
          const observation = { observationDate: candidate.date, metrics: payload.metrics, quality: payload.quality };
          candidate.zones = payload.zones.map((zone) => ({
            ...zone,
            areaHa: zoneAreaHa(field.areaHa, zone.validPixelCount, payload.quality.totalPixelCount),
          }));
          candidate.zoningQuality = payload.zoningQuality;
          zoneSnapshots.push({ observationDate: candidate.date, zones: candidate.zones });
          visualizationArtifacts.push(...(payload.visualizations ?? []).map((visualization) => ({
            ref: `${visualizationDirectoryRef}/${visualization.fileName}`,
            kind: "map" as const,
            visualization: {
              type: "raster" as const,
              source: "sentinel-2",
              metric: visualization.metric,
              date: candidate.date,
              bounds: visualization.bounds,
              min: visualization.min,
              max: visualization.max,
              resolutionMeters: visualization.resolutionMeters,
              unit: visualization.metric === "true_color" ? "reflectance" : "index",
              label: visualization.label,
            },
          })));
          if (payload.status === "succeeded") {
            observations.push(observation);
            sources.push({ source: "sentinel-2", date: candidate.date, quality: "usable", note: "Sentinel-2 L2A 光谱与 SCL 已读取。" });
          } else {
            partialObservations.push(observation);
            sources.push({ source: "sentinel-2", date: candidate.date, quality: "partial", note: "地块内有效像元未达到 80%，保留为受限观测；有合格日期时不参与田况时序和跨期变化判断。" });
          }
        } else {
          sources.push({ source: "sentinel-2", date: candidate.date, quality: "missing", note: payload.error.message ?? "地块内没有可用于分析的有效像元。" });
          if (payload.error.code) unavailableErrors.push({ code: payload.error.code, message: payload.error.message ?? "当前光学时相不可用。", retryable: payload.error.retryable });
        }
      } catch (error) {
        processingFailureCount += 1;
        sources.push({ source: "sentinel-2", date: candidate.date, quality: "missing", note: error instanceof Error ? error.message : "光学处理进程失败。" });
      }
    }
    if (!observations.length && partialObservations.length) observations.push(partialObservations.at(-1)!);
    if (!observations.length) {
      const failed = processingFailureCount === complete.length;
      const distinctCodes = [...new Set(unavailableErrors.map((error) => error.code))];
      const explicitError = distinctCodes.length === 1 ? unavailableErrors[0] : null;
      const limitation = distinctCodes.includes("cloud_contaminated") ? "当前时段的地块光学像元受云污染。"
        : distinctCodes.includes("no_field_coverage") ? "当前时段的影像不覆盖该地块。"
          : "当前时段缺少可用于地块分析的有效光学像元。";
      return { ...base, status: failed ? "failed" : "needs_data", summary: failed ? "Sentinel-2 光学处理失败。" : explicitError?.message ?? "所有已采集光学时相均不可用于地块分析。", result: null,
        sources, findings: [], artifacts: emptyArtifacts, limitations: [limitation], nextActions: emptyActions,
        error: failed ? { code: "optical_processing_failed", message: "光学处理进程未能读取任何时相。", retryable: true }
          : explicitError ?? { code: "no_usable_optical_observation", message: "多个光学时相分别存在云污染、无覆盖或有效像元不足。", retryable: true } };
    }
    const current = observations.at(-1)!;
    const currentCandidate = complete.find((candidate) => candidate.date === current.observationDate)!;
    const changes = observations.slice(1).map((observation, index) => ({
      fromDate: observations[index]!.observationDate,
      toDate: observation.observationDate,
      ndviDelta: roundMetric(observation.metrics.ndvi.mean - observations[index]!.metrics.ndvi.mean),
      ndreDelta: roundMetric(observation.metrics.ndre.mean - observations[index]!.metrics.ndre.mean),
      reciDelta: roundMetric(observation.metrics.reci.mean - observations[index]!.metrics.reci.mean),
      msaviDelta: roundMetric(observation.metrics.msavi.mean - observations[index]!.metrics.msavi.mean),
      ndmiDelta: roundMetric(observation.metrics.ndmi.mean - observations[index]!.metrics.ndmi.mean),
      ndwiDelta: roundMetric(observation.metrics.ndwi.mean - observations[index]!.metrics.ndwi.mean),
    }));
    const zones = currentCandidate.zones ?? [];
    const zoningQuality = currentCandidate.zoningQuality!;
    const artifacts: AnalysisArtifact[] = [
      { ref: await writeZonesArtifact(taskId, id, field, zones), kind: "map" },
      ...visualizationArtifacts,
      ...opticalTrendCharts(taskId, id, observations),
    ];
    const missingOrPartial = candidates.length > complete.length || sources.some((source) => source.quality !== "usable");
    const status = observations.length < 2 || missingOrPartial ? "partial" : "succeeded";
    const limitations = [
      ...(observations.length < 2 ? ["当前只有一个可用光学时相，不能判断历史变化日期。"] : []),
      ...(missingOrPartial ? ["部分候选时相缺少完整资产、受云影响或处理失败，时序仅包含可用观测。"] : []),
    ];
    const result: OpticalConditionPayload = { current, observations, changes, zoningMethod: OPTICAL_ZONING_METHOD, zoningQuality, zones,
      zoneSnapshots: zoneSnapshots.filter((snapshot) => observations.some((observation) => observation.observationDate === snapshot.observationDate)) };
    return { ...base, status, summary: `已形成 ${observations.length} 个可交付光学日期；最近观测为 ${current.observationDate}，地块平均 NDVI ${current.metrics.ndvi.mean.toFixed(3)}。`, result,
      sources, findings: [{ id: "optical-overview", summary: `最近观测平均 NDVI ${current.metrics.ndvi.mean.toFixed(3)}，有效像元覆盖率 ${(current.quality.validFraction * 100).toFixed(1)}%。`, sourceDates: observations.map((observation) => ({ source: "sentinel-2", date: observation.observationDate })), zoneRef: artifacts[0]!.ref }],
      artifacts, limitations, nextActions: [], error: null };
  }

  private async estimateCropStage(taskId: string, field: FieldSummary, acquisitions: DataAcquisitionRun[], timeRange?: AnalysisTimeRange): Promise<AnalysisResult<CropStagePayload>> {
    const available = await this.store.list(taskId);
    const optical = available.find((result) => result.kind === "optical_condition") as AnalysisResult<OpticalConditionPayload> | undefined;
    const weather = available.find((result) => result.kind === "weather_event") as AnalysisResult<{ forecast?: { start: string | null; coldWindows: Array<{ start: string; minTemperatureC: number }> } | null }> | undefined;
    const forecastReferenceDate = weather?.result?.forecast ? coldestForecastDate(weather.result.forecast) : null;
    const referenceDate = optical?.result?.current.observationDate ?? forecastReferenceDate ?? latestObservationDate(acquisitions, timeRange) ?? latestPeriodEnd(acquisitions, timeRange) ?? timeRange?.end.slice(0, 10) ?? null;
    const referenceResult = optical?.result ? optical : forecastReferenceDate ? weather : undefined;
    const base = createAnalysisResultBase({ taskId, toolName: "estimate_crop_stage", toolVersion: CROP_STAGE_TOOL_VERSION, kind: "crop_stage", field, acquisitions, timeRange,
      inputResults: referenceResult ? [referenceResult] : [], parameters: { stageRule: CROP_STAGE_RULE_VERSION, referenceDate } });
    const emptyArtifacts: AnalysisArtifact[] = [];
    const emptyActions: Array<{ code: string; label: string; zoneRef?: string }> = [];
    if (!field.plantingDate) {
      return { ...base, status: "needs_input", summary: "缺少播种日期，暂不能估计玉米生育期。", result: null,
        sources: [{ source: "field_record", date: null, quality: "missing", note: "请补充当前种植季播种日期。" }], findings: [], artifacts: emptyArtifacts, limitations: ["生育期估计需要播种日期；单幅影像不能替代生育期记录。"], nextActions: emptyActions, error: { code: "planting_date_missing", message: "缺少播种日期。", retryable: false } };
    }
    if (!isCalendarDate(field.plantingDate)) {
      return { ...base, status: "needs_input", summary: "播种日期格式无效，暂不能估计玉米生育期。", result: null,
        sources: [{ source: "field_record", date: field.plantingDate, quality: "missing", note: "播种日期不是有效日期。" }], findings: [], artifacts: emptyArtifacts, limitations: ["播种日期必须是有效的日历日期。"], nextActions: [{ code: "fix_planting_date", label: "修正地块播种日期" }], error: { code: "planting_date_invalid", message: "播种日期格式无效。", retryable: false } };
    }
    if (!referenceDate || !isCalendarDate(referenceDate)) {
      return { ...base, status: "needs_data", summary: "缺少可追溯的生育期参考日期。", result: null,
        sources: [{ source: "task_scope", date: null, quality: "missing", note: "任务没有光学观测日期或有效时间窗口。" }], findings: [], artifacts: emptyArtifacts, limitations: ["生育期估计必须绑定光学观测日期或任务时间窗口，不能使用系统当天日期兜底。"], nextActions: [{ code: "select_reference_period", label: "选择有效分析时段" }], error: { code: "stage_reference_date_missing", message: "缺少生育期参考日期。", retryable: false } };
    }
    const referenceTime = Date.parse(`${referenceDate}T00:00:00Z`);
    const plantingTime = Date.parse(`${field.plantingDate}T00:00:00Z`);
    if (plantingTime > referenceTime) {
      return { ...base, status: "needs_input", summary: "播种日期晚于参考观测日，暂不能估计玉米生育期。", result: null,
        sources: [{ source: "field_record", date: field.plantingDate, quality: "partial", note: `播种日期晚于参考观测日 ${referenceDate}。` }], findings: [], artifacts: emptyArtifacts, limitations: ["参考观测日必须位于播种日期之后；系统不会把未来播期归零为出苗期。"], nextActions: [{ code: "fix_planting_date", label: "核对地块播种日期或选择正确种植季" }], error: { code: "planting_date_after_reference", message: "播种日期晚于参考观测日。", retryable: false } };
    }
    const days = Math.floor((referenceTime - plantingTime) / 86_400_000);
    const stage = stageForDays(days);
    const result: CropStagePayload = { stage: stage.stage, label: stage.label, referenceDate, daysAfterPlanting: days, confidence: optical?.result || forecastReferenceDate ? "medium" : "low", ruleVersion: CROP_STAGE_RULE_VERSION };
    const referenceSources: AnalysisResult<unknown>["sources"] = optical?.result
      ? optical.sources.filter((source) => source.date === referenceDate && source.quality !== "missing").map((source) => ({ ...source, role: "context" as const, note: `${source.note} 生育期参考日。` }))
      : forecastReferenceDate
        ? (weather?.sources ?? []).filter((source) => source.source === "ecmwf-ifs" && source.quality !== "missing").map((source) => ({ ...source, role: "context" as const, note: `${source.note} 低温事件 ${referenceDate} 用作生育期参考日。` }))
        : [{ source: "task_scope", date: referenceDate, quality: "usable" as const, role: "context" as const, note: "任务时间窗口提供生育期参考日。" }];
    const sources = [{ source: "field_record", date: field.plantingDate, quality: "usable" as const, note: "地块种植季播种日期。" }, ...referenceSources];
    return { ...base, status: "succeeded", summary: `按播种日期和观测窗口估计为${stage.label}，播后第 ${days} 天。`, result,
      sources, findings: [{ id: "crop-stage", summary: `${stage.label}，播后第 ${days} 天。`, sourceDates: sources.map((source) => ({ source: source.source, date: source.date })), zoneRef: null }], artifacts: emptyArtifacts, limitations: ["这是基于播期的阶段估计，需结合冠层观测校验。"], nextActions: emptyActions, error: null };
  }

  private async assessGrowthStatus(taskId: string, field: FieldSummary, targetRange?: AnalysisTimeRange): Promise<AnalysisResult<GrowthAssessmentPayload>> {
    const available = await this.store.list(taskId);
    const optical = available.find((result) => result.kind === "optical_condition") as AnalysisResult<OpticalConditionPayload> | undefined;
    const stage = available.find((result) => result.kind === "crop_stage") as AnalysisResult<CropStagePayload> | undefined;
    const base = createAnalysisResultBase({ taskId, toolName: "assess_growth_status", toolVersion: GROWTH_ASSESSMENT_TOOL_VERSION, kind: "assessment", field, timeRange: targetRange,
      inputResults: [...(optical ? [optical] : []), ...(stage ? [stage] : [])], parameters: { meaningfulNdviChange: MEANINGFUL_NDVI_CHANGE, maximumObservationAgeDays: MAX_GROWTH_OBSERVATION_AGE_DAYS, zoneComparisonMethod: GROWTH_ZONE_COMPARISON_METHOD } });
    if (!optical?.result || (optical.status !== "succeeded" && optical.status !== "partial")) {
      const limitations = ["缺少地块内有效光学像元，不能形成当前长势和空间差异。", ...(stage?.limitations ?? [])];
      const nextActions = [
        { code: "collect_optical_data", label: "采集下一个可用 Sentinel-2 光学日期" },
        ...(stage?.nextActions ?? []),
      ];
      return { ...base, status: "needs_data", summary: "缺少有效光学影像，暂不能形成当前长势和空间差异。", result: null,
        sources: [...(optical?.sources ?? []), ...(stage?.sources ?? [])], findings: [], artifacts: optical?.artifacts ?? [], limitations, nextActions, error: { code: "growth_assessment_inputs_missing", message: "长势判断所需光学输入不完整。", retryable: true } };
    }
    const stageResult = stage?.status === "succeeded" ? stage.result : null;
    const belowZones = optical.result.zones.filter((zone) => zone.class === "below_average");
    const below = belowZones.length;
    const above = optical.result.zones.filter((zone) => zone.class === "above_average").length;
    const belowAverageAreaHa = measuredZoneArea(belowZones);
    const belowAverageAreaFraction = field.areaHa > 0 && belowAverageAreaHa !== null ? roundMetric(belowAverageAreaHa / field.areaHa) : null;
    const latestChange = optical.result.changes.at(-1) ?? null;
    const trend = latestChange ? latestChange.ndviDelta <= -MEANINGFUL_NDVI_CHANGE ? "declining" : latestChange.ndviDelta >= MEANINGFUL_NDVI_CHANGE ? "increasing" : "stable" : "insufficient_timeseries";
    const growthStatus = trend === "declining" || below > above * 2 ? "watch" : "observed";
    const observationAgeDays = targetRange ? dateDistanceDays(optical.result.current.observationDate, targetRange.end.slice(0, 10)) : null;
    const observationStatus = observationAgeDays !== null && observationAgeDays > MAX_GROWTH_OBSERVATION_AGE_DAYS ? "stale" : "current";
    const zoneChange = summarizeGrowthZoneChange(optical.result.zoneSnapshots, optical.result.current.observationDate);
    const weakZones = belowZones
      .slice()
      .sort((left, right) => (left.meanNdvi ?? Number.POSITIVE_INFINITY) - (right.meanNdvi ?? Number.POSITIVE_INFINITY))
      .map((zone, index) => ({
        id: zone.id,
        areaHa: Number.isFinite(zone.areaHa) && zone.areaHa! >= 0 ? roundMetric(zone.areaHa!) : null,
        meanNdvi: typeof zone.meanNdvi === "number" ? roundMetric(zone.meanNdvi) : null,
        deviation: typeof zone.deviation === "number" ? roundMetric(zone.deviation) : null,
        rank: index + 1,
      }));
    const result: GrowthAssessmentPayload = {
      stage: stageResult,
      status: growthStatus,
      trend,
      meanNdvi: optical.result.current.metrics.ndvi.mean,
      latestObservationDate: optical.result.current.observationDate,
      observationCount: optical.result.observations.length,
      observationWindow: {
        requestedPeriod: targetRange ?? null,
        datesWithinPeriod: optical.result.observations.map((item) => item.observationDate).filter((date) => inTimeRange(date, targetRange)),
        comparisonDatesOutsidePeriod: optical.result.observations.map((item) => item.observationDate).filter((date) => !inTimeRange(date, targetRange)),
      },
      areaBasis: { fieldAreaHa: field.areaHa, belowAverageAreaFractionDenominator: "field_area" },
      validCoverageFraction: optical.result.current.quality.validFraction,
      observationAgeDays,
      observationStatus,
      latestChange,
      belowAverageZoneCount: below,
      belowAverageAreaHa,
      belowAverageAreaFraction,
      aboveAverageZoneCount: above,
      weakZones,
      zoneChange,
    };
    const zoneRef = optical.artifacts[0]?.ref;
    const observationDates = new Set(optical.result.observations.map((observation) => observation.observationDate));
    const usedSources = dedupeAnalysisSources([...optical.sources.filter((source) => source.quality !== "missing" && source.date !== null && observationDates.has(source.date)), ...(stageResult ? stage?.sources ?? [] : [])]);
    const stageLabel = stageResult ? `${stageResult.label}地块` : "地块";
    const summary = trend === "declining" && latestChange
      ? `${latestChange.fromDate} 至 ${latestChange.toDate}，${stageLabel}平均 NDVI 下降 ${Math.abs(latestChange.ndviDelta).toFixed(3)}。`
      : trend === "increasing" && latestChange
        ? `${latestChange.fromDate} 至 ${latestChange.toDate}，${stageLabel}平均 NDVI 上升 ${latestChange.ndviDelta.toFixed(3)}。`
        : trend === "stable"
          ? `${latestChange!.fromDate} 至 ${latestChange!.toDate}，${stageLabel}平均 NDVI 变化 ${latestChange!.ndviDelta.toFixed(3)}，未达到 ${MEANINGFUL_NDVI_CHANGE.toFixed(3)} 变化门槛。`
          : `${optical.result.current.observationDate} 光学观测${stageResult ? `估计处于${stageResult.label}，` : "显示"}${below ? `识别到 ${below} 个需要关注的长势偏弱区；` : "未形成明显需要关注的区域；"}当前只有一个可用时相，暂不能判断历史变化。`;
    const staleLimitation = observationStatus === "stale" ? [`最近可用光学观测距任务结束日期 ${observationAgeDays} 天，本结果表示 ${optical.result.current.observationDate} 的历史田况，不代表当前长势。`] : [];
    const stageLimitations = stageResult ? [] : stage?.limitations?.length ? stage.limitations : ["缺少有效播种日期，本次不能解释当前生育期。"];
    const stageActions = stageResult ? [] : stage?.nextActions?.length ? stage.nextActions : [{ code: "add_planting_date", label: "补充播种日期以完善生育期解释" }];
    return { ...base, status: optical.status === "partial" || observationStatus === "stale" || !stageResult ? "partial" : "succeeded", summary, result,
      sources: usedSources, findings: [{ id: "growth-status", summary, sourceDates: usedSources.map((source) => ({ source: source.source, date: source.date })), zoneRef: zoneRef ?? null }], artifacts: optical.artifacts, limitations: [...staleLimitation, ...stageLimitations, ...optical.limitations], nextActions: stageActions, error: null };
  }
}

function measuredZoneArea(zones: OpticalZone[]): number | null {
  return zones.every((zone) => Number.isFinite(zone.areaHa) && zone.areaHa! >= 0)
    ? roundMetric(zones.reduce((sum, zone) => sum + zone.areaHa!, 0)) : null;
}

export function summarizeGrowthZoneChange(snapshots: OpticalZoneSnapshot[] | undefined, latestDate: string): GrowthZoneChange {
  const dated = (snapshots ?? []).filter((snapshot) => /^\d{4}-\d{2}-\d{2}$/.test(snapshot.observationDate)
    && !Number.isNaN(Date.parse(snapshot.observationDate)) && new Date(snapshot.observationDate).toISOString().slice(0, 10) === snapshot.observationDate);
  const current = dated.filter((snapshot) => snapshot.observationDate === latestDate);
  const previousDate = dated.map((snapshot) => snapshot.observationDate).filter((date) => date < latestDate).sort().at(-1);
  const prior = dated.filter((snapshot) => snapshot.observationDate === previousDate);
  const latest = current.length === 1 ? current[0] : null;
  const previous = prior.length === 1 ? prior[0] : null;
  const currentBelow = latest?.zones.filter((zone) => zone.class === "below_average");
  const previousBelow = previous?.zones.filter((zone) => zone.class === "below_average");
  const base = {
    method: GROWTH_ZONE_COMPARISON_METHOD, fromDate: previousDate ?? null, toDate: latestDate,
    previousBelowZoneCount: previousBelow?.length ?? null, currentBelowZoneCount: currentBelow?.length ?? null,
    previousBelowAreaHa: previousBelow ? measuredZoneArea(previousBelow) : null,
    currentBelowAreaHa: currentBelow ? measuredZoneArea(currentBelow) : null,
  };
  const reason = current.length > 1 || prior.length > 1 ? "ambiguous_snapshot_date"
    : !latest ? "missing_current_snapshot" : !previous ? "missing_previous_snapshot"
      : !latest.zones.length || !previous.zones.length ? "empty_observed_coverage" : null;
  if (reason || !latest || !previous) return { ...base, status: "not_comparable", reason, areas: null, currentBelowZones: [] };
  return { ...base, ...compareRelativeZoneCoverage(previous.zones, latest.zones), reason: null };
}

function coldestForecastDate(forecast: { start: string | null; coldWindows: Array<{ start: string; minTemperatureC: number }> }): string | null {
  const coldest = [...forecast.coldWindows].filter((window) => Number.isFinite(window.minTemperatureC)).sort((left, right) => left.minTemperatureC - right.minTemperatureC)[0];
  return (coldest?.start ?? forecast.start)?.slice(0, 10) ?? null;
}

function dedupeAnalysisSources(sources: AnalysisResult<unknown>["sources"]): AnalysisResult<unknown>["sources"] {
  const seen = new Set<string>();
  return sources.filter((source) => {
    const key = `${source.source}:${source.date ?? "static"}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export interface OpticalPythonResult {
  status: "succeeded" | "partial" | "needs_data";
  sourceDate: string | null;
  quality: OpticalObservation["quality"];
  metrics: OpticalObservation["metrics"] | null;
  zoningMethod?: typeof OPTICAL_ZONING_METHOD;
  zoningQuality?: OpticalZoningQuality;
  zones: OpticalZone[];
  visualizations?: Array<{
    fileName: string;
    metric: VisualizationMetric;
    label: string;
    bounds: [[number, number], [number, number], [number, number], [number, number]];
    min: number;
    max: number;
    resolutionMeters: number;
  }>;
  error: { code: string | null; message: string | null; retryable: boolean };
}

function findAsset(assets: AcquiredAsset[], role: AcquiredAsset["role"], token: string): AcquiredAsset | null {
  return assets.find((asset) => asset.role === role && asset.accessStatus === "retrieved" && asset.providerAssetId.includes(token)) ?? null;
}

function assetPath(asset: AcquiredAsset): string | null {
  return asset.artifactRef ? resolveAcquisitionArtifact(asset.artifactRef) : null;
}

interface OpticalCandidate {
  date: string;
  spectral10: AcquiredAsset | null;
  spectral20: AcquiredAsset | null;
  scl: AcquiredAsset | null;
  zones?: OpticalZone[];
  zoningQuality?: OpticalZoningQuality;
}

interface CompleteOpticalCandidate extends OpticalCandidate {
  spectral10: AcquiredAsset;
  spectral20: AcquiredAsset;
  scl: AcquiredAsset;
}

function isOpticalZoningQuality(value: OpticalZoningQuality | undefined): value is OpticalZoningQuality {
  if (!value) return false;
  return Number.isFinite(value.robustRange)
    && Number.isFinite(value.minimumRobustRange)
    && typeof value.variationVisible === "boolean";
}

export function hasCompleteOpticalAssets(acquisitions: DataAcquisitionRun[], timeRange?: AnalysisTimeRange): boolean {
  return collectOpticalCandidates(acquisitions, timeRange)
    .some((candidate) => Boolean(candidate.spectral10 && candidate.spectral20 && candidate.scl));
}

function collectOpticalCandidates(acquisitions: DataAcquisitionRun[], timeRange?: AnalysisTimeRange): OpticalCandidate[] {
  const bySceneDate = new Map<string, OpticalCandidate>();
  for (const acquisition of acquisitions) {
    const source = acquisition.sources.find((item) => item.source === "sentinel-2");
    if (!source) continue;
    const dates = new Set([...source.selectedObservationDates, ...source.selectedAssets.flatMap((asset) => asset.capturedAt ? [asset.capturedAt.slice(0, 10)] : [])]
      .filter((date) => inTimeRange(date, timeRange)));
    for (const date of dates) {
      const assets = source.selectedAssets.filter((asset) => asset.capturedAt?.slice(0, 10) === date);
      const sceneKeys = assets.length ? [...new Set(assets.map((asset) => opticalSceneKey(asset.providerAssetId)))] : ["missing-scene"];
      for (const sceneKey of sceneKeys) {
        const key = `${date}|${sceneKey}`;
        if (bySceneDate.has(key)) continue;
        const sceneAssets = assets.filter((asset) => opticalSceneKey(asset.providerAssetId) === sceneKey);
        bySceneDate.set(key, {
        date,
        spectral10: findAsset(sceneAssets, "spectral", "B02+B03+B04+B08"),
        spectral20: findAsset(sceneAssets, "spectral", "B05+B06+B07+B8A+B11+B12"),
        scl: findAsset(sceneAssets, "quality-mask", "SCL"),
        });
      }
    }
  }
  const byDate = new Map<string, OpticalCandidate>();
  for (const candidate of [...bySceneDate.values()].sort((left, right) => left.date.localeCompare(right.date))) {
    const previous = byDate.get(candidate.date);
    if (!previous || (!previous.spectral10 || !previous.spectral20 || !previous.scl) && candidate.spectral10 && candidate.spectral20 && candidate.scl) {
      byDate.set(candidate.date, candidate);
    }
  }
  return [...byDate.values()].sort((left, right) => left.date.localeCompare(right.date));
}

function opticalSceneKey(providerAssetId: string): string {
  return providerAssetId.replace(/:(?:B02\+B03\+B04\+B08|B03\+B04\+B08|B05\+B06\+B07\+B8A\+B11\+B12|SCL)$/, "");
}

function latestObservationDate(acquisitions: DataAcquisitionRun[], timeRange?: AnalysisTimeRange): string | null {
  return collectOpticalCandidates(acquisitions, timeRange).at(-1)?.date ?? null;
}

function latestPeriodEnd(acquisitions: DataAcquisitionRun[], timeRange?: AnalysisTimeRange): string | null {
  return acquisitions.map((acquisition) => acquisition.period.end.slice(0, 10)).filter((date) => inTimeRange(date, timeRange)).sort().at(-1) ?? null;
}

function inTimeRange(date: string, timeRange?: AnalysisTimeRange): boolean {
  if (!timeRange) return true;
  return date >= timeRange.start.slice(0, 10) && date <= timeRange.end.slice(0, 10);
}

function dateDistanceDays(date: string, referenceDate: string): number | null {
  const left = Date.parse(`${date}T00:00:00Z`);
  const right = Date.parse(`${referenceDate}T00:00:00Z`);
  return Number.isFinite(left) && Number.isFinite(right) ? Math.max(0, Math.round((right - left) / 86_400_000)) : null;
}

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

function roundMetric(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function zoneAreaHa(fieldAreaHa: number, validPixelCount: number, totalPixelCount: number): number {
  if (fieldAreaHa <= 0 || validPixelCount <= 0 || totalPixelCount <= 0) return 0;
  return roundMetric(fieldAreaHa * Math.min(validPixelCount / totalPixelCount, 1));
}

function opticalTrendCharts(taskId: string, resultId: string, observations: OpticalObservation[]): AnalysisArtifact[] {
  const definitions = [
    { metric: "ndvi", title: "NDVI 时序" },
    { metric: "ndre", title: "NDRE 时序" },
    { metric: "reci", title: "RECI 时序" },
    { metric: "msavi", title: "MSAVI 时序" },
    { metric: "ndmi", title: "NDMI 时序" },
    { metric: "ndwi", title: "NDWI 时序" },
  ] as const;
  return definitions.map(({ metric, title }) => ({
    ref: `analysis/${taskId}/${resultId}-${metric}-timeseries`,
    kind: "chart",
    chart: {
      source: "sentinel-2",
      title,
      unit: "index",
      series: [{ label: "地块均值", points: observations.map((observation) => ({ label: observation.observationDate, value: observation.metrics[metric].mean })) }],
    },
  }));
}

async function writeZonesArtifact(taskId: string, resultId: string, field: FieldSummary, zones: OpticalZone[]): Promise<string> {
  const ref = `analysis/${taskId}/${resultId}-zones.geojson`;
  const target = resolve(import.meta.dirname, "../../../runtime/artifacts", ref);
  await mkdir(resolve(target, ".."), { recursive: true });
  const geojson = {
    type: "FeatureCollection",
    features: zones.map((zone) => ({ type: "Feature", properties: { id: zone.id, class: zone.class, meanNdvi: zone.meanNdvi, deviation: zone.deviation, areaHa: zone.areaHa ?? null, validPixelCount: zone.validPixelCount }, geometry: { type: "Polygon", coordinates: [zone.zone, ...(zone.holes ?? [])] } })),
    fieldId: field.id,
  };
  await writeFile(target, JSON.stringify(geojson));
  return ref;
}

function stageForDays(days: number): Pick<CropStagePayload, "stage" | "label"> {
  if (days <= 10) return { stage: "sowing", label: "播种期" };
  if (days <= 25) return { stage: "emergence", label: "出苗期" };
  if (days <= 55) return { stage: "jointing", label: "拔节期" };
  if (days <= 75) return { stage: "tasseling", label: "抽雄期" };
  if (days <= 85) return { stage: "silking", label: "吐丝期" };
  if (days <= 125) return { stage: "grain_fill", label: "灌浆期" };
  return { stage: "maturity", label: "成熟期" };
}
