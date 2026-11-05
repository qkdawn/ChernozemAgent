import type { AnalysisBrief, AnalysisObjective, AnalysisResult, DiagnosticModule, DiagnosticReport } from "@chernozem/contracts";

type Data = Record<string, unknown>;
const record = (value: unknown): Data | null => value && typeof value === "object" && !Array.isArray(value) ? value as Data : null;
const number = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
const string = (value: unknown): string | null => typeof value === "string" && value.length > 0 ? value : null;
const fixed = (value: number) => `${value >= 0 ? "+" : ""}${value.toFixed(3)}`;
const metrics = ["ndvi", "ndre", "reci", "msavi", "ndmi", "ndwi"] as const;
const absolute = (value: number | undefined) => value === undefined ? "—" : value.toFixed(3);

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
  const observations = Array.isArray(optical?.observations) ? optical.observations.map(record).filter((item): item is Data => !!item) : [];
  const timeSeries = observations.flatMap((item) => {
    const observationDate = string(item.observationDate);
    if (!observationDate) return [];
    const observedMetrics = record(item.metrics);
    const values: Record<string, number> = {};
    for (const metric of metrics) {
      const mean = number(record(observedMetrics?.[metric])?.mean);
      if (mean !== null) values[metric] = mean;
    }
    return [{ date: observationDate, metrics: values }];
  }).sort((left, right) => left.date.localeCompare(right.date));
  const current = record(optical?.current);
  const currentNdvi = record(record(current?.metrics)?.ndvi);
  const meanNdvi = number(assessment.meanNdvi) ?? number(currentNdvi?.mean);
  const stdNdvi = number(currentNdvi?.std);
  const coverage = number(assessment.validCoverageFraction) ?? number(record(current?.quality)?.validFraction);
  const zones = Array.isArray(optical?.zones) ? optical.zones.map(record).filter((zone): zone is Data => !!zone) : null;
  const zoneCount = zones?.length;
  const nearCount = zones?.filter((zone) => zone.class === "near_average").length;
  const aboveCount = zones?.filter((zone) => zone.class === "above_average").length;
  const belowCount = zones?.filter((zone) => zone.class === "below_average").length ?? number(assessment.belowAverageZoneCount);
  const zoningQuality = record(optical?.zoningQuality);
  const robustRange = number(zoningQuality?.robustRange);
  const minimumRange = number(zoningQuality?.minimumRobustRange);
  const threshold = robustRange !== null && minimumRange !== null
    ? `NDVI 第90与第10百分位差 ${robustRange.toFixed(3)}，分区门槛 ${minimumRange.toFixed(3)}；${zoningQuality?.variationVisible === false ? "未达到差异门槛，有效区域归为近平均" : "达到差异门槛后按田内相对分位分区"}`
    : "偏弱区按田内相对 NDVI 分区判断；缺少分区质量门记录";
  const zoneSummary = zoneCount !== null && zoneCount !== undefined
    ? `共 ${zoneCount} 个分区：偏弱 ${belowCount ?? 0}、近平均 ${nearCount ?? 0}、偏高 ${aboveCount ?? 0}`
    : belowCount !== null ? `偏弱 ${belowCount} 个；缺少完整分区计数` : undefined;
  const fieldStats: NonNullable<DiagnosticReport["fieldStats"]> = {
    ...(meanNdvi !== null ? { meanNdvi } : {}), ...(stdNdvi !== null ? { stdNdvi } : {}),
    ...(coverage !== null ? { coveragePct: coverage * 100 } : {}),
    ...(zoneSummary ? { zoneSummary } : {}),
    belowAverageAreaHa: number(assessment.belowAverageAreaHa),
    threshold,
    ...(zoneCount !== null && zoneCount !== undefined ? { zoneCount } : {}),
    ...(number(record(assessment.areaBasis)?.fieldAreaHa) !== null ? { fieldAreaHa: number(record(assessment.areaBasis)?.fieldAreaHa)! } : {}),
  };
  const opticalChanges = Array.isArray(optical?.changes) ? optical.changes : [];
  const change = record(assessment.latestChange) ?? record(opticalChanges.at(-1));
  const fromDate = string(change?.fromDate);
  const toDate = string(change?.toDate);
  const deltas: NonNullable<DiagnosticModule["metricDeltas"]> = [];
  if (fromDate && toDate) for (const metric of metrics) {
    const delta = number(change?.[`${metric}Delta`]);
    if (delta !== null) deltas.push({ metric: metric.toUpperCase(), fromDate, toDate, delta,
      ...(timeSeries.find((item) => item.date === fromDate)?.metrics[metric] !== undefined ? { fromValue: timeSeries.find((item) => item.date === fromDate)!.metrics[metric] } : {}),
      ...(timeSeries.find((item) => item.date === toDate)?.metrics[metric] !== undefined ? { toValue: timeSeries.find((item) => item.date === toDate)!.metrics[metric] } : {}),
    });
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
  const ndviPath = timeSeries.filter((item) => item.metrics.ndvi !== undefined).map((item) => `${item.date} ${absolute(item.metrics.ndvi)}`).join(" → ");
  const moisturePath = timeSeries.filter((item) => item.metrics.ndmi !== undefined || item.metrics.ndwi !== undefined)
    .map((item) => `${item.date} NDMI ${absolute(item.metrics.ndmi)}、NDWI ${absolute(item.metrics.ndwi)}`).join(" → ");
  const ndviSteps = timeSeries.flatMap((item, index) => {
    const previous = timeSeries[index - 1];
    return previous?.metrics.ndvi !== undefined && item.metrics.ndvi !== undefined
      ? [{ from: previous.date, to: item.date, delta: item.metrics.ndvi - previous.metrics.ndvi }] : [];
  });
  const largestDrop = ndviSteps.filter((step) => step.delta < 0).sort((a, b) => a.delta - b.delta)[0];
  const largestRise = ndviSteps.filter((step) => step.delta > 0).sort((a, b) => b.delta - a.delta)[0];
  const turns = [largestDrop ? `最大单期回落为 ${largestDrop.from} 至 ${largestDrop.to} ${fixed(largestDrop.delta)}` : null,
    largestRise ? `最大单期回升为 ${largestRise.from} 至 ${largestRise.to} ${fixed(largestRise.delta)}` : null].filter(Boolean).join("；");
  const latestValues = ndvi?.fromValue !== undefined && ndvi.toValue !== undefined
    ? `，由 ${absolute(ndvi.fromValue)} 至 ${absolute(ndvi.toValue)}` : "";
  const statsText = [meanNdvi !== null ? `全田平均 NDVI ${meanNdvi.toFixed(3)}` : null,
    stdNdvi !== null ? `标准差 ${stdNdvi.toFixed(4)}` : null,
    coverage !== null ? `有效覆盖 ${(coverage * 100).toFixed(1)}%` : null,
    zoneSummary, number(assessment.belowAverageAreaHa) !== null ? `偏弱区面积 ${number(assessment.belowAverageAreaHa)!.toFixed(2)} 公顷` : null]
    .filter(Boolean).join("；");
  const stageText = string(stage?.label) ? `按播期估计为${string(stage?.label)}${number(stage?.daysAfterPlanting) !== null ? `、播后约 ${number(stage?.daysAfterPlanting)} 天` : ""}，可信度${stage?.confidence === "medium" ? "中等" : stage?.confidence === "low" ? "较低" : "未标明"}` : "尚无可用生育期估计";
  const indexDirection = ndvi && moisture.length ? `最近一期绿度指标 NDVI ${fixed(ndvi.delta)}，水分相关指标 ${moisture.map((item) => `${item.metric} ${fixed(item.delta)}`).join("、")}${moisture.some((item) => Math.sign(item.delta) !== Math.sign(ndvi.delta)) ? "，方向不完全一致" : "，方向一致"}` : ndvi ? `最近一期 NDVI ${fixed(ndvi.delta)}` : "缺少可比的多指数变化";
  const module = (id: string, title: string, body: string, ready: boolean, evidenceNotes: string[], metricDeltas?: DiagnosticModule["metricDeltas"]): DiagnosticModule => ({ id, title, status: ready ? "ready" : "insufficient_evidence", body, evidenceNotes, ...(metricDeltas?.length ? { metricDeltas } : {}) });
  const modules: DiagnosticModule[] = [
    module("current-conditions", "当前气象与环境条件", weatherFacts.length ? `${weatherFacts.join("；")}。需按观测日期核对与田内变化的先后关系，不能只凭同期出现判断成因。` : "缺少直接证据：本任务暂无与光学观测日期对应的降雨、气温资料，无法解释近期指数变化是否受天气影响；现场核查时补记降雨、田间积水和温度影响。", weatherFacts.length > 0, weatherFacts.length ? [`气象记录：${weatherFacts.join("；")}`] : ["缺口：观测期降雨和气温记录"]),
    module("satellite-greening-trend", "遥感长势变化趋势", ndvi ? `${ndviPath ? `可用观测的全田平均 NDVI 路径：${ndviPath}。` : "缺少完整的跨期绝对值路径。"}${turns ? `${turns}。` : ""}最近 ${ndvi.fromDate} 至 ${ndvi.toDate}，NDVI 变化 ${fixed(ndvi.delta)}${latestValues}；${ndvi.delta > 0 ? "全田均值回升" : ndvi.delta < 0 ? "全田均值回落" : "全田均值持平"}。${indexDirection}；这些是地块均值，田内分布见分区结果。` : `缺少直接证据：尚无可比的跨期 NDVI 观测。${ndviPath ? `现有绝对值：${ndviPath}。` : "需补充至少两个可用日期。"}`, !!ndvi, [`光学可用日期：${timeSeries.map((item) => item.date).join("、") || "缺少观测明细"}`, ...(turns ? [turns] : [])], deltas),
    module("persistent-low-vigor", "持续性偏弱区域", !isVegetationTask ? "缺少直接证据：本任务没有田内长势分区对照。" : !hasWeak ? `已评估田内相对分区，未识别偏弱区，也没有可排序的偏弱带。${statsText || "缺少分区统计"}。${threshold}。${zoneChange?.status === "computed" ? `跨期共同偏弱面积 ${persistentArea?.toFixed(2) ?? "未知"} 公顷。` : "持续性仍需同位置跨期对照。"}` : `${weakDescription}。${statsText}。${persistentArea !== null ? `${string(zoneChange?.fromDate) ?? "前期"} 与 ${string(zoneChange?.toDate) ?? "本期"} 的共同可观测范围内，${persistentArea.toFixed(2)} 公顷两期均相对偏弱。` : "当前分区仅说明本期相对差异，持续性尚缺跨期同位置对照。"} ${threshold}。`, isVegetationTask && (hasWeak || belowCount !== null), [statsText || "缺口：分区统计", threshold]),
    module("moisture-pattern", "土壤与植被水分状况", moisture.length || moisturePath ? `${moisturePath ? `可用观测的水分相关指数路径：${moisturePath}。` : "缺少水分指数绝对值路径。"}${moisture.length ? `最近 ${fromDate} 至 ${toDate}：${moisture.map((item) => `${item.metric} ${absolute(item.fromValue)}→${absolute(item.toValue)}（${fixed(item.delta)}）`).join("、")}。` : "尚无可比的跨期变化。"}${ndvi && moisture.some((item) => Math.sign(item.delta) !== Math.sign(ndvi.delta)) ? `同一期 NDVI ${fixed(ndvi.delta)}，与部分水分指数方向不同。` : ""}指数反映冠层信号，成因待交叉验证，不能单凭指数判断土壤缺水或积水。` : "缺少直接证据：暂无可比水分指数观测；需补充可用影像并现场记录土壤墒情与明水。", moisture.length > 0, [moisturePath ? `水分指数日期：${timeSeries.filter((item) => item.metrics.ndmi !== undefined || item.metrics.ndwi !== undefined).map((item) => item.date).join("、")}` : "缺口：水分指数绝对值", "缺口：现场墒情或积水记录"], moisture),
    module("growth-stage-estimate", "作物生育期判断", string(stage?.label) ? `${stageText}。该判断来自播期与参考日，不是影像直接识别；成熟期应结合籽粒与植株状态核对收获进度。` : "缺少直接证据：暂无可用生育期估计；请核对播种日期与当前籽粒、植株状态。", !!string(stage?.label), [string(stage?.label) ? `参考日 ${string(stage?.referenceDate) ?? date}；${stageText}` : "缺口：播种日期或生育期估计"]),
    module("water-disease-risk", "水分与病虫害风险", "缺少直接证据：本任务没有病虫害、倒伏、缺苗或田间积水的现场记录，也缺少可直接验证这些风险的观测；不能据此判定发生位置或程度。巡田时记录叶片病斑、虫口、倒伏、缺苗与明水，并与图上区域对应。", false, ["缺口：病虫害、倒伏、缺苗与明水的定位现场记录", "建议：逐点拍照并记录发生日期"]),
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
    aiReport: { generatedOn: date.slice(0, 10), summary: !isVegetationTask ? (brief?.overview ?? brief?.headline ?? "本次任务已有评估结果，需结合地图和现场核对。") : [
      `${date.slice(0, 10)} 的可用观测显示${hasWeak ? weakDescription : "全田分区以近平均为主，未识别可排序偏弱区"}；${statsText || "暂无完整均值和覆盖统计"}。`,
      ndviPath ? `NDVI 时序为 ${ndviPath}${turns ? `；${turns}` : ""}。` : "缺少可用的完整 NDVI 时序，暂不能描述窗口内拐点。",
      `${indexDirection}；多指数变化不能单独证明水分或养分成因。`,
      `${stageText}；${hasWeak ? "先核查地图标出的关注区，再与相邻区域对照。" : "先选全田代表性样段核对冠层、墒情和实际成熟进度。"}`,
    ].join(" ") },
    modules,
    recommendedNextStep,
    ...(timeSeries.length ? { timeSeries } : {}),
    fieldStats,
  };
}
