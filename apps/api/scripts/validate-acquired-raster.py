import json
import sys

import numpy as np
import rasterio


CLOUD_AFFECTED_CLASSES = {3, 8, 9, 10}
INVALID_CLASSES = {0, 1, 3, 8, 9, 10, 11}


def main() -> None:
    target = sys.argv[1]
    request = json.load(sys.stdin)
    source = request["source"]
    role = request["role"]

    with rasterio.open(target) as dataset:
        if dataset.width < 1 or dataset.height < 1 or dataset.count < 1:
            raise RuntimeError("影像没有有效尺寸或波段")
        pixels = dataset.read(masked=True)
        if pixels.count() == 0:
            raise RuntimeError("影像没有有效像元")
        values = pixels.compressed()
        if not np.isfinite(values).any():
            raise RuntimeError("影像没有有限数值像元")
        if source == "sentinel-2" and np.count_nonzero(values) == 0:
            raise RuntimeError("Sentinel-2 返回了全零空栅格")
        if role == "radar" and dataset.count < 3:
            raise RuntimeError("Sentinel-1 雷达资产缺少 VV/VH/dataMask 波段")
        if role == "quality-mask":
            scl = pixels[0].compressed().astype(np.int16)
            # Sentinel Hub writes SCL=0 outside the requested field geometry.
            # Those bounding-box pixels are NoData, not cloud-contaminated field pixels.
            field_scl = scl[scl != 0]
            histogram = {str(value): int(count) for value, count in zip(*np.unique(field_scl, return_counts=True))}
            total = int(field_scl.size)
            if total == 0:
                raise RuntimeError("Sentinel-2 SCL 在地块内没有覆盖")
            cloud_affected = int(np.isin(field_scl, list(CLOUD_AFFECTED_CLASSES)).sum())
            valid = int((~np.isin(field_scl, list(INVALID_CLASSES))).sum())
            print(json.dumps({
                "totalPixelCount": total,
                "validPixelCount": valid,
                "validPixelFraction": valid / total,
                "cloudAffectedPixelCount": cloud_affected,
                "cloudAffectedFraction": cloud_affected / total,
                "sclClassHistogram": histogram,
            }, separators=(",", ":")))


if __name__ == "__main__":
    main()
