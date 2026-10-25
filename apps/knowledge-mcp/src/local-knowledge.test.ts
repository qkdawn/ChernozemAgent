import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildLocalCollection, LocalKnowledgeService, rankPassages, type SearchablePassage } from "./local-knowledge.js";
import type { PreparedKnowledgePack } from "./knowledge-pack.js";

const nitrogen = passage("nitrogen", "Red-edge nitrogen assessment", "Nitrogen deficiency estimation from red-edge indices depends on soil and chlorophyll.", ["红边", "缺氮"]);
const frost = passage("cold", "Maize chilling tolerance", "Low temperature and chilling stress affect maize development; freezing is a separate process.", ["低温", "霜冻"]);
const flood = passage("flood", "SAR inundation mapping", "SAR flood mapping depends on backscatter and inundated vegetation scattering.", ["雷达", "积水"]);
const incidental = passage("incidental", "Sowing dates", "Nitrogen fertilizer was applied before sowing.", ["积温", "播期"]);

describe("local original-text knowledge retrieval", () => {
  it("retrieves Chinese concepts from English originals without padding with incidental mentions", () => {
    expect(rankPassages("红边下降能直接判断缺氮吗", [frost, flood, incidental, nitrogen]).map((p) => p.sourceId)).toEqual(["nitrogen"]);
    expect(rankPassages("玉米低温霜冻有什么影响", [nitrogen, flood, frost]).map((p) => p.sourceId)).toEqual(["cold"]);
    expect(rankPassages("雷达可以发现积水吗", [nitrogen, flood, frost]).map((p) => p.sourceId)).toEqual(["flood"]);
    expect(rankPassages("今天穿什么衣服", [nitrogen, frost])).toEqual([]);
  });

  it("requires concepts in original text, and uses word boundaries for SAR and pH", () => {
    const misleading = passage("x", "SAR soil pH", "Photosynthesis physiology responses are interesting.", ["雷达", "土壤"]);
    expect(rankPassages("SAR", [misleading])).toEqual([]);
    expect(rankPassages("ph", [misleading])).toEqual([]);
  });

  it("never reads passages after a scope rejection", async () => {
    const passages = vi.fn(async () => [nitrogen]);
    const service = new LocalKnowledgeService({ async resolveScope() { return null; }, passages });
    expect(await service.search({ fieldId: "other-org", query: "缺氮" })).toMatchObject({ status: "unavailable", matches: [], answer: null });
    expect(passages).not.toHaveBeenCalled();
  });

  it("passes the resolved task objective before ranking and returns exact original evidence with caveats", async () => {
    const passages = vi.fn(async () => [flood]);
    const service = new LocalKnowledgeService({ async resolveScope() { return { indexId: "local-1", objective: "waterlogging_detection" }; }, passages });
    const result = await service.search({ taskId: "task-1", query: "雷达积水" });
    expect(passages).toHaveBeenCalledWith("local-1", "waterlogging_detection");
    expect(result).toMatchObject({ status: "succeeded", indexRunRef: "local-1", answer: null,
      matches: [{ excerpt: flood.excerpt, citation: { sourceId: "flood", locator: flood.locator } }],
      limitations: [expect.stringContaining("Not locally validated")],
    });
  });

  it("reports failures without leaking database details or generating a fallback answer", async () => {
    const service = new LocalKnowledgeService({ async resolveScope() { throw new Error("postgres://private:secret@host"); }, async passages() { return []; } });
    const result = await service.search({ fieldId: "field-1", query: "缺氮" });
    expect(result).toMatchObject({ status: "unavailable", answer: null, error: { code: "local_knowledge_query_failed", retryable: true } });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("checks every source and chapter hash; chunks remain exact substrings with stable fingerprints", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "maize-local-"));
    try {
      await mkdir(resolve(root, "input"));
      await mkdir(resolve(root, "sources"));
      const id = "11111111-1111-4111-8111-111111111111";
      const xml = "verified-original-xml";
      const body = "Original maize evidence sentence with nitrogen and red-edge. ".repeat(95);
      const text = `Source: Metadata should not be evidence\n\n${body}\n`;
      const hash = (s: string) => createHash("sha256").update(s).digest("hex");
      const manifestPath = resolve(root, "input-manifest.json");
      await writeFile(resolve(root, "sources", "test.xml"), xml);
      await writeFile(resolve(root, "input", "chapter.txt"), text);
      await writeFile(manifestPath, JSON.stringify({ packId: "test", entries: [{ sourceId: id, documentTitle: "chapter.txt", locator: "Results", contentSha256: hash(text) }] }));
      const pack = { packId: "test", root, manifestPath, sources: [{
        spec: { id, version: "v1", content: { fileName: "test.xml" }, retrievalKeywords: ["缺氮"], applicabilityNote: "Method only" },
        contentSha256: hash(xml), documentCount: 1,
      }] } as PreparedKnowledgePack;
      const first = await buildLocalCollection(pack);
      expect(first.passages.length).toBeGreaterThan(2);
      for (const p of first.passages) {
        expect(body).toContain(p.excerpt);
        expect(p.excerpt.length).toBeLessThanOrEqual(1800);
        expect(p.excerpt).not.toContain("Metadata");
      }
      expect((await buildLocalCollection(pack)).fingerprint).toBe(first.fingerprint);
      await writeFile(resolve(root, "input", "chapter.txt"), `${text}unauthorized edit`);
      await expect(buildLocalCollection(pack)).rejects.toThrow("document hash mismatch");
      await writeFile(resolve(root, "input", "chapter.txt"), text);
      await writeFile(resolve(root, "sources", "test.xml"), "changed source");
      await expect(buildLocalCollection(pack)).rejects.toThrow("source hash mismatch");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

function passage(id: string, title: string, excerpt: string, keywords: string[]): SearchablePassage {
  return { passageId: id, sourceId: id, title, excerpt, keywords, sourceVersion: "v1", sourceSha256: "a".repeat(64),
    locator: "Discussion", applicabilityNote: "Not locally validated", regions: ["通用方法"], stages: [],
    sourceUrl: "https://doi.org/10.3390/test", identifierType: "doi", identifier: "10.3390/test" };
}
