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
    ? `分区门槛依据：P90−P10=${robustRange.toFixed(3)}，门槛=${minimumRange.toFixed(3)}（田内 NDVI 第90与第10百分位差）`
    : "";
  const zoneSummary = zoneCount !== null && zoneCount !== undefined
    ? `共 ${zoneCount} 个分区：偏弱 ${belowCount ?? 0}、近平均 ${nearCount ?? 0}、偏高 ${aboveCount ?? 0}`
    : belowCount !== null ? `偏弱 ${belowCount} 个` : undefined;
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
  const weatherResult = results.find((item) => item.kind === "weather_event");
  const weatherUsable = weatherResult?.status === "succeeded" || weatherResult?.status === "partial";
  const terrainResult = results.find((item) => item.kind === "terrain_susceptibility");
  const terrainUsable = terrainResult?.status === "succeeded" || terrainResult?.status === "partial";
  const terrain = record(terrainResult?.result);
  const soilResult = results.find((item) => item.kind === "soil_background");
  const soilUsable = soilResult?.status === "succeeded" || soilResult?.status === "partial";
  const soil = record(soilResult?.result);
  const radarResult = results.find((item) => item.kind === "radar_change");
  const radarUsable = radarResult?.status === "succeeded" || radarResult?.status === "partial";
  const radar = record(radarResult?.result);
  const stageResult = results.find((item) => item.kind === "crop_stage");
  const stagePayload = record(stageResult?.result);
  const stage = record(assessment.stage) ?? record(assessment.cropStage) ?? stagePayload;
  const fieldRecordSource = stageResult?.sources.find((source) => source.source === "field_record");
  const plantingProvenance = string(assessment.plantingDateSource) ?? string(assessment.plantingDateProvenance)
    ?? (fieldRecordSource ? `${fieldRecordSource.source}${fieldRecordSource.date ? `（${fieldRecordSource.date}）` : ""}：${fieldRecordSource.note}` : null);
  const weatherEvidence: string[] = [];
  if (historical && weatherUsable) {
    const historicalValues = [
      number(historical.totalRainfallMm) !== null ? `累计降雨 ${number(historical.totalRainfallMm)!.toFixed(1)} 毫米` : null,
      number(historical.minTemperatureC) !== null ? `最低气温 ${number(historical.minTemperatureC)!.toFixed(1)}℃` : null,
      number(historical.max24hRainfallMm) !== null ? `最大 24 小时降雨 ${number(historical.max24hRainfallMm)!.toFixed(1)} 毫米` : null,
    ].filter((value): value is string => !!value);
    if (historicalValues.length) weatherEvidence.push(`ERA5-Land（约 9 公里格点，${string(historical.start) ?? ""} 至 ${string(historical.end) ?? ""}）：${historicalValues.join("、")}`);
  }
  if (forecast && weatherUsable) {
    const forecastValues = [
      number(forecast.minTemperatureC) !== null ? `最低气温 ${number(forecast.minTemperatureC)!.toFixed(1)}℃` : null,
      number(forecast.cumulativeRainfallMm) !== null ? `累计降水 ${number(forecast.cumulativeRainfallMm)!.toFixed(1)} 毫米` : null,
      string(forecast.start) || string(forecast.end) ? `有效期 ${string(forecast.start) ?? "未知"} 至 ${string(forecast.end) ?? "未知"}` : null,
    ].filter((value): value is string => !!value);
    if (forecastValues.length) weatherEvidence.push(`ECMWF IFS 预报${forecast.runAt ? `（起报 ${forecast.runAt}）` : ""}：${forecastValues.join("、")}`);
  }
  const terrainMetrics = record(terrain?.metrics);
  const terrainZones = Array.isArray(terrain?.zones) ? terrain.zones.map(record).filter((item): item is Data => !!item) : [];
  const soilMeasurements = Array.isArray(soil?.measurements) ? soil.measurements.map(record).filter((item): item is Data => !!item) : [];
  const radarObservations = Array.isArray(radar?.observations) ? radar.observations.map(record).filter((item): item is Data => !!item) : [];
  const environmentEvidence: string[] = [...weatherEvidence];
  if (terrain && terrainUsable) {
    environmentEvidence.push(`DEM（约 30 米）${number(terrainMetrics?.minElevationM) !== null && number(terrainMetrics?.maxElevationM) !== null ? `田面高程 ${number(terrainMetrics?.minElevationM)!.toFixed(1)} 至 ${number(terrainMetrics?.maxElevationM)!.toFixed(1)} 米，` : ""}低洼关注分区 ${terrainZones.filter((zone) => zone.class === "low").length} 个`);
  }
  if (soil && soil.available !== false && soilUsable) {
    const soilValues = soilMeasurements.filter((item) => string(item.label) === "pH" || string(item.property) === "phh2o").flatMap((item) => number(item.mean) === null ? [] : [`${string(item.depth)?.replace(/(\d)-(\d)/g, "$1–$2").replace(/cm$/, " cm") ?? "表层"} ${number(item.mean)!.toFixed(2)}`]);
    if (soilValues.length) environmentEvidence.push(`SoilGrids（约 ${number(soil.resolutionMeters) ?? 250} 米）pH ${soilValues.join("、")}`);
  }
  if (radar && radarUsable) {
    const comparable = radar.comparable === true;
    const radarDates = radarObservations.map((item) => string(item.date)).filter((value): value is string => !!value);
    environmentEvidence.push(comparable
      ? `Sentinel-1 可比雷达变化（${string(radar.beforeDate) ?? ""} 至 ${string(radar.afterDate) ?? ""}）`
      : `Sentinel-1 ${radarDates.join("、")} 单期观测，尚无可比变化对${radarResult?.status === "partial" ? "（部分结果）" : ""}`);
  }
  const opticalQuality = record(current?.quality);
  const qualityNotes = opticalQuality
    ? [`影像质量与覆盖核验：有效覆盖 ${number(opticalQuality.validFraction) !== null ? `${(number(opticalQuality.validFraction)! * 100).toFixed(1)}%` : "未标明"}${number(opticalQuality.cloudAffectedFraction) !== null ? `，云影响 ${(number(opticalQuality.cloudAffectedFraction)! * 100).toFixed(1)}%` : ""}${Array.isArray(opticalQuality.flags) ? `；质量标记 ${opticalQuality.flags.join("、") || "无"}` : ""}`]
    : [];
  if (opticalQuality) environmentEvidence.push(`Sentinel-2 ${qualityNotes[0]}`);
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
  const stageText = string(stage?.label) ? `按播期估计为${string(stage?.label)}${number(stage?.daysAfterPlanting) !== null ? `、播后约 ${number(stage?.daysAfterPlanting)} 天` : ""}，可信度${stage?.confidence === "medium" ? "中等" : stage?.confidence === "low" ? "较低" : "未标明"}` : "";
  const moistureDiffers = !!ndvi && moisture.some((item) => Math.sign(item.delta) !== Math.sign(ndvi.delta));
  const moistureValues = moisture.map((item) => item.fromValue !== undefined && item.toValue !== undefined
    ? `${item.metric} 从 ${absolute(item.fromValue)} ${item.delta < 0 ? "降至" : item.delta > 0 ? "升至" : "变为"} ${absolute(item.toValue)}（${fixed(item.delta)}）`
    : `${item.metric} ${item.delta < 0 ? "下降" : item.delta > 0 ? "上升" : "变化"} ${fixed(item.delta)}`).join("，");
  const ndviValues = ndvi ? ndvi.fromValue !== undefined && ndvi.toValue !== undefined
    ? `NDVI 从 ${absolute(ndvi.fromValue)} ${ndvi.delta < 0 ? "降至" : ndvi.delta > 0 ? "升至" : "变为"} ${absolute(ndvi.toValue)}（${fixed(ndvi.delta)}）`
    : `NDVI ${ndvi.delta < 0 ? "下降" : ndvi.delta > 0 ? "上升" : "变化"} ${fixed(ndvi.delta)}` : "";
  const module = (id: string, title: string, body: string, ready: boolean, evidenceNotes: string[], metricDeltas?: DiagnosticModule["metricDeltas"]): DiagnosticModule => ({ id, title, status: ready ? "ready" : "insufficient_evidence", body, evidenceNotes, ...(metricDeltas?.length ? { metricDeltas } : {}) });
  const modules: DiagnosticModule[] = [
    module("current-conditions", "当前气象与环境条件", environmentEvidence.length ? `${environmentEvidence.join("。 ")}。${ndvi && moistureDiffers ? "同期绿度指数与水分指数方向不同。" : ""}对照样段时记录土壤干湿与植株状态。` : "", environmentEvidence.length > 0, environmentEvidence),
    module("satellite-greening-trend", "遥感长势变化趋势", ndvi ? `${ndvi.fromDate} 至 ${ndvi.toDate}，全田 ${ndviValues}。${moistureDiffers ? "同期水分相关指数方向不同。" : ""}${ndviPath ? `时序 NDVI：${ndviPath}。` : ""}对照样段时看冠层覆盖和同叶位叶色。` : "", !!ndvi, [timeSeries.length ? `光学可用日期：${timeSeries.map((item) => item.date).join("、")}` : "", ...qualityNotes, ...(ndvi ? [`NDVI ${ndvi.fromDate} 至 ${ndvi.toDate} 变化 ${fixed(ndvi.delta)}${latestValues}`] : []), ...(ndviPath ? [`NDVI 时序：${ndviPath}`] : []), ...(turns ? [turns] : [])].filter(Boolean), deltas),
    module("persistent-low-vigor", "持续性偏弱区域", !isVegetationTask ? "" : !hasWeak ? `最新光学分区未划出可排序偏弱区。${threshold ? `田内 ${threshold.replace("分区门槛依据：", "")}。` : ""}${statsText ? `${statsText}。` : ""}${persistentArea !== null ? `跨期共同偏弱面积 ${persistentArea.toFixed(2)} 公顷。` : ""}全田按近平均归类；下一步到目测较稀或裸土较多处与邻近整齐处做对照样段。` : `${weakDescription}。本期田内相对偏弱，优先到图示区域与邻近整齐处对照检查冠层、叶色和土壤干湿。${persistentArea !== null ? `跨期共同偏弱面积 ${persistentArea.toFixed(2)} 公顷。` : ""}`, isVegetationTask && (hasWeak || belowCount !== null), [statsText, threshold, ...qualityNotes, plantingProvenance ? `播期来源：${plantingProvenance}` : "", ...(persistentArea !== null ? [`跨期共同偏弱面积：${persistentArea.toFixed(2)} 公顷`] : [])].filter(Boolean)),
    module("moisture-pattern", "土壤与植被水分状况", moisture.length ? `最近一期 ${moistureValues}。${moistureDiffers ? "与绿度变化方向不同；" : ""}对照样段时在两处相同深度记录土壤干湿。` : "", moisture.length > 0, [moisturePath ? `水分指数日期：${timeSeries.filter((item) => item.metrics.ndmi !== undefined || item.metrics.ndwi !== undefined).map((item) => item.date).join("、")}` : "", ...(moisture.length ? [`水分变化：${moisture.map((item) => `${item.metric} ${absolute(item.fromValue)}→${absolute(item.toValue)}（${fixed(item.delta)}）`).join("、")}`] : []), ...(moisturePath ? [`水分指数时序：${moisturePath}`] : [])].filter(Boolean), moisture),
    module("growth-stage-estimate", "作物生育期判断", stageText ? `${string(stage?.referenceDate) ?? date}，${stageText}。按播期推算，这块田在观测日处于${string(stage?.label)}；下一步看籽粒与植株状态。` : "", !!stageText, [stageText ? `参考日 ${string(stage?.referenceDate) ?? date}；${stageText}` : "", plantingProvenance ? `播期来源：${plantingProvenance}` : "", string(stage?.ruleVersion) ? `生育期规则：${string(stage?.ruleVersion)}` : "", number(stage?.daysAfterPlanting) !== null ? `播后天数：${number(stage?.daysAfterPlanting)}；可信度：${string(stage?.confidence) ?? "未标明"}` : ""].filter(Boolean)),
    module("water-disease-risk", "水分与病虫害风险", "", false, []),
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
    summary: hasWeak ? "先到地图标出的相对偏弱区巡查，再与邻近正常区对照" : isVegetationTask ? "在目测较稀处与邻近整齐处做首组成对样段核对" : objective === "waterlogging_detection" ? "核查地图上的雷达变化区与排水情况" : "核对低洼关注区和实际生育期",
    bullets: hasWeak ? ["核对偏弱区位置和冠层完整度", "与邻近正常区对照墒情、叶色和缺苗情况"] : isVegetationTask ? ["选择目测较稀或裸土较多处及邻近整齐处，拍照并标记位置", "两处各取10米长、连续2行的样段，记录株数、倒伏株数和裸土比例", "比较同叶位叶色，在相同深度记录土壤干湿并注明深度", "并列两段记录，判断株数、倒伏或裸土差异"] : objective === "waterlogging_detection" ? ["记录有无明水、受淹或排水不畅"] : ["核对播种日期和田内实际生育进度"],
  };
  return {
    aiReport: { generatedOn: date.slice(0, 10), summary: !isVegetationTask ? (brief?.overview ?? brief?.headline ?? "本次任务已有评估结果，需结合地图和现场核对。") : [
      `${date.slice(0, 10)}，${number(record(assessment.areaBasis)?.fieldAreaHa) !== null ? `约 ${number(record(assessment.areaBasis)?.fieldAreaHa)!.toFixed(2)} 公顷田块` : "该田块"}光学分区${hasWeak ? `划出 ${weakCount} 个相对偏弱区` : "未划出可排序偏弱区"}${number(assessment.belowAverageAreaHa) !== null ? `，偏弱区面积 ${number(assessment.belowAverageAreaHa)!.toFixed(2)} 公顷` : ""}。`,
      ndvi ? `${ndvi.fromDate} 至 ${ndvi.toDate}，全田 ${ndviValues}。${moistureValues ? `同期 ${moistureValues}。` : ""}` : "",
      stageText ? `${stageText}。` : "",
      `下一步${recommendedNextStep.summary}，看株数、倒伏、裸土、叶色和土壤干湿。`,
    ].filter(Boolean).join(" ") },
    modules,
    recommendedNextStep,
    ...(timeSeries.length ? { timeSeries } : {}),
    fieldStats,
  };
}
