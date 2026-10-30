import json
import os
import sys
import tempfile

import numpy as np
import rasterio
from PIL import Image
from rasterio.features import geometry_mask, shapes
from rasterio.transform import array_bounds
from rasterio.warp import Resampling, reproject, transform_bounds, transform_geom
from rasterio.windows import transform as window_transform

from raster_presentation import pixel_size_meters, resize_for_presentation


INVALID_SCL = {0, 1, 3, 8, 9, 10, 11}
NDVI_PALETTE = [
    (0.0, (155, 75, 43)),
    (0.25, (210, 132, 42)),
    (0.5, (229, 211, 60)),
    (0.7, (111, 189, 63)),
    (1.0, (12, 111, 59)),
]
CONTRAST_PALETTE = [
    (0.0, (196, 48, 57)),
    (0.25, (234, 119, 47)),
    (0.5, (231, 224, 61)),
    (0.75, (66, 181, 82)),
    (1.0, (25, 139, 117)),
]
MOISTURE_PALETTE = [
    (0.0, (156, 84, 53)),
    (0.35, (224, 181, 92)),
    (0.55, (224, 224, 181)),
    (0.75, (89, 160, 135)),
    (1.0, (35, 91, 151)),
]
ZONE_METHOD = "ndvi-quantile-connected-v2"
MIN_NDVI_ROBUST_RANGE = 0.05


def read_band(path: str, index: int, shape=None, transform=None, crs=None):
    with rasterio.open(path) as dataset:
        target_shape = shape or (dataset.height, dataset.width)
        if shape is None:
            return dataset.read(index).astype(np.float32), dataset.transform, dataset.crs
        values = np.zeros(target_shape, dtype=np.float32)
        reproject(
            source=rasterio.band(dataset, index),
            destination=values,
            src_transform=dataset.transform,
            src_crs=dataset.crs,
            dst_transform=transform,
            dst_crs=crs,
            resampling=Resampling.bilinear,
        )
        return values, transform, crs


def field_geometry(boundary, crs):
    geometry = {
        "type": "Polygon",
        "coordinates": [[[point["longitude"], point["latitude"]] for point in boundary]],
    }
    if crs and crs.to_string() != "EPSG:4326":
        return transform_geom("EPSG:4326", crs, geometry, precision=7)
    return geometry


def valid_ratio(values: np.ndarray) -> float:
    return float(np.isfinite(values).sum() / values.size) if values.size else 0.0


def colorize(values: np.ndarray, valid: np.ndarray, minimum: float, maximum: float, palette) -> np.ndarray:
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
    rgba[..., 3][valid] = 255
    return rgba


def write_visualization(output_dir: str, file_name: str, values: np.ndarray, valid: np.ndarray, transform, crs, minimum: float, maximum: float, palette):
    rows, columns = np.where(valid)
    if rows.size == 0 or columns.size == 0:
        return None
    y0, y1 = int(rows.min()), int(rows.max()) + 1
    x0, x1 = int(columns.min()), int(columns.max()) + 1
    cropped_values = values[y0:y1, x0:x1]
    cropped_valid = valid[y0:y1, x0:x1]
    rgba = colorize(cropped_values, cropped_valid, minimum, maximum, palette)
    image = Image.fromarray(rgba, mode="RGBA")
    image = resize_for_presentation(image)
    save_png(image, output_dir, file_name)
    crop_transform = window_transform(rasterio.windows.Window(x0, y0, x1 - x0, y1 - y0), transform)
    west, south, east, north = array_bounds(y1 - y0, x1 - x0, crop_transform)
    left, bottom, right, top = transform_bounds(crs, "EPSG:4326", west, south, east, north, densify_pts=21)
    return {
        "fileName": file_name,
        "bounds": [[left, top], [right, top], [right, bottom], [left, bottom]],
        "min": minimum,
        "max": maximum,
        "resolutionMeters": pixel_size_meters(crop_transform, crs, (top + bottom) / 2),
    }


