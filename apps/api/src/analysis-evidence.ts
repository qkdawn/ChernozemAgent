import type { AgronomyKnowledgeSearchPort, ControlledAnalysisTool } from "@chernozem/agent-runtime";
import type { AnalysisResult, AnalysisTask, AnalysisToolName } from "@chernozem/contracts";
import { createHash } from "node:crypto";

import type { AnalysisResultStore } from "./analysis-store.js";

export type AnalysisEvidenceTask = Pick<AnalysisTask, "id" | "fieldId" | "boundaryVersion" | "objective" | "timeRange" | "requestMessage">;

export const EVIDENCE_TOOLS = {
  analyze_optical_condition: "读取已采集光学影像，计算可用时序、各指数变化和田内分区。",
  analyze_radar_change: "对已采集可比雷达时相计算变化、覆盖与空间分区。",
  analyze_weather_event: "从已采集天气数据计算任务时段相关降雨或低温过程。",
  analyze_terrain_susceptibility: "从已采集地形计算高程、坡度及相对低洼分区。",
  get_soil_background: "读取已采集土壤背景属性及其空间尺度。",
  estimate_crop_stage: "使用已登记播期和可用证据估计生育期及置信度。",
} satisfies Partial<Record<AnalysisToolName, string>>;

export class AnalysisEvidenceError extends Error {
  constructor(readonly code: "result_not_available" | "path_not_available" | "tool_not_available" | "invalid_tool_result", message: string) {
    super(message);
    this.name = "AnalysisEvidenceError";
  }
}

/** Owns one task's investigation; protocol and model messages stay in the harness. */
export class AnalysisEvidence {
  private readonly tools: Map<AnalysisToolName, ControlledAnalysisTool>;
  private readonly reads = new Map<string, Set<string>>();
  private readonly computations = new Map<string, Promise<unknown>>();
  private readonly searches = new Map<string, Promise<unknown>>();

  constructor(private readonly options: {
    task: AnalysisEvidenceTask;
    store: AnalysisResultStore;
    tools?: ControlledAnalysisTool[];
    knowledgeSearch?: AgronomyKnowledgeSearchPort;
  }) {
    if (!Number.isInteger(options.task.boundaryVersion) || options.task.boundaryVersion! < 1) throw new Error("调查必须绑定已验证的地块边界版本。");
    this.tools = new Map((options.tools ?? []).map((tool) => [tool.name, tool]));
    if (this.tools.size !== (options.tools ?? []).length) throw new Error("调查工具重复注册。");
    if ([...this.tools.keys()].some((name) => !Object.hasOwn(EVIDENCE_TOOLS, name))) throw new Error("调查阶段只能注册证据计算工具。");
  }

  get availableTools(): AnalysisToolName[] { return [...this.tools.keys()]; }
  get canSearchKnowledge(): boolean { return this.options.knowledgeSearch !== undefined; }

  async results(): Promise<AnalysisResult<unknown>[]> {
    return (await this.options.store.list(this.options.task.id)).filter((result) => this.inScope(result));
  }

  async catalog() {
    return (await this.results()).map(resultDescriptor);
  }

  async readResult(input: { resultId: string; paths?: string[] }) {
    const result = await this.options.store.get(input.resultId);
    if (!result || !this.inScope(result)) throw new AnalysisEvidenceError("result_not_available", "当前任务没有可读取的该成果。");
    const paths = input.paths ?? [""];
    const data = paths.map((path) => {
      const selected = valueAtPointer(result.result, path);
      if (!selected.found) throw new AnalysisEvidenceError("path_not_available", "该成果没有请求的字段。");
      return { path, value: selected.value };
    });
    for (const path of paths) this.recordRead(result.id, path);
    return { ...resultDescriptor(result), data };
  }

