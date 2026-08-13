"""Format detection and the front door for reading FBX files."""

from __future__ import annotations

import mmap
import os
from typing import BinaryIO

from .ascii import is_ascii_fbx, parse_ascii
from .binary import MAGIC, is_binary_fbx, parse_binary
from .model import Document, UnsupportedFormatError

__all__ = ["detect_format", "read_fbx", "parse_bytes"]

_SNIFF_SIZE = 8192
# Above this, binary files are mapped rather than read into memory.
_MMAP_THRESHOLD = 8 * 1024 * 1024


def detect_format(data: bytes) -> str:
    """Return ``"binary"``, ``"ascii"``, or ``"unknown"`` for a file head."""
    if is_binary_fbx(data[: len(MAGIC)]):
        return "binary"
    text = _decode(data)
    if text is not None and is_ascii_fbx(text):
        return "ascii"
    return "unknown"


def _decode(data: bytes) -> str | None:
    """Decode a file head as text, tolerating a truncated multi-byte tail."""
    for encoding in ("utf-8-sig", "latin-1"):
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue
    return None


def read_fbx(
    path: str | os.PathLike[str],
    *,
    load_arrays: bool = False,
    max_array_values: int | None = None,
) -> Document:
    """Read the FBX file at *path*, choosing the reader by content sniffing."""
    path = os.fspath(path)
    with open(path, "rb") as handle:
        head = handle.read(_SNIFF_SIZE)
        kind = detect_format(head)
        if kind == "binary":
            return _read_binary(
                handle, path, load_arrays=load_arrays, max_array_values=max_array_values
            )
        if kind == "ascii":
            handle.seek(0)
            raw = handle.read()
            text = _decode(raw)
            if text is None:  # pragma: no cover - _decode falls back to latin-1
                raise UnsupportedFormatError(f"{path}: could not decode as text")
            doc = parse_ascii(
                text,
                path=path,
                load_arrays=load_arrays,
                max_array_values=max_array_values,
            )
            doc.file_size = len(raw)
            return doc
    raise UnsupportedFormatError(
        f"{path}: not an FBX file (no binary magic and no recognisable ASCII records)"
    )


def _read_binary(
    handle: BinaryIO,
    path: str,
    *,
    load_arrays: bool,
    max_array_values: int | None,
) -> Document:
    size = os.fstat(handle.fileno()).st_size
    handle.seek(0)
    if size >= _MMAP_THRESHOLD:
        with mmap.mmap(handle.fileno(), 0, access=mmap.ACCESS_READ) as mapped:
            return parse_binary(
                mapped,
                path=path,
                load_arrays=load_arrays,
                max_array_values=max_array_values,
            )
    return parse_binary(
        handle.read(),
        path=path,
        load_arrays=load_arrays,
        max_array_values=max_array_values,
    )


def parse_bytes(
    data: bytes,
    *,
    path: str | None = None,
    load_arrays: bool = False,
    max_array_values: int | None = None,
) -> Document:
    """Parse an in-memory FBX file of either encoding."""
    kind = detect_format(data[:_SNIFF_SIZE])
    if kind == "binary":
        return parse_binary(
            data, path=path, load_arrays=load_arrays, max_array_values=max_array_values
        )
    if kind == "ascii":
        text = _decode(data)
        if text is None:  # pragma: no cover - _decode falls back to latin-1
            raise UnsupportedFormatError("could not decode data as text")
        doc = parse_ascii(
            text, path=path, load_arrays=load_arrays, max_array_values=max_array_values
        )
        doc.file_size = len(data)
        return doc
    raise UnsupportedFormatError(
        "not an FBX file (no binary magic and no recognisable ASCII records)"
    )
