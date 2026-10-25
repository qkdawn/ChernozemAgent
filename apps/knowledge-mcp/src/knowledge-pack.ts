import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

import { XMLParser } from "fast-xml-parser";
import type { Pool } from "pg";
import { z } from "zod";

const SectionSelectorSchema = z.object({
  id: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
}).refine((value) => (value.id ? 1 : 0) + (value.title ? 1 : 0) === 1, "Section selector must contain exactly one of id or title.");

const ContentSchema = z.object({
  format: z.literal("jats-xml"),
  fileName: z.string().regex(/^[a-z0-9][a-z0-9.-]*\.xml$/),
  urls: z.array(z.string().url()).min(1),
  sections: z.array(SectionSelectorSchema).min(1),
});

const SourceSchema = z.object({
  id: z.string().uuid(),
  title: z.string().min(1).max(240),
  sourceType: z.enum(["standard", "extension_guidance", "paper", "book", "station_material", "product_documentation"]),
  authors: z.array(z.string().min(1)).min(1),
  publisher: z.string().min(1),
  publicationYear: z.number().int().min(1800).max(2100).nullable(),
  version: z.string().min(1),
  sourceUrl: z.string().url(),
  identifierType: z.enum(["doi", "isbn", "standard", "internal"]),
  identifier: z.string().min(1),
  licenseStatus: z.enum(["public", "licensed", "citation_only", "internal_authorized"]),
  licenseRef: z.string().url().nullable(),
  licenseNote: z.string().min(1),
  regions: z.array(z.string().min(1)),
  stages: z.array(z.string().min(1)),
  capabilities: z.array(z.enum(["growth_stage_monitoring", "water_nitrogen_diagnosis", "waterlogging_detection", "frost_risk_warning"])).min(1),
  retrievalKeywords: z.array(z.string().min(2)).min(1),
  applicabilityNote: z.string().min(1),
  content: ContentSchema.nullable(),
}).superRefine((source, context) => {
  if (source.content && source.licenseStatus !== "public") {
    context.addIssue({ code: "custom", path: ["content"], message: "Only public sources with an explicit license can enter the full-text pack." });
  }
  if (source.content && !source.licenseRef?.startsWith("https://creativecommons.org/licenses/by/")) {
    context.addIssue({ code: "custom", path: ["licenseRef"], message: "Indexed public sources must use an explicit Creative Commons Attribution license." });
  }
  if (!source.content && source.licenseStatus !== "citation_only") {
    context.addIssue({ code: "custom", path: ["content"], message: "A source without indexable content must be citation_only in this pack." });
  }
});

const PackSchema = z.object({
  schemaVersion: z.literal("1.0"),
  packId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  title: z.string().min(1),
  crop: z.literal("corn"),
  regions: z.array(z.string().min(1)).min(1),
  capabilities: z.array(z.enum(["growth_stage_monitoring", "water_nitrogen_diagnosis", "waterlogging_detection", "frost_risk_warning"])).min(1),
  sources: z.array(SourceSchema).min(1),
});

export type KnowledgePackSpec = z.infer<typeof PackSchema>;
type KnowledgeSourceSpec = KnowledgePackSpec["sources"][number];
type SectionSelector = NonNullable<KnowledgeSourceSpec["content"]>["sections"][number];

export interface PreparedKnowledgeSource {
  spec: KnowledgeSourceSpec;
  contentRef: string | null;
  contentSha256: string | null;
  documentCount: number;
}

export interface PreparedKnowledgePack {
  packId: string;
  root: string;
  manifestPath: string;
  snapshotPath: string;
  sources: PreparedKnowledgeSource[];
  documents: number;
}

interface CrossrefWork {
  DOI?: string;
  title?: string[];
  publisher?: string;
  license?: Array<{ URL?: string }>;
}

interface ManifestEntry {
  documentTitle: string;
  sourceId: string;
  locator: string;
  contentSha256: string;
}

interface SourceSnapshotEntry {
  id: string;
  specSha256?: string;
  contentSha256: string | null;
}

interface JatsElement {
  name: string;
  attributes: Record<string, string>;
  children: Array<JatsElement | string>;
}

export async function readKnowledgePackSpec(path: string): Promise<KnowledgePackSpec> {
  return PackSchema.parse(JSON.parse(await readFile(resolve(path), "utf8")));
}

