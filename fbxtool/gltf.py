"""Reader for glTF 2.0 — the ``.gltf`` document and the ``.glb`` container.

glTF describes the same scene an FBX file does, but stores it the way a
graphics API wants it: vertex attributes in a flat buffer, addressed by
*accessors* that say where each stream starts, how wide its elements are and
how far apart they sit.  Nothing is duplicated per polygon, meshes are already
triangulated, and the units are metres with Y up.

As with the OBJ reader, the file is normalised into the record tree the FBX
readers produce, so the existing report and scene analysis apply unchanged:

=============================  ====================================
glTF                           record
=============================  ====================================
one primitive                  one ``Geometry`` and one ``Model``
``POSITION`` / ``NORMAL``      ``Vertices`` / ``LayerElementNormal``
``TEXCOORD_0``                 ``LayerElementUV`` (V flipped)
``indices``                    ``PolygonVertexIndex``
``pbrMetallicRoughness``       ``DiffuseColor``, ``SpecularColor``, ``Metallic``
``images``                     ``Texture`` + ``Video``
a node's matrix or its TRS     ``Lcl Translation`` / ``Rotation`` / ``Scaling``
=============================  ====================================

Accessors are decoded only when arrays are asked for; otherwise their lengths
are reported from the accessor headers alone, which is what makes ``--brief``
cheap on a large file.  The buffers themselves are always gathered, since a
document that names a ``.bin`` it has not got is worth reporting either way,
and an embedded image is carried as a raw property, as an embedded FBX texture
is.

A ``.gltf`` keeps its vertices in a separate file, named by a relative URI.
That file is read from beside the document, the way an ``.obj``'s ``.mtl`` is.
"""

from __future__ import annotations

import base64
import binascii
import json
import math
import os
import struct
import urllib.parse
from typing import Sequence

from .model import ArrayInfo, Document, Node, ParseError, Property

__all__ = ["MAGIC", "is_gltf", "parse_gltf", "read_container"]

MAGIC = b"glTF"
_JSON_CHUNK = 0x4E4F534A
_BIN_CHUNK = 0x004E4942

#: componentType -> (struct code, size in bytes)
_COMPONENT = {
    5120: ("b", 1), 5121: ("B", 1), 5122: ("h", 2),
    5123: ("H", 2), 5125: ("I", 4), 5126: ("f", 4),
}
_COMPONENT_NAMES = {
    5120: "int8", 5121: "uint8", 5122: "int16",
    5123: "uint16", 5125: "uint32", 5126: "float32",
}
_WIDTH = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT2": 4, "MAT3": 9, "MAT4": 16}


def is_gltf(data: bytes) -> bool:
    """True when *data* starts a glTF file, either container."""
    if data[:4] == MAGIC:
        return True
    head = data[:4096].lstrip(b"\xef\xbb\xbf \t\r\n")
    if not head.startswith(b"{"):
        return False
    # Only a document that says what it is, so a stray JSON file is not claimed.
    try:
        text = head.decode("utf-8", "replace")
    except UnicodeDecodeError:  # pragma: no cover - "replace" does not raise
        return False
    return '"asset"' in text and '"version"' in text


