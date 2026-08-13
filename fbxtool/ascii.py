"""Reader for the ASCII FBX format.

The ASCII form carries the same record tree as the binary form, written as::

    ; FBX 7.3.0 project file
    ; ----------------------

    FBXHeaderExtension:  {
        FBXVersion: 7300
        Creator: "FBX SDK/FBX Plugins version 2013.3"
    }
    Objects:  {
        Geometry: 140717632, "Geometry::", "Mesh" {
            Vertices: *24 {
                a: -1,-1,1,1,-1,1,1,1,1
            }
        }
    }

Records are ``Name: prop, prop {children}``; ``;`` starts a comment; a trailing
comma continues a property list onto the next line; and ``*N`` is the element
count that precedes a large array.  Since ASCII has no type codes, values are
typed by inspection and the ``a:`` records that hold bulk data are folded into
a single array property so that both readers describe arrays the same way.
"""

from __future__ import annotations

import re
from collections import deque
from typing import Iterator

from .model import ArrayInfo, Document, Node, ParseError, Property

__all__ = ["is_ascii_fbx", "parse_ascii"]

_MAX_DEPTH = 256

# Token kinds.
_NAME = "name"
_STRING = "string"
_WORD = "word"
_COLON = "colon"
_COMMA = "comma"
_LBRACE = "lbrace"
_RBRACE = "rbrace"
_NEWLINE = "newline"
_EOF = "eof"

_INT_RE = re.compile(r"^[+-]?\d+$")
_FLOAT_RE = re.compile(r"^[+-]?(\d+\.\d*|\.\d+|\d+)([eE][+-]?\d+)?$")
_COUNT_RE = re.compile(r"^\*(\d+)$")
_VERSION_COMMENT_RE = re.compile(r";\s*FBX\s+(\d+)\.(\d+)\.(\d+)", re.IGNORECASE)
_NODE_LINE_RE = re.compile(r"^\s*[A-Za-z_][\w]*\s*:", re.MULTILINE)

# IEEE specials as emitted by MSVC-based exporters.
_SPECIAL_FLOATS = {
    "1.#inf": float("inf"),
    "-1.#inf": float("-inf"),
    "1.#ind": float("nan"),
    "-1.#ind": float("nan"),
    "1.#qnan": float("nan"),
    "-1.#qnan": float("nan"),
    "nan": float("nan"),
    "inf": float("inf"),
    "-inf": float("-inf"),
}


class _Token:
    __slots__ = ("kind", "text", "line")

    def __init__(self, kind: str, text: str, line: int) -> None:
        self.kind = kind
        self.text = text
        self.line = line

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"<{self.kind} {self.text!r} line {self.line}>"


def is_ascii_fbx(text: str) -> bool:
    """Heuristic check that *text* is the head of an ASCII FBX file."""
    if _VERSION_COMMENT_RE.search(text):
        return True
    head = text[:8192]
    if "FBXHeaderExtension" in head or "FBXVersion" in head:
        return True
    # Fall back to shape: a couple of ``Name:`` records and a brace.
    return len(_NODE_LINE_RE.findall(head)) >= 2 and "{" in head


def parse_ascii(
    text: str,
    *,
    path: str | None = None,
    load_arrays: bool = False,
    max_array_values: int | None = None,
) -> Document:
    """Parse ASCII FBX *text* into a Document."""
    if text.startswith("﻿"):
        text = text[1:]

    doc = Document(
        root=Node(""),
        encoding="ascii",
        path=path,
        file_size=len(text.encode("utf-8", "replace")),
    )

    parser = _Parser(text, doc, load_arrays=load_arrays, max_array_values=max_array_values)
    doc.root.children.extend(parser.parse_records(depth=0, inside_braces=False))

    version = doc.root.path_value("FBXHeaderExtension", "FBXVersion")
    if isinstance(version, int):
        doc.version = version
        doc.version_source = "FBXHeaderExtension"
    else:
        match = _VERSION_COMMENT_RE.search(text[:4096])
        if match:
            major, minor, patch = (int(g) for g in match.groups())
            doc.version = major * 1000 + minor * 100 + patch
            doc.version_source = "header comment"
        else:
            doc.warn("no FBXVersion record and no version comment; version unknown")

    if not doc.root.children:
        doc.warn("no records were found")
    return doc


def _tokenize(text: str) -> Iterator[_Token]:
    length = len(text)
    pos = 0
    line = 1
    while pos < length:
        ch = text[pos]
        if ch == "\n":
            yield _Token(_NEWLINE, "\n", line)
            line += 1
            pos += 1
        elif ch in " \t\r\f\v":
            pos += 1
        elif ch == ";":
            end = text.find("\n", pos)
            pos = length if end < 0 else end
        elif ch == '"':
            start = pos + 1
            end = text.find('"', start)
            if end < 0:
                raise ParseError(f"unterminated string on line {line}")
            raw = text[start:end]
            yield _Token(_STRING, _unescape(raw), line)
            line += raw.count("\n")
            pos = end + 1
        elif ch == ":":
            yield _Token(_COLON, ":", line)
            pos += 1
        elif ch == ",":
            yield _Token(_COMMA, ",", line)
            pos += 1
        elif ch == "{":
            yield _Token(_LBRACE, "{", line)
            pos += 1
        elif ch == "}":
            yield _Token(_RBRACE, "}", line)
            pos += 1
        else:
            start = pos
            while pos < length and text[pos] not in ' \t\r\f\v\n;":,{}':
                pos += 1
            yield _Token(_WORD, text[start:pos], line)
    yield _Token(_EOF, "", line)


