import type { AnalysisResult, AnalysisTask, AnalysisTimeRange, DataAcquisitionRun, FieldSummary, SourceAcquisitionResult } from "@chernozem/contracts";
import type { ControlledAnalysisTool, ControlledToolName } from "@chernozem/agent-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { buildApp } from "./app.js";
import { createMemoryAcquisitionStore } from "./acquisition-store.js";
import { createMemoryAnalysisResultStore } from "./analysis-store.js";
import { createMemoryAgentRunStore } from "./agent-run-store.js";
import { GrowthAnalysisService, type OpticalPythonResult } from "./analysis-tools.js";
import { MultiSourceAnalysisService, type MultiSourceRunners } from "./multi-source-analysis.js";
import { createMemoryAnalysisTaskStore } from "./task-store.js";
import { createMemoryFieldStore } from "./field-store.js";
import { DataAcquisitionService, type AcquisitionProvider } from "./data-acquisition.js";
import { createMemoryTaskConversationStore } from "./task-conversation-store.js";
import { createMemoryScoutingNoteStore } from "./scouting-store.js";

const apps: Array<ReturnType<typeof buildApp>> = [];
const artifactCleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(artifactCleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("analysis API", () => {
  it("returns a confirmable workflow plan for an explicit field-analysis request", async () => {
    const fieldStore = createMemoryFieldStore();
    const taskStore = createMemoryAnalysisTaskStore();
    const field = await fieldStore.create({
      name: "对话测试田", crop: "corn", seasonYear: 2026, plantingDate: "2026-05-05", variety: null,
      boundary: [{ longitude: 123.8, latitude: 42.3 }, { longitude: 123.81, latitude: 42.3 }, { longitude: 123.81, latitude: 42.31 }, { longitude: 123.8, latitude: 42.31 }],
    });
    const app = buildApp({ fieldStore, taskStore });
    apps.push(app);

    const response = await app.inject({ method: "POST", url: `/api/v1/fields/${field.id}/messages`, payload: { content: "帮我看看有没有霜冻风险" } });

    expect(response.statusCode).toBe(201);
    expect(response.json().workflowPlan).toMatchObject({
      objective: "frost_risk_warning", requiresConfirmation: true,
      startRequest: {
        fieldId: field.id, crop: "corn", period: "last_30_days", objective: "frost_risk_warning",
        message: "帮我看看有没有霜冻风险",
      },
    });
    expect(response.json().workflowStatus).toBeNull();
    expect(response.json().taskResult).toBeNull();
    expect(response.json().assistantMessage.content).toContain("确认后开始");
    expect((await app.inject({ method: "GET", url: "/api/v1/tasks" })).json().tasks).toHaveLength(0);

    const started = await app.inject({ method: "POST", url: "/api/v1/tasks", payload: response.json().workflowPlan.startRequest });
    expect(started.statusCode).toBe(202);
    expect(started.json()).toMatchObject({ objective: "frost_risk_warning", requestMessage: "帮我看看有没有霜冻风险" });
    expect(await taskStore.list(field.id)).toHaveLength(1);
  });

  it("keeps a general agronomy question as pure conversation", async () => {
    const fieldStore = createMemoryFieldStore();
    const field = await fieldStore.create({
      name: "问答测试田", crop: "corn", seasonYear: 2026, plantingDate: "2026-05-05", variety: null,
      boundary: [{ longitude: 123.8, latitude: 42.3 }, { longitude: 123.81, latitude: 42.3 }, { longitude: 123.81, latitude: 42.31 }, { longitude: 123.8, latitude: 42.31 }],
    });
    const app = buildApp({ fieldStore });
    apps.push(app);

    const response = await app.inject({ method: "POST", url: `/api/v1/fields/${field.id}/messages`, payload: { content: "霜冻通常是怎么形成的？" } });

    expect(response.statusCode).toBe(201);
    expect(response.json().workflowPlan).toBeNull();
    expect(response.json().workflowStatus).toBeNull();
    expect(response.json().taskResult).toBeNull();
  });

  it("reads field context without calling the model or changing tasks", async () => {
    const fieldStore = createMemoryFieldStore();
    const taskStore = createMemoryAnalysisTaskStore();
    const field = await fieldStore.create({
      name: "档案查询测试田", crop: "corn", seasonYear: 2026, plantingDate: "2026-05-05", variety: "先玉 335",
      boundary: [{ longitude: 123.8, latitude: 42.3 }, { longitude: 123.81, latitude: 42.3 }, { longitude: 123.81, latitude: 42.31 }, { longitude: 123.8, latitude: 42.31 }],
    });
    const app = buildApp({
      fieldStore,
      taskStore,
      fieldConversationAgent: { async reply() { throw new Error("地块资料查询不应调用对话模型"); } },
    });
    apps.push(app);

    const response = await app.inject({ method: "POST", url: `/api/v1/fields/${field.id}/messages`, payload: { content: "这块地多大，什么时候播种的？" } });

    expect(response.statusCode).toBe(201);
    expect(response.json().fieldContext).toMatchObject({
      tool: "get_field_context", status: "found", requestedFocus: "profile",
      field: { name: "档案查询测试田", crop: "corn", plantingDate: "2026-05-05", variety: "先玉 335" },
    });
    expect(response.json().assistantMessage.content).toContain("5月5日播种");
    expect(response.json().workflowPlan).toBeNull();
    expect(response.json().workflowStatus).toBeNull();
    expect(response.json().taskResult).toBeNull();
    expect(await taskStore.list(field.id)).toEqual([]);
  });

  it("reads the latest matching workflow status without starting another task", async () => {
    const fieldStore = createMemoryFieldStore();
    const taskStore = createMemoryAnalysisTaskStore();
    const field = await fieldStore.create({
      name: "状态查询测试田", crop: "corn", seasonYear: 2026, plantingDate: "2026-05-05", variety: null,
      boundary: [{ longitude: 123.8, latitude: 42.3 }, { longitude: 123.81, latitude: 42.3 }, { longitude: 123.81, latitude: 42.31 }, { longitude: 123.8, latitude: 42.31 }],
    });
    const frost = taskWithInspectionFindings();
    frost.id = "44444444-4444-4444-8444-444444444444";
    frost.fieldId = field.id;
    frost.objective = "frost_risk_warning";
    frost.status = "needs_data";
    frost.stage = "等待天气预报";
    frost.summary = "暂时没有未来低温预报。";
    frost.createdAt = "2026-08-19T08:00:00.000Z";
    const newerGrowth = structuredClone(frost);
    newerGrowth.id = "55555555-5555-4555-8555-555555555555";
    newerGrowth.objective = "growth_stage_monitoring";
    newerGrowth.status = "completed";
    newerGrowth.summary = "长势总体稳定。";
    newerGrowth.createdAt = "2026-08-20T08:00:00.000Z";
    await taskStore.save(frost);
    await taskStore.save(newerGrowth);
    const app = buildApp({
      fieldStore,
      taskStore,
      fieldConversationAgent: { async reply() { throw new Error("状态查询不应调用对话模型"); } },
    });
    apps.push(app);

    const response = await app.inject({ method: "POST", url: `/api/v1/fields/${field.id}/messages`, payload: { content: "霜冻预警任务完成了吗？" } });

    expect(response.statusCode).toBe(201);
    expect(response.json().workflowPlan).toBeNull();
    expect(response.json().workflowStatus).toMatchObject({
      tool: "get_workflow_status", status: "found", requestedObjective: "frost_risk_warning",
      task: { id: frost.id, status: "needs_data" },
    });
    expect(response.json().assistantMessage.content).toBe("霜冻预警正在等待观测数据。 暂时没有未来低温预报。");
    expect(await taskStore.list(field.id)).toHaveLength(2);
  });

  it("answers a status question explicitly when no workflow exists", async () => {
    const fieldStore = createMemoryFieldStore();
    const field = await fieldStore.create({
      name: "无任务测试田", crop: "corn", seasonYear: 2026, plantingDate: "2026-05-05", variety: null,
      boundary: [{ longitude: 123.8, latitude: 42.3 }, { longitude: 123.81, latitude: 42.3 }, { longitude: 123.81, latitude: 42.31 }, { longitude: 123.8, latitude: 42.31 }],
    });
    const app = buildApp({ fieldStore });
    apps.push(app);

    const response = await app.inject({ method: "POST", url: `/api/v1/fields/${field.id}/messages`, payload: { content: "刚才那个任务跑到哪了？" } });

    expect(response.statusCode).toBe(201);
    expect(response.json().workflowStatus).toMatchObject({ status: "not_found", requestedObjective: null, task: null });
    expect(response.json().assistantMessage.content).toBe("这块农田还没有分析任务。");
  });

  it("reads a published task result without calling the model or creating a task", async () => {
    const fieldStore = createMemoryFieldStore();
    const taskStore = createMemoryAnalysisTaskStore();
    const field = await fieldStore.create({
      name: "结果查询测试田", crop: "corn", seasonYear: 2026, plantingDate: "2026-05-05", variety: null,
      boundary: [{ longitude: 123.8, latitude: 42.3 }, { longitude: 123.81, latitude: 42.3 }, { longitude: 123.81, latitude: 42.31 }, { longitude: 123.8, latitude: 42.31 }],
    });
    const task = taskWithInspectionFindings();
    task.fieldId = field.id;
    task.objective = "growth_stage_monitoring";
    task.summary = "西南区域近期长势下降。";
    task.brief = {
      version: "analysis-brief-v2", headline: "西南区域近期长势下降", overview: "变化集中在 8 月 18 日后。", reasoning: "两期光学观测共同支持。", uncertainty: null,
      evidence: [{ statement: "田内低值区连续存在。", sourceDates: [{ source: "Sentinel-2", date: "2026-08-20" }] }], actions: [],
      generation: { mode: "deterministic", generatedAt: "2026-08-20T00:00:00.000Z", provider: null, modelId: null, promptVersion: null, fallbackReason: null },
    };
    await taskStore.save(task);
    const app = buildApp({
      fieldStore,
      taskStore,
      fieldConversationAgent: { async reply() { throw new Error("结果查询不应调用对话模型"); } },
    });
    apps.push(app);

    const response = await app.inject({ method: "POST", url: `/api/v1/fields/${field.id}/messages`, payload: { content: "上次长势分析的结论是什么？" } });

    expect(response.statusCode).toBe(201);
    expect(response.json().taskResult).toMatchObject({
      tool: "get_task_result", status: "found", requestedObjective: "growth_stage_monitoring", requestedFocus: "summary",
      task: { id: task.id, headline: "西南区域近期长势下降" },
    });
    expect(response.json().assistantMessage.content).toBe("西南区域近期长势下降 变化集中在 8 月 18 日后。");
    expect(await taskStore.list(field.id)).toHaveLength(1);
  });

  it("returns a confirmable scouting-note draft without calling the model or saving a note", async () => {
    const fieldStore = createMemoryFieldStore();
    const scoutingNoteStore = createMemoryScoutingNoteStore();
    const field = await fieldStore.create({
      name: "巡田对话测试田", crop: "corn", seasonYear: 2026, plantingDate: "2026-05-05", variety: null,
      boundary: [{ longitude: 123.8, latitude: 42.3 }, { longitude: 123.81, latitude: 42.3 }, { longitude: 123.81, latitude: 42.31 }, { longitude: 123.8, latitude: 42.31 }],
    });
    const app = buildApp({
      fieldStore,
      scoutingNoteStore,
      fieldConversationAgent: { async reply() { throw new Error("巡田草稿不应调用对话模型"); } },
    });
    apps.push(app);

    const response = await app.inject({ method: "POST", url: `/api/v1/fields/${field.id}/messages`, payload: { content: "记一下，今天田里叶色偏黄、墒情偏干，未见病虫害" } });

    expect(response.statusCode).toBe(201);
    expect(response.json().workflowPlan).toBeNull();
    expect(response.json().workflowStatus).toBeNull();
    expect(response.json().scoutingNoteDraft).toMatchObject({
      tool: "record_scouting_note", status: "draft", fieldId: field.id, location: null,
      waterCondition: "dry", leafColor: "pale", diseaseOrPest: "none_seen",
      missingInputs: ["现场位置"], requiresConfirmation: true,
    });
    expect(await scoutingNoteStore.list(field.id)).toEqual([]);
  });

  it("removes an out-of-field coordinate from a conversation scouting draft", async () => {
    const fieldStore = createMemoryFieldStore();
    const field = await fieldStore.create({
      name: "巡田范围测试田", crop: "corn", seasonYear: 2026, plantingDate: "2026-05-05", variety: null,
      boundary: [{ longitude: 123.8, latitude: 42.3 }, { longitude: 123.81, latitude: 42.3 }, { longitude: 123.81, latitude: 42.31 }, { longitude: 123.8, latitude: 42.31 }],
    });
    const app = buildApp({ fieldStore });
    apps.push(app);

    const response = await app.inject({ method: "POST", url: `/api/v1/fields/${field.id}/messages`, payload: { content: "保存现场记录：坐标 120.1, 40.1，叶色深绿" } });

    expect(response.json().scoutingNoteDraft).toMatchObject({ location: null, leafColor: "dark_green", missingInputs: ["现场位置"] });
  });

  it("routes a natural-language field request through the Agent planner", async () => {
    const fieldStore = createMemoryFieldStore();
    const field = await fieldStore.create({
      name: "路由测试田", crop: "corn", seasonYear: 2026, plantingDate: "2026-05-05", variety: null,
      boundary: [{ longitude: 123.8, latitude: 42.3 }, { longitude: 123.81, latitude: 42.3 }, { longitude: 123.81, latitude: 42.31 }, { longitude: 123.8, latitude: 42.31 }],
    });
    const requests: string[] = [];
    const app = buildApp({
      fieldStore,
      analysisRequestRouter: {
        async route(input) {
          requests.push(`${input.field.id}:${input.message}:${input.periodHint}`);
          return { objective: "waterlogging_detection", period: "last_30_days" };
        },
      },
    });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/agent/plan",
      payload: { fieldId: field.id, message: "昨天下大雨，看看有没有积水", periodHint: "this_season" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ plan: { objective: "waterlogging_detection", period: "last_30_days" } });
    expect(requests).toEqual([`${field.id}:昨天下大雨，看看有没有积水:this_season`]);
  });

  it("rejects empty natural-language Agent requests", async () => {
    const fieldStore = createMemoryFieldStore();
    const field = await fieldStore.create({
      name: "路由测试田", crop: "corn", seasonYear: 2026, plantingDate: null, variety: null,
      boundary: [{ longitude: 123.8, latitude: 42.3 }, { longitude: 123.81, latitude: 42.3 }, { longitude: 123.81, latitude: 42.31 }, { longitude: 123.8, latitude: 42.31 }],
    });
    const app = buildApp({ fieldStore });
    apps.push(app);

    const response = await app.inject({ method: "POST", url: "/api/v1/agent/plan", payload: { fieldId: field.id, message: "   " } });

    expect(response.statusCode).toBe(422);
    expect(response.json().code).toBe("invalid_agent_request");
  });

  it("starts with no preloaded demonstration fields", async () => {
    const app = buildApp();
    apps.push(app);

    const fieldsResponse = await app.inject({ method: "GET", url: "/api/v1/fields" });
    expect(fieldsResponse.statusCode).toBe(200);
    expect(fieldsResponse.json().fields).toEqual([]);

    const taskResponse = await app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      payload: {
        fieldId: "field-not-yet-imported",
        crop: "corn",
        period: "last_30_days",
        objective: "growth_stage_monitoring",
      },
    });
    expect(taskResponse.statusCode).toBe(404);
    expect(taskResponse.json().code).toBe("field_not_found");
  });

  it("derives the field status from the latest delivered analysis task", async () => {
    const fieldStore = createMemoryFieldStore();
    const taskStore = createMemoryAnalysisTaskStore();
    const field = await fieldStore.create({
      name: "状态测试田", crop: "corn", seasonYear: 2026, plantingDate: "2026-05-05", variety: null,
      boundary: [{ longitude: 123.8, latitude: 42.3 }, { longitude: 123.81, latitude: 42.3 }, { longitude: 123.81, latitude: 42.31 }, { longitude: 123.8, latitude: 42.31 }],
    });
    const delivered = taskWithInspectionFindings();
    delivered.fieldId = field.id;
    delivered.status = "partial";
    delivered.completedAt = "2026-08-19T03:37:14.873Z";
    delivered.findings = [{ ...delivered.findings[0]!, severity: "watch" }];
    await taskStore.save(delivered);
    const failed = structuredClone(delivered);
    failed.id = "44444444-4444-4444-8444-444444444444";
    failed.createdAt = "2026-08-19T04:00:00.000Z";
    failed.completedAt = "2026-08-19T04:01:00.000Z";
    failed.status = "failed";
    failed.findings = [];
    await taskStore.save(failed);
    const app = buildApp({ fieldStore, taskStore });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/api/v1/fields" });

    expect(response.json().fields[0]).toMatchObject({ latestStatus: "watch", latestAnalyzedAt: delivered.completedAt });
  });

  it("lists persisted analysis tasks newest first", async () => {
    const taskStore = createMemoryAnalysisTaskStore();
    const older = taskWithInspectionFindings();
    older.id = "11111111-1111-4111-8111-111111111111";
    older.createdAt = "2026-08-16T08:00:00.000Z";
    const newer = structuredClone(older);
    newer.id = "22222222-2222-4222-8222-222222222222";
    newer.createdAt = "2026-08-18T08:00:00.000Z";
    newer.objective = "growth_stage_monitoring";
    await taskStore.save(older);
    await taskStore.save(newer);
    const app = buildApp({ taskStore });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/api/v1/tasks" });

    expect(response.statusCode).toBe(200);
    expect(response.json().tasks.map((task: AnalysisTask) => task.id)).toEqual([newer.id, older.id]);

    const filtered = await app.inject({ method: "GET", url: "/api/v1/tasks?limit=1&objective=water_nitrogen_diagnosis" });
    expect(filtered.statusCode).toBe(200);
    expect(filtered.json().tasks.map((task: AnalysisTask) => task.id)).toEqual([older.id]);

    const invalid = await app.inject({ method: "GET", url: "/api/v1/tasks?objective=unknown" });
    expect(invalid.statusCode).toBe(400);
  });

  it("returns the latest Pi run as a stable tool trace", async () => {
    const taskStore = createMemoryAnalysisTaskStore();
    const agentRunStore = createMemoryAgentRunStore();
    const task = taskWithInspectionFindings();
    await taskStore.save(task);
    await agentRunStore.start({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      organizationId: "11111111-1111-4111-8111-111111111111",
      taskId: task.id,
      provider: "mytokenpi",
      modelId: "gpt-5.4",
      startedAt: "2026-08-19T10:00:00.000Z",
    });
    await agentRunStore.append({
      runId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", sequence: 1, type: "tool_execution_start",
      occurredAt: "2026-08-19T10:00:01.000Z", toolCallId: "call-1", toolName: "analyze_optical_condition",
    });
    await agentRunStore.append({
      runId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", sequence: 2, type: "tool_execution_end",
      occurredAt: "2026-08-19T10:00:02.000Z", toolCallId: "call-1", toolName: "analyze_optical_condition",
      isError: false, resultId: "result-1", resultStatus: "succeeded",
    });
    await agentRunStore.complete(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "地块长势分析完成。",
      "2026-08-19T10:00:03.000Z",
    );
    const app = buildApp({ taskStore, agentRunStore });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: `/api/v1/tasks/${task.id}/agent-run` });

    expect(response.statusCode).toBe(200);
    expect(response.json().run).toEqual({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      taskId: task.id,
      provider: "mytokenpi",
      modelId: "gpt-5.4",
      status: "completed",
      startedAt: "2026-08-19T10:00:00.000Z",
      completedAt: "2026-08-19T10:00:03.000Z",
      finalMessage: "地块长势分析完成。",
      errorMessage: null,
      tools: [{
        sequence: 1,
        toolCallId: "call-1",
        toolName: "analyze_optical_condition",
        status: "completed",
        startedAt: "2026-08-19T10:00:01.000Z",
        completedAt: "2026-08-19T10:00:02.000Z",
        resultId: "result-1",
        resultStatus: "succeeded",
      }],
    });
  });

  it("returns no Agent run for a task that did not invoke Pi", async () => {
    const taskStore = createMemoryAnalysisTaskStore();
    const task = taskWithInspectionFindings();
    await taskStore.save(task);
    const app = buildApp({ taskStore });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: `/api/v1/tasks/${task.id}/agent-run` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ run: null });
  });

  it("persists one initial result and a complete task-scoped conversation exchange", async () => {
    const taskStore = createMemoryAnalysisTaskStore();
    const taskConversationStore = createMemoryTaskConversationStore();
    const task = taskWithInspectionFindings();
    await taskStore.save(task);
    const requests: string[] = [];
    const app = buildApp({
      taskStore,
      taskConversationStore,
      taskConversationAgent: {
        async reply(request) {
          requests.push(`${request.task.id}:${request.history.length}:${request.userMessage}`);
          return "优先核查地图中的相对低值区。";
        },
      },
    });
    apps.push(app);

    const initial = await app.inject({ method: "GET", url: `/api/v1/tasks/${task.id}/conversation` });
    const response = await app.inject({ method: "POST", url: `/api/v1/tasks/${task.id}/messages`, payload: { content: "先去哪里看？" } });
    const repeated = await app.inject({ method: "GET", url: `/api/v1/tasks/${task.id}/conversation` });

    expect(initial.statusCode).toBe(200);
    expect(initial.json().messages).toMatchObject([{ sequence: 1, role: "assistant", kind: "analysis_result", content: task.summary }]);
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      userMessage: { sequence: 2, role: "user", content: "先去哪里看？" },
      assistantMessage: { sequence: 3, role: "assistant", content: "优先核查地图中的相对低值区。" },
    });
    expect(requests).toEqual([`${task.id}:1:先去哪里看？`]);
    expect(repeated.json().messages).toHaveLength(3);
    expect(repeated.json().messages.filter((message: { kind: string }) => message.kind === "analysis_result")).toHaveLength(1);
  });

  it("uses the professional brief for the initial task conversation", async () => {
    const taskStore = createMemoryAnalysisTaskStore();
    const taskConversationStore = createMemoryTaskConversationStore();
    const task = taskWithInspectionFindings();
    task.brief = {
      version: "analysis-brief-v2",
      headline: "田内低值区已定位，下一步需要现场对照",
      overview: "本期观测定位到 1 个相对低值区，先与田内正常区对照。",
      reasoning: "光学差异只能用于筛查。",
      uncertainty: "当前不能确认缺水或缺氮。",
      evidence: [], actions: [],
      generation: { mode: "deterministic", generatedAt: "2026-08-18T00:01:00.000Z", provider: null, modelId: null, promptVersion: null, fallbackReason: null },
    };
    await taskStore.save(task);
    const app = buildApp({ taskStore, taskConversationStore });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: `/api/v1/tasks/${task.id}/conversation` });

    expect(response.statusCode).toBe(200);
    expect(response.json().messages[0].content).toBe(`${task.brief.headline}\n${task.brief.overview}`);
    expect(response.json().messages[0].content).not.toContain(task.summary);
  });

  it("keeps ordinary field chat out of the analysis task workflow", async () => {
    const fieldStore = createMemoryFieldStore();
    const field = await fieldStore.create({
      name: "普通对话测试田",
      crop: "corn",
      seasonYear: 2026,
      plantingDate: "2026-05-04",
      variety: null,
      boundary: [{ longitude: 123.8, latitude: 42.3 }, { longitude: 123.81, latitude: 42.3 }, { longitude: 123.81, latitude: 42.31 }, { longitude: 123.8, latitude: 42.31 }],
    });
    const requests: string[] = [];
    const app = buildApp({
      fieldStore,
      fieldConversationAgent: {
        async reply(request) {
          requests.push(`${request.field.id}:${request.history.length}:${request.userMessage}`);
          return "你好，我在。";
        },
      },
    });
    apps.push(app);

    const response = await app.inject({ method: "POST", url: `/api/v1/fields/${field.id}/messages`, payload: { content: "你好" } });
    const history = await app.inject({ method: "GET", url: `/api/v1/fields/${field.id}/conversation` });
    const tasks = await app.inject({ method: "GET", url: "/api/v1/tasks" });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      userMessage: { sequence: 1, role: "user", content: "你好" },
      assistantMessage: { sequence: 2, role: "assistant", content: "你好，我在。" },
    });
    expect(history.json().messages).toHaveLength(2);
    expect(tasks.json().tasks).toHaveLength(0);
    expect(requests).toEqual([`${field.id}:0:你好`]);
  });

  it("keeps usable optical observations in the initial Agent reply when crop stage is missing", async () => {
    const taskStore = createMemoryAnalysisTaskStore();
    const task = taskWithInspectionFindings();
    task.objective = "growth_stage_monitoring";
    task.status = "needs_input";
    task.summary = "缺少播种日期，暂不能估计玉米生育期。不能形成关键生育期长势判断。";
    task.analysisResults = [{
      id: "optical-initial-reply",
      taskId: task.id,
      kind: "optical_condition",
      status: "succeeded",
      toolVersion: "test",
      createdAt: "2026-08-05T00:00:00.000Z",
      execution: testExecution("analyze_optical_condition", task.fieldId),
      summary: "已读取 3 个可用光学日期。",
      result: {
        current: { observationDate: "2026-08-05", metrics: { ndvi: { mean: 0.8187 } } },
        observations: [{}, {}, {}],
      },
      sources: [{ source: "sentinel-2", date: "2026-08-05", quality: "usable", note: "可用" }],
      findings: [],
      artifacts: [],
      limitations: [],
      nextActions: [],
      error: null,
    }];
    await taskStore.save(task);
    const app = buildApp({ taskStore });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: `/api/v1/tasks/${task.id}/conversation` });

    expect(response.statusCode).toBe(200);
    expect(response.json().messages[0].content).toBe(
      "已读取 3 期可用光学田况，最近观测为 2026-08-05，地块平均 NDVI 0.819。 缺少播种日期，暂不能估计玉米生育期。不能形成关键生育期长势判断。",
    );
  });

  it("rejects conversation while a task is running or after it failed", async () => {
    const taskStore = createMemoryAnalysisTaskStore();
    const running = taskWithInspectionFindings();
    running.id = "44444444-4444-4444-8444-444444444444";
    running.status = "running";
    const failed = taskWithInspectionFindings();
    failed.id = "55555555-5555-4555-8555-555555555555";
    failed.status = "failed";
    await taskStore.save(running);
    await taskStore.save(failed);
    const app = buildApp({ taskStore });
    apps.push(app);

    const runningResponse = await app.inject({ method: "POST", url: `/api/v1/tasks/${running.id}/messages`, payload: { content: "解释一下" } });
    const failedResponse = await app.inject({ method: "POST", url: `/api/v1/tasks/${failed.id}/messages`, payload: { content: "解释一下" } });

    expect(runningResponse.statusCode).toBe(409);
    expect(runningResponse.json().code).toBe("task_still_running");
    expect(failedResponse.statusCode).toBe(409);
    expect(failedResponse.json().code).toBe("task_not_conversable");
  });

  it("lists persisted field visualizations, deduplicates charts, and skips missing map artifacts", async () => {
    const taskStore = createMemoryAnalysisTaskStore();
    const app = buildApp({ taskStore });
    apps.push(app);
    const fieldResponse = await app.inject({ method: "POST", url: "/api/v1/fields", payload: {
      name: "图层目录测试田", crop: "corn", seasonYear: 2026, plantingDate: "2026-05-04",
      boundary: [{ longitude: 123.8, latitude: 42.3 }, { longitude: 123.81, latitude: 42.3 }, { longitude: 123.81, latitude: 42.31 }, { longitude: 123.8, latitude: 42.31 }],
    } });
    const fieldId = fieldResponse.json().field.id as string;
    const directoryRef = `analysis/layer-catalog-${fieldId}`;
    const directory = resolve(import.meta.dirname, "../../../runtime/artifacts", directoryRef);
    artifactCleanupPaths.push(directory);
    await mkdir(directory, { recursive: true });
    await writeFile(resolve(directory, "ndvi.png"), Buffer.from([137, 80, 78, 71]));

    await taskStore.save(taskWithLayer(fieldId, "11111111-1111-4111-8111-111111111111", "2026-08-16T10:00:00.000Z", `${directoryRef}/ndvi.png`));
    await taskStore.save(taskWithLayer(fieldId, "22222222-2222-4222-8222-222222222222", "2026-08-17T10:00:00.000Z", `${directoryRef}/missing.png`));

    const response = await app.inject({ method: "GET", url: `/api/v1/fields/${fieldId}/visualizations` });
    expect(response.statusCode).toBe(200);
    expect(response.json().layers).toEqual([expect.objectContaining({
      ref: `${directoryRef}/ndvi.png`,
      taskId: "11111111-1111-4111-8111-111111111111",
      visualization: expect.objectContaining({ source: "sentinel-2", metric: "ndvi", date: "2026-08-16" }),
    })]);
    expect(response.json().charts).toEqual([expect.objectContaining({
      ref: "analysis/22222222-2222-4222-8222-222222222222/weather-rainfall",
      taskId: "22222222-2222-4222-8222-222222222222",
      sourceDates: ["2026-08-15"],
      chart: expect.objectContaining({ source: "era5-land", title: "历史降雨" }),
    })]);
  });

  it("creates, updates, and archives a validated field", async () => {
    const app = buildApp();
    apps.push(app);
    const boundary = [
      { longitude: 123.8, latitude: 42.3 },
      { longitude: 123.81, latitude: 42.3 },
      { longitude: 123.81, latitude: 42.31 },
      { longitude: 123.8, latitude: 42.31 },
    ];

    const created = await app.inject({ method: "POST", url: "/api/v1/fields", payload: { name: "北田 01", crop: "corn", seasonYear: 2026, plantingDate: "2026-05-04", variety: "先玉 335", boundary } });
    expect(created.statusCode).toBe(201);
    expect(created.json().field).toMatchObject({ name: "北田 01", plantingDate: "2026-05-04", variety: "先玉 335" });
    expect(created.json().field.boundary).toHaveLength(5);
    const id = created.json().field.id as string;

    const updated = await app.inject({ method: "PATCH", url: `/api/v1/fields/${id}`, payload: { name: "北田 02" } });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().field).toMatchObject({ name: "北田 02", plantingDate: "2026-05-04", variety: "先玉 335" });

    const metadataOnly = await app.inject({ method: "PATCH", url: `/api/v1/fields/${id}`, payload: {
      name: "北田 02", crop: "corn", seasonYear: 2026, plantingDate: "2026-05-05", variety: null,
      boundary: boundary.map((point) => ({ longitude: point.longitude + 1e-10, latitude: point.latitude - 1e-10 })),
    } });
    expect(metadataOnly.statusCode).toBe(200);
    expect(metadataOnly.json().field).toMatchObject({ plantingDate: "2026-05-05", boundaryVersion: 1 });

    const nextSeason = await app.inject({ method: "PATCH", url: `/api/v1/fields/${id}`, payload: {
      crop: "corn", seasonYear: 2027, plantingDate: "2027-05-02", variety: "先玉 335",
      boundary: [
        { longitude: 123.8, latitude: 42.3 },
        { longitude: 123.812, latitude: 42.3 },
        { longitude: 123.812, latitude: 42.31 },
        { longitude: 123.8, latitude: 42.31 },
      ],
    } });
    expect(nextSeason.statusCode).toBe(200);
    expect(nextSeason.json().field).toMatchObject({ seasonYear: 2027, boundaryVersion: 2, seasonCount: 2 });

    const history = await app.inject({ method: "GET", url: `/api/v1/fields/${id}/history` });
    expect(history.statusCode).toBe(200);
    expect(history.json().history.seasons.map((season: { seasonYear: number }) => season.seasonYear)).toEqual([2027, 2026]);
    expect(history.json().history.boundaryVersions.map((version: { version: number }) => version.version)).toEqual([2, 1]);

    const archived = await app.inject({ method: "DELETE", url: `/api/v1/fields/${id}` });
    expect(archived.statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: "/api/v1/fields" })).json().fields).toEqual([]);
  });

  it("rejects self-intersecting field geometry", async () => {
    const app = buildApp();
    apps.push(app);
    const response = await app.inject({ method: "POST", url: "/api/v1/fields", payload: {
      name: "无效边界", crop: "corn", seasonYear: 2026,
      boundary: [{ longitude: 123.8, latitude: 42.3 }, { longitude: 123.81, latitude: 42.31 }, { longitude: 123.81, latitude: 42.3 }, { longitude: 123.8, latitude: 42.31 }],
    } });
    expect(response.statusCode).toBe(422);
    expect(response.json().code).toBe("invalid_field");
  });

  it("does not invent a result for an unknown unsupported-crop field", async () => {
    const app = buildApp();
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      payload: {
        fieldId: "field-not-yet-imported",
        crop: "soybean",
        period: "last_30_days",
        objective: "growth_stage_monitoring",
      },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().code).toBe("field_not_found");
  });

  it("binds a started workflow to the field crop instead of trusting the request", async () => {
    const fieldStore = createMemoryFieldStore();
    const field = await fieldStore.create({
      name: "大豆测试田", crop: "soybean", seasonYear: 2026,
      boundary: [{ longitude: 123.8, latitude: 42.3 }, { longitude: 123.81, latitude: 42.3 }, { longitude: 123.81, latitude: 42.31 }, { longitude: 123.8, latitude: 42.31 }],
    });
    const app = buildApp({ fieldStore });
    apps.push(app);

    const response = await app.inject({
      method: "POST", url: "/api/v1/tasks",
      payload: { fieldId: field.id, crop: "corn", period: "last_30_days", objective: "growth_stage_monitoring" },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().code).toBe("crop_not_supported");
  });

  it("returns an explicit data gap while real acquisition sources are not connected", async () => {
    const app = buildApp();
    apps.push(app);
    const createdField = await app.inject({ method: "POST", url: "/api/v1/fields", payload: {
      name: "待分析地块", crop: "corn", seasonYear: 2026,
      boundary: [{ longitude: 123.8, latitude: 42.3 }, { longitude: 123.81, latitude: 42.3 }, { longitude: 123.81, latitude: 42.31 }, { longitude: 123.8, latitude: 42.31 }],
    } });
    const fieldId = createdField.json().field.id as string;
    const createdTask = await app.inject({ method: "POST", url: "/api/v1/tasks", payload: { fieldId, crop: "corn", period: "last_30_days", objective: "waterlogging_detection" } });
    expect(createdTask.statusCode).toBe(202);
    expect(createdTask.json()).toMatchObject({
      objective: "waterlogging_detection",
      status: "needs_data",
      stage: "等待地块数据采集",
      findings: [],
      sources: [
        { source: "sentinel-1", quality: "missing" },
        { source: "copernicus-dem", quality: "missing" },
        { source: "era5-land", quality: "missing" },
      ],
      analysisResults: [],
      limitations: ["该地块尚未建立分析数据；需要 Sentinel-1 雷达、Copernicus DEM、ERA5-Land 历史天气。"],
      nextActions: [{ code: "collect_waterlogging_v1", label: "打开地块数据并开始采集" }],
    });
    expect(createdTask.json()).not.toHaveProperty("sceneSearch");
    expect(createdTask.json()).not.toHaveProperty("observation");
    expect(createdTask.json().summary).toContain("尚未建立分析数据");
  });

  it("does not call the Agent when a matching run lacks complete optical assets", async () => {
    const fieldStore = createMemoryFieldStore();
    const acquisitionStore = createMemoryAcquisitionStore();
    const field = await fieldStore.create({
      name: "光学资产缺失测试田", crop: "corn", seasonYear: 2026, plantingDate: "2026-05-05", variety: null,
      boundary: [{ longitude: 123.8, latitude: 42.3 }, { longitude: 123.81, latitude: 42.3 }, { longitude: 123.81, latitude: 42.31 }, { longitude: 123.8, latitude: 42.31 }],
    });
    const incomplete = integrationAcquisition();
    incomplete.fieldId = field.id;
    incomplete.sources[0]!.selectedAssets = incomplete.sources[0]!.selectedAssets
      .filter((asset) => !asset.providerAssetId.endsWith(":B02+B03+B04+B08"));
    await acquisitionStore.save(incomplete);
    let executionCount = 0;
    const app = buildApp({
      fieldStore,
      acquisitionService: new DataAcquisitionService(acquisitionStore, []),
      analysisTaskExecutor: {
        async run() {
          executionCount += 1;
          return { runId: null, finalMessage: null, results: [] };
        },
      },
    });
    apps.push(app);

    const response = await app.inject({ method: "POST", url: "/api/v1/tasks", payload: {
      fieldId: field.id,
      crop: "corn",
      period: "custom",
      objective: "growth_stage_monitoring",
      timeRange: { start: "2026-08-01", end: "2026-08-18" },
    } });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      status: "needs_data",
      stage: "等待可分析光学数据",
      sources: [{ source: "sentinel-2", quality: "missing" }],
      limitations: ["已有采集记录，但没有同一观测日期的完整 Sentinel-2 光谱与质量资产。"],
      nextActions: [{
        code: "collect_growth_stage_v1",
        label: "打开地块数据并开始采集",
        acquisitionRequest: {
          fieldId: field.id,
          boundaryVersion: field.boundaryVersion,
          dataProfile: "growth_stage_v1",
          period: { start: "2026-08-01T00:00:00.000Z", end: "2026-08-18T23:59:59.999Z" },
        },
      }],
    });
    expect(executionCount).toBe(0);
  });

  it("accepts only the four user-facing agronomic objectives", async () => {
    const app = buildApp();
    apps.push(app);
    const createdField = await app.inject({ method: "POST", url: "/api/v1/fields", payload: {
      name: "目标校验地块", crop: "corn", seasonYear: 2026,
      boundary: [{ longitude: 123.8, latitude: 42.3 }, { longitude: 123.81, latitude: 42.3 }, { longitude: 123.81, latitude: 42.31 }, { longitude: 123.8, latitude: 42.31 }],
    } });
    const fieldId = createdField.json().field.id as string;
    const response = await app.inject({ method: "POST", url: "/api/v1/tasks", payload: {
      fieldId, crop: "corn", period: "last_30_days", objective: "recent_change",
    } });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: "objective_not_supported" });
  });

  it("normalizes custom analysis dates and rejects a missing range", async () => {
    const app = buildApp();
    apps.push(app);
    const createdField = await app.inject({ method: "POST", url: "/api/v1/fields", payload: {
      name: "时间范围测试田", crop: "corn", seasonYear: 2026,
      boundary: [{ longitude: 123.8, latitude: 42.3 }, { longitude: 123.81, latitude: 42.3 }, { longitude: 123.81, latitude: 42.31 }, { longitude: 123.8, latitude: 42.31 }],
    } });
    const fieldId = createdField.json().field.id as string;
    const missing = await app.inject({ method: "POST", url: "/api/v1/tasks", payload: { fieldId, crop: "corn", period: "custom", objective: "growth_stage_monitoring" } });
    expect(missing.statusCode).toBe(422);
    expect(missing.json()).toMatchObject({ code: "invalid_analysis_period" });
    const valid = await app.inject({ method: "POST", url: "/api/v1/tasks", payload: {
      fieldId, crop: "corn", period: "custom", objective: "growth_stage_monitoring",
      timeRange: { start: "2026-06-01", end: "2026-06-30" },
    } });
    expect(valid.statusCode).toBe(202);
    expect(valid.json()).toMatchObject({ timeRange: { start: "2026-06-01T00:00:00.000Z", end: "2026-06-30T23:59:59.999Z" }, status: "needs_data" });
  });

  it("rejects historical date ranges for frost warnings", async () => {
    const app = buildApp();
    apps.push(app);
    const createdField = await app.inject({ method: "POST", url: "/api/v1/fields", payload: {
      name: "霜冻时间测试田", crop: "corn", seasonYear: 2026,
      boundary: [{ longitude: 123.8, latitude: 42.3 }, { longitude: 123.81, latitude: 42.3 }, { longitude: 123.81, latitude: 42.31 }, { longitude: 123.8, latitude: 42.31 }],
    } });
    const fieldId = createdField.json().field.id as string;
    const response = await app.inject({ method: "POST", url: "/api/v1/tasks", payload: {
      fieldId, crop: "corn", period: "custom", objective: "frost_risk_warning",
      timeRange: { start: "2026-06-26", end: "2026-06-26" },
    } });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: "invalid_analysis_period", message: "霜冻预警只使用最新未来预报窗口，不能绑定历史观测日期。" });
  });

  it("keeps the selected radar date while expanding the internal waterlogging evidence window", async () => {
    const acquisitionStore = createMemoryAcquisitionStore();
    const captured: { range: AnalysisTimeRange | null; runIds: string[] } = { range: null, runIds: [] };
    const multiSourceAnalysisService = {
      createWaterloggingTools(field: FieldSummary, runs: DataAcquisitionRun[], range: AnalysisTimeRange) {
        captured.range = range;
        captured.runIds = runs.map((run) => run.id).sort();
        return testTools(field.id, "analyze_radar_change", "analyze_weather_event", "analyze_terrain_susceptibility", "detect_waterlogging");
      },
    } as unknown as MultiSourceAnalysisService;
    const app = buildApp({ acquisitionService: new DataAcquisitionService(acquisitionStore, []), multiSourceAnalysisService });
    apps.push(app);
    const createdField = await app.inject({ method: "POST", url: "/api/v1/fields", payload: {
      name: "雷达日期窗口测试田", crop: "corn", seasonYear: 2026,
      boundary: [{ longitude: 123.8, latitude: 42.3 }, { longitude: 123.81, latitude: 42.3 }, { longitude: 123.81, latitude: 42.31 }, { longitude: 123.8, latitude: 42.31 }],
    } });
    const fieldId = createdField.json().field.id as string;
    await acquisitionStore.save(radarAcquisition(fieldId, "radar-before", "2026-08-04"));
    await acquisitionStore.save(radarAcquisition(fieldId, "radar-target", "2026-08-16"));

    const response = await app.inject({ method: "POST", url: "/api/v1/tasks", payload: {
      fieldId, crop: "corn", period: "custom", objective: "waterlogging_detection",
      timeRange: { start: "2026-08-16", end: "2026-08-16" },
    } });
    expect(response.statusCode).toBe(202);
    expect(response.json().timeRange).toEqual({ start: "2026-08-16T00:00:00.000Z", end: "2026-08-16T23:59:59.999Z" });
    expect(captured.range).toEqual({ start: "2026-07-23T00:00:00.000Z", end: "2026-08-16T23:59:59.999Z" });
    expect(captured.runIds).toEqual(["radar-before", "radar-target"]);
  });

  it("creates a source manifest with explicit partial acquisition state", async () => {
    const provider: AcquisitionProvider = {
      source: "sentinel-2",
      async discover(context) {
        const result: SourceAcquisitionResult = {
          sourceType: "optical", source: "sentinel-2", provider: "test", product: "test-product", status: "succeeded",
          requestedPeriod: context.period, discoveredAt: context.now.toISOString(), retrievedAt: null, availableDates: ["2026-08-05"], selectedObservationDates: ["2026-08-05"], selectedAssets: [],
          coverage: { requestedAreaHa: context.field.areaHa, coveredAreaFraction: 1 }, quality: { flags: ["catalog_only"], metadata: {} },
          license: { access: "public", downloadAllowed: false, attribution: "test" }, limitations: ["测试 provider 未下载资产。"], error: { code: null, retryable: false, message: null },
        };
        return result;
      },
    };
    const acquisitionService = new DataAcquisitionService(createMemoryAcquisitionStore(), [provider]);
    const app = buildApp({ acquisitionService });
    apps.push(app);
    const createdField = await app.inject({ method: "POST", url: "/api/v1/fields", payload: {
      name: "采集测试地块", crop: "corn", seasonYear: 2026,
      boundary: [{ longitude: 123.8, latitude: 42.3 }, { longitude: 123.81, latitude: 42.3 }, { longitude: 123.81, latitude: 42.31 }, { longitude: 123.8, latitude: 42.31 }],
    } });
    const field = createdField.json().field as { id: string; boundaryVersion: number };
    const response = await app.inject({ method: "POST", url: "/api/v1/acquisitions", payload: {
      fieldId: field.id, boundaryVersion: field.boundaryVersion, dataProfile: "field_baseline_v1", period: { start: "2026-08-01T00:00:00.000Z", end: "2026-08-10T00:00:00.000Z" },
    } });
    expect(response.statusCode).toBe(202);
    expect(response.json().run).toMatchObject({ fieldId: field.id, status: "running", dataProfile: "field_baseline_v1", sources: [] });
    const runId = response.json().run.id as string;
    let latest = await app.inject({ method: "GET", url: `/api/v1/fields/${field.id}/data` });
    for (let attempt = 0; latest.json().run.status === "running" && attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      latest = await app.inject({ method: "GET", url: `/api/v1/fields/${field.id}/data` });
    }
    expect(latest.statusCode).toBe(200);
    expect(latest.json().run.id).toBe(runId);
    expect(latest.json().run).toMatchObject({ status: "partial" });
    expect(latest.json().run.sources).toHaveLength(6);
    expect(latest.json().run.sources.find((source: SourceAcquisitionResult) => source.source === "sentinel-2")).toMatchObject({ status: "succeeded", availableDates: ["2026-08-05"] });
    expect(latest.json().run.sources.find((source: SourceAcquisitionResult) => source.source === "sentinel-1")).toMatchObject({ status: "failed", error: { code: "provider_unavailable" } });

    const matches = await app.inject({ method: "GET", url: `/api/v1/fields/${field.id}/data-match?date=2026-08-06` });
    expect(matches.statusCode).toBe(200);
    expect(matches.json().matches).toHaveLength(6);
    expect(matches.json().matches.find((match: { source: string }) => match.source === "sentinel-2")).toMatchObject({
      targetDate: "2026-08-06", matchedDate: "2026-08-05", offsetDays: -1, matchType: "nearest",
    });

    const invalidDate = await app.inject({ method: "GET", url: `/api/v1/fields/${field.id}/data-match?date=2026-13-40` });
    expect(invalidDate.statusCode).toBe(422);
    expect(invalidDate.json().code).toBe("invalid_target_date");
  });

  it.each([false, true])("runs the growth workflow with generated interpretation and reviewRequired=%s", async (reviewRequired) => {
    const acquisitionStore = createMemoryAcquisitionStore();
    const analysisResultStore = createMemoryAnalysisResultStore();
    const taskStore = createMemoryAnalysisTaskStore();
    const run = integrationAcquisition();
    await acquisitionStore.save(run);
    const runner = async (input: unknown): Promise<OpticalPythonResult> => {
      const date = (input as { sourceDate: string }).sourceDate;
      const mean = date === "2026-06-16" ? 0.61 : 0.72;
      return {
        status: "succeeded", sourceDate: date,
        quality: { flags: [], totalPixelCount: 100, validPixelCount: 100, validFraction: 1, cloudAffectedFraction: 0 },
        zoningMethod: "ndvi-quantile-connected-v2",
        zoningQuality: { robustRange: 0.28, minimumRobustRange: 0.05, variationVisible: true },
        metrics: {
          ndvi: { mean, min: 0.4, max: 0.88, validPixelCount: 100, totalPixelCount: 100, coverageFraction: 1 },
          ndre: { mean: mean - 0.2, min: 0.2, max: 0.6, validPixelCount: 100, totalPixelCount: 100, coverageFraction: 1 },
          reci: { mean: 2.1, min: 0.6, max: 3.2, validPixelCount: 100, totalPixelCount: 100, coverageFraction: 1 },
          msavi: { mean: mean - 0.04, min: 0.35, max: 0.82, validPixelCount: 100, totalPixelCount: 100, coverageFraction: 1 },
          ndmi: { mean: 0.31, min: -0.1, max: 0.55, validPixelCount: 100, totalPixelCount: 100, coverageFraction: 1 },
          ndwi: { mean: -0.58, min: -0.8, max: -0.3, validPixelCount: 100, totalPixelCount: 100, coverageFraction: 1 },
        },
        zones: [{ id: "zone-1", row: 0, column: 0, meanNdvi: mean - 0.1, deviation: -0.1, class: "below_average", validPixelCount: 40, zone: [[123.8, 42.3], [123.81, 42.3], [123.81, 42.31], [123.8, 42.31], [123.8, 42.3]] }],
        error: { code: null, message: null, retryable: false },
      };
    };
    const app = buildApp({
      acquisitionService: new DataAcquisitionService(acquisitionStore, []),
      analysisResultStore,
      growthAnalysisService: new GrowthAnalysisService(analysisResultStore, "python", runner),
      taskStore,
      analysisBriefWriter: {
        provider: "openai-codex",
        modelId: "gpt-test",
        promptVersion: "analysis-brief-writer-v1",
        async write({ brief, task, results }) {
          expect(task.fieldId).toBe(results[0]?.execution.scope.fieldId);
          expect(results.map((result) => result.kind)).toEqual(["optical_condition", "crop_stage", "assessment"]);
          expect(await taskStore.get(task.id)).toMatchObject({ status: "running", progress: 90, stage: "正在比较观测结果并撰写农情分析" });
          const investigation: AnalysisResult<unknown> = { ...results[0]!, id: `${task.id}-extra-weather`, kind: "weather_event", status: "needs_data",
            execution: { ...results[0]!.execution, toolName: "analyze_weather_event" }, result: null };
          await analysisResultStore.save(investigation);
          return { results: [...results, investigation], brief: {
            ...brief,
            overview: `专业分析：${brief.overview}`,
            reviewRequired,
            generation: {
              mode: "model_generated",
              generatedAt: "2026-08-26T00:00:00.000Z",
              provider: "openai-codex",
              modelId: "gpt-test",
              promptVersion: "analysis-brief-writer-v1",
              fallbackReason: null,
            },
          } };
        },
      },
    });
    apps.push(app);
    const fieldResponse = await app.inject({ method: "POST", url: "/api/v1/fields", payload: {
      name: "真实链路测试田", crop: "corn", seasonYear: 2026, plantingDate: "2026-05-04",
      boundary: [{ longitude: 123.8, latitude: 42.3 }, { longitude: 123.81, latitude: 42.3 }, { longitude: 123.81, latitude: 42.31 }, { longitude: 123.8, latitude: 42.31 }],
    } });
    const fieldId = fieldResponse.json().field.id as string;
    run.fieldId = fieldId;
    await acquisitionStore.save(run);
    const taskResponse = await app.inject({ method: "POST", url: "/api/v1/tasks", payload: { fieldId, crop: "corn", period: "this_season", objective: "growth_stage_monitoring" } });
    expect(taskResponse.statusCode).toBe(202);
    const taskId = taskResponse.json().id as string;
    let task = await app.inject({ method: "GET", url: `/api/v1/tasks/${taskId}` });
    for (let attempt = 0; task.json().status === "running" && attempt < 20; attempt += 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
      task = await app.inject({ method: "GET", url: `/api/v1/tasks/${taskId}` });
    }
    expect(task.json().status).toBe(reviewRequired ? "needs_review" : "partial");
    expect(task.json().summary).toBe(task.json().brief.overview);
    expect(task.json().findings.some((finding: { id: string }) => finding.id === "growth-status")).toBe(true);
    expect(task.json().findings.find((finding: { id: string }) => finding.id === "zone-1")).toMatchObject({
      findingType: "observation_zone",
      areaHa: expect.any(Number),
      sourceDates: ["2026-06-26"],
    });
    expect(task.json().brief.overview).toContain("同日相对偏弱分区");
    expect(task.json().brief.overview).toContain("覆盖地块 100.0%");
    expect(task.json().nextActions).toEqual([]);
    const analysis = await app.inject({ method: "GET", url: `/api/v1/tasks/${taskId}/analysis` });
    expect(analysis.json().results.map((result: { kind: string }) => result.kind)).toEqual(["optical_condition", "crop_stage", "assessment", "weather_event"]);
    expect(analysis.json().results[0]).toMatchObject({ result: { changes: [{ fromDate: "2026-06-16", toDate: "2026-06-26" }] } });
    expect(analysis.json().results[0].artifacts[0]).toMatchObject({ kind: "map" });
    expect(analysis.json().results[0].artifacts.filter((artifact: { kind: string }) => artifact.kind === "chart")).toHaveLength(6);
    const reopenedApp = buildApp({ taskStore });
    apps.push(reopenedApp);
    const persistedTask = await reopenedApp.inject({ method: "GET", url: `/api/v1/tasks/${taskId}` });
    expect(persistedTask.json()).toMatchObject({
      id: taskId,
      status: reviewRequired ? "needs_review" : "partial",
      completedAt: expect.any(String),
      timeRange: { start: "2026-05-04T00:00:00.000Z" },
      brief: {
        overview: expect.stringContaining("专业分析："),
        generation: { mode: "model_generated", modelId: "gpt-test", fallbackReason: null },
      },
    });
    expect(persistedTask.json().analysisResults.map((result: { kind: string }) => result.kind)).toContain("weather_event");
    await rm(resolve(import.meta.dirname, "../../../runtime/artifacts", `analysis/${taskId}`), { recursive: true, force: true });
  });

  it("keeps the deterministic assessment as the task summary when the Agent final text differs", async () => {
    const acquisitionStore = createMemoryAcquisitionStore();
    const taskStore = createMemoryAnalysisTaskStore();
    const app = buildApp({
      acquisitionService: new DataAcquisitionService(acquisitionStore, []),
      taskStore,
      analysisTaskExecutor: {
        async run(request) {
          return {
            runId: "agent-run-test",
            finalMessage: "模型自由文本错误地声称需要立即施肥。",
            results: [{
              id: "assessment-authoritative",
              taskId: request.taskId,
              kind: "assessment",
              status: "partial",
              toolVersion: "test",
              createdAt: "2026-08-19T00:00:00.000Z",
              execution: testExecution("assess_growth_status", request.scope.fieldIds[0]),
              summary: "当前只有单期光学观测，已定位田内相对低值区，尚不能判断变化趋势。",
              result: {},
              sources: [],
              findings: [],
              artifacts: [],
              limitations: ["缺少第二个可用观测日期。"],
              nextActions: [{ code: "collect_recent_optical_data", label: "等待下一期可用光学观测" }],
              error: null,
            }],
          };
        },
      },
    });
    apps.push(app);
    const fieldResponse = await app.inject({ method: "POST", url: "/api/v1/fields", payload: {
      name: "发布边界测试田", crop: "corn", seasonYear: 2026, plantingDate: "2026-05-04",
      boundary: [{ longitude: 123.8, latitude: 42.3 }, { longitude: 123.81, latitude: 42.3 }, { longitude: 123.81, latitude: 42.31 }, { longitude: 123.8, latitude: 42.31 }],
    } });
    const fieldId = fieldResponse.json().field.id as string;
    const run = integrationAcquisition();
    run.fieldId = fieldId;
    await acquisitionStore.save(run);

    const created = await app.inject({ method: "POST", url: "/api/v1/tasks", payload: {
      fieldId, crop: "corn", period: "this_season", objective: "growth_stage_monitoring",
    } });
    const taskId = created.json().id as string;
    let task = await app.inject({ method: "GET", url: `/api/v1/tasks/${taskId}` });
    for (let attempt = 0; task.json().status === "running" && attempt < 20; attempt += 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
      task = await app.inject({ method: "GET", url: `/api/v1/tasks/${taskId}` });
    }

    expect(task.json()).toMatchObject({
      status: "partial",
      summary: "当前只有单期光学观测，已定位田内相对低值区，尚不能判断变化趋势。",
    });
  });

  it("does not auto-include historical task inspections and only uses explicitly selected field notes", async () => {
    const acquisitionStore = createMemoryAcquisitionStore();
    const taskStore = createMemoryAnalysisTaskStore();
    const captured: { inspections: unknown[] } = { inspections: [] };
    const growthAnalysisService = {
      createTools(field: FieldSummary) {
        return [{ name: "analyze_optical_condition", execute: async ({ taskId }: { taskId: string }) => ({
          id: "optical-context-test", taskId, kind: "optical_condition", status: "succeeded", toolVersion: "test", createdAt: "2026-08-18T00:00:00.000Z",
          execution: testExecution("analyze_optical_condition", field.id),
          summary: "测试光学观测。", result: { current: { observationDate: "2026-06-26", metrics: {} }, observations: [], changes: [], zones: [] },
          sources: [{ source: "sentinel-2", date: "2026-06-26", quality: "usable", note: "test" }], findings: [], artifacts: [], limitations: [], nextActions: [], error: null,
        }) }, ...testTools(field.id, "estimate_crop_stage", "assess_growth_status")];
      },
    } as unknown as GrowthAnalysisService;
    const multiSourceAnalysisService = {
      createWaterNitrogenTools(field: FieldSummary, _runs: DataAcquisitionRun[], _range: AnalysisTimeRange, inspections: unknown[]) {
        captured.inspections = inspections;
        return [...testTools(field.id, "analyze_radar_change", "analyze_weather_event", "analyze_terrain_susceptibility", "get_soil_background"), { name: "assess_water_nitrogen_evidence", execute: async ({ taskId }: { taskId: string }) => ({
          id: "assessment-context-test", taskId, kind: "assessment", status: "succeeded", toolVersion: "test", createdAt: "2026-08-18T00:01:00.000Z",
          execution: testExecution("assess_water_nitrogen_evidence", field.id),
          summary: "测试田况。", result: { assessment: "uniform", referenceDate: "2026-06-26", observationAgeDays: 1, observationStatus: "current", observation: { ndvi: null, ndre: null, reci: null, msavi: null, ndmi: null, ndwi: null, variationStatus: "uniform" }, previousInspections: inspections, methodVersion: "water-nitrogen-v5", evidenceLevel: "optical_only", zones: [], sourceAlignment: [], fieldComparison: { status: "absent", lowValueRecords: [], referenceRecords: [], generalRecords: [], pairs: [] } },
          sources: [{ source: "sentinel-2", date: "2026-06-26", quality: "usable", note: "test" }], findings: [], artifacts: [], limitations: [], nextActions: [], error: null,
        }) }];
      },
    } as unknown as MultiSourceAnalysisService;
    const app = buildApp({
      acquisitionService: new DataAcquisitionService(acquisitionStore, []),
      growthAnalysisService,
      multiSourceAnalysisService,
      taskStore,
    });
    apps.push(app);
    const fieldResponse = await app.inject({ method: "POST", url: "/api/v1/fields", payload: {
      name: "巡查回流测试田", crop: "corn", seasonYear: 2026, plantingDate: "2026-05-04",
      boundary: [{ longitude: 123.8, latitude: 42.3 }, { longitude: 123.81, latitude: 42.3 }, { longitude: 123.81, latitude: 42.31 }, { longitude: 123.8, latitude: 42.31 }],
    } });
    const fieldId = fieldResponse.json().field.id as string;
    const acquisition = integrationAcquisition();
    acquisition.fieldId = fieldId;
    await acquisitionStore.save(acquisition);
    const previousTask = taskWithInspectionFindings();
    previousTask.fieldId = fieldId;
    previousTask.inspections = [{ id: "inspection-1", taskId: previousTask.id, findingId: "zone-1", scoutingRole: "general", status: "checked", checkedAt: "2026-08-17T08:00:00.000Z", observedAt: "2026-08-16", location: { longitude: 123.805, latitude: 42.305 }, waterCondition: "wet", leafColor: "pale", diseaseOrPest: "none_seen", note: "西南角偏湿，叶色偏浅。" }];
    await taskStore.save(previousTask);

    const response = await app.inject({ method: "POST", url: "/api/v1/tasks", payload: { fieldId, crop: "corn", period: "this_season", objective: "water_nitrogen_diagnosis" } });

    expect(response.statusCode).toBe(202);
    expect(captured.inspections).toEqual([]);

    const createdNote = await app.inject({ method: "POST", url: `/api/v1/fields/${fieldId}/scouting-notes`, payload: {
      observedAt: "2026-08-16", location: { longitude: 123.805, latitude: 42.305 }, waterCondition: "wet", leafColor: "pale", diseaseOrPest: "none_seen", note: "西南角偏湿，叶色偏浅。",
    } });
    expect(createdNote.statusCode).toBe(201);
    const noteId = createdNote.json().note.id as string;
    const listedNotes = await app.inject({ method: "GET", url: `/api/v1/fields/${fieldId}/scouting-notes` });
    expect(listedNotes.json().notes).toEqual([expect.objectContaining({ id: noteId, fieldId, observedAt: "2026-08-16", waterCondition: "wet" })]);

    const followUp = await app.inject({ method: "POST", url: "/api/v1/tasks", payload: { fieldId, crop: "corn", period: "this_season", objective: "water_nitrogen_diagnosis", scoutingNoteIds: [noteId] } });
    expect(followUp.statusCode).toBe(202);
    expect(captured.inspections).toEqual([expect.objectContaining({ taskId: "field-scouting-note", findingId: noteId, findingTitle: "巡田记录", waterCondition: "wet", leafColor: "pale", note: "西南角偏湿，叶色偏浅。" })]);
  });

  it("keeps the follow-up water-nitrogen pass focused on optical and field observations", async () => {
    const acquisitionStore = createMemoryAcquisitionStore();
    const analysisResultStore = createMemoryAnalysisResultStore();
    const taskStore = createMemoryAnalysisTaskStore();
    const opticalResult = (taskId: string) => ({
      id: "optical-follow-up", taskId, kind: "optical_condition" as const, status: "succeeded" as const, toolVersion: "test", createdAt: "2026-06-30T00:00:00.000Z", execution: testExecution("analyze_optical_condition"),
      summary: "测试光学观测。", result: { current: { observationDate: "2026-06-26", metrics: { ndvi: { mean: 0.62 }, ndre: { mean: 0.2 }, reci: { mean: 1.5 }, msavi: { mean: 0.5 }, ndmi: { mean: 0.1 }, ndwi: { mean: -0.3 } }, quality: { validPixelCount: 100 } }, observations: [], changes: [], zones: [{ id: "zone-follow-up", class: "below_average", meanNdvi: 0.5, deviation: -0.12, validPixelCount: 20, metricDeviations: { ndre: -0.08, reci: -0.08, msavi: -0.03, ndmi: -0.06, ndwi: -0.04 }, zone: [[123.8, 42.3], [123.81, 42.3], [123.81, 42.31], [123.8, 42.31], [123.8, 42.3]] }] },
      sources: [{ source: "sentinel-2", date: "2026-06-26", quality: "usable" as const, note: "test" }], findings: [], artifacts: [], limitations: [], nextActions: [], error: null,
    });
    const growthAnalysisService = {
      createTools() {
        return [
          { name: "analyze_optical_condition", execute: async ({ taskId }: { taskId: string }) => {
            const result = opticalResult(taskId);
            await analysisResultStore.save(result);
            return result;
          } },
          { name: "estimate_crop_stage", execute: async ({ taskId }: { taskId: string }) => {
            const result = {
              id: "stage-follow-up", taskId, kind: "crop_stage" as const, status: "succeeded" as const, toolVersion: "test", createdAt: "2026-06-30T00:00:00.000Z", execution: testExecution("estimate_crop_stage"),
              summary: "吐丝期。", result: { stage: "silking", label: "吐丝期", referenceDate: "2026-06-26", daysAfterPlanting: 53, confidence: "medium" as const },
              sources: [{ source: "field_record", date: "2026-05-04", quality: "usable" as const, note: "播种日期。" }], findings: [], artifacts: [], limitations: [], nextActions: [], error: null,
            };
            await analysisResultStore.save(result);
            return result;
          } },
        ];
      },
    } as unknown as GrowthAnalysisService;
    const runners: MultiSourceRunners = {
      async radar() { return { status: "needs_data", quality: { totalPixelCount: 0, validPixelCount: 0, validFraction: 0 }, metrics: null, zones: [], error: { code: "test_missing_path", message: "test", retryable: true } }; },
      async weather() { return { status: "needs_data", historical: null, forecast: null, error: { code: "test_missing_path", message: "test", retryable: true } }; },
      async terrain() { return { status: "needs_data", metrics: null, zones: [], error: { code: "test_missing_path", message: "test", retryable: true } }; },
      async soil() { return { status: "needs_data", measurements: [], error: { code: "test_missing_path", message: "test", retryable: true } }; },
    };
    const multiSourceAnalysisService = new MultiSourceAnalysisService(analysisResultStore, "python", runners);
    const app = buildApp({ acquisitionService: new DataAcquisitionService(acquisitionStore, []), analysisResultStore, growthAnalysisService, multiSourceAnalysisService, taskStore });
    apps.push(app);
    const fieldResponse = await app.inject({ method: "POST", url: "/api/v1/fields", payload: {
      name: "水氮复核链路测试田", crop: "corn", seasonYear: 2026, plantingDate: "2026-05-04",
      boundary: [{ longitude: 123.8, latitude: 42.3 }, { longitude: 123.81, latitude: 42.3 }, { longitude: 123.81, latitude: 42.31 }, { longitude: 123.8, latitude: 42.31 }],
    } });
    const fieldId = fieldResponse.json().field.id as string;
    const run = integrationAcquisition();
    run.fieldId = fieldId;
    run.dataProfile = "water_nitrogen_v1";
    run.sources.push({ sourceType: "radar", source: "sentinel-1", provider: "test", product: "test", status: "succeeded", requestedPeriod: null, discoveredAt: "2026-06-30T00:00:00.000Z", retrievedAt: "2026-06-30T01:00:00.000Z", availableDates: ["2026-06-16", "2026-06-26"], selectedObservationDates: ["2026-06-16", "2026-06-26"], selectedAssets: [
      { id: "radar-before", providerAssetId: "radar-before", role: "radar", capturedAt: "2026-06-16T03:00:00.000Z", validFrom: null, validTo: null, generatedAt: null, retrievedAt: "2026-06-30T01:00:00.000Z", spatialResolutionMeters: 10, crs: "EPSG:4326", format: "GeoTIFF", byteSize: 10, checksum: "sha256:test", artifactRef: "missing/radar-before.tif", accessStatus: "retrieved" },
      { id: "radar-after", providerAssetId: "radar-after", role: "radar", capturedAt: "2026-06-26T03:00:00.000Z", validFrom: null, validTo: null, generatedAt: null, retrievedAt: "2026-06-30T01:00:00.000Z", spatialResolutionMeters: 10, crs: "EPSG:4326", format: "GeoTIFF", byteSize: 10, checksum: "sha256:test", artifactRef: "missing/radar-after.tif", accessStatus: "retrieved" },
    ], coverage: { requestedAreaHa: 10, coveredAreaFraction: 1 }, quality: { flags: [], metadata: { orbitDirection: "descending", relativeOrbitNumber: 3 } }, license: { access: "public", downloadAllowed: true, attribution: "test" }, limitations: [], error: { code: null, retryable: false, message: null } });
    run.sources.push({ sourceType: "weather-historical", source: "era5-land", provider: "test", product: "test", status: "succeeded", requestedPeriod: null, discoveredAt: "2026-06-30T00:00:00.000Z", retrievedAt: "2026-06-30T01:00:00.000Z", availableDates: [], selectedObservationDates: [], selectedAssets: [{ id: "weather", providerAssetId: "weather", role: "weather-series", capturedAt: null, validFrom: "2026-06-01T00:00:00.000Z", validTo: "2026-06-30T23:00:00.000Z", generatedAt: null, retrievedAt: "2026-06-30T01:00:00.000Z", spatialResolutionMeters: 9000, crs: "EPSG:4326", format: "NetCDF", byteSize: 10, checksum: "sha256:test", artifactRef: "missing/weather.nc", accessStatus: "retrieved" }], coverage: { requestedAreaHa: 10, coveredAreaFraction: 1 }, quality: { flags: [], metadata: {} }, license: { access: "public", downloadAllowed: true, attribution: "test" }, limitations: [], error: { code: null, retryable: false, message: null } });
    await acquisitionStore.save(run);
    const previousTask = taskWithInspectionFindings();
    previousTask.fieldId = fieldId;
    previousTask.findings = [{ ...previousTask.findings.find((finding) => finding.id === "field-observation")!, sourceDates: ["2026-06-26"] }];
    previousTask.inspections = [{ id: "follow-up-inspection", taskId: previousTask.id, findingId: "field-observation", scoutingRole: "general", status: "checked", checkedAt: "2026-06-27T08:00:00.000Z", observedAt: "2026-06-26", location: { longitude: 123.805, latitude: 42.305 }, waterCondition: "wet", leafColor: "pale", diseaseOrPest: "none_seen", note: "西南角偏湿，叶色偏浅。" }];
    await taskStore.save(previousTask);

    const response = await app.inject({ method: "POST", url: "/api/v1/tasks", payload: { fieldId, crop: "corn", period: "this_season", objective: "water_nitrogen_diagnosis" } });
    expect(response.statusCode).toBe(202);
    const taskId = response.json().id as string;
    let task = await app.inject({ method: "GET", url: `/api/v1/tasks/${taskId}` });
    for (let attempt = 0; task.json().status === "running" && attempt < 20; attempt += 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
      task = await app.inject({ method: "GET", url: `/api/v1/tasks/${taskId}` });
    }
    expect(task.json().status).toBe("partial");
    expect(task.json().findings).toEqual(expect.arrayContaining([expect.objectContaining({
      id: "water-nitrogen-zone-follow-up",
      title: "田内相对低值区 1",
      findingType: "observation_zone",
      scoutingRole: "low_value",
      zone: expect.any(Array),
    }), expect.objectContaining({ findingType: "field_observation", scoutingRole: "low_value" }), expect.objectContaining({ findingType: "field_observation", scoutingRole: "reference" })]));
    const analysis = await app.inject({ method: "GET", url: `/api/v1/tasks/${taskId}/analysis` });
    expect(analysis.json().results.map((result: { kind: string }) => result.kind)).toEqual(["optical_condition", "crop_stage", "radar_change", "weather_event", "terrain_susceptibility", "soil_background", "assessment"]);
  });

  it("saves field inspections idempotently and rejects invalid inspection input", async () => {
    const taskStore = createMemoryAnalysisTaskStore();
    const fieldStore = createMemoryFieldStore();
    const app = buildApp({ taskStore, fieldStore });
    apps.push(app);
    const task = taskWithInspectionFindings();
    const field = await fieldStore.create({ name: "现场核查测试田", crop: "corn", seasonYear: 2026, plantingDate: "2026-05-04", variety: null, boundary: [{ longitude: 123.8, latitude: 42.3 }, { longitude: 123.81, latitude: 42.3 }, { longitude: 123.81, latitude: 42.31 }, { longitude: 123.8, latitude: 42.31 }, { longitude: 123.8, latitude: 42.3 }] });
    task.fieldId = field.id;
    await taskStore.save(task);

    const first = await app.inject({ method: "PUT", url: `/api/v1/tasks/${task.id}/findings/zone-1/inspection`, payload: {
      observedAt: "2026-08-18", location: { longitude: 123.805, latitude: 42.305 },
      waterCondition: "wet", leafColor: "pale", diseaseOrPest: "none_seen", note: "西南角叶色偏浅，土壤表面偏湿。",
    } });
    expect(first.statusCode).toBe(200);
    expect(first.json().inspection).toMatchObject({ taskId: task.id, findingId: "zone-1", status: "checked", waterCondition: "wet", note: "西南角叶色偏浅，土壤表面偏湿。" });

    const firstId = first.json().inspection.id as string;
    const repeat = await app.inject({ method: "PUT", url: `/api/v1/tasks/${task.id}/findings/zone-1/inspection`, payload: {
      observedAt: "2026-08-19", location: { longitude: 123.806, latitude: 42.306 },
      waterCondition: "normal", leafColor: "normal", diseaseOrPest: "suspected", note: "复核后记录。",
    } });
    expect(repeat.statusCode).toBe(200);
    expect(repeat.json().inspection).toMatchObject({ id: firstId, waterCondition: "normal", note: "复核后记录。" });
    const persisted = await app.inject({ method: "GET", url: `/api/v1/tasks/${task.id}` });
    expect(persisted.json().inspections).toHaveLength(1);
    expect(persisted.json().inspections[0]).toMatchObject({ id: firstId, findingId: "zone-1", diseaseOrPest: "suspected" });

    const nonSpatial = await app.inject({ method: "PUT", url: `/api/v1/tasks/${task.id}/findings/summary/inspection`, payload: {
      waterCondition: "normal", leafColor: "normal", diseaseOrPest: "unknown", note: "",
    } });
    expect(nonSpatial.statusCode).toBe(422);
    expect(nonSpatial.json()).toMatchObject({ code: "finding_not_spatial" });

    const fieldObservation = await app.inject({ method: "PUT", url: `/api/v1/tasks/${task.id}/findings/field-observation/inspection`, payload: {
      observedAt: "2026-08-19", location: { longitude: 123.805, latitude: 42.305 },
      waterCondition: "normal", leafColor: "normal", diseaseOrPest: "none_seen", note: "地块级现场记录。",
    } });
    expect(fieldObservation.statusCode).toBe(200);
    expect(fieldObservation.json().inspection).toMatchObject({ findingId: "field-observation", note: "地块级现场记录。" });

    const invalidEnum = await app.inject({ method: "PUT", url: `/api/v1/tasks/${task.id}/findings/zone-1/inspection`, payload: {
      waterCondition: "very_wet", leafColor: "normal", diseaseOrPest: "unknown", note: "",
    } });
    expect(invalidEnum.statusCode).toBe(422);
    expect(invalidEnum.json()).toMatchObject({ code: "invalid_inspection" });

    const tooLong = await app.inject({ method: "PUT", url: `/api/v1/tasks/${task.id}/findings/zone-1/inspection`, payload: {
      waterCondition: "normal", leafColor: "normal", diseaseOrPest: "unknown", note: "x".repeat(501),
    } });
    expect(tooLong.statusCode).toBe(422);
    expect(tooLong.json()).toMatchObject({ code: "invalid_inspection" });
  });

  it("validates low-value and reference scouting locations against the optical observation", async () => {
    const taskStore = createMemoryAnalysisTaskStore();
    const fieldStore = createMemoryFieldStore();
    const app = buildApp({ taskStore, fieldStore });
    apps.push(app);
    const field = await fieldStore.create({ name: "巡田选点测试田", crop: "corn", seasonYear: 2026, plantingDate: "2026-05-04", variety: null, boundary: [
      { longitude: 123.8, latitude: 42.3 }, { longitude: 123.82, latitude: 42.3 }, { longitude: 123.82, latitude: 42.31 }, { longitude: 123.8, latitude: 42.31 }, { longitude: 123.8, latitude: 42.3 },
    ] });
    const task = taskWithInspectionFindings();
    task.fieldId = field.id;
    task.findings = [
      { id: "low", title: "低值区巡田点", summary: "低值点。", severity: "watch", findingType: "field_observation", scoutingRole: "low_value", areaHa: null, sourceDates: ["2026-06-20"], zone: null },
      { id: "reference", title: "正常区对照点", summary: "对照点。", severity: "normal", findingType: "field_observation", scoutingRole: "reference", areaHa: null, sourceDates: ["2026-06-20"], zone: null },
    ];
    task.analysisResults = [{
      id: "optical-result", taskId: task.id, kind: "optical_condition", status: "succeeded", toolVersion: "test", createdAt: "2026-06-20T03:00:00Z", execution: testExecution("analyze_optical_condition", task.fieldId), summary: "测试光学结果。",
      result: { zones: [
        { class: "below_average", zone: [[123.8, 42.3], [123.81, 42.3], [123.81, 42.31], [123.8, 42.31], [123.8, 42.3]] },
        { class: "near_average", zone: [[123.81, 42.3], [123.82, 42.3], [123.82, 42.31], [123.81, 42.31], [123.81, 42.3]] },
      ] },
      sources: [{ source: "sentinel-2", date: "2026-06-20", quality: "usable", note: "test" }], findings: [], artifacts: [], limitations: [], nextActions: [], error: null,
    }];
    await taskStore.save(task);
    const payload = { observedAt: "2026-06-20", waterCondition: "normal", leafColor: "normal", diseaseOrPest: "none_seen", note: "测试记录。" };

    const wrongLow = await app.inject({ method: "PUT", url: `/api/v1/tasks/${task.id}/findings/low/inspection`, payload: { ...payload, location: { longitude: 123.815, latitude: 42.305 } } });
    expect(wrongLow.statusCode).toBe(422);
    expect(wrongLow.json()).toMatchObject({ code: "inspection_role_mismatch" });
    const low = await app.inject({ method: "PUT", url: `/api/v1/tasks/${task.id}/findings/low/inspection`, payload: { ...payload, location: { longitude: 123.805, latitude: 42.305 } } });
    expect(low.statusCode).toBe(200);
    expect(low.json().inspection).toMatchObject({ scoutingRole: "low_value" });

    const wrongReference = await app.inject({ method: "PUT", url: `/api/v1/tasks/${task.id}/findings/reference/inspection`, payload: { ...payload, location: { longitude: 123.805, latitude: 42.305 } } });
    expect(wrongReference.statusCode).toBe(422);
    expect(wrongReference.json()).toMatchObject({ code: "inspection_role_mismatch" });
    const reference = await app.inject({ method: "PUT", url: `/api/v1/tasks/${task.id}/findings/reference/inspection`, payload: { ...payload, location: { longitude: 123.815, latitude: 42.305 } } });
    expect(reference.statusCode).toBe(200);
    expect(reference.json().inspection).toMatchObject({ scoutingRole: "reference" });
  });

  it("carries a task's paired inspections into an explicit follow-up task", async () => {
    const taskStore = createMemoryAnalysisTaskStore();
    const fieldStore = createMemoryFieldStore();
    const app = buildApp({ taskStore, fieldStore });
    apps.push(app);
    const field = await fieldStore.create({ name: "巡田回流测试田", crop: "corn", seasonYear: 2026, plantingDate: "2026-05-04", variety: null, boundary: [
      { longitude: 123.8, latitude: 42.3 }, { longitude: 123.82, latitude: 42.3 }, { longitude: 123.82, latitude: 42.31 }, { longitude: 123.8, latitude: 42.31 }, { longitude: 123.8, latitude: 42.3 },
    ] });
    const sourceTask = taskWithInspectionFindings();
    sourceTask.fieldId = field.id;
    sourceTask.findings = [
      { id: "water-nitrogen-low-check", title: "低值区", summary: "低值点。", severity: "watch", findingType: "field_observation", scoutingRole: "low_value", areaHa: null, sourceDates: ["2026-08-16"], zone: null },
      { id: "water-nitrogen-reference-check", title: "正常区对照", summary: "对照点。", severity: "normal", findingType: "field_observation", scoutingRole: "reference", areaHa: null, sourceDates: ["2026-08-16"], zone: null },
    ];
    sourceTask.inspections = [
      { id: "low-inspection", taskId: sourceTask.id, findingId: "water-nitrogen-low-check", scoutingRole: "low_value", status: "checked", checkedAt: "2026-08-16T08:00:00Z", observedAt: "2026-08-16", location: { longitude: 123.805, latitude: 42.305 }, waterCondition: "dry", leafColor: "pale", diseaseOrPest: "none_seen", note: "低值区偏干。" },
      { id: "reference-inspection", taskId: sourceTask.id, findingId: "water-nitrogen-reference-check", scoutingRole: "reference", status: "checked", checkedAt: "2026-08-16T08:10:00Z", observedAt: "2026-08-16", location: { longitude: 123.815, latitude: 42.305 }, waterCondition: "normal", leafColor: "normal", diseaseOrPest: "none_seen", note: "正常区对照。" },
    ];
    await taskStore.save(sourceTask);

    const response = await app.inject({ method: "POST", url: "/api/v1/tasks", payload: { fieldId: field.id, crop: "corn", period: "custom", timeRange: sourceTask.timeRange, objective: "water_nitrogen_diagnosis", inspectionTaskId: sourceTask.id } });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ status: "needs_data", inspections: [
      { id: "low-inspection", scoutingRole: "low_value" },
      { id: "reference-inspection", scoutingRole: "reference" },
    ] });
    expect(response.json().inspections.every((inspection: { taskId: string }) => inspection.taskId === response.json().id)).toBe(true);
  });
});

