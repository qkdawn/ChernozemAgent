import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import * as z from "zod/v4";

import { AnalysisEvidence, AnalysisEvidenceError, EVIDENCE_TOOLS } from "./analysis-evidence.js";

export function createAnalysisEvidenceMcpServer(evidence: AnalysisEvidence): McpServer {
  const server = new McpServer({ name: "chernozem-task-evidence", version: "1.0.0" });
  server.registerTool("list_analysis_results", {
    description: "列出当前任务已保存的计算或知识成果，包括对象范围、来源、状态和可读取字段。",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    inputSchema: z.strictObject({}),
  }, () => answer(() => evidence.catalog()));
  server.registerTool("read_analysis_result", {
    description: "按成果 ID 读取当前任务的领域数据。paths 是相对 result 的 JSON Pointer；省略则读取完整 result。返回实际数据，不返回预写文案。",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    inputSchema: z.strictObject({ resultId: z.string().min(1).max(200), paths: z.array(z.string().max(300)).min(1).max(20).optional() }),
  }, (input) => answer(() => evidence.readResult({ resultId: input.resultId, ...(input.paths ? { paths: input.paths } : {}) })));
  if (evidence.canSearchKnowledge) server.registerTool("search_agronomy_knowledge", {
    description: "围绕当前任务检索已发布的农学原文，返回出处、版本及适用范围，并持久化为知识成果。",
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    inputSchema: z.strictObject({ query: z.string().trim().min(2).max(500) }),
  }, ({ query }) => answer(() => evidence.searchKnowledge(query)));
  for (const name of evidence.availableTools) server.registerTool(name, {
    description: EVIDENCE_TOOLS[name as keyof typeof EVIDENCE_TOOLS], inputSchema: z.strictObject({}),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  }, () => answer(() => evidence.compute(name)));
  return server;
}

/** A short-lived, loopback-only native MCP endpoint bound to one task and model turn. */
export async function openAnalysisEvidenceMcp(evidence: AnalysisEvidence) {
  const token = randomBytes(32).toString("hex");
  const expected = hash(`Bearer ${token}`);
  const handler = createMcpHandler(() => createAnalysisEvidenceMcpServer(evidence));
  let endpoint = "";
  let closed = false;
  const server = createServer(async (request, response) => {
    if (closed || request.url !== "/mcp" || request.headers.origin || !timingSafeEqual(hash(request.headers.authorization ?? ""), expected)) {
      response.writeHead(403).end();
      return;
    }
    try {
      const headers = new Headers();
      for (const [key, value] of Object.entries(request.headers)) {
        if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
      }
      const body = request.method === "GET" || request.method === "HEAD" ? undefined : await requestBody(request);
      const result = await handler.fetch(new Request(endpoint, { method: request.method ?? "POST", headers, ...(body ? { body: body.toString("utf8") } : {}) }));
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(Buffer.from(await result.arrayBuffer()));
    } catch {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    }
  });
  server.requestTimeout = 180_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
  });
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  return {
    url: endpoint,
    token,
    tools: ["list_analysis_results", "read_analysis_result", ...(evidence.canSearchKnowledge ? ["search_agronomy_knowledge"] : []), ...evidence.availableTools],
    async close() {
      if (closed) return;
      closed = true;
      await handler.close();
      await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
    },
  };
}

async function answer(operation: () => Promise<unknown>) {
  try {
    const result = await operation();
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: { result } };
  } catch (error) {
    const result = error instanceof AnalysisEvidenceError
      ? { status: "unavailable", code: error.code, message: error.message }
      : { status: "failed", code: "evidence_operation_failed", message: "本次证据操作未完成。" };
    return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result };
  }
}

async function requestBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 32_768) throw new Error("MCP request exceeds the registered input schema size.");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function hash(value: string): Buffer { return createHash("sha256").update(value).digest(); }
