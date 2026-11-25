"""
Write cross-language parity vectors for the TypeScript PACC port.

    python research/pacc_sim/make_parity_vectors.py  ->  research/pacc_sim/parity_vectors.json

The TypeScript test (pacc_web/scripts/pacc_parity.ts) must reproduce every
encoding bit-for-bit and decode every noisy grid.
"""
from __future__ import annotations

import json
import os
import sys
import zlib

import numpy as np

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, ROOT)

from pacc import codec, fmt, framing, golay, ldpc  # noqa: E402
from pacc.prng import Prng, mix_seed, permutation  # noqa: E402


def code_digest(n: int, k: int) -> int:
    code = ldpc.build(n, k)
    flat = []
    for c, members in enumerate(code.check_info):
        flat.append(c)
        flat.extend(members)
    return zlib.crc32(np.asarray(flat, dtype=np.int32).tobytes())


def main() -> None:
    rng = np.random.default_rng(42)
    p = Prng(12345)
    vectors: dict = {
        "prng": [p.next_u32() for _ in range(8)],
        "mix_seed": [mix_seed(1, 2, 3), mix_seed(0x1D9C, 888, 316)],
        "permutation_10_7": permutation(10, 7),
        "golay": [golay.encode(i) for i in (0, 1, 2, 1000, 4095)],
        "ldpc": [{"n": n, "k": k, "digest": code_digest(n, k)} for n, k in [(888, 316), (1200, 600), (2400, 1920), (5000, 1664)]],
        "interleaver_head": [int(x) for x in framing.interleaver(1294)[:16]],
        "grids": [],
    }
    payloads = [b"hello PACC", b"https://example.com/pacc/a-reasonably-long-url?with=params&and=more_stuff_here_1234567890",
                bytes(range(256)) * 2]
    for payload in payloads:
        for mcs in (0, 1, 2):
            for level in "LQH":
                e = codec.encode_grid(payload, mcs=mcs, level=level, compress=False)
                noisy = np.clip(fmt.dihedral(e.grid.astype(float) / 255, int(rng.integers(0, 8)))
                                + rng.normal(0, 0.08, e.grid.shape), 0, 1)
                noisy = np.round(noisy, 4)
                llrs = codec.decode_grid(noisy).channel_llrs
                vectors["grids"].append({
                    "payload_hex": payload.hex(), "mcs": mcs, "level": level, "n": e.n,
                    "grid_crc": zlib.crc32(e.grid.tobytes()),
                    "noisy": [float(v) for v in noisy.reshape(-1)],
                    "llr_head": [] if llrs is None else [float(v) for v in llrs[:64]],
                })
    out = os.path.join(os.path.dirname(__file__), "parity_vectors.json")
    with open(out, "w") as f:
        json.dump(vectors, f)
    print(f"wrote {len(vectors['grids'])} grid vectors -> {out}")


if __name__ == "__main__":
    main()

