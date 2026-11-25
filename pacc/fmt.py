"""
pacc.fmt — Format word: grid size, modulation (MCS) and robustness level.

Each corner carries its own 24-cell Golay(24,12) codeword of
    corner id (2 bits) | grid index (5) | MCS (3) | level (2)
in black/white cells (bit 1 = dark). Because each copy names its own corner,
reading any one copy fixes the symbol's orientation, including mirror images.
The decoder correlates soft luminance against every codeword and combines all
four copies under each of the 8 rotations/reflections of the sampled grid.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from pacc import golay, layout
from pacc.spec import GRID_INDEX_BITS, MCS_BITS


@dataclass(frozen=True)
class FormatInfo:
    grid_index: int
    mcs: int
    level: int


def pack(corner: int, info: FormatInfo) -> int:
    return (
        (corner << 10)
        | (info.grid_index << (MCS_BITS + 2))
        | (info.mcs << 2)
        | info.level
    )


def unpack10(x: int) -> FormatInfo:
    return FormatInfo(
        grid_index=(x >> (MCS_BITS + 2)) & ((1 << GRID_INDEX_BITS) - 1),
        mcs=(x >> 2) & ((1 << MCS_BITS) - 1),
        level=x & 3,
    )


def corner_bits(corner: int, info: FormatInfo) -> list[int]:
    return golay.codeword_bits(pack(corner, info))


def dihedral(grid: np.ndarray, t: int) -> np.ndarray:
    """Transform t in 0..7: rotate by t % 4 quarter turns, transpose first if t >= 4."""
    g = np.swapaxes(grid, 0, 1) if t >= 4 else grid
    return np.rot90(g, k=t % 4)


@dataclass(frozen=True)
class FormatResult:
    info: FormatInfo
    transform: int
    score: float          # normalised correlation of the winning hypothesis (1.0 = perfect)
    margin: float         # gap to the best competing hypothesis


def decode(soft_grid: np.ndarray) -> FormatResult:
    """soft_grid: (n, n) values in [-1, 1], +1 = light (bit 0), -1 = dark (bit 1)."""
    n = soft_grid.shape[0]
    lay = layout.build(n)
    table = golay.bipolar_table()                       # (4096, 24)
    best: list[tuple[float, int, int]] = []
    for t in range(8):
        g = dihedral(soft_grid, t)
        total = np.zeros(1024, dtype=np.float64)
        for corner in range(4):
            cells = lay.format_cells[corner]
            s = np.array([g[r, c] for r, c in cells], dtype=np.float64)
            corr = table @ s                            # (4096,)
            total += corr[corner << 10:(corner + 1) << 10]
        idx = int(np.argmax(total))
        top = float(total[idx])
        total[idx] = -np.inf
        best.append((top, t, idx))
        best.append((float(np.max(total)), t, -1))
    best.sort(reverse=True)
    top, t, idx = best[0]
    runner_up = next(b[0] for b in best[1:])
    norm = 4 * 24
    return FormatResult(unpack10(idx), t, top / norm, (top - runner_up) / norm)

