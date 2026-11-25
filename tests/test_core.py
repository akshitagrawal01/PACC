import os
import tempfile
import pytest
from PIL import Image

from pacc import encode, decode, capacity

@pytest.fixture
def tmp_img():
    with tempfile.TemporaryDirectory() as tmp:
        yield os.path.join(tmp, "test.png")

@pytest.mark.parametrize("name, orig", [
    ("empty string",     b""),
    ("single 0x00",      b"\x00"),
    ("single 0xFF",      b"\xFF"),
    ("ASCII text",       b"Hello, world!"),
    ("URL 58 chars",     b"https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
    ("UTF-8 multibyte",  b"Omega alpha beta gamma"),
    ("binary blob",      bytes(range(256))),
])
def test_baseline_round_trip(tmp_img, name, orig):
    img, meta = encode(orig, cell_size=10, level="Q", mcs=1)
    img.save(tmp_img)
    r = decode(Image.open(tmp_img))
    assert r.ok
    assert r.payload == orig

def test_mcs_levels(tmp_img):
    orig = b"Testing MCS levels"
    for mcs in [0, 1, 2]:
        img, meta = encode(orig, mcs=mcs)
        img.save(tmp_img)
        r = decode(Image.open(tmp_img))
        assert r.ok
        assert r.payload == orig

def test_capacity_calc():
    assert capacity(21, 1, 2) > 0
    assert capacity(45, 2, 3) > 0

