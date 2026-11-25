/**
 * Deterministic 32-bit PRNG — bit-for-bit twin of pacc2/prng.py (see SPEC §2).
 * Every pseudo-random PACC structure (LDPC graph, interleaver, scrambler) comes
 * from here, so Python and TypeScript build identical codes.
 */

export function imul32(a: number, b: number): number {
  return Math.imul(a, b) >>> 0;
}

export function mixSeed(...values: number[]): number {
  let h = 0x50414343; // "PACC"
  for (const v of values) {
    h = imul32((h ^ (v >>> 0)) >>> 0, 0x9e3779b1);
    h = (h ^ (h >>> 15)) >>> 0;
  }
  return h >>> 0;
}

export class Prng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  nextU32(): number {
    this.state = (this.state + 0x9e3779b9) >>> 0;
    let z = this.state;
    z = imul32((z ^ (z >>> 16)) >>> 0, 0x85ebca6b);
    z = imul32((z ^ (z >>> 13)) >>> 0, 0xc2b2ae35);
    return (z ^ (z >>> 16)) >>> 0;
  }

  below(n: number): number {
    return this.nextU32() % n;
  }

  shuffle<T>(items: T[] | Int32Array): void {
    for (let i = items.length - 1; i > 0; i--) {
      const j = this.below(i + 1);
      const t = items[i];
      items[i] = items[j];
      items[j] = t;
    }
  }

  bits(n: number): Uint8Array {
    const out = new Uint8Array(n);
    let i = 0;
    while (i < n) {
      const w = this.nextU32();
      for (let b = 0; b < 32 && i < n; b++, i++) out[i] = (w >>> b) & 1;
    }
    return out;
  }
}

export function permutation(n: number, seed: number): Int32Array {
  const perm = new Int32Array(n);
  for (let i = 0; i < n; i++) perm[i] = i;
  new Prng(seed).shuffle(perm);
  return perm;
}
