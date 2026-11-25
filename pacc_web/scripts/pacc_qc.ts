/**
 * Cross-language test of PACC QC (QR-compatible hidden chroma channel).
 *
 *   python research/pacc_sim/make_qc_vectors.py
 *   npx jiti scripts/pacc_qc.ts
 *   python research/pacc_sim/make_qc_vectors.py --check-ts
 */
import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { qcDecodeAt, qcEncode } from "../src/lib/pacc/qc";
import { ALG_ED25519, fingerprint, fromHex, signingKeyFromSeed, toHex } from "../src/lib/pacc/secure";

const dir = path.resolve(__dirname, "../../research/pacc_sim");
const V = JSON.parse(readFileSync(path.join(dir, "qc_vectors.json"), "utf-8"));
const key = signingKeyFromSeed(ALG_ED25519, fromHex(V.ed_seed));
const secrets = { trustedSigners: { [toHex(fingerprint(key.alg, key.publicKey))]: { alg: key.alg, publicKey: key.publicKey } } };
const hidden = fromHex(V.hidden_hex);
const same = (a?: Uint8Array, b?: Uint8Array) => !!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]);
let failures = 0;

for (const v of V.vectors) {
  const rgba = new Uint8ClampedArray(v.width * v.height * 4);
  for (let i = 0; i < v.width * v.height; i++) {
    rgba[i * 4] = v.rgb[i * 3];
    rgba[i * 4 + 1] = v.rgb[i * 3 + 1];
    rgba[i * 4 + 2] = v.rgb[i * 3 + 2];
    rgba[i * 4 + 3] = 255;
  }
  const t0 = performance.now();
  const corners = v.corners.map(([x, y]: [number, number]) => ({ x, y }));
  const r = qcDecodeAt({ data: rgba, width: v.width, height: v.height }, corners, v.version, v.visible, secrets);
  let ok = r.ok && same(r.hidden, hidden) && r.bound === true;
  if (v.signed) ok = ok && r.security?.signatureValid === true && r.security?.trusted === true;
  if (!ok) failures++;
  console.log(`py->ts ${v.name.padEnd(20)} ${ok ? "OK" : "FAIL " + (r.error ?? "")}  ${(performance.now() - t0).toFixed(0)} ms`);
}

const tsHidden = new TextEncoder().encode(new TextDecoder().decode(hidden).replace("ACME", "TS"));
const out = [
  { name: "ts-plain", signed: false, ...qcEncode(V.visible, tsHidden) },
  { name: "ts-signed", signed: true, ...qcEncode(V.visible, tsHidden, { security: { signWith: key, embedPublicKey: false } }) },
].map((e) => ({ name: e.name, signed: e.signed, n: e.n, version: e.version, grid: Array.from(e.grid) }));
writeFileSync(path.join(dir, "ts_qc_vectors.json"), JSON.stringify(out));
console.log(`QC failures: ${failures}`);
process.exit(failures ? 1 : 0);

