import { WATER_NITROGEN_METHOD_VERSION, type AnalysisResult, type TaskStatus } from "@chernozem/contracts";

export interface WaterNitrogenObservationViewModel {
  methodVersion: string;
  assessment: "variation_visible" | "uniform";
  referenceDate: string;
  cropStage: { label: string } | null;
  observationCount: number;
  validCoverageFraction: number | null;
  latestChange: { fromDate: string; toDate: string; ndviDelta: number } | null;
  attentionAreaHa: number | null;
  attentionAreaFraction: number | null;
  observationAgeDays: number | null;
  observationStatus: "current" | "stale";
  observation: { variationStatus: "visible" | "uniform" };
  evidenceLevel: "optical_only" | "multi_source" | "field_comparison";
  zones: Array<{
    id: string;
    opticalZoneId: string;
    meanNdvi: number | null;
    ndviDeviation: number | null;
    radarOverlap: { status: string; overlapAreaHa: number | null; overlapFraction: number | null };
  }>;
}

export function getWaterNitrogenObservation(results: AnalysisResult<unknown>[]): WaterNitrogenObservationViewModel | null {
  const payload = [...results].reverse().find((result) => result.kind === "assessment")?.result as Partial<WaterNitrogenObservationViewModel> | null | undefined;
  if (payload?.methodVersion !== WATER_NITROGEN_METHOD_VERSION || !payload.observation || typeof payload.referenceDate !== "string"
    || !["optical_only", "multi_source", "field_comparison"].includes(payload.evidenceLevel ?? "") || !Array.isArray(payload.zones)
    || !(payload.attentionAreaHa === null || Number.isFinite(payload.attentionAreaHa)) || !(payload.attentionAreaFraction === null || Number.isFinite(payload.attentionAreaFraction))) return null;
  return payload as WaterNitrogenObservationViewModel;
}

export function waterNitrogenObservationStatus(observation: WaterNitrogenObservationViewModel, status: TaskStatus): { label: string; tone: "complete" | "partial" } {
  if (status === "needs_review") return { label: "等待专业复核", tone: "partial" };
  if (observation.observationStatus === "stale") return { label: "历史田况", tone: "partial" };
  if (status === "partial") return { label: "部分数据可用", tone: "partial" };
  return { label: observation.evidenceLevel === "field_comparison" ? "现场记录已关联" : observation.evidenceLevel === "multi_source" ? "多源对比已完成" : "光学差异已计算", tone: "complete" };
}
