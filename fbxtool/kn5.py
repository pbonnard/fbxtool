"""Reader for Assetto Corsa's ``.kn5`` — the model a car or a track is drawn from.

A ``.kn5`` is what ksEditor writes out of 3ds Max for the game to load: one
binary file holding the whole thing, textures included.  There is no scene
graph library behind it and nothing is named by string at run time, so the file
is a plain forward walk — a texture table, a material table, then a node tree
whose meshes address the materials by index.

As with the OBJ and glTF readers, it is normalised into the record tree the FBX
readers produce, so the existing report and scene analysis apply unchanged:

=============================  ====================================
kn5                            record
=============================  ====================================
a texture                      ``Texture`` + ``Video`` (bytes on the clip)
a material                     ``Material``
``txDiffuse`` / ``txNormal``   an ``OP`` link naming ``DiffuseColor`` / ``NormalMap``
a dummy node                   ``Model`` (Null) with its transform
a mesh node                    ``Model`` (Mesh) and a ``Geometry``
a vertex stream                ``Vertices``, ``LayerElementNormal``, ``LayerElementUV``
``indices``                    ``PolygonVertexIndex``
=============================  ====================================

Two things are turned round on the way in.  The game measures V downwards from
the top of a texture, as Direct3D does and FBX does not, so V is flipped.  And
the transforms are Direct3D's row-major 4×4 with the translation in the last
row — which is the same sixteen numbers in the same order as glTF's
column-major matrix acting on column vectors, so they decompose identically.

Nothing else is moved.  The game's axes are right-handed with Y up and +Z
towards the front of the car, which leaves +X pointing at its left-hand side;
that is what ``GlobalSettings`` is made to say, rather than mirroring a car to
make it look like something else.

Vertices are interleaved — position, normal, UV and tangent, 44 bytes to a
vertex — and are only unpacked when arrays are asked for, which is what keeps
``--brief`` cheap on an 80 MB car.  The texture payloads are carried either
way, since they are the file's own bytes and the report is worth having exact
sizes in.
"""

from __future__ import annotations

import math
import struct
from typing import Sequence

from .model import ArrayInfo, Document, Node, ParseError, Property

__all__ = ["MAGIC", "NODE_CLASSES", "is_kn5", "parse_kn5"]

MAGIC = b"sc6969"

#: What the class number at the head of a node record means.
NODE_CLASSES = {1: "Node", 2: "Mesh", 3: "SkinnedMesh"}

#: 0 opaque, 1 blended, 2 resolved by the multisample mask.
_BLEND_MODES = {0: "OPAQUE", 1: "BLEND", 2: "MASK"}

#: How wide one vertex is, plain and skinned.
_VERTEX = 44
_SKINNED_VERTEX = 76

#: The kn5 texture slots that mean something to an FBX material.
_SLOT_PROPERTIES = {
    "txDiffuse": "DiffuseColor",
    "txNormal": "NormalMap",
    "txGlow": "EmissiveColor",
}

#: On the shaders that model a car being crashed, ``txNormal`` is not the
#: surface's own relief — it is the dents, blended in as damage accumulates.
#: A car as saved has none, so drawing it puts creases down the whole of a
#: bonnet that has never been hit: the Mercedes' body names a 1024-square of
#: dents there, and taken at face value every panel comes out beaten in.
_DAMAGE_NORMAL_SLOTS = {"txNormal"}


def _slot_property(slot: str, shader: str) -> str:
    """The FBX property a kn5 texture slot fills, under this shader.

    A slot with no FBX meaning keeps the name the game gives it: ``txMaps`` is
    not a metallic-roughness map however much it looks like one — its channels
    drive the game's own shader — and a map drawn from the wrong end is worse
    than one not drawn.
    """
    if slot in _DAMAGE_NORMAL_SLOTS and "damage" in shader.lower():
        return slot
    return _SLOT_PROPERTIES.get(slot, slot)

#: Property defaults for a material that leaves one out, as the shaders do.
_DEFAULT_FRESNEL_C = 0.05

#: The most a dielectric reflects facing you: diamond, at an index of refraction
#: of 2.42.  Glass and plastic sit near 0.04, and an artist writing 0.15 for a
#: windscreen is still describing one.  Above this, nothing but a conductor
#: reflects that much.
_DIELECTRIC_CEILING = 0.17
#: And where the dullest of the conductors starts — iron and chromium.
_METAL_FLOOR = 0.5


