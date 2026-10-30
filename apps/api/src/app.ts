import { parseConversationScoutingNote, parseFieldContextQuery, parseTaskResultQuery, parseWorkflowStatusQuery, planConversationWorkflow } from "@chernozem/agent-runtime";
import type { ControlledAnalysisTool } from "@chernozem/agent-runtime";
import type { AnalysisObjective, AnalysisResult, AnalysisTask, AnalysisTimeRange, CreateAgentAnalysisPlanRequest, CreateAnalysisTaskRequest, CreateDataAcquisitionRequest, CreateFieldConversationMessageRequest, CreateTaskConversationMessageRequest, CreateVariableNitrogenPrescriptionRequest, DataProfile, FieldChartArtifact, FieldInput, FieldInspectionRecord, FieldMapLayer, FieldScoutingNote, FieldSummary, FieldUpdateInput, FieldVisualizationCatalog, Position, SaveFieldInspectionRequest, SaveFieldScoutingNoteRequest } from "@chernozem/contracts";
import cors from "@fastify/cors";
import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";

import { createMemoryAcquisitionStore } from "./acquisition-store.js";
import { buildAnalysisBrief } from "./analysis-brief.js";
import { publishAnalysisBrief, type AnalysisBriefWriter } from "./analysis-brief-writer.js";
import { createMemoryAnalysisResultStore, type AnalysisResultStore } from "./analysis-store.js";
import { AnalysisTaskExecutionError, createDeterministicAnalysisTaskExecutor, type AnalysisTaskExecutor } from "./analysis-task-executor.js";
import { AnalysisToolsetFactory } from "./analysis-toolset.js";
import { GrowthAnalysisService } from "./analysis-tools.js";
import { createDeterministicAnalysisRequestRouter, type AnalysisRequestRouter } from "./analysis-request-router.js";
import { createMemoryAgentRunStore, type AgentRunStore } from "./agent-run-store.js";
import { createDefaultAcquisitionProviders, DataAcquisitionService, resolveAcquisitionArtifact } from "./data-acquisition.js";
import { DATA_SOURCE_LABELS, isDataProfile } from "./data-profiles.js";
import { createMemoryFieldStore, FieldGeometryError, pointInBoundary, type FieldStore } from "./field-store.js";
import { FieldContextService } from "./field-context.js";
import { createMemoryFieldConversationStore, type FieldConversationStore } from "./field-conversation-store.js";
import { MultiSourceAnalysisService, type WaterNitrogenInspectionContext, type WaterNitrogenEvidencePayload } from "./multi-source-analysis.js";
import { collectNitrogenSourceOptions, createVariableNitrogenPrescription, NitrogenPrescriptionError, prescriptionGeoJson } from "./nitrogen-prescription.js";
import { createMemoryNitrogenPrescriptionStore, type NitrogenPrescriptionStore } from "./nitrogen-prescription-store.js";
import { createMemoryAnalysisTaskStore, type AnalysisTaskStore } from "./task-store.js";
import { attachTaskAcquisitionRequests } from "./task-next-actions.js";
import { createMemoryScoutingNoteStore, type ScoutingNoteStore } from "./scouting-store.js";
import { createDeterministicFieldConversationAgent, createDeterministicTaskConversationAgent, type FieldConversationAgent, type TaskConversationAgent } from "./task-conversation-agent.js";
import { createMemoryTaskConversationStore, type TaskConversationStore } from "./task-conversation-store.js";
import { WorkflowStatusService } from "./workflow-status.js";
import { TaskResultService } from "./task-result.js";

type StoredTask = AnalysisTask;

interface BuildAppOptions {
  fieldStore?: FieldStore;
  acquisitionService?: DataAcquisitionService;
  analysisResultStore?: AnalysisResultStore;
  growthAnalysisService?: GrowthAnalysisService;
  multiSourceAnalysisService?: MultiSourceAnalysisService;
  analysisToolsetFactory?: AnalysisToolsetFactory;
  taskStore?: AnalysisTaskStore;
  scoutingNoteStore?: ScoutingNoteStore;
  nitrogenPrescriptionStore?: NitrogenPrescriptionStore;
  analysisTaskExecutor?: AnalysisTaskExecutor;
  analysisBriefWriter?: AnalysisBriefWriter;
  agentRunStore?: AgentRunStore;
  taskConversationAgent?: TaskConversationAgent;
  taskConversationStore?: TaskConversationStore;
  fieldConversationAgent?: FieldConversationAgent;
  fieldConversationStore?: FieldConversationStore;
  analysisRequestRouter?: AnalysisRequestRouter;
}

