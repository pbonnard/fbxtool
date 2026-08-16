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
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from conftest import real_sample, real_scene
from fbxtool import read_fbx

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
WASM = WEB / "build" / "fbx.wasm"
PAGE = WEB / "dist" / "fbxview.html"

needs_clang = pytest.mark.skipif(shutil.which("clang") is None, reason="clang is required")
needs_node = pytest.mark.skipif(shutil.which("node") is None, reason="node is required")


def _run(args, **kwargs) -> subprocess.CompletedProcess:
    """Run a harness and read what it prints as UTF-8.

    The harnesses print "×" and "·"; left to the console's own code page,
    Windows hands back mojibake and every check on their output fails.
    """
    return subprocess.run(args, capture_output=True, text=True,
                          encoding="utf-8", errors="replace", **kwargs)


def _node_env() -> dict[str, str]:
    """Node needs to find the globally installed playwright.

    ``npm`` is asked for where that is, by the path ``shutil.which`` gives
    rather than by name: on Windows it is ``npm.cmd``, which ``CreateProcess``
    will not run when it is asked for ``npm``.  Left as it was, every harness
    below skipped for want of playwright that was installed all along — and a
    suite that skips itself reads exactly like one that passes.
    """
    env = dict(os.environ)
    npm = shutil.which("npm")
    if npm is None:  # pragma: no cover - npm absent
        return env
    try:
        root = _run([npm, "root", "-g"], timeout=60).stdout.strip()
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
    # The interpreter running the tests, not whatever "python3" happens to
    # name: on Windows that is as likely to be an unrelated install, or the
    # Store's stub, as the one the suite is running under.
    result = _run([sys.executable, str(WEB / "build.py")], cwd=str(ROOT))
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
    result = _run(["node", "-e", script])
    assert result.returncode == 0, result.stderr
    exports = json.loads(result.stdout)
    for name in ["fbx_parse", "fbx_alloc", "fbx_inflate", "fbx_build_mesh", "memory"]:
        assert name in exports


# --------------------------------------------------- the Photoshop decoder


def _decode_psd(tmp_path, data: bytes) -> dict:
    """Run the page's own ``psd.js`` over some bytes, under Node."""
    source = tmp_path / "image.psd"
    source.write_bytes(data)
    script = (
        "const fs=require('fs');"
        f"const P=require({str(WEB / 'app' / 'psd.js')!r});"
        f"const b=new Uint8Array(fs.readFileSync({str(source)!r}));"
        "const image=P.decode(b);"
        "console.log(JSON.stringify(image ? "
        "{width:image.width,height:image.height,rgba:Array.from(image.rgba)} : null));"
    )
    result = _run(["node", "-e", script])
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


@needs_node
@pytest.mark.parametrize("compress", [True, False], ids=["packbits", "raw"])
def test_a_photoshop_document_is_decoded_to_its_pixels(tmp_path, compress):
    """No browser will make an image of a ``.psd``, and 3ds Max scenes name
    them freely — a tyre whose tread lives in one is a plain black ring
    without this.

    The composite is stored planar, the whole of one channel before the next,
    so a reader that takes it for RGB triples gets three bands of nonsense
    rather than nothing at all.
    """
    import fbxbuild as fb

    width, height = 19, 5
    pixels = bytearray()
    for y in range(height):
        for x in range(width):
            # A run long enough to be coded as one, then bytes that cannot be.
            if x < 6:
                pixels += bytes((200, 30, 40))
            else:
                pixels += bytes((x * 7 % 256, y * 40 % 256, (x + y) * 11 % 256))

    image = _decode_psd(tmp_path, fb.psd(width, height, bytes(pixels), compress=compress))
    assert image is not None, "the decoder would not claim it"
    assert (image["width"], image["height"]) == (width, height)
    got = bytes(v for i, v in enumerate(image["rgba"]) if i % 4 != 3)
    assert got == bytes(pixels)
    assert set(image["rgba"][3::4]) == {255}, "no alpha channel means opaque"


@needs_node
def test_a_greyscale_document_comes_out_grey_rather_than_red(tmp_path):
    """One channel is the picture, not the red of a picture missing two."""
    import fbxbuild as fb

    pixels = bytes(bytearray(sum(([v, 0, 0] for v in (10, 90, 200, 255)), [])))
    image = _decode_psd(tmp_path, fb.psd(4, 1, pixels, channels=1))
    assert image is not None
    assert image["rgba"][0:4] == [10, 10, 10, 255]
    assert image["rgba"][8:12] == [200, 200, 200, 255]


