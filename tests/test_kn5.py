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
from fbxtool import analyze, kn5, parse_bytes, read_fbx
from fbxtool.model import ParseError
from fbxtool.reader import detect_format
from fbxtool.report import render_text, to_dict

ROOT = Path(__file__).resolve().parent.parent
NL = chr(10)


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

def chrome(facing: float, *, blend: int = 0, shader: str = "ksPerPixelReflection",
           ceiling: float | None = None):
    """A material reflecting *facing* of what hits it head on.

    *ceiling* is the `fresnelMaxLevel` beside it, which every real material
    states and which holds the whole Fresnel term down.
    """
    props = fb.kn5_property("fresnelC", facing)
    count = 1
    if ceiling is not None:
        props += fb.kn5_property("fresnelMaxLevel", ceiling)
        count += 1
    material = fb.kn5_material("trim", shader, blend=blend,
                               properties=props, property_count=count)
    doc = parse_bytes(fb.build_kn5(materials=[material],
                                   tree=fb.kn5_dummy("car", IDENTITY)))
    return properties_of(objects_of(doc, "Material")[0]), doc


@pytest.mark.parametrize("facing,ceiling,expected,what", [
    (1.00, 0.03, 0.03, "a Z3M's tail lamp lens, which the game draws see-through"),
    (5.00, 0.02, 0.02, "an Alfa TZ2's tyre, stating what cannot be a reflectance"),
    (0.20, 0.40, 0.20, "glass, whose ceiling is above it and changes nothing"),
    (0.00, 0.05, 0.00, "a lamp body, reflecting nothing head on"),
    (2.00, 0.70, 0.70, "an Audi's `metalll`, held to seven tenths"),
    (0.04, None, 0.04, "a material stating no ceiling, which none of them do"),
], ids=["lens", "tyre", "glass", "lamp", "metal", "silent"])
def test_the_reflectance_is_what_the_pair_of_them_come_to(facing, ceiling, expected, what):
    """`fresnelC` is the Schlick base and `fresnelMaxLevel` is a ceiling on the
    whole term — not the value at a grazing angle, which is what the pair reads
    like until you see the numbers.

    A BMW Z3M's `lightclear` states 1.0 and 0.03. Read as a base alone it is a
    perfect mirror, and the tail lamp comes out an opaque white blade instead
    of the see-through red lens it is. An Alfa TZ2's `EXT_TYRE` settles which
    way round it goes: 5.0 is not a reflectance at all and can only be a number
    something clamps.

    The two always travel together — of 1853 materials across the cars to hand,
    1075 state both and 778 state neither, and not one states only one.
    """
    stated = {"fresnelC": (facing, (), (), ())}
    if ceiling is not None:
        stated["fresnelMaxLevel"] = (ceiling, (), (), ())
    material = kn5._Material("trim", "ksPerPixelReflection", 0, 0, 0, stated, [])
    assert kn5._reflectance(material) == pytest.approx(expected, abs=1e-3), what

    # And it is that, rather than what `fresnelC` says alone, that the file
    # comes out stating — below the point where a metalness would split it.
    if expected <= 0.17:
        written, _ = chrome(facing, ceiling=ceiling)
        assert written["SpecularColor"][0] == pytest.approx(expected, abs=1e-3), what


def test_a_reflectance_held_down_is_not_read_as_metal():
    """Which is the whole of why it matters twice over. An Alfa TZ2's tyre
    states 5.0 and is held to 0.02: read without the ceiling it is a full
    conductor, its diffuse cancelled outright, and a tyre draws as a mirror."""
    loose, _ = chrome(5.0)
    assert loose["Metallic"] == pytest.approx(1.0), "5.0 on its own is a mirror"
    held, _ = chrome(5.0, ceiling=0.02)
    assert held["Metallic"] == 0.0
    assert held["DiffuseColor"] == pytest.approx([1.0, 1.0, 1.0]),         "and its picture is drawn, rather than cancelled by a metalness"


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


def test_the_pattern_comes_from_the_texture_and_the_light_from_the_material(car):
    """A kn5 material states no colour of its own — `txDiffuse` is the albedo —
    but it does state how much of the light it takes, and the two multiply."""
    body = next(m for m in objects_of(car, "Material") if m.value(1).startswith("body"))
    props = properties_of(body)
    # 0.3 and 0.4 against the 0.5 and 0.6 a plainly lit surface states.
    assert props["DiffuseColor"] == pytest.approx([0.7 / 1.1] * 3)
    assert props["TintsTexture"] == 1, "read through the picture, not replaced by it"
    # …and what it said is still there under the name it said it with.
    assert props["ksDiffuse"] == pytest.approx(0.4)
    assert props["ksAmbient"] == pytest.approx(0.3)
    assert props["ShaderName"] == "ksPerPixelMultiMap"