function testTools(fieldId: string, ...names: ControlledToolName[]): ControlledAnalysisTool[] {
  return names.map((name) => ({
    name,
    async execute({ taskId }) {
      const kind: AnalysisResult<unknown>["kind"] = name === "analyze_optical_condition" ? "optical_condition"
        : name === "estimate_crop_stage" ? "crop_stage"
          : name === "analyze_radar_change" ? "radar_change"
            : name === "analyze_weather_event" ? "weather_event"
              : name === "analyze_terrain_susceptibility" ? "terrain_susceptibility"
                : name === "get_soil_background" ? "soil_background" : "assessment";
      return { id: `${name}-test`, taskId, kind, status: "needs_data", toolVersion: "test", createdAt: "2026-08-19T00:00:00.000Z", execution: testExecution(name, fieldId), summary: "测试占位结果。", result: null, sources: [], findings: [], artifacts: [], limitations: [], nextActions: [], error: { code: "test_data_missing", message: "测试数据缺失。", retryable: false } };
    },
  }));
}

function integrationAcquisition(): DataAcquisitionRun {
  const asset = (date: string, token: string, role: "spectral" | "quality-mask") => ({
    id: `${date}:${token}`, providerAssetId: `scene:${date}:${token}`, role, capturedAt: `${date}T02:00:00.000Z`, validFrom: null, validTo: null,
    generatedAt: null, retrievedAt: "2026-06-30T01:00:00.000Z", spatialResolutionMeters: 20, crs: "EPSG:4326", format: "GeoTIFF", byteSize: 10,
    checksum: "sha256:test", artifactRef: `test/${date}-${token}.tif`, accessStatus: "retrieved" as const,
  });
  const assets = ["2026-06-16", "2026-06-26"].flatMap((date) => [
    asset(date, "B02+B03+B04+B08", "spectral"), asset(date, "B05+B06+B07+B8A+B11+B12", "spectral"), asset(date, "SCL", "quality-mask"),
  ]);
  return {
    id: "integration-acquisition", fieldId: "pending", boundaryVersion: 1, period: { start: "2026-06-01T00:00:00.000Z", end: "2026-06-30T23:59:59.000Z" },
    dataProfile: "growth_stage_v1", dataProfileVersion: "test", status: "completed", createdAt: "2026-06-30T00:00:00.000Z", completedAt: "2026-06-30T01:00:00.000Z", manifestVersion: "1.2", progress: [],
    sources: [{ sourceType: "optical", source: "sentinel-2", provider: "test", product: "test", status: "succeeded", requestedPeriod: null, discoveredAt: "2026-06-30T00:00:00.000Z", retrievedAt: "2026-06-30T01:00:00.000Z", availableDates: ["2026-06-16", "2026-06-26"], selectedObservationDates: ["2026-06-16", "2026-06-26"], selectedAssets: assets,
      coverage: { requestedAreaHa: 10, coveredAreaFraction: 1 }, quality: { flags: [], metadata: {} }, license: { access: "public", downloadAllowed: true, attribution: "test" }, limitations: [], error: { code: null, retryable: false, message: null } }],
  };
}

