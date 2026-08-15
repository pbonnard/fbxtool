"""Tests for the Wavefront OBJ reader."""

from __future__ import annotations

import pytest

from fbxtool import analyze, detect_format, parse_bytes, parse_mtl, parse_obj, read_model

SIMPLE = """\
# a triangle
v 0 0 0
v 1 0 0
v 0 1 0
f 1 2 3
"""

FULL = """\
# exported by something
mtllib scene.mtl
o Plate
g top
v -1 0 -1
v  1 0 -1
v  1 0  1
v -1 0  1
vt 0 0
vt 1 0
vt 1 1
vt 0 1
vn 0 1 0
s 1
usemtl Metal
f 1/1/1 2/2/1 3/3/1 4/4/1
"""

MTL = """\
newmtl Metal
Kd 0.30 0.60 0.90
Ks 1.0 1.0 1.0
Ns 96
map_Kd  -s 1 1 1  metal_diffuse.png

newmtl Unused
Kd 1 0 0
"""


def test_detects_obj():
    assert detect_format(SIMPLE.encode()) == "obj"
    assert detect_format(FULL.encode()) == "obj"


def test_a_comment_only_file_is_not_obj():
    assert detect_format(b"# just a comment\n# and another\n") != "obj"


def test_prose_is_not_obj():
    assert detect_format(b"the quick brown fox\njumps over it\n") == "unknown"


def test_simple_triangle():
    doc = parse_obj(SIMPLE, load_arrays=True)
    assert doc.format == "obj"
    assert doc.warnings == []
    geometry = doc.root.path("Objects", "Geometry")
    assert geometry.get("Vertices").props[0].array.length == 9
    # The last index of each polygon is stored as its complement.
    assert geometry.get("PolygonVertexIndex").props[0].value == [0, 1, -3]


def test_quad_keeps_four_corners():
    doc = parse_obj(FULL, materials=MTL, load_arrays=True)
    indices = doc.root.path("Objects", "Geometry", "PolygonVertexIndex").props[0].value
    assert indices == [0, 1, 2, -4]


@pytest.mark.parametrize("face,expected", [
    ("f 1 2 3", [0, 1, -3]),                 # positions only
    ("f 1/1 2/2 3/3", [0, 1, -3]),           # positions and UVs
    ("f 1//1 2//1 3//1", [0, 1, -3]),        # positions and normals
    ("f 1/1/1 2/2/1 3/3/1", [0, 1, -3]),     # all three
    ("f -3 -2 -1", [0, 1, -3]),              # relative indices
])
def test_face_syntaxes(face, expected):
    text = "v 0 0 0\nv 1 0 0\nv 0 1 0\nvt 0 0\nvt 1 0\nvt 0 1\nvn 0 0 1\n" + face + "\n"
    doc = parse_obj(text, load_arrays=True)
    assert doc.warnings == []
    indices = doc.root.path("Objects", "Geometry", "PolygonVertexIndex").props[0].value
    assert indices == expected


def test_uv_and_normal_layers_are_indexed():
    doc = parse_obj(FULL, materials=MTL, load_arrays=True)
    geometry = doc.root.path("Objects", "Geometry")
    uv = geometry.get("LayerElementUV")
    assert uv.path_value("ReferenceInformationType") == "IndexToDirect"
    assert uv.get("UVIndex").props[0].value == [0, 1, 2, 3]
    normal = geometry.get("LayerElementNormal")
    assert normal.path_value("MappingInformationType") == "ByPolygonVertex"
    assert normal.get("NormalsIndex").props[0].value == [0, 0, 0, 0]


def test_geometry_without_uvs_omits_the_layer():
    doc = parse_obj(SIMPLE)
    geometry = doc.root.path("Objects", "Geometry")
    assert geometry.get("LayerElementUV") is None
    assert geometry.get("LayerElementNormal") is None


def test_out_of_range_index_warns_and_continues():
    doc = parse_obj("v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 99\n", load_arrays=True)
    assert any("out of range" in w for w in doc.warnings)
    assert doc.root.path("Objects", "Geometry", "PolygonVertexIndex").props[0].value


def test_degenerate_face_is_skipped():
    doc = parse_obj("v 0 0 0\nv 1 0 0\nf 1 2\n")
    assert any("fewer than three corners" in w for w in doc.warnings)


def test_empty_file_warns():
    doc = parse_obj("# nothing here\n")
    assert any("no vertices" in w for w in doc.warnings)


# ---------------------------------------------------------------- materials


def test_mtl_parsing():
    materials, warnings = parse_mtl(MTL)
    assert warnings == []
    assert [m.name for m in materials] == ["Metal", "Unused"]
    assert materials[0].diffuse == pytest.approx((0.30, 0.60, 0.90))
    assert materials[0].shininess == 96
    # Option flags before the filename must not be taken as part of it.
    assert materials[0].diffuse_map == "metal_diffuse.png"


def test_mtl_property_before_newmtl_warns():
    _, warnings = parse_mtl("Kd 1 1 1\nnewmtl Late\n")
    assert any("before any newmtl" in w for w in warnings)


def test_materials_become_records_with_colours():
    info = analyze(parse_obj(FULL, materials=MTL))
    material = next(o for o in info.objects if o.node_type == "Material")
    assert material.name == "Metal"
    from fbxtool.analyze import _properties
    assert _properties(material.node)["DiffuseColor"] == pytest.approx([0.30, 0.60, 0.90])


