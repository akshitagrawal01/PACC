"""
Shared machinery for the PACC benchmark suite: codecs at equal printed footprint,
distortions, decoding, ablation switches, deterministic seeds and statistics.

Codec names
    PACC-<mcs>-<level>    PACC, palette MCS 0/1/2 (BW / KCMY / CUBE8), LDPC level L/M/Q/H
    PACC-HD               PACC 4 colours, rate 1/2, hard decisions (no soft LLRs)
    QR-<L|M|Q|H>          ISO/IEC 18004 via `qrcode` + zxing-cpp
    JAB-<colours>         JAB Code reference implementation (tools/jabcode), ECC level 7
"""
from __future__ import annotations

import contextlib
import io
import os
import sys
import zlib
from typing import Callable

import cv2
import numpy as np
from PIL import Image

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
for p in (ROOT, os.path.join(ROOT, "tests")):
    if p not in sys.path:
        sys.path.insert(0, p)

SYMBOL_PX = 360              # printed symbol width (excluding quiet zone) for every codec
QUIET_CELLS = 4
PAYLOAD = b"PACC Physical Damage Fault Tolerance Benchmark: ISO/IEC 18004 Cross-Evaluation."


def seed_for(*parts: object) -> int:
    """Stable across processes and runs (unlike Python's randomised str hash)."""
    return zlib.crc32("|".join(map(str, parts)).encode()) & 0x7FFFFFFF


# ── Symbols at equal footprint ────────────────────────────────────────────────

_CACHE: dict[tuple[str, bytes], np.ndarray] = {}


def _scale(img: np.ndarray, modules: int, quiet: int) -> np.ndarray:
    """Scale so the symbol (not the quiet zone) is SYMBOL_PX wide; keep `quiet` modules of margin."""
    cell = SYMBOL_PX / modules
    side = int(round((modules + 2 * quiet) * cell))
    return cv2.resize(img, (side, side), interpolation=cv2.INTER_NEAREST)


