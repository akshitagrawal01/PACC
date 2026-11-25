/**
 * Symbol localisation and cell sampling — twin of pacc2/detect.py.
 *
 * Finders come from the existing damage-tolerant CCL detector (dark core + ring
 * votes); geometry hypotheses come from four finders, three (parallelogram), two
 * (candidate squares), or the symbol outline when finders are destroyed. Each
 * hypothesis is refined by finder-template correlation and confirmed by the
 * format word before full decoding.
 */
import { getPerspectiveTransformDstToSrc, mapPoint, type Matrix3x3, type Point2D } from "./homography";
import { computeOtsuThreshold, detectFindersCCL } from "./ccl";
import { FINDER, gridSizes } from "./spec";

export interface Finder {
  x: number;
  y: number;
  module: number;
  score: number;
}

export interface Image {
  data: Uint8ClampedArray; // RGBA
  width: number;
  height: number;
}

export function toGray(img: Image): Uint8Array {
  const { data, width, height } = img;
  const g = new Uint8Array(width * height);
  for (let i = 0, j = 0; i < g.length; i++, j += 4) {
    g[i] = (data[j] * 77 + data[j + 1] * 150 + data[j + 2] * 29) >> 8;
  }
  return g;
}

/** Box blur via integral image (radius r). */
export function boxBlur(gray: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const S = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += gray[y * w + x];
      S[(y + 1) * (w + 1) + x + 1] = S[y * (w + 1) + x + 1] + row;
    }
  }
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
      const sum = S[y1 * (w + 1) + x1] - S[y0 * (w + 1) + x1] - S[y1 * (w + 1) + x0] + S[y0 * (w + 1) + x0];
      out[y * w + x] = sum / ((y1 - y0) * (x1 - x0));
    }
  }
  return out;
}

function mergeFinders(found: Finder[]): Finder[] {
  const merged: Finder[] = [];
  for (const f of found.slice().sort((a, b) => b.score - a.score || b.module - a.module)) {
    if (merged.every((g) => Math.hypot(f.x - g.x, f.y - g.y) > 2 * g.module)) merged.push(f);
  }
  return merged;
}

/** findFinders, optionally without the missing-finder search (`complete = false`): live frames run
 *  that search only when the finders found directly do not yield a symbol (see completeFinders). */
export function findFinders(img: Image, gray?: Uint8Array, complete = true): Finder[] {
  const { width: w, height: h } = img;
  const g0 = gray ?? toGray(img);
  const run = (g: Uint8Array): Finder[] =>
    detectFindersCCL(g, w, h, computeOtsuThreshold(g, w * h)).map((f) => ({
      x: f.x, y: f.y, module: f.r / 1.5, score: f.score ?? 1,
    }));
  let finders = mergeFinders(run(g0));
  for (const r of [2, 4]) {
    if (finders.length >= 4) break;
    finders = mergeFinders(finders.concat(run(boxBlur(g0, w, h, r))));
  }
  return complete ? completeFinders(g0, w, h, finders) : finders;
}

/** Add finders recovered by the missing-finder search to those already found. */
export function completeFinders(gray: Uint8Array, w: number, h: number, finders: Finder[]): Finder[] {
  return mergeFinders(finders.concat(completeCorners(gray, w, h, finders)));
}

// ── Missing fourth finder (twin of detect.py) ────────────────────────────────
// A tilted symbol in dim light can lose one finder to shadow and blur, or to dark data cells
// merging with its ring. Three finders at a right angle say where the fourth must be: along the
// missing side, between 0.3 and 2.2 times the opposite side (perspective). That strip is searched
// in small, locally normalised windows.

/** On the strip o + t*v (t in [0.3, 2.2]), allowing a shift of s*e (s in [0, 1]) towards the symbol's
 *  centre: under perspective the corners of the far edge move inwards. */
