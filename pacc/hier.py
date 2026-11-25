"""
pacc.hier — Distance-adaptive layered symbols ("PACC layered").

One printed symbol, two messages:

* **Coarse layer** — an ordinary black-and-white PACC symbol (MCS 0) whose message
  flags include FLAG_LAYERED. Its cells are large, so it decodes from far away or from a
  blurry, low-resolution capture.
* **Fine layer** — every coarse cell is split into S x S sub-cells (S = 2). Each sub-cell
  keeps its parent's luminance (dark stays dark, light stays light) but is tinted warm or
  cool, exactly like PACC QC (pacc.qc colours). The tint of each sub-cell inside a coarse
  *data* cell carries one bit of a rate-1/2 LDPC codeword with its own framing and
  security layer; sub-cells inside finders, separators, format and pilot cells follow
  the checkerboard (row + col) % 2 and are the fine layer's colour pilots.

A distant camera averages the sub-cells and sees only the coarse symbol. A close camera
decodes the coarse layer first, re-encodes it (so it knows every sub-cell's luminance
exactly) and then reads the fine layer's chroma bits at S times the resolution, through
the coarse layer's homography. The fine layer can therefore never be read without the
coarse one, and the coarse one is never disturbed by the fine one (luminance is
untouched; the chroma spread just looks like noise to the coarse equaliser).
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from pacc import codec, equalize, fmt, framing, layout, ldpc, modem, secure

# Sub-cell colours (index = 2 * dark + warm). Stronger tints than QR-compatible mode
# (pacc.qc), which trades chroma for QR-reader contrast; layered symbols need no QR reader.
QC_RGB = np.array([(150, 228, 255), (255, 226, 140), (0, 34, 150), (150, 0, 34)], dtype=np.uint8)
QC_PAL = QC_RGB / 255.0
from pacc.spec import FLAG_LAYERED, LEVEL_BY_NAME

SUB = 2                       # sub-cells per coarse cell side
PILOT_WEIGHT = 2.0
REFINE_ROUNDS = 1
REFINE_CONFIDENCE = 0.95


@dataclass(frozen=True)
class FineLayout:
    n: int                     # coarse grid size
    nf: int                    # fine grid size (n * SUB)
    dark: np.ndarray           # (nf, nf) bool luminance of each sub-cell (from the coarse grid)
    pilot: np.ndarray          # (nf, nf) bool sub-cells of non-data coarse cells
    data_cells: np.ndarray     # (D, 2) fine coordinates of data sub-cells, row-major


def fine_layout(coarse_grid: np.ndarray) -> FineLayout:
    """Fine-layer layout for a (canonically oriented) coarse PACC grid (uint8 RGB)."""
    n = coarse_grid.shape[0]
    lay = layout.build(n)
    is_data = np.zeros((n, n), bool)
    is_data[lay.data_cells[:, 0], lay.data_cells[:, 1]] = True
    dark = coarse_grid.astype(float).mean(axis=2) < 128
    up = np.ones((SUB, SUB), bool)
    dark_f = np.kron(dark, up).astype(bool)
    data_f = np.kron(is_data, up).astype(bool)
    return FineLayout(n, n * SUB, dark_f, ~data_f, np.argwhere(data_f))


def code_params(fl: FineLayout) -> tuple[int, int]:
    n_bits = len(fl.data_cells)
    return n_bits, (n_bits // 2) // 8 * 8


def fine_capacity(n: int) -> int:
    """Fine-layer plaintext bytes for a coarse grid of size n (before security)."""
    lay = layout.build(n)
    n_bits = len(lay.data_cells) * SUB * SUB
    return max(0, (n_bits // 2) // 8 - framing.MESSAGE_OVERHEAD)


def _pilot_warm(rr: np.ndarray, cc: np.ndarray) -> np.ndarray:
    return (rr + cc) % 2 == 1


# ── Encoding ──────────────────────────────────────────────────────────────────

@dataclass
class LayeredEncodeResult:
    grid: np.ndarray           # (nf, nf, 3) uint8: the printed sub-cell colours
    coarse: codec.EncodeResult
    n: int
    nf: int
    fine_bytes: int
    fine_capacity: int


def encode(coarse_data: bytes, fine_data: bytes, level: int | str = "H", compress: bool = True,
           coarse_security: secure.SealOptions | None = None,
           fine_security: secure.SealOptions | None = None,
           min_grid: int | None = None) -> LayeredEncodeResult:
    """Coarse message (far) + fine message (near) in one symbol. The coarse grid grows
    until the fine message fits."""
    if isinstance(level, str):
        level = LEVEL_BY_NAME[level.upper()]
    f_flags, f_body = secure.seal(fine_data, compress, fine_security)
    message = framing.build_message(f_body, f_flags)
    sealed = secure.seal(coarse_data, compress, coarse_security, extra_flags=FLAG_LAYERED)
    size = min_grid
    while True:
        coarse = codec.encode_grid(b"", mcs=0, level=level, min_grid=size, sealed=sealed)
        fl = fine_layout(coarse.grid)
        n_bits, k = code_params(fl)
        if k >= 8 * len(message):
            break
        if coarse.n >= 148:
            raise ValueError("fine message too large for any layered symbol")
        size = coarse.n + 4
    cw = ldpc.encode(ldpc.build(n_bits, k), framing.message_to_info_bits(message, k))
    tx = cw[framing.interleaver(n_bits)]
    warm = np.zeros((fl.nf, fl.nf), bool)
    pr, pc = np.nonzero(fl.pilot)
    warm[pr, pc] = _pilot_warm(pr, pc)
    warm[fl.data_cells[:, 0], fl.data_cells[:, 1]] = tx.astype(bool)
    grid = QC_RGB[2 * fl.dark.astype(int) + warm.astype(int)]
    return LayeredEncodeResult(grid, coarse, fl.n, fl.nf, len(fine_data), k // 8 - framing.MESSAGE_OVERHEAD)


def render(res: LayeredEncodeResult, sub_px: int = 5, quiet_cells: int = 4) -> np.ndarray:
    """Image with sub-cells of sub_px pixels and a white quiet zone of quiet_cells coarse cells."""
    q = quiet_cells * SUB
    g = np.pad(res.grid, ((q, q), (q, q), (0, 0)), constant_values=255)
    return np.repeat(np.repeat(g, sub_px, axis=0), sub_px, axis=1)


# ── Decoding the fine layer ───────────────────────────────────────────────────

@dataclass
class FineResult:
    ok: bool
    payload: bytes | None = None
    security: secure.OpenResult | None = None
    locked: str | None = None
    flags: int = 0
    body: bytes | None = None
    error: str | None = None
    diagnostics: dict = field(default_factory=dict)


def coarse_grid_from_result(res: codec.DecodeResult) -> np.ndarray:
    """Re-encode the decoded coarse symbol (canonical orientation)."""
    if res.body is None or res.n is None or res.mcs is None or res.level is None:
        raise ValueError("coarse result has no message body")
    e = codec.encode_grid(b"", mcs=res.mcs, level=res.level, min_grid=res.n, sealed=(res.flags, res.body))
    if e.n != res.n:
        raise ValueError("re-encoded coarse grid does not match")
    return e.grid


def _quad_h(quad: np.ndarray, nf: int) -> np.ndarray:
    import cv2
    src = np.array([[0, 0], [nf, 0], [nf, nf], [0, nf]], np.float32)
    return cv2.getPerspectiveTransform(src, quad.astype(np.float32))


def _sampled_points(mask: np.ndarray, transform: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Sampled-orientation centres of the canonical cells in mask, plus their (row, col)."""
    nf = mask.shape[0]
    idx = fmt.dihedral(np.arange(nf * nf).reshape(nf, nf), transform)    # canonical -> sampled index
    rr, cc = np.nonzero(mask)
    flat = idx[rr, cc]
    pts = np.stack([flat % nf + 0.5, flat // nf + 0.5], axis=-1).astype(np.float32)
    return pts, rr, cc


def _score(img: np.ndarray, quad: np.ndarray, nf: int, pts: np.ndarray, target: np.ndarray, chroma: bool) -> float:
    """Normalised agreement of sampled luminance (or warm-minus-cool chroma) with target signs."""
    import cv2
    mapped = cv2.perspectiveTransform(pts.reshape(-1, 1, 2), _quad_h(quad, nf)).reshape(1, -1, 2)
    px = cv2.remap(img, mapped[..., 0], mapped[..., 1], interpolation=cv2.INTER_LINEAR,
                   borderMode=cv2.BORDER_REPLICATE).reshape(-1, 3)
    v = px[:, 0] - px[:, 2] if chroma else px @ np.array([0.299, 0.587, 0.114], np.float32)
    v = v - v.mean()
    return float(np.mean(v * target) / (np.std(v) + 1e-6))


def _search(img, quad, nf, pts, target, chroma, step, levels):
    best = _score(img, quad, nf, pts, target, chroma)
    for _ in range(levels):
        for _sweep in range(4):                       # repeat each step size until nothing improves
            improved = False
            for i in range(4):
                base = quad[i].copy()
                for dy in (-1.0, 0.0, 1.0):
                    for dx in (-1.0, 0.0, 1.0):
                        if dx == 0.0 and dy == 0.0:
                            continue
                        trial = quad.copy()
                        trial[i] = base + step * np.array([dx, dy])
                        sc = _score(img, trial, nf, pts, target, chroma)
                        if sc > best + 1e-9:
                            best, quad, improved = sc, trial, True
            if not improved:
                break
        step /= 2
    return quad


def refine_fine(rgb: np.ndarray, H: np.ndarray, fl: FineLayout, transform: int) -> np.ndarray:
    """Fine registration. The coarse geometry is only accurate to a fraction of a coarse
    cell, too coarse for sub-cells. Stage 1 aligns the (now fully known) coarse luminance
    pattern at every sub-cell centre: random, so its optimum is unambiguous within about
    a coarse cell. Stage 2 polishes on the pilot sub-cells' warm/cool checkerboard."""
    n, nf = fl.n, fl.nf
    corners = np.array([[0, 0, 1], [n, 0, 1], [n, n, 1], [0, n, 1]], float) @ H.T
    quad = corners[:, :2] / corners[:, 2:]
    img = rgb.astype(np.float32)
    side = np.mean([np.linalg.norm(quad[i] - quad[(i + 1) % 4]) for i in range(4)])
    sub = side / nf
    # Stage 1: luminance of every other sub-cell (enough samples, half the cost).
    every = np.zeros((nf, nf), bool)
    every[::2, :] = True
    pts, rr, cc = _sampled_points(every, transform)
    quad = _search(img, quad, nf, pts, np.where(fl.dark[rr, cc], -1.0, 1.0), False, sub, 3)
    # Stage 2: pilot chroma checkerboard.
    pts, rr, cc = _sampled_points(fl.pilot, transform)
    quad = _search(img, quad, nf, pts, np.where(_pilot_warm(rr, cc), 1.0, -1.0), True, sub / 4, 2)
    return _quad_h(quad, nf)


def decode_fine(rgb: np.ndarray, H: np.ndarray, coarse: codec.DecodeResult,
                secrets: secure.Secrets | None = None) -> FineResult:
    """Read the fine layer given the coarse homography (coarse cell coords -> pixels, as
    sampled, i.e. before the coarse result's orientation transform)."""
    from pacc import detect
    out = FineResult(ok=False)
    try:
        cg = coarse_grid_from_result(coarse)
    except ValueError as e:
        out.error = str(e)
        return out
    fl = fine_layout(cg)
    nf = fl.nf
    Hf = refine_fine(rgb, H, fl, coarse.transform)
    g = fmt.dihedral(detect.sample_grid(rgb, Hf, nf, spread=0.2, taps=3), coarse.transform)

    ref = np.zeros((nf, nf, 3))
    w = np.zeros((nf, nf))
    pr, pc = np.nonzero(fl.pilot)
    ref[pr, pc] = QC_PAL[2 * fl.dark[pr, pc].astype(int) + _pilot_warm(pr, pc).astype(int)]
    w[pr, pc] = PILOT_WEIGHT

    n_bits, k = code_params(fl)
    code = ldpc.build(n_bits, k)
    perm = framing.interleaver(n_bits)
    dr, dc = fl.data_cells[:, 0], fl.data_cells[:, 1]
    d = fl.dark[dr, dc].astype(int)
    rows = np.arange(len(dr))
    converged = False
    for rnd in range(REFINE_ROUNDS + 1):
        eq = equalize.fit(g, ref, w)
        eg = eq.apply(g)
        centroids, cov = equalize.constellation(eg, ref, w, QC_PAL)
        ll = modem.symbol_loglik(eg[dr, dc], centroids, cov)
        # Luminance is known from the coarse layer: compare only that luminance's two tints.
        llr_tx = np.clip(ll[rows, 2 * d] - ll[rows, 2 * d + 1], -modem.LLR_CAP, modem.LLR_CAP)
        llr_cw = np.empty(n_bits)
        llr_cw[perm] = llr_tx
        bits, post, converged, _ = ldpc.decode(code, llr_cw)
        parsed = framing.parse_info_bits(bits[:k]) if converged else None
        if parsed is not None:
            out.flags, out.body = parsed
            opened = secure.open_message(parsed[0], parsed[1], secrets)
            out.security, out.locked = opened, opened.locked
            if opened.error and not opened.locked:
                out.error = opened.error
                return out
            out.ok, out.payload = True, opened.payload
            out.diagnostics = {"noise_sigma": float(np.sqrt(np.trace(cov) / 3))}
            return out
        if rnd == REFINE_ROUNDS:
            break
        p_warm = 1.0 / (1.0 + np.exp(np.clip(post[perm], -30, 30)))
        conf = np.maximum(p_warm, 1 - p_warm)
        sel = conf >= REFINE_CONFIDENCE
        ref[dr[sel], dc[sel]] = QC_PAL[2 * d[sel] + (p_warm[sel] > 0.5)]
        w[dr[sel], dc[sel]] = conf[sel]
    out.error = "fine layer not readable (move closer)" if not converged else "fine layer CRC mismatch"
    return out


def unlock_fine(fine: FineResult, secrets: secure.Secrets) -> FineResult:
    if fine.body is None:
        raise ValueError("fine result has no message body")
    opened = secure.open_message(fine.flags, fine.body, secrets)
    fine.security, fine.locked = opened, opened.locked
    fine.ok = not (opened.error and not opened.locked)
    fine.payload = opened.payload
    fine.error = opened.error
    return fine
