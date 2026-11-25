"""
pacc.secure — Signatures and encryption for PACC messages.

The message flags byte (pacc.framing) says which layers are present. Encoding
applies them in this order, decoding undoes them in reverse:

    content --DEFLATE?--> body --sign?--> SigHeader | body | Signature --encrypt?--> Envelope

Signature layer (FLAG_SIGNED)
    SigHeader = alg (1 B: low nibble algorithm, bit 7 = public key embedded)
                | public key (embedded) or 8-byte key fingerprint
    Signature over  "PACC-SIG-v1\\0" | flags | SigHeader | body
    Algorithms: 1 = Ed25519 (64 B signature), 2 = ML-DSA-44 (FIPS 204, 2420 B).
    Fingerprint = SHA-256(alg nibble | public key)[:8].

Encryption layer (FLAG_ENCRYPTED)
    Envelope = mode (1 B) | mode header | AEAD ciphertext
    mode 1 — password: profile (1 B) | salt (16 B) | nonce (12 B) | ChaCha20-Poly1305
             key = Argon2id(password, salt, profile); AAD = "PACC-ENC-v1" | flags | mode header
             A printed symbol can be attacked offline forever: only use with long passphrases.
    mode 2 — recipient public key, HPKE base mode (RFC 9180) with
             DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, ChaCha20-Poly1305:
             key id (4 B) | enc (32 B) | ciphertext;  info = "PACC-ENC-v1" | flags | mode | key id
    mode 3 — recipient public key, post-quantum hybrid: HPKE base mode with the X-Wing KEM
             (ML-KEM-768 + X25519, HPKE KEM id 0x647A), HKDF-SHA256, ChaCha20-Poly1305:
             key id (4 B) | enc (1120 B) | ciphertext;  info as for mode 2.
             Keys are X-Wing keys: a 32-byte seed expanded with SHAKE256 into the ML-KEM-768
             seed (64 B) and the X25519 private key (32 B); public key = ML-KEM pk | X25519 pk.
"""
from __future__ import annotations

import hashlib
import os
import zlib
from dataclasses import dataclass, field

from pacc.spec import FLAG_DEFLATE, FLAG_ENCRYPTED, FLAG_LAYERED, FLAG_SIGNED, FLAG_STREAM

MAX_INFLATE = 16 * 1024 * 1024
KNOWN_FLAGS = FLAG_DEFLATE | FLAG_SIGNED | FLAG_ENCRYPTED | FLAG_STREAM | FLAG_LAYERED

SIG_CONTEXT = b"PACC-SIG-v1\x00"
ENC_CONTEXT = b"PACC-ENC-v1"

ALG_ED25519 = 1
ALG_MLDSA44 = 2
ALG_EMBEDDED = 0x80
SIG_SIZES = {ALG_ED25519: 64, ALG_MLDSA44: 2420}
PUB_SIZES = {ALG_ED25519: 32, ALG_MLDSA44: 1312}
ALG_NAMES = {ALG_ED25519: "Ed25519", ALG_MLDSA44: "ML-DSA-44"}
FINGERPRINT_LEN = 8

MODE_PASSWORD = 1
MODE_RECIPIENT = 2
MODE_RECIPIENT_PQ = 3
PQ_PUBLIC_LEN = 1184 + 32
# Argon2id profiles (single lane so the browser's WebAssembly build is not penalised).
KDF_PROFILES = {
    0: {"time_cost": 2, "memory_cost": 19 * 1024, "parallelism": 1},    # OWASP minimum
    1: {"time_cost": 3, "memory_cost": 64 * 1024, "parallelism": 1},
}
RECIPIENT_KID_LEN = 4


# ── Keys ──────────────────────────────────────────────────────────────────────

def fingerprint(alg: int, public_key: bytes) -> bytes:
    return hashlib.sha256(bytes([alg & 0x0F]) + public_key).digest()[:FINGERPRINT_LEN]


