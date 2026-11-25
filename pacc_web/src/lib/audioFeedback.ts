import { getAudioContextCtor } from "./browserApis";
/**
 * Audio & Haptic Feedback Engine
 * --------------------------------
 * Web Audio API synthesizer for instant auditory feedback during scanning,
 * with graceful fallback and mobile vibration support.
 */

let _audioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  try {
    if (!_audioCtx) {
      const AudioCtx = getAudioContextCtor();
      if (AudioCtx) _audioCtx = new AudioCtx();
    }
    if (_audioCtx && _audioCtx.state === "suspended") {
      _audioCtx.resume().catch(() => {});
    }
    return _audioCtx;
  } catch {
    return null;
  }
}

export type SoundEffect = "success" | "skip" | "timeout" | "mismatch" | "step" | "victory";

export function playSound(effect: SoundEffect, enabled: boolean = true) {
  if (!enabled || typeof window === "undefined") return;

  // Haptic feedback
  if ("vibrate" in navigator) {
    try {
      if (effect === "success") {
        navigator.vibrate([60]);
      } else if (effect === "timeout" || effect === "mismatch") {
        navigator.vibrate([100, 50, 100]);
      } else if (effect === "victory") {
        navigator.vibrate([100, 50, 100, 50, 300]);
      }
    } catch {}
  }

  const ctx = getAudioContext();
  if (!ctx) return;

  try {
    const now = ctx.currentTime;

    if (effect === "success") {
      // Crisp 2-tone upward chime (880Hz -> 1174Hz)
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(880, now);
      osc.frequency.exponentialRampToValueAtTime(1174.66, now + 0.1);
      gain.gain.setValueAtTime(0.18, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.24);
    } else if (effect === "timeout" || effect === "mismatch") {
      // Low descending warning thud (320Hz -> 180Hz)
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "triangle";
      osc.frequency.setValueAtTime(320, now);
      osc.frequency.exponentialRampToValueAtTime(180, now + 0.16);
      gain.gain.setValueAtTime(0.2, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.26);
    } else if (effect === "step" || effect === "skip") {
      // Soft mechanical click
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(540, now);
      gain.gain.setValueAtTime(0.08, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.05);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.06);
    } else if (effect === "victory") {
      // Celebratory 4-tone arpeggio (C5 - E5 - G5 - C6)
      [523.25, 659.25, 783.99, 1046.5].forEach((freq, idx) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "triangle";
        osc.frequency.setValueAtTime(freq, now + idx * 0.11);
        gain.gain.setValueAtTime(0.001, now + idx * 0.11);
        gain.gain.exponentialRampToValueAtTime(0.16, now + idx * 0.11 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + idx * 0.11 + 0.35);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now + idx * 0.11);
        osc.stop(now + idx * 0.11 + 0.38);
      });
    }
  } catch {}
}
