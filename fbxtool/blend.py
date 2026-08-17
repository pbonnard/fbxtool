"""Reader for Blender's ``.blend`` files.

A ``.blend`` is not an interchange format: it is a dump of Blender's own
memory, written as a sequence of *file-blocks* plus a description of the C
structures those blocks contain (the ``DNA1`` block, known as SDNA).  What this
module reports is the container and that description — which are stable and
documented — rather than the contents of individual structs, whose layout is
Blender's internal business and changes between releases.

Layout::

    "BLENDER" _ v 293      12-byte header: pointer size, endianness, version
    <file-block>*          code, size, old pointer, SDNA index, count, data
    "DNA1" ... SDNA        names, types, type lengths, struct definitions
    "ENDB"                 terminator

Datablock names are located through the SDNA rather than hard-coded offsets,
so the ``ID.name`` field is found wherever a given Blender version puts it.

Files saved with Blender's "Compress" option are wrapped: gzip in releases up
to 2.9x, Zstandard from 3.0.  Gzip is unwrapped here; Zstandard is detected and
reported, since decompressing it would mean shipping a second decompressor.
"""

from __future__ import annotations

import gzip
import re
import struct
from dataclasses import dataclass, field
from typing import Any

from .model import ArrayInfo, Document, Node, ParseError, Property

__all__ = ["MAGIC", "is_blend", "parse_blend", "describe_blender_version"]

MAGIC = b"BLENDER"
GZIP_MAGIC = b"\x1f\x8b"
ZSTD_MAGIC = b"\x28\xb5\x2f\xfd"

#: Two-letter ID codes that begin a datablock, and what they hold.
ID_TYPES = {
    "AC": "Action", "AR": "Armature", "BR": "Brush", "CA": "Camera",
    "CF": "CacheFile", "CU": "Curve", "GD": "GreasePencil", "GR": "Collection",
    "IM": "Image", "IP": "Ipo", "KE": "ShapeKey", "LA": "Light",
    "LI": "Library", "LS": "LineStyle", "LT": "Lattice", "MA": "Material",
    "MB": "MetaBall", "MC": "MovieClip", "ME": "Mesh", "MS": "Mask",
    "NT": "NodeTree", "OB": "Object", "PA": "ParticleSettings", "PC": "PaintCurve",
    "PL": "LightProbe", "PT": "Palette", "SC": "Scene", "SN": "Screen",
    "SO": "Sound", "SQ": "Sequence", "TE": "Texture", "TX": "Text",
    "VF": "VectorFont", "WM": "WindowManager", "WO": "World", "WS": "Workspace",
    "SI": "Simulation", "HA": "Hair", "PO": "PointCloud", "VO": "Volume",
}

#: Blocks that are structural rather than datablocks.
STRUCTURAL = {"DATA", "GLOB", "DNA1", "ENDB", "REND", "TEST", "USER"}

_NAME_ARRAY = re.compile(r"\[(\d+)\]")


def describe_blender_version(stamp: int | None) -> str:
    """``293`` -> ``"2.93"``; ``400`` -> ``"4.0"``."""
    if stamp is None:
        return "unknown"
    major, rest = divmod(int(stamp), 100)
    return f"{major}.{rest // 10}{rest % 10 if rest % 10 else ''}" if rest % 10 \
        else f"{major}.{rest // 10}"


def is_blend(data: bytes) -> bool:
    """True when *data* starts a .blend file, compressed or not."""
    return (data[:7] == MAGIC or data[:2] == GZIP_MAGIC or data[:4] == ZSTD_MAGIC)


@dataclass
class Block:
    code: str
    size: int
    old_pointer: int
    sdna_index: int
    count: int
    offset: int