export function buildApp(options: BuildAppOptions = {}) {
  const app = Fastify({ logger: true });
  const fieldStore = options.fieldStore ?? createMemoryFieldStore();
  const acquisitionService = options.acquisitionService ?? new DataAcquisitionService(createMemoryAcquisitionStore(), createDefaultAcquisitionProviders());
  const analysisResultStore = options.analysisResultStore ?? createMemoryAnalysisResultStore();
  const growthAnalysisService = options.growthAnalysisService ?? new GrowthAnalysisService(analysisResultStore);
  const multiSourceAnalysisService = options.multiSourceAnalysisService ?? new MultiSourceAnalysisService(analysisResultStore);
  const analysisToolsetFactory = options.analysisToolsetFactory ?? new AnalysisToolsetFactory(growthAnalysisService, multiSourceAnalysisService);
  const taskStore = options.taskStore ?? createMemoryAnalysisTaskStore();
  const scoutingNoteStore = options.scoutingNoteStore ?? createMemoryScoutingNoteStore();
  const nitrogenPrescriptionStore = options.nitrogenPrescriptionStore ?? createMemoryNitrogenPrescriptionStore();
  const analysisTaskExecutor = options.analysisTaskExecutor ?? createDeterministicAnalysisTaskExecutor();
  const analysisBriefWriter = options.analysisBriefWriter;
  const agentRunStore = options.agentRunStore ?? createMemoryAgentRunStore();
  const taskConversationAgent = options.taskConversationAgent ?? createDeterministicTaskConversationAgent();
  const taskConversationStore = options.taskConversationStore ?? createMemoryTaskConversationStore();
  const fieldConversationAgent = options.fieldConversationAgent ?? createDeterministicFieldConversationAgent();
  const fieldConversationStore = options.fieldConversationStore ?? createMemoryFieldConversationStore();
  const analysisRequestRouter = options.analysisRequestRouter ?? createDeterministicAnalysisRequestRouter();
  const workflowStatusService = new WorkflowStatusService(taskStore);
  const taskResultService = new TaskResultService(taskStore);
  const fieldContextService = new FieldContextService(taskStore, acquisitionService);
  void app.register(cors, { origin: true });

  app.get("/api/v1/health", async () => ({ status: "ok" }));

  app.post<{ Body: CreateAgentAnalysisPlanRequest }>("/api/v1/agent/plan", async (request, reply) => {
    const field = await fieldStore.get(request.body?.fieldId);
    if (!field) return reply.code(404).send({ code: "field_not_found", message: "没有找到该农田。" });
    if (field.crop !== "corn") return reply.code(422).send({ code: "crop_not_supported", message: "首版专项分析目前仅支持玉米。" });
    const message = typeof request.body?.message === "string" ? request.body.message.trim() : "";
    if (!message || message.length > 1000) return reply.code(422).send({ code: "invalid_agent_request", message: "请输入 1 至 1000 个字符的农情需求。" });
    const periodHint = request.body.periodHint;
    if (periodHint && periodHint !== "last_30_days" && periodHint !== "this_season") {
      return reply.code(422).send({ code: "invalid_analysis_period", message: "请选择有效的分析时间。" });
    }
    try {
      return { plan: await analysisRequestRouter.route({ field, message, ...(periodHint ? { periodHint } : {}) }) };
    } catch (error) {
      return reply.code(503).send({ code: "agent_unavailable", message: error instanceof Error ? error.message : "农情 Agent 暂时不可用，请稍后重试。" });
    }
  });

  app.get("/api/v1/fields", async () => ({
    fields: await Promise.all((await fieldStore.list()).map(async (field) => fieldWithLatestAnalysis(field, await taskStore.list(field.id, 20)))),
  }));

  app.get<{ Params: { id: string } }>("/api/v1/fields/:id/history", async (request, reply) => {
    const history = await fieldStore.history(request.params.id);
    if (!history) return reply.code(404).send({ code: "field_not_found", message: "没有找到该农田。" });
    return { history };
  });

  app.get<{ Params: { id: string } }>("/api/v1/fields/:id/conversation", async (request, reply) => {
    const field = await fieldStore.get(request.params.id);
    if (!field) return reply.code(404).send({ code: "field_not_found", message: "没有找到该农田。" });
    return { messages: await fieldConversationStore.list(field.id) };
  });

  app.post<{ Params: { id: string }; Body: CreateFieldConversationMessageRequest }>("/api/v1/fields/:id/messages", async (request, reply) => {
    const field = await fieldStore.get(request.params.id);
    if (!field) return reply.code(404).send({ code: "field_not_found", message: "没有找到该农田。" });
    const content = typeof request.body?.content === "string" ? request.body.content.trim() : "";
    if (!content || content.length > 1000) return reply.code(422).send({ code: "invalid_message", message: "请输入 1 至 1000 个字符的消息。" });
    const workflowStatusQuery = parseWorkflowStatusQuery(content);
    const taskResultQuery = workflowStatusQuery ? null : parseTaskResultQuery(content);
    const fieldContextQuery = workflowStatusQuery || taskResultQuery ? null : parseFieldContextQuery(content);
    const parsedScoutingNote = workflowStatusQuery || taskResultQuery || fieldContextQuery ? null : parseConversationScoutingNote(content, chinaCalendarDate());
    const scoutingLocation = parsedScoutingNote?.location && pointInBoundary(parsedScoutingNote.location, field.boundary)
      ? parsedScoutingNote.location
      : null;
    const scoutingNoteDraft = parsedScoutingNote ? {
      ...parsedScoutingNote,
      fieldId: field.id,
      location: scoutingLocation,
      missingInputs: scoutingLocation ? [] : ["现场位置"],
    } : null;
    const [history, recentTasks, workflowPlan, workflowStatus, taskResult, fieldContext] = await Promise.all([
      fieldConversationStore.list(field.id),
      taskStore.list(field.id, 3),
      workflowStatusQuery || taskResultQuery || fieldContextQuery || scoutingNoteDraft ? null : planConversationWorkflow(field, content),
      workflowStatusQuery ? workflowStatusService.get({ fieldId: field.id, objective: workflowStatusQuery.objective }) : null,
      taskResultQuery ? taskResultService.get({ fieldId: field.id, objective: taskResultQuery.objective, focus: taskResultQuery.focus }) : null,
      fieldContextQuery ? fieldContextService.get({ field, focus: fieldContextQuery.focus }) : null,
    ]);
    let answer: string;
    if (workflowStatus) {
      answer = workflowStatus.message;
    } else if (taskResult) {
      answer = taskResult.message;
    } else if (fieldContext) {
      answer = fieldContext.message;
    } else if (scoutingNoteDraft) {
      answer = scoutingNoteDraft.location
        ? "我把这条现场观察整理成了巡田记录。请检查内容，确认后再保存。"
        : "我把这条现场观察整理成了巡田记录。还需要在地图上选择观察位置，确认后再保存。";
    } else if (workflowPlan) {
      const missing = workflowPlan.missingInputs.length ? ` 当前缺少${workflowPlan.missingInputs.join("、")}，分析会明确保留这个缺口。` : "";
      answer = `可以。${workflowPlan.summary}${missing} 确认后开始这项任务。`;
    } else {
      try {
        answer = await fieldConversationAgent.reply({ field, history, recentTasks, userMessage: content });
      } catch (error) {
        return reply.code(503).send({ code: "agent_unavailable", message: error instanceof Error ? error.message : "农情 Agent 暂时不可用，请稍后重试。" });
      }
    }
    const trimmedAnswer = answer.trim();
    const normalizedAnswer = trimmedAnswer.length <= 4000 ? trimmedAnswer : `${trimmedAnswer.slice(0, 3999)}…`;
    const [userMessage, assistantMessage] = await fieldConversationStore.appendExchange(field.id, content, normalizedAnswer, new Date().toISOString());
    return reply.code(201).send({ userMessage, assistantMessage, workflowPlan, workflowStatus, taskResult, fieldContext, scoutingNoteDraft });
  });

  app.get<{ Params: { id: string } }>("/api/v1/fields/:id/visualizations", async (request, reply) => {
    const field = await fieldStore.get(request.params.id);
    if (!field) return reply.code(404).send({ code: "field_not_found", message: "没有找到该农田。" });
    return collectFieldVisualizations(await taskStore.list(field.id));
  });

  app.get<{ Params: { id: string } }>("/api/v1/fields/:id/scouting-notes", async (request, reply) => {
    const field = await fieldStore.get(request.params.id);
    if (!field) return reply.code(404).send({ code: "field_not_found", message: "没有找到该农田。" });
    return { notes: await scoutingNoteStore.list(field.id) };
  });

  app.post<{ Params: { id: string }; Body: SaveFieldScoutingNoteRequest }>("/api/v1/fields/:id/scouting-notes", async (request, reply) => {
    const field = await fieldStore.get(request.params.id);
    if (!field) return reply.code(404).send({ code: "field_not_found", message: "没有找到该农田。" });
    const validation = validateFieldScoutingNote(request.body);
    if (validation) return reply.code(422).send({ code: "invalid_scouting_note", message: validation });
    if (!pointInBoundary(request.body.location, field.boundary)) return reply.code(422).send({ code: "scouting_note_outside_field", message: "巡田记录点必须位于当前地块边界内。" });
    const note: FieldScoutingNote = {
      id: randomUUID(),
      fieldId: field.id,
      observedAt: request.body.observedAt,
      location: request.body.location,
      waterCondition: request.body.waterCondition,
      leafColor: request.body.leafColor,
      diseaseOrPest: request.body.diseaseOrPest,
      note: request.body.note.trim(),
      createdAt: new Date().toISOString(),
    };
    await scoutingNoteStore.save(note);
    return reply.code(201).send({ note });
  });

  app.get<{ Params: { id: string } }>("/api/v1/fields/:id/nitrogen-prescription-context", async (request, reply) => {
    const field = await fieldStore.get(request.params.id);
    if (!field) return reply.code(404).send({ code: "field_not_found", message: "没有找到该农田。" });
    const [tasks, prescriptions] = await Promise.all([taskStore.list(field.id, 100), nitrogenPrescriptionStore.list(field.id, 1)]);
    return { options: collectNitrogenSourceOptions(tasks, field.boundaryVersion), latestPrescription: prescriptions[0] ?? null };
  });

  app.get<{ Params: { id: string } }>("/api/v1/fields/:id/nitrogen-prescriptions", async (request, reply) => {
    const field = await fieldStore.get(request.params.id);
    if (!field) return reply.code(404).send({ code: "field_not_found", message: "没有找到该农田。" });
    return { prescriptions: await nitrogenPrescriptionStore.list(field.id) };
  });

  app.post<{ Params: { id: string }; Body: CreateVariableNitrogenPrescriptionRequest }>("/api/v1/fields/:id/nitrogen-prescriptions", async (request, reply) => {
    const field = await fieldStore.get(request.params.id);
    if (!field) return reply.code(404).send({ code: "field_not_found", message: "没有找到该农田。" });
    const sourceTask = await taskStore.get(request.body?.sourceTaskId);
    if (!sourceTask) return reply.code(422).send({ code: "source_task_not_found", message: "没有找到所选光学分析结果。" });
    try {
      const prescription = createVariableNitrogenPrescription(field, sourceTask, request.body);
      await nitrogenPrescriptionStore.save(prescription);
      return reply.code(201).send({ prescription });
    } catch (error) {
      if (error instanceof NitrogenPrescriptionError) return reply.code(422).send({ code: error.code, message: error.message });
      throw error;
    }
  });

  app.get<{ Params: { id: string } }>("/api/v1/nitrogen-prescriptions/:id/export", async (request, reply) => {
    const prescription = await nitrogenPrescriptionStore.get(request.params.id);
    if (!prescription) return reply.code(404).send({ code: "prescription_not_found", message: "没有找到该候选处方。" });
    reply.header("content-type", "application/geo+json; charset=utf-8");
    reply.header("content-disposition", `attachment; filename="nitrogen-prescription-${prescription.sourceDate}.geojson"`);
    return prescriptionGeoJson(prescription);
  });

  app.post<{ Body: FieldInput }>("/api/v1/fields", async (request, reply) => {
    try {
      return reply.code(201).send({ field: await fieldStore.create(validateFieldInput(request.body)) });
    } catch (error) {
      return sendFieldError(reply, error);
    }
  });

  app.patch<{ Params: { id: string }; Body: FieldUpdateInput }>("/api/v1/fields/:id", async (request, reply) => {
    try {
      const field = await fieldStore.update(request.params.id, validateFieldUpdate(request.body));
      if (!field) return reply.code(404).send({ code: "field_not_found", message: "没有找到该农田。" });
      return { field };
    } catch (error) {
      return sendFieldError(reply, error);
    }
  });

  app.delete<{ Params: { id: string } }>("/api/v1/fields/:id", async (request, reply) => {
    if (!await fieldStore.archive(request.params.id)) {
      return reply.code(404).send({ code: "field_not_found", message: "没有找到该农田。" });
    }
    return reply.code(204).send();
  });

  app.post<{ Body: GeoJsonFeatureCollection }>("/api/v1/fields/import", async (request, reply) => {
    try {
      if (request.body.type !== "FeatureCollection" || !Array.isArray(request.body.features) || request.body.features.length === 0) {
        throw new FieldGeometryError("请选择包含至少一个多边形的 GeoJSON 文件。");
      }
      const imported = await Promise.all(request.body.features.map(async (feature, index) => {
        if (feature.geometry?.type !== "Polygon") throw new FieldGeometryError(`第 ${index + 1} 个要素不是多边形。`);
        const properties = feature.properties ?? {};
        return fieldStore.create(validateFieldInput({
          name: stringValue(properties.name) ?? `导入地块 ${index + 1}`,
          crop: cropValue(properties.crop) ?? "corn",
          seasonYear: numberValue(properties.seasonYear) ?? new Date().getFullYear(),
          plantingDate: stringValue(properties.plantingDate) ?? null,
          variety: stringValue(properties.variety) ?? null,
          boundary: feature.geometry.coordinates[0]!.map(([longitude, latitude]) => ({ longitude, latitude })),
        }));
      }));
      return reply.code(201).send({ fields: imported });
    } catch (error) {
      return sendFieldError(reply, error);
    }
  });

  app.post<{ Body: CreateDataAcquisitionRequest }>("/api/v1/acquisitions", async (request, reply) => {
    const field = await fieldStore.get(request.body?.fieldId);
    if (!field) return reply.code(404).send({ code: "field_not_found", message: "没有找到该农田。" });
    if (request.body.boundaryVersion !== field.boundaryVersion) {
      return reply.code(409).send({ code: "boundary_version_mismatch", message: "地块边界已经更新，请重新发起数据采集。" });
    }
    const validation = validateAcquisitionRequest(request.body);
    if (validation) return reply.code(422).send({ code: "invalid_acquisition_request", message: validation });
    const run = await acquisitionService.start(field, request.body);
    return reply.code(202).send({ run });
  });

  app.get<{ Params: { id: string } }>("/api/v1/acquisitions/:id", async (request, reply) => {
    const run = await acquisitionService.get(request.params.id);
    if (!run) return reply.code(404).send({ code: "acquisition_not_found", message: "没有找到该数据采集任务。" });
    return { run };
  });

  app.get<{ Params: { id: string } }>("/api/v1/fields/:id/data", async (request, reply) => {
    const field = await fieldStore.get(request.params.id);
    if (!field) return reply.code(404).send({ code: "field_not_found", message: "没有找到该农田。" });
    return { run: await acquisitionService.latest(field.id) };
  });

  app.get<{ Params: { id: string } }>("/api/v1/fields/:id/acquisitions", async (request, reply) => {
    const field = await fieldStore.get(request.params.id);
    if (!field) return reply.code(404).send({ code: "field_not_found", message: "没有找到该农田。" });
    return { runs: await acquisitionService.list(field.id) };
  });

  app.get<{ Params: { id: string }; Querystring: { date?: string } }>("/api/v1/fields/:id/data-match", async (request, reply) => {
    const field = await fieldStore.get(request.params.id);
    if (!field) return reply.code(404).send({ code: "field_not_found", message: "没有找到该农田。" });
    if (!isCalendarDate(request.query.date)) {
      return reply.code(422).send({ code: "invalid_target_date", message: "请选择有效的数据日期。" });
    }
    return { targetDate: request.query.date, matches: await acquisitionService.matchDate(field.id, request.query.date!) };
  });

  app.post<{ Body: CreateAnalysisTaskRequest }>("/api/v1/tasks", async (request, reply) => {
    const field = await fieldStore.get(request.body.fieldId);
    if (!field) {
      return reply.code(404).send({ code: "field_not_found", message: "没有找到该农田。" });
    }
    if (field.crop !== "corn" || request.body.crop !== field.crop) {
      return reply.code(422).send({
        code: "crop_not_supported",
        message: "首版专项分析目前仅支持玉米。",
      });
    }

    if (!isAnalysisObjective(request.body.objective)) {
      return reply.code(422).send({ code: "objective_not_supported", message: "请选择有效的农情分析目标。" });
    }
    if (request.body.objective === "frost_risk_warning" && request.body.period !== "last_30_days") {
      return reply.code(422).send({ code: "invalid_analysis_period", message: "霜冻预警只使用最新未来预报窗口，不能绑定历史观测日期。" });
    }

    const timeRange = resolveAnalysisTimeRange(request.body, field);
    if (typeof timeRange === "string") return reply.code(422).send({ code: "invalid_analysis_period", message: timeRange });

    const allAcquisitions = (await acquisitionService.list(field.id, 100))
      .filter((run) => run.boundaryVersion === field.boundaryVersion);
    const selectedWaterNitrogenNotes = request.body.objective === "water_nitrogen_diagnosis"
      ? await selectedWaterNitrogenScoutingNotes(field.id, request.body.scoutingNoteIds ?? [], scoutingNoteStore)
      : [];
    const inspectionSourceTask = request.body.objective === "water_nitrogen_diagnosis" && request.body.inspectionTaskId
      ? await taskStore.get(request.body.inspectionTaskId)
      : null;
    if (request.body.inspectionTaskId && (!inspectionSourceTask || inspectionSourceTask.fieldId !== field.id || inspectionSourceTask.objective !== "water_nitrogen_diagnosis")) {
      return reply.code(422).send({ code: "invalid_inspection_task", message: "没有找到该地块可用于更新判断的巡田任务。" });
    }
    const pairedInspectionContext = inspectionSourceTask
      ? (inspectionSourceTask.inspections ?? []).map((inspection) => toWaterNitrogenTaskInspectionContext(inspection, inspectionSourceTask))
      : [];
    const inspections = [...pairedInspectionContext, ...selectedWaterNitrogenNotes.map(toWaterNitrogenInspectionContext)];
    const toolset = analysisToolsetFactory.create({
      objective: request.body.objective,
      field,
      timeRange,
      acquisitions: allAcquisitions,
      inspections,
    });
    const canRunAnalysis = toolset.availability.canRun;
    const hasHistoricalAcquisition = allAcquisitions.length > 0;
    const now = Date.now();
    const acquisitionMessage = toolset.availability.gap?.message ?? "数据已就绪。";
    const objectiveLabel = analysisObjectiveLabel(request.body.objective);
    const taskId = randomUUID();
    const task: StoredTask = {
      id: taskId,
      fieldId: field.id,
      boundaryVersion: field.boundaryVersion,
      objective: request.body.objective,
      requestMessage: typeof request.body.message === "string" ? request.body.message.trim().slice(0, 1000) || null : null,
      timeRange,
      status: canRunAnalysis ? "running" : "needs_data",
      progress: canRunAnalysis ? 5 : 0,
      stage: canRunAnalysis
        ? request.body.objective === "water_nitrogen_diagnosis" && (selectedWaterNitrogenNotes.length || pairedInspectionContext.length)
          ? "正在结合低值区与正常区记录更新判断"
          : `正在执行${objectiveLabel}`
        : toolset.availability.status === "missing_analysis_assets"
          ? "等待可分析光学数据"
          : hasHistoricalAcquisition ? "等待该时段数据采集" : "等待地块数据采集",
      createdAt: new Date(now).toISOString(),
      completedAt: null,
      demoData: false,
      summary: canRunAnalysis
        ? request.body.objective === "water_nitrogen_diagnosis" && (selectedWaterNitrogenNotes.length || pairedInspectionContext.length)
          ? "正在对照现场记录与对应光学观测。"
          : `正在读取已采集数据并执行${objectiveLabel}。`
        : `${acquisitionMessage} 当前分析工具不会用缺失数据生成农情结论。`,
      brief: null,
      findings: [],
      sources: toolset.availability.gap?.sources.map((source) => ({
        source,
        observedAt: "",
        quality: "missing" as const,
        note: `尚未取得覆盖当前任务窗口的 ${DATA_SOURCE_LABELS[source]} 数据。`,
        role: "context" as const,
      })) ?? [],
      analysisResults: [],
      limitations: toolset.availability.gap ? [toolset.availability.gap.message] : [],
      nextActions: toolset.availability.gap ? [toolset.availability.gap.nextAction] : [],
      failure: null,
      inspections: (inspectionSourceTask?.inspections ?? []).map((inspection) => ({ ...inspection, taskId })),
    };
    await taskStore.save(task);
    if (canRunAnalysis) {
      void analysisTaskExecutor.run({
        objective: task.objective,
        taskId: task.id,
        scope: {
          organizationId: field.organizationId,
          taskId: task.id,
          fieldIds: [field.id],
          crop: field.crop,
          period: task.timeRange,
        },
        tools: toolset.tools,
        ...(task.requestMessage ? { userRequest: task.requestMessage } : {}),
      }).then(async (execution) => {
        if (analysisBriefWriter) {
          task.analysisResults = execution.results;
          task.progress = 90;
          task.stage = "正在比较观测结果并撰写农情分析";
          await taskStore.save(task);
        }
        await applyAnalysisResults(task, execution.results, toolset.investigationTools, analysisBriefWriter);
        if (task.brief?.reviewRequired) {
          task.status = "needs_review";
          task.stage = "分析草稿等待专业复核";
        }
        await taskStore.save(task);
      }).catch(async (error: unknown) => {
        const failure = error instanceof AnalysisTaskExecutionError
          ? error.failure
          : { code: "agent_execution_failed" as const, retryable: true, message: "农情 Agent 运行失败，请稍后重试。" };
        task.status = "failed";
        task.progress = 0;
        task.stage = `${objectiveLabel}失败`;
        task.completedAt = new Date().toISOString();
        task.summary = failure.message;
        task.failure = failure;
        await taskStore.save(task);
      });
    }
    return reply.code(202).send(toPublicTask(task));
  });

  app.get<{ Querystring: { limit?: string; objective?: string } }>("/api/v1/tasks", async (request, reply) => {
    const parsedLimit = Number.parseInt(request.query.limit ?? "20", 10);
    const limit = Number.isFinite(parsedLimit) ? Math.min(100, Math.max(1, parsedLimit)) : 20;
    const objective = request.query.objective;
    if (objective && !isAnalysisObjective(objective)) {
      return reply.code(400).send({ code: "invalid_objective", message: "分析目标无效。" });
    }
    return { tasks: await taskStore.listRecent(limit, objective as AnalysisObjective | undefined) };
  });

  app.get<{ Params: { id: string } }>("/api/v1/tasks/:id", async (request, reply) => {
    const task = await taskStore.get(request.params.id);
    if (!task) {
      return reply.code(404).send({ code: "task_not_found", message: "没有找到该分析任务。" });
    }

    return toPublicTask(task);
  });

  app.get<{ Params: { id: string } }>("/api/v1/tasks/:id/analysis", async (request, reply) => {
    const task = await taskStore.get(request.params.id);
    if (!task) return reply.code(404).send({ code: "task_not_found", message: "没有找到该分析任务。" });
    return { results: task.analysisResults.length ? task.analysisResults : await analysisResultStore.list(task.id) };
  });

  app.get<{ Params: { id: string } }>("/api/v1/tasks/:id/agent-run", async (request, reply) => {
    const task = await taskStore.get(request.params.id);
    if (!task) return reply.code(404).send({ code: "task_not_found", message: "没有找到该分析任务。" });
    return { run: await agentRunStore.getLatestForTask(task.id) };
  });

  app.get<{ Params: { id: string } }>("/api/v1/tasks/:id/conversation", async (request, reply) => {
    const task = await taskStore.get(request.params.id);
    if (!task) return reply.code(404).send({ code: "task_not_found", message: "没有找到该分析任务。" });
    if (task.status === "running" || task.status === "planned") return { messages: [] };
    await taskConversationStore.ensureInitial(task.id, taskConversationInitialContent(task), task.completedAt ?? task.createdAt, task.requestMessage);
    return { messages: await taskConversationStore.list(task.id) };
  });

  app.post<{ Params: { id: string }; Body: CreateTaskConversationMessageRequest }>("/api/v1/tasks/:id/messages", async (request, reply) => {
    const task = await taskStore.get(request.params.id);
    if (!task) return reply.code(404).send({ code: "task_not_found", message: "没有找到该分析任务。" });
    if (task.status === "running" || task.status === "planned") {
      return reply.code(409).send({ code: "task_still_running", message: "分析完成后可以继续提问。" });
    }
    if (task.status === "failed" || task.status === "cancelled") {
      return reply.code(409).send({ code: "task_not_conversable", message: "当前任务没有形成可解释的分析结果，请重新分析。" });
    }
    const content = typeof request.body?.content === "string" ? request.body.content.trim() : "";
    if (!content || content.length > 1000) {
      return reply.code(422).send({ code: "invalid_message", message: "请输入 1 至 1000 个字符的问题。" });
    }
    await taskConversationStore.ensureInitial(task.id, taskConversationInitialContent(task), task.completedAt ?? task.createdAt, task.requestMessage);
    const history = await taskConversationStore.list(task.id);
    let answer: string;
    try {
      answer = await taskConversationAgent.reply({ task, history, userMessage: content });
    } catch (error) {
      return reply.code(503).send({ code: "agent_unavailable", message: error instanceof Error ? error.message : "农情 Agent 暂时不可用，请稍后重试。" });
    }
    const trimmedAnswer = answer.trim();
    const normalizedAnswer = trimmedAnswer.length <= 4000 ? trimmedAnswer : `${trimmedAnswer.slice(0, 3999)}…`;
    const [userMessage, assistantMessage] = await taskConversationStore.appendExchange(task.id, content, normalizedAnswer, new Date().toISOString());
    return reply.code(201).send({ userMessage, assistantMessage });
  });

  app.put<{ Params: { taskId: string; findingId: string }; Body: SaveFieldInspectionRequest }>("/api/v1/tasks/:taskId/findings/:findingId/inspection", async (request, reply) => {
    const task = await taskStore.get(request.params.taskId);
    if (!task) return reply.code(404).send({ code: "task_not_found", message: "没有找到该分析任务。" });
    const field = await fieldStore.get(task.fieldId);
    if (!field) return reply.code(404).send({ code: "field_not_found", message: "没有找到该任务对应的地块。" });
    const finding = task.findings.find((item) => item.id === request.params.findingId);
    if (!finding) return reply.code(404).send({ code: "finding_not_found", message: "没有找到该差异区域。" });
    if (!finding.zone && finding.findingType !== "field_observation") return reply.code(422).send({ code: "finding_not_spatial", message: "这个结果没有可核查的田内区域。" });
    const validation = validateFieldInspection(request.body);
    if (validation) return reply.code(422).send({ code: "invalid_inspection", message: validation });
    if (!pointInBoundary(request.body.location, field.boundary)) return reply.code(422).send({ code: "inspection_outside_field", message: "现场记录点必须位于当前地块边界内。" });
    const scoutingLocationError = validateScoutingLocation(task, finding, request.body.location);
    if (scoutingLocationError) return reply.code(422).send({ code: "inspection_role_mismatch", message: scoutingLocationError });
    const record: FieldInspectionRecord = {
      id: task.inspections?.find((item) => item.findingId === finding.id)?.id ?? randomUUID(),
      taskId: task.id,
      findingId: finding.id,
      scoutingRole: finding.scoutingRole ?? "general",
      status: "checked",
      checkedAt: new Date().toISOString(),
      observedAt: request.body.observedAt,
      location: request.body.location,
      waterCondition: request.body.waterCondition,
      leafColor: request.body.leafColor,
      diseaseOrPest: request.body.diseaseOrPest,
      note: request.body.note.trim(),
    };
    task.inspections = [...(task.inspections ?? []).filter((item) => item.findingId !== finding.id), record];
    await taskStore.save(task);
    return { inspection: record };
  });

  app.get<{ Params: { "*": string } }>("/api/v1/artifacts/*", async (request, reply) => {
    const path = resolveAcquisitionArtifact(request.params["*"]);
    if (!path) return reply.code(404).send({ code: "artifact_not_found", message: "没有找到该分析产物。" });
    try {
      const contentType = extname(path).toLowerCase() === ".png" ? "image/png"
        : extname(path).toLowerCase() === ".geojson" || extname(path).toLowerCase() === ".json" ? "application/geo+json"
          : "application/octet-stream";
      return reply.header("cache-control", "private, max-age=86400").type(contentType).send(await readFile(path));
    } catch {
      return reply.code(404).send({ code: "artifact_not_found", message: "分析产物尚未生成或已不存在。" });
    }
  });

  return app;
}

