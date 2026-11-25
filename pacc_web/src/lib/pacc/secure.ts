/**
 * Signatures and encryption for PACC messages — twin of pacc2/secure.py
 * (layouts are documented there and in docs/pacc2/SPEC.md).
 *
 * Everything is synchronous except the password (Argon2id) path, which needs
 * hash-wasm: use sealAsync / unlockAsync for passwords.
 */
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { expand, extract } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { ml_kem768_x25519 } from "@noble/post-quantum/hybrid.js";
import { ml_dsa44 } from "@noble/post-quantum/ml-dsa.js";
import { argon2id } from "hash-wasm";
import { deflateRaw, inflateRaw } from "pako";
import { FLAG_DEFLATE, FLAG_ENCRYPTED, FLAG_LAYERED, FLAG_SIGNED, FLAG_STREAM } from "./spec";

const MAX_INFLATE = 16 * 1024 * 1024;
const KNOWN_FLAGS = FLAG_DEFLATE | FLAG_SIGNED | FLAG_ENCRYPTED | FLAG_STREAM | FLAG_LAYERED;
const enc = new TextEncoder();
const SIG_CONTEXT = enc.encode("PACC-SIG-v1\0");
const ENC_CONTEXT = enc.encode("PACC-ENC-v1");

export const ALG_ED25519 = 1;
export const ALG_MLDSA44 = 2;
const ALG_EMBEDDED = 0x80;
const SIG_SIZES: Record<number, number> = { 1: 64, 2: 2420 };
const PUB_SIZES: Record<number, number> = { 1: 32, 2: 1312 };
export const ALG_NAMES: Record<number, string> = { 1: "Ed25519", 2: "ML-DSA-44" };
const FINGERPRINT_LEN = 8;

const MODE_PASSWORD = 1;
const MODE_RECIPIENT = 2;
const MODE_RECIPIENT_PQ = 3;
const XWING_ENC_LEN = 1120;
const XWING_PUBLIC_LEN = 1216;
export const KDF_PROFILES: Record<number, { timeCost: number; memoryKiB: number; parallelism: number }> = {
  0: { timeCost: 2, memoryKiB: 19 * 1024, parallelism: 1 },
  1: { timeCost: 3, memoryKiB: 64 * 1024, parallelism: 1 },
};
const RECIPIENT_KID_LEN = 4;

// ── Bytes ─────────────────────────────────────────────────────────────────────

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
export function fromHex(h: string): Uint8Array {
  const s = h.replace(/\s+/g, "");
  if (s.length % 2 || /[^0-9a-f]/i.test(s)) throw new Error("invalid hex");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
  return out;
}
const randomBytes = (n: number) => crypto.getRandomValues(new Uint8Array(n));

// ── Keys ──────────────────────────────────────────────────────────────────────

export function fingerprint(alg: number, publicKey: Uint8Array): Uint8Array {
  return sha256(concat(Uint8Array.of(alg & 0x0f), publicKey)).slice(0, FINGERPRINT_LEN);
}

export interface SigningKey {
  alg: number;
  seed: Uint8Array;        // 32-byte seed (Ed25519 private key / ML-DSA keygen seed)
  publicKey: Uint8Array;
}

export function signingKeyFromSeed(alg: number, seed: Uint8Array): SigningKey {
  if (alg === ALG_ED25519) return { alg, seed, publicKey: ed25519.getPublicKey(seed) };
  if (alg === ALG_MLDSA44) return { alg, seed, publicKey: ml_dsa44.keygen(seed).publicKey };
  throw new Error(`unsupported signature algorithm ${alg}`);
}

export const generateSigningKey = (alg = ALG_ED25519) => signingKeyFromSeed(alg, randomBytes(32));

function sign(key: SigningKey, msg: Uint8Array): Uint8Array {
  if (key.alg === ALG_ED25519) return ed25519.sign(msg, key.seed);
  return ml_dsa44.sign(msg, ml_dsa44.keygen(key.seed).secretKey);
}

