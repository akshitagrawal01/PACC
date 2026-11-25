"""
pacc.spec — Format constants for PACC (draft; see docs/pacc/SPEC.md).
"""
from __future__ import annotations

import numpy as np

QUIET_ZONE = 4                 # cells of white around the symbol
FINDER = 7                     # finder pattern side (cells)
CORNER_BLOCK = 8               # finder + 1-cell light separator
GRID_MIN = 24
GRID_STEP = 4
GRID_INDEX_BITS = 5            # N = 24 + 4 * index, index 0..31  ->  N in [24, 148]
GRID_MAX = GRID_MIN + GRID_STEP * (2 ** GRID_INDEX_BITS - 1)

PILOT_PERIOD = 5               # one pilot per 5x5 block ...
PILOT_OFFSET = 2               # ... at (2, 2) inside the block (~4% of cells)


def grid_sizes() -> list[int]:
    return list(range(GRID_MIN, GRID_MAX + 1, GRID_STEP))


def grid_index(n: int) -> int:
    if n < GRID_MIN or n > GRID_MAX or (n - GRID_MIN) % GRID_STEP:
        raise ValueError(f"invalid PACC grid size {n}")
    return (n - GRID_MIN) // GRID_STEP


# ── Modulation and coding ─────────────────────────────────────────────────────
# Palette entry i encodes the bit label i (most significant bit first).
# Colours are nominal sRGB; the decoder never relies on them directly — it learns
# the actual captured colours from pilot cells.
PALETTES: dict[int, dict] = {
    0: {"name": "BW", "bits": 1,
        "rgb": [(255, 255, 255), (0, 0, 0)]},
    # Process-ink tetrahedron: the four maximally separated points of the RGB cube
    # that exclude white, and printable with CMYK inks by construction.
    1: {"name": "KCMY", "bits": 2,
        "rgb": [(0, 0, 0), (0, 255, 255), (255, 0, 255), (255, 255, 0)]},
    # RGB cube corners; label bits are the (R, G, B) on/off states, so neighbouring
    # corners differ in exactly one bit (a natural Gray labelling).
    2: {"name": "CUBE8", "bits": 3,
        "rgb": [(0, 0, 0), (0, 0, 255), (0, 255, 0), (0, 255, 255),
                (255, 0, 0), (255, 0, 255), (255, 255, 0), (255, 255, 255)]},
}
MCS_BITS = 3

# Robustness levels: LDPC code rate as (numerator, denominator).
LEVELS: dict[int, tuple[str, int, int]] = {
    0: ("L", 4, 5),
    1: ("M", 2, 3),
    2: ("Q", 1, 2),
    3: ("H", 1, 3),
}
LEVEL_BY_NAME = {v[0]: k for k, v in LEVELS.items()}


def palette_array(mcs: int) -> np.ndarray:
    """(M, 3) float palette in [0, 1]."""
    return np.asarray(PALETTES[mcs]["rgb"], dtype=np.float64) / 255.0


def bits_per_cell(mcs: int) -> int:
    return int(PALETTES[mcs]["bits"])


# ── Message framing ───────────────────────────────────────────────────────────
FLAG_DEFLATE = 0x01            # payload is raw-DEFLATE compressed
FLAG_SIGNED = 0x02             # signature layer present (pacc.secure)
FLAG_ENCRYPTED = 0x04          # encryption envelope present (pacc.secure)
FLAG_STREAM = 0x08             # payload is one fountain-coded fragment of a stream (pacc.stream)
FLAG_LAYERED = 0x10            # a fine chroma layer is present inside the cells (pacc.hier)
MESSAGE_OVERHEAD = 1 + 2 + 4   # flags + length + CRC-32

