import type { AcquisitionDateMatch, AgentAnalysisPlan, AgentRunTrace, AnalysisResult, AnalysisTask, CreateAgentAnalysisPlanRequest, CreateDataAcquisitionRequest, DataAcquisitionRun, CreateAnalysisTaskRequest, CreateVariableNitrogenPrescriptionRequest, FieldConversationExchange, FieldConversationMessage, FieldHistory, FieldInput, FieldInspectionRecord, FieldScoutingNote, FieldSummary, FieldUpdateInput, FieldVisualizationCatalog, SaveFieldInspectionRequest, SaveFieldScoutingNoteRequest, TaskConversationMessage, VariableNitrogenPrescription, VariableNitrogenSourceOption } from "@chernozem/contracts";

interface ApiErrorBody {
  message?: string;
}

export async function fetchFields(): Promise<FieldSummary[]> {
  const response = await fetch("/api/v1/fields");
  if (!response.ok) throw new Error("农田列表加载失败。");
  const body = (await response.json()) as { fields: FieldSummary[] };
  return body.fields;
}

export async function fetchFieldHistory(id: string): Promise<FieldHistory> {
  const response = await fetch(`/api/v1/fields/${id}/history`);
  if (!response.ok) throw new Error("地块历史加载失败。");
  return ((await response.json()) as { history: FieldHistory }).history;
}

export async function fetchFieldVisualizations(id: string): Promise<FieldVisualizationCatalog> {
  const response = await fetch(`/api/v1/fields/${id}/visualizations`);
  if (!response.ok) throw new Error("地块可视化加载失败。");
  return (await response.json()) as FieldVisualizationCatalog;
}

export async function fetchScoutingNotes(fieldId: string): Promise<FieldScoutingNote[]> {
  const response = await fetch(`/api/v1/fields/${fieldId}/scouting-notes`);
  if (!response.ok) throw new Error("巡田记录加载失败。");
  return ((await response.json()) as { notes: FieldScoutingNote[] }).notes;
}

export async function saveScoutingNote(fieldId: string, input: SaveFieldScoutingNoteRequest): Promise<FieldScoutingNote> {
  const response = await fetch(`/api/v1/fields/${fieldId}/scouting-notes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    const body = (await response.json()) as ApiErrorBody;
    throw new Error(body.message ?? "巡田记录保存失败。");
  }
  return ((await response.json()) as { note: FieldScoutingNote }).note;
}

export async function fetchNitrogenPrescriptionContext(fieldId: string): Promise<{ options: VariableNitrogenSourceOption[]; latestPrescription: VariableNitrogenPrescription | null }> {
  const response = await fetch(`/api/v1/fields/${fieldId}/nitrogen-prescription-context`);
  if (!response.ok) throw new Error("施氮分区加载失败。");
  return (await response.json()) as { options: VariableNitrogenSourceOption[]; latestPrescription: VariableNitrogenPrescription | null };
}

export async function fetchNitrogenPrescriptions(fieldId: string): Promise<VariableNitrogenPrescription[]> {
  const response = await fetch(`/api/v1/fields/${fieldId}/nitrogen-prescriptions`);
  if (!response.ok) throw new Error("候选处方加载失败。");
  return ((await response.json()) as { prescriptions: VariableNitrogenPrescription[] }).prescriptions;
}

export async function createNitrogenPrescription(fieldId: string, input: CreateVariableNitrogenPrescriptionRequest): Promise<VariableNitrogenPrescription> {
  const response = await fetch(`/api/v1/fields/${fieldId}/nitrogen-prescriptions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    const body = await response.json() as ApiErrorBody;
    throw new Error(body.message ?? "候选处方保存失败。");
  }
  return ((await response.json()) as { prescription: VariableNitrogenPrescription }).prescription;
}

export function nitrogenPrescriptionExportUrl(id: string): string {
  return `/api/v1/nitrogen-prescriptions/${encodeURIComponent(id)}/export`;
}

export async function createDataAcquisition(input: CreateDataAcquisitionRequest): Promise<DataAcquisitionRun> {
  const response = await fetch("/api/v1/acquisitions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  if (!response.ok) {
    const body = await response.json() as ApiErrorBody;
    throw new Error(body.message ?? "数据采集失败。");
  }
  return ((await response.json()) as { run: DataAcquisitionRun }).run;
}

export async function fetchLatestAcquisition(fieldId: string): Promise<DataAcquisitionRun | null> {
  const response = await fetch(`/api/v1/fields/${fieldId}/data`);
  if (!response.ok) throw new Error("地块数据状态加载失败。");
  return ((await response.json()) as { run: DataAcquisitionRun | null }).run;
}

