/**
 * PACC Stream — animated sequences of fountain-coded PACC frames.
 * Twin of pacc2/stream.py (frame layout and coefficient rule documented there).
 */
import { capacity, encodeGrid, type EncodeResult } from "./codec";
import { Prng, mixSeed } from "./prng";
import { openMessage, openMessageAsync, seal, sealAsync, type OpenResult, type SealOptions, type Secrets } from "./secure";
import { FLAG_STREAM, gridSizes, levelByName } from "./spec";

export const HEADER_SIZE = 15;
export const MAX_BLOCKS = 4096;

export function coefficients(streamId: number, esi: number, k: number): Uint8Array {
  const v = new Uint8Array(k);
  if (esi < k) {
    v[esi] = 1;
    return v;
  }
  v.set(new Prng(mixSeed(0x57ea, streamId, esi)).bits(k));
  if (!v.some((x) => x)) v[esi % k] = 1;
  return v;
}

export interface StreamPlan {
  streamId: number;
  flags: number;
  message: Uint8Array;
  blockSize: number;
  k: number;
  n: number;
  mcs: number;
  level: number;
}

export interface StreamOptions {
  n?: number;
  mcs?: number;
  level?: number | string;
  compress?: boolean;
  security?: SealOptions;
  streamId?: number;
}

function makePlan(sealed: { flags: number; body: Uint8Array }, opts: StreamOptions): StreamPlan {
  const n = opts.n ?? 64;
  const mcs = opts.mcs ?? 1;
  const level = typeof opts.level === "string" ? levelByName(opts.level) : opts.level ?? 1;
  if (!gridSizes().includes(n)) throw new Error(`invalid grid size ${n}`);
  const blockSize = capacity(n, mcs, level) - HEADER_SIZE;
  if (blockSize < 16) throw new Error("symbol too small for stream frames; use a larger grid or a denser MCS/level");
  const k = Math.max(1, Math.ceil(sealed.body.length / blockSize));
  if (k > MAX_BLOCKS) throw new Error(`stream would need ${k} blocks (max ${MAX_BLOCKS}); use larger frames`);
  const streamId = opts.streamId ?? crypto.getRandomValues(new Uint32Array(1))[0];
  return { streamId, flags: sealed.flags, message: sealed.body, blockSize, k, n, mcs, level };
}

export function planStream(data: Uint8Array, opts: StreamOptions = {}): StreamPlan {
  return makePlan(seal(data, opts.compress ?? true, opts.security), opts);
}

export async function planStreamAsync(data: Uint8Array, opts: StreamOptions = {}): Promise<StreamPlan> {
  return makePlan(await sealAsync(data, opts.compress ?? true, opts.security), opts);
}

export function streamBlock(p: StreamPlan, esi: number): Uint8Array {
  const out = new Uint8Array(p.blockSize);
  const coef = coefficients(p.streamId, esi, p.k);
  for (let j = 0; j < p.k; j++) {
    if (!coef[j]) continue;
    const start = j * p.blockSize;
    const end = Math.min(start + p.blockSize, p.message.length);
    for (let i = start; i < end; i++) out[i - start] ^= p.message[i];
  }
  return out;
}

export function framePayload(p: StreamPlan, esi: number): Uint8Array {
  const out = new Uint8Array(HEADER_SIZE + p.blockSize);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, p.streamId >>> 0);
  dv.setUint32(4, p.message.length);
  dv.setUint16(8, p.blockSize);
  dv.setUint32(10, esi >>> 0);
  out[14] = p.flags;
  out.set(streamBlock(p, esi), HEADER_SIZE);
  return out;
}

export function streamFrame(p: StreamPlan, esi: number): EncodeResult {
  return encodeGrid(new Uint8Array(0), { mcs: p.mcs, level: p.level, minGrid: p.n, sealed: { flags: FLAG_STREAM, body: framePayload(p, esi) } });
}

// ── Receiver ──────────────────────────────────────────────────────────────────

export interface StreamStatus {
  streamId: number;
  k: number;
  rank: number;
  received: number;
  complete: boolean;
}

/** Incremental GF(2) elimination over received encoded blocks of one stream. */
export class StreamDecoder {
  streamId: number | null = null;
  k = 0;
  blockSize = 0;
  length = 0;
  flags = 0;
  received = 0;
  private words = 0;
  private rows = new Map<number, { c: Uint32Array; d: Uint8Array }>();
  private seen = new Set<number>();

  add(payload: Uint8Array): StreamStatus | null {
    if (payload.length < HEADER_SIZE) return null;
    const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const sid = dv.getUint32(0), length = dv.getUint32(4), bsize = dv.getUint16(8), esi = dv.getUint32(10), flags = payload[14];
    const block = payload.subarray(HEADER_SIZE);
    if (bsize === 0 || block.length !== bsize) return null;
    const k = Math.max(1, Math.ceil(length / bsize));
    if (k > MAX_BLOCKS) return null;
    if (sid !== this.streamId || length !== this.length || bsize !== this.blockSize || flags !== this.flags) {
      this.streamId = sid;
      this.length = length;
      this.blockSize = bsize;
      this.flags = flags;
      this.k = k;
      this.words = Math.ceil(k / 32);
      this.received = 0;
      this.rows.clear();
      this.seen.clear();
    }
    if (this.seen.has(esi)) return this.status();
    this.seen.add(esi);
    this.received++;
    if (this.complete) return this.status();
    const coef = coefficients(sid, esi, k);
    const c = new Uint32Array(this.words);
    for (let j = 0; j < k; j++) if (coef[j]) c[j >>> 5] |= 1 << (j & 31);
    const d = block.slice();
    for (;;) {
      const p = lowestBit(c);
      if (p < 0) break;
      const row = this.rows.get(p);
      if (!row) {
        this.rows.set(p, { c, d });
        break;
      }
      for (let w = 0; w < this.words; w++) c[w] ^= row.c[w];
      for (let i = 0; i < d.length; i++) d[i] ^= row.d[i];
    }
    return this.status();
  }

  get complete(): boolean {
    return this.k > 0 && this.rows.size === this.k;
  }

  status(): StreamStatus {
    return { streamId: this.streamId ?? 0, k: this.k, rank: this.rows.size, received: this.received, complete: this.complete };
  }

  /** The reassembled (still sealed) message once complete. */
  message(): Uint8Array | null {
    if (!this.complete) return null;
    const solved: Uint8Array[] = new Array(this.k);
    for (let p = this.k - 1; p >= 0; p--) {
      const row = this.rows.get(p)!;
      const d = row.d.slice();
      for (let q = p + 1; q < this.k; q++) {
        if ((row.c[q >>> 5] >>> (q & 31)) & 1) {
          const s = solved[q];
          for (let i = 0; i < d.length; i++) d[i] ^= s[i];
        }
      }
      solved[p] = d;
    }
    const out = new Uint8Array(this.k * this.blockSize);
    solved.forEach((s, i) => out.set(s, i * this.blockSize));
    return out.subarray(0, this.length);
  }

  open(secrets: Secrets = {}): OpenResult | null {
    const m = this.message();
    return m ? openMessage(this.flags, m, secrets) : null;
  }

  async openAsync(secrets: Secrets = {}): Promise<OpenResult | null> {
    const m = this.message();
    return m ? openMessageAsync(this.flags, m, secrets) : null;
  }
}

function lowestBit(c: Uint32Array): number {
  for (let w = 0; w < c.length; w++) {
    const v = c[w];
    if (v) return w * 32 + (31 - Math.clz32(v & -v));
  }
  return -1;
}
