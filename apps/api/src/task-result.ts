import type { AnalysisBriefAction, AnalysisBriefEvidence, AnalysisObjective, AnalysisTask, ConversationTaskResult, ConversationTaskResultFocus } from "@chernozem/contracts";

import type { AnalysisTaskStore } from "./task-store.js";

const OBJECTIVE_LABELS: Record<AnalysisObjective, string> = {
  growth_stage_monitoring: "长势巡检",
  water_nitrogen_diagnosis: "水氮排查",
  waterlogging_detection: "积水识别",
  frost_risk_warning: "霜冻预警",
};

export class TaskResultService {
  constructor(
    private readonly tasks: Pick<AnalysisTaskStore, "list">,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async get(input: { fieldId: string; objective: AnalysisObjective | null; focus: ConversationTaskResultFocus }): Promise<ConversationTaskResult> {
    const task = (await this.tasks.list(input.fieldId, 50)).find((candidate) => !input.objective || candidate.objective === input.objective) ?? null;
    if (!task) return this.notFound(input);

    const resultTask = publicResult(task);
    const hasPublishedResult = Boolean(task.brief || task.summary?.trim() || task.findings.length || task.analysisResults.length);
    if (!hasPublishedResult) {
      const failure = task.failure?.message ? ` ${task.failure.message}` : "";
      return {
        tool: "get_task_result",
        status: "not_ready",
        fieldId: input.fieldId,
        requestedObjective: input.objective,
        requestedFocus: input.focus,
        checkedAt: this.now().toISOString(),
        task: resultTask,
        message: `${OBJECTIVE_LABELS[task.objective]}还没有形成可读取的结果，当前处于“${task.stage}”。${failure}`.trim(),
      };
    }

    return {
      tool: "get_task_result",
      status: "found",
      fieldId: input.fieldId,
      requestedObjective: input.objective,
      requestedFocus: input.focus,
      checkedAt: this.now().toISOString(),
      task: resultTask,
      message: focusedMessage(resultTask, input.focus),
    };
  }

  private notFound(input: { fieldId: string; objective: AnalysisObjective | null; focus: ConversationTaskResultFocus }): ConversationTaskResult {
    const target = input.objective ? `${OBJECTIVE_LABELS[input.objective]}结果` : "分析结果";
    return {
      tool: "get_task_result",
      status: "not_found",
      fieldId: input.fieldId,
      requestedObjective: input.objective,
      requestedFocus: input.focus,
      checkedAt: this.now().toISOString(),
      task: null,
      message: `这块农田还没有可读取的${target}。`,
    };
  }
}

function publicResult(task: AnalysisTask): NonNullable<ConversationTaskResult["task"]> {
  const evidence: AnalysisBriefEvidence[] = task.brief?.evidence.length
    ? task.brief.evidence
    : task.sources.map((source) => ({
      statement: source.note,
      sourceDates: [{ source: source.source, date: source.observedAt || null }],
    }));
  const actions: AnalysisBriefAction[] = task.brief?.actions.length
    ? task.brief.actions
    : task.nextActions.map((action) => ({
      label: action.label,
      decisionEffect: "若现场核查与当前判断一致，按该区域优先级安排后续；若不一致，补充记录并重新判断原因。",
      where: null,
      timing: null,
      checklist: [],
      ...(action.zoneRef ? { zoneRef: action.zoneRef } : {}),
    }));
  const headline = task.brief?.headline ?? task.summary?.trim() ?? task.failure?.message ?? `${OBJECTIVE_LABELS[task.objective]}尚未形成结论`;
  return {
    id: task.id,
    objective: task.objective,
    status: task.status,
    createdAt: task.createdAt,
    completedAt: task.completedAt,
    headline,
    overview: task.brief?.overview ?? task.summary?.trim() ?? headline,
    reasoning: task.brief?.reasoning ?? "",
    uncertainty: task.brief?.uncertainty ?? (task.limitations.length ? task.limitations.join(" ") : null),
    findings: task.findings.map((finding) => ({
      id: finding.id,
      title: finding.title,
      summary: finding.summary,
      severity: finding.severity,
      areaHa: finding.areaHa,
      sourceDates: finding.sourceDates,
      hasGeometry: Boolean(finding.zone?.length),
    })),
    evidence,
    limitations: task.limitations,
    actions,
  };
}

function focusedMessage(task: NonNullable<ConversationTaskResult["task"]>, focus: ConversationTaskResultFocus): string {
  if (focus === "locations") {
    const located = task.findings.filter((finding) => finding.hasGeometry);
    if (!located.length) return `${task.headline} 当前结果没有标出可定位的地图区域。`;
    return `地图上标出了${located.length}处关注区：${located.slice(0, 3).map((finding) => {
      const area = finding.areaHa === null ? "" : `，约 ${finding.areaHa.toFixed(2)} 公顷`;
      return `${finding.title}${area}：${withoutTerminalPunctuation(finding.summary)}`;
    }).join("；")}。`;
  }
  if (focus === "evidence") {
    const statements = unique(task.evidence.map((item) => evidenceStatement(item))).slice(0, 4);
    return unique([task.reasoning, ...statements]).filter(Boolean).join(" ") || "当前结果没有保存可发布的分析依据。";
  }
  if (focus === "limitations") {
    const limitations = unique([task.uncertainty ?? "", ...task.limitations]).filter(Boolean);
    return limitations.length ? limitations.join(" ") : "当前发布结果没有记录会改变本次结论的数据限制。";
  }
  if (focus === "actions") {
    if (!task.actions.length) return `${task.headline} 当前结果没有新增现场动作。`;
    return `下一步：${task.actions.slice(0, 3).map(actionStatement).join("；")}。`;
  }
  return unique([task.headline, task.overview]).filter(Boolean).join(" ");
}

function evidenceStatement(evidence: AnalysisBriefEvidence): string {
  const dates = unique(evidence.sourceDates.map((item) => item.date ? `${item.source} ${item.date}` : item.source)).filter(Boolean);
  return dates.length ? `${evidence.statement}（${dates.join("、")}）` : evidence.statement;
}

function actionStatement(action: AnalysisBriefAction): string {
  const scope = [action.timing, action.where].filter(Boolean).join("，");
  const checklist = action.checklist.length ? `，检查${action.checklist.join("、")}` : "";
  const purpose = action.purpose ? `，目的是${action.purpose}` : "";
  return `${action.label}${scope ? `（${scope}）` : ""}${purpose}${checklist}`;
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function withoutTerminalPunctuation(value: string): string {
  return value.trim().replace(/[。；！？!?;]+$/u, "");
}
