import { WATER_NITROGEN_METHOD_VERSION } from "@chernozem/contracts";
import type { AcquisitionDateMatch, AgentRunTrace, AnalysisArtifact, AnalysisBrief, AnalysisFinding, AnalysisObjective, AnalysisResult, AnalysisTask, ConversationScoutingNoteDraft, ConversationWorkflowPlan, CreateDataAcquisitionRequest, DataAcquisitionRun, DataSource, FieldConversationMessage, FieldHistory, FieldInput, FieldInspectionRecord, FieldScoutingNote, FieldSummary, NitrogenManagementLevel, Position, SaveFieldInspectionRequest, SaveFieldScoutingNoteRequest, SourceAcquisitionResult, TaskConversationMessage, VariableNitrogenPrescription, VariableNitrogenSourceOption, VariableNitrogenZone } from "@chernozem/contracts";
import { ArrowClockwiseIcon as ArrowClockwise } from "@phosphor-icons/react/dist/icons/ArrowClockwise";
import { ArchiveIcon as Archive } from "@phosphor-icons/react/dist/icons/Archive";
import { CaretLeftIcon as CaretLeft } from "@phosphor-icons/react/dist/icons/CaretLeft";
import { CaretRightIcon as CaretRight } from "@phosphor-icons/react/dist/icons/CaretRight";
import { ChartLineUpIcon as ChartLineUp } from "@phosphor-icons/react/dist/icons/ChartLineUp";
import { CheckCircleIcon as CheckCircle } from "@phosphor-icons/react/dist/icons/CheckCircle";
import { CloudRainIcon as CloudRain } from "@phosphor-icons/react/dist/icons/CloudRain";
import { CrosshairIcon as Crosshair } from "@phosphor-icons/react/dist/icons/Crosshair";
import { DatabaseIcon as Database } from "@phosphor-icons/react/dist/icons/Database";
import { DropIcon as Drop } from "@phosphor-icons/react/dist/icons/Drop";
import { FarmIcon as Farm } from "@phosphor-icons/react/dist/icons/Farm";
import { GrainsIcon as Grains } from "@phosphor-icons/react/dist/icons/Grains";
import { LeafIcon as Leaf } from "@phosphor-icons/react/dist/icons/Leaf";
import { ListChecksIcon as ListChecks } from "@phosphor-icons/react/dist/icons/ListChecks";
import { MagnifyingGlassIcon as MagnifyingGlass } from "@phosphor-icons/react/dist/icons/MagnifyingGlass";
import { MapPinIcon as MapPin } from "@phosphor-icons/react/dist/icons/MapPin";
import { PlusIcon as Plus } from "@phosphor-icons/react/dist/icons/Plus";
import { PaperPlaneRightIcon as PaperPlaneRight } from "@phosphor-icons/react/dist/icons/PaperPlaneRight";
import { PencilSimpleIcon as PencilSimple } from "@phosphor-icons/react/dist/icons/PencilSimple";
import { SparkleIcon as Sparkle } from "@phosphor-icons/react/dist/icons/Sparkle";
import { StackIcon as Stack } from "@phosphor-icons/react/dist/icons/Stack";
import { ThermometerColdIcon as ThermometerCold } from "@phosphor-icons/react/dist/icons/ThermometerCold";
import { WarningCircleIcon as WarningCircle } from "@phosphor-icons/react/dist/icons/WarningCircle";
import { XIcon as X } from "@phosphor-icons/react/dist/icons/X";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { agentToolLabel, agentToolStatusLabel } from "./agent-run-presentation.js";
import { archiveField, createDataAcquisition, createField, createNitrogenPrescription, createTask, fetchAcquisition, fetchAcquisitionHistory, fetchAgentRun, fetchDataMatches, fetchFieldConversation, fetchFieldHistory, fetchFieldVisualizations, fetchFields, fetchLatestAcquisition, fetchNitrogenPrescriptionContext, fetchNitrogenPrescriptions, fetchScoutingNotes, fetchTask, fetchTaskAnalysis, fetchTaskConversation, fetchTasks, importFields, nitrogenPrescriptionExportUrl, planAgentAnalysis, saveFieldInspection, saveScoutingNote, sendFieldConversationMessage, sendTaskConversationMessage, updateField } from "./api.js";
import { acquisitionProgressSummary, acquisitionReadyForRequest, acquisitionRequestForField } from "./data-acquisition-presentation.js";
import { analysisBriefVisibleSections } from "./analysis-brief-presentation.js";
import { fieldReportPresentation } from "./field-report-presentation.js";
import { mapFindingsForLayer } from "./map-findings.js";
import { MapCanvas, type MapVisualizationLayer } from "./MapCanvas.js";
import { getWaterNitrogenObservation, waterNitrogenObservationStatus, type WaterNitrogenObservationViewModel } from "./water-nitrogen-presentation.js";
import { workflowActionButtonLabel, workflowPrimaryAction } from "./workflow-action-presentation.js";

const objectives: Array<{ value: AnalysisObjective; label: string }> = [
  { value: "growth_stage_monitoring", label: "关键生育期长势监测" },
  { value: "water_nitrogen_diagnosis", label: "水氮排查" },
  { value: "waterlogging_detection", label: "农田积水灾害识别" },
  { value: "frost_risk_warning", label: "霜冻风险提前预警" },
];

const workflowCopy: Record<AnalysisObjective, { title: string; purpose: string; prompt: string }> = {
  growth_stage_monitoring: {
    title: "长势巡检",
    purpose: "找出田内偏弱区",
    prompt: "运行关键生育期长势监测工作流",
  },
  water_nitrogen_diagnosis: {
    title: "水氮排查",
    purpose: "定位差异并排查原因",
    prompt: "运行水氮排查工作流",
  },
  waterlogging_detection: {
    title: "积水识别",
    purpose: "核查一次降雨后的疑似积水区",
    prompt: "运行农田积水灾害识别工作流",
  },
  frost_risk_warning: {
    title: "霜冻预警",
    purpose: "查看未来低温风险区",
    prompt: "运行霜冻风险提前预警工作流",
  },
};

const featureCardCopy: Record<AnalysisObjective, { title: string; summary: string }> = {
  growth_stage_monitoring: { title: "长势巡检", summary: "定位田内偏弱区" },
  water_nitrogen_diagnosis: { title: "水氮管理", summary: "原因排查 · 施氮方案" },
  waterlogging_detection: { title: "积水识别", summary: "定位疑似积水区" },
  frost_risk_warning: { title: "霜冻预警", summary: "查看未来低温风险" },
};


const fieldDataSources = [
  { source: "sentinel-2", code: "S2", type: "光学影像", provider: "Sentinel-2" },
  { source: "sentinel-1", code: "S1", type: "雷达影像", provider: "Sentinel-1" },
  { source: "copernicus-dem", code: "DEM", type: "地形高程", provider: "Copernicus DEM" },
  { source: "era5-land", code: "HIS", type: "历史天气", provider: "ERA5-Land" },
  { source: "ecmwf-ifs", code: "FCST", type: "天气预报", provider: "ECMWF IFS" },
  { source: "soilgrids-250m", code: "SOIL", type: "土壤背景", provider: "SoilGrids 250m" },
] as const;

type ChartArtifact = AnalysisArtifact & { chart: NonNullable<AnalysisArtifact["chart"]>; sourceDates?: string[]; taskId?: string };
type AnalysisPeriod = "last_30_days" | "this_season" | "selected_date";
type FieldDetailView = "status" | "overview" | "data" | "scouting";
type LeftPanelMode = "fields" | "analysis" | "features" | "workflow" | "prescription" | "records";
type TaskSurface = "agent" | "workflow";
type TaskRecordFilter = "all" | AnalysisObjective;
type AgentStartIntent = { message: string; objective?: AnalysisObjective; period?: AnalysisPeriod };

