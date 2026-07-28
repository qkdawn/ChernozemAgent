import type { AnalysisTask, CreateAnalysisTaskRequest, FieldInput, FieldSummary, FieldUpdateInput, PlanetAccessStatus } from "@chernozem/contracts";

interface ApiErrorBody {
  message?: string;
}

export async function fetchFields(): Promise<FieldSummary[]> {
  const response = await fetch("/api/v1/fields");
  if (!response.ok) throw new Error("农田列表加载失败。");
  const body = (await response.json()) as { fields: FieldSummary[] };
  return body.fields;
}

export async function createField(input: FieldInput): Promise<FieldSummary> {
  const response = await fetch("/api/v1/fields", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  return fieldFromResponse(response, "地块保存失败。");
}

export async function updateField(id: string, input: FieldUpdateInput): Promise<FieldSummary> {
  const response = await fetch(`/api/v1/fields/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  return fieldFromResponse(response, "地块更新失败。");
}

export async function archiveField(id: string): Promise<void> {
  const response = await fetch(`/api/v1/fields/${id}`, { method: "DELETE" });
  if (!response.ok) throw new Error("地块归档失败。");
}

export async function importFields(file: File): Promise<FieldSummary[]> {
  const parsed: unknown = JSON.parse(await file.text());
  const response = await fetch("/api/v1/fields/import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(parsed) });
  if (!response.ok) {
    const body = await response.json() as ApiErrorBody;
    throw new Error(body.message ?? "GeoJSON 导入失败。");
  }
  return ((await response.json()) as { fields: FieldSummary[] }).fields;
}

async function fieldFromResponse(response: Response, fallback: string): Promise<FieldSummary> {
  if (!response.ok) { const body = await response.json() as ApiErrorBody; throw new Error(body.message ?? fallback); }
  return ((await response.json()) as { field: FieldSummary }).field;
}

export async function fetchPlanetAccessStatus(): Promise<PlanetAccessStatus> {
  const response = await fetch("/api/v1/integrations/planet");
  if (!response.ok) throw new Error("Planet 数据连接状态加载失败。");
  return (await response.json()) as PlanetAccessStatus;
}

export async function createTask(input: CreateAnalysisTaskRequest): Promise<AnalysisTask> {
  const response = await fetch("/api/v1/tasks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    const body = (await response.json()) as ApiErrorBody;
    throw new Error(body.message ?? "分析任务创建失败。");
  }
  return (await response.json()) as AnalysisTask;
}

export async function fetchTask(taskId: string): Promise<AnalysisTask> {
  const response = await fetch(`/api/v1/tasks/${taskId}`);
  if (!response.ok) throw new Error("分析进度加载失败。");
  return (await response.json()) as AnalysisTask;
}
