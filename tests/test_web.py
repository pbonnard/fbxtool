"""Tests for the web version.

Three layers, each skipping cleanly when its toolchain is missing:

* the WebAssembly module builds from ``web/src/fbx.c``;
* the WASM reader, run under Node, produces exactly what the Python reader
  does for the same file;
* the built page loads in a real browser, parses a file and rasterises it.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

from fbxtool import read_fbx

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
WASM = WEB / "build" / "fbx.wasm"
PAGE = WEB / "dist" / "fbxview.html"

needs_clang = pytest.mark.skipif(shutil.which("clang") is None, reason="clang is required")
needs_node = pytest.mark.skipif(shutil.which("node") is None, reason="node is required")


def _node_env() -> dict[str, str]:
    """Node needs to find the globally installed playwright."""
    env = dict(os.environ)
    try:
        root = subprocess.run(["npm", "root", "-g"], capture_output=True, text=True,
                              timeout=60).stdout.strip()
        if root:
            env["NODE_PATH"] = root
    except (OSError, subprocess.SubprocessError):  # pragma: no cover - npm absent
        pass
    return env


@pytest.fixture(scope="session")
def built() -> Path:
    """Build the WASM module and the single-file page."""
    if shutil.which("clang") is None:
        pytest.skip("clang is required to build the WebAssembly module")
    result = subprocess.run(["python3", str(WEB / "build.py")], capture_output=True,
                            text=True, cwd=str(ROOT))
    if result.returncode != 0:
        pytest.fail(f"web build failed:\n{result.stdout}\n{result.stderr}")
    return PAGE


@needs_clang
def test_wasm_module_is_self_contained(built):
    """No imports means no runtime, no glue and no network."""
    assert WASM.exists()
    data = WASM.read_bytes()
    assert data[:4] == b"\x00asm"
    assert len(data) < 200_000, "the module should stay small enough to inline"


@needs_clang
def test_page_is_a_single_self_contained_file(built):
    page = built.read_text(encoding="utf-8")
    assert "WASM_BASE64" in page
    # Nothing may be fetched at runtime.
    for pattern in ["<script src=", "<link rel=\"stylesheet\"", "https://", "http://"]:
        assert pattern not in page, f"the page must not reference {pattern}"
    assert len(page) < 4_000_000


@needs_clang
@needs_node
def test_node_can_instantiate_the_module(built):
    script = (
        "const fs=require('fs');"
        f"const m=new WebAssembly.Module(fs.readFileSync({str(WASM)!r}));"
        "const i=new WebAssembly.Instance(m,{});"
        "console.log(JSON.stringify(Object.keys(i.exports)));"
    )
    result = subprocess.run(["node", "-e", script], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    exports = json.loads(result.stdout)
    for name in ["fbx_parse", "fbx_alloc", "fbx_inflate", "fbx_build_mesh", "memory"]:
        assert name in exports


def _wasm_dump(path: str) -> dict:
    result = subprocess.run(["node", str(WEB / "test" / "dump.js"), path],
                            capture_output=True, text=True, env=_node_env())
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def _python_dump(path: str) -> list:
    doc = read_fbx(path)
    out = []

    def describe(prop):
        if prop.array is not None:
            return ["A", prop.code, prop.array.length, prop.array.encoding,
                    prop.array.byte_length]
        if isinstance(prop.value, bytes):
            return ["R", list(prop.value)]
        if isinstance(prop.value, str):
            return ["S", prop.code, prop.value]
        return ["N", prop.code, prop.value]

    def walk(node, depth):
        for child in node.children:
            out.append([depth, child.name, len(child.props), len(child.children),
                        child.offset, [describe(p) for p in child.props]])
            walk(child, depth + 1)

    walk(doc.root, 0)
    return out


@needs_clang
@needs_node
@pytest.mark.parametrize("sample", ["cube_binary.fbx", "cube_ascii.fbx"])
def test_wasm_reader_matches_the_python_reader(built, sample):
    """The two implementations must agree record for record."""
    path = str(ROOT / "samples" / sample)
    wasm = _wasm_dump(path)
    python = _python_dump(path)
    doc = read_fbx(path)

    assert wasm["version"] == doc.version
    assert wasm["encoding"] == doc.encoding
    assert wasm["warnings"] == doc.warnings
    assert len(wasm["nodes"]) == len(python), (
        f"record count differs: wasm={len(wasm['nodes'])} python={len(python)}"
    )
    for index, (a, b) in enumerate(zip(python, wasm["nodes"])):
        if doc.encoding == "ascii":
            a, b = a[:4], b[:4]  # ASCII carries line numbers rather than offsets
        assert a == b, f"record {index} differs:\n  python={a}\n  wasm  ={b}"


@needs_clang
@needs_node
def test_wasm_reader_matches_on_a_real_file(built, real_fbx_path):
    wasm = _wasm_dump(real_fbx_path)
    python = _python_dump(real_fbx_path)
    assert len(wasm["nodes"]) == len(python)
    assert wasm["nodes"] == python
    assert wasm["warnings"] == []


@needs_clang
@needs_node
@pytest.mark.parametrize("version", [7400, 7500])
def test_wasm_reader_handles_both_offset_widths(built, tmp_path, version):
    import fbxbuild as fb

    path = tmp_path / f"v{version}.fbx"
    path.write_bytes(fb.build_cube(version=version))
    wasm = _wasm_dump(str(path))
    assert wasm["version"] == version
    assert wasm["wide"] is (version >= 7500)
    assert wasm["nodes"] == _python_dump(str(path))


@needs_node
def test_javascript_units():
    """Transform maths and PropertyTemplate defaults, checked under Node."""
    result = subprocess.run(["node", str(WEB / "test" / "units.js")],
                            capture_output=True, text=True, env=_node_env())
    print(result.stdout)
    assert result.returncode == 0, f"{result.stdout}\n{result.stderr}"
    assert "all checks passed" in result.stdout


@needs_clang
@needs_node
def test_wasm_heap_mark_and_release(built, tmp_path):
    """The bump allocator has to rewind cleanly between mesh builds."""
    import fbxbuild as fb

    path = tmp_path / "cube.fbx"
    path.write_bytes(fb.build_cube())
    result = subprocess.run(["node", str(WEB / "test" / "heap.js"), str(path)],
                            capture_output=True, text=True, env=_node_env())
    print(result.stdout)
    assert result.returncode == 0, f"{result.stdout}\n{result.stderr}"
    assert "all checks passed" in result.stdout


@needs_clang
@needs_node
def test_page_renders_in_a_browser(built):
    """Load the page in Chromium, feed it files, and confirm pixels were drawn."""
    try:
        import subprocess as sp
        probe = sp.run(["node", "-e", "require('playwright')"], capture_output=True,
                       text=True, env=_node_env())
        if probe.returncode != 0:
            pytest.skip("playwright is not installed for node")
    except OSError:  # pragma: no cover
        pytest.skip("node is unavailable")

    samples = [str(ROOT / "samples" / "cube_binary.fbx"),
               str(ROOT / "samples" / "cube_ascii.fbx"),
               # Embedded texture: loads with no help from the user.
               str(ROOT / "samples" / "cube_textured.fbx")]

    # A file that references its texture by name, with the image supplied
    # alongside — "a+b" tells the harness to load them together.
    import tempfile
    import fbxbuild as fb

    external = Path(tempfile.mkdtemp()) / "cube_external.fbx"
    external.write_bytes(fb.build_textured_cube(embed=False, filename="art/checker.png"))
    samples.append(f"{external}+{ROOT / 'samples' / 'checker.png'}")

    # OBJ needs its material library alongside, the same way textures do.
    samples.append(f"{ROOT / 'samples' / 'pyramid.obj'}"
                   f"+{ROOT / 'samples' / 'pyramid.mtl'}"
                   f"+{ROOT / 'samples' / 'checker.png'}")

    blend = Path(tempfile.mkdtemp()) / "scene.blend"
    blend.write_bytes(fb.build_blend())
    samples.append(str(blend))

    # A scene of several parts, which only assembles correctly when each
    # model's transform is applied — see test_scene_assembles_in_the_browser.
    scene = Path(tempfile.mkdtemp()) / "parts.fbx"
    scene.write_bytes(fb.build_scene())
    samples.append(str(scene))

    real = os.environ.get("FBXTOOL_SAMPLE")
    if real and Path(real).is_file():
        samples.append(real)

    result = subprocess.run(["node", str(WEB / "test" / "browser.js"), *samples],
                            capture_output=True, text=True, env=_node_env(), timeout=300)
    print(result.stdout)
    assert result.returncode == 0, f"{result.stdout}\n{result.stderr}"
    assert "all checks passed" in result.stdout


@needs_clang
@needs_node
def test_scene_assembles_in_the_browser(built, tmp_path):
    """Every part placed by its model's transform, with the size to prove it.

    The fixture chains three models onto one shared cube, so the assembled
    scene is only the right size if instancing, the parent chain and the
    negative scale on the last part are all handled.
    """
    try:
        probe = subprocess.run(["node", "-e", "require('playwright')"],
                               capture_output=True, text=True, env=_node_env())
        if probe.returncode != 0:
            pytest.skip("playwright is not installed for node")
    except OSError:  # pragma: no cover
        pytest.skip("node is unavailable")

    import fbxbuild as fb

    scene = tmp_path / "parts.fbx"
    scene.write_bytes(fb.build_scene())
    result = subprocess.run(["node", str(WEB / "test" / "browser.js"), str(scene)],
                            capture_output=True, text=True, env=_node_env(), timeout=300)
    print(result.stdout)
    assert result.returncode == 0, f"{result.stdout}\n{result.stderr}"

    size = " × ".join(f"{v:.1f}" for v in fb.SCENE_SIZE)
    assert f"{fb.SCENE_PARTS} parts" in result.stdout
    assert f"{fb.SCENE_TRIANGLES} triangles" in result.stdout
    assert f"{size} units" in result.stdout, f"expected a {size} scene"
    # One palette entry per part, all coloured by the Definitions template.
    assert f"{fb.SCENE_PARTS} material colours" in result.stdout
