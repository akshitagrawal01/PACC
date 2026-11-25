"use client";

import React, { useState, useEffect } from "react";
import { encodePacc, encodedToDataUrl } from "@/lib/pacc/client";
import { X, Copy, Check, QrCode, Smartphone, ExternalLink, Sparkles, Settings2 } from "lucide-react";

interface JoinQrModalProps {
  isOpen: boolean;
  onClose: () => void;
  roomId: string;
}

export function JoinQrModal({ isOpen, onClose, roomId }: JoinQrModalProps) {
  const [codeFormat, setCodeFormat] = useState<"qr" | "pacc">("qr");
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [paccDataUrl, setPaccDataUrl] = useState<string | null>(null);
  const [loadingPacc, setLoadingPacc] = useState<boolean>(false);
  const [copiedLink, setCopiedLink] = useState(false);
  const [copiedCode, setCopiedCode] = useState(false);

  // Custom host override (e.g. for Cloudflare tunnel or LAN IP when running on localhost)
  const [customHost, setCustomHost] = useState<string>("");
  const [showHostInput, setShowHostInput] = useState<boolean>(false);

  const isLocalhost =
    typeof window !== "undefined" &&
    (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1");

  const effectiveOrigin =
    customHost.trim() || (typeof window !== "undefined" ? window.location.origin : "");

  const joinUrl = effectiveOrigin
    ? `${effectiveOrigin}/?tab=test-lab&room=${roomId}&mode=scanner`
    : "";

  // 1. Generate standard QR code
  useEffect(() => {
    if (!isOpen || !roomId || !joinUrl) return;
    import("qrcode")
      .then((QRCode) => {
        QRCode.toDataURL(joinUrl, {
          width: 320,
          margin: 2,
          color: { dark: "#1A1C16", light: "#FFFFFF" },
        })
          .then(setQrDataUrl)
          .catch(() => {});
      })
      .catch(() => {});
  }, [isOpen, roomId, joinUrl]);

  // Reset PACC data URL if joinUrl changes
  useEffect(() => {
    setPaccDataUrl(null);
  }, [joinUrl]);

  // 2. Generate PACC Optical Barcode if requested
  useEffect(() => {
    if (!isOpen || !roomId || !joinUrl || codeFormat !== "pacc") return;
    if (paccDataUrl) return;

    let cancelled = false;
    setLoadingPacc(true);

    // PACC join barcode, encoded in the browser (no server round-trip).
    encodePacc(new TextEncoder().encode(joinUrl), { mcs: 1, level: "M", cellSize: 10 })
      .then((enc) => ({ dataUrl: encodedToDataUrl(enc), error: undefined as string | undefined }))
      .then((data) => {
        const url = data.dataUrl;
        if (!cancelled && url) {
          setPaccDataUrl(url);
        } else if (!cancelled && data?.error) {
          console.warn("PACC generation error:", data.error);
        }
      })
      .catch((err) => {
        if (!cancelled) console.warn("Failed to fetch PACC encode:", err);
      })
      .finally(() => {
        if (!cancelled) setLoadingPacc(false);
      });

    return () => {
      cancelled = true;
    };
  }, [isOpen, roomId, joinUrl, codeFormat, paccDataUrl]);

  if (!isOpen) return null;

  const handleCopyLink = () => {
    if (!joinUrl) return;
    navigator.clipboard.writeText(joinUrl);
    setCopiedLink(true);
    setTimeout(() => setCopiedLink(false), 2000);
  };

  const handleCopyCode = () => {
    if (!roomId) return;
    navigator.clipboard.writeText(roomId);
    setCopiedCode(true);
    setTimeout(() => setCopiedCode(false), 2000);
  };

  const activeDisplayUrl = codeFormat === "pacc" ? paccDataUrl : qrDataUrl;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
      <div
        className="w-full max-w-sm rounded-2xl p-5 sm:p-6 shadow-2xl space-y-4 animate-in zoom-in-95 duration-200 relative max-h-[92vh] overflow-y-auto"
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border-mid)",
        }}
      >
        {/* Close button */}
        <button
          onClick={onClose}
          className="absolute top-4 right-4 p-1.5 rounded-full hover:bg-black/5 text-stone-400 hover:text-stone-700 transition cursor-pointer"
        >
          <X className="w-5 h-5" />
        </button>

        {/* Title */}
        <div className="text-center space-y-1">
          <div
            className="w-10 h-10 rounded-xl mx-auto flex items-center justify-center mb-1.5"
            style={{
              background: "var(--accent-light)",
              border: "1px solid var(--accent-mid)",
              color: "var(--accent)",
            }}
          >
            <Smartphone className="w-5 h-5" />
          </div>
          <h3 className="text-base font-bold text-stone-900">Pair Mobile Scanner</h3>
          <p className="text-xs text-stone-500">Scan to connect phone as dedicated optical scanner</p>
        </div>

        {/* Direct Decoder Connect Feature Banner */}
        <div className="p-2.5 rounded-xl bg-emerald-50/80 border border-emerald-200 text-emerald-900 text-[11px] flex items-start gap-2">
          <Sparkles className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
          <div className="leading-tight">
            <span className="font-bold">Direct Decoder Connect:</span> Point the{" "}
            <span className="font-semibold underline underline-offset-1">PACC Decoder</span> on your phone
            at this screen to pair automatically without typing codes.
          </div>
        </div>

        {/* Format Selector Pill (Standard QR vs PACC Optical Code) */}
        <div className="flex items-center justify-center">
          <div className="p-0.5 rounded-xl bg-stone-100 border border-stone-200 flex gap-1 text-xs">
            <button
              onClick={() => setCodeFormat("qr")}
              className={`px-3 py-1 rounded-lg font-medium transition cursor-pointer ${
                codeFormat === "qr"
                  ? "bg-white text-stone-900 shadow-xs font-semibold"
                  : "text-stone-600 hover:text-stone-900"
              }`}
            >
              Standard QR
            </button>
            <button
              onClick={() => setCodeFormat("pacc")}
              className={`px-3 py-1 rounded-lg font-medium transition flex items-center gap-1 cursor-pointer ${
                codeFormat === "pacc"
                  ? "bg-emerald-800 text-white shadow-xs font-semibold"
                  : "text-stone-600 hover:text-stone-900"
              }`}
            >
              <Sparkles className="w-3 h-3 text-emerald-300" />
              <span>PACC Barcode</span>
            </button>
          </div>
        </div>

        {/* Barcode Display */}
        <div className="flex justify-center">
          <div className="p-3 bg-white rounded-2xl shadow-inner border border-stone-200 flex items-center justify-center">
            {codeFormat === "pacc" && loadingPacc && !paccDataUrl ? (
              <div className="w-48 h-48 flex flex-col items-center justify-center bg-stone-50 rounded-lg text-xs text-stone-400 gap-2">
                <QrCode className="w-8 h-8 animate-pulse text-emerald-600" />
                <span>Synthesizing PACC…</span>
              </div>
            ) : activeDisplayUrl ? (
              <img
                src={activeDisplayUrl}
                alt={`Join Room ${roomId}`}
                className="w-48 h-48 rounded-lg object-contain"
                style={{ imageRendering: "pixelated" }}
              />
            ) : (
              <div className="w-48 h-48 flex items-center justify-center bg-stone-100 rounded-lg animate-pulse">
                <QrCode className="w-10 h-10 text-stone-300" />
              </div>
            )}
          </div>
        </div>

        {/* Room Code Badge */}
        <div className="flex items-center justify-between p-3 rounded-xl bg-stone-50 border border-stone-200">
          <div>
            <div className="text-[10px] uppercase font-bold tracking-wider text-stone-400">Room Code</div>
            <div className="text-lg font-mono font-bold tracking-widest text-stone-800">{roomId}</div>
          </div>
          <button
            onClick={handleCopyCode}
            className="px-3 py-1.5 rounded-lg text-xs font-medium border flex items-center gap-1.5 transition bg-white hover:bg-stone-50 text-stone-700 border-stone-200 shadow-xs cursor-pointer"
          >
            {copiedCode ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
            {copiedCode ? "Copied" : "Copy Code"}
          </button>
        </div>

        {/* Localhost / Custom Host Settings for Remote Mobile Scanners */}
        {isLocalhost && (
          <div className="space-y-1.5">
            <button
              onClick={() => setShowHostInput(!showHostInput)}
              className="text-[11px] text-stone-500 hover:text-stone-800 flex items-center gap-1 font-medium transition cursor-pointer"
            >
              <Settings2 className="w-3 h-3" />
              <span>{showHostInput ? "Hide custom host origin" : "Using Cloudflare tunnel or LAN IP? Set URL"}</span>
            </button>

            {showHostInput && (
              <div className="p-2.5 bg-stone-100/80 rounded-xl border border-stone-200 space-y-1.5 animate-in fade-in">
                <label className="text-[10px] uppercase font-bold text-stone-500 block">
                  Public Tunnel / Host Origin
                </label>
                <div className="flex gap-1.5">
                  <input
                    type="text"
                    placeholder="e.g. https://xxx.trycloudflare.com"
                    value={customHost}
                    onChange={(e) => setCustomHost(e.target.value)}
                    className="flex-1 px-2.5 py-1 text-xs rounded-lg border border-stone-300 bg-white font-mono"
                  />
                  {customHost && (
                    <button
                      onClick={() => setCustomHost("")}
                      className="px-2 py-1 text-[11px] rounded-lg border border-stone-300 bg-stone-50 hover:bg-stone-100 text-stone-600 cursor-pointer"
                    >
                      Reset
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Direct Link */}
        <button
          onClick={handleCopyLink}
          className="w-full py-2.5 px-3 rounded-xl text-xs font-semibold flex items-center justify-center gap-2 transition bg-stone-900 hover:bg-stone-800 text-white shadow-sm cursor-pointer"
        >
          {copiedLink ? <Check className="w-4 h-4 text-emerald-400" /> : <ExternalLink className="w-4 h-4" />}
          {copiedLink ? "Link Copied to Clipboard!" : "Copy Direct Scanner Link"}
        </button>
      </div>
    </div>
  );
}
