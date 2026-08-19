"""Tests for the web version.

Three layers, each skipping cleanly when its toolchain is missing:

* the WebAssembly module builds from ``web/src/fbx.c``;
* the WASM reader, run under Node, produces exactly what the Python reader
  does for the same file;
* the built page loads in a real browser, parses a file and rasterises it.
"""

from __future__ import annotations

import io
import json
import os
import re
import shutil
import struct
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
def test_the_alpha_of_a_bc2_tile_survives_the_colour_written_over_it(tmp_path):
    """BC2's alpha is the eight bytes in front of the colour half, and the
    colour half writes an opaque fourth channel of its own — so decoded in
    file order the colour lands on top and every BC2 texture comes back
    solid.

    A Mercedes CLK's headlight glass is a 32-square BC2 at 27% alpha and its
    `highlights` map is a 1024-square of cut-out shapes; read that way round
    the lamps are lumps of plaster and the highlights a grey sheet.
    """
    import fbxbuild as fb

    image = _decode_dds(tmp_path, fb.dds_bc2(alphas=(0, 1, 8, 15) + (4,) * 12))
    assert image is not None
    assert image["rgba"][3::4][:4] == [0, 17, 136, 255]


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


@needs_node
def test_a_bc7_tile_is_decoded_against_a_decoder_that_owes_us_nothing(tmp_path):
    """BC7 is the last of the block formats and the only one with modes: eight
    of them, each cutting a 4x4 tile up differently and spending its 128 bits
    differently.

    It is what a modern car is saved in. Sixteen textures across five of the
    cars to hand are BC7 and every one is bound to a material — a BMW Z3M's
    `dirty-glass`, an Alfa TZ2's brake disc, a Donkervoort's gauges — so
    refused, each is a surface with no picture on it.

    Nothing about a wrong BC7 decoder announces itself: it produces a plausible
    picture with some of its tiles wrong. So each fixture is decoded here and
    by Pillow, which implements the same specification and shares no code with
    this. Written from memory, the partition table in this reader was right for
    the first eighteen entries and wrong for the other forty-six, and it took
    the second decoder to say so.
    """
    import fbxbuild as fb
    from PIL import Image

    def both(data):
        ours = _decode_dds(tmp_path, data)
        picture = Image.open(io.BytesIO(data))
        picture.load()
        theirs = list(picture.convert("RGBA").tobytes())
        return ours, theirs

    # Mode 6: one pair of endpoints and four-bit indices, which is what most of
    # a photograph comes out as.
    ours, theirs = both(fb.bc7_mode6(low=(10, 20, 30, 0), high=(200, 150, 100, 255),
                                     indices=[0, 5, 10, 15] * 4))
    assert ours is not None, "the decoder would not claim it"
    assert (ours["width"], ours["height"]) == (4, 4)
    assert ours["rgba"] == theirs
    assert ours["rgba"][0:4] == [10, 20, 30, 0], "the low endpoint, alpha and all"
    assert ours["rgba"][12:16] == [200, 150, 100, 254], "and the high one"


@needs_node
@pytest.mark.parametrize("partition", [0, 1, 17, 18, 34, 47, 63],
                         ids=lambda p: f"partition{p}")
def test_which_subset_each_pixel_of_a_bc7_tile_belongs_to(tmp_path, partition):
    """The partition tables are the part of BC7 a reader cannot reason its way
    to: sixty-four arrangements of sixteen pixels into subsets, and sixty-four
    more into three.

    Every index is left at zero here, so each pixel comes out its own subset's
    first endpoint and what is drawn is the partition itself, in two colours.
    A table wrong at one entry is a tile wrong wherever a file happens to use
    it — 18 onwards, in this reader's first draft.
    """
    import fbxbuild as fb
    from PIL import Image

    data = fb.bc7_mode1(partition)
    ours = _decode_dds(tmp_path, data)
    picture = Image.open(io.BytesIO(data))
    picture.load()
    assert ours is not None
    assert ours["rgba"] == list(picture.convert("RGBA").tobytes())
    # Two colours and no others, which is what an all-zero index set gives.
    seen = {tuple(ours["rgba"][at:at + 4]) for at in range(0, 64, 4)}
    assert len(seen) == 2, f"a two-subset partition draws in two colours: {seen}"


@needs_node
def test_a_surface_stating_its_layout_as_a_number(tmp_path):
    """A DX10 header names a DXGI format instead of writing masks and flags,
    so the file says `DDPF_FOURCC` and nothing else — and a reader deciding
    what to do from the flags refuses every one of them, however well it knows
    the layout underneath.

    B8G8R8X8 is the one that matters most, because the fourth byte is padding
    rather than an alpha. An Alfa A110's twenty-two are all zero there, so read
    as an alpha the car loses twenty-two of its sixty-three textures.
    """
    import fbxbuild as fb
    stored = bytes([10, 20, 30, 0, 40, 50, 60, 0, 70, 80, 90, 0, 100, 110, 120, 0])
    image = _decode_dds(tmp_path, fb.dds_bgrx(2, 2, stored))
    assert image is not None, "a DXGI number is a statement of layout like any other"
    assert (image["width"], image["height"]) == (2, 2)
    assert image["rgba"][0:8] == [30, 20, 10, 255, 60, 50, 40, 255], \
        "blue first in the file, and the padding read as solid"

    # And the same bytes called BGRA, where the fourth one is an alpha and is
    # nothing — which is a surface that is really there and really invisible.
    opaque = _decode_dds(tmp_path, fb.dds_bgrx(2, 2, stored, dxgi=87))
    assert opaque["rgba"][0:4] == [30, 20, 10, 0]


@needs_node
def test_a_dxgi_format_this_does_not_decode_is_refused(tmp_path):
    """BC6H is a floating-point surface and there is nothing to be gained by
    half-reading one. A texture nobody can tell is wrong is one nobody fixes."""
    import fbxbuild as fb
    assert _decode_dds(tmp_path, fb.dds_bgrx(4, 4, bytes(64), dxgi=95)) is None
    assert _decode_dds(tmp_path, fb.dds_bgrx(4, 4, bytes(64), dxgi=1234)) is None


@needs_node
def test_the_two_readers_agree_on_a_lamp_lens():
    """Both sides read the car's lighting, and a colour read one way and not
    the other is a lamp that is amber in the report and grey on the screen."""
    from fbxtool import kn5

    text = ("[REFRACTING_HEADLIGHT_...]" + chr(10)
            + "SURFACE = glass_fog, glass_fogb" + chr(10)
            + "GLASS_COLOR = 1, 0.80723137, 0.12472421" + chr(10)
            + "EXTRA_GLASS_COLORIZATION = 1" + chr(10) + chr(10)
            + "[REFRACTING_HEADLIGHT_...]" + chr(10)
            + "SURFACE = glass_platelight" + chr(10)
            + "GLASS_COLOR = 0.25,0.25,0.25" + chr(10)
            + "EXTRA_GLASS_COLORIZATION = 0" + chr(10))
    script = (
        f"const K=require({str(WEB / 'app' / 'kn5.js')!r});"
        f"console.log(JSON.stringify([...K.lensColours({json.dumps(text)})]));"
    )
    result = _run(["node", "-e", script])
    assert result.returncode == 0, result.stderr
    page = {name: [round(c, 6) for c in rgb] for name, rgb in json.loads(result.stdout)}

    here = {name: [round(int(hexed[at:at + 2], 16) / 255, 6) for at in (1, 3, 5)]
            for name, hexed in kn5._lens_colours(text).items()}
    assert set(page) == set(here) == {"glass_fog", "glass_fogb"}
    for name in page:
        # The page keeps the float the file wrote; this side goes through the
        # eight bits a colour is written with, so they meet within one step.
        assert page[name] == pytest.approx(here[name], abs=1 / 255)


# ------------------------------------------ writing a PNG back out


def _encode_png(tmp_path, pixels, width: int, height: int) -> bytes:
    """Run the page's own ``png.js`` over some pixels, under Node."""
    out = tmp_path / "written.png"
    script = (
        "const fs=require('fs');"
        f"const P=require({str(WEB / 'app' / 'png.js')!r});"
        f"const px=new Uint8ClampedArray({json.dumps(list(pixels))});"
        f"P.encode(px, {width}, {height}).then((bytes) => "
        f"fs.writeFileSync({str(out)!r}, Buffer.from(bytes)));"
    )
    result = _run(["node", "-e", script])
    assert result.returncode == 0, result.stderr
    return out.read_bytes()


@needs_node
def test_a_texel_that_is_not_there_keeps_its_colour_through_an_export(tmp_path):
    """The one thing a browser will not do for us.

    `canvas.toBlob` is the obvious way to make a PNG and it cannot be used for
    an export: a 2D canvas holds its pixels premultiplied, so a texel at zero
    alpha comes back black and the colour that was on it is gone — dividing it
    back out is a division by nothing. The viewer's upload path has avoided
    that for a while and the export was still going through a canvas, so a
    car's own textures left it as squares of black. A Renault 5 Turbo has
    twenty-four such among its forty-two, its rubber, carpet, brass and
    interior panels among them, each a picture that matters under an empty
    alpha: through a canvas its `rubber` exports as (0, 0, 0, 0) and written
    here as the (66, 66, 66, 0) the file holds.

    The reader that checks it is the one `.kn5` uses for a paint chip, so the
    two halves of this repository are held against each other.
    """
    from fbxtool import kn5

    pixels = []
    for y in range(3):
        for x in range(4):
            # Solid along the top row, and nothing at all below it.
            pixels += [200, 50, 25, 255 if y == 0 else 0]
    written = _encode_png(tmp_path, pixels, 4, 3)
    assert written[:8] == bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

    read = kn5._png_pixels(written)
    assert read is not None, "our own reader would not have it"
    got, width, height = read
    assert (width, height) == (4, 3)
    assert list(got) == pixels, "every texel as it went in, alpha and all"
    assert list(got[16:20]) == [200, 50, 25, 0], "the colour under an empty alpha"


