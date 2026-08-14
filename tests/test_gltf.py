"""Tests for the glTF 2.0 reader.

The fixture is deliberately awkward — interleaved attributes, 16-bit indices,
a sparse accessor, a primitive with no indices, a node placed by a quaternion
and another by a matrix — because a reader that only handles what a simple
exporter writes passes on anything easier.
"""

from __future__ import annotations

import json
import math
import struct

import pytest

import fbxbuild as fb

from fbxtool import ParseError, analyze, detect_format, parse_bytes, read_model
from fbxtool.gltf import is_gltf, parse_gltf, read_container
from fbxtool.report import render_text


@pytest.fixture
def glb() -> bytes:
    return fb.build_glb()


@pytest.fixture
def gltf_pair(tmp_path):
    """A .gltf document and the .bin beside it, written to disk."""
    document, buffer = fb.build_gltf()
    (tmp_path / "scene.gltf").write_bytes(document)
    (tmp_path / "scene.bin").write_bytes(buffer)
    return tmp_path / "scene.gltf", tmp_path / "scene.bin"


def child(node, name):
    return next(c for c in node.children if c.name == name)


def objects_of(doc, kind):
    root = child(doc.root, "Objects")
    return [c for c in root.children if c.name == kind]


def values(node, name):
    return child(node, name).props[0].value


# ------------------------------------------------------------------ detection

def test_a_glb_is_recognised_from_its_magic(glb):
    assert is_gltf(glb)
    assert detect_format(glb[:8192]) == "gltf"


def test_a_gltf_document_is_recognised_from_its_asset_block():
    document, _ = fb.build_gltf()
    assert is_gltf(document)
    assert detect_format(document[:8192]) == "gltf"


def test_a_leading_byte_order_mark_or_whitespace_does_not_hide_it():
    document, _ = fb.build_gltf()
    assert is_gltf(b"\xef\xbb\xbf" + document)
    assert is_gltf(b"\n\t  " + document)


def test_other_json_is_not_claimed():
    """A saved material assignment is JSON too, and must not be read as glTF."""
    assignment = json.dumps({"materials": {"paint": {"colour": [1, 0, 0]}}}).encode()
    assert not is_gltf(assignment)
    assert detect_format(assignment) == "unknown"


# -------------------------------------------------------------- the container

def test_the_binary_chunk_is_found(glb):
    document, binary, warnings = read_container(glb)
    assert warnings == []
    assert document["asset"]["version"] == "2.0"
    assert binary is not None and len(binary) % 4 == 0


def test_a_wrong_length_in_the_header_is_reported(glb):
    stated = struct.unpack_from("<I", glb, 8)[0]
    broken = glb[:8] + struct.pack("<I", stated + 16) + glb[12:]
    _, _, warnings = read_container(broken)
    assert any("the header says" in w for w in warnings)


def test_a_container_without_json_is_an_error():
    empty = struct.pack("<4sII", b"glTF", 2, 12)
    with pytest.raises(ParseError):
        read_container(empty)


def test_json_that_does_not_parse_is_an_error():
    payload = b"{ not json"
    payload += b" " * (-len(payload) % 4)
    data = struct.pack("<4sII", b"glTF", 2, 20 + len(payload))
    data += struct.pack("<II", len(payload), 0x4E4F534A) + payload
    with pytest.raises(ParseError):
        read_container(data)


# ------------------------------------------------------------------ the scene

def test_the_document_describes_the_file(glb):
    doc = parse_bytes(glb)
    assert doc.format == "gltf"
    assert doc.encoding == "binary"
    assert doc.warnings == []
    assert doc.extra["gltf_version"] == "2.0"
    assert doc.extra["generator"] == "fbxtool test fixture"
    assert doc.extra["triangles"] == fb.GLTF_TRIANGLES
    assert doc.extra["primitives"] == fb.GLTF_PRIMITIVES
    assert doc.extra["nodes"] == fb.GLTF_NODES
    assert doc.extra["component_types"] == ["float32", "uint16"]


def test_every_primitive_becomes_a_geometry_and_a_model(glb):
    doc = parse_bytes(glb)
    info = analyze(doc)
    assert len(objects_of(doc, "Geometry")) == fb.GLTF_PRIMITIVES
    # Three nodes, and no extra model since neither mesh has two primitives.
    assert len(objects_of(doc, "Model")) == fb.GLTF_NODES
    names = {obj.display_name for obj in info.objects}
    assert {"box", "speck", "rig", fb.GLTF_MATERIAL} <= names


