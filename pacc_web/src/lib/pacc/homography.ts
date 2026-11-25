/**
 * PACC Projective Homography & Adaptive Core Sampling Engine.
 * 
 * Provides:
 * - 4-Point Projective Homography solver via 8x8 Gaussian elimination
 * - Backward coordinate mapping (u, v) -> (x, y)
 * - 3-Tier center-core adaptive sampling (sampleNearestRGB, sampleCenterGaussianRGB, sampleAdaptiveBoxRGB, sampleSharpCoreRGB)
 */

export interface Point2D {
  x: number;
  y: number;
}

export type Matrix3x3 = [
  number, number, number,
  number, number, number,
  number, number, number
];

/**
 * Solve an 8x8 linear system A * x = b using Gaussian elimination with partial pivoting.
 */
function solve8x8(A: number[][], b: number[]): number[] | null {
  const n = 8;
  const M: number[][] = Array.from({ length: n }, (_, i) => [...A[i], b[i]]);

  for (let i = 0; i < n; i++) {
    // Partial pivoting
    let maxRow = i;
    let maxVal = Math.abs(M[i][i]);
    for (let r = i + 1; r < n; r++) {
      const val = Math.abs(M[r][i]);
      if (val > maxVal) {
        maxVal = val;
        maxRow = r;
      }
    }
    if (maxVal < 1e-11) {
      return null; // Singular matrix
    }
    if (maxRow !== i) {
      const tmp = M[i];
      M[i] = M[maxRow];
      M[maxRow] = tmp;
    }

    const pivot = M[i][i];
    for (let c = i; c <= n; c++) {
      M[i][c] /= pivot;
    }

    for (let r = 0; r < n; r++) {
      if (r !== i) {
        const factor = M[r][i];
        if (factor !== 0) {
          for (let c = i; c <= n; c++) {
            M[r][c] -= factor * M[i][c];
          }
        }
      }
    }
  }

  return M.map((row) => row[n]);
}

/**
 * Compute the 3x3 Projective Homography matrix that maps destination coordinates (u, v)
 * to source coordinates (x, y).
 * 
 * dstPts: [TL, TR, BR, BL] in destination space (e.g. grid coordinates)
 * srcPts: [TL, TR, BR, BL] in source image space (camera frame pixels)
 */
export function getPerspectiveTransformDstToSrc(
  dstPts: [Point2D, Point2D, Point2D, Point2D],
  srcPts: [Point2D, Point2D, Point2D, Point2D]
): Matrix3x3 | null {
  const A: number[][] = [];
  const b: number[] = [];

  for (let i = 0; i < 4; i++) {
    const u = dstPts[i].x;
    const v = dstPts[i].y;
    const x = srcPts[i].x;
    const y = srcPts[i].y;

    // x equation: h00*u + h01*v + h02 - h20*u*x - h21*v*x = x
    A.push([u, v, 1, 0, 0, 0, -u * x, -v * x]);
    b.push(x);

    // y equation: h10*u + h11*v + h12 - h20*u*y - h21*v*y = y
    A.push([0, 0, 0, u, v, 1, -u * y, -v * y]);
    b.push(y);
  }

  const h = solve8x8(A, b);
  if (!h) return null;

  return [
    h[0], h[1], h[2],
    h[3], h[4], h[5],
    h[6], h[7], 1.0,
  ];
}


/**
 * Apply 3x3 homography matrix to destination point (u, v) -> returns source point (x, y).
 */
export function mapPoint(H: Matrix3x3, u: number, v: number): Point2D {
  const w = H[6] * u + H[7] * v + H[8];
  if (Math.abs(w) < 1e-9) {
    return { x: H[0] * u + H[1] * v + H[2], y: H[3] * u + H[4] * v + H[5] };
  }
  const invW = 1.0 / w;
  return {
    x: (H[0] * u + H[1] * v + H[2]) * invW,
    y: (H[3] * u + H[4] * v + H[5]) * invW,
  };
}