function onStrip(f: Finder, ox: number, oy: number, vx: number, vy: number, module: number, ex = 0, ey = 0): boolean {
  const l2 = vx * vx + vy * vy;
  const dx = f.x - ox, dy = f.y - oy;
  const t = (dx * vx + dy * vy) / l2;
  let rx = dx - t * vx, ry = dy - t * vy;
  const e2 = ex * ex + ey * ey;
  if (e2 > 0) {
    const sh = Math.min(1, Math.max(0, (rx * ex + ry * ey) / e2));
    rx -= sh * ex;
    ry -= sh * ey;
  }
  return t >= 0.3 && t <= 2.2 && Math.hypot(rx, ry) < 3 * module && f.module / module > 0.4 && f.module / module < 2.5;
}

function searchStrip(g: Uint8Array, w: number, h: number, ox: number, oy: number, vx: number, vy: number,
                     module: number, ex = 0, ey = 0): Finder[] {
  const length = Math.hypot(vx, vy);
  const half = 8 * module;
  const steps = Math.max(2, Math.floor((1.9 * length) / (3 * module)) + 1);
  const out: Finder[] = [];
  const shifts = ex || ey ? [0, 0.5, 1] : [0];
  for (let k = 0; k <= steps; k++) for (const sh of shifts) {
    const t = 0.3 + (1.9 * k) / steps;
    const cx = ox + t * vx + sh * ex, cy = oy + t * vy + sh * ey;
    const x0 = Math.floor(Math.max(0, cx - half)), y0 = Math.floor(Math.max(0, cy - half));
    const x1 = Math.floor(Math.min(w, cx + half)), y1 = Math.floor(Math.min(h, cy + half));
    const ww = x1 - x0, wh = y1 - y0;
    if (ww < 8 || wh < 8) continue;
    let lo = 255, hi = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const v = g[y * w + x];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (hi - lo < 16) continue;
    const win = new Uint8Array(ww * wh);
    const s = 255 / (hi - lo);
    for (let y = 0; y < wh; y++) for (let x = 0; x < ww; x++) win[y * ww + x] = (g[(y + y0) * w + x + x0] - lo) * s;
    for (const f of detectFindersCCL(win, ww, wh, computeOtsuThreshold(win, ww * wh))) {
      const c: Finder = { x: f.x + x0, y: f.y + y0, module: f.r / 1.5, score: f.score ?? 1 };
      if (onStrip(c, ox, oy, vx, vy, module, ex, ey)) out.push(c);
    }
  }
  // One finder per strip (the most finder-like); below the directly detected ones in rank.
  if (!out.length) return [];
  const best = out.reduce((m, f) => (f.score > m.score ? f : m));
  return [{ ...best, score: 0.5 * Math.min(best.score, 1) }];
}

function hasRightAngleTrio(pool: Finder[]): boolean {
  for (const trio of combinations(pool, 3)) {
    const mods = trio.map((f) => f.module);
    if (Math.max(...mods) / Math.min(...mods) > 2.6) continue;
    for (let i = 0; i < 3; i++) {
      const a = trio[i], b = trio[(i + 1) % 3], c = trio[(i + 2) % 3];
      const v1 = { x: b.x - a.x, y: b.y - a.y }, v2 = { x: c.x - a.x, y: c.y - a.y };
      const n1 = Math.hypot(v1.x, v1.y), n2 = Math.hypot(v2.x, v2.y);
      if (Math.min(n1, n2) >= 6 * Math.min(...mods) && Math.abs((v1.x * v2.x + v1.y * v2.y) / (n1 * n2)) < 0.35) return true;
    }
  }
  return false;
}

function completeCorners(g: Uint8Array, w: number, h: number, finders: Finder[]): Finder[] {
  const pool = finders.slice(0, 6);
  const found = completeFromTrios(g, w, h, pool);
  if (!hasRightAngleTrio(pool.concat(found))) {
    // Only two finders, e.g. the near edge of a tilted symbol whose far finders are small and
    // squeezed: the opposite edge lies perpendicular to it, on one side or the other.
    for (const [a, b] of combinations(pool.slice(0, 4), 2)) {
      const mod = (a.module + b.module) / 2;
      if (Math.max(a.module, b.module) / Math.min(a.module, b.module) > 1.5 || Math.hypot(b.x - a.x, b.y - a.y) < 8 * mod) continue;
      for (const sign of [1, -1]) {
        const nx = -(b.y - a.y) * sign, ny = (b.x - a.x) * sign;
        for (const [o, p] of [[a, b], [b, a]]) {
          const ex = 0.35 * (p.x - o.x), ey = 0.35 * (p.y - o.y); // inward, towards the partner
          if (!pool.concat(found).some((f) => onStrip(f, o.x, o.y, nx, ny, 0.6 * o.module, ex, ey))) {
            found.push(...searchStrip(g, w, h, o.x, o.y, nx, ny, 0.6 * o.module, ex, ey));
          }
        }
      }
    }
    found.push(...completeFromTrios(g, w, h, mergeFinders(pool.concat(found)).slice(0, 6)));
  }
  return found;
}

