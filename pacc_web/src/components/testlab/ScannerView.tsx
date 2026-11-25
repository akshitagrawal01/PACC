"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  Camera,
  Flashlight,
  RefreshCw,
  Volume2,
  VolumeX,
  SkipForward,
  List,
  LogOut,
  CheckCircle2,
  AlertCircle,
  Radio,
  Smartphone,
} from "lucide-react";
import { RoomState, TestItem } from "@/lib/useTestRoom";
import { UseCameraReturn } from "@/lib/useCamera";
import { useDecodeLoop } from "@/lib/useDecodeLoop";
import { setPaccSecrets } from "@/lib/pacc/client";
import { playSound } from "@/lib/audioFeedback";
import { TestItemDrawer } from "./TestItemDrawer";
import type { HardwareFingerprint } from "@/lib/deviceFingerprint";

interface ScannerViewProps {
  roomState: RoomState;
  camera: UseCameraReturn;
  onSubmitScan: (opts: {
    decodedPayload: string;
    decodeLatencyMs: number;
    clientTimeToScanMs: number;
    attempts: number;
    decoderUsed: string;
    deviceHw: Record<string, unknown>;
  }) => Promise<boolean>;
  onSkip: () => void;
  onStep: (direction: "next" | "prev" | number) => void;
  onTimeout: (clientTimeToScanMs: number, attempts: number) => void;
  onLeaveRoom: () => void;
  soundEnabled: boolean;
  setSoundEnabled: (s: boolean) => void;
  hardwarePayload: Partial<HardwareFingerprint>;
  onFetchItems: () => Promise<TestItem[]>;
}

