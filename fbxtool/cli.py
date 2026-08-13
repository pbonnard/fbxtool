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
from .report import render_text, to_dict

__all__ = ["main", "build_parser"]

_EPILOG = """\
examples:
  fbxinfo scene.fbx                     summary: version, settings, objects, hierarchy
  fbxinfo scene.fbx --tree --depth 3    the record tree, three levels deep
  fbxinfo scene.fbx --objects --props   every object plus full property values
  fbxinfo scene.fbx --json > scene.json machine-readable output
  fbxinfo *.fbx --brief                 one line per file
"""


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="fbxinfo",
        description=(
            "Report the format version and object structure of FBX files, "
            "in both the ASCII and binary encodings."
        ),
        epilog=_EPILOG,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("files", metavar="FILE", nargs="+", help="FBX file(s) to inspect")
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
    return parser


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
            print(f"fbxinfo: {path}: {exc}", file=sys.stderr)
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

    for index, (path, item) in enumerate(documents):
        if args.brief:
            print(_brief(path, item))
            continue
        if index:
            print("\n" + "=" * 72)
        sys.stdout.write(
            render_text(
                item,
                show_tree=args.tree,
                tree_depth=args.depth,
                show_props=args.props,
                show_objects=args.objects,
                show_connections=args.connections,
                show_hierarchy=args.hierarchy,
                max_list=args.max_list,
            )
        )
    return status


def _brief(path: str, analysis) -> str:
    version = analysis.version
    version_text = version.label if version else "version unknown"
    doc = analysis.doc
    parts = [
        path,
        doc.encoding,
        version_text,
        f"{analysis.total_records:,} records",
        f"{analysis.object_count:,} objects",
        f"{len(analysis.connections):,} connections",
    ]
    if doc.warnings:
        parts.append(f"{len(doc.warnings)} warning(s)")
    return "  |  ".join(parts)


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
