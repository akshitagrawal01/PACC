# PACC — Pilot-Aided Color Code

[![DOI](https://zenodo.org/badge/1471276748.svg)](https://doi.org/10.5281/zenodo.24522299)

> **Status: research prototype.** This repository accompanies the paper *Pilot-Aided Color Code: a color
> matrix barcode with spatially varying equalization and soft-decision LDPC decoding* (A. Agrawal and
> V. R. Tadiboyina, in submission). It contains the code, benchmark and the scripts that regenerate the
> paper's numbers, tables and figures.
>
> **License:** PolyForm Noncommercial 1.0.0 (see `LICENSE`): free for research, teaching and review;
> commercial use requires a separate license.
>
> The results in `tests/pacc_results/` were produced at revision `59bdd77` of the authors'
> development repository, as recorded in each run's `manifest.json`; the codec and benchmark code
> here is identical to that revision.

PACC is a 2D optical symbology built as a communication system rather than a colour
lookup. This repository holds the current design, **PACC (Prototype 23)**: a Python
reference implementation, a bit-compatible TypeScript implementation that runs in the
browser, a web app, cross-language test vectors and a benchmark suite.

## Contents

1. [What PACC does](#what-pacc-does)
2. [Results](#results)
3. [Quick start](#quick-start)
4. [Web app](#web-app)
5. [Tests](#tests)
6. [Benchmarks](#benchmarks)
7. [Paper](#paper)
8. [Repository layout](#repository-layout)
9. [Documents](#documents)
10. [Status and limitations](#status-and-limitations)

## What PACC does

- **Pilot-equalised colour.** About 4% of cells are known reference colours. The decoder
  learns how every palette colour actually looks in this capture, across the symbol
  (a global colour transform plus spatially varying gain/offset), and re-estimates the
  colour centres from the references, so shadows, colour casts and hue shifts are
  corrected rather than guessed.
- **Soft decisions.** Each cell becomes bit likelihoods around the re-estimated colour
  centres; stained, scratched or glared cells give weak or wrong likelihoods that the
  LDPC decoder absorbs.
- **One strong code over all data cells.** A rate-adaptive irregular repeat-accumulate LDPC
  code (rates 4/5, 2/3, 1/2, 1/3) built deterministically from the symbol size, decoded by
  belief propagation, with a CRC-32 so a wrong payload is never returned.
- **Iterative refinement.** If decoding fails, confidently decoded cells become extra colour
  references and the symbol is decoded again.
- **Robust geometry.** A Golay-protected, self-orienting format word in all four corners
  (any one copy fixes orientation, including mirror images) and localisation that survives
  destroyed finders (two-finder hypotheses, a finder-free outline mode).
- **Palettes:** 2 colours (1 bit/cell), 4 colours (2 bits/cell), 8 colours (3 bits/cell).
- **Multi-frame combining.** In live video, frames that fail on their own are decoded
  together by summing their soft information.
- **Security layer.** Ed25519 or post-quantum ML-DSA-44 signatures; encryption with a
  passphrase (Argon2id + ChaCha20-Poly1305) or to a recipient's public key (HPKE, RFC 9180),
  including the post-quantum hybrid X-Wing (ML-KEM-768 + X25519).
- **PACC Stream.** Payloads larger than one symbol as a looping animation of fountain-coded
  frames; a scanner can start anywhere and miss frames.
- **QR-compatible mode (QC).** A standard QR code whose module tints carry a hidden,
  optionally signed channel bound to the QR's text: every phone reads the QR, and PACC
  scanners can also verify that the URL is genuine.
- **Layered (near/far) symbols.** A black-and-white message readable from a distance, with a
  second, larger message in sub-cell tints that a close scan also reads.

## Results

**Simulation.** From `python tests/run_pacc_benchmarks.py --trials 30` (everyday protocol; full
report: `tests/pacc_results/paper_run_2026-11-24/REPORT.md`).

**Robustness at equal printed footprint** (N2): 31 everyday conditions in 14 families, each at a
typical and a demanding level: viewing angle 20°/40°, distance (symbol at 50 %/35 % size), defocus,
hand shake, indoor/dim-light noise, warm/cool light, soft shadow, glare, faded print, printer hue
error, JPEG 80/60, stains 3 %/6 %, 5 %/10 % covered, a crease, and three everyday scenes. Same
79-byte payload, every symbol scaled to the same printed width and placed at a random offset,
30 paired trials each.

| Codec | Mean decode success |
|---|---|
| PACC, 4 colours, rate 1/2 | **99.9%** |
| PACC, 4 colours, rate 1/3 | 99.9% |
| PACC, 4 colours, rate 1/2, hard decisions | 99.1% |
| QR Code, level H | 98.9% |
| PACC, 8 colours, rate 1/2 | 98.1% |
| QR Code, level M | 96.0% |
| JAB Code, 4 / 8 colours | 82.9% / 81.3% |

In everyday conditions PACC (4 colours) and QR-H are statistically tied at the same printed size
(no condition differs significantly, McNemar p < 0.05): PACC decoded 10 trials that QR-H missed,
and QR-H 1 that PACC missed. QR-H is weakest on a 12 px crease (83.3 %); QR-M fails when 10 % of
the symbol is covered. PACC (4 colours) missed one trial, in the dim restaurant-table scene. JAB
Code fails mainly with tilt, the larger occlusion and the dim scenes. For the same data PACC needs
only about a third to a half as many cells (see Density below).

**Density** (N1): for 64–1024-byte payloads a 4-colour, rate-1/2 PACC symbol needs
0.36–0.51× the area (in modules) of a level-H QR Code.

**Ablations** (N3, 4 colours): under the eight most demanding everyday conditions every decoder
variant decodes 98.3–99.6 % of trials: the special decoder steps are a safety margin, not the
everyday advantage. At the limit of decoding (hard sunlight shadow edges, a 95 % shadow, stacked
effects, heavy stains and erasures): full decoder 75.6 %; without colour-centre re-estimation
33.9 %; without decision-directed refinement 57.2 %; hard decisions 48.3 %; earlier 3 % outlier
term 64.5 %; without the local equaliser 75.6 % (no effect).

**Video** (N6): in everyday hand-held video in dim light with a moving reflection, PACC decodes
90–100 % of single frames (QR-H 43–63 %, 97–100 % within 8 frames), so frame combining is not
needed. At the limit (rate 4/5, heavy noise, every single frame fails) combining 4 frames
decodes 40–93 %, and 8 frames up to 100 %.

**Other** (N5, N7): an Ed25519 signature adds 73–97 bytes, post-quantum ML-DSA-44 about 2.4 KB
and X-Wing encryption about 1.1 KB. Layered symbols read both layers down to 1.2 px per sub-cell
and the coarse layer below that. QR-compatible symbols read as standard QR as often as plain QR
in 8 of 9 everyday conditions (96.7 % vs 100 % under strong glare), and the hidden message decoded
whenever the QR did.

The earlier breaking-point protocol (`--protocol stress`: 30 % erasure, 36 px diagonal scratch,
hue 180°, JPEG 10, 60° tilt) is kept for reproducibility.

These are simulations on rendered images with digitally applied damage and capture effects.

**Real-camera sessions** (Test Lab, 24 November 2026): two phones (OnePlus KB2001, Android 14;
OnePlus CPH2717, Android 16; Chrome) scanned the 98-item Paper set from the host's screen. For the
everyday, payload-size and video items:

| | PACC, 4 colours | PACC, 8 colours | QR Code, level H |
|---|---|---|---|
| Decoded | 50 / 50 | 42 / 44 | 46 / 50 |
| Wrong payload returned | 0 | 0 | 0 |
| Median time to scan | 174 ms | 174 ms | 138 ms |

QR-H missed the largest payloads and the dim-table scene once; the 8-colour PACC symbol missed only
the 10 %-covered item, which the desktop decoder misses too. Report:
`tests/pacc_results/test_lab_2026-11-24/REPORT.md`.

**Printed symbols:** sheets from `tests/make_print_tests.py` (40 mm symbols, hand-applied damage,
payload and size series) decoded under every condition of the print protocol, including 50–60 cm
and about 60° viewing angle.

## Quick start

```bash
pip install -r requirements.txt
python -c "import pacc; img, meta = pacc.encode(b'hello', level='Q', mcs=1); print(meta.n, pacc.decode(img).payload)"
```

```python
import pacc
from pacc import secure, stream, qc, hier

img, meta = pacc.encode(b"https://example.com", level="Q", mcs=1)          # PIL image
result = pacc.decode(img)                                                    # result.ok, result.payload

key = secure.SigningKey.generate()                                           # signed symbol
img, _ = pacc.encode(b"ticket #42", security=secure.SealOptions(sign_with=key))
r = pacc.decode(img)                                                         # r.security.signature_valid

symbol = qc.render(qc.encode("https://bank.example/pay", b"issuer=ACME"))    # QR-compatible
layered = hier.render(hier.encode(b"short far message", b"long near message"))  # near/far
plan = stream.plan(open("file.bin", "rb").read(), n=64)                      # animated stream
```

Levels are `L`, `M`, `Q`, `H` (LDPC rates 4/5, 2/3, 1/2, 1/3); `mcs` is 0, 1 or 2 (2, 4 or
8 colours).

## Web app

```bash
cd pacc_web
npm install
npm run dev            # http://localhost:3000
```

Everything PACC runs in the browser (Web Worker, no server round-trip):

| Tab | What it does |
|---|---|
| Create | Standard symbols, animated PACC Stream, QR-compatible and layered modes; signing, passphrase and recipient (incl. post-quantum) encryption; in-browser key generation |
| Scan | Upload or live camera; multi-frame combining, stream reassembly, QR hidden channels, layered fine layers; signature and encryption status; trusted-signer and recipient keys |
| Matrix | All 32 grid sizes, colours × code rates, and security envelopes, each encoded, decoded from its own pixels and timed |
| Test Lab | Multi-device sessions: a host screen shows test suites, phones scan and report; results export as CSV/JSON |

The Python bridge (`pacc_web/scripts/api_bridge.py`) serves server-side decoding and the
Test Lab suites.

## Tests

```bash
pip install -r requirements-dev.txt
pytest tests/ -q                                         # Python

# TypeScript vs Python: bit-exact grids and LLRs, images, security, streams, QC, layered
for v in parity image secure stream qc layered; do python research/pacc_sim/make_${v}_vectors.py; done
cd pacc_web && npm run test:pacc && cd ..
python research/pacc_sim/make_secure_vectors.py --check-ts   # Python opens TypeScript-made symbols
python research/pacc_sim/make_qc_vectors.py --check-ts
python pacc_web/scripts/pacc_suites.py && (cd pacc_web && npm run test:lab)   # Test Lab items graded by the phone logic
```

## Benchmarks

```bash
python tests/run_pacc_benchmarks.py --quick              # smoke run, a few minutes
python tests/run_pacc_benchmarks.py --trials 30          # paper run
python tests/run_pacc_benchmarks.py --only N2,N3 --trials 50
```

| Id | Benchmark |
|---|---|
| N1 | Capacity and density: bytes per symbol, symbol area for a given payload, vs QR |
| N2 | Robustness at equal printed footprint: 14 everyday condition families and 3 scenes, PACC vs QR (M, H), JAB Code (4, 8 colours) and a hard-decision PACC baseline; paired seeds, Wilson 95% intervals, McNemar tests |
| N3 | Decoder ablations: each decoder element, on demanding everyday conditions and at the limit |
| N4 | Encode/decode latency (Python reference) |
| N5 | Security envelope overhead: bytes, symbol size, timings |
| N6 | Multi-frame combining under noise and moving glare |
| N7 | Layered symbols vs resolution; QR-compatible mode vs plain QR with standard readers |

**Real-camera counterparts.** The Test Lab "Paper set" (N1, N2, N5, N6, N7 and an animated
stream; 98 items) shows the same symbols, damage and seeds on a screen for a phone to scan.
`python tests/test_lab_report.py` turns saved sessions into tables, with each camera result
next to the desktop result for the identical image. See `pacc_web/README.md` → Test Lab.

Output (CSV, figures, `results.json`, `manifest.json` with versions and git commit, and
`REPORT.md`) goes to `tests/pacc_results/`. Seeds are deterministic, so runs are
reproducible.

## Paper

*Pilot-Aided Color Code: a color matrix barcode with spatially varying equalization and
soft-decision LDPC decoding* (A. Agrawal and V. R. Tadiboyina), in submission. The manuscript
sources will be added here after acceptance.

`paper/make_assets.py` regenerates every number, table and data figure of the paper
(`paper/generated/`, `paper/figures/`) from `tests/pacc_results/paper_run_2026-11-24`
(benchmark) and `tests/pacc_results/test_lab_2026-11-24` (phone sessions).

```bash
python tests/run_pacc_benchmarks.py --trials 30 --out-dir tests/pacc_results/paper_run_2026-11-24
python tests/test_lab_report.py <room ids> --out tests/pacc_results/test_lab_2026-11-24
powershell -File tools/build_jabcode.ps1                  # once: builds the JAB Code baseline (needs MSYS2 gcc)
python paper/make_assets.py
python tests/make_print_tests.py                         # A4 print-and-capture test sheets
```

## Repository layout

```
PACC/
├── pacc/                      # PACC reference package (Python)
│   ├── codec.py, ldpc.py, equalize.py, modem.py, detect.py, fmt.py, framing.py, layout.py
│   ├── secure.py              #   signatures and encryption
│   ├── combine.py             #   multi-frame combining
│   ├── stream.py              #   PACC Stream (fountain-coded animation)
│   ├── qc.py                  #   QR-compatible mode
│   └── hier.py                #   layered near/far symbols
├── pacc_web/                  # Next.js web app
│   ├── src/lib/pacc/          #   TypeScript twin of pacc/ (+ worker, client)
│   ├── src/components/        #   Create, Scan, Matrix, Test Lab tabs, keys panel
│   └── scripts/               #   Python bridge, Test Lab suites, pacc_*.ts parity tests
├── tests/
│   ├── test_pacc.py, test_core.py, test_golden.py
│   ├── make_print_tests.py, test_lab_report.py   # print sheets; phone-session tables
│   ├── pacc_bench/            #   benchmark suite: baselines, distortions, stress scenarios, statistics, N1–N7
│   └── run_pacc_benchmarks.py
├── research/pacc_sim/         # cross-language test-vector generators (Python vs TypeScript)
├── docs/pacc/                 # SPEC.md (format)
├── paper/                     # make_assets.py and the tables and figures it generates
└── tools/                     # JAB Code build tooling (benchmark baseline)
```

## Documents

- [`docs/pacc/SPEC.md`](docs/pacc/SPEC.md) — symbol format, coding, security layer,
  streams, QR-compatible and layered symbols; everything an independent decoder needs.

## Status and limitations

- **Physical evaluation is everyday-level.** Two phones scanned the benchmark from a screen and
  printed symbols decoded under every everyday condition tested (see [Results](#results)). Several
  printers, papers and devices near the limits of decoding, and lens distortion, are untested.
- **Flat surfaces only.** Geometry is a single homography; curved surfaces are not modelled.
- **Thresholds were tuned on synthetic data** (format gate, outlier rate, refinement
  confidence) and should be re-checked on real captures.
- **Key management is minimal.** Trusted signers are a local list; there is no revocation
  or key distribution, and recipient key ids are 4 bytes.
- **Not implemented:** artwork mode, copy-detection (anti-counterfeit) regions.
