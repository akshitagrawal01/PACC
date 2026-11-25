import sys
import os
import json
import base64
import io
import time
import functools
from PIL import Image
import numpy as np

script_dir = os.path.dirname(os.path.abspath(__file__))
root_dir = os.path.abspath(os.path.join(script_dir, "..", ".."))
tests_dir = os.path.abspath(os.path.join(root_dir, "tests"))

for d in (tests_dir, root_dir):
    if d not in sys.path:
        sys.path.insert(0, d)

try:
    import cv2
    CV2_AVAILABLE = True
except ImportError:
    cv2 = None
    CV2_AVAILABLE = False

try:
    import qrcode
    from qrcode.constants import ERROR_CORRECT_L, ERROR_CORRECT_M, ERROR_CORRECT_Q, ERROR_CORRECT_H
    QR_AVAILABLE = True
except ImportError:
    QR_AVAILABLE = False

try:
    import zxingcpp
    ZXINGCPP_AVAILABLE = True
except ImportError:
    zxingcpp = None
    ZXINGCPP_AVAILABLE = False


def get_qr_ecc(ecc_level: int):
    if not QR_AVAILABLE:
        return None, "N/A", "0%"
    if ecc_level == 0:
        return ERROR_CORRECT_L, "Level L", "~7%"
    elif ecc_level == 1:
        return ERROR_CORRECT_M, "Level M", "~15%"
    elif ecc_level == 2:
        return ERROR_CORRECT_Q, "Level Q", "~25%"
    elif ecc_level >= 3:
        return ERROR_CORRECT_H, "Level H", "~30%"
    else:
        return ERROR_CORRECT_M, "Level M", "~15%"

def generate_standard_qr(text: str, cell_size: int = 10, ecc_level: int = 1):
    if not QR_AVAILABLE:
        return {"stdError": "qrcode library not available"}
    
    qr_ecc, ecc_label, ecc_rec = get_qr_ecc(ecc_level)
    try:
        qr = qrcode.QRCode(
            version=None,
            error_correction=qr_ecc,
            box_size=cell_size,
            border=4,
        )
        qr.add_data(text)
        qr.make(fit=True)
        img = qr.make_image(fill_color="black", back_color="white")

        buf = io.BytesIO()
        img.save(buf)
        b64 = base64.b64encode(buf.getvalue()).decode("utf-8")
        width = getattr(img, 'pixel_size', getattr(img, 'size', (0, 0))[0])

        version = qr.version or 1
        matrix_size = 21 + 4 * (version - 1)
        modules_count = matrix_size * matrix_size

        return {
            "stdDataUrl": f"data:image/png;base64,{b64}",
            "stdSize": width,
            "stdVersion": version,
            "stdMatrix": matrix_size,
            "stdEccLevel": ecc_label,
            "stdEccRecovery": ecc_rec,
            "stdModulesCount": modules_count,
            "stdPayloadBytes": len(text.encode("utf-8")),
            "stdMode": "8-Bit Byte (Standard QR)",
            "stdBitsPerCell": "1.0 bit/cell (Binary)",
            "stdError": None
        }
    except Exception as e:
        return {
            "stdDataUrl": None,
            "stdError": f"Payload exceeds Standard QR limit: {e}",
            "stdSize": None,
            "stdVersion": None,
            "stdMatrix": None,
            "stdEccLevel": ecc_label,
            "stdEccRecovery": ecc_rec,
            "stdModulesCount": 0,
            "stdPayloadBytes": len(text.encode("utf-8")),
            "stdMode": "Capacity Overflow",
            "stdBitsPerCell": "1.0 bit/cell"
        }


def get_jab_ecc(ecc_level: int):
    if ecc_level == 0:
        return 1, "Level 1", "~4%"
    elif ecc_level == 1:
        return 4, "Level 4", "~15%"
    elif ecc_level == 2:
        return 7, "Level 7", "~27%"
    elif ecc_level >= 3:
        return 9, "Level 9", "~35%"
    else:
        return 7, "Level 7", "~27%"


