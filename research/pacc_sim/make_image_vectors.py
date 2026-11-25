"""
Distorted test images for the TypeScript PACC image decoder.

    python research/pacc_sim/make_image_vectors.py
writes research/pacc_sim/image_vectors/{index.json, <case>.rgba}
"""
from __future__ import annotations

import io
import json
import os
import sys

import cv2
import numpy as np
from PIL import Image

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "tests"))

import pacc  # noqa: E402
from pacc_bench import distortions as D  # noqa: E402

OUT = os.path.join(os.path.dirname(__file__), "image_vectors")
PAYLOAD = b"https://example.com/pacc/a-reasonably-long-url?with=params&and=more_stuff_here_1234567890"


def place(a: np.ndarray, rng: np.random.Generator) -> np.ndarray:
    t, b, l, r = (int(v) for v in rng.integers(30, 70, size=4))
    c = np.full((a.shape[0] + t + b, a.shape[1] + l + r, 3), 255, np.uint8)
    c[t:t + a.shape[0], l:l + a.shape[1]] = a
    return c


def jpeg(a: np.ndarray, q: int) -> np.ndarray:
    buf = io.BytesIO()
    Image.fromarray(a).save(buf, "JPEG", quality=q)
    buf.seek(0)
    return np.asarray(Image.open(buf).convert("RGB"))


def main() -> None:
    os.makedirs(OUT, exist_ok=True)
    rng = np.random.default_rng(7)
    cases = []
    for mcs in (0, 1, 2):
        img, meta = pacc.encode(PAYLOAD, level="Q", mcs=mcs, cell_size=9, compress=False)
        base = np.asarray(img)
        variants = {
            "clean": place(base, rng),
            "rot33": D.apply_rotation(place(base, rng), 33),
            "yaw45": D.apply_perspective_tilt(place(base, rng), yaw_deg=45),
            "blur_jpeg": jpeg(cv2.GaussianBlur(place(base, rng), (0, 0), 1.5), 50),
            "noise40": D.apply_gaussian_noise(place(base, rng), sigma=40, rng=rng),
            "scratch16": place(D.apply_scratch(base, "diagonal", 16, rng), rng),
            "stain15": place(D.apply_cell_erasures(base, 0.15, cell_size=9, rng=rng, fill_mode="chromatic"), rng),
            "hue150": D.apply_hue_rotation(place(base, rng), 150),
            "small": cv2.resize(place(base, rng), None, fx=0.3, fy=0.3, interpolation=cv2.INTER_AREA),
        }
        for name, arr in variants.items():
            arr = np.ascontiguousarray(arr[..., :3].astype(np.uint8))
            rgba = np.concatenate([arr, np.full(arr.shape[:2] + (1,), 255, np.uint8)], axis=2)
            fname = f"mcs{mcs}_{name}.rgba"
            rgba.tofile(os.path.join(OUT, fname))
            py = pacc.decode(arr)
            cases.append({"file": fname, "width": arr.shape[1], "height": arr.shape[0], "mcs": mcs,
                          "case": name, "python_ok": bool(py.ok and py.payload == PAYLOAD)})
    with open(os.path.join(OUT, "index.json"), "w") as f:
        json.dump({"payload_hex": PAYLOAD.hex(), "cases": cases}, f, indent=1)
    ok = sum(c["python_ok"] for c in cases)
    print(f"wrote {len(cases)} images; python decodes {ok}/{len(cases)}")


if __name__ == "__main__":
    main()

