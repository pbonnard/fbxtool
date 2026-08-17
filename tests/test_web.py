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


# ------------------------------------------ the DirectDraw Surface decoder


def _decode_dds(tmp_path, data: bytes) -> dict:
    """Run the page's own ``dds.js`` over some bytes, under Node."""
    source = tmp_path / "image.dds"
    source.write_bytes(data)
    script = (
        "const fs=require('fs');"
        f"const D=require({str(WEB / 'app' / 'dds.js')!r});"
        f"const b=new Uint8Array(fs.readFileSync({str(source)!r}));"
        "const image=D.decode(b);"
        "console.log(JSON.stringify(image ? "
        "{width:image.width,height:image.height,rgba:Array.from(image.rgba)} : null));"
    )
    result = _run(["node", "-e", script])
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


@needs_node
def test_a_block_compressed_surface_is_decoded_to_its_corners(tmp_path):
    """BC1 stores a 4x4 tile as two endpoint colours and sixteen selectors, and
    the two in between are a third and two thirds of the way along.

    Assetto Corsa keeps almost every texture in a `.dds` — 111 of the 135 in
    one car — and no browser will make an image of one, so without this a
    `.kn5` opens as a grey model with its paint and its badges missing.
    """
    import fbxbuild as fb

    image = _decode_dds(tmp_path, fb.dds_bc1())
    assert image is not None, "the decoder would not claim it"
    assert (image["width"], image["height"]) == (4, 4)
    assert image["rgba"][0:4] == [255, 0, 0, 255], "the first endpoint"
    assert image["rgba"][4:8] == [0, 0, 255, 255], "the second"
    assert image["rgba"][8:12] == [170, 0, 85, 255], "two thirds of the way"
    assert image["rgba"][12:16] == [85, 0, 170, 255], "one third"


@needs_node
def test_the_alpha_of_a_bc3_tile_is_interpolated_the_way_it_was_written(tmp_path):
    """BC3 puts eight bytes of alpha in front of the colour: two endpoints and
    sixteen three-bit selectors over six bytes, which is where a decoder that
    reads them as one 48-bit number goes wrong.

    Glass and a spinning wheel are both fully transparent textures in a car,
    so alpha read as zero is indistinguishable from alpha not read at all.
    """
    import fbxbuild as fb

    image = _decode_dds(tmp_path, fb.dds_bc3(alpha=(255, 0)))
    assert image is not None
    got = image["rgba"][3::4][:8]
    assert got == [255, 0, 218, 182, 145, 109, 72, 36]


@needs_node
def test_an_uncompressed_surface_is_read_by_its_channel_masks(tmp_path):
    """A mask says which bits of a pixel are which channel, so B8G8R8A8 needs
    no entry in a table of layouts — and neither does anything else."""
    import fbxbuild as fb

    image = _decode_dds(tmp_path, fb.dds_bgra(2, 1, bytes([10, 20, 30, 40,
                                                           200, 150, 100, 255])))
    assert image is not None
    assert image["rgba"] == [30, 20, 10, 40, 100, 150, 200, 255]


@needs_node
def test_a_greyscale_surface_comes_out_grey_rather_than_red(tmp_path):
    """One channel is the picture, not the red of a picture missing two."""
    import fbxbuild as fb

    image = _decode_dds(tmp_path, fb.dds_luminance(3, 1, bytes([10, 128, 250])))
    assert image is not None
    assert image["rgba"] == [10, 10, 10, 255, 128, 128, 128, 255, 250, 250, 250, 255]


@needs_node
@pytest.mark.parametrize("mangle,why", [
    (lambda d: b"DDX " + d[4:], "not a DDS at all"),
    (lambda d: d[:84] + b"BC7 " + d[88:], "a block format this does not decode"),
    (lambda d: d[:100], "cut off before the pixels"),
], ids=["not-dds", "bc7", "truncated"])
def test_a_surface_it_will_not_claim_comes_back_as_nothing(tmp_path, mangle, why):
    """A texture nobody can tell is wrong is one nobody fixes."""
    import fbxbuild as fb

    assert _decode_dds(tmp_path, mangle(fb.dds_bc1())) is None, why


