import type { AgentEvent } from "@mariozechner/pi-agent-core";

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
  type: AgentEvent["type"];
  occurredAt: string;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
}

export interface AgentEventSink {
  append(record: AgentEventRecord): Promise<void>;
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