def write_true_color_visualization(output_dir: str, file_name: str, red: np.ndarray, green: np.ndarray, blue: np.ndarray, valid: np.ndarray, transform, crs):
    rows, columns = np.where(valid)
    if rows.size == 0 or columns.size == 0:
        return None
    y0, y1 = int(rows.min()), int(rows.max()) + 1
    x0, x1 = int(columns.min()), int(columns.max()) + 1
    cropped_valid = valid[y0:y1, x0:x1]
    rgba = np.zeros((y1 - y0, x1 - x0, 4), dtype=np.uint8)
    for channel, values in enumerate((red, green, blue)):
        source = values[y0:y1, x0:x1]
        samples = source[cropped_valid]
        lower = float(np.percentile(samples, 2))
        upper = float(np.percentile(samples, 98))
        if upper - lower < 1:
            lower = float(np.min(samples))
            upper = float(np.max(samples))
        normalized = np.clip((source - lower) / max(upper - lower, 1), 0, 1)
        rgba[..., channel] = np.round(np.power(normalized, 0.9) * 255).astype(np.uint8)
    rgba[..., 3][cropped_valid] = 255
    image = resize_for_presentation(Image.fromarray(rgba, mode="RGBA"))
    save_png(image, output_dir, file_name)
    crop_transform = window_transform(rasterio.windows.Window(x0, y0, x1 - x0, y1 - y0), transform)
    west, south, east, north = array_bounds(y1 - y0, x1 - x0, crop_transform)
    left, bottom, right, top = transform_bounds(crs, "EPSG:4326", west, south, east, north, densify_pts=21)
    return {
        "fileName": file_name,
        "bounds": [[left, top], [right, top], [right, bottom], [left, bottom]],
        "min": 0.0,
        "max": 1.0,
        "resolutionMeters": pixel_size_meters(crop_transform, crs, (top + bottom) / 2),
    }


def save_png(image: Image.Image, output_dir: str, file_name: str) -> None:
    """Publish only complete images; a failed write must not replace an existing preview."""
    os.makedirs(output_dir, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=output_dir, suffix=".png", delete=False) as temporary:
        temporary_path = temporary.name
    try:
        image.save(temporary_path, format="PNG", optimize=True)
        os.replace(temporary_path, os.path.join(output_dir, file_name))
    finally:
        if os.path.exists(temporary_path):
            os.unlink(temporary_path)


def majority_filter(classes: np.ndarray, valid: np.ndarray, passes: int = 2) -> np.ndarray:
    """Remove isolated class noise while retaining the native 20 m analysis grid."""
    result = classes.copy()
    height, width = result.shape
    for _ in range(passes):
        updated = result.copy()
        for row, column in zip(*np.where(valid)):
            row_start, row_end = max(0, row - 1), min(height, row + 2)
            column_start, column_end = max(0, column - 1), min(width, column + 2)
            neighborhood_valid = valid[row_start:row_end, column_start:column_end]
            neighborhood = result[row_start:row_end, column_start:column_end][neighborhood_valid]
            if neighborhood.size < 4:
                continue
            counts = np.bincount(neighborhood, minlength=3)
            winner = int(np.argmax(counts))
            if counts[winner] >= 5:
                updated[row, column] = winner
        result = updated
    return result


def connected_components(classes: np.ndarray, valid: np.ndarray):
    height, width = classes.shape
    component_ids = np.zeros(classes.shape, dtype=np.int32)
    components = []
    next_id = 1
    for start_row, start_column in zip(*np.where(valid)):
        if component_ids[start_row, start_column] != 0:
            continue
        class_value = int(classes[start_row, start_column])
        stack = [(int(start_row), int(start_column))]
        pixels = []
        component_ids[start_row, start_column] = next_id
        while stack:
            row, column = stack.pop()
            pixels.append((row, column))
            for neighbor_row, neighbor_column in ((row - 1, column), (row + 1, column), (row, column - 1), (row, column + 1)):
                if not (0 <= neighbor_row < height and 0 <= neighbor_column < width):
                    continue
                if not valid[neighbor_row, neighbor_column] or component_ids[neighbor_row, neighbor_column] != 0:
                    continue
                if int(classes[neighbor_row, neighbor_column]) != class_value:
                    continue
                component_ids[neighbor_row, neighbor_column] = next_id
                stack.append((neighbor_row, neighbor_column))
        components.append({"id": next_id, "class": class_value, "pixels": pixels})
        next_id += 1
    return component_ids, components


def absorb_small_components(classes: np.ndarray, valid: np.ndarray, minimum_pixels: int) -> np.ndarray:
    result = classes.copy()
    height, width = result.shape
    for _ in range(3):
        _, components = connected_components(result, valid)
        small = [component for component in components if len(component["pixels"]) < minimum_pixels]
        if not small:
            break
        changed = False
        for component in small:
            neighbor_counts = np.zeros(3, dtype=np.int32)
            component_class = component["class"]
            for row, column in component["pixels"]:
                for neighbor_row, neighbor_column in ((row - 1, column), (row + 1, column), (row, column - 1), (row, column + 1)):
                    if not (0 <= neighbor_row < height and 0 <= neighbor_column < width) or not valid[neighbor_row, neighbor_column]:
                        continue
                    neighbor_class = int(result[neighbor_row, neighbor_column])
                    if neighbor_class != component_class:
                        neighbor_counts[neighbor_class] += 1
            if int(neighbor_counts.sum()) == 0:
                continue
            replacement = int(np.argmax(neighbor_counts))
            for row, column in component["pixels"]:
                result[row, column] = replacement
            changed = True
        if not changed:
            break
    return result


