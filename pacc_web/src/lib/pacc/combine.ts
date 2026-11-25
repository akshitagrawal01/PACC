/**
 * Multi-frame soft-information combining for live video — twin of pacc2/combine.py.
 * Channel LLRs (codeword order, orientation already undone) of failed frames of the
 * same symbol are summed and decoded together.
 */

const keyOf = (n: number, mcs: number, level: number) => `${n}:${mcs}:${level}`;

export function llrQuality(llrs: Float64Array): number {
  let s = 0;
  for (let i = 0; i < llrs.length; i++) s += Math.log2(1 + Math.exp(-Math.min(Math.abs(llrs[i]), 30)));
  return 1 - s / Math.max(llrs.length, 1);
}

const CONSISTENCY_LLR = 2.0;
const CONSISTENCY_MIN_BITS = 32;
const CONSISTENCY_AGREE = 0.7;

/** Do two LLR vectors plausibly observe the same codeword? */
export function consistent(a: Float64Array, b: Float64Array): boolean {
  let m = 0;
  let agree = 0;
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i]) > CONSISTENCY_LLR && Math.abs(b[i]) > CONSISTENCY_LLR) {
      m++;
      if (a[i] > 0 === b[i] > 0) agree++;
    }
  }
  return m < CONSISTENCY_MIN_BITS || agree / m >= CONSISTENCY_AGREE;
}

export class FrameCombiner {
  private hist = new Map<string, Float64Array[]>();
  private pending: { q: number; key: string; llrs: Float64Array } | null = null;

  constructor(public maxFrames = 8, public maxKeys = 3, public minQuality = 0.05) {}

  /** Summed LLRs of earlier frames of this symbol; history that is inconsistent with the
   *  current frame (a different codeword, e.g. the next frame of a stream) is dropped. */
  prior(n: number, mcs: number, level: number, llrs?: Float64Array): Float64Array | null {
    const key = keyOf(n, mcs, level);
    const frames = this.hist.get(key);
    if (!frames?.length) return null;
    const sum = new Float64Array(frames[0].length);
    for (const f of frames) for (let i = 0; i < sum.length; i++) sum[i] += f[i];
    if (llrs && llrs.length === sum.length && !consistent(sum, llrs)) {
      this.hist.delete(key);
      return null;
    }
    return sum;
  }

  offer(n: number, mcs: number, level: number, llrs: Float64Array): void {
    const q = llrQuality(llrs);
    if (q < this.minQuality) return;
    if (!this.pending || q > this.pending.q) this.pending = { q, key: keyOf(n, mcs, level), llrs };
  }

  endFrame(success: boolean): void {
    const pending = this.pending;
    this.pending = null;
    if (success) {
      this.reset();
      return;
    }
    if (!pending) return;
    const frames = this.hist.get(pending.key) ?? [];
    this.hist.delete(pending.key);
    // The same camera buffer read twice is not a new observation.
    const last = frames[frames.length - 1];
    const duplicate = last && last.length === pending.llrs.length && last.every((v, i) => Math.abs(v - pending.llrs[i]) <= 1e-6);
    if (!duplicate) frames.push(pending.llrs);
    while (frames.length > this.maxFrames) frames.shift();
    this.hist.set(pending.key, frames);
    while (this.hist.size > this.maxKeys) this.hist.delete(this.hist.keys().next().value!);
  }

  framesFor(n: number, mcs: number, level: number): number {
    return this.hist.get(keyOf(n, mcs, level))?.length ?? 0;
  }

  reset(): void {
    this.hist.clear();
    this.pending = null;
  }

  /** Frames held for the most recently updated symbol. */
  get frames(): number {
    let last: Float64Array[] | undefined;
    for (const v of this.hist.values()) last = v;
    return last?.length ?? 0;
  }
}