def _metalness(facing: float, blended: bool) -> float:
    """How much of a conductor a surface reflecting this much must be.

    A kn5 states no metalness.  The game shades a car with a Blinn-Phong
    highlight and a Schlick Fresnel over it, and chrome is simply a material
    whose ``fresnelC`` an artist set high.  But ``fresnelC`` is a reflectance
    at normal incidence, and that is the one number where the two kinds of
    surface cannot be confused: no dielectric reflects more than about 17%
    facing you, and no metal less than about half.

    Nothing is read from a surface the file also says is see-through — light
    passes through a dielectric and not through a conductor, so a windscreen
    with a strong reflection is a windscreen.

    Where an artist stated nothing this reads zero, rather than guessing from a
    material's name.  Some cars are modelled entirely through the grazing
    level, which is what paint does too: an Alfa Brera's chrome and its body
    are the same numbers to three decimal places, and the difference between
    them is in the picture each one wears.
    """
    if blended or facing <= _DIELECTRIC_CEILING:
        return 0.0
    return min(1.0, (facing - _DIELECTRIC_CEILING)
               / (_METAL_FLOOR - _DIELECTRIC_CEILING))


def is_kn5(data: bytes) -> bool:
    """True when *data* is an Assetto Corsa model file."""
    return data[:6] == MAGIC


class _Cursor:
    """A forward walk over the file, which is all the format ever needs."""

    def __init__(self, data: bytes) -> None:
        self.data = data
        self.at = 0

    def _take(self, count: int) -> int:
        start = self.at
        self.at += count
        if self.at > len(self.data):
            raise ParseError(f"the file ends inside a record at byte {start}")
        return start

    def u8(self) -> int:
        return self.data[self._take(1)]

    def i32(self) -> int:
        return struct.unpack_from("<i", self.data, self._take(4))[0]

    def u32(self) -> int:
        return struct.unpack_from("<I", self.data, self._take(4))[0]

    def f32(self) -> float:
        return struct.unpack_from("<f", self.data, self._take(4))[0]

    def floats(self, count: int) -> tuple[float, ...]:
        return struct.unpack_from(f"<{count}f", self.data, self._take(4 * count))

    def text(self) -> str:
        """A length-prefixed UTF-8 string."""
        length = self.u32()
        if length > len(self.data) - self.at:
            raise ParseError(f"a {length}-byte name at {self.at} runs past the file")
        return self.data[self._take(length):self.at].decode("utf-8", "replace")

    def blob(self, length: int) -> bytes:
        return self.data[self._take(length):self.at]

    def skip(self, count: int) -> None:
        self._take(count)


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
    width = 8 if code in ("d", "l") else 4
    info = ArrayInfo(length=length, encoding=0, byte_length=length * width)
    return Property(code, list(values) if values is not None else None, info)


def _euler(m: Sequence[float]) -> tuple[float, float, float]:
    """Euler angles in degrees for R = Rz · Ry · Rx, FBX's XYZ order.

    *m* is a 3×3 as ``r[row][col]``, with any scale already divided out.
    """
    sy = -max(-1.0, min(1.0, m[2][0]))
    y = math.asin(sy)
    if abs(m[2][0]) < 0.99999:
        x = math.atan2(m[2][1], m[2][2])
        z = math.atan2(m[1][0], m[0][0])
    else:  # looking straight up or down: x and z are the same turn
        x = math.atan2(-m[1][2], m[1][1])
        z = 0.0
    return tuple(math.degrees(v) for v in (x, y, z))  # type: ignore[return-value]


def _placement(matrix: Sequence[float]) -> tuple[list[float], list[float], list[float]]:
    """A node's translation, rotation in degrees, and scale.

    The sixteen numbers are Direct3D's: rows are the basis vectors and the
    translation is the last of them.  Read as ``m[col * 4 + row]`` that is the
    same element order as a column-major matrix acting on column vectors, which
    is what the rest of this package works in.

    A mirrored node has a negative determinant and no rotation can produce one,
    so the flip is kept where it belongs — as a negative scale on X.
    """
    translation = [matrix[12], matrix[13], matrix[14]]
    basis = [[matrix[col * 4 + row] for col in range(3)] for row in range(3)]
    scale = [math.sqrt(sum(basis[row][col] ** 2 for row in range(3)))
             for col in range(3)]
    determinant = (
        basis[0][0] * (basis[1][1] * basis[2][2] - basis[1][2] * basis[2][1])
        - basis[0][1] * (basis[1][0] * basis[2][2] - basis[1][2] * basis[2][0])
        + basis[0][2] * (basis[1][0] * basis[2][1] - basis[1][1] * basis[2][0])
    )
    if determinant < 0:
        scale[0] = -scale[0]
    unit = [[basis[row][col] / scale[col] if scale[col] else 0.0
             for col in range(3)] for row in range(3)]
    return translation, list(_euler(unit)), scale


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


# ------------------------------------------------------------------ the file


class _Texture:
    __slots__ = ("kind", "name", "size", "data")

    def __init__(self, kind: int, name: str, size: int, data: bytes) -> None:
        self.kind = kind
        self.name = name
        self.size = size
        self.data = data


