"""Tests for the KTX2 / Basis Universal (ETC1S) texture decoder.

Each fixture in ``samples/ktx2`` is a picture encoded by Binomial's own
encoder, beside the pixels Binomial's own transcoder gives back for it. A
texture has one right answer, so these are held to it byte for byte:

===========  ==================================================================
bars         flat colour blocks, where every 4x4 block is one colour
gradient     a smooth ramp, which makes the intensity tables work
alpha        a disc cut out of a ramp, so the file carries a second slice for
             the alpha channel
wide         96x32 checks: not square, and not a whole number of blocks either
===========  ==================================================================

The fixtures are regenerated with the ``basis_universal`` encoder from npm; see
the README.
"""

from __future__ import annotations

import ctypes
import struct
import zlib
from pathlib import Path

import pytest

KTX2 = Path(__file__).resolve().parent.parent / "samples" / "ktx2"
CASES = sorted(p.stem for p in KTX2.glob("*.ktx2"))

ERRORS = {
    0: "none", 1: "not a KTX2 file", 2: "truncated", 3: "not ETC1S",
    4: "unsupported supercompression", 5: "out of memory", 6: "corrupt",
    7: "over a limit",
}


class Ktx2Out(ctypes.Structure):
    _fields_ = [("ok", ctypes.c_uint32), ("error", ctypes.c_uint32),
                ("width", ctypes.c_uint32), ("height", ctypes.c_uint32),
                ("has_alpha", ctypes.c_uint32), ("levels", ctypes.c_uint32),
                ("rgba", ctypes.c_uint32)]


def read_png(path: Path) -> tuple[int, int, bytes]:
    """Read one of our own 8-bit RGBA PNGs — enough for the fixtures."""
    data = path.read_bytes()
    assert data[:8] == b"\x89PNG\r\n\x1a\n", f"{path} is not a PNG"
    at = 8
    width = height = 0
    payload = b""
    while at + 8 <= len(data):
        length, kind = struct.unpack_from(">I4s", data, at)
        body = data[at + 8:at + 8 + length]
        if kind == b"IHDR":
            width, height, depth, colour = struct.unpack_from(">IIBB", body, 0)
            assert depth == 8 and colour == 6, "expected 8-bit RGBA"
        elif kind == b"IDAT":
            payload += body
        at += 12 + length
    raw = zlib.decompress(payload)

    # Undo the per-row filters; the writer uses none, but be safe.
    out = bytearray()
    stride = width * 4
    prev = bytearray(stride)
    at = 0
    for _ in range(height):
        filter_type = raw[at]
        row = bytearray(raw[at + 1:at + 1 + stride])
        at += 1 + stride
        if filter_type == 1:
            for i in range(4, stride):
                row[i] = (row[i] + row[i - 4]) & 0xFF
        elif filter_type == 2:
            for i in range(stride):
                row[i] = (row[i] + prev[i]) & 0xFF
        elif filter_type != 0:
            raise AssertionError(f"unsupported PNG filter {filter_type}")
        out += row
        prev = row
    return width, height, bytes(out)


@pytest.fixture(scope="module")
def ktx(lib):
    lib.fbx_alloc.restype = ctypes.c_uint32
    lib.fbx_alloc.argtypes = [ctypes.c_uint32]
    lib.test_heap_base.restype = ctypes.c_void_p
    lib.fbx_ktx2_decode.restype = ctypes.c_uint32
    lib.fbx_ktx2_decode.argtypes = [ctypes.c_uint32, ctypes.c_uint32]
    lib.fbx_heap_mark.restype = ctypes.c_uint32
    lib.fbx_heap_release.argtypes = [ctypes.c_uint32]
    return lib


def decode(ktx, blob: bytes):
    base = ctypes.c_void_p(ktx.test_heap_base()).value
    mark = ktx.fbx_heap_mark()
    try:
        at = ktx.fbx_alloc(max(len(blob), 1))
        ctypes.memmove(base + at, blob, len(blob))
        out = ctypes.cast(base + ktx.fbx_ktx2_decode(at, len(blob)),
                          ctypes.POINTER(Ktx2Out)).contents
        if not out.ok:
            return {"error": ERRORS.get(out.error, out.error)}
        return {
            "width": out.width,
            "height": out.height,
            "has_alpha": bool(out.has_alpha),
            "levels": out.levels,
            "rgba": ctypes.string_at(base + out.rgba, out.width * out.height * 4),
        }
    finally:
        ktx.fbx_heap_release(mark)


@pytest.mark.parametrize("case", CASES)
def test_every_pixel_matches_the_reference_transcoder(ktx, case):
    want_width, want_height, want = read_png(KTX2 / f"{case}.png")
    got = decode(ktx, (KTX2 / f"{case}.ktx2").read_bytes())
    assert "error" not in got, f"{case}: {got.get('error')}"
    assert (got["width"], got["height"]) == (want_width, want_height)
    assert len(got["rgba"]) == len(want)
    if got["rgba"] != want:
        bad = [i for i, (a, b) in enumerate(zip(got["rgba"], want)) if a != b]
        pixel = bad[0] // 4
        raise AssertionError(
            f"{len(bad)} of {len(want)} bytes differ; first at pixel "
            f"({pixel % want_width}, {pixel // want_width}) channel {bad[0] % 4}: "
            f"{got['rgba'][bad[0]]} vs {want[bad[0]]}")


def test_a_second_slice_carries_the_alpha(ktx):
    """A cut-out disc: opaque in the middle, clear at the corners."""
    got = decode(ktx, (KTX2 / "alpha.ktx2").read_bytes())
    assert got["has_alpha"]
    width, height = got["width"], got["height"]
    middle = got["rgba"][((height // 2) * width + width // 2) * 4 + 3]
    corner = got["rgba"][3]
    assert middle > 200, "the middle of the disc should be opaque"
    assert corner < 60, "the corner outside it should be clear"


def test_an_image_without_alpha_comes_back_opaque(ktx):
    got = decode(ktx, (KTX2 / "bars.ktx2").read_bytes())
    assert not got["has_alpha"]
    assert all(got["rgba"][i] == 255 for i in range(3, len(got["rgba"]), 4))


def test_the_size_is_whatever_the_file_says(ktx):
    """96x32 is neither square nor a whole number of 4x4 blocks tall."""
    got = decode(ktx, (KTX2 / "wide.ktx2").read_bytes())
    assert (got["width"], got["height"]) == (96, 32)
    assert got["levels"] > 1, "the fixture was encoded with mipmaps"


def test_something_that_is_not_a_ktx2_is_refused(ktx):
    assert decode(ktx, b"\x89PNG\r\n\x1a\n and then some")["error"] == "not a KTX2 file"


def test_a_truncated_file_is_refused(ktx):
    blob = (KTX2 / "gradient.ktx2").read_bytes()
    assert "error" in decode(ktx, blob[:len(blob) // 3])


def test_an_empty_file_is_refused(ktx):
    assert "error" in decode(ktx, b"")
