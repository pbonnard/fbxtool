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
    """A renderer nobody has studied lays its block out as it pleases.

    Reading one by a shader's layout would put its reflection where its colour
    goes, so a class nobody has studied keeps the older rule — the first colour
    is the diffuse — and states nothing about the finish.
    """
    props = _material_props(parse_max(fb.build_max(shader="ArnoldStandardSurface"),
                                      load_arrays=True))
    assert list(props) == ["DiffuseColor"]
    assert props["DiffuseColor"] == pytest.approx(fb.MAX_AMBIENT, abs=1e-6)


def test_a_vray_material_is_read_for_what_it_lets_through():
    """The one plugin material that has been studied.

    Its ids come off the files rather than any documentation, but id 5 settles
    itself: it is stored as a colour, which a glossiness never is, and it is
    exactly zero on fourteen of twenty materials in a real car — implausible
    for a glossiness and exactly right for an opaque surface.
    """
    props = _material_props(parse_max(fb.build_max(shader="VRayMtl"), load_arrays=True))
    assert props["DiffuseColor"] == pytest.approx(fb.MAX_DIFFUSE, abs=1e-6)
    assert props["SpecularColor"] == pytest.approx(fb.MAX_SPECULAR, abs=1e-6)
    # What it refracts is what it lets through, so it is the opposite of this.
    assert props["Opacity"] == pytest.approx([1 - max(fb.MAX_REFRACTION)], abs=1e-6)


@pytest.mark.parametrize("shader", ["CoronaMtl", "CoronaLegacyMtl"])
def test_a_corona_material_is_read_by_the_layout_it_writes(shader):
    """Corona keeps a level beside every colour, and its numbers in short
    chunks.

    Both had to be dealt with for any of it to arrive: the scalars are four
    bytes shorter than the ones a shader 3ds Max ships writes, so a reader that
    skips them keeps nothing of the finish at all — and the colour on its own
    is only half of what the channel is, since a level of zero turns the
    brightest refraction into a solid surface.

    The ids were settled against the answer: five of these cars ship a Corona
    scene and a V-Ray scene of the same model, with the same material names in
    both, and read this way 174 of the 176 shared materials agree with the
    V-Ray twin on all four of these.
    """
    props = _material_props(parse_max(fb.build_max(shader=shader), load_arrays=True))
    assert props["DiffuseColor"] == pytest.approx(
        [c * fb.MAX_DIFFUSE_LEVEL for c in fb.MAX_DIFFUSE], abs=1e-6)
    assert props["SpecularColor"] == pytest.approx(
        [c * fb.MAX_SPECULAR_LEVEL_CORONA for c in fb.MAX_SPECULAR], abs=1e-6)
    assert props["ShininessExponent"] == pytest.approx([fb.MAX_GLOSSINESS * 100], abs=1e-4)
    assert props["Opacity"] == pytest.approx(
        [1 - max(fb.MAX_REFRACTION) * fb.MAX_REFRACTION_LEVEL], abs=1e-6)


def test_a_corona_material_is_named_from_the_block_it_keeps_its_name_in():
    """A plugin writes the block every material carries under an id of its own.

    Corona's is 0x0FA0 where 3ds Max's own is 0x5431, with the same name chunk
    inside it — which is why a Corona scene came out as a list of numbered
    materials while its V-Ray twin, named by the same artist, came out named.
    """
    doc = parse_max(fb.build_max(shader="CoronaMtl"), load_arrays=True)
    objects = next(n for n in doc.root.children if n.name == "Objects")
    material = next(n for n in objects.children if n.name == "Material")
    assert material.props[1].value.split("\x00")[0] == "Body paint"


def test_a_map_slot_is_not_read_as_a_number():
    """Corona's slots for maps sit among its scalars and read as 2.0.

    Nothing in the size tells them apart — they are smaller, and the reader now
    goes below that size — so the type is what has to, or a slot at the wrong
    id would pass for a level and dim the colour beside it.
    """
    props = _material_props(parse_max(fb.build_max(shader="CoronaMtl"), load_arrays=True))
    # 141 is a slot, not a level, so the diffuse is dimmed by 121 alone.
    assert props["DiffuseColor"] == pytest.approx(
        [c * fb.MAX_DIFFUSE_LEVEL for c in fb.MAX_DIFFUSE], abs=1e-6)


def test_a_material_that_refracts_nothing_says_nothing_about_opacity():
    """A .max carries no opacity otherwise, and writing 1 for every material
    would say something the file does not."""
    props = _material_props(parse_max(fb.build_max(shader="Blinn"), load_arrays=True))
    assert "Opacity" not in props


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

