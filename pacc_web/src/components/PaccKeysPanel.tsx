"use client";
/**
 * PACC key management (prototype).
 *
 * - "decoder" mode: trusted signer public keys (kept in localStorage — they are public)
 *   and recipient private keys (kept in memory only, never persisted), pushed to the
 *   PACC worker so every decode verifies signatures and opens recipient-encrypted symbols.
 * - "generator" mode: create signing keys and recipient key pairs to copy elsewhere.
 */
import React, { useEffect, useRef, useState } from "react";
import { KeyRound, Plus, Trash2, ChevronDown, ChevronUp, Copy } from "lucide-react";
import { setPacc2Secrets, type WireSecrets } from "@/lib/pacc/client";
import {
  ALG_ED25519, ALG_MLDSA44, ALG_NAMES, fingerprint, fromHex, generatePqRecipientKey, generateRecipientKey, generateSigningKey,
  pqRecipientKeyFromSeed, pqRecipientKid, recipientKeyFromPrivate, recipientKid, toHex,
} from "@/lib/pacc/secure";

const TRUSTED_KEY = "pacc2.trustedSigners";

interface Trusted {
  alg: number;
  publicKeyHex: string;
  fingerprint: string;
  label: string;
}

function loadTrusted(): Trusted[] {
  try {
    const raw = localStorage.getItem(TRUSTED_KEY);
    return raw ? (JSON.parse(raw) as Trusted[]) : [];
  } catch {
    return [];
  }
}

// Recipient secrets live in module memory: they survive tab switches but never touch storage.
let sessionRecipients: string[] = [];

const field = "w-full px-2.5 py-1.5 rounded-lg text-xs font-mono border bg-white";
const btn = "smooth-press px-2.5 py-1 rounded-lg text-xs border cursor-pointer flex items-center space-x-1";

