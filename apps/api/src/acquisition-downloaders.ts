import type { AcquisitionPeriod, Position } from "@chernozem/contracts";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const TOKEN_URL = "https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token";
const PROCESS_URL = "https://sh.dataspace.copernicus.eu/process/v1";
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

export const SENTINEL_2_BANDS = ["B02", "B03", "B04", "B05", "B06", "B07", "B08", "B8A", "B11", "B12", "SCL"] as const;
export const SENTINEL_1_BANDS = ["VV", "VH", "dataMask"] as const;
const SENTINEL_2_NATIVE_GROUPS = [
  { suffix: "spectral-10m", bands: ["B02", "B03", "B04", "B08"] as const, resolution: 10, role: "spectral" as const, sampleType: "UINT16" },
  { suffix: "spectral-20m", bands: ["B05", "B06", "B07", "B8A", "B11", "B12"] as const, resolution: 20, role: "spectral" as const, sampleType: "UINT16" },
  { suffix: "scl-20m", bands: ["SCL"] as const, resolution: 20, role: "quality-mask" as const, sampleType: "UINT8" },
] as const;

export interface RasterDownloadRequest {
  providerAssetId: string;
  boundary: Position[];
  capturedAt: string | null;
  period: AcquisitionPeriod | null;
  target: string;
  orbitDirection?: "ASCENDING" | "DESCENDING" | null;
}

export interface RasterOutputResult {
  target: string;
  format: "GeoTIFF";
  spatialResolutionMeters: number;
  crs: "EPSG:4326";
  bands: readonly string[];
  role: "spectral" | "quality-mask" | "radar";
  pixelQuality: RasterPixelQuality | null;
}

export interface RasterPixelQuality {
  totalPixelCount: number;
  validPixelCount: number;
  validPixelFraction: number;
  cloudAffectedPixelCount: number;
  cloudAffectedFraction: number;
  sclClassHistogram: Record<string, number>;
}

export interface RasterDownloadResult {
  outputs: RasterOutputResult[];
}

export interface CdseRasterDownloader {
  retrieve(source: "sentinel-1" | "sentinel-2", request: RasterDownloadRequest): Promise<RasterDownloadResult>;
  inspectQualityMask?(target: string): Promise<RasterPixelQuality>;
}

export class SentinelHubProcessDownloader implements CdseRasterDownloader {
  private token: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly pythonExecutable = "python",
  ) {}

  async retrieve(source: "sentinel-1" | "sentinel-2", request: RasterDownloadRequest): Promise<RasterDownloadResult> {
    const token = await this.accessToken();
    const groups = source === "sentinel-2"
      ? SENTINEL_2_NATIVE_GROUPS
      : [{ suffix: "radar-10m", bands: SENTINEL_1_BANDS, resolution: 10, role: "radar" as const, sampleType: "FLOAT32" }];
    const outputs: RasterOutputResult[] = [];
    for (const group of groups) {
      const target = suffixedTarget(request.target, group.suffix);
      const body = processRequest(source, request, group.resolution, group.bands, group.sampleType);
      let response: Response;
      try {
        response = await fetch(PROCESS_URL, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "image/tiff" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
        });
      } catch (error) {
        throw new DownloadError(503, `CDSE Process API 连接失败：${networkErrorMessage(error)}`);
      }
      if (!response.ok) throw new DownloadError(response.status, await responseMessage(response, "CDSE Process API 请求失败。"));
      await writeValidatedGeoTiff(response, target);
      const pixelQuality = await validateRasterPixels(this.pythonExecutable, target, source, group.role);
      outputs.push({ target, format: "GeoTIFF", spatialResolutionMeters: group.resolution, crs: "EPSG:4326", bands: group.bands, role: group.role, pixelQuality });
    }
    return { outputs };
  }

  async inspectQualityMask(target: string): Promise<RasterPixelQuality> {
    const summary = await validateRasterPixels(this.pythonExecutable, target, "sentinel-2", "quality-mask");
    if (!summary) throw new DownloadError(502, "Sentinel-2 SCL 质量摘要缺失。");
    return summary;
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const body = new URLSearchParams({ grant_type: "client_credentials", client_id: this.clientId, client_secret: this.clientSecret });
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new DownloadError(response.status, await responseMessage(response, "CDSE OAuth 客户端认证失败。"));
    const payload = await response.json() as { access_token?: unknown; expires_in?: unknown };
    if (typeof payload.access_token !== "string") throw new DownloadError(502, "CDSE OAuth 响应缺少 access_token。");
    const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : 600;
    this.token = { value: payload.access_token, expiresAt: Date.now() + expiresIn * 1000 };
    return payload.access_token;
  }
}

