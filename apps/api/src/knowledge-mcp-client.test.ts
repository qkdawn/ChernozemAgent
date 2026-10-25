import { describe, expect, it } from "vitest";

import { parseKnowledgeSearchResult } from "./knowledge-mcp-client.js";

describe("knowledge MCP client result", () => {
  it("accepts the stable structured result", () => {
    expect(parseKnowledgeSearchResult({
      status: "no_matches",
      indexRunRef: "index-001",
      answer: null,
      matches: [],
      limitations: ["没有适用材料。"],
      error: null,
    })).toMatchObject({ status: "no_matches", indexRunRef: "index-001" });
  });

  it("rejects an untyped MCP payload", () => {
    expect(() => parseKnowledgeSearchResult({ status: "ok", matches: {} })).toThrow("无效结果");
  });
});
