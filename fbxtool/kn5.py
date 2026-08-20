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

Two things are turned round on the way in.  The file stores V negated — a
sampler's V is the value's negation, since the game measures downwards from
the top of a texture, as Direct3D does, and FBX measures upwards — so the
negation is undone, leaving V measured upwards in ``[0, 1]`` as the other
readers here write it.  And the transforms are Direct3D's row-major 4×4 with
the translation in the last row — which is the same sixteen numbers in the
same order as glTF's column-major matrix acting on column vectors, so they
decompose identically.

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

import json
import math
import os
import re
import struct
import zlib
from typing import Sequence

from . import acshaders
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

#: The kn5 texture slots that mean something to an FBX material.  Every other
#: slot keeps the name the game gives it, which is what carries it across: a
#: reader that knows the name finds the map, and one that does not sees a
#: texture hung off a property it can ignore.
_SLOT_PROPERTIES = {
    "txDiffuse": "DiffuseColor",
    "txNormal": "NormalMap",
    # Heat in a brake disc rather than a surface that gives off light.  Kept as
    # an emissive because that is the only slot an FBX has for it, and because
    # the level beside it — nought on every material counted, since the game
    # writes it per frame — is what ought to dim it.
    "txGlow": "EmissiveColor",
    # And a real emissive map, which `ksPerPixelMultiMap_AT_emissive` binds.
    "txEmissive": "EmissiveColor",
}


def _slot_property(slot: str, shader: str) -> str:
    """The FBX property a kn5 texture slot fills, under this shader.

    A slot with no FBX meaning keeps the name the game gives it: ``txMaps`` is
    not a metallic-roughness map however much it looks like one — its channels
    drive the game's own shader — and a map drawn from the wrong end is worse
    than one not drawn.

    Which slot means what is :mod:`fbxtool.acshaders`' question rather than this
    one's, and it is asked there: on the shaders that model a car being crashed
    ``txNormal`` is not the surface's own relief but the dents blended in as
    damage accumulates, and a car as saved has none — so drawn as relief it puts
    creases down the whole of a bonnet that has never been hit.
    """
    if acshaders.slot_role(slot, shader) == "damageNormal":
        return slot
    return _SLOT_PROPERTIES.get(slot, slot)



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
    whose reflectance an artist set high.  *facing* is what the surface
    actually returns at normal incidence — `fresnelC` held under its own
    ceiling, which is what :func:`_reflectance` settles — and that is the one
    number where the two kinds of surface cannot be confused: no dielectric
    reflects more than about 17% facing you, and no metal less than about
    half.

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


def _reflectance(material: "_Material") -> float:
    """What a surface actually reflects facing you.

    ``fresnelC`` is the Schlick base and ``fresnelMaxLevel`` is a ceiling on
    the whole term — not the value at a grazing angle, which is what the pair
    reads like until you see the numbers.  A BMW Z3M's ``lightclear`` states
    1.0 and 0.03: read as a base it is a perfect mirror, and read as a ceiling
    it is the three per cent a clear lens reflects.  An Alfa TZ2's ``EXT_TYRE``
    settles it — it states 5.0, which is not a reflectance at all and can only
    be a number something clamps, beside a ceiling of 0.02.

    The two always travel together: of 1853 materials across the cars to hand,
    1075 state both and 778 state neither, and not one states only one of them.
    So reading the first without the second is reading half of a sentence, and
    it is the half that turns a tail lamp and a tyre into mirrors.

    The ceiling is below the base in 95 of them.  What is not modelled is the
    ceiling at a grazing angle: the viewer's own Schlick rises towards 1 at the
    edge where the game would hold it at ``fresnelMaxLevel``, which is a
    brighter rim than the game draws and nothing like the difference between a
    lens and a mirror.
    """
    return acshaders.reflectance(material.scalar)




