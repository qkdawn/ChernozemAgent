import json
import os
import sys

from ecmwf.datastores import Client


def main() -> None:
    target = sys.argv[1]
    payload = json.load(sys.stdin)
    token = os.environ["CDS_API_KEY"]
    request = {
        "variable": payload["variables"],
        "year": payload["year"],
        "month": payload["month"],
        "day": payload["days"],
        "time": [f"{hour:02d}:00" for hour in range(24)],
        "area": payload["area"],
        "data_format": "netcdf",
        "download_format": "unarchived",
    }
    client = Client(
        url="https://cds.climate.copernicus.eu/api",
        key=token,
        progress=False,
    )
    client.retrieve("reanalysis-era5-land", request, target)


if __name__ == "__main__":
    main()
