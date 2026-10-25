import json
import os
import sys
import tempfile
import zipfile

import rasterio
from rasterio.mask import mask
from rasterio.warp import transform_geom


def closed_geometry(boundary: list[dict[str, float]]) -> dict:
    coordinates = [[point["longitude"], point["latitude"]] for point in boundary]
    if coordinates[0] != coordinates[-1]:
        coordinates.append(coordinates[0])
    return {"type": "Polygon", "coordinates": [coordinates]}


def find_dem(directory: str) -> str:
    candidates = []
    for root, _, files in os.walk(directory):
        for name in files:
            lower = name.lower()
            if lower.endswith((".tif", ".tiff")) and ("dem" in lower or "dsm" in lower):
                candidates.append(os.path.join(root, name))
    if not candidates:
        raise RuntimeError("GLO-30 archive does not contain a DEM GeoTIFF")
    return sorted(candidates, key=os.path.getsize, reverse=True)[0]


def main() -> None:
    target = sys.argv[1]
    payload = json.load(sys.stdin)
    partial = f"{target}.partial"
    with tempfile.TemporaryDirectory() as directory:
        with zipfile.ZipFile(payload["archive"]) as archive:
            archive.extractall(directory)
        source_path = find_dem(directory)
        with rasterio.open(source_path) as source:
            geometry = transform_geom("EPSG:4326", source.crs, closed_geometry(payload["boundary"]), precision=8)
            data, transform = mask(source, [geometry], crop=True, all_touched=True)
            profile = source.profile.copy()
            profile.update(driver="GTiff", height=data.shape[1], width=data.shape[2], transform=transform, compress="deflate", tiled=False)
            profile.pop("blockxsize", None)
            profile.pop("blockysize", None)
            with rasterio.open(partial, "w", **profile) as output:
                output.write(data)
        with rasterio.open(partial) as result:
            if result.count < 1 or result.width < 1 or result.height < 1:
                raise RuntimeError("cropped DEM is empty")
        os.replace(partial, target)


if __name__ == "__main__":
    main()
