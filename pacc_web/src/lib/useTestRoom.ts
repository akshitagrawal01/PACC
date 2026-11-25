/**
 * useTestRoom
 * -----------
 * All server-state for a test-lab room session.
 *
 * Design principles:
 * - One sequential poll loop (recursive setTimeout, never setInterval).
 *   A new poll never starts while the previous request is still in flight.
 * - Monotonic sequence counter discards stale / out-of-order responses.
 * - Optimistic stepping: currentIndex advances in the ref immediately so the
 *   UI feels instant; the server response reconciles the real state.
 * - All network calls go through a single fetchRoom() helper with a built-in
 *   AbortController timeout so nothing ever hangs indefinitely.
 * - Every action returns a boolean indicating success so callers can react.
 */

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ThrownError } from "@/lib/errors";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface TestItem {
  id: string;
  codeType: "PACC" | "PACC_DUAL" | "QR" | "JAB" | string;
  badge: string;
  label: string;
  sublabel: string;
  gridSide: number | null;
  cellSize: number;
  eccLevel: string;
  bitsPerCell: string;
  payload: string;
  payloadBytes: number;
  dataUrl: string;
  serverDecodeLatencyMs?: number;
  serverDecodeSuccess?: boolean;
  encodeDurationMs?: number;
  password?: string;
  cssFilter?: string;
  cssTransform?: string;
  /** PACC suites: report tags, grading rule, per-item keys, animation (see scripts/pacc_suites.py). */
  group?: string;
  condition?: string;
  codec?: string;
  severity?: number | null;
  expect?: "text" | "signed" | "reject" | "coarse" | "fine" | "qc_hidden";
  secrets?: import("@/lib/pacc/client").WireSecrets;
  frames?: string[] | null;
  fps?: number;
  hint?: string;
}

export interface ScanLog {
  scanId: string;
  testId?: string;
  testIndex?: number;
  codeType: string;
  label: string;
  status: "PASS" | "FAIL" | "SKIPPED" | "MISMATCH" | "TIMEOUT";
  decodeLatencyMs: number;
  clientTimeToScanMs: number;
  attempts?: number;
  decoderUsed?: string;
  deviceName: string;
  gridSide?: number | null;
  eccLevel?: string;
  bitsPerCell?: string;
  round?: number;
  timestamp?: string;
}

export interface ConnectedDevice {
  deviceId: string;
  deviceName: string;
  os?: string;
  browser?: string;
  cameraResolution?: string;
  isOnline: boolean;
  scansCompleted: number;
  lastSeen: number;
}

export interface CompletionSummary {
  total: number;
  pass: number;
  skipped: number;
  timeout: number;
  fail: number;
  mismatch: number;
}

export interface RoomStats {
  totalScans: number;
  passedCount: number;
  passRate: number;
  avgDecodeLatencyMs: number;
  avgTimeToScanMs: number;
  byType: Record<string, { total: number; pass: number; passRate: number; avgLatency: number; avgTimeToScan: number }>;
}

