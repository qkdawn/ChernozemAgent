export const WATER_NITROGEN_METHOD_VERSION = "water-nitrogen-v5" as const;
export type CropCode = "corn" | "soybean" | "rice";
export type AnalysisObjective = "growth_stage_monitoring" | "water_nitrogen_diagnosis" | "waterlogging_detection" | "frost_risk_warning";
export type TaskStatus = "planned" | "running" | "needs_input" | "needs_data" | "needs_review" | "partial" | "completed" | "failed" | "cancelled";
export type VisualizationMetric =
  | "true_color"
  | "ndvi"
  | "ndvi_contrast"
  | "ndre"
  | "reci"
  | "msavi"
  | "ndmi"
  | "ndwi"
  | "vv"
  | "vh"
  | "radar_change"
  | "elevation"
  | "slope"
  | "lowland";

export interface AnalysisChart {
  source: string;
  title: string;
  unit: string;
  series: Array<{
    label: string;
    points: Array<{ label: string; value: number }>;
  }>;
}

export interface AnalysisArtifact {
  ref: string;
  kind: "map" | "chart" | "table";
  visualization?: {
    type: "raster";
    source: string;
    metric: VisualizationMetric;
    date: string;
    bounds: [[number, number], [number, number], [number, number], [number, number]];
    min: number;
    max: number;
    resolutionMeters: number;
    unit: string;
    label: string;
  };
  chart?: AnalysisChart;
}

export interface FieldMapLayer {
  ref: string;
  taskId: string;
  objective: AnalysisObjective;
  createdAt: string;
  visualization: NonNullable<AnalysisArtifact["visualization"]>;
}

export interface FieldChartArtifact {
  ref: string;
  taskId: string;
  objective: AnalysisObjective;
  createdAt: string;
  sourceDates: string[];
  chart: AnalysisChart;
}

export interface FieldVisualizationCatalog {
  layers: FieldMapLayer[];
  charts: FieldChartArtifact[];
}

export type AnalysisToolName =
  | "analyze_optical_condition"
  | "estimate_crop_stage"
  | "assess_growth_status"
  | "analyze_radar_change"
  | "analyze_weather_event"
  | "analyze_terrain_susceptibility"
  | "get_soil_background"
  | "assess_water_nitrogen_evidence"
  | "detect_waterlogging"
  | "assess_frost_risk";

export interface AnalysisExecution {
  toolName: AnalysisToolName | "search_agronomy_knowledge";
  scope: {
    fieldId: string;
    boundaryVersion: number;
    timeRange: AnalysisTimeRange | null;
  };
  inputs: {
    acquisitionIds: string[];
    assetIds: string[];
    resultIds: string[];
  };
  parameters: Record<string, string | number | boolean | null>;
  inputFingerprint: string;
}

export interface AnalysisResult<T> {
  id: string;
  taskId: string;
  kind: "optical_condition" | "radar_change" | "weather_event" | "terrain_susceptibility" | "soil_background" | "crop_stage" | "assessment" | "knowledge_context";
  status: "succeeded" | "partial" | "needs_input" | "needs_data" | "needs_review" | "failed";
  toolVersion: string;
  createdAt: string;
  execution: AnalysisExecution;
  summary: string;
  result: T | null;
  sources: Array<{
    source: string;
    date: string | null;
    quality: "usable" | "partial" | "missing";
    note: string;
    role?: "observation" | "comparison" | "context" | "field_check";
  }>;
  findings: Array<{
    id: string;
    summary: string;
    sourceDates: Array<{ source: string; date: string | null }>;
    zoneRef: string | null;
  }>;
  artifacts: AnalysisArtifact[];
  limitations: string[];
  nextActions: AnalysisNextAction[];
  error: { code: string; message: string; retryable: boolean } | null;
}

export interface AnalysisBriefEvidence {
  statement: string;
  sourceDates: Array<{ source: string; date: string | null }>;
  /** RFC 6901 pointers into the persisted result payload, not provider responses. */
  references?: Array<{ resultId: string; path: string }>;
  /** Published original passages explain observations; they are not field measurements. */
  knowledgeCitations?: AgronomyKnowledgeCitation[];
}

