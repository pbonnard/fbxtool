"""Human-readable and JSON renderings of an :class:`~fbxtool.analyze.Analysis`."""

from __future__ import annotations

from typing import Any, Iterable

from .analyze import Analysis, SceneNode, SceneObject
from .model import Document, Node

__all__ = ["render_text", "to_dict", "format_size", "render_tree", "to_ascii"]

_BRANCH = "├── "
_LAST = "└── "
_PIPE = "│   "
_BLANK = "    "

#: Every non-ASCII character this module can emit, and a plain substitute.
#: Used when the destination stream cannot represent them — a Windows console
#: code page such as cp1252 has none of the box-drawing characters, so writing
#: to a redirected file would otherwise raise ``UnicodeEncodeError``.
ASCII_FALLBACKS = {
    "─": "-",
    "├": "+",
    "└": "+",
    "│": "|",
    "—": "-",
    "→": "->",
    "…": "...",
}


def to_ascii(text: str) -> str:
    """Replace the report's box-drawing and typographic characters with ASCII."""
    for fancy, plain in ASCII_FALLBACKS.items():
        text = text.replace(fancy, plain)
    return text


def format_size(num: int) -> str:
    value = float(num)
    for unit in ("B", "KiB", "MiB", "GiB"):
        if value < 1024.0 or unit == "GiB":
            if unit == "B":
                return f"{int(value)} B"
            return f"{value:,.1f} {unit}"
        value /= 1024.0
    return f"{value:,.1f} GiB"  # pragma: no cover - unreachable


class _Out:
    """A tiny line buffer with section and key/value helpers."""

    def __init__(self) -> None:
        self.lines: list[str] = []

    def line(self, text: str = "") -> None:
        self.lines.append(text)

    def heading(self, text: str) -> None:
        if self.lines:
            self.line()
        self.line(text)
        self.line("─" * len(text))

    def pairs(self, items: Iterable[tuple[str, Any]], indent: str = "  ") -> None:
        rows = [(key, value) for key, value in items if value not in (None, "", [])]
        if not rows:
            return
        width = max(len(key) for key, _ in rows)
        for key, value in rows:
            self.line(f"{indent}{key + ':':<{width + 1}} {value}")

    def text(self) -> str:
        return "\n".join(self.lines) + "\n"


def render_text(
    analysis: Analysis,
    *,
    show_tree: bool = False,
    tree_depth: int | None = None,
    show_props: bool = False,
    show_objects: bool = False,
    show_connections: bool = False,
    show_hierarchy: bool = True,
    max_list: int = 40,
) -> str:
    """Render *analysis* as a report."""
    out = _Out()
    doc = analysis.doc

    _render_file(out, analysis)
    _render_metadata(out, analysis)
    _render_settings(out, analysis)
    _render_structure(out, analysis)
    _render_definitions(out, analysis)
    _render_object_summary(out, analysis)
    if show_hierarchy:
        _render_hierarchy(out, analysis, max_list=max_list)
    if show_objects:
        _render_object_list(out, analysis, max_list=max_list)
    _render_connections(out, analysis, detailed=show_connections, max_list=max_list)
    _render_animation(out, analysis)
    if show_tree:
        out.heading("Record tree")
        for line in render_tree(doc.root, max_depth=tree_depth, show_props=show_props):
            out.line(line)
    _render_warnings(out, doc)
    return out.text()


FORMAT_NAMES = {
    "fbx": "Autodesk FBX",
    "obj": "Wavefront OBJ",
    "blend": "Blender",
    "gltf": "glTF 2.0",
}


