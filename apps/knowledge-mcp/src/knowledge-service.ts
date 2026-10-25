import type { AgronomyKnowledgeMatch, AgronomyKnowledgeScope, AgronomyKnowledgeSearchInput, AgronomyKnowledgeSearchResult, AnalysisObjective, CropCode } from "@chernozem/contracts";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import pg from "pg";

const { Pool } = pg;

export interface KnowledgeIndexScope {
  indexRunRef: string;
  objective: AnalysisObjective | null;
}

export interface GraphRagQueryResult {
  answer: string;
  textUnitIds: string[];
  relatedEntities: string[];
}

export interface KnowledgeRepository {
  resolveIndex(input: AgronomyKnowledgeScope): Promise<KnowledgeIndexScope | null>;
  findCitations(scope: KnowledgeIndexScope, textUnitIds: string[]): Promise<AgronomyKnowledgeMatch[]>;
}

export interface GraphRagQueryRunner {
  query(input: { query: string }): Promise<GraphRagQueryResult>;
}

export class AgronomyKnowledgeService {
  constructor(
    private readonly repository: KnowledgeRepository,
    private readonly runner: GraphRagQueryRunner | null,
  ) {}

  async search(input: AgronomyKnowledgeSearchInput): Promise<AgronomyKnowledgeSearchResult> {
    const scope = await this.repository.resolveIndex("taskId" in input ? { taskId: input.taskId } : { fieldId: input.fieldId });
    if (!scope) return unavailable("knowledge_index_missing", `当前没有可用于该${"taskId" in input ? "任务" : "地块"}的东北玉米知识索引。`, false);
    if (!this.runner) return unavailable("graphrag_not_configured", "GraphRAG 查询运行时尚未配置。", false, scope.indexRunRef);

    try {
      const queryResult = await this.runner.query({ query: input.query });
      const matches = await this.repository.findCitations(scope, queryResult.textUnitIds);
      if (matches.length === 0) {
        return {
          status: "no_matches",
          indexRunRef: scope.indexRunRef,
          answer: null,
          matches: [],
          limitations: ["GraphRAG 没有返回带合法来源定位的适用材料。"],
          error: null,
        };
      }
      const related = new Set(queryResult.relatedEntities);
      return {
        status: "succeeded",
        indexRunRef: scope.indexRunRef,
        answer: queryResult.answer,
        matches: matches.map((match) => ({
          ...match,
          relatedEntities: [...new Set([...match.relatedEntities, ...related])],
        })),
        limitations: [],
        error: null,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "GraphRAG 查询失败。";
      return unavailable("graphrag_query_failed", message, true, scope.indexRunRef);
    }
  }
}

export function createPostgresKnowledgeRepository(
  databaseUrl: string,
  organizationId: string,
): KnowledgeRepository {
  const pool = new Pool({ connectionString: databaseUrl });
  return {
    async resolveIndex(input) {
      const response = "taskId" in input
        ? await pool.query(
        `SELECT t.objective, i.id AS index_run_id
         FROM analysis_tasks t
         JOIN fields f ON f.id = t.field_id AND f.organization_id = t.organization_id
         CROSS JOIN LATERAL (
           SELECT id FROM knowledge_index_runs
           WHERE status = 'completed'
           ORDER BY completed_at DESC NULLS LAST, created_at DESC
           LIMIT 1
         ) i
         WHERE t.id = $1 AND t.organization_id = $2 AND f.crop = 'corn'`,
        [input.taskId, organizationId],
      )
        : await pool.query(
        `SELECT NULL::text AS objective, i.id AS index_run_id
         FROM fields f
         CROSS JOIN LATERAL (
           SELECT id FROM knowledge_index_runs
           WHERE status = 'completed'
           ORDER BY completed_at DESC NULLS LAST, created_at DESC
           LIMIT 1
         ) i
         WHERE f.id = $1 AND f.organization_id = $2 AND f.crop = 'corn'`,
        [input.fieldId, organizationId],
      );
      const row = response.rows[0];
      return row ? { indexRunRef: String(row.index_run_id), objective: row.objective as AnalysisObjective | null } : null;
    },
    async findCitations(scope, textUnitIds) {
      if (textUnitIds.length === 0) return [];
      const response = await pool.query(
        `SELECT u.text_unit_id, u.locator, u.excerpt, u.related_entities,
                s.id AS source_id, s.title, s.crop, s.regions, s.stages,
                s.source_url, s.identifier_type, s.identifier, s.version
         FROM knowledge_text_units u
         JOIN knowledge_sources s ON s.id = u.source_id
         WHERE u.index_run_id = $1
           AND u.text_unit_id = ANY($2::text[])
           AND s.status = 'published'
           AND (s.crop IS NULL OR s.crop = 'corn')
           AND (cardinality(s.capabilities) = 0 OR $3::text IS NULL OR $3 = ANY(s.capabilities))
           AND (cardinality(s.regions) = 0 OR s.regions && ARRAY['东北黑土区', '辽宁省', '铁岭市']::text[])
         ORDER BY array_position($2::text[], u.text_unit_id), s.title`,
        [scope.indexRunRef, textUnitIds, scope.objective],
      );
      return response.rows.map(toKnowledgeMatch);
    },
  };
}

export function createGraphRagPythonRunner(options: {
  pythonExecutable: string;
  scriptPath: string;
  workspaceRoot: string;
  outputDirectory: string;
  timeoutMs?: number;
  environment?: NodeJS.ProcessEnv;
}): GraphRagQueryRunner {
  const scriptPath = resolve(options.scriptPath);
  const workspaceRoot = resolve(options.workspaceRoot);
  const outputDirectory = resolve(options.outputDirectory);
  return {
    query(input) {
      return runGraphRagProcess({
        pythonExecutable: options.pythonExecutable,
        scriptPath,
        payload: { root: workspaceRoot, data: outputDirectory, query: input.query },
        timeoutMs: options.timeoutMs ?? 90_000,
        environment: graphRagProcessEnvironment(options.environment ?? process.env),
      });
    },
  };
}

function runGraphRagProcess(options: {
  pythonExecutable: string;
  scriptPath: string;
  payload: { root: string; data: string; query: string };
  timeoutMs: number;
  environment: Record<string, string>;
}): Promise<GraphRagQueryResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(options.pythonExecutable, [options.scriptPath], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: options.environment,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), options.timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(safeProcessError(stderr, code)));
      try {
        const parsed = JSON.parse(stdout) as GraphRagQueryResult;
        if (typeof parsed.answer !== "string" || !Array.isArray(parsed.textUnitIds) || !Array.isArray(parsed.relatedEntities)) {
          throw new Error("GraphRAG worker returned an invalid result.");
        }
        resolveResult(parsed);
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(JSON.stringify(options.payload));
  });
}

