import type { AnalysisObjective, DataProfile, DataSource } from "@chernozem/contracts";

export const PROFILE_SOURCES: Record<DataProfile, DataSource[]> = {
  field_baseline_v1: ["sentinel-2", "sentinel-1", "copernicus-dem", "era5-land", "ecmwf-ifs", "soilgrids-250m"],
  growth_stage_v1: ["sentinel-2"],
  water_nitrogen_v1: ["sentinel-2", "sentinel-1", "copernicus-dem", "era5-land", "soilgrids-250m"],
  waterlogging_v1: ["sentinel-1", "copernicus-dem", "era5-land"],
  frost_risk_v1: ["copernicus-dem", "era5-land", "ecmwf-ifs"],
};

export const OBJECTIVE_DATA_PROFILE: Record<AnalysisObjective, DataProfile> = {
  growth_stage_monitoring: "growth_stage_v1",
  water_nitrogen_diagnosis: "water_nitrogen_v1",
  waterlogging_detection: "waterlogging_v1",
  frost_risk_warning: "frost_risk_v1",
};

export const DATA_SOURCE_LABELS: Record<DataSource, string> = {
  "sentinel-1": "Sentinel-1 雷达",
  "sentinel-2": "Sentinel-2 光学",
  "copernicus-dem": "Copernicus DEM",
  "era5-land": "ERA5-Land 历史天气",
  "ecmwf-ifs": "ECMWF IFS 天气预报",
  "soilgrids-250m": "SoilGrids 土壤背景",
};

export function isDataProfile(value: unknown): value is DataProfile {
  return typeof value === "string" && Object.hasOwn(PROFILE_SOURCES, value);
}
