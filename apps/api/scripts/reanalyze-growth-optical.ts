/**
 * Recompute a finished growth task's optical result from its original local Sentinel-2 assets.
 * Run on the same artifact volume as the API, with DATABASE_URL and Python raster dependencies:
 *   pnpm --filter @chernozem/api growth:optical-rerun -- 77fc29fe-d411-49a1-9a80-3f4bbd86b887
 * Updates the saved optical result and assessment map references; leaves the writer brief and
 * task-level actions unchanged. Fails if the historical NDVI means or zone count change.
 */
import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { resolve } from "node:path";

import { createPostgresAcquisitionStore } from "../src/acquisition-store.js";
import { createPostgresAnalysisResultStore } from "../src/analysis-store.js";
import { createPostgresFieldStore } from "../src/field-store.js";
import { reanalyzeGrowthOptical } from "../src/reanalyze-growth-optical.js";
import { createPostgresAnalysisTaskStore } from "../src/task-store.js";

const envPath = resolve(import.meta.dirname, "../../../.env");
if (existsSync(envPath)) loadEnvFile(envPath);
const taskIds = process.argv.slice(2).filter((argument) => argument !== "--");
if (!taskIds.length || !process.env.DATABASE_URL) {
  throw new Error("Provide DATABASE_URL and at least one growth task ID.");
}
const databaseUrl = process.env.DATABASE_URL;
const stores = {
  tasks: createPostgresAnalysisTaskStore(databaseUrl),
  results: createPostgresAnalysisResultStore(databaseUrl),
  fields: createPostgresFieldStore(databaseUrl),
  acquisitions: createPostgresAcquisitionStore(databaseUrl),
};
for (const taskId of taskIds) {
  const result = await reanalyzeGrowthOptical(taskId, stores);
  console.log(JSON.stringify({ taskId, ...result }));
}
