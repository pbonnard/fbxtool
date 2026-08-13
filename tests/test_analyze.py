"""Tests for the scene-level interpretation."""

from __future__ import annotations

import pytest

import fbxbuild as fb

from fbxtool import analyze, parse_ascii, parse_bytes, read_fbx
from fbxtool.analyze import FBX_TIME_UNIT, split_object_name


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("pCube1\x00\x01Model", ("pCube1", "Model")),
        ("Model::pCube1", ("pCube1", "Model")),
        ("Geometry\x00\x01Geometry", ("Geometry", "Geometry")),
        ("Geometry::", ("", "Geometry")),
        ("bare", ("bare", "")),
        (None, ("", "")),
        (1234, ("", "")),
    ],
)
def test_split_object_name(raw, expected):
    assert split_object_name(raw) == expected


def test_axis_signs_are_applied():
    text = """\
FBXHeaderExtension:  {
\tFBXVersion: 7400
}
GlobalSettings:  {
\tProperties70:  {
\t\tP: "UpAxis", "int", "Integer", "",2
\t\tP: "UpAxisSign", "int", "Integer", "",-1
\t\tP: "FrontAxis", "int", "Integer", "",1
\t\tP: "FrontAxisSign", "int", "Integer", "",1
\t\tP: "CoordAxis", "int", "Integer", "",0
\t\tP: "CoordAxisSign", "int", "Integer", "",-1
\t\tP: "UnitScaleFactor", "double", "Number", "",2.54
\t\tP: "TimeMode", "enum", "", "",11
\t}
}
"""
    info = analyze(parse_ascii(text))
    assert info.global_settings["up_axis"] == "-Z"
    assert info.global_settings["front_axis"] == "+Y"
    assert info.global_settings["coord_axis"] == "-X"
    assert info.global_settings["units"] == "inches"
    assert info.global_settings["time_mode"] == "24 fps (cinema)"


def test_unknown_time_mode_and_unit_are_still_reported():
    text = """\
GlobalSettings:  {
\tProperties70:  {
\t\tP: "UnitScaleFactor", "double", "Number", "",7.5
\t\tP: "TimeMode", "enum", "", "",99
\t}
}
"""
    info = analyze(parse_ascii(text))
    assert info.global_settings["units"] == "custom"
    assert info.global_settings["time_mode"] == "mode 99"


def test_definitions_mismatch_is_visible():
    text = """\
Definitions:  {
\tCount: 9
\tObjectType: "Model" {
\t\tCount: 1
\t}
}
Objects:  {
\tModel: 1, "Model::a", "Mesh" {
\t}
}
"""
    info = analyze(parse_ascii(text))
    assert info.definitions_count == 9
    assert info.object_count == 1
    assert info.definitions[0] == {
        "type": "Model", "count": 1, "template": None, "template_properties": 0,
    }


def test_hierarchy_without_a_scene_root_falls_back_to_top_models():
    text = """\
Objects:  {
\tModel: 10, "Model::parent", "Null" {
\t}
\tModel: 11, "Model::child", "Mesh" {
\t}
}
Connections:  {
\tC: "OO",11,10
}
"""
    info = analyze(parse_ascii(text))
    assert info.roots, "expected a fallback root"
    assert "no scene root" in info.roots[0].label
    assert [node.obj.name for node in info.roots[0].children] == ["parent"]
    assert [node.obj.name for node in info.roots[0].children[0].children] == ["child"]


def test_models_with_no_connections_are_listed_as_unparented():
    text = """\
Objects:  {
\tModel: 10, "Model::lonely", "Mesh" {
\t}
}
"""
    info = analyze(parse_ascii(text))
    assert [obj.name for obj in info.orphans] == ["lonely"]


def test_connection_cycles_do_not_hang():
    text = """\
Objects:  {
\tModel: 10, "Model::a", "Mesh" {
\t}
\tModel: 11, "Model::b", "Mesh" {
\t}
}
Connections:  {
\tC: "OO",10,0
\tC: "OO",11,10
\tC: "OO",10,11
}
"""
    info = analyze(parse_ascii(text))
    names = {node.obj.name for node in info.roots[0].children}
    assert names == {"a"}


