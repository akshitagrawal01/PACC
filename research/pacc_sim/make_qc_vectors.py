"""
Cross-language vectors for PACC QC (QR-compatible hidden chroma channel).

    python research/pacc_sim/make_qc_vectors.py            -> qc_vectors.json (Python-encoded, distorted)
    npx jiti pacc_web/scripts/pacc_qc.ts                   -> decodes them, writes ts_qc_vectors.json
    python research/pacc_sim/make_qc_vectors.py --check-ts -> zxing-cpp + Python read the TypeScript symbols

Corners/versions come from zxing-cpp, exactly what the browser gets from zxing-wasm.
"""
from __future__ import annotations

import argparse
import io
import json
import os
import sys

import cv2
import numpy as np
from PIL import Image

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, ROOT)

from pacc import qc, secure  # noqa: E402

HERE = os.path.dirname(__file__)
ED_SEED = bytes(range(32))
VISIBLE = "https://bank.example.com/pay?to=ACME&amount=120.00"
HIDDEN = b"issuer=ACME Bank;ref=INV-2026-0042"


def trusted():
    k = secure.SigningKey.from_seed(secure.ALG_ED25519, ED_SEED)
    return k, secure.Secrets(trusted_signers={k.fingerprint.hex(): (k.alg, k.public)})


def distort(rgb: np.ndarray, kind: str) -> np.ndarray:
    a = np.pad(rgb, ((60, 60), (60, 60), (0, 0)), constant_values=255)
    h, w = a.shape[:2]
    if kind == "perspective":
        src = np.float32([[0, 0], [w, 0], [w, h], [0, h]])
        dst = np.float32([[w * 0.07, h * 0.03], [w * 0.96, 0], [w, h], [w * 0.02, h * 0.93]])
        return cv2.warpPerspective(a, cv2.getPerspectiveTransform(src, dst), (w, h), borderValue=(255, 255, 255))
    if kind == "jpeg":
        buf = io.BytesIO()
        Image.fromarray(cv2.GaussianBlur(a, (0, 0), 1.0)).save(buf, "JPEG", quality=65)
        return np.asarray(Image.open(io.BytesIO(buf.getvalue())).convert("RGB"))
    if kind == "cast":
        return np.clip(a.astype(float) * [1.0, 0.85, 0.65] * 0.85, 0, 255).astype(np.uint8)
    return a


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check-ts", action="store_true")
    args = ap.parse_args()
    key, tr = trusted()
    if args.check_ts:
        vecs = json.load(open(os.path.join(HERE, "ts_qc_vectors.json")))
        bad = 0
        for v in vecs:
            grid = np.asarray(v["grid"], np.uint8).reshape(v["n"], v["n"], 3)
            img = qc.render(qc.QcEncodeResult(grid, v["version"], v["n"], 0, 0), cell_size=8)
            import zxingcpp
            z = zxingcpp.read_barcodes(img)
            r = qc.decode(img, tr)
            ok = bool(z) and z[0].text == VISIBLE and r.ok and r.hidden == HIDDEN.replace(b"ACME", b"TS") and r.bound
            if v["signed"]:
                ok = ok and bool(r.security and r.security.signature_valid and r.security.trusted)
            bad += not ok
            print(f"{v['name']:<12} plain-QR={bool(z) and z[0].text == VISIBLE} hidden={r.ok and r.hidden is not None} "
                  f"bound={r.bound} {'OK' if ok else 'FAIL ' + str(r.error)}")
        print(f"Python/zxing read {len(vecs) - bad}/{len(vecs)} TypeScript QC symbols")
        sys.exit(1 if bad else 0)

    import zxingcpp
    out = {"visible": VISIBLE, "hidden_hex": HIDDEN.hex(), "ed_seed": ED_SEED.hex(), "vectors": []}
    cases = [("plain", None), ("signed", secure.SealOptions(sign_with=key, embed_public_key=False))]
    for name, sec in cases:
        e = qc.encode(VISIBLE, HIDDEN, security=sec)
        for kind in ("clean", "perspective", "jpeg", "cast"):
            img = distort(qc.render(e, cell_size=8), kind)
            z = zxingcpp.read_barcodes(img)
            if not z:
                raise SystemExit(f"{name}/{kind}: zxing could not read the visible QR")
            p = z[0].position
            corners = [[p.top_left.x, p.top_left.y], [p.top_right.x, p.top_right.y],
                       [p.bottom_right.x, p.bottom_right.y], [p.bottom_left.x, p.bottom_left.y]]
            version = int(z[0].extra["Version"])
            r = qc.decode_at(img, corners, version, z[0].text, tr)
            if not (r.ok and r.hidden == HIDDEN and r.bound):
                raise SystemExit(f"{name}/{kind}: Python self-check failed: {r.error}")
            out["vectors"].append({
                "name": f"{name}/{kind}", "signed": sec is not None, "width": img.shape[1], "height": img.shape[0],
                "rgb": img.reshape(-1).tolist(), "corners": corners, "version": version, "visible": z[0].text,
            })
    json.dump(out, open(os.path.join(HERE, "qc_vectors.json"), "w"))
    print(f"wrote {len(out['vectors'])} QC vectors")


if __name__ == "__main__":
    main()