@dataclass
class Sdna:
    names: list[str] = field(default_factory=list)
    types: list[str] = field(default_factory=list)
    lengths: list[int] = field(default_factory=list)
    #: struct index -> (type index, [(type index, name index), ...])
    structs: list[tuple[int, list[tuple[int, int]]]] = field(default_factory=list)

    def struct_named(self, name: str) -> int | None:
        for index, (type_index, _) in enumerate(self.structs):
            if type_index < len(self.types) and self.types[type_index] == name:
                return index
        return None

    def field_size(self, type_index: int, name_index: int, pointer_size: int) -> int:
        name = self.names[name_index] if name_index < len(self.names) else ""
        if name.startswith("*") or name.startswith("(*"):
            size = pointer_size
        else:
            size = self.lengths[type_index] if type_index < len(self.lengths) else 0
        for count in _NAME_ARRAY.findall(name):
            size *= int(count)
        return size

    def field_offset(self, struct_index: int, field_name: str,
                     pointer_size: int) -> int | None:
        """Byte offset of a named field, computed from the file's own SDNA."""
        if struct_index is None or struct_index >= len(self.structs):
            return None
        offset = 0
        for type_index, name_index in self.structs[struct_index][1]:
            name = self.names[name_index] if name_index < len(self.names) else ""
            if name.split("[")[0].lstrip("*(") == field_name:
                return offset
            offset += self.field_size(type_index, name_index, pointer_size)
        return None


def parse_blend(data: bytes, *, path: str | None = None,
                load_arrays: bool = False) -> Document:
    """Parse a .blend file's container and SDNA into a Document."""
    doc = Document(root=Node(""), encoding="binary", path=path, file_size=len(data))
    doc.format = "blend"

    compression = "none"
    if data[:2] == GZIP_MAGIC:
        compression = "gzip"
        try:
            data = gzip.decompress(data)
        except OSError as exc:
            raise ParseError(f"gzip-compressed .blend could not be decompressed: {exc}")
    elif data[:4] == ZSTD_MAGIC:
        doc.extra["compression"] = "zstd"
        doc.warn("this file is Zstandard-compressed (Blender 3.0+ with Compress on); "
                 "re-save it with Compress off, or decompress it first")
        _minimal_records(doc, compression="zstd")
        return doc

    if data[:7] != MAGIC:
        raise ParseError("missing 'BLENDER' magic")
    if len(data) < 12:
        raise ParseError("file is too short to be a .blend file")

    pointer_flag = chr(data[7])
    endian_flag = chr(data[8])
    pointer_size = 8 if pointer_flag == "-" else 4
    endian = "<" if endian_flag == "v" else ">"
    if pointer_flag not in "_-":
        doc.warn(f"unexpected pointer-size flag {pointer_flag!r}; assuming 4 bytes")
    if endian_flag not in "vV":
        doc.warn(f"unexpected endianness flag {endian_flag!r}; assuming little-endian")

    try:
        version = int(data[9:12].decode("ascii"))
    except ValueError:
        version = None
        doc.warn("version field in the header is not a number")

    doc.extra.update({
        "compression": compression,
        "pointer_size": pointer_size,
        "endianness": "little" if endian == "<" else "big",
        "blender_version": version,
        "blender_version_text": describe_blender_version(version),
    })

    blocks, sdna = _read_blocks(data, doc, endian, pointer_size)
    doc.extra["block_count"] = len(blocks)
    _build_records(doc, data, blocks, sdna, endian, pointer_size, load_arrays)
    return doc


def _read_blocks(data: bytes, doc: Document, endian: str,
                 pointer_size: int) -> tuple[list[Block], Sdna]:
    blocks: list[Block] = []
    sdna = Sdna()
    header = struct.Struct(f"{endian}4sI{'Q' if pointer_size == 8 else 'I'}II")
    position = 12
    total = len(data)

    while position + header.size <= total:
        code_raw, size, old_pointer, sdna_index, count = header.unpack_from(data, position)
        code = code_raw.rstrip(b"\x00").decode("ascii", "replace")
        body = position + header.size
        if code == "ENDB":
            blocks.append(Block(code, size, old_pointer, sdna_index, count, body))
            break
        if body + size > total:
            doc.warn(f"block {code!r} at {position} claims {size} bytes but the file ends")
            break
        blocks.append(Block(code, size, old_pointer, sdna_index, count, body))
        if code == "DNA1":
            try:
                sdna = _read_sdna(data[body:body + size], endian)
            except (struct.error, ValueError, IndexError) as exc:
                doc.warn(f"the DNA1 block could not be read: {exc}")
        position = body + size

    if not blocks:
        doc.warn("no file-blocks were found")
    elif blocks[-1].code != "ENDB":
        doc.warn("the file does not end with an ENDB block; it may be truncated")
    return blocks, sdna


