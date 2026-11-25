/**
 * Cross-language test of distance-adaptive layered symbols.
 *
 *   python research/pacc_sim/make_layered_vectors.py
 *   npx jiti scripts/pacc_layered.ts
 */
import { readFileSync } from "fs";
import path from "path";
import { crc32 } from "../src/lib/pacc/framing";
import { encodeLayered } from "../src/lib/pacc/hier";
import { decodeImage } from "../src/lib/pacc/index";
import { fromHex } from "../src/lib/pacc/secure";

const V = JSON.parse(readFileSync(path.resolve(__dirname, "../../research/pacc_sim/layered_vectors.json"), "utf-8"));
const coarse = fromHex(V.coarse_hex);
const fine = fromHex(V.fine_hex);
const same = (a?: Uint8Array, b?: Uint8Array) => !!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]);
let failures = 0;

const e = encodeLayered(coarse, fine, { level: "H" });
if (e.n !== V.n || crc32(e.grid) !== V.grid_crc) {
  failures++;
  console.error(`FAIL encode: N=${e.n}/${V.n} crc ${crc32(e.grid)}/${V.grid_crc}`);
}

for (const im of V.images) {
  const rgb = Buffer.from(im.rgb_b64, "base64");
  const data = new Uint8ClampedArray(im.width * im.height * 4);
  for (let i = 0; i < im.width * im.height; i++) {
    data[i * 4] = rgb[i * 3];
    data[i * 4 + 1] = rgb[i * 3 + 1];
    data[i * 4 + 2] = rgb[i * 3 + 2];
    data[i * 4 + 3] = 255;
  }
  const r = decodeImage({ data, width: im.width, height: im.height });
  const coarseOk = r.ok && same(r.payload, coarse);
  const fineOk = Boolean(r.fine?.ok && same(r.fine.payload, fine));
  const ok = coarseOk && fineOk === im.fine;
  if (!ok) failures++;
  console.log(`py->ts ${im.name.padEnd(14)} coarse=${coarseOk} fine=${fineOk} (expected ${im.fine}) ${r.durationMs} ms ${ok ? "OK" : "FAIL " + (r.fine?.error ?? r.error ?? "")}`);
}
console.log(`layered failures: ${failures}`);
process.exit(failures ? 1 : 0);
