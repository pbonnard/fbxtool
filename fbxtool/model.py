"""Core data model shared by the ASCII and binary FBX readers.

An FBX file — in either encoding — is a tree of *node records*.  Every record
has a name, an ordered list of properties, and an optional list of child
records.  The two encodings differ only in how that tree is serialised, so both
readers produce the same :class:`Node` structure and everything downstream
(analysis, reporting) works on files of either kind.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Iterator, Sequence

__all__ = [
    "ArrayInfo",
    "Property",
    "Node",
    "Document",
    "FbxError",
    "ParseError",
    "UnsupportedFormatError",
    "SCALAR_TYPES",
    "ARRAY_TYPES",
    "SPECIAL_TYPES",
]


class FbxError(Exception):
    """Base class for every error raised by this package."""


class ParseError(FbxError):
    """The file looks like FBX but could not be decoded."""


class UnsupportedFormatError(FbxError):
    """The file is not an FBX file we know how to read."""


#: Binary property type codes that hold a single scalar value.
SCALAR_TYPES = {
    "Y": "int16",
    "C": "bool",
    "I": "int32",
    "F": "float32",
    "D": "float64",
    "L": "int64",
}

#: Binary property type codes that hold an (optionally deflated) array.
ARRAY_TYPES = {
    "f": "float32",
    "d": "float64",
    "l": "int64",
    "i": "int32",
    "b": "bool",
}

#: Binary property type codes with a length-prefixed payload.
SPECIAL_TYPES = {"S": "string", "R": "raw"}

#: Pseudo type codes used by the ASCII reader, which has no explicit typing.
_ASCII_TYPES = {
    "*": "array-size",
    "W": "word",
}

_ENCODINGS = {0: "raw", 1: "deflate"}


def _human_bytes(n: int) -> str:
    step = 1024.0
    value = float(n)
    for unit in ("B", "KiB", "MiB", "GiB"):
        if value < step or unit == "GiB":
            if unit == "B":
                return f"{int(value)} B"
            return f"{value:.1f} {unit}"
        value /= step
    return f"{value:.1f} GiB"  # pragma: no cover - unreachable


@dataclass
class ArrayInfo:
    """Metadata about an array-valued property.

    ``byte_length`` is the number of bytes the payload occupies *in the file*,
    which is the deflated size when ``encoding`` is non-zero.
    """

    length: int
    encoding: int = 0
    byte_length: int = 0
    #: File offset of the payload (binary files only; 0 for ASCII).
    data_offset: int = 0

    @property
    def compressed(self) -> bool:
        return self.encoding != 0

    @property
    def encoding_name(self) -> str:
        return _ENCODINGS.get(self.encoding, f"unknown({self.encoding})")


@dataclass
class Property:
    """A single property of a node record."""

    code: str
    value: Any = None
    array: ArrayInfo | None = None

    @property
    def type_name(self) -> str:
        if self.array is not None:
            base = ARRAY_TYPES.get(self.code, self.code)
            return f"{base}[]"
        for table in (SCALAR_TYPES, SPECIAL_TYPES, _ASCII_TYPES):
            if self.code in table:
                return table[self.code]
        return f"unknown({self.code})"

    @property
    def is_array(self) -> bool:
        return self.array is not None

    def summary(self, max_len: int = 64, preview: int = 6) -> str:
        """A short, printable rendering of the value."""
        if self.array is not None:
            info = self.array
            bits = [f"*{info.length}", f"[{self.code}]", info.encoding_name]
            bits.append(_human_bytes(info.byte_length))
            text = " ".join(bits)
            if self.value:
                shown = ", ".join(_fmt_scalar(v) for v in self.value[:preview])
                if len(self.value) > preview:
                    shown += ", ..."
                text += f" {{{shown}}}"
            return text
        if self.code == "S":
            text = str(self.value).replace("\x00\x01", "::")
            if len(text) > max_len:
                text = text[: max_len - 3] + "..."
            return f'"{text}"'
        if self.code == "R":
            data = self.value or b""
            head = data[:8].hex(" ")
            more = "..." if len(data) > 8 else ""
            return f"<raw {len(data)} B: {head}{more}>"
        if self.code == "*":
            return f"*{self.value}"
        return _fmt_scalar(self.value)


def _fmt_scalar(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, float):
        return f"{value:g}"
    if isinstance(value, str):
        return f'"{value}"'
    return str(value)


@dataclass
class Node:
    """A single FBX node record."""

    name: str
    props: list[Property] = field(default_factory=list)
    children: list["Node"] = field(default_factory=list)
    #: Byte offset of the record (binary files) — ``None`` for ASCII.
    offset: int | None = None
    #: Byte offset just past the record (binary files).
    end_offset: int | None = None
    #: 1-based source line (ASCII files) — ``None`` for binary.
    line: int | None = None

    # -- lookup helpers ---------------------------------------------------
    def get(self, name: str) -> "Node | None":
        """The first direct child called *name*, or ``None``."""
        for child in self.children:
            if child.name == name:
                return child
        return None

    def get_all(self, name: str) -> list["Node"]:
        """Every direct child called *name*."""
        return [child for child in self.children if child.name == name]

    def path(self, *names: str) -> "Node | None":
        """Follow a chain of child names, e.g. ``path("Definitions", "Count")``."""
        node: Node | None = self
        for name in names:
            if node is None:
                return None
            node = node.get(name)
        return node

    def value(self, index: int = 0, default: Any = None) -> Any:
        """The value of property *index*, or *default* if it is absent."""
        if 0 <= index < len(self.props):
            return self.props[index].value
        return default

    def path_value(self, *names: str, index: int = 0, default: Any = None) -> Any:
        node = self.path(*names)
        if node is None:
            return default
        return node.value(index, default)

    def walk(self, _depth: int = 0) -> Iterator[tuple[int, "Node"]]:
        """Yield ``(depth, node)`` for every descendant, depth-first."""
        for child in self.children:
            yield _depth, child
            yield from child.walk(_depth + 1)

    def count_nodes(self) -> int:
        """Number of records below this one."""
        return sum(1 + child.count_nodes() for child in self.children)

    def depth(self) -> int:
        """Height of the subtree below this node (0 when it has no children)."""
        if not self.children:
            return 0
        return 1 + max(child.depth() for child in self.children)

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"<Node {self.name!r} props={len(self.props)} children={len(self.children)}>"


@dataclass
class Document:
    """A parsed FBX file."""

    root: Node
    encoding: str  # "binary", "ascii" or "obj"
    #: Which family the file belongs to: "fbx", "obj" or "blend".
    format: str = "fbx"
    version: int | None = None
    path: str | None = None
    file_size: int = 0
    #: Set for binary files: 7500+ uses 64-bit node offsets.
    wide_offsets: bool = False
    #: Version recorded in the binary footer, when one is present.
    footer_version: int | None = None
    has_footer: bool = False
    #: Where the version came from ("header", "FBXHeaderExtension", "comment").
    version_source: str | None = None
    warnings: list[str] = field(default_factory=list)
    #: Format-specific facts that do not fit the FBX-shaped fields.
    extra: dict = field(default_factory=dict)

    @property
    def top_level(self) -> Sequence[Node]:
        return self.root.children

    def warn(self, message: str) -> None:
        if message not in self.warnings:
            self.warnings.append(message)
