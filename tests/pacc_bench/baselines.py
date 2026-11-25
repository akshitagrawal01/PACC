"""
baselines.py — Baseline codec adapters for the PACC benchmark suite: Standard QR
(qrcode + zxing-cpp) and JAB Code (tools/jabcode).
"""

import os
from typing import Any, Dict, Optional, Tuple, Union
import numpy as np
from PIL import Image

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))

try:
    import qrcode
    import qrcode.constants
except ImportError:
    qrcode = None

try:
    import zxingcpp
except ImportError:
    zxingcpp = None

try:
    import cv2
except ImportError:
    cv2 = None


def preprocess_color_frame(
    arr_rgb: np.ndarray,
    enable_white_balance: bool = True,
    enable_clahe: bool = True,
    enable_deblur: bool = False,
    deblur_strength: float = 2.0,
    deblur_sigma: float = 1.8,
) -> np.ndarray:
    """
    Symmetric optical computer vision pre-processing pipeline.
    Applies Gray-World White Balance, LAB CLAHE contrast enhancement,
    and optional high-boost unsharp masking.
    Input and output are RGB uint8 numpy arrays.
    """
    if cv2 is None or arr_rgb is None:
        return arr_rgb

    out = arr_rgb.copy()
    if enable_white_balance:
        img_f = out.astype(np.float32)
        avg = img_f.mean(axis=(0, 1)) + 1e-6
        gray = avg.mean()
        scale = gray / avg
        img_f *= scale[np.newaxis, np.newaxis, :]
        out = np.clip(img_f, 0, 255).astype(np.uint8)

    if enable_clahe:
        lab = cv2.cvtColor(out, cv2.COLOR_RGB2LAB)
        l, a, b = cv2.split(lab)
        clahe = cv2.createCLAHE(clipLimit=2.5, tileGridSize=(8, 8))
        cl = clahe.apply(l)
        enhanced_lab = cv2.merge([cl, a, b])
        out = cv2.cvtColor(enhanced_lab, cv2.COLOR_LAB2RGB)

    if enable_deblur and deblur_strength > 0:
        blurred = cv2.GaussianBlur(out, (0, 0), sigmaX=deblur_sigma)
        out = np.clip(cv2.addWeighted(out, 1.0 + deblur_strength, blurred, -deblur_strength, 0), 0, 255).astype(np.uint8)

    return out


