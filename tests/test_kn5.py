"""Tests for the Assetto Corsa .kn5 reader.

A ``.kn5`` is a forward walk with no offsets and no lengths above the record
level: a texture table, a material table, then a node tree.  Nothing in it says
where anything is, so a reader that mis-sizes one field walks off the rest of
the file — which is what most of these are really checking.
"""

from __future__ import annotations

import os
import struct
from pathlib import Path

import pytest

import fbxbuild as fb
from fbxtool import analyze, parse_bytes, read_fbx
from fbxtool.model import ParseError
from fbxtool.reader import detect_format
from fbxtool.report import render_text, to_dict

ROOT = Path(__file__).resolve().parent.parent


# --------------------------------------------------------------- a small car

#: One triangle, with the four streams the game interleaves per vertex.
TRIANGLE = [
    ((0.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0), (1.0, 0.0, 0.0)),
    ((1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (1.0, 0.25), (1.0, 0.0, 0.0)),
    ((0.0, 0.0, 1.0), (0.0, 1.0, 0.0), (0.0, 1.0), (1.0, 0.0, 0.0)),
]

IDENTITY = (1.0, 0.0, 0.0, 0.0,
            0.0, 1.0, 0.0, 0.0,
            0.0, 0.0, 1.0, 0.0,
            0.0, 0.0, 0.0, 1.0)


def placed(x: float, y: float, z: float, *, scale: float = 1.0):
    """A row-major transform with the translation in the last row."""
    return (scale, 0.0, 0.0, 0.0,
            0.0, scale, 0.0, 0.0,
            0.0, 0.0, scale, 0.0,
            x, y, z, 1.0)


def body_material() -> bytes:
    return fb.kn5_material(
        "body", "ksPerPixelMultiMap",
        properties=(fb.kn5_property("ksAmbient", 0.3)
                    + fb.kn5_property("ksDiffuse", 0.4)
                    + fb.kn5_property("ksSpecular", 0.5)
                    + fb.kn5_property("ksSpecularEXP", 200.0)
                    + fb.kn5_property("fresnelC", 0.04)
                    + fb.kn5_property("ksEmissive", 0.0, c=(0.0, 0.5, 1.0))),
        property_count=6,
        slots=(("txDiffuse", 0, "paint.dds"),
               ("txNormal", 1, "body_n.dds"),
               ("txMaps", 2, "maps.dds")))


def glass_material() -> bytes:
    return fb.kn5_material(
        "glass", "ksPerPixelReflection", blend=1,
        properties=fb.kn5_property("fresnelC", 0.0), property_count=1,
        slots=(("txDiffuse", 0, "paint.dds"),))


def grille_material() -> bytes:
    return fb.kn5_material(
        "grille", "ksPerPixelAT", alpha_tested=True,
        properties=fb.kn5_property("ksAlphaRef", 0.4), property_count=1,
        slots=())


def small_car(version: int = 6) -> bytes:
    """A texture, three materials, and a wheel hung off the body."""
    mesh = fb.kn5_mesh("tyre", TRIANGLE, [0, 1, 2, 2, 1, 0], material=1)
    wheel = fb.kn5_dummy("WHEEL_LF", placed(0.8, 0.36, 1.41), mesh, 1)
    root = fb.kn5_dummy("car", IDENTITY, wheel, 1)
    return fb.build_kn5(
        version,
        textures=[("paint.dds", fb.dds_bc1())],
        materials=[body_material(), glass_material(), grille_material()],
        tree=root)


@pytest.fixture(scope="module")
def car():
    return parse_bytes(small_car(), load_arrays=True)


def objects_of(doc, kind: str) -> list:
    return doc.root.path("Objects").get_all(kind)


def properties_of(node) -> dict:
    """A Properties70 block as a name -> values dict."""
    out = {}
    for entry in node.path("Properties70").children:
        values = [prop.value for prop in entry.props]
        payload = values[4:]
        out[values[0]] = payload[0] if len(payload) == 1 else payload
    return out


# ------------------------------------------------------------------ the file

def test_a_kn5_is_recognised_from_its_first_six_bytes():
    """Nothing else the tool reads begins "sc6969", so the head settles it."""
    assert detect_format(small_car()[:8192]) == "kn5"
    assert detect_format(b"sc6969" + b"\x00" * 64) == "kn5"
    assert detect_format(b"sc69" + b"\x00" * 64) != "kn5"


def test_the_version_before_five_extra_bytes_reads_the_same(car):
    """Version 6 puts one more number in the header, and nothing else moves.

    Read as a version 5 file it would be four bytes out for the whole of the
    rest, which is the sort of mistake that produces a plausible texture count
    and then nonsense — so both are read and held against each other.
    """
    five = parse_bytes(small_car(version=5), load_arrays=True)
    assert five.extra["kn5_version"] == 5
    assert car.extra["kn5_version"] == 6
    for key in ("materials", "meshes", "nodes", "vertices", "triangles"):
        assert five.extra[key] == car.extra[key]


def test_a_file_cut_short_is_reported_rather_than_guessed_at():
    whole = small_car()
    with pytest.raises(ParseError):
        parse_bytes(whole[:len(whole) - 40])


def test_a_node_class_this_reader_does_not_know_is_refused():
    """Better to say so than to walk off into the rest of the file."""
    whole = bytearray(small_car())
    at = whole.index(b"\x03\x00\x00\x00car") - 1
    whole[at - 3:at + 1] = struct.pack("<i", 9)
    with pytest.raises(ParseError, match="node class 9"):
        parse_bytes(bytes(whole))


def test_the_whole_file_is_consumed(car):
    """A reader that stops early leaves a warning saying so, and this does not."""
    assert not any("past the end" in w for w in car.warnings)


# ------------------------------------------------------------------ geometry

def test_the_mesh_arrives_as_the_records_every_other_reader_produces(car):
    geometry = objects_of(car, "Geometry")
    assert len(geometry) == 1
    mesh = geometry[0]
    assert mesh.get("Vertices").props[0].value == [
        0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0]
    # A polygon run, as FBX writes it: the last corner of each triangle is
    # stored as its complement.
    assert mesh.get("PolygonVertexIndex").props[0].value == [0, 1, -3, 2, 1, -1]
    normals = mesh.get("LayerElementNormal").get("Normals")
    assert normals.props[0].value == [0.0, 1.0, 0.0] * 3
    assert mesh.get("LayerElementNormal").path_value("MappingInformationType") \
        == "ByVertice"


def test_v_is_measured_from_the_other_end_of_the_texture(car):
    """The game measures V down from the top, as Direct3D does; FBX up.

    Left alone, every texture on the car is upside down — which on a number
    plate or a badge is obvious and on a panel is not.
    """
    uv = objects_of(car, "Geometry")[0].get("LayerElementUV").get("UV")
    assert uv.props[0].value == [0.0, 1.0, 1.0, 0.75, 0.0, 0.0]


def test_the_arrays_are_only_unpacked_when_they_are_asked_for():
    """Their lengths are reported either way, which is what keeps a listing
    of an eighty-megabyte car cheap."""
    doc = parse_bytes(small_car())
    vertices = objects_of(doc, "Geometry")[0].get("Vertices").props[0]
    assert vertices.value is None
    assert vertices.array.length == 9


# ---------------------------------------------------------------- placement

def test_a_node_is_placed_where_its_transform_puts_it(car):
    models = {obj.value(1).split("\x00")[0]: obj for obj in objects_of(car, "Model")}
    props = properties_of(models["WHEEL_LF"])
    assert props["Lcl Translation"] == pytest.approx([0.8, 0.36, 1.41])
    # Nothing is written for a turn of nothing or a scale of one.
    assert "Lcl Rotation" not in props
    assert "Lcl Scaling" not in props


def test_a_scale_is_read_off_the_basis_it_is_baked_into():
    tree = fb.kn5_dummy("big", placed(0.0, 0.0, 0.0, scale=2.5))
    doc = parse_bytes(fb.build_kn5(tree=tree))
    props = properties_of(objects_of(doc, "Model")[0])
    assert props["Lcl Scaling"] == pytest.approx([2.5, 2.5, 2.5])


def test_a_half_turn_comes_back_as_a_turn_and_not_as_a_mirror():
    """Two negated axes are a rotation, and the real files are full of them —
    a right-hand wheel is the left one turned round."""
    tree = fb.kn5_dummy("RIM_RF", (-1.0, 0.0, 0.0, 0.0,
                                   0.0, 1.0, 0.0, 0.0,
                                   0.0, 0.0, -1.0, 0.0,
                                   0.0, 0.0, 0.0, 1.0))
    doc = parse_bytes(fb.build_kn5(tree=tree))
    props = properties_of(objects_of(doc, "Model")[0])
    assert props["Lcl Rotation"] == pytest.approx([180.0, 0.0, 180.0])
    assert "Lcl Scaling" not in props, "a turn is not a scale"


def test_a_mirror_is_kept_as_a_mirror_rather_than_turned_into_a_rotation():
    """One negated axis is a reflection, and no rotation produces one: taken
    as a rotation the part comes back the right way round and inside out."""
    tree = fb.kn5_dummy("mirrored", (-1.0, 0.0, 0.0, 0.0,
                                     0.0, 1.0, 0.0, 0.0,
                                     0.0, 0.0, 1.0, 0.0,
                                     0.0, 0.0, 0.0, 1.0))
    doc = parse_bytes(fb.build_kn5(tree=tree))
    props = properties_of(objects_of(doc, "Model")[0])
    assert props["Lcl Scaling"] == pytest.approx([-1.0, 1.0, 1.0])
    assert "Lcl Rotation" not in props, "a mirror is not a turn"


def test_the_hierarchy_is_the_one_the_file_describes(car):
    info = analyze(car)
    assert len(info.roots) == 1
    root = info.roots[0].children[0]
    assert root.obj.display_name == "car"
    wheel = root.children[0]
    assert wheel.obj.display_name == "WHEEL_LF"
    # The mesh sits where its parent puts it; the format gives it no transform.
    tyre = wheel.children[0]
    assert tyre.obj.subclass == "Mesh"
    assert {a.node_type for a in tyre.attachments} == {"Geometry", "Material"}


def test_the_axes_are_the_games_own(car):
    """Right handed, Y up, metres, with +Z towards the front of the car —
    which leaves the third axis pointing at its left-hand side."""
    settings = analyze(car).global_settings
    assert settings["up_axis"] == "+Y"
    assert settings["front_axis"] == "+Z"
    assert settings["coord_axis"] == "-X"
    assert settings["units"] == "metres"


# ---------------------------------------------------------------- materials

def test_a_reflection_is_written_as_the_reflectance_the_file_states(car):
    """`fresnelC` is what comes back facing you, so that is what is written —
    not a Phong highlight that has to be capped before it is believed."""
    body = next(m for m in objects_of(car, "Material") if m.value(1).startswith("body"))
    props = properties_of(body)
    assert props["SpecularColor"] == pytest.approx([0.04, 0.04, 0.04])
    assert props["ShininessExponent"] == 200.0
    assert props["Metallic"] == 0.0, "a reflectance this low is a dielectric"


def test_a_surface_that_reflects_nothing_says_so(car):
    glass = next(m for m in objects_of(car, "Material") if m.value(1).startswith("glass"))
    assert properties_of(glass)["SpecularColor"] == [0.0, 0.0, 0.0]


# ----------------------------------------------------------------- metalness

def chrome(facing: float, *, blend: int = 0, shader: str = "ksPerPixelReflection"):
    """A material reflecting *facing* of what hits it head on."""
    material = fb.kn5_material("trim", shader, blend=blend,
                               properties=fb.kn5_property("fresnelC", facing),
                               property_count=1)
    doc = parse_bytes(fb.build_kn5(materials=[material],
                                   tree=fb.kn5_dummy("car", IDENTITY)))
    return properties_of(objects_of(doc, "Material")[0]), doc


@pytest.mark.parametrize("facing,expected,what", [
    (0.010, 0.0, "leather, which reflects almost nothing"),
    (0.040, 0.0, "the 4% every dielectric reflects"),
    (0.150, 0.0, "an artist being generous with a windscreen"),
    (0.170, 0.0, "diamond, and the most a dielectric can be"),
    (0.300, 0.394, "chrome trim as one artist wrote it"),
    (0.500, 1.0, "where the dullest conductors start"),
    (1.000, 1.0, "a mirror"),
    (2.000, 1.0, "an artist writing 'as much as possible'"),
], ids=["leather", "plastic", "glassy", "diamond", "chrome", "iron", "mirror", "over"])
def test_metalness_is_read_from_what_a_surface_reflects_facing_you(facing, expected, what):
    """A kn5 states no metalness — the game shades a car with a Blinn-Phong
    highlight and a Schlick Fresnel over it, and chrome is a material whose
    `fresnelC` an artist set high.

    But that number is a reflectance at normal incidence, and it is the one
    place the two kinds of surface cannot be confused: no dielectric reflects
    more than about 17% facing you, and no metal less than about half.
    """
    props, _ = chrome(facing)
    assert props["Metallic"] == pytest.approx(expected, abs=1e-3), what


def test_a_metal_takes_its_share_of_the_surface_from_the_diffuse():
    """Split the two halves the way every importer here does, so that what is
    left of the diffuse and what the surface reflects still add up."""
    props, _ = chrome(0.5)
    assert props["Metallic"] == pytest.approx(1.0)
    assert props["DiffuseColor"] == pytest.approx([0.0, 0.0, 0.0])
    assert props["SpecularColor"] == pytest.approx([1.0, 1.0, 1.0])
    half, _ = chrome(0.335)               # halfway up the ramp
    assert half["Metallic"] == pytest.approx(0.5, abs=1e-3)
    assert half["DiffuseColor"] == pytest.approx([0.5, 0.5, 0.5])
    # The dielectric's own reflectance on the half that is not metal, and the
    # conductor's on the half that is.
    assert half["SpecularColor"] == pytest.approx([0.335 * 0.5 + 0.5] * 3, abs=1e-3)


def test_nothing_the_file_says_is_see_through_is_read_as_metal():
    """Light passes through a dielectric and not through a conductor, so a
    windscreen with a strong reflection is a windscreen."""
    props, _ = chrome(0.6, blend=1)
    assert props["AlphaMode"] == "BLEND"
    assert props["Metallic"] == 0.0
    assert props["SpecularColor"] == pytest.approx([0.6, 0.6, 0.6])


def test_how_many_metals_a_car_holds_is_counted(car):
    assert car.extra["metals"] == 0, "nothing in the fixture reflects that much"
    doc = parse_bytes(fb.build_kn5(
        materials=[fb.kn5_material("chrome", "ksPerPixelReflection",
                                   properties=fb.kn5_property("fresnelC", 0.4),
                                   property_count=1),
                   body_material()],
        tree=fb.kn5_dummy("car", IDENTITY)))
    assert doc.extra["metals"] == 1
    assert "1 reflect more facing you" in render_text(analyze(doc))


def test_the_colour_comes_from_the_texture_and_not_from_the_material(car):
    """A kn5 material has no colour of its own: `ksDiffuse` weights the game's
    own lighting, and the albedo is whatever `txDiffuse` holds."""
    body = next(m for m in objects_of(car, "Material") if m.value(1).startswith("body"))
    props = properties_of(body)
    assert props["DiffuseColor"] == [1.0, 1.0, 1.0]
    # …and what it does say is still there under the name it said it with.
    assert props["ksDiffuse"] == pytest.approx(0.4)
    assert props["ksAmbient"] == pytest.approx(0.3)
    assert props["ShaderName"] == "ksPerPixelMultiMap"


def test_an_emissive_written_as_a_colour_is_read_as_one(car):
    """`ksEmissive` is a single number on most materials and three on the ones
    that light up, and the three are in a different place in the record."""
    body = next(m for m in objects_of(car, "Material") if m.value(1).startswith("body"))
    assert properties_of(body)["EmissiveColor"] == [0.0, 0.5, 1.0]


def test_how_the_file_asked_to_be_blended_is_carried(car):
    by_name = {m.value(1).split("\x00")[0]: properties_of(m)
               for m in objects_of(car, "Material")}
    assert by_name["body"]["AlphaMode"] == "OPAQUE"
    assert by_name["glass"]["AlphaMode"] == "BLEND"
    assert by_name["grille"]["AlphaMode"] == "MASK"
    assert by_name["grille"]["AlphaCutoff"] == pytest.approx(0.4)


# ----------------------------------------------------------------- textures

def test_one_texture_record_is_shared_by_every_material_that_wears_it(car):
    """A car's paint is worn by dozens of materials, and copying sixty
    megabytes of DDS once per slot is not a description of anything."""
    textures = objects_of(car, "Texture")
    names = sorted(t.value(1).split("\x00")[0] for t in textures)
    assert names == ["body_n.dds", "maps.dds", "paint.dds"]
    assert len(objects_of(car, "Video")) == 3

    paint = next(t for t in textures if t.value(1).startswith("paint"))
    info = analyze(car)
    wearing = [c for c in info.connections if c.kind == "OP" and c.src == paint.value(0)]
    assert len(wearing) == 2, "the body and the glass both name it"
    assert {c.prop for c in wearing} == {"DiffuseColor"}


def test_a_slot_with_no_fbx_meaning_keeps_the_name_the_game_gives_it(car):
    """`txMaps` is not a metallic-roughness map however much it looks like one;
    drawn from the wrong end it is worse than not drawn at all."""
    info = analyze(car)
    slots = {c.prop for c in info.connections if c.kind == "OP"}
    assert slots == {"DiffuseColor", "NormalMap", "txMaps"}


def test_the_dents_a_damage_shader_names_are_not_laid_over_an_undamaged_car():
    """On the shaders that model a car being crashed, `txNormal` is not the
    surface's own relief — it is the dents, blended in as damage accumulates.

    A car as saved has none. The Mercedes' body names a 1024-square of them
    there, and drawn at face value every panel comes out beaten in, with the
    sun catching each crease pink.
    """
    crashable = fb.kn5_material(
        "body", "ksPerPixelMultiMap_damage_dirt",
        slots=(("txDiffuse", 0, "paint.dds"), ("txNormal", 1, "dents.png")))
    plain = fb.kn5_material(
        "trim", "ksPerPixelNM",
        slots=(("txDiffuse", 0, "paint.dds"), ("txNormal", 1, "trim_n.dds")))
    doc = parse_bytes(fb.build_kn5(materials=[crashable, plain],
                                   tree=fb.kn5_dummy("car", IDENTITY)))
    info = analyze(doc)
    by_uid = {obj.uid: obj for obj in info.objects}
    worn = {(by_uid[c.dst].name, by_uid[c.src].name): c.prop
            for c in info.connections if c.kind == "OP"}
    assert worn[("body", "dents.png")] == "txNormal", "carried, but not drawn"
    assert worn[("trim", "trim_n.dds")] == "NormalMap"
    # The colour is the colour whichever shader asked for it.
    assert worn[("body", "paint.dds")] == "DiffuseColor"


def test_an_embedded_texture_arrives_as_bytes_on_the_clip(car):
    video = next(v for v in objects_of(car, "Video") if v.value(1).startswith("paint"))
    content = video.get("Content")
    assert content is not None
    assert bytes(content.props[0].value)[:4] == b"DDS "
    # The two the file names but does not hold have nothing on them.
    absent = next(v for v in objects_of(car, "Video") if v.value(1).startswith("maps"))
    assert absent.get("Content") is None
    assert absent.path_value("RelativeFilename") == "maps.dds"


def test_a_texture_named_but_not_held_is_said_out_loud(car):
    """A LOD carries no textures at all and reads them from the car's main
    file — which is worth saying rather than drawing the LOD untextured and
    leaving it to be guessed at."""
    assert car.extra["missing_textures"] == ["body_n.dds", "maps.dds"]
    assert any("named by a material but not in this file" in w for w in car.warnings)


def test_a_car_published_with_its_textures_stripped_out_is_said_to_be():
    """Cars are published with the pictures taken out and something else put in
    the file after the node tree: every entry in the table is then the same
    seventy-byte image, under the name of the texture that used to be there.

    Carried, that paints the whole car in one colour — a Ford Puma rally car
    comes out translucent blue from end to end. Read for what it is, the car
    draws in its own material colours and every texture is listed as one to go
    and find.
    """
    stand_in = fb.png(1, 1, bytes((0, 0, 255)))
    doc = parse_bytes(fb.build_kn5(
        textures=[("paint.dds", stand_in), ("trim.dds", stand_in),
                  ("glass.dds", stand_in)],
        materials=[body_material()],
        tree=fb.kn5_dummy("car", IDENTITY)))
    assert doc.extra["placeholder_textures"] == 3
    assert doc.extra["texture_bytes"] == 0
    assert any("stripped out" in w for w in doc.warnings)
    # Nothing is carried, and every name a material gave is one to go and find.
    assert all(v.get("Content") is None for v in objects_of(doc, "Video"))
    assert doc.extra["missing_textures"] == ["body_n.dds", "maps.dds", "paint.dds"]
    assert "stripped out" in render_text(analyze(doc))


def test_textures_that_merely_repeat_are_not_mistaken_for_stand_ins():
    """A car really does reuse a 16-square of flat black several times over."""
    black = fb.dds_bgra(16, 16, bytes([0, 0, 0, 255]) * 256)
    checker = fb.dds_bc1()
    doc = parse_bytes(fb.build_kn5(
        textures=[("black.dds", black), ("ac_black.dds", black),
                  ("paint.dds", checker)],
        materials=[body_material()], tree=fb.kn5_dummy("car", IDENTITY)))
    assert doc.extra["placeholder_textures"] == 0
    assert doc.extra["texture_bytes"] == 2 * len(black) + len(checker)


# ------------------------------------------------------- a protected car

def spoiled_car(*, scramble: bool, encrypt: bool) -> bytes:
    """A car big enough to judge: 40 cubes, 480 triangles between them."""
    stand_in = fb.png(1, 1, bytes((0, 0, 255)))
    meshes = b""
    for at in range(40):
        vertices, indices = fb.kn5_cube(0.5)
        if scramble:
            vertices, indices = fb.kn5_scrambled(vertices, indices)
        meshes += fb.kn5_mesh(f"part{at}", vertices, indices)
    model = fb.build_kn5(
        6, textures=[(f"tex{at}.dds", stand_in) for at in range(4)],
        materials=[fb.kn5_material("paint")],
        tree=fb.kn5_dummy("car", IDENTITY, meshes, 40))
    return fb.kn5_encrypted(model) if encrypt else model


def test_geometry_that_disagrees_with_its_own_normals_is_reported():
    """A triangle's corners in order give it a facing, and the normals its
    vertices carry should agree — the exporter wrote both from one surface.

    Cars are published deliberately spoiled, the vertex stream scrambled so
    that anything but the game draws a shattered model. Nothing in the header
    says so: the counts are right, the normals are unit vectors, and every
    index is in range. Held against each other, the two say it plainly.
    """
    sound = parse_bytes(spoiled_car(scramble=False, encrypt=False))
    assert sound.extra["winding_agreement"] == 1.0
    assert sound.extra["scrambled"] is False
    assert not any("wound" in w for w in sound.warnings)

    spoiled = parse_bytes(spoiled_car(scramble=True, encrypt=False))
    assert spoiled.extra["winding_agreement"] == pytest.approx(0.5, abs=0.05)
    assert spoiled.extra["scrambled"] is True
    assert any("not the shape that was modelled" in w for w in spoiled.warnings)
    assert "wound the way their own normals point" in render_text(analyze(spoiled))


def test_a_car_the_game_holds_back_says_so_in_plain_text():
    """A protected car ends with Custom Shaders Patch's marker, the offset the
    encrypted part starts at, and a version — and what is in front of it has
    been spoiled to match.  The game decrypts it; nothing here does."""
    doc = parse_bytes(spoiled_car(scramble=True, encrypt=True))
    assert doc.extra["encrypted"] is True
    assert doc.extra["encrypted_from"] > 0
    assert doc.extra["placeholder_textures"] == 4
    warning = next(w for w in doc.warnings if "protected" in w)
    assert "__AC_SHADERS_PATCH_KN5ENC_v1__" in warning
    assert "nothing here does" in warning
    # One warning for the whole story rather than three halves of it.
    assert len(doc.warnings) == 1
    assert "Custom Shaders Patch" in render_text(analyze(doc))


def test_a_sound_car_is_not_called_protected(car):
    assert car.extra["encrypted"] is False
    assert car.extra["encrypted_from"] is None
    assert car.extra["scrambled"] is False


def test_a_file_too_small_to_judge_is_not_judged(car):
    """One cube is eight triangles, and eight is not a verdict."""
    vertices, indices = fb.kn5_scrambled(*fb.kn5_cube())
    doc = parse_bytes(fb.build_kn5(
        materials=[fb.kn5_material("paint")],
        tree=fb.kn5_dummy("car", IDENTITY, fb.kn5_mesh("cube", vertices, indices), 1)))
    assert doc.extra["winding_agreement"] < 0.75, "the sample says so"
    assert doc.extra["scrambled"] is False, "but there was not enough of it"


def test_what_the_file_holds_is_counted_by_kind(car):
    assert car.extra["textures"] == 1
    assert car.extra["texture_formats"] == {"DDS": 1}
    assert car.extra["texture_bytes"] == len(fb.dds_bc1())


# ------------------------------------------------------------ skinned meshes

def test_a_skinned_mesh_is_read_through_its_bones_to_its_triangles():
    """Its vertices are 76 bytes rather than 44 and its tail is shorter by a
    bounding sphere — get either wrong and the rest of the file is nonsense."""
    bones = b""
    for name in ("root", "spine"):
        bones += fb._kn5_text(name) + struct.pack("<16f", *IDENTITY)
    body = bytearray(struct.pack("<i", 3) + fb._kn5_text("driver")
                     + struct.pack("<i", 0) + b"\x01" + bytes((1, 1, 0)))
    body += struct.pack("<i", 2) + bones
    body += struct.pack("<I", 3)
    for position, normal, uv, tangent in TRIANGLE:
        body += struct.pack("<3f3f2f3f", *position, *normal, *uv, *tangent)
        body += struct.pack("<4f", 1.0, 0.0, 0.0, 0.0)      # weights
        body += struct.pack("<4f", 0.0, 0.0, 0.0, 0.0)      # bone indices
    body += struct.pack("<I", 3) + struct.pack("<3H", 0, 1, 2)
    body += struct.pack("<iI", 0, 0) + struct.pack("<2f", 0.0, 0.0)

    doc = parse_bytes(fb.build_kn5(materials=[body_material()],
                                   tree=fb.kn5_dummy("car", IDENTITY, bytes(body), 1)),
                      load_arrays=True)
    assert doc.extra["skinned_meshes"] == 1
    assert doc.extra["bones"] == 2
    assert not any("past the end" in w for w in doc.warnings)
    geometry = objects_of(doc, "Geometry")[0]
    assert geometry.get("Vertices").props[0].value[:3] == [0.0, 0.0, 0.0]
    assert geometry.get("PolygonVertexIndex").props[0].value == [0, 1, -3]


# ------------------------------------------------------------------- report

def test_what_is_not_drawn_is_counted_rather_than_dropped():
    """A car carries its own spares — a hidden variant of a wing, a node the
    game switches on — and a count that ignores them describes another car."""
    hidden = fb.kn5_mesh("spare", TRIANGLE, [0, 1, 2], visible=False)
    off = fb.kn5_dummy("OFF", IDENTITY, active=False)
    tree = fb.kn5_dummy("car", IDENTITY, hidden + off, 2)
    doc = parse_bytes(fb.build_kn5(materials=[body_material()], tree=tree))
    assert doc.extra["hidden_meshes"] == 1
    assert doc.extra["inactive_nodes"] == 1


def test_a_lod_group_is_named_in_the_report():
    tree = fb.kn5_dummy("car", IDENTITY, fb.kn5_dummy("LOD_A", IDENTITY), 1)
    doc = parse_bytes(fb.build_kn5(tree=tree))
    assert doc.extra["lods"] == ["LOD_A"]
    assert "LOD_A" in render_text(analyze(doc))


def test_the_report_says_what_the_file_is(car):
    text = render_text(analyze(car))
    assert "Assetto Corsa kn5" in text
    assert "kn5 version" in text
    assert "ksPerPixelMultiMap" in text
    assert "1 vertices, 2 triangles" not in text     # counted per file, not per mesh
    assert "3 vertices, 2 triangles" in text


def test_the_json_carries_what_is_only_true_of_a_kn5(car):
    payload = to_dict(analyze(car))
    assert payload["file"]["format"] == "kn5"
    assert payload["format_details"]["kn5_version"] == 6
    assert payload["format_details"]["shaders"] == [
        "ksPerPixelAT", "ksPerPixelMultiMap", "ksPerPixelReflection"]


def test_a_file_on_disk_is_read_by_the_same_route(tmp_path):
    path = tmp_path / "car.kn5"
    path.write_bytes(small_car())
    doc = read_fbx(str(path))
    assert doc.format == "kn5"
    assert doc.file_size == path.stat().st_size


# ----------------------------------------------------- a real car, if there is one

def real_kn5() -> str | None:
    candidate = os.environ.get("FBXTOOL_KN5")
    return candidate if candidate and Path(candidate).is_file() else None


@pytest.fixture(scope="module")
def real_kn5_path() -> str:
    """A car shipped with the game.

    Set ``FBXTOOL_KN5`` to one; none is checked in, since they are tens of
    megabytes apiece and not ours to redistribute.
    """
    candidate = real_kn5()
    if candidate:
        return candidate
    pytest.skip("set FBXTOOL_KN5 to a real .kn5 file to run this test")


def test_a_real_car_is_read_to_its_last_byte(real_kn5_path):
    """Which is the whole test: the format has no offsets and no lengths above
    the record level, so a reader that mis-sizes one field cannot reach the
    end of the file — and one that reaches it read every field correctly."""
    doc = read_fbx(real_kn5_path, load_arrays=True)
    assert not any("past the end" in w for w in doc.warnings)
    assert doc.extra["meshes"] > 0
    assert doc.extra["vertices"] > 0
    assert doc.extra["materials"] > 0
    info = analyze(doc)
    assert info.roots, "a car is one tree hanging off one root"
