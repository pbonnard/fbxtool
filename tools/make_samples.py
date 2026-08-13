#!/usr/bin/env python3
"""Regenerate the binary sample file in ``samples/``.

The ASCII sample is checked in as source; its binary counterpart is generated
so that the bytes stay in step with the writer used by the tests::

    python3 tools/make_samples.py
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tests"))

import fbxbuild as fb  # noqa: E402  (needs the path set up first)


def main() -> int:
    samples = ROOT / "samples"
    samples.mkdir(parents=True, exist_ok=True)
    for name, data in [
        ("cube_binary.fbx", fb.build_cube(version=7400)),
        # Three placed parts sharing one mesh, for the whole-scene view.
        ("scene_parts.fbx", fb.build_scene(version=7400)),
    ]:
        target = samples / name
        target.write_bytes(data)
        print(f"wrote {target.relative_to(ROOT)} ({target.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