/**
 * Pure nearest integer center RGB sampling without cross-cell blending.
 * Eliminates Inter-Symbol Interference (ISI) on small cells (< 3.5 px).
 */
export function sampleNearestRGB(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  x: number,
  y: number
): [number, number, number] {
  const cx = Math.max(0, Math.min(width - 1, Math.round(x)));
  const cy = Math.max(0, Math.min(height - 1, Math.round(y)));
  const idx = (cy * width + cx) * 4;
  return [data[idx], data[idx + 1], data[idx + 2]];
}


/**
 * Adaptive box kernel average RGB sampling around (x, y) for noise suppression.
 * Samples within halfK radius (averages inner ~60% of cell).
 */
export function sampleAdaptiveBoxRGB(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  x: number,
  y: number,
  halfK: number = 1
): [number, number, number] {
  const k = Math.max(1, Math.round(halfK));
  let rSum = 0;
  let gSum = 0;
  let bSum = 0;
  let count = 0;

  const cx = Math.round(x);
  const cy = Math.round(y);

  for (let dy = -k; dy <= k; dy++) {
    const py = cy + dy;
    if (py < 0 || py >= height) continue;
    for (let dx = -k; dx <= k; dx++) {
      const px = cx + dx;
      if (px < 0 || px >= width) continue;
      const idx = (py * width + px) * 4;
      rSum += data[idx];
      gSum += data[idx + 1];
      bSum += data[idx + 2];
      count++;
    }
  }

  if (count === 0) return [255, 255, 255];
  return [Math.round(rSum / count), Math.round(gSum / count), Math.round(bSum / count)];
}

/**
 * 3x3 Gaussian-weighted core RGB sampling around (x, y).
 * Weights: [1, 2, 1; 2, 4, 2; 1, 2, 1] / 16.
 * Minimizes neighbor Inter-Symbol Interference (ISI) under optical defocus blur.
 */
export function sampleCenterGaussianRGB(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  x: number,
  y: number
): [number, number, number] {
  const cx = Math.round(x);
  const cy = Math.round(y);
  if (cx < 1 || cx >= width - 1 || cy < 1 || cy >= height - 1) {
    const idx = (Math.max(0, Math.min(height - 1, cy)) * width + Math.max(0, Math.min(width - 1, cx))) * 4;
    return [data[idx], data[idx + 1], data[idx + 2]];
  }

  const weights = [
    [1, 2, 1],
    [2, 4, 2],
    [1, 2, 1],
  ];

  let rSum = 0;
  let gSum = 0;
  let bSum = 0;

  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const w = weights[dy + 1][dx + 1];
      const idx = ((cy + dy) * width + (cx + dx)) * 4;
      rSum += data[idx] * w;
      gSum += data[idx + 1] * w;
      bSum += data[idx + 2] * w;
    }
  }

  return [Math.round(rSum / 16), Math.round(gSum / 16), Math.round(bSum / 16)];
}

/**
 * High-boost unsharp masking core RGB sampling around (x, y).
 * Sharpened = clip(center * (1 + strength) - gaussian_blur * strength, 0, 255).
 * Penetrates severe optical defocus and motion blur.
 */
export function sampleSharpCoreRGB(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  x: number,
  y: number,
  strength: number = 1.8
): [number, number, number] {
  const [cr, cg, cb] = sampleNearestRGB(data, width, height, x, y);
  const [gr, gg, gb] = sampleCenterGaussianRGB(data, width, height, x, y);
  const factor = 1.0 + strength;
  const sr = Math.min(255, Math.max(0, Math.round(cr * factor - gr * strength)));
  const sg = Math.min(255, Math.max(0, Math.round(cg * factor - gg * strength)));
  const sb = Math.min(255, Math.max(0, Math.round(cb * factor - gb * strength)));
  return [sr, sg, sb];
}

