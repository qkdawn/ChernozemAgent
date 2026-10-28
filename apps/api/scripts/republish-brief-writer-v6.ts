/**
 * One-off CLI: re-run analysis-brief-writer v6 against saved historical tasks.
 *
 * Usage (repo root .env must provide DATABASE_URL + OPENAI_API_KEY / Codex env, same as server.ts):
 *   pnpm --filter @chernozem/api writer:v6-rerun -- <taskId> [taskId...]
 *
 * Acceptance examples (S2/B3):
 *   aca17f7b-34e2-442f-977b-7f0b63b56c0f
 *   60b8e16b-8e4a-45d6-9b53-e5d9cd076829
 *
 * Writes artifacts under runtime/writer-v6-rerun/<taskId>.json (gitignored). Does not open a PR.
 *
 * S2 note: spatialPriority / radarOverlap / lowlandOverlap live on water-nitrogen assessments.
 * Growth-only historical tasks (including the pinned aca17f7b / 60b8e16b samples) usually lack
 * those fields; ensureSpatialPriorityOnResults cannot invent overlaps without them. To leave
 * S2 N/A, re-run water_nitrogen_diagnosis (assess_water_nitrogen_evidence) for the field/window,
 * persist the assessment, then writer:v6-rerun that new taskId. Fallback diagnostics print to
 * stderr as JSON lines with event=analysis_brief_writer_fallback.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";

import type { AnalysisResult, AnalysisTask } from "@chernozem/contracts";

import { createConfiguredCodexRuntime } from "../src/agent-model-runtime.js";
import { buildAnalysisBrief } from "../src/analysis-brief.js";
import { createCodexAnalysisBriefWriter, publishAnalysisBrief } from "../src/analysis-brief-writer.js";
import { createPostgresAnalysisResultStore } from "../src/analysis-store.js";
import { createKnowledgeMcpSearch } from "../src/knowledge-mcp-client.js";
import { deriveSpatialPriority, type SpatialPriority, type WaterNitrogenEvidencePayload } from "../src/multi-source-analysis.js";
import type { SpatialOverlap } from "../src/spatial-evidence.js";
import { createPostgresAnalysisTaskStore } from "../src/task-store.js";

const envPath = resolve(import.meta.dirname, "../../../.env");
if (existsSync(envPath)) loadEnvFile(envPath);

const DEFAULT_EXAMPLES = [
  "aca17f7b-34e2-442f-977b-7f0b63b56c0f",
  "60b8e16b-8e4a-45d6-9b53-e5d9cd076829",
] as const;

const taskIds = process.argv.slice(2).filter((argument) => argument !== "--");
if (taskIds.length === 0) {
  console.error(`Pass one or more analysis task IDs.\nExample: pnpm --filter @chernozem/api writer:v6-rerun -- ${DEFAULT_EXAMPLES.join(" ")}`);
  process.exitCode = 1;
} else {
  await main(taskIds);
}

async function main(ids: string[]): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required. Start PostGIS with docker compose up -d and provide repo-root .env.");

  const taskStore = createPostgresAnalysisTaskStore(databaseUrl);
  const analysisResultStore = createPostgresAnalysisResultStore(databaseUrl);
  const knowledgeSearch = createKnowledgeMcpSearch(process.env);
  const writer = createCodexAnalysisBriefWriter({
    ...createConfiguredCodexRuntime(process.env),
    store: analysisResultStore,
    ...(knowledgeSearch ? { knowledgeSearch } : {}),
  });

  const outDir = resolve(import.meta.dirname, "../../../runtime/writer-v6-rerun");
  await mkdir(outDir, { recursive: true });

  let failures = 0;
  for (const taskId of ids) {
    try {
      const artifact = await rerunOne(taskId, { taskStore, analysisResultStore, writer });
      const path = resolve(outDir, `${taskId}.json`);
      await writeFile(path, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
      console.log(JSON.stringify({
        taskId,
        ok: true,
        path,
        promptVersion: artifact.promptVersion,
        generationMode: artifact.generation?.mode ?? null,
        changesAnyPriority: artifact.spatialPrioritySummary?.changesAnyPriority ?? null,
      }));
    } catch (error) {
      failures += 1;
      const message = error instanceof Error ? error.message : String(error);
      console.error(JSON.stringify({ taskId, ok: false, error: message }));
      const path = resolve(outDir, `${taskId}.json`);
      await writeFile(path, `${JSON.stringify({ taskId, ok: false, error: message }, null, 2)}\n`, "utf8");
    }
  }
  if (failures > 0) process.exitCode = 1;
}

async function rerunOne(taskId: string, deps: {
  taskStore: ReturnType<typeof createPostgresAnalysisTaskStore>;
  analysisResultStore: ReturnType<typeof createPostgresAnalysisResultStore>;
  writer: ReturnType<typeof createCodexAnalysisBriefWriter>;
}) {
  const task = await deps.taskStore.get(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  if (task.boundaryVersion === undefined || !Number.isInteger(task.boundaryVersion) || task.boundaryVersion < 1) {
    throw new Error(`Task ${taskId} is missing a verified boundaryVersion; cannot republish brief.`);
  }

  let results = await deps.analysisResultStore.list(taskId);
  if (results.length === 0 && task.analysisResults.length > 0) {
    for (const result of task.analysisResults) await deps.analysisResultStore.save(result);
    results = await deps.analysisResultStore.list(taskId);
  }
  if (results.length === 0) throw new Error(`No analysis results for task ${taskId}.`);

  const ensured = await ensureSpatialPriorityOnResults(results, deps.analysisResultStore);
  results = ensured.results;

  const deterministicBrief = buildAnalysisBrief(task.objective, results);
  if (!deterministicBrief) throw new Error(`buildAnalysisBrief returned null for task ${taskId} (objective=${task.objective}).`);

  const publication = await publishAnalysisBrief({
    task: briefTask(task),
    results,
    brief: deterministicBrief,
    writer: deps.writer,
  });

  const assessment = publication.results.find((result) => result.kind === "assessment")
    ?? results.find((result) => result.kind === "assessment");
  const payload = assessment?.result && isRecord(assessment.result) ? assessment.result : null;
  const zones = Array.isArray(payload?.zones) ? payload.zones : [];
  const spatialPrioritySummary = isRecord(payload?.spatialPrioritySummary)
    ? payload.spatialPrioritySummary as WaterNitrogenEvidencePayload["spatialPrioritySummary"]
    : null;

  return {
    taskId,
    ok: true,
    objective: task.objective,
    promptVersion: deps.writer.promptVersion,
    spatialPriorityRecomputed: ensured.recomputed,
    spatialPrioritySummary,
    spatialPriority: zones.map((zone) => {
      const record = isRecord(zone) ? zone : {};
      return {
        id: typeof record.id === "string" ? record.id : null,
        spatialPriority: isRecord(record.spatialPriority) ? record.spatialPriority : null,
        radarOverlap: isRecord(record.radarOverlap) ? summarizeOverlap(record.radarOverlap) : null,
        lowlandOverlap: isRecord(record.lowlandOverlap) ? summarizeOverlap(record.lowlandOverlap) : null,
      };
    }),
    overview: publication.brief.overview,
    document: publication.brief.document,
    headline: publication.brief.headline,
    reasoning: publication.brief.reasoning,
    generation: publication.brief.generation,
    reviewRequired: publication.brief.reviewRequired,
  };
}

function briefTask(task: AnalysisTask) {
  return {
    id: task.id,
    fieldId: task.fieldId,
    objective: task.objective,
    timeRange: task.timeRange,
    ...(task.boundaryVersion !== undefined ? { boundaryVersion: task.boundaryVersion } : {}),
    ...(task.requestMessage ? { requestMessage: task.requestMessage } : {}),
  };
}

async function ensureSpatialPriorityOnResults(
  results: AnalysisResult<unknown>[],
  store: ReturnType<typeof createPostgresAnalysisResultStore>,
): Promise<{ results: AnalysisResult<unknown>[]; recomputed: boolean }> {
  let recomputed = false;
  const next: AnalysisResult<unknown>[] = [];
  for (const result of results) {
    // Only water-nitrogen assessments carry radar/lowland overlap + spatialPriority.
    if (
      result.kind !== "assessment"
      || !isRecord(result.result)
      || !Array.isArray(result.result.zones)
      || typeof result.result.evidenceLevel !== "string"
    ) {
      next.push(result);
      continue;
    }
    const patched = ensureSpatialPriorityPayload(result.result);
    if (patched.changed) {
      recomputed = true;
      const updated: AnalysisResult<unknown> = { ...result, result: patched.payload };
      await store.save(updated);
      next.push(updated);
    } else {
      next.push(result);
    }
  }
  return { results: next, recomputed };
}

function ensureSpatialPriorityPayload(payload: Record<string, unknown>): { payload: Record<string, unknown>; changed: boolean } {
  const zonesIn = payload.zones;
  if (!Array.isArray(zonesIn)) return { payload, changed: false };

  let zoneChanged = false;
  const zones = zonesIn.map((zone, index) => {
    if (!isRecord(zone)) throw new Error(`zones[${index}] is not an object; cannot derive spatialPriority.`);
    if (isSpatialPriority(zone.spatialPriority)) return zone;

    const radar = asSpatialOverlap(zone.radarOverlap);
    const lowland = asSpatialOverlap(zone.lowlandOverlap);
    if (!radar || !lowland) {
      throw new Error(
        `Assessment zone ${typeof zone.id === "string" ? zone.id : index} lacks spatialPriority and is missing radarOverlap/lowlandOverlap; full tool re-run (with imagery assets) is required.`,
      );
    }
    zoneChanged = true;
    return { ...zone, spatialPriority: deriveSpatialPriority(radar, lowland) };
  });

  const summary = {
    changesAnyPriority: zones.some((zone) => isRecord(zone.spatialPriority) && zone.spatialPriority.changesPriority === true)
      ? true
      : zones.length > 0 && zones.every((zone) => isRecord(zone.spatialPriority) && zone.spatialPriority.changesPriority === false)
        ? false
        : null,
    orderedZoneIds: [
      ...zones.filter((zone) => isRecord(zone.spatialPriority) && zone.spatialPriority.changesPriority === true),
      ...zones.filter((zone) => !(isRecord(zone.spatialPriority) && zone.spatialPriority.changesPriority === true)),
    ].map((zone) => String((zone as { id: unknown }).id)),
  };

  const summaryChanged = !hasSpatialPrioritySummary(payload)
    || JSON.stringify(payload.spatialPrioritySummary) !== JSON.stringify(summary);
  if (!zoneChanged && !summaryChanged) return { payload, changed: false };
  return { payload: { ...payload, zones, spatialPrioritySummary: summary }, changed: true };
}

function hasSpatialPrioritySummary(payload: Record<string, unknown>): boolean {
  return isRecord(payload.spatialPrioritySummary)
    && ("changesAnyPriority" in payload.spatialPrioritySummary)
    && Array.isArray(payload.spatialPrioritySummary.orderedZoneIds);
}

function isSpatialPriority(value: unknown): value is SpatialPriority {
  return isRecord(value)
    && (value.status === "computed" || value.status === "unavailable" || value.status === "not_applicable")
    && (value.changesPriority === true || value.changesPriority === false || value.changesPriority === null)
    && typeof value.note === "string";
}

function asSpatialOverlap(value: unknown): SpatialOverlap | null {
  if (!isRecord(value)) return null;
  if (value.status !== "computed" && value.status !== "unavailable" && value.status !== "invalid_geometry" && value.status !== "calculation_failed") {
    return null;
  }
  return value as unknown as SpatialOverlap;
}

function summarizeOverlap(value: Record<string, unknown>) {
  return {
    status: value.status ?? null,
    overlapAreaHa: value.overlapAreaHa ?? null,
    sourceResultId: value.sourceResultId ?? null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
