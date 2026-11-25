"""
pacc_suites.py — Test Lab suites that mirror the paper's simulation benchmarks on real cameras.

Each suite reuses tests/pacc_bench (same symbols at equal footprint, same distortions, same
deterministic seeds), so a phone session can be compared condition-by-condition with the
synthetic numbers:

    n1_capacity   N1  payload tiers, PACC 4/8 colours vs QR-H at equal footprint
    n2_robustness N2  everyday conditions (the demanding level of each simulation family), PACC vs QR-H
    n5_security   N5  signatures (incl. a tampered symbol that must be rejected) and encryption
    n6_multiframe N6  hand-held video in dim light with a moving reflection (looping animation), PACC vs QR-H
    n7_layers_qc  N7  layered symbols read far (coarse) and near (fine); QR-compatible symbols
    stream        —   animated PACC Stream carrying 0.5–1.5 KB
    paper_set         all of the above in one session

Item fields beyond the classic Test Lab ones:
    group, condition, codec, severity   tags used by tests/test_lab_report.py
    expect      what the phone must report: text | signed | reject | coarse | fine | qc_hidden
    secrets     keys the phone loads for this item (trusted signers, recipient private keys)
    frames, fps looping animation (stream and multi-frame items); dataUrl is the first frame
    hint        instruction shown to the tester (e.g. scan from ~1 m)
"""
from __future__ import annotations

import base64
import hashlib
import io
import json
import os
import sys
import time
from collections.abc import Callable
from functools import partial
from typing import Any

import cv2
import numpy as np
from PIL import Image

_here = os.path.dirname(os.path.abspath(__file__))
_root = os.path.abspath(os.path.join(_here, "..", ".."))
for _p in (_root, os.path.join(_root, "tests")):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from pacc_bench import common as C

import pacc
from pacc import codec, hier, qc, secure
from pacc import stream as nstream
from pacc.render import render as render_grid

DISPLAY_SCALE = 1          # images are exactly the benchmark images (360 px footprint); the host upscales them
LEVEL_RATE = {"L": "4/5", "M": "2/3", "Q": "1/2", "H": "1/3"}
PALETTE_BITS = {0: 1, 1: 2, 2: 3}


# ── helpers ───────────────────────────────────────────────────────────────────

def _png(arr: np.ndarray, scale: int = DISPLAY_SCALE) -> str:
    if scale != 1:
        arr = cv2.resize(arr, None, fx=scale, fy=scale, interpolation=cv2.INTER_NEAREST)
    buf = io.BytesIO()
    Image.fromarray(np.ascontiguousarray(arr)).save(buf, format="PNG", optimize=True)
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


