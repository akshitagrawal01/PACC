# PACC Symbol Specification (draft 0.4)

Status: research prototype. Reference implementation: [`pacc/`](../../pacc). Everything an
independent decoder needs is defined here; where a value comes from a pseudo-random
generator, the generator itself is specified (Section 2) so implementations are
bit-exact.

Changes in draft 0.4 (October 2026): the security-layer context strings are `PACC-SIG-v1`,
`PACC-ENC-v1`, `PACC-X25519` and `PACC-XWING` (Section 9); the QR-compatible palette uses
milder tints (Section 12); the reference demapper's outlier weight is 10⁻⁴ (Section 7).
Symbols sealed under draft 0.3 do not verify or decrypt under draft 0.4.

## 1. Overview

A PACC symbol is an N × N grid of square cells (N = 24 + 4i, i = 0…31, so 24 ≤ N ≤ 148)
surrounded by a white quiet zone of at least 4 cells. Cells play one of four roles:

| Role | Cells | Purpose |
|---|---|---|
| Finder | 4 × 64 (7×7 pattern + 1-cell light separator per corner) | Localisation |
| Format | 4 × 24 | Grid size, modulation, robustness level, orientation |
| Pilot | one per 5×5 block (≈ 4%) | Colour references for equalisation |
| Data | all remaining cells, row-major | LDPC-coded payload |

Data bits are mapped to colours from a small palette (2, 4 or 8 colours). The decoder
does not assume the printed colours: it learns the captured appearance of every palette
entry from the pilots, finders and format cells, locally across the symbol, and refines
that model using its own decisions.

## 2. Deterministic pseudo-random generator

All pseudo-random structure uses this 32-bit generator (unsigned arithmetic mod 2³²;
`imul` is the low 32 bits of the product):

```
next():  state = state + 0x9E3779B9
         z = state
         z = imul(z XOR (z >> 16), 0x85EBCA6B)
         z = imul(z XOR (z >> 13), 0xC2B2AE35)
         return z XOR (z >> 16)
below(n): next() mod n
shuffle(list): for i = len-1 down to 1: j = below(i+1); swap(list[i], list[j])
bits(n): concatenate next() words, least significant bit first, truncate to n
mix_seed(v1, v2, ...): h = 0x50414343; for each v: h = imul(h XOR v, 0x9E3779B1); h = h XOR (h >> 15)
```

Reference values: with seed 12345 the first three outputs are 1200724404, 818072533,
996137225; `mix_seed(1, 2, 3)` = 3888320701.

## 3. Geometry

Coordinates are (row, column), origin top-left.

**Finders.** In each corner, a 7×7 pattern (dark border, light ring, dark 3×3 core) and a
light separator completing an 8×8 block. Finder dark cells are black (0, 0, 0); finder
light cells and separators are white (255, 255, 255).

**Format cells.** Top-left list, in bit order (24 cells):
row 8, columns 0–7; column 8, rows 0–8; row 9, columns 0–6.
Corner c ∈ {0 = TL, 1 = TR, 2 = BR, 3 = BL} uses the mirror image: column → N−1−column
for c ∈ {1, 2}; row → N−1−row for c ∈ {2, 3}.

**Pilots.** Every cell with row ≡ 2 and column ≡ 2 (mod 5) that is not a finder or format
cell. The pilot at (r, c) shows palette entry `(r div 5 + 3 · (c div 5)) mod M`.

**Data cells.** All remaining cells in row-major order.

## 4. Format word

Each corner holds a Golay(24, 12) codeword of
`corner (2 bits) | grid index i (5) | MCS (3) | level (2)` (most significant first),
drawn black for bit 1 and white for bit 0. The (23, 12) code uses generator
x¹¹ + x¹⁰ + x⁶ + x⁵ + x⁴ + x² + 1 in systematic form (information in the top 12 bits),
extended by an even-parity bit (least significant). Minimum distance 8.

Because each copy names its own corner, any readable copy fixes the orientation. The
reference decoder correlates soft luminance values against all codewords and jointly
scores the four copies under each of the 8 rotations/reflections of the sampled grid.

## 5. Modulation (MCS)