def weighted(ambient=None, diffuse=None) -> float:
    """What one material's colour comes out as, stating these two weights."""
    props = b""
    count = 0
    for name, value in (("ksAmbient", ambient), ("ksDiffuse", diffuse)):
        if value is not None:
            props += fb.kn5_property(name, value)
            count += 1
    doc = parse_bytes(fb.build_kn5(
        materials=[fb.kn5_material("panel", properties=props, property_count=count)],
        tree=fb.kn5_dummy("car", IDENTITY)))
    return properties_of(objects_of(doc, "Material")[0])["DiffuseColor"][0]


@pytest.mark.parametrize("ambient,diffuse,expected,what", [
    (0.5, 0.6, 1.0, "the pair most of them state, and the editor's own default"),
    (0.4, 0.4, 0.727, "an Audi S8's paint, which is a shade off a plain surface"),
    (0.03, 0.01, 0.036, "its wheels, which the game draws black"),
    (0.0, 0.0, 0.0, "its headlight housings, which take no light at all"),
    (2.0, 2.0, 1.0, "a dashboard lit brighter than the light, which cannot be"),
    (None, None, 1.0, "a material stating neither, which is read as a plain one"),
], ids=["plain", "paint", "wheels", "lamps", "overbright", "silent"])
def test_how_much_of_the_light_a_material_takes_is_read(ambient, diffuse, expected, what):
    """`ksAmbient` and `ksDiffuse` weight the two halves of the game's own
    lighting rather than tinting anything, and both halves are diffuse — so in
    a viewer with one fixed light they have nowhere to go but the albedo, which
    is the same arithmetic.

    Read without them an Audi S8 comes up white from end to end: the pictures
    under its rims and its lamps are grey panel maps, and the colour was never
    in the picture.
    """
    assert weighted(ambient, diffuse) == pytest.approx(expected, abs=1e-3), what


def test_how_many_materials_are_dimmed_is_counted(car):
    """Which is most of a car: 94 of an Audi S8's 97."""
    assert car.extra["dimmed"] == 1, "the body states low weights; the other two state none"
    assert "1 take less of the light" in render_text(analyze(car))
    plain = parse_bytes(fb.build_kn5(
        materials=[fb.kn5_material(
            "panel", properties=(fb.kn5_property("ksAmbient", 0.5)
                                 + fb.kn5_property("ksDiffuse", 0.6)),
            property_count=2)],
        tree=fb.kn5_dummy("car", IDENTITY)))
    assert plain.extra["dimmed"] == 0
    assert "take less of the light" not in render_text(analyze(plain))


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


def test_the_paint_sitting_beside_a_car_is_counted(tmp_path):
    """A kn5 carries one set of textures and the game puts another over the
    top: everything under ``skins/<name>/`` replaces the texture of that name.

    So what is in the file is the car unpainted, and a car that comes up pale
    is not necessarily one that was read wrongly. An Audi S8's own textures are
    ambient occlusion over bare grey; its thirteen skins are what make it
    Alpine White or Sakhir Orange.
    """
    path = tmp_path / "car.kn5"
    path.write_bytes(small_car())
    skins = tmp_path / "skins"
    for name, files in (("Alpine_White", ["paint.dds", "maps.dds", "readme.txt"]),
                        ("Sakhir_Orange", ["PAINT.DDS"]),
                        ("empty", [])):
        (skins / name).mkdir(parents=True)
        for entry in files:
            (skins / name / entry).write_bytes(b"")
    # A file that is not a folder, and a texture no material names, are both
    # beside the point and neither may upset the count.
    (skins / "notes.txt").write_bytes(b"")

    doc = read_fbx(str(path))
    assert doc.extra["skins"] == [
        {"name": "Alpine_White", "replaces": 2, "paints": []},
        # matched without regard to case
        {"name": "Sakhir_Orange", "replaces": 1, "paints": []},
        {"name": "empty", "replaces": 0, "paints": []},
    ]
    assert "Alpine_White puts 2 of its textures over the top" in render_text(analyze(doc))


