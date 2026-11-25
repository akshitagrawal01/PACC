"""
pacc.layout — Cell roles for an N x N PACC symbol.

Roles: four 7x7 finder patterns with a light separator (8x8 corner blocks), a
24-cell format word next to each finder, a pilot lattice (one known-colour cell
per 5x5 block), and data cells (everything else, row-major order).
"""
from __future__ import annotations

import functools
from dataclasses import dataclass

import numpy as np

from pacc.spec import CORNER_BLOCK, FINDER, PILOT_OFFSET, PILOT_PERIOD

# Format cells for the top-left corner, in bit order. Other corners use mirror
# images of this list (see corner_cells).
_FORMAT_TL: list[tuple[int, int]] = (
    [(8, c) for c in range(8)]          # 8 cells along row 8
    + [(r, 8) for r in range(9)]        # 9 cells down column 8 (includes (8, 8))
    + [(9, c) for c in range(7)]        # 7 cells along row 9
)
assert len(_FORMAT_TL) == 24 and len(set(_FORMAT_TL)) == 24

CORNERS = ("TL", "TR", "BR", "BL")      # clockwise; corner id = index


def corner_cells(n: int, corner: int, cells: list[tuple[int, int]]) -> list[tuple[int, int]]:
    """Mirror top-left cell coordinates into the given corner."""
    out = []
    for r, c in cells:
        if corner in (1, 2):
            c = n - 1 - c
        if corner in (2, 3):
            r = n - 1 - r
        out.append((r, c))
    return out


def finder_pattern() -> np.ndarray:
    """7x7 array: 1 = dark, 0 = light."""
    p = np.ones((FINDER, FINDER), dtype=np.uint8)
    p[1:-1, 1:-1] = 0
    p[2:-2, 2:-2] = 1
    return p


@dataclass(frozen=True)
class Layout:
    n: int
    role: np.ndarray                 # (n, n) uint8: 0 data, 1 finder/separator, 2 format, 3 pilot
    known_dark: np.ndarray           # (n, n) bool: finder dark cells
    known_light: np.ndarray          # (n, n) bool: finder light cells + separators
    format_cells: tuple              # 4 lists (per corner) of 24 (r, c)
    pilot_cells: np.ndarray          # (P, 2) int
    data_cells: np.ndarray           # (D, 2) int, row-major


ROLE_DATA, ROLE_FIXED, ROLE_FORMAT, ROLE_PILOT = 0, 1, 2, 3


def pilot_index(r: int, c: int, palette_size: int) -> int:
    """Palette entry shown by the pilot at (r, c): cycles so every neighbourhood sees all colours."""
    return ((r // PILOT_PERIOD) + 3 * (c // PILOT_PERIOD)) % palette_size


@functools.lru_cache(maxsize=64)
def build(n: int) -> Layout:
    role = np.zeros((n, n), dtype=np.uint8)
    dark = np.zeros((n, n), dtype=bool)
    light = np.zeros((n, n), dtype=bool)
    fp = finder_pattern().astype(bool)
    for corner in range(4):
        r0 = 0 if corner in (0, 1) else n - CORNER_BLOCK
        c0 = 0 if corner in (0, 3) else n - CORNER_BLOCK
        role[r0:r0 + CORNER_BLOCK, c0:c0 + CORNER_BLOCK] = ROLE_FIXED
        light[r0:r0 + CORNER_BLOCK, c0:c0 + CORNER_BLOCK] = True
        fr = 0 if corner in (0, 1) else n - FINDER
        fc = 0 if corner in (0, 3) else n - FINDER
        dark[fr:fr + FINDER, fc:fc + FINDER] = fp
    light &= ~dark

    fmt = []
    for corner in range(4):
        cells = corner_cells(n, corner, _FORMAT_TL)
        for r, c in cells:
            if role[r, c] != ROLE_DATA:
                raise ValueError(f"format cell overlap at N={n}")
            role[r, c] = ROLE_FORMAT
        fmt.append(tuple(cells))

    pilots = []
    for r in range(PILOT_OFFSET, n, PILOT_PERIOD):
        for c in range(PILOT_OFFSET, n, PILOT_PERIOD):
            if role[r, c] == ROLE_DATA:
                role[r, c] = ROLE_PILOT
                pilots.append((r, c))

    data = np.argwhere(role == ROLE_DATA).astype(np.int32)   # row-major
    return Layout(
        n=n, role=role, known_dark=dark, known_light=light,
        format_cells=tuple(fmt),
        pilot_cells=np.asarray(pilots, dtype=np.int32).reshape(-1, 2),
        data_cells=data,
    )

