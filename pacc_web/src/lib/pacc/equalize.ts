/**
 * Pilot-based colour equalisation — twin of pacc2/equalize.py.
 * Global quadratic colour transform (ridge towards identity) + smoothly varying
 * per-channel gain/offset from Gaussian-weighted reference statistics.
 */
import { invert3 } from "./modem";

const LOCAL_SIGMA = 4.0;
const TRUNCATE = 3.0;
const RIDGE_GLOBAL = 0.5;
const PRIOR_A = 1.0;
const PRIOR_B = 2.0;
const COV_FLOOR = 0.002;
const COV_INFLATE = 1.3;
const NF = 10;

function features(r: number, g: number, b: number, out: Float64Array, o: number): void {
  out[o] = 1;
  out[o + 1] = r;
  out[o + 2] = g;
  out[o + 3] = b;
  out[o + 4] = r * r;
  out[o + 5] = g * g;
  out[o + 6] = b * b;
  out[o + 7] = r * g;
  out[o + 8] = r * b;
  out[o + 9] = g * b;
}

let kernelCache: Float64Array | null = null;
function gaussKernel(): Float64Array {
  if (kernelCache) return kernelCache;
  const radius = Math.floor(TRUNCATE * LOCAL_SIGMA + 0.5);
  const k = new Float64Array(2 * radius + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    k[i + radius] = Math.exp(-0.5 * (i * i) / (LOCAL_SIGMA * LOCAL_SIGMA));
    sum += k[i + radius];
  }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  kernelCache = k;
  return k;
}

/** Separable Gaussian blur of an n x n field with zero padding (scipy mode="constant"). */
function blur(src: Float64Array, n: number): Float64Array {
  const k = gaussKernel();
  const rad = (k.length - 1) / 2;
  const tmp = new Float64Array(n * n);
  const out = new Float64Array(n * n);
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++) {
      let s = 0;
      for (let i = -rad; i <= rad; i++) {
        const cc = c + i;
        if (cc >= 0 && cc < n) s += k[i + rad] * src[r * n + cc];
      }
      tmp[r * n + c] = s;
    }
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++) {
      let s = 0;
      for (let i = -rad; i <= rad; i++) {
        const rr = r + i;
        if (rr >= 0 && rr < n) s += k[i + rad] * tmp[rr * n + c];
      }
      out[r * n + c] = s;
    }
  return out;
}

/** Solve A X = B for X (A: p x p, B: p x q), Gaussian elimination with partial pivoting. */
function solve(A: Float64Array, B: Float64Array, p: number, q: number): Float64Array {
  const a = Float64Array.from(A);
  const b = Float64Array.from(B);
  for (let col = 0; col < p; col++) {
    let piv = col;
    for (let r = col + 1; r < p; r++) if (Math.abs(a[r * p + col]) > Math.abs(a[piv * p + col])) piv = r;
    if (piv !== col) {
      for (let j = 0; j < p; j++) [a[col * p + j], a[piv * p + j]] = [a[piv * p + j], a[col * p + j]];
      for (let j = 0; j < q; j++) [b[col * q + j], b[piv * q + j]] = [b[piv * q + j], b[col * q + j]];
    }
    const d = a[col * p + col];
    for (let r = col + 1; r < p; r++) {
      const f = a[r * p + col] / d;
      if (f === 0) continue;
      for (let j = col; j < p; j++) a[r * p + j] -= f * a[col * p + j];
      for (let j = 0; j < q; j++) b[r * q + j] -= f * b[col * q + j];
    }
  }
  const x = new Float64Array(p * q);
  for (let r = p - 1; r >= 0; r--)
    for (let j = 0; j < q; j++) {
      let s = b[r * q + j];
      for (let c = r + 1; c < p; c++) s -= a[r * p + c] * x[c * q + j];
      x[r * q + j] = s / a[r * p + r];
    }
  return x;
}