async function selectedWaterNitrogenScoutingNotes(fieldId: string, ids: string[], store: ScoutingNoteStore): Promise<FieldScoutingNote[]> {
  const uniqueIds = [...new Set(ids)].slice(0, 20);
  const notes = await Promise.all(uniqueIds.map((id) => store.get(id)));
  return notes.filter((note): note is FieldScoutingNote => note !== null && note.fieldId === fieldId);
}

function toWaterNitrogenInspectionContext(note: FieldScoutingNote): WaterNitrogenInspectionContext {
  return {
    taskId: "field-scouting-note",
    findingId: note.id,
    findingTitle: "巡田记录",
    scoutingRole: "general",
    observationDates: [],
    checkedAt: note.createdAt,
    observedAt: note.observedAt,
    location: note.location,
    waterCondition: note.waterCondition,
    leafColor: note.leafColor,
    diseaseOrPest: note.diseaseOrPest,
    note: note.note,
  };
}

function toWaterNitrogenTaskInspectionContext(inspection: FieldInspectionRecord, task: AnalysisTask): WaterNitrogenInspectionContext {
  const finding = task.findings.find((item) => item.id === inspection.findingId);
  return {
    taskId: task.id,
    findingId: inspection.findingId,
    findingTitle: finding?.title ?? "巡田记录",
    scoutingRole: inspection.scoutingRole,
    observationDates: finding?.sourceDates ?? [],
    checkedAt: inspection.checkedAt,
    observedAt: inspection.observedAt,
    location: inspection.location,
    waterCondition: inspection.waterCondition,
    leafColor: inspection.leafColor,
    diseaseOrPest: inspection.diseaseOrPest,
    note: inspection.note,
  };
}

