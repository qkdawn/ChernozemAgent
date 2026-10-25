import type { AnalysisObjective, AnalysisResult, AnalysisToolName } from "@chernozem/contracts";

export type ControlledToolName = AnalysisToolName;

export interface ControlledAnalysisTool {
  readonly name: ControlledToolName;
  execute(input: { taskId: string }): Promise<AnalysisResult<unknown>>;
}

export interface CornSkillRunHooks {
  beforeTool?(name: ControlledToolName): void | Promise<void>;
  afterTool?(name: ControlledToolName, result: AnalysisResult<unknown>): void | Promise<void>;
}

export interface CornSkillDefinition {
  objective: AnalysisObjective;
  tools: ControlledToolName[];
  completionKind: AnalysisResult<unknown>["kind"];
  completionTool: ControlledToolName;
  completionPrerequisites: ControlledToolName[];
  instruction: string;
}

export const CORN_SKILLS: Record<AnalysisObjective, CornSkillDefinition> = {
  growth_stage_monitoring: {
    objective: "growth_stage_monitoring",
    tools: ["analyze_optical_condition", "estimate_crop_stage", "assess_growth_status"],
    completionKind: "assessment",
    completionTool: "assess_growth_status",
    completionPrerequisites: ["analyze_optical_condition", "estimate_crop_stage"],
    instruction: "先读取光学时序，再估计生育期，最后评估长势；不得用单期影像补造历史变化。",
  },
  water_nitrogen_diagnosis: {
    objective: "water_nitrogen_diagnosis",
    tools: [
      "analyze_optical_condition",
      "estimate_crop_stage",
      "analyze_radar_change",
      "analyze_weather_event",
      "analyze_terrain_susceptibility",
      "get_soil_background",
      "assess_water_nitrogen_evidence",
    ],
    completionKind: "assessment",
    completionTool: "assess_water_nitrogen_evidence",
    completionPrerequisites: ["analyze_optical_condition"],
    instruction: "先定位光谱差异，再按需读取生育期、雷达、天气、地形、土壤和现场证据，最后形成水氮证据判断；证据不足时只给核查方向。",
  },
  waterlogging_detection: {
    objective: "waterlogging_detection",
    tools: ["analyze_radar_change", "analyze_weather_event", "analyze_terrain_susceptibility", "detect_waterlogging"],
    completionKind: "assessment",
    completionTool: "detect_waterlogging",
    completionPrerequisites: ["analyze_radar_change", "analyze_weather_event"],
    instruction: "先读取可比雷达变化和关联降雨，地形只用于核查排序，最后识别疑似积水；缺少灾前灾后可比雷达时明确返回缺口。",
  },
  frost_risk_warning: {
    objective: "frost_risk_warning",
    tools: ["analyze_weather_event", "analyze_terrain_susceptibility", "estimate_crop_stage", "assess_frost_risk"],
    completionKind: "assessment",
    completionTool: "assess_frost_risk",
    completionPrerequisites: ["analyze_weather_event", "estimate_crop_stage"],
    instruction: "读取最新低温预报、生育期和地形易发性，最后评估未来霜冻风险；不得把预测写成已发生灾害。",
  },
};

export class CornSkillRunner {
  private readonly tools: Map<ControlledToolName, ControlledAnalysisTool>;

  constructor(tools: ControlledAnalysisTool[]) {
    this.tools = new Map(tools.map((tool) => [tool.name, tool]));
  }

  async run(objective: AnalysisObjective, taskId: string, hooks: CornSkillRunHooks = {}): Promise<AnalysisResult<unknown>[]> {
    const skill = CORN_SKILLS[objective];
    const missing = skill.tools.filter((name) => !this.tools.has(name));
    if (missing.length) throw new Error(`Skill ${objective} 缺少受控工具：${missing.join(", ")}`);

    const results: AnalysisResult<unknown>[] = [];
    for (const name of skill.tools) {
      const tool = this.tools.get(name);
      if (!tool) continue;
      await hooks.beforeTool?.(name);
      const result = await tool.execute({ taskId });
      if (result.taskId !== taskId) throw new Error(`工具 ${name} 返回了其他任务的结果。`);
      if (result.execution.toolName !== name) throw new Error(`工具 ${name} 返回了 ${result.execution.toolName} 的执行记录。`);
      results.push(result);
      await hooks.afterTool?.(name, result);
    }
    if (results.at(-1)?.kind !== skill.completionKind) throw new Error(`Skill ${objective} 没有生成完成结果。`);
    return results;
  }
}
