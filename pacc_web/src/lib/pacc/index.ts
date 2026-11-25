/**
 * PACC web codec (research prototype) — native, dependency-light TypeScript.
 *
 *   const { imageData, meta } = encodeToImageData(bytes, { level: "Q", mcs: 1, cellSize: 8 });
 *   const result = decodeImage(imageData);
 */
import type { Matrix3x3 } from "./homography";
import {
  capacity, decodeGrid, encodeGrid, encodeGridAsync, readFormat, unlock,
  type DecodeGridOptions, type DecodeResult, type EncodeOptions, type EncodeResult,
} from "./codec";
import { FrameCombiner } from "./combine";
import {
  candidateQuads, completeFinders, estimateN, findFinders, finderHomography, outlineHomography, outlineQuads, refineCorners,
  sampleGrid, toGray, type Image,
} from "./detect";
import { decodeFine } from "./hier";
import { FLAG_LAYERED, QUIET_ZONE, gridSizes } from "./spec";

export { capacity, decodeGrid, encodeGrid, encodeGridAsync, FrameCombiner, unlock };
export type { DecodeResult, EncodeOptions, EncodeResult };

// Format-word gate before a full decode. Measured: genuine (even heavily damaged)
// PACC symbols score >= 0.69 with margin >= 0.34; Prototype 22 and QR images score ~0.5
// with margin <= 0.07.
const FORMAT_GATE = 0.6;
const FORMAT_MARGIN_GATE = 0.2;
// Finder-free fallback only: with corners torn away a single surviving format copy
// cannot clear the joint gate, so there the CRC has the final say.
const LOOSE_FORMAT_GATE = 0.4;
const SMALL_MODULE_PX = 3;
// Live camera frames only. On simulated distant scans and on the distorted test images, every
// symbol read through its finders was read by the first or second hypothesis, whose corner
// blocks matched the finder template with correlation >= 0.99; most hypotheses built from
// spurious finders (sensor noise, texture) match below 0.3. Skipping those before the format
// search, and capping hypotheses per frame, keeps an empty or cluttered frame cheap, so the
// next frame (a few ms later) gets its turn sooner. Still images keep the exhaustive search.
const LIVE_CORNER_GATE = 0.3;
const LIVE_MAX_HYPOTHESES = 10;

/** Where a symbol was seen but not read: bounding box of the best finder quad and its module size (image px). */
export interface LocateHint {
  x: number;
  y: number;
  w: number;
  h: number;
  module: number;
}

export interface ImageDecodeResult extends DecodeResult {
  durationMs: number;
  geometry?: "finders" | "outline";
  /** Set on failure when finder patterns were found, so a live scanner can crop or zoom towards them. */
  locate?: LocateHint;
}

export function renderGrid(grid: Uint8Array, n: number, cellSize = 8, quietZone = QUIET_ZONE): ImageData | { data: Uint8ClampedArray; width: number; height: number } {
  const side = (n + 2 * quietZone) * cellSize;
  const data = new Uint8ClampedArray(side * side * 4).fill(255);
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++) {
      const k = (r * n + c) * 3;
      for (let y = 0; y < cellSize; y++)
        for (let x = 0; x < cellSize; x++) {
          const py = (r + quietZone) * cellSize + y, px = (c + quietZone) * cellSize + x;
          const o = (py * side + px) * 4;
          data[o] = grid[k];
          data[o + 1] = grid[k + 1];
          data[o + 2] = grid[k + 2];
        }
    }
  return typeof ImageData !== "undefined" ? new ImageData(data, side, side) : { data, width: side, height: side };
}

export function encodeToImageData(data: Uint8Array, opts: EncodeOptions & { cellSize?: number } = {}) {
  const meta = encodeGrid(data, opts);
  return { imageData: renderGrid(meta.grid, meta.n, opts.cellSize ?? 8), meta };
}

export async function encodeToImageDataAsync(data: Uint8Array, opts: EncodeOptions & { cellSize?: number } = {}) {
  const meta = await encodeGridAsync(data, opts);
  return { imageData: renderGrid(meta.grid, meta.n, opts.cellSize ?? 8), meta };
}

function tryGeometry(
  img: Image, gray: Uint8Array, H: Matrix3x3 | null, n: number, loose: boolean, gopts: DecodeGridOptions, live = false,
): DecodeResult | null {
  if (!H) return null;
  const ref = refineCorners(gray, img.width, img.height, H, n);
  if (live && ref.corr < LIVE_CORNER_GATE) return null;
  let best: DecodeResult | null = null;
  for (const h of ref.corr > 0.3 && ref.H ? [ref.H, H] : [H]) {
    // Cheap screen: sample only the corner blocks and read the format word.
    const fr = readFormat(sampleGrid(img, h, n, true), n);
    if (loose ? fr.score < LOOSE_FORMAT_GATE : fr.score < FORMAT_GATE || fr.margin < FORMAT_MARGIN_GATE) continue;
    const res = decodeGrid(sampleGrid(img, h, n), n, gopts);
    if (res.ok) {
      // Distance-adaptive symbol: also try the fine chroma layer through this geometry.
      if (res.flags !== undefined && res.flags & FLAG_LAYERED) res.fine = decodeFine(img, h, res, gopts.secrets);
      return res;
    }
    best = best ?? res;
  }
  return best;
}