export function graphRagProcessEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  const baseUrl = env.GRAPHRAG_API_BASE ?? env.OPENAI_BASE_URL;
  const apiKey = env.GRAPHRAG_API_KEY ?? env.OPENAI_API_KEY;
  return {
    ...Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
    ...(baseUrl ? { GRAPHRAG_API_BASE: baseUrl } : {}),
    ...(apiKey ? { GRAPHRAG_API_KEY: apiKey } : {}),
  };
}

function toKnowledgeMatch(row: Record<string, unknown>): AgronomyKnowledgeMatch {
  const crop = row.crop === "corn" ? ["corn" as CropCode] : [];
  const identifierType = row.identifier_type as "doi" | "isbn" | "standard" | "internal" | null;
  return {
    excerpt: String(row.excerpt),
    textUnitIds: [String(row.text_unit_id)],
    relatedEntities: Array.isArray(row.related_entities) ? row.related_entities.map(String) : [],
    applicability: {
      regions: Array.isArray(row.regions) ? row.regions.map(String) : [],
      crops: crop,
      stages: Array.isArray(row.stages) ? row.stages.map(String) : [],
    },
    citation: {
      sourceId: String(row.source_id),
      title: String(row.title),
      locator: String(row.locator),
      sourceUrl: row.source_url ? String(row.source_url) : null,
      identifier: identifierType && row.identifier
        ? { type: identifierType, value: String(row.identifier) }
        : null,
      version: String(row.version),
    },
  };
}

function unavailable(
  code: string,
  message: string,
  retryable: boolean,
  indexRunRef: string | null = null,
): AgronomyKnowledgeSearchResult {
  return {
    status: "unavailable",
    indexRunRef,
    answer: null,
    matches: [],
    limitations: [message],
    error: { code, message, retryable },
  };
}

function safeProcessError(stderr: string, code: number | null): string {
  const firstLine = stderr.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  return firstLine ? `GraphRAG worker failed: ${firstLine.slice(0, 300)}` : `GraphRAG worker exited with code ${code ?? "unknown"}.`;
}
