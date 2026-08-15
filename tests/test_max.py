"""3ds Max scenes: the container, the chunk tree and the geometry inside it.

The fixture is written by ``fbxbuild.build_max`` — a compound file assembled
byte by byte — so these run against a file this project produced from its own
understanding of the format, and the reader has to agree with it rather than
with itself.
"""

from __future__ import annotations

import struct

import pytest

import fbxbuild as fb
from fbxtool import read_fbx
from fbxtool.maxfile import is_compound, is_max, parse_max, version_text
from fbxtool.model import ParseError
from fbxtool.reader import detect_format, parse_bytes
from fbxtool.report import render_text
from fbxtool.analyze import analyze


def _geometry(doc):
    objects = next(n for n in doc.root.children if n.name == "Objects")
    return [n for n in objects.children if n.name == "Geometry"]


def test_a_max_is_recognised():
    data = fb.build_max()
    assert is_compound(data[:512])
    assert is_max(data)
    assert detect_format(data[:8192]) == "max"


def test_another_compound_file_is_not_a_max():
    """The magic is shared with .doc and .xls; the streams are what differ."""
    data = bytearray(fb.build_max())
    # Rename the Scene stream, leaving a compound file that is not a scene.
    at = data.find("Scene".encode("utf-16-le"))
    assert at > 0
    data[at:at + 10] = "Sheet".encode("utf-16-le")
    assert is_compound(bytes(data))
    assert not is_max(bytes(data))
    with pytest.raises(ParseError):
        parse_max(bytes(data))


def test_the_cube_comes_out_whole():
    doc = parse_max(fb.build_max(), load_arrays=True)
    geometry = _geometry(doc)
    assert len(geometry) == 1
    vertices = geometry[0].get("Vertices").props[0].value
    assert len(vertices) == 24
    assert min(vertices) == -1.0 and max(vertices) == 1.0

    polygons = geometry[0].get("PolygonVertexIndex").props[0].value
    assert len(polygons) == 24                      # six quads
    # Every fourth index closes its polygon, and a run closes with a negation.
    assert all(polygons[i] < 0 for i in range(3, len(polygons), 4))
    assert all(polygons[i] >= 0 for i in range(len(polygons)) if i % 4 != 3)
    assert sorted({~v if v < 0 else v for v in polygons}) == list(range(8))


def test_the_map_channel_becomes_uvs():
    doc = parse_max(fb.build_max(with_uvs=True), load_arrays=True)
    layer = _geometry(doc)[0].get("LayerElementUV")
    assert layer is not None
    assert layer.get("MappingInformationType").props[0].value == "ByPolygonVertex"
    assert len(layer.get("UV").props[0].value) == 12          # four points
    assert len(layer.get("UVIndex").props[0].value) == 24     # one per corner

    plain = parse_max(fb.build_max(with_uvs=False), load_arrays=True)
    assert _geometry(plain)[0].get("LayerElementUV") is None


def test_the_node_gives_the_mesh_its_name():
    doc = parse_max(fb.build_max(name="wheel_fl"), load_arrays=True)
    objects = next(n for n in doc.root.children if n.name == "Objects")
    names = [n.props[1].value for n in objects.children]
    assert any(name.startswith("wheel_fl") for name in names)
    assert doc.extra["nodes"] == 1 and doc.extra["placed"] == 1


def test_a_scene_is_read_as_z_up():
    """3ds Max is Z up, and nothing in the geometry says so on its own."""
    info = analyze(parse_max(fb.build_max()))
    assert info.global_settings.get("up_axis") == "+Z"


def test_the_version_stamp_says_which_max_wrote_it():
    doc = parse_max(fb.build_max(build=(20 * 1000) << 16 | 966))
    assert doc.extra["build"] == 0x4E2003C6
    assert version_text(doc.extra["build"]) == "20.0 (3ds Max 2018), build 966"
    assert version_text((24 * 1000) << 16 | 12) == "24.0 (3ds Max 2022), build 12"
    assert version_text(None) == "unknown"


def test_the_class_table_and_the_plugins_are_read():
    doc = parse_max(fb.build_max())
    names = [c["name"] for c in doc.extra["classes"]]
    assert names[:4] == ["Editable Poly", "Node", "ParamBlock2", "Standard"]
    assert "TurboSmooth" in names
    assert doc.extra["dlls"][0]["file"] == "epoly.dlo"