def _fit(prefix: str, size: int) -> bytes:
    """Unique, deterministic ASCII payload of exactly `size` bytes starting with `prefix`."""
    filler = (C.PAYLOAD.decode() + " ") * (size // len(C.PAYLOAD) + 2)
    return (prefix + " " + filler)[:size].encode()


def _codec_meta(c: str) -> dict:
    if c.startswith("PACC-"):
        _, mcs, level = c.split("-")
        bits = PALETTE_BITS[int(mcs)]
        return {"codeType": "PACC", "badge": f"PACC {2 ** bits} colours", "eccLevel": f"LDPC {level} ({LEVEL_RATE[level]})",
                "bitsPerCell": f"{bits}.0 bits/cell"}
    return {"codeType": "QR", "badge": f"QR {c[3:]}", "eccLevel": f"Level {c[3:]}", "bitsPerCell": "1.0 bit/cell"}


def _verify(item: dict, img: np.ndarray, secrets_: secure.Secrets | None = None, password: str | None = None) -> bool:
    """Same check the phone performs, run once on the displayed image (sanity flag only)."""
    try:
        expect, want = item["expect"], item["payload"]
        if item["codeType"] == "QR":
            import zxingcpp
            z = zxingcpp.read_barcodes(img) or zxingcpp.read_barcodes(cv2.medianBlur(img, 3))
            return bool(z) and z[0].text == want
        if item["codeType"] == "PACC_QC":
            h = qc.decode(img, secrets=secrets_)
            return bool(h.ok and h.bound and h.hidden is not None and h.hidden.decode() == want)
        s = secrets_ or secure.Secrets()
        if password:
            s.password = password
        r = pacc.decode(img, secrets=s)
        if expect == "fine":
            return bool(r.fine is not None and r.fine.ok and r.fine.payload == want.encode())
        if expect == "reject":
            return bool(r.ok and r.security is not None and r.security.signature_valid is False)
        if expect == "signed" and not (r.security is not None and r.security.signature_valid):
            return False
        return bool(r.ok and r.payload == want.encode())
    except Exception:  # noqa: BLE001  (a sanity flag: any decoder error means "not read")
        return False


def _item(*, id: str, group: str, condition: str, codec_name: str, label: str, sublabel: str, img: np.ndarray,
          payload: bytes | str, grid_side: int | None, expect: str = "text", severity: float | None = None,
          code_type: str | None = None, extra: dict | None = None, verify: Callable[[dict, np.ndarray], bool] | None = None,
          scale: int = DISPLAY_SCALE) -> dict:
    text = payload.decode() if isinstance(payload, bytes) else payload
    meta = _codec_meta(codec_name) if codec_name.startswith(("PACC-", "QR-")) else {
        "codeType": code_type or "PACC", "badge": codec_name, "eccLevel": "", "bitsPerCell": ""}
    if code_type:
        meta["codeType"] = code_type
    it: dict[str, Any] = {
        "id": id, **meta, "label": label, "sublabel": sublabel, "gridSide": grid_side, "cellSize": 9,
        "payload": text, "payloadBytes": len(text.encode()), "dataUrl": _png(img, scale),
        "group": group, "condition": condition, "codec": codec_name, "severity": severity, "expect": expect,
    }
    if extra:
        it.update(extra)
    t0 = time.perf_counter()
    it["serverDecodeSuccess"] = (verify or _verify)(it, img)
    it["serverDecodeLatencyMs"] = round((time.perf_counter() - t0) * 1000, 1)
    return it


def _distort(sym: np.ndarray, kind: str, value: float, rng: np.random.Generator) -> np.ndarray:
    """The N2 distortion, minus the final simulated sensor noise (sigma 3): the phone camera adds
    real sensor noise, and leaving it out keeps the images small. Damage, lighting and geometry
    are identical to the simulation (same function, same seeds)."""
    from pacc_bench import distortions as D
    original = D.apply_gaussian_noise

    def no_capture_noise(a, sigma=0.0, rng=None, **kw):
        return a if sigma == 3.0 else original(a, sigma=sigma, rng=rng, **kw)

    D.apply_gaussian_noise = no_capture_noise
    try:
        return C.distort(sym, kind, value, rng)
    finally:
        D.apply_gaussian_noise = original


# ── N1 capacity ───────────────────────────────────────────────────────────────

N1_TIERS = [32, 128, 256, 512, 1024]
N1_CODECS = ["PACC-1-Q", "PACC-2-Q", "QR-H"]


def suite_n1() -> list[dict]:
    items: list[dict] = []
    for size in N1_TIERS:
        for c in N1_CODECS:
            idx = len(items) + 1
            payload = _fit(f"N1-{idx:02d}", size)
            img = C.place(C.symbol(c, payload), np.random.default_rng(C.seed_for("n1-place", size, c)))
            items.append(_item(id=f"n1-{idx}", group="N1", condition=f"{size} B", codec_name=c, severity=size,
                               label=f"{size} B", sublabel=f"Capacity · {c} · same printed size", img=img,
                               payload=payload, grid_side=C.modules_of(c, payload)))
    return items


# ── N2 robustness ─────────────────────────────────────────────────────────────

def _n2_label(kind: str, v: float) -> str:
    pct = round(v * 100)
    return {
        "yaw_deg": f"Tilt {v:g}°", "downscale": f"Far away ({pct} % size)", "gaussian_blur_px": f"Out of focus ({v:g} px)",
        "motion_blur_px": f"Hand shake ({v:g} px)", "gaussian_noise_sigma": f"Dim light (noise σ{v:g})",
        "white_balance": "Warm light" if v > 0 else "Cool light", "shadow_atten": f"Shadow ({pct} % darker)",
        "glare_intensity": "Glare (reflection)", "faded_print": f"Faded print ({pct} % colour)",
        "print_hue_deg": f"Printer colour shift {v:g}°", "jpeg_quality": f"JPEG quality {v:g}",
        "smudge_frac": f"Stains ({pct} %)", "occlusion_area": f"{pct} % covered", "crease_px": f"Crease ({v:g} px)",
        "everyday": {1: "Everyday: lit room", 2: "Everyday: dim warm room", 3: "Everyday: dim restaurant table"}.get(int(v), f"Everyday scene {v:g}"),
    }[kind]


# Clean, then the demanding level of every everyday family of the simulation (both light colours).
# The mild levels decode for every code in simulation; the phone camera adds its own capture effects.
N2_CONDITIONS: list[tuple[str, float, str]] = [("clean", 0, "Clean")] + [
    (k, v, _n2_label(k, v)) for k, vals in C.SWEEPS.items() for v in (vals if k == "white_balance" else vals[-1:])]
N2_CODECS = ["PACC-1-Q", "PACC-2-Q", "QR-H"]


def suite_n2() -> list[dict]:
    items: list[dict] = []
    size = len(C.PAYLOAD)
    for kind, value, name in N2_CONDITIONS:
        for c in N2_CODECS:
            idx = len(items) + 1
            payload = _fit(f"N2-{idx:03d}", size)               # unique text, same length as the N2 payload
            rng = np.random.default_rng(C.seed_for(kind, value, 0))     # same damage for every codec (paired)
            sym = C.symbol(c, payload)
            img = C.place(sym, rng) if kind == "clean" else _distort(sym, kind, value, rng)
            items.append(_item(id=f"n2-{idx}", group="N2", condition=name, codec_name=c, severity=value,
                               label=name, sublabel=f"Robustness · {c} · {kind}={value}", img=img,
                               payload=payload, grid_side=C.modules_of(c, payload)))
    return items


# ── N5 security ───────────────────────────────────────────────────────────────

def _keys():
    """Fixed test keys so sessions are reproducible (never use these for anything real)."""
    def s(tag: str) -> bytes:
        return C.seed_for("pacc-testlab-key", tag).to_bytes(4, "big") * 8

    ed = secure.SigningKey.from_seed(secure.ALG_ED25519, s("ed"))
    pq = secure.SigningKey.from_seed(secure.ALG_MLDSA44, s("mldsa"))
    rk = secure.RecipientKey.from_private(s("x25519"))
    xk = secure.PqRecipientKey.from_seed(s("xwing"))
    return ed, pq, rk, xk


def _trusted(k: secure.SigningKey) -> dict:
    return {"alg": k.alg, "publicKeyHex": k.public.hex(), "fingerprint": k.fingerprint.hex()}


def _tampered(text: bytes, key: secure.SigningKey) -> tuple[int, bytes]:
    """A correctly framed symbol whose content was changed after signing."""
    flags, body = secure.seal(text, False, secure.SealOptions(sign_with=key))
    i = body.find(text)
    if i < 0:
        raise RuntimeError("payload not found in sealed body")
    b = bytearray(body)
    b[i] = ord("X") if b[i] != ord("X") else ord("Y")
    return flags, bytes(b)


def suite_n5() -> list[dict]:
    ed, pq, rk, xk = _keys()
    pw = "test lab passphrase"
    variants: list[tuple[str, secure.SealOptions | None, dict, str, secure.Secrets, dict]] = [
        ("Plain", None, {}, "text", secure.Secrets(), {}),
        ("Ed25519, key embedded", secure.SealOptions(sign_with=ed), {}, "signed", secure.Secrets(), {}),
        ("Ed25519, key id", secure.SealOptions(sign_with=ed, embed_public_key=False), {"trustedSigners": [_trusted(ed)]},
         "signed", secure.Secrets(trusted_signers={ed.fingerprint.hex(): (ed.alg, ed.public)}), {}),
        ("ML-DSA-44, key id", secure.SealOptions(sign_with=pq, embed_public_key=False), {"trustedSigners": [_trusted(pq)]},
         "signed", secure.Secrets(trusted_signers={pq.fingerprint.hex(): (pq.alg, pq.public)}), {}),
        ("Passphrase", secure.SealOptions(password=pw, kdf_profile=0), {}, "text", secure.Secrets(password=pw), {"password": pw}),
        ("To key, X25519", secure.SealOptions(recipient=rk.public), {"recipientPrivateHex": [rk.private.hex()]}, "text",
         secure.Secrets(recipient_keys=[rk]), {}),
        ("To key, X-Wing (PQ)", secure.SealOptions(recipient_pq=xk.public), {"pqRecipientSeedHex": [xk.seed.hex()]}, "text",
         secure.Secrets(pq_recipient_keys=[xk]), {}),
    ]
    items: list[dict] = []
    for name, opts, wire, expect, sec, extra in variants:
        idx = len(items) + 1
        payload = _fit(f"N5-{idx:02d}", 64)
        mcs, level = 1, "Q"
        try:
            meta = codec.encode_grid(payload, mcs=mcs, level=level, compress=False, security=opts)
        except ValueError:
            mcs, level = 2, "M"
            meta = codec.encode_grid(payload, mcs=mcs, level=level, compress=False, security=opts)
        img = C.place(np.asarray(render_grid(meta.grid, 8)), np.random.default_rng(C.seed_for("n5", idx)))
        c = f"PACC-{mcs}-{level}"
        items.append(_item(id=f"n5-{idx}", group="N5", condition=name, codec_name=c, label=name,
                           sublabel=f"Security · {c} · {len(payload)} B content", img=img, payload=payload,
                           grid_side=meta.n, expect=expect, extra={"secrets": wire, **extra},
                           verify=partial(_verify, secrets_=sec)))
    # Tampered: must be REJECTED (valid structure, signature does not match the content).
    idx = len(items) + 1
    payload = _fit(f"N5-{idx:02d}", 64)
    meta = codec.encode_grid(b"", mcs=1, level="Q", sealed=_tampered(payload, ed))
    img = C.place(np.asarray(render_grid(meta.grid, 8)), np.random.default_rng(C.seed_for("n5", idx)))
    items.append(_item(id=f"n5-{idx}", group="N5", condition="Tampered after signing", codec_name="PACC-1-Q",
                       label="Tampered (must be rejected)", sublabel="Security · Ed25519 · content changed after signing",
                       img=img, payload="REJECTED", grid_side=meta.n, expect="reject"))
    return items


# ── N6 multi-frame combining ──────────────────────────────────────────────────

def suite_n6(frames: int = 8) -> list[dict]:
    """The simulation's everyday multi-frame scene: hand-held video in dim light with a reflection that
    moves from frame to frame. PACC and QR-H get the same kind of video; PACC may combine frames."""
    from pacc_bench.benchmarks import MF_NOISE, MF_SCALE, _mf_frame
    items: list[dict] = []
    for sigma in MF_NOISE:
        for c in ("PACC-1-Q", "QR-H"):
            idx = len(items) + 1
            payload = _fit(f"N6-{idx:02d}", len(C.PAYLOAD))           # same length as the simulation payload
            base = C.place(C.symbol(c, payload), np.random.default_rng(C.seed_for("mf-place", idx)))
            base = cv2.resize(base, None, fx=MF_SCALE, fy=MF_SCALE, interpolation=cv2.INTER_AREA)
            rng = np.random.default_rng(C.seed_for("mf", sigma, idx))
            shots = [_mf_frame(base, rng, sigma) for _ in range(frames)]
            items.append(_item(id=f"n6-{idx}", group="N6", condition=f"Dim light σ{sigma}, moving reflection",
                               codec_name=c, severity=sigma, label=f"Dim light (noise σ{sigma}) · moving reflection",
                               sublabel=f"Multi-frame · {c} · {frames} frames of hand-held video; hold steady",
                               img=shots[0], payload=payload, grid_side=C.modules_of(c, payload), scale=1,
                               extra={"frames": [_png(x, 1) for x in shots], "fps": 3}))
    return items


# ── N7 layered and QR-compatible ──────────────────────────────────────────────

def suite_n7() -> list[dict]:
    items: list[dict] = []
    for k in range(2):
        coarse = f"https://ex.co/p/{41 + k}".encode()
        fine = f"N7 lot {7781 + k}-B; batch 2026-10-{'AB'[k]}; origin Pune; expiry 2027-04; serial 00{k}".encode()
        e = hier.encode(coarse, fine, level="H")
        img = np.pad(hier.render(e, sub_px=6), ((40, 40), (40, 40), (0, 0)), constant_values=255)
        for expect, want, hint in (("coarse", coarse, "Hold the phone far away (symbol small on screen)"),
                                   ("fine", fine, "Hold the phone close (symbol fills the view)")):
            idx = len(items) + 1
            items.append(_item(id=f"n7-{idx}", group="N7", condition=f"Layered {expect}", codec_name="PACC layered",
                               label=f"Layered · {'far: coarse layer' if expect == 'coarse' else 'near: fine layer'}",
                               sublabel=f"Layered symbol · {e.n}×{e.n} coarse cells · reads the {expect} layer",
                               img=img, payload=want, grid_side=e.n, expect=expect,
                               extra={"hint": hint}, scale=1))
    import qrcode
    for kind, value, name in (("clean", 0, "Clean"), ("white_balance", 0.4, "Warm light"),
                              ("gaussian_noise_sigma", 20, "Dim light"), ("glare_intensity", 200, "Glare")):
        k = len(items)
        url = f"https://bank.example.com/pay?to=ACME&amount=1{k:02d}.00"
        hidden = f"issuer=ACME Bank; ref N7-{k:02d}".encode()
        q = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_M, border=4, box_size=8)
        q.add_data(url)
        q.make(fit=True)
        plain = np.asarray(q.make_image().convert("RGB"))
        url_t = url.replace("pay?", "pay?qc=1&")
        enc = qc.encode(url_t, hidden)
        tinted = qc.render(enc, cell_size=8)
        def shown(a: np.ndarray, kind: str = kind, value: float = value, k: int = k) -> np.ndarray:
            rng = np.random.default_rng(C.seed_for("qc", kind, value, k))     # same damage for plain and QC
            return C.place(a, rng) if kind == "clean" else _distort(a, kind, value, rng)

        p_img, t_img = shown(plain), shown(tinted)
        items.append(_item(id=f"n7-{len(items) + 1}", group="N7", condition=f"QR plain · {name}", codec_name="QR-M",
                           label=f"Plain QR · {name}", sublabel="QR-compatible baseline: an ordinary QR code",
                           img=p_img, payload=url, grid_side=len(q.get_matrix()) - 8))
        items.append(_item(id=f"n7-{len(items) + 1}", group="N7", condition=f"QC visible · {name}", codec_name="PACC QC",
                           code_type="QR", label=f"QR-compatible, read as QR · {name}",
                           sublabel="Does the tint hurt ordinary QR readers?", img=t_img, payload=url_t, grid_side=enc.n))
        items.append(_item(id=f"n7-{len(items) + 1}", group="N7", condition=f"QC hidden · {name}", codec_name="PACC QC",
                           code_type="PACC_QC", label=f"QR-compatible, hidden part · {name}",
                           sublabel="PACC reads the hidden part and checks it belongs to this QR", img=t_img,
                           payload=hidden, grid_side=enc.n, expect="qc_hidden"))
    return items