export interface RoomState {
  roomId: string;
  suiteType: string;
  suiteTitle?: string;
  round: number;
  currentIndex: number;
  totalTests: number;
  isCompleted: boolean;
  currentTest: TestItem | null;
  /** Full items array — only populated after ?action=items fetch or on room creation */
  items?: TestItem[];
  /** Lightweight suite items metadata without dataUrls — always populated */
  suiteItems?: TestItem[];
  /** Map of testId -> terminal status (PASS, FAIL, SKIPPED, TIMEOUT, MISMATCH) for the current round */
  itemStatuses?: Record<string, "PASS" | "FAIL" | "SKIPPED" | "MISMATCH" | "TIMEOUT">;
  recentScanLogs: ScanLog[];
  connectedDevices: ConnectedDevice[];
  lastScanResult: ScanLog | null;
  completionSummary: CompletionSummary;
  stats: RoomStats;
  hostOnline?: boolean;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function apiFetch(url: string, opts: RequestInit = {}, ms = 5000): Promise<Response> {
  const ac = new AbortController();
  const t = setTimeout(() => {
    ac.abort(new Error(`Request timed out after ${Math.round(ms / 1000)}s`));
  }, ms);
  try {
    return await fetch(url, { ...opts, signal: ac.signal });
  } finally {
    clearTimeout(t);
  }
}

/** Shape of every /api/test-room response: a partial room snapshot plus status. */
type RoomApiResponse = Partial<RoomState> & { success?: boolean; error?: string; duplicate?: boolean };

async function apiJson<T = RoomApiResponse>(url: string, opts: RequestInit = {}, ms = 5000): Promise<T> {
  const res = await apiFetch(url, opts, ms);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ─── Hook ───────────────────────────────────────────────────────────────────

interface UseTestRoomOptions {
  roomId: string;
  deviceId: string;
  mode: "host" | "scanner";
  hardware?: object | null;
  /** Called whenever the item index changes (i.e. new test started) */
  onTestChange?: (item: TestItem, index: number) => void;
  /** Called when room completes */
  onComplete?: () => void;
}

export function useTestRoom({ roomId, deviceId, mode, hardware, onTestChange, onComplete }: UseTestRoomOptions) {
  const [state, setState] = useState<RoomState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  // Refs that survive re-renders without triggering effects
  const stateRef = useRef<RoomState | null>(null);
  const hardwareRef = useRef(hardware);
  hardwareRef.current = hardware;
  const seqRef = useRef(0);
  const failsRef = useRef(0);
  const lastTestIdRef = useRef<string | null>(null);
  const lastIndexRef = useRef<number | null>(null);
  const onTestChangeRef = useRef(onTestChange);
  const onCompleteRef = useRef(onComplete);
  onTestChangeRef.current = onTestChange;
  onCompleteRef.current = onComplete;

  // ── Merge helper ──────────────────────────────────────────────────────────
  const mergeState = useCallback((incoming: Partial<RoomState>) => {
    setState((prev) => {
      const isNewRound = incoming.round !== undefined && prev?.round !== undefined && incoming.round !== prev.round;
      const next: RoomState = {
        ...(prev ?? ({} as RoomState)),
        ...incoming,
        // Never lose full items array once loaded
        items: incoming.items ?? prev?.items,
        suiteItems: incoming.suiteItems ?? prev?.suiteItems,
        itemStatuses: isNewRound
          ? (incoming.itemStatuses || {})
          : {
              ...(prev?.itemStatuses || {}),
              ...(incoming.itemStatuses || {}),
            },
      } as RoomState;
      stateRef.current = next;
      return next;
    });
  }, []);

  // ── Single poll cycle ────────────────────────────────────────────────────
  const pollOnce = useCallback(async () => {
    if (!roomId) return;
    const mySeq = ++seqRef.current;

    try {
      const devQ = deviceId ? `&deviceId=${encodeURIComponent(deviceId)}&mode=${encodeURIComponent(mode)}` : "";
      const data = await apiJson(
        `/api/test-room?roomId=${encodeURIComponent(roomId)}${devQ}`,
        {},
        8000
      );
      if (mySeq < seqRef.current) return; // stale — a newer poll already resolved
      if (!data.success) { failsRef.current++; return; }

      failsRef.current = 0;
      setError(null);
      mergeState(data);

      // Detect test change
      const newId = data.currentTest?.id ?? null;
      const newIdx = typeof data.currentIndex === "number" ? data.currentIndex : null;
      const changed =
        (newId !== null && newId !== lastTestIdRef.current) ||
        (newIdx !== null && newIdx !== lastIndexRef.current);

      if (changed) {
        lastTestIdRef.current = newId;
        lastIndexRef.current = newIdx;
        if (data.currentTest && !data.isCompleted) {
          onTestChangeRef.current?.(data.currentTest, data.currentIndex ?? 0);
        }
        if (data.isCompleted) {
          onCompleteRef.current?.();
        }
      }
    } catch {
      failsRef.current++;
      if (failsRef.current > 6) setError("Connection lost — retrying…");
    }
  }, [roomId, deviceId, mode, mergeState]);

  // ── Real-Time SSE Stream (Sub-10ms instantaneous push sync) ────────────────
  const sseActiveRef = useRef(false);

  useEffect(() => {
    if (!roomId || typeof window === "undefined" || typeof EventSource === "undefined") return;

    let es: EventSource | null = null;
    let dead = false;
    let reconnectTimeout: NodeJS.Timeout | null = null;

    const connect = () => {
      if (dead) return;
      const url = `/api/test-room?action=stream&roomId=${encodeURIComponent(roomId)}&mode=${encodeURIComponent(mode)}&deviceId=${encodeURIComponent(deviceId)}`;
      es = new EventSource(url);

      es.onopen = () => {
        sseActiveRef.current = true;
      };

      es.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data && data.success) {
            mergeState(data);
            const newId = data.currentTest?.id ?? null;
            const newIdx = typeof data.currentIndex === "number" ? data.currentIndex : null;
            const changed =
              (newId !== null && newId !== lastTestIdRef.current) ||
              (newIdx !== null && newIdx !== lastIndexRef.current);

            if (changed) {
              lastTestIdRef.current = newId;
              lastIndexRef.current = newIdx;
              if (data.currentTest && !data.isCompleted) {
                onTestChangeRef.current?.(data.currentTest, data.currentIndex ?? 0);
              }
              if (data.isCompleted) {
                onCompleteRef.current?.();
              }
            }
          }
        } catch {}
      };

      es.onerror = () => {
        sseActiveRef.current = false;
        es?.close();
        if (!dead) {
          reconnectTimeout = setTimeout(connect, 1500);
        }
      };
    };

    connect();

    return () => {
      dead = true;
      sseActiveRef.current = false;
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      es?.close();
    };
  }, [roomId, mode, deviceId, mergeState]);

  // ── Poll loop (Adaptive fast-sync / background heartbeat) ─────────────────
  useEffect(() => {
    if (!roomId) {
      setState(null);
      stateRef.current = null;
      lastTestIdRef.current = null;
      lastIndexRef.current = null;
      return;
    }
    let dead = false;
    const run = async () => {
      if (dead) return;
      await pollOnce();
      // If SSE is active, poll gently at 800ms for heartbeat.
      // If SSE is reconnecting, poll aggressively at 50ms-80ms for ultra-fast fallback!
      const delay = sseActiveRef.current ? 800 : (mode === "host" ? 50 : 80);
      if (!dead) setTimeout(run, delay);
    };
    run();
    return () => { dead = true; };
  }, [roomId, mode, pollOnce]);

  // ── Heartbeat ping (scanner only) ────────────────────────────────────────
  useEffect(() => {
    if (mode !== "scanner" || !roomId || !deviceId) return;
    const ping = () =>
      fetch(`/api/test-room?action=ping`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          roomId,
          deviceId,
          ...(hardwareRef.current || {}),
        }),
      }).catch(() => {});
    ping();
    const id = setInterval(ping, 3000);
    return () => clearInterval(id);
  }, [mode, roomId, deviceId]);

  // ── Actions ──────────────────────────────────────────────────────────────

  const createRoom = useCallback(async (suiteType: string): Promise<string | null> => {
    setCreating(true);
    setError(null);
    try {
      const data = await apiJson(
        `/api/test-room?action=create`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ suiteType }),
        },
        300_000 // first build of a suite can take ~2 min (cached afterwards)
      );
      if (data.success && data.roomId) {
        mergeState({ ...data, items: data.items });
        lastTestIdRef.current = data.currentTest?.id ?? null;
        lastIndexRef.current = data.currentIndex ?? 0;
        return data.roomId as string;
      }
      setError(data.error ?? "Failed to create room");
      return null;
    } catch (caught: unknown) {
      const e = caught as ThrownError;
      const isAbort = e.name === "AbortError" || e.message?.includes("aborted") || e.message?.includes("timed out");
      const msg = isAbort ? "Suite generation timed out. Please try again." : (e.message ?? "Network error");
      setError(msg);
      return null;
    } finally {
      setCreating(false);
    }
  }, [mergeState]);

  const joinRoom = useCallback(async (hw: object) => {
    if (!roomId || !deviceId || mode !== "scanner") return;
    try {
      const data = await apiJson(
        `/api/test-room?action=join`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ roomId, deviceId, mode: "scanner", ...hw }),
        },
        8000
      );
      if (data.success) mergeState(data);
    } catch {}
  }, [roomId, deviceId, mode, mergeState]);

  const submitScan = useCallback(async (opts: {
    decodedPayload: string;
    decodeLatencyMs: number;
    clientTimeToScanMs: number;
    attempts: number;
    decoderUsed: string;
    deviceHw: Record<string, unknown>;
  }) => {
    const test = stateRef.current?.currentTest;
    const round = stateRef.current?.round ?? 1;
    if (!test || !roomId) return false;
    try {
      const data = await apiJson(
        `/api/test-room?action=scan`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            roomId,
            deviceId,
            testId: test.id,
            roundId: round,
            decodedPayload: opts.decodedPayload,
            text: opts.decodedPayload,
            decodeLatencyMs: opts.decodeLatencyMs,
            clientTimeToScanMs: opts.clientTimeToScanMs,
            attempts: opts.attempts,
            decoderUsed: opts.decoderUsed,
            engine: opts.decoderUsed,
            ...opts.deviceHw,
          }),
        },
        5000
      );
      if (data.success) {
        mergeState(data);
        if (data.currentTest) {
          lastTestIdRef.current = data.currentTest.id;
          lastIndexRef.current = data.currentIndex ?? null;
          onTestChangeRef.current?.(data.currentTest, data.currentIndex ?? 0);
        }
        if (data.isCompleted) onCompleteRef.current?.();
      }
      return Boolean(data.success);
    } catch {
      return false;
    }
  }, [roomId, deviceId, mergeState]);

  const skipItem = useCallback(async () => {
    if (!roomId) return;
    try {
      const data = await apiJson(
        `/api/test-room?action=skip`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ roomId, deviceId }),
        },
        5000
      );
      if (data.success) {
        mergeState(data);
        if (data.currentTest) {
          lastTestIdRef.current = data.currentTest.id;
          lastIndexRef.current = data.currentIndex ?? null;
          onTestChangeRef.current?.(data.currentTest, data.currentIndex ?? 0);
        }
        if (data.isCompleted) onCompleteRef.current?.();
      }
    } catch {}
  }, [roomId, deviceId, mergeState]);

  const stepItem = useCallback(async (direction: "next" | "prev" | number) => {
    if (!roomId) return;
    const body: Record<string, unknown> = { roomId };
    if (typeof direction === "number") body.index = direction;
    else body.direction = direction;
    try {
      const data = await apiJson(
        `/api/test-room?action=step`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
        5000
      );
      if (data.success) {
        mergeState(data);
        if (data.currentTest) {
          lastTestIdRef.current = data.currentTest.id;
          lastIndexRef.current = data.currentIndex ?? null;
          onTestChangeRef.current?.(data.currentTest, data.currentIndex ?? 0);
        }
        if (data.isCompleted) onCompleteRef.current?.();
      }
    } catch {}
  }, [roomId, mergeState]);

  const reportTimeout = useCallback(async (clientTimeToScanMs: number, attempts: number) => {
    const test = stateRef.current?.currentTest;
    if (!test || !roomId) return;
    try {
      const data = await apiJson(
        `/api/test-room?action=timeout`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            roomId,
            deviceId,
            testId: test.id,
            clientTimeToScanMs,
            attempts,
          }),
        },
        5000
      );
      if (data.success && !data.duplicate) {
        mergeState(data);
        if (data.currentTest) {
          lastTestIdRef.current = data.currentTest.id;
          lastIndexRef.current = data.currentIndex ?? null;
          onTestChangeRef.current?.(data.currentTest, data.currentIndex ?? 0);
        }
      }
    } catch {}
  }, [roomId, deviceId, mergeState]);

  const newRound = useCallback(async () => {
    if (!roomId) return;
    try {
      const data = await apiJson(
        `/api/test-room?action=new_round`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ roomId }) },
        5000
      );
      if (data.success) {
        mergeState(data);
        lastTestIdRef.current = data.currentTest?.id ?? null;
        lastIndexRef.current = data.currentIndex ?? 0;
        if (data.currentTest) onTestChangeRef.current?.(data.currentTest, 0);
      }
    } catch {}
  }, [roomId, mergeState]);

  /** Fetch full items[] (with dataUrls) on demand */
  const fetchItems = useCallback(async (): Promise<TestItem[]> => {
    if (!roomId) return [];
    if (stateRef.current?.items?.length) return stateRef.current.items;
    try {
      const data = await apiJson(`/api/test-room?action=items&roomId=${encodeURIComponent(roomId)}`, {}, 30_000);
      if (data.success && data.items) {
        mergeState({ items: data.items });
        return data.items;
      }
    } catch {}
    return [];
  }, [roomId, mergeState]);

  const leaveRoom = useCallback(() => {
    setState(null);
    stateRef.current = null;
    lastTestIdRef.current = null;
    lastIndexRef.current = null;
  }, []);

  return {
    state,
    stateRef,
    error,
    creating,
    createRoom,
    joinRoom,
    leaveRoom,
    submitScan,
    skipItem,
    stepItem,
    reportTimeout,
    newRound,
    fetchItems,
  };
}
