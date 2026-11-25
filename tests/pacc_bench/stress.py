"""
stress.py — Composite lighting x damage scenarios used by the Test Lab "Master Stress
Matrix" suite (pacc_web/scripts/pacc_suites.py).

Colour functions treat the array as BGR-ordered, as the originals did; on RGB input the warm
and cool casts are therefore swapped, which keeps scenario names stable across suites.
"""
from __future__ import annotations

from typing import Callable, Dict, Optional

import numpy as np
from matplotlib.colors import hsv_to_rgb, rgb_to_hsv


# ── Lighting ──────────────────────────────────────────────────────────────────

def apply_sun_bleach(arr: np.ndarray) -> np.ndarray:
    """Intense ambient light: washed-out saturation, raised brightness."""
    hsv = rgb_to_hsv(arr[..., ::-1].astype(np.float32) / 255.0)
    hsv[..., 1] = np.clip(hsv[..., 1] * 0.45, 0.0, 1.0)
    hsv[..., 2] = np.clip(hsv[..., 2] * 1.35, 0.0, 1.0)
    return np.clip((hsv_to_rgb(hsv) * 255.0)[..., ::-1], 0, 255).astype(np.uint8)


def apply_underexposed(arr: np.ndarray) -> np.ndarray:
    """Severe underexposure / dark shadow."""
    hsv = rgb_to_hsv(arr[..., ::-1].astype(np.float32) / 255.0)
    hsv[..., 2] = np.clip(hsv[..., 2] * 0.58, 0.0, 1.0)
    return np.clip((hsv_to_rgb(hsv) * 255.0)[..., ::-1], 0, 255).astype(np.uint8)


def apply_warm_tint(arr: np.ndarray) -> np.ndarray:
    """Warm incandescent / sunset light."""
    out = arr.astype(np.float32)
    out[..., 2] = np.clip(out[..., 2] * 1.20, 0.0, 255.0)
    out[..., 1] = np.clip(out[..., 1] * 1.10, 0.0, 255.0)
    out[..., 0] = np.clip(out[..., 0] * 0.75, 0.0, 255.0)
    return out.astype(np.uint8)


def apply_cool_tint(arr: np.ndarray) -> np.ndarray:
    """Cool blue LED / fluorescent light."""
    out = arr.astype(np.float32)
    out[..., 2] = np.clip(out[..., 2] * 0.75, 0.0, 255.0)
    out[..., 1] = np.clip(out[..., 1] * 1.05, 0.0, 255.0)
    out[..., 0] = np.clip(out[..., 0] * 1.30, 0.0, 255.0)
    return out.astype(np.uint8)


def apply_hue_shift(arr: np.ndarray, degrees: float = 35.0) -> np.ndarray:
    """Global white-balance / hue drift."""
    hsv = rgb_to_hsv(arr[..., ::-1].astype(np.float32) / 255.0)
    hsv[..., 0] = (hsv[..., 0] + degrees / 360.0) % 1.0
    return np.clip((hsv_to_rgb(hsv) * 255.0)[..., ::-1], 0, 255).astype(np.uint8)


# ── Damage ────────────────────────────────────────────────────────────────────

def _rng(rng: Optional[np.random.Generator]) -> np.random.Generator:
    return rng if rng is not None else np.random.default_rng()


def damage_level1(arr: np.ndarray, rng: Optional[np.random.Generator] = None) -> np.ndarray:
    """Light: 5% random white pixel noise."""
    out = arr.copy()
    out[_rng(rng).random(out.shape[:2]) < 0.05] = 255
    return out


def damage_level2(arr: np.ndarray, rng: Optional[np.random.Generator] = None) -> np.ndarray:
    """Moderate: 15% white pixel noise plus a horizontal scratch across 80% of the width."""
    out = arr.copy()
    h, w = out.shape[:2]
    out[_rng(rng).random((h, w)) < 0.15] = 255
    out[int(h * 0.40):int(h * 0.45), int(w * 0.10):int(w * 0.90)] = 255
    return out


def damage_level3(arr: np.ndarray, rng: Optional[np.random.Generator] = None) -> np.ndarray:
    """Severe: 30% white pixel noise plus a 30% x 30% central occlusion."""
    out = arr.copy()
    h, w = out.shape[:2]
    out[_rng(rng).random((h, w)) < 0.30] = 255
    out[int(h * 0.25):int(h * 0.55), int(w * 0.25):int(w * 0.55)] = 255
    return out


COLOUR_TESTS: Dict[str, Callable[[np.ndarray], np.ndarray]] = {
    "Sun-Bleached": apply_sun_bleach,
    "Under-Exposed": apply_underexposed,
    "Warm Tint": apply_warm_tint,
    "Cool Tint": apply_cool_tint,
    "Hue Shift": lambda arr: apply_hue_shift(arr, 35.0),
}

DAMAGE_TESTS: Dict[str, Callable[[np.ndarray, Optional[np.random.Generator]], np.ndarray]] = {
    "Level-1 Light": damage_level1,
    "Level-2 Moderate": damage_level2,
    "Level-3 Severe": damage_level3,
}


def apply_composite_stress(arr: np.ndarray, damage_name: str, colour_name: str,
                           rng: Optional[np.random.Generator] = None) -> np.ndarray:
    """Lighting first, then physical damage."""
    out = arr.copy()
    if colour_name in COLOUR_TESTS:
        out = COLOUR_TESTS[colour_name](out)
    if damage_name in DAMAGE_TESTS:
        out = DAMAGE_TESTS[damage_name](out, rng)
    return out