export function PaccDecoderKeys({ onKeysChanged }: { onKeysChanged?: () => void } = {}) {
  const [open, setOpen] = useState(false);
  const onKeysChangedRef = useRef(onKeysChanged);
  useEffect(() => {
    onKeysChangedRef.current = onKeysChanged;
  });
  const [trusted, setTrusted] = useState<Trusted[]>([]);
  // Recipient secrets: "x25519:<hex>" or "xwing:<hex>" (post-quantum), memory only.
  const [recipients, setRecipients] = useState<string[]>(() => sessionRecipients);
  const [recipientKind, setRecipientKind] = useState<"x25519" | "xwing">("x25519");
  const [pub, setPub] = useState("");
  const [alg, setAlg] = useState(ALG_ED25519);
  const [label, setLabel] = useState("");
  const [priv, setPriv] = useState("");
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    // localStorage is only available after mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTrusted(loadTrusted());
  }, []);

  useEffect(() => {
    const of = (kind: string) => recipients.filter((r) => r.startsWith(kind + ":")).map((r) => r.slice(kind.length + 1));
    const secrets: WireSecrets = { trustedSigners: trusted, recipientPrivateHex: of("x25519"), pqRecipientSeedHex: of("xwing") };
    sessionRecipients = recipients;
    setPacc2Secrets(secrets)
      .then(() => onKeysChangedRef.current?.())
      .catch(() => {});
    try {
      localStorage.setItem(TRUSTED_KEY, JSON.stringify(trusted));
    } catch {
      /* storage unavailable */
    }
  }, [trusted, recipients]);

  const addTrusted = () => {
    try {
      const key = fromHex(pub);
      const expected = alg === ALG_ED25519 ? 32 : 1312;
      if (key.length !== expected) throw new Error(`${ALG_NAMES[alg]} public keys are ${expected} bytes`);
      const fp = toHex(fingerprint(alg, key));
      setTrusted((t) => [...t.filter((x) => x.fingerprint !== fp), { alg, publicKeyHex: toHex(key), fingerprint: fp, label: label || fp }]);
      setPub("");
      setLabel("");
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const addRecipient = () => {
    try {
      const k = fromHex(priv);
      if (k.length !== 32) throw new Error(recipientKind === "xwing" ? "X-Wing seeds are 32 bytes" : "X25519 private keys are 32 bytes");
      setRecipients((r) => [...r, `${recipientKind}:${toHex(k)}`]);
      setPriv("");
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="card p-3 space-y-3 text-xs">
      <button className="w-full flex items-center justify-between cursor-pointer" onClick={() => setOpen((o) => !o)}>
        <span className="flex items-center space-x-1.5 font-semibold" style={{ color: "var(--text)" }}>
          <KeyRound className="w-3.5 h-3.5" />
          <span>Keys</span>
          <span className="font-normal text-stone-500">
            · {trusted.length} trusted signer{trusted.length === 1 ? "" : "s"} · {recipients.length} private key{recipients.length === 1 ? "" : "s"}
          </span>
        </span>
        {open ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
      </button>
      {open && (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <div className="font-semibold text-stone-700">Trusted signers: public keys of people you trust</div>
            {trusted.map((t) => (
              <div key={t.fingerprint} className="flex items-center justify-between gap-2">
                <span className="font-mono truncate">{t.label} · {ALG_NAMES[t.alg]} · {t.fingerprint}</span>
                <button className={btn} onClick={() => setTrusted((x) => x.filter((y) => y.fingerprint !== t.fingerprint))} aria-label="Remove signer">
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            ))}
            <div className="flex gap-1.5">
              <select className={field + " w-auto"} value={alg} onChange={(e) => setAlg(Number(e.target.value))}>
                <option value={ALG_ED25519}>Ed25519</option>
                <option value={ALG_MLDSA44}>ML-DSA-44</option>
              </select>
              <input className={field} placeholder="label" value={label} onChange={(e) => setLabel(e.target.value)} />
            </div>
            <div className="flex gap-1.5">
              <input className={field} placeholder="public key (hex)" value={pub} onChange={(e) => setPub(e.target.value)} />
              <button className={btn} onClick={addTrusted}><Plus className="w-3 h-3" /><span>Trust</span></button>
            </div>
          </div>
          <div className="space-y-1.5">
            <div className="font-semibold text-stone-700">Private keys for encrypted symbols (kept only while this tab is open)</div>
            {recipients.map((entry, i) => {
              const [kind, h] = entry.split(":");
              const kid = kind === "xwing"
                ? toHex(pqRecipientKid(pqRecipientKeyFromSeed(fromHex(h)).publicKey))
                : toHex(recipientKid(recipientKeyFromPrivate(fromHex(h)).publicKey));
              return (
              <div key={entry} className="flex items-center justify-between gap-2">
                <span className="font-mono truncate">{kind === "xwing" ? "X-Wing (post-quantum)" : "X25519"} · key id {kid}</span>
                <button className={btn} onClick={() => setRecipients((r) => r.filter((_, j) => j !== i))} aria-label="Remove key">
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
              );
            })}
            <div className="flex gap-1.5">
              <select className={field + " w-auto"} value={recipientKind} onChange={(e) => setRecipientKind(e.target.value as "x25519" | "xwing")}>
                <option value="x25519">X25519</option>
                <option value="xwing">X-Wing (PQ)</option>
              </select>
              <input
                className={field}
                type="password"
                placeholder={recipientKind === "xwing" ? "X-Wing seed (hex)" : "X25519 private key (hex)"}
                value={priv}
                onChange={(e) => setPriv(e.target.value)}
              />
              <button className={btn} onClick={addRecipient}><Plus className="w-3 h-3" /><span>Add</span></button>
            </div>
          </div>
          {err && <div className="text-red-700">{err}</div>}
        </div>
      )}
    </div>
  );
}

function CopyRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-0.5">
      <div className="text-stone-600">{label}</div>
      <div className="flex gap-1.5">
        <input readOnly className={field} value={value} />
        <button className={btn} onClick={() => navigator.clipboard?.writeText(value)} aria-label={`Copy ${label}`}>
          <Copy className="w-3 h-3" />
        </button>
      </div>
    </div>
  );
}

/** Key generator for the Generator tab. */
export function Pacc2KeyGenerator() {
  const [sig, setSig] = useState<{ alg: number; seed: string; pub: string; fp: string } | null>(null);
  const [rec, setRec] = useState<{ priv: string; pub: string; kid: string; pq: boolean } | null>(null);
  return (
    <div className="space-y-2 text-xs">
      <div className="flex flex-wrap gap-1.5">
        {[ALG_ED25519, ALG_MLDSA44].map((a) => (
          <button key={a} className={btn} onClick={() => {
            const k = generateSigningKey(a);
            setSig({ alg: a, seed: toHex(k.seed), pub: toHex(k.publicKey), fp: toHex(fingerprint(a, k.publicKey)) });
          }}>
            <KeyRound className="w-3 h-3" /><span>New {ALG_NAMES[a]} signing key</span>
          </button>
        ))}
        <button className={btn} onClick={() => {
          const k = generateRecipientKey();
          setRec({ priv: toHex(k.privateKey), pub: toHex(k.publicKey), kid: toHex(recipientKid(k.publicKey)), pq: false });
        }}>
          <KeyRound className="w-3 h-3" /><span>New recipient key pair</span>
        </button>
        <button className={btn} onClick={() => {
          const k = generatePqRecipientKey();
          setRec({ priv: toHex(k.seed), pub: toHex(k.publicKey), kid: toHex(pqRecipientKid(k.publicKey)), pq: true });
        }}>
          <KeyRound className="w-3 h-3" /><span>New post-quantum recipient key (X-Wing)</span>
        </button>
      </div>
      {sig && (
        <div className="space-y-1 rounded-lg border p-2" style={{ borderColor: "var(--border)" }}>
          <CopyRow label={`${ALG_NAMES[sig.alg]} private seed — keep secret`} value={sig.seed} />
          <CopyRow label={`Public key (fingerprint ${sig.fp}) — give to verifiers`} value={sig.pub} />
        </div>
      )}
      {rec && (
        <div className="space-y-1 rounded-lg border p-2" style={{ borderColor: "var(--border)" }}>
          <CopyRow label={`${rec.pq ? "X-Wing seed" : "X25519 private key"} (key id ${rec.kid}) — keep secret`} value={rec.priv} />
          <CopyRow label="Public key — encrypt to this" value={rec.pub} />
        </div>
      )}
      <p className="text-stone-500">Prototype key handling: keys are generated in this browser and are not stored.</p>
    </div>
  );
}

export const PaccKeyGenerator = Pacc2KeyGenerator;
export const Pacc2DecoderKeys = PaccDecoderKeys;
