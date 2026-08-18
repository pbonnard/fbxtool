"""Minimal writers for the formats the readers read, for known-good input.

These are deliberately small: they write exactly the structures the readers
need to be exercised against — typed properties, deflated arrays, nested
records, the null terminator and the footer for FBX, and for glTF the awkward
shapes a plain exporter never produces — not general-purpose exporters.
"""

from __future__ import annotations

import json
import math
import pathlib
import re
import gzip
import struct
import zlib

MAGIC = b"Kaydara FBX Binary  \x00\x1a\x00"
FOOTER_MAGIC = bytes(
    (0xF8, 0x5A, 0x8C, 0x6A, 0xDE, 0xF5, 0xD9, 0x7E,
     0xEC, 0xE9, 0x0C, 0xE3, 0x75, 0x8F, 0x29, 0x0B)
)


class Prop:
    """A single typed property."""

    def __init__(self, code: str, value) -> None:
        self.code = code
        self.value = value

    def encode(self) -> bytes:
        code, value = self.code, self.value
        if code == "Y":
            return b"Y" + struct.pack("<h", value)
        if code == "C":
            return b"C" + struct.pack("<?", value)
        if code == "I":
            return b"I" + struct.pack("<i", value)
        if code == "F":
            return b"F" + struct.pack("<f", value)
        if code == "D":
            return b"D" + struct.pack("<d", value)
        if code == "L":
            return b"L" + struct.pack("<q", value)
        if code == "S":
            data = value.encode("utf-8") if isinstance(value, str) else value
            return b"S" + struct.pack("<I", len(data)) + data
        if code == "R":
            return b"R" + struct.pack("<I", len(value)) + value
        raise ValueError(f"unhandled property code {code!r}")


class ArrayProp(Prop):
    """An array property, optionally deflated as real exporters do."""

    _FORMATS = {"f": "f", "d": "d", "l": "q", "i": "i", "b": "b"}

    def __init__(self, code: str, values, *, deflate: bool = False) -> None:
        super().__init__(code, list(values))
        self.deflate = deflate

    def encode(self) -> bytes:
        fmt = self._FORMATS[self.code]
        raw = struct.pack(f"<{len(self.value)}{fmt}", *self.value)
        payload = zlib.compress(raw) if self.deflate else raw
        header = struct.pack("<III", len(self.value), 1 if self.deflate else 0, len(payload))
        return self.code.encode("ascii") + header + payload


# Shorthand constructors.
def I(v): return Prop("I", v)          # noqa: E743 - matches the FBX type code
def D(v): return Prop("D", v)
def L(v): return Prop("L", v)
def S(v): return Prop("S", v)
def R(v): return Prop("R", v)
def C(v): return Prop("C", v)
def F(v): return Prop("F", v)
def Y(v): return Prop("Y", v)
def darr(v, deflate=False): return ArrayProp("d", v, deflate=deflate)
def iarr(v, deflate=False): return ArrayProp("i", v, deflate=deflate)


class N:
    """A node record: a name, properties and children."""

    def __init__(self, name: str, props=(), children=()) -> None:
        self.name = name
        self.props = list(props)
        self.children = list(children)

    def encode(self, start: int, wide: bool) -> bytes:
        header_size = 24 if wide else 12
        fmt = "<QQQ" if wide else "<III"
        name = self.name.encode("utf-8")
        props = b"".join(prop.encode() for prop in self.props)

        pos = start + header_size + 1 + len(name) + len(props)
        body = b""
        for child in self.children:
            chunk = child.encode(pos, wide)
            body += chunk
            pos += len(chunk)
        if self.children:
            body += b"\x00" * (header_size + 1)
            pos += header_size + 1

        header = struct.pack(fmt, pos, len(self.props), len(props))
        return header + bytes([len(name)]) + name + props + body


def build_binary(nodes, version: int = 7400) -> bytes:
    """Serialise top-level *nodes* into a complete binary FBX file."""
    wide = version >= 7500
    header_size = 24 if wide else 12

    out = bytearray(MAGIC + struct.pack("<I", version))
    for node in nodes:
        out += node.encode(len(out), wide)
    out += b"\x00" * (header_size + 1)  # top-level terminator

    out += b"\x00" * 16                 # file id placeholder
    while len(out) % 16:                # exporters pad to a 16-byte boundary
        out += b"\x00"
    out += b"\x00" * 4
    out += struct.pack("<I", version)
    out += b"\x00" * 120
    out += FOOTER_MAGIC
    return bytes(out)


#: A unit cube centred on the origin, reaching ±1 along every axis.
CUBE_VERTICES = [
    -1.0, -1.0, 1.0, 1.0, -1.0, 1.0, -1.0, 1.0, 1.0, 1.0, 1.0, 1.0,
    -1.0, 1.0, -1.0, 1.0, 1.0, -1.0, -1.0, -1.0, -1.0, 1.0, -1.0, -1.0,
]
CUBE_POLYGONS = [0, 1, 3, -3, 2, 3, 5, -5, 4, 5, 7, -7, 6, 7, 1, -1,
                 1, 7, 5, -4, 6, 0, 2, -5]


def cube_nodes(version: int = 7400, *, deflate: bool = True) -> list[N]:
    """A small but realistic scene: one mesh, one material, one texture."""
    geometry_uid, model_uid, material_uid, texture_uid = 1000, 2000, 3000, 4000

    vertices = CUBE_VERTICES
    polygons = CUBE_POLYGONS

    header = N("FBXHeaderExtension", [], [
        N("FBXHeaderExtensionVersion", [I(1003)]),
        N("FBXVersion", [I(version)]),
        N("EncryptionType", [I(0)]),
        N("CreationTimeStamp", [], [
            N("Version", [I(1000)]), N("Year", [I(2024)]), N("Month", [I(6)]),
            N("Day", [I(14)]), N("Hour", [I(9)]), N("Minute", [I(30)]),
            N("Second", [I(15)]), N("Millisecond", [I(250)]),
        ]),
        N("Creator", [S("fbxtool test fixture")]),
        N("SceneInfo", [S("GlobalInfo\x00\x01SceneInfo"), S("UserData")], [
            N("Type", [S("UserData")]),
            N("Version", [I(100)]),
            N("MetaData", [], [
                N("Version", [I(100)]),
                N("Title", [S("Test cube")]),
                N("Author", [S("fbxtool")]),
            ]),
            N("Properties70", [], [
                N("P", [S("DocumentUrl"), S("KString"), S("Url"), S(""),
                        S("/tmp/cube.fbx")]),
                N("P", [S("Original|ApplicationName"), S("KString"), S(""), S(""),
                        S("Maya")]),
                N("P", [S("Original|ApplicationVersion"), S("KString"), S(""), S(""),
                        S("2024")]),
                N("P", [S("Original|ApplicationVendor"), S("KString"), S(""), S(""),
                        S("Autodesk")]),
                N("P", [S("LastSaved|ApplicationName"), S("KString"), S(""), S(""),
                        S("fbxtool")]),
            ]),
        ]),
    ])

    global_settings = N("GlobalSettings", [], [
        N("Version", [I(1000)]),
        N("Properties70", [], [
            N("P", [S("UpAxis"), S("int"), S("Integer"), S(""), I(1)]),
            N("P", [S("UpAxisSign"), S("int"), S("Integer"), S(""), I(1)]),
            N("P", [S("FrontAxis"), S("int"), S("Integer"), S(""), I(2)]),
            N("P", [S("FrontAxisSign"), S("int"), S("Integer"), S(""), I(1)]),
            N("P", [S("CoordAxis"), S("int"), S("Integer"), S(""), I(0)]),
            N("P", [S("CoordAxisSign"), S("int"), S("Integer"), S(""), I(1)]),
            N("P", [S("UnitScaleFactor"), S("double"), S("Number"), S(""), D(1.0)]),
            N("P", [S("OriginalUnitScaleFactor"), S("double"), S("Number"), S(""),
                    D(2.54)]),
            N("P", [S("TimeMode"), S("enum"), S(""), S(""), I(6)]),
            N("P", [S("TimeSpanStart"), S("KTime"), S("Time"), S(""), L(0)]),
            N("P", [S("TimeSpanStop"), S("KTime"), S("Time"), S(""),
                    L(46186158000 * 2)]),
        ]),
    ])

    definitions = N("Definitions", [], [
        N("Version", [I(100)]),
        N("Count", [I(5)]),  # four Objects entries plus GlobalSettings
        N("ObjectType", [S("GlobalSettings")], [N("Count", [I(1)])]),
        N("ObjectType", [S("Geometry")], [
            N("Count", [I(1)]),
            N("PropertyTemplate", [S("FbxMesh")], [
                N("Properties70", [], [
                    N("P", [S("Color"), S("ColorRGB"), S("Color"), S(""),
                            D(0.8), D(0.8), D(0.8)]),
                ]),
            ]),
        ]),
        N("ObjectType", [S("Model")], [N("Count", [I(1)])]),
        N("ObjectType", [S("Material")], [N("Count", [I(1)])]),
        N("ObjectType", [S("Texture")], [N("Count", [I(1)])]),
    ])

    objects = N("Objects", [], [
        N("Geometry", [L(geometry_uid), S("Geometry\x00\x01Geometry"), S("Mesh")], [
            N("Vertices", [darr(vertices, deflate=deflate)]),
            N("PolygonVertexIndex", [iarr(polygons, deflate=deflate)]),
            N("GeometryVersion", [I(124)]),
            N("LayerElementUV", [I(0)], [
                N("Version", [I(101)]),
                N("Name", [S("map1")]),
                N("MappingInformationType", [S("ByPolygonVertex")]),
            ]),
            N("Layer", [I(0)], [N("Version", [I(100)])]),
        ]),
        N("Model", [L(model_uid), S("pCube1\x00\x01Model"), S("Mesh")], [
            N("Version", [I(232)]),
            N("Properties70", [], [
                N("P", [S("Lcl Translation"), S("Lcl Translation"), S(""), S("A"),
                        D(0.0), D(1.0), D(0.0)]),
            ]),
            N("Shading", [C(True)]),
            N("Culling", [S("CullingOff")]),
        ]),
        N("Material", [L(material_uid), S("lambert1\x00\x01Material"), S("")], [
            N("Version", [I(102)]),
            N("ShadingModel", [S("lambert")]),
            N("MultiLayer", [I(0)]),
        ]),
        N("Texture", [L(texture_uid), S("file1\x00\x01Texture"), S("")], [
            N("Type", [S("TextureVideoClip")]),
            N("Version", [I(202)]),
            N("RelativeFilename", [S("textures/cube_diffuse.png")]),
        ]),
    ])

    connections = N("Connections", [], [
        N("C", [S("OO"), L(model_uid), L(0)]),
        N("C", [S("OO"), L(geometry_uid), L(model_uid)]),
        N("C", [S("OO"), L(material_uid), L(model_uid)]),
        N("C", [S("OP"), L(texture_uid), L(material_uid), S("DiffuseColor")]),
    ])

    return [
        header,
        N("FileId", [R(bytes(range(16)))]),
        N("CreationTime", [S("2024-06-14 09:30:15:250")]),
        N("Creator", [S("fbxtool test fixture")]),
        global_settings,
        definitions,
        objects,
        connections,
    ]


def build_cube(version: int = 7400, *, deflate: bool = True) -> bytes:
    """A complete binary FBX file containing the sample cube scene."""
    return build_binary(cube_nodes(version, deflate=deflate), version=version)


# --------------------------------------------------------------------------
# multi-part scene fixture


#: Where each part of :func:`scene_nodes` ends up, and how big the whole is.
#:
#: The three parts share one cube and are chained parent to child:
#:
#:   hub     identity                      -> -1..1 on every axis
#:   arm     child of hub,  T=(4,0,0) S=2  ->  x 2..6, y -2..2, z -2..2
#:   mirror  child of arm,  T=(0,0,3) S=(1,1,-1)
#:                                         ->  x 2..6, y -2..2, z  4..8
#:
#: so the assembled scene spans 7 x 4 x 10 units. The mirror's negative scale
#: also reverses its winding, which the renderer has to undo.
SCENE_SIZE = (7.0, 4.0, 10.0)
SCENE_PARTS = 3
SCENE_TRIANGLES = 36
#: The material colour comes from the Definitions template, not the materials.
SCENE_DIFFUSE = (0.8, 0.1, 0.05)


def scene_nodes(version: int = 7400, *, deflate: bool = True) -> list[N]:
    """A scene that only assembles correctly when transforms are honoured.

    One geometry is instanced by three models, each with its own placement, and
    one material shared by all three — so the render palette has three slots
    that are really a single material, which is what the material list has to
    group back together. The material carries no colour of its own; that comes
    from the ``PropertyTemplate`` in ``Definitions``.
    """
    geometry_uid = 1000
    hub_uid, arm_uid, mirror_uid = 2001, 2002, 2003
    shared_material = 3001
    materials = {hub_uid: shared_material, arm_uid: shared_material,
                 mirror_uid: shared_material}

    def model(uid: int, name: str, props: list[N]) -> N:
        return N("Model", [L(uid), S(f"{name}\x00\x01Model"), S("Mesh")], [
            N("Version", [I(232)]),
            N("Properties70", [], props),
            N("Shading", [C(True)]),
            N("Culling", [S("CullingOff")]),
        ])

    def lcl(name: str, x: float, y: float, z: float) -> N:
        return N("P", [S(f"Lcl {name}"), S(f"Lcl {name}"), S(""), S("A"),
                       D(x), D(y), D(z)])

    objects = N("Objects", [], [
        N("Geometry", [L(geometry_uid), S("part\x00\x01Geometry"), S("Mesh")], [
            N("Vertices", [darr(CUBE_VERTICES, deflate=deflate)]),
            N("PolygonVertexIndex", [iarr(CUBE_POLYGONS, deflate=deflate)]),
            N("GeometryVersion", [I(124)]),
            N("Layer", [I(0)], [N("Version", [I(100)])]),
        ]),
        model(hub_uid, "hub", []),
        model(arm_uid, "arm", [lcl("Translation", 4.0, 0.0, 0.0),
                               lcl("Scaling", 2.0, 2.0, 2.0)]),
        model(mirror_uid, "mirror", [lcl("Translation", 0.0, 0.0, 3.0),
                                     lcl("Scaling", 1.0, 1.0, -1.0)]),
        N("Material", [L(shared_material), S("paint\x00\x01Material"), S("")], [
            N("Version", [I(102)]),
            N("ShadingModel", [S("phong")]),
            N("MultiLayer", [I(0)]),
        ]),
    ])

    definitions = N("Definitions", [], [
        N("Version", [I(100)]),
        N("Count", [I(6)]),
        N("ObjectType", [S("GlobalSettings")], [N("Count", [I(1)])]),
        N("ObjectType", [S("Geometry")], [N("Count", [I(1)])]),
        N("ObjectType", [S("Model")], [N("Count", [I(3)])]),
        N("ObjectType", [S("Material")], [
            N("Count", [I(1)]),
            N("PropertyTemplate", [S("FbxSurfacePhong")], [
                N("Properties70", [], [
                    N("P", [S("DiffuseColor"), S("Color"), S(""), S("A"),
                            D(SCENE_DIFFUSE[0]), D(SCENE_DIFFUSE[1]),
                            D(SCENE_DIFFUSE[2])]),
                    N("P", [S("ShininessExponent"), S("Number"), S(""), S("A"),
                            D(20.0)]),
                ]),
            ]),
        ]),
    ])

    connections = N("Connections", [], [
        N("C", [S("OO"), L(hub_uid), L(0)]),
        # The chain the world matrices have to walk: mirror -> arm -> hub.
        N("C", [S("OO"), L(arm_uid), L(hub_uid)]),
        N("C", [S("OO"), L(mirror_uid), L(arm_uid)]),
        # One geometry, three models.
        *[N("C", [S("OO"), L(geometry_uid), L(uid)]) for uid in materials],
        *[N("C", [S("OO"), L(material_uid), L(model_uid)])
          for model_uid, material_uid in materials.items()],
    ])

    header = N("FBXHeaderExtension", [], [
        N("FBXHeaderExtensionVersion", [I(1003)]),
        N("FBXVersion", [I(version)]),
        N("EncryptionType", [I(0)]),
        N("Creator", [S("fbxtool test fixture")]),
    ])

    global_settings = N("GlobalSettings", [], [
        N("Version", [I(1000)]),
        N("Properties70", [], [
            N("P", [S("UpAxis"), S("int"), S("Integer"), S(""), I(1)]),
            N("P", [S("UpAxisSign"), S("int"), S("Integer"), S(""), I(1)]),
            N("P", [S("UnitScaleFactor"), S("double"), S("Number"), S(""), D(1.0)]),
        ]),
    ])

    return [header, N("Creator", [S("fbxtool test fixture")]),
            global_settings, definitions, objects, connections]


