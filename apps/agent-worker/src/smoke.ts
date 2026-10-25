import { InMemoryAgentEventSink, runCornWorkflow, type ControlledAnalysisTool } from "@chernozem/agent-runtime";
import type { AnalysisResult } from "@chernozem/contracts";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";

const envPath = resolve(import.meta.dirname, "../../../.env");
if (existsSync(envPath)) {
  loadEnvFile(envPath);
}

const eventSink = new InMemoryAgentEventSink();
try {
  const run = await runCornWorkflow({
    eventSink,
    objective: "growth_stage_monitoring",
    scope: {
      organizationId: "demo-organization",
      taskId: "demo-task",
      fieldIds: ["field-001"],
      crop: "corn",
      period: { start: "2026-06-01", end: "2026-06-30" },
    },
    tools: smokeTools(),
  });
  console.log(JSON.stringify({ run, events: eventSink.records }, null, 2));
} catch (error) {
  const message = error instanceof Error ? error.message : "农情工作流运行失败。";
  console.error(`Agent smoke failed: ${redactSecrets(message)}`);
  console.error(JSON.stringify({ events: eventSink.records.map((event) => ({
    sequence: event.sequence,
    type: event.type,
    ...(event.toolName ? { toolName: event.toolName } : {}),
    ...(event.isError !== undefined ? { isError: event.isError } : {}),
    ...(event.resultStatus ? { resultStatus: event.resultStatus } : {}),
  })) }, null, 2));
  process.exitCode = 1;
}

function smokeTools(): ControlledAnalysisTool[] {
  return [
    tool("analyze_optical_condition", "optical_condition", "已读取 2026-06-26 光学田况。"),
    tool("estimate_crop_stage", "crop_stage", "根据播种日期估计处于拔节期。"),
    tool("assess_growth_status", "assessment", "2026-06-26 地块长势整体正常，西南部存在田内相对偏弱区。"),
  ];
}

function tool(name: ControlledAnalysisTool["name"], kind: AnalysisResult<unknown>["kind"], summary: string): ControlledAnalysisTool {
  return {
    name,
    async execute({ taskId }) {
      return {
        id: `${kind}-smoke`, taskId, kind, status: "succeeded", toolVersion: "smoke", createdAt: new Date().toISOString(),
        execution: { toolName: name, scope: { fieldId: "demo-field", boundaryVersion: 1, timeRange: null }, inputs: { acquisitionIds: [], assetIds: [], resultIds: [] }, parameters: {}, inputFingerprint: "smoke" },
        summary, result: {}, sources: [], findings: [], artifacts: [], limitations: [], nextActions: [], error: null,
      };
    },
  };
}

function redactSecrets(value: string): string {
  const configured = process.env.OPENAI_API_KEY;
  return value
    .replace(configured ?? "__no_configured_key__", configured ? "[REDACTED]" : "__no_configured_key__")
    .replace(/\bBearer\s+[A-Za-z0-9._~-]{8,}/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "[REDACTED]");
}
