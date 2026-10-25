import type { AgronomyKnowledgeSearchPort } from "@chernozem/agent-runtime";
import type { AgronomyKnowledgeSearchResult } from "@chernozem/contracts";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

export function createKnowledgeMcpSearch(env: NodeJS.ProcessEnv): AgronomyKnowledgeSearchPort | undefined {
  if (env.KNOWLEDGE_MCP_ENABLED !== "true") return undefined;
  const command = env.KNOWLEDGE_MCP_COMMAND || (process.platform === "win32" ? "pnpm.cmd" : "pnpm");
  const args = parseArgs(env.KNOWLEDGE_MCP_ARGS_JSON) ?? ["--silent", "--filter", "@chernozem/knowledge-mcp", "start"];
  return {
    async search(input) {
      const client = new Client({ name: "chernozem-api", version: "0.1.0" });
      const transport = new StdioClientTransport({ command, args, env: processEnvironment(env) });
      try {
        await client.connect(transport);
        const response = await client.callTool({ name: "search_agronomy_knowledge", arguments: input });
        return parseKnowledgeSearchResult(response.structuredContent ?? textContent(response.content));
      } catch (error) {
        const message = error instanceof Error ? error.message : "知识 MCP 调用失败。";
        return unavailable(message);
      } finally {
        await client.close().catch(() => undefined);
      }
    },
  };
}

export function parseKnowledgeSearchResult(value: unknown): AgronomyKnowledgeSearchResult {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  if (!parsed || typeof parsed !== "object") throw new Error("知识 MCP 返回了无效结果。");
  const candidate = parsed as Partial<AgronomyKnowledgeSearchResult>;
  if (!isStatus(candidate.status) || !Array.isArray(candidate.matches) || !Array.isArray(candidate.limitations)) {
    throw new Error("知识 MCP 返回了无效结果。");
  }
  if (candidate.answer !== null && typeof candidate.answer !== "string") throw new Error("知识 MCP 返回了无效答案。");
  if (candidate.indexRunRef !== null && typeof candidate.indexRunRef !== "string") throw new Error("知识 MCP 返回了无效索引引用。");
  return candidate as AgronomyKnowledgeSearchResult;
}

function textContent(content: unknown): string {
  if (!Array.isArray(content)) throw new Error("知识 MCP 没有返回可读取内容。");
  const block = content.find((item) => item && typeof item === "object" && (item as { type?: unknown }).type === "text") as { text?: unknown } | undefined;
  if (!block || typeof block.text !== "string") throw new Error("知识 MCP 没有返回可读取内容。");
  return block.text;
}

function parseArgs(value: string | undefined): string[] | null {
  if (!value) return null;
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw new Error("KNOWLEDGE_MCP_ARGS_JSON 必须是字符串数组。");
  }
  return parsed;
}

function processEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function isStatus(value: unknown): value is AgronomyKnowledgeSearchResult["status"] {
  return value === "succeeded" || value === "no_matches" || value === "unavailable";
}

function unavailable(message: string): AgronomyKnowledgeSearchResult {
  return {
    status: "unavailable",
    indexRunRef: null,
    answer: null,
    matches: [],
    limitations: ["知识检索暂时不可用，当前回答仅使用已有地块或任务上下文。"],
    error: { code: "knowledge_mcp_unavailable", message: sanitize(message), retryable: true },
  };
}

function sanitize(message: string): string {
  return message.replace(/sk-[A-Za-z0-9_-]+/g, "[REDACTED]").slice(0, 300);
}
