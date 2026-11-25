"""
Cross-language vectors for PACC Stream (pacc/stream.py vs pacc_web/src/lib/pacc/stream.ts).

    python research/pacc_sim/make_stream_vectors.py   ->  stream_vectors.json
    npx jiti pacc_web/scripts/pacc_secure.ts           (checks frame payloads and reassembly)
"""
from __future__ import annotations

import json
import os
import sys
import zlib

import numpy as np

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, ROOT)

from pacc import stream  # noqa: E402


def main() -> None:
    data = np.random.default_rng(9).bytes(6000)
    p = stream.plan(data, n=48, mcs=1, level="M", compress=False, stream_id=0xC0FFEE)
    rng = np.random.default_rng(10)
    # Receiver starts mid-loop and misses ~30% of frames.
    esis, esi = [], int(rng.integers(0, p.k))
    dec = stream.StreamDecoder()
    while not dec.complete:
        esi += 1
        if rng.random() < 0.3:
            continue
        esis.append(esi)
        dec.add(p.frame_payload(esi))
    assert dec.message() == p.message
    frames = []
    for e in esis[:3]:
        g = p.frame(e).grid
        frames.append({"esi": e, "n": int(g.shape[0]), "grid": g.reshape(-1).tolist()})
    out = {
        "data_hex": data.hex(), "stream_id": p.stream_id, "n": p.n, "mcs": p.mcs, "level": p.level, "k": p.k,
        "block_size": p.block_size, "esis": esis,
        "payload_crcs": [zlib.crc32(p.frame_payload(e)) for e in esis],
        "frames": frames,
    }
    path = os.path.join(os.path.dirname(__file__), "stream_vectors.json")
    with open(path, "w") as f:
        json.dump(out, f)
    print(f"wrote stream vectors (K={p.k}, {len(esis)} frames received) -> {path}")


if __name__ == "__main__":
    main()