function completeFromTrios(g: Uint8Array, w: number, h: number, pool: Finder[]): Finder[] {
  const found: Finder[] = [];
  for (const trio of combinations(pool, 3)) {
    const mods = trio.map((f) => f.module);
    if (Math.max(...mods) / Math.min(...mods) > 2.6) continue;
    for (let i = 0; i < 3; i++) {
      const a = trio[i], b = trio[(i + 1) % 3], c = trio[(i + 2) % 3];
      const v1 = { x: b.x - a.x, y: b.y - a.y }, v2 = { x: c.x - a.x, y: c.y - a.y };
      const n1 = Math.hypot(v1.x, v1.y), n2 = Math.hypot(v2.x, v2.y);
      if (Math.min(n1, n2) < 6 * Math.min(...mods)) continue;
      if (Math.abs((v1.x * v2.x + v1.y * v2.y) / (n1 * n2)) >= 0.35) continue;
      for (const [o, v, mod] of [[c, v1, c.module], [b, v2, b.module]] as [Finder, Point2D, number][]) {
        if (pool.concat(found).some((f) => !trio.includes(f) && onStrip(f, o.x, o.y, v.x, v.y, mod))) continue;
        found.push(...searchStrip(g, w, h, o.x, o.y, v.x, v.y, mod));
      }
    }
  }
  return found;
}

export type Quad = [Point2D, Point2D, Point2D, Point2D];

function orderClockwise(pts: Point2D[]): Quad {
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  return pts.slice().sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx)) as Quad;
}

function polyArea(p: Point2D[]): number {
  let s = 0;
  for (let i = 0; i < p.length; i++) {
    const a = p[i], b = p[(i + 1) % p.length];
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s) / 2;
}

function* combinations<T>(arr: T[], k: number, start = 0, acc: T[] = []): Generator<T[]> {
  if (acc.length === k) {
    yield acc.slice();
    return;
  }
  for (let i = start; i < arr.length; i++) {
    acc.push(arr[i]);
    yield* combinations(arr, k, i + 1, acc);
    acc.pop();
  }
}

export function candidateQuads(finders: Finder[], limit = 6, twoFinder = true): { pts: Quad; module: number }[] {
  const pool = finders.slice(0, 8);
  const quads: { area: number; pts: Quad; module: number }[] = [];
  for (const combo of combinations(pool, 4)) {
    const mods = combo.map((f) => f.module);
    if (Math.max(...mods) / Math.min(...mods) > 2.6) continue;
    const pts = orderClockwise(combo.map((f) => ({ x: f.x, y: f.y })));
    const sides = pts.map((p, i) => Math.hypot(pts[(i + 1) % 4].x - p.x, pts[(i + 1) % 4].y - p.y));
    if (Math.min(...sides) < 6 * Math.min(...mods) || Math.max(...sides) / Math.min(...sides) > 3) continue;
    quads.push({ area: polyArea(pts), pts, module: mods.reduce((a, b) => a + b) / 4 });
  }
  if (!quads.length) {
    for (const combo of combinations(pool, 3)) {
      const mods = combo.map((f) => f.module);
      if (Math.max(...mods) / Math.min(...mods) > 2.6) continue;
      for (let i = 0; i < 3; i++) {
        const a = combo[i], b = combo[(i + 1) % 3], c = combo[(i + 2) % 3];
        const v1 = { x: b.x - a.x, y: b.y - a.y }, v2 = { x: c.x - a.x, y: c.y - a.y };
        const cos = (v1.x * v2.x + v1.y * v2.y) / (Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y) + 1e-9);
        if (Math.abs(cos) < 0.35) {
          const d = { x: b.x + c.x - a.x, y: b.y + c.y - a.y };
          const pts = orderClockwise([a, b, c, d].map((p) => ({ x: p.x, y: p.y })));
          quads.push({ area: polyArea(pts), pts, module: mods.reduce((s, m) => s + m) / 3 });
        }
      }
    }
  }
  quads.sort((p, q) => q.area - p.area);
  // Two-finder hypotheses always follow: data blobs can masquerade as finders and
  // produce plausible-looking but wrong 4-finder quads, while the two genuine
  // survivors of a scratch still define the symbol. The format word arbitrates.
  const byScore = pool.slice().sort((a, b) => b.score - a.score);
  const result = quads.slice(0, limit).map(({ pts, module }) => ({ pts, module }));
  return twoFinder ? result.concat(twoFinderQuads(byScore)) : result;
}

