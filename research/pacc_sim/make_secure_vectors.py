"""
Cross-language vectors for the PACC security layer (signatures, HPKE, password).

    python research/pacc_sim/make_secure_vectors.py            -> secure_vectors.json (Python-sealed)
    npx jiti pacc_web/scripts/pacc_secure.ts                   -> checks them, writes ts_secure_vectors.json
    python research/pacc_sim/make_secure_vectors.py --check-ts -> Python opens the TypeScript-sealed ones

Keys are derived from fixed seeds so both sides know them. Test keys only.
"""
from __future__ import annotations

import argparse
import json
import os
import sys

import numpy as np

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, ROOT)

from pacc import codec, secure  # noqa: E402

HERE = os.path.dirname(__file__)
ED_SEED = bytes(range(32))
MLDSA_SEED = bytes(range(32, 64))
X25519_PRIV = bytes(range(64, 96))
XWING_SEED = bytes(range(96, 128))
PASSWORD = "correct horse battery staple"
TEXT = b"PACC secure payload: https://example.com/ticket/8842?seat=14C " * 2


def keys():
    ed = secure.SigningKey.from_seed(secure.ALG_ED25519, ED_SEED)
    pq = secure.SigningKey.from_seed(secure.ALG_MLDSA44, MLDSA_SEED)
    rk = secure.RecipientKey.from_private(X25519_PRIV)
    return ed, pq, rk


def secrets_for(case: dict, ed, pq, rk) -> secure.Secrets:
    s = secure.Secrets()
    if case.get("password"):
        s.password = PASSWORD
    if case.get("recipient"):
        s.recipient_keys = [rk]
    if case.get("recipient_pq"):
        s.pq_recipient_keys = [secure.PqRecipientKey.from_seed(XWING_SEED)]
    for name in case.get("trust", []):
        k = {"ed": ed, "pq": pq}[name]
        s.trusted_signers[k.fingerprint.hex()] = (k.alg, k.public)
    return s


CASES = [
    {"name": "ed25519-embedded", "sign": "ed", "embed": True, "expect": {"signed": "Ed25519", "valid": True, "trusted": False}},
    {"name": "ed25519-keyid-trusted", "sign": "ed", "embed": False, "trust": ["ed"],
     "expect": {"signed": "Ed25519", "valid": True, "trusted": True}},
    {"name": "ed25519-keyid-unknown", "sign": "ed", "embed": False, "expect": {"signed": "Ed25519", "valid": None, "trusted": False}},
    {"name": "mldsa44-keyid", "sign": "pq", "embed": False, "trust": ["pq"], "mcs": 2, "level": "L",
     "expect": {"signed": "ML-DSA-44", "valid": True, "trusted": True}},
    {"name": "hpke-recipient+ed25519", "sign": "ed", "embed": True, "recipient": True,
     "expect": {"signed": "Ed25519", "valid": True, "encrypted": "recipient"}},
    {"name": "hpke-xwing-pq+mldsa44", "sign": "pq", "embed": False, "trust": ["pq"], "recipient_pq": True,
     "mcs": 2, "level": "L", "expect": {"signed": "ML-DSA-44", "valid": True, "trusted": True, "encrypted": "recipient-pq"}},
    {"name": "password", "password": True, "expect": {"encrypted": "password"}},
    {"name": "tampered-signature", "sign": "ed", "embed": True, "tamper": True, "expect": {"signed": "Ed25519", "valid": False}},
]


def seal_case(case: dict, ed, pq, rk) -> tuple[int, bytes]:
    opts = secure.SealOptions(
        sign_with={"ed": ed, "pq": pq}.get(case.get("sign", "")),
        embed_public_key=case.get("embed", True),
        password=PASSWORD if case.get("password") else None, kdf_profile=0,
        recipient=rk.public if case.get("recipient") else None,
        recipient_pq=secure.PqRecipientKey.from_seed(XWING_SEED).public if case.get("recipient_pq") else None,
    )
    flags, body = secure.seal(TEXT, True, opts)
    if case.get("tamper"):
        b = bytearray(body)
        b[40] ^= 0x01                       # inside the signed content
        body = bytes(b)
    return flags, body


def check(case: dict, grid: np.ndarray, ed, pq, rk) -> list[str]:
    r = codec.decode_grid(grid.astype(float) / 255, secrets_for(case, ed, pq, rk))
    errs = []
    exp = case["expect"]
    sec = r.security
    if not r.ok or sec is None:
        return [f"decode failed: {r.error}"]
    if "signed" in exp and sec.signed != exp["signed"]:
        errs.append(f"signed {sec.signed}")
    if "valid" in exp and sec.signature_valid != exp["valid"]:
        errs.append(f"signature_valid {sec.signature_valid}")
    if "trusted" in exp and sec.trusted != exp["trusted"]:
        errs.append(f"trusted {sec.trusted}")
    if "encrypted" in exp and sec.encrypted != exp["encrypted"]:
        errs.append(f"encrypted {sec.encrypted}")
    if not case.get("tamper") and r.payload != TEXT:
        errs.append("payload mismatch")
    return errs


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check-ts", action="store_true")
    args = ap.parse_args()
    ed, pq, rk = keys()
    if args.check_ts:
        with open(os.path.join(HERE, "ts_secure_vectors.json")) as f:
            vecs = json.load(f)
        bad = 0
        for v in vecs:
            case = next(c for c in CASES if c["name"] == v["name"])
            grid = np.asarray(v["grid"], dtype=np.uint8).reshape(v["n"], v["n"], 3)
            errs = check(case, grid, ed, pq, rk)
            bad += bool(errs)
            print(f"{v['name']:<26} {'OK' if not errs else 'FAIL ' + '; '.join(errs)}")
        print(f"Python opened {len(vecs) - bad}/{len(vecs)} TypeScript-sealed symbols")
        sys.exit(1 if bad else 0)

    out = {"text_hex": TEXT.hex(), "password": PASSWORD, "ed_seed": ED_SEED.hex(), "mldsa_seed": MLDSA_SEED.hex(),
           "x25519_priv": X25519_PRIV.hex(), "xwing_seed": XWING_SEED.hex(), "ed_fp": ed.fingerprint.hex(), "pq_fp": pq.fingerprint.hex(),
           "cases": CASES, "vectors": []}
    for case in CASES:
        e = codec.encode_grid(TEXT, mcs=case.get("mcs", 1), level=case.get("level", "Q"), sealed=seal_case(case, ed, pq, rk))
        errs = check(case, e.grid, ed, pq, rk)
        if errs:
            raise SystemExit(f"{case['name']}: Python self-check failed: {errs}")
        out["vectors"].append({"name": case["name"], "n": e.n, "grid": e.grid.reshape(-1).tolist()})
    path = os.path.join(HERE, "secure_vectors.json")
    with open(path, "w") as f:
        json.dump(out, f)
    print(f"wrote {len(out['vectors'])} secure vectors -> {path}")


if __name__ == "__main__":
    main()

