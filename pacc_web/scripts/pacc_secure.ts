/**
 * Cross-language test of the PACC security layer.
 *
 *   python research/pacc_sim/make_secure_vectors.py              (Python seals)
 *   npx jiti scripts/pacc_secure.ts                              (TypeScript opens them, then seals its own)
 *   python research/pacc_sim/make_secure_vectors.py --check-ts   (Python opens the TypeScript ones)
 */
import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { decodeGrid, encodeGrid, unlock } from "../src/lib/pacc/codec";
import { FrameCombiner } from "../src/lib/pacc/combine";
import { crc32 } from "../src/lib/pacc/framing";
import { StreamDecoder, framePayload, planStream } from "../src/lib/pacc/stream";
import {
  ALG_ED25519, ALG_MLDSA44, fingerprint, fromHex, hpkeOpen, hpkeSeal, pqRecipientKeyFromSeed, recipientKeyFromPrivate, sealAsync,
  signingKeyFromSeed, toHex, type Secrets,
} from "../src/lib/pacc/secure";

const dir = path.resolve(__dirname, "../../research/pacc_sim");
const V = JSON.parse(readFileSync(path.join(dir, "secure_vectors.json"), "utf-8"));
const text = fromHex(V.text_hex);
const ed = signingKeyFromSeed(ALG_ED25519, fromHex(V.ed_seed));
const pq = signingKeyFromSeed(ALG_MLDSA44, fromHex(V.mldsa_seed));
const rk = recipientKeyFromPrivate(fromHex(V.x25519_priv));
const xk = pqRecipientKeyFromSeed(fromHex(V.xwing_seed));
let failures = 0;
const fail = (msg: string) => {
  failures++;
  console.error(`FAIL ${msg}`);
};
const same = (a?: Uint8Array, b?: Uint8Array) => !!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]);

if (toHex(fingerprint(ed.alg, ed.publicKey)) !== V.ed_fp) fail("Ed25519 key derivation differs from Python");
if (toHex(fingerprint(pq.alg, pq.publicKey)) !== V.pq_fp) fail("ML-DSA-44 key derivation differs from Python");

// HPKE self-consistency (Python interop is covered by the vectors below).
{
  const info = new TextEncoder().encode("info");
  const ct = hpkeSeal(rk.publicKey, info, text);
  if (!same(hpkeOpen(rk.privateKey, info, ct), text)) fail("HPKE round trip");
}

interface Case { name: string; sign?: string; embed?: boolean; trust?: string[]; recipient?: boolean; recipient_pq?: boolean; password?: boolean;
  tamper?: boolean; mcs?: number; level?: string;
  expect: { signed?: string; valid?: boolean | null; trusted?: boolean; encrypted?: string } }

function secretsFor(c: Case): Secrets {
  const s: Secrets = { trustedSigners: {} };
  if (c.password) s.password = V.password;
  if (c.recipient) s.recipientKeys = [rk];
  if (c.recipient_pq) s.pqRecipientKeys = [xk];
  for (const name of c.trust ?? []) {
    const k = name === "ed" ? ed : pq;
    s.trustedSigners![toHex(fingerprint(k.alg, k.publicKey))] = { alg: k.alg, publicKey: k.publicKey };
  }
  return s;
}

async function open(c: Case, grid: Uint8Array, n: number): Promise<string[]> {
  const obs = Float64Array.from(grid, (v) => v / 255);
  const secrets = secretsFor(c);
  let r = decodeGrid(obs, n, { secrets: { ...secrets, password: undefined } });
  if (r.locked === "password") r = await unlock(r, secrets);
  const errs: string[] = [];
  const sec = r.security;
  if (!r.ok || !sec) return [`decode failed: ${r.error}`];
  const e = c.expect;
  if (e.signed !== undefined && sec.signed !== e.signed) errs.push(`signed ${sec.signed}`);
  if (e.valid !== undefined && (sec.signatureValid ?? null) !== e.valid) errs.push(`signatureValid ${sec.signatureValid}`);
  if (e.trusted !== undefined && sec.trusted !== e.trusted) errs.push(`trusted ${sec.trusted}`);
  if (e.encrypted !== undefined && sec.encrypted !== e.encrypted) errs.push(`encrypted ${sec.encrypted}`);
  if (!c.tamper && !same(r.payload, text)) errs.push("payload mismatch");
  return errs;
}