def generate_jab_code(text: str, cell_size: int = 10, ecc_level: int = 2):
    tools_dir = os.path.join(root_dir, "tools", "jabcode", "bin")
    writer_bin = os.path.join(tools_dir, "jabcodeWriter.exe")
    jab_ecc, ecc_label, ecc_rec = get_jab_ecc(ecc_level)
    payload = text.encode("utf-8")

    if not os.path.exists(writer_bin):
        return {
            "jabDataUrl": None,
            "jabError": "JAB Code native writer binary not found",
            "jabSize": None,
            "jabMatrix": None,
            "jabEccLevel": ecc_label,
            "jabEccRecovery": ecc_rec,
            "jabModulesCount": 0,
            "jabPayloadBytes": len(payload),
            "jabColors": 4,
            "jabBitsPerCell": "2.0 bits/cell (4-Color Quaternary)"
        }

    import subprocess
    import tempfile

    env = os.environ.copy()
    paths = [tools_dir]
    if os.path.exists(r"C:\msys64\ucrt64\bin"):
        paths.append(r"C:\msys64\ucrt64\bin")
    env["PATH"] = ";".join(paths) + ";" + env.get("PATH", "")

    try:
        with tempfile.TemporaryDirectory() as tmpdir:
            in_file = os.path.join(tmpdir, "payload.bin")
            out_file = os.path.join(tmpdir, "jabcode.png")

            with open(in_file, "wb") as f:
                f.write(payload)

            cmd = [
                writer_bin,
                "--input-file", in_file,
                "--output", out_file,
                "--color-number", "4",
                "--module-size", str(cell_size),
                "--ecc-level", str(jab_ecc),
            ]

            res = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                env=env,
                timeout=10,
            )
            if res.returncode != 0 or not os.path.exists(out_file):
                return {
                    "jabDataUrl": None,
                    "jabError": f"JAB Code encoding failed (code {res.returncode}): {res.stderr or res.stdout}",
                    "jabSize": None,
                    "jabMatrix": None,
                    "jabEccLevel": ecc_label,
                    "jabEccRecovery": ecc_rec,
                    "jabModulesCount": 0,
                    "jabPayloadBytes": len(payload),
                    "jabColors": 4,
                    "jabBitsPerCell": "2.0 bits/cell"
                }

            with open(out_file, "rb") as f:
                img_bytes = f.read()

        img = Image.open(io.BytesIO(img_bytes))
        w, h = img.size
        matrix_size = round(w / cell_size) if cell_size > 0 else 0
        b64 = base64.b64encode(img_bytes).decode("utf-8")

        return {
            "jabDataUrl": f"data:image/png;base64,{b64}",
            "jabSize": w,
            "jabMatrix": matrix_size,
            "jabEccLevel": ecc_label,
            "jabEccRecovery": ecc_rec,
            "jabModulesCount": matrix_size * matrix_size,
            "jabPayloadBytes": len(payload),
            "jabColors": 4,
            "jabBitsPerCell": "2.0 bits/cell (4-Color Quaternary)",
            "jabError": None
        }
    except Exception as e:
        return {
            "jabDataUrl": None,
            "jabError": f"JAB Code generation error: {e}",
            "jabSize": None,
            "jabMatrix": None,
            "jabEccLevel": ecc_label,
            "jabEccRecovery": ecc_rec,
            "jabModulesCount": 0,
            "jabPayloadBytes": len(payload),
            "jabColors": 4,
            "jabBitsPerCell": "2.0 bits/cell"
        }


def arr_to_base64_thumb(arr: np.ndarray, max_dim: int = 140) -> str:
    """Convert RGB numpy array to compact base64 PNG thumbnail."""
    if not CV2_AVAILABLE or cv2 is None:
        return ""
    try:
        assert cv2 is not None
        h, w = arr.shape[:2]
        scale = min(max_dim / h, max_dim / w, 1.0)
        new_w, new_h = max(1, int(w * scale)), max(1, int(h * scale))
        resized = cv2.resize(arr, (new_w, new_h), interpolation=cv2.INTER_AREA)
        _, buf = cv2.imencode(".png", cv2.cvtColor(resized, cv2.COLOR_RGB2BGR))
        return "data:image/png;base64," + base64.b64encode(buf).decode("utf-8")
    except Exception:
        return ""

def test_qr_decode(arr: np.ndarray, expected_text: str) -> bool:
    """Attempt decoding a QR image using zxingcpp with median blur and OpenCV QRCodeDetector fallback."""
    if ZXINGCPP_AVAILABLE and zxingcpp is not None:
        try:
            zres = zxingcpp.read_barcode(arr)
            if zres and zres.text == expected_text:
                return True
        except Exception:
            pass
    if CV2_AVAILABLE and cv2 is not None:
        for k in (3, 5):
            try:
                filtered = cv2.medianBlur(arr, k)
                if ZXINGCPP_AVAILABLE and zxingcpp is not None:
                    zres = zxingcpp.read_barcode(filtered)
                    if zres and zres.text == expected_text:
                        return True
            except Exception:
                pass
        try:
            det = cv2.QRCodeDetector()
            val, pts, _ = det.detectAndDecode(arr)
            if val == expected_text:
                return True
        except Exception:
            pass
    return False