# ------------------------------------------ the paint beside a car


def _skins(expression: str):
    """Evaluate an expression against the page's own ``skins.js``, under Node."""
    script = (
        f"const S=require({str(WEB / 'app' / 'skins.js')!r});"
        f"console.log(JSON.stringify({expression}));"
    )
    result = _run(["node", "-e", script])
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


@needs_node
@pytest.mark.parametrize("value,expected,why", [
    ("#FF1A2025", "#1a2025", "Content Manager writes ARGB, alpha first"),
    ("#1A2025", "#1a2025", "and six characters are already what a picker wants"),
    ("#abc", "#aabbcc", "three are shorthand for six"),
    ("nonsense", None, "and anything else is not a colour"),
], ids=["argb", "rgb", "short", "junk"])
def test_a_skins_colour_is_read_without_its_alpha(value, expected, why):
    """Taking the first six characters of `#FF1A2025` paints the car with its
    own opacity: `#FF1A20` is a red, and the colour is a near-black blue."""
    assert _skins(f"S.rgbHex({value!r})") == (expected.lower() if expected else None), why


@needs_node
def test_which_material_a_skin_calls_the_paint():
    """One key in the skin's own `ext_config.ini`, sometimes a list and
    sometimes repeated, in a file otherwise full of things that live inside
    Custom Shaders Patch rather than beside the car."""
    config = """\
[INCLUDE: common/materials_carpaint.ini]
CarPaintMaterial =booody_aooo
DisableDev = 1
[Material_CarPaint_Metallic]
CarPaintMaterial = carpaint, carpaint2  ; two of them
CarPaintMaterial=booody_aooo
"""
    assert _skins(f"S.paintMaterials({config!r})") == [
        "booody_aooo", "carpaint", "carpaint2"]
    assert _skins("S.paintMaterials('nothing here')") == []


@needs_node
def test_what_content_manager_says_the_paint_is():
    meta = ('{"carPaint":{"color":"#FF1A2025","enabled":true,"gloss":0.178,'
            '"reflection":0.767},"carpet":{"enabled":true}}')
    assert _skins(f"S.paintColour({meta!r})") == {
        "hex": "#1a2025", "enabled": True, "gloss": 0.178, "reflection": 0.767}
    # A skin that says its paint is off keeps the colour in its texture
    # instead, and putting the colour on as well paints it twice.
    off = '{"carPaint":{"color":"#FFFFFFFF","enabled":false}}'
    assert _skins(f"S.paintColour({off!r})")["enabled"] is False
    assert _skins("S.paintColour('not json')") is None
    assert _skins("S.paintColour('{}')") is None


@needs_node
def test_what_a_car_calls_its_paint_is_settled_across_its_own_skins():
    """Three places say which material is the paint, in the order they are
    trusted: the skin's own config, the car's, and last what the car's
    *other* skins agree it is.

    That last is a reading of the folder rather than of one file, and it is
    what a folder of skins usually needs: an Audi S8 has thirteen, of which
    three name a material it has and five name `carpaint`, which it has not —
    configs copied from another car, colour and all. Left there, those five
    state a perfectly good colour and put it nowhere.
    """
    skins = [
        {"name": "knows", "named": ["booody_aooo"],
         "colours": [{"hex": "#111111", "enabled": True}]},
        {"name": "copied", "named": ["carpaint"],
         "colours": [{"hex": "#222222", "enabled": True}]},
        {"name": "silent", "named": [],
         "colours": [{"hex": "#333333", "enabled": True}]},
        {"name": "colourless", "named": ["carpaint"], "colours": []},
    ]
    settled = _skins(
        f"S.settle({json.dumps(skins)}, "
        f"{{materials: new Set(['booody_aooo']), fallback: []}})")
    assert [(s["name"], s["paints"]) for s in settled] == [
        ("knows", [{"material": "booody_aooo", "hex": "#111111"}]),
        ("copied", [{"material": "booody_aooo", "hex": "#222222"}]),
        ("silent", [{"material": "booody_aooo", "hex": "#333333"}]),
        ("colourless", []),
    ]