async function applyAnalysisResults(task: StoredTask, results: AnalysisResult<unknown>[], investigationTools: ControlledAnalysisTool[], briefWriter?: AnalysisBriefWriter) {
  task.analysisResults = results;
  const assessment = results.find((result) => result.kind === "assessment");
  task.status = assessment?.status === "succeeded" ? "completed" : assessment?.status === "partial" ? "partial" : assessment?.status === "needs_review" ? "needs_review" : assessment?.status === "needs_input" ? "needs_input" : assessment?.status === "needs_data" ? "needs_data" : "failed";
  task.progress = task.status === "completed" || task.status === "partial" ? 100 : 0;
  task.stage = task.status === "completed" || task.status === "partial" ? `${analysisObjectiveLabel(task.objective)}已完成`
    : task.status === "needs_input" ? "等待补充地块资料"
      : task.status === "needs_data" ? "等待可用观测数据"
        : task.status === "needs_review" ? "等待专业复核" : `${analysisObjectiveLabel(task.objective)}失败`;
  task.completedAt = new Date().toISOString();
  task.summary = assessment?.summary ?? `${analysisObjectiveLabel(task.objective)}没有形成结果。`;
  const deterministicBrief = buildAnalysisBrief(task.objective, results);
  const publication = deterministicBrief
    ? await publishAnalysisBrief({
      task: { id: task.id, fieldId: task.fieldId, objective: task.objective, timeRange: task.timeRange,
        ...(task.boundaryVersion !== undefined ? { boundaryVersion: task.boundaryVersion } : {}),
        ...(task.requestMessage ? { requestMessage: task.requestMessage } : {}) },
      results, investigationTools, brief: deterministicBrief, ...(briefWriter ? { writer: briefWriter } : {}),
    })
    : null;
  task.brief = publication?.brief ?? null;
  results = publication?.results ?? results;
  task.analysisResults = results;
  if (task.brief?.generation.mode === "model_generated") task.summary = task.brief.overview;
  task.sources = assessment?.sources.map((source) => ({ source: source.source, observedAt: source.date ?? "", quality: source.quality, note: source.note, ...(source.role ? { role: source.role } : {}) })) ?? [];
  task.limitations = assessment?.limitations ?? [];
  task.nextActions = attachTaskAcquisitionRequests(task, assessment?.nextActions ?? []);
  if (task.objective === "growth_stage_monitoring") {
    const optical = results.find((result) => result.kind === "optical_condition");
    const opticalPayload = optical?.result as { current?: { observationDate?: string }; zones?: Array<{ id: string; class: string; meanNdvi: number; deviation: number; areaHa?: number; zone: number[][]; holes?: number[][][] }> } | null;
    const latestObservationDate = opticalPayload?.current?.observationDate ?? null;
    const zoneSourceDates = latestObservationDate ? [latestObservationDate] : [];
    const opticalZones = (opticalPayload?.zones ?? [])
      .filter((zone) => zone.class === "below_average")
      .sort((left, right) => left.meanNdvi - right.meanNdvi)
      .map((zone) => ({
        id: zone.id,
        title: "长势偏弱区",
        summary: `该区平均 NDVI ${zone.meanNdvi.toFixed(3)}，较地块均值低 ${Math.abs(zone.deviation).toFixed(3)}，需现场对照确认原因。`,
        severity: "watch" as const,
        findingType: "observation_zone" as const,
        areaHa: zone.areaHa ?? null,
        sourceDates: zoneSourceDates,
        zone: toPositions(zone.zone),
        ...(zone.holes ? { zoneHoles: zone.holes.map(toPositions) } : {}),
      }));
    task.findings = [...(assessment?.findings.map((finding) => ({ id: finding.id, title: finding.id === "growth-status" ? "关键生育期长势" : finding.id, summary: finding.summary, severity: assessment.result && (assessment.result as { status?: string }).status === "watch" ? "watch" as const : "normal" as const, areaHa: null, sourceDates: finding.sourceDates.map((source) => source.date).filter((date): date is string => date !== null), zone: null })) ?? []), ...opticalZones];
    return;
  }
  if (task.objective === "waterlogging_detection") {
    const payload = assessment?.result as { status?: "suspected" | "not_detected" | "radar_change_only"; zones?: Array<{ id: string; areaHa: number; zone: number[][] }> } | null;
    const zones = payload?.zones ?? [];
    const radarOnly = payload?.status === "radar_change_only";
    task.findings = assessment?.findings.map((finding) => {
      const zone = zones.find((item) => item.id === finding.id);
      return { id: finding.id, title: radarOnly ? "雷达变化区" : "疑似积水区", summary: finding.summary, severity: "watch" as const, findingType: radarOnly ? "observation_zone" as const : "candidate_zone" as const, areaHa: zone?.areaHa ?? null, sourceDates: finding.sourceDates.map((source) => source.date).filter((date): date is string => date !== null), zone: zone ? toPositions(zone.zone) : null };
    }) ?? [];
    return;
  }
  if (task.objective === "water_nitrogen_diagnosis") {
    const payload = assessment?.result as WaterNitrogenEvidencePayload | null;
    if (payload?.observation && ["variation_visible", "uniform"].includes(payload.assessment)) {
      task.stage = payload.evidenceLevel === "field_comparison" ? "同期现场记录已关联" : payload.evidenceLevel === "multi_source" ? "多源数据对比已完成" : "光学差异已计算";
    }
    const referenceDate = payload?.referenceDate ?? null;
    const spatialFindings = (payload?.zones ?? []).map((zone, index) => ({
      id: zone.id,
      title: `田内相对低值区 ${index + 1}`,
      summary: `${referenceDate ?? "本期"}${zone.meanNdvi === null ? "" : ` · NDVI ${zone.meanNdvi.toFixed(3)}`}${zone.ndviDeviation === null ? "" : ` · 与田内均值相差 ${zone.ndviDeviation.toFixed(3)}`}。`,
      severity: "watch" as const,
      findingType: "observation_zone" as const,
      scoutingRole: "low_value" as const,
      areaHa: zone.areaHa,
      sourceDates: referenceDate ? [referenceDate] : [],
      zone: toPositions(zone.zone),
      ...(zone.holes ? { zoneHoles: zone.holes.map(toPositions) } : {}),
    }));
    const scoutingTargets = payload?.observation?.variationStatus === "visible" ? [
      {
        id: "water-nitrogen-low-check",
        title: "低值区",
        summary: "在地图标出的本期 NDVI 相对低值区内记录现场情况。",
        severity: "watch" as const,
        findingType: "field_observation" as const,
        scoutingRole: "low_value" as const,
        areaHa: null,
        sourceDates: referenceDate ? [referenceDate] : [],
        zone: null,
      },
      {
        id: "water-nitrogen-reference-check",
        title: "正常区对照",
        summary: "在地块内、低值区外选择一处表现正常的位置记录对照。",
        severity: "normal" as const,
        findingType: "field_observation" as const,
        scoutingRole: "reference" as const,
        areaHa: null,
        sourceDates: referenceDate ? [referenceDate] : [],
        zone: null,
      },
    ] : [];
    task.findings = [...spatialFindings, ...scoutingTargets];
    return;
  }
  if (task.objective === "frost_risk_warning") {
    const payload = assessment?.result as { zones?: Array<{ id: string; risk: string; areaHa: number; zone: number[][] }> } | null;
    task.findings = [
      ...(assessment?.findings.map((finding) => ({ id: finding.id, title: "霜冻风险预警", summary: finding.summary, severity: assessment.result && (assessment.result as { risk?: string }).risk !== "normal" ? "watch" as const : "normal" as const, areaHa: null, sourceDates: finding.sourceDates.map((source) => source.date).filter((date): date is string => date !== null), zone: null })) ?? []),
      ...(payload?.zones ?? []).map((zone) => ({ id: zone.id, title: "低洼霜冻关注区", summary: `地形相对低洼，预报风险为${zone.risk === "high" ? "高" : "关注"}。`, severity: "watch" as const, areaHa: zone.areaHa, sourceDates: assessment?.sources.map((source) => source.date).filter((date): date is string => date !== null) ?? [], zone: toPositions(zone.zone) })),
    ];
    return;
  }
  task.findings = assessment?.findings.map((finding) => ({ id: finding.id, title: analysisObjectiveLabel(task.objective), summary: finding.summary, severity: "normal", areaHa: null, sourceDates: finding.sourceDates.map((source) => source.date).filter((date): date is string => date !== null), zone: null })) ?? [];
}