def _read_sdna(data: bytes, endian: str) -> Sdna:
    """Decode the SDNA: names, types, type lengths and struct definitions."""
    sdna = Sdna()
    if data[:4] != b"SDNA":
        raise ValueError("the DNA1 block does not start with 'SDNA'")
    position = 4

    def align(value: int) -> int:
        return (value + 3) & ~3

    def read_strings(tag: bytes) -> list[str]:
        nonlocal position
        if data[position:position + 4] != tag:
            raise ValueError(f"expected {tag.decode()} at offset {position}")
        position += 4
        (count,) = struct.unpack_from(f"{endian}I", data, position)
        position += 4
        out = []
        for _ in range(count):
            end = data.index(b"\x00", position)
            out.append(data[position:end].decode("utf-8", "replace"))
            position = end + 1
        position = align(position)
        return out

    sdna.names = read_strings(b"NAME")
    sdna.types = read_strings(b"TYPE")

    if data[position:position + 4] != b"TLEN":
        raise ValueError("expected TLEN")
    position += 4
    sdna.lengths = list(struct.unpack_from(f"{endian}{len(sdna.types)}H", data, position))
    position = align(position + len(sdna.types) * 2)

    if data[position:position + 4] != b"STRC":
        raise ValueError("expected STRC")
    position += 4
    (struct_count,) = struct.unpack_from(f"{endian}I", data, position)
    position += 4
    for _ in range(struct_count):
        type_index, field_count = struct.unpack_from(f"{endian}HH", data, position)
        position += 4
        fields = []
        for _ in range(field_count):
            fields.append(struct.unpack_from(f"{endian}HH", data, position))
            position += 4
        sdna.structs.append((type_index, fields))
    return sdna


def _datablock_names(data: bytes, blocks: list[Block], sdna: Sdna,
                     pointer_size: int) -> dict[int, str]:
    """Read ``ID.name`` for each datablock, locating the field via the SDNA."""
    id_struct = sdna.struct_named("ID")
    name_offset = sdna.field_offset(id_struct, "name", pointer_size)
    if name_offset is None:
        return {}

    names: dict[int, str] = {}
    for index, block in enumerate(blocks):
        if block.code not in ID_TYPES:
            continue
        at = block.offset + name_offset
        if at + 2 > len(data):
            continue
        end = data.find(b"\x00", at, at + 66)
        raw = data[at:end if end >= 0 else at + 66]
        text = raw.decode("utf-8", "replace")
        # Names are prefixed with the two-letter code, as in "OBCube".
        names[index] = text[2:] if len(text) > 2 and text[:2] == block.code else text
    return names


# ---------------------------------------------------------------------------
# mesh extraction
#
# Blender stores a mesh as four parallel arrays reached by pointer: MVert holds
# the coordinates, MLoop the per-corner vertex indices, MPoly the run of loops
# each polygon owns, and MLoopUV the per-corner texture coordinates.  A pointer
# is the address the block had when it was written, so following one means
# finding the block whose "old pointer" matches.
#
# Every offset and size comes from the file's own SDNA, so this adapts to
# whatever a given release put where.  Releases that dropped these fields in
# favour of generic attributes (3.6 deprecated MVert, 4.0 removed it) are
# detected by their absence and reported rather than guessed at.


class _Struct:
    """Field offsets and size for one SDNA struct."""

    def __init__(self, sdna: Sdna, name: str, pointer_size: int) -> None:
        self.name = name
        self.index = sdna.struct_named(name)
        self.size = 0
        self.offsets: dict[str, int] = {}
        if self.index is None:
            return
        type_index = sdna.structs[self.index][0]
        self.size = sdna.lengths[type_index] if type_index < len(sdna.lengths) else 0
        offset = 0
        for field_type, field_name in sdna.structs[self.index][1]:
            bare = sdna.names[field_name].split("[")[0].lstrip("*(")
            self.offsets.setdefault(bare, offset)
            offset += sdna.field_size(field_type, field_name, pointer_size)

    def __bool__(self) -> bool:
        return self.index is not None

    def has(self, *fields: str) -> bool:
        return all(field in self.offsets for field in fields)

    def at(self, base: int, field: str) -> int:
        return base + self.offsets[field]


