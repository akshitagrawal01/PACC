/**
 * Typings for browser features that Chromium/WebKit expose but lib.dom does not
 * declare (camera zoom/torch/focus controls, prefixed AudioContext, UA-CH).
 * Everything is optional: support varies by device and browser.
 */

export interface CameraCapabilities extends MediaTrackCapabilities {
  zoom?: { min?: number; max?: number; step?: number };
  torch?: boolean;
  focusMode?: string[];
  exposureMode?: string[];
  whiteBalanceMode?: string[];
}

export interface CameraConstraintSet extends MediaTrackConstraintSet {
  zoom?: number;
  torch?: boolean;
  focusMode?: string;
  exposureMode?: string;
  whiteBalanceMode?: string;
  pointsOfInterest?: { x: number; y: number }[];
}

export function getCameraCapabilities(track: MediaStreamTrack | null | undefined): CameraCapabilities {
  if (!track || typeof track.getCapabilities !== "function") return {};
  try {
    return track.getCapabilities() as CameraCapabilities;
  } catch {
    return {};
  }
}

export function applyCameraConstraints(track: MediaStreamTrack, set: CameraConstraintSet): Promise<void> {
  return track.applyConstraints({ advanced: [set as MediaTrackConstraintSet] });
}

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}

/** AudioContext constructor, including the prefixed one older Safari ships. */
export function getAudioContextCtor(): typeof AudioContext | undefined {
  if (typeof window === "undefined") return undefined;
  return window.AudioContext || window.webkitAudioContext;
}

/** Navigator fields used for device fingerprinting that lib.dom omits. */
export interface NavigatorExtras {
  deviceMemory?: number;
  userAgentData?: {
    platform?: string;
    mobile?: boolean;
    brands?: { brand: string; version: string }[];
    getHighEntropyValues?: (hints: string[]) => Promise<{
      model?: string;
      platform?: string;
      platformVersion?: string;
      architecture?: string;
      bitness?: string;
      [hint: string]: unknown;
    }>;
  };
  connection?: { effectiveType?: string; downlink?: number; rtt?: number };
}

export function navigatorExtras(): Navigator & NavigatorExtras {
  return navigator as Navigator & NavigatorExtras;
}