export interface Equalizer {
  n: number;
  W: Float64Array;     // 10 x 3
  a: Float64Array;     // n*n*3
  b: Float64Array;     // n*n*3
  cov: Float64Array;   // 3 x 3
}

export function applyEqualizer(eq: Equalizer, obs: Float64Array): Float64Array {
  const cells = eq.n * eq.n;
  const out = new Float64Array(cells * 3);
  const phi = new Float64Array(NF);
  for (let i = 0; i < cells; i++) {
    features(obs[i * 3], obs[i * 3 + 1], obs[i * 3 + 2], phi, 0);
    for (let ch = 0; ch < 3; ch++) {
      let x = 0;
      for (let f = 0; f < NF; f++) x += phi[f] * eq.W[f * 3 + ch];
      out[i * 3 + ch] = eq.a[i * 3 + ch] * x + eq.b[i * 3 + ch];
    }
  }
  return out;
}

/** obs, ref: n*n*3 in [0, 1]; weight: n*n, 0 for unknown cells. */
export function fitEqualizer(obs: Float64Array, ref: Float64Array, weight: Float64Array, n: number): Equalizer {
  const cells = n * n;
  // 1. Global quadratic transform, ridge towards identity.
  const A = new Float64Array(NF * NF);
  const B = new Float64Array(NF * 3);
  const phi = new Float64Array(NF);
  for (let i = 0; i < cells; i++) {
    const w = weight[i];
    if (w <= 0) continue;
    features(obs[i * 3], obs[i * 3 + 1], obs[i * 3 + 2], phi, 0);
    for (let p = 0; p < NF; p++) {
      for (let q = 0; q < NF; q++) A[p * NF + q] += w * phi[p] * phi[q];
      for (let ch = 0; ch < 3; ch++) B[p * 3 + ch] += w * phi[p] * ref[i * 3 + ch];
    }
  }
  for (let p = 0; p < NF; p++) A[p * NF + p] += RIDGE_GLOBAL;
  B[1 * 3 + 0] += RIDGE_GLOBAL;
  B[2 * 3 + 1] += RIDGE_GLOBAL;
  B[3 * 3 + 2] += RIDGE_GLOBAL;
  const W = solve(A, B, NF, 3);

  // 2. Local per-channel linear correction.
  const xg = new Float64Array(cells * 3);
  for (let i = 0; i < cells; i++) {
    features(obs[i * 3], obs[i * 3 + 1], obs[i * 3 + 2], phi, 0);
    for (let ch = 0; ch < 3; ch++) {
      let x = 0;
      for (let f = 0; f < NF; f++) x += phi[f] * W[f * 3 + ch];
      xg[i * 3 + ch] = x;
    }
  }
  const S = blur(weight, n);
  const a = new Float64Array(cells * 3);
  const b = new Float64Array(cells * 3);
  const t = new Float64Array(cells);
  for (let ch = 0; ch < 3; ch++) {
    const field = (fn: (i: number) => number) => {
      for (let i = 0; i < cells; i++) t[i] = weight[i] * fn(i);
      return blur(t, n);
    };
    const Sx = field((i) => xg[i * 3 + ch]);
    const Sy = field((i) => ref[i * 3 + ch]);
    const Sxx = field((i) => xg[i * 3 + ch] * xg[i * 3 + ch]);
    const Sxy = field((i) => xg[i * 3 + ch] * ref[i * 3 + ch]);
    for (let i = 0; i < cells; i++) {
      const m11 = Sxx[i] + PRIOR_A;
      const m12 = Sx[i];
      const m22 = S[i] + PRIOR_B;
      const r1 = Sxy[i] + PRIOR_A;
      const r2 = Sy[i];
      const det = m11 * m22 - m12 * m12;
      a[i * 3 + ch] = (r1 * m22 - m12 * r2) / det;
      b[i * 3 + ch] = (m11 * r2 - m12 * r1) / det;
    }
  }
  const eq: Equalizer = { n, W, a, b, cov: new Float64Array(9) };

  // 3. Residual covariance at references.
  const y = applyEqualizer(eq, obs);
  const cov = new Float64Array(9);
  let wsum = 0;
  for (let i = 0; i < cells; i++) {
    const w = weight[i];
    if (w <= 0) continue;
    wsum += w;
    const e0 = ref[i * 3] - y[i * 3];
    const e1 = ref[i * 3 + 1] - y[i * 3 + 1];
    const e2 = ref[i * 3 + 2] - y[i * 3 + 2];
    const e = [e0, e1, e2];
    for (let p = 0; p < 3; p++) for (let q = 0; q < 3; q++) cov[p * 3 + q] += w * e[p] * e[q];
  }
  for (let p = 0; p < 9; p++) cov[p] = (COV_INFLATE * cov[p]) / Math.max(wsum, 1);
  cov[0] += COV_FLOOR;
  cov[4] += COV_FLOOR;
  cov[8] += COV_FLOOR;
  if (!(invert3(cov).det > 0)) cov.set([COV_FLOOR, 0, 0, 0, COV_FLOOR, 0, 0, 0, COV_FLOOR]);
  eq.cov = cov;
  return eq;
}

