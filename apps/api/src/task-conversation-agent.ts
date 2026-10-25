import { runFieldConversation, runTaskConversation, type AgronomyKnowledgeSearchPort } from "@chernozem/agent-runtime";
import type { AnalysisTask, FieldConversationMessage, FieldSummary, TaskConversationMessage } from "@chernozem/contracts";

import { createConfiguredCodexRuntime, publicAgentErrorMessage } from "./agent-model-runtime.js";

export interface TaskConversationReplyRequest {
  task: AnalysisTask;
  history: TaskConversationMessage[];
  userMessage: string;
}

export interface TaskConversationAgent {
  reply(request: TaskConversationReplyRequest): Promise<string>;
}

export interface FieldConversationReplyRequest {
  field: FieldSummary;
  history: FieldConversationMessage[];
  recentTasks: AnalysisTask[];
  userMessage: string;
}

export interface FieldConversationAgent {
  reply(request: FieldConversationReplyRequest): Promise<string>;
}

export function createDeterministicTaskConversationAgent(): TaskConversationAgent {
  return {
    async reply(request) {
      return `${taskProfessionalSummary(request.task)} ${request.task.nextActions[0]?.label ?? "请结合任务中的依据继续核查。"}`.trim();
    },
  };
}

export function createDeterministicFieldConversationAgent(): FieldConversationAgent {
  return { async reply(request) {
    const latest = request.recentTasks[0];
    return latest
      ? `${request.field.name}最近一次${latest.objective === "growth_stage_monitoring" ? "长势" : latest.objective === "water_nitrogen_diagnosis" ? "水氮" : latest.objective === "waterlogging_detection" ? "积水" : "霜冻"}任务结果：${taskProfessionalSummary(latest)}`
      : `你好，我可以和你讨论${request.field.name}，也可以先规划一项农情任务。`;
  } };
}

function taskProfessionalSummary(task: AnalysisTask): string {
  if (task.brief) return `${task.brief.headline} ${task.brief.overview}`;
  return task.summary?.trim() || "本次任务没有形成可用结论。";
}

export function createCodexTaskConversationAgent(
  env: NodeJS.ProcessEnv = process.env,
  knowledgeSearch?: AgronomyKnowledgeSearchPort,
): TaskConversationAgent {
  let configured: ReturnType<typeof createConfiguredCodexRuntime>;
  try {
    configured = createConfiguredCodexRuntime(env);
  } catch (error) {
    console.error("[agent-conversation] 模型配置无效", error);
    return unavailableConversationAgent(publicAgentErrorMessage(error));
  }
  return {
    async reply(request) {
      try {
        return await runTaskConversation({
          runtime: configured.runtime,
          task: request.task,
          history: request.history,
          userMessage: request.userMessage,
          ...(knowledgeSearch ? { knowledgeSearch } : {}),
        });
      } catch (error) {
        console.error(`[agent-conversation:${request.task.id}] 对话生成失败`, error);
        throw new Error(publicAgentErrorMessage(error), { cause: error });
      }
    },
  };
}

export function createCodexFieldConversationAgent(
  env: NodeJS.ProcessEnv = process.env,
  knowledgeSearch?: AgronomyKnowledgeSearchPort,
): FieldConversationAgent {
  let configured: ReturnType<typeof createConfiguredCodexRuntime>;
  try {
    configured = createConfiguredCodexRuntime(env);
  } catch (error) {
    console.error("[field-conversation] 模型配置无效", error);
    return unavailableConversationAgent(publicAgentErrorMessage(error));
  }
  return {
    async reply(request) {
      try {
        return await runFieldConversation({
          runtime: configured.runtime,
          field: request.field,
          history: request.history,
          recentTasks: request.recentTasks,
          userMessage: request.userMessage,
          ...(knowledgeSearch ? { knowledgeSearch } : {}),
        });
      } catch (error) {
        console.error(`[field-conversation:${request.field.id}] 对话生成失败`, error);
        throw new Error(publicAgentErrorMessage(error), { cause: error });
      }
    },
  };
}

function unavailableConversationAgent(message: string): TaskConversationAgent & FieldConversationAgent {
  return { async reply() { throw new Error(message); } };
}
