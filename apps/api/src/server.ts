import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";

import { createPostgresAcquisitionStore } from "./acquisition-store.js";
import { createCodexAnalysisBriefWriter } from "./analysis-brief-writer.js";
import { createConfiguredCodexRuntime } from "./agent-model-runtime.js";
import { createPostgresAgentRunStore } from "./agent-run-store.js";
import { createPostgresAnalysisResultStore } from "./analysis-store.js";
import { createAnalysisRequestRouter } from "./analysis-request-router.js";
import { createWorkflowAnalysisTaskExecutor } from "./analysis-task-executor.js";
import { buildApp } from "./app.js";
import { createDefaultAcquisitionProviders, DataAcquisitionService } from "./data-acquisition.js";
import { createPostgresFieldStore } from "./field-store.js";
import { createPostgresFieldConversationStore } from "./field-conversation-store.js";
import { createKnowledgeMcpSearch } from "./knowledge-mcp-client.js";
import { createPostgresNitrogenPrescriptionStore } from "./nitrogen-prescription-store.js";
import { createPostgresAnalysisTaskStore } from "./task-store.js";
import { createPostgresScoutingNoteStore } from "./scouting-store.js";
import { createCodexFieldConversationAgent, createCodexTaskConversationAgent } from "./task-conversation-agent.js";
import { createPostgresTaskConversationStore } from "./task-conversation-store.js";

const envPath = resolve(import.meta.dirname, "../../../.env");
if (existsSync(envPath)) {
  loadEnvFile(envPath);
}

const port = Number(process.env.PORT ?? 3001);
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required. Start PostGIS with docker compose up -d before starting the API.");
}
const agentRunStore = createPostgresAgentRunStore(databaseUrl);
const analysisResultStore = createPostgresAnalysisResultStore(databaseUrl);
const knowledgeSearch = createKnowledgeMcpSearch(process.env);
let analysisBriefWriter: ReturnType<typeof createCodexAnalysisBriefWriter> | undefined;
try {
  analysisBriefWriter = createCodexAnalysisBriefWriter({ ...createConfiguredCodexRuntime(process.env), store: analysisResultStore, ...(knowledgeSearch ? { knowledgeSearch } : {}) });
} catch (error) {
  console.error("[analysis-brief-writer] 模型配置无效，仅提供计算摘要，AI 解读未生成", error);
}
const app = buildApp({
  fieldStore: createPostgresFieldStore(databaseUrl),
  acquisitionService: new DataAcquisitionService(createPostgresAcquisitionStore(databaseUrl), createDefaultAcquisitionProviders()),
  analysisResultStore,
  taskStore: createPostgresAnalysisTaskStore(databaseUrl),
  scoutingNoteStore: createPostgresScoutingNoteStore(databaseUrl),
  nitrogenPrescriptionStore: createPostgresNitrogenPrescriptionStore(databaseUrl),
  agentRunStore,
  analysisTaskExecutor: createWorkflowAnalysisTaskExecutor(agentRunStore),
  ...(analysisBriefWriter ? { analysisBriefWriter } : {}),
  taskConversationAgent: createCodexTaskConversationAgent(process.env, knowledgeSearch),
  taskConversationStore: createPostgresTaskConversationStore(databaseUrl),
  fieldConversationAgent: createCodexFieldConversationAgent(process.env, knowledgeSearch),
  fieldConversationStore: createPostgresFieldConversationStore(databaseUrl),
  analysisRequestRouter: createAnalysisRequestRouter(),
});

try {
  await app.listen({ host: "0.0.0.0", port });
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}
