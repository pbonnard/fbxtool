from __future__ import annotations

import ctypes
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

TESTS_DIR = Path(__file__).resolve().parent
ROOT = TESTS_DIR.parent
SOURCE = ROOT / "web" / "src" / "fbx.c"
#: fbx.c includes the rest, so any of them changing means a rebuild.
SOURCES = sorted((ROOT / "web" / "src").glob("*.c"))
LIBRARY = ROOT / "web" / "build" / (
    "libfbx.dll" if sys.platform == "win32" else "libfbx.so")

# Make ``fbxbuild`` importable and prefer the checkout over any installed copy.
for entry in (str(TESTS_DIR), str(ROOT)):
    if entry not in sys.path:
        sys.path.insert(0, entry)


@pytest.fixture(scope="session")
def lib():
    """Compile the C core natively and load it.

    The same source becomes the WebAssembly module, so its DEFLATE decoder can
    be held against zlib and its geometry against values worked out by hand,
    with no browser in the way.
    """
    if not SOURCE.exists():  # pragma: no cover - the source is checked in
        pytest.skip("web/src/fbx.c is missing")
    LIBRARY.parent.mkdir(parents=True, exist_ok=True)
    newest = max((path.stat().st_mtime for path in SOURCES), default=0)
    if not LIBRARY.exists() or newest > LIBRARY.stat().st_mtime:
        if shutil.which("clang") is None:
            pytest.skip("clang is required to build the native test library")
        result = subprocess.run(
            ["clang", "-DFBX_NATIVE", "-O2", "-shared",
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


@pytest.fixture(scope="session")
def sample_ascii_path() -> str:
    return str(ROOT / "samples" / "cube_ascii.fbx")


@pytest.fixture(scope="session")
def sample_binary_path() -> str:
    return str(ROOT / "samples" / "cube_binary.fbx")


@pytest.fixture(scope="session")
def sample_obj_path() -> str:
    return str(ROOT / "samples" / "pyramid.obj")


@pytest.fixture(scope="session")
def sample_textured_path() -> str:
    return str(ROOT / "samples" / "cube_textured.fbx")


@pytest.fixture(scope="session")
def sample_scene_path() -> str:
    return str(ROOT / "samples" / "scene_parts.fbx")


@pytest.fixture
def binary_cube(tmp_path) -> str:
    import fbxbuild as fb

    path = tmp_path / "cube.fbx"
    path.write_bytes(fb.build_cube())
    return str(path)


def real_sample() -> str | None:
    """A real exporter's file: the checked-in one, or your own."""
    import os

    candidate = os.environ.get("FBXTOOL_SAMPLE")
    if candidate and Path(candidate).is_file():
        return candidate
    checked_in = ROOT / "samples" / "Mercedes+Benz+GLS+580.fbx"
    return str(checked_in) if checked_in.is_file() else None


def real_scene() -> str | None:
    """A real file of many parts, as opposed to one big mesh."""
    import os

    candidate = os.environ.get("FBXTOOL_SCENE")
    if candidate and Path(candidate).is_file():
        return candidate
    checked_in = ROOT / "samples" / "Shelby.fbx"
    return str(checked_in) if checked_in.is_file() else None


@pytest.fixture(scope="session")
def real_scene_path() -> str:
    """A Blender export of a Shelby Cobra: 44 parts, materials with nothing
    in them, and one mesh instanced by two dozen models."""
    candidate = real_scene()
    if candidate:
        return candidate
    pytest.skip("set FBXTOOL_SCENE to a multi-part .fbx to run this test")


@pytest.fixture(scope="session")
def real_fbx_path() -> str:
    """A real exporter's file.

    A Blender export of a Mercedes GLS 580 is checked in; ``FBXTOOL_SAMPLE``
    points these tests at a different one.
    """
    candidate = real_sample()
    if candidate:
        return candidate
    pytest.skip("set FBXTOOL_SAMPLE to a real .fbx file to run this test")


@pytest.fixture(scope="session")
def real_blend_path() -> str:
    """A real Blender file, if one is available.

    Set ``FBXTOOL_BLEND`` to point at your own; no .blend is checked in.
    """
    import os

    candidate = os.environ.get("FBXTOOL_BLEND")
    if candidate and Path(candidate).is_file():
        return candidate
    pytest.skip("set FBXTOOL_BLEND to a real .blend file to run this test")
