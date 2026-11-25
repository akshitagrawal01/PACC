"""
pacc.golay — Extended binary Golay code (24, 12, 8) with soft-decision ML decoding.

Used for the format word: 12 information bits per corner copy, any 3 bit errors
(or 7 erasures) per copy are correctable, and the decoder correlates soft
luminance values against all 4096 codewords at once.
"""
from __future__ import annotations

import functools

import numpy as np

# Generator polynomial of the cyclic (23, 12) Golay code:
# g(x) = x^11 + x^10 + x^6 + x^5 + x^4 + x^2 + 1
_G23 = 0b110001110101


def _encode23(info: int) -> int:
    """Systematic cyclic encoding: info in the top 12 bits, remainder in the low 11."""
    reg = info << 11
    for bit in range(22, 10, -1):
        if reg & (1 << bit):
            reg ^= _G23 << (bit - 11)
    return (info << 11) | reg


def encode(info: int) -> int:
    """12 information bits -> 24-bit codeword (23-bit Golay + even-parity bit as bit 0)."""
    if not 0 <= info < 4096:
        raise ValueError("Golay info must be 12 bits")
    cw23 = _encode23(info)
    parity = cw23.bit_count() & 1
    return (cw23 << 1) | parity


def codeword_bits(info: int) -> list[int]:
    """Codeword as a list of 24 bits, most significant first."""
    cw = encode(info)
    return [(cw >> (23 - i)) & 1 for i in range(24)]


@functools.lru_cache(maxsize=1)
def bipolar_table() -> np.ndarray:
    """(4096, 24) array: +1 for a 0 bit, -1 for a 1 bit."""
    table = np.empty((4096, 24), dtype=np.float32)
    for info in range(4096):
        table[info] = [1.0 - 2.0 * b for b in codeword_bits(info)]
    return table


def min_distance() -> int:
    """Exhaustive check of the code's minimum distance (should be 8)."""
    weights = [encode(i).bit_count() for i in range(1, 4096)]
    return min(weights)