| MCS | Name | Bits/cell | Palette (entry = bit label, MSB first) |
|---|---|---|---|
| 0 | BW | 1 | white, black |
| 1 | KCMY | 2 | black, cyan, magenta, yellow |
| 2 | CUBE8 | 3 | the 8 RGB-cube corners; label bits = (R, G, B) on/off |
| 3–7 | reserved | | |

KCMY is the regular tetrahedron inscribed in the RGB cube (all pairs equidistant) and is
printable with process inks. In CUBE8, neighbouring corners differ in one label bit.

## 6. Coding

**Parameters.** n = (number of data cells) × (bits per cell). The level sets the rate
R = num/den: L = 4/5, M = 2/3, Q = 1/2, H = 1/3; k = ⌊⌊n · num / den⌋ / 8⌋ · 8.

**Message.** `flags (1 byte) | length (2 bytes, big-endian) | payload | CRC-32 (4 bytes)`,
CRC-32 (IEEE) over flags, length and payload; zero-padded to k bits; then XORed with
`bits(k)` from a generator seeded `mix_seed(0x5C2A, k)`.

| Flag | Meaning |
|---|---|
| 0x01 | DEFLATE: the innermost content is raw DEFLATE |
| 0x02 | SIGNED: signature layer present (Section 9) |
| 0x04 | ENCRYPTED: encryption envelope present (Section 9) |
| 0x08 | STREAM: the payload is one fragment of a PACC Stream (Section 11); no other flag may be set |
| 0x10 | LAYERED: a fine chroma layer is present inside the cells (Section 13) |
| 0x20–0x80 | reserved; decoders must reject a message that sets them |

**LDPC code.** Irregular repeat-accumulate; m = n − k checks; check i contains a set of
information bits plus parity bits p_i and p_(i−1) (i ≥ 1). Encoding:
p_i = p_(i−1) ⊕ (XOR of its information bits).

Construction (integer arithmetic only):
1. `dc = max(2, (8k + 3m) div (2m))`; heavy degree `h = 12` if `10k < 4n` or `10k > 7n`,
   else 8; `h = min(h, m)`; light degree `l = min(3, m)`;
   `n_heavy = clamp((m · dc − l · k) div (h − l), 0, k)` (0 if h ≤ l).
2. Sockets: information bit v appears h times if v < n_heavy, else l times, in order.
   Shuffle with a generator seeded `mix_seed(0x1D9C, n, k)`.
3. Deal sockets to checks in order; check c receives `⌊S/m⌋ + (1 if c < S mod m)` sockets.
   A socket conflicts if its bit is already in the check or already shares a check with a
   member (4-cycle). On conflict, up to 48 times: `j = pos + 1 + below(S − pos − 1)`; if
   socket j does not conflict, swap and stop. Then take the socket at pos; if its bit is
   already in the check, drop it; otherwise record all its pairs with current members.

**Interleaver.** Transmitted bit t carries codeword bit `perm[t]`, where `perm` is
`shuffle([0 … n−1])` with seed `mix_seed(0x1A7E, n)`. Cell j of the data-cell list
carries transmitted bits `[j·b, (j+1)·b)` as its palette label (b = bits per cell).

## 7. Reference decoding procedure (informative)

1. Locate finders (nested-contour test with ring area ratios), choose a corner quad
   (complete a parallelogram if only three are found), estimate N from finder spacing ÷
   module size, sample each cell as the mean of a 5×5 sub-sample patch over its inner 60%.
2. Read the format word from soft luminance (finder black/white as levels); retry with
   the N it reports if it disagrees.
3. Fit the colour equaliser from reference cells (finder, separator, format, pilots):
   a global quadratic colour transform by ridge regression, then a smoothly varying
   per-channel gain/offset from Gaussian-weighted reference statistics (σ = 4 cells).
4. Estimate the constellation: for each palette entry, the weighted mean of the equalised
   colours of reference cells showing it, shrunk towards the nominal colour with a
   pseudo-count of 1; the noise covariance is the pooled weighted scatter around these
   centroids (× 1.3, + 0.002·I). This corrects the shrinkage of the clusters that the
   regression-based equaliser produces at low SNR.
5. Soft-demap each data cell against the estimated centroids with a Gaussian likelihood
   (plus a uniform component of weight ε = 10⁻⁴ as a numerical floor). Damaged cells need no
   special treatment: their LLRs are weak or wrong and the LDPC decoder absorbs them. A
   larger ε (0.03) was measured to hurt: it discarded genuine cells as outliers under deep
   shadow, blur and heavy erasure (benchmark N3).