@needs_node
@pytest.mark.parametrize("mangle,why", [
    (lambda d: b"8BPS" + b"\x00\x02" + d[6:], "a PSB, whose sizes are wider"),
    (lambda d: d[:22] + b"\x00\x10" + d[24:], "sixteen bits a channel"),
    (lambda d: d[:24] + b"\x00\x04" + d[26:], "CMYK, which needs a profile"),
    (lambda d: d[:40], "cut off before the picture"),
], ids=["psb", "16bit", "cmyk", "truncated"])
def test_a_document_it_will_not_claim_comes_back_as_nothing(tmp_path, mangle, why):
    """Returning nothing has it reported as an image that would not decode.

    Returning a guess would have it drawn wrongly, which is worse: a texture
    nobody can tell is wrong is one nobody fixes.
    """
    import fbxbuild as fb

    good = fb.psd(4, 1, bytes(12))
    assert _decode_psd(tmp_path, mangle(good)) is None, why


# --------------------------------------------- how a reflection is read


def _appearance(props: dict) -> dict:
    """Run the page's own reading of a material's surface, under Node."""
    script = (
        f"const A=require({str(WEB / 'app' / 'analyze.js')!r});"
        f"console.log(JSON.stringify(A.materialAppearance({json.dumps(props)})));"
    )
    result = _run(["node", "-e", script])
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


@needs_node
@pytest.mark.parametrize("ior,expected,what", [
    (999.0, 0.996, "an artist writing 'metal', which is a mirror"),
    (1.52, 0.0426, "the index of glass, and of most plastics"),
    (8.0, 0.6049, "a car paint's base under its coat"),
], ids=["chrome", "glass", "paint"])
def test_a_reflection_is_shaped_by_the_index_beside_it(ior, expected, what):
    """A reflection colour is the tint; the index says how much comes back.

    Facing you it is ``((n-1)/(n+1))**2`` of the colour, which is the whole of
    what tells a mirror from a windscreen — and both are stated as a reflection
    of 1.  Capped instead, an Audi's chrome draws as white plastic; taken at
    face value, its windscreen draws as a sheet of chrome.
    """
    look = _appearance({"DiffuseColor": [0, 0, 0], "SpecularColor": [1, 1, 1],
                        "ReflectionIor": ior})
    assert look["specular"][0] == pytest.approx(expected, abs=1e-3), what


@needs_node
def test_the_tint_of_a_reflection_is_kept():
    """The index says how much, the colour says what of it."""
    look = _appearance({"DiffuseColor": [0, 0, 0], "SpecularColor": [0.8, 0.4, 0.2],
                        "ReflectionIor": 1.52})
    facing = ((1.52 - 1) / (1.52 + 1)) ** 2
    assert look["specular"] == pytest.approx([0.8 * facing, 0.4 * facing, 0.2 * facing],
                                             abs=1e-4)


@needs_node
@pytest.mark.parametrize("spelling", [
    "ReflectionIor",                        # this project's own
    "3dsMax|basic|reflection_ior",          # V-Ray, through 3ds Max's exporter
    "3dsMax|CoronaMtlPb|fresnelIor",        # Corona, the same way
], ids=["ours", "vray", "corona"])
def test_the_index_is_found_however_it_is_spelt(spelling):
    look = _appearance({"SpecularColor": [1, 1, 1], spelling: 999.0})
    assert look["specular"][0] == pytest.approx(0.996, abs=1e-3)


@needs_node
def test_a_clear_coat_is_read_as_its_own_surface():
    """How much it reflects and how polished it is, and nothing else.

    A coat is clear, so it needs no colour of its own — but it does need its
    index, and an Audi's coat states 999, which is a mirror.  Without it the
    coat would be a reflection of 1.0 taken at face value, which is the same
    mirror by accident rather than by reading.
    """
    look = _appearance({"SpecularColor": [0.047, 0.047, 0.047], "ReflectionIor": 8.0,
                        "CoatColor": [0.5, 0.5, 0.5], "CoatIor": 999.0,
                        "CoatShininess": 1024.0})
    assert look["coat"] == pytest.approx(0.498, abs=1e-3)
    assert look["coatRoughness"] == pytest.approx(0.05, abs=1e-3)
    # The base underneath is untouched by it.
    assert look["specular"][0] == pytest.approx(0.047 * 0.6049, abs=1e-4)


@needs_node
def test_a_surface_with_no_coat_states_none():
    """Which is most of them, and the shader skips the whole of it."""
    look = _appearance({"SpecularColor": [1, 1, 1], "ReflectionIor": 1.52})
    assert look["coat"] == 0


@needs_node
def test_a_specular_with_no_index_beside_it_is_still_capped():
    """It has to be.

    A legacy 6.x export carries the reflection and loses the index, and that
    car's every material states 1.0 — taken at face value the whole of it turns
    to mirror and a dark blue Ferrari comes out grey.  An OBJ's `Ks 0.9 0.9
    0.9` is the same habit and the reason the cap is there at all.
    """
    look = _appearance({"DiffuseColor": [0, 0.1, 0.3], "SpecularColor": [1, 1, 1]})
    assert max(look["specular"]) == pytest.approx(0.16, abs=1e-6)
    # And a map slot that merely drives an index is not one.
    driven = _appearance({"SpecularColor": [1, 1, 1],
                          "3dsMax|CoronaMtlPb|texmapFresnelIor": 999.0})
    assert max(driven["specular"]) == pytest.approx(0.16, abs=1e-6)


