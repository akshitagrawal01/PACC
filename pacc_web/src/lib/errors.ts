/** Human-readable message from any thrown value. */
export function errorMessage(err: unknown, fallback = "Unknown error"): string {
  if (err instanceof Error) return err.message || fallback;
  if (typeof err === "string") return err || fallback;
  return fallback;
}

/**
 * Shape of values the decoders and browser media APIs throw: a DOMException-style
 * name/message, plus the payload/header that EncryptedBarcodeError carries.
 * Every field is optional because a caught value may be any of them.
 */
export interface ThrownError {
  name?: string;
  message?: string;
  rawPayload?: Uint8Array;
  header?: { raw?: Uint8Array; multilayer?: boolean; eccLevel?: number; [key: string]: unknown };
}