6. Sum-product LDPC decoding; descramble; verify CRC-32.
7. If decoding fails, add data cells whose decoded-symbol posterior ≥ 0.95 as references,
   refit the equaliser, and decode again (up to two refinement rounds).

## 8. Capacity

Capacities follow from Section 6; `pacc.capacity(N, mcs, level)` gives the exact payload
limit. Example: a 91-byte URL needs N = 36 at KCMY/Q, where Prototype 22's default (ECC-2 × 2
copies) needs N = 45.

## 9. Security layer

Applied by the encoder in this order and undone in reverse:
`content → DEFLATE? → sign? → encrypt?`. The message flags byte records each layer.

**Signature (flag 0x02).** Body = `SigHeader | inner | Signature`.
SigHeader = `alg (1 byte) | key field`; the low nibble of `alg` is the algorithm, bit 7 set
means the key field is the full public key, otherwise it is the 8-byte fingerprint
`SHA-256(alg nibble | public key)[0:8]`. The signature covers
`"PACC-SIG-v1" 0x00 | flags | SigHeader | inner`.

| alg | Algorithm | Public key | Signature |
|---|---|---|---|
| 1 | Ed25519 (RFC 8032) | 32 B | 64 B |
| 2 | ML-DSA-44 (FIPS 204, empty context) | 1312 B | 2420 B |
| 3–15 | reserved (e.g. FN-DSA) | | |

A decoder reports: algorithm, signer fingerprint, signature valid / invalid / not
checkable (key-id form with an unknown key), and whether the signer is in its trusted set.
It returns the content in every case; trust decisions belong to the application.

**Encryption (flag 0x04).** Body = `mode (1 byte) | mode header | ciphertext`.

| Mode | Header | Cipher |
|---|---|---|
| 1 password | profile (1 B) · salt (16 B) · nonce (12 B) | key = Argon2id(password, salt; profile 0: t=2, m=19 MiB, p=1; profile 1: t=3, m=64 MiB, p=1); ChaCha20-Poly1305, AAD = `"PACC-ENC-v1" | flags | mode header` |
| 2 recipient | key id (4 B) = `SHA-256("PACC-X25519" | pkR)[0:4]` | HPKE base mode, RFC 9180: DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, ChaCha20-Poly1305; info = `"PACC-ENC-v1" | flags | mode header`; ciphertext = enc (32 B) · AEAD output |
| 3 recipient, post-quantum | key id (4 B) = `SHA-256("PACC-XWING" | pkR)[0:4]` | HPKE base mode with the X-Wing hybrid KEM (ML-KEM-768 + X25519, HPKE KEM id 0x647A), HKDF-SHA256, ChaCha20-Poly1305; info as for mode 2; ciphertext = enc (1120 B) · AEAD output. Keys: a 32-byte seed expanded by SHAKE256 to 96 bytes = ML-KEM-768 seed (64 B) · X25519 private key (32 B); pkR = ML-KEM pk (1184 B) · X25519 pk (32 B) |

Printed symbols can be attacked offline indefinitely, so password mode needs long
passphrases; recipient mode has no such weakness. A decoder without the secret reports
the symbol as decoded but *locked*, and keeps the envelope so it can be opened later
without re-reading the image.

## 10. Multi-frame combining (informative)

Successive camera frames of one symbol are independent observations of the same codeword.
The reference decoder keeps, per (N, MCS, level), the first-pass codeword-order channel
LLRs of up to 8 failed frames (duplicate frames are ignored). Each new frame is decoded
on its own first; if that fails, its LLRs plus the stored sum are decoded. History is
dropped when it disagrees with the new frame (fewer than 70% sign agreement on bits
where both |LLR| > 2, given at least 32 such bits), which happens when the symbol changes,
e.g. between frames of a stream.

## 11. PACC Stream

Payloads larger than one symbol are shown as an animated loop of symbols. The whole
message is sealed once (Section 9) and split into K = ⌈L / B⌉ source blocks of B bytes
(zero-padded). Every frame is an ordinary PACC symbol whose message flags are exactly
0x08 and whose payload is

```
stream id (4 B) | message length L (4 B) | block size B (2 B) | block id e (4 B) | message flags (1 B) | block (B bytes)
```

