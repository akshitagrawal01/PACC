"""
Cross-language vectors for distance-adaptive layered symbols (pacc/hier.py vs
pacc_web/src/lib/pacc/hier.ts).

    python research/pacc_sim/make_layered_vectors.py   ->  layered_vectors.json
    npx jiti pacc_web/scripts/pacc_layered.ts           (bit-exact encoding; near and far decoding)
"""
from __future__ import annotations

import base64
import io
import json
import os
import sys
import zlib

import cv2
import numpy as np
from PIL import Image

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, ROOT)

import pacc  # noqa: E402
from pacc import hier  # noqa: E402

COARSE = b"https://ex.co/p/42"
FINE = b"batch 2026-10-A; origin Pune; expiry 2027-04; lot 7781-B; QA passed 2026-10-02 " * 2


def main() -> None:
    e = hier.encode(COARSE, FINE, level="H")
    img = np.pad(hier.render(e, sub_px=5), ((40, 40), (40, 40), (0, 0)), constant_values=255)
    h, w = img.shape[:2]
    src = np.float32([[0, 0], [w, 0], [w, h], [0, h]])
    dst = np.float32([[w * 0.08, h * 0.03], [w * 0.95, 0], [w, h], [w * 0.03, h * 0.92]])
    buf = io.BytesIO()
    Image.fromarray(cv2.GaussianBlur(img, (0, 0), 1.0)).save(buf, "JPEG", quality=70)
    cases = {
        "near": (img, True),
        "perspective": (cv2.warpPerspective(img, cv2.getPerspectiveTransform(src, dst), (w, h),
                                            borderValue=(255, 255, 255)), True),
        "blur_jpeg": (np.asarray(Image.open(io.BytesIO(buf.getvalue())).convert("RGB")), True),
        "mid_scale_0.3": (cv2.resize(img, None, fx=0.3, fy=0.3, interpolation=cv2.INTER_AREA), True),
        # As the web Generator renders it: level Q, quiet zone only (no extra margin). This case
        # caught a TypeScript Otsu-threshold bug on crisp tinted images.
        "level_q_tight": (hier.render(hier.encode(COARSE, FINE, level="Q"), sub_px=5), True),
        "far": (cv2.GaussianBlur(cv2.resize(img, None, fx=0.2, fy=0.2, interpolation=cv2.INTER_AREA), (0, 0), 0.8),
                False),
    }
    out = {"coarse_hex": COARSE.hex(), "fine_hex": FINE.hex(), "n": e.n, "nf": e.nf,
           "grid_crc": zlib.crc32(e.grid.tobytes()), "images": []}
    for name, (im, fine_expected) in cases.items():
        r = pacc.decode(im)
        fine_ok = bool(r.fine and r.fine.ok and r.fine.payload == FINE)
        if not (r.ok and r.payload == COARSE) or fine_ok != fine_expected:
            raise SystemExit(f"{name}: Python self-check failed (coarse {r.ok}, fine {fine_ok})")
        out["images"].append({"name": name, "width": im.shape[1], "height": im.shape[0], "fine": fine_expected,
                              "rgb_b64": base64.b64encode(np.ascontiguousarray(im).tobytes()).decode()})
    path = os.path.join(os.path.dirname(__file__), "layered_vectors.json")
    with open(path, "w") as f:
        json.dump(out, f)
    print(f"wrote {len(out['images'])} layered vectors (coarse N={e.n}, fine {e.nf}x{e.nf}) -> {path}")


if __name__ == "__main__":
    main()
