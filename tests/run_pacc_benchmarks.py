"""
run_pacc_benchmarks.py — PACC benchmark suite (N1–N7), synthetic.

    python tests/run_pacc_benchmarks.py --quick                 # smoke run, a few minutes
    python tests/run_pacc_benchmarks.py --trials 30             # paper run (everyday conditions)
    python tests/run_pacc_benchmarks.py --only N2,N3 --trials 50
    python tests/run_pacc_benchmarks.py --protocol stress       # breaking points, beyond everyday use

The default "everyday" protocol uses the conditions of everyday phone scanning (viewing angle up
to 40°, normal distances, slight blur and hand shake, dim light, warm/cool light, soft shadows,
glare, faded print, small stains, a crease or a covered corner, everyday scenes). The "stress"
protocol uses breaking-point conditions.

Writes CSV files, figures, results.json, manifest.json and REPORT.md to --out-dir
(default tests/pacc_results/). All seeds are deterministic (CRC-32 of the condition),
so runs are reproducible and trials are paired across codecs.

Baseline adapters (Prototype 22, QR via zxing-cpp, JAB Code), distortion models
and statistics live in tests/pacc_bench/ (carried over from the Prototype 22 harness).
"""
from __future__ import annotations

import argparse
import datetime
import json
import os
import platform
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
for p in (ROOT, HERE):
    if p not in sys.path:
        sys.path.insert(0, p)

from pacc_bench.benchmarks import BENCHMARKS, run  # noqa: E402


def manifest(args: argparse.Namespace) -> dict:
    def version(mod: str, dist: str | None = None) -> str:
        try:
            return __import__(mod).__version__
        except Exception:
            try:
                from importlib.metadata import version as dist_version
                return dist_version(dist or mod)
            except Exception:
                return "n/a"
    try:
        commit = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=ROOT, capture_output=True, text=True).stdout.strip()
        dirty = bool(subprocess.run(["git", "status", "--porcelain"], cwd=ROOT, capture_output=True, text=True).stdout.strip())
    except Exception:
        commit, dirty = "n/a", None
    return {
        "suite": "PACC N1-N7", "timestamp": datetime.datetime.now().isoformat(timespec="seconds"),
        "git_commit": commit, "working_tree_dirty": dirty, "python": sys.version.split()[0],
        "platform": platform.platform(), "numpy": version("numpy"), "opencv": version("cv2"),
        "zxingcpp": version("zxingcpp", "zxing-cpp"), "qrcode": version("qrcode"),
        "cryptography": version("cryptography"),
        "trials": args.trials, "quick": args.quick, "only": args.only, "protocol": args.protocol,
    }


