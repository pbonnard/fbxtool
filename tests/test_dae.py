"""Tests for the COLLADA ``.dae`` reader.

COLLADA is XML, so the fixtures are written out here rather than built: what
matters about them is the shape of the document, and a reader is easier to hold
to a file you can read than to one a helper assembled.

The scenes are small on purpose and awkward where the format is: a quad beside
a triangle, two primitives wearing different materials in one mesh, a node
placing its mesh with a matrix, and the one-hop ``<vertices>`` indirection that
sits between a primitive and the numbers it counts against.
"""

from __future__ import annotations

import math

import pytest

from fbxtool import analyze, parse_dae
from fbxtool.model import ParseError
from fbxtool.reader import detect_format

NS = "http://www.collada.org/2005/11/COLLADASchema"


def document(body: str, *, up: str = "Z_UP", meter: str = "1") -> str:
    """A COLLADA document with *body* between its libraries."""
    return (
        '<?xml version="1.0" encoding="utf-8"?>\n'
        f'<COLLADA xmlns="{NS}" version="1.4.1">'
        "<asset><contributor><authoring_tool>Blender 4.0.2</authoring_tool>"
        "</contributor>"
        f'<unit name="meter" meter="{meter}"/><up_axis>{up}</up_axis></asset>'
        f"{body}</COLLADA>"
    )


#: One square of four corners, as a source, a `<vertices>` and a `<polylist>`.
SQUARE = """
<library_geometries><geometry id="g" name="square"><mesh>
  <source id="g-pos"><float_array id="g-pos-a" count="12">
    0 0 0  1 0 0  1 1 0  0 1 0</float_array>
    <technique_common><accessor source="#g-pos-a" count="4" stride="3">
      <param name="X" type="float"/><param name="Y" type="float"/>
      <param name="Z" type="float"/></accessor></technique_common></source>
  <source id="g-nrm"><float_array id="g-nrm-a" count="3">0 0 1</float_array>
    <technique_common><accessor source="#g-nrm-a" count="1" stride="3">
      <param name="X" type="float"/><param name="Y" type="float"/>
      <param name="Z" type="float"/></accessor></technique_common></source>
  <source id="g-uv"><float_array id="g-uv-a" count="8">
    0 0  1 0  1 1  0 1</float_array>
    <technique_common><accessor source="#g-uv-a" count="4" stride="2">
      <param name="S" type="float"/><param name="T" type="float"/>
      </accessor></technique_common></source>
  <vertices id="g-vtx"><input semantic="POSITION" source="#g-pos"/></vertices>
  <polylist material="red" count="1">
    <input semantic="VERTEX" source="#g-vtx" offset="0"/>
    <input semantic="NORMAL" source="#g-nrm" offset="1"/>
    <input semantic="TEXCOORD" source="#g-uv" offset="2" set="0"/>
    <vcount>4</vcount>
    <p>0 0 0  1 0 1  2 0 2  3 0 3</p>
  </polylist>
</mesh></geometry></library_geometries>
"""


def scene(matrix: str = "1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1") -> str:
    return (
        '<library_visual_scenes><visual_scene id="s"><node id="n" name="part">'
        f'<matrix sid="transform">{matrix}</matrix>'
        '<instance_geometry url="#g"><bind_material><technique_common>'
        '<instance_material symbol="red" target="#red-material"/>'
        "</technique_common></bind_material></instance_geometry>"
        "</node></visual_scene></library_visual_scenes>"
    )


MATERIALS = (
    '<library_effects><effect id="red-effect"><profile_COMMON><technique sid="c">'
    '<lambert><diffuse><color sid="diffuse">1 0 0 1</color></diffuse></lambert>'
    "</technique></profile_COMMON></effect></library_effects>"
    '<library_materials><material id="red-material" name="red">'
    '<instance_effect url="#red-effect"/></material></library_materials>'
)


def geometry_of(doc):
    return doc.root.path("Objects", "Geometry")


def values(node, name):
    return node.path(name).props[0].value


