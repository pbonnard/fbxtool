"""Turn a parsed FBX record tree into scene-level facts.

This is where the container (records and properties) is interpreted as an FBX
*scene*: header metadata, global settings, the object table, the connection
graph, and the node hierarchy those connections describe.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import dataclass, field
from typing import Any

from .model import Document, Node
from .versions import VersionInfo, describe

__all__ = [
    "Analysis",
    "SceneObject",
    "Connection",
    "SceneNode",
    "analyze",
    "split_object_name",
]

#: Binary files separate the object name from its class with these two bytes;
#: ASCII files write ``Class::Name`` instead.
NAME_CLASS_SEPARATOR = "\x00\x01"

_TIME_MODES = {
    0: "DefaultMode", 1: "120 fps", 2: "100 fps", 3: "60 fps", 4: "50 fps",
    5: "48 fps", 6: "30 fps", 7: "30 fps (drop)", 8: "NTSC drop frame",
    9: "NTSC full frame", 10: "PAL (25 fps)", 11: "24 fps (cinema)",
    12: "1000 fps", 13: "cinema (drop)", 14: "custom", 15: "96 fps",
    16: "72 fps", 17: "59.94 fps",
}

_AXIS_NAMES = {0: "X", 1: "Y", 2: "Z"}

#: Unit scale factor (in centimetres) -> unit name.
_UNITS = {
    1.0: "centimetres", 2.54: "inches", 30.48: "feet", 100.0: "metres",
    0.1: "millimetres", 91.44: "yards", 10.0: "decimetres",
}

#: One FBX time unit is 1/46186158000 of a second.
FBX_TIME_UNIT = 46186158000


def split_object_name(raw: Any) -> tuple[str, str]:
    """Split an FBX object name into ``(name, class)``.

    Handles both the binary form (``"pCube1\\x00\\x01Model"``) and the ASCII
    form (``"Model::pCube1"``).
    """
    if not isinstance(raw, str):
        return ("", "")
    if NAME_CLASS_SEPARATOR in raw:
        name, _, class_name = raw.partition(NAME_CLASS_SEPARATOR)
        return (name, class_name)
    if "::" in raw:
        class_name, _, name = raw.partition("::")
        return (name, class_name)
    return (raw, "")


@dataclass
class SceneObject:
    """One entry of the ``Objects`` section."""

    node_type: str
    uid: int | None
    name: str
    class_name: str
    subclass: str
    detail: str = ""
    node: Node | None = field(default=None, repr=False)

    @property
    def display_name(self) -> str:
        return self.name or "<unnamed>"

    @property
    def kind(self) -> str:
        """``Model (Mesh)`` — the record name plus its subclass."""
        return f"{self.node_type} ({self.subclass})" if self.subclass else self.node_type


@dataclass
class Connection:
    """One entry of the ``Connections`` section."""

    kind: str  # "OO" (object-object) or "OP" (object-property)
    src: Any  # child: UID (7.x) or name (6.x)
    dst: Any  # parent
    prop: str | None = None


@dataclass
class SceneNode:
    """A node of the reconstructed scene hierarchy."""

    obj: SceneObject | None
    children: list["SceneNode"] = field(default_factory=list)
    attachments: list[SceneObject] = field(default_factory=list)
    label: str = ""


@dataclass
class Analysis:
    """Everything the reporter needs to describe a file."""

    doc: Document
    version: VersionInfo | None
    header: dict[str, Any] = field(default_factory=dict)
    scene_info: dict[str, Any] = field(default_factory=dict)
    global_settings: dict[str, Any] = field(default_factory=dict)
    definitions: list[dict[str, Any]] = field(default_factory=list)
    definitions_count: int | None = None
    objects: list[SceneObject] = field(default_factory=list)
    object_counts: Counter = field(default_factory=Counter)
    connections: list[Connection] = field(default_factory=list)
    connection_counts: Counter = field(default_factory=Counter)
    sections: list[tuple[str, int]] = field(default_factory=list)
    total_records: int = 0
    max_depth: int = 0
    property_counts: Counter = field(default_factory=Counter)
    array_bytes: int = 0
    media: list[dict[str, str]] = field(default_factory=list)
    animation: dict[str, Any] = field(default_factory=dict)
    roots: list[SceneNode] = field(default_factory=list)
    orphans: list[SceneObject] = field(default_factory=list)

    @property
    def object_count(self) -> int:
        return len(self.objects)


def analyze(doc: Document) -> Analysis:
    """Interpret *doc* as a scene."""
    root = doc.root
    analysis = Analysis(doc=doc, version=describe(doc.version))

    analysis.sections = [(child.name, child.count_nodes() + 1) for child in root.children]
    analysis.total_records = root.count_nodes()
    analysis.max_depth = root.depth()
    _count_properties(root, analysis)

    _read_header(root, analysis)
    _read_global_settings(root, analysis)
    _read_definitions(root, analysis)
    _read_objects(root, analysis)
    _read_connections(root, analysis)
    _read_animation(root, analysis)
    _build_hierarchy(analysis)
    return analysis


# ---------------------------------------------------------------------------
# sections


def _count_properties(root: Node, analysis: Analysis) -> None:
    for _, node in root.walk():
        for prop in node.props:
            analysis.property_counts[prop.type_name] += 1
            if prop.array is not None:
                analysis.array_bytes += prop.array.byte_length


def _read_header(root: Node, analysis: Analysis) -> None:
    header: dict[str, Any] = {}
    ext = root.get("FBXHeaderExtension")
    if ext is not None:
        header["header_version"] = ext.path_value("FBXHeaderExtensionVersion")
        header["fbx_version"] = ext.path_value("FBXVersion")
        header["encryption"] = ext.path_value("EncryptionType")
        header["creator"] = ext.path_value("Creator")
        timestamp = ext.get("CreationTimeStamp")
        if timestamp is not None:
            header["creation_time"] = _format_timestamp(timestamp)
        scene_info = ext.get("SceneInfo")
        if scene_info is not None:
            analysis.scene_info = _read_scene_info(scene_info)

    if not header.get("creator"):
        header["creator"] = root.path_value("Creator")
    creation = root.path_value("CreationTime")
    if creation:
        header.setdefault("creation_time", creation)
    file_id = root.get("FileId")
    if file_id is not None and file_id.props:
        value = file_id.props[0].value
        if isinstance(value, (bytes, bytearray)):
            header["file_id"] = bytes(value).hex()
        elif value is not None:
            header["file_id"] = str(value)
    analysis.header = {key: value for key, value in header.items() if value not in (None, "")}


def _format_timestamp(node: Node) -> str:
    def part(name: str) -> int:
        value = node.path_value(name, default=0)
        return int(value) if isinstance(value, (int, float)) else 0

    year, month, day = part("Year"), part("Month"), part("Day")
    hour, minute, second = part("Hour"), part("Minute"), part("Second"),
    millis = part("Millisecond")
    if not year:
        return ""
    return f"{year:04d}-{month:02d}-{day:02d} {hour:02d}:{minute:02d}:{second:02d}.{millis:03d}"


def _properties(node: Node | None) -> dict[str, Any]:
    """Flatten a ``Properties70``/``Properties60`` block into a dict."""
    if node is None:
        return {}
    block = node.get("Properties70") or node.get("Properties60")
    if block is None:
        return {}
    result: dict[str, Any] = {}
    for entry in block.children:
        if entry.name not in ("P", "Property"):
            continue
        values = [prop.value for prop in entry.props]
        if not values or not isinstance(values[0], str):
            continue
        key = values[0]
        # 7.x: name, type, subtype, flags, value...   6.x: name, type, flags, value...
        payload = values[4:] if entry.name == "P" else values[3:]
        if not payload:
            payload = values[1:]
        result[key] = payload[0] if len(payload) == 1 else payload
    return result


def _read_scene_info(node: Node) -> dict[str, Any]:
    props = _properties(node)
    info: dict[str, Any] = {}
    for key, label in (
        ("DocumentUrl", "document_url"),
        ("SrcDocumentUrl", "source_document_url"),
        ("Original|ApplicationVendor", "original_vendor"),
        ("Original|ApplicationName", "original_application"),
        ("Original|ApplicationVersion", "original_version"),
        ("Original|DateTime_GMT", "original_datetime"),
        ("Original|FileName", "original_filename"),
        ("LastSaved|ApplicationVendor", "last_saved_vendor"),
        ("LastSaved|ApplicationName", "last_saved_application"),
        ("LastSaved|ApplicationVersion", "last_saved_version"),
        ("LastSaved|DateTime_GMT", "last_saved_datetime"),
    ):
        value = props.get(key)
        if value not in (None, ""):
            info[label] = value
    meta = node.get("MetaData")
    if meta is not None:
        for name in ("Title", "Subject", "Author", "Keywords", "Revision", "Comment"):
            value = meta.path_value(name)
            if value:
                info[name.lower()] = value
    return info


def _read_global_settings(root: Node, analysis: Analysis) -> None:
    node = root.get("GlobalSettings")
    if node is None:
        return
    props = _properties(node)
    settings: dict[str, Any] = {}

    for axis in ("Up", "Front", "Coord"):
        index = props.get(f"{axis}Axis")
        sign = props.get(f"{axis}AxisSign")
        if isinstance(index, int):
            letter = _AXIS_NAMES.get(index, str(index))
            prefix = "-" if isinstance(sign, int) and sign < 0 else "+"
            settings[f"{axis.lower()}_axis"] = f"{prefix}{letter}"

    scale = props.get("UnitScaleFactor")
    if isinstance(scale, (int, float)):
        settings["unit_scale"] = float(scale)
        settings["units"] = _UNITS.get(round(float(scale), 5), "custom")
    original_scale = props.get("OriginalUnitScaleFactor")
    if isinstance(original_scale, (int, float)):
        settings["original_unit_scale"] = float(original_scale)

    time_mode = props.get("TimeMode")
    if isinstance(time_mode, int):
        settings["time_mode"] = _TIME_MODES.get(time_mode, f"mode {time_mode}")
    custom_fps = props.get("CustomFrameRate")
    if isinstance(custom_fps, (int, float)) and custom_fps > 0:
        settings["custom_frame_rate"] = float(custom_fps)

    start = props.get("TimeSpanStart")
    stop = props.get("TimeSpanStop")
    if isinstance(start, int) and isinstance(stop, int) and stop >= start:
        settings["time_span_seconds"] = (stop - start) / FBX_TIME_UNIT

    version = node.path_value("Version")
    if version is not None:
        settings["version"] = version
    analysis.global_settings = settings


def _read_definitions(root: Node, analysis: Analysis) -> None:
    node = root.get("Definitions")
    if node is None:
        return
    count = node.path_value("Count")
    if isinstance(count, (int, float)):
        analysis.definitions_count = int(count)
    for entry in node.get_all("ObjectType"):
        template = entry.get("PropertyTemplate")
        analysis.definitions.append(
            {
                "type": entry.value(0, ""),
                "count": entry.path_value("Count", default=0),
                "template": template.value(0, "") if template is not None else None,
                "template_properties": len(_properties(template)) if template else 0,
            }
        )


def _read_objects(root: Node, analysis: Analysis) -> None:
    node = root.get("Objects")
    if node is None:
        return
    for entry in node.children:
        obj = _make_object(entry)
        analysis.objects.append(obj)
        analysis.object_counts[obj.kind] += 1
        if obj.node_type in ("Texture", "Video") and obj.detail:
            analysis.media.append({"type": obj.node_type, "name": obj.display_name,
                                   "path": obj.detail})


def _make_object(entry: Node) -> SceneObject:
    values = [prop.value for prop in entry.props]
    uid = None
    raw_name = ""
    subclass = ""
    if values and isinstance(values[0], int):  # 7.x: uid, name, subclass
        uid = values[0]
        raw_name = values[1] if len(values) > 1 and isinstance(values[1], str) else ""
        subclass = values[2] if len(values) > 2 and isinstance(values[2], str) else ""
    else:  # 6.x: name, subclass
        raw_name = values[0] if values and isinstance(values[0], str) else ""
        subclass = values[1] if len(values) > 1 and isinstance(values[1], str) else ""

    name, class_name = split_object_name(raw_name)
    obj = SceneObject(
        node_type=entry.name,
        uid=uid,
        name=name,
        class_name=class_name or entry.name,
        subclass=subclass,
        node=entry,
    )
    obj.detail = _describe_object(entry, obj)
    return obj


def _describe_object(entry: Node, obj: SceneObject) -> str:
    if entry.name in ("Geometry", "Model") and entry.get("Vertices") is not None:
        return _describe_mesh(entry)
    if entry.name in ("Texture", "Video"):
        for key in ("RelativeFilename", "FileName", "Filename"):
            value = entry.path_value(key)
            if isinstance(value, str) and value:
                return value
        return ""
    if entry.name == "Material":
        shading = entry.path_value("ShadingModel")
        return f"shading: {shading}" if shading else ""
    if entry.name == "Deformer" and obj.subclass == "Cluster":
        count = _array_length(entry.get("Indexes"))
        return f"{count} weighted vertices" if count is not None else ""
    if entry.name == "AnimationCurve":
        count = _array_length(entry.get("KeyTime"))
        return f"{count} keys" if count is not None else ""
    if entry.name == "NodeAttribute":
        type_flags = entry.path_value("TypeFlags")
        return f"flags: {type_flags}" if type_flags else ""
    return ""


def _array_length(node: Node | None) -> int | None:
    """Element count of an array record, in either encoding.

    Binary files store the array directly on the record; ASCII files write the
    count as ``*N`` and put the values in a nested ``a:`` record.
    """
    if node is None:
        return None
    for prop in node.props:
        if prop.array is not None:
            return prop.array.length
        if prop.code == "*" and isinstance(prop.value, int):
            return prop.value
    values = node.get("a")
    if values is not None and values.props and values.props[0].array is not None:
        return values.props[0].array.length
    return None


def _describe_mesh(entry: Node) -> str:
    bits: list[str] = []
    count = _array_length(entry.get("Vertices"))
    if count is not None:
        bits.append(f"{count // 3} vertices")
    count = _array_length(entry.get("PolygonVertexIndex"))
    if count is not None:
        bits.append(f"{count} polygon indices")
    layers = len(entry.get_all("Layer"))
    if layers:
        bits.append(f"{layers} layer{'s' if layers != 1 else ''}")
    uvs = len(entry.get_all("LayerElementUV"))
    if uvs:
        bits.append(f"{uvs} UV set{'s' if uvs != 1 else ''}")
    return ", ".join(bits)


def _read_connections(root: Node, analysis: Analysis) -> None:
    node = root.get("Connections")
    if node is None:
        # 6.x keeps them in a ``Relations``/``Connections`` block of ``Connect`` records.
        node = root.get("Relations")
        if node is None:
            return
    for entry in node.children:
        if entry.name not in ("C", "Connect"):
            continue
        values = [prop.value for prop in entry.props]
        if len(values) < 3:
            continue
        kind = values[0] if isinstance(values[0], str) else "??"
        prop_name = values[3] if len(values) > 3 and isinstance(values[3], str) else None
        analysis.connections.append(
            Connection(kind=kind, src=values[1], dst=values[2], prop=prop_name)
        )
        analysis.connection_counts[kind] += 1


def _read_animation(root: Node, analysis: Analysis) -> None:
    counts = Counter(obj.node_type for obj in analysis.objects)
    info: dict[str, Any] = {}
    for key in ("AnimationStack", "AnimationLayer", "AnimationCurve", "AnimationCurveNode"):
        if counts.get(key):
            info[key] = counts[key]
    stacks = [obj for obj in analysis.objects if obj.node_type == "AnimationStack"]
    if stacks:
        info["stacks"] = []
        for stack in stacks:
            props = _properties(stack.node)
            entry: dict[str, Any] = {"name": stack.display_name}
            start, stop = props.get("LocalStart"), props.get("LocalStop")
            if isinstance(start, int) and isinstance(stop, int) and stop >= start:
                entry["duration_seconds"] = (stop - start) / FBX_TIME_UNIT
            info["stacks"].append(entry)
    takes = root.get("Takes")
    if takes is not None:
        names = [take.value(0) for take in takes.get_all("Take")]
        if names:
            info["takes"] = [name for name in names if isinstance(name, str)]
        current = takes.path_value("Current")
        if current:
            info["current_take"] = current
    analysis.animation = info


# ---------------------------------------------------------------------------
# scene hierarchy


#: Object types that form the transform hierarchy.
_HIERARCHY_TYPES = {"Model", "NodeAttribute", "Null", "LimbNode", "Light", "Camera"}


def _build_hierarchy(analysis: Analysis) -> None:
    """Reconstruct the transform hierarchy from the object-object connections."""
    objects = analysis.objects
    if not objects:
        return

    by_key: dict[Any, SceneObject] = {}
    for obj in objects:
        if obj.uid is not None:
            by_key[obj.uid] = obj
        if obj.name:
            # 6.x connections address objects by their ``Class::Name`` string.
            by_key.setdefault(f"{obj.class_name}::{obj.name}", obj)

    parents: dict[int, list[Any]] = defaultdict(list)
    children: dict[Any, list[SceneObject]] = defaultdict(list)
    for conn in analysis.connections:
        if conn.kind not in ("OO", "OP"):
            continue
        child = by_key.get(conn.src)
        if child is None:
            continue
        parents[id(child)].append(conn.dst)
        children[conn.dst].append(child)

    models = [obj for obj in objects if obj.node_type == "Model"]
    if not models:
        return

    root_keys = [key for key in (0, "Model::Scene", "Model::SceneRoot") if key in children]
    scene_root = SceneNode(obj=None, label="RootNode")

    visited: set[int] = set()

    def attach(parent_node: SceneNode, obj: SceneObject, depth: int) -> None:
        if id(obj) in visited or depth > 128:
            return
        visited.add(id(obj))
        node = SceneNode(obj=obj)
        parent_node.children.append(node)
        for child in children.get(obj.uid if obj.uid is not None else
                                 f"{obj.class_name}::{obj.name}", []):
            if child.node_type == "Model":
                attach(node, child, depth + 1)
            elif child.node_type in _HIERARCHY_TYPES or child.node_type in (
                "Geometry", "Material"
            ):
                node.attachments.append(child)

    for key in root_keys:
        for child in children.get(key, []):
            if child.node_type == "Model":
                attach(scene_root, child, 0)

    if scene_root.children:
        analysis.roots.append(scene_root)

    analysis.orphans = [
        obj for obj in models
        if id(obj) not in visited and not parents.get(id(obj))
    ]
    unreached = [obj for obj in models if id(obj) not in visited and parents.get(id(obj))]
    if unreached and not analysis.roots:
        # No recognisable scene root: show every model that has no model parent.
        model_ids = {id(obj) for obj in models}
        floating = SceneNode(obj=None, label="Models (no scene root record)")
        for obj in models:
            parent_objs = [by_key.get(key) for key in parents.get(id(obj), [])]
            if not any(p is not None and id(p) in model_ids for p in parent_objs):
                attach(floating, obj, 0)
        if floating.children:
            analysis.roots.append(floating)
        analysis.orphans = [obj for obj in models if id(obj) not in visited]
