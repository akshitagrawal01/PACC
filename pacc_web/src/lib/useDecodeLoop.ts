/**
 * useDecodeLoop
 * -------------
 * High-performance cooperative decode loop for the optical scanner view.
 *
 * Architecture:
 * - Operates with cooperative setTimeout yielding to guarantee the browser's UI thread
 *   remains fluid.
 * - Samples canvas frames and dispatches them to the PACC Web Worker decoder
 *   (LDPC soft-decision, Golay format decoding, pilot equalizer, fountain combining).
 * - Multi-format support: scans for PACC symbols, with fallback to standard QR (ZXing).
 * - Integrated pause(ms) API to immediately halt processing during user interactions.
 */

"use client";

import { useCallback, useEffect, useRef } from "react";
import { decodePacc, decodeQcPacc, paccBusy, resetPaccLive, unlockPacc } from "@/lib/pacc/client";
import { decodeWithZXing } from "@/lib/zxingDecoder";
import { reportPacc, reportQc, type Expect } from "@/lib/testLabGrade";

const SCAN_TIMEOUT_MS = 10_000;
const FRAME_INTERVAL_MS = 50;  // ~20 FPS cooperative loop
const MAX_FRAME_DIM = 640;     // 640px optical resolution

export interface DecodeLoopOptions {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  codeType: "PACC" | "PACC_DUAL" | "PACC_QC" | "QR" | "JAB" | string | null;
  active: boolean;
  password?: string;
  /** Grading rule of the current item (layered fine layer, signature, tamper rejection…). */
  expect?: Expect;
  onResult: (text: string, decoderUsed: string, latencyMs: number, attempts: number, fullResult?: unknown) => void;
  onTimeout: (elapsed: number, attempts: number) => void;
}

