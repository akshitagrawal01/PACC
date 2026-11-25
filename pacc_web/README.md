# PACC Web App

> **Status: research prototype.** The app is not deployed publicly yet.

A Next.js 16 app for generating, scanning and testing PACC symbols (Prototype 23). All
PACC encoding and decoding runs in the browser, in a Web Worker, with the TypeScript
implementation in `src/lib/pacc/` — a bit-compatible twin of the Python reference
package `pacc/` (see the root [README](../README.md) and [`docs/pacc/SPEC.md`](../docs/pacc/SPEC.md)).
A Python bridge serves the Test Lab suites and server-side decoding.

## Tabs

The interface has four tabs: **Create**, **Scan**, **Matrix** and **Test Lab**. Advanced
options (security, image size, technical decode details, device information) sit in
collapsed sections so the default view stays simple.

### Create
- Types: **Standard** symbol, **Animated** (PACC Stream: a looping fountain-coded animation for large
  payloads), **QR-compatible** (a standard QR with a hidden, bound channel), **Layered**
  (far-readable black-and-white message plus a near-readable fine layer).
- Colours: 2, 4 or 8 (1–3 bits per cell); LDPC rate L 4/5, M 2/3, Q 1/2, H 1/3.
- Security: Ed25519 or ML-DSA-44 signatures (embedded key or key id); encryption by
  passphrase (Argon2id + ChaCha20-Poly1305) or to a recipient key (HPKE X25519, or the
  post-quantum hybrid X-Wing).
- "New key" / "New pair" buttons generate signing and recipient keys in the browser and
  show the other half to copy (nothing is stored).
- "Test scan" opens the result in Scan.

### Scan
- Image upload and live camera. Order: PACC in the worker → standard QR via zxing-wasm
  (and the hidden channel of QR-compatible symbols) → server bridge.
- Live camera: multi-frame combining (frames that fail alone are decoded together),
  stream reassembly with a progress badge, frame dropping while a decode is in flight.
- Shows signature status (valid, invalid, unknown signer, trusted), encryption, the fine
  layer of layered symbols and the hidden channel of QR-compatible symbols; prompts for a
  passphrase when needed (only the Argon2id + AEAD step runs, no re-decode).
- **Keys** panel: trusted signer public keys (kept in localStorage) and recipient
  private keys (memory only, kept while the tab is open). A symbol encrypted to a key you
  have not added shows as *Locked* and opens automatically once the key is added.

### Matrix
Suites generated and verified in the browser, each symbol decoded from its own pixels and
timed: all 32 grid sizes (24×24 to 148×148) filled to capacity; colours × code rates on one
payload; eight security envelopes including post-quantum ones. Options too large for the
chosen colours and error-correction level are skipped with a note.

### Test Lab
Multi-device sessions for real-camera testing: a host screen shows a suite, phones join by
QR code or room code and scan; results stream back live (Server-Sent Events) with device
telemetry and export as CSV/JSON (`data/test_rooms/<room>.json`).

**PACC suites** (default; `scripts/pacc_suites.py`) mirror the paper's simulation benchmarks.
They use the same symbols at equal footprint, the same distortion functions and the same
deterministic seeds as `tests/pacc_bench`, so each phone result lines up with its simulation
counterpart. N2 images leave out only the simulation's final σ=3 sensor noise, because the
camera adds real noise.

| Suite | Items | Contents |
|---|---|---|
| Paper set | 122 | all of the below in one session (about 25 min) |
| N1 · Capacity | 15 | 32 B – 1 KB at the same printed size: PACC 4 and 8 colours vs QR-H |
| N2 · Damage and lighting | 75 | 12 families × 2 strengths + clean: PACC 4/8 colours vs QR-H, paired damage |
| N5 · Signatures and encryption | 8 | Ed25519 / ML-DSA-44 signatures, passphrase, X25519 and X-Wing encryption, a tampered symbol that must be **rejected** |
| N6 · Multi-frame combining | 9 | heavy noise + moving glare as a looping animation; still single frame vs moving, and QR-H |
| N7 · Layered and QR-compatible | 13 | layered symbols read far (coarse) and near (fine); plain QR vs QC read by a QR reader vs QC hidden part |
| Animated stream | 2 | 0.5 KB and 1.5 KB PACC Streams |

How the phone grades an item depends on its `expect` rule (`src/lib/testLabGrade.ts`):

| Rule | Passes when |
|---|---|
| text | decoded content matches |
| signed | content matches and the signature verifies (per-item trusted key loaded automatically) |
| reject | the signature check fails, as it should for the tampered symbol |
| coarse / fine | the far / near layer of a layered symbol matches (coarse alone keeps scanning on a fine item) |
| qc_hidden | the hidden part matches and is bound to the visible QR |

Per-item keys (trusted signers, recipient private keys) and passphrases travel with the item.
Animated items loop on the host screen, and the phone receives no images.

Building a suite renders every item and checks it with the desktop decoder (the "sim" result),
which takes about 40 s the first time. Suites are then cached in `data/suite_cache/` until
`pacc_suites.py` or the `pacc` package changes, so later rooms start in seconds.
`python scripts/pacc_suites.py` builds the cache ahead of time.

```bash
npm run test:lab              # phone logic (TS decoder + grading) on every cached item
python ../tests/test_lab_report.py            # paper tables from data/test_rooms/*.json
python ../tests/test_lab_report.py 7964 9957  # selected rooms
```

The report counts each item once per round and device by its first outcome, treats skipped
items as failures (`--exclude-skipped` to drop them), and gives Wilson 95% intervals, median
time to scan, the desktop "sim" result for the same image, and McNemar tests for N2.

## Running

Prerequisites: Node.js 18+, Python 3.10+ with the root `requirements.txt` installed.

```bash
npm install
npm run dev                      # http://localhost:3000
npm run build && npm start       # production
```

Phones need HTTPS for the camera; for local testing:

```bash
npm run tunnel                   # Cloudflare tunnel to localhost:3000
```

## Checks

```bash
npm run typecheck
npm run lint
npm run test:pacc                # TypeScript vs Python: grids, LLRs, images, security, streams, QC, layered
```

`test:pacc` needs the vectors from `research/pacc_sim/make_*_vectors.py` (see the root
README).

## Layout

```
src/
├── app/                 # page, layout, API routes (encode/decode bridge, test-room)
├── components/          # GeneratorTab, DecoderTab, TestMatrixTab, TestLabTab, PaccKeysPanel, testlab/
└── lib/
    ├── pacc/            # TypeScript PACC: codec, ldpc, equalize, detect, secure, combine,
    │                    #   stream, qc, hier, worker, client, toResponse
    ├── zxingDecoder.ts  # standard QR (zxing-wasm) with corners/version for QC
    ├── useDecodeLoop.ts, useCamera.ts, useTestRoom.ts, cameraHelper.ts, deviceFingerprint.ts
    └── server/          # Python bridge process management
scripts/                 # api_bridge.py, pacc_suites.py, pacc_*.ts parity tests
data/test_rooms/         # Test Lab session results
```