export function verifySignature(alg: number, publicKey: Uint8Array, sig: Uint8Array, msg: Uint8Array): boolean {
  try {
    if (alg === ALG_ED25519) return ed25519.verify(sig, msg, publicKey);
    if (alg === ALG_MLDSA44) return ml_dsa44.verify(sig, msg, publicKey);
  } catch {
    /* malformed key or signature */
  }
  return false;
}

export interface RecipientKey {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}

export function recipientKeyFromPrivate(privateKey: Uint8Array): RecipientKey {
  return { privateKey, publicKey: x25519.getPublicKey(privateKey) };
}
export const generateRecipientKey = () => recipientKeyFromPrivate(randomBytes(32));

export function recipientKid(publicKey: Uint8Array): Uint8Array {
  return sha256(concat(enc.encode("PACC-X25519"), publicKey)).slice(0, RECIPIENT_KID_LEN);
}

// ── HPKE base mode (RFC 9180): DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, ChaCha20-Poly1305

const HPKE_V1 = enc.encode("HPKE-v1");
const i2osp = (v: number, n: number) => Uint8Array.from({ length: n }, (_, i) => (v >>> (8 * (n - 1 - i))) & 0xff);
const KEM_SUITE = concat(enc.encode("KEM"), i2osp(0x0020, 2));
const hpkeSuite = (kem: number) => concat(enc.encode("HPKE"), i2osp(kem, 2), i2osp(0x0001, 2), i2osp(0x0003, 2));
const HPKE_SUITE = hpkeSuite(0x0020);
const HPKE_SUITE_XWING = hpkeSuite(0x647a); // X-Wing: ML-KEM-768 + X25519

const labeledExtract = (suite: Uint8Array, salt: Uint8Array, label: string, ikm: Uint8Array) =>
  extract(sha256, concat(HPKE_V1, suite, enc.encode(label), ikm), salt);
const labeledExpand = (suite: Uint8Array, prk: Uint8Array, label: string, info: Uint8Array, L: number) =>
  expand(sha256, prk, concat(i2osp(L, 2), HPKE_V1, suite, enc.encode(label), info), L);

function keyScheduleFromShared(suite: Uint8Array, shared: Uint8Array, info: Uint8Array) {
  const empty = new Uint8Array(0);
  const pskIdHash = labeledExtract(suite, empty, "psk_id_hash", empty);
  const infoHash = labeledExtract(suite, empty, "info_hash", info);
  const ctx = concat(Uint8Array.of(0), pskIdHash, infoHash);
  const secret = labeledExtract(suite, shared, "secret", empty);
  return {
    key: labeledExpand(suite, secret, "key", ctx, 32),
    nonce: labeledExpand(suite, secret, "base_nonce", ctx, 12),
  };
}

function hpkeKeySchedule(dh: Uint8Array, kemContext: Uint8Array, info: Uint8Array) {
  const eaePrk = labeledExtract(KEM_SUITE, new Uint8Array(0), "eae_prk", dh);
  const shared = labeledExpand(KEM_SUITE, eaePrk, "shared_secret", kemContext, 32);
  return keyScheduleFromShared(HPKE_SUITE, shared, info);
}

/** Single-shot HPKE seal; returns enc (32 B) || ciphertext. */
export function hpkeSeal(pkR: Uint8Array, info: Uint8Array, pt: Uint8Array, skE: Uint8Array = randomBytes(32)): Uint8Array {
  const pkE = x25519.getPublicKey(skE);
  const dh = x25519.getSharedSecret(skE, pkR);
  const { key, nonce } = hpkeKeySchedule(dh, concat(pkE, pkR), info);
  return concat(pkE, chacha20poly1305(key, nonce).encrypt(pt));
}

export function hpkeOpen(skR: Uint8Array, info: Uint8Array, sealed: Uint8Array): Uint8Array {
  const pkE = sealed.subarray(0, 32);
  const dh = x25519.getSharedSecret(skR, pkE);
  const { key, nonce } = hpkeKeySchedule(dh, concat(pkE, x25519.getPublicKey(skR)), info);
  return chacha20poly1305(key, nonce).decrypt(sealed.subarray(32));
}

