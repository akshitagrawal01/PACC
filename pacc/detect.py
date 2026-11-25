"""
pacc.detect — Locate a PACC symbol in an image and sample its cell grid.

1. Find finder patterns two ways: exact nested contours (dark ring / light ring /
   dark core, checked by area ratios), and a damage-tolerant detector that takes
   compact dark cores and votes on the light ring, dark ring and separator around
   them at 16 angles, so a finder with a wiped cell or a scratch through it still
   counts. Both escalate to denoised images when fewer than four turn up.
2. Pick the four finders that form the symbol's corners; complete a parallelogram
   from three; from two, hypothesise the squares they could belong to (the format
   word then accepts or rejects each hypothesis).
3. Estimate the grid size from finder spacing and finder module size; the
   format word then confirms it (the decoder retries with the size it reports).
4. Map cell centres through the corner homography and average a 5x5 patch of
   sub-samples inside each cell.
"""
from __future__ import annotations

import itertools
import math
from dataclasses import dataclass

import cv2
import numpy as np

from pacc.spec import FINDER, grid_sizes


@dataclass(frozen=True)
class Finder:
    x: float
    y: float
    module: float          # estimated module (cell) size in pixels
    score: float = 2.0     # 2.0 = exact contour match; ring-vote fraction otherwise