def _render_file(out: _Out, analysis: Analysis) -> None:
    doc = analysis.doc
    out.heading("File")
    rows: list[tuple[str, Any]] = [
        ("Path", doc.path or "<memory>"),
        ("Size", format_size(doc.file_size)),
        ("Format", FORMAT_NAMES.get(doc.format, doc.format)),
    ]

    if doc.format == "obj":
        rows.append(("Encoding", "text"))
        _render_obj_rows(rows, doc)
        out.pairs(rows)
        return
    if doc.format == "blend":
        _render_blend_rows(rows, doc)
        out.pairs(rows)
        return
    if doc.format == "gltf":
        _render_gltf_rows(rows, doc)
        out.pairs(rows)
        return

    rows.append(("Encoding", "binary" if doc.encoding == "binary" else "ASCII text"))
    version = analysis.version
    if version is not None:
        rows.append(("Version", version.label))
        if version.notes:
            rows.append(("Version note", version.notes))
        if doc.version_source:
            rows.append(("Version read from", doc.version_source))
    else:
        rows.append(("Version", "unknown"))

    if doc.encoding == "binary":
        rows.append(
            ("Node offsets", "64-bit (version >= 7500)" if doc.wide_offsets else "32-bit")
        )
        if doc.has_footer:
            footer = "present"
            if doc.footer_version is not None:
                footer += f", version stamp {doc.footer_version}"
            rows.append(("Footer", footer))
        else:
            rows.append(("Footer", "missing"))
    if version is not None and version.legacy_layout:
        rows.append(("Layout", "legacy 6.x (objects addressed by name, not UID)"))
    out.pairs(rows)


def _render_obj_rows(rows: list[tuple[str, Any]], doc) -> None:
    extra = doc.extra
    if extra.get("objects"):
        rows.append(("Objects (o)", ", ".join(extra["objects"][:8])
                     + (" …" if len(extra["objects"]) > 8 else "")))
    if extra.get("groups"):
        rows.append(("Groups (g)", ", ".join(extra["groups"][:8])
                     + (" …" if len(extra["groups"]) > 8 else "")))
    if extra.get("libraries"):
        rows.append(("Material libraries", ", ".join(extra["libraries"])))
        resolved = extra.get("materials_resolved", 0)
        rows.append(("Materials resolved", f"{resolved} from the .mtl"
                     if resolved else "none — the .mtl was not found beside the file"))
    if extra.get("smoothing_groups"):
        rows.append(("Smoothing groups", extra["smoothing_groups"]))
    if extra.get("line_or_point_statements"):
        rows.append(("Line/point statements", f"{extra['line_or_point_statements']}"
                                              " (not rendered)"))


def _render_gltf_rows(rows: list[tuple[str, Any]], doc) -> None:
    extra = doc.extra
    rows.append(("Container", "binary (.glb — JSON and a buffer chunk)"
                 if doc.encoding == "binary" else "text (.gltf)"))
    rows.append(("glTF version", extra.get("gltf_version") or "unknown"))
    rows.append(("Written by", extra.get("generator") or "unknown"))
    if extra.get("copyright"):
        rows.append(("Copyright", extra["copyright"]))
    primitives = extra.get("primitives", 0)
    rows.append(("Meshes", f"{extra.get('meshes', 0):,} "
                           f"({primitives:,} primitive{'' if primitives == 1 else 's'}, "
                           f"{extra.get('triangles', 0):,} triangles)"))
    rows.append(("Nodes", f"{extra.get('nodes', 0):,}"))
    rows.append(("Materials", f"{extra.get('materials', 0):,}"))
    rows.append(("Images", f"{extra.get('images', 0):,}"))
    rows.append(("Buffers", f"{extra.get('buffers', 0):,} "
                            f"({extra.get('buffer_views', 0):,} views, "
                            f"{extra.get('accessors', 0):,} accessors)"))
    if extra.get("external_buffers"):
        rows.append(("Read from beside it", ", ".join(extra["external_buffers"][:4])))
    if extra.get("component_types"):
        rows.append(("Component types", ", ".join(extra["component_types"])))
    for label, key in (("Animations", "animations"), ("Skins", "skins"),
                       ("Cameras", "cameras")):
        if extra.get(key):
            rows.append((label, f"{extra[key]:,}"))
    if extra.get("extensions_used"):
        rows.append(("Extensions used", ", ".join(extra["extensions_used"])))
    if extra.get("extensions_required"):
        rows.append(("Extensions required", ", ".join(extra["extensions_required"])))