export async function prepareKnowledgePack(
  spec: KnowledgePackSpec,
  rootPath: string,
  fetcher: typeof fetch = fetch,
  contentReferenceRoot: string = process.cwd(),
): Promise<PreparedKnowledgePack> {
  const root = resolve(rootPath);
  const sourceDirectory = resolve(root, "sources");
  const inputDirectory = resolve(root, "input");
  const manifestPath = resolve(root, "input-manifest.json");
  const snapshotPath = resolve(root, "source-snapshot.json");
  const stageDirectory = resolve(root, `.prepare-${spec.packId}-${process.pid}`);
  const stageInput = resolve(stageDirectory, "input");
  const stageSources = resolve(stageDirectory, "sources");
  const previousSnapshot = await readSourceSnapshot(snapshotPath, spec.packId);
  await rm(stageDirectory, { recursive: true, force: true });
  await Promise.all([mkdir(stageInput, { recursive: true }), mkdir(stageSources, { recursive: true })]);

  const prepared: PreparedKnowledgeSource[] = [];
  const manifest: ManifestEntry[] = [];
  const generatedDocuments = new Map<string, string>();
  try {
    for (const source of spec.sources) {
      if (!source.content) {
        prepared.push({ spec: source, contentRef: null, contentSha256: null, documentCount: 0 });
        continue;
      }
      const cached = await readVerifiedCachedSource(source, sourceDirectory, previousSnapshot);
      const crossref = cached ? { publisher: source.publisher } : await verifyCrossref(source, fetcher);
      const xml = cached ?? await downloadSource(source, fetcher);
      const article = parseJats(xml);
      verifyJatsArticle(source, article);
      const sourceTarget = resolve(stageSources, source.content.fileName);
      await writeFile(sourceTarget, xml);
      let documentCount = 0;
      for (const [index, selector] of source.content.sections.entries()) {
        const section = findJatsSection(article, selector);
        const locator = elementText(firstChild(section, "title"));
        const body = sectionBody(section);
        if (body.length < 200) throw new Error(`${source.identifier} section ${locator} contains too little indexable text.`);
        const documentTitle = `${source.id}__${String(index + 1).padStart(2, "0")}-${slug(locator)}.txt`;
        if (generatedDocuments.has(documentTitle)) throw new Error(`Duplicate generated document title: ${documentTitle}`);
        const text = knowledgeDocument(source, locator, body, crossref.publisher ?? source.publisher);
        generatedDocuments.set(documentTitle, text);
        await writeFile(resolve(stageInput, documentTitle), text, "utf8");
        manifest.push({ documentTitle, sourceId: source.id, locator, contentSha256: sha256(text) });
        documentCount += 1;
      }
      const contentSha256 = sha256(xml);
      prepared.push({
        spec: source,
        contentRef: repositoryRelative(resolve(sourceDirectory, source.content.fileName), contentReferenceRoot),
        contentSha256,
        documentCount,
      });
    }

    await ensureManagedInput(inputDirectory, manifestPath);
    await Promise.all([mkdir(sourceDirectory, { recursive: true }), mkdir(inputDirectory, { recursive: true })]);
    for (const source of prepared) {
      if (!source.spec.content) continue;
      await replaceFile(resolve(stageSources, source.spec.content.fileName), resolve(sourceDirectory, source.spec.content.fileName));
    }
    for (const documentTitle of generatedDocuments.keys()) {
      await replaceFile(resolve(stageInput, documentTitle), resolve(inputDirectory, documentTitle));
    }
    await writeJsonAtomic(manifestPath, { schemaVersion: "1.0", packId: spec.packId, entries: manifest });
    await writeJsonAtomic(snapshotPath, {
      schemaVersion: "1.0",
      packId: spec.packId,
      preparedAt: new Date().toISOString(),
      sources: prepared.map((source) => ({
        id: source.spec.id,
        title: source.spec.title,
        identifier: source.spec.identifier,
        version: source.spec.version,
        licenseStatus: source.spec.licenseStatus,
        licenseRef: source.spec.licenseRef,
        specSha256: sourceSpecSha256(source.spec),
        contentRef: source.contentRef,
        contentSha256: source.contentSha256,
        documentCount: source.documentCount,
      })),
    });
    return { packId: spec.packId, root, manifestPath, snapshotPath, sources: prepared, documents: manifest.length };
  } finally {
    await rm(stageDirectory, { recursive: true, force: true });
  }
}

