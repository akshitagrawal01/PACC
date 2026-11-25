/// <reference lib="webworker" />
/**
 * PACC Web Worker: decodes and encodes off the UI thread, and keeps the live-camera
 * state (multi-frame combining, stream reassembly, the last locked result).
 *
 * Messages in (all carry `id`):
 *   decode       { width, height, buffer (RGBA, transferred), live? }
 *   unlock       { password }                       -> re-opens the last locked result
 *   setSecrets   { trustedSigners?, recipientPrivateHex?, pqRecipientSeedHex? }
 *   resetLive    {}                                 -> drop combining / stream state
 *   encode       { bytes, mcs?, level?, cellSize?, security? }
 *   planStream   { bytes, n?, mcs?, level?, security?, frames, repair? }
 *   decodeQc     { width, height, buffer, corners, version, visible } -> hidden channel of a QR
 *   encodeQc     { visible, hidden, ec?, security? }
 *   encodeLayered { coarse, fine, level?, security? }   -> distance-adaptive symbol (security on the fine layer)
 *   matrixItem   { bytes, mcs, level, minGrid?, compress?, cellSize?, security?, secrets?, password? }
 *                -> encode, render, decode and time one symbol (Matrix tab)
 * Messages out: { id, ok: true, result } | { id, ok: false, error }
 */
import { unlock, type DecodeResult } from "./codec";
import { FrameCombiner } from "./combine";
import { decodeImage, encodeToImageDataAsync, type ImageDecodeResult } from "./index";
import {
  fromHex, pqRecipientKeyFromSeed, recipientKeyFromPrivate, signingKeyFromSeed, type OpenResult, type SealOptions, type Secrets,
} from "./secure";
import { encodeLayeredAsync, unlockFine } from "./hier";
import { qcDecodeAt, qcEncodeAsync, qcUnlock, type QcDecodeResult } from "./qc";
import { FLAG_STREAM } from "./spec";
import { StreamDecoder, planStreamAsync, streamFrame, type StreamStatus } from "./stream";

/** Serialisable security options (keys as hex). */
export interface WireSecurity {
  sign?: { alg: number; seedHex: string; embed: boolean };
  password?: string;
  kdfProfile?: number;
  recipientHex?: string;
  /** X-Wing (ML-KEM-768 + X25519) public key: post-quantum recipient encryption. */
  recipientPqHex?: string;
}

export interface WireSecrets {
  trustedSigners?: { alg: number; publicKeyHex: string; fingerprint: string }[];
  recipientPrivateHex?: string[];
  /** X-Wing 32-byte seeds (post-quantum recipient keys). */
  pqRecipientSeedHex?: string[];
}

export interface WorkerDecodeResult extends ImageDecodeResult {
  stream?: StreamStatus;
}

type Req = { id: number } & (
  | { type: "decode"; width: number; height: number; buffer: ArrayBuffer; live?: boolean }
  | { type: "unlock"; password: string }
  | { type: "setSecrets"; secrets: WireSecrets }
  | { type: "resetLive" }
  | { type: "encode"; bytes: Uint8Array; mcs?: number; level?: string; cellSize?: number; security?: WireSecurity }
  | { type: "planStream"; bytes: Uint8Array; n?: number; mcs?: number; level?: string; security?: WireSecurity; frames: number; repair?: number }
  | { type: "decodeQc"; width: number; height: number; buffer: ArrayBuffer; corners: { x: number; y: number }[]; version: number; visible: string }
  | { type: "encodeQc"; visible: string; hidden: Uint8Array; ec?: "L" | "M" | "Q" | "H"; security?: WireSecurity }
  | { type: "encodeLayered"; coarse: Uint8Array; fine: Uint8Array; level?: string; security?: WireSecurity }
  | {
      type: "matrixItem"; bytes: Uint8Array; mcs: number; level: string; minGrid?: number; compress?: boolean;
      cellSize?: number; security?: WireSecurity; secrets?: WireSecrets; password?: string;
    }
);

