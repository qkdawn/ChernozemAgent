import type { PlanetAccessStatus } from "@chernozem/contracts";

const PLANET_DATA_API = "https://api.planet.com/data/v1/item-types";

export interface PlanetClient {
  checkAccess(): Promise<PlanetAccessStatus>;
}

interface PlanetClientOptions {
  apiKey?: string;
  fetchImpl?: typeof fetch;
}

export function createPlanetClient(options: PlanetClientOptions = {}): PlanetClient {
  const apiKey = options.apiKey ?? process.env.PL_API_KEY ?? process.env.PLANET_API_KEY;
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    async checkAccess(): Promise<PlanetAccessStatus> {
      if (!apiKey) {
        return {
          configured: false,
          reachable: false,
          planetScopeAvailable: false,
          itemTypes: [],
          message: "尚未配置 Planet API 密钥。",
        };
      }

      try {
        const response = await fetchImpl(PLANET_DATA_API, {
          headers: {
            Accept: "application/json",
            Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`,
          },
        });

        if (!response.ok) {
          return {
            configured: true,
            reachable: true,
            planetScopeAvailable: false,
            itemTypes: [],
            message: `Planet 目录请求未通过（HTTP ${response.status}）。请检查密钥和数据产品权限。`,
          };
        }

        const itemTypes = extractItemTypes(await response.json());
        const planetScopeAvailable = itemTypes.includes("PSScene");

        return {
          configured: true,
          reachable: true,
          planetScopeAvailable,
          itemTypes,
          message: planetScopeAvailable
            ? "Planet 目录连接正常，账号可见 PlanetScope PSScene。"
            : "Planet 目录连接正常，但当前账号未返回 PlanetScope PSScene。",
        };
      } catch {
        return {
          configured: true,
          reachable: false,
          planetScopeAvailable: false,
          itemTypes: [],
          message: "无法连接 Planet 目录。请检查网络后重试。",
        };
      }
    },
  };
}

function extractItemTypes(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") return [];

  const candidates = "item_types" in payload ? payload.item_types : payload;
  if (!Array.isArray(candidates)) return [];

  return candidates.flatMap((item) => {
    if (typeof item === "string") return [item];
    if (item && typeof item === "object" && "id" in item && typeof item.id === "string") {
      return [item.id];
    }
    return [];
  });
}