export interface AnalysisBriefAction {
  label: string;
  /** The unresolved question this action is intended to answer. */
  purpose?: string;
  /** How the observation changes the next diagnosis or action. */
  decisionEffect?: string;
  where: string | null;
  timing: string | null;
  checklist: string[];
  zoneRef?: string;
}

export interface AnalysisBriefDocumentItem {
  label: string;
  text: string;
  zoneRef?: string;
}

export interface AnalysisBriefDocumentSection {
  id: string;
  title: string;
  paragraphs: string[];
  items?: AnalysisBriefDocumentItem[];
}

export type AnalysisBriefFallbackReason = "model_error" | "malformed_output" | "unsafe_output";

export interface AnalysisBriefGeneration {
  mode: "deterministic" | "model_generated";
  generatedAt: string;
  provider: string | null;
  modelId: string | null;
  promptVersion: string | null;
  fallbackReason: AnalysisBriefFallbackReason | null;
}

/** User-facing interpretation derived only from the task's structured analysis results. */
export interface AnalysisBrief {
  version: "analysis-brief-v2";
  headline: string;
  overview: string;
  reasoning: string;
  uncertainty: string | null;
  evidence: AnalysisBriefEvidence[];
  actions: AnalysisBriefAction[];
  /** A task-specific, printable document assembled from the same evidence chain. */
  document?: {
    title: string;
    subtitle: string;
    sections: AnalysisBriefDocumentSection[];
  };
  generation: AnalysisBriefGeneration;
  /** Generated agronomic prescriptions remain a draft until professional review. */
  reviewRequired?: boolean;
}


export interface Position {
  longitude: number;
  latitude: number;
}

export interface FieldSummary {
  id: string;
  organizationId: string;
  code: string;
  name: string;
  areaHa: number;
  village: string;
  crop: CropCode;
  seasonYear: number;
  plantingDate: string | null;
  variety: string | null;
  boundaryVersion: number;
  seasonCount: number;
  centroid: Position;
  boundary: Position[];
  latestStatus: "normal" | "watch" | "not_analyzed";
  latestAnalyzedAt: string | null;
}

export interface FieldHistory {
  fieldId: string;
  boundaryVersions: Array<{ version: number; createdAt: string }>;
  seasons: Array<{
    id: string;
    crop: CropCode;
    seasonYear: number;
    plantingDate: string | null;
    variety: string | null;
    updatedAt: string;
  }>;
}

export interface FieldInput {
  name: string;
  crop: CropCode;
  seasonYear: number;
  plantingDate?: string | null;
  variety?: string | null;
  boundary: Position[];
}

export interface FieldUpdateInput {
  name?: string;
  crop?: CropCode;
  seasonYear?: number;
  plantingDate?: string | null;
  variety?: string | null;
  boundary?: Position[];
}

export interface ImportedFieldInput extends FieldInput {
  sourceName?: string;
}

export type DataProfile = "field_baseline_v1" | "growth_stage_v1" | "water_nitrogen_v1" | "waterlogging_v1" | "frost_risk_v1";
export type DataSourceType = "optical" | "radar" | "terrain" | "weather-historical" | "weather-forecast" | "soil";
export type DataSource = "sentinel-1" | "sentinel-2" | "copernicus-dem" | "era5-land" | "ecmwf-ifs" | "soilgrids-250m";
export type AcquisitionRunStatus = "planned" | "running" | "needs_input" | "partial" | "completed" | "failed";
export type SourceAcquisitionStatus = "succeeded" | "partial" | "needs_input" | "failed";
export type AcquisitionSourceStage = "queued" | "discovering" | "downloading" | "validating" | "completed" | "failed";

export interface AcquisitionPeriod {
  start: string;
  end: string;
}

export interface CreateDataAcquisitionRequest {
  fieldId: string;
  boundaryVersion: number;
  period: AcquisitionPeriod;
  dataProfile: DataProfile;
}

export interface AnalysisNextAction {
  code: string;
  label: string;
  zoneRef?: string;
  acquisitionRequest?: CreateDataAcquisitionRequest;
}