export interface IfsDownloadRequest {
  runAt: string;
  longitude: number;
  latitude: number;
  target: string;
}

export interface DemDownloadRequest {
  providerAssetId: string;
  boundary: Position[];
  target: string;
}

export interface CopernicusDemDownloader {
  retrieve(request: DemDownloadRequest): Promise<void>;
}

export class NativeCopernicusDemDownloader implements CopernicusDemDownloader {
  private token: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly username: string,
    private readonly password: string,
    private readonly pythonExecutable: string,
  ) {}

  async retrieve(request: DemDownloadRequest): Promise<void> {
    const token = await this.accessToken();
    const url = `https://download.dataspace.copernicus.eu/odata/v1/Products(${encodeURIComponent(request.providerAssetId)})/$value`;
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
      redirect: "follow",
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!response.ok) throw new DownloadError(response.status, await responseMessage(response, "Copernicus DEM 原生瓦片下载失败。"));
    const archiveTarget = `${request.target}.zip.partial`;
    await writeResponseFile(response, archiveTarget);
    try {
      await runPythonWorker(this.pythonExecutable, "crop-copernicus-dem.py", request.target, { archive: archiveTarget, boundary: request.boundary }, 15 * 60_000);
    } finally {
      await rm(archiveTarget, { force: true });
    }
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const body = new URLSearchParams({ grant_type: "password", client_id: "cdse-public", username: this.username, password: this.password });
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new DownloadError(response.status, await responseMessage(response, "CDSE 账户认证失败。"));
    const payload = await response.json() as { access_token?: unknown; expires_in?: unknown };
    if (typeof payload.access_token !== "string") throw new DownloadError(502, "CDSE 账户认证响应缺少 access_token。");
    const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : 600;
    this.token = { value: payload.access_token, expiresAt: Date.now() + expiresIn * 1000 };
    return payload.access_token;
  }
}

export interface IfsPointDownloader {
  retrieve(request: IfsDownloadRequest): Promise<void>;
}

export class PythonIfsPointDownloader implements IfsPointDownloader {
  constructor(private readonly pythonExecutable: string) {}
  async retrieve(request: IfsDownloadRequest): Promise<void> {
    try {
      await runPythonWorker(this.pythonExecutable, "download-ifs-point.py", request.target, request, 30 * 60_000);
    } finally {
      // The ECMWF client keeps the GRIB handle until process exit on Windows.
      await rm(`${request.target}.grib2.partial`, { force: true });
    }
  }
}

export interface SoilGridsDownloadRequest {
  boundary: Position[];
  targetDirectory: string;
}

export interface SoilGridsFileResult {
  providerAssetId: string;
  fileName: string;
  property: string;
  depth: string;
  quantile: string;
  spatialResolutionMeters: number;
  crs: string;
}

export interface SoilGridsDownloader {
  retrieve(request: SoilGridsDownloadRequest): Promise<SoilGridsFileResult[]>;
}

export class PythonSoilGridsDownloader implements SoilGridsDownloader {
  constructor(private readonly pythonExecutable: string) {}
  async retrieve(request: SoilGridsDownloadRequest): Promise<SoilGridsFileResult[]> {
    const manifestTarget = resolve(request.targetDirectory, "soilgrids-manifest.json");
    try {
      await runPythonWorker(this.pythonExecutable, "download-soilgrids.py", manifestTarget, request, 45 * 60_000);
      const manifest = JSON.parse(await import("node:fs/promises").then(({ readFile }) => readFile(manifestTarget, "utf8"))) as unknown;
      if (!Array.isArray(manifest) || !manifest.every(isSoilGridsFileResult)) throw new DownloadError(502, "SoilGrids worker 返回了无效产物清单。");
      await rm(manifestTarget, { force: true });
      return manifest;
    } catch (error) {
      await rm(request.targetDirectory, { recursive: true, force: true });
      throw error;
    }
  }
}

