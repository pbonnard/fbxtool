"""Format detection and the front door for reading FBX files."""

from __future__ import annotations

import mmap
import os
from typing import BinaryIO

from .ascii import is_ascii_fbx, parse_ascii
from .binary import MAGIC, is_binary_fbx, parse_binary
from .blend import is_blend, parse_blend
from .gltf import is_gltf, parse_gltf, starts_json_object
from .kn5 import is_kn5, parse_kn5
from .maxfile import is_compound, parse_max
from .model import Document, UnsupportedFormatError
from .obj import is_obj, parse_obj

__all__ = ["detect_format", "read_fbx", "read_model", "parse_bytes"]

_SNIFF_SIZE = 8192
# Above this, binary files are mapped rather than read into memory.
_MMAP_THRESHOLD = 8 * 1024 * 1024


def detect_format(data: bytes) -> str:
    """Identify a file from its head.

    Returns ``"binary"`` or ``"ascii"`` for FBX, ``"obj"``, ``"blend"``,
    ``"gltf"``, ``"max"``, ``"kn5"``, or ``"unknown"``. The FBX names are kept
    as they were so existing callers continue to work.

    A ``.max`` is answered from its container alone, since what distinguishes
    it from another compound file is a stream too deep in to sniff; reading it
    is where that is settled.

    A ``.gltf`` is answered from whatever it is given. The block that names it
    one may sit far past any head worth reading, so a caller holding only a
    head can get ``"unknown"`` for a file that is a glTF; both readers here ask
    again with the whole document before refusing it.
    """
    if is_binary_fbx(data[: len(MAGIC)]):
        return "binary"
    if is_kn5(data):
        return "kn5"
    if is_compound(data):
        return "max"
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

    Handles FBX (binary and ASCII), Wavefront OBJ, glTF 2.0, Blender .blend,
    3ds Max .max and Assetto Corsa .kn5 files.
    """
    path = os.fspath(path)
    with open(path, "rb") as handle:
        head = handle.read(_SNIFF_SIZE)
        kind = detect_format(head)
        # A .gltf can put the one block that names it a long way past any head
        # worth sniffing: JSON has no key order, and an exporter that sorts its
        # keys writes `accessors` first — 132 KB of it, one number to a line, in
        # a Sketchfab export of an E-Type. A file that begins a JSON object and
        # says nothing else deserves to be read in full before it is refused.
        if kind == "unknown" and starts_json_object(head):
            handle.seek(0)
            whole = handle.read()
            if is_gltf(whole):
                return parse_gltf(whole, path=path, load_arrays=load_arrays)
        if kind == "kn5":
            handle.seek(0)
            return parse_kn5(handle.read(), path=path, load_arrays=load_arrays)
        if kind == "max":
            handle.seek(0)
            return parse_max(handle.read(), path=path, load_arrays=load_arrays)
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
        f"{path}: unrecognised format — not FBX (binary or ASCII), OBJ, glTF, "
        ".blend, .max or .kn5"
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
    # The whole document is here, so a .gltf that carries its asset block past
    # the sniffing window costs nothing to recognise.
    if kind == "unknown" and starts_json_object(data) and is_gltf(data):
        kind = "gltf"
    if kind == "kn5":
        return parse_kn5(data, path=path, load_arrays=load_arrays)
    if kind == "max":
        return parse_max(data, path=path, load_arrays=load_arrays)
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
        "unrecognised format — not FBX (binary or ASCII), OBJ, glTF, "
        ".blend, .max or .kn5"
    )