def test_animation_objects_are_summarised():
    text = f"""\
Objects:  {{
\tAnimationStack: 100, "AnimStack::Take 001", "" {{
\t\tProperties70:  {{
\t\t\tP: "LocalStart", "KTime", "Time", "",0
\t\t\tP: "LocalStop", "KTime", "Time", "",{FBX_TIME_UNIT * 3}
\t\t}}
\t}}
\tAnimationLayer: 101, "AnimLayer::BaseLayer", "" {{
\t}}
\tAnimationCurveNode: 102, "AnimCurveNode::T", "" {{
\t}}
\tAnimationCurve: 103, "AnimCurve::", "" {{
\t\tKeyTime: *4 {{
\t\t\ta: 0,1539538600,3079077200,4618615800
\t\t}}
\t}}
}}
"""
    info = analyze(parse_ascii(text))
    assert info.animation["AnimationStack"] == 1
    assert info.animation["AnimationLayer"] == 1
    assert info.animation["AnimationCurve"] == 1
    assert info.animation["stacks"][0]["name"] == "Take 001"
    assert info.animation["stacks"][0]["duration_seconds"] == pytest.approx(3.0)
    curve = next(obj for obj in info.objects if obj.node_type == "AnimationCurve")
    assert curve.detail == "4 keys"


def test_deformer_detail():
    text = """\
Objects:  {
\tDeformer: 200, "SubDeformer::skinCluster1", "Cluster" {
\t\tIndexes: *3 {
\t\t\ta: 0,1,2
\t\t}
\t}
}
"""
    info = analyze(parse_ascii(text))
    assert info.objects[0].detail == "3 weighted vertices"
    assert info.objects[0].kind == "Deformer (Cluster)"


def test_media_paths_are_collected():
    text = """\
Objects:  {
\tVideo: 300, "Video::clip", "Clip" {
\t\tRelativeFilename: "movies/clip.avi"
\t}
\tTexture: 301, "Texture::tex", "" {
\t\tFileName: "/abs/tex.png"
\t}
}
"""
    info = analyze(parse_ascii(text))
    assert info.media == [
        {"type": "Video", "name": "clip", "path": "movies/clip.avi"},
        {"type": "Texture", "name": "tex", "path": "/abs/tex.png"},
    ]


def test_property_histogram_counts_every_property():
    info = analyze(parse_bytes(fb.build_cube()))
    assert info.property_counts["float64[]"] == 1
    assert info.property_counts["int32[]"] == 1
    assert info.property_counts["raw"] == 1
    assert sum(info.property_counts.values()) > 100
    assert info.array_bytes > 0


def test_section_record_counts_include_the_section_itself():
    info = analyze(parse_bytes(fb.build_binary([fb.N("A", [], [fb.N("B"), fb.N("C")])])))
    assert info.sections == [("A", 3)]
    assert info.total_records == 3
    assert info.max_depth == 2


def test_empty_document_analyses_cleanly():
    info = analyze(parse_ascii("; FBX 7.4.0 project file\n"))
    assert info.object_count == 0
    assert info.roots == []
    assert info.sections == []
    assert info.version.stamp == 7400


def test_memory_mapped_reads_match_in_memory_reads(tmp_path, monkeypatch):
    """Files past the mmap threshold take a different code path in the reader."""
    from fbxtool import reader

    padding = [fb.N(f"Filler{index}", [fb.darr([float(index)] * 512, deflate=True)])
               for index in range(32)]
    data = fb.build_binary(fb.cube_nodes() + padding)
    path = tmp_path / "big.fbx"
    path.write_bytes(data)

    monkeypatch.setattr(reader, "_MMAP_THRESHOLD", 1024)
    assert path.stat().st_size > 1024
    mapped = analyze(read_fbx(str(path), load_arrays=True))

    monkeypatch.setattr(reader, "_MMAP_THRESHOLD", 1 << 40)
    in_memory = analyze(read_fbx(str(path), load_arrays=True))

    assert mapped.doc.warnings == in_memory.doc.warnings == []
    assert mapped.object_count == in_memory.object_count == 4
    assert mapped.total_records == in_memory.total_records
    assert mapped.roots[0].children[0].obj.name == "pCube1"
    first = mapped.doc.root.get("Filler0").props[0]
    assert first.array.compressed and first.value == [0.0] * 512


@pytest.mark.parametrize("version", [7400, 7500])
def test_both_offset_widths_produce_the_same_scene(version):
    info = analyze(parse_bytes(fb.build_cube(version=version)))
    assert info.doc.wide_offsets is (version >= 7500)
    assert info.object_counts["Model (Mesh)"] == 1
    assert info.roots[0].children[0].obj.uid == 2000
    assert info.doc.warnings == []


# ------------------------------------------------------------------ templates