function twoFinderQuads(pool: Finder[]): { pts: Quad; module: number }[] {
  const out: { pts: Quad; module: number }[] = [];
  for (const [a, b] of combinations(pool.slice(0, 6), 2)) {
    if (Math.max(a.module, b.module) / Math.min(a.module, b.module) > 1.8) continue;
    const mod = (a.module + b.module) / 2;
    if (Math.hypot(b.x - a.x, b.y - a.y) < 8 * mod) continue;
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const hx = (b.x - a.x) / 2, hy = (b.y - a.y) / 2;
    out.push({ pts: orderClockwise([{ x: a.x, y: a.y }, { x: mx - hy, y: my + hx }, { x: b.x, y: b.y }, { x: mx + hy, y: my - hx }]), module: mod });
    const sx = b.x - a.x, sy = b.y - a.y;
    for (const sign of [1, -1]) {
      const px = -sy * sign, py = sx * sign;
      out.push({ pts: orderClockwise([{ x: a.x, y: a.y }, { x: b.x, y: b.y }, { x: b.x + px, y: b.y + py }, { x: a.x + px, y: a.y + py }]), module: mod });
    }
  }
  return out.slice(0, 12);
}

export function estimateN(pts: Quad, module: number): number[] {
  const sides = pts.map((p, i) => Math.hypot(pts[(i + 1) % 4].x - p.x, pts[(i + 1) % 4].y - p.y));
  const est = sides.reduce((a, b) => a + b) / 4 / module + FINDER;
  const tol = Math.max(5, 0.15 * est);
  return gridSizes().filter((n) => Math.abs(n - est) <= tol).sort((a, b) => Math.abs(a - est) - Math.abs(b - est));
}

/** Cell coordinates (x = column, y = row) -> image pixels, through the finder centres. */
export function finderHomography(pts: Quad, n: number): Matrix3x3 | null {
  const h = FINDER / 2;
  return getPerspectiveTransformDstToSrc(
    [{ x: h, y: h }, { x: n - h, y: h }, { x: n - h, y: n - h }, { x: h, y: n - h }], pts);
}

export function outlineHomography(pts: Quad, n: number): Matrix3x3 | null {
  return getPerspectiveTransformDstToSrc([{ x: 0, y: 0 }, { x: n, y: 0 }, { x: n, y: n }, { x: 0, y: n }], pts);
}

function bilinear(img: Image, x: number, y: number, ch: number): number {
  const { data, width: w, height: h } = img;
  const xc = Math.min(Math.max(x, 0), w - 1.001);
  const yc = Math.min(Math.max(y, 0), h - 1.001);
  const x0 = Math.floor(xc), y0 = Math.floor(yc);
  const fx = xc - x0, fy = yc - y0;
  const i00 = (y0 * w + x0) * 4 + ch;
  const i10 = i00 + 4, i01 = i00 + w * 4, i11 = i01 + 4;
  return (data[i00] * (1 - fx) + data[i10] * fx) * (1 - fy) + (data[i01] * (1 - fx) + data[i11] * fx) * fy;
}