def test_texture_becomes_a_texture_and_video_pair():
    info = analyze(parse_obj(FULL, materials=MTL))
    assert info.object_counts["Texture"] == 1
    assert info.object_counts["Video (Clip)"] == 1
    assert info.media[0]["path"] == "metal_diffuse.png"
    # The texture must drive DiffuseColor, which is how the viewer finds it.
    assert any(c.kind == "OP" and c.prop == "DiffuseColor" for c in info.connections)


def test_materials_used_but_not_defined_still_get_a_slot():
    doc = parse_obj(FULL, materials="newmtl Other\nKd 1 1 1\n")
    info = analyze(doc)
    assert info.object_counts["Material"] == 1
    assert any("not defined" in w for w in doc.warnings)


def test_material_order_follows_first_use():
    text = ("v 0 0 0\nv 1 0 0\nv 0 1 0\n"
            "usemtl Second\nf 1 2 3\nusemtl First\nf 1 2 3\nusemtl Second\nf 1 2 3\n")
    doc = parse_obj(text, materials="newmtl First\nKd 1 0 0\nnewmtl Second\nKd 0 1 0\n",
                    load_arrays=True)
    info = analyze(doc)
    names = [o.name for o in info.objects if o.node_type == "Material"]
    assert names == ["Second", "First"]
    # Faces index that order, not the order the .mtl happens to define.
    materials = doc.root.path("Objects", "Geometry", "LayerElementMaterial")
    assert materials.get("Materials").props[0].value == [0, 1, 0]


# ------------------------------------------------------------------ on disk


def test_reading_from_disk_picks_up_the_sibling_mtl(sample_obj_path):
    doc = read_model(sample_obj_path)
    assert doc.format == "obj"
    assert doc.warnings == []
    assert doc.extra["materials_resolved"] == 2
    assert doc.extra["objects"] == ["Pyramid"]


def test_the_sample_analyses_like_any_other_scene(sample_obj_path):
    info = analyze(read_model(sample_obj_path))
    assert info.object_counts["Geometry (Mesh)"] == 1
    assert info.object_counts["Material"] == 2
    geometry = next(o for o in info.objects if o.node_type == "Geometry")
    assert "5 vertices" in geometry.detail
    assert info.roots[0].children[0].obj.name == "Pyramid"


def test_missing_mtl_is_reported_not_fatal(tmp_path):
    path = tmp_path / "lonely.obj"
    path.write_text("mtllib nowhere.mtl\nv 0 0 0\nv 1 0 0\nv 0 1 0\nusemtl X\nf 1 2 3\n")
    doc = read_model(str(path))
    assert doc.extra["libraries"] == ["nowhere.mtl"]
    assert doc.extra["materials_resolved"] == 0
    assert analyze(doc).object_counts["Material"] == 1


def test_parse_bytes_handles_obj():
    doc = parse_bytes(SIMPLE.encode())
    assert doc.format == "obj"

# ------------------------------------------------------------------- parts

GROUPED = """v 0 0 0
v 1 0 0
v 0 1 0
v 2 0 0
vt 0 0
vt 1 0
vt 0 1
vn 0 0 1
g A
usemtl Red
f 1/1/1 2/2/1 3/3/1
g B
usemtl Blue
f 1/1/1 2/2/1 4/3/1
"""


def test_groups_become_parts():
    """A car written as 164 groups is 164 parts, which is what lets it be
    exploded, picked at, edited part by part, and matched against the same
    scene saved in another format."""
    info = analyze(parse_obj(GROUPED, load_arrays=True))
    models = [o.name for o in info.objects if o.node_type == "Model"]
    assert models == ["A", "B"]
    assert sum(1 for o in info.objects if o.node_type == "Geometry") == 2


def test_a_part_carries_only_the_vertices_it_uses():
    """OBJ indexes one pool from anywhere in the file, so a part is gathered
    and renumbered rather than sliced."""
    doc = parse_obj(GROUPED, load_arrays=True)
    geometries = [c for c in doc.root.get("Objects").children if c.name == "Geometry"]
    for geometry in geometries:
        vertices = geometry.get("Vertices").props[0].value
        polygons = geometry.get("PolygonVertexIndex").props[0].value
        assert len(vertices) == 9, "three corners, and none of the others"
        for written in polygons:
            index = ~written if written < 0 else written
            assert 0 <= index < 3


def test_a_file_naming_no_parts_is_still_one_part():
    """Only a change of name starts another, so a file with no `o` or `g` at
    all does not come apart at every face."""
    info = analyze(parse_obj(FULL, load_arrays=True))
    assert sum(1 for o in info.objects if o.node_type == "Model") == 1


def test_every_part_sees_the_whole_palette():
    """A per-polygon material index counts the materials connected to that
    part's own model, so the numbering only holds if each sees the same list."""
    doc = parse_obj(GROUPED, load_arrays=True,
                    materials="newmtl Red\nKd 1 0 0\nnewmtl Blue\nKd 0 0 1\n")
    info = analyze(doc)
    models = [o for o in info.objects if o.node_type == "Model"]
    for model in models:
        worn = [c for c in info.connections
                if c.kind == "OO" and c.dst == model.uid]
        assert len(worn) == 3, "two materials and the geometry"