def read_container(data: bytes) -> tuple[dict, bytes | None, list[str]]:
    """Split a file into its JSON and its binary chunk.

    A ``.gltf`` has no binary chunk; a ``.glb`` carries one after the JSON.
    """
    warnings: list[str] = []
    if data[:4] != MAGIC:
        try:
            return json.loads(data.decode("utf-8-sig")), None, warnings
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ParseError(f"not a readable glTF document: {error}") from error

    if len(data) < 12:
        raise ParseError("truncated glTF container")
    version, total = struct.unpack_from("<II", data, 4)
    if version != 2:
        warnings.append(f"glTF container version {version}, not 2")
    if total != len(data):
        warnings.append(f"the header says {total} bytes, the file has {len(data)}")

    document: dict | None = None
    binary: bytes | None = None
    at = 12
    while at + 8 <= len(data):
        length, kind = struct.unpack_from("<II", data, at)
        start = at + 8
        end = min(start + length, len(data))
        if end - start < length:
            warnings.append("a chunk runs past the end of the file")
        if kind == _JSON_CHUNK:
            try:
                document = json.loads(data[start:end].decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as error:
                raise ParseError(f"the JSON chunk does not parse: {error}") from error
        elif kind == _BIN_CHUNK:
            binary = data[start:end]
        at = start + length + (-length % 4)
    if document is None:
        raise ParseError("this .glb has no JSON chunk")
    return document, binary, warnings


def _decode_uri(uri: str, path: str | None, doc: Document) -> bytes | None:
    """Bytes for a buffer or image URI: inline data, or a file beside *path*."""
    if uri.startswith("data:"):
        head, _, payload = uri.partition(",")
        if not _:
            return None
        if head.endswith(";base64"):
            try:
                return base64.b64decode(payload)
            except (binascii.Error, ValueError):
                doc.warn("a data: URI does not decode as base64")
                return None
        return urllib.parse.unquote_to_bytes(payload)
    if path is None:
        doc.warn(f"{uri} is beside the document, which was read without a path")
        return None
    beside = os.path.join(os.path.dirname(os.path.abspath(path)),
                          urllib.parse.unquote(uri).replace("\\", "/"))
    try:
        with open(beside, "rb") as handle:
            return handle.read()
    except OSError:
        doc.warn(f"{uri} was not found beside the document")
        return None


class _Accessors:
    """Reads accessor values, de-interleaving whatever byteStride asks for."""

    def __init__(self, json_doc: dict, buffers: Sequence[bytes | None], doc: Document):
        self.json = json_doc
        self.buffers = buffers
        self.doc = doc

    def count(self, index: int | None) -> int:
        """How many values an accessor holds, without reading any of them."""
        accessor = self._accessor(index)
        if accessor is None:
            return 0
        return int(accessor.get("count", 0)) * _WIDTH.get(accessor.get("type"), 0)

    def _accessor(self, index: int | None) -> dict | None:
        if index is None:
            return None
        table = self.json.get("accessors") or []
        if not 0 <= index < len(table):
            self.doc.warn(f"accessor {index} is named but not defined")
            return None
        return table[index]

    def read(self, index: int | None) -> list | None:
        accessor = self._accessor(index)
        if accessor is None:
            return None
        component = _COMPONENT.get(accessor.get("componentType"))
        width = _WIDTH.get(accessor.get("type"))
        if component is None or width is None:
            self.doc.warn(f"accessor {index} has a component type this reader does not know")
            return None
        # An accessor with neither a view nor a sparse override has nothing
        # behind it — which is how a compressed file describes what it took
        # away. Reading it as zeros would describe a mesh that is not there.
        if accessor.get("bufferView") is None and not accessor.get("sparse"):
            self.doc.warn(f"accessor {index} has no data behind it")
            return None
        code, size = component
        count = int(accessor.get("count", 0))
        values: list = [0] * (count * width)

        view = self._view(accessor.get("bufferView"))
        if view is not None:
            data, base, stride = view
            stride = stride or width * size
            layout = struct.Struct(f"<{width}{code}")
            at = base + int(accessor.get("byteOffset", 0))
            for i in range(count):
                if at + width * size > len(data):
                    self.doc.warn(f"accessor {index} runs past its buffer")
                    break
                values[i * width:(i + 1) * width] = layout.unpack_from(data, at)
                at += stride

        sparse = accessor.get("sparse")
        if sparse:
            self._apply_sparse(sparse, values, width, code, size)
        return values

    def _view(self, index: int | None) -> tuple[bytes, int, int] | None:
        """(buffer bytes, offset of the view, byteStride) for a bufferView."""
        if index is None:
            return None
        views = self.json.get("bufferViews") or []
        if not 0 <= index < len(views):
            self.doc.warn(f"bufferView {index} is named but not defined")
            return None
        view = views[index]
        data = self.buffers[view.get("buffer", 0)] if view.get("buffer", 0) < len(self.buffers) \
            else None
        if data is None:
            return None
        return data, int(view.get("byteOffset", 0)), int(view.get("byteStride", 0))

    def _apply_sparse(self, sparse: dict, values: list, width: int,
                      code: str, size: int) -> None:
        """A sparse accessor replaces some of what the bufferView held."""
        count = int(sparse.get("count", 0))
        indices = sparse.get("indices") or {}
        source = sparse.get("values") or {}
        index_component = _COMPONENT.get(indices.get("componentType"))
        index_view = self._view(indices.get("bufferView"))
        value_view = self._view(source.get("bufferView"))
        if index_component is None or index_view is None or value_view is None:
            self.doc.warn("a sparse accessor could not be applied")
            return
        index_code, index_size = index_component
        index_data, index_base, _ = index_view
        value_data, value_base, _ = value_view
        index_at = index_base + int(indices.get("byteOffset", 0))
        value_at = value_base + int(source.get("byteOffset", 0))
        layout = struct.Struct(f"<{width}{code}")
        for i in range(count):
            (where,) = struct.unpack_from(f"<{index_code}", index_data,
                                          index_at + i * index_size)
            if (where + 1) * width > len(values):
                continue
            values[where * width:(where + 1) * width] = \
                layout.unpack_from(value_data, value_at + i * width * size)


def _euler_from_matrix(m: Sequence[float]) -> tuple[float, float, float]:
    """Euler angles in degrees for R = Rz * Ry * Rx, FBX's XYZ order.

    *m* is a column-major 4x4, as glTF writes it; any scale is divided out
    first so a scaled node still reports the rotation it turns through.
    """
    columns = []
    for c in range(3):
        column = [m[c * 4], m[c * 4 + 1], m[c * 4 + 2]]
        length = math.sqrt(sum(v * v for v in column)) or 1.0
        columns.append([v / length for v in column])
    # r[row][col]
    r = [[columns[c][row] for c in range(3)] for row in range(3)]
    sy = -max(-1.0, min(1.0, r[2][0]))
    y = math.asin(sy)
    if abs(r[2][0]) < 0.99999:
        x = math.atan2(r[2][1], r[2][2])
        z = math.atan2(r[1][0], r[0][0])
    else:  # looking straight up or down: x and z are the same turn
        x = math.atan2(-r[1][2], r[1][1])
        z = 0.0
    return tuple(math.degrees(v) for v in (x, y, z))  # type: ignore[return-value]


def _placement(node: dict) -> tuple[list[float], list[float], list[float]]:
    """A node's translation, rotation in degrees, and scale."""
    if "matrix" in node:
        m = [float(v) for v in node["matrix"]]
        translation = [m[12], m[13], m[14]]
        scale = [math.sqrt(sum(m[c * 4 + k] ** 2 for k in range(3))) for c in range(3)]
        return translation, list(_euler_from_matrix(m)), scale

    translation = [float(v) for v in node.get("translation", (0.0, 0.0, 0.0))]
    scale = [float(v) for v in node.get("scale", (1.0, 1.0, 1.0))]
    rotation = [0.0, 0.0, 0.0]
    if "rotation" in node:
        x, y, z, w = (float(v) for v in node["rotation"])
        # The quaternion as a matrix, then the same angles as above.
        m = [
            1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 0,
            2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 0,
            2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y), 0,
            0, 0, 0, 1,
        ]
        rotation = list(_euler_from_matrix(m))
    return translation, rotation, scale


