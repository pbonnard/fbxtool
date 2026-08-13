"""fbxtool — inspect FBX files (ASCII and binary) without the FBX SDK.

Typical use::

    from fbxtool import read_fbx, analyze

    doc = read_fbx("scene.fbx")
    print(doc.encoding, doc.version)       # 'binary' 7400

    info = analyze(doc)
    for obj in info.objects:
        print(obj.kind, obj.display_name)
"""

from __future__ import annotations

from .analyze import Analysis, Connection, SceneNode, SceneObject, analyze
from .ascii import parse_ascii
from .binary import parse_binary
from .model import (
    ArrayInfo,
    Document,
    FbxError,
    Node,
    ParseError,
    Property,
    UnsupportedFormatError,
)
from .reader import detect_format, parse_bytes, read_fbx
from .report import render_text, render_tree, to_dict
from .versions import KNOWN_VERSIONS, VersionInfo, describe

__version__ = "1.0.0"

__all__ = [
    "__version__",
    "Analysis",
    "ArrayInfo",
    "Connection",
    "Document",
    "FbxError",
    "KNOWN_VERSIONS",
    "Node",
    "ParseError",
    "Property",
    "SceneNode",
    "SceneObject",
    "UnsupportedFormatError",
    "VersionInfo",
    "analyze",
    "describe",
    "detect_format",
    "parse_ascii",
    "parse_binary",
    "parse_bytes",
    "read_fbx",
    "render_text",
    "render_tree",
    "to_dict",
]
