/**
 * Cross-language parity test for the PACC TypeScript port.
 *
 *   python research/pacc_sim/make_parity_vectors.py
 *   npx jiti scripts/pacc_parity.ts
 *
 * Exits non-zero on any mismatch.
 */
import { readFileSync } from "fs";
import path from "path";
import { decodeGrid, encodeGrid } from "../src/lib/pacc/codec";
import { crc32, interleaver } from "../src/lib/pacc/framing";
import { golayEncode } from "../src/lib/pacc/golay";
import { buildCode } from "../src/lib/pacc/ldpc";
import { Prng, mixSeed, permutation } from "../src/lib/pacc/prng";

const vectorsPath = path.resolve(__dirname, "../../research/pacc_sim/parity_vectors.json");
const V = JSON.parse(readFileSync(vectorsPath, "utf-8"));
let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) {
    failures++;
    console.error(`FAIL ${name} ${detail}`);
  }
};
const eq = (a: ArrayLike<number>, b: ArrayLike<number>) => a.length === b.length && Array.from(a).every((x, i) => x === b[i]);

const p = new Prng(12345);
check("prng", eq(Array.from({ length: 8 }, () => p.nextU32()), V.prng));
check("mix_seed", eq([mixSeed(1, 2, 3), mixSeed(0x1d9c, 888, 316)], V.mix_seed));
check("permutation", eq(permutation(10, 7), V.permutation_10_7));
check("golay", eq([0, 1, 2, 1000, 4095].map(golayEncode), V.golay));
for (const { n, k, digest } of V.ldpc) {
  const code = buildCode(n, k);
  const flat: number[] = [];
  code.checkInfo.forEach((members, c) => {
    flat.push(c, ...members);
  });
  const bytes = new Uint8Array(Int32Array.from(flat).buffer);
  check(`ldpc ${n},${k}`, crc32(bytes) === digest, `${crc32(bytes)} != ${digest}`);
}
check("interleaver", eq(Array.from(interleaver(1294).subarray(0, 16)), V.interleaver_head));

let decodeMs = 0;
for (const g of V.grids) {
  const payload = Uint8Array.from(Buffer.from(g.payload_hex, "hex"));
  const e = encodeGrid(payload, { mcs: g.mcs, level: g.level, compress: false });
  const tag = `mcs${g.mcs} ${g.level} ${payload.length}B`;
  check(`encode ${tag}`, e.n === g.n && crc32(e.grid) === g.grid_crc, `n=${e.n}/${g.n}`);
  const t0 = performance.now();
  const r = decodeGrid(Float64Array.from(g.noisy), g.n);
  decodeMs += performance.now() - t0;
  check(`decode ${tag}`, r.ok && !!r.payload && eq(r.payload, payload), r.error ?? "");
  if (g.llr_head.length) {
    const head = Array.from(r.channelLlrs?.subarray(0, g.llr_head.length) ?? []);
    const maxErr = Math.max(...head.map((v, i) => Math.abs(v - g.llr_head[i])));
    check(`llr ${tag}`, head.length === g.llr_head.length && maxErr < 1e-6, `max |dLLR| = ${maxErr}`);
  }
}
console.log(`${V.grids.length} grids, mean decodeGrid ${(decodeMs / V.grids.length).toFixed(1)} ms; failures: ${failures}`);
process.exit(failures ? 1 : 0);