def _binarisations(gray: np.ndarray) -> list[np.ndarray]:
    out = []
    _, otsu = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV | cv2.THRESH_OTSU)
    out.append(otsu)
    block = max(15, (min(gray.shape) // 10) | 1)
    out.append(cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_MEAN_C, cv2.THRESH_BINARY_INV, block, 7))
    return out


def find_finders(rgb: np.ndarray) -> list[Finder]:
    """Finder candidates, escalating to the ring-vote detector and denoised images
    when fewer than four turn up. Sorted by confidence."""
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    finders = _find_in(gray)
    stages = (
        lambda: _find_by_cores(gray),
        lambda: _find_in(cv2.medianBlur(gray, 5)) + _find_by_cores(cv2.medianBlur(gray, 5)),
        lambda: _find_in(cv2.GaussianBlur(gray, (0, 0), 2.0)),
        lambda: _find_in(cv2.GaussianBlur(gray, (0, 0), 3.5)),
    )
    for stage in stages:
        if len(finders) >= 4:
            break
        finders = _merge(finders + stage())
    return _merge(finders + _complete_corners(gray, finders))


# ── Missing fourth finder ────────────────────────────────────────────────────
# A tilted symbol in dim light can lose one finder to shadow and blur, or to dark data
# cells merging with its ring. Three finders at a right angle say where the fourth must be:
# along the missing side, whose length under perspective lies between 0.3 and 2.2 times the
# opposite side. That strip is searched in small, locally normalised windows.

def _on_strip(f: Finder, ox: float, oy: float, vx: float, vy: float, module: float,
              ex: float = 0.0, ey: float = 0.0) -> bool:
    """On the strip o + t*v (t in [0.3, 2.2]), allowing a shift of s*e (s in [0, 1]) towards the
    centre of the symbol: under perspective the corners of the far edge move inwards."""
    length2 = vx * vx + vy * vy
    dx, dy = f.x - ox, f.y - oy
    t = (dx * vx + dy * vy) / length2
    rx, ry = dx - t * vx, dy - t * vy
    e2 = ex * ex + ey * ey
    if e2 > 0:
        sh = min(1.0, max(0.0, (rx * ex + ry * ey) / e2))
        rx, ry = rx - sh * ex, ry - sh * ey
    return 0.3 <= t <= 2.2 and math.hypot(rx, ry) < 3 * module and 0.4 < f.module / module < 2.5


def _search_strip(gray: np.ndarray, ox: float, oy: float, vx: float, vy: float, module: float,
                  ex: float = 0.0, ey: float = 0.0) -> list[Finder]:
    h, w = gray.shape
    length = math.hypot(vx, vy)
    half = 8 * module                      # a window holds a whole finder with its separator
    steps = max(2, int(1.9 * length / (3 * module)) + 1)
    out = []
    shifts = (0.0, 0.5, 1.0) if ex or ey else (0.0,)
    for k, sh in itertools.product(range(steps + 1), shifts):
        t = 0.3 + 1.9 * k / steps
        cx, cy = ox + t * vx + sh * ex, oy + t * vy + sh * ey
        x0, y0 = int(max(0, cx - half)), int(max(0, cy - half))
        x1, y1 = int(min(w, cx + half)), int(min(h, cy + half))
        if x1 - x0 < 8 or y1 - y0 < 8:
            continue
        win = gray[y0:y1, x0:x1].astype(np.float32)
        lo, hi = float(win.min()), float(win.max())
        if hi - lo < 16:                   # flat: nothing to find
            continue
        win = ((win - lo) * (255.0 / (hi - lo))).astype(np.uint8)
        for f in _find_in(win) + _find_by_cores(win):
            g = Finder(f.x + x0, f.y + y0, f.module, f.score)
            if _on_strip(g, ox, oy, vx, vy, module, ex, ey):
                out.append(g)
    # One finder per strip (the most finder-like); below the directly detected ones in rank.
    best = max(out, key=lambda f: f.score, default=None)
    return [Finder(best.x, best.y, best.module, 0.5 * min(best.score, 1.0))] if best else []


def _right_angle_trios(pool: list[Finder]):
    """(a, b, c): three finders with a right angle at a, sides at least 6 modules long."""
    for trio in itertools.combinations(pool, 3):
        if max(f.module for f in trio) / min(f.module for f in trio) > 2.6:
            continue
        for i in range(3):
            a, b, c = trio[i], trio[(i + 1) % 3], trio[(i + 2) % 3]
            v1, v2 = (b.x - a.x, b.y - a.y), (c.x - a.x, c.y - a.y)
            n1, n2 = math.hypot(*v1), math.hypot(*v2)
            if min(n1, n2) >= 6 * min(f.module for f in trio) and abs((v1[0] * v2[0] + v1[1] * v2[1]) / (n1 * n2)) < 0.35:
                yield trio, a, b, c


def _complete_corners(gray: np.ndarray, finders: list[Finder]) -> list[Finder]:
    pool = finders[:6]
    found = _complete_from_trios(gray, pool)
    if not any(True for _ in _right_angle_trios(pool + found)):
        # Only two finders, e.g. the near edge of a tilted symbol whose far finders are small and
        # squeezed: the opposite edge lies perpendicular to it, on one side or the other, with
        # smaller finders (perspective).
        for a, b in itertools.combinations(pool[:4], 2):
            mod = (a.module + b.module) / 2
            if max(a.module, b.module) / min(a.module, b.module) > 1.5 or math.hypot(b.x - a.x, b.y - a.y) < 8 * mod:
                continue
            for sign in (1, -1):
                nx, ny = -(b.y - a.y) * sign, (b.x - a.x) * sign
                for o, p in ((a, b), (b, a)):
                    ex, ey = 0.35 * (p.x - o.x), 0.35 * (p.y - o.y)       # inward, towards the partner
                    if not any(_on_strip(f, o.x, o.y, nx, ny, 0.6 * o.module, ex, ey) for f in pool + found):
                        found += _search_strip(gray, o.x, o.y, nx, ny, 0.6 * o.module, ex, ey)
        found += _complete_from_trios(gray, _merge(pool + found)[:6])
    return found


def _complete_from_trios(gray: np.ndarray, pool: list[Finder]) -> list[Finder]:
    found: list[Finder] = []
    for trio in itertools.combinations(pool, 3):
        if max(f.module for f in trio) / min(f.module for f in trio) > 2.6:
            continue
        for i in range(3):
            a, b, c = trio[i], trio[(i + 1) % 3], trio[(i + 2) % 3]
            v1, v2 = (b.x - a.x, b.y - a.y), (c.x - a.x, c.y - a.y)
            n1, n2 = math.hypot(*v1), math.hypot(*v2)
            if min(n1, n2) < 6 * min(f.module for f in trio):
                continue
            if abs((v1[0] * v2[0] + v1[1] * v2[1]) / (n1 * n2)) >= 0.35:
                continue
            # The fourth corner lies on the line from c parallel to a->b, and on the line from b parallel to a->c.
            for (o, v, mod) in ((c, v1, c.module), (b, v2, b.module)):
                if any(_on_strip(f, o.x, o.y, v[0], v[1], mod) for f in pool + found if f not in trio):
                    continue
                found += _search_strip(gray, o.x, o.y, v[0], v[1], mod)
    return found


def _merge(found: list[Finder]) -> list[Finder]:
    merged: list[Finder] = []
    for f in sorted(found, key=lambda f: (-f.score, -f.module)):
        if all(math.hypot(f.x - g.x, f.y - g.y) > 2 * g.module for g in merged):
            merged.append(f)
    return merged


# Ring radii in modules from the finder centre: light ring (1.5-2.5), dark outer
# ring (2.5-3.5), light separator (3.5-4.5).
_RING_LIGHT, _RING_DARK, _RING_SEP = 2.0, 3.0, 4.0
_VOTE_ANGLES = np.linspace(0, 2 * np.pi, 16, endpoint=False)


def _find_by_cores(gray: np.ndarray) -> list[Finder]:
    """Damage-tolerant finders: compact dark components whose surroundings match
    the finder's ring structure on most of 16 rays."""
    thr, _ = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY | cv2.THRESH_OTSU)
    dark = (gray <= thr).astype(np.uint8)
    count, _, stats, cents = cv2.connectedComponentsWithStats(dark, connectivity=8)
    h_img, w_img = gray.shape
    max_area = h_img * w_img / 16
    out: list[Finder] = []
    cos, sin = np.cos(_VOTE_ANGLES), np.sin(_VOTE_ANGLES)

    def vote(cx: float, cy: float, rx: float, ry: float, radius: float, want_dark: bool) -> float:
        xs = np.clip(np.rint(cx + radius * rx * cos), 0, w_img - 1).astype(int)
        ys = np.clip(np.rint(cy + radius * ry * sin), 0, h_img - 1).astype(int)
        vals = gray[ys, xs] <= thr
        return float(np.mean(vals if want_dark else ~vals))

    for i in range(1, count):
        _x, _y, w, h, area = stats[i]
        if area < 4 or area > max_area or not 0.35 < w / max(h, 1) < 2.8:
            continue
        if area / float(w * h) < 0.45:
            continue
        cx, cy = cents[i]
        # The core spans 3 modules, so its half-extent is 1.5 modules on each axis.
        mx, my = w / 3.0, h / 3.0
        light = vote(cx, cy, mx, my, _RING_LIGHT, False)
        ring = vote(cx, cy, mx, my, _RING_DARK, True)
        sep = vote(cx, cy, mx, my, _RING_SEP, False)
        if light >= 0.6 and ring >= 0.55 and sep >= 0.5:
            out.append(Finder(float(cx), float(cy), (mx + my) / 2, (light + ring + sep) / 3))
    return _merge(out)