// ── Post-quantum hybrid HPKE: X-Wing KEM (ML-KEM-768 + X25519, KEM id 0x647A) ──

export interface PqRecipientKey {
  seed: Uint8Array;        // 32-byte X-Wing seed
  publicKey: Uint8Array;   // 1216 bytes: ML-KEM-768 pk | X25519 pk
}

export function pqRecipientKeyFromSeed(seed: Uint8Array): PqRecipientKey {
  if (seed.length !== 32) throw new Error("X-Wing seeds are 32 bytes");
  return { seed, publicKey: ml_kem768_x25519.keygen(seed).publicKey };
}
export const generatePqRecipientKey = () => pqRecipientKeyFromSeed(randomBytes(32));

export function pqRecipientKid(publicKey: Uint8Array): Uint8Array {
  return sha256(concat(enc.encode("PACC-XWING"), publicKey)).slice(0, RECIPIENT_KID_LEN);
}

/** Single-shot HPKE seal with X-Wing; returns enc (1120 B) || ciphertext. */
export function xwingSeal(pkR: Uint8Array, info: Uint8Array, pt: Uint8Array): Uint8Array {
  if (pkR.length !== XWING_PUBLIC_LEN) throw new Error(`X-Wing public keys are ${XWING_PUBLIC_LEN} bytes`);
  const { cipherText, sharedSecret } = ml_kem768_x25519.encapsulate(pkR);
  const { key, nonce } = keyScheduleFromShared(HPKE_SUITE_XWING, sharedSecret, info);
  return concat(cipherText, chacha20poly1305(key, nonce).encrypt(pt));
}

export function xwingOpen(seed: Uint8Array, info: Uint8Array, sealed: Uint8Array): Uint8Array {
  const { secretKey } = ml_kem768_x25519.keygen(seed);
  const shared = ml_kem768_x25519.decapsulate(sealed.subarray(0, XWING_ENC_LEN), secretKey);
  const { key, nonce } = keyScheduleFromShared(HPKE_SUITE_XWING, shared, info);
  return chacha20poly1305(key, nonce).decrypt(sealed.subarray(XWING_ENC_LEN));
}

async function argon2(password: string, salt: Uint8Array, profile: number): Promise<Uint8Array> {
  const p = KDF_PROFILES[profile];
  if (!p) throw new Error(`unknown KDF profile ${profile}`);
  return argon2id({
    password, salt, iterations: p.timeCost, memorySize: p.memoryKiB, parallelism: p.parallelism,
    hashLength: 32, outputType: "binary",
  });
}

// ── Sealing ──────────────────────────────────────────────────────────────────

export interface SealOptions {
  signWith?: SigningKey;
  embedPublicKey?: boolean;        // default true
  password?: string;
  kdfProfile?: number;             // default 1
  recipient?: Uint8Array;          // X25519 public key
  recipientPq?: Uint8Array;        // X-Wing public key (post-quantum hybrid)
}

function sealInner(content: Uint8Array, compress: boolean, opts: SealOptions, extraFlags: number) {
  if ([opts.password !== undefined, Boolean(opts.recipient), Boolean(opts.recipientPq)].filter(Boolean).length > 1)
    throw new Error("choose one of: password, recipient key, post-quantum recipient key");
  let flags = extraFlags;
  let body = content;
  if (compress) {
    const packed = deflateRaw(content, { level: 9 });
    if (packed.length < content.length) {
      flags |= FLAG_DEFLATE;
      body = packed;
    }
  }
  if (opts.signWith) flags |= FLAG_SIGNED;
  if (opts.password !== undefined || opts.recipient || opts.recipientPq) flags |= FLAG_ENCRYPTED;
  if (opts.signWith) {
    const key = opts.signWith;
    const embed = opts.embedPublicKey ?? true;
    const header = concat(Uint8Array.of(key.alg | (embed ? ALG_EMBEDDED : 0)), embed ? key.publicKey : fingerprint(key.alg, key.publicKey));
    const sig = sign(key, concat(SIG_CONTEXT, Uint8Array.of(flags), header, body));
    body = concat(header, body, sig);
  }
  if (opts.recipient) {
    const modeHeader = concat(Uint8Array.of(MODE_RECIPIENT), recipientKid(opts.recipient));
    body = concat(modeHeader, hpkeSeal(opts.recipient, concat(ENC_CONTEXT, Uint8Array.of(flags), modeHeader), body));
  } else if (opts.recipientPq) {
    const modeHeader = concat(Uint8Array.of(MODE_RECIPIENT_PQ), pqRecipientKid(opts.recipientPq));
    body = concat(modeHeader, xwingSeal(opts.recipientPq, concat(ENC_CONTEXT, Uint8Array.of(flags), modeHeader), body));
  }
  return { flags, body };
}