def _render_blend_rows(rows: list[tuple[str, Any]], doc) -> None:
    extra = doc.extra
    rows.append(("Blender version", extra.get("blender_version_text", "unknown")))
    compression = extra.get("compression", "none")
    rows.append(("Compression", compression if compression != "none" else "none"))
    if compression == "zstd":
        return
    rows.append(("Pointer size", f"{extra.get('pointer_size', '?')} bytes"))
    rows.append(("Endianness", extra.get("endianness", "?")))
    rows.append(("File blocks", f"{extra.get('block_count', 0):,}"))
    rows.append(("Datablocks", f"{extra.get('datablocks', 0):,}"))
    rows.append(("DNA", f"{extra.get('struct_count', 0):,} structs, "
                        f"{extra.get('type_count', 0):,} types, "
                        f"{extra.get('name_count', 0):,} field names"))


def _render_metadata(out: _Out, analysis: Analysis) -> None:
    header = analysis.header
    info = analysis.scene_info
    if not header and not info:
        return
    out.heading("Metadata")
    rows: list[tuple[str, Any]] = [
        ("Creator", header.get("creator")),
        ("Created", header.get("creation_time")),
        ("Header extension version", header.get("header_version")),
        ("Encryption type", header.get("encryption")),
        ("File id", header.get("file_id")),
    ]
    application = _join_app(
        info.get("original_application"), info.get("original_version"),
        info.get("original_vendor"),
    )
    if application:
        rows.append(("Originally written by", application))
    if info.get("original_datetime"):
        rows.append(("Originally written", info["original_datetime"]))
    last_saved = _join_app(
        info.get("last_saved_application"), info.get("last_saved_version"),
        info.get("last_saved_vendor"),
    )
    if last_saved:
        rows.append(("Last saved by", last_saved))
    if info.get("last_saved_datetime"):
        rows.append(("Last saved", info["last_saved_datetime"]))
    for key in ("document_url", "original_filename", "title", "subject", "author",
                "keywords", "revision", "comment"):
        if info.get(key):
            rows.append((key.replace("_", " ").capitalize(), info[key]))
    out.pairs(rows)


def _join_app(name: Any, version: Any, vendor: Any) -> str:
    parts = [str(part) for part in (name, version) if part]
    text = " ".join(parts)
    if vendor and str(vendor) not in text:
        text = f"{text} ({vendor})" if text else str(vendor)
    return text


def _render_settings(out: _Out, analysis: Analysis) -> None:
    settings = analysis.global_settings
    if not settings:
        return
    out.heading("Global settings")
    axes = [settings.get(f"{axis}_axis") for axis in ("up", "front", "coord")]
    axis_text = ""
    if any(axes):
        axis_text = "up {}, front {}, right {}".format(*(a or "?" for a in axes))
    unit = ""
    if "unit_scale" in settings:
        unit = f"{settings['unit_scale']:g} cm per unit ({settings.get('units', 'custom')})"
        original = settings.get("original_unit_scale")
        if original is not None and original != settings["unit_scale"]:
            unit += f", originally {original:g}"
    rows: list[tuple[str, Any]] = [
        ("Axis system", axis_text),
        ("Units", unit),
        ("Time mode", settings.get("time_mode")),
        ("Custom frame rate", settings.get("custom_frame_rate")),
    ]
    if "time_span_seconds" in settings:
        rows.append(("Time span", f"{settings['time_span_seconds']:.3f} s"))
    out.pairs(rows)


def _render_structure(out: _Out, analysis: Analysis) -> None:
    out.heading("Record structure")
    out.pairs(
        [
            ("Total records", f"{analysis.total_records:,}"),
            ("Maximum nesting depth", analysis.max_depth),
            ("Top-level sections", len(analysis.sections)),
        ]
    )
    if analysis.sections:
        out.line()
        width = max(len(name) for name, _ in analysis.sections)
        for name, count in analysis.sections:
            noun = "record" if count == 1 else "records"
            out.line(f"  {name:<{width}}  {count:>9,} {noun}")
    if analysis.property_counts:
        out.line()
        out.line("  Properties by type:")
        total = sum(analysis.property_counts.values())
        for type_name, count in analysis.property_counts.most_common():
            out.line(f"    {type_name:<12} {count:>9,}")
        out.line(f"    {'total':<12} {total:>9,}")
        if analysis.array_bytes:
            out.line(f"  Array payloads: {format_size(analysis.array_bytes)} as stored")


