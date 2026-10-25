import json
import importlib.util
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

import numpy as np


SCRIPT = Path(__file__).resolve().parents[1] / "analyze-weather.py"
SPEC = importlib.util.spec_from_file_location("analyze_weather", SCRIPT)
WEATHER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(WEATHER)


class AnalyzeWeatherTest(unittest.TestCase):
    def test_limits_forecast_values_and_cold_windows_to_task_period(self):
        with tempfile.TemporaryDirectory() as directory:
            forecast_path = Path(directory) / "forecast.json"
            forecast_path.write_text(json.dumps({
                "runAt": "2026-08-18T00:00:00Z",
                "values": [
                    value("2t", "2026-08-18T21:00:00Z", 267.15),
                    value("2t", "2026-08-19T00:00:00Z", 273.15),
                    value("2t", "2026-08-19T03:00:00Z", 274.15),
                    value("2t", "2026-08-19T12:00:00Z", 278.15),
                    value("2t", "2026-08-20T00:00:00Z", 272.15),
                    value("2t", "2026-08-21T00:00:00Z", 265.15),
                    value("tp", "2026-08-19T00:00:00Z", 0.002),
                    value("tp", "2026-08-20T00:00:00Z", 0.005),
                ],
            }), encoding="utf-8")
            result = run_tool(forecast_path)

            self.assertEqual(result["status"], "partial")
            forecast = result["forecast"]
            self.assertEqual(forecast["start"], "2026-08-19T00:00:00Z")
            self.assertEqual(forecast["end"], "2026-08-20T00:00:00Z")
            self.assertEqual(forecast["minTemperatureC"], -1.0)
            self.assertEqual(len(forecast["coldWindows"]), 2)
            self.assertAlmostEqual(forecast["cumulativeRainfallMm"], 5.0)
            self.assertGreater(forecast["coverage"]["fraction"], 0)
            self.assertLess(forecast["coverage"]["fraction"], 0.8)

    def test_returns_needs_data_when_forecast_does_not_cover_task_period(self):
        with tempfile.TemporaryDirectory() as directory:
            forecast_path = Path(directory) / "forecast.json"
            forecast_path.write_text(json.dumps({
                "runAt": "2026-08-18T00:00:00Z",
                "values": [value("2t", "2026-08-21T00:00:00Z", 265.15)],
            }), encoding="utf-8")
            result = run_tool(forecast_path)

            self.assertEqual(result["status"], "needs_data")
            self.assertIsNone(result["forecast"])

    def test_preserves_separate_heavy_rain_events(self):
        start = int(datetime(2026, 6, 1, tzinfo=timezone.utc).timestamp())
        rain = [
            (start, 30.0),
            (start + 3600, 5.0),
            (start + 72 * 3600, 40.0),
        ]

        maximum, events = WEATHER.rain_events_for(rain)

        self.assertEqual(maximum[0], 40.0)
        self.assertEqual(len(events), 2)
        self.assertEqual([event["rainfallMm"] for event in events], [35.0, 40.0])

    def test_rejects_masked_or_outside_historical_grid_samples(self):
        masked = FakeDataset(np.ma.array([[9999.0]], mask=[[True]]), (0, 0))
        outside = FakeDataset(np.ma.array([[280.0]], mask=[[False]]), (2, 2))

        self.assertIsNone(WEATHER.nearest_value(masked, 1, 123.8, 42.3))
        self.assertIsNone(WEATHER.nearest_value(outside, 1, 123.8, 42.3))


def value(parameter, valid_at, amount):
    return {"parameter": parameter, "validAt": valid_at, "value": amount, "distanceKm": 8}


class FakeCrs:
    def to_string(self):
        return "EPSG:4326"


class FakeDataset:
    width = 1
    height = 1
    crs = FakeCrs()

    def __init__(self, values, location):
        self.values = values
        self.location = location

    def index(self, _longitude, _latitude):
        return self.location

    def read(self, _band, masked=False):
        return self.values if masked else self.values.filled(9999)


def run_tool(forecast_path: Path):
    completed = subprocess.run(
        [sys.executable, str(SCRIPT)],
        input=json.dumps({
            "historicalPaths": [],
            "forecastPaths": [str(forecast_path)],
            "centroid": {"longitude": 123.8, "latitude": 42.3},
            "timeRange": {"start": "2026-08-19T00:00:00Z", "end": "2026-08-20T23:59:59Z"},
        }),
        text=True,
        capture_output=True,
        check=False,
    )
    if completed.returncode != 0:
        raise AssertionError(completed.stderr)
    return json.loads(completed.stdout)


if __name__ == "__main__":
    unittest.main()