  async compute(name: AnalysisToolName): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) throw new AnalysisEvidenceError("tool_not_available", "当前任务未注册该计算工具。");
    const pending = this.computations.get(name);
    if (pending) return pending;
    const computation = (async () => {
      const cached = (await this.results()).find((result) => result.execution.toolName === name);
      const result = cached ?? await tool.execute({ taskId: this.options.task.id });
      if (!this.inScope(result) || result.execution.toolName !== name) {
        throw new AnalysisEvidenceError("invalid_tool_result", "工具返回的成果与当前任务范围不一致。");
      }
      // Reuse the original result store; no fact is kept only in transient model text.
      if (!cached) await this.options.store.save(result);
      return this.readResult({ resultId: result.id });
    })();
    this.computations.set(name, computation);
    return computation;
  }

  async searchKnowledge(query: string): Promise<unknown> {
    if (!this.options.knowledgeSearch) throw new AnalysisEvidenceError("tool_not_available", "当前任务没有可用的知识检索入口。");
    const normalized = query.trim().replace(/\s+/g, " ");
    const pending = this.searches.get(normalized);
    if (pending) return pending;
    const search = (async () => {
      const existing = (await this.results()).find((result) => result.kind === "knowledge_context" && result.execution.parameters.query === normalized);
      if (existing) return this.readResult({ resultId: existing.id });
      const response = await this.options.knowledgeSearch!.search({ taskId: this.options.task.id, query: normalized });
      const payload = { status: response.status, query: normalized, indexRunRef: response.indexRunRef, matches: response.matches };
      const fingerprint = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
      const result: AnalysisResult<typeof payload> = {
        id: knowledgeResultId(this.options.task.id, fingerprint), taskId: this.options.task.id,
        kind: "knowledge_context", status: response.status === "succeeded" ? "succeeded" : response.status === "no_matches" ? "needs_data" : "failed",
        toolVersion: "agronomy-knowledge-search-v1", createdAt: new Date().toISOString(),
        execution: { toolName: "search_agronomy_knowledge", scope: {
          fieldId: this.options.task.fieldId, boundaryVersion: this.options.task.boundaryVersion!, timeRange: this.options.task.timeRange,
        }, inputs: { acquisitionIds: [], assetIds: [], resultIds: [] }, parameters: { query: normalized, indexRunRef: response.indexRunRef }, inputFingerprint: fingerprint },
        summary: `知识检索：${response.status}，${response.matches.length} 个原文片段。`, result: payload,
        sources: response.matches.map((match) => ({ source: match.citation.sourceId, date: null, quality: "usable", note: match.citation.locator })),
        findings: [], artifacts: [], limitations: response.limitations, nextActions: [], error: response.error,
      };
      await this.options.store.save(result);
      return this.readResult({ resultId: result.id });
    })();
    this.searches.set(normalized, search);
    return search;
  }

  wasRead(resultId: string, path: string): boolean {
    const reads = this.reads.get(resultId);
    return Boolean(reads && [...reads].some((read) => read === "" || path === read || path.startsWith(`${read}/`)));
  }

  inScope(result: AnalysisResult<unknown>): boolean {
    const { task } = this.options;
    return result.taskId === task.id && result.execution.scope.fieldId === task.fieldId
      && task.boundaryVersion !== undefined && result.execution.scope.boundaryVersion === task.boundaryVersion;
  }

  private recordRead(resultId: string, path: string) {
    const paths = this.reads.get(resultId) ?? new Set<string>();
    paths.add(path);
    this.reads.set(resultId, paths);
  }
}

export function resultDescriptor(result: AnalysisResult<unknown>) {
  return { id: result.id, kind: result.kind, status: result.status, toolVersion: result.toolVersion, createdAt: result.createdAt,
    scope: result.execution.scope, parameters: result.execution.parameters,
    availablePaths: result.result !== null && typeof result.result === "object"
      ? Object.keys(result.result).map((key) => `/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`) : [],
    sources: result.sources.map(({ source, date, quality, role }) => ({ source, date, quality, ...(role ? { role } : {}) })),
    error: result.error ? { code: result.error.code, retryable: result.error.retryable } : null };
}

export function valueAtPointer(value: unknown, path: string): { found: boolean; value?: unknown } {
  if (path === "") return { found: true, value };
  if (!path.startsWith("/") || /~(?![01])/u.test(path)) return { found: false };
  let current: unknown = value;
  for (const token of path.slice(1).split("/")) {
    const key = token.replace(/~1/g, "/").replace(/~0/g, "~");
    if (current === null || typeof current !== "object" || !Object.hasOwn(current, key)) return { found: false };
    current = (current as Record<string, unknown>)[key];
  }
  return { found: true, value: current };
}

function knowledgeResultId(taskId: string, fingerprint: string): string {
  const hex = createHash("sha256").update(`${taskId}:${fingerprint}`).digest("hex").slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8).join("")}-${hex.slice(8, 12).join("")}-${hex.slice(12, 16).join("")}-${hex.slice(16, 20).join("")}-${hex.slice(20).join("")}`;
}