def test_the_hierarchy_follows_the_scene_graph(glb):
    text = render_text(analyze(parse_bytes(glb)), show_hierarchy=True)
    # The rig holds both parts, and each part holds its own geometry.
    assert "rig" in text and "box" in text and "speck" in text
    assert text.index("rig") < text.index("box") < text.index("speck")
    assert "[Geometry] box" in text and "[Material] paint" in text


def test_the_triangles_are_a_polygon_run(glb):
    doc = parse_bytes(glb, load_arrays=True)
    box = objects_of(doc, "Geometry")[0]
    run = values(box, "PolygonVertexIndex")
    assert len(run) == fb.GLTF_TRIANGLES * 3 - 3      # the speck is separate
    # Every third index is stored as its complement, and nothing else is.
    assert all(v < 0 for v in run[2::3])
    assert all(v >= 0 for i, v in enumerate(run) if i % 3 != 2)


def test_a_primitive_without_indices_still_has_polygons(glb):
    doc = parse_bytes(glb, load_arrays=True)
    speck = objects_of(doc, "Geometry")[1]
    assert values(speck, "PolygonVertexIndex") == [0, 1, ~2]


def test_interleaved_attributes_are_taken_apart(glb):
    doc = parse_bytes(glb, load_arrays=True)
    box = objects_of(doc, "Geometry")[0]
    positions = values(box, "Vertices")
    normals = values(child(box, "LayerElementNormal"), "Normals")
    assert len(positions) == 8 * 3
    # Every normal is +Y; reading the stride wrongly would mix in positions.
    assert normals == [0.0, 1.0, 0.0] * 8


def test_the_sparse_accessor_moves_the_corner_it_names(glb):
    doc = parse_bytes(glb, load_arrays=True)
    positions = values(objects_of(doc, "Geometry")[0], "Vertices")
    depth = max(positions[2::3]) - min(positions[2::3])
    assert depth == pytest.approx(fb.GLTF_BOX_LOCAL[2])
    assert positions[:3] == [-1.0, -0.5, -3.0]


def test_arrays_are_only_read_when_they_are_asked_for(glb):
    doc = parse_bytes(glb)
    box = objects_of(doc, "Geometry")[0]
    vertices = child(box, "Vertices").props[0]
    assert vertices.value is None
    # The lengths still come out, from the accessor headers alone.
    assert vertices.array.length == 8 * 3
    assert child(box, "PolygonVertexIndex").props[0].array.length == 36


# -------------------------------------------------------------- placement

def test_a_quaternion_becomes_the_euler_angles_fbx_uses(glb):
    doc = parse_bytes(glb)
    box = next(m for m in objects_of(doc, "Model")
               if m.props[1].value.startswith("box"))
    props = {p.props[0].value: [q.value for q in p.props[4:]]
             for p in child(box, "Properties70").children}
    assert props["Lcl Translation"] == pytest.approx(list(fb.GLTF_BOX_TRANSLATION))
    assert props["Lcl Scaling"] == pytest.approx(list(fb.GLTF_BOX_SCALE))
    assert props["Lcl Rotation"] == pytest.approx(list(fb.GLTF_BOX_ROTATION), abs=1e-4)


def test_a_matrix_is_taken_apart_the_same_way(glb):
    doc = parse_bytes(glb)
    rig = next(m for m in objects_of(doc, "Model")
               if m.props[1].value.startswith("rig"))
    props = {p.props[0].value: [q.value for q in p.props[4:]]
             for p in child(rig, "Properties70").children}
    assert props["Lcl Translation"] == pytest.approx([0.0, 0.0, 0.0])
    assert props["Lcl Rotation"] == pytest.approx([0.0, 0.0, 0.0])
    assert props["Lcl Scaling"] == pytest.approx([1.0, 1.0, 1.0])


@pytest.mark.parametrize("axis,angle", [
    ((1, 0, 0), 30.0), ((0, 1, 0), -45.0), ((0, 0, 1), 120.0),
])
def test_a_rotation_about_one_axis_comes_back_as_itself(axis, angle):
    """The angles are for R = Rz * Ry * Rx, so a single-axis turn is exact."""
    half = math.radians(angle) / 2
    quaternion = [a * math.sin(half) for a in axis] + [math.cos(half)]
    document = json.loads(fb.build_gltf()[0])
    document["nodes"][0]["rotation"] = quaternion
    doc = parse_gltf(json.dumps(document).encode())
    box = next(m for m in objects_of(doc, "Model")
               if m.props[1].value.startswith("box"))
    rotation = next([q.value for q in p.props[4:]]
                    for p in child(box, "Properties70").children
                    if p.props[0].value == "Lcl Rotation")
    wanted = [angle * a for a in axis]
    assert rotation == pytest.approx(wanted, abs=1e-4)


