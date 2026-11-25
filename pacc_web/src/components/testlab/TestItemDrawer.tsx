"use client";

import React, { useState } from "react";
import { X, CheckCircle2, Clock, SkipForward, AlertCircle, Search } from "lucide-react";
import { TestItem, ScanLog } from "@/lib/useTestRoom";

interface TestItemDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  items: TestItem[];
  currentIndex: number;
  scanLogs?: ScanLog[];
  itemStatuses?: Record<string, ScanLog["status"]>;
  onSelectIndex: (index: number) => void;
}

export function TestItemDrawer({
  isOpen,
  onClose,
  items,
  currentIndex,
  scanLogs,
  itemStatuses,
  onSelectIndex,
}: TestItemDrawerProps) {
  const [filterType, setFilterType] = useState<"ALL" | "PACC" | "PACC_DUAL" | "QR">("ALL");
  const [search, setSearch] = useState("");

  if (!isOpen) return null;

  // Build lookup of latest status per testId
  const statusMap = new Map<string, ScanLog["status"]>();

  // 1. Authoritative room itemStatuses map (covers all 135+ tests in suite)
  if (itemStatuses) {
    for (const [id, s] of Object.entries(itemStatuses)) {
      if (id && s) statusMap.set(id, s);
    }
  }

  // 2. Overlay live scan logs (contains testId & testIndex)
  if (scanLogs) {
    for (const log of scanLogs) {
      if (log.testId) statusMap.set(log.testId, log.status);
      if (typeof log.testIndex === "number" && items[log.testIndex]?.id) {
        statusMap.set(items[log.testIndex].id, log.status);
      }
    }
  }

  let passCount = 0;
  let unresolvedCount = 0;
  for (const item of items) {
    const s = statusMap.get(item.id);
    if (s === "PASS") passCount++;
    else if (s) unresolvedCount++;
  }

  const filteredItems = items.filter((item) => {
    if (filterType !== "ALL" && item.codeType !== filterType) return false;
    if (search.trim()) {
      const q = search.toLowerCase();
      return (
        item.label.toLowerCase().includes(q) ||
        item.sublabel.toLowerCase().includes(q) ||
        item.badge.toLowerCase().includes(q)
      );
    }
    return true;
  });

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/50 backdrop-blur-sm animate-in fade-in duration-200">
      <div
        className="w-full max-w-md h-full flex flex-col shadow-2xl animate-in slide-in-from-right duration-250"
        style={{ background: "var(--surface)", borderLeft: "1px solid var(--border-mid)" }}
      >
        {/* Header */}
        <div className="p-4 border-b flex items-center justify-between" style={{ borderColor: "var(--border)" }}>
          <div>
            <h3 className="font-bold text-sm text-stone-900">Suite Items ({items.length})</h3>
            <div className="flex items-center gap-1.5 text-[11px] text-stone-500 mt-0.5 font-medium">
              <span className="text-emerald-700 font-semibold">{passCount} passed</span>
              <span>·</span>
              {unresolvedCount > 0 && (
                <>
                  <span className="text-amber-700">{unresolvedCount} other</span>
                  <span>·</span>
                </>
              )}
              <span>{Math.max(0, items.length - passCount - unresolvedCount)} pending</span>
            </div>
          </div>
          <button
            onClick={onClose}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl hover:bg-stone-100 text-stone-600 hover:text-stone-900 transition text-xs font-semibold border border-stone-200 cursor-pointer"
            title="Close Suite Items"
          >
            <X className="w-4 h-4" />
            <span>Close</span>
          </button>
        </div>

        {/* Filter & Search */}
        <div className="p-3 border-b space-y-2" style={{ borderColor: "var(--border)" }}>
          <div className="relative">
            <Search className="w-4 h-4 text-stone-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              placeholder="Search stress condition…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-8 pr-3 py-1.5 rounded-lg text-xs bg-stone-50 border border-stone-200 focus:outline-none focus:ring-1 focus:ring-emerald-600"
            />
          </div>
          <div className="flex gap-1.5 overflow-x-auto pb-0.5">
            {(["ALL", "PACC", "PACC_DUAL", "QR"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setFilterType(t)}
                className={`px-2.5 py-1 rounded-md text-[11px] font-medium whitespace-nowrap transition ${
                  filterType === t
                    ? "bg-stone-900 text-white shadow-sm"
                    : "bg-stone-100 text-stone-600 hover:bg-stone-200"
                }`}
              >
                {t === "ALL" ? "All" : t === "PACC_DUAL" ? "8-Colour" : t}
              </button>
            ))}
          </div>
        </div>

        {/* Item List */}
        <div className="flex-1 overflow-y-auto p-3 space-y-1.5">
          {filteredItems.map((item) => {
            const originalIndex = items.findIndex((it) => it.id === item.id);
            const isCurrent = originalIndex === currentIndex;
            const status = statusMap.get(item.id) || (itemStatuses && typeof originalIndex === "number" ? itemStatuses[String(originalIndex)] : undefined);

            let statusIcon = <Clock className="w-3.5 h-3.5 text-stone-300" />;
            let statusText = "Pending";
            let statusBg = "bg-stone-50";

            if (isCurrent) {
              statusIcon = <div className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-ping" />;
              statusText = status ? `Active (${status})` : "Active";
              statusBg = "bg-emerald-50/80 border-emerald-300";
            } else if (status === "PASS") {
              statusIcon = <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />;
              statusText = "PASS";
              statusBg = "bg-emerald-50/40";
            } else if (status === "SKIPPED") {
              statusIcon = <SkipForward className="w-4 h-4 text-stone-400 shrink-0" />;
              statusText = "SKIPPED";
              statusBg = "bg-stone-50";
            } else if (status === "TIMEOUT") {
              statusIcon = <AlertCircle className="w-4 h-4 text-amber-600 shrink-0" />;
              statusText = "TIMEOUT";
              statusBg = "bg-amber-50/40";
            } else if (status === "FAIL" || status === "MISMATCH") {
              statusIcon = <AlertCircle className="w-4 h-4 text-red-500 shrink-0" />;
              statusText = status;
              statusBg = "bg-red-50/40";
            }

            return (
              <button
                key={item.id}
                onClick={() => {
                  onSelectIndex(originalIndex);
                  onClose();
                }}
                className={`w-full p-2.5 rounded-xl border text-left flex items-center justify-between transition gap-2 ${
                  isCurrent
                    ? "border-emerald-500 ring-2 ring-emerald-500/20 shadow-sm"
                    : "border-stone-200 hover:border-stone-300 hover:bg-stone-50/80"
                } ${statusBg}`}
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className="text-xs font-mono font-semibold text-stone-400 w-6 shrink-0">
                    #{originalIndex + 1}
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span
                        className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                          item.codeType === "PACC_DUAL"
                            ? "bg-pink-100 text-pink-800"
                            : item.codeType === "PACC"
                            ? "bg-emerald-100 text-emerald-800"
                            : "bg-purple-100 text-purple-800"
                        }`}
                      >
                        {item.badge || (item.codeType === "PACC_DUAL" ? "8-Colour" : item.codeType === "PACC" ? "PACC" : "Standard QR")}
                      </span>
                      <span className="text-xs font-medium text-stone-800 truncate">{item.label}</span>
                    </div>
                    <div className="text-[11px] text-stone-500 truncate mt-0.5">{item.sublabel}</div>
                  </div>
                </div>

                <div className="flex items-center gap-1 shrink-0">
                  <span className="text-[10px] font-medium text-stone-400 mr-1">{statusText}</span>
                  {statusIcon}
                </div>
              </button>
            );
          })}
        </div>

        {/* Footer */}
        <div className="p-3 border-t bg-stone-50 flex items-center justify-between text-xs" style={{ borderColor: "var(--border)" }}>
          <span className="text-stone-400 font-mono text-[11px]">Click an item to jump directly</span>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-1.5 rounded-xl bg-stone-900 hover:bg-stone-800 text-white font-semibold transition shadow-xs cursor-pointer"
          >
            Close Suite
          </button>
        </div>
      </div>
    </div>
  );
}
