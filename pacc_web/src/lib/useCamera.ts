/**
 * useCamera
 * ---------
 * Camera stream lifecycle, torch, primary main camera selection, hardware zoom, wake lock.
 *
 * Design principles:
 * - Always targets the Primary Main Camera (Camera 0 / 1x autofocus sensor) on multi-camera devices.
 * - Enforces high-definition stream negotiation (width: 1920, min: 1280; height: 1080, min: 720; min: 24fps)
 *   which automatically filters out lower-tier auxiliary / ultra-wide fixed-focus sensors.
 * - Applies continuous autofocus automatically.
 * - Wake lock keeps screen on during long testing sessions.
 */

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { enforceContinuousFocus, openPrimaryCameraStream } from "./cameraHelper";
import type { ThrownError } from "@/lib/errors";
import { applyCameraConstraints, getCameraCapabilities } from "./browserApis";

export interface CameraInfo {
  active: boolean;
  hasTorch: boolean;
  torchOn: boolean;
  hasHwZoom: boolean;
  zoomLevel: number;
  facingMode: "environment" | "user";
  cameraError: string | null;
  cameraResolution: string;
  cameraFps: number;
}

export interface UseCameraReturn extends CameraInfo {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  streamRef: React.RefObject<MediaStream | null>;
  start: (facing?: "environment" | "user") => Promise<void>;
  stop: () => void;
  flip: () => Promise<void>;
  setTorch: (on: boolean) => Promise<void>;
  setZoom: (level: number) => Promise<void>;
  getTrackInfo: () => { width: number | null; height: number | null; fps: number | null };
}

export function useCamera(): UseCameraReturn {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const facingRef = useRef<"environment" | "user">("environment");

  const [active, setActive] = useState(false);
  const [hasTorch, setHasTorch] = useState(false);
  const [torchOn, setTorchOnState] = useState(false);
  const [hasHwZoom, setHasHwZoom] = useState(false);
  const [zoomLevel, setZoomLevelState] = useState(1.0);
  const [facingMode, setFacingMode] = useState<"environment" | "user">("environment");
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [cameraResolution, setCameraResolution] = useState("1280x720");
  const [cameraFps, setCameraFps] = useState(30);

  // ── Wake lock ─────────────────────────────────────────────────────────────
  const acquireWakeLock = useCallback(async () => {
    if (typeof navigator === "undefined" || !("wakeLock" in navigator)) return;
    try {
      wakeLockRef.current = await navigator.wakeLock.request("screen");
    } catch {}
  }, []);

  const releaseWakeLock = useCallback(() => {
    try { wakeLockRef.current?.release(); } catch {}
    wakeLockRef.current = null;
  }, []);

  // Re-acquire on tab focus
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible" && streamRef.current) {
        acquireWakeLock();
        if (videoRef.current?.paused) {
          videoRef.current.play().catch(() => {});
        }
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [acquireWakeLock]);

  // ── stop ─────────────────────────────────────────────────────────────────
  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setActive(false);
    setTorchOnState(false);
    releaseWakeLock();
  }, [releaseWakeLock]);

  // ── start ─────────────────────────────────────────────────────────────────
  const start = useCallback(async (facing?: "environment" | "user") => {
    stop(); // always clean-slate
    setCameraError(null);
    const targetFacing = facing ?? facingRef.current;
    facingRef.current = targetFacing;

    let stream: MediaStream;
    try {
      stream = await openPrimaryCameraStream(targetFacing);
    } catch (caught: unknown) {
      const e = caught as ThrownError;
      const msg =
        e?.name === "NotAllowedError"
          ? "Camera permission denied. Allow camera access and reload."
          : e?.name === "NotFoundError"
          ? "No camera found on this device."
          : `Camera error: ${e?.message ?? "unknown"}`;
      setCameraError(msg);
      return;
    }

    streamRef.current = stream;

    // Attach to video element and track resolution
    if (videoRef.current) {
      const vid = videoRef.current;
      vid.srcObject = stream;
      vid.setAttribute("playsinline", "true");
      vid.muted = true;

      const updateRes = () => {
        const trk = stream.getVideoTracks()[0];
        const s = trk?.getSettings() ?? {};
        const w = vid.videoWidth || s.width || 0;
        const h = vid.videoHeight || s.height || 0;
        const fps = s.frameRate ? Math.round(s.frameRate) : 30;
        if (w > 0 && h > 0) {
          setCameraResolution(`${w}x${h}`);
          setCameraFps(fps);
        }
        enforceContinuousFocus(trk);
      };

      vid.onloadedmetadata = updateRes;
      vid.onresize = updateRes;
      vid.onplaying = updateRes;

      try { await vid.play(); } catch {}

      setTimeout(updateRes, 400);
      setTimeout(updateRes, 1200);
    }

    const track = stream.getVideoTracks()[0];
    const caps = getCameraCapabilities(track);
    const settings = track?.getSettings() ?? {};
    if (settings.width && settings.height) {
      setCameraResolution(`${settings.width}x${settings.height}`);
      if (settings.frameRate) setCameraFps(Math.round(settings.frameRate));
    }

    await enforceContinuousFocus(track);

    setHasTorch(Boolean(caps.torch));
    setHasHwZoom(Boolean(caps.zoom));
    setZoomLevelState(1.0);
    setFacingMode(targetFacing);
    setActive(true);
    acquireWakeLock();
  }, [stop, acquireWakeLock]);

  // ── flip ─────────────────────────────────────────────────────────────────
  const flip = useCallback(async () => {
    const next = facingRef.current === "environment" ? "user" : "environment";
    await start(next);
  }, [start]);

  // ── torch ─────────────────────────────────────────────────────────────────
  const setTorch = useCallback(async (on: boolean) => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    try {
      await applyCameraConstraints(track, { torch: on });
      setTorchOnState(on);
    } catch {}
  }, []);

  // ── zoom ─────────────────────────────────────────────────────────────────
  const setZoom = useCallback(async (level: number) => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    try {
      await applyCameraConstraints(track, { zoom: level });
      setZoomLevelState(level);
    } catch {}
  }, []);

  // ── track info ────────────────────────────────────────────────────────────
  const getTrackInfo = useCallback(() => {
    const vid = videoRef.current;
    const track = streamRef.current?.getVideoTracks()[0];
    const s = track?.getSettings() ?? {};
    return {
      width: vid?.videoWidth || s.width || null,
      height: vid?.videoHeight || s.height || null,
      fps: s.frameRate ? Math.round(s.frameRate) : null,
    };
  }, []);

  // Cleanup on unmount
  useEffect(() => () => stop(), [stop]);

  return {
    videoRef,
    streamRef,
    active,
    hasTorch,
    torchOn,
    hasHwZoom,
    zoomLevel,
    facingMode,
    cameraError,
    cameraResolution,
    cameraFps,
    start,
    stop,
    flip,
    setTorch,
    setZoom,
    getTrackInfo,
  };
}
