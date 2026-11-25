/** Bits <-> palette symbols and soft demapping — twin of pacc2/modem.py. */

export const OUTLIER_EPS = 1e-4; // uniform outlier weight (see pacc/modem.py)
export const LLR_CAP = 20;

export function bitsToSymbols(bits: Uint8Array, bpc: number): Int32Array {
  const n = bits.length / bpc;
  const out = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (let b = 0; b < bpc; b++) v = (v << 1) | bits[i * bpc + b];
    out[i] = v;
  }
  return out;
}

function logAddExp(a: number, b: number): number {
  if (a === -Infinity) return b;
  if (b === -Infinity) return a;
  const m = Math.max(a, b);
  return m + Math.log(Math.exp(a - m) + Math.exp(b - m));
}

export function invert3(m: Float64Array): { inv: Float64Array; det: number } {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  const inv = new Float64Array([
    A, -(b * i - c * h), b * f - c * e,
    B, a * i - c * g, -(a * f - c * d),
    C, -(a * h - b * g), a * e - b * d,
  ]).map((x) => x / det);
  return { inv, det };
}

/** (D x M) log p(y | s) with the uniform outlier component. y: D*3, palette: M*3, cov: 3x3. */
export function symbolLoglik(y: Float64Array, palette: Float64Array, cov: Float64Array): Float64Array {
  const D = y.length / 3;
  const M = palette.length / 3;
  const { inv, det } = invert3(cov);
  const logdet = Math.log(Math.pow(2 * Math.PI, 3) * det);
  const lin = Math.log1p(-OUTLIER_EPS);
  const lout = Math.log(OUTLIER_EPS);
  const out = new Float64Array(D * M);
  for (let d = 0; d < D; d++) {
    for (let j = 0; j < M; j++) {
      const x0 = y[d * 3] - palette[j * 3];
      const x1 = y[d * 3 + 1] - palette[j * 3 + 1];
      const x2 = y[d * 3 + 2] - palette[j * 3 + 2];
      const maha =
        x0 * (inv[0] * x0 + inv[1] * x1 + inv[2] * x2) +
        x1 * (inv[3] * x0 + inv[4] * x1 + inv[5] * x2) +
        x2 * (inv[6] * x0 + inv[7] * x1 + inv[8] * x2);
      out[d * M + j] = logAddExp(lin + (-0.5 * maha - 0.5 * logdet), lout);
    }
  }
  return out;
}

/** (D x bpc) bit LLRs, positive favouring bit 0. */
export function bitLlrs(loglik: Float64Array, M: number, bpc: number): Float64Array {
  const D = loglik.length / M;
  const out = new Float64Array(D * bpc);
  for (let d = 0; d < D; d++) {
    for (let b = 0; b < bpc; b++) {
      let z = -Infinity;
      let o = -Infinity;
      const shift = bpc - 1 - b;
      for (let j = 0; j < M; j++) {
        const v = loglik[d * M + j];
        if ((j >> shift) & 1) o = logAddExp(o, v);
        else z = logAddExp(z, v);
      }
      out[d * bpc + b] = Math.max(-LLR_CAP, Math.min(LLR_CAP, z - o));
    }
  }
  return out;
}

/** Most likely symbol and its probability per cell, from per-bit posterior LLRs. */
export function symbolDecisions(llr: Float64Array, bpc: number): { best: Int32Array; conf: Float64Array } {
  const D = llr.length / bpc;
  const M = 1 << bpc;
  const best = new Int32Array(D);
  const conf = new Float64Array(D);
  const logp = new Float64Array(M);
  for (let d = 0; d < D; d++) {
    let mx = -Infinity;
    for (let j = 0; j < M; j++) {
      let s = 0;
      for (let b = 0; b < bpc; b++) {
        const L = llr[d * bpc + b];
        const bit = (j >> (bpc - 1 - b)) & 1;
        // log P(bit = 0) = -log(1 + e^-L); log P(bit = 1) = -log(1 + e^L)
        s += bit ? -logAddExp(0, L) : -logAddExp(0, -L);
      }
      logp[j] = s;
      if (s > mx) {
        mx = s;
        best[d] = j;
      }
    }
    let tot = 0;
    for (let j = 0; j < M; j++) tot += Math.exp(logp[j] - mx);
    conf[d] = 1 / tot;
  }
  return { best, conf };
}
