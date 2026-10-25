// Live DB + stdio MCP verification using temporary, explicitly synthetic scopes.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import pg from "pg";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { AgronomyKnowledgeSearchResult, AnalysisObjective } from "@chernozem/contracts";

const workspace = resolve(import.meta.dirname, "../../..");
if (existsSync(resolve(workspace, ".env"))) loadEnvFile(resolve(workspace, ".env"));
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required.");
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const org = randomUUID();
const otherOrg = randomUUID();
const fields = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
const tasks: string[] = [];
const client = new Client({ name: "maize-local-verification", version: "1.0" });
const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
const transport = new StdioClientTransport({ command: process.execPath,
  args: ["--import", "tsx", resolve(workspace, "apps/knowledge-mcp/src/server.ts")], cwd: workspace,
  env: { ...env, ORGANIZATION_ID: org, KNOWLEDGE_SEARCH_ENGINE: "local" },
});
let checks = 0;
async function search(scope: { fieldId: string } | { taskId: string }, query: string) {
  const response = await client.callTool({ name: "search_agronomy_knowledge", arguments: { ...scope, query } });
  const result = response.structuredContent as unknown as AgronomyKnowledgeSearchResult;
  assert.ok(result);
  assert.equal(result.answer, null, "Extractive retrieval must not generate an answer");
  checks++;
  return result;
}
try {
  await pool.query("INSERT INTO organizations(id,name) VALUES($1,'synthetic knowledge verification'),($2,'synthetic unauthorized scope')", [org, otherOrg]);
  for (const [i, id] of fields.entries()) await pool.query(
    `INSERT INTO fields(id,organization_id,name,crop,season_year,boundary,archived_at)
     VALUES($1,$2,'synthetic knowledge verification',$3,2026,
       ST_GeomFromText('POLYGON((123 42,123.001 42,123.001 42.001,123 42.001,123 42))',4326),$4)`,
    [id, i === 2 ? otherOrg : org, i === 1 ? "rice" : "corn", i === 3 ? new Date() : null],
  );
  await client.connect(transport);
  assert.deepEqual((await client.listTools()).tools.map((t) => t.name), ["search_agronomy_knowledge"]);
  const cases: Array<{ objective: AnalysisObjective; query: string; expected: string }> = [
    { objective: "growth_stage_monitoring", query: "玉米生育期与积温有什么关系", expected: "10.3390/agronomy12102585" },
    { objective: "water_nitrogen_diagnosis", query: "红边下降能直接判断缺氮吗", expected: "10.3390/rs12142175" },
    { objective: "waterlogging_detection", query: "雷达可以识别积水吗", expected: "10.3390/rs14246374" },
    { objective: "frost_risk_warning", query: "玉米低温霜冻有什么影响", expected: "10.3390/plants11162082" },
  ];
  for (const sample of cases) {
    for (const isTask of [false, true]) {
      let scope: { fieldId: string } | { taskId: string } = { fieldId: fields[0]! };
      if (isTask) {
        const id = randomUUID(); tasks.push(id);
        await pool.query(`INSERT INTO analysis_tasks(id,organization_id,field_id,objective,status,created_at,document)
          VALUES($1,$2,$3,$4,'planned',now(),'{"syntheticKnowledgeVerification":true}')`, [id, org, fields[0], sample.objective]);
        scope = { taskId: id };
      }
      const result = await search(scope, sample.query);
      assert.equal(result.status, "succeeded");
      assert.ok(result.matches.some((m) => m.citation.identifier?.value === sample.expected), `Expected source missing for ${sample.objective}`);
      for (const match of result.matches) {
        const source = (await pool.query("SELECT capabilities, license_status, status FROM knowledge_sources WHERE id=$1", [match.citation.sourceId])).rows[0];
        assert.equal(source.status, "published"); assert.equal(source.license_status, "public");
        if (isTask) assert.ok(source.capabilities.includes(sample.objective), "Source escaped task capability filter");
        const original = (await pool.query("SELECT excerpt FROM knowledge_local_passages WHERE index_id=$1 AND passage_id=$2", [result.indexRunRef, match.textUnitIds[0]])).rows[0];
        assert.equal(match.excerpt, original.excerpt);
        assert.ok(match.citation.locator && match.citation.sourceUrl && result.limitations.length);
      }
      console.log(JSON.stringify({ objective: sample.objective, scope: isTask ? "task" : "field", status: result.status, matches: result.matches.length }));
    }
  }
  for (const id of [fields[1]!, fields[2]!, fields[3]!, randomUUID()]) {
    assert.equal((await search({ fieldId: id }, "玉米低温霜冻")).status, "unavailable");
  }
  assert.equal((await search({ taskId: randomUUID() }, "玉米低温霜冻")).status, "unavailable");
  assert.equal((await search({ fieldId: fields[0]! }, "今天穿什么颜色的衣服")).status, "no_matches");
  console.log(JSON.stringify({ verified: true, checks, includes: ["original-citations", "four-capabilities", "organization", "crop", "archived-field", "missing-scope", "no-match"] }));
} finally {
  await client.close();
  try {
    await pool.query("DELETE FROM analysis_tasks WHERE id=ANY($1::uuid[])", [tasks]);
    await pool.query("DELETE FROM fields WHERE id=ANY($1::uuid[])", [fields]);
    await pool.query("DELETE FROM organizations WHERE id=ANY($1::uuid[])", [[org, otherOrg]]);
  } finally { await pool.end(); }
}
