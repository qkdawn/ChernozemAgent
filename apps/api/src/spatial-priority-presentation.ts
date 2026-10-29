import type { SpatialPriority, WaterNitrogenEvidencePayload } from "./multi-source-analysis.js";

export function summarizeSpatialPriorityForBrief(result: WaterNitrogenEvidencePayload): {
  overviewClause: string;
  reasoningClause: string;
  firstLookZoneId: string | null;
} {
  const summary = result.spatialPrioritySummary;
  if (!summary) return {
    overviewClause: "当前无可用雷达/低洼弱区交集优先级，无法据此调整先看哪一块。",
    reasoningClause: "未提供多源空间交集排序。",
    firstLookZoneId: null,
  };

  const zonesById = new Map(result.zones.map((zone) => [zone.id, zone]));
  const orderedZones = summary.orderedZoneIds.flatMap((id) => {
    const zone = zonesById.get(id);
    return zone ? [zone] : [];
  });
  const firstLookZoneId = summary.changesAnyPriority === true
    ? orderedZones.find((zone) => zone.spatialPriority.changesPriority === true)?.id ?? null
    : null;
  const overviewClause = summary.changesAnyPriority === true
    ? firstLookZoneId ? `多源空间交集已调整先看顺序，优先查看 ${zoneLabel(zonesById.get(firstLookZoneId)!.opticalZoneId)}。` : "多源空间交集改变了弱区先看顺序。"
    : summary.changesAnyPriority === false
      ? "多源空间证据已测零交，未改变先看哪一块弱区。"
      : "雷达/低洼弱区交集不可计算，无法据此调整先看哪一块。";
  const reasoningClause = orderedZones.length
    ? orderedZones.map((zone) => priorityNote(zone.opticalZoneId, zone.spatialPriority, zone.radarOverlap, zone.lowlandOverlap)).join("")
    : "没有可排序的弱区。";
  return { overviewClause, reasoningClause, firstLookZoneId };
}

export function overlapTextImpliesForbiddenMoistureClaim(text: string): boolean {
  return /无水分问题|无水分|证明无积水|排除水分|没有水分问题|不存在水分问题|不存在积水|未发现积水问题/.test(text);
}

function priorityNote(zoneId: string, priority: SpatialPriority, radar: WaterNitrogenEvidencePayload["zones"][number]["radarOverlap"], lowland: WaterNitrogenEvidencePayload["zones"][number]["lowlandOverlap"]): string {
  const areas = [
    `雷达${overlapArea(radar)}`,
    `低洼${overlapArea(lowland)}`,
  ].join("、");
  return `${zoneLabel(zoneId)}：${priority.note}（${areas}）。`;
}

function overlapArea(overlap: WaterNitrogenEvidencePayload["zones"][number]["radarOverlap"]): string {
  return overlap.status === "computed" && overlap.overlapAreaHa !== null
    ? `${overlap.overlapAreaHa.toFixed(2)} 公顷${overlap.overlapAreaHa > 0 ? "有交" : "已测零交"}`
    : "不可计算";
}

function zoneLabel(id: string): string {
  return id.startsWith("water-nitrogen-") ? id.slice("water-nitrogen-".length) : id;
}
