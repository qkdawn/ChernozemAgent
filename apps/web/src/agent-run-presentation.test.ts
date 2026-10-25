import { describe, expect, it } from "vitest";

import { agentToolLabel, agentToolStatusLabel } from "./agent-run-presentation.js";

describe("agent run presentation", () => {
  it("uses user-facing labels for registered analysis tools", () => {
    expect(agentToolLabel("analyze_optical_condition")).toBe("读取光学田况");
    expect(agentToolLabel("assess_water_nitrogen_evidence")).toBe("形成水氮判断");
    expect(agentToolLabel("detect_waterlogging")).toBe("识别疑似积水");
  });

  it("does not expose unknown internal tool names", () => {
    expect(agentToolLabel("internal_tool_with_sensitive_name")).toBe("执行分析步骤");
  });

  it("translates stable run states", () => {
    expect(agentToolStatusLabel("running")).toBe("进行中");
    expect(agentToolStatusLabel("completed")).toBe("已完成");
    expect(agentToolStatusLabel("failed")).toBe("未完成");
  });
});
