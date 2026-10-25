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


SCRIPT = Path(__file__).resolve().parents[1] / "analyze-radar.py"


class AnalyzeRadarTest(unittest.TestCase):
    def test_aligns_projected_rasters_and_returns_wgs84_change_zones(self):
        boundary = field_boundary()
        longitudes = [point["longitude"] for point in boundary]
        latitudes = [point["latitude"] for point in boundary]
        projected_x, projected_y = transform("EPSG:4326", "EPSG:3857", longitudes, latitudes)
        bounds = (min(projected_x) - 80, min(projected_y) - 80, max(projected_x) + 80, max(projected_y) + 80)

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            before = root / "before.tif"
            after = root / "after.tif"
            write_radar(before, bounds, 0.20, 0.08)
            write_radar(after, bounds, 0.10, 0.06)
            result = run_tool(before, after, boundary, root / "output")

            self.assertEqual(result["status"], "succeeded")
            self.assertAlmostEqual(result["metrics"]["vvDeltaDb"], -3.0103, places=3)
            self.assertGreater(result["quality"]["validPixelCount"], 0)
            self.assertEqual(result["visualizations"][0]["metric"], "radar_change")
            self.assertTrue(all(zone["class"] == "strong_decrease" for zone in result["zones"]))
            coordinates = [coordinate for zone in result["zones"] for coordinate in zone["zone"]]
            self.assertTrue(all(123.79 < coordinate[0] < 123.81 for coordinate in coordinates))
            self.assertTrue(all(42.29 < coordinate[1] < 42.31 for coordinate in coordinates))

    def test_returns_single_observation_statistics_without_inventing_change(self):
        boundary = field_boundary()
        projected_x, projected_y = transform("EPSG:4326", "EPSG:3857", [point["longitude"] for point in boundary], [point["latitude"] for point in boundary])
        bounds = (min(projected_x) - 80, min(projected_y) - 80, max(projected_x) + 80, max(projected_y) + 80)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            observation = root / "observation.tif"
            write_radar(observation, bounds, 0.20, 0.08)
            result = run_observation_tool(observation, boundary, root / "output")

            self.assertEqual(result["status"], "succeeded")
            self.assertIsNone(result["metrics"])
            self.assertAlmostEqual(result["observation"]["meanVvDb"], -6.9897, places=3)
            self.assertAlmostEqual(result["observation"]["meanVhDb"], -10.9691, places=3)
            self.assertEqual([item["metric"] for item in result["visualizations"]], ["vv", "vh"])

    def test_returns_needs_data_when_rasters_do_not_cover_field(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            before = root / "before.tif"
            after = root / "after.tif"
            write_radar(before, (0, 0, 1000, 1000), 0.20, 0.08)
            write_radar(after, (0, 0, 1000, 1000), 0.10, 0.06)

            result = run_tool(before, after, field_boundary(), root / "output")

            self.assertEqual(result["status"], "needs_data")
            self.assertEqual(result["error"]["code"], "no_radar_coverage")
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


def write_radar(path: Path, bounds, vv: float, vh: float):
    values = np.stack([
        np.full((30, 30), vv, dtype=np.float32),
        np.full((30, 30), vh, dtype=np.float32),
        np.ones((30, 30), dtype=np.float32),
    ])
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        width=30,
        height=30,
        count=3,
        dtype="float32",
        crs="EPSG:3857",
        transform=from_bounds(*bounds, 30, 30),
    ) as dataset:
        dataset.write(values)


def run_tool(before: Path, after: Path, boundary, output_dir: Path):
    completed = subprocess.run(
        [sys.executable, str(SCRIPT)],
        input=json.dumps({
            "beforePath": str(before),
            "afterPath": str(after),
            "boundary": boundary,
            "outputDir": str(output_dir),
            "includeObservationVisualizations": False,
        }),
        text=True,
        capture_output=True,
        check=False,
    )
    if completed.returncode != 0:
        raise AssertionError(completed.stderr)
    return json.loads(completed.stdout)


def run_observation_tool(path: Path, boundary, output_dir: Path):
    completed = subprocess.run(
        [sys.executable, str(SCRIPT)],
        input=json.dumps({"mode": "observation", "path": str(path), "boundary": boundary, "outputDir": str(output_dir)}),
        text=True,
        capture_output=True,
        check=False,
    )
    if completed.returncode != 0:
        raise AssertionError(completed.stderr)
    return json.loads(completed.stdout)


if __name__ == "__main__":
    unittest.main()