@dataclass
class SigningKey:
    alg: int
    private: bytes            # Ed25519: 32-byte seed; ML-DSA-44: 32-byte seed
    public: bytes

    @staticmethod
    def generate(alg: int = ALG_ED25519) -> SigningKey:
        return SigningKey.from_seed(alg, os.urandom(32))

    @staticmethod
    def from_seed(alg: int, seed: bytes) -> SigningKey:
        if alg == ALG_ED25519:
            from cryptography.hazmat.primitives.asymmetric import ed25519
            pk = ed25519.Ed25519PrivateKey.from_private_bytes(seed).public_key().public_bytes_raw()
        elif alg == ALG_MLDSA44:
            from cryptography.hazmat.primitives.asymmetric import mldsa
            pk = mldsa.MLDSA44PrivateKey.from_seed_bytes(seed).public_key().public_bytes_raw()
        else:
            raise ValueError(f"unsupported signature algorithm {alg}")
        return SigningKey(alg, seed, pk)

    @property
    def fingerprint(self) -> bytes:
        return fingerprint(self.alg, self.public)

    def sign(self, message: bytes) -> bytes:
        if self.alg == ALG_ED25519:
            from cryptography.hazmat.primitives.asymmetric import ed25519
            return ed25519.Ed25519PrivateKey.from_private_bytes(self.private).sign(message)
        from cryptography.hazmat.primitives.asymmetric import mldsa
        return mldsa.MLDSA44PrivateKey.from_seed_bytes(self.private).sign(message)


def verify_signature(alg: int, public_key: bytes, signature: bytes, message: bytes) -> bool:
    from cryptography.exceptions import InvalidSignature
    try:
        if alg == ALG_ED25519:
            from cryptography.hazmat.primitives.asymmetric import ed25519
            ed25519.Ed25519PublicKey.from_public_bytes(public_key).verify(signature, message)
        elif alg == ALG_MLDSA44:
            from cryptography.hazmat.primitives.asymmetric import mldsa
            mldsa.MLDSA44PublicKey.from_public_bytes(public_key).verify(signature, message)
        else:
            return False
        return True
    except (InvalidSignature, ValueError):
        return False


@dataclass
class RecipientKey:
    """X25519 key pair for recipient (public-key) encryption."""
    private: bytes
    public: bytes

    @staticmethod
    def generate() -> RecipientKey:
        return RecipientKey.from_private(os.urandom(32))

    @staticmethod
    def from_private(private: bytes) -> RecipientKey:
        from cryptography.hazmat.primitives.asymmetric import x25519
        pub = x25519.X25519PrivateKey.from_private_bytes(private).public_key().public_bytes_raw()
        return RecipientKey(private, pub)


def recipient_kid(public_key: bytes) -> bytes:
    return hashlib.sha256(b"PACC-X25519" + public_key).digest()[:RECIPIENT_KID_LEN]


@dataclass
class PqRecipientKey:
    """X-Wing (ML-KEM-768 + X25519) key pair for post-quantum recipient encryption."""
    seed: bytes             # 32 bytes
    public: bytes           # 1216 bytes

    @staticmethod
    def generate() -> PqRecipientKey:
        return PqRecipientKey.from_seed(os.urandom(32))

    @staticmethod
    def from_seed(seed: bytes) -> PqRecipientKey:
        mk, xk = _xwing_components(seed)
        pub = mk.public_key().public_bytes_raw() + xk.public_key().public_bytes_raw()
        return PqRecipientKey(seed, pub)

    def private_key(self):
        from cryptography.hazmat.primitives import hpke
        return hpke.MLKEM768X25519PrivateKey(*_xwing_components(self.seed))


def _xwing_components(seed: bytes):
    if len(seed) != 32:
        raise ValueError("X-Wing seeds are 32 bytes")
    from cryptography.hazmat.primitives.asymmetric import mlkem, x25519
    expanded = hashlib.shake_256(seed).digest(96)
    return (mlkem.MLKEM768PrivateKey.from_seed_bytes(expanded[:64]),
            x25519.X25519PrivateKey.from_private_bytes(expanded[64:]))


def _xwing_public(public: bytes):
    if len(public) != PQ_PUBLIC_LEN:
        raise ValueError(f"X-Wing public keys are {PQ_PUBLIC_LEN} bytes")
    from cryptography.hazmat.primitives import hpke
    from cryptography.hazmat.primitives.asymmetric import mlkem, x25519
    return hpke.MLKEM768X25519PublicKey(mlkem.MLKEM768PublicKey.from_public_bytes(public[:1184]),
                                        x25519.X25519PublicKey.from_public_bytes(public[1184:]))


def pq_recipient_kid(public_key: bytes) -> bytes:
    return hashlib.sha256(b"PACC-XWING" + public_key).digest()[:RECIPIENT_KID_LEN]


def _hpke_suite(pq: bool = False):
    from cryptography.hazmat.primitives import hpke
    kem = hpke.KEM.MLKEM768_X25519 if pq else hpke.KEM.X25519
    return hpke.Suite(kem, hpke.KDF.HKDF_SHA256, hpke.AEAD.CHACHA20_POLY1305)


