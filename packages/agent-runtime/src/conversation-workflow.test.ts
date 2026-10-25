import type { FieldSummary } from "@chernozem/contracts";
import { describe, expect, it } from "vitest";

import { parseFieldContextQuery, parseTaskResultQuery, parseWorkflowStatusQuery, planConversationWorkflow } from "./conversation-workflow.js";

describe("planConversationWorkflow", () => {
  it("plans an explicitly requested frost workflow", async () => {
    const plan = await planConversationWorkflow(field(), "帮我看看这块地有没有霜冻风险");
    expect(plan).toMatchObject({
      objective: "frost_risk_warning", requiresConfirmation: true, missingInputs: [],
      startRequest: {
        fieldId: "field-1", crop: "corn", period: "last_30_days", objective: "frost_risk_warning",
        message: "帮我看看这块地有没有霜冻风险",
      },
    });
  });

  it("does not turn a general question into a workflow", async () => {
    await expect(planConversationWorkflow(field(), "霜冻通常是怎么形成的？")).resolves.toBeNull();
  });

  it("surfaces a missing planting date without silently filling it", async () => {
    const plan = await planConversationWorkflow({ ...field(), plantingDate: null }, "分析一下当前长势");
    expect(plan?.missingInputs).toEqual(["播种日期"]);
  });

  it("routes a workflow progress question to the read-only status tool", async () => {
    expect(parseWorkflowStatusQuery("霜冻预警任务完成了吗？")).toEqual({ objective: "frost_risk_warning" });
    await expect(planConversationWorkflow(field(), "霜冻预警任务完成了吗？")).resolves.toBeNull();
  });

  it("uses the latest workflow when a status question does not name an objective", () => {
    expect(parseWorkflowStatusQuery("刚才那个任务跑到哪了？")).toEqual({ objective: null });
    expect(parseWorkflowStatusQuery("当前分析任务是什么状态？")).toEqual({ objective: null });
  });

  it("does not treat a general agronomy question as a workflow status request", () => {
    expect(parseWorkflowStatusQuery("霜冻一般在什么状态下形成？")).toBeNull();
    expect(parseWorkflowStatusQuery("玉米叶片状态不好可能是什么原因？")).toBeNull();
  });

  it("routes task-result questions by requested result facet", () => {
    expect(parseTaskResultQuery("上次长势分析的结论是什么？")).toEqual({ objective: "growth_stage_monitoring", focus: "summary" });
    expect(parseTaskResultQuery("这次积水识别的依据是什么？")).toEqual({ objective: "waterlogging_detection", focus: "evidence" });
    expect(parseTaskResultQuery("刚才分析发现的区域在哪里？")).toEqual({ objective: null, focus: "locations" });
    expect(parseTaskResultQuery("这次任务下一步怎么办？")).toEqual({ objective: null, focus: "actions" });
    expect(parseTaskResultQuery("本次结果有什么限制？")).toEqual({ objective: null, focus: "limitations" });
    expect(parseTaskResultQuery("下一步怎么办？")).toEqual({ objective: null, focus: "actions" });
  });

  it("keeps general agronomy questions outside the task-result tool", () => {
    expect(parseTaskResultQuery("玉米叶片发黄的原因和判断依据是什么？")).toBeNull();
    expect(parseTaskResultQuery("霜冻风险一般有哪些限制因素？")).toBeNull();
  });

  it("routes field profile, data, and task-history questions to field context", () => {
    expect(parseFieldContextQuery("这块地多大，什么时候播种的？")).toEqual({ focus: "profile" });
    expect(parseFieldContextQuery("当前地块有哪些数据？")).toEqual({ focus: "data" });
    expect(parseFieldContextQuery("最近做过什么分析任务？")).toEqual({ focus: "recent_tasks" });
    expect(parseFieldContextQuery("这块地整体情况怎么样？")).toEqual({ focus: "summary" });
  });

  it("keeps general crop questions outside field context", () => {
    expect(parseFieldContextQuery("玉米一般什么时候播种？")).toBeNull();
    expect(parseFieldContextQuery("Sentinel-2 有哪些波段？")).toBeNull();
  });
});

function field(): FieldSummary {
  return {
    id: "field-1", organizationId: "org-1", code: "F-1", name: "一号田", areaHa: 12.4, village: "示范村",
    crop: "corn", seasonYear: 2026, plantingDate: "2026-05-01", variety: null, boundaryVersion: 1, seasonCount: 1,
    centroid: { longitude: 123.8, latitude: 42.3 }, boundary: [], latestStatus: "not_analyzed", latestAnalyzedAt: null,
  };
}
