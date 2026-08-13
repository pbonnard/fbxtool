"""Tests for the C core that becomes the WASM module.

The same source is compiled natively as a shared library so its DEFLATE
decoder can be checked against Python's zlib, and its mesh builder against a
reference implementation written here.  ``tests/test_web.py`` then exercises
the compiled ``.wasm`` in Node and the page in a browser.
"""

from __future__ import annotations

import ctypes
import random
import struct
import subprocess
import zlib
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "web" / "src" / "fbx.c"
LIBRARY = ROOT / "web" / "build" / "libfbx.so"


@pytest.fixture(scope="session")
def lib():
    """Compile the C core natively and load it."""
    if not SOURCE.exists():  # pragma: no cover - the source is checked in
        pytest.skip("web/src/fbx.c is missing")
    LIBRARY.parent.mkdir(parents=True, exist_ok=True)
    if not LIBRARY.exists() or SOURCE.stat().st_mtime > LIBRARY.stat().st_mtime:
        result = subprocess.run(
            ["clang", "-DFBX_NATIVE", "-O2", "-fPIC", "-shared",
             "-Wno-unknown-attributes", "-o", str(LIBRARY), str(SOURCE)],
            capture_output=True, text=True,
        )
        if result.returncode != 0:
            pytest.fail(f"could not build the native test library:\n{result.stderr}")

    handle = ctypes.CDLL(str(LIBRARY))
    handle.test_inflate_zlib.restype = ctypes.c_int32
    handle.test_inflate_zlib.argtypes = [
        ctypes.c_char_p, ctypes.c_uint32, ctypes.c_char_p, ctypes.c_uint32
    ]
    handle.test_inflate_raw.restype = ctypes.c_int32
    handle.test_inflate_raw.argtypes = handle.test_inflate_zlib.argtypes
    return handle


def inflate(lib, compressed: bytes, expected_len: int, raw: bool = False) -> bytes:
    buffer = ctypes.create_string_buffer(max(expected_len, 1))
    func = lib.test_inflate_raw if raw else lib.test_inflate_zlib
    written = func(compressed, len(compressed), buffer, max(expected_len, 1))
    if written < 0:
        raise ValueError("inflate reported failure")
    return buffer.raw[:written]


# ---------------------------------------------------------------- inflate


@pytest.mark.parametrize("payload", [
    b"",
    b"a",
    b"hello world",
    b"x" * 10_000,                       # long runs exercise back-references
    bytes(range(256)) * 40,              # every byte value
    b"abcabcabc" * 500,                  # short repeats
])
def test_inflate_matches_zlib(lib, payload):
    assert inflate(lib, zlib.compress(payload), len(payload)) == payload


@pytest.mark.parametrize("level", [0, 1, 6, 9])
def test_every_compression_level(lib, level):
    """Level 0 is stored blocks, 1 is mostly fixed Huffman, 9 is dynamic."""
    payload = bytes(random.Random(level).randrange(256) for _ in range(20_000))
    assert inflate(lib, zlib.compress(payload, level), len(payload)) == payload


def test_raw_deflate_without_the_zlib_header(lib):
    payload = b"raw deflate stream" * 100
    compressor = zlib.compressobj(9, zlib.DEFLATED, -zlib.MAX_WBITS)
    compressed = compressor.compress(payload) + compressor.flush()
    assert inflate(lib, compressed, len(payload), raw=True) == payload


def test_fuzz_against_zlib(lib):
    """Random payloads with varied redundancy, which is what shakes out
    Huffman table and back-reference bugs."""
    rng = random.Random(20240614)
    for trial in range(400):
        size = rng.randrange(0, 6000)
        style = trial % 4
        if style == 0:                                   # incompressible
            payload = bytes(rng.randrange(256) for _ in range(size))
        elif style == 1:                                 # highly repetitive
            payload = (bytes(rng.randrange(256) for _ in range(8)) * (size // 8 + 1))[:size]
        elif style == 2:                                 # small alphabet
            payload = bytes(rng.choice(b"ab\x00\xff") for _ in range(size))
        else:                                            # runs
            payload = b"".join(bytes([rng.randrange(256)]) * rng.randrange(1, 40)
                               for _ in range(size // 20 + 1))[:size]
        level = rng.choice([0, 1, 6, 9])
        assert inflate(lib, zlib.compress(payload, level), len(payload)) == payload, (
            f"trial {trial}: size={size} style={style} level={level}"
        )


def test_float_arrays_round_trip(lib):
    """The payload shape FBX actually stores: deflated float64 arrays."""
    values = [i * 0.10938 - 500.0 for i in range(30_000)]
    raw = struct.pack(f"<{len(values)}d", *values)
    decoded = inflate(lib, zlib.compress(raw, 9), len(raw))
    assert decoded == raw
    assert struct.unpack(f"<{len(values)}d", decoded)[:5] == tuple(values[:5])


def test_truncated_stream_is_rejected(lib):
    compressed = zlib.compress(b"payload" * 1000, 9)
    with pytest.raises(ValueError):
        inflate(lib, compressed[: len(compressed) // 2], 7000)


def test_corrupt_stream_is_rejected(lib):
    data = bytearray(zlib.compress(b"payload" * 1000, 9))
    data[5] ^= 0xFF
    data[9] ^= 0xFF
    with pytest.raises(ValueError):
        inflate(lib, bytes(data), 7000)


def test_bad_zlib_header_is_rejected(lib):
    with pytest.raises(ValueError):
        inflate(lib, b"\x00\x00garbage", 100)


def test_output_buffer_overrun_is_refused(lib):
    """A stream claiming more output than the caller allowed must not write past
    the end of the buffer."""
    payload = b"z" * 5000
    with pytest.raises(ValueError):
        inflate(lib, zlib.compress(payload), 100)


def _check_file_payloads(lib, path: str, minimum: int) -> int:
    """Inflate every deflated array in *path* and compare against zlib."""
    from fbxtool import read_fbx

    data = Path(path).read_bytes()
    doc = read_fbx(path)
    checked = 0
    for _, node in doc.root.walk():
        for prop in node.props:
            if prop.array is None or prop.array.encoding != 1:
                continue
            info = prop.array
            payload = data[info.data_offset : info.data_offset + info.byte_length]
            expected = zlib.decompress(payload)
            assert inflate(lib, payload, len(expected)) == expected
            checked += 1
    assert checked >= minimum, f"expected at least {minimum} deflated arrays"
    return checked


def test_sample_file_payloads(lib, sample_binary_path):
    """The checked-in sample, whose arrays the fixture writer deflates."""
    _check_file_payloads(lib, sample_binary_path, minimum=2)


def test_real_file_payloads(lib, real_fbx_path):
    """A real exporter's file, when one is provided."""
    checked = _check_file_payloads(lib, real_fbx_path, minimum=5)
    assert checked >= 5