@needs_node
def test_a_colour_a_skin_states_in_its_own_config():
    """Half of them have no `cm_skin.json` at all. A chameleon paint states
    two colours in the config instead — one facing you and one at a grazing
    angle, each with an opacity after it and a comment after that.

    Only the first is taken: there is one albedo here, and A is what the car
    looks like from where you are standing. A Clio V6's Illiad Blue is
    `#33007f` turning to yellow at the edges, and read without it the car is
    white.
    """
    config = """\
[INCLUDE]
CarPaintMaterial = wccarbody, aleron
[Material_CarPaint_Chameleon]
Skins=Illiad_Blue
ChameleonColorA=#33007f, 0.50    ;first color and opacity
ChameleonColorB=#ffff00, 0.25    ;second color and opacity
"""
    assert _skins(f"S.configColours({config!r}, 'Illiad_Blue')") == [
        {"key": "chameleoncolora", "hex": "#33007f", "enabled": True,
         "gloss": None, "reflection": None}]
    # A section that names the skins it is for is only for those: one
    # folder's config can carry a block written for another.
    assert _skins(f"S.configColours({config!r}, 'Mars_Red')") == []
    # And a colour outside a paint section is not the paint.
    stray = "[Material_Glass]" + chr(10) + "ChameleonColorA=#33007f"
    assert _skins(f"S.configColours({stray!r}, 'any')") == []


@needs_node
def test_the_colour_of_the_paint_chip_a_skin_carries():
    """`livery.png` is the swatch Content Manager shows beside a skin's name —
    a rounded square of the paint with a gloss sweeping over it — and every one
    of the 189 skins to hand has one. It is a picture rather than a statement,
    so it is read last and only where nothing was stated; but read, it is
    exact. A Champagne Quartz chip is 1874 pixels of #565D6B and its
    `cm_skin.json` says #565D6B.

    Two things make a plain average the wrong reading. The gloss is a wide
    bright sweep, and under some of them is a band of dark reflection: a
    Renault 5's Blanc Perle chip is white over black, and averaged it is a
    mid-grey nobody painted.
    """
    # Eight rows of a chip: paint over the reflection under it, one corner
    # taken by a highlight and one by the rounding, which is transparent.
    build = """
      const paint = [0x56, 0x5d, 0x6b];
      const px = new Uint8ClampedArray(8 * 8 * 4);
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
        const at = (y * 8 + x) * 4;
        const rgb = y < 4 ? paint : [10, 10, 10];
        px[at] = rgb[0]; px[at + 1] = rgb[1]; px[at + 2] = rgb[2]; px[at + 3] = 255;
      }
      px[0] = 255; px[1] = 255; px[2] = 255;
      px[7 * 4 + 3] = 0;
    """
    assert _skins(f"(() => {{{build} return S.chipColour(px, 8, 8); }})()") == "#565d6b"
    assert _skins("S.chipColour(new Uint8ClampedArray(4), 0, 0)") is None
    assert _skins("S.chipColour(new Uint8ClampedArray(4), 8, 8)") is None, \
        "fewer pixels than the size claims"
    assert _skins("S.chipColour(new Uint8ClampedArray(4 * 4), 2, 2)") is None, \
        "nothing solidly there is nothing to read"


@needs_node
def test_a_chip_does_not_argue_with_a_colour_the_skin_stated():
    """A picture is weaker evidence than a setting, and where both are there
    they disagree about a third of the time — usually because the setting is
    Content Manager's untouched white and the chip is the paint."""
    stated = {"name": "Nighthawk", "colours": [
        {"key": "carPaint", "hex": "#0c0c0c", "enabled": True}]}
    assert _skins(f"S.fromChip({json.dumps(stated)}, '#941a0a').colours"
                  )[0]["hex"] == "#0c0c0c"
    # One that switched its colour off stated none, which is where a chip
    # comes in: an Audi's Sakhir Orange says #FFFFFF and turns it off.
    off = {"name": "Sakhir", "colours": [
        {"key": "carPaint", "hex": "#ffffff", "enabled": False}]}
    assert _skins(f"S.fromChip({json.dumps(off)}, '#941a0a').colours") == [
        {"key": "livery", "hex": "#941a0a", "enabled": True,
         "gloss": None, "reflection": None}]
    # And an unreadable chip states nothing rather than something.
    assert _skins(f"S.fromChip({json.dumps(off)}, null).colours") == off["colours"]


