import { Agent, type AgentEvent } from "@mariozechner/pi-agent-core";
import type { Api, Message, Model } from "@mariozechner/pi-ai";
import { randomUUID } from "node:crypto";

import { createInspectTaskScopeTool, INSPECT_TASK_SCOPE_TOOL } from "./scope-tool.js";
import type { AgentEventRecord, AgentEventSink, TaskScope } from "./types.js";

const SYSTEM_PROMPT = `你是黑土智管的农田分析任务助手。
你的职责是理解任务范围、调用已注册的受控工具，并用清楚的中文组织结构化结果。
不得虚构数据、地块、遥感观测或工具结果。不得提供施肥、灌溉、用药处方。
当前最小运行验证只允许读取任务范围；调用 inspect_task_scope 后，简要复述地块、作物和分析时段。`;

export interface CreateChernozemAgentOptions {
  model: Model<Api>;
  scope: TaskScope;
  eventSink: AgentEventSink;
  runId?: string;
  getApiKey?: (provider: string) => string | undefined | Promise<string | undefined>;
}

export function createChernozemAgent(options: CreateChernozemAgentOptions): Agent {
  const runId = options.runId ?? randomUUID();
  const allowedFieldIds = new Set(options.scope.fieldIds);
  let sequence = 0;

  const agent = new Agent({
    sessionId: runId,
    initialState: {
      systemPrompt: SYSTEM_PROMPT,
      model: options.model,
      thinkingLevel: "off",
      tools: [createInspectTaskScopeTool(options.scope)],
      messages: [],
    },
    ...(options.getApiKey ? { getApiKey: options.getApiKey } : {}),
    convertToLlm: (messages) => messages as Message[],
    transformContext: async (messages) => messages,
    toolExecution: "parallel",
    beforeToolCall: async ({ toolCall, args }) => {
      if (toolCall.name !== INSPECT_TASK_SCOPE_TOOL) {
        return { block: true, reason: `Tool is not allowed for this run: ${toolCall.name}` };
      }

      const requested = args as { taskId: string; fieldIds: string[] };
      const validTask = requested.taskId === options.scope.taskId;
      const validFields = requested.fieldIds.every((fieldId) => allowedFieldIds.has(fieldId));
      if (!validTask || !validFields) {
        return { block: true, reason: "Requested task or field is outside the validated task scope." };
      }

      return undefined;
    },
    afterToolCall: async ({ result }) => ({ details: result.details }),
  });

  agent.subscribe(async (event) => {
    await options.eventSink.append(toEventRecord(event, runId, ++sequence));
  });

  return agent;
}

function toEventRecord(event: AgentEvent, runId: string, sequence: number): AgentEventRecord {
  const base: AgentEventRecord = {
    runId,
    sequence,
    type: event.type,
    occurredAt: new Date().toISOString(),
  };

  if (event.type === "tool_execution_start" || event.type === "tool_execution_update") {
    return { ...base, toolCallId: event.toolCallId, toolName: event.toolName };
  }

  if (event.type === "tool_execution_end") {
    return {
      ...base,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      isError: event.isError,
    };
  }

  return base;
}
