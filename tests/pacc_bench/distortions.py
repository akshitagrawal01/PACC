"""
distortions.py — Mathematical Damage, Optical, Lighting, and Geometric Distortions
================================================================================
All distortion functions operate on uint8 RGB NumPy arrays (H, W, 3).
Seeds are strictly controlled via np.random.default_rng(seed).
"""

import math
from typing import Optional, Tuple
import numpy as np
from matplotlib.colors import hsv_to_rgb, rgb_to_hsv

try:
    import cv2
except ImportError:
    cv2 = None


def apply_gaussian_noise(
    arr: np.ndarray,
    sigma: float,
    rng: Optional[np.random.Generator] = None,
) -> np.ndarray:
    if sigma <= 0:
        return arr.copy()
    if rng is None:
        rng = np.random.default_rng()
    noise = rng.normal(0.0, sigma, size=arr.shape)
    return np.clip(arr.astype(np.float32) + noise, 0, 255).astype(np.uint8)


def apply_salt_and_pepper(
    arr: np.ndarray,
    density: float,
    rng: Optional[np.random.Generator] = None,
) -> np.ndarray:
    if density <= 0:
        return arr.copy()
    if rng is None:
        rng = np.random.default_rng()
    out = arr.copy()
    h, w = out.shape[:2]
    num_corrupt = int(h * w * density)
    if num_corrupt <= 0:
        return out
    ys = rng.integers(0, h, size=num_corrupt)
    xs = rng.integers(0, w, size=num_corrupt)
    vals = rng.choice([0, 255], size=num_corrupt)
    for y, x, v in zip(ys, xs, vals):
        out[y, x] = v
    return out


def apply_color_channel_noise(
    arr: np.ndarray,
    sigma: float,
    rng: Optional[np.random.Generator] = None,
) -> np.ndarray:
    if sigma <= 0:
        return arr.copy()
    if rng is None:
        rng = np.random.default_rng()
    noise = rng.normal(0.0, sigma, size=arr.shape)
    return np.clip(arr.astype(np.float32) + noise, 0, 255).astype(np.uint8)


def apply_cell_erasures(
    arr: np.ndarray,
    fraction: float,
    cell_size: int = 10,
    rng: Optional[np.random.Generator] = None,
    fill_mode: str = "neutral",
) -> np.ndarray:
    if fraction <= 0:
        return arr.copy()
    if rng is None:
        rng = np.random.default_rng()
    out = arr.copy()
    h, w = out.shape[:2]
    grid_rows = h // cell_size
    grid_cols = w // cell_size
    total_cells = grid_rows * grid_cols
    num_erased = int(total_cells * fraction)
    if num_erased <= 0:
        return out
    indices = rng.choice(total_cells, size=num_erased, replace=False)
    for idx in indices:
        r = idx // grid_cols
        c = idx % grid_cols
        y0, y1 = r * cell_size, (r + 1) * cell_size
        x0, x1 = c * cell_size, (c + 1) * cell_size
        if fill_mode == "chromatic":
            out[y0:y1, x0:x1] = rng.integers(0, 256, size=3, dtype=np.uint8)
        else:
            out[y0:y1, x0:x1] = (128, 128, 128)
    return out