def _render_definitions(out: _Out, analysis: Analysis) -> None:
    if not analysis.definitions and analysis.definitions_count is None:
        return
    out.heading("Definitions")
    if analysis.definitions_count is not None:
        out.line(f"  Declared object count: {analysis.definitions_count:,}")
    if not analysis.definitions:
        return
    out.line()
    width = max(len(str(entry["type"])) for entry in analysis.definitions)
    width = max(width, 12)
    out.line(f"  {'object type':<{width}}  {'count':>7}  template")
    for entry in analysis.definitions:
        template = entry.get("template")
        if template:
            template_text = f"{template} ({entry['template_properties']} defaults)"
        else:
            template_text = "-"
        out.line(f"  {str(entry['type']):<{width}}  {entry['count']:>7}  {template_text}")


def _render_object_summary(out: _Out, analysis: Analysis) -> None:
    if not analysis.objects:
        return
    out.heading("Objects")
    expected = analysis.expected_object_count
    line = f"  {analysis.object_count:,} object records"
    if expected is not None and expected != analysis.object_count:
        line += (f" — Definitions implies {expected:,}, "
                 f"so {abs(expected - analysis.object_count):,} "
                 f"{'are missing' if expected > analysis.object_count else 'are extra'}")
    out.line(line)
    out.line()
    width = max(len(kind) for kind in analysis.object_counts)
    for kind, count in analysis.object_counts.most_common():
        out.line(f"  {kind:<{width}}  {count:>7,}")


def _render_hierarchy(out: _Out, analysis: Analysis, *, max_list: int) -> None:
    if not analysis.roots and not analysis.orphans:
        return
    out.heading("Scene hierarchy")
    for root in analysis.roots:
        out.line(f"  {root.label or 'RootNode'}")
        lines: list[str] = []
        _scene_lines(root, "  ", lines, max_list)
        out.lines.extend(lines)
    if analysis.orphans:
        out.line()
        out.line(f"  Unparented models: {len(analysis.orphans)}")
        for obj in analysis.orphans[:max_list]:
            out.line(f"    {_object_label(obj)}")
        if len(analysis.orphans) > max_list:
            out.line(f"    ... {len(analysis.orphans) - max_list} more")


def _scene_lines(node: SceneNode, prefix: str, lines: list[str], limit: int) -> None:
    """Append one line per scene node, stopping once *limit* lines are drawn."""
    total = len(node.children)
    for index, child in enumerate(node.children):
        if len(lines) >= limit:
            lines.append(f"{prefix}{_LAST}... {total - index} more")
            return
        last = index == total - 1
        lines.append(f"{prefix}{_LAST if last else _BRANCH}{_object_label(child.obj)}")
        child_prefix = prefix + (_BLANK if last else _PIPE)
        for position, attachment in enumerate(child.attachments):
            attachment_last = (
                position == len(child.attachments) - 1 and not child.children
            )
            connector = _LAST if attachment_last else _BRANCH
            lines.append(
                f"{child_prefix}{connector}[{attachment.node_type}] "
                f"{attachment.display_name}"
                + (f" ({attachment.detail})" if attachment.detail else "")
            )
        _scene_lines(child, child_prefix, lines, limit)


def _object_label(obj: SceneObject | None) -> str:
    if obj is None:
        return "<root>"
    label = obj.display_name
    if obj.subclass:
        label += f"  [{obj.subclass}]"
    if obj.uid is not None:
        label += f"  uid={obj.uid}"
    if obj.detail:
        label += f"  ({obj.detail})"
    return label


def _render_object_list(out: _Out, analysis: Analysis, *, max_list: int) -> None:
    if not analysis.objects:
        return
    out.heading("Object list")
    for obj in analysis.objects[:max_list]:
        uid = f"{obj.uid}" if obj.uid is not None else "-"
        out.line(f"  {uid:>20}  {obj.kind:<24} {obj.display_name}")
        if obj.detail:
            out.line(f"  {'':>20}  {'':<24} {obj.detail}")
    if len(analysis.objects) > max_list:
        out.line(f"  ... {len(analysis.objects) - max_list} more "
                 f"(raise the limit with --max-list)")


