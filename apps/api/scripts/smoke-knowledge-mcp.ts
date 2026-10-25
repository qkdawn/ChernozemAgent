import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";

const envPath = resolve(import.meta.dirname, "../../../.env");
if (existsSync(envPath)) loadEnvFile(envPath);

const taskId = process.argv.slice(2).findLast((argument) => argument !== "--");
if (!taskId) throw new Error("Pass an existing analysis task ID.");

const client = new Client({ name: "chernozem-knowledge-smoke", version: "0.1.0" });
const transport = new StdioClientTransport({
  command: process.platform === "win32" ? "pnpm.cmd" : "pnpm",
  args: ["--silent", "--filter", "@chernozem/knowledge-mcp", "start"],
  env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
});

try {
  await client.connect(transport);
  const tools = await client.listTools();
  const result = await client.callTool({
    name: "search_agronomy_knowledge",
    arguments: { taskId, query: "玉米拔节期如何核查田内相对弱势区？" },
  });
  console.log(JSON.stringify({
    tools: tools.tools.map((tool) => tool.name),
    structuredContent: result.structuredContent,
    content: result.content,
  }, null, 2));
} finally {
  await client.close();
}