def test_the_colour_a_skin_states_is_read_with_the_material_it_goes_on(tmp_path):
    """Two files, both the skin's own, so a car and the folder it came in are
    enough: `ext_config.ini` names the material and Content Manager's
    `cm_skin.json` gives the colour as `#AARRGGBB`.

    The alpha comes first, so taking the first six characters would paint the
    car with its own opacity — #FF1A2025 is a near-black blue and #FF1A20 a red.
    """
    path = tmp_path / "car.kn5"
    path.write_bytes(small_car())
    skins = tmp_path / "skins"
    for name, names_it, colour, extra in (
        ("Azurite", "body", '"#FF1A2025"', ""),
        ("Elsewhere", "some_other_car", '"#FF1A2025"', ""),
        ("SwitchedOff", "body", '"#FF1A2025"', ', "enabled": false'),
        ("Untouched", "body", '"#FFFFFFFF"', ', "enabled": false'),
        ("UntouchedBlack", "body", '"#FF000000"', ', "enabled": false'),
        ("Nonsense", "body", '"purple"', ""),
    ):
        (skins / name).mkdir(parents=True)
        (skins / name / "paint.dds").write_bytes(b"")
        (skins / name / "ext_config.ini").write_text(
            "CarPaintMaterial = " + names_it + chr(10), encoding="utf-8")
        (skins / name / "cm_skin.json").write_text(
            '{"carPaint": {"color": ' + colour + extra + '}}', encoding="utf-8")

    doc = read_fbx(str(path))
    by_name = {skin["name"]: skin for skin in doc.extra["skins"]}
    assert by_name["Azurite"]["paints"] == [
        {"material": "body", "colour": "#1a2025"}], "the alpha is not the red"
    # `enabled` is the paint shop's switch rather than a statement about the
    # car: a colour that is not plain white is the paint whichever way it is
    # set, and 78 skins of the 128 cars to hand say one with it off without
    # bringing any texture that colour could have been baked into instead.
    assert by_name["SwitchedOff"]["paints"] == [
        {"material": "body", "colour": "#1a2025"}]
    # The two colours a picker nobody opened was left holding state nothing —
    # plain white, which is where Content Manager opens, and black, which a
    # Scirocco's twelve skins say while being red and blue and silver.  And a
    # colour that is not one is not one.
    for name in ("Untouched", "UntouchedBlack", "Nonsense"):
        assert by_name[name]["paints"] == [], name
    # One whose config was copied from another car names a material this one
    # has not got — and is answered by what its siblings called the paint.
    assert by_name["Elsewhere"]["paints"] == [
        {"material": "body", "colour": "#1a2025"}]
    assert "paints body #1a2025" in render_text(analyze(doc))


def test_a_car_that_names_its_paint_once_for_every_skin_is_read_too(tmp_path):
    """Half of them declare which material is the paint in the car's own
    `extension/ext_config.ini` rather than in each skin, under the other of
    the two spellings — and state several, paired with the several colours a
    skin gives by the order both are written in.

    A Renault 5 names `body`, `body2` and `rim_colored` there and its skins
    answer with `extBody1`, `extBody2` and `extRims1`; without this the picker
    offers the skins and the car does not change colour.
    """
    path = tmp_path / "car.kn5"
    path.write_bytes(fb.build_kn5(
        materials=[fb.kn5_material("body"), fb.kn5_material("body2"),
                   fb.kn5_material("rim_colored")],
        tree=fb.kn5_dummy("car", IDENTITY)))
    (tmp_path / "extension").mkdir()
    (tmp_path / "extension" / "ext_config.ini").write_text(
        "[INCLUDE: common/materials_carpaint.ini]" + NL
        + "[Material_CarPaint_Metallic]" + NL
        + "Materials = body" + NL
        + "[Material_CarPaint_Metallic]" + NL
        + "Materials = body2" + NL
        + "[Material_CarPaint_Metallic]" + NL
        + "Materials = rim_colored" + NL
        # A `Materials` key outside a paint section is not the paint.
        + "[Material_Glass]" + NL
        + "Materials = glass" + NL, encoding="utf-8")
    skin = tmp_path / "skins" / "01_blue_olympe"
    skin.mkdir(parents=True)
    (skin / "paint.dds").write_bytes(b"")
    (skin / "cm_skin.json").write_text(
        '{"extBody1": {"color": "#FF003C7C"}, "extBody2": {"color": "#FF006ECE"},'
        ' "extRims1": {"color": "#FF046AC9"}, "carpet": {"enabled": true}}',
        encoding="utf-8")

    paints = read_fbx(str(path)).extra["skins"][0]["paints"]
    assert paints == [
        {"material": "body", "colour": "#003c7c"},
        {"material": "body2", "colour": "#006ece"},
        {"material": "rim_colored", "colour": "#046ac9"},
    ]