# -------------------------------------------------------------- materials

def test_metallic_roughness_becomes_the_material_fbx_carries(glb):
    doc = parse_bytes(glb)
    material = objects_of(doc, "Material")[0]
    assert material.props[1].value.startswith(fb.GLTF_MATERIAL)
    props = {p.props[0].value: [q.value for q in p.props[4:]]
             for p in child(material, "Properties70").children}

    metallic = fb.GLTF_METALLIC
    base = fb.GLTF_BASE_COLOR
    assert props["Metallic"] == pytest.approx([metallic])
    # Metal takes its reflectance from the base colour, a dielectric 4%.
    assert props["DiffuseColor"] == pytest.approx([c * (1 - metallic) for c in base[:3]])
    assert props["SpecularColor"] == pytest.approx(
        [0.04 * (1 - metallic) + c * metallic for c in base[:3]])
    # Roughness back to the exponent the viewer and the report expect.
    wanted = 2 / fb.GLTF_ROUGHNESS ** 2 - 2
    assert props["ShininessExponent"] == pytest.approx([wanted])


def test_only_a_blended_material_is_transparent(glb):
    doc = parse_bytes(glb)
    opacity = next([q.value for q in p.props[4:]]
                   for p in child(objects_of(doc, "Material")[0], "Properties70").children
                   if p.props[0].value == "Opacity")
    assert opacity == pytest.approx([fb.GLTF_BASE_COLOR[3]])

    document = json.loads(fb.build_gltf()[0])
    document["materials"][0]["alphaMode"] = "OPAQUE"
    doc = parse_gltf(json.dumps(document).encode())
    opacity = next([q.value for q in p.props[4:]]
                   for p in child(objects_of(doc, "Material")[0], "Properties70").children
                   if p.props[0].value == "Opacity")
    assert opacity == pytest.approx([1.0])


def test_a_reflectance_of_its_own_comes_from_the_specular_extension():
    """glTF fixes a dielectric at 4% unless KHR_materials_specular says
    otherwise, which is the one place a file can state a tinted reflectance."""
    document = json.loads(fb.build_gltf()[0])
    document["materials"][0]["pbrMetallicRoughness"]["metallicFactor"] = 0.0
    document["materials"][0]["extensions"] = {
        "KHR_materials_specular": {"specularColorFactor": [3.0, 2.0, 1.0]},
    }
    doc = parse_gltf(json.dumps(document).encode())
    specular = next([q.value for q in p.props[4:]]
                    for p in child(objects_of(doc, "Material")[0], "Properties70").children
                    if p.props[0].value == "SpecularColor")
    assert specular == pytest.approx([0.12, 0.08, 0.04])


def test_the_specular_strength_scales_it():
    document = json.loads(fb.build_gltf()[0])
    document["materials"][0]["pbrMetallicRoughness"]["metallicFactor"] = 0.0
    document["materials"][0]["extensions"] = {
        "KHR_materials_specular": {"specularFactor": 0.5},
    }
    doc = parse_gltf(json.dumps(document).encode())
    specular = next([q.value for q in p.props[4:]]
                    for p in child(objects_of(doc, "Material")[0], "Properties70").children
                    if p.props[0].value == "SpecularColor")
    assert specular == pytest.approx([0.02, 0.02, 0.02])


def test_an_embedded_image_travels_as_raw_content(glb):
    doc = parse_bytes(glb)
    video = objects_of(doc, "Video")[0]
    content = child(video, "Content").props[0]
    assert content.code == "R"
    assert content.value == fb.checker_png()
    texture = objects_of(doc, "Texture")[0]
    # It is in the container, so there is no file to name.
    assert values(texture, "RelativeFilename") == ""
    assert texture.props[1].value.startswith(fb.GLTF_IMAGE)


def test_the_texture_is_connected_to_the_material_it_colours(glb):
    info = analyze(parse_bytes(glb))
    kinds = {(c.kind, c.prop) for c in info.connections}
    assert ("OP", "DiffuseColor") in kinds