def _extract_meshes(doc: Document, data: bytes, blocks: list[Block], sdna: Sdna,
                    endian: str, pointer_size: int, load_arrays: bool) -> list[Node]:
    """Turn each ME datablock into a Geometry record, or explain why not."""
    mesh = _Struct(sdna, "Mesh", pointer_size)
    vert = _Struct(sdna, "MVert", pointer_size)
    poly = _Struct(sdna, "MPoly", pointer_size)
    loop = _Struct(sdna, "MLoop", pointer_size)
    loop_uv = _Struct(sdna, "MLoopUV", pointer_size)

    me_blocks = [b for b in blocks if b.code == "ME"]
    if not me_blocks:
        return []
    if not (mesh and mesh.has("mvert", "mpoly", "mloop", "totvert", "totpoly", "totloop")
            and vert.has("co") and poly.has("loopstart", "totloop") and loop.has("v")):
        doc.warn("this Blender version stores mesh data as generic attributes rather "
                 "than the MVert/MPoly/MLoop arrays; geometry was not extracted")
        doc.extra["geometry"] = "unsupported layout"
        return []

    by_address = {block.old_pointer: block for block in blocks if block.old_pointer}
    int32 = struct.Struct(f"{endian}i")
    uint64 = struct.Struct(f"{endian}{'Q' if pointer_size == 8 else 'I'}")

    def read_int(base: int, field: str) -> int:
        return int32.unpack_from(data, mesh.at(base, field))[0]

    def follow(base: int, field: str) -> Block | None:
        if field not in mesh.offsets:
            return None
        address = uint64.unpack_from(data, mesh.at(base, field))[0]
        return by_address.get(address)

    material_struct = _Struct(sdna, "Material", pointer_size)
    id_struct = _Struct(sdna, "ID", pointer_size)

    def datablock_name(block: Block, prefix: str) -> str:
        if "name" not in id_struct.offsets:
            return ""
        at = block.offset + id_struct.offsets["name"]
        end = data.find(b"\x00", at, at + 66)
        text = data[at:end if end >= 0 else at + 66].decode("utf-8", "replace")
        return text[2:] if text[:2] == prefix else text

    def material_slots(base: int) -> list[tuple[int, str, tuple[float, float, float]]]:
        """The mesh's material slots in order, which is what mat_nr indexes."""
        if not (mesh.has("mat", "totcol") and material_struct):
            return []
        total = struct.unpack_from(f"{endian}h", data, mesh.at(base, "totcol"))[0]
        table = follow(base, "mat")
        if total <= 0 or table is None:
            return []
        slots = []
        for i in range(total):
            at = table.offset + i * pointer_size
            if at + pointer_size > len(data):
                break
            address = uint64.unpack_from(data, at)[0]
            block = by_address.get(address)
            if block is None or block.code != "MA":
                slots.append((0, f"slot{i}", (0.8, 0.8, 0.8)))
                continue
            colour = (0.8, 0.8, 0.8)
            if material_struct.has("r"):
                colour = struct.unpack_from(f"{endian}3f", data,
                                            material_struct.at(block.offset, "r"))
            slots.append((address, datablock_name(block, "MA"), colour))
        return slots

    records = []
    for index, block in enumerate(me_blocks):
        base = block.offset
        totvert = read_int(base, "totvert")
        totpoly = read_int(base, "totpoly")
        totloop = read_int(base, "totloop")
        if totvert <= 0 or totloop <= 0:
            continue

        vert_block = follow(base, "mvert")
        poly_block = follow(base, "mpoly")
        loop_block = follow(base, "mloop")
        if not (vert_block and poly_block and loop_block):
            doc.warn(f"mesh {index}: vertex or polygon data could not be located")
            continue

        name = _mesh_name(data, blocks, sdna, block, pointer_size)
        node = _mesh_records(data, name, totvert, totpoly, totloop,
                             vert_block, poly_block, loop_block,
                             follow(base, "mloopuv"),
                             vert, poly, loop, loop_uv, endian, load_arrays,
                             uid=block.old_pointer)
        records.append((node, name, block.old_pointer, material_slots(base)))
    return records