export interface DecodeImageOptions extends DecodeGridOptions {
  /** Live camera frames: skip the finder-free outline search and the 2x upscale retry,
   *  which are expensive on frames that contain no symbol. */
  live?: boolean;
}

function decodeAt(img: Image, live: boolean, gopts: DecodeGridOptions): { res: DecodeResult; minModule: number; locate?: LocateHint } {
  const gray = toGray(img);
  // Live frames try the finders found directly first and run the (costly) missing-finder search
  // only if they do not yield a symbol; still images search for missing finders up front.
  let finders = findFinders(img, gray, !live);
  let last: DecodeResult = {
    ok: false, formatScore: 0, formatMargin: 0, transform: 0, refineRounds: 0, ldpcIterations: 0,
    error: `no plausible symbol geometry (${finders.length} finder candidates)`,
  };
  const tried = new Set<string>();
  let budget = Infinity; // hypotheses left in this round (live frames only)
  const attempt = (key: number, hFor: (n: number) => Matrix3x3 | null, queue: number[], loose = false): DecodeResult | null => {
    while (queue.length) {
      if (budget <= 0) return null;
      const n = queue.shift()!;
      const id = `${key}:${n}`;
      if (tried.has(id)) continue;
      tried.add(id);
      budget--;
      const res = tryGeometry(img, gray, hFor(n), n, loose, gopts, live);
      if (!res) continue;
      if (res.ok) return res;
      if (res.gridMismatch && !tried.has(`${key}:${res.gridMismatch}`) && res.formatMargin > 0.15) queue.unshift(res.gridMismatch);
      last = res;
    }
    return null;
  };
  let locate: LocateHint | undefined;
  const fromFinders = (round: number): DecodeResult | null => {
    if (finders.length < 2) return null;
    budget = live ? LIVE_MAX_HYPOTHESES : Infinity;
    const quads = candidateQuads(finders, 6, !live);
    if (quads.length && !locate) {
      const xs = quads[0].pts.map((p) => p.x), ys = quads[0].pts.map((p) => p.y);
      const x = Math.min(...xs), y = Math.min(...ys);
      locate = { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y, module: quads[0].module };
    }
    for (let qi = 0; qi < quads.length; qi++) {
      const { pts, module } = quads[qi];
      // Geometry keys stay distinct per round; a quad repeated in round 2 is re-tried with the
      // finders recovered alongside it, which is rare and bounded by the budget.
      const hit = attempt(round * 100 + qi, (n) => finderHomography(pts, n), estimateN(pts, module));
      if (hit) return hit;
    }
    return null;
  };
  const minModule = () => Math.min(...finders.map((f) => f.module));
  let hit = fromFinders(0);
  if (!hit && live) {
    const completed = completeFinders(gray, img.width, img.height, finders);
    if (completed.length > finders.length) {
      finders = completed;
      hit = fromFinders(1);
    }
  }
  if (hit) return { res: hit, minModule: minModule() };
  const outlines = live ? [] : outlineQuads(img);
  for (let oi = 0; oi < outlines.length; oi++) {
    const pts = outlines[oi];
    const hit = attempt(1000 + oi, (n) => outlineHomography(pts, n), gridSizes(), true);
    if (hit) return { res: hit, minModule: 0 };
  }
  return { res: last, minModule: finders.length ? Math.min(...finders.map((f) => f.module)) : 0, locate };
}

function upscale2x(img: Image): Image {
  const { data, width: w, height: h } = img;
  const W = w * 2, H = h * 2;
  const out = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const sx = Math.min(w - 1.001, Math.max(0, (x + 0.5) / 2 - 0.5));
      const sy = Math.min(h - 1.001, Math.max(0, (y + 0.5) / 2 - 0.5));
      const x0 = Math.floor(sx), y0 = Math.floor(sy), fx = sx - x0, fy = sy - y0;
      for (let ch = 0; ch < 4; ch++) {
        const i = (y0 * w + x0) * 4 + ch;
        out[(y * W + x) * 4 + ch] =
          (data[i] * (1 - fx) + data[i + 4] * fx) * (1 - fy) + (data[i + w * 4] * (1 - fx) + data[i + w * 4 + 4] * fx) * fy;
      }
    }
  return { data: out, width: W, height: H };
}

/** Locate and decode a PACC symbol in RGBA image data. */
export function decodeImage(img: Image, opts: DecodeImageOptions = {}): ImageDecodeResult {
  const t0 = performance.now();
  const gopts: DecodeGridOptions = { secrets: opts.secrets, combiner: opts.combiner };
  const first = decodeAt(img, Boolean(opts.live), gopts);
  let res = first.res;
  if (!opts.live && !res.ok && (first.minModule === 0 || first.minModule < SMALL_MODULE_PX) && Math.max(img.width, img.height) < 2000) {
    const up = decodeAt(upscale2x(img), false, gopts).res;
    if (up.ok) res = up;
  }
  opts.combiner?.endFrame(res.ok);
  const locate = res.ok ? undefined : first.locate;
  return { ...res, durationMs: Math.round(performance.now() - t0), ...(locate ? { locate } : {}) };
}