def _wasm_dump(path: str) -> dict:
    result = _run(["node", str(WEB / "test" / "dump.js"), path], env=_node_env())
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
@pytest.mark.parametrize("container", ["glb", "gltf"])
def test_the_two_gltf_readers_agree(built, tmp_path, container):
    """glTF is read twice over — once here, once in the page — and the two
    have to produce the same records, down to the embedded image."""
    import fbxbuild as fb

    if container == "glb":
        path = tmp_path / "scene.glb"
        path.write_bytes(fb.build_glb())
    else:
        document, buffer = fb.build_gltf()
        path = tmp_path / "scene.gltf"
        path.write_bytes(document)
        (tmp_path / "scene.bin").write_bytes(buffer)

    js = _wasm_dump(str(path))
    python = _python_dump(str(path))
    assert js["warnings"] == []
    assert len(js["nodes"]) == len(python), (
        f"record count differs: js={len(js['nodes'])} python={len(python)}"
    )
    for index, (a, b) in enumerate(zip(python, js["nodes"])):
        assert a == b, f"record {index} differs:\n  python={a}\n  js    ={b}"


@needs_clang
@needs_node
@pytest.mark.parametrize("shader", [None, "Blinn", "VRayMtl", "CoronaMtl"])
def test_the_two_max_readers_agree(built, tmp_path, shader):
    """A .max is read twice over — once here, once in the page — and the two
    have to produce the same records, down to the last vertex.

    Nothing about this format is documented, so there is no third party to
    check against: what the two readers share is one account of the format,
    and this is what keeps them from drifting apart.  Each shader lays its
    block out differently, so each is read both ways.
    """
    import fbxbuild as fb

    path = tmp_path / "scene.max"
    path.write_bytes(fb.build_max(shader=shader))

    js = _wasm_dump(str(path))
    python = _python_dump(str(path))
    assert js["warnings"] == []
    assert len(js["nodes"]) == len(python), (
        f"record count differs: js={len(js['nodes'])} python={len(python)}"
    )
    for index, (a, b) in enumerate(zip(python, js["nodes"])):
        assert a == b, f"record {index} differs:\n  python={a}\n  js    ={b}"


@needs_clang
@needs_node
@pytest.mark.parametrize("scene", [
    # A wheel linked to a body, whose controller is read relative to it.
    {"name": "body", "place": (0.0, 0.0, 100.0), "child": (10.0, 0.0, -20.0)},
    # A Multi/Sub-Object, and the slot each face of the cube picks out of it.
    {"slots": 4, "materials": [0, 1, 2, 3, 1, 0], "groups": [1 << 20] * 6},
    # What a 3ds Max 2012 writes: its parameters and its asset table both.
    {"shader": "Blinn", "param_chunk": 0x000E, "assets_version": 2},
    # A V-Ray material's diffuse and its bump, which must not be swapped.
    {"shader": "VRayMtl", "material_class": "VRayMtl",
     "maps": {7: "colour.png", 10: "bump.png"}},
    # The same for Corona, which keys them on the block rather than itself.
    {"shader": "CoronaMtl", "material_class": "CoronaMtl", "maps_on": "block",
     "maps": {0: "colour.png", 6: "bump.png"}},
    # A Blend in a slot, which must not shift the slots behind it, and which
    # keeps its name under an id of its own.
    {"slots": 4, "materials": [0, 1, 2, 3, 1, 0], "blend_slots": {1}},
    # A polished surface, so the exponent the two write has to agree.
    {"shader": "VRayMtl", "glossiness": 0.82},
    # A Symmetry modifier, which both have to mirror the same way.
    {"symmetry": (0, 0.001), "offset": (2.0, 0.0, 0.0)},
    # A Dummy over the node, which both have to write a record for.
    {"under_a_dummy": (10.0, 0.0, 5.0)},
    # A diffuse slot filled by a colour rather than a picture.
    {"shader": "CoronaMtl", "material_class": "CoronaMtl", "maps_on": "block",
     "colour_map": (0.02, 0.04, 0.06)},
    # A clear coat over a base, at half the strength the blend allows.
    {"slots": 2, "materials": [0, 1, 0, 1, 0, 1], "blend_slots": {0},
     "shader": "VRayMtl", "material_class": "VRayMtl", "coat_amount": 0.5},
    # Corona's two indices side by side, only one of which shapes a reflection.
    {"shader": "CoronaMtl", "material_class": "CoronaMtl",
     "fresnel_ior": 999.0, "refract_ior": 1.52},
    # A reflection slot filled by a colour, and by a ramp between two.
    {"shader": "CoronaMtl", "material_class": "CoronaMtl", "maps_on": "block",
     "reflect_map": (0.19, 0.15, 0.13)},
    {"shader": "CoronaMtl", "material_class": "CoronaMtl", "maps_on": "block",
     "falloff_near": (0.02, 0.02, 0.02)},
    # A layered material whose coat amount is a map rather than a number.
    {"shader": "CoronaMtl", "material_class": "CoronaMtl",
     "layered_coat": (0.0, 0.0, 0.0)},
    {"shader": "CoronaMtl", "material_class": "CoronaMtl",
     "layered_coat": (1.0, 1.0, 1.0)},
], ids=["hierarchy", "slots", "max2012", "vray-maps", "corona-maps", "blend-slot",
        "glossiness", "symmetry", "dummy", "colour-map", "clear-coat",
        "corona-ior", "reflect-colour", "reflect-falloff",
        "layered-edge-coat", "layered-full-coat"])
