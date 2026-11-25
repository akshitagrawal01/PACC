"""
pacc.codec — Grid-level PACC encoder and decoder.

encode_grid() produces the N x N colour grid for a payload; decode_grid() takes a
sampled N x N grid of captured colours (floats in [0, 1]) and returns the payload.
Image rendering and symbol localisation live in pacc.render / pacc.detect.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

import numpy as np

from pacc import equalize, fmt, framing, layout, ldpc, modem, secure
from pacc.spec import (
    FLAG_DEFLATE,
    LEVEL_BY_NAME,
    LEVELS,
    PALETTES,
    bits_per_cell,
    grid_index,
    grid_sizes,
    palette_array,
)

if TYPE_CHECKING:
    from pacc.combine import FrameCombiner

PILOT_WEIGHT = 2.0
REFINE_ROUNDS = 2
REFINE_CONFIDENCE = 0.95


def code_params(n: int, mcs: int, level: int) -> tuple[int, int]:
    """(codeword bits, information bits) for grid size n."""
    lay = layout.build(n)
    n_bits = len(lay.data_cells) * bits_per_cell(mcs)
    _, num, den = LEVELS[level]
    k = (n_bits * num // den) // 8 * 8
    return n_bits, k


def capacity(n: int, mcs: int, level: int) -> int:
    """Largest raw payload (bytes) a grid of size n can carry."""
    from pacc.spec import MESSAGE_OVERHEAD
    return max(0, code_params(n, mcs, level)[1] // 8 - MESSAGE_OVERHEAD)


@dataclass
class EncodeResult:
    grid: np.ndarray                 # (n, n, 3) uint8
    n: int
    mcs: int
    level: int
    payload_bytes: int
    compressed: bool
    code_n: int
    code_k: int


def encode_grid(data: bytes, mcs: int = 1, level: int | str = "Q",
                compress: bool = True, min_grid: int | None = None,
                security: secure.SealOptions | None = None, extra_flags: int = 0,
                sealed: tuple[int, bytes] | None = None) -> EncodeResult:
    """security: optional signing / encryption (pacc.secure.SealOptions).
    sealed: a pre-built (flags, body) message, bypassing compression and security."""
    if isinstance(level, str):
        level = LEVEL_BY_NAME[level.upper()]
    if mcs not in PALETTES:
        raise ValueError(f"unsupported MCS {mcs}")
    flags, payload = sealed if sealed is not None else secure.seal(data, compress, security, extra_flags)
    message = framing.build_message(payload, flags)

    n = None
    for size in grid_sizes():
        if min_grid and size < min_grid:
            continue
        if code_params(size, mcs, level)[1] >= 8 * len(message):
            n = size
            break
    if n is None:
        raise ValueError(
            f"payload of {len(payload)} bytes exceeds the largest PACC symbol "
            f"({capacity(grid_sizes()[-1], mcs, level)} bytes at this MCS/level)"
        )

    lay = layout.build(n)
    n_bits, k = code_params(n, mcs, level)
    info = framing.message_to_info_bits(message, k)
    code = ldpc.build(n_bits, k)
    cw = ldpc.encode(code, info)
    tx = cw[framing.interleaver(n_bits)]
    bpc = bits_per_cell(mcs)
    symbols = modem.bits_to_symbols(tx, bpc)

    pal = np.asarray(PALETTES[mcs]["rgb"], dtype=np.uint8)
    grid = np.full((n, n, 3), 255, dtype=np.uint8)
    grid[lay.known_dark] = 0
    info_fmt = fmt.FormatInfo(grid_index(n), mcs, level)
    for corner in range(4):
        for (r, c), bit in zip(lay.format_cells[corner], fmt.corner_bits(corner, info_fmt)):
            grid[r, c] = 0 if bit else 255
    for r, c in lay.pilot_cells:
        grid[r, c] = pal[layout.pilot_index(int(r), int(c), len(pal))]
    grid[lay.data_cells[:, 0], lay.data_cells[:, 1]] = pal[symbols]
    return EncodeResult(grid, n, mcs, level, len(data), bool(flags & FLAG_DEFLATE), n_bits, k)


# ── Decoding ──────────────────────────────────────────────────────────────────

@dataclass
class DecodeResult:
    ok: bool
    payload: bytes | None = None
    n: int | None = None
    mcs: int | None = None
    level: int | None = None
    format_score: float = 0.0
    format_margin: float = 0.0
    transform: int = 0
    refine_rounds: int = 0
    ldpc_iterations: int = 0
    error: str | None = None
    grid_mismatch: int | None = None          # format says a different N
    flags: int = 0
    body: bytes | None = None                 # framed message body (for unlock() later)
    locked: str | None = None                 # "password" / "recipient": secret needed
    security: secure.OpenResult | None = None
    channel_llrs: np.ndarray | None = None    # codeword-order LLRs (multi-frame combining)
    frames_combined: int = 0                  # frames whose soft information produced this decode
    fine: Any = None                          # pacc.hier.FineResult for layered symbols
    diagnostics: dict = field(default_factory=dict)


def _luma(rgb: np.ndarray) -> np.ndarray:
    return rgb[..., 0] * 0.299 + rgb[..., 1] * 0.587 + rgb[..., 2] * 0.114


def read_format(obs: np.ndarray) -> fmt.FormatResult:
    lay = layout.build(obs.shape[0])
    y = _luma(obs)
    dark = float(np.median(y[lay.known_dark]))
    light = float(np.median(y[lay.known_light]))
    half = max((light - dark) / 2.0, 1e-3)
    soft = np.clip((y - (light + dark) / 2.0) / half, -1.0, 1.0)
    return fmt.decode(soft)


def finish(res: DecodeResult, flags: int, body: bytes, secrets: secure.Secrets | None) -> DecodeResult:
    """Apply the security/compression layers to a CRC-verified message body."""
    res.flags, res.body = flags, body
    opened = secure.open_message(flags, body, secrets)
    res.security = opened
    res.locked = opened.locked
    if opened.error and not opened.locked:
        res.ok, res.error = False, opened.error
        return res
    res.ok, res.payload = True, opened.payload
    if opened.error:
        res.error = opened.error
    return res


def unlock(res: DecodeResult, secrets: secure.Secrets) -> DecodeResult:
    """Re-open a locked result with a password / recipient key, without re-decoding."""
    if res.body is None:
        raise ValueError("result has no message body")
    return finish(res, res.flags, res.body, secrets)


def decode_grid(obs: np.ndarray, secrets: secure.Secrets | None = None,
                combiner: FrameCombiner | None = None) -> DecodeResult:
    """obs: (n, n, 3) captured colours in [0, 1], cells in grid order (any rotation/mirror).

    combiner: multi-frame soft combining state (pacc.combine.FrameCombiner): LLRs of
    earlier failed frames of the same symbol are added to this frame's LLRs.
    """
    n = obs.shape[0]
    fr = read_format(obs)
    res = DecodeResult(ok=False, format_score=fr.score, format_margin=fr.margin, transform=fr.transform)
    expected_n = 24 + 4 * fr.info.grid_index
    if expected_n != n:
        res.grid_mismatch = expected_n
        res.error = f"format word indicates N={expected_n}, sampled N={n}"
        return res
    if fr.info.mcs not in PALETTES or fr.info.level not in LEVELS:
        res.error = "format word names an unsupported MCS/level"
        return res
    mcs, level = fr.info.mcs, fr.info.level
    res.n, res.mcs, res.level = n, mcs, level

    g = fmt.dihedral(obs, fr.transform)
    lay = layout.build(n)
    pal = palette_array(mcs)
    bpc = bits_per_cell(mcs)

    ref = np.zeros((n, n, 3))
    w = np.zeros((n, n))
    ref[lay.known_light] = 1.0
    w[lay.known_light | lay.known_dark] = 1.0
    info_fmt = fmt.FormatInfo(fr.info.grid_index, mcs, level)
    for corner in range(4):
        for (r, c), bit in zip(lay.format_cells[corner], fmt.corner_bits(corner, info_fmt)):
            ref[r, c] = 0.0 if bit else 1.0
            w[r, c] = 1.0
    for r, c in lay.pilot_cells:
        ref[r, c] = pal[layout.pilot_index(int(r), int(c), len(pal))]
        w[r, c] = PILOT_WEIGHT

    n_bits, k = code_params(n, mcs, level)
    code = ldpc.build(n_bits, k)
    perm = framing.interleaver(n_bits)
    dr, dc = lay.data_cells[:, 0], lay.data_cells[:, 1]

    def run(prior_llrs: np.ndarray | None, ref: np.ndarray, w: np.ndarray):
        """Equalise, demap and decode with decision-directed refinement.
        Returns (parsed message or None, noise covariance, converged)."""
        for rnd in range(REFINE_ROUNDS + 1):
            eq = equalize.fit(g, ref, w)
            eg = eq.apply(g)
            centroids, cov = equalize.constellation(eg, ref, w, pal)
            y = eg[dr, dc]
            llr_tx = modem.bit_llrs(modem.symbol_loglik(y, centroids, cov), bpc).reshape(-1)
            llr_cw = np.empty(n_bits)
            llr_cw[perm] = llr_tx
            if res.channel_llrs is None:
                res.channel_llrs = llr_cw.copy()
            if prior_llrs is not None:
                llr_cw = llr_cw + prior_llrs
            bits, post, converged, iters = ldpc.decode(code, llr_cw)
            res.ldpc_iterations += iters
            res.refine_rounds = rnd
            parsed = framing.parse_info_bits(bits[:k]) if converged else None
            if parsed is not None or rnd == REFINE_ROUNDS:
                return parsed, cov, converged
            # Decision-directed refinement: confident data cells become extra references.
            post_tx = post[perm].reshape(-1, bpc)
            probs = modem.symbol_posteriors_from_bit_llrs(post_tx, bpc)
            best = probs.argmax(axis=1)
            conf = probs[np.arange(len(best)), best]
            sel = conf >= REFINE_CONFIDENCE
            ref[dr[sel], dc[sel]] = pal[best[sel]]
            w[dr[sel], dc[sel]] = conf[sel]
        raise AssertionError("unreachable")

    # The frame on its own first, so a decodable frame can never be spoiled by history
    # from a different codeword; then together with earlier frames (pacc.combine).
    parsed, cov, converged = run(None, ref.copy(), w.copy())
    if parsed is None and combiner is not None and res.channel_llrs is not None:
        key = (n, mcs, level)
        prior = combiner.prior(key, res.channel_llrs)
        combiner.offer(key, res.channel_llrs)
        if prior is not None:
            parsed, cov, converged = run(prior, ref, w)
            if parsed is not None:
                res.frames_combined = combiner.frames_for(key) + 1
    if parsed is not None:
        res.diagnostics = {"noise_sigma": float(np.sqrt(np.trace(cov) / 3))}
        return finish(res, parsed[0], parsed[1], secrets)
    res.error = "LDPC decoding did not converge" if not converged else "CRC mismatch"
    return res