/** Synchronous sealing (no password). */
export function seal(content: Uint8Array, compress: boolean, opts: SealOptions = {}, extraFlags = 0) {
  if (opts.password !== undefined) throw new Error("password encryption is asynchronous: use sealAsync");
  return sealInner(content, compress, opts, extraFlags);
}

export async function sealAsync(content: Uint8Array, compress: boolean, opts: SealOptions = {}, extraFlags = 0) {
  const inner = sealInner(content, compress, opts, extraFlags);
  if (opts.password === undefined) return inner;
  if (!opts.password) throw new Error("empty password");
  const profile = opts.kdfProfile ?? 1;
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const modeHeader = concat(Uint8Array.of(MODE_PASSWORD, profile), salt, nonce);
  const key = await argon2(opts.password, salt, profile);
  const ct = chacha20poly1305(key, nonce, concat(ENC_CONTEXT, Uint8Array.of(inner.flags), modeHeader)).encrypt(inner.body);
  return { flags: inner.flags, body: concat(modeHeader, ct) };
}

// ── Opening ──────────────────────────────────────────────────────────────────

export interface OpenResult {
  payload?: Uint8Array;
  locked?: "password" | "recipient";
  encrypted?: "password" | "recipient" | "recipient-pq";
  signed?: string;
  signer?: string;                  // fingerprint hex
  signatureValid?: boolean | null;  // null: unknown signer key, could not check
  trusted?: boolean;
  recipientKid?: string;
  error?: string;
}

export interface Secrets {
  password?: string;
  recipientKeys?: RecipientKey[];
  pqRecipientKeys?: PqRecipientKey[];
  /** fingerprint hex -> { alg, publicKey } */
  trustedSigners?: Record<string, { alg: number; publicKey: Uint8Array }>;
}

function verifyLayer(flags: number, body: Uint8Array, secrets: Secrets, out: OpenResult): Uint8Array | null {
  if (!body.length) {
    out.error = "empty signed body";
    return null;
  }
  const alg = body[0] & 0x0f;
  if (!SIG_SIZES[alg]) {
    out.error = `unsupported signature algorithm ${alg}`;
    return null;
  }
  out.signed = ALG_NAMES[alg];
  const embedded = Boolean(body[0] & ALG_EMBEDDED);
  const keyLen = embedded ? PUB_SIZES[alg] : FINGERPRINT_LEN;
  const sigLen = SIG_SIZES[alg];
  if (body.length < 1 + keyLen + sigLen) {
    out.error = "truncated signature block";
    return null;
  }
  const header = body.subarray(0, 1 + keyLen);
  const content = body.subarray(1 + keyLen, body.length - sigLen);
  const sig = body.subarray(body.length - sigLen);
  let pub: Uint8Array | null;
  let fp: string;
  if (embedded) {
    pub = header.subarray(1);
    fp = toHex(fingerprint(alg, pub));
  } else {
    fp = toHex(header.subarray(1));
    const known = secrets.trustedSigners?.[fp];
    pub = known && known.alg === alg ? known.publicKey : null;
  }
  out.signer = fp;
  out.trusted = Boolean(secrets.trustedSigners?.[fp]);
  out.signatureValid = pub ? verifySignature(alg, pub, sig, concat(SIG_CONTEXT, Uint8Array.of(flags), header, content)) : null;
  return content.slice();
}