@needs_node
def test_the_png_writer_says_when_it_cannot(tmp_path):
    """A caller told nothing can fall back; one handed a broken file cannot."""
    script = (
        f"const P=require({str(WEB / 'app' / 'png.js')!r});"
        "Promise.all(["
        "P.encode(new Uint8ClampedArray(4), 0, 0),"
        "P.encode(new Uint8ClampedArray(4), 8, 8),"
        "P.encode(null, 2, 2),"
        "]).then((r) => console.log(JSON.stringify(r.map((v) => v === null))));"
    )
    result = _run(["node", "-e", script])
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == [True, True, True],         "no size, too few pixels for the size claimed, and no pixels at all"


# ------------------------------------------ putting two files in one


def _write_zip(tmp_path, members):
    """Build an archive with the page's own ``zip.js``, under Node.

    The payloads go through files rather than through the command line, which
    a fifty-kilobyte member is far too long for.
    """
    out = tmp_path / "written.zip"
    listed = []
    for at, (name, data) in enumerate(members):
        source = tmp_path / f"member{at}"
        source.write_bytes(data)
        listed.append("{ name: %s, bytes: new Uint8Array(fs.readFileSync(%s)) }"
                      % (json.dumps(name), json.dumps(str(source))))
    script = (
        "const fs=require('fs');"
        f"global.FbxPng=require({str(WEB / 'app' / 'png.js')!r});"
        f"const Z=require({str(WEB / 'app' / 'zip.js')!r});"
        f"Z.write([{', '.join(listed)}]).then((bytes) => {{"
        f"fs.writeFileSync({str(out)!r}, Buffer.from(bytes));"
        "console.log(bytes.length); });"
    )
    result = _run(["node", "-e", script])
    assert result.returncode == 0, result.stderr
    return out


@needs_node
def test_two_files_handed_over_as_one(tmp_path):
    """A glTF written the readable way is two files — the JSON and the buffer
    it names — and a browser downloads one thing at a time. A pair means it
    stopping to ask whether you meant it, and then two files that have to stay
    together and are easy to part.

    What is written is checked by Python's own `zipfile`, which owes this
    nothing: `testzip` walks every member and holds it against the CRC stored
    beside it, so a length or an offset one byte out is caught rather than
    left to whatever opens the archive next.
    """
    import zipfile

    repeated = bytes(at % 7 for at in range(50000))
    archive = _write_zip(tmp_path, [
        ("scene.gltf", b'{"asset": {"version": "2.0"}}'),
        ("scene.bin", repeated),
        ("tiny.txt", b"x"),
    ])
    with zipfile.ZipFile(archive) as held:
        assert held.testzip() is None, "a member disagreed with its own checksum"
        assert held.namelist() == ["scene.gltf", "scene.bin", "tiny.txt"]
        assert held.read("scene.bin") == repeated
        assert held.read("tiny.txt") == b"x"
        assert json.loads(held.read("scene.gltf"))["asset"]["version"] == "2.0"

        # Deflated where that makes it smaller, and stored where it does not:
        # a file written larger than it was is a file nobody wanted zipped.
        big = held.getinfo("scene.bin")
        assert big.compress_type == zipfile.ZIP_DEFLATED
        assert big.compress_size < big.file_size // 10
        assert held.getinfo("tiny.txt").compress_type == zipfile.ZIP_STORED


@needs_node
def test_what_an_archive_stamps_its_members_with(tmp_path):
    """MS-DOS counted from 1980 in two-second steps, and a zip still does.

    A date before that cannot be written at all, so it is held at the floor
    rather than allowed to wrap round into the future.
    """
    script = (
        f"const Z=require({str(WEB / 'app' / 'zip.js')!r});"
        "const at = (y, m, d, h, mi, s) => Z.dosTime(new Date(y, m - 1, d, h, mi, s));"
        "console.log(JSON.stringify([at(2026, 8, 17, 14, 30, 44), at(1970, 6, 6, 1, 2, 3)]));"
    )
    result = _run(["node", "-e", script])
    assert result.returncode == 0, result.stderr
    now, ancient = json.loads(result.stdout)
    assert now["date"] == ((2026 - 1980) << 9) | (8 << 5) | 17
    assert now["time"] == (14 << 11) | (30 << 5) | 22, "seconds count in twos"
    assert ancient["date"] >> 9 == 0, "1970 is held at the year zip counts from"


# ------------------------------------------ writing an FBX back out


def _write_fbx(tmp_path, body: str):
    """Build a scene through the page's own ``fbxout.js`` and write it, under
    Node. Returns the document our own reader makes of what came out."""
    out = tmp_path / "written.fbx"
    script = (
        "const fs=require('fs');"
        f"global.FbxGltf=require({str(WEB / 'app' / 'gltf.js')!r});"
        f"const O=require({str(WEB / 'app' / 'fbxout.js')!r});"
        + body
        + "O.serialise(built.tree).then((bytes) => {"
        f"fs.writeFileSync({str(out)!r}, Buffer.from(bytes));"
        "console.log(JSON.stringify(built.stats)); });"
    )
    result = _run(["node", "-e", script])
    assert result.returncode == 0, result.stderr
    from fbxtool import read_fbx

    return json.loads(result.stdout), read_fbx(str(out), load_arrays=True)


#: One triangle wearing one material with one picture, placed away from the
#: origin — enough for every kind of record the writer emits.
_ONE_TRIANGLE = """
  const mesh = { triangleCount: 1, hasUv: true,
    positions: Float32Array.from([0,0,0, 1,0,0, 0,1,0]),
    normals: Float32Array.from([0,0,1, 0,0,1, 0,0,1]),
    uvs: Float32Array.from([0,0, 1,0, 0,1]),
    materials: Float32Array.from([0,0,0]) };
  const palette = [{ name: 'paint', colour: [0.8,0.1,0.1], specular: [0.04,0.04,0.04],
    roughness: 0.4, metallic: 0, opacity: 1, emissive: [0,0,0] }];
  const built = O.build({ name: 'thing',
    meshes: [{ name: 'tri', mesh, palette }],
    nodes: [{ name: 'root', matrix: [1,0,0,0, 0,1,0,0, 0,0,1,0, 2,3,4,1],
              mesh: 0, children: [] }],
    images: new Map([['paint', { bytes: new Uint8Array([1,2,3,4,5]),
                                 mimeType: 'image/png' }]]),
    settings: { unitScale: 100 }, upAxis: 'y' });
"""


@needs_node
def test_the_fbx_it_writes_is_one_this_reads(tmp_path):
    """Everything else here reads FBX; this is the one thing that writes it,
    and the reader on the other side of the repository is what says whether it
    got the container right.

    A binary FBX is a header, a stream of records that each say where the next
    one begins, a null record and a footer. Nothing in it is self-describing
    enough to fail loudly: an end offset one byte out is a file that parses
    into nonsense rather than one that refuses.
    """
    stats, doc = _write_fbx(tmp_path, _ONE_TRIANGLE)
    assert doc.format == "fbx"
    assert doc.version == 7400
    assert not doc.warnings, doc.warnings

    objects = doc.root.path("Objects")
    kinds = [child.name for child in objects.children]
    assert sorted(kinds) == ["Geometry", "Material", "Model", "Texture", "Video"]

    geometry = objects.get("Geometry")
    assert geometry.get("Vertices").props[0].value == [
        0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0]
    # The last corner of a polygon is stored as its complement, which is how
    # FBX says where one ends.
    assert geometry.get("PolygonVertexIndex").props[0].value == [0, 1, -3]
    assert geometry.get("LayerElementUV").get("UV").props[0].value == [
        0.0, 0.0, 1.0, 0.0, 0.0, 1.0]
    assert stats["triangles"] == 1 and stats["vertices"] == 3


@needs_node
def test_what_a_written_fbx_says_about_itself(tmp_path):
    """The scene around the geometry: where the node stands, what the material
    is, the picture carried inside the file, and the units it is measured in."""
    from fbxtool import analyze

    _, doc = _write_fbx(tmp_path, _ONE_TRIANGLE)
    info = analyze(doc)

    assert info.global_settings["unit_scale"] == 100.0
    assert info.global_settings["up_axis"] == "+Y"
    model = doc.root.path("Objects").get("Model")
    placed = {entry.props[0].value: [p.value for p in entry.props[4:]]
              for entry in model.path("Properties70").children}
    assert placed["Lcl Translation"] == [2.0, 3.0, 4.0]

    # The picture goes inside the file, which is where an embedded texture
    # lives in an FBX and is how a car's paint travels with it.
    video = doc.root.path("Objects").get("Video")
    assert video.get("Content").props[0].value == bytes([1, 2, 3, 4, 5])

    # And everything is wired together: the geometry and the material to the
    # model, the model to the root, the picture to the property it drives.
    connections = doc.root.path("Connections").children
    kinds = [c.props[0].value for c in connections]
    assert kinds.count("OO") == 4, "geometry, material and video, and the model"
    assert kinds.count("OP") == 1
    binding = [c for c in connections if c.props[0].value == "OP"][0]
    assert binding.props[3].value == "DiffuseColor"


@needs_node
def test_a_mesh_used_twice_is_written_once(tmp_path):
    """Which is how the file it came from held it: the three-part sample scene
    is one cube under three transforms. The materials go on in the same order
    each time, since that order is what the per-polygon indices count."""
    # The one node becomes two, the second hanging off the first and
    # naming the same mesh.
    body = _ONE_TRIANGLE.replace(
        "nodes: [{ name: 'root'",
        "nodes: [{ name: 'a'", 1).replace(
        "mesh: 0, children: [] }],",
        "mesh: 0, children: [{ name: 'b', matrix: null, mesh: 0, " + "children: [] }] }],", 1)
    stats, doc = _write_fbx(tmp_path, body)
    objects = doc.root.path("Objects")
    assert len(objects.get_all("Model")) == 2
    assert len(objects.get_all("Geometry")) == 1, "one geometry for both"
    assert stats["triangles"] == 2, "drawn twice"
    assert stats["stored"] == 1, "and stored once"


