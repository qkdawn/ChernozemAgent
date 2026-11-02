import type { AnalysisBrief } from "@chernozem/contracts";

export interface AnalysisBriefVisibleSections {
  showDiagnosticReport: boolean;
  showOverview: boolean;
  showReasoning: boolean;
  showActions: boolean;
  showDocument: boolean;
  showEvidence: boolean;
}

export function analysisBriefVisibleSections(brief: AnalysisBrief): AnalysisBriefVisibleSections {
  const showDiagnosticReport = Boolean(brief.diagnosticReport);
  return {
    showDiagnosticReport,
    showOverview: !showDiagnosticReport && Boolean(brief.overview.trim()),
    showReasoning: !showDiagnosticReport && Boolean(brief.reasoning.trim()),
    showActions: !showDiagnosticReport && brief.actions.length > 0,
    showDocument: !showDiagnosticReport && Boolean(brief.document),
    showEvidence: brief.evidence.length > 0,
  };
}
