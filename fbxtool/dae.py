"""Reader for COLLADA ``.dae`` — the format BeamNG.drive ships its cars in.

COLLADA is XML, and it carries the same things an FBX scene does: vertices,
polygons, normals, texture coordinates, materials and a node tree placing them.
Rather than grow a second analysis and rendering path, a file is normalised
into the record tree the FBX readers produce, so the existing report, scene
analysis and viewer all apply unchanged.

The mapping is:

===============================  ====================================
COLLADA                          record
===============================  ====================================
``float_array`` under POSITION   ``Vertices``
``vcount`` + ``p``               ``PolygonVertexIndex``
NORMAL source + its offset       ``LayerElementNormal`` (IndexToDirect)
TEXCOORD source + its offset     ``LayerElementUV`` (IndexToDirect)
``polylist``/``triangles``       ``LayerElementMaterial`` (ByPolygon)
``node`` + ``matrix``            ``Model`` with Lcl Translation/Rotation/Scaling
``material`` + ``effect``        ``Material`` with DiffuseColor
``up_axis`` and ``unit``         ``GlobalSettings``
===============================  ====================================

Two things about the geometry are worth stating outright, because both are
decisions rather than readings.

**A polygon's last corner is stored as its complement**, which is how FBX marks
where one polygon ends and the next begins; COLLADA says the same thing with a
separate ``vcount`` list, and the two are exactly equivalent.

**The texture coordinates are not turned over.** COLLADA measures V upwards
from the bottom of the image, as FBX and OBJ do and unlike glTF, so what the
file states is what goes in. A reader that flipped them would put every badge
and number plate on a car upside down, which is the same trap the ``.kn5``
reader falls the other side of.

What is not read: ``library_animations`` and ``library_controllers``, neither
of which is geometry — of 36 vehicle files surveyed, none carries an animation
and two carry a controller. Nor the ``.cdae`` beside a BeamNG car, which is the
game's own compiled cache of the same model and is shipped alongside the
readable one.
"""

from __future__ import annotations

from typing import Any

from .model import ArrayInfo, Document, Node, ParseError, Property

__all__ = ["is_dae", "parse_dae"]

#: What every COLLADA document opens with, whatever wrote it.
_SCHEMA = "collada.org/2005/11/COLLADASchema"


def is_dae(text: str) -> bool:
    """Heuristic check that *text* is a COLLADA document.

    The root element is the whole of it, and it sits within the first few
    hundred bytes of every file to hand — after an XML declaration and
    whatever comment the exporter felt like leaving.
    """
    head = text[:8192]
    return "<COLLADA" in head and _SCHEMA in head


def _tag(element) -> str:
    """An element's name with its namespace taken off."""
    name = element.tag
    return name.rsplit("}", 1)[-1] if "}" in name else name


def _find(element, name: str):
    """The first child of *element* called *name*, whatever its namespace."""
    for child in element:
        if _tag(child) == name:
            return child
    return None


def _findall(element, name: str) -> list:
    return [child for child in element if _tag(child) == name]


def _numbers(text: str | None) -> list[float]:
    """The whitespace-separated numbers in an array's body, or nothing."""
    if not text:
        return []
    return [float(token) for token in text.split()]


def _indices(text: str | None) -> list[int]:
    if not text:
        return []
    return [int(token) for token in text.split()]


class _Source:
    """One ``<source>``: its numbers and how many make up an entry."""

    __slots__ = ("values", "stride")

    def __init__(self, values: list[float], stride: int) -> None:
        self.values = values
        self.stride = stride


def _read_sources(mesh) -> dict[str, _Source]:
    """Every ``<source>`` of a mesh, by id.

    The stride comes from the ``<accessor>`` rather than being assumed: a
    position source counts three to a vertex and a texture coordinate two, and
    a file is free to write a third that nothing reads.
    """
    out: dict[str, _Source] = {}
    for source in _findall(mesh, "source"):
        ident = source.get("id")
        if not ident:
            continue
        array = _find(source, "float_array")
        values = _numbers(array.text if array is not None else None)
        stride = 1
        technique = _find(source, "technique_common")
        accessor = _find(technique, "accessor") if technique is not None else None
        if accessor is not None:
            try:
                stride = max(1, int(accessor.get("stride") or 1))
            except ValueError:
                stride = 1
        out[ident] = _Source(values, stride)
    return out