def test_the_two_max_readers_agree_on_what_a_car_needs(built, tmp_path, scene):
    """The same cross-check over the shapes a real car scene turns out to use.

    Each of these was a way the two readers could have drifted apart while
    still agreeing about a cube with one material on it.
    """
    import fbxbuild as fb

    path = tmp_path / "scene.max"
    path.write_bytes(fb.build_max(**scene))

    js = _wasm_dump(str(path))
    python = _python_dump(str(path))
    assert js["warnings"] == []
    assert len(js["nodes"]) == len(python), (
        f"record count differs: js={len(js['nodes'])} python={len(python)}"
    )
    for index, (a, b) in enumerate(zip(python, js["nodes"])):
        assert a == b, f"record {index} differs:\n  python={a}\n  js    ={b}"


@needs_clang
@needs_node
def test_a_max_scene_is_drawn(built, tmp_path):
    """The cube out of a 3ds Max scene, on screen and the right way up."""
    try:
        probe = _run(["node", "-e", "require('playwright')"], env=_node_env())
        if probe.returncode != 0:
            pytest.skip("playwright is not installed for node")
    except OSError:  # pragma: no cover
        pytest.skip("node is unavailable")

    import fbxbuild as fb

    path = tmp_path / "scene.max"
    path.write_bytes(fb.build_max(name="body_shell"))
    result = _run(["node", str(WEB / "test" / "browser.js"), str(path)],
                  env=_node_env(), timeout=300)
    print(result.stdout)
    assert result.returncode == 0, f"{result.stdout}\n{result.stderr}"
    assert "all checks passed" in result.stdout


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
    result = _run(["node", str(WEB / "test" / "units.js")], env=_node_env())
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
    result = _run(["node", str(WEB / "test" / "heap.js"), str(path)], env=_node_env())
    print(result.stdout)
    assert result.returncode == 0, f"{result.stdout}\n{result.stderr}"
    assert "all checks passed" in result.stdout


@needs_clang
@needs_node
def test_a_new_file_replaces_the_last(built):
    """Nothing of the previous file may survive opening another one."""
    try:
        probe = _run(["node", "-e", "require('playwright')"], env=_node_env())
        if probe.returncode != 0:
            pytest.skip("playwright is not installed for node")
    except OSError:  # pragma: no cover
        pytest.skip("node is unavailable")

    result = _run(
        ["node", str(WEB / "test" / "reload.js"),
         str(ROOT / "samples" / "cube_textured.fbx"),
         str(ROOT / "samples" / "scene_parts.fbx")],
        env=_node_env(), timeout=300)
    print(result.stdout)
    assert result.returncode == 0, f"{result.stdout}\n{result.stderr}"
    assert "all checks passed" in result.stdout


@needs_clang
@needs_node
def test_gltf_export(built, tmp_path):
    """Export through the page and take the result apart.

    The Khronos glTF-Validator is used when it is installed
    (``npm i -g gltf-validator``); the structural and semantic checks run
    either way.
    """
    try:
        probe = _run(["node", "-e", "require('playwright')"], env=_node_env())
        if probe.returncode != 0:
            pytest.skip("playwright is not installed for node")
    except OSError:  # pragma: no cover
        pytest.skip("node is unavailable")

    import fbxbuild as fb

    glass = tmp_path / "glass.fbx"
    glass.write_bytes(fb.build_glass())
    # A compressed glTF goes round the whole loop: decompressed to be drawn,
    # then written back out as plain geometry with its texture as a PNG.
    basis = tmp_path / "basis.glb"
    basis.write_bytes(fb.build_basis_glb())
    draco = tmp_path / "draco.glb"
    draco.write_bytes(fb.build_draco_glb())
    files = [str(ROOT / "samples" / "cube_textured.fbx"),
             str(ROOT / "samples" / "scene_parts.fbx"),
             f"{ROOT / 'samples' / 'pyramid.obj'}+{ROOT / 'samples' / 'pyramid.mtl'}"
             f"+{ROOT / 'samples' / 'checker.png'}",
             str(glass), str(basis), str(draco)]
    for real in (real_sample(), real_scene()):
        if real:
            files.append(real)

    result = _run(["node", str(WEB / "test" / "gltf.js"), *files], env=_node_env(), timeout=600)
    print(result.stdout)
    assert result.returncode == 0, f"{result.stdout}\n{result.stderr}"
    assert "all checks passed" in result.stdout


