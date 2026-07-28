export type CropCode = "corn" | "soybean" | "rice";
export type AnalysisObjective = "current_condition" | "recent_change" | "within_field" | "season_trend";
export type TaskStatus = "planned" | "running" | "needs_input" | "completed" | "failed";

export interface Position {
  longitude: number;
  latitude: number;
}

export interface FieldSummary {
  id: string;
  code: string;
  name: string;
  areaHa: number;
  village: string;
  crop: CropCode;
  seasonYear: number;
  plantingDate: string | null;
  variety: string | null;
  centroid: Position;
  boundary: Position[];
  latestStatus: "normal" | "watch" | "not_analyzed";
  latestAnalyzedAt: string | null;
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

export interface CreateAnalysisTaskRequest {
  fieldId: string;
  crop: CropCode;
  period: "last_30_days" | "this_season" | "custom";
  objective: AnalysisObjective;
}

export interface PlanetAccessStatus {
  configured: boolean;
  reachable: boolean;
  planetScopeAvailable: boolean;
  itemTypes: string[];
  message: string;
}

export interface AnalysisFinding {
  id: string;
  title: string;
  summary: string;
  severity: "normal" | "watch";
  areaHa: number | null;
  evidenceDates: string[];
  zone: Position[] | null;
}

export interface AnalysisTask {
  id: string;
  fieldId: string;
  status: TaskStatus;
  progress: number;
  stage: string;
  createdAt: string;
  completedAt: string | null;
  demoData: boolean;
  summary: string | null;
  findings: AnalysisFinding[];
  evidence: Array<{
    source: string;
    observedAt: string;
    quality: "usable" | "partial";
    note: string;
  }>;
}
