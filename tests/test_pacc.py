"""
Tests for the PACC reference implementation (pacc/).
"""
import io
import math

import cv2
import numpy as np
import pytest
from PIL import Image

import pacc
from pacc import codec, fmt, framing, golay, layout, ldpc
from pacc.prng import Prng, mix_seed, permutation
from pacc.spec import LEVELS, PALETTES, grid_sizes

PAYLOAD = b"https://example.com/pacc/a-reasonably-long-url?with=params&and=more_stuff_here_1234567890"


# ── Deterministic primitives (the TypeScript port must reproduce these) ──────

def test_prng_reference_values():
    p = Prng(12345)
    assert [p.next_u32() for _ in range(3)] == [1200724404, 818072533, 996137225]
    assert mix_seed(1, 2, 3) == 2352861809
    assert permutation(10, 7) == [6, 7, 8, 0, 5, 9, 4, 3, 2, 1]


def test_golay_minimum_distance_is_8():
    assert golay.min_distance() == 8


def test_ldpc_encode_satisfies_parity_and_decodes_noise():
    rng = np.random.default_rng(0)
    code = ldpc.build(1200, 600)
    info = rng.integers(0, 2, 600).astype(np.uint8)
    cw = ldpc.encode(code, info)
    assert ldpc.syndrome_ok(code, cw)
    sigma = math.sqrt(1 / (2 * 0.5 * 10 ** (2.5 / 10)))       # Eb/N0 = 2.5 dB
    y = (1 - 2.0 * cw) + rng.normal(0, sigma, len(cw))
    bits, _, ok, _ = ldpc.decode(code, 2 * y / sigma ** 2)
    assert ok and np.array_equal(bits[:600], info)


def test_ldpc_has_no_four_cycles_between_info_bits():
    code = ldpc.build(888, 316)
    seen = set()
    for members in code.check_info:
        for i, a in enumerate(members):
            for b in members[i + 1:]:
                assert (a, b) not in seen
                seen.add((a, b))


def test_framing_roundtrip_and_crc():
    msg = framing.build_message(b"hello", 0)
    bits = framing.message_to_info_bits(msg, 256)
    assert framing.parse_info_bits(bits) == (0, b"hello")
    bits[10] ^= 1
    assert framing.parse_info_bits(bits) is None


def test_layouts_are_consistent_for_every_grid_size():
    for n in grid_sizes():
        lay = layout.build(n)
        assert len(lay.data_cells) > 0
        assert lay.role.shape == (n, n)


# ── Grid-level codec ─────────────────────────────────────────────────────────

@pytest.mark.parametrize("mcs", sorted(PALETTES))
@pytest.mark.parametrize("level", [v[0] for v in LEVELS.values()])
def test_grid_roundtrip_all_modes(mcs, level):
    e = codec.encode_grid(PAYLOAD, mcs=mcs, level=level, compress=False)
    r = codec.decode_grid(e.grid.astype(float) / 255)
    assert r.ok and r.payload == PAYLOAD and r.n == e.n


@pytest.mark.parametrize("t", range(8))
def test_any_rotation_or_mirror_is_decoded(t):
    e = codec.encode_grid(PAYLOAD, mcs=1, level="Q")
    r = codec.decode_grid(fmt.dihedral(e.grid.astype(float) / 255, t))
    assert r.ok and r.payload == PAYLOAD


def test_colour_cast_shadow_and_noise_are_equalised():
    rng = np.random.default_rng(1)
    e = codec.encode_grid(PAYLOAD, mcs=2, level="H")
    x = e.grid.astype(float) / 255
    x = np.clip(x @ np.array([[0.9, 0.15, 0.0], [0.05, 0.8, 0.1], [0.1, 0.1, 0.6]]).T, 0, 1) ** 1.6
    n = x.shape[0]
    yy, xx = np.mgrid[0:n, 0:n] / n
    x = x * (1 - 0.5 * np.clip(1.3 - xx - yy, 0, 1))[..., None]
    x = np.clip(x + rng.normal(0, 0.05, x.shape), 0, 1)
    r = codec.decode_grid(x)
    assert r.ok and r.payload == PAYLOAD


def test_top_rows_damage_is_survivable():
    """Prototype 22 lost its whole header when the top two data rows were blanked."""
    e = codec.encode_grid(PAYLOAD, mcs=1, level="Q")
    x = e.grid.astype(float) / 255
    x[8:10, 10:-10] = 1.0
    r = codec.decode_grid(x)
    assert r.ok and r.payload == PAYLOAD