export default function App() {
  const [fields, setFields] = useState<FieldSummary[]>([]);
  const [selectedFieldId, setSelectedFieldId] = useState<string | null>(null);
  const [fieldHistory, setFieldHistory] = useState<FieldHistory | null>(null);
  const [scoutingNotes, setScoutingNotes] = useState<FieldScoutingNote[]>([]);
  const [objective, setObjective] = useState<AnalysisObjective>("growth_stage_monitoring");
  const [period, setPeriod] = useState<AnalysisPeriod>("last_30_days");
  const [analysisDate, setAnalysisDate] = useState<string | null>(null);
  const [selectedScoutingNoteIds, setSelectedScoutingNoteIds] = useState<string[]>([]);
  const [task, setTask] = useState<AnalysisTask | null>(null);
  const [taskSurface, setTaskSurface] = useState<TaskSurface>("agent");
  const [agentRun, setAgentRun] = useState<AgentRunTrace | null>(null);
  const [taskRecords, setTaskRecords] = useState<AnalysisTask[]>([]);
  const [taskRecordsLoading, setTaskRecordsLoading] = useState(false);
  const [taskRecordsError, setTaskRecordsError] = useState<string | null>(null);
  const [taskRecordFilter, setTaskRecordFilter] = useState<TaskRecordFilter>("all");
  const [analysisResults, setAnalysisResults] = useState<AnalysisResult<unknown>[]>([]);
  const [savedVisualizationLayers, setSavedVisualizationLayers] = useState<MapVisualizationLayer[]>([]);
  const [savedChartArtifacts, setSavedChartArtifacts] = useState<ChartArtifact[]>([]);
  const [mapLayersLoading, setMapLayersLoading] = useState(false);
  const [mapLayersError, setMapLayersError] = useState<string | null>(null);
  const [selectedVisualizationKey, setSelectedVisualizationKey] = useState<string | null>(null);
  const [loadingFields, setLoadingFields] = useState(true);
  const [fieldListError, setFieldListError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [locateSignal, setLocateSignal] = useState(0);
  const [focusFieldSignal, setFocusFieldSignal] = useState(0);
  const [layerMenuOpen, setLayerMenuOpen] = useState(false);
  const [spatialOverlays, setSpatialOverlays] = useState({ fieldBoundary: true, taskFindings: true, scoutingNotes: true, nitrogenZones: true });
  const [focusedFindingId, setFocusedFindingId] = useState<string | null>(null);
  const [focusedScoutingNoteId, setFocusedScoutingNoteId] = useState<string | null>(null);
  const [inspectionPicking, setInspectionPicking] = useState(false);
  const [inspectionLocation, setInspectionLocation] = useState<Position | null>(null);
  const [fieldScoutingPicking, setFieldScoutingPicking] = useState(false);
  const [fieldScoutingDraftLocation, setFieldScoutingDraftLocation] = useState<Position | null>(null);
  const [conversationScoutingDraft, setConversationScoutingDraft] = useState<ConversationScoutingNoteDraft | null>(null);
  const [fieldPanelOpen, setFieldPanelOpen] = useState(true);
  const [detailPanelOpen, setDetailPanelOpen] = useState(false);
  const [detailView, setDetailView] = useState<FieldDetailView>("status");
  const [leftPanelMode, setLeftPanelMode] = useState<LeftPanelMode>("fields");
  const [fieldEditorOpen, setFieldEditorOpen] = useState(false);
  const [editingField, setEditingField] = useState<FieldSummary | null>(null);
  const [draftBoundary, setDraftBoundary] = useState<FieldSummary["boundary"] | null>(null);
  const [acquisition, setAcquisition] = useState<DataAcquisitionRun | null>(null);
  const [acquisitionHistory, setAcquisitionHistory] = useState<DataAcquisitionRun[]>([]);
  const [selectedDataSource, setSelectedDataSource] = useState<DataSource | null>(null);
  const [acquisitionHistoryLoading, setAcquisitionHistoryLoading] = useState(false);
  const [dataTargetDate, setDataTargetDate] = useState(todayCalendarDate());
  const [dataMatches, setDataMatches] = useState<AcquisitionDateMatch[]>([]);
  const [dataMatchesLoading, setDataMatchesLoading] = useState(false);
  const [acquisitionLoading, setAcquisitionLoading] = useState(false);
  const [dataAcquisitionRequest, setDataAcquisitionRequest] = useState<CreateDataAcquisitionRequest | null>(null);
  const [nitrogenSourceOptions, setNitrogenSourceOptions] = useState<VariableNitrogenSourceOption[]>([]);
  const [nitrogenPrescriptions, setNitrogenPrescriptions] = useState<VariableNitrogenPrescription[]>([]);
  const [nitrogenZones, setNitrogenZones] = useState<VariableNitrogenZone[]>([]);
  const [nitrogenLoading, setNitrogenLoading] = useState(false);
  const acquisitionRequestRef = useRef(0);
  const importInputRef = useRef<HTMLInputElement>(null);
  const selectedField = fields.find((field) => field.id === selectedFieldId) ?? null;
  useEffect(() => {
    if (leftPanelMode === "analysis" || leftPanelMode === "features" || leftPanelMode === "workflow" || leftPanelMode === "prescription") setDetailPanelOpen(false);
  }, [leftPanelMode]);
  const currentVisualizationLayers = useMemo<MapVisualizationLayer[]>(() => uniqueVisualizationLayers(
    analysisResults.flatMap((result) => result.artifacts.flatMap((artifact: AnalysisArtifact) => artifact.visualization ? [{ ref: artifact.ref, taskId: result.taskId, ...artifact.visualization }] : [])),
  ), [analysisResults]);
  const currentChartArtifacts = useMemo(() => uniqueChartArtifacts(
    analysisResults.flatMap((result) => result.artifacts.filter((artifact): artifact is ChartArtifact => Boolean(artifact.chart)).map((artifact) => ({
      ...artifact,
      taskId: result.taskId,
      sourceDates: result.sources.filter((source) => source.source === artifact.chart.source && source.date).map((source) => source.date!),
    }))),
  ), [analysisResults]);
  const visualizationLayers = useMemo<MapVisualizationLayer[]>(() => uniqueVisualizationLayers([
    ...currentVisualizationLayers,
    ...savedVisualizationLayers,
  ]), [currentVisualizationLayers, savedVisualizationLayers]);
  const chartArtifacts = useMemo(() => uniqueChartArtifacts([
    ...currentChartArtifacts,
    ...savedChartArtifacts,
  ]), [currentChartArtifacts, savedChartArtifacts]);
  const selectedVisualization = useMemo(() => {
    if (selectedVisualizationKey === "basemap") return null;
    const objectiveMetric = task?.objective === "waterlogging_detection"
      ? "radar_change"
      : task?.objective === "frost_risk_warning"
        ? "lowland"
        : "ndvi_contrast";
    const assessmentResult = [...analysisResults].reverse().find((result) => result.kind === "assessment")?.result as { referenceDate?: string; latestObservationDate?: string; afterDate?: string } | null | undefined;
    const radarResult = analysisResults.find((result) => result.kind === "radar_change")?.result as { afterDate?: string } | null | undefined;
    const preferredDate = task?.objective === "waterlogging_detection"
      ? assessmentResult?.afterDate ?? radarResult?.afterDate
      : task?.objective === "water_nitrogen_diagnosis"
        ? assessmentResult?.referenceDate
        : task?.objective === "growth_stage_monitoring"
          ? assessmentResult?.latestObservationDate
          : null;
    const hasRadarChangeResult = Boolean(assessmentResult?.afterDate ?? radarResult?.afterDate);
    const fallbackMetric = task?.objective === "waterlogging_detection" && !hasRadarChangeResult ? "vv" : objectiveMetric;
    const taskLayers = visualizationLayers.filter((layer) => layer.taskId === task?.id && layer.metric === fallbackMetric);
    const datedTaskLayer = preferredDate ? taskLayers.find((layer) => layer.date === preferredDate) : null;
    const targetDate = preferredDate ?? analysisDate ?? task?.timeRange.end.slice(0, 10) ?? null;
    const datedGlobalLayer = targetDate
      ? visualizationLayers
        .filter((layer) => layer.metric === fallbackMetric && layer.date !== "static")
        .sort((left, right) => Math.abs(dateOffsetDays(left.date, targetDate)) - Math.abs(dateOffsetDays(right.date, targetDate)))[0] ?? null
      : null;
    const datedTaskTargetLayer = targetDate
      ? taskLayers
        .filter((layer) => layer.date !== "static")
        .sort((left, right) => Math.abs(dateOffsetDays(left.date, targetDate)) - Math.abs(dateOffsetDays(right.date, targetDate)))[0] ?? null
      : null;
    const taskCanDriveMap = !task || !isLegacyWaterNitrogenTask(task);
    const latestFieldLayer = !task
      ? visualizationLayers
        .filter((layer) => layer.metric === fallbackMetric && layer.date !== "static")
        .sort((left, right) => right.date.localeCompare(left.date))[0] ?? null
      : null;
    const fallback = datedTaskLayer
      ?? datedTaskTargetLayer
      ?? datedGlobalLayer
      ?? latestFieldLayer
      ?? taskLayers[0]
      ?? visualizationLayers.find((layer) => layer.taskId === task?.id && layer.metric === fallbackMetric)
      ?? visualizationLayers.find((layer) => layer.metric === fallbackMetric)
      ?? visualizationLayers.find((layer) => layer.metric === "ndvi")
      ?? visualizationLayers[0]
      ?? null;
    const selectedLayer = visualizationLayers.find((layer) => layer.ref === selectedVisualizationKey) ?? null;
    if (!taskCanDriveMap) return selectedLayer?.taskId ? null : selectedLayer;
    return selectedLayer ?? fallback;
  }, [analysisDate, analysisResults, selectedVisualizationKey, task?.id, task?.objective, visualizationLayers]);
  const visibleMapFindings = useMemo(() => mapFindingsForLayer(task, selectedVisualization), [selectedVisualization, task]);

  useEffect(() => {
    if (task?.id) setSelectedVisualizationKey(null);
  }, [task?.id]);

  const loadFields = async () => {
    setLoadingFields(true);
    setFieldListError(null);
    try {
      const items = await fetchFields();
      setFields(items);
      setSelectedFieldId(null);
    } catch (reason) {
      setFieldListError(reason instanceof Error ? reason.message : "农田列表加载失败。");
    } finally {
      setLoadingFields(false);
    }
  };

  useEffect(() => { void loadFields(); }, []);

  useEffect(() => {
    if (!selectedFieldId) {
      setFieldHistory(null);
      setScoutingNotes([]);
      setSavedVisualizationLayers([]);
      setSavedChartArtifacts([]);
      setMapLayersLoading(false);
      setMapLayersError(null);
      return;
    }
    fetchFieldHistory(selectedFieldId).then(setFieldHistory).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "地块历史加载失败。"));
    fetchScoutingNotes(selectedFieldId).then(setScoutingNotes).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "巡田记录加载失败。"));
    let cancelled = false;
    setSavedVisualizationLayers([]);
    setSavedChartArtifacts([]);
    setMapLayersLoading(true);
    setMapLayersError(null);
    void fetchFieldVisualizations(selectedFieldId).then((catalog) => {
      if (!cancelled) {
        setSavedVisualizationLayers(catalog.layers.map((layer) => ({ ref: layer.ref, ...layer.visualization })));
        setSavedChartArtifacts(catalog.charts.map((artifact) => ({ ref: artifact.ref, kind: "chart", chart: artifact.chart, sourceDates: artifact.sourceDates })));
      }
    }).catch((reason: unknown) => {
      if (!cancelled) {
        setSavedVisualizationLayers([]);
        setSavedChartArtifacts([]);
        setMapLayersError(reason instanceof Error ? reason.message : "地块可视化加载失败。");
      }
    }).finally(() => {
      if (!cancelled) setMapLayersLoading(false);
    });
    return () => { cancelled = true; };
  }, [selectedFieldId]);

  useEffect(() => {
    if (!selectedFieldId || leftPanelMode !== "prescription") {
      setNitrogenSourceOptions([]);
      setNitrogenPrescriptions([]);
      setNitrogenZones([]);
      return;
    }
    let cancelled = false;
    setNitrogenLoading(true);
    setNitrogenSourceOptions([]);
    setNitrogenPrescriptions([]);
    void Promise.all([fetchNitrogenPrescriptionContext(selectedFieldId), fetchNitrogenPrescriptions(selectedFieldId)]).then(([context, prescriptions]) => {
      if (cancelled) return;
      setNitrogenSourceOptions(context.options);
      setNitrogenPrescriptions(prescriptions);
      setNitrogenZones(context.latestPrescription?.zones ?? []);
    }).catch((reason: unknown) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : "施氮分区加载失败。");
    }).finally(() => {
      if (!cancelled) setNitrogenLoading(false);
    });
    return () => { cancelled = true; };
  }, [leftPanelMode, selectedFieldId]);

  useEffect(() => {
    if (!task || task.status !== "running") return;
    const timer = window.setInterval(() => {
      fetchTask(task.id).then(setTask).catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : "分析进度加载失败。");
        window.clearInterval(timer);
      });
    }, 650);
    return () => window.clearInterval(timer);
  }, [task?.id, task?.status]);

  useEffect(() => {
    if (!task) {
      setAgentRun(null);
      return;
    }
    let cancelled = false;
    const load = () => {
      void fetchAgentRun(task.id).then((run) => {
        if (!cancelled) setAgentRun(run);
      }).catch(() => {
        if (!cancelled) setAgentRun(null);
      });
    };
    load();
    if (task.status !== "running") return () => { cancelled = true; };
    const timer = window.setInterval(load, 650);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [task?.id, task?.status]);

  useEffect(() => {
    if (!task?.completedAt) return;
    void fetchFields().then(setFields).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "地块状态更新失败。"));
  }, [task?.completedAt]);

  useEffect(() => {
    if (!task || task.status === "running") {
      setAnalysisResults([]);
      return;
    }
    let cancelled = false;
    void fetchTaskAnalysis(task.id).then((results) => {
      if (!cancelled) setAnalysisResults(results);
    }).catch(() => {
      if (!cancelled) setAnalysisResults([]);
    });
    return () => { cancelled = true; };
  }, [task?.id, task?.status]);

  const loadFieldData = useCallback(async (field: FieldSummary, force = false, plannedRequest?: CreateDataAcquisitionRequest) => {
    const requestId = acquisitionRequestRef.current + 1;
    acquisitionRequestRef.current = requestId;
    setAcquisitionLoading(true);
    let keepLoading = false;
    try {
      if (!force) {
        const latest = await fetchLatestAcquisition(field.id);
        if (acquisitionRequestRef.current !== requestId) return;
        if (latest) {
          setAcquisition(latest);
          keepLoading = latest.status === "running";
          setAcquisitionLoading(keepLoading);
          return;
        }
      }
      const request = acquisitionRequestForField(field, plannedRequest ?? null);
      const run = await createDataAcquisition(request);
      if (acquisitionRequestRef.current === requestId) {
        keepLoading = run.status === "running";
        setAcquisition(run);
      }
    } catch (reason) {
      if (acquisitionRequestRef.current === requestId) setError(reason instanceof Error ? reason.message : "地块数据采集失败。");
    } finally {
      if (acquisitionRequestRef.current === requestId && !keepLoading) setAcquisitionLoading(false);
    }
  }, []);

  const openFieldData = useCallback(() => {
    setDataAcquisitionRequest(null);
    setDetailView("data");
    setSelectedDataSource(null);
    setDetailPanelOpen(true);
  }, []);

  const openTaskData = useCallback(() => {
    const request = task?.nextActions.find((action) => action.acquisitionRequest)?.acquisitionRequest ?? null;
    setDataAcquisitionRequest(request);
    setDetailView("data");
    setSelectedDataSource(null);
    setDetailPanelOpen(true);
    if (request && selectedField) void loadFieldData(selectedField, true, request);
  }, [loadFieldData, selectedField, task]);

  useEffect(() => {
    if (!selectedField) {
      acquisitionRequestRef.current += 1;
      setAcquisition(null);
      setAcquisitionLoading(false);
      setAcquisitionHistory([]);
      setSelectedDataSource(null);
      return;
    }
    void loadFieldData(selectedField);
  }, [selectedField?.id, selectedField?.boundaryVersion, loadFieldData]);

  const openDataSource = useCallback(async (source: DataSource) => {
    if (!selectedField) return;
    setSelectedDataSource(source);
    setAcquisitionHistoryLoading(true);
    try {
      setAcquisitionHistory(await fetchAcquisitionHistory(selectedField.id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "历史采集记录加载失败。");
    } finally {
      setAcquisitionHistoryLoading(false);
    }
  }, [selectedField]);

  useEffect(() => {
    if (!selectedField || detailView !== "data") return;
    let cancelled = false;
    setDataMatchesLoading(true);
    void fetchDataMatches(selectedField.id, dataTargetDate).then((matches) => {
      if (!cancelled) setDataMatches(matches);
    }).catch((reason: unknown) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : "日期匹配结果加载失败。");
    }).finally(() => {
      if (!cancelled) setDataMatchesLoading(false);
    });
    return () => { cancelled = true; };
  }, [selectedField?.id, detailView, dataTargetDate, acquisition?.id, acquisition?.status]);

  useEffect(() => {
    if (!acquisition || acquisition.status !== "running") return;
    const requestId = acquisitionRequestRef.current;
    const timer = window.setInterval(() => {
      void fetchAcquisition(acquisition.id).then((run) => {
        if (acquisitionRequestRef.current !== requestId) return;
        setAcquisition(run);
        if (run.status !== "running") setAcquisitionLoading(false);
      }).catch((reason: unknown) => {
        if (acquisitionRequestRef.current !== requestId) return;
        setError(reason instanceof Error ? reason.message : "数据采集进度加载失败。");
        setAcquisitionLoading(false);
      });
    }, 1500);
    return () => window.clearInterval(timer);
  }, [acquisition?.id, acquisition?.status]);

  const filteredFields = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return keyword ? fields.filter((field) => `${field.name}${field.code}${field.village}`.toLowerCase().includes(keyword)) : fields;
  }, [fields, query]);

  const selectField = useCallback((fieldId: string) => {
    setLayerMenuOpen(false);
    if (fieldId === selectedFieldId) {
      setSelectedFieldId(null);
      setTask(null);
      setSelectedScoutingNoteIds([]);
      setAnalysisResults([]);
      setSelectedVisualizationKey(null);
      setFocusedFindingId(null);
      setFocusedScoutingNoteId(null);
      setConversationScoutingDraft(null);
      setFieldScoutingDraftLocation(null);
      setDetailView("status");
      setDetailPanelOpen(false);
      return;
    }
    setSelectedFieldId(fieldId);
    if (window.innerWidth < 1280) setFieldPanelOpen(false);
    setTask(null);
    setAnalysisResults([]);
    setAnalysisDate(null);
    setSelectedScoutingNoteIds([]);
    setPeriod("last_30_days");
    setSelectedVisualizationKey(null);
    setFocusedFindingId(null);
    setFocusedScoutingNoteId(null);
    setConversationScoutingDraft(null);
    setFieldScoutingDraftLocation(null);
    setDetailView("status");
    setError(null);
    if (leftPanelMode === "analysis" || leftPanelMode === "features" || leftPanelMode === "workflow" || leftPanelMode === "prescription") {
      setFieldPanelOpen(true);
      setDetailPanelOpen(false);
    } else {
      setDetailPanelOpen(true);
    }
  }, [leftPanelMode, selectedFieldId]);

  const startAnalysis = async (intent: AgentStartIntent, surface: TaskSurface): Promise<boolean> => {
    if (!selectedField) return false;
    setError(null);
    setFocusedFindingId(null);
    setDetailPanelOpen(false);
    try {
      const planned = intent.objective
        ? { objective: intent.objective, period: intent.period ?? period }
        : await planAgentAnalysis({
          fieldId: selectedField.id,
          message: intent.message,
          periodHint: (intent.period ?? period) === "this_season" ? "this_season" : "last_30_days",
        });
      const plannedObjective = planned.objective;
      const plannedPeriod = planned.period;
      setObjective(plannedObjective);
      setPeriod(plannedPeriod);
      const scoutingSelection = plannedObjective === "water_nitrogen_diagnosis" && selectedScoutingNoteIds.length ? { scoutingNoteIds: selectedScoutingNoteIds } : {};
      const request = plannedObjective === "frost_risk_warning"
        ? { fieldId: selectedField.id, crop: selectedField.crop, period: "last_30_days" as const, objective: plannedObjective, message: intent.message, ...scoutingSelection }
        : plannedPeriod === "selected_date" && analysisDate
        ? { fieldId: selectedField.id, crop: selectedField.crop, period: "custom" as const, timeRange: { start: analysisDate, end: analysisDate }, objective: plannedObjective, message: intent.message, ...scoutingSelection }
        : { fieldId: selectedField.id, crop: selectedField.crop, period: plannedPeriod === "selected_date" ? "last_30_days" as const : plannedPeriod, objective: plannedObjective, message: intent.message, ...scoutingSelection };
      const createdTask = await createTask(request);
      setTaskSurface(surface);
      setTask(createdTask);
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "分析任务创建失败。");
      return false;
    }
  };

  const startConversationWorkflow = async (plan: ConversationWorkflowPlan): Promise<boolean> => {
    if (!selectedField || plan.startRequest.fieldId !== selectedField.id) return false;
    setError(null);
    setFocusedFindingId(null);
    setDetailPanelOpen(false);
    try {
      const createdTask = await createTask(plan.startRequest);
      setObjective(plan.objective);
      setPeriod(plan.period);
      setTaskSurface("workflow");
      setTask(createdTask);
      setLeftPanelMode("workflow");
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "分析任务创建失败。");
      return false;
    }
  };

  const followUpAnalysis = async (currentTask: AnalysisTask, scoutingNoteIds: string[] = [], inspectionTaskId?: string) => {
    if (!selectedField) return;
    setError(null);
    setFocusedFindingId(null);
    setDetailPanelOpen(false);
    try {
      const request = currentTask.objective === "frost_risk_warning"
        ? { fieldId: selectedField.id, crop: selectedField.crop, period: "last_30_days" as const, objective: currentTask.objective }
        : { fieldId: selectedField.id, crop: selectedField.crop, period: "custom" as const, timeRange: currentTask.timeRange, objective: currentTask.objective, scoutingNoteIds, ...(inspectionTaskId ? { inspectionTaskId } : {}) };
      setTask(await createTask(request));
      setAnalysisResults([]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "复核任务创建失败。");
    }
  };

  const openFieldEditor = (field: FieldSummary | null = null) => { setEditingField(field); setDraftBoundary(field?.boundary ?? null); setDetailView("overview"); setFieldEditorOpen(true); setDetailPanelOpen(true); setError(null); };
  const loadTaskRecords = async (filter: TaskRecordFilter) => {
    setTaskRecordFilter(filter);
    setTaskRecordsLoading(true);
    setTaskRecordsError(null);
    try {
      setTaskRecords(await fetchTasks(filter === "all" ? undefined : filter));
    } catch (reason) {
      setTaskRecordsError(reason instanceof Error ? reason.message : "分析记录加载失败。");
    } finally {
      setTaskRecordsLoading(false);
    }
  };
  const openTaskRecords = async () => {
    setLeftPanelMode("records");
    setFieldPanelOpen(true);
    setDetailPanelOpen(false);
    await loadTaskRecords(taskRecordFilter);
  };
  const openTaskRecord = (record: AnalysisTask) => {
    setSelectedFieldId(record.fieldId);
    setTask(record);
    setObjective(record.objective);
    setAnalysisDate(record.timeRange.end.slice(0, 10));
    setSelectedScoutingNoteIds([]);
    setAnalysisResults([]);
    setFocusedFindingId(null);
    setSelectedVisualizationKey(null);
    setTaskSurface("workflow");
    setLeftPanelMode("workflow");
    setFieldPanelOpen(true);
    setDetailPanelOpen(false);
  };
  const analyzeObservationDate = (date: string, requestedObjective?: AnalysisObjective) => {
    setAnalysisDate(date);
    setPeriod("selected_date");
    if (requestedObjective) setObjective(requestedObjective);
    setSelectedScoutingNoteIds([]);
    setTask(null);
    setAnalysisResults([]);
    setFocusedFindingId(null);
    setTaskSurface("workflow");
    setLeftPanelMode("workflow");
    setFieldPanelOpen(true);
    setDetailPanelOpen(false);
  };
  const saveField = async (input: FieldInput) => {
    const field = editingField ? await updateField(editingField.id, input) : await createField(input);
    setFields((current) => editingField ? current.map((item) => item.id === field.id ? field : item) : [...current, field]);
    setSelectedFieldId(field.id);
    void fetchFieldHistory(field.id).then(setFieldHistory).catch(() => undefined);
    setFieldEditorOpen(false);
    setEditingField(null);
    setDraftBoundary(null);
  };
  const archiveSelectedField = async () => {
    if (!selectedField || !window.confirm(`归档“${selectedField.name}”吗？历史分析记录会保留。`)) return;
    try {
      await archiveField(selectedField.id);
      setFields((current) => current.filter((field) => field.id !== selectedField.id));
      setSelectedFieldId(null);
      setTask(null);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "地块归档失败。"); }
  };
  const startFieldScouting = () => {
    setConversationScoutingDraft(null);
    setInspectionLocation(null);
    setFieldScoutingDraftLocation(null);
    setFieldScoutingPicking(true);
    setInspectionPicking(true);
    setFieldPanelOpen(false);
    setDetailPanelOpen(false);
  };
  const startConversationScouting = (draft: ConversationScoutingNoteDraft) => {
    if (!selectedField || draft.fieldId !== selectedField.id) return false;
    setConversationScoutingDraft(draft);
    setInspectionLocation(null);
    setFieldPanelOpen(false);
    setDetailPanelOpen(false);
    if (draft.location) {
      setFieldScoutingPicking(false);
      setInspectionPicking(false);
      setFieldScoutingDraftLocation(draft.location);
    } else {
      setFieldScoutingDraftLocation(null);
      setFieldScoutingPicking(true);
      setInspectionPicking(true);
    }
    return true;
  };
  const importGeoJson = async (file: File) => {
    try {
      const imported = await importFields(file);
      setFields((current) => [...current, ...imported]);
      setSelectedFieldId(imported[0]?.id ?? null);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "GeoJSON 导入失败。"); }
  };
  const isFeaturePanel = leftPanelMode === "features" || leftPanelMode === "workflow" || leftPanelMode === "prescription";
  const openAgentPanel = () => {
    setLeftPanelMode("analysis");
    setFieldPanelOpen(true);
    setDetailPanelOpen(false);
    setLayerMenuOpen(false);
  };
  const openFeaturePanel = () => {
    setLeftPanelMode("features");
    if (taskSurface !== "workflow" || !task) setSelectedVisualizationKey("basemap");
    setFieldPanelOpen(true);
    setDetailPanelOpen(false);
    setLayerMenuOpen(false);
  };
  const openWorkflow = (value: AnalysisObjective) => {
    setObjective(value);
    setLeftPanelMode("workflow");
    if (taskSurface !== "workflow" || task?.objective !== value) {
      setTask(null);
      setAnalysisResults([]);
      setFocusedFindingId(null);
      setSelectedVisualizationKey("basemap");
      setAnalysisDate(null);
      setPeriod("last_30_days");
    }
  };
  const returnToFeatureHome = () => {
    setLeftPanelMode("features");
    setFieldPanelOpen(true);
  };
  const leftPanelTitle = leftPanelMode === "fields"
    ? "农田"
    : leftPanelMode === "records"
      ? "任务记录"
      : isFeaturePanel
        ? leftPanelMode === "features" ? "功能" : leftPanelMode === "prescription" ? "施氮方案" : workflowCopy[objective].title
        : "农情 Agent";
  const leftPanelSubtitle = leftPanelMode === "fields"
    ? fieldListError ? "加载失败" : `${fields.length} 块农田`
    : leftPanelMode === "records"
      ? taskRecordsError ? "加载失败" : `最近 ${taskRecords.length} 条`
      : selectedField?.name ?? "先选择农田";

  return (
    <div className="agri-shell">
      <nav className="nav-rail">
        <div className="nav-brand"><span><Leaf size={22} weight="fill" /></span><div><strong>黑土智管</strong><small>玉米农情 Agent</small></div></div>
        <div className="nav-menu">
          <button aria-label="农田" title="农田" className={leftPanelMode === "fields" ? "is-active" : ""} onClick={() => { setLeftPanelMode("fields"); setFieldPanelOpen(true); }}><Farm size={20} weight="fill" /><span>农田</span></button>
          <button aria-label="农情 Agent" title="农情 Agent" className={leftPanelMode === "analysis" ? "is-active" : ""} onClick={openAgentPanel}><ChartLineUp size={20} /><span>Agent</span></button>
          <button aria-label="功能" title="功能" className={isFeaturePanel ? "is-active" : ""} onClick={openFeaturePanel}><Grains size={20} /><span>功能</span></button>
          <button aria-label="任务记录" title="任务记录" className={leftPanelMode === "records" ? "is-active" : ""} onClick={() => void openTaskRecords()}><ListChecks size={20} /><span>记录</span></button>
        </div>
        <div className="nav-bottom"><div className="account-mark">辽</div><span className="account-name">铁岭示范账户</span></div>
      </nav>

      <main className="map-workspace">
        <MapCanvas fields={fields} selectedFieldId={selectedFieldId} findings={visibleMapFindings} focusedFindingId={focusedFindingId} scoutingNotes={scoutingNotes} focusedScoutingNoteId={focusedScoutingNoteId} visualizationLayer={selectedVisualization} nitrogenZones={nitrogenZones} spatialOverlays={spatialOverlays} focusFieldSignal={focusFieldSignal} locateSignal={locateSignal} fieldPanelOpen={fieldPanelOpen} detailPanelOpen={detailPanelOpen} onSelectField={selectField} onSelectScoutingNote={(noteId) => { setFocusedScoutingNoteId(noteId); setDetailView("scouting"); setDetailPanelOpen(true); }} onLocationError={setError} drawing={fieldEditorOpen} draftBoundary={draftBoundary} onBoundaryDrawn={setDraftBoundary} inspectionPicking={inspectionPicking} inspectionLocation={inspectionLocation} onInspectionLocationChange={(location) => { setError(null); setInspectionPicking(false); if (fieldScoutingPicking) { setInspectionLocation(null); setFieldScoutingPicking(false); setFieldScoutingDraftLocation(location); return; } setInspectionLocation(location); }} />

        {leftPanelMode === "workflow" && fieldPanelOpen && !task ? <div className="workflow-backdrop" role="presentation" aria-hidden="true" onMouseDown={() => setFieldPanelOpen(false)} /> : null}
        {leftPanelMode === "workflow" && fieldPanelOpen && !task ? <aside className="feature-context-rail" aria-label="功能总览" aria-hidden="true">
          <div className="drawer-head"><div><h1>功能</h1><span>{leftPanelSubtitle}</span></div></div>
          <FeatureHome field={selectedField} activeObjective={objective} onSelect={openWorkflow} />
        </aside> : null}
        <aside className={`field-drawer${leftPanelMode === "analysis" ? " is-agent-panel is-analysis" : leftPanelMode === "features" ? " is-feature-panel is-feature-home" : leftPanelMode === "workflow" ? " is-feature-panel is-workflow" : leftPanelMode === "prescription" ? " is-feature-panel is-prescription" : leftPanelMode === "records" ? " is-records" : ""} ${fieldPanelOpen ? "is-open" : ""}`}>
          <div className="drawer-head"><div className="drawer-title-group">{leftPanelMode === "workflow" || leftPanelMode === "prescription" ? <button className="feature-back" aria-label="返回功能" title="返回功能" onClick={leftPanelMode === "workflow" ? returnToFeatureHome : () => setLeftPanelMode("features")}><CaretLeft size={18} /></button> : null}{leftPanelMode === "workflow" ? <span className="workflow-title-icon">{workflowCardIcon(objective)}</span> : null}<div><h1>{leftPanelTitle}</h1><span>{leftPanelSubtitle}</span></div></div>{leftPanelMode === "workflow" ? null : <button className="plain-icon" aria-label={`收起${leftPanelTitle}面板`} title={`收起${leftPanelTitle}面板`} onClick={() => setFieldPanelOpen(false)}>{isFeaturePanel ? <X size={18} weight="bold" /> : <CaretLeft size={19} />}</button>}</div>
          {(leftPanelMode === "prescription" || (leftPanelMode === "workflow" && objective === "water_nitrogen_diagnosis")) ? <WaterNitrogenNav mode={leftPanelMode} onDiagnosisSelect={() => { setObjective("water_nitrogen_diagnosis"); setLeftPanelMode("workflow"); }} onPrescriptionSelect={() => setLeftPanelMode("prescription")} /> : null}
          {leftPanelMode === "fields" ? <>
          <div className="field-tools"><label><MagnifyingGlass size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索地块名称或村庄" /></label></div>
          <div className="field-list-new">
            {loadingFields ? <FieldSkeleton /> : null}
            {!loadingFields && fieldListError ? <LoadFailure message={fieldListError} onRetry={() => void loadFields()} /> : null}
            {!loadingFields && !fieldListError && filteredFields.length === 0 ? <div className="empty-state">没有找到匹配地块</div> : null}
            {filteredFields.map((field) => <button key={field.id} className={`field-card ${field.id === selectedFieldId ? "is-selected" : ""}`} onClick={() => selectField(field.id)}>
              <div><strong>{field.name}</strong><StatusDot status={field.latestStatus} /></div><p>{field.village}</p><footer><span>{field.areaHa.toFixed(2)} 公顷</span><span>{cropName(field.crop)} · {field.seasonYear}</span></footer>
            </button>)}
          </div>
          <div className="field-actions"><button className="drawer-primary" onClick={() => openFieldEditor()}><Plus size={18} />新增地块</button><button className="import-button" onClick={() => importInputRef.current?.click()}>导入 GeoJSON</button><input ref={importInputRef} type="file" accept="application/geo+json,application/json,.geojson" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void importGeoJson(file); event.currentTarget.value = ""; }} /></div>
          </> : leftPanelMode === "records" ? <TaskRecordList tasks={taskRecords} fields={fields} loading={taskRecordsLoading} error={taskRecordsError} filter={taskRecordFilter} onFilterChange={(value) => void loadTaskRecords(value)} onRetry={() => void loadTaskRecords(taskRecordFilter)} onOpen={openTaskRecord} /> : leftPanelMode === "features" ? <FeatureHome field={selectedField} onSelect={openWorkflow} /> : leftPanelMode === "prescription" ? selectedField ? <VariableNitrogenView key={selectedField.id} field={selectedField} options={nitrogenSourceOptions} prescriptions={nitrogenPrescriptions} loading={nitrogenLoading} onZonesChange={setNitrogenZones} onViewMap={() => { setSelectedVisualizationKey("basemap"); setFieldPanelOpen(false); setFocusFieldSignal((value) => value + 1); }} onStartGrowth={() => { setObjective("growth_stage_monitoring"); setLeftPanelMode("workflow"); setTask(null); setAnalysisResults([]); setFocusedFindingId(null); setSelectedVisualizationKey("basemap"); setAnalysisDate(null); setPeriod("last_30_days"); }} onSaved={(prescription) => { setNitrogenPrescriptions((current) => [prescription, ...current]); setNitrogenZones(prescription.zones); }} /> : <PrescriptionFieldPicker fields={fields} loading={loadingFields} onSelect={selectField} /> : leftPanelMode === "workflow" ? <WorkflowPanel field={selectedField} task={taskSurface === "workflow" ? task : null} acquisition={acquisition} agentRun={agentRun} analysisResults={analysisResults} objective={objective} period={period} analysisDate={analysisDate} selectedScoutingNoteCount={selectedScoutingNoteIds.length} visualizations={currentVisualizationLayers} charts={currentChartArtifacts} scoutingNotes={scoutingNotes} inspectionPicking={inspectionPicking && !fieldScoutingPicking} inspectionLocation={inspectionLocation} onPeriodChange={setPeriod} onStart={(intent) => startAnalysis(intent, "workflow")} onInspectionStart={() => { setInspectionLocation(null); setInspectionPicking(true); }} onInspectionEnd={() => { setInspectionPicking(false); setInspectionLocation(null); }} onScoutingNoteSaved={(note) => setScoutingNotes((current) => [note, ...current])} onFocusFinding={setFocusedFindingId} onFollowUpAnalysis={followUpAnalysis} onNewWorkflow={() => { setTask(null); setAnalysisResults([]); setFocusedFindingId(null); setSelectedScoutingNoteIds([]); setInspectionPicking(false); setInspectionLocation(null); setSelectedVisualizationKey("basemap"); setAnalysisDate(null); setPeriod("last_30_days"); }} onOpenData={openTaskData} onEditField={() => openFieldEditor(selectedField)} onRecordFieldNote={startFieldScouting} onSelectVisualization={(layer) => setSelectedVisualizationKey(layer.ref)} /> : <FieldAgentChat field={selectedField} onPrepareScoutingNote={startConversationScouting} onStartWorkflow={startConversationWorkflow} />}
        </aside>
        {!fieldPanelOpen ? <button className="drawer-toggle left" title={`展开${leftPanelTitle}面板`} aria-label={`展开${leftPanelTitle}面板`} onClick={() => setFieldPanelOpen(true)}><CaretRight size={18} /></button> : null}

        {selectedField ? <div className="map-topbar">
          <button onClick={() => { setLayerMenuOpen(false); setDetailView("status"); setDetailPanelOpen(true); }}><MapPin size={16} weight="fill" /><strong>{selectedField.name}</strong><span>{selectedField.areaHa.toFixed(2)} 公顷</span></button>
        </div> : null}
        {!detailPanelOpen ? <div className="map-layer-fab">
          <div className="map-layer-control">
          <button className={`layer-trigger${layerMenuOpen ? " is-active" : ""}`} title="地图图层" aria-label={`地图图层，当前${selectedVisualization?.label ?? "卫星底图"}`} aria-expanded={layerMenuOpen} onClick={() => { const opening = !layerMenuOpen; setLayerMenuOpen(opening); if (opening) setDetailPanelOpen(false); }}><Stack size={18} weight="bold" /><span>图层</span></button>
            {layerMenuOpen ? <MapLayerMenu layers={visualizationLayers} selected={selectedVisualization} loading={mapLayersLoading} error={mapLayersError} overlays={spatialOverlays} hasTask={Boolean(task || visibleMapFindings.length)} hasScoutingNotes={scoutingNotes.length > 0} hasNitrogenZones={nitrogenZones.length > 0} onToggle={(key) => setSpatialOverlays((current) => ({ ...current, [key]: !current[key] }))} onLocate={() => setFocusFieldSignal((value) => value + 1)} onSelect={(layer) => setSelectedVisualizationKey(layer?.ref ?? "basemap")} /> : null}
          </div>
        </div> : null}
        <div className={`map-controls${detailPanelOpen ? " has-right-drawer" : ""}`}>
          <button title="回到所选地块" aria-label="回到所选地块" disabled={!selectedFieldId} onClick={() => setFocusFieldSignal((value) => value + 1)}><ArrowClockwise size={19} /></button>
          <button title="定位当前位置" aria-label="定位当前位置" onClick={() => setLocateSignal((value) => value + 1)}><Crosshair size={19} /></button>
        </div>
        {selectedVisualization && !detailPanelOpen ? <MapObservationLegend layer={selectedVisualization} /> : null}
        {nitrogenZones.length ? <div className="nitrogen-map-legend"><span><i className="is-low" />相对低</span><span><i className="is-medium" />中等</span><span><i className="is-high" />相对高</span></div> : fields.length > 0 ? <div className="map-legend-new"><span><i className="field-key" />地块边界</span>{scoutingNotes.length ? <span><i className="scouting-key" />巡田记录</span> : null}{visibleMapFindings.some((finding) => finding.findingType === "observation_zone") ? <span><i className="observation-key" />{task?.objective === "waterlogging_detection" ? "雷达变化区" : task?.objective === "water_nitrogen_diagnosis" ? "田内低值区" : "长势偏弱区"}</span> : null}{visibleMapFindings.some((finding) => finding.findingType === "candidate_zone") ? <span><i className="candidate-key" />{task?.objective === "waterlogging_detection" ? "疑似积水区" : "原因线索区"}</span> : null}</div> : null}

        <aside className={`analysis-drawer ${detailPanelOpen ? "is-open" : ""}`}>
          <div className="drawer-head"><div><span className="section-kicker">{detailView === "status" ? "田况状态" : detailView === "data" ? "地块数据" : detailView === "scouting" ? "巡田记录" : "地块档案"}</span><h2>{selectedField?.name ?? "选择地块"}</h2></div><div className="drawer-head-actions"><button className="drawer-layer-button" title="切换地图图层" aria-label="切换地图图层" onClick={() => { setDetailPanelOpen(false); setLayerMenuOpen(true); }}><Stack size={18} /><span>切换图层</span></button><button className="plain-icon" title="关闭地块详情" aria-label="关闭地块详情" onClick={() => setDetailPanelOpen(false)}><X size={19} /></button></div></div>
          <div className="detail-body">
            {error ? <div className="error-banner"><WarningCircle size={18} weight="fill" /><span>{error}</span><button onClick={() => setError(null)}>关闭</button></div> : null}
            {!fieldEditorOpen && selectedField && !selectedDataSource ? <FieldDetailTabs value={detailView} onChange={(view) => setDetailView(view)} /> : null}
            {fieldEditorOpen ? <FieldEditor field={editingField} boundary={draftBoundary} onCancel={() => { setFieldEditorOpen(false); setEditingField(null); setDraftBoundary(null); }} onSave={saveField} /> : null}
            {!fieldEditorOpen && !selectedField ? <NoFieldSelected /> : null}
            {!fieldEditorOpen && selectedField && detailView === "status" ? <FieldStatusView field={selectedField} layers={visualizationLayers} charts={chartArtifacts} selected={selectedVisualization} loading={mapLayersLoading} error={mapLayersError} onSelectLayer={(layer) => setSelectedVisualizationKey(layer.ref)} onClearMap={() => setSelectedVisualizationKey("basemap")} onViewMap={(layer) => { setSelectedVisualizationKey(layer.ref); setDetailPanelOpen(false); }} onAnalyzeDate={analyzeObservationDate} onOpenData={openFieldData} /> : null}
            {!fieldEditorOpen && selectedField && detailView === "overview" ? <FieldDetails field={selectedField} onEdit={() => openFieldEditor(selectedField)} onArchive={() => void archiveSelectedField()} /> : null}
            {!fieldEditorOpen && selectedField && detailView === "scouting" ? <FieldScoutingView notes={scoutingNotes} focusedNoteId={focusedScoutingNoteId} onFocusNote={setFocusedScoutingNoteId} onAdd={startFieldScouting} onAnalyzeNote={(note) => { setAnalysisDate(note.observedAt); setPeriod("selected_date"); setObjective("water_nitrogen_diagnosis"); setSelectedScoutingNoteIds([note.id]); setTask(null); setAnalysisResults([]); setTaskSurface("workflow"); setLeftPanelMode("workflow"); setFieldPanelOpen(true); setDetailPanelOpen(false); }} /> : null}
            {!fieldEditorOpen && selectedField && detailView === "data" && selectedDataSource ? <DataSourceHistoryView source={selectedDataSource} runs={acquisitionHistory} loading={acquisitionHistoryLoading} visualizations={visualizationLayers.filter((layer) => layer.source === selectedDataSource)} charts={chartArtifacts.filter((artifact) => artifact.chart.source === selectedDataSource)} onOpenMapLayers={(layer) => { setSelectedVisualizationKey(layer.ref); setDetailPanelOpen(false); setLayerMenuOpen(true); }} onBack={() => setSelectedDataSource(null)} /> : null}
            {!fieldEditorOpen && selectedField && detailView === "data" && !selectedDataSource ? <FieldDataView acquisition={acquisition} loading={acquisitionLoading} targetDate={dataTargetDate} matches={dataMatches} matchesLoading={dataMatchesLoading} onTargetDateChange={setDataTargetDate} onRefresh={() => void loadFieldData(selectedField, true, dataAcquisitionRequest ?? undefined)} onOpenSource={(source) => void openDataSource(source)} /> : null}
          </div>
        </aside>
        {fieldScoutingPicking ? <div className="field-scouting-map-hint"><MapPin size={16} weight="fill" /><span>在地块内点击巡田位置</span><button className="plain-icon" aria-label="取消新增巡田记录" title="取消" onClick={() => { setConversationScoutingDraft(null); setFieldScoutingPicking(false); setInspectionPicking(false); setInspectionLocation(null); setDetailPanelOpen(true); }}><X size={16} /></button></div> : null}
        {selectedField && fieldScoutingDraftLocation ? <FieldScoutingNoteModal field={selectedField} location={fieldScoutingDraftLocation} initial={conversationScoutingDraft} onClose={() => { setConversationScoutingDraft(null); setFieldScoutingDraftLocation(null); setInspectionLocation(null); setDetailView("scouting"); setDetailPanelOpen(true); }} onSaved={(note) => { setScoutingNotes((current) => [note, ...current]); setFocusedScoutingNoteId(note.id); setConversationScoutingDraft(null); setFieldScoutingDraftLocation(null); setInspectionLocation(null); setDetailView("scouting"); setDetailPanelOpen(true); }} /> : null}
      </main>
    </div>
  );
}