# ------------------------------------------------------- buffers beside it

def test_a_gltf_reads_the_bin_beside_it(gltf_pair):
    document, _ = gltf_pair
    doc = read_model(document, load_arrays=True)
    assert doc.encoding == "ascii"
    assert doc.warnings == []
    assert doc.extra["external_buffers"] == ["scene.bin"]
    positions = values(objects_of(doc, "Geometry")[0], "Vertices")
    assert positions[:3] == [-1.0, -0.5, -3.0]


def test_a_missing_bin_is_said_plainly(gltf_pair):
    document, buffer = gltf_pair
    buffer.unlink()
    doc = read_model(document, load_arrays=True)
    assert any("scene.bin" in w and "not found" in w for w in doc.warnings)
    # The structure is still readable — only the numbers are missing.
    assert len(objects_of(doc, "Geometry")) == fb.GLTF_PRIMITIVES
    assert doc.extra["triangles"] == fb.GLTF_TRIANGLES


def test_a_listing_says_the_bin_is_missing_too(gltf_pair):
    """Even without the arrays, a document that names a file it has not got
    should say so — that is exactly what someone listing a directory wants."""
    document, buffer = gltf_pair
    buffer.unlink()
    doc = read_model(document)
    assert any("scene.bin" in w for w in doc.warnings)
    assert doc.extra["triangles"] == fb.GLTF_TRIANGLES


def test_a_buffer_in_a_data_uri_is_decoded():
    document, buffer = fb.build_gltf()
    import base64
    json_doc = json.loads(document)
    json_doc["buffers"][0]["uri"] = ("data:application/octet-stream;base64,"
                                     + base64.b64encode(buffer).decode())
    doc = parse_gltf(json.dumps(json_doc).encode(), load_arrays=True)
    assert doc.warnings == []
    assert doc.extra["external_buffers"] == []
    assert values(objects_of(doc, "Geometry")[0], "Vertices")[:3] == [-1.0, -0.5, -3.0]


# ------------------------------------------------------------ what it refuses

def test_a_drawing_mode_that_is_not_triangles_is_reported():
    document = json.loads(fb.build_gltf()[0])
    document["meshes"][0]["primitives"][0]["mode"] = 1      # LINES
    doc = parse_gltf(json.dumps(document).encode())
    assert any("drawing mode 1" in w for w in doc.warnings)
    assert len(objects_of(doc, "Geometry")) == fb.GLTF_PRIMITIVES - 1


def test_a_version_that_is_not_two_is_reported():
    document = json.loads(fb.build_gltf()[0])
    document["asset"]["version"] = "1.0"
    doc = parse_gltf(json.dumps(document).encode())
    assert any("this reads 2.x" in w for w in doc.warnings)


def test_extensions_the_file_insists_on_are_reported():
    document = json.loads(fb.build_gltf()[0])
    document["extensionsRequired"] = ["KHR_draco_mesh_compression"]
    document["extensionsUsed"] = ["KHR_draco_mesh_compression"]
    doc = parse_gltf(json.dumps(document).encode())
    assert any("KHR_draco_mesh_compression" in w for w in doc.warnings)
    assert doc.extra["extensions_required"] == ["KHR_draco_mesh_compression"]


def test_an_accessor_that_is_not_there_is_reported():
    document = json.loads(fb.build_gltf()[0])
    document["meshes"][0]["primitives"][0]["attributes"]["POSITION"] = 99
    doc = parse_gltf(json.dumps(document).encode())
    assert any("accessor 99" in w for w in doc.warnings)


# -------------------------------------------------------------- the report

def test_the_report_names_the_format_and_what_is_in_it(glb, tmp_path, capsys):
    from fbxtool.cli import main

    path = tmp_path / "scene.glb"
    path.write_bytes(glb)
    assert main([str(path)]) == 0
    out = capsys.readouterr().out
    assert "glTF 2.0" in out
    assert "binary (.glb" in out
    assert f"{fb.GLTF_TRIANGLES} triangles" in out
    assert "fbxtool test fixture" in out
    assert "up +Y" in out                       # glTF is Y up, in metres
    assert "100 cm per unit" in out


def test_the_brief_listing_names_the_container(glb, tmp_path, capsys):
    from fbxtool.cli import main

    path = tmp_path / "scene.glb"
    path.write_bytes(glb)
    assert main([str(path), "--brief"]) == 0
    out = capsys.readouterr().out
    assert "glTF 2.0" in out and ".glb" in out