def _find_in(gray: np.ndarray) -> list[Finder]:
    found: list[Finder] = []
    for binary in _binarisations(gray):
        contours, hier = cv2.findContours(binary, cv2.RETR_TREE, cv2.CHAIN_APPROX_SIMPLE)
        if hier is None:
            continue
        hier = hier[0]
        for i, cnt in enumerate(contours):
            child = hier[i][2]
            if child < 0:
                continue
            grand = hier[child][2]
            if grand < 0:
                continue
            a0 = cv2.contourArea(cnt)
            a1 = cv2.contourArea(contours[child])
            a2 = cv2.contourArea(contours[grand])
            if a0 < 49 or a1 <= 0 or a2 <= 0:
                continue
            # Ideal ratios for a 7/5/3 ring: 1.96 and 2.78.
            r01, r12 = a0 / a1, a1 / a2
            if not (1.4 < r01 < 3.0 and 1.7 < r12 < 4.5):
                continue
            _x, _y, w, h = cv2.boundingRect(cnt)
            # Perspective foreshortening can halve a finder's apparent width.
            if not 0.25 < w / max(h, 1) < 4.0:
                continue
            m = cv2.moments(contours[grand])
            if m["m00"] == 0:
                continue
            cx, cy = m["m10"] / m["m00"], m["m01"] / m["m00"]
            found.append(Finder(cx, cy, math.sqrt(a0) / FINDER))
    return _merge(found)   # several binarisations find the same finder


