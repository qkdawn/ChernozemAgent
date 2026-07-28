import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@mariozechner/pi-ai";
import { createHash } from "node:crypto";

import type { DomainToolEnvelope, TaskScope } from "./types.js";

export const INSPECT_TASK_SCOPE_TOOL = "inspect_task_scope";

const scopeParameters = Type.Object({
  taskId: Type.String({ minLength: 1 }),
  fieldIds: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
});

export function createInspectTaskScopeTool(scope: TaskScope): AgentTool<typeof scopeParameters, DomainToolEnvelope> {
  return {
    name: INSPECT_TASK_SCOPE_TOOL,
    label: "Inspect task scope",
    description: "Read the validated field, crop, and time scope for the current analysis task.",
    parameters: scopeParameters,
    executionMode: "parallel",
    async execute(_toolCallId, params, signal) {
      signal?.throwIfAborted();

      const details: DomainToolEnvelope = {
        status: "succeeded",
        coverage: {
          timeStart: scope.period.start,
          timeEnd: scope.period.end,
          fieldIds: [...scope.fieldIds],
        },
        quality: { flags: [], usableFraction: 1 },
        parameters: {
          taskId: params.taskId,
          requestedFieldIds: [...params.fieldIds],
          crop: scope.crop,
        },
        outputs: [],
        limitations: [],
        error: { code: null, retryable: false, message: null },
        audit: {
          toolVersion: "0.1.0",
          inputHash: createHash("sha256").update(JSON.stringify(params)).digest("hex"),
          cost: 0,
        },
      };

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              taskId: scope.taskId,
              fieldIds: scope.fieldIds,
              crop: scope.crop,
              period: scope.period,
            }),
          },
        ],
        details,
      };
    },
  };
}