def _light_weight(material: "_Material") -> float:
    """How much of the light a material takes, against a plainly lit one.

    ``ksAmbient`` and ``ksDiffuse`` weight the two halves of the game's own
    lighting rather than tinting anything.  Both halves are diffuse, so in a
    viewer with one fixed light the two weights have nowhere to go but the
    albedo, where they are the same arithmetic: dimming the light that reaches
    a surface and dimming the surface come to the same picture.

    This is the whole of why an Audi S8 comes up white from end to end.  Its
    paint is 0.4 and 0.4 and its wheels are 0.03 and 0.01; its headlight
    housings are nothing at all.  The pictures under those are grey panel maps
    — the colour was never in the picture — so read without the weights the
    rims, the lamps and the carbon mirror caps all draw as bright as the body,
    and the body draws brighter than the game ever shows it.

    A quarter of them ask for more light than a plainly lit surface gets, which
    a dashboard or a lamp lens does on purpose.  A diffuse surface cannot
    return more than it was given, so that is where this stops.
    """
    return acshaders.light_weight(material.scalar)


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
        # A slot of kind nought is an empty one, and is the whole of the
        # record: no name, no length, no bytes.
        #
        # Three of the 125 cars to hand open with one — a 53 MB Forester, a
        # 313 MB Citroën and a 388 MB Renault — and read as though it were a
        # texture it takes the next entry's kind for a name length and walks
        # off the table four bytes in.  All three were refused as damaged at
        # byte 27, which is a whole car turned away over an empty slot.
        #
        # Counted, since the table says how many entries it has and this is
        # one of them; kept out of what is handed on, since a texture with no
        # name is not one anything can ask for.
        if kind == 0:
            continue
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
        # The file stores V negated: the sampler's V is the value's negation
        # (the game measures down from the top of the texture and FBX up, so
        # the two are each other's mirror).  Undoing the negation leaves V
        # measured upwards in [0, 1], which is what every other reader here
        # writes.
        uvs[index * 2:index * 2 + 2] = (u, -v)
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


#: How many skin folders are looked in before the rest are counted and left.
_SKIN_LIMIT = 64


#: Which materials a config calls the car's paint.  Two spellings for the one
#: thing, and a car uses whichever its author did: ``CarPaintMaterial`` on its
#: own, and ``Materials`` inside a ``[Material_CarPaint_*]`` section — the
#: second only there, since half the sections in the file use that key.
_PAINT_SECTION = re.compile(r"^[ 	]*" + re.escape("[") + r"([^]]*)")
_PAINT_KEY = re.compile(r"^[ 	]*(CarPaintMaterial|Materials)[ 	]*=([^;]*)", re.I)


def _paint_materials(text: str) -> list[str]:
    """The materials a config names as paint, in the order it names them.

    The order is what pairs them with the colours.  Everything else in the file
    is includes of things that live inside Custom Shaders Patch rather than
    beside the car, and is left where it is.
    """
    out: list[str] = []
    section = ""
    for line in text.splitlines():
        heading = _PAINT_SECTION.match(line)
        if heading:
            section = heading.group(1)
            continue
        setting = _PAINT_KEY.match(line)
        if setting is None:
            continue
        if (setting.group(1).lower() != "carpaintmaterial"
                and not section.lower().startswith("material_carpaint")):
            continue
        for name in setting.group(2).split(","):
            if name.strip() and name.strip() not in out:
                out.append(name.strip())
    return out


def _read(path: str) -> str | None:
    try:
        with open(path, encoding="utf-8", errors="replace") as handle:
            return handle.read()
    except OSError:
        return None


def _read_bytes(path: str) -> bytes | None:
    try:
        with open(path, "rb") as handle:
            return handle.read()
    except OSError:
        return None


def _unset(colour: str) -> bool:
    """Whether a colour is one a picker nobody opened was left holding.

    Plain white is the one Content Manager opens at.  Black is the other, and
    it arrives spelt several ways — 000000, 020202, 040505, 070707 — so the
    test is that no channel rises above 8, which no eye can tell from black
    anyway.  The darkest colour any car here actually states is 00030F, a
    Porsche 928's Dark Blue, so nothing real falls in the gap.

    *colour* is six lowercase hex digits, no leading hash.
    """
    if colour == "ffffff":
        return True
    return max(int(colour[at:at + 2], 16) for at in (0, 2, 4)) <= 8


