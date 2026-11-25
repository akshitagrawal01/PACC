/** PACC format constants — twin of pacc2/spec.py (SPEC §1, §5, §6). */

export const QUIET_ZONE = 4;
export const FINDER = 7;
export const CORNER_BLOCK = 8;
export const GRID_MIN = 24;
export const GRID_STEP = 4;
export const GRID_INDEX_BITS = 5;
export const GRID_MAX = GRID_MIN + GRID_STEP * (2 ** GRID_INDEX_BITS - 1);
export const PILOT_PERIOD = 5;
export const PILOT_OFFSET = 2;
export const MCS_BITS = 3;
export const FLAG_DEFLATE = 0x01;
export const FLAG_SIGNED = 0x02;
export const FLAG_ENCRYPTED = 0x04;
export const FLAG_STREAM = 0x08;
export const FLAG_LAYERED = 0x10;
export const MESSAGE_OVERHEAD = 7;

export function gridSizes(): number[] {
  const out: number[] = [];
  for (let n = GRID_MIN; n <= GRID_MAX; n += GRID_STEP) out.push(n);
  return out;
}

export function gridIndex(n: number): number {
  if (n < GRID_MIN || n > GRID_MAX || (n - GRID_MIN) % GRID_STEP) throw new Error(`invalid PACC grid size ${n}`);
  return (n - GRID_MIN) / GRID_STEP;
}

export interface Palette {
  name: string;
  bits: number;
  rgb: [number, number, number][];
}

export const PALETTES: Record<number, Palette> = {
  0: { name: "BW", bits: 1, rgb: [[255, 255, 255], [0, 0, 0]] },
  1: { name: "KCMY", bits: 2, rgb: [[0, 0, 0], [0, 255, 255], [255, 0, 255], [255, 255, 0]] },
  2: {
    name: "CUBE8",
    bits: 3,
    rgb: [[0, 0, 0], [0, 0, 255], [0, 255, 0], [0, 255, 255], [255, 0, 0], [255, 0, 255], [255, 255, 0], [255, 255, 255]],
  },
};

export const LEVELS: Record<number, [string, number, number]> = {
  0: ["L", 4, 5],
  1: ["M", 2, 3],
  2: ["Q", 1, 2],
  3: ["H", 1, 3],
};

export function levelByName(name: string): number {
  for (const [k, v] of Object.entries(LEVELS)) if (v[0] === name.toUpperCase()) return Number(k);
  throw new Error(`unknown level ${name}`);
}

/** Palette as floats in [0, 1], row-major (M x 3). */
export function paletteArray(mcs: number): Float64Array {
  const p = PALETTES[mcs].rgb;
  const out = new Float64Array(p.length * 3);
  p.forEach((c, i) => {
    out[i * 3] = c[0] / 255;
    out[i * 3 + 1] = c[1] / 255;
    out[i * 3 + 2] = c[2] / 255;
  });
  return out;
}

export interface EccLevelInfo {
  level: number;
  label: string;
  rate: string;
  role: string;
}

export const ECC_LEVELS: EccLevelInfo[] = [
  { level: 0, label: "L", rate: "4/5", role: "High Capacity (rate 4/5)" },
  { level: 1, label: "M", rate: "2/3", role: "Balanced Default (rate 2/3)" },
  { level: 2, label: "Q", rate: "1/2", role: "Rugged (rate 1/2)" },
  { level: 3, label: "H", rate: "1/3", role: "Extreme Recovery (rate 1/3)" },
];

export function eccSummary(level: number): string {
  const info = ECC_LEVELS[level];
  return info ? `Rate ${info.rate} (${info.label})` : `Level ${level}`;
}
