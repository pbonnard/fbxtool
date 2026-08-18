"""fbxtool — inspect model files without the FBX SDK.

Reads FBX (binary and ASCII), Wavefront OBJ, glTF 2.0, Blender .blend,
3ds Max .max and Assetto Corsa .kn5.

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
from .blend import parse_blend
from .gltf import parse_gltf
from .kn5 import parse_kn5
from .dae import parse_dae
from .obj import parse_mtl, parse_obj
from .reader import detect_format, parse_bytes, read_fbx, read_model
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
    "parse_blend",
    "parse_gltf",
    "parse_kn5",
    "parse_mtl",
    "parse_dae",
    "parse_obj",
    "read_fbx",
    "read_model",
    "render_text",
    "render_tree",
    "to_dict",
]
