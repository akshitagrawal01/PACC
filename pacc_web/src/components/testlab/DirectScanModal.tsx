"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import { X, Camera, Sparkles, AlertCircle } from "lucide-react";
import { openPrimaryCameraStream, enforceContinuousFocus } from "@/lib/cameraHelper";
import { decodeWithZXing, prewarmZXing } from "@/lib/zxingDecoder";
import { decodePacc, paccBusy, resetPaccLive } from "@/lib/pacc/client";
import { extractTestLabRoom } from "@/lib/testLabHelper";
import { errorMessage } from "@/lib/errors";
import { getAudioContextCtor } from "@/lib/browserApis";

interface DirectScanModalProps {
  isOpen: boolean;
  onClose: () => void;
  onJoin: (roomId: string, mode?: "host" | "scanner") => void;
}

export function DirectScanModal({ isOpen, onClose, onJoin }: DirectScanModalProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const [active, setActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detectedRoom, setDetectedRoom] = useState<string | null>(null);

  // Prewarm ZXing
  useEffect(() => {
    prewarmZXing();
  }, []);

  const stopCamera = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setActive(false);
  }, []);

  // Handle open / close lifecycle
  useEffect(() => {
    if (!isOpen) {
      stopCamera();
      setError(null);
      setDetectedRoom(null);
      return;
    }

    let isSubscribed = true;

    async function initCamera() {
      try {
        setError(null);
        const stream = await openPrimaryCameraStream("environment");
        if (!isSubscribed) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }

        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.setAttribute("playsinline", "true");
          videoRef.current.muted = true;
          try {
            await videoRef.current.play();
          } catch {}

          const track = stream.getVideoTracks()[0];
          if (track) enforceContinuousFocus(track);
        }

        setActive(true);
      } catch (err: unknown) {
        if (!isSubscribed) return;
        setError(errorMessage(err, "Camera access was denied or is unavailable."));
      }
    }

    initCamera();

    return () => {
      isSubscribed = false;
      stopCamera();
    };
  }, [isOpen, stopCamera]);

  // Frame processing loop
  useEffect(() => {
    if (!isOpen || !active || detectedRoom) return;

    let animId: number;
    let stopped = false;
    let isEvaluating = false;

    if (!canvasRef.current) {
      canvasRef.current = document.createElement("canvas");
    }
    const canvas = canvasRef.current;

    const processFrame = async () => {
      if (stopped) return;

      if (!videoRef.current || videoRef.current.readyState < 2 || isEvaluating) {
        animId = requestAnimationFrame(processFrame);
        return;
      }

      isEvaluating = true;
      const video = videoRef.current;
      const vw = video.videoWidth || 640;
      const vh = video.videoHeight || 480;

      if (canvas.width !== vw || canvas.height !== vh) {
        canvas.width = vw;
        canvas.height = vh;
      }

      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) {
        isEvaluating = false;
        animId = requestAnimationFrame(processFrame);
        return;
      }

      ctx.drawImage(video, 0, 0, vw, vh);
      const imgData = ctx.getImageData(0, 0, vw, vh);

      try {
        // 1. Try PACC Optical Pipeline
        if (!paccBusy()) {
          const paccRes = await decodePacc(imgData, { live: true });
          if (paccRes.ok && paccRes.payload) {
            let text = "";
            try {
              text = new TextDecoder().decode(paccRes.payload);
            } catch {
              text = "";
            }
            if (text) {
              const target = extractTestLabRoom(text);
              if (target) {
                handleFoundRoom(target.roomId, target.mode);
                stopped = true;
                return;
              }
            }
          }
        }

        // 2. Try Standard QR (ZXing)
        const zxRes = await decodeWithZXing(imgData, ["QRCode"]);
        if (zxRes?.text) {
          const target = extractTestLabRoom(zxRes.text);
          if (target) {
            handleFoundRoom(target.roomId, target.mode);
            stopped = true;
            return;
          }
        }
      } catch {
        // Continue scanning
      } finally {
        isEvaluating = false;
        if (!stopped) {
          animId = requestAnimationFrame(processFrame);
        }
      }
    };

    animId = requestAnimationFrame(processFrame);

    return () => {
      stopped = true;
      cancelAnimationFrame(animId);
    };
  }, [isOpen, active, detectedRoom]);

  const handleFoundRoom = (roomId: string, mode: "host" | "scanner" = "scanner") => {
    setDetectedRoom(roomId);

    // Haptic & Audio feedback
    if (typeof window !== "undefined" && "vibrate" in navigator) {
      try {
        navigator.vibrate([60, 40, 90]);
      } catch {}
    }

    try {
      const AudioCtx = getAudioContextCtor();
      if (AudioCtx) {
        const ctx = new AudioCtx();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.setValueAtTime(880, ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(1174.66, ctx.currentTime + 0.12);
        gain.gain.setValueAtTime(0.2, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.22);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.24);
      }
    } catch {}

    stopCamera();
    setTimeout(() => {
      onJoin(roomId, mode);
      onClose();
    }, 400);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm animate-in fade-in duration-200">
      <div
        className="w-full max-w-sm rounded-2xl overflow-hidden shadow-2xl space-y-4 animate-in zoom-in-95 duration-200 relative"
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border-mid)",
        }}
      >
        {/* Header */}
        <div className="p-4 pb-0 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-xl bg-emerald-700 text-white flex items-center justify-center">
              <Camera className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-stone-900">Direct Decoder Connect</h3>
              <p className="text-[11px] text-stone-500">Scan host screen join barcode</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-full hover:bg-black/5 text-stone-400 hover:text-stone-700 transition cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Viewfinder */}
        <div className="px-4">
          <div className="relative w-full aspect-square rounded-2xl overflow-hidden bg-black flex items-center justify-center border border-emerald-950/40 shadow-inner">
            <video
              ref={videoRef}
              className={`w-full h-full object-cover transition-opacity duration-300 ${
                active ? "opacity-100" : "opacity-0"
              }`}
              muted
              playsInline
              autoPlay
            />

            {/* Scanning beam & reticle */}
            {active && !detectedRoom && (
              <div className="absolute inset-0 pointer-events-none flex flex-col items-center justify-center">
                <div className="w-48 h-48 rounded-2xl border-2 border-emerald-400/80 relative shadow-[0_0_15px_rgba(52,211,153,0.3)]">
                  {/* Corner accents */}
                  <div className="absolute -top-1 -left-1 w-4 h-4 border-t-2 border-l-2 border-emerald-300 rounded-tl" />
                  <div className="absolute -top-1 -right-1 w-4 h-4 border-t-2 border-r-2 border-emerald-300 rounded-tr" />
                  <div className="absolute -bottom-1 -left-1 w-4 h-4 border-b-2 border-l-2 border-emerald-300 rounded-bl" />
                  <div className="absolute -bottom-1 -right-1 w-4 h-4 border-b-2 border-r-2 border-emerald-300 rounded-br" />

                  {/* Scanning beam animation */}
                  <div className="absolute left-0 right-0 h-0.5 bg-gradient-to-r from-transparent via-emerald-400 to-transparent animate-pulse shadow-[0_0_8px_#34d399] top-1/2 -translate-y-1/2" />
                </div>
              </div>
            )}

            {/* Success overlay */}
            {detectedRoom && (
              <div className="absolute inset-0 bg-emerald-900/80 backdrop-blur-xs flex flex-col items-center justify-center gap-2 text-white animate-in zoom-in-95">
                <Sparkles className="w-10 h-10 text-emerald-300 animate-bounce" />
                <div className="text-base font-bold">Room {detectedRoom} Detected!</div>
                <div className="text-xs text-emerald-100">Connecting mobile scanner…</div>
              </div>
            )}

            {/* Inactive / Error */}
            {!active && !detectedRoom && (
              <div className="absolute inset-0 flex flex-col items-center justify-center p-4 text-center gap-2 text-stone-300">
                {error ? (
                  <>
                    <AlertCircle className="w-8 h-8 text-red-400" />
                    <p className="text-xs text-red-300 max-w-[200px]">{error}</p>
                  </>
                ) : (
                  <>
                    <Camera className="w-8 h-8 text-emerald-400 animate-pulse" />
                    <p className="text-xs text-stone-400">Starting camera…</p>
                  </>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="p-4 pt-0 text-center">
          <p className="text-[11px] text-stone-500">
            Aim camera at the QR code displayed on your host screen.
          </p>
        </div>
      </div>
    </div>
  );
}
