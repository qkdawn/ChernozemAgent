import { describe, expect, it } from "vitest";

import { createMemoryTaskConversationStore } from "./task-conversation-store.js";
import { createMemoryFieldConversationStore } from "./field-conversation-store.js";

describe("memory task conversation store", () => {
  it("keeps one initial result and appends an ordered exchange", async () => {
    const store = createMemoryTaskConversationStore();
    const first = await store.ensureInitial("task-1", "初始结论", "2026-08-19T00:00:00.000Z");
    const repeated = await store.ensureInitial("task-1", "不应覆盖", "2026-08-19T00:00:01.000Z");
    const exchange = await store.appendExchange("task-1", "哪里需要查看？", "优先查看西南区域。", "2026-08-19T00:01:00.000Z");

    expect(repeated.id).toBe(first.id);
    expect(exchange.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect((await store.list("task-1")).map((message) => [message.sequence, message.kind, message.content])).toEqual([
      [1, "analysis_result", "初始结论"],
      [2, "chat", "哪里需要查看？"],
      [3, "chat", "优先查看西南区域。"],
    ]);
  });
});

describe("memory field conversation store", () => {
  it("appends ordinary chat without an analysis result message", async () => {
    const store = createMemoryFieldConversationStore();
    await store.appendExchange("field-1", "你好", "你好，我在。", "2026-08-21T00:00:00.000Z");

    expect((await store.list("field-1")).map((message) => [message.sequence, message.role, message.content])).toEqual([
      [1, "user", "你好"],
      [2, "assistant", "你好，我在。"],
    ]);
  });
});