function validateScoutingLocation(task: AnalysisTask, finding: AnalysisTask["findings"][number], location: Position): string | null {
  if (task.objective !== "water_nitrogen_diagnosis" || finding.findingType !== "field_observation" || !finding.scoutingRole || finding.scoutingRole === "general") return null;
  const optical = task.analysisResults.find((result) => result.kind === "optical_condition");
  const zones = ((optical?.result as { zones?: Array<{ class?: string; zone?: number[][] }> } | null)?.zones ?? [])
    .filter((zone): zone is { class: string; zone: number[][] } => typeof zone.class === "string" && Array.isArray(zone.zone) && zone.zone.length >= 3);
  const lowValueZones = zones.filter((zone) => zone.class === "below_average");
  if (!lowValueZones.length) return "当前任务缺少可验证的对比 NDVI 低值区，请重新执行本期分析。";
  const insideLowValue = lowValueZones.some((zone) => pointInBoundary(location, toPositions(zone.zone)));
  if (finding.scoutingRole === "low_value") {
    return insideLowValue ? null : "该位置不在本期 NDVI 相对低值区内，请在地图标出的区域重新选点。";
  }
  return insideLowValue ? "该位置仍在本期 NDVI 相对低值区内，请在地块内表现正常的位置选择对照点。" : null;
}

