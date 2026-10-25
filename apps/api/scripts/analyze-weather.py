import json
import sys
from collections import defaultdict, deque
from datetime import datetime, timezone

import numpy as np
import rasterio
from rasterio.warp import transform


RAIN_EVENT_THRESHOLD_MM = 25.0
COLD_ATTENTION_C = 2.0
COLD_WINDOW_MAX_GAP_SECONDS = 6 * 3600


def utc_date(timestamp):
    return datetime.fromtimestamp(timestamp, tz=timezone.utc).date().isoformat()


def historical_daily(rain, temperatures):
    daily = defaultdict(lambda: {"date": "", "rainfallMm": 0.0, "minTemperatureC": None, "maxTemperatureC": None})
    for timestamp, amount in rain:
        date = utc_date(timestamp)
        item = daily[date]
        item["date"] = date
        item["rainfallMm"] += amount
    for timestamp, value in temperatures.items():
        if not np.isfinite(value):
            continue
        date = utc_date(timestamp)
        temperature = value - 273.15
        item = daily[date]
        item["date"] = date
        item["minTemperatureC"] = temperature if item["minTemperatureC"] is None else min(item["minTemperatureC"], temperature)
        item["maxTemperatureC"] = temperature if item["maxTemperatureC"] is None else max(item["maxTemperatureC"], temperature)
    return [daily[date] for date in sorted(daily)]


def parse_times(tags):
    raw = tags.get("NETCDF_DIM_valid_time_VALUES", "").strip("{}")
    return [int(value) for value in raw.split(",") if value]


def nearest_value(dataset, band, longitude, latitude):
    try:
        x, y = longitude, latitude
        if dataset.crs and dataset.crs.to_string() != "EPSG:4326":
            x_values, y_values = transform("EPSG:4326", dataset.crs, [longitude], [latitude])
            x, y = x_values[0], y_values[0]
        row, column = dataset.index(x, y)
        if not (0 <= row < dataset.height and 0 <= column < dataset.width):
            return None
        sample = dataset.read(band, masked=True)[row, column]
        if np.ma.is_masked(sample):
            return None
        value = float(sample)
        if np.isfinite(value):
            return value
    except Exception:
        return None
    return None


