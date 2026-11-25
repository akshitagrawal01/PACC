import type { Point2D } from "./homography";

export interface FinderCandidate extends Point2D {
  r: number;
  score?: number;
}

export function computeOtsuThreshold(gray: Uint8Array, totalPixels: number): number {
  const hist = new Int32Array(256);
  for (let i = 0; i < totalPixels; i++) {
    hist[gray[i]]++;
  }

  const total = totalPixels;
  let sum = 0;
  for (let t = 0; t < 256; t++) {
    sum += t * hist[t];
  }

  let sumB = 0;
  let wB = 0;
  let varMax = 0;
  let first = 128;
  let last = 128;

  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;

    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;

    const varBetween = wB * wF * (mB - mF) * (mB - mF);
    if (varBetween > varMax * (1 + 1e-12)) {
      varMax = varBetween;
      first = last = t;
    } else if (varBetween >= varMax * (1 - 1e-12)) {
      last = t; // same split: the histogram is empty between first and last
    }
  }

  // Crisp images leave an empty gap between the classes, so the maximum is a plateau; its
  // first point sits on the edge of the dark class (e.g. a dark tint one level above it).
  // The middle of the plateau is the robust threshold.
  return Math.round((first + last + 1) / 2);
}

export interface FinderCandidate extends Point2D {
  r: number;
  score?: number;
}

/**
 * Robust 2-pass Connected Component Labeling (CCL) with Concentric Ring Verification.
 * Rotational & tilt invariant finder detector. Executes in ~4-8ms on 640x480 video frames.
 */