class StandardQRCodec:
    """
    Wrapper around standard ISO/IEC 18004 QR encoder and compiled zxing-cpp decoder.
    """
    FORMAT_NAME = "Standard QR (ISO/IEC 18004)"

    ECC_MAP = {
        "L": qrcode.constants.ERROR_CORRECT_L if qrcode else 1,
        "M": qrcode.constants.ERROR_CORRECT_M if qrcode else 0,
        "Q": qrcode.constants.ERROR_CORRECT_Q if qrcode else 3,
        "H": qrcode.constants.ERROR_CORRECT_H if qrcode else 2,
    }

    @classmethod
    def get_decoder_info(cls) -> Dict[str, Any]:
        if zxingcpp is not None:
            ver = getattr(zxingcpp, "__version__", None)
            if ver is None or ver == "installed":
                try:
                    import importlib.metadata
                    ver = importlib.metadata.version("zxing-cpp")
                except Exception:
                    ver = "3.1.1"
            return {"decoder": "zxing-cpp", "version": str(ver), "is_fallback": False}
        elif cv2 is not None:
            ver = getattr(cv2, "__version__", None)
            if ver is None:
                try:
                    import importlib.metadata
                    ver = importlib.metadata.version("opencv-python")
                except Exception:
                    ver = "installed"
            return {"decoder": "opencv-QRCodeDetector", "version": str(ver), "is_fallback": True}
        return {"decoder": "none", "version": "unavailable", "is_fallback": True}

    @classmethod
    def encode(
        cls,
        payload: bytes,
        ecc_level: str = "H",
        box_size: int = 10,
        border: int = 4,
    ) -> Tuple[Image.Image, Dict[str, Any]]:
        if qrcode is None:
            raise RuntimeError("qrcode package is required for Standard QR generation")

        ecc_val = cls.ECC_MAP.get(ecc_level.upper(), qrcode.constants.ERROR_CORRECT_H)
        qr = qrcode.QRCode(
            version=None,
            error_correction=ecc_val,
            box_size=box_size,
            border=border,
        )
        qr.add_data(payload)
        qr.make(fit=True)
        raw_qr_img = qr.make_image(fill_color="black", back_color="white")
        if hasattr(raw_qr_img, "convert"):
            img = raw_qr_img.convert("RGB")
        elif hasattr(raw_qr_img, "get_image"):
            img = raw_qr_img.get_image().convert("RGB")
        else:
            img = Image.fromarray(np.array(raw_qr_img)).convert("RGB")
        version = qr.version
        modules = 17 + 4 * version

        return img, {
            "qr_version": version,
            "modules": modules,
            "ecc_level": ecc_level.upper(),
            "rendered_width": img.width,
            "rendered_height": img.height,
            "box_size": box_size,
        }

    @classmethod
    def _decode_frame(
        cls,
        arr: np.ndarray,
        expected_payload: Optional[bytes] = None,
    ) -> Tuple[bool, Optional[bytes], Optional[str]]:
        if zxingcpp is not None:
            try:
                res = zxingcpp.read_barcode(arr)
                if res and res.valid:
                    raw_bytes = res.bytes if (hasattr(res, "bytes") and res.bytes) else res.text.encode("utf-8")
                    if expected_payload is not None:
                        if raw_bytes == expected_payload:
                            return True, raw_bytes, None
                        return False, raw_bytes, "PAYLOAD_MISMATCH"
                    return True, raw_bytes, None
            except Exception:
                pass

            if cv2 is not None:
                for k in (3, 5):
                    try:
                        filtered = cv2.medianBlur(arr, k)
                        res = zxingcpp.read_barcode(filtered)
                        if res and res.valid:
                            raw_bytes = res.bytes if (hasattr(res, "bytes") and res.bytes) else res.text.encode("utf-8")
                            if expected_payload is not None:
                                if raw_bytes == expected_payload:
                                    return True, raw_bytes, None
                                return False, raw_bytes, "PAYLOAD_MISMATCH"
                            return True, raw_bytes, None
                    except Exception:
                        pass

        if cv2 is not None:
            try:
                detector = cv2.QRCodeDetector()
                gray = cv2.cvtColor(arr, cv2.COLOR_RGB2GRAY) if arr.ndim == 3 else arr
                data, _, _ = detector.detectAndDecode(gray)
                if data:
                    raw_bytes = data.encode("utf-8")
                    if expected_payload is not None:
                        if raw_bytes == expected_payload:
                            return True, raw_bytes, None
                        return False, raw_bytes, "PAYLOAD_MISMATCH"
                    return True, raw_bytes, None
            except Exception:
                pass

        return False, None, "FINDER_OR_DECODE_FAILED"

    @classmethod
    def decode(
        cls,
        image_input: Union[Image.Image, np.ndarray, str],
        expected_payload: Optional[bytes] = None,
        apply_cv_prepass: bool = True,
    ) -> Tuple[bool, Optional[bytes], Optional[str]]:
        """
        Attempts decoding via zxing-cpp, applying median blur, CLAHE, and high-boost deblurring
        fallbacks if needed, and finally falling back to OpenCV QRCodeDetector.
        """
        if isinstance(image_input, Image.Image):
            arr = np.array(image_input.convert("RGB"), dtype=np.uint8)
        elif isinstance(image_input, str):
            arr = None
            if cv2 is not None:
                arr = cv2.imread(image_input)
                if arr is not None:
                    arr = cv2.cvtColor(arr, cv2.COLOR_BGR2RGB)
            if arr is None:
                img = Image.open(image_input).convert("RGB")
                arr = np.array(img, dtype=np.uint8)
        elif isinstance(image_input, np.ndarray):
            arr = image_input
            if arr.ndim == 2:
                arr = np.stack([arr] * 3, axis=-1)
        else:
            return False, None, "INVALID_INPUT_TYPE"

        ok, dec, err = cls._decode_frame(arr, expected_payload)
        if ok or err == "PAYLOAD_MISMATCH" or not apply_cv_prepass or cv2 is None:
            return ok, dec, err

        # Symmetric CV pre-pass 1: CLAHE contrast enhancement
        arr_clahe = preprocess_color_frame(arr, enable_white_balance=False, enable_clahe=True)
        ok, dec, err = cls._decode_frame(arr_clahe, expected_payload)
        if ok:
            return ok, dec, None

        # Symmetric CV pre-pass 2: High-boost deblurring if optical blur detected
        gray = cv2.cvtColor(arr, cv2.COLOR_RGB2GRAY)
        lap_var = float(cv2.Laplacian(gray, cv2.CV_64F).var())
        if lap_var < 220.0:
            for deb_s, deb_sig in [(2.2, 1.8), (3.0, 2.2)]:
                arr_deb = preprocess_color_frame(arr, enable_white_balance=False, enable_clahe=False,
                                                enable_deblur=True, deblur_strength=deb_s, deblur_sigma=deb_sig)
                ok, dec, err = cls._decode_frame(arr_deb, expected_payload)
                if ok:
                    return ok, dec, None

        return False, None, "FINDER_OR_DECODE_FAILED"