@needs_clang
@needs_node
def test_a_draco_compressed_glb_renders(built, tmp_path):
    """A .glb whose geometry is only in a Draco block draws, in the page.

    The accessors in such a file carry counts but no data, so anything that
    comes out on screen came out of the decompressor.
    """
    import fbxbuild as fb

    path = tmp_path / "draco.glb"
    path.write_bytes(fb.build_draco_glb())
    result = _run(["node", str(WEB / "test" / "browser.js"), str(path)],
                  env=_node_env(), timeout=300)
    print(result.stdout)
    assert result.returncode == 0, f"{result.stdout}\n{result.stderr}"
    assert f"{fb.DRACO_GLB_TRIANGLES} triangles" in result.stdout
    assert "no warnings  — clean" in result.stdout
    # Something was actually drawn, not merely counted.
    assert "lit samples" in result.stdout
    assert " 0 lit samples" not in result.stdout


@needs_clang
@needs_node
def test_a_basis_texture_is_drawn(built, tmp_path):
    """A quad whose texture is a KTX2 (Basis Universal).

    No browser decodes KTX2 — it holds blocks for a GPU, not a picture — so
    the colours on screen came out of our transcoder.
    """
    import fbxbuild as fb

    path = tmp_path / "basis.glb"
    path.write_bytes(fb.build_basis_glb("bars"))
    result = _run(["node", str(WEB / "test" / "browser.js"), str(path)],
                  env=_node_env(), timeout=300)
    print(result.stdout)
    assert result.returncode == 0, f"{result.stdout}\n{result.stderr}"
    assert "1/1 textures" in result.stdout, "the texture was not decoded"
    # Eight colour bars: an untextured quad would be close to flat.
    match = re.search(r"(\d+) distinct colours", result.stdout)
    assert match and int(match.group(1)) > 20, result.stdout


@needs_clang
@needs_node
def test_gltf_import(built):
    """Read glTF back: our own export, round-tripped, and a hand-written file
    using what the exporter never writes — interleaving, 16-bit indices, a
    sparse accessor, a quaternion, and a buffer in a separate .bin."""
    try:
        probe = _run(["node", "-e", "require('playwright')"], env=_node_env())
        if probe.returncode != 0:
            pytest.skip("playwright is not installed for node")
    except OSError:  # pragma: no cover
        pytest.skip("node is unavailable")

    files = [str(ROOT / "samples" / "cube_textured.fbx"),
             str(ROOT / "samples" / "scene_parts.fbx"),
             f"{ROOT / 'samples' / 'pyramid.obj'}+{ROOT / 'samples' / 'pyramid.mtl'}"
             f"+{ROOT / 'samples' / 'checker.png'}"]
    real = real_sample()
    if real:
        files.append(real)

    result = _run(["node", str(WEB / "test" / "gltfin.js"), *files],
                  env=_node_env(), timeout=900)
    print(result.stdout)
    assert result.returncode == 0, f"{result.stdout}\n{result.stderr}"
    assert "all checks passed" in result.stdout


@needs_clang
@needs_node
def test_legacy_scene_assembles_in_the_browser(built, tmp_path):
    """FBX 6.x renders too: objects named rather than numbered, the mesh on
    the model, and every number written as its own property."""
    try:
        probe = _run(["node", "-e", "require('playwright')"], env=_node_env())
        if probe.returncode != 0:
            pytest.skip("playwright is not installed for node")
    except OSError:  # pragma: no cover
        pytest.skip("node is unavailable")

    import fbxbuild as fb

    legacy = tmp_path / "legacy.fbx"
    legacy.write_bytes(fb.build_legacy())
    result = _run(["node", str(WEB / "test" / "browser.js"), str(legacy)], env=_node_env(), timeout=300)
    print(result.stdout)
    assert result.returncode == 0, f"{result.stdout}\n{result.stderr}"

    size = " × ".join(f"{v:.1f}" for v in fb.LEGACY_SIZE)
    assert f"{fb.LEGACY_PARTS} parts" in result.stdout
    assert f"{fb.LEGACY_TRIANGLES} triangles" in result.stdout
    assert f"{size} units" in result.stdout, f"expected a {size} scene"


