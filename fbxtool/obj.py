"""Reader for Wavefront OBJ (and its companion MTL material library).

OBJ carries the same things an FBX scene does — vertices, polygons, normals,
texture coordinates, materials and texture references — in a much simpler text
form.  Rather than grow a second analysis and rendering path, the file is
normalised into the record tree the FBX readers produce, so the existing
report, scene analysis and viewer all apply unchanged.

The mapping is:

===========================  ====================================
OBJ                          record
===========================  ====================================
``v`` / ``vn`` / ``vt``      ``Vertices`` / ``Normals`` / ``UV``
``f``                        ``PolygonVertexIndex``
``usemtl``                   ``LayerElementMaterial``
``newmtl`` + ``Kd``          ``Material`` with ``DiffuseColor``
``map_Kd``                   ``Texture`` + ``Video``
``o`` / ``g``                reported as groups
===========================  ====================================

Face indices are 1-based and may be negative (relative to the end of the list
so far); both are resolved to 0-based here.  Polygons become an FBX-style
index run, in which the last index of each polygon is stored as its bitwise
complement.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Iterable

from .model import ArrayInfo, Document, Node, ParseError, Property

__all__ = ["is_obj", "parse_obj", "parse_mtl"]

#: Statements that make a file recognisably OBJ.
_KEYWORDS = ("v", "vn", "vt", "f", "o", "g", "usemtl", "mtllib", "s", "l", "p")
_LEADING = re.compile(r"^\s*(#|v |vn |vt |f |o |g |usemtl |mtllib |s |l |p )", re.MULTILINE)


def is_obj(text: str) -> bool:
    """Heuristic check that *text* is a Wavefront OBJ file."""
    head = text[:8192]
    hits = _LEADING.findall(head)
    if not hits:
        return False
    # A comment-only head is not enough; require real geometry statements.
    return any(h.strip() in ("v", "f", "vn", "vt") for h in hits)


@dataclass
class Material:
    """One entry of an MTL library."""

    name: str
    diffuse: tuple[float, float, float] = (0.8, 0.8, 0.8)
    ambient: tuple[float, float, float] | None = None
    specular: tuple[float, float, float] | None = None
    shininess: float | None = None
    opacity: float | None = None
    diffuse_map: str = ""
    illumination: int | None = None


def _floats(parts: Iterable[str], count: int, default: float = 0.0) -> list[float]:
    values = []
    for item in parts:
        try:
            values.append(float(item))
        except ValueError:
            break
    while len(values) < count:
        values.append(default)
    return values[:count]


def parse_mtl(text: str) -> tuple[list[Material], list[str]]:
    """Parse an MTL library. Returns the materials and any warnings."""
    materials: list[Material] = []
    warnings: list[str] = []
    current: Material | None = None

    for number, raw in enumerate(text.splitlines(), 1):
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        parts = line.split()
        key = parts[0].lower()
        rest = parts[1:]

        if key == "newmtl":
            current = Material(name=" ".join(rest) or f"material{len(materials) + 1}")
            materials.append(current)
            continue
        if current is None:
            warnings.append(f"MTL line {number}: {key!r} before any newmtl; ignored")
            continue

        if key == "kd":
            current.diffuse = tuple(_floats(rest, 3))
        elif key == "ka":
            current.ambient = tuple(_floats(rest, 3))
        elif key == "ks":
            current.specular = tuple(_floats(rest, 3))
        elif key == "ns":
            current.shininess = _floats(rest, 1)[0]
        elif key == "d":
            current.opacity = _floats(rest, 1)[0]
        elif key == "tr":
            current.opacity = 1.0 - _floats(rest, 1)[0]
        elif key == "illum":
            try:
                current.illumination = int(float(rest[0]))
            except (IndexError, ValueError):
                pass
        elif key in ("map_kd", "map_ka"):
            # Options such as "-s 1 1 1" may precede the filename.
            name = [p for p in rest if not p.startswith("-")]
            skip = 0
            cleaned = []
            for token in rest:
                if skip:
                    skip -= 1
                    continue
                if token.startswith("-"):
                    skip = 3 if token in ("-s", "-o", "-t") else 1
                    continue
                cleaned.append(token)
            chosen = " ".join(cleaned) or " ".join(name)
            if key == "map_kd" or not current.diffuse_map:
                current.diffuse_map = chosen
    return materials, warnings


@dataclass
class _Mesh:
    """Accumulated geometry, before it is turned into records."""

    positions: list[float] = field(default_factory=list)
    normals: list[float] = field(default_factory=list)
    uvs: list[float] = field(default_factory=list)
    polygons: list[int] = field(default_factory=list)      # FBX-style index run
    face_normals: list[int] = field(default_factory=list)  # per polygon vertex
    face_uvs: list[int] = field(default_factory=list)      # per polygon vertex
    face_materials: list[int] = field(default_factory=list)
    polygon_count: int = 0
    has_normals: bool = False
    has_uvs: bool = False


def _resolve(index: int, count: int) -> int:
    """OBJ indices are 1-based; negative ones count back from the end."""
    if index > 0:
        return index - 1
    if index < 0:
        return count + index
    return -1


def parse_obj(
    text: str,
    *,
    path: str | None = None,
    materials: str | dict[str, str] | None = None,
    load_arrays: bool = False,
) -> Document:
    """Parse OBJ *text* into a Document.

    *materials* supplies MTL content: either the text of a single library, or a
    mapping of filename to text when the file references several.
    """
    doc = Document(root=Node(""), encoding="obj", path=path,
                   file_size=len(text.encode("utf-8", "replace")))
    doc.format = "obj"
    doc.version_source = None

    mesh = _Mesh()
    groups: list[str] = []
    objects: list[str] = []
    libraries: list[str] = []
    material_names: list[str] = []
    material_index: dict[str, int] = {}
    current_material = -1
    comments: list[str] = []
    smoothing_groups = 0
    line_statements = 0

    for number, raw in enumerate(text.splitlines(), 1):
        stripped = raw.strip()
        if not stripped:
            continue
        if stripped.startswith("#"):
            if len(comments) < 8:
                comments.append(stripped.lstrip("#").strip())
            continue

        parts = stripped.split()
        key = parts[0].lower()
        rest = parts[1:]

        if key == "v":
            mesh.positions.extend(_floats(rest, 3))
        elif key == "vn":
            mesh.normals.extend(_floats(rest, 3))
            mesh.has_normals = True
        elif key == "vt":
            mesh.uvs.extend(_floats(rest, 2))
            mesh.has_uvs = True
        elif key == "f":
            corners = []
            for token in rest:
                bits = token.split("/")
                try:
                    vertex = int(bits[0])
                except (ValueError, IndexError):
                    continue
                uv = int(bits[1]) if len(bits) > 1 and bits[1] else 0
                normal = int(bits[2]) if len(bits) > 2 and bits[2] else 0
                corners.append((vertex, uv, normal))
            if len(corners) < 3:
                doc.warn(f"line {number}: face with fewer than three corners; skipped")
                continue

            vertex_total = len(mesh.positions) // 3
            uv_total = len(mesh.uvs) // 2
            normal_total = len(mesh.normals) // 3
            for position, (vertex, uv, normal) in enumerate(corners):
                index = _resolve(vertex, vertex_total)
                if index < 0 or index >= vertex_total:
                    doc.warn(f"line {number}: vertex index {vertex} is out of range")
                    index = 0
                last = position == len(corners) - 1
                mesh.polygons.append(~index if last else index)
                mesh.face_uvs.append(_resolve(uv, uv_total) if uv else -1)
                mesh.face_normals.append(_resolve(normal, normal_total) if normal else -1)
            mesh.face_materials.append(current_material if current_material >= 0 else 0)
            mesh.polygon_count += 1
        elif key == "usemtl":
            name = " ".join(rest)
            if name not in material_index:
                material_index[name] = len(material_names)
                material_names.append(name)
            current_material = material_index[name]
        elif key == "mtllib":
            libraries.extend(rest)
        elif key == "o":
            objects.append(" ".join(rest))
        elif key == "g":
            groups.append(" ".join(rest))
        elif key == "s":
            smoothing_groups += 1
        elif key in ("l", "p"):
            line_statements += 1

    if not mesh.positions:
        doc.warn("no vertices were found")

    library_texts = _collect_libraries(materials, libraries)
    defined, mtl_warnings = _materials_from(library_texts)
    for warning in mtl_warnings:
        doc.warn(warning)

    palette = _ordered_materials(material_names, defined, doc)
    _build_records(doc, mesh, palette, objects, groups, comments, libraries,
                   load_arrays=load_arrays)

    doc.extra.update({
        "objects": objects,
        "groups": groups,
        "libraries": libraries,
        "smoothing_groups": smoothing_groups,
        "line_or_point_statements": line_statements,
        "comments": comments,
        "materials_resolved": sum(1 for m in palette if m.resolved),
    })
    return doc


def _collect_libraries(materials, referenced: list[str]) -> list[str]:
    if materials is None:
        return []
    if isinstance(materials, str):
        return [materials]
    # A mapping: prefer the libraries the file actually names.
    texts = []
    lowered = {key.lower().replace("\\", "/").split("/")[-1]: value
               for key, value in materials.items()}
    for name in referenced:
        base = name.lower().replace("\\", "/").split("/")[-1]
        if base in lowered:
            texts.append(lowered.pop(base))
    texts.extend(lowered.values())
    return texts


def _materials_from(texts: list[str]) -> tuple[dict[str, Material], list[str]]:
    defined: dict[str, Material] = {}
    warnings: list[str] = []
    for text in texts:
        found, issues = parse_mtl(text)
        warnings.extend(issues)
        for material in found:
            defined.setdefault(material.name, material)
    return defined, warnings


@dataclass
class _PaletteEntry:
    material: Material
    resolved: bool


def _ordered_materials(used: list[str], defined: dict[str, Material],
                       doc: Document) -> list[_PaletteEntry]:
    """Materials in the order faces reference them, which is the index order."""
    palette: list[_PaletteEntry] = []
    if not used and defined:
        used = list(defined)
    if not used:
        used = ["default"]
    for name in used:
        material = defined.get(name)
        if material is None:
            palette.append(_PaletteEntry(Material(name=name), resolved=False))
        else:
            palette.append(_PaletteEntry(material, resolved=True))
    missing = [entry.material.name for entry in palette if not entry.resolved]
    if missing and defined:
        doc.warn("materials referenced but not defined in the supplied .mtl: "
                 + ", ".join(missing[:6]))
    return palette


# ---------------------------------------------------------------------------
# record construction


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


def _build_records(doc: Document, mesh: _Mesh, palette: list[_PaletteEntry],
                   objects: list[str], groups: list[str], comments: list[str],
                   libraries: list[str], *, load_arrays: bool) -> None:
    root = doc.root
    name = "mesh"
    if objects:
        name = objects[0]
    elif groups:
        name = groups[0]

    creator = next((c for c in comments if c), "") or "Wavefront OBJ"
    root.children.append(_node("FBXHeaderExtension", [], [
        _node("Creator", [_s(creator)]),
    ]))

    geometry_uid, model_uid = 1, 2
    material_base, texture_base, video_base = 100, 200, 300

    geometry_children = [
        _node("Vertices", [_array("d", mesh.positions, load_arrays)]),
        _node("PolygonVertexIndex", [_array("i", mesh.polygons, load_arrays)]),
        _node("GeometryVersion", [_i(124)]),
    ]

    # OBJ indexes normals and UVs per polygon vertex, which is exactly the
    # IndexToDirect layout the rest of the pipeline already understands.
    if mesh.has_normals and any(i >= 0 for i in mesh.face_normals):
        geometry_children.append(_node("LayerElementNormal", [_i(0)], [
            _node("Version", [_i(101)]),
            _node("Name", [_s("")]),
            _node("MappingInformationType", [_s("ByPolygonVertex")]),
            _node("ReferenceInformationType", [_s("IndexToDirect")]),
            _node("Normals", [_array("d", mesh.normals, load_arrays)]),
            _node("NormalsIndex", [_array("i", mesh.face_normals, load_arrays)]),
        ]))
    if mesh.has_uvs and any(i >= 0 for i in mesh.face_uvs):
        geometry_children.append(_node("LayerElementUV", [_i(0)], [
            _node("Version", [_i(101)]),
            _node("Name", [_s("map1")]),
            _node("MappingInformationType", [_s("ByPolygonVertex")]),
            _node("ReferenceInformationType", [_s("IndexToDirect")]),
            _node("UV", [_array("d", mesh.uvs, load_arrays)]),
            _node("UVIndex", [_array("i", mesh.face_uvs, load_arrays)]),
        ]))
    geometry_children.append(_node("LayerElementMaterial", [_i(0)], [
        _node("Version", [_i(101)]),
        _node("MappingInformationType", [_s("ByPolygon")]),
        _node("ReferenceInformationType", [_s("IndexToDirect")]),
        _node("Materials", [_array("i", mesh.face_materials, load_arrays)]),
    ]))
    geometry_children.append(_node("Layer", [_i(0)], [_node("Version", [_i(100)])]))

    objects_node = _node("Objects", [], [
        _node("Geometry", [_l(geometry_uid), _s(f"{name}\x00\x01Geometry"), _s("Mesh")],
              geometry_children),
        _node("Model", [_l(model_uid), _s(f"{name}\x00\x01Model"), _s("Mesh")], [
            _node("Version", [_i(232)]),
        ]),
    ])

    connections = [
        _node("C", [_s("OO"), _l(model_uid), _l(0)]),
        _node("C", [_s("OO"), _l(geometry_uid), _l(model_uid)]),
    ]

    for index, entry in enumerate(palette):
        material = entry.material
        uid = material_base + index
        props = [_p70("DiffuseColor", "Color", *(_d(c) for c in material.diffuse))]
        if material.specular:
            props.append(_p70("SpecularColor", "Color", *(_d(c) for c in material.specular)))
        if material.ambient:
            props.append(_p70("AmbientColor", "Color", *(_d(c) for c in material.ambient)))
        if material.shininess is not None:
            props.append(_p70("Shininess", "double", _d(material.shininess)))
        if material.opacity is not None:
            props.append(_p70("Opacity", "double", _d(material.opacity)))

        objects_node.children.append(
            _node("Material", [_l(uid), _s(f"{material.name}\x00\x01Material"), _s("")], [
                _node("Version", [_i(102)]),
                _node("ShadingModel", [_s("phong")]),
                _node("Properties70", [], props),
            ])
        )
        connections.append(_node("C", [_s("OO"), _l(uid), _l(model_uid)]))

        if material.diffuse_map:
            texture_uid = texture_base + index
            video_uid = video_base + index
            objects_node.children.append(
                _node("Texture",
                      [_l(texture_uid), _s(f"{material.name}_map\x00\x01Texture"), _s("")], [
                          _node("Type", [_s("TextureVideoClip")]),
                          _node("Version", [_i(202)]),
                          _node("FileName", [_s(material.diffuse_map)]),
                          _node("RelativeFilename", [_s(material.diffuse_map)]),
                      ])
            )
            objects_node.children.append(
                _node("Video",
                      [_l(video_uid), _s(f"{material.diffuse_map}\x00\x01Video"), _s("Clip")], [
                          _node("Type", [_s("Clip")]),
                          _node("FileName", [_s(material.diffuse_map)]),
                          _node("RelativeFilename", [_s(material.diffuse_map)]),
                      ])
            )
            connections.append(
                _node("C", [_s("OP"), _l(texture_uid), _l(uid), _s("DiffuseColor")]))
            connections.append(_node("C", [_s("OO"), _l(video_uid), _l(texture_uid)]))

    definitions = _node("Definitions", [], [
        _node("Version", [_i(100)]),
        _node("Count", [_i(len(objects_node.children))]),
        _node("ObjectType", [_s("Geometry")], [_node("Count", [_i(1)])]),
        _node("ObjectType", [_s("Model")], [_node("Count", [_i(1)])]),
        _node("ObjectType", [_s("Material")], [_node("Count", [_i(len(palette))])]),
    ])

    root.children.append(definitions)
    root.children.append(objects_node)
    root.children.append(_node("Connections", [], connections))
    if libraries:
        root.children.append(_node("MaterialLibraries", [],
                                   [_node("Library", [_s(item)]) for item in libraries]))