export function ScannerView({
  roomState,
  camera,
  onSubmitScan,
  onSkip,
  onStep,
  onTimeout,
  onLeaveRoom,
  soundEnabled,
  setSoundEnabled,
  hardwarePayload,
  onFetchItems,
}: ScannerViewProps) {
  const [showDrawer, setShowDrawer] = useState(false);
  const [fullItems, setFullItems] = useState<TestItem[]>(roomState.items || roomState.suiteItems || []);
  const [lastScanFeedback, setLastScanFeedback] = useState<{
    status: "PASS" | "TIMEOUT" | "MISMATCH" | "FAIL";
    msg: string;
  } | null>(null);

  const [scanElapsedSec, setScanElapsedSec] = useState(0);
  const [scanAttempts, setScanAttempts] = useState(0);
  const [activeEngine, setActiveEngine] = useState<string>("Initializing");

  const currentTest = roomState.currentTest;
  const currentIndex = roomState.currentIndex || 0;
  const totalTests = roomState.totalTests || 1;
  const isActionInFlightRef = useRef(false);
  const lastScannedPayloadRef = useRef<string | null>(null);

  const effectiveItems = (roomState.items && roomState.items.length > 0)
    ? roomState.items
    : (roomState.suiteItems && roomState.suiteItems.length > 0)
    ? roomState.suiteItems
    : fullItems;

  // Sync items
  useEffect(() => {
    if (roomState.items?.length) {
      setFullItems(roomState.items);
    } else if (roomState.suiteItems?.length && !fullItems.length) {
      setFullItems(roomState.suiteItems);
    }
  }, [roomState.items, roomState.suiteItems, fullItems.length]);

  // Start camera on mount if not active
  useEffect(() => {
    if (!camera.active) {
      camera.start("environment");
    }
  }, [camera]);

  const decodeLoopRef = useRef<{ startTimeRef: { current: number } } | null>(null);

  // Decode result handler
  const handleDecodeResult = useCallback(
    async (decodedText: string, decoderUsed: string, latencyMs: number, attempts: number) => {
      if (isActionInFlightRef.current || !currentTest) return;
      isActionInFlightRef.current = true;

      const startTime = decodeLoopRef.current?.startTimeRef.current || Date.now();
      const elapsed = Date.now() - startTime;
      const match = decodedText.trim() === currentTest.payload.trim();

      if (match) {
        playSound("success", soundEnabled);
        setLastScanFeedback({ status: "PASS", msg: `PASS in ${latencyMs}ms (${decoderUsed}) → Advancing…` });

        const liveHw = {
          ...hardwarePayload,
          cameraResolution: camera.cameraResolution || hardwarePayload.cameraResolution,
          cameraFps: camera.cameraFps || hardwarePayload.cameraFps,
        };

        let submitted = false;
        try {
          submitted = await onSubmitScan({
            decodedPayload: decodedText,
            decodeLatencyMs: latencyMs,
            clientTimeToScanMs: elapsed,
            attempts,
            decoderUsed,
            deviceHw: liveHw,
          });
          if (submitted) {
            lastScannedPayloadRef.current = decodedText.trim();
          } else {
            // Submission was rejected or network blip — allow immediate retry
            lastScannedPayloadRef.current = null;
            setLastScanFeedback({ status: "FAIL", msg: "Syncing with host…" });
          }
        } catch {
          lastScannedPayloadRef.current = null;
          setLastScanFeedback({ status: "FAIL", msg: "Network error — retrying…" });
        } finally {
          setTimeout(() => {
            isActionInFlightRef.current = false;
            if (submitted) {
              setLastScanFeedback(null);
            }
          }, 800);
        }
      } else {
        // If the camera is still seeing the previous test while the host screen transitions, ignore without buzzing
        if (lastScannedPayloadRef.current && decodedText.trim() === lastScannedPayloadRef.current) {
          isActionInFlightRef.current = false;
          return;
        }

        playSound("mismatch", soundEnabled);
        setLastScanFeedback({ status: "MISMATCH", msg: "Payload mismatch detected" });
        setTimeout(() => {
          isActionInFlightRef.current = false;
          setLastScanFeedback(null);
        }, 1200);
      }
    },
     
    [currentTest, soundEnabled, onSubmitScan, hardwarePayload, camera.cameraResolution, camera.cameraFps]
  );

  // Timeout handler
  const handleScanTimeout = useCallback(
    async (elapsedMs: number, attempts: number) => {
      if (isActionInFlightRef.current || !currentTest) return;
      isActionInFlightRef.current = true;

      playSound("timeout", soundEnabled);
      setLastScanFeedback({ status: "TIMEOUT", msg: "10s timeout reached" });
      try {
        await onTimeout(elapsedMs, attempts);
      } catch {} finally {
        setTimeout(() => {
          isActionInFlightRef.current = false;
          setLastScanFeedback(null);
        }, 1500);
      }
    },
    [currentTest, soundEnabled, onTimeout]
  );

  const isScanning = camera.active;

  // Wire up decode loop hook
  const decodeLoop = useDecodeLoop({
    videoRef: camera.videoRef,
    codeType: currentTest?.codeType ?? null,
    active: isScanning && Boolean(currentTest),
    password: currentTest?.password,
    expect: currentTest?.expect,
    onResult: handleDecodeResult,
    onTimeout: handleScanTimeout,
  });
  decodeLoopRef.current = decodeLoop;

  // Reset decode loop when test item changes
  const prevTestIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (currentTest?.id && currentTest.id !== prevTestIdRef.current) {
      prevTestIdRef.current = currentTest.id;
      isActionInFlightRef.current = false;
      // Keys this item needs (trusted signer, recipient private key); clears the previous item's.
      setPaccSecrets(currentTest.secrets ?? {}).catch(() => {});
      decodeLoop.reset();
      setScanElapsedSec(0);
      setActiveEngine(
        currentTest.codeType === "QR"
          ? "ZXing-WASM"
          : currentTest.codeType === "PACC_QC"
          ? "ZXing + PACC QC"
          : currentTest.codeType === "PACC_DUAL"
          ? "PACC 8-Colour"
          : "PACC Pipeline"
      );

      // Clear transition tolerance after 1.5s
      const timer = setTimeout(() => {
        lastScannedPayloadRef.current = null;
      }, 1500);
      return () => clearTimeout(timer);
    }
  }, [currentTest?.id, decodeLoop]);

  // 1-second interval to update elapsed scan time HUD
  useEffect(() => {
    const timer = setInterval(() => {
      if (decodeLoop.startTimeRef.current > 0) {
        const sec = Math.min(10, Math.floor((Date.now() - decodeLoop.startTimeRef.current) / 1000));
        setScanElapsedSec(sec);
        setScanAttempts(decodeLoop.attemptsRef.current);
      }
    }, 500);
    return () => clearInterval(timer);
  }, [decodeLoop.startTimeRef, decodeLoop.attemptsRef]);

  const handleManualSkip = () => {
    decodeLoop.pause(800);
    isActionInFlightRef.current = false;
    lastScannedPayloadRef.current = null;
    playSound("skip", soundEnabled);
    onSkip();
  };

  const handleManualSnap = async () => {
    decodeLoop.pause(1200);
    isActionInFlightRef.current = false;
    await decodeLoop.snap();
  };

  const handleOpenDrawer = async () => {
    decodeLoop.pause(2000);
    if (!effectiveItems.length) {
      const items = await onFetchItems();
      if (items?.length) setFullItems(items);
    }
    setShowDrawer(true);
  };

  return (
    <div className="fixed inset-0 z-50 bg-[#0A0D0A] flex flex-col justify-between select-none overflow-hidden text-white font-sans">
      {/* ── LIVE CAMERA VIEWPORT ─────────────────────────────────────────── */}
      <div className="absolute inset-0 z-0 overflow-hidden">
        <video
          ref={camera.videoRef}
          autoPlay
          playsInline
          muted
          className="w-full h-full object-cover"
        />

        {/* Viewfinder Reticle */}
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none p-6">
          <div className="relative w-64 h-64 sm:w-72 sm:h-72">
            {/* 4 Corner Brackets */}
            <div className="absolute top-0 left-0 w-8 h-8 border-t-2 border-l-2 border-emerald-400 rounded-tl-xl" />
            <div className="absolute top-0 right-0 w-8 h-8 border-t-2 border-r-2 border-emerald-400 rounded-tr-xl" />
            <div className="absolute bottom-0 left-0 w-8 h-8 border-b-2 border-l-2 border-emerald-400 rounded-bl-xl" />
            <div className="absolute bottom-0 right-0 w-8 h-8 border-b-2 border-r-2 border-emerald-400 rounded-br-xl" />

            {/* Subtle Scanning Laser Line */}
            <div
              className="absolute left-1 right-1 h-0.5 bg-gradient-to-r from-transparent via-emerald-400/80 to-transparent shadow-[0_0_8px_rgba(52,211,153,0.8)] animate-pulse"
              style={{
                top: `${((scanElapsedSec % 3) / 3) * 100}%`,
                transition: "top 0.8s linear",
              }}
            />

            {/* Center crosshair */}
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-2 h-2 rounded-full bg-emerald-400/50" />
          </div>
        </div>
      </div>

      {/* ── TOP FLOATING HUD ─────────────────────────────────────────────── */}
      <div className="relative z-10 px-3 pt-[max(0.75rem,env(safe-area-inset-top))] pb-2 sm:p-4 flex flex-col gap-2.5">
        <div className="flex items-center justify-between gap-2">
          {/* Room & Device Pills */}
          <div className="flex items-center gap-1.5 min-w-0">
            <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-black/60 backdrop-blur-md border border-white/10 text-xs font-mono shrink-0">
              <Radio className="w-3 h-3 text-emerald-400 animate-pulse" />
              <span className="font-bold tracking-wider">{roomState.roomId}</span>
            </div>
            <div className="flex items-center gap-1 px-2.5 py-1.5 rounded-full bg-black/60 backdrop-blur-md border border-white/10 text-xs truncate max-w-[120px] sm:max-w-[180px]">
              <Smartphone className="w-3 h-3 text-emerald-400 shrink-0" />
              <span className="truncate text-white/90 text-[11px] font-medium">
                {String(hardwarePayload.deviceName || "Scanner")}
              </span>
            </div>

            {/* Host Synced Pill */}
            <div className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-full backdrop-blur-md border text-xs font-semibold ${
              roomState.hostOnline
                ? "bg-emerald-950/70 border-emerald-500/40 text-emerald-300"
                : "bg-black/60 border-white/10 text-white/60"
            }`}>
              <div className={`w-2 h-2 rounded-full ${roomState.hostOnline ? "bg-emerald-400 animate-pulse" : "bg-amber-400"}`} />
              <span className="text-[11px] font-medium hidden xs:inline">
                {roomState.hostOnline ? "Host Synced" : "Host Syncing"}
              </span>
            </div>
          </div>

          {/* Quick Hardware Toggles */}
          <div className="flex items-center gap-1.5 p-1 rounded-full bg-black/60 backdrop-blur-md border border-white/10">
            {camera.hasTorch && (
              <button
                onClick={() => camera.setTorch(!camera.torchOn)}
                className={`p-2 rounded-full transition ${
                  camera.torchOn ? "bg-amber-400 text-stone-950 shadow" : "text-white/80 hover:bg-white/10"
                }`}
                title="Torch"
              >
                <Flashlight className="w-4 h-4" />
              </button>
            )}

            <button
              onClick={() => camera.flip()}
              className="p-2 rounded-full text-white/80 hover:bg-white/10 transition"
              title="Flip Camera"
            >
              <RefreshCw className="w-4 h-4" />
            </button>

            {camera.hasHwZoom && (
              <button
                onClick={() => camera.setZoom(camera.zoomLevel > 1.5 ? 1.0 : 2.0)}
                className="p-2 rounded-full text-white/80 hover:bg-white/10 transition text-xs font-bold"
                title="Zoom"
              >
                {camera.zoomLevel > 1.5 ? "2x" : "1x"}
              </button>
            )}

            <button
              onClick={() => setSoundEnabled(!soundEnabled)}
              className="p-2 rounded-full text-white/80 hover:bg-white/10 transition"
              title="Sound"
            >
              {soundEnabled ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4 text-white/40" />}
            </button>

            <button
              onClick={onLeaveRoom}
              className="p-2 rounded-full text-red-400 hover:bg-red-500/20 transition"
              title="Exit Scanner"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Current Test Target Card */}
        {currentTest && (
          <div className="p-3 rounded-2xl bg-black/70 backdrop-blur-md border border-white/10 space-y-1.5 shadow-xl">
            <div className="flex items-center justify-between text-xs">
              <div className="flex items-center gap-2 min-w-0">
                <span
                  className={`text-[10px] font-bold px-2 py-0.5 rounded ${
                    currentTest.codeType === "PACC_DUAL"
                      ? "bg-pink-500/20 text-pink-300 border border-pink-500/30"
                      : currentTest.codeType === "PACC"
                      ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30"
                      : "bg-purple-500/20 text-purple-300 border border-purple-500/30"
                  }`}
                >
                  {currentTest.badge || currentTest.codeType}
                </span>
                <span className="font-semibold text-white truncate text-xs sm:text-sm">
                  {currentTest.label}
                </span>
              </div>
              <span className="font-mono text-[11px] text-white/60 shrink-0">
                {currentIndex + 1} / {totalTests}
              </span>
            </div>
            {currentTest.hint && (
              <div className="text-xs font-medium text-amber-200">{currentTest.hint}</div>
            )}

            {/* Telemetry row */}
            <div className="flex items-center justify-between text-[11px] text-white/60 font-mono pt-1 border-t border-white/5">
              <span>
                {camera.active && camera.cameraResolution
                  ? `${camera.cameraResolution} @ ${camera.cameraFps || 30}fps`
                  : activeEngine}
              </span>
              <div className="flex items-center gap-2">
                <span>{scanAttempts} frames</span>
                <span className={scanElapsedSec > 35 ? "text-amber-400 font-bold" : "text-white/80"}>
                  {scanElapsedSec}s / 10s
                </span>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ── BOTTOM FEEDBACK & CONTROLS ────────────────────────────────────── */}
      <div className="relative z-10 px-4 pt-3 pb-[max(4.5rem,calc(env(safe-area-inset-bottom)+3.5rem))] flex flex-col gap-5">
        {/* Feedback Banner */}
        {lastScanFeedback ? (
          <div
            className={`p-4 rounded-2xl backdrop-blur-lg flex items-center justify-center gap-2.5 text-xs font-semibold shadow-2xl animate-in zoom-in-95 ${
              lastScanFeedback.status === "PASS"
                ? "bg-emerald-600/95 text-white ring-2 ring-emerald-400/40"
                : lastScanFeedback.status === "TIMEOUT"
                ? "bg-amber-600/95 text-white ring-2 ring-amber-400/40"
                : "bg-red-600/95 text-white ring-2 ring-red-400/40"
            }`}
          >
            {lastScanFeedback.status === "PASS" ? (
              <CheckCircle2 className="w-4 h-4 text-emerald-200" />
            ) : (
              <AlertCircle className="w-4 h-4 text-amber-200" />
            )}
            <span>{lastScanFeedback.msg}</span>
          </div>
        ) : (
          <div className="text-center text-[11px] text-white/60 tracking-wide font-medium py-1">
            Align camera with host screen barcode to decode
          </div>
        )}

        {/* Action Buttons Bar with generous gap and touch padding */}
        <div className="grid grid-cols-3 gap-3.5 sm:gap-4 mb-2">
          <button
            onClick={handleManualSkip}
            style={{ touchAction: "manipulation" }}
            className="py-4 px-3 rounded-2xl bg-black/80 backdrop-blur-md border border-white/20 active:bg-white/25 active:scale-95 transition-transform text-xs font-semibold flex items-center justify-center gap-2 shadow-lg select-none"
          >
            <SkipForward className="w-4 h-4 text-white/90" />
            <span>Skip</span>
          </button>

          <button
            onClick={handleManualSnap}
            style={{ touchAction: "manipulation" }}
            className="py-4 px-3 rounded-2xl bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 active:scale-95 transition-transform text-xs font-bold text-white shadow-xl flex items-center justify-center gap-2 ring-2 ring-emerald-400/40 select-none"
          >
            <Camera className="w-4 h-4" />
            <span>Snap</span>
          </button>

          <button
            onClick={handleOpenDrawer}
            style={{ touchAction: "manipulation" }}
            className="py-4 px-3 rounded-2xl bg-black/80 backdrop-blur-md border border-white/20 active:bg-white/25 active:scale-95 transition-transform text-xs font-semibold flex items-center justify-center gap-2 shadow-lg select-none"
          >
            <List className="w-4 h-4 text-white/90" />
            <span>Suite</span>
          </button>
        </div>
      </div>

      {/* Drawer */}
      <TestItemDrawer
        isOpen={showDrawer}
        onClose={() => setShowDrawer(false)}
        items={effectiveItems}
        currentIndex={currentIndex}
        scanLogs={roomState.recentScanLogs}
        itemStatuses={roomState.itemStatuses}
        onSelectIndex={(idx) => onStep(idx)}
      />
    </div>
  );
}