function bilinearGray(g: Uint8Array, w: number, h: number, x: number, y: number): number {
  const xc = Math.min(Math.max(x, 0), w - 1.001);
  const yc = Math.min(Math.max(y, 0), h - 1.001);
  const x0 = Math.floor(xc), y0 = Math.floor(yc);
  const fx = xc - x0, fy = yc - y0;
  const i = y0 * w + x0;
  return (g[i] * (1 - fx) + g[i + 1] * fx) * (1 - fy) + (g[i + w] * (1 - fx) + g[i + w + 1] * fx) * fy;
}

/** True for cells in the four 10x10 corner blocks (finders, separators, every format cell). */
export function inCornerBlock(n: number, r: number, c: number, size = 10): boolean {
  return (r < size || r >= n - size) && (c < size || c >= n - size);
}

/**
 * n*n*3 mean colour over a 5x5 sub-sample patch spanning each cell's inner 60%, in [0, 1].
 * With cornersOnly, only the corner blocks are sampled (enough to read the format word),
 * which makes screening a geometry hypothesis cheap.
 */
export function sampleGrid(img: Image, H: Matrix3x3, n: number, cornersOnly = false, spread = 0.3, taps = 5): Float64Array {
  const offs = Array.from({ length: taps }, (_, i) => (taps === 1 ? 0 : -spread + (2 * spread * i) / (taps - 1)));
  const T = taps * taps;
  const out = new Float64Array(n * n * 3);
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++) {
      if (cornersOnly && !inCornerBlock(n, r, c)) continue;
      let s0 = 0, s1 = 0, s2 = 0;
      for (const dy of offs)
        for (const dx of offs) {
          const p = mapPoint(H, c + 0.5 + dx, r + 0.5 + dy);
          s0 += bilinear(img, p.x, p.y, 0);
          s1 += bilinear(img, p.x, p.y, 1);
          s2 += bilinear(img, p.x, p.y, 2);
        }
      const k = (r * n + c) * 3;
      out[k] = s0 / T / 255;
      out[k + 1] = s1 / T / 255;
      out[k + 2] = s2 / T / 255;
    }
  return out;
}

const CORNER_PATTERN: number[] = (() => {
  const p: number[] = [];
  for (let i = 0; i < 8; i++)
    for (let j = 0; j < 8; j++) {
      if (i >= FINDER || j >= FINDER) p.push(0);
      else {
        const ring = i === 0 || j === 0 || i === FINDER - 1 || j === FINDER - 1;
        const core = i >= 2 && i <= 4 && j >= 2 && j <= 4;
        p.push(ring || core ? 1 : 0);
      }
    }
  const mean = p.reduce((a, b) => a + b) / p.length;
  return p.map((v) => v - mean);
})();

/** Finder-template refinement of the four finder centres (see detect.py). */
export function refineCorners(gray: Uint8Array, w: number, h: number, H: Matrix3x3, n: number): { H: Matrix3x3 | null; corr: number } {
  const half = FINDER / 2;
  const patNorm = Math.hypot(...CORNER_PATTERN);
  const src: Point2D[] = [];
  const dst: Point2D[] = [];
  let corrSum = 0;
  const vals = new Float64Array(64);
  for (let corner = 0; corner < 4; corner++) {
    let best = { c: -2, du: 0, dv: 0 };
    for (let du = -0.75; du <= 0.751; du += 0.25)
      for (let dv = -0.75; dv <= 0.751; dv += 0.25) {
        let mean = 0;
        for (let i = 0; i < 8; i++)
          for (let j = 0; j < 8; j++) {
            const row = corner === 0 || corner === 1 ? i : n - 1 - i;
            const col = corner === 0 || corner === 3 ? j : n - 1 - j;
            const p = mapPoint(H, col + 0.5 + du, row + 0.5 + dv);
            const v = bilinearGray(gray, w, h, p.x, p.y);
            vals[i * 8 + j] = v;
            mean += v;
          }
        mean /= 64;
        let dot = 0, norm = 0;
        for (let t = 0; t < 64; t++) {
          const v = -(vals[t] - mean);
          dot += v * CORNER_PATTERN[t];
          norm += v * v;
        }
        const c = norm > 0 ? dot / (Math.sqrt(norm) * patNorm) : -1;
        if (c > best.c) best = { c, du, dv };
      }
    corrSum += best.c;
    const fc = corner === 0 || corner === 3 ? half : n - half;
    const fr = corner === 0 || corner === 1 ? half : n - half;
    src.push({ x: fc, y: fr });
    dst.push(mapPoint(H, fc + best.du, fr + best.dv));
  }
  return { H: getPerspectiveTransformDstToSrc(src as Quad, dst as Quad), corr: corrSum / 4 };
}

