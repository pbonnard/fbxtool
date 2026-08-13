#!/usr/bin/env python3
"""Build the web version.

Compiles ``src/fbx.c`` to WebAssembly and inlines everything — WASM, CSS and
JavaScript — into a single self-contained ``dist/fbxview.html`` that runs from
a file:// URL with no server, no CDN and no network access.

    python3 web/build.py
"""

from __future__ import annotations

import base64
import shutil
import subprocess
import sys
from pathlib import Path

WEB = Path(__file__).resolve().parent
ROOT = WEB.parent
SRC = WEB / "src" / "fbx.c"
APP = WEB / "app"
BUILD = WEB / "build"
DIST = WEB / "dist"

WASM = BUILD / "fbx.wasm"
OUTPUT = DIST / "fbxview.html"

#: Order matters — later modules use the earlier ones.
SCRIPTS = [
    "wasm.js",
    "ascii.js",
    "obj.js",
    "blend.js",
    "transform.js",
    "analyze.js",
    "palette.js",
    "gltf.js",
    "report.js",
    "viewer.js",
    "main.js",
]

CLANG_FLAGS = [
    "--target=wasm32",
    "-nostdlib",
    "-O3",
    "-flto",
    "-ffast-math",
    "-Wall",
    "-Wextra",
    "-Wno-unused-parameter",
    "-Wl,--no-entry",
    "-Wl,--export-dynamic",
    "-Wl,--lto-O3",
    "-Wl,-z,stack-size=1048576",
    "-Wl,--initial-memory=16777216",
]


def compile_wasm() -> Path:
    BUILD.mkdir(parents=True, exist_ok=True)
    if shutil.which("clang") is None:
        raise SystemExit("clang is required to build the WebAssembly module")
    command = ["clang", *CLANG_FLAGS, "-o", str(WASM), str(SRC)]
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode != 0:
        raise SystemExit(f"clang failed:\n{result.stdout}\n{result.stderr}")
    if result.stderr.strip():
        print(result.stderr.strip(), file=sys.stderr)
    return WASM


def bundle(wasm: Path) -> Path:
    DIST.mkdir(parents=True, exist_ok=True)
    template = (APP / "index.html").read_text(encoding="utf-8")
    css = (APP / "style.css").read_text(encoding="utf-8")
    scripts = "\n".join(
        f"// ---- {name} " + "-" * (66 - len(name)) + "\n"
        + (APP / name).read_text(encoding="utf-8")
        for name in SCRIPTS
    )
    encoded = base64.b64encode(wasm.read_bytes()).decode("ascii")

    page = template.replace("/*INLINE_CSS*/", css)
    page = page.replace("/*INLINE_WASM*/", f'"{encoded}"')
    page = page.replace("/*INLINE_JS*/", scripts)
    OUTPUT.write_text(page, encoding="utf-8")
    return OUTPUT


def main() -> int:
    wasm = compile_wasm()
    page = bundle(wasm)
    print(f"wasm  {wasm.relative_to(ROOT)}  {wasm.stat().st_size:,} bytes")
    print(f"page  {page.relative_to(ROOT)}  {page.stat().st_size:,} bytes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
