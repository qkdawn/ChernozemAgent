import type { AnalysisObjective, AnalysisTask, ConversationWorkflowStatusResult, TaskStatus } from "@chernozem/contracts";

import type { AnalysisTaskStore } from "./task-store.js";

const OBJECTIVE_LABELS: Record<AnalysisObjective, string> = {
  growth_stage_monitoring: "长势巡检",
  water_nitrogen_diagnosis: "水氮排查",
  waterlogging_detection: "积水识别",
  frost_risk_warning: "霜冻预警",
};

export class WorkflowStatusService {
  constructor(
    private readonly tasks: Pick<AnalysisTaskStore, "list">,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async get(input: { fieldId: string; objective: AnalysisObjective | null }): Promise<ConversationWorkflowStatusResult> {
    const task = (await this.tasks.list(input.fieldId, 50)).find((candidate) => !input.objective || candidate.objective === input.objective) ?? null;
    if (!task) {
      const target = input.objective ? `${OBJECTIVE_LABELS[input.objective]}任务` : "分析任务";
      return {
        tool: "get_workflow_status",
        status: "not_found",
        fieldId: input.fieldId,
        requestedObjective: input.objective,
        checkedAt: this.now().toISOString(),
        task: null,
        message: `这块农田还没有${target}。`,
      };
    }

    return {
      tool: "get_workflow_status",
      status: "found",
      fieldId: input.fieldId,
      requestedObjective: input.objective,
      checkedAt: this.now().toISOString(),
      task: {
        id: task.id,
        objective: task.objective,
        status: task.status,
        progress: task.progress,
        stage: task.stage,
        createdAt: task.createdAt,
        completedAt: task.completedAt,
        summary: task.summary,
        nextActions: task.nextActions.map((action) => action.label),
        failure: task.failure,
      },
      message: statusMessage(task),
    };
  }
}

function statusMessage(task: AnalysisTask): string {
  const label = OBJECTIVE_LABELS[task.objective];
  const detail = compactDetail(task);
  const status: Record<TaskStatus, string> = {
    planned: `${label}任务已经创建，正在等待运行。`,
    running: `${label}正在运行：${task.stage}，进度 ${Math.round(task.progress)}%。`,
    needs_input: `${label}正在等待补充信息。`,
    needs_data: `${label}正在等待观测数据。`,
    needs_review: `${label}已经形成候选结果，正在等待专业复核。`,
    partial: `${label}已经完成受限分析。`,
    completed: `${label}已经完成。`,
    failed: `${label}本次未完成。`,
    cancelled: `${label}已经取消。`,
  };
  return `${status[task.status]}${detail ? ` ${detail}` : ""}`;
}

function compactDetail(task: AnalysisTask): string | null {
  if (task.status === "failed" && task.failure?.message) return task.failure.message;
  if (task.summary?.trim()) return task.summary.trim();
  if (task.nextActions[0]?.label && (task.status === "needs_input" || task.status === "needs_data" || task.status === "needs_review" || task.status === "partial")) {
    return `下一步：${task.nextActions[0].label}。`;
  }
  return null;
}