# --------------------------------------------------------- smoothing groups


def test_the_smoothing_groups_come_across():
    """Without them a mesh that stores no normals of its own can only be
    shaded flat — every crease on a car body rounded away."""
    data = fb.build_max(groups=[1, 2, 4, 8, 16, 32])
    doc = parse_max(data)
    geometry = doc.root.path("Objects", "Geometry")
    layer = geometry.get("LayerElementSmoothing")
    assert layer is not None, "no smoothing layer"
    assert layer.get("MappingInformationType").props[0].value == "ByPolygon"
    assert layer.get("Smoothing").props[0].value == [1, 2, 4, 8, 16, 32]


def test_a_group_above_the_sixteenth_is_kept():
    """A face carries thirty-two of them, and a car body uses the far ones.

    Read as though the low half of the word were a material id, every group
    below the seventeenth is masked away and the parts wearing them go flat.
    """
    far = [1 << 20, 1 << 31, 3, 1 << 16, 1, 1 << 24]
    doc = parse_max(fb.build_max(groups=far))
    layer = doc.root.path("Objects", "Geometry").get("LayerElementSmoothing")
    assert layer.get("Smoothing").props[0].value == far


def test_the_material_id_survives_beside_them():
    """The id and the groups are separate fields of the same face, and reading
    either must leave the other alone."""
    doc = parse_max(fb.build_max(slots=3, materials=[0, 1, 2, 2, 1, 0],
                                 groups=[7, 7, 7, 7, 7, 7]))
    geometry = doc.root.path("Objects", "Geometry")
    assert geometry.get("LayerElementSmoothing").get("Smoothing").props[0].value == [7] * 6
    assert geometry.get("LayerElementMaterial").get("Materials").props[0].value \
        == [0, 1, 2, 2, 1, 0]


def test_a_scene_with_no_groups_says_nothing_about_them():
    """A file that names none gets no layer, rather than one full of zeros."""
    doc = parse_max(fb.build_max())
    assert doc.root.path("Objects", "Geometry").get("LayerElementSmoothing") is None


# ------------------------------------------------------------ material slots


def test_a_face_wears_the_slot_its_own_field_names():
    """The id is a field of its own, not the low half of the smoothing word.

    Read out of that word instead, a face's groups pass for a slot: a body of
    sixteen materials comes out wearing seven, two of them past the end of its
    own list, and the car is painted from the wrong tins throughout.
    """
    doc = parse_max(fb.build_max(slots=4, materials=[0, 1, 2, 3, 1, 0],
                                 groups=[1 << 20] * 6))
    layer = doc.root.path("Objects", "Geometry").get("LayerElementMaterial")
    assert layer.get("MappingInformationType").props[0].value == "ByPolygon"
    assert layer.get("Materials").props[0].value == [0, 1, 2, 3, 1, 0]

    # And every slot of the list is a material of its own, connected to the
    # part that picks from it.
    objects = next(n for n in doc.root.children if n.name == "Objects")
    names = [n.props[1].value.split("\x00")[0] for n in objects.children
             if n.name == "Material"]
    assert sorted(names) == ["slot0", "slot1", "slot2", "slot3"]


def test_a_part_with_one_material_says_so_once():
    """Nothing to pick from is not a per-face list of zeros."""
    doc = parse_max(fb.build_max())
    layer = doc.root.path("Objects", "Geometry").get("LayerElementMaterial")
    assert layer.get("MappingInformationType").props[0].value == "AllSame"


# ---------------------------------------------------------- the node it hangs
#                                                             off


def _models(doc):
    objects = next(n for n in doc.root.children if n.name == "Objects")
    return {n.props[1].value.split("\x00")[0]: n.props[0].value
            for n in objects.children if n.name == "Model"}


def _parent_of(doc, uid):
    connections = next(n for n in doc.root.children if n.name == "Connections")
    return next(c.props[2].value for c in connections.children
                if c.props[0].value == "OO" and c.props[1].value == uid)


def test_a_child_hangs_off_the_node_that_places_it():
    """A child's controller says where it stands relative to its parent.

    Hang every node off the scene instead and that local offset is read as a
    world position: a car whose wheels are linked to its body comes out with
    the wheels somewhere below it and the body in the air.
    """
    doc = parse_max(fb.build_max(name="body", place=(0.0, 0.0, 100.0),
                                 child=(10.0, 0.0, -20.0)), load_arrays=True)
    models = _models(doc)
    assert set(models) == {"body", "body_child"}
    assert _parent_of(doc, models["body_child"]) == models["body"]
    # The body itself names the scene's root, which is not a part of its own.
    assert _parent_of(doc, models["body"]) == 0

    objects = next(n for n in doc.root.children if n.name == "Objects")
    child = next(n for n in objects.children
                 if n.name == "Model" and n.props[0].value == models["body_child"])
    placement = {q.props[0].value: [round(x.value, 3) for x in q.props[4:7]]
                 for q in child.get("Properties70").children}
    # What is written is the local transform; the parent supplies the rest.
    assert placement["Lcl Translation"] == [10.0, 0.0, -20.0]