def build_management_zones(ndvi, ndre, reci, msavi, ndmi, ndwi, valid, transform, crs, field_means):
    values = ndvi[valid]
    classes = np.full(ndvi.shape, -1, dtype=np.int16)
    percentile_10, percentile_90 = np.percentile(values, [10, 90])
    robust_range = float(percentile_90 - percentile_10)
    variation_visible = robust_range >= MIN_NDVI_ROBUST_RANGE
    if variation_visible:
        lower, upper = np.percentile(values, [33.333, 66.667])
        classes[valid & (ndvi <= lower)] = 0
        classes[valid & (ndvi > lower) & (ndvi <= upper)] = 1
        classes[valid & (ndvi > upper)] = 2
        classes = majority_filter(classes, valid)
        minimum_pixels = max(3, int(round(int(valid.sum()) * 0.01)))
        classes = absorb_small_components(classes, valid, minimum_pixels)
    else:
        classes[valid] = 1
    component_ids, components = connected_components(classes, valid)
    geometries = {
        int(value): geometry
        for geometry, value in shapes(component_ids, mask=component_ids > 0, transform=transform, connectivity=4)
        if int(value) > 0
    }
    class_names = ["below_average", "near_average", "above_average"]
    zones = []
    for component in components:
        geometry = geometries.get(component["id"])
        if not geometry:
            continue
        if crs and crs.to_string() != "EPSG:4326":
            geometry = transform_geom(crs, "EPSG:4326", geometry, precision=7)
        if geometry.get("type") != "Polygon" or not geometry.get("coordinates"):
            continue
        rows = np.array([pixel[0] for pixel in component["pixels"]], dtype=np.int32)
        columns = np.array([pixel[1] for pixel in component["pixels"]], dtype=np.int32)
        mean_ndvi = float(np.mean(ndvi[rows, columns]))
        zones.append({
            "id": f"management-{component['id']}",
            "row": int(round(float(np.mean(rows)))),
            "column": int(round(float(np.mean(columns)))),
            "meanNdvi": mean_ndvi,
            "deviation": mean_ndvi - float(np.mean(values)),
            "metricDeviations": {
                "ndre": float(np.mean(ndre[rows, columns]) - field_means["ndre"]),
                "reci": float(np.mean(reci[rows, columns]) - field_means["reci"]),
                "msavi": float(np.mean(msavi[rows, columns]) - field_means["msavi"]),
                "ndmi": float(np.mean(ndmi[rows, columns]) - field_means["ndmi"]),
                "ndwi": float(np.mean(ndwi[rows, columns]) - field_means["ndwi"]),
            },
            "class": class_names[component["class"]],
            "validPixelCount": len(component["pixels"]),
            "zone": geometry["coordinates"][0],
            "holes": geometry["coordinates"][1:],
        })
    return zones, {
        "robustRange": robust_range,
        "minimumRobustRange": MIN_NDVI_ROBUST_RANGE,
        "variationVisible": variation_visible,
    }


