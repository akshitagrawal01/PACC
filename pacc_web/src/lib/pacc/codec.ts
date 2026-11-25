/** Grid-level PACC encoder/decoder — twin of pacc2/codec.py. */
import type { FrameCombiner } from "./combine";
import { applyEqualizer, constellation, fitEqualizer } from "./equalize";
import { cornerBits, decodeFormat, dihedral, FormatResult } from "./fmt";
import { buildMessage, interleaver, messageToInfoBits, parseInfoBits } from "./framing";
import { buildLayout, pilotIndex } from "./layout";
import { buildCode, ldpcDecode, ldpcEncode } from "./ldpc";
import { bitLlrs, bitsToSymbols, symbolDecisions, symbolLoglik } from "./modem";
import { openMessage, openMessageAsync, seal, sealAsync, type OpenResult, type SealOptions, type Secrets } from "./secure";
import {
  FLAG_DEFLATE, LEVELS, MESSAGE_OVERHEAD, PALETTES, gridIndex, gridSizes, levelByName, paletteArray,
} from "./spec";

const PILOT_WEIGHT = 2.0;
const REFINE_ROUNDS = 2;
const REFINE_CONFIDENCE = 0.95;

export function codeParams(n: number, mcs: number, level: number): [number, number] {
  const lay = buildLayout(n);
  const nBits = lay.dataCells.length * PALETTES[mcs].bits;
  const [, num, den] = LEVELS[level];
  const k = Math.floor(Math.floor((nBits * num) / den) / 8) * 8;
  return [nBits, k];
}

export function capacity(n: number, mcs: number, level: number): number {
  return Math.max(0, codeParams(n, mcs, level)[1] / 8 - MESSAGE_OVERHEAD);
}

export interface EncodeOptions {
  mcs?: number;
  level?: number | string;
  compress?: boolean;
  minGrid?: number;
  security?: SealOptions;
  extraFlags?: number;
  /** Pre-sealed message (used by encodeGridAsync). */
  sealed?: { flags: number; body: Uint8Array };
}

export interface EncodeResult {
  grid: Uint8Array;     // n*n*3 RGB
  n: number;
  mcs: number;
  level: number;
  payloadBytes: number;
  compressed: boolean;
  codeN: number;
  codeK: number;
}

export function encodeGrid(data: Uint8Array, opts: EncodeOptions = {}): EncodeResult {
  const mcs = opts.mcs ?? 1;
  const level = typeof opts.level === "string" ? levelByName(opts.level) : opts.level ?? 2;
  if (!PALETTES[mcs]) throw new Error(`unsupported MCS ${mcs}`);
  const { flags, body: payload } = opts.sealed ?? seal(data, opts.compress ?? true, opts.security, opts.extraFlags ?? 0);
  const message = buildMessage(payload, flags);
  let n = -1;
  for (const size of gridSizes()) {
    if (opts.minGrid && size < opts.minGrid) continue;
    if (codeParams(size, mcs, level)[1] >= 8 * message.length) {
      n = size;
      break;
    }
  }
  if (n < 0) {
    const max = gridSizes()[gridSizes().length - 1];
    throw new Error(`payload of ${payload.length} bytes exceeds the largest PACC symbol (${capacity(max, mcs, level)} bytes at this MCS/level)`);
  }
  const lay = buildLayout(n);
  const [nBits, k] = codeParams(n, mcs, level);
  const info = messageToInfoBits(message, k);
  const code = buildCode(nBits, k);
  const cw = ldpcEncode(code, info);
  const perm = interleaver(nBits);
  const tx = new Uint8Array(nBits);
  for (let i = 0; i < nBits; i++) tx[i] = cw[perm[i]];
  const symbols = bitsToSymbols(tx, PALETTES[mcs].bits);
  const pal = PALETTES[mcs].rgb;

  const grid = new Uint8Array(n * n * 3).fill(255);
  const setCell = (idx: number, rgb: readonly number[]) => {
    grid[idx * 3] = rgb[0];
    grid[idx * 3 + 1] = rgb[1];
    grid[idx * 3 + 2] = rgb[2];
  };
  for (let i = 0; i < n * n; i++) if (lay.knownDark[i]) setCell(i, [0, 0, 0]);
  const fi = { gridIndex: gridIndex(n), mcs, level };
  for (let corner = 0; corner < 4; corner++) {
    const bits = cornerBits(corner, fi);
    lay.formatCells[corner].forEach(([r, c], j) => setCell(r * n + c, bits[j] ? [0, 0, 0] : [255, 255, 255]));
  }
  for (const idx of lay.pilotCells) setCell(idx, pal[pilotIndex(Math.floor(idx / n), idx % n, pal.length)]);
  lay.dataCells.forEach((idx, j) => setCell(idx, pal[symbols[j]]));
  return { grid, n, mcs, level, payloadBytes: data.length, compressed: Boolean(flags & FLAG_DEFLATE), codeN: nBits, codeK: k };
}

