"""
PACC benchmark suite (synthetic; for the paper's simulation section).

    N1  capacity & density     bytes per symbol, bits per module, symbol size for equal payloads
    N2  robustness             everyday capture conditions at equal printed footprint, paired seeds,
                               Wilson 95% CIs, McNemar PACC vs QR-H
    N3  ablations              contribution of each decoder element on the most demanding of them
    N4  latency                Python encode/decode time vs grid size and palette
    N5  security overhead      envelope bytes, resulting grid size, sign/seal/open timings
    N6  multi-frame combining  hand-held video in dim light with a moving reflection: single frames,
                               any single frame within k frames (what every reader gets), and PACC's
                               combination of frames
    N7  layers & QC            layered fine/coarse readability vs resolution; QR-compatible
                               mode: standard-reader success on tinted vs plain QR, hidden channel

Protocols: "everyday" (default) uses the conditions of everyday phone scanning (common.SWEEPS);
"stress" uses breaking-point conditions (common.STRESS_SWEEPS and the original N3/N6/N7 settings).

Every function returns a JSON-serialisable dict and writes its CSV/PNG into out_dir.
"""
from __future__ import annotations

import csv
import os
import time
from concurrent.futures import ProcessPoolExecutor
from typing import Any

import cv2
import numpy as np

from pacc_bench import common as C


def _write_csv(path: str, rows: list[dict]) -> None:
    if not rows:
        return
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)


def _plt():
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    return plt


# ── N1 capacity & density ─────────────────────────────────────────────────────

def _qr_capacity(version: int, ec: str) -> int:
    """Byte-mode capacity of a QR version/EC level (ISO/IEC 18004 tables via `qrcode`)."""
    from qrcode import base, constants
    level = {"L": constants.ERROR_CORRECT_L, "M": constants.ERROR_CORRECT_M,
             "Q": constants.ERROR_CORRECT_Q, "H": constants.ERROR_CORRECT_H}[ec]
    data_cw = sum(b.data_count for b in base.rs_blocks(version, level))
    count_bits = 8 if version <= 9 else 16
    return (data_cw * 8 - 4 - count_bits) // 8


def bench_capacity(out_dir: str, quick: bool = False) -> dict:
    from pacc.codec import capacity
    from pacc.spec import LEVELS, PALETTES, grid_sizes
    rows = []
    for n in grid_sizes():
        for mcs in PALETTES:
            for lv, (name, num, den) in LEVELS.items():
                cap = capacity(n, mcs, lv)
                rows.append({"codec": f"PACC-{mcs}-{name}", "side_modules": n, "capacity_bytes": cap,
                             "bits_per_module": round(8 * cap / (n * n), 4)})
    for v in range(1, 41):
        n = 17 + 4 * v
        for ec in "LMQH":
            cap = _qr_capacity(v, ec)
            rows.append({"codec": f"QR-{ec}", "side_modules": n, "capacity_bytes": cap,
                         "bits_per_module": round(8 * cap / (n * n), 4)})
    _write_csv(os.path.join(out_dir, "n1_capacity.csv"), rows)

    # Equal payload: symbol side (modules) needed, and area relative to QR-H.
    sizes = [32, 64, 128, 256, 512] if quick else [16, 32, 64, 128, 256, 512, 1024, 2048]
    codecs = ["PACC-1-Q", "PACC-2-Q", "PACC-1-H", "QR-M", "QR-H"]
    eq_rows = []
    rng = np.random.default_rng(1)
    for size in sizes:
        payload = rng.bytes(size)
        row: dict[str, Any] = {"payload_bytes": size}
        for c in codecs:
            try:
                row[c] = C.modules_of(c, payload)
            except Exception:
                row[c] = None
        eq_rows.append(row)
    _write_csv(os.path.join(out_dir, "n1_equal_payload_side.csv"), eq_rows)

    plt = _plt()
    fig, ax = plt.subplots(1, 2, figsize=(11, 4))
    for c in ["PACC-0-Q", "PACC-1-Q", "PACC-2-Q", "PACC-1-H", "QR-M", "QR-H"]:
        pts = [(r["side_modules"], r["capacity_bytes"]) for r in rows if r["codec"] == c]
        ax[0].plot(*zip(*pts), label=c, lw=1.5)
    ax[0].set(xlabel="symbol side (modules)", ylabel="capacity (bytes)", title="Capacity vs symbol size", yscale="log")
    ax[0].legend(fontsize=8)
    for c in codecs:
        pts = [(r["payload_bytes"], r[c] ** 2) for r in eq_rows if r[c]]
        ax[1].plot(*zip(*pts), marker="o", label=c, lw=1.5)
    ax[1].set(xlabel="payload (bytes)", ylabel="symbol area (modules²)", title="Area needed for a payload",
              xscale="log", yscale="log")
    ax[1].legend(fontsize=8)
    fig.tight_layout()
    fig.savefig(os.path.join(out_dir, "n1_capacity.png"), dpi=200)
    plt.close(fig)

    ratio = {}
    for r in eq_rows:
        if r.get("QR-H") and r.get("PACC-1-Q"):
            ratio[r["payload_bytes"]] = round((r["PACC-1-Q"] ** 2) / (r["QR-H"] ** 2), 3)
    return {"equal_payload_side": eq_rows, "area_ratio_pacc2_1q_vs_qrh": ratio}