function radarAcquisition(fieldId: string, id: string, date: string): DataAcquisitionRun {
  return {
    id, fieldId, boundaryVersion: 1, period: { start: `${date}T00:00:00.000Z`, end: `${date}T23:59:59.999Z` },
    dataProfile: "waterlogging_v1", dataProfileVersion: "test", status: "completed", createdAt: `${date}T12:00:00.000Z`, completedAt: `${date}T12:01:00.000Z`, manifestVersion: "1.2", progress: [],
    sources: [{
      sourceType: "radar", source: "sentinel-1", provider: "test", product: "test", status: "succeeded", requestedPeriod: null,
      discoveredAt: `${date}T12:00:00.000Z`, retrievedAt: `${date}T12:01:00.000Z`, availableDates: [date], selectedObservationDates: [date],
      selectedAssets: [{ id: `${id}-asset`, providerAssetId: `${id}-asset`, role: "radar", capturedAt: `${date}T03:00:00.000Z`, validFrom: null, validTo: null, generatedAt: null, retrievedAt: `${date}T12:01:00.000Z`, spatialResolutionMeters: 10, crs: "EPSG:4326", format: "GeoTIFF", byteSize: 10, checksum: "sha256:test", artifactRef: `test/${id}.tif`, accessStatus: "retrieved" }],
      coverage: { requestedAreaHa: 10, coveredAreaFraction: 1 }, quality: { flags: [], metadata: { orbitDirection: "descending", relativeOrbitNumber: 3 } },
      license: { access: "public", downloadAllowed: true, attribution: "test" }, limitations: [], error: { code: null, retryable: false, message: null },
    }],
  };
}

