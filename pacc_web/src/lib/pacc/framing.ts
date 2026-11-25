/** Message framing, CRC-32, scrambler, interleaver — twin of pacc2/framing.py (SPEC §6). */
import { Prng, mixSeed, permutation } from "./prng";
import { MESSAGE_OVERHEAD } from "./spec";

let crcTable: Uint32Array | null = null;

export function crc32(data: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[i] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = crcTable[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function buildMessage(payload: Uint8Array, flags: number): Uint8Array {
  if (payload.length > 0xffff) throw new Error("payload too long for a single PACC symbol");
  const head = new Uint8Array(3 + payload.length);
  head[0] = flags;
  head[1] = payload.length >> 8;
  head[2] = payload.length & 0xff;
  head.set(payload, 3);
  const crc = crc32(head);
  const out = new Uint8Array(head.length + 4);
  out.set(head);
  out[head.length] = crc >>> 24;
  out[head.length + 1] = (crc >>> 16) & 0xff;
  out[head.length + 2] = (crc >>> 8) & 0xff;
  out[head.length + 3] = crc & 0xff;
  return out;
}

const scramblers = new Map<number, Uint8Array>();
export function scrambler(k: number): Uint8Array {
  let s = scramblers.get(k);
  if (!s) {
    s = new Prng(mixSeed(0x5c2a, k)).bits(k);
    scramblers.set(k, s);
  }
  return s;
}

export function messageToInfoBits(message: Uint8Array, k: number): Uint8Array {
  if (8 * message.length > k) throw new Error("message does not fit");
  const bits = new Uint8Array(k);
  for (let i = 0; i < message.length; i++)
    for (let b = 0; b < 8; b++) bits[i * 8 + b] = (message[i] >> (7 - b)) & 1;
  const s = scrambler(k);
  for (let i = 0; i < k; i++) bits[i] ^= s[i];
  return bits;
}

export function parseInfoBits(bits: Uint8Array): { flags: number; payload: Uint8Array } | null {
  const k = bits.length;
  const s = scrambler(k);
  const raw = new Uint8Array(Math.floor(k / 8));
  for (let i = 0; i < raw.length; i++) {
    let v = 0;
    for (let b = 0; b < 8; b++) v = (v << 1) | (bits[i * 8 + b] ^ s[i * 8 + b]);
    raw[i] = v;
  }
  if (raw.length < MESSAGE_OVERHEAD) return null;
  const length = (raw[1] << 8) | raw[2];
  const end = 3 + length;
  if (end + 4 > raw.length) return null;
  const crc = crc32(raw.subarray(0, end));
  const stored = ((raw[end] << 24) | (raw[end + 1] << 16) | (raw[end + 2] << 8) | raw[end + 3]) >>> 0;
  if (crc !== stored) return null;
  return { flags: raw[0], payload: raw.slice(3, end) };
}

const perms = new Map<number, Int32Array>();
export function interleaver(n: number): Int32Array {
  let p = perms.get(n);
  if (!p) {
    p = permutation(n, mixSeed(0x1a7e, n));
    perms.set(n, p);
  }
  return p;
}
