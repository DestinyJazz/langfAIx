"""Generates the extension icons (icon16.png, icon48.png, icon128.png).

The design: a blue rounded square with a white bar for a line of text and a red squiggle
below it for "something is wrong here". Standard library only, no imaging package. The
icons are already generated in this folder; run this only to change the design:
  python make_icons.py
"""

import math
import struct
import zlib
from pathlib import Path

BLUE = (11, 92, 173)
WHITE = (255, 255, 255)
RED = (255, 90, 95)
SCALE = 4  # draw at 4x and scale down, for smooth edges (anti-aliasing)


def pixel(x: float, y: float) -> tuple[int, int, int, int]:
    """Colour at point (x, y), both from 0 to 1. Returns (red, green, blue, alpha)."""
    # Outside the rounded square is transparent.
    radius = 0.22
    dx = max(radius - x, 0, x - (1 - radius))
    dy = max(radius - y, 0, y - (1 - radius))
    if dx * dx + dy * dy > radius * radius:
        return (0, 0, 0, 0)

    # White bar: a line of text.
    if 0.20 <= x <= 0.80 and abs(y - 0.40) <= 0.055:
        return (*WHITE, 255)

    # Red squiggle.
    if 0.18 <= x <= 0.82:
        wave_y = 0.66 + 0.055 * math.sin((x - 0.18) * 2 * math.pi * 2.5)
        if abs(y - wave_y) <= 0.045:
            return (*RED, 255)

    return (*BLUE, 255)


def render(size: int) -> bytes:
    """Draw a size x size image and return the PNG file content."""
    rows = []
    for row in range(size):
        line = bytearray([0])  # the leading 0 of each row is PNG's "no filter for this row"
        for col in range(size):
            # Sample SCALE x SCALE points in this pixel and average the colour.
            total = [0, 0, 0, 0]
            for sy in range(SCALE):
                for sx in range(SCALE):
                    r, g, b, a = pixel((col + (sx + 0.5) / SCALE) / size, (row + (sy + 0.5) / SCALE) / size)
                    total[0] += r * a
                    total[1] += g * a
                    total[2] += b * a
                    total[3] += a
            alpha = total[3] / (SCALE * SCALE)
            if total[3]:
                line += bytes([round(total[0] / total[3]), round(total[1] / total[3]), round(total[2] / total[3])])
            else:
                line += bytes([0, 0, 0])
            line.append(round(alpha))
        rows.append(bytes(line))

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

    header = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)  # 8 bits, colour with alpha
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(b"".join(rows), 9)) + chunk(b"IEND", b"")


if __name__ == "__main__":
    folder = Path(__file__).parent
    for size in (16, 48, 128):
        path = folder / f"icon{size}.png"
        path.write_bytes(render(size))
        print(f"{path.name}: {path.stat().st_size} bytes")
