import type { AnalysisNextAction, AnalysisTask } from "@chernozem/contracts";

export type WorkflowActionKind = "edit_field" | "new_analysis" | "open_data" | "rerun" | "inspect_task_zone" | "record_field_note";

export interface WorkflowPrimaryAction {
  action: AnalysisNextAction;
  kind: WorkflowActionKind;
}

const TASK_INSPECTION_ACTIONS = new Set([
  "add_field_note",
  "inspect_frost_risk",
  "inspect_growth_zones",
  "inspect_radar_change_zones",
  "inspect_waterlogging_zones",
  "verify_candidate_cause",
]);

const FIELD_NOTE_ACTIONS = new Set([
  "record_growth_observation",
  "record_waterlogging_event",
]);

export function workflowPrimaryAction(task: AnalysisTask): WorkflowPrimaryAction | null {
  const action = task.nextActions[0];
  if (!action) return null;
  if (action.code === "add_planting_date" || action.code === "fix_planting_date") {
    return { action, kind: "edit_field" };
  }
  if (action.code === "select_reference_period") return { action, kind: "new_analysis" };
  if (action.code.startsWith("retry_")) return { action, kind: "rerun" };
  if (TASK_INSPECTION_ACTIONS.has(action.code)) return { action, kind: "inspect_task_zone" };
  if (FIELD_NOTE_ACTIONS.has(action.code)) return { action, kind: "record_field_note" };
  return { action, kind: "open_data" };
}

export function workflowActionButtonLabel(primary: WorkflowPrimaryAction): string {
  if (primary.kind === "edit_field") return primary.action.code === "fix_planting_date" ? "核对播种日期" : "补充播种日期";
  if (primary.kind === "new_analysis") return "选择分析时段";
  if (primary.kind === "rerun") return "重新分析";
  if (primary.kind === "record_field_note") return "记录巡田";
  if (primary.kind === "inspect_task_zone") return "记录核查";
  if (/weather/.test(primary.action.code)) return "补充天气";
  if (/radar/.test(primary.action.code)) return "补充雷达影像";
  if (/optical/.test(primary.action.code)) return "补充光学影像";
  if (primary.action.code === "continue_monitoring" || primary.action.code === "monitor_supported_zone") return "查看新影像";
  return "补充数据";
}
