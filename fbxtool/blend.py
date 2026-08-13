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

from .model import Document, Node, ParseError, Property

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


def parse_blend(data: bytes, *, path: str | None = None) -> Document:
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
    _build_records(doc, data, blocks, sdna, endian, pointer_size)
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
                   endian: str, pointer_size: int) -> None:
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
    objects = _node("Objects", [], [])
    for index, block in enumerate(blocks):
        kind = ID_TYPES.get(block.code)
        if not kind:
            continue
        label = names.get(index, "")
        objects.children.append(
            _node(kind,
                  [Property("L", block.old_pointer),
                   _s(f"{label}\x00\x01{kind}"),
                   _s(block.code)],
                  [_node("Size", [_i(block.size)])])
        )
    if objects.children:
        root.children.append(objects)

    doc.extra["datablocks"] = len(objects.children)
    doc.extra["struct_count"] = len(sdna.structs)
    doc.extra["type_count"] = len(sdna.types)
    doc.extra["name_count"] = len(sdna.names)
    doc.extra["block_codes"] = dict(counts.most_common())