def read_historical(paths, longitude, latitude, start, end):
    precipitation = {}
    temperatures = {}
    for path in paths:
        for variable, target in (("tp", precipitation), ("t2m", temperatures)):
            with rasterio.open(f"netcdf:{path}:{variable}") as dataset:
                times = parse_times(dataset.tags())
                for index, timestamp in enumerate(times, start=1):
                    if timestamp < start or timestamp > end:
                        continue
                    value = nearest_value(dataset, index, longitude, latitude)
                    if value is not None:
                        target[timestamp] = value
    if not precipitation and not temperatures:
        return None
    cumulative = sorted((timestamp, max(0.0, value * 1000)) for timestamp, value in precipitation.items())
    rain = []
    previous_time = None
    previous_value = None
    for timestamp, value in cumulative:
        continuous = previous_time is not None and timestamp - previous_time <= 5400
        amount = value - previous_value if continuous and previous_value is not None and value >= previous_value else value
        rain.append((timestamp, max(0.0, amount)))
        previous_time, previous_value = timestamp, value
    maximum, events = rain_events_for(rain)
    temperature_values = [value - 273.15 for value in temperatures.values() if np.isfinite(value)]
    observed_times = set(precipitation) | set(temperatures)
    expected_hour_count = max(1, int((end - start) // 3600) + 1)
    observed_hour_count = len(observed_times)
    return {
        "start": iso(min([*precipitation.keys(), *temperatures.keys()])),
        "end": iso(max([*precipitation.keys(), *temperatures.keys()])),
        "totalRainfallMm": sum(amount for _, amount in rain),
        "max24hRainfallMm": maximum[0],
        "minTemperatureC": min(temperature_values) if temperature_values else None,
        "rainEvents": events,
        "hourCount": observed_hour_count,
        "coverage": {"expectedHourCount": expected_hour_count, "observedHourCount": observed_hour_count, "fraction": min(1.0, observed_hour_count / expected_hour_count)},
        "daily": historical_daily(rain, temperatures),
    }


def maximum_rain_window(rain):
    window = deque()
    rolling = 0.0
    maximum = (0.0, None, None)
    for timestamp, amount in rain:
        window.append((timestamp, amount))
        rolling += amount
        while window and timestamp - window[0][0] >= 24 * 3600:
            rolling -= window.popleft()[1]
        if rolling > maximum[0]:
            maximum = (rolling, window[0][0] if window else timestamp, timestamp)
    return maximum


def rain_events_for(rain):
    maximum = maximum_rain_window(rain)
    positive = [(timestamp, amount) for timestamp, amount in rain if amount > 0]
    clusters = []
    current = []
    for item in positive:
        if current and item[0] - current[-1][0] >= 24 * 3600:
            clusters.append(current)
            current = []
        current.append(item)
    if current:
        clusters.append(current)
    events = []
    for cluster in clusters:
        event = maximum_rain_window(cluster)
        if event[0] >= RAIN_EVENT_THRESHOLD_MM:
            events.append({"start": iso(event[1]), "end": iso(event[2]), "rainfallMm": event[0]})
    return maximum, events


def read_forecast(paths, start, end):
    forecasts = []
    for path in paths:
        with open(path, encoding="utf-8") as handle:
            forecasts.append(json.load(handle))
    if not forecasts:
        return None
    forecast = next((item for item in sorted(forecasts, key=lambda item: item.get("runAt", ""), reverse=True) if any(in_window(value.get("validAt"), start, end) for value in item.get("values", []))), None)
    if forecast is None:
        return None
    temperatures = sorted((value["validAt"], float(value["value"]) - 273.15) for value in forecast.get("values", []) if value.get("parameter") == "2t" and in_window(value.get("validAt"), start, end))
    precipitation = sorted((value["validAt"], max(0.0, float(value["value"]) * 1000)) for value in forecast.get("values", []) if value.get("parameter") == "tp" and in_window(value.get("validAt"), start, end))
    valid_times = [time for time, _ in temperatures] or [time for time, _ in precipitation]
    if not valid_times:
        return None
    cold_windows = cold_windows_for(temperatures)
    daily = defaultdict(lambda: {"date": "", "rainfallMm": 0.0, "minTemperatureC": None, "maxTemperatureC": None})
    previous_rainfall = 0.0
    for valid_at, cumulative in precipitation:
        date = valid_at[:10]
        amount = cumulative - previous_rainfall if cumulative >= previous_rainfall else cumulative
        previous_rainfall = cumulative
        item = daily[date]
        item["date"] = date
        item["rainfallMm"] += max(0.0, amount)
    for valid_at, temperature in temperatures:
        date = valid_at[:10]
        item = daily[date]
        item["date"] = date
        item["minTemperatureC"] = temperature if item["minTemperatureC"] is None else min(item["minTemperatureC"], temperature)
        item["maxTemperatureC"] = temperature if item["maxTemperatureC"] is None else max(item["maxTemperatureC"], temperature)
    coverage = forecast_coverage(valid_times, start, end)
    return {
        "runAt": forecast.get("runAt"),
        "start": min(valid_times) if valid_times else None,
        "end": max(valid_times) if valid_times else None,
        "minTemperatureC": min((value for _, value in temperatures), default=None),
        "cumulativeRainfallMm": max((value for _, value in precipitation), default=0.0),
        "coldWindows": cold_windows,
        "gridDistanceKm": next((float(value["distanceKm"]) for value in forecast.get("values", []) if value.get("distanceKm") is not None), None),
        "coverage": coverage,
        "daily": [daily[date] for date in sorted(daily)],
    }


def forecast_coverage(valid_times, start, end):
    timestamps = sorted(set(filter(lambda value: value is not None, (parse_iso(value) for value in valid_times))))
    if not timestamps:
        return {"validPointCount": 0, "fraction": 0.0}
    steps = [right - left for left, right in zip(timestamps, timestamps[1:]) if right > left]
    step = int(np.median(steps)) if steps else 0
    covered_start = max(start, timestamps[0])
    covered_end = min(end, timestamps[-1] + step)
    requested_seconds = max(1, end - start)
    fraction = max(0.0, min(1.0, (covered_end - covered_start) / requested_seconds))
    return {"validPointCount": len(timestamps), "fraction": fraction}


def iso(timestamp):
    return datetime.fromtimestamp(timestamp, tz=timezone.utc).isoformat().replace("+00:00", "Z") if timestamp is not None else None


def parse_iso(value):
    try:
        return int(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp())
    except (AttributeError, TypeError, ValueError):
        return None


def in_window(value, start, end):
    timestamp = parse_iso(value)
    return timestamp is not None and start <= timestamp <= end


def cold_windows_for(temperatures):
    windows = []
    current = []
    for valid_at, temperature in temperatures:
        if temperature > COLD_ATTENTION_C:
            if current:
                windows.append(current)
                current = []
            continue
        timestamp = parse_iso(valid_at)
        previous = parse_iso(current[-1][0]) if current else None
        if current and (timestamp is None or previous is None or timestamp - previous > COLD_WINDOW_MAX_GAP_SECONDS):
            windows.append(current)
            current = []
        current.append((valid_at, temperature))
    if current:
        windows.append(current)
    return [{"start": window[0][0], "end": window[-1][0], "minTemperatureC": min(value for _, value in window)} for window in windows]


def main():
    request = json.load(sys.stdin)
    start = int(datetime.fromisoformat(request["timeRange"]["start"].replace("Z", "+00:00")).timestamp())
    end = int(datetime.fromisoformat(request["timeRange"]["end"].replace("Z", "+00:00")).timestamp())
    historical = read_historical(request.get("historicalPaths", []), request["centroid"]["longitude"], request["centroid"]["latitude"], start, end)
    forecast = read_forecast(request.get("forecastPaths", []), start, end)
    requested_historical = bool(request.get("historicalPaths"))
    requested_forecast = bool(request.get("forecastPaths"))
    partial = (
        (requested_historical and (historical is None or historical["coverage"]["fraction"] < 0.8))
        or (requested_forecast and (forecast is None or forecast["coverage"]["fraction"] < 0.8 or parse_iso(forecast.get("runAt")) is None))
    )
    print(json.dumps({
        "status": "partial" if (historical or forecast) and partial else "succeeded" if historical or forecast else "needs_data",
        "historical": historical,
        "forecast": forecast,
        "error": {"code": None, "message": None} if historical or forecast else {"code": "weather_assets_missing", "message": "No readable weather assets were found."},
    }, separators=(",", ":")))


if __name__ == "__main__":
    main()