export interface AcquiredAsset {
  id: string;
  providerAssetId: string;
  role: "spectral" | "quality-mask" | "radar" | "dem" | "weather-series" | "soil" | "metadata";
  capturedAt: string | null;
  validFrom: string | null;
  validTo: string | null;
  generatedAt: string | null;
  retrievedAt: string | null;
  spatialResolutionMeters: number | null;
  crs: string | null;
  format: string;
  byteSize: number | null;
  checksum: string | null;
  artifactRef: string | null;
  accessStatus: "discovered" | "authorized" | "retrieved";
}

export interface SourceAcquisitionResult {
  sourceType: DataSourceType;
  source: DataSource;
  provider: string;
  product: string;
  status: SourceAcquisitionStatus;
  requestedPeriod: AcquisitionPeriod | null;
  discoveredAt: string;
  retrievedAt: string | null;
  availableDates: string[];
  selectedObservationDates: string[];
  selectedAssets: AcquiredAsset[];
  coverage: {
    requestedAreaHa: number | null;
    coveredAreaFraction: number | null;
  };
  quality: {
    flags: string[];
    metadata: Record<string, string | number | boolean | null>;
  };
  license: {
    access: "public" | "licensed" | "restricted" | "unknown";
    downloadAllowed: boolean;
    attribution: string | null;
  };
  limitations: string[];
  error: {
    code: string | null;
    retryable: boolean;
    message: string | null;
  };
}

export interface DataAcquisitionRun {
  id: string;
  fieldId: string;
  boundaryVersion: number;
  period: AcquisitionPeriod;
  dataProfile: DataProfile;
  dataProfileVersion: string;
  status: AcquisitionRunStatus;
  createdAt: string;
  completedAt: string | null;
  manifestVersion: string;
  sources: SourceAcquisitionResult[];
  progress: Array<{
    source: DataSource;
    stage: AcquisitionSourceStage;
    message: string;
    updatedAt: string;
  }>;
  error?: {
    code: string;
    retryable: boolean;
    message: string;
  } | null;
}

export interface AcquisitionDateMatch {
  source: DataSource;
  targetDate: string;
  matchType: "nearest" | "covering" | "static" | "none";
  matchedDate: string | null;
  validPeriod: AcquisitionPeriod | null;
  offsetDays: number | null;
  status: "retrieved" | "available" | "limited" | "failed" | "unavailable";
  runId: string | null;
  detail: string;
}

export interface CreateAnalysisTaskRequest {
  fieldId: string;
  crop: CropCode;
  period: "last_30_days" | "this_season" | "custom";
  timeRange?: AcquisitionPeriod;
  objective: AnalysisObjective;
  /** The user's original request. It is passed to the scoped Agent and never treated as tool input. */
  message?: string;
  /** Field notes to use for an explicit follow-up diagnosis; history is never auto-included. */
  scoutingNoteIds?: string[];
  /** Completed task whose paired low-value/reference inspections should be used for follow-up. */
  inspectionTaskId?: string;
}

export interface CreateAgentAnalysisPlanRequest {
  fieldId: string;
  message: string;
  periodHint?: "last_30_days" | "this_season";
}

export interface AgentAnalysisPlan {
  objective: AnalysisObjective;
  period: "last_30_days" | "this_season";
}

export type AnalysisTimeRange = AcquisitionPeriod;

export interface AnalysisFinding {
  id: string;
  title: string;
  summary: string;
  severity: "normal" | "watch";
  findingType?: "observation_zone" | "candidate_zone" | "field_observation" | "other";
  scoutingRole?: FieldScoutingRole;
  areaHa: number | null;
  sourceDates: string[];
  zone: Position[] | null;
  zoneHoles?: Position[][];
}

export type FieldInspectionStatus = "checked";
export type FieldScoutingRole = "low_value" | "reference" | "general";
export type FieldWaterCondition = "dry" | "normal" | "wet" | "standing_water" | "unknown";
export type FieldLeafColor = "normal" | "pale" | "dark_green" | "unknown";
export type FieldDiseaseOrPest = "none_seen" | "suspected" | "unknown";

export interface FieldInspectionRecord {
  id: string;
  taskId: string;
  findingId: string;
  scoutingRole: FieldScoutingRole;
  status: FieldInspectionStatus;
  checkedAt: string;
  observedAt: string;
  location: Position;
  waterCondition: FieldWaterCondition;
  leafColor: FieldLeafColor;
  diseaseOrPest: FieldDiseaseOrPest;
  note: string;
}

