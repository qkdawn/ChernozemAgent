import { beforeEach, describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const codexMocks = vi.hoisted(() => ({
  constructor: vi.fn(),
  run: vi.fn(),
  startThread: vi.fn(),
}));

vi.mock("@openai/codex-sdk", () => ({
  Codex: class {
    constructor(options: unknown) { codexMocks.constructor(options); }
    startThread = codexMocks.startThread;
  },
}));

import { createCodexRuntime } from "./model-runtime.js";

describe("Codex runtime configuration", () => {
  beforeEach(() => {
    codexMocks.constructor.mockReset();
    codexMocks.run.mockReset().mockResolvedValue({
      items: [{ id: "message-1", type: "agent_message", text: "已收到" }],
      finalResponse: "已收到",
      usage: null,
    });
    codexMocks.startThread.mockReset().mockReturnValue({ id: "thread-1", run: codexMocks.run });
  });

  it("requires explicit model access credentials", () => {
    expect(() => createCodexRuntime({ modelId: "gpt-5.6-terra", apiKey: "" })).toThrow("OPENAI_API_KEY");
    expect(() => createCodexRuntime({ modelId: "", apiKey: "test" })).toThrow("CODEX_MODEL");
  });

  it("rejects non-http model gateways", () => {
    expect(() => createCodexRuntime({ modelId: "gpt-5.6-terra", apiKey: "test", baseUrl: "file:///tmp/model" }))
      .toThrow("CODEX_BASE_URL");
  });

  it("starts every conversation with the restricted pure-chat policy", async () => {
    const runtime = createCodexRuntime({ modelId: "gpt-test", apiKey: "test" });

    await expect(runtime.runConversation({
      systemPrompt: "回答农情问题。",
      history: [],
      userMessage: "这块田怎么样？",
    })).resolves.toEqual({ threadId: "thread-1", finalResponse: "已收到" });

    expect(codexMocks.startThread).toHaveBeenCalledWith(expect.objectContaining({
      model: "gpt-test",
      sandboxMode: "read-only",
      approvalPolicy: "never",
      networkAccessEnabled: false,
      webSearchMode: "disabled",
      skipGitRepoCheck: true,
      workingDirectory: resolve(tmpdir(), "chernozem-agent-model-workspace"),
    }));
    expect(codexMocks.run).toHaveBeenCalledWith(expect.stringContaining("本轮只生成自然语言回复"));
  });

  it("passes configured upstream proxies and loopback bypass without forwarding unrelated secrets", () => {
    const prior = { HTTPS_PROXY: process.env.HTTPS_PROXY, NO_PROXY: process.env.NO_PROXY, UNRELATED_SERVICE_KEY: process.env.UNRELATED_SERVICE_KEY };
    try {
      process.env.HTTPS_PROXY = "http://127.0.0.1:10808";
      process.env.NO_PROXY = "localhost,127.0.0.1,::1";
      process.env.UNRELATED_SERVICE_KEY = "unrelated-test-credential";
      createCodexRuntime({ modelId: "gpt-test", apiKey: "test" });
      const config = codexMocks.constructor.mock.calls[0]![0];
      expect(config.env).toMatchObject({ HTTPS_PROXY: "http://127.0.0.1:10808", NO_PROXY: "localhost,127.0.0.1,::1" });
      expect(config.env).not.toHaveProperty("UNRELATED_SERVICE_KEY");
    } finally {
      for (const [key, value] of Object.entries(prior)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  });

  it("rejects a turn if Codex attempts a privileged capability", async () => {
    codexMocks.run.mockResolvedValue({
      items: [{
        id: "command-1",
        type: "command_execution",
        command: "dir",
        aggregated_output: "",
        exit_code: 0,
        status: "completed",
      }],
      finalResponse: "",
      usage: null,
    });
    const runtime = createCodexRuntime({ modelId: "gpt-test", apiKey: "test" });

    await expect(runtime.runConversation({
      systemPrompt: "回答农情问题。",
      history: [],
      userMessage: "读取目录。",
    })).rejects.toThrow("disabled capability: command_execution");
  });

  it("runs structured generation under the same restricted policy", async () => {
    codexMocks.run.mockResolvedValue({
      items: [{ id: "message-1", type: "agent_message", text: "{\"headline\":\"结果\"}" }],
      finalResponse: "{\"headline\":\"结果\"}",
      usage: null,
    });
    const runtime = createCodexRuntime({ modelId: "gpt-test", apiKey: "test" });

    await expect(runtime.runStructured({ systemPrompt: "按契约编辑。", input: { headline: "原文" } }))
      .resolves.toMatchObject({ finalResponse: "{\"headline\":\"结果\"}" });
    expect(codexMocks.startThread).toHaveBeenLastCalledWith(expect.objectContaining({
      sandboxMode: "read-only",
      approvalPolicy: "never",
      networkAccessEnabled: false,
      webSearchMode: "disabled",
    }));
    expect(codexMocks.run).toHaveBeenLastCalledWith(expect.stringContaining("只输出一个符合 system prompt 契约的 JSON 对象"), undefined);
  });

  it("uses native task MCP and disables coding capabilities before starting the model", async () => {
    codexMocks.run.mockResolvedValue({ items: [{ type: "mcp_tool_call", server: "task_evidence", tool: "read_analysis_result" }], finalResponse: "{}" });
    const runtime = createCodexRuntime({ modelId: "gpt-test", apiKey: "test" });
    const evidenceSource = { url: "http://127.0.0.1:34567/mcp", token: "a".repeat(64), tools: ["read_analysis_result"] };
    await runtime.runStructured({ systemPrompt: "分析", input: {}, evidenceSource });
    expect(codexMocks.constructor).toHaveBeenLastCalledWith(expect.objectContaining({
      env: expect.objectContaining({ CHERNOZEM_EVIDENCE_TOKEN: evidenceSource.token }),
      config: { project_doc_max_bytes: 0, features: { shell_tool: false, unified_exec: false, apply_patch_freeform: false },
        mcp_servers: { task_evidence: { url: evidenceSource.url, bearer_token_env_var: "CHERNOZEM_EVIDENCE_TOKEN", enabled_tools: evidenceSource.tools, required: true, default_tools_approval_mode: "approve" } } },
    }));
    expect(codexMocks.run).toHaveBeenLastCalledWith(expect.stringContaining("task_evidence MCP"), undefined);
    expect(codexMocks.run.mock.calls[0]?.[0]).not.toContain(evidenceSource.token);
  });

  it.each([
    ["unregistered tool", "task_evidence", "execute_sql"],
    ["another server", "foreign_server", "read_analysis_result"],
  ])("rejects %s in structured investigation", async (_label, server, tool) => {
    codexMocks.run.mockResolvedValue({ items: [{ type: "mcp_tool_call", server, tool }], finalResponse: "{}" });
    const runtime = createCodexRuntime({ modelId: "gpt-test", apiKey: "test" });
    await expect(runtime.runStructured({ systemPrompt: "分析", input: {}, evidenceSource: {
      url: "http://127.0.0.1:34567/mcp", token: "a".repeat(64), tools: ["read_analysis_result"],
    } })).rejects.toThrow("disabled capability: mcp_tool_call");
  });

  it.each(["https://example.org/mcp", "http://127.0.0.1:34567/other", "http://user@127.0.0.1:34567/mcp", "http://127.0.0.1:34567/mcp?q=1"])("rejects an unscoped endpoint %s", async (url) => {
    const runtime = createCodexRuntime({ modelId: "gpt-test", apiKey: "test" });
    await expect(runtime.runStructured({ systemPrompt: "分析", input: {}, evidenceSource: { url, token: "a".repeat(64), tools: [] } })).rejects.toThrow("Invalid task evidence MCP endpoint");
    expect(codexMocks.startThread).not.toHaveBeenCalled();
  });

  it("passes structured generation cancellation to the SDK", async () => {
    const runtime = createCodexRuntime({ modelId: "gpt-test", apiKey: "test" });
    const controller = new AbortController();
    await runtime.runStructured({ systemPrompt: "生成文档。", input: {}, signal: controller.signal });
    expect(codexMocks.run).toHaveBeenLastCalledWith(expect.any(String), { signal: controller.signal });
  });
});
