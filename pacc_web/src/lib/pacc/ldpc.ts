/**
 * Irregular repeat-accumulate LDPC codes — twin of pacc2/ldpc.py (SPEC §6).
 * Construction uses integer arithmetic and the shared PRNG only, so it matches
 * the Python reference exactly. Decoding is sum-product belief propagation.
 */
import { Prng, mixSeed } from "./prng";

const LLR_CLIP = 30;

export interface IraCode {
  n: number;
  k: number;
  m: number;
  checkInfo: Int32Array[];   // per check: sorted info-bit indices
  eCheck: Int32Array;        // edges sorted by check
  eVar: Int32Array;
  checkStart: Int32Array;
  checkDeg: Int32Array;
}

export function degreeProfile(n: number, k: number): [number, number, number] {
  const m = n - k;
  const dc = Math.max(2, Math.floor((8 * k + 3 * m) / (2 * m)));
  let heavy = 10 * k < 4 * n || 10 * k > 7 * n ? 12 : 8;
  heavy = Math.min(heavy, m);
  const light = Math.min(3, m);
  const total = m * dc;
  let nHeavy = heavy <= light ? 0 : Math.floor((total - light * k) / (heavy - light));
  nHeavy = Math.max(0, Math.min(k, nHeavy));
  return [dc, heavy, nHeavy];
}

const cache = new Map<string, IraCode>();

export function buildCode(n: number, k: number): IraCode {
  const key = `${n}:${k}`;
  const hit = cache.get(key);
  if (hit) return hit;
  if (!(0 < k && k < n)) throw new Error(`invalid LDPC size n=${n} k=${k}`);
  const m = n - k;
  const [, heavy, nHeavy] = degreeProfile(n, k);
  const light = Math.min(3, m);

  const sockets: number[] = [];
  for (let v = 0; v < k; v++) {
    const d = v < nHeavy ? heavy : light;
    for (let i = 0; i < d; i++) sockets.push(v);
  }
  const rng = new Prng(mixSeed(0x1d9c, n, k));
  rng.shuffle(sockets);

  const total = sockets.length;
  const base = Math.floor(total / m);
  const extra = total % m;
  const usedPairs = new Set<number>();
  const conflicts = (v: number, members: number[]): boolean => {
    for (const u of members) {
      if (u === v) return true;
      if (usedPairs.has(Math.min(u, v) * k + Math.max(u, v))) return true;
    }
    return false;
  };

  const checkInfo: Int32Array[] = [];
  let pos = 0;
  for (let c = 0; c < m; c++) {
    const deg = base + (c < extra ? 1 : 0);
    const members: number[] = [];
    for (let s = 0; s < deg; s++) {
      if (pos >= total) break;
      if (conflicts(sockets[pos], members)) {
        for (let attempt = 0; attempt < 48; attempt++) {
          if (pos + 1 >= total) break;
          const j = pos + 1 + rng.below(total - pos - 1);
          if (!conflicts(sockets[j], members)) {
            const t = sockets[pos];
            sockets[pos] = sockets[j];
            sockets[j] = t;
            break;
          }
        }
      }
      const v = sockets[pos];
      pos++;
      if (members.includes(v)) continue;
      for (const u of members) usedPairs.add(Math.min(u, v) * k + Math.max(u, v));
      members.push(v);
    }
    members.sort((a, b) => a - b);
    checkInfo.push(Int32Array.from(members));
  }

  const eC: number[] = [];
  const eV: number[] = [];
  for (let c = 0; c < m; c++) {
    for (const v of checkInfo[c]) {
      eC.push(c);
      eV.push(v);
    }
    if (c > 0) {
      eC.push(c);
      eV.push(k + c - 1);
    }
    eC.push(c);
    eV.push(k + c);
  }
  const eCheck = Int32Array.from(eC);
  const eVar = Int32Array.from(eV);
  const checkDeg = new Int32Array(m);
  for (const c of eCheck) checkDeg[c]++;
  const checkStart = new Int32Array(m);
  for (let c = 1; c < m; c++) checkStart[c] = checkStart[c - 1] + checkDeg[c - 1];
  const code: IraCode = { n, k, m, checkInfo, eCheck, eVar, checkStart, checkDeg };
  cache.set(key, code);
  return code;
}

export function ldpcEncode(code: IraCode, info: Uint8Array): Uint8Array {
  if (info.length !== code.k) throw new Error(`expected ${code.k} info bits`);
  const out = new Uint8Array(code.n);
  out.set(info);
  let prev = 0;
  for (let c = 0; c < code.m; c++) {
    let s = 0;
    for (const v of code.checkInfo[c]) s ^= info[v];
    prev ^= s;
    out[code.k + c] = prev;
  }
  return out;
}

export function syndromeOk(code: IraCode, bits: Uint8Array): boolean {
  const { checkStart, checkDeg, eVar, m } = code;
  for (let c = 0; c < m; c++) {
    let p = 0;
    const end = checkStart[c] + checkDeg[c];
    for (let e = checkStart[c]; e < end; e++) p ^= bits[eVar[e]];
    if (p) return false;
  }
  return true;
}

export interface LdpcResult {
  bits: Uint8Array;
  posterior: Float64Array;
  converged: boolean;
  iterations: number;
}

/** Sum-product decoding; llr > 0 favours bit 0. */
export function ldpcDecode(code: IraCode, llr: Float64Array, maxIter = 80): LdpcResult {
  const { n, m, eVar, checkStart, checkDeg } = code;
  const E = eVar.length;
  const ch = new Float64Array(n);
  for (let i = 0; i < n; i++) ch[i] = Math.max(-LLR_CLIP, Math.min(LLR_CLIP, llr[i]));
  const c2v = new Float64Array(E);
  const logT = new Float64Array(E);
  const neg = new Uint8Array(E);
  const post = Float64Array.from(ch);
  const bits = new Uint8Array(n);
  const harden = () => {
    for (let i = 0; i < n; i++) bits[i] = post[i] < 0 ? 1 : 0;
  };
  harden();
  if (syndromeOk(code, bits)) return { bits, posterior: post, converged: true, iterations: 0 };

  for (let it = 1; it <= maxIter; it++) {
    for (let e = 0; e < E; e++) {
      let v = post[eVar[e]] - c2v[e];
      if (v > LLR_CLIP) v = LLR_CLIP;
      else if (v < -LLR_CLIP) v = -LLR_CLIP;
      neg[e] = v < 0 ? 1 : 0;
      logT[e] = Math.log(Math.max(Math.tanh(Math.abs(v) * 0.5), 1e-15));
    }
    for (let c = 0; c < m; c++) {
      const s = checkStart[c];
      const end = s + checkDeg[c];
      let sumLog = 0;
      let par = 0;
      for (let e = s; e < end; e++) {
        sumLog += logT[e];
        par ^= neg[e];
      }
      for (let e = s; e < end; e++) {
        const mag = 2 * Math.atanh(Math.min(Math.exp(sumLog - logT[e]), 1 - 1e-15));
        c2v[e] = (par ^ neg[e]) ? -mag : mag;
      }
    }
    post.set(ch);
    for (let e = 0; e < E; e++) post[eVar[e]] += c2v[e];
    harden();
    if (syndromeOk(code, bits)) return { bits, posterior: post, converged: true, iterations: it };
  }
  return { bits, posterior: post, converged: false, iterations: maxIter };
}
