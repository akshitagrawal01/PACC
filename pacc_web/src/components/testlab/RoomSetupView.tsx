"use client";

import React, { useState } from "react";
import {
  Camera,
  ArrowRight,
  Cpu,
  Loader2,
  ChevronDown,
} from "lucide-react";
import { HardwareFingerprint } from "@/lib/deviceFingerprint";
import { DirectScanModal } from "./DirectScanModal";

interface SuiteOption {
  id: string;
  name: string;
  badge: string;
  count: number;
  desc: string;
}

const SUITES: SuiteOption[] = [
  // PACC suites: the paper's N-benchmarks on a real camera (scripts/pacc_suites.py).
  {
    id: "paper_set",
    name: "Paper set (N1, N2, N5, N6, N7, stream)",
    badge: "PACC",
    count: 98,
    desc: "Everything below in one session (about 20 minutes). Same images and seeds as the simulation, so results compare item by item.",
  },
  {
    id: "n2_robustness",
    name: "N2 · Everyday conditions",
    badge: "PACC",
    count: 51,
    desc: "Angle, distance, blur, hand shake, dim, warm and cool light, shadow, glare, faded print, stains, a crease, a covered part and everyday scenes: PACC 4 and 8 colours against QR-H, all the same size.",
  },
  {
    id: "n1_capacity",
    name: "N1 · Capacity",
    badge: "PACC",
    count: 15,
    desc: "32 B to 1 KB in the same printed size: PACC 4 and 8 colours against QR-H.",
  },
  {
    id: "n5_security",
    name: "N5 · Signatures and encryption",
    badge: "PACC",
    count: 8,
    desc: "Ed25519 and ML-DSA-44 signatures, passphrase and key encryption (incl. post-quantum), and a tampered symbol that must be rejected.",
  },
  {
    id: "n6_multiframe",
    name: "N6 · Multi-frame combining",
    badge: "PACC",
    count: 6,
    desc: "Hand-held video in dim light with a moving reflection, shown as a loop: PACC and QR-H see the same kind of frames; PACC may combine them.",
  },
  {
    id: "n7_layers_qc",
    name: "N7 · Layered and QR-compatible",
    badge: "PACC",
    count: 16,
    desc: "Layered symbols read far (coarse) and near (fine); QR-compatible symbols (clean, warm light, dim light, glare) read by a QR reader and by PACC.",
  },
  {
    id: "stream",
    name: "Animated stream",
    badge: "PACC",
    count: 2,
    desc: "0.5 KB and 1.5 KB sent as looping animations; the phone collects frames until the content is complete.",
  },
];

interface RoomSetupViewProps {
  mode?: "host" | "scanner";
  setMode?: (m: "host" | "scanner") => void;
  onCreateRoom: (suiteType: string) => Promise<void>;
  onJoinRoom: (roomId: string, role?: "host" | "scanner") => void;
  isCreating: boolean;
  error: string | null;
  hardware: HardwareFingerprint | null;
  onUpdateDeviceName?: (name: string) => void;
}