def _order_clockwise(pts: list[tuple[float, float]]) -> list[tuple[float, float]]:
    cx = sum(p[0] for p in pts) / len(pts)
    cy = sum(p[1] for p in pts) / len(pts)
    return sorted(pts, key=lambda p: math.atan2(p[1] - cy, p[0] - cx))


def candidate_quads(finders: list[Finder], limit: int = 6,
                    two_finder: bool = True) -> list[tuple[list[tuple[float, float]], float]]:
    """Up to `limit` plausible corner quads (clockwise image points) with their mean module size."""
    quads = []
    pool = finders[:8]
    for combo in itertools.combinations(pool, 4):
        mods = [f.module for f in combo]
        if max(mods) / min(mods) > 2.6:
            continue
        pts = _order_clockwise([(f.x, f.y) for f in combo])
        sides = [math.dist(pts[i], pts[(i + 1) % 4]) for i in range(4)]
        if min(sides) < 6 * min(mods) or max(sides) / min(sides) > 3.0:
            continue
        area = abs(cv2.contourArea(np.asarray(pts, dtype=np.float32)))
        quads.append((area, pts, sum(mods) / 4))
    if not quads and len(pool) >= 3:
        # Three finders: complete the parallelogram opposite the right-angle corner.
        for trio in itertools.combinations(pool, 3):
            p = [(f.x, f.y) for f in trio]
            mods = [f.module for f in trio]
            if max(mods) / min(mods) > 2.6:
                continue
            for i in range(3):
                a, b, c = p[i], p[(i + 1) % 3], p[(i + 2) % 3]
                v1 = (b[0] - a[0], b[1] - a[1])
                v2 = (c[0] - a[0], c[1] - a[1])
                cos = (v1[0] * v2[0] + v1[1] * v2[1]) / (math.hypot(*v1) * math.hypot(*v2) + 1e-9)
                if abs(cos) < 0.35:
                    d = (b[0] + c[0] - a[0], b[1] + c[1] - a[1])
                    pts = _order_clockwise([a, b, c, d])
                    area = abs(cv2.contourArea(np.asarray(pts, dtype=np.float32)))
                    quads.append((area, pts, sum(mods) / 3))
    quads.sort(key=lambda q: -q[0])
    # Two-finder hypotheses always follow: data blobs can masquerade as finders and
    # produce plausible-looking but wrong 4-finder quads, while the two genuine
    # survivors of a scratch still define the symbol. The format word arbitrates.
    by_score = sorted(pool, key=lambda f: -f.score)
    result = [(q[1], q[2]) for q in quads[:limit]]
    return result + _two_finder_quads(by_score) if two_finder else result


def _two_finder_quads(pool: list[Finder]) -> list[tuple[list[tuple[float, float]], float]]:
    """Squares two surviving finders could belong to: as a diagonal pair, or as
    either side of an edge. Assumes no strong perspective; the format word rejects
    wrong hypotheses."""
    out = []
    for a, b in itertools.combinations(pool[:6], 2):
        if max(a.module, b.module) / min(a.module, b.module) > 1.8:
            continue
        mod = (a.module + b.module) / 2
        if math.hypot(b.x - a.x, b.y - a.y) < 8 * mod:
            continue
        mx, my = (a.x + b.x) / 2, (a.y + b.y) / 2
        hx, hy = (b.x - a.x) / 2, (b.y - a.y) / 2
        out.append((_order_clockwise([(a.x, a.y), (mx - hy, my + hx), (b.x, b.y), (mx + hy, my - hx)]), mod))
        sx, sy = b.x - a.x, b.y - a.y
        for sign in (1, -1):
            px, py = -sy * sign, sx * sign
            out.append((_order_clockwise([(a.x, a.y), (b.x, b.y), (b.x + px, b.y + py), (a.x + px, a.y + py)]), mod))
    return out[:12]