def symbol(codec: str, payload: bytes = PAYLOAD) -> np.ndarray:
    key = (codec, payload)
    if key in _CACHE:
        return _CACHE[key]
    if codec == "PACC-HD":
        return symbol("PACC-1-Q", payload)
    if codec.startswith("QR-"):
        from pacc_bench.baselines import StandardQRCodec
        img, _ = StandardQRCodec.encode(payload, ecc_level=codec[3:], box_size=10, border=4)
        a = np.asarray(img.convert("RGB"))
        arr = _scale(a, a.shape[0] // 10 - 8, 4)
    elif codec.startswith("JAB-"):
        from pacc_bench.baselines import JABCodeCodec
        img, info = JABCodeCodec.encode(payload, color_number=int(codec[4:]), module_size=10, ecc_level=7)
        a = np.asarray(img.convert("RGB"))
        a = np.pad(a, ((40, 40), (40, 40), (0, 0)), constant_values=255)          # JAB has no quiet zone
        arr = _scale(a, a.shape[0] // 10 - 8, 4)
    elif codec.startswith("PACC-"):
        import pacc
        _, mcs, level = codec.split("-")
        img, meta = pacc.encode(payload, level=level, mcs=int(mcs), cell_size=10, compress=False)
        arr = _scale(np.asarray(img), meta.n, QUIET_CELLS)
    else:
        raise ValueError(f"unknown codec {codec}")
    _CACHE[key] = arr
    return arr


def modules_of(codec: str, payload: bytes = PAYLOAD) -> int:
    """Symbol side in modules (excluding quiet zone)."""
    if codec == "PACC-HD":
        return modules_of("PACC-1-Q", payload)
    if codec.startswith("PACC-"):
        from pacc import codec as c
        _, mcs, level = codec.split("-")
        return c.encode_grid(payload, mcs=int(mcs), level=level, compress=False).n
    if codec.startswith("QR-"):
        from pacc_bench.baselines import StandardQRCodec
        img, _ = StandardQRCodec.encode(payload, ecc_level=codec[3:], box_size=1, border=0)
        return img.size[0]
    if codec.startswith("JAB-"):
        from pacc_bench.baselines import JABCodeCodec
        img, _ = JABCodeCodec.encode(payload, color_number=int(codec[4:]), module_size=1, ecc_level=7)
        return img.size[0]
    raise ValueError(f"unknown codec {codec}")


def available(codec: str) -> bool:
    if codec.startswith("JAB-"):
        from pacc_bench.baselines import JABCodeCodec
        return JABCodeCodec.is_available()
    return True


# ── Distortions ───────────────────────────────────────────────────────────────

# Everyday protocol (default): conditions a phone user meets when scanning a printed label or a
# screen, each family at a typical and a demanding level. With the symbol 360 px wide, the
# module is about 8-10 px at scale 1.
SWEEPS: dict[str, list[float]] = {
    "yaw_deg": [20, 40],                 # viewing angle
    "downscale": [0.5, 0.35],            # distance: about 4-5 and 3-3.5 px per module
    "gaussian_blur_px": [1, 2],          # slight defocus
    "motion_blur_px": [5, 9],            # hand shake
    "gaussian_noise_sigma": [10, 20],    # indoor and dim-room sensor noise
    "white_balance": [-0.4, 0.4],        # cool LED / warm tungsten light left after auto white balance
    "shadow_atten": [0.4, 0.6],          # soft shadow of a hand or a phone
    "glare_intensity": [110, 200],       # reflection on a glossy label or a screen
    "faded_print": [0.75, 0.55],         # print saturation: cheap printer, uncoated paper, sunlight
    "print_hue_deg": [10, 20],           # hue error of an uncalibrated printer
    "jpeg_quality": [80, 60],            # camera-app and messaging recompression
    "smudge_frac": [0.03, 0.06],         # coffee, dirt, ink or grease stains on the label
    "occlusion_area": [0.05, 0.1],       # a thumb or a price sticker
    "crease_px": [6, 12],                # a crease or scratch at a random angle and position
    "everyday": [1, 2, 3],               # tilt + warm light + soft shadow + defocus + noise + JPEG
}

# Stress protocol (run_pacc_benchmarks.py --protocol stress): breaking points far beyond everyday
# use. Kept for reproducibility.
STRESS_SWEEPS: dict[str, list[float]] = {
    "gaussian_noise_sigma": [15, 30, 45, 60],
    "gaussian_blur_px": [2, 4, 6],
    "random_erasure_frac": [0.1, 0.2, 0.3],
    "random_stain_frac": [0.05, 0.1, 0.15, 0.2],
    "occlusion_area": [0.05, 0.1, 0.15, 0.2],
    "scratch_px": [8, 16, 24, 36],
    "hue_rotation_deg": [30, 90, 180],
    "white_balance": [-0.8, 0.8],
    "shadow_atten": [0.6, 0.8, 0.9],
    "jpeg_quality": [40, 20, 10],
    "yaw_deg": [25, 45, 60],
    "downscale": [0.5, 0.35, 0.25, 0.18],
    "combined": [1, 2, 3, 4],          # stains + uneven shadow + colour cast + noise
}

# Far away in dim light: (scale of the symbol in the image, sensor noise). Small modules plus noise is
# where the colour estimate of every reader becomes uncertain.
FAR_DIM = {1: (0.3, 20), 2: (0.25, 25), 3: (0.22, 30), 4: (0.2, 35)}

# Everyday scenes: tilt (deg), warm light, soft shadow, defocus (px), sensor noise, JPEG quality.
EVERYDAY = {
    1: {"yaw": 15, "warm": 0.3, "shadow": 0.3, "blur": 0.0, "noise": 8, "jpeg": 85},     # lit room
    2: {"yaw": 30, "warm": 0.5, "shadow": 0.5, "blur": 1.0, "noise": 15, "jpeg": 70},    # warm, dim room
    3: {"yaw": 35, "warm": 0.6, "shadow": 0.6, "blur": 1.5, "noise": 22, "jpeg": 60},    # dim restaurant table
}


# Transparent stains darken the print beneath them (white turns brown, black stays black).
SMUDGE_COLOURS = np.array([(150, 105, 55), (110, 105, 95), (70, 85, 160), (170, 150, 95)], np.float32)  # coffee, dirt, ink, grease


def _smudge(a: np.ndarray, frac: float, rng: np.random.Generator) -> np.ndarray:
    """Two to four soft-edged elliptical stains covering about `frac` of the image area in total."""
    h, w = a.shape[:2]
    out = a.astype(np.float32)
    n = int(rng.integers(2, 5))
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    for _ in range(n):
        ratio = rng.uniform(0.5, 1.0)
        r1 = float(np.sqrt(frac * h * w / n / (np.pi * ratio)))
        r2 = r1 * ratio
        cx, cy, th = rng.uniform(0.15, 0.85) * w, rng.uniform(0.15, 0.85) * h, rng.uniform(0, np.pi)
        u = ((xx - cx) * np.cos(th) + (yy - cy) * np.sin(th)) / r1
        v = (-(xx - cx) * np.sin(th) + (yy - cy) * np.cos(th)) / r2
        m = cv2.GaussianBlur((u * u + v * v <= 1).astype(np.float32), (0, 0), max(1.0, 0.2 * r2))
        alpha = (rng.uniform(0.6, 0.9) * m)[..., None]
        out *= 1 - alpha + alpha * SMUDGE_COLOURS[rng.integers(len(SMUDGE_COLOURS))] / 255.0
    return np.clip(out, 0, 255).astype(np.uint8)


def _edge_shadow(a: np.ndarray, attenuation: float, rng: np.random.Generator) -> np.ndarray:
    """A hard shadow (e.g. of a wall or a hand in sunlight) whose edge crosses the symbol at a random angle."""
    h, w = a.shape[:2]
    th = rng.uniform(0, np.pi)
    cx, cy = rng.uniform(0.35, 0.65) * w, rng.uniform(0.35, 0.65) * h
    y, x = np.mgrid[:h, :w].astype(np.float32)
    m = 1.0 / (1.0 + np.exp(-((x - cx) * np.cos(th) + (y - cy) * np.sin(th)) / 4.0))      # penumbra of a few pixels
    return np.clip(a.astype(np.float32) * (1 - attenuation * m)[..., None], 0, 255).astype(np.uint8)


def _crease(a: np.ndarray, width: int, rng: np.random.Generator) -> np.ndarray:
    """A straight white line right across the label, at a random angle through a random point of its centre."""
    h, w = a.shape[:2]
    th = rng.uniform(0, np.pi)
    cx, cy = rng.uniform(0.3, 0.7) * w, rng.uniform(0.3, 0.7) * h
    d = 2 * max(h, w)
    p1 = (int(cx - d * np.cos(th)), int(cy - d * np.sin(th)))
    p2 = (int(cx + d * np.cos(th)), int(cy + d * np.sin(th)))
    out = a.copy()
    cv2.line(out, p1, p2, (255, 255, 255), thickness=int(width))
    return out


def _jpeg(a: np.ndarray, quality: int) -> np.ndarray:
    buf = io.BytesIO()
    Image.fromarray(a).save(buf, "JPEG", quality=quality)
    return np.asarray(Image.open(io.BytesIO(buf.getvalue())).convert("RGB"))


def _everyday(a: np.ndarray, level: int, rng: np.random.Generator) -> np.ndarray:
    """Light on the label (shadow, colour), then optics (tilt, defocus), sensor noise, compression."""
    from pacc_bench import distortions as D
    p = EVERYDAY[level]
    c = tuple(rng.uniform(0.3, 0.7, size=2))
    a = D.apply_underexposure_spot(a, attenuation=p["shadow"], radius=a.shape[0] * 0.4, center=c)
    a = D.apply_white_balance(a, temp_shift=p["warm"])
    a = D.apply_perspective_tilt(a, yaw_deg=p["yaw"], pitch_deg=0.0)
    if p["blur"]:
        a = cv2.GaussianBlur(a, (0, 0), p["blur"])
    a = D.apply_gaussian_noise(a, sigma=p["noise"], rng=rng)
    return _jpeg(a, int(p["jpeg"]))


def place(arr: np.ndarray, rng: np.random.Generator) -> np.ndarray:
    h, w = arr.shape[:2]
    t, b, l, r = (int(v) for v in rng.integers(30, 70, size=4))
    canvas = np.full((h + t + b, w + l + r, 3), 255, np.uint8)
    canvas[t:t + h, l:l + w] = arr
    return canvas


def distort(arr: np.ndarray, kind: str, value: float, rng: np.random.Generator) -> np.ndarray:
    """Damage to the printed symbol, then placement at a random offset, then capture effects."""
    from pacc_bench import distortions as D
    block = max(2, SYMBOL_PX // 40)
    a = arr.copy()
    if kind == "random_erasure_frac":
        a = D.apply_cell_erasures(a, fraction=value, cell_size=block, rng=rng, fill_mode="neutral")
    elif kind == "random_stain_frac":
        a = D.apply_cell_erasures(a, fraction=value, cell_size=block, rng=rng, fill_mode="chromatic")
    elif kind == "occlusion_area":
        off = tuple(rng.uniform(0.3, 0.7, size=2))
        a = D.apply_rectangular_occlusion(a, area_fraction=value, offset=off, rng=rng)
    elif kind == "scratch_px":
        a = D.apply_scratch(a, scratch_type="diagonal", width=int(value), rng=rng, fill_mode="neutral")
    elif kind == "combined":
        # Stacked real-world effects at severity s: stains on the print, then (after placement)
        # an uneven shadow, a colour cast and sensor noise.
        a = D.apply_cell_erasures(a, fraction=0.04 * value, cell_size=block, rng=rng, fill_mode="chromatic")
    elif kind == "smudge_frac":
        a = _smudge(a, value, rng)
    elif kind == "crease_px":
        a = _crease(a, int(value), rng)
    elif kind == "faded_print":
        a = D.apply_saturation_scale(a, factor=value)
    elif kind == "print_hue_deg":
        a = D.apply_hue_rotation(a, degrees=value)
    a = place(a, rng)
    if kind == "combined":
        c = tuple(rng.uniform(0.3, 0.7, size=2))
        a = D.apply_underexposure_spot(a, attenuation=min(0.95, 0.55 + 0.1 * value), radius=a.shape[0] * 0.4, center=c)
        a = D.apply_white_balance(a, temp_shift=min(1.0, 0.2 * value))
        a = D.apply_gaussian_noise(a, sigma=12.0 * value, rng=rng)
    elif kind == "everyday":
        a = _everyday(a, int(value), rng)
    elif kind == "motion_blur_px":
        a = D.apply_motion_blur(a, length=int(value), angle_deg=float(rng.uniform(0, 180)))
    elif kind == "edge_shadow":
        a = _edge_shadow(a, value, rng)
    elif kind == "far_dim":
        scale, sigma = FAR_DIM[int(value)]
        h, w = a.shape[:2]
        a = cv2.resize(a, (max(8, int(w * scale)), max(8, int(h * scale))), interpolation=cv2.INTER_AREA)
        a = D.apply_gaussian_noise(a, sigma=sigma, rng=rng)
    elif kind == "glare_intensity":
        c = tuple(rng.uniform(0.3, 0.7, size=2))
        a = D.apply_glare(a, intensity=value, radius=0.12 * a.shape[1], center=c)
    if kind == "gaussian_noise_sigma":
        a = D.apply_gaussian_noise(a, sigma=value, rng=rng)
    elif kind == "gaussian_blur_px":
        a = cv2.GaussianBlur(a, (0, 0), value)
    elif kind == "hue_rotation_deg":
        a = D.apply_hue_rotation(a, degrees=value)
    elif kind == "white_balance":
        a = D.apply_white_balance(a, temp_shift=value)
    elif kind == "shadow_atten":
        c = tuple(rng.uniform(0.3, 0.7, size=2))
        a = D.apply_underexposure_spot(a, attenuation=value, radius=a.shape[0] * 0.35, center=c)
    elif kind == "jpeg_quality":
        buf = io.BytesIO()
        Image.fromarray(a).save(buf, "JPEG", quality=int(value))
        a = np.asarray(Image.open(io.BytesIO(buf.getvalue())).convert("RGB"))
    elif kind == "yaw_deg":
        a = D.apply_perspective_tilt(a, yaw_deg=value, pitch_deg=0.0)
    elif kind == "downscale":
        h, w = a.shape[:2]
        a = cv2.resize(a, (max(8, int(w * value)), max(8, int(h * value))), interpolation=cv2.INTER_AREA)
    elif kind not in ("clean", "combined", "random_erasure_frac", "random_stain_frac", "occlusion_area", "scratch_px",
                      "smudge_frac", "crease_px", "faded_print", "print_hue_deg", "everyday", "motion_blur_px", "glare_intensity", "edge_shadow", "far_dim"):
        raise ValueError(f"unknown distortion {kind}")
    if kind not in ("gaussian_noise_sigma", "everyday", "far_dim"):   # these include their own sensor noise
        a = D.apply_gaussian_noise(a, sigma=3.0, rng=rng)       # mild sensor noise on every capture
    return a


# ── Decoding ──────────────────────────────────────────────────────────────────

def decode_ok(codec: str, img: np.ndarray, payload: bytes = PAYLOAD) -> bool:
    """PACC reports a failed decode as ok=False, so any exception it raises is a harness or
    environment fault (e.g. MemoryError) and propagates instead of counting as a failed trial."""
    if codec.startswith("PACC"):
        import pacc
        if codec == "PACC-HD":
            set_ablation("hard_decision")
        try:
            r = pacc.decode(img)
        finally:
            if codec == "PACC-HD":
                set_ablation("full")
        return bool(r.ok and r.payload == payload)
    try:
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            if codec.startswith("QR-"):
                from pacc_bench.baselines import StandardQRCodec
                ok, _, _ = StandardQRCodec.decode(img, expected_payload=payload)
                return bool(ok)
            if codec.startswith("JAB-"):
                from pacc_bench.baselines import JABCodeCodec
                ok, dec, _ = JABCodeCodec.decode(img, expected_payload=payload)
                return bool(ok and dec == payload)
    except Exception:
        return False
    raise ValueError(f"unknown codec {codec}")


# ── Ablations of the PACC decoder (applied inside worker processes) ────────

ABLATIONS = {
    "full": "complete decoder",
    "no_local_eq": "global colour transform only (no spatially varying gain/offset)",
    "no_constellation": "demap against nominal palette colours (no centroid re-estimation)",
    "no_refinement": "no decision-directed refinement rounds",
    "outlier_3pct": "previous design: 3% uniform outlier component (now a 1e-4 floor)",
    "hard_decision": "hard decisions with fixed reliability instead of soft LLRs",
}

_ORIGINAL: dict[str, object] = {}


def set_ablation(name: str) -> None:
    """Configure the in-process PACC decoder; 'full' restores everything."""
    from pacc import codec, equalize, modem
    if not _ORIGINAL:
        _ORIGINAL.update(prior_a=equalize.PRIOR_A, prior_b=equalize.PRIOR_B, constellation=equalize.constellation,
                         refine=codec.REFINE_ROUNDS, eps=modem.OUTLIER_EPS, bit_llrs=modem.bit_llrs)
    equalize.PRIOR_A, equalize.PRIOR_B = _ORIGINAL["prior_a"], _ORIGINAL["prior_b"]
    equalize.constellation = _ORIGINAL["constellation"]
    codec.REFINE_ROUNDS = _ORIGINAL["refine"]
    modem.OUTLIER_EPS = _ORIGINAL["eps"]
    modem.bit_llrs = _ORIGINAL["bit_llrs"]
    if name == "no_local_eq":
        equalize.PRIOR_A = equalize.PRIOR_B = 1e12
    elif name == "no_constellation":
        def nominal(eq_obs, ref, weight, palette):
            m = weight > 0
            resid = (ref - eq_obs)[m]
            w = weight[m]
            cov = (resid * w[:, None]).T @ resid / max(w.sum(), 1.0)
            return palette, equalize.COV_INFLATE * cov + equalize.COV_FLOOR * np.eye(3)
        equalize.constellation = nominal
    elif name == "no_refinement":
        codec.REFINE_ROUNDS = 0
    elif name == "outlier_3pct":
        modem.OUTLIER_EPS = 0.03
    elif name == "hard_decision":
        orig: Callable = _ORIGINAL["bit_llrs"]       # type: ignore[assignment]
        modem.bit_llrs = lambda loglik, bpc: np.sign(orig(loglik, bpc)) * 2.0
    elif name != "full":
        raise ValueError(f"unknown ablation {name}")


# ── Statistics ────────────────────────────────────────────────────────────────

def rate_ci(successes: int, trials: int) -> dict:
    from pacc_bench.stats import summarize_rate
    return summarize_rate(successes, trials)


def mcnemar(a: list[bool], b: list[bool]) -> dict:
    from pacc_bench.stats import mcnemar_test
    return mcnemar_test(a, b)
