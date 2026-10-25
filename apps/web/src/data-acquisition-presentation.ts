import type { CreateDataAcquisitionRequest, DataAcquisitionRun, FieldSummary } from "@chernozem/contracts";

type FieldAcquisitionScope = Pick<FieldSummary, "id" | "boundaryVersion">;

export function acquisitionRequestForField(
  field: FieldAcquisitionScope,
  plannedRequest: CreateDataAcquisitionRequest | null,
  now = new Date(),
): CreateDataAcquisitionRequest {
  if (plannedRequest) {
    if (plannedRequest.fieldId !== field.id || plannedRequest.boundaryVersion !== field.boundaryVersion) {
      throw new Error("采集计划与当前地块或边界版本不一致，请重新发起分析。");
    }
    return plannedRequest;
  }

  const start = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  return {
    fieldId: field.id,
    boundaryVersion: field.boundaryVersion,
    dataProfile: "field_baseline_v1",
    period: { start: start.toISOString(), end: now.toISOString() },
  };
}

export function acquisitionProgressSummary(run: DataAcquisitionRun | null, fallbackSourceCount: number) {
  const progressBySource = new Map(run?.progress.map((item) => [item.source, item]) ?? []);
  const sourceCount = progressBySource.size || fallbackSourceCount;
  const finishedCount = [...progressBySource.values()]
    .filter((item) => item.stage === "completed" || item.stage === "failed").length;

  return {
    sourceCount,
    finishedCount,
    fraction: sourceCount === 0 ? 0 : finishedCount / sourceCount,
  };
}

export function acquisitionReadyForRequest(
  run: DataAcquisitionRun | null,
  request: CreateDataAcquisitionRequest | null,
): boolean {
  if (!run || !request || (run.status !== "completed" && run.status !== "partial")) return false;
  return run.fieldId === request.fieldId
    && run.boundaryVersion === request.boundaryVersion
    && run.dataProfile === request.dataProfile
    && sameInstant(run.period.start, request.period.start)
    && sameInstant(run.period.end, request.period.end);
}

function sameInstant(left: string, right: string): boolean {
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  return Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime === rightTime;
}