def test_a_skin_that_states_its_colour_in_its_own_config(tmp_path):
    """Half of them have no `cm_skin.json` at all. A chameleon paint states two
    colours in the config instead — one facing you and one at a grazing angle,
    each with an opacity after it — and only the first is taken, since there is
    one albedo here and A is what the car looks like from where you stand.

    And one colour is the car's however many materials the paint is spread
    over: a Clio V6 names `wccarbody` and `aleron`, its body and its spoiler,
    and states the one colour for both. Without either, "Illiad Blue" is white.
    """
    path = tmp_path / "car.kn5"
    path.write_bytes(fb.build_kn5(
        materials=[fb.kn5_material("wccarbody"), fb.kn5_material("aleron")],
        tree=fb.kn5_dummy("car", IDENTITY)))
    skin = tmp_path / "skins" / "Illiad_Blue"
    skin.mkdir(parents=True)
    (skin / "paint.dds").write_bytes(b"")
    (skin / "ext_config.ini").write_text(
        "[INCLUDE]" + NL
        + "CarPaintMaterial = wccarbody, aleron" + NL
        + "[Material_CarPaint_Chameleon]" + NL
        + "Skins=Illiad_Blue" + NL
        + "ChameleonColorA=#33007f, 0.50    ;first color and opacity" + NL
        + "ChameleonColorB=#ffff00, 0.25    ;second color and opacity" + NL,
        encoding="utf-8")

    doc = read_fbx(str(path))
    assert doc.extra["skins"][0]["paints"] == [
        {"material": "wccarbody", "colour": "#33007f"},
        {"material": "aleron", "colour": "#33007f"},
    ]


def test_what_a_car_calls_its_paint_is_settled_across_its_own_skins(tmp_path):
    """Three places say which material is the paint, in the order they are
    trusted: the skin's own config, the car's, and last what the car's *other*
    skins agree it is.

    That last is a reading of the folder rather than of one file, and it is
    what a folder of skins usually needs: an Audi S8 has thirteen, of which
    three name a material it has and five name `carpaint`, which it has not —
    configs copied from another car, colour and all. Left there, those five
    state a perfectly good colour and put it nowhere.
    """
    path = tmp_path / "car.kn5"
    path.write_bytes(small_car())
    for name, names_it, colour in (("knows", "body", "#FF111111"),
                                   ("copied", "some_other_car", "#FF222222"),
                                   ("silent", None, "#FF333333")):
        skin = tmp_path / "skins" / name
        skin.mkdir(parents=True)
        (skin / "paint.dds").write_bytes(b"")
        if names_it:
            (skin / "ext_config.ini").write_text(
                "CarPaintMaterial = " + names_it + NL, encoding="utf-8")
        (skin / "cm_skin.json").write_text(
            '{"carPaint": {"color": "' + colour + '"}}', encoding="utf-8")

    by_name = {skin["name"]: skin["paints"]
               for skin in read_fbx(str(path)).extra["skins"]}
    assert by_name["knows"] == [{"material": "body", "colour": "#111111"}]
    assert by_name["copied"] == [{"material": "body", "colour": "#222222"}]
    assert by_name["silent"] == [{"material": "body", "colour": "#333333"}]


def test_a_skin_that_states_no_colour_anywhere_brings_only_its_pictures(tmp_path):
    """Four of a Clio V6's six say nothing about colour in the folder at all —
    their config names the shader and no more. They are offered for what they
    do bring, and nothing is invented for the rest."""
    path = tmp_path / "car.kn5"
    path.write_bytes(small_car())
    skin = tmp_path / "skins" / "Acid_Yellow"
    skin.mkdir(parents=True)
    (skin / "paint.dds").write_bytes(b"")
    (skin / "ext_config.ini").write_text(
        "CarPaintMaterial = body" + NL
        + "[Material_CarPaint_Solid]" + NL
        + "Skins = Acid_Yellow" + NL, encoding="utf-8")
    doc = read_fbx(str(path))
    assert doc.extra["skins"][0] == {"name": "Acid_Yellow", "replaces": 1, "paints": []}