class _Material:
    __slots__ = ("name", "shader", "blend", "alpha_tested", "depth_mode",
                 "props", "slots")

    def __init__(self, name: str, shader: str, blend: int, alpha_tested: int,
                 depth_mode: int, props: dict, slots: list) -> None:
        self.name = name
        self.shader = shader
        self.blend = blend
        self.alpha_tested = alpha_tested
        self.depth_mode = depth_mode
        #: name -> (a, (b0, b1), (c0, c1, c2), (d0, d1, d2, d3))
        self.props = props
        #: [(slot name, slot number, texture name)]
        self.slots = slots

    def scalar(self, name: str, default: float = 0.0) -> float:
        entry = self.props.get(name)
        return float(entry[0]) if entry is not None else default


def _read_textures(cursor: _Cursor, doc: Document) -> list[_Texture]:
    count = cursor.i32()
    if count < 0:
        raise ParseError(f"the texture table claims {count} entries")
    textures: list[_Texture] = []
    for _ in range(count):
        kind = cursor.i32()
        name = cursor.text()
        size = cursor.u32()
        # A slot marked inactive still carries its bytes; the game just does
        # not load it.  Nothing here has to make that distinction, and dropping
        # the payload would move the cursor off the next record.
        textures.append(_Texture(kind, name, size, cursor.blob(size)))
    return textures


#: A payload every texture in the file shares is not a texture — and no real
#: one is this small.  4 KiB is roomy for a 1x1 placeholder and far under a
#: 16x16 swatch a car actually uses, of which several are genuinely repeated.
_PLACEHOLDER_LIMIT = 4096


def _placeholders(textures: Sequence["_Texture"]) -> bool:
    """True when the texture table holds one stand-in image over and over.

    Cars are published with their textures stripped out and something else put
    in the file after the node tree: every entry in the table is then the same
    seventy-byte PNG of a single blue pixel, under the name of the picture that
    used to be there.  Drawn, that paints the whole car one translucent blue;
    read for what it is, the car comes back in its own material colours with
    every texture listed as one to go and find.
    """
    if len(textures) < 2:
        return False
    first = textures[0].data
    if not first or len(first) > _PLACEHOLDER_LIMIT:
        return False
    return all(texture.data == first for texture in textures[1:])


def _read_materials(cursor: _Cursor, doc: Document) -> list[_Material]:
    count = cursor.i32()
    if count < 0:
        raise ParseError(f"the material table claims {count} entries")
    materials: list[_Material] = []
    for _ in range(count):
        name = cursor.text()
        shader = cursor.text()
        blend = cursor.u8()
        alpha_tested = cursor.u8()
        depth_mode = cursor.i32()
        props: dict = {}
        for _ in range(cursor.i32()):
            key = cursor.text()
            props[key] = (cursor.f32(), cursor.floats(2), cursor.floats(3),
                          cursor.floats(4))
        slots = []
        for _ in range(cursor.i32()):
            slots.append((cursor.text(), cursor.i32(), cursor.text()))
        materials.append(
            _Material(name, shader, blend, alpha_tested, depth_mode, props, slots))
    return materials


class _Mesh:
    """One mesh node's geometry, unpacked only as far as was asked for."""

    __slots__ = ("vertices", "indices", "positions", "normals", "uvs",
                 "polygons", "material", "layer", "lod_in", "lod_out",
                 "radius", "renderable", "visible", "transparent",
                 "cast_shadows", "bones", "vertex_at", "index_at", "stride")

    def __init__(self) -> None:
        self.vertices = 0
        self.indices = 0
        #: Where the two streams start, so they can be sampled without being
        #: unpacked — which is how the geometry is checked against itself.
        self.vertex_at = 0
        self.index_at = 0
        self.stride = _VERTEX
        self.positions: list[float] | None = None
        self.normals: list[float] | None = None
        self.uvs: list[float] | None = None
        self.polygons: list[int] | None = None
        self.material = 0
        self.layer = 0
        self.lod_in = 0.0
        self.lod_out = 0.0
        self.radius = 0.0
        self.renderable = True
        self.visible = True
        self.transparent = False
        self.cast_shadows = True
        self.bones: list[str] = []