// ── Finder-free localisation from the symbol outline ─────────────────────────

function otsu(hist: Float64Array, total: number): number {
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, thr = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) {
      best = between;
      thr = t;
    }
  }
  return thr;
}

function closeMask(mask: Uint8Array, w: number, h: number, k: number): Uint8Array {
  const boxCount = (m: Uint8Array, r: number): Float64Array => {
    const S = new Float64Array((w + 1) * (h + 1));
    for (let y = 0; y < h; y++) {
      let row = 0;
      for (let x = 0; x < w; x++) {
        row += m[y * w + x];
        S[(y + 1) * (w + 1) + x + 1] = S[y * (w + 1) + x + 1] + row;
      }
    }
    const out = new Float64Array(w * h);
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
        out[y * w + x] = S[y1 * (w + 1) + x1] - S[y0 * (w + 1) + x1] - S[y1 * (w + 1) + x0] + S[y0 * (w + 1) + x0];
      }
    }
    return out;
  };
  const r = Math.max(1, Math.floor(k / 2));
  const dil = boxCount(mask, r);
  const d = new Uint8Array(w * h);
  for (let i = 0; i < d.length; i++) d[i] = dil[i] > 0 ? 1 : 0;
  const ero = boxCount(d, r);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
      out[y * w + x] = ero[y * w + x] >= (y1 - y0) * (x1 - x0) ? 1 : 0;
    }
  return out;
}

function convexHull(points: Point2D[]): Point2D[] {
  const pts = points.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  if (pts.length < 3) return pts;
  const cross = (o: Point2D, a: Point2D, b: Point2D) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Point2D[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Point2D[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/** Minimum-area enclosing rectangle of a convex hull (rotating edges). */
function minAreaRect(hull: Point2D[]): { corners: Quad; ux: Point2D; uy: Point2D; c: Point2D; w: number; h: number } | null {
  let best: { area: number; corners: Quad; ux: Point2D; uy: Point2D; c: Point2D; w: number; h: number } | null = null;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 1e-9) continue;
    const ux = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
    const uy = { x: -ux.y, y: ux.x };
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const p of hull) {
      const u = p.x * ux.x + p.y * ux.y, v = p.x * uy.x + p.y * uy.y;
      minU = Math.min(minU, u); maxU = Math.max(maxU, u);
      minV = Math.min(minV, v); maxV = Math.max(maxV, v);
    }
    const area = (maxU - minU) * (maxV - minV);
    if (!best || area < best.area) {
      const at = (u: number, v: number): Point2D => ({ x: u * ux.x + v * uy.x, y: u * ux.y + v * uy.y });
      const corners = orderClockwise([at(minU, minV), at(maxU, minV), at(maxU, maxV), at(minU, maxV)]);
      best = { area, corners, ux, uy, c: at((minU + maxU) / 2, (minV + maxV) / 2), w: maxU - minU, h: maxV - minV };
    }
  }
  return best;
}

