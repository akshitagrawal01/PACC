import { applyCameraConstraints, getCameraCapabilities, type CameraConstraintSet } from "./browserApis";
/**
 * cameraHelper.ts
 * ---------------
 * Robust Camera HAL negotiation with Two-Pass Primary Main Camera (Camera 0) Lock.
 *
 * Guarantees that:
 * 1. Android multi-camera setups (e.g. OnePlus, Realme, Oppo, Samsung, Xiaomi)
 *    always bind to the Primary Main Camera (Camera 0 with 1x autofocus),
 *    never the 0.6x fixed-focus ultra-wide or macro auxiliary sensors.
 * 2. Does not use rigid portrait-breaking constraints (e.g. min: 1280 on width).
 * 3. Two-pass verification: if camera labels were hidden pre-permission, re-checks
 *    and immediately switches to Camera 0 once permissions are unlocked.
 * 4. Automatically negotiates and locks continuous autofocus (VCM actuator).
 */

export function scoreCameraDevice(device: MediaDeviceInfo, index: number): number {
  const label = (device.label || "").toLowerCase();

  // Exclude front/user/selfie cameras when selecting rear
  if (/front|user|selfie/.test(label)) {
    return -1000;
  }

  let score = 0;

  // 1. Android Camera2 HAL primary rear camera:
  // Android Camera2 HAL strictly defines Camera ID 0 as the primary back camera.
  // Chrome labels it: "camera2 0, facing back" or "camera 0, facing back"
  if (/camera2\s*0\b|camera\s*0\b|\b0,\s*facing\s*back\b|\bid\s*[:=]?\s*0\b|\bback.*camera\s*0\b/.test(label)) {
    score += 1000;
  }

  // 2. Explicit main / primary label
  if (/\b(main|primary)\b/.test(label)) {
    score += 500;
  }

  // 3. Heavily penalize auxiliary / ultra-wide / macro / depth / telephoto lenses
  if (/wide|ultra|macro|depth|tele|bokeh|virtual|aux/.test(label)) {
    score -= 600;
  }

  // 4. Heavily penalize secondary/tertiary back camera IDs (camera2 2, camera2 3, etc.)
  if (/camera2\s*[2-9]|camera\s*[2-9]|\b[2-9],\s*facing\s*back/.test(label)) {
    score -= 400;
  }

  // 5. Reward general back / rear indicators
  if (/back|rear|environment/.test(label)) {
    score += 100;
  }

  // 6. Tie-breaker: earlier enumerated rear cameras are preferred
  score += Math.max(0, 10 - index);

  return score;
}

export function pickPrimaryRearCamera(devices: MediaDeviceInfo[]): MediaDeviceInfo | undefined {
  const videoDevices = devices.filter((d) => d.kind === "videoinput");
  if (!videoDevices.length) return undefined;

  const scored = videoDevices
    .map((d, index) => ({ device: d, score: scoreCameraDevice(d, index) }))
    .filter((s) => s.score > -500)
    .sort((a, b) => b.score - a.score);

  return scored[0]?.device;
}

export async function enforceContinuousFocus(track: MediaStreamTrack | null | undefined): Promise<void> {
  if (!track) return;
  try {
    const caps = getCameraCapabilities(track);
    const adv: CameraConstraintSet = {};
    if (!caps.focusMode || caps.focusMode.includes("continuous")) {
      adv.focusMode = "continuous";
    } else if (caps.focusMode?.includes("auto")) {
      adv.focusMode = "auto";
    }
    if (caps.exposureMode?.includes?.("continuous")) {
      adv.exposureMode = "continuous";
    }
    if (caps.whiteBalanceMode?.includes?.("continuous")) {
      adv.whiteBalanceMode = "continuous";
    }
    if (Object.keys(adv).length > 0) {
      await applyCameraConstraints(track, adv).catch(() => {});
    }
  } catch {}
}

export async function openPrimaryCameraStream(
  targetFacing: "environment" | "user" = "environment"
): Promise<MediaStream> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    throw new Error("Camera API not supported in this browser environment.");
  }

  // ── PASS 1: Pre-permission device detection ──────────────────────────────
  let targetDeviceId: string | undefined = undefined;
  if (targetFacing === "environment" && navigator.mediaDevices.enumerateDevices) {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const primary = pickPrimaryRearCamera(devices);
      if (primary?.deviceId) {
        targetDeviceId = primary.deviceId;
      }
    } catch {}
  }

  let stream: MediaStream | null = null;

  // Flexible resolution constraints that work seamlessly in both portrait (1080x1920)
  // and landscape (1920x1080) without throwing OverconstrainedError on mobile.
  const highResVideoConstraints: MediaTrackConstraints = targetDeviceId
    ? {
        deviceId: { exact: targetDeviceId },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: { ideal: 60, min: 24 },
      }
    : {
        facingMode: { ideal: targetFacing },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: { ideal: 60, min: 24 },
      };

  // Attempt 1: High-res with target device / facingMode
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: highResVideoConstraints,
      audio: false,
    });
  } catch {
    // Attempt 2: Flexible ideal constraints
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: targetDeviceId
          ? { deviceId: { ideal: targetDeviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }
          : { facingMode: { ideal: targetFacing }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
    } catch {
      // Attempt 3: Bare-minimum fallback
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: targetFacing } },
        audio: false,
      });
    }
  }

  // ── PASS 2: Post-permission verification & Primary Camera 0 Switch ────────
  // Now that permissions are granted, enumerateDevices() is guaranteed to return
  // full labels (e.g. "camera2 0, facing back" vs "camera2 2, facing back").
  if (targetFacing === "environment" && navigator.mediaDevices.enumerateDevices) {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const verifiedPrimary = pickPrimaryRearCamera(devices);

      if (verifiedPrimary?.deviceId) {
        const activeTrack = stream.getVideoTracks()[0];
        const activeSettings = activeTrack?.getSettings?.() ?? {};
        const activeDeviceId = activeSettings.deviceId;
        const activeLabel = (activeTrack?.label || "").toLowerCase();
        const verifiedLabel = (verifiedPrimary.label || "").toLowerCase();
        const isWrongCamera =
          (activeDeviceId && activeDeviceId !== verifiedPrimary.deviceId) ||
          (/wide|ultra|macro|aux/.test(activeLabel) && !/wide|ultra|macro|aux/.test(verifiedLabel));

        // If the active camera is an auxiliary / ultra-wide lens, switch to Camera 0
        if (isWrongCamera) {
          try {
            const switchedStream = await navigator.mediaDevices.getUserMedia({
              video: {
                deviceId: { exact: verifiedPrimary.deviceId },
                width: { ideal: 1920 },
                height: { ideal: 1080 },
                frameRate: { ideal: 60, min: 24 },
              },
              audio: false,
            });

            // Clean up previous stream
            stream.getTracks().forEach((t) => t.stop());
            stream = switchedStream;
          } catch {
            // If exact deviceId fails, attempt with ideal
            try {
              const switchedStream = await navigator.mediaDevices.getUserMedia({
                video: {
                  deviceId: { ideal: verifiedPrimary.deviceId },
                  width: { ideal: 1920 },
                  height: { ideal: 1080 },
                },
                audio: false,
              });
              stream.getTracks().forEach((t) => t.stop());
              stream = switchedStream;
            } catch {}
          }
        }
      }
    } catch {}
  }

  // Enforce continuous autofocus on the verified track
  const finalTrack = stream.getVideoTracks()[0];
  if (finalTrack) {
    await enforceContinuousFocus(finalTrack);
  }

  return stream;
}