function FieldEditor({ field, boundary, onCancel, onSave }: { field: FieldSummary | null; boundary: FieldSummary["boundary"] | null; onCancel: () => void; onSave: (input: FieldInput) => Promise<void> }) {
  const [name, setName] = useState(field?.name ?? ""); const [crop, setCrop] = useState<FieldInput["crop"]>(field?.crop ?? "corn"); const [seasonYear, setSeasonYear] = useState(field?.seasonYear ?? new Date().getFullYear()); const [plantingDate, setPlantingDate] = useState(field?.plantingDate ?? ""); const [variety, setVariety] = useState(field?.variety ?? ""); const [saving, setSaving] = useState(false); const [message, setMessage] = useState<string | null>(null);
  useEffect(() => { setName(field?.name ?? ""); setCrop(field?.crop ?? "corn"); setSeasonYear(field?.seasonYear ?? new Date().getFullYear()); setPlantingDate(field?.plantingDate ?? ""); setVariety(field?.variety ?? ""); setMessage(null); }, [field]);
  const submit = async () => { if (!boundary) return setMessage("请先在地图上绘制地块边界。"); setSaving(true); setMessage(null); try { await onSave({ name, crop, seasonYear, plantingDate: plantingDate || null, variety: variety || null, boundary }); } catch (reason) { setMessage(reason instanceof Error ? reason.message : "地块保存失败。"); } finally { setSaving(false); } };
  return <div className="panel-scroll-new field-editor"><div className="editor-hint"><strong>{field ? "编辑地块边界" : "在地图上绘制地块"}</strong><span>单击落点，双击结束；选中边界后可拖动顶点，右上角垃圾桶可删除。</span></div><section className="form-section-new"><label>地块名称</label><input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：北田 01" /></section><section className="form-section-new"><label>作物</label><select value={crop} onChange={(event) => { setCrop(event.target.value as FieldInput["crop"]); setVariety(""); }}><option value="corn">玉米</option></select></section><section className="form-section-new"><label>具体品种（可选）</label><input value={variety} onChange={(event) => setVariety(event.target.value)} placeholder="例如：先玉 335" /></section><section className="form-section-new"><label>种植季年份</label><input type="number" value={seasonYear} min="2000" max="2100" onChange={(event) => setSeasonYear(Number(event.target.value))} /></section><section className="form-section-new"><label>播种日期</label><input type="date" value={plantingDate} onChange={(event) => setPlantingDate(event.target.value)} /></section>{message ? <p className="field-error">{message}</p> : null}<div className="drawer-footer split"><button className="secondary-button" onClick={onCancel}>取消</button><button className="drawer-primary" disabled={saving || !boundary || !name.trim()} onClick={() => void submit()}>{saving ? "正在保存" : field ? "保存修改" : "保存地块"}</button></div></div>;
}

function FeatureHome({ field, activeObjective, onSelect }: { field: FieldSummary | null; activeObjective?: AnalysisObjective; onSelect: (objective: AnalysisObjective) => void }) {
  return <div className="panel-scroll-new feature-home">
    <div className="feature-card-grid">
      {objectives.map((item) => {
        const copy = featureCardCopy[item.value];
        return <button key={item.value} className={`feature-card is-${item.value}${activeObjective === item.value ? " is-selected" : ""}`} disabled={!field} onClick={() => onSelect(item.value)}>
          <span className="feature-card-icon">{workflowCardIcon(item.value)}</span>
          <span className="feature-card-copy"><strong>{copy.title}</strong><small>{copy.summary}</small></span>
          <CaretRight size={17} weight="bold" />
        </button>;
      })}
    </div>
  </div>;
}

function workflowCardIcon(objective: AnalysisObjective) {
  if (objective === "water_nitrogen_diagnosis") return <Drop size={22} weight="fill" />;
  if (objective === "waterlogging_detection") return <CloudRain size={22} weight="fill" />;
  if (objective === "frost_risk_warning") return <ThermometerCold size={22} weight="fill" />;
  return <ChartLineUp size={22} weight="bold" />;
}

function WaterNitrogenNav({ mode, onDiagnosisSelect, onPrescriptionSelect }: { mode: LeftPanelMode; onDiagnosisSelect: () => void; onPrescriptionSelect: () => void }) {
  return <nav className="water-nitrogen-switcher" aria-label="水氮管理步骤">
    <button className={mode === "workflow" ? "is-active" : ""} onClick={onDiagnosisSelect}>排查</button>
    <button className={mode === "prescription" ? "is-active" : ""} onClick={onPrescriptionSelect}>施氮</button>
  </nav>;
}

function WorkflowPanel({ field, task, acquisition, agentRun, analysisResults, objective, period, analysisDate, selectedScoutingNoteCount, visualizations, charts, scoutingNotes, inspectionPicking, inspectionLocation, onPeriodChange, onStart, onInspectionStart, onInspectionEnd, onScoutingNoteSaved, onFocusFinding, onFollowUpAnalysis, onNewWorkflow, onOpenData, onEditField, onRecordFieldNote, onSelectVisualization }: { field: FieldSummary | null; task: AnalysisTask | null; acquisition: DataAcquisitionRun | null; agentRun: AgentRunTrace | null; analysisResults: AnalysisResult<unknown>[]; objective: AnalysisObjective; period: AnalysisPeriod; analysisDate: string | null; selectedScoutingNoteCount: number; visualizations: MapVisualizationLayer[]; charts: ChartArtifact[]; scoutingNotes: FieldScoutingNote[]; inspectionPicking: boolean; inspectionLocation: Position | null; onPeriodChange: (period: AnalysisPeriod) => void; onStart: (intent: AgentStartIntent) => Promise<boolean>; onInspectionStart: () => void; onInspectionEnd: () => void; onScoutingNoteSaved: (note: FieldScoutingNote) => void; onFocusFinding: (findingId: string) => void; onFollowUpAnalysis: (task: AnalysisTask, scoutingNoteIds?: string[], inspectionTaskId?: string) => void; onNewWorkflow: () => void; onOpenData: () => void; onEditField: () => void; onRecordFieldNote: () => void; onSelectVisualization: (layer: MapVisualizationLayer) => void }) {
  if (!field) return <NoFieldSelected />;
  if (!task) return <WorkflowSetup field={field} objective={objective} period={period} analysisDate={analysisDate} selectedScoutingNoteCount={selectedScoutingNoteCount} onPeriodChange={onPeriodChange} onStart={onStart} />;
  if (task.status === "running") return <TaskProgress field={field} task={task} agentRun={agentRun} surface="workflow" />;
  return <TaskResult surface="workflow" field={field} task={task} acquisition={acquisition} agentRun={agentRun} analysisResults={analysisResults} visualizations={visualizations} charts={charts} scoutingNotes={scoutingNotes} inspectionPicking={inspectionPicking} inspectionLocation={inspectionLocation} onInspectionStart={onInspectionStart} onInspectionEnd={onInspectionEnd} onScoutingNoteSaved={onScoutingNoteSaved} onFocusFinding={onFocusFinding} onFollowUpAnalysis={onFollowUpAnalysis} onNewAnalysis={onNewWorkflow} onOpenData={onOpenData} onEditField={onEditField} onRecordFieldNote={onRecordFieldNote} onSelectVisualization={onSelectVisualization} />;
}

function WorkflowSetup({ field, objective, period, analysisDate, selectedScoutingNoteCount, onPeriodChange, onStart }: { field: FieldSummary; objective: AnalysisObjective; period: AnalysisPeriod; analysisDate: string | null; selectedScoutingNoteCount: number; onPeriodChange: (period: AnalysisPeriod) => void; onStart: (intent: AgentStartIntent) => Promise<boolean> }) {
  const [starting, setStarting] = useState(false);
  const detail = workflowCopy[objective];
  const run = async () => { setStarting(true); try { await onStart({ message: detail.prompt, objective, period: objective === "frost_risk_warning" ? "last_30_days" : period }); } finally { setStarting(false); } };
  return <div className="panel-scroll-new workflow-setup">
    <section className="workflow-launcher">
      <p className="workflow-purpose">{detail.purpose}</p>
      <div className="workflow-scope-grid">
        <div><span>分析地块</span><strong>{field.name}</strong><small>{field.areaHa.toFixed(2)} 公顷 · {cropName(field.crop)}</small></div>
        <div><span>任务类型</span><strong>{detail.title}</strong><small>基于已登记的田块数据</small></div>
      </div>
      <div className="workflow-compact-row"><span>{objective === "waterlogging_detection" ? "事件" : "时间"}</span>{objective === "frost_risk_warning" ? <strong>最新未来 10 天</strong> : <div className="workflow-period">{analysisDate ? <button className={period === "selected_date" ? "is-active" : ""} onClick={() => onPeriodChange("selected_date")}>{formatShortDate(analysisDate)}{objective === "waterlogging_detection" ? "事件" : ""}</button> : null}<button className={period === "last_30_days" ? "is-active" : ""} onClick={() => onPeriodChange("last_30_days")}>{objective === "waterlogging_detection" ? "近30天事件" : objective === "water_nitrogen_diagnosis" ? "最近观测" : "近 30 天"}</button>{objective !== "waterlogging_detection" ? <button className={period === "this_season" ? "is-active" : ""} onClick={() => onPeriodChange("this_season")}>本季</button> : null}</div>}</div>
      {selectedScoutingNoteCount ? <div className="workflow-compact-note"><CheckCircle size={14} weight="fill" /><span>{selectedScoutingNoteCount} 条巡田记录</span></div> : null}
      <button className="workflow-run" disabled={starting || field.crop !== "corn"} onClick={() => void run()}>{starting ? <span className="agent-send-pulse" /> : <ChartLineUp size={17} />}{starting ? "正在开始" : workflowActionLabel(objective)}</button>
    </section>
  </div>;
}

function workflowActionLabel(objective: AnalysisObjective): string {
  if (objective === "water_nitrogen_diagnosis") return "开始排查";
  if (objective === "waterlogging_detection") return "识别积水";
  if (objective === "frost_risk_warning") return "查看风险";
  return "检查长势";
}

function FieldAgentChat({ field, onStartWorkflow, onPrepareScoutingNote }: { field: FieldSummary | null; onStartWorkflow: (plan: ConversationWorkflowPlan) => Promise<boolean>; onPrepareScoutingNote: (draft: ConversationScoutingNoteDraft) => boolean }) {
  if (!field) return <NoFieldSelected />;
  return <FieldAgentConversation key={field.id} field={field} onStartWorkflow={onStartWorkflow} onPrepareScoutingNote={onPrepareScoutingNote} />;
}

function FieldAgentConversation({ field, onStartWorkflow, onPrepareScoutingNote }: { field: FieldSummary; onStartWorkflow: (plan: ConversationWorkflowPlan) => Promise<boolean>; onPrepareScoutingNote: (draft: ConversationScoutingNoteDraft) => boolean }) {
  const [messages, setMessages] = useState<FieldConversationMessage[]>([]);
  const [content, setContent] = useState("");
  const [pendingQuestion, setPendingQuestion] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [startingWorkflow, setStartingWorkflow] = useState(false);
  const [workflowPlan, setWorkflowPlan] = useState<ConversationWorkflowPlan | null>(null);
  const [scoutingNoteDraft, setScoutingNoteDraft] = useState<ConversationScoutingNoteDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void fetchFieldConversation(field.id).then((items) => { if (!cancelled) setMessages(items); }).catch((reason: unknown) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : "对话加载失败。");
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [field.id]);
  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [messages, pendingQuestion, sending, workflowPlan, scoutingNoteDraft]);
  const submit = async () => {
    const question = content.trim();
    if (!question || sending) return;
    setSending(true);
    setError(null);
    setPendingQuestion(question);
    setContent("");
    try {
      const exchange = await sendFieldConversationMessage(field.id, question);
      setMessages((current) => [...current, exchange.userMessage, exchange.assistantMessage]);
      setWorkflowPlan(exchange.workflowPlan);
      setScoutingNoteDraft(exchange.scoutingNoteDraft);
      setPendingQuestion(null);
    } catch (reason) {
      setPendingQuestion(null);
      setContent(question);
      setError(reason instanceof Error ? reason.message : "农情 Agent 暂时无法回答，请稍后重试。");
    } finally {
      setSending(false);
    }
  };
  return <section className="field-agent-chat" aria-label={`与农情 Agent 讨论${field.name}`}>
    <div className="task-field-context"><span>{cropName(field.crop)} · {field.areaHa.toFixed(2)} 公顷</span>{field.variety ? <small>{field.variety}</small> : null}</div>
    <div className="field-agent-messages" aria-live="polite">
      {loading ? <div className="conversation-history-loading"><i /><span>正在读取对话</span></div> : null}
      {!loading && messages.length === 0 ? <article className="agent-welcome-message"><span><Leaf size={17} weight="fill" /></span><div><strong>农情 Agent</strong><p>你好，有什么想聊的？</p></div></article> : null}
      {messages.map((message) => <div key={message.id} className={`conversation-message is-${message.role}`}><small>{message.role === "user" ? "你" : "农情 Agent"}</small><p>{message.content}</p></div>)}
      {pendingQuestion ? <div className="conversation-message is-user"><small>你</small><p>{pendingQuestion}</p></div> : null}
      {sending ? <div className="conversation-message is-assistant is-thinking"><small>农情 Agent</small><p><i /><i /><i /></p></div> : null}
      {workflowPlan ? <section className="conversation-workflow-plan" aria-label={`${workflowPlan.title}计划`}>
        <div><strong>{workflowPlan.title}</strong><p>{workflowPlan.steps.join(" · ")}</p>{workflowPlan.missingInputs.length ? <small>缺少：{workflowPlan.missingInputs.join("、")}</small> : null}</div>
        <button disabled={startingWorkflow} onClick={() => void (async () => { setStartingWorkflow(true); setError(null); try { const started = await onStartWorkflow(workflowPlan); if (started) setWorkflowPlan(null); else setError("工作流没有启动，请重试。"); } finally { setStartingWorkflow(false); } })()}>{startingWorkflow ? "正在启动" : "确认并开始"}</button>
      </section> : null}
      {scoutingNoteDraft ? <section className="conversation-workflow-plan is-scouting-note" aria-label="巡田记录草稿">
        <div><strong>巡田记录</strong><p>{scoutingDraftSummary(scoutingNoteDraft)}</p>{scoutingNoteDraft.missingInputs.length ? <small>缺少：{scoutingNoteDraft.missingInputs.join("、")}</small> : null}</div>
        <button onClick={() => { if (onPrepareScoutingNote(scoutingNoteDraft)) setScoutingNoteDraft(null); }}>{scoutingNoteDraft.location ? "检查并保存" : "选择位置"}</button>
      </section> : null}
      <div ref={endRef} />
    </div>
    <form className="conversation-composer field-agent-composer" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      {error ? <p>{error}</p> : null}
      <div><input aria-label="给农情 Agent 发消息" value={content} maxLength={1000} autoFocus onChange={(event) => setContent(event.target.value)} placeholder="发消息" /><button type="submit" aria-label="发送消息" title="发送" disabled={!content.trim() || sending}><PaperPlaneRight size={17} weight="fill" /></button></div>
    </form>
  </section>;
}

function FieldDetailTabs({ value, onChange }: { value: FieldDetailView; onChange: (value: FieldDetailView) => void }) {
  return <nav className="field-detail-tabs" aria-label="地块详情视图">
    <button className={value === "status" ? "is-active" : ""} onClick={() => onChange("status")}>田况</button>
    <button className={value === "overview" ? "is-active" : ""} onClick={() => onChange("overview")}>档案</button>
    <button className={value === "data" ? "is-active" : ""} onClick={() => onChange("data")}>数据</button>
    <button className={value === "scouting" ? "is-active" : ""} onClick={() => onChange("scouting")}>巡田</button>
  </nav>;
}

function PrescriptionFieldPicker({ fields, loading, onSelect }: { fields: FieldSummary[]; loading: boolean; onSelect: (fieldId: string) => void }) {
  return <div className="panel-scroll-new prescription-field-picker">
    <p>选择地块</p>
    {loading ? <FieldSkeleton /> : fields.map((field) => <button key={field.id} className="field-card" onClick={() => onSelect(field.id)}>
      <div><strong>{field.name}</strong><StatusDot status={field.latestStatus} /></div>
      <p>{field.village}</p>
      <footer><span>{field.areaHa.toFixed(2)} 公顷</span><span>{cropName(field.crop)} · {field.seasonYear}</span></footer>
    </button>)}
    {!loading && fields.length === 0 ? <div className="empty-state">暂无地块</div> : null}
  </div>;
}

function LoadFailure({ message, onRetry }: { message: string; onRetry: () => void }) {
  return <div className="load-failure"><WarningCircle size={25} weight="fill" /><strong>内容加载失败</strong><p>{message}</p><button onClick={onRetry}><ArrowClockwise size={15} weight="bold" />重新加载</button></div>;
}