def main() -> None:
    request = json.load(sys.stdin)
    spectral_10 = request["spectral10"]
    spectral_20 = request["spectral20"]
    scl_path = request["scl"]
    boundary = request["boundary"]
    source_date = request["sourceDate"]
    output_dir = request["outputDir"]
    if not output_dir:
        raise ValueError("outputDir is required for optical preview artifacts")

    with rasterio.open(spectral_20) as reference:
        shape = (reference.height, reference.width)
        transform = reference.transform
        crs = reference.crs
        b05 = reference.read(1).astype(np.float32)
        b8a = reference.read(4).astype(np.float32)
        b11 = reference.read(5).astype(np.float32)
        footprint = geometry_mask([field_geometry(boundary, crs)], out_shape=shape, transform=transform, invert=True)

    with rasterio.open(spectral_10) as true_color_source:
        true_color_transform = true_color_source.transform
        true_color_crs = true_color_source.crs
        true_color_shape = (true_color_source.height, true_color_source.width)
        native_b02 = true_color_source.read(1).astype(np.float32)
        native_b03 = true_color_source.read(2).astype(np.float32)
        native_b04 = true_color_source.read(3).astype(np.float32)
    b03, _, _ = read_band(spectral_10, 2, shape=shape, transform=transform, crs=crs)
    b04, _, _ = read_band(spectral_10, 3, shape=shape, transform=transform, crs=crs)
    b08, _, _ = read_band(spectral_10, 4, shape=shape, transform=transform, crs=crs)
    with rasterio.open(scl_path) as scl_dataset:
        scl = scl_dataset.read(1).astype(np.int16)
        same_grid = scl.shape == shape and scl_dataset.crs == crs and scl_dataset.transform.almost_equals(transform)
        if not same_grid:
            resized = np.zeros(shape, dtype=np.float32)
            reproject(
                source=scl,
                destination=resized,
                src_transform=scl_dataset.transform,
                src_crs=scl_dataset.crs,
                dst_transform=transform,
                dst_crs=crs,
                resampling=Resampling.nearest,
            )
            scl = resized.astype(np.int16)

        native_scl = np.zeros(true_color_shape, dtype=np.float32)
        reproject(
            source=rasterio.band(scl_dataset, 1),
            destination=native_scl,
            src_transform=scl_dataset.transform,
            src_crs=scl_dataset.crs,
            dst_transform=true_color_transform,
            dst_crs=true_color_crs,
            resampling=Resampling.nearest,
        )

    true_color_footprint = geometry_mask(
        [field_geometry(boundary, true_color_crs)],
        out_shape=true_color_shape,
        transform=true_color_transform,
        invert=True,
    )
    true_color_valid = true_color_footprint & ~np.isin(native_scl.astype(np.int16), list(INVALID_SCL))

    denominator_ndvi = b08 + b04
    denominator_ndre = b8a + b05
    denominator_ndmi = b8a + b11
    denominator_ndwi = b03 + b08
    ndvi = np.divide(b08 - b04, denominator_ndvi, out=np.full(shape, np.nan, dtype=np.float32), where=denominator_ndvi != 0)
    ndre = np.divide(b8a - b05, denominator_ndre, out=np.full(shape, np.nan, dtype=np.float32), where=denominator_ndre != 0)
    reci = np.divide(b8a, b05, out=np.full(shape, np.nan, dtype=np.float32), where=b05 != 0) - 1.0
    ndmi = np.divide(b8a - b11, denominator_ndmi, out=np.full(shape, np.nan, dtype=np.float32), where=denominator_ndmi != 0)
    ndwi = np.divide(b03 - b08, denominator_ndwi, out=np.full(shape, np.nan, dtype=np.float32), where=denominator_ndwi != 0)
    nir = b08 / 10000.0
    red = b04 / 10000.0
    msavi_radicand = np.maximum((2.0 * nir + 1.0) ** 2 - 8.0 * (nir - red), 0.0)
    msavi = (2.0 * nir + 1.0 - np.sqrt(msavi_radicand)) / 2.0
    valid = footprint & ~np.isin(scl, list(INVALID_SCL))
    for index_values in (ndvi, ndre, reci, msavi, ndmi, ndwi):
        valid &= np.isfinite(index_values)
    cloud = footprint & np.isin(scl, [3, 8, 9, 10])
    total = int(footprint.sum())
    valid_count = int(valid.sum())
    cloud_count = int(cloud.sum())
    if total == 0:
        print(json.dumps({
            "status": "needs_data",
            "sourceDate": source_date,
            "quality": {"flags": ["no_coverage"], "totalPixelCount": 0, "validPixelCount": 0, "validFraction": 0, "cloudAffectedFraction": 0},
            "metrics": None,
            "zones": [],
            "error": {"code": "no_field_coverage", "message": "当前影像不覆盖该地块。", "retryable": False},
        }, separators=(",", ":")))
        return

    if valid_count == 0:
        cloud_fraction = cloud_count / total
        cloud_blocked = cloud_fraction >= 0.2
        print(json.dumps({
            "status": "needs_data",
            "sourceDate": source_date,
            "quality": {"flags": ["cloud_contaminated" if cloud_blocked else "no_valid_pixels"], "totalPixelCount": total, "validPixelCount": 0, "validFraction": 0, "cloudAffectedFraction": cloud_fraction},
            "metrics": None,
            "zones": [],
            "error": {
                "code": "cloud_contaminated" if cloud_blocked else "no_valid_pixels",
                "message": "地块内像元受云污染，当前日期不可用于光学分析。" if cloud_blocked else "地块内没有可用于光学分析的有效像元。",
                "retryable": False,
            },
        }, separators=(",", ":")))
        return

    values_ndvi = ndvi[valid]
    values_ndre = ndre[valid]
    values_reci = reci[valid]
    values_msavi = msavi[valid]
    values_ndmi = ndmi[valid]
    values_ndwi = ndwi[valid]
    mean_ndvi = float(np.mean(values_ndvi))
    mean_ndre = float(np.mean(values_ndre))
    field_means = {
        "ndre": mean_ndre,
        "reci": float(np.mean(values_reci)),
        "msavi": float(np.mean(values_msavi)),
        "ndmi": float(np.mean(values_ndmi)),
        "ndwi": float(np.mean(values_ndwi)),
    }
    zones, zoning_quality = build_management_zones(ndvi, ndre, reci, msavi, ndmi, ndwi, valid, transform, crs, field_means)

    flags = []
    valid_fraction = valid_count / total if total else 0
    if valid_fraction < 0.8:
        flags.append("insufficient_valid_pixels")
    if cloud_count / total >= 0.2 if total else False:
        flags.append("cloud_contaminated")
    status = "partial" if flags else "succeeded"
    visualizations = []
    if output_dir:
        true_color = write_true_color_visualization(
            output_dir,
            f"{source_date}-true-color.png",
            native_b04,
            native_b03,
            native_b02,
            true_color_valid,
            true_color_transform,
            true_color_crs,
        )
        standard = write_visualization(output_dir, f"{source_date}-ndvi.png", ndvi, valid, transform, crs, 0.0, 1.0, NDVI_PALETTE)
        contrast_min = float(np.percentile(values_ndvi, 5))
        contrast_max = float(np.percentile(values_ndvi, 95))
        if contrast_max - contrast_min < 0.01:
            contrast_min = float(np.min(values_ndvi))
            contrast_max = float(np.max(values_ndvi))
        if contrast_max - contrast_min < 0.01:
            contrast_min -= 0.01
            contrast_max += 0.01
        contrasted = write_visualization(output_dir, f"{source_date}-ndvi-contrast.png", ndvi, valid, transform, crs, contrast_min, contrast_max, CONTRAST_PALETTE)
        if true_color:
            visualizations.append({**true_color, "metric": "true_color", "label": "卫星原图"})
        if standard:
            visualizations.append({**standard, "metric": "ndvi", "label": "NDVI"})
        if contrasted:
            visualizations.append({**contrasted, "metric": "ndvi_contrast", "label": "对比 NDVI"})
        index_layers = [
            ("ndre", "NDRE", ndre, -0.2, 0.8, NDVI_PALETTE),
            ("reci", "RECI", reci, 0.0, 6.0, NDVI_PALETTE),
            ("msavi", "MSAVI", msavi, 0.0, 1.0, NDVI_PALETTE),
            ("ndmi", "NDMI", ndmi, -0.5, 0.8, MOISTURE_PALETTE),
            ("ndwi", "NDWI", ndwi, -0.8, 0.4, MOISTURE_PALETTE),
        ]
        for metric, label, values, minimum, maximum, palette in index_layers:
            layer = write_visualization(output_dir, f"{source_date}-{metric}.png", values, valid, transform, crs, minimum, maximum, palette)
            if layer:
                visualizations.append({**layer, "metric": metric, "label": label})

    def metric_summary(values):
        summary = {
            "mean": float(np.mean(values)),
            "min": float(np.min(values)),
            "max": float(np.max(values)),
            "validPixelCount": valid_count,
            "totalPixelCount": total,
            "coverageFraction": valid_fraction,
        }
        if values.size >= 2:
            std = float(np.std(values))
            if np.isfinite(std):
                summary["std"] = std
        return summary

    print(json.dumps({
        "status": status,
        "sourceDate": source_date,
        "quality": {"flags": flags, "totalPixelCount": total, "validPixelCount": valid_count, "validFraction": valid_fraction, "cloudAffectedFraction": cloud_count / total if total else 0},
        "metrics": {
            "ndvi": metric_summary(values_ndvi),
            "ndre": metric_summary(values_ndre),
            "reci": metric_summary(values_reci),
            "msavi": metric_summary(values_msavi),
            "ndmi": metric_summary(values_ndmi),
            "ndwi": metric_summary(values_ndwi),
        },
        "zoningMethod": ZONE_METHOD,
        "zoningQuality": zoning_quality,
        "zones": zones,
        "visualizations": visualizations,
        "error": {"code": None, "message": None, "retryable": False},
    }, separators=(",", ":")))


if __name__ == "__main__":
    main()
