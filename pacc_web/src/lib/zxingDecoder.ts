/**
 * zxingDecoder.ts
 * ---------------
 * Thin singleton wrapper around zxing-wasm/reader (ZXing-C++ compiled to WASM).
 * Lazily initialises the WASM module on first call so there is zero startup cost.
 *
 * Supported formats cover QR Code (all variants), Data Matrix, Aztec, PDF417,
 * Code 128/39/93, EAN, ITF, Codabar, MaxiCode, and more.
 *
 * Usage:
 *   import { decodeWithZXing } from "@/lib/zxingDecoder";
 *   const result = await decodeWithZXing(imageData);   // ImageData from canvas
 *   if (result) console.log(result.text, result.format);
 */

export interface ZXingResult {
  text: string;
  format: string;
  /** Outer symbol corners TL, TR, BR, BL (image pixels), when reported. */
  corners?: { x: number; y: number }[];
  /** QR version, when reported. */
  version?: number;
}

type RawResult = {
  isValid: boolean;
  text: string;
  format: string;
  position?: Record<"topLeft" | "topRight" | "bottomRight" | "bottomLeft", { x: number; y: number }>;
  extra?: string;
  version?: string;
};

function toResult(r: RawResult): ZXingResult {
  let version: number | undefined;
  try {
    const extra = r.extra ? (JSON.parse(r.extra) as { Version?: string | number }) : {};
    version = Number(extra.Version ?? r.version) || undefined;
  } catch {
    version = Number(r.version) || undefined;
  }
  const p = r.position;
  return {
    text: r.text,
    format: r.format,
    version,
    corners: p ? [p.topLeft, p.topRight, p.bottomRight, p.bottomLeft].map(({ x, y }) => ({ x, y })) : undefined,
  };
}

// ---------------------------------------------------------------------------
// Module-level singleton promise — WASM loads only once per page lifetime
// ---------------------------------------------------------------------------
type ReadBarcodesFromImageData = (
  imageData: ImageData,
  options?: Record<string, unknown>
) => Promise<RawResult[]>;

let _readerPromise: Promise<ReadBarcodesFromImageData> | null = null;

function getReader(): Promise<ReadBarcodesFromImageData> {
  if (!_readerPromise) {
    _readerPromise = (async () => {
      // Dynamically import so Next.js SSR doesn't try to run WASM on the server
      const mod = await import("zxing-wasm/reader");

      // v3 API: readBarcodesFromImageData
      const fn = (mod as { readBarcodesFromImageData?: ReadBarcodesFromImageData }).readBarcodesFromImageData;
      if (typeof fn !== "function") {
        throw new Error("zxing-wasm: readBarcodesFromImageData not found");
      }
      return fn;
    })();
  }
  return _readerPromise;
}

// ---------------------------------------------------------------------------
// Public decode function
// ---------------------------------------------------------------------------
/**
 * Attempt to decode all barcodes in the given ImageData using ZXing-C++ WASM.
 * Returns the first valid result, or null if nothing was found.
 *
 * @param imageData  Raw pixel data from a <canvas> context (RGBA, 4 bytes/px).
 * @param formats    Optional whitelist of format strings, e.g. ["QRCode"].
 *                   Defaults to all readable formats for maximum flexibility.
 */
export async function decodeWithZXing(
  imageData: ImageData,
  formats?: string[]
): Promise<ZXingResult | null> {
  try {
    const readBarcodes = await getReader();

    const opts: Record<string, unknown> = {
      tryHarder: true,
      tryRotate: true,
      tryInvert: true,
    };
    if (formats && formats.length > 0) {
      opts.formats = formats;
    }

    const results = await readBarcodes(imageData, opts);
    const first = results.find((r) => r.isValid && r.text);
    if (!first) return null;
    return toResult(first);
  } catch (err) {
    console.warn("[zxingDecoder] decode error:", err);
    return null;
  }
}

/**
 * Fast live-frame decode for the camera loop.
 *
 * Disables tryHarder / tryRotate / tryInvert so ZXing does a single forward
 * pass instead of 4 rotations + inversion.  Suitable for 30–60 FPS loops
 * where the barcode is expected to be roughly upright.
 *
 * Falls back to the full decode on failure only when `allowFallback` is true
 * (useful for the first cold frame before tracking is established).
 *
 * @param imageData   Raw RGBA ImageData from a canvas context.
 * @param formats     Optional format whitelist, e.g. ["QRCode"].
 * @param allowFallback  If true, retries with full options on failure (slower).
 */
export async function decodeWithZXingLive(
  imageData: ImageData,
  formats?: string[],
  allowFallback = false
): Promise<ZXingResult | null> {
  try {
    const readBarcodes = await getReader();

    const fastOpts: Record<string, unknown> = {
      tryHarder: false,
      tryRotate: false,
      tryInvert: false,
      downscaleThreshold: 400,
    };
    if (formats && formats.length > 0) {
      fastOpts.formats = formats;
    }

    const results = await readBarcodes(imageData, fastOpts);
    const first = results.find((r) => r.isValid && r.text);
    if (first) return toResult(first);

    // Optional fallback: full scan with rotation/inversion for the first cold frame
    if (allowFallback) {
      return decodeWithZXing(imageData, formats);
    }

    return null;
  } catch (err) {
    console.warn("[zxingDecoder] live decode error:", err);
    return null;
  }
}

/**
 * Warm-up: eagerly load the WASM module in the background.
 * Call this once early (e.g. on component mount) to eliminate
 * the first-decode latency penalty.
 */
export function prewarmZXing(): void {
  getReader().catch(() => {}); // fire-and-forget, errors are silenced
}