# ------------------------------------------ the paint beside a car


def _analyze(expression: str):
    """Evaluate an expression against the page's own ``analyze.js``, under Node."""
    script = (
        f"const A=require({str(WEB / 'app' / 'analyze.js')!r});"
        f"console.log(JSON.stringify({expression}));"
    )
    result = _run(["node", "-e", script])
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)

@needs_node
def test_the_highlight_a_game_writes_for_the_sun_alone():
    """`ksSpecular` weighs what a surface throws back generally; `sunSpecular`
    is the same number written for the one light in the sky, and where a
    material states one it is the one that belongs on the sun's highlight.

    868 of the materials across the 67 cars to hand state it, 846 of those
    state something other than their `ksSpecular` and 403 state nought — a
    surface that reflects its surroundings and takes no highlight, which read
    off `ksSpecular` alone comes up polished. `sunSpecularEXP` goes with it and
    is the width of that lobe rather than of the surface: its median is 90
    against the 20 or so a `ksSpecularEXP` usually is.
    """
    stated = _analyze("A.materialAppearance({ksSpecular: 0.4, sunSpecular: 0.05,"
                      " ksSpecularEXP: 20, sunSpecularEXP: 90})")
    # 0.1 is the whole of the highlight this renderer's lobe gives, so 0.05 is
    # half of it — where `ksSpecular` at 0.4 would have asked for all of it.
    assert stated["specularWeight"] == pytest.approx(0.5)
    assert 0 < stated["sunRoughness"] < stated["roughness"], (
        "the sun is answered tighter than the room is")

    # A surface that says it takes none of the sun takes none of it.
    dark = _analyze("A.materialAppearance({ksSpecular: 0.4, sunSpecular: 0})")
    assert dark["specularWeight"] == 0

    # And every file but a game's own states neither, and keeps the whole of
    # the highlight at the roughness it already has.
    plain = _analyze("A.materialAppearance({ksSpecularEXP: 20})")
    assert plain["specularWeight"] == 1 and plain["sunRoughness"] is None

    # `isAdditive` is only read where there is something behind to add to.
    assert _analyze("A.materialAppearance({isAdditive: 1})")["additive"] is True
    assert _analyze("A.materialAppearance({isAdditive: 0})")["additive"] is False

def _kn5js(expression: str):
    """Evaluate an expression against the page's own ``kn5.js``, under Node."""
    script = (
        f"const K=require({str(WEB / 'app' / 'kn5.js')!r});"
        f"console.log(JSON.stringify({expression}));"
    )
    result = _run(["node", "-e", script])
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


@needs_node
def test_what_a_cars_lighting_config_says_lights_up():
    """`[EMISSIVE_*]` names meshes and says what colour each goes with the
    lights on, and often what it sits at with them off. 56 of the 135 cars to
    hand carry them, 1544 sections between them.

    The colour is a hue and a level rather than a colour: `220, 33, 33, 1` and
    `5, 5, 5, 2` are both written, and neither is in the nought-to-one the
    rest of this works in. Of the 2023 such triples across those cars, 80%
    have a channel above one and their median largest channel is 10 — so the
    triple says which colour and the fourth number says how much.
    """
    config = """\
[EMISSIVE_...]
NAME=tail_l, tail_r
COLOR=255, 40, 40, 2
OFF_COLOR=255, 40, 40, 0.1
LAG=0.8
[EMISSIVE_LIGHT_...]
NAME=plate
OFF_COLOR=5, 5, 5, 1
[LIGHT_EXTRA_...]
COLOR=50,40,30,5
POSITION=0.05, 1.26, -0.23
DIRECTION=0, -1, 0
RANGE=1.5
SPOT=100
SPOT_SHARPNESS=0.2
"""
    read = _kn5js(f"(()=>{{const o=K.carLighting({config!r});"
                  "return {lamps:[...o.lamps], lights:o.lights};})()")
    lamps = dict(read["lamps"])
    # The triple divided by its own largest channel, times the level beside it.
    assert lamps["tail_l"]["on"] == pytest.approx([2, 40 / 255 * 2, 40 / 255 * 2])
    assert lamps["tail_l"]["off"] == pytest.approx([0.1, 40 / 255 * 0.1, 40 / 255 * 0.1])
    assert lamps["tail_r"] == lamps["tail_l"], "a section names as many meshes as it likes"
    # A section stating one colour has one colour, whichever way the switch is.
    assert lamps["plate"]["on"] == pytest.approx([1, 1, 1])
    assert lamps["plate"]["off"] == pytest.approx([1, 1, 1])

    assert len(read["lights"]) == 1
    light = read["lights"][0]
    assert light["position"] == pytest.approx([0.05, 1.26, -0.23])
    assert light["colour"] == pytest.approx([5, 4, 3])
    assert light["range"] == 1.5 and light["spot"] == 100
    assert light["sharpness"] == pytest.approx(0.2)

    empty = _kn5js("(()=>{const o=K.carLighting('nothing here');"
                   "return {lamps:[...o.lamps], lights:o.lights};})()")
    assert empty == {"lamps": [], "lights": []}
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
def test_how_bright_a_skin_says_its_paint_is_drawn():
    """`BrightnessAdjustment` is written in the same section as the rest of
    the paint, and without it a Jaguar C-X75's Silver is the `#FFFFFF` its
    `cm_skin.json` states rather than the silver its preview shows.

    A section naming no materials is about whatever `CarPaintMaterial` names;
    one that names some is about those. 37 of the 135 cars to hand state one
    on a paint, 140 of the 229 settings in a skin rather than beside the car.
    """
    config = """\
[INCLUDE: common/materials_carpaint.ini]
CarPaintMaterial = Paint
DisableDev = 1

[Material_CarPaint_Metallic]
FresnelMax = 0.4
BrightnessAdjustment = 0.66 ; compensates for ambient specular

[Material_CarPaint_Metallic]
Materials = Rim_colour, Trim
BrightnessAdjustment = 0.55

[Material_CarPaint_Solid]
Skins = SomeoneElse
Materials = Paint
BrightnessAdjustment = 0.4

[Material_Plastic_v2]
Materials = Paint
BrightnessAdjustment = 0.07
"""
    assert dict(_skins(f"[...S.paintBrightness({config!r}, 'Silver')]")) == {
        "paint": 0.66, "rim_colour": 0.55, "trim": 0.55,
    }, "the unnamed section is the paint, a named one is what it names"
    # And a block written for another skin is that skin's, not this one's.
    assert dict(_skins(f"[...S.paintBrightness({config!r}, 'SomeoneElse')]"))["paint"] == 0.4

    # A surface stated darker than the floor is one the file has turned into
    # its own highlight — a C-X75's rims are 0.05 beside a clear coat of 3 —
    # and this viewer does not put that highlight back, so following it down
    # would draw bright silver wheels black.
    mirror = """\
[Material_CarPaint_Metallic]
Materials = Rim_colour
BrightnessAdjustment = 0.05
ClearCoatThickness = 3
"""
    assert dict(_skins(f"[...S.paintBrightness({mirror!r}, 'Silver')]")) == {}
    assert dict(_skins("[...S.paintBrightness('nothing here', 'Silver')]")) == {}

@needs_node
def test_what_content_manager_says_the_paint_is():
    meta = ('{"carPaint":{"color":"#FF1A2025","enabled":true,"gloss":0.178,'
            '"reflection":0.767},"carpet":{"enabled":true}}')
    assert _skins(f"S.paintColour({meta!r})") == {
        "hex": "#1a2025", "enabled": True, "gloss": 0.178, "reflection": 0.767}
    # The paint shop's switch is read and handed on as it stands; what it
    # means for the car is settled in `stated`.
    off = '{"carPaint":{"color":"#FFFFFFFF","enabled":false}}'
    assert _skins(f"S.paintColour({off!r})")["enabled"] is False
    assert _skins("S.paintColour('not json')") is None
    assert _skins("S.paintColour('{}')") is None


@needs_node
def test_a_stated_paint_is_the_number_it_says_not_a_shade():
    """A colour somebody picked is a display colour and is undone through the
    sRGB curve to get at the light. A paint stated in a `cm_skin.json` is not
    that: it is the multiplier the game's own shader uses.

    Measured off two cars' previews, four stated greys apiece out of the one
    showroom, with the black car giving the floor and the white the scale. A
    550 Maranello's `#A0A0A0` behaves as 0.73 of white and its `#525254` as
    0.39. Read straight those are 0.63 and 0.32 — out by a constant the
    showroom's own exposure covers. Read through the curve they are 0.35 and
    0.08, which is out by four times on the dark one and cannot be a constant
    anything.

    A Mercedes GL63's carmine is `#5E0000`, and read through the curve it
    arrives at a third of itself and the car comes out a dusty mauve.
    """
    stated = _skins("(()=>{const P=require(%r);return {"
                    "picked: P.fromHex('#525254'), said: P.fromStatedHex('#525254'),"
                    "white: P.fromStatedHex('#FFFFFF')};})()"
                    % str(WEB / "app" / "palette.js"))
    assert stated["said"][0] == pytest.approx(0x52 / 255, abs=1e-6)
    assert stated["picked"][0] == pytest.approx(0.084, abs=0.002)
    assert stated["white"] == [1, 1, 1], "and white is white either way round"

    # Where it lands: the paint a skin states goes on as the number it says,
    # and the colour read off a livery chip — a picture of a swatch, and so a
    # display colour — keeps the curve.
    paints = _skins(
        "(()=>{const skins=[{name:'a',named:['body'],colours:"
        "[{key:'carPaint',hex:'#5e0000',enabled:true}],images:new Map()}];"
        "S.settle(skins,{pictures:new Map([['body','body.dds']]),fallback:[]});"
        "return skins[0].paints;})()")
    assert paints[0]["picture"] is False, "a stated paint is not read off a picture"