function taskWithLayer(fieldId: string, id: string, createdAt: string, ref: string): AnalysisTask {
  return {
    id, fieldId, objective: "growth_stage_monitoring", timeRange: { start: "2026-08-01T00:00:00.000Z", end: "2026-08-18T23:59:59.000Z" },
    status: "completed", progress: 100, stage: "关键生育期长势监测已完成", createdAt, completedAt: createdAt, demoData: false,
    summary: "测试图层目录。", brief: null, findings: [], sources: [], limitations: [], nextActions: [], failure: null,
    analysisResults: [{
      id: `${id.slice(0, -1)}3`, taskId: id, kind: "optical_condition", status: "succeeded", toolVersion: "test", createdAt, execution: testExecution("analyze_optical_condition", fieldId),
      summary: "测试图层。", result: {}, sources: [{ source: "era5-land", date: "2026-08-15", quality: "usable", note: "测试天气。" }], findings: [], limitations: [], nextActions: [], error: null,
      artifacts: [{ ref, kind: "map", visualization: {
        type: "raster", source: "sentinel-2", metric: "ndvi", date: "2026-08-16",
        bounds: [[123.8, 42.31], [123.81, 42.31], [123.81, 42.3], [123.8, 42.3]],
        min: 0.1, max: 0.8, resolutionMeters: 10, unit: "index", label: "NDVI 长势",
      } }, { ref: `analysis/${id}/weather-rainfall`, kind: "chart", chart: {
        source: "era5-land", title: "历史降雨", unit: "mm", series: [{ label: "降雨", points: [{ label: "累计", value: 12 }] }],
      } }],
    }],
  };
}