def test_every_texture_the_scene_names_is_listed_with_where_it_lived():
    """The paths are a modeller's own directories, and worth reporting."""
    assets = parse_max(fb.build_max()).extra["assets"]
    assert len(assets) == 1
    assert assets[0]["kind"] == "Bitmap"
    assert assets[0]["name"] == "paint.jpg"
    assert assets[0]["path"] == "C:\\models\\paint.jpg"
    # The sixteen bytes in front of the record are what a material's parameter
    # block names the file by.
    assert len(assets[0]["id"]) == 16


def test_an_ngon_keeps_every_corner():
    """A face past four corners carries its triangulation, which is what makes
    the record variable length: read that size wrong and the next face is read
    out of the middle of this one."""
    data = fb.build_max()
    doc = parse_max(data, load_arrays=True)
    before = doc.extra["faces"]

    # A pentagon and a triangle, to move the following faces off alignment.
    faces = struct.pack("<I", 3) + b"".join([
        fb._max_face([0, 1, 2, 3, 4]),
        fb._max_face([5, 6, 7]),
        fb._max_face([0, 4, 7, 5]),
    ])
    mesh = (fb._max_chunk(0x0100, _cube_points())
            + fb._max_chunk(0x011A, faces))
    scene = fb._max_wide_chunk(0x2023,
                               fb._max_chunk(0x0000,
                                             fb._max_chunk(0x08FE, mesh, container=True),
                                             container=True)
                               + fb._max_chunk(0x0001,
                                               fb._max_chunk(0x2035,
                                                             struct.pack("<3I", 0x10, 1, 0))
                                               + fb._max_chunk(0x0962,
                                                               fb._max_utf16("ngon")),
                                               container=True))
    mixed = fb._max_compound({
        "Scene": scene,
        "ClassDirectory3": (fb._max_class("Editable Poly", 0x10, 0x1BF8338D)
                            + fb._max_class("Node", 0x01, 0x01)),
    })
    doc = parse_max(mixed, load_arrays=True)
    assert doc.warnings == []
    assert doc.extra["faces"] == 3 and before == 6
    polygons = _geometry(doc)[0].get("PolygonVertexIndex").props[0].value
    assert len(polygons) == 5 + 3 + 4
    assert polygons[:5] == [0, 1, 2, 3, -5]
    assert polygons[5:8] == [5, 6, -8]


def _cube_points() -> bytes:
    points = [(-1, -1, -1), (1, -1, -1), (1, 1, -1), (-1, 1, -1),
              (-1, -1, 1), (1, -1, 1), (1, 1, 1), (-1, 1, 1)]
    out = struct.pack("<I", len(points))
    for x, y, z in points:
        out += struct.pack("<I3f", 0, x, y, z)
    return out


def test_a_scene_with_nothing_it_can_read_says_so():
    """A file of primitives nobody collapsed has no geometry to give."""
    scene = fb._max_wide_chunk(0x2023, fb._max_chunk(0x0000, b"", container=True))
    data = fb._max_compound({
        "Scene": scene,
        "ClassDirectory3": fb._max_class("Box", 0x10, 0x10),
    })
    doc = parse_max(data)
    assert doc.extra["placed"] == 0
    assert any("Box" in w for w in doc.warnings)
    assert any("no Editable Poly" in w for w in doc.warnings)


def test_reading_it_from_disk_and_reporting_it(tmp_path):
    path = tmp_path / "scene.max"
    path.write_bytes(fb.build_max())
    doc = read_fbx(path, load_arrays=True)
    assert doc.format == "max"
    assert doc.file_size == path.stat().st_size

    text = render_text(analyze(doc))
    assert "Autodesk 3ds Max" in text
    assert "3ds Max 2018" in text
    assert "1 mesh object, 8 vertices, 6 faces" in text
    assert "paint.jpg" in text


def test_parse_bytes_takes_one_too():
    doc = parse_bytes(fb.build_max(), path="scene.max")
    assert doc.format == "max" and doc.extra["meshes"] == 1


def test_a_truncated_file_is_refused():
    data = fb.build_max()[:600]
    with pytest.raises((ParseError, struct.error)):
        parse_max(data)


