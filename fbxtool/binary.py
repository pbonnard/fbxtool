"""Reader for the binary FBX container format.

Layout of a binary FBX file::

    "Kaydara FBX Binary  \\x00"   21 bytes of magic
    \\x1a\\x00                     2 unknown bytes
    uint32                       version stamp, e.g. 7400
    <node record>*               top-level records
    <null record>                terminator (all-zero record header)
    <footer>                     file id, version stamp and a 16-byte magic

A node record is::

    EndOffset          uint32 (uint64 when version >= 7500)
    NumProperties      uint32 (uint64 when version >= 7500)
    PropertyListLen    uint32 (uint64 when version >= 7500)
    NameLen            uint8
    Name               NameLen bytes
    <property>*        NumProperties properties, PropertyListLen bytes total
    <node record>*     optional nested records
    <null record>      present only when there are nested records

``EndOffset`` is an absolute file offset, which is what lets a reader skip a
subtree without decoding it.
"""

from __future__ import annotations

import struct
import zlib

from .model import (
    ARRAY_TYPES,
    ArrayInfo,
    Document,
    Node,
    ParseError,
    Property,
)
from .versions import WIDE_OFFSET_VERSION

__all__ = ["MAGIC", "is_binary_fbx", "parse_binary"]

MAGIC = b"Kaydara FBX Binary  \x00"
_MAGIC_TAIL = b"\x1a\x00"
_HEADER_SIZE = len(MAGIC) + len(_MAGIC_TAIL) + 4  # 27

FOOTER_MAGIC = bytes(
    (0xF8, 0x5A, 0x8C, 0x6A, 0xDE, 0xF5, 0xD9, 0x7E,
     0xEC, 0xE9, 0x0C, 0xE3, 0x75, 0x8F, 0x29, 0x0B)
)

#: The footer is located by this prefix rather than the whole magic.  Every
#: writer seen so far agrees on these bytes; matching on them means a variant
#: tail is not mistaken for a truncated file.  The match is confirmed by the
#: version stamp, which must sit 124 bytes earlier.
_FOOTER_PREFIX = FOOTER_MAGIC[:13]

_MAX_DEPTH = 256

# Property code -> (struct format, size in bytes).
_SCALAR_STRUCT = {
    "Y": ("<h", 2),
    "C": ("<?", 1),
    "I": ("<i", 4),
    "F": ("<f", 4),
    "D": ("<d", 8),
    "L": ("<q", 8),
}

# Array property code -> (struct format char, element size).
_ARRAY_STRUCT = {
    "f": ("f", 4),
    "d": ("d", 8),
    "l": ("q", 8),
    "i": ("i", 4),
    "b": ("b", 1),
}


def is_binary_fbx(data: bytes) -> bool:
    """True when *data* starts with the binary FBX magic."""
    return data[: len(MAGIC)] == MAGIC


def parse_binary(
    data,
    *,
    path: str | None = None,
    load_arrays: bool = False,
    max_array_values: int | None = None,
) -> Document:
    """Parse binary FBX *data* (``bytes`` or an ``mmap``) into a Document.

    Array payloads are skipped unless *load_arrays* is set; their length and
    encoding are always recorded.  *max_array_values* caps how many elements of
    each array are kept in memory.
    """
    total = len(data)
    if total < _HEADER_SIZE:
        raise ParseError("file is too short to be a binary FBX file")
    if not is_binary_fbx(data[: len(MAGIC)]):
        raise ParseError("missing 'Kaydara FBX Binary' magic")

    doc = Document(
        root=Node(""),
        encoding="binary",
        path=path,
        file_size=total,
        version_source="header",
    )

    tail = bytes(data[len(MAGIC) : len(MAGIC) + 2])
    if tail != _MAGIC_TAIL:
        doc.warn(f"unexpected bytes after magic: {tail.hex(' ')} (expected 1a 00)")

    version = struct.unpack_from("<I", data, len(MAGIC) + 2)[0]
    doc.version = version
    doc.wide_offsets = version >= WIDE_OFFSET_VERSION

    ctx = _Context(
        data=data,
        doc=doc,
        wide=doc.wide_offsets,
        load_arrays=load_arrays,
        max_array_values=max_array_values,
    )

    pos = _HEADER_SIZE
    while pos < total:
        if total - pos < ctx.record_header_size + 1:
            doc.warn(
                f"file ends {total - pos} bytes into a top-level record header at {pos}"
            )
            break
        node, pos, terminated = _read_node(ctx, pos, depth=0)
        if terminated:
            break
        if node is None:
            break
        doc.root.children.append(node)

    _read_footer(ctx, pos)
    if not doc.root.children:
        doc.warn("no top-level records were found")
    return doc


class _Context:
    """Parser state threaded through the recursive reader."""

    __slots__ = ("data", "doc", "wide", "load_arrays", "max_array_values",
                 "record_header_size", "_header_fmt")

    def __init__(self, data, doc: Document, wide: bool, load_arrays: bool,
                 max_array_values: int | None) -> None:
        self.data = data
        self.doc = doc
        self.wide = wide
        self.load_arrays = load_arrays
        self.max_array_values = max_array_values
        self._header_fmt = "<QQQ" if wide else "<III"
        self.record_header_size = 24 if wide else 12

    def unpack_header(self, pos: int) -> tuple[int, int, int]:
        return struct.unpack_from(self._header_fmt, self.data, pos)


