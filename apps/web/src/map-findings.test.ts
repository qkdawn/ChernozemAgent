import type { AnalysisFinding, AnalysisTask } from "@chernozem/contracts";
import { describe, expect, it } from "vitest";

import { mapFindingsForLayer } from "./map-findings.js";

const spatialFinding = (id: string, sourceDates: string[]): AnalysisFinding => ({
  id,
  title: id,
  summary: id,
  severity: "watch",
  areaHa: null,
  sourceDates,
  zone: [{ longitude: 123.8, latitude: 42.3 }, { longitude: 123.81, latitude: 42.3 }, { longitude: 123.8, latitude: 42.31 }],
});

const task = {
  id: "task-current",
  findings: [
    spatialFinding("current-zone", ["2026-07-31"]),
    spatialFinding("comparison-zone", ["2026-07-16"]),
    { ...spatialFinding("undated-zone", []), sourceDates: [] },
    { ...spatialFinding("summary", ["2026-07-31"]), zone: null },
  ],
} as AnalysisTask;

describe("mapFindingsForLayer", () => {
  it("shows only spatial findings for the active observation date", () => {
    expect(mapFindingsForLayer(task, { taskId: task.id, date: "2026-07-16" }).map((finding) => finding.id)).toEqual(["comparison-zone", "undated-zone"]);
  });

  it("does not overlay findings on a layer from another task", () => {
    expect(mapFindingsForLayer(task, { taskId: "task-other", date: "2026-07-31" })).toEqual([]);
  });

  it("keeps the task's spatial findings on the basemap or a static context layer", () => {
    expect(mapFindingsForLayer(task, null).map((finding) => finding.id)).toEqual(["current-zone", "comparison-zone", "undated-zone"]);
    expect(mapFindingsForLayer(task, { date: "static" }).map((finding) => finding.id)).toEqual(["current-zone", "comparison-zone", "undated-zone"]);
  });
});