@needs_node
@pytest.mark.parametrize("path,expected", [
    ("faz_audi_s8_plus/skins/Alpine_White/leather_1.dds", "Alpine_White"),
    ("skins/black/cm_skin.json", "black"),
    (r"faz_audi_s8_plus\skins\Nighthawk\Plate_D.dds", "Nighthawk"),
    ("faz_audi_s8_plus/texture/body.dds", None),
    ("skins/black/deeper/still.dds", None),
], ids=["nested", "bare", "backslashes", "outside", "too-deep"])
def test_which_skin_a_file_came_from(path, expected):
    """Every skin holds a `leather_1.dds`; the folder is the only thing that
    tells them apart."""
    assert _skins(f"S.skinOf({path!r})") == expected


@needs_clang
@needs_node
def test_the_grain_a_surface_is_tiled_over_with(built, tmp_path):
    """A car's interior is one atlas of flat panels with the leather, the
    carpet and the carbon laid over them, tiled sixty or a hundred times
    across. An Audi S8 has thirty-eight materials wearing one, and nine of the
    fifteen files in each of its skins go there — so without it a skin changes
    the badge and the number plate and leaves the cabin as it was.

    What the file does not say is how much of the grain to mix in, and the two
    readings are far apart: multiplied straight, a Mercedes E63's paint — whose
    grain averages 0.24 — turns a white car graphite. So each is taken as
    neutral at its own average, in linear light.
    """
    try:
        probe = _run(["node", "-e", "require('playwright')"], env=_node_env())
        if probe.returncode != 0:
            pytest.skip("playwright is not installed for node")
    except OSError:  # pragma: no cover
        pytest.skip("node is unavailable")

    import fbxbuild as fb

    grey = fb.dds_bgra(4, 4, bytes([128, 128, 128, 255]) * 16)
    # A grain dark and light in equal measure, so its own average is the middle
    # of it and only the green shows.
    green = fb.dds_bgra(4, 4, (bytes([0, 60, 0, 255]) * 8) + (bytes([0, 200, 0, 255]) * 8))
    identity = (1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0,
                0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0)
    vertices, indices = fb.kn5_cube(1.0)
    files = []
    for name, slots, textures in (
        ("plain", (("txDiffuse", 0, "grey.dds"),), [("grey.dds", grey)]),
        ("grained", (("txDiffuse", 0, "grey.dds"), ("txDetail", 3, "green.dds")),
         [("grey.dds", grey), ("green.dds", green)]),
    ):
        material = fb.kn5_material(
            "panel", "ksPerPixelMultiMap",
            properties=(fb.kn5_property("fresnelC", 0.05)
                        + fb.kn5_property("useDetail", 1.0)
                        + fb.kn5_property("detailUVMultiplier", 1.0)),
            property_count=3, slots=slots)
        path = tmp_path / f"{name}.kn5"
        path.write_bytes(fb.build_kn5(
            6, textures=textures, materials=[material],
            tree=fb.kn5_dummy("car", identity,
                              fb.kn5_mesh("cube", vertices, indices), 1)))
        files.append(str(path))

    result = _run(["node", str(WEB / "test" / "detail.js"), *files],
                  env=_node_env(), timeout=300)
    print(result.stdout)
    assert result.returncode == 0, f"{result.stdout}" + chr(10) + f"{result.stderr}"
    assert "all checks passed" in result.stdout