def _mesh_name(data: bytes, blocks: list[Block], sdna: Sdna, block: Block,
               pointer_size: int) -> str:
    id_struct = sdna.struct_named("ID")
    offset = sdna.field_offset(id_struct, "name", pointer_size)
    if offset is None:
        return "mesh"
    at = block.offset + offset
    end = data.find(b"\x00", at, at + 66)
    text = data[at:end if end >= 0 else at + 66].decode("utf-8", "replace")
    return text[2:] if text[:2] == "ME" else text


def _mesh_records(data, name, totvert, totpoly, totloop, vert_block, poly_block,
                  loop_block, uv_block, vert, poly, loop, loop_uv, endian,
                  load_arrays, uid) -> Node:
    """Build a Geometry record from the four parallel arrays."""
    positions: list[float] = []
    normals: list[float] = []
    indices: list[int] = []
    uvs: list[float] = []
    materials: list[int] = []

    if load_arrays:
        co_offset = vert.offsets["co"]
        no_offset = vert.offsets.get("no")
        vector = struct.Struct(f"{endian}3f")
        shorts = struct.Struct(f"{endian}3h")
        for i in range(totvert):
            at = vert_block.offset + i * vert.size
            positions.extend(vector.unpack_from(data, at + co_offset))
            if no_offset is not None:
                # Vertex normals are stored as normalised shorts.
                raw = shorts.unpack_from(data, at + no_offset)
                normals.extend(component / 32767.0 for component in raw)

        loop_vertices = struct.Struct(f"{endian}I")
        loop_v = loop.offsets["v"]
        corner = []
        for i in range(totloop):
            corner.append(loop_vertices.unpack_from(
                data, loop_block.offset + i * loop.size + loop_v)[0])

        start_offset = poly.offsets["loopstart"]
        count_offset = poly.offsets["totloop"]
        mat_offset = poly.offsets.get("mat_nr")
        int32 = struct.Struct(f"{endian}i")
        int16 = struct.Struct(f"{endian}h")
        for i in range(totpoly):
            at = poly_block.offset + i * poly.size
            start = int32.unpack_from(data, at + start_offset)[0]
            count = int32.unpack_from(data, at + count_offset)[0]
            if count < 3 or start < 0 or start + count > totloop:
                continue
            for position in range(count):
                index = corner[start + position]
                # FBX-style run: the last index of each polygon is complemented.
                indices.append(~index if position == count - 1 else index)
            materials.append(int16.unpack_from(data, at + mat_offset)[0]
                             if mat_offset is not None else 0)

        if uv_block and loop_uv and loop_uv.has("uv"):
            uv_pair = struct.Struct(f"{endian}2f")
            uv_offset = loop_uv.offsets["uv"]
            for i in range(totloop):
                uvs.extend(uv_pair.unpack_from(
                    data, uv_block.offset + i * loop_uv.size + uv_offset))

    def array(code: str, values: list, length: int) -> Property:
        size = 8 if code in ("d", "l") else 4
        info = ArrayInfo(length=length, encoding=0, byte_length=length * size)
        return Property(code, values if load_arrays else None, info)

    children = [
        _node("Vertices", [array("d", positions, totvert * 3)]),
        _node("PolygonVertexIndex", [array("i", indices,
                                           len(indices) if load_arrays else totloop)]),
        _node("GeometryVersion", [_i(124)]),
    ]
    if not load_arrays or normals:
        children.append(_node("LayerElementNormal", [_i(0)], [
            _node("Version", [_i(101)]),
            _node("MappingInformationType", [_s("ByVertice")]),
            _node("ReferenceInformationType", [_s("Direct")]),
            _node("Normals", [array("d", normals, totvert * 3)]),
        ]))
    if uv_block:
        children.append(_node("LayerElementUV", [_i(0)], [
            _node("Version", [_i(101)]),
            _node("Name", [_s("UVMap")]),
            _node("MappingInformationType", [_s("ByPolygonVertex")]),
            _node("ReferenceInformationType", [_s("Direct")]),
            _node("UV", [array("d", uvs, totloop * 2)]),
        ]))
    children.append(_node("LayerElementMaterial", [_i(0)], [
        _node("Version", [_i(101)]),
        _node("MappingInformationType", [_s("ByPolygon")]),
        _node("ReferenceInformationType", [_s("IndexToDirect")]),
        _node("Materials", [array("i", materials,
                                  len(materials) if load_arrays else totpoly)]),
    ]))
    children.append(_node("Layer", [_i(0)], [_node("Version", [_i(100)])]))

    return _node("Geometry",
                 [Property("L", uid), _s(f"{name}\x00\x01Geometry"), _s("Mesh")],
                 children)