# ── Animated stream ───────────────────────────────────────────────────────────

def suite_stream() -> list[dict]:
    items: list[dict] = []
    for size, n in ((512, 48), (1500, 64)):
        idx = len(items) + 1
        payload = _fit(f"STREAM-{idx}", size)
        p = nstream.plan(payload, n=n, mcs=1, level="M", compress=False, stream_id=C.seed_for("stream", idx))
        count = p.k + max(4, p.k // 2)                              # 50% repair frames
        frames = [_png(np.asarray(render_grid(f.grid, 8)), 1) for f in p.frames(count)]
        first = np.asarray(render_grid(p.frame(0).grid, 8))
        items.append(_item(id=f"st-{idx}", group="Stream", condition=f"{size} B", codec_name=f"PACC stream {n}×{n}",
                           label=f"Animated · {size} B in {p.k} blocks", severity=size,
                           sublabel=f"Animated · {count} looping frames · keep the phone steady until it completes",
                           img=first, payload=payload, grid_side=n, scale=1,
                           extra={"frames": frames, "fps": 6}, verify=lambda it, im: True))
    return items


# ── cache ─────────────────────────────────────────────────────────────────────
# Items are deterministic, but checking hard images on the desktop is slow (a failed thorough
# decode takes seconds). Built suites are cached until this file or the pacc package changes.

CACHE_DIR = os.path.join(_root, "pacc_web", "data", "suite_cache")


def _code_hash() -> str:
    h = hashlib.sha256()
    files = [os.path.abspath(__file__)] + sorted(
        os.path.join(_root, "pacc", f) for f in os.listdir(os.path.join(_root, "pacc")) if f.endswith(".py"))
    files += [os.path.join(_root, "tests", "pacc_bench", f) for f in ("common.py", "distortions.py", "benchmarks.py")]
    for f in files:
        with open(f, "rb") as fh:
            h.update(fh.read())
    return h.hexdigest()[:16]


def _cached(key: str, build: Callable[[], list[dict]]) -> list[dict]:
    path = os.path.join(CACHE_DIR, f"{key}-{_code_hash()}.json")
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        pass
    items = build()
    try:
        os.makedirs(CACHE_DIR, exist_ok=True)
        for old in os.listdir(CACHE_DIR):
            if old.startswith(key + "-"):
                os.remove(os.path.join(CACHE_DIR, old))
        with open(path, "w", encoding="utf-8") as f:
            json.dump(items, f)
    except OSError:
        pass
    return items


# ── dispatcher ────────────────────────────────────────────────────────────────

SUITES: dict[str, tuple[str, Callable[[], list[dict]]]] = {
    "n1_capacity": ("N1 · Capacity", suite_n1),
    "n2_robustness": ("N2 · Damage and lighting", suite_n2),
    "n5_security": ("N5 · Signatures and encryption", suite_n5),
    "n6_multiframe": ("N6 · Multi-frame combining", suite_n6),
    "n7_layers_qc": ("N7 · Layered and QR-compatible", suite_n7),
    "stream": ("Animated stream", suite_stream),
}


def generate(suite_type: str) -> list[dict] | None:
    """Items for a PACC suite, or None if `suite_type` is not one of these."""
    if suite_type == "paper_set":
        out: list[dict] = []
        for key in ("n1_capacity", "n2_robustness", "n5_security", "n6_multiframe", "n7_layers_qc", "stream"):
            out.extend(_cached(key, SUITES[key][1]))
    elif suite_type in SUITES:
        out = _cached(suite_type, SUITES[suite_type][1])
    else:
        return None
    out = [dict(it) for it in out]
    for i, it in enumerate(out, 1):
        it["id"] = f"{suite_type}-{i}"
        it["sublabel"] = f"{it['sublabel']} · Test {i}/{len(out)}"
    return out


if __name__ == "__main__":
    # python pacc_web/scripts/pacc_suites.py   -> build (and cache) every suite, report desktop checks
    for key in ["paper_set"]:
        t0 = time.perf_counter()
        items = generate(key) or []
        bad = [f"{it['group']} {it['condition']} {it['codec']}" for it in items if not it["serverDecodeSuccess"]]
        print(f"{key}: {len(items)} items in {time.perf_counter() - t0:.1f}s; desktop check failed on {len(bad)}")
        for b in bad:
            print("  ", b)
