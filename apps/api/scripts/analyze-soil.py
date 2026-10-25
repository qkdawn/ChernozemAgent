import json
import sys

import numpy as np
import rasterio
from rasterio.features import geometry_mask
from rasterio.warp import transform_geom


PROPERTY_META = {
    "phh2o": ("pH", "pH", 10.0),
    "soc": ("土壤有机碳", "g/kg", 10.0),
    "nitrogen": ("全氮", "g/kg", 100.0),
    "sand": ("砂粒", "%", 10.0),
    "silt": ("粉粒", "%", 10.0),
    "clay": ("黏粒", "%", 10.0),
    "bdod": ("容重", "kg/dm3", 100.0),
    "cec": ("阳离子交换量", "cmol(c)/kg", 10.0),
}


def field_geometry(boundary, crs):
    geometry = {
        "type": "Polygon",
        "coordinates": [[[point["longitude"], point["latitude"]] for point in boundary]],
    }
    return transform_geom("EPSG:4326", crs, geometry) if str(crs) != "EPSG:4326" else geometry


def main():
    request = json.load(sys.stdin)
    measurements = []
    for asset in request.get("assets", []):
        with rasterio.open(asset["path"]) as dataset:
            value_band = dataset.read(1, masked=True)
            values = value_band.filled(np.nan).astype(np.float32)
            footprint = geometry_mask(
                [field_geometry(request["boundary"], dataset.crs)],
                out_shape=values.shape,
                transform=dataset.transform,
                invert=True,
                all_touched=True,
            )
            valid = footprint & ~np.ma.getmaskarray(value_band) & np.isfinite(values)
        if not valid.any():
            continue
        property_name = asset["property"]
        label, unit, divisor = PROPERTY_META.get(property_name, (property_name, "raw", 1.0))
        field_values = values[valid] / divisor
        measurements.append({
            "property": property_name,
            "label": label,
            "depth": asset["depth"],
            "unit": unit,
            "mean": float(np.mean(field_values)),
            "min": float(np.min(field_values)),
            "max": float(np.max(field_values)),
            "validPixelCount": int(valid.sum()),
            "totalPixelCount": int(footprint.sum()),
            "validFraction": float(valid.sum() / footprint.sum()),
        })
    partial = len(measurements) < len(request.get("assets", [])) or any(item["validFraction"] < 0.8 for item in measurements)
    print(json.dumps({
        "status": "partial" if measurements and partial else "succeeded" if measurements else "needs_data",
        "measurements": measurements,
        "error": {"code": None, "message": None} if measurements else {"code": "soil_coverage_missing", "message": "No valid SoilGrids pixels cover the field."},
    }, separators=(",", ":")))


if __name__ == "__main__":
    main()
