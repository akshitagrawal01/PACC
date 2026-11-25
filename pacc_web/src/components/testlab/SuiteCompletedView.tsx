"use client";

import React, { useState } from "react";
import {
  Trophy,
  Download,
  RotateCcw,
  Smartphone,
  Copy,
  Check,
} from "lucide-react";
import { RoomState } from "@/lib/useTestRoom";

interface SuiteCompletedViewProps {
  roomState: RoomState;
  onNewRound: () => void;
  onResetToSetup: () => void;
}

export function SuiteCompletedView({
  roomState,
  onNewRound,
  onResetToSetup,
}: SuiteCompletedViewProps) {
  const [copiedSummary, setCopiedSummary] = useState(false);

  const stats = roomState.stats || {
    totalScans: 0,
    passedCount: 0,
    passRate: 0,
    avgDecodeLatencyMs: 0,
    avgTimeToScanMs: 0,
    byType: {},
  };

  const summary = roomState.completionSummary || {
    total: roomState.totalTests || 0,
    pass: stats.passedCount,
    skipped: 0,
    timeout: 0,
    fail: 0,
    mismatch: 0,
  };

  const passPercent =
    summary.total > 0 ? Math.round((summary.pass / summary.total) * 100) : 0;

  const handleDownloadCsv = () => {
    window.open(`/api/test-room?action=export&roomId=${encodeURIComponent(roomState.roomId)}&format=csv`, "_blank");
  };

  const handleDownloadJson = () => {
    window.open(`/api/test-room?action=export&roomId=${encodeURIComponent(roomState.roomId)}&format=json`, "_blank");
  };

  const handleCopySummary = () => {
    const text = [
      `=== PACC Optical Benchmark Report: Room ${roomState.roomId} ===`,
      `Suite: ${roomState.suiteType} | Round: ${roomState.round}`,
      `Total Tests: ${summary.total} | Passed: ${summary.pass} (${passPercent}%)`,
      `Skipped: ${summary.skipped} | Timeout: ${summary.timeout} | Fail: ${summary.fail}`,
      `Avg Time-to-Scan: ${Math.round(stats.avgTimeToScanMs)} ms | Avg Decode Latency: ${Math.round(stats.avgDecodeLatencyMs)} ms`,
      `Devices: ${roomState.connectedDevices.map((d) => d.deviceName).join(", ") || "Single Node"}`,
    ].join("\n");

    navigator.clipboard.writeText(text);
    setCopiedSummary(true);
    setTimeout(() => setCopiedSummary(false), 2000);
  };

  return (
    <div className="w-full max-w-4xl mx-auto py-4 sm:py-8 px-2 sm:px-4 space-y-6 sm:space-y-8 select-none animate-in fade-in duration-300">
      {/* ── CELEBRATION HEADER ────────────────────────────────────────────── */}
      <div
        className="p-6 sm:p-8 rounded-3xl shadow-xl text-center space-y-4 border relative overflow-hidden"
        style={{ background: "var(--surface)", borderColor: "var(--border-mid)" }}
      >
        <div
          className="w-16 h-16 rounded-3xl mx-auto flex items-center justify-center shadow-md animate-bounce"
          style={{
            background: "var(--accent-light)",
            border: "1px solid var(--accent-mid)",
            color: "var(--accent)",
          }}
        >
          <Trophy className="w-8 h-8 text-emerald-700" />
        </div>

        <div>
          <span className="text-xs font-bold uppercase tracking-widest px-3 py-1 rounded-full bg-emerald-100 text-emerald-800">
            Suite Completed
          </span>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-stone-900 mt-2">
            Benchmark Session Finished
          </h1>
          <p className="text-xs sm:text-sm text-stone-500 mt-1">
            Room {roomState.roomId} · {roomState.suiteType} · Round {roomState.round}
          </p>
        </div>

        {/* Action Buttons */}
        <div className="flex flex-wrap items-center justify-center gap-2.5 sm:gap-3 pt-2">
          <button
            type="button"
            onClick={onNewRound}
            className="min-h-[44px] px-5 py-2.5 rounded-xl font-semibold text-xs bg-emerald-800 hover:bg-emerald-900 text-white shadow transition flex items-center gap-2 touch-press cursor-pointer"
          >
            <RotateCcw className="w-4 h-4" />
            <span>Start Round {(roomState.round || 1) + 1}</span>
          </button>

          <button
            type="button"
            onClick={handleDownloadCsv}
            className="min-h-[44px] px-4 py-2.5 rounded-xl font-semibold text-xs border border-stone-300 hover:bg-stone-50 text-stone-800 transition flex items-center gap-2 bg-white touch-press cursor-pointer"
          >
            <Download className="w-4 h-4" />
            <span>Export CSV</span>
          </button>

          <button
            type="button"
            onClick={handleDownloadJson}
            className="min-h-[44px] px-4 py-2.5 rounded-xl font-semibold text-xs border border-stone-300 hover:bg-stone-50 text-stone-800 transition flex items-center gap-2 bg-white touch-press cursor-pointer"
          >
            <Download className="w-4 h-4" />
            <span>Export JSON</span>
          </button>

          <button
            type="button"
            onClick={handleCopySummary}
            className="min-h-[44px] px-4 py-2.5 rounded-xl font-semibold text-xs border border-stone-300 hover:bg-stone-50 text-stone-800 transition flex items-center gap-2 bg-white touch-press cursor-pointer"
          >
            {copiedSummary ? <Check className="w-4 h-4 text-emerald-600" /> : <Copy className="w-4 h-4" />}
            <span>{copiedSummary ? "Copied" : "Copy Report"}</span>
          </button>
        </div>
      </div>

      {/* ── KPI TILES ─────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3.5">
        <div className="p-4 rounded-2xl bg-white border border-stone-200 shadow-sm space-y-1 text-center">
          <div className="text-[11px] font-bold uppercase tracking-wider text-stone-400">Pass Rate</div>
          <div className="text-2xl sm:text-3xl font-bold font-mono text-emerald-700">
            {passPercent}%
          </div>
          <div className="text-[11px] text-stone-500 font-medium">
            {summary.pass} of {summary.total} passed
          </div>
        </div>

        <div className="p-4 rounded-2xl bg-white border border-stone-200 shadow-sm space-y-1 text-center">
          <div className="text-[11px] font-bold uppercase tracking-wider text-stone-400">Avg Time To Scan</div>
          <div className="text-2xl sm:text-3xl font-bold font-mono text-stone-900">
            {Math.round(stats.avgTimeToScanMs)} <span className="text-sm font-normal text-stone-500">ms</span>
          </div>
          <div className="text-[11px] text-stone-500 font-medium">Phone viewport latency</div>
        </div>

        <div className="p-4 rounded-2xl bg-white border border-stone-200 shadow-sm space-y-1 text-center">
          <div className="text-[11px] font-bold uppercase tracking-wider text-stone-400">Decode Latency</div>
          <div className="text-2xl sm:text-3xl font-bold font-mono text-stone-900">
            {Math.round(stats.avgDecodeLatencyMs)} <span className="text-sm font-normal text-stone-500">ms</span>
          </div>
          <div className="text-[11px] text-stone-500 font-medium">Core algorithm speed</div>
        </div>

        <div className="p-4 rounded-2xl bg-white border border-stone-200 shadow-sm space-y-1 text-center">
          <div className="text-[11px] font-bold uppercase tracking-wider text-stone-400">Unresolved Items</div>
          <div className="text-2xl sm:text-3xl font-bold font-mono text-amber-600">
            {summary.skipped + summary.timeout}
          </div>
          <div className="text-[11px] text-stone-500 font-medium">
            {summary.skipped} skipped · {summary.timeout} timeout
          </div>
        </div>
      </div>

      {/* ── CODE TYPE BREAKDOWN ───────────────────────────────────────────── */}
      <div className="p-5 sm:p-6 rounded-3xl bg-white border border-stone-200 shadow-sm space-y-4">
        <h2 className="text-sm font-bold uppercase tracking-wider text-stone-700">
          Format Comparison Matrix
        </h2>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {(["PACC", "QR"] as const).map((type) => {
            const data = stats.byType?.[type] || {
              total: 0,
              pass: 0,
              passRate: 0,
              avgLatency: 0,
              avgTimeToScan: 0,
            };

            const isPacc = type === "PACC";

            const rawRate = data.passRate != null ? data.passRate : (data.total > 0 ? (data.pass / data.total) * 100 : 0);
            const ratePercent = rawRate > 1 ? Math.round(rawRate) : Math.round(rawRate * 100);

            return (
              <div
                key={type}
                className="p-4 rounded-2xl border border-stone-200/90 bg-stone-50/50 space-y-3"
              >
                <div className="flex items-center justify-between">
                  <span
                    className={`text-xs font-bold px-2 py-0.5 rounded ${
                      isPacc
                        ? "bg-emerald-100 text-emerald-800"
                        : "bg-purple-100 text-purple-800"
                    }`}
                  >
                    {isPacc ? "PACC Engine" : "Standard QR"}
                  </span>
                  <span className="text-xs font-mono font-bold text-stone-700">
                    {data.pass}/{data.total} ({ratePercent}%)
                  </span>
                </div>

                <div className="space-y-1.5 text-xs text-stone-600 font-mono">
                  <div className="flex justify-between">
                    <span className="text-stone-400">Avg Time-to-Scan:</span>
                    <span className="font-semibold text-stone-800">{Math.round(data.avgTimeToScan)} ms</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-stone-400">Avg Decode Latency:</span>
                    <span className="font-semibold text-stone-800">{Math.round(data.avgLatency)} ms</span>
                  </div>
                </div>

                <div className="w-full bg-stone-200 h-1.5 rounded-full overflow-hidden">
                  <div
                    className={`h-full ${
                      isPacc ? "bg-emerald-600" : "bg-purple-600"
                    }`}
                    style={{ width: `${Math.min(100, Math.max(0, ratePercent))}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── PARTICIPATING DEVICES ─────────────────────────────────────────── */}
      <div className="p-5 rounded-3xl bg-white border border-stone-200 shadow-sm space-y-3">
        <h2 className="text-sm font-bold uppercase tracking-wider text-stone-700">
          Participating Optical Nodes ({roomState.connectedDevices.length})
        </h2>

        <div className="space-y-2">
          {roomState.connectedDevices.map((dev) => (
            <div
              key={dev.deviceId}
              className="p-3 rounded-xl border border-stone-200 bg-stone-50 flex items-center justify-between text-xs"
            >
              <div className="flex items-center gap-2.5">
                <Smartphone className="w-4 h-4 text-stone-500" />
                <div>
                  <div className="font-semibold text-stone-800">{dev.deviceName}</div>
                  <div className="text-[11px] text-stone-400">
                    {dev.os || "Unknown OS"} · {dev.browser || "Browser"} · {dev.cameraResolution || "Camera"}
                  </div>
                </div>
              </div>

              <div className="text-right">
                <div className="font-mono font-semibold text-emerald-700">
                  {dev.scansCompleted} Scans
                </div>
                <div className="text-[10px] text-stone-400">
                  {dev.isOnline ? "Online" : "Disconnected"}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ── RETURN TO SETUP BUTTON ────────────────────────────────────────── */}
      <div className="text-center pt-2">
        <button
          onClick={onResetToSetup}
          className="text-xs font-semibold text-stone-500 hover:text-stone-900 transition underline underline-offset-4"
        >
          Return to Test Suite Launcher
        </button>
      </div>
    </div>
  );
}