/** encodeGrid with password encryption support (Argon2id is asynchronous). */
export async function encodeGridAsync(data: Uint8Array, opts: EncodeOptions = {}): Promise<EncodeResult> {
  const sealed = await sealAsync(data, opts.compress ?? true, opts.security, opts.extraFlags ?? 0);
  return encodeGrid(data, { ...opts, sealed });
}

// ── Decoding ──────────────────────────────────────────────────────────────────

export interface DecodeResult {
  ok: boolean;
  payload?: Uint8Array;
  n?: number;
  mcs?: number;
  level?: number;
  formatScore: number;
  formatMargin: number;
  transform: number;
  refineRounds: number;
  ldpcIterations: number;
  error?: string;
  gridMismatch?: number;
  flags?: number;
  /** Framed message body, kept so a locked result can be unlocked without re-decoding. */
  body?: Uint8Array;
  locked?: "password" | "recipient";
  security?: OpenResult;
  /** Frames whose soft information produced this decode (multi-frame combining). */
  framesCombined?: number;
  /** Codeword-order channel LLRs of the first pass (multi-frame combining). */
  channelLlrs?: Float64Array;
  /** Fine layer of a distance-adaptive layered symbol (hier.ts). */
  fine?: import("./hier").FineResult;
}

export interface DecodeGridOptions {
  secrets?: Secrets;
  combiner?: FrameCombiner;
}

function applyOpen(res: DecodeResult, flags: number, body: Uint8Array, opened: OpenResult): DecodeResult {
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
  res.payload = opened.payload;
  res.error = opened.error;
  return res;
}

/** Re-open a locked result with a password / recipient key, without re-decoding. */
export async function unlock(res: DecodeResult, secrets: Secrets): Promise<DecodeResult> {
  if (!res.body || res.flags === undefined) throw new Error("result has no message body");
  return applyOpen({ ...res }, res.flags, res.body, await openMessageAsync(res.flags, res.body, secrets));
}

