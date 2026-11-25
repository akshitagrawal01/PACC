"""Printable A4 sheets (6 symbols per page) for the print-and-capture evaluation.

Symbols are rendered at whole pixels per module and placed so that every symbol, excluding its
quiet zone, has the same printed width, as in the simulation benchmark.

    py -3.12 -I tests/make_print_tests.py [--size-mm 40] [--out tests/print_tests/print_tests.pdf]
"""
from __future__ import annotations

import argparse
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path[:0] = [os.path.dirname(HERE), HERE]

from pacc_bench import common as C  # noqa: E402

CELL = 10
QUIET = 4
PAGE_W, PAGE_H = 210.0, 297.0

CODECS = ["PACC-1-Q", "PACC-1-H", "PACC-2-Q", "QR-H", "QR-M"]
NAME = {
    "PACC-1-Q": "PACC, 4 colors, rate 1/2", "PACC-1-H": "PACC, 4 colors, rate 1/3",
    "PACC-2-Q": "PACC, 8 colors, rate 1/2", "QR-H": "QR Code, level H", "QR-M": "QR Code, level M",
}
SHORT = {"PACC-1-Q": "PACC 4c 1/2", "PACC-1-H": "PACC 4c 1/3", "PACC-2-Q": "PACC 8c 1/2", "QR-H": "QR-H",
         "QR-M": "QR-M"}

COPIES = [
    ("C", "clean", "Keep undamaged. Used for every capture condition."),
    ("S1", "light stain", "One coffee drop or dirty thumb print, about 3 % of the symbol area."),
    ("S2", "heavy stain", "Two or three coffee drops or smears, about 6 % of the symbol area."),
    ("O1", "small sticker", "Opaque sticker or tape over about 5 % of the area (9 x 9 mm at 40 mm)."),
    ("O2", "large sticker", "Opaque sticker or tape over about 10 % of the area (13 x 13 mm at 40 mm)."),
    ("F1", "fold", "Fold once straight through the symbol, unfold and flatten."),
    ("F2", "crumple", "Crumple into a ball, then flatten by hand."),
    ("P", "pen line", "One line with a 1 mm black marker straight across the symbol."),
    ("R", "scuff", "Rub firmly ten times with an eraser or a coin over a third of the symbol."),
]
CAPTURE = ["Normal\n30 cm", "Tilt\n~20°", "Tilt\n~40°", "Far\n~60 cm", "Hand\nshake", "Dim\nroom", "Warm\nlamp",
           "Cool\nLED", "Day-\nlight", "Flash", "Hand\nshadow", "Glare", "Sleeve", "Close"]
DENSITY_TIERS = [32, 128, 256, 512, 1024]
DENSITY_CODECS = ["PACC-1-Q", "PACC-2-Q", "QR-H"]
PRINT_SIZES_MM = [15, 20, 25, 30]
SIZE_CODECS = ["PACC-1-Q", "PACC-2-Q", "QR-H"]


