/** Cell roles for an N x N symbol — twin of pacc2/layout.py (SPEC §3). */
import { CORNER_BLOCK, FINDER, PILOT_OFFSET, PILOT_PERIOD } from "./spec";

export const ROLE_DATA = 0;
export const ROLE_FIXED = 1;
export const ROLE_FORMAT = 2;
export const ROLE_PILOT = 3;

const FORMAT_TL: [number, number][] = [];
for (let c = 0; c < 8; c++) FORMAT_TL.push([8, c]);
for (let r = 0; r < 9; r++) FORMAT_TL.push([r, 8]);
for (let c = 0; c < 7; c++) FORMAT_TL.push([9, c]);

export function cornerCells(n: number, corner: number, cells: [number, number][]): [number, number][] {
  return cells.map(([r, c]) => {
    let rr = r;
    let cc = c;
    if (corner === 1 || corner === 2) cc = n - 1 - c;
    if (corner === 2 || corner === 3) rr = n - 1 - r;
    return [rr, cc];
  });
}

export function pilotIndex(r: number, c: number, paletteSize: number): number {
  return (Math.floor(r / PILOT_PERIOD) + 3 * Math.floor(c / PILOT_PERIOD)) % paletteSize;
}

export interface Layout {
  n: number;
  role: Uint8Array;          // n*n
  knownDark: Uint8Array;     // n*n, 1 = finder dark cell
  knownLight: Uint8Array;    // n*n, 1 = finder light cell or separator
  formatCells: [number, number][][];
  pilotCells: Int32Array;    // flat index r*n + c
  dataCells: Int32Array;     // flat index, row-major
}

const cache = new Map<number, Layout>();

export function buildLayout(n: number): Layout {
  const hit = cache.get(n);
  if (hit) return hit;
  const role = new Uint8Array(n * n);
  const dark = new Uint8Array(n * n);
  const light = new Uint8Array(n * n);
  for (let corner = 0; corner < 4; corner++) {
    const r0 = corner === 0 || corner === 1 ? 0 : n - CORNER_BLOCK;
    const c0 = corner === 0 || corner === 3 ? 0 : n - CORNER_BLOCK;
    for (let r = r0; r < r0 + CORNER_BLOCK; r++)
      for (let c = c0; c < c0 + CORNER_BLOCK; c++) {
        role[r * n + c] = ROLE_FIXED;
        light[r * n + c] = 1;
      }
    const fr = corner === 0 || corner === 1 ? 0 : n - FINDER;
    const fc = corner === 0 || corner === 3 ? 0 : n - FINDER;
    for (let i = 0; i < FINDER; i++)
      for (let j = 0; j < FINDER; j++) {
        const ring = i === 0 || j === 0 || i === FINDER - 1 || j === FINDER - 1;
        const core = i >= 2 && i <= 4 && j >= 2 && j <= 4;
        if (ring || core) {
          dark[(fr + i) * n + fc + j] = 1;
          light[(fr + i) * n + fc + j] = 0;
        }
      }
  }
  const formatCells: [number, number][][] = [];
  for (let corner = 0; corner < 4; corner++) {
    const cells = cornerCells(n, corner, FORMAT_TL);
    for (const [r, c] of cells) {
      if (role[r * n + c] !== ROLE_DATA) throw new Error(`format cell overlap at N=${n}`);
      role[r * n + c] = ROLE_FORMAT;
    }
    formatCells.push(cells);
  }
  const pilots: number[] = [];
  for (let r = PILOT_OFFSET; r < n; r += PILOT_PERIOD)
    for (let c = PILOT_OFFSET; c < n; c += PILOT_PERIOD)
      if (role[r * n + c] === ROLE_DATA) {
        role[r * n + c] = ROLE_PILOT;
        pilots.push(r * n + c);
      }
  const data: number[] = [];
  for (let i = 0; i < n * n; i++) if (role[i] === ROLE_DATA) data.push(i);
  const lay: Layout = {
    n, role, knownDark: dark, knownLight: light, formatCells,
    pilotCells: Int32Array.from(pilots), dataCells: Int32Array.from(data),
  };
  cache.set(n, lay);
  return lay;
}