function TaskRecordList({ tasks, fields, loading, error, filter, onFilterChange, onRetry, onOpen }: { tasks: AnalysisTask[]; fields: FieldSummary[]; loading: boolean; error: string | null; filter: TaskRecordFilter; onFilterChange: (value: TaskRecordFilter) => void; onRetry: () => void; onOpen: (task: AnalysisTask) => void }) {
  const singleObjective = filter !== "all";
  return <div className="panel-scroll-new task-record-list">
    <label className="task-record-filter"><select aria-label="筛选分析记录" value={filter} onChange={(event) => onFilterChange(event.target.value as TaskRecordFilter)}><option value="all">全部分析</option>{objectives.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
    {loading ? <div className="task-record-loading"><i /><i /><i /></div> : null}
    {!loading && error ? <LoadFailure message={error} onRetry={onRetry} /> : null}
    {!loading && !error && !tasks.length ? <div className="task-record-empty"><ListChecks size={26} /><strong>没有这类任务</strong><p>完成对应农情任务后，可以从这里重新打开结果。</p></div> : null}
    {!loading && !error ? tasks.map((record) => {
    const field = fields.find((item) => item.id === record.fieldId);
    const observationOnly = isSatelliteConditionObservation(record);
    const legacy = isLegacyWaterNitrogenTask(record);
    const waterNitrogenObservation = observationOnly ? getWaterNitrogenObservation(record.analysisResults) : null;
    const status = waterNitrogenObservation ? waterNitrogenObservationStatus(waterNitrogenObservation, record.status)
      : legacy ? { label: "历史版本", tone: "partial" as const } : taskStatusPresentation(record.status);
    const objectiveLabel = objectiveName(record.objective);
    const recordSummary = legacy
      ? "早期试验结果，仅保留历史记录。"
      : record.status === "failed"
        ? "任务未完成，打开查看失败原因。"
        : observationOnly
          ? waterNitrogenRecordSummary(record)
          : record.brief?.overview ?? record.summary ?? record.stage;
    return <button key={record.id} className={`task-record-row${legacy ? " is-legacy" : ""}${singleObjective ? " is-single-objective" : ""}`} onClick={() => onOpen(record)}>
      <span className={`task-record-status is-${status.tone}`}><i />{status.label}</span>
      <span className="task-record-meta"><small>{field?.name ?? "已归档地块"}</small><time dateTime={record.createdAt}>{formatDateTime(record.createdAt)}</time></span>
          <strong>{singleObjective ? record.brief?.headline ?? recordSummary : objectiveLabel}</strong>
      {!singleObjective ? <p>{recordSummary}</p> : null}
      <CaretRight className="task-record-caret" size={14} />
    </button>;
  }) : null}</div>;
}

function FieldScoutingView({ notes, focusedNoteId, onFocusNote, onAdd, onAnalyzeNote }: { notes: FieldScoutingNote[]; focusedNoteId: string | null; onFocusNote: (noteId: string) => void; onAdd: () => void; onAnalyzeNote: (note: FieldScoutingNote) => void }) {
  return <div className="panel-scroll-new field-scouting-view">
    <section className="field-scouting-head">
      <div><h3>巡田记录</h3><span>{notes.length ? `${notes.length} 条` : "暂无记录"}</span></div>
      <button className="drawer-primary" onClick={onAdd}><Plus size={16} />记录</button>
    </section>
    {notes.length ? <section className="field-scouting-list">{notes.map((note) => <article key={note.id} className={note.id === focusedNoteId ? "is-focused" : ""}>
      <button className="field-scouting-focus" onClick={() => onFocusNote(note.id)}>
        <span className="field-scouting-pin"><MapPin size={16} weight="fill" /></span>
        <span><time dateTime={note.observedAt}>{formatLongDate(note.observedAt)}</time><strong>{inspectionConditionSummary(note)}</strong>{note.note ? <small>{note.note}</small> : null}<code>{note.location.longitude.toFixed(4)}°, {note.location.latitude.toFixed(4)}°</code></span>
      </button>
      <button className="field-scouting-analyze" onClick={() => onAnalyzeNote(note)}><Sparkle size={14} />结合这条分析</button>
    </article>)}</section> : <section className="field-scouting-empty"><MapPin size={24} /><strong>暂无巡田记录</strong></section>}
  </div>;
}

function VariableNitrogenView({ field, options, prescriptions, loading, onZonesChange, onViewMap, onStartGrowth, onSaved }: { field: FieldSummary; options: VariableNitrogenSourceOption[]; prescriptions: VariableNitrogenPrescription[]; loading: boolean; onZonesChange: (zones: VariableNitrogenZone[]) => void; onViewMap: () => void; onStartGrowth: () => void; onSaved: (prescription: VariableNitrogenPrescription) => void }) {
  const [sourceTaskId, setSourceTaskId] = useState("");
  const [fertilizerName, setFertilizerName] = useState("");
  const [nitrogenPercent, setNitrogenPercent] = useState("");
  const [standardRate, setStandardRate] = useState("");
  const [rates, setRates] = useState<Record<NitrogenManagementLevel, string>>({ low: "", medium: "", high: "" });
  const [ratesTouched, setRatesTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setLocalError] = useState<string | null>(null);
  useEffect(() => {
    if (!sourceTaskId && options[0]) setSourceTaskId(options[0].sourceTaskId);
  }, [options, sourceTaskId]);
  const source = options.find((option) => option.sourceTaskId === sourceTaskId) ?? options[0] ?? null;
  const nitrogenRatio = Math.max(0, Number(nitrogenPercent) || 0) / 100;
  const previewZones = useMemo<VariableNitrogenZone[]>(() => source ? source.zones.map((zone) => {
    const productRateKgHa = Math.max(0, Number(rates[zone.level]) || 0);
    return {
      ...zone,
      productRateKgHa,
      nitrogenRateKgHa: productRateKgHa * nitrogenRatio,
      totalProductKg: zone.areaHa * productRateKgHa,
      totalNitrogenKg: zone.areaHa * productRateKgHa * nitrogenRatio,
    };
  }) : [], [nitrogenRatio, rates, source]);
  useEffect(() => {
    onZonesChange(previewZones);
    return () => onZonesChange([]);
  }, [onZonesChange, previewZones]);
  const totalArea = previewZones.reduce((total, zone) => total + zone.areaHa, 0);
  const totalProduct = previewZones.reduce((total, zone) => total + zone.totalProductKg, 0);
  const totalNitrogen = previewZones.reduce((total, zone) => total + zone.totalNitrogenKg, 0);
  const uniformProduct = totalArea * (Number(standardRate) || 0);
  const canSave = Boolean(source && fertilizerName.trim() && Number(nitrogenPercent) > 0 && Number(nitrogenPercent) <= 100 && standardRate !== "" && Object.values(rates).every((value) => value !== ""));
  const updateStandardRate = (value: string) => {
    setStandardRate(value);
    if (!ratesTouched) setRates({ low: value, medium: value, high: value });
  };
  const save = async () => {
    if (!source || !canSave || saving) return;
    setSaving(true);
    setLocalError(null);
    try {
      const prescription = await createNitrogenPrescription(field.id, {
        sourceTaskId: source.sourceTaskId,
        sourceDate: source.sourceDate,
        fertilizerName,
        nitrogenPercent: Number(nitrogenPercent),
        standardRateKgHa: Number(standardRate),
        rates: { low: Number(rates.low), medium: Number(rates.medium), high: Number(rates.high) },
      });
      onSaved(prescription);
    } catch (reason) {
      setLocalError(reason instanceof Error ? reason.message : "候选处方保存失败。");
    } finally {
      setSaving(false);
    }
  };
  if (loading) return <div className="panel-scroll-new nitrogen-prescription-view"><div className="nitrogen-loading"><i /><span>正在读取管理分区</span></div></div>;
  if (!options.length) return <div className="panel-scroll-new nitrogen-prescription-view"><section className="nitrogen-heading"><h3>施氮方案</h3><p>基于已有长势分区设置各区施用量，保存后进入农艺复核。</p></section><section className="nitrogen-empty"><Leaf size={26} /><strong>需要先生成长势分区</strong><span>完成一次长势巡检后，再回来设置施用量。</span><button onClick={onStartGrowth}>去检查长势</button></section></div>;
  return <div className="panel-scroll-new nitrogen-prescription-view">
    <section className="nitrogen-heading"><h3>施氮方案</h3><p>选分区、填用量、保存候选方案。系统不自动推荐剂量。</p></section>
    <section className="nitrogen-source-row">
      <label><span>影像日期</span><select value={source?.sourceTaskId ?? ""} onChange={(event) => setSourceTaskId(event.target.value)}>{options.map((option) => <option key={option.sourceTaskId} value={option.sourceTaskId}>{formatLongDate(option.sourceDate)}</option>)}</select></label>
      <div className="nitrogen-source-actions"><small>NDVI {source?.meanNdvi.toFixed(3)}</small><button onClick={onViewMap}><MapPin size={14} weight="fill" />查看分区地图</button></div>
    </section>
    <section className="nitrogen-input-grid">
      <label className="is-wide"><span>肥料</span><input value={fertilizerName} maxLength={80} placeholder="例如：尿素" onChange={(event) => setFertilizerName(event.target.value)} /></label>
      <label><span>含氮率</span><div><input type="number" min="0.1" max="100" step="0.1" value={nitrogenPercent} onChange={(event) => setNitrogenPercent(event.target.value)} /><em>%</em></div></label>
      <label><span>常规用量</span><div><input type="number" min="0" max="2000" step="1" value={standardRate} onChange={(event) => updateStandardRate(event.target.value)} /><em>kg/ha</em></div></label>
    </section>
    <section className="nitrogen-zone-editor">
      <header><span>管理区</span><span>面积</span><span>施用量</span></header>
      {previewZones.map((zone) => <label key={zone.level} className={`is-${zone.level}`}>
        <span><i /><strong>{zone.label}</strong><small>NDVI {zone.meanNdvi.toFixed(3)}</small></span>
        <b>{zone.areaHa.toFixed(2)} ha</b>
        <div><input aria-label={`${zone.label}施用量`} type="number" min="0" max="2000" step="1" value={rates[zone.level]} onChange={(event) => { setRatesTouched(true); setRates((current) => ({ ...current, [zone.level]: event.target.value })); }} /><em>kg/ha</em></div>
      </label>)}
    </section>
    <section className="nitrogen-summary">
      <div><span>肥料总量</span><strong>{totalProduct.toFixed(1)} <small>kg</small></strong></div>
      <div><span>折纯氮</span><strong>{totalNitrogen.toFixed(1)} <small>kg</small></strong></div>
      <div><span>较均匀施用</span><strong className={totalProduct - uniformProduct > 0 ? "is-more" : ""}>{formatSignedKg(totalProduct - uniformProduct)}</strong></div>
    </section>
    {error ? <p className="field-error">{error}</p> : null}
    <button className="drawer-primary nitrogen-save" disabled={!canSave || saving} onClick={() => void save()}>{saving ? "正在保存" : "保存候选方案"}</button>
    {prescriptions.length ? <section className="nitrogen-history"><header><h3>候选方案</h3><span>{prescriptions.length} 个</span></header>{prescriptions.slice(0, 4).map((prescription) => <article key={prescription.id}>
      <button onClick={() => onZonesChange(prescription.zones)}><span><strong>{prescription.fertilizerName}</strong><small>{formatLongDate(prescription.sourceDate)} · {prescription.totalProductKg.toFixed(1)} kg</small></span><em>待农艺复核</em></button>
      <a href={nitrogenPrescriptionExportUrl(prescription.id)} download>导出 GeoJSON</a>
    </article>)}</section> : null}
  </div>;
}

function formatSignedKg(value: number): string {
  if (Math.abs(value) < 0.05) return "0.0 kg";
  return `${value > 0 ? "+" : ""}${value.toFixed(1)} kg`;
}

type FieldStatusSource = "optical" | "radar" | "terrain" | "weather" | "soil";

function FieldStatusView({ field, layers, charts, selected, loading, error, onSelectLayer, onClearMap, onViewMap, onAnalyzeDate, onOpenData }: { field: FieldSummary; layers: MapVisualizationLayer[]; charts: ChartArtifact[]; selected: MapVisualizationLayer | null; loading: boolean; error: string | null; onSelectLayer: (layer: MapVisualizationLayer) => void; onClearMap: () => void; onViewMap: (layer: MapVisualizationLayer) => void; onAnalyzeDate: (date: string, objective?: AnalysisObjective) => void; onOpenData: () => void }) {
  const [source, setSource] = useState<FieldStatusSource>(() => fieldStatusSource(selected?.source));
  useEffect(() => {
    setSource("optical");
  }, [field.id]);
  useEffect(() => {
    if (selected) setSource(fieldStatusSource(selected.source));
  }, [selected?.source]);

  const selectSource = (nextSource: FieldStatusSource) => {
    setSource(nextSource);
    const layerSource = nextSource === "optical" ? "sentinel-2" : nextSource === "radar" ? "sentinel-1" : nextSource === "terrain" ? "copernicus-dem" : null;
    if (!layerSource) {
      onClearMap();
      return;
    }
    const candidates = layers.filter((layer) => layer.source === layerSource).sort((left, right) => right.date.localeCompare(left.date));
    const preferredMetric = nextSource === "optical" ? "ndvi_contrast" : nextSource === "radar" ? "vv" : "elevation";
    const latestDate = candidates[0]?.date;
    const preferred = candidates.find((layer) => layer.date === latestDate && layer.metric === preferredMetric) ?? candidates[0];
    if (preferred) onSelectLayer(preferred);
  };

  return <div className="field-status-shell">
    <nav className="field-status-source-tabs" aria-label="田况数据来源">
      {(["optical", "radar", "terrain", "weather", "soil"] as FieldStatusSource[]).map((item) => <button key={item} className={source === item ? "is-active" : ""} onClick={() => selectSource(item)}><span>{fieldStatusSourceLabel(item)}</span></button>)}
    </nav>
    {source === "optical" ? <OpticalFieldStatusView field={field} layers={layers} charts={charts} selected={selected} loading={loading} error={error} onSelectLayer={onSelectLayer} onViewMap={onViewMap} onAnalyzeDate={onAnalyzeDate} onOpenData={onOpenData} /> : null}
    {source === "radar" ? <RasterFieldStatusView kind="radar" layers={layers.filter((layer) => layer.source === "sentinel-1")} selected={selected} loading={loading} onSelectLayer={onSelectLayer} onViewMap={onViewMap} onAnalyzeDate={onAnalyzeDate} onOpenData={onOpenData} /> : null}
    {source === "terrain" ? <RasterFieldStatusView kind="terrain" layers={layers.filter((layer) => layer.source === "copernicus-dem")} selected={selected} loading={loading} onSelectLayer={onSelectLayer} onViewMap={onViewMap} onAnalyzeDate={onAnalyzeDate} onOpenData={onOpenData} /> : null}
    {source === "weather" ? <ContextFieldStatusView kind="weather" charts={charts.filter((artifact) => artifact.chart.source === "era5-land" || artifact.chart.source === "ecmwf-ifs")} onOpenData={onOpenData} /> : null}
    {source === "soil" ? <ContextFieldStatusView kind="soil" charts={charts.filter((artifact) => artifact.chart.source === "soilgrids-250m")} onOpenData={onOpenData} /> : null}
  </div>;
}

function OpticalFieldStatusView({ field, layers, charts, selected, loading, error, onSelectLayer, onViewMap, onAnalyzeDate, onOpenData }: { field: FieldSummary; layers: MapVisualizationLayer[]; charts: ChartArtifact[]; selected: MapVisualizationLayer | null; loading: boolean; error: string | null; onSelectLayer: (layer: MapVisualizationLayer) => void; onViewMap: (layer: MapVisualizationLayer) => void; onAnalyzeDate: (date: string, objective?: AnalysisObjective) => void; onOpenData: () => void }) {
  const opticalLayers = layers.filter((layer) => layer.source === "sentinel-2" && layer.date !== "static");
  const dates = [...new Set(opticalLayers.map((layer) => layer.date))].sort((left, right) => right.localeCompare(left));
  const activeDate = selected?.source === "sentinel-2" && dates.includes(selected.date) ? selected.date : dates[0] ?? null;
  const dateLayers = activeDate ? opticalLayers.filter((layer) => layer.date === activeDate) : [];
  const activeLayer = selected?.source === "sentinel-2" && selected.date === activeDate
    ? selected
    : dateLayers.find((layer) => layer.metric === "ndvi_contrast") ?? dateLayers.find((layer) => layer.metric === "ndvi") ?? dateLayers[0] ?? null;
  const ndviChart = charts.find((artifact) => artifact.chart.source === "sentinel-2" && artifact.chart.title === "NDVI 时序");
  const ndviPoints = ndviChart?.chart.series[0]?.points ?? [];
  const currentPoint = activeDate ? ndviPoints.find((point) => point.label === activeDate) ?? null : null;
  const previousPoint = currentPoint ? ndviPoints.at(Math.max(0, ndviPoints.findIndex((point) => point.label === currentPoint.label) - 1)) ?? null : null;
  const change = currentPoint && previousPoint && currentPoint.label !== previousPoint.label ? currentPoint.value - previousPoint.value : null;
  const ageDays = activeDate ? calendarDayDifference(activeDate, todayCalendarDate()) : null;
  const historical = ageDays !== null && ageDays > 21;

  if (loading) return <div className="panel-scroll-new field-status-view"><div className="field-status-skeleton"><i /><i /><i /></div></div>;
  if (!activeDate || !activeLayer) return <div className="panel-scroll-new field-status-view"><section className="field-status-empty"><Stack size={26} /><strong>{error ? "田况图层加载失败" : "还没有可显示的田况"}</strong><p>{error ?? "完成 Sentinel-2 数据采集与光学处理后，这里会自动出现最近影像、指数图层和季节变化。"}</p><button className="secondary-button" onClick={onOpenData}><Database size={16} />查看数据采集</button></section></div>;

  const metricOrder = ["true_color", "ndvi", "ndvi_contrast", "ndre", "reci", "msavi", "ndmi", "ndwi"];
  const orderedLayers = [...dateLayers].sort((left, right) => metricOrder.indexOf(left.metric) - metricOrder.indexOf(right.metric));
  const changeLabel = change === null ? "等待下一期" : `较上期 ${change >= 0 ? "+" : ""}${change.toFixed(3)}`;
  return <div className="panel-scroll-new field-status-view">
    <section className="field-status-head">
      <div><span>{historical ? "最近可用" : "当前田况"}</span><h3>{formatLongDate(activeDate)}</h3><p>{currentPoint ? `NDVI ${currentPoint.value.toFixed(3)} · ${changeLabel}` : activeLayer.label}</p></div>
      <button title="在地图中查看当前图层" onClick={() => onViewMap(activeLayer)}><Stack size={18} /><span>查看地图</span></button>
    </section>

    <section className="field-status-section">
      <header><div><h4>日期</h4><span>{dates.length} 期</span></div></header>
      <div className="field-status-dates">{dates.map((date) => <button key={date} className={date === activeDate ? "is-active" : ""} onClick={() => {
        const next = opticalLayers.find((layer) => layer.date === date && layer.metric === activeLayer.metric)
          ?? opticalLayers.find((layer) => layer.date === date && layer.metric === "ndvi_contrast")
          ?? opticalLayers.find((layer) => layer.date === date);
        if (next) onSelectLayer(next);
      }}><time dateTime={date}>{compactMapDate(date)}</time><small>{date === dates[0] ? "最近" : ""}</small></button>)}</div>
    </section>

    <section className="field-status-section">
      <header><div><h4>图层</h4><span>{activeLayer.label}</span></div></header>
      <div className="field-status-layers">{orderedLayers.map((layer) => <button key={layer.ref} className={layer.ref === activeLayer.ref ? "is-active" : ""} onClick={() => onSelectLayer(layer)}><i className={`visualization-gradient is-${layer.metric}`} /><span><strong>{layer.label}</strong><small>{fieldLayerPurpose(layer.metric)}</small></span></button>)}</div>
    </section>

    {ndviPoints.length ? <FieldSeasonTrend points={ndviPoints} activeDate={activeDate} onSelectDate={(date) => {
      const next = opticalLayers.find((layer) => layer.date === date && layer.metric === activeLayer.metric)
        ?? opticalLayers.find((layer) => layer.date === date && layer.metric === "ndvi_contrast")
        ?? opticalLayers.find((layer) => layer.date === date);
      if (next) onSelectLayer(next);
    }} /> : null}

    <section className="field-status-action">
      <div><span>农情 Agent</span><strong>分析 {formatShortDate(activeDate)} 田况</strong></div>
      <button className="drawer-primary" onClick={() => onAnalyzeDate(activeDate)}><Sparkle size={17} weight="fill" />开始分析</button>
    </section>
  </div>;
}

function RasterFieldStatusView({ kind, layers, selected, loading, onSelectLayer, onViewMap, onAnalyzeDate, onOpenData }: { kind: "radar" | "terrain"; layers: MapVisualizationLayer[]; selected: MapVisualizationLayer | null; loading: boolean; onSelectLayer: (layer: MapVisualizationLayer) => void; onViewMap: (layer: MapVisualizationLayer) => void; onAnalyzeDate: (date: string, objective?: AnalysisObjective) => void; onOpenData: () => void }) {
  const dates = [...new Set(layers.map((layer) => layer.date))].sort((left, right) => right.localeCompare(left));
  const selectedInSource = selected && layers.some((layer) => layer.ref === selected.ref) ? selected : null;
  const activeDate = selectedInSource?.date ?? dates[0] ?? null;
  const dateLayers = activeDate ? layers.filter((layer) => layer.date === activeDate) : [];
  const activeLayer = selectedInSource && selectedInSource.date === activeDate ? selectedInSource : dateLayers[0] ?? null;
  const title = kind === "radar" ? "雷达观测" : "地形背景";

  if (loading) return <div className="panel-scroll-new field-status-view"><div className="field-status-skeleton"><i /><i /><i /></div></div>;
  if (!activeDate || !activeLayer) return <FieldStatusSourceEmpty title={`还没有${title}`} detail={kind === "radar" ? "完成 Sentinel-1 处理后，这里会出现 VV、VH 和日期变化图层。" : "完成 Copernicus DEM 处理后，这里会出现高程、坡度和相对低洼图层。"} onOpenData={onOpenData} />;

  return <div className="panel-scroll-new field-status-view">
    <section className="field-status-head">
      <div><span>{title}</span><h3>{kind === "radar" ? formatLongDate(activeDate) : "Copernicus DEM"}</h3><p>{activeLayer.label} · {activeLayer.resolutionMeters.toFixed(0)} 米</p></div>
      <button title="在地图中查看当前图层" onClick={() => onViewMap(activeLayer)}><Stack size={18} /><span>查看地图</span></button>
    </section>
    {kind === "radar" ? <section className="field-status-section"><header><div><h4>日期</h4><span>{dates.length} 期</span></div></header><div className="field-status-dates">{dates.map((date) => <button key={date} className={date === activeDate ? "is-active" : ""} onClick={() => {
      const next = layers.find((layer) => layer.date === date && layer.metric === activeLayer.metric) ?? layers.find((layer) => layer.date === date);
      if (next) onSelectLayer(next);
    }}><time dateTime={date}>{compactMapDate(date)}</time><small>{date === dates[0] ? "最近" : ""}</small></button>)}</div></section> : null}
    <section className="field-status-section"><header><div><h4>图层</h4><span>{activeLayer.label}</span></div></header><div className="field-status-layers">{dateLayers.map((layer) => <button key={layer.ref} className={layer.ref === activeLayer.ref ? "is-active" : ""} onClick={() => onSelectLayer(layer)}><i className={`visualization-gradient is-${layer.metric}`} /><span><strong>{layer.label}</strong><small>{fieldLayerPurpose(layer.metric)}</small></span></button>)}</div></section>
    {kind === "radar" ? <section className="field-status-action"><div><span>农情 Agent</span><strong>检查 {formatShortDate(activeDate)} 的积水变化</strong></div><button className="drawer-primary" onClick={() => onAnalyzeDate(activeDate, "waterlogging_detection")}><Sparkle size={17} weight="fill" />识别积水</button></section> : null}
  </div>;
}

function ContextFieldStatusView({ kind, charts, onOpenData }: { kind: "weather" | "soil"; charts: ChartArtifact[]; onOpenData: () => void }) {
  const title = kind === "weather" ? "天气背景" : "土壤背景";
  if (!charts.length) return <FieldStatusSourceEmpty title={`还没有${title}`} detail={kind === "weather" ? "完成 ERA5-Land 或 ECMWF IFS 处理后，这里会出现降雨和温度图表。" : "完成 SoilGrids 处理后，这里会出现不同深度的土壤属性背景。"} onOpenData={onOpenData} />;
  return <div className="panel-scroll-new field-status-view field-context-view"><section className="field-context-head"><span>{title}</span><h3>{kind === "weather" ? "温度与降雨" : "土壤属性"}</h3></section><AnalysisCharts artifacts={charts} /></div>;
}

function FieldStatusSourceEmpty({ title, detail, onOpenData }: { title: string; detail: string; onOpenData: () => void }) {
  return <div className="panel-scroll-new field-status-view"><section className="field-status-empty"><Stack size={26} /><strong>{title}</strong><p>{detail}</p><button className="secondary-button" onClick={onOpenData}><Database size={16} />查看数据采集</button></section></div>;
}

function fieldStatusSource(source: string | undefined): FieldStatusSource {
  if (source === "sentinel-1") return "radar";
  if (source === "copernicus-dem") return "terrain";
  return "optical";
}

function fieldStatusSourceLabel(source: FieldStatusSource): string {
  if (source === "optical") return "光学";
  if (source === "radar") return "雷达";
  if (source === "terrain") return "地形";
  if (source === "weather") return "天气";
  return "土壤";
}

function FieldSeasonTrend({ points, activeDate, onSelectDate }: { points: Array<{ label: string; value: number }>; activeDate: string; onSelectDate: (date: string) => void }) {
  const values = points.map((point) => point.value);
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const range = Math.max(maximum - minimum, 0.001);
  return <section className="field-status-section field-season-trend" aria-label="本季 NDVI 变化">
    <header><div><h4>本季 NDVI</h4><span>{points.length > 1 ? `${formatShortDate(points[0]!.label)} 至 ${formatShortDate(points.at(-1)!.label)}` : "等待后续观测"}</span></div></header>
    <div>{points.map((point) => <button key={point.label} className={point.label === activeDate ? "is-active" : ""} title={`${point.label} · ${point.value.toFixed(3)}`} aria-label={`查看 ${formatShortDate(point.label)} 田况，NDVI ${point.value.toFixed(3)}`} onClick={() => onSelectDate(point.label)}><i style={{ transform: `scaleY(${0.25 + (point.value - minimum) / range * 0.75})` }} /><small>{compactMapDate(point.label)}</small></button>)}</div>
  </section>;
}

function fieldLayerPurpose(metric: string): string {
  if (metric === "true_color") return "卫星实景";
  if (metric === "ndvi") return "植被长势";
  if (metric === "ndvi_contrast") return "田内差异";
  if (metric === "ndre") return "红边响应";
  if (metric === "reci") return "叶绿素表现";
  if (metric === "msavi") return "稀疏冠层";
  if (metric === "ndmi") return "冠层水分";
  if (metric === "ndwi") return "表面水分";
  if (metric === "vv") return "同极化散射";
  if (metric === "vh") return "交叉极化散射";
  if (metric === "radar_change") return "日期变化";
  if (metric === "elevation") return "地表高程";
  if (metric === "slope") return "坡度";
  if (metric === "lowland") return "相对低洼";
  return "遥感观测";
}

function calendarDayDifference(from: string, to: string): number | null {
  const start = Date.parse(`${from}T12:00:00Z`);
  const end = Date.parse(`${to}T12:00:00Z`);
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, Math.round((end - start) / 86_400_000)) : null;
}