def test_a_collada_document_is_recognised_from_its_head():
    """The root element names the format and the schema, and both are wanted.

    An XML file that is not COLLADA is not answered as one, and neither is a
    file that merely mentions the word.
    """
    text = document(SQUARE + scene() + MATERIALS)
    assert detect_format(text.encode("utf-8")) == "dae"
    assert detect_format(b"<?xml version='1.0'?><svg xmlns='http://www.w3.org/2000/svg'/>") \
        == "unknown"
    assert detect_format(b"# COLLADA is a format\nv 0 0 0\nf 1 1 1\n") == "obj"


def test_a_polygon_ends_with_its_last_corner_complemented():
    """Which is how an FBX run says where one polygon stops and the next
    starts.  COLLADA says the same thing with a separate `vcount` list, so the
    two are exactly equivalent and the run is what the rest of this tool reads.
    """
    doc = parse_dae(document(SQUARE + scene() + MATERIALS), load_arrays=True)
    geometry = geometry_of(doc)
    assert values(geometry, "Vertices") == [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]
    assert values(geometry, "PolygonVertexIndex") == [0, 1, 2, ~3]


def test_normals_and_texture_coordinates_are_indexed_per_corner():
    """A COLLADA primitive gives every corner an index into each source, at the
    offset that input states, which is the IndexToDirect layout the rest of the
    pipeline already understands.
    """
    doc = parse_dae(document(SQUARE + scene() + MATERIALS), load_arrays=True)
    geometry = geometry_of(doc)
    normal = geometry.get("LayerElementNormal")
    assert normal.path_value("MappingInformationType") == "ByPolygonVertex"
    assert normal.path_value("ReferenceInformationType") == "IndexToDirect"
    assert values(normal, "Normals") == [0, 0, 1]
    assert values(normal, "NormalsIndex") == [0, 0, 0, 0], "one normal, four corners"
    uv = geometry.get("LayerElementUV")
    assert values(uv, "UV") == [0, 0, 1, 0, 1, 1, 0, 1]
    assert values(uv, "UVIndex") == [0, 1, 2, 3]


def test_texture_coordinates_are_not_turned_over():
    """COLLADA measures V upwards from the bottom of the image, as FBX and OBJ
    do and unlike glTF.  Flipped on the way in, every badge and number plate on
    a car comes out upside down.
    """
    doc = parse_dae(document(SQUARE + scene() + MATERIALS), load_arrays=True)
    uv = geometry_of(doc).get("LayerElementUV")
    # The fourth corner is stated at the top of the image and stays there.
    assert values(uv, "UV")[7] == 1


def test_a_mesh_of_several_primitives_keeps_a_material_for_each():
    """One COLLADA mesh may hold a `polylist` per material, and each polygon
    has to come back wearing the one its own run named.  A car body shipped
    with its glass merged in is exactly this.
    """
    body = SQUARE.replace(
        "</mesh>",
        """<triangles material="blue" count="1">
             <input semantic="VERTEX" source="#g-vtx" offset="0"/>
             <p>0 1 2</p>
           </triangles></mesh>""")
    materials = MATERIALS.replace(
        "</library_materials>",
        '<material id="blue-material" name="blue">'
        '<instance_effect url="#red-effect"/></material></library_materials>')
    binding = scene().replace(
        "</technique_common>",
        '<instance_material symbol="blue" target="#blue-material"/></technique_common>')
    doc = parse_dae(document(body + binding + materials), load_arrays=True)
    geometry = geometry_of(doc)
    # The quad, then the triangle: four corners and three.
    assert values(geometry, "PolygonVertexIndex") == [0, 1, 2, ~3, 0, 1, ~2]
    slots = geometry.get("LayerElementMaterial")
    assert slots.path_value("MappingInformationType") == "ByPolygon"
    assert values(slots, "Materials") == [0, 1], "one polygon each, in palette order"