def test_an_editable_mesh_is_read_as_well():
    """The other geometry class: triangles, and no flag word before a vertex.

    Half the scenes in the wild are modelled this way, and it shares only the
    block it sits in with an Editable Poly.
    """
    doc = parse_max(fb.build_max(kind="mesh"), load_arrays=True)
    assert doc.warnings == []
    assert doc.extra["meshes"] == 1
    assert doc.extra["faces"] == 12                      # six quads, cut in two
    geometry = _geometry(doc)[0]
    vertices = geometry.get("Vertices").props[0].value
    assert len(vertices) == 24 and min(vertices) == -1.0 and max(vertices) == 1.0
    polygons = geometry.get("PolygonVertexIndex").props[0].value
    assert len(polygons) == 36
    assert all(polygons[i] < 0 for i in range(2, len(polygons), 3))
    assert geometry.get("LayerElementUV") is not None


def test_compressed_streams_are_inflated():
    """3ds Max 2022 and later can gzip what it writes, stream by stream."""
    plain = parse_max(fb.build_max(), load_arrays=True)
    packed = fb.build_max(compressed=True)
    assert packed != fb.build_max()
    doc = parse_max(packed, load_arrays=True)
    assert doc.warnings == []
    assert _geometry(doc)[0].get("Vertices").props[0].value == \
        _geometry(plain)[0].get("Vertices").props[0].value
    assert doc.extra["classes"] and doc.extra["assets"]


def test_a_file_that_stops_mid_sector_is_still_read():
    """Writers do it, and the tail of one sector is no reason to refuse 30 MB."""
    data = fb.build_max()
    doc = parse_max(data[:-200], load_arrays=True)
    assert doc.extra["meshes"] == 1
    assert len(_geometry(doc)[0].get("Vertices").props[0].value) == 24


def test_the_material_a_part_wears_comes_with_it():
    """A node names its material, the material names its colour and its map.

    Which parameter id means *diffuse* is the plugin's own business and the
    file does not say, so the reader takes the first colour-valued parameter —
    a rule read off the files rather than assumed about a plugin.
    """
    doc = parse_max(fb.build_max(), load_arrays=True)
    objects = next(n for n in doc.root.children if n.name == "Objects")
    materials = [n for n in objects.children if n.name == "Material"]
    assert len(materials) == 1
    assert materials[0].props[1].value.startswith("Body paint")
    colour = [p.value for p in materials[0].get("Properties70").children[0].props[4:7]]
    assert [round(v, 3) for v in colour] == [0.8, 0.1, 0.05]
    assert doc.extra["materials"] == 1

    # And the part is connected to it, or nothing would wear it.
    connections = next(n for n in doc.root.children if n.name == "Connections")
    material_uid = materials[0].props[0].value
    assert any(c.props[1].value == material_uid for c in connections.children)


def _material_props(doc):
    objects = next(n for n in doc.root.children if n.name == "Objects")
    material = next(n for n in objects.children if n.name == "Material")
    return {p.props[0].value: [q.value for q in p.props[4:]]
            for p in material.get("Properties70").children}


def test_a_shader_says_which_parameter_of_its_block_is_which():
    """The block a shader fills starts with ambient, not diffuse.

    Reading it by position takes the ambient for the colour of the surface,
    which is what the first-colour rule does to a material it was not written
    for.  The class table names the shader, and each shader's own layout says
    where the rest of the surface is: what it reflects, and how glossy.
    """
    props = _material_props(parse_max(fb.build_max(shader="Blinn"), load_arrays=True))
    assert props["DiffuseColor"] == pytest.approx(fb.MAX_DIFFUSE, abs=1e-6)
    assert props["SpecularColor"] == pytest.approx(fb.MAX_SPECULAR, abs=1e-6)
    assert props["SpecularFactor"] == pytest.approx([fb.MAX_SPECULAR_LEVEL], abs=1e-6)
    # Glossiness is 0 to 1 in the file and a percentage as an exponent, which
    # is the conversion 3ds Max's own exporter makes.
    assert props["ShininessExponent"] == pytest.approx([fb.MAX_GLOSSINESS * 100], abs=1e-4)