async function readSourceSnapshot(path: string, packId: string): Promise<Map<string, SourceSnapshotEntry>> {
  try {
    const snapshot = JSON.parse(await readFile(path, "utf8")) as {
      packId?: string;
      sources?: SourceSnapshotEntry[];
    };
    if (snapshot.packId !== packId || !Array.isArray(snapshot.sources)) return new Map();
    return new Map(snapshot.sources.map((source) => [source.id, source]));
  } catch {
    return new Map();
  }
}

async function readVerifiedCachedSource(
  source: KnowledgeSourceSpec,
  sourceDirectory: string,
  snapshot: Map<string, SourceSnapshotEntry>,
): Promise<Buffer | null> {
  const previous = snapshot.get(source.id);
  if (!source.content || !previous?.specSha256 || previous.specSha256 !== sourceSpecSha256(source) || !previous.contentSha256) return null;
  try {
    const xml = await readFile(resolve(sourceDirectory, source.content.fileName));
    if (sha256(xml) !== previous.contentSha256) return null;
    return xml;
  } catch {
    return null;
  }
}

export async function registerKnowledgeSources(pool: Pool, pack: PreparedKnowledgePack): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const prepared of pack.sources) {
      const source = prepared.spec;
      await client.query(
        `INSERT INTO knowledge_sources
          (id, title, source_type, crop, regions, varieties, stages, capabilities, authors, publisher,
           source_url, identifier_type, identifier, publication_year, version, effective_at, license_status,
           status, content_ref, content_sha256, license_ref, license_note)
         VALUES ($1,$2,$3,'corn',$4,'{}',$5,$6,$7,$8,$9,$10,$11,$12,$13,NULL,$14,$15,$16,$17,$18,$19)
         ON CONFLICT (id) DO NOTHING`,
        [
          source.id, source.title, source.sourceType, source.regions, source.stages, source.capabilities,
          source.authors, source.publisher, source.sourceUrl, source.identifierType, source.identifier,
          source.publicationYear, source.version, source.licenseStatus, source.content ? "published" : "catalogued",
          prepared.contentRef, prepared.contentSha256, source.licenseRef, source.licenseNote,
        ],
      );
      const existing = await client.query(
        `SELECT title, version, identifier, license_status, license_ref, content_ref, content_sha256, regions, stages, capabilities
           FROM knowledge_sources WHERE id = $1`,
        [source.id],
      );
      const row = existing.rows[0] as Record<string, unknown> | undefined;
      if (!row || row.title !== source.title || row.version !== source.version || row.identifier !== source.identifier
        || row.license_status !== source.licenseStatus || row.license_ref !== source.licenseRef
        || row.content_ref !== prepared.contentRef || row.content_sha256 !== prepared.contentSha256
        || JSON.stringify(row.regions) !== JSON.stringify(source.regions)
        || JSON.stringify(row.stages) !== JSON.stringify(source.stages)
        || JSON.stringify(row.capabilities) !== JSON.stringify(source.capabilities)) {
        throw new Error(`Knowledge source ${source.id} already exists with a different immutable snapshot.`);
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function verifyCrossref(source: KnowledgeSourceSpec, fetcher: typeof fetch): Promise<CrossrefWork> {
  if (source.identifierType !== "doi") throw new Error(`Full-text source ${source.id} must have a DOI.`);
  const response = await fetcher(`https://api.crossref.org/works/${encodeURIComponent(source.identifier)}`, {
    headers: { "user-agent": "ChernozemAgent knowledge-pack/1.0" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Crossref verification failed for ${source.identifier}: HTTP ${response.status}.`);
  const payload = await response.json() as { message?: CrossrefWork };
  const work = payload.message;
  if (!work || work.DOI?.toLowerCase() !== source.identifier.toLowerCase()) throw new Error(`Crossref DOI mismatch for ${source.identifier}.`);
  if (normalizeComparable(work.title?.[0] ?? "") !== normalizeComparable(source.title)) throw new Error(`Crossref title mismatch for ${source.identifier}.`);
  if (work.publisher !== source.publisher) throw new Error(`Crossref publisher mismatch for ${source.identifier}.`);
  if (!work.license?.some((license) => normalizeLicense(license.URL) === normalizeLicense(source.licenseRef))) {
    throw new Error(`Crossref license mismatch for ${source.identifier}.`);
  }
  return work;
}

async function downloadSource(source: KnowledgeSourceSpec, fetcher: typeof fetch): Promise<Buffer> {
  const content = source.content!;
  const failures: string[] = [];
  for (const rawUrl of content.urls) {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:" || url.hostname !== "mdpi-res.com") throw new Error(`Untrusted knowledge content host: ${url.hostname}`);
    try {
      const response = await fetcher(url, { signal: AbortSignal.timeout(60_000) });
      if (!response.ok) {
        failures.push(`${url.hostname}: HTTP ${response.status}`);
        continue;
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length < 1_000 || !bytes.subarray(0, 100).toString("utf8").includes("<?xml")) {
        failures.push(`${url.hostname}: response is not JATS XML`);
        continue;
      }
      return bytes;
    } catch (error) {
      failures.push(`${url.hostname}: ${error instanceof Error ? error.message : "download failed"}`);
    }
  }
  throw new Error(`Unable to download ${source.identifier}: ${failures.join("; ")}`);
}

function verifyJatsArticle(source: KnowledgeSourceSpec, article: JatsElement): void {
  const front = requiredChild(article, "front");
  const meta = requiredChild(front, "article-meta");
  const doiValues = childElements(meta, "article-id")
    .filter((entry) => entry.attributes["pub-id-type"] === "doi")
    .map(elementText);
  const title = elementText(requiredChild(requiredChild(meta, "title-group"), "article-title"));
  if (!doiValues.some((doi) => doi.toLowerCase() === source.identifier.toLowerCase())) throw new Error(`JATS DOI mismatch for ${source.identifier}.`);
  if (normalizeComparable(title) !== normalizeComparable(source.title)) throw new Error(`JATS title mismatch for ${source.identifier}.`);
  const licenseText = elementText(firstChild(meta, "permissions"));
  const expectedLicenseVersion = source.licenseRef?.match(/by\/(\d+\.\d+)/)?.[1];
  if (!expectedLicenseVersion || !licenseText.includes("Creative Commons Attribution") || !licenseText.includes(expectedLicenseVersion)) {
    throw new Error(`JATS license statement mismatch for ${source.identifier}.`);
  }
}

function findJatsSection(article: JatsElement, selector: SectionSelector): JatsElement {
  const body = requiredChild(article, "body");
  const sections = descendants(body, "sec");
  const matches = sections.filter((section) => selector.id
    ? section.attributes.id === selector.id
    : normalizeComparable(elementText(firstChild(section, "title"))) === normalizeComparable(selector.title ?? ""));
  if (matches.length !== 1) throw new Error(`JATS section selector ${JSON.stringify(selector)} matched ${matches.length} sections.`);
  return matches[0]!;
}

function parseJats(xml: Buffer): JatsElement {
  const parser = new XMLParser({
    preserveOrder: true,
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    textNodeName: "#text",
    trimValues: false,
    parseTagValue: false,
    parseAttributeValue: false,
  });
  const parsed = parser.parse(xml.toString("utf8")) as unknown;
  const roots = orderedElements(parsed);
  const articles = roots.filter((element) => element.name === "article");
  if (articles.length !== 1) throw new Error(`JATS document must contain exactly one article; found ${articles.length}.`);
  return articles[0]!;
}

function sectionBody(section: JatsElement): string {
  const lines: string[] = [];
  appendSection(section, lines);
  return lines.map(cleanText).filter(Boolean).join("\n\n");
}

function appendSection(section: JatsElement, lines: string[]): void {
  const title = elementText(firstChild(section, "title"));
  if (title) lines.push(title);
  for (const child of section.children) {
    if (typeof child === "string" || child.name === "title" || EXCLUDED_JATS_ELEMENTS.has(child.name)) continue;
    if (child.name === "sec") {
      appendSection(child, lines);
      continue;
    }
    if (!["p", "list", "boxed-text"].includes(child.name)) continue;
    const text = elementText(child);
    if (text) lines.push(text);
  }
}

function knowledgeDocument(source: KnowledgeSourceSpec, locator: string, body: string, publisher: string): string {
  return [
    `Source: ${source.title}`,
    `Authors: ${source.authors.join("; ")}`,
    `Publisher: ${publisher}`,
    `Year: ${source.publicationYear}`,
    `DOI: ${source.identifier}`,
    `License: ${source.licenseRef}`,
    `Locator: ${locator}`,
    `Regions: ${source.regions.join("; ")}`,
    `Maize stages: ${source.stages.join("; ")}`,
    "",
    body,
    "",
  ].join("\n");
}

async function ensureManagedInput(inputDirectory: string, manifestPath: string): Promise<void> {
  let existing: string[] = [];
  try { existing = (await readdir(inputDirectory)).filter((name) => name.endsWith(".txt")); } catch { return; }
  if (!existing.length) return;
  let managed = new Set<string>();
  try {
    const previous = JSON.parse(await readFile(manifestPath, "utf8")) as { entries?: ManifestEntry[] };
    managed = new Set(previous.entries?.map((entry) => entry.documentTitle) ?? []);
  } catch {
    throw new Error("GraphRAG input contains text files but has no readable managed manifest.");
  }
  const unmanaged = existing.filter((name) => !managed.has(name));
  if (unmanaged.length) throw new Error(`GraphRAG input contains unmanaged files: ${unmanaged.join(", ")}`);
  await Promise.all(existing.map((name) => rm(resolve(inputDirectory, name), { force: true })));
}

async function replaceFile(source: string, target: string): Promise<void> {
  await rm(target, { force: true });
  await rename(source, target);
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await replaceFile(temporary, path);
}

const EXCLUDED_JATS_ELEMENTS = new Set(["xref", "fig", "table-wrap", "disp-formula", "supplementary-material"]);

function elementText(element: JatsElement | undefined): string {
  if (!element) return "";
  const text = element.children.map((child) => {
    if (typeof child === "string") return child;
    return EXCLUDED_JATS_ELEMENTS.has(child.name) ? "" : elementText(child);
  }).join("");
  return cleanText(text);
}

function orderedElements(value: unknown): JatsElement[] {
  if (!Array.isArray(value)) return [];
  const elements: JatsElement[] = [];
  for (const node of value) {
    const object = objectValue(node);
    if (!object) continue;
    const rawAttributes = objectValue(object[":@"]);
    const attributes = Object.fromEntries(Object.entries(rawAttributes ?? {}).map(([key, attribute]) => [
      key.startsWith("@_") ? key.slice(2) : key,
      String(attribute),
    ]));
    for (const [name, children] of Object.entries(object)) {
      if (name === ":@" || name === "#text") continue;
      elements.push({ name, attributes, children: orderedContent(children) });
    }
  }
  return elements;
}

function orderedContent(value: unknown): Array<JatsElement | string> {
  if (!Array.isArray(value)) return [];
  const content: Array<JatsElement | string> = [];
  for (const node of value) {
    const object = objectValue(node);
    if (!object) continue;
    if (object["#text"] !== undefined) content.push(String(object["#text"]));
    content.push(...orderedElements([node]));
  }
  return content;
}

function childElements(element: JatsElement, name: string): JatsElement[] {
  return element.children.filter((child): child is JatsElement => typeof child !== "string" && child.name === name);
}

function firstChild(element: JatsElement, name: string): JatsElement | undefined {
  return childElements(element, name)[0];
}

function requiredChild(element: JatsElement, name: string): JatsElement {
  const matches = childElements(element, name);
  if (matches.length !== 1) throw new Error(`JATS ${element.name} must contain exactly one ${name}; found ${matches.length}.`);
  return matches[0]!;
}

function descendants(element: JatsElement, name: string): JatsElement[] {
  const matches: JatsElement[] = [];
  for (const child of element.children) {
    if (typeof child === "string") continue;
    if (child.name === name) matches.push(child);
    matches.push(...descendants(child, name));
  }
  return matches;
}

function cleanText(value: string): string {
  // preserveOrder can leave numeric JATS entities in text nodes. Decode Unicode,
  // rather than weakening DOI/title verification to accept mismatched metadata.
  return value.replace(/&#(x[0-9a-f]+|[0-9]+);/gi, (entity, code: string) => {
    const point = code.toLowerCase().startsWith("x") ? Number.parseInt(code.slice(1), 16) : Number.parseInt(code, 10);
    return point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : entity;
  }).replace(/\s+/g, " ").replace(/\s+([,.;:!?])/g, "$1").trim();
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function arrayValue<T = unknown>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function normalizeComparable(value: string): string {
  return value.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function normalizeLicense(value: string | null | undefined): string {
  return (value ?? "").replace(/^http:/, "https:").replace(/\/$/, "").toLowerCase();
}

function slug(value: string): string {
  const candidate = value.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return candidate.slice(0, 80) || `section-${sha256(value).slice(0, 10)}`;
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sourceSpecSha256(source: KnowledgeSourceSpec): string {
  return sha256(JSON.stringify(source));
}

function repositoryRelative(path: string, root: string): string {
  const result = relative(resolve(root), path).replaceAll("\\", "/");
  if (!result || result.startsWith("../") || result === ".." || /^[a-z]:\//i.test(result)) {
    throw new Error(`Knowledge content is outside the repository: ${path}`);
  }
  return result;
}
