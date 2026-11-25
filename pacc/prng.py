"""
pacc.prng — Deterministic 32-bit PRNG shared bit-for-bit with the TypeScript port.

Every pseudo-random structure in PACC (LDPC graph, cell interleaver, scrambler)
is derived from this generator, never from numpy or Math.random, so encoders and
decoders in any language build identical codes. Only 32-bit unsigned integer
arithmetic is used; the TypeScript twin uses Math.imul and >>> 0.
"""
from __future__ import annotations

MASK32 = 0xFFFFFFFF


def imul32(a: int, b: int) -> int:
    """Low 32 bits of a*b (JavaScript Math.imul, unsigned)."""
    return (a * b) & MASK32


def mix_seed(*values: int) -> int:
    """Combine integers into one 32-bit seed (order-sensitive)."""
    h = 0x50414343  # "PACC"
    for v in values:
        h = imul32(h ^ (v & MASK32), 0x9E3779B1)
        h ^= h >> 15
    return h & MASK32


class Prng:
    """splitmix32-style generator: one add, two multiplies, three xorshifts per draw."""

    __slots__ = ("state",)

    def __init__(self, seed: int) -> None:
        self.state = seed & MASK32

    def next_u32(self) -> int:
        self.state = (self.state + 0x9E3779B9) & MASK32
        z = self.state
        z = imul32(z ^ (z >> 16), 0x85EBCA6B)
        z = imul32(z ^ (z >> 13), 0xC2B2AE35)
        return (z ^ (z >> 16)) & MASK32

    def below(self, n: int) -> int:
        """Integer in [0, n). Modulo bias (< 2^-20 for n < 4096) is irrelevant here."""
        return self.next_u32() % n

    def shuffle(self, items: list) -> None:
        """In-place Fisher-Yates shuffle."""
        for i in range(len(items) - 1, 0, -1):
            j = self.below(i + 1)
            items[i], items[j] = items[j], items[i]

    def bits(self, n: int) -> list[int]:
        out: list[int] = []
        while len(out) < n:
            w = self.next_u32()
            for b in range(32):
                out.append((w >> b) & 1)
        return out[:n]


def permutation(n: int, seed: int) -> list[int]:
    perm = list(range(n))
    Prng(seed).shuffle(perm)
    return perm

