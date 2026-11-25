"use client";

import React from "react";
import { QrCode, Scan, LayoutGrid, FlaskConical } from "lucide-react";

export type TabId = "generator" | "decoder" | "test-matrix" | "test-lab";

interface NavbarProps {
  activeTab: TabId;
  setActiveTab: (tab: TabId) => void;
}

export const TABS: { id: TabId; label: string; icon: typeof QrCode }[] = [
  { id: "generator", label: "Create", icon: QrCode },
  { id: "decoder", label: "Scan", icon: Scan },
  { id: "test-matrix", label: "Matrix", icon: LayoutGrid },
  { id: "test-lab", label: "Test Lab", icon: FlaskConical },
];

/** Four-colour mark: a nod to the colour cells of a PACC symbol. */
export function PaccMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <rect x="2" y="2" width="9" height="9" rx="2" fill="#111827" />
      <rect x="13" y="2" width="9" height="9" rx="2" fill="#06B6D4" />
      <rect x="2" y="13" width="9" height="9" rx="2" fill="#EC4899" />
      <rect x="13" y="13" width="9" height="9" rx="2" fill="#FACC15" />
    </svg>
  );
}

export const Navbar: React.FC<NavbarProps> = ({ activeTab, setActiveTab }) => {
  return (
    <>
      {/* Top bar (all sizes); tabs inline from md up */}
      <header
        className="sticky top-0 z-50 w-full"
        style={{ background: "rgba(255,255,255,0.9)", backdropFilter: "blur(12px)", borderBottom: "1px solid var(--border)" }}
      >
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-14 flex items-center gap-6">
          <button
            onClick={() => setActiveTab("generator")}
            className="flex items-center gap-2 cursor-pointer shrink-0"
            aria-label="PACC home"
          >
            <PaccMark />
            <span className="text-[15px] font-semibold tracking-tight" style={{ color: "var(--text)" }}>
              PACC
            </span>
          </button>

          <nav className="hidden md:flex items-center gap-1 h-full" aria-label="Main navigation">
            {TABS.map((tab) => {
              const active = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  id={`nav-${tab.id}`}
                  onClick={() => setActiveTab(tab.id)}
                  aria-current={active ? "page" : undefined}
                  className="relative h-full px-3 text-sm font-medium cursor-pointer transition-colors"
                  style={{ color: active ? "var(--text)" : "var(--text-3)" }}
                >
                  {tab.label}
                  {active && (
                    <span className="absolute left-3 right-3 bottom-0 h-0.5 rounded-full" style={{ background: "var(--accent)" }} />
                  )}
                </button>
              );
            })}
          </nav>
        </div>
      </header>

      {/* Mobile bottom tab bar */}
      <nav
        className="md:hidden fixed bottom-0 inset-x-0 z-[9999]"
        style={{
          background: "rgba(255,255,255,0.96)",
          backdropFilter: "blur(16px)",
          borderTop: "1px solid var(--border)",
          paddingBottom: "env(safe-area-inset-bottom, 0px)",
        }}
        aria-label="Mobile navigation"
      >
        <div className="grid grid-cols-4">
          {TABS.map((tab) => {
            const Icon = tab.icon;
            const active = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                id={`mobile-nav-${tab.id}`}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                aria-current={active ? "page" : undefined}
                className="touch-press flex flex-col items-center justify-center gap-1 py-2 min-h-[56px] cursor-pointer"
                style={{ color: active ? "var(--accent)" : "var(--text-3)" }}
              >
                <Icon className="w-5 h-5" strokeWidth={active ? 2.2 : 1.8} />
                <span className="text-[11px] font-medium leading-none">{tab.label}</span>
              </button>
            );
          })}
        </div>
      </nav>
    </>
  );
};