const CENTROID_PRIOR = 1.0;

/**
 * Where each palette colour actually lands after equalisation, and the spread around
 * it — twin of pacc2.equalize.constellation (corrects the regression-dilution shrink
 * of the clusters at low SNR, which would otherwise bias every frame the same way).
 */
export function constellation(
  eqObs: Float64Array, ref: Float64Array, weight: Float64Array, palette: Float64Array,
): { centroids: Float64Array; cov: Float64Array } {
  const M = palette.length / 3;
  const cells = weight.length;
  const lab = new Int32Array(cells).fill(-1);
  const cnt = new Float64Array(M);
  const sums = new Float64Array(M * 3);
  for (let i = 0; i < cells; i++) {
    const wi = weight[i];
    if (!(wi > 0)) continue;
    let best = -1;
    let bestD = Infinity;
    for (let j = 0; j < M; j++) {
      const d0 = ref[i * 3] - palette[j * 3], d1 = ref[i * 3 + 1] - palette[j * 3 + 1], d2 = ref[i * 3 + 2] - palette[j * 3 + 2];
      const d = d0 * d0 + d1 * d1 + d2 * d2;
      if (d < bestD) {
        bestD = d;
        best = j;
      }
    }
    if (bestD >= 1e-6) continue;
    lab[i] = best;
    cnt[best] += wi;
    for (let ch = 0; ch < 3; ch++) sums[best * 3 + ch] += wi * eqObs[i * 3 + ch];
  }
  const centroids = new Float64Array(M * 3);
  for (let j = 0; j < M; j++)
    for (let ch = 0; ch < 3; ch++)
      centroids[j * 3 + ch] = (sums[j * 3 + ch] + CENTROID_PRIOR * palette[j * 3 + ch]) / (cnt[j] + CENTROID_PRIOR);
  const cov = new Float64Array(9);
  let wsum = 0;
  for (let i = 0; i < cells; i++) {
    const j = lab[i];
    if (j < 0) continue;
    const wi = weight[i];
    wsum += wi;
    const r0 = eqObs[i * 3] - centroids[j * 3], r1 = eqObs[i * 3 + 1] - centroids[j * 3 + 1], r2 = eqObs[i * 3 + 2] - centroids[j * 3 + 2];
    const r = [r0, r1, r2];
    for (let p = 0; p < 3; p++) for (let q = 0; q < 3; q++) cov[p * 3 + q] += wi * r[p] * r[q];
  }
  for (let p = 0; p < 9; p++) cov[p] = (COV_INFLATE * cov[p]) / Math.max(wsum, 1);
  cov[0] += COV_FLOOR;
  cov[4] += COV_FLOOR;
  cov[8] += COV_FLOOR;
  if (!(invert3(cov).det > 0)) cov.set([COV_FLOOR, 0, 0, 0, COV_FLOOR, 0, 0, 0, COV_FLOOR]);
  return { centroids, cov };
}