function testExecution(toolName: ControlledToolName, fieldId = "field-1") {
  return { toolName, scope: { fieldId, boundaryVersion: 1, timeRange: null }, inputs: { acquisitionIds: [], assetIds: [], resultIds: [] }, parameters: {}, inputFingerprint: "test" };
}

function taskWithInspectionFindings(): AnalysisTask {
  return {
    id: "33333333-3333-4333-8333-333333333333", fieldId: "field-inspection-test", objective: "water_nitrogen_diagnosis",
    timeRange: { start: "2026-08-01T00:00:00.000Z", end: "2026-08-18T23:59:59.000Z" }, status: "partial", progress: 100,
    stage: "水氮协同诊断已完成", createdAt: "2026-08-18T00:00:00.000Z", completedAt: "2026-08-18T00:01:00.000Z", demoData: false,
    summary: "测试现场核查。", brief: null, findings: [
      { id: "zone-1", title: "相对低值区", summary: "测试空间区域。", severity: "watch", findingType: "observation_zone", areaHa: 0.8, sourceDates: ["2026-08-16"], zone: [
        { longitude: 123.8, latitude: 42.3 }, { longitude: 123.81, latitude: 42.3 }, { longitude: 123.81, latitude: 42.31 }, { longitude: 123.8, latitude: 42.31 }, { longitude: 123.8, latitude: 42.3 },
      ] },
      { id: "summary", title: "水氮协同诊断", summary: "测试摘要。", severity: "watch", findingType: "other", areaHa: null, sourceDates: ["2026-08-16"], zone: null },
      { id: "field-observation", title: "田况观测", summary: "测试地块观测。", severity: "normal", findingType: "field_observation", areaHa: null, sourceDates: ["2026-08-16"], zone: null },
    ], sources: [], analysisResults: [], limitations: [], nextActions: [], failure: null,
  };
}