export async function fileMetadata(path: string): Promise<{ byteSize: number; checksum: string }> {
  const fileStat = await stat(path);
  if (!fileStat.isFile() || fileStat.size === 0) throw new DownloadError(502, "数据源返回了空文件。");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return { byteSize: fileStat.size, checksum: `sha256:${hash.digest("hex")}` };
}

export class DownloadError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function processRequest(
  source: "sentinel-1" | "sentinel-2",
  request: RasterDownloadRequest,
  resolution: number,
  bands: readonly string[],
  sampleType: string,
) {
  const dimensions = outputDimensions(request.boundary, resolution);
  const geometry = { type: "Polygon", coordinates: [closedRing(request.boundary).map((point) => [point.longitude, point.latitude])] };
  const inputData = source === "sentinel-2"
    ? [{ type: "sentinel-2-l2a", dataFilter: { timeRange: observationRange(request), mosaickingOrder: "mostRecent" } }]
    : [{
          type: "sentinel-1-grd",
          dataFilter: {
            timeRange: observationRange(request), acquisitionMode: "IW", polarization: "DV", resolution: "HIGH", mosaickingOrder: "mostRecent",
            ...(request.orbitDirection ? { orbitDirection: request.orbitDirection } : {}),
          },
          processing: { orthorectify: true, backCoeff: "GAMMA0_TERRAIN", demInstance: "COPERNICUS_30" },
        }];
  return {
    input: { bounds: { geometry, properties: { crs: "http://www.opengis.net/def/crs/OGC/1.3/CRS84" } }, data: inputData },
    output: { ...dimensions, responses: [{ identifier: "default", format: { type: "image/tiff" } }] },
    evalscript: evalscript(bands, sampleType, source === "sentinel-2" ? "DN" : null),
  };
}

function evalscript(bands: readonly string[], sampleType: string, units: string | null): string {
  const input = units ? `[{bands:${JSON.stringify(bands)},units:"${units}"}]` : JSON.stringify(bands);
  return `//VERSION=3
function setup(){return{input:${input},output:{bands:${bands.length},sampleType:"${sampleType}"}}}
function evaluatePixel(s){return [${bands.map((band) => `s.${band}`).join(",")}]} `;
}

function suffixedTarget(target: string, suffix: string): string {
  return target.toLowerCase().endsWith(".tif") ? `${target.slice(0, -4)}_${suffix}.tif` : `${target}_${suffix}.tif`;
}

function observationRange(request: RasterDownloadRequest): { from: string; to: string } {
  if (!request.capturedAt) {
    if (!request.period) throw new DownloadError(422, "动态影像请求缺少观测时间范围。");
    return { from: request.period.start, to: request.period.end };
  }
  const captured = new Date(request.capturedAt);
  if (Number.isNaN(captured.getTime())) throw new DownloadError(422, "动态影像请求的观测时间无效。");
  const dayStart = new Date(Date.UTC(captured.getUTCFullYear(), captured.getUTCMonth(), captured.getUTCDate()));
  return { from: dayStart.toISOString(), to: new Date(dayStart.getTime() + 86_400_000 - 1).toISOString() };
}

async function validateRasterPixels(
  pythonExecutable: string,
  target: string,
  source: "sentinel-1" | "sentinel-2",
  role: "spectral" | "quality-mask" | "radar",
): Promise<RasterPixelQuality | null> {
  try {
    const output = await runPythonWorker(pythonExecutable, "validate-acquired-raster.py", target, { source, role }, 30_000);
    if (role !== "quality-mask") return null;
    const summary = JSON.parse(output) as RasterPixelQuality;
    if (!isRasterPixelQuality(summary)) throw new DownloadError(502, "Sentinel-2 SCL 质量摘要无效。");
    return summary;
  } catch (error) {
    await rm(target, { force: true });
    throw error;
  }
}