def handle_encode(req: dict) -> dict:
    """Encode text as a PACC symbol. ecc_level 0-3 selects robustness L/M/Q/H (default Q)."""
    text = req.get("text", "")
    cell_size = int(req.get("cell_size", 10))
    try:
        ecc_level = int(req.get("ecc_level", -1))
    except (TypeError, ValueError):
        ecc_level = -1
    level = "LMQH"[ecc_level] if 0 <= ecc_level <= 3 else "Q"
    mcs = int(req.get("mcs", 1))
    if req.get("password"):
        return {"success": False,
                "error": "Passphrase encryption is not available in the server encoder; use the browser generator."}

    data_bytes = text.encode("utf-8")
    t0 = time.perf_counter()
    try:
        import pacc as pacc2
        img, meta = pacc2.encode(data_bytes, level=level, mcs=mcs, cell_size=cell_size, compress=False)
    except ValueError as e:
        return {"success": False, "error": str(e)}
    except Exception as e:
        return {"success": False, "error": f"Encoding failed: {e}"}
    duration_ms = round((time.perf_counter() - t0) * 1000, 1)

    buf = io.BytesIO()
    img.save(buf, format="PNG")
    data_url = "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("utf-8")
    return {
        "success": True,
        "engine": "PACC (server)",
        "dataUrl": data_url,
        "data_url": data_url,
        "gridSide": meta.n,
        "payloadBytes": len(data_bytes),
        "rawBytes": len(data_bytes),
        "imageSize": img.size[0],
        "compressed": False,
        "encrypted": False,
        "eccLevel": level,
        "durationMs": duration_ms,
        "qrComparison": generate_standard_qr(text, cell_size, ecc_level),
        "jabComparison": generate_jab_code(text, cell_size, ecc_level),
    }



def _try_pacc2(img: Image.Image, thorough: bool, password: str | None = None) -> dict | None:
    """Decode a PACC symbol; None if the image is not (recognisably) PACC."""
    t0 = time.perf_counter()
    try:
        import pacc as pacc2
        from pacc.spec import FLAG_STREAM
        v2 = pacc2.decode(img, thorough=thorough, secrets=pacc2.Secrets(password=password))
    except Exception:
        return None
    if not v2.ok:
        return None
    sec = v2.security
    security = {
        "signed": sec.signed if sec else None,
        "signer": sec.signer if sec else None,
        "signatureValid": sec.signature_valid if sec else None,
        "trusted": sec.trusted if sec else None,
        "encrypted": sec.encrypted if sec else None,
        "recipientKid": sec.recipient_kid if sec else None,
        "locked": v2.locked,
    }
    fine = getattr(v2, "fine", None)
    if fine is not None:
        fine_text = None
        if fine.ok and fine.payload is not None:
            fine_text = fine.payload.decode("utf-8", errors="replace")
        security["fine"] = {"ok": fine.ok, "text": fine_text, "error": None if fine.ok else fine.error,
                            "locked": fine.locked, "encrypted": fine.security.encrypted if fine.security else None}
    base = {"durationMs": round((time.perf_counter() - t0) * 1000, 1), "engine": "PACC (server)",
            "codeType": "PACC", "pacc2": security}
    if v2.locked:
        return {**base, "success": False, "requiresPassword": v2.locked == "password", "encrypted": True,
                "error": "Password-protected PACC symbol" if v2.locked == "password"
                else "PACC symbol encrypted for a recipient key"}
    if v2.flags & FLAG_STREAM:
        return {**base, "success": False,
                "error": "This is one frame of an animated PACC Stream; scan it live with the camera."}
    if v2.payload is None:
        return None
    try:
        v2_text, v2_binary = v2.payload.decode("utf-8"), False
    except UnicodeDecodeError:
        v2_text, v2_binary = "", True
    return {
        **base,
        "success": True,
        "text": v2_text,
        "totalText": v2_text,
        "bytesLen": len(v2.payload),
        "totalBytesLen": len(v2.payload),
        "isBinary": v2_binary,
        "encrypted": bool(sec and sec.encrypted),
        "payloadBase64": base64.b64encode(v2.payload).decode("utf-8"),
        "metadata": {"gridSide": f"{v2.n}x{v2.n}", "passUsed": "PACC"},
    }


