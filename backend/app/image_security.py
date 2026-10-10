"""Validate uploaded raster bytes and normalize them before storage or cloud analysis."""

import io
import shutil
import subprocess
import tempfile
from pathlib import Path


IMAGE_TYPES = {
    "image/jpeg": "jpeg",
    "image/png": "png",
    "image/webp": "webp",
}
MAX_SAFE_ANALYSIS_BYTES = 3_700_000
MAX_DIMENSION = 1600


def _matches_magic(contents: bytes, media_type: str) -> bool:
    if media_type == "image/jpeg":
        return contents.startswith(b"\xff\xd8\xff")
    if media_type == "image/png":
        return contents.startswith(b"\x89PNG\r\n\x1a\n")
    if media_type == "image/webp":
        return len(contents) >= 12 and contents[:4] == b"RIFF" and contents[8:12] == b"WEBP"
    return False


def _strip_jpeg_app1(contents: bytes) -> bytes:
    """Remove JPEG APP1 metadata segments (including EXIF) without re-encoding."""
    if not contents.startswith(b"\xff\xd8"):
        raise ValueError("Normalized image is not a JPEG")
    output = bytearray(contents[:2])
    index = 2
    while index < len(contents):
        marker_start = index
        if contents[index] != 0xFF:
            raise ValueError("Malformed JPEG marker stream")
        while index < len(contents) and contents[index] == 0xFF:
            index += 1
        if index >= len(contents):
            raise ValueError("Truncated JPEG marker")
        marker = contents[index]
        index += 1
        if marker == 0xDA:  # Entropy-coded image follows; copy the compressed image as-is.
            output.extend(contents[marker_start:])
            break
        if marker in {0xD8, 0xD9, 0x01, *range(0xD0, 0xD8)}:
            output.extend(contents[marker_start:index])
            if marker == 0xD9:
                break
            continue
        if index + 2 > len(contents):
            raise ValueError("Truncated JPEG segment")
        segment_length = int.from_bytes(contents[index:index + 2], "big")
        segment_end = index + segment_length
        if segment_length < 2 or segment_end > len(contents):
            raise ValueError("Invalid JPEG segment length")
        if marker != 0xE1:
            output.extend(contents[marker_start:segment_end])
        index = segment_end
    return bytes(output)


def _normalize_with_pillow(contents: bytes) -> bytes:
    from PIL import Image, ImageOps

    Image.MAX_IMAGE_PIXELS = 40_000_000
    with Image.open(io.BytesIO(contents)) as opened:
        opened.verify()
    with Image.open(io.BytesIO(contents)) as opened:
        image = ImageOps.exif_transpose(opened)
        image.thumbnail((MAX_DIMENSION, MAX_DIMENSION), Image.Resampling.LANCZOS)
        if image.mode not in ("RGB", "L"):
            image = image.convert("RGB")
        elif image.mode == "L":
            image = image.convert("RGB")
        for quality in (85, 78, 70, 62):
            output = io.BytesIO()
            image.save(output, format="JPEG", quality=quality, optimize=True)
            normalized = output.getvalue()
            if len(normalized) <= MAX_SAFE_ANALYSIS_BYTES:
                return normalized
        image.thumbnail((1280, 1280), Image.Resampling.LANCZOS)
        output = io.BytesIO()
        image.save(output, format="JPEG", quality=58, optimize=True)
        normalized = output.getvalue()
        if len(normalized) > MAX_SAFE_ANALYSIS_BYTES:
            raise ValueError("Image cannot be reduced below the safe analysis size")
        return normalized


def _normalize_with_sips(contents: bytes) -> bytes:
    executable = shutil.which("sips")
    if not executable:
        raise RuntimeError("Pillow is required to normalize uploaded photos")
    with tempfile.TemporaryDirectory(prefix="wastelens-photo-") as directory:
        source = Path(directory) / "source.bin"
        output = Path(directory) / "normalized.jpg"
        source.write_bytes(contents)
        result = subprocess.run(
            [executable, "-s", "format", "jpeg", "-s", "formatOptions", "80", "-Z", "1600",
             str(source), "--out", str(output)],
            capture_output=True, check=False, timeout=25,
        )
        if result.returncode != 0 or not output.is_file():
            raise ValueError("Image could not be decoded and normalized")
        normalized = _strip_jpeg_app1(output.read_bytes())
        if not normalized or len(normalized) > MAX_SAFE_ANALYSIS_BYTES:
            raise ValueError("Image could not be normalized below the safe analysis size")
        return normalized


def normalize_uploaded_image(contents: bytes, media_type: str) -> bytes:
    if media_type not in IMAGE_TYPES or not _matches_magic(contents, media_type):
        raise ValueError("Image content does not match the declared JPEG, PNG, or WebP type")
    try:
        try:
            return _normalize_with_pillow(contents)
        except ImportError:
            return _normalize_with_sips(contents)
    except ValueError:
        raise
    except Exception as exc:
        raise ValueError("Image could not be decoded and normalized") from exc
