import type { AnalysisBrief } from "@chernozem/contracts";

export interface AnalysisBriefVisibleSections {
  showOverview: boolean;
  showReasoning: boolean;
  showActions: boolean;
  showDocument: boolean;
  showEvidence: boolean;
}

export function analysisBriefVisibleSections(brief: AnalysisBrief): AnalysisBriefVisibleSections {
  return {
    showOverview: Boolean(brief.overview.trim()),
    showReasoning: Boolean(brief.reasoning.trim()),
    showActions: brief.actions.length > 0,
    showDocument: Boolean(brief.document),
    showEvidence: brief.evidence.length > 0,
  };
}