def _render_connections(out: _Out, analysis: Analysis, *, detailed: bool,
                        max_list: int) -> None:
    if not analysis.connections:
        return
    out.heading("Connections")
    names = {"OO": "object -> object", "OP": "object -> property",
             "PO": "property -> object", "PP": "property -> property"}
    out.line(f"  {len(analysis.connections):,} connections")
    for kind, count in analysis.connection_counts.most_common():
        out.line(f"    {kind}  {names.get(kind, 'unknown'):<20} {count:>7,}")
    if not detailed:
        return
    lookup = {obj.uid: obj for obj in analysis.objects if obj.uid is not None}
    lookup.update({f"{obj.class_name}::{obj.name}": obj for obj in analysis.objects})
    out.line()
    for conn in analysis.connections[:max_list]:
        src = lookup.get(conn.src)
        dst = lookup.get(conn.dst)
        src_text = f"{src.kind} {src.display_name}" if src else str(conn.src)
        dst_text = f"{dst.kind} {dst.display_name}" if dst else (
            "RootNode" if conn.dst == 0 else str(conn.dst)
        )
        suffix = f" .{conn.prop}" if conn.prop else ""
        out.line(f"  {conn.kind}  {src_text}  ->  {dst_text}{suffix}")
    if len(analysis.connections) > max_list:
        out.line(f"  ... {len(analysis.connections) - max_list} more")


def _render_animation(out: _Out, analysis: Analysis) -> None:
    info = analysis.animation
    if not info:
        return
    out.heading("Animation")
    rows = [(key, value) for key, value in info.items()
            if key not in ("stacks", "takes") and not isinstance(value, (list, dict))]
    out.pairs(rows)
    for stack in info.get("stacks", []):
        duration = stack.get("duration_seconds")
        text = f"  stack {stack['name']}"
        if duration is not None:
            text += f"  ({duration:.3f} s)"
        out.line(text)
    for take in info.get("takes", []):
        out.line(f"  take  {take}")


def _render_warnings(out: _Out, doc: Document) -> None:
    if not doc.warnings:
        return
    out.heading(f"Warnings ({len(doc.warnings)})")
    for warning in doc.warnings:
        out.line(f"  ! {warning}")


# ---------------------------------------------------------------------------
# record tree


def render_tree(
    root: Node,
    *,
    max_depth: int | None = None,
    show_props: bool = False,
    max_children: int | None = None,
) -> list[str]:
    """Render the record tree as indented lines."""
    lines: list[str] = []
    _tree_lines(root, "", lines, 0, max_depth, show_props, max_children)
    return lines


def _tree_lines(node: Node, prefix: str, lines: list[str], depth: int,
                max_depth: int | None, show_props: bool,
                max_children: int | None) -> None:
    children = node.children
    shown = children if max_children is None else children[:max_children]
    for index, child in enumerate(shown):
        last = index == len(shown) - 1 and len(shown) == len(children)
        connector = _LAST if last else _BRANCH
        lines.append(f"{prefix}{connector}{_node_label(child, show_props)}")
        child_prefix = prefix + (_BLANK if last else _PIPE)
        if max_depth is not None and depth + 1 >= max_depth:
            if child.children:
                hidden = child.count_nodes()
                noun = "record" if hidden == 1 else "records"
                lines.append(
                    f"{child_prefix}{_LAST}... {hidden:,} {noun} not shown"
                )
            continue
        _tree_lines(child, child_prefix, lines, depth + 1, max_depth, show_props,
                    max_children)
    if max_children is not None and len(children) > max_children:
        lines.append(f"{prefix}{_LAST}... {len(children) - max_children} more siblings")


def _node_label(node: Node, show_props: bool) -> str:
    label = node.name or "<unnamed>"
    if node.props:
        if show_props:
            rendered = ", ".join(prop.summary() for prop in node.props)
            label += f": {rendered}"
        else:
            preview = ", ".join(prop.summary(max_len=32) for prop in node.props[:3])
            if len(node.props) > 3:
                preview += f", +{len(node.props) - 3} more"
            label += f": {preview}"
    if node.children:
        label += f"  {{{len(node.children)}}}"
    return label