function median(values: number[]): number {
  const s = values.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function readFormat(obs: Float64Array, n: number): FormatResult {
  const lay = buildLayout(n);
  const luma = new Float64Array(n * n);
  for (let i = 0; i < n * n; i++) luma[i] = obs[i * 3] * 0.299 + obs[i * 3 + 1] * 0.587 + obs[i * 3 + 2] * 0.114;
  const darkVals: number[] = [];
  const lightVals: number[] = [];
  for (let i = 0; i < n * n; i++) {
    if (lay.knownDark[i]) darkVals.push(luma[i]);
    else if (lay.knownLight[i]) lightVals.push(luma[i]);
  }
  const dark = median(darkVals);
  const light = median(lightVals);
  const half = Math.max((light - dark) / 2, 1e-3);
  const mid = (light + dark) / 2;
  const soft = new Float64Array(n * n);
  for (let i = 0; i < n * n; i++) soft[i] = Math.max(-1, Math.min(1, (luma[i] - mid) / half));
  return decodeFormat(soft, n);
}

/** obs: n*n*3 captured colours in [0, 1] in grid order (any rotation/mirror). */
export function decodeGrid(obs: Float64Array, n: number, opts: DecodeGridOptions = {}): DecodeResult {
  const fr = readFormat(obs, n);
  const res: DecodeResult = {
    ok: false, formatScore: fr.score, formatMargin: fr.margin, transform: fr.transform, refineRounds: 0, ldpcIterations: 0,
  };
  const expectedN = 24 + 4 * fr.info.gridIndex;
  if (expectedN !== n) {
    res.gridMismatch = expectedN;
    res.error = `format word indicates N=${expectedN}, sampled N=${n}`;
    return res;
  }
  const { mcs, level } = fr.info;
  if (!PALETTES[mcs] || !LEVELS[level]) {
    res.error = "format word names an unsupported MCS/level";
    return res;
  }
  res.n = n;
  res.mcs = mcs;
  res.level = level;

  const g = dihedral(obs, n, 3, fr.transform);
  const lay = buildLayout(n);
  const pal = paletteArray(mcs);
  const M = pal.length / 3;
  const bpc = PALETTES[mcs].bits;

  const ref = new Float64Array(n * n * 3);
  const w = new Float64Array(n * n);
  const setRef = (idx: number, r: number, gg: number, b: number, weight: number) => {
    ref[idx * 3] = r;
    ref[idx * 3 + 1] = gg;
    ref[idx * 3 + 2] = b;
    w[idx] = weight;
  };
  for (let i = 0; i < n * n; i++) {
    if (lay.knownLight[i]) setRef(i, 1, 1, 1, 1);
    else if (lay.knownDark[i]) setRef(i, 0, 0, 0, 1);
  }
  for (let corner = 0; corner < 4; corner++) {
    const bits = cornerBits(corner, fr.info);
    lay.formatCells[corner].forEach(([r, c], j) => {
      const v = bits[j] ? 0 : 1;
      setRef(r * n + c, v, v, v, 1);
    });
  }
  for (const idx of lay.pilotCells) {
    const p = pilotIndex(Math.floor(idx / n), idx % n, M);
    setRef(idx, pal[p * 3], pal[p * 3 + 1], pal[p * 3 + 2], PILOT_WEIGHT);
  }

  const [nBits, k] = codeParams(n, mcs, level);
  const code = buildCode(nBits, k);
  const perm = interleaver(nBits);
  const D = lay.dataCells.length;
  const y = new Float64Array(D * 3);
  let converged = false;

  /** Equalise, demap and decode with decision-directed refinement. */
  const run = (prior: Float64Array | null, ref: Float64Array, w: Float64Array) => {
    for (let rnd = 0; rnd <= REFINE_ROUNDS; rnd++) {
      const eq = fitEqualizer(g, ref, w, n);
      const all = applyEqualizer(eq, g);
      lay.dataCells.forEach((idx, j) => {
        y[j * 3] = all[idx * 3];
        y[j * 3 + 1] = all[idx * 3 + 1];
        y[j * 3 + 2] = all[idx * 3 + 2];
      });
      const cons = constellation(all, ref, w, pal);
      const llrTx = bitLlrs(symbolLoglik(y, cons.centroids, cons.cov), M, bpc);
      const llrCw = new Float64Array(nBits);
      for (let i = 0; i < nBits; i++) llrCw[perm[i]] = llrTx[i];
      if (!res.channelLlrs) res.channelLlrs = llrCw.slice();
      if (prior) for (let i = 0; i < nBits; i++) llrCw[i] += prior[i];
      const dec = ldpcDecode(code, llrCw);
      converged = dec.converged;
      res.ldpcIterations += dec.iterations;
      res.refineRounds = rnd;
      const parsed = dec.converged ? parseInfoBits(dec.bits.subarray(0, k)) : null;
      if (parsed || rnd === REFINE_ROUNDS) return parsed;
      // Decision-directed refinement: confident data cells become extra references.
      const postTx = new Float64Array(nBits);
      for (let i = 0; i < nBits; i++) postTx[i] = dec.posterior[perm[i]];
      const { best, conf } = symbolDecisions(postTx, bpc);
      lay.dataCells.forEach((idx, j) => {
        if (conf[j] >= REFINE_CONFIDENCE) {
          const sym = best[j];
          ref[idx * 3] = pal[sym * 3];
          ref[idx * 3 + 1] = pal[sym * 3 + 1];
          ref[idx * 3 + 2] = pal[sym * 3 + 2];
          w[idx] = conf[j];
        }
      });
    }
    return null;
  };

  // The frame on its own first, so a decodable frame can never be spoiled by history
  // from a different codeword; then together with earlier frames (combine.ts).
  let parsed = run(null, ref.slice(), w.slice());
  if (!parsed && opts.combiner && res.channelLlrs) {
    const prior = opts.combiner.prior(n, mcs, level, res.channelLlrs);
    opts.combiner.offer(n, mcs, level, res.channelLlrs);
    if (prior) {
      parsed = run(prior, ref, w);
      if (parsed) res.framesCombined = opts.combiner.framesFor(n, mcs, level) + 1;
    }
  }
  if (parsed) return applyOpen(res, parsed.flags, parsed.payload, openMessage(parsed.flags, parsed.payload, opts.secrets));
  res.error = converged ? "CRC mismatch" : "LDPC decoding did not converge";
  return res;
}
