"use client";
/**
 * Promise-based client for the PACC worker. One shared worker per page; frames are
 * transferred (zero-copy). `busy` lets a camera loop skip frames instead of queueing.
 */
import type { QcDecodeResult } from "./qc";
import type { WireSecrets, WireSecurity, WorkerDecodeResult } from "./worker";

export type { WireSecrets, WireSecurity, WorkerDecodeResult };

export interface EncodedImage {
  width: number;
  height: number;
  pixels: Uint8ClampedArray;
  meta: { n: number; mcs: number; level: number; payloadBytes: number; compressed: boolean; codeN: number; codeK: number };
}

type Pending = { resolve: (v: never) => void; reject: (e: Error) => void };

let worker: Worker | null = null;
const pending = new Map<number, Pending>();
let nextId = 1;
let inFlightDecodes = 0;

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (ev: MessageEvent<{ id: number; ok: boolean; result?: unknown; error?: string }>) => {
    const p = pending.get(ev.data.id);
    if (!p) return;
    pending.delete(ev.data.id);
    if (ev.data.ok) p.resolve(ev.data.result as never);
    else p.reject(new Error(ev.data.error ?? "PACC worker error"));
  };
  worker.onerror = (ev) => {
    for (const p of pending.values()) p.reject(new Error(ev.message || "PACC worker crashed"));
    pending.clear();
    worker?.terminate();
    worker = null;
  };
  return worker;
}

function call<T>(msg: Record<string, unknown>, transfer: Transferable[] = []): Promise<T> {
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: never) => void, reject });
    getWorker().postMessage({ ...msg, id }, transfer);
  });
}

/** True while a decode is running; camera loops should drop frames rather than queue them. */
export function pacc2Busy(): boolean {
  return inFlightDecodes > 0;
}

/** Decode an ImageData (its buffer is copied, so the caller keeps its frame).
 *  live: camera frame — enables multi-frame combining and PACC Stream reassembly. */
export async function decodePacc2(img: ImageData, opts: { live?: boolean } = {}): Promise<WorkerDecodeResult> {
  const copy = new Uint8ClampedArray(img.data);
  inFlightDecodes++;
  try {
    return await call<WorkerDecodeResult>(
      { type: "decode", width: img.width, height: img.height, buffer: copy.buffer, live: opts.live },
      [copy.buffer],
    );
  } finally {
    inFlightDecodes--;
  }
}

/** Re-open the last locked (password-encrypted) result: a symbol result, or { qc } for a QC hidden channel. */
export function unlockPacc2(password: string): Promise<WorkerDecodeResult | { qc: QcDecodeResult }> {
  return call<WorkerDecodeResult | { qc: QcDecodeResult }>({ type: "unlock", password });
}

/** Read the hidden PACC chroma channel of a QR found by zxing (corners TL, TR, BR, BL). */
export async function decodeQcPacc2(
  img: ImageData, corners: { x: number; y: number }[], version: number, visible: string,
): Promise<{ qc: QcDecodeResult; durationMs: number }> {
  const copy = new Uint8ClampedArray(img.data);
  return call({ type: "decodeQc", width: img.width, height: img.height, buffer: copy.buffer, corners, version, visible }, [copy.buffer]);
}

export function encodeQcPacc2(
  visible: string, hidden: Uint8Array, opts: { ec?: "L" | "M" | "Q" | "H"; security?: WireSecurity } = {},
): Promise<{ n: number; version: number; grid: Uint8Array; messageBytes: number }> {
  return call({ type: "encodeQc", visible, hidden, ...opts });
}

/** Trusted signer public keys and recipient private keys used by every decode. */
export function setPacc2Secrets(secrets: WireSecrets): Promise<boolean> {
  return call<boolean>({ type: "setSecrets", secrets });
}

/** Forget multi-frame and stream state (call when the camera starts or stops). */
export function resetPacc2Live(): Promise<boolean> {
  return call<boolean>({ type: "resetLive" });
}

export function encodePacc2(
  bytes: Uint8Array,
  opts: { mcs?: number; level?: string; cellSize?: number; security?: WireSecurity } = {},
): Promise<EncodedImage> {
  return call<EncodedImage>({ type: "encode", bytes, ...opts });
}

export interface StreamFrames {
  n: number;
  k: number;
  blockSize: number;
  messageBytes: number;
  grids: Uint8Array[];      // n*n*3 RGB per frame
}

/** Plan a PACC Stream and render frame grids: at least K, or K * (1 + repair) + 2. */
export function planPacc2Stream(
  bytes: Uint8Array,
  opts: { n?: number; mcs?: number; level?: string; security?: WireSecurity; frames: number; repair?: number },
): Promise<StreamFrames> {
  return call<StreamFrames>({ type: "planStream", bytes, ...opts });
}

/** Render an encoded symbol to a PNG data URL (browser only). */
export function encodedToDataUrl(img: EncodedImage): string {
  const canvas = document.createElement("canvas");
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas unavailable");
  ctx.putImageData(new ImageData(new Uint8ClampedArray(img.pixels), img.width, img.height), 0, 0);
  return canvas.toDataURL("image/png");
}

/** Distance-adaptive layered symbol: `coarse` reads from afar, `fine` up close (security applies to fine). */
export function encodeLayeredPacc2(
  coarse: Uint8Array, fine: Uint8Array, opts: { level?: string; security?: WireSecurity } = {},
): Promise<{ n: number; nf: number; grid: Uint8Array; fineCapacity: number }> {
  return call({ type: "encodeLayered", coarse, fine, ...opts });
}

export interface MatrixItemResult {
  n: number;
  mcs: number;
  level: number;
  grid: Uint8Array;
  codeN: number;
  codeK: number;
  compressed: boolean;
  encodeMs: number;
  decodeMs: number;
  decoded: boolean;
  signatureValid: boolean | null;
  encrypted?: string;
  error?: string;
}

/** Encode, render, decode and time one symbol in the worker (Matrix tab). */
export function matrixItemPacc(
  bytes: Uint8Array,
  opts: { mcs: number; level: string; minGrid?: number; compress?: boolean; cellSize?: number;
    security?: WireSecurity; secrets?: WireSecrets; password?: string },
): Promise<MatrixItemResult> {
  return call<MatrixItemResult>({ type: "matrixItem", bytes, ...opts });
}

export const encodePacc = encodePacc2;
export const encodeLayeredPacc = encodeLayeredPacc2;
export const decodePacc = decodePacc2;
export const encodeQcPacc = encodeQcPacc2;
export const decodeQcPacc = decodeQcPacc2;
export const planPaccStream = planPacc2Stream;
export const setPaccSecrets = setPacc2Secrets;
export const resetPaccLive = resetPacc2Live;
export const unlockPacc = unlockPacc2;
export const paccBusy = pacc2Busy;
