# Test Lab report (real camera)

Rooms: 1948 (paper_set), 2714 (paper_set)
Devices: Android CPH2717 (Android 16), Android KB2001 (Android 14)
Item outcomes: 196 (first outcome per item, round and device)

## PACC vs QR

| code type | success | 95% CI | timeouts | mismatches | skipped |
|---|---|---|---|---|---|
| PACC | 126/130 (96.9%) | 92.4–98.8% | 4 | 0 | 0 |
| QR | 62/66 (93.9%) | 85.4–97.6% | 4 | 0 | 0 |

QR-compatible symbols read by a QR reader count as QR; their hidden part counts as PACC.

## Overall by codec

| codec | success | 95% CI | median time to scan | sim (desktop) |
|---|---|---|---|---|
| PACC QC | 16/16 (100.0%) | 80.6–100.0% | 0.1 s | 16/16 |
| PACC layered | 8/8 (100.0%) | 67.6–100.0% | 0.3 s | 8/8 |
| PACC stream 48×48 | 2/2 (100.0%) | 34.2–100.0% | 0.3 s | 2/2 |
| PACC stream 64×64 | 2/2 (100.0%) | 34.2–100.0% | 0.9 s | 2/2 |
| PACC-1-Q | 64/66 (97.0%) | 89.6–99.2% | 0.2 s | 66/66 |
| PACC-2-Q | 42/44 (95.5%) | 84.9–98.7% | 0.2 s | 42/44 |
| QR-H | 46/50 (92.0%) | 81.2–96.8% | 0.1 s | 50/50 |
| QR-M | 8/8 (100.0%) | 67.6–100.0% | 0.1 s | 8/8 |

## N1

| condition | PACC-1-Q | PACC-2-Q | QR-H |
|---|---|---|---|
| 32 B | 2/2 (100%) · sim ✓ | 2/2 (100%) · sim ✓ | 2/2 (100%) · sim ✓ |
| 512 B | 2/2 (100%) · sim ✓ | 2/2 (100%) · sim ✓ | 1/2 (50%) · sim ✓ |
| 1024 B | 2/2 (100%) · sim ✓ | 2/2 (100%) · sim ✓ | 0/2 (0%) · sim ✓ |
| 128 B | 2/2 (100%) · sim ✓ | 2/2 (100%) · sim ✓ | 2/2 (100%) · sim ✓ |
| 256 B | 2/2 (100%) · sim ✓ | 2/2 (100%) · sim ✓ | 2/2 (100%) · sim ✓ |

## N2

| condition | PACC-1-Q | PACC-2-Q | QR-H |
|---|---|---|---|
| Clean | 2/2 (100%) · sim ✓ | 2/2 (100%) · sim ✓ | 2/2 (100%) · sim ✓ |
| Tilt 40° | 2/2 (100%) · sim ✓ | 2/2 (100%) · sim ✓ | 2/2 (100%) · sim ✓ |
| Far away (35 % size) | 2/2 (100%) · sim ✓ | 2/2 (100%) · sim ✓ | 2/2 (100%) · sim ✓ |
| Out of focus (2 px) | 2/2 (100%) · sim ✓ | 2/2 (100%) · sim ✓ | 2/2 (100%) · sim ✓ |
| Hand shake (9 px) | 2/2 (100%) · sim ✓ | 2/2 (100%) · sim ✓ | 2/2 (100%) · sim ✓ |
| Dim light (noise σ20) | 2/2 (100%) · sim ✓ | 2/2 (100%) · sim ✓ | 2/2 (100%) · sim ✓ |
| Cool light | 2/2 (100%) · sim ✓ | 2/2 (100%) · sim ✓ | 2/2 (100%) · sim ✓ |
| Warm light | 2/2 (100%) · sim ✓ | 2/2 (100%) · sim ✓ | 2/2 (100%) · sim ✓ |
| Shadow (60 % darker) | 2/2 (100%) · sim ✓ | 2/2 (100%) · sim ✓ | 2/2 (100%) · sim ✓ |
| Glare (reflection) | 2/2 (100%) · sim ✓ | 2/2 (100%) · sim ✓ | 2/2 (100%) · sim ✓ |
| Faded print (55 % colour) | 2/2 (100%) · sim ✓ | 2/2 (100%) · sim ✓ | 2/2 (100%) · sim ✓ |
| Printer colour shift 20° | 2/2 (100%) · sim ✓ | 2/2 (100%) · sim ✓ | 2/2 (100%) · sim ✓ |
| JPEG quality 60 | 2/2 (100%) · sim ✓ | 2/2 (100%) · sim ✓ | 2/2 (100%) · sim ✓ |
| Stains (6 %) | 2/2 (100%) · sim ✓ | 2/2 (100%) · sim ✓ | 2/2 (100%) · sim ✓ |
| 10 % covered | 2/2 (100%) · sim ✓ | 0/2 (0%) · sim ✗ | 2/2 (100%) · sim ✓ |
| Crease (12 px) | 2/2 (100%) · sim ✓ | 2/2 (100%) · sim ✓ | 2/2 (100%) · sim ✓ |
| Everyday: dim restaurant table | 2/2 (100%) · sim ✓ | 2/2 (100%) · sim ✓ | 1/2 (50%) · sim ✓ |

