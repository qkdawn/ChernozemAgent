import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { access, copyFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";

const workspaceRoot = resolve(import.meta.dirname, "../../..");
const envPath = resolve(workspaceRoot, ".env");
if (existsSync(envPath)) loadEnvFile(envPath);

const rootArgument = process.argv.slice(2).filter((argument) => argument !== "--")[0];
const graphRagRoot = resolve(workspaceRoot, rootArgument ?? process.env.GRAPHRAG_ROOT ?? "runtime/knowledge/graphrag");
const python = resolve(workspaceRoot, process.env.GRAPHRAG_PYTHON ?? "runtime/graphrag-venv/Scripts/python.exe");
const settingsTemplate = resolve(workspaceRoot, "apps/knowledge-mcp/graphrag/settings.yaml");
const requiredPrompts = [
  "extract_graph.txt",
  "summarize_descriptions.txt",
  "community_report_graph.txt",
  "community_report_text.txt",
  "local_search_system_prompt.txt",
  "global_search_map_system_prompt.txt",
  "global_search_reduce_system_prompt.txt",
  "global_search_knowledge_system_prompt.txt",
  "drift_search_system_prompt.txt",
  "drift_reduce_prompt.txt",
  "basic_search_system_prompt.txt",
];

await mkdir(graphRagRoot, { recursive: true });
const missingPrompts = await Promise.all(requiredPrompts.map(async (name) => {
  try {
    await access(resolve(graphRagRoot, "prompts", name));
    return null;
  } catch {
    return name;
  }
}));
const needsOfficialPrompts = missingPrompts.some(Boolean);
if (needsOfficialPrompts) {
  const exitCode = await runGraphRagInit(python, graphRagRoot);
  if (exitCode !== 0) throw new Error(`GraphRAG initialization failed with exit code ${exitCode}.`);
}
await copyFile(settingsTemplate, resolve(graphRagRoot, "settings.yaml"));
console.log(JSON.stringify({ root: graphRagRoot, generatedOfficialPrompts: needsOfficialPrompts, settingsTemplate }));

function runGraphRagInit(executable: string, root: string): Promise<number> {
  return new Promise((resolveExit, reject) => {
    const child = spawn(executable, [
      "-m", "graphrag", "init", "--root", root,
      "--model", "gpt-5.4", "--embedding", "text-embedding-3-small", "--force",
    ], { cwd: workspaceRoot, stdio: "inherit", windowsHide: true });
    child.on("error", reject);
    child.on("close", (code) => resolveExit(code ?? 1));
  });
}