@needs_node
def test_which_material_a_carpaint_section_is_about():
    """`CarPaintMaterial` is spelt two ways and means two things. 165 of the
    219 across the 135 cars to hand sit above the material sections and name
    the car's paint once for the whole file; 54 sit inside one and name that
    section's own.

    A 550 Maranello writes four such sections — for its body, its rims and its
    exhaust — each naming itself. Read as a file-wide default, all four name
    every one of the others and the last section's word lands on the body: the
    rims' brightness of 0.5 came out on the paint, and a rosso corsa arrived
    at half the red it states.
    """
    per_section = """\
[Material_CarPaint_Solid]
CarPaintMaterial = body
FresnelMax = 0.5
[Material_CarPaint_Metallic]
CarPaintMaterial = rim
BrightnessAdjustment = 0.5
[Material_CarPaint_Metallic]
CarPaintMaterial = exhaust1
BrightnessAdjustment = 0.4
"""
    assert dict(_skins(f"[...S.paintBrightness({per_section!r}, '')]")) == {
        "rim": 0.5, "exhaust1": 0.4,
    }, "a section naming its own material is about that one and no other"

    # And the other spelling still means the whole file.
    wide = """\
[INCLUDE: common/materials_carpaint.ini]
CarPaintMaterial = Paint
[Material_CarPaint_Metallic]
BrightnessAdjustment = 0.66
"""
    assert dict(_skins(f"[...S.paintBrightness({wide!r}, '')]")) == {"paint": 0.66}


@needs_node
def test_a_car_states_some_of_what_it_says_per_skin():
    """A config beside the car gates its sections by skin — a 550 Maranello
    writes its body once for its reds and once for its silvers — so a single
    reading of it is the reading for no skin at all, and every gated section
    is dropped for every skin.
    """
    config = """\
[Material_CarPaint_Metallic]
CarPaintMaterial = body
Skins = argento, grigio
BrightnessAdjustment = 0.9
"""
    # Read for the skin it names, and for one it does not.
    assert dict(_skins(f"[...S.paintBrightness({config!r}, 'argento')]")) == {"body": 0.9}
    assert dict(_skins(f"[...S.paintBrightness({config!r}, 'rosso')]")) == {}

    # And `settle` asks for it per skin rather than being handed one answer.
    settled = _skins(
        "(()=>{const skins=[{name:'argento',named:['body'],colours:"
        "[{key:'carPaint',hex:'#a0a0a0',enabled:true}],images:new Map()},"
        "{name:'rosso',named:['body'],colours:"
        "[{key:'carPaint',hex:'#d30300',enabled:true}],images:new Map()}];"
        "S.settle(skins,{pictures:new Map([['body','body.dds']]),fallback:[],"
        "brightness:(name)=>new Map(name==='argento'?[['body',0.9]]:[])});"
        "return skins.map(s=>[s.name,s.paints]);})()")
    assert dict(settled)["argento"][0]["scale"] == 0.9
    assert dict(settled)["rosso"][0]["scale"] == 1

