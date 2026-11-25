"use client";
/**
 * Matrix tab — PACC scaling and configuration suites, generated and verified entirely in
 * the browser worker: every card is encoded, rendered, decoded from its own pixels and timed.
 */
import React, { useEffect, useMemo, useState } from "react";
import {
  Download, Scan, RefreshCw, X, Grid, Copy, Check, Layers, Sliders, CheckCircle2, Zap, ShieldCheck,
  Maximize2, Lock,
} from "lucide-react";
import { PaccVersionItem } from "@/lib/types";
import { matrixItemPacc, type WireSecrets, type WireSecurity } from "@/lib/pacc/client";
import { capacity } from "@/lib/pacc/codec";
import { renderGrid } from "@/lib/pacc/index";
import {
  ALG_ED25519, ALG_MLDSA44, fingerprint, generatePqRecipientKey, generateRecipientKey, generateSigningKey, toHex,
} from "@/lib/pacc/secure";
import { LEVELS, PALETTES, gridSizes } from "@/lib/pacc/spec";
import { errorMessage } from "@/lib/errors";

export type MatrixMode = "grid_versions" | "config_matrix" | "security_matrix";

interface TestMatrixTabProps {
  payload: string;
  setPayload: (val: string) => void;
  onNavigateToDecoder?: (dataUrl?: string) => void;
  matrixCache?: Record<string, PaccVersionItem[]>;
  setMatrixCache?: React.Dispatch<React.SetStateAction<Record<string, PaccVersionItem[]>>>;
  currentMode?: MatrixMode;
  setCurrentMode?: (mode: MatrixMode) => void;
  onEnlargedChange?: (enlarged: boolean) => void;
}

const LEVEL_NAMES = Object.values(LEVELS).map(([name]) => name); // L, M, Q, H
const rateOf = (level: number) => `${LEVELS[level][1]}/${LEVELS[level][2]}`;
const CELL_PX = 4;
const PASSPHRASE = "matrix suite passphrase 2026";

function gridToDataUrl(grid: Uint8Array, n: number): string {
  const img = renderGrid(grid, n, CELL_PX) as ImageData;
  const canvas = document.createElement("canvas");
  canvas.width = img.width;
  canvas.height = img.height;
  canvas.getContext("2d")!.putImageData(img, 0, 0);
  return canvas.toDataURL("image/png");
}

/** Deterministic, incompressible-looking text of exactly `len` bytes (fills a grid to capacity). */
function fillerText(len: number, seed: number): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let x = (seed * 2654435761) >>> 0 || 1;
  let out = "";
  for (let i = 0; i < len; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out += alphabet[(x >>> 0) % alphabet.length];
  }
  return out;
}

interface Job {
  title: string;
  text: string;
  mcs: number;
  level: string;
  minGrid?: number;
  compress: boolean;
  variant?: string;
  security?: WireSecurity;
  secrets?: WireSecrets;
  password?: string;
}

