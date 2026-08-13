"""Tests for the ASCII reader."""

from __future__ import annotations

import math

import pytest

from fbxtool import ParseError, analyze, detect_format, parse_ascii

MINIMAL = """\
; FBX 7.4.0 project file
FBXHeaderExtension:  {
\tFBXVersion: 7400
\tCreator: "unit test"
}
Objects:  {
\tModel: 2000, "Model::pCube1", "Mesh" {
\t\tVersion: 232
\t}
}
"""


def test_detects_ascii():
    assert detect_format(MINIMAL.encode()) == "ascii"


def test_version_from_header_record():
    doc = parse_ascii(MINIMAL)
    assert doc.encoding == "ascii"
    assert doc.version == 7400
    assert doc.version_source == "FBXHeaderExtension"
    assert doc.warnings == []


def test_version_falls_back_to_the_comment():
    text = "; FBX 6.1.0 project file\nObjects:  {\n\tModel: \"Model::x\", \"Mesh\" {\n\t}\n}\n"
    doc = parse_ascii(text)
    assert doc.version == 6100
    assert doc.version_source == "header comment"


def test_unknown_version_warns():
    doc = parse_ascii("Objects:  {\n\tModel: \"Model::x\", \"Mesh\" {\n\t}\n}\n")
    assert doc.version is None
    assert any("version unknown" in warning for warning in doc.warnings)


def test_property_typing():
    doc = parse_ascii('A: 1, -2.5, "text", T, *17\n')
    props = doc.root.children[0].props
    assert [prop.value for prop in props] == [1, -2.5, "text", "T", 17]
    assert [prop.type_name for prop in props] == [
        "int64", "float64", "string", "word", "array-size",
    ]


def test_scientific_notation_and_specials():
    doc = parse_ascii("A: 1e-5, -1.#IND, 1.#INF\n")
    values = [prop.value for prop in doc.root.children[0].props]
    assert values[0] == pytest.approx(1e-5)
    assert math.isnan(values[1])
    assert math.isinf(values[2])


def test_array_records_are_folded():
    doc = parse_ascii("Vertices: *6 {\n\ta: 1,2,3,4,5,6\n}\n")
    vertices = doc.root.children[0]
    assert vertices.props[0].value == 6  # the *6 size marker
    array = vertices.get("a").props[0]
    assert array.array.length == 6
    assert array.value is None
    assert array.type_name == "int64[]"


def test_arrays_decode_on_request():
    doc = parse_ascii("Vertices: *4 {\n\ta: 1.5,2,3,4\n}\n", load_arrays=True)
    assert doc.root.children[0].get("a").props[0].value == [1.5, 2.0, 3.0, 4.0]


def test_multiline_arrays_with_trailing_commas():
    text = "N: *6 {\n\ta: 1,2,3,\n\t\t4,5,6\n}\n"
    doc = parse_ascii(text, load_arrays=True)
    assert doc.root.children[0].get("a").props[0].value == [1, 2, 3, 4, 5, 6]


def test_multiline_arrays_with_leading_commas():
    text = "N: *4 {\n\ta: 1,2\n\t\t,3,4\n}\n"
    doc = parse_ascii(text, load_arrays=True)
    assert doc.root.children[0].get("a").props[0].value == [1, 2, 3, 4]


def test_comments_and_blank_lines_are_ignored():
    text = "; leading comment\n\nA: 1  ; trailing comment\n; another\nB: 2\n"
    doc = parse_ascii(text)
    assert [node.name for node in doc.root.children] == ["A", "B"]


def test_semicolon_inside_a_string_is_kept():
    doc = parse_ascii('A: "a;b"\n')
    assert doc.root.children[0].value(0) == "a;b"


def test_escaped_quotes():
    doc = parse_ascii('A: "say &quot;hi&quot;"\n')
    assert doc.root.children[0].value(0) == 'say "hi"'


def test_line_numbers_are_recorded():
    doc = parse_ascii(MINIMAL)
    header = doc.root.children[0]
    assert header.line == 2
    assert header.get("FBXVersion").line == 3


def test_unterminated_string_is_an_error():
    with pytest.raises(ParseError, match="unterminated string"):
        parse_ascii('A: "oops\n')


def test_unclosed_brace_warns():
    doc = parse_ascii("A: 1 {\n\tB: 2\n")
    assert doc.root.children[0].get("B").value(0) == 2
    assert any("unclosed" in warning for warning in doc.warnings)


def test_stray_close_brace_warns():
    doc = parse_ascii("A: 1\n}\nB: 2\n")
    assert [node.name for node in doc.root.children] == ["A", "B"]
    assert any("stray" in warning for warning in doc.warnings)