def _vertex_sources(mesh) -> dict[str, str]:
    """Which source each ``<vertices>`` element stands for.

    A primitive names a `<vertices>` id rather than a source, and that element
    holds the POSITION input pointing at the source proper.  It is one hop and
    it is always there, so it is followed rather than guessed past.
    """
    out: dict[str, str] = {}
    for vertices in _findall(mesh, "vertices"):
        ident = vertices.get("id")
        if not ident:
            continue
        for entry in _findall(vertices, "input"):
            if entry.get("semantic") == "POSITION":
                out[ident] = (entry.get("source") or "").lstrip("#")
    return out


class _Primitive:
    """One ``<polylist>`` or ``<triangles>``: its corners and what wears them."""

    __slots__ = ("material", "vcount", "p", "inputs", "stride")

    def __init__(self) -> None:
        self.material = ""
        self.vcount: list[int] = []
        self.p: list[int] = []
        self.inputs: dict[str, tuple[int, str]] = {}
        self.stride = 1


def _read_primitives(mesh) -> list[_Primitive]:
    """The drawable runs of a mesh, in the order the file writes them.

    ``<triangles>`` states no ``vcount`` because every polygon of it is three
    corners; the two are otherwise the same record and are read as one.
    """
    out: list[_Primitive] = []
    for element in mesh:
        kind = _tag(element)
        if kind not in ("polylist", "triangles"):
            continue
        primitive = _Primitive()
        primitive.material = element.get("material") or ""
        indices = _find(element, "p")
        primitive.p = _indices(indices.text if indices is not None else None)
        highest = 0
        for entry in _findall(element, "input"):
            semantic = entry.get("semantic") or ""
            try:
                offset = int(entry.get("offset") or 0)
            except ValueError:
                offset = 0
            highest = max(highest, offset)
            # A file may state several UV sets; the first is the one drawn.
            if semantic in primitive.inputs:
                continue
            primitive.inputs[semantic] = (offset, (entry.get("source") or "").lstrip("#"))
        primitive.stride = highest + 1
        if kind == "triangles":
            corners = len(primitive.p) // primitive.stride if primitive.stride else 0
            primitive.vcount = [3] * (corners // 3)
        else:
            counts = _find(element, "vcount")
            primitive.vcount = _indices(counts.text if counts is not None else None)
        out.append(primitive)
    return out


class _Mesh:
    """One geometry's arrays, in the shape the record tree wants them."""

    def __init__(self) -> None:
        self.positions: list[float] = []
        self.polygons: list[int] = []
        self.normals: list[float] = []
        self.face_normals: list[int] = []
        self.uvs: list[float] = []
        self.face_uvs: list[int] = []
        self.face_materials: list[int] = []
        self.triangles = 0
        self.polygon_count = 0


def _build_mesh(geometry, palette_of) -> _Mesh | None:
    """One ``<geometry>`` turned into arrays, or None where it draws nothing.

    *palette_of* answers what palette slot a primitive's material symbol is,
    since the symbol is local to the geometry and the slot is the car's.
    """
    mesh_element = _find(geometry, "mesh")
    if mesh_element is None:
        return None
    sources = _read_sources(mesh_element)
    vertices = _vertex_sources(mesh_element)
    primitives = _read_primitives(mesh_element)
    if not primitives:
        return None

    mesh = _Mesh()
    # The position source is the one every primitive agrees on, and it is what
    # the polygon indices count against, so it is taken once for the geometry.
    position_id = ""
    for primitive in primitives:
        entry = primitive.inputs.get("VERTEX")
        if entry is None:
            continue
        position_id = vertices.get(entry[1], entry[1])
        if position_id:
            break
    positions = sources.get(position_id)
    if positions is None or not positions.values:
        return None
    mesh.positions = positions.values

    for primitive in primitives:
        vertex = primitive.inputs.get("VERTEX")
        if vertex is None or not primitive.vcount:
            continue
        normal = primitive.inputs.get("NORMAL")
        texcoord = primitive.inputs.get("TEXCOORD")
        normal_source = sources.get(normal[1]) if normal else None
        uv_source = sources.get(texcoord[1]) if texcoord else None
        # Each source's numbers are appended once, and the indices that follow
        # are moved along by however many entries stood in front of them.
        normal_base = len(mesh.normals) // 3
        uv_base = len(mesh.uvs) // 2
        if normal_source is not None:
            mesh.normals.extend(normal_source.values)
        if uv_source is not None:
            mesh.uvs.extend(uv_source.values)

        slot = palette_of(primitive.material)
        stride = primitive.stride
        at = 0
        for count in primitive.vcount:
            if count < 3 or (at + count) * stride > len(primitive.p):
                at += count
                continue
            for corner in range(count):
                base = (at + corner) * stride
                index = primitive.p[base + vertex[0]]
                # The last corner of a polygon is written as its complement,
                # which is how the run says where one ends and the next starts.
                mesh.polygons.append(~index if corner == count - 1 else index)
                if normal is not None and normal_source is not None:
                    mesh.face_normals.append(normal_base + primitive.p[base + normal[0]])
                elif mesh.normals:
                    mesh.face_normals.append(-1)
                if texcoord is not None and uv_source is not None:
                    mesh.face_uvs.append(uv_base + primitive.p[base + texcoord[0]])
                elif mesh.uvs:
                    mesh.face_uvs.append(-1)
            mesh.face_materials.append(slot)
            mesh.polygon_count += 1
            mesh.triangles += count - 2
            at += count
    return mesh if mesh.polygons else None


def _decompose(matrix: list[float]) -> tuple[list[float], list[float], list[float]]:
    """A COLLADA matrix as translation, Euler rotation in degrees, and scale.

    The matrix is sixteen numbers in row-major order acting on column vectors,
    so the translation is the last *column* — elements 3, 7 and 11 — and not
    the last row, which is where a Direct3D matrix keeps it.  Read the other
    way round every part of a car lands at the origin.
    """
    import math

    if len(matrix) != 16:
        return [0.0, 0.0, 0.0], [0.0, 0.0, 0.0], [1.0, 1.0, 1.0]
    translation = [matrix[3], matrix[7], matrix[11]]
    columns = [
        [matrix[0], matrix[4], matrix[8]],
        [matrix[1], matrix[5], matrix[9]],
        [matrix[2], matrix[6], matrix[10]],
    ]
    scale = [math.sqrt(sum(c * c for c in column)) or 1.0 for column in columns]
    basis = [[c / scale[i] for c in column] for i, column in enumerate(columns)]
    # A negative determinant is a mirror, and it is kept as a negative scale
    # rather than turned into a rotation that would come back inside out.
    determinant = (
        basis[0][0] * (basis[1][1] * basis[2][2] - basis[1][2] * basis[2][1])
        - basis[1][0] * (basis[0][1] * basis[2][2] - basis[0][2] * basis[2][1])
        + basis[2][0] * (basis[0][1] * basis[1][2] - basis[0][2] * basis[1][1])
    )
    if determinant < 0:
        scale[0] = -scale[0]
        basis[0] = [-c for c in basis[0]]
    m00, m10, m20 = basis[0]
    m01, m11, m21 = basis[1]
    m02, m12, m22 = basis[2]
    if abs(m20) < 1.0 - 1e-6:
        y = math.asin(-m20)
        x = math.atan2(m21, m22)
        z = math.atan2(m10, m00)
    else:                                    # looking straight up or down
        y = math.pi / 2 if m20 < 0 else -math.pi / 2
        x = math.atan2(-m12, m11)
        z = 0.0
    # Adding zero settles the sign of one: a turn of -0.0 degrees is a turn of
    # none, and the two readers here would otherwise write it differently for
    # no difference in the model.
    rotation = [math.degrees(v) + 0.0 for v in (x, y, z)]
    return ([v + 0.0 for v in translation], rotation, [v + 0.0 for v in scale])


def _colour_of(effect) -> tuple[float, float, float] | None:
    """A ``profile_COMMON`` effect's diffuse colour, where it states one flat.

    A diffuse that names a texture instead of a colour states no colour at all,
    and is left to say so rather than answered with the grey a missing value
    would come back as.
    """
    profile = _find(effect, "profile_COMMON")
    if profile is None:
        return None
    technique = _find(profile, "technique")
    if technique is None:
        return None
    for shading in ("lambert", "phong", "blinn", "constant"):
        model = _find(technique, shading)
        if model is None:
            continue
        diffuse = _find(model, "diffuse")
        if diffuse is None:
            continue
        colour = _find(diffuse, "color")
        if colour is None:
            return None
        values = _numbers(colour.text)
        if len(values) >= 3:
            return (values[0], values[1], values[2])
        return None
    return None


def _array(code: str, values: list, load: bool) -> Property:
    size = 8 if code in ("d", "l") else 4
    info = ArrayInfo(length=len(values), encoding=0, byte_length=len(values) * size)
    return Property(code, list(values) if load else None, info)


def _node(name: str, props: list[Property] | None = None,
          children: list[Node] | None = None) -> Node:
    return Node(name=name, props=props or [], children=children or [])


def _s(value: str) -> Property:
    return Property("S", value)


def _i(value: int) -> Property:
    return Property("I", int(value))


def _l(value: int) -> Property:
    return Property("L", int(value))


def _d(value: float) -> Property:
    return Property("D", float(value))


def _p70(name: str, kind: str, *values) -> Node:
    return _node("P", [_s(name), _s(kind), _s(""), _s("A"), *values])


def parse_dae(text: str, *, path: str | None = None,
              load_arrays: bool = False) -> Document:
    """Parse COLLADA *text* into a Document."""
    import xml.etree.ElementTree as ET

    try:
        root = ET.fromstring(text)
    except ET.ParseError as error:
        raise ParseError(f"the document is not well-formed XML: {error}") from None
    if _tag(root) != "COLLADA":
        raise ParseError("the document's root element is not COLLADA")

    doc = Document(root=Node(""), encoding="dae", path=path,
                   file_size=len(text.encode("utf-8", "replace")))
    doc.format = "dae"
    doc.version = None
    doc.version_source = None

    asset = _find(root, "asset")
    creator = ""
    up_axis = "Y"
    unit_scale = 1.0
    unit_name = ""
    if asset is not None:
        tool = _find(asset, "authoring_tool")
        contributor = _find(asset, "contributor")
        if contributor is not None:
            # `or` is the wrong word for an element: one with no children of
            # its own is falsy, and `<authoring_tool>` never has any, so the
            # tool that wrote the file would be thrown away for the None it
            # was being preferred over.
            inside = _find(contributor, "authoring_tool")
            if inside is not None:
                tool = inside
        if tool is not None and tool.text:
            creator = tool.text.strip()
        axis = _find(asset, "up_axis")
        if axis is not None and axis.text:
            up_axis = axis.text.strip().upper().replace("_UP", "") or "Y"
        unit = _find(asset, "unit")
        if unit is not None:
            unit_name = unit.get("name") or ""
            try:
                # Stated in metres a unit; the rest of this tool counts
                # centimetres, which is what an FBX states.
                unit_scale = float(unit.get("meter") or 1.0) * 100.0
            except ValueError:
                unit_scale = 100.0

    doc.root.children.append(_node("FBXHeaderExtension", [], [
        _node("Creator", [_s(creator or "COLLADA")]),
    ]))
    axis_index = {"X": 0, "Y": 1, "Z": 2}.get(up_axis, 1)
    front = 2 if axis_index != 2 else 1
    doc.root.children.append(_node("GlobalSettings", [], [
        _node("Version", [_i(1000)]),
        _node("Properties70", [], [
            _p70("UpAxis", "int", _i(axis_index)),
            _p70("UpAxisSign", "int", _i(1)),
            _p70("FrontAxis", "int", _i(front)),
            _p70("FrontAxisSign", "int", _i(1)),
            _p70("CoordAxis", "int", _i(0)),
            _p70("CoordAxisSign", "int", _i(1)),
            _p70("UnitScaleFactor", "double", _d(unit_scale)),
        ]),
    ]))

    # ---- materials, which a primitive names and an instance binds ----------
    effects = {}
    library = _find(root, "library_effects")
    if library is not None:
        for effect in _findall(library, "effect"):
            if effect.get("id"):
                effects[effect.get("id")] = effect
    palette: list[tuple[str, tuple[float, float, float] | None]] = []
    slot_of: dict[str, int] = {}
    library = _find(root, "library_materials")
    if library is not None:
        for material in _findall(library, "material"):
            ident = material.get("id") or ""
            name = material.get("name") or ident
            instance = _find(material, "instance_effect")
            url = (instance.get("url") or "").lstrip("#") if instance is not None else ""
            slot_of[ident] = len(palette)
            palette.append((name, _colour_of(effects[url]) if url in effects else None))

    geometries = {}
    library = _find(root, "library_geometries")
    if library is not None:
        for geometry in _findall(library, "geometry"):
            if geometry.get("id"):
                geometries[geometry.get("id")] = geometry

    # ---- the scene, which says what is drawn and where --------------------
    objects_node = _node("Objects", [], [])
    connections: list[Node] = []
    models: list[tuple[int, list[int]]] = []
    uid = 1000
    drawn = 0
    scenes = _find(root, "library_visual_scenes")
    nodes: list[tuple[Any, list[float]]] = []
    if scenes is not None:
        for scene in _findall(scenes, "visual_scene"):
            _walk(scene, [1.0, 0.0, 0.0, 0.0,
                          0.0, 1.0, 0.0, 0.0,
                          0.0, 0.0, 1.0, 0.0,
                          0.0, 0.0, 0.0, 1.0], nodes)

    for element, matrix in nodes:
        instance = _find(element, "instance_geometry")
        if instance is None:
            continue
        target = (instance.get("url") or "").lstrip("#")
        geometry = geometries.get(target)
        if geometry is None:
            continue
        # What each primitive's symbol stands for, which the instance binds.
        bound: dict[str, int] = {}
        bind = _find(instance, "bind_material")
        common = _find(bind, "technique_common") if bind is not None else None
        if common is not None:
            for entry in _findall(common, "instance_material"):
                symbol = entry.get("symbol") or ""
                to = (entry.get("target") or "").lstrip("#")
                if symbol and to in slot_of:
                    bound[symbol] = slot_of[to]
        # Which of the car's materials this part wears, in the order its own
        # primitives first ask for them, and the number each goes by *on this
        # part*: a per-polygon material index counts the materials connected to
        # the model that owns the geometry, so a part wearing three of the
        # thirty-nine numbers them nought, one and two.
        worn: list[int] = []
        local: dict[str, int] = {}

        def slot_for(symbol, worn=worn, local=local, bound=bound):
            if symbol not in local:
                local[symbol] = len(worn)
                worn.append(bound.get(symbol, 0))
            return local[symbol]

        mesh = _build_mesh(geometry, slot_for)
        if mesh is None:
            continue
        name = element.get("name") or element.get("id") or "part"
        geometry_uid, model_uid = uid, uid + 1
        uid += 2
        drawn += 1

        children = [
            _node("Vertices", [_array("d", mesh.positions, load_arrays)]),
            _node("PolygonVertexIndex", [_array("i", mesh.polygons, load_arrays)]),
            _node("GeometryVersion", [_i(124)]),
        ]
        if mesh.normals and any(i >= 0 for i in mesh.face_normals):
            children.append(_node("LayerElementNormal", [_i(0)], [
                _node("Version", [_i(101)]),
                _node("Name", [_s("")]),
                _node("MappingInformationType", [_s("ByPolygonVertex")]),
                _node("ReferenceInformationType", [_s("IndexToDirect")]),
                _node("Normals", [_array("d", mesh.normals, load_arrays)]),
                _node("NormalsIndex", [_array("i", mesh.face_normals, load_arrays)]),
            ]))
        if mesh.uvs and any(i >= 0 for i in mesh.face_uvs):
            children.append(_node("LayerElementUV", [_i(0)], [
                _node("Version", [_i(101)]),
                _node("Name", [_s("map1")]),
                _node("MappingInformationType", [_s("ByPolygonVertex")]),
                _node("ReferenceInformationType", [_s("IndexToDirect")]),
                _node("UV", [_array("d", mesh.uvs, load_arrays)]),
                _node("UVIndex", [_array("i", mesh.face_uvs, load_arrays)]),
            ]))
        children.append(_node("LayerElementMaterial", [_i(0)], [
            _node("Version", [_i(101)]),
            _node("MappingInformationType", [_s("ByPolygon")]),
            _node("ReferenceInformationType", [_s("IndexToDirect")]),
            _node("Materials", [_array("i", mesh.face_materials, load_arrays)]),
        ]))
        children.append(_node("Layer", [_i(0)], [_node("Version", [_i(100)])]))

        objects_node.children.append(_node(
            "Geometry", [_l(geometry_uid), _s(f"{name}\x00\x01Geometry"), _s("Mesh")],
            children))
        translation, rotation, scale = _decompose(matrix)
        props: list[Node] = []
        if any(translation):
            props.append(_p70("Lcl Translation", "Lcl Translation",
                              *(_d(v) for v in translation)))
        if any(rotation):
            props.append(_p70("Lcl Rotation", "Lcl Rotation",
                              *(_d(v) for v in rotation)))
        if scale != [1.0, 1.0, 1.0]:
            props.append(_p70("Lcl Scaling", "Lcl Scaling", *(_d(v) for v in scale)))
        model_children = [_node("Version", [_i(232)])]
        if props:
            model_children.append(_node("Properties70", [], props))
        objects_node.children.append(_node(
            "Model", [_l(model_uid), _s(f"{name}\x00\x01Model"), _s("Mesh")],
            model_children))
        connections.append(_node("C", [_s("OO"), _l(model_uid), _l(0)]))
        connections.append(_node("C", [_s("OO"), _l(geometry_uid), _l(model_uid)]))
        models.append((model_uid, worn))

    # A material is written once and connected to the parts that wear it.
    #
    # Connecting every material to every model is the simpler rule, and it is
    # what a file of one part wants.  But a car is 353 parts and 39 materials,
    # and all of them to all of them is 13,767 pairs — one texel apiece in the
    # palette the shader reads per fragment, which is wider than a card will
    # hold.  Over that width the whole palette comes back as zeroes and the car
    # draws black, geometry and normals perfectly correct underneath.
    #
    # So each part names only what its own primitives asked for, which for that
    # car is 1,124 pairs against 14,473, and its per-polygon material indices
    # count against that.
    for index, (name, colour) in enumerate(palette):
        material_uid = 100000 + index
        props = []
        if colour is not None:
            props.append(_p70("DiffuseColor", "Color", *(_d(c) for c in colour)))
        objects_node.children.append(
            _node("Material", [_l(material_uid), _s(f"{name}\x00\x01Material"), _s("")], [
                _node("Version", [_i(102)]),
                _node("ShadingModel", [_s("phong")]),
                _node("Properties70", [], props),
            ]))
    for model_uid, worn in models:
        for slot in worn:
            connections.append(_node("C", [_s("OO"), _l(100000 + slot), _l(model_uid)]))

    doc.root.children.append(_node("Definitions", [], [
        _node("Version", [_i(100)]),
        _node("Count", [_i(len(objects_node.children))]),
    ]))
    doc.root.children.append(objects_node)
    doc.root.children.append(_node("Connections", [], connections))

    doc.extra["collada_version"] = root.get("version") or ""
    doc.extra["parts"] = drawn
    doc.extra["materials"] = len(palette)
    doc.extra["up_axis"] = up_axis
    doc.extra["unit"] = unit_name
    return doc


def _walk(element, matrix: list[float], out: list, depth: int = 0) -> None:
    """Every node under *element*, with the matrix that places it.

    A node states its own placement and inherits its parent's, so the two are
    multiplied on the way down.  The files to hand are one level deep with an
    identity apiece — the exporter having baked the scene into world space —
    but nothing here relies on that.
    """
    if depth > 256:
        raise ParseError("the node tree is nested more than 256 deep")
    for child in element:
        if _tag(child) != "node":
            continue
        here = matrix
        for placement in child:
            if _tag(placement) != "matrix":
                continue
            values = _numbers(placement.text)
            if len(values) == 16:
                here = _multiply(here, values)
        out.append((child, here))
        _walk(child, here, out, depth + 1)


def _multiply(a: list[float], b: list[float]) -> list[float]:
    """Two row-major 4x4 matrices, in the order they are written."""
    out = [0.0] * 16
    for row in range(4):
        for column in range(4):
            out[row * 4 + column] = sum(
                a[row * 4 + k] * b[k * 4 + column] for k in range(4))
    return out
