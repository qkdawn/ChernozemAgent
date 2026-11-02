import type { AnalysisBrief, AnalysisObjective, AnalysisResult, DiagnosticModule, DiagnosticReport } from "@chernozem/contracts";

type Data = Record<string, unknown>;
const record = (value: unknown): Data | null => value && typeof value === "object" && !Array.isArray(value) ? value as Data : null;
const number = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
const string = (value: unknown): string | null => typeof value === "string" && value.length > 0 ? value : null;
const fixed = (value: number) => `${value >= 0 ? "+" : ""}${value.toFixed(3)}`;

export function buildDiagnosticReport(objective: AnalysisObjective, results: AnalysisResult<unknown>[], brief?: AnalysisBrief | null): DiagnosticReport | null {
  const assessment = record(results.find((item) => item.kind === "assessment" && item.result)?.result);
  if (!assessment) return null;
  const growth = objective === "growth_stage_monitoring";
  const waterNitrogen = objective === "water_nitrogen_diagnosis";
  const weakZones = Array.isArray(assessment.weakZones) ? assessment.weakZones.map(record).filter((zone): zone is Data => !!zone) : [];
  const attentionZones = Array.isArray(assessment.zones) && waterNitrogen ? assessment.zones.map(record).filter((zone): zone is Data => !!zone) : [];
  const weakCount = growth ? number(assessment.belowAverageZoneCount) ?? weakZones.length : waterNitrogen && record(assessment.observation)?.variationStatus === "visible" ? attentionZones.length || (number(assessment.attentionAreaHa) ?? 0) > 0 ? 1 : 0 : 0;
  const hasWeak = weakCount > 0 || weakZones.length > 0;
  const date = string(assessment.latestObservationDate) ?? string(assessment.referenceDate) ?? string(assessment.afterDate) ?? new Date().toISOString().slice(0, 10);
  const isVegetationTask = growth || waterNitrogen;
  const optical = record(results.find((item) => item.kind === "optical_condition")?.result);
  const opticalChanges = Array.isArray(optical?.changes) ? optical.changes : [];
  const change = record(assessment.latestChange) ?? record(opticalChanges.at(-1));
  const fromDate = string(change?.fromDate);
  const toDate = string(change?.toDate);
  const deltas: NonNullable<DiagnosticModule["metricDeltas"]> = [];
  if (fromDate && toDate) for (const metric of ["ndvi", "reci", "msavi", "ndmi", "ndwi"] as const) {
    const delta = number(change?.[`${metric}Delta`]);
    if (delta !== null) deltas.push({ metric: metric.toUpperCase(), fromDate, toDate, delta });
  }
  const ndvi = deltas.find((item) => item.metric === "NDVI");
  const moisture = deltas.filter((item) => item.metric === "NDMI" || item.metric === "NDWI");
  const weather = record(results.find((item) => item.kind === "weather_event" && item.result)?.result);
  const historical = record(weather?.historical);
  const forecast = record(weather?.forecast);
  const weatherFacts = [
    number(historical?.totalRainfallMm) !== null ? `观测期累计降雨 ${number(historical?.totalRainfallMm)!.toFixed(1)} 毫米` : null,
    number(historical?.max24hRainfallMm) !== null ? `最大 24 小时降雨 ${number(historical?.max24hRainfallMm)!.toFixed(1)} 毫米` : null,
    number(forecast?.minTemperatureC) !== null ? `预报最低气温 ${number(forecast?.minTemperatureC)!.toFixed(1)}℃` : null,
  ].filter((part): part is string => !!part);
  const stage = record(assessment.stage) ?? record(assessment.cropStage);
  const zoneChange = record(assessment.zoneChange);
  const persistentArea = zoneChange?.status === "computed" ? number(record(zoneChange.areas)?.belowOnBothDatesHa) : null;
  const weakDescription = weakZones.length ? weakZones.slice(0, 2).map((zone) => `第 ${number(zone.rank) ?? 1} 关注区${number(zone.areaHa) !== null ? `约 ${number(zone.areaHa)!.toFixed(2)} 公顷` : ""}${number(zone.meanNdvi) !== null ? `，平均 NDVI ${number(zone.meanNdvi)!.toFixed(3)}` : ""}`).join("；") : weakCount ? `识别 ${weakCount} 个同日相对偏弱区${number(assessment.attentionAreaHa) !== null ? `，约 ${number(assessment.attentionAreaHa)!.toFixed(2)} 公顷` : number(assessment.belowAverageAreaHa) !== null ? `，约 ${number(assessment.belowAverageAreaHa)!.toFixed(2)} 公顷` : ""}` : "";
  const module = (id: string, title: string, body: string, ready: boolean, metricDeltas?: DiagnosticModule["metricDeltas"]): DiagnosticModule => ({ id, title, status: ready ? "ready" : "insufficient_evidence", body, ...(metricDeltas?.length ? { metricDeltas } : {}) });
  const modules: DiagnosticModule[] = [
    module("current-conditions", "当前气象与环境条件", weatherFacts.length ? `${weatherFacts.join("；")}。需结合观测时段判断与田内变化的关系。` : "缺少直接证据：本任务暂无可用于交叉核对的气象资料。", weatherFacts.length > 0),
    module("satellite-greening-trend", "遥感长势变化趋势", ndvi ? `${ndvi.fromDate} 至 ${ndvi.toDate}，全田平均 NDVI 变化 ${fixed(ndvi.delta)}，${ndvi.delta > 0 ? "整体转绿" : ndvi.delta < 0 ? "整体回落" : "整体持平"}。这反映地块均值变化，不能推断每个区域同向变化。` : "缺少直接证据：尚无可比的跨期长势观测。", !!ndvi, deltas),
    module("persistent-low-vigor", "持续性偏弱区域", !isVegetationTask ? "缺少直接证据：本任务没有田内长势分区对照。" : !hasWeak ? "未识别明确持续性偏弱区域；当前没有可排序偏弱区。" : `${weakDescription}。${persistentArea !== null ? `${string(zoneChange?.fromDate) ?? "前期"} 与 ${string(zoneChange?.toDate) ?? "本期"} 的共同可观测范围内，${persistentArea.toFixed(2)} 公顷两期均相对偏弱。` : "当前分区仅说明本期相对差异，持续性尚缺跨期同位置对照。"}`, hasWeak),
    module("moisture-pattern", "土壤与植被水分状况", moisture.length ? `${moisture.map((item) => `${item.metric} ${fixed(item.delta)}`).join("、")}，${moisture.some((item) => item.delta < 0) ? "部分水分相关信号回落" : "水分相关信号未见下降"}；成因待交叉验证，不能单凭指数判断土壤缺水或积水。` : "缺少直接证据：暂无可比水分指数变化。", moisture.length > 0, moisture),
    module("growth-stage-estimate", "作物生育期判断", string(stage?.label) ? `估计处于${string(stage?.label)}${number(stage?.daysAfterPlanting) !== null ? `，播后约 ${number(stage?.daysAfterPlanting)} 天` : ""}。${stage?.confidence === "medium" ? "估计可信度为中等，仍需现场核对。" : "依据现有作物历估计，需结合现场生育进度核对。"}` : "缺少直接证据：暂无可用生育期估计。", !!string(stage?.label)),
    module("water-disease-risk", "水分与病虫害风险", "缺少直接证据：尚不能判断倒伏、缺苗、病虫害、积温或收获风险；现场巡查时同步记录相关迹象。", false),
  ];
  const action = brief?.actions[0];
  const firstCheck = brief?.document?.sections.find((section) => section.id === "first-check");
  const recommendedNextStep = action ? {
    summary: action.label,
    bullets: [...[action.timing, action.where].filter((part): part is string => !!part).map((part) => part), ...action.checklist],
  } : firstCheck ? {
    summary: firstCheck.title,
    bullets: [...firstCheck.paragraphs, ...(firstCheck.items ?? []).map((item) => `${item.label}：${item.text}`)],
  } : {
    summary: hasWeak ? "先到地图标出的相对偏弱区巡查，再与邻近正常区对照" : isVegetationTask ? "全田选取两个代表性样段巡查，核对遥感判断" : objective === "waterlogging_detection" ? "核查地图上的雷达变化区与排水情况" : "核对低洼关注区和实际生育期",
    bullets: hasWeak ? ["核对偏弱区位置和冠层完整度", "与邻近正常区对照墒情、叶色和缺苗情况"] : isVegetationTask ? ["在田内选取两个代表性样段", "对照冠层、墒情和叶色，记录现场差异"] : objective === "waterlogging_detection" ? ["记录有无明水、受淹或排水不畅"] : ["核对播种日期和田内实际生育进度"],
  };
  return {
    aiReport: { generatedOn: date.slice(0, 10), summary: !isVegetationTask ? (brief?.overview ?? brief?.headline ?? "本次任务已有评估结果，需结合地图和现场核对。") : hasWeak ? `${date.slice(0, 10)} 的可用观测显示${weakDescription}，这些区域需优先关注；其他区域相对稳定。水分、压实或养分限制均可能造成差异，具体原因待现场核对。` : `${date.slice(0, 10)} 的可用观测显示全田表现接近平均，未识别可排序偏弱区；多数区域表现相对稳定。当前不宜指定异常位置，先用全田样段核对。` },
    modules,
    recommendedNextStep,
  };
}
