"""
pacc.qc — QR-compatible PACC ("PACC QC").

A standard QR Code whose modules are tinted: the luminance of every module is
exactly what the QR encoder chose (dark modules stay dark, light stay light), so any
phone camera app reads the QR as usual. The chroma of every module — warm or cool —
carries a second, hidden channel that only PACC decoders read:

* QR function patterns (finders, separators, timing, alignment, dark module) are
  chroma pilots: their luminance is fixed by the QR standard and their chroma follows
  the checkerboard (row + col) % 2, so the decoder learns all four captured colours
  (dark/light x warm/cool) locally across the symbol with the PACC equaliser.
* Every other module (data, ECC, format and version information) carries one
  chroma bit of an LDPC codeword (rate 1/2), with the same framing, scrambling, CRC
  and interleaving as PACC symbols. The decoder never needs the QR's luminance
  bits: they are marginalised out of the chroma LLRs.

The hidden message can be signed and/or encrypted (pacc.secure). Its plaintext
starts with a binding byte: 1 = the next 16 bytes are SHA-256 of the visible QR text,
so a signature authenticates the URL every ordinary phone opens — an anti-phishing
QR code that stays backward compatible.

QR detection (finders, version, corners) is delegated to a standard QR reader
(zxing-cpp here, zxing-wasm in the browser); this module needs only the symbol's
four outer corners and its version.
"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from typing import Any

import cv2
import numpy as np

from pacc import detect, equalize, framing, ldpc, modem, secure

RATE_NUM, RATE_DEN = 1, 2
PILOT_WEIGHT = 2.0
REFINE_ROUNDS = 1
REFINE_CONFIDENCE = 0.95
BIND_NONE, BIND_SHA256 = 0, 1
BIND_LEN = 16

# Palette index = 2 * dark + warm. Luma (Rec. 601): light >= 0.91, dark <= 0.12, so QR
# readers binarise exactly as for black-and-white; chroma is the hidden bit. The tints are
# deliberately mild: stronger ones (as in pacc.hier) cut QR contrast to ~0.62 and standard
# readers then failed under noise (sigma 30: 45% reads vs 100% now).
QC_RGB = np.array([
    (205, 242, 255),    # light, cool
    (255, 243, 200),    # light, warm
    (0, 15, 95),        # dark, cool
    (95, 0, 15),        # dark, warm
], dtype=np.uint8)
QC_PAL = QC_RGB / 255.0

# ISO/IEC 18004 alignment pattern centre coordinates per version.
ALIGNMENT = [
    [], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46],
    [6, 28, 50], [6, 30, 54], [6, 32, 58], [6, 34, 62], [6, 26, 46, 66], [6, 26, 48, 70],
    [6, 26, 50, 74], [6, 30, 54, 78], [6, 30, 56, 82], [6, 30, 58, 86], [6, 34, 62, 90],
    [6, 28, 50, 72, 94], [6, 26, 50, 74, 98], [6, 30, 54, 78, 102], [6, 28, 54, 80, 106],
    [6, 32, 58, 84, 110], [6, 30, 58, 86, 114], [6, 34, 62, 90, 118], [6, 26, 50, 74, 98, 122],
    [6, 30, 54, 78, 102, 126], [6, 26, 52, 78, 104, 130], [6, 30, 56, 82, 108, 134],
    [6, 34, 60, 86, 112, 138], [6, 30, 58, 86, 114, 142], [6, 34, 62, 90, 118, 146],
    [6, 30, 54, 78, 102, 126, 150], [6, 24, 50, 76, 102, 128, 154], [6, 28, 54, 80, 106, 132, 158],
    [6, 32, 58, 84, 110, 136, 162], [6, 26, 54, 82, 110, 138, 166], [6, 30, 58, 86, 114, 142, 170],
]


@dataclass(frozen=True)
class QcLayout:
    n: int
    pilot: np.ndarray          # (n, n) bool: function-pattern modules with known luminance
    pilot_dark: np.ndarray     # (n, n) bool: their luminance
    data_cells: np.ndarray     # (D, 2) row-major modules carrying hidden bits


_LAYOUTS: dict[int, QcLayout] = {}


def layout(version: int) -> QcLayout:
    if version in _LAYOUTS:
        return _LAYOUTS[version]
    if not 1 <= version <= 40:
        raise ValueError(f"invalid QR version {version}")
    n = 17 + 4 * version
    pilot = np.zeros((n, n), bool)
    dark = np.zeros((n, n), bool)
    finder = np.zeros((8, 8), bool)
    finder[:7, :7] = True
    finder[1:6, 1:6] = False
    finder[2:5, 2:5] = True
    for r0, c0, fr, fc in [(0, 0, slice(0, 8), slice(0, 8)), (0, n - 8, slice(0, 8), slice(None, None, -1)),
                           (n - 8, 0, slice(None, None, -1), slice(0, 8))]:
        pilot[r0:r0 + 8, c0:c0 + 8] = True
        dark[r0:r0 + 8, c0:c0 + 8] = finder[fr, fc]
    for i in range(8, n - 8):
        pilot[6, i] = pilot[i, 6] = True
        dark[6, i] = dark[i, 6] = i % 2 == 0
    centres = ALIGNMENT[version]
    for r in centres:
        for c in centres:
            if (r, c) in [(6, 6), (6, centres[-1]), (centres[-1], 6)]:
                continue
            pilot[r - 2:r + 3, c - 2:c + 3] = True
            block = np.ones((5, 5), bool)
            block[1:4, 1:4] = False
            block[2, 2] = True
            dark[r - 2:r + 3, c - 2:c + 3] = block
    pilot[n - 8, 8] = dark[n - 8, 8] = True          # the always-dark module
    data = np.argwhere(~pilot)
    out = QcLayout(n, pilot, dark, data)
    _LAYOUTS[version] = out
    return out


def pilot_warm(r: np.ndarray, c: np.ndarray) -> np.ndarray:
    return (r + c) % 2 == 1


def code_params(version: int) -> tuple[int, int]:
    n_bits = len(layout(version).data_cells)
    k = (n_bits * RATE_NUM // RATE_DEN) // 8 * 8
    return n_bits, k


def capacity(version: int) -> int:
    """Hidden plaintext bytes available (before the binding header and any security)."""
    return max(0, code_params(version)[1] // 8 - framing.MESSAGE_OVERHEAD - 1)


def _binding(visible: str | bytes) -> bytes:
    v = visible.encode("utf-8") if isinstance(visible, str) else visible
    return hashlib.sha256(v).digest()[:BIND_LEN]


# ── Encoding ──────────────────────────────────────────────────────────────────

@dataclass
class QcEncodeResult:
    grid: np.ndarray            # (n, n, 3) uint8 tinted QR modules (no quiet zone)
    version: int
    n: int
    hidden_bytes: int
    message_bytes: int


def qr_matrix(text: str, ec: str = "M", min_version: int = 1) -> tuple[np.ndarray, int]:
    """Standard QR module matrix (True = dark) via the `qrcode` package."""
    import qrcode
    from qrcode import constants
    levels = {"L": constants.ERROR_CORRECT_L, "M": constants.ERROR_CORRECT_M,
              "Q": constants.ERROR_CORRECT_Q, "H": constants.ERROR_CORRECT_H}
    q = qrcode.QRCode(version=None, error_correction=levels[ec], border=0)
    q.add_data(text)
    q.make(fit=True)
    if q.version < min_version:
        q = qrcode.QRCode(version=min_version, error_correction=levels[ec], border=0)
        q.add_data(text)
        q.make(fit=False)
    return np.asarray(q.get_matrix(), dtype=bool), int(q.version)


def encode(visible: str, hidden: bytes = b"", ec: str = "M", bind: bool = True,
           security: secure.SealOptions | None = None, compress: bool = True,
           min_version: int = 1) -> QcEncodeResult:
    """Tint a standard QR for `visible` so its chroma carries `hidden` (grows the QR
    version if the hidden message needs more modules)."""
    plaintext = (bytes([BIND_SHA256]) + _binding(visible) if bind else bytes([BIND_NONE])) + hidden
    flags, body = secure.seal(plaintext, compress, security)
    message = framing.build_message(body, flags)
    version = min_version
    while True:
        matrix, version = qr_matrix(visible, ec, version)
        if code_params(version)[1] >= 8 * len(message):
            break
        if version >= 40:
            raise ValueError("hidden message too large for any QR version")
        version += 1
    lay = layout(version)
    n = lay.n
    n_bits, k = code_params(version)
    cw = ldpc.encode(ldpc.build(n_bits, k), framing.message_to_info_bits(message, k))
    tx = cw[framing.interleaver(n_bits)]
    warm = np.zeros((n, n), bool)
    rr, cc = np.nonzero(lay.pilot)
    warm[rr, cc] = pilot_warm(rr, cc)
    warm[lay.data_cells[:, 0], lay.data_cells[:, 1]] = tx.astype(bool)
    grid = QC_RGB[2 * matrix.astype(int) + warm.astype(int)]
    return QcEncodeResult(grid, version, n, len(hidden), len(message))


def render(res: QcEncodeResult, cell_size: int = 8, quiet: int = 4) -> np.ndarray:
    g = np.pad(res.grid, ((quiet, quiet), (quiet, quiet), (0, 0)), constant_values=255)
    return np.repeat(np.repeat(g, cell_size, axis=0), cell_size, axis=1)


# ── Decoding ──────────────────────────────────────────────────────────────────

@dataclass
class QcDecodeResult:
    ok: bool
    visible: str | None = None
    hidden: bytes | None = None
    bound: bool | None = None            # binding header present and matches the visible text
    version: int | None = None
    security: secure.OpenResult | None = None
    locked: str | None = None
    error: str | None = None
    flags: int = 0
    body: bytes | None = None
    diagnostics: dict = field(default_factory=dict)


def _grid_h(corners: np.ndarray, n: int) -> np.ndarray:
    src = np.array([[0, 0], [n, 0], [n, n], [0, n]], np.float32)
    return cv2.getPerspectiveTransform(src, np.asarray(corners, np.float32))


def _luma(x: np.ndarray) -> np.ndarray:
    return x[..., 0] * 0.299 + x[..., 1] * 0.587 + x[..., 2] * 0.114


def _pilot_score(rgb: np.ndarray, corners: np.ndarray, lay: QcLayout) -> float:
    obs = detect.sample_cells(rgb, _grid_h(corners, lay.n), lay.n, lay.pilot, spread=0.15, taps=2)
    y = _luma(obs[lay.pilot])
    d = lay.pilot_dark[lay.pilot]
    return float(np.mean(y[~d]) - np.mean(y[d])) / (float(np.std(y)) + 1e-6)


def refine(rgb: np.ndarray, corners: np.ndarray, lay: QcLayout, rounds: int = 2) -> np.ndarray:
    """Nudge each corner by up to half a module so the function patterns line up."""
    corners = np.asarray(corners, np.float64).copy()
    side = np.mean([np.linalg.norm(corners[i] - corners[(i + 1) % 4]) for i in range(4)])
    step = side / lay.n
    best = _pilot_score(rgb, corners, lay)
    for _ in range(rounds):
        for i in range(4):
            base = corners[i].copy()
            for dy in (-0.5, -0.25, 0.0, 0.25, 0.5):
                for dx in (-0.5, -0.25, 0.0, 0.25, 0.5):
                    trial = corners.copy()
                    trial[i] = base + step * np.array([dx, dy])
                    s = _pilot_score(rgb, trial, lay)
                    if s > best + 1e-9:
                        best, corners = s, trial
        step /= 2
    return corners


def decode_at(rgb: np.ndarray, corners: Any, version: int, visible: str | None = None,
              secrets: secure.Secrets | None = None) -> QcDecodeResult:
    """Read the hidden chroma channel of a QR whose outer corners (TL, TR, BR, BL in
    the QR's own orientation) and version are known."""
    res = QcDecodeResult(ok=False, visible=visible, version=version)
    lay = layout(version)
    n = lay.n
    corners = refine(rgb, np.asarray(corners, np.float64), lay)
    g = detect.sample_grid(rgb, _grid_h(corners, n), n)

    ref = np.zeros((n, n, 3))
    w = np.zeros((n, n))
    rr, cc = np.nonzero(lay.pilot)
    idx = 2 * lay.pilot_dark[rr, cc].astype(int) + pilot_warm(rr, cc).astype(int)
    ref[rr, cc] = QC_PAL[idx]
    w[rr, cc] = PILOT_WEIGHT

    n_bits, k = code_params(version)
    code = ldpc.build(n_bits, k)
    perm = framing.interleaver(n_bits)
    dr, dc = lay.data_cells[:, 0], lay.data_cells[:, 1]
    converged = False
    for rnd in range(REFINE_ROUNDS + 1):
        eq = equalize.fit(g, ref, w)
        eg = eq.apply(g)
        centroids, cov = equalize.constellation(eg, ref, w, QC_PAL)
        loglik = modem.symbol_loglik(eg[dr, dc], centroids, cov)
        llr_tx = modem.bit_llrs(loglik, 2)[:, 1]            # chroma bit; luminance marginalised
        llr_cw = np.empty(n_bits)
        llr_cw[perm] = llr_tx
        bits, post, converged, _ = ldpc.decode(code, llr_cw)
        parsed = framing.parse_info_bits(bits[:k]) if converged else None
        if parsed is not None:
            return _finish(res, parsed[0], parsed[1], secrets)
        if rnd == REFINE_ROUNDS:
            break
        # Decision-directed refinement: confident cells (both bits) become references.
        warm_llr = post[perm]
        p_warm = 1.0 / (1.0 + np.exp(np.clip(warm_llr, -30, 30)))
        lik = np.exp(loglik - loglik.max(axis=1, keepdims=True))
        dark_post = (lik[:, 2:] * np.stack([1 - p_warm, p_warm], 1)).sum(1)
        light_post = (lik[:, :2] * np.stack([1 - p_warm, p_warm], 1)).sum(1)
        p_dark = dark_post / (dark_post + light_post)
        best = 2 * (p_dark > 0.5) + (p_warm > 0.5)
        conf = np.maximum(p_dark, 1 - p_dark) * np.maximum(p_warm, 1 - p_warm)
        sel = conf >= REFINE_CONFIDENCE
        ref[dr[sel], dc[sel]] = QC_PAL[best[sel]]
        w[dr[sel], dc[sel]] = conf[sel]
    res.error = "no hidden PACC channel (LDPC did not converge)" if not converged else "CRC mismatch"
    return res


def _finish(res: QcDecodeResult, flags: int, body: bytes, secrets: secure.Secrets | None) -> QcDecodeResult:
    res.flags, res.body = flags, body
    opened = secure.open_message(flags, body, secrets)
    res.security, res.locked = opened, opened.locked
    if opened.error and not opened.locked:
        res.error = opened.error
        return res
    res.ok = True
    if opened.payload is None:
        return res
    p = opened.payload
    if p[:1] == bytes([BIND_SHA256]) and len(p) >= 1 + BIND_LEN:
        res.bound = res.visible is not None and _binding(res.visible) == p[1:1 + BIND_LEN]
        res.hidden = p[1 + BIND_LEN:]
    elif p[:1] == bytes([BIND_NONE]):
        res.hidden = p[1:]
    else:
        res.ok, res.error = False, "unknown binding header"
    return res


def unlock(res: QcDecodeResult, secrets: secure.Secrets) -> QcDecodeResult:
    if res.body is None:
        raise ValueError("result has no message body")
    return _finish(res, res.flags, res.body, secrets)


def decode(image: Any, secrets: secure.Secrets | None = None) -> QcDecodeResult:
    """Find a QR with zxing-cpp and read its hidden channel, if any."""
    import zxingcpp
    from PIL import Image
    rgb = np.asarray(image.convert("RGB")) if isinstance(image, Image.Image) else np.asarray(image)[..., :3]
    found = [b for b in zxingcpp.read_barcodes(rgb) if b.format == zxingcpp.BarcodeFormat.QRCode]
    if not found:
        return QcDecodeResult(ok=False, error="no QR code found")
    b = found[0]
    extra: Any = b.extra
    try:
        version = int(extra["Version"])
    except (TypeError, ValueError, KeyError):
        return QcDecodeResult(ok=False, visible=b.text, error="QR version unavailable")
    p = b.position
    corners = [(p.top_left.x, p.top_left.y), (p.top_right.x, p.top_right.y),
               (p.bottom_right.x, p.bottom_right.y), (p.bottom_left.x, p.bottom_left.y)]
    return decode_at(rgb, corners, version, visible=b.text, secrets=secrets)