# --------------------------------------------------------------- record tree

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


def _p70(name: str, kind: str, *values: Property) -> Node:
    return _node("P", [_s(name), _s(kind), _s(""), _s("A"), *values])


def _array(code: str, values: list | None, length: int) -> Property:
    """An array property, with its values only when they were read."""
    size = 8 if code in ("d", "l") else 4
    info = ArrayInfo(length=length, encoding=0, byte_length=length * size)
    return Property(code, list(values) if values is not None else None, info)


class _Builder:
    """Assembles the record tree, handing out UIDs as it goes."""

    def __init__(self) -> None:
        self.objects: list[Node] = []
        self.connections: list[Node] = []
        self._next = 1000

    def uid(self) -> int:
        self._next += 1
        return self._next

    def connect(self, kind: str, source: int, target: int, *extra: str) -> None:
        props = [_s(kind), _l(source), _l(target), *(_s(e) for e in extra)]
        self.connections.append(_node("C", props))


def _materials(json_doc: dict, build: _Builder, buffers: Sequence[bytes | None],
               doc: Document) -> list[int]:
    uids: list[int] = []
    for index, material in enumerate(json_doc.get("materials") or []):
        uid = build.uid()
        uids.append(uid)
        pbr = material.get("pbrMetallicRoughness") or {}
        base = [float(v) for v in pbr.get("baseColorFactor", (1.0, 1.0, 1.0, 1.0))]
        while len(base) < 4:
            base.append(1.0)
        metallic = float(pbr.get("metallicFactor", 1.0))
        roughness = float(pbr.get("roughnessFactor", 1.0))
        # Metal takes its reflectance from the base colour, a dielectric 4% —
        # unless KHR_materials_specular says otherwise, which is the one place
        # glTF records a reflectance of its own.
        extension = (material.get("extensions") or {}).get("KHR_materials_specular") or {}
        tint = extension.get("specularColorFactor", (1.0, 1.0, 1.0))
        strength = float(extension.get("specularFactor", 1.0))
        specular = [0.04 * float(tint[k]) * strength * (1 - metallic) + base[k] * metallic
                    for k in range(3)]
        diffuse = [base[k] * (1 - metallic) for k in range(3)]
        opacity = base[3] if material.get("alphaMode") == "BLEND" else 1.0

        props = [
            _p70("DiffuseColor", "Color", *(_d(c) for c in diffuse)),
            _p70("SpecularColor", "Color", *(_d(c) for c in specular)),
            # Roughness back to the exponent an FBX material carries.
            _p70("ShininessExponent", "Number", _d(2 / max(roughness * roughness, 1e-4) - 2)),
            _p70("Metallic", "Number", _d(metallic)),
            _p70("Opacity", "Number", _d(opacity)),
        ]
        name = material.get("name") or f"material{index}"
        build.objects.append(
            _node("Material", [_l(uid), _s(f"{name}\x00\x01Material"), _s("")], [
                _node("Version", [_i(102)]),
                _node("ShadingModel", [_s("phong")]),
                _node("Properties70", [], props),
            ])
        )
        _texture_for(json_doc, pbr, build, buffers, uid, doc)
    return uids


