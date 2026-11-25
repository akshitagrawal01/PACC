"""
pacc.equalize — Pilot-based colour equalisation.

Maps captured cell colours back to the nominal palette space in two stages:

1. Global: a quadratic colour transform (10 features -> RGB) fitted by ridge
   regression from every reference cell (pilots, finder dark/light cells,
   separators, decoded format cells), shrunk towards the identity. This absorbs
   white balance, saturation loss, gamma and printer/camera colour error.
2. Local: a per-channel linear correction y = a(x) x + b(x) whose coefficients
   vary smoothly over the symbol, estimated from Gaussian-weighted reference
   statistics (a guided-filter style local regression with sparse samples),
   shrunk towards a = 1, b = 0. This absorbs shadows, illumination gradients and
   vignetting.

References carry weights, so decoded data cells can later be added as extra
references with their confidence (decision-directed refinement).
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy.ndimage import gaussian_filter

LOCAL_SIGMA = 4.0          # cells; pilots are every 5 cells
GAUSS_TRUNCATE = 3.0
RIDGE_GLOBAL = 0.5
PRIOR_A = 1.0              # pull of the local gain towards 1
PRIOR_B = 2.0              # pull of the local offset towards 0
COV_FLOOR = 0.002
COV_INFLATE = 1.3


def _features(x: np.ndarray) -> np.ndarray:
    r, g, b = x[..., 0], x[..., 1], x[..., 2]
    return np.stack([np.ones_like(r), r, g, b, r * r, g * g, b * b, r * g, r * b, g * b], axis=-1)


def _blur(a: np.ndarray) -> np.ndarray:
    return gaussian_filter(a, sigma=LOCAL_SIGMA, mode="constant", cval=0.0, truncate=GAUSS_TRUNCATE)


@dataclass
class Equalizer:
    W: np.ndarray            # (10, 3) global transform
    a: np.ndarray            # (n, n, 3) local gain
    b: np.ndarray            # (n, n, 3) local offset
    cov: np.ndarray          # (3, 3) residual covariance at references

    def apply(self, obs: np.ndarray) -> np.ndarray:
        """Equalise an (n, n, 3) grid of captured colours."""
        x = _features(obs) @ self.W
        return self.a * x + self.b


def fit(obs: np.ndarray, ref: np.ndarray, weight: np.ndarray) -> Equalizer:
    """obs, ref: (n, n, 3) in [0, 1]; weight: (n, n), 0 for unknown cells."""
    n = obs.shape[0]
    w = np.asarray(weight, dtype=np.float64)
    mask = w > 0

    # 1. Global quadratic transform, ridge towards identity.
    phi = _features(obs[mask])                       # (R, 10)
    wr = w[mask][:, None]
    W0 = np.zeros((10, 3))
    W0[1, 0] = W0[2, 1] = W0[3, 2] = 1.0
    A = phi.T @ (phi * wr) + RIDGE_GLOBAL * np.eye(10)
    B = phi.T @ (ref[mask] * wr) + RIDGE_GLOBAL * W0
    W = np.linalg.solve(A, B)

    # 2. Local per-channel linear correction from weighted reference statistics.
    x = _features(obs) @ W                           # (n, n, 3)
    S = _blur(w)
    a = np.ones((n, n, 3))
    b = np.zeros((n, n, 3))
    for ch in range(3):
        xc, yc = x[..., ch], ref[..., ch]
        Sx = _blur(w * xc)
        Sy = _blur(w * yc)
        Sxx = _blur(w * xc * xc)
        Sxy = _blur(w * xc * yc)
        # Normal equations of  sum w (a x + b - y)^2 + PRIOR_A (a - 1)^2 + PRIOR_B b^2
        m11 = Sxx + PRIOR_A
        m12 = Sx
        m22 = S + PRIOR_B
        r1 = Sxy + PRIOR_A
        r2 = Sy
        det = m11 * m22 - m12 * m12
        a[..., ch] = (r1 * m22 - m12 * r2) / det
        b[..., ch] = (m11 * r2 - m12 * r1) / det

    eq = Equalizer(W, a, b, np.eye(3) * COV_FLOOR)
    resid = (ref - eq.apply(obs))[mask]
    ww = w[mask]
    cov = (resid * ww[:, None]).T @ resid / max(ww.sum(), 1.0)
    eq.cov = COV_INFLATE * cov + COV_FLOOR * np.eye(3)
    return eq


CENTROID_PRIOR = 1.0       # pseudo-count pulling each centroid towards its nominal colour


def constellation(eq_obs: np.ndarray, ref: np.ndarray, weight: np.ndarray,
                  palette: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Where each palette colour actually lands after equalisation, and the spread around it.

    The equaliser is a regression of nominal colours on noisy observations, so at low
    SNR it shrinks the clusters towards their mean (regression dilution). Centring the
    demapper on the nominal palette would then bias every cell of a colour the same way,
    frame after frame. The centroids are estimated from reference cells whose nominal
    colour is a palette entry (pilots, refined data cells, and black/white references
    when the palette contains them), shrunk towards the nominal colour.
    """
    w = np.asarray(weight, dtype=np.float64)
    mask = w > 0
    y, r, ww = eq_obs[mask], ref[mask], w[mask]
    d = ((r[:, None, :] - palette[None]) ** 2).sum(-1)
    lab = d.argmin(axis=1)
    hit = d[np.arange(len(lab)), lab] < 1e-6
    y, lab, ww = y[hit], lab[hit], ww[hit]
    m = len(palette)
    cnt = np.bincount(lab, weights=ww, minlength=m)
    sums = np.stack([np.bincount(lab, weights=ww * y[:, ch], minlength=m) for ch in range(3)], axis=1)
    centroids = (sums + CENTROID_PRIOR * palette) / (cnt + CENTROID_PRIOR)[:, None]
    resid = y - centroids[lab]
    cov = (resid * ww[:, None]).T @ resid / max(ww.sum(), 1.0)
    return centroids, COV_INFLATE * cov + COV_FLOOR * np.eye(3)