export async function fetchAcquisition(id: string): Promise<DataAcquisitionRun> {
  const response = await fetch(`/api/v1/acquisitions/${id}`);
  if (!response.ok) throw new Error("数据采集进度加载失败。");
  return ((await response.json()) as { run: DataAcquisitionRun }).run;
}

export async function fetchAcquisitionHistory(fieldId: string): Promise<DataAcquisitionRun[]> {
  const response = await fetch(`/api/v1/fields/${fieldId}/acquisitions`);
  if (!response.ok) throw new Error("历史采集记录加载失败。");
  return ((await response.json()) as { runs: DataAcquisitionRun[] }).runs;
}

export async function fetchDataMatches(fieldId: string, targetDate: string): Promise<AcquisitionDateMatch[]> {
  const response = await fetch(`/api/v1/fields/${fieldId}/data-match?date=${encodeURIComponent(targetDate)}`);
  if (!response.ok) throw new Error("日期匹配结果加载失败。");
  return ((await response.json()) as { matches: AcquisitionDateMatch[] }).matches;
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

export async function planAgentAnalysis(input: CreateAgentAnalysisPlanRequest): Promise<AgentAnalysisPlan> {
  const response = await fetch("/api/v1/agent/plan", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    const body = (await response.json()) as ApiErrorBody;
    throw new Error(body.message ?? "农情 Agent 暂时无法理解这个需求。");
  }
  return ((await response.json()) as { plan: AgentAnalysisPlan }).plan;
}

export async function fetchTasks(objective?: AnalysisTask["objective"]): Promise<AnalysisTask[]> {
  const params = new URLSearchParams({ limit: "20" });
  if (objective) params.set("objective", objective);
  const response = await fetch(`/api/v1/tasks?${params.toString()}`);
  if (!response.ok) throw new Error("分析记录加载失败。");
  return ((await response.json()) as { tasks: AnalysisTask[] }).tasks;
}

export async function fetchTask(taskId: string): Promise<AnalysisTask> {
  const response = await fetch(`/api/v1/tasks/${taskId}`);
  if (!response.ok) throw new Error("分析进度加载失败。");
  return (await response.json()) as AnalysisTask;
}

export async function fetchTaskAnalysis(taskId: string): Promise<AnalysisResult<unknown>[]> {
  const response = await fetch(`/api/v1/tasks/${taskId}/analysis`);
  if (!response.ok) throw new Error("分析产物加载失败。");
  return ((await response.json()) as { results: AnalysisResult<unknown>[] }).results;
}

export async function fetchAgentRun(taskId: string): Promise<AgentRunTrace | null> {
  const response = await fetch(`/api/v1/tasks/${taskId}/agent-run`);
  if (!response.ok) throw new Error("Agent 运行记录加载失败。");
  return ((await response.json()) as { run: AgentRunTrace | null }).run;
}

export async function fetchTaskConversation(taskId: string): Promise<TaskConversationMessage[]> {
  const response = await fetch(`/api/v1/tasks/${taskId}/conversation`);
  if (!response.ok) throw new Error("任务对话加载失败。");
  return ((await response.json()) as { messages: TaskConversationMessage[] }).messages;
}

export async function fetchFieldConversation(fieldId: string): Promise<FieldConversationMessage[]> {
  const response = await fetch(`/api/v1/fields/${fieldId}/conversation`);
  if (!response.ok) throw new Error("对话加载失败。");
  return ((await response.json()) as { messages: FieldConversationMessage[] }).messages;
}

export async function sendFieldConversationMessage(fieldId: string, content: string): Promise<FieldConversationExchange> {
  const response = await fetch(`/api/v1/fields/${fieldId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!response.ok) {
    const body = (await response.json()) as ApiErrorBody;
    throw new Error(body.message ?? "农情 Agent 暂时无法回答，请稍后重试。");
  }
  return (await response.json()) as FieldConversationExchange;
}

export async function sendTaskConversationMessage(taskId: string, content: string): Promise<[TaskConversationMessage, TaskConversationMessage]> {
  const response = await fetch(`/api/v1/tasks/${taskId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!response.ok) {
    const body = (await response.json()) as ApiErrorBody;
    throw new Error(body.message ?? "农情 Agent 暂时无法回答，请稍后重试。");
  }
  const body = (await response.json()) as { userMessage: TaskConversationMessage; assistantMessage: TaskConversationMessage };
  return [body.userMessage, body.assistantMessage];
}

export async function saveFieldInspection(taskId: string, findingId: string, input: SaveFieldInspectionRequest): Promise<FieldInspectionRecord> {
  const response = await fetch(`/api/v1/tasks/${taskId}/findings/${findingId}/inspection`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    const body = (await response.json()) as ApiErrorBody;
    throw new Error(body.message ?? "现场核查记录保存失败。");
  }
  return ((await response.json()) as { inspection: FieldInspectionRecord }).inspection;
}