def _texture_for(json_doc: dict, pbr: dict, build: _Builder,
                 buffers: Sequence[bytes | None], material_uid: int,
                 doc: Document) -> None:
    """The base colour image, wherever it lives."""
    entry = pbr.get("baseColorTexture")
    if not entry:
        return
    textures = json_doc.get("textures") or []
    index = entry.get("index")
    if index is None or not 0 <= index < len(textures):
        doc.warn("a material names a texture that is not there")
        return
    images = json_doc.get("images") or []
    source = textures[index].get("source")
    if source is None or not 0 <= source < len(images):
        return
    image = images[source]

    uri = image.get("uri") or ""
    filename = "" if uri.startswith("data:") else uri
    name = image.get("name") or filename or f"image{source}"
    texture_uid = build.uid()
    video_uid = build.uid()
    build.objects.append(
        _node("Texture", [_l(texture_uid), _s(f"{name}\x00\x01Texture"), _s("")], [
            _node("Type", [_s("TextureVideoClip")]),
            _node("Version", [_i(202)]),
            _node("FileName", [_s(filename)]),
            _node("RelativeFilename", [_s(filename)]),
        ])
    )

    video_children = [
        _node("Type", [_s("Clip")]),
        _node("FileName", [_s(filename)]),
        _node("RelativeFilename", [_s(filename)]),
    ]
    _length, content = _image_bytes(json_doc, image, buffers)
    if content:
        # Carried as a raw property, the way an embedded texture arrives in an
        # FBX file. An image in a buffer that was not read is simply absent.
        video_children.append(_node("Content", [Property("R", content)]))
    build.objects.append(
        _node("Video", [_l(video_uid), _s(f"{name}\x00\x01Video"), _s("Clip")], video_children))
    build.connect("OP", texture_uid, material_uid, "DiffuseColor")
    build.connect("OO", video_uid, texture_uid)


def _image_bytes(json_doc: dict, image: dict,
                 buffers: Sequence[bytes | None]) -> tuple[int, bytes | None]:
    """How big an image inside the file is, and its bytes when they were read."""
    if image.get("bufferView") is None:
        return 0, None
    views = json_doc.get("bufferViews") or []
    index = image["bufferView"]
    if not 0 <= index < len(views):
        return 0, None
    view = views[index]
    length = int(view.get("byteLength", 0))
    data = buffers[view.get("buffer", 0)] if view.get("buffer", 0) < len(buffers) else None
    if data is None:
        return length, None
    start = int(view.get("byteOffset", 0))
    return length, data[start:start + length]


