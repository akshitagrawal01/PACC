"""
test_lab_report.py — turn Test Lab sessions (real phone cameras) into paper tables.

    python tests/test_lab_report.py                       # every room in pacc_web/data/test_rooms
    python tests/test_lab_report.py 7964 9957             # selected rooms (ids or paths)
    python tests/test_lab_report.py --out tests/pacc_results/test_lab

Each item counts once per round and device, by its first outcome: PASS, or a failure
(TIMEOUT after 10 s, MISMATCH, or SKIPPED — the tester gave up). Use --exclude-skipped to
leave skipped items out instead. Items from
the PACC suites (scripts/pacc_suites.py) carry group / condition / codec tags; legacy B1–B13
items are grouped by the section in their sublabel.

Writes REPORT.md and outcomes.csv. Tables give success with Wilson 95% intervals, median
time to scan, and how often the desktop decoder read the same image ("sim" column), so each
camera result sits next to its simulation counterpart. N2 adds a paired McNemar test of
PACC 4 colours against QR-H over identical conditions.
"""
from __future__ import annotations

import argparse
import csv
import glob
import json
import os
import re
import statistics
import sys
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
if HERE not in sys.path:
    sys.path.insert(0, HERE)

from pacc_bench.stats import mcnemar_test, summarize_rate

ROOMS_DIR = os.path.join(ROOT, "pacc_web", "data", "test_rooms")
GROUP_ORDER = ["N1", "N2", "N5", "N6", "N7", "Stream"]


def load(arg: str) -> dict:
    path = arg if arg.endswith(".json") else os.path.join(ROOMS_DIR, f"{arg}.json")
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def tags(item: dict) -> tuple[str, str, str]:
    """(group, condition, codec) for PACC-suite and legacy items alike."""
    if item.get("group"):
        return item["group"], item.get("condition") or item.get("label", ""), item.get("codec") or item.get("codeType", "")
    m = re.match(r"\[(B\d+)[^\]]*\]", item.get("sublabel", ""))
    group = m.group(1) if m else "legacy"
    codec = item.get("badge") or item.get("codeType", "")
    return group, item.get("label", ""), codec


def outcomes(room: dict, exclude_skipped: bool = False) -> list[dict]:
    """One row per (item, round, device that scanned in that round), from the first outcome."""
    items = {it["id"]: it for it in room.get("items", [])}
    by: dict[tuple, list[dict]] = defaultdict(list)
    for log in room.get("scanLogs", []):
        if log.get("testId") in items:
            by[(log["testId"], log.get("round", 1), log.get("deviceId", "unknown"))].append(log)
    rows = []
    for (tid, rnd, dev), logs in by.items():
        logs.sort(key=lambda l: l.get("timestamp", ""))
        first = logs[0]["status"]
        if exclude_skipped and first == "SKIPPED":
            continue
        passed = first == "PASS"
        it = items[tid]
        group, cond, codec = tags(it)
        codec = codec.replace("NAQR", "PACC")  # rooms recorded before the rename use NAQR names
        pass_logs = logs[:1] if passed else []
        rows.append({
            "room": room["roomId"], "suite": room.get("suiteType"), "round": rnd, "device": logs[-1].get("deviceName", dev),
            "item": tid, "group": group, "condition": cond, "codec": codec, "severity": it.get("severity"),
            "code_type": it.get("codeType", "").replace("NAQR", "PACC"), "expect": it.get("expect", "text"), "pass": passed,
            "status": first, "later_passed": (not passed) and any(l["status"] == "PASS" for l in logs),
            "time_to_scan_ms": pass_logs[0].get("clientTimeToScanMs") if pass_logs else None,
            "attempts": pass_logs[0].get("attempts") if pass_logs else None,
            "sim_pass": it.get("serverDecodeSuccess"),
        })
    return rows


def _cell(rs: list[dict]) -> str:
    s = summarize_rate(sum(r["pass"] for r in rs), len(rs))
    return f"{s['successes']}/{s['trials']} ({s['rate_pct']:.0f}%)"


def _median_time(rs: list[dict]) -> str:
    t = [r["time_to_scan_ms"] for r in rs if r["pass"] and r["time_to_scan_ms"]]
    return f"{statistics.median(t) / 1000:.1f} s" if t else "—"


