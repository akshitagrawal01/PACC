/**
 * Distance-adaptive layered symbols — twin of pacc/hier.py (design notes there).
 * Coarse layer: a black-and-white PACC symbol with FLAG_LAYERED. Fine layer: every
 * coarse cell split into SUB x SUB sub-cells whose warm/cool tint (luminance kept)
 * carries a rate-1/2 LDPC codeword; sub-cells of non-data coarse cells are pilots.
 */
import { getPerspectiveTransformDstToSrc, mapPoint, type Matrix3x3, type Point2D } from "./homography";
import { encodeGrid, type DecodeResult, type EncodeResult } from "./codec";
import { sampleGrid, type Image } from "./detect";
import { applyEqualizer, constellation, fitEqualizer } from "./equalize";
import { dihedral, dihedralSource } from "./fmt";
import { buildMessage, interleaver, messageToInfoBits, parseInfoBits } from "./framing";
import { buildLayout } from "./layout";
import { buildCode, ldpcDecode, ldpcEncode } from "./ldpc";
import { LLR_CAP, symbolLoglik } from "./modem";
import {
  openMessage, openMessageAsync, seal, sealAsync, type OpenResult, type SealOptions, type Secrets,
} from "./secure";
import { FLAG_LAYERED, MESSAGE_OVERHEAD, levelByName } from "./spec";

export const SUB = 2;
const PILOT_WEIGHT = 2.0;
const REFINE_ROUNDS = 1;
const REFINE_CONFIDENCE = 0.95;
/** Sub-cell colours (index = 2 * dark + warm): stronger tints than QR-compatible mode (qc.ts). */
export const QC_RGB: readonly (readonly [number, number, number])[] = [
  [150, 228, 255], [255, 226, 140], [0, 34, 150], [150, 0, 34],
];
const QC_PAL = Float64Array.from(QC_RGB.flat(), (v) => v / 255);

export interface FineLayout {
  n: number;
  nf: number;
  dark: Uint8Array;        // nf*nf
  pilot: Uint8Array;       // nf*nf
  dataCells: Int32Array;   // fine flat indices, row-major
}

/** Fine-layer layout for a canonically oriented coarse grid (n*n*3 RGB). */
export function fineLayout(coarseGrid: Uint8Array, n: number): FineLayout {
  const lay = buildLayout(n);
  const isData = new Uint8Array(n * n);
  for (const i of lay.dataCells) isData[i] = 1;
  const nf = n * SUB;
  const dark = new Uint8Array(nf * nf);
  const pilot = new Uint8Array(nf * nf);
  const data: number[] = [];
  for (let r = 0; r < nf; r++)
    for (let c = 0; c < nf; c++) {
      const p = Math.floor(r / SUB) * n + Math.floor(c / SUB);
      const k = r * nf + c;
      dark[k] = (coarseGrid[p * 3] + coarseGrid[p * 3 + 1] + coarseGrid[p * 3 + 2]) / 3 < 128 ? 1 : 0;
      if (isData[p]) data.push(k);
      else pilot[k] = 1;
    }
  return { n, nf, dark, pilot, dataCells: Int32Array.from(data) };
}

export function fineCodeParams(fl: FineLayout): [number, number] {
  const nBits = fl.dataCells.length;
  return [nBits, Math.floor(Math.floor(nBits / 2) / 8) * 8];
}

export function fineCapacity(n: number): number {
  const nBits = buildLayout(n).dataCells.length * SUB * SUB;
  return Math.max(0, Math.floor(Math.floor(nBits / 2) / 8) - MESSAGE_OVERHEAD);
}

const pilotWarm = (r: number, c: number) => (r + c) % 2 === 1;

// ── Encoding ──────────────────────────────────────────────────────────────────

export interface LayeredEncodeResult {
  grid: Uint8Array;        // nf*nf*3 printed sub-cell colours
  coarse: EncodeResult;
  n: number;
  nf: number;
  fineCapacity: number;
}

export interface LayeredEncodeOptions {
  level?: number | string;
  compress?: boolean;
  coarseSecurity?: SealOptions;
  fineSecurity?: SealOptions;
  minGrid?: number;
}