function finishLayers(flags: number, data: Uint8Array, secrets: Secrets, out: OpenResult): OpenResult {
  let d: Uint8Array | null = data;
  if (flags & FLAG_SIGNED) {
    d = verifyLayer(flags, d, secrets, out);
    if (!d) return out;
  }
  if (flags & FLAG_DEFLATE) {
    try {
      d = inflateRaw(d);
    } catch {
      out.error = "invalid compressed payload";
      return out;
    }
    if (d.length > MAX_INFLATE) {
      out.error = "compressed payload exceeds the safety limit";
      return out;
    }
  }
  out.payload = d;
  return out;
}

/** Synchronous opening: everything except password decryption (reported as locked). */
export function openMessage(flags: number, body: Uint8Array, secrets: Secrets = {}): OpenResult {
  const out: OpenResult = {};
  if (flags & ~KNOWN_FLAGS) {
    out.error = `unsupported message flags 0x${flags.toString(16)}`;
    return out;
  }
  if (!(flags & FLAG_ENCRYPTED)) return finishLayers(flags, body, secrets, out);
  const mode = body[0];
  if (mode === MODE_PASSWORD) {
    out.encrypted = "password";
    if (body.length < 30 + 16) out.error = "truncated password envelope";
    else out.locked = "password";
    return out;
  }
  if (mode === MODE_RECIPIENT) {
    out.encrypted = "recipient";
    const modeHeader = body.subarray(0, 1 + RECIPIENT_KID_LEN);
    const kid = toHex(modeHeader.subarray(1));
    out.recipientKid = kid;
    const info = concat(ENC_CONTEXT, Uint8Array.of(flags), modeHeader);
    for (const rk of secrets.recipientKeys ?? []) {
      if (toHex(recipientKid(rk.publicKey)) !== kid) continue;
      try {
        return finishLayers(flags, hpkeOpen(rk.privateKey, info, body.subarray(modeHeader.length)), secrets, out);
      } catch {
        /* not this key */
      }
    }
    out.locked = "recipient";
    out.error = "no matching recipient key";
    return out;
  }
  if (mode === MODE_RECIPIENT_PQ) {
    out.encrypted = "recipient-pq";
    const modeHeader = body.subarray(0, 1 + RECIPIENT_KID_LEN);
    const kid = toHex(modeHeader.subarray(1));
    out.recipientKid = kid;
    const info = concat(ENC_CONTEXT, Uint8Array.of(flags), modeHeader);
    for (const pk of secrets.pqRecipientKeys ?? []) {
      if (toHex(pqRecipientKid(pk.publicKey)) !== kid) continue;
      try {
        return finishLayers(flags, xwingOpen(pk.seed, info, body.subarray(modeHeader.length)), secrets, out);
      } catch {
        /* not this key */
      }
    }
    out.locked = "recipient";
    out.error = "no matching post-quantum recipient key";
    return out;
  }
  out.error = `unsupported encryption mode ${mode}`;
  return out;
}

/** Full opening, including password decryption. */
export async function openMessageAsync(flags: number, body: Uint8Array, secrets: Secrets = {}): Promise<OpenResult> {
  if (!(flags & FLAG_ENCRYPTED) || body[0] !== MODE_PASSWORD || secrets.password === undefined) {
    return openMessage(flags, body, secrets);
  }
  const out: OpenResult = { encrypted: "password" };
  if (body.length < 30 + 16) {
    out.error = "truncated password envelope";
    return out;
  }
  const profile = body[1];
  if (!KDF_PROFILES[profile]) {
    out.error = `unknown KDF profile ${profile}`;
    return out;
  }
  const modeHeader = body.subarray(0, 30);
  const key = await argon2(secrets.password, body.subarray(2, 18), profile);
  let inner: Uint8Array;
  try {
    inner = chacha20poly1305(key, body.subarray(18, 30), concat(ENC_CONTEXT, Uint8Array.of(flags), modeHeader)).decrypt(body.subarray(30));
  } catch {
    out.locked = "password";
    out.error = "wrong password or corrupted data";
    return out;
  }
  return finishLayers(flags, inner, secrets, out);
}
