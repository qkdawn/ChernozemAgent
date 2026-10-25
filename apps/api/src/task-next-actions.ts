import type { AnalysisNextAction, AnalysisTask, AnalysisTimeRange } from "@chernozem/contracts";

import { OBJECTIVE_DATA_PROFILE } from "./data-profiles.js";

const LATEST_OPTICAL_ACTIONS = new Set([
  "collect_recent_optical_data",
  "continue_monitoring",
  "monitor_supported_zone",
  "wait_for_new_optical",
]);

export function attachTaskAcquisitionRequests(task: AnalysisTask, actions: AnalysisNextAction[]): AnalysisNextAction[] {
  return actions.map((action) => {
    if (action.acquisitionRequest || !requiresAcquisition(action.code) || task.boundaryVersion === undefined) return action;
    return {
      ...action,
      acquisitionRequest: {
        fieldId: task.fieldId,
        boundaryVersion: task.boundaryVersion,
        dataProfile: OBJECTIVE_DATA_PROFILE[task.objective],
        period: LATEST_OPTICAL_ACTIONS.has(action.code) ? latestWindow(task) : task.timeRange,
      },
    };
  });
}

function requiresAcquisition(code: string): boolean {
  return code.startsWith("collect_")
    || code.startsWith("redownload_")
    || LATEST_OPTICAL_ACTIONS.has(code);
}

function latestWindow(task: AnalysisTask): AnalysisTimeRange {
  const candidateEnd = task.completedAt ?? task.timeRange.end;
  const end = Date.parse(candidateEnd) >= Date.parse(task.timeRange.end) ? candidateEnd : task.timeRange.end;
  const parsedEnd = Date.parse(end);
  if (!Number.isFinite(parsedEnd)) return task.timeRange;
  return {
    start: new Date(parsedEnd - 30 * 86_400_000).toISOString(),
    end: new Date(parsedEnd).toISOString(),
  };
}
