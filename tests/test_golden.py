import os
import pytest
from PIL import Image

from pacc import encode, decode

from typing import Any

FIXTURE_DIR = os.path.join(os.path.dirname(__file__), "fixtures")
os.makedirs(FIXTURE_DIR, exist_ok=True)

# Define the golden vectors to generate
GOLDEN_CASES: list[dict[str, Any]] = [
    {
        "name": "single_layer_text",
        "payload": b"Hello, PACC World!",
        "kwargs": {"cell_size": 10}
    },
    {
        "name": "level_h_text",
        "payload": b"High error correction text",
        "kwargs": {"cell_size": 10, "level": "H"}
    }
]

def generate_golden_vectors():
    """Run this function manually to regenerate golden vectors if the format changes intentionally."""
    for case in GOLDEN_CASES:
        img_path = os.path.join(FIXTURE_DIR, f"{case['name']}.png")
        txt_path = os.path.join(FIXTURE_DIR, f"{case['name']}.txt")
        img, _ = encode(case["payload"], **case["kwargs"])
        img.save(img_path)
        with open(txt_path, "wb") as f:
            f.write(case["payload"])

@pytest.mark.parametrize("case", GOLDEN_CASES)
def test_golden_vectors(case):
    img_path = os.path.join(FIXTURE_DIR, f"{case['name']}.png")
    txt_path = os.path.join(FIXTURE_DIR, f"{case['name']}.txt")
    
    if not os.path.exists(img_path):
        pytest.skip(f"Golden vector {img_path} not found. Run generate_golden_vectors() to create them.")
        
    with open(txt_path, "rb") as f:
        expected_payload = f.read()
        
    r = decode(Image.open(img_path))
    assert r.ok
    assert r.payload == expected_payload