@needs_clang
@needs_node
def test_a_car_wears_the_skin_it_is_given(built, tmp_path):
    """A `.kn5` holds the car unpainted: everything under `skins/<name>/`
    beside it replaces the texture of that name, and the skin's own two
    settings files say what colour the paint is and which material it goes on.

    Read without any of that an Audi S8 comes up white from end to end and
    looks like something has gone wrong. It has not — it is a car nobody has
    painted yet.
    """
    try:
        probe = _run(["node", "-e", "require('playwright')"], env=_node_env())
        if probe.returncode != 0:
            pytest.skip("playwright is not installed for node")
    except OSError:  # pragma: no cover
        pytest.skip("node is unavailable")

    import fbxbuild as fb

    car = tmp_path / "car"
    (car / "extension").mkdir(parents=True)
    for name in ("Red", "Stranger", "Pair", "Bare", "Chip"):
        (car / "skins" / name).mkdir(parents=True)
    # A paint map is the panels in white, because the colour is what the game
    # multiplies through it.
    white = fb.dds_bgra(4, 4, bytes([255, 255, 255, 255]) * 16)
    materials = [
        fb.kn5_material(name, "ksPerPixelMultiMap",
                        properties=fb.kn5_property("fresnelC", 0.05),
                        property_count=1,
                        slots=(("txDiffuse", 0, "paint.dds"),))
        for name in ("carpaint", "trim")
    ]
    # And one that takes almost none of the light, which is what an Audi's
    # wheels are: the same white map under it, and black on the screen.
    materials.append(fb.kn5_material(
        "sill", "ksPerPixelMultiMap",
        properties=(fb.kn5_property("fresnelC", 0.05)
                    + fb.kn5_property("ksAmbient", 0.03)
                    + fb.kn5_property("ksDiffuse", 0.01)),
        property_count=3, slots=(("txDiffuse", 0, "paint.dds"),)))
    identity = (1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0,
                0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0)
    vertices, indices = fb.kn5_cube(1.0)
    small, small_indices = fb.kn5_cube(0.2)
    tree = fb.kn5_dummy(
        "car", identity,
        fb.kn5_mesh("body", vertices, indices, material=0)
        + fb.kn5_mesh("bumper", small, small_indices, material=1)
        + fb.kn5_mesh("sill", small, small_indices, material=2), 3)
    (car / "car.kn5").write_bytes(fb.build_kn5(
        6, textures=[("paint.dds", white)], materials=materials, tree=tree))

    # Half of them declare which material is the paint once for the whole car
    # rather than once per skin, and in the other spelling.
    (car / "extension" / "ext_config.ini").write_text(
        "[Material_CarPaint_Metallic]" + chr(10)
        + "Materials = carpaint" + chr(10)
        + "[Material_CarPaint_Metallic]" + chr(10)
        + "Materials = trim" + chr(10), encoding="utf-8")

    for name, names_it, meta in (
        ("Red", "carpaint", '{"carPaint": {"color": "#FFDD2010"}}'),
        ("Stranger", "some_other_car", '{"carPaint": {"color": "#FFDD2010"}}'),
        # No config of its own, two colours under the names half of them use.
        ("Pair", None,
         '{"extBody1": {"color": "#FF2010DD"}, "extBody2": {"color": "#FF10DD20"}}'),
        # And one that states no colour anywhere at all.
        ("Bare", "carpaint", '{"carPaint": {"enabled": true}}'),
        # Nor does this one, but it carries a picture of the paint, which is
        # the only thing left saying what colour it is.
        ("Chip", "carpaint", '{"carPaint": {"color": "#FFFFFFFF", "enabled": false}}'),
    ):
        skin = car / "skins" / name
        (skin / "paint.dds").write_bytes(white)
        if names_it:
            (skin / "ext_config.ini").write_text(
                "CarPaintMaterial = " + names_it + chr(10), encoding="utf-8")
        (skin / "cm_skin.json").write_text(meta, encoding="utf-8")
    # A chip: the paint over the band of dark reflection under it.
    (car / "skins" / "Chip" / "livery.png").write_bytes(fb.livery_png(
        [[(0x20, 0x10, 0xdd)] * 8] * 4 + [[(10, 10, 10)] * 8] * 4))

    # A second car, with nothing beside it, to open over the top of the first.
    other = tmp_path / "other.kn5"
    other.write_bytes(fb.build_kn5(
        6, textures=[("paint.dds", white)], materials=[materials[0]],
        tree=fb.kn5_dummy("car", identity,
                          fb.kn5_mesh("body", vertices, indices), 1)))

    result = _run(["node", str(WEB / "test" / "skin.js"), str(car), str(other)],
                  env=_node_env(), timeout=300)
    print(result.stdout)
    assert result.returncode == 0, f"{result.stdout}" + chr(10) + f"{result.stderr}"
    assert "all checks passed" in result.stdout