def test_a_car_that_names_its_paint_nowhere_is_read_by_its_paint_shop_slots(tmp_path):
    """A quarter of them say which material the paint is in no file at all.

    A Lamborghini LM002's fourteen skins are the shape of it: every one states
    its colour in `cm_skin.json`, and neither they nor the car carry an
    `ext_config.ini`.  Read for names alone the folder is silent and fourteen
    good colours go nowhere, which is what its skins did.

    What is left is the name the paint shop filed the colour under.  Content
    Manager opens `carPaint` on a car that has told it nothing, and the
    material the car wears is that name and a number: `carPaint02` over the
    doors and hood, `carPaint03` over the wheel-arch extenders, and the one
    stated colour belongs on both.

    Only a number, though.  The same car's `carPaint_010101FF` is a side-marker
    trim wearing its own colour in its own name, and painting that in the body
    colour is the one thing this must not do.
    """
    def paint(name: str) -> bytes:
        return fb.kn5_material(name, "ksPerPixelMultiMap",
                               slots=(("txDiffuse", 0, "paint.dds"),))

    path = tmp_path / "car.kn5"
    path.write_bytes(fb.build_kn5(
        6,
        textures=[("paint.dds", fb.dds_bc1())],
        materials=[paint("carPaint02"), paint("carPaint03"),
                   paint("carPaint_010101FF"), paint("rubbertrim_020202FF")],
        tree=fb.kn5_dummy("car", IDENTITY,
                          fb.kn5_mesh("body", TRIANGLE, [0, 1, 2], material=0), 1)))
    skins = tmp_path / "skins"
    (skins / "02_rosso").mkdir(parents=True)
    (skins / "02_rosso" / "cm_skin.json").write_text(
        '{"carPaint": {"color": "#FFA5080D", "enabled": false}}', encoding="utf-8")

    doc = read_fbx(str(path))
    paints = doc.extra["skins"][0]["paints"]
    # The body and the extenders, both, off the one colour the skin states.
    assert paints == [{"material": "carpaint02", "colour": "#a5080d"},
                      {"material": "carpaint03", "colour": "#a5080d"}]
    # And not the trim that wears its own colour in its own name.
    assert all("010101" not in p["material"] for p in paints)


def test_a_paint_shop_slot_is_the_last_thing_asked_about_a_material(tmp_path):
    """Weakest of the four, and only where the other three said nothing.

    A slot name is what Content Manager opened at rather than anything the car
    said about itself, so a car that does name its paint keeps that name even
    where a slot would have reached further.
    """
    def paint(name: str) -> bytes:
        return fb.kn5_material(name, "ksPerPixelMultiMap",
                               slots=(("txDiffuse", 0, "paint.dds"),))

    path = tmp_path / "car.kn5"
    path.write_bytes(fb.build_kn5(
        6,
        textures=[("paint.dds", fb.dds_bc1())],
        materials=[paint("carPaint02"), paint("carPaint03")],
        tree=fb.kn5_dummy("car", IDENTITY,
                          fb.kn5_mesh("body", TRIANGLE, [0, 1, 2], material=0), 1)))
    skins = tmp_path / "skins"
    (skins / "Named").mkdir(parents=True)
    (skins / "Named" / "ext_config.ini").write_text(
        "CarPaintMaterial = carPaint03" + chr(10), encoding="utf-8")
    (skins / "Named" / "cm_skin.json").write_text(
        '{"carPaint": {"color": "#FFA5080D"}}', encoding="utf-8")

    doc = read_fbx(str(path))
    assert doc.extra["skins"][0]["paints"] == [
        {"material": "carPaint03", "colour": "#a5080d"}], "the config still wins"


def test_a_car_with_nothing_beside_it_says_nothing_about_skins(tmp_path):
    path = tmp_path / "car.kn5"
    path.write_bytes(small_car())
    doc = read_fbx(str(path))
    assert doc.extra["skins"] == []
    assert "Skins" not in render_text(analyze(doc))
    # And one read from memory has nowhere to look.
    assert parse_bytes(small_car()).extra["skins"] == []


def test_a_file_on_disk_is_read_by_the_same_route(tmp_path):
    path = tmp_path / "car.kn5"
    path.write_bytes(small_car())
    doc = read_fbx(str(path))
    assert doc.format == "kn5"
    assert doc.file_size == path.stat().st_size


# ------------------------------------------------------- the colour of a lamp

