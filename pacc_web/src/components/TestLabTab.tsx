"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import { useTestRoom } from "@/lib/useTestRoom";
import { useCamera } from "@/lib/useCamera";
import {
  getDeviceId,
  getHardwareFingerprint,
  enrichHardwareFingerprint,
  setCustomDeviceName,
  HardwareFingerprint,
} from "@/lib/deviceFingerprint";
import { RoomSetupView } from "./testlab/RoomSetupView";
import { HostTheaterView } from "./testlab/HostTheaterView";
import { ScannerView } from "./testlab/ScannerView";
import { SuiteCompletedView } from "./testlab/SuiteCompletedView";

export interface TestLabTabProps {
  onTestActiveChange?: (active: boolean) => void;
  initialRoomId?: string | null;
  initialMode?: "host" | "scanner";
}

export function TestLabTab({
  onTestActiveChange,
  initialRoomId,
  initialMode = "host",
}: TestLabTabProps = {}) {
  // ── Mode & Routing ────────────────────────────────────────────────────────
  const [mode, setMode] = useState<"host" | "scanner">(initialMode);
  const [roomId, setRoomId] = useState<string>(initialRoomId ? initialRoomId.toUpperCase() : "");
  const [deviceId, setDeviceId] = useState<string>("");
  const [hardware, setHardware] = useState<HardwareFingerprint | null>(null);

  // Sync if initialRoomId is updated externally (e.g. from direct decoder navigation)
  useEffect(() => {
    if (initialRoomId) {
      setRoomId(initialRoomId.toUpperCase());
      if (initialMode) setMode(initialMode);
    }
  }, [initialRoomId, initialMode]);

  // Sound & Auto-advance preferences
  const [soundEnabled, setSoundEnabled] = useState<boolean>(true);
  const [autoAdvance, setAutoAdvance] = useState<boolean>(true);
  const autoAdvanceRef = useRef(true);
  autoAdvanceRef.current = autoAdvance;

  // Initialize client ID, hardware, and URL query params
  useEffect(() => {
    const dId = getDeviceId();
    setDeviceId(dId);

    const initialHw = getHardwareFingerprint();
    setHardware(initialHw);

    // Asynchronously enrich with Chromium User-Agent Client Hints (real phone model, true Android OS)
    enrichHardwareFingerprint(initialHw).then((enriched) => {
      setHardware(enriched);
    });

    if (typeof window !== "undefined") {
      const isMobileDevice =
        /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);

      const params = new URLSearchParams(window.location.search);
      const roomParam = params.get("room") || params.get("join");
      const modeParam = params.get("mode");

      if (roomParam) {
        const cleanRoom = roomParam.toUpperCase();
        setRoomId(cleanRoom);

        const savedRole = sessionStorage.getItem(`pacc_role_${cleanRoom}`) as "host" | "scanner" | null;

        if (modeParam === "scanner") {
          setMode("scanner");
          sessionStorage.setItem(`pacc_role_${cleanRoom}`, "scanner");
        } else if (modeParam === "host") {
          setMode("host");
          sessionStorage.setItem(`pacc_role_${cleanRoom}`, "host");
        } else if (savedRole) {
          setMode(savedRole);
        } else if (isMobileDevice) {
          setMode("scanner");
          sessionStorage.setItem(`pacc_role_${cleanRoom}`, "scanner");
        } else {
          setMode("host");
          sessionStorage.setItem(`pacc_role_${cleanRoom}`, "host");
        }
      } else if (isMobileDevice && modeParam !== "host") {
        setMode("scanner");
      }
    }
  }, []);


  // ── Camera Controller ─────────────────────────────────────────────────────
  const camera = useCamera();

  // Stop camera if mode switches to host or room is cleared
  useEffect(() => {
    if (mode !== "scanner" && camera.active) {
      camera.stop();
    }
  }, [mode, camera]);

  // Dynamically capture actual camera resolution & FPS once stream opens
  useEffect(() => {
    if (camera.active) {
      const res = camera.cameraResolution;
      const fps = camera.cameraFps;
      setHardware((prev) => {
        if (!prev) return prev;
        if (prev.cameraResolution === res && prev.cameraFps === fps) return prev;
        return {
          ...prev,
          cameraResolution: res,
          cameraFps: fps,
        };
      });
    }
  }, [camera.active, camera.cameraResolution, camera.cameraFps]);

  // ── Test Room Server Controller ───────────────────────────────────────────
  const testRoom = useTestRoom({
    roomId,
    deviceId,
    mode,
    hardware,
    onTestChange: (_item, _index) => {
      // Called when active item advances on the server
    },
    onComplete: () => {
      // Called when the test suite reaches completion
    },
  });

  const {
    state: roomState,
    creating,
    error: roomError,
    createRoom,
    joinRoom,
    leaveRoom,
    submitScan,
    skipItem,
    stepItem,
    reportTimeout,
    newRound,
    fetchItems,
  } = testRoom;

  // Notify parent if scanner is active (only hide header, footer, and nav while scanner view is open)
  useEffect(() => {
    const isScannerActive = Boolean(roomId && mode === "scanner" && !roomState?.isCompleted);
    onTestActiveChange?.(isScannerActive);
    return () => {
      onTestActiveChange?.(false);
    };
  }, [roomId, mode, roomState?.isCompleted, onTestActiveChange]);

  // Auto-join room when joined/loaded or hardware updates (ONLY for mobile scanners)
  useEffect(() => {
    if (mode === "scanner" && roomId && deviceId && hardware) {
      joinRoom(hardware);
    }
  }, [mode, roomId, deviceId, hardware, joinRoom]);

  // Handle custom device name update
  const handleUpdateDeviceName = useCallback(
    (newName: string) => {
      setCustomDeviceName(newName);
      setHardware((prev) => {
        if (!prev) return prev;
        const updated = { ...prev, deviceName: newName };
        if (mode === "scanner" && roomId && deviceId) {
          joinRoom(updated);
        }
        return updated;
      });
    },
    [mode, roomId, deviceId, joinRoom]
  );

  // Handle suite creation (host screen)
  const handleCreateRoom = useCallback(
    async (suiteType: string) => {
      setMode("host");
      const newId = await createRoom(suiteType);
      if (newId) {
        setRoomId(newId);
        if (typeof window !== "undefined") {
          sessionStorage.setItem(`pacc_role_${newId}`, "host");
          const url = new URL(window.location.href);
          url.searchParams.set("room", newId);
          url.searchParams.set("mode", "host");
          window.history.replaceState({}, "", url.toString());
        }
      }
    },
    [createRoom]
  );

  // Handle manual room join (with explicit host / scanner role)
  const handleJoinRoom = useCallback(
    (code: string, role: "host" | "scanner" = "scanner") => {
      setMode(role);
      setRoomId(code);
      if (typeof window !== "undefined") {
        sessionStorage.setItem(`pacc_role_${code}`, role);
        const url = new URL(window.location.href);
        url.searchParams.set("room", code);
        url.searchParams.set("mode", role);
        window.history.replaceState({}, "", url.toString());
      }
    },
    []
  );

  // Handle room exit
  const handleLeaveRoom = useCallback(() => {
    if (roomId && typeof window !== "undefined") {
      sessionStorage.removeItem(`pacc_role_${roomId}`);
    }
    leaveRoom();
    setRoomId("");
    if (camera.active) camera.stop();
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.searchParams.delete("room");
      url.searchParams.delete("join");
      url.searchParams.delete("mode");
      window.history.replaceState({}, "", url.toString());
    }
  }, [roomId, leaveRoom, camera]);

  // ── Render Views ──────────────────────────────────────────────────────────

  // 1. Setup / Room Launcher View (No room joined)
  if (!roomId || !roomState) {
    return (
      <RoomSetupView
        mode={mode}
        setMode={setMode}
        onCreateRoom={handleCreateRoom}
        onJoinRoom={handleJoinRoom}
        isCreating={creating}
        error={roomError}
        hardware={hardware}
        onUpdateDeviceName={handleUpdateDeviceName}
      />
    );
  }

  // 2. Suite Completed / Victory Screen
  if (roomState.isCompleted) {
    return (
      <SuiteCompletedView
        roomState={roomState}
        onNewRound={newRound}
        onResetToSetup={handleLeaveRoom}
      />
    );
  }

  // 3. Mobile Optical Scanner View
  if (mode === "scanner") {
    return (
      <ScannerView
        roomState={roomState}
        camera={camera}
        onSubmitScan={submitScan}
        onSkip={skipItem}
        onStep={stepItem}
        onTimeout={reportTimeout}
        onLeaveRoom={handleLeaveRoom}
        soundEnabled={soundEnabled}
        setSoundEnabled={setSoundEnabled}
        hardwarePayload={hardware ?? {}}
        onFetchItems={fetchItems}
      />
    );
  }

  // 4. Host Desktop Barcode Theater View
  return (
    <HostTheaterView
      roomState={roomState}
      onStep={stepItem}
      onSkip={skipItem}
      onLeaveRoom={handleLeaveRoom}
      soundEnabled={soundEnabled}
      setSoundEnabled={setSoundEnabled}
      autoAdvance={autoAdvance}
      setAutoAdvance={setAutoAdvance}
      onFetchItems={fetchItems}
    />
  );
}
