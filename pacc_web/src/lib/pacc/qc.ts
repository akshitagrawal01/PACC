/**
 * PACC QC — QR-compatible symbols with a hidden chroma channel.
 * Twin of pacc2/qc.py (design notes there and in docs/pacc2/SPEC.md §QC).
 *
 * QR detection (corners + version) comes from a standard reader (zxing-wasm);
 * this module tints the modules on encode and reads the chroma channel on decode.
 */
import QRCode from "qrcode";
import { getPerspectiveTransformDstToSrc, mapPoint, type Matrix3x3, type Point2D } from "./homography";
import { sampleGrid, type Image } from "./detect";
import { applyEqualizer, constellation, fitEqualizer } from "./equalize";
import { buildMessage, interleaver, messageToInfoBits, parseInfoBits } from "./framing";
import { buildCode, ldpcDecode, ldpcEncode } from "./ldpc";
import { bitLlrs, symbolLoglik } from "./modem";
import { concat, openMessage, openMessageAsync, seal, sealAsync, type OpenResult, type SealOptions, type Secrets } from "./secure";
import { sha256 } from "@noble/hashes/sha2.js";
import { MESSAGE_OVERHEAD } from "./spec";

const PILOT_WEIGHT = 2.0;
const REFINE_ROUNDS = 1;
const REFINE_CONFIDENCE = 0.95;
export const BIND_NONE = 0;
export const BIND_SHA256 = 1;
const BIND_LEN = 16;

/** Palette index = 2 * dark + warm. */
export const QC_RGB: readonly (readonly [number, number, number])[] = [
  [205, 242, 255], // light, cool
  [255, 243, 200], // light, warm
  [0, 15, 95], // dark, cool
  [95, 0, 15], // dark, warm
];
const QC_PAL = Float64Array.from(QC_RGB.flat(), (v) => v / 255);

const ALIGNMENT: number[][] = [
  [], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46],
  [6, 28, 50], [6, 30, 54], [6, 32, 58], [6, 34, 62], [6, 26, 46, 66], [6, 26, 48, 70],
  [6, 26, 50, 74], [6, 30, 54, 78], [6, 30, 56, 82], [6, 30, 58, 86], [6, 34, 62, 90],
  [6, 28, 50, 72, 94], [6, 26, 50, 74, 98], [6, 30, 54, 78, 102], [6, 28, 54, 80, 106],
  [6, 32, 58, 84, 110], [6, 30, 58, 86, 114], [6, 34, 62, 90, 118], [6, 26, 50, 74, 98, 122],
  [6, 30, 54, 78, 102, 126], [6, 26, 52, 78, 104, 130], [6, 30, 56, 82, 108, 134],
  [6, 34, 60, 86, 112, 138], [6, 30, 58, 86, 114, 142], [6, 34, 62, 90, 118, 146],
  [6, 30, 54, 78, 102, 126, 150], [6, 24, 50, 76, 102, 128, 154], [6, 28, 54, 80, 106, 132, 158],
  [6, 32, 58, 84, 110, 136, 162], [6, 26, 54, 82, 110, 138, 166], [6, 30, 58, 86, 114, 142, 170],
];

export interface QcLayout {
  n: number;
  pilot: Uint8Array;      // n*n
  pilotDark: Uint8Array;  // n*n
  dataCells: Int32Array;  // row-major cell indices
}

const layouts = new Map<number, QcLayout>();