export function useDecodeLoop({ videoRef, codeType, active, password, expect, onResult, onTimeout }: DecodeLoopOptions) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const attemptsRef = useRef(0);
  const startTimeRef = useRef(0);
  const evaluatingRef = useRef(false);
  const pausedUntilRef = useRef(0);
  const timeoutIdRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const onResultRef = useRef(onResult);
  const onTimeoutRef = useRef(onTimeout);
  const passwordRef = useRef(password);
  const expectRef = useRef(expect);
  // Bumped on every item change: a decode started on the previous item's frame (decodes are
  // asynchronous) must not be credited to the next item.
  const generationRef = useRef(0);

  useEffect(() => {
    onResultRef.current = onResult;
    onTimeoutRef.current = onTimeout;
    passwordRef.current = password;
    expectRef.current = expect;
  }, [onResult, onTimeout, password, expect]);

  const frameTimesRef = useRef<number[]>([]);

  // ── Canvas helper ─────────────────────────────────────────────────────────
  function getCanvas(w: number, h: number): HTMLCanvasElement {
    if (!canvasRef.current) canvasRef.current = document.createElement("canvas");
    const c = canvasRef.current;
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    return c;
  }

  // ── Per-item timer ────────────────────────────────────────────────────────
  const clearTimer = useCallback(() => {
    if (timeoutIdRef.current !== undefined) {
      clearTimeout(timeoutIdRef.current);
      timeoutIdRef.current = undefined;
    }
  }, []);

  const armTimer = useCallback(() => {
    clearTimer();
    timeoutIdRef.current = setTimeout(() => {
      timeoutIdRef.current = undefined;
      const elapsed = Date.now() - startTimeRef.current;
      onTimeoutRef.current(elapsed, attemptsRef.current);
    }, SCAN_TIMEOUT_MS);
  }, [clearTimer]);

  // ── Reset when item changes ───────────────────────────────────────────────
  const reset = useCallback(() => {
    generationRef.current += 1;
    attemptsRef.current = 0;
    startTimeRef.current = Date.now();
    evaluatingRef.current = false;
    pausedUntilRef.current = 0;
    frameTimesRef.current = [];
    resetPaccLive().catch(() => {});
    armTimer();
  }, [armTimer]);

  // ── Pause loop temporarily (e.g. during user taps or screen transitions) ──
  const pause = useCallback((ms = 600) => {
    pausedUntilRef.current = Date.now() + ms;
  }, []);

  // ── Core frame processor ─────────────────────────────────────────────────
  const processFrame = useCallback(
    async (isHighResSnap = false): Promise<void> => {
      const video = videoRef.current;
      if (!video || video.readyState < 2) return;

      const rawW = video.videoWidth || 640;
      const rawH = video.videoHeight || 480;

      const maxDim = isHighResSnap ? 1280 : MAX_FRAME_DIM;
      const scale = Math.max(rawW, rawH) > maxDim ? maxDim / Math.max(rawW, rawH) : 1;
      const w = Math.round(rawW * scale);
      const h = Math.round(rawH * scale);

      const canvas = getCanvas(w, h);
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return;
      ctx.drawImage(video, 0, 0, w, h);
      const imgData = ctx.getImageData(0, 0, w, h);

      attemptsRef.current += 1;
      const attemptNum = attemptsRef.current;
      const generation = generationRef.current;
      const expectNow = expectRef.current;
      const stale = () => generation !== generationRef.current;
      const t0 = performance.now();

      // Record timestamp for FPS tracking
      const now = performance.now();
      frameTimesRef.current.push(now);
      if (frameTimesRef.current.length > 20) frameTimesRef.current.shift();

      if (codeType === "PACC_QC") {
        // QR-compatible symbol: find the QR, then read its hidden PACC chroma channel.
        const zx = await decodeWithZXing(imgData, ["QRCode"]);
        if (zx?.text && zx.corners?.length === 4 && zx.version) {
          try {
            const { qc } = await decodeQcPacc(imgData, zx.corners, zx.version, zx.text);
            const text = reportQc(qc);
            if (text !== null) {
              const lat = Math.round(performance.now() - t0);
              if (stale()) return;
              clearTimer();
              onResultRef.current(text, "PACC QC", lat, attemptNum, qc);
              return;
            }
          } catch {
            // keep scanning
          }
        }
      } else if (codeType === "QR") {
        const res = await decodeWithZXing(imgData, ["QRCode"]);
        if (res?.text) {
          const lat = Math.round(performance.now() - t0);
          if (stale()) return;
          clearTimer();
          onResultRef.current(res.text, `ZXing (${res.format})`, lat, attemptNum);
          return;
        }

        // Opportunistic transition fallback: screen may have transitioned to PACC
        if (attemptNum % 8 === 0 && !paccBusy()) {
          const paccFallback = await decodePacc(imgData, { live: true });
          if (paccFallback?.ok && paccFallback.payload) {
            let text = "";
            try {
              text = new TextDecoder("utf-8").decode(paccFallback.payload);
            } catch {
              text = "";
            }
            if (text) {
              const lat = Math.round(performance.now() - t0);
              if (stale()) return;
              clearTimer();
              onResultRef.current(text, "PACC Native", lat, attemptNum, paccFallback);
              return;
            }
          }
        }
      } else {
        // PACC Primary Path
        if (!paccBusy()) {
          const res = await decodePacc(imgData, { live: !isHighResSnap });
          const text = reportPacc(expectNow, res);
          if (text !== null) {
            const lat = Math.round(performance.now() - t0);
            if (stale()) return;
            clearTimer();
            onResultRef.current(text, res.fine?.ok ? "PACC Native (fine layer)" : "PACC Native", lat, attemptNum, res);
            return;
          }

          // Locked with password
          if (res?.locked === "password" && passwordRef.current) {
            try {
              const unlocked = await unlockPacc(passwordRef.current);
              const uRes = "qc" in unlocked ? unlocked.qc : unlocked;
              const payload = "payload" in uRes ? uRes.payload : ("hidden" in uRes ? uRes.hidden : null);
              if (payload) {
                let text = "";
                try {
                  text = new TextDecoder("utf-8").decode(payload);
                } catch {
                  text = "";
                }
                const lat = Math.round(performance.now() - t0);
                if (stale()) return;
                clearTimer();
                onResultRef.current(text, "PACC Decrypted", lat, attemptNum, uRes);
                return;
              }
            } catch {
              // Wrong password or unlock failed
            }
          }
        }

        // Opportunistic transition fallback: screen may have transitioned to QR (every 12 frames)
        if (attemptNum % 12 === 0) {
          const qrFallback = await decodeWithZXing(imgData, ["QRCode"]);
          if (qrFallback?.text) {
            const lat = Math.round(performance.now() - t0);
            if (stale()) return;
            clearTimer();
            onResultRef.current(qrFallback.text, `ZXing (${qrFallback.format})`, lat, attemptNum);
            return;
          }
        }
      }
    },
    [videoRef, codeType, clearTimer]
  );

  // ── Cooperative, non-blocking scan loop ──────────────────────────────────
  useEffect(() => {
    if (!active || !codeType) {
      if (timerRef.current !== undefined) clearTimeout(timerRef.current);
      clearTimer();
      return;
    }

    let dead = false;

    const runLoop = async () => {
      if (dead) return;

      // Pause when tab is backgrounded or when user actions are in-flight
      if (document.visibilityState !== "visible" || Date.now() < pausedUntilRef.current) {
        if (!dead) timerRef.current = setTimeout(runLoop, 80);
        return;
      }

      if (!evaluatingRef.current) {
        evaluatingRef.current = true;
        try {
          await processFrame(false);
        } catch {}
        evaluatingRef.current = false;
      }

      if (!dead) {
        timerRef.current = setTimeout(runLoop, FRAME_INTERVAL_MS);
      }
    };

    timerRef.current = setTimeout(runLoop, 60);

    return () => {
      dead = true;
      if (timerRef.current !== undefined) clearTimeout(timerRef.current);
    };
  }, [active, codeType, processFrame, clearTimer]);

  // ── Manual Snap (High-Res single frame capture) ───────────────────────────
  const snap = useCallback(async () => {
    pause(1000);
    if (evaluatingRef.current) return;
    evaluatingRef.current = true;
    try {
      await processFrame(true);
    } finally {
      evaluatingRef.current = false;
    }
  }, [pause, processFrame]);

  // Cleanup on unmount
  useEffect(() => () => {
    if (timerRef.current !== undefined) clearTimeout(timerRef.current);
    clearTimer();
    resetPaccLive().catch(() => {});
  }, [clearTimer]);

  const getFps = useCallback(() => {
    const times = frameTimesRef.current;
    if (times.length < 2) return 0;
    const elapsed = (times[times.length - 1] - times[0]) / 1000;
    return elapsed > 0 ? Math.round((times.length - 1) / elapsed) : 0;
  }, []);

  return {
    reset,
    pause,
    snap,
    attemptsRef,
    startTimeRef,
    getFps,
  };
}