export type SaveFieldInspectionRequest = Pick<FieldInspectionRecord, "observedAt" | "location" | "waterCondition" | "leafColor" | "diseaseOrPest" | "note">;

export interface FieldScoutingNote {
  id: string;
  fieldId: string;
  observedAt: string;
  location: Position;
  waterCondition: FieldWaterCondition;
  leafColor: FieldLeafColor;
  diseaseOrPest: FieldDiseaseOrPest;
  note: string;
  createdAt: string;
}

export type SaveFieldScoutingNoteRequest = Pick<FieldScoutingNote, "observedAt" | "location" | "waterCondition" | "leafColor" | "diseaseOrPest" | "note">;

export type NitrogenManagementLevel = "low" | "medium" | "high";
export type NitrogenPrescriptionStatus = "needs_review";

export interface VariableNitrogenZone {
  id: string;
  level: NitrogenManagementLevel;
  label: string;
  meanNdvi: number;
  areaHa: number;
  productRateKgHa: number;
  nitrogenRateKgHa: number;
  totalProductKg: number;
  totalNitrogenKg: number;
  polygons: Position[][];
}

export interface VariableNitrogenPrescription {
  id: string;
  fieldId: string;
  boundaryVersion: number;
  status: NitrogenPrescriptionStatus;
  sourceTaskId: string;
  sourceDate: string;
  sourceMetric: "ndvi";
  fertilizerName: string;
  nitrogenPercent: number;
  standardRateKgHa: number;
  zones: VariableNitrogenZone[];
  totalAreaHa: number;
  totalProductKg: number;
  totalNitrogenKg: number;
  uniformProductKg: number;
  productDifferenceKg: number;
  createdAt: string;
  updatedAt: string;
}

export interface VariableNitrogenSourceOption {
  sourceTaskId: string;
  sourceDate: string;
  meanNdvi: number;
  zoneCount: number;
  createdAt: string;
  zones: Array<Pick<VariableNitrogenZone, "id" | "level" | "label" | "meanNdvi" | "areaHa" | "polygons">>;
}

export interface CreateVariableNitrogenPrescriptionRequest {
  sourceTaskId: string;
  sourceDate: string;
  fertilizerName: string;
  nitrogenPercent: number;
  standardRateKgHa: number;
  rates: Record<NitrogenManagementLevel, number>;
}

export interface AnalysisTask {
  id: string;
  fieldId: string;
  /** Present on new tasks; omitted only by records created before boundary-scoped tasks. */
  boundaryVersion?: number;
  objective: AnalysisObjective;
  requestMessage?: string | null;
  timeRange: AnalysisTimeRange;
  status: TaskStatus;
  progress: number;
  stage: string;
  createdAt: string;
  completedAt: string | null;
  demoData: boolean;
  summary: string | null;
  brief: AnalysisBrief | null;
  findings: AnalysisFinding[];
  sources: Array<{
    source: string;
    observedAt: string;
    quality: "usable" | "partial" | "missing";
    note: string;
    role?: "observation" | "comparison" | "context" | "field_check";
  }>;
  analysisResults: AnalysisResult<unknown>[];
  limitations: string[];
  nextActions: AnalysisNextAction[];
  failure: AnalysisTaskFailure | null;
  inspections?: FieldInspectionRecord[];
}

export interface AnalysisTaskFailure {
  code: "agent_configuration_invalid" | "agent_rate_limited" | "agent_unreachable" | "agent_incomplete" | "agent_execution_failed";
  retryable: boolean;
  message: string;
}

export type AgentRunStatus = "running" | "completed" | "failed";
export type AgentToolRunStatus = "running" | "completed" | "failed";

export interface AgentToolRun {
  sequence: number;
  toolCallId: string;
  toolName: string;
  status: AgentToolRunStatus;
  startedAt: string;
  completedAt: string | null;
  resultId: string | null;
  resultStatus: AnalysisResult<unknown>["status"] | null;
}

