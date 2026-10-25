import json
import math
import os
import sys

import numpy as np
import rasterio
from PIL import Image
from rasterio.features import geometry_mask, shapes
from rasterio.transform import array_bounds
from rasterio.warp import Resampling, reproject, transform_geom
from rasterio.warp import transform_bounds
from rasterio.windows import transform as window_transform

from raster_presentation import pixel_size_meters, resize_for_presentation


CHANGE_THRESHOLD_DB = 2.0
RADAR_PALETTE = [(0.0, (36, 74, 139)), (0.5, (236, 236, 210)), (1.0, (176, 64, 45))]
CHANGE_PALETTE = [(0.0, (39, 91, 170)), (0.5, (245, 239, 190)), (1.0, (184, 61, 55))]


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
    cropped_values = values[y0:y1, x0:x1]
    cropped_valid = valid[y0:y1, x0:x1]
    image = Image.fromarray(colorize(cropped_values, cropped_valid, minimum, maximum, palette), mode="RGBA")
    image = resize_for_presentation(image)
    os.makedirs(output_dir, exist_ok=True)
    image.save(os.path.join(output_dir, file_name), format="PNG", optimize=True)
    crop_transform = window_transform(rasterio.windows.Window(x0, y0, x1 - x0, y1 - y0), transform)
    west, south, east, north = array_bounds(y1 - y0, x1 - x0, crop_transform)
    left, bottom, right, top = transform_bounds(crs, "EPSG:4326", west, south, east, north, densify_pts=21)
    return {"fileName": file_name, "metric": metric, "label": label, "bounds": [[left, top], [right, top], [right, bottom], [left, bottom]], "min": minimum, "max": maximum, "resolutionMeters": pixel_size_meters(crop_transform, crs, (top + bottom) / 2)}


def polygon(boundary, crs):
    geometry = {
        "type": "Polygon",
        "coordinates": [[[point["longitude"], point["latitude"]] for point in boundary]],
    }
    return transform_geom("EPSG:4326", crs, geometry) if str(crs) != "EPSG:4326" else geometry


def read_aligned(path, shape, transform, crs):
    with rasterio.open(path) as source:
        values = np.full((3, *shape), np.nan, dtype=np.float32)
        for index in range(3):
            reproject(
                source=rasterio.band(source, index + 1),
                destination=values[index],
                src_transform=source.transform,
                src_crs=source.crs,
                dst_transform=transform,
                dst_crs=crs,
                resampling=Resampling.nearest if index == 2 else Resampling.bilinear,
            )
        return values


def zone_geometry(mask, row_start, row_end, col_start, col_end, transform, crs):
    subset = mask[row_start:row_end, col_start:col_end].astype(np.uint8)
    if not subset.any():
        return None
    window = rasterio.windows.Window(col_start, row_start, col_end - col_start, row_end - row_start)
    geometries = [geometry for geometry, value in shapes(
        subset,
        mask=subset.astype(bool),
        transform=window_transform(window, transform),
    ) if value == 1]
    if not geometries:
        return None
    geometry = max(geometries, key=lambda item: len(item.get("coordinates", [[]])[0]))
    if crs and crs.to_string() != "EPSG:4326":
        geometry = transform_geom(crs, "EPSG:4326", geometry, precision=7)
    return geometry["coordinates"][0]


