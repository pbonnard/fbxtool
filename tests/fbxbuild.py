"""A minimal binary FBX writer, used to produce known-good test input.

This is deliberately small: it writes exactly the structures the readers need
to be exercised against — typed properties, deflated arrays, nested records,
the null terminator and the footer — not a general-purpose exporter.
"""

from __future__ import annotations

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


def cube_nodes(version: int = 7400, *, deflate: bool = True) -> list[N]:
    """A small but realistic scene: one mesh, one material, one texture."""
    geometry_uid, model_uid, material_uid, texture_uid = 1000, 2000, 3000, 4000

    vertices = [
        -1.0, -1.0, 1.0, 1.0, -1.0, 1.0, -1.0, 1.0, 1.0, 1.0, 1.0, 1.0,
        -1.0, 1.0, -1.0, 1.0, 1.0, -1.0, -1.0, -1.0, -1.0, 1.0, -1.0, -1.0,
    ]
    polygons = [0, 1, 3, -3, 2, 3, 5, -5, 4, 5, 7, -7, 6, 7, 1, -1,
                1, 7, 5, -4, 6, 0, 2, -5]

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