# ---------------------------------------------------------------------------
# JSON


def to_dict(analysis: Analysis, *, include_tree: bool = False,
            tree_depth: int | None = None) -> dict[str, Any]:
    """A JSON-serialisable view of *analysis*."""
    doc = analysis.doc
    version = analysis.version
    data: dict[str, Any] = {
        "file": {
            "path": doc.path,
            "size_bytes": doc.file_size,
            "format": doc.format,
            "encoding": doc.encoding,
            "version": doc.version,
            "version_dotted": version.dotted if version else None,
            "version_product": version.product if version else None,
            "version_source": doc.version_source,
            "legacy_layout": version.legacy_layout if version else None,
            "wide_offsets": doc.wide_offsets,
            "has_footer": doc.has_footer,
            "footer_version": doc.footer_version,
        },
        "metadata": analysis.header,
        "scene_info": analysis.scene_info,
        "global_settings": analysis.global_settings,
        "structure": {
            "total_records": analysis.total_records,
            "max_depth": analysis.max_depth,
            "sections": [{"name": name, "records": count}
                         for name, count in analysis.sections],
            "property_counts": dict(analysis.property_counts),
            "array_bytes": analysis.array_bytes,
        },
        "definitions": {
            "declared_count": analysis.definitions_count,
            "expected_in_objects": analysis.expected_object_count,
            "object_types": analysis.definitions,
        },
        "objects": {
            "count": analysis.object_count,
            "by_kind": dict(analysis.object_counts),
            "items": [
                {
                    "type": obj.node_type,
                    "uid": obj.uid,
                    "name": obj.name,
                    "class": obj.class_name,
                    "subclass": obj.subclass,
                    "detail": obj.detail,
                }
                for obj in analysis.objects
            ],
        },
        "connections": {
            "count": len(analysis.connections),
            "by_kind": dict(analysis.connection_counts),
            "items": [
                {"kind": conn.kind, "src": conn.src, "dst": conn.dst, "property": conn.prop}
                for conn in analysis.connections
            ],
        },
        "animation": analysis.animation,
        "hierarchy": [_scene_dict(root) for root in analysis.roots],
        "unparented_models": [obj.display_name for obj in analysis.orphans],
        "warnings": doc.warnings,
        "media": analysis.media,
        "format_details": doc.extra,
    }
    if include_tree:
        data["records"] = _node_dict(doc.root, tree_depth, 0)
    return data


def _scene_dict(node: SceneNode) -> dict[str, Any]:
    obj = node.obj
    return {
        "name": obj.display_name if obj else (node.label or "RootNode"),
        "type": obj.node_type if obj else "Root",
        "subclass": obj.subclass if obj else "",
        "uid": obj.uid if obj else None,
        "detail": obj.detail if obj else "",
        "attachments": [
            {"type": item.node_type, "name": item.display_name, "subclass": item.subclass}
            for item in node.attachments
        ],
        "children": [_scene_dict(child) for child in node.children],
    }


def _node_dict(node: Node, max_depth: int | None, depth: int) -> dict[str, Any]:
    data: dict[str, Any] = {
        "name": node.name,
        "properties": [_prop_dict(prop) for prop in node.props],
    }
    if node.offset is not None:
        data["offset"] = node.offset
    if node.line is not None:
        data["line"] = node.line
    if max_depth is not None and depth >= max_depth:
        if node.children:
            data["children_omitted"] = node.count_nodes()
        return data
    if node.children:
        data["children"] = [_node_dict(child, max_depth, depth + 1)
                            for child in node.children]
    return data


def _prop_dict(prop) -> dict[str, Any]:
    data: dict[str, Any] = {"type": prop.type_name, "code": prop.code}
    if prop.array is not None:
        data["array"] = {
            "length": prop.array.length,
            "encoding": prop.array.encoding_name,
            "stored_bytes": prop.array.byte_length,
        }
        if prop.value is not None:
            data["values"] = prop.value
    elif isinstance(prop.value, bytes):
        data["value"] = prop.value.hex()
    else:
        data["value"] = prop.value
    return data
