import type { AnalysisResult } from "@chernozem/contracts";
import { stat } from "node:fs/promises";

import type { AcquisitionStore } from "./acquisition-store.js";
import type { AnalysisResultStore } from "./analysis-store.js";
import { createMemoryAnalysisResultStore } from "./analysis-store.js";
import { GrowthAnalysisService, hasCompleteOpticalAssets, type OpticalRunner } from "./analysis-tools.js";
import { resolveAcquisitionArtifact } from "./data-acquisition.js";
import type { FieldStore } from "./field-store.js";
import type { AnalysisTaskStore } from "./task-store.js";

export async function reanalyzeGrowthOptical(taskId: string, stores: {
  tasks: AnalysisTaskStore;
  results: AnalysisResultStore;
  fields: FieldStore;
  acquisitions: AcquisitionStore;
}, opticalRunner?: OpticalRunner): Promise<{ resultId: string; ndviRef: string; std: number | null }> {
  const task = await stores.tasks.get(taskId);
  if (!task || task.objective !== "growth_stage_monitoring" || task.status === "running") {
    throw new Error("Expected an existing, finished growth task.");
  }
  const field = await stores.fields.get(task.fieldId);
  if (!field || field.boundaryVersion !== task.boundaryVersion) {
    throw new Error("Field authorization or boundary version no longer matches this task.");
  }
  const storedResults = await stores.results.list(taskId);
  const prior = task.analysisResults.find((result) => result.kind === "optical_condition")
    ?? storedResults.find((result) => result.kind === "optical_condition");
  if (!prior?.result || (prior.status !== "succeeded" && prior.status !== "partial")) {
    throw new Error("Task has no successful optical result to backfill.");
  }
  const acquisitionIds = prior.execution.inputs.acquisitionIds;
  if (!acquisitionIds.length) throw new Error("Optical result does not identify its acquisition runs.");
  const acquisitions = await Promise.all(acquisitionIds.map((id) => stores.acquisitions.get(id)));
  if (acquisitions.some((run) => !run || run.fieldId !== field.id || run.boundaryVersion !== task.boundaryVersion)) {
    throw new Error("An original acquisition run is missing or outside the task boundary.");
  }
  const runs = acquisitions.filter((run): run is NonNullable<typeof run> => run !== null);
  const observationRange = prior.execution.scope.timeRange ?? undefined;
  if (!hasCompleteOpticalAssets(runs, observationRange)) throw new Error("No complete local Sentinel-2 asset set exists for this task.");

  const staging = createMemoryAnalysisResultStore();
  const opticalTool = new GrowthAnalysisService(staging, process.env.PYTHON_EXECUTABLE ?? "python", opticalRunner)
    .createTools(field, runs, observationRange)[0]!;
  const refreshed = await opticalTool.execute({ taskId });
  if (!refreshed.result || (refreshed.status !== "succeeded" && refreshed.status !== "partial")) {
    throw new Error(`Optical reanalysis failed: ${refreshed.error?.message ?? refreshed.summary}`);
  }
  type Observation = { observationDate: string; metrics: { ndvi: { mean: number; std?: number } } };
  type OpticalPayload = { current: Observation; observations: Observation[]; zones: unknown[] };
  const oldPayload = prior.result as OpticalPayload;
  const newPayload = refreshed.result as OpticalPayload;
  const oldCurrent = oldPayload.current;
  const newCurrent = newPayload.current;
  const sameObservations = oldPayload.observations.length === newPayload.observations.length
    && oldPayload.observations.every((observation, index) => observation.observationDate === newPayload.observations[index]?.observationDate
      && Math.abs(observation.metrics.ndvi.mean - newPayload.observations[index]!.metrics.ndvi.mean) <= 1e-6);
  if (refreshed.id !== prior.id || oldCurrent?.observationDate !== newCurrent?.observationDate
    || !Number.isFinite(oldCurrent?.metrics?.ndvi?.mean) || !Number.isFinite(newCurrent?.metrics?.ndvi?.mean)
    || !sameObservations || oldPayload.zones.length !== newPayload.zones.length) {
    throw new Error("Reanalysis changed the historical assessment inputs; review a full task rerun instead.");
  }
  const ndvi = refreshed.artifacts.find((artifact) => artifact.visualization?.metric === "ndvi"
    && artifact.visualization.date === newCurrent?.observationDate);
  const path = ndvi && resolveAcquisitionArtifact(ndvi.ref);
  if (!path) throw new Error("Reanalysis did not produce a current NDVI preview artifact.");
  const image = await stat(path);
  if (!image.isFile() || image.size === 0) throw new Error("Current NDVI preview artifact is empty.");

  const assessment = task.analysisResults.find((result) => result.kind === "assessment")
    ?? storedResults.find((result) => result.kind === "assessment");
  const updatedAssessment = assessment ? {
    ...assessment,
    artifacts: [...assessment.artifacts.filter((artifact) => !artifact.visualization),
      ...refreshed.artifacts.filter((artifact) => artifact.visualization)],
  } : null;
  const snapshot = task.analysisResults.some((result) => result.kind === "optical_condition") ? task.analysisResults : storedResults;
  const updated = snapshot.map((result): AnalysisResult<unknown> => {
    if (result.kind === "optical_condition") return refreshed;
    if (result.kind === "assessment" && updatedAssessment) return updatedAssessment;
    return result;
  });
  await stores.results.save(refreshed);
  if (updatedAssessment) await stores.results.save(updatedAssessment);
  await stores.tasks.save({ ...task, analysisResults: updated });
  return { resultId: refreshed.id, ndviRef: ndvi.ref, std: newCurrent?.metrics?.ndvi?.std ?? null };
}