async function main() {
  const cases: Case[] = V.cases;
  for (const v of V.vectors) {
    const c = cases.find((x) => x.name === v.name)!;
    const errs = await open(c, Uint8Array.from(v.grid), v.n);
    console.log(`py->ts ${v.name.padEnd(26)} ${errs.length ? "FAIL " + errs.join("; ") : "OK"}`);
    if (errs.length) failures++;
  }

  // TypeScript seals; Python checks these with --check-ts.
  const out: { name: string; n: number; grid: number[] }[] = [];
  for (const c of cases) {
    const sealed = await sealAsync(text, true, {
      signWith: c.sign === "ed" ? ed : c.sign === "pq" ? pq : undefined,
      embedPublicKey: c.embed ?? true,
      password: c.password ? V.password : undefined,
      kdfProfile: 0,
      recipient: c.recipient ? rk.publicKey : undefined,
      recipientPq: c.recipient_pq ? xk.publicKey : undefined,
    });
    if (c.tamper) sealed.body[40] ^= 0x01;
    const e = encodeGrid(text, { mcs: c.mcs ?? 1, level: c.level ?? "Q", sealed });
    const errs = await open(c, e.grid, e.n);
    if (errs.length) fail(`ts self-check ${c.name}: ${errs.join("; ")}`);
    out.push({ name: c.name, n: e.n, grid: Array.from(e.grid) });
  }
  writeFileSync(path.join(dir, "ts_secure_vectors.json"), JSON.stringify(out));

  // Multi-frame combining: frames that fail alone decode together.
  {
    const e = encodeGrid(new TextEncoder().encode("https://example.com/pacc/a-reasonably-long-url?with=params"), { mcs: 1, level: "L" });
    let seed = 7;
    const gauss = () => {
      seed = (seed * 1103515245 + 12345) >>> 0;
      const u = (seed + 1) / 4294967297;
      seed = (seed * 1103515245 + 12345) >>> 0;
      const w = (seed + 1) / 4294967297;
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * w);
    };
    const comb = new FrameCombiner();
    let singles = 0;
    let decodedAt = 0;
    for (let f = 1; f <= 8 && !decodedAt; f++) {
      const obs = Float64Array.from(e.grid, (v) => Math.min(1, Math.max(0, v / 255 + 0.45 * gauss())));
      if (decodeGrid(obs, e.n).ok) singles++;
      const r = decodeGrid(obs, e.n, { combiner: comb });
      comb.endFrame(r.ok);
      if (r.ok) decodedAt = f;
    }
    console.log(`multi-frame: sigma 0.45, single-frame successes ${singles}, combined decode at frame ${decodedAt || "never"}`);
    if (!decodedAt || decodedAt === 1) fail("multi-frame combining did not help");
  }
  // PACC Stream: identical frames to Python, and reassembly from a lossy mid-loop capture.
  {
    const S = JSON.parse(readFileSync(path.join(dir, "stream_vectors.json"), "utf-8"));
    const data = fromHex(S.data_hex);
    const p = planStream(data, { n: S.n, mcs: S.mcs, level: S.level, compress: false, streamId: S.stream_id });
    if (p.k !== S.k || p.blockSize !== S.block_size) fail(`stream plan K=${p.k}/${S.k} B=${p.blockSize}/${S.block_size}`);
    S.esis.forEach((e: number, i: number) => {
      if (crc32(framePayload(p, e)) !== S.payload_crcs[i]) fail(`stream frame ${e} differs from Python`);
    });
    const dec = new StreamDecoder();
    for (const f of S.frames) {
      const r = decodeGrid(Float64Array.from(f.grid, (v: number) => v / 255), f.n);
      if (!r.ok || r.flags !== 8 || !r.payload) fail(`stream grid ${f.esi} did not decode`);
      else dec.add(r.payload);
    }
    for (const e of S.esis.slice(S.frames.length)) dec.add(framePayload(p, e));
    const opened = dec.open();
    console.log(`stream: K=${p.k}, received ${dec.received}, complete ${dec.complete}`);
    if (!opened?.payload || !same(opened.payload, data)) fail("stream reassembly");
  }
  console.log(`secure/combining/stream failures: ${failures}`);
  process.exit(failures ? 1 : 0);
}

main();

