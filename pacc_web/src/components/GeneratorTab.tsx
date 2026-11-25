"use client";

import React, { useEffect, useState } from "react";
import {
  QrCode,
  Sliders,
  Download,
  Copy,
  Check,
  ChevronDown,
  RefreshCw,
  Info,
  ArrowRight,
  Scan,
  ShieldCheck,
  KeyRound,
} from "lucide-react";
import { EncodeResponse } from "@/lib/types";
import { errorMessage } from "@/lib/errors";
import {
  encodeLayeredPacc,
  encodePacc,
  encodeQcPacc,
  encodedToDataUrl,
  planPaccStream,
  type WireSecurity,
} from "@/lib/pacc/client";
import { renderGrid } from "@/lib/pacc/index";
import {
  ALG_ED25519,
  ALG_MLDSA44,
  ALG_NAMES,
  generatePqRecipientKey,
  generateRecipientKey,
  generateSigningKey,
  toHex,
} from "@/lib/pacc/secure";
import { LEVELS as PACC_LEVELS, PALETTES as PACC_PALETTES } from "@/lib/pacc/spec";

interface GeneratorTabProps {
  payload: string;
  setPayload: (val: string) => void;
  onNavigateToTestMatrix?: () => void;
  onNavigateToDecoder?: (dataUrl: string, codec?: "auto" | "pacc" | "qr") => void;
}