function buildLayered(
  coarseSealed: { flags: number; body: Uint8Array }, fineSealed: { flags: number; body: Uint8Array }, opts: LayeredEncodeOptions,
): LayeredEncodeResult {
  const level = typeof opts.level === "string" ? levelByName(opts.level) : opts.level ?? 3;
  const message = buildMessage(fineSealed.body, fineSealed.flags);
  let size = opts.minGrid;
  for (;;) {
    const coarse = encodeGrid(new Uint8Array(0), { mcs: 0, level, minGrid: size, sealed: coarseSealed });
    const fl = fineLayout(coarse.grid, coarse.n);
    const [nBits, k] = fineCodeParams(fl);
    if (k >= 8 * message.length) {
      const cw = ldpcEncode(buildCode(nBits, k), messageToInfoBits(message, k));
      const perm = interleaver(nBits);
      const warm = new Uint8Array(fl.nf * fl.nf);
      for (let i = 0; i < warm.length; i++) if (fl.pilot[i]) warm[i] = pilotWarm(Math.floor(i / fl.nf), i % fl.nf) ? 1 : 0;
      fl.dataCells.forEach((cell, j) => (warm[cell] = cw[perm[j]]));
      const grid = new Uint8Array(fl.nf * fl.nf * 3);
      for (let i = 0; i < warm.length; i++) grid.set(QC_RGB[2 * fl.dark[i] + warm[i]], i * 3);
      return { grid, coarse, n: fl.n, nf: fl.nf, fineCapacity: k / 8 - MESSAGE_OVERHEAD };
    }
    if (coarse.n >= 148) throw new Error("fine message too large for any layered symbol");
    size = coarse.n + 4;
  }
}

export function encodeLayered(coarse: Uint8Array, fine: Uint8Array, opts: LayeredEncodeOptions = {}): LayeredEncodeResult {
  const compress = opts.compress ?? true;
  return buildLayered(seal(coarse, compress, opts.coarseSecurity, FLAG_LAYERED), seal(fine, compress, opts.fineSecurity), opts);
}

/** encodeLayered with password-encryption support (Argon2id is asynchronous). */
export async function encodeLayeredAsync(coarse: Uint8Array, fine: Uint8Array, opts: LayeredEncodeOptions = {}) {
  const compress = opts.compress ?? true;
  return buildLayered(
    await sealAsync(coarse, compress, opts.coarseSecurity, FLAG_LAYERED), await sealAsync(fine, compress, opts.fineSecurity), opts);
}

// ── Decoding the fine layer ───────────────────────────────────────────────────

export interface FineResult {
  ok: boolean;
  payload?: Uint8Array;
  security?: OpenResult;
  locked?: "password" | "recipient";
  flags?: number;
  body?: Uint8Array;
  error?: string;
}

type Quad = [Point2D, Point2D, Point2D, Point2D];

const quadH = (q: Quad, nf: number) =>
  getPerspectiveTransformDstToSrc([{ x: 0, y: 0 }, { x: nf, y: 0 }, { x: nf, y: nf }, { x: 0, y: nf }], q);

function bilinear(img: Image, x: number, y: number, ch: number): number {
  const { data, width: w, height: h } = img;
  const xc = Math.min(Math.max(x, 0), w - 1.001);
  const yc = Math.min(Math.max(y, 0), h - 1.001);
  const x0 = Math.floor(xc), y0 = Math.floor(yc);
  const fx = xc - x0, fy = yc - y0;
  const i = (y0 * w + x0) * 4 + ch;
  return (data[i] * (1 - fx) + data[i + 4] * fx) * (1 - fy) + (data[i + w * 4] * (1 - fx) + data[i + w * 4 + 4] * fx) * fy;
}

/** Sampled-orientation centres of the canonical cells selected by `keep`, with targets. */
function sampledPoints(nf: number, transform: number, keep: (r: number, c: number) => boolean, target: (r: number, c: number) => number) {
  const pts: number[] = [];
  const tgt: number[] = [];
  for (let r = 0; r < nf; r++)
    for (let c = 0; c < nf; c++) {
      if (!keep(r, c)) continue;
      const [sr, sc] = dihedralSource(nf, transform, r, c);
      pts.push(sc + 0.5, sr + 0.5);
      tgt.push(target(r, c));
    }
  return { pts: Float64Array.from(pts), tgt: Float64Array.from(tgt) };
}

