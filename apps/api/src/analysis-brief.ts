import type { AnalysisBrief, AnalysisBriefAction, AnalysisObjective, AnalysisResult } from "@chernozem/contracts";

import type { GrowthAssessmentPayload } from "./analysis-tools.js";
import type { FrostRiskPayload, WaterloggingAssessmentPayload, WaterNitrogenEvidencePayload } from "./multi-source-analysis.js";

const BRIEF_VERSION = "analysis-brief-v2" as const;

export function buildAnalysisBrief(objective: AnalysisObjective, results: AnalysisResult<unknown>[]): AnalysisBrief | null {
  const assessment = results.find((result) => result.kind === "assessment");
  if (!assessment?.result || assessment.kind !== "assessment") return null;

  switch (objective) {
    case "growth_stage_monitoring":
      return isGrowthPayload(assessment.result) ? growthBrief(assessment as AnalysisResult<GrowthAssessmentPayload>) : null;
    case "water_nitrogen_diagnosis":
      return isWaterNitrogenPayload(assessment.result) ? waterNitrogenBrief(assessment as AnalysisResult<WaterNitrogenEvidencePayload>) : null;
    case "waterlogging_detection":
      return isWaterloggingPayload(assessment.result) ? waterloggingBrief(assessment as AnalysisResult<WaterloggingAssessmentPayload>) : null;
    case "frost_risk_warning":
      return isFrostPayload(assessment.result) ? frostBrief(assessment as AnalysisResult<FrostRiskPayload>) : null;
  }
}

function isGrowthPayload(value: unknown): value is GrowthAssessmentPayload {
  return isRecord(value)
    && typeof value.latestObservationDate === "string"
    && typeof value.meanNdvi === "number"
    && typeof value.observationCount === "number"
    && typeof value.validCoverageFraction === "number"
    && typeof value.trend === "string"
    && typeof value.observationStatus === "string"
    && typeof value.belowAverageZoneCount === "number"
    && (value.belowAverageAreaHa === null || typeof value.belowAverageAreaHa === "number")
    && (value.belowAverageAreaFraction === null || typeof value.belowAverageAreaFraction === "number");
}

function isWaterNitrogenPayload(value: unknown): value is WaterNitrogenEvidencePayload {
  return isRecord(value)
    && typeof value.referenceDate === "string"
    && Number.isFinite(value.observationCount)
    && (value.validCoverageFraction === null || Number.isFinite(value.validCoverageFraction))
    && (value.attentionAreaHa === null || Number.isFinite(value.attentionAreaHa))
    && (value.attentionAreaFraction === null || Number.isFinite(value.attentionAreaFraction))
    && isRecord(value.observation)
    && typeof value.observation.variationStatus === "string"
    && ["optical_only", "multi_source", "field_comparison"].includes(String(value.evidenceLevel))
    && Array.isArray(value.sourceAlignment)
    && Array.isArray(value.zones);
}

function isWaterloggingPayload(value: unknown): value is WaterloggingAssessmentPayload {
  return isRecord(value)
    && typeof value.status === "string"
    && typeof value.beforeDate === "string"
    && typeof value.afterDate === "string"
    && typeof value.radarCoverageFraction === "number"
    && typeof value.changedAreaHa === "number"
    && typeof value.affectedAreaHa === "number"
    && Array.isArray(value.zones);
}

