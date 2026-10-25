import json
import runpy
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np
import rasterio
from rasterio.transform import from_bounds
from rasterio.warp import transform


SCRIPT = Path(__file__).resolve().parents[1] / "analyze-optical.py"


class AnalyzeOpticalTest(unittest.TestCase):
    def test_retains_unobserved_holes_in_zone_geometry(self):
        sys.path.insert(0, str(SCRIPT.parent))
        try:
            build_zones = runpy.run_path(str(SCRIPT))["build_management_zones"]
        finally:
            sys.path.pop(0)
        values = np.full((9, 9), 0.7, dtype=np.float32)
        valid = np.ones((9, 9), dtype=bool)
        valid[3:6, 3:6] = False
        zones, _ = build_zones(values, values, values, values, values, values,
                               valid, from_bounds(123.8, 42.3, 123.81, 42.31, 9, 9),
                               rasterio.crs.CRS.from_epsg(4326),
                               {name: 0.7 for name in ["ndre", "reci", "msavi", "ndmi", "ndwi"]})
        self.assertEqual(len(zones), 1)
        self.assertEqual(zones[0]["validPixelCount"], 72)
        self.assertEqual(len(zones[0]["holes"]), 1)
        self.assertGreaterEqual(len(zones[0]["holes"][0]), 4)

    def test_projects_wgs84_field_boundary_into_raster_crs(self):
        boundary = field_boundary()
        longitudes = [point["longitude"] for point in boundary]
        latitudes = [point["latitude"] for point in boundary]
        projected_x, projected_y = transform("EPSG:4326", "EPSG:3857", longitudes, latitudes)
        bounds = (min(projected_x) - 100, min(projected_y) - 100, max(projected_x) + 100, max(projected_y) + 100)

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            spectral_10, spectral_20, scl = write_optical_inputs(root, bounds, "EPSG:3857")
            output_dir = root / "output"
            result = run_tool(spectral_10, spectral_20, scl, boundary, output_dir)

            self.assertEqual(result["status"], "succeeded")
            self.assertGreater(result["quality"]["totalPixelCount"], 0)
            self.assertGreater(result["quality"]["validPixelCount"], 0)
            self.assertGreater(len(result["zones"]), 0)
            self.assertEqual({item["metric"] for item in result["visualizations"]}, {"true_color", "ndvi", "ndvi_contrast", "ndre", "reci", "msavi", "ndmi", "ndwi"})
            self.assertTrue(all((output_dir / item["fileName"]).stat().st_size > 0 for item in result["visualizations"]))
            left = min(point[0] for item in result["visualizations"] for point in item["bounds"])
            right = max(point[0] for item in result["visualizations"] for point in item["bounds"])
            self.assertLess(left, 123.802)
            self.assertGreater(right, 123.802)

    def test_keeps_metrics_when_clouds_leave_partial_valid_coverage(self):
        boundary = field_boundary()
        bounds = (123.798, 42.298, 123.806, 42.306)

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            spectral_10, spectral_20, scl = write_optical_inputs(root, bounds, "EPSG:4326", cloud_rows=8)
            result = run_tool(spectral_10, spectral_20, scl, boundary, root / "output")

            self.assertEqual(result["status"], "partial")
            self.assertIsNotNone(result["metrics"])
            self.assertGreater(result["quality"]["validPixelCount"], 0)
            self.assertLess(result["quality"]["validFraction"], 0.8)
            self.assertIn("cloud_contaminated", result["quality"]["flags"])

    def test_uniform_field_does_not_create_false_low_or_high_zones(self):
        boundary = field_boundary()
        bounds = (123.798, 42.298, 123.806, 42.306)

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            spectral_10, spectral_20, scl = write_optical_inputs(root, bounds, "EPSG:4326", uniform=True)
            result = run_tool(spectral_10, spectral_20, scl, boundary, root / "output")

            self.assertEqual(result["status"], "succeeded")
            self.assertEqual(result["zoningMethod"], "ndvi-quantile-connected-v2")
            self.assertFalse(result["zoningQuality"]["variationVisible"])
            self.assertLess(result["zoningQuality"]["robustRange"], result["zoningQuality"]["minimumRobustRange"])
            self.assertGreater(len(result["zones"]), 0)
            self.assertEqual({zone["class"] for zone in result["zones"]}, {"near_average"})

    def test_returns_needs_data_when_raster_does_not_cover_field(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            spectral_10, spectral_20, scl = write_optical_inputs(root, (120.0, 40.0, 120.01, 40.01), "EPSG:4326")
            result = run_tool(spectral_10, spectral_20, scl, field_boundary(), root / "output")

            self.assertEqual(result["status"], "needs_data")
            self.assertEqual(result["error"]["code"], "no_field_coverage")
            self.assertIsNone(result["metrics"])
            self.assertEqual(result["zones"], [])


def field_boundary():
    return [
        {"longitude": 123.800, "latitude": 42.300},
        {"longitude": 123.804, "latitude": 42.300},
        {"longitude": 123.804, "latitude": 42.304},
        {"longitude": 123.800, "latitude": 42.304},
        {"longitude": 123.800, "latitude": 42.300},
    ]


def write_optical_inputs(root: Path, bounds, crs: str, cloud_rows: int = 0, uniform: bool = False):
    spectral_10 = root / "spectral-10m.tif"
    spectral_20 = root / "spectral-20m.tif"
    scl = root / "scl-20m.tif"
    transform_10 = from_bounds(*bounds, 40, 40)
    transform_20 = from_bounds(*bounds, 20, 20)
    gradient_10 = np.zeros((40, 40), dtype=np.float32) if uniform else np.tile(np.linspace(0, 1200, 40, dtype=np.float32), (40, 1))
    gradient_20 = np.zeros((20, 20), dtype=np.float32) if uniform else np.tile(np.linspace(0, 600, 20, dtype=np.float32), (20, 1))
    bands_10 = np.stack([
        np.full((40, 40), 1000, dtype=np.float32),
        np.full((40, 40), 1500, dtype=np.float32),
        2200 + gradient_10,
        7600 - gradient_10,
    ]).astype(np.uint16)
    bands_20 = np.stack([
        2400 + gradient_20,
        np.full((20, 20), 3000, dtype=np.float32),
        np.full((20, 20), 3500, dtype=np.float32),
        7000 - gradient_20,
        np.full((20, 20), 3200, dtype=np.float32),
        np.full((20, 20), 2800, dtype=np.float32),
    ]).astype(np.uint16)
    scl_values = np.full((1, 20, 20), 4, dtype=np.uint8)
    if cloud_rows:
        scl_values[:, :cloud_rows, :] = 9
    write_raster(spectral_10, bands_10, transform_10, crs)
    write_raster(spectral_20, bands_20, transform_20, crs)
    write_raster(scl, scl_values, transform_20, crs)
    return spectral_10, spectral_20, scl


def write_raster(path: Path, values: np.ndarray, raster_transform, crs: str):
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        width=values.shape[2],
        height=values.shape[1],
        count=values.shape[0],
        dtype=values.dtype,
        crs=crs,
        transform=raster_transform,
    ) as dataset:
        dataset.write(values)


def run_tool(spectral_10: Path, spectral_20: Path, scl: Path, boundary, output_dir: Path):
    request = {
        "spectral10": str(spectral_10),
        "spectral20": str(spectral_20),
        "scl": str(scl),
        "boundary": boundary,
        "sourceDate": "2026-06-26",
        "outputDir": str(output_dir),
    }
    completed = subprocess.run(
        [sys.executable, str(SCRIPT)],
        input=json.dumps(request),
        text=True,
        capture_output=True,
        check=False,
    )
    if completed.returncode != 0:
        raise AssertionError(completed.stderr)
    return json.loads(completed.stdout)


if __name__ == "__main__":
    unittest.main()