function score(img: Image, q: Quad, nf: number, pts: Float64Array, tgt: Float64Array, chroma: boolean): number {
  const H = quadH(q, nf);
  if (!H) return -Infinity;
  const m = tgt.length;
  const v = new Float64Array(m);
  let mean = 0;
  for (let i = 0; i < m; i++) {
    const p = mapPoint(H, pts[2 * i], pts[2 * i + 1]);
    v[i] = chroma
      ? bilinear(img, p.x, p.y, 0) - bilinear(img, p.x, p.y, 2)
      : 0.299 * bilinear(img, p.x, p.y, 0) + 0.587 * bilinear(img, p.x, p.y, 1) + 0.114 * bilinear(img, p.x, p.y, 2);
    mean += v[i];
  }
  mean /= m;
  let dot = 0, ss = 0;
  for (let i = 0; i < m; i++) {
    const d = v[i] - mean;
    dot += d * tgt[i];
    ss += d * d;
  }
  return dot / m / (Math.sqrt(ss / m) + 1e-6);
}

function search(img: Image, quad: Quad, nf: number, pts: Float64Array, tgt: Float64Array, chroma: boolean, step: number, levels: number): Quad {
  let q = quad;
  let best = score(img, q, nf, pts, tgt, chroma);
  for (let lv = 0; lv < levels; lv++) {
    for (let sweep = 0; sweep < 4; sweep++) {
      let improved = false;
      for (let i = 0; i < 4; i++) {
        const base = { ...q[i] };
        for (const dy of [-1, 0, 1])
          for (const dx of [-1, 0, 1]) {
            if (!dx && !dy) continue;
            const trial = q.map((p) => ({ ...p })) as Quad;
            trial[i] = { x: base.x + step * dx, y: base.y + step * dy };
            const s = score(img, trial, nf, pts, tgt, chroma);
            if (s > best + 1e-9) {
              best = s;
              q = trial;
              improved = true;
            }
          }
      }
      if (!improved) break;
    }
    step /= 2;
  }
  return q;
}

/** Fine registration: align the known coarse luminance, then the pilot chroma checkerboard. */
export function refineFine(img: Image, H: Matrix3x3, fl: FineLayout, transform: number): Matrix3x3 | null {
  const { n, nf } = fl;
  let quad = [mapPoint(H, 0, 0), mapPoint(H, n, 0), mapPoint(H, n, n), mapPoint(H, 0, n)] as Quad;
  const side = quad.reduce((s, p, i) => s + Math.hypot(p.x - quad[(i + 1) % 4].x, p.y - quad[(i + 1) % 4].y), 0) / 4;
  const sub = side / nf;
  const lum = sampledPoints(nf, transform, (r) => r % 2 === 0, (r, c) => (fl.dark[r * nf + c] ? -1 : 1));
  quad = search(img, quad, nf, lum.pts, lum.tgt, false, sub, 3);
  const chr = sampledPoints(nf, transform, (r, c) => fl.pilot[r * nf + c] === 1, (r, c) => (pilotWarm(r, c) ? 1 : -1));
  quad = search(img, quad, nf, chr.pts, chr.tgt, true, sub / 4, 2);
  return quadH(quad, nf);
}

/** Re-encode the decoded coarse symbol (canonical orientation). */
export function coarseGridFromResult(res: DecodeResult): Uint8Array {
  if (!res.body || res.n === undefined || res.mcs === undefined || res.level === undefined || res.flags === undefined)
    throw new Error("coarse result has no message body");
  const e = encodeGrid(new Uint8Array(0), { mcs: res.mcs, level: res.level, minGrid: res.n, sealed: { flags: res.flags, body: res.body } });
  if (e.n !== res.n) throw new Error("re-encoded coarse grid does not match");
  return e.grid;
}