_LAMPS = (
    "[REFRACTING_HEADLIGHT_...]" + NL
    + "SURFACE = glass_fog" + NL
    + "INSIDE = lc_fog" + NL
    + "GLASS_COLOR = 1, 0.80723137, 0.12472421" + NL
    + "EXTRA_GLASS_COLORIZATION = 1" + NL
    + "CUSTOM_BULB_0 = 0.5,0.5,0,0" + NL
    + NL
    + "[REFRACTING_HEADLIGHT_...]" + NL
    + "SURFACE = glass_turnfl, glass_turnfl2" + NL
    + "GLASS_COLOR = 0.9672982,0.2797753,0   ; amber" + NL
    + NL
    + "[REFRACTING_HEADLIGHT_...]" + NL
    + "; a lens told not to be coloured is not coloured" + NL
    + "SURFACE = glass_platelight" + NL
    + "GLASS_COLOR = 0.25,0.25,0.25" + NL
    + "EXTRA_GLASS_COLORIZATION = 0" + NL
    + NL
    + "[REFRACTING_HEADLIGHT_...]" + NL
    + "SURFACE = glass_reverse" + NL
    + NL
    + "[LIGHT_LICENSEPLATE]" + NL
    + "GLASS_COLOR = 1, 0, 0" + NL
)


def test_what_colour_each_lamp_lens_is():
    """A car's glass is one grey picture however many lamps wear it.

    A Renault 5 has nine materials sharing one 32-pixel square of
    `rgba(52, 60, 61, 47)`, told apart only by the normal map moulding each
    pattern. What makes its fog lamps yellow and its indicators amber is stated
    beside the model, in the blocks Custom Shaders Patch reads to simulate a
    lamp — and read without them every lamp on the car is the same colourless
    glass, which is what the file holds and not what anyone has seen it as.
    """
    found = kn5._lens_colours(_LAMPS)
    assert found == {
        "glass_fog": "#ffce20",
        "glass_turnfl": "#f74700",
        "glass_turnfl2": "#f74700",
    }, "one block may name several meshes, and a comment is not part of a colour"


@pytest.mark.parametrize("text,why", [
    ("", "nothing at all"),
    ("[REFRACTING_HEADLIGHT_...]" + NL + "SURFACE = a", "a block with no colour"),
    ("[REFRACTING_HEADLIGHT_...]" + NL + "GLASS_COLOR = 1,1,1", "a colour with no mesh"),
    ("[REFRACTING_HEADLIGHT_...]" + NL + "SURFACE = a" + NL + "GLASS_COLOR = 1,1",
     "a colour with only two channels"),
    ("[REFRACTING_HEADLIGHT_...]" + NL + "SURFACE = a" + NL + "GLASS_COLOR = red",
     "a colour that is not numbers"),
], ids=["empty", "no-colour", "no-mesh", "short", "words"])
def test_a_lamp_block_that_states_no_colour_states_nothing(text, why):
    assert kn5._lens_colours(text) == {}, why


def test_a_lamp_colour_goes_on_the_part_and_not_on_the_material(tmp_path):
    """`SURFACE` names a *mesh*, and the mesh and the material do not line up:
    a Renault 5's `glass_fog` mesh wears the material its `glass_platelight`
    mesh wears, and the two are given different colours. So there is nowhere
    for the colour to go but the record for that mesh.
    """
    path = tmp_path / "car.kn5"
    lens = fb.kn5_mesh("glass_fog", TRIANGLE, [0, 1, 2])
    plate = fb.kn5_mesh("glass_platelight", TRIANGLE, [0, 1, 2])
    path.write_bytes(fb.build_kn5(
        materials=[fb.kn5_material("platelight")],
        tree=fb.kn5_dummy("car", IDENTITY, lens + plate, 2)))
    (tmp_path / "extension").mkdir()
    (tmp_path / "extension" / "lights.ini").write_text(_LAMPS, encoding="utf-8")

    doc = read_fbx(str(path))
    assert doc.extra["lenses"] == 1, "the one mesh this car has that is named"
    assert "1 lamp(s) coloured" in render_text(analyze(doc))

    lit = {}
    for model in doc.root.path("Objects").get_all("Model"):
        props = {entry.props[0].value: [p.value for p in entry.props[4:]]
                 for entry in model.path("Properties70").children}
        if "LensColour" in props:
            lit[model.value(1).split(chr(0))[0]] = props["LensColour"]
    assert list(lit) == ["glass_fog"], "and not the mesh sharing its material"
    assert lit["glass_fog"] == pytest.approx([1.0, 0.80723137, 0.12472421], abs=2e-3)