# ── Corner refinement ────────────────────────────────────────────────────────

def _corner_pattern() -> np.ndarray:
    """8x8 top-left block: finder (dark = 1) plus light separator (0)."""
    from pacc.layout import finder_pattern
    block = np.zeros((8, 8))
    block[:FINDER, :FINDER] = finder_pattern()
    return block


_OFFSETS = np.arange(-0.75, 0.76, 0.25)


def refine_corners(gray: np.ndarray, H: np.ndarray, n: int) -> tuple[np.ndarray, float]:
    """Slide each corner's finder template by up to 0.75 cells and keep the best
    match. Returns the homography through the refined finder centres and the mean
    template correlation (1.0 = perfect). Fixes centroid errors from scratched or
    split finder cores and from perspective. All 4 x 49 offsets x 64 cells are
    sampled in one vectorised call."""
    pattern = _corner_pattern().reshape(-1)
    pat = pattern - pattern.mean()
    pat_norm = np.linalg.norm(pat)
    h = FINDER / 2.0
    du, dv = np.meshgrid(_OFFSETS, _OFFSETS, indexing="ij")
    du, dv = du.reshape(-1), dv.reshape(-1)                          # (O,)
    i8 = np.arange(8)
    pts_all = []
    for corner in range(4):
        rows = i8 if corner in (0, 1) else n - 1 - i8
        cols = i8 if corner in (0, 3) else n - 1 - i8
        rr, cc = np.meshgrid(rows + 0.5, cols + 0.5, indexing="ij")  # (8, 8)
        x = cc.reshape(1, -1) + du[:, None]                           # (O, 64)
        y = rr.reshape(1, -1) + dv[:, None]
        pts_all.append(np.stack([x, y], axis=-1))
    pts = np.stack(pts_all).reshape(-1, 1, 2).astype(np.float32)      # (4*O*64, 1, 2)
    mapped = cv2.perspectiveTransform(pts, H).reshape(1, -1, 2)
    vals = cv2.remap(gray.astype(np.float32), mapped[..., 0], mapped[..., 1],
                     cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE).reshape(4, len(du), 64)
    v = -(vals - vals.mean(axis=2, keepdims=True))                    # dark = positive
    norms = np.linalg.norm(v, axis=2) * pat_norm
    corr = np.where(norms > 0, (v @ pat) / np.maximum(norms, 1e-9), -1.0)   # (4, O)
    best = corr.argmax(axis=1)
    src_pts, dst_pts = [], []
    for corner in range(4):
        fc = h if corner in (0, 3) else n - h
        fr = h if corner in (0, 1) else n - h
        src_pts.append([fc, fr])
        target = np.array([[[fc + du[best[corner]], fr + dv[best[corner]]]]], dtype=np.float32)
        dst_pts.append(cv2.perspectiveTransform(target, H).reshape(2))
    H_new = cv2.getPerspectiveTransform(np.array(src_pts, dtype=np.float32), np.array(dst_pts, dtype=np.float32))
    return H_new, float(corr[np.arange(4), best].mean())


# ── Finder-free localisation from the symbol outline ────────────────────────