export function qcLayout(version: number): QcLayout {
  const cached = layouts.get(version);
  if (cached) return cached;
  if (!(version >= 1 && version <= 40)) throw new Error(`invalid QR version ${version}`);
  const n = 17 + 4 * version;
  const pilot = new Uint8Array(n * n);
  const dark = new Uint8Array(n * n);
  const finderDark = (i: number, j: number) => {
    if (i >= 7 || j >= 7) return 0;
    const ring = i === 0 || j === 0 || i === 6 || j === 6;
    const core = i >= 2 && i <= 4 && j >= 2 && j <= 4;
    return ring || core ? 1 : 0;
  };
  for (let i = 0; i < 8; i++)
    for (let j = 0; j < 8; j++) {
      const f = finderDark(i, j);
      for (const [r, c] of [[i, j], [i, n - 1 - j], [n - 1 - i, j]]) {
        pilot[r * n + c] = 1;
        dark[r * n + c] = f;
      }
    }
  for (let i = 8; i < n - 8; i++) {
    pilot[6 * n + i] = pilot[i * n + 6] = 1;
    dark[6 * n + i] = dark[i * n + 6] = i % 2 === 0 ? 1 : 0;
  }
  const centres = ALIGNMENT[version];
  const last = centres[centres.length - 1];
  for (const r of centres)
    for (const c of centres) {
      if ((r === 6 && c === 6) || (r === 6 && c === last) || (r === last && c === 6)) continue;
      for (let dr = -2; dr <= 2; dr++)
        for (let dc = -2; dc <= 2; dc++) {
          const k = (r + dr) * n + c + dc;
          pilot[k] = 1;
          dark[k] = Math.max(Math.abs(dr), Math.abs(dc)) !== 1 ? 1 : 0;
        }
    }
  pilot[(n - 8) * n + 8] = dark[(n - 8) * n + 8] = 1;
  const data: number[] = [];
  for (let i = 0; i < n * n; i++) if (!pilot[i]) data.push(i);
  const out = { n, pilot, pilotDark: dark, dataCells: Int32Array.from(data) };
  layouts.set(version, out);
  return out;
}

const pilotWarm = (r: number, c: number) => (r + c) % 2 === 1;

export function qcCodeParams(version: number): [number, number] {
  const nBits = qcLayout(version).dataCells.length;
  return [nBits, Math.floor(Math.floor(nBits / 2) / 8) * 8];
}

export function qcCapacity(version: number): number {
  return Math.max(0, qcCodeParams(version)[1] / 8 - MESSAGE_OVERHEAD - 1);
}

const binding = (visible: string) => sha256(new TextEncoder().encode(visible)).slice(0, BIND_LEN);

// ── Encoding ──────────────────────────────────────────────────────────────────

export interface QcEncodeOptions {
  ec?: "L" | "M" | "Q" | "H";
  bind?: boolean;
  compress?: boolean;
  security?: SealOptions;
  minVersion?: number;
  sealed?: { flags: number; body: Uint8Array };
}

export interface QcEncodeResult {
  grid: Uint8Array;    // n*n*3
  version: number;
  n: number;
  hiddenBytes: number;
  messageBytes: number;
}

function qcPlaintext(visible: string, hidden: Uint8Array, bind: boolean): Uint8Array {
  return bind ? concat(Uint8Array.of(BIND_SHA256), binding(visible), hidden) : concat(Uint8Array.of(BIND_NONE), hidden);
}

export function qcEncode(visible: string, hidden: Uint8Array = new Uint8Array(0), opts: QcEncodeOptions = {}): QcEncodeResult {
  const { flags, body } = opts.sealed ?? seal(qcPlaintext(visible, hidden, opts.bind ?? true), opts.compress ?? true, opts.security);
  const message = buildMessage(body, flags);
  let version = opts.minVersion ?? 1;
  let qr = QRCode.create(visible, { errorCorrectionLevel: opts.ec ?? "M" });
  version = Math.max(version, qr.version);
  while (qcCodeParams(version)[1] < 8 * message.length) {
    if (++version > 40) throw new Error("hidden message too large for any QR version");
  }
  if (qr.version !== version) qr = QRCode.create(visible, { errorCorrectionLevel: opts.ec ?? "M", version });
  const lay = qcLayout(version);
  const n = lay.n;
  const [nBits, k] = qcCodeParams(version);
  const cw = ldpcEncode(buildCode(nBits, k), messageToInfoBits(message, k));
  const perm = interleaver(nBits);
  const warm = new Uint8Array(n * n);
  for (let i = 0; i < n * n; i++) if (lay.pilot[i]) warm[i] = pilotWarm(Math.floor(i / n), i % n) ? 1 : 0;
  lay.dataCells.forEach((cell, j) => (warm[cell] = cw[perm[j]]));
  const grid = new Uint8Array(n * n * 3);
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++) {
      const i = r * n + c;
      const rgb = QC_RGB[2 * (qr.modules.get(r, c) ? 1 : 0) + warm[i]];
      grid.set(rgb, i * 3);
    }
  return { grid, version, n, hiddenBytes: hidden.length, messageBytes: message.length };
}