def report(rows: list[dict], rooms: list[dict]) -> str:
    L = ["# Test Lab report (real camera)", ""]
    devices = sorted({r["device"] for r in rows})
    L += [f"Rooms: {', '.join(r['roomId'] + ' (' + str(r.get('suiteType')) + ')' for r in rooms)}",
          f"Devices: {', '.join(devices) or '—'}", f"Item outcomes: {len(rows)} (first outcome per item, round and device)", ""]

    # PACC vs QR at a glance
    L += ["## PACC vs QR", "", "| code type | success | 95% CI | timeouts | mismatches | skipped |", "|---|---|---|---|---|---|"]
    by_type = defaultdict(list)
    for r in rows:
        by_type["QR" if r["code_type"] == "QR" else "PACC"].append(r)
    for t, rs in sorted(by_type.items()):
        s = summarize_rate(sum(r["pass"] for r in rs), len(rs))
        n = {st: sum(r["status"] == st for r in rs) for st in ("TIMEOUT", "MISMATCH", "SKIPPED")}
        L.append(f"| {t} | {s['successes']}/{s['trials']} ({s['rate_pct']:.1f}%) | {s['ci_lower_pct']:.1f}–{s['ci_upper_pct']:.1f}% "
                 f"| {n['TIMEOUT']} | {n['MISMATCH']} | {n['SKIPPED']} |")
    L += ["", "QR-compatible symbols read by a QR reader count as QR; their hidden part counts as PACC.", ""]

    # Overall per codec
    L += ["## Overall by codec", "", "| codec | success | 95% CI | median time to scan | sim (desktop) |", "|---|---|---|---|---|"]
    by_codec = defaultdict(list)
    for r in rows:
        by_codec[r["codec"]].append(r)
    for c, rs in sorted(by_codec.items()):
        s = summarize_rate(sum(r["pass"] for r in rs), len(rs))
        sim = [r["sim_pass"] for r in rs if r["sim_pass"] is not None]
        L.append(f"| {c} | {s['successes']}/{s['trials']} ({s['rate_pct']:.1f}%) | {s['ci_lower_pct']:.1f}–{s['ci_upper_pct']:.1f}% "
                 f"| {_median_time(rs)} | {sum(sim)}/{len(sim)} |")
    L.append("")

    # Per group: condition x codec
    groups = sorted({r["group"] for r in rows}, key=lambda g: (GROUP_ORDER.index(g) if g in GROUP_ORDER else 99, g))
    for g in groups:
        gr = [r for r in rows if r["group"] == g]
        codecs = sorted({r["codec"] for r in gr})
        conds = list(dict.fromkeys(r["condition"] for r in sorted(gr, key=lambda r: (r["severity"] is None, r["item"]))))
        L += [f"## {g}", "", "| condition | " + " | ".join(codecs) + " |", "|---" * (len(codecs) + 1) + "|"]
        for cond in conds:
            cells = []
            for c in codecs:
                rs = [r for r in gr if r["condition"] == cond and r["codec"] == c]
                if not rs:
                    cells.append("")
                    continue
                sim = [r["sim_pass"] for r in rs if r["sim_pass"] is not None]
                mark = "" if not sim else (" · sim ✓" if all(sim) else " · sim ✗")
                cells.append(_cell(rs) + mark)
            L.append(f"| {cond} | " + " | ".join(cells) + " |")
        L.append("")
        if g == "N2":
            L += _mcnemar(gr, "PACC-1-Q", "QR-H") + _mcnemar(gr, "PACC-2-Q", "QR-H")
    L += ["“sim ✓/✗”: whether the desktop decoder read the exact image shown (for QR, zxing-cpp).",
          "Camera images add real capture effects on top; N2 images omit only the simulation's final σ=3 sensor noise.", ""]
    return "\n".join(L)


def _mcnemar(gr: list[dict], a: str, b: str) -> list[str]:
    """Pairs A and B outcomes over the same condition, device and round."""
    def key(r: dict) -> tuple:
        return r["condition"], r["device"], r["round"], r["room"]

    A = {key(r): r["pass"] for r in gr if r["codec"] == a}
    B = {key(r): r["pass"] for r in gr if r["codec"] == b}
    common = sorted(set(A) & set(B))
    if not common:
        return []
    m = mcnemar_test([A[k] for k in common], [B[k] for k in common])
    return [f"McNemar {a} vs {b}: n={m['n']}, {a} only {m.get('pacc_only', 0)}, {b} only {m.get('qr_only', 0)}, "
            f"p={m['p_value']:.3g}" + (" (significant)" if m.get("significant") else ""), ""]


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("rooms", nargs="*", help="room ids or JSON paths (default: all rooms)")
    ap.add_argument("--out", default=os.path.join(HERE, "pacc_results", "test_lab"))
    ap.add_argument("--exclude-skipped", action="store_true", help="leave items the tester skipped out of the counts")
    args = ap.parse_args()
    paths = args.rooms or sorted(glob.glob(os.path.join(ROOMS_DIR, "*.json")))
    rooms = [load(p) for p in paths]
    rooms = [r for r in rooms if r.get("scanLogs")]
    rows = [row for r in rooms for row in outcomes(r, args.exclude_skipped)]
    os.makedirs(args.out, exist_ok=True)
    with open(os.path.join(args.out, "outcomes.csv"), "w", newline="", encoding="utf-8") as f:
        if rows:
            w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
            w.writeheader()
            w.writerows(rows)
    md = report(rows, rooms)
    with open(os.path.join(args.out, "REPORT.md"), "w", encoding="utf-8") as f:
        f.write(md)
    print(md)
    print(f"\nWrote {args.out}/REPORT.md and outcomes.csv")


if __name__ == "__main__":
    main()
