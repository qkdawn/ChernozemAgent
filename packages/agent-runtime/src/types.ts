import type { AnalysisObjective, AnalysisResult } from "@chernozem/contracts";

export interface TaskScope {
  organizationId: string;
  taskId: string;
  fieldIds: string[];
  crop: string;
  period: {
    start: string;
    end: string;
  };
}

export interface AgentEventRecord {
  runId: string;
  sequence: number;
  type: "workflow_start" | "tool_execution_start" | "tool_execution_end" | "workflow_end";
  occurredAt: string;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  resultId?: string;
  resultStatus?: AnalysisResult<unknown>["status"];
}

export interface AgentEventSink {
  append(record: AgentEventRecord): Promise<void>;
}

export interface CornAgentRunRequest {
  objective: AnalysisObjective;
  scope: TaskScope;
  tools: import("./skill-runner.js").ControlledAnalysisTool[];
  prompt?: string;
}

export interface CornAgentRunResult {
  runId: string;
  finalMessage: string;
  results: AnalysisResult<unknown>[];
}

export interface DomainToolEnvelope {
  status: "succeeded" | "partial" | "failed";
  coverage: {
    timeStart: string;
    timeEnd: string;
    fieldIds: string[];
  };
  quality: {
    flags: string[];
    usableFraction: number;
  };
  parameters: Record<string, unknown>;
  outputs: Array<{ kind: "observation" | "artifact"; ref: string }>;
  limitations: string[];
  error: {
    code: string | null;
    retryable: boolean;
    message: string | null;
  };
  audit: {
    toolVersion: string;
    inputHash: string;
    cost: number | null;
  };
}
