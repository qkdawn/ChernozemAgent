import math

from PIL import Image


PRESENTATION_MIN_EDGE = 480
PRESENTATION_MAX_EDGE = 1200


def resize_for_presentation(image: Image.Image) -> Image.Image:
    """Resize a raster for UI delivery without interpolating new spatial detail."""
    longest_edge = max(image.size)
    if longest_edge < PRESENTATION_MIN_EDGE:
        scale = PRESENTATION_MIN_EDGE / longest_edge
    elif longest_edge > PRESENTATION_MAX_EDGE:
        scale = PRESENTATION_MAX_EDGE / longest_edge
    else:
        return image
    return image.resize(
        (max(1, round(image.width * scale)), max(1, round(image.height * scale))),
        Image.Resampling.NEAREST,
    )


def pixel_size_meters(transform, crs, latitude: float) -> float:
    pixel_width = math.hypot(transform.a, transform.b)
    pixel_height = math.hypot(transform.d, transform.e)
    if getattr(crs, "is_projected", False):
        return round((pixel_width + pixel_height) / 2, 1)
    width_meters = pixel_width * 111320 * math.cos(math.radians(latitude))
    height_meters = pixel_height * 110540
    return round((width_meters + height_meters) / 2, 1)
