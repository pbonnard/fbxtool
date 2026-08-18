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


# --------------------------------------------------------------------------
# what a car keeps beside its model


def dressed_doc(**kwargs):
    """The two-material scene, dressed from a BeamNG-style sidecar."""
    import fbxbuild as fb

    return parse_dae(fb.build_dae().decode("utf-8"), materials=fb.DAE_MATERIALS,
                     **kwargs)


def properties(node):
    p70 = node.get("Properties70")
    if p70 is None:
        return {}
    return {str(p.props[0].value): [v.value for v in p.props[4:]]
            for p in p70.get_all("P")}


def material_named(doc, name):
    for entry in doc.root.path("Objects").get_all("Material"):
        if str(entry.props[1].value).split("\x00")[0] == name:
            return entry
    return None


def test_a_material_is_dressed_by_the_file_beside_the_model():
    """A BeamNG `.dae` carries a lambert stub and, on the car to hand, one
    `<image>` for its eighty-odd pictures.  What a surface actually is lives in
    a `*.materials.json` in the same folder, under the name the model gave it.

    The numbers go on under a vendor prefix, because that is how the rest of
    this tool tells an artist's own value from an exporter's approximation of
    it: a bare `Opacity` is FBX's own property and read on its own terms.
    """
    doc = dressed_doc()
    props = properties(material_named(doc, "red"))
    assert props["BeamNG|main|roughness"] == [0.25]
    assert props["BeamNG|main|metalness"] == [0.75]
    assert props["BeamNG|main|base_color"] == [0.5, 0.25, 0.125]
    # A clear coat is what makes paint read as paint, and the shader already
    # draws one — given a colour saying how much comes back and an index.
    assert props["CoatColor"] == [1.0, 1.0, 1.0]
    assert props["CoatIor"] == [1.5]
    assert doc.extra["dressed"] == 2, "the lamp states nothing and is not counted"
    # Three entries, keyed under every name they answer to: the red one is
    # called `red material` and mapped to `red`, so it claims two.
    assert doc.extra["stated_materials"] == 4


def test_the_name_the_model_uses_is_the_one_looked_up():
    """`mapTo` is what the model says and `name` is the material's own.  They
    are the same in 2,796 of the 2,861 entries the game ships, and where they
    differ it is `mapTo` the model wrote.
    """
    doc = dressed_doc()
    # The fixture's red is called `red material` and mapped to `red`.
    assert material_named(doc, "red") is not None
    assert properties(material_named(doc, "red"))


def test_the_pictures_a_material_wears_become_texture_records():
    """Named, not read: a texture record says which file a slot wants, and
    whoever supplies the folder supplies the picture.
    """
    doc = dressed_doc()
    bound = {}
    for entry in doc.root.path("Connections").get_all("C"):
        if str(entry.props[0].value) != "OP":
            continue
        bound[str(entry.props[3].value)] = entry.props[1].value
    assert set(bound) == {"DiffuseColor", "NormalMap", "AmbientOcclusion"}
    names = [str(t.props[1].value).split("\x00")[0]
             for t in doc.root.path("Objects").get_all("Texture")]
    assert "red_DiffuseColor" in names
    assert "blue_DiffuseColor" in names, "the older generation's colorMap is a diffuse too"


def test_a_material_stating_nothing_is_left_alone():
    """Twelve of a Bolide's thirty-nine are lights, and their entries carry
    four empty stages: the game lights them rather than painting them.  A
    material that states nothing is not dressed in nothing.
    """
    import fbxbuild as fb

    # The fixture's `lamp` is one of those, so the model is made to wear it.
    text = fb.build_dae().decode("utf-8").replace('name="blue"', 'name="lamp"')
    doc = parse_dae(text, materials=fb.DAE_MATERIALS)
    props = properties(material_named(doc, "lamp"))
    assert not [key for key in props if key.startswith(("BeamNG|", "Coat"))]
    # What the model itself said about it still stands: the sidecar adding
    # nothing is not the same as it saying the surface is nothing.
    assert props["DiffuseColor"] == [0.0, 0.25, 1.0]
    assert doc.extra["dressed"] == 1, "only the red one states anything"


def test_a_duplicate_name_is_dressed_by_the_one_it_was_copied_from():
    """Blender numbers a duplicate and the model keeps the number while the
    material file does not: `bolide_main_001` is dressed by `bolide_main`.
    """
    import fbxbuild as fb

    text = fb.build_dae().decode("utf-8").replace('name="red"', 'name="red_001"')
    doc = parse_dae(text, materials=fb.DAE_MATERIALS)
    assert properties(material_named(doc, "red_001"))["BeamNG|main|roughness"] == [0.25]


def test_a_model_with_nothing_beside_it_still_reads():
    """Which is the ordinary case for a `.dae` that is not a BeamNG car."""
    import fbxbuild as fb

    doc = parse_dae(fb.build_dae().decode("utf-8"))
    assert doc.extra["dressed"] == 0
    assert doc.root.path("Objects").get("Texture") is None
    assert doc.extra["parts"] == 1
