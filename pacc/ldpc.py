"""
pacc.ldpc — Irregular repeat-accumulate (IRA) LDPC codes of any length and rate.

Structure (same family as DVB-S2): H = [H_info | staircase]. Check i connects a
set of information bits plus parity bits p_i and p_{i-1}, so encoding is linear
time: p_i = p_{i-1} XOR (XOR of info bits on check i).

The graph is built deterministically from (n, k) with the shared integer PRNG,
using only integer arithmetic, so the TypeScript port constructs the identical
code. Degree profile follows the DVB-S2 pattern: two classes of information
bits (degree 3 and a heavier degree) and near-constant check degree.

Decoding is flooding normalised min-sum, vectorised over edges.
"""
from __future__ import annotations

import functools
from dataclasses import dataclass

import numpy as np

from pacc.prng import Prng, mix_seed

LLR_CLIP = 30.0


@dataclass(frozen=True)
class IraCode:
    n: int                      # codeword length (bits)
    k: int                      # information length (bits)
    check_info: tuple           # per check: tuple of info-bit indices
    # Edge arrays (sorted by check) used by the decoder:
    e_check: np.ndarray
    e_var: np.ndarray
    check_start: np.ndarray     # first edge of each check
    check_deg: np.ndarray

    @property
    def m(self) -> int:
        return self.n - self.k


def degree_profile(n: int, k: int) -> tuple[int, int, int]:
    """Return (info edges per check target, heavy degree, number of heavy info bits)."""
    m = n - k
    # Information edges per check ~ 4 R / (1 - R) + 1, matching DVB-S2's check degrees
    # (2 at R=1/4, 3 at 1/3, 5 at 1/2, 9 at 2/3, 13 at 3/4).
    dc = max(2, (8 * k + 3 * m) // (2 * m))
    heavy = 12 if (10 * k < 4 * n or 10 * k > 7 * n) else 8
    heavy = min(heavy, m)
    light = min(3, m)
    total = m * dc
    n_heavy = 0 if heavy <= light else (total - light * k) // (heavy - light)
    n_heavy = max(0, min(k, n_heavy))
    return dc, heavy, n_heavy


@functools.lru_cache(maxsize=64)
def build(n: int, k: int) -> IraCode:
    if not 0 < k < n:
        raise ValueError(f"invalid LDPC size n={n} k={k}")
    m = n - k
    _, heavy, n_heavy = degree_profile(n, k)
    light = min(3, m)

    # Variable sockets: info bit v repeated deg(v) times.
    sockets: list[int] = []
    for v in range(k):
        sockets.extend([v] * (heavy if v < n_heavy else light))
    rng = Prng(mix_seed(0x1D9C, n, k))
    rng.shuffle(sockets)

    # Deal sockets to checks as evenly as possible. A socket is rejected at a check if
    # its variable is already there (duplicate edge) or already shares another check
    # with one of the members (a length-4 cycle, which causes error floors); rejected
    # sockets are swapped with a later one (deterministic, bounded attempts). Pairs are
    # keyed as v * k + u so the bookkeeping stays integer-only.
    total = len(sockets)
    base, extra = divmod(total, m)
    check_info: list[tuple] = []
    used_pairs: set[int] = set()

    def conflicts(v: int, members: list[int]) -> bool:
        for u in members:
            if u == v:
                return True
            if (min(u, v) * k + max(u, v)) in used_pairs:
                return True
        return False

    pos = 0
    for c in range(m):
        deg = base + (1 if c < extra else 0)
        members: list[int] = []
        for _ in range(deg):
            if pos >= total:
                break
            if conflicts(sockets[pos], members):
                for _attempt in range(48):
                    if pos + 1 >= total:
                        break
                    j = pos + 1 + rng.below(total - pos - 1)
                    if not conflicts(sockets[j], members):
                        sockets[pos], sockets[j] = sockets[j], sockets[pos]
                        break
            v = sockets[pos]
            pos += 1
            if v in members:
                continue  # unavoidable duplicate: drop the edge (it would cancel in GF(2))
            for u in members:
                used_pairs.add(min(u, v) * k + max(u, v))
            members.append(v)
        check_info.append(tuple(sorted(members)))

    # Edge list sorted by check: info edges, then p_{c-1} (c >= 1), then p_c.
    e_check: list[int] = []
    e_var: list[int] = []
    for c, check_members in enumerate(check_info):
        for v in check_members:
            e_check.append(c)
            e_var.append(v)
        if c > 0:
            e_check.append(c)
            e_var.append(k + c - 1)
        e_check.append(c)
        e_var.append(k + c)
    ec = np.asarray(e_check, dtype=np.int32)
    ev = np.asarray(e_var, dtype=np.int32)
    check_deg = np.bincount(ec, minlength=m).astype(np.int32)
    check_start = np.concatenate(([0], np.cumsum(check_deg)[:-1])).astype(np.int32)
    return IraCode(n, k, tuple(check_info), ec, ev, check_start, check_deg)


def encode(code: IraCode, info_bits: np.ndarray) -> np.ndarray:
    info = np.asarray(info_bits, dtype=np.uint8)
    if info.shape != (code.k,):
        raise ValueError(f"expected {code.k} info bits, got {info.shape}")
    parity = np.empty(code.m, dtype=np.uint8)
    prev = 0
    for c, members in enumerate(code.check_info):
        s = 0
        for v in members:
            s ^= int(info[v])
        prev ^= s
        parity[c] = prev
    return np.concatenate([info, parity])


def syndrome_ok(code: IraCode, bits: np.ndarray) -> bool:
    vals = bits[code.e_var].astype(np.int32)
    return not np.any(np.add.reduceat(vals, code.check_start) & 1)


def decode(code: IraCode, llr: np.ndarray, max_iter: int = 80) -> tuple[np.ndarray, np.ndarray, bool, int]:
    """Sum-product belief propagation (tanh rule in the log domain). llr > 0 favours bit 0.

    Min-sum was measured ~2 dB worse on these codes at low rate (heavy degree-12
    information bits), so the exact rule is used.

    Returns (hard bits, posterior LLRs, converged, iterations used).
    """
    ch = np.clip(np.asarray(llr, dtype=np.float64), -LLR_CLIP, LLR_CLIP)
    ec, ev, start = code.e_check, code.e_var, code.check_start
    c2v = np.zeros(len(ev), dtype=np.float64)
    post = ch.copy()
    bits = (post < 0).astype(np.uint8)
    if syndrome_ok(code, bits):
        return bits, post, True, 0

    for it in range(1, max_iter + 1):
        v2c = np.clip(post[ev] - c2v, -LLR_CLIP, LLR_CLIP)
        neg = (v2c < 0).astype(np.int32)
        log_t = np.log(np.maximum(np.tanh(np.abs(v2c) * 0.5), 1e-15))
        # Exclude each edge's own contribution from its check's totals.
        excl_log = np.add.reduceat(log_t, start)[ec] - log_t
        excl_neg = (np.add.reduceat(neg, start)[ec] - neg) & 1
        mag = 2.0 * np.arctanh(np.minimum(np.exp(excl_log), 1.0 - 1e-15))
        c2v = np.where(excl_neg == 1, -mag, mag)
        post = ch + np.bincount(ev, weights=c2v, minlength=code.n)
        bits = (post < 0).astype(np.uint8)
        if syndrome_ok(code, bits):
            return bits, post, True, it
    return bits, post, False, max_iter

