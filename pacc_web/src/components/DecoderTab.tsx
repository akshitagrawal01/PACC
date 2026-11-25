"use client";

import React, { useState, useRef, useEffect, useCallback, useMemo, useSyncExternalStore } from "react";
import {
  Scan,
  UploadCloud,
  Camera,
  CameraOff,
  RefreshCw,
  Unlock,
  KeyRound,
  AlertTriangle,
  Copy,
  Check,
  ExternalLink,
  Sliders,
  Aperture,
  Smartphone,
  Info,
  ZoomIn,
  Lock,
  ArrowRight,
  History,
  Binary,
  ChevronDown,
  ChevronUp,
  Layers,
  ShieldCheck,
  ShieldAlert,
  Film,
} from "lucide-react";
import { DecodeResponse } from "@/lib/types";
import { decodeWithZXing, prewarmZXing } from "@/lib/zxingDecoder";
import { extractTestLabRoom } from "@/lib/testLabHelper";
import { openPrimaryCameraStream, enforceContinuousFocus } from "@/lib/cameraHelper";
import { errorMessage, type ThrownError } from "@/lib/errors";
import { getCameraCapabilities, type CameraConstraintSet } from "@/lib/browserApis";
import { decodePacc, decodeQcPacc, paccBusy, resetPaccLive, unlockPacc } from "@/lib/pacc/client";
import { canvasScale, planScan, plausibleLocate, toVideoRect, type Rect } from "@/lib/scanRoi";
import { PaccDecoderKeys } from "./PaccKeysPanel";
import { paccToResponse, qcToResponse } from "@/lib/pacc/toResponse";
import type { ZXingResult } from "@/lib/zxingDecoder";

const UPLOAD_MAX_DIM = 1280;

/** If a QR found by ZXing carries a PACC hidden chroma channel, read it. */
async function readQcChannel(img: ImageData, zx: ZXingResult): Promise<DecodeResponse | null> {
  if (!zx.corners || zx.corners.length !== 4 || !zx.version) return null;
  try {
    const { qc, durationMs } = await decodeQcPacc(img, zx.corners, zx.version, zx.text);
    return qc.ok ? qcToResponse(qc, durationMs) : null;
  } catch {
    return null;
  }
}


interface DecoderTabProps {
  initialImage?: string | null;
  initialCodec?: "auto" | "pacc" | "qr";
  onNavigateToTestLab?: (roomId: string, mode?: "host" | "scanner") => void;
}

