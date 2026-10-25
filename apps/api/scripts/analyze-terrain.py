import json
import math
import os
import sys

import numpy as np
import rasterio
from PIL import Image
from rasterio.features import geometry_mask, shapes
from rasterio.transform import array_bounds
from rasterio.warp import transform_geom
from rasterio.warp import transform_bounds
from rasterio.windows import transform as window_transform

from raster_presentation import pixel_size_meters, resize_for_presentation


ELEVATION_PALETTE = [(0.0, (46, 94, 158)), (0.45, (103, 166, 118)), (0.7, (218, 190, 88)), (1.0, (155, 76, 47))]
SLOPE_PALETTE = [(0.0, (242, 245, 232)), (0.5, (190, 211, 137)), (1.0, (112, 67, 47))]
LOWLAND_PALETTE = [(0.0, (41, 95, 168)), (0.5, (244, 239, 190)), (1.0, (194, 74, 52))]
MIN_LOWLAND_RELATIVE_DEPTH_M = 0.5


def colorize(values, valid, minimum, maximum, palette):
    normalized = np.clip((values - minimum) / max(maximum - minimum, 1e-6), 0, 1)
    rgba = np.zeros((*values.shape, 4), dtype=np.uint8)
    for index in range(len(palette) - 1):
        start, start_color = palette[index]
        end, end_color = palette[index + 1]
        segment = valid & (normalized >= start) & (normalized <= end if index == len(palette) - 2 else normalized < end)
        if not np.any(segment):
            continue
        ratio = (normalized[segment] - start) / max(end - start, 1e-6)
        for channel in range(3):
            rgba[..., channel][segment] = np.round(start_color[channel] + (end_color[channel] - start_color[channel]) * ratio).astype(np.uint8)
    rgba[..., 3][valid] = 220
    return rgba


def write_visualization(output_dir, file_name, values, valid, transform, crs, minimum, maximum, palette, metric, label):
    rows, columns = np.where(valid)
    if rows.size == 0 or columns.size == 0 or not output_dir:
        return None
    y0, y1 = int(rows.min()), int(rows.max()) + 1
    x0, x1 = int(columns.min()), int(columns.max()) + 1
    image = Image.fromarray(colorize(values[y0:y1, x0:x1], valid[y0:y1, x0:x1], minimum, maximum, palette), mode="RGBA")
    image = resize_for_presentation(image)
    os.makedirs(output_dir, exist_ok=True)
    image.save(os.path.join(output_dir, file_name), format="PNG", optimize=True)
    crop_transform = window_transform(rasterio.windows.Window(x0, y0, x1 - x0, y1 - y0), transform)
    west, south, east, north = array_bounds(y1 - y0, x1 - x0, crop_transform)
    left, bottom, right, top = transform_bounds(crs, "EPSG:4326", west, south, east, north, densify_pts=21)
    return {"fileName": file_name, "metric": metric, "label": label, "bounds": [[left, top], [right, top], [right, bottom], [left, bottom]], "min": minimum, "max": maximum, "resolutionMeters": pixel_size_meters(crop_transform, crs, (top + bottom) / 2)}