def build_scene(version: int = 7400, *, deflate: bool = True) -> bytes:
    """A complete binary FBX file holding the three-part scene."""
    return build_binary(scene_nodes(version, deflate=deflate), version=version)


#: A red cube inside a larger blue one that is mostly see-through, so the inner
#: cube can only appear on screen if transparency is actually drawn.
GLASS_OPACITY = 0.35
GLASS_INNER = (0.55, 0.02, 0.02)
GLASS_OUTER = (0.05, 0.10, 0.30)


def glass_nodes(version: int = 7400, *, deflate: bool = True) -> list[N]:
    """One mesh instanced twice: a solid core inside a transparent shell."""
    geometry_uid = 1000
    core_uid, shell_uid = 2001, 2002
    core_material, shell_material = 3001, 3002

    def model(uid: int, name: str, scale: float) -> N:
        return N("Model", [L(uid), S(f"{name}\x00\x01Model"), S("Mesh")], [
            N("Version", [I(232)]),
            N("Properties70", [], [
                N("P", [S("Lcl Scaling"), S("Lcl Scaling"), S(""), S("A"),
                        D(scale), D(scale), D(scale)]),
            ]),
        ])

    def material(uid: int, name: str, colour, opacity: float) -> N:
        props = [
            N("P", [S("DiffuseColor"), S("Color"), S(""), S("A"),
                    D(colour[0]), D(colour[1]), D(colour[2])]),
            N("P", [S("ShininessExponent"), S("Number"), S(""), S("A"), D(60.0)]),
        ]
        if opacity < 1.0:
            props += [
                N("P", [S("Opacity"), S("Number"), S(""), S("A"), D(opacity)]),
                N("P", [S("TransparencyFactor"), S("Number"), S(""), S("A"),
                        D(1.0 - opacity)]),
            ]
        return N("Material", [L(uid), S(f"{name}\x00\x01Material"), S("")], [
            N("Version", [I(102)]),
            N("ShadingModel", [S("phong")]),
            N("Properties70", [], props),
        ])

    objects = N("Objects", [], [
        N("Geometry", [L(geometry_uid), S("box\x00\x01Geometry"), S("Mesh")], [
            N("Vertices", [darr(CUBE_VERTICES, deflate=deflate)]),
            N("PolygonVertexIndex", [iarr(CUBE_POLYGONS, deflate=deflate)]),
            N("GeometryVersion", [I(124)]),
            N("Layer", [I(0)], [N("Version", [I(100)])]),
        ]),
        model(core_uid, "core", 1.0),
        model(shell_uid, "shell", 2.2),
        material(core_material, "paint", GLASS_INNER, 1.0),
        material(shell_material, "glass", GLASS_OUTER, GLASS_OPACITY),
    ])

    connections = N("Connections", [], [
        N("C", [S("OO"), L(core_uid), L(0)]),
        N("C", [S("OO"), L(shell_uid), L(0)]),
        N("C", [S("OO"), L(geometry_uid), L(core_uid)]),
        N("C", [S("OO"), L(geometry_uid), L(shell_uid)]),
        N("C", [S("OO"), L(core_material), L(core_uid)]),
        N("C", [S("OO"), L(shell_material), L(shell_uid)]),
    ])

    return [
        N("FBXHeaderExtension", [], [
            N("FBXHeaderExtensionVersion", [I(1003)]),
            N("FBXVersion", [I(version)]),
            N("Creator", [S("fbxtool test fixture")]),
        ]),
        N("Creator", [S("fbxtool test fixture")]),
        N("GlobalSettings", [], [
            N("Version", [I(1000)]),
            N("Properties70", [], [
                N("P", [S("UpAxis"), S("int"), S("Integer"), S(""), I(1)]),
                N("P", [S("UpAxisSign"), S("int"), S("Integer"), S(""), I(1)]),
            ]),
        ]),
        N("Definitions", [], [
            N("Version", [I(100)]),
            N("Count", [I(5)]),
            N("ObjectType", [S("Geometry")], [N("Count", [I(1)])]),
            N("ObjectType", [S("Model")], [N("Count", [I(2)])]),
            N("ObjectType", [S("Material")], [N("Count", [I(2)])]),
        ]),
        objects,
        connections,
    ]


def build_glass(version: int = 7400, *, deflate: bool = True) -> bytes:
    """A complete binary FBX file holding the glass-shell scene."""
    return build_binary(glass_nodes(version, deflate=deflate), version=version)


# --------------------------------------------------------------------------
# legacy 6.x fixture


#: The 6.x scene: two cubes, the second moved 5 along x and scaled by two, so
#: the pair spans -1..7 across and ±2 the other ways.
LEGACY_SIZE = (8.0, 4.0, 4.0)
LEGACY_PARTS = 2
LEGACY_TRIANGLES = 24
LEGACY_DIFFUSE = (0.1, 0.45, 0.8)


def legacy_nodes(version: int = 6100) -> list[N]:
    """A scene written the way FBX 6.x wrote them.

    Three things differ from 7.x and every one of them has to be handled:
    objects are addressed by name rather than by UID, the mesh lives on the
    Model instead of in its own Geometry record, and the numbers are written
    one property at a time rather than as arrays.
    """
    def scalars(name: str, code: str, values) -> N:
        return N(name, [Prop(code, v) for v in values])

    def p60(name: str, type_name: str, *values) -> N:
        # 6.x names these records "Property" and writes three strings before
        # the value, where 7.x writes "P" and four.
        return N("Property", [S(name), S(type_name), S("")] + list(values))

    def model(label: str, translation, scale) -> N:
        return N("Model", [S(f"{label}\x00\x01Model"), S("Mesh")], [
            N("Version", [I(232)]),
            N("Properties60", [], [
                p60("RotationOrder", "enum", I(0)),
                p60("Lcl Translation", "Lcl Translation", *[D(v) for v in translation]),
                p60("Lcl Rotation", "Lcl Rotation", D(0.0), D(0.0), D(0.0)),
                p60("Lcl Scaling", "Lcl Scaling", *[D(v) for v in scale]),
            ]),
            N("MultiLayer", [I(0)]),
            N("Shading", [C(True)]),
            N("Culling", [S("CullingOff")]),
            scalars("Vertices", "D", CUBE_VERTICES),
            scalars("PolygonVertexIndex", "I", CUBE_POLYGONS),
            N("GeometryVersion", [I(124)]),
            N("LayerElementMaterial", [I(0)], [
                N("Version", [I(101)]),
                N("Name", [S("")]),
                N("MappingInformationType", [S("AllSame")]),
                N("ReferenceInformationType", [S("IndexToDirect")]),
                scalars("Materials", "I", [0]),
            ]),
            N("Layer", [I(0)], [N("Version", [I(100)])]),
        ])

    objects = N("Objects", [], [
        model("partA", (0.0, 0.0, 0.0), (1.0, 1.0, 1.0)),
        model("partB", (5.0, 0.0, 0.0), (2.0, 2.0, 2.0)),
        N("Material", [S("paint\x00\x01Material"), S("")], [
            N("Version", [I(102)]),
            N("ShadingModel", [S("phong")]),
            N("MultiLayer", [I(0)]),
            N("Properties60", [], [
                p60("ShadingModel", "KString", S("phong")),
                p60("DiffuseColor", "ColorRGB", *[D(v) for v in LEGACY_DIFFUSE]),
                p60("SpecularColor", "ColorRGB", D(0.1), D(0.1), D(0.1)),
                p60("ShininessExponent", "double", D(40.0)),
            ]),
        ]),
    ])

    connections = N("Connections", [], [
        N("Connect", [S("OO"), S("partA\x00\x01Model"), S("Scene\x00\x01Model")]),
        N("Connect", [S("OO"), S("partB\x00\x01Model"), S("Scene\x00\x01Model")]),
        N("Connect", [S("OO"), S("paint\x00\x01Material"), S("partA\x00\x01Model")]),
        N("Connect", [S("OO"), S("paint\x00\x01Material"), S("partB\x00\x01Model")]),
    ])

    return [
        N("FBXHeaderExtension", [], [
            N("FBXHeaderExtensionVersion", [I(1003)]),
            N("FBXVersion", [I(version)]),
            N("Creator", [S("fbxtool test fixture")]),
        ]),
        N("Creator", [S("fbxtool test fixture")]),
        N("Definitions", [], [
            N("Version", [I(100)]),
            N("Count", [I(3)]),
            N("ObjectType", [S("Model")], [N("Count", [I(2)])]),
            N("ObjectType", [S("Material")], [N("Count", [I(1)])]),
        ]),
        objects,
        connections,
        N("Version5", [], [N("AmbientRenderSettings", [], [])]),
    ]


def build_legacy(version: int = 6100) -> bytes:
    """A complete binary FBX file in the 6.x layout."""
    return build_binary(legacy_nodes(version), version=version)


# --------------------------------------------------------------------------
# textured fixtures


def png(width: int, height: int, pixels: bytes) -> bytes:
    """A minimal 8-bit RGB PNG, so tests need no image library."""
    rows = b"".join(b"\x00" + pixels[y * width * 3:(y + 1) * width * 3]
                    for y in range(height))

    def chunk(tag: bytes, payload: bytes) -> bytes:
        body = tag + payload
        return (struct.pack(">I", len(payload)) + body
                + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF))

    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(rows, 9))
            + chunk(b"IEND", b""))