def outline_quads(rgb: np.ndarray, limit: int = 3) -> list[list[tuple[float, float]]]:
    """Candidate symbol outlines (clockwise image corners of the full N x N grid).

    Ink = pixels whose smallest RGB channel is low: every palette colour except
    white has a zero channel, paper has none. A morphological close fills wiped
    cells, then the largest blobs are fitted with a quadrilateral.
    """
    ink_src = rgb.min(axis=2).astype(np.uint8)
    thr, _ = cv2.threshold(ink_src, 0, 255, cv2.THRESH_BINARY | cv2.THRESH_OTSU)
    ink = (ink_src <= thr).astype(np.uint8) * 255
    k = max(3, round(min(rgb.shape[:2]) / 60))
    closed = cv2.morphologyEx(ink, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (k, k)))
    contours, _ = cv2.findContours(closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    area_min = 0.01 * rgb.shape[0] * rgb.shape[1]
    out = []
    for cnt in sorted(contours, key=cv2.contourArea, reverse=True)[:limit]:
        if cv2.contourArea(cnt) < area_min:
            break
        hull = cv2.convexHull(cnt)
        approx = cv2.approxPolyDP(hull, 0.02 * cv2.arcLength(hull, True), True)
        pts = approx.reshape(-1, 2) if len(approx) == 4 else cv2.boxPoints(cv2.minAreaRect(cnt))
        out.append(_order_clockwise([(float(x), float(y)) for x, y in pts]))
        out.extend(_density_trimmed_boxes(closed, cnt))
    return out


def _dominant_edge_angle(cnt: np.ndarray) -> float:
    """Most common edge direction of a contour, in radians mod pi/2 (length-weighted)."""
    poly = cv2.approxPolyDP(cnt, 2.0, True).reshape(-1, 2).astype(np.float64)
    seg = np.roll(poly, -1, axis=0) - poly
    lengths = np.hypot(seg[:, 0], seg[:, 1])
    angles = np.degrees(np.arctan2(seg[:, 1], seg[:, 0])) % 90.0
    hist = np.bincount(np.round(angles).astype(int) % 90, weights=lengths, minlength=90)
    smooth = hist + np.roll(hist, 1) + np.roll(hist, -1)
    return float(np.radians(np.argmax(smooth)))


def _trimmed_box_at(ys: np.ndarray, xs: np.ndarray, theta: float, frac: float) -> list[tuple[float, float]] | None:
    """Project blob pixels onto axes rotated by theta and cut each side back to
    where pixel density reaches `frac` of the interior's."""
    c, s_ = math.cos(theta), math.sin(theta)
    u = xs * c + ys * s_
    v = -xs * s_ + ys * c
    bounds = []
    for coord in (u, v):
        lo = coord.min()
        counts = np.bincount(np.floor(coord - lo).astype(int))
        if len(counts) < 8:
            return None
        mid = counts[len(counts) // 4: 3 * len(counts) // 4]
        thr = frac * float(np.median(mid))
        idx = np.nonzero(counts >= thr)[0]
        bounds.append((lo + idx[0], lo + idx[-1] + 1))
    (u0, u1), (v0, v1) = bounds
    corners = [(uu * c - vv * s_, uu * s_ + vv * c) for uu, vv in ((u0, v0), (u1, v0), (u1, v1), (u0, v1))]
    return _order_clockwise([(float(x), float(y)) for x, y in corners])


def _density_trimmed_boxes(ink: np.ndarray, cnt: np.ndarray) -> list[list[tuple[float, float]]]:
    """Outlines with sparse fringe removed, at several candidate orientations.

    Smudges and debris next to the symbol stretch a convex hull but are far sparser
    than the symbol. Missing corners (corner tears) can tilt the minimum-area
    rectangle, so the dominant contour-edge direction and a 45-degree alternative
    are tried as well; the format word picks the right one.
    """
    mask = np.zeros(ink.shape, dtype=np.uint8)
    cv2.drawContours(mask, [cnt], -1, 255, thickness=cv2.FILLED)
    ys, xs = np.nonzero((mask > 0) & (ink > 0))
    if len(xs) < 64:
        return []
    rect_angle = math.radians(cv2.minAreaRect(cnt)[2])
    thetas: list[float] = []
    for t in (_dominant_edge_angle(cnt), rect_angle, rect_angle + math.pi / 4):
        t = t % (math.pi / 2)
        if all(min(abs(t - o), math.pi / 2 - abs(t - o)) > math.radians(3) for o in thetas):
            thetas.append(t)
    # Two trim levels: 50% removes dense smudge fringe; 25% keeps sides whose
    # corners are torn away (those columns hold well under half the interior's ink).
    out: list[list[tuple[float, float]]] = []
    for t in thetas:
        for frac in (0.5, 0.25):
            box = _trimmed_box_at(ys.astype(np.float64), xs.astype(np.float64), t, frac)
            if box is not None and all(max(math.dist(p, q) for p, q in zip(box, o)) > 2.0 for o in out):
                out.append(box)
    return out


def outline_homography(pts: list[tuple[float, float]], n: int) -> np.ndarray:
    src = np.array([[0, 0], [n, 0], [n, n], [0, n]], dtype=np.float32)
    return cv2.getPerspectiveTransform(src, np.array(pts, dtype=np.float32))


def estimate_n(pts: list[tuple[float, float]], module: float) -> list[int]:
    """Valid grid sizes ordered by closeness to the estimate from finder spacing."""
    sides = [math.dist(pts[i], pts[(i + 1) % 4]) for i in range(4)]
    est = sum(sides) / 4 / module + FINDER
    tol = max(5.0, 0.15 * est)
    return [n for n in sorted(grid_sizes(), key=lambda n: abs(n - est)) if abs(n - est) <= tol]


def homography(pts: list[tuple[float, float]], n: int) -> np.ndarray:
    """Cell coordinates (x = column, y = row) -> image pixels."""
    h = FINDER / 2.0
    src = np.array([[h, h], [n - h, h], [n - h, n - h], [h, n - h]], dtype=np.float32)
    return cv2.getPerspectiveTransform(src, np.array(pts, dtype=np.float32))


def corner_block_mask(n: int, size: int = 10) -> np.ndarray:
    """Cells of the four size x size corner blocks: finders, separators and every
    format cell under all 8 rotations/reflections."""
    m = np.zeros((n, n), dtype=bool)
    m[:size, :size] = m[:size, -size:] = m[-size:, :size] = m[-size:, -size:] = True
    return m


def sample_cells(rgb: np.ndarray, H: np.ndarray, n: int, mask: np.ndarray,
                 spread: float = 0.3, taps: int = 5) -> np.ndarray:
    """Like sample_grid, but only for cells in mask (others stay 0). Used to screen a
    geometry hypothesis with the format word before sampling the whole grid."""
    rr, cc = np.nonzero(mask)
    offs = np.linspace(-spread, spread, taps)
    acc = np.zeros((len(rr), 3))
    img = rgb.astype(np.float32)
    for dy in offs:
        for dx in offs:
            pts = np.stack([cc + 0.5 + dx, rr + 0.5 + dy], axis=-1).reshape(-1, 1, 2).astype(np.float32)
            mapped = cv2.perspectiveTransform(pts, H).reshape(1, -1, 2)
            acc += cv2.remap(img, mapped[..., 0].astype(np.float32), mapped[..., 1].astype(np.float32),
                             interpolation=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE).reshape(-1, 3)
    out = np.zeros((n, n, 3))
    out[rr, cc] = np.clip(acc / (taps * taps) / 255.0, 0.0, 1.0)
    return out


def sample_grid(rgb: np.ndarray, H: np.ndarray, n: int, spread: float = 0.3, taps: int = 5) -> np.ndarray:
    """(n, n, 3) mean colour of a taps x taps sub-sample patch spanning the inner
    2*spread of each cell, in [0, 1]. Wider patches average away sensor noise while
    staying clear of the neighbouring cells' edges."""
    offs = np.linspace(-spread, spread, taps)
    rr, cc = np.meshgrid(np.arange(n) + 0.5, np.arange(n) + 0.5, indexing="ij")
    acc = np.zeros((n, n, 3), dtype=np.float64)
    img = rgb.astype(np.float32)
    for dy in offs:
        for dx in offs:
            pts = np.stack([cc + dx, rr + dy], axis=-1).reshape(-1, 1, 2).astype(np.float32)
            mapped = cv2.perspectiveTransform(pts, H).reshape(n, n, 2)
            samp = cv2.remap(img, mapped[..., 0].astype(np.float32), mapped[..., 1].astype(np.float32),
                             interpolation=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
            acc += samp
    return np.clip(acc / (len(offs) ** 2) / 255.0, 0.0, 1.0)