function isRasterPixelQuality(value: unknown): value is RasterPixelQuality {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return ["totalPixelCount", "validPixelCount", "validPixelFraction", "cloudAffectedPixelCount", "cloudAffectedFraction"]
    .every((key) => typeof item[key] === "number" && Number.isFinite(item[key]));
}

function outputDimensions(boundary: Position[], resolutionMeters: number): { width: number; height: number } {
  const longitudes = boundary.map((point) => point.longitude);
  const latitudes = boundary.map((point) => point.latitude);
  const middleLatitude = (Math.min(...latitudes) + Math.max(...latitudes)) / 2;
  const widthMeters = (Math.max(...longitudes) - Math.min(...longitudes)) * 111_320 * Math.cos(middleLatitude * Math.PI / 180);
  const heightMeters = (Math.max(...latitudes) - Math.min(...latitudes)) * 110_540;
  const width = Math.max(1, Math.ceil(widthMeters / resolutionMeters));
  const height = Math.max(1, Math.ceil(heightMeters / resolutionMeters));
  if (width > 2500 || height > 2500) throw new DownloadError(422, "地块范围超过同步 Process API 单次 2500 像素限制，需要分块采集。" );
  return { width, height };
}

function closedRing(boundary: Position[]): Position[] {
  const first = boundary[0];
  const last = boundary.at(-1);
  if (!first) throw new DownloadError(422, "地块边界为空。");
  return last && first.longitude === last.longitude && first.latitude === last.latitude ? boundary : [...boundary, first];
}

async function writeValidatedGeoTiff(response: Response, target: string): Promise<void> {
  const bytes = new Uint8Array(await response.arrayBuffer());
  const isTiff = bytes.length >= 4 && ((bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00)
    || (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a));
  if (!isTiff) throw new DownloadError(502, "CDSE Process API 未返回有效 GeoTIFF。" );
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.partial`;
  try {
    await writeFile(temporary, bytes);
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function writeResponseFile(response: Response, target: string): Promise<void> {
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length === 0) throw new DownloadError(502, "数据源返回了空文件。");
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes);
}

function runPythonWorker(pythonExecutable: string, scriptName: string, target: string, payload: unknown, timeoutMs: number): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const script = resolve(import.meta.dirname, "../scripts", scriptName);
    const child = spawn(pythonExecutable, [script, target], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, PYTHONUTF8: "1" },
    });
    let stderr = "";
    let stdout = "";
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.stderr.setEncoding("utf8");
    child.stdout.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-8_000); });
    child.stdout.on("data", (chunk: string) => { stdout = `${stdout}${chunk}`.slice(-32_000); });
    child.once("error", (error) => { clearTimeout(timeout); reject(new DownloadError(503, `无法启动 ${scriptName}：${error.message}`)); });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) return resolvePromise(stdout.trim());
      if (timedOut) return reject(new DownloadError(504, `${scriptName} 执行超时。`));
      reject(new DownloadError(503, workerErrorMessage(scriptName, stderr)));
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

function workerErrorMessage(scriptName: string, stderr: string): string {
  const lastLine = stderr.trim().split(/\r?\n/).at(-1);
  return lastLine ? `${scriptName} 执行失败：${lastLine.slice(0, 500)}` : `${scriptName} 执行失败。`;
}

function networkErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return "网络请求未完成。";
  const cause = error.cause instanceof Error ? error.cause : null;
  return (cause?.message ?? error.message).slice(0, 300);
}

async function responseMessage(response: Response, fallback: string): Promise<string> {
  const text = (await response.text()).trim();
  return text ? `${fallback} ${text.slice(0, 500)}` : fallback;
}

function isSoilGridsFileResult(value: unknown): value is SoilGridsFileResult {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return ["providerAssetId", "fileName", "property", "depth", "quantile", "crs"].every((key) => typeof item[key] === "string")
    && typeof item.spatialResolutionMeters === "number";
}