def checker_png(size: int = 64, squares: int = 8) -> bytes:
    """A two-colour checkerboard, obvious when it lands on geometry."""
    step = max(size // squares, 1)
    out = bytearray()
    for y in range(size):
        for x in range(size):
            if ((x // step) + (y // step)) % 2:
                out += bytes((235, 72, 48))     # orange
            else:
                out += bytes((32, 90, 200))     # blue
    return png(size, size, bytes(out))


def height_png(size: int = 64) -> bytes:
    """A bump map: grey, and getting brighter to the right and downwards.

    A ramp rather than a pattern because its answer is known — the surface it
    stands for leans one way over the whole of itself, so the normals it turns
    into can be checked against a direction rather than against a picture.
    """
    out = bytearray()
    for y in range(size):
        for x in range(size):
            value = (x + y) * 255 // max(2 * (size - 1), 1)
            out += bytes((value, value, value))
    return png(size, size, bytes(out))


def normal_map_png(size: int = 64) -> bytes:
    """A tangent-space normal map: mostly facing straight out, so mostly blue.

    Which is what tells one from a height map — a height map is grey however
    bright it is, and this is not.
    """
    out = bytearray()
    for y in range(size):
        for x in range(size):
            # A gentle tilt, so it is a normal map rather than a flat blue.
            lean = 20 if (x // 8 + y // 8) % 2 else -20
            out += bytes((128 + lean, 128 - lean, 250))
    return png(size, size, bytes(out))


def _pack_bits(row: bytes) -> bytes:
    """One row as PackBits, the run-length coding a ``.psd`` stores rows in.

    Written the plain way — a run of three or more of the same byte becomes a
    repeat, everything else is copied literally — which is enough to be a real
    exercise of the reader without being what Photoshop itself would choose.
    """
    out = bytearray()
    at = 0
    while at < len(row):
        run = 1
        while at + run < len(row) and row[at + run] == row[at] and run < 128:
            run += 1
        if run >= 3:
            out += bytes((257 - run, row[at]))
            at += run
            continue
        start = at
        while at < len(row) and at - start < 128:
            ahead = row[at:at + 3]
            if len(ahead) == 3 and ahead[0] == ahead[1] == ahead[2]:
                break
            at += 1
        out += bytes((at - start - 1,)) + row[start:at]
    return bytes(out)


def psd(width: int, height: int, pixels: bytes, *, compress: bool = True,
        channels: int = 3) -> bytes:
    """A Photoshop document holding nothing but its composite.

    Which is all a reader wants of one: the flattened picture at the end, in
    planar order — the whole of red, then the whole of green, then blue — with
    the three length-prefixed sections in front of it left empty.  ``compress``
    chooses between the two codings a ``.psd`` uses for it, raw and PackBits.
    """
    planes = [bytes(pixels[i::3]) for i in range(3)][:channels]
    if channels == 1:
        planes = [bytes(pixels[0::3])]
    head = (b"8BPS" + struct.pack(">H", 1) + b"\x00" * 6
            + struct.pack(">HIIHH", len(planes), height, width, 8,
                          1 if channels == 1 else 3))
    sections = struct.pack(">I", 0) * 3
    if not compress:
        return head + sections + struct.pack(">H", 0) + b"".join(planes)
    counts = bytearray()
    body = bytearray()
    for plane in planes:
        for y in range(height):
            packed = _pack_bits(plane[y * width:(y + 1) * width])
            counts += struct.pack(">H", len(packed))
            body += packed
    return head + sections + struct.pack(">H", 1) + bytes(counts) + bytes(body)


def textured_cube_nodes(version: int = 7400, *, embed: bool = True,
                        filename: str = "checker.png") -> list[N]:
    """A cube carrying UVs and a diffuse texture.

    UVs use ByPolygonVertex + IndexToDirect, which is what real exporters
    write, so the index path is what gets exercised.
    """
    geometry_uid, model_uid, material_uid, texture_uid, video_uid = 10, 20, 30, 40, 50

    vertices = [
        -1.0, -1.0, 1.0, 1.0, -1.0, 1.0, -1.0, 1.0, 1.0, 1.0, 1.0, 1.0,
        -1.0, 1.0, -1.0, 1.0, 1.0, -1.0, -1.0, -1.0, -1.0, 1.0, -1.0, -1.0,
    ]
    polygons = [0, 1, 3, -3, 2, 3, 5, -5, 4, 5, 7, -7, 6, 7, 1, -1,
                1, 7, 5, -4, 6, 0, 2, -5]
    # Four corners, referenced by index once per polygon vertex.
    uv_values = [0.0, 0.0, 1.0, 0.0, 1.0, 1.0, 0.0, 1.0]
    uv_index = [0, 1, 2, 3] * 6

    image = checker_png()

    video_children = [
        N("Type", [S("Clip")]),
        N("Filename", [S(filename)]),
        N("RelativeFilename", [S(filename)]),
    ]
    if embed:
        video_children.append(N("Content", [R(image)]))

    objects = N("Objects", [], [
        N("Geometry", [L(geometry_uid), S("Geometry\x00\x01Geometry"), S("Mesh")], [
            N("Vertices", [darr(vertices, deflate=True)]),
            N("PolygonVertexIndex", [iarr(polygons, deflate=True)]),
            N("GeometryVersion", [I(124)]),
            N("LayerElementUV", [I(0)], [
                N("Version", [I(101)]),
                N("Name", [S("map1")]),
                N("MappingInformationType", [S("ByPolygonVertex")]),
                N("ReferenceInformationType", [S("IndexToDirect")]),
                N("UV", [darr(uv_values)]),
                N("UVIndex", [iarr(uv_index)]),
            ]),
            N("LayerElementMaterial", [I(0)], [
                N("Version", [I(101)]),
                N("MappingInformationType", [S("AllSame")]),
                N("ReferenceInformationType", [S("IndexToDirect")]),
                N("Materials", [iarr([0])]),
            ]),
            N("Layer", [I(0)], [N("Version", [I(100)])]),
        ]),
        N("Model", [L(model_uid), S("texturedCube\x00\x01Model"), S("Mesh")], [
            N("Version", [I(232)]),
        ]),
        N("Material", [L(material_uid), S("checker\x00\x01Material"), S("")], [
            N("Version", [I(102)]),
            N("ShadingModel", [S("phong")]),
            N("Properties70", [], [
                N("P", [S("DiffuseColor"), S("Color"), S(""), S("A"),
                        D(1.0), D(1.0), D(1.0)]),
            ]),
        ]),
        N("Texture", [L(texture_uid), S("checkerTexture\x00\x01Texture"), S("")], [
            N("Type", [S("TextureVideoClip")]),
            N("Version", [I(202)]),
            N("TextureName", [S("checkerTexture\x00\x01Texture")]),
            N("FileName", [S(filename)]),
            N("RelativeFilename", [S(filename)]),
        ]),
        N("Video", [L(video_uid), S(f"{filename}\x00\x01Video"), S("Clip")], video_children),
    ])

    connections = N("Connections", [], [
        N("C", [S("OO"), L(model_uid), L(0)]),
        N("C", [S("OO"), L(geometry_uid), L(model_uid)]),
        N("C", [S("OO"), L(material_uid), L(model_uid)]),
        N("C", [S("OP"), L(texture_uid), L(material_uid), S("DiffuseColor")]),
        N("C", [S("OO"), L(video_uid), L(texture_uid)]),
    ])

    header = N("FBXHeaderExtension", [], [
        N("FBXHeaderExtensionVersion", [I(1003)]),
        N("FBXVersion", [I(version)]),
        N("Creator", [S("fbxtool textured fixture")]),
    ])
    definitions = N("Definitions", [], [
        N("Version", [I(100)]),
        N("Count", [I(5)]),
        N("ObjectType", [S("Geometry")], [N("Count", [I(1)])]),
        N("ObjectType", [S("Model")], [N("Count", [I(1)])]),
        N("ObjectType", [S("Material")], [N("Count", [I(1)])]),
        N("ObjectType", [S("Texture")], [N("Count", [I(1)])]),
        N("ObjectType", [S("Video")], [N("Count", [I(1)])]),
    ])
    return [header, N("Creator", [S("fbxtool textured fixture")]),
            definitions, objects, connections]


def build_textured_cube(version: int = 7400, *, embed: bool = True,
                        filename: str = "checker.png") -> bytes:
    return build_binary(textured_cube_nodes(version, embed=embed, filename=filename),
                        version=version)


def build_bare_twin(version: int = 7400) -> bytes:
    """The same cube under the same name, with no image and nowhere to put one.

    Half of a pair: this is the file worth opening — it holds the geometry —
    and it is the one with nothing to draw on it.  Which is how a model saved
    several ways usually arrives, one saving having kept the mesh and another
    the maps.
    """
    nodes = textured_cube_nodes(version)
    objects = next(n for n in nodes if n.name == "Objects")
    connections = next(n for n in nodes if n.name == "Connections")
    objects.children = [c for c in objects.children if c.name not in ("Texture", "Video")]
    connections.children = [c for c in connections.children
                            if c.props[0].value != "OP"
                            and c.props[1].value != 50]
    return build_binary(nodes, version=version)


def build_scrap_twin(version: int = 7400,
                     property_name: str = "DiffuseColor") -> bytes:
    """The other half: one triangle under the same model name, with the image.

    Deliberately the poorer mesh of the two, so which file is opened for its
    geometry and which is read for its materials cannot come out the same by
    accident.  `property_name` is what the connection binding the texture is
    called, which every renderer spells its own way.
    """
    nodes = textured_cube_nodes(version)
    objects = next(n for n in nodes if n.name == "Objects")
    connections = next(n for n in nodes if n.name == "Connections")
    for entry in objects.children:
        if entry.name == "Geometry":
            entry.children = [
                N("Vertices", [darr([-1.0, -1.0, 0.0, 1.0, -1.0, 0.0, 0.0, 1.0, 0.0])]),
                N("PolygonVertexIndex", [iarr([0, 1, -3])]),
                N("GeometryVersion", [I(124)]),
                N("LayerElementMaterial", [I(0)], [
                    N("Version", [I(101)]),
                    N("MappingInformationType", [S("AllSame")]),
                    N("ReferenceInformationType", [S("IndexToDirect")]),
                    N("Materials", [iarr([0])]),
                ]),
                N("Layer", [I(0)], [N("Version", [I(100)])]),
            ]
    for entry in connections.children:
        if entry.props[0].value == "OP":
            entry.props[3] = S(property_name)
    return build_binary(nodes, version=version)


#: The property a 3ds Max / Corona export names its base colour with, and the
#: image that ends up two links below it.
VENDOR_PROPERTY = "3dsMax|CoronaMtlPb|texmapDiffuse"
#: What V-Ray and Corona write instead, which is most of what leaves 3ds Max.
VENDOR_PROPERTY_UNDERSCORED = "3dsMax|maps|texmap_diffuse"
VENDOR_IMAGE = "Maps/checker.png"


def build_vendor_textured(version: int = 7400,
                          property_name: str = VENDOR_PROPERTY) -> bytes:
    """A cube textured the way an exporter with its own renderer writes it.

    Two things differ from the standard shape and both have to be followed:
    the connection names the renderer's own property rather than
    ``DiffuseColor``, and the texture bound to the material holds no image —
    it feeds off another texture, which is the one naming the file.
    """
    nodes = textured_cube_nodes(version, embed=False, filename=VENDOR_IMAGE)
    objects = next(n for n in nodes if n.name == "Objects")
    connections = next(n for n in nodes if n.name == "Connections")

    texture_uid, video_uid, material_uid = 40, 50, 30
    inner_uid = 60

    # The texture that names the file becomes the inner one; a new, empty
    # texture sits between it and the material.
    for entry in objects.children:
        if entry.name == "Texture":
            entry.props = [L(inner_uid), S("inner\x00\x01Texture"), S("")]
    objects.children.append(
        N("Texture", [L(texture_uid), S("outer\x00\x01Texture"), S("")], [
            N("Type", [S("TextureVideoClip")]),
            N("Version", [I(202)]),
            N("TextureName", [S("outer\x00\x01Texture")]),
            # No filename at all: the image is further down the chain.
            N("RelativeFilename", [S("")]),
        ]))

    connections.children = [
        c for c in connections.children
        if not (c.props[0].value == "OP" and c.props[1].value == texture_uid)
        and not (c.props[0].value == "OO" and c.props[2].value == texture_uid)
    ]
    connections.children += [
        N("C", [S("OP"), L(texture_uid), L(material_uid), S(property_name)]),
        N("C", [S("OP"), L(inner_uid), L(texture_uid), S("3dsMax|parameters|map1")]),
        N("C", [S("OO"), L(video_uid), L(inner_uid)]),
    ]
    return build_binary(nodes, version=version)


# --------------------------------------------------------------------------
# .blend fixtures
#
# A .blend is a dump of Blender's memory plus an SDNA block describing the C
# structs it contains. This writes a small but structurally faithful one —
# including a real mesh reached by pointer — so both the container reader and
# the SDNA-driven mesh extraction can be tested without Blender installed.

BLEND_MAGIC = b"BLENDER"

#: (type, name) pairs per struct, in declaration order. Field sizes follow the
#: SDNA rules: a leading '*' means a pointer, '[n]' multiplies.
_BLEND_TYPES = [
    ("void", 0), ("char", 1), ("short", 2), ("int", 4), ("float", 4),
    ("ID", 0), ("Library", 0), ("MVert", 20), ("MPoly", 12), ("MLoop", 8),
    ("MLoopUV", 12), ("Material", 0), ("Mesh", 0), ("Object", 0),
]

_BLEND_STRUCTS = {
    "ID": [("void", "*next"), ("void", "*prev"), ("ID", "*newid"),
           ("Library", "*lib"), ("char", "name[66]"), ("short", "flag")],
    "MVert": [("float", "co[3]"), ("short", "no[3]"), ("char", "flag"),
              ("char", "bweight")],
    "MPoly": [("int", "loopstart"), ("int", "totloop"), ("short", "mat_nr"),
              ("char", "flag"), ("char", "_pad")],
    "MLoop": [("int", "v"), ("int", "e")],
    "MLoopUV": [("float", "uv[2]"), ("int", "flag")],
    "Material": [("ID", "id"), ("float", "r"), ("float", "g"), ("float", "b"),
                 ("float", "a")],
    "Mesh": [("ID", "id"), ("MPoly", "*mpoly"), ("MLoop", "*mloop"),
             ("MLoopUV", "*mloopuv"), ("MVert", "*mvert"), ("Material", "**mat"),
             ("int", "totvert"), ("int", "totpoly"), ("int", "totloop"),
             ("short", "totcol")],
    "Object": [("ID", "id"), ("void", "*data")],
}

#: Struct order in the SDNA; datablocks reference these by index.
_BLEND_ORDER = ["ID", "MVert", "MPoly", "MLoop", "MLoopUV", "Material", "Mesh", "Object"]

_ARRAY = re.compile(r"\[(\d+)\]")


def _blend_field_size(type_name: str, field_name: str, sizes: dict, pointer_size: int) -> int:
    size = pointer_size if field_name.startswith("*") else sizes[type_name]
    for count in _ARRAY.findall(field_name):
        size *= int(count)
    return size


def _blend_sizes(pointer_size: int) -> dict:
    """Struct sizes, computed the way the SDNA declares them."""
    sizes = dict(_BLEND_TYPES)
    for name in _BLEND_ORDER:
        sizes[name] = sum(_blend_field_size(t, f, sizes, pointer_size)
                          for t, f in _BLEND_STRUCTS[name])
    return sizes


def _sdna_block(pointer_size: int, endian: str = "<") -> bytes:
    sizes = _blend_sizes(pointer_size)
    names, types = [], [name for name, _ in _BLEND_TYPES]
    for struct_name in _BLEND_ORDER:
        for _, field_name in _BLEND_STRUCTS[struct_name]:
            if field_name not in names:
                names.append(field_name)

    def strings(tag, items):
        out = bytearray(tag)
        out += struct.pack(f"{endian}I", len(items))
        for item in items:
            out += item.encode("ascii") + b"\x00"
        while len(out) % 4:
            out += b"\x00"
        return bytes(out)

    body = bytearray(b"SDNA")
    body += strings(b"NAME", names)
    body += strings(b"TYPE", types)

    tlen = bytearray(b"TLEN")
    tlen += struct.pack(f"{endian}{len(types)}H", *[sizes[t] for t in types])
    while len(tlen) % 4:
        tlen += b"\x00"
    body += tlen

    strc = bytearray(b"STRC")
    strc += struct.pack(f"{endian}I", len(_BLEND_ORDER))
    for struct_name in _BLEND_ORDER:
        fields = _BLEND_STRUCTS[struct_name]
        strc += struct.pack(f"{endian}HH", types.index(struct_name), len(fields))
        for type_name, field_name in fields:
            strc += struct.pack(f"{endian}HH", types.index(type_name),
                                names.index(field_name))
        body += b""
    body += strc
    return bytes(body)


def _blend_id(code: str, name: str, pointer_size: int) -> bytes:
    """An ID struct whose name field holds the code-prefixed datablock name."""
    payload = bytearray(pointer_size * 4)           # next, prev, newid, lib
    field = (code + name).encode("utf-8")[:65]
    payload += field + b"\x00" * (66 - len(field))
    payload += struct.pack("<h", 0)                 # flag
    return bytes(payload)


#: A unit cube: eight corners, six quads, twenty-four loops.
_CUBE_VERTS = [(-1, -1, -1), (1, -1, -1), (1, 1, -1), (-1, 1, -1),
               (-1, -1, 1), (1, -1, 1), (1, 1, 1), (-1, 1, 1)]
_CUBE_FACES = [(0, 1, 2, 3), (4, 5, 6, 7), (0, 1, 5, 4),
               (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]


def build_blend(version: int = 293, *, pointer_size: int = 8,
                datablocks=(("OB", "Cube"), ("MA", "Red")),
                with_mesh: bool = True, compress: bool = False,
                truncated: bool = False) -> bytes:
    """A small but structurally valid .blend file.

    With *with_mesh*, a real cube is written as MVert/MPoly/MLoop arrays in
    their own blocks, reached from the Mesh struct by pointer exactly as
    Blender writes them.
    """
    endian = "<"
    sizes = _blend_sizes(pointer_size)
    pointer_format = "Q" if pointer_size == 8 else "I"
    header = struct.Struct(f"{endian}4sI{pointer_format}II")

    out = bytearray(BLEND_MAGIC)
    out += b"-" if pointer_size == 8 else b"_"
    out += b"v"
    out += f"{version:03d}".encode("ascii")

    address = 0x10000

    def next_address():
        nonlocal address
        address += 0x1000
        return address

    def block(code: str, payload: bytes, at: int, sdna_index: int = 0, count: int = 1):
        return header.pack(code.encode("ascii").ljust(4, b"\x00"), len(payload),
                           at, sdna_index, count) + payload

    out += block("GLOB", b"\x00" * 32, next_address())

    material_addresses = []
    for code, name in datablocks:
        at = next_address()
        payload = bytearray(_blend_id(code, name, pointer_size))
        if code == "MA":
            payload += struct.pack(f"{endian}4f", 0.9, 0.1, 0.1, 1.0)
            material_addresses.append(at)
        payload += b"\x00" * pointer_size
        out += block(code, bytes(payload), at, sdna_index=_BLEND_ORDER.index("Object"))

    if with_mesh:
        vert_at, poly_at, loop_at, uv_at, mat_at = (next_address() for _ in range(5))

        verts = bytearray()
        for x, y, z in _CUBE_VERTS:
            verts += struct.pack(f"{endian}3f", float(x), float(y), float(z))
            verts += struct.pack(f"{endian}3h", 0, 0, 32767)   # normal, as shorts
            verts += b"\x00\x00"                               # flag, bweight
        polys, loops, uvs = bytearray(), bytearray(), bytearray()
        for index, face in enumerate(_CUBE_FACES):
            polys += struct.pack(f"{endian}iihbb", index * 4, 4,
                                 index % max(len(material_addresses), 1), 0, 0)
            for corner, vertex in enumerate(face):
                loops += struct.pack(f"{endian}II", vertex, 0)
                uvs += struct.pack(f"{endian}2fi", (corner % 2), (corner // 2), 0)

        out += block("DATA", bytes(verts), vert_at,
                     sdna_index=_BLEND_ORDER.index("MVert"), count=len(_CUBE_VERTS))
        out += block("DATA", bytes(polys), poly_at,
                     sdna_index=_BLEND_ORDER.index("MPoly"), count=len(_CUBE_FACES))
        out += block("DATA", bytes(loops), loop_at,
                     sdna_index=_BLEND_ORDER.index("MLoop"), count=len(_CUBE_FACES) * 4)
        out += block("DATA", bytes(uvs), uv_at,
                     sdna_index=_BLEND_ORDER.index("MLoopUV"), count=len(_CUBE_FACES) * 4)
        out += block("DATA",
                     struct.pack(f"{endian}{len(material_addresses)}{pointer_format}",
                                 *material_addresses) or b"\x00" * pointer_size,
                     mat_at, count=max(len(material_addresses), 1))

        mesh = bytearray(_blend_id("ME", "Cube", pointer_size))
        mesh += struct.pack(f"{endian}{pointer_format}", poly_at)
        mesh += struct.pack(f"{endian}{pointer_format}", loop_at)
        mesh += struct.pack(f"{endian}{pointer_format}", uv_at)
        mesh += struct.pack(f"{endian}{pointer_format}", vert_at)
        mesh += struct.pack(f"{endian}{pointer_format}", mat_at)
        mesh += struct.pack(f"{endian}iii", len(_CUBE_VERTS), len(_CUBE_FACES),
                            len(_CUBE_FACES) * 4)
        mesh += struct.pack(f"{endian}h", len(material_addresses))
        assert len(mesh) == sizes["Mesh"], f"{len(mesh)} != declared {sizes['Mesh']}"
        out += block("ME", bytes(mesh), next_address(),
                     sdna_index=_BLEND_ORDER.index("Mesh"))

    out += block("DNA1", _sdna_block(pointer_size, endian), next_address())
    if not truncated:
        out += header.pack(b"ENDB", 0, 0, 0, 0)

    data = bytes(out)
    if compress:
        import gzip as _gzip
        data = _gzip.compress(data)
    return data


#: A cube under a parent that holds nothing but a transform. The parent scales
#: by two and stands the cube ten units away, so the assembled scene is 4 units
#: across — 2 if the parent's transform is skipped, which is the whole point.
RIGGED_SIZE = (4.0, 4.0, 4.0)
RIGGED_PARTS = 1
RIGGED_TRIANGLES = 12


def rigged_nodes(version: int = 7400, *, deflate: bool = True) -> list[N]:
    """A mesh whose placement lives on a parent with no mesh of its own.

    Exporters write this constantly — a rig, a pivot, or the root node a glTF
    hangs its axis and unit conversion on — and a scene assembled by walking
    only the parts that hold geometry silently drops it.
    """
    geometry_uid, cube_uid, rig_uid = 1000, 2001, 2002

    def lcl(name: str, x: float, y: float, z: float) -> N:
        return N("P", [S(f"Lcl {name}"), S(f"Lcl {name}"), S(""), S("A"),
                       D(x), D(y), D(z)])

    objects = N("Objects", [], [
        N("Geometry", [L(geometry_uid), S("part\x00\x01Geometry"), S("Mesh")], [
            N("Vertices", [darr(CUBE_VERTICES, deflate=deflate)]),
            N("PolygonVertexIndex", [iarr(CUBE_POLYGONS, deflate=deflate)]),
            N("GeometryVersion", [I(124)]),
            N("Layer", [I(0)], [N("Version", [I(100)])]),
        ]),
        N("Model", [L(rig_uid), S("rig\x00\x01Model"), S("Null")], [
            N("Version", [I(232)]),
            N("Properties70", [], [lcl("Translation", 10.0, 0.0, 0.0),
                                   lcl("Scaling", 2.0, 2.0, 2.0)]),
        ]),
        N("Model", [L(cube_uid), S("cube\x00\x01Model"), S("Mesh")], [
            N("Version", [I(232)]),
            N("Properties70", [], []),
        ]),
    ])

    connections = N("Connections", [], [
        N("C", [S("OO"), L(rig_uid), L(0)]),
        N("C", [S("OO"), L(cube_uid), L(rig_uid)]),
        N("C", [S("OO"), L(geometry_uid), L(cube_uid)]),
    ])

    header = N("FBXHeaderExtension", [], [
        N("FBXHeaderExtensionVersion", [I(1003)]),
        N("FBXVersion", [I(version)]),
        N("EncryptionType", [I(0)]),
        N("Creator", [S("fbxtool test fixture")]),
    ])

    global_settings = N("GlobalSettings", [], [
        N("Version", [I(1000)]),
        N("Properties70", [], [
            N("P", [S("UpAxis"), S("int"), S("Integer"), S(""), I(1)]),
            N("P", [S("UpAxisSign"), S("int"), S("Integer"), S(""), I(1)]),
            N("P", [S("UnitScaleFactor"), S("double"), S("Number"), S(""), D(1.0)]),
        ]),
    ])

    return [header, N("Creator", [S("fbxtool test fixture")]),
            global_settings, objects, connections]


def build_rigged(version: int = 7400, *, deflate: bool = True) -> bytes:
    """A complete binary FBX file holding the parented cube."""
    return build_binary(rigged_nodes(version, deflate=deflate), version=version)


# --------------------------------------------------------------------- glTF 2.0

#: The hand-written glTF scene: a box and a speck, one material, one image.
#:
#: It deliberately uses what a plain exporter would not — attributes
#: interleaved behind a byteStride, 16-bit indices, a sparse accessor, a
#: primitive with no indices, a node placed by a quaternion and another by a
#: matrix — so a reader that only handles the easy shapes fails on it.
GLTF_TRIANGLES = 13
GLTF_PRIMITIVES = 2
GLTF_NODES = 3
#: The box before its node's scale: the fifth unit of depth comes from the
#: sparse accessor alone.
GLTF_BOX_LOCAL = (2.0, 1.0, 5.0)
GLTF_MATERIAL = "paint"
GLTF_BASE_COLOR = (0.8, 0.1, 0.05, 0.5)
GLTF_METALLIC = 0.25
GLTF_ROUGHNESS = 0.4
GLTF_IMAGE = "checker.png"
#: A quarter turn about Y, as FBX Euler angles in degrees.
GLTF_BOX_ROTATION = (0.0, 90.0, 0.0)
GLTF_BOX_TRANSLATION = (5.0, 0.0, 0.0)
GLTF_BOX_SCALE = (2.0, 2.0, 2.0)

_GLTF_CORNERS = [
    (-1, -0.5, -2), (1, -0.5, -2), (1, 0.5, -2), (-1, 0.5, -2),
    (-1, -0.5, 2), (1, -0.5, 2), (1, 0.5, 2), (-1, 0.5, 2),
]
_GLTF_FACES = [
    (0, 1, 2), (0, 2, 3), (5, 4, 7), (5, 7, 6), (4, 0, 3), (4, 3, 7),
    (1, 5, 6), (1, 6, 2), (3, 2, 6), (3, 6, 7), (4, 5, 1), (4, 1, 0),
]
#: Where the sparse accessor puts corner 0.
_GLTF_MOVED = (-1, -0.5, -3)


def _gltf_buffer(image: bytes) -> tuple[bytes, dict[str, tuple[int, int]]]:
    """The one buffer, and where each view sits in it."""
    stride = 24
    out = bytearray()
    for x, y, z in _GLTF_CORNERS:
        out += struct.pack("<3f", x, y, z)          # position
        out += struct.pack("<3f", 0.0, 1.0, 0.0)    # normal
    assert len(out) == len(_GLTF_CORNERS) * stride

    views = {"attributes": (0, len(out))}
    at = len(out)
    out += struct.pack("<36H", *[i for face in _GLTF_FACES for i in face])
    views["indices"] = (at, len(out) - at)

    at = len(out)
    out += struct.pack("<H", 0)
    views["sparse_indices"] = (at, 2)
    out += b"\x00\x00"                              # pad the values to 4 bytes
    at = len(out)
    out += struct.pack("<3f", *_GLTF_MOVED)
    views["sparse_values"] = (at, 12)

    at = len(out)
    for corner in ((0, 0, 0), (0.1, 0, 0), (0, 0.1, 0)):
        out += struct.pack("<3f", *corner)
    views["speck"] = (at, len(out) - at)

    at = len(out)
    out += image
    out += b"\x00" * (-len(image) % 4)
    views["image"] = (at, len(image))
    return bytes(out), views


def gltf_document(image: bytes, *, buffer_uri: str | None,
                  buffer_length: int, views: dict[str, tuple[int, int]]) -> dict:
    """The JSON half, pointing either at a .bin or at the container's chunk."""
    buffer: dict = {"byteLength": buffer_length}
    if buffer_uri is not None:
        buffer["uri"] = buffer_uri
    return {
        "asset": {"version": "2.0", "generator": "fbxtool test fixture"},
        "scene": 0,
        "scenes": [{"nodes": [2]}],
        "nodes": [
            {
                "name": "box", "mesh": 0,
                "translation": list(GLTF_BOX_TRANSLATION),
                "rotation": [0.0, 2 ** -0.5, 0.0, 2 ** -0.5],
                "scale": list(GLTF_BOX_SCALE),
            },
            {"name": "speck", "mesh": 1},
            # Placed by a matrix rather than a TRS: the identity, so the parts
            # below it stand where their own transforms put them.
            {"name": "rig", "children": [0, 1],
             "matrix": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]},
        ],
        "meshes": [
            {"name": "box", "primitives": [
                {"attributes": {"POSITION": 0, "NORMAL": 1}, "indices": 2, "material": 0}]},
            {"name": "speck", "primitives": [{"attributes": {"POSITION": 3}}]},
        ],
        "materials": [{
            "name": GLTF_MATERIAL,
            "alphaMode": "BLEND",
            "pbrMetallicRoughness": {
                "baseColorFactor": list(GLTF_BASE_COLOR),
                "metallicFactor": GLTF_METALLIC,
                "roughnessFactor": GLTF_ROUGHNESS,
                "baseColorTexture": {"index": 0},
            },
        }],
        "textures": [{"source": 0}],
        "images": [{"name": GLTF_IMAGE, "mimeType": "image/png", "bufferView": 5}],
        "buffers": [buffer],
        "bufferViews": [
            {"buffer": 0, "byteOffset": views["attributes"][0],
             "byteLength": views["attributes"][1], "byteStride": 24},
            {"buffer": 0, "byteOffset": views["indices"][0],
             "byteLength": views["indices"][1]},
            {"buffer": 0, "byteOffset": views["sparse_indices"][0],
             "byteLength": views["sparse_indices"][1]},
            {"buffer": 0, "byteOffset": views["sparse_values"][0],
             "byteLength": views["sparse_values"][1]},
            {"buffer": 0, "byteOffset": views["speck"][0],
             "byteLength": views["speck"][1]},
            {"buffer": 0, "byteOffset": views["image"][0],
             "byteLength": views["image"][1]},
        ],
        "accessors": [
            {"bufferView": 0, "byteOffset": 0, "componentType": 5126,
             "count": len(_GLTF_CORNERS), "type": "VEC3",
             "sparse": {
                 "count": 1,
                 "indices": {"bufferView": 2, "byteOffset": 0, "componentType": 5123},
                 "values": {"bufferView": 3, "byteOffset": 0},
             }},
            {"bufferView": 0, "byteOffset": 12, "componentType": 5126,
             "count": len(_GLTF_CORNERS), "type": "VEC3"},
            {"bufferView": 1, "componentType": 5123,
             "count": len(_GLTF_FACES) * 3, "type": "SCALAR"},
            {"bufferView": 4, "componentType": 5126, "count": 3, "type": "VEC3"},
        ],
    }


def build_draco_glb(shape: str = "sphere4") -> bytes:
    """A .glb whose geometry is a checked-in Draco block.

    The accessors carry counts and bounds but no bufferView, which is how a
    compressed file describes the mesh it took away: everything real is in the
    Draco block, and a reader that cannot decompress it has nothing to draw.
    """
    here = pathlib.Path(__file__).resolve().parent.parent / "samples" / "draco"
    block = (here / f"{shape}.drc").read_bytes()
    answer = json.loads((here / f"{shape}.json").read_text())

    names = {"POSITION": "POSITION", "NORMAL": "NORMAL", "TEX_COORD": "TEXCOORD_0"}
    accessors = []
    attributes = {}
    draco_attributes = {}
    for label, entry in answer["attributes"].items():
        name = names[label]
        components = entry["numComponents"]
        values = entry["values"]
        columns = [[values[i * components + c] for i in range(answer["numPoints"])]
                   for c in range(components)]
        attributes[name] = len(accessors)
        draco_attributes[name] = entry["uniqueId"]
        accessors.append({
            "componentType": 5126,
            "count": answer["numPoints"],
            "type": {1: "SCALAR", 2: "VEC2", 3: "VEC3", 4: "VEC4"}[components],
            "min": [min(col) for col in columns],
            "max": [max(col) for col in columns],
        })
    indices_accessor = len(accessors)
    accessors.append({"componentType": 5125, "count": answer["numFaces"] * 3,
                      "type": "SCALAR"})

    document = {
        "asset": {"version": "2.0", "generator": "fbxtool test fixture"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"name": shape, "mesh": 0}],
        "meshes": [{"name": shape, "primitives": [{
            "attributes": attributes,
            "indices": indices_accessor,
            "material": 0,
            "extensions": {"KHR_draco_mesh_compression": {
                "bufferView": 0,
                "attributes": draco_attributes,
            }},
        }]}],
        "materials": [{"name": "paint", "pbrMetallicRoughness": {
            "baseColorFactor": [0.8, 0.1, 0.05, 1.0],
            "metallicFactor": 0.0,
            "roughnessFactor": 0.5,
        }}],
        "accessors": accessors,
        "bufferViews": [{"buffer": 0, "byteOffset": 0, "byteLength": len(block)}],
        "buffers": [{"byteLength": len(block)}],
        "extensionsUsed": ["KHR_draco_mesh_compression"],
        "extensionsRequired": ["KHR_draco_mesh_compression"],
    }

    json_chunk = json.dumps(document).encode("utf-8")
    json_chunk += b" " * (-len(json_chunk) % 4)
    binary = block + b"\x00" * (-len(block) % 4)
    total = 12 + 8 + len(json_chunk) + 8 + len(binary)
    out = bytearray(struct.pack("<4sII", b"glTF", 2, total))
    out += struct.pack("<II", len(json_chunk), 0x4E4F534A) + json_chunk
    out += struct.pack("<II", len(binary), 0x004E4942) + binary
    return bytes(out)


def build_basis_glb(texture: str = "bars") -> bytes:
    """A textured quad whose image is a KTX2 (Basis Universal, ETC1S).

    No browser can decode that image, so anything that appears on screen came
    out of the transcoder.
    """
    here = pathlib.Path(__file__).resolve().parent.parent / "samples" / "ktx2"
    image = (here / f"{texture}.ktx2").read_bytes()

    positions = [-1.0, -1.0, 0.0, 1.0, -1.0, 0.0, 1.0, 1.0, 0.0, -1.0, 1.0, 0.0]
    uvs = [0.0, 1.0, 1.0, 1.0, 1.0, 0.0, 0.0, 0.0]
    indices = [0, 1, 2, 0, 2, 3]

    buffer = bytearray()
    def region(payload: bytes) -> tuple[int, int]:
        while len(buffer) % 4:
            buffer.append(0)
        start = len(buffer)
        buffer.extend(payload)
        return start, len(payload)

    pos_at, pos_len = region(struct.pack(f"<{len(positions)}f", *positions))
    uv_at, uv_len = region(struct.pack(f"<{len(uvs)}f", *uvs))
    idx_at, idx_len = region(struct.pack(f"<{len(indices)}I", *indices))
    img_at, img_len = region(image)

    document = {
        "asset": {"version": "2.0", "generator": "fbxtool test fixture"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"name": "quad", "mesh": 0}],
        "meshes": [{"name": "quad", "primitives": [{
            "attributes": {"POSITION": 0, "TEXCOORD_0": 1},
            "indices": 2,
            "material": 0,
        }]}],
        "materials": [{"name": "printed", "pbrMetallicRoughness": {
            "baseColorTexture": {"index": 0},
            "metallicFactor": 0.0,
            "roughnessFactor": 1.0,
        }}],
        "textures": [{"sampler": 0, "extensions": {"KHR_texture_basisu": {"source": 0}}}],
        "samplers": [{}],
        "images": [{"name": texture, "mimeType": "image/ktx2", "bufferView": 3}],
        "accessors": [
            {"bufferView": 0, "componentType": 5126, "count": 4, "type": "VEC3",
             "min": [-1.0, -1.0, 0.0], "max": [1.0, 1.0, 0.0]},
            {"bufferView": 1, "componentType": 5126, "count": 4, "type": "VEC2"},
            {"bufferView": 2, "componentType": 5125, "count": 6, "type": "SCALAR"},
        ],
        "bufferViews": [
            {"buffer": 0, "byteOffset": pos_at, "byteLength": pos_len},
            {"buffer": 0, "byteOffset": uv_at, "byteLength": uv_len},
            {"buffer": 0, "byteOffset": idx_at, "byteLength": idx_len},
            {"buffer": 0, "byteOffset": img_at, "byteLength": img_len},
        ],
        "buffers": [{"byteLength": len(buffer)}],
        "extensionsUsed": ["KHR_texture_basisu"],
        "extensionsRequired": ["KHR_texture_basisu"],
    }

    json_chunk = json.dumps(document).encode("utf-8")
    json_chunk += b" " * (-len(json_chunk) % 4)
    binary = bytes(buffer) + b"\x00" * (-len(buffer) % 4)
    total = 12 + 8 + len(json_chunk) + 8 + len(binary)
    out = bytearray(struct.pack("<4sII", b"glTF", 2, total))
    out += struct.pack("<II", len(json_chunk), 0x4E4F534A) + json_chunk
    out += struct.pack("<II", len(binary), 0x004E4942) + binary
    return bytes(out)


#: What ``build_draco_glb("sphere4")`` holds, from Draco's own decoder.
DRACO_GLB_TRIANGLES = 59
DRACO_GLB_POINTS = 44


def build_gltf(image: bytes | None = None,
               buffer_uri: str = "scene.bin") -> tuple[bytes, bytes]:
    """A .gltf document and the .bin it names, as two files."""
    image = checker_png() if image is None else image
    buffer, views = _gltf_buffer(image)
    document = gltf_document(image, buffer_uri=buffer_uri,
                             buffer_length=len(buffer), views=views)
    return json.dumps(document).encode("utf-8"), buffer


def build_glb(image: bytes | None = None) -> bytes:
    """The same scene as a .glb: JSON and buffer in one container."""
    image = checker_png() if image is None else image
    buffer, views = _gltf_buffer(image)
    document = gltf_document(image, buffer_uri=None,
                             buffer_length=len(buffer), views=views)
    json_chunk = json.dumps(document).encode("utf-8")
    json_chunk += b" " * (-len(json_chunk) % 4)
    binary = buffer + b"\x00" * (-len(buffer) % 4)

    total = 12 + 8 + len(json_chunk) + 8 + len(binary)
    out = bytearray(struct.pack("<4sII", b"glTF", 2, total))
    out += struct.pack("<II", len(json_chunk), 0x4E4F534A) + json_chunk
    out += struct.pack("<II", len(binary), 0x004E4942) + binary
    return bytes(out)

# ---------------------------------------------------------------- 3ds Max


_MAX_SECTOR = 512
_MAX_MINI = 64
_MAX_CUTOFF = 4096
_MAX_END = 0xFFFFFFFE
_MAX_FREE = 0xFFFFFFFF
_MAX_FAT = 0xFFFFFFFD


def _max_chunk(idn: int, payload: bytes, container: bool = False) -> bytes:
    """One chunk: its id, its length counting this header, and its payload.

    Bit 31 of the length is what says the payload is more chunks — which is
    the whole of how a reader knows a tree from a leaf.
    """
    length = 6 + len(payload)
    if container:
        length |= 0x80000000
    return struct.pack("<HI", idn, length) + payload


def _max_wide_chunk(idn: int, payload: bytes, container: bool = True) -> bytes:
    """The long form: a zero length, then the real one as 64 bits."""
    length = 14 + len(payload)
    if container:
        length |= 1 << 63
    return struct.pack("<HIQ", idn, 0, length) + payload


def _max_utf16(text: str) -> bytes:
    return text.encode("utf-16-le") + b"\x00\x00"


def _max_compound(streams: "dict[str, bytes]") -> bytes:
    """Pack named streams into an OLE2 compound file.

    Every stream here is small, so they all live in the mini stream — which is
    the arrangement a real .max uses for everything but its scene, and the one
    worth having a fixture exercise.
    """
    mini = bytearray()
    starts = {}
    for name, data in streams.items():
        starts[name] = len(mini) // _MAX_MINI
        mini += data + b"\x00" * (-len(data) % _MAX_MINI)

    mini_sectors = max(1, -(-len(mini) // _MAX_SECTOR))
    # 0 is the mini FAT, then the mini stream, then the directory, then the FAT.
    mini_start = 1
    dir_start = mini_start + mini_sectors
    dir_sectors = -(-(len(streams) + 1) * 128 // _MAX_SECTOR)
    fat_sector = dir_start + dir_sectors
    total = fat_sector + 1

    fat = [_MAX_FREE] * total
    fat[0] = _MAX_END
    for i in range(mini_sectors):
        fat[mini_start + i] = mini_start + i + 1 if i + 1 < mini_sectors else _MAX_END
    for i in range(dir_sectors):
        fat[dir_start + i] = dir_start + i + 1 if i + 1 < dir_sectors else _MAX_END
    fat[fat_sector] = _MAX_FAT

    mini_fat = []
    for name, data in streams.items():
        run = max(1, -(-len(data) // _MAX_MINI))
        at = starts[name]
        for i in range(run):
            mini_fat.append(at + i + 1 if i + 1 < run else _MAX_END)

    header = bytearray(_MAX_SECTOR)
    header[0:8] = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"
    struct.pack_into("<HH", header, 0x18, 0x003E, 3)
    struct.pack_into("<H", header, 0x1C, 0xFFFE)
    struct.pack_into("<HH", header, 0x1E, 9, 6)
    struct.pack_into("<I", header, 0x2C, 1)              # one FAT sector
    struct.pack_into("<I", header, 0x30, dir_start)
    struct.pack_into("<I", header, 0x38, _MAX_CUTOFF)
    struct.pack_into("<I", header, 0x3C, 0)              # the mini FAT
    struct.pack_into("<I", header, 0x40, 1)
    struct.pack_into("<I", header, 0x44, _MAX_END)       # no DIFAT sectors
    struct.pack_into("<I", header, 0x48, 0)
    for i in range(109):
        struct.pack_into("<I", header, 0x4C + i * 4, fat_sector if i == 0 else _MAX_FREE)

    def entry(name: str, kind: int, start: int, size: int, child: int = _MAX_FREE) -> bytes:
        block = bytearray(128)
        encoded = name.encode("utf-16-le") + b"\x00\x00"
        block[0:len(encoded)] = encoded
        struct.pack_into("<H", block, 64, len(encoded))
        block[66] = kind
        block[67] = 1                                    # black
        struct.pack_into("<III", block, 68, _MAX_FREE, _MAX_FREE, child)
        struct.pack_into("<I", block, 116, start)
        struct.pack_into("<Q", block, 120, size)
        return bytes(block)

    directory = bytearray()
    directory += entry("Root Entry", 5, mini_start, len(mini), child=1)
    for index, (name, data) in enumerate(streams.items()):
        # A flat chain rather than a red-black tree: every reader walks the
        # whole directory anyway, and a tree would only obscure the fixture.
        nxt = index + 2 if index + 1 < len(streams) else _MAX_FREE
        block = bytearray(entry(name, 2, starts[name], len(data)))
        struct.pack_into("<I", block, 72, nxt)           # right sibling
        directory += bytes(block)
    directory += b"\x00" * (-len(directory) % _MAX_SECTOR)

    out = bytearray(header)
    out += struct.pack("<%dI" % (_MAX_SECTOR // 4),
                       *(mini_fat + [_MAX_FREE] * (_MAX_SECTOR // 4 - len(mini_fat))))
    out += bytes(mini) + b"\x00" * (-len(mini) % _MAX_SECTOR)
    out += bytes(directory)
    out += struct.pack("<%dI" % (_MAX_SECTOR // 4),
                       *(fat + [_MAX_FREE] * (_MAX_SECTOR // 4 - len(fat))))
    return bytes(out)


def _max_class(name: str, super_id: int, class_id: int, dll: int = -1) -> bytes:
    return _max_chunk(0x2040,
                      _max_chunk(0x2060, struct.pack("<iIII", dll, class_id, 0, super_id))
                      + _max_chunk(0x2042, _max_utf16(name)),
                      container=True)


#: The two chunk ids a ParamBlock2 writes its parameters under.  Which one a
#: file uses is the writer's own business: 3ds Max 2012 keeps them at 0x000E
#: and later versions at 0x100E, with the same record behind both.
MAX_PARAM_IDS = (0x000E, 0x100E)


def _max_param_colour(param: int, rgb: "tuple[float, float, float]",
                      chunk: int = 0x100E) -> bytes:
    """One parameter of a ParamBlock2, valued as a colour.

    The id and the type come first, then flags, and a colour is the three
    floats on the end — which is all a reader can go on, since what the id
    *means* lives in the plugin and not in the file.
    """
    return _max_chunk(chunk, struct.pack("<HHIIIB3f", param, 2, 0, 0, 0, 0, *rgb))


def _max_param_float(param: int, value: float, chunk: int = 0x100E) -> bytes:
    """The same, valued as a float — one number on the end instead of three."""
    return _max_chunk(chunk, struct.pack("<HHIIIBf", param, 0, 0, 0, 0, 0, value))


#: How much flag a parameter carries between its type and its value is the
#: plugin's own business, and Corona writes four bytes fewer than the shaders
#: 3ds Max ships — nineteen bytes for a scalar, twenty-seven for a colour.
#: Written as the real files write it, since the size is exactly what a reader
#: has to get past to see any of these numbers at all.
_CORONA_FLAGS = struct.pack("<IIHB", 0x00010000, 0x00000092, 0, 0xC0)


def _max_param_small_colour(param: int, rgb: "tuple[float, float, float]") -> bytes:
    """A colour parameter as a plugin with a shorter header writes it."""
    return _max_chunk(0x100E, struct.pack("<HH", param, 2) + _CORONA_FLAGS
                      + struct.pack("<3f", *rgb))


def _max_param_small_float(param: int, value: float) -> bytes:
    """A scalar parameter as a plugin with a shorter header writes it."""
    return _max_chunk(0x100E, struct.pack("<HH", param, 0) + _CORONA_FLAGS
                      + struct.pack("<f", value))


def _max_param_texmap(param: int) -> bytes:
    """A slot for a map: shorter still, and carrying no value of its own.

    Read as a float it is 2.0, which would pass for a level or a glossiness if
    the type were not there to say what it is.
    """
    return _max_chunk(0x100E, struct.pack("<HH", param, 15)
                      + struct.pack("<IIH", 0x40000000, 0x00001081, 0)
                      + struct.pack("<B", 0x40))


def _max_float_controller(value: float) -> bytes:
    """A Bezier Float, which keeps its one value wrapped in a block of its own.

    This is where a node's position really lives: a Position XYZ holds nothing
    itself, it refers to three of these, one per axis.
    """
    return _max_chunk(0x0004,
                      _max_chunk(0x7127,
                                 _max_chunk(0x2501, struct.pack("<f", value)),
                                 container=True),
                      container=True)


def _max_asset_id(seed: int = 1) -> bytes:
    """The sixteen bytes an asset and the parameter block naming it share."""
    return bytes((seed + i) & 0xFF for i in range(16))


def _max_face(corners: "list[int]", material: int = 0, groups: int = 0) -> bytes:
    """A face: its degree, its corners, then the members its flags select.

    0x01 carries the smoothing groups, all thirty-two of them; 0x08 the
    material id, which is written only where there is one; and 0x20 the
    triangulation of an n-gon, which is two ints per triangle past the first
    and the reason a face is not a fixed size.
    """
    flags = 0x01 | (0x08 if material else 0) | (0x20 if len(corners) > 3 else 0)
    out = struct.pack("<I", len(corners))
    out += struct.pack("<%dI" % len(corners), *corners)
    out += struct.pack("<H", flags)
    out += struct.pack("<I", groups)
    if flags & 0x08:
        out += struct.pack("<H", material & 0xFFFF)
    if flags & 0x20:
        out += struct.pack("<%dI" % (2 * (len(corners) - 3)), *([0] * 2 * (len(corners) - 3)))
    return out


#: What a ``build_max(shader=...)`` scene says its one surface is. The order
#: is the one every shader 3ds Max ships lays its block out in: ambient,
#: diffuse and specular first, the floats behind them.
MAX_AMBIENT = (0.2, 0.2, 0.2)
MAX_DIFFUSE = (0.8, 0.1, 0.05)
MAX_SPECULAR = (1.0, 0.9, 0.8)
MAX_GLOSSINESS = 0.25


def shininess(glossiness: float) -> float:
    """A glossiness as the exponent an FBX carries, the way 3ds Max converts it.

    Two to the ten times the glossiness, which is what its own exporter
    writes: over the seventy materials of a car this project has both ways,
    every exponent in the ``.FBX`` is ``2 ** (10 * g)`` of the glossiness in
    the ``.max`` to four decimals.
    """
    return 2.0 ** (10.0 * glossiness)
MAX_SPECULAR_LEVEL = 0.6
#: What a V-Ray material lets through, which is the opposite of its opacity —
#: and the one thing a .max says about transparency at all.  Stored as a
#: colour, as a V-Ray refraction is; a glossiness would be a single float.
MAX_REFRACTION = (0.35, 0.35, 0.35)

#: Corona keeps a level beside each colour rather than folding it in, so what
#: the surface is depends on both.  A refraction level below one is a partly
#: see-through material; at zero the colour beside it means nothing at all.
MAX_DIFFUSE_LEVEL = 0.75
MAX_SPECULAR_LEVEL_CORONA = 0.5
MAX_REFRACTION_LEVEL = 0.4


def build_max(*, name: str = "cube001", with_uvs: bool = True,
              build: int = (20 * 1000) << 16 | 966,
              kind: str = "poly", compressed: bool = False,
              place: "tuple[float, float, float] | None" = None,
              offset: "tuple[float, float, float] | None" = None,
              smooth: int = 0, shader: "str | None" = None,
              groups: "list[int] | None" = None,
              materials: "list[int] | None" = None, slots: int = 0,
              child: "tuple[float, float, float] | None" = None,
              maps: "dict[int, str] | None" = None, maps_on: str = "material",
              colour_map: "tuple[float, float, float] | None" = None,
              reflect_map: "tuple[float, float, float] | None" = None,
              falloff_near: "tuple[float, float, float] | None" = None,
              fresnel_ior: "float | None" = None,
              refract_ior: "float | None" = None,
              layered_coat: "tuple[float, float, float] | None" = None,
              diffuse_level: float = MAX_DIFFUSE_LEVEL,
              blend_slots: "set[int] | None" = None,
              coat_amount: float = 1.0,
              material_class: "str | None" = None,
              param_chunk: int = 0x100E, assets_version: int = 3,
              glossiness: float = MAX_GLOSSINESS,
              symmetry: "tuple[int, float] | None" = None,
              under_a_dummy: "tuple[float, float, float] | None" = None) -> bytes:
    """A .max holding one cube under one node.

    The cube is a unit cube, which is enough to exercise every rule the reader
    depends on: the container, the chunk tree, the class table, the entity
    list, the face record and a map channel.

    ``kind`` chooses which class holds it — ``"poly"`` for an Editable Poly of
    six quads, ``"mesh"`` for an Editable Mesh of twelve triangles, which is a
    different layout in the same block. ``compressed`` gzips every stream, as
    a newer 3ds Max does.

    ``place`` puts the node somewhere, through the three per-axis controllers a
    Position XYZ really keeps its value in; ``offset`` sets the offset between
    the node and its mesh, which is a separate thing again; and ``smooth`` puts
    a subdividing modifier over the mesh, which is how a scene comes to store a
    cage rather than what was modelled.

    ``shader`` names a shader between the material and its parameter block —
    ``"Blinn"``, or a plugin's own name — and fills that block the way such a
    shader fills it.  Left out, the material holds a block of one colour, which
    is a plugin's material and all a reader can say about one.

    ``maps`` hangs a picture off the material under each reference key given —
    ``{7: 'colour.png', 10: 'bump.png'}`` is a V-Ray material's diffuse and its
    bump — each behind an Output, as a real one is.  ``material_class`` names
    the class the material itself is, which for a renderer's own material is
    that renderer's rather than ``Standard``.

    ``slots`` puts a Multi/Sub-Object of that many materials on the node, and
    ``blend_slots`` names the ones that hold a Blend of two rather than a plain
    material — a surface of its own, which must still take up its own slot.
    
    ``materials`` gives each face the slot it wears.  ``child`` hangs a second
    node off the first, placed there, which is how a scene says a wheel belongs
    to a body.

    ``reflect_map`` and ``falloff_near`` fill the *reflection* slot instead,
    with a CoronaColor and with a Falloff whose near end is that colour;
    ``fresnel_ior`` and ``refract_ior`` write Corona's two indices, which sit
    side by side and mean different things.  ``layered_coat`` wraps the whole
    material in a CoronaLayeredMtl whose coat amount is a Falloff of that
    colour, kept at a map slot rather than as a number.

    ``colour_map`` fills the diffuse slot with a CoronaColor of that colour —
    a map that is nothing but a colour, which is what leaves the colour beside
    it in the block a placeholder.

    ``symmetry`` puts a Symmetry modifier over the mesh, as ``(axis,
    threshold)`` — the reader has to mirror the cube itself, since the modifier
    stack is never run.  ``under_a_dummy`` hangs the node off a Dummy placed
    there, which is how a car keeps its wheels: the Dummy draws nothing, and a
    reader that writes no record for it leaves the wheels at the origin.

    ``param_chunk`` and ``assets_version`` write the two things a 3ds Max 2012
    file writes differently: its parameters under 0x000E rather than 0x100E,
    and an asset table naming a file by its path alone.
    """
    points = [
        (-1, -1, -1), (1, -1, -1), (1, 1, -1), (-1, 1, -1),
        (-1, -1, 1), (1, -1, 1), (1, 1, 1), (-1, 1, 1),
    ]
    quads = [
        [0, 1, 2, 3], [4, 7, 6, 5], [0, 4, 5, 1],
        [1, 5, 6, 2], [2, 6, 7, 3], [3, 7, 4, 0],
    ]

    if kind == "mesh":
        # An Editable Mesh: three bare floats a vertex, and a face of three
        # corners and two words about them.
        verts = struct.pack("<I", len(points))
        for x, y, z in points:
            verts += struct.pack("<3f", x, y, z)
        triangles = [q[:3] for q in quads] + [[q[0], q[2], q[3]] for q in quads]
        faces = struct.pack("<I", len(triangles))
        for a, b, c in triangles:
            faces += struct.pack("<5I", a, b, c, 0, 1)
        mesh = _max_chunk(0x0914, verts) + _max_chunk(0x0912, faces)
        if with_uvs:
            uvs = struct.pack("<I", 4)
            for u, v in ((0, 0), (1, 0), (1, 1), (0, 1)):
                uvs += struct.pack("<3f", u, v, 0)
            uv_faces = struct.pack("<I", len(triangles))
            uv_faces += b"".join(struct.pack("<3I", 0, 1, 2) for _ in triangles)
            mesh += _max_chunk(0x2394, uvs) + _max_chunk(0x2396, uv_faces)
        class_name = "Editable Mesh"
    else:
        verts = struct.pack("<I", len(points))
        for x, y, z in points:
            verts += struct.pack("<I3f", 0, x, y, z)
        # Each side of the cube in a group of its own, so every edge between
        # them is hard — which is what a cube's edges are.
        faces = struct.pack("<I", len(quads)) + b"".join(
            _max_face(q, material=(materials[i] if materials else 0),
                      groups=(groups[i] if groups else 0))
            for i, q in enumerate(quads))
        # Edges are counted but not needed; a plausible count keeps the report
        # true.
        edges = struct.pack("<I", 12) + b"\x00" * (12 * 12)
        mesh = (_max_chunk(0x0100, verts) + _max_chunk(0x010A, edges)
                + _max_chunk(0x011A, faces))
        if with_uvs:
            uvs = struct.pack("<I", 4)
            for u, v in ((0, 0), (1, 0), (1, 1), (0, 1)):
                uvs += struct.pack("<3f", u, v, 0)
            uv_faces = b"".join(struct.pack("<I4I", 4, 0, 1, 2, 3) for _ in quads)
            mesh += (_max_chunk(0x0120, struct.pack("<I", 2))
                     + _max_chunk(0x0128, uvs) + _max_chunk(0x012B, uv_faces))
        class_name = "Editable Poly"

    poly = _max_chunk(0x0000, _max_chunk(0x08FE, mesh, container=True), container=True)
    # A material, the parameter block holding its colour and the identifier of
    # the picture it wears, and the node that says the mesh wears it. A shader
    # fills that block out; without one it holds the single colour a plugin's
    # own material is read for.
    if shader and shader.strip().lower() == "vraymtl":
        # A renderer's own block, laid out as it pleases: the same ids mean
        # other things, and id 5 is a refraction colour where a shader 3ds Max
        # ships would keep a glossiness.
        block = (_max_param_colour(1, MAX_DIFFUSE)
                 + _max_param_colour(2, MAX_SPECULAR)
                 + _max_param_float(3, glossiness)
                 + _max_param_colour(5, MAX_REFRACTION))
    elif shader and shader.strip().lower().startswith("corona"):
        # Corona's own block: every channel a colour with a level beside it,
        # its glossiness far behind them at 180, and the whole of it written
        # four bytes shorter than the shaders 3ds Max ships write theirs.  The
        # map slot is there because it reads as a plausible number and must be
        # told from one by its type.
        block = (_max_param_small_colour(101, MAX_DIFFUSE)
                 + _max_param_small_colour(102, MAX_SPECULAR)
                 + _max_param_small_colour(103, MAX_REFRACTION)
                 + _max_param_small_float(121, diffuse_level)
                 + _max_param_small_float(122, MAX_SPECULAR_LEVEL_CORONA)
                 + _max_param_small_float(123, MAX_REFRACTION_LEVEL)
                 + _max_param_texmap(141)
                 + _max_param_small_float(180, MAX_GLOSSINESS))
        # Corona keeps two indices side by side: 182 shapes the reflection and
        # 183 is what light bends by on the way through.  Written with
        # different values on purpose — a reader taking the wrong one cannot
        # tell them apart otherwise, since 183 is 1.52 on nearly everything.
        if fresnel_ior is not None:
            block += _max_param_small_float(182, fresnel_ior)
        if refract_ior is not None:
            block += _max_param_small_float(183, refract_ior)
    elif shader:
        block = (_max_param_colour(0, MAX_AMBIENT, param_chunk)
                 + _max_param_colour(1, MAX_DIFFUSE, param_chunk)
                 + _max_param_colour(2, MAX_SPECULAR, param_chunk)
                 + _max_param_float(5, MAX_GLOSSINESS, param_chunk)
                 + _max_param_float(6, MAX_SPECULAR_LEVEL, param_chunk))
    else:
        block = _max_param_colour(1, MAX_DIFFUSE, param_chunk)
    # The mesh is entity 0, the node 1, its material's parameters 2 and the
    # material itself 3; anything else is numbered from there.
    extra = b""
    nxt = 4
    node_refs = []
    holds = 0                      # what the node points at for its object
    wears = 3                      # and what it points at for its material

    # The maps, under the key each slot has: for a V-Ray material 7 is the
    # diffuse and 10 the bump, and which of them a reader picks is the
    # difference between a tyre's colour and its tread.  Each is a Bitmap
    # behind an Output, as a real one is, so the slot has to be followed down
    # rather than matched at its first step.  These come first so that the
    # parameter block can name them, which is where Corona keys its own.
    map_refs = []
    map_assets = []
    for at, (key, filename) in enumerate(sorted((maps or {}).items())):
        asset_id = _max_asset_id(64 + at * 32)
        map_assets.append((asset_id, filename))
        extra += _max_chunk(0x0002,
                            _max_chunk(0x0003, bytes(8) + asset_id + bytes(8)),
                            container=True)
        extra += _max_chunk(0x000B,                 # an Output, wrapping it
                            _max_chunk(0x2034, struct.pack("<I", nxt)),
                            container=True)
        extra += _max_chunk(0x000C,                 # the Bitmap that holds it
                            _max_chunk(0x2034, struct.pack("<I", nxt + 1)),
                            container=True)
        map_refs.append((key, nxt + 2))
        nxt += 3

    # A CoronaColor in the diffuse slot: a map that is nothing but a colour,
    # which is what Corona fills a slot with when there is no picture. The
    # colour beside it in the block is then a placeholder.
    if colour_map is not None:
        extra += _max_chunk(0x0002,
                            _max_param_colour(52, colour_map, param_chunk),
                            container=True)
        extra += _max_chunk(0x0010,
                            _max_chunk(0x2034, struct.pack("<I", nxt)),
                            container=True)
        map_refs.append((0 if maps_on == "block" else 7, nxt + 1))
        nxt += 2

    # And one in the reflection slot, which is slot 1.  Corona's own colour
    # beside it stays white, as a real one does, so what arrives says which of
    # the two was read.
    if reflect_map is not None:
        extra += _max_chunk(0x0002,
                            _max_param_colour(52, reflect_map, param_chunk),
                            container=True)
        extra += _max_chunk(0x0010,
                            _max_chunk(0x2034, struct.pack("<I", nxt)),
                            container=True)
        map_refs.append((1, nxt + 1))
        nxt += 2

    # A Falloff in that slot instead: not a colour but a ramp between two of
    # them, near at parameter 0 and far at 4, with nothing beneath it.
    if falloff_near is not None:
        extra += _max_chunk(0x0002,
                            _max_param_colour(0, falloff_near, param_chunk)
                            + _max_param_colour(4, (1.0, 1.0, 1.0), param_chunk),
                            container=True)
        extra += _max_chunk(0x0011,
                            _max_chunk(0x2034, struct.pack("<I", nxt)),
                            container=True)
        map_refs.append((1, nxt + 1))
        nxt += 2

    # Corona keys its maps on the block rather than on the material, so where
    # the caller asks for that the block is what carries them.
    keyed = b""
    if maps_on == "block" and map_refs:
        words = [len(map_refs)]
        for key, target in sorted(map_refs):
            words += [key, target]
        keyed = _max_chunk(0x2035, struct.pack("<%dI" % len(words), *words))
        map_refs = []
    params = _max_chunk(0x0002,
                        keyed + block
                        + _max_chunk(0x0003, bytes(8) + _max_asset_id() + bytes(8)),
                        container=True)

    # What the material refers to for its parameters. A Standard material
    # keeps a shader between the two, and it is the shader that says what the
    # numbers in the block are; a renderer's own material is its own class and
    # holds the block directly, which is also where it keys its maps.
    parameters = 2
    if shader and not material_class:
        parameters = nxt
        extra += _max_chunk(0x0008,
                            _max_chunk(0x2034, struct.pack("<I", 2)),
                            container=True)
        nxt += 1

    # Every material keeps its name in the same block; a plugin's material
    # keeps that block under an id of its own, which is Corona's whole reason
    # for coming out unnamed.
    base_id = 0x0FA0 if (shader or "").strip().lower().startswith("corona") else 0x5431
    words = [0x10, 1, parameters]
    for key, target in sorted(map_refs):
        words += [key, target]
    material = _max_chunk(0x0003,
                          _max_chunk(0x2035,
                                     struct.pack("<%dI" % len(words), *words))
                          + _max_chunk(base_id,
                                       _max_chunk(0x4001, _max_utf16("Body paint")),
                                       container=True),
                          container=True)

    # A Multi/Sub-Object over materials of its own, which is the list a face's
    # material id picks a slot out of.
    if slots:
        held = []
        for at in range(slots):
            extra += _max_chunk(0x0002,
                                _max_param_colour(1, (at / 10.0, 0.5, 0.25), param_chunk),
                                container=True)
            extra += _max_chunk(0x0003,
                                _max_chunk(0x2035, struct.pack("<3I", 0x10, 1, nxt))
                                + _max_chunk(0x5431,
                                             _max_chunk(0x4001, _max_utf16(f"slot{at}")),
                                             container=True),
                                container=True)
            held.append(nxt + 1)
            nxt += 2
            # A slot that holds a Blend rather than a plain material: two
            # materials mixed, which is a surface of its own and not a list of
            # two. Read as a list it is written as no material at all, and
            # every slot behind it moves up to fill the gap.
            if blend_slots and at in blend_slots:
                extra += _max_chunk(0x0002,
                                    _max_param_colour(1, (0.9, 0.1, 0.9), param_chunk)
                                    + _max_param_colour(2, (1.0, 1.0, 1.0), param_chunk)
                                    + _max_param_float(3, 1.0, param_chunk)
                                    + _max_param_float(63, 999.0, param_chunk),
                                    container=True)
                extra += _max_chunk(0x0003,
                                    _max_chunk(0x2035, struct.pack("<3I", 0x10, 1, nxt))
                                    + _max_chunk(0x5431,
                                                 _max_chunk(0x4001,
                                                            _max_utf16(f"coat{at}")),
                                                 container=True),
                                    container=True)
                # A Blend keeps its name under 0x4000 rather than the id
                # 3ds Max's own materials use, which is why blends came out
                # numbered while everything beside them was named.
                # How much of the coat shows, which a VRayBlendMtl keeps as
                # a colour at parameter 2 of the block it holds.
                extra += _max_chunk(0x0002,
                                    _max_param_colour(2, (coat_amount,) * 3,
                                                      param_chunk),
                                    container=True)
                extra += _max_chunk(0x000D,
                                    _max_chunk(0x2034,
                                               struct.pack("<3I", held[-1], nxt + 1,
                                                           nxt + 2))
                                    + _max_chunk(0x4000,
                                                 _max_chunk(0x4001,
                                                            _max_utf16(f"blend{at}")),
                                                 container=True),
                                    container=True)
                held[-1] = nxt + 3
                nxt += 4
        wears = nxt
        extra += _max_chunk(0x0009,
                            _max_chunk(0x2034,
                                       struct.pack("<%dI" % len(held), *held))
                            + _max_chunk(0x5431,
                                         _max_chunk(0x4001, _max_utf16("Multi")),
                                         container=True),
                            container=True)
        nxt += 1

    # A CoronaLayeredMtl over whatever the node wore: that material as its
    # base, a mirror over it as its coat, and how much of the coat shows kept
    # as a *map* at slot 11 rather than as a number — a Falloff, black facing
    # you, which is a coat seen along the edges of a panel and nowhere else.
    if layered_coat is not None:
        base_at = wears
        extra += _max_chunk(0x0002,
                            _max_param_small_colour(101, (0.0, 0.0, 0.0))
                            + _max_param_small_colour(102, (1.0, 1.0, 1.0))
                            + _max_param_small_float(121, 1.0)
                            + _max_param_small_float(122, 1.0)
                            + _max_param_small_float(180, 1.0)
                            + _max_param_small_float(182, 999.0),
                            container=True)
        extra += _max_chunk(0x0003,
                            _max_chunk(0x2034, struct.pack("<I", nxt))
                            + _max_chunk(0x0FA0,
                                         _max_chunk(0x4001, _max_utf16("Coat")),
                                         container=True),
                            container=True)
        coat_at = nxt + 1
        nxt += 2
        extra += _max_chunk(0x0002,
                            _max_param_colour(0, layered_coat, param_chunk)
                            + _max_param_colour(4, (1.0, 1.0, 1.0), param_chunk),
                            container=True)
        extra += _max_chunk(0x0011,
                            _max_chunk(0x2034, struct.pack("<I", nxt)),
                            container=True)
        amount_at = nxt + 1
        nxt += 2
        extra += _max_chunk(0x0002,
                            _max_chunk(0x2035, struct.pack("<7I", 3, 0, base_at,
                                                           1, coat_at,
                                                           11, amount_at)),
                            container=True)
        extra += _max_chunk(0x0012,
                            _max_chunk(0x2034, struct.pack("<I", nxt))
                            + _max_chunk(0x4000,
                                         _max_chunk(0x4001, _max_utf16("Layered")),
                                         container=True),
                            container=True)
        wears = nxt + 1
        nxt += 2
    node_refs.append((3, wears))

    if smooth:
        extra += _max_chunk(0x0002,
                            _max_chunk(0x100E,
                                       struct.pack("<HHIIIBi", 0, 1, 0, 0, 0, 0, smooth)),
                            container=True)
        extra += _max_chunk(0x0007,
                            _max_chunk(0x2034, struct.pack("<2I", nxt, 0)),
                            container=True)
        holds = nxt + 1
        nxt += 2
    node_refs.append((1, holds))

    if place is not None:
        axes = nxt
        extra += b"".join(_max_float_controller(v) for v in place)
        nxt += 3
        extra += _max_chunk(0x0005,
                            _max_chunk(0x2034, struct.pack("<3I", axes, axes + 1, axes + 2)),
                            container=True)
        extra += _max_chunk(0x0006,
                            _max_chunk(0x2034, struct.pack("<I", nxt)),
                            container=True)
        node_refs.append((0, nxt + 1))
        nxt += 2

    node_offset = b""
    if offset is not None:
        node_offset = (_max_chunk(0x096A, struct.pack("<3f", *offset))
                       + _max_chunk(0x096B, struct.pack("<4f", 0.0, 0.0, 0.0, 1.0))
                       + _max_chunk(0x096C, struct.pack("<3f", 1.0, 1.0, 1.0)))

    # A second node hung off the first and placed where it says, sharing the
    # object and the material: a wheel linked to a body, whose controller says
    # where it stands relative to that body and not to the world.
    node_parent = b""
    if child is not None:
        axes = nxt
        extra += b"".join(_max_float_controller(v) for v in child)
        nxt += 3
        extra += _max_chunk(0x0005,
                            _max_chunk(0x2034, struct.pack("<3I", axes, axes + 1, axes + 2)),
                            container=True)
        extra += _max_chunk(0x0006,
                            _max_chunk(0x2034, struct.pack("<I", nxt)),
                            container=True)
        controller = nxt + 1
        nxt += 2
        # The scene's own root is a node like any other; naming it is how a
        # part says it hangs off nothing.
        extra += _max_chunk(0x000A,
                            _max_chunk(0x0962, _max_utf16("Scene Root")),
                            container=True)
        node_parent = _max_chunk(0x0960, struct.pack("<2I", nxt, 0x1C00))
        nxt += 1
        words = [0x10, 0, controller, 1, holds, 3, wears]
        extra += _max_chunk(0x0001,
                            _max_chunk(0x2035, struct.pack("<%dI" % len(words), *words))
                            + _max_chunk(0x0962, _max_utf16(f"{name}_child"))
                            + _max_chunk(0x0960, struct.pack("<2I", 1, 0x1000)),
                            container=True)
        nxt += 1

    # A Symmetry modifier over the mesh. What the node points at for its object
    # becomes the modifier, and the modifier points down at the mesh, which is
    # the stack a reader has to walk.
    if symmetry is not None:
        axis, threshold = symmetry
        extra += _max_chunk(0x0002,
                            _max_chunk(0x100E,
                                       struct.pack("<HHIIIBi", 0, 1, 0, 0, 0, 0, axis))
                            + _max_chunk(0x100E,
                                         struct.pack("<HHIIIBf", 3, 0, 0, 0, 0, 0,
                                                     threshold)),
                            container=True)
        extra += _max_chunk(0x000E,
                            _max_chunk(0x2034, struct.pack("<2I", nxt, holds)),
                            container=True)
        holds = nxt + 1
        nxt += 2
        node_refs = [(key, target) for key, target in node_refs if key != 1]
        node_refs.append((1, holds))

    # A Dummy standing over the node: it draws nothing and exists only to place
    # what hangs off it, which is how a car keeps its four wheels together.
    if under_a_dummy is not None:
        axes = nxt
        extra += b"".join(_max_float_controller(v) for v in under_a_dummy)
        nxt += 3
        extra += _max_chunk(0x0005,
                            _max_chunk(0x2034, struct.pack("<3I", axes, axes + 1, axes + 2)),
                            container=True)
        extra += _max_chunk(0x0006,
                            _max_chunk(0x2034, struct.pack("<I", nxt)),
                            container=True)
        controller = nxt + 1
        nxt += 2
        extra += _max_chunk(0x000F,
                            _max_chunk(0x0962, _max_utf16("dummy object")),
                            container=True)
        dummy_object = nxt
        nxt += 1
        dummy_words = [0x10, 0, controller, 1, dummy_object]
        extra += _max_chunk(0x0001,
                            _max_chunk(0x2035,
                                       struct.pack("<%dI" % len(dummy_words), *dummy_words))
                            + _max_chunk(0x0962, _max_utf16("Group001")),
                            container=True)
        node_parent = _max_chunk(0x0960, struct.pack("<2I", nxt, 0x1000))
        nxt += 1

    words = [0x10]
    for key, target in sorted(node_refs):
        words += [key, target]
    node = _max_chunk(0x0001,
                      _max_chunk(0x2035, struct.pack("<%dI" % len(words), *words))
                      + _max_chunk(0x0962, _max_utf16(name)) + node_offset + node_parent,
                      container=True)
    scene = _max_wide_chunk(0x2023, poly + node + params + material + extra)

    classes = (_max_class(class_name, 0x10, 0x1BF8338D, dll=0)
               + _max_class("Node", 0x01, 0x01)
               + _max_class("ParamBlock2", 0x82, 0x82)
               # A renderer's own material is its own class, where 3ds Max's
               # is a Standard with a shader under it.
               + _max_class(material_class or "Standard", 0xC00, 0x02)
               + _max_class("Bezier Float", 0x9003, 0x2007)
               + _max_class("Position XYZ", 0x900B, 0x118F7E02)
               + _max_class("Position/Rotation/Scale", 0x9008, 0x2005)
               + _max_class("TurboSmooth", 0x810, 0x0D727B3E)
               # Class 8, which is what a shader entity's chunk id names.
               + _max_class(shader or "Shader", 0xC02, 0x02)
               + _max_class("Multi/Sub-Object", 0xC00, 0x0200)
               + _max_class("RootNode", 0x01, 0x02)
               + _max_class("Output", 0xC40, 0x0280)
               + _max_class("Bitmap", 0xC10, 0x0240)
               # A renderer's own blend, which is the one that states how
               # much of its coat shows.
               + _max_class("VRayBlendMtl", 0xC00, 0x0210)
               + _max_class("Symmetry", 0x810, 0x00B7)
               # A Dummy is a helper, not geometry: superclass 0x50, which is
               # what keeps it out of the tally of objects with no mesh.
               + _max_class("Dummy", 0x50, 8872500)
               + _max_class("CoronaColor", 0xC10, 0x0300)
               # A Falloff is a ramp between two colours by viewing angle, and
               # a layered material is a base with coats over it that keeps how
               # much of each shows as a map slot rather than as a number.
               + _max_class("Falloff", 0xC10, 0x0310)
               + _max_class("CoronaLayeredMtl", 0xC00, 0x0320))
    dlls = _max_chunk(0x2038,
                      _max_chunk(0x2039, _max_utf16("Editable Poly (Autodesk)"))
                      + _max_chunk(0x2037, _max_utf16("epoly.dlo")),
                      container=True)
    # The newer table names the file and the path it lived at; the older one,
    # which is what 3ds Max 2012 writes, keeps the path alone.
    def asset_record(asset_id: bytes, filename: str) -> bytes:
        path = f"C:\\models\\{filename}"
        out = asset_id + struct.pack("<I", 6) + _max_utf16("Bitmap")
        if assets_version != 2:
            out += struct.pack("<I", len(filename)) + _max_utf16(filename)
        return out + struct.pack("<I", len(path)) + _max_utf16(path)

    assets = asset_record(_max_asset_id(), "paint.jpg")
    for asset_id, filename in map_assets:
        assets += asset_record(asset_id, filename)
    assets += b"\x00" * 16
    config = _max_chunk(0x2170, struct.pack("<I", build))

    streams = {
        "Scene": scene,
        "ClassDirectory3": classes,
        "DllDirectory": dlls,
        f"FileAssetMetaData{assets_version}": assets,
        "SaveConfigData": config,
    }
    if compressed:
        # mtime zero so the same scene is the same bytes twice running.
        streams = {name: gzip.compress(data, mtime=0) for name, data in streams.items()}
    return _max_compound(streams)


# ------------------------------------------------- a metallic-roughness map

#: The trap this fixture is built around: a material that states no
#: `metallicFactor` at all, so glTF's default of 1 applies and the real
#: metalness lives in the blue channel of a map.  Read as the factor alone the
#: surface is a mirror, and a mirror has no diffuse left to show its own colour.
FINISH_BASE_COLOUR = (200, 40, 40)          # a plain red, obvious when it shows


def finish_map_png(size: int = 32) -> bytes:
    """A metallic-roughness map: rough throughout, metal on one half only.

    glTF keeps roughness in green and metalness in blue.  Splitting the
    metalness down the middle is what makes the map testable on its own — the
    two halves can only differ on screen if something sampled it.
    """
    out = bytearray()
    for _ in range(size):
        for x in range(size):
            metal = 255 if x >= size // 2 else 0
            out += bytes((0, 230, metal))
    return png(size, size, bytes(out))


def build_finish_glb() -> bytes:
    """A .glb of one quad wearing a base colour and a metallic-roughness map.

    Two triangles facing +Z, spanning U across the quad so the map's two halves
    land on the two halves of the face.
    """
    corners = [(-1.0, -1.0), (1.0, -1.0), (1.0, 1.0), (-1.0, 1.0)]
    attributes = bytearray()
    for x, y in corners:
        attributes += struct.pack("<3f", x, y, 0.0)         # position
        attributes += struct.pack("<3f", 0.0, 0.0, 1.0)     # normal
        attributes += struct.pack("<2f", (x + 1) / 2, (1 - y) / 2)   # uv
    indices = struct.pack("<6H", 0, 1, 2, 0, 2, 3)
    colour = png(1, 1, bytes(FINISH_BASE_COLOUR))
    finish = finish_map_png()

    buffer = bytearray()
    views = []

    def view(payload: bytes, **extra) -> int:
        buffer.extend(b"\x00" * (-len(buffer) % 4))
        views.append({"buffer": 0, "byteOffset": len(buffer),
                      "byteLength": len(payload), **extra})
        buffer.extend(payload)
        return len(views) - 1

    attribute_view = view(bytes(attributes), byteStride=32)
    index_view = view(indices)
    colour_view = view(colour)
    finish_view = view(finish)

    document = {
        "asset": {"version": "2.0", "generator": "fbxtool finish fixture"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"name": "quad", "mesh": 0}],
        "meshes": [{"name": "quad", "primitives": [{
            "attributes": {"POSITION": 0, "NORMAL": 1, "TEXCOORD_0": 2},
            "indices": 3, "material": 0,
        }]}],
        "materials": [{
            "name": "finish",
            # No metallicFactor and no baseColorFactor: both default, which is
            # the whole point of the fixture.
            "pbrMetallicRoughness": {
                "baseColorTexture": {"index": 0},
                "metallicRoughnessTexture": {"index": 1},
            },
        }],
        "textures": [{"source": 0}, {"source": 1}],
        "images": [
            {"name": "finishBase", "mimeType": "image/png", "bufferView": colour_view},
            {"name": "finishMap", "mimeType": "image/png", "bufferView": finish_view},
        ],
        "buffers": [{"byteLength": len(buffer)}],
        "bufferViews": views,
        "accessors": [
            {"bufferView": attribute_view, "byteOffset": 0, "componentType": 5126,
             "count": 4, "type": "VEC3",
             "min": [-1.0, -1.0, 0.0], "max": [1.0, 1.0, 0.0]},
            {"bufferView": attribute_view, "byteOffset": 12, "componentType": 5126,
             "count": 4, "type": "VEC3"},
            {"bufferView": attribute_view, "byteOffset": 24, "componentType": 5126,
             "count": 4, "type": "VEC2"},
            {"bufferView": index_view, "componentType": 5123, "count": 6, "type": "SCALAR"},
        ],
    }
    json_chunk = json.dumps(document).encode("utf-8")
    json_chunk += b" " * (-len(json_chunk) % 4)
    binary = bytes(buffer) + b"\x00" * (-len(buffer) % 4)
    total = 12 + 8 + len(json_chunk) + 8 + len(binary)
    out = bytearray(struct.pack("<4sII", b"glTF", 2, total))
    out += struct.pack("<II", len(json_chunk), 0x4E4F534A) + json_chunk
    out += struct.pack("<II", len(binary), 0x004E4942) + binary
    return bytes(out)


# ------------------------------------------------- DirectDraw Surface (.dds)

#: Header flags: caps, height, width, pixel format, mip count.
_DDS_FLAGS = 0x1007
_DDPF_ALPHAPIXELS = 0x1
_DDPF_FOURCC = 0x4
_DDPF_RGB = 0x40
_DDPF_LUMINANCE = 0x20000


def _dds_header(width: int, height: int, *, fourcc: bytes = b"",
                bits: int = 0, masks=(0, 0, 0, 0), pixel_flags: int = 0) -> bytes:
    """The 128 bytes in front of every DDS surface."""
    flags = _DDPF_FOURCC if fourcc else pixel_flags
    pixel_format = struct.pack("<II4sIIIII", 32, flags, fourcc or b"\x00" * 4,
                               bits, *masks)
    return (b"DDS " + struct.pack("<IIIIIII", 124, _DDS_FLAGS, height, width, 0, 0, 1)
            + b"\x00" * 44 + pixel_format + struct.pack("<IIIII", 0x1000, 0, 0, 0, 0))


def _dds_dx10(width: int, height: int, dxgi: int, payload: bytes) -> bytes:
    """A surface whose layout is stated as a DXGI number rather than as masks.

    A file written this way says `DDPF_FOURCC` and nothing else in its flags,
    so a reader that decides what to do from the flags alone refuses every one
    of them however well it knows the format underneath.
    """
    return (_dds_header(width, height, fourcc=b"DX10")
            + struct.pack("<IIIII", dxgi, 3, 0, 1, 0) + payload)


class _Bits:
    """A little-endian bit writer, which is the order a BC7 block is read in."""

    def __init__(self) -> None:
        self.bits: list[int] = []

    def put(self, value: int, count: int) -> "_Bits":
        for n in range(count):
            self.bits.append((value >> n) & 1)
        return self

    def block(self) -> bytes:
        if len(self.bits) != 128:
            raise ValueError(f"a BC7 block is 128 bits, not {len(self.bits)}")
        out = bytearray(16)
        for at, bit in enumerate(self.bits):
            if bit:
                out[at >> 3] |= 1 << (at & 7)
        return bytes(out)


def bc7_mode6(low=(0, 0, 0, 0), high=(255, 255, 255, 255), indices=None) -> bytes:
    """A BC7 tile in mode 6: one subset, four-bit indices, alpha of its own.

    Mode 6 is what most of a photograph comes out as — one pair of endpoints
    across the whole tile and sixteen bits of index to place each pixel between
    them. Seven bits a channel with a parity bit under each, so 127 with a one
    beneath it is 255 and 0 with a zero is nothing.

    *indices* is sixteen values 0-15; the first is the anchor and stores three
    bits, its top bit being implicitly zero.
    """
    picks = list(indices or [0] * 16)
    if len(picks) != 16:
        raise ValueError("a tile has sixteen pixels")
    if picks[0] > 7:
        raise ValueError("the anchor stores three bits, so 0-7")
    out = _Bits().put(0, 6).put(1, 1)                  # mode 6
    for channel in range(4):                           # R, G, B then A
        out.put(low[channel] >> 1, 7)
        out.put(high[channel] >> 1, 7)
    out.put(low[0] & 1, 1).put(high[0] & 1, 1)         # the two parity bits
    out.put(picks[0], 3)
    for pick in picks[1:]:
        out.put(pick, 4)
    return _dds_dx10(4, 4, 98, out.block())


def bc7_mode1(partition: int, low=(0, 0, 0), high=(255, 255, 255)) -> bytes:
    """A BC7 tile in mode 1: two subsets, and every index left at zero.

    Which makes each pixel its own subset's first endpoint, so what comes out
    is the partition drawn in two colours — the one thing a wrong partition
    table cannot survive.
    """
    out = _Bits().put(0, 1).put(1, 1)                  # mode 1
    out.put(partition, 6)
    for channel in range(3):                           # six-bit endpoints
        out.put(low[channel] >> 2, 6).put(low[channel] >> 2, 6)
        out.put(high[channel] >> 2, 6).put(high[channel] >> 2, 6)
    out.put(1, 1).put(1, 1)                            # one parity per subset
    out.put(0, 46)                                     # every index at zero
    return _dds_dx10(4, 4, 98, out.block())


def dds_bgrx(width: int, height: int, pixels: bytes, dxgi: int = 93) -> bytes:
    """A B8G8R8X8 surface — the fourth byte is padding, not an alpha."""
    return _dds_dx10(width, height, dxgi, pixels)


def rgb565(red: int, green: int, blue: int) -> int:
    """One 8-bit colour as the 16-bit endpoint a block format stores."""
    return ((red >> 3) << 11) | ((green >> 2) << 5) | (blue >> 3)


def dds_bc1(colours=(0xF800, 0x001F), selectors=(0, 1, 2, 3)) -> bytes:
    """One 4x4 BC1 tile: two endpoints and sixteen two-bit selectors.

    The first four selectors are *selectors*; the rest pick endpoint zero. With
    the endpoints in descending order the tile is in its four-colour mode,
    which is what a plain opaque texture uses.
    """
    bits = 0
    for at, pick in enumerate(selectors):
        bits |= (pick & 3) << (2 * at)
    return _dds_header(4, 4, fourcc=b"DXT1") + struct.pack("<HHI", *colours, bits)


def dds_bc3(alpha=(255, 0), colours=(0xF800, 0x001F)) -> bytes:
    """One 4x4 BC3 tile whose sixteen alpha selectors count 0..7 twice.

    With the alpha endpoints in descending order the block interpolates eight
    values, which is the mode a real texture is written in.
    """
    selectors = 0
    for at in range(16):
        selectors |= (at % 8) << (3 * at)
    block = bytes(alpha) + selectors.to_bytes(6, "little")
    return (_dds_header(4, 4, fourcc=b"DXT5") + block
            + struct.pack("<HHI", *colours, 0))


def dds_bgra(width: int, height: int, pixels: bytes) -> bytes:
    """An uncompressed B8G8R8A8 surface — *pixels* is BGRA, as stored."""
    return _dds_header(width, height, bits=32,
                       masks=(0x00FF0000, 0x0000FF00, 0x000000FF, 0xFF000000),
                       pixel_flags=_DDPF_RGB | _DDPF_ALPHAPIXELS) + pixels


def dds_luminance(width: int, height: int, pixels: bytes) -> bytes:
    """An eight-bit greyscale surface, one byte a pixel."""
    return _dds_header(width, height, bits=8, masks=(0xFF, 0, 0, 0),
                       pixel_flags=_DDPF_LUMINANCE) + pixels


# --------------------------------------------------- Assetto Corsa (.kn5)

KN5_MAGIC = b"sc6969"


def _kn5_text(value: str) -> bytes:
    raw = value.encode("utf-8")
    return struct.pack("<I", len(raw)) + raw


def livery_png(rows, *, alpha: bool = True) -> bytes:
    """A paint chip as Content Manager writes one: an eight-bit PNG.

    *rows* is a list of rows, each a list of ``(r, g, b)`` or ``(r, g, b, a)``.
    Written unfiltered, one row at a time, which is what a picture this small
    comes out as.
    """
    height = len(rows)
    width = len(rows[0])
    channels = 4 if alpha else 3
    raw = bytearray()
    for row in rows:
        raw.append(0)                     # filter: none
        for pixel in row:
            values = list(pixel) + ([255] if alpha and len(pixel) == 3 else [])
            raw += bytes(values[:channels])

    def chunk(tag: bytes, body: bytes) -> bytes:
        return (struct.pack(">I", len(body)) + tag + body
                + struct.pack(">I", zlib.crc32(tag + body) & 0xFFFFFFFF))

    header = struct.pack(">IIBBBBB", width, height, 8, 6 if alpha else 2, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header)
            + chunk(b"IDAT", zlib.compress(bytes(raw)))
            + chunk(b"IEND", b""))


def kn5_property(name: str, a: float = 0.0, b=(0.0, 0.0), c=(0.0, 0.0, 0.0),
                 d=(0.0, 0.0, 0.0, 0.0)) -> bytes:
    """One shader parameter: a name and four value groups, all written."""
    return (_kn5_text(name) + struct.pack("<f", a) + struct.pack("<2f", *b)
            + struct.pack("<3f", *c) + struct.pack("<4f", *d))


def kn5_material(name: str, shader: str = "ksPerPixel", *, blend: int = 0,
                 alpha_tested: bool = False, depth_mode: int = 0,
                 properties: bytes = b"", property_count: int = 0,
                 slots=()) -> bytes:
    """One material: its shader, how it blends, its parameters and its maps."""
    out = bytearray(_kn5_text(name) + _kn5_text(shader))
    out += struct.pack("<BBi", blend, 1 if alpha_tested else 0, depth_mode)
    out += struct.pack("<i", property_count) + properties
    out += struct.pack("<i", len(slots))
    for slot, number, texture in slots:
        out += _kn5_text(slot) + struct.pack("<i", number) + _kn5_text(texture)
    return bytes(out)


def kn5_dummy(name: str, matrix, children: bytes = b"", child_count: int = 0,
              active: bool = True) -> bytes:
    """A node that places what hangs off it — Direct3D's row-major 4x4."""
    return (struct.pack("<i", 1) + _kn5_text(name)
            + struct.pack("<i", child_count) + bytes((1 if active else 0,))
            + struct.pack("<16f", *matrix) + children)


def kn5_mesh(name: str, vertices, indices, material: int = 0, *,
             visible: bool = True, renderable: bool = True, layer: int = 0,
             lod=(0.0, 0.0), radius: float = 1.0) -> bytes:
    """A mesh node: interleaved vertices, ushort indices, then the tail.

    *vertices* is a list of ``(position, normal, uv, tangent)``; the game
    writes all four for every vertex, 44 bytes apiece.
    """
    out = bytearray(struct.pack("<i", 2) + _kn5_text(name)
                    + struct.pack("<i", 0) + b"\x01")
    out += bytes((1, 1 if visible else 0, 0))
    out += struct.pack("<I", len(vertices))
    for position, normal, uv, tangent in vertices:
        out += struct.pack("<3f3f2f3f", *position, *normal, *uv, *tangent)
    out += struct.pack("<I", len(indices))
    out += struct.pack(f"<{len(indices)}H", *indices)
    out += struct.pack("<iI", material, layer)
    out += struct.pack("<2f", *lod)
    out += struct.pack("<3f", 0.0, 0.0, 0.0) + struct.pack("<f", radius)
    out += bytes((1 if renderable else 0,))
    return bytes(out)


def build_kn5(version: int = 6, *, textures=(), materials=(), tree: bytes = b"",
              empty_slots: int = 0) -> bytes:
    """An Assetto Corsa model file from the parts above.

    *textures* is ``(name, bytes)`` pairs, written as the game writes them —
    a kind, a name, a length and the payload — and *materials* is already
    encoded by :func:`kn5_material`.

    *empty_slots* writes that many empty entries in front of the real ones: a
    kind of nought and nothing else, which three of the cars to hand open with.
    They count towards the table's own total.
    """
    out = bytearray(KN5_MAGIC + struct.pack("<i", version))
    if version > 5:
        out += struct.pack("<i", 0)
    out += struct.pack("<i", len(textures) + empty_slots)
    for _ in range(empty_slots):
        out += struct.pack("<i", 0)
    for name, payload in textures:
        out += struct.pack("<i", 1) + _kn5_text(name)
        out += struct.pack("<I", len(payload)) + payload
    out += struct.pack("<i", len(materials))
    for material in materials:
        out += material
    out += tree
    return bytes(out)

#: A cube's eight corners for the kn5 fixtures, the near face then the far one.
#: Named apart from the `.blend` builder's own cube above, which is six quads
#: rather than twelve triangles and is read through the SDNA.
_KN5_CUBE_CORNERS = [(-1, -1, -1), (1, -1, -1), (1, 1, -1), (-1, 1, -1),
                     (-1, -1, 1), (1, -1, 1), (1, 1, 1), (-1, 1, 1)]

#: Twelve triangles, wound anticlockwise seen from outside the cube.
_KN5_CUBE_FACES = [
    (4, 5, 6), (4, 6, 7),        # +Z
    (0, 3, 2), (0, 2, 1),        # -Z
    (1, 2, 6), (1, 6, 5),        # +X
    (0, 4, 7), (0, 7, 3),        # -X
    (3, 7, 6), (3, 6, 2),        # +Y
    (0, 1, 5), (0, 5, 4),        # -Y
]


def kn5_cube(size: float = 1.0):
    """A cube as ``(vertices, indices)`` for :func:`kn5_mesh`.

    Normals point out from the centre, so the shading reads as a rounded box
    rather than a flat one — which is beside the point here, but a vertex the
    game's layout has no room to leave out has to hold something true.
    """
    vertices = []
    for corner in _KN5_CUBE_CORNERS:
        length = math.sqrt(3.0)
        normal = tuple(v / length for v in corner)
        vertices.append((tuple(v * size for v in corner), normal, (0.5, 0.5),
                         (1.0, 0.0, 0.0)))
    indices = [index for face in _KN5_CUBE_FACES for index in face]
    # A face wound the wrong way is culled, and a fixture that draws nothing
    # reads exactly like the thing it was written to catch.
    for at in range(0, len(indices), 3):
        a, b, c = (vertices[indices[at + k]][0] for k in range(3))
        edge1 = [b[k] - a[k] for k in range(3)]
        edge2 = [c[k] - a[k] for k in range(3)]
        cross = (edge1[1] * edge2[2] - edge1[2] * edge2[1],
                 edge1[2] * edge2[0] - edge1[0] * edge2[2],
                 edge1[0] * edge2[1] - edge1[1] * edge2[0])
        outward = [(a[k] + b[k] + c[k]) / 3 for k in range(3)]
        assert sum(cross[k] * outward[k] for k in range(3)) > 0, "face wound inwards"
    return vertices, indices


#: What Custom Shaders Patch writes at the very end of a car it has encrypted.
KN5_ENCRYPTED_MARKER = b"__AC_SHADERS_PATCH_KN5ENC_v1__"


def kn5_encrypted(model: bytes, blocks=(("ver.body.x", 64),)) -> bytes:
    """A car with its real model held back, as a protected one is published.

    *model* is the spoiled copy left in front — a whole, readable kn5 — then
    the named blocks that stand for the encrypted section, then the trailer
    that says in plain text what has been done and where it starts.
    """
    out = bytearray(model)
    start = len(out)
    for name, size in blocks:
        raw = name.encode("ascii")
        out += struct.pack("<I", len(raw)) + raw
        out += struct.pack("<I", size) + bytes((at * 37 + 11) % 256 for at in range(size))
    out += struct.pack("<I", len(KN5_ENCRYPTED_MARKER)) + KN5_ENCRYPTED_MARKER
    out += struct.pack("<II", start, 1)
    return bytes(out)


def kn5_scrambled(vertices, indices):
    """The same triangles with every other one turned round.

    Which is what a spoiled file looks like from the outside: the counts are
    right, the normals are unit vectors, every index is in range, and half the
    triangles face the other way from the surface their corners describe.
    """
    out = list(indices)
    for at in range(0, len(out) - 2, 6):
        out[at + 1], out[at + 2] = out[at + 2], out[at + 1]
    return vertices, out


def kn5_shell_and_core(*, blend: int = 1, alpha_tested: bool = False,
                       cutoff: float = 0.5, shell_alpha: int = 64) -> bytes:
    """A solid red cube inside a larger blue one whose texture is see-through.

    Only the blue material's blending changes between fixtures, so what the
    middle of the viewport comes back as is answering one question.
    """
    red = dds_bgra(4, 4, bytes([0, 0, 255, 255]) * 16)
    blue = dds_bgra(4, 4, bytes([255, 0, 0, shell_alpha]) * 16)
    # No Fresnel at all, so what is seen is the two colours and not a reflection.
    core = kn5_material("core", "ksPerPixel",
                        properties=kn5_property("fresnelC", 0.0), property_count=1,
                        slots=(("txDiffuse", 0, "red.dds"),))
    shell = kn5_material("shell", "ksPerPixelAlpha", blend=blend,
                         alpha_tested=alpha_tested,
                         properties=(kn5_property("fresnelC", 0.0)
                                     + kn5_property("ksAlphaRef", cutoff)),
                         property_count=2,
                         slots=(("txDiffuse", 0, "blue.dds"),))
    inner_v, inner_i = kn5_cube(0.4)
    outer_v, outer_i = kn5_cube(1.0)
    tree = kn5_dummy(
        "scene",
        (1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0),
        kn5_mesh("core", inner_v, inner_i, material=0)
        + kn5_mesh("shell", outer_v, outer_i, material=1),
        2)
    return build_kn5(6, textures=[("red.dds", red), ("blue.dds", blue)],
                     materials=[core, shell], tree=tree)


# --------------------------------------------------------------------------
# COLLADA fixture


#: A COLLADA scene written the way an exporter writes one: a quad and a
#: triangle in one mesh wearing a material apiece, placed by a matrix that
#: turns and scales as well as moves.
#:
#: The turn is deliberate.  Every other reader here carries its numbers
#: straight out of the file, but a COLLADA node states a matrix and the Euler
#: angles an FBX wants have to be worked out from it — so this is the one place
#: two languages' trigonometry has to be held against each other.
def build_dae(*, up: str = "Z_UP", meter: str = "1",
              matrix: str = "0 -2 0 5  2 0 0 6  0 0 2 7  0 0 0 1") -> bytes:
    """A complete COLLADA document holding the two-primitive scene."""
    return f"""<?xml version="1.0" encoding="utf-8"?>
<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1">
 <asset><contributor><authoring_tool>fbxtool test fixture</authoring_tool>
  </contributor><unit name="meter" meter="{meter}"/><up_axis>{up}</up_axis></asset>
 <library_effects>
  <effect id="red-effect"><profile_COMMON><technique sid="common"><lambert>
   <diffuse><color sid="diffuse">1 0.25 0 1</color></diffuse>
  </lambert></technique></profile_COMMON></effect>
  <effect id="blue-effect"><profile_COMMON><technique sid="common"><phong>
   <diffuse><color sid="diffuse">0 0.25 1 1</color></diffuse>
  </phong></technique></profile_COMMON></effect>
 </library_effects>
 <library_materials>
  <material id="red-material" name="red"><instance_effect url="#red-effect"/></material>
  <material id="blue-material" name="blue"><instance_effect url="#blue-effect"/></material>
 </library_materials>
 <library_geometries><geometry id="g" name="wedge"><mesh>
  <source id="g-pos"><float_array id="g-pos-a" count="15">
    0 0 0  1 0 0  1 1 0  0 1 0  0.5 0.5 1</float_array>
   <technique_common><accessor source="#g-pos-a" count="5" stride="3">
    <param name="X" type="float"/><param name="Y" type="float"/>
    <param name="Z" type="float"/></accessor></technique_common></source>
  <source id="g-nrm"><float_array id="g-nrm-a" count="6">0 0 1  0 1 0</float_array>
   <technique_common><accessor source="#g-nrm-a" count="2" stride="3">
    <param name="X" type="float"/><param name="Y" type="float"/>
    <param name="Z" type="float"/></accessor></technique_common></source>
  <source id="g-uv"><float_array id="g-uv-a" count="8">0 0  1 0  1 1  0 1</float_array>
   <technique_common><accessor source="#g-uv-a" count="4" stride="2">
    <param name="S" type="float"/><param name="T" type="float"/>
    </accessor></technique_common></source>
  <vertices id="g-vtx"><input semantic="POSITION" source="#g-pos"/></vertices>
  <polylist material="red" count="1">
   <input semantic="VERTEX" source="#g-vtx" offset="0"/>
   <input semantic="NORMAL" source="#g-nrm" offset="1"/>
   <input semantic="TEXCOORD" source="#g-uv" offset="2" set="0"/>
   <vcount>4</vcount><p>0 0 0  1 0 1  2 0 2  3 0 3</p>
  </polylist>
  <triangles material="blue" count="1">
   <input semantic="VERTEX" source="#g-vtx" offset="0"/>
   <input semantic="NORMAL" source="#g-nrm" offset="1"/>
   <p>0 1  1 1  4 1</p>
  </triangles>
 </mesh></geometry></library_geometries>
 <library_visual_scenes><visual_scene id="s" name="s">
  <node id="n" name="wedge" type="NODE">
   <matrix sid="transform">{matrix}</matrix>
   <instance_geometry url="#g"><bind_material><technique_common>
    <instance_material symbol="red" target="#red-material"/>
    <instance_material symbol="blue" target="#blue-material"/>
   </technique_common></bind_material></instance_geometry>
  </node>
 </visual_scene></library_visual_scenes>
 <scene><instance_visual_scene url="#s"/></scene>
</COLLADA>
""".encode("utf-8")


#: What a BeamNG car keeps beside its model: the newer generation, which
#: states a base colour and a roughness the way glTF does, and the older, a
#: colour map and a Blinn-Phong specular the way Torque3D always did.
#:
#: `mapTo` is the name the model uses and `name` is the material's own — the
#: two differ here on purpose, since the model said `mapTo`.
DAE_MATERIALS = """{
 "red": {
  "name": "red material", "mapTo": "red", "class": "Material", "version": 1.5,
  "Stages": [
   {"baseColorMap": "/vehicles/x/red_b.color.png",
    "normalMap": "vehicles/x/red_nm.normal.png",
    "ambientOcclusionMap": "/vehicles/x/red_ao.data.png",
    "roughnessFactor": 0.25, "metallicFactor": 0.75,
    "clearCoatFactor": 1, "baseColorFactor": [0.5, 0.25, 0.125, 1]},
   {}, {}, {}
  ]
 },
 "blue": {
  "name": "blue", "mapTo": "blue", "class": "Material",
  "Stages": [{}, {"colorMap": "/vehicles/x/blue_d.png", "specularPower": 32}, {}]
 },
 "lamp": {
  "name": "lamp", "mapTo": "lamp", "class": "Material",
  "Stages": [{}, {}, {}, {}]
 }
}"""
