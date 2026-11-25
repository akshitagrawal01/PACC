"use client";

import React, { useState, useEffect, useRef } from "react";
import { X, Play, Square, CheckCircle2, XCircle, Zap } from "lucide-react";
import { TestItem } from "@/lib/useTestRoom";
import { decodePacc } from "@/lib/pacc/client";
import { decodeWithZXing } from "@/lib/zxingDecoder";
import { errorMessage } from "@/lib/errors";

interface BenchmarkResult {
  id: string;
  label: string;
  codeType: string;
  success: boolean;
  latencyMs: number;
  engine: string;
  error?: string;
}

interface ClientBenchmarkModalProps {
  isOpen: boolean;
  onClose: () => void;
  items: TestItem[];
  roomId: string;
}

export function ClientBenchmarkModal({
  isOpen,
  onClose,
  items,
}: ClientBenchmarkModalProps) {
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [results, setResults] = useState<BenchmarkResult[]>([]);
  const abortRef = useRef(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!isOpen) {
      abortRef.current = true;
      setRunning(false);
      setProgress(0);
      setResults([]);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const runBenchmark = async () => {
    if (running || !items.length) return;
    setRunning(true);
    setProgress(0);
    setResults([]);
    abortRef.current = false;

    if (!canvasRef.current) {
      canvasRef.current = document.createElement("canvas");
    }
    const canvas = canvasRef.current;

    const collected: BenchmarkResult[] = [];

    for (let i = 0; i < items.length; i++) {
      if (abortRef.current) break;

      // 1. Cooperative yield to event loop so browser stays responsive and UI paints
      await new Promise((resolve) => setTimeout(resolve, 12));
      if (abortRef.current) break;

      const item = items[i];

      if (!item.dataUrl) {
        collected.push({
          id: item.id,
          label: item.label,
          codeType: item.codeType,
          success: false,
          latencyMs: 0,
          engine: "None",
          error: "No image payload",
        });
        setResults([...collected]);
        setProgress(Math.round(((i + 1) / items.length) * 100));
        continue;
      }

      const t0 = performance.now();
      try {
        const img = new Image();
        img.crossOrigin = "anonymous";
        await new Promise<void>((resolve, reject) => {
          img.onload = () => resolve();
          img.onerror = () => reject(new Error("Image failed to load"));
          img.src = item.dataUrl;
        });

        const vw = img.naturalWidth || img.width || 300;
        const vh = img.naturalHeight || img.height || 300;
        if (canvas.width !== vw || canvas.height !== vh) {
          canvas.width = vw;
          canvas.height = vh;
        }

        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) throw new Error("Could not acquire 2D canvas context");
        ctx.clearRect(0, 0, vw, vh);
        ctx.drawImage(img, 0, 0);
        const imgData = ctx.getImageData(0, 0, vw, vh);

        // Run decode with 750ms timeout guard to prevent locking the browser thread
        const decodeTask = (async (): Promise<BenchmarkResult> => {
          if (item.codeType === "QR") {
            const zx = await decodeWithZXing(imgData, ["QRCode"]);
            const elapsed = Math.round(performance.now() - t0);
            const match = Boolean(zx?.text && zx.text.trim() === item.payload.trim());
            return {
              id: item.id,
              label: item.label,
              codeType: item.codeType,
              success: match,
              latencyMs: elapsed,
              engine: "ZXing-WASM",
              error: match ? undefined : zx?.text ? "Payload mismatch" : "Unrecognized",
            };
          } else {
            const res = await decodePacc(imgData);
            const elapsed = Math.round(performance.now() - t0);
            let text = "";
            if (res?.ok && res.payload) {
              try {
                text = new TextDecoder().decode(res.payload);
              } catch {
                text = "";
              }
            }
            const match = Boolean(res?.ok && text.trim() === item.payload.trim());
            return {
              id: item.id,
              label: item.label,
              codeType: item.codeType,
              success: match,
              latencyMs: elapsed,
              engine: "PACC Native",
              error: match ? undefined : res?.error || "Decode failed",
            };
          }
        })();

        const itemResult = await Promise.race([
          decodeTask,
          new Promise<BenchmarkResult>((resolve) =>
            setTimeout(
              () =>
                resolve({
                  id: item.id,
                  label: item.label,
                  codeType: item.codeType,
                  success: false,
                  latencyMs: Math.round(performance.now() - t0),
                  engine: item.codeType === "QR" ? "ZXing-WASM" : "PACC Native",
                  error: "Timeout (>750ms)",
                }),
              750
            )
          ),
        ]);

        collected.push(itemResult);
      } catch (err: unknown) {
        collected.push({
          id: item.id,
          label: item.label,
          codeType: item.codeType,
          success: false,
          latencyMs: Math.round(performance.now() - t0),
          engine: item.codeType === "QR" ? "ZXing-WASM" : "PACC Native",
          error: errorMessage(err) || "Error",
        });
      }

      setResults([...collected]);
      setProgress(Math.round(((i + 1) / items.length) * 100));
    }

    setRunning(false);
  };

  const passCount = results.filter((r) => r.success).length;
  const avgLatency =
    results.length > 0
      ? Math.round(results.reduce((acc, r) => acc + r.latencyMs, 0) / results.length)
      : 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
      <div
        className="w-full max-w-2xl max-h-[85vh] flex flex-col rounded-2xl shadow-2xl overflow-hidden animate-in zoom-in-95 duration-200"
        style={{ background: "var(--surface)", border: "1px solid var(--border-mid)" }}
      >
        {/* Header */}
        <div className="p-4 border-b flex items-center justify-between" style={{ borderColor: "var(--border)" }}>
          <div className="flex items-center gap-2.5">
            <div
              className="w-8 h-8 rounded-lg flex items-center justify-center"
              style={{ background: "var(--accent-light)", color: "var(--accent)" }}
            >
              <Zap className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-stone-900">Synthetic In-Memory Benchmark</h3>
              <p className="text-xs text-stone-500">Benchmark raw JS/WASM decode speed on ideal bitmap frames</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl hover:bg-stone-100 text-stone-600 hover:text-stone-900 transition text-xs font-semibold border border-stone-200 cursor-pointer"
            title="Close Benchmark"
          >
            <X className="w-4 h-4" />
            <span>Close</span>
          </button>
        </div>

        {/* Controls & KPIs */}
        <div className="p-4 border-b bg-stone-50 space-y-3" style={{ borderColor: "var(--border)" }}>
          <div className="flex flex-wrap items-center justify-between gap-3 text-xs">
            <div className="flex items-center gap-4">
              <div>
                <span className="text-stone-500">Total Items: </span>
                <span className="font-bold text-stone-800">{items.length}</span>
              </div>
              {results.length > 0 && (
                <>
                  <div>
                    <span className="text-stone-500">Pass Rate: </span>
                    <span className="font-bold text-emerald-700">
                      {passCount} / {results.length} ({Math.round((passCount / results.length) * 100)}%)
                    </span>
                  </div>
                  <div>
                    <span className="text-stone-500">Avg Latency: </span>
                    <span className="font-bold text-stone-800">{avgLatency} ms</span>
                  </div>
                </>
              )}
            </div>

            {running ? (
              <button
                type="button"
                onClick={() => { abortRef.current = true; }}
                className="px-4 py-2 rounded-xl text-xs font-semibold flex items-center gap-2 transition bg-red-600 hover:bg-red-700 text-white shadow-sm cursor-pointer"
              >
                <Square className="w-3.5 h-3.5 fill-current" />
                <span>Stop ({progress}%)</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={runBenchmark}
                disabled={!items.length}
                className="px-4 py-2 rounded-xl text-xs font-semibold flex items-center gap-2 transition bg-emerald-700 hover:bg-emerald-800 text-white disabled:opacity-50 shadow-sm cursor-pointer"
              >
                <Play className="w-3.5 h-3.5 fill-current" />
                <span>{results.length > 0 ? "Re-Run Benchmark" : "Start Benchmark"}</span>
              </button>
            )}
          </div>

          {/* Progress bar */}
          {running && (
            <div className="w-full bg-stone-200 h-1.5 rounded-full overflow-hidden">
              <div
                className="bg-emerald-600 h-full transition-all duration-150"
                style={{ width: `${progress}%` }}
              />
            </div>
          )}
        </div>

        {/* Results list */}
        <div className="flex-1 overflow-y-auto p-4 space-y-1.5 min-h-[240px]">
          {results.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-center p-8 text-stone-400">
              <Zap className="w-8 h-8 mb-2 stroke-[1.5]" />
              <p className="text-xs">Click &quot;Start Benchmark&quot; to test client decoder throughput</p>
            </div>
          ) : (
            results.map((r, i) => (
              <div
                key={r.id + i}
                className="p-2.5 rounded-xl border border-stone-200 flex items-center justify-between text-xs bg-white"
              >
                <div className="flex items-center gap-2 min-w-0">
                  {r.success ? (
                    <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                  ) : (
                    <XCircle className="w-4 h-4 text-red-500 shrink-0" />
                  )}
                  <span
                    className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                      r.codeType === "PACC"
                        ? "bg-emerald-100 text-emerald-800"
                        : "bg-purple-100 text-purple-800"
                    }`}
                  >
                    {r.codeType}
                  </span>
                  <span className="font-medium text-stone-800 truncate">{r.label}</span>
                </div>

                <div className="flex items-center gap-3 shrink-0">
                  <span className="text-stone-400 text-[11px] font-mono">{r.engine}</span>
                  <span className="font-mono font-semibold text-stone-700 w-16 text-right">
                    {r.latencyMs} ms
                  </span>
                </div>
              </div>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="p-3.5 border-t bg-stone-50 flex items-center justify-between text-xs" style={{ borderColor: "var(--border)" }}>
          <span className="text-stone-500 font-mono text-[11px]">
            {results.length > 0 ? `${results.length} of ${items.length} items benchmarked` : `${items.length} suite items ready`}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-1.5 rounded-xl bg-stone-900 hover:bg-stone-800 text-white font-semibold transition shadow-xs cursor-pointer"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