def main():
    request = json.load(sys.stdin)
    output_dir = request.get("outputDir")
    with rasterio.open(request["path"]) as dataset:
        elevation_band = dataset.read(1, masked=True)
        elevation = elevation_band.filled(np.nan).astype(np.float32)
        geometry = {
            "type": "Polygon",
            "coordinates": [[[point["longitude"], point["latitude"]] for point in request["boundary"]]],
        }
        if str(dataset.crs) != "EPSG:4326":
            geometry = transform_geom("EPSG:4326", dataset.crs, geometry)
        footprint = geometry_mask([geometry], out_shape=elevation.shape, transform=dataset.transform, invert=True)
        transform = dataset.transform
        crs = dataset.crs
    valid = footprint & ~np.ma.getmaskarray(elevation_band) & np.isfinite(elevation) & (elevation > -500)
    total = int(footprint.sum())
    count = int(valid.sum())
    if count == 0:
        print(json.dumps({"status": "needs_data", "metrics": None, "zones": [], "error": {"code": "no_terrain_coverage", "message": "No valid DEM pixels cover the field."}}, separators=(",", ":")))
        return
    values = elevation[valid]
    low_threshold = float(np.percentile(values, 25))
    if crs and crs.is_projected:
        x_meters = math.hypot(transform.a, transform.d)
        y_meters = math.hypot(transform.b, transform.e)
    else:
        latitude = sum(point["latitude"] for point in request["boundary"][:-1]) / max(1, len(request["boundary"]) - 1)
        x_meters = math.hypot(transform.a, transform.d) * 111320 * math.cos(math.radians(latitude))
        y_meters = math.hypot(transform.b, transform.e) * 110540
    filled = np.where(valid, elevation, float(np.mean(values)))
    gradient_y, gradient_x = np.gradient(filled, max(y_meters, 0.1), max(x_meters, 0.1))
    slope = np.degrees(np.arctan(np.sqrt(gradient_x ** 2 + gradient_y ** 2)))
    zones = []
    height, width = elevation.shape
    for row in range(3):
        for column in range(3):
            y0, y1 = row * height // 3, (row + 1) * height // 3
            x0, x1 = column * width // 3, (column + 1) * width // 3
            zone_valid = valid[y0:y1, x0:x1]
            zone_count = int(zone_valid.sum())
            if zone_count == 0:
                continue
            subset = valid[y0:y1, x0:x1].astype(np.uint8)
            window = rasterio.windows.Window(x0, y0, x1 - x0, y1 - y0)
            geometries = [item for item, value in shapes(subset, mask=subset.astype(bool), transform=window_transform(window, transform)) if value == 1]
            if not geometries:
                continue
            geometry = max(geometries, key=lambda item: len(item.get("coordinates", [[]])[0]))
            if crs and crs.to_string() != "EPSG:4326":
                geometry = transform_geom(crs, "EPSG:4326", geometry, precision=7)
            ring = geometry["coordinates"][0]
            mean_elevation = float(np.mean(elevation[y0:y1, x0:x1][zone_valid]))
            zones.append({
                "id": f"zone-{row + 1}-{column + 1}",
                "row": row,
                "column": column,
                "class": "normal",
                "meanElevationM": mean_elevation,
                "relativeElevationM": mean_elevation - float(np.mean(values)),
                "meanSlopeDegrees": float(np.mean(slope[y0:y1, x0:x1][zone_valid])),
                "validPixelCount": zone_count,
                "zone": ring,
            })
    zone_low_threshold = float(np.percentile([zone["meanElevationM"] for zone in zones], 25)) if zones else low_threshold
    field_mean = float(np.mean(values))
    for zone in zones:
        zone["class"] = "low" if zone["meanElevationM"] <= zone_low_threshold and zone["meanElevationM"] <= field_mean - MIN_LOWLAND_RELATIVE_DEPTH_M else "normal"
    visualizations = []
    elevation_min, elevation_max = float(np.min(values)), float(np.max(values))
    for item in [
        (elevation, "elevation.png", "elevation", "高程", elevation_min, elevation_max, ELEVATION_PALETTE),
        (slope, "slope.png", "slope", "坡度", 0.0, max(1.0, float(np.percentile(slope[valid], 95))), SLOPE_PALETTE),
        (elevation - float(np.mean(values)), "lowland.png", "lowland", "相对高程", float(np.min(values) - np.mean(values)), float(np.max(values) - np.mean(values)), LOWLAND_PALETTE),
    ]:
        visualization = write_visualization(output_dir, item[1], item[0], valid, transform, crs, item[4], item[5], item[6], item[2], item[3])
        if visualization:
            visualizations.append(visualization)
    print(json.dumps({
        "status": "partial" if count / total < 0.8 else "succeeded",
        "metrics": {
            "minElevationM": float(np.min(values)),
            "meanElevationM": float(np.mean(values)),
            "maxElevationM": float(np.max(values)),
            "meanSlopeDegrees": float(np.mean(slope[valid])),
            "lowElevationThresholdM": zone_low_threshold,
            "minimumLowlandRelativeDepthM": MIN_LOWLAND_RELATIVE_DEPTH_M,
            "validPixelCount": count,
            "totalPixelCount": total,
            "validFraction": count / total,
        },
        "zones": zones,
        "visualizations": visualizations,
        "error": {"code": None, "message": None},
    }, separators=(",", ":")))


if __name__ == "__main__":
    main()
