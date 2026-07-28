import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@mariozechner/pi-ai";
import { afterEach, describe, expect, it } from "vitest";

import { createChernozemAgent } from "./agent-factory.js";
import { InMemoryAgentEventSink } from "./event-sink.js";
import { INSPECT_TASK_SCOPE_TOOL } from "./scope-tool.js";

const registrations: Array<ReturnType<typeof registerFauxProvider>> = [];

afterEach(() => {
  registrations.splice(0).forEach((registration) => registration.unregister());
});

describe("createChernozemAgent", () => {
  it("executes the allowlisted scope tool and records an ordered lifecycle", async () => {
    const registration = registerFauxProvider();
    registrations.push(registration);
    registration.setResponses([
      fauxAssistantMessage(
        fauxToolCall(INSPECT_TASK_SCOPE_TOOL, {
          taskId: "task-001",
          fieldIds: ["field-001"],
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("分析对象为 field-001 玉米地块，时间为 2026 年 6 月。"),
    ]);

    const sink = new InMemoryAgentEventSink();
    const agent = createChernozemAgent({
      model: registration.getModel(),
      eventSink: sink,
      runId: "run-001",
      scope: {
        organizationId: "org-001",
        taskId: "task-001",
        fieldIds: ["field-001"],
        crop: "corn",
        period: { start: "2026-06-01", end: "2026-06-30" },
      },
    });

    await agent.prompt("读取任务范围。 ");

    expect(sink.records[0]?.type).toBe("agent_start");
    expect(sink.records.at(-1)?.type).toBe("agent_end");
    expect(sink.records.map((record) => record.sequence)).toEqual(
      sink.records.map((_, index) => index + 1),
    );
    expect(sink.records).toContainEqual(
      expect.objectContaining({
        type: "tool_execution_end",
        toolName: INSPECT_TASK_SCOPE_TOOL,
        isError: false,
      }),
    );
  });

  it("blocks a field outside the validated task scope", async () => {
    const registration = registerFauxProvider();
    registrations.push(registration);
    registration.setResponses([
      fauxAssistantMessage(
        fauxToolCall(INSPECT_TASK_SCOPE_TOOL, {
          taskId: "task-001",
          fieldIds: ["field-other"],
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("无法读取该地块。"),
    ]);

    const sink = new InMemoryAgentEventSink();
    const agent = createChernozemAgent({
      model: registration.getModel(),
      eventSink: sink,
      scope: {
        organizationId: "org-001",
        taskId: "task-001",
        fieldIds: ["field-001"],
        crop: "corn",
        period: { start: "2026-06-01", end: "2026-06-30" },
      },
    });

    await agent.prompt("读取范围外的地块。 ");

    expect(sink.records).toContainEqual(
      expect.objectContaining({
        type: "tool_execution_end",
        toolName: INSPECT_TASK_SCOPE_TOOL,
        isError: true,
      }),
    );
  });
});