def handle_decode(req: dict) -> dict:
    image_b64 = req.get("image_base64") or req.get("image_b64") or req.get("image") or ""
    password = req.get("password") or None

    if "," in image_b64:
        image_b64 = image_b64.split(",", 1)[1]

    if not image_b64:
        return {"success": False, "error": "No image payload provided"}

    try:
        raw_img_bytes = base64.b64decode(image_b64)
        img = Image.open(io.BytesIO(raw_img_bytes)).convert("RGB")
    except Exception as e:
        return {"success": False, "error": f"Invalid image format: {e}"}

    # The quick pass's format-word gate rejects non-PACC images fast; the thorough
    # pass adds finder-free localisation for symbols with damaged finders.
    result = _try_pacc2(img, thorough=False, password=password) or _try_pacc2(img, thorough=True, password=password)
    return result or {"success": False, "error": "No PACC symbol detected in image"}
_ALLOW_LOCAL_PATHS = os.environ.get("PACC_ALLOW_LOCAL_PATHS") == "1"


def _local_path(req: dict, key: str) -> str | None:
    value = req.get(key)
    if not value:
        return None
    if not _ALLOW_LOCAL_PATHS:
        raise ValueError(
            f"'{key}' is disabled; send image data instead "
            f"(set PACC_ALLOW_LOCAL_PATHS=1 for local use)"
        )
    return str(value)


def handle_test_room_decode(req: dict) -> dict:
    """Universal optical frame decoder for Test Room benchmark (PACC, JAB, QR)."""
    image_base64 = req.get("image_base64")
    image_path = _local_path(req, "image_path")
    expected_type = (req.get("expected_type") or "AUTO").upper().strip()
    expected_payload = req.get("expected_payload")
    password = req.get("password") or None

    img = None
    if image_path and os.path.exists(image_path):
        img = Image.open(image_path)
    elif image_base64:
        header_rem = image_base64.split(",")[-1]
        img_bytes = base64.b64decode(header_rem)
        img = Image.open(io.BytesIO(img_bytes))
    else:
        return {"success": False, "error": "No image payload provided"}

    t0 = time.perf_counter()
    decoded_text = None
    engine_used = None
    error_msg = None

    def try_qr(pil_img):
        if not CV2_AVAILABLE or cv2 is None:
            return None
        np_img = np.array(pil_img.convert("RGB"))
        detector = cv2.QRCodeDetector()
        val, pts, straight = detector.detectAndDecode(np_img)
        if val and val.strip():
            return val.strip()
        # Try grayscale with OTSU thresholding if direct detect misses
        try:
            gray = cv2.cvtColor(np_img, cv2.COLOR_RGB2GRAY)
            val, pts, straight = detector.detectAndDecode(gray)
            if val and val.strip():
                return val.strip()
            _, thresh = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY | cv2.THRESH_OTSU)
            val, pts, straight = detector.detectAndDecode(thresh)
            if val and val.strip():
                return val.strip()
        except Exception:
            pass
        return None

    def try_jab(pil_img):
        tools_dir = os.path.join(root_dir, "tools", "jabcode", "bin")
        reader_bin = os.path.join(tools_dir, "jabcodeReader.exe")
        if not os.path.exists(reader_bin):
            return None
        import tempfile
        import subprocess
        env = os.environ.copy()
        paths = [tools_dir]
        if os.path.exists(r"C:\msys64\ucrt64\bin"):
            paths.append(r"C:\msys64\ucrt64\bin")
        env["PATH"] = ";".join(paths) + ";" + env.get("PATH", "")
        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tf:
            temp_path = tf.name
        try:
            pil_img.save(temp_path, format="PNG")
            res = subprocess.run([reader_bin, temp_path], env=env, capture_output=True, text=True, timeout=5)
            if res.returncode == 0 and res.stdout and res.stdout.strip():
                return res.stdout.strip()
        except Exception:
            pass
        finally:
            if os.path.exists(temp_path):
                try:
                    os.remove(temp_path)
                except Exception:
                    pass
        return None

    def try_pacc(pil_img):
        res = _try_pacc2(pil_img, thorough=True, password=password)
        if not res or not res.get("success"):
            return None
        return res.get("text") or None

    orig_stdout = sys.stdout
    sys.stdout = io.StringIO()
    try:
        if expected_type == "QR":
            decoded_text = try_qr(img)
            engine_used = "opencv_qr"
            if not decoded_text:
                error_msg = "No QR code detected in frame"
        elif expected_type == "JAB":
            decoded_text = try_jab(img)
            engine_used = "jabcode_reader"
            if not decoded_text:
                error_msg = "No JAB code detected in frame"
        elif expected_type == "PACC":
            decoded_text = try_pacc(img)
            engine_used = "pacc"
            if not decoded_text:
                error_msg = "No PACC pattern detected or ECC recovery failed"
        else:
            # AUTO: try in order of expected speed/fit
            decoded_text = try_pacc(img)
            if decoded_text:
                engine_used = "pacc"
            else:
                decoded_text = try_qr(img)
                if decoded_text:
                    engine_used = "opencv_qr"
                else:
                    decoded_text = try_jab(img)
                    if decoded_text:
                        engine_used = "jabcode_reader"
                    else:
                        error_msg = "No recognizable barcode found in frame"
    finally:
        sys.stdout = orig_stdout

    duration_ms = round((time.perf_counter() - t0) * 1000, 2)

    is_match = False
    if decoded_text is not None:
        if expected_payload:
            is_match = (decoded_text.strip() == str(expected_payload).strip())
        else:
            is_match = True

    return {
        "success": decoded_text is not None,
        "text": decoded_text or "",
        "engine": engine_used or "unknown",
        "durationMs": duration_ms,
        "expectedType": expected_type,
        "match": is_match,
        "error": error_msg if not decoded_text else None
    }

