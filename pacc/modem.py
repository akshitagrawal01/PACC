"""
pacc.modem — Bits <-> palette symbols, and soft demapping to bit LLRs.

The demapper models each equalised cell colour y as
    p(y | s) = (1 - eps) * N(y; palette[s], Sigma) + eps * U
where U is a uniform density over the colour cube. The outlier term means a cell
whose colour matches no palette entry (scratch, stain, glare) yields LLRs near
zero, i.e. an erasure, instead of a confident wrong bit.
"""
from __future__ import annotations

import numpy as np

OUTLIER_EPS = 1e-4          # weight of the uniform outlier component (see benchmark N3)
LLR_CAP = 20.0


def bits_to_symbols(bits: np.ndarray, bpc: int) -> np.ndarray:
    b = np.asarray(bits, dtype=np.int64).reshape(-1, bpc)
    weights = 1 << np.arange(bpc - 1, -1, -1)
    return b @ weights


def label_bits(m: int, bpc: int) -> np.ndarray:
    """(m, bpc) bit labels of palette entries, MSB first."""
    return ((np.arange(m)[:, None] >> np.arange(bpc - 1, -1, -1)[None, :]) & 1).astype(np.uint8)


def symbol_loglik(y: np.ndarray, palette: np.ndarray, cov: np.ndarray) -> np.ndarray:
    """(D, M) log p(y | s) including the outlier component."""
    inv = np.linalg.inv(cov)
    _, logdet = np.linalg.slogdet(2 * np.pi * cov)
    d = y[:, None, :] - palette[None, :, :]                   # (D, M, 3)
    maha = np.einsum("dmi,ij,dmj->dm", d, inv, d)
    gauss = -0.5 * maha - 0.5 * logdet
    return np.logaddexp(np.log1p(-OUTLIER_EPS) + gauss, np.log(OUTLIER_EPS))


def bit_llrs(loglik: np.ndarray, bpc: int) -> np.ndarray:
    """(D, bpc) LLRs, positive favouring bit 0."""
    m = loglik.shape[1]
    labels = label_bits(m, bpc)
    out = np.empty((loglik.shape[0], bpc))
    for b in range(bpc):
        zero = loglik[:, labels[:, b] == 0]
        one = loglik[:, labels[:, b] == 1]
        out[:, b] = np.logaddexp.reduce(zero, axis=1) - np.logaddexp.reduce(one, axis=1)
    return np.clip(out, -LLR_CAP, LLR_CAP)


def symbol_posteriors_from_bit_llrs(llr: np.ndarray, bpc: int) -> np.ndarray:
    """(D, M) symbol probabilities from per-bit posterior LLRs (bits treated independently)."""
    m = 1 << bpc
    labels = label_bits(m, bpc)
    # log P(bit = 0) = -log(1 + e^-L), log P(bit = 1) = -log(1 + e^L)
    lp0 = -np.logaddexp(0.0, -llr)
    lp1 = -np.logaddexp(0.0, llr)
    logp = np.zeros((llr.shape[0], m))
    for b in range(bpc):
        logp += np.where(labels[None, :, b] == 0, lp0[:, b:b + 1], lp1[:, b:b + 1])
    logp -= logp.max(axis=1, keepdims=True)
    p = np.exp(logp)
    return p / p.sum(axis=1, keepdims=True)