#: Returned instead of a UID by a primitive whose geometry is compressed away.
COMPRESSED = object()


def _geometry(primitive: dict, name: str, accessors: _Accessors, build: _Builder,
              doc: Document, *, load_arrays: bool):
    """One primitive as a Geometry record; returns its UID.

    ``COMPRESSED`` comes back when the geometry is Draco's rather than the
    file's own, and ``None`` when there is nothing to read at all.
    """
    mode = primitive.get("mode", 4)
    if mode != 4:
        doc.warn(f"{name} uses drawing mode {mode}, which this reader does not "
                 "turn into polygons")
        return None
    # Draco replaces the vertex streams with its own compressed block, so the
    # accessors it leaves behind describe a mesh that is not there.
    if (primitive.get("extensions") or {}).get("KHR_draco_mesh_compression"):
        return COMPRESSED
    attributes = primitive.get("attributes") or {}
    position = attributes.get("POSITION")
    if position is None:
        return None
    vertex_count = accessors.count(position) // 3
    if not vertex_count:
        return None

    positions = accessors.read(position) if load_arrays else None
    index_accessor = primitive.get("indices")
    corners = accessors.count(index_accessor) if index_accessor is not None else vertex_count

    polygons = None
    if load_arrays:
        indices = accessors.read(index_accessor) if index_accessor is not None \
            else list(range(vertex_count))
        # A polygon run, as FBX writes it: the last corner of each triangle is
        # stored as its complement.
        polygons = list(indices)
        for i in range(2, len(polygons), 3):
            polygons[i] = ~polygons[i]

    children = [
        _node("Vertices", [_array("d", positions, vertex_count * 3)]),
        _node("PolygonVertexIndex", [_array("i", polygons, corners)]),
        _node("GeometryVersion", [_i(124)]),
    ]

    normal = attributes.get("NORMAL")
    if normal is not None and accessors.count(normal) == vertex_count * 3:
        children.append(_node("LayerElementNormal", [_i(0)], [
            _node("Version", [_i(101)]),
            _node("MappingInformationType", [_s("ByVertice")]),
            _node("ReferenceInformationType", [_s("Direct")]),
            _node("Normals", [_array("d", accessors.read(normal) if load_arrays else None,
                                     vertex_count * 3)]),
        ]))

    uv = attributes.get("TEXCOORD_0")
    if uv is not None and accessors.count(uv) == vertex_count * 2:
        values = None
        if load_arrays:
            read = accessors.read(uv) or []
            # glTF measures V downwards from the top; FBX upwards.
            values = [v if i % 2 == 0 else 1 - v for i, v in enumerate(read)]
        children.append(_node("LayerElementUV", [_i(0)], [
            _node("Version", [_i(101)]),
            _node("Name", [_s("map1")]),
            _node("MappingInformationType", [_s("ByVertice")]),
            _node("ReferenceInformationType", [_s("Direct")]),
            _node("UV", [_array("d", values, vertex_count * 2)]),
        ]))

    children.append(_node("LayerElementMaterial", [_i(0)], [
        _node("Version", [_i(101)]),
        _node("MappingInformationType", [_s("AllSame")]),
        _node("ReferenceInformationType", [_s("IndexToDirect")]),
        _node("Materials", [_array("i", [0] if load_arrays else None, 1)]),
    ]))
    children.append(_node("Layer", [_i(0)], [_node("Version", [_i(100)])]))

    uid = build.uid()
    build.objects.append(
        _node("Geometry", [_l(uid), _s(f"{name}\x00\x01Geometry"), _s("Mesh")], children))
    return uid