export const DecoderTab: React.FC<DecoderTabProps> = ({
  initialImage,
  onNavigateToTestLab,
}) => {
  const [activeMode, setActiveMode] = useState<"upload" | "camera">(initialImage ? "upload" : "camera");
  const [imageSrc, setImageSrc] = useState<string | null>(initialImage || null);
  const [prevInitialImage, setPrevInitialImage] = useState<string | null>(initialImage || null);
  if (initialImage && initialImage !== prevInitialImage) {
    setPrevInitialImage(initialImage);
    setImageSrc(initialImage);
    setActiveMode("upload");
  }
  const [password, setPassword] = useState<string>("");
  const [showPasswordModal, setShowPasswordModal] = useState<boolean>(false);

  const [loading, setLoading] = useState<boolean>(false);
  const [result, setResult] = useState<DecodeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<boolean>(false);

  // Binary / Hex View Mode (Task H)
  const [viewMode, setViewMode] = useState<"text" | "hex">("text");
  const [showRawPayload, setShowRawPayload] = useState<boolean>(false);
  const [selectedLayerTab, setSelectedLayerTab] = useState<"total" | "layer1" | "layer2">("total");

  // Recent Scan History (Task F)
  const [scanHistory, setScanHistory] = useState<
    Array<{
      id: string;
      timestamp: string;
      preview: string;
      isBinary?: boolean;
      multilayer?: boolean;
      isContinuation?: boolean;
      durationMs?: number;
      engine?: string;
      result: DecodeResponse;
    }>
  >([]);

  // Per-channel partial unlock states
  const [layer1Pass, setLayer1Pass] = useState<string>("");
  const [layer2Pass, setLayer2Pass] = useState<string>("");
  const [unlockingLayer, setUnlockingLayer] = useState<boolean>(false);
  const [unlockError, setUnlockError] = useState<string | null>(null);

  // Camera Scanner State & Adaptive Pipeline
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const nativeCameraInputRef = useRef<HTMLInputElement | null>(null);

  const [cameraActive, setCameraActive] = useState<boolean>(false);
  const [facingMode, setFacingMode] = useState<"environment" | "user">("environment");
  const [scanStatus, setScanStatus] = useState<"idle" | "starting" | "scanning" | "analyzing" | "found">("idle");
  const [liveStats, setLiveStats] = useState<{ fps: number; latencyMs: number; tier?: string }>({ fps: 0, latencyMs: 0 });
  const [streamProgress, setStreamProgress] = useState<{ k: number; rank: number; received: number } | null>(null);
  const isSecureContext = useSyncExternalStore(
    () => () => {},
    () => (typeof window !== "undefined" ? (window.isSecureContext || window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1") : true),
    () => true
  );
  const hasMediaDevices = useSyncExternalStore(
    () => () => {},
    () => (typeof navigator !== "undefined" && !!navigator?.mediaDevices?.getUserMedia),
    () => true
  );

  const scanTimerRef = useRef<NodeJS.Timeout | null>(null);
  const isScanningRef = useRef<boolean>(false);
  const liveFrameIndexRef = useRef<number>(0);

  // Auto-Zoom & Manual Zoom States
  const [autoZoom, setAutoZoom] = useState<boolean>(true);
  const [zoomLevel, setZoomLevel] = useState<number>(1.0);
  const [hasHardwareZoom, setHasHardwareZoom] = useState<boolean>(false);
  const [maxZoom, setMaxZoom] = useState<number>(4.0);
  const [minZoom, setMinZoom] = useState<number>(1.0);

  const autoZoomRef = useRef<boolean>(true);
  const zoomLevelRef = useRef<number>(1.0);
  const maxZoomRef = useRef<number>(4.0);
  const minZoomRef = useRef<number>(1.0);
  const hasHardwareZoomRef = useRef<boolean>(false);
  const lastAutoZoomTimeRef = useRef<number>(0);
  const noBarcodeFramesRef = useRef<number>(0);
  const videoTrackRef = useRef<MediaStreamTrack | null>(null);
  const targetCenterRef = useRef<{ x: number; y: number } | null>(null);
  const consecutiveInFramesRef = useRef<number>(0);
  const consecutiveOutFramesRef = useRef<number>(0);
  const lastCropRef = useRef<{ x: number; y: number; w: number; h: number }>({ x: 0, y: 0, w: 0, h: 0 });
  const smoothCenterRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  // Where the PACC decoder last saw (but could not read) a symbol, in video pixels; drives the
  // full-resolution crop passes and auto-zoom for distant symbols.
  const paccLocatedRef = useRef<{ rect: Rect; module: number; t: number } | null>(null);
  // Counts frames handed to the PACC worker. Passes alternate per submitted frame, not per camera
  // frame: frames are dropped while a decode runs, so frame parity could starve the crop passes.
  const paccPassRef = useRef<number>(0);

  // Direct connect auto-countdown timer (3 seconds)
  const [autoConnectSec, setAutoConnectSec] = useState<number | null>(null);

  useEffect(() => {
    autoZoomRef.current = autoZoom;
  }, [autoZoom]);

  useEffect(() => {
    prewarmZXing();
  }, []);

  const addToScanHistory = useCallback((res: DecodeResponse) => {
    if (!res.success) return;
    const displayText = res.totalText || res.text || "";
    const preview = displayText
      ? displayText.slice(0, 32)
      : res.hexPreview
      ? res.hexPreview.slice(0, 32)
      : "Decoded payload";
    const now = new Date();
    const timeStr = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const isMulti = Boolean(
      res.multilayer ||
      res.bitsPerCell === 3.0 ||
      res.layer2Text ||
      res.layer2Locked ||
      (res.layer2BytesLen && res.layer2BytesLen > 0)
    );
    const item = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: timeStr,
      preview,
      isBinary: res.isBinary,
      multilayer: isMulti,
      durationMs: res.durationMs,
      engine: res.engine,
      result: res,
    };
    setScanHistory((prev) => {
      if (
        prev.length > 0 &&
        prev[0].preview === item.preview &&
        (prev[0].result.totalText || prev[0].result.text) === displayText
      ) {
        return prev;
      }
      return [item, ...prev].slice(0, 5);
    });
  }, []);

  useEffect(() => {
    if (result && result.success) {
      const timer = setTimeout(() => {
        addToScanHistory(result);
        if (result.isBinary) {
          setViewMode("hex");
        }
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [result, addToScanHistory]);

  const formatHexPreview = (bytes: Uint8Array, max = 256): string => {
    return Array.from(bytes.subarray(0, max), (b) => b.toString(16).padStart(2, "0").toUpperCase()).join(" ");
  };

  const formatHexFromText = useCallback((str: string) => {
    const enc = new TextEncoder();
    const bytes = enc.encode(str);
    return formatHexPreview(bytes, 256);
  }, []);

  // Smoothly applies zoom via hardware camera constraints or digital canvas crop with hysteresis
  const applyZoom = useCallback((targetZoom: number, centerNorm?: { x: number; y: number }) => {
    const minZ = minZoomRef.current;
    const maxZ = maxZoomRef.current;
    const clamped = Math.max(minZ, Math.min(maxZ, targetZoom));
    const rounded = Math.round(clamped * 10) / 10;

    // Ignore trivial changes (< 0.05x) to eliminate jitter and unnecessary driver re-configuration
    if (Math.abs(rounded - zoomLevelRef.current) < 0.05) return;

    zoomLevelRef.current = rounded;
    setZoomLevel(rounded);
    paccLocatedRef.current = null; // its video coordinates no longer apply

    if (videoTrackRef.current && hasHardwareZoomRef.current) {
      try {
        const advancedConstraint: CameraConstraintSet = { zoom: rounded };
        if (centerNorm) {
          advancedConstraint.pointsOfInterest = [{ x: centerNorm.x / 100, y: centerNorm.y / 100 }];
        }
        videoTrackRef.current
          .applyConstraints({
            advanced: [advancedConstraint],
          })
          .catch((err) => {
            console.warn("Hardware zoom apply constraint failed:", err);
          });
      } catch (err) {
        console.warn("applyConstraints zoom failed:", err);
      }
    }

    if (videoRef.current && !hasHardwareZoomRef.current) {
      videoRef.current.style.transform = rounded > 1.05 ? `scale(${rounded})` : "none";
      if (centerNorm && rounded > 1.05) {
        const ox = Math.max(20, Math.min(80, Math.round(centerNorm.x)));
        const oy = Math.max(20, Math.min(80, Math.round(centerNorm.y)));
        videoRef.current.style.transformOrigin = `${ox}% ${oy}%`;
      } else {
        videoRef.current.style.transformOrigin = "center center";
      }
      videoRef.current.style.transition = "transform 0.25s ease-out";
    }
  }, []);

  // Browser security environment is continuously derived via useSyncExternalStore above.

  const isDual = Boolean(
    !result?.multilayer &&
    (result?.bitsPerCell === 3.0 ||
    result?.codeType === "PACC_DUAL" ||
    result?.layer2Text ||
    result?.layer2Locked ||
    (result?.layer2BytesLen && result.layer2BytesLen > 0))
  );

  const l1Text = result?.text || "";
  const l2Text = result?.layer2Text || "";

  const totalText = useMemo(() => {
    if (!result) return "";
    if (result.totalText) return result.totalText;
    if (!isDual || !l2Text) return l1Text;
    if (!l1Text) return l2Text;
    if (result.isContinuation || result.metadata?.isContinuation || /\s$/.test(l1Text) || /^\s/.test(l2Text)) {
      return l1Text + l2Text;
    }
    return `${l1Text}\n${l2Text}`;
  }, [result, isDual, l1Text, l2Text]);

  const l1Bytes = result?.bytesLen ?? 0;
  const l2Bytes = result?.layer2BytesLen ?? 0;
  const totalBytes = useMemo(() => {
    if (!result) return 0;
    if (result.totalBytesLen !== undefined && result.totalBytesLen > 0) {
      return result.totalBytesLen;
    }
    if (isDual) {
      return (l1Bytes || 0) + (l2Bytes || 0);
    }
    return l1Bytes || 0;
  }, [result, isDual, l1Bytes, l2Bytes]);

  const activeDisplayText = useMemo(() => {
    if (!isDual || selectedLayerTab === "total") {
      return totalText;
    }
    if (selectedLayerTab === "layer1") {
      return l1Text;
    }
    return l2Text;
  }, [isDual, selectedLayerTab, totalText, l1Text, l2Text]);

  const activeHexPreview = useMemo(() => {
    if (!result) return "";
    if (!isDual || selectedLayerTab === "total") {
      if (result.hexPreview && !isDual) return result.hexPreview;
      return totalText ? formatHexFromText(totalText) : (result.hexPreview || "No binary data");
    }
    if (selectedLayerTab === "layer1") {
      return result.hexPreview || (l1Text ? formatHexFromText(l1Text) : "No binary data");
    }
    return l2Text ? formatHexFromText(l2Text) : "No binary data";
  }, [result, isDual, selectedLayerTab, totalText, l1Text, l2Text, formatHexFromText]);

  const activeUrl = useMemo(() => {
    const t = (activeDisplayText || totalText || result?.text || "").trim();
    return t.startsWith("http://") || t.startsWith("https://") ? t : null;
  }, [activeDisplayText, totalText, result]);

  const [prevResultText, setPrevResultText] = useState<string | null>(null);
  const currentResultText = result ? `${result.text || ""}|${result.totalText || ""}` : null;
  if (currentResultText !== prevResultText) {
    setPrevResultText(currentResultText);
    setSelectedLayerTab("total");
  }

  // Check if decoded result is a Test Lab room link / payload
  const testLabTarget = useMemo(() => {
    if (!result?.success) return null;
    const textToCheck = totalText || result.text;
    return extractTestLabRoom(textToCheck || "");
  }, [result, totalText]);

  const [prevTestLabTargetKey, setPrevTestLabTargetKey] = useState<string | null>(null);
  const currentTestLabTargetKey = testLabTarget && onNavigateToTestLab ? `${testLabTarget.roomId}:${testLabTarget.mode}` : null;
  if (currentTestLabTargetKey !== prevTestLabTargetKey) {
    setPrevTestLabTargetKey(currentTestLabTargetKey);
    setAutoConnectSec(currentTestLabTargetKey ? 3 : null);
  }

  const cameraActiveRef = useRef<boolean>(false);

  // Stop camera helper
  const stopCamera = useCallback(() => {
    cameraActiveRef.current = false;
    if (scanTimerRef.current) {
      clearTimeout(scanTimerRef.current);
      scanTimerRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
      videoRef.current.style.transform = "none";
    }
    videoTrackRef.current = null;
    targetCenterRef.current = null;
    smoothCenterRef.current = { x: 0, y: 0 };
    lastCropRef.current = { x: 0, y: 0, w: 0, h: 0 };
    paccLocatedRef.current = null;
    consecutiveInFramesRef.current = 0;
    consecutiveOutFramesRef.current = 0;
    zoomLevelRef.current = 1.0;
    setZoomLevel(1.0);
    resetPaccLive().catch(() => {});
    setStreamProgress(null);
    setLiveStats({ fps: 0, latencyMs: 0 });
    isScanningRef.current = false;
    setCameraActive(false);
    setScanStatus("idle");
  }, []);

  const handleConnectTestLab = useCallback(
    (roomId: string, mode: "host" | "scanner" = "scanner") => {
      setAutoConnectSec(null);
      stopCamera();
      onNavigateToTestLab?.(roomId, mode);
    },
    [stopCamera, onNavigateToTestLab]
  );

  useEffect(() => {
    if (autoConnectSec === null || autoConnectSec <= 0) return;
    const timer = setTimeout(() => {
      if (autoConnectSec === 1) {
        if (testLabTarget && onNavigateToTestLab) {
          handleConnectTestLab(testLabTarget.roomId, testLabTarget.mode);
        } else {
          setAutoConnectSec(null);
        }
      } else {
        setAutoConnectSec((prev) => (prev !== null ? prev - 1 : null));
      }
    }, 1000);
    return () => clearTimeout(timer);
  }, [autoConnectSec, testLabTarget, onNavigateToTestLab, handleConnectTestLab]);

  // Helper to extract raw ImageData from Base64 or Image URL for 0-latency native decoding
  const getImageDataFromBase64 = (b64: string, maxDim = Infinity): Promise<ImageData> => {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        const w = img.naturalWidth || img.width;
        const h = img.naturalHeight || img.height;
        const scale = Math.min(1, maxDim / Math.max(w, h));
        const cvs = document.createElement("canvas");
        cvs.width = Math.round(w * scale);
        cvs.height = Math.round(h * scale);
        const ctx = cvs.getContext("2d", { willReadFrequently: true });
        if (!ctx) {
          reject(new Error("Cannot acquire canvas 2D context"));
          return;
        }
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(img, 0, 0, cvs.width, cvs.height);
        try {
          resolve(ctx.getImageData(0, 0, cvs.width, cvs.height));
        } catch (err) {
          reject(err);
        }
      };
      img.onerror = () => reject(new Error("Image failed to load into canvas"));
      img.src = b64;
    });
  };

  // Core decode call: Native TypeScript client-side first, server fallback second
  const performDecode = async (imgBase64: string, pass?: string) => {
    setLoading(true);
    setError(null);

    if (pass) {
      try {
        const u = await unlockPacc(pass);
        const resp = "qc" in u ? qcToResponse(u.qc, 0) : paccToResponse(u);
        if (resp.success && !resp.requiresPassword) {
          setResult(resp);
          addToScanHistory(resp);
          setShowPasswordModal(false);
          setPassword("");
          setError(null);
        } else {
          setError(resp.requiresPassword ? "Wrong passphrase — try again." : resp.error ?? "Decryption failed");
        }
      } catch (err: unknown) {
        setError(errorMessage(err as ThrownError, "Decryption failed"));
      } finally {
        setLoading(false);
      }
      return;
    }

    try {
      const imgData = await getImageDataFromBase64(imgBase64);
      // 1. PACC via Web Worker; full-size phone photos can mislead grid-size estimation, so try the snapshot size first.
      try {
        let v = await decodePacc(
          Math.max(imgData.width, imgData.height) > UPLOAD_MAX_DIM
            ? await getImageDataFromBase64(imgBase64, UPLOAD_MAX_DIM)
            : imgData,
        );
        if (!(v.ok || v.stream || v.locked) && Math.max(imgData.width, imgData.height) > UPLOAD_MAX_DIM) {
          v = await decodePacc(imgData);
        }
        if (v.ok || v.stream || v.locked) {
          const resp = paccToResponse(v);
          setResult(resp);
          setShowPasswordModal(Boolean(resp.requiresPassword));
          // Locked symbols are explained in the result panel, so no separate error.
          setError(resp.success || resp.encrypted ? null : resp.error ?? null);
          setLoading(false);
          return;
        }
      } catch {
        // Continue to QR
      }

      // 2. Standard QR and PACC QC hidden channel
      const zxRes = await decodeWithZXing(imgData, ["QRCode"]);
      const qcRes = zxRes?.text ? await readQcChannel(imgData, zxRes) : null;
      if (qcRes) {
        setResult(qcRes);
        setShowPasswordModal(Boolean(qcRes.requiresPassword));
        setError(qcRes.requiresPassword ? "The hidden PACC channel is passphrase-protected." : null);
        setLoading(false);
        return;
      }
      if (zxRes?.text) {
        setResult({
          success: true,
          text: zxRes.text,
          bytesLen: zxRes.text.length,
          durationMs: 0,
          engine: `ZXing (${zxRes.format})`,
        });
        setShowPasswordModal(false);
        setError(null);
        setLoading(false);
        return;
      }

      setError("No recognizable PACC or QR symbol detected in image.");
      setResult(null);
    } catch (err: unknown) {
      setError(errorMessage(err, "Failed to decode image."));
      setResult(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (initialImage) {
      const timer = setTimeout(() => {
        performDecode(initialImage);
      }, 0);
      return () => clearTimeout(timer);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialImage]);

  // Handle file drop & selection
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      processFile(file);
    }
  };

  const processFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const b64 = reader.result as string;
      setImageSrc(b64);
      performDecode(b64);
    };
    reader.readAsDataURL(file);
  };

  // Clipboard Paste (Ctrl+V)
  useEffect(() => {
    const handlePaste = (e: ClipboardEvent) => {
      if (activeMode !== "upload") return;
      const items = e.clipboardData?.items;
      if (!items) return;

      for (let i = 0; i < items.length; i++) {
        if (items[i].type.indexOf("image") !== -1) {
          const file = items[i].getAsFile();
          if (file) {
            processFile(file);
            break;
          }
        }
      }
    };

    window.addEventListener("paste", handlePaste);
    return () => window.removeEventListener("paste", handlePaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeMode]);

  const captureAndDecodeFrameRef = useRef<() => void>(() => {});

  // Frame capture & 3-tier adaptive real-time in-browser native decode (Paced at 30 FPS)
  const captureAndDecodeFrame = useCallback(async () => {
    if (!videoRef.current || !canvasRef.current || isScanningRef.current || !cameraActiveRef.current) return;
    const video = videoRef.current;
    const canvas = canvasRef.current;

    // Check video readiness
    if (video.readyState < 2 || video.videoWidth === 0 || video.videoHeight === 0) {
      if (cameraActiveRef.current) {
        scanTimerRef.current = setTimeout(() => { captureAndDecodeFrameRef.current(); }, 50);
      }
      return;
    }

    const tFrameStart = performance.now();
    isScanningRef.current = true;
    setScanStatus("analyzing");
    liveFrameIndexRef.current++;
    const frameIdx = liveFrameIndexRef.current;

    try {
      // The visible view: the whole frame, or the digital-zoom crop (target-centred, smoothed).
      let view: Rect = { x: 0, y: 0, w: video.videoWidth, h: video.videoHeight };
      const z = zoomLevelRef.current;
      if (z > 1.05 && !hasHardwareZoomRef.current) {
        const cropW = video.videoWidth / z;
        const cropH = video.videoHeight / z;
        if (smoothCenterRef.current.x === 0 && smoothCenterRef.current.y === 0) {
          smoothCenterRef.current = { x: video.videoWidth / 2, y: video.videoHeight / 2 };
        }
        view = {
          x: Math.max(0, Math.min(video.videoWidth - cropW, smoothCenterRef.current.x - cropW / 2)),
          y: Math.max(0, Math.min(video.videoHeight - cropH, smoothCenterRef.current.y - cropH / 2)),
          w: cropW,
          h: cropH,
        };
      }

      // Even frames: the whole view shrunk to 640 px (fast, finds symbols anywhere). Odd frames: a
      // full-resolution crop around a symbol seen recently, or the centre of the view, so that
      // distant symbols keep enough pixels per module (see lib/scanRoi.ts).
      const located = paccLocatedRef.current;
      const fresh = located && performance.now() - located.t < 1500 ? located.rect : null;
      const paccFree = !paccBusy();
      const plan = planScan(paccFree ? paccPassRef.current++ : 0, view, fresh);
      canvas.width = plan.width;
      canvas.height = plan.height;

      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) {
        isScanningRef.current = false;
        if (cameraActiveRef.current) {
          scanTimerRef.current = setTimeout(() => { captureAndDecodeFrameRef.current(); }, 50);
        }
        return;
      }

      lastCropRef.current = plan.src;
      ctx.drawImage(video, plan.src.x, plan.src.y, plan.src.w, plan.src.h, 0, 0, canvas.width, canvas.height);
      const frameImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

      // PACC runs in its worker alongside the Prototype 22 live pipeline. Frames are
      // dropped (not queued) while a decode is in flight, so the UI never stalls.
      if (paccFree) {
        decodePacc(frameImageData, { live: true })
          .then((v) => {
            if (!cameraActiveRef.current) return;
            if (!v.ok && v.locate) {
              // Seen but not read: remember where, in video pixels, for the next crop pass and auto-zoom.
              const rect = toVideoRect(plan, v.locate);
              const modulePx = v.locate.module / canvasScale(plan);
              if (plausibleLocate(rect, modulePx)) paccLocatedRef.current = { rect, module: modulePx, t: performance.now() };
            }
            if (v.stream && !v.ok) {
              setStreamProgress({ k: v.stream.k, rank: v.stream.rank, received: v.stream.received });
              return;
            }
            if (!v.ok) return;
            setStreamProgress(null);
            setImageSrc(canvas.toDataURL("image/jpeg", 0.85));
            const resp = paccToResponse(v);
            setResult(resp);
            if (resp.requiresPassword) {
              setShowPasswordModal(true);
              setError(resp.error ?? null);
            }
            if (typeof navigator !== "undefined" && navigator.vibrate) {
              try {
                navigator.vibrate([80, 40, 80]);
              } catch {}
            }
            stopCamera();
            setScanStatus("found");
          })
          .catch(() => {});
      }

      // Check standard QR / QC hidden channel every 4 frames
      let nativeRes: DecodeResponse | null = null;
      if (frameIdx % 4 === 0) {
        try {
          const zx = await decodeWithZXing(frameImageData, ["QRCode"]);
          const qcRes = zx?.text ? await readQcChannel(frameImageData, zx) : null;
          if (qcRes) {
            nativeRes = { ...qcRes, durationMs: Math.round(performance.now() - tFrameStart) };
          } else if (zx?.text) {
            nativeRes = {
              success: true,
              text: zx.text,
              bytesLen: zx.text.length,
              durationMs: Math.round(performance.now() - tFrameStart),
              engine: `ZXing (${zx.format})`,
            };
          }
        } catch {}
      }

      if (nativeRes?.targetCenter && canvas.width > 0 && canvas.height > 0) {
        const lastCrop = lastCropRef.current;
        const absX = lastCrop.x + (nativeRes.targetCenter.x / canvas.width) * lastCrop.w;
        const absY = lastCrop.y + (nativeRes.targetCenter.y / canvas.height) * lastCrop.h;

        // Apply 85% exponential moving average (EMA) smoothing for rock-solid stability
        if (smoothCenterRef.current.x === 0 && smoothCenterRef.current.y === 0) {
          smoothCenterRef.current = { x: absX, y: absY };
        } else {
          smoothCenterRef.current = {
            x: smoothCenterRef.current.x * 0.85 + absX * 0.15,
            y: smoothCenterRef.current.y * 0.85 + absY * 0.15,
          };
        }
        targetCenterRef.current = smoothCenterRef.current;
      }

      // Auto-Zoom Predictive Adaptation with Dual-Frame Confirmation & Hysteresis Hold
      if (autoZoomRef.current && !nativeRes?.success) {
        const now = performance.now();
        let suggested = nativeRes?.suggestedZoom;
        let multiplier = nativeRes?.targetZoomMultiplier;
        // A PACC symbol seen with too few pixels per module: hardware zoom adds real sensor detail,
        // so zoom towards about 4 px per module. (Digital zoom adds no detail; the crop passes
        // above already read at native resolution.)
        const seen = paccLocatedRef.current;
        if (!suggested && hasHardwareZoomRef.current && seen && now - seen.t < 1500) {
          suggested = seen.module < 3.5 ? "in" : "hold";
          multiplier = Math.max(1.3, Math.min(2.5, 4 / Math.max(seen.module, 0.5)));
          targetCenterRef.current = { x: seen.rect.x + seen.rect.w / 2, y: seen.rect.y + seen.rect.h / 2 };
        }

        if (suggested === "in") {
          noBarcodeFramesRef.current = 0;
          consecutiveOutFramesRef.current = 0;
          consecutiveInFramesRef.current++;

          if (consecutiveInFramesRef.current >= 2 && now - lastAutoZoomTimeRef.current > 450) {
            const mult = multiplier || 1.35;
            const desiredZoom = Math.min(maxZoomRef.current, zoomLevelRef.current * mult);

            if (desiredZoom - zoomLevelRef.current >= 0.25) {
              const nextZoom = Math.round((zoomLevelRef.current + (desiredZoom - zoomLevelRef.current) * 0.65) * 10) / 10;
              const centerNorm =
                targetCenterRef.current && video.videoWidth > 0
                  ? {
                      x: (targetCenterRef.current.x / video.videoWidth) * 100,
                      y: (targetCenterRef.current.y / video.videoHeight) * 100,
                    }
                  : undefined;
              applyZoom(nextZoom, centerNorm);
              lastAutoZoomTimeRef.current = now;
              consecutiveInFramesRef.current = 0;
            }
          }
        } else if (suggested === "out") {
          noBarcodeFramesRef.current = 0;
          consecutiveInFramesRef.current = 0;
          consecutiveOutFramesRef.current++;

          if (consecutiveOutFramesRef.current >= 2 && now - lastAutoZoomTimeRef.current > 500) {
            const nextZoom = Math.max(minZoomRef.current, Math.round((zoomLevelRef.current - 0.5) * 10) / 10);
            if (zoomLevelRef.current - nextZoom >= 0.25) {
              applyZoom(nextZoom);
              lastAutoZoomTimeRef.current = now;
              consecutiveOutFramesRef.current = 0;
            }
          }
        } else if (suggested === "hold") {
          noBarcodeFramesRef.current = 0;
          consecutiveInFramesRef.current = 0;
          consecutiveOutFramesRef.current = 0;
        } else {
          noBarcodeFramesRef.current++;
          consecutiveInFramesRef.current = 0;
          consecutiveOutFramesRef.current = 0;

          if (noBarcodeFramesRef.current > 100 && zoomLevelRef.current > 1.2 && now - lastAutoZoomTimeRef.current > 500) {
            applyZoom(Math.max(minZoomRef.current, Math.round((zoomLevelRef.current - 0.4) * 10) / 10));
            lastAutoZoomTimeRef.current = now;
          }
        }
      }

      if (nativeRes && nativeRes.success) {
        const frameBase64 = canvas.toDataURL("image/jpeg", 0.85);
        setImageSrc(frameBase64);
        setResult({
          ...nativeRes,
          engine: nativeRes.engine || "native",
        });
        if (nativeRes.requiresPassword) setShowPasswordModal(true); // QC hidden channel is locked
        if (typeof navigator !== "undefined" && navigator.vibrate) {
          try {
            navigator.vibrate([80, 40, 80]);
          } catch {}
        }
        stopCamera();
        setScanStatus("found");
        return;
      }

      if (nativeRes && nativeRes.requiresPassword) {
        const frameBase64 = canvas.toDataURL("image/jpeg", 0.85);
        setImageSrc(frameBase64);
        setResult({
          ...nativeRes,
          engine: "native",
        });
        setShowPasswordModal(true);
        stopCamera();
        setScanStatus("found");
        return;
      }
    } catch {
      // Continue continuous scanning quietly
    } finally {
      isScanningRef.current = false;
      if (cameraActiveRef.current && streamRef.current && streamRef.current.active) {
        setScanStatus("scanning");
        // Cooperative event loop pacing: ensure at least 20ms of breathing room for
        // UI rendering, tap-to-focus, and mobile gestures
        const frameElapsed = performance.now() - tFrameStart;
        const pacingDelay = Math.max(20, Math.round(33 - frameElapsed));
        scanTimerRef.current = setTimeout(() => { captureAndDecodeFrameRef.current(); }, pacingDelay);
      }
    }
  }, [password, stopCamera, applyZoom]);

  useEffect(() => {
    captureAndDecodeFrameRef.current = captureAndDecodeFrame;
  }, [captureAndDecodeFrame]);

  // Start camera with high-resolution constraints (1080p / 720p HD)
  const startCamera = useCallback(
    async (modeOverride?: "environment" | "user") => {
      setError(null);
      resetPaccLive().catch(() => {});
      const targetFacing = modeOverride || facingMode;

      if (!navigator?.mediaDevices?.getUserMedia) {
        setError(
          "Camera streaming API is not available on this connection. Modern browsers restrict live camera access to HTTPS or localhost. If testing over Wi-Fi, use the HTTPS link or use 'Take Photo with Phone Camera' below."
        );
        setCameraActive(false);
        setScanStatus("idle");
        return;
      }

      try {
        if (streamRef.current) {
          streamRef.current.getTracks().forEach((track) => track.stop());
        }

        setScanStatus("starting");

        const stream = await openPrimaryCameraStream(targetFacing);
        streamRef.current = stream;

        const videoTrack = stream.getVideoTracks()[0];
        videoTrackRef.current = videoTrack;
        let hwZoom = false;
        let minZ = 1.0;
        let maxZ = 4.0;

        await enforceContinuousFocus(videoTrack);

        // Inspect hardware optical zoom capabilities
        if (videoTrack && typeof videoTrack.getCapabilities === "function") {
          try {
            const caps = getCameraCapabilities(videoTrack);
            if (caps && caps.zoom) {
              hwZoom = true;
              minZ = caps.zoom.min || 1.0;
              maxZ = Math.min(caps.zoom.max || 5.0, 8.0);
            }
          } catch (e) {
            console.warn("Camera capabilities zoom query failed:", e);
          }
        }

        hasHardwareZoomRef.current = hwZoom;
        setHasHardwareZoom(hwZoom);
        minZoomRef.current = minZ;
        setMinZoom(minZ);
        maxZoomRef.current = maxZ;
        setMaxZoom(maxZ);
        zoomLevelRef.current = minZ;
        setZoomLevel(minZ);

        if (videoRef.current) {
          const vid = videoRef.current;
          vid.srcObject = stream;
          vid.setAttribute("playsinline", "true");
          vid.muted = true;

          const reFocus = () => {
            const trk = stream.getVideoTracks()[0];
            enforceContinuousFocus(trk);
          };

          vid.onloadedmetadata = reFocus;
          vid.onplaying = reFocus;
          vid.onresize = reFocus;

          try {
            await vid.play();
          } catch (playErr) {
            console.warn("video.play() aborted or blocked:", playErr);
          }

          setTimeout(reFocus, 400);
          setTimeout(reFocus, 1200);
        }

        cameraActiveRef.current = true;
        setCameraActive(true);
        setScanStatus("scanning");

        if (scanTimerRef.current) clearTimeout(scanTimerRef.current);
        scanTimerRef.current = setTimeout(() => captureAndDecodeFrame(), 150);
      } catch (caught: unknown) {
        const err = caught as ThrownError;
        console.error("Camera access error:", err);
        let msg = err.message || "Failed to access camera";
        if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") {
          msg = "Camera permission was denied. Please allow camera permissions in your browser.";
        } else if (err.name === "NotFoundError" || err.name === "DevicesNotFoundError") {
          msg = "No compatible camera device found on this system.";
        } else if (err.name === "NotReadableError" || err.name === "TrackStartError") {
          msg = "Camera is currently locked or in use by another application.";
        }
        setError(msg);
        cameraActiveRef.current = false;
        setCameraActive(false);
        setScanStatus("idle");
      }
    },
    [facingMode, captureAndDecodeFrame]
  );

  const toggleFacingMode = () => {
    const nextFacing = facingMode === "environment" ? "user" : "environment";
    setFacingMode(nextFacing);
    if (cameraActive) {
      startCamera(nextFacing);
    }
  };

  const handleManualCapture = async () => {
    if (!videoRef.current || !canvasRef.current) return;
    const video = videoRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;
    canvas.width = video.videoWidth || 1280;
    canvas.height = video.videoHeight || 720;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const b64 = canvas.toDataURL("image/jpeg", 0.9);
    setImageSrc(b64);
    await performDecode(b64);
  };

  const handleTabChange = (mode: "upload" | "camera") => {
    if (mode === activeMode) return;
    setActiveMode(mode);
    if (mode === "camera") {
      startCamera();
    } else {
      stopCamera();
    }
  };

  useEffect(() => {
    return () => {
      stopCamera();
    };
  }, [stopCamera]);

  const handleCopyText = () => {
    const textToCopy = activeDisplayText || totalText || result?.text;
    if (textToCopy) {
      navigator.clipboard.writeText(textToCopy);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleUnlockLayer = async (passOverride?: string) => {
    const pass = (passOverride || layer1Pass || layer2Pass || password).trim();
    if (!pass) {
      setUnlockError("Please enter a passphrase");
      return;
    }

    setUnlockingLayer(true);
    setUnlockError(null);

    const cleanPw = pass;
    try {
      const u = await unlockPacc(cleanPw);
      const resp = "qc" in u ? qcToResponse(u.qc, 0) : paccToResponse(u);
      if (resp.success && !resp.requiresPassword) {
        setResult(resp);
        addToScanHistory(resp);
        setShowPasswordModal(false);
        setPassword("");
        setLayer1Pass("");
        setLayer2Pass("");
        setUnlockError(null);
      } else {
        setUnlockError(resp.requiresPassword ? "Incorrect passphrase — please try again." : resp.error ?? "Decryption failed");
      }
    } catch (err: unknown) {
      setUnlockError(errorMessage(err as ThrownError, "Decryption failed"));
    } finally {
      setUnlockingLayer(false);
    }
  };

  const handleUnlockLayer2 = async () => {
    await handleUnlockLayer(layer2Pass);
  };

  const handlePasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await handleUnlockLayer(password);
  };

  return (
    <div className="w-full max-w-6xl mx-auto space-y-6">
      {/* Hidden file input for native mobile camera shutter */}
      <input
        type="file"
        accept="image/*"
        capture="environment"
        ref={nativeCameraInputRef}
        onChange={handleFileChange}
        className="hidden"
      />

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h1 className="page-title">Scan a symbol</h1>
          <p className="page-sub">Use your camera or an image. Reads PACC (standard, animated, layered, QR-compatible) and normal QR codes.</p>
        </div>
        <div className="seg self-start sm:self-auto">
          <button type="button" aria-pressed={activeMode === "camera"} onClick={() => handleTabChange("camera")} className="flex items-center gap-1.5">
            <Camera className="w-4 h-4" /> Camera
          </button>
          <button type="button" aria-pressed={activeMode === "upload"} onClick={() => handleTabChange("upload")} className="flex items-center gap-1.5">
            <UploadCloud className="w-4 h-4" /> Image
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Column: Input Dropzone or Camera Viewfinder */}
        <div className="lg:col-span-6 space-y-4">
          {/* Mode 1: Image Upload Dropzone */}
          <div className={activeMode === "upload" ? "block" : "hidden"}>
            <div className="card p-4 sm:p-5 space-y-3">

              {/* Drag & Drop Box */}
              <label
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  const file = e.dataTransfer.files?.[0];
                  if (file) processFile(file);
                }}
                className="relative border border-dashed rounded-xl p-6 sm:p-8 flex flex-col items-center justify-center cursor-pointer transition-colors min-h-[240px] sm:min-h-[300px] group overflow-hidden hover:border-stone-400"
                style={{
                  borderColor: "var(--border-strong)",
                  background: "var(--surface-2)",
                }}
              >
                <input
                  type="file"
                  accept="image/*"
                  onChange={handleFileChange}
                  className="hidden"
                />
                {imageSrc ? (
                  <div
                    className="relative max-h-[240px] max-w-[240px] p-2.5 rounded-xl shadow-xs flex items-center justify-center group/preview"
                    style={{ background: "var(--surface)", border: "1px solid var(--border)" }}
                  >
                    <img
                      src={imageSrc}
                      alt="Uploaded Barcode"
                      className="w-full h-full object-contain rounded-lg"
                    />
                    <div className="absolute inset-0 bg-stone-900/60 opacity-0 group-hover/preview:opacity-100 transition-opacity rounded-xl flex items-center justify-center text-white text-xs font-medium backdrop-blur-xs">
                      Click to choose another image
                    </div>
                  </div>
                ) : (
                  <>
                    <UploadCloud className="w-8 h-8 mb-3" style={{ color: "var(--text-4)" }} />
                    <span className="text-sm font-medium" style={{ color: "var(--text)" }}>
                      Drop an image here
                    </span>
                    <span className="hint mt-1 text-center max-w-xs">
                      or click to choose a file, or paste with Ctrl+V · PNG, JPEG, WebP
                    </span>
                  </>
                )}
              </label>

              {/* Mobile Phone Native Camera Button */}
              <div className="flex sm:hidden">
                <button
                  type="button"
                  onClick={() => nativeCameraInputRef.current?.click()}
                  className="btn-ghost w-full"
                >
                  <Smartphone className="w-4 h-4" />
                  <span>Take a photo</span>
                </button>
              </div>
            </div>
          </div>

          {/* Mode 2: Live Camera Viewfinder */}
          <div className={activeMode === "camera" ? "block" : "hidden"}>
            <div className="card p-4 sm:p-5 space-y-3">
              <div className="flex items-center justify-between gap-2 text-sm">
                <div className="flex items-center gap-2 min-w-0" style={{ color: "var(--text-2)" }}>
                  <span className={`w-2 h-2 rounded-full shrink-0 ${cameraActive ? "bg-emerald-500 animate-pulse" : "bg-stone-300"}`} />
                  <span className="font-medium truncate">{cameraActive ? "Scanning" : "Camera off"}</span>
                  {cameraActive && liveStats.fps > 0 && <span className="badge-neutral font-mono">{liveStats.fps} fps</span>}
                  {streamProgress && (
                    <span className="badge-green font-mono flex items-center gap-1">
                      <Film className="w-3 h-3 shrink-0" />
                      {streamProgress.rank}/{streamProgress.k}
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    onClick={() => setAutoZoom((prev) => !prev)}
                    aria-pressed={autoZoom}
                    className="btn-ghost !min-h-[32px] !py-1 !px-2.5 !text-xs"
                    style={autoZoom ? { color: "var(--accent)", borderColor: "var(--accent-mid)", background: "var(--accent-light)" } : undefined}
                    title="Zoom in automatically when a symbol is small"
                  >
                    <ZoomIn className="w-3.5 h-3.5" />
                    Auto-zoom
                  </button>
                  <button
                    onClick={toggleFacingMode}
                    className="btn-ghost !min-h-[32px] !py-1 !px-2.5 !text-xs"
                    title={`Using the ${facingMode === "environment" ? "back" : "front"} camera`}
                    aria-label="Switch camera"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    <span className="hidden sm:inline">{facingMode === "environment" ? "Back" : "Front"}</span>
                  </button>
                </div>
              </div>

              {/* Viewfinder Frame (4:3 aspect on mobile, 16:9 on desktop) */}
              <div className="relative aspect-[4/3] sm:aspect-video rounded-xl overflow-hidden bg-stone-900 flex items-center justify-center">
                {/* Persistent Video Element */}
                <video
                  ref={videoRef}
                  autoPlay
                  playsInline
                  muted
                  className="w-full h-full object-cover"
                />
                {/* Hidden processing canvas for downscaling & frame capture */}
                <canvas ref={canvasRef} className="hidden" />

                {/* Captured Image Display on Found */}
                {!cameraActive && scanStatus === "found" && imageSrc && (
                  <div className="absolute inset-0 z-15 flex items-center justify-center">
                    <img src={imageSrc} alt="Decoded Barcode Frame" className="w-full h-full object-cover" />
                  </div>
                )}

                {/* Found */}
                {scanStatus === "found" && (
                  <div className="absolute inset-0 z-30 flex items-center justify-center pointer-events-none bg-black/40 animate-in fade-in duration-200">
                    <div className="px-4 py-3 rounded-xl bg-white shadow-lg flex items-center gap-2.5 max-w-[80%]">
                      <span className="w-7 h-7 rounded-full bg-emerald-600 text-white flex items-center justify-center shrink-0">
                        <Check className="w-4 h-4 stroke-[3]" />
                      </span>
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-stone-900">Decoded</div>
                        {(result?.totalText || result?.text) && (
                          <div className="text-xs font-mono text-stone-500 truncate">{result.totalText || result.text}</div>
                        )}
                      </div>
                    </div>
                  </div>
                )}

                {/* Standby */}
                {!cameraActive && scanStatus !== "found" && (
                  <button
                    type="button"
                    onClick={() => {
                      setScanStatus("starting");
                      startCamera();
                    }}
                    className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 text-center text-stone-300 cursor-pointer"
                  >
                    <Camera className="w-8 h-8" />
                    <span className="text-sm font-medium text-white">Start the camera</span>
                    <span className="text-xs text-stone-400 max-w-xs px-4">Point it at a PACC or QR code. It decodes automatically.</span>
                  </button>
                )}

                {/* HUD Overlay Reticle */}
                {cameraActive && (
                  <div className="absolute inset-0 pointer-events-none flex items-center justify-center z-10">
                    <div className="relative w-48 h-48 sm:w-60 sm:h-60">
                      {/* Viewfinder Precision Rounded Corners */}
                      <div className="absolute -top-1 -left-1 w-7 h-7 border-t-2 border-l-2 border-emerald-400 rounded-tl-xl shadow-xs" />
                      <div className="absolute -top-1 -right-1 w-7 h-7 border-t-2 border-r-2 border-emerald-400 rounded-tr-xl shadow-xs" />
                      <div className="absolute -bottom-1 -left-1 w-7 h-7 border-b-2 border-l-2 border-emerald-400 rounded-bl-xl shadow-xs" />
                      <div className="absolute -bottom-1 -right-1 w-7 h-7 border-b-2 border-r-2 border-emerald-400 rounded-br-xl shadow-xs" />

                      {/* Laser Sweep Line */}
                      <div className="absolute left-3 right-3 h-px bg-emerald-400/70 animate-scan" />


                      {/* Live Guidance Pill — guaranteed single line with whitespace-nowrap and center anchor */}
                      <div className="absolute -bottom-9 left-1/2 -translate-x-1/2 pointer-events-none whitespace-nowrap z-20">
                        <span className="inline-flex items-center px-3 py-1 rounded-full bg-black/60 text-xs text-white whitespace-nowrap">
                          <span>Fit the code inside the frame</span>
                        </span>
                      </div>
                    </div>
                  </div>
                )}

                {/* Live Zoom HUD Badge */}
                {cameraActive && (
                  <div className="absolute top-3 right-3 z-20 flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-black/60 text-white text-xs font-mono pointer-events-none">
                    <span className="font-semibold">{zoomLevel.toFixed(1)}x</span>
                    <span className="text-[10px] text-stone-400 font-sans">
                      {hasHardwareZoom ? "Optical" : "Digital"}
                    </span>
                    {autoZoom && (
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                    )}
                  </div>
                )}
              </div>

              {/* Interactive Zoom Control Bar — Compact Mobile Layout */}
              {cameraActive && (
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span className="hint">Zoom</span>

                  <div className="flex items-center space-x-1 overflow-x-auto no-scrollbar">
                    <button
                      onClick={() => applyZoom(zoomLevel - 0.5)}
                      disabled={zoomLevel <= minZoom}
                      className="smooth-press w-7 h-7 rounded-lg bg-white hover:bg-stone-100 border border-stone-200 text-stone-600 flex items-center justify-center font-bold text-xs cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed transition-all shrink-0"
                      title="Zoom Out"
                    >
                      -
                    </button>
                    {[1.0, 1.5, 2.0, 3.0]
                      .filter((z) => z <= maxZoom + 0.1)
                      .map((preset) => (
                        <button
                          key={preset}
                          onClick={() => applyZoom(preset)}
                          className={`smooth-press px-2.5 py-1 rounded-lg text-[11px] font-mono cursor-pointer transition-all shrink-0 min-h-[28px] flex items-center justify-center ${
                            Math.abs(zoomLevel - preset) < 0.2
                              ? "bg-stone-900 text-white font-medium"
                              : "bg-white hover:bg-stone-100 border border-stone-200 text-stone-700"
                          }`}
                        >
                          {preset}x
                        </button>
                      ))}
                    <button
                      onClick={() => applyZoom(zoomLevel + 0.5)}
                      disabled={zoomLevel >= maxZoom}
                      className="smooth-press w-7 h-7 rounded-lg bg-white hover:bg-stone-100 border border-stone-200 text-stone-600 flex items-center justify-center font-bold text-xs cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed transition-all shrink-0"
                      title="Zoom In"
                    >
                      +
                    </button>
                  </div>
                </div>
              )}

              {/* Actions */}
              <div className="flex items-center gap-2">
                <button onClick={cameraActive ? stopCamera : () => startCamera()} className={`${cameraActive ? "btn-ghost" : "btn-primary"} flex-1 h-11`}>
                  {cameraActive ? (
                    <>
                      <CameraOff className="w-4 h-4" /> Stop
                    </>
                  ) : scanStatus === "found" ? (
                    <>
                      <RefreshCw className="w-4 h-4" /> Scan another
                    </>
                  ) : (
                    <>
                      <Camera className="w-4 h-4" /> Start camera
                    </>
                  )}
                </button>
                {cameraActive && (
                  <button onClick={handleManualCapture} disabled={loading} className="btn-ghost h-11" title="Freeze and decode the current frame">
                    <Aperture className="w-4 h-4" /> Snap
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => nativeCameraInputRef.current?.click()}
                  className="btn-ghost h-11"
                  title="Take a photo with the phone camera app"
                >
                  <Smartphone className="w-4 h-4" />
                  <span className="hidden sm:inline">Photo</span>
                </button>
              </div>

              {/* Insecure Context or WebRTC Notice */}
              {(!isSecureContext || !hasMediaDevices) && (
                <div className="p-3 rounded-lg bg-amber-50 text-amber-900 text-xs flex items-start gap-2">
                  <Info className="w-4 h-4 shrink-0 mt-0.5" />
                  <p>
                    Live camera needs HTTPS. Open the HTTPS (tunnel) address, or press <span className="font-medium">Photo</span> to take a picture instead.
                  </p>
                </div>
              )}
            </div>
          </div>

          <PaccDecoderKeys
            onKeysChanged={() => {
              // A symbol encrypted to a key we did not have yet: try again with the new keys.
              if (imageSrc && result && !result.success && result.encrypted && !result.requiresPassword) performDecode(imageSrc);
            }}
          />

          {/* Error Notice */}
          {error && (
            <div className="p-3 rounded-lg bg-red-50 text-red-800 text-sm flex items-start gap-2" role="alert">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <p>{error}</p>
            </div>
          )}
        </div>

        {/* Right column: result */}
        <div className="lg:col-span-6 space-y-4">
          <div className="card p-4 sm:p-5 space-y-4">
            <div className="space-y-2.5">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-sm font-semibold" style={{ color: "var(--text)" }}>Result</h2>
                <div className="flex items-center gap-1.5 shrink-0">
                  {result?.engine?.includes("ZXing") && <span className="badge-neutral">{result.engine}</span>}
                  {result?.engine === "api" && <span className="badge-neutral">Server</span>}
                  {result?.durationMs !== undefined && <span className="badge-neutral font-mono">{result.durationMs} ms</span>}
                </div>
              </div>

              {result?.success && (
                <div className="flex flex-wrap gap-1.5">
                  <Chip tone="neutral">
                    {isDual
                      ? `Dual layer · ${totalBytes} B`
                      : result?.multilayer
                        ? `Multilayer · ${totalBytes} B`
                        : result?.codeType === "PACC QC"
                          ? `QR-compatible · ${totalBytes} B`
                          : result?.codeType?.startsWith("PACC") || !result?.engine?.includes("ZXing")
                            ? `PACC${result.pacc2?.stream ? ` animated (${result.pacc2.stream.k} blocks)` : ""} · ${totalBytes} B`
                            : `QR code · ${totalBytes} B`}
                  </Chip>

                  {result?.pacc2?.signed && (
                    <Chip
                      tone={result.pacc2.signatureValid === false ? "bad" : result.pacc2.signatureValid && result.pacc2.trusted ? "good" : "warn"}
                      title={`Signer fingerprint ${result.pacc2.signer}`}
                    >
                      {result.pacc2.signatureValid === false ? <ShieldAlert className="w-3 h-3" /> : <ShieldCheck className="w-3 h-3" />}
                      {result.pacc2.signatureValid === false
                        ? `Signature INVALID (${result.pacc2.signed})`
                        : result.pacc2.signatureValid === null
                          ? `Signed by unknown key ${result.pacc2.signer}`
                          : result.pacc2.trusted
                            ? `Signed by trusted key ${result.pacc2.signer}`
                            : `Valid signature · signer not in your keys (${result.pacc2.signer})`}
                    </Chip>
                  )}
                  {result?.pacc2?.qcBound !== undefined && (
                    <Chip tone={result.pacc2.qcBound ? "good" : "bad"}>
                      {result.pacc2.qcBound ? "Hidden part matches this QR" : "Hidden part does NOT match this QR"}
                    </Chip>
                  )}
                  {result?.pacc2?.encrypted && (
                    <Chip tone="neutral">
                      <Lock className="w-3 h-3" /> Encrypted ({result.pacc2.encrypted})
                    </Chip>
                  )}
                  {result?.isBinary && (
                    <Chip tone="warn">
                      <Binary className="w-3 h-3" /> Binary data
                    </Chip>
                  )}
                </div>
              )}

              {result?.success && result?.pacc2?.fine && (
                <div
                  className="p-3 rounded-lg text-sm"
                  style={{ background: result.pacc2.fine.ok && !result.pacc2.fine.locked ? "var(--surface-2)" : "var(--warn-light)" }}
                >
                  <div className="text-xs font-medium mb-0.5" style={{ color: "var(--text-3)" }}>Close-up layer</div>
                  <div className="font-mono text-[13px] break-all" style={{ color: "var(--text)" }}>
                    {result.pacc2.fine.locked
                      ? `Locked (${result.pacc2.fine.locked})`
                      : result.pacc2.fine.ok
                        ? result.pacc2.fine.text ?? ""
                        : "Move closer to read it"}
                  </div>
                </div>
              )}
              {result?.success && result?.pacc2?.qcHidden !== undefined && (
                <div className="p-3 rounded-lg text-sm" style={{ background: "var(--surface-2)" }}>
                  <div className="text-xs font-medium mb-0.5" style={{ color: "var(--text-3)" }}>Hidden content</div>
                  <div className="font-mono text-[13px] break-all" style={{ color: "var(--text)" }}>{result.pacc2.qcHidden || "(empty)"}</div>
                </div>
              )}
            </div>

            {/* Test Lab Direct Connect Card — Mobile-Optimized */}
            {testLabTarget && onNavigateToTestLab && (
              <div
                className="p-4 rounded-xl border space-y-3 animate-in fade-in"
                style={{ background: "var(--accent-light)", borderColor: "var(--accent-mid)" }}
              >
                {/* Header Row */}
                <div className="flex items-start justify-between gap-2.5">
                  <div className="flex items-center gap-3 min-w-0">
                    <Smartphone className="w-5 h-5 shrink-0" style={{ color: "var(--accent)" }} />
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-semibold text-stone-900">Test Lab room {testLabTarget.roomId}</span>
                      </div>
                      <p className="text-xs text-stone-600 mt-0.5">
                        This code invites this device to a Test Lab session.
                      </p>
                    </div>
                  </div>
                </div>

                {/* Auto-Connect Countdown Bar */}
                {autoConnectSec !== null && autoConnectSec > 0 ? (
                  <div className="space-y-1.5 p-2.5 rounded-xl bg-white/75 border border-emerald-200/80 backdrop-blur-xs">
                    <div className="flex items-center justify-between text-xs">
                      <div className="flex items-center gap-1.5 font-medium text-emerald-900">
                        <span className="w-2 h-2 rounded-full bg-emerald-500 animate-ping" />
                        <span>Auto-connecting in <strong className="font-mono">{autoConnectSec}s</strong>...</span>
                      </div>
                      <button
                        onClick={() => setAutoConnectSec(null)}
                        className="text-[11px] font-semibold text-emerald-800 hover:text-emerald-950 underline cursor-pointer px-1 py-0.5"
                      >
                        Cancel
                      </button>
                    </div>
                    {/* Animated Progress Bar */}
                    <div className="w-full h-1.5 rounded-full bg-emerald-100 overflow-hidden">
                      <div
                        className="h-full bg-emerald-600 rounded-full transition-all duration-1000 ease-linear"
                        style={{ width: `${Math.max(10, (autoConnectSec / 3) * 100)}%` }}
                      />
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center justify-between text-[11px] text-emerald-800/80 px-1">
                    <span className="italic">Auto-connect paused. Ready to pair.</span>
                    <button
                      onClick={() => setAutoConnectSec(3)}
                      className="font-medium text-emerald-800 underline hover:text-emerald-950 cursor-pointer"
                    >
                      Restart Countdown
                    </button>
                  </div>
                )}

                {/* Action Buttons */}
                <div className="space-y-2 pt-0.5">
                  <button
                    onClick={() => handleConnectTestLab(testLabTarget.roomId, "scanner")}
                    className="btn-primary w-full h-11"
                  >
                    <Smartphone className="w-4 h-4 shrink-0" />
                    <span>Join as scanner</span>
                    <ArrowRight className="w-4 h-4 shrink-0 ml-0.5" />
                  </button>

                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => handleConnectTestLab(testLabTarget.roomId, "host")}
                      className="btn-ghost flex-1 !min-h-[36px] !text-xs"
                    >
                      Join as host instead
                    </button>

                    <button
                      onClick={() => setShowRawPayload((prev) => !prev)}
                      className="btn-ghost !min-h-[36px] !text-xs shrink-0"
                    >
                      <span>{showRawPayload ? "Hide content" : "Show content"}</span>
                      {showRawPayload ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {loading ? (
              <div className="min-h-[220px] flex flex-col items-center justify-center gap-3">
                <div className="w-6 h-6 border-2 border-stone-200 border-t-emerald-700 rounded-full animate-spin"></div>
                <span className="hint">Decoding…</span>
              </div>
            ) : result?.success ? (
              <div className="space-y-4 animate-in fade-in duration-200">
                {testLabTarget && !showRawPayload ? (
                  <div className="flex items-center justify-between gap-2 px-3.5 py-2.5 rounded-xl bg-stone-50/80 border border-stone-200 text-xs">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="font-mono text-[11px] text-stone-500 truncate max-w-[200px] sm:max-w-md">
                        {totalText || result.text}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        onClick={handleCopyText}
                        className="smooth-press py-1.5 px-2.5 rounded-lg bg-white hover:bg-stone-100 text-stone-700 text-xs font-medium border border-stone-200 shadow-2xs flex items-center gap-1 cursor-pointer"
                        title="Copy payload"
                      >
                        {copied ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5 text-stone-500" />}
                        <span>{copied ? "Copied" : "Copy"}</span>
                      </button>
                      {activeUrl && (
                        <a
                          href={activeUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="smooth-press py-1.5 px-2.5 rounded-lg bg-stone-100 hover:bg-stone-200 text-stone-700 text-xs font-medium border border-stone-200 flex items-center gap-1 cursor-pointer"
                          title="Open in new tab"
                        >
                          <ExternalLink className="w-3.5 h-3.5" />
                        </a>
                      )}
                    </div>
                  </div>
                ) : (
                  <>
                    {/* Layer Selector Tabs (for Dual-Layer Barcodes) */}
                    {isDual && (
                      <div className="flex items-center space-x-1 p-1 rounded-xl bg-stone-100/90 border border-stone-200 text-xs font-medium overflow-x-auto no-scrollbar">
                        <button
                          type="button"
                          onClick={() => setSelectedLayerTab("total")}
                          className={`smooth-press px-3 py-1.5 rounded-lg transition-all cursor-pointer flex items-center space-x-1.5 shrink-0 ${
                            selectedLayerTab === "total"
                              ? "bg-white text-emerald-950 font-bold shadow-xs border border-stone-200/80"
                              : "text-stone-600 hover:text-stone-900"
                          }`}
                        >
                          <Layers className="w-3.5 h-3.5 text-emerald-700" />
                          <span>Total Payload ({totalBytes} B)</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => setSelectedLayerTab("layer1")}
                          className={`smooth-press px-3 py-1.5 rounded-lg transition-all cursor-pointer flex items-center space-x-1.5 shrink-0 ${
                            selectedLayerTab === "layer1"
                              ? "bg-white text-emerald-950 font-bold shadow-xs border border-stone-200/80"
                              : "text-stone-600 hover:text-stone-900"
                          }`}
                        >
                          <span>Layer 1 ({l1Bytes} B)</span>
                          {result.layer1Locked && <Lock className="w-3 h-3 text-amber-600" />}
                        </button>
                        <button
                          type="button"
                          onClick={() => setSelectedLayerTab("layer2")}
                          className={`smooth-press px-3 py-1.5 rounded-lg transition-all cursor-pointer flex items-center space-x-1.5 shrink-0 ${
                            selectedLayerTab === "layer2"
                              ? "bg-white text-emerald-950 font-bold shadow-xs border border-stone-200/80"
                              : "text-stone-600 hover:text-stone-900"
                          }`}
                        >
                          <span>Layer 2 ({l2Bytes} B)</span>
                          {result.layer2Locked && <Lock className="w-3 h-3 text-amber-600" />}
                        </button>
                      </div>
                    )}

                    {/* Mode toggles (Text vs Hex) and Layer locked states */}
                    {selectedLayerTab === "layer1" && result.layer1Locked ? (
                      <div className="p-4 rounded-xl bg-amber-50/80 border border-amber-200/90 space-y-3">
                        <div className="flex items-center space-x-2">
                          <Lock className="w-4 h-4 text-amber-700" />
                          <span className="text-xs font-semibold text-amber-900">
                            Layer 1 is Encrypted (ChaCha20-Poly1305)
                          </span>
                        </div>
                        <p className="text-xs text-amber-800/90">
                          Passphrase required to decrypt Layer 1 payload.
                        </p>
                        <div className="flex gap-2">
                          <input
                            type="password"
                            value={layer1Pass}
                            onChange={(e) => setLayer1Pass(e.target.value)}
                            placeholder="Enter Layer 1 passphrase..."
                            className="flex-1 rounded-xl border border-amber-300 px-3.5 py-2 text-xs font-mono bg-white focus:outline-none focus:ring-2 focus:ring-amber-500"
                            disabled={unlockingLayer}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") handleUnlockLayer();
                            }}
                          />
                          <button
                            onClick={() => handleUnlockLayer()}
                            disabled={unlockingLayer}
                            className="smooth-press bg-amber-800 hover:bg-amber-900 text-white px-4 py-2 rounded-xl text-xs font-medium shadow-xs disabled:opacity-50 cursor-pointer shrink-0"
                          >
                            {unlockingLayer ? "Unlocking..." : "Unlock Layer 1"}
                          </button>
                        </div>
                        {unlockError && <p className="text-red-600 text-xs font-medium">{unlockError}</p>}
                      </div>
                    ) : selectedLayerTab === "layer2" && result.layer2Locked ? (
                      <div className="p-4 rounded-xl bg-amber-50/80 border border-amber-200/90 space-y-3">
                        <div className="flex items-center space-x-2">
                          <Lock className="w-4 h-4 text-amber-700" />
                          <span className="text-xs font-semibold text-amber-900">
                            Layer 2 is Encrypted
                          </span>
                        </div>
                        <p className="text-xs text-amber-800/90">
                          Passphrase required to decrypt Layer 2 payload.
                        </p>
                        <div className="flex gap-2">
                          <input 
                            type="password" 
                            value={layer2Pass} 
                            onChange={(e) => setLayer2Pass(e.target.value)} 
                            placeholder="Enter passphrase to unlock..." 
                            className="flex-1 rounded-xl border border-amber-300 px-3.5 py-2 text-xs font-mono bg-white focus:outline-none focus:ring-2 focus:ring-amber-500"
                            disabled={unlockingLayer}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") handleUnlockLayer2();
                            }}
                          />
                          <button 
                            onClick={handleUnlockLayer2} 
                            disabled={unlockingLayer}
                            className="smooth-press bg-amber-800 hover:bg-amber-900 text-white px-4 py-2 rounded-xl text-xs font-medium shadow-xs disabled:opacity-50 cursor-pointer shrink-0"
                          >
                            {unlockingLayer ? "Unlocking..." : "Unlock Layer 2"}
                          </button>
                        </div>
                        {unlockError && <p className="text-red-600 text-xs font-medium">{unlockError}</p>}
                      </div>
                    ) : selectedLayerTab === "total" && result.layer1Locked && result.layer2Locked ? (
                      <div className="p-4 rounded-xl bg-amber-50/80 border border-amber-200/90 space-y-3">
                        <div className="flex items-center space-x-2">
                          <Lock className="w-4 h-4 text-amber-700" />
                          <span className="text-xs font-semibold text-amber-900">
                            Barcode is Encrypted (Both Layers)
                          </span>
                        </div>
                        <p className="text-xs text-amber-800/90">
                          Enter passphrase to decrypt the payload.
                        </p>
                        <div className="flex gap-2">
                          <input
                            type="password"
                            value={layer1Pass}
                            onChange={(e) => setLayer1Pass(e.target.value)}
                            placeholder="Enter passphrase..."
                            className="flex-1 rounded-xl border border-amber-300 px-3.5 py-2 text-xs font-mono bg-white focus:outline-none focus:ring-2 focus:ring-amber-500"
                            disabled={unlockingLayer}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") handleUnlockLayer();
                            }}
                          />
                          <button
                            onClick={() => handleUnlockLayer()}
                            disabled={unlockingLayer}
                            className="smooth-press bg-amber-800 hover:bg-amber-900 text-white px-4 py-2 rounded-xl text-xs font-medium shadow-xs disabled:opacity-50 cursor-pointer shrink-0"
                          >
                            {unlockingLayer ? "Unlocking..." : "Unlock Payload"}
                          </button>
                        </div>
                        {unlockError && <p className="text-red-600 text-xs font-medium">{unlockError}</p>}
                      </div>
                    ) : (
                      <>
                        <div className="flex items-center justify-between">
                          <div className="seg">
                            <button type="button" aria-pressed={viewMode === "text"} onClick={() => setViewMode("text")}>
                              Text
                            </button>
                            <button type="button" aria-pressed={viewMode === "hex"} onClick={() => setViewMode("hex")}>
                              Hex
                            </button>
                          </div>

                          <div className="flex items-center space-x-2">
                            {isDual && selectedLayerTab === "total" && (
                              <span className="px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-800 border border-emerald-200 text-[10px] font-mono font-medium">
                                Total ({totalBytes} B)
                              </span>
                            )}
                            {result.isBinary && (
                              <span className="px-2 py-0.5 rounded-full bg-amber-50 text-amber-800 border border-amber-200 text-[10px] font-mono font-medium">
                                Non-UTF8 Data
                              </span>
                            )}
                          </div>
                        </div>

                        <div className="p-3.5 rounded-lg bg-stone-50 border border-stone-200 max-h-[320px] overflow-y-auto select-all">
                          {viewMode === "hex" ? (
                            <pre className="text-xs text-stone-800 font-mono whitespace-pre leading-relaxed font-normal">
                              {activeHexPreview}
                            </pre>
                          ) : (
                            <pre className="text-[13px] text-stone-900 font-mono whitespace-pre-wrap break-all leading-relaxed">
                              {activeDisplayText || (selectedLayerTab === "layer2" && result.layer2Locked ? "Layer 2 is locked" : "No readable text")}
                            </pre>
                          )}
                        </div>

                        {/* Partial unlock prompt when viewing Total tab and Layer 2 is still locked */}
                        {isDual && selectedLayerTab === "total" && result.layer2Locked && (
                          <div className="p-3.5 rounded-xl bg-amber-50/80 border border-amber-200/90 space-y-2.5">
                            <div className="flex items-center justify-between">
                              <div className="flex items-center space-x-2">
                                <Lock className="w-4 h-4 text-amber-700 shrink-0" />
                                <span className="text-xs font-semibold text-amber-900">
                                  Layer 2 is Encrypted ({l2Bytes} B)
                                </span>
                              </div>
                              <span className="text-[10px] text-amber-800 font-mono">Partial Payload Shown</span>
                            </div>
                            <p className="text-[11px] text-amber-800/90">
                              Layer 1 is displayed above. Enter passphrase to decrypt Layer 2 and unlock the full dual payload.
                            </p>
                            <div className="flex gap-2">
                              <input
                                type="password"
                                value={layer2Pass}
                                onChange={(e) => setLayer2Pass(e.target.value)}
                                placeholder="Enter Layer 2 passphrase..."
                                className="flex-1 rounded-xl border border-amber-300 px-3 py-1.5 text-xs font-mono bg-white focus:outline-none focus:ring-2 focus:ring-amber-500"
                                disabled={unlockingLayer}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") handleUnlockLayer2();
                                }}
                              />
                              <button
                                onClick={handleUnlockLayer2}
                                disabled={unlockingLayer}
                                className="smooth-press bg-amber-800 hover:bg-amber-900 text-white px-3.5 py-1.5 rounded-xl text-xs font-medium shadow-xs disabled:opacity-50 cursor-pointer shrink-0"
                              >
                                {unlockingLayer ? "Unlocking..." : "Unlock L2"}
                              </button>
                            </div>
                            {unlockError && <p className="text-red-600 text-xs font-medium">{unlockError}</p>}
                          </div>
                        )}

                        <div className="flex gap-2">
                          <button onClick={handleCopyText} className="btn-ghost flex-1">
                            {copied ? (
                              <Check className="w-3.5 h-3.5 text-emerald-600 animate-spring" />
                            ) : (
                              <Copy className="w-3.5 h-3.5 text-stone-500" />
                            )}
                            <span>
                              {copied
                                ? "Copied"
                                : isDual && selectedLayerTab === "total"
                                ? `Copy Total Payload (${totalBytes} B)`
                                : isDual && selectedLayerTab === "layer1"
                                ? `Copy Layer 1 (${l1Bytes} B)`
                                : isDual && selectedLayerTab === "layer2"
                                ? `Copy Layer 2 (${l2Bytes} B)`
                                : "Copy"}
                            </span>
                          </button>

                          {activeUrl && (
                            <a
                              href={activeUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="btn-primary flex-1"
                            >
                              <ExternalLink className="w-3.5 h-3.5" />
                              <span>Open link</span>
                            </a>
                          )}
                        </div>
                      </>
                    )}
                  </>
                )}

                {/* Technical details (collapsed) */}
                <details className="disclosure border-t" style={{ borderColor: "var(--border)" }}>
                  <summary>
                    <span className="flex items-center gap-2">
                      <Sliders className="w-4 h-4" style={{ color: "var(--text-3)" }} />
                      Technical details
                    </span>
                    <ChevronDown className="chev w-4 h-4" />
                  </summary>
                  <div className="pb-1">
                  {result.codeType === "PACC" && (
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-2.5 text-xs font-mono">
                      {[
                        ["Content", `${totalBytes} B`],
                        ["Grid", result.metadata?.gridSide ?? "?"],
                        ["Error correction", result.metadata?.eccLevel ?? "?"],
                        ["Decode path", result.metadata?.passUsed ?? "PACC"],
                        ["Signature", result.pacc2?.signed
                          ? `${result.pacc2.signed}: ${result.pacc2.signatureValid === false ? "INVALID" : result.pacc2.signatureValid ? "valid" : "unverified"}`
                          : "none"],
                        ["Signer", result.pacc2?.signer ? `${result.pacc2.signer}${result.pacc2.trusted ? " (trusted)" : ""}` : "—"],
                        ["Encryption", result.pacc2?.encrypted ?? "none"],
                        ["Frames", result.pacc2?.stream ? `${result.pacc2.stream.k} blocks / ${result.pacc2.stream.received} frames` : "single symbol"],
                      ].map(([label, value]) => (
                        <div key={label} className="p-2.5 rounded-lg bg-stone-50">
                          <div className="text-stone-500 text-[11px] font-sans">{label}</div>
                          <div className="text-stone-900 font-medium mt-0.5 truncate" title={String(value)}>{value}</div>
                        </div>
                      ))}
                    </div>
                  )}
                  <div className={`grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-2.5 text-xs font-mono ${result.codeType === "PACC" ? "hidden" : ""}`}>
                    <div className="p-2.5 sm:p-3 rounded-lg bg-stone-50">
                      <div className="text-stone-500 text-[11px] font-sans">{isDual ? "TOTAL PAYLOAD" : "PAYLOAD"}</div>
                      <div className="text-stone-800 font-semibold mt-0.5">{totalBytes} B</div>
                      {isDual && (
                        <div className="text-[10px] text-stone-500 font-mono mt-0.5 truncate">
                          L1: {l1Bytes}B + L2: {l2Bytes}B
                        </div>
                      )}
                    </div>

                    <div className="p-2.5 sm:p-3 rounded-lg bg-stone-50">
                      <div className="text-stone-500 text-[11px] font-sans">GRID SIDE</div>
                      <div className="text-emerald-800 font-semibold mt-0.5">
                        {result.metadata?.gridSide ? `${result.metadata.gridSide}` : "Auto"}
                      </div>
                    </div>

                    <div className="p-2.5 sm:p-3 rounded-lg bg-stone-50">
                      <div className="text-stone-500 text-[11px] font-sans">ECC CORRECTIONS</div>
                      <div className={`font-semibold mt-0.5 ${(result.metadata?.eccCorrections ?? 0) > 0 ? "text-amber-700 font-bold" : "text-emerald-700"}`}>
                        {result.metadata?.eccCorrections !== undefined ? `${result.metadata.eccCorrections} B` : "0 B"}
                      </div>
                    </div>

                    <div className="p-2.5 sm:p-3 rounded-lg bg-stone-50">
                      <div className="text-stone-500 text-[11px] font-sans">ERASURES HIT</div>
                      <div className="text-stone-800 font-semibold mt-0.5">
                        {result.metadata?.erasuresHit !== undefined ? `${result.metadata.erasuresHit}` : "0"}
                      </div>
                    </div>

                    <div className="p-2.5 sm:p-3 rounded-lg bg-stone-50">
                      <div className="text-stone-500 text-[11px] font-sans">COPIES VOTED</div>
                      <div className="text-stone-800 font-semibold mt-0.5">
                        {result.metadata?.copiesVoted ? `${result.metadata.copiesVoted}x` : "1x"}
                      </div>
                    </div>

                    <div className="p-2.5 sm:p-3 rounded-lg bg-stone-50">
                      <div className="text-stone-500 text-[11px] font-sans">HUE CALIBRATION</div>
                      <div className="font-semibold text-emerald-800 mt-0.5">
                        {result.metadata?.hueRotUsed ? `${result.metadata.hueRotUsed > 0 ? "+" : ""}${result.metadata.hueRotUsed}°` : "0° (Neutral)"}
                      </div>
                    </div>

                    <div className="p-2.5 sm:p-3 rounded-lg bg-stone-50">
                      <div className="text-stone-500 text-[11px] font-sans">OPTICAL SAMPLER</div>
                      <div className="text-stone-800 font-semibold mt-0.5 truncate" title={result.metadata?.sampleModeUsed || "Adaptive"}>
                        {result.metadata?.sampleModeUsed === "sharp_core"
                          ? "Sharp Core"
                          : result.metadata?.sampleModeUsed === "gaussian"
                          ? "Gaussian Core"
                          : result.engine === "api"
                          ? "OpenCV Core"
                          : "Adaptive Box"}
                      </div>
                    </div>

                    <div className="p-2.5 sm:p-3 rounded-lg bg-stone-50">
                      <div className="text-stone-500 text-[11px] font-sans">PIPELINE PASS</div>
                      <div className="text-emerald-800 font-semibold mt-0.5 truncate" title={result.metadata?.passUsed || result.tier || result.engine || "Native"}>
                        {result.metadata?.passUsed === "tier1_tracking"
                          ? "Tier-1 Track"
                          : result.metadata?.passUsed === "homography"
                          ? "Homography"
                          : result.metadata?.passUsed === "color-cast-wb"
                          ? "Color-Cast WB"
                          : result.metadata?.passUsed === "low-light-gain"
                          ? "Low-Light Boost"
                          : result.metadata?.passUsed === "deblur"
                          ? "Deblur Boost"
                          : result.metadata?.passUsed === "clahe"
                          ? "CLAHE Contrast"
                          : result.metadata?.passUsed === "outer-boundary"
                          ? "Extrema Quad"
                          : result.metadata?.passUsed === "direct-grid"
                          ? "Direct Grid"
                          : result.tier === "tier1_tracking"
                          ? "Tier-1 Tracking"
                          : result.tier === "tier3_cold"
                          ? "Cold Scan"
                          : result.engine === "api"
                          ? "OpenCV Core"
                          : "Native Pass"}
                      </div>
                    </div>
                  </div>
                  </div>
                </details>

                {/* Recent scans */}
                {scanHistory.length > 0 && (
                  <div className="pt-3 border-t border-stone-200 space-y-2">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-medium text-stone-700 flex items-center space-x-1.5">
                        <History className="w-3.5 h-3.5 text-stone-500" />
                        <span>Recent scans ({scanHistory.length})</span>
                      </span>
                      <button
                        type="button"
                        onClick={() => setScanHistory([])}
                        className="text-[10px] text-stone-400 hover:text-stone-600 transition cursor-pointer"
                      >
                        Clear
                      </button>
                    </div>

                    <div className="flex flex-col space-y-1.5">
                      {scanHistory.map((item) => (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => {
                            setResult(item.result);
                            if (item.result.isBinary) setViewMode("hex");
                          }}
                          className={`w-full p-2 rounded-lg text-left transition-all flex items-center justify-between gap-2 cursor-pointer border ${
                            (result?.totalText || result?.text) === (item.result.totalText || item.result.text) && result?.durationMs === item.result.durationMs
                              ? "bg-emerald-50 border-emerald-200"
                              : "bg-white hover:bg-stone-50/80 border-stone-200/80"
                          }`}
                        >
                          <div className="flex items-center space-x-2 min-w-0">
                            <span className="text-[10px] font-mono text-stone-400 shrink-0">
                              {item.timestamp}
                            </span>
                            <span className="text-xs font-mono text-stone-800 truncate">
                              {item.preview}
                            </span>
                          </div>

                          <div className="flex items-center space-x-1.5 shrink-0">
                            {item.multilayer && (
                              <span className="px-1.5 py-0.2 rounded bg-emerald-100 text-emerald-800 text-[9px] font-mono font-bold">
                                DUAL
                              </span>
                            )}
                            {item.isBinary && (
                              <span className="px-1.5 py-0.2 rounded bg-amber-100 text-amber-800 text-[9px] font-mono">
                                BIN
                              </span>
                            )}
                            <span className="text-[10px] font-mono text-stone-500">
                              {item.durationMs ?? 0}ms
                            </span>
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ) : result?.encrypted && !result.success ? (
              <div className="min-h-[220px] flex flex-col items-center justify-center gap-2 text-center px-4">
                <Lock className="w-8 h-8 text-stone-400" />
                <span className="text-sm font-medium text-stone-800">Locked</span>
                <span className="hint max-w-sm">
                  {result.requiresPassword
                    ? "This symbol needs a passphrase."
                    : "This symbol is encrypted to someone's key. Add the matching private key under Keys and it opens automatically."}
                </span>
                {result.requiresPassword && (
                  <button type="button" onClick={() => setShowPasswordModal(true)} className="btn-primary mt-1">
                    <Unlock className="w-4 h-4" /> Enter passphrase
                  </button>
                )}
              </div>
            ) : (
              <div className="min-h-[220px] flex flex-col items-center justify-center gap-2 text-center">
                <Scan className="w-8 h-8 text-stone-300" />
                <span className="text-sm font-medium text-stone-700">Nothing scanned yet</span>
                <span className="hint max-w-xs">The decoded content will show up here.</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Password Unlock Modal */}
      {showPasswordModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/40 backdrop-blur-xs p-3 sm:p-4 animate-in fade-in duration-150">
          <div
            className="p-5 sm:p-6 rounded-2xl max-w-md w-[94vw] sm:w-full border shadow-xl space-y-4 animate-in zoom-in-95 duration-200"
            style={{ background: "var(--surface)", borderColor: "var(--border-mid)" }}
          >
            <div className="flex items-center space-x-3">
              <div
                className="w-10 h-10 rounded-xl flex items-center justify-center shadow-2xs"
                style={{
                  background: "var(--accent-light)",
                  border: "1px solid var(--accent-mid)",
                  color: "var(--accent)",
                }}
              >
                <KeyRound className="w-5 h-5" />
              </div>
              <div>
                <h4 className="text-base font-semibold" style={{ color: "var(--text)" }}>This symbol is encrypted</h4>
                <p className="text-xs" style={{ color: "var(--text-3)" }}>Enter the passphrase to read it.</p>
              </div>
            </div>

            {error && (
              <div className="p-2.5 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700 flex items-center space-x-2">
                <AlertTriangle className="w-4 h-4 text-red-500 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <form onSubmit={handlePasswordSubmit} className="space-y-4">
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoFocus
                placeholder="Passphrase"
                className="input"
              />

              <div className="flex items-center justify-end space-x-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowPasswordModal(false)}
                  className="btn-ghost"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={loading}
                  className="btn-primary"
                >
                  <Unlock className="w-3.5 h-3.5" />
                  <span>Unlock</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

function Chip({ tone, title, children }: { tone: "good" | "bad" | "warn" | "neutral"; title?: string; children: React.ReactNode }) {
  const styles = {
    good: "bg-emerald-50 text-emerald-800 border-emerald-200",
    bad: "bg-red-50 text-red-800 border-red-200",
    warn: "bg-amber-50 text-amber-900 border-amber-200",
    neutral: "bg-stone-100 text-stone-700 border-stone-200",
  }[tone];
  return (
    <span title={title} className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-xs font-medium max-w-full truncate ${styles}`}>
      {children}
    </span>
  );
}
