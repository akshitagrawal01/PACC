/**
 * Runs the Test Lab phone logic (TypeScript decoder + grading, src/lib/testLabGrade.ts) on every
 * cached PACC suite item, the way the phone sees them but without a camera. Checks that each item
 * is gradable and that the TypeScript result agrees with the Python desktop check.
 *
 *   python scripts/pacc_suites.py        # builds data/suite_cache
 *   npx jiti scripts/test_lab_items.ts
 */
import { readdirSync, readFileSync } from "fs";
import path from "path";
import { PNG } from "pngjs";
import { readBarcodes } from "zxing-wasm/reader";
import { FrameCombiner } from "../src/lib/pacc/combine";
import { decodeImage, unlock, type ImageDecodeResult } from "../src/lib/pacc/index";
import { qcDecodeAt } from "../src/lib/pacc/qc";
import { fromHex, pqRecipientKeyFromSeed, recipientKeyFromPrivate, type Secrets } from "../src/lib/pacc/secure";
import { FLAG_STREAM } from "../src/lib/pacc/spec";
import { StreamDecoder } from "../src/lib/pacc/stream";
import { reportPacc, reportQc, type Expect } from "../src/lib/testLabGrade";

interface Item {
  id: string; group: string; condition: string; codec: string; codeType: string; payload: string;
  dataUrl: string; frames?: string[] | null; expect?: Expect; password?: string; serverDecodeSuccess?: boolean;
  secrets?: { trustedSigners?: { alg: number; publicKeyHex: string; fingerprint: string }[]; recipientPrivateHex?: string[]; pqRecipientSeedHex?: string[] };
}

const dir = path.resolve(__dirname, "../data/suite_cache");
const png = (url: string) => {
  const buf = Buffer.from(url.split(",")[1], "base64");
  const p = PNG.sync.read(buf);
  return { img: { data: new Uint8ClampedArray(p.data), width: p.width, height: p.height }, buf };
};
const secretsOf = (it: Item): Secrets => {
  const trusted: NonNullable<Secrets["trustedSigners"]> = {};
  for (const t of it.secrets?.trustedSigners ?? []) trusted[t.fingerprint] = { alg: t.alg, publicKey: fromHex(t.publicKeyHex) };
  return {
    trustedSigners: trusted,
    recipientKeys: (it.secrets?.recipientPrivateHex ?? []).map((h) => recipientKeyFromPrivate(fromHex(h))),
    pqRecipientKeys: (it.secrets?.pqRecipientSeedHex ?? []).map((h) => pqRecipientKeyFromSeed(fromHex(h))),
    password: it.password,
  };
};

async function grade(it: Item): Promise<string | null> {
  const secrets = secretsOf(it);
  if (it.codeType === "QR" || it.codeType === "PACC_QC") {
    const { img, buf } = png(it.dataUrl);
    const [z] = await readBarcodes(new Uint8Array(buf), { formats: ["QRCode"] });
    if (!z?.isValid) return null;
    if (it.codeType === "QR") return z.text;
    const p = z.position;
    const version = Number(JSON.parse(z.extra || "{}").Version ?? z.version) || 0;
    const q = qcDecodeAt(img, [p.topLeft, p.topRight, p.bottomRight, p.bottomLeft], version, z.text, secrets);
    return reportQc(q);
  }
  // PACC: loop the frames (up to 3 cycles) with multi-frame combining and stream reassembly, as live mode does.
  const frames = it.frames?.length ? it.frames : [it.dataUrl];
  const combiner = new FrameCombiner();
  const stream = new StreamDecoder();
  for (let k = 0; k < frames.length * (frames.length > 1 ? 3 : 1); k++) {
    const { img } = png(frames[k % frames.length]);
    let r: ImageDecodeResult = decodeImage(img, { secrets, combiner: frames.length > 1 ? combiner : undefined });
    if (r.locked === "password" && it.password) r = { ...r, ...(await unlock(r, secrets)) };   // the phone calls unlockPacc
    if (r.ok && r.flags !== undefined && r.flags & FLAG_STREAM && r.payload) {
      const st = stream.add(r.payload);
      if (!st?.complete) continue;
      const opened = stream.open(secrets)!;
      r = { ...r, ok: !opened.error, payload: opened.payload, security: opened };
    }
    const text = reportPacc(it.expect, r);
    if (text !== null) return text;
  }
  return null;
}

(async () => {
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  let mismatches = 0, total = 0, pass = 0, wrong = 0;
  for (const f of files) {
    const items: Item[] = JSON.parse(readFileSync(path.join(dir, f), "utf-8"));
    for (const it of items) {
      total++;
      const t0 = performance.now();
      const got = await grade(it);
      const ok = got === it.payload;
      pass += Number(ok);
      if (got !== null && !ok) wrong++;   // reported the wrong content: a grading bug
      // Multi-frame items: Python checks only the first frame, so it may fail where TS (combining) passes.
      const comparable = !it.frames?.length;
      const agree = !comparable || ok === Boolean(it.serverDecodeSuccess);
      if (!agree) mismatches++;
      if (!ok || !agree) {
        console.log(`${(it.group + " " + it.condition).padEnd(34)} ${it.codec.padEnd(16)} ts=${ok ? "PASS" : "fail"} py=${it.serverDecodeSuccess ? "PASS" : "fail"}` +
          `${agree ? "" : "  <-- DISAGREE"} ${got !== null && !ok ? `reported "${got.slice(0, 40)}"` : ""} ${Math.round(performance.now() - t0)} ms`);
      }
    }
  }
  console.log(`test lab items: ${pass}/${total} PASS on the exact images; wrong reports: ${wrong}; ` +
    `TS/Python decoder disagreements: ${mismatches} (informational: the phone runs the TS decoder)`);
  process.exit(wrong ? 1 : 0);
})();
