import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np
import rasterio
from rasterio.transform import from_bounds
from rasterio.warp import transform


SCRIPT = Path(__file__).resolve().parents[1] / "analyze-soil.py"


class AnalyzeSoilTest(unittest.TestCase):
    def test_clips_projected_rasters_and_converts_soilgrids_units(self):
        boundary = field_boundary()
        bounds = projected_bounds(boundary)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            ph_path = root / "ph.tif"
            nitrogen_path = root / "nitrogen.tif"
            write_soil(ph_path, bounds, np.full((30, 30), 65, dtype=np.float32))
            write_soil(nitrogen_path, bounds, np.full((30, 30), 140, dtype=np.float32))

            result = run_tool([
                {"path": str(ph_path), "property": "phh2o", "depth": "5-15cm"},
                {"path": str(nitrogen_path), "property": "nitrogen", "depth": "5-15cm"},
            ], boundary)

            self.assertEqual(result["status"], "succeeded")
            measurements = {item["property"]: item for item in result["measurements"]}
            self.assertAlmostEqual(measurements["phh2o"]["mean"], 6.5)
            self.assertAlmostEqual(measurements["nitrogen"]["mean"], 1.4, places=5)
            self.assertEqual(measurements["phh2o"]["validFraction"], 1)

    def test_preserves_measurements_and_marks_partial_nodata_coverage(self):
        boundary = field_boundary()
        bounds = projected_bounds(boundary)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "ph.tif"
            values = np.full((30, 30), 65, dtype=np.float32)
            values[:, 12:18] = -9999
            write_soil(path, bounds, values, nodata=-9999)

            result = run_tool([{"path": str(path), "property": "phh2o", "depth": "5-15cm"}], boundary)

            self.assertEqual(result["status"], "partial")
            self.assertAlmostEqual(result["measurements"][0]["mean"], 6.5)
            self.assertGreater(result["measurements"][0]["validFraction"], 0)
            self.assertLess(result["measurements"][0]["validFraction"], 0.8)

    def test_returns_needs_data_when_field_has_no_valid_pixels(self):
        boundary = field_boundary()
        bounds = projected_bounds(boundary)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "ph.tif"
            write_soil(path, bounds, np.full((30, 30), -9999, dtype=np.float32), nodata=-9999)

            result = run_tool([{"path": str(path), "property": "phh2o", "depth": "5-15cm"}], boundary)

            self.assertEqual(result["status"], "needs_data")
            self.assertEqual(result["error"]["code"], "soil_coverage_missing")


def field_boundary():
    return [
        {"longitude": 123.800, "latitude": 42.300},
        {"longitude": 123.804, "latitude": 42.300},
        {"longitude": 123.804, "latitude": 42.304},
        {"longitude": 123.800, "latitude": 42.304},
        {"longitude": 123.800, "latitude": 42.300},
    ]


def projected_bounds(boundary):
    x, y = transform("EPSG:4326", "EPSG:3857", [point["longitude"] for point in boundary], [point["latitude"] for point in boundary])
    return min(x) - 80, min(y) - 80, max(x) + 80, max(y) + 80


def write_soil(path: Path, bounds, values, nodata=None):
    with rasterio.open(path, "w", driver="GTiff", width=30, height=30, count=1, dtype="float32", crs="EPSG:3857", transform=from_bounds(*bounds, 30, 30), nodata=nodata) as dataset:
        dataset.write(values, 1)


def run_tool(assets, boundary):
    completed = subprocess.run(
        [sys.executable, str(SCRIPT)],
        input=json.dumps({"assets": assets, "boundary": boundary}),
        text=True,
        capture_output=True,
        check=False,
    )
    if completed.returncode != 0:
        raise AssertionError(completed.stderr)
    return json.loads(completed.stdout)


if __name__ == "__main__":
    unittest.main()
