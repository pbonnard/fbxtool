"""Tests for the Blender .blend container reader.

No Blender is required: ``tests/fbxbuild.build_blend`` writes a structurally
faithful file — header, file-blocks and a real SDNA — so the container reader
and the SDNA field-offset arithmetic can be exercised directly.
"""

from __future__ import annotations

import gzip
import math

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
    assert doc.extra["block_count"] > 5
    assert doc.extra["struct_count"] == 8
    assert doc.extra["block_codes"]["ENDB"] == 1
    assert doc.extra["block_codes"]["DATA"] == 5   # verts, polys, loops, uvs, mat


@pytest.mark.parametrize("pointer_size", [4, 8])
def test_datablock_names_come_from_the_sdna(pointer_size):
    """ID.name sits at a different offset for each pointer width, so the offset
    has to be computed from the file's own SDNA rather than assumed."""
    info = analyze(parse_blend(fb.build_blend(pointer_size=pointer_size)))
    names = {(o.node_type, o.name) for o in info.objects}
    assert ("Object", "Cube") in names
    assert ("Material", "Red") in names
    assert ("Geometry", "Cube") in names


def test_every_id_type_is_named():
    doc = parse_blend(fb.build_blend(
        datablocks=(("OB", "Camera"), ("SC", "Scene"), ("IM", "Grid"), ("WO", "World")),
        with_mesh=False))
    names = {o.name for o in analyze(doc).objects}
    assert {"Camera", "Scene", "Grid", "World"} <= names


def test_gzip_and_datablock_counts():
    doc = parse_blend(fb.build_blend(compress=True))
    assert doc.extra["compression"] == "gzip"
    assert doc.extra["datablocks"] >= 3
    assert doc.warnings == []


# ------------------------------------------------------------------- meshes


@pytest.mark.parametrize("pointer_size", [4, 8])
def test_mesh_geometry_is_extracted(pointer_size):
    """MVert/MPoly/MLoop are reached by pointer; every offset comes from SDNA."""
    doc = parse_blend(fb.build_blend(pointer_size=pointer_size), load_arrays=True)
    assert doc.warnings == []
    geometry = doc.root.path("Objects", "Geometry")
    assert geometry is not None
    vertices = geometry.get("Vertices").props[0]
    assert vertices.array.length == 24                       # eight corners
    assert vertices.value[:3] == [-1.0, -1.0, -1.0]
    indices = geometry.get("PolygonVertexIndex").props[0]
    assert indices.array.length == 24                        # six quads
    # Each polygon's last index is complemented, as FBX writes them.
    assert indices.value[:4] == [0, 1, 2, -4]


def test_polygons_carry_uvs_and_material_slots():
    doc = parse_blend(fb.build_blend(), load_arrays=True)
    geometry = doc.root.path("Objects", "Geometry")
    uv = geometry.get("LayerElementUV")
    assert uv.path_value("MappingInformationType") == "ByPolygonVertex"
    assert uv.get("UV").props[0].array.length == 48           # two per loop
    materials = geometry.get("LayerElementMaterial")
    assert materials.path_value("MappingInformationType") == "ByPolygon"
    assert len(materials.get("Materials").props[0].value) == 6


def test_counts_are_reported_without_decoding():
    """The default path reports sizes without materialising the arrays."""
    doc = parse_blend(fb.build_blend())
    vertices = doc.root.path("Objects", "Geometry", "Vertices").props[0]
    assert vertices.array.length == 24
    assert vertices.value is None


def test_material_slot_order_drives_the_hierarchy():
    doc = parse_blend(fb.build_blend(datablocks=(("MA", "Red"), ("MA", "Blue"))))
    info = analyze(doc)
    attached = [a.name for a in info.roots[0].children[0].attachments
                if a.node_type == "Material"]
    assert attached == ["Red", "Blue"]


def test_material_colours_are_read():
    from fbxtool.analyze import _properties

    info = analyze(parse_blend(fb.build_blend()))
    material = next(o for o in info.objects if o.node_type == "Material")
    assert _properties(material.node)["DiffuseColor"] == pytest.approx([0.9, 0.1, 0.1])


def test_a_version_without_the_mvert_layout_is_reported():
    """Blender 3.6 deprecated MVert and 4.0 removed it; say so rather than
    misreading whatever happens to sit at those offsets."""
    doc = parse_blend(fb.build_blend(with_mesh=False))
    # No ME block at all here, so nothing is claimed either way.
    assert doc.extra.get("meshes", 0) == 0
    assert doc.root.path("Objects", "Geometry") is None


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
    assert doc.extra["block_count"] > 5       # the container still reads


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
    assert "8 structs" in text
    # No FBX-only rows should leak into a .blend report.
    assert "Footer" not in text
    assert "Node offsets" not in text


def test_real_file_geometry_matches_its_fbx_export(real_blend_path, real_fbx_path):
    """The strongest check available: the same model in two formats, read by
    two independent parsers, must yield identical geometry."""
    from fbxtool import read_model

    blend = read_model(real_blend_path, load_arrays=True)
    fbx = read_model(real_fbx_path, load_arrays=True)

    geometries = [g for g in blend.root.get("Objects").children if g.name == "Geometry"]
    biggest = max(geometries, key=lambda g: g.get("Vertices").props[0].array.length)
    from_blend = biggest.get("Vertices").props[0].value
    from_fbx = fbx.root.path("Objects", "Geometry", "Vertices").props[0].value

    assert len(from_blend) == len(from_fbx)
    for axis in range(3):
        assert min(from_blend[axis::3]) == pytest.approx(min(from_fbx[axis::3]), abs=1e-3)
        assert max(from_blend[axis::3]) == pytest.approx(max(from_fbx[axis::3]), abs=1e-3)

    indices = biggest.get("PolygonVertexIndex").props[0]
    fbx_indices = fbx.root.path("Objects", "Geometry", "PolygonVertexIndex").props[0]
    assert indices.array.length == fbx_indices.array.length


def test_material_look_maps_blender_shading_onto_fbx_properties():
    """Metalness, roughness and specular become a diffuse/specular pair."""
    from fbxtool.blend import material_look

    plastic = material_look((0.8, 0.1, 0.1), metallic=0.0, roughness=0.4, specular=0.5)
    assert plastic["colour"] == (0.8, 0.1, 0.1)
    # A dielectric reflects 8% of its specular value, so 0.5 gives the usual 0.04.
    assert plastic["specular"] == pytest.approx((0.04, 0.04, 0.04))
    # The exponent round-trips: sqrt(2 / (e + 2)) gives the roughness back.
    assert plastic["shininess"] == pytest.approx(2 / 0.4**2 - 2)
    assert math.sqrt(2 / (plastic["shininess"] + 2)) == pytest.approx(0.4)

    metal = material_look((0.9, 0.8, 0.5), metallic=1.0, roughness=0.2)
    assert metal["colour"] == pytest.approx((0.0, 0.0, 0.0))
    assert metal["specular"] == pytest.approx((0.9, 0.8, 0.5))
    assert metal["metallic"] == 1.0

    # Out-of-range values are pulled back rather than producing a mirror.
    assert material_look((1, 1, 1), roughness=0.0)["shininess"] < 3000
    assert material_look((1, 1, 1), metallic=5)["metallic"] == 1.0


def test_blend_materials_carry_their_finish():
    """The record tree gets the whole appearance, not just a colour."""
    doc = parse_blend(fb.build_blend())
    material = doc.root.path("Objects", "Material")
    names = [entry.props[0].value for entry in material.get("Properties70").children]
    assert names == ["DiffuseColor", "SpecularColor", "ShininessExponent", "Metallic"]