def main():
    request = json.load(sys.stdin)
    output_dir = request.get("outputDir")
    if request.get("mode") == "observation":
        render_observation(request, output_dir)
        return
    with rasterio.open(request["afterPath"]) as after_source:
        after = after_source.read().astype(np.float32)
        shape = (after_source.height, after_source.width)
        transform = after_source.transform
        crs = after_source.crs
        footprint = geometry_mask(
            [polygon(request["boundary"], crs)],
            out_shape=shape,
            transform=transform,
            invert=True,
        )
    before = read_aligned(request["beforePath"], shape, transform, crs)
    valid = (
        footprint
        & (before[2] > 0.5)
        & (after[2] > 0.5)
        & np.isfinite(before[0])
        & np.isfinite(before[1])
        & np.isfinite(after[0])
        & np.isfinite(after[1])
        & (before[0] > 0)
        & (before[1] > 0)
        & (after[0] > 0)
        & (after[1] > 0)
    )
    total = int(footprint.sum())
    valid_count = int(valid.sum())
    if total == 0 or valid_count == 0:
        print(json.dumps({
            "status": "needs_data",
            "quality": {"totalPixelCount": total, "validPixelCount": valid_count, "validFraction": 0},
            "metrics": None,
            "zones": [],
            "error": {"code": "no_radar_coverage", "message": "No valid radar pixels cover the field."},
        }, separators=(",", ":")))
        return

    before_vv = 10 * np.log10(before[0])
    before_vh = 10 * np.log10(before[1])
    after_vv = 10 * np.log10(after[0])
    after_vh = 10 * np.log10(after[1])
    vv_delta = after_vv - before_vv
    vh_delta = after_vh - before_vh
    zones = []
    for row in range(3):
        for column in range(3):
            y0 = row * shape[0] // 3
            y1 = (row + 1) * shape[0] // 3
            x0 = column * shape[1] // 3
            x1 = (column + 1) * shape[1] // 3
            zone_valid = valid[y0:y1, x0:x1]
            count = int(zone_valid.sum())
            if count == 0:
                continue
            zone_vv_delta = float(np.mean(vv_delta[y0:y1, x0:x1][zone_valid]))
            zone_vh_delta = float(np.mean(vh_delta[y0:y1, x0:x1][zone_valid]))
            ring = zone_geometry(valid, y0, y1, x0, x1, transform, crs)
            if ring is None:
                continue
            change_class = "strong_decrease" if zone_vv_delta <= -CHANGE_THRESHOLD_DB else "strong_increase" if zone_vv_delta >= CHANGE_THRESHOLD_DB else "stable"
            zones.append({
                "id": f"zone-{row + 1}-{column + 1}",
                "row": row,
                "column": column,
                "class": change_class,
                "meanVvDeltaDb": zone_vv_delta,
                "meanVhDeltaDb": zone_vh_delta,
                "meanAfterVvDb": float(np.mean(after_vv[y0:y1, x0:x1][zone_valid])),
                "validPixelCount": count,
                "zone": ring,
            })
    changed = valid & ((np.abs(vv_delta) >= CHANGE_THRESHOLD_DB) | (np.abs(vh_delta) >= CHANGE_THRESHOLD_DB))
    visualizations = []
    visualization_specs = [(vv_delta, "vv-change.png", "radar_change", "VV 变化", -5.0, 5.0, CHANGE_PALETTE)]
    if request.get("includeObservationVisualizations", True):
        visualization_specs = [
            (after_vv, "after-vv.png", "vv", "VV 后向散射", -25.0, 0.0, RADAR_PALETTE),
            (after_vh, "after-vh.png", "vh", "VH 后向散射", -35.0, -2.0, RADAR_PALETTE),
            *visualization_specs,
        ]
    for values, file_name, metric, label, minimum, maximum, palette in visualization_specs:
        visualization = write_visualization(output_dir, file_name, values, valid, transform, crs, minimum, maximum, palette, metric, label)
        if visualization:
            visualizations.append(visualization)
    print(json.dumps({
        "status": "succeeded",
        "quality": {"totalPixelCount": total, "validPixelCount": valid_count, "validFraction": valid_count / total},
        "metrics": {
            "beforeVvDb": float(np.mean(before_vv[valid])),
            "afterVvDb": float(np.mean(after_vv[valid])),
            "vvDeltaDb": float(np.mean(vv_delta[valid])),
            "beforeVhDb": float(np.mean(before_vh[valid])),
            "afterVhDb": float(np.mean(after_vh[valid])),
            "vhDeltaDb": float(np.mean(vh_delta[valid])),
            "changedPixelFraction": float(changed.sum() / valid_count),
        },
        "zones": zones,
        "visualizations": visualizations,
        "error": {"code": None, "message": None},
    }, separators=(",", ":")))


def render_observation(request, output_dir):
    with rasterio.open(request["path"]) as source:
        values = source.read().astype(np.float32)
        shape = (source.height, source.width)
        transform = source.transform
        crs = source.crs
        footprint = geometry_mask(
            [polygon(request["boundary"], crs)],
            out_shape=shape,
            transform=transform,
            invert=True,
        )
    valid = (
        footprint
        & (values[2] > 0.5)
        & np.isfinite(values[0])
        & np.isfinite(values[1])
        & (values[0] > 0)
        & (values[1] > 0)
    )
    total = int(footprint.sum())
    valid_count = int(valid.sum())
    if total == 0 or valid_count == 0:
        print(json.dumps({
            "status": "needs_data",
            "quality": {"totalPixelCount": total, "validPixelCount": valid_count, "validFraction": 0},
            "metrics": None,
            "zones": [],
            "visualizations": [],
            "error": {"code": "no_radar_coverage", "message": "No valid radar pixels cover the field."},
        }, separators=(",", ":")))
        return
    vv = 10 * np.log10(values[0])
    vh = 10 * np.log10(values[1])
    visualizations = []
    for raster, file_name, metric, label, minimum, maximum in [
        (vv, "vv.png", "vv", "VV 后向散射", -25.0, 0.0),
        (vh, "vh.png", "vh", "VH 后向散射", -35.0, -2.0),
    ]:
        visualization = write_visualization(output_dir, file_name, raster, valid, transform, crs, minimum, maximum, RADAR_PALETTE, metric, label)
        if visualization:
            visualizations.append(visualization)
    print(json.dumps({
        "status": "succeeded",
        "quality": {"totalPixelCount": total, "validPixelCount": valid_count, "validFraction": valid_count / total},
        "metrics": None,
        "observation": {
            "meanVvDb": float(np.mean(vv[valid])),
            "meanVhDb": float(np.mean(vh[valid])),
        },
        "zones": [],
        "visualizations": visualizations,
        "error": {"code": None, "message": None},
    }, separators=(",", ":")))


if __name__ == "__main__":
    main()
