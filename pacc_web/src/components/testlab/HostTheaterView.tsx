"use client";

import React, { useState, useEffect } from "react";
import { encodePacc, encodedToDataUrl } from "@/lib/pacc/client";
import {
  ChevronLeft,
  ChevronRight,
  SkipForward,
  Smartphone,
  Maximize2,
  Minimize2,
  Volume2,
  VolumeX,
  List,
  Zap,
  CheckCircle2,
  Copy,
  Check,
  Radio,
  LogOut,
  Sparkles,
  X,
} from "lucide-react";
import { RoomState, TestItem } from "@/lib/useTestRoom";
import { JoinQrModal } from "./JoinQrModal";
import { TestItemDrawer } from "./TestItemDrawer";
import { ClientBenchmarkModal } from "./ClientBenchmarkModal";
import { playSound } from "@/lib/audioFeedback";

interface HostTheaterViewProps {
  roomState: RoomState;
  onStep: (direction: "next" | "prev" | number) => void;
  onSkip: () => void;
  onLeaveRoom: () => void;
  soundEnabled: boolean;
  setSoundEnabled: (s: boolean) => void;
  autoAdvance: boolean;
  setAutoAdvance: (a: boolean) => void;
  onFetchItems: () => Promise<TestItem[]>;
}

export function HostTheaterView({
  roomState,
  onStep,
  onSkip,
  onLeaveRoom,
  soundEnabled,
  setSoundEnabled,
  autoAdvance,
  setAutoAdvance,
  onFetchItems,
}: HostTheaterViewProps) {
  const [showJoinModal, setShowJoinModal] = useState(false);
  const [showDrawer, setShowDrawer] = useState(false);
  const [showBenchmarkModal, setShowBenchmarkModal] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [copiedCode, setCopiedCode] = useState(false);
  const [fullItems, setFullItems] = useState<TestItem[]>(roomState.items || roomState.suiteItems || []);

  const currentTest = roomState.currentTest;
  const currentIndex = roomState.currentIndex || 0;
  const totalTests = roomState.totalTests || 1;
  const connectedCount = roomState.connectedDevices.filter((d) => d.isOnline).length;
  const lastScan = roomState.lastScanResult;

  const effectiveItems = (roomState.items && roomState.items.length > 0)
    ? roomState.items
    : (roomState.suiteItems && roomState.suiteItems.length > 0)
    ? roomState.suiteItems
    : fullItems;

  // Gate test start: do not start displaying test barcodes until a scanner device joins
  const [hasStarted, setHasStarted] = useState<boolean>(() => {
    return Boolean((roomState.currentIndex && roomState.currentIndex > 0) || roomState.lastScanResult);
  });
  const [joinQrDataUrl, setJoinQrDataUrl] = useState<string | null>(null);
  const [codeFormat, setCodeFormat] = useState<"qr" | "pacc">("qr");
  const [joinPaccDataUrl, setJoinPaccDataUrl] = useState<string | null>(null);
  const [loadingPacc, setLoadingPacc] = useState<boolean>(false);

  const effectiveOrigin = typeof window !== "undefined" ? window.location.origin : "";
  const joinUrl = effectiveOrigin
    ? `${effectiveOrigin}/?tab=test-lab&room=${roomState.roomId}&mode=scanner`
    : "";

  useEffect(() => {
    if (!joinUrl) return;
    import("qrcode")
      .then((QRCode) => {
        QRCode.toDataURL(joinUrl, {
          width: 320,
          margin: 2,
          color: { dark: "#1A1C16", light: "#FFFFFF" },
        })
          .then(setJoinQrDataUrl)
          .catch(() => {});
      })
      .catch(() => {});
  }, [joinUrl]);

  // Generate PACC join barcode when format is switched to pacc
  useEffect(() => {
    if (!joinUrl || codeFormat !== "pacc" || joinPaccDataUrl) return;

    let cancelled = false;
    setLoadingPacc(true);

    // PACC join barcode, encoded in the browser (no server round-trip).
    encodePacc(new TextEncoder().encode(joinUrl), { mcs: 1, level: "M", cellSize: 10 })
      .then((enc) => ({ dataUrl: encodedToDataUrl(enc), error: undefined as string | undefined }))
      .then((data) => {
        const url = data.dataUrl;
        if (!cancelled && url) setJoinPaccDataUrl(url);
      })
      .catch((err) => {
        if (!cancelled) console.warn("Failed to generate join PACC:", err);
      })
      .finally(() => {
        if (!cancelled) setLoadingPacc(false);
      });

    return () => {
      cancelled = true;
    };
  }, [joinUrl, codeFormat, joinPaccDataUrl]);

  // When first scanner device joins, automatically launch the test suite and chime
  useEffect(() => {
    if (connectedCount > 0 && !hasStarted) {
      setHasStarted(true);
      playSound("success", soundEnabled);
    }
  }, [connectedCount, hasStarted, soundEnabled]);

  // Sync full items
  useEffect(() => {
    if (roomState.items?.length) {
      setFullItems(roomState.items);
    } else if (roomState.suiteItems?.length && !fullItems.length) {
      setFullItems(roomState.suiteItems);
    }
  }, [roomState.items, roomState.suiteItems, fullItems.length]);

  const handleOpenDrawer = async () => {
    if (!effectiveItems.length) {
      const items = await onFetchItems();
      if (items?.length) setFullItems(items);
    }
    setShowDrawer(true);
  };

  const handleOpenBenchmark = async () => {
    const hasDataUrls = fullItems.some((i) => Boolean(i.dataUrl));
    if (!hasDataUrls) {
      const items = await onFetchItems();
      if (items?.length) setFullItems(items);
    }
    setShowBenchmarkModal(true);
  };

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore if in an input
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      if (e.key === "ArrowRight") {
        if (!hasStarted) return;
        e.preventDefault();
        onStep("next");
      } else if (e.key === "ArrowLeft") {
        if (!hasStarted) return;
        e.preventDefault();
        onStep("prev");
      } else if (e.code === "Space") {
        if (!hasStarted) return;
        e.preventDefault();
        onSkip();
      } else if (e.key === "f" || e.key === "F") {
        e.preventDefault();
        toggleFullscreen();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onStep, onSkip, hasStarted]);

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().then(() => setIsFullscreen(true)).catch(() => {});
    } else {
      document.exitFullscreen().then(() => setIsFullscreen(false)).catch(() => {});
    }
  };

  const copyRoomCode = () => {
    navigator.clipboard.writeText(roomState.roomId);
    setCopiedCode(true);
    setTimeout(() => setCopiedCode(false), 2000);
  };

  return (
    <div className="w-full min-h-[calc(100vh-80px)] flex flex-col justify-between p-3 sm:p-5 max-w-6xl mx-auto space-y-4 select-none">
      {/* ── TOP NAV BAR ─────────────────────────────────────────────────── */}
      <div
        className="w-full flex items-center justify-between p-3 sm:p-4 rounded-2xl shadow-sm border"
        style={{ background: "var(--surface)", borderColor: "var(--border-mid)" }}
      >
        {/* Left: Room ID & Devices */}
        <div className="flex items-center gap-2 sm:gap-3">
          <button
            onClick={copyRoomCode}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-stone-100 hover:bg-stone-200 transition text-stone-800 text-xs font-mono font-bold tracking-wider"
          >
            <span>ROOM {roomState.roomId}</span>
            {copiedCode ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5 text-stone-400" />}
          </button>

          {roomState.suiteTitle && (
            <span className="hidden md:inline px-2.5 py-1.5 rounded-xl bg-stone-100 text-stone-600 text-xs font-semibold border border-stone-200/60">
              {roomState.suiteTitle}
            </span>
          )}

          <div className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl border text-xs font-semibold ${
            connectedCount > 0
              ? "bg-emerald-50 border-emerald-200/60 text-emerald-800"
              : "bg-amber-50 border-amber-200/60 text-amber-800"
          }`}>
            <Radio className={`w-3.5 h-3.5 ${connectedCount > 0 ? "text-emerald-600 animate-pulse" : "text-amber-600"}`} />
            <span>{connectedCount > 0 ? `${connectedCount} ${connectedCount === 1 ? "Scanner" : "Scanners"} Live` : "Waiting for Scanner…"}</span>
          </div>
        </div>

        {/* Right: Actions */}
        <div className="flex items-center gap-1.5 sm:gap-2">
          {hasStarted && connectedCount === 0 && (
            <button
              onClick={() => setHasStarted(false)}
              className="px-3 py-1.5 rounded-xl text-xs font-semibold bg-stone-100 hover:bg-stone-200 text-stone-700 flex items-center gap-1.5 transition border border-stone-200 shadow-xs cursor-pointer"
              title="Close Desktop Preview and return to QR screen"
            >
              <X className="w-3.5 h-3.5 text-stone-500" />
              <span className="hidden sm:inline">Close Desktop Preview</span>
              <span className="sm:hidden">Close</span>
            </button>
          )}

          {hasStarted && (
            <button
              onClick={() => setShowJoinModal(true)}
              className="px-3 py-1.5 rounded-xl text-xs font-semibold bg-emerald-700 hover:bg-emerald-800 text-white flex items-center gap-1.5 transition shadow-sm"
              title="Pair Another Mobile Scanner"
            >
              <Smartphone className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Pair Mobile Scanner</span>
            </button>
          )}

          <button
            onClick={handleOpenBenchmark}
            className="p-2 rounded-xl text-stone-600 hover:bg-stone-100 transition border border-stone-200"
            title="Synthetic Client Benchmark"
          >
            <Zap className="w-4 h-4 text-amber-600" />
          </button>

          <button
            onClick={() => setSoundEnabled(!soundEnabled)}
            className="p-2 rounded-xl text-stone-600 hover:bg-stone-100 transition border border-stone-200"
            title={soundEnabled ? "Mute Sound" : "Enable Sound"}
          >
            {soundEnabled ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4 text-stone-400" />}
          </button>

          <button
            onClick={toggleFullscreen}
            className="p-2 rounded-xl text-stone-600 hover:bg-stone-100 transition border border-stone-200"
            title="Toggle Fullscreen"
          >
            {isFullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
          </button>

          <button
            onClick={onLeaveRoom}
            className="p-2 rounded-xl text-red-600 hover:bg-red-50 transition border border-red-200"
            title="Exit Room"
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* ── THEATER STAGE (BARCODE CANVAS OR WAITING ROOM) ────────────────── */}
      <div className="flex-1 flex flex-col items-center justify-center py-4 sm:py-6">
        {!hasStarted && connectedCount === 0 ? (
          /* Waiting for Scanner Device Staging Screen */
          <div className="w-full max-w-xl flex flex-col items-center space-y-4 animate-in fade-in duration-300">
            <div
              className="relative p-6 sm:p-8 rounded-3xl shadow-2xl border flex flex-col items-center max-w-md w-full text-center space-y-4"
              style={{ background: "var(--surface)", borderColor: "var(--border-mid)" }}
            >
              {/* Status Badge */}
              <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-amber-50 border border-amber-200 text-amber-900 text-xs font-semibold">
                <Radio className="w-3.5 h-3.5 text-amber-600 animate-pulse" />
                <span>Waiting for Scanner Device to Join…</span>
              </div>

              {/* Header Title */}
              <div className="space-y-1">
                <h3 className="text-xl font-bold text-stone-900">
                  Connect Phone to Start Test
                </h3>
                <p className="text-xs text-stone-500 max-w-xs mx-auto">
                  The test suite will automatically launch as soon as a scanner device connects.
                </p>
              </div>

              {/* Format Selector Pill (Standard QR vs PACC Optical Code) */}
              <div className="flex items-center justify-center pt-1">
                <div className="p-0.5 rounded-xl bg-stone-100 border border-stone-200 flex gap-1 text-xs shadow-inner">
                  <button
                    type="button"
                    onClick={() => setCodeFormat("qr")}
                    className={`px-3 py-1 rounded-lg font-medium transition cursor-pointer ${
                      codeFormat === "qr"
                        ? "bg-white text-stone-900 shadow-xs font-semibold"
                        : "text-stone-600 hover:text-stone-900"
                    }`}
                  >
                    Standard QR
                  </button>
                  <button
                    type="button"
                    onClick={() => setCodeFormat("pacc")}
                    className={`px-3 py-1 rounded-lg font-medium transition flex items-center gap-1.5 cursor-pointer ${
                      codeFormat === "pacc"
                        ? "bg-emerald-800 text-white shadow-xs font-semibold"
                        : "text-stone-600 hover:text-stone-900"
                    }`}
                  >
                    <Sparkles className="w-3.5 h-3.5 text-emerald-300" />
                    <span>PACC Barcode</span>
                  </button>
                </div>
              </div>

              {/* Big Join Code (Standard QR or PACC) */}
              <div className="p-4 bg-white rounded-2xl border border-stone-200 shadow-inner flex items-center justify-center">
                {codeFormat === "pacc" ? (
                  loadingPacc ? (
                    <div className="w-56 h-56 sm:w-64 sm:h-64 flex flex-col items-center justify-center bg-stone-50 rounded-xl animate-pulse text-stone-500 text-xs font-medium gap-2">
                      <Sparkles className="w-6 h-6 text-emerald-600 animate-spin" />
                      <span>Synthesizing PACC Optical Barcode…</span>
                    </div>
                  ) : joinPaccDataUrl ? (
                    <img
                      src={joinPaccDataUrl}
                      alt={`Join Room ${roomState.roomId} via PACC`}
                      className="w-56 h-56 sm:w-64 sm:h-64 object-contain rounded-xl select-none"
                      style={{ imageRendering: "pixelated" }}
                    />
                  ) : (
                    <div className="w-56 h-56 sm:w-64 sm:h-64 flex items-center justify-center bg-stone-100 rounded-xl text-stone-400 text-xs font-medium">
                      Failed to load PACC
                    </div>
                  )
                ) : joinQrDataUrl ? (
                  <img
                    src={joinQrDataUrl}
                    alt={`Join Room ${roomState.roomId} via QR`}
                    className="w-56 h-56 sm:w-64 sm:h-64 object-contain rounded-xl select-none"
                    style={{ imageRendering: "pixelated" }}
                  />
                ) : (
                  <div className="w-56 h-56 sm:w-64 sm:h-64 flex items-center justify-center bg-stone-100 rounded-xl animate-pulse text-stone-400 text-xs font-medium">
                    Generating Join Code…
                  </div>
                )}
              </div>

              {/* Room Access Code */}
              <div className="w-full p-3 rounded-2xl bg-stone-100/90 border border-stone-200/80 space-y-1">
                <div className="text-[10px] font-bold uppercase tracking-wider text-stone-500">
                  Room Access Code
                </div>
                <div className="text-2xl font-mono font-extrabold text-stone-900 tracking-widest">
                  {roomState.roomId}
                </div>
              </div>

              {/* Standalone Desktop Preview Bypass */}
              <button
                type="button"
                onClick={() => setHasStarted(true)}
                className="text-xs text-stone-400 hover:text-stone-700 underline underline-offset-4 transition cursor-pointer"
              >
                Start anyway without a device (Desktop preview)
              </button>
            </div>
          </div>
        ) : (
          /* Active Barcode Canvas */
          <div className="w-full max-w-xl flex flex-col items-center space-y-4 animate-in fade-in duration-300">
            {/* Desktop Preview Mode banner with explicit Close button */}
            {connectedCount === 0 && (
              <div className="w-full flex items-center justify-between px-4 py-2 rounded-2xl bg-amber-50 border border-amber-200/80 text-amber-900 text-xs shadow-xs">
                <div className="flex items-center gap-2 font-medium">
                  <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
                  <span>Desktop Preview Active (No phone connected)</span>
                </div>
                <button
                  type="button"
                  onClick={() => setHasStarted(false)}
                  className="flex items-center gap-1 font-bold text-amber-900 hover:text-amber-950 bg-amber-100 hover:bg-amber-200 px-2.5 py-1 rounded-xl transition cursor-pointer"
                  title="Return to Standby QR / PACC Code"
                >
                  <X className="w-3.5 h-3.5" />
                  <span>Close Preview</span>
                </button>
              </div>
            )}

            {/* Barcode Frame */}
            <div className="relative p-5 sm:p-7 bg-white rounded-3xl shadow-2xl border border-stone-200/90 flex flex-col items-center overflow-hidden">
              {currentTest?.dataUrl ? (
                <AnimatedSymbol
                  key={currentTest.id}
                  src={currentTest.dataUrl}
                  frames={currentTest.frames ?? undefined}
                  fps={currentTest.fps}
                  alt={currentTest.label}
                  style={{
                    imageRendering: "pixelated",
                    filter: currentTest.cssFilter || "none",
                    transform: currentTest.cssTransform || "none"
                  }}
                />
              ) : (
                <div className="w-64 h-64 sm:w-80 sm:h-80 flex items-center justify-center bg-stone-100 rounded-xl animate-pulse text-stone-400 text-xs font-medium">
                  Generating Barcode…
                </div>
              )}

              {/* Condition Badge */}
              {currentTest && (
                <div className="mt-4 text-center space-y-1">
                  <div className="flex items-center justify-center gap-2">
                    <span
                      className={`text-xs font-bold px-2.5 py-0.5 rounded-md border ${
                        currentTest.codeType === "PACC"
                          ? "bg-emerald-50 text-emerald-800 border-emerald-300"
                          : "bg-purple-50 text-purple-800 border-purple-300"
                      }`}
                    >
                      {currentTest.badge || (currentTest.codeType === "PACC" ? "PACC Engine" : "Standard QR")}
                    </span>
                    <span className="text-sm font-bold text-stone-900">{currentTest.label}</span>
                  </div>
                  <div className="text-xs text-stone-500 font-mono">{currentTest.sublabel}</div>
                  {currentTest.hint && (
                    <div className="mt-2 inline-block px-3 py-1 rounded-full bg-amber-50 text-amber-900 text-sm font-medium">
                      {currentTest.hint}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Last Scan Result Pill */}
            {lastScan && (
              <div className="flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs font-medium shadow-sm animate-in fade-in slide-in-from-bottom-2">
                <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                <span>
                  {lastScan.status} in {lastScan.clientTimeToScanMs || lastScan.decodeLatencyMs}ms by{" "}
                  <span className="font-semibold">{lastScan.deviceName || "Scanner"}</span>
                </span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── CONTROLS & TIMELINE BAR ───────────────────────────────────────── */}
      <div
        className="w-full flex flex-col sm:flex-row items-center justify-between p-3 sm:p-4 rounded-2xl shadow-sm border gap-3"
        style={{ background: "var(--surface)", borderColor: "var(--border-mid)" }}
      >
        {/* Navigation buttons */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => onStep("prev")}
            disabled={!hasStarted || currentIndex <= 0}
            className="p-2.5 rounded-xl border border-stone-200 hover:bg-stone-100 transition disabled:opacity-30 text-stone-700"
            title="Previous (Left Arrow)"
          >
            <ChevronLeft className="w-5 h-5" />
          </button>

          <div className="px-3 py-1.5 text-center">
            <div className="text-xs font-mono font-bold text-stone-900">
              {hasStarted ? `Test ${currentIndex + 1} of ${totalTests}` : "Standby Mode"}
            </div>
            <div className="text-[10px] text-stone-500 font-medium">
              {hasStarted ? `Round ${roomState.round || 1}` : "Waiting for scanner"}
            </div>
          </div>

          <button
            onClick={() => onStep("next")}
            disabled={!hasStarted || currentIndex >= totalTests - 1}
            className="p-2.5 rounded-xl border border-stone-200 hover:bg-stone-100 transition disabled:opacity-30 text-stone-700"
            title="Next (Right Arrow)"
          >
            <ChevronRight className="w-5 h-5" />
          </button>

          <button
            onClick={onSkip}
            disabled={!hasStarted}
            className="px-3 py-2 rounded-xl border border-stone-200 hover:bg-stone-100 transition text-xs font-medium text-stone-600 flex items-center gap-1.5 ml-2 disabled:opacity-30"
            title="Skip Item (Space)"
          >
            <SkipForward className="w-3.5 h-3.5" />
            <span>Skip</span>
          </button>
        </div>

        {/* Center Progress Bar */}
        <div className="w-full sm:w-64 space-y-1">
          <div className="w-full bg-stone-200 h-2 rounded-full overflow-hidden">
            <div
              className="bg-emerald-600 h-full transition-all duration-200"
              style={{ width: `${Math.round(((currentIndex + 1) / totalTests) * 100)}%` }}
            />
          </div>
          <div className="flex justify-between text-[10px] text-stone-400 font-mono">
            <span>Progress</span>
            <span>{Math.round(((currentIndex + 1) / totalTests) * 100)}%</span>
          </div>
        </div>

        {/* Right drawer & auto advance switch */}
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-xs text-stone-600 cursor-pointer">
            <input
              type="checkbox"
              checked={autoAdvance}
              onChange={(e) => setAutoAdvance(e.target.checked)}
              className="rounded text-emerald-600 focus:ring-emerald-500"
            />
            <span className="hidden sm:inline">Auto-Advance</span>
          </label>

          <button
            onClick={handleOpenDrawer}
            className="px-3.5 py-2 rounded-xl border border-stone-200 hover:bg-stone-100 transition text-xs font-semibold text-stone-800 flex items-center gap-1.5"
          >
            <List className="w-4 h-4" />
            <span>Browse Suite</span>
          </button>
        </div>
      </div>

      {/* Modals */}
      <JoinQrModal
        isOpen={showJoinModal}
        onClose={() => setShowJoinModal(false)}
        roomId={roomState.roomId}
      />

      <TestItemDrawer
        isOpen={showDrawer}
        onClose={() => setShowDrawer(false)}
        items={effectiveItems}
        currentIndex={currentIndex}
        scanLogs={roomState.recentScanLogs}
        itemStatuses={roomState.itemStatuses}
        onSelectIndex={(idx) => onStep(idx)}
      />

      <ClientBenchmarkModal
        isOpen={showBenchmarkModal}
        onClose={() => setShowBenchmarkModal(false)}
        items={fullItems}
        roomId={roomState.roomId}
      />
    </div>
  );
}

/** A test symbol; loops through `frames` (animated stream, moving glare) when given. */
function AnimatedSymbol({ src, frames, fps = 4, alt, style }: {
  src: string; frames?: string[]; fps?: number; alt: string; style: React.CSSProperties;
}) {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (!frames || frames.length < 2) return;
    const t = setInterval(() => setI((k) => (k + 1) % frames.length), 1000 / Math.max(1, fps));
    return () => clearInterval(t);
  }, [frames, fps]);
  return (
    <img
      src={frames && frames.length ? frames[i % frames.length] : src}
      alt={alt}
      className="w-72 h-72 sm:w-[28rem] sm:h-[28rem] object-contain rounded-xl select-none"
      style={style}
    />
  );
}