export interface AgentRunTrace {
  id: string;
  taskId: string;
  provider: string;
  modelId: string;
  status: AgentRunStatus;
  startedAt: string;
  completedAt: string | null;
  finalMessage: string | null;
  errorMessage: string | null;
  tools: AgentToolRun[];
}

export type TaskConversationRole = "user" | "assistant";
export type TaskConversationMessageKind = "analysis_result" | "chat";

export interface TaskConversationMessage {
  id: string;
  taskId: string;
  sequence: number;
  role: TaskConversationRole;
  kind: TaskConversationMessageKind;
  content: string;
  createdAt: string;
}

export interface CreateTaskConversationMessageRequest {
  content: string;
}

export interface FieldConversationMessage {
  id: string;
  fieldId: string;
  sequence: number;
  role: TaskConversationRole;
  content: string;
  createdAt: string;
}

export interface ConversationWorkflowPlan {
  objective: AnalysisObjective;
  period: "last_30_days" | "this_season";
  title: string;
  summary: string;
  steps: [string, string, string];
  missingInputs: string[];
  startRequest: {
    fieldId: string;
    crop: CropCode;
    period: "last_30_days" | "this_season";
    objective: AnalysisObjective;
    message: string;
  };
  requiresConfirmation: true;
}

export interface FieldConversationExchange {
  userMessage: FieldConversationMessage;
  assistantMessage: FieldConversationMessage;
  workflowPlan: ConversationWorkflowPlan | null;
  workflowStatus: ConversationWorkflowStatusResult | null;
  taskResult: ConversationTaskResult | null;
  fieldContext: ConversationFieldContext | null;
  scoutingNoteDraft: ConversationScoutingNoteDraft | null;
}

export type ConversationFieldContextFocus = "summary" | "profile" | "data" | "recent_tasks";

export interface ConversationFieldContext {
  tool: "get_field_context";
  status: "found";
  fieldId: string;
  requestedFocus: ConversationFieldContextFocus;
  checkedAt: string;
  field: {
    name: string;
    crop: CropCode;
    seasonYear: number;
    plantingDate: string | null;
    variety: string | null;
    areaHa: number;
    boundaryVersion: number;
  };
  data: {
    currentBoundaryRunCount: number;
    latestRunStatus: AcquisitionRunStatus | null;
    latestRunAt: string | null;
    sources: Array<{
      source: DataSource;
      status: SourceAcquisitionStatus;
      latestAvailableDate: string | null;
      availableDateCount: number;
      retrievedAssetCount: number;
      limitations: string[];
    }>;
  };
  recentTasks: Array<{
    id: string;
    objective: AnalysisObjective;
    status: TaskStatus;
    createdAt: string;
    completedAt: string | null;
    summary: string | null;
  }>;
  missingInputs: string[];
  message: string;
}

export type ConversationTaskResultFocus = "summary" | "locations" | "evidence" | "limitations" | "actions";

export interface ConversationTaskResult {
  tool: "get_task_result";
  status: "found" | "not_found" | "not_ready";
  fieldId: string;
  requestedObjective: AnalysisObjective | null;
  requestedFocus: ConversationTaskResultFocus;
  checkedAt: string;
  task: {
    id: string;
    objective: AnalysisObjective;
    status: TaskStatus;
    createdAt: string;
    completedAt: string | null;
    headline: string;
    overview: string;
    reasoning: string;
    uncertainty: string | null;
    findings: Array<{
      id: string;
      title: string;
      summary: string;
      severity: "normal" | "watch";
      areaHa: number | null;
      sourceDates: string[];
      hasGeometry: boolean;
    }>;
    evidence: AnalysisBriefEvidence[];
    limitations: string[];
    actions: AnalysisBriefAction[];
  } | null;
  message: string;
}

export interface ConversationScoutingNoteDraft {
  tool: "record_scouting_note";
  status: "draft";
  fieldId: string;
  observedAt: string;
  location: Position | null;
  waterCondition: FieldWaterCondition;
  leafColor: FieldLeafColor;
  diseaseOrPest: FieldDiseaseOrPest;
  note: string;
  missingInputs: string[];
  requiresConfirmation: true;
}