def test_the_hierarchy_is_reported_as_the_scene_keeps_it():
    doc = parse_max(fb.build_max(name="body", child=(1.0, 0.0, 0.0)))
    lines = render_text(analyze(doc)).splitlines()
    body = next(i for i, line in enumerate(lines) if "body  [Mesh]" in line)
    kid = next(i for i, line in enumerate(lines) if "body_child" in line)
    # The child is drawn below its parent and indented past it.
    assert kid > body
    assert lines[kid].index("body_child") > lines[body].index("body")


# ------------------------------------------------- which map is the colour one


def _vray(**kw):
    return parse_max(fb.build_max(shader="VRayMtl", material_class="VRayMtl", **kw),
                     load_arrays=True)


def _bound(doc):
    """Which picture drives which property of the material wearing it."""
    objects = next(n for n in doc.root.children if n.name == "Objects")
    names = {n.props[0].value: n.props[1].value.split("\x00")[0]
             for n in objects.children if n.name == "Texture"}
    connections = next(n for n in doc.root.children if n.name == "Connections")
    return {c.props[3].value: names[c.props[1].value] for c in connections.children
            if c.props[0].value == "OP" and c.props[1].value in names}


def test_a_vray_material_wears_each_map_in_the_slot_that_holds_it():
    """Not whichever map the walk happens to reach first.

    A VRayMtl keeps six parameter blocks and then its maps, and the first one
    most of them carry is not the diffuse: reference 7 holds it and 10 the
    bump.  Taken in the order they are found, a tyre whose only map is the
    tread it is bumped by comes out painted with that tread — pale grey where
    it should be black rubber — and a leather seat wears its own relief.
    """
    assert _bound(_vray(maps={7: "colour.png", 10: "bump.png"})) == {
        "DiffuseColor": "colour.png", "Bump": "bump.png"}
    # The order the slots are written in must not decide it either.
    assert _bound(_vray(maps={10: "bump.png", 7: "colour.png"})) == {
        "DiffuseColor": "colour.png", "Bump": "bump.png"}


def test_a_vray_material_with_only_a_bump_is_bumped_and_not_painted():
    """An empty diffuse slot is an answer, not a reason to keep looking — and
    the map that is there is still worth having, in the slot it belongs to."""
    assert _bound(_vray(maps={10: "bump.png"})) == {"Bump": "bump.png"}


def test_a_shader_whose_slots_are_not_known_keeps_the_older_rule():
    """The first picture below the material, which is all that can be said of
    a plugin nobody has read the reference order of."""
    doc = parse_max(fb.build_max(shader="Blinn"), load_arrays=True)
    assert _bound(doc) == {"DiffuseColor": "paint.jpg"}
    assert _bound(parse_max(fb.build_max(), load_arrays=True)) == {
        "DiffuseColor": "paint.jpg"}


# ------------------------------------------------- what an older 3ds Max writes


@pytest.mark.parametrize("chunk", fb.MAX_PARAM_IDS)
def test_a_parameter_is_read_under_either_id_its_block_uses(chunk):
    """3ds Max 2012 keeps them at 0x000E and later versions at 0x100E.

    The record behind both is the same, and a reader that knows only the later
    id finds no parameters at all in a 2012 scene — so every material in it
    falls back to grey and the whole car comes out unpainted.
    """
    props = _material_props(parse_max(fb.build_max(shader="Blinn", param_chunk=chunk),
                                      load_arrays=True))
    assert [round(v, 3) for v in props["DiffuseColor"]] == list(fb.MAX_DIFFUSE)
    assert [round(v, 3) for v in props["SpecularColor"]] == list(fb.MAX_SPECULAR)


def test_the_older_asset_table_names_its_files_by_path_alone():
    """It holds the kind and the path where the newer one holds a name between
    them, and a record read as though it had three strings is no record."""
    doc = parse_max(fb.build_max(assets_version=2), load_arrays=True)
    assets = doc.extra["assets"]
    assert [a["path"] for a in assets] == ["C:\\models\\paint.jpg"]
    # With nothing to call it by, the last step of the path is its name.
    assert [a["name"] for a in assets] == ["paint.jpg"]
    assert doc.extra["textures"] == ["paint.jpg"]
