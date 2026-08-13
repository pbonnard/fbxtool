"""A minimal binary FBX writer, used to produce known-good test input.

This is deliberately small: it writes exactly the structures the readers need
to be exercised against — typed properties, deflated arrays, nested records,
the null terminator and the footer — not a general-purpose exporter.
"""

from __future__ import annotations

import re
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

    One geometry is instanced by three models, each with its own placement and
    its own material, and none of the materials carries a colour of its own —
    that comes from the ``PropertyTemplate`` in ``Definitions``.
    """
    geometry_uid = 1000
    hub_uid, arm_uid, mirror_uid = 2001, 2002, 2003
    materials = {hub_uid: 3001, arm_uid: 3002, mirror_uid: 3003}

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
        *[N("Material", [L(uid), S(f"paint{index}\x00\x01Material"), S("")], [
            N("Version", [I(102)]),
            N("ShadingModel", [S("phong")]),
            N("MultiLayer", [I(0)]),
        ]) for index, uid in enumerate(materials.values())],
    ])

    definitions = N("Definitions", [], [
        N("Version", [I(100)]),
        N("Count", [I(8)]),
        N("ObjectType", [S("GlobalSettings")], [N("Count", [I(1)])]),
        N("ObjectType", [S("Geometry")], [N("Count", [I(1)])]),
        N("ObjectType", [S("Model")], [N("Count", [I(3)])]),
        N("ObjectType", [S("Material")], [
            N("Count", [I(3)]),
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