def test_wrong_payload_is_never_returned():
    rng = np.random.default_rng(2)
    e = codec.encode_grid(PAYLOAD, mcs=1, level="L")
    x = np.clip(e.grid.astype(float) / 255 + rng.normal(0, 0.45, e.grid.shape), 0, 1)
    r = codec.decode_grid(x)
    assert (not r.ok) or r.payload == PAYLOAD


def test_compression_flag_roundtrip():
    data = b"abc" * 200
    e = codec.encode_grid(data, mcs=1, level="Q", compress=True)
    assert e.compressed
    r = codec.decode_grid(e.grid.astype(float) / 255)
    assert r.ok and r.payload == data


def test_capacity_exceeded_raises():
    with pytest.raises(ValueError, match="exceeds the largest"):
        codec.encode_grid(np.random.default_rng(3).bytes(20000), mcs=0, level="H", compress=False)


# ── Image level ──────────────────────────────────────────────────────────────

def _place(img, pad=50):
    a = np.asarray(img)
    c = np.full((a.shape[0] + 2 * pad, a.shape[1] + 2 * pad, 3), 255, np.uint8)
    c[pad:pad + a.shape[0], pad:pad + a.shape[1]] = a
    return c


@pytest.mark.parametrize("mcs", sorted(PALETTES))
def test_image_roundtrip_with_rotation_perspective_and_jpeg(mcs):
    img, _ = pacc.encode(PAYLOAD, level="Q", mcs=mcs, cell_size=8, compress=False)
    a = _place(img)
    h, w = a.shape[:2]
    rot = cv2.warpAffine(a, cv2.getRotationMatrix2D((w / 2, h / 2), 31, 1.0), (w, h), borderValue=(255, 255, 255))
    src = np.array([[0, 0], [w, 0], [w, h], [0, h]], dtype=np.float32)
    dst = np.array([[w * 0.1, h * 0.04], [w * 0.97, 0], [w, h], [w * 0.05, h * 0.9]], dtype=np.float32)
    persp = cv2.warpPerspective(a, cv2.getPerspectiveTransform(src, dst), (w, h), borderValue=(255, 255, 255))
    buf = io.BytesIO()
    Image.fromarray(cv2.GaussianBlur(a, (0, 0), 1.2)).save(buf, "JPEG", quality=60)
    buf.seek(0)
    jpeg = np.asarray(Image.open(buf).convert("RGB"))
    for name, im in [("clean", a), ("rotated", rot), ("perspective", persp), ("blur+jpeg", jpeg)]:
        r = pacc.decode(im)
        assert r.ok and r.payload == PAYLOAD, name


# ── Localisation robustness ──────────────────────────────────────────────────

def test_three_destroyed_corners_decode_via_outline():
    img, _ = pacc.encode(b"hello from PACC", level="Q", mcs=1)
    a = np.asarray(img).copy()
    h, w = a.shape[:2]
    for y, x in [(0, 0), (0, w - 120), (h - 120, 0)]:
        a[y:y + 120, x:x + 120] = 255
    r = pacc.decode(a)
    assert r.ok and r.payload == b"hello from PACC"


def test_diagonal_scratch_through_two_finders():
    img, _ = pacc.encode(PAYLOAD, level="Q", mcs=1, cell_size=9, compress=False)
    a = _place(img)
    h, w = a.shape[:2]
    cv2.line(a, (0, 0), (w - 1, h - 1), (255, 255, 255), thickness=18)
    r = pacc.decode(a)
    assert r.ok and r.payload == PAYLOAD


def test_non_pacc_images_are_rejected_quickly():
    import time

    import qrcode

    img = qrcode.make("https://example.com/not-a-pacc-code").get_image().convert("RGB")
    pacc.decode(img, thorough=False)            # warm caches
    t0 = time.perf_counter()
    r = pacc.decode(img, thorough=False)
    assert not r.ok and time.perf_counter() - t0 < 0.5


# ── Security layer ───────────────────────────────────────────────────────────

from pacc import secure
from pacc.combine import FrameCombiner


def test_signed_symbol_verifies_and_tampering_is_detected():
    key = secure.SigningKey.generate()
    flags, body = secure.seal(PAYLOAD, True, secure.SealOptions(sign_with=key))
    r = codec.decode_grid(codec.encode_grid(PAYLOAD, sealed=(flags, body)).grid / 255)
    assert r.ok and r.payload == PAYLOAD and r.security and r.security.signature_valid and r.security.signer == key.fingerprint.hex()
    bad = bytearray(body)
    bad[40] ^= 1
    r = codec.decode_grid(codec.encode_grid(PAYLOAD, sealed=(flags, bytes(bad))).grid / 255)
    assert r.security and r.security.signature_valid is False


