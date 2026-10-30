import type { AnalysisResult } from "@chernozem/contracts";
import type { MapVisualizationLayer } from "./MapCanvas.js";

export interface FieldReportZone {
  id: string;
  label: string;
  areaHa: number | null;
  meanNdvi: number | null;
  deviation: number | null;
  rateKgHa: number | null;
}

export interface FieldReportPresentation {
  heroMap: MapVisualizationLayer | null;
  mean: number | null;
  std: number | null;
  min: number | null;
  max: number | null;
  coverageFraction: number | null;
  zones: FieldReportZone[];
}

export function fieldReportPresentation(
  results: AnalysisResult<unknown>[],
  visualizations: MapVisualizationLayer[],
  taskId: string,
): FieldReportPresentation {
  const taskLayers = visualizations.filter((layer) => layer.taskId === taskId);
  const heroMap = taskLayers.find((layer) => layer.metric === "ndvi_contrast")
    ?? taskLayers.find((layer) => layer.metric === "ndvi")
    ?? taskLayers.find((layer) => layer.metric !== "true_color")
    ?? null;
  const optical = [...results].reverse().find((result) => result.kind === "optical_condition"
    && result.result !== null && (result.status === "succeeded" || result.status === "partial"));
  const payload = record(optical?.result);
  const current = record(payload?.current);
  const metrics = record(current?.metrics);
  const ndvi = record(metrics?.ndvi);
  const assessment = [...results].reverse().find((result) => result.kind === "assessment");
  const assessmentPayload = record(assessment?.result);
  const mean = finite(ndvi?.mean) ?? finite(assessmentPayload?.meanNdvi);

  return {
    heroMap,
    mean,
    std: finite(ndvi?.std),
    min: finite(ndvi?.min),
    max: finite(ndvi?.max),
    coverageFraction: finite(current && record(current.quality)?.validFraction)
      ?? finite(assessmentPayload?.validCoverageFraction),
    zones: reportZones(payload?.zones) ?? reportZones(assessmentPayload?.zones)
      ?? reportZones(assessmentPayload?.weakZones) ?? [],
  };
}

function reportZones(value: unknown): FieldReportZone[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  return value.filter((item): item is Record<string, unknown> => record(item) !== null)
    .map((zone) => ({
      id: stringValue(zone.id) ?? "",
      label: stringValue(zone.label) ?? zoneClassLabel(zone.class) ?? stringValue(zone.level) ?? "分区",
      areaHa: finite(zone.areaHa),
      meanNdvi: finite(zone.meanNdvi),
      deviation: finite(zone.deviation) ?? finite(zone.ndviDeviation),
      rateKgHa: finite(zone.nitrogenRateKgHa) ?? finite(zone.productRateKgHa),
    }));
}

function zoneClassLabel(value: unknown): string | null {
  if (value === "below_average") return "偏弱区";
  if (value === "near_average") return "接近平均";
  if (value === "above_average") return "偏强区";
  return null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