export async function qcEncodeAsync(visible: string, hidden: Uint8Array = new Uint8Array(0), opts: QcEncodeOptions = {}) {
  const sealed = await sealAsync(qcPlaintext(visible, hidden, opts.bind ?? true), opts.compress ?? true, opts.security);
  return qcEncode(visible, hidden, { ...opts, sealed });
}

// ── Decoding ──────────────────────────────────────────────────────────────────

export interface QcDecodeResult {
  ok: boolean;
  visible?: string;
  hidden?: Uint8Array;
  bound?: boolean;
  version?: number;
  security?: OpenResult;
  locked?: "password" | "recipient";
  error?: string;
  flags?: number;
  body?: Uint8Array;
}

type Quad = [Point2D, Point2D, Point2D, Point2D];

const gridH = (q: Quad, n: number) =>
  getPerspectiveTransformDstToSrc([{ x: 0, y: 0 }, { x: n, y: 0 }, { x: n, y: n }, { x: 0, y: n }], q);

function luma(img: Image, x: number, y: number): number {
  const { data, width: w, height: h } = img;
  const xi = Math.min(w - 1, Math.max(0, Math.round(x))), yi = Math.min(h - 1, Math.max(0, Math.round(y)));
  const o = (yi * w + xi) * 4;
  return data[o] * 0.299 + data[o + 1] * 0.587 + data[o + 2] * 0.114;
}

function pilotScore(img: Image, q: Quad, lay: QcLayout): number {
  const H = gridH(q, lay.n) as Matrix3x3 | null;
  if (!H) return -Infinity;
  let sd = 0, nd = 0, sl = 0, nl = 0, s = 0, s2 = 0, cnt = 0;
  for (let i = 0; i < lay.n * lay.n; i++) {
    if (!lay.pilot[i]) continue;
    const r = Math.floor(i / lay.n), c = i % lay.n;
    let y = 0;
    for (const d of [-0.15, 0.15])
      for (const e of [-0.15, 0.15]) {
        const p = mapPoint(H, c + 0.5 + e, r + 0.5 + d);
        y += luma(img, p.x, p.y) / 4;
      }
    if (lay.pilotDark[i]) {
      sd += y;
      nd++;
    } else {
      sl += y;
      nl++;
    }
    s += y;
    s2 += y * y;
    cnt++;
  }
  const std = Math.sqrt(Math.max(s2 / cnt - (s / cnt) ** 2, 0));
  return (sl / nl - sd / nd) / (std + 1e-6);
}

/** Nudge each corner by up to half a module so the function patterns line up. */
export function qcRefine(img: Image, corners: Quad, lay: QcLayout, rounds = 2): Quad {
  let q = corners.map((p) => ({ ...p })) as Quad;
  let step = q.reduce((s, p, i) => s + Math.hypot(p.x - q[(i + 1) % 4].x, p.y - q[(i + 1) % 4].y), 0) / 4 / lay.n;
  let best = pilotScore(img, q, lay);
  const offs = [-0.5, -0.25, 0, 0.25, 0.5];
  for (let rnd = 0; rnd < rounds; rnd++) {
    for (let i = 0; i < 4; i++) {
      const base = { ...q[i] };
      for (const dy of offs)
        for (const dx of offs) {
          const trial = q.map((p) => ({ ...p })) as Quad;
          trial[i] = { x: base.x + step * dx, y: base.y + step * dy };
          const s = pilotScore(img, trial, lay);
          if (s > best + 1e-9) {
            best = s;
            q = trial;
          }
        }
    }
    step /= 2;
  }
  return q;
}

function finish(res: QcDecodeResult, flags: number, body: Uint8Array, opened: OpenResult): QcDecodeResult {
  res.flags = flags;
  res.body = body;
  res.security = opened;
  res.locked = opened.locked;
  if (opened.error && !opened.locked) {
    res.ok = false;
    res.error = opened.error;
    return res;
  }
  res.ok = true;
  const p = opened.payload;
  if (!p) return res;
  if (p[0] === BIND_SHA256 && p.length >= 1 + BIND_LEN) {
    const b = res.visible !== undefined ? binding(res.visible) : null;
    res.bound = !!b && b.every((v, i) => v === p[1 + i]);
    res.hidden = p.slice(1 + BIND_LEN);
  } else if (p[0] === BIND_NONE) {
    res.hidden = p.slice(1);
  } else {
    res.ok = false;
    res.error = "unknown binding header";
  }
  return res;
}

