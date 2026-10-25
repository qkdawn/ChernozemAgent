import type { AnalysisFinding, AnalysisTask } from "@chernozem/contracts";

interface DatedMapLayer {
  date: string;
  taskId?: string;
}

export function mapFindingsForLayer(task: AnalysisTask | null, layer: DatedMapLayer | null): AnalysisFinding[] {
  if (!task) return [];
  const spatial = task.findings.filter((finding) => finding.zone !== null);
  if (!layer || layer.date === "static") return spatial;
  if (layer.taskId && layer.taskId !== task.id) return [];
  return spatial.filter((finding) => finding.sourceDates.length === 0 || finding.sourceDates.includes(layer.date));
}
