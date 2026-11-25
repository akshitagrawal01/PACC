/**
 * Live scanning from a distance: a PACC symbol (4 colours, rate 1/2, 79 bytes) shown at a
 * decreasing size in a 1920x1080 camera frame, with mild defocus and sensor noise, aimed
 * roughly at the centre of the view.
 *
 * "old": every frame shrunk to 640 px (the live scanner before the crop passes).
 * "new": the pass schedule of lib/scanRoi.ts (full view, then full-resolution crops).
 * Each scanner gets the same number of frames, each frame with fresh noise. "decode ms to read" is
 * the decode time summed over the frames until the symbol was read (the worker decodes one frame
 * at a time, so this is the scanning delay on this machine; phones are slower).
 *
 *   npx jiti scripts/pacc_distance.ts
 */
import { decodeImage, encodeToImageData } from "../src/lib/pacc";
import { canvasScale, planScan, plausibleLocate, toVideoRect, type Rect, type ScanPlan } from "../src/lib/scanRoi";

const W = 1920, H = 1080, FRAMES = 6, TRIALS = 12;
const MODULE_PX = [1.5, 2, 2.5, 3, 4, 6, 12];

let seed = 12345;
const rand = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());

const payload = new Uint8Array(79).map((_, i) => (i * 37 + 11) & 255);
const sym = encodeToImageData(payload, { mcs: 1, level: "Q", cellSize: 1 });
const S = sym.imageData.width; // modules incl. quiet zone

type Img = { data: Uint8ClampedArray; width: number; height: number };

/** The scene: the symbol of `m` px per module at (ox, oy) on a lit grey desk, 3x3 supersampled, softly blurred. */
function scene(m: number, ox: number, oy: number): Float32Array {
  const out = new Float32Array(W * H * 3);
  const src = sym.imageData.data;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const bg = 150 + 40 * (x / W) - 20 * (y / H);
      for (let c = 0; c < 3; c++) {
        let acc = 0;
        for (let sy = 0; sy < 3; sy++)
          for (let sx = 0; sx < 3; sx++) {
            const u = (x + (sx + 0.5) / 3 - ox) / m, v = (y + (sy + 0.5) / 3 - oy) / m;
            acc += u >= 0 && v >= 0 && u < S && v < S ? src[(Math.floor(v) * S + Math.floor(u)) * 4 + c] * 0.85 + 10 : bg;
          }
        out[(y * W + x) * 3 + c] = acc / 9;
      }
    }
  // defocus: one 3x3 box pass
  const blur = new Float32Array(out.length);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      for (let c = 0; c < 3; c++) {
        let a = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx, yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
            a += out[(yy * W + xx) * 3 + c] * (dx === 0 && dy === 0 ? 4 : 1);
            n += dx === 0 && dy === 0 ? 4 : 1;
          }
        blur[(y * W + x) * 3 + c] = a / n;
      }
  return blur;
}

/** One camera frame: the scene with fresh sensor noise (sigma 6 of 255). */
function frame(sc: Float32Array): Float32Array {
  const f = new Float32Array(sc.length);
  for (let i = 0; i < sc.length; i++) f[i] = sc[i] + 6 * gauss();
  return f;
}

/** Draw `src` of the frame into a w x h image by area averaging (as a browser canvas downscale, at best). */
function draw(f: Float32Array, src: Rect, w: number, h: number): Img {
  const data = new Uint8ClampedArray(w * h * 4);
  const sx = src.w / w, sy = src.h / h;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(src.x + x * sx), x1 = Math.max(x0 + 1, Math.floor(src.x + (x + 1) * sx));
      const y0 = Math.floor(src.y + y * sy), y1 = Math.max(y0 + 1, Math.floor(src.y + (y + 1) * sy));
      for (let c = 0; c < 3; c++) {
        let a = 0, n = 0;
        for (let yy = y0; yy < Math.min(y1, H); yy++)
          for (let xx = x0; xx < Math.min(x1, W); xx++) {
            a += f[(yy * W + xx) * 3 + c];
            n++;
          }
        data[(y * w + x) * 4 + c] = a / Math.max(1, n);
      }
      data[(y * w + x) * 4 + 3] = 255;
    }
  return { data, width: w, height: h };
}

const same = (r: { ok: boolean; payload?: Uint8Array }) =>
  r.ok && !!r.payload && r.payload.length === payload.length && r.payload.every((b, i) => b === payload[i]);

const view: Rect = { x: 0, y: 0, w: W, h: H };
console.log(`symbol ${S - 8} modules (+ quiet zone), ${FRAMES} frames per trial, ${TRIALS} trials per size`);
console.log("px/module  symbol width  old (640 px)  new (crop passes)  new: decode ms to read (median)");
for (const m of MODULE_PX) {
  let oldOk = 0, newOk = 0;
  const times: number[] = [];
  for (let t = 0; t < TRIALS; t++) {
    const side = S * m;
    const ox = (W - side) / 2 + (rand() - 0.5) * 0.3 * W, oy = (H - side) / 2 + (rand() - 0.5) * 0.3 * H;
    const sc = scene(m, ox, oy);
    // old scanner
    let ok = false;
    for (let k = 0; k < FRAMES && !ok; k++) ok = same(decodeImage(draw(frame(sc), view, 640, 360), { live: true }));
    oldOk += ok ? 1 : 0;
    // new scanner
    ok = false;
    let located: Rect | null = null;
    let spent = 0;
    for (let k = 0; k < FRAMES && !ok; k++) {
      const plan: ScanPlan = planScan(k, view, located);
      const r = decodeImage(draw(frame(sc), plan.src, plan.width, plan.height), { live: true });
      ok = same(r);
      spent += r.durationMs;
      if (!ok && r.locate) {
        const rect = toVideoRect(plan, r.locate);
        if (plausibleLocate(rect, r.locate.module / canvasScale(plan))) located = rect;
      }
    }
    newOk += ok ? 1 : 0;
    if (ok) times.push(spent);
  }
  const pct = (k: number) => `${Math.round((100 * k) / TRIALS)} %`.padStart(5);
  times.sort((a, b) => a - b);
  const med = times.length ? `${times[Math.floor(times.length / 2)]} ms` : "-";
  console.log(`${String(m).padStart(9)}  ${String(Math.round(S * m)).padStart(9)} px  ${pct(oldOk).padStart(12)}  ${pct(newOk).padStart(17)}  ${med.padStart(14)}`);
}