export async function qcUnlock(res: QcDecodeResult, secrets: Secrets): Promise<QcDecodeResult> {
  if (!res.body || res.flags === undefined) throw new Error("result has no message body");
  return finish({ ...res }, res.flags, res.body, await openMessageAsync(res.flags, res.body, secrets));
}

/** Read the hidden channel of a QR with known outer corners (TL, TR, BR, BL) and version. */
export function qcDecodeAt(img: Image, corners: Quad, version: number, visible?: string, secrets: Secrets = {}): QcDecodeResult {
  const res: QcDecodeResult = { ok: false, visible, version };
  const lay = qcLayout(version);
  const n = lay.n;
  const q = qcRefine(img, corners, lay);
  const H = gridH(q, n);
  if (!H) return { ...res, error: "degenerate corners" };
  const g = sampleGrid(img, H, n);
  const ref = new Float64Array(n * n * 3);
  const w = new Float64Array(n * n);
  for (let i = 0; i < n * n; i++) {
    if (!lay.pilot[i]) continue;
    const idx = 2 * lay.pilotDark[i] + (pilotWarm(Math.floor(i / n), i % n) ? 1 : 0);
    ref.set(QC_PAL.subarray(idx * 3, idx * 3 + 3), i * 3);
    w[i] = PILOT_WEIGHT;
  }
  const [nBits, k] = qcCodeParams(version);
  const code = buildCode(nBits, k);
  const perm = interleaver(nBits);
  const D = lay.dataCells.length;
  const y = new Float64Array(D * 3);
  let converged = false;
  for (let rnd = 0; rnd <= REFINE_ROUNDS; rnd++) {
    const eq = fitEqualizer(g, ref, w, n);
    const all = applyEqualizer(eq, g);
    lay.dataCells.forEach((cell, j) => y.set(all.subarray(cell * 3, cell * 3 + 3), j * 3));
    const cons = constellation(all, ref, w, QC_PAL);
    const loglik = symbolLoglik(y, cons.centroids, cons.cov);
    const llrs = bitLlrs(loglik, 4, 2);
    const llrCw = new Float64Array(nBits);
    for (let j = 0; j < nBits; j++) llrCw[perm[j]] = llrs[j * 2 + 1];
    const dec = ldpcDecode(code, llrCw);
    converged = dec.converged;
    const parsed = dec.converged ? parseInfoBits(dec.bits.subarray(0, k)) : null;
    if (parsed) return finish(res, parsed.flags, parsed.payload, openMessage(parsed.flags, parsed.payload, secrets));
    if (rnd === REFINE_ROUNDS) break;
    // Decision-directed refinement (both bits confident -> extra reference).
    for (let j = 0; j < D; j++) {
      const pWarm = 1 / (1 + Math.exp(Math.max(-30, Math.min(30, dec.posterior[perm[j]]))));
      const m = Math.max(loglik[j * 4], loglik[j * 4 + 1], loglik[j * 4 + 2], loglik[j * 4 + 3]);
      const l = [0, 1, 2, 3].map((s) => Math.exp(loglik[j * 4 + s] - m));
      const darkP = l[2] * (1 - pWarm) + l[3] * pWarm;
      const lightP = l[0] * (1 - pWarm) + l[1] * pWarm;
      const pDark = darkP / (darkP + lightP);
      const conf = Math.max(pDark, 1 - pDark) * Math.max(pWarm, 1 - pWarm);
      if (conf >= REFINE_CONFIDENCE) {
        const s = 2 * (pDark > 0.5 ? 1 : 0) + (pWarm > 0.5 ? 1 : 0);
        const cell = lay.dataCells[j];
        ref.set(QC_PAL.subarray(s * 3, s * 3 + 3), cell * 3);
        w[cell] = conf;
      }
    }
  }
  res.error = converged ? "CRC mismatch" : "no hidden PACC channel (LDPC did not converge)";
  return res;
}