async function artifactExists(ref: string): Promise<boolean> {
  const path = resolveAcquisitionArtifact(ref);
  if (!path) return false;
  try {
    const file = await stat(path);
    return file.isFile() && file.size > 0;
  } catch {
    return false;
  }
}

async function collectFieldVisualizations(tasks: AnalysisTask[]): Promise<FieldVisualizationCatalog> {
  const layers: FieldMapLayer[] = [];
  const charts: FieldChartArtifact[] = [];
  const layerKeys = new Set<string>();
  const chartKeys = new Set<string>();

  for (const task of tasks) {
    for (const result of task.analysisResults) {
      for (const artifact of result.artifacts) {
        if (artifact.visualization) {
          const key = `${task.id}:${artifact.visualization.source}:${artifact.visualization.date}:${artifact.visualization.metric}`;
          if (layerKeys.has(key) || !await artifactExists(artifact.ref)) continue;
          layerKeys.add(key);
          layers.push({ ref: artifact.ref, taskId: task.id, objective: task.objective, createdAt: result.createdAt, visualization: artifact.visualization });
        }
        if (artifact.chart) {
          const key = `${artifact.chart.source}:${chartCatalogTitle(artifact.chart.title)}`;
          if (chartKeys.has(key)) continue;
          chartKeys.add(key);
          const pointDates = artifact.chart.series.flatMap((series) => series.points.map((point) => point.label)).filter((label) => /^\d{4}-\d{2}-\d{2}$/.test(label));
          charts.push({
            ref: artifact.ref,
            taskId: task.id,
            objective: task.objective,
            createdAt: result.createdAt,
            sourceDates: [...new Set(pointDates.length ? pointDates : result.sources.filter((source) => source.source === artifact.chart!.source && source.date).map((source) => source.date!))].sort(),
            chart: artifact.chart,
          });
        }
      }
    }
  }
  return { layers, charts };
}

