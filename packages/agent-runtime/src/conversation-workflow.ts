import type { AnalysisObjective, ConversationWorkflowPlan, FieldSummary } from "@chernozem/contracts";

import { routeAnalysisRequest } from "./analysis-request-router.js";

const ACTION_INTENT = /帮我|分析|看看|看下|查一下|检查|诊断|识别|评估|预警|监测|运行|开始/;
const WORKFLOW_SUBJECT = /长势|长得|水氮|缺氮|缺水|肥水|叶色|积水|内涝|暴雨|涝|霜冻|寒潮|降温|低温/;
const STATUS_INTENT = /进度|(?:任务|工作流|分析|监测|诊断|识别|预警).{0,8}状态|状态.{0,8}(?:任务|工作流|分析|监测|诊断|识别|预警)|跑到哪|做到哪|分析到哪|完成了吗|完了吗|结束了吗|好了吗|还在跑|运行到|结果出来/;
const STATUS_CONTEXT = /任务|工作流|分析|监测|诊断|识别|预警|刚才|上次|那个/;
const RESULT_INTENT = /结果|结论|发现|依据|证据|数据来源|为什么.{0,8}判断|限制|不确定|数据问题|缺什么|可靠|下一步|怎么办|怎么处理|先去哪里|哪里|位置|区域|地图|范围|面积/;
const RESULT_CONTEXT = /任务|分析|监测|诊断|识别|预警|刚才|上次|这次|本次|那个|当前地块|这块地/;
const STANDALONE_NEXT_ACTION = /^\s*下一步(?:该)?(?:怎么办|怎么做|做什么|呢)?[？?。！!\s]*$/;
const FIELD_REFERENCE = /当前地块|这块地|这个地块|当前农田|这块田|这个田|地块/;
const FIELD_PROFILE_INTENT = /多大|面积|作物|种的什么|种植季|哪年|播种|品种|基本资料|地块资料|地块档案/;
const FIELD_DATA_INTENT = /(?:数据|采集|影像).{0,8}(?:状态|情况|有什么|有哪些|齐|全|够不够|准备)|(?:有什么|有哪些).{0,4}(?:数据|影像)|资料.{0,3}(?:齐|全)|数据状态/;
const FIELD_TASK_CONTEXT = /最近|上次|历史/;
const FIELD_TASK_SUBJECT = /任务|工作流|分析/;
const FIELD_TASK_INTENT = /哪些|什么|做过|跑过|记录/;

const WORKFLOWS = {
  growth_stage_monitoring: {
    title: "长势巡检",
    summary: "对比本季观测，定位田内偏弱位置并生成巡田重点。",
    steps: ["读取观测", "定位差异", "生成行动"] as [string, string, string],
  },
  water_nitrogen_diagnosis: {
    title: "水氮排查",
    summary: "先定位田内差异，再用独立证据和现场对照逐步排查原因。",
    steps: ["定位差异", "核对证据", "安排对照"] as [string, string, string],
  },
  waterlogging_detection: {
    title: "积水识别",
    summary: "对比降雨前后观测，识别疑似积水范围并安排核查。",
    steps: ["对比雷达", "识别范围", "排列优先级"] as [string, string, string],
  },
  frost_risk_warning: {
    title: "霜冻预警",
    summary: "结合最新低温预报、生育期和地形识别未来风险。",
    steps: ["读取预报", "结合生育期", "形成风险区"] as [string, string, string],
  },
} as const;

export async function planConversationWorkflow(field: FieldSummary, message: string): Promise<ConversationWorkflowPlan | null> {
  if (parseWorkflowStatusQuery(message) || parseTaskResultQuery(message) || parseFieldContextQuery(message)) return null;
  if (!ACTION_INTENT.test(message) || !WORKFLOW_SUBJECT.test(message)) return null;
  const routed = await routeAnalysisRequest({
    field: { name: field.name, crop: "corn", seasonYear: field.seasonYear, plantingDate: field.plantingDate },
    message,
  });
  const workflow = WORKFLOWS[routed.objective];
  const needsPlantingDate = (routed.objective === "growth_stage_monitoring" || routed.objective === "frost_risk_warning") && !field.plantingDate;
  return {
    objective: routed.objective,
    period: routed.period,
    title: workflow.title,
    summary: workflow.summary,
    steps: workflow.steps,
    missingInputs: needsPlantingDate ? ["播种日期"] : [],
    startRequest: {
      fieldId: field.id,
      crop: field.crop,
      period: routed.period,
      objective: routed.objective,
      message: message.trim(),
    },
    requiresConfirmation: true,
  };
}

export interface WorkflowStatusQuery {
  objective: AnalysisObjective | null;
}

export type TaskResultFocus = "summary" | "locations" | "evidence" | "limitations" | "actions";

export interface TaskResultQuery {
  objective: AnalysisObjective | null;
  focus: TaskResultFocus;
}

export type FieldContextFocus = "summary" | "profile" | "data" | "recent_tasks";

export interface FieldContextQuery {
  focus: FieldContextFocus;
}

export function parseWorkflowStatusQuery(message: string): WorkflowStatusQuery | null {
  if (!STATUS_INTENT.test(message) || (!STATUS_CONTEXT.test(message) && !WORKFLOW_SUBJECT.test(message))) return null;
  return { objective: statusObjective(message) };
}

export function parseTaskResultQuery(message: string): TaskResultQuery | null {
  if (!RESULT_INTENT.test(message)) return null;
  if (!RESULT_CONTEXT.test(message) && !STANDALONE_NEXT_ACTION.test(message) && !(/结果|结论/.test(message) && WORKFLOW_SUBJECT.test(message))) return null;
  return { objective: statusObjective(message), focus: resultFocus(message) };
}

export function parseFieldContextQuery(message: string): FieldContextQuery | null {
  if (FIELD_TASK_CONTEXT.test(message) && FIELD_TASK_SUBJECT.test(message) && FIELD_TASK_INTENT.test(message)) return { focus: "recent_tasks" };
  if (FIELD_DATA_INTENT.test(message) && (FIELD_REFERENCE.test(message) || /^(?:现在|目前|当前)?(?:有|还?有|数据)/.test(message.trim()))) return { focus: "data" };
  if (FIELD_REFERENCE.test(message) && FIELD_PROFILE_INTENT.test(message)) return { focus: "profile" };
  if (FIELD_REFERENCE.test(message) && /概况|整体情况|资料怎么样/.test(message)) return { focus: "summary" };
  return null;
}

function resultFocus(message: string): TaskResultFocus {
  if (/依据|证据|数据来源|为什么.{0,8}判断/.test(message)) return "evidence";
  if (/限制|不确定|数据问题|缺什么|可靠/.test(message)) return "limitations";
  if (/下一步|怎么办|怎么处理|先去哪里|核查|巡田/.test(message)) return "actions";
  if (/哪里|位置|区域|地图|范围|面积/.test(message)) return "locations";
  return "summary";
}

function statusObjective(message: string): AnalysisObjective | null {
  if (/积水|内涝|暴雨|涝/.test(message)) return "waterlogging_detection";
  if (/霜冻|寒潮|降温|低温/.test(message)) return "frost_risk_warning";
  if (/水氮|缺氮|缺水|肥水|叶色/.test(message)) return "water_nitrogen_diagnosis";
  if (/长势|长得/.test(message)) return "growth_stage_monitoring";
  return null;
}