def test_record_without_colon_is_skipped():
    doc = parse_ascii("A 1\nB: 2\n")
    assert [node.name for node in doc.root.children] == ["B"]
    assert any("not followed by ':'" in warning for warning in doc.warnings)


def test_bom_is_stripped():
    doc = parse_ascii("﻿" + MINIMAL)
    assert doc.root.children[0].name == "FBXHeaderExtension"


def test_analysis_of_ascii_sample(sample_ascii_path):
    from fbxtool import read_fbx

    info = analyze(read_fbx(sample_ascii_path))
    assert info.doc.encoding == "ascii"
    assert info.version.stamp == 7300
    assert info.version.product == "FBX 2013"
    assert info.header["creator"] == "fbxtool sample writer"
    assert info.header["creation_time"] == "2024-06-14 09:30:15.250"
    assert info.scene_info["original_application"] == "Maya"
    assert info.scene_info["title"] == "Test cube"
    assert info.global_settings["up_axis"] == "+Y"
    assert info.global_settings["units"] == "centimetres"
    assert info.global_settings["original_unit_scale"] == 2.54
    assert info.definitions_count == 6
    assert info.expected_object_count == 5  # GlobalSettings is not in Objects
    assert info.object_counts["Model (Mesh)"] == 2
    assert len(info.connections) == 5
    assert info.doc.warnings == []


def test_ascii_object_names_use_the_double_colon_form(sample_ascii_path):
    from fbxtool import read_fbx

    info = analyze(read_fbx(sample_ascii_path))
    model = next(obj for obj in info.objects if obj.uid == 2000)
    assert (model.name, model.class_name, model.subclass) == ("pCube1", "Model", "Mesh")


def test_ascii_hierarchy_nests_children(sample_ascii_path):
    from fbxtool import read_fbx

    info = analyze(read_fbx(sample_ascii_path))
    root = info.roots[0]
    assert [node.obj.name for node in root.children] == ["pCube1"]
    assert [node.obj.name for node in root.children[0].children] == ["pCubeChild"]


def test_ascii_geometry_arrays_are_counted(sample_ascii_path):
    from fbxtool import read_fbx

    info = analyze(read_fbx(sample_ascii_path))
    geometry = next(obj for obj in info.objects if obj.node_type == "Geometry")
    assert "8 vertices" in geometry.detail
    assert "24 polygon indices" in geometry.detail


LEGACY_6100 = """\
; FBX 6.1.0 project file
FBXHeaderExtension:  {
\tFBXHeaderExtensionVersion: 3000
\tFBXVersion: 6100
\tCreator: "FBX SDK/FBX Plugins build 20080212"
}
CreationTime: "2009-08-11 17:15:23:000"
Creator: "FBX SDK/FBX Plugins build 20080212"
Objects:  {
\tModel: "Model::pCube1", "Mesh" {
\t\tVersion: 232
\t\tShading: Y
\t\tCulling: "CullingOff"
\t}
\tModel: "Model::pCubeChild", "Mesh" {
\t\tVersion: 232
\t}
\tMaterial: "Material::lambert1", "" {
\t\tVersion: 102
\t\tShadingModel: "lambert"
\t}
}
Relations:  {
\tModel: "Model::pCube1", "Mesh" {
\t}
}
Connections:  {
\tConnect: "OO", "Model::pCube1", "Model::Scene"
\tConnect: "OO", "Model::pCubeChild", "Model::pCube1"
\tConnect: "OO", "Material::lambert1", "Model::pCube1"
}
Takes:  {
\tCurrent: "Take 001"
\tTake: "Take 001" {
\t\tFileName: "Take_001.tak"
\t}
}
"""


def test_legacy_6100_layout():
    info = analyze(parse_ascii(LEGACY_6100))
    assert info.version.stamp == 6100
    assert info.version.legacy_layout is True
    assert info.header["creation_time"] == "2009-08-11 17:15:23:000"
    assert info.object_counts["Model (Mesh)"] == 2
    assert len(info.connections) == 3


def test_legacy_objects_have_no_uid():
    info = analyze(parse_ascii(LEGACY_6100))
    model = next(obj for obj in info.objects if obj.name == "pCube1")
    assert model.uid is None
    assert model.class_name == "Model"
    assert model.subclass == "Mesh"


def test_legacy_hierarchy_is_built_from_names():
    info = analyze(parse_ascii(LEGACY_6100))
    root = info.roots[0]
    assert [node.obj.name for node in root.children] == ["pCube1"]
    child_names = [node.obj.name for node in root.children[0].children]
    assert child_names == ["pCubeChild"]
    assert [item.name for item in root.children[0].attachments] == ["lambert1"]


def test_legacy_takes_are_reported():
    info = analyze(parse_ascii(LEGACY_6100))
    assert info.animation["takes"] == ["Take 001"]
    assert info.animation["current_take"] == "Take 001"