def _read_vertices(cursor: _Cursor, mesh: _Mesh, stride: int, *,
                   load_arrays: bool) -> None:
    """Unpack the interleaved vertex stream, or step over it."""
    count = cursor.u32()
    mesh.vertices = count
    start = cursor.at
    mesh.vertex_at = start
    mesh.stride = stride
    cursor.skip(count * stride)
    if not load_arrays:
        return
    data = cursor.data
    positions: list[float] = [0.0] * (count * 3)
    normals: list[float] = [0.0] * (count * 3)
    uvs: list[float] = [0.0] * (count * 2)
    layout = struct.Struct("<8f")
    for index in range(count):
        px, py, pz, nx, ny, nz, u, v = layout.unpack_from(data, start + index * stride)
        positions[index * 3:index * 3 + 3] = (px, py, pz)
        normals[index * 3:index * 3 + 3] = (nx, ny, nz)
        # The game measures V down from the top of the texture; FBX up.
        uvs[index * 2:index * 2 + 2] = (u, 1.0 - v)
    mesh.positions = positions
    mesh.normals = normals
    mesh.uvs = uvs


def _read_indices(cursor: _Cursor, mesh: _Mesh, *, load_arrays: bool) -> None:
    count = cursor.u32()
    mesh.indices = count
    start = cursor.at
    mesh.index_at = start
    cursor.skip(count * 2)
    if not load_arrays:
        return
    indices = list(struct.unpack_from(f"<{count}H", cursor.data, start))
    # A polygon run, as FBX writes it: the last corner of each triangle is
    # stored as its complement.
    for at in range(2, len(indices), 3):
        indices[at] = ~indices[at]
    mesh.polygons = indices


def _read_mesh(cursor: _Cursor, skinned: bool, *, load_arrays: bool) -> _Mesh:
    mesh = _Mesh()
    mesh.cast_shadows = bool(cursor.u8())
    mesh.visible = bool(cursor.u8())
    mesh.transparent = bool(cursor.u8())
    if skinned:
        for _ in range(cursor.i32()):
            mesh.bones.append(cursor.text())
            cursor.skip(64)
    _read_vertices(cursor, mesh, _SKINNED_VERTEX if skinned else _VERTEX,
                   load_arrays=load_arrays)
    _read_indices(cursor, mesh, load_arrays=load_arrays)
    mesh.material = cursor.i32()
    mesh.layer = cursor.u32()
    mesh.lod_in = cursor.f32()
    mesh.lod_out = cursor.f32()
    if not skinned:
        # A bounding sphere, then whether the game draws it at all.  A skinned
        # mesh moves, so it carries neither.
        cursor.skip(12)
        mesh.radius = cursor.f32()
        mesh.renderable = bool(cursor.u8())
    return mesh


#: How many triangles of any one mesh are held against its normals.  A couple
#: of dozen settles a mesh either way, and the cost is what keeps a listing of
#: an eighty-megabyte car under a tenth of a second.
_WINDING_SAMPLE = 24
#: Below this share agreeing, the geometry does not describe the surface its
#: own normals describe.  Twelve sound cars sit between 95% and 100%; a
#: scrambled one sits on a coin toss.
_WINDING_FLOOR = 0.75
#: And this many triangles must have been looked at before saying so.
_WINDING_MINIMUM = 200


