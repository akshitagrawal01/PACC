// Minimal types for pngjs (installed with `qrcode`), used by scripts/test_lab_items.ts.
declare module "pngjs" {
  export const PNG: { sync: { read(buf: Buffer): { width: number; height: number; data: Buffer } } };
}