export function outlineQuads(img: Image, limit = 3): Quad[] {
  const { data, width: w, height: h } = img;
  const minCh = new Uint8Array(w * h);
  const hist = new Float64Array(256);
  for (let i = 0, j = 0; i < minCh.length; i++, j += 4) {
    const v = Math.min(data[j], data[j + 1], data[j + 2]);
    minCh[i] = v;
    hist[v]++;
  }
  const thr = otsu(hist, w * h);
  const ink = new Uint8Array(w * h);
  for (let i = 0; i < ink.length; i++) ink[i] = minCh[i] <= thr ? 1 : 0;
  const closed = closeMask(ink, w, h, Math.max(3, Math.round(Math.min(w, h) / 60)));

  // Connected components (4-connected) by iterative flood fill.
  const label = new Int32Array(w * h);
  const comps: { id: number; size: number }[] = [];
  const stack = new Int32Array(w * h);
  let next = 1;
  for (let start = 0; start < w * h; start++) {
    if (!closed[start] || label[start]) continue;
    let sp = 0;
    stack[sp++] = start;
    label[start] = next;
    let size = 0;
    while (sp) {
      const p = stack[--sp];
      size++;
      const x = p % w, y = (p - x) / w;
      if (x > 0 && closed[p - 1] && !label[p - 1]) { label[p - 1] = next; stack[sp++] = p - 1; }
      if (x < w - 1 && closed[p + 1] && !label[p + 1]) { label[p + 1] = next; stack[sp++] = p + 1; }
      if (y > 0 && closed[p - w] && !label[p - w]) { label[p - w] = next; stack[sp++] = p - w; }
      if (y < h - 1 && closed[p + w] && !label[p + w]) { label[p + w] = next; stack[sp++] = p + w; }
    }
    comps.push({ id: next, size });
    next++;
  }
  comps.sort((a, b) => b.size - a.size);
  const out: Quad[] = [];
  for (const comp of comps.slice(0, limit)) {
    if (comp.size < 0.01 * w * h) break;
    // Hull from each row's leftmost and rightmost pixels.
    const edge: Point2D[] = [];
    for (let y = 0; y < h; y++) {
      let lo = -1, hi = -1;
      for (let x = 0; x < w; x++) if (label[y * w + x] === comp.id) { if (lo < 0) lo = x; hi = x; }
      if (lo >= 0) edge.push({ x: lo, y }, { x: hi + 1, y }, { x: lo, y: y + 1 }, { x: hi + 1, y: y + 1 });
    }
    const hull = convexHull(edge);
    const rect = minAreaRect(hull);
    if (!rect) continue;
    // Quad from the hull points nearest to each rectangle corner (follows perspective).
    const nearest = rect.corners.map((c) => hull.reduce((b, p) => (Math.hypot(p.x - c.x, p.y - c.y) < Math.hypot(b.x - c.x, b.y - c.y) ? p : b)));
    out.push(orderClockwise(nearest));
    const trimmed = densityTrimmed(closed, w, h, rect);
    if (trimmed) out.push(trimmed);
  }
  return out;
}

function densityTrimmed(mask: Uint8Array, w: number, h: number,
  rect: { ux: Point2D; uy: Point2D; c: Point2D; w: number; h: number }): Quad | null {
  const S = 96;
  if (rect.w < 8 || rect.h < 8) return null;
  const rows = new Float64Array(S), cols = new Float64Array(S);
  const at = (i: number, j: number): Point2D => {
    const u = ((j + 0.5) / S - 0.5) * rect.w, v = ((i + 0.5) / S - 0.5) * rect.h;
    return { x: rect.c.x + u * rect.ux.x + v * rect.uy.x, y: rect.c.y + u * rect.ux.y + v * rect.uy.y };
  };
  for (let i = 0; i < S; i++)
    for (let j = 0; j < S; j++) {
      const p = at(i, j);
      const x = Math.round(p.x), y = Math.round(p.y);
      const v = x >= 0 && x < w && y >= 0 && y < h ? mask[y * w + x] : 0;
      rows[i] += v / S;
      cols[j] += v / S;
    }
  const trim = (prof: Float64Array): [number, number] => {
    const mid = Array.from(prof.subarray(S / 4, (3 * S) / 4)).sort((a, b) => a - b);
    const thr = 0.5 * mid[mid.length >> 1];
    let lo = 0, hi = S - 1;
    while (lo < S && prof[lo] < thr) lo++;
    while (hi > lo && prof[hi] < thr) hi--;
    return [lo, hi + 1];
  };
  const [r0, r1] = trim(rows);
  const [c0, c1] = trim(cols);
  const corner = (i: number, j: number) => at(i - 0.5, j - 0.5);
  return orderClockwise([corner(r0, c0), corner(r0, c1), corner(r1, c1), corner(r1, c0)]);
}