function finishFine(out: FineResult, flags: number, body: Uint8Array, opened: OpenResult): FineResult {
  out.flags = flags;
  out.body = body;
  out.security = opened;
  out.locked = opened.locked;
  if (opened.error && !opened.locked) {
    out.ok = false;
    out.error = opened.error;
    return out;
  }
  out.ok = true;
  out.payload = opened.payload;
  out.error = opened.error;
  return out;
}

export async function unlockFine(fine: FineResult, secrets: Secrets): Promise<FineResult> {
  if (!fine.body || fine.flags === undefined) throw new Error("fine result has no message body");
  return finishFine({ ...fine }, fine.flags, fine.body, await openMessageAsync(fine.flags, fine.body, secrets));
}

/** Read the fine layer through the coarse homography (coarse cell coords -> pixels, as sampled). */
export function decodeFine(img: Image, H: Matrix3x3, coarse: DecodeResult, secrets: Secrets = {}): FineResult {
  const out: FineResult = { ok: false };
  let cg: Uint8Array;
  try {
    cg = coarseGridFromResult(coarse);
  } catch (e) {
    out.error = e instanceof Error ? e.message : String(e);
    return out;
  }
  const fl = fineLayout(cg, coarse.n!);
  const nf = fl.nf;
  const Hf = refineFine(img, H, fl, coarse.transform);
  if (!Hf) return { ok: false, error: "degenerate geometry" };
  const g = dihedral(sampleGrid(img, Hf, nf, false, 0.2, 3), nf, 3, coarse.transform);

  const ref = new Float64Array(nf * nf * 3);
  const w = new Float64Array(nf * nf);
  for (let i = 0; i < nf * nf; i++) {
    if (!fl.pilot[i]) continue;
    const s = 2 * fl.dark[i] + (pilotWarm(Math.floor(i / nf), i % nf) ? 1 : 0);
    ref.set(QC_PAL.subarray(s * 3, s * 3 + 3), i * 3);
    w[i] = PILOT_WEIGHT;
  }
  const [nBits, k] = fineCodeParams(fl);
  const code = buildCode(nBits, k);
  const perm = interleaver(nBits);
  const D = fl.dataCells.length;
  const y = new Float64Array(D * 3);
  let converged = false;
  for (let rnd = 0; rnd <= REFINE_ROUNDS; rnd++) {
    const eq = fitEqualizer(g, ref, w, nf);
    const all = applyEqualizer(eq, g);
    fl.dataCells.forEach((cell, j) => y.set(all.subarray(cell * 3, cell * 3 + 3), j * 3));
    const cons = constellation(all, ref, w, QC_PAL);
    const ll = symbolLoglik(y, cons.centroids, cons.cov);
    const llrCw = new Float64Array(nBits);
    for (let j = 0; j < D; j++) {
      const d = fl.dark[fl.dataCells[j]];
      // Luminance is known from the coarse layer: compare only that luminance's two tints.
      llrCw[perm[j]] = Math.max(-LLR_CAP, Math.min(LLR_CAP, ll[j * 4 + 2 * d] - ll[j * 4 + 2 * d + 1]));
    }
    const dec = ldpcDecode(code, llrCw);
    converged = dec.converged;
    const parsed = dec.converged ? parseInfoBits(dec.bits.subarray(0, k)) : null;
    if (parsed) return finishFine(out, parsed.flags, parsed.payload, openMessage(parsed.flags, parsed.payload, secrets));
    if (rnd === REFINE_ROUNDS) break;
    for (let j = 0; j < D; j++) {
      const pWarm = 1 / (1 + Math.exp(Math.max(-30, Math.min(30, dec.posterior[perm[j]]))));
      const conf = Math.max(pWarm, 1 - pWarm);
      if (conf < REFINE_CONFIDENCE) continue;
      const cell = fl.dataCells[j];
      const s = 2 * fl.dark[cell] + (pWarm > 0.5 ? 1 : 0);
      ref.set(QC_PAL.subarray(s * 3, s * 3 + 3), cell * 3);
      w[cell] = conf;
    }
  }
  out.error = converged ? "fine layer CRC mismatch" : "fine layer not readable (move closer)";
  return out;
}
