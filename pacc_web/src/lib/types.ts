export interface QrComparison {
  stdDataUrl: string | null;
  stdSize: number | null;
  stdVersion: number | null;
  stdMatrix: number | null;
  stdEccLevel: string;
  stdEccRecovery: string;
  stdModulesCount: number;
  stdPayloadBytes: number;
  stdMode: string;
  stdBitsPerCell: string;
  stdError: string | null;
}

export interface JabComparison {
  jabDataUrl: string | null;
  jabSize: number | null;
  jabMatrix: number | null;
  jabEccLevel: string;
  jabEccRecovery: string;
  jabModulesCount: number;
  jabPayloadBytes: number;
  jabColors: number;
  jabBitsPerCell: string;
  jabError: string | null;
}

export interface SingleComparison {
  available: boolean;
  dataUrl?: string | null;
  gridSide?: number | null;
  totalModules?: number | null;
  effectiveCopies?: number;
  requestedCopies?: number;
  cannotFitCopies?: boolean;
  error?: string | null;
}

export interface EncodeResponse {
  success: boolean;
  error?: string;
  cannotFitCopies?: boolean;
  dataUrl?: string;
  gridSide?: number;
  singleLayerGridSide?: number;
  singleComparison?: SingleComparison | null;
  gridSavedSteps?: number;
  areaReductionPercent?: number;
  payloadBytes?: number;
  rawBytes?: number;
  imageSize?: [number, number];
  compressed?: boolean;
  encrypted?: boolean;
  encryptedLayer1?: boolean;
  eccLevel?: number;
  minCopies?: number;
  effectiveCopies?: number;
  requestedCopies?: number;
  copiesReduced?: boolean;
  copyWarning?: string | null;
  cellSize?: number;
  bitsPerCell?: number;
  durationMs?: number;
  totalModules?: number;
  codeType?: string;
  qrComparison?: QrComparison;
  jabComparison?: JabComparison;
}

export interface DecodeMetadata {
  cellSize?: string | null;
  gridSide?: string | null;
  eccLevel?: string | null;
  encrypted?: boolean;
  multilayer?: boolean;
  isContinuation?: boolean;
  quietZone?: string | null;
  bitsPerCell?: number;
  // Diagnostic fields surfaced from decoder internals
  eccCorrections?: number;     // RS bytes corrected (0 = clean decode)
  erasuresHit?: number;        // total weighted erasure count before RS
  copiesVoted?: number;        // redundant copies that participated in majority vote
  hueRotUsed?: number;         // hue rotation angle that succeeded (0 = no rotation)
  sampleModeUsed?: string;     // "adaptive" | "gaussian" | "sharp_core"
  passUsed?: string;           // "direct-grid" | "deblur" | "homography" | "clahe" | "outer-boundary"
}

export interface DecodeResponse {
  success: boolean;
  error?: string;
  requiresPassword?: boolean;
  encrypted?: boolean;
  multilayer?: boolean;
  isContinuation?: boolean;
  bitsPerCell?: number;
  text?: string;
  totalText?: string;
  bytesLen?: number;
  totalBytesLen?: number;
  isBinary?: boolean;
  hexPreview?: string;
  payloadBase64?: string;        // full base64 payload for binary/hex viewer
  durationMs?: number;
  /** "native" (in-browser PACC), "api" (server bridge) or e.g. "ZXing (QRCode)". */
  engine?: string;
  tier?: "tier1_tracking" | "tier2_roi" | "tier3_cold";
  fps?: number;
  barcodeRatio?: number;
  suggestedZoom?: "in" | "out" | "hold";
  targetZoomMultiplier?: number;
  targetCenter?: { x: number; y: number };
  metadata?: DecodeMetadata;
  encryptedPayload?: string;
  headerBytes?: string;
  layer1Locked?: boolean;
  layer1EncPayload?: string;
  layer2Locked?: boolean;
  layer2EncPayload?: string;
  layer2Text?: string | null;
  layer2BytesLen?: number;
  layer2IsBinary?: boolean;
  layer2HexPreview?: string;
  codeType?: string;
  /** PACC security / stream status. */
  pacc2?: {
    signed?: string;
    signer?: string;
    signatureValid?: boolean | null;
    trusted?: boolean;
    encrypted?: string;
    recipientKid?: string;
    locked?: string;
    stream?: { k: number; rank: number; received: number };
    /** PACC QC: hidden channel text and whether it is bound to the visible QR text. */
    qcHidden?: string;
    qcBound?: boolean;
    /** Fine layer of a distance-adaptive layered symbol. */
    fine?: {
      ok: boolean;
      text?: string;
      error?: string;
      locked?: string;
      encrypted?: string;
      signed?: string;
      signatureValid?: boolean | null;
    };
  };
}


export interface PaccVersionItem {
  version: number;
  title: string;
  gridSide: number;
  totalCells: number;
  safeCells?: number;
  payloadBytes: number;
  capacityBytes?: number;
  payloadSnippet?: string;
  payload?: string;
  eccLevel: number;
  eccLabel?: string;
  minCopies: number;
  copiesLabel?: string;
  compressed?: boolean;
  encrypted?: boolean;
  bitsPerCell?: number;
  l1Bytes?: number;
  l2Bytes?: number;
  capacityL1?: number;
  capacityL2?: number;
  fillPercent?: number;
  encodeMs: number;
  decodeMs: number;
  decoded: boolean;
  dataUrl: string;
  /** PACC matrix extras */
  mcsName?: string;
  variant?: string;
  codeRate?: string;
  error?: string;
}

export interface VersionsMatrixResponse {
  success: boolean;
  error?: string;
  mode: "grid_versions" | "config_matrix";
  payload: string;
  totalVersions: number;
  allDecoded: boolean;
  versions: PaccVersionItem[];
}