TEMPLATE_TEXT = """\
FBXHeaderExtension:  {
\tFBXVersion: 7400
}
Definitions:  {
\tObjectType: "Material" {
\t\tCount: 2
\t\tPropertyTemplate: "FbxSurfacePhong" {
\t\t\tProperties70:  {
\t\t\t\tP: "DiffuseColor", "Color", "", "A",0.8,0.1,0.05
\t\t\t\tP: "ShininessExponent", "Number", "", "A",20
\t\t\t}
\t\t}
\t}
\tObjectType: "Model" {
\t\tCount: 1
\t\tPropertyTemplate: "FbxNode" {
\t\t\tProperties70:  {
\t\t\t\tP: "Visibility", "Visibility", "", "A",1
\t\t\t}
\t\t}
\t}
\tObjectType: "Geometry" {
\t\tCount: 1
\t}
}
Objects:  {
\tMaterial: 3001, "Material::plain", "" {
\t\tShadingModel: "phong"
\t}
\tMaterial: 3002, "Material::painted", "" {
\t\tShadingModel: "phong"
\t\tProperties70:  {
\t\t\tP: "DiffuseColor", "Color", "", "A",0,0.5,1
\t\t}
\t}
}
Connections:  {
}
"""


def test_property_templates_are_read():
    from fbxtool.analyze import property_templates

    info = analyze(parse_ascii(TEMPLATE_TEXT))
    templates = property_templates(info.doc.root)
    assert templates["Material"]["DiffuseColor"] == [0.8, 0.1, 0.05]
    assert templates["Material"]["ShininessExponent"] == 20
    assert templates["Model"]["Visibility"] == 1
    # An ObjectType without a template contributes nothing.
    assert "Geometry" not in templates
    assert info.templates == templates


def test_resolved_properties_fall_back_to_the_template():
    """A material with no Properties70 still has the type's default colour."""
    from fbxtool.analyze import resolved_properties

    info = analyze(parse_ascii(TEMPLATE_TEXT))
    plain = next(o for o in info.objects if o.name == "plain")
    painted = next(o for o in info.objects if o.name == "painted")

    assert resolved_properties(plain, info.templates)["DiffuseColor"] == [0.8, 0.1, 0.05]
    # An object's own value wins, and it still inherits what it does not set.
    resolved = resolved_properties(painted, info.templates)
    assert resolved["DiffuseColor"] == [0, 0.5, 1]
    assert resolved["ShininessExponent"] == 20


def test_resolved_properties_without_templates():
    from fbxtool.analyze import resolved_properties

    info = analyze(parse_bytes(fb.build_cube()))
    model = next(o for o in info.objects if o.node_type == "Model")
    assert resolved_properties(model, {})["Lcl Translation"] == [0.0, 1.0, 0.0]


def test_scene_fixture_describes_its_parts():
    """The multi-part fixture: one geometry instanced by three placed models."""
    info = analyze(parse_bytes(fb.build_scene()))
    assert info.doc.warnings == []
    assert info.object_counts["Model (Mesh)"] == 3
    assert info.object_counts["Geometry (Mesh)"] == 1

    models = {o.name: o for o in info.objects if o.node_type == "Model"}
    assert set(models) == {"hub", "arm", "mirror"}
    # The geometry is connected to every one of them.
    geometry = next(o for o in info.objects if o.node_type == "Geometry")
    owners = [c.dst for c in info.connections if c.src == geometry.uid]
    assert sorted(owners) == sorted(m.uid for m in models.values())

    from fbxtool.analyze import resolved_properties

    for material in (o for o in info.objects if o.node_type == "Material"):
        colour = resolved_properties(material, info.templates)["DiffuseColor"]
        assert colour == list(fb.SCENE_DIFFUSE)


def test_glass_fixture_marks_one_material_see_through():
    """Both spellings of transparency, so either reader path is covered."""
    info = analyze(parse_bytes(fb.build_glass()))
    assert info.doc.warnings == []
    assert info.object_counts["Model (Mesh)"] == 2

    from fbxtool.analyze import resolved_properties

    looks = {o.name: resolved_properties(o, info.templates)
             for o in info.objects if o.node_type == "Material"}
    assert looks["paint"].get("Opacity") is None
    assert looks["glass"]["Opacity"] == pytest.approx(fb.GLASS_OPACITY)
    assert looks["glass"]["TransparencyFactor"] == pytest.approx(1 - fb.GLASS_OPACITY)
