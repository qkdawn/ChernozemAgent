import { CORN_SKILLS, type ControlledAnalysisTool, type ControlledToolName } from "@chernozem/agent-runtime";
import type { AnalysisNextAction, AnalysisObjective, AnalysisTimeRange, DataAcquisitionRun, DataProfile, DataSource, FieldSummary } from "@chernozem/contracts";

import { EVIDENCE_TOOLS } from "./analysis-evidence.js";
import { hasCompleteOpticalAssets, type GrowthAnalysisService } from "./analysis-tools.js";
import { DATA_SOURCE_LABELS, OBJECTIVE_DATA_PROFILE, PROFILE_SOURCES } from "./data-profiles.js";
import { MAX_RADAR_PAIR_DAYS, type MultiSourceAnalysisService, type WaterNitrogenInspectionContext } from "./multi-source-analysis.js";

const WATER_NITROGEN_CONTEXT_AFTER_DAYS = 14;

export interface AnalysisToolsetRequest {
  objective: AnalysisObjective;
  field: FieldSummary;
  timeRange: AnalysisTimeRange;
  acquisitions: DataAcquisitionRun[];
  inspections?: WaterNitrogenInspectionContext[];
}

export interface AnalysisToolset {
  tools: ControlledAnalysisTool[];
  investigationTools: ControlledAnalysisTool[];
  availability: {
    status: "ready" | "missing_analysis_assets" | "missing_period_data" | "missing_field_data";
    canRun: boolean;
    relevantAcquisition: DataAcquisitionRun | null;
    gap: {
      dataProfile: DataProfile;
      sources: DataSource[];
      message: string;
      nextAction: AnalysisNextAction;
    } | null;
  };
  context: {
    evidenceTimeRange: AnalysisTimeRange;
    evidenceAcquisitionIds: string[];
    opticalObservationRange: AnalysisTimeRange;
    opticalAcquisitionIds: string[];
  };
}

type GrowthToolProvider = Pick<GrowthAnalysisService, "createTools">;
type MultiSourceToolProvider = Pick<
  MultiSourceAnalysisService,
  "createWaterloggingTools" | "createWaterNitrogenTools" | "createFrostRiskTools"
>;

export class AnalysisToolsetFactory {
  constructor(
    private readonly growth: GrowthToolProvider,
    private readonly multiSource: MultiSourceToolProvider,
    private readonly opticalAssetsReady: (acquisitions: DataAcquisitionRun[], timeRange?: AnalysisTimeRange) => boolean = hasCompleteOpticalAssets,
  ) {}

  create(request: AnalysisToolsetRequest): AnalysisToolset {
    const evidenceTimeRange = evidenceRange(request.objective, request.timeRange);
    const evidenceAcquisitions = request.acquisitions.filter((run) => overlaps(run.period, evidenceTimeRange));
    const opticalObservationRange = seasonRange(request.field, request.timeRange);
    const opticalAcquisitions = request.acquisitions.filter((run) => overlaps(run.period, opticalObservationRange));
    const canUseSeasonOptical = request.objective === "growth_stage_monitoring" || request.objective === "water_nitrogen_diagnosis";
    const relevantAcquisition = evidenceAcquisitions[0] ?? (canUseSeasonOptical ? opticalAcquisitions[0] : null) ?? null;
    const hasCompleteOpticalAssets = !canUseSeasonOptical
      || this.opticalAssetsReady(opticalAcquisitions, opticalObservationRange);
    const canRun = relevantAcquisition !== null && hasCompleteOpticalAssets;
    const dataProfile = OBJECTIVE_DATA_PROFILE[request.objective];
    const sourceLabels = PROFILE_SOURCES[dataProfile].map((source) => DATA_SOURCE_LABELS[source]);
    const availabilityStatus = canRun
      ? "ready"
      : relevantAcquisition && !hasCompleteOpticalAssets
        ? "missing_analysis_assets"
        : request.acquisitions.length ? "missing_period_data" : "missing_field_data";
    const missingSources = availabilityStatus === "missing_analysis_assets"
      ? ["sentinel-2" as const]
      : [...PROFILE_SOURCES[dataProfile]];

    const candidates = canRun ? this.toolsFor(request, evidenceAcquisitions, opticalAcquisitions, evidenceTimeRange, opticalObservationRange) : [];
    return {
      tools: canRun ? orderAndValidateTools(request.objective, candidates) : [],
      investigationTools: candidates.filter((tool) => Object.hasOwn(EVIDENCE_TOOLS, tool.name)),
      availability: {
        status: availabilityStatus,
        canRun,
        relevantAcquisition,
        gap: canRun ? null : {
          dataProfile,
          sources: missingSources,
          message: availabilityStatus === "missing_analysis_assets"
            ? "已有采集记录，但没有同一观测日期的完整 Sentinel-2 光谱与质量资产。"
            : availabilityStatus === "missing_period_data"
              ? `所选时段没有匹配的采集批次；需要 ${sourceLabels.join("、")}。`
              : `该地块尚未建立分析数据；需要 ${sourceLabels.join("、")}。`,
          nextAction: {
            code: `collect_${dataProfile}`,
            label: "打开地块数据并开始采集",
            acquisitionRequest: {
              fieldId: request.field.id,
              boundaryVersion: request.field.boundaryVersion,
              dataProfile,
              period: request.objective === "growth_stage_monitoring" ? request.timeRange : evidenceTimeRange,
            },
          },
        },
      },
      context: {
        evidenceTimeRange,
        evidenceAcquisitionIds: evidenceAcquisitions.map((run) => run.id),
        opticalObservationRange,
        opticalAcquisitionIds: opticalAcquisitions.map((run) => run.id),
      },
    };
  }