def test_a_car_with_no_lighting_beside_it_states_no_lenses(tmp_path):
    """Four of the 41 cars to hand state any, so most say nothing and nothing
    is invented for them."""
    path = tmp_path / "car.kn5"
    path.write_bytes(fb.build_kn5(
        materials=[fb.kn5_material("glass")],
        tree=fb.kn5_dummy("car", IDENTITY,
                          fb.kn5_mesh("glass_fog", TRIANGLE, [0, 1, 2]), 1)))
    doc = read_fbx(str(path))
    assert doc.extra["lenses"] == 0
    assert "lamp(s) coloured" not in render_text(analyze(doc))


# ---------------------------------------------------------------- the paint chip


def chip(rows, **kw) -> str:
    return kn5._chip_colour(fb.livery_png(rows, **kw))


def test_the_colour_of_a_paint_chip_is_the_commonest_one_in_it():
    """`livery.png` is the swatch Content Manager shows beside a skin's name —
    a rounded square of the paint with a gloss sweeping over it — and every one
    of the 189 skins to hand has one.

    Two things make a plain average the wrong reading. The gloss is a wide
    bright sweep, and under some of them is a band of dark reflection: a
    Renault 5's Blanc Perle chip is white over black, and averaged it is a
    mid-grey nobody painted. So the commonest colour is taken, over the upper
    half where the paint is.
    """
    paint = (0x56, 0x5d, 0x6b)            # Champagne Quartz, as its JSON says
    flat = chip([[paint] * 8] * 8)
    assert flat == "#565d6b", "a flat chip is the one colour it is drawn in"

    gloss = [[paint] * 8 for _ in range(8)]
    for x in range(3):
        gloss[0][x] = (255, 255, 255)     # the highlight across a corner
    assert chip(gloss) == "#565d6b", "a highlight is not the paint"

    over = [[(255, 255, 255)] * 8 for _ in range(4)] + [[(10, 10, 10)] * 8 for _ in range(4)]
    assert chip(over) == "#ffffff", "the reflection under a chip is not the paint"

    assert chip([[paint] * 8] * 8, alpha=False) == "#565d6b", "written without an alpha"
    rounded = [[paint + (0,)] * 8 for _ in range(8)]
    rounded[0][0] = paint + (255,)
    assert chip(rounded) == "#565d6b", "a transparent corner is the rounding"


def test_a_chip_this_does_not_read_states_nothing():
    """Five of the 189 are a palette or interlaced, and are left unread rather
    than half-read."""
    assert kn5._chip_colour(b"not a picture at all") == ""
    assert kn5._chip_colour(b"") == ""


def test_a_skin_that_states_no_colour_is_read_from_its_chip(tmp_path):
    """Sixty-nine of the 189 state none: an Audi's Sakhir Orange says #FFFFFF
    and switches it off, and its Silver Pearl has no `carPaint` section to say
    anything in. Read from what they say, those cars come up white.

    A picture is weaker evidence than a setting — where both are there they
    disagree about a third of the time, usually because the setting is Content
    Manager's untouched white — so the chip is read last and only where there
    is nothing to disagree with.
    """
    path = tmp_path / "car.kn5"
    path.write_bytes(fb.build_kn5(
        materials=[fb.kn5_material("body", slots=(("txDiffuse", 0, "paint.dds"),))],
        textures=[("paint.dds", fb.dds_bc1())],
        tree=fb.kn5_dummy("car", IDENTITY)))
    skins = tmp_path / "skins"
    for name in ("Sakhir", "Nighthawk", "Livery"):
        (skins / name).mkdir(parents=True)
        (skins / name / "badge.dds").write_bytes(b"")
        (skins / name / "ext_config.ini").write_text(
            "CarPaintMaterial = body" + NL, encoding="utf-8")
        (skins / name / "livery.png").write_bytes(
            fb.livery_png([[(0x94, 0x1a, 0x0a)] * 8] * 8))
    # One of them switches its colour off, which is the same as stating none.
    (skins / "Sakhir" / "cm_skin.json").write_text(
        '{"carPaint": {"color": "#FFFFFFFF", "enabled": false}}', encoding="utf-8")
    # And the other states one, which the picture does not get to argue with.
    (skins / "Nighthawk" / "cm_skin.json").write_text(
        '{"carPaint": {"color": "#FF0C0C0C"}}', encoding="utf-8")
    # And the third brings the paint's own picture, which is the whole of what
    # the chip is for and settles that it is not wanted.
    (skins / "Livery" / "paint.dds").write_bytes(b"")

    painted = {skin["name"]: skin["paints"] for skin in read_fbx(str(path)).extra["skins"]}
    assert painted["Sakhir"] == [{"material": "body", "colour": "#941a0a"}]
    assert painted["Nighthawk"] == [{"material": "body", "colour": "#0c0c0c"}]
    assert painted["Livery"] == [], "its livery is its picture, not a colour"


