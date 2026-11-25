/**
 * What a Test Lab phone reports for one decode, given the item's `expect` rule
 * (scripts/pacc_suites.py). The server compares the report with the item's payload,
 * so returning null means "keep scanning" (e.g. only the coarse layer was read so far).
 */
import type { WorkerDecodeResult } from "@/lib/pacc/client";
import type { QcDecodeResult } from "@/lib/pacc/qc";

export type Expect = "text" | "signed" | "reject" | "coarse" | "fine" | "qc_hidden";

const utf8 = (b?: Uint8Array) => (b ? new TextDecoder("utf-8").decode(b) : "");

export function reportPacc(expect: Expect | undefined, r: WorkerDecodeResult | null | undefined): string | null {
  if (!r) return null;
  switch (expect) {
    case "fine":
      // The coarse layer alone is not enough: the tester has to come closer.
      return r.fine?.ok && r.fine.payload ? utf8(r.fine.payload) : null;
    case "reject":
      if (r.security?.signatureValid === false) return "REJECTED";
      return r.ok && r.payload ? `ACCEPTED: ${utf8(r.payload)}` : null;
    case "signed":
      if (!r.ok || !r.payload) return null;
      if (r.security?.signatureValid === true) return utf8(r.payload);
      if (r.security?.signatureValid === false) return "SIGNATURE INVALID";
      return null; // signer key not loaded yet: keep scanning
    default:
      return r.ok && r.payload ? utf8(r.payload) : null;
  }
}

export function reportQc(q: QcDecodeResult | null | undefined): string | null {
  if (!q?.ok || !q.hidden) return null;
  return q.bound === false ? "HIDDEN PART NOT BOUND TO THIS QR" : utf8(q.hidden);
}
