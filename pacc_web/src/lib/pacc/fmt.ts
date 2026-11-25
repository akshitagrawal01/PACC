/** Format word (Golay-protected, one copy per corner) — twin of pacc2/fmt.py (SPEC §4). */
import { bipolarTable, codewordBits } from "./golay";
import { buildLayout } from "./layout";
import { GRID_INDEX_BITS, MCS_BITS } from "./spec";

export interface FormatInfo {
  gridIndex: number;
  mcs: number;
  level: number;
}

export function pack(corner: number, info: FormatInfo): number {
  return (corner << 10) | (info.gridIndex << (MCS_BITS + 2)) | (info.mcs << 2) | info.level;
}

export function unpack10(x: number): FormatInfo {
  return {
    gridIndex: (x >> (MCS_BITS + 2)) & ((1 << GRID_INDEX_BITS) - 1),
    mcs: (x >> 2) & ((1 << MCS_BITS) - 1),
    level: x & 3,
  };
}

export function cornerBits(corner: number, info: FormatInfo): number[] {
  return codewordBits(pack(corner, info));
}

/**
 * Source index for transformed grid cell (r, c) under dihedral transform t, matching
 * numpy: optional transpose (t >= 4) then np.rot90(k = t % 4) (counter-clockwise).
 */
export function dihedralSource(n: number, t: number, r: number, c: number): [number, number] {
  let rr = r;
  let cc = c;
  // Undo the rotations one quarter-turn at a time: rot90 maps out[i][j] = in[j][n-1-i].
  for (let q = 0; q < t % 4; q++) {
    const nr = cc;
    const nc = n - 1 - rr;
    rr = nr;
    cc = nc;
  }
  if (t >= 4) return [cc, rr];
  return [rr, cc];
}

/** Apply dihedral transform t to an n x n grid with `ch` channels. */
export function dihedral(grid: Float64Array, n: number, ch: number, t: number): Float64Array {
  if (t === 0) return grid;
  const out = new Float64Array(grid.length);
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++) {
      const [sr, sc] = dihedralSource(n, t, r, c);
      for (let k = 0; k < ch; k++) out[(r * n + c) * ch + k] = grid[(sr * n + sc) * ch + k];
    }
  return out;
}

export interface FormatResult {
  info: FormatInfo;
  transform: number;
  score: number;
  margin: number;
}

/** soft: n*n values in [-1, 1], +1 = light (bit 0). */
export function decodeFormat(soft: Float64Array, n: number): FormatResult {
  const lay = buildLayout(n);
  const table = bipolarTable();
  const cands: [number, number, number][] = [];
  const s = new Float64Array(24);
  for (let t = 0; t < 8; t++) {
    const g = dihedral(soft, n, 1, t);
    const total = new Float64Array(1024);
    for (let corner = 0; corner < 4; corner++) {
      const cells = lay.formatCells[corner];
      for (let i = 0; i < 24; i++) s[i] = g[cells[i][0] * n + cells[i][1]];
      const baseInfo = corner << 10;
      for (let x = 0; x < 1024; x++) {
        const row = (baseInfo | x) * 24;
        let acc = 0;
        for (let i = 0; i < 24; i++) acc += table[row + i] * s[i];
        total[x] += acc;
      }
    }
    let best = 0;
    for (let x = 1; x < 1024; x++) if (total[x] > total[best]) best = x;
    let second = -Infinity;
    for (let x = 0; x < 1024; x++) if (x !== best && total[x] > second) second = total[x];
    cands.push([total[best], t, best], [second, t, -1]);
  }
  cands.sort((a, b) => b[0] - a[0]);
  const [top, t, idx] = cands[0];
  const runner = cands[1][0];
  const norm = 4 * 24;
  return { info: unpack10(idx < 0 ? 0 : idx), transform: t, score: top / norm, margin: (top - runner) / norm };
}