def _paint_colours(text: str) -> list[str]:
    """Every colour Content Manager's ``cm_skin.json`` states, in order.

    One car calls its paint ``carPaint`` and another ``extBody1``, ``extBody2``
    and ``extRims1``; a Renault 5 states three and its config names three
    materials to match, in the same order and with the names corroborating.  A
    section carrying no colour is not a paint — the same file holds the carpet,
    the interior and the driver's suit.

    ``enabled`` is the paint shop's own switch, and reading it as *this paint
    is not on the car* throws away most of what the file says.  Of the 125 cars
    whose models read here, 77 skins state a colour with the switch off that
    the picker was never left holding, and not one of them brings the texture
    that colour could have been baked into instead: a Ford Escort Cosworth's
    Red says #7F0000 with the switch off and replaces nothing but its wheels
    and its number plate, and the car is red.  So a colour is the paint
    whichever way the switch is set.

    What the picker was left holding is the other way about, and that is
    settled by asking the chip rather than by trusting it.  Plain white is the
    colour Content Manager opens at: of the 138 skins here that say it with the
    switch off, 124 carry a chip that is plainly some other colour.  Black is
    the other, and it arrives spelt several ways — #000000, #020202, #040505,
    #070707 — so the test is that no channel rises above 8, which no eye can
    tell from black anyway, and the darkest colour any car here actually states
    is #00030F.  Where the car really is black its chip says black too; where
    it is not, as with a Scirocco's twelve and a Skoda's White, the chip is the
    red or blue or silver its own preview shows.  Every one of those 170 skins
    carries a chip, so handing the question over never loses the answer.
    """
    try:
        data = json.loads(text)
    except ValueError:
        return []
    if not isinstance(data, dict):
        return []
    out: list[str] = []
    for value in data.values():
        if not isinstance(value, dict) or "color" not in value:
            continue
        colour = str(value.get("color") or "").lstrip("#")
        if len(colour) == 8:
            colour = colour[2:]
        if (len(colour) != 6
                or any(c not in "0123456789abcdefABCDEF" for c in colour)
                or (value.get("enabled") is False and _unset(colour.lower()))):
            out.append("")
            continue
        out.append(f"#{colour.lower()}")
    return out


_CONFIG_KEY = re.compile(r"^[ \t]*([A-Za-z]+)[ \t]*=([^;]*)")


def _config_colours(text: str, name: str) -> list[str]:
    """The colours a skin's own config states, for the ones with no JSON.

    A chameleon paint is two: ``ChameleonColorA`` facing you and
    ``ChameleonColorB`` at a grazing angle, each with an opacity after it.
    Only the first is taken — there is one albedo here, and A is what the car
    looks like from where you are standing.  A Clio V6's Illiad Blue is
    ``#33007f`` turning to yellow at the edges, and read without it the car is
    white.

    A section that names the skins it is for is only for those: one folder's
    config can carry a block written for another.
    """
    out: list[str] = []
    section = ""
    mine = True
    for line in text.splitlines():
        heading = _PAINT_SECTION.match(line)
        if heading:
            section, mine = heading.group(1), True
            continue
        if not section.lower().startswith("material_carpaint"):
            continue
        setting = _CONFIG_KEY.match(line)
        if setting is None:
            continue
        key, value = setting.group(1).lower(), setting.group(2).strip()
        if key == "skins":
            mine = any(part.strip().lower() == name.lower()
                       for part in value.split(","))
        elif key == "chameleoncolora" and mine:
            colour = value.split(",")[0].strip().lstrip("#")
            if len(colour) == 6 and all(c in "0123456789abcdefABCDEF" for c in colour):
                out.append(f"#{colour.lower()}")
    return out


#: An eight-bit PNG, truecolour with an alpha channel or without, written in
#: one pass.  184 of the 189 paint chips to hand are one of those two; the
#: other five are a palette and four interlaced, and are left unread rather
#: than half-read.
_PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
_PNG_CHANNELS = {2: 3, 6: 4}


def _png_pixels(data: bytes) -> tuple[bytearray, int, int] | None:
    """The RGBA of a PNG, top row first, or None for one this does not read."""
    if not data.startswith(_PNG_MAGIC):
        return None
    at = len(_PNG_MAGIC)
    width = height = channels = 0
    parts: list[bytes] = []
    while at + 8 <= len(data):
        length = int.from_bytes(data[at:at + 4], "big")
        kind = data[at + 4:at + 8]
        body = data[at + 8:at + 8 + length]
        if len(body) < length:
            return None
        at += 12 + length                       # length, tag, body, CRC
        if kind == b"IHDR":
            if length < 13:
                return None
            width = int.from_bytes(body[0:4], "big")
            height = int.from_bytes(body[4:8], "big")
            depth, colour, _compression, _filter, interlace = body[8:13]
            if depth != 8 or interlace or colour not in _PNG_CHANNELS:
                return None
            channels = _PNG_CHANNELS[colour]
        elif kind == b"IDAT":
            parts.append(body)
        elif kind == b"IEND":
            break
    if not width or not height or not channels or not parts:
        return None
    if width * height > 1 << 24:
        return None
    stride = width * channels
    # Exactly one filter byte and one row per scanline; anything more in the
    # stream is a bomb hiding behind a small declared picture, and
    # `zlib.decompress` would happily build all of it first.
    expected = (stride + 1) * height
    try:
        inflater = zlib.decompressobj()
        raw = inflater.decompress(b"".join(parts), expected)
    except zlib.error:
        return None
    if inflater.unconsumed_tail or not inflater.eof or len(raw) != expected:
        return None
    # Undo the per-row filters.  Each row states its own, and every one of them
    # is written against the row above and the pixel to the left.
    out = bytearray(stride * height)
    at = 0
    for y in range(height):
        kind = raw[at]
        at += 1
        line = raw[at:at + stride]
        at += stride
        row = y * stride
        prior = row - stride
        for i in range(stride):
            left = out[row + i - channels] if i >= channels else 0
            up = out[prior + i] if y else 0
            upleft = out[prior + i - channels] if y and i >= channels else 0
            value = line[i]
            if kind == 1:
                value += left
            elif kind == 2:
                value += up
            elif kind == 3:
                value += (left + up) >> 1
            elif kind == 4:
                guess = left + up - upleft
                a, b, c = abs(guess - left), abs(guess - up), abs(guess - upleft)
                value += left if a <= b and a <= c else (up if b <= c else upleft)
            elif kind:
                return None
            out[row + i] = value & 0xFF
    if channels == 4:
        return out, width, height
    rgba = bytearray(width * height * 4)
    for i in range(width * height):
        rgba[4 * i:4 * i + 3] = out[3 * i:3 * i + 3]
        rgba[4 * i + 3] = 255
    return rgba, width, height


