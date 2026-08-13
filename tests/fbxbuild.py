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
# structs it contains. This writes a small but structurally faithful one, so
# the container and SDNA reader can be tested without Blender installed.

BLEND_MAGIC = b"BLENDER"


def _sdna_block(pointer_size: int, endian: str = "<") -> bytes:
    """An SDNA describing an ID struct and a few datablock types."""
    names = ["*next", "*prev", "*newid", "*lib", "name[66]", "flag", "id", "*data"]
    types = ["void", "ID", "Library", "char", "short", "Object", "Mesh", "Material"]
    # ID: two void pointers, an ID pointer, a Library pointer, name[66], flag.
    id_length = pointer_size * 4 + 66 + 2
    lengths = [0, id_length, 0, 1, 2, id_length + pointer_size,
               id_length + pointer_size, id_length]

    def index_of(collection, value):
        return collection.index(value)

    id_fields = [
        (index_of(types, "void"), index_of(names, "*next")),
        (index_of(types, "void"), index_of(names, "*prev")),
        (index_of(types, "ID"), index_of(names, "*newid")),
        (index_of(types, "Library"), index_of(names, "*lib")),
        (index_of(types, "char"), index_of(names, "name[66]")),
        (index_of(types, "short"), index_of(names, "flag")),
    ]
    # Every datablock struct opens with an embedded ID, which is what lets the
    # reader find names without knowing the struct.
    def with_id(extra=True):
        fields = [(index_of(types, "ID"), index_of(names, "id"))]
        if extra:
            fields.append((index_of(types, "void"), index_of(names, "*data")))
        return fields

    structs = [
        (index_of(types, "ID"), id_fields),
        (index_of(types, "Object"), with_id()),
        (index_of(types, "Mesh"), with_id()),
        (index_of(types, "Material"), with_id(extra=False)),
    ]

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
    tlen += struct.pack(f"{endian}{len(lengths)}H", *lengths)
    while len(tlen) % 4:
        tlen += b"\x00"
    body += tlen

    strc = bytearray(b"STRC")
    strc += struct.pack(f"{endian}I", len(structs))
    for type_index, fields in structs:
        strc += struct.pack(f"{endian}HH", type_index, len(fields))
        for field in fields:
            strc += struct.pack(f"{endian}HH", *field)
    body += strc
    return bytes(body)


#: Struct index within _sdna_block, by datablock code.
_BLEND_STRUCT = {"OB": 1, "ME": 2, "MA": 3}


def _id_payload(code: str, name: str, pointer_size: int) -> bytes:
    """An ID struct whose name field holds the code-prefixed datablock name."""
    payload = bytearray(pointer_size * 4)        # next, prev, newid, lib
    field = (code + name).encode("utf-8")[:65]
    payload += field + b"\x00" * (66 - len(field))
    payload += struct.pack("<h", 0)              # flag
    payload += b"\x00" * pointer_size            # trailing data pointer
    return bytes(payload)


def build_blend(version: int = 293, *, pointer_size: int = 8,
                datablocks=(("OB", "Cube"), ("ME", "Cube"), ("MA", "Red")),
                compress: bool = False, truncated: bool = False) -> bytes:
    """A small but structurally valid .blend file."""
    endian = "<"
    out = bytearray(BLEND_MAGIC)
    out += b"-" if pointer_size == 8 else b"_"
    out += b"v"
    out += f"{version:03d}".encode("ascii")

    pointer_format = "Q" if pointer_size == 8 else "I"
    header = struct.Struct(f"{endian}4sI{pointer_format}II")
    address = 0x1000

    def block(code: str, payload: bytes, sdna_index: int = 0, count: int = 1):
        nonlocal address
        address += 0x100
        return header.pack(code.encode("ascii").ljust(4, b"\x00"), len(payload),
                           address, sdna_index, count) + payload

    out += block("GLOB", b"\x00" * 32)
    for code, name in datablocks:
        out += block(code, _id_payload(code, name, pointer_size),
                     sdna_index=_BLEND_STRUCT.get(code, 0))
    out += block("DATA", b"\x00" * 64)
    out += block("DNA1", _sdna_block(pointer_size, endian))
    if not truncated:
        out += header.pack(b"ENDB", 0, 0, 0, 0)

    data = bytes(out)
    if compress:
        import gzip as _gzip
        data = _gzip.compress(data)
    return data