def handle_generate_test_suite(req: dict) -> dict:
    """Generate PACC benchmark suites (scripts/pacc_suites.py)."""
    suite_type = req.get("suite_type", "paper_set").lower()
    try:
        import pacc_suites
        items = pacc_suites.generate(suite_type)
        if items is not None:
            return {"success": True, "suiteType": suite_type, "totalItems": len(items), "items": items}
        return {"success": False, "error": f"Unknown suite type: {suite_type}"}
    except Exception as e:
        return {"success": False, "error": str(e)}




@functools.lru_cache(maxsize=256)



def run_daemon():
    """Persistent stdin/stdout worker daemon for sub-10ms API responses."""
    sys.stdout.write(json.dumps({"status": "READY"}) + "\n")
    sys.stdout.flush()

    for line in sys.stdin:
        line = line.strip().lstrip('\ufeff')
        if not line:
            continue
        req_id = None
        try:
            req = json.loads(line)
            req_id = req.pop("_id", None)
            action = req.get("action", "decode").lower()
            if action == "decode":
                res = handle_decode(req)
            elif action in ("test_room_decode", "room_decode"):
                res = handle_test_room_decode(req)
            elif action == "encode":
                res = handle_encode(req)
            elif action in ("generate_test_suite", "test_suite"):
                res = handle_generate_test_suite(req)
            else:
                res = {"success": False, "error": f"Unknown action: {action}"}
        except Exception as e:
            res = {"success": False, "error": str(e)}

        # Echo the request id so the Node side can match replies to requests even
        # after one of them timed out and left the queue.
        if req_id is not None:
            res = {**res, "_id": req_id}
        sys.stdout.write(json.dumps(res) + "\n")
        sys.stdout.flush()

def main():
    if len(sys.argv) < 2:
        action = "encode"
    else:
        action = sys.argv[1].lower()

    if action == "daemon":
        run_daemon()
        return

    try:
        raw_input = sys.stdin.read().lstrip('\ufeff')
        if not raw_input.strip():
            print(json.dumps({"success": False, "error": "Empty stdin input"}))
            return
        req = json.loads(raw_input)
    except Exception as e:
        print(json.dumps({"success": False, "error": f"Invalid JSON input: {e}"}))
        return

    try:
        if action == "encode":
            result = handle_encode(req)
        elif action == "decode":
            result = handle_decode(req)
        elif action in ("test_room_decode", "room_decode"):
            result = handle_test_room_decode(req)
        elif action in ("generate_test_suite", "test_suite"):
            result = handle_generate_test_suite(req)
        else:
            result = {"success": False, "error": f"Unknown action: {action}"}
    except Exception as e:
        result = {"success": False, "error": str(e)}

    print(json.dumps(result))

if __name__ == "__main__":
    main()
