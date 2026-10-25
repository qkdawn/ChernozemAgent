import type { CreateDataAcquisitionRequest, DataAcquisitionRun } from "@chernozem/contracts";
import { describe, expect, it } from "vitest";

import { acquisitionProgressSummary, acquisitionReadyForRequest, acquisitionRequestForField } from "./data-acquisition-presentation.js";

describe("data acquisition presentation", () => {
  it("uses the backend task plan unchanged for a matching field boundary", () => {
    const planned: CreateDataAcquisitionRequest = {
      fieldId: "field-1",
      boundaryVersion: 3,
      dataProfile: "growth_stage_v1",
      period: { start: "2026-08-01T00:00:00.000Z", end: "2026-08-18T23:59:59.999Z" },
    };

    expect(acquisitionRequestForField({ id: "field-1", boundaryVersion: 3 }, planned)).toBe(planned);
  });

  it("uses the six-source baseline only when no task plan is present", () => {
    expect(acquisitionRequestForField(
      { id: "field-1", boundaryVersion: 3 },
      null,
      new Date("2026-08-19T08:00:00.000Z"),
    )).toEqual({
      fieldId: "field-1",
      boundaryVersion: 3,
      dataProfile: "field_baseline_v1",
      period: { start: "2026-07-20T08:00:00.000Z", end: "2026-08-19T08:00:00.000Z" },
    });
  });

  it("rejects a stale task plan after the field boundary changes", () => {
    const planned: CreateDataAcquisitionRequest = {
      fieldId: "field-1",
      boundaryVersion: 2,
      dataProfile: "growth_stage_v1",
      period: { start: "2026-08-01T00:00:00.000Z", end: "2026-08-18T23:59:59.999Z" },
    };

    expect(() => acquisitionRequestForField({ id: "field-1", boundaryVersion: 3 }, planned))
      .toThrow("采集计划与当前地块或边界版本不一致");
  });

  it("counts only sources in the active task profile", () => {
    const run = acquisitionRun([
      { source: "sentinel-2", stage: "downloading", message: "正在下载", updatedAt: "2026-08-19T08:00:00.000Z" },
    ]);

    expect(acquisitionProgressSummary(run, 6)).toEqual({ sourceCount: 1, finishedCount: 0, fraction: 0 });
    run.progress[0]!.stage = "completed";
    expect(acquisitionProgressSummary(run, 6)).toEqual({ sourceCount: 1, finishedCount: 1, fraction: 1 });
  });

  it("enables re-analysis only for the completed matching task plan", () => {
    const request: CreateDataAcquisitionRequest = {
      fieldId: "field-1",
      boundaryVersion: 3,
      dataProfile: "growth_stage_v1",
      period: { start: "2026-08-01T00:00:00.000Z", end: "2026-08-18T23:59:59.999Z" },
    };
    const run = acquisitionRun([]);
    run.status = "partial";

    expect(acquisitionReadyForRequest(run, request)).toBe(true);
    expect(acquisitionReadyForRequest({ ...run, dataProfile: "field_baseline_v1" }, request)).toBe(false);
    expect(acquisitionReadyForRequest({ ...run, status: "failed" }, request)).toBe(false);
  });
});

function acquisitionRun(progress: DataAcquisitionRun["progress"]): DataAcquisitionRun {
  return {
    id: "run-1",
    fieldId: "field-1",
    boundaryVersion: 3,
    period: { start: "2026-08-01T00:00:00.000Z", end: "2026-08-18T23:59:59.999Z" },
    dataProfile: "growth_stage_v1",
    dataProfileVersion: "1",
    status: "running",
    createdAt: "2026-08-19T08:00:00.000Z",
    completedAt: null,
    manifestVersion: "1.3",
    sources: [],
    progress,
  };
}