def report(results: dict, man: dict, out_dir: str) -> str:
    L = ["# PACC Benchmark Report", "",
         f"Generated {man['timestamp']} · commit `{man['git_commit']}`{' (uncommitted changes)' if man['working_tree_dirty'] else ''}"
         f" · {man['trials']} trials per condition{' (quick mode)' if man['quick'] else ''}"
         f" · protocol: {man.get('protocol', 'stress')}.", "",
         "All results are from digital renders and simulated capture effects; they are not a "
         "substitute for print-and-camera measurements.", ""]
    if "N1" in results:
        r = results["N1"]
        L += ["## N1 Capacity & density", "", "Symbol side (modules) needed for a payload:", "",
              "| payload (B) | " + " | ".join(k for k in r["equal_payload_side"][0] if k != "payload_bytes") + " |",
              "|---" * len(r["equal_payload_side"][0]) + "|"]
        for row in r["equal_payload_side"]:
            L.append(f"| {row['payload_bytes']} | " + " | ".join(str(v) for k, v in row.items() if k != "payload_bytes") + " |")
        L += ["", "Area of PACC-1-Q relative to QR-H: " +
              ", ".join(f"{k} B → {v:.2f}×" for k, v in r["area_ratio_pacc2_1q_vs_qrh"].items()), "",
              "![capacity](n1_capacity.png)", ""]
    if "N2" in results:
        r = results["N2"]
        L += ["## N2 Robustness at equal printed footprint", "",
              f"{r['conditions']} conditions × {r['trials']} paired trials; symbols scaled to the same printed width, "
              "placed at random offsets. Wilson 95% intervals in `n2_robustness.csv`.", "",
              "| codec | mean success (%) |", "|---|---|"]
        L += [f"| {c} | {v} |" for c, v in sorted(r["mean_success_pct"].items(), key=lambda kv: -kv[1])]
        if "significant_conditions_p_lt_0.05" in r:
            L += ["", f"McNemar PACC-1-Q vs QR-H: significant difference (p < 0.05) in "
                      f"{r['significant_conditions_p_lt_0.05']} of {r['conditions']} conditions "
                      "(`n2_mcnemar_pacc2_vs_qrh.csv`)."]
        L += ["", "![robustness](n2_robustness.png)", ""]
    if "N3" in results:
        r = results["N3"]
        L += ["## N3 Decoder ablations", "", "Mean success over: " + ", ".join(r["conditions"]), ""]
        codecs = list(r["mean_success_pct"])
        L += ["| decoder variant | " + " | ".join(codecs) + " |", "|---" * (len(codecs) + 1) + "|"]
        for ab in next(iter(r["mean_success_pct"].values())):
            L.append(f"| {ab} | " + " | ".join(str(r["mean_success_pct"][c][ab]) for c in codecs) + " |")
        if "everyday" in r:
            e = r["everyday"]
            L += ["", "Everyday set: " + ", ".join(e["conditions"]), "",
                  "| decoder variant | " + " | ".join(codecs) + " |", "|---" * (len(codecs) + 1) + "|"]
            for ab in next(iter(e["mean_success_pct"].values())):
                L.append(f"| {ab} | " + " | ".join(str(e["mean_success_pct"][c][ab]) for c in codecs) + " |")
        L += ["", "![ablations](n3_ablations.png)", ""]
    if "N4" in results:
        L += ["## N4 Latency (Python reference)", "", "| MCS | side | payload (B) | encode ms | decode ms |", "|---|---|---|---|---|"]
        L += [f"| {x['mcs']} | {x['side_modules']} | {x['payload_bytes']} | {x['encode_ms_median']} | {x['decode_ms_median']} |"
              for x in results["N4"]["rows"]]
        L += ["", "The TypeScript decoder's grid decode is timed by `npm run test:pacc`.", ""]
    if "N5" in results:
        r = results["N5"]
        L += ["## N5 Security envelope overhead", "", f"Payload {r['payload_bytes']} B.", "",
              "| envelope | overhead (B) | N (KCMY, Q) | N (CUBE8, Q) | seal ms | open ms |", "|---|---|---|---|---|---|"]
        L += [f"| {x['envelope']} | {x['overhead_bytes']} | {x['N_mcs1_Q']} | {x['N_mcs2_Q']} | {x['seal_ms']} | {x['open_ms']} |"
              for x in r["rows"]]
        L += [""]
    if "N6" in results:
        rows = results["N6"]["rows"]
        if rows and "codec" in rows[0]:
            L += ["## N6 Multi-frame combining", "",
                  "Hand-held video in dim light with a reflection that moves from frame to frame. 'Any frame' is the "
                  "chance that at least one single frame decodes (what every reader gets from video); 'combined' adds "
                  "PACC's combination of frames that fail on their own.", "",
                  "| codec | noise σ | single frame | any frame ≤2 | any ≤4 | any ≤8 | combined ≤2 | combined ≤4 | combined ≤8 |",
                  "|---|---|---|---|---|---|---|---|---|"]
            for x in rows:
                comb = [x.get(f"combined_within_{k}_pct", "—") for k in (2, 4, 8)]
                L.append(f"| {x['codec']} | {x['noise_sigma']} | {x['single_frame_pct']} | {x['any_frame_within_2_pct']} | "
                         f"{x['any_frame_within_4_pct']} | {x['any_frame_within_8_pct']} | {comb[0]} | {comb[1]} | {comb[2]} |")
        else:
            L += ["## N6 Multi-frame combining", "", "Noise plus a moving specular highlight on every frame.", "",
                  "| noise σ | single frame (%) | ≤2 frames | ≤4 frames | ≤8 frames |", "|---|---|---|---|---|"]
            L += [f"| {x['noise_sigma']} | {x['single_frame_pct']} | {x['within_2_frames_pct']} | {x['within_4_frames_pct']} | "
                  f"{x['within_8_frames_pct']} |" for x in rows]
        if "limit" in results["N6"]:
            L += ["", "At the limit (PACC rate 4/5, heavy noise and a moving highlight; every single frame fails):", "",
                  "| noise σ | single frame (%) | ≤2 frames | ≤4 frames | ≤8 frames |", "|---|---|---|---|---|"]
            L += [f"| {x['noise_sigma']} | {x['single_frame_pct']} | {x['within_2_frames_pct']} | "
                  f"{x['within_4_frames_pct']} | {x['within_8_frames_pct']} |" for x in results["N6"]["limit"]["rows"]]
        L += ["", "![multiframe](n6_multiframe.png)", ""]
    if "N7" in results:
        r = results["N7"]
        L += ["## N7 Layered symbols & QR-compatible mode", "", f"{r.get('trials', '?')} trials per row.", "",
              "| px per sub-cell | coarse (%) | fine (%) |", "|---|---|---|"]
        L += [f"| {x['px_per_subcell']} | {x['coarse_pct']} | {x['fine_pct']} |" for x in r["layered"]]
        L += ["", "| condition | plain QR read (%) | QC symbol read as QR (%) | hidden channel (%) |", "|---|---|---|---|"]
        L += [f"| {x['distortion']} {x['value']} | {x['plain_qr_read_pct']} | {x['tinted_qr_read_pct']} | {x['hidden_channel_pct']} |"
              for x in r["qc"]]
        L += ["", "![layers and QC](n7_layers_qc.png)", ""]
    text = "\n".join(L)
    with open(os.path.join(out_dir, "REPORT.md"), "w", encoding="utf-8") as f:
        f.write(text)
    return text


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--only", default=None, help="comma-separated benchmark ids, e.g. N1,N2")
    ap.add_argument("--trials", type=int, default=30)
    ap.add_argument("--workers", type=int, default=max(1, (os.cpu_count() or 2) - 1))
    ap.add_argument("--quick", action="store_true", help="fewer trials and severities (smoke run)")
    ap.add_argument("--out-dir", default=os.path.join(HERE, "pacc_results"))
    ap.add_argument("--protocol", choices=["everyday", "stress"], default="everyday",
                    help="everyday phone-scanning conditions (default) or breaking-point stress conditions")
    args = ap.parse_args()
    if args.quick:
        args.trials = min(args.trials, 6)
    os.makedirs(args.out_dir, exist_ok=True)
    names = [n.strip().upper() for n in args.only.split(",")] if args.only else list(BENCHMARKS)
    names = [n if n.startswith("N") else f"N{n}" for n in names]
    man = manifest(args)
    results: dict = {}
    t_all = time.time()
    for name in names:
        title = BENCHMARKS[name][0]
        print(f"{name} {title} ...", flush=True)
        t0 = time.time()
        results[name] = run(name, args.out_dir, args.trials, args.workers, args.quick, args.protocol)
        print(f"{name} done in {time.time() - t0:.0f}s", flush=True)
    man["duration_s"] = round(time.time() - t_all, 1)
    with open(os.path.join(args.out_dir, "results.json"), "w") as f:
        json.dump(results, f, indent=2, default=str)
    with open(os.path.join(args.out_dir, "manifest.json"), "w") as f:
        json.dump(man, f, indent=2)
    report(results, man, args.out_dir)
    print(f"all done in {man['duration_s']}s -> {args.out_dir}/REPORT.md")


if __name__ == "__main__":
    main()
