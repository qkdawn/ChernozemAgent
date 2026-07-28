import type { AnalysisTask, CreateAnalysisTaskRequest, FieldInput, FieldUpdateInput } from "@chernozem/contracts";
import cors from "@fastify/cors";
import Fastify from "fastify";
import { randomUUID } from "node:crypto";

import { createMemoryFieldStore, FieldGeometryError, type FieldStore } from "./field-store.js";
import { createPlanetClient, type PlanetClient } from "./planet-client.js";

interface StoredTask extends AnalysisTask {
  readyAt: number;
}

const tasks = new Map<string, StoredTask>();

interface BuildAppOptions {
  planetClient?: PlanetClient;
  fieldStore?: FieldStore;
}

export function buildApp(options: BuildAppOptions = {}) {
  const app = Fastify({ logger: true });
  const planetClient = options.planetClient ?? createPlanetClient();
  const fieldStore = options.fieldStore ?? createMemoryFieldStore();
  void app.register(cors, { origin: true });

  app.get("/api/v1/health", async () => ({ status: "ok" }));

  app.get("/api/v1/integrations/planet", async () => planetClient.checkAccess());

  app.get("/api/v1/fields", async () => ({ fields: await fieldStore.list() }));

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

  app.post<{ Body: CreateAnalysisTaskRequest }>("/api/v1/tasks", async (request, reply) => {
    const field = await fieldStore.get(request.body.fieldId);
    if (!field) {
      return reply.code(404).send({ code: "field_not_found", message: "没有找到该农田。" });
    }
    if (request.body.crop !== "corn") {
      return reply.code(422).send({
        code: "crop_not_supported",
        message: "首版专项分析目前仅支持玉米。",
      });
    }

    const now = Date.now();
    const task: StoredTask = {
      id: randomUUID(),
      fieldId: field.id,
      status: "running",
      progress: 12,
      stage: "正在准备可用资料",
      createdAt: new Date(now).toISOString(),
      completedAt: null,
      demoData: true,
      summary: null,
      findings: [],
      evidence: [],
      readyAt: now + 2600,
    };
    tasks.set(task.id, task);
    return reply.code(202).send(toPublicTask(task));
  });

  app.get<{ Params: { id: string } }>("/api/v1/tasks/:id", async (request, reply) => {
    const task = tasks.get(request.params.id);
    if (!task) {
      return reply.code(404).send({ code: "task_not_found", message: "没有找到该分析任务。" });
    }

    refreshTask(task);
    return toPublicTask(task);
  });

  return app;
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
function cropValue(value: unknown): FieldInput["crop"] | null { return isCrop(value) ? value : null; }
function stringValue(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
function numberValue(value: unknown): number | undefined { return typeof value === "number" ? value : undefined; }
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

function refreshTask(task: StoredTask): void {
  if (task.status !== "running") return;

  const remaining = task.readyAt - Date.now();
  if (remaining > 1700) {
    task.progress = 28;
    task.stage = "正在检查影像覆盖";
    return;
  }
  if (remaining > 700) {
    task.progress = 67;
    task.stage = "正在比较田内变化";
    return;
  }
  if (remaining > 0) {
    task.progress = 88;
    task.stage = "正在组织分析结果";
    return;
  }

  task.status = "needs_input";
  task.progress = 0;
  task.stage = "等待接入已授权地块与 PlanetScope 影像";
}

function toPublicTask(task: StoredTask): AnalysisTask {
  const { readyAt: _readyAt, ...publicTask } = task;
  return publicTask;
}
