"use client";

import React, { useState, useEffect } from "react";
import { Navbar, PaccMark, type TabId } from "@/components/Navbar";
import { GeneratorTab } from "@/components/GeneratorTab";
import { DecoderTab } from "@/components/DecoderTab";
import { TestMatrixTab, MatrixMode } from "@/components/TestMatrixTab";
import { TestLabTab } from "@/components/TestLabTab";
import { PaccVersionItem } from "@/lib/types";

export default function Home() {
  const [activeTab, setActiveTab] = useState<TabId>("generator");

  const [payload, setPayload] = useState<string>(
    "Welcome to PACC — pilot-equalised, LDPC-coded colour optical symbols"
  );
  const [decoderInitialImage, setDecoderInitialImage] = useState<string | null>(null);
  const [decoderInitialCodec, setDecoderInitialCodec] = useState<"auto" | "pacc" | "qr">("auto");
  const [testLabInitialRoom, setTestLabInitialRoom] = useState<string | null>(null);
  const [testLabInitialMode, setTestLabInitialMode] = useState<"host" | "scanner">("host");
  const [matrixCache, setMatrixCache] = useState<Record<string, PaccVersionItem[]>>({});
  const [matrixMode, setMatrixMode] = useState<MatrixMode>("grid_versions");
  const [isTestActive, setIsTestActive] = useState<boolean>(false);
  const [isMatrixEnlarged, setIsMatrixEnlarged] = useState<boolean>(false);

  // Deep link routing
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const tabParam = params.get("tab");
    const roomParam = params.get("room");
    const modeParam = params.get("mode");
    if (tabParam === "test-lab" || tabParam === "room" || roomParam) {
      if (roomParam) {
        const cleanRoom = roomParam.toUpperCase();
        setTestLabInitialRoom(cleanRoom);
        const saved = sessionStorage.getItem(`pacc_role_${cleanRoom}`) as "host" | "scanner" | null;
        if (modeParam === "scanner" || modeParam === "host") {
          setTestLabInitialMode(modeParam);
        } else if (saved) {
          setTestLabInitialMode(saved);
        } else {
          setTestLabInitialMode("host");
        }
      } else if (modeParam === "scanner" || modeParam === "host") {
        setTestLabInitialMode(modeParam);
      }
      setActiveTab("test-lab");
    }
  }, []);

  const handleNavigateToTestLab = (targetRoomId: string, targetMode: "host" | "scanner" = "host") => {
    setTestLabInitialRoom(targetRoomId.toUpperCase());
    setTestLabInitialMode(targetMode);
    setActiveTab("test-lab");
    if (typeof window !== "undefined") {
      sessionStorage.setItem(`pacc_role_${targetRoomId.toUpperCase()}`, targetMode);
      const url = new URL(window.location.href);
      url.searchParams.set("tab", "test-lab");
      url.searchParams.set("room", targetRoomId.toUpperCase());
      url.searchParams.set("mode", targetMode);
      window.history.replaceState({}, "", url.toString());
    }
  };

  const hideChrome =
    (isTestActive && activeTab === "test-lab") ||
    (isMatrixEnlarged && activeTab === "test-matrix");

  return (
    <div
      className={hideChrome ? "h-screen flex flex-col relative overflow-hidden" : "min-h-screen flex flex-col relative"}
      style={{ background: "var(--bg)" }}
    >
      {!hideChrome && <Navbar activeTab={activeTab} setActiveTab={setActiveTab} />}

      {/* ── Main Content ── */}
      <main
        className={hideChrome ? "flex-1 w-full relative z-10 overflow-y-auto min-h-0" : "flex-1 w-full relative z-10"}
      >
        <div className={hideChrome ? "w-full p-0" : "max-w-6xl mx-auto px-4 sm:px-6 py-6 sm:py-8"}>
          <div key={activeTab} className="animate-in fade-in duration-200">
            {activeTab === "generator" && (
              <GeneratorTab
                payload={payload}
                setPayload={setPayload}
                onNavigateToTestMatrix={() => setActiveTab("test-matrix")}
                onNavigateToDecoder={(dataUrl, codec) => {
                  setDecoderInitialImage(dataUrl || null);
                  setDecoderInitialCodec(codec || "auto");
                  setActiveTab("decoder");
                }}
              />
            )}
            {activeTab === "decoder" && (
              <DecoderTab
                initialImage={decoderInitialImage}
                initialCodec={decoderInitialCodec}
                onNavigateToTestLab={handleNavigateToTestLab}
              />
            )}
            {activeTab === "test-matrix" && (
              <TestMatrixTab
                payload={payload}
                setPayload={setPayload}
                matrixCache={matrixCache}
                setMatrixCache={setMatrixCache}
                currentMode={matrixMode}
                setCurrentMode={setMatrixMode}
                onEnlargedChange={setIsMatrixEnlarged}
                onNavigateToDecoder={(dataUrl) => {
                  setDecoderInitialImage(dataUrl || null);
                  setDecoderInitialCodec("pacc");
                  setActiveTab("decoder");
                }}
              />
            )}
            {activeTab === "test-lab" && (
              <TestLabTab
                onTestActiveChange={setIsTestActive}
                initialRoomId={testLabInitialRoom}
                initialMode={testLabInitialMode}
              />
            )}
          </div>
        </div>
      </main>

      {!hideChrome && (
        <footer className="w-full mt-auto pb-24 md:pb-0" style={{ borderTop: "1px solid var(--border)" }}>
          <div
            className="max-w-6xl mx-auto px-4 sm:px-6 py-5 flex flex-col sm:flex-row items-center justify-between gap-2 text-xs"
            style={{ color: "var(--text-3)" }}
          >
            <div className="flex items-center gap-2">
              <PaccMark size={14} />
              <span>
                <span className="font-medium" style={{ color: "var(--text-2)" }}>PACC</span> · Prototype 23 · runs entirely in
                your browser
              </span>
            </div>
            <div className="flex items-center gap-3">
              <a
                href="https://www.linkedin.com/in/akshitagrawal01/"
                target="_blank"
                rel="noopener noreferrer"
                className="hover:underline"
              >
                Akshit Agrawal
              </a>
              <span aria-hidden="true">·</span>
              <a href="https://github.com/akshitagrawal01/PACC" target="_blank" rel="noopener noreferrer" className="hover:underline">
                GitHub
              </a>
            </div>
          </div>
        </footer>
      )}
    </div>
  );
}