def material_look(base: tuple[float, float, float], *, metallic: float = 0.0,
                  roughness: float = 0.5, specular: float = 0.5,
                  alpha: float = 1.0) -> dict[str, Any]:
    """Blender's shading values as the diffuse/specular pair FBX describes.

    A metal has no diffuse and takes its reflectance from its own colour; a
    dielectric reflects 8% of ``specular`` — the convention the Principled BSDF
    uses. Roughness becomes a Blinn-Phong exponent, which is what an FBX
    material carries, and which a renderer turns back into roughness.
    """
    metallic = min(max(metallic, 0.0), 1.0)
    rough = min(max(roughness, 0.03), 1.0)
    dielectric = 0.08 * min(max(specular, 0.0), 1.0)
    return {
        "colour": tuple(c * (1.0 - metallic) for c in base),
        "specular": tuple(dielectric * (1.0 - metallic) + c * metallic for c in base),
        # A Phong exponent, which is what an FBX material states.  The
        # relation runs through the microfacet alpha: `alpha = roughness
        # squared` and `alpha = sqrt(2 / (n + 2))`, so `n` is two over the
        # fourth power.  Squaring once instead loses the round trip and
        # hands back a surface far shinier than Blender was showing.
        "shininess": 2.0 / (rough ** 4) - 2.0,
        "metallic": metallic,
        "opacity": min(max(alpha, 0.0), 1.0),
    }


def _material_looks(data: bytes, blocks: list[Block], sdna: Sdna, pointer_size: int,
                    endian: str) -> dict[int, dict[str, Any]]:
    """Each material's appearance, keyed by its address.

    Blender keeps a viewport colour on the datablock, plus the metallic,
    roughness and specular values its viewport and EEVEE fall back on. The
    node tree can say something different again — that is a separate problem —
    but these are what the file offers directly.
    """
    material = _Struct(sdna, "Material", pointer_size)
    if not (material and material.has("r")):
        return {}
    looks = {}
    for block in blocks:
        if block.code != "MA":
            continue

        def value(field: str, fallback: float) -> float:
            if field not in material.offsets:
                return fallback
            try:
                return struct.unpack_from(f"{endian}f", data,
                                          material.at(block.offset, field))[0]
            except struct.error:
                return fallback

        try:
            base = struct.unpack_from(f"{endian}3f", data,
                                      material.at(block.offset, "r"))
        except struct.error:
            continue
        looks[block.old_pointer] = material_look(
            base,
            metallic=value("metallic", 0.0),
            roughness=value("roughness", 0.5),
            specular=value("spec", 0.5),
            # The fourth component of the viewport colour, which is where
            # Blender keeps a material's transparency.
            alpha=value("a", 1.0),
        )
    return looks


def _node(name: str, props=None, children=None) -> Node:
    return Node(name=name, props=props or [], children=children or [])


def _s(value) -> Property:
    return Property("S", str(value))


def _i(value) -> Property:
    return Property("I", int(value))


def _minimal_records(doc: Document, *, compression: str) -> None:
    doc.root.children.append(_node("BlenderFile", [], [
        _node("Compression", [_s(compression)]),
    ]))