export interface ConversationWorkflowStatusResult {
  tool: "get_workflow_status";
  status: "found" | "not_found";
  fieldId: string;
  requestedObjective: AnalysisObjective | null;
  checkedAt: string;
  task: {
    id: string;
    objective: AnalysisObjective;
    status: TaskStatus;
    progress: number;
    stage: string;
    createdAt: string;
    completedAt: string | null;
    summary: string | null;
    nextActions: string[];
    failure: AnalysisTaskFailure | null;
  } | null;
  message: string;
}

export interface CreateFieldConversationMessageRequest {
  content: string;
}

export interface AgronomyKnowledgeCitation {
  sourceId: string;
  title: string;
  locator: string;
  sourceUrl: string | null;
  identifier: { type: "doi" | "isbn" | "standard" | "internal"; value: string } | null;
  version: string;
}

export interface AgronomyKnowledgeMatch {
  excerpt: string;
  textUnitIds: string[];
  relatedEntities: string[];
  applicability: {
    regions: string[];
    crops: CropCode[];
    stages: string[];
  };
  citation: AgronomyKnowledgeCitation;
}

export interface AgronomyKnowledgeSearchResult {
  status: "succeeded" | "no_matches" | "unavailable";
  indexRunRef: string | null;
  answer: string | null;
  matches: AgronomyKnowledgeMatch[];
  limitations: string[];
  error: { code: string; message: string; retryable: boolean } | null;
}

export type AgronomyKnowledgeScope =
  | { taskId: string; fieldId?: never }
  | { fieldId: string; taskId?: never };

export type AgronomyKnowledgeSearchInput = AgronomyKnowledgeScope & { query: string };

export type ImageryQualityFlag =
  | "valid"
  | "partial_coverage"
  | "no_coverage"
  | "cloud_contaminated"
  | "cloud_mask_unavailable"
  | "temporally_stale"
  | "spatial_mismatch"
  | "insufficient_pixels"
  | "provider_unavailable"
  | "processing_failed"
  | "not_available";

export type ImageryAssetStatus = "active" | "inactive" | "activating" | "unavailable" | "unknown";
export type ImageryAssetPermission = "download" | "none" | "unknown";

export interface ImageryAssetAccess {
  assetType: string;
  status: ImageryAssetStatus;
  permission: ImageryAssetPermission;
  expiresAt: string | null;
}

export interface OpticalScene {
  provider: "sentinel-2" | "other";
  itemType: string;
  sceneId: string;
  capturedAt: string;
  cloudCover: number | null;
  coverageFraction: number | null;
  footprint: Position[] | null;
  assets: ImageryAssetAccess[];
}

export interface SceneSearchResult {
  status: "succeeded" | "partial" | "failed";
  scenes: OpticalScene[];
  coverage: {
    timeStart: string;
    timeEnd: string;
    fieldId: string;
    requestedAreaHa: number | null;
    coveredAreaFraction: number | null;
  };
  quality: {
    flags: ImageryQualityFlag[];
    usableSceneCount: number;
    candidateSceneCount: number;
    bestCloudCover: number | null;
  };
  limitations: string[];
  error: {
    code: string | null;
    retryable: boolean;
    message: string | null;
  };
}

export interface RasterDataset {
  width: number;
  height: number;
  crs: string;
  origin: { x: number; y: number };
  pixelSize: { x: number; y: number };
  bands: Record<string, Float32Array>;
  nodata?: number | null;
  mask?: Uint8Array;
}

export interface FieldObservation {
  metric: "ndvi";
  unit: "ratio";
  value: number;
  min: number;
  max: number;
  validPixelCount: number;
  totalPixelCount: number;
  coverageFraction: number;
}

export interface DifferenceZone {
  row: number;
  column: number;
  value: number;
  class: "below_average" | "near_average" | "above_average";
  zone: Position[];
}

export interface OpticalObservationResult {
  status: "succeeded" | "partial" | "failed";
  sceneId: string;
  observationDate: string;
  fieldId: string;
  observation: FieldObservation | null;
  differenceZones: DifferenceZone[];
  quality: {
    flags: ImageryQualityFlag[];
    usableFraction: number;
  };
  limitations: string[];
  error: {
    code: string | null;
    retryable: boolean;
    message: string | null;
  };
}
