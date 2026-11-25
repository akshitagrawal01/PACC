/** Map a PACC decode result onto the app's DecodeResponse shape. */
import type { DecodeResponse } from "@/lib/types";
import type { QcDecodeResult } from "./qc";
import type { WorkerDecodeResult } from "./worker";
import { LEVELS, PALETTES } from "./spec";

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return typeof btoa !== "undefined" ? btoa(binary) : Buffer.from(bytes).toString("base64");
}

function hexPreview(bytes: Uint8Array, max = 512): string {
  return Array.from(bytes.subarray(0, max), (b) => b.toString(16).padStart(2, "0").toUpperCase()).join(" ");
}

function security(r: WorkerDecodeResult): DecodeResponse["pacc2"] {
  const s = r.security;
  return {
    signed: s?.signed, signer: s?.signer, signatureValid: s?.signatureValid ?? null, trusted: s?.trusted,
    encrypted: s?.encrypted, recipientKid: s?.recipientKid, locked: r.locked,
    stream: r.stream ? { k: r.stream.k, rank: r.stream.rank, received: r.stream.received } : undefined,
    fine: r.fine ? fineSummary(r.fine) : undefined,
  };
}

function fineSummary(f: NonNullable<WorkerDecodeResult["fine"]>) {
  let text: string | undefined;
  if (f.ok && f.payload) {
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(f.payload);
    } catch {
      text = `0x${hexPreview(f.payload, 64).replace(/ /g, "")}`;
    }
  }
  return {
    ok: f.ok, text, error: f.ok ? undefined : f.error, locked: f.locked,
    encrypted: f.security?.encrypted, signed: f.security?.signed, signatureValid: f.security?.signatureValid ?? null,
  };
}

export function pacc2ToResponse(r: WorkerDecodeResult): DecodeResponse {
  if (r.ok && r.locked) {
    return {
      success: false, requiresPassword: r.locked === "password", encrypted: true, codeType: "PACC",
      error: r.locked === "password" ? "Password-protected PACC symbol. Enter the passphrase to decrypt."
        : `Encrypted for a recipient key (key id ${r.security?.recipientKid ?? "?"}). Add the matching private key.`,
      engine: "PACC native", durationMs: r.durationMs, pacc2: security(r),
    };
  }
  if (!r.ok || !r.payload) {
    return {
      success: false, error: r.error ?? "PACC decode failed", engine: "PACC native", durationMs: r.durationMs,
      pacc2: r.stream ? security(r) : undefined,
    };
  }
  let text = "";
  let isBinary = false;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(r.payload);
  } catch {
    isBinary = true;
  }
  const palette = r.mcs !== undefined ? PALETTES[r.mcs] : undefined;
  const level = r.level !== undefined ? LEVELS[r.level] : undefined;
  return {
    success: true,
    text,
    totalText: text,
    bytesLen: r.payload.length,
    totalBytesLen: r.payload.length,
    isBinary,
    hexPreview: isBinary ? hexPreview(r.payload) : undefined,
    payloadBase64: uint8ToBase64(r.payload),
    durationMs: r.durationMs,
    engine: "PACC native",
    bitsPerCell: palette?.bits,
    codeType: "PACC",
    // A layered symbol whose fine layer is passphrase-protected: show the coarse message and ask.
    requiresPassword: r.fine?.locked === "password",
    metadata: {
      gridSide: r.n ? `${r.n}x${r.n}` : null,
      eccLevel: level ? `${level[0]} (LDPC rate ${level[1]}/${level[2]})` : null,
      bitsPerCell: palette?.bits,
      passUsed: `PACC ${palette?.name ?? ""}${r.refineRounds ? ` · ${r.refineRounds} refinement round(s)` : ""}${
        r.framesCombined ? ` · ${r.framesCombined} frames combined` : ""}`,
      encrypted: Boolean(r.security?.encrypted),
    },
    encrypted: Boolean(r.security?.encrypted),
    pacc2: security(r),
  };
}

/** A QR whose hidden PACC chroma channel was read (or is locked). */
export function qcToResponse(r: QcDecodeResult, durationMs: number): DecodeResponse {
  const s = r.security;
  const visible = r.visible ?? "";
  let hiddenText: string | undefined;
  if (r.hidden) {
    try {
      hiddenText = new TextDecoder("utf-8", { fatal: true }).decode(r.hidden);
    } catch {
      hiddenText = `0x${hexPreview(r.hidden, 64).replace(/ /g, "")}`;
    }
  }
  return {
    success: true,
    text: visible,
    totalText: visible,
    bytesLen: visible.length,
    totalBytesLen: visible.length,
    durationMs,
    engine: "PACC QC (QR + hidden channel)",
    codeType: "PACC QC",
    requiresPassword: r.locked === "password",
    encrypted: Boolean(s?.encrypted),
    metadata: { gridSide: r.version ? `${17 + 4 * r.version}x${17 + 4 * r.version} (QR v${r.version})` : null, passUsed: "PACC QC" },
    pacc2: {
      signed: s?.signed, signer: s?.signer, signatureValid: s?.signatureValid ?? null, trusted: s?.trusted,
      encrypted: s?.encrypted, recipientKid: s?.recipientKid, locked: r.locked,
      qcHidden: hiddenText, qcBound: r.bound,
    },
  };
}

export const paccToResponse = pacc2ToResponse;