def _build_records(doc: Document, data: bytes, blocks: list[Block], sdna: Sdna,
                   endian: str, pointer_size: int,
                   load_arrays: bool = False) -> None:
    from collections import Counter

    root = doc.root
    counts = Counter(block.code for block in blocks)
    payload = sum(block.size for block in blocks)

    root.children.append(_node("BlenderFile", [], [
        _node("Version", [_i(doc.extra.get("blender_version") or 0)]),
        _node("VersionText", [_s(doc.extra.get("blender_version_text", "unknown"))]),
        _node("PointerSize", [_i(pointer_size)]),
        _node("Endianness", [_s(doc.extra.get("endianness", "little"))]),
        _node("Compression", [_s(doc.extra.get("compression", "none"))]),
        _node("BlockCount", [_i(len(blocks))]),
        _node("PayloadBytes", [_i(payload)]),
    ]))

    root.children.append(_node("Blocks", [], [
        _node("Block", [_s(code), _i(count)]) for code, count in counts.most_common()
    ]))

    root.children.append(_node("DNA", [], [
        _node("Structs", [_i(len(sdna.structs))]),
        _node("Types", [_i(len(sdna.types))]),
        _node("Names", [_i(len(sdna.names))]),
    ]))

    names = _datablock_names(data, blocks, sdna, pointer_size)
    material_looks = _material_looks(data, blocks, sdna, pointer_size, endian)
    meshes = _extract_meshes(doc, data, blocks, sdna, endian, pointer_size, load_arrays)
    by_pointer = {pointer: (node, name, slots) for node, name, pointer, slots in meshes}

    objects = _node("Objects", [], [])
    connections: list[Node] = []
    # Synthetic model UIDs are small integers; real ones are former memory
    # addresses, so the two cannot collide.
    next_model_uid = 1

    for index, block in enumerate(blocks):
        kind = ID_TYPES.get(block.code)
        if not kind:
            continue
        label = names.get(index, "")

        # A mesh is emitted as the Geometry record carrying its data, with a
        # model to hang it and its material slots from.
        if block.code == "ME" and block.old_pointer in by_pointer:
            geometry_node, mesh_name, slots = by_pointer[block.old_pointer]
            objects.children.append(geometry_node)
            model_uid = next_model_uid
            next_model_uid += 1
            objects.children.append(
                _node("Model", [Property("L", model_uid),
                                _s(f"{mesh_name}\x00\x01Model"), _s("Mesh")],
                      [_node("Version", [_i(232)])]))
            connections.append(_node("C", [_s("OO"), Property("L", model_uid),
                                           Property("L", 0)]))
            connections.append(_node("C", [_s("OO"), Property("L", block.old_pointer),
                                           Property("L", model_uid)]))
            # Slot order is what a polygon's material index refers to.
            for pointer, _, _ in slots:
                if pointer:
                    connections.append(_node("C", [_s("OO"), Property("L", pointer),
                                                   Property("L", model_uid)]))
            continue

        if block.code == "MA":
            look = material_looks.get(block.old_pointer)
            if look is None:
                look = material_look((0.8, 0.8, 0.8))
            objects.children.append(
                _node("Material", [Property("L", block.old_pointer),
                                   _s(f"{label}\x00\x01Material"), _s("")], [
                    _node("Version", [_i(102)]),
                    _node("ShadingModel", [_s("phong")]),
                    _node("Properties70", [], [
                        _node("P", [_s("DiffuseColor"), _s("Color"), _s(""), _s("A"),
                                    *[Property("D", float(c)) for c in look["colour"]]]),
                        _node("P", [_s("SpecularColor"), _s("Color"), _s(""), _s("A"),
                                    *[Property("D", float(c)) for c in look["specular"]]]),
                        _node("P", [_s("ShininessExponent"), _s("Number"), _s(""), _s("A"),
                                    Property("D", float(look["shininess"]))]),
                        # Blender states metalness outright, so the reflectance
                        # above is measured rather than inferred from a
                        # highlight colour.
                        _node("P", [_s("Metallic"), _s("Number"), _s(""), _s("A"),
                                    Property("D", float(look["metallic"]))]),
                        _node("P", [_s("Opacity"), _s("Number"), _s(""), _s("A"),
                                    Property("D", float(look["opacity"]))]),
                    ]),
                ]))
            continue

        objects.children.append(
            _node(kind,
                  [Property("L", block.old_pointer),
                   _s(f"{label}\x00\x01{kind}"),
                   _s(block.code)],
                  [_node("Size", [_i(block.size)])])
        )

    if objects.children:
        root.children.append(objects)
    if connections:
        root.children.append(_node("Connections", [], connections))

    doc.extra["meshes"] = len(meshes)
    doc.extra["datablocks"] = len(objects.children)
    doc.extra["struct_count"] = len(sdna.structs)
    doc.extra["type_count"] = len(sdna.types)
    doc.extra["name_count"] = len(sdna.names)
    doc.extra["block_codes"] = dict(counts.most_common())
