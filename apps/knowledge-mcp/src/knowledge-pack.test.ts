import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { prepareKnowledgePack, readKnowledgePackSpec } from "./knowledge-pack.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("knowledge pack preparation", () => {
  it("decodes numeric JATS title and text entities without bypassing source verification", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "chernozem-entities-"));
    cleanup.push(root);
    const value = validPack();
    value.sources[0]!.title = "Verified maize article—Zea mays";
    const path = resolve(root, "pack.json");
    await writeFile(path, JSON.stringify(value));
    const fetcher = async (input: string | URL | Request) => String(input).includes("api.crossref.org")
      ? Response.json({ message: { DOI: "10.3390/test123", title: [value.sources[0]!.title], publisher: "MDPI AG", license: [{ URL: "https://creativecommons.org/licenses/by/4.0/" }] } })
      : new Response(jatsFixture().replace("Verified maize article (<italic>Zea mays</italic> L.)", "Verified maize article&#x2014;Zea mays"));
    const result = await prepareKnowledgePack(await readKnowledgePackSpec(path), root, fetcher as typeof fetch, root);
    expect(result.documents).toBe(1);
  });
  it("verifies source metadata and produces section-addressable GraphRAG documents", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "chernozem-knowledge-"));
    cleanup.push(root);
    const specPath = resolve(root, "pack.json");
    await writeFile(specPath, JSON.stringify(validPack()), "utf8");
    const fetcher = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("api.crossref.org")) {
        return Response.json({ message: {
          DOI: "10.3390/test123",
          title: ["Verified maize article (Zea mays L.)"],
          publisher: "MDPI AG",
          license: [{ URL: "https://creativecommons.org/licenses/by/4.0/" }],
        } });
      }
      return new Response(jatsFixture(), { headers: { "content-type": "text/xml" } });
    };

    const prepared = await prepareKnowledgePack(await readKnowledgePackSpec(specPath), root, fetcher as typeof fetch, root);
    const manifest = JSON.parse(await readFile(prepared.manifestPath, "utf8")) as { entries: Array<{ locator: string; documentTitle: string; contentSha256: string }> };
    const document = await readFile(resolve(root, "input", manifest.entries[0]!.documentTitle), "utf8");

    expect(prepared).toMatchObject({ packId: "test-pack", documents: 1 });
    expect(prepared.sources).toHaveLength(2);
    expect(manifest.entries).toEqual([expect.objectContaining({ locator: "3. Results" })]);
    expect(manifest.entries[0]?.contentSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(document).toContain("DOI: 10.3390/test123");
    expect(document).toContain("Repeated verified maize result text for Zea mays improved after treatment.");
    expect(document).not.toContain("[1]");
    expect(prepared.sources[1]).toMatchObject({ contentRef: null, contentSha256: null, documentCount: 0 });

    const replayed = await prepareKnowledgePack(
      await readKnowledgePackSpec(specPath),
      root,
      (async () => { throw new Error("network should not be used for an unchanged verified pack"); }) as typeof fetch,
      root,
    );
    expect(replayed).toMatchObject({ packId: "test-pack", documents: 1 });
    expect(replayed.sources[0]?.contentSha256).toBe(prepared.sources[0]?.contentSha256);
  });

  it("rejects full text when the source does not carry an explicit CC BY license", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "chernozem-knowledge-"));
    cleanup.push(root);
    const value = validPack();
    value.sources[0]!.licenseStatus = "citation_only";
    value.sources[0]!.licenseRef = null;
    const path = resolve(root, "invalid.json");
    await writeFile(path, JSON.stringify(value), "utf8");

    await expect(readKnowledgePackSpec(path)).rejects.toThrow("Only public sources with an explicit license");
  });
});

function validPack() {
  return {
    schemaVersion: "1.0",
    packId: "test-pack",
    title: "Test pack",
    crop: "corn",
    regions: ["东北中国"],
    capabilities: ["growth_stage_monitoring"],
    sources: [{
      id: "11111111-1111-4111-8111-111111111111",
      title: "Verified maize article (Zea mays L.)",
      sourceType: "paper",
      authors: ["Test Author"],
      publisher: "MDPI AG",
      publicationYear: 2024,
      version: "2024-01-01",
      sourceUrl: "https://doi.org/10.3390/test123",
      identifierType: "doi",
      identifier: "10.3390/test123",
      licenseStatus: "public",
      licenseRef: "https://creativecommons.org/licenses/by/4.0/",
      licenseNote: "CC BY 4.0",
      regions: ["东北中国"],
      stages: ["拔节"],
      capabilities: ["growth_stage_monitoring"],
      retrievalKeywords: ["长势", "叶绿素"],
      applicabilityNote: "Test method; not a field observation.",
      content: {
        format: "jats-xml",
        fileName: "test.xml",
        urls: ["https://mdpi-res.com/test.xml"],
        sections: [{ id: "results" }],
      },
    }, {
      id: "22222222-2222-4222-8222-222222222222",
      title: "Citation only guidance",
      sourceType: "extension_guidance",
      authors: ["Test Agency"],
      publisher: "Test Agency",
      publicationYear: 2024,
      version: "1",
      sourceUrl: "https://example.com/guidance",
      identifierType: "standard",
      identifier: "TEST-1",
      licenseStatus: "citation_only",
      licenseRef: null,
      licenseNote: "No explicit reuse license.",
      regions: ["辽宁"],
      stages: ["苗期"],
      capabilities: ["growth_stage_monitoring"],
      retrievalKeywords: ["苗期"],
      applicabilityNote: "Citation only.",
      content: null,
    }],
  };
}

function jatsFixture(): string {
  const paragraph = "Repeated verified maize result text for <italic>Zea mays</italic> improved after <xref ref-type=\"bibr\">[1]</xref> treatment. ".repeat(20);
  return `<?xml version="1.0" encoding="UTF-8"?>
<article>
  <front><article-meta>
    <article-id pub-id-type="doi">10.3390/test123</article-id>
    <title-group><article-title>Verified maize article (<italic>Zea mays</italic> L.)</article-title></title-group>
    <permissions><license><license-p>This article is distributed under the Creative Commons Attribution 4.0 license.</license-p></license></permissions>
  </article-meta></front>
  <body><sec id="results"><title>3. <italic>Results</italic></title><p>${paragraph}</p></sec></body>
</article>`;
}