def _chip_colour(data: bytes) -> str:
    """The colour of the paint chip a skin carries a picture of.

    ``livery.png`` is the swatch Content Manager shows beside a skin's name: a
    rounded square of the paint with a gloss sweeping over it, sixty-four
    pixels square, and every one of the 189 skins to hand has one.  It is a
    picture rather than a statement, so it is read last and only where nothing
    was stated — but read, it is exact.  A Champagne Quartz chip is 1874 pixels
    of #565D6B and its ``cm_skin.json`` says #565D6B.

    Two things make a plain average the wrong reading.  The gloss is a wide
    bright sweep, and under some of them is a band of dark reflection — a
    Renault 5's Blanc Perle chip is white over black, and averaged it is a
    mid-grey nobody painted.  So this takes the commonest colour rather than
    the mean, over the upper half where the paint is: colours are gathered into
    32 steps a channel, the fullest bucket wins, and what is returned is the
    average of what fell in it, which for a flat chip is the one colour it is
    drawn in, to the unit.
    """
    read = _png_pixels(data)
    if read is None:
        return ""
    pixels, width, height = read
    # A big picture is sampled rather than counted: a few cars carry the whole
    # livery sheet here instead of a chip, at two thousand pixels square.
    step = max(1, -(-max(width, height) // 256))
    buckets: dict[int, list[int]] = {}
    best: list[int] | None = None
    for y in range(0, max(1, round(height / 2)), step):
        for x in range(0, width, step):
            at = (y * width + x) * 4
            # A transparent corner is the chip's rounding, not a colour it is.
            if pixels[at + 3] < 128:
                continue
            r, g, b = pixels[at], pixels[at + 1], pixels[at + 2]
            key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3)
            bucket = buckets.get(key)
            if bucket is None:
                bucket = [0, 0, 0, 0]
                buckets[key] = bucket
            bucket[0] += r
            bucket[1] += g
            bucket[2] += b
            bucket[3] += 1
            if best is None or bucket[3] > best[3]:
                best = bucket
    if best is None:
        return ""
    return "#" + "".join(f"{round(c / best[3]):02x}" for c in best[:3])


def _skin_states(folder: str) -> tuple[list[str], list[str]]:
    """What one skin says: the materials it calls the paint, and the colours.

    Two files, both the skin's own, so a car and the folder it came in are
    enough — nothing here needs the game installed.
    """
    config = _read(os.path.join(folder, "ext_config.ini")) or ""
    meta = _read(os.path.join(folder, "cm_skin.json"))
    colours = _paint_colours(meta) if meta else []
    # Half of them have no `cm_skin.json` at all and say it in their config.
    if not any(colours):
        colours = _config_colours(config, os.path.basename(folder.rstrip("/" + chr(92))))
    return _paint_materials(config), colours


def _slot_names(text: str) -> list[str]:
    """What the paint shop filed each colour under, in the order it states them.

    The same walk `_paint_colours` makes and the same sections, so the two
    lists line up entry for entry and can be read together.
    """
    try:
        data = json.loads(text)
    except ValueError:
        return []
    if not isinstance(data, dict):
        return []
    return [str(key) for key, value in data.items()
            if isinstance(value, dict) and "color" in value]


def _slot_materials(text: str, materials: set[str]) -> list[str]:
    """The materials a paint shop's own slot names reach, for a car naming none.

    Three quarters of the cars here say which material the paint is, in a
    config beside the skin or beside the car.  The rest say it nowhere, and a
    Lamborghini LM002's fourteen skins are the shape of it: every one states
    its colour in ``cm_skin.json`` and not one of them, nor the car, carries an
    ``ext_config.ini`` at all.  Read for names alone the folder is silent and
    fourteen good colours go nowhere.

    What is left is the name the paint shop filed the colour under.  Content
    Manager opens ``carPaint`` on a car that has told it nothing, and the
    material the car actually wears is that name and a number: this one has
    ``carPaint02`` over its doors and hood and ``carPaint03`` over its four
    wheel-arch extenders, and the one stated colour belongs on both.

    Only a number, though.  The same car has ``carPaint_010101FF``, which is a
    side-marker trim wearing its own colour in its own name — the author's
    convention, and five materials here follow it.  A slot name reaching that
    would paint a black trim in body colour, so the tail has to be digits and
    nothing else.
    """
    out: list[str] = []
    for slot in _slot_names(text):
        low = slot.lower()
        for material in sorted(materials):
            if material == low:
                tail = ""
            elif material.startswith(low):
                tail = material[len(low):].lstrip("_-. ")
            else:
                continue
            if tail and not tail.isdigit():
                continue
            if material not in out:
                out.append(material)
    return out


def _pair(named: list[str], colours: list[str], materials: set[str]) -> list[dict]:
    """Which of the car's materials wear which of a skin's colours.

    One colour is the car's, however many materials the paint is spread over:
    a Clio V6 names ``wccarbody`` and ``aleron`` — its body and its spoiler —
    and states the one colour for both.  Several are paired by order, which is
    the only thing the two lists share.
    """
    out = []
    for at, material in enumerate(named):
        colour = colours[0] if len(colours) == 1 else (
            colours[at] if at < len(colours) else "")
        if colour and material.lower() in materials:
            out.append({"material": material, "colour": colour})
    return out


#: Words that mark a material as some other part of the car than its paint —
#: the vocabulary its wheels, brakes, glass and cabin actually carry.
#: ``CarPaintMaterial`` has been seen naming one of these by mistake: a
#: Ferrari Mondial's own ``extension/ext_config.ini`` names ``EXT_RIM_AO``,
#: the ambient occlusion baked into its wheel rims, and every one of its
#: twelve skins comes up unpainted for it — nothing wrong with the file, the
#: file just says the wrong thing.
#:
#: Matched whole, not as a substring: a Honda Prelude's own
#: ``remap__prim_env_19_spec_`` is not a rim for containing "rim" — that is
#: the middle of "prim" — and reading it as one is worse than missing it.
_NOT_PAINT_WORDS = {
    "rim", "wheel", "tyre", "tire", "brake", "caliper", "disc", "glass",
    "lens", "chrome", "light", "lamp", "mirror", "interior", "seat",
    "carpet", "dash", "leather", "steer", "pedal", "gauge", "plastic",
    "plate", "exhaust", "badge", "logo",
}

#: A material name split into its words — on punctuation, digits and the
#: casing itself, so ``EXT_RIM_AO`` and ``ExtRimAo`` come apart the same way.
_WORD_SPLIT = re.compile(r"[^A-Za-z]+")
_CAMEL_SPLIT = re.compile(r"(?<=[a-z])(?=[A-Z])")


def _words(name: str) -> set[str]:
    out: set[str] = set()
    for chunk in _WORD_SPLIT.split(name):
        if chunk:
            out.update(word.lower() for word in _CAMEL_SPLIT.sub(" ", chunk).split())
    return out


#: And what a car's paint is usually called, when it is named at all.  Takes
#: precedence over `_NOT_PAINT_WORDS`: a material naming its own paintwork
#: wins even where it also happens to carry one of the other words.  Matched
#: as a substring rather than a whole word — unlike the wheel-and-cabin
#: vocabulary above, nothing in a car's own parts happens to contain "paint".
_IS_PAINT = re.compile(r"body.?paint|car.?paint|paint|ext.?body|wc.?body|bodywork", re.I)


def _suspect_paint(name: str) -> bool:
    """Whether a material named as the car's paint reads like some other part."""
    if _IS_PAINT.search(name):
        return False
    words = _words(name)
    return any(word in _NOT_PAINT_WORDS or (word.endswith("s") and word[:-1] in _NOT_PAINT_WORDS)
               for word in words)


def _paint_correction(stated: list[str], materials: set[str],
                       casing: dict[str, str]) -> list[str] | None:
    """The car's own material to use instead, where *stated* reads wrong.

    Only where every material *stated* names reads like a wheel, a brake, a
    lamp or the cabin rather than paint — a config naming several materials is
    taken at its word otherwise, since a real paint spread over several parts
    names one that is not obviously paint far more often than a genuine
    mismatch does.

    And only where the car's own materials name exactly one thing that reads
    like paint and is not the same kind of mistake itself.  More than one such
    material is not chosen among: the one thing this is sure of is that
    *stated* is probably wrong, and a wrong guess dressed as a correction is
    worse than none.  *materials* is every material name the car has,
    lowercased; *casing* gets a lowered name back to how the file spelled it.
    """
    if not stated or not all(_suspect_paint(name) for name in stated):
        return None
    candidates = sorted(name for name in materials
                        if _IS_PAINT.search(name) and not _suspect_paint(name))
    if len(candidates) != 1:
        return None
    found = candidates[0]
    return [casing.get(found, found)]


#: A Custom Shaders Patch lamp block, and the two things wanted out of it.
_LAMP_SECTION = re.compile(r"^\s*\[(REFRACTING_HEADLIGHT[^\]]*)\]")
_LAMP_KEY = re.compile(r"^[ \t]*(SURFACE|GLASS_COLOR|EXTRA_GLASS_COLORIZATION)"
                       r"[ \t]*=([^;\n]*)", re.IGNORECASE)


def _lens_colours(text: str) -> dict[str, str]:
    """What colour each lamp lens is, out of a car's own lighting config.

    A car's glass is one grey picture however many lamps wear it — a Renault 5
    has nine materials sharing one 32-pixel square of `rgba(52, 60, 61, 47)`,
    told apart only by the normal map moulding each pattern.  What makes its
    fog lamps yellow and its indicators amber is stated beside the model
    instead, in the blocks Custom Shaders Patch reads to simulate a lamp:

        [REFRACTING_HEADLIGHT_...]
        SURFACE = glass_fog
        GLASS_COLOR = 1, 0.80723137, 0.12472421

    Eighteen of them on that car, naming a mesh apiece and giving it a tint —
    amber for the four indicators, red for the tail lamps, yellow for the fog
    lamps and a plain quarter-grey for the headlights.  Read without them every
    lamp on the car is the same colourless glass, which is what the file holds
    and not what anybody has ever seen the car as.

    `SURFACE` names a *mesh* rather than a material, and the two do not line
    up: this car's `glass_fog` mesh wears the material its `glass_platelight`
    mesh wears, and the two are given different colours.  So the tint belongs
    to the part.

    A block that turns the colouring off is taken at its word.
    """
    out: dict[str, str] = {}
    section = ""
    surfaces: list[str] = []
    colour = ""
    enabled = True

    def close() -> None:
        if colour and enabled:
            for name in surfaces:
                out.setdefault(name.lower(), colour)

    for line in text.splitlines():
        heading = _LAMP_SECTION.match(line)
        if heading or line.lstrip().startswith("["):
            close()
            section = heading.group(1) if heading else ""
            surfaces, colour, enabled = [], "", True
            continue
        if not section:
            continue
        setting = _LAMP_KEY.match(line)
        if setting is None:
            continue
        key, value = setting.group(1).upper(), setting.group(2).strip()
        if key == "SURFACE":
            surfaces = [n.strip() for n in value.split(",") if n.strip()]
        elif key == "EXTRA_GLASS_COLORIZATION":
            enabled = value not in ("0", "0.0", "false", "False")
        else:
            parts = [p.strip() for p in value.split(",") if p.strip()]
            if len(parts) >= 3:
                try:
                    rgb = [min(max(float(p), 0.0), 1.0) for p in parts[:3]]
                except ValueError:
                    continue
                colour = "#" + "".join(f"{round(c * 255):02x}" for c in rgb)
    close()
    return out


def _lamps(path: str | None) -> dict[str, str]:
    """Every lens colour stated beside a car, from all of its config.

    A car's lighting lives in whichever files its author split it across —
    `ext_config.ini` pulls in a `lights.ini` beside it on this one — so the
    whole of the folder is read rather than the includes followed.  What they
    name that lives inside Custom Shaders Patch rather than beside the car is
    left where it is, as it is everywhere else here.
    """
    if path is None:
        return {}
    folder = os.path.join(os.path.dirname(os.path.abspath(path)), "extension")
    out: dict[str, str] = {}
    try:
        names = sorted(os.listdir(folder))
    except OSError:
        return {}
    for name in names:
        if not name.lower().endswith(".ini"):
            continue
        text = _read(os.path.join(folder, name))
        if text:
            for mesh, colour in _lens_colours(text).items():
                out.setdefault(mesh, colour)
    return out


def _base_pictures(materials: Sequence["_Material"]) -> dict[str, str]:
    """Which picture each material wears, by name, both lowercased.

    The base colour alone: a skin replacing a material's normal map has not
    painted it, and a skin replacing the picture the colour is in has.
    """
    out: dict[str, str] = {}
    for material in materials:
        out[material.name.lower()] = ""
        for slot, _number, texture in material.slots:
            if slot == "txDiffuse" and texture:
                out[material.name.lower()] = texture.lower()
                break
    return out


def _skins(path: str | None, named: set[str], pictures: dict[str, str],
           casing: dict[str, str]) -> list[dict]:
    """The paint jobs sitting beside a car, and how much of each one it wears.

    A kn5 carries one set of textures and the game puts another over the top
    before it draws: every file under ``skins/<name>/`` replaces the texture of
    that name for as long as the skin is chosen.  So what is *in* the file is
    the car unpainted.  An Audi S8's own textures are ambient occlusion over
    bare grey, and its thirteen skins are what make it Alpine White or Sakhir
    Orange; five cars to hand all have them, replacing between 2 and 15
    textures apiece.

    A car that comes up pale, then, is not necessarily one that was read
    wrongly — it may be one nobody has painted yet, and that is worth saying
    out loud rather than leaving to look like a fault.
    """
    if path is None:
        return []
    materials = set(pictures)
    beside = os.path.dirname(os.path.abspath(path))
    # Half of them declare which material is the paint once for the whole car
    # rather than once per skin, and that is the file it goes in.
    fallback = _paint_materials(
        _read(os.path.join(beside, "extension", "ext_config.ini")) or "")
    folder = os.path.join(beside, "skins")
    try:
        entries = sorted(os.listdir(folder))[:_SKIN_LIMIT]
    except OSError:
        return []
    out: list[dict] = []
    for name in entries:
        inside = os.path.join(folder, name)
        try:
            files = {entry.lower() for entry in os.listdir(inside)}
        except OSError:
            continue
        stated, colours = _skin_states(inside)
        out.append({"name": name, "replaces": len(files & named),
                    "stated": stated, "colours": colours, "files": files,
                    "meta": _read(os.path.join(inside, "cm_skin.json")) or ""})

    # What the car's paint is called, settled across the whole folder.  Three
    # places say so, in the order they are trusted: the skin's own config; the
    # car's, since half of them declare it once for the whole car; and last
    # what the car's *other* skins agree it is.
    #
    # That last is a reading of the folder rather than of one file, and it is
    # what a folder of skins usually needs.  An Audi S8 has thirteen: three
    # name `booody_aooo`, which the car has, and five name `carpaint`, which it
    # has not — configs copied from another car, colour and all.  Left there,
    # those five state a perfectly good colour and put it nowhere.  Only a skin
    # naming nothing the car has is answered this way, and only from names its
    # own siblings used.
    known: list[str] = []
    for skin in out:
        for name in skin["stated"]:
            if name.lower() in materials and name not in known:
                known.append(name)
    for skin in out:
        stated = [n for n in skin.pop("stated") if n.lower() in materials]
        if not stated:
            stated = [n for n in fallback if n.lower() in materials] or known
        # And for a car that named the paint in none of those three, the name
        # the paint shop filed the colour under.  Weakest of the four, and last
        # for the same reason the chip is: a slot name is what Content Manager
        # opened at rather than anything the car said about itself.
        if not stated:
            stated = _slot_materials(skin["meta"], materials)
        # And whether what got settled on reads like the car's paint at all —
        # see `_paint_correction`.  Left as a note beside the skin rather than
        # swapped in ahead of `_pair`: what a config states is a fact about the
        # file, and this is only a guess at what was meant.
        if stated and all(_suspect_paint(name) for name in stated):
            skin["paint_suspect"] = {"stated": stated,
                                     "corrected": _paint_correction(stated, materials, casing)}
        skin.pop("meta")
        colours = skin.pop("colours")
        files = skin.pop("files")
        # And last, for the skins that came out of all that with nothing on
        # the car, the picture of the paint nearly all of them carry.
        #
        # Nothing painted rather than nothing stated: an Audi RS4's Nardo Grey
        # states two colours and neither is the body's — they are its wheels,
        # in slots the car pairs with nothing — and its body slot is the
        # untouched white that says nothing at all.  Asked whether the skin
        # stated anything it answers yes and the body goes unpainted, which is
        # the one thing the chip is there to prevent.
        #
        # Only where the skin does not bring the paint's own picture.  A skin
        # that replaces the very texture the paint material wears has put the
        # colour there already, and painting the chip over the top paints it
        # twice: a Lancia Beta Montecarlo's seven skins each replace the
        # `LANCIA_body.dds` that `lancia_body_paint` wears and say nothing
        # else at all, so read the other way round every one of its liveries
        # comes out under a flat wash of its own average.
        #
        # A chip is the weakest of the three readings and this is where it
        # stops: what the skin has already drawn beats a picture of a swatch.
        paints = _pair(stated, colours, materials)
        if not paints and not any(
                pictures.get(name.lower()) in files for name in stated):
            chip = _read_bytes(os.path.join(folder, skin["name"], "livery.png"))
            colour = _chip_colour(chip) if chip else ""
            if colour:
                paints = _pair(stated, [colour], materials)
        skin["paints"] = paints
    out.sort(key=lambda skin: (-skin["replaces"], skin["name"]))
    return out


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
                      build: _Builder, doc: Document, metals: list[int],
                      dimmed: list[int]) -> list[int]:
    """One Material record apiece, with the maps it wears linked to it."""
    uids: list[int] = []
    for index, material in enumerate(materials):
        uid = build.uid()
        uids.append(uid)

        # What comes back facing you.  The game's shaders spell a Schlick
        # Fresnel out in full — `fresnelC` as the base, rising over `fresnelEXP`
        # and held under `fresnelMaxLevel` — and the reflectance is what the
        # two of those come to, not what the first of them says alone.
        facing = _reflectance(material)
        alpha_mode = ("MASK" if material.alpha_tested
                      else _BLEND_MODES.get(material.blend, "OPAQUE"))
        metal = _metalness(facing, alpha_mode == "BLEND")
        if metal:
            metals[0] += 1
        # Split between the two halves of the surface the way every importer
        # here does: what is left of the diffuse once the metal has taken its
        # share, and a reflectance that is the dielectric's on that share and
        # the conductor's own on the rest.
        #
        # A kn5 material states no colour of its own — `txDiffuse` is the
        # albedo — but it does state how much of the light it takes, and that
        # is a greyscale the picture is read through.  So the colour being
        # split is that weight rather than white, and it multiplies the map
        # instead of standing in for one.
        weight = _light_weight(material)
        if weight < 0.999:
            dimmed[0] += 1
        diffuse = (1.0 - metal) * weight
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
            # And that the colour above is read through the picture rather
            # than replaced by it, which is the usual way round.  Everything a
            # kn5 states about a surface is stated for the whole of it and the
            # picture is the pattern, so the two multiply.
            _p70("TintsTexture", "Bool", _i(1)),
        ]
        # Where the surface is cut against its own alpha.
        #
        # A stated nought is not a threshold, it is a material that named none:
        # every alpha-tested material counted across the cars to hand states
        # `ksAlphaRef` as nought — all 20 of the `ksPerPixelAT` and all 17 of
        # the `ksPerPixelAT_NM` — and nought cuts nothing out, so a grille taken
        # at face value comes out a solid rectangle with the fence painted on
        # it.  The game has a default behind the number and so has this.  A
        # material that did state one keeps it.
        if material.alpha_tested:
            stated = material.scalar("ksAlphaRef", 0.0)
            props.append(_p70("AlphaCutoff", "Number",
                              _d(stated if stated > 0
                                 else acshaders.ALPHA_REF_DEFAULT)))

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
    #: And how many take less of the light than a plainly lit surface does.
    dimmed = [0]
    material_uids = _material_records(materials, texture_uids, build, doc,
                                      metals, dimmed)

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

    # And what colour each lamp lens is, which the model does not hold: it is
    # stated per mesh in the car's own lighting config, so it goes on the
    # record for that mesh rather than on the material it shares.
    lenses = _lamps(path)
    lit: set[str] = set()
    if lenses:
        for entry in build.objects:
            if entry.name != "Model":
                continue
            name = entry.value(1).split(chr(0))[0].lower()
            colour = lenses.get(name)
            if colour is None:
                continue
            rgb = [int(colour[at:at + 2], 16) / 255.0 for at in (1, 3, 5)]
            entry.path("Properties70").children.append(
                _p70("LensColour", "Color", *(_d(c) for c in rgb)))
            # Counted by name rather than by record: a lamp is often a mesh
            # inside a node of the same name, and it is one lens either way.
            lit.add(name)

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
        "dimmed": dimmed[0],
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
        "lenses": len(lit),
        "skins": _skins(path, {name.lower() for name in named if name},
                        _base_pictures(materials),
                        {material.name.lower(): material.name for material in materials}),
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
