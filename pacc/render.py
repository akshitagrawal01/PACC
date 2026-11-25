"""
pacc.render — Grid -> image (cells as squares, white quiet zone).
"""
from __future__ import annotations

import numpy as np
from PIL import Image

from pacc.spec import QUIET_ZONE


def render(grid: np.ndarray, cell_size: int = 10, quiet_zone: int = QUIET_ZONE) -> Image.Image:
    if cell_size < 1:
        raise ValueError("cell_size must be >= 1")
    up = np.repeat(np.repeat(grid, cell_size, axis=0), cell_size, axis=1)
    pad = quiet_zone * cell_size
    canvas = np.full((up.shape[0] + 2 * pad, up.shape[1] + 2 * pad, 3), 255, dtype=np.uint8)
    canvas[pad:pad + up.shape[0], pad:pad + up.shape[1]] = up
    return Image.fromarray(canvas, mode="RGB")

