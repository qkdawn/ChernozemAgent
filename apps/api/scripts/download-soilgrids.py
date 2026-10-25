import json
import http.client
import os
import socket
import sys
import time
import urllib.parse
import urllib.request
import urllib.error
from concurrent.futures import ThreadPoolExecutor

import rasterio
from pyproj import CRS, Transformer


PROPERTIES = ["phh2o", "soc", "nitrogen", "sand", "silt", "clay", "bdod", "cec"]
DEPTHS = ["0-5cm", "5-15cm", "15-30cm", "30-60cm", "60-100cm", "100-200cm"]
QUANTILES = ["Q0.05", "Q0.5", "Q0.95"]
SOILGRIDS_CRS = "+proj=igh +datum=WGS84 +no_defs +towgs84=0,0,0"
MAX_ATTEMPTS = 4
MAX_WORKERS = max(1, min(int(os.environ.get("SOILGRIDS_WORKERS", "2")), 4))


def bounds(boundary: list[dict[str, float]]) -> tuple[float, float, float, float]:
    transformer = Transformer.from_crs("EPSG:4326", SOILGRIDS_CRS, always_xy=True)
    points = [transformer.transform(point["longitude"], point["latitude"]) for point in boundary]
    xs = [point[0] for point in points]
    ys = [point[1] for point in points]
    padding = 250.0
    return min(xs) - padding, min(ys) - padding, max(xs) + padding, max(ys) + padding


def download(url: str, target: str) -> None:
    partial = f"{target}.partial"
    request = urllib.request.Request(url, headers={"User-Agent": "ChernozemAgent/0.1", "Accept": "image/tiff"})
    for attempt in range(MAX_ATTEMPTS):
        try:
            with urllib.request.urlopen(request, timeout=180) as response, open(partial, "wb") as output:
                while chunk := response.read(1024 * 1024):
                    output.write(chunk)
            with rasterio.open(partial, "r+") as dataset:
                if dataset.count < 1 or dataset.width < 1 or dataset.height < 1:
                    raise RuntimeError("SoilGrids returned an empty raster")
                if dataset.crs is None:
                    dataset.crs = CRS.from_proj4(SOILGRIDS_CRS)
            os.replace(partial, target)
            return
        except Exception as error:
            if os.path.exists(partial):
                os.remove(partial)
            if not retryable(error) or attempt == MAX_ATTEMPTS - 1:
                raise
            time.sleep(2 ** attempt)


def retryable(error: Exception) -> bool:
    if isinstance(error, urllib.error.HTTPError):
        return error.code in {408, 429, 500, 502, 503, 504}
    return isinstance(error, (http.client.RemoteDisconnected, urllib.error.URLError, socket.timeout, TimeoutError, ConnectionError))


def run_download_job(job: tuple[str, str, dict]) -> None:
    download(job[0], job[1])


def main() -> None:
    manifest_target = sys.argv[1]
    payload = json.load(sys.stdin)
    target_directory = payload["targetDirectory"]
    os.makedirs(target_directory, exist_ok=True)
    min_x, min_y, max_x, max_y = bounds(payload["boundary"])
    jobs = []
    for property_name in PROPERTIES:
        for depth in DEPTHS:
            for quantile in QUANTILES:
                coverage_id = f"{property_name}_{depth}_{quantile}"
                params = [
                    ("map", f"/map/{property_name}.map"),
                    ("SERVICE", "WCS"),
                    ("VERSION", "2.0.1"),
                    ("REQUEST", "GetCoverage"),
                    ("COVERAGEID", coverage_id),
                    ("FORMAT", "GEOTIFF_INT16"),
                    ("SUBSET", f"X({min_x},{max_x})"),
                    ("SUBSET", f"Y({min_y},{max_y})"),
                    ("SUBSETTINGCRS", "http://www.opengis.net/def/crs/EPSG/0/152160"),
                    ("OUTPUTCRS", "http://www.opengis.net/def/crs/EPSG/0/152160"),
                ]
                url = "https://maps.isric.org/mapserv?" + urllib.parse.urlencode(params)
                file_name = f"{coverage_id}.tif"
                jobs.append((url, os.path.join(target_directory, file_name), {
                    "providerAssetId": coverage_id,
                    "fileName": file_name,
                    "property": property_name,
                    "depth": depth,
                    "quantile": quantile,
                    "spatialResolutionMeters": 250,
                    "crs": "EPSG:152160",
                }))
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        list(executor.map(run_download_job, jobs))
    manifest = [job[2] for job in jobs]
    with open(manifest_target, "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, ensure_ascii=True, separators=(",", ":"))


if __name__ == "__main__":
    main()