def test_a_skin_that_brings_the_paint_its_picture_is_not_painted_over(tmp_path):
    """Which is the rule `cm_skin.json` states in words when it switches a
    colour off: a slot whose colour is in its texture is not painted.

    A Lancia Beta Montecarlo has seven skins, none of them stating a colour
    anywhere, and each replaces the `LANCIA_body.dds` that its
    `lancia_body_paint` wears. Read the other way round every one of its
    liveries comes out under a flat wash of that livery's own average — the
    material overtaking the skin it was meant to be showing.
    """
    path = tmp_path / "car.kn5"
    path.write_bytes(fb.build_kn5(
        materials=[fb.kn5_material("body", slots=(("txDiffuse", 0, "body.dds"),)),
                   fb.kn5_material("trim", slots=(("txDiffuse", 0, "trim.dds"),))],
        textures=[("body.dds", fb.dds_bc1()), ("trim.dds", fb.dds_bc1())],
        tree=fb.kn5_dummy("car", IDENTITY)))
    (tmp_path / "extension").mkdir()
    (tmp_path / "extension" / "ext_config.ini").write_text(
        "CarPaintMaterial=body" + NL, encoding="utf-8")
    skins = tmp_path / "skins"
    for name, brings in (("Livery", "body.dds"), ("Badge", "trim.dds")):
        (skins / name).mkdir(parents=True)
        (skins / name / brings).write_bytes(b"")
        (skins / name / "livery.png").write_bytes(
            fb.livery_png([[(0xed, 0x11, 0x14)] * 8] * 8))

    painted = {skin["name"]: skin["paints"] for skin in read_fbx(str(path)).extra["skins"]}
    assert painted["Livery"] == [], "the colour is already in the picture it brought"
    # And a skin replacing some other picture has painted nothing, so its chip
    # is still the only thing saying what colour it is.
    assert painted["Badge"] == [{"material": "body", "colour": "#ed1114"}]


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


def test_an_empty_texture_slot_is_counted_and_stepped_over(tmp_path):
    """A slot of kind nought is the whole of its record: no name, no length,
    no bytes.

    Three of the 125 cars to hand open with one — a 53 MB Forester, a 313 MB
    Citroën and a 388 MB Renault.  Read as though it were a texture it takes
    the next entry's kind for a name length and walks off the table four bytes
    in, and all three were refused as damaged at byte 27: a whole car turned
    away over an empty slot.
    """
    red = fb.dds_bc1()
    body = fb.kn5_material("body", "ksPerPixel",
                           properties=fb.kn5_property("fresnelC", 0.0),
                           property_count=1, slots=(("txDiffuse", 0, "red.dds"),))
    verts, indices = fb.kn5_cube(1.0)
    tree = fb.kn5_dummy("scene", IDENTITY, fb.kn5_mesh("body", verts, indices), 1)
    path = tmp_path / "car.kn5"
    path.write_bytes(fb.build_kn5(6, textures=[("red.dds", red)], materials=[body],
                                  tree=tree, empty_slots=1))
    # And the same file without the slot, which must read identically.
    plain = tmp_path / "plain.kn5"
    plain.write_bytes(fb.build_kn5(6, textures=[("red.dds", red)], materials=[body],
                                   tree=tree))

    doc = read_fbx(str(path))
    assert doc.warnings == []
    # Counted in the table's own total, and not handed on as a texture.
    assert doc.extra["textures"] == 1
    assert doc.extra["materials"] == 1
    assert doc.extra["meshes"] == 1
    # And the file is read to its last byte, which is what says the table was
    # walked correctly rather than merely survived.
    assert doc.extra["missing_textures"] == []
    same = read_fbx(str(plain))
    for key in ("textures", "materials", "meshes", "vertices", "triangles"):
        assert doc.extra[key] == same.extra[key], key
