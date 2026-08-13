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


@pytest.fixture
def binary_cube(tmp_path) -> str:
    import fbxbuild as fb

    path = tmp_path / "cube.fbx"
    path.write_bytes(fb.build_cube())
    return str(path)


@pytest.fixture(scope="session")
def real_fbx_path() -> str:
    """A real exporter's file, if one is available.

    Set ``FBXTOOL_SAMPLE`` to point at your own; the tests that need it skip
    when it is absent, since no such file is checked in.
    """
    import os

    candidate = os.environ.get("FBXTOOL_SAMPLE")
    if candidate and Path(candidate).is_file():
        return candidate
    pytest.skip("set FBXTOOL_SAMPLE to a real .fbx file to run this test")