export function RoomSetupView({
  mode,
  setMode,
  onCreateRoom,
  onJoinRoom,
  isCreating,
  error,
  hardware,
  onUpdateDeviceName,
}: RoomSetupViewProps) {
  const [selectedSuite, setSelectedSuite] = useState<string>("paper_set");
  const [roomCodeInput, setRoomCodeInput] = useState<string>("");
  const [showDirectScanner, setShowDirectScanner] = useState(false);
  const [isEditingName, setIsEditingName] = useState(false);
  const [nameInput, setNameInput] = useState("");
  const [activeTab, setActiveTab] = useState<"scanner" | "host">(
    mode === "host" ? "host" : "scanner"
  );

  // Follow the parent's mode when it changes (adjusting state during render, not in an effect).
  const [prevMode, setPrevMode] = useState(mode);
  if (mode !== prevMode) {
    setPrevMode(mode);
    if (mode) setActiveTab(mode);
  }

  const handleJoin = (e: React.FormEvent) => {
    e.preventDefault();
    if (roomCodeInput.trim()) {
      onJoinRoom(roomCodeInput.trim().toUpperCase(), "scanner");
    }
  };

  const steps = [
    ["1", "Start a test here", "This screen shows the test symbols."],
    ["2", "Join from a phone", "Scan the join code or type the room number."],
    ["3", "Point and wait", "The phone reads each symbol; results are saved."],
  ];

  return (
    <div className="w-full max-w-6xl mx-auto space-y-6 animate-in fade-in duration-300">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
        <div>
          <h1 className="page-title">Test Lab</h1>
          <p className="page-sub">Compare PACC with QR on real devices: one screen shows the symbols, a phone camera reads them.</p>
        </div>
        {hardware?.deviceName && (
          <span className="badge-neutral self-start sm:self-auto">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
            {hardware.deviceName}
          </span>
        )}
      </div>

      <ol className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        {steps.map(([n, title, desc]) => (
          <li key={n} className="flex items-start gap-3 p-3 rounded-lg" style={{ background: "var(--surface-2)" }}>
            <span className="w-6 h-6 rounded-full bg-white border border-stone-200 text-xs font-semibold flex items-center justify-center shrink-0">
              {n}
            </span>
            <span>
              <span className="block text-sm font-medium text-stone-900">{title}</span>
              <span className="block text-xs text-stone-500">{desc}</span>
            </span>
          </li>
        ))}
      </ol>

      {error && (
        <div className="p-3 rounded-lg bg-red-50 text-red-800 text-sm" role="alert">
          {error}
        </div>
      )}

      {/* Phone vs screen switch (small screens) */}
      <div className="lg:hidden seg w-full">
        {([
          ["scanner", "This is the phone"],
          ["host", "This is the screen"],
        ] as const).map(([id, label]) => (
          <button
            key={id}
            type="button"
            aria-pressed={activeTab === id}
            onClick={() => {
              setActiveTab(id);
              setMode?.(id);
            }}
            className="flex-1"
          >
            {label}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
        {/* Host: pick a test */}
        <div className={`lg:col-span-2 card p-4 sm:p-5 space-y-4 ${activeTab === "scanner" ? "hidden lg:block" : "block"}`}>
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-stone-900">Pick a test</h2>
          </div>

          <div className="space-y-1.5 max-h-[460px] overflow-y-auto pr-1" role="radiogroup" aria-label="Test">
            {SUITES.map((suite) => {
              const isSelected = selectedSuite === suite.id;
              return (
                <button
                  key={suite.id}
                  type="button"
                  role="radio"
                  aria-checked={isSelected}
                  onClick={() => setSelectedSuite(suite.id)}
                  className="w-full text-left flex items-start gap-3 p-3 rounded-lg border transition-colors cursor-pointer"
                  style={{
                    borderColor: isSelected ? "var(--accent)" : "var(--border)",
                    background: isSelected ? "var(--accent-light)" : "var(--surface)",
                  }}
                >
                  <span
                    className="mt-0.5 w-4 h-4 rounded-full border-2 shrink-0 flex items-center justify-center"
                    style={{ borderColor: isSelected ? "var(--accent)" : "var(--border-strong)" }}
                  >
                    {isSelected && <span className="w-2 h-2 rounded-full" style={{ background: "var(--accent)" }} />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium text-stone-900">{suite.name}</span>
                      <span className="text-xs text-stone-500 shrink-0">{suite.count} items</span>
                    </span>
                    <span className="block text-xs text-stone-500 mt-0.5">{suite.desc}</span>
                  </span>
                </button>
              );
            })}
          </div>

          <button
            type="button"
            onClick={() => {
              setMode?.("host");
              onCreateRoom(selectedSuite);
            }}
            disabled={isCreating}
            className="btn-primary w-full h-12"
          >
            {isCreating ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>Preparing symbols… (about 15 s)</span>
              </>
            ) : (
              <>
                <span>Start test room</span>
                <ArrowRight className="w-4 h-4" />
              </>
            )}
          </button>
        </div>

        {/* Scanner: join a room */}
        <div className={`space-y-4 ${activeTab === "host" ? "hidden lg:block" : "block"}`}>
          <div className="card p-4 sm:p-5 space-y-4">
            <h2 className="text-sm font-semibold text-stone-900">Join a room</h2>
            <button type="button" onClick={() => setShowDirectScanner(true)} className="btn-primary w-full h-11">
              <Camera className="w-4 h-4" />
              <span>Scan the join code</span>
            </button>

            <div className="flex items-center gap-2 text-xs text-stone-400">
              <div className="flex-grow border-t border-stone-200" />
              or type the room number
              <div className="flex-grow border-t border-stone-200" />
            </div>

            <form onSubmit={handleJoin} className="space-y-3">
              <input
                type="text"
                maxLength={6}
                placeholder="e.g. 2148"
                aria-label="Room number"
                value={roomCodeInput}
                onChange={(e) => setRoomCodeInput(e.target.value.toUpperCase())}
                className="input h-12 text-lg font-mono font-semibold tracking-[0.3em] uppercase text-center"
              />
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => onJoinRoom(roomCodeInput.trim().toUpperCase(), "host")}
                  disabled={!roomCodeInput.trim()}
                  className="btn-ghost disabled:opacity-40"
                >
                  Join as screen
                </button>
                <button type="submit" disabled={!roomCodeInput.trim()} className="btn-primary">
                  Join as phone
                </button>
              </div>
            </form>
          </div>

          {/* This device */}
          {hardware && (
            <details className="card px-4 disclosure">
              <summary>
                <span className="flex items-center gap-2 min-w-0">
                  <Cpu className="w-4 h-4 shrink-0" style={{ color: "var(--text-3)" }} />
                  <span className="truncate">This device: {hardware.deviceName}</span>
                </span>
                <ChevronDown className="chev w-4 h-4 shrink-0" />
              </summary>
              <div className="pb-4 space-y-3 text-xs">
                {isEditingName ? (
                  <div className="space-y-2">
                    <input
                      type="text"
                      value={nameInput}
                      onChange={(e) => setNameInput(e.target.value)}
                      placeholder="e.g. Pixel 8 Pro"
                      aria-label="Device name"
                      className="input"
                    />
                    <div className="flex justify-end gap-2">
                      <button onClick={() => setIsEditingName(false)} className="btn-ghost !min-h-[32px] !text-xs">
                        Cancel
                      </button>
                      <button
                        onClick={() => {
                          if (nameInput.trim()) onUpdateDeviceName?.(nameInput.trim());
                          setIsEditingName(false);
                        }}
                        className="btn-primary !min-h-[32px] !text-xs"
                      >
                        Save
                      </button>
                    </div>
                  </div>
                ) : (
                  onUpdateDeviceName && (
                    <button
                      onClick={() => {
                        setNameInput(hardware.deviceName);
                        setIsEditingName(true);
                      }}
                      className="text-xs font-medium underline underline-offset-2 cursor-pointer"
                      style={{ color: "var(--accent)" }}
                    >
                      Rename this device
                    </button>
                  )
                )}
                <dl className="space-y-1.5 text-stone-500">
                  {([
                    ["Model", `${hardware.deviceBrand} ${hardware.deviceModel}`],
                    ["OS", hardware.os],
                    ["Browser", hardware.browser],
                    ["GPU", hardware.gpuRenderer],
                    ...(hardware.chipsetInferred ? [["Chip", hardware.chipsetInferred]] : []),
                    ["Screen", hardware.screenResolution],
                    ["Cores / memory", `${hardware.hardwareConcurrency} cores · ${hardware.deviceMemory}`],
                  ] as [string, string][]).map(([k, v]) => (
                    <div key={k} className="flex justify-between gap-3">
                      <dt>{k}</dt>
                      <dd className="font-medium text-stone-800 truncate max-w-[180px]" title={v}>{v}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            </details>
          )}
        </div>
      </div>

      <DirectScanModal isOpen={showDirectScanner} onClose={() => setShowDirectScanner(false)} onJoin={onJoinRoom} />
    </div>
  );
}
