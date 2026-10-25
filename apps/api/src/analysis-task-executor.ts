import {
  CornSkillRunner,
  runCornWorkflow,
  type ControlledAnalysisTool,
  type TaskScope,
} from "@chernozem/agent-runtime";
import type { AnalysisObjective, AnalysisResult } from "@chernozem/contracts";
import type { AnalysisTaskFailure } from "@chernozem/contracts";
import { randomUUID } from "node:crypto";

import { createMemoryAgentRunStore, type AgentRunStore } from "./agent-run-store.js";
import { classifyAgentError } from "./agent-model-runtime.js";

export interface AnalysisTaskExecutionRequest {
  objective: AnalysisObjective;
  taskId: string;
  scope: TaskScope;
  tools: ControlledAnalysisTool[];
  userRequest?: string;
}

export interface AnalysisTaskExecution {
  runId: string | null;
  finalMessage: string | null;
  results: AnalysisResult<unknown>[];
}

export interface AnalysisTaskExecutor {
  run(request: AnalysisTaskExecutionRequest): Promise<AnalysisTaskExecution>;
}

export function createDeterministicAnalysisTaskExecutor(): AnalysisTaskExecutor {
  return {
    async run(request) {
      return {
        runId: null,
        finalMessage: null,
        results: await new CornSkillRunner(request.tools).run(request.objective, request.taskId),
      };
    },
  };
}

export function createWorkflowAnalysisTaskExecutor(runStore: AgentRunStore = createMemoryAgentRunStore()): AnalysisTaskExecutor {
  return {
    async run(request) {
      const runId = randomUUID();
      const startedAt = new Date().toISOString();
      await runStore.start({ id: runId, organizationId: request.scope.organizationId, taskId: request.taskId, provider: "chernozem-workflow", modelId: "deterministic-v1", startedAt });
      try {
        const run = await runCornWorkflow({
          eventSink: runStore,
          objective: request.objective,
          scope: request.scope,
          tools: request.tools,
          runId,
        });
        await runStore.complete(runId, run.finalMessage, new Date().toISOString());
        return run;
      } catch (error) {
        const failure = classifyAgentError(error);
        console.error(`[agent-run:${runId}] 农情 Agent 运行失败`, error);
        await runStore.fail(runId, failure.message, new Date().toISOString());
        throw new AnalysisTaskExecutionError(failure, error);
      }
    },
  };
}

export class AnalysisTaskExecutionError extends Error {
  constructor(readonly failure: AnalysisTaskFailure, cause?: unknown) {
    super(failure.message, { cause });
    this.name = "AnalysisTaskExecutionError";
  }
}