def _argon2(password: str | bytes, salt: bytes, profile: int) -> bytes:
    from argon2.low_level import Type, hash_secret_raw
    if profile not in KDF_PROFILES:
        raise ValueError(f"unknown KDF profile {profile}")
    p = KDF_PROFILES[profile]
    pw = password.encode("utf-8") if isinstance(password, str) else password
    return hash_secret_raw(secret=pw, salt=salt, time_cost=p["time_cost"], memory_cost=p["memory_cost"],
                           parallelism=p["parallelism"], hash_len=32, type=Type.ID)


# ── Sealing (encoder side) ────────────────────────────────────────────────────

@dataclass
class SealOptions:
    sign_with: SigningKey | None = None
    embed_public_key: bool = True
    password: str | None = None
    kdf_profile: int = 1
    recipient: bytes | None = None          # X25519 public key
    recipient_pq: bytes | None = None       # X-Wing public key (post-quantum hybrid)


def seal(content: bytes, compress: bool, opts: SealOptions | None = None,
         extra_flags: int = 0) -> tuple[int, bytes]:
    """Return (flags, message body) for the content."""
    opts = opts or SealOptions()
    if sum(x is not None for x in (opts.password, opts.recipient, opts.recipient_pq)) > 1:
        raise ValueError("choose one of: password, recipient key, post-quantum recipient key")
    flags, body = extra_flags, content
    if compress:
        c = zlib.compressobj(9, zlib.DEFLATED, -15)
        packed = c.compress(content) + c.flush()
        if len(packed) < len(content):
            flags, body = flags | FLAG_DEFLATE, packed
    if opts.sign_with is not None:
        flags |= FLAG_SIGNED
    if opts.password is not None or opts.recipient is not None or opts.recipient_pq is not None:
        flags |= FLAG_ENCRYPTED

    if opts.sign_with is not None:
        key = opts.sign_with
        alg = key.alg | (ALG_EMBEDDED if opts.embed_public_key else 0)
        header = bytes([alg]) + (key.public if opts.embed_public_key else key.fingerprint)
        sig = key.sign(SIG_CONTEXT + bytes([flags]) + header + body)
        body = header + body + sig

    if opts.password is not None:
        if not opts.password:
            raise ValueError("empty password")
        salt, nonce = os.urandom(16), os.urandom(12)
        mode_header = bytes([MODE_PASSWORD, opts.kdf_profile]) + salt + nonce
        from cryptography.hazmat.primitives.ciphers.aead import ChaCha20Poly1305
        key32 = _argon2(opts.password, salt, opts.kdf_profile)
        body = mode_header + ChaCha20Poly1305(key32).encrypt(nonce, body, ENC_CONTEXT + bytes([flags]) + mode_header)
    elif opts.recipient is not None:
        from cryptography.hazmat.primitives.asymmetric import x25519
        mode_header = bytes([MODE_RECIPIENT]) + recipient_kid(opts.recipient)
        info = ENC_CONTEXT + bytes([flags]) + mode_header
        body = mode_header + _hpke_suite().encrypt(body, x25519.X25519PublicKey.from_public_bytes(opts.recipient), info=info)
    elif opts.recipient_pq is not None:
        mode_header = bytes([MODE_RECIPIENT_PQ]) + pq_recipient_kid(opts.recipient_pq)
        info = ENC_CONTEXT + bytes([flags]) + mode_header
        body = mode_header + _hpke_suite(pq=True).encrypt(body, _xwing_public(opts.recipient_pq), info=info)
    return flags, body


# ── Opening (decoder side) ────────────────────────────────────────────────────

@dataclass
class OpenResult:
    payload: bytes | None = None
    locked: str | None = None                # "password" | "recipient" when a secret is needed
    encrypted: str | None = None
    signed: str | None = None                # algorithm name
    signer: str | None = None                # hex fingerprint
    signature_valid: bool | None = None      # None = could not be checked (unknown key)
    trusted: bool | None = None              # signer is in the caller's trusted set
    recipient_kid: str | None = None
    error: str | None = None
    details: dict = field(default_factory=dict)


@dataclass
class Secrets:
    password: str | None = None
    recipient_keys: list[RecipientKey] = field(default_factory=list)
    pq_recipient_keys: list[PqRecipientKey] = field(default_factory=list)
    # fingerprint hex -> (alg, public key); used to verify key-id signatures and to mark trust
    trusted_signers: dict[str, tuple[int, bytes]] = field(default_factory=dict)