@needs_node
def test_what_a_cars_config_takes_away_and_restates():
    """`[MODEL_REPLACEMENT_*]` swaps one model for another and the part of that
    this can honour is `HIDE` — 100 of the 101 such sections across the 135
    cars to hand name some, and 77 of the 101 are written in a skin rather
    than beside the car. `[SHADER_REPLACEMENT_*]` restates a material in the
    very numbers a `.kn5` states about a surface.

    Both are written with the patch's own auto-numbering — `[SECTION_...]` and
    `PROP_...`, a full stop where an index would be — which half these configs
    use and which a reader wanting a plain key name never sees.
    """
    config = """\
[MODEL_REPLACEMENT_...]
ACTIVE = 1
FILE = car.kn5
HIDE = plate, plate_screw
[MODEL_REPLACEMENT_...]
SKINS = Another
HIDE = wing
[MODEL_REPLACEMENT_...]
ACTIVE = 0
HIDE = roof
[SHADER_REPLACEMENT_...]
MATERIALS = zahlens, jantao
SHADER = ksWindscreen
IS_TRANSPARENT = 1
PROP_... = ksAmbient, 0.4
PROP_... = ksSpecularEXP, 13
[SHADER_REPLACEMENT_...]
MESHES = only_a_mesh
PROP_... = ksAmbient, 0.9
"""
    read = _skins(f"(()=>{{const o=S.carReplacements({config!r}, 'Silver');"
                  "return {hidden:[...o.hidden], shaders:[...o.shaders]"
                  ".map(([k,v])=>[k,{props:[...v.props],shader:v.shader,"
                  "transparent:v.transparent}])};})()")
    # A section for another skin is that skin's, and one switched off is nobody's.
    assert sorted(read["hidden"]) == ["plate", "plate_screw"]

    shaders = dict(read["shaders"])
    assert sorted(shaders) == ["jantao", "zahlens"], (
        "a section naming meshes rather than materials is not applied: a material"
        " here is shared across every mesh that wears it")
    assert dict(shaders["zahlens"]["props"]) == {"ksAmbient": 0.4, "ksSpecularEXP": 13}
    assert shaders["zahlens"]["shader"] == "ksWindscreen"
    assert shaders["zahlens"]["transparent"] is True

    empty = _skins("(()=>{const o=S.carReplacements('nothing here','');"
                   "return {hidden:[...o.hidden], shaders:[...o.shaders]};})()")
    assert empty == {"hidden": [], "shaders": []}

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
        f"S.settle({json.dumps(skins)}.map((s) => "
        "Object.assign(s, { images: new Map() })), "
        f"{{pictures: new Map([['booody_aooo', 'skin_00.dds']]), fallback: []}})")
    assert [(s["name"], s["paints"]) for s in settled] == [
        ("knows", [{"material": "booody_aooo", "hex": "#111111", "scale": 1,
                    "picture": False}]),
        ("copied", [{"material": "booody_aooo", "hex": "#222222", "scale": 1,
                     "picture": False}]),
        ("silent", [{"material": "booody_aooo", "hex": "#333333", "scale": 1,
                     "picture": False}]),
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
def test_a_chip_is_only_read_where_nothing_else_says_the_colour():
    """A picture is weaker evidence than a setting, and where both are there
    they disagree about a third of the time — usually because the setting is
    Content Manager's untouched white and the chip is the paint.

    And it is weaker still than the skin's own pictures. A skin that replaces
    the very texture the paint material wears has put the colour there already,
    and the chip over the top paints it twice: a Lancia Beta Montecarlo's seven
    skins each replace the `LANCIA_body.dds` its `lancia_body_paint` wears and
    state nothing else at all.
    """
    pictures = "new Map([['carpaint', 'body.dds']])"

    def settled(colours, brings, chip=None):
        """One skin, settled against a car whose paint wears `body.dds`."""
        skin = json.dumps({"name": "one", "named": ["carpaint"], "colours": colours})
        images = json.dumps([[name, 1] for name in brings])
        after = f"S.fromChip(one, {json.dumps(chip)}, {pictures})" if chip else "one"
        return _skins(
            "(() => { const one = S.settle("
            f"[Object.assign({skin}, {{ images: new Map({images}), livery: 1 }})], "
            f"{{ pictures: {pictures}, fallback: [] }})[0];"
            f" return {after}; }})()")

    stated = settled([{"key": "carPaint", "hex": "#0c0c0c", "enabled": True}], [])
    assert stated["wantsChip"] is False, "a colour it stated needs no picture"
    assert stated["paints"] == [
        {"material": "carpaint", "hex": "#0c0c0c", "scale": 1, "picture": False}]

    # One that switched its colour off and left the white it opens with stated
    # none, which is where a chip comes in: an Audi's Sakhir Orange says
    # #FFFFFF and turns it off.
    off = settled([{"key": "carPaint", "hex": "#ffffff", "enabled": False}], [])
    assert off["wantsChip"] is True

    # Black is the other colour a picker nobody opened is left holding, and it
    # arrives spelt several ways: a Scirocco says #000000 across twelve skins
    # that are red and blue and silver, and a Skoda's White says #020202.
    for hex in ("#000000", "#020202", "#040505", "#070707"):
        dark = settled([{"key": "carPaint", "hex": hex, "enabled": False}], [])
        assert dark["wantsChip"] is True, hex
    # And the gap below what any car actually states is not fallen into: a
    # Porsche 928's Dark Blue is #00030f and is the darkest of them.
    real = settled([{"key": "carPaint", "hex": "#00030f", "enabled": False}], [])
    assert real["wantsChip"] is False

    # But one that turned the shop off and stated a colour anyway stated one.
    # The switch is the paint shop's rather than the car's, and 77 skins of the
    # 125 cars to hand say a colour with it off — a Ford Escort Cosworth's Red
    # says #7F0000 that way, brings no texture it could have been baked into,
    # and the car is red.
    anyway = settled([{"key": "carPaint", "hex": "#7f0000", "enabled": False}], [])
    assert anyway["wantsChip"] is False
    assert anyway["paints"] == [
        {"material": "carpaint", "hex": "#7f0000", "scale": 1, "picture": False}]

    # And a slot the car pairs with nothing does not answer for the body: an
    # Audi RS4's Nardo Grey states two colours, both of them its wheels, and
    # leaves the untouched white in the slot the paint is read from.
    rims = settled([{"key": "01AbtPaint", "hex": "#ffffff", "enabled": False},
                    {"key": "02Rim", "hex": "#191919", "enabled": False},
                    {"key": "03Rim", "hex": "#a5a5a5", "enabled": False}], [])
    assert rims["paints"] == []
    assert rims["wantsChip"] is True, "nothing was painted, so the chip answers"

    # But not where the skin brought the paint's own picture.
    livery = settled([], ["body.dds"])
    assert livery["wantsChip"] is False, "the colour is already in that picture"
    # A different picture is a different matter: that one paints nothing.
    other = settled([], ["badge.dds"])
    assert other["wantsChip"] is True

    # And where it is wanted, the colour lands on the material the car settled.
    assert settled([], ["badge.dds"], chip="#941a0a")["paints"] == [
        # Read off the livery chip, which is a picture of a swatch.
        {"material": "carpaint", "hex": "#941a0a", "scale": 1, "picture": True}]
    assert settled([], ["body.dds"], chip="#941a0a")["paints"] == [],         "and a chip nobody wanted is not put on anyway"


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
def test_what_a_surface_gives_off_on_its_own(built, tmp_path):
    """A dial, a display and an LED are lit rather than pale, and what makes
    them read that way is that nothing about the room changes them.

    The colour and the map are two different materials: across the 67 cars to
    hand 29 state an emissive colour and bind no map, 89 bind a map and state
    no colour, and not one does both. And `txGlow` is bound almost only by
    `ksBrakeDisc` — 36 of the 37 that bind it — where the level beside it is
    the heat in the disc, which is nought in a car standing still.
    """
    try:
        probe = _run(["node", "-e", "require('playwright')"], env=_node_env())
        if probe.returncode != 0:
            pytest.skip("playwright is not installed for node")
    except OSError:  # pragma: no cover
        pytest.skip("node is unavailable")

    import fbxbuild as fb

    grey = fb.dds_bgra(4, 4, bytes([128, 128, 128, 255]) * 16)
    lamp = fb.dds_bgra(4, 4, bytes([255, 255, 255, 255]) * 16)
    identity = (1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0,
                0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0)
    vertices, indices = fb.kn5_cube(1.0)
    files = []
    for name, emissive, glow_level in (
        ("dark", None, None),
        # Amber, and past white in its red: a game states how much brighter
        # than the room the thing reads, not what shade it is painted.
        ("lit", (2.0, 0.4, 0.0), None),
        ("mapped", None, 1.0),
        ("cold", None, 0.0),
    ):
        properties = fb.kn5_property("ksAmbient", 0.5) + fb.kn5_property("ksDiffuse", 0.6)
        count = 2
        if emissive is not None:
            # A kn5 writes an emissive colour in the three-float group, and a
            # plain number in the first: the reader takes whichever is set.
            properties += fb.kn5_property("ksEmissive", 0.0, c=emissive)
            count += 1
        slots = [("txDiffuse", 0, "grey.dds")]
        textures = [("grey.dds", grey)]
        if glow_level is not None:
            properties += fb.kn5_property("glowLevel", glow_level)
            count += 1
            slots.append(("txGlow", 4, "lamp.dds"))
            textures.append(("lamp.dds", lamp))
        material = fb.kn5_material("panel", "ksPerPixel", properties=properties,
                                   property_count=count, slots=tuple(slots))
        path = tmp_path / f"{name}.kn5"
        path.write_bytes(fb.build_kn5(
            6, textures=textures, materials=[material],
            tree=fb.kn5_dummy("car", identity,
                              fb.kn5_mesh("cube", vertices, indices), 1)))
        files.append(str(path))

    result = _run(["node", str(WEB / "test" / "emissive.js"), *files],
                  env=_node_env(), timeout=300)
    print(result.stdout)
    assert result.returncode == 0, f"{result.stdout}" + chr(10) + f"{result.stderr}"
    assert "all checks passed" in result.stdout

@needs_clang
@needs_node
def test_a_surface_drawn_from_behind_its_own_normal(built, tmp_path):
    """A surface whose normal faces away from the eye has nowhere to go: the
    angle is past a right angle, and clamped back to something a cosine will
    take it becomes exactly grazing — the one place a Fresnel term goes to a
    mirror. The surface then reflects the whole room whatever colour it is.

    Which happens to a whole model at a time. A Smart Roadster out of a file
    converter states its normals the other way round from its winding, and
    drew all 28 of its colours as the same pale grey — its near-black tyres
    included. With every colour on it set to black it still came back at 124
    of 255, which is a mirror and not a car.
    """
    try:
        probe = _run(["node", "-e", "require('playwright')"], env=_node_env())
        if probe.returncode != 0:
            pytest.skip("playwright is not installed for node")
    except OSError:  # pragma: no cover
        pytest.skip("node is unavailable")

    import fbxbuild as fb

    # Black, so that anything on the screen is the room and not the surface.
    dark = fb.dds_bgra(4, 4, bytes([0, 0, 0, 255]) * 16)
    identity = (1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0,
                0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0)
    material = fb.kn5_material("panel", "ksPerPixel",
                               properties=fb.kn5_property("fresnelC", 0.04),
                               property_count=1,
                               slots=(("txDiffuse", 0, "dark.dds"),))
    files = []
    for name, inward in (("out", False), ("in", True)):
        vertices, indices = fb.kn5_cube(1.0, inward=inward)
        path = tmp_path / f"{name}.kn5"
        path.write_bytes(fb.build_kn5(
            6, textures=[("dark.dds", dark)], materials=[material],
            tree=fb.kn5_dummy("car", identity,
                              fb.kn5_mesh("cube", vertices, indices), 1)))
        files.append(str(path))

    result = _run(["node", str(WEB / "test" / "facing.js"), *files],
                  env=_node_env(), timeout=300)
    print(result.stdout)
    assert result.returncode == 0, f"{result.stdout}" + chr(10) + f"{result.stderr}"
    assert "all checks passed" in result.stdout

@needs_clang
@needs_node
def test_the_shape_that_goes_with_a_grain(built, tmp_path):
    """A grain is two maps: what colour the surface is at that scale and what
    shape it is. Every one of the 575 materials across the 67 cars to hand
    that binds `txNormalDetail` binds `txDetail` as well, and only three of
    them are the same file — so the shape is its own picture, of the leather
    rather than of the panel.

    53 of those 575 blend it at nothing, which has to come back
    indistinguishable from carrying none at all.
    """
    try:
        probe = _run(["node", "-e", "require('playwright')"], env=_node_env())
        if probe.returncode != 0:
            pytest.skip("playwright is not installed for node")
    except OSError:  # pragma: no cover
        pytest.skip("node is unavailable")

    import fbxbuild as fb

    grey = fb.dds_bgra(4, 4, bytes([180, 180, 180, 255]) * 16)
    # A grain that varies, so it is a grain rather than a flat colour and is
    # not dropped before the relief that goes with it can be tiled by it.
    speck = fb.dds_bgra(4, 4, (bytes([120, 120, 120, 255]) * 8)
                        + (bytes([150, 150, 150, 255]) * 8))
    # A relief pointing one way across the whole of itself, so what it does is
    # the surface turning rather than a texture appearing. BGRA in, so this is
    # r=210, g=128, b=255: tilted along the surface's own x.
    tilt = fb.dds_bgra(4, 4, bytes([255, 128, 210, 255]) * 16)
    identity = (1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0,
                0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0)
    vertices, indices = fb.kn5_cube(1.0)
    files = []
    for name, relief, blend in (("plain", False, 1.0), ("tilted", True, 1.0),
                                ("off", True, 0.0)):
        slots = [("txDiffuse", 0, "grey.dds"), ("txDetail", 3, "speck.dds")]
        textures = [("grey.dds", grey), ("speck.dds", speck)]
        properties = (fb.kn5_property("fresnelC", 0.05)
                      + fb.kn5_property("useDetail", 1.0)
                      + fb.kn5_property("detailUVMultiplier", 3.0)
                      + fb.kn5_property("detailNormalBlend", blend))
        if relief:
            slots.append(("txNormalDetail", 4, "tilt.dds"))
            textures.append(("tilt.dds", tilt))
        material = fb.kn5_material("panel", "ksPerPixelMultiMap_NMDetail",
                                   properties=properties, property_count=4,
                                   slots=tuple(slots))
        path = tmp_path / f"{name}.kn5"
        path.write_bytes(fb.build_kn5(
            6, textures=textures, materials=[material],
            tree=fb.kn5_dummy("car", identity,
                              fb.kn5_mesh("cube", vertices, indices), 1)))
        files.append(str(path))

    result = _run(["node", str(WEB / "test" / "relief.js"), *files],
                  env=_node_env(), timeout=300)
    print(result.stdout)
    assert result.returncode == 0, f"{result.stdout}" + chr(10) + f"{result.stderr}"
    assert "all checks passed" in result.stdout

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
    # of it and what shows is its green cast. Held well clear of both ends: a
    # grain that multiplies through to black or to white lands in the same
    # place whichever light it was multiplied in, and says nothing about which.
    green = fb.dds_bgra(4, 4,
                        (bytes([80, 160, 80, 255]) * 8) + (bytes([120, 200, 120, 255]) * 8))
    # And one that is nothing but its own average, which must therefore do
    # nothing at all. It is the strictest thing a grain can be asked: taken in
    # the light the file is written in rather than the light it is multiplied
    # in, a flat grain over a grey panel turns it white.
    flat = fb.dds_bgra(4, 4, bytes([150, 150, 150, 255]) * 16)
    # And one dark enough that taking it as neutral asks for forty-seven times
    # the light back, where the viewer allows eight. An Audi S8's paint asks
    # for ten, so the ceiling is a real one and both sides must hold to it.
    # Dark and darker rather than one flat dark: a grain has to differ from
    # its own average somewhere to be a grain at all, and this one is here to
    # ask about the ceiling rather than about that.
    deep = fb.dds_bgra(4, 4,
                       (bytes([35, 35, 35, 255]) * 8) + (bytes([45, 45, 45, 255]) * 8))
    # And the same flat grain in a colour, which is the slot filled in and
    # never authored: 55 of the 581 detail maps in the 67 cars to hand are one
    # of these, under names like `PURE_RED.dds` and `NULL.dds`. Its average is
    # one number in grey and three in colour, so neutralised by the one it
    # comes back three times its own red and paints whatever wears it.
    dummy = fb.dds_bgra(4, 4, bytes([0, 0, 255, 255]) * 16)
    identity = (1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0,
                0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0)
    vertices, indices = fb.kn5_cube(1.0)
    files = []
    for name, slots, textures in (
        ("plain", (("txDiffuse", 0, "grey.dds"),), [("grey.dds", grey)]),
        ("grained", (("txDiffuse", 0, "grey.dds"), ("txDetail", 3, "green.dds")),
         [("grey.dds", grey), ("green.dds", green)]),
        ("flat", (("txDiffuse", 0, "grey.dds"), ("txDetail", 3, "flat.dds")),
         [("grey.dds", grey), ("flat.dds", flat)]),
        ("deep", (("txDiffuse", 0, "grey.dds"), ("txDetail", 3, "deep.dds")),
         [("grey.dds", grey), ("deep.dds", deep)]),
        ("dummy", (("txDiffuse", 0, "grey.dds"), ("txDetail", 3, "dummy.dds")),
         [("grey.dds", grey), ("dummy.dds", dummy)]),
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

    result = _run(["node", str(WEB / "test" / "detail.js"), str(tmp_path), *files],
                  env=_node_env(), timeout=300)
    print(result.stdout)
    assert result.returncode == 0, f"{result.stdout}" + chr(10) + f"{result.stderr}"
    assert "all checks passed" in result.stdout


@needs_clang
@needs_node
def test_the_fresnel_a_material_states_is_the_one_it_is_drawn_with(built, tmp_path):
    """Schlick's term is one shape: a base at nothing rising to a mirror over a
    fifth power. A `.kn5` writes both of those numbers loose — `fresnelEXP` for
    how fast the reflection comes up as the surface turns away, and
    `fresnelMaxLevel` for how far it is let get — and read as a base alone the
    other two are lost.

    1428 of the 3427 materials across the 67 cars to hand state a base of
    nought, so read that way they reflect nothing at all: a Jaguar Mk2's paint
    is nought, a half and a quarter, which is a body reflecting a quarter of
    the room from every angle but dead head-on, and it drew as a matte panel.
    The median ceiling across the same materials is 0.1, so the other half of
    the sentence is at least as often a limit — a fifth power rising to a
    mirror at a grazing angle is the thing most of them spent a number saying
    they do not do.
    """
    try:
        probe = _run(["node", "-e", "require('playwright')"], env=_node_env())
        if probe.returncode != 0:
            pytest.skip("playwright is not installed for node")
    except OSError:  # pragma: no cover
        pytest.skip("node is unavailable")

    import fbxbuild as fb

    identity = (1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0,
                0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0)
    vertices, indices = fb.kn5_cube(1.0)
    files = []
    # Two pairs, each differing in one number and nothing else. The first pair
    # shares a base of nought and a ceiling of a quarter and differs only in
    # how fast it gets there. The second shares a base and an exponent of
    # nought — the rise at its full height from every angle, which 626 of the
    # materials to hand write — and differs only in the ceiling that holds it:
    # one at a mirror, one at the base it started from. Both are lit dimly —
    # `ksAmbient` and `ksDiffuse` at a tenth — so what is measured is the
    # reflection rather than the panel under it.
    for name, base, exponent, ceiling in (
        ("broad", 0.0, 0.5, 0.25),
        ("dull", 0.0, 5.0, 0.25),
        ("open", 0.05, 0.0, 1.0),
        ("capped", 0.05, 0.0, 0.05),
    ):
        material = fb.kn5_material(
            "panel", "ksPerPixel",
            properties=(fb.kn5_property("ksAmbient", 0.1)
                        + fb.kn5_property("ksDiffuse", 0.1)
                        + fb.kn5_property("fresnelC", base)
                        + fb.kn5_property("fresnelEXP", exponent)
                        + fb.kn5_property("fresnelMaxLevel", ceiling)),
            property_count=5, slots=())
        path = tmp_path / f"{name}.kn5"
        path.write_bytes(fb.build_kn5(
            6, textures=[], materials=[material],
            tree=fb.kn5_dummy("car", identity,
                              fb.kn5_mesh("cube", vertices, indices), 1)))
        files.append(str(path))

    result = _run(["node", str(WEB / "test" / "fresnel.js"), *files],
                  env=_node_env(), timeout=300)
    print(result.stdout)
    assert result.returncode == 0, f"{result.stdout}" + chr(10) + f"{result.stderr}"
    assert "all checks passed" in result.stdout


@needs_clang
@needs_node
def test_a_surface_that_adds_what_it_returns(built, tmp_path):
    """`isAdditive` tells a game's shader to put what a surface returns on top
    of what is behind it rather than in place of some of it.

    1109 materials across the 67 cars to hand state one — and 1015 of those are
    opaque, named `body` and `carpaint` and `chrome`, where there is nothing
    behind to add to. Whatever the number means there it is not this, so only
    the 94 that also blend are taken.
    """
    try:
        probe = _run(["node", "-e", "require('playwright')"], env=_node_env())
        if probe.returncode != 0:
            pytest.skip("playwright is not installed for node")
    except OSError:  # pragma: no cover
        pytest.skip("node is unavailable")

    import fbxbuild as fb

    # Half-covered, so the near faces of the cube show the far ones through
    # them and there is something for the addition to land on.
    veil = fb.dds_bgra(4, 4, bytes([190, 190, 190, 128]) * 16)
    identity = (1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0,
                0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0)
    vertices, indices = fb.kn5_cube(1.0)
    files = []
    for name, additive in (("over", 0.0), ("added", 1.0)):
        material = fb.kn5_material(
            "veil", "ksPerPixelReflection", blend=1,
            properties=(fb.kn5_property("fresnelC", 0.05)
                        + fb.kn5_property("isAdditive", additive)),
            property_count=2, slots=(("txDiffuse", 0, "veil.dds"),))
        path = tmp_path / f"{name}.kn5"
        path.write_bytes(fb.build_kn5(
            6, textures=[("veil.dds", veil)], materials=[material],
            tree=fb.kn5_dummy("car", identity,
                              fb.kn5_mesh("cube", vertices, indices), 1)))
        files.append(str(path))

    result = _run(["node", str(WEB / "test" / "additive.js"), *files],
                  env=_node_env(), timeout=300)
    print(result.stdout)
    assert result.returncode == 0, f"{result.stdout}" + chr(10) + f"{result.stderr}"
    assert "all checks passed" in result.stdout

@needs_clang
@needs_node
def test_what_a_cars_config_takes_away_and_what_it_restates(built, tmp_path):
    """A model replacement's `HIDE` takes meshes away — a number plate a livery
    does not want, which is the commonest thing in them — and 77 of the 101
    such sections across the 135 cars to hand are written in a skin rather than
    beside the car, so it has to follow the skin.

    A shader replacement restates a material in the very numbers a `.kn5`
    states about a surface, so what it says arrives as though the model had
    said it.
    """
    try:
        probe = _run(["node", "-e", "require('playwright')"], env=_node_env())
        if probe.returncode != 0:
            pytest.skip("playwright is not installed for node")
    except OSError:  # pragma: no cover
        pytest.skip("node is unavailable")

    import fbxbuild as fb

    grey = fb.dds_bgra(4, 4, bytes([200, 200, 200, 255]) * 16)
    identity = (1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0,
                0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0)
    vertices, indices = fb.kn5_cube(1.0)
    # The model says a dim, nearly mirror-smooth surface.
    material = fb.kn5_material(
        "panel", "ksPerPixel",
        properties=(fb.kn5_property("ksAmbient", 0.1)
                    + fb.kn5_property("ksDiffuse", 0.1)
                    + fb.kn5_property("ksSpecularEXP", 400.0)),
        property_count=3, slots=(("txDiffuse", 0, "grey.dds"),))
    model = fb.build_kn5(6, textures=[("grey.dds", grey)], materials=[material],
                         tree=fb.kn5_dummy("car", identity,
                                           fb.kn5_mesh("panel", vertices, indices), 1))
    # Written the way half these configs are: the patch's own auto-numbering,
    # a full stop where an index would be.
    hide = ("[MODEL_REPLACEMENT_...]" + chr(10) + "ACTIVE = 1" + chr(10)
            + "FILE = car.kn5" + chr(10) + "HIDE = panel" + chr(10))
    # And the config says a bright, blunt one.
    restate = ("[SHADER_REPLACEMENT_...]" + chr(10) + "MATERIALS = panel" + chr(10)
               + "PROP_... = ksAmbient, 0.5" + chr(10)
               + "PROP_... = ksDiffuse, 0.5" + chr(10)
               + "PROP_... = ksSpecularEXP, 4" + chr(10))
    folders = []
    for name, config, skin in (("plain", None, None), ("hidden", hide, None),
                               ("restated", restate, None), ("skinned", None, hide)):
        car = tmp_path / name
        car.mkdir()
        (car / f"{name}.kn5").write_bytes(model)
        if config:
            (car / "extension").mkdir()
            (car / "extension" / "ext_config.ini").write_text(config, encoding="utf-8")
        if skin:
            plain = car / "skins" / "Plain"
            plain.mkdir(parents=True)
            (plain / "ext_config.ini").write_text(skin, encoding="utf-8")
            # A skin is only offered for the pictures it replaces, so it brings
            # the one the car wears.
            (plain / "grey.dds").write_bytes(grey)
        folders.append(str(car))

    result = _run(["node", str(WEB / "test" / "replace.js"), *folders],
                  env=_node_env(), timeout=300)
    print(result.stdout)
    assert result.returncode == 0, f"{result.stdout}" + chr(10) + f"{result.stderr}"
    assert "all checks passed" in result.stdout

@needs_clang
@needs_node
def test_a_car_lights_its_own_lamps(built, tmp_path):
    """A car's lighting config names meshes and says what colour each goes
    when the lights are on. 56 of the 135 cars to hand carry those sections,
    1544 between them, and they are the whole of what makes a lamp read as a
    lamp rather than as red plastic.

    The switch is offered only where a car brought a config saying what its
    lights are, and starts off: a showroom photograph has the lamps dark.
    """
    try:
        probe = _run(["node", "-e", "require('playwright')"], env=_node_env())
        if probe.returncode != 0:
            pytest.skip("playwright is not installed for node")
    except OSError:  # pragma: no cover
        pytest.skip("node is unavailable")

    import fbxbuild as fb

    # A dark housing lit dimly, so what the middle of the viewport shows is
    # the lamp rather than the plastic around it.
    grey = fb.dds_bgra(4, 4, bytes([40, 40, 40, 255]) * 16)
    identity = (1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0,
                0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0)
    vertices, indices = fb.kn5_cube(1.0)
    material = fb.kn5_material("plastic", "ksPerPixel",
                               properties=(fb.kn5_property("fresnelC", 0.05)
                                           + fb.kn5_property("ksAmbient", 0.1)
                                           + fb.kn5_property("ksDiffuse", 0.1)),
                               property_count=3,
                               slots=(("txDiffuse", 0, "grey.dds"),))
    # The one mesh is the lamp, so what the config says about it is what the
    # middle of the viewport shows.
    model = fb.build_kn5(6, textures=[("grey.dds", grey)], materials=[material],
                         tree=fb.kn5_dummy("car", identity,
                                           fb.kn5_mesh("tail", vertices, indices), 1))
    folders = []
    for name, config in (
        ("lamp", "[EMISSIVE_...]" + chr(10) + "NAME=tail" + chr(10)
         # A hue and a level, which is how these are written: the triple is
         # divided by its own largest channel and the fourth says how much.
         + "COLOR=255, 40, 40, 3" + chr(10)
         + "OFF_COLOR=255, 40, 40, 0.15" + chr(10)),
        ("plain", None),
    ):
        car = tmp_path / name
        car.mkdir()
        (car / f"{name}.kn5").write_bytes(model)
        if config:
            (car / "extension").mkdir()
            (car / "extension" / "ext_config.ini").write_text(config, encoding="utf-8")
        folders.append(str(car))

    result = _run(["node", str(WEB / "test" / "lights.js"), *folders],
                  env=_node_env(), timeout=300)
    print(result.stdout)
    assert result.returncode == 0, f"{result.stdout}" + chr(10) + f"{result.stderr}"
    assert "all checks passed" in result.stdout

@needs_clang
@needs_node
def test_what_a_cars_config_says_its_surfaces_are_made_of(built, tmp_path):
    """`Reflectance`, `Smoothness` and `Metalness` sit in the `[Material_*]`
    blocks beside the model, and on a Custom Shaders Patch car they are where
    the material lives — the `ks*` values still inside the `.kn5` describe the
    same surface as it was before the author moved the description out.

    1121 of those blocks sit beside the 135 cars to hand: 423 state a
    smoothness, 375 a reflectance, 194 a metalness. Read from the model alone
    a car is read as the car it used to be, and the chrome it was given comes
    back as plastic.
    """
    try:
        probe = _run(["node", "-e", "require('playwright')"], env=_node_env())
        if probe.returncode != 0:
            pytest.skip("playwright is not installed for node")
    except OSError:  # pragma: no cover
        pytest.skip("node is unavailable")

    import fbxbuild as fb

    grey = fb.dds_bgra(4, 4, bytes([200, 200, 200, 255]) * 16)
    identity = (1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0,
                0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0)
    vertices, indices = fb.kn5_cube(1.0)
    material = fb.kn5_material(
        "panel", "ksPerPixel",
        properties=(fb.kn5_property("fresnelC", 0.05)
                    + fb.kn5_property("fresnelMaxLevel", 0.6)
                    + fb.kn5_property("ksSpecularEXP", 20.0)),
        property_count=3, slots=(("txDiffuse", 0, "grey.dds"),))
    model = fb.build_kn5(6, textures=[("grey.dds", grey)], materials=[material],
                         tree=fb.kn5_dummy("car", identity,
                                           fb.kn5_mesh("cube", vertices, indices), 1))
    folders = []
    for name, config in (
        ("plain", None),
        # Chrome, in the three numbers a `.kn5` has no way of saying.
        ("polished", "[Material_Metal_v2]" + chr(10) + "Materials = panel" + chr(10)
         + "Smoothness = 0.95" + chr(10) + "Reflectance = 0.9" + chr(10)
         + "Metalness = 1.0" + chr(10)),
        # And a smoothness written past anything that means something, which
        # is a thing these files do: the highest written is 3.
        ("matte", "[Material_Plastic_v2]" + chr(10) + "Materials = panel" + chr(10)
         + "Smoothness = 3.0" + chr(10) + "Reflectance = 0.02" + chr(10)),
    ):
        car = tmp_path / name
        car.mkdir()
        (car / f"{name}.kn5").write_bytes(model)
        if config:
            (car / "extension").mkdir()
            (car / "extension" / "ext_config.ini").write_text(config, encoding="utf-8")
        folders.append(str(car))

    result = _run(["node", str(WEB / "test" / "finish.js"), *folders],
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
    for name in ("Red", "Stranger", "Pair", "Bare", "Chip", "Livery"):
        (car / "skins" / name).mkdir(parents=True)
    # A paint map is the panels in white, because the colour is what the game
    # multiplies through it.
    white = fb.dds_bgra(4, 4, bytes([255, 255, 255, 255]) * 16)
    # A second picture, worn by the trim alone. Only the `Bare` skin replaces
    # it, so switching away from that skin leaves nothing to claim it back —
    # which is the one arrangement in which a texture left behind can be seen.
    green = fb.dds_bgra(4, 4, bytes([40, 220, 40, 255]) * 16)
    materials = [
        fb.kn5_material(name, "ksPerPixelMultiMap",
                        properties=fb.kn5_property("fresnelC", 0.05),
                        property_count=1,
                        slots=(("txDiffuse", 0, picture),))
        for name, picture in (("carpaint", "paint.dds"), ("trim", "trim.dds"))
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
    beside = (1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0,
              0.0, 0.0, 1.0, 0.0, 1.8, 0.0, 0.0, 1.0)
    tree = fb.kn5_dummy(
        "car", identity,
        fb.kn5_mesh("body", vertices, indices, material=0)
        # Out beside the body rather than inside it: a part nobody can see is a
        # part no check can speak for.
        + fb.kn5_dummy("trim", beside,
                       fb.kn5_mesh("bumper", small, small_indices, material=1), 1)
        + fb.kn5_mesh("sill", small, small_indices, material=2), 3)
    (car / "car.kn5").write_bytes(fb.build_kn5(
        6, textures=[("paint.dds", white), ("trim.dds", green)],
        materials=materials, tree=tree))

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
        # And this one states nothing either and brings the paint's own
        # picture, which says the colour is in there already.
        ("Livery", "carpaint", None),
    ):
        skin = car / "skins" / name
        # One of them brings a map that is not the car's own.
        #
        # `Bare` states no colour at all, so its picture is the only thing it
        # changes and the only thing that can prove the picture was changed.
        # Every other skin here leaves the paint map as it found it, so
        # switching away from this one has to put the car's own back — and a
        # texture left behind is a skin still half on, which is the half nobody
        # looks for: the colour changes, so the eye says the skin changed,
        # while the picture underneath is still the last one's.
        # `Chip` brings no paint map at all, so its chip is the only thing
        # saying what colour it is; `Livery` brings one, so its chip is not.
        if name != "Chip":
            (skin / "paint.dds").write_bytes(
                fb.dds_bgra(4, 4, bytes([200, 200, 200, 255]) * 16)
                if name == "Bare" else white)
        if name in ("Bare", "Chip"):
            (skin / "trim.dds").write_bytes(
                fb.dds_bgra(4, 4, bytes([220, 40, 220, 255]) * 16))
        if names_it:
            (skin / "ext_config.ini").write_text(
                "CarPaintMaterial = " + names_it + chr(10), encoding="utf-8")
        if meta:
            (skin / "cm_skin.json").write_text(meta, encoding="utf-8")
    # A chip apiece: the paint over the band of dark reflection under it.
    for name in ("Chip", "Livery"):
        (car / "skins" / name / "livery.png").write_bytes(fb.livery_png(
            [[(0x20, 0x10, 0xdd)] * 8] * 4 + [[(10, 10, 10)] * 8] * 4))

    # A second car, with nothing beside it, to open over the top of the first.
    other = tmp_path / "other.kn5"
    other.write_bytes(fb.build_kn5(
        6, textures=[("paint.dds", white), ("trim.dds", green)], materials=[materials[0]],
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
@pytest.mark.parametrize("exponent,what", [
    (2, "the bluntest a Phong lobe gets"),
    (20, "what a material stating no shininess is given"),
    (25, "a Mercedes' paint"),
    (100, "a chrome trim"),
    (650, "a Renault 5's headlight glass"),
    (1024, "a clear coat"),
], ids=lambda v: str(v))
def test_a_phong_exponent_survives_becoming_a_roughness(exponent, what):
    """An exponent and a roughness meet through the microfacet alpha, and there
    are two squarings in the way of it.

    `alpha = sqrt(2 / (n + 2))` is the relation between the two lobes, and
    `alpha = roughness * roughness` is what every modern renderer means by the
    word — so the roughness is the fourth root. Handing the alpha over as the
    roughness instead squares it twice, and the file's exponent is drawn far
    sharper than it asked: 20 as 240, 100 as 5,200, 650 as 212,550.

    It shows least where it matters most. A highlight that sharp lands between
    the pixels, so a surface that should carry a hard bright glint carries
    nothing at all — which is how a Renault 5's headlight lens, at 650, came to
    read as a hole rather than as glass.
    """
    roughness = _appearance({"ShininessExponent": exponent})["roughness"]
    assert roughness == pytest.approx((2 / (exponent + 2)) ** 0.25, abs=1e-6), what
    # The shader squares it, and what comes out is the exponent that went in.
    assert 2 / roughness ** 4 - 2 == pytest.approx(exponent, rel=1e-6), what


@needs_node
@pytest.mark.parametrize("roughness", [0.05, 0.2, 0.4, 0.5, 0.8, 1.0])
def test_a_roughness_written_out_as_an_exponent_comes_back_as_itself(roughness):
    """Which is the other half of it, and it crosses the two languages.

    A `.blend` states a roughness and an FBX material states an exponent, so
    the Python reader writes the one as the other and the page reads it back.
    The two conversions have to be inverses, or a Blender material comes back
    shinier than Blender was showing it.
    """
    from fbxtool.blend import material_look

    written = material_look((0.5, 0.5, 0.5), roughness=roughness)["shininess"]
    assert _appearance({"ShininessExponent": written})["roughness"] ==         pytest.approx(roughness, abs=1e-6)


@needs_node
@pytest.mark.parametrize("stated,expected,what", [
    (None, 1, "every file but a game's, which states nothing and keeps it all"),
    (0.0, 0.0, "277 of 2006 materials say this and were given a highlight anyway"),
    (0.05, 0.5, "half of what a plain surface takes"),
    (0.1, 1.0, "the commonest value of all: 559 materials"),
    (2.0, 1.0, "a Renault 5's headlight glass, which cannot ask for more"),
    (100.0, 1.0, "nor can the one material that says a hundred"),
], ids=["silent", "none", "half", "plain", "glass", "absurd"])
def test_how_much_of_the_suns_highlight_a_surface_takes(stated, expected, what):
    """`ksSpecular` is the peak of the Blinn-Phong highlight a game's shader
    adds, and it is the third of a trio: `ksAmbient` and `ksDiffuse` weigh the
    two halves of the light a surface takes in, and this weighs what it throws
    back. Given a highlight anyway, a windscreen seal and a rubber gaiter both
    come up polished.

    It only ever takes a highlight away. The peak of an additive Blinn-Phong
    term is in the game's own light units and means nothing here, so above the
    commonest value there is nothing more an energy-conserving lobe can do with
    it — and what a surface returns of the world around it is a Fresnel term,
    read separately, so chrome told to take no highlight is still chrome.
    """
    props = {} if stated is None else {"ksSpecular": stated}
    assert _appearance(props)["specularWeight"] == pytest.approx(expected, abs=1e-6), what


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
    # An exponent of 1024 is a very sharp coat but not a perfect one: it is the
    # fourth root of two over it, since `alpha = roughness squared` is what the
    # shader means by the word. Read as the alpha itself it came out below the
    # floor this clamps at, and every clear coat was drawn as a flat mirror.
    assert look["coatRoughness"] == pytest.approx((2 / 1026) ** 0.25, abs=1e-3)
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
@pytest.mark.parametrize("up,meter", [("Z_UP", "1"), ("Y_UP", "0.01")])
def test_the_two_collada_readers_agree(built, tmp_path, up, meter):
    """A `.dae` is read twice over — once here, once in the page — and the two
    have to produce the same records.

    Every other format here is compared to the last bit, and this one cannot
    be. A COLLADA node states a matrix where an FBX states Euler angles, so
    the angles are worked out rather than copied — and `asin` and `atan2` are
    the platform's, so CPython and V8 part company in the last place or two of
    a degree. Measured over thirteen of BeamNG's own cars the worst of it is
    3e-14 degrees, which is a rotation nothing can be turned by.

    So the structure, the names and the arrays are held exactly, and the
    numbers to a relative 1e-9 — tight enough that a wrong axis, a transposed
    matrix or a mixed-up sign fails it, and loose enough to let two libraries
    disagree about a bit.
    """
    import fbxbuild as fb

    path = tmp_path / "scene.dae"
    path.write_bytes(fb.build_dae(up=up, meter=meter))
    # And what a BeamNG car keeps beside its model, which both readers find
    # for themselves rather than being handed.
    (tmp_path / "main.materials.json").write_text(fb.DAE_MATERIALS, encoding="utf-8")

    js = _wasm_dump(str(path))
    python = _python_dump(str(path))
    assert js["warnings"] == []
    assert len(js["nodes"]) == len(python), (
        f"record count differs: js={len(js['nodes'])} python={len(python)}"
    )

    def close(a, b):
        if a == b:
            return True
        if isinstance(a, list) and isinstance(b, list) and len(a) == len(b):
            return all(close(x, y) for x, y in zip(a, b))
        if isinstance(a, (int, float)) and isinstance(b, (int, float)):
            return abs(a - b) <= 1e-9 * max(1.0, abs(a), abs(b))
        return False

    for index, (a, b) in enumerate(zip(python, js["nodes"])):
        assert close(a, b), f"record {index} differs: python={a} js={b}"


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
def test_every_spelling_the_export_is_written_in(built, tmp_path):
    """Three spellings of the same scene, each opened again in the page.

    A `.glb` is one file and is what most things want; a `.gltf` beside a
    `.bin` is the same document with its JSON out where a person can read it;
    an `.fbx` is what the rest of this tool reads, written back out. A format
    nobody can read back is not an export, so each is held against what went
    in — every triangle, every part, every material by name.

    The FBX is then read by the Python side as well, which owes the page
    nothing: a binary FBX is a stream of records that each say where the next
    begins, and an end offset one byte out is a file that parses into nonsense
    rather than one that refuses.
    """
    written = tmp_path / "written"
    written.mkdir()
    files = [str(ROOT / "samples" / "cube_textured.fbx"),
             str(ROOT / "samples" / "scene_parts.fbx")]
    real = real_sample()
    if real:
        files.append(real)
    result = _run(["node", str(WEB / "test" / "exports.js"), str(written), *files],
                  env=_node_env(), timeout=900)
    print(result.stdout)
    assert result.returncode == 0, f"{result.stdout}" + chr(10) + f"{result.stderr}"
    assert "all checks passed" in result.stdout

    from fbxtool import read_fbx

    doc = read_fbx(str(written / "scene_parts.fbx"), load_arrays=True)
    assert doc.format == "fbx" and doc.version == 7400
    assert not doc.warnings, doc.warnings
    objects = doc.root.path("Objects")
    assert len(objects.get_all("Model")) == 3, "one model per part"
    assert len(objects.get_all("Geometry")) == 1, "one cube under three transforms"


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
    # A car whose one texture is a colour under an alpha of nothing, which is
    # what a `.dds` out of Assetto Corsa routinely is and what a canvas
    # destroys: written through one, this exports as a square of black.
    hollow = tmp_path / "hollow.kn5"
    identity = (1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0,
                0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0)
    vertices, indices = fb.kn5_cube(1.0)
    hollow.write_bytes(fb.build_kn5(
        6, textures=[("skin.dds", fb.dds_bgra(4, 4, bytes([25, 50, 200, 0]) * 16))],
        materials=[fb.kn5_material("paint", "ksPerPixel",
                                   slots=(("txDiffuse", 0, "skin.dds"),))],
        tree=fb.kn5_dummy("car", identity,
                          fb.kn5_mesh("body", vertices, indices), 1)))
    files = [str(ROOT / "samples" / "cube_textured.fbx"),
             str(ROOT / "samples" / "scene_parts.fbx"),
             f"{ROOT / 'samples' / 'pyramid.obj'}+{ROOT / 'samples' / 'pyramid.mtl'}"
             f"+{ROOT / 'samples' / 'checker.png'}",
             str(glass), str(basis), str(draco), str(hollow)]
    for real in (real_sample(), real_scene()):
        if real:
            files.append(real)

    kept = tmp_path / "exports"
    kept.mkdir()
    env = dict(_node_env())
    env["FBXTOOL_EXPORT_DIR"] = str(kept)
    result = _run(["node", str(WEB / "test" / "gltf.js"), *files], env=env, timeout=600)
    print(result.stdout)
    assert result.returncode == 0, f"{result.stdout}\n{result.stderr}"
    assert "all checks passed" in result.stdout

    # And the picture that came out, read with the repository's own reader
    # rather than with the page that wrote it.
    from fbxtool import kn5

    images = _glb_images(kept / "hollow.kn5.glb")
    assert len(images) == 1, f"{len(images)} image(s) exported"
    read = kn5._png_pixels(images[0])
    assert read is not None, "the export is not a PNG this can read"
    pixels, width, height = read
    assert (width, height) == (4, 4)
    assert list(pixels[:4]) == [200, 50, 25, 0], \
        "the colour under an empty alpha, which a canvas would have thrown away"


def _glb_images(path) -> list:
    """The bytes of every image a .glb carries in its binary chunk."""
    raw = path.read_bytes()
    json_length = struct.unpack_from("<I", raw, 12)[0]
    document = json.loads(raw[20:20 + json_length].decode("utf-8"))
    binary_at = 20 + json_length + 8
    length = struct.unpack_from("<I", raw, 20 + json_length)[0]
    binary = raw[binary_at:binary_at + length]
    out = []
    for image in document.get("images", []):
        view = document["bufferViews"][image["bufferView"]]
        at = view.get("byteOffset", 0)
        out.append(binary[at:at + view["byteLength"]])
    return out


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
