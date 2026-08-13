"""Tests for the Blender .blend container reader.

No Blender is required: ``tests/fbxbuild.build_blend`` writes a structurally
faithful file — header, file-blocks and a real SDNA — so the container reader
and the SDNA field-offset arithmetic can be exercised directly.
"""

from __future__ import annotations

import gzip

import pytest

import fbxbuild as fb

from fbxtool import ParseError, analyze, detect_format, parse_blend, parse_bytes
from fbxtool.blend import describe_blender_version


def test_detects_blend():
    assert detect_format(fb.build_blend()) == "blend"


def test_detects_compressed_blend():
    assert detect_format(fb.build_blend(compress=True)) == "blend"


@pytest.mark.parametrize("stamp,expected", [
    (293, "2.93"), (300, "3.0"), (400, "4.0"), (280, "2.8"), (279, "2.79"),
])
def test_version_formatting(stamp, expected):
    assert describe_blender_version(stamp) == expected


@pytest.mark.parametrize("pointer_size", [4, 8])
def test_header_is_read(pointer_size):
    doc = parse_blend(fb.build_blend(pointer_size=pointer_size))
    assert doc.format == "blend"
    assert doc.extra["pointer_size"] == pointer_size
    assert doc.extra["endianness"] == "little"
    assert doc.extra["blender_version"] == 293
    assert doc.extra["blender_version_text"] == "2.93"
    assert doc.warnings == []


def test_blocks_and_dna_are_counted():
    doc = parse_blend(fb.build_blend())
    assert doc.extra["block_count"] == 7          # GLOB, 3 datablocks, DATA, DNA1, ENDB
    assert doc.extra["struct_count"] == 4
    assert doc.extra["type_count"] == 8
    assert doc.extra["name_count"] == 8
    assert doc.extra["block_codes"]["ENDB"] == 1


@pytest.mark.parametrize("pointer_size", [4, 8])
def test_datablock_names_come_from_the_sdna(pointer_size):
    """ID.name sits at a different offset for each pointer width, so the offset
    has to be computed from the file's own SDNA rather than assumed."""
    doc = parse_blend(fb.build_blend(pointer_size=pointer_size))
    info = analyze(doc)
    found = {(o.node_type, o.name, o.subclass) for o in info.objects}
    assert found == {("Object", "Cube", "OB"), ("Mesh", "Cube", "ME"),
                     ("Material", "Red", "MA")}


def test_datablock_names_survive_extra_id_fields():
    """A newer Blender adds fields to ID; names must still be located."""
    doc = parse_blend(fb.build_blend(datablocks=(("OB", "Camera"), ("SC", "Scene"),
                                                 ("IM", "Grid"), ("WO", "World"))))
    names = {o.name for o in analyze(doc).objects}
    assert names == {"Camera", "Scene", "Grid", "World"}


def test_gzip_compressed_files_are_unwrapped():
    doc = parse_blend(fb.build_blend(compress=True))
    assert doc.extra["compression"] == "gzip"
    assert doc.extra["datablocks"] == 3
    assert doc.warnings == []


def test_zstd_compressed_files_are_reported_not_guessed():
    """Blender 3.0+ uses Zstandard when Compress is on; say so plainly."""
    payload = b"\x28\xb5\x2f\xfd" + b"\x00" * 64
    doc = parse_blend(payload)
    assert doc.extra["compression"] == "zstd"
    assert any("Zstandard" in w for w in doc.warnings)


def test_truncated_file_warns():
    doc = parse_blend(fb.build_blend(truncated=True))
    assert any("ENDB" in w for w in doc.warnings)


def test_a_corrupt_dna_block_does_not_stop_the_parse():
    data = bytearray(fb.build_blend())
    index = data.index(b"SDNA")
    data[index:index + 4] = b"XXXX"
    doc = parse_blend(bytes(data))
    assert any("DNA1" in w for w in doc.warnings)
    assert doc.extra["block_count"] == 7      # the container still reads


def test_missing_magic_is_rejected():
    with pytest.raises(ParseError, match="BLENDER"):
        parse_blend(b"not a blend file at all, quite definitely not")


def test_parse_bytes_routes_blend_files():
    doc = parse_bytes(fb.build_blend())
    assert doc.format == "blend"


def test_report_describes_the_container():
    from fbxtool import render_text

    text = render_text(analyze(parse_blend(fb.build_blend())))
    assert "Blender" in text
    assert "2.93" in text
    assert "8 bytes" in text
    assert "4 structs" in text
    # No FBX-only rows should leak into a .blend report.
    assert "Footer" not in text
    assert "Node offsets" not in text