def _winding(data: bytes, mesh: "_Mesh", tally: list[int]) -> None:
    """Count triangles wound the way their own vertex normals point.

    A triangle's corners in order give it a facing, and every vertex of it
    carries a normal that should agree.  In a sound file they always do — the
    exporter wrote both from the same surface — so the two are a check on each
    other that needs nothing outside the mesh.

    Cars are published deliberately spoiled, with the vertex stream scrambled
    so that anything but the game draws a shattered model, and the real
    geometry left encrypted after the node tree.  Nothing in the header says
    so: the counts are right, the normals are unit vectors, and every index is
    in range.  This is what tells the difference, and it costs a sample.
    """
    count = min(mesh.indices // 3, _WINDING_SAMPLE)
    if not count or not mesh.vertices:
        return
    step = max(1, (mesh.indices // 3) // count) * 3
    layout = struct.Struct("<6f")
    for at in range(0, mesh.indices - 2, step):
        corners = struct.unpack_from("<3H", data, mesh.index_at + at * 2)
        if max(corners) >= mesh.vertices:
            return
        a, b, c = (layout.unpack_from(data, mesh.vertex_at + i * mesh.stride)
                   for i in corners)
        e1 = (b[0] - a[0], b[1] - a[1], b[2] - a[2])
        e2 = (c[0] - a[0], c[1] - a[1], c[2] - a[2])
        cross = (e1[1] * e2[2] - e1[2] * e2[1],
                 e1[2] * e2[0] - e1[0] * e2[2],
                 e1[0] * e2[1] - e1[1] * e2[0])
        scale = math.sqrt(cross[0] ** 2 + cross[1] ** 2 + cross[2] ** 2)
        if scale < 1e-12:                      # a degenerate triangle faces nowhere
            continue
        facing = sum(cross[k] * (a[3 + k] + b[3 + k] + c[3 + k]) for k in range(3))
        if facing > 0.02 * scale:
            tally[0] += 1
        elif facing < -0.02 * scale:
            tally[1] += 1


#: What Custom Shaders Patch writes at the very end of a car it has encrypted.
_ENCRYPTED_MARKER = b"__AC_SHADERS_PATCH_KN5ENC_v1__"


def _encrypted_from(data: bytes) -> int | None:
    """Where a Custom Shaders Patch encrypted section starts, if there is one.

    A protected car is a whole kn5 with the model deliberately spoiled — the
    vertex stream scrambled, every texture replaced by one stand-in — followed
    by the real thing in named, encrypted blocks, and then a trailer saying so
    in plain text: this marker, the offset the encrypted part begins at, and a
    version.  The game decrypts it.  Nothing here does, and nothing here tries;
    what it can do is say which kind of file it has been given, so a shattered
    car is a fact about the file rather than a mystery about the reader.
    """
    tail = data[-64:]
    at = tail.rfind(_ENCRYPTED_MARKER)
    if at < 0:
        return None
    after = len(data) - len(tail) + at + len(_ENCRYPTED_MARKER)
    if after + 8 > len(data):
        return None
    start, _version = struct.unpack_from("<II", data, after)
    return start if 0 < start <= len(data) else None


class _Scene:
    """What the node walk gathers, beside the records it writes."""

    def __init__(self) -> None:
        self.nodes = 0
        self.meshes = 0
        self.skinned = 0
        self.vertices = 0
        self.triangles = 0
        self.inactive = 0
        self.hidden = 0
        self.bones = 0
        self.depth = 0
        self.lods: list[str] = []
        self.used_materials: set[int] = set()
        #: Triangles wound with their own normals, and against them.
        self.winding = [0, 0]


def _walk(cursor: _Cursor, build: _Builder, scene: _Scene, doc: Document,
          material_uids: list[int], parent: int, depth: int, *,
          load_arrays: bool) -> None:
    """Read one node and everything under it, writing the records as it goes."""
    if depth > 256:
        raise ParseError("the node tree nests deeper than 256 levels")
    scene.depth = max(scene.depth, depth)
    class_id = cursor.i32()
    if class_id not in NODE_CLASSES:
        raise ParseError(f"node class {class_id} at byte {cursor.at - 4} is not one "
                         "this reader knows")
    name = cursor.text()
    children = cursor.i32()
    if children < 0:
        raise ParseError(f"{name or 'a node'} claims {children} children")
    active = bool(cursor.u8())
    scene.nodes += 1
    if not active:
        scene.inactive += 1

    uid = build.uid()
    props: list[Node] = []
    mesh: _Mesh | None = None

    if class_id == 1:
        translation, rotation, scaling = _placement(cursor.floats(16))
        if any(translation):
            props.append(_p70("Lcl Translation", "Lcl Translation",
                              *(_d(v) for v in translation)))
        if any(rotation):
            props.append(_p70("Lcl Rotation", "Lcl Rotation",
                              *(_d(v) for v in rotation)))
        if scaling != [1.0, 1.0, 1.0]:
            props.append(_p70("Lcl Scaling", "Lcl Scaling",
                              *(_d(v) for v in scaling)))
        if name.upper().startswith("LOD_"):
            scene.lods.append(name)
    else:
        # A mesh sits where its parent puts it: the format gives it no
        # transform of its own.
        mesh = _read_mesh(cursor, class_id == 3, load_arrays=load_arrays)
        _winding(cursor.data, mesh, scene.winding)
        scene.meshes += 1
        scene.vertices += mesh.vertices
        scene.triangles += mesh.indices // 3
        scene.bones += len(mesh.bones)
        if class_id == 3:
            scene.skinned += 1
        if not mesh.visible or not mesh.renderable:
            scene.hidden += 1
        props.append(_p70("Visibility", "Visibility",
                          _d(1.0 if mesh.visible and mesh.renderable else 0.0)))

    if not active:
        props.append(_p70("Visibility", "Visibility", _d(0.0)))

    label = name or f"node{uid}"
    build.objects.append(
        _node("Model", [_l(uid), _s(f"{label}\x00\x01Model"),
                        _s("Mesh" if mesh is not None else "Null")], [
            _node("Version", [_i(232)]),
            _node("Properties70", [], props),
        ])
    )
    build.connect("OO", uid, parent)

    if mesh is not None:
        _geometry(mesh, label, build, uid)
        if 0 <= mesh.material < len(material_uids):
            scene.used_materials.add(mesh.material)
            build.connect("OO", material_uids[mesh.material], uid)
        elif material_uids:
            doc.warn(f"{label} names material {mesh.material}, which is not in "
                     "the material table")

    for _ in range(children):
        _walk(cursor, build, scene, doc, material_uids, uid, depth + 1,
              load_arrays=load_arrays)


def _geometry(mesh: _Mesh, label: str, build: _Builder, model_uid: int) -> None:
    """One mesh node as the Geometry record an FBX file holds."""
    children = [
        _node("Vertices", [_array("d", mesh.positions, mesh.vertices * 3)]),
        _node("PolygonVertexIndex", [_array("i", mesh.polygons, mesh.indices)]),
        _node("GeometryVersion", [_i(124)]),
        _node("LayerElementNormal", [_i(0)], [
            _node("Version", [_i(101)]),
            _node("MappingInformationType", [_s("ByVertice")]),
            _node("ReferenceInformationType", [_s("Direct")]),
            _node("Normals", [_array("d", mesh.normals, mesh.vertices * 3)]),
        ]),
        _node("LayerElementUV", [_i(0)], [
            _node("Version", [_i(101)]),
            _node("Name", [_s("map1")]),
            _node("MappingInformationType", [_s("ByVertice")]),
            _node("ReferenceInformationType", [_s("Direct")]),
            _node("UV", [_array("d", mesh.uvs, mesh.vertices * 2)]),
        ]),
        # One mesh wears one material, which is the whole of what the game
        # allows: a part that needs two is two parts.
        _node("LayerElementMaterial", [_i(0)], [
            _node("Version", [_i(101)]),
            _node("MappingInformationType", [_s("AllSame")]),
            _node("ReferenceInformationType", [_s("IndexToDirect")]),
            _node("Materials", [_array("i", [0] if mesh.polygons is not None
                                       else None, 1)]),
        ]),
        _node("Layer", [_i(0)], [_node("Version", [_i(100)])]),
    ]
    uid = build.uid()
    build.objects.append(
        _node("Geometry", [_l(uid), _s(f"{label}\x00\x01Geometry"), _s("Mesh")],
              children))
    build.connect("OO", uid, model_uid)


# ------------------------------------------------------------------ materials


def _material_records(materials: Sequence[_Material], texture_uids: dict[str, int],
                      build: _Builder, doc: Document, metals: list[int]) -> list[int]:
    """One Material record apiece, with the maps it wears linked to it."""
    uids: list[int] = []
    for index, material in enumerate(materials):
        uid = build.uid()
        uids.append(uid)

        # What comes back facing you.  The game's shaders spell a Schlick
        # Fresnel out in full: `fresnelC` at normal incidence rising to
        # `fresnelMaxLevel` at grazing, over `fresnelEXP`.  The first of those
        # is a reflectance, and it is written as one.
        facing = min(max(material.scalar("fresnelC", _DEFAULT_FRESNEL_C), 0.0), 1.0)
        alpha_mode = ("MASK" if material.alpha_tested
                      else _BLEND_MODES.get(material.blend, "OPAQUE"))
        metal = _metalness(facing, alpha_mode == "BLEND")
        if metal:
            metals[0] += 1
        # Split between the two halves of the surface the way every importer
        # here does: what is left of the diffuse once the metal has taken its
        # share, and a reflectance that is the dielectric's on that share and
        # the conductor's own on the rest.  A kn5 material has no colour of its
        # own — `txDiffuse` is the albedo, and `ksAmbient`/`ksDiffuse` weight
        # the ambient and direct halves of the game's own lighting rather than
        # tinting anything — so the colour being split is white.
        diffuse = 1.0 - metal
        specular = facing * (1.0 - metal) + metal
        props = [
            _p70("DiffuseColor", "Color", *(_d(diffuse) for _ in range(3))),
            _p70("SpecularColor", "Color", *(_d(specular) for _ in range(3))),
            _p70("Metallic", "Number", _d(metal)),
            _p70("ShininessExponent", "Number",
                 _d(max(material.scalar("ksSpecularEXP", 20.0), 0.0))),
            _p70("Opacity", "Number", _d(1.0)),
            _p70("AlphaMode", "KString", _s(alpha_mode)),
            _p70("ShaderName", "KString", _s(material.shader)),
        ]
        if material.alpha_tested:
            props.append(_p70("AlphaCutoff", "Number",
                              _d(material.scalar("ksAlphaRef", 0.5))))

        # What the surface gives off on its own.  `ksEmissive` is written as a
        # colour when it is one and as a single number when it is not.
        emissive = material.props.get("ksEmissive")
        if emissive is not None:
            colour = list(emissive[2]) if any(emissive[2]) else [emissive[0]] * 3
            props.append(_p70("EmissiveColor", "Color", *(_d(c) for c in colour)))
            props.append(_p70("EmissiveFactor", "Number", _d(1.0)))

        # Then everything the file said, under the name it said it with, so
        # that a shader parameter this reader has no FBX spelling for is still
        # there to be read.  A parameter that happens to be spelt like one of
        # the properties above is left alone rather than allowed to overwrite
        # what was read from it.
        written = {entry.value(0) for entry in props}
        for key, (a, b, c, d) in material.props.items():
            if key in written:
                continue
            if any(d):
                props.append(_p70(key, "Vector4D", *(_d(v) for v in d)))
            elif any(c):
                props.append(_p70(key, "Color", *(_d(v) for v in c)))
            elif any(b):
                props.append(_p70(key, "Vector2D", *(_d(v) for v in b)))
            else:
                props.append(_p70(key, "Number", _d(a)))

        build.objects.append(
            _node("Material", [_l(uid), _s(f"{material.name}\x00\x01Material"), _s("")], [
                _node("Version", [_i(102)]),
                _node("ShadingModel", [_s("phong")]),
                _node("Properties70", [], props),
            ])
        )

        seen: set[str] = set()
        for slot, _number, texture in material.slots:
            target = texture_uids.get(texture)
            if target is None or slot in seen:
                continue
            seen.add(slot)
            build.connect("OP", target, uid, _slot_property(slot, material.shader))
    return uids


def _texture_records(textures: Sequence[_Texture], named: Sequence[str],
                     build: _Builder) -> dict[str, int]:
    """One Texture and one Video per distinct image the file holds or names.

    The pair is shared rather than made afresh per material: a car's paint,
    its detail map and its normal map are worn by dozens of materials each,
    and copying eighty megabytes of DDS once per slot is not a description of
    anything.
    """
    uids: dict[str, int] = {}
    carried = {texture.name: texture for texture in textures}
    for name in list(carried) + [n for n in named if n and n not in carried]:
        if name in uids:
            continue
        texture_uid = build.uid()
        video_uid = build.uid()
        uids[name] = texture_uid
        build.objects.append(
            _node("Texture", [_l(texture_uid), _s(f"{name}\x00\x01Texture"), _s("")], [
                _node("Type", [_s("TextureVideoClip")]),
                _node("Version", [_i(202)]),
                _node("FileName", [_s(name)]),
                _node("RelativeFilename", [_s(name)]),
                _node("Properties70", [], [
                    # The game wraps every texture; nothing in the file says
                    # otherwise, and a tread that came back clamped would show.
                    _p70("WrapModeU", "enum", _i(0)),
                    _p70("WrapModeV", "enum", _i(0)),
                ]),
            ])
        )
        video_children = [
            _node("Type", [_s("Clip")]),
            _node("FileName", [_s(name)]),
            _node("RelativeFilename", [_s(name)]),
        ]
        held = carried.get(name)
        if held is not None and held.data:
            # Carried as a raw property, the way an embedded texture arrives in
            # an FBX file.
            video_children.append(_node("Content", [Property("R", held.data)]))
        build.objects.append(
            _node("Video", [_l(video_uid), _s(f"{name}\x00\x01Video"), _s("Clip")],
                  video_children))
        build.connect("OO", video_uid, texture_uid)
    return uids


# ----------------------------------------------------------------- the reader


def parse_kn5(
    data: bytes,
    *,
    path: str | None = None,
    load_arrays: bool = False,
) -> Document:
    """Parse an Assetto Corsa ``.kn5`` into a Document."""
    if not is_kn5(data):
        raise ParseError("not a kn5 file — it does not begin \"sc6969\"")

    doc = Document(root=Node(""), encoding="binary", format="kn5", path=path,
                   file_size=len(data))
    cursor = _Cursor(data)
    cursor.skip(6)
    version = cursor.i32()
    # From version 6 the header carries one more number, which every file seen
    # writes as zero and nothing reads.  It has to be stepped over all the same.
    extra = cursor.i32() if version > 5 else None
    if version not in (5, 6):
        doc.warn(f"kn5 version {version} — this reads 5 and 6")

    textures = _read_textures(cursor, doc)
    materials = _read_materials(cursor, doc)
    # A stripped file names its textures and holds none of them.  Carrying the
    # stand-in would paint the whole car with it.
    stripped = _placeholders(textures)
    held = [] if stripped else textures

    build = _Builder()
    named = [slot[2] for material in materials for slot in material.slots]
    texture_uids = _texture_records(held, named, build)
    #: How many materials reflect more facing you than a dielectric can.
    metals = [0]
    material_uids = _material_records(materials, texture_uids, build, doc, metals)

    scene = _Scene()
    _walk(cursor, build, scene, doc, material_uids, 0, 0, load_arrays=load_arrays)
    # Whether the geometry describes the surface its own normals describe.
    sound, against = scene.winding
    sampled = sound + against
    agreement = sound / sampled if sampled else 1.0
    scrambled = sampled >= _WINDING_MINIMUM and agreement < _WINDING_FLOOR
    encrypted = _encrypted_from(data)
    if encrypted is None and cursor.at != len(data):
        doc.warn(f"{len(data) - cursor.at} byte(s) past the end of the node tree "
                 "were not read")

    _assemble(doc, build, version)

    have = {texture.name for texture in held}
    missing = sorted({name for name in named if name and name not in have})
    doc.extra.update({
        "kn5_version": version,
        "header_extra": extra,
        "textures": len(textures),
        "placeholder_textures": len(textures) if stripped else 0,
        "texture_bytes": sum(texture.size for texture in held),
        "texture_formats": _formats(held),
        "missing_textures": missing,
        "materials": len(materials),
        "materials_used": len(scene.used_materials),
        "metals": metals[0],
        "shaders": sorted({material.shader for material in materials}),
        "nodes": scene.nodes,
        "meshes": scene.meshes,
        "skinned_meshes": scene.skinned,
        "bones": scene.bones,
        "inactive_nodes": scene.inactive,
        "hidden_meshes": scene.hidden,
        "vertices": scene.vertices,
        "triangles": scene.triangles,
        "tree_depth": scene.depth,
        "lods": scene.lods,
        "encrypted": encrypted is not None,
        "encrypted_from": encrypted,
        "winding_agreement": round(agreement, 4) if sampled else None,
        "scrambled": scrambled,
    })
    if encrypted is not None:
        doc.warn("this car is protected: it ends with Custom Shaders Patch's "
                 f"{_ENCRYPTED_MARKER.decode()} marker, and the "
                 f"{len(data) - encrypted:,} bytes before it are the model, "
                 "encrypted. What is in front of that has been spoiled to match — "
                 f"{agreement:.0%} of its triangles are wound against their own "
                 "normals and every texture is one stand-in image. The game "
                 "decrypts it; nothing here does. What is drawn is not the shape "
                 "that was modelled")
    elif scrambled:
        doc.warn(f"only {agreement:.0%} of this car's triangles are wound the way "
                 "their own normals point, where a sound one is all of them — this "
                 "car's geometry was spoiled before it was published, and what is "
                 "drawn from it is not the shape that was modelled")
    if stripped and encrypted is None:
        doc.warn(f"every one of the {len(textures)} entries in the texture table is "
                 "the same stand-in image — this car was published with its "
                 "textures stripped out, and they are not in the file under any "
                 "name it gives")
    elif missing and not stripped:
        doc.warn(f"{len(missing)} texture(s) are named by a material but not in "
                 "this file — a LOD or a skin reads them from the car's main "
                 f".kn5: {', '.join(missing[:6])}"
                 + (" …" if len(missing) > 6 else ""))
    if not scene.meshes:
        doc.warn("no meshes in this file")
    return doc


def _formats(textures: Sequence[_Texture]) -> dict[str, int]:
    """How many of each kind of image the file carries, by its own head."""
    counts: dict[str, int] = {}
    for texture in textures:
        head = texture.data[:4]
        if head == b"DDS ":
            name = "DDS"
        elif head[:4] == b"\x89PNG":
            name = "PNG"
        elif head[:3] == b"\xff\xd8\xff":
            name = "JPEG"
        elif head[:2] == b"BM":
            name = "BMP"
        else:
            name = "other"
        counts[name] = counts.get(name, 0) + 1
    return counts


def _assemble(doc: Document, build: _Builder, version: int) -> None:
    root = doc.root
    creator = f"Assetto Corsa kn5 version {version}"
    root.children.append(_node("FBXHeaderExtension", [], [
        _node("FBXVersion", [_i(7400)]),
        _node("Creator", [_s(creator)]),
    ]))
    root.children.append(_node("Creator", [_s(creator)]))
    root.children.append(_node("GlobalSettings", [], [
        _node("Version", [_i(1000)]),
        _node("Properties70", [], [
            # Right handed, Y up, in metres, with +Z towards the front of the
            # car — which leaves the third axis pointing at its left side.
            _node("P", [_s("UpAxis"), _s("int"), _s("Integer"), _s(""), _i(1)]),
            _node("P", [_s("UpAxisSign"), _s("int"), _s("Integer"), _s(""), _i(1)]),
            _node("P", [_s("FrontAxis"), _s("int"), _s("Integer"), _s(""), _i(2)]),
            _node("P", [_s("FrontAxisSign"), _s("int"), _s("Integer"), _s(""), _i(1)]),
            _node("P", [_s("CoordAxis"), _s("int"), _s("Integer"), _s(""), _i(0)]),
            _node("P", [_s("CoordAxisSign"), _s("int"), _s("Integer"), _s(""), _i(-1)]),
            _node("P", [_s("UnitScaleFactor"), _s("double"), _s("Number"), _s(""),
                        _d(100.0)]),
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