  private toolsFor(
    request: AnalysisToolsetRequest,
    evidenceAcquisitions: DataAcquisitionRun[],
    opticalAcquisitions: DataAcquisitionRun[],
    evidenceTimeRange: AnalysisTimeRange,
    opticalObservationRange: AnalysisTimeRange,
  ): ControlledAnalysisTool[] {
    const candidates = request.objective === "growth_stage_monitoring"
      ? [
          ...this.growth.createTools(request.field, opticalAcquisitions, opticalObservationRange, request.timeRange),
          ...this.multiSource.createWaterNitrogenTools(request.field, opticalAcquisitions, request.timeRange),
        ]
      : request.objective === "waterlogging_detection"
        ? this.multiSource.createWaterloggingTools(request.field, evidenceAcquisitions, evidenceTimeRange)
        : request.objective === "water_nitrogen_diagnosis"
          ? [
              ...this.growth.createTools(request.field, opticalAcquisitions, opticalObservationRange, request.timeRange),
              ...this.multiSource.createWaterNitrogenTools(request.field, evidenceAcquisitions, request.timeRange, request.inspections ?? []),
            ]
          : [
              ...this.growth.createTools(request.field, evidenceAcquisitions, request.timeRange),
              ...this.multiSource.createFrostRiskTools(request.field, evidenceAcquisitions, request.timeRange),
            ];

    return candidates;
  }
}

function orderAndValidateTools(objective: AnalysisObjective, candidates: ControlledAnalysisTool[]): ControlledAnalysisTool[] {
  const byName = new Map<ControlledToolName, ControlledAnalysisTool>();
  for (const tool of candidates) {
    if (byName.has(tool.name)) throw new Error(`目标 ${objective} 重复注册工具：${tool.name}`);
    byName.set(tool.name, tool);
  }
  const required = CORN_SKILLS[objective].tools;
  const missing = required.filter((name) => !byName.has(name));
  if (missing.length) throw new Error(`目标 ${objective} 缺少受控工具：${missing.join(", ")}`);
  return required.map((name) => byName.get(name)!);
}

function evidenceRange(objective: AnalysisObjective, timeRange: AnalysisTimeRange): AnalysisTimeRange {
  const isSingleDay = timeRange.start.slice(0, 10) === timeRange.end.slice(0, 10);
  if (!isSingleDay || (objective !== "waterlogging_detection" && objective !== "water_nitrogen_diagnosis")) return timeRange;
  return {
    start: shiftDays(timeRange.start, -MAX_RADAR_PAIR_DAYS),
    end: objective === "water_nitrogen_diagnosis"
      ? shiftDays(timeRange.end, WATER_NITROGEN_CONTEXT_AFTER_DAYS)
      : timeRange.end,
  };
}

function seasonRange(field: FieldSummary, timeRange: AnalysisTimeRange): AnalysisTimeRange {
  const configuredStart = field.plantingDate ? Date.parse(`${field.plantingDate}T00:00:00.000Z`) : Number.NaN;
  const seasonStart = Number.isFinite(configuredStart) ? configuredStart : Date.UTC(field.seasonYear, 0, 1);
  return { start: new Date(seasonStart).toISOString(), end: timeRange.end };
}

function overlaps(period: AnalysisTimeRange, timeRange: AnalysisTimeRange): boolean {
  return Date.parse(period.end) >= Date.parse(timeRange.start) && Date.parse(period.start) <= Date.parse(timeRange.end);
}

function shiftDays(value: string, days: number): string {
  return new Date(Date.parse(value) + days * 86_400_000).toISOString();
}
