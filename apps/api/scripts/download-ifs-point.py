import json
import sys
from datetime import datetime, timezone

from eccodes import (
    codes_get,
    codes_get_string,
    codes_grib_find_nearest,
    codes_grib_new_from_file,
    codes_release,
)
from ecmwf.opendata import Client


PARAMETERS = ["2t", "2d", "10u", "10v", "tp", "tcc", "ssrd"]


def forecast_steps(run_hour: int) -> list[int]:
    maximum = 240 if run_hour in (0, 12) else 90
    return list(range(0, min(144, maximum) + 1, 3)) + list(range(150, maximum + 1, 6))


def main() -> None:
    target = sys.argv[1]
    payload = json.load(sys.stdin)
    run_at = datetime.fromisoformat(payload["runAt"].replace("Z", "+00:00")).astimezone(timezone.utc)
    raw_target = f"{target}.grib2.partial"
    client = Client(source="ecmwf", model="ifs", resol="0p25")
    client.retrieve(
        date=run_at.strftime("%Y%m%d"),
        time=run_at.hour,
        type="fc",
        levtype="sfc",
        step=forecast_steps(run_at.hour),
        param=PARAMETERS,
        target=raw_target,
    )

    rows = []
    with open(raw_target, "rb") as handle:
        while True:
            message = codes_grib_new_from_file(handle)
            if message is None:
                break
            try:
                nearest = codes_grib_find_nearest(message, float(payload["latitude"]), float(payload["longitude"]))[0]
                valid_date = int(codes_get(message, "validityDate"))
                valid_time = int(codes_get(message, "validityTime"))
                valid_at = datetime.strptime(f"{valid_date:08d}{valid_time:04d}", "%Y%m%d%H%M").replace(tzinfo=timezone.utc).isoformat().replace("+00:00", "Z")
                rows.append({
                    "parameter": codes_get_string(message, "shortName"),
                    "validAt": valid_at,
                    "value": float(nearest["value"]),
                    "units": codes_get_string(message, "units"),
                    "gridLongitude": float(nearest["lon"]),
                    "gridLatitude": float(nearest["lat"]),
                    "distanceKm": float(nearest["distance"]),
                })
            finally:
                codes_release(message)

    output = {
        "model": "ECMWF IFS",
        "resolutionDegrees": 0.25,
        "runAt": run_at.isoformat().replace("+00:00", "Z"),
        "location": {"longitude": payload["longitude"], "latitude": payload["latitude"]},
        "parameters": PARAMETERS,
        "values": rows,
    }
    with open(target, "w", encoding="utf-8") as handle:
        json.dump(output, handle, ensure_ascii=True, separators=(",", ":"))


if __name__ == "__main__":
    main()