@needs_clang
@needs_node
def test_a_transform_on_a_parent_without_a_mesh_still_counts(built, tmp_path):
    """A cube under a parent that holds nothing but a transform.

    Exporters write this constantly — a rig, a pivot, or the root node a glTF
    hangs its axis and unit conversion on. Assembling the scene by walking only
    the models that own geometry drops it, and the model comes out at half the
    size it should be, in the wrong place.
    """
    try:
        probe = _run(["node", "-e", "require('playwright')"], env=_node_env())
        if probe.returncode != 0:
            pytest.skip("playwright is not installed for node")
    except OSError:  # pragma: no cover
        pytest.skip("node is unavailable")

    import fbxbuild as fb

    path = tmp_path / "rigged.fbx"
    path.write_bytes(fb.build_rigged())
    result = _run(["node", str(WEB / "test" / "browser.js"), str(path)],
                  env=_node_env(), timeout=300)
    print(result.stdout)
    assert result.returncode == 0, f"{result.stdout}\n{result.stderr}"

    size = " × ".join(f"{v:.1f}" for v in fb.RIGGED_SIZE)
    assert f"{fb.RIGGED_TRIANGLES} triangles" in result.stdout
    assert f"{size} units" in result.stdout, "the parent's scale was dropped"


@needs_clang
@needs_node
def test_subdivision_through_the_module(built):
    """The compiled module, driven the way the viewer drives it."""
    files = [str(WEB / "test" / "subdivide.js")]
    real = real_sample()
    if real:
        files.append(real)
    result = _run(["node", *files], env=_node_env(), timeout=300)
    print(result.stdout)
    assert result.returncode == 0, f"{result.stdout}\n{result.stderr}"
    assert "all checks passed" in result.stdout


@needs_clang
@needs_node
def test_a_dropped_folder_brings_its_textures(built, tmp_path):
    """A model downloaded as a folder keeps its images in a subfolder, and the
    document names them by relative path.  Dropping the folder has to reach
    them: without them every material falls back to what it states alone, and
    glTF's default for a metalness a file leaves out is 1."""
    try:
        probe = _run(["node", "-e", "require('playwright')"], env=_node_env())
        if probe.returncode != 0:
            pytest.skip("playwright is not installed for node")
    except OSError:  # pragma: no cover
        pytest.skip("node is unavailable")

    import fbxbuild as fb

    # The same scene saved twice: one file kept the mesh, the other the maps.
    rich = tmp_path / "rich.fbx"
    rich.write_bytes(fb.build_bare_twin())
    mapped = tmp_path / "mapped.fbx"
    mapped.write_bytes(fb.build_scrap_twin())
    result = _run(
        ["node", str(WEB / "test" / "drop.js"),
         str(ROOT / "samples" / "pyramid.obj"),
         str(ROOT / "samples" / "pyramid.mtl"),
         str(ROOT / "samples" / "checker.png"),
         str(rich), str(mapped)],
        env=_node_env(), timeout=300)
    print(result.stdout)
    assert result.returncode == 0, f"{result.stdout}\n{result.stderr}"
    assert "all checks passed" in result.stdout


@needs_clang
@needs_node
def test_a_material_is_shaded_by_the_map_it_is_bumped_by(built, tmp_path):
    """A .max names the map its surface is shaped by, and drawing it flat
    throws away most of what the artist put there.

    Two kinds arrive through the one slot — a height and a direction — and
    they have to be told apart: read the wrong way round, a height map tips
    every normal towards the same corner.
    """
    try:
        probe = _run(["node", "-e", "require('playwright')"], env=_node_env())
        if probe.returncode != 0:
            pytest.skip("playwright is not installed for node")
    except OSError:  # pragma: no cover
        pytest.skip("node is unavailable")

    import fbxbuild as fb

    height = tmp_path / "height.max"
    height.write_bytes(fb.build_max(shader="VRayMtl", material_class="VRayMtl",
                                    maps={10: "height.png"}))
    (tmp_path / "height.png").write_bytes(fb.height_png())
    facing = tmp_path / "facing.max"
    facing.write_bytes(fb.build_max(shader="VRayMtl", material_class="VRayMtl",
                                    maps={10: "facing.png"}))
    (tmp_path / "facing.png").write_bytes(fb.normal_map_png())

    result = _run(
        ["node", str(WEB / "test" / "bump.js"),
         str(height), str(tmp_path / "height.png"),
         str(facing), str(tmp_path / "facing.png")],
        env=_node_env(), timeout=300)
    print(result.stdout)
    assert result.returncode == 0, f"{result.stdout}\n{result.stderr}"
    assert "all checks passed" in result.stdout


@needs_clang
@needs_node
def test_the_model_can_be_mirrored_on_each_axis(built):
    """A mirror is not a view setting: it goes out with the export.

    And it reverses which way round a triangle is wound, so a renderer culling
    by the old rule draws the inside of the model — the same outline, which is
    why this asks what the normals are doing as well as what the picture is.
    """
    try:
        probe = _run(["node", "-e", "require('playwright')"], env=_node_env())
        if probe.returncode != 0:
            pytest.skip("playwright is not installed for node")
    except OSError:  # pragma: no cover
        pytest.skip("node is unavailable")

    result = _run(["node", str(WEB / "test" / "flip.js"),
                   str(ROOT / "samples" / "scene_parts.fbx")],
                  env=_node_env(), timeout=300)
    print(result.stdout)
    assert result.returncode == 0, f"{result.stdout}\n{result.stderr}"
    assert "all checks passed" in result.stdout