def test_each_shader_reads_its_own_layout():
    """Anisotropic keeps its specular level where Blinn keeps its glossiness,
    so the two cannot be read the same way round."""
    props = _material_props(parse_max(fb.build_max(shader="Anisotropic"), load_arrays=True))
    assert props["SpecularFactor"] == pytest.approx([fb.MAX_GLOSSINESS], abs=1e-6)
    # Its glossiness is two parameters further on, and this block has none.
    assert "ShininessExponent" not in props


def test_a_plugins_own_material_is_read_no_further_than_its_colour():
    """VRay, Corona and the rest lay their blocks out as they please.

    Reading one by a shader's layout would put its reflection where its colour
    goes, so an unknown class keeps the older rule — the first colour is the
    diffuse — and states nothing about the finish.
    """
    props = _material_props(parse_max(fb.build_max(shader="VRayMtl"), load_arrays=True))
    assert list(props) == ["DiffuseColor"]
    assert props["DiffuseColor"] == pytest.approx(fb.MAX_AMBIENT, abs=1e-6)


def test_the_picture_a_material_wears_is_named():
    """The map is not in the scene: a parameter block carries the identifier of
    an asset, and the asset table turns that into a file name."""
    doc = parse_max(fb.build_max(), load_arrays=True)
    objects = next(n for n in doc.root.children if n.name == "Objects")
    textures = [n for n in objects.children if n.name == "Texture"]
    assert len(textures) == 1
    assert textures[0].get("FileName").props[0].value == "paint.jpg"
    assert doc.extra["textures"] == ["paint.jpg"]
    # A Video record too, which is what carries the image for the viewer.
    assert any(n.name == "Video" for n in objects.children)


def test_a_material_nothing_points_at_is_left_out():
    """A scene keeps the material editor's own slots; only what a node wears
    is worth a record."""
    doc = parse_max(fb.build_max(), load_arrays=True)
    assert doc.extra["materials"] == 1          # not the class table's worth


def test_a_node_is_placed_by_its_three_axis_controllers():
    """A Position XYZ holds nothing itself.

    It refers to three float controllers, one per axis, and each of those
    wraps its single value a level further down — a reader that looks only at
    the controller's own chunks finds nothing and leaves the part at the
    origin, which is where this went wrong.
    """
    doc = parse_max(fb.build_max(place=(10.5, -2.0, 3.25)), load_arrays=True)
    objects = next(n for n in doc.root.children if n.name == "Objects")
    model = next(n for n in objects.children if n.name == "Model")
    placement = {q.props[0].value: [round(x.value, 3) for x in q.props[4:7]]
                 for q in model.get("Properties70").children}
    assert placement["Lcl Translation"] == [10.5, -2.0, 3.25]

    # And a scene that says nothing leaves the node where it stands.
    plain = parse_max(fb.build_max(), load_arrays=True)
    model = next(n for n in next(o for o in plain.root.children if o.name == "Objects")
                 .children if n.name == "Model")
    assert model.get("Properties70").children == []


def test_the_offset_between_a_node_and_its_mesh_is_kept():
    """3ds Max holds this apart from the node's own transform, and so does an
    FBX — it is the geometric transform, the one a child does not inherit."""
    doc = parse_max(fb.build_max(offset=(1.0, 2.0, 3.0)), load_arrays=True)
    objects = next(n for n in doc.root.children if n.name == "Objects")
    model = next(n for n in objects.children if n.name == "Model")
    placement = {q.props[0].value: [round(x.value, 3) for x in q.props[4:7]]
                 for q in model.get("Properties70").children}
    assert placement["GeometricTranslation"] == [1.0, 2.0, 3.0]
    assert "Lcl Translation" not in placement


def test_a_scene_modelled_smooth_says_how_smooth():
    """The mesh under a subdividing modifier is the cage, and drawing the cage
    is drawing something nobody modelled — so the file is asked how many
    rounds it wanted."""
    doc = parse_max(fb.build_max(smooth=2), load_arrays=True)
    assert doc.extra["smoothed"] == 1
    assert doc.extra["smoothing"] == 2
    # The geometry itself is still the cage; nothing is subdivided here.
    assert doc.extra["vertices"] == 8

    once = parse_max(fb.build_max(smooth=1))
    assert once.extra["smoothing"] == 1
    assert parse_max(fb.build_max()).extra["smoothed"] == 0