# ----------------------------------------- the Assetto Corsa reader

def _rounded(value, places: int = 9):
    """The same structure with every number rounded, for comparing readers.

    Both read the file's own 32-bit floats, so the values are the same to the
    bit; what differs in the last place is the arithmetic on top of them —
    ``Math.hypot`` against a square root of a sum of squares — and rounding is
    what lets those be held equal without letting a real difference through.
    """
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return round(float(value), places)
    if isinstance(value, dict):
        return {key: _rounded(v, places) for key, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_rounded(v, places) for v in value]
    return value


def _kn5_dump(path: str) -> dict:
    """Run the page's own ``kn5.js`` over a file, under Node."""
    result = _run(["node", str(WEB / "test" / "kn5.js"), path], env=_node_env())
    assert result.returncode == 0, f"{result.stdout}\n{result.stderr}"
    return json.loads(result.stdout)


def _kn5_python(path: str) -> dict:
    """The same facts, read by the Python reader, in the same shape."""
    doc = read_fbx(path, load_arrays=True)
    objects = doc.root.path("Objects")

    def plain(entry):
        return str(entry.value(1)).split("\x00")[0]

    def properties(entry):
        block = entry.get("Properties70")
        out = {}
        for prop in (block.children if block else []):
            values = [p.value for p in prop.props][4:]
            out[prop.props[0].value] = values[0] if len(values) == 1 else values
        return out

    def arrays(entry, name=None):
        out = {}
        for prop in entry.props:
            if prop.array is not None:
                out[name or entry.name] = {"length": prop.array.length}
        for child in entry.children:
            out.update(arrays(child, child.name))
        return out

    def head(entry, name):
        found = entry.get(name) if entry is not None else None
        return list(found.props[0].value)[:12] if found is not None else None

    first = next((o for o in objects.children if o.name == "Geometry"), None)
    counts: dict[str, int] = {}
    for entry in objects.children:
        counts[entry.name] = counts.get(entry.name, 0) + 1
    return {
        "format": doc.format,
        "encoding": doc.encoding,
        "counts": counts,
        "connections": len(doc.root.path("Connections").children),
        "materials": [{"name": plain(m), "props": properties(m)}
                      for m in objects.get_all("Material")],
        "models": [{"name": plain(m), "subclass": m.value(2),
                    "props": properties(m)} for m in objects.get_all("Model")],
        "links": [[p.value for p in c.props]
                  for c in doc.root.path("Connections").children],
        "firstGeometry": first and {
            "name": plain(first),
            "arrays": arrays(first),
            "vertices": head(first, "Vertices"),
            "polygons": head(first, "PolygonVertexIndex"),
            "normals": head(first.get("LayerElementNormal"), "Normals"),
            "uv": head(first.get("LayerElementUV"), "UV"),
        },
    }