export function detectFindersCCL(
  gray: Uint8Array,
  width: number,
  height: number,
  threshold: number,
  roi?: { x: number; y: number; width: number; height: number }
): FinderCandidate[] {
  const roiX = roi ? Math.max(0, Math.floor(roi.x)) : 0;
  const roiY = roi ? Math.max(0, Math.floor(roi.y)) : 0;
  const roiW = roi ? Math.min(width - roiX, Math.ceil(roi.width)) : width;
  const roiH = roi ? Math.min(height - roiY, Math.ceil(roi.height)) : height;

  if (roiW < 18 || roiH < 18) return [];

  // Downsample 2x if region is large (>= 280px) for speed (runs in ~4-6ms)
  const scale = roiW >= 280 && roiH >= 280 ? 2 : 1;
  const sw = Math.floor(roiW / scale);
  const sh = Math.floor(roiH / scale);

  const labels = new Int32Array(sw * sh);
  const maxLabels = 20000;
  const parent = new Int32Array(maxLabels);
  for (let i = 0; i < maxLabels; i++) parent[i] = i;

  let nextLabel = 1;

  function find(i: number): number {
    let curr = i;
    while (parent[curr] !== curr) {
      parent[curr] = parent[parent[curr]];
      curr = parent[curr];
    }
    return curr;
  }

  function union(i: number, j: number) {
    const rootI = find(i);
    const rootJ = find(j);
    if (rootI !== rootJ) {
      if (rootI < rootJ) parent[rootJ] = rootI;
      else parent[rootI] = rootJ;
    }
  }

  // Pass 1: Connected components labeling on dark pixels
  for (let y = 0; y < sh; y++) {
    const srcY = roiY + y * scale;
    const srcRowOffset = srcY * width;
    const rowOffset = y * sw;

    for (let x = 0; x < sw; x++) {
      const srcX = roiX + x * scale;
      const isDark = gray[srcRowOffset + srcX] < threshold;
      if (!isDark) continue;

      const left = x > 0 ? labels[rowOffset + x - 1] : 0;
      const up = y > 0 ? labels[rowOffset - sw + x] : 0;

      if (left > 0 && up > 0) {
        labels[rowOffset + x] = left;
        union(left, up);
      } else if (left > 0) {
        labels[rowOffset + x] = left;
      } else if (up > 0) {
        labels[rowOffset + x] = up;
      } else {
        if (nextLabel < maxLabels - 1) {
          labels[rowOffset + x] = nextLabel;
          parent[nextLabel] = nextLabel;
          nextLabel++;
        }
      }
    }
  }

  // Pass 2: Component bounding box and centroid aggregation
  interface CompStats {
    count: number;
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
    sumX: number;
    sumY: number;
  }

  const compMap = new Map<number, CompStats>();
  for (let y = 0; y < sh; y++) {
    const rowOffset = y * sw;
    for (let x = 0; x < sw; x++) {
      const lbl = labels[rowOffset + x];
      if (lbl === 0) continue;
      const root = find(lbl);
      let s = compMap.get(root);
      if (!s) {
        s = { count: 0, minX: x, maxX: x, minY: y, maxY: y, sumX: 0, sumY: 0 };
        compMap.set(root, s);
      }
      s.count++;
      s.sumX += x;
      s.sumY += y;
      if (x < s.minX) s.minX = x;
      if (x > s.maxX) s.maxX = x;
      if (y < s.minY) s.minY = y;
      if (y > s.maxY) s.maxY = y;
    }
  }

  // Pass 3: Concentric ring verification with dual Box (pitch/yaw) and Area (rotation) scaling
  const finders: FinderCandidate[] = [];
  const minPixels = Math.max(2, Math.floor(4 / (scale * scale)));
  const maxPixels = Math.floor(6000 / (scale * scale));

  for (const s of compMap.values()) {
    if (s.count < minPixels || s.count > maxPixels) continue;

    const cx = roiX + (s.sumX / s.count) * scale;
    const cy = roiY + (s.sumY / s.count) * scale;
    const w = (s.maxX - s.minX + 1) * scale;
    const h = (s.maxY - s.minY + 1) * scale;
    const rBox = (w + h) / 4.0;
    const area = s.count * (scale * scale);
    const rArea = (Math.sqrt(area) / 3.0) * 1.5;
    const rBase = Math.min(rBox, rArea);

    // Allow down to 1.2px radius for distant finder detection
    if (rBase < 1.2 || rBase > Math.min(width, height) * 0.35) continue;

    // Aspect ratio check (finder center is roughly square/isometric)
    const aspect = w / Math.max(1, h);
    if (aspect < 0.38 || aspect > 2.65) continue;

    // Center pixel must be dark
    const icx = Math.round(cx);
    const icy = Math.round(cy);
    if (icx < 0 || icx >= width || icy < 0 || icy >= height) continue;
    if (gray[icy * width + icx] >= threshold) continue;

    if (rBase < 3.2) {
      // Fast 4-cardinal check for small/distant finders (avoids trigonometric rounding miss)
      let bestScore = 0;
      let bestR = rBase;

      for (const candR of [rBox, rArea]) {
        const d1 = Math.max(1, Math.round(1.4 * candR));
        const d2 = Math.max(2, Math.round(2.2 * candR));
        let lightCount = 0;
        let darkOuter = 0;

        const cardinals = [
          [d1, 0, d2, 0],
          [-d1, 0, -d2, 0],
          [0, d1, 0, d2],
          [0, -d1, 0, -d2],
        ];

        for (const [dx1, dy1, dx2, dy2] of cardinals) {
          const x1 = icx + dx1;
          const y1 = icy + dy1;
          if (x1 >= 0 && x1 < width && y1 >= 0 && y1 < height && gray[y1 * width + x1] >= threshold) {
            lightCount++;
          }
          const x2 = icx + dx2;
          const y2 = icy + dy2;
          if (x2 >= 0 && x2 < width && y2 >= 0 && y2 < height && gray[y2 * width + x2] < threshold) {
            darkOuter++;
          }
        }

        if (lightCount >= 3 && darkOuter >= 3) {
          const sc = lightCount / 4 + darkOuter / 4;
          if (sc > bestScore) {
            bestScore = sc;
            bestR = candR;
          }
        }
      }

      if (bestScore > 0) {
        if (!finders.some((f) => Math.hypot(f.x - cx, f.y - cy) < bestR * 2.0)) {
          finders.push({
            x: Math.round(cx * 10) / 10,
            y: Math.round(cy * 10) / 10,
            r: bestR,
            score: bestScore,
          });
        }
      }
    } else {
      // Concentric geometry test for medium/large finders:
      // Evaluates both Box geometry (elliptical 3D pitch/yaw) and Isotropic Area geometry (in-plane 45° rotation)
      let bestScore = 0;
      let bestR = rBox;

      const candidates = [
        { rx: Math.max(1.5, w / 2.0), ry: Math.max(1.5, h / 2.0), r: rBox },
        { rx: Math.max(1.5, rArea), ry: Math.max(1.5, rArea), r: rArea },
      ];

      for (const cand of candidates) {
        let lightCount = 0;
        let darkOuter = 0;

        for (let a = 0; a < 12; a++) {
          const angle = (a * 2.0 * Math.PI) / 12.0;
          const cosA = Math.cos(angle);
          const sinA = Math.sin(angle);

          // Light ring (1.38x radius)
          const x1 = Math.round(cx + 1.38 * cand.rx * cosA);
          const y1 = Math.round(cy + 1.38 * cand.ry * sinA);
          if (x1 >= 0 && x1 < width && y1 >= 0 && y1 < height && gray[y1 * width + x1] >= threshold) {
            lightCount++;
          }

          // Dark outer ring (2.15x radius)
          const x2 = Math.round(cx + 2.15 * cand.rx * cosA);
          const y2 = Math.round(cy + 2.15 * cand.ry * sinA);
          if (x2 >= 0 && x2 < width && y2 >= 0 && y2 < height && gray[y2 * width + x2] < threshold) {
            darkOuter++;
          }
        }

        // Damage & scratch resilient: 6/12 light ring and 5/12 dark outer ring
        if (lightCount >= 6 && darkOuter >= 5) {
          const sc = (lightCount / 12.0) + (darkOuter / 12.0) + 0.5 * (Math.min(w, h) / Math.max(w, h));
          if (sc > bestScore) {
            bestScore = sc;
            bestR = cand.r;
          }
        }
      }

      if (bestScore > 0) {
        const existingIdx = finders.findIndex((f) => Math.hypot(f.x - cx, f.y - cy) < bestR * 1.8);
        if (existingIdx >= 0) {
          if ((finders[existingIdx].score ?? 0) < bestScore) {
            finders[existingIdx] = {
              x: Math.round(cx * 10) / 10,
              y: Math.round(cy * 10) / 10,
              r: bestR,
              score: bestScore,
            };
          }
        } else {
          finders.push({
            x: Math.round(cx * 10) / 10,
            y: Math.round(cy * 10) / 10,
            r: bestR,
            score: bestScore,
          });
        }
      }
    }
  }

  // Post-filter & sort finders:
  if (finders.length > 1) {
    const maxR = Math.max(...finders.map((f) => f.r));
    let pool = finders;
    if (maxR >= 5.0) {
      pool = finders.filter((f) => f.r >= maxR * 0.45 || (f.score ?? 0) >= 1.5);
      if (pool.length < 2) pool = finders;
    }
    // Sort pool by confidence score * radius descending
    pool.sort((a, b) => {
      const scoreA = (a.score ?? 1.0) * Math.sqrt(a.r);
      const scoreB = (b.score ?? 1.0) * Math.sqrt(b.r);
      return scoreB - scoreA;
    });
    return pool;
  }

  return finders;
}


/**
 * 1:1:3:1:1 Scanline Finder Pattern Detector with CCL fast-path.
 * Automatically tries rotation-invariant CCL first; falls back to 1:1:3:1:1 scanlines.
 */