let secrets: Secrets = {};
let combiner = new FrameCombiner();
let streamDec = new StreamDecoder();
let lastLocked: DecodeResult | null = null;
let lastLockedQc: QcDecodeResult | null = null;

function wireToSecrets(w: WireSecrets): Secrets {
  const trusted: Secrets["trustedSigners"] = {};
  for (const t of w.trustedSigners ?? []) trusted[t.fingerprint] = { alg: t.alg, publicKey: fromHex(t.publicKeyHex) };
  return {
    trustedSigners: trusted,
    recipientKeys: (w.recipientPrivateHex ?? []).map((h) => recipientKeyFromPrivate(fromHex(h))),
    pqRecipientKeys: (w.pqRecipientSeedHex ?? []).map((h) => pqRecipientKeyFromSeed(fromHex(h))),
  };
}

function toSeal(s?: WireSecurity): SealOptions | undefined {
  if (!s) return undefined;
  return {
    signWith: s.sign ? signingKeyFromSeed(s.sign.alg, fromHex(s.sign.seedHex)) : undefined,
    embedPublicKey: s.sign?.embed ?? true,
    password: s.password || undefined,
    kdfProfile: s.kdfProfile,
    recipient: s.recipientHex ? fromHex(s.recipientHex) : undefined,
    recipientPq: s.recipientPqHex ? fromHex(s.recipientPqHex) : undefined,
  };
}

function withOpened(r: ImageDecodeResult, flags: number, body: Uint8Array, opened: OpenResult): ImageDecodeResult {
  const failed = Boolean(opened.error && !opened.locked);
  return {
    ...r, ok: !failed, flags, body, security: opened, locked: opened.locked,
    payload: opened.payload, error: failed ? opened.error : undefined,
  };
}

function handleDecode(msg: Extract<Req, { type: "decode" }>): WorkerDecodeResult {
  const img = { data: new Uint8ClampedArray(msg.buffer), width: msg.width, height: msg.height };
  const r: WorkerDecodeResult = decodeImage(img, { live: msg.live, secrets, combiner: msg.live ? combiner : undefined });
  if (r.ok && r.flags !== undefined && r.flags & FLAG_STREAM && r.payload) {
    const status = streamDec.add(r.payload);
    if (!status) return { ...r, ok: false, error: "malformed PACC Stream frame" };
    if (!status.complete) {
      return { ...r, ok: false, payload: undefined, stream: status, error: `PACC Stream: ${status.rank}/${status.k} blocks — keep scanning` };
    }
    const message = streamDec.message()!;
    const out: WorkerDecodeResult = { ...withOpened(r, streamDec.flags, message, streamDec.open(secrets)!), stream: status };
    if (out.locked) {
      lastLocked = out;
      lastLockedQc = null;
    }
    streamDec = new StreamDecoder();
    return out;
  }
  if (r.locked || r.fine?.locked) {
    lastLocked = r;
    lastLockedQc = null;
  }
  return r;
}

