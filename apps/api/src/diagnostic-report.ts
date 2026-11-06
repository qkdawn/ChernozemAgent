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
    ? `分区门槛依据：P90−P10=${robustRange.toFixed(3)}，门槛=${minimumRange.toFixed(3)}；含义：以田内 NDVI 第90与第10百分位差衡量分布跨度，未达门槛不代表均匀健康。`
    : "缺口：分区门槛依据说明（含 0.050 门槛与 P90−P10 含义）";
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
    weatherEvidence.push(`ERA5-Land 历史天气（${string(historical.start) ?? "起始日未知"} 至 ${string(historical.end) ?? "结束日未知"}）：${historicalValues.join("、") || "已形成历史天气记录"}；约 9 公里格点，仅作任务时段背景，不能解释田内差异，也不是预报`);
  }
  if (forecast && weatherUsable) {
    const forecastValues = [
      number(forecast.minTemperatureC) !== null ? `最低气温 ${number(forecast.minTemperatureC)!.toFixed(1)}℃` : null,
      number(forecast.cumulativeRainfallMm) !== null ? `累计降水 ${number(forecast.cumulativeRainfallMm)!.toFixed(1)} 毫米` : null,
      string(forecast.start) || string(forecast.end) ? `有效期 ${string(forecast.start) ?? "未知"} 至 ${string(forecast.end) ?? "未知"}` : null,
    ].filter((value): value is string => !!value);
    weatherEvidence.push(`ECMWF IFS 预报${forecast.runAt ? `（起报 ${forecast.runAt}）` : ""}：${forecastValues.join("、") || "已形成预报记录"}；预报与 ERA5-Land 历史观测分别解读，不混作历史事实`);
  }
  const terrainMetrics = record(terrain?.metrics);
  const terrainZones = Array.isArray(terrain?.zones) ? terrain.zones.map(record).filter((item): item is Data => !!item) : [];
  const soilMeasurements = Array.isArray(soil?.measurements) ? soil.measurements.map(record).filter((item): item is Data => !!item) : [];
  const radarObservations = Array.isArray(radar?.observations) ? radar.observations.map(record).filter((item): item is Data => !!item) : [];
  const environmentEvidence: string[] = [...weatherEvidence];
  if (terrain && terrainUsable) {
    environmentEvidence.push(`DEM 约 30 米地形背景：${number(terrainMetrics?.minElevationM) !== null && number(terrainMetrics?.maxElevationM) !== null ? `高程 ${number(terrainMetrics?.minElevationM)!.toFixed(1)} 至 ${number(terrainMetrics?.maxElevationM)!.toFixed(1)} 米` : "已形成地形结果"}，低洼关注分区 ${terrainZones.filter((zone) => zone.class === "low").length} 个；用于低洼巡查排序，不代表已积水，也不表达田埂、沟渠等微地形`);
  }
  if (soil && soil.available !== false && soilUsable) {
    const soilValues = soilMeasurements.slice(0, 6).map((item) => `${string(item.label) ?? string(item.property) ?? "土壤属性"} ${number(item.mean) !== null ? number(item.mean)!.toFixed(2) : "无有效统计"}${string(item.unit) ? ` ${string(item.unit)}` : ""}`);
    environmentEvidence.push(`SoilGrids 约 ${number(soil.resolutionMeters) ?? 250} 米土壤背景${soilValues.length ? `：${soilValues.join("、")}` : `（属性：${Array.isArray(soil.properties) ? soil.properties.join("、") : "未列明"}）`}；仅作地块背景，不替代土壤化验`);
  }
  if (radar && radarUsable) {
    const comparable = radar.comparable === true;
    const radarDates = radarObservations.map((item) => string(item.date)).filter((value): value is string => !!value);
    environmentEvidence.push(comparable
      ? `Sentinel-1 可比雷达变化（${string(radar.beforeDate) ?? "日期未知"} 至 ${string(radar.afterDate) ?? "日期未知"}）：可作为变化线索与光学、地形共同安排优先核查；不构成田间诊断`
      : `Sentinel-1 已有${radarDates.length ? ` ${radarDates.join("、")} 单期观测` : "雷达观测结果"}，但没有可比变化对${radarResult?.status === "partial" ? "（部分结果）" : ""}；不据此推断积水，后续需有可比时相才能判断变化`);
  }
  const sourceFailures = [
    weatherResult && (!weather || !weatherUsable) ? `天气分析${weatherResult.status === "failed" ? "失败" : "未形成可用结果（${weatherResult.status}）"}（${weatherResult.summary}）` : null,
    terrainResult && (!terrain || !terrainUsable) ? `DEM 分析${terrainResult.status === "failed" ? "失败" : `未形成可用结果（${terrainResult.status}）`}（${terrainResult.summary}）` : null,
    soilResult && (!soil || !soilUsable) ? `土壤背景分析${soilResult.status === "failed" ? "失败" : `未形成可用结果（${soilResult.status}）`}（${soilResult.summary}）` : null,
    radarResult && (!radar || !radarUsable) ? `雷达分析${radarResult.status === "failed" ? "失败" : `未形成可用结果（${radarResult.status}）`}（${radarResult.summary}）` : null,
  ].filter((value): value is string => !!value);
  const opticalQuality = record(current?.quality);
  const qualityNotes = opticalQuality
    ? [`影像质量与覆盖核验：有效覆盖 ${number(opticalQuality.validFraction) !== null ? `${(number(opticalQuality.validFraction)! * 100).toFixed(1)}%` : "未标明"}${number(opticalQuality.cloudAffectedFraction) !== null ? `，云影响 ${(number(opticalQuality.cloudAffectedFraction)! * 100).toFixed(1)}%` : ""}${Array.isArray(opticalQuality.flags) ? `；质量标记 ${opticalQuality.flags.join("、") || "无"}` : ""}`]
    : ["缺口：影像质量与覆盖核验记录"];
  if (opticalQuality) environmentEvidence.push(`Sentinel-2 光学质量：${qualityNotes[0]}；云污染或掩膜可能降低本期可用覆盖`);
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
  const moistureDiffers = !!ndvi && moisture.some((item) => Math.sign(item.delta) !== Math.sign(ndvi.delta));
  const indexDirection = ndvi && moisture.length ? `绿度与水分相关指数方向${moistureDiffers ? "不完全一致" : "一致"}` : ndvi ? "缺少可比的水分指数变化" : "缺少可比的多指数变化";
  const module = (id: string, title: string, body: string, ready: boolean, evidenceNotes: string[], metricDeltas?: DiagnosticModule["metricDeltas"]): DiagnosticModule => ({ id, title, status: ready ? "ready" : "insufficient_evidence", body, evidenceNotes, ...(metricDeltas?.length ? { metricDeltas } : {}) });
  const modules: DiagnosticModule[] = [
    module("current-conditions", "当前气象与环境条件", environmentEvidence.length
      ? `现象：${environmentEvidence.join("；")}。含义：这些时段天气、地形、土壤与雷达信息可作为解释观测变化和安排核查的背景证据；只有与光学日期及空间位置对应的证据才支持相应判断。局限：${sourceFailures.length ? `${sourceFailures.join("；")}；` : ""}现场巡田、土壤化验和农事操作记录仍缺失；上述背景数据不能单独确认田间成因或替代现场核查。`
      : `缺少可用的气象与环境分析结果：${sourceFailures.join("；") || "本任务没有相应来源结果"}。现场巡田、土壤化验和农事操作记录仍是缺口，需补充后再判断田间成因。`, environmentEvidence.length > 0,
      environmentEvidence.length ? [...environmentEvidence, ...sourceFailures.map((failure) => `分析状态：${failure}`)] : [...sourceFailures.map((failure) => `分析状态：${failure}`), "缺口：现场巡田记录、土壤化验和农事操作记录"]),
    module("satellite-greening-trend", "遥感长势变化趋势", ndvi ? `现象：${ndvi.fromDate} 至 ${ndvi.toDate}，全田均值${ndvi.delta > 0 ? "出现待核验的指数上升" : ndvi.delta < 0 ? "指数回落" : "指数持平"}。含义：这是地块尺度的指数变化，${indexDirection}${moistureDiffers ? "；方向不一致，更不能解读为长势已恢复" : "；不代表已确认长势回升"}，全田均值不能代替田内分布。` : "缺少直接证据：尚无可比的跨期 NDVI 观测，暂不能判断全田指数变化；需补充至少两个可用日期。", !!ndvi, [`光学可用日期：${timeSeries.map((item) => item.date).join("、") || "缺少观测明细"}`, ...qualityNotes, ...(ndvi ? [`NDVI ${ndvi.fromDate} 至 ${ndvi.toDate} 变化 ${fixed(ndvi.delta)}${latestValues}`] : []), ...(ndviPath ? [`NDVI 时序：${ndviPath}`] : []), ...(turns ? [turns] : [])], deltas),
    module("persistent-low-vigor", "持续性偏弱区域", !isVegetationTask ? "缺少直接证据：本任务没有田内长势分区对照。" : !hasWeak ? `现象：最新光学分区未检出可排序偏弱区，${zoningQuality?.variationVisible === false ? "田内差异未达到分区门槛" : "当前差异未形成可排序分区"}。含义：未检出不等于田内没有需要重点看的地方；差异未过门槛不等于均匀健康。这只是指数分区结果，不能当作田间无重点的结论。局限与下一步：${zoneChange?.status === "computed" && persistentArea === 0 ? "跨期共同偏弱面积为零，持续性未获证实；" : "持续性尚缺同位置跨期证据；"}证据不足下建议全田选取代表性样段核对，结果尚未回写到判断闭环。` : `现象：${weakDescription}。含义：该区域在本期田内相对偏弱，可作为优先巡查位置。局限与下一步：相对分区不能单独说明成因${persistentArea !== null ? "，跨期共同偏弱情况需结合相同位置复核" : "，持续性尚缺同位置跨期对照"}；建议到图示区域与邻近长势正常处对照检查冠层、墒情和缺苗情况。`, isVegetationTask && (hasWeak || belowCount !== null), [statsText || "缺口：分区统计", threshold, ...qualityNotes, `播期来源：${plantingProvenance ?? "缺口：播期来源未核验"}`, `观测日田块成熟/收获状态：${string(assessment.fieldMaturityStatus) ?? "缺口：观测日田块成熟/收获状态未核验"}`, ...(persistentArea !== null ? [`跨期共同偏弱面积：${persistentArea.toFixed(2)} 公顷`] : [])]),
    module("moisture-pattern", "土壤与植被水分状况", moisture.length || moisturePath ? `现象：${moisture.length ? `最近一期水分相关指数${moisture.some((item) => item.delta < 0) ? "回落" : moisture.some((item) => item.delta > 0) ? "回升" : "持平"}` : "缺少可比的跨期变化"}，与绿度方向${moisture.length && ndvi ? moistureDiffers ? "不同" : "一致" : "暂无法比较"}。含义：这反映冠层水分相关信号变化，不能单凭指数断定土壤缺水或积水。局限与下一步：缺少现场墒情证据，需结合土壤手感、田间明水和近期降雨交叉核验。` : "缺少直接证据：暂无可比水分指数观测；需补充可用影像并现场记录土壤墒情与明水。", moisture.length > 0, [moisturePath ? `水分指数日期：${timeSeries.filter((item) => item.metrics.ndmi !== undefined || item.metrics.ndwi !== undefined).map((item) => item.date).join("、")}` : "缺口：水分指数绝对值", ...(moisture.length ? [`水分变化：${moisture.map((item) => `${item.metric} ${absolute(item.fromValue)}→${absolute(item.toValue)}（${fixed(item.delta)}）`).join("、")}`] : []), ...(moisturePath ? [`水分指数时序：${moisturePath}`] : []), "缺口：现场墒情或积水记录"], moisture),
    module("growth-stage-estimate", "作物生育期判断", string(stage?.label) ? `${stageText}。该判断来自播期与参考日，不是影像直接识别；成熟期应结合籽粒与植株状态核对收获进度。` : "缺少直接证据：暂无可用生育期估计；请核对播种日期与当前籽粒、植株状态。", !!string(stage?.label), [string(stage?.label) ? `参考日 ${string(stage?.referenceDate) ?? date}；${stageText}` : "缺口：播种日期或生育期估计", `播期来源：${plantingProvenance ?? "缺口：播期来源未核验"}`, `生育期规则：${string(stage?.ruleVersion) ?? "缺口：规则版本未记录"}`, `播后天数：${number(stage?.daysAfterPlanting) ?? "缺口：播后天数未记录"}；可信度：${string(stage?.confidence) ?? "缺口：可信度未记录"}`, `观测日田块成熟/收获状态：${string(assessment.fieldMaturityStatus) ?? "缺口：观测日田块成熟/收获状态未核验"}`]),
    module("water-disease-risk", "水分与病虫害风险", "缺少直接证据：本任务没有病虫害、倒伏、缺苗或田间积水的现场记录，也缺少可直接验证这些风险的观测；不能据此判定发生位置或程度。巡田时记录叶片病斑、虫口、倒伏、缺苗与明水，并与图上区域对应。", false, ["缺口：病虫害、倒伏、缺苗与明水的定位现场记录", "建议：逐点拍照并记录发生日期"]),
  ];
  const action = brief?.actions[0];
  const defaultActionCaveat = isVegetationTask && !hasWeak
    ? "此为证据不足下的默认核对动作；核对本身不等于田间决策。"
    : null;
  const firstCheck = brief?.document?.sections.find((section) => section.id === "first-check");
  const recommendedNextStep = action ? {
    summary: defaultActionCaveat ? `证据不足下的默认动作：${action.label}` : action.label,
    bullets: [...[action.timing, action.where].filter((part): part is string => !!part).map((part) => part), ...action.checklist, ...(defaultActionCaveat ? [defaultActionCaveat] : [])],
  } : firstCheck ? {
    summary: firstCheck.title,
    bullets: [...firstCheck.paragraphs, ...(firstCheck.items ?? []).map((item) => `${item.label}：${item.text}`), ...(defaultActionCaveat ? [defaultActionCaveat] : [])],
  } : {
    summary: hasWeak ? "先到地图标出的相对偏弱区巡查，再与邻近正常区对照" : isVegetationTask ? "证据不足下的默认动作：全田选取两个代表性样段核对" : objective === "waterlogging_detection" ? "核查地图上的雷达变化区与排水情况" : "核对低洼关注区和实际生育期",
    bullets: hasWeak ? ["核对偏弱区位置和冠层完整度", "与邻近正常区对照墒情、叶色和缺苗情况"] : isVegetationTask ? ["在田内选取两个代表性样段", "对照冠层、墒情和叶色，记录现场差异", "核对本身不等于田间决策"] : objective === "waterlogging_detection" ? ["记录有无明水、受淹或排水不畅"] : ["核对播种日期和田内实际生育进度"],
  };
  return {
    aiReport: { generatedOn: date.slice(0, 10), summary: !isVegetationTask ? (brief?.overview ?? brief?.headline ?? "本次任务已有评估结果，需结合地图和现场核对。") : [
      `${date.slice(0, 10)} 的可用观测显示${hasWeak ? "存在田内相对偏弱区" : "未检出可排序偏弱区"}。这是指数读数，不是田间诊断；未检出不等于田内没有重点，也不能据此认定无需进一步核对。`,
      ndvi ? `最近一期全田均值出现${ndvi.delta > 0 ? "待核验的指数上升" : ndvi.delta < 0 ? "指数下降" : "指数持平"}；${indexDirection}${moistureDiffers ? "，方向不一致，更不能解读为长势已恢复" : ""}。` : "缺少可比的跨期 NDVI 观测，暂不能判断全田指数变化。",
      `多指数变化不能单独证明水分或养分成因。${stageText}；结合现场冠层、墒情和实际生育进度核对，样段结果尚未回写到判断闭环。`,
    ].join(" ") },
    modules,
    recommendedNextStep,
    ...(timeSeries.length ? { timeSeries } : {}),
    fieldStats,
  };
}