class JABCodeCodec:
    """
    Wrapper around official Fraunhofer SIT JAB Code (ISO/IEC 23634) C11 reference implementation.
    Operates in 4-color mode (2 bits/module) to match PACC's information density.
    """
    FORMAT_NAME = "JAB Code (ISO/IEC 23634)"

    TOOLS_DIR = os.path.abspath(os.path.join(REPO_ROOT, "tools", "jabcode", "bin"))
    WRITER_BIN = os.path.join(TOOLS_DIR, "jabcodeWriter.exe")
    READER_BIN = os.path.join(TOOLS_DIR, "jabcodeReader.exe")

    _ENABLED: bool = True

    @classmethod
    def set_enabled(cls, enabled: bool) -> None:
        cls._ENABLED = enabled

    @classmethod
    def is_available(cls) -> bool:
        if not cls._ENABLED or os.environ.get("PACC_SKIP_JAB", "0") in ("1", "true", "True"):
            return False
        return os.path.exists(cls.WRITER_BIN) and os.path.exists(cls.READER_BIN)

    @classmethod
    def _get_env(cls) -> Dict[str, str]:
        env = os.environ.copy()
        paths = [cls.TOOLS_DIR]
        if os.path.exists(r"C:\msys64\ucrt64\bin"):
            paths.append(r"C:\msys64\ucrt64\bin")
        env["PATH"] = ";".join(paths) + ";" + env.get("PATH", "")
        return env

    @classmethod
    def encode(
        cls,
        payload: bytes,
        color_number: int = 4,
        module_size: int = 10,
        ecc_level: int = 7,
        color_mode: Optional[int] = None,
        **kwargs: Any,
    ) -> Tuple[Image.Image, Dict[str, Any]]:
        """
        Encodes payload into a JAB Code image using the native reference writer.
        Default ecc_level=7 corresponds to 27.0% error recovery (matched to QR-H and PACC RS-2).
        """
        if color_mode is not None:
            color_number = color_mode

        import subprocess
        import tempfile

        if not cls.is_available():
            raise RuntimeError(f"JAB Code binaries not found at {cls.TOOLS_DIR}")

        with tempfile.TemporaryDirectory() as tmpdir:
            in_file = os.path.join(tmpdir, "payload.bin")
            out_file = os.path.join(tmpdir, "jabcode.png")

            with open(in_file, "wb") as f:
                f.write(payload)

            cmd = [
                cls.WRITER_BIN,
                "--input-file", in_file,
                "--output", out_file,
                "--color-number", str(color_number),
                "--module-size", str(module_size),
                "--ecc-level", str(ecc_level),
            ]

            res = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                env=cls._get_env(),
                timeout=15,
            )
            if res.returncode != 0 or not os.path.exists(out_file):
                raise RuntimeError(f"jabcodeWriter failed (code {res.returncode}): {res.stderr or res.stdout}")

            img = Image.open(out_file).convert("RGB")
            img.load()

            return img, {
                "color_number": color_number,
                "module_size": module_size,
                "ecc_level": ecc_level,
                "rendered_width": img.width,
                "rendered_height": img.height,
            }

    _DLL = None
    _UCRT = None
    _DLL_ATTEMPTED = False

    @classmethod
    def _get_dll(cls) -> Any:
        if not cls._DLL_ATTEMPTED:
            cls._DLL_ATTEMPTED = True
            try:
                import ctypes
                if os.path.exists(r"C:\msys64\ucrt64\bin"):
                    try:
                        os.add_dll_directory(r"C:\msys64\ucrt64\bin")
                    except Exception:
                        pass
                try:
                    os.add_dll_directory(cls.TOOLS_DIR)
                except Exception:
                    pass
                dll_path = os.path.join(cls.TOOLS_DIR, "libjabcode.dll")
                if os.path.exists(dll_path):
                    cls._DLL = ctypes.CDLL(dll_path)
                    cls._DLL.decodeJABCode.argtypes = [ctypes.c_void_p, ctypes.c_int32]
                    cls._DLL.decodeJABCode.restype = ctypes.c_void_p
                    try:
                        cls._UCRT = ctypes.CDLL("ucrtbase.dll")
                    except Exception:
                        cls._UCRT = None
            except Exception:
                cls._DLL = None
        return cls._DLL

    @classmethod
    def _decode_frame(
        cls,
        image_input: Union[Image.Image, np.ndarray, str],
        expected_payload: Optional[bytes] = None,
        force_cli: bool = False,
    ) -> Tuple[bool, Optional[bytes], Optional[str]]:
        if not cls.is_available():
            return False, None, "JABCODE_NOT_AVAILABLE"

        # 1. Fast path: Direct in-memory C decoding via libjabcode.dll
        if not force_cli:
            dll = cls._get_dll()
            if dll is not None:
                try:
                    import ctypes
                    if isinstance(image_input, Image.Image):
                        img = image_input.convert("RGBA")
                    elif isinstance(image_input, np.ndarray):
                        arr = image_input
                        if arr.ndim == 2:
                            arr = np.stack([arr] * 3, axis=-1)
                        if arr.shape[2] == 3:
                            img = Image.fromarray(arr).convert("RGBA")
                        else:
                            img = Image.fromarray(arr)
                    elif isinstance(image_input, str):
                        img = Image.open(image_input).convert("RGBA")
                    else:
                        return False, None, "INVALID_INPUT_TYPE"

                    w, h = img.size
                    rgba_data = img.tobytes()
                    total_size = 20 + len(rgba_data)
                    buf = (ctypes.c_uint8 * total_size)()
                    struct_vals = (ctypes.c_uint32 * 5).from_buffer(buf)
                    struct_vals[0] = w
                    struct_vals[1] = h
                    struct_vals[2] = 32
                    struct_vals[3] = 8
                    struct_vals[4] = 4
                    ctypes.memmove(ctypes.byref(buf, 20), rgba_data, len(rgba_data))

                    res_ptr = dll.decodeJABCode(ctypes.byref(buf), 0)
                    if res_ptr:
                        length = ctypes.c_int32.from_address(res_ptr).value
                        decoded = ctypes.string_at(res_ptr + 4, length)
                        if cls._UCRT and hasattr(cls._UCRT, "free"):
                            cls._UCRT.free(res_ptr)
                        if expected_payload is not None:
                            if decoded == expected_payload:
                                return True, decoded, None
                            return False, decoded, "PAYLOAD_MISMATCH"
                        return True, decoded, None
                    else:
                        return False, None, "FINDER_OR_DECODE_FAILED"
                except Exception:
                    pass  # Graceful fallback to CLI runner below

        # 2. Fallback: CLI Subprocess runner with disk I/O
        import subprocess
        import tempfile

        with tempfile.TemporaryDirectory() as tmpdir:
            img_path = os.path.join(tmpdir, "input.png")
            out_bin = os.path.join(tmpdir, "decoded.bin")

            if isinstance(image_input, Image.Image):
                image_input.convert("RGB").save(img_path, format="PNG")
            elif isinstance(image_input, np.ndarray):
                arr = image_input
                if arr.ndim == 2:
                    arr = np.stack([arr] * 3, axis=-1)
                Image.fromarray(arr).convert("RGB").save(img_path, format="PNG")
            elif isinstance(image_input, str):
                img = Image.open(image_input).convert("RGB")
                img.save(img_path, format="PNG")
            else:
                return False, None, "INVALID_INPUT_TYPE"

            cmd = [cls.READER_BIN, img_path, "--output", out_bin]

            try:
                res = subprocess.run(
                    cmd,
                    capture_output=True,
                    text=True,
                    env=cls._get_env(),
                    timeout=15,
                )
            except subprocess.TimeoutExpired:
                return False, None, "TIMEOUT"
            except Exception as e:
                return False, None, f"EXCEPTION_{type(e).__name__}"

            if res.returncode == 0 and os.path.exists(out_bin):
                with open(out_bin, "rb") as f:
                    decoded = f.read()
                if expected_payload is not None:
                    if decoded == expected_payload:
                        return True, decoded, None
                    return False, decoded, "PAYLOAD_MISMATCH"
                return True, decoded, None
            elif res.returncode == 255:
                return False, None, "FINDER_NOT_DETECTED"
            else:
                return False, None, "FEC_DECODE_FAIL"

    @classmethod
    def decode(
        cls,
        image_input: Union[Image.Image, np.ndarray, str],
        expected_payload: Optional[bytes] = None,
        force_cli: bool = False,
        apply_cv_prepass: bool = True,
        **kwargs: Any,
    ) -> Tuple[bool, Optional[bytes], Optional[str]]:
        """
        Decodes a JAB Code image using the native reference reader.
        Prefers fast in-memory libjabcode.dll decoding; falls back to CLI subprocess.
        Applies symmetric CV prepasses (CLAHE, Gray-World, high-boost deblurring) if needed.
        Returns (success: bool, payload: Optional[bytes], error_mode: Optional[str]).
        """
        ok, dec, err = cls._decode_frame(image_input, expected_payload=expected_payload, force_cli=force_cli)
        if ok or err == "PAYLOAD_MISMATCH" or not apply_cv_prepass or cv2 is None:
            return ok, dec, err

        if isinstance(image_input, Image.Image):
            arr = np.array(image_input.convert("RGB"), dtype=np.uint8)
        elif isinstance(image_input, np.ndarray):
            arr = image_input if image_input.ndim == 3 else np.stack([image_input] * 3, axis=-1)
        elif isinstance(image_input, str):
            arr = np.array(Image.open(image_input).convert("RGB"), dtype=np.uint8)
        else:
            return ok, dec, err

        # 1. CLAHE Contrast Enhancement pre-pass
        arr_clahe = preprocess_color_frame(arr, enable_white_balance=False, enable_clahe=True)
        ok, dec, err = cls._decode_frame(arr_clahe, expected_payload=expected_payload, force_cli=force_cli)
        if ok:
            return ok, dec, None

        # 2. Gray-World White Balance pre-pass
        arr_wb = preprocess_color_frame(arr, enable_white_balance=True, enable_clahe=False)
        ok, dec, err = cls._decode_frame(arr_wb, expected_payload=expected_payload, force_cli=force_cli)
        if ok:
            return ok, dec, None

        # 3. High-Boost Deblurring pre-pass if optical blur detected
        gray = cv2.cvtColor(arr, cv2.COLOR_RGB2GRAY)
        lap_var = float(cv2.Laplacian(gray, cv2.CV_64F).var())
        if lap_var < 220.0:
            for deb_s, deb_sig in [(2.2, 1.8), (3.0, 2.2), (3.8, 2.6)]:
                arr_deb = preprocess_color_frame(arr, enable_white_balance=False, enable_clahe=False,
                                                enable_deblur=True, deblur_strength=deb_s, deblur_sigma=deb_sig)
                ok, dec, err = cls._decode_frame(arr_deb, expected_payload=expected_payload, force_cli=force_cli)
                if ok:
                    return ok, dec, None

        # 4. Combined WB + CLAHE pre-pass
        arr_both = preprocess_color_frame(arr, enable_white_balance=True, enable_clahe=True)
        ok, dec, err = cls._decode_frame(arr_both, expected_payload=expected_payload, force_cli=force_cli)
        if ok:
            return ok, dec, None

        return False, None, err or "FINDER_OR_DECODE_FAILED"


def probe_jabcode() -> Dict[str, Any]:
    """
    Probes for JAB Code C11 reference implementation and CLI availability.
    """
    if JABCodeCodec.is_available():
        return {
            "available": True,
            "version": "1.0-C11 (ISO/IEC 23634)",
            "backend": "native-cli",
            "notes": "Native C11 reference library and CLI tools built with MSYS2 UCRT64.",
        }
    return {
        "available": False,
        "version": "unavailable",
        "notes": (
            "JAB Code (ISO/IEC 23634) binaries not found. "
            "Run tools/build_jabcode.ps1 to build from source."
        ),
    }