Block e < K is source block e. Block e ≥ K is the XOR of the source blocks j with
`bits(K)[j] = 1` from a generator seeded `mix_seed(0x57EA, stream id, e)` (if no bit is set,
block e mod K is used). Any K independent blocks recover the message by GF(2)
elimination; with dense random blocks, K suffice with probability ≈ 0.29, K + 2 with
≈ 0.77 and K + 7 with ≈ 0.99 (∏ over j > m of (1 − 2⁻ʲ)); measured mean overhead ≈ 1.6
blocks. K ≤ 4096. Frames use a fixed N, so B = capacity(N, MCS, level) − 15.

## 12. PACC QC — QR-compatible symbols

A QR Code (ISO/IEC 18004, any version, any error-correction level) whose module colours
are taken from four colours indexed `2 · dark + warm`:

| | cool (0) | warm (1) |
|---|---|---|
| light | (205, 242, 255) | (255, 243, 200) |
| dark | (0, 15, 95) | (95, 0, 15) |

Luminance follows the QR exactly (light ≥ 0.91, dark ≤ 0.12 in Rec. 601 luma, contrast
≥ 0.79), so standard readers decode the QR unchanged; stronger tints were measured to cost
QR readability under noise. Chroma carries a hidden channel:

* **Pilots:** finder patterns with separators, timing patterns, alignment patterns and the
  dark module. Their luminance is fixed by the QR standard; their chroma is warm iff
  (row + column) is odd.
* **Hidden data:** every other module (data, error correction, format and version
  information), in row-major order, carries one bit: the transmitted bits of an LDPC
  codeword (Section 6 construction, rate 1/2: k = ⌊⌊n/2⌋/8⌋·8 for n hidden modules),
  with the Section 6 framing, scrambling and interleaver and the Section 9 security layer.
* **Plaintext:** `binding (1 B) | …`. Binding 0: the hidden content follows. Binding 1:
  the next 16 bytes are `SHA-256(visible QR text)[0:16]`, then the hidden content; a
  signature over the hidden message therefore authenticates the visible text too.

Decoding: a standard QR reader supplies the four outer corners and the version; corners
are refined (each by up to ½ module, two passes) to maximise the light/dark contrast of
the pilot modules; cells are sampled and equalised as in Section 7 with the four QC colours
as the palette; the luminance bit is marginalised out of each cell's likelihood and only
the chroma-bit LLR is passed to the LDPC decoder (one decision-directed refinement round).

## 13. Layered (distance-adaptive) symbols

A layered symbol carries two messages in one print:

* **Coarse layer:** an ordinary MCS 0 (black-and-white) PACC symbol whose message flags
  include 0x10. It is readable wherever the cells are resolved — far away or blurred.
* **Fine layer:** every coarse cell is split into S × S sub-cells (S = 2). A sub-cell
  keeps its parent's luminance (dark parent → dark colour, light parent → light colour)
  and is tinted warm or cool with the stronger layer palette: light cool (150, 228, 255),
  light warm (255, 226, 140), dark cool (0, 34, 150), dark warm (150, 0, 34).
  - Sub-cells of non-data coarse cells (finders, separators, format and pilot cells) are
    **pilots**: warm iff (fine row + fine column) is odd.
  - Sub-cells of coarse data cells, in fine-grid row-major order, carry the transmitted
    bits of a rate-1/2 LDPC codeword (Section 6 construction with n = number of such
    sub-cells, k = ⌊⌊n/2⌋/8⌋·8), with the Section 6 framing, scrambling and interleaver
    and its own Section 9 security layer (bit 1 = warm).

Decoding (informative): decode the coarse layer; re-encode it from its message (same N,
MCS, level, flags and body) so the luminance of every sub-cell is known; map fine cell
coordinates through the coarse homography scaled by 1/S; refine the four outer corners
in two stages — first to maximise agreement of sampled luminance with the known coarse
pattern at sub-cell centres (unambiguous within about one coarse cell), then to maximise
agreement of warm-minus-cool chroma with the pilot checkerboard; sample, equalise over
the four layer colours and compute each data sub-cell's LLR from the two colours of
its known luminance only. Measured on renders: the fine layer reads down to about
1.2 px per sub-cell; below that only the coarse layer decodes.
