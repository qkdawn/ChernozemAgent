import type { AnalysisObjective } from "@chernozem/contracts";

export type AgentAnalysisPeriod = "last_30_days" | "this_season";

export interface AnalysisRequestPlan {
  objective: AnalysisObjective;
  period: AgentAnalysisPeriod;
}

export interface RouteAnalysisRequestOptions {
  field: {
    name: string;
    crop: "corn";
    seasonYear: number;
    plantingDate: string | null;
  };
  message: string;
  periodHint?: AgentAnalysisPeriod;
}

export async function routeAnalysisRequest(options: RouteAnalysisRequestOptions): Promise<AnalysisRequestPlan> {
  const objective = selectObjective(options.message);
  return {
    objective,
    period: objective === "frost_risk_warning"
      ? "last_30_days"
      : /本季|生长季|种植季/.test(options.message)
        ? "this_season"
        : options.periodHint ?? "last_30_days",
  };
}

function selectObjective(message: string): AnalysisObjective {
  if (/霜冻|寒潮|降温|低温/.test(message)) return "frost_risk_warning";
  if (/积水|内涝|暴雨|涝/.test(message)) return "waterlogging_detection";
  if (/水氮|缺氮|缺水|肥水|叶色/.test(message)) return "water_nitrogen_diagnosis";
  return "growth_stage_monitoring";
}
