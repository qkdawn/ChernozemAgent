import { describe, expect, it } from "vitest";

import { classifyAgentError, publicAgentErrorMessage } from "./agent-model-runtime.js";

describe("publicAgentErrorMessage", () => {
  it("hides provider authentication details", () => {
    expect(publicAgentErrorMessage(new Error("OpenAI API error (403): Your request was blocked")))
      .toBe("农情 Agent 服务配置无效，请联系管理员更新模型凭据。");
    expect(publicAgentErrorMessage(new Error("401 Invalid token")))
      .toBe("农情 Agent 服务配置无效，请联系管理员更新模型凭据。");
    expect(classifyAgentError(new Error("401 Invalid token"))).toMatchObject({
      code: "agent_configuration_invalid",
      retryable: false,
    });
  });

  it("returns actionable retry messages for transient failures", () => {
    expect(publicAgentErrorMessage(new Error("429 Too Many Requests")))
      .toBe("农情 Agent 的模型服务繁忙，请稍后重试。");
    expect(classifyAgentError(new Error("429 Too Many Requests"))).toMatchObject({ retryable: true });
    expect(publicAgentErrorMessage(new Error("fetch failed: ECONNRESET")))
      .toBe("暂时无法连接农情 Agent 的模型服务，请稍后重试。");
  });

  it("uses a stable fallback instead of exposing unknown errors", () => {
    expect(publicAgentErrorMessage(new Error("vendor internal stack detail")))
      .toBe("农情 Agent 运行失败，请稍后重试。");
  });
});