@needs_clang
@needs_node
def test_the_model_can_be_turned_to_face_the_other_way(built):
    """A heading is a view setting, and the export does not follow it.

    No file says which end of a model is its front — the axis declarations are
    a convention of the format, not a reading of the scene — so a model laid
    out across them opens showing its back. Being told once has to be enough,
    which is why this asks what happens when the file is opened again.
    """
    try:
        probe = _run(["node", "-e", "require('playwright')"], env=_node_env())
        if probe.returncode != 0:
            pytest.skip("playwright is not installed for node")
    except OSError:  # pragma: no cover
        pytest.skip("node is unavailable")

    result = _run(["node", str(WEB / "test" / "turn.js"),
                   str(ROOT / "samples" / "scene_parts.fbx")],
                  env=_node_env(), timeout=300)
    print(result.stdout)
    assert result.returncode == 0, f"{result.stdout}\n{result.stderr}"
    assert "all checks passed" in result.stdout


@needs_clang
@needs_node
def test_smoothing_control(built, tmp_path):
    """Picking a level rebuilds what is on screen, and rounds it."""
    try:
        probe = _run(["node", "-e", "require('playwright')"], env=_node_env())
        if probe.returncode != 0:
            pytest.skip("playwright is not installed for node")
    except OSError:  # pragma: no cover
        pytest.skip("node is unavailable")

    import fbxbuild as fb

    # Each side of this cube in a smoothing group of its own, so every edge
    # between them is hard — which a .max can only say this way, storing no
    # normals of its own.
    hard = tmp_path / "hard.max"
    hard.write_bytes(fb.build_max(groups=[1, 2, 4, 8, 16, 32]))
    result = _run(
        ["node", str(WEB / "test" / "smoothing.js"),
         str(ROOT / "samples" / "cube_binary.fbx"),
         str(ROOT / "samples" / "scene_parts.fbx"), str(hard)],
        env=_node_env(), timeout=300)
    print(result.stdout)
    assert result.returncode == 0, f"{result.stdout}\n{result.stderr}"
    assert "all checks passed" in result.stdout


@needs_clang
@needs_node
def test_parts_explode_and_pick(built):
    """Taking the scene apart, and clicking a part out of it.

    The three-part sample is three cubes that touch, so "detached" is
    measurable: a line of picks across the model crosses one stretch of model
    when the scene is whole and separate stretches once it is pulled apart.
    """
    try:
        probe = _run(["node", "-e", "require('playwright')"], env=_node_env())
        if probe.returncode != 0:
            pytest.skip("playwright is not installed for node")
    except OSError:  # pragma: no cover
        pytest.skip("node is unavailable")

    result = _run(
        ["node", str(WEB / "test" / "parts.js"),
         str(ROOT / "samples" / "scene_parts.fbx"),
         str(ROOT / "samples" / "cube_binary.fbx")],
        env=_node_env(), timeout=600)
    print(result.stdout)
    assert result.returncode == 0, f"{result.stdout}\n{result.stderr}"
    assert "all checks passed" in result.stdout
    assert "1 run(s) together, 2 apart" in result.stdout


@needs_clang
@needs_node
def test_parts_delete_and_split(built):
    """Taking a part out of a scene, and cutting one into its pieces.

    Nothing is allowed to go missing on the way: a delete takes exactly its own
    triangles out of the screen, the report and the export, a split moves none
    at all, and undo puts the count back where it started.
    """
    try:
        probe = _run(["node", "-e", "require('playwright')"], env=_node_env())
        if probe.returncode != 0:
            pytest.skip("playwright is not installed for node")
    except OSError:  # pragma: no cover
        pytest.skip("node is unavailable")

    result = _run(
        ["node", str(WEB / "test" / "edits.js"),
         str(ROOT / "samples" / "scene_parts.fbx"),
         str(ROOT / "samples" / "Shelby.fbx")],
        env=_node_env(), timeout=900)
    print(result.stdout)
    assert result.returncode == 0, f"{result.stdout}\n{result.stderr}"
    assert "all checks passed" in result.stdout
    # A wheel saved as one mesh really is many loose pieces, and the split
    # keeps every triangle of it. Node groups digits in whatever the machine's
    # locale asks for, which need not be a plain space.
    grouped = result.stdout.replace(" ", " ").replace(" ", " ")
    assert "122 112 of 122 112" in grouped


