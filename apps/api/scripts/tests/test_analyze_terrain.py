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


SCRIPT = Path(__file__).resolve().parents[1] / "analyze-terrain.py"


class AnalyzeTerrainTest(unittest.TestCase):
    def test_uses_projected_pixel_spacing_and_returns_wgs84_zones(self):
        boundary = field_boundary()
        bounds = projected_bounds(boundary)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "dem.tif"
            elevation = 50 + np.tile(np.arange(30, dtype=np.float32), (30, 1))
            write_dem(path, bounds, elevation)
            result = run_tool(path, boundary, Path(directory) / "output")

            self.assertEqual(result["status"], "succeeded")
            self.assertGreater(result["metrics"]["meanSlopeDegrees"], 1.0)
            self.assertLess(result["metrics"]["meanSlopeDegrees"], 10.0)
            coordinates = [coordinate for zone in result["zones"] for coordinate in zone["zone"]]
            self.assertTrue(all(123.79 < coordinate[0] < 123.81 for coordinate in coordinates))
            self.assertTrue(all(42.29 < coordinate[1] < 42.31 for coordinate in coordinates))

    def test_marks_incomplete_dem_coverage_partial(self):
        boundary = field_boundary()
        bounds = projected_bounds(boundary)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "dem.tif"
            elevation = np.full((30, 30), 55, dtype=np.float32)
            elevation[:, 12:18] = -9999
            write_dem(path, bounds, elevation, nodata=-9999)
            result = run_tool(path, boundary, Path(directory) / "output")

            self.assertEqual(result["status"], "partial")
            self.assertGreater(result["metrics"]["validFraction"], 0)
            self.assertLess(result["metrics"]["validFraction"], 0.8)

    def test_does_not_invent_lowland_zones_on_flat_terrain(self):
        boundary = field_boundary()
        bounds = projected_bounds(boundary)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "flat-dem.tif"
            write_dem(path, bounds, np.full((30, 30), 55, dtype=np.float32))

            result = run_tool(path, boundary, Path(directory) / "output")

            self.assertEqual(result["status"], "succeeded")
            self.assertEqual(result["metrics"]["minimumLowlandRelativeDepthM"], 0.5)
            self.assertFalse(any(zone["class"] == "low" for zone in result["zones"]))

    def test_returns_needs_data_when_dem_does_not_cover_field(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "outside-dem.tif"
            write_dem(path, (0, 0, 1000, 1000), np.full((30, 30), 55, dtype=np.float32))

            result = run_tool(path, field_boundary(), root / "output")

            self.assertEqual(result["status"], "needs_data")
            self.assertEqual(result["error"]["code"], "no_terrain_coverage")
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


def projected_bounds(boundary):
    x, y = transform("EPSG:4326", "EPSG:3857", [point["longitude"] for point in boundary], [point["latitude"] for point in boundary])
    return min(x) - 80, min(y) - 80, max(x) + 80, max(y) + 80


def write_dem(path: Path, bounds, elevation, nodata=None):
    with rasterio.open(path, "w", driver="GTiff", width=30, height=30, count=1, dtype="float32", crs="EPSG:3857", transform=from_bounds(*bounds, 30, 30), nodata=nodata) as dataset:
        dataset.write(elevation, 1)


def run_tool(path: Path, boundary, output_dir: Path):
    completed = subprocess.run(
        [sys.executable, str(SCRIPT)],
        input=json.dumps({"path": str(path), "boundary": boundary, "outputDir": str(output_dir)}),
        text=True,
        capture_output=True,
        check=False,
    )
    if completed.returncode != 0:
        raise AssertionError(completed.stderr)
    return json.loads(completed.stdout)


if __name__ == "__main__":
    unittest.main()
