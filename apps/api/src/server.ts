import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";

import { buildApp } from "./app.js";
import { createPostgresFieldStore } from "./field-store.js";

const envPath = resolve(import.meta.dirname, "../../../.env");
if (existsSync(envPath)) {
  loadEnvFile(envPath);
}

const port = Number(process.env.PORT ?? 3001);
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required. Start PostGIS with docker compose up -d before starting the API.");
}
const app = buildApp({ fieldStore: createPostgresFieldStore(databaseUrl) });

try {
  await app.listen({ host: "0.0.0.0", port });
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}
