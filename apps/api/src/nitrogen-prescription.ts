import type {
  AnalysisTask,
  CreateVariableNitrogenPrescriptionRequest,
  FieldSummary,
  NitrogenManagementLevel,
  Position,
  VariableNitrogenPrescription,
  VariableNitrogenSourceOption,
  VariableNitrogenZone,
} from "@chernozem/contracts";
import area from "@turf/area";
import { randomUUID } from "node:crypto";

interface OpticalZoneInput {
  id: string;
  meanNdvi: number;
  class: "below_average" | "near_average" | "above_average";
  zone: number[][];
}

interface OpticalPayloadInput {
  current?: { observationDate?: string; metrics?: { ndvi?: { mean?: number } } };
  zoningMethod?: string;
  zoningQuality?: { variationVisible?: boolean };
  zones?: OpticalZoneInput[];
}

const SUPPORTED_ZONING_METHOD = "ndvi-quantile-connected-v2";

const LEVELS: NitrogenManagementLevel[] = ["low", "medium", "high"];
const LEVEL_LABELS: Record<NitrogenManagementLevel, string> = {
  low: "相对低长势区",
  medium: "中等长势区",
  high: "相对高长势区",
};

export class NitrogenPrescriptionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export function collectNitrogenSourceOptions(tasks: AnalysisTask[], boundaryVersion?: number): VariableNitrogenSourceOption[] {
  return tasks.flatMap((task) => {
    const optical = usableOpticalResult(task);
    const payload = optical?.result as OpticalPayloadInput | null | undefined;
    const sourceDate = payload?.current?.observationDate;
    const meanNdvi = payload?.current?.metrics?.ndvi?.mean;
    const zones = validZones(payload?.zones);
    if ((boundaryVersion !== undefined && task.boundaryVersion !== undefined && task.boundaryVersion !== boundaryVersion) || task.status === "failed" || payload?.zoningMethod !== SUPPORTED_ZONING_METHOD || payload.zoningQuality?.variationVisible !== true || !sourceDate || !Number.isFinite(meanNdvi) || !hasAllManagementLevels(zones)) return [];
    const groups = groupZones(zones);
    const managementZones = LEVELS.map((level) => buildZone(level, groups[level], 0, 1));
    return [{
      sourceTaskId: task.id,
      sourceDate,
      meanNdvi: Number(meanNdvi),
      zoneCount: zones.length,
      createdAt: task.createdAt,
      zones: managementZones.map(({ id, level, label, meanNdvi: zoneMeanNdvi, areaHa, polygons }) => ({ id, level, label, meanNdvi: zoneMeanNdvi, areaHa, polygons })),
    }];
  }).filter((option, index, all) => all.findIndex((candidate) => candidate.sourceDate === option.sourceDate) === index)
    .sort((left, right) => right.sourceDate.localeCompare(left.sourceDate));
}

