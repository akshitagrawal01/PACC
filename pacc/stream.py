"""
pacc.stream — PACC Stream: payloads larger than one symbol, shown as an animated
sequence of PACC symbols carrying fountain-coded fragments.

The whole message is sealed once (compression, signature, encryption — pacc.secure),
split into K source blocks of B bytes, and an unbounded sequence of encoded blocks
is generated: ids 0..K-1 are the source blocks themselves (systematic), ids >= K are
random GF(2) combinations of all source blocks. A receiver needs K encoded blocks
plus a small random overhead: with dense random combinations, K blocks suffice with
probability ~0.29, K + 2 with ~0.77 and K + 7 with ~0.99 (measured: mean overhead
about 1.6 blocks). The receiver does
not need to see any particular frame, so a scanner can start mid-loop and missed or
undecodable frames cost nothing beyond the time to see a few more.

Each frame is an ordinary PACC symbol whose message flags are exactly FLAG_STREAM and
whose payload is

    stream id (4 B) | message length (4 B) | block size B (2 B) | block id (4 B)
    | message flags (1 B) | encoded block (B bytes)

All integers big-endian. The coefficient vector of block id e >= K is
Prng(mix_seed(0x57EA, stream id, e)).bits(K) (all-zero vectors get bit e mod K).
"""
from __future__ import annotations

import os
import struct
from collections.abc import Iterator
from dataclasses import dataclass, field

import numpy as np

from pacc import codec, secure
from pacc.prng import Prng, mix_seed
from pacc.spec import FLAG_STREAM, LEVEL_BY_NAME, grid_sizes

HEADER = struct.Struct(">IIHIB")
HEADER_SIZE = HEADER.size          # 15
MAX_BLOCKS = 4096


def coefficients(stream_id: int, esi: int, k: int) -> np.ndarray:
    """Which source blocks are XORed into encoded block `esi` (bool vector of length k)."""
    if esi < k:
        v = np.zeros(k, dtype=bool)
        v[esi] = True
        return v
    v = np.asarray(Prng(mix_seed(0x57EA, stream_id, esi)).bits(k), dtype=bool)
    if not v.any():
        v[esi % k] = True
    return v


@dataclass
class StreamPlan:
    stream_id: int
    flags: int
    message: bytes
    block_size: int
    n: int
    mcs: int
    level: int

    @property
    def k(self) -> int:
        return max(1, -(-len(self.message) // self.block_size))

    def block(self, esi: int) -> bytes:
        k, b = self.k, self.block_size
        padded = self.message.ljust(k * b, b"\0")
        src = np.frombuffer(padded, dtype=np.uint8).reshape(k, b)
        return np.bitwise_xor.reduce(src[coefficients(self.stream_id, esi, k)], axis=0).tobytes()

    def frame_payload(self, esi: int) -> bytes:
        return HEADER.pack(self.stream_id, len(self.message), self.block_size, esi, self.flags) + self.block(esi)

    def frame(self, esi: int) -> codec.EncodeResult:
        return codec.encode_grid(b"", mcs=self.mcs, level=self.level, min_grid=self.n,
                                 sealed=(FLAG_STREAM, self.frame_payload(esi)))

    def frames(self, count: int | None = None, start: int = 0) -> Iterator[codec.EncodeResult]:
        esi = start
        while count is None or esi < start + count:
            yield self.frame(esi)
            esi += 1


def plan(data: bytes, n: int = 64, mcs: int = 1, level: int | str = "M", compress: bool = True,
         security: secure.SealOptions | None = None, stream_id: int | None = None) -> StreamPlan:
    """Seal `data` and plan a stream of N x N symbols."""
    if isinstance(level, str):
        level = LEVEL_BY_NAME[level.upper()]
    if n not in grid_sizes():
        raise ValueError(f"invalid grid size {n}")
    flags, message = secure.seal(data, compress, security)
    block_size = codec.capacity(n, mcs, level) - HEADER_SIZE
    if block_size < 16:
        raise ValueError("symbol too small for stream frames; use a larger grid or a denser MCS/level")
    p = StreamPlan(stream_id if stream_id is not None else int.from_bytes(os.urandom(4), "big"),
                   flags, message, block_size, n, mcs, level)
    if p.k > MAX_BLOCKS:
        raise ValueError(f"stream would need {p.k} blocks (max {MAX_BLOCKS}); use larger frames")
    return p


# ── Receiver ──────────────────────────────────────────────────────────────────

@dataclass
class StreamStatus:
    stream_id: int
    k: int
    rank: int
    received: int
    complete: bool


@dataclass
class StreamDecoder:
    """Incremental GF(2) elimination over received encoded blocks of one stream."""
    stream_id: int | None = None
    k: int = 0
    block_size: int = 0
    length: int = 0
    flags: int = 0
    received: int = 0
    # pivot column -> (coefficient bitmask as int, block data)
    _rows: dict[int, tuple[int, np.ndarray]] = field(default_factory=dict)
    _seen: set[int] = field(default_factory=set)

    def add(self, frame_payload: bytes) -> StreamStatus | None:
        """Add a decoded frame payload (DecodeResult.payload of a stream frame)."""
        if len(frame_payload) < HEADER_SIZE:
            return None
        sid, length, bsize, esi, flags = HEADER.unpack_from(frame_payload)
        block = np.frombuffer(frame_payload[HEADER_SIZE:], dtype=np.uint8)
        if bsize == 0 or len(block) != bsize:
            return None
        k = max(1, -(-length // bsize))
        if k > MAX_BLOCKS:
            return None
        if sid != self.stream_id or (length, bsize, flags) != (self.length, self.block_size, self.flags):
            self._reset(sid, length, bsize, flags, k)          # a new stream started
        if esi in self._seen:
            return self.status()
        self._seen.add(esi)
        self.received += 1
        if self.complete:
            return self.status()
        bits = coefficients(sid, esi, k)
        c = int.from_bytes(np.packbits(bits[::-1]).tobytes(), "big") >> ((-k) % 8)
        d = block.copy()
        while c:
            p = (c & -c).bit_length() - 1
            row = self._rows.get(p)
            if row is None:
                self._rows[p] = (c, d)
                break
            c ^= row[0]
            d ^= row[1]
        return self.status()

    def _reset(self, sid: int, length: int, bsize: int, flags: int, k: int) -> None:
        self.stream_id, self.length, self.block_size, self.flags, self.k = sid, length, bsize, flags, k
        self.received = 0
        self._rows.clear()
        self._seen.clear()

    @property
    def complete(self) -> bool:
        return self.k > 0 and len(self._rows) == self.k

    def status(self) -> StreamStatus:
        return StreamStatus(self.stream_id or 0, self.k, len(self._rows), self.received, self.complete)

    def message(self) -> bytes | None:
        """The reassembled (still sealed) message once complete."""
        if not self.complete:
            return None
        solved: dict[int, np.ndarray] = {}
        for p in sorted(self._rows, reverse=True):
            c, d = self._rows[p]
            d = d.copy()
            c >>= p + 1
            q = p + 1
            while c:
                if c & 1:
                    d ^= solved[q]
                c >>= 1
                q += 1
            solved[p] = d
        return b"".join(solved[i].tobytes() for i in range(self.k))[: self.length]

    def open(self, secrets: secure.Secrets | None = None) -> secure.OpenResult | None:
        msg = self.message()
        return None if msg is None else secure.open_message(self.flags, msg, secrets)