# ── N2 robustness ─────────────────────────────────────────────────────────────

def _robust_cell(args: tuple) -> tuple:
    codec, kind, value, trials, ablation = args
    C.set_ablation(ablation)
    outcomes = []
    for t in range(trials):
        rng = np.random.default_rng(C.seed_for(kind, value, t))       # paired across codecs
        img = C.distort(C.symbol(codec), kind, value, rng)
        for attempt in range(3):
            try:
                outcomes.append(C.decode_ok(codec, img))
                break
            except Exception as e:
                if attempt == 2:
                    raise RuntimeError(f"{codec} {kind}={value} trial {t}: {e!r}") from e
                print(f"  retrying {codec} {kind}={value} trial {t} after {e!r}", flush=True)
    return codec, kind, value, ablation, outcomes


def _run_cells(jobs: list[tuple], workers: int, label: str, attempts: int = 3) -> list[tuple]:
    """Runs the cells in a process pool. If a worker dies (a native library crash), the unfinished
    cells are run again in a fresh pool; seeds are deterministic, so results do not change."""
    from concurrent.futures import as_completed
    from concurrent.futures.process import BrokenProcessPool
    done: dict[int, tuple] = {}
    t0 = time.time()
    for attempt in range(attempts):
        todo = [i for i in range(len(jobs)) if i not in done]
        if not todo:
            break
        try:
            with ProcessPoolExecutor(max_workers=workers) as ex:
                futures = {ex.submit(_robust_cell, jobs[i]): i for i in todo}
                for f in as_completed(futures):
                    done[futures[f]] = f.result()
                    n = len(done)
                    if n % max(1, len(jobs) // 20) == 0 or n == len(jobs):
                        print(f"  {label}: {n}/{len(jobs)} cells ({time.time() - t0:.0f}s)", flush=True)
        except BrokenProcessPool:
            print(f"  {label}: a worker crashed; re-running {len(jobs) - len(done)} cells (attempt {attempt + 2})",
                  flush=True)
    if len(done) < len(jobs):
        raise RuntimeError(f"{label}: {len(jobs) - len(done)} cells failed after {attempts} attempts")
    return [done[i] for i in range(len(jobs))]


def bench_robustness(out_dir: str, trials: int, workers: int, quick: bool = False, codecs: list[str] | None = None,
                     protocol: str = "everyday") -> dict:
    codecs = [c for c in (codecs or ["PACC-1-Q", "PACC-1-H", "PACC-2-Q", "PACC-HD", "QR-H", "QR-M", "JAB-4", "JAB-8"])
              if C.available(c)]
    source = C.SWEEPS if protocol == "everyday" else C.STRESS_SWEEPS
    sweeps = {k: (v[::2] if quick else v) for k, v in source.items()}
    jobs = [(c, kind, v, trials, "full") for kind, vals in sweeps.items() for v in vals for c in codecs]
    results = _run_cells(jobs, workers, "N2")
    rows = []
    by: dict[tuple, list[bool]] = {}
    for codec, kind, value, _, outcomes in results:
        s = C.rate_ci(sum(outcomes), len(outcomes))
        by[(codec, kind, value)] = outcomes
        rows.append({"codec": codec, "distortion": kind, "value": value, "trials": len(outcomes),
                     "successes": sum(outcomes), "rate_pct": round(s["rate_pct"], 1),
                     "ci_low_pct": round(s["ci_lower_pct"], 1), "ci_high_pct": round(s["ci_upper_pct"], 1)})
    _write_csv(os.path.join(out_dir, "n2_robustness.csv"), rows)

    # Mean success over all conditions, and paired McNemar PACC-1-Q vs QR-H per condition.
    means = {c: round(float(np.mean([r["rate_pct"] for r in rows if r["codec"] == c])), 1) for c in codecs}
    tests = []
    if "PACC-1-Q" in codecs and "QR-H" in codecs:
        for kind, vals in sweeps.items():
            for v in vals:
                m = C.mcnemar(by[("PACC-1-Q", kind, v)], by[("QR-H", kind, v)])
                tests.append({"distortion": kind, "value": v, "p_value": round(float(m.get("p_value", 1.0)), 4),
                              "pacc2_only": m.get("b", m.get("pacc_only")), "qr_only": m.get("c", m.get("qr_only"))})
        _write_csv(os.path.join(out_dir, "n2_mcnemar_pacc2_vs_qrh.csv"), tests)

    plt = _plt()
    kinds = list(sweeps)
    cols = 4
    fig, axes = plt.subplots((len(kinds) + cols - 1) // cols, cols, figsize=(16, 3.2 * ((len(kinds) + cols - 1) // cols)))
    for ax, kind in zip(axes.flat, kinds):
        for c in codecs:
            pts = [r for r in rows if r["codec"] == c and r["distortion"] == kind]
            x = [p["value"] for p in pts]
            y = [p["rate_pct"] for p in pts]
            lo = [p["rate_pct"] - p["ci_low_pct"] for p in pts]
            hi = [p["ci_high_pct"] - p["rate_pct"] for p in pts]
            ax.errorbar(x, y, yerr=[lo, hi], marker="o", ms=3, capsize=2, lw=1.2, label=c)
        ax.set_title(kind, fontsize=9)
        ax.set_ylim(-5, 105)
    for ax in list(axes.flat)[len(kinds):]:
        ax.axis("off")
    axes.flat[0].legend(fontsize=7)
    fig.tight_layout()
    fig.savefig(os.path.join(out_dir, "n2_robustness.png"), dpi=170)
    plt.close(fig)
    return {"codecs": codecs, "mean_success_pct": means, "conditions": sum(len(v) for v in sweeps.values()),
            "sweeps": sweeps, "protocol": protocol, "trials": trials,
            "significant_conditions_p_lt_0.05": sum(1 for t in tests if t["p_value"] < 0.05),
            "pacc_better_p_lt_0.05": sum(1 for t in tests if t["p_value"] < 0.05 and (t["pacc2_only"] or 0) > (t["qr_only"] or 0)),
            "qr_better_p_lt_0.05": sum(1 for t in tests if t["p_value"] < 0.05 and (t["qr_only"] or 0) > (t["pacc2_only"] or 0))}


# ── N3 ablations ──────────────────────────────────────────────────────────────

# Everyday protocol: the decoder variants are compared on the most demanding everyday conditions,
# and on conditions at the limit of decoding (a hard sunlight shadow, a deep shadow, stacked effects,
# heavy stains and erasures), because an element can only show its effect where decoding is hard.
ABLATION_CONDITIONS = [
    ("everyday", 2), ("everyday", 3), ("gaussian_noise_sigma", 20), ("shadow_atten", 0.6),
    ("glare_intensity", 200), ("smudge_frac", 0.06), ("faded_print", 0.55), ("motion_blur_px", 9),
]
LIMIT_ABLATION_CONDITIONS = [
    ("edge_shadow", 0.85), ("edge_shadow", 0.9), ("shadow_atten", 0.95), ("combined", 3),
    ("random_stain_frac", 0.3), ("random_erasure_frac", 0.35),
]
# Stress protocol: stacked effects at three severities and single effects near breaking point.
STRESS_ABLATION_CONDITIONS = [
    ("combined", 2), ("combined", 3), ("combined", 4),
    ("shadow_atten", 0.95), ("random_stain_frac", 0.3), ("random_erasure_frac", 0.35),
]


def bench_ablations(out_dir: str, trials: int, workers: int, quick: bool = False, protocol: str = "everyday") -> dict:
    codecs = ["PACC-1-Q"] if quick else ["PACC-1-Q", "PACC-2-Q"]
    if protocol == "everyday":
        sets = {"limit": LIMIT_ABLATION_CONDITIONS, "everyday": ABLATION_CONDITIONS}
    else:
        sets = {"limit": STRESS_ABLATION_CONDITIONS}
    jobs = [(c, kind, v, trials, ab) for ab in C.ABLATIONS for c in codecs
            for conds in sets.values() for kind, v in conds]
    results = _run_cells(jobs, workers, "N3")
    rows = []
    for codec, kind, value, ab, outcomes in results:
        s = C.rate_ci(sum(outcomes), len(outcomes))
        which = next(name for name, conds in sets.items() if (kind, value) in conds)
        rows.append({"set": which, "codec": codec, "ablation": ab, "distortion": kind, "value": value,
                     "rate_pct": round(s["rate_pct"], 1), "ci_low_pct": round(s["ci_lower_pct"], 1),
                     "ci_high_pct": round(s["ci_upper_pct"], 1)})
    _write_csv(os.path.join(out_dir, "n3_ablations.csv"), rows)

    def summary_of(name):
        return {c: {ab: round(float(np.mean([r["rate_pct"] for r in rows if r["set"] == name and r["codec"] == c
                                              and r["ablation"] == ab])), 1) for ab in C.ABLATIONS} for c in codecs}
    summary = summary_of("limit")
    conditions = sets["limit"]
    plt = _plt()
    fig, ax = plt.subplots(figsize=(10, 4))
    labels = [f"{k}\n{v}" for k, v in conditions]
    width = 0.8 / len(C.ABLATIONS)
    for i, ab in enumerate(C.ABLATIONS):
        y = [next(r["rate_pct"] for r in rows if r["codec"] == codecs[0] and r["ablation"] == ab
                  and r["distortion"] == k and r["value"] == v) for k, v in conditions]
        ax.bar(np.arange(len(labels)) + i * width, y, width, label=ab)
    ax.set_xticks(np.arange(len(labels)) + 0.4 - width / 2)
    ax.set_xticklabels(labels, fontsize=7)
    ax.set(ylabel="decode success (%)", title=f"Ablations ({codecs[0]})")
    ax.legend(fontsize=7, ncol=3)
    fig.tight_layout()
    fig.savefig(os.path.join(out_dir, "n3_ablations.png"), dpi=170)
    plt.close(fig)
    out: dict[str, Any] = {"mean_success_pct": summary, "conditions": [f"{k}={v}" for k, v in conditions], "trials": trials}
    if "everyday" in sets:
        out["everyday"] = {"mean_success_pct": summary_of("everyday"),
                           "conditions": [f"{k}={v}" for k, v in sets["everyday"]]}
    return out


# ── N4 latency ────────────────────────────────────────────────────────────────

def bench_latency(out_dir: str, quick: bool = False) -> dict:
    import pacc
    from pacc.codec import capacity
    sizes = [24, 48, 72, 100] if quick else [24, 36, 48, 64, 80, 100, 124, 148]
    reps = 2 if quick else 5
    rows = []
    for mcs in (0, 1, 2):
        for n in sizes:
            cap = capacity(n, mcs, 2)
            data = np.random.default_rng(n).bytes(cap)
            enc_t, dec_t, ok = [], [], True
            warm, _ = pacc.encode(data, level="Q", mcs=mcs, cell_size=6, compress=False, min_grid=n)   # builds caches
            pacc.decode(np.pad(np.asarray(warm), ((30, 30), (30, 30), (0, 0)), constant_values=255))
            for _ in range(reps):
                t0 = time.perf_counter()
                img, meta = pacc.encode(data, level="Q", mcs=mcs, cell_size=6, compress=False, min_grid=n)
                enc_t.append(time.perf_counter() - t0)
                arr = np.pad(np.asarray(img), ((30, 30), (30, 30), (0, 0)), constant_values=255)
                t0 = time.perf_counter()
                r = pacc.decode(arr)
                dec_t.append(time.perf_counter() - t0)
                ok &= bool(r.ok and r.payload == data)
            rows.append({"mcs": mcs, "side_modules": meta.n, "payload_bytes": cap,
                         "encode_ms_median": round(1000 * float(np.median(enc_t)), 1),
                         "decode_ms_median": round(1000 * float(np.median(dec_t)), 1), "decoded": ok})
    _write_csv(os.path.join(out_dir, "n4_latency.csv"), rows)
    plt = _plt()
    fig, ax = plt.subplots(figsize=(6, 4))
    for mcs in (0, 1, 2):
        pts = [(r["side_modules"], r["decode_ms_median"]) for r in rows if r["mcs"] == mcs]
        ax.plot(*zip(*pts), marker="o", label=f"decode, MCS {mcs}")
    ax.set(xlabel="symbol side (modules)", ylabel="ms (Python reference)", title="Decode time vs size")
    ax.legend(fontsize=8)
    fig.tight_layout()
    fig.savefig(os.path.join(out_dir, "n4_latency.png"), dpi=170)
    plt.close(fig)
    return {"rows": rows}


# ── N5 security overhead ──────────────────────────────────────────────────────

def bench_security(out_dir: str, quick: bool = False) -> dict:
    from pacc import codec, secure
    text = C.PAYLOAD
    ed = secure.SigningKey.generate()
    pq = secure.SigningKey.generate(secure.ALG_MLDSA44)
    rk = secure.RecipientKey.generate()
    xk = secure.PqRecipientKey.generate()
    variants = {
        "plain": (secure.SealOptions(), secure.Secrets()),
        "Ed25519 (embedded key)": (secure.SealOptions(sign_with=ed), secure.Secrets()),
        "Ed25519 (key id)": (secure.SealOptions(sign_with=ed, embed_public_key=False),
                             secure.Secrets(trusted_signers={ed.fingerprint.hex(): (ed.alg, ed.public)})),
        "ML-DSA-44 (key id)": (secure.SealOptions(sign_with=pq, embed_public_key=False),
                               secure.Secrets(trusted_signers={pq.fingerprint.hex(): (pq.alg, pq.public)})),
        "passphrase (Argon2id p0)": (secure.SealOptions(password="benchmark passphrase", kdf_profile=0),
                                     secure.Secrets(password="benchmark passphrase")),
        "HPKE X25519": (secure.SealOptions(recipient=rk.public), secure.Secrets(recipient_keys=[rk])),
        "HPKE X-Wing (PQ)": (secure.SealOptions(recipient_pq=xk.public), secure.Secrets(pq_recipient_keys=[xk])),
        "ML-DSA-44 + X-Wing": (secure.SealOptions(sign_with=pq, embed_public_key=False, recipient_pq=xk.public),
                               secure.Secrets(trusted_signers={pq.fingerprint.hex(): (pq.alg, pq.public)},
                                              pq_recipient_keys=[xk])),
    }
    rows = []
    reps = 1 if quick else 3
    for name, (opts, secrets) in variants.items():
        seal_t, open_t = [], []
        for _ in range(reps):
            t0 = time.perf_counter()
            flags, body = secure.seal(text, False, opts)
            seal_t.append(time.perf_counter() - t0)
            t0 = time.perf_counter()
            opened = secure.open_message(flags, body, secrets)
            open_t.append(time.perf_counter() - t0)
        row: dict[str, Any] = {"envelope": name, "overhead_bytes": len(body) - len(text),
                               "seal_ms": round(1000 * float(np.median(seal_t)), 2),
                               "open_ms": round(1000 * float(np.median(open_t)), 2),
                               "opens": opened.payload == text}
        for mcs in (1, 2):
            try:
                row[f"N_mcs{mcs}_Q"] = codec.encode_grid(text, mcs=mcs, level="Q", compress=False, sealed=(flags, body)).n
            except ValueError:
                row[f"N_mcs{mcs}_Q"] = None
        rows.append(row)
    _write_csv(os.path.join(out_dir, "n5_security.csv"), rows)
    return {"rows": rows, "payload_bytes": len(text)}


# ── N6 multi-frame combining ──────────────────────────────────────────────────

def _glare_stress(img: np.ndarray, rng: np.random.Generator, frac: float = 0.35) -> np.ndarray:
    h, w = img.shape[:2]
    cx, cy = rng.uniform(0.3 * w, 0.7 * w), rng.uniform(0.3 * h, 0.7 * h)
    yy, xx = np.mgrid[0:h, 0:w]
    r = np.sqrt((xx - cx) ** 2 + ((yy - cy) / 0.8) ** 2)
    a = np.clip(1.3 - r / (frac * w), 0, 1)[..., None]
    return np.clip(img.astype(np.float32) * (1 - a) + 255 * a, 0, 255).astype(np.uint8)


def _multiframe_trial_stress(args: tuple) -> tuple:
    noise, trial, max_frames = args
    import pacc
    from pacc.combine import FrameCombiner
    text = b"multi-frame combining benchmark payload"
    img, _ = pacc.encode(text, level="L", mcs=1, cell_size=8, compress=False)
    base = C.place(np.asarray(img), np.random.default_rng(C.seed_for("mf-place", trial)))
    rng = np.random.default_rng(C.seed_for("mf", noise, trial))
    comb = FrameCombiner()
    single_ok, needed = False, None
    for f in range(1, max_frames + 1):
        frame = _glare_stress(np.clip(base + rng.normal(0, noise, base.shape), 0, 255).astype(np.uint8), rng)
        if f == 1:
            single_ok = bool(pacc.decode(frame, thorough=False).ok)
        r = pacc.decode(frame, thorough=False, combiner=comb)
        if r.ok and r.payload == text:
            needed = f
            break
    return noise, trial, single_ok, needed


def bench_multiframe_stress(out_dir: str, trials: int, workers: int, quick: bool = False) -> dict:
    noises = [70, 90, 110] if quick else [50, 70, 90, 110, 130]
    max_frames = 8
    jobs = [(nz, t, max_frames) for nz in noises for t in range(trials)]
    with ProcessPoolExecutor(max_workers=workers) as ex:
        res = list(ex.map(_multiframe_trial_stress, jobs))
    rows = []
    for nz in noises:
        rs = [r for r in res if r[0] == nz]
        single = sum(r[2] for r in rs)
        row: dict[str, Any] = {"noise_sigma": nz, "trials": len(rs), "single_frame_pct": round(100 * single / len(rs), 1)}
        for k in range(1, max_frames + 1):
            row[f"within_{k}_frames_pct"] = round(100 * sum(1 for r in rs if r[3] is not None and r[3] <= k) / len(rs), 1)
        rows.append(row)
    _write_csv(os.path.join(out_dir, "n6_multiframe.csv"), rows)
    plt = _plt()
    fig, ax = plt.subplots(figsize=(6, 4))
    for row in rows:
        ax.plot(range(1, max_frames + 1), [row[f"within_{k}_frames_pct"] for k in range(1, max_frames + 1)],
                marker="o", label=f"σ={row['noise_sigma']} (single {row['single_frame_pct']}%)")
    ax.set(xlabel="frames combined", ylabel="decoded (%)", title="Multi-frame combining (noise + moving glare)")
    ax.legend(fontsize=7)
    fig.tight_layout()
    fig.savefig(os.path.join(out_dir, "n6_multiframe.png"), dpi=170)
    plt.close(fig)
    return {"rows": rows}


# Everyday multi-frame: a hand-held phone in dim light at reading distance. A reflection on the
# glossy label moves from frame to frame and the hand shakes a little. Every reader gets the same
# video: a standard reader succeeds as soon as any single frame decodes; PACC can also combine
# the soft information of frames that fail on their own.
MF_NOISE = [15, 25, 35]                 # sensor noise: dim to very dim light
MF_SCALE = 0.45                         # symbol about 160 px wide (about 4 px per module)
MF_CODECS = ["PACC-1-Q", "QR-H"]


def _mf_frame(base: np.ndarray, rng: np.random.Generator, noise: float) -> np.ndarray:
    from pacc_bench import distortions as D
    w = base.shape[1]
    a = D.apply_glare(base, intensity=200.0, radius=0.12 * w, center=tuple(rng.uniform(0.3, 0.7, size=2)))
    a = D.apply_motion_blur(a, length=int(rng.integers(3, 8)), angle_deg=float(rng.uniform(0, 180)))
    return D.apply_gaussian_noise(a, sigma=noise, rng=rng)


def _multiframe_trial(args: tuple) -> tuple:
    codec, noise, trial, max_frames = args
    import pacc
    from pacc.combine import FrameCombiner
    base = C.place(C.symbol(codec), np.random.default_rng(C.seed_for("mf-place", trial)))
    base = cv2.resize(base, None, fx=MF_SCALE, fy=MF_SCALE, interpolation=cv2.INTER_AREA)
    rng = np.random.default_rng(C.seed_for("mf", noise, trial))
    comb = FrameCombiner() if codec.startswith("PACC-") else None
    first, alone_at, combined_at = False, None, None
    for f in range(1, max_frames + 1):
        frame = _mf_frame(base, rng, noise)
        if comb is None:
            ok = C.decode_ok(codec, frame)
        else:
            r = pacc.decode(frame, thorough=False)
            ok = bool(r.ok and r.payload == C.PAYLOAD)
            if combined_at is None:
                rc = pacc.decode(frame, thorough=False, combiner=comb)
                if rc.ok and rc.payload == C.PAYLOAD:
                    combined_at = f
        if f == 1:
            first = ok
        if ok and alone_at is None:
            alone_at = f
        if alone_at is not None and (comb is None or combined_at is not None):
            break
    return codec, noise, trial, first, alone_at, combined_at


def bench_multiframe(out_dir: str, trials: int, workers: int, quick: bool = False) -> dict:
    noises = MF_NOISE[1:] if quick else MF_NOISE
    max_frames = 8
    jobs = [(c, nz, t, max_frames) for c in MF_CODECS for nz in noises for t in range(trials)]
    with ProcessPoolExecutor(max_workers=workers) as ex:
        res = list(ex.map(_multiframe_trial, jobs))
    rows = []
    for c in MF_CODECS:
        for nz in noises:
            rs = [r for r in res if r[0] == c and r[1] == nz]
            row: dict[str, Any] = {"codec": c, "noise_sigma": nz, "trials": len(rs),
                                   "single_frame_pct": round(100 * sum(r[3] for r in rs) / len(rs), 1)}
            for k in range(1, max_frames + 1):
                row[f"any_frame_within_{k}_pct"] = round(100 * sum(1 for r in rs if r[4] is not None and r[4] <= k) / len(rs), 1)
                if c.startswith("PACC-"):
                    row[f"combined_within_{k}_pct"] = round(
                        100 * sum(1 for r in rs if r[5] is not None and r[5] <= k) / len(rs), 1)
            rows.append(row)
    _write_csv(os.path.join(out_dir, "n6_multiframe.csv"), rows)
    plt = _plt()
    fig, ax = plt.subplots(figsize=(6.5, 4))
    ks = range(1, max_frames + 1)
    for row in rows:
        ax.plot(ks, [row[f"any_frame_within_{k}_pct"] for k in ks], ls="--", marker="o", ms=3,
                label=f"{row['codec']} any single frame, σ={row['noise_sigma']}")
        if row["codec"].startswith("PACC-"):
            ax.plot(ks, [row[f"combined_within_{k}_pct"] for k in ks], marker="s", ms=3,
                    label=f"{row['codec']} combined, σ={row['noise_sigma']}")
    ax.set(xlabel="frames", ylabel="decoded (%)", title="Hand-held video, dim light, moving reflection")
    ax.legend(fontsize=6)
    fig.tight_layout()
    fig.savefig(os.path.join(out_dir, "n6_multiframe.png"), dpi=170)
    plt.close(fig)
    return {"rows": rows, "scale": MF_SCALE, "max_frames": max_frames}


# ── N7 layered symbols and QR-compatible mode ─────────────────────────────────

QC_CONDITIONS = [("clean", 0), ("gaussian_noise_sigma", 20), ("gaussian_blur_px", 2), ("jpeg_quality", 60),
                 ("downscale", 0.35), ("white_balance", 0.4), ("yaw_deg", 40), ("glare_intensity", 200), ("everyday", 2)]
STRESS_QC_CONDITIONS = [("clean", 0), ("gaussian_noise_sigma", 30), ("gaussian_blur_px", 2), ("jpeg_quality", 20),
                        ("downscale", 0.35), ("white_balance", 0.8), ("yaw_deg", 45)]


def bench_layers_qc(out_dir: str, trials: int, quick: bool = False, protocol: str = "everyday") -> dict:
    import pacc
    import zxingcpp
    from pacc import hier, qc
    from pacc_bench import distortions as D

    # Layered: fine/coarse success vs pixels per sub-cell.
    coarse, fine = b"https://ex.co/p/42", b"batch 2026-10-A; origin Pune; expiry 2027-04; lot 7781-B" * 2
    e = hier.encode(coarse, fine, level="H")
    base = np.pad(hier.render(e, sub_px=6), ((40, 40), (40, 40), (0, 0)), constant_values=255)
    scales = [1.0, 0.5, 0.3, 0.2, 0.15] if quick else [1.0, 0.7, 0.5, 0.35, 0.25, 0.2, 0.15, 0.12, 0.1]
    lrows = []
    for s in scales:
        c_ok = f_ok = 0
        for t in range(trials):
            rng = np.random.default_rng(C.seed_for("layer", s, t))
            img = cv2.resize(base, None, fx=s, fy=s, interpolation=cv2.INTER_AREA)
            img = D.apply_gaussian_noise(img, sigma=4.0, rng=rng)
            r = pacc.decode(img)
            c_ok += bool(r.ok and r.payload == coarse)
            f_ok += bool(r.fine is not None and r.fine.ok and r.fine.payload == fine)
        lrows.append({"px_per_subcell": round(6 * s, 2), "coarse_pct": round(100 * c_ok / trials, 1),
                      "fine_pct": round(100 * f_ok / trials, 1)})
    _write_csv(os.path.join(out_dir, "n7_layered.csv"), lrows)

    # QC: does tinting hurt standard QR readers? And does the hidden channel survive?
    url = "https://bank.example.com/pay?to=ACME&amount=120.00"
    import qrcode
    plain_q = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_M, border=4, box_size=8)
    plain_q.add_data(url)
    plain_q.make(fit=True)
    plain = np.asarray(plain_q.make_image().convert("RGB"))
    tinted = qc.render(qc.encode(url, b"issuer=ACME Bank"), cell_size=8)
    conds = QC_CONDITIONS if protocol == "everyday" else STRESS_QC_CONDITIONS
    qrows = []
    for kind, v in conds:
        p_ok = t_ok = h_ok = 0
        for t in range(trials):
            for which, img in (("plain", plain), ("tinted", tinted)):
                rng = np.random.default_rng(C.seed_for("qc", kind, v, t))
                a = C.distort(img, kind, v, rng) if kind != "clean" else C.place(img, rng)
                z = zxingcpp.read_barcodes(a)
                ok = bool(z) and z[0].text == url
                if which == "plain":
                    p_ok += ok
                else:
                    t_ok += ok
                    if ok:
                        h = qc.decode(a)
                        h_ok += bool(h.ok and h.hidden == b"issuer=ACME Bank" and h.bound)
        qrows.append({"distortion": kind, "value": v, "plain_qr_read_pct": round(100 * p_ok / trials, 1),
                      "tinted_qr_read_pct": round(100 * t_ok / trials, 1),
                      "hidden_channel_pct": round(100 * h_ok / trials, 1)})
    _write_csv(os.path.join(out_dir, "n7_qc.csv"), qrows)

    plt = _plt()
    fig, ax = plt.subplots(1, 2, figsize=(11, 4))
    x = [r["px_per_subcell"] for r in lrows]
    ax[0].plot(x, [r["coarse_pct"] for r in lrows], marker="o", label="coarse layer")
    ax[0].plot(x, [r["fine_pct"] for r in lrows], marker="s", label="fine layer")
    ax[0].set(xlabel="pixels per sub-cell", ylabel="decoded (%)", title="Layered symbol vs resolution", xscale="log")
    ax[0].legend(fontsize=8)
    idx = np.arange(len(qrows))
    ax[1].bar(idx - 0.27, [r["plain_qr_read_pct"] for r in qrows], 0.27, label="plain QR (zxing)")
    ax[1].bar(idx, [r["tinted_qr_read_pct"] for r in qrows], 0.27, label="QC symbol as QR (zxing)")
    ax[1].bar(idx + 0.27, [r["hidden_channel_pct"] for r in qrows], 0.27, label="QC hidden channel")
    ax[1].set_xticks(idx)
    ax[1].set_xticklabels([f"{r['distortion']}\n{r['value']}" for r in qrows], fontsize=6)
    ax[1].set(ylabel="%", title="QR-compatible mode")
    ax[1].legend(fontsize=7)
    fig.tight_layout()
    fig.savefig(os.path.join(out_dir, "n7_layers_qc.png"), dpi=170)
    plt.close(fig)
    return {"layered": lrows, "qc": qrows, "trials": trials}


BENCHMARKS = {
    "N1": ("Capacity & density", "capacity"),
    "N2": ("Robustness at equal footprint", "robustness"),
    "N3": ("Decoder ablations", "ablations"),
    "N4": ("Latency (Python reference)", "latency"),
    "N5": ("Security envelope overhead", "security"),
    "N6": ("Multi-frame combining", "multiframe"),
    "N7": ("Layered symbols & QR-compatible mode", "layers_qc"),
}


def run(name: str, out_dir: str, trials: int, workers: int, quick: bool, protocol: str = "everyday") -> dict:
    if name == "N1":
        return bench_capacity(out_dir, quick)
    if name == "N2":
        return bench_robustness(out_dir, trials, workers, quick, protocol=protocol)
    if name == "N3":
        return bench_ablations(out_dir, trials, workers, quick, protocol=protocol)
    if name == "N4":
        return bench_latency(out_dir, quick)
    if name == "N5":
        return bench_security(out_dir, quick)
    if name == "N6":
        if protocol == "everyday":
            res = bench_multiframe(out_dir, trials, workers, quick)
            limit_dir = os.path.join(out_dir, "n6_limit")
            os.makedirs(limit_dir, exist_ok=True)
            res["limit"] = bench_multiframe_stress(limit_dir, trials, workers, quick)
            return res
        return bench_multiframe_stress(out_dir, trials, workers, quick)
    if name == "N7":
        if protocol == "everyday":
            return bench_layers_qc(out_dir, trials, quick)
        return bench_layers_qc(out_dir, max(3, trials // 3), quick, protocol="stress")
    raise ValueError(name)