export function createVariableNitrogenPrescription(
  field: FieldSummary,
  task: AnalysisTask,
  input: CreateVariableNitrogenPrescriptionRequest,
  now = new Date(),
): VariableNitrogenPrescription {
  validateRequest(input);
  if (field.crop !== "corn") throw new NitrogenPrescriptionError("crop_not_supported", "首版变量施氮仅支持玉米地块。");
  if (task.fieldId !== field.id) throw new NitrogenPrescriptionError("source_task_mismatch", "所选影像不属于当前地块。");
  if (task.boundaryVersion !== undefined && task.boundaryVersion !== field.boundaryVersion) throw new NitrogenPrescriptionError("boundary_version_mismatch", "地块边界已更新，请重新生成光学分区。");
  const optical = usableOpticalResult(task);
  const payload = optical?.result as OpticalPayloadInput | null | undefined;
  if (!payload) throw new NitrogenPrescriptionError("optical_result_missing", "所选任务没有可用的光学分析结果。");
  if (payload.current?.observationDate !== input.sourceDate) throw new NitrogenPrescriptionError("source_date_mismatch", "所选日期与光学分析结果不一致。");
  const sourceZones = validZones(payload.zones);
  if (payload.zoningMethod !== SUPPORTED_ZONING_METHOD || payload.zoningQuality?.variationVisible !== true || !hasAllManagementLevels(sourceZones)) throw new NitrogenPrescriptionError("zones_insufficient", "该日期的田内差异不足，或没有可用于变量施氮的连续管理分区。");

  const groups = groupZones(sourceZones);
  const zones = LEVELS.map((level) => buildZone(level, groups[level], input.rates[level], input.nitrogenPercent));
  const totalAreaHa = sum(zones.map((zone) => zone.areaHa));
  const totalProductKg = sum(zones.map((zone) => zone.totalProductKg));
  const totalNitrogenKg = sum(zones.map((zone) => zone.totalNitrogenKg));
  const uniformProductKg = totalAreaHa * input.standardRateKgHa;
  const timestamp = now.toISOString();
  return {
    id: randomUUID(),
    fieldId: field.id,
    boundaryVersion: field.boundaryVersion,
    status: "needs_review",
    sourceTaskId: task.id,
    sourceDate: input.sourceDate,
    sourceMetric: "ndvi",
    fertilizerName: input.fertilizerName.trim(),
    nitrogenPercent: round(input.nitrogenPercent, 2),
    standardRateKgHa: round(input.standardRateKgHa, 2),
    zones,
    totalAreaHa: round(totalAreaHa, 4),
    totalProductKg: round(totalProductKg, 2),
    totalNitrogenKg: round(totalNitrogenKg, 2),
    uniformProductKg: round(uniformProductKg, 2),
    productDifferenceKg: round(totalProductKg - uniformProductKg, 2),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function prescriptionGeoJson(prescription: VariableNitrogenPrescription) {
  return {
    type: "FeatureCollection" as const,
    features: prescription.zones.flatMap((zone) => zone.polygons.map((ring, index) => ({
      type: "Feature" as const,
      id: `${zone.id}-${index + 1}`,
      properties: {
        prescriptionId: prescription.id,
        status: prescription.status,
        sourceDate: prescription.sourceDate,
        sourceMetric: prescription.sourceMetric,
        managementLevel: zone.level,
        managementLabel: zone.label,
        fertilizerName: prescription.fertilizerName,
        productRateKgHa: zone.productRateKgHa,
        nitrogenRateKgHa: zone.nitrogenRateKgHa,
        polygonAreaHa: round(polygonAreaHa(ring), 4),
      },
      geometry: { type: "Polygon" as const, coordinates: [closedCoordinates(ring)] },
    }))),
  };
}

function usableOpticalResult(task: AnalysisTask) {
  return task.analysisResults.find((result) => result.kind === "optical_condition" && (result.status === "succeeded" || result.status === "partial"));
}

function validZones(zones: OpticalPayloadInput["zones"]): OpticalZoneInput[] {
  return (zones ?? []).filter((zone) => ["below_average", "near_average", "above_average"].includes(zone.class) && Number.isFinite(zone.meanNdvi) && Array.isArray(zone.zone) && zone.zone.length >= 4);
}

function groupZones(zones: OpticalZoneInput[]): Record<NitrogenManagementLevel, OpticalZoneInput[]> {
  return {
    low: zones.filter((zone) => zone.class === "below_average"),
    medium: zones.filter((zone) => zone.class === "near_average"),
    high: zones.filter((zone) => zone.class === "above_average"),
  };
}

function hasAllManagementLevels(zones: OpticalZoneInput[]): boolean {
  const groups = groupZones(zones);
  return LEVELS.every((level) => groups[level].length > 0);
}

function buildZone(level: NitrogenManagementLevel, inputs: OpticalZoneInput[], productRateKgHa: number, nitrogenPercent: number): VariableNitrogenZone {
  const polygons = inputs.map((input) => input.zone.map(([longitude, latitude]) => ({ longitude: longitude!, latitude: latitude! })));
  const areas = polygons.map(polygonAreaHa);
  const areaHa = sum(areas);
  const meanNdvi = areaHa > 0
    ? sum(inputs.map((input, index) => input.meanNdvi * areas[index]!)) / areaHa
    : sum(inputs.map((input) => input.meanNdvi)) / inputs.length;
  const totalProductKg = areaHa * productRateKgHa;
  const nitrogenRateKgHa = productRateKgHa * nitrogenPercent / 100;
  return {
    id: `management-${level}`,
    level,
    label: LEVEL_LABELS[level],
    meanNdvi: round(meanNdvi, 4),
    areaHa: round(areaHa, 4),
    productRateKgHa: round(productRateKgHa, 2),
    nitrogenRateKgHa: round(nitrogenRateKgHa, 2),
    totalProductKg: round(totalProductKg, 2),
    totalNitrogenKg: round(totalProductKg * nitrogenPercent / 100, 2),
    polygons,
  };
}

function validateRequest(input: CreateVariableNitrogenPrescriptionRequest): void {
  if (!input || typeof input.sourceTaskId !== "string" || !input.sourceTaskId || typeof input.sourceDate !== "string") {
    throw new NitrogenPrescriptionError("source_required", "请选择用于分区的光学日期。");
  }
  if (typeof input.fertilizerName !== "string" || !input.fertilizerName.trim() || input.fertilizerName.trim().length > 80) {
    throw new NitrogenPrescriptionError("fertilizer_invalid", "请输入有效的肥料名称。");
  }
  if (!Number.isFinite(input.nitrogenPercent) || input.nitrogenPercent <= 0 || input.nitrogenPercent > 100) {
    throw new NitrogenPrescriptionError("nitrogen_percent_invalid", "含氮率必须大于 0 且不超过 100%。");
  }
  for (const [name, value] of Object.entries({ standardRateKgHa: input.standardRateKgHa, ...input.rates })) {
    if (!Number.isFinite(value) || value < 0 || value > 2000) throw new NitrogenPrescriptionError("rate_invalid", `${name} 必须是 0 至 2000 kg/ha。`);
  }
}

function polygonAreaHa(ring: Position[]): number {
  return area({ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [closedCoordinates(ring)] } }) / 10_000;
}

function closedCoordinates(ring: Position[]): number[][] {
  const coordinates = ring.map((point) => [point.longitude, point.latitude]);
  const first = coordinates[0];
  const last = coordinates.at(-1);
  if (first && last && (first[0] !== last[0] || first[1] !== last[1])) coordinates.push([...first]);
  return coordinates;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