def _sample_kn5(tmp_path) -> str:
    """A small car with a texture, three materials and a placed wheel."""
    import fbxbuild as fb

    triangle = [
        ((0.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0), (1.0, 0.0, 0.0)),
        ((1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (1.0, 0.25), (1.0, 0.0, 0.0)),
        ((0.0, 0.0, 1.0), (0.0, 1.0, 0.0), (0.0, 1.0), (1.0, 0.0, 0.0)),
    ]
    identity = (1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0,
                0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0)
    # A wheel turned round, which is how the right-hand side of a car is built
    # and where a decomposition that mistakes a half turn for a mirror shows.
    turned = (-1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0,
              0.0, 0.0, -1.0, 0.0, 0.8, 0.36, 1.41, 1.0)
    materials = [
        fb.kn5_material("body", "ksPerPixelMultiMap",
                        properties=(fb.kn5_property("ksDiffuse", 0.4)
                                    + fb.kn5_property("ksSpecularEXP", 200.0)
                                    + fb.kn5_property("fresnelC", 0.04)),
                        property_count=3,
                        slots=(("txDiffuse", 0, "paint.dds"),
                               ("txNormal", 1, "body_n.dds"))),
        fb.kn5_material("glass", "ksPerPixelReflection", blend=1,
                        properties=fb.kn5_property("fresnelC", 0.0),
                        property_count=1,
                        slots=(("txDiffuse", 0, "paint.dds"),)),
        fb.kn5_material("grille", "ksPerPixelAT", alpha_tested=True,
                        properties=fb.kn5_property("ksAlphaRef", 0.4),
                        property_count=1),
    ]
    mesh = fb.kn5_mesh("tyre", triangle, [0, 1, 2, 2, 1, 0], material=1)
    tree = fb.kn5_dummy("car", identity,
                        fb.kn5_dummy("WHEEL_RF", turned, mesh, 1), 1)
    path = tmp_path / "car.kn5"
    path.write_bytes(fb.build_kn5(6, textures=[("paint.dds", fb.dds_bc1())],
                                  materials=materials, tree=tree))
    return str(path)


@needs_node
def test_the_page_reads_a_kn5_exactly_as_python_does(tmp_path):
    """A `.kn5` has no offsets and no lengths above the record level, so the
    two readers cannot disagree quietly: a field mis-sized in one of them walks
    off the rest of the file and produces a different car, not an error.
    """
    path = _sample_kn5(tmp_path)
    page = _kn5_dump(path)
    python = _kn5_python(path)
    for key in ("format", "encoding", "counts", "connections", "links",
                "models", "materials", "firstGeometry"):
        assert _rounded(page[key]) == _rounded(python[key]), f"{key} differs"
    assert page["extra"]["kn5Version"] == 6
    assert page["extra"]["missingTextures"] == ["body_n.dds"]


@needs_clang
@needs_node
def test_geometry_the_file_switched_off_is_not_drawn(built, tmp_path):
    """A car ships with its own spares — a shattered windscreen behind the
    clear one, a blurred disc inside each wheel — every one switched off until
    the game wants it.  Drawn anyway, the Mercedes comes out with cracked glass
    in every window and two cockpits.
    """
    try:
        probe = _run(["node", "-e", "require('playwright')"], env=_node_env())
        if probe.returncode != 0:
            pytest.skip("playwright is not installed for node")
    except OSError:  # pragma: no cover
        pytest.skip("node is unavailable")

    import fbxbuild as fb

    triangle = [
        ((0.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0), (1.0, 0.0, 0.0)),
        ((1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (1.0, 0.0), (1.0, 0.0, 0.0)),
        ((0.0, 0.0, 1.0), (0.0, 1.0, 0.0), (0.0, 1.0), (1.0, 0.0, 0.0)),
    ]
    identity = (1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0,
                0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0)
    drawn = fb.kn5_mesh("drawn", triangle, [0, 1, 2])
    invisible = fb.kn5_mesh("cracked", triangle, [0, 1, 2], visible=False)
    # Switched off a node up, which is how the blurred wheels are switched off.
    under_an_off_node = fb.kn5_dummy(
        "RIM_BLUR_LF", identity, fb.kn5_mesh("blur", triangle, [0, 1, 2]), 1,
        active=False)
    tree = fb.kn5_dummy("car", identity,
                        drawn + invisible + under_an_off_node, 3)
    path = tmp_path / "switched.kn5"
    path.write_bytes(fb.build_kn5(materials=[fb.kn5_material("paint")], tree=tree))

    result = _run(["node", str(WEB / "test" / "hidden.js"), str(path)],
                  env=_node_env(), timeout=300)
    print(result.stdout)
    assert result.returncode == 0, f"{result.stdout}\n{result.stderr}"
    assert "all checks passed" in result.stdout


@needs_clang
@needs_node
def test_a_texture_reaches_the_gpu_the_right_way_up_and_with_its_colour(built):
    """FBX texture space has V running upwards, so V=0 must sample the bottom
    of the picture — the viewer turns each image over on the way in rather than
    in the shader, so the UVs stay as the file wrote them.

    That turn is easy to lose without anything saying so. `UNPACK_FLIP_Y_WEBGL`
    is what a canvas or an ImageData upload obeys, and an `ImageBitmap` ignores
    it in silence. A model is a poor witness: a car's UV islands are scattered
    over the sheet, so a flip moves the paint about rather than turning the car
    over, and it reads as some other fault entirely — which is how it got past
    a suite that renders four cars and reads their pixels back.
    """
    try:
        probe = _run(["node", "-e", "require('playwright')"], env=_node_env())
        if probe.returncode != 0:
            pytest.skip("playwright is not installed for node")
    except OSError:  # pragma: no cover
        pytest.skip("node is unavailable")

    result = _run(["node", str(WEB / "test" / "texorient.js")],
                  env=_node_env(), timeout=300)
    print(result.stdout)
    assert result.returncode == 0, f"{result.stdout}\n{result.stderr}"
    assert "all checks passed" in result.stdout


@needs_clang
@needs_node
def test_transparency_that_lives_in_a_texture_rather_than_in_a_factor(built, tmp_path):
    """A racing game's cars state no opacity factor at all: a windscreen keeps
    its 26% in the alpha channel of the picture it wears, a badge keeps its
    outline there, and a tail lamp its tint.

    And a material that never asked for any of that must not be given it — the
    light housings on a Cullinan carry an ambient-occlusion map whose alpha is
    nothing at all, and read as coverage every lamp on the car disappears.

    And where the alpha is zero throughout, the colour still has to arrive.
    Multiplied by its own alpha on the way to the GPU — which is what a browser
    does by default, and all a 2D canvas can do — it does not: a Renault 5
    Turbo whose seats, carpet and dashboard are `.dds` files with an empty
    alpha channel comes out as a black car.
    """
    try:
        probe = _run(["node", "-e", "require('playwright')"], env=_node_env())
        if probe.returncode != 0:
            pytest.skip("playwright is not installed for node")
    except OSError:  # pragma: no cover
        pytest.skip("node is unavailable")

    import fbxbuild as fb

    files = []
    for name, kwargs in (
        ("blend", {"blend": 1}),
        ("mask", {"blend": 0, "alpha_tested": True, "cutoff": 0.5}),
        ("opaque", {"blend": 0}),
        # An alpha channel of nothing at all, which is what a `.dds` written
        # out of the game routinely carries beside a colour that matters.
        ("empty", {"blend": 0, "shell_alpha": 0}),
    ):
        path = tmp_path / f"{name}.kn5"
        path.write_bytes(fb.kn5_shell_and_core(**kwargs))
        files.append(str(path))

    result = _run(["node", str(WEB / "test" / "texalpha.js"), *files],
                  env=_node_env(), timeout=300)
    print(result.stdout)
    assert result.returncode == 0, f"{result.stdout}\n{result.stderr}"
    assert "all checks passed" in result.stdout


@needs_node
def test_the_page_reads_a_real_car_to_its_last_byte():
    """Set ``FBXTOOL_KN5`` to a car out of the game; none is checked in."""
    candidate = os.environ.get("FBXTOOL_KN5")
    if not candidate or not Path(candidate).is_file():
        pytest.skip("set FBXTOOL_KN5 to a real .kn5 file to run this test")
    page = _kn5_dump(candidate)
    doc = read_fbx(candidate)
    assert not any("past the end" in w for w in page["warnings"])
    assert page["extra"]["vertices"] == doc.extra["vertices"]
    assert page["extra"]["triangles"] == doc.extra["triangles"]
    assert page["extra"]["meshes"] == doc.extra["meshes"]
    assert page["extra"]["materials"] == doc.extra["materials"]
    assert page["connections"] == len(doc.root.path("Connections").children)


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