self.onmessage = async (ev: MessageEvent<Req>) => {
  const msg = ev.data;
  const post = (result: unknown, transfer: Transferable[] = []) =>
    (self as unknown as Worker).postMessage({ id: msg.id, ok: true, result }, transfer);
  try {
    switch (msg.type) {
      case "decode":
        post(handleDecode(msg));
        break;
      case "unlock": {
        if (lastLocked?.fine?.locked && !lastLocked.locked) {
          // Only the fine layer of a layered symbol is locked.
          const fine = await unlockFine(lastLocked.fine, { ...secrets, password: msg.password });
          const r = { ...lastLocked, fine };
          if (!fine.locked) lastLocked = null;
          post(r);
          break;
        }
        if (lastLockedQc) {
          const q = await qcUnlock(lastLockedQc, { ...secrets, password: msg.password });
          if (!q.locked) lastLockedQc = null;
          post({ qc: q });
          break;
        }
        if (!lastLocked) throw new Error("nothing to unlock");
        const r = await unlock(lastLocked, { ...secrets, password: msg.password });
        if (!r.locked) lastLocked = null;
        post(r);
        break;
      }
      case "setSecrets": {
        secrets = wireToSecrets(msg.secrets);
        post(true);
        break;
      }
      case "matrixItem": {
        const t0 = performance.now();
        const { imageData, meta } = await encodeToImageDataAsync(msg.bytes, {
          mcs: msg.mcs, level: msg.level, minGrid: msg.minGrid, compress: msg.compress, cellSize: msg.cellSize ?? 4,
          security: toSeal(msg.security),
        });
        const encodeMs = performance.now() - t0;
        const t1 = performance.now();
        const itemSecrets = msg.secrets ? wireToSecrets(msg.secrets) : {};
        let r: DecodeResult = decodeImage(imageData, { secrets: itemSecrets });
        if (r.locked === "password" && msg.password) r = await unlock(r, { ...itemSecrets, password: msg.password });
        const decodeMs = performance.now() - t1;
        const decoded = r.ok && !r.locked && !!r.payload && r.payload.length === msg.bytes.length
          && r.payload.every((v, i) => v === msg.bytes[i]);
        post({
          n: meta.n, mcs: meta.mcs, level: meta.level, grid: meta.grid, codeN: meta.codeN, codeK: meta.codeK,
          compressed: meta.compressed, encodeMs, decodeMs, decoded,
          signatureValid: r.security?.signatureValid ?? null, encrypted: r.security?.encrypted, error: decoded ? undefined : r.error,
        }, [meta.grid.buffer]);
        break;
      }
      case "decodeQc": {
        const img = { data: new Uint8ClampedArray(msg.buffer), width: msg.width, height: msg.height };
        const corners = msg.corners as [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }, { x: number; y: number }];
        const t0 = performance.now();
        const r = qcDecodeAt(img, corners, msg.version, msg.visible, secrets);
        if (r.locked) {
          lastLockedQc = r;
          lastLocked = null;
        }
        post({ qc: r, durationMs: Math.round(performance.now() - t0) });
        break;
      }
      case "encodeQc": {
        const e = await qcEncodeAsync(msg.visible, msg.hidden, { ec: msg.ec, security: toSeal(msg.security) });
        post({ n: e.n, version: e.version, grid: e.grid, messageBytes: e.messageBytes }, [e.grid.buffer]);
        break;
      }
      case "encodeLayered": {
        const e = await encodeLayeredAsync(msg.coarse, msg.fine, { level: msg.level ?? "H", fineSecurity: toSeal(msg.security) });
        post({ n: e.n, nf: e.nf, grid: e.grid, fineCapacity: e.fineCapacity }, [e.grid.buffer]);
        break;
      }
      case "resetLive":
        combiner = new FrameCombiner();
        streamDec = new StreamDecoder();
        post(true);
        break;
      case "encode": {
        const { imageData, meta } = await encodeToImageDataAsync(msg.bytes, {
          mcs: msg.mcs, level: msg.level, cellSize: msg.cellSize, security: toSeal(msg.security),
        });
        const pixels = imageData.data;
        post({ width: imageData.width, height: imageData.height, pixels, meta: { ...meta, grid: undefined } }, [pixels.buffer]);
        break;
      }
      case "planStream": {
        const p = await planStreamAsync(msg.bytes, { n: msg.n, mcs: msg.mcs, level: msg.level, security: toSeal(msg.security) });
        // At least K frames; `repair` adds that fraction of K in repair frames (+2).
        const count = Math.max(msg.frames, msg.repair ? Math.ceil(p.k * (1 + msg.repair)) + 2 : p.k);
        const grids = Array.from({ length: count }, (_, esi) => streamFrame(p, esi).grid);
        post({ n: p.n, k: p.k, blockSize: p.blockSize, messageBytes: p.message.length, grids }, grids.map((g) => g.buffer));
        break;
      }
    }
  } catch (e) {
    (self as unknown as Worker).postMessage({ id: msg.id, ok: false, error: e instanceof Error ? e.message : String(e) });
  }
};