function securityJobs(text: string, mcs: number, level: string): Job[] {
  const ed = generateSigningKey(ALG_ED25519);
  const pq = generateSigningKey(ALG_MLDSA44);
  const rk = generateRecipientKey();
  const xk = generatePqRecipientKey();
  const trusted = (k: typeof ed): WireSecrets => ({
    trustedSigners: [{ alg: k.alg, publicKeyHex: toHex(k.publicKey), fingerprint: toHex(fingerprint(k.alg, k.publicKey)) }],
  });
  const base = { text, mcs, level, compress: true };
  return [
    { ...base, title: "Plain", variant: "plain" },
    { ...base, title: "Ed25519 · embedded key", variant: "Ed25519", security: { sign: { alg: ed.alg, seedHex: toHex(ed.seed), embed: true } } },
    { ...base, title: "Ed25519 · key id", variant: "Ed25519 (key id)", security: { sign: { alg: ed.alg, seedHex: toHex(ed.seed), embed: false } }, secrets: trusted(ed) },
    { ...base, title: "ML-DSA-44 · key id", variant: "ML-DSA-44", security: { sign: { alg: pq.alg, seedHex: toHex(pq.seed), embed: false } }, secrets: trusted(pq) },
    { ...base, title: "Passphrase (Argon2id)", variant: "passphrase", security: { password: PASSPHRASE, kdfProfile: 0 }, password: PASSPHRASE },
    { ...base, title: "Recipient · X25519", variant: "HPKE X25519", security: { recipientHex: toHex(rk.publicKey) }, secrets: { recipientPrivateHex: [toHex(rk.privateKey)] } },
    { ...base, title: "Recipient · X-Wing (PQ)", variant: "HPKE X-Wing", security: { recipientPqHex: toHex(xk.publicKey) }, secrets: { pqRecipientSeedHex: [toHex(xk.seed)] } },
    {
      ...base, title: "ML-DSA-44 + X-Wing", variant: "fully post-quantum",
      security: { sign: { alg: pq.alg, seedHex: toHex(pq.seed), embed: false }, recipientPqHex: toHex(xk.publicKey) },
      secrets: { ...trusted(pq), pqRecipientSeedHex: [toHex(xk.seed)] },
    },
  ];
}