function isFrostPayload(value: unknown): value is FrostRiskPayload {
  return isRecord(value)
    && typeof value.risk === "string"
    && typeof value.forecastRunAt === "string"
    && typeof value.forecastCoverageFraction === "number"
    && typeof value.forecastMinTemperatureC === "number"
    && isRecord(value.forecastWindow)
    && typeof value.coldDurationHours === "number"
    && (value.cropStage === null || isRecord(value.cropStage) && typeof value.cropStage.label === "string")
    && Array.isArray(value.zones);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function growthBrief(assessment: AnalysisResult<GrowthAssessmentPayload>): AnalysisBrief {
  const result = assessment.result!;
  const weakArea = result.belowAverageAreaHa === null ? null : `${result.belowAverageAreaHa.toFixed(2)} 公顷`;
  const weakShare = result.belowAverageAreaFraction === null ? "" : `（占 ${(result.belowAverageAreaFraction * 100).toFixed(1)}%）`;
  const headline = `${result.latestObservationDate} 长势观测：${result.belowAverageZoneCount ? weakArea ? `约 ${weakArea}相对偏弱` : `${result.belowAverageZoneCount} 个同日相对偏弱区` : "可用范围内未检出明显田内差异"}`;
  const overview = `${result.latestObservationDate} 观测覆盖地块 ${(result.validCoverageFraction * 100).toFixed(1)}%，地块平均 NDVI ${result.meanNdvi.toFixed(3)}${result.stage ? `，估计处于${result.stage.label}` : ""}。${result.belowAverageZoneCount ? `田内 ${result.belowAverageZoneCount} 个同日相对偏弱分区，${weakArea ? `合计约 ${weakArea}${weakShare}` : "面积尚未计算"}。` : "可用范围内未检出明显田内相对弱区。"}`;
  const change = result.latestChange ? `${result.latestChange.fromDate} 到 ${result.latestChange.toDate}，地块平均 NDVI 变化 ${result.latestChange.ndviDelta >= 0 ? "+" : ""}${result.latestChange.ndviDelta.toFixed(3)}。` : "当前只有一个可用观测日期，尚无跨期变化统计。";
  const spatial = (result.weakZones ?? []).map((zone) => `偏弱分区 ${zone.rank}：${zone.areaHa === null ? "面积尚未计算" : `${zone.areaHa.toFixed(2)} 公顷`}${zone.meanNdvi === null ? "" : `，NDVI ${zone.meanNdvi.toFixed(3)}`}${zone.deviation === null ? "" : `，与全田同日均值相差 ${zone.deviation.toFixed(3)}`}。`).join("");
  const zoneChange = result.zoneChange;
  const dates = zoneChange?.status === "computed" && zoneChange.areas && zoneChange.fromDate
    ? `${zoneChange.fromDate} 与 ${zoneChange.toDate} 共同可观测范围的几何面积为 ${zoneChange.areas.commonObservedHa.toFixed(2)} 公顷，其中 ${zoneChange.areas.belowOnBothDatesHa.toFixed(2)} 公顷在两期均相对偏弱；${zoneChange.areas.newlyBelowWithinCommonHa.toFixed(2)} 公顷由非偏弱转为相对偏弱，${zoneChange.areas.noLongerBelowWithinCommonHa.toFixed(2)} 公顷由相对偏弱转为非偏弱。这些面积比较的是两期相对分级。${zoneChange.areas.currentBelowUnobservedPreviouslyHa > 0 ? `本期偏弱区另有 ${zoneChange.areas.currentBelowUnobservedPreviouslyHa.toFixed(2)} 公顷在前期没有可用观测。` : ""}${zoneChange.areas.previousBelowUnobservedCurrentlyHa > 0 ? `前期偏弱区另有 ${zoneChange.areas.previousBelowUnobservedCurrentlyHa.toFixed(2)} 公顷在本期没有可用观测。` : ""}` : "";
  const uncertainty = [
    result.observationStatus === "stale" ? `影像距任务结束日期 ${result.observationAgeDays ?? "未知"} 天，观测时间为 ${result.latestObservationDate}。` : null,
    result.validCoverageFraction < 0.8 ? `本次只覆盖地块的 ${(result.validCoverageFraction * 100).toFixed(1)}%，空间分布统计对应有数据的区域。` : null,
  ].filter((item): item is string => item !== null).join(" ") || null;
  return brief({ assessment, headline, overview, reasoning: `${change}${spatial}${dates}`, uncertainty, actions: [] });
}

function waterNitrogenBrief(assessment: AnalysisResult<WaterNitrogenEvidencePayload>): AnalysisBrief {
  const result = assessment.result!;
  const visible = result.observation.variationStatus === "visible";
  const area = result.attentionAreaHa === null ? "面积未计算" : `约 ${result.attentionAreaHa.toFixed(2)} 公顷${result.attentionAreaFraction === null ? "" : `（占 ${(result.attentionAreaFraction * 100).toFixed(1)}%）`}`;
  const coverage = result.validCoverageFraction === null ? "最新影像的有效覆盖尚未记录" : `最新影像有效覆盖 ${(result.validCoverageFraction * 100).toFixed(1)}%`;
  const stage = result.cropStage ? `，估计处于${result.cropStage.label}` : "";
  const headline = `${result.referenceDate} ${visible ? `田内相对低值区${area}` : "可用范围内未检出明显田内差异"}`;
  const overview = visible ? `${result.referenceDate}${stage}，${area}的植被表现低于同日其他区域。` : `${result.referenceDate}${stage}，可用影像范围内的植被表现较均匀。`;
  const change = result.latestChange ? `与 ${result.latestChange.fromDate} 相比，地块平均 NDVI 变化 ${result.latestChange.ndviDelta >= 0 ? "+" : ""}${result.latestChange.ndviDelta.toFixed(3)}。` : "尚无可比的跨期变化统计。";
  const measuredOverlaps = result.zones.flatMap((zone) => zone.radarOverlap?.status === "computed" && zone.radarOverlap.overlapAreaHa !== null
    ? [`${zone.opticalZoneId} 与雷达变化区的几何交集 ${zone.radarOverlap.overlapAreaHa.toFixed(2)} 公顷${zone.radarOverlap.overlapFraction === null ? "" : `（占分区几何面积 ${(zone.radarOverlap.overlapFraction * 100).toFixed(1)}%）`}`] : []);
  const reasoning = `本次纳入 ${result.observationCount} 个有效观测日期，${coverage}。${change}${measuredOverlaps.length ? `${measuredOverlaps.join("；")}。` : ""}`;
  const uncertainty = result.observationStatus === "stale" ? `影像距任务结束日期 ${result.observationAgeDays ?? "未知"} 天，观测时间为 ${result.referenceDate}。` : null;
  return brief({ assessment, headline, overview, reasoning, uncertainty, actions: [] });
}

function waterloggingBrief(assessment: AnalysisResult<WaterloggingAssessmentPayload>): AnalysisBrief {
  const result = assessment.result!;
  const range = `${result.beforeDate} 至 ${result.afterDate}`;
  const headline = result.status === "suspected"
    ? `${result.afterDate} 的雷达变化与降雨相互印证，发现 ${result.zones.length} 个疑似积水区`
    : result.status === "radar_change_only"
      ? result.zones.length ? "发现了雷达变化，但现在还不能说是积水" : "这组雷达对比没有发现明显变化区"
      : "这次没有发现达到门槛的疑似积水区";
  const overview = result.status === "suspected"
    ? `${range} 的同轨雷达有效覆盖 ${(result.radarCoverageFraction * 100).toFixed(1)}%；雷达变化和同期 ${result.rainfallMm?.toFixed(1) ?? "未知"} 毫米降雨同时出现，共识别 ${result.zones.length} 个疑似积水区，估算影响 ${result.affectedAreaHa.toFixed(2)} 公顷（占 ${(result.affectedAreaFraction * 100).toFixed(1)}%）。`
    : result.status === "radar_change_only"
      ? `${range} 的同轨雷达有效覆盖 ${(result.radarCoverageFraction * 100).toFixed(1)}%；${result.zones.length ? `发现 ${result.zones.length} 个显著变化区，约 ${result.changedAreaHa.toFixed(2)} 公顷` : "没有发现显著下降区"}，但还缺少能和这段变化对应的连续降雨资料。`
      : `${range} 的同轨雷达有效覆盖 ${(result.radarCoverageFraction * 100).toFixed(1)}%；${result.rainfallMm !== null && result.rainfallMm < result.rainfallThresholdMm ? `区间内最大降雨 ${result.rainfallMm.toFixed(1)} 毫米，没有达到 ${result.rainfallThresholdMm.toFixed(0)} 毫米事件门槛` : "雷达和降雨证据没有形成达到当前识别门槛的疑似积水区"}。`;
  const reasoning = result.status === "suspected"
    ? "雷达变化发生在降雨对应的时段，因此将这些区域列为疑似积水。若有低洼地形证据，可进一步安排核查顺序；实际是否受淹及积水深度仍需现场确认。"
    : result.status === "radar_change_only"
      ? "雷达变化也可能来自作物生长、耕作或地表湿度变化；没有同期连续降雨时，不能把它升级成积水判断。"
      : result.rainfallMm !== null && result.rainfallMm < result.rainfallThresholdMm
        ? `雷达前后时相内的降雨没有达到 ${result.rainfallThresholdMm.toFixed(0)} 毫米事件门槛，所以没有把雷达变化升级为积水判断。`
        : "强降雨后没有出现达到当前雷达变化门槛的空间区域。";
  const uncertainty = result.status === "radar_change_only"
    ? `还缺覆盖雷达前后时相的连续降雨资料，${result.zones.length ? "目前识别到的只是雷达变化区" : "本次未检出明显雷达变化，尚不足以完成积水判断"}。`
    : result.status === "suspected"
      ? "遥感结果不能计算积水深度，疑似区域仍要到现场确认有没有明水、受淹或排水不畅。"
      : "“没有发现”只针对这两期观测和当前检测门槛，不代表整个时段从未发生积水。";
  return brief({ assessment, headline, overview, reasoning, uncertainty, actions: waterloggingActions(assessment, result) });
}

function frostBrief(assessment: AnalysisResult<FrostRiskPayload>): AnalysisBrief {
  const result = assessment.result!;
  const start = displayMoment(result.forecastWindow.start, "预报窗口开始");
  const end = displayMoment(result.forecastWindow.end, "预报窗口结束");
  const riskLabel = result.risk === "high" ? "高" : result.risk === "watch" ? "关注" : result.risk === "normal" ? "正常" : "待判定";
  const sensitivity = result.stageSensitivity === "high" ? "高敏感" : result.stageSensitivity === "medium" ? "中等敏感" : result.stageSensitivity === "low" ? "低敏感" : "敏感性待判定";
  const headline = result.risk === "undetermined"
    ? `${start} 至 ${end} 预计有低温，玉米受冻风险还需结合生育期判断`
    : result.risk === "normal"
    ? `${start} 至 ${end} 暂未达到本次霜冻关注门槛`
    : result.risk === "high"
      ? `${start} 至 ${end} 霜冻风险较高，提前关注敏感区域`
      : `${start} 至 ${end} 有霜冻风险需要关注`;
  const overview = `这轮预报最低气温为 ${result.forecastMinTemperatureC.toFixed(1)}℃，低温预计持续约 ${result.coldDurationHours.toFixed(0)} 小时。${result.cropStage ? `玉米估计处于${result.cropStage.label}，属于${sensitivity}阶段；结合温度和持续时间，${result.risk === "normal" ? "尚未触发本次风险门槛" : `判为${riskLabel}风险`}。` : "还缺少有效生育期信息，因此目前能提示低温过程，尚不能确定玉米受冻风险。"}`;
  const reasoning = result.risk === "undetermined"
    ? `${displayMoment(result.forecastRunAt, "最新批次")}生成的预报覆盖任务时段的 ${(result.forecastCoverageFraction * 100).toFixed(1)}%。${result.zones.length ? `地图标出 ${result.zones.length} 个低洼关注区，便于提前核查冷空气可能滞留的位置。` : "还没有可用地形分区，暂不划定田内关注位置。"}低洼地形本身不代表作物已经受冻。`
    : result.risk === "normal"
    ? `${displayMoment(result.forecastRunAt, "最新批次")}生成的预报覆盖任务时段的 ${(result.forecastCoverageFraction * 100).toFixed(1)}%。温度、持续时间与估计生育期的组合未触发本次门槛；获得新预报后可重新判断。`
    : `${displayMoment(result.forecastRunAt, "最新批次")}生成的预报覆盖任务时段的 ${(result.forecastCoverageFraction * 100).toFixed(1)}%。风险由最低温、持续时间与估计生育期共同确定，${result.zones.length ? `地图上的 ${result.zones.length} 个低洼关注区用于安排核查顺序` : "缺少可用地形分区，目前只能给出地块层面的风险提示"}。`;
  const uncertainty = result.risk === "undetermined"
    ? "需要补充播种日期并核对实际生育期，才能进一步判断这次低温对玉米的影响。"
    : "预报反映地块附近的区域气温，田内最低温可能因地形而不同。这是未来风险提示，还不是已经发生冻害的结论。";
  return brief({ assessment, headline, overview, reasoning, uncertainty, actions: frostActions(assessment, result) });
}

function brief(options: {
  assessment: AnalysisResult<unknown>;
  headline: string;
  overview: string;
  reasoning: string;
  uncertainty: string | null;
  actions: AnalysisBriefAction[];
}): AnalysisBrief {
  return {
    version: BRIEF_VERSION,
    headline: options.headline,
    overview: options.overview,
    reasoning: options.reasoning,
    uncertainty: options.uncertainty,
    evidence: options.assessment.findings.slice(0, 4).map((finding) => ({ statement: finding.summary, sourceDates: finding.sourceDates })),
    actions: options.actions,
    generation: {
      mode: "deterministic",
      generatedAt: new Date().toISOString(),
      provider: null,
      modelId: null,
      promptVersion: null,
      fallbackReason: null,
    },
  };
}

function waterloggingActions(assessment: AnalysisResult<WaterloggingAssessmentPayload>, result: WaterloggingAssessmentPayload): AnalysisBriefAction[] {
  return assessment.nextActions.map((action) => {
    if (action.code === "collect_weather") {
      return { label: action.label, purpose: "判断雷达变化是否与同一降雨事件对应", decisionEffect: "若降雨时段与雷达变化吻合，优先核查积水；若不吻合，转查其他地表变化原因。", where: null, timing: "重新判定积水前", checklist: ["覆盖雷达前后时相", "核对连续降雨量和事件日期"] };
    }
    return {
      label: action.label,
      purpose: result.status === "suspected" ? "确认疑似积水区是否存在明水、受淹或排水不畅" : "判断雷达变化是否具有现场积水对应物",
      decisionEffect: "若现场有明水或排水不畅，优先按积水区处置；若无明水且排水正常，转查作物或地表变化。",
      where: result.zones.length
        ? result.zones.some((zone) => zone.priority === "high") ? "优先检查低洼且雷达变化明显的区域" : "优先检查雷达变化明显的区域"
        : "地块排水口和常见低洼处",
      timing: result.status === "suspected" ? "尽快，优先在地表水消退前" : "按本次事件巡田安排",
      checklist: ["是否存在明水", "积水边界", "作物倒伏或受淹", "排水沟通畅情况"],
      ...(action.zoneRef ? { zoneRef: action.zoneRef } : {}),
    };
  });
}

function frostActions(assessment: AnalysisResult<FrostRiskPayload>, result: FrostRiskPayload): AnalysisBriefAction[] {
  return assessment.nextActions.map((action) => {
    const timing = result.forecastWindow.start ? `${displayMoment(result.forecastWindow.start, "低温过程")}前完成` : "低温过程开始前";
    if (action.code === "add_planting_date" || action.code === "fix_planting_date") {
      return { label: action.label, purpose: "补齐霜冻风险等级所需的生育期依据", decisionEffect: "若播种日期与生育期记录一致，保留当前风险等级；若不一致，按修正后的生育期重新评估。", where: null, timing, checklist: ["核对本季播种日期", "确认当前实际生育期"] };
    }
    return {
      label: action.label,
      purpose: "确认低温预报对应的田间敏感位置和防护关注点",
      decisionEffect: "若低洼处出现低温或冻害迹象，优先列为防护区；若未出现，转查其他暴露区域。",
      where: result.zones.length ? "地图标出的低洼关注区" : "当前生育期敏感区域",
      timing,
      checklist: ["田间最低温", "冷空气滞留位置", "叶片冻害迹象", "防护措施准备情况"],
      ...(action.zoneRef ? { zoneRef: action.zoneRef } : {}),
    };
  });
}

function displayMoment(value: string | null, fallback: string): string {
  if (!value) return fallback;
  const match = value.match(/^\d{4}-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/);
  if (!match) return value;
  const date = `${Number(match[1])}月${Number(match[2])}日`;
  return match[3] && match[4] ? `${date} ${match[3]}:${match[4]}` : date;
}