def _read_node(ctx: _Context, pos: int, depth: int) -> tuple[Node | None, int, bool]:
    """Read one record starting at *pos*.

    Returns ``(node, new_pos, is_terminator)``; *node* is ``None`` for the
    all-zero record that terminates a sibling list.
    """
    if depth > _MAX_DEPTH:
        raise ParseError(f"record nesting deeper than {_MAX_DEPTH} at offset {pos}")

    start = pos
    end_offset, num_props, prop_list_len = ctx.unpack_header(pos)
    pos += ctx.record_header_size
    name_len = ctx.data[pos]
    pos += 1

    if end_offset == 0 and num_props == 0 and prop_list_len == 0 and name_len == 0:
        return None, pos, True

    name = bytes(ctx.data[pos : pos + name_len]).decode("utf-8", "replace")
    pos += name_len

    node = Node(name=name, offset=start, end_offset=end_offset)

    prop_start = pos
    try:
        for _ in range(num_props):
            prop, pos = _read_property(ctx, pos)
            node.props.append(prop)
    except (struct.error, IndexError) as exc:
        raise ParseError(
            f"truncated property list in record {name!r} at offset {start}"
        ) from exc

    consumed = pos - prop_start
    if consumed != prop_list_len:
        ctx.doc.warn(
            f"record {name!r} at offset {start}: property list is {consumed} bytes "
            f"but the header declares {prop_list_len}"
        )
        # The declared length is authoritative for resynchronising.
        pos = prop_start + prop_list_len

    if not (start < end_offset <= len(ctx.data)):
        ctx.doc.warn(
            f"record {name!r} at offset {start} has an out-of-range end offset "
            f"({end_offset}); stopping this branch"
        )
        return node, max(pos, start + 1), False

    if pos < end_offset:
        while pos < end_offset:
            if end_offset - pos < ctx.record_header_size + 1:
                ctx.doc.warn(
                    f"record {name!r} at offset {start}: {end_offset - pos} stray "
                    "bytes where a nested record header was expected"
                )
                break
            child, pos, terminated = _read_node(ctx, pos, depth + 1)
            if terminated:
                break
            if child is None:
                break
            node.children.append(child)

    if pos != end_offset:
        ctx.doc.warn(
            f"record {name!r} at offset {start}: ends at {pos} but the header "
            f"declares {end_offset}"
        )
    return node, end_offset, False


def _read_property(ctx: _Context, pos: int) -> tuple[Property, int]:
    data = ctx.data
    code = chr(data[pos])
    pos += 1

    scalar = _SCALAR_STRUCT.get(code)
    if scalar is not None:
        fmt, size = scalar
        value = struct.unpack_from(fmt, data, pos)[0]
        return Property(code, value), pos + size

    if code in ("S", "R"):
        (length,) = struct.unpack_from("<I", data, pos)
        pos += 4
        payload = bytes(data[pos : pos + length])
        if len(payload) != length:
            raise ParseError(f"truncated {code!r} property at offset {pos}")
        pos += length
        if code == "S":
            return Property(code, payload.decode("utf-8", "replace")), pos
        return Property(code, payload), pos

    if code in _ARRAY_STRUCT:
        return _read_array_property(ctx, pos, code)

    raise ParseError(
        f"unknown property type {code!r} (0x{ord(code):02x}) at offset {pos - 1}"
    )


def _read_array_property(ctx: _Context, pos: int, code: str) -> tuple[Property, int]:
    data = ctx.data
    length, encoding, byte_length = struct.unpack_from("<III", data, pos)
    pos += 12
    payload_start = pos + 0
    info = ArrayInfo(length=length, encoding=encoding, byte_length=byte_length,
                     data_offset=payload_start)
    pos += byte_length
    if pos > len(data):
        raise ParseError(f"array property runs past the end of the file at {payload_start}")

    values = None
    if ctx.load_arrays and length:
        values = _decode_array(ctx, bytes(data[payload_start:pos]), code, info)
    return Property(code, values, info), pos


def _decode_array(ctx: _Context, payload: bytes, code: str, info: ArrayInfo):
    if info.encoding == 1:
        try:
            payload = zlib.decompress(payload)
        except zlib.error as exc:
            ctx.doc.warn(f"could not inflate a {ARRAY_TYPES[code]} array: {exc}")
            return None
    elif info.encoding != 0:
        ctx.doc.warn(f"unknown array encoding {info.encoding}; payload left undecoded")
        return None

    fmt_char, item_size = _ARRAY_STRUCT[code]
    count = info.length
    if ctx.max_array_values is not None:
        count = min(count, ctx.max_array_values)
    available = len(payload) // item_size
    if available < count:
        ctx.doc.warn(
            f"a {ARRAY_TYPES[code]} array declares {info.length} elements but only "
            f"{available} are present"
        )
        count = available
    values = list(struct.unpack_from(f"<{count}{fmt_char}", payload, 0))
    if code == "b":
        values = [bool(v) for v in values]
    return values


def _read_footer(ctx: _Context, pos: int) -> None:
    """Record what we can about the trailing footer block."""
    doc = ctx.doc
    data = ctx.data
    # Start early enough to cover the whole footer whichever end is nearer.
    tail_start = max(0, min(pos - 8, len(data) - 256))
    tail = bytes(data[tail_start:])
    index = tail.rfind(_FOOTER_PREFIX)
    if index < 0:
        doc.warn("footer magic not found; the file may be truncated")
        return
    doc.has_footer = True
    version_at = tail_start + index - 124
    if version_at >= 0:
        (footer_version,) = struct.unpack_from("<I", data, version_at)
        doc.footer_version = footer_version
        if doc.version is not None and footer_version != doc.version:
            doc.warn(
                f"footer version {footer_version} does not match header version "
                f"{doc.version}"
            )
    trailing = len(data) - (tail_start + index + len(FOOTER_MAGIC))
    if trailing > 0:
        doc.warn(f"{trailing} bytes follow the footer magic")
