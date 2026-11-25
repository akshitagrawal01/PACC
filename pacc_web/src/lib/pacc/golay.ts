/**
 * Extended Golay (24, 12, 8) code — twin of pacc2/golay.py.
 */

const G23 = 0b110001110101; // x^11 + x^10 + x^6 + x^5 + x^4 + x^2 + 1

function encode23(info: number): number {
  let reg = info << 11;
  for (let bit = 22; bit >= 11; bit--) {
    if (reg & (1 << bit)) reg ^= G23 << (bit - 11);
  }
  return (info << 11) | reg;
}

function popcount(x: number): number {
  let c = 0;
  while (x) {
    x &= x - 1;
    c++;
  }
  return c;
}

export function golayEncode(info: number): number {
  const cw23 = encode23(info);
  return ((cw23 << 1) | (popcount(cw23) & 1)) >>> 0;
}

export function codewordBits(info: number): number[] {
  const cw = golayEncode(info);
  const out: number[] = [];
  for (let i = 0; i < 24; i++) out.push((cw >>> (23 - i)) & 1);
  return out;
}

let bipolar: Float32Array | null = null;

/** 4096 x 24 table: +1 for a 0 bit, -1 for a 1 bit. */
export function bipolarTable(): Float32Array {
  if (bipolar) return bipolar;
  const t = new Float32Array(4096 * 24);
  for (let info = 0; info < 4096; info++) {
    const cw = golayEncode(info);
    for (let i = 0; i < 24; i++) t[info * 24 + i] = ((cw >>> (23 - i)) & 1) ? -1 : 1;
  }
  bipolar = t;
  return t;
}
