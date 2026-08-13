"""Tests for the binary reader."""

from __future__ import annotations

import struct

import pytest

import fbxbuild as fb

from fbxtool import ParseError, analyze, detect_format, parse_bytes
from fbxtool.binary import parse_binary


def test_detects_binary():
    data = fb.build_cube()
    assert detect_format(data) == "binary"


@pytest.mark.parametrize("version", [7100, 7400, 7500, 7700])
def test_round_trip_versions(version):
    doc = parse_binary(fb.build_cube(version=version))
    assert doc.encoding == "binary"
    assert doc.version == version
    assert doc.wide_offsets is (version >= 7500)
    assert doc.has_footer
    assert doc.footer_version == version
    assert doc.warnings == []
    assert [node.name for node in doc.top_level] == [
        "FBXHeaderExtension", "FileId", "CreationTime", "Creator",
        "GlobalSettings", "Definitions", "Objects", "Connections",
    ]


def test_scalar_property_types():
    nodes = [fb.N("Scalars", [
        fb.Y(-7), fb.C(True), fb.I(-1234), fb.F(0.5), fb.D(2.25), fb.L(1 << 40),
        fb.S("hello"), fb.R(b"\x00\x01\x02"),
    ])]
    doc = parse_binary(fb.build_binary(nodes))
    values = [prop.value for prop in doc.root.children[0].props]
    assert values == [-7, True, -1234, 0.5, 2.25, 1 << 40, "hello", b"\x00\x01\x02"]
    types = [prop.type_name for prop in doc.root.children[0].props]
    assert types == ["int16", "bool", "int32", "float32", "float64", "int64",
                     "string", "raw"]


@pytest.mark.parametrize("deflate", [False, True])
def test_arrays_are_measured_without_decoding(deflate):
    values = [float(i) for i in range(64)]
    nodes = [fb.N("Mesh", [fb.darr(values, deflate=deflate)])]
    doc = parse_binary(fb.build_binary(nodes))
    prop = doc.root.children[0].props[0]
    assert prop.array is not None
    assert prop.array.length == 64
    assert prop.array.compressed is deflate
    assert prop.array.encoding_name == ("deflate" if deflate else "raw")
    assert prop.value is None  # not decoded by default
    assert prop.type_name == "float64[]"


@pytest.mark.parametrize("deflate", [False, True])
def test_arrays_decode_on_request(deflate):
    values = [float(i) for i in range(64)]
    nodes = [fb.N("Mesh", [fb.darr(values, deflate=deflate)])]
    doc = parse_binary(fb.build_binary(nodes), load_arrays=True)
    assert doc.root.children[0].props[0].value == values


def test_max_array_values_caps_decoding():
    values = list(range(100))
    nodes = [fb.N("Mesh", [fb.iarr(values)])]
    doc = parse_binary(fb.build_binary(nodes), load_arrays=True, max_array_values=10)
    prop = doc.root.children[0].props[0]
    assert prop.array.length == 100
    assert prop.value == list(range(10))


def test_offsets_are_recorded():
    doc = parse_binary(fb.build_cube())
    first = doc.root.children[0]
    assert first.offset == 27  # straight after magic + version
    assert first.end_offset > first.offset
    second = doc.root.children[1]
    assert second.offset == first.end_offset


def test_nested_records_and_terminators():
    nodes = [fb.N("A", [], [fb.N("B", [fb.I(1)], [fb.N("C", [fb.I(2)])])])]
    doc = parse_binary(fb.build_binary(nodes))
    a = doc.root.children[0]
    assert a.path("B", "C").value(0) == 2
    assert doc.warnings == []


def test_missing_magic_is_rejected():
    with pytest.raises(ParseError, match="magic"):
        parse_binary(b"not an fbx file at all, really quite long padding here")


def test_short_file_is_rejected():
    with pytest.raises(ParseError, match="too short"):
        parse_binary(b"Kaydara")


def test_unknown_property_code_is_reported():
    data = bytearray(fb.build_binary([fb.N("A", [fb.I(1)])]))
    index = data.index(b"AI")  # name "A" followed by the 'I' type code
    data[index + 1] = ord("Z")
    with pytest.raises(ParseError, match="unknown property type"):
        parse_binary(bytes(data))


def test_truncated_footer_warns():
    data = fb.build_cube()
    doc = parse_binary(data[:-32])
    assert not doc.has_footer
    assert any("footer" in warning for warning in doc.warnings)


def test_footer_version_mismatch_warns():
    data = bytearray(fb.build_cube(version=7400))
    magic_at = data.rindex(fb.FOOTER_MAGIC)
    struct.pack_into("<I", data, magic_at - 124, 7500)
    doc = parse_binary(bytes(data))
    assert doc.footer_version == 7500
    assert any("footer version" in warning for warning in doc.warnings)


def test_bad_end_offset_warns_but_keeps_parsing():
    data = bytearray(fb.build_binary([fb.N("A", [fb.I(1)]), fb.N("B", [fb.I(2)])]))
    struct.pack_into("<I", data, 27, 10 ** 9)  # A's EndOffset
    doc = parse_binary(bytes(data))
    assert doc.root.children[0].name == "A"
    assert any("out-of-range end offset" in warning for warning in doc.warnings)


def test_analysis_of_generated_cube():
    info = analyze(parse_bytes(fb.build_cube(), path="cube.fbx"))
    assert info.version.stamp == 7400
    assert info.version.product == "FBX 2014 / 2015"
    assert info.header["creator"] == "fbxtool test fixture"
    assert info.header["creation_time"] == "2024-06-14 09:30:15.250"
    assert info.header["file_id"].startswith("000102")
    assert info.scene_info["original_application"] == "Maya"
    assert info.global_settings["up_axis"] == "+Y"
    assert info.global_settings["units"] == "centimetres"
    assert info.global_settings["time_mode"] == "30 fps"
    assert info.global_settings["time_span_seconds"] == pytest.approx(2.0)
    assert info.object_counts["Model (Mesh)"] == 1
    assert info.object_counts["Material"] == 1
    assert len(info.connections) == 4
    assert info.connection_counts["OO"] == 3
    assert info.connection_counts["OP"] == 1
    assert info.media == [
        {"type": "Texture", "name": "file1", "path": "textures/cube_diffuse.png"}
    ]


def test_object_names_are_split_on_the_binary_separator():
    info = analyze(parse_bytes(fb.build_cube()))
    model = next(obj for obj in info.objects if obj.node_type == "Model")
    assert model.name == "pCube1"
    assert model.class_name == "Model"
    assert model.subclass == "Mesh"
    assert model.uid == 2000


def test_geometry_detail_counts_vertices():
    info = analyze(parse_bytes(fb.build_cube()))
    geometry = next(obj for obj in info.objects if obj.node_type == "Geometry")
    assert "8 vertices" in geometry.detail
    assert "24 polygon indices" in geometry.detail
    assert "1 UV set" in geometry.detail


def test_hierarchy_is_rebuilt_from_connections():
    info = analyze(parse_bytes(fb.build_cube()))
    assert len(info.roots) == 1
    top = info.roots[0].children
    assert [node.obj.name for node in top] == ["pCube1"]
    attached = {item.node_type for item in top[0].attachments}
    assert attached == {"Geometry", "Material"}