export const TestMatrixTab: React.FC<TestMatrixTabProps> = ({
  payload, setPayload, onNavigateToDecoder, matrixCache, setMatrixCache, currentMode, setCurrentMode, onEnlargedChange,
}) => {
  const [internalMode, setInternalMode] = useState<MatrixMode>("grid_versions");
  const mode: MatrixMode = (["grid_versions", "config_matrix", "security_matrix"] as const).includes(currentMode as MatrixMode)
    ? (currentMode as MatrixMode) : internalMode;
  const setMode = (m: MatrixMode) => {
    setCurrentMode?.(m);
    setInternalMode(m);
  };
  const [internalCache, setInternalCache] = useState<Record<string, PaccVersionItem[]>>({});
  const cache = matrixCache ?? internalCache;
  const setCacheEntry = (key: string, items: PaccVersionItem[]) => {
    if (setMatrixCache) setMatrixCache((prev) => ({ ...prev, [key]: items }));
    else setInternalCache((prev) => ({ ...prev, [key]: items }));
  };

  const [mcs, setMcs] = useState<number>(1);
  const [level, setLevel] = useState<string>("Q");
  const [isLoading, setIsLoading] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Options that do not fit at the chosen colours / error correction (skipped, not failures).
  const [skipped, setSkipped] = useState<string[]>([]);
  const [lightboxItem, setLightboxItem] = useState<PaccVersionItem | null>(null);
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [scaleFilter, setScaleFilter] = useState<"all" | "small" | "mid" | "large">("all");

  useEffect(() => {
    onEnlargedChange?.(Boolean(lightboxItem));
  }, [lightboxItem, onEnlargedChange]);
  useEffect(() => () => onEnlargedChange?.(false), [onEnlargedChange]);

  const levelIdx = LEVEL_NAMES.indexOf(level);
  const activeKey = mode === "grid_versions" ? `${mode}_m${mcs}_${level}` : mode === "security_matrix" ? `${mode}_m${mcs}_${level}` : mode;
  const versions = useMemo(() => cache[activeKey] ?? [], [cache, activeKey]);

  const buildJobs = (m: MatrixMode): Job[] => {
    const text = payload || "https://example.com/pacc";
    if (m === "grid_versions") {
      return gridSizes().map((n, i) => {
        const cap = capacity(n, mcs, levelIdx);
        return { title: `${n}×${n}`, text: fillerText(cap, i + 1), mcs, level, minGrid: n, compress: false };
      });
    }
    if (m === "config_matrix") {
      const jobs: Job[] = [];
      for (const k of Object.keys(PALETTES).map(Number))
        for (const lv of LEVEL_NAMES) jobs.push({ title: `${PALETTES[k].name} · ${lv}`, text, mcs: k, level: lv, compress: true });
      return jobs;
    }
    return securityJobs(text, mcs, level);
  };

  const runSuite = async (m: MatrixMode = mode) => {
    const key = m === "config_matrix" ? m : `${m}_m${mcs}_${level}`;
    setIsLoading(true);
    setError(null);
    setSkipped([]);
    const jobs = buildJobs(m);
    setProgress({ done: 0, total: jobs.length });
    const items: PaccVersionItem[] = [];
    try {
      for (let i = 0; i < jobs.length; i++) {
        const j = jobs[i];
        const bytes = new TextEncoder().encode(j.text);
        let r;
        try {
          r = await matrixItemPacc(bytes, {
            mcs: j.mcs, level: j.level, minGrid: j.minGrid, compress: j.compress, cellSize: CELL_PX,
            security: j.security, secrets: j.secrets, password: j.password,
          });
        } catch (err: unknown) {
          const msg = errorMessage(err, "");
          if (!/exceeds the largest/.test(msg)) throw err;
          setSkipped((prev) => [...prev, `${j.title} (${msg.match(/(\d+) bytes/)?.[1] ?? "?"} B)`]);
          setProgress({ done: i + 1, total: jobs.length });
          continue;
        }
        const cap = capacity(r.n, r.mcs, r.level);
        items.push({
          version: i + 1,
          title: j.title,
          gridSide: r.n,
          totalCells: r.n * r.n,
          payloadBytes: bytes.length,
          capacityBytes: cap,
          payload: j.text,
          eccLevel: r.level,
          eccLabel: `${LEVEL_NAMES[r.level]} · LDPC ${rateOf(r.level)}`,
          codeRate: rateOf(r.level),
          minCopies: 1,
          bitsPerCell: PALETTES[r.mcs].bits,
          mcsName: PALETTES[r.mcs].name,
          variant: j.variant,
          compressed: r.compressed,
          encrypted: Boolean(r.encrypted),
          fillPercent: Math.min(100, Math.round((100 * bytes.length) / Math.max(cap, 1))),
          encodeMs: Math.round(r.encodeMs * 10) / 10,
          decodeMs: Math.round(r.decodeMs * 10) / 10,
          decoded: r.decoded,
          error: r.error,
          dataUrl: gridToDataUrl(r.grid, r.n),
        });
        setCacheEntry(key, [...items]);
        setProgress({ done: i + 1, total: jobs.length });
      }
    } catch (err: unknown) {
      setError(errorMessage(err, "Matrix generation failed"));
    } finally {
      setIsLoading(false);
      setProgress(null);
    }
  };

  const stats = useMemo(() => {
    const total = versions.length;
    if (!total) return { total: 0, passed: 0, passRate: 0, avgEncode: 0, avgDecode: 0, maxCap: 0 };
    const passed = versions.filter((v) => v.decoded).length;
    const avg = (f: (v: PaccVersionItem) => number) => Math.round((versions.reduce((s, v) => s + f(v), 0) / total) * 10) / 10;
    return {
      total, passed, passRate: Math.round((passed / total) * 100),
      avgEncode: avg((v) => v.encodeMs), avgDecode: avg((v) => v.decodeMs),
      maxCap: Math.max(...versions.map((v) => v.capacityBytes ?? 0)),
    };
  }, [versions]);

  const filtered = useMemo(() => {
    if (mode !== "grid_versions" || scaleFilter === "all") return versions;
    return versions.filter((v) => (scaleFilter === "small" ? v.gridSide <= 60 : scaleFilter === "mid" ? v.gridSide > 60 && v.gridSide <= 104 : v.gridSide > 104));
  }, [versions, scaleFilter, mode]);

  const download = (v: PaccVersionItem) => {
    const a = document.createElement("a");
    a.href = v.dataUrl;
    a.download = `pacc_${(v.mcsName ?? "").toLowerCase()}_${v.gridSide}x${v.gridSide}_${v.version}.png`;
    a.click();
  };
  const copy = (id: number, text: string) => {
    navigator.clipboard?.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const modeCards: { id: MatrixMode; label: string; sublabel: string; badge: string; icon: typeof Grid }[] = [
    { id: "grid_versions", label: "Every size", sublabel: "All 32 sizes from 24×24 to 148×148, each filled to capacity", badge: `${capacity(148, mcs, levelIdx).toLocaleString()} B max`, icon: Grid },
    { id: "config_matrix", label: "Colours × strength", sublabel: "3 colour sets × 4 error-correction levels, one content", badge: "12 configs", icon: Sliders },
    { id: "security_matrix", label: "Security options", sublabel: "Every signature and encryption choice, incl. post-quantum", badge: "8 variants", icon: Lock },
  ];

  return (
    <div className="w-full max-w-6xl mx-auto space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h1 className="page-title">Matrix</h1>
          <p className="page-sub">
            See how much fits and check that it scans. Each symbol is created, drawn and read back from its pixels in your browser.
          </p>
        </div>
        <button onClick={() => runSuite()} disabled={isLoading} className="btn-primary shrink-0">
          <RefreshCw className={`w-4 h-4 ${isLoading ? "animate-spin" : ""}`} />
          <span>{isLoading && progress ? `Checking ${progress.done}/${progress.total}` : versions.length ? "Run again" : "Run"}</span>
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        {modeCards.map((m) => {
          const Icon = m.icon;
          return (
            <button key={m.id} onClick={() => setMode(m.id)} aria-pressed={mode === m.id} className="tile">
              <div className="flex items-center justify-between gap-2">
                <span className="tile-title flex items-center gap-2">
                  <Icon className="w-4 h-4" style={{ color: "var(--text-3)" }} />
                  {m.label}
                </span>
                <span className="badge-neutral font-mono">{m.badge}</span>
              </div>
              <div className="tile-desc mt-1">{m.sublabel}</div>
            </button>
          );
        })}
      </div>

      <div className="card p-3 flex flex-col lg:flex-row lg:items-center justify-between gap-3">
        {mode !== "config_matrix" ? (
          <div className="flex flex-wrap items-center gap-3 sm:gap-4">
            <div className="flex items-center gap-2">
              <span className="text-sm" style={{ color: "var(--text-3)" }}>Colours</span>
              <div className="seg">
                {Object.entries(PALETTES).map(([k, p]) => (
                  <button key={k} onClick={() => setMcs(Number(k))} aria-pressed={mcs === Number(k)} title={`${p.name}: ${p.bits} bit/cell`}>
                    {p.bits === 1 ? "B&W" : `${2 ** p.bits}`}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sm" style={{ color: "var(--text-3)" }}>Error correction</span>
              <div className="seg">
                {LEVEL_NAMES.map((lv, i) => (
                  <button key={lv} onClick={() => setLevel(lv)} aria-pressed={level === lv} title={`rate ${rateOf(i)}`}>
                    {lv}
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : null}
        {mode !== "grid_versions" && (
          <div className="flex-1 flex items-center gap-2">
            <span className="text-sm shrink-0" style={{ color: "var(--text-3)" }}>Content</span>
            <input value={payload} onChange={(e) => setPayload(e.target.value)} placeholder="Text or URL to encode in every configuration..." className="input flex-1 font-mono text-[13px] !py-1.5" />
            <span className="badge-neutral font-mono shrink-0">
              {new TextEncoder().encode(payload).length} B
            </span>
          </div>
        )}
        {mode === "grid_versions" && (
          <div className="mobile-pill-scroll shrink-0">
            <div className="seg">
              {([["all", `All ${versions.length || 32}`], ["small", "≤ 60"], ["mid", "64–104"], ["large", "≥ 108"]] as const).map(([id, label]) => (
                <button key={id} onClick={() => setScaleFilter(id)} aria-pressed={scaleFilter === id}>
                  {label}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {versions.length > 0 && (
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
        {[
          { label: "Symbols", value: `${stats.total}`, sub: mode === "grid_versions" ? "sizes" : "configs", icon: Layers },
          { label: "Decoded", value: `${stats.passRate}%`, sub: `${stats.passed}/${stats.total}`, icon: CheckCircle2 },
          { label: "Mean time", value: `${stats.avgDecode} ms`, sub: `decode · ${stats.avgEncode} ms encode`, icon: Zap },
          { label: "Max capacity", value: `${stats.maxCap.toLocaleString()} B`, sub: "in this suite", icon: ShieldCheck },
        ].map((k) => (
          <div key={k.label} className="card p-3.5">
            <div className="flex items-center justify-between text-xs" style={{ color: "var(--text-3)" }}>
              <span>{k.label}</span>
              <k.icon className="w-3.5 h-3.5" />
            </div>
            <div className="mt-1.5 flex items-baseline gap-2 flex-wrap">
              <span className="text-xl font-semibold font-mono" style={{ color: "var(--text)" }}>{k.value}</span>
              <span className="text-xs" style={{ color: "var(--text-3)" }}>{k.sub}</span>
            </div>
          </div>
        ))}
      </div>
      )}

      {skipped.length > 0 && !isLoading && (
        <div className="p-3 rounded-lg text-sm bg-amber-50 text-amber-900">
          Too large for this setting, so skipped: {skipped.join(", ")}. Try 8 colours or a lower error-correction level.
        </div>
      )}

      {error && (
        <div className="p-3.5 rounded-xl border text-xs" style={{ background: "var(--danger-light)", borderColor: "var(--danger)", color: "var(--danger)" }}>
          {error}
        </div>
      )}

      {versions.length === 0 ? (
        <div className="rounded-xl p-10 sm:p-14 text-center flex flex-col items-center gap-3" style={{ border: "1px dashed var(--border-strong)", background: "var(--surface)" }}>
          {isLoading ? <RefreshCw className="w-8 h-8 animate-spin" style={{ color: "var(--accent)" }} /> : <Grid className="w-8 h-8" style={{ color: "var(--text-4)" }} />}
          <p className="text-sm max-w-md" style={{ color: "var(--text-2)" }}>
            {isLoading ? "Creating and checking symbols…" : "Pick a set above and press Run."}
          </p>
          {!isLoading && <p className="hint">Nothing is sent to a server.</p>}
        </div>
      ) : (
        <div className="grid grid-cols-1 xs:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3 sm:gap-4">
          {filtered.map((v) => (
            <div key={v.version} className="nature-card p-3 sm:p-4 flex flex-col space-y-3 group" style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
              <div className="flex items-center justify-between gap-1">
                <div className="flex items-center gap-1 flex-wrap">
                  <span className="badge-green text-[10px] font-mono font-bold">{v.title}</span>
                  {mode !== "grid_versions" && (
                    <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-stone-100 text-stone-600 border border-stone-200">{v.gridSide}×{v.gridSide}</span>
                  )}
                </div>
                <span className={`text-[10px] font-mono font-bold ${v.decoded ? "text-emerald-700" : "text-red-700"}`}>{v.decoded ? "✓ decoded" : "✗ failed"}</span>
              </div>
              <button onClick={() => setLightboxItem(v)} className="p-2 sm:p-3 rounded-2xl flex items-center justify-center bg-white border cursor-pointer relative" style={{ borderColor: "var(--border)" }} title="Inspect">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={v.dataUrl} alt={`PACC ${v.title}`} className="w-28 h-28 sm:w-36 sm:h-36 object-contain" style={{ imageRendering: "pixelated" }} />
                <Maximize2 className="w-4 h-4 absolute top-2 right-2 text-stone-500 opacity-0 group-hover:opacity-80 transition-opacity" />
              </button>
              <div className="space-y-1.5 pt-1 border-t text-xs" style={{ borderColor: "var(--border)" }}>
                <Row label="Payload" value={`${v.payloadBytes} B${v.compressed ? " (deflated)" : ""}`} />
                <Row label="Grid capacity" value={`${v.capacityBytes} B · ${v.fillPercent}% full`} />
                <Row label="Code" value={`${v.mcsName} · ${v.eccLabel}`} />
                {v.variant && <Row label="Envelope" value={v.variant} />}
                <Row label="Timing" value={`${v.encodeMs} ms enc · ${v.decodeMs} ms dec`} accent />
                {v.error && <div className="text-[10px] text-red-700 font-mono truncate" title={v.error}>{v.error}</div>}
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                <button onClick={() => download(v)} className="btn-ghost h-8 text-[11px] cursor-pointer"><Download className="w-3 h-3" /><span>Download</span></button>
                {onNavigateToDecoder && (
                  <button onClick={() => onNavigateToDecoder(v.dataUrl)} className="btn-primary h-8 text-[11px] cursor-pointer"><Scan className="w-3 h-3" /><span>Decode</span></button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {lightboxItem && (
        <div className="fixed inset-0 z-[100000] bg-black/50 backdrop-blur-sm flex items-center justify-center p-4" onClick={() => setLightboxItem(null)}>
          <div className="nature-card p-6 max-w-md w-full shadow-2xl space-y-4" style={{ background: "var(--surface)", border: "1px solid var(--border-mid)" }} onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <span className="badge-green text-sm font-mono font-bold">{lightboxItem.title}</span>
              <button onClick={() => setLightboxItem(null)} className="w-8 h-8 rounded-xl bg-stone-100 flex items-center justify-center cursor-pointer" title="Close">
                <X className="w-4 h-4 text-stone-600" />
              </button>
            </div>
            <div className="p-4 bg-white rounded-2xl border flex items-center justify-center" style={{ borderColor: "var(--border)" }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={lightboxItem.dataUrl} alt={`PACC ${lightboxItem.title}`} className="w-64 h-64 object-contain" style={{ imageRendering: "pixelated" }} />
            </div>
            <div className="p-3.5 rounded-xl space-y-1.5 text-xs font-mono border" style={{ background: "var(--surface-2)", borderColor: "var(--border)" }}>
              <Row label="Grid" value={`${lightboxItem.gridSide}×${lightboxItem.gridSide} (${lightboxItem.totalCells} cells)`} />
              <Row label="Stored / capacity" value={`${lightboxItem.payloadBytes} / ${lightboxItem.capacityBytes} B`} />
              <Row label="Code" value={`${lightboxItem.mcsName} (${lightboxItem.bitsPerCell} b/cell) · ${lightboxItem.eccLabel}`} />
              {lightboxItem.variant && <Row label="Envelope" value={lightboxItem.variant} />}
            </div>
            <div className="flex items-center gap-2">
              <div className="p-2.5 rounded-xl font-mono text-[11px] max-h-24 overflow-y-auto break-all border flex-1" style={{ background: "var(--surface-2)", borderColor: "var(--border)", color: "var(--text)" }}>
                {lightboxItem.payload}
              </div>
              <button onClick={() => copy(lightboxItem.version, lightboxItem.payload ?? "")} className="p-2 rounded-lg cursor-pointer" title="Copy payload">
                {copiedId === lightboxItem.version ? <Check className="w-4 h-4 text-emerald-600" /> : <Copy className="w-4 h-4 text-stone-400" />}
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <button onClick={() => download(lightboxItem)} className="btn-ghost h-9 cursor-pointer"><Download className="w-3.5 h-3.5" /><span>Save PNG</span></button>
              {onNavigateToDecoder && (
                <button onClick={() => { const url = lightboxItem.dataUrl; setLightboxItem(null); onNavigateToDecoder(url); }} className="btn-primary h-9 cursor-pointer">
                  <Scan className="w-3.5 h-3.5" /><span>Test in Decoder</span>
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

function Row({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span style={{ color: "var(--text-3)" }}>{label}</span>
      <span className="font-mono text-[10px] text-right truncate" style={{ color: accent ? "var(--accent)" : "var(--text-2)" }}>{value}</span>
    </div>
  );
}
