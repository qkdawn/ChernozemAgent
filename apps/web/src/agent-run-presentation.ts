import type { AgentToolRunStatus } from "@chernozem/contracts";

const toolLabels: Record<string, string> = {
  inspect_task_scope: "确认任务范围",
  analyze_optical_condition: "读取光学田况",
  estimate_crop_stage: "估计生育期",
  assess_growth_status: "形成长势判断",
  analyze_radar_change: "比较雷达时相",
  analyze_weather_event: "分析天气过程",
  analyze_terrain_susceptibility: "分析地形易发区",
  get_soil_background: "读取土壤背景",
  assess_water_nitrogen_evidence: "形成水氮判断",
  detect_waterlogging: "识别疑似积水",
  assess_frost_risk: "评估霜冻风险",
};

export function agentToolLabel(toolName: string): string {
  return toolLabels[toolName] ?? "执行分析步骤";
}

export function agentToolStatusLabel(status: AgentToolRunStatus): string {
  if (status === "completed") return "已完成";
  if (status === "failed") return "未完成";
  return "进行中";
}
