from __future__ import annotations

import sys
from pathlib import Path

import pytest

TESTS_DIR = Path(__file__).resolve().parent
ROOT = TESTS_DIR.parent

# Make ``fbxbuild`` importable and prefer the checkout over any installed copy.
for entry in (str(TESTS_DIR), str(ROOT)):
    if entry not in sys.path:
        sys.path.insert(0, entry)


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