def parse_gltf(
    data: bytes,
    *,
    path: str | None = None,
    load_arrays: bool = False,
) -> Document:
    """Parse a glTF document or container into a Document."""
    doc = Document(root=Node(""), encoding="binary" if data[:4] == MAGIC else "ascii",
                   path=path, file_size=len(data))
    doc.format = "gltf"
    doc.version = None
    doc.version_source = None

    json_doc, binary, warnings = read_container(data)
    for warning in warnings:
        doc.warn(warning)
    asset = json_doc.get("asset") or {}
    if not str(asset.get("version", "")).startswith("2"):
        doc.warn(f"glTF version {asset.get('version')} — this reads 2.x")

    # Buffers: the container's own, a data: URI, or a file beside the document.
    buffers: list[bytes | None] = []
    external: list[str] = []
    for index, buffer in enumerate(json_doc.get("buffers") or []):
        uri = buffer.get("uri")
        if uri is None:
            buffers.append(binary)
            continue
        if not uri.startswith("data:"):
            external.append(uri)
        # Buffers are gathered whatever is asked for — a file that names one it
        # has not got is worth saying so about even in a listing — while what
        # costs real time, decoding the accessors, waits for load_arrays.
        buffers.append(_decode_uri(uri, path, doc))
        if buffers[-1] is None:
            doc.warn(f"buffer {index} could not be read, so its arrays are empty")

    accessors = _Accessors(json_doc, buffers, doc)
    build = _Builder()
    material_uids = _materials(json_doc, build, buffers, doc)

    # One Geometry per primitive, keyed by the mesh that owns it.
    mesh_parts: list[list[tuple[int, int | None, str]]] = []
    compressed = 0
    for mesh_index, mesh in enumerate(json_doc.get("meshes") or []):
        primitives = mesh.get("primitives") or []
        label = mesh.get("name") or f"mesh{mesh_index}"
        parts: list[tuple[int, int | None, str]] = []
        for at, primitive in enumerate(primitives):
            name = f"{label}/{at}" if len(primitives) > 1 else label
            uid = _geometry(primitive, name, accessors, build, doc, load_arrays=load_arrays)
            if uid is COMPRESSED:
                compressed += 1
            elif uid is not None:
                parts.append((uid, primitive.get("material"), name))
        mesh_parts.append(parts)

    if compressed:
        doc.warn(f"{compressed} mesh part(s) are compressed with Draco "
                 "(KHR_draco_mesh_compression), which this reader cannot "
                 "decompress — their geometry is not in the file in any other "
                 "form")
    basis = sum(1 for image in json_doc.get("images") or []
                if image.get("mimeType") == "image/ktx2")
    if basis:
        doc.warn(f"{basis} texture(s) are KTX2 / Basis Universal "
                 "(KHR_texture_basisu), which is not an image format a viewer "
                 "can hand to a browser")

    # Nodes: the hierarchy, and where each mesh sits in it.
    nodes = json_doc.get("nodes") or []
    node_uids = [build.uid() for _ in nodes]
    for index, gltf_node in enumerate(nodes):
        uid = node_uids[index]
        translation, rotation, scale = _placement(gltf_node)
        parts = mesh_parts[gltf_node["mesh"]] if gltf_node.get("mesh") is not None \
            and gltf_node["mesh"] < len(mesh_parts) else []
        build.objects.append(
            _node("Model", [_l(uid), _s(f"{gltf_node.get('name') or f'node{index}'}"
                                        "\x00\x01Model"),
                            _s("Mesh" if parts else "Null")], [
                _node("Version", [_i(232)]),
                _node("Properties70", [], [
                    _p70("Lcl Translation", "Lcl Translation", *(_d(v) for v in translation)),
                    _p70("Lcl Rotation", "Lcl Rotation", *(_d(v) for v in rotation)),
                    _p70("Lcl Scaling", "Lcl Scaling", *(_d(v) for v in scale)),
                ]),
            ])
        )
        # A node with several primitives becomes one model per primitive, each
        # hanging off it, so every one keeps its own material.
        for geometry_uid, material, name in parts:
            owner = uid
            if len(parts) > 1:
                owner = build.uid()
                build.objects.append(
                    _node("Model", [_l(owner), _s(f"{name}\x00\x01Model"), _s("Mesh")], [
                        _node("Version", [_i(232)]),
                    ])
                )
                build.connect("OO", owner, uid)
            build.connect("OO", geometry_uid, owner)
            if material is not None and 0 <= material < len(material_uids):
                build.connect("OO", material_uids[material], owner)

    for index, gltf_node in enumerate(nodes):
        for child in gltf_node.get("children") or []:
            if 0 <= child < len(node_uids):
                build.connect("OO", node_uids[child], node_uids[index])
    scenes = json_doc.get("scenes") or []
    scene_index = json_doc.get("scene", 0)
    scene = scenes[scene_index] if 0 <= scene_index < len(scenes) else {}
    for root_node in scene.get("nodes") or []:
        if 0 <= root_node < len(node_uids):
            build.connect("OO", node_uids[root_node], 0)

    _assemble(doc, json_doc, build, asset)
    doc.extra.update({
        "generator": asset.get("generator", ""),
        "gltf_version": asset.get("version", ""),
        "copyright": asset.get("copyright", ""),
        "meshes": len(json_doc.get("meshes") or []),
        "primitives": sum(len(mesh.get("primitives") or [])
                          for mesh in json_doc.get("meshes") or []),
        "draco_primitives": compressed,
        "nodes": len(nodes),
        "materials": len(json_doc.get("materials") or []),
        "images": len(json_doc.get("images") or []),
        "buffers": len(json_doc.get("buffers") or []),
        "buffer_views": len(json_doc.get("bufferViews") or []),
        "accessors": len(json_doc.get("accessors") or []),
        "animations": len(json_doc.get("animations") or []),
        "skins": len(json_doc.get("skins") or []),
        "cameras": len(json_doc.get("cameras") or []),
        "extensions_used": list(json_doc.get("extensionsUsed") or []),
        "extensions_required": list(json_doc.get("extensionsRequired") or []),
        "external_buffers": external,
        "component_types": sorted({
            _COMPONENT_NAMES.get(a.get("componentType"), str(a.get("componentType")))
            for a in json_doc.get("accessors") or []
        }),
        "triangles": sum(
            (accessors.count(p.get("indices")) if p.get("indices") is not None
             else accessors.count((p.get("attributes") or {}).get("POSITION")) // 3) // 3
            for mesh in json_doc.get("meshes") or []
            for p in mesh.get("primitives") or []
        ),
    })
    if json_doc.get("extensionsRequired"):
        doc.warn("this file requires extensions: "
                 + ", ".join(json_doc["extensionsRequired"]))
    return doc


def _assemble(doc: Document, json_doc: dict, build: _Builder, asset: dict) -> None:
    generator = asset.get("generator") or "glTF 2.0"
    root = doc.root
    root.children.append(_node("FBXHeaderExtension", [], [
        _node("FBXVersion", [_i(7400)]),
        _node("Creator", [_s(generator)]),
    ]))
    root.children.append(_node("Creator", [_s(generator)]))
    root.children.append(_node("GlobalSettings", [], [
        _node("Version", [_i(1000)]),
        _node("Properties70", [], [
            # glTF is Y up, right handed, in metres.
            _node("P", [_s("UpAxis"), _s("int"), _s("Integer"), _s(""), _i(1)]),
            _node("P", [_s("UpAxisSign"), _s("int"), _s("Integer"), _s(""), _i(1)]),
            _node("P", [_s("FrontAxis"), _s("int"), _s("Integer"), _s(""), _i(2)]),
            _node("P", [_s("FrontAxisSign"), _s("int"), _s("Integer"), _s(""), _i(1)]),
            _node("P", [_s("CoordAxis"), _s("int"), _s("Integer"), _s(""), _i(0)]),
            _node("P", [_s("CoordAxisSign"), _s("int"), _s("Integer"), _s(""), _i(1)]),
            _node("P", [_s("UnitScaleFactor"), _s("double"), _s("Number"), _s(""), _d(100.0)]),
        ]),
    ]))

    counts: dict[str, int] = {}
    for entry in build.objects:
        counts[entry.name] = counts.get(entry.name, 0) + 1
    root.children.append(_node("Definitions", [], [
        _node("Version", [_i(100)]),
        _node("Count", [_i(len(build.objects))]),
        *[_node("ObjectType", [_s(name)], [_node("Count", [_i(count)])])
          for name, count in counts.items()],
    ]))
    root.children.append(_node("Objects", [], build.objects))
    root.children.append(_node("Connections", [], build.connections))
