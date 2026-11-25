/**
 * Decode the Python-generated distorted images with the TypeScript PACC decoder.
 *
 *   python research/pacc_sim/make_image_vectors.py
 *   npx jiti scripts/pacc_images.ts
 */
import { readFileSync } from "fs";
import path from "path";
import { decodeImage } from "../src/lib/pacc";

const dir = path.resolve(__dirname, "../../research/pacc_sim/image_vectors");
const index = JSON.parse(readFileSync(path.join(dir, "index.json"), "utf-8"));
const payload = Buffer.from(index.payload_hex, "hex");
let tsOk = 0, pyOk = 0, regressions = 0;
for (const c of index.cases) {
  const buf = readFileSync(path.join(dir, c.file));
  const data = new Uint8ClampedArray(buf.buffer, buf.byteOffset, buf.byteLength);
  const r = decodeImage({ data, width: c.width, height: c.height });
  const ok = r.ok && !!r.payload && Buffer.from(r.payload).equals(payload);
  tsOk += ok ? 1 : 0;
  pyOk += c.python_ok ? 1 : 0;
  if (c.python_ok && !ok) regressions++;
  console.log(`${c.file.padEnd(22)} ts=${ok ? "OK  " : "FAIL"} py=${c.python_ok ? "OK  " : "FAIL"} ${String(r.durationMs).padStart(5)} ms ${ok ? "" : r.error ?? ""}`);
}
console.log(`TypeScript ${tsOk}/${index.cases.length}, Python ${pyOk}/${index.cases.length}, regressions vs Python: ${regressions}`);
process.exit(regressions ? 1 : 0);