export const GeneratorTab: React.FC<GeneratorTabProps> = ({
  payload,
  setPayload,
  onNavigateToTestMatrix,
  onNavigateToDecoder,
}) => {
  // Config state
  const [cellSize, setCellSize] = useState<number>(10);
  const [mcs, setMcs] = useState<number>(1);
  const [level, setLevel] = useState<string>("Q");

  // Mode: standard, stream (animated fountain code), or qc (QR-compatible)
  const [mode, setMode] = useState<"standard" | "stream" | "qc" | "layered">("standard");
  const [fineText, setFineText] = useState<string>("");

  // Security state
  const [sign, setSign] = useState<boolean>(false);
  const [signAlg, setSignAlg] = useState<number>(ALG_ED25519);
  const [signSeed, setSignSeed] = useState<string>("");
  const [embedKey, setEmbedKey] = useState<boolean>(true);
  const [enc, setEnc] = useState<"none" | "password" | "recipient" | "recipient-pq">("none");
  const [password, setPassword] = useState<string>("");
  const [recipient, setRecipient] = useState<string>("");
  // Shown after "New key" / "New pair" so the user can copy the other half.
  const [signPub, setSignPub] = useState<string>("");
  const [recipientSecret, setRecipientSecret] = useState<string>("");

  // QC mode state
  const [qcHidden, setQcHidden] = useState<string>("");

  // Stream state
  const [streamN, setStreamN] = useState<number>(64);
  const [fps, setFps] = useState<number>(6);
  const [streamFrames, setStreamFrames] = useState<string[] | null>(null);
  const [streamIdx, setStreamIdx] = useState<number>(0);

  // Output & UI state
  const [loading, setLoading] = useState<boolean>(false);
  const [result, setResult] = useState<EncodeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<boolean>(false);

  // Animate stream frames
  useEffect(() => {
    if (!streamFrames || streamFrames.length < 2) return;
    const t = setInterval(() => setStreamIdx((i) => (i + 1) % streamFrames.length), 1000 / fps);
    return () => clearInterval(t);
  }, [streamFrames, fps]);

  const safePayload = payload || "";
  const textBytes = new TextEncoder().encode(safePayload).length;

  // Presets
  const presets = [
    { label: "Link", value: "https://github.com/akshitagrawal01/PACC" },
    {
      label: "Short text",
      value:
        "PACC: Pilot-equalised, rate-adaptive LDPC-coded colour matrix symbology with Golay format words, multi-frame soft combining, post-quantum signatures, and fountain streaming.",
    },
    {
      label: "JSON",
      value: JSON.stringify(
        {
          sub: "node_alpha_09",
          iss: "PACC-Authority",
          repo: "https://github.com/akshitagrawal01/PACC",
          ecc_mode: "LDPC_IRA",
          roles: ["read", "write", "verify"],
        },
        null,
        2
      ),
    },
    {
      label: "1 KB text",
      value:
        "PACC: High-Density Coded Colour Optical Symbology with Pilot Equalisation and Adaptive LDPC Coding\n\nAbstract:\nConventional two-dimensional matrix barcodes rely on binary luminance modulation, restricting density to 1.0 bit per cell. We introduce PACC, a colour optical barcode framework combining spectrally separated constellations (up to 3.0 bits/cell) with sparse pilot reference grids, irregular repeat-accumulate (IRA) LDPC forward error correction, and belief-propagation decoding.\n\nPilot cells dynamically calibrate camera tone curves, glare, and hue drift in real-time. Symmetrical 4-corner Golay-coded format words ensure orientation recovery under destroyed finders. ML-DSA-44 (post-quantum) or Ed25519 signatures and HPKE recipient encryption (X25519, or post-quantum hybrid X-Wing) provide authenticated, confidential payloads.",
    },
    {
      label: "2 KB text",
      value:
        "PACC: High-Density Coded Colour Optical Symbology with Pilot Equalisation and Adaptive LDPC Coding\n\nAbstract:\nConventional two-dimensional matrix barcodes rely on binary luminance modulation, restricting density to 1.0 bit per cell. We introduce PACC, a colour optical barcode framework combining spectrally separated constellations (up to 3.0 bits/cell) with sparse pilot reference grids, irregular repeat-accumulate (IRA) LDPC forward error correction, and belief-propagation decoding.\n\nPilot cells dynamically calibrate camera tone curves, glare, and hue drift in real-time. Symmetrical 4-corner Golay-coded format words ensure orientation recovery under destroyed finders. ML-DSA-44 (post-quantum) or Ed25519 signatures and HPKE recipient encryption (X25519, or post-quantum hybrid X-Wing) provide authenticated, confidential payloads.\n\nEvaluation Summary:\nAcross 42 synthetic stress conditions including 30% cell loss, deep chromatic stains, 6px Gaussian blur, and perspective yaw up to 60 degrees, PACC achieved a 95.0% mean decode success rate compared to 66.9% for ISO QR Code Level H at identical physical footprint.",
    },
  ];

  // Encode Handler
  const handleGenerate = async () => {
    if (!safePayload.trim()) {
      setError("Please enter text or payload to synthesize.");
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const t0 = performance.now();
      const bytes = new TextEncoder().encode(safePayload);
      const security: WireSecurity = {};

      if (sign) {
        if (!/^[0-9a-fA-F]{64}$/.test(signSeed.trim())) {
          throw new Error("The signing key must be 64 hex characters. Press New key to create one.");
        }
        security.sign = { alg: signAlg, seedHex: signSeed.trim(), embed: embedKey };
      }

      if (enc === "password") {
        if (password.length < 12) {
          throw new Error("Use a passphrase of at least 12 characters for offline print resilience.");
        }
        security.password = password;
      } else if (enc === "recipient") {
        if (!/^[0-9a-fA-F]{64}$/.test(recipient.trim())) {
          throw new Error("Recipient public key must be 32 bytes of hex.");
        }
        security.recipientHex = recipient.trim();
      } else if (enc === "recipient-pq") {
        if (!/^[0-9a-fA-F]{2432}$/.test(recipient.trim())) {
          throw new Error("Post-quantum (X-Wing) recipient public key must be 1216 bytes of hex.");
        }
        security.recipientPqHex = recipient.trim();
      }

      const gridToDataUrl = (g: Uint8Array, n: number) => {
        const img = renderGrid(g, n, cellSize) as ImageData;
        const canvas = document.createElement("canvas");
        canvas.width = img.width;
        canvas.height = img.height;
        canvas.getContext("2d")!.putImageData(img, 0, 0);
        return canvas.toDataURL("image/png");
      };

      if (mode === "qc") {
        // QR-compatible: visible text is standard QR; hidden text rides on chroma
        const qc = await encodeQcPacc(safePayload, new TextEncoder().encode(qcHidden), { ec: (["L", "M", "Q", "H"].includes(level) ? level : "M") as "L" | "M" | "Q" | "H", security });
        setStreamFrames(null);
        setResult({
          success: true,
          dataUrl: gridToDataUrl(qc.grid, qc.n),
          gridSide: qc.n,
          payloadBytes: qc.messageBytes,
          rawBytes: bytes.length,
          compressed: false,
          encrypted: enc !== "none",
          eccLevel: 1,
          cellSize,
          bitsPerCell: 2,
          totalModules: qc.n * qc.n,
          durationMs: Math.round(performance.now() - t0),
          codeType: "PACC QC",
        });
        return;
      }

      if (mode === "layered") {
        // Distance-adaptive: coarse black-and-white symbol (payload) + fine chroma layer (detail text).
        const lay = await encodeLayeredPacc(bytes, new TextEncoder().encode(fineText), { level, security });
        const subPx = Math.max(2, Math.round(cellSize / 2));
        const img = renderGrid(lay.grid, lay.nf, subPx, 8) as ImageData;
        const canvas = document.createElement("canvas");
        canvas.width = img.width;
        canvas.height = img.height;
        canvas.getContext("2d")!.putImageData(img, 0, 0);
        setStreamFrames(null);
        setResult({
          success: true,
          dataUrl: canvas.toDataURL("image/png"),
          gridSide: lay.n,
          payloadBytes: bytes.length,
          rawBytes: bytes.length,
          compressed: false,
          encrypted: enc !== "none",
          eccLevel: 0,
          cellSize,
          bitsPerCell: 1,
          totalModules: lay.n * lay.n,
          durationMs: Math.round(performance.now() - t0),
          codeType: "PACC Layered",
        });
        return;
      }

      if (mode === "stream") {
        // Multi-frame animated stream
        const plan = await planPaccStream(bytes, {
          n: streamN,
          mcs,
          level,
          security,
          frames: 0,
          repair: 0.25,
        });
        const frames = plan.grids.map((g) => gridToDataUrl(g, plan.n));
        setStreamFrames(frames);
        setStreamIdx(0);
        setResult({
          success: true,
          dataUrl: frames[0],
          gridSide: plan.n,
          payloadBytes: plan.messageBytes,
          rawBytes: bytes.length,
          compressed: false,
          encrypted: enc !== "none",
          eccLevel: 0,
          cellSize,
          bitsPerCell: PACC_PALETTES[mcs].bits,
          totalModules: plan.n * plan.n,
          durationMs: Math.round(performance.now() - t0),
          codeType: "PACC Stream",
        });
        return;
      }

      // Standard single-symbol PACC
      setStreamFrames(null);
      const encResult = await encodePacc(bytes, { mcs, level, cellSize, security });
      setResult({
        success: true,
        dataUrl: encodedToDataUrl(encResult),
        gridSide: encResult.meta.n,
        payloadBytes: encResult.meta.payloadBytes,
        rawBytes: bytes.length,
        compressed: encResult.meta.compressed,
        encrypted: enc !== "none",
        eccLevel: encResult.meta.level,
        cellSize,
        bitsPerCell: PACC_PALETTES[encResult.meta.mcs].bits,
        totalModules: encResult.meta.n * encResult.meta.n,
        durationMs: Math.round(performance.now() - t0),
        codeType: "PACC",
      });
    } catch (err: unknown) {
      setError(errorMessage(err, "PACC encoding failed"));
    } finally {
      setLoading(false);
    }
  };

  const handleDownload = (format: "png" | "svg" = "png") => {
    if (!result?.dataUrl) return;
    const link = document.createElement("a");
    link.download = `pacc_symbol.${format}`;
    link.href = streamFrames ? streamFrames[streamIdx % streamFrames.length] : result.dataUrl;
    link.click();
  };

  const handleCopyDataUrl = () => {
    if (!result?.dataUrl) return;
    const activeUrl = streamFrames ? streamFrames[streamIdx % streamFrames.length] : result.dataUrl;
    navigator.clipboard.writeText(activeUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const securitySummary =
    [sign ? `Signed (${ALG_NAMES[signAlg]})` : null, enc === "password" ? "Passphrase" : enc === "recipient" ? "Encrypted to key" : enc === "recipient-pq" ? "Encrypted to key (PQ)" : null]
      .filter(Boolean)
      .join(" · ") || "Off";

  const newSigningKey = () => {
    const k = generateSigningKey(signAlg);
    setSignSeed(toHex(k.seed));
    setSignPub(toHex(k.publicKey));
  };

  const newRecipientKey = () => {
    if (enc === "recipient-pq") {
      const k = generatePqRecipientKey();
      setRecipient(toHex(k.publicKey));
      setRecipientSecret(toHex(k.seed));
    } else {
      const k = generateRecipientKey();
      setRecipient(toHex(k.publicKey));
      setRecipientSecret(toHex(k.privateKey));
    }
  };

  const modes = [
    { id: "standard" as const, label: "Standard", desc: "One colour symbol" },
    { id: "stream" as const, label: "Animated", desc: "Frames for big content" },
    { id: "qc" as const, label: "QR-compatible", desc: "Works with any QR app" },
    { id: "layered" as const, label: "Layered", desc: "Readable near and far" },
  ];

  const modeTitle = streamFrames
    ? `Animated · ${streamFrames.length} frames`
    : result?.codeType === "PACC QC"
    ? "QR-compatible"
    : result?.codeType === "PACC Layered"
    ? "Layered"
    : "Standard";

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="page-title">Create a symbol</h1>
          <p className="page-sub">Type your content, choose a type and press Generate. Everything runs in your browser.</p>
        </div>
        {onNavigateToTestMatrix && (
          <button
            type="button"
            onClick={onNavigateToTestMatrix}
            className="text-sm font-medium flex items-center gap-1 hover:underline cursor-pointer"
            style={{ color: "var(--accent)" }}
          >
            How much fits? <ArrowRight className="w-4 h-4" />
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Settings */}
        <div className="lg:col-span-7 card p-5 sm:p-6 space-y-6">
          {/* 1. Type */}
          <div>
            <span className="section-label">Type</span>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {modes.map((m) => (
                <button key={m.id} type="button" onClick={() => setMode(m.id)} aria-pressed={mode === m.id} className="tile">
                  <div className="tile-title">{m.label}</div>
                  <div className="tile-desc">{m.desc}</div>
                </button>
              ))}
            </div>
          </div>

          {/* 2. Content */}
          <div>
            <div className="flex items-baseline justify-between mb-1.5">
              <label htmlFor="gen-payload" className="field-label !mb-0">
                {mode === "qc" ? "Visible QR content (link or text)" : mode === "layered" ? "Far-away content" : "Content"}
              </label>
              <span className="hint font-mono">{textBytes} bytes</span>
            </div>
            <textarea
              id="gen-payload"
              value={payload}
              onChange={(e) => setPayload(e.target.value)}
              rows={4}
              placeholder={mode === "qc" ? "A link any phone camera will open…" : "Text, a link, JSON…"}
              className="input font-mono text-[13px] resize-y"
              style={{ minHeight: 104 }}
            />
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-2 text-xs">
              <span style={{ color: "var(--text-4)" }}>Examples:</span>
              {presets.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => setPayload(p.value)}
                  className="cursor-pointer hover:underline"
                  style={{ color: "var(--text-2)" }}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          {mode === "layered" && (
            <div>
              <div className="flex items-baseline justify-between mb-1.5">
                <label htmlFor="gen-fine" className="field-label !mb-0">Close-up content</label>
                <span className="hint font-mono">{new TextEncoder().encode(fineText).length} bytes</span>
              </div>
              <textarea
                id="gen-fine"
                value={fineText}
                onChange={(e) => setFineText(e.target.value)}
                rows={3}
                placeholder="Extra detail that only a close scan reads: batch, provenance, full record…"
                className="input font-mono text-[13px] resize-y"
              />
              <p className="hint mt-1.5">
                The first box becomes a black-and-white symbol that scans from far away. This text is hidden in fine colour tints
                and needs a closer scan. Signing and encryption apply to this part.
              </p>
            </div>
          )}

          {mode === "qc" && (
            <div>
              <div className="flex items-baseline justify-between mb-1.5">
                <label htmlFor="gen-hidden" className="field-label !mb-0">Hidden content (PACC scanners only)</label>
                <span className="hint font-mono">{new TextEncoder().encode(qcHidden).length} bytes</span>
              </div>
              <textarea
                id="gen-hidden"
                value={qcHidden}
                onChange={(e) => setQcHidden(e.target.value)}
                rows={2}
                placeholder="Private or signed data, tied to the visible QR…"
                className="input font-mono text-[13px] resize-y"
              />
              <p className="hint mt-1.5">Normal QR scanners open the visible content. PACC scanners also read and check the hidden part.</p>
            </div>
          )}

          {/* 3. Colours and strength */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <label className="block">
              <span className="field-label">Colours</span>
              <select
                value={mcs}
                onChange={(e) => setMcs(Number(e.target.value))}
                className="input"
                disabled={mode === "qc" || mode === "layered"}
              >
                {Object.entries(PACC_PALETTES).map(([id, p]) => (
                  <option key={id} value={id}>
                    {p.bits === 1 ? "Black & white" : `${2 ** p.bits} colours`} · {p.bits} bit{p.bits > 1 ? "s" : ""} per cell
                  </option>
                ))}
              </select>
              {(mode === "qc" || mode === "layered") && <span className="hint block mt-1">Fixed for this type.</span>}
            </label>
            <label className="block">
              <span className="field-label">Error correction</span>
              <select value={level} onChange={(e) => setLevel(e.target.value)} className="input">
                {Object.values(PACC_LEVELS).map(([name, num, den]) => (
                  <option key={name} value={name}>
                    {name} · {LEVEL_WORDS[name]} (rate {num}/{den})
                  </option>
                ))}
              </select>
            </label>
          </div>

          {mode === "stream" && (
            <div className="grid grid-cols-2 gap-4">
              <label className="block">
                <span className="field-label">Frame size</span>
                <select value={streamN} onChange={(e) => setStreamN(Number(e.target.value))} className="input">
                  {[32, 40, 48, 56, 64].map((n) => (
                    <option key={n} value={n}>{n} × {n} cells</option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="field-label">Speed</span>
                <select value={fps} onChange={(e) => setFps(Number(e.target.value))} className="input">
                  {[3, 4, 6, 8, 10].map((f) => (
                    <option key={f} value={f}>{f} frames / s</option>
                  ))}
                </select>
              </label>
            </div>
          )}

          {/* 4. Optional settings */}
          <div className="border-t" style={{ borderColor: "var(--border)" }}>
            <details className="disclosure border-b" style={{ borderColor: "var(--border)" }} open={sign || enc !== "none"}>
              <summary>
                <span className="flex items-center gap-2">
                  <ShieldCheck className="w-4 h-4" style={{ color: "var(--text-3)" }} />
                  Security
                </span>
                <span className="flex items-center gap-2 font-normal hint">
                  {securitySummary}
                  <ChevronDown className="chev w-4 h-4" />
                </span>
              </summary>
              <div className="pb-4 space-y-5">
                {/* Signature */}
                <div className="space-y-3">
                  <label className="flex items-start gap-2.5 cursor-pointer">
                    <input type="checkbox" checked={sign} onChange={(e) => setSign(e.target.checked)} className="mt-0.5 w-4 h-4" />
                    <span>
                      <span className="text-sm font-medium" style={{ color: "var(--text)" }}>Sign it</span>
                      <span className="hint block">Scanners can prove who made the symbol and that it was not changed.</span>
                    </span>
                  </label>
                  {sign && (
                    <div className="ml-6.5 space-y-3">
                      <div className="flex flex-wrap items-center gap-3">
                        <div className="seg">
                          {[ALG_ED25519, ALG_MLDSA44].map((a) => (
                            <button key={a} type="button" aria-pressed={signAlg === a} onClick={() => { setSignAlg(a); setSignPub(""); }}>
                              {a === ALG_ED25519 ? "Ed25519" : "ML-DSA-44 (post-quantum)"}
                            </button>
                          ))}
                        </div>
                        <label className="flex items-center gap-2 text-sm" style={{ color: "var(--text-2)" }}>
                          <input type="checkbox" checked={embedKey} onChange={(e) => setEmbedKey(e.target.checked)} className="w-4 h-4" />
                          Include public key
                        </label>
                      </div>
                      <div className="flex gap-2">
                        <input
                          type="password"
                          value={signSeed}
                          onChange={(e) => { setSignSeed(e.target.value); setSignPub(""); }}
                          placeholder="Private signing key (64 hex characters)"
                          className="input font-mono text-[13px]"
                        />
                        <button type="button" onClick={newSigningKey} className="btn-ghost shrink-0">
                          <KeyRound className="w-4 h-4" /> New key
                        </button>
                      </div>
                      {signPub && (
                        <CopyField label="Public key: share this so others can verify your symbols" value={signPub} />
                      )}
                    </div>
                  )}
                </div>

                {/* Encryption */}
                <div className="space-y-3">
                  <span className="text-sm font-medium" style={{ color: "var(--text)" }}>Encrypt it</span>
                  <div className="seg flex-wrap">
                    {([
                      ["none", "No"],
                      ["password", "Passphrase"],
                      ["recipient", "To a key"],
                      ["recipient-pq", "To a key (post-quantum)"],
                    ] as const).map(([id, label]) => (
                      <button
                        key={id}
                        type="button"
                        aria-pressed={enc === id}
                        onClick={() => { setEnc(id); setRecipient(""); setRecipientSecret(""); }}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  {enc === "password" && (
                    <div className="space-y-1.5">
                      <input
                        type="password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder="Passphrase (at least 12 characters)"
                        className="input"
                      />
                      <p className="hint">A printed symbol can be attacked offline forever, so use a long passphrase. Argon2id + ChaCha20-Poly1305.</p>
                    </div>
                  )}
                  {(enc === "recipient" || enc === "recipient-pq") && (
                    <div className="space-y-2">
                      <div className="flex gap-2">
                        <input
                          value={recipient}
                          onChange={(e) => { setRecipient(e.target.value); setRecipientSecret(""); }}
                          placeholder={enc === "recipient-pq" ? "Recipient X-Wing public key (2432 hex characters)" : "Recipient X25519 public key (64 hex characters)"}
                          className="input font-mono text-[13px]"
                        />
                        <button type="button" onClick={newRecipientKey} className="btn-ghost shrink-0">
                          <KeyRound className="w-4 h-4" /> New pair
                        </button>
                      </div>
                      {recipientSecret && (
                        <CopyField
                          label="Private key: give this only to the reader (add it under Scan → Keys)"
                          value={recipientSecret}
                        />
                      )}
                      <p className="hint">
                        {enc === "recipient-pq"
                          ? "HPKE with X-Wing (ML-KEM-768 + X25519). Adds about 1.1 KB to the symbol."
                          : "HPKE with X25519 (RFC 9180). Only the holder of the private key can read it."}
                      </p>
                    </div>
                  )}
                </div>
              </div>
            </details>

            <details className="disclosure">
              <summary>
                <span className="flex items-center gap-2">
                  <Sliders className="w-4 h-4" style={{ color: "var(--text-3)" }} />
                  Image size
                </span>
                <span className="flex items-center gap-2 font-normal hint">
                  {cellSize} px per cell
                  <ChevronDown className="chev w-4 h-4" />
                </span>
              </summary>
              <div className="pb-3">
                <input
                  type="range"
                  min={4}
                  max={20}
                  value={cellSize}
                  onChange={(e) => setCellSize(Number(e.target.value))}
                  className="w-full"
                  aria-label="Pixels per cell"
                />
              </div>
            </details>
          </div>

          <button onClick={handleGenerate} disabled={loading} className="btn-primary w-full h-11">
            {loading ? (
              <>
                <RefreshCw className="w-4 h-4 animate-spin" /> Generating…
              </>
            ) : (
              <>
                <QrCode className="w-4 h-4" /> Generate
              </>
            )}
          </button>

          {error && (
            <div
              className="p-3 rounded-lg text-sm flex items-start gap-2"
              style={{ background: "var(--danger-light)", color: "var(--danger)" }}
              role="alert"
            >
              <Info className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}
        </div>

        {/* Result */}
        <div className="lg:col-span-5 lg:sticky lg:top-20">
          {result?.dataUrl ? (
            <div className="card p-5 space-y-4">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-semibold" style={{ color: "var(--text)" }}>{modeTitle}</span>
                <span className="badge-neutral font-mono">
                  {result.gridSide} × {result.gridSide}
                </span>
              </div>

              <div className="rounded-lg p-4 flex items-center justify-center" style={{ background: "#fff", border: "1px solid var(--border)" }}>
                <img
                  src={streamFrames ? streamFrames[streamIdx % streamFrames.length] : result.dataUrl}
                  alt="Generated PACC symbol"
                  className="max-w-full h-auto object-contain"
                  style={{ imageRendering: "pixelated", maxHeight: 320 }}
                />
              </div>

              <dl className="grid grid-cols-4 gap-2 text-center">
                {[
                  ["Content", `${result.rawBytes} B`],
                  ["Cells", `${result.gridSide}²`],
                  ["Bits/cell", String(result.bitsPerCell)],
                  ["Time", `${result.durationMs} ms`],
                ].map(([k, v]) => (
                  <div key={k} className="rounded-lg py-2" style={{ background: "var(--surface-2)" }}>
                    <dt className="text-[11px]" style={{ color: "var(--text-3)" }}>{k}</dt>
                    <dd className="text-sm font-semibold font-mono" style={{ color: "var(--text)" }}>{v}</dd>
                  </div>
                ))}
              </dl>

              <div className="flex gap-2">
                <button onClick={() => handleDownload("png")} className="btn-primary flex-1">
                  <Download className="w-4 h-4" /> Download
                </button>
                {onNavigateToDecoder && (
                  <button type="button" onClick={() => onNavigateToDecoder(result.dataUrl!, "pacc")} className="btn-ghost">
                    <Scan className="w-4 h-4" /> Test scan
                  </button>
                )}
                <button onClick={handleCopyDataUrl} className="btn-ghost px-3" title="Copy image as data URL" aria-label="Copy image as data URL">
                  {copied ? <Check className="w-4 h-4" style={{ color: "var(--accent)" }} /> : <Copy className="w-4 h-4" />}
                </button>
              </div>
            </div>
          ) : (
            <div
              className="rounded-xl p-10 text-center"
              style={{ border: "1px dashed var(--border-strong)", background: "var(--surface)" }}
            >
              <QrCode className="w-8 h-8 mx-auto mb-3" style={{ color: "var(--text-4)" }} />
              <p className="text-sm font-medium" style={{ color: "var(--text-2)" }}>Your symbol will appear here</p>
              <p className="hint mt-1">Press Generate to create it.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

const LEVEL_WORDS: Record<string, string> = { L: "Low", M: "Medium", Q: "High", H: "Highest" };

function CopyField({ label, value }: { label: string; value: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="rounded-lg p-3 space-y-1.5" style={{ background: "var(--surface-2)" }}>
      <div className="text-xs" style={{ color: "var(--text-2)" }}>{label}</div>
      <div className="flex gap-2">
        <input readOnly value={value} className="input font-mono text-xs !py-1.5" onFocus={(e) => e.currentTarget.select()} />
        <button
          type="button"
          className="btn-ghost !min-h-0 !py-1.5 px-2.5 shrink-0"
          onClick={() => {
            navigator.clipboard?.writeText(value);
            setDone(true);
            setTimeout(() => setDone(false), 1500);
          }}
          aria-label="Copy"
        >
          {done ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
        </button>
      </div>
    </div>
  );
}