function chartCatalogTitle(title: string): string {
  if (title === "历史最低气温" || title === "历史气温") return "历史气温";
  if (title === "预报最低气温" || title === "预报气温") return "预报气温";
  return title;
}

function toPositions(zone: number[][]): Array<{ longitude: number; latitude: number }> {
  return zone.map(([longitude, latitude]) => ({ longitude: longitude!, latitude: latitude! }));
}

function analysisObjectiveLabel(objective: CreateAnalysisTaskRequest["objective"]): string {
  if (objective === "growth_stage_monitoring") return "关键生育期长势监测";
  if (objective === "waterlogging_detection") return "农田积水识别";
  if (objective === "frost_risk_warning") return "霜冻风险预警";
  return "水氮排查";
}

function taskConversationInitialContent(task: AnalysisTask): string {
  if (task.brief) return `${task.brief.headline}\n${task.brief.overview}`;
  if (task.objective === "growth_stage_monitoring") {
    const optical = task.analysisResults.find((result) => result.kind === "optical_condition" && result.result && (result.status === "succeeded" || result.status === "partial"));
    const payload = optical?.result as {
      current?: { observationDate?: string; metrics?: { ndvi?: { mean?: number } } };
      observations?: unknown[];
    } | null | undefined;
    const date = payload?.current?.observationDate;
    const ndvi = payload?.current?.metrics?.ndvi?.mean;
    const observationCount = payload?.observations?.length ?? 0;
    if (date && typeof ndvi === "number" && observationCount > 0) {
      const observed = `已读取 ${observationCount} 期可用光学田况，最近观测为 ${date}，地块平均 NDVI ${ndvi.toFixed(3)}。`;
      return task.status === "needs_input"
        ? `${observed} ${task.summary?.trim() || "还缺少形成关键生育期判断所需的地块记录。"}`
        : task.summary?.trim() || observed;
    }
  }
  return task.summary?.trim() || `${analysisObjectiveLabel(task.objective)}已结束，请查看任务结果和数据依据。`;
}