def test_key_id_signature_needs_trusted_key():
    key = secure.SigningKey.generate()
    e = codec.encode_grid(PAYLOAD, security=secure.SealOptions(sign_with=key, embed_public_key=False))
    r = codec.decode_grid(e.grid / 255)
    assert r.ok and r.security and r.security.signature_valid is None and not r.security.trusted
    trusted = secure.Secrets(trusted_signers={key.fingerprint.hex(): (key.alg, key.public)})
    r = codec.decode_grid(e.grid / 255, trusted)
    assert r.security and r.security.signature_valid and r.security.trusted


def test_password_symbol_is_locked_until_unlocked():
    e = codec.encode_grid(PAYLOAD, security=secure.SealOptions(password="a long passphrase here", kdf_profile=0))
    r = codec.decode_grid(e.grid / 255)
    assert r.ok and r.payload is None and r.locked == "password"
    assert codec.unlock(r, secure.Secrets(password="wrong")).payload is None
    assert codec.unlock(r, secure.Secrets(password="a long passphrase here")).payload == PAYLOAD


def test_recipient_encryption_only_opens_with_the_right_key():
    rk, other = secure.RecipientKey.generate(), secure.RecipientKey.generate()
    e = codec.encode_grid(PAYLOAD, security=secure.SealOptions(recipient=rk.public))
    assert codec.decode_grid(e.grid / 255, secure.Secrets(recipient_keys=[other])).locked == "recipient"
    assert codec.decode_grid(e.grid / 255, secure.Secrets(recipient_keys=[rk])).payload == PAYLOAD


def test_unknown_flags_are_rejected():
    r = codec.decode_grid(codec.encode_grid(b"x", sealed=(0x80, b"x")).grid / 255)
    assert not r.ok and r.error and "flags" in r.error


# ── Multi-frame combining ────────────────────────────────────────────────────

def test_frames_that_fail_alone_decode_together():
    rng = np.random.default_rng(5)
    e = codec.encode_grid(PAYLOAD, mcs=1, level="L")
    x = e.grid / 255
    comb = FrameCombiner()
    singles, decoded_at = 0, None
    for f in range(1, 9):
        obs = np.clip(x + rng.normal(0, 0.45, x.shape), 0, 1)
        singles += codec.decode_grid(obs).ok
        r = codec.decode_grid(obs, combiner=comb)
        comb.end_frame(r.ok)
        if r.ok:
            decoded_at = f
            break
    assert singles == 0 and decoded_at is not None and r.payload == PAYLOAD


def test_combiner_does_not_mix_different_codewords():
    """Stream frames share N/MCS/level; a noisy failed frame must not poison the next one."""
    rng = np.random.default_rng(6)
    a = codec.encode_grid(b"A" * 60, mcs=1, level="L", compress=False).grid / 255
    b = codec.encode_grid(b"B" * 60, mcs=1, level="L", compress=False).grid / 255
    comb = FrameCombiner()
    for _ in range(3):
        r = codec.decode_grid(np.clip(a + rng.normal(0, 0.5, a.shape), 0, 1), combiner=comb)
        comb.end_frame(r.ok)
    r = codec.decode_grid(np.clip(b + rng.normal(0, 0.2, b.shape), 0, 1), combiner=comb)
    assert r.ok and r.payload == b"B" * 60


# ── PACC Stream ──────────────────────────────────────────────────────────────

from pacc import stream


def test_stream_reassembles_from_any_frames():
    data = np.random.default_rng(7).bytes(9000)
    p = stream.plan(data, n=48, compress=False, stream_id=77)
    rng = np.random.default_rng(8)
    dec, esi = stream.StreamDecoder(), 1000          # start far into the repair sequence
    while not dec.complete:
        esi += 1
        if rng.random() < 0.4:
            continue
        dec.add(p.frame_payload(esi))
    assert dec.received <= p.k + 10
    o = dec.open()
    assert o and o.payload == data


def test_stream_frames_decode_as_symbols_and_carry_security():
    key = secure.SigningKey.generate()
    text = b"stream me " * 300
    p = stream.plan(text, n=36, security=secure.SealOptions(sign_with=key))
    dec = stream.StreamDecoder()
    for e in p.frames(p.k + 8):
        r = codec.decode_grid(e.grid / 255)
        assert r.ok and r.flags == 0x08
        if r.payload:
            dec.add(r.payload)
            if dec.complete:
                break
    o = dec.open()
    assert o and o.payload == text and o.signature_valid