def apply_rectangular_occlusion(
    arr: np.ndarray,
    area_fraction: float,
    offset: Tuple[float, float] = (0.5, 0.5),
    fill_color: Tuple[int, int, int] = (255, 255, 255),
    fill_mode: str = "neutral",
    rng: Optional[np.random.Generator] = None,
) -> np.ndarray:
    if area_fraction <= 0:
        return arr.copy()
    out = arr.copy()
    h, w = out.shape[:2]
    occ_w = int(round(w * math.sqrt(area_fraction)))
    occ_h = int(round(h * math.sqrt(area_fraction)))
    center_y = int(h * offset[1])
    center_x = int(w * offset[0])
    y0 = max(0, center_y - occ_h // 2)
    y1 = min(h, y0 + occ_h)
    x0 = max(0, center_x - occ_w // 2)
    x1 = min(w, x0 + occ_w)
    if fill_mode == "chromatic":
        if rng is None:
            rng = np.random.default_rng()
        out[y0:y1, x0:x1] = rng.integers(0, 256, size=(y1 - y0, x1 - x0, 3), dtype=np.uint8)
    else:
        out[y0:y1, x0:x1] = fill_color
    return out


def apply_scratch(
    arr: np.ndarray,
    scratch_type: str = "horizontal",
    width: int = 6,
    rng: Optional[np.random.Generator] = None,
    fill_mode: str = "neutral",
) -> np.ndarray:
    if width <= 0:
        return arr.copy()
    if rng is None:
        rng = np.random.default_rng()
    out = arr.copy()
    h, w = out.shape[:2]
    scratch_color = rng.integers(0, 256, size=3, dtype=np.uint8).tolist() if fill_mode == "chromatic" else [255, 255, 255]
    if scratch_type == "horizontal":
        y0 = h // 2 - width // 2
        y1 = min(h, y0 + width)
        x0 = int(w * 0.1)
        x1 = int(w * 0.9)
        out[y0:y1, x0:x1] = scratch_color
        return out
    elif scratch_type == "vertical":
        x0 = w // 2 - width // 2
        x1 = min(w, x0 + width)
        y0 = int(h * 0.1)
        y1 = int(h * 0.9)
        out[y0:y1, x0:x1] = scratch_color
        return out
    elif scratch_type == "diagonal":
        color_tuple = tuple(int(c) for c in scratch_color)
        if cv2 is not None:
            pt1 = (int(w * 0.1), int(h * 0.1))
            pt2 = (int(w * 0.9), int(h * 0.9))
            cv2.line(out, pt1, pt2, color_tuple, thickness=width)
            return out
        else:
            for d in range(min(h, w)):
                y = int(h * 0.1 + d * 0.8)
                x = int(w * 0.1 + d * 0.8)
                if y < h and x < w:
                    out[max(0, y - width // 2):min(h, y + width // 2), max(0, x - width // 2):min(w, x + width // 2)] = scratch_color
            return out
    return out


def apply_corner_loss(
    arr: np.ndarray,
    corner_size_fraction: float = 0.25,
    num_corners: int = 1,
) -> np.ndarray:
    if corner_size_fraction <= 0 or num_corners <= 0:
        return arr.copy()
    out = arr.copy()
    h, w = out.shape[:2]
    c_h = int(h * corner_size_fraction)
    c_w = int(w * corner_size_fraction)

    corners = [
        (0, c_h, 0, c_w),
        (0, c_h, w - c_w, w),
        (h - c_h, h, 0, c_w),
        (h - c_h, h, w - c_w, w),
    ]

    for y0, y1, x0, x1 in corners[:num_corners]:
        out[y0:y1, x0:x1] = 255
    return out


def apply_glare(
    arr: np.ndarray,
    intensity: float = 200.0,
    radius: float = 60.0,
    center: Tuple[float, float] = (0.5, 0.5),
) -> np.ndarray:
    out = arr.astype(np.float32)
    h, w = arr.shape[:2]
    cx, cy = w * center[0], h * center[1]
    y, x = np.ogrid[:h, :w]
    dist_sq = (x - cx) ** 2 + (y - cy) ** 2
    glare = intensity * np.exp(-dist_sq / (2.0 * (radius ** 2)))
    out += glare[..., np.newaxis]
    return np.clip(out, 0, 255).astype(np.uint8)


def apply_underexposure_spot(
    arr: np.ndarray,
    attenuation: float = 0.85,
    radius: float = 80.0,
    center: Tuple[float, float] = (0.5, 0.5),
) -> np.ndarray:
    out = arr.astype(np.float32)
    h, w = arr.shape[:2]
    cx, cy = w * center[0], h * center[1]
    y, x = np.ogrid[:h, :w]
    dist_sq = (x - cx) ** 2 + (y - cy) ** 2
    shadow = 1.0 - attenuation * np.exp(-dist_sq / (2.0 * (radius ** 2)))
    out *= shadow[..., np.newaxis]
    return np.clip(out, 0, 255).astype(np.uint8)


def apply_exposure_gamma(
    arr: np.ndarray,
    exposure: float = 1.0,
    gamma: float = 1.0,
) -> np.ndarray:
    scaled = arr.astype(np.float32) * exposure
    normalized = np.clip(scaled / 255.0, 0.0, 1.0)
    corrected = np.power(normalized, gamma) * 255.0
    return np.clip(corrected, 0, 255).astype(np.uint8)


def apply_white_balance(
    arr: np.ndarray,
    temp_shift: float = 0.5,
) -> np.ndarray:
    out = arr.astype(np.float32)
    if temp_shift > 0:
        out[..., 0] = np.clip(out[..., 0] * (1.0 + 0.35 * temp_shift), 0, 255)
        out[..., 2] = np.clip(out[..., 2] * (1.0 - 0.35 * temp_shift), 0, 255)
    else:
        s = abs(temp_shift)
        out[..., 2] = np.clip(out[..., 2] * (1.0 + 0.35 * s), 0, 255)
        out[..., 0] = np.clip(out[..., 0] * (1.0 - 0.35 * s), 0, 255)
    return out.astype(np.uint8)


def apply_hue_rotation(
    arr: np.ndarray,
    degrees: float = 0.0,
) -> np.ndarray:
    norm = arr.astype(np.float32) / 255.0
    hsv = rgb_to_hsv(norm)
    hsv[..., 0] = (hsv[..., 0] + degrees / 360.0) % 1.0
    rgb = hsv_to_rgb(hsv) * 255.0
    return np.clip(rgb, 0, 255).astype(np.uint8)


def apply_saturation_scale(
    arr: np.ndarray,
    factor: float,
) -> np.ndarray:
    norm = arr.astype(np.float32) / 255.0
    hsv = rgb_to_hsv(norm)
    hsv[..., 1] = np.clip(hsv[..., 1] * factor, 0.0, 1.0)
    rgb = hsv_to_rgb(hsv) * 255.0
    return np.clip(rgb, 0, 255).astype(np.uint8)


def apply_vignetting(
    arr: np.ndarray,
    strength: float = 0.5,
) -> np.ndarray:
    h, w = arr.shape[:2]
    cx, cy = w / 2.0, h / 2.0
    max_r = math.sqrt(cx ** 2 + cy ** 2)
    y, x = np.ogrid[:h, :w]
    r = np.sqrt((x - cx) ** 2 + (y - cy) ** 2) / max_r
    falloff = 1.0 - strength * (r ** 2)
    falloff = np.clip(falloff, 0.0, 1.0)[..., np.newaxis]
    return np.clip(arr.astype(np.float32) * falloff, 0, 255).astype(np.uint8)


def apply_gaussian_blur(
    arr: np.ndarray,
    kernel_size: int,
) -> np.ndarray:
    if kernel_size <= 1:
        return arr.copy()
    if kernel_size % 2 == 0:
        kernel_size += 1

    if cv2 is not None:
        return cv2.GaussianBlur(arr, (kernel_size, kernel_size), 0)
    else:
        from PIL import ImageFilter, Image
        img = Image.fromarray(arr)
        radius = (kernel_size - 1) / 4.0
        return np.array(img.filter(ImageFilter.GaussianBlur(radius=radius)), dtype=np.uint8)


def apply_motion_blur(
    arr: np.ndarray,
    length: int,
    angle_deg: float = 0.0,
) -> np.ndarray:
    if length <= 1 or cv2 is None:
        return arr.copy()

    kernel = np.zeros((length, length), dtype=np.float32)
    center = length // 2
    theta = math.radians(angle_deg)
    cos_t = math.cos(theta)
    sin_t = math.sin(theta)

    for i in range(-center, center + 1):
        x = round(center + i * cos_t)
        y = round(center + i * sin_t)
        if 0 <= x < length and 0 <= y < length:
            kernel[y, x] = 1.0

    k_sum = kernel.sum()
    if k_sum > 0:
        kernel /= k_sum
    else:
        kernel[center, center] = 1.0

    return cv2.filter2D(arr, -1, kernel)


def apply_rotation(
    arr: np.ndarray,
    angle_deg: float,
    ssaa_factor: int = 3,
) -> np.ndarray:
    if abs(angle_deg) < 0.001:
        return arr.copy()
    if cv2 is not None and ssaa_factor > 1:
        h_orig, w_orig = arr.shape[:2]
        up = cv2.resize(arr, (w_orig * ssaa_factor, h_orig * ssaa_factor), interpolation=cv2.INTER_NEAREST)
        uh, uw = up.shape[:2]
        center = (uw / 2.0, uh / 2.0)
        M = cv2.getRotationMatrix2D(center, angle_deg, 1.0)
        cos_a = abs(M[0, 0])
        sin_a = abs(M[0, 1])
        new_w = int(uh * sin_a + uw * cos_a)
        new_h = int(uh * cos_a + uw * sin_a)
        M[0, 2] += (new_w / 2.0) - center[0]
        M[1, 2] += (new_h / 2.0) - center[1]
        warped_up = cv2.warpAffine(up, M, (new_w, new_h), borderMode=cv2.BORDER_CONSTANT, borderValue=(255, 255, 255))
        final_w = max(1, new_w // ssaa_factor)
        final_h = max(1, new_h // ssaa_factor)
        return cv2.resize(warped_up, (final_w, final_h), interpolation=cv2.INTER_AREA)

    h, w = arr.shape[:2]
    if cv2 is not None:
        center = (w / 2.0, h / 2.0)
        M = cv2.getRotationMatrix2D(center, angle_deg, 1.0)
        cos_a = abs(M[0, 0])
        sin_a = abs(M[0, 1])
        new_w = int(h * sin_a + w * cos_a)
        new_h = int(h * cos_a + w * sin_a)
        M[0, 2] += (new_w / 2.0) - center[0]
        M[1, 2] += (new_h / 2.0) - center[1]
        return cv2.warpAffine(arr, M, (new_w, new_h), borderMode=cv2.BORDER_CONSTANT, borderValue=(255, 255, 255))
    else:
        from PIL import Image
        img = Image.fromarray(arr)
        rot = img.rotate(angle_deg, expand=True, fillcolor=(255, 255, 255))
        return np.array(rot, dtype=np.uint8)


def apply_perspective_tilt(
    arr: np.ndarray,
    yaw_deg: float = 0.0,
    pitch_deg: float = 0.0,
    camera_fov_deg: float = 60.0,
    ssaa_factor: int = 3,
) -> np.ndarray:
    if cv2 is None or (abs(yaw_deg) < 0.001 and abs(pitch_deg) < 0.001):
        return arr.copy()

    # Barcodes are high-frequency piecewise-constant grids. Bilinear projective warping
    # without area integration introduces spatial Nyquist phase-cancellation notches
    # along 1D timing tracks (e.g., at ~65° pitch tilt where module height reaches ~2 px).
    # Upsampling via nearest-neighbor followed by projection and cv2.INTER_AREA downsampling
    # simulates continuous optical aperture integration and guarantees strictly monotonic degradation.
    if ssaa_factor > 1:
        h_orig, w_orig = arr.shape[:2]
        up = cv2.resize(arr, (w_orig * ssaa_factor, h_orig * ssaa_factor), interpolation=cv2.INTER_NEAREST)
        warped_up = apply_perspective_tilt(
            up,
            yaw_deg=yaw_deg,
            pitch_deg=pitch_deg,
            camera_fov_deg=camera_fov_deg,
            ssaa_factor=1,
        )
        wh, ww = warped_up.shape[:2]
        final_w = max(1, ww // ssaa_factor)
        final_h = max(1, wh // ssaa_factor)
        return cv2.resize(warped_up, (final_w, final_h), interpolation=cv2.INTER_AREA)

    h, w = arr.shape[:2]
    f = (w / 2.0) / math.tan(math.radians(camera_fov_deg / 2.0))

    yaw_rad = math.radians(yaw_deg)
    pitch_rad = math.radians(pitch_deg)

    K = np.array([
        [f, 0, w / 2.0],
        [0, f, h / 2.0],
        [0, 0, 1]
    ], dtype=np.float64)

    R_yaw = np.array([
        [math.cos(yaw_rad), 0, math.sin(yaw_rad)],
        [0, 1, 0],
        [-math.sin(yaw_rad), 0, math.cos(yaw_rad)]
    ], dtype=np.float64)

    R_pitch = np.array([
        [1, 0, 0],
        [0, math.cos(pitch_rad), -math.sin(pitch_rad)],
        [0, math.sin(pitch_rad), math.cos(pitch_rad)]
    ], dtype=np.float64)

    R = R_yaw @ R_pitch

    src_pts = np.array([
        [-w / 2.0, -h / 2.0, 0, 1],
        [w / 2.0, -h / 2.0, 0, 1],
        [w / 2.0, h / 2.0, 0, 1],
        [-w / 2.0, h / 2.0, 0, 1]
    ], dtype=np.float64)

    T = np.array([0, 0, f], dtype=np.float64)

    proj_pts = []
    for pt in src_pts:
        p3d = R @ pt[:3] + T
        p2d = K @ p3d
        proj_pts.append([p2d[0] / p2d[2], p2d[1] / p2d[2]])

    proj_pts = np.array(proj_pts, dtype=np.float32)

    src_corners = np.array([
        [0, 0],
        [w, 0],
        [w, h],
        [0, h]
    ], dtype=np.float32)

    min_x, min_y = np.min(proj_pts, axis=0)
    max_x, max_y = np.max(proj_pts, axis=0)
    canv_w = int(math.ceil(max_x - min_x)) + 20
    canv_h = int(math.ceil(max_y - min_y)) + 20

    dst_pts = proj_pts - np.array([min_x - 10, min_y - 10], dtype=np.float32)

    H_mat = cv2.getPerspectiveTransform(src_corners, dst_pts)
    warped = cv2.warpPerspective(
        arr,
        H_mat,
        (canv_w, canv_h),
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=(255, 255, 255)
    )
    return warped


def apply_downsampling(
    arr: np.ndarray,
    scale_factor: float,
) -> np.ndarray:
    if scale_factor >= 1.0 or scale_factor <= 0:
        return arr.copy()

    h, w = arr.shape[:2]
    new_w = max(4, int(w * scale_factor))
    new_h = max(4, int(h * scale_factor))

    if cv2 is not None:
        down = cv2.resize(arr, (new_w, new_h), interpolation=cv2.INTER_AREA)
        up = cv2.resize(down, (w, h), interpolation=cv2.INTER_LINEAR)
        return up
    else:
        from PIL import Image
        img = Image.fromarray(arr)
        down = img.resize((new_w, new_h), Image.Resampling.BOX)
        up = down.resize((w, h), Image.Resampling.BILINEAR)
        return np.array(up, dtype=np.uint8)


# ─────────────────────────────────────────────────────────────────────────────
# Shared trial-construction helpers (fairness and pairing)
# ─────────────────────────────────────────────────────────────────────────────

def place_on_canvas(arr: np.ndarray, rng: Optional[np.random.Generator] = None) -> np.ndarray:
    """Embed a symbol image in a larger white canvas with random, uneven margins.

    Without this, a PACC test image is exactly the encoded PNG minus metadata, so
    the decoder can recover cell size and quiet zone from the image width alone
    and skip finder detection, while QR/JAB readers must locate their finders.
    Applying the same random canvas to every format makes all decoders perform
    real symbol localisation.
    """
    h, w = arr.shape[:2]
    if rng is not None:
        pad_y0, pad_y1, pad_x0, pad_x1 = (int(v) for v in rng.integers(35, 65, size=4))
    else:
        pad_y0, pad_y1, pad_x0, pad_x1 = 45, 55, 40, 50
    canvas = np.full((h + pad_y0 + pad_y1, w + pad_x0 + pad_x1, 3), 255, dtype=np.uint8)
    canvas[pad_y0:pad_y0 + h, pad_x0:pad_x0 + w] = arr
    return canvas


def paired_seed(base_seed: int, condition: str, trial_idx: int) -> int:
    """Seed for one trial of one condition, identical across formats.

    Every format then sees the same noise and canvas for a given (condition,
    trial), so outcomes pair up for McNemar tests.
    """
    import zlib
    return (base_seed + zlib.crc32(condition.encode("utf-8")) * 31 + trial_idx * 7919) & 0xFFFFFFFF


def thin_sweep(values: list, max_points: Optional[int]) -> list:
    """Evenly subsample a sweep to at most *max_points* values, keeping both endpoints."""
    if not max_points or len(values) <= max_points:
        return list(values)
    idx = np.unique(np.round(np.linspace(0, len(values) - 1, max_points)).astype(int))
    return [values[i] for i in idx]
