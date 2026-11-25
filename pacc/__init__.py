"""
pacc — PACC reference implementation (research prototype).

Pilot-equalised coded colour modulation: LDPC-coded bits on a 2/4/8-colour
palette, pilot cells for local colour equalisation with decision-directed
refinement, a Golay-protected format word in all four corners, and a CRC-32.

    from pacc import encode, decode
    img, meta = encode(b"hello", level="Q", mcs=1)
    result = decode(img)
"""
from __future__ import annotations

from typing import Any

import numpy as np
from PIL import Image

from pacc import codec, detect
from pacc.codec import (
    DecodeResult,
    EncodeResult,
    capacity,
    decode_grid,
    encode_grid,
    unlock,
)
from pacc.combine import FrameCombiner
from pacc.render import render
from pacc.secure import RecipientKey, SealOptions, Secrets, SigningKey
from pacc.spec import FLAG_LAYERED, grid_sizes

__all__ = [
    "DecodeResult",
    "EncodeResult",
    "FrameCombiner",
    "RecipientKey",
    "SealOptions",
    "Secrets",
    "SigningKey",
    "capacity",
    "decode",
    "decode_grid",
    "encode",
    "encode_grid",
    "render",
    "unlock",
]


def encode(data: bytes, level: int | str = "Q", mcs: int = 1, cell_size: int = 10,
           compress: bool = True, min_grid: int | None = None,
           security: SealOptions | None = None) -> tuple[Image.Image, EncodeResult]:
    meta = encode_grid(data, mcs=mcs, level=level, compress=compress, min_grid=min_grid, security=security)
    return render(meta.grid, cell_size), meta


def _to_rgb(image: Any) -> np.ndarray:
    if isinstance(image, Image.Image):
        return np.asarray(image.convert("RGB"))
    arr = np.asarray(image)
    if arr.ndim == 2:
        arr = np.stack([arr] * 3, axis=-1)
    return arr[..., :3].astype(np.uint8)


# Format-word gate before a full decode. Measured: genuine (even heavily damaged)
# PACC symbols score >= 0.69 with margin >= 0.34; Prototype 22 and QR images score ~0.5
# with margin <= 0.07.
FORMAT_GATE = 0.6
FORMAT_MARGIN_GATE = 0.2
# Finder-free fallback only: with corners torn away a single surviving format copy
# cannot clear the joint gate, so there the CRC has the final say.
LOOSE_FORMAT_GATE = 0.4
SMALL_MODULE_PX = 3.0       # below this, also try a 2x upscaled image


def decode(image: Any, thorough: bool = True, secrets: Secrets | None = None,
           combiner: FrameCombiner | None = None) -> DecodeResult:
    """Locate and decode a PACC symbol in an RGB image (PIL image or HxWx3 uint8 array).

    thorough=False skips the finder-free outline search and the 2x upscale retry:
    much faster at rejecting images that are not PACC, at some cost in recovery
    from destroyed finders.
    secrets: password / recipient keys / trusted signers for secured symbols; without
    them an encrypted symbol decodes with ok=True, payload=None and `locked` set.
    combiner: pass the same FrameCombiner for consecutive video frames.
    """
    res = _decode(_to_rgb(image), thorough, secrets, combiner)
    if combiner is not None:
        combiner.end_frame(res.ok)
    return res


def _decode(rgb: np.ndarray, thorough: bool, secrets, combiner) -> DecodeResult:
    res, finders = _decode_rgb(rgb, thorough, secrets, combiner)
    if res.ok or not thorough:
        return res
    small = not finders or min(f.module for f in finders) < SMALL_MODULE_PX
    if small and max(rgb.shape[:2]) < 2000:
        up = np.asarray(Image.fromarray(rgb).resize((rgb.shape[1] * 2, rgb.shape[0] * 2), Image.Resampling.BICUBIC))
        res_up, _ = _decode_rgb(up, True, secrets, combiner)
        if res_up.ok:
            return res_up
    return res


def _try_geometry(rgb: np.ndarray, gray: np.ndarray, H: np.ndarray, n: int,
                  loose: bool = False, secrets=None, combiner=None) -> DecodeResult | None:
    """Refine the corners, gate on the format word, then fully decode. None = rejected."""
    H_ref, corr = detect.refine_corners(gray, H, n)
    best = None
    corners = detect.corner_block_mask(n)
    for h in ((H_ref, H) if corr > 0.3 else (H,)):
        # Cheap screen: sample only the corner blocks and read the format word.
        fr = codec.read_format(detect.sample_cells(rgb, h, n, corners))
        if (fr.score < LOOSE_FORMAT_GATE) if loose else (fr.score < FORMAT_GATE or fr.margin < FORMAT_MARGIN_GATE):
            continue
        grid = detect.sample_grid(rgb, h, n)
        res = codec.decode_grid(grid, secrets, combiner)
        if res.ok:
            if res.flags & FLAG_LAYERED:
                # Distance-adaptive symbol: also try the fine chroma layer through this geometry.
                from pacc import hier
                res.fine = hier.decode_fine(rgb, h, res, secrets)
            return res
        best = best or res
    return best


def _decode_rgb(rgb: np.ndarray, outline: bool = True, secrets=None, combiner=None) -> tuple[DecodeResult, list]:
    import cv2
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    finders = detect.find_finders(rgb)
    last = DecodeResult(ok=False, error=f"no plausible symbol geometry ({len(finders)} finder candidates)")
    tried: set[tuple[int, int]] = set()

    def attempt(key: int, h_for, queue: list[int], loose: bool = False) -> DecodeResult | None:
        nonlocal last
        while queue:
            n = queue.pop(0)
            if (key, n) in tried:
                continue
            tried.add((key, n))
            res = _try_geometry(rgb, gray, h_for(n), n, loose, secrets, combiner)
            if res is None:
                continue
            if res.ok:
                return res
            if res.grid_mismatch and (key, res.grid_mismatch) not in tried and res.format_margin > 0.15:
                queue.insert(0, res.grid_mismatch)
            last = res
        return None

    # 1. Finder-based geometry.
    if len(finders) >= 2:
        for qi, (pts, module) in enumerate(detect.candidate_quads(finders, two_finder=outline)):
            hit = attempt(qi, lambda n, p=pts: detect.homography(p, n), detect.estimate_n(pts, module))
            if hit:
                return hit, finders
    # 2. Finder-free fallback: the symbol's outline; the format word selects N.
    for oi, pts in enumerate(detect.outline_quads(rgb) if outline else []):
        hit = attempt(1000 + oi, lambda n, p=pts: detect.outline_homography(p, n), list(grid_sizes()), loose=True)
        if hit:
            return hit, finders
    return last, finders

