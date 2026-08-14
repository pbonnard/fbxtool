"""Format detection and the front door for reading FBX files."""

from __future__ import annotations

import mmap
import os
from typing import BinaryIO

from .ascii import is_ascii_fbx, parse_ascii
from .binary import MAGIC, is_binary_fbx, parse_binary
from .blend import is_blend, parse_blend
from .gltf import is_gltf, parse_gltf
from .model import Document, UnsupportedFormatError
from .obj import is_obj, parse_obj

__all__ = ["detect_format", "read_fbx", "read_model", "parse_bytes"]

_SNIFF_SIZE = 8192
# Above this, binary files are mapped rather than read into memory.
_MMAP_THRESHOLD = 8 * 1024 * 1024


def detect_format(data: bytes) -> str:
    """Identify a file from its head.

    Returns ``"binary"`` or ``"ascii"`` for FBX, ``"obj"``, ``"blend"``,
    ``"gltf"``, or ``"unknown"``. The FBX names are kept as they were so
    existing callers continue to work.
    """
    if is_binary_fbx(data[: len(MAGIC)]):
        return "binary"
    if is_blend(data):
        return "blend"
    if is_gltf(data):
        return "gltf"
    text = _decode(data)
    if text is None:
        return "unknown"
    if is_ascii_fbx(text):
        return "ascii"
    if is_obj(text):
        return "obj"
    return "unknown"


def _decode(data: bytes) -> str | None:
    """Decode a file head as text, tolerating a truncated multi-byte tail."""
    for encoding in ("utf-8-sig", "latin-1"):
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue
    return None


def read_model(
    path: str | os.PathLike[str],
    *,
    load_arrays: bool = False,
    max_array_values: int | None = None,
) -> Document:
    """Read the model file at *path*, choosing the reader by content sniffing.

    Handles FBX (binary and ASCII), Wavefront OBJ, glTF 2.0 and Blender
    .blend files.
    """
    path = os.fspath(path)
    with open(path, "rb") as handle:
        head = handle.read(_SNIFF_SIZE)
        kind = detect_format(head)
        if kind == "gltf":
            handle.seek(0)
            return parse_gltf(handle.read(), path=path, load_arrays=load_arrays)
        if kind == "blend":
            handle.seek(0)
            return parse_blend(handle.read(), path=path,
                               load_arrays=load_arrays)
        if kind == "obj":
            handle.seek(0)
            raw = handle.read()
            text = _decode(raw) or ""
            doc = parse_obj(text, path=path, load_arrays=load_arrays,
                            materials=_sibling_mtl(path, text))
            doc.file_size = len(raw)
            return doc
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
        f"{path}: unrecognised format — not FBX (binary or ASCII), OBJ, glTF "
        "or .blend"
    )


#: Kept as the original name; it now reads any supported format.
read_fbx = read_model


def _sibling_mtl(path: str, text: str) -> dict[str, str]:
    """Load the .mtl libraries an OBJ names, from beside the file.

    Only files in the OBJ's own directory are read, and the name is reduced to
    its basename first, so a library recorded with an absolute path from
    another machine still resolves.
    """
    directory = os.path.dirname(os.path.abspath(path))
    libraries: dict[str, str] = {}
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped.lower().startswith("mtllib"):
            continue
        for name in stripped.split()[1:]:
            base = os.path.basename(name.replace("\\", "/"))
            candidate = os.path.join(directory, base)
            if base in libraries or not os.path.isfile(candidate):
                continue
            try:
                with open(candidate, "rb") as handle:
                    libraries[base] = _decode(handle.read()) or ""
            except OSError:
                continue
    return libraries


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
    """Parse an in-memory model file, in any format read from disk."""
    kind = detect_format(data[:_SNIFF_SIZE])
    if kind == "gltf":
        return parse_gltf(data, path=path, load_arrays=load_arrays)
    if kind == "blend":
        return parse_blend(data, path=path, load_arrays=load_arrays)
    if kind == "obj":
        text = _decode(data) or ""
        doc = parse_obj(text, path=path, load_arrays=load_arrays)
        doc.file_size = len(data)
        return doc
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
        "unrecognised format — not FBX (binary or ASCII), OBJ, glTF or .blend"
    )
