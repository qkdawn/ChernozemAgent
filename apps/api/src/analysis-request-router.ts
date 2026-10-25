import { routeAnalysisRequest, type AgentAnalysisPeriod, type AnalysisRequestPlan } from "@chernozem/agent-runtime";
import type { FieldSummary } from "@chernozem/contracts";

export interface AnalysisRequestRouter {
  route(input: { field: FieldSummary; message: string; periodHint?: AgentAnalysisPeriod }): Promise<AnalysisRequestPlan>;
}

export function createAnalysisRequestRouter(): AnalysisRequestRouter {
  return {
    route({ field, message, periodHint }) {
      return routeAnalysisRequest({
        field: { name: field.name, crop: "corn", seasonYear: field.seasonYear, plantingDate: field.plantingDate },
        message,
        ...(periodHint ? { periodHint } : {}),
      });
    },
  };
}

export const createDeterministicAnalysisRequestRouter = createAnalysisRequestRouter;
