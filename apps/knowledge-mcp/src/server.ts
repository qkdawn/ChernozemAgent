import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import * as z from "zod/v4";
import pg from "pg";

import {
  AgronomyKnowledgeService,
  createGraphRagPythonRunner,
  createPostgresKnowledgeRepository,
  type GraphRagQueryRunner,
} from "./knowledge-service.js";
import type { AgronomyKnowledgeSearchInput, AgronomyKnowledgeSearchResult } from "@chernozem/contracts";
import { createLocalKnowledgeRepository, LocalKnowledgeService } from "./local-knowledge.js";

const envPath = resolve(import.meta.dirname, "../../../.env");
if (existsSync(envPath)) loadEnvFile(envPath);

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required by the knowledge MCP server.");

const organizationId = process.env.ORGANIZATION_ID ?? "00000000-0000-0000-0000-000000000001";
const engine = process.env.KNOWLEDGE_SEARCH_ENGINE ?? "local";
if (engine !== "local" && engine !== "graphrag") throw new Error("KNOWLEDGE_SEARCH_ENGINE must be local or graphrag.");
const service = engine === "local"
  ? new LocalKnowledgeService(createLocalKnowledgeRepository(new pg.Pool({ connectionString: databaseUrl }), organizationId))
  : new AgronomyKnowledgeService(createPostgresKnowledgeRepository(databaseUrl, organizationId), configuredRunner(process.env));

void serveStdio(() => createKnowledgeMcpServer(service));
console.error("chernozem knowledge MCP server running on stdio");

export function createKnowledgeMcpServer(service: { search(input: AgronomyKnowledgeSearchInput): Promise<AgronomyKnowledgeSearchResult> }): McpServer {
  const server = new McpServer(
    { name: "chernozem-agronomy-knowledge", version: "0.1.0" },
    { instructions: "Only retrieve Northeast China black-soil maize knowledge for an authorized field or existing analysis task. Retrieved knowledge explains but never overrides field or task observations." },
  );
  server.registerTool(
    "search_agronomy_knowledge",
    {
      title: "Search agronomy knowledge",
      description: "Retrieve cited original agronomy passages from the published maize knowledge collection, scoped to an authorized field or existing task. Knowledge is explanatory, never a field observation.",
      inputSchema: z.union([
        z.strictObject({ taskId: z.string().trim().min(1), query: z.string().trim().min(2).max(500) }),
        z.strictObject({ fieldId: z.string().trim().min(1), query: z.string().trim().min(2).max(500) }),
      ]),
    },
    async (input) => {
      const result = await service.search("taskId" in input
        ? { taskId: input.taskId, query: input.query.trim() }
        : { fieldId: input.fieldId, query: input.query.trim() });
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result as unknown as Record<string, unknown>,
        isError: false,
      };
    },
  );
  return server;
}

function configuredRunner(env: NodeJS.ProcessEnv): GraphRagQueryRunner | null {
  if (!env.GRAPHRAG_PYTHON || !env.GRAPHRAG_ROOT || !env.GRAPHRAG_DATA_DIR) return null;
  return createGraphRagPythonRunner({
    pythonExecutable: env.GRAPHRAG_PYTHON,
    scriptPath: resolve(import.meta.dirname, "../scripts/query-graphrag.py"),
    workspaceRoot: env.GRAPHRAG_ROOT,
    outputDirectory: env.GRAPHRAG_DATA_DIR,
    environment: env,
  });
}