def test_a_triangles_run_needs_no_vcount():
    """`<triangles>` states none because every polygon of it is three corners.
    The two records are otherwise the same and are read as one.
    """
    body = SQUARE.replace(
        """<polylist material="red" count="1">
    <input semantic="VERTEX" source="#g-vtx" offset="0"/>
    <input semantic="NORMAL" source="#g-nrm" offset="1"/>
    <input semantic="TEXCOORD" source="#g-uv" offset="2" set="0"/>
    <vcount>4</vcount>
    <p>0 0 0  1 0 1  2 0 2  3 0 3</p>
  </polylist>""",
        """<triangles material="red" count="2">
    <input semantic="VERTEX" source="#g-vtx" offset="0"/>
    <p>0 1 2  0 2 3</p>
  </triangles>""")
    doc = parse_dae(document(body + scene() + MATERIALS), load_arrays=True)
    assert values(geometry_of(doc), "PolygonVertexIndex") == [0, 1, ~2, 0, 2, ~3]


def test_a_node_places_its_mesh_by_a_matrix():
    """A COLLADA matrix is sixteen numbers in row-major order acting on column
    vectors, so the translation is the last *column*.  Read as the last row —
    which is where a Direct3D matrix keeps it — every part of a car lands at
    the origin instead.
    """
    doc = parse_dae(document(SQUARE + scene(
        "2 0 0 7  0 2 0 8  0 0 2 9  0 0 0 1") + MATERIALS))
    model = doc.root.path("Objects", "Model")
    props = {str(p.props[0].value): [float(v.value) for v in p.props[4:]]
             for p in model.path("Properties70").get_all("P")}
    assert props["Lcl Translation"] == [7, 8, 9]
    assert props["Lcl Scaling"] == [2, 2, 2]


def test_a_quarter_turn_comes_back_as_ninety_degrees():
    """The rotation is decomposed to the Euler angles an FBX states."""
    # A turn about Z: x goes to y, y goes to -x.
    doc = parse_dae(document(SQUARE + scene(
        "0 -1 0 0  1 0 0 0  0 0 1 0  0 0 0 1") + MATERIALS))
    model = doc.root.path("Objects", "Model")
    props = {str(p.props[0].value): [float(v.value) for v in p.props[4:]]
             for p in model.path("Properties70").get_all("P")}
    assert props["Lcl Rotation"] == pytest.approx([0, 0, 90], abs=1e-6)


def test_the_scene_states_which_way_is_up_and_how_big_a_unit_is():
    """BeamNG's cars are Z up in metres; this tool counts centimetres, as an
    FBX does, so the two have to be stated in its own terms.
    """
    doc = parse_dae(document(SQUARE + scene() + MATERIALS))
    settings = analyze(doc).global_settings
    assert settings["up_axis"] == "+Z"
    assert settings["unit_scale"] == 100.0
    doc = parse_dae(document(SQUARE + scene() + MATERIALS, up="Y_UP", meter="0.01"))
    settings = analyze(doc).global_settings
    assert settings["up_axis"] == "+Y"
    assert settings["unit_scale"] == 1.0


def test_the_tool_that_wrote_the_file_is_read():
    """`<authoring_tool>` sits inside `<contributor>` and carries no children of
    its own, which makes it *falsy* as an ElementTree element.  Reached with an
    `or`, the name of the tool is thrown away in favour of the nothing it was
    being preferred over, and every COLLADA file reports itself as written by
    no one.
    """
    doc = parse_dae(document(SQUARE + scene() + MATERIALS))
    assert analyze(doc).header["creator"] == "Blender 4.0.2"


def test_a_material_states_the_colour_its_effect_gives_it():
    doc = parse_dae(document(SQUARE + scene() + MATERIALS))
    material = doc.root.path("Objects", "Material")
    assert str(material.props[1].value).split("\x00")[0] == "red"
    props = {str(p.props[0].value): [float(v.value) for v in p.props[4:]]
             for p in material.path("Properties70").get_all("P")}
    assert props["DiffuseColor"] == [1, 0, 0]


def test_a_document_that_is_not_well_formed_is_refused():
    with pytest.raises(ParseError):
        parse_dae("<COLLADA><mesh></COLLADA>")
    with pytest.raises(ParseError):
        parse_dae("<notcollada/>")


def test_a_geometry_nothing_instances_is_not_drawn():
    """The scene says what is drawn.  A geometry the visual scene never
    mentions is in the file but not in the model, and is left there.
    """
    doc = parse_dae(document(SQUARE + MATERIALS))
    assert doc.root.path("Objects").get("Geometry") is None
    assert doc.extra["parts"] == 0
