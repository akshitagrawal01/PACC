/**
 * Which part of a camera frame a live scanner decodes on each frame.
 *
 * A fast pass over the whole view is shrunk to 640 px, which throws away most of the
 * resolution of a 1080p camera: a distant symbol ends up with 1-2 px per module and
 * cannot be read. Every other frame is therefore a full-resolution crop instead:
 * around the symbol when the decoder has located its finder patterns, otherwise the
 * centre of the view, where the user aims. The crops act as a 2-3x zoom without
 * losing detail, and the full pass still finds symbols anywhere in the view.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type ScanPass = "full" | "located" | "centre-2x" | "centre-3x";

export interface ScanPlan {
  pass: ScanPass;
  /** Source rectangle in video pixels. */
  src: Rect;
  /** Canvas size to draw it at. */
  width: number;
  height: number;
}

const FULL_MAX_DIM = 640;
// Crops are drawn at native resolution up to this size (a 2x centre crop of 1080p fits exactly).
const CROP_MAX_DIM = 960;
// A located symbol is cropped with this margin around its finder centres (the symbol edge lies
// about 3.5 modules beyond them, plus room for hand movement between frames).
const LOCATED_MARGIN = 0.6;
const MIN_CROP = 240;

function centred(view: Rect, factor: number): Rect {
  const w = view.w / factor, h = view.h / factor;
  return { x: view.x + (view.w - w) / 2, y: view.y + (view.h - h) / 2, w, h };
}

function around(view: Rect, r: Rect): Rect {
  const side = Math.max(MIN_CROP, Math.max(r.w, r.h) * (1 + 2 * LOCATED_MARGIN));
  const w = Math.min(view.w, side), h = Math.min(view.h, side);
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
  const x = Math.max(view.x, Math.min(view.x + view.w - w, cx - w / 2));
  const y = Math.max(view.y, Math.min(view.y + view.h - h, cy - h / 2));
  return { x, y, w, h };
}

function sized(pass: ScanPass, src: Rect, maxDim: number): ScanPlan {
  const scale = Math.min(1, maxDim / Math.max(src.w, src.h));
  return { pass, src, width: Math.max(1, Math.round(src.w * scale)), height: Math.max(1, Math.round(src.h * scale)) };
}

/**
 * Whether a located box (finder centres, video px) with this module size (video px) looks like a real
 * symbol worth cropping: 15-150 modules between finder centres, and small enough to crop at native
 * resolution. Shrunk frames of noisy scenes produce spurious finder candidates; this rejects them.
 */
export function plausibleLocate(rect: Rect, module: number): boolean {
  if (!(module > 0)) return false;
  const span = Math.max(rect.w, rect.h) / module;
  const side = Math.max(MIN_CROP, Math.max(rect.w, rect.h) * (1 + 2 * LOCATED_MARGIN));
  return span >= 15 && span <= 150 && side <= CROP_MAX_DIM;
}

/**
 * Plan the pass for frame `frameIdx`.
 *
 * - Even frames: the whole view at 640 px.
 * - Frames 1, 5, 9, …: a full-resolution 2x centre crop.
 * - Frames 3, 7, 11, …: a full-resolution crop around `located` (a symbol seen on a recent frame,
 *   in video pixels, already checked with `plausibleLocate`), or else a 3x centre crop.
 *
 * `view` is the visible part of the video (smaller than the frame under digital zoom).
 */
export function planScan(frameIdx: number, view: Rect, located: Rect | null): ScanPlan {
  if (frameIdx % 2 === 0) return sized("full", view, FULL_MAX_DIM);
  if (frameIdx % 4 === 1) return sized("centre-2x", centred(view, 2), CROP_MAX_DIM);
  if (located) return sized("located", around(view, located), CROP_MAX_DIM);
  return sized("centre-3x", centred(view, 3), CROP_MAX_DIM);
}

/** Map a rectangle from canvas pixels of `plan` back to video pixels. */
export function toVideoRect(plan: ScanPlan, r: Rect): Rect {
  const sx = plan.src.w / plan.width, sy = plan.src.h / plan.height;
  return { x: plan.src.x + r.x * sx, y: plan.src.y + r.y * sy, w: r.w * sx, h: r.h * sy };
}

/** Canvas pixels of `plan` per video pixel (1 for native-resolution crops, < 1 for the shrunk full pass). */
export function canvasScale(plan: ScanPlan): number {
  return plan.width / plan.src.w;
}
