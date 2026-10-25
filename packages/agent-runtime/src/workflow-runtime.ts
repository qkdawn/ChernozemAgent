import type { AnalysisObjective } from "@chernozem/contracts";
import { randomUUID } from "node:crypto";

import { CornSkillRunner, type ControlledAnalysisTool } from "./skill-runner.js";
import type { AgentEventRecord, AgentEventSink, CornAgentRunResult, TaskScope } from "./types.js";

export interface RunCornWorkflowOptions {
  objective: AnalysisObjective;
  scope: TaskScope;
  tools: ControlledAnalysisTool[];
  eventSink: AgentEventSink;
  runId?: string;
}

export async function runCornWorkflow(options: RunCornWorkflowOptions): Promise<CornAgentRunResult> {
  const runId = options.runId ?? randomUUID();
  let sequence = 0;
  const append = (record: Omit<AgentEventRecord, "runId" | "sequence" | "occurredAt">) => options.eventSink.append({
    runId,
    sequence: ++sequence,
    occurredAt: new Date().toISOString(),
    ...record,
  });

  await append({ type: "workflow_start" });
  const results = await new CornSkillRunner(options.tools).run(options.objective, options.scope.taskId, {
    beforeTool: (toolName) => append({ type: "tool_execution_start", toolName }),
    afterTool: async (toolName, result) => {
      if (!options.scope.fieldIds.includes(result.execution.scope.fieldId)) throw new Error(`工具 ${toolName} 返回了任务范围外的地块结果。`);
      await append({
        type: "tool_execution_end",
        toolName,
        isError: result.status === "failed",
        resultId: result.id,
        resultStatus: result.status,
      });
    },
  });
  await append({ type: "workflow_end" });

  const assessment = results.at(-1);
  if (!assessment) throw new Error(`工作流 ${options.objective} 没有生成结果。`);
  return { runId, results, finalMessage: assessment.summary };
}