# ── QR-compatible mode ───────────────────────────────────────────────────────

from pacc import qc


def test_qc_symbol_is_a_standard_qr_and_carries_a_signed_hidden_channel():
    import zxingcpp  # type: ignore
    url = "https://example.com/pay?to=ACME&amount=12.00"
    key = secure.SigningKey.generate()
    e = qc.encode(url, b"issuer=ACME", security=secure.SealOptions(sign_with=key, embed_public_key=False))
    img = qc.render(e)
    z = zxingcpp.read_barcodes(img)
    assert z and z[0].text == url                      # any QR reader still works
    tr = secure.Secrets(trusted_signers={key.fingerprint.hex(): (key.alg, key.public)})
    r = qc.decode(img, tr)
    assert r.ok and r.hidden == b"issuer=ACME" and r.bound and r.security and r.security.signature_valid and r.security.trusted


def test_qc_binding_rejects_a_different_visible_text():
    e = qc.encode("https://good.example", b"x")
    img = qc.render(e, cell_size=8, quiet=4)
    side = 8 * e.n
    corners = [(32, 32), (32 + side, 32), (32 + side, 32 + side), (32, 32 + side)]
    assert qc.decode_at(img, corners, e.version, "https://good.example").bound is True
    assert qc.decode_at(img, corners, e.version, "https://evil.example").bound is False


def test_plain_qr_has_no_hidden_channel():
    import qrcode
    q = qrcode.QRCode(border=4, box_size=8)
    q.add_data("https://example.com")
    q.make(fit=True)
    r = qc.decode(q.make_image().get_image().convert("RGB"))
    assert not r.ok and r.visible == "https://example.com"



def test_post_quantum_recipient_encryption():
    """Encryption mode 3: HPKE with the X-Wing hybrid KEM (ML-KEM-768 + X25519)."""
    key, other = secure.PqRecipientKey.generate(), secure.PqRecipientKey.generate()
    e = codec.encode_grid(PAYLOAD, mcs=2, level="Q", security=secure.SealOptions(recipient_pq=key.public))
    assert codec.decode_grid(e.grid / 255, secure.Secrets(pq_recipient_keys=[other])).locked == "recipient"
    r = codec.decode_grid(e.grid / 255, secure.Secrets(pq_recipient_keys=[key]))
    assert r.ok and r.payload == PAYLOAD and r.security and r.security.encrypted == "recipient-pq"


# ── Distance-adaptive layered symbols ────────────────────────────────────────

from pacc import hier  # noqa: E402


def _layered_image():
    coarse, fine = b"https://ex.co/p/42", b"batch 2026-10-A; origin Pune; expiry 2027-04; lot 7781-B " * 2
    e = hier.encode(coarse, fine, level="H")
    img = hier.render(e, sub_px=5)
    return coarse, fine, np.pad(img, ((40, 40), (40, 40), (0, 0)), constant_values=255)


def test_layered_symbol_reads_both_layers_up_close():
    coarse, fine, img = _layered_image()
    for t in (0, 3, 6):
        r = pacc.decode(fmt.dihedral(img, t).copy())
        assert r.ok and r.payload == coarse
        assert r.fine is not None and r.fine.ok and r.fine.payload == fine


def test_layered_symbol_degrades_to_coarse_layer_from_far():
    coarse, _, img = _layered_image()
    far = cv2.GaussianBlur(cv2.resize(img, None, fx=0.2, fy=0.2, interpolation=cv2.INTER_AREA), (0, 0), 0.8)
    r = pacc.decode(far)
    assert r.ok and r.payload == coarse and r.fine is not None and not r.fine.ok


def test_layered_fine_layer_can_be_encrypted_separately():
    rk = secure.RecipientKey.generate()
    e = hier.encode(b"public", b"private details", fine_security=secure.SealOptions(recipient=rk.public))
    img = np.pad(hier.render(e, sub_px=5), ((40, 40), (40, 40), (0, 0)), constant_values=255)
    r = pacc.decode(img)
    assert r.payload == b"public" and r.fine.locked == "recipient"
    r = pacc.decode(img, secrets=secure.Secrets(recipient_keys=[rk]))
    assert r.fine.ok and r.fine.payload == b"private details"
