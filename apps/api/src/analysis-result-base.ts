import type { AnalysisExecution, AnalysisResult, AnalysisTimeRange, DataAcquisitionRun, FieldSummary } from "@chernozem/contracts";
import type { ControlledToolName } from "@chernozem/agent-runtime";
import { createHash } from "node:crypto";

interface AnalysisResultBaseInput {
  taskId: string;
  toolName: ControlledToolName;
  toolVersion: string;
  kind: AnalysisResult<unknown>["kind"];
  field: FieldSummary;
  acquisitions?: DataAcquisitionRun[];
  timeRange?: AnalysisTimeRange | null | undefined;
  inputResults?: Array<Pick<AnalysisResult<unknown>, "id" | "execution">>;
  parameters?: AnalysisExecution["parameters"];
}

export function createAnalysisResultBase(input: AnalysisResultBaseInput) {
  const acquisitionIds = uniqueSorted((input.acquisitions ?? []).map((run) => run.id));
  const assetIds = uniqueSorted((input.acquisitions ?? []).flatMap((run) => run.sources.flatMap((source) => source.selectedAssets.map((asset) => asset.id))));
  const inputResults = [...(input.inputResults ?? [])].sort((left, right) => left.id.localeCompare(right.id));
  const resultIds = uniqueSorted(inputResults.map((result) => result.id));
  const parameters = sortRecord(input.parameters ?? {});
  const scope = {
    fieldId: input.field.id,
    boundaryVersion: input.field.boundaryVersion,
    timeRange: input.timeRange ?? null,
  };
  const fingerprintSource = JSON.stringify({
    toolName: input.toolName,
    toolVersion: input.toolVersion,
    scope,
    inputs: {
      acquisitions: (input.acquisitions ?? []).map((run) => ({ id: run.id, manifestVersion: run.manifestVersion })).sort(byId),
      assets: (input.acquisitions ?? []).flatMap((run) => run.sources.flatMap((source) => source.selectedAssets.map((asset) => ({ id: asset.id, checksum: asset.checksum })))).sort(byId),
      results: inputResults.map((result) => ({ id: result.id, inputFingerprint: result.execution.inputFingerprint })),
    },
    parameters,
  });
  const inputFingerprint = createHash("sha256").update(fingerprintSource).digest("hex");

  return {
    id: deterministicResultId(input.taskId, input.toolName),
    taskId: input.taskId,
    kind: input.kind,
    toolVersion: input.toolVersion,
    createdAt: new Date().toISOString(),
    execution: {
      toolName: input.toolName,
      scope,
      inputs: { acquisitionIds, assetIds, resultIds },
      parameters,
      inputFingerprint,
    } satisfies AnalysisExecution,
  };
}

function deterministicResultId(taskId: string, toolName: ControlledToolName): string {
  const hex = createHash("sha256").update(`${taskId}:${toolName}`).digest("hex").slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8).join("")}-${hex.slice(8, 12).join("")}-${hex.slice(12, 16).join("")}-${hex.slice(16, 20).join("")}-${hex.slice(20).join("")}`;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function sortRecord(record: AnalysisExecution["parameters"]): AnalysisExecution["parameters"] {
  return Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right)));
}

function byId(left: { id: string }, right: { id: string }): number {
  return left.id.localeCompare(right.id);
}