function todayCalendarDate(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

function FieldDetails({ field, onEdit, onArchive }: { field: FieldSummary; onEdit: () => void; onArchive: () => void }) {
  return <div className="panel-scroll-new field-details">
    <section className="detail-season"><div><span>{field.seasonYear} 种植季</span><strong>{cropName(field.crop)}</strong><p>{field.plantingDate ? `${formatLongDate(field.plantingDate)}播种` : "播种日期未记录"}</p></div><StatusDot status={field.latestStatus} /></section>
    <dl className="detail-profile" aria-label="地块基本属性">
      <div><dt>面积</dt><dd>{field.areaHa.toFixed(2)} 公顷</dd></div>
      <div><dt>品种</dt><dd>{field.variety ?? "未记录"}</dd></div>
      <div><dt>编号</dt><dd>{field.code || "未生成"}</dd></div>
    </dl>
    <section className="detail-management"><div className="detail-actions"><button className="detail-edit" onClick={onEdit}><PencilSimple size={18} />编辑档案</button><button className="detail-archive" title="归档地块" aria-label="归档地块" onClick={onArchive}><Archive size={18} /></button></div></section>
  </div>;
}

function FieldDataView({ acquisition, loading, targetDate, matches, matchesLoading, onTargetDateChange, onRefresh, onOpenSource }: { acquisition: DataAcquisitionRun | null; loading: boolean; targetDate: string; matches: AcquisitionDateMatch[]; matchesLoading: boolean; onTargetDateChange: (date: string) => void; onRefresh: () => void; onOpenSource: (source: DataSource) => void }) {
  const rows = fieldDataSources.map((source) => ({
    ...source,
    result: acquisition?.sources.find((result) => result.source === source.source) ?? null,
    progress: acquisition?.progress?.find((item) => item.source === source.source) ?? null,
  }));
  const collecting = loading || acquisition?.status === "running";
  const { sourceCount: activeSourceCount, finishedCount, fraction } = acquisitionProgressSummary(acquisition, rows.length);
  return <div className="panel-scroll-new field-data-view">
    <section className="data-view-intro"><div><span>{collecting ? `正在更新 ${finishedCount}/${activeSourceCount}` : `${rows.length} 类数据`}</span><button className={collecting ? "is-loading" : ""} title="更新地块数据" aria-label="更新地块数据" disabled={collecting} onClick={onRefresh}><ArrowClockwise size={15} /></button></div>{collecting ? <div className="acquisition-progress" aria-label={`已结束 ${finishedCount} 个来源，共 ${activeSourceCount} 个`}><i style={{ transform: `scaleX(${fraction})` }} /></div> : null}</section>
    <section className="data-source-list" aria-label="地块数据清单"><header><span>{collecting ? "下载过程" : "目标日期"}</span>{collecting ? <span>当前阶段</span> : <label className="data-date-picker"><input aria-label="选择数据日期" title="选择数据日期" type="date" value={targetDate} max={todayCalendarDate()} onChange={(event) => onTargetDateChange(event.target.value)} /></label>}</header>{rows.map((source) => <DataSourceRow key={source.code} source={source} collecting={collecting && Boolean(source.progress)} matching={matchesLoading} match={matches.find((match) => match.source === source.source) ?? null} onOpen={() => onOpenSource(source.source)} />)}</section>
  </div>;
}

function DataSourceRow({ source, collecting, matching, match, onOpen }: { source: typeof fieldDataSources[number] & { result: SourceAcquisitionResult | null; progress: DataAcquisitionRun["progress"][number] | null }; collecting: boolean; matching: boolean; match: AcquisitionDateMatch | null; onOpen: () => void }) {
  const result = source.result;
  const dates = result?.selectedObservationDates.length ? result.selectedObservationDates : result?.availableDates ?? [];
  const stage = source.progress?.stage ?? (collecting ? "queued" : result ? result.status === "failed" ? "failed" : "completed" : null);
  const detail = source.progress?.message ?? (result ? sourceStatusText(result, dates.length) : collecting ? "等待开始" : "暂无采集记录");
  const primary = collecting ? acquisitionStageText(stage) : matching ? "匹配中" : dataMatchPrimary(match);
  const secondary = collecting ? detail : matching ? "正在查找附近数据" : dataMatchDetail(match);
  return <button className={`data-source-row ${stage ? `is-${stage}` : ""}`} onClick={onOpen}><span className="data-source-code">{source.code}</span><span className="data-source-name"><strong>{source.type}</strong></span><span className="data-source-time"><time dateTime={!collecting && !matching && match?.matchedDate ? match.matchedDate : undefined}>{primary}</time><small className={!collecting && !matching && match ? `match-status-${match.status}` : result ? `source-status-${result.status}` : ""}>{secondary}</small></span><CaretRight size={15} /></button>;
}

function dataMatchPrimary(match: AcquisitionDateMatch | null): string {
  if (!match) return "匹配中";
  if (match.matchType === "static") return "当前版本";
  if (!match.matchedDate) return "未找到";
  return match.matchedDate;
}

function dataMatchDetail(match: AcquisitionDateMatch | null): string {
  if (!match) return "正在查找附近数据";
  if (match.matchType === "nearest" && match.offsetDays !== null) {
    const offset = match.offsetDays === 0 ? "同日" : match.offsetDays < 0 ? `早 ${Math.abs(match.offsetDays)} 天` : `晚 ${match.offsetDays} 天`;
    return `${offset} · ${matchStatusText(match.status)}`;
  }
  if (match.matchType === "covering") return `覆盖目标日 · ${matchStatusText(match.status)}`;
  if (match.matchType === "static") return matchStatusText(match.status);
  return match.detail;
}

function matchStatusText(status: AcquisitionDateMatch["status"]): string {
  return status === "retrieved" ? "已下载" : status === "available" ? "可获取" : status === "limited" ? "质量受限" : status === "failed" ? "获取失败" : "暂无数据";
}

function DataSourceHistoryView({ source, runs, loading, visualizations, charts, onOpenMapLayers, onBack }: { source: DataSource; runs: DataAcquisitionRun[]; loading: boolean; visualizations: MapVisualizationLayer[]; charts: ChartArtifact[]; onOpenMapLayers: (layer: MapVisualizationLayer) => void; onBack: () => void }) {
  const definition = fieldDataSources.find((item) => item.source === source)!;
  const dynamic = source === "sentinel-2" || source === "sentinel-1" || source === "era5-land" || source === "ecmwf-ifs";
  const observations = dynamic ? sourceObservationHistory(source, runs) : [];
  const versions = dynamic ? [] : sourceVersionHistory(source, runs);
  const downloadedVersionCount = new Set(versions.filter((item) => item.state === "retrieved" || item.state === "limited").map((item) => item.label)).size;
  return <div className="panel-scroll-new source-history-view">
    <button className="data-back-button" onClick={onBack}><CaretLeft size={15} />返回数据目录</button>
    <section className="source-history-head"><span className="data-source-code">{definition.code}</span><div><h3>{definition.type}</h3><p>{definition.provider}</p></div>{visualizations[0] ? <button className="source-visualization-action" onClick={() => onOpenMapLayers(visualizations[0]!)}><Stack size={15} />查看图层</button> : null}</section>
    <section className="source-history-summary"><strong>{loading ? "读取中" : dynamic ? `${observations.length} 个日期` : `${downloadedVersionCount} 个已下载版本`}</strong></section>
    {charts.length ? <details className="source-chart-disclosure"><summary><span>指标趋势</span><b>{charts.length} 项</b></summary><AnalysisCharts artifacts={charts} /></details> : null}
    {loading ? <div className="source-history-empty">正在读取历史采集记录</div> : null}
    {!loading && dynamic && observations.length === 0 ? <div className="source-history-empty">还没有发现该来源的历史日期</div> : null}
    {!loading && !dynamic && versions.length === 0 ? <div className="source-history-empty">还没有登记该来源的数据版本</div> : null}
    {!loading && dynamic ? <section className="observation-list" aria-label={`${definition.type}日期列表`}>{observations.map((item) => <article key={item.date}><time dateTime={item.date}>{formatLongDate(item.date)}</time><span className={`observation-state is-${item.state}`}>{observationStateText(item.state)}</span><p>{item.detail}</p></article>)}</section> : null}
    {!loading && !dynamic ? <section className="observation-list" aria-label={`${definition.type}版本列表`}>{versions.map((item) => <article key={item.runId}><time dateTime={item.runAt}>{item.label}</time><span className={`observation-state is-${item.state}`}>{observationStateText(item.state)}</span><p>{item.detail}</p></article>)}</section> : null}
  </div>;
}

type ObservationState = "retrieved" | "available" | "limited" | "failed";
interface ObservationHistoryItem { date: string; state: ObservationState; detail: string; runId: string; runAt: string }

function sourceObservationHistory(source: DataSource, runs: DataAcquisitionRun[]): ObservationHistoryItem[] {
  const entries = new Map<string, ObservationHistoryItem>();
  for (const run of runs) {
    const result = run.sources.find((item) => item.source === source);
    if (!result) continue;
    const retrievedDates = new Set(result.selectedAssets.filter((asset) => asset.accessStatus === "retrieved").flatMap((asset) => assetDateKeys(asset)));
    const dates = new Set([...result.availableDates, ...result.selectedObservationDates, ...retrievedDates]);
    if (dates.size === 0 && source === "era5-land") {
      for (const asset of result.selectedAssets) for (const date of assetDateKeys(asset)) dates.add(date);
    }
    for (const date of dates) {
      const retrieved = retrievedDates.has(date);
      const opticalValidFraction = retrieved ? opticalSceneValidFraction(result, date) : null;
      const limited = retrieved && (opticalValidFraction !== null ? opticalValidFraction < 0.8 : source !== "sentinel-2" && result.status === "partial");
      const state: ObservationState = limited ? "limited" : retrieved ? "retrieved" : result.status === "failed" ? "failed" : "available";
      const candidate: ObservationHistoryItem = {
        date, state,
        detail: opticalValidFraction !== null
          ? opticalSceneQualityText(opticalValidFraction)
          : retrieved
            ? `${result.selectedAssets.filter((asset) => asset.accessStatus === "retrieved").length} 个文件已保存`
            : result.status === "failed"
              ? sourceFailureText(result)
              : "目录已发现，尚未下载到本地",
        runId: run.id, runAt: run.createdAt,
      };
      const current = entries.get(date);
      if (!current || observationStateRank(candidate.state) > observationStateRank(current.state)) entries.set(date, candidate);
    }
  }
  return [...entries.values()].sort((left, right) => right.date.localeCompare(left.date));
}

function opticalSceneValidFraction(source: SourceAcquisitionResult, date: string): number | null {
  if (source.source !== "sentinel-2") return null;
  const raw = source.quality.metadata.sceneQualityByDate;
  try {
    const scenes = typeof raw === "string" ? JSON.parse(raw) as Record<string, { validPixelFraction?: unknown }> : raw as Record<string, { validPixelFraction?: unknown }> | null;
    const value = scenes?.[date]?.validPixelFraction;
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function opticalSceneQualityText(validFraction: number): string {
  const quality = validFraction >= 0.8 ? "可用" : validFraction >= 0.5 ? "局部可用" : "云影响较重";
  return `地块有效 ${formatPercent(validFraction)} · ${quality}`;
}

function sourceVersionHistory(source: DataSource, runs: DataAcquisitionRun[]) {
  return runs.flatMap((run) => {
    const result = run.sources.find((item) => item.source === source);
    if (!result) return [];
    const retrieved = result.selectedAssets.filter((asset) => asset.accessStatus === "retrieved");
    const state: ObservationState = retrieved.length > 0 ? result.status === "partial" ? "limited" : "retrieved" : result.status === "failed" ? "failed" : "available";
    const version = source === "copernicus-dem" ? String(result.quality.metadata.dataset ?? result.product) : String(result.quality.metadata.version ?? result.product);
    return [{ runId: run.id, runAt: run.createdAt, label: version, state, detail: retrieved.length > 0 ? `${retrieved.length} 个文件已保存` : result.status === "failed" ? sourceFailureText(result) : "已发现版本，尚未下载到本地" }];
  });
}

function assetDateKeys(asset: SourceAcquisitionResult["selectedAssets"][number]): string[] {
  if (asset.capturedAt) return [asset.capturedAt.slice(0, 10)];
  if (asset.validFrom && asset.validTo) return [`${asset.validFrom.slice(0, 10)} 至 ${asset.validTo.slice(0, 10)}`];
  if (asset.generatedAt) return [asset.generatedAt.slice(0, 10)];
  return [];
}

function observationStateRank(state: ObservationState): number { return state === "retrieved" ? 4 : state === "limited" ? 3 : state === "available" ? 2 : 1; }
function observationStateText(state: ObservationState): string { return state === "retrieved" ? "已下载" : state === "limited" ? "质量受限" : state === "available" ? "可获取" : "获取失败"; }
function formatLongDate(value: string): string {
  const parts = value.split(" 至 ");
  const formatter = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric" });
  const formatted = parts.map((part) => {
    const date = new Date(`${part}T12:00:00Z`);
    return Number.isNaN(date.getTime()) ? part : formatter.format(date);
  });
  return formatted.join(" 至 ");
}

function acquisitionStageText(stage: DataAcquisitionRun["progress"][number]["stage"] | null): string {
  if (stage === "discovering") return "检索中";
  if (stage === "downloading") return "下载中";
  if (stage === "validating") return "校验中";
  if (stage === "completed") return "已完成";
  if (stage === "failed") return "未完成";
  return "等待中";
}

function sourceStatusText(source: SourceAcquisitionResult, dateCount: number): string {
  if (source.source === "sentinel-2") {
    const validFraction = metadataNumber(source, "fieldValidPixelFraction");
    if (validFraction !== null) {
      const quality = validFraction >= 0.8 ? "可用" : validFraction >= 0.5 ? "局部可用" : "云影响较重";
      return `地块有效 ${formatPercent(validFraction)} · ${quality}`;
    }
    if (source.selectedAssets.length > 0) return "已下载 · 等待地块 SCL 检查";
  }
  if (source.status === "succeeded") return dateCount > 0 ? `${dateCount} 个可用日期` : "已采集";
  if (source.status === "needs_input") return source.error.message ?? "需要配置访问权限";
  if (source.status === "failed") return sourceFailureText(source);
  if (dateCount > 0) return `${dateCount} 个日期 · ${source.error.message ?? "等待资产"}`;
  return source.error.message ?? source.limitations[0] ?? "部分可用";
}

function sourceFailureText(source: SourceAcquisitionResult): string {
  if (source.error.code === "provider_rate_limited") return "数据服务繁忙，可稍后重试";
  if (source.error.code === "provider_unauthorized") return "数据来源尚未授权";
  if (source.error.code === "asset_integrity_failed") return "下载文件校验失败，可重新采集";
  if (source.source === "sentinel-2") return "光学影像获取失败，可稍后重试";
  if (source.source === "sentinel-1") return "雷达影像获取失败，可稍后重试";
  if (source.source === "copernicus-dem") return "地形数据获取失败，可稍后重试";
  if (source.source === "ecmwf-ifs") return "天气预报下载失败，可稍后重试";
  if (source.source === "soilgrids-250m") return "土壤背景下载失败，可稍后重试";
  return "数据获取失败，可稍后重试";
}

function metadataNumber(source: SourceAcquisitionResult, key: string): number | null {
  const value = source.quality.metadata[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function objectiveName(objective: AnalysisObjective): string {
  return objectives.find((item) => item.value === objective)?.label ?? "农情分析";
}

function TaskProgress({ field, task, agentRun, surface }: { field: FieldSummary; task: AnalysisTask; agentRun: AgentRunTrace | null; surface: TaskSurface }) {
  const liveSteps = agentRun
    ? agentRun.tools.length
      ? agentRun.tools.map((tool) => ({ id: tool.toolCallId, label: agentToolLabel(tool.toolName), status: tool.status }))
      : null
    : null;
  const fallbackThresholds = [10, 35, 65, 90];
  const activeFallbackStep = fallbackThresholds.findIndex((threshold) => task.progress < threshold);
  const fallbackSteps = analysisProgressSteps(task.objective).map((label, index) => ({
    id: label,
    label,
    status: task.progress >= (fallbackThresholds[index] ?? 100)
      ? "completed" as const
      : index === (activeFallbackStep < 0 ? fallbackThresholds.length - 1 : activeFallbackStep)
        ? "running" as const
        : "pending" as const,
  }));
  const steps = liveSteps ?? fallbackSteps;
  const currentStep = task.stage || [...steps].reverse().find((step) => step.status === "running")?.label || "正在分析";
  const completedStepCount = steps.filter((step) => step.status === "completed").length;
  const stepList = <div className="step-list">{steps.map((step) => <div key={step.id} className={`is-${step.status}`}>
    {step.status === "failed" ? <WarningCircle size={19} weight="fill" /> : <CheckCircle size={19} weight={step.status === "completed" ? "fill" : "regular"} />}
    <span>{step.label}</span>
    {liveSteps && step.status !== "pending" ? <small>{agentToolStatusLabel(step.status)}</small> : null}
  </div>)}</div>;
  return <div className={`panel-scroll-new${surface === "workflow" ? " workflow-progress" : ""}`}>
    {surface === "agent" && task.requestMessage ? <div className="agent-request-bubble"><small>你</small><p>{task.requestMessage}</p></div> : null}
    <div className="progress-block">
      {surface === "agent" ? <div className="progress-orbit"><Leaf size={27} weight="fill" /></div> : <span className="workflow-running-state"><i />正在分析</span>}
      <strong>{surface === "workflow" ? currentStep : `${field.name}正在分析`}</strong>
      {surface === "agent" ? <p>{currentStep}</p> : null}
      {surface === "workflow" ? <div className="progress-meta"><b>{task.progress}%</b></div> : <span>{task.progress}%</span>}
      <div className="progress-track" aria-label={`任务进度 ${task.progress}%`}><i style={{ transform: `scaleX(${task.progress / 100})` }} /></div>
    </div>
    {surface === "workflow" ? <details className="workflow-progress-steps">
      <summary><span>过程</span><small>{completedStepCount}/{steps.length}</small></summary>
      {stepList}
    </details> : stepList}
  </div>;
}

function analysisProgressSteps(objective: AnalysisObjective): string[] {
  if (objective === "water_nitrogen_diagnosis") return ["确认地块和观测日期", "定位田内变化区域", "核对可用支持信息", "给出可能原因与巡查位置"];
  if (objective === "waterlogging_detection") return ["确认目标雷达日期", "寻找同轨前后影像", "结合降雨和地形", "组织积水结果"];
  if (objective === "frost_risk_warning") return ["读取最新天气预报", "估计当前生育期", "定位低洼关注区域", "组织霜冻预警"];
  return ["确认地块和种植季", "读取可用光学影像", "估计生育期和田内差异", "组织长势结果"];
}

function TaskResult({ surface, field, task, acquisition, agentRun, analysisResults, visualizations, charts, scoutingNotes, inspectionPicking, inspectionLocation, onInspectionStart, onInspectionEnd, onScoutingNoteSaved, onFocusFinding, onFollowUpAnalysis, onNewAnalysis, onOpenData, onEditField, onRecordFieldNote, onSelectVisualization }: { surface: TaskSurface; field: FieldSummary; task: AnalysisTask; acquisition: DataAcquisitionRun | null; agentRun: AgentRunTrace | null; analysisResults: AnalysisResult<unknown>[]; visualizations: MapVisualizationLayer[]; charts: ChartArtifact[]; scoutingNotes: FieldScoutingNote[]; inspectionPicking: boolean; inspectionLocation: Position | null; onInspectionStart: () => void; onInspectionEnd: () => void; onScoutingNoteSaved: (note: FieldScoutingNote) => void; onFocusFinding: (findingId: string) => void; onFollowUpAnalysis: (task: AnalysisTask, scoutingNoteIds?: string[], inspectionTaskId?: string) => void; onNewAnalysis: () => void; onOpenData: () => void; onEditField: () => void; onRecordFieldNote: () => void; onSelectVisualization: (layer: MapVisualizationLayer) => void }) {
  const [view, setView] = useState<"overview" | "evidence">("overview");
  const [inspectionTarget, setInspectionTarget] = useState<AnalysisFinding | null>(null);
  const [inspectionDraftLocation, setInspectionDraftLocation] = useState<Position | null>(null);
  const [inspections, setInspections] = useState<FieldInspectionRecord[]>(task.inspections ?? []);
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setView("overview");
    window.requestAnimationFrame(() => scrollRef.current?.scrollTo({ top: 0 }));
  }, [task.id]);
  useEffect(() => setInspections(task.inspections ?? []), [task.id, task.inspections]);
  useEffect(() => {
    if (!inspectionLocation) return;
    const target = inspectionTarget ?? task.findings.find((finding) => finding.findingType === "field_observation") ?? null;
    if (target) {
      setInspectionDraftLocation(inspectionLocation);
      setInspectionTarget(target);
      onInspectionEnd();
    }
  }, [inspectionLocation, inspectionTarget, onInspectionEnd, task.findings, task.objective]);

  if (isLegacyWaterNitrogenTask(task)) return <LegacyTaskResult task={task} onNewAnalysis={onNewAnalysis} />;
  if (view === "evidence") return <TaskEvidence task={task} charts={charts} agentRun={agentRun} onBack={() => setView("overview")} />;

  const status = taskStatusPresentation(task.status);
  const spatialFindings = task.findings.filter((finding) => finding.zone !== null);
  const startInspection = (finding: AnalysisFinding) => {
    const existing = inspections.find((item) => item.findingId === finding.id);
    setInspectionTarget(finding);
    if (existing) {
      setInspectionDraftLocation(existing.location);
      onInspectionEnd();
    } else {
      setInspectionDraftLocation(null);
      onInspectionStart();
    }
  };
  const impactfulLimitation = taskImpactfulLimitation(task);
  const growthObservation = task.objective === "growth_stage_monitoring" ? getGrowthObservation(analysisResults) : null;
  const waterNitrogenObservation = task.objective === "water_nitrogen_diagnosis" ? getWaterNitrogenObservation(analysisResults) : null;
  const waterloggingObservation = task.objective === "waterlogging_detection" ? getWaterloggingObservation(analysisResults) : null;
  const frostObservation = task.objective === "frost_risk_warning" ? getFrostObservation(analysisResults) : null;
  const fieldReport = fieldReportPresentation(analysisResults, visualizations, task.id);
  const datedOpticalLayers = visualizations
    .filter((layer) => layer.taskId === task.id && layer.source === "sentinel-2" && layer.date !== "static")
    .sort((left, right) => right.date.localeCompare(left.date));
  const observationReady = Boolean(growthObservation || waterNitrogenObservation || waterloggingObservation || frostObservation);
  const unavailablePresentation = unavailableTaskPresentation(task);
  const displayStatus = task.status === "needs_review" ? status : growthObservation
    ? growthObservation.observationStatus === "stale"
      ? { label: "历史田况", tone: "partial" as const }
      : growthObservation.trend === "insufficient_timeseries"
        ? { label: "单期观测", tone: "partial" as const }
        : !growthObservation.stage || task.status === "partial"
          ? { label: "受限观测", tone: "partial" as const }
          : status
    : waterNitrogenObservation
    ? waterNitrogenObservationStatus(waterNitrogenObservation, task.status)
    : frostObservation?.risk === "undetermined"
      ? { label: "低温过程已识别", tone: "partial" as const }
    : waterloggingObservation?.status === "radar_change_only"
      ? { label: "雷达观测完成", tone: "partial" as const }
      : observationReady && task.status === "partial" ? { label: "观测完成", tone: "complete" as const } : status;
  const displaySummary = growthObservation
    ? growthObservation.belowAverageZoneCount
      ? `${formatShortDate(growthObservation.latestObservationDate)} · ${growthObservation.stage?.label ?? "当前"}发现 ${growthObservation.belowAverageZoneCount} 个需要关注的区域`
      : `${formatShortDate(growthObservation.latestObservationDate)} · ${growthObservation.stage?.label ?? "当前"}田内长势较均匀`
    : waterNitrogenObservation
    ? `${formatShortDate(waterNitrogenObservation.referenceDate)} · ${waterNitrogenObservation.observation.variationStatus === "visible" ? `${waterNitrogenObservation.zones.length} 个田内相对低值区` : "可用范围内未检出明显田内差异"}`
    : waterloggingObservation
      ? waterloggingObservation.status === "suspected"
        ? `${formatShortDate(waterloggingObservation.beforeDate)} → ${formatShortDate(waterloggingObservation.afterDate)} · 发现 ${waterloggingObservation.zones.length} 个疑似积水区`
        : waterloggingObservation.status === "radar_change_only"
          ? waterloggingObservation.zones.length
            ? `${formatShortDate(waterloggingObservation.beforeDate)} → ${formatShortDate(waterloggingObservation.afterDate)} · 发现 ${waterloggingObservation.zones.length} 个雷达变化区`
            : `${formatShortDate(waterloggingObservation.beforeDate)} → ${formatShortDate(waterloggingObservation.afterDate)} · 未发现明显雷达变化区`
          : `${formatShortDate(waterloggingObservation.beforeDate)} → ${formatShortDate(waterloggingObservation.afterDate)} · ${waterloggingObservation.rainfallMm === null ? "" : `降雨 ${waterloggingObservation.rainfallMm.toFixed(1)} mm，`}未发现疑似积水区`
    : frostObservation
      ? frostObservation.risk === "undetermined"
        ? `${formatForecastRange(frostObservation.forecastWindow)} · 已识别低温过程，风险待补生育期`
        : frostObservation.risk === "normal"
        ? `${formatForecastRange(frostObservation.forecastWindow)} · 暂未触发霜冻风险`
        : `${formatForecastRange(frostObservation.forecastWindow)} · ${frostObservation.risk === "high" ? "高" : "关注"}霜冻风险`
    : unavailablePresentation.title;
  const staleObservation = growthObservation?.observationStatus === "stale" || waterNitrogenObservation?.observationStatus === "stale";
  const staleObservationDate = growthObservation?.observationStatus === "stale" ? growthObservation.latestObservationDate : waterNitrogenObservation?.referenceDate ?? null;
  const selectWaterNitrogenReferenceLayer = () => {
    if (!waterNitrogenObservation) return;
    const layer = datedOpticalLayers.find((item) => item.date === waterNitrogenObservation.referenceDate && item.metric === "ndvi_contrast")
      ?? datedOpticalLayers.find((item) => item.date === waterNitrogenObservation.referenceDate);
    if (layer) onSelectVisualization(layer);
  };
  const beginWaterNitrogenInspection = () => {
    selectWaterNitrogenReferenceLayer();
    const lowTarget = task.findings.find((finding) => finding.findingType === "field_observation" && finding.scoutingRole === "low_value");
    const referenceTarget = task.findings.find((finding) => finding.findingType === "field_observation" && finding.scoutingRole === "reference");
    const nextTarget = [lowTarget, referenceTarget].find((target) => target && !inspections.some((inspection) => inspection.findingId === target.id));
    if (nextTarget) startInspection(nextTarget);
  };
  const waterNitrogenTargets = task.findings.filter((finding) => finding.findingType === "field_observation" && (finding.scoutingRole === "low_value" || finding.scoutingRole === "reference"));
  const waterNitrogenPairComplete = waterNitrogenTargets.length === 2 && waterNitrogenTargets.every((target) => inspections.some((inspection) => inspection.findingId === target.id));
  const nextGeneralInspection = !waterNitrogenObservation
    ? spatialFindings.find((finding) => !inspections.some((inspection) => inspection.findingId === finding.id)) ?? spatialFindings[0] ?? null
    : null;
  const generalInspectionsComplete = Boolean(spatialFindings.length) && spatialFindings.every((finding) => inspections.some((inspection) => inspection.findingId === finding.id));
  const requiresData = !observationReady;
  const primaryAction = workflowPrimaryAction(task);
  const plannedAcquisitionRequest = task.nextActions.find((action) => action.acquisitionRequest)?.acquisitionRequest ?? null;
  const acquiredForTask = acquisitionReadyForRequest(acquisition, plannedAcquisitionRequest);
  const activeInspectionTarget = inspectionTarget?.scoutingRole === "low_value" ? "点击地图中的低值区" : inspectionTarget?.scoutingRole === "reference" ? "点击地块内的正常位置" : "点击要记录的位置";

  return <div ref={scrollRef} className={`panel-scroll-new result-scroll ${surface === "agent" ? "agent-conversation-result" : "workflow-result"}`}>
    {surface === "agent" && task.requestMessage ? <div className="agent-request-bubble"><small>你</small><p>{task.requestMessage}</p></div> : null}
    <article className={surface === "agent" ? "agent-answer-block" : "workflow-result-content"}>
    {surface === "agent"
      ? <header className="agent-answer-head"><span><Sparkle size={15} weight="fill" /></span><strong>农情 Agent</strong><small className={`is-${displayStatus.tone}`}>{displayStatus.label}</small></header>
      : <header className="workflow-result-head"><small className={`is-${displayStatus.tone}`}>{displayStatus.label}</small></header>}
    <section className={`result-hero${staleObservation || (task.status === "partial" && !waterNitrogenObservation) ? " is-partial" : ""}`}>
      <h3>{task.brief?.headline ?? displaySummary}</h3>
      {!waterNitrogenObservation && !observationReady ? <p>{unavailablePresentation.description}</p> : null}
    </section>

    {fieldReport.heroMap || fieldReport.mean !== null || fieldReport.zones.length ? <FieldReportView report={fieldReport} /> : null}

    {task.brief ? <AnalysisBriefView brief={task.brief} /> : null}

    {growthObservation ? <GrowthObservationView observation={growthObservation} trendChart={charts.find((artifact) => artifact.chart.title === "NDVI 时序") ?? null} /> : null}
    {inspectionPicking ? <div className="inspection-pick-banner"><MapPin size={17} weight="fill" /><span>{activeInspectionTarget}</span><button className="plain-icon" aria-label="取消地图选点" title="取消" onClick={onInspectionEnd}><X size={16} /></button></div> : null}
    {waterNitrogenObservation ? <WaterNitrogenObservationView observation={waterNitrogenObservation} targets={waterNitrogenTargets} inspections={inspections} /> : null}
    {waterloggingObservation ? <WaterloggingObservationView observation={waterloggingObservation} /> : null}
    {frostObservation ? <FrostObservationView observation={frostObservation} /> : null}

    {staleObservation && staleObservationDate ? <div className="result-impact is-observation-stale"><WarningCircle size={18} weight="fill" /><p><span>使用 {formatShortDate(staleObservationDate)} 影像，不代表今天的{growthObservation ? "长势" : "水氮状态"}。</span></p></div> : impactfulLimitation && waterloggingObservation?.status === "radar_change_only" ? <div className="result-impact"><WarningCircle size={18} weight="fill" /><p><strong>还缺连续降雨资料</strong><span>{impactfulLimitation}</span></p></div> : null}

    {spatialFindings.length ? <section className="result-band result-zones">
      <header><h4>{growthObservation ? "需要关注的区域" : waterNitrogenObservation ? "需要关注的区域" : waterloggingObservation?.status === "radar_change_only" ? "雷达变化区" : waterloggingObservation?.status === "suspected" ? "疑似积水区" : frostObservation ? "低洼关注区" : "关注区域"}</h4><span>{waterNitrogenObservation ? "点击地图定位并与正常区对照" : "点击后在地图定位"}</span></header>
      <div>{spatialFindings.map((finding, index) => {
        const inspection = inspections.find((item) => item.findingId === finding.id);
        const waterNitrogenPresentation = waterNitrogenObservation ? waterNitrogenZonePresentation(waterNitrogenObservation, finding, index) : null;
        return <div className="result-zone-row" key={finding.id}>
          <button className="result-zone-focus" onClick={() => { selectWaterNitrogenReferenceLayer(); onFocusFinding(finding.id); }}>
            <span className="zone-order">{String(index + 1).padStart(2, "0")}</span>
            <span><strong>{waterNitrogenPresentation?.title ?? finding.title}</strong><small>{waterNitrogenPresentation?.summary ?? (growthObservation ? growthZoneSummary(finding, growthObservation.latestObservationDate) : finding.summary)}</small></span>
            {finding.areaHa !== null ? <b>{finding.areaHa.toFixed(2)} 公顷</b> : <MapPin size={16} />}
          </button>
          {inspection && !waterNitrogenObservation ? <span className="zone-checked"><CheckCircle size={15} weight="fill" />已核查</span> : null}
        </div>;
      })}</div>
    </section> : null}

    {surface === "agent" && agentRun?.tools.length ? <AgentProcessDisclosure run={agentRun} label="Agent 过程" /> : null}

    <div className={`result-footer${task.status === "failed" || !primaryAction ? " single" : ""}`}>
      {task.status === "failed"
        ? task.failure?.retryable !== false
          ? <button className="drawer-primary" onClick={onNewAnalysis}><ArrowClockwise size={18} weight="bold" />重新分析</button>
          : <button className="drawer-primary" onClick={() => setView("evidence")}><Database size={18} weight="bold" />查看失败原因</button>
        : primaryAction?.kind === "edit_field"
        ? <button className="drawer-primary" onClick={onEditField}><PencilSimple size={18} weight="bold" />{workflowActionButtonLabel(primaryAction)}</button>
        : primaryAction?.kind === "new_analysis"
        ? <button className="drawer-primary" onClick={onNewAnalysis}><ChartLineUp size={18} weight="bold" />{workflowActionButtonLabel(primaryAction)}</button>
        : primaryAction?.kind === "rerun"
        ? <button className="drawer-primary" onClick={() => onFollowUpAnalysis(task)}><ArrowClockwise size={18} weight="bold" />{workflowActionButtonLabel(primaryAction)}</button>
        : primaryAction?.kind === "open_data" && acquiredForTask
        ? <button className="drawer-primary" onClick={() => onFollowUpAnalysis(task)}><ArrowClockwise size={18} weight="bold" />重新分析</button>
        : primaryAction?.kind === "open_data"
        ? <button className="drawer-primary" onClick={onOpenData}><Database size={18} weight="bold" />{workflowActionButtonLabel(primaryAction)}</button>
        : primaryAction?.kind === "inspect_task_zone" && waterNitrogenObservation?.observation.variationStatus === "visible" && waterNitrogenPairComplete
        ? <button className="drawer-primary" onClick={() => onFollowUpAnalysis(task, [], task.id)}><Sparkle size={17} weight="fill" />更新判断</button>
        : primaryAction?.kind === "inspect_task_zone" && waterNitrogenObservation?.observation.variationStatus === "visible"
        ? <button className="drawer-primary" onClick={beginWaterNitrogenInspection}><MapPin size={17} weight="fill" />{inspections.some((inspection) => inspection.scoutingRole === "low_value") ? "记录正常区" : "记录低值区"}</button>
        : primaryAction?.kind === "inspect_task_zone" && nextGeneralInspection
          ? <button className="drawer-primary" onClick={() => startInspection(nextGeneralInspection)}><MapPin size={17} weight="fill" />{generalInspectionsComplete ? "查看核查" : inspections.length ? "记录下一区域" : "记录核查"}</button>
        : primaryAction?.kind === "inspect_task_zone" || primaryAction?.kind === "record_field_note"
          ? <button className="drawer-primary" onClick={onRecordFieldNote}><MapPin size={17} weight="fill" />{workflowActionButtonLabel(primaryAction)}</button>
          : null}
      {task.status !== "failed" ? <button className="secondary-button" onClick={() => setView("evidence")}><Database size={18} weight="bold" />{requiresData ? "查看所缺数据" : "依据与数据"}</button> : null}
    </div>
    </article>
    {surface === "agent" && canContinueConversation(task) ? <TaskConversationFollowUps task={task} /> : null}
    {inspectionTarget && inspectionDraftLocation ? <FieldInspectionModal taskId={task.id} finding={inspectionTarget} location={inspectionDraftLocation} existing={inspections.find((item) => item.findingId === inspectionTarget.id) ?? null} onClose={() => { setInspectionTarget(null); setInspectionDraftLocation(null); onInspectionEnd(); }} onSaved={(record) => { setInspections((current) => [...current.filter((item) => item.findingId !== record.findingId), record]); setInspectionTarget(null); setInspectionDraftLocation(null); onInspectionEnd(); }} /> : null}
  </div>;
}

function FieldReportView({ report }: { report: ReturnType<typeof fieldReportPresentation> }) {
  const layer = report.heroMap;
  const isContrastLayer = layer?.metric === "ndvi_contrast";
  return <section className="field-report" aria-label="田块分析图件">
    {layer ? <figure className="field-report-map">
      <img src={artifactUrl(layer.ref)} alt={`${layer.label} ${layer.date} 分析图`} />
      <figcaption><strong>{isContrastLayer ? "对比 NDVI · 田内差异" : layer.label}</strong><span>{isContrastLayer ? `拉伸范围 ${layer.min.toFixed(2)}–${layer.max.toFixed(2)}` : null}{isContrastLayer ? " · " : null}{formatShortDate(layer.date)} · {layer.resolutionMeters} 米</span></figcaption>
    </figure> : null}
    {report.mean !== null || report.std !== null ? <div className="field-report-stats" aria-label="指数统计">
      {report.mean !== null ? <div><small>平均 NDVI</small><strong>{report.mean.toFixed(3)}</strong></div> : null}
      {report.std !== null ? <div><small>标准差</small><strong>{report.std.toFixed(3)}</strong></div> : null}
      {report.min !== null ? <div><small>最小值</small><strong>{report.min.toFixed(3)}</strong></div> : null}
      {report.max !== null ? <div><small>最大值</small><strong>{report.max.toFixed(3)}</strong></div> : null}
      {report.coverageFraction !== null ? <div><small>有效覆盖</small><strong>{(report.coverageFraction * 100).toFixed(0)}%</strong></div> : null}
    </div> : null}
    {report.zones.length ? <div className="field-report-zones">
      <h4>分区统计</h4>
      <div className="field-report-table-scroll"><table><thead><tr><th>分区</th><th>面积</th><th>平均 NDVI</th><th>偏差</th><th>参考用量</th></tr></thead>
        <tbody>{report.zones.map((zone, index) => <tr key={zone.id || index}>
          <th>{zone.label}</th>
          <td>{zone.areaHa === null ? "—" : `${zone.areaHa.toFixed(2)} ha`}</td>
          <td>{zone.meanNdvi === null ? "—" : zone.meanNdvi.toFixed(3)}</td>
          <td>{zone.deviation === null ? "—" : `${zone.deviation > 0 ? "+" : ""}${zone.deviation.toFixed(3)}`}</td>
          <td>{zone.rateKgHa === null ? "—" : `${zone.rateKgHa.toFixed(1)} kg/ha`}</td>
        </tr>)}</tbody>
      </table></div>
    </div> : null}
  </section>;
}

function AnalysisBriefView({ brief }: { brief: AnalysisBrief }) {
  const document = brief.document;
  const sections = analysisBriefVisibleSections(brief);
  return <section className="result-decision-brief" aria-label="农情解读">
    {brief.generation.mode === "deterministic" ? <p className="brief-boundary" role="status">AI 解读未生成，当前展示计算摘要。</p> : null}
    {brief.reviewRequired ? <p className="brief-boundary" role="status">分析草稿待专业复核，处方性建议尚未发布。</p> : null}
    {sections.showOverview ? <div className="brief-conclusion">
      <span>{brief.generation.mode === "deterministic" ? "观测结果" : "当前判断"}</span>
      <p>{brief.overview}</p>
    </div> : null}
    {sections.showReasoning ? <div className="brief-reasoning">
      <span>{brief.generation.mode === "deterministic" ? "变化与分区统计" : "为什么这样判断"}</span>
      <p>{brief.reasoning}</p>
    </div> : null}
    {brief.uncertainty ? <div className="brief-boundary"><span>数据时间与范围</span><p>{brief.uncertainty}</p></div> : null}
    {sections.showActions ? <div className="brief-actions">
      <span>现在先做</span>
      {brief.actions.map((action, index) => {
        const context = [action.timing, action.where].filter((value): value is string => Boolean(value)).join(" · ");
        return <div className={`brief-action${index === 0 ? " is-primary" : ""}`} key={`${action.label}-${index}`}>
          <i>{index + 1}</i>
          <div>
            <strong>{action.label}</strong>
            {context ? <small>{context}</small> : null}
            {action.purpose ? <p>为了判断：{action.purpose}</p> : null}
            {action.decisionEffect ? <p>判断变化：{action.decisionEffect}</p> : null}
            {action.checklist.length ? <p>检查：{action.checklist.join("、")}</p> : null}
          </div>
        </div>;
      })}
    </div> : null}
    {sections.showDocument && document ? <div className="brief-document">
      <header className="brief-document-head">
        <div><span>{brief.generation.mode === "model_generated" ? "AI 农情分析" : "任务文档"}</span><h4>{document.title}</h4></div>
        <small>{document.subtitle}</small>
      </header>
      {document.sections.map((section) => <section className="brief-document-section" key={section.id}>
        <h5>{section.title}</h5>
        {section.paragraphs.map((paragraph, index) => <p key={`${section.id}-p-${index}`}>{paragraph}</p>)}
        {section.items?.length ? <div className="brief-document-items">{section.items.map((item, index) => <div className="brief-document-item" key={`${section.id}-i-${item.label}-${index}`}>
          <strong>{item.label}</strong><p>{item.text}</p>
        </div>)}</div> : null}
      </section>)}
    </div> : null}
    {sections.showEvidence ? <details className="brief-evidence">
      <summary><span>证据依据</span><b>{brief.evidence.length} 条</b></summary>
      <ol>{brief.evidence.map((item, index) => <li key={`${item.statement}-${index}`}>
        <p>{item.statement}</p>
        <small>{item.sourceDates.map((source) => source.date ? `${source.source} ${source.date}` : source.source).join("、")}</small>
        {item.knowledgeCitations?.map((citation) => <small key={`${citation.sourceId}-${citation.locator}`}>
          农学知识：{citation.title} · {citation.locator}{citation.version ? ` · ${citation.version}` : ""}
          {citation.sourceUrl && /^https?:\/\//i.test(citation.sourceUrl) ? <> · <a href={citation.sourceUrl} target="_blank" rel="noreferrer">查看原文</a></> : null}
        </small>)}
        {item.references?.length ? <small>{item.references.map((ref) => `${ref.resultId} ${ref.path}`).join("；")}</small> : null}
      </li>)}</ol>
    </details> : null}
  </section>;
}

function AgentProcessDisclosure({ run, label }: { run: AgentRunTrace; label: string }) {
  const completedCount = run.tools.filter((tool) => tool.status === "completed").length;
  const summary = run.status === "running"
    ? "进行中"
    : run.status === "failed"
      ? "未完成"
      : `${completedCount}/${run.tools.length}`;
  return <details className="agent-process">
    <summary><strong>{label}</strong><small>{summary}</small></summary>
    <div className="agent-process-list">
      {run.tools.length ? run.tools.map((tool) => <div key={tool.toolCallId} className={`agent-process-step is-${tool.status}`}>
        {tool.status === "failed" ? <WarningCircle size={16} weight="fill" /> : <CheckCircle size={16} weight={tool.status === "completed" ? "fill" : "regular"} />}
        <span>{agentToolLabel(tool.toolName)}</span>
        <small>{agentToolStatusLabel(tool.status)}</small>
      </div>) : <p>本次运行尚未调用分析工具。</p>}
    </div>
  </details>;
}

function TaskConversationFollowUps({ task }: { task: AnalysisTask }) {
  const [messages, setMessages] = useState<TaskConversationMessage[]>([]);
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const latestMessageRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void fetchTaskConversation(task.id).then((items) => {
      if (!cancelled) setMessages(items);
    }).catch((reason: unknown) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : "任务对话加载失败。");
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [task.id]);
  const submit = async () => {
    const question = content.trim();
    if (!question || sending) return;
    setSending(true);
    setError(null);
    try {
      const exchange = await sendTaskConversationMessage(task.id, question);
      setMessages((current) => [...current, ...exchange]);
      setContent("");
      window.requestAnimationFrame(() => latestMessageRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "农情 Agent 暂时无法回答，请稍后重试。");
    } finally {
      setSending(false);
    }
  };
  const resultSequence = messages.find((message) => message.kind === "analysis_result")?.sequence ?? 0;
  const followUps = messages.filter((message) => message.sequence > resultSequence);
  return <section className="conversation-followups" aria-label="与农情 Agent 的后续对话">
    <div className="conversation-list" aria-live="polite">
      {loading ? <div className="conversation-history-loading"><i /><span>正在读取对话</span></div> : null}
      {!loading && followUps.map((message, index) => <div ref={index === followUps.length - 1 ? latestMessageRef : undefined} key={message.id} className={`conversation-message is-${message.role}`}><small>{message.role === "user" ? "你" : "农情 Agent"}</small><p>{message.content}</p></div>)}
      {sending ? <div className="conversation-message is-assistant is-thinking"><small>农情 Agent</small><p><i /><i /><i /></p></div> : null}
    </div>
    <form className="conversation-composer is-integrated" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      {error ? <p>{error}</p> : null}
      <div><input aria-label="向农情 Agent 提问" value={content} maxLength={1000} onChange={(event) => setContent(event.target.value)} placeholder="继续问这次田况" /><button type="submit" aria-label="发送问题" title="发送" disabled={!content.trim() || sending}><PaperPlaneRight size={17} weight="fill" /></button></div>
    </form>
  </section>;
}

function canContinueConversation(task: AnalysisTask): boolean {
  return ["needs_input", "needs_data", "needs_review", "partial", "completed"].includes(task.status);
}

function FieldScoutingNoteModal({ field, location, initial, onClose, onSaved }: { field: FieldSummary; location: Position; initial?: ConversationScoutingNoteDraft | null; onClose: () => void; onSaved: (note: FieldScoutingNote) => void }) {
  const [observedAt, setObservedAt] = useState(initial?.observedAt ?? todayCalendarDate());
  const [waterCondition, setWaterCondition] = useState<SaveFieldScoutingNoteRequest["waterCondition"]>(initial?.waterCondition ?? "unknown");
  const [leafColor, setLeafColor] = useState<SaveFieldScoutingNoteRequest["leafColor"]>(initial?.leafColor ?? "unknown");
  const [diseaseOrPest, setDiseaseOrPest] = useState<SaveFieldScoutingNoteRequest["diseaseOrPest"]>(initial?.diseaseOrPest ?? "unknown");
  const [note, setNote] = useState(initial?.note ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      onSaved(await saveScoutingNote(field.id, { observedAt, location, waterCondition, leafColor, diseaseOrPest, note }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "巡田记录保存失败。");
    } finally {
      setSaving(false);
    }
  };
  return <div className="inspection-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}>
    <section className="inspection-modal" role="dialog" aria-modal="true" aria-labelledby="scouting-note-title">
      <header><div><span>{field.name}</span><h3 id="scouting-note-title">{initial ? "确认巡田记录" : "新增巡田记录"}</h3></div><button className="plain-icon" aria-label="关闭巡田记录" title="关闭" onClick={onClose}><X size={18} /></button></header>
      <div className="inspection-form">
        <label>观察日期<input type="date" value={observedAt} onChange={(event) => setObservedAt(event.target.value)} /></label>
        <div className="inspection-location"><MapPin size={15} weight="fill" /><span>记录位置</span><code>{location.longitude.toFixed(5)}°, {location.latitude.toFixed(5)}°</code></div>
        <label>墒情<select value={waterCondition} onChange={(event) => setWaterCondition(event.target.value as SaveFieldScoutingNoteRequest["waterCondition"])}><option value="unknown">未记录</option><option value="dry">偏干</option><option value="normal">正常</option><option value="wet">偏湿</option><option value="standing_water">有积水</option></select></label>
        <label>叶色<select value={leafColor} onChange={(event) => setLeafColor(event.target.value as SaveFieldScoutingNoteRequest["leafColor"])}><option value="unknown">未记录</option><option value="normal">正常</option><option value="pale">偏黄</option><option value="dark_green">深绿</option></select></label>
        <label>病虫害<select value={diseaseOrPest} onChange={(event) => setDiseaseOrPest(event.target.value as SaveFieldScoutingNoteRequest["diseaseOrPest"])}><option value="unknown">未记录</option><option value="none_seen">未见</option><option value="suspected">疑似</option></select></label>
        <label>备注<textarea value={note} maxLength={500} onChange={(event) => setNote(event.target.value)} placeholder="记录现场看到的情况" /></label>
        {error ? <p className="inspection-error">{error}</p> : null}
      </div>
      <footer><button className="secondary-button" onClick={onClose}>取消</button><button className="drawer-primary" disabled={saving} onClick={() => void submit()}>{saving ? "正在保存" : initial ? "确认保存" : "保存记录"}</button></footer>
    </section>
  </div>;
}

function FieldInspectionModal({ taskId, finding, location, existing, onClose, onSaved }: { taskId: string; finding: AnalysisFinding; location: Position; existing: FieldInspectionRecord | null; onClose: () => void; onSaved: (record: FieldInspectionRecord) => void }) {
  const [observedAt, setObservedAt] = useState(existing?.observedAt ?? todayCalendarDate());
  const [waterCondition, setWaterCondition] = useState<SaveFieldInspectionRequest["waterCondition"]>(existing?.waterCondition ?? "unknown");
  const [leafColor, setLeafColor] = useState<SaveFieldInspectionRequest["leafColor"]>(existing?.leafColor ?? "unknown");
  const [diseaseOrPest, setDiseaseOrPest] = useState<SaveFieldInspectionRequest["diseaseOrPest"]>(existing?.diseaseOrPest ?? "unknown");
  const [note, setNote] = useState(existing?.note ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      const record = await saveFieldInspection(taskId, finding.id, { observedAt, location, waterCondition, leafColor, diseaseOrPest, note });
      onSaved(record);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "现场核查记录保存失败。");
    } finally {
      setSaving(false);
    }
  };
  return <div className="inspection-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}>
    <section className="inspection-modal" role="dialog" aria-modal="true" aria-labelledby="inspection-title">
      <header><div><span>现场核查</span><h3 id="inspection-title">{finding.title}</h3></div><button className="plain-icon" aria-label="关闭现场核查" title="关闭" onClick={onClose}><X size={18} /></button></header>
      <div className="inspection-form">
        <label>观察日期<input type="date" value={observedAt} onChange={(event) => setObservedAt(event.target.value)} /></label>
        <div className="inspection-location"><MapPin size={15} weight="fill" /><span>已选位置</span><code>{location.longitude.toFixed(5)}°, {location.latitude.toFixed(5)}°</code></div>
        <label>墒情<select value={waterCondition} onChange={(event) => setWaterCondition(event.target.value as SaveFieldInspectionRequest["waterCondition"])}><option value="unknown">未记录</option><option value="dry">偏干</option><option value="normal">正常</option><option value="wet">偏湿</option><option value="standing_water">有积水</option></select></label>
        <label>叶色<select value={leafColor} onChange={(event) => setLeafColor(event.target.value as SaveFieldInspectionRequest["leafColor"])}><option value="unknown">未记录</option><option value="normal">正常</option><option value="pale">偏黄</option><option value="dark_green">深绿</option></select></label>
        <label>病虫害<select value={diseaseOrPest} onChange={(event) => setDiseaseOrPest(event.target.value as SaveFieldInspectionRequest["diseaseOrPest"])}><option value="unknown">未记录</option><option value="none_seen">未见</option><option value="suspected">疑似</option></select></label>
        <label>备注<textarea value={note} maxLength={500} onChange={(event) => setNote(event.target.value)} placeholder="记录现场看到的情况" /></label>
        {error ? <p className="inspection-error">{error}</p> : null}
      </div>
      <footer><button className="secondary-button" onClick={onClose}>取消</button><button className="drawer-primary" disabled={saving} onClick={() => void submit()}>{saving ? "正在保存" : "保存核查"}</button></footer>
    </section>
  </div>;
}

interface GrowthObservationViewModel {
  stage: { label: string; daysAfterPlanting: number } | null;
  status: "observed" | "watch";
  trend: "increasing" | "stable" | "declining" | "insufficient_timeseries";
  meanNdvi: number;
  latestObservationDate: string;
  observationCount: number;
  validCoverageFraction: number;
  observationAgeDays: number | null;
  observationStatus: "current" | "stale";
  latestChange: { fromDate: string; toDate: string; ndviDelta: number } | null;
  belowAverageZoneCount: number;
  belowAverageAreaHa: number | null;
  belowAverageAreaFraction: number | null;
  aboveAverageZoneCount: number;
}

function getGrowthObservation(results: AnalysisResult<unknown>[]): GrowthObservationViewModel | null {
  const assessment = results.find((result) => result.kind === "assessment");
  const payload = assessment?.result as Partial<GrowthObservationViewModel> | null | undefined;
  if (!payload?.latestObservationDate
    || typeof payload.meanNdvi !== "number"
    || typeof payload.observationCount !== "number"
    || typeof payload.validCoverageFraction !== "number"
    || (payload.belowAverageAreaHa !== null && typeof payload.belowAverageAreaHa !== "number")
    || (payload.belowAverageAreaFraction !== null && typeof payload.belowAverageAreaFraction !== "number")
    || !payload.trend
    || !payload.observationStatus) return null;
  return {
    stage: payload.stage ?? null,
    status: payload.status ?? "observed",
    trend: payload.trend,
    meanNdvi: payload.meanNdvi,
    latestObservationDate: payload.latestObservationDate,
    observationCount: payload.observationCount,
    validCoverageFraction: payload.validCoverageFraction,
    observationAgeDays: payload.observationAgeDays ?? null,
    observationStatus: payload.observationStatus,
    latestChange: payload.latestChange ?? null,
    belowAverageZoneCount: payload.belowAverageZoneCount ?? 0,
    belowAverageAreaHa: payload.belowAverageAreaHa,
    belowAverageAreaFraction: payload.belowAverageAreaFraction,
    aboveAverageZoneCount: payload.aboveAverageZoneCount ?? 0,
  };
}

function GrowthObservationView({ observation, trendChart }: { observation: GrowthObservationViewModel; trendChart: ChartArtifact | null }) {
  return <section className="result-observation" aria-label="关键生育期长势观测">
    <header><h4>田况观测</h4><span>{formatShortDate(observation.latestObservationDate)} · 有效覆盖 {(observation.validCoverageFraction * 100).toFixed(0)}% · {observation.observationCount} 期</span></header>
    <div className="waterlogging-facts growth-facts">
      <span><small>地块 NDVI</small><strong>{observation.meanNdvi.toFixed(3)}</strong></span>
      <span><small>生育期</small><strong>{observation.stage ? `${observation.stage.label} · 第 ${observation.stage.daysAfterPlanting} 天` : "待补播期"}</strong></span>
      <span><small>最近变化</small><strong>{observation.latestChange ? `${observation.latestChange.ndviDelta >= 0 ? "+" : ""}${observation.latestChange.ndviDelta.toFixed(3)}` : "待下期"}</strong></span>
      <span><small>相对偏弱区</small><strong>{observation.belowAverageZoneCount ? observation.belowAverageAreaHa === null ? `${observation.belowAverageZoneCount} 区 · 面积未计算` : `${observation.belowAverageAreaHa.toFixed(2)} ha${observation.belowAverageAreaFraction === null ? "" : ` · ${(observation.belowAverageAreaFraction * 100).toFixed(1)}%`}` : "未形成"}</strong></span>
    </div>
    <NdviSeasonTrend artifact={trendChart} />
  </section>;
}

function growthZoneSummary(finding: AnalysisFinding, observationDate: string): string {
  const ndvi = finding.summary.match(/NDVI (?:为|均值为)?\s*([0-9.]+)/)?.[1];
  return `${formatShortDate(observationDate)}${ndvi ? ` · NDVI ${ndvi}` : ""}`;
}

function NdviSeasonTrend({ artifact }: { artifact: ChartArtifact | null }) {
  const points = artifact?.chart.series[0]?.points ?? [];
  if (!points.length) return null;
  if (points.length === 1) return <div className="growth-trend growth-trend-empty" aria-label="本季 NDVI 时序"><header><strong>本季 NDVI</strong><span>1 个可用日期</span></header><p>当前只有 {formatShortDate(points[0]!.label)} 一期影像，后续影像到达后显示变化趋势。</p></div>;
  const values = points.map((point) => point.value);
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const range = Math.max(maximum - minimum, 0.001);
  return <div className="growth-trend" aria-label="本季 NDVI 时序"><header><strong>本季 NDVI</strong><span>{points.length} 个可用日期</span></header><div>{points.map((point) => <span key={point.label}><i style={{ height: `${22 + (point.value - minimum) / range * 42}px` }} /><small>{formatShortDate(point.label)}</small><b>{point.value.toFixed(3)}</b></span>)}</div></div>;
}

function WaterNitrogenObservationView({ observation, targets, inspections }: { observation: WaterNitrogenObservationViewModel; targets: AnalysisFinding[]; inspections: FieldInspectionRecord[] }) {
  const hasRelativeVariation = observation.observation.variationStatus === "visible";
  const lowTarget = targets.find((target) => target.scoutingRole === "low_value");
  const referenceTarget = targets.find((target) => target.scoutingRole === "reference");
  const lowInspection = lowTarget ? inspections.find((inspection) => inspection.findingId === lowTarget.id) : null;
  const referenceInspection = referenceTarget ? inspections.find((inspection) => inspection.findingId === referenceTarget.id) : null;
  const evidenceLabel = observation.evidenceLevel === "field_comparison" ? "同期现场记录" : observation.evidenceLevel === "multi_source" ? "多源数据" : "光学数据";
  const changeLabel = observation.latestChange ? `${observation.latestChange.ndviDelta >= 0 ? "+" : ""}${observation.latestChange.ndviDelta.toFixed(3)}` : "单期";
  return <section className="result-observation" aria-label="水氮任务田况观测">
    <header><h4>观测与比较</h4><span>{formatShortDate(observation.referenceDate)}{observation.cropStage ? ` · ${observation.cropStage.label}` : ""}</span></header>
    <div className="waterlogging-facts growth-facts">
      <span><small>有效覆盖</small><strong>{observation.validCoverageFraction === null ? "未记录" : `${(observation.validCoverageFraction * 100).toFixed(0)}%`}</strong></span>
      <span><small>关注区</small><strong>{hasRelativeVariation ? observation.attentionAreaHa === null ? "面积未计算" : `${observation.attentionAreaHa.toFixed(2)} ha${observation.attentionAreaFraction === null ? "" : ` · ${(observation.attentionAreaFraction * 100).toFixed(1)}%`}` : "未形成"}</strong></span>
      <span><small>近期变化</small><strong>{changeLabel}</strong></span>
      <span><small>证据状态</small><strong>{evidenceLabel}</strong></span>
    </div>
    {lowInspection || referenceInspection ? <div className="scouting-pair" aria-label="已关联现场记录">
      {lowInspection ? <ScoutingPairRow index={1} label="低值区" inspection={lowInspection} /> : null}
      {referenceInspection ? <ScoutingPairRow index={2} label="正常区对照" inspection={referenceInspection} /> : null}
    </div> : !hasRelativeVariation ? <div className="observation-condition"><span className="observation-condition-dot" /><strong>可用范围内未检出明显田内差异</strong></div> : null}
  </section>;
}

function waterNitrogenZonePresentation(observation: WaterNitrogenObservationViewModel, finding: AnalysisFinding, index: number): { title: string; summary: string } {
  const zone = observation.zones.find((candidate) => candidate.id === finding.id || candidate.opticalZoneId === finding.id);
  const priority = zone?.spatialPriority;
  const overlapLine = !priority || priority.status === "unavailable"
    ? "多源交集不可计算，未据此排序"
    : priority.changesPriority
      ? `${priority.preferredBecause === "radar_overlap" ? "雷达有交" : priority.preferredBecause === "lowland_overlap" ? "低洼有交" : "雷达/低洼有交"} · ${priority.note}`
      : "已测零交，未改变先看顺序";
  return {
    title: `田内相对低值区 ${index + 1}`,
    summary: `${formatShortDate(observation.referenceDate)}${zone?.meanNdvi == null ? "" : ` · NDVI ${zone.meanNdvi.toFixed(3)}`} · ${overlapLine}`,
  };
}

function ScoutingPairRow({ index, label, inspection }: { index: number; label: string; inspection: FieldInspectionRecord | null }) {
  return <div className={inspection ? "is-complete" : ""}>
    <span>{inspection ? <CheckCircle size={18} weight="fill" /> : index}</span>
    <strong>{label}</strong>
    <small>{inspection ? `${formatShortDate(inspection.observedAt)} · ${inspectionConditionSummary(inspection)}` : "未记录"}</small>
  </div>;
}

function inspectionConditionSummary(inspection: Pick<FieldInspectionRecord, "waterCondition" | "leafColor" | "diseaseOrPest">): string {
  const water = inspection.waterCondition === "dry" ? "墒情偏干" : inspection.waterCondition === "wet" ? "墒情偏湿" : inspection.waterCondition === "standing_water" ? "现场有积水" : inspection.waterCondition === "normal" ? "墒情正常" : "墒情未记录";
  const leaf = inspection.leafColor === "pale" ? "叶色偏黄" : inspection.leafColor === "dark_green" ? "叶色深绿" : inspection.leafColor === "normal" ? "叶色正常" : "叶色未记录";
  const disease = inspection.diseaseOrPest === "suspected" ? "疑似病虫害" : inspection.diseaseOrPest === "none_seen" ? "未见病虫害" : "病虫害未记录";
  return `${water} · ${leaf} · ${disease}`;
}

function scoutingDraftSummary(draft: ConversationScoutingNoteDraft): string {
  return `${formatShortDate(draft.observedAt)} · ${inspectionConditionSummary(draft)}`;
}

interface WaterloggingObservationViewModel {
  methodVersion: "radar-rainfall-terrain-v2";
  status: "suspected" | "not_detected" | "radar_change_only";
  beforeDate: string;
  afterDate: string;
  intervalDays: number;
  radarCoverageFraction: number;
  changedAreaHa: number;
  changedAreaFraction: number;
  rainfallThresholdMm: number;
  rainfallMm: number | null;
  rainEvent: { start: string; end: string; rainfallMm: number } | null;
  affectedAreaHa: number;
  affectedAreaFraction: number;
  zones: Array<{ id: string; priority: "high" | "normal"; areaHa: number; areaFraction: number; meanVvDeltaDb: number; relativeElevationM: number | null; zone: number[][] }>;
}

function getWaterloggingObservation(results: AnalysisResult<unknown>[]): WaterloggingObservationViewModel | null {
  const assessment = [...results].reverse().find((result) => {
    if (result.kind !== "assessment" || !result.result || typeof result.result !== "object") return false;
    const payload = result.result as { methodVersion?: unknown; status?: unknown; beforeDate?: unknown; afterDate?: unknown };
    return payload.methodVersion === "radar-rainfall-terrain-v2" && typeof payload.status === "string" && typeof payload.beforeDate === "string" && typeof payload.afterDate === "string";
  });
  const payload = assessment?.result as Partial<WaterloggingObservationViewModel> | null | undefined;
  if (!payload?.status || !payload.beforeDate || !payload.afterDate || !Array.isArray(payload.zones)) return null;
  return {
    status: payload.status,
    beforeDate: payload.beforeDate,
    afterDate: payload.afterDate,
    methodVersion: payload.methodVersion!,
    intervalDays: typeof payload.intervalDays === "number" ? payload.intervalDays : 0,
    radarCoverageFraction: typeof payload.radarCoverageFraction === "number" ? payload.radarCoverageFraction : 0,
    changedAreaHa: typeof payload.changedAreaHa === "number" ? payload.changedAreaHa : 0,
    changedAreaFraction: typeof payload.changedAreaFraction === "number" ? payload.changedAreaFraction : 0,
    rainfallThresholdMm: typeof payload.rainfallThresholdMm === "number" ? payload.rainfallThresholdMm : 20,
    rainfallMm: typeof payload.rainfallMm === "number" ? payload.rainfallMm : null,
    rainEvent: payload.rainEvent ?? null,
    affectedAreaHa: typeof payload.affectedAreaHa === "number" ? payload.affectedAreaHa : 0,
    affectedAreaFraction: typeof payload.affectedAreaFraction === "number" ? payload.affectedAreaFraction : 0,
    zones: payload.zones,
  };
}

function WaterloggingObservationView({ observation }: { observation: WaterloggingObservationViewModel }) {
  return <section className="result-observation" aria-label="积水任务雷达观测">
    <div className="waterlogging-facts growth-facts">
      <span><small>雷达时相</small><strong>{formatShortDate(observation.beforeDate)} → {formatShortDate(observation.afterDate)}</strong></span>
      <span><small>有效覆盖</small><strong>{Math.round(observation.radarCoverageFraction * 100)}%</strong></span>
      <span><small>{observation.status === "suspected" ? "关联降雨" : "区间降雨"}</small><strong>{observation.rainfallMm === null ? "待补充" : `${observation.rainfallMm.toFixed(1)} mm`}</strong></span>
      <span><small>{observation.status === "suspected" ? "疑似影响" : "雷达变化"}</small><strong>{(observation.status === "suspected" ? observation.affectedAreaHa : observation.changedAreaHa).toFixed(2)} ha · {((observation.status === "suspected" ? observation.affectedAreaFraction : observation.changedAreaFraction) * 100).toFixed(1)}%</strong></span>
    </div>
  </section>;
}

interface FrostObservationViewModel {
  methodVersion: "stage-temperature-duration-terrain-v2";
  risk: "high" | "watch" | "normal" | "undetermined";
  forecastRunAt: string;
  forecastCoverageFraction: number;
  forecastGridDistanceKm: number | null;
  forecastMinTemperatureC: number;
  forecastWindow: { start: string | null; end: string | null };
  coldDurationHours: number;
  cropStage: { label: string } | null;
  stageSensitivity: "high" | "medium" | "low" | "unknown";
  terrainStatus: "available" | "limited" | "missing";
  zones: Array<{ id: string; risk: "high" | "watch"; relativeElevationM: number; areaHa: number; areaFraction: number; zone: number[][] }>;
}

function getFrostObservation(results: AnalysisResult<unknown>[]): FrostObservationViewModel | null {
  const assessment = [...results].reverse().find((result) => {
    if (result.kind !== "assessment" || !result.result || typeof result.result !== "object") return false;
    const payload = result.result as { methodVersion?: unknown; risk?: unknown; forecastWindow?: unknown; forecastMinTemperatureC?: unknown };
    return payload.methodVersion === "stage-temperature-duration-terrain-v2" && typeof payload.risk === "string" && Boolean(payload.forecastWindow) && typeof payload.forecastMinTemperatureC === "number";
  });
  const payload = assessment?.result as Partial<FrostObservationViewModel> | null | undefined;
  if (!payload?.risk || typeof payload.forecastRunAt !== "string" || typeof payload.forecastCoverageFraction !== "number" || typeof payload.forecastMinTemperatureC !== "number" || !payload.forecastWindow || typeof payload.coldDurationHours !== "number" || !payload.stageSensitivity || !payload.terrainStatus || !Array.isArray(payload.zones)) return null;
  return payload as FrostObservationViewModel;
}

function FrostObservationView({ observation }: { observation: FrostObservationViewModel }) {
  const sensitivityLabel = observation.stageSensitivity === "high" ? "高敏感" : observation.stageSensitivity === "medium" ? "中敏感" : observation.stageSensitivity === "low" ? "低敏感" : "待补资料";
  return <section className="result-observation" aria-label="霜冻预报判断">
    <div className="waterlogging-facts growth-facts">
      <span><small>风险窗口</small><strong>{formatForecastRange(observation.forecastWindow)}</strong></span>
      <span><small>低温过程</small><strong>{observation.forecastMinTemperatureC.toFixed(1)}℃ · {observation.coldDurationHours.toFixed(0)}h</strong></span>
      <span><small>生育期</small><strong>{observation.cropStage?.label ?? "待补播期"} · {sensitivityLabel}</strong></span>
      <span><small>预报资料</small><strong>{formatShortDate(observation.forecastRunAt.slice(0, 10))} · {Math.round(observation.forecastCoverageFraction * 100)}%</strong></span>
    </div>
  </section>;
}

function formatForecastRange(window: { start: string | null; end: string | null }): string {
  if (window.start && window.end) return `${formatShortDate(window.start.slice(0, 10))} → ${formatShortDate(window.end.slice(0, 10))}`;
  if (window.start) return `自 ${formatShortDate(window.start.slice(0, 10))}`;
  if (window.end) return `截至 ${formatShortDate(window.end.slice(0, 10))}`;
  return "有效期未知";
}

function TaskEvidence({ task, charts, agentRun, onBack }: { task: AnalysisTask; charts: ChartArtifact[]; agentRun: AgentRunTrace | null; onBack: () => void }) {
  if (task.status === "failed" && task.failure) {
    return <div className="panel-scroll-new result-scroll evidence-view">
      <header className="evidence-head"><button className="plain-icon" title="返回分析结果" aria-label="返回分析结果" onClick={onBack}><CaretLeft size={19} /></button><div><h3>失败原因</h3></div></header>
      <section className="evidence-block evidence-limitations">
        <header><h4>{task.failure.retryable ? "本次运行未完成" : "服务配置需要更新"}</h4></header>
        <ul><li>{task.failure.message}</li></ul>
      </section>
    </div>;
  }
  const sourceGroups = groupTaskSources(taskEvidenceSources(task)).sort((left, right) => evidenceQualityOrder(left.quality) - evidenceQualityOrder(right.quality));
  const participatingSources = task.sources.filter((source) => source.quality !== "missing");
  const evidenceCharts = charts.filter((artifact) => artifact.taskId === task.id && chartParticipates(participatingSources, artifact));
  const limitations = isSatelliteConditionObservation(task)
    ? task.limitations.filter((limitation) => !limitation.includes("可能产生相似光谱表现") && !limitation.includes("缺少同期现场记录"))
    : task.limitations;
  const publicLimitations = [...new Set(limitations.map(userFacingLimitation))];
  return <div className="panel-scroll-new result-scroll evidence-view">
    <header className="evidence-head"><button className="plain-icon" title="返回分析结果" aria-label="返回分析结果" onClick={onBack}><CaretLeft size={19} /></button><div><h3>依据与数据</h3></div></header>

    <section className="evidence-block">
      <header><h4>数据来源</h4></header>
      <div className="evidence-sources">{sourceGroups.length ? sourceGroups.map((group) => <details key={`${group.source}-${group.role}`}>
        <summary><span className={`source-mark is-${group.quality}`} /><span><strong>{analysisSourceName(group.source)}</strong><small>{group.dateLabel}</small></span><b>{evidenceQualityLabel(group.quality)}</b></summary>
        <div>{group.notes.map((note) => <p key={note}>{note}</p>)}</div>
      </details>) : <p className="evidence-empty">本次任务没有登记可用数据来源。</p>}</div>
    </section>

    {evidenceCharts.length ? <details className="evidence-disclosure"><summary><span><strong>参与本次判断的图表</strong><small>其他数据仍保留在地块数据目录</small></span><b>{evidenceCharts.length} 项</b></summary><AnalysisCharts artifacts={evidenceCharts} /></details> : null}

    {publicLimitations.length ? <section className="evidence-block evidence-limitations"><header><h4>方法与限制</h4><span>{publicLimitations.length} 条</span></header><ul>{publicLimitations.map((limitation) => <li key={limitation}>{limitation}</li>)}</ul></section> : null}

    {agentRun?.tools.length ? <AgentProcessDisclosure run={agentRun} label="执行过程" /> : null}

  </div>;
}

function chartParticipates(sources: AnalysisTask["sources"], artifact: ChartArtifact): boolean {
  const matchingSources = sources.filter((item) => item.source === artifact.chart.source);
  if (!matchingSources.length) return false;
  if (!artifact.sourceDates?.length) return matchingSources.some((item) => item.observedAt === "");
  return artifact.sourceDates.some((date) => matchingSources.some((item) => item.observedAt === date));
}

function taskStatusPresentation(status: AnalysisTask["status"]): { label: string; tone: "complete" | "partial" | "warning" | "running" } {
  if (status === "running") return { label: "正在分析", tone: "running" };
  if (status === "completed") return { label: "分析完成", tone: "complete" };
  if (status === "partial") return { label: "部分完成", tone: "partial" };
  if (status === "needs_input") return { label: "需要补充资料", tone: "warning" };
  if (status === "needs_data") return { label: "等待观测数据", tone: "warning" };
  if (status === "needs_review") return { label: "等待专业复核", tone: "partial" };
  return { label: "分析未完成", tone: "warning" };
}

function isSatelliteConditionObservation(task: AnalysisTask): boolean {
  if (task.objective !== "water_nitrogen_diagnosis") return false;
  const assessment = [...task.analysisResults].reverse().find((result) => result.kind === "assessment")?.result as { methodVersion?: string; assessment?: string; observation?: { variationStatus?: string } } | null | undefined;
  return Boolean(
    assessment?.methodVersion === WATER_NITROGEN_METHOD_VERSION
    && assessment.observation
    && ["variation_visible", "uniform"].includes(assessment.assessment ?? ""),
  );
}

function waterNitrogenRecordSummary(task: AnalysisTask): string {
  const observation = getWaterNitrogenObservation(task.analysisResults);
  if (!observation) return task.summary ?? "";
  const date = `观测日期 ${observation.referenceDate}。`;
  if (observation.observation.variationStatus === "uniform") return `${date}可用范围内未检出明显田内差异。`;
  return `${date}${observation.zones.length} 个田内相对低值区${observation.attentionAreaHa === null ? "，面积未计算" : `，约 ${observation.attentionAreaHa.toFixed(2)} 公顷`}。${observation.evidenceLevel === "field_comparison" ? "已关联同期现场对照记录。" : observation.evidenceLevel === "multi_source" ? "已完成多源数据对比。" : "已完成同日光学差异计算。"}`;
}

function isLegacyWaterNitrogenTask(task: AnalysisTask): boolean {
  return task.objective === "water_nitrogen_diagnosis"
    && ["completed", "partial"].includes(task.status)
    && task.analysisResults.some((result) => result.kind === "assessment" && result.result !== null)
    && !isSatelliteConditionObservation(task);
}

function LegacyTaskResult({ task, onNewAnalysis }: { task: AnalysisTask; onNewAnalysis: () => void }) {
  return <div className="panel-scroll-new legacy-task-result">
    <span>历史试验任务</span>
    <h3>这条结果已停止使用</h3>
    <p>早期版本曾把单期指数低值或未对齐数据组织成水氮判断。当前版本先回答哪里、何时发生了变化，再给出可能原因和现场核查顺序，不再沿用这条旧结论。</p>
    <dl><div><dt>任务时间</dt><dd>{formatDateTime(task.createdAt)}</dd></div><div><dt>原任务</dt><dd>水氮协同诊断</dd></div></dl>
    <button className="drawer-primary" onClick={onNewAnalysis}><ArrowClockwise size={17} />按当前方法重新分析</button>
  </div>;
}

function unavailableTaskPresentation(task: AnalysisTask): { title: string; description: string } {
  if (task.status === "failed") return {
    title: "分析任务未完成",
    description: userFacingLimitation(task.summary ?? task.limitations[0] ?? "分析工具未能完成本次任务。"),
  };
  if (task.objective === "waterlogging_detection") return {
    title: /天气|降雨/.test(`${task.summary} ${task.limitations.join(" ")}`) ? "还缺连续降雨资料" : "还缺一组可比雷达影像",
    description: userFacingLimitation(task.limitations[0] ?? task.summary ?? "获得同轨、同极化的前后两期雷达观测后，系统会继续识别疑似积水范围。"),
  };
  if (task.objective === "frost_risk_warning") {
    const hasForecast = task.sources.some((source) => source.source === "ecmwf-ifs" && source.quality !== "missing");
    const hasPlantingDate = task.sources.some((source) => source.source === "field_record" && source.quality !== "missing");
    if (!hasForecast) return {
      title: "暂时没有未来低温预报",
      description: "获得最新天气预报后，系统会结合当前生育期评估未来几天的霜冻风险。",
    };
    if (!hasPlantingDate) return {
      title: "还缺播种日期",
      description: "记录播种日期后，系统会估计当前生育期并完成霜冻风险判断。",
    };
    return {
      title: "霜冻预警数据还不完整",
      description: userFacingLimitation(task.summary ?? task.limitations[0] ?? "补齐预报和生育期数据后再继续分析。"),
    };
  }
  if (task.objective === "water_nitrogen_diagnosis") return {
    title: "还没有可用的田况影像",
    description: "获得地块内有效的光学观测后，系统会显示需要优先巡查的田内差异区域。",
  };
  const optical = task.analysisResults.find((result) => result.kind === "optical_condition" && result.result && (result.status === "succeeded" || result.status === "partial"));
  const opticalPayload = optical?.result as { observations?: Array<{ observationDate?: string }> } | null | undefined;
  const usableObservationCount = opticalPayload?.observations?.filter((observation) => typeof observation.observationDate === "string").length ?? 0;
  if (usableObservationCount > 0) return {
    title: "已有田况观测，尚缺生育期",
    description: `已生成 ${usableObservationCount} 期光学田况和田内差异；补充播种日期后才能判断其对应的关键生育期。`,
  };
  return {
    title: "还没有可用的长势观测",
    description: "获得合格光学影像和播种日期后，系统会继续估计生育期并显示田内长势差异。",
  };
}

function taskImpactfulLimitation(task: AnalysisTask): string | null {
  if (task.status === "completed") return null;
  if (task.status === "needs_review") return userFacingLimitation(task.limitations.at(-1) ?? "当前结果需要完成专业复核后发布。");
  if (task.status === "partial") return task.limitations[0] ? userFacingLimitation(task.limitations[0]) : null;
  return task.limitations[0] ? userFacingLimitation(task.limitations[0]) : null;
}

function taskEvidenceSources(task: AnalysisTask): AnalysisTask["sources"] {
  const sources = [...task.sources];
  if (task.status === "failed") return sources;
  const hasUsable = (source: string) => sources.some((item) => item.source === source && item.quality !== "missing");
  const addMissing = (source: string, note: string, role: NonNullable<AnalysisTask["sources"][number]["role"]> = "observation") => {
    if (!sources.some((item) => item.source === source && item.quality === "missing" && (item.role ?? "observation") === role)) {
      sources.push({ source, observedAt: "", quality: "missing", note, role });
    }
  };

  if (task.objective === "frost_risk_warning") {
    if (!hasUsable("ecmwf-ifs")) addMissing("ecmwf-ifs", "还没有覆盖本次预警窗口的未来低温预报。");
    if (!hasUsable("field_record")) addMissing("field_record", "还没有可用于估计当前生育期的播种日期。", "context");
  } else if (task.objective === "waterlogging_detection") {
    const usableRadarDates = uniqueDates(sources.filter((item) => item.source === "sentinel-1" && item.quality !== "missing").map((item) => item.observedAt));
    if (usableRadarDates.length < 2) addMissing("sentinel-1", "还缺少一组同轨、同极化的前后雷达观测。", "comparison");
    if (/天气|降雨/.test(`${task.summary ?? ""} ${task.limitations.join(" ")}`) && !hasUsable("era5-land")) {
      addMissing("era5-land", "还没有覆盖雷达对比时段的连续降雨资料。", "context");
    }
  } else if ((task.objective === "growth_stage_monitoring" || task.objective === "water_nitrogen_diagnosis") && !hasUsable("sentinel-2")) {
    addMissing("sentinel-2", "还没有满足地块覆盖和有效像元要求的光学影像。");
  }
  return sources;
}

function userFacingLimitation(value: string): string {
  const technical = /Traceback|\bFile ["']|rasterio|CPLE_|[A-Z]:\\|\/apps\/|Error:/i.test(value) || value.includes("\n");
  return technical ? "分析工具未能读取本次数据，请更新地块数据后重新分析。" : value;
}

function uniqueDates(values: string[]): string[] {
  return [...new Set(values.filter(Boolean).map((value) => value.slice(0, 10)))].sort();
}

function formatShortDate(value: string): string {
  const [, month, day] = value.slice(0, 10).split("-");
  return month && day ? `${Number(month)}月${Number(day)}日` : value;
}

function groupTaskSources(sources: AnalysisTask["sources"]) {
  const groups = new Map<string, AnalysisTask["sources"]>();
  for (const source of sources) {
    const role = source.role ?? "observation";
    const key = `${source.source}:${role}`;
    groups.set(key, [...(groups.get(key) ?? []), source]);
  }
  return [...groups.values()].map((items) => {
    const source = items[0]!.source;
    const role = items[0]!.role ?? "observation";
    const usableDates = uniqueDates(items.filter((item) => item.quality !== "missing").map((item) => item.observedAt));
    const missingDates = uniqueDates(items.filter((item) => item.quality === "missing").map((item) => item.observedAt));
    const qualities = new Set(items.map((item) => item.quality));
    const quality: AnalysisTask["sources"][number]["quality"] = qualities.has("missing") && qualities.size === 1 ? "missing" : qualities.has("partial") || qualities.has("missing") ? "partial" : "usable";
    const dateLabel = usableDates.length > 1
      ? `${usableDates.length} 个可用日期 · 最近 ${formatShortDate(usableDates.at(-1)!)}`
      : usableDates.length === 1
        ? `${formatShortDate(usableDates[0]!)}${missingDates.length ? ` 可用 · ${missingDates.length} 个日期不可用` : ""}`
        : missingDates.length
          ? `${missingDates.length} 个日期不可用`
          : quality === "missing" ? "暂未获取" : "静态背景";
    return { source, role, quality, dateLabel, notes: [...new Set(items.map((item) => item.note).filter(Boolean))] };
  });
}

function evidenceQualityOrder(quality: "usable" | "partial" | "missing"): number {
  return quality === "missing" ? 0 : quality === "partial" ? 1 : 2;
}

function evidenceQualityLabel(quality: "usable" | "partial" | "missing"): string {
  return quality === "missing" ? "缺失" : quality === "partial" ? "部分使用" : "已使用";
}

function analysisSourceName(source: string): string {
  if (source === "sentinel-2") return "Sentinel-2 光学";
  if (source === "sentinel-1") return "Sentinel-1 雷达";
  if (source === "copernicus-dem") return "Copernicus DEM 地形";
  if (source === "era5-land") return "ERA5-Land 历史天气";
  if (source === "ecmwf-ifs") return "ECMWF IFS 天气预报";
  if (source === "soilgrids-250m") return "SoilGrids 土壤背景";
  if (source === "field_record") return "地块种植记录";
  if (source === "field_observation") return "同期现场记录";
  return source;
}

function AnalysisCharts({ artifacts }: { artifacts: ChartArtifact[] }) {
  if (!artifacts.length) return null;
  const groups = artifacts.reduce<Map<string, typeof artifacts>>((current, artifact) => {
    current.set(artifact.chart.source, [...(current.get(artifact.chart.source) ?? []), artifact]);
    return current;
  }, new Map());
  return <section className="result-section analysis-charts">
    <div className="result-section-head"><div><span className="result-section-index">图</span><h4>环境背景</h4></div><span className="result-section-count">{groups.size} 个数据源</span></div>
    <div className="analysis-chart-sources">{[...groups.entries()].map(([source, sourceArtifacts]) => <section className="analysis-chart-source" key={source}>
      <header className="analysis-chart-source-head"><strong>{chartSourceName(source)}</strong><span>{chartSourceScale(source)}</span></header>
      <div className="analysis-chart-list">{sourceArtifacts.map((artifact) => {
        const values = artifact.chart.series.flatMap((series) => series.points.map((point) => point.value));
        const maximum = Math.max(...values.map((value) => Math.abs(value)), 0.0001);
        return <article key={artifact.ref} className="analysis-chart-card">
          <header><strong>{artifact.chart.title}</strong><span>{formatChartDates(artifact.sourceDates)}{artifact.sourceDates?.length ? " · " : ""}{artifact.chart.unit}</span></header>
          {artifact.chart.series.flatMap((series) => series.points.map((point) => <div className="analysis-chart-row" key={`${series.label}-${point.label}`}>
            <span title={point.label}>{formatChartPointLabel(point.label)}</span><div><i className={point.value < 0 ? "is-negative" : ""} style={{ width: `${Math.max(3, Math.abs(point.value) / maximum * 100)}%` }} /></div><strong>{formatChartValue(point.value)}</strong>
          </div>))}
        </article>;
      })}</div>
    </section>)}</div>
  </section>;
}

function MapObservationLegend({ layer }: { layer: MapVisualizationLayer }) {
  return <section className="map-observation-legend" aria-label="当前地图图层图例">
    <header><strong>{layer.label}</strong><time>{layer.date === "static" ? "静态背景" : compactMapDate(layer.date)}</time></header>
    {layer.metric === "true_color"
      ? <div className="map-true-color-caption"><i className="visualization-gradient is-true_color" /><span>Sentinel-2 真彩色</span></div>
      : <><div className="map-observation-scale"><span>{layer.min.toFixed(2)}</span><i className={`visualization-gradient is-${layer.metric}`} /><span>{layer.max.toFixed(2)}</span></div><small>{layer.unit === "index" ? "地块内相对指数" : layer.unit}</small></>}
  </section>;
}

function MapLayerMenu({ layers, selected, loading, error, overlays, hasTask, hasScoutingNotes, hasNitrogenZones, onToggle, onLocate, onSelect }: { layers: MapVisualizationLayer[]; selected: MapVisualizationLayer | null; loading: boolean; error: string | null; overlays: { fieldBoundary: boolean; taskFindings: boolean; scoutingNotes: boolean; nitrogenZones: boolean }; hasTask: boolean; hasScoutingNotes: boolean; hasNitrogenZones: boolean; onToggle: (key: "fieldBoundary" | "taskFindings" | "scoutingNotes" | "nitrogenZones") => void; onLocate: () => void; onSelect: (layer: MapVisualizationLayer | null) => void }) {
  const sources = [...new Set(layers.map((layer) => layer.source))];
  const selectedSource = selected?.source ?? sources[0];
  const sourceLayers = layers.filter((layer) => layer.source === selectedSource);
  const dates = [...new Set(sourceLayers.map((layer) => layer.date))].sort((left, right) => right.localeCompare(left));
  const selectedDate = selected && selected.source === selectedSource ? selected.date : dates[0];
  const dateLayers = sourceLayers.filter((layer) => layer.date === selectedDate);

  const overlay = (key: "fieldBoundary" | "taskFindings" | "scoutingNotes" | "nitrogenZones", label: string, detail: string, available = true) => <button className={`map-tool-toggle${overlays[key] ? " is-on" : ""}${!available ? " is-disabled" : ""}`} aria-pressed={available && overlays[key]} disabled={!available} onClick={() => onToggle(key)}><span><b>{label}</b><small>{detail}</small></span><i aria-hidden="true" /></button>;

  return <section className="map-layer-menu spatial-tool-menu" aria-label="地图图层">
    <header className="spatial-tool-head"><div><strong>地图图层</strong></div><button className="spatial-locate" title="回到当前农田" aria-label="回到当前农田" onClick={onLocate}><Crosshair size={15} /></button></header>
    <section className="spatial-tool-section"><header><strong>底图</strong><span>背景</span></header><button className={`map-basemap-option${selected ? "" : " is-active"}`} aria-pressed={!selected} onClick={() => onSelect(null)}><span><b>卫星底图</b><small>当前影像背景</small></span><i /></button></section>
    <section className="spatial-tool-section"><header><strong>空间对象</strong><span>叠加显示</span></header>
      {overlay("fieldBoundary", "地块边界", "当前农田与其他地块")}
      {overlay("taskFindings", "任务结果", hasTask ? "异常区与任务标记" : "运行任务后显示", hasTask)}
      {overlay("scoutingNotes", "巡田记录", hasScoutingNotes ? "现场记录点位" : "还没有巡田记录", hasScoutingNotes)}
      {overlay("nitrogenZones", "施氮分区", hasNitrogenZones ? "候选管理区" : "生成方案后显示", hasNitrogenZones)}
    </section>
    <section className="spatial-tool-section spatial-observation-section"><header><strong>农情观测</strong><span>{selected ? `${visualizationSourceLabel(selected.source)} · ${compactMapDate(selected.date)}` : "选择一层查看"}</span></header>
      {loading ? <p className="map-layer-empty">正在加载观测图层...</p> : error ? <p className="map-layer-empty is-error">{error}</p> : layers.length === 0 ? <p className="map-layer-empty">暂无可用观测图层</p> : <>
        <div className="map-layer-sources" aria-label="选择观测来源">{sources.map((source) => <button key={source} className={source === selectedSource ? "is-active" : ""} onClick={() => { const nextLayer = layers.filter((layer) => layer.source === source).sort((left, right) => right.date.localeCompare(left.date))[0]; if (nextLayer) onSelect(nextLayer); }}>{visualizationSourceLabel(source)}</button>)}</div>
        {dates.length ? <div className="map-layer-date" aria-label="选择观测日期"><div>{dates.map((date) => <button key={date} className={date === selectedDate ? "is-active" : ""} title={date} onClick={() => { const layer = sourceLayers.find((item) => item.date === date && item.metric === selected?.metric) ?? sourceLayers.find((item) => item.date === date); if (layer) onSelect(layer); }}><time dateTime={date}>{compactMapDate(date)}</time></button>)}</div></div> : null}
        <div className="map-layer-metrics" aria-label="选择观测指标">{dateLayers.map((layer) => <button key={layer.ref} className={layer.ref === selected?.ref ? "is-active" : ""} aria-pressed={layer.ref === selected?.ref} onClick={() => onSelect(layer)}><b>{layer.label}</b><i className={`visualization-gradient is-${layer.metric}`} /></button>)}</div>
        {selected ? selected.metric === "true_color" ? <div className="map-layer-scale is-true-color"><i className="visualization-gradient is-true_color" /><small>Sentinel-2 真彩色 · 10 m</small></div> : <div className="map-layer-scale"><small>{selected.min.toFixed(2)}</small><i className={`visualization-gradient is-${selected.metric}`} /><small>{selected.max.toFixed(2)} {selected.unit}</small></div> : null}
      </>}
    </section>
    <p className="spatial-tool-note">天气和土壤作为时间或地块背景展示，不直接生成田内分区。</p>
  </section>;
}

function visualizationSourceLabel(source: string): string {
  if (source === "sentinel-2") return "光学";
  if (source === "sentinel-1") return "雷达";
  if (source === "copernicus-dem") return "地形";
  return source;
}

function compactMapDate(date: string): string {
  const [, month, day] = date.split("-");
  return month && day ? `${Number(month)}/${Number(day)}` : date;
}

function dateOffsetDays(left: string, right: string): number {
  const leftTime = Date.parse(`${left.slice(0, 10)}T00:00:00Z`);
  const rightTime = Date.parse(`${right.slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(leftTime) && Number.isFinite(rightTime) ? (leftTime - rightTime) / 86_400_000 : Number.POSITIVE_INFINITY;
}

function StatusDot({ status }: { status: FieldSummary["latestStatus"] }) { const label = status === "watch" ? "需关注" : status === "normal" ? "已分析" : "未分析"; return <span className={`status-dot status-${status}`}><i />{label}</span>; }
function FieldSkeleton() { return <div className="skeleton-list" aria-label="正在加载农田">{[0,1,2].map((item) => <div key={item} className="skeleton-row" />)}</div>; }
function NoFieldSelected() { return <div className="empty-panel"><MapPin size={30} /><strong>请选择地块</strong><span>从左侧选择一块农田后查看田况或发起分析</span></div>; }
function cropName(crop: FieldSummary["crop"]): string { return crop === "corn" ? "玉米" : crop === "soybean" ? "大豆" : "水稻"; }
function chartSourceName(source: string): string { return source === "era5-land" ? "ERA5-Land" : source === "ecmwf-ifs" ? "ECMWF IFS" : source === "soilgrids-250m" ? "SoilGrids 250m" : source; }
function chartSourceScale(source: string): string { return source === "era5-land" ? "0.1° · 地块周边历史背景" : source === "ecmwf-ifs" ? "0.25° · 地块邻近格点预报" : source === "soilgrids-250m" ? "250 m · 土壤背景" : "环境数据"; }
function formatChartValue(value: number): string { return Math.abs(value) >= 100 ? value.toFixed(0) : Math.abs(value) >= 10 ? value.toFixed(1) : value.toFixed(2); }
function formatChartPointLabel(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return match ? `${Number(match[2])}/${Number(match[3])}` : value;
}
function formatChartDates(dates: string[] | undefined): string {
  const values = [...new Set(dates ?? [])].sort();
  if (!values.length) return "";
  const compact = (value: string) => {
    const [, month, day] = value.split("-");
    return month && day ? `${Number(month)}/${Number(day)}` : value;
  };
  return values.length === 1 ? compact(values[0]!) : `${compact(values[0]!)}–${compact(values.at(-1)!)}`;
}
function uniqueChartArtifacts(items: ChartArtifact[]): ChartArtifact[] {
  const charts = new Map<string, ChartArtifact>();
  for (const artifact of items) {
    const key = `${artifact.chart.source}:${chartCatalogTitle(artifact.chart.title)}`;
    if (!charts.has(key)) charts.set(key, artifact);
  }
  return [...charts.values()];
}
function chartCatalogTitle(title: string): string {
  if (title === "历史最低气温" || title === "历史气温") return "历史气温";
  if (title === "预报最低气温" || title === "预报气温") return "预报气温";
  return title;
}
function uniqueVisualizationLayers(items: MapVisualizationLayer[]): MapVisualizationLayer[] {
  const layers = new Map<string, MapVisualizationLayer>();
  for (const item of items) {
    const key = `${item.taskId}:${item.source}:${item.date}:${item.metric}`;
    if (!layers.has(key)) layers.set(key, item);
  }
  return [...layers.values()];
}
function formatDateTime(value: string): string { return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }
function artifactUrl(ref: string): string { return `/api/v1/artifacts/${ref.split("/").map(encodeURIComponent).join("/")}`; }