def fit(prefix: str, size: int) -> bytes:
    filler = (C.PAYLOAD.decode() + " ") * (size // len(C.PAYLOAD) + 2)
    return (prefix + " " + filler)[:size].encode()


def native(codec: str, payload: bytes) -> tuple[np.ndarray, int]:
    """RGB image at CELL px per module including a QUIET-module margin, and the symbol side in modules."""
    if codec.startswith("QR-"):
        from pacc_bench.baselines import StandardQRCodec
        img, _ = StandardQRCodec.encode(payload, ecc_level=codec[3:], box_size=CELL, border=QUIET)
        a = np.asarray(img.convert("RGB"))
        n = a.shape[0] // CELL - 2 * QUIET
    else:
        import pacc
        _, mcs, level = codec.split("-")
        img, meta = pacc.encode(payload, level=level, mcs=int(mcs), cell_size=CELL, compress=False)
        a, n = np.asarray(img), meta.n
    if a.shape[0] != (n + 2 * QUIET) * CELL:
        raise RuntimeError(f"{codec}: unexpected image size {a.shape} for {n} modules")
    return a, n


def build_items(size_mm: float) -> list[dict]:
    items = []
    for key, copy, todo in COPIES:
        for i, c in enumerate(CODECS, 1):
            items.append({"id": f"A-{key}-{i}", "codec": c, "payload": C.PAYLOAD, "mm": size_mm,
                          "line1": NAME[c], "line2": f"Copy: {copy}. {todo}" + ("" if key == "C" else
                                                                                 " Same spot on every copy.")})
    for size in DENSITY_TIERS:
        for c in DENSITY_CODECS:
            idx = len([x for x in items if x["id"].startswith("B-")]) + 1
            items.append({"id": f"B-{idx:02d}", "codec": c, "payload": fit(f"B-{idx:02d}", size), "mm": size_mm,
                          "line1": f"{NAME[c]}, {size} bytes", "line2": "Clean. Normal scan at 30 cm, then closer if needed."})
    for mm in PRINT_SIZES_MM:
        for c in SIZE_CODECS:
            idx = len([x for x in items if x["id"].startswith("D-")]) + 1
            items.append({"id": f"D-{idx:02d}", "codec": c, "payload": C.PAYLOAD, "mm": float(mm),
                          "line1": f"{NAME[c]}, {mm} mm wide", "line2": "Clean. Find the farthest distance that still decodes."})
    return items


def wrap(text: str, width: int) -> str:
    import textwrap
    return "\n".join(textwrap.wrap(text, width))


def mm_fig(plt):
    fig = plt.figure(figsize=(PAGE_W / 25.4, PAGE_H / 25.4))
    ax = fig.add_axes([0, 0, 1, 1])
    ax.set_xlim(0, PAGE_W)
    ax.set_ylim(PAGE_H, 0)
    ax.axis("off")
    return fig, ax


def footer(ax, page: int, total: int, size_mm: float) -> None:
    y = PAGE_H - 12
    ax.plot([15, 65], [y, y], color="k", lw=1.2)
    for x in (15, 65):
        ax.plot([x, x], [y - 1.5, y + 1.5], color="k", lw=1.2)
    ax.text(70, y, "50 mm check: print at 100 % (no \"fit to page\")", va="center", fontsize=7)
    ax.text(PAGE_W - 15, y, f"Sets A, B: {size_mm:g} mm  ·  page {page}/{total}", va="center", ha="right", fontsize=7)


def protocol_page(ax, size_mm: float, n_items: int) -> None:
    ax.text(15, 20, "Print-and-Capture Test Set: PACC and QR Code", fontsize=16, weight="bold")
    ax.text(15, 27, f"{n_items} symbols, 6 per page. Sets A and B are {size_mm:g} mm wide (excluding the white margin); "
            "set D varies the width.", fontsize=9)
    blocks = [
        ("Printing", [
            "A4, color, plain paper, 100 % scale. Check the 50 mm bar at the foot of every page with a ruler.",
            "Record printer model, print mode and paper. For faded print, print the set a second time in draft or "
            "economy mode and repeat sets A and D on it.",
            "Cut along the dashed frames and keep the label with each symbol."]),
        ("Set A: robustness at equal printed size (A-C to A-R)", [
            "Five configurations, as in Table II of the paper: PACC 4c 1/2, PACC 4c 1/3, PACC 8c 1/2, QR-H and QR-M.",
            "A-C (clean): scan under every capture condition of log sheet 1.",
            "A-S1/S2 stains, A-O1/O2 stickers, A-F1 fold, A-F2 crumple, A-P pen line, A-R scuff: apply the damage "
            "named on the label at the same position on all five copies, so the comparison stays paired. "
            "Photograph each damaged group side by side before scanning.",
            "Damaged copies: scan under normal conditions (30 cm, room light)."]),
        ("Set B: density (B-01 to B-15)", [
            "Payloads of 32, 128, 256, 512 and 1024 bytes for PACC 4c, PACC 8c and QR-H at the same printed size.",
            "If 30 cm fails, move closer and note the distance that worked. The 512- and 1024-byte items are limit "
            "tests of print and camera resolution."]),
        ("Set D: printed size (D-01 to D-12)", [
            "The 79-byte payload at 15, 20, 25 and 30 mm for PACC 4c, PACC 8c and QR-H.",
            "For each item, start close and move away; record the closest and farthest distance (cm) that decode. "
            "15 mm is a limit test."]),
        ("Capture conditions (log sheet 1)", [
            "Normal: 30 cm, room light. Tilt: about 20° and 40°. Far: about 60 cm. Hand shake: move the phone slowly.",
            "Dim room: one distant light. Warm lamp / cool LED: lit mainly by an incandescent-type or cold-white lamp. "
            "Daylight: outdoors in shade. Flash: phone torch on.",
            "Hand shadow: your hand shades part of the symbol. Glare: a lamp reflected on the paper. Sleeve: symbol "
            "inside a clear plastic sleeve. Close: start closer than the phone can focus."]),
        ("Scoring", [
            "Use the same scanner app build for all symbologies. Make three attempts per item and condition; an "
            "attempt passes if it decodes within 10 s. Record the number of passes (0-3). Note any wrong payload "
            "with W.",
            "Use at least two phones, with one copy of each log sheet per phone. Scan the items in a shuffled order, "
            "and alternate PACC and QR so that lighting drift affects both."]),
    ]
    y = 36
    for title, lines in blocks:
        ax.text(15, y, title, fontsize=10, weight="bold")
        y += 5
        for ln in lines:
            t = wrap(ln, 105)
            ax.text(18, y, "•", fontsize=8.5, va="top")
            ax.text(22, y, t, fontsize=8.5, va="top")
            y += 4.2 * (t.count("\n") + 1) + 1.2
        y += 2.5


def symbol_pages(plt, pdf, items, size_mm: float, total_pages: int, first_page: int) -> int:
    cols, rows = 2, 3
    top, bottom, side = 12.0, 22.0, 12.0
    cw, ch = (PAGE_W - 2 * side) / cols, (PAGE_H - top - bottom) / rows
    page = first_page
    for start in range(0, len(items), cols * rows):
        fig, ax = mm_fig(plt)
        for k, it in enumerate(items[start:start + cols * rows]):
            x0, y0 = side + (k % cols) * cw, top + (k // cols) * ch
            ax.add_patch(plt.Rectangle((x0 + 1, y0 + 1), cw - 2, ch - 2, fill=False, ls=(0, (2, 2)), lw=0.4, ec="0.6"))
            img, n = native(it["codec"], it["payload"])
            full = it["mm"] * (n + 2 * QUIET) / n
            cx, sy = x0 + cw / 2, y0 + 4
            ax.imshow(img, extent=(cx - full / 2, cx + full / 2, sy + full, sy), interpolation="none")
            ty = sy + full + 2.5
            ax.text(cx, ty, it["id"], ha="center", va="top", fontsize=11, weight="bold")
            ax.text(cx, ty + 5, it["line1"], ha="center", va="top", fontsize=7.5)
            ax.text(cx, ty + 8.6, f"{n}×{n} modules, {it['mm'] / n:.2f} mm per module", ha="center", va="top",
                    fontsize=6.5)
            ax.text(cx, ty + 12, wrap(it["line2"], 62), ha="center", va="top", fontsize=6.5, color="0.25")
        footer(ax, page, total_pages, size_mm)
        pdf.savefig(fig)
        plt.close(fig)
        page += 1
    return page


def log_sheet(ax, title: str, ids: list[str], labels: dict[str, str], cols: list[str]) -> None:
    ax.text(15, 18, title, fontsize=13, weight="bold")
    ax.text(15, 25, "Phone model / OS: ______________________________   Printer / paper: ______________________________",
            fontsize=8)
    ax.text(15, 30, "Date: ____________   Scanner app build: ____________   Tester: ____________", fontsize=8)
    x_id, x_lab, x0 = 15, 33, 66
    w = (PAGE_W - 15 - x0) / len(cols)
    y = 38
    rh = 7.5
    for j, c in enumerate(cols):
        ax.text(x0 + (j + 0.5) * w, y + 4, c, ha="center", va="center", fontsize=6)
    y += 9
    for i, item in enumerate(ids):
        yy = y + i * rh
        ax.plot([15, PAGE_W - 15], [yy, yy], color="0.6", lw=0.4)
        ax.text(x_id, yy + rh / 2, item, va="center", fontsize=8, weight="bold")
        ax.text(x_lab, yy + rh / 2, labels[item], va="center", fontsize=7)
    ax.plot([15, PAGE_W - 15], [y + len(ids) * rh] * 2, color="0.6", lw=0.4)
    for j in range(len(cols) + 1):
        ax.plot([x0 + j * w] * 2, [y, y + len(ids) * rh], color="0.6", lw=0.4)
    ax.text(15, y + len(ids) * rh + 6, "Enter passes out of 3 attempts (0-3); W = wrong payload. "
            "Notes: distances, damage photos.", fontsize=7.5)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--size-mm", type=float, default=40.0)
    ap.add_argument("--out", default=os.path.join(HERE, "print_tests", "print_tests.pdf"))
    args = ap.parse_args()

    import matplotlib
    matplotlib.use("pdf")
    import matplotlib.pyplot as plt
    from matplotlib.backends.backend_pdf import PdfPages
    plt.rcParams.update({"font.family": "DejaVu Sans", "pdf.fonttype": 42})

    items = build_items(args.size_mm)
    labels = {}
    for it in items:
        extra = {"A": "", "B": f", {len(it['payload'])} B", "D": f", {it['mm']:g} mm"}[it["id"][0]]
        labels[it["id"]] = SHORT[it["codec"]] + extra
    rows_per_sheet = 30
    sheets = [("Log sheet 1: clean copies under capture conditions",
               [it["id"] for it in items if it["id"].startswith("A-C")], CAPTURE)]
    dmg = [it["id"] for it in items if it["id"].startswith("A-") and not it["id"].startswith("A-C")]
    for k in range(0, len(dmg), rows_per_sheet):
        sheets.append(("Log sheet 2: damaged copies, normal scan", dmg[k:k + rows_per_sheet],
                       ["Passes\n(0-3)", "Notes"]))
    sheets.append(("Log sheet 3: density (B) and printed size (D)",
                   [it["id"] for it in items if it["id"][0] in "BD"],
                   ["Passes at\n30 cm (0-3)", "Closest /\nfarthest cm", "Notes"]))
    n_sym_pages = -(-len(items) // 6)
    total = 1 + n_sym_pages + len(sheets)

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with PdfPages(args.out) as pdf:
        fig, ax = mm_fig(plt)
        protocol_page(ax, args.size_mm, len(items))
        footer(ax, 1, total, args.size_mm)
        pdf.savefig(fig)
        plt.close(fig)
        page = symbol_pages(plt, pdf, items, args.size_mm, total, 2)
        for title, ids, cols in sheets:
            fig, ax = mm_fig(plt)
            log_sheet(ax, title + " (one per phone)", ids, labels, cols)
            footer(ax, page, total, args.size_mm)
            pdf.savefig(fig)
            plt.close(fig)
            page += 1
    print(f"{len(items)} symbols, {total} pages -> {args.out}")


if __name__ == "__main__":
    main()