McNemar PACC-1-Q vs QR-H: n=34, PACC-1-Q only 1, QR-H only 0, p=1

McNemar PACC-2-Q vs QR-H: n=34, PACC-2-Q only 1, QR-H only 2, p=1

## N5

| condition | PACC-1-Q |
|---|---|
| Plain | 2/2 (100%) · sim ✓ |
| Ed25519, key embedded | 2/2 (100%) · sim ✓ |
| Ed25519, key id | 2/2 (100%) · sim ✓ |
| ML-DSA-44, key id | 0/2 (0%) · sim ✓ |
| Passphrase | 2/2 (100%) · sim ✓ |
| To key, X25519 | 2/2 (100%) · sim ✓ |
| To key, X-Wing (PQ) | 2/2 (100%) · sim ✓ |
| Tampered after signing | 2/2 (100%) · sim ✓ |

## N6

| condition | PACC-1-Q | QR-H |
|---|---|---|
| Dim light σ15, moving reflection | 2/2 (100%) · sim ✓ | 2/2 (100%) · sim ✓ |
| Dim light σ25, moving reflection | 2/2 (100%) · sim ✓ | 2/2 (100%) · sim ✓ |
| Dim light σ35, moving reflection | 2/2 (100%) · sim ✓ | 2/2 (100%) · sim ✓ |

## N7

| condition | PACC QC | PACC layered | QR-M |
|---|---|---|---|
| Layered coarse |  | 4/4 (100%) · sim ✓ |  |
| Layered fine |  | 4/4 (100%) · sim ✓ |  |
| QR plain · Clean |  |  | 2/2 (100%) · sim ✓ |
| QC visible · Clean | 2/2 (100%) · sim ✓ |  |  |
| QC hidden · Clean | 2/2 (100%) · sim ✓ |  |  |
| QR plain · Warm light |  |  | 2/2 (100%) · sim ✓ |
| QC visible · Warm light | 2/2 (100%) · sim ✓ |  |  |
| QC hidden · Warm light | 2/2 (100%) · sim ✓ |  |  |
| QR plain · Dim light |  |  | 2/2 (100%) · sim ✓ |
| QC visible · Dim light | 2/2 (100%) · sim ✓ |  |  |
| QC hidden · Dim light | 2/2 (100%) · sim ✓ |  |  |
| QR plain · Glare |  |  | 2/2 (100%) · sim ✓ |
| QC visible · Glare | 2/2 (100%) · sim ✓ |  |  |
| QC hidden · Glare | 2/2 (100%) · sim ✓ |  |  |

## Stream

| condition | PACC stream 48×48 | PACC stream 64×64 |
|---|---|---|
| 512 B | 2/2 (100%) · sim ✓ |  |
| 1500 B |  | 2/2 (100%) · sim ✓ |

“sim ✓/✗”: whether the desktop decoder read the exact image shown (for QR, zxing-cpp).
Camera images add real capture effects on top; N2 images omit only the simulation's final σ=3 sensor noise.
