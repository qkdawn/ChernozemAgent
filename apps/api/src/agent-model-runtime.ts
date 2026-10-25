import { createCodexRuntime } from "@chernozem/agent-runtime";
import type { AnalysisTaskFailure } from "@chernozem/contracts";

export interface ConfiguredCodexRuntime {
  provider: "openai-codex";
  modelId: string;
  runtime: ReturnType<typeof createCodexRuntime>;
}

export function createConfiguredCodexRuntime(env: NodeJS.ProcessEnv): ConfiguredCodexRuntime {
  const modelId = env.CODEX_MODEL?.trim() || "gpt-5.6-terra";
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY 尚未配置，无法启动 Codex harness。");
  const baseUrl = env.CODEX_BASE_URL ?? env.OPENAI_BASE_URL;
  return {
    provider: "openai-codex",
    modelId,
    runtime: createCodexRuntime({
      modelId,
      apiKey,
      ...(baseUrl ? { baseUrl } : {}),
      ...(env.CODEX_HOME ? { codexHome: env.CODEX_HOME } : {}),
      ...(env.CODEX_WORKING_DIRECTORY ? { workingDirectory: env.CODEX_WORKING_DIRECTORY } : {}),
      ...(env.CODEX_PATH ? { codexPathOverride: env.CODEX_PATH } : {}),
    }),
  };
}

export function publicAgentErrorMessage(error: unknown): string {
  return classifyAgentError(error).message;
}

export function classifyAgentError(error: unknown): AnalysisTaskFailure {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (/CODEX_MODEL|CODEX_BASE_URL|OPENAI_API_KEY|api key|authentication|unauthorized|forbidden|invalid token|blocked|\b40[13]\b/i.test(message)) {
    return { code: "agent_configuration_invalid", retryable: false, message: "农情 Agent 服务配置无效，请联系管理员更新模型凭据。" };
  }
  if (/rate.?limit|quota|overloaded|too many requests|\b429\b/i.test(message)) {
    return { code: "agent_rate_limited", retryable: true, message: "农情 Agent 的模型服务繁忙，请稍后重试。" };
  }
  if (/timeout|timed out|fetch failed|network|ECONN|ENOTFOUND|EAI_AGAIN/i.test(message)) {
    return { code: "agent_unreachable", retryable: true, message: "暂时无法连接农情 Agent 的模型服务，请稍后重试。" };
  }
  if (/disabled capability|没有生成对话回复/.test(message)) {
    return { code: "agent_incomplete", retryable: true, message: "农情 Agent 本次没有形成完整回复，请重试。" };
  }
  return { code: "agent_execution_failed", retryable: true, message: "农情 Agent 运行失败，请稍后重试。" };
}