function validateFieldInput(input: FieldInput): FieldInput {
  if (!input || !input.name?.trim()) throw new FieldGeometryError("请填写地块名称。");
  if (!isCrop(input.crop)) throw new FieldGeometryError("请选择支持的作物类型。");
  if (!Number.isInteger(input.seasonYear) || input.seasonYear < 2000 || input.seasonYear > 2100) throw new FieldGeometryError("种植季年份无效。");
  return { ...input, name: input.name.trim(), plantingDate: input.plantingDate || null, variety: input.variety?.trim() || null };
}

function validateFieldUpdate(input: FieldUpdateInput): FieldUpdateInput {
  if (input.name !== undefined && !input.name.trim()) throw new FieldGeometryError("请填写地块名称。");
  if (input.crop !== undefined && !isCrop(input.crop)) throw new FieldGeometryError("请选择支持的作物类型。");
  if (input.seasonYear !== undefined && (!Number.isInteger(input.seasonYear) || input.seasonYear < 2000 || input.seasonYear > 2100)) throw new FieldGeometryError("种植季年份无效。");
  const result: FieldUpdateInput = { ...input };
  if (input.name !== undefined) result.name = input.name.trim();
  if (input.variety !== undefined) result.variety = input.variety?.trim() || null;
  return result;
}

function isCrop(value: unknown): value is FieldInput["crop"] { return value === "corn" || value === "soybean" || value === "rice"; }
function isAnalysisObjective(value: unknown): value is CreateAnalysisTaskRequest["objective"] {
  return value === "growth_stage_monitoring"
    || value === "water_nitrogen_diagnosis"
    || value === "waterlogging_detection"
    || value === "frost_risk_warning";
}
function resolveAnalysisTimeRange(input: CreateAnalysisTaskRequest, field: FieldSummary, now = new Date()): AnalysisTimeRange | string {
  if (input.period === "last_30_days") {
    return { start: new Date(now.getTime() - 30 * 86_400_000).toISOString(), end: now.toISOString() };
  }
  if (input.period === "this_season") {
    const seasonStart = field.plantingDate ? new Date(`${field.plantingDate}T00:00:00.000Z`) : new Date(Date.UTC(field.seasonYear, 0, 1));
    const seasonEnd = new Date(Math.min(now.getTime(), Date.UTC(field.seasonYear, 11, 31, 23, 59, 59, 999)));
    if (!Number.isFinite(seasonStart.getTime()) || seasonStart >= seasonEnd) return "当前种植季时间范围无效，请检查种植年份和播种日期。";
    return { start: seasonStart.toISOString(), end: seasonEnd.toISOString() };
  }
  if (input.period !== "custom") return "请选择有效的分析时间范围。";
  const start = parseAnalysisBoundary(input.timeRange?.start, false);
  const end = parseAnalysisBoundary(input.timeRange?.end, true);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) return "自定义分析时间范围必须包含有效的开始和结束时间。";
  if (end - start > 366 * 86_400_000) return "单次分析时间范围不能超过 366 天。";
  return { start: new Date(start).toISOString(), end: new Date(end).toISOString() };
}
function parseAnalysisBoundary(value: string | undefined, endOfDay: boolean): number {
  if (!value) return Number.NaN;
  return Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z` : value);
}
function cropValue(value: unknown): FieldInput["crop"] | null { return isCrop(value) ? value : null; }
function stringValue(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
function numberValue(value: unknown): number | undefined { return typeof value === "number" ? value : undefined; }
function validateAcquisitionRequest(input: CreateDataAcquisitionRequest): string | null {
  if (!input || !isDataProfile(input.dataProfile)) return "请选择有效的数据采集配置。";
  const start = Date.parse(input.period?.start);
  const end = Date.parse(input.period?.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) return "数据采集时间窗口无效。";
  if (end - start > 366 * 24 * 60 * 60 * 1000) return "单次数据采集时间窗口不能超过 366 天。";
  return null;
}
function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year!, month! - 1, day!));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month! - 1 && parsed.getUTCDate() === day;
}
function chinaCalendarDate(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
function validateFieldInspection(input: SaveFieldInspectionRequest | undefined): string | null {
  if (!input || !isCalendarDate(input.observedAt)) return "请选择有效的现场观察日期。";
  if (!input.location || !Number.isFinite(input.location.longitude) || !Number.isFinite(input.location.latitude) || Math.abs(input.location.longitude) > 180 || Math.abs(input.location.latitude) > 90) return "请选择有效的地块内现场位置。";
  if (!["dry", "normal", "wet", "standing_water", "unknown"].includes(input.waterCondition)) return "请选择现场墒情。";
  if (!["normal", "pale", "dark_green", "unknown"].includes(input.leafColor)) return "请选择现场叶色。";
  if (!["none_seen", "suspected", "unknown"].includes(input.diseaseOrPest)) return "请选择病虫害观察结果。";
  if (typeof input.note !== "string" || input.note.length > 500) return "备注不能超过 500 个字符。";
  return null;
}

function validateFieldScoutingNote(input: SaveFieldScoutingNoteRequest | undefined): string | null {
  return validateFieldInspection(input);
}
function sendFieldError(reply: { code(status: number): { send(body: unknown): unknown } }, error: unknown) {
  const message = error instanceof Error ? error.message : "地块保存失败。";
  return reply.code(422).send({ code: "invalid_field", message });
}

interface GeoJsonFeatureCollection {
  type: "FeatureCollection";
  features: Array<{
    type: "Feature";
    properties?: Record<string, unknown>;
    geometry: { type: "Polygon"; coordinates: Array<Array<[number, number]>> } | null;
  }>;
}

function fieldWithLatestAnalysis(field: FieldSummary, tasks: AnalysisTask[]): FieldSummary {
  const latest = tasks.find((task) => task.completedAt
    && (task.status === "completed" || task.status === "partial" || task.status === "needs_review")
    && task.findings.length > 0);
  if (!latest) return field;
  return {
    ...field,
    latestStatus: latest.findings.some((finding) => finding.severity === "watch") ? "watch" : "normal",
    latestAnalyzedAt: latest.completedAt,
  };
}

function toPublicTask(task: StoredTask): AnalysisTask {
  return { ...task, failure: task.failure ?? null };
}