def _unescape(raw: str) -> str:
    if "&quot;" in raw:
        raw = raw.replace("&quot;", '"')
    if "\\" in raw:
        raw = raw.replace('\\"', '"')
    return raw


class _Parser:
    """Recursive-descent parser over a bounded-lookahead token stream."""

    def __init__(self, text: str, doc: Document, *, load_arrays: bool,
                 max_array_values: int | None) -> None:
        self._tokens = _tokenize(text)
        self._buffer: deque[_Token] = deque()
        self._doc = doc
        self._load_arrays = load_arrays
        self._max_array_values = max_array_values

    # -- token access -----------------------------------------------------
    def _peek(self, index: int = 0) -> _Token:
        while len(self._buffer) <= index:
            self._buffer.append(next(self._tokens))
        return self._buffer[index]

    def _next(self) -> _Token:
        token = self._peek()
        self._buffer.popleft()
        return token

    def _skip_newlines(self) -> None:
        while self._peek().kind == _NEWLINE:
            self._next()

    # -- grammar ----------------------------------------------------------
    def parse_records(self, depth: int, inside_braces: bool) -> list[Node]:
        if depth > _MAX_DEPTH:
            raise ParseError(f"record nesting deeper than {_MAX_DEPTH}")
        records: list[Node] = []
        while True:
            self._skip_newlines()
            token = self._peek()
            if token.kind == _EOF:
                if inside_braces:
                    self._doc.warn(f"file ends with an unclosed '{{' (line {token.line})")
                return records
            if token.kind == _RBRACE:
                if not inside_braces:
                    self._doc.warn(f"stray '}}' on line {token.line}")
                    self._next()
                    continue
                return records
            record = self._parse_record(depth)
            if record is not None:
                records.append(record)

    def _parse_record(self, depth: int) -> Node | None:
        token = self._next()
        if token.kind not in (_WORD, _STRING):
            self._doc.warn(f"unexpected {token.text!r} on line {token.line}; skipped")
            return None
        if self._peek().kind != _COLON:
            self._doc.warn(
                f"record {token.text!r} on line {token.line} is not followed by ':'; skipped"
            )
            return None
        self._next()  # consume ':'

        node = Node(name=token.text, line=token.line)
        node.props.extend(self._parse_properties(node.name))

        if self._peek().kind == _LBRACE:
            self._next()
            node.children.extend(self.parse_records(depth + 1, inside_braces=True))
            if self._peek().kind == _RBRACE:
                self._next()
        return node

    def _parse_properties(self, name: str) -> list[Property]:
        values: list[object] = []
        while True:
            token = self._peek()
            if token.kind in (_NEWLINE, _LBRACE, _RBRACE, _EOF):
                break
            if token.kind == _COMMA:  # empty slot, e.g. ``P: "a",,1``
                self._next()
                values.append(None)
                continue
            values.append(_parse_value(self._next()))
            if not self._consume_separator():
                break
        if name == "a":
            return _fold_array(values, self._load_arrays, self._max_array_values)
        return [_make_property(value) for value in values]

    def _consume_separator(self) -> bool:
        """Consume a ``,`` separator, including one wrapped across newlines."""
        if self._peek().kind == _COMMA:
            self._next()
            self._skip_newlines()
            return True
        # Some writers break the line *before* the comma.
        index = 0
        while self._peek(index).kind == _NEWLINE:
            index += 1
        if index and self._peek(index).kind == _COMMA:
            for _ in range(index + 1):
                self._next()
            self._skip_newlines()
            return True
        return False


def _parse_value(token: _Token):
    if token.kind == _STRING:
        return token.text
    text = token.text
    match = _COUNT_RE.match(text)
    if match:
        return _ArrayCount(int(match.group(1)))
    if _INT_RE.match(text):
        return int(text)
    if _FLOAT_RE.match(text):
        return float(text)
    lowered = text.lower()
    if lowered in _SPECIAL_FLOATS:
        return _SPECIAL_FLOATS[lowered]
    return _Word(text)


class _ArrayCount(int):
    """An ``*N`` array-size marker."""


class _Word(str):
    """An unquoted token that is not a number (e.g. ``T``, ``Y``)."""


def _make_property(value) -> Property:
    if isinstance(value, _ArrayCount):
        return Property("*", int(value))
    if isinstance(value, _Word):
        return Property("W", str(value))
    if isinstance(value, bool):
        return Property("C", value)
    if isinstance(value, int):
        return Property("L", value)
    if isinstance(value, float):
        return Property("D", value)
    if isinstance(value, str):
        return Property("S", value)
    return Property("W", "" if value is None else str(value))


def _fold_array(values: list, load_arrays: bool, max_array_values: int | None) -> list[Property]:
    """Collapse the values of an ``a:`` record into one array property."""
    if not values:
        return []
    code = "l" if all(isinstance(v, int) and not isinstance(v, bool) for v in values) else "d"
    info = ArrayInfo(length=len(values), encoding=0, byte_length=0)
    kept = None
    if load_arrays:
        kept = values if max_array_values is None else values[:max_array_values]
        kept = [float(v) if code == "d" else int(v) for v in kept if isinstance(v, (int, float))]
    return [Property(code, kept, info)]