def _decrypt(flags: int, body: bytes, secrets: Secrets, out: OpenResult) -> bytes | None:
    if not body:
        out.error = "empty encrypted envelope"
        return None
    mode = body[0]
    if mode == MODE_PASSWORD:
        out.encrypted = "password"
        if len(body) < 2 + 16 + 12 + 16:
            out.error = "truncated password envelope"
            return None
        profile = body[1]
        if profile not in KDF_PROFILES:
            out.error = f"unknown KDF profile {profile}"
            return None
        mode_header = body[:30]
        salt, nonce = body[2:18], body[18:30]
        if secrets.password is None:
            out.locked = "password"
            return None
        from cryptography.exceptions import InvalidTag
        from cryptography.hazmat.primitives.ciphers.aead import ChaCha20Poly1305
        try:
            return ChaCha20Poly1305(_argon2(secrets.password, salt, profile)).decrypt(
                nonce, body[30:], ENC_CONTEXT + bytes([flags]) + mode_header)
        except InvalidTag:
            out.locked = "password"
            out.error = "wrong password or corrupted data"
            return None
    if mode == MODE_RECIPIENT:
        out.encrypted = "recipient"
        mode_header = body[:1 + RECIPIENT_KID_LEN]
        kid = mode_header[1:]
        out.recipient_kid = kid.hex()
        info = ENC_CONTEXT + bytes([flags]) + mode_header
        from cryptography.hazmat.primitives.asymmetric import x25519
        for rk in secrets.recipient_keys:
            if recipient_kid(rk.public) != kid:
                continue
            try:
                return _hpke_suite().decrypt(body[len(mode_header):],
                                             x25519.X25519PrivateKey.from_private_bytes(rk.private), info=info)
            except Exception:  # noqa: BLE001, S112 — any failure means "not this key"
                continue
        out.locked = "recipient"
        out.error = "no matching recipient key"
        return None
    if mode == MODE_RECIPIENT_PQ:
        out.encrypted = "recipient-pq"
        mode_header = body[:1 + RECIPIENT_KID_LEN]
        kid = mode_header[1:]
        out.recipient_kid = kid.hex()
        info = ENC_CONTEXT + bytes([flags]) + mode_header
        for pk in secrets.pq_recipient_keys:
            if pq_recipient_kid(pk.public) != kid:
                continue
            try:
                return _hpke_suite(pq=True).decrypt(body[len(mode_header):], pk.private_key(), info=info)
            except Exception:  # noqa: BLE001, S112 — any failure means "not this key"
                continue
        out.locked = "recipient"
        out.error = "no matching post-quantum recipient key"
        return None
    out.error = f"unsupported encryption mode {mode}"
    return None


def _verify(flags: int, body: bytes, secrets: Secrets, out: OpenResult) -> bytes | None:
    if not body:
        out.error = "empty signed body"
        return None
    alg_byte = body[0]
    alg = alg_byte & 0x0F
    if alg not in SIG_SIZES:
        out.error = f"unsupported signature algorithm {alg}"
        return None
    out.signed = ALG_NAMES[alg]
    embedded = bool(alg_byte & ALG_EMBEDDED)
    key_len = PUB_SIZES[alg] if embedded else FINGERPRINT_LEN
    sig_len = SIG_SIZES[alg]
    if len(body) < 1 + key_len + sig_len:
        out.error = "truncated signature block"
        return None
    header = body[:1 + key_len]
    content = body[1 + key_len:len(body) - sig_len]
    sig = body[len(body) - sig_len:]
    if embedded:
        pub: bytes | None = header[1:]
        fp = fingerprint(alg, header[1:])
    else:
        fp = header[1:]
        known = secrets.trusted_signers.get(fp.hex())
        pub = known[1] if known and known[0] == alg else None
    out.signer = fp.hex()
    out.trusted = fp.hex() in secrets.trusted_signers
    if pub is None:
        out.signature_valid = None
    else:
        out.signature_valid = verify_signature(alg, pub, sig, SIG_CONTEXT + bytes([flags]) + header + content)
    return content


def open_message(flags: int, body: bytes, secrets: Secrets | None = None) -> OpenResult:
    """Undo encryption, check the signature and decompress. Never raises on bad input."""
    secrets = secrets or Secrets()
    out = OpenResult()
    if flags & ~KNOWN_FLAGS:
        out.error = f"unsupported message flags 0x{flags:02x}"
        return out
    data = body
    if flags & FLAG_ENCRYPTED:
        opened = _decrypt(flags, body, secrets, out)
        if opened is None:
            return out
        data = opened
    if flags & FLAG_SIGNED:
        content = _verify(flags, data, secrets, out)
        if content is None:
            return out
        data = content
    if flags & FLAG_DEFLATE:
        d = zlib.decompressobj(-15)
        try:
            data = d.decompress(data, MAX_INFLATE)
        except zlib.error:
            out.error = "invalid compressed payload"
            return out
        if d.unconsumed_tail or not d.eof:
            out.error = "invalid or oversized compressed payload"
            return out
    out.payload = data
    return out

