"""Command line interface: ``fbxinfo`` / ``python -m fbxtool``."""

from __future__ import annotations

import argparse
import json
import sys
from typing import Sequence

from . import __version__
from .analyze import analyze
from .model import FbxError
from .reader import read_fbx
from .report import ASCII_FALLBACKS, render_text, to_ascii, to_dict

__all__ = ["main", "build_parser"]

_EPILOG = """\
examples:
  fbxinfo scene.fbx                     summary: version, settings, objects, hierarchy
  fbxinfo model.obj                     the same report for a Wavefront OBJ
  fbxinfo scene.blend                   Blender container: version, blocks, DNA
  fbxinfo model.glb                     glTF 2.0, either container
  fbxinfo car.kn5                       an Assetto Corsa model, textures and all
  fbxinfo scene.fbx --tree --depth 3    the record tree, three levels deep
  fbxinfo scene.fbx --objects --props   every object plus full property values
  fbxinfo scene.fbx --json > scene.json machine-readable output
  fbxinfo *.fbx *.obj --brief           one line per file

An .obj is read with any .mtl it names from the same directory, and is
normalised into the same record tree as FBX, so every option below applies.
A .blend is reported as a container — version, file-blocks and SDNA — since
its struct layouts are Blender's internal business and change between
releases; no geometry is extracted from one.
A .kn5 is Assetto Corsa's own model file: its textures, materials and node
tree are read out of the one file, and the same report applies.
"""


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="fbxinfo",
        description=(
            "Report the format version and object structure of model files: "
            "FBX (binary and ASCII), Wavefront OBJ, glTF 2.0, Blender .blend, "
            "3ds Max .max and Assetto Corsa .kn5."
        ),
        epilog=_EPILOG,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("files", metavar="FILE", nargs="+",
                        help="model file(s) to inspect: .fbx, .obj, .gltf, .glb, "
                             ".blend, .max or .kn5")
    parser.add_argument(
        "--version", action="version", version=f"%(prog)s {__version__}"
    )

    sections = parser.add_argument_group("sections")
    sections.add_argument("--tree", action="store_true",
                          help="print the raw record tree")
    sections.add_argument("--depth", type=int, default=None, metavar="N",
                          help="limit --tree to N levels")
    sections.add_argument("--props", action="store_true",
                          help="print every property value, not just a preview")
    sections.add_argument("--objects", action="store_true",
                          help="list the Objects section entry by entry")
    sections.add_argument("--connections", action="store_true",
                          help="list connections individually, with names resolved")
    sections.add_argument("--no-hierarchy", dest="hierarchy", action="store_false",
                          help="skip the reconstructed scene hierarchy")
    sections.add_argument("-a", "--all", action="store_true",
                          help="everything: --tree --props --objects --connections")
    sections.add_argument("--brief", action="store_true",
                          help="one summary line per file")

    output = parser.add_argument_group("output")
    output.add_argument("--json", action="store_true",
                        help="emit JSON instead of text")
    output.add_argument("--indent", type=int, default=2, metavar="N",
                        help="JSON indent (default: 2, 0 for compact)")
    output.add_argument("--max-list", type=int, default=40, metavar="N",
                        help="cap listed objects/connections/hierarchy rows (default: 40)")
    output.add_argument("--decode-arrays", action="store_true",
                        help="decode (and inflate) array payloads so values can be shown")
    output.add_argument("--max-array", type=int, default=64, metavar="N",
                        help="keep at most N values per decoded array (0 for all)")
    output.add_argument("--ascii", dest="ascii_only", action="store_true",
                        help="draw with plain ASCII instead of box-drawing "
                             "characters (automatic when the output encoding "
                             "cannot represent them)")
    return parser


def _needs_ascii(stream) -> bool:
    """True when *stream* cannot encode the characters the report draws with.

    A Windows console writes UTF-8, but a redirected stdout falls back to the
    active code page (cp1252 and friends), which has no box-drawing characters.
    """
    encoding = getattr(stream, "encoding", None)
    if not encoding:
        return True
    probe = "".join(ASCII_FALLBACKS)
    try:
        probe.encode(encoding)
    except (UnicodeEncodeError, LookupError):
        return True
    return False


def _write(text: str, ascii_only: bool) -> None:
    if ascii_only:
        text = to_ascii(text)
    try:
        sys.stdout.write(text)
    except UnicodeEncodeError:
        # Belt and braces: a stream that misreports its own encoding.
        sys.stdout.write(to_ascii(text))


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.all:
        args.tree = args.props = args.objects = args.connections = True

    max_array = None if args.max_array <= 0 else args.max_array
    load_arrays = args.decode_arrays or (args.props and args.tree)

    documents = []
    status = 0
    for path in args.files:
        try:
            doc = read_fbx(path, load_arrays=load_arrays, max_array_values=max_array)
        except FbxError as exc:
            # Reader errors already carry the path.
            message = str(exc)
            if not message.startswith(path):
                message = f"{path}: {message}"
            print(f"fbxinfo: {message}", file=sys.stderr)
            status = 1
            continue
        except OSError as exc:
            print(f"fbxinfo: {exc.strerror or exc}: {path}", file=sys.stderr)
            status = 1
            continue
        documents.append((path, analyze(doc)))

    if args.json:
        payload = [
            to_dict(item, include_tree=args.tree, tree_depth=args.depth)
            for _, item in documents
        ]
        indent = args.indent if args.indent > 0 else None
        text = json.dumps(payload if len(payload) != 1 else payload[0],
                          indent=indent, default=str)
        print(text)
        return status

    ascii_only = args.ascii_only or _needs_ascii(sys.stdout)
    for index, (path, item) in enumerate(documents):
        if args.brief:
            _write(_brief(path, item) + "\n", ascii_only)
            continue
        if index:
            _write("\n" + "=" * 72 + "\n", ascii_only)
        _write(
            render_text(
                item,
                show_tree=args.tree,
                tree_depth=args.depth,
                show_props=args.props,
                show_objects=args.objects,
                show_connections=args.connections,
                show_hierarchy=args.hierarchy,
                max_list=args.max_list,
            ),
            ascii_only,
        )
    return status


def _brief(path: str, analysis) -> str:
    doc = analysis.doc
    if doc.format == "obj":
        descriptor = "Wavefront OBJ"
    elif doc.format == "blend":
        descriptor = f"Blender {doc.extra.get('blender_version_text', '?')}"
    elif doc.format == "gltf":
        descriptor = ("glTF " + (doc.extra.get("gltf_version") or "2.0")
                      + ("  |  .glb" if doc.encoding == "binary" else "  |  .gltf"))
    elif doc.format == "kn5":
        descriptor = f"Assetto Corsa kn5 v{doc.extra.get('kn5_version', '?')}"
    else:
        version = analysis.version
        descriptor = f"{doc.encoding}  |  " + (version.label if version
                                               else "version unknown")
    parts = [
        path,
        descriptor,
        f"{analysis.total_records:,} records",
        f"{analysis.object_count:,} objects",
        f"{len(analysis.connections):,} connections",
    ]
    if doc.warnings:
        parts.append(f"{len(doc.warnings)} warning(s)")
    return "  |  ".join(parts)


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