@needs_clang
@needs_node
def test_ground_and_shadows(built):
    """The model stands on a floor and drops a shadow onto it."""
    try:
        probe = _run(["node", "-e", "require('playwright')"], env=_node_env())
        if probe.returncode != 0:
            pytest.skip("playwright is not installed for node")
    except OSError:  # pragma: no cover
        pytest.skip("node is unavailable")

    scene = ROOT / "samples" / "scene_parts.fbx"
    result = _run(["node", str(WEB / "test" / "ground.js"), str(scene)], env=_node_env(), timeout=300)
    print(result.stdout)
    assert result.returncode == 0, f"{result.stdout}\n{result.stderr}"
    assert "all checks passed" in result.stdout


@needs_clang
@needs_node
def test_materials_can_be_assigned(built, tmp_path):
    """Group the palette, edit a material, save it and get it back.

    A saved assignment has to survive arriving with the model, or before it,
    and not only after it: opening a file starts from whatever was remembered
    for it, which is the one thing that can throw a dropped assignment away.
    The .glb is there because that is the file people drag in as a pair.
    """
    try:
        probe = _run(["node", "-e", "require('playwright')"], env=_node_env())
        if probe.returncode != 0:
            pytest.skip("playwright is not installed for node")
    except OSError:  # pragma: no cover
        pytest.skip("node is unavailable")

    import fbxbuild as fb

    scene = ROOT / "samples" / "scene_parts.fbx"
    glb = tmp_path / "fixture.glb"
    glb.write_bytes(fb.build_glb())
    # A material whose metalness is in a map rather than in its factor, which
    # is what a tyre out of Sketchfab is.
    finish = tmp_path / "finish.glb"
    finish.write_bytes(fb.build_finish_glb())
    result = _run(["node", str(WEB / "test" / "materials.js"), str(scene), str(glb),
                   str(finish)], env=_node_env(), timeout=300)
    print(result.stdout)
    assert result.returncode == 0, f"{result.stdout}\n{result.stderr}"
    assert "all checks passed" in result.stdout


@needs_clang
@needs_node
def test_transparency_is_drawn(built, tmp_path):
    """A solid core inside a see-through shell has to stay visible."""
    try:
        probe = _run(["node", "-e", "require('playwright')"], env=_node_env())
        if probe.returncode != 0:
            pytest.skip("playwright is not installed for node")
    except OSError:  # pragma: no cover
        pytest.skip("node is unavailable")

    import fbxbuild as fb

    glass = tmp_path / "glass.fbx"
    glass.write_bytes(fb.build_glass())
    result = _run(["node", str(WEB / "test" / "transparency.js"), str(glass)], env=_node_env(), timeout=300)
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

    # A texture bound the way an exporter with its own renderer writes it:
    # a vendor property name, and the image two links down the chain.
    vendor = Path(tempfile.mkdtemp()) / "vendor.fbx"
    vendor.write_bytes(fb.build_vendor_textured())
    samples.append(f"{vendor}+{ROOT / 'samples' / 'checker.png'}")

    # The same, spelled the way V-Ray and Corona spell it — which is most of
    # what leaves 3ds Max, and which used to bind no texture at all.
    underscored = Path(tempfile.mkdtemp()) / "vendor_underscored.fbx"
    underscored.write_bytes(fb.build_vendor_textured(
        property_name=fb.VENDOR_PROPERTY_UNDERSCORED))
    samples.append(f"{underscored}+{ROOT / 'samples' / 'checker.png'}")

    # A file in the 6.x layout: named objects, mesh on the model, scalar runs.
    legacy = Path(tempfile.mkdtemp()) / "legacy.fbx"
    legacy.write_bytes(fb.build_legacy())
    samples.append(str(legacy))

    # A see-through material, drawn in a second blended pass.
    glass = Path(tempfile.mkdtemp()) / "glass.fbx"
    glass.write_bytes(fb.build_glass())
    samples.append(str(glass))

    for real in (real_sample(), real_scene()):
        if real:
            samples.append(real)

    result = _run(["node", str(WEB / "test" / "browser.js"), *samples], env=_node_env(), timeout=300)
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
        probe = _run(["node", "-e", "require('playwright')"], env=_node_env())
        if probe.returncode != 0:
            pytest.skip("playwright is not installed for node")
    except OSError:  # pragma: no cover
        pytest.skip("node is unavailable")

    import fbxbuild as fb

    scene = tmp_path / "parts.fbx"
    scene.write_bytes(fb.build_scene())
    result = _run(["node", str(WEB / "test" / "browser.js"), str(scene)], env=_node_env(), timeout=300)
    print(result.stdout)
    assert result.returncode == 0, f"{result.stdout}\n{result.stderr}"

    size = " × ".join(f"{v:.1f}" for v in fb.SCENE_SIZE)
    assert f"{fb.SCENE_PARTS} parts" in result.stdout
    assert f"{fb.SCENE_TRIANGLES} triangles" in result.stdout
    assert f"{size} units" in result.stdout, f"expected a {size} scene"
    # One palette entry per part, all coloured by the Definitions template.
    assert f"{fb.SCENE_PARTS} material colours" in result.stdout
