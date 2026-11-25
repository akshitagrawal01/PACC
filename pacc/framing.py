"""
pacc.framing — Message framing, CRC-32, scrambling and the cell interleaver.

Message (k bits, before scrambling):
    flags (1 B) | payload length (2 B, big-endian) | payload | CRC-32 (4 B) | zero padding
The CRC covers flags, length and payload. The whole k-bit block (padding
included) is XORed with a PRNG sequence so cell colours stay uniformly
distributed whatever the payload, which keeps colour statistics stable and
prevents accidental finder-like shapes.
"""
from __future__ import annotations

import functools
import zlib

import numpy as np

from pacc.prng import Prng, mix_seed, permutation
from pacc.spec import MESSAGE_OVERHEAD


def build_message(payload: bytes, flags: int) -> bytes:
    if len(payload) > 0xFFFF:
        raise ValueError("payload too long for a single PACC symbol")
    head = bytes([flags]) + len(payload).to_bytes(2, "big") + payload
    return head + zlib.crc32(head).to_bytes(4, "big")


@functools.lru_cache(maxsize=64)
def scrambler(k: int) -> np.ndarray:
    return np.asarray(Prng(mix_seed(0x5C2A, k)).bits(k), dtype=np.uint8)


def message_to_info_bits(message: bytes, k: int) -> np.ndarray:
    if 8 * len(message) > k:
        raise ValueError("message does not fit")
    bits = np.zeros(k, dtype=np.uint8)
    bits[: 8 * len(message)] = np.unpackbits(np.frombuffer(message, dtype=np.uint8))
    return bits ^ scrambler(k)


def parse_info_bits(bits: np.ndarray) -> tuple[int, bytes] | None:
    """Return (flags, payload) if the CRC verifies, else None."""
    k = len(bits)
    raw = np.packbits(np.asarray(bits, dtype=np.uint8) ^ scrambler(k)).tobytes()
    if len(raw) < MESSAGE_OVERHEAD:
        return None
    flags = raw[0]
    length = int.from_bytes(raw[1:3], "big")
    end = 3 + length
    if end + 4 > len(raw):
        return None
    if zlib.crc32(raw[:end]).to_bytes(4, "big") != raw[end:end + 4]:
        return None
    return flags, raw[3:end]


@functools.lru_cache(maxsize=64)
def interleaver(n: int) -> np.ndarray:
    """Transmitted bit i carries codeword bit perm[i]."""
    return np.asarray(permutation(n, mix_seed(0x1A7E, n)), dtype=np.int64)

