"""Reader for Autodesk 3ds Max scenes — ``.max``.

There is no specification for this one.  A ``.max`` is a Microsoft compound
file — the same OLE2 container Word and Excel used — holding a handful of
streams, and everything that matters is in ``Scene``, which is a tree of
chunks written by each plugin's own save routine.  What follows was worked out
from the files themselves, and every rule here is one that reproduces a scene
byte for byte rather than one taken on trust.

The container
=============

The compound file gives named streams; six of them are read:

======================  =====================================================
``Scene``               the scene itself, as a chunk tree
``ClassDirectory3``     the class table — what each chunk id in the scene *is*
``DllDirectory``        the plugins those classes came from
``FileAssetMetaData3``  every texture the scene refers to, and where it lived
``FileAssetMetaData2``  the same table, as a 3ds Max before 2013 wrote it
``\\x05SummaryInformation``  title, author, comments and the saved thumbnail
``Config``, ``SaveConfigData``  the version that wrote it
======================  =====================================================

Chunks
======

A chunk is ``uint16 id; uint32 length``, the length counting its own header.
Bit 31 of the length says the chunk holds child chunks rather than data.  A
length of zero means the real length is a ``uint64`` that follows, and there
the flag is bit 63 — which is how a 31 MB scene fits in a 32-bit field.

The scene
=========

``Scene`` is one chunk holding a flat list of entities.  **A top-level chunk's
id is its class**, indexing the class table, and its position in the list is
how other entities refer to it.  So the 164th chunk with id 31 is the 164th
Editable Poly, and a node that names entity 648 means the 649th chunk.

Entities point at each other two ways: ``0x2034`` is a plain array of indices,
``0x2035`` an array of (key, index) pairs where the key says what the reference
is *for* — 0 the transform controller, 1 the object, 3 the material.

A node
======

======  ==================================================================
0x0962  its name
0x0960  the entity index of its parent
0x2035  its transform controller, its object, its material
0x096a  the object offset: position, then ``0x096b`` rotation, ``0x096c`` scale
======  ==================================================================

An Editable Poly
================

Under ``0x08fe``:

======  ==================================================================
0x0100  vertices: ``uint32 count``, then per vertex a flag word and x, y, z
0x011a  faces (below)
0x010a  edges, which the reader counts but does not need
0x0120  how many map channels follow, plus one
0x0128  a channel's coordinates, laid out as the vertices are
0x012b  a channel's faces: ``uint32 degree; uint32 index[degree]`` repeated
======  ==================================================================

A face is variable length, and this is the part that takes the explaining::

    uint32 degree
    uint32 vertex[degree]
    uint16 flags
    if flags & 0x01:  uint32                       (the smoothing groups)
    if flags & 0x08:  uint16                       (the material id)
    if flags & 0x10:  uint32
    if flags & 0x20:  uint32 [2 * (degree - 3)]    (how the n-gon triangulates)

Nothing is aligned: a quad is 34 bytes, so every second face starts on an odd
half-word.  A reader that assumes four-byte alignment gets three faces in and
then reads a vertex index as a degree.

What is not decoded
===================

The modifier stack is not run.  A scene modelled with TurboSmooth stores the
cage, and the cage is what comes out — the viewer's own smoothing is the way
to see it as it was modelled.  A ``.max`` stores no normals either, only the
cage and a smoothing group per face; those groups are what says which edges
are hard, and they come out as a ``LayerElementSmoothing`` for the normals to
be worked out from.  Only Editable Poly geometry is read; primitives
that were never collapsed (a Box, a Line) and Editable Mesh are counted and
named in the report but have no vertices here.
"""

from __future__ import annotations

import gzip
import io
import struct
from typing import Iterator

from zlib import error as zlib_error

from .model import ArrayInfo, Document, Node, ParseError, Property

__all__ = ["MAGIC", "is_compound", "is_max", "parse_max", "version_text"]

MAGIC = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"

_FREE = 0xFFFFFFFF
_END = 0xFFFFFFFE
_CONTAINER = 0x80000000
_WIDE_CONTAINER = 1 << 63

#: Chunks inside an Editable Poly's mesh block.
_MESH = 0x08FE
_VERTS = 0x0100
_EDGES = 0x010A
_FACES = 0x011A
_CHANNELS = 0x0120
_MAP_VERTS = 0x0128
_MAP_FACES = 0x012B

#: The same block holds an Editable Mesh, which is a different shape: three
#: corners to a face, and no flag word in front of a vertex.
_TRI_VERTS = 0x0914
_TRI_FACES = 0x0912
_TRI_MAP_VERTS = 0x2394
_TRI_MAP_FACES = 0x2396

#: Chunks inside a node.
_NAME = 0x0962
_PARENT = 0x0960
_REFS = 0x2034
_TYPED_REFS = 0x2035
_OFFSET_POS = 0x096A
_OFFSET_ROT = 0x096B
_OFFSET_SCALE = 0x096C

#: Chunks inside a controller.
_POINT3 = 0x2503
_SCALE = 0x2505
_FLOAT = 0x2501

_CLASS_NAME = 0x2042
_CLASS_IDS = 0x2060

#: Chunks inside a material and its parameter blocks.
#: The block a material keeps its name in, under each of the three ids it is
#: written with.  0x5431 is where 3ds Max's own materials put it, 0x0FA0 is
#: Corona's, and 0x4000 is what a Blend, a Standard and a VRayCarPaintMtl use —
#: which is why those came out numbered rather than named.
_MTL_BASES = (0x5431, 0x0FA0, 0x4000)
_MTL_NAME = 0x4001          # its name, inside that block
#: One parameter of a ParamBlock2, under either of the two ids the block is
#: written with.  Which one a file uses is the writer's own business and not
#: the parameter's: the payload behind both is the same ``uint16 id; uint16
#: type;`` record, and a 3ds Max 2012 scene whose materials all come out grey
#: is one whose every parameter sits under 0x000E.
_PARAMS = (0x000E, 0x100E)
_ASSET_REF = 0x0003         # a parameter block's reference to a file asset

#: A parameter's type, of the list the SDK publishes.  Only these two are
#: whole numbers; the rest of what a shader keeps is float-valued.
_PARAM_INT = 1
_PARAM_BOOL = 4
_PARAM_TEXMAP = 15          # a slot for a map, which carries no value of its own

#: Superclasses, as 3ds Max numbers them.
_GEOM_CLASS = 0x10
_MTL_CLASS = 0xC00


# ---------------------------------------------------------------- container


class _Compound:
    """The OLE2 compound file a .max is packed in."""

    def __init__(self, data: bytes):
        if data[:8] != MAGIC:
            raise ParseError("not a compound file")
        if len(data) < 512:
            raise ParseError("compound file is truncated")
        self.data = data
        shift, mini_shift = struct.unpack_from("<HH", data, 0x1E)
        if not 7 <= shift <= 20 or not 2 <= mini_shift <= shift:
            raise ParseError(f"impossible sector size (1 << {shift})")
        self.sector = 1 << shift
        self.mini = 1 << mini_shift
        (self.fat_count, self.dir_start, _, self.cutoff, self.mini_start,
         self.mini_count, self.difat_start, self.difat_count) = struct.unpack_from(
            "<8I", data, 0x2C)
        self.fat = self._fat()
        self.entries = self._directory()
        root = self.entries[0] if self.entries else None
        self.mini_stream = self._chain(root[2], root[3], mini=False) if root else b""
        self.mini_fat = self._mini_fat()

    def _sector(self, number: int) -> bytes:
        """One sector, padded if it is the last and the file stops short.

        Files in the wild do end mid-sector — a writer that counted its
        payload and not its padding — and refusing to read the whole file over
        the tail of one is worse than reading the tail as the zeros it would
        have been.
        """
        at = (number + 1) * self.sector
        if at >= len(self.data):
            raise ParseError("a sector runs past the end of the file")
        block = self.data[at:at + self.sector]
        if len(block) < self.sector:
            block += b"\x00" * (self.sector - len(block))
        return block

    def _fat(self) -> list[int]:
        sectors = list(struct.unpack_from("<109I", self.data, 0x4C))
        nxt, left = self.difat_start, self.difat_count
        # A DIFAT chain cannot visit a sector twice — it is a linear list, not
        # a graph — so a chain that loops back on itself is a broken container
        # rather than a bigger one.  Without the check, a hostile header that
        # points the chain at itself runs `difat_count` iterations, which the
        # file itself is free to claim is any number up to 2^32-1.
        visited: set[int] = set()
        while nxt not in (_END, _FREE) and left:
            if nxt in visited:
                raise ParseError("the DIFAT chain loops back on itself")
            visited.add(nxt)
            block = self._sector(nxt)
            values = struct.unpack_from("<%dI" % (self.sector // 4), block)
            sectors.extend(values[:-1])
            nxt = values[-1]
            left -= 1
        fat: list[int] = []
        for number in sectors[:self.fat_count]:
            if number in (_END, _FREE):
                continue
            fat.extend(struct.unpack_from("<%dI" % (self.sector // 4), self._sector(number)))
        return fat

    def _mini_fat(self) -> list[int]:
        out: list[int] = []
        sector, left = self.mini_start, self.mini_count
        # The same linear-chain rule as the DIFAT walk above: a chain that
        # loops is a broken container, and without the check a hostile header
        # can make `mini_count` (up to 2^32-1) self-referencing iterations.
        visited: set[int] = set()
        while sector not in (_END, _FREE) and left:
            if sector in visited:
                raise ParseError("the mini-FAT chain loops back on itself")
            visited.add(sector)
            out.extend(struct.unpack_from("<%dI" % (self.sector // 4), self._sector(sector)))
            sector = self.fat[sector] if sector < len(self.fat) else _END
            left -= 1
        return out

    def _chain(self, start: int, size: int, mini: bool) -> bytes:
        """Follow a sector chain, gathering at most *size* bytes."""
        out = bytearray()
        sector = start
        table = self.mini_fat if mini else self.fat
        seen = 0
        while sector not in (_END, _FREE) and len(out) < size:
            if mini:
                at = sector * self.mini
                out += self.mini_stream[at:at + self.mini]
            else:
                out += self._sector(sector)
            sector = table[sector] if sector < len(table) else _END
            seen += 1
            if seen > len(table) + 2:
                raise ParseError("a stream loops back on itself")
        return bytes(out[:size])

    def _directory(self) -> list[tuple[str, int, int, int]]:
        """(name, kind, start sector, size) for every entry."""
        raw = bytearray()
        sector = self.dir_start
        while sector not in (_END, _FREE):
            raw += self._sector(sector)
            sector = self.fat[sector] if sector < len(self.fat) else _END
            if len(raw) > 1 << 22:
                break
        out = []
        for index in range(len(raw) // 128):
            block = raw[index * 128:(index + 1) * 128]
            length = struct.unpack_from("<H", block, 64)[0]
            kind = block[66]
            if kind == 0:
                continue
            name = bytes(block[:max(0, min(length - 2, 64))]).decode("utf-16-le", "replace")
            start, size = struct.unpack_from("<IQ", block, 116)
            out.append((name, kind, start, size))
        return out

    def stream(self, name: str) -> bytes:
        """The named stream, inflated when it is compressed.

        3ds Max 2022 and later can gzip what it writes, stream by stream, and
        it is the same scene underneath — so the compression is undone here
        rather than everywhere that reads one.
        """
        for index, (found, kind, start, size) in enumerate(self.entries):
            if found == name and kind == 2:
                data = self._chain(start, size, mini=size < self.cutoff)
                if data[:2] == b"\x1f\x8b":
                    # A stream that inflates to more than the whole file it
                    # came from, or to more than a couple of gigabytes, is not
                    # a scene: it is a bomb, and an unbounded read would build
                    # it all before anyone noticed.
                    cap = min(1 << 33, max(len(self.data) * 64, 1 << 20))
                    try:
                        with gzip.GzipFile(fileobj=io.BytesIO(data)) as handle:
                            inflated = handle.read(cap + 1)
                    except (OSError, EOFError, zlib_error) as error:
                        raise ParseError(f"{name} is compressed and will not "
                                         f"inflate: {error}") from None
                    if len(inflated) > cap:
                        raise ParseError(
                            f"{name} is compressed and will not inflate: it "
                            "expands further than the file it came from")
                    return inflated
                return data
        return b""

    @property
    def names(self) -> list[str]:
        return [name for name, kind, _, _ in self.entries if kind == 2]


# ------------------------------------------------------------------- chunks


def _chunks(data: bytes, start: int, end: int) -> Iterator[tuple[int, int, int, bool]]:
    """Yield (id, body start, body end, has children) over a range."""
    at = start
    while at + 6 <= end:
        idn, length = struct.unpack_from("<HI", data, at)
        container = bool(length & _CONTAINER)
        length &= ~_CONTAINER
        head = 6
        if length == 0:
            if at + 14 > end:
                return
            wide = struct.unpack_from("<Q", data, at + 6)[0]
            container = bool(wide & _WIDE_CONTAINER)
            length = wide & ~_WIDE_CONTAINER
            head = 14
        if length < head or at + length > end:
            return
        yield idn, at + head, at + length, container
        at += length


def _text(data: bytes) -> str:
    """A chunk's payload as the UTF-16 string it usually is."""
    try:
        return data.decode("utf-16-le").rstrip("\x00")
    except UnicodeDecodeError:
        return ""


def _find(data: bytes, start: int, end: int, wanted: int) -> tuple[int, int] | None:
    for idn, body, tail, _ in _chunks(data, start, end):
        if idn == wanted:
            return body, tail
    return None


# ------------------------------------------------------------------ streams


def _read_classes(data: bytes) -> list[dict]:
    """The class table: what every entity in the scene is."""
    out = []
    for _, body, tail, container in _chunks(data, 0, len(data)):
        if not container:
            continue
        entry = {"name": "", "class_id": 0, "super_id": 0, "dll": -1}
        for idn, cb, ct, _ in _chunks(data, body, tail):
            if idn == _CLASS_NAME:
                entry["name"] = _text(data[cb:ct])
            elif idn == _CLASS_IDS and ct - cb >= 16:
                dll, low, high, super_id = struct.unpack_from("<iIII", data, cb)
                entry.update(dll=dll, class_id=low, class_id2=high, super_id=super_id)
        out.append(entry)
    return out


def _read_dlls(data: bytes) -> list[dict]:
    """The plugins the classes came out of, in the order classes name them."""
    out: list[dict] = []
    for _, body, tail, container in _chunks(data, 0, len(data)):
        if not container:
            continue
        entry = {"description": "", "file": ""}
        for idn, cb, ct, _ in _chunks(data, body, tail):
            if idn == 0x2039:
                entry["description"] = _text(data[cb:ct])
            elif idn == 0x2037:
                entry["file"] = _text(data[cb:ct])
        if entry["description"] or entry["file"]:
            out.append(entry)
    return out


def _read_assets(data: bytes) -> list[dict]:
    """Every file the scene refers to: its kind, its name and where it lived.

    The stream is a run of records, each a 16-byte identifier followed by
    length-prefixed strings.  The lengths count characters, and the strings are
    UTF-16 with a terminator, which is what makes the walk self-correcting: a
    record whose length does not land on a terminator is not a record.

    How many strings a record holds is the table's own version: the newer one
    writes the kind, the file's name and the path it lived at, the older one
    the kind and the path alone.  Both are read, since a scene saved by 3ds Max
    2012 keeps the older table and otherwise comes out with no textures at all.
    """
    out: list[dict] = []
    at = 16
    start = 0
    while at + 4 <= len(data):
        strings = []
        while len(strings) < 3 and at + 4 <= len(data):
            count = struct.unpack_from("<I", data, at)[0]
            if count == 0 or count > 4096 or at + 6 + count * 2 > len(data):
                break
            text = data[at + 4:at + 4 + count * 2].decode("utf-16-le", "replace")
            at += 4 + count * 2 + 2       # the string, then its terminator
            strings.append(text)
        if len(strings) >= 2:
            path = strings[-1]
            # Where the record does not name the file apart from its path, the
            # name is the last step of that path.
            name = (strings[1] if len(strings) >= 3
                    else path.replace("\\", "/").rsplit("/", 1)[-1])
            # The identifier is the sixteen bytes in front of the record, and
            # it is how a material's parameter block names this file.
            out.append({"kind": strings[0], "name": name, "path": path,
                        "id": bytes(data[start:start + 16])})
            start = at
            at += 16          # the identifier of the record that follows
        else:
            break
    return out


def _read_summary(data: bytes) -> dict:
    """Title, author and comments out of the OLE property set."""
    out: dict = {}
    if len(data) < 48:
        return out
    try:
        count = struct.unpack_from("<I", data, 24)[0]
        if count < 1:
            return out
        section = struct.unpack_from("<I", data, 44)[0]
        if section + 8 > len(data):
            return out
        properties = struct.unpack_from("<I", data, section + 4)[0]
        names = {2: "title", 3: "subject", 4: "author", 6: "comments",
                 8: "last_saved_by", 18: "application"}
        for index in range(min(properties, 64)):
            at = section + 8 + index * 8
            if at + 8 > len(data):
                break
            ident, offset = struct.unpack_from("<II", data, at)
            if ident not in names or section + offset + 8 > len(data):
                continue
            kind, length = struct.unpack_from("<II", data, section + offset)
            start = section + offset + 8
            if kind == 30 and start + length <= len(data):        # VT_LPSTR
                out[names[ident]] = data[start:start + length].split(b"\0")[0] \
                    .decode("latin-1", "replace")
            elif kind == 31 and start + length * 2 <= len(data):  # VT_LPWSTR
                out[names[ident]] = data[start:start + length * 2] \
                    .decode("utf-16-le", "replace").split("\x00")[0]
    except struct.error:
        return out
    return out


def version_text(stamp: int | None) -> str:
    """What a saved version number says, as 3ds Max counts them.

    The high half is the release times a thousand — 20000 for the 20.0 that
    was sold as 3ds Max 2018 — and the low half is the build.  The product
    year is the release plus 1998, which has held since 3ds Max 9.
    """
    if not stamp:
        return "unknown"
    release, build = stamp >> 16, stamp & 0xFFFF
    if not 1000 <= release <= 60000:
        return f"{stamp}"
    major, minor = divmod(release, 1000)
    return f"{major}.{minor} (3ds Max {1998 + major}), build {build}"


def _read_version(config: bytes, save_config: bytes) -> int | None:
    """The build that wrote the file, where it says so."""
    for data in (save_config, config):
        for idn, body, tail, _ in _chunks(data, 0, len(data)):
            if idn == 0x2170 and tail - body >= 4:
                return struct.unpack_from("<I", data, body)[0]
    return None


# --------------------------------------------------------------------- mesh


class _Mesh:
    """One Editable Poly, as read."""

    __slots__ = ("positions", "polygons", "uvs", "face_uvs", "faces", "edges",
                 "materials", "groups")

    def __init__(self) -> None:
        self.positions: list[float] = []
        self.polygons: list[int] = []
        self.uvs: list[float] = []
        self.face_uvs: list[int] = []
        self.faces = 0
        self.edges = 0
        self.materials: list[int] = []
        #: Smoothing groups, one bitmask per face; 0 where the file gives none.
        self.groups: list[int] = []


def _read_points(data: bytes, start: int, end: int, stride: int) -> list[float]:
    """``uint32 count``, then that many points.

    A vertex is sixteen bytes — a flag word, then x, y and z — while a map
    coordinate is the three floats alone.  The stride is the whole difference
    between the two, and reading one as the other gets a count it cannot have.
    """
    if end - start < 4:
        return []
    count = struct.unpack_from("<I", data, start)[0]
    if count > (end - start - 4) // stride:
        raise ParseError(f"a point array claims {count} points it has not got")
    lead = stride - 12
    out: list[float] = []
    at = start + 4 + lead
    for _ in range(count):
        out.extend(struct.unpack_from("<3f", data, at))
        at += stride
    return out


def _read_faces(data: bytes, start: int, end: int, vertices: int
                ) -> tuple[list[list[int]], list[int]]:
    """The face list, and the material each face wears.

    Every face is a run of vertex indices and then whatever its flag word says
    it carries.  The flags are read for their length as much as their meaning:
    get one wrong and the next face is read out of the middle of this one.
    """
    if end - start < 4:
        return [], [], []
    count = struct.unpack_from("<I", data, start)[0]
    faces: list[list[int]] = []
    materials: list[int] = []
    groups: list[int] = []
    at = start + 4
    for _ in range(count):
        if at + 4 > end:
            break
        degree = struct.unpack_from("<I", data, at)[0]
        at += 4
        if not 3 <= degree <= 4096 or at + 4 * degree + 2 > end:
            raise ParseError(f"a face of {degree} corners at byte {at}")
        corners = list(struct.unpack_from("<%dI" % degree, data, at))
        at += 4 * degree
        if max(corners) >= vertices:
            raise ParseError("a face names a vertex the mesh has not got")
        flags = struct.unpack_from("<H", data, at)[0]
        at += 2
        material = 0
        smoothing = 0
        if flags & 0x01:
            if at + 4 > end:
                break
            # The whole word is the smoothing groups, all thirty-two of them.
            # The groups say which faces share a smooth normal and, by their
            # absence, where an edge is hard — without them a mesh with no
            # normals of its own can only be shaded flat, and every crease on a
            # car body rounds away.
            smoothing = struct.unpack_from("<I", data, at)[0]
            at += 4
        if flags & 0x08:
            if at + 2 > end:
                break
            # The material id, in a field of its own, and absent where it is
            # zero.  It is the slot a Multi/Sub-Object hands the face.
            #
            # Which field holds which was read off a car whose answer is
            # known: over its body, the 0x01 word takes sixteen values that are
            # sparse bit patterns up to bit 24, while the 0x08 field takes
            # exactly 1 to 15 — the slots of the sixteen-material list that
            # body wears.  Its wheels, on a four-material list, use 1 to 3, and
            # its tyres, which wear a single material, carry no 0x08 field at
            # all.  Read the other way round the body wore seven materials, two
            # of them past the end of its own list.
            material = struct.unpack_from("<H", data, at)[0]
            at += 2
        if flags & 0x10:
            at += 4
        if flags & 0x20:
            at += 8 * (degree - 3)
        faces.append(corners)
        materials.append(material)
        groups.append(smoothing)
    return faces, materials, groups


def _read_map_faces(data: bytes, start: int, end: int) -> list[list[int]]:
    """``uint32 degree; uint32 index[degree]`` until the chunk runs out."""
    out: list[list[int]] = []
    at = start
    while at + 4 <= end:
        degree = struct.unpack_from("<I", data, at)[0]
        at += 4
        if not 3 <= degree <= 4096 or at + 4 * degree > end:
            break
        out.append(list(struct.unpack_from("<%dI" % degree, data, at)))
        at += 4 * degree
    return out


def _read_triangles(data: bytes, start: int, end: int, vertices: int) -> list[list[int]]:
    """An Editable Mesh face: three corners and two words about them."""
    if end - start < 4:
        return []
    count = struct.unpack_from("<I", data, start)[0]
    if count > (end - start - 4) // 20:
        raise ParseError(f"a face array claims {count} faces it has not got")
    out = []
    at = start + 4
    for _ in range(count):
        corners = list(struct.unpack_from("<3I", data, at))
        if max(corners) >= vertices:
            raise ParseError("a face names a vertex the mesh has not got")
        out.append(corners)
        at += 20
    return out


def _read_index_triples(data: bytes, start: int, end: int) -> list[int]:
    """A map channel's faces, three indices each and no more."""
    if end - start < 4:
        return []
    count = struct.unpack_from("<I", data, start)[0]
    if count > (end - start - 4) // 12:
        return []
    return list(struct.unpack_from("<%dI" % (count * 3), data, start + 4))


def _read_mesh(data: bytes, start: int, end: int) -> _Mesh | None:
    """The geometry of one object, as a polygon list.

    Two classes are read, and they share nothing but the block they sit in:
    an Editable Poly keeps n-gons and a flag word per vertex, an Editable Mesh
    keeps triangles and three bare floats.
    """
    mesh = _Mesh()
    channels: list[tuple[list[float], list[list[int]]]] = []
    pending_points: list[float] = []
    order = list(_chunks(data, start, end))
    # Vertices first whatever the order in the file: a face is checked against
    # them, and an Editable Mesh writes its faces first.
    order.sort(key=lambda c: c[0] not in (_VERTS, _TRI_VERTS))
    for idn, body, tail, container in order:
        if idn == _VERTS and not mesh.positions:
            mesh.positions = _read_points(data, body, tail, 16)
        elif idn == _EDGES and tail - body >= 4:
            mesh.edges = struct.unpack_from("<I", data, body)[0]
        elif idn == _FACES:
            faces, materials, groups = _read_faces(
                data, body, tail, len(mesh.positions) // 3)
            mesh.faces = len(faces)
            mesh.materials = materials
            mesh.groups = groups
            for corners in faces:
                for at, corner in enumerate(corners):
                    mesh.polygons.append(corner if at < len(corners) - 1 else ~corner)
        elif idn == _MAP_VERTS:
            pending_points = _read_points(data, body, tail, 12)
        elif idn == _MAP_FACES:
            channels.append((pending_points, _read_map_faces(data, body, tail)))
            pending_points = []
        elif idn == _TRI_VERTS and not mesh.positions:
            mesh.positions = _read_points(data, body, tail, 12)
        elif idn == _TRI_FACES:
            triangles = _read_triangles(data, body, tail, len(mesh.positions) // 3)
            mesh.faces = len(triangles)
            mesh.materials = [0] * len(triangles)
            # An Editable Mesh keeps its smoothing groups elsewhere; none read.
            mesh.groups = [0] * len(triangles)
            for corners in triangles:
                mesh.polygons.extend((corners[0], corners[1], ~corners[2]))
        elif idn == _TRI_MAP_VERTS:
            pending_points = _read_points(data, body, tail, 12)
        elif idn == _TRI_MAP_FACES:
            triples = _read_index_triples(data, body, tail)
            channels.append((pending_points, [triples[i:i + 3]
                                              for i in range(0, len(triples), 3)]))
            pending_points = []
    if not mesh.positions or not mesh.polygons:
        return None

    # The first map channel is the texture coordinates; the rest are data the
    # scene carries per corner and nothing here can draw.
    for points, faces in channels:
        if not points or not faces:
            continue
        mesh.uvs = points
        for corners in faces:
            mesh.face_uvs.extend(corners)
        break
    if len(mesh.face_uvs) != len(mesh.polygons):
        mesh.uvs, mesh.face_uvs = [], []
    return mesh


# -------------------------------------------------------------------- scene


class _Material:
    """One material as the viewer needs it: a name, a surface and its pictures.

    Two pictures, where the file has them: the one the surface is coloured by
    and the one it is bumped by.  They are different slots and a reader that
    kept only the first of them either painted a car with its own relief or
    threw its relief away.
    """

    __slots__ = ("name", "look", "texture", "bump", "subs", "is_list", "shading",
                 "coat", "coat_amount")

    def __init__(self, name: str, look, texture, subs, bump=None, is_list=False,
                 shading="unknown"):
        self.name = name
        self.look = look
        self.texture = texture
        self.bump = bump
        #: The materials this one names.  For a Multi/Sub-Object they are its
        #: slots, and a face picks between them; for anything else — a Blend, a
        #: VRayBlendMtl — they are what this surface is made of, and it is a
        #: surface in its own right.
        self.subs = subs
        self.is_list = is_list
        #: Which shading model the surface was read by.  One of 3ds Max's own
        #: shaders is a Phong and its specular is a highlight; a renderer's own
        #: material has no model anybody here knows, and its specular is a
        #: reflectance that was measured.  3ds Max says the same of its own
        #: export, writing ``unknown`` for every V-Ray and Corona material.
        self.shading = shading
        #: The clear coat laid over this surface, where it has one: the
        #: reflection colour, the index that shapes it and how polished it is.
        #: A blend of a paint under a coat is two surfaces and not one.
        self.coat = None
        #: How much of that coat shows, where the blend says.
        self.coat_amount = 1.0


def _material_name(scene: bytes, entity) -> str:
    """What the scene calls a material.

    3ds Max's own materials keep the name in the block every ``MtlBase``
    carries; a plugin's material writes the same block under an id of its own
    — Corona's is 0x0FA0, and a Blend, a Standard and a VRayCarPaintMtl use
    0x4000 — with the same name chunk inside it.  All three are read, since a
    scene otherwise comes out as a mixture of named materials and numbered
    ones, and the numbered ones are the paints: an Audi's body is a Blend, and
    'vray AUDI body grey' is in the file all along.
    """
    for wanted in _MTL_BASES:
        block = _find(scene, entity.start, entity.end, wanted)
        if block is None:
            continue
        found = _find(scene, block[0], block[1], _MTL_NAME)
        if found:
            return _text(scene[found[0]:found[1]])
    return ""


def _params_of(scene: bytes, entity):
    """Every parameter of a parameter block, under the id the file gives it.

    A parameter is ``uint16 id; uint16 type;`` then flags and its value, and
    the value is the last four bytes or, for a colour, the last twelve.  What
    an id *means* is the plugin's business — but the class table says which
    plugin, and for the shaders 3ds Max itself ships the layout is published.

    How much flag sits between the two varies, so a scalar can be as little as
    nineteen bytes.  That is exactly what a Corona material writes, and every
    number describing its surface — its glossiness above all — was below the
    cutoff and thrown away.  A slot for a map is smaller still and carries no
    value at all, which its type is what says.
    """
    out: list[tuple[int, str, object]] = []
    for idn, body, tail, _ in _chunks(scene, entity.start, entity.end):
        size = tail - body
        if idn not in _PARAMS or size < 19:
            continue
        param, kind = struct.unpack_from("<HH", scene, body)
        if kind == _PARAM_TEXMAP:
            continue
        if size >= 27:
            rgb = struct.unpack_from("<3f", scene, tail - 12)
            if all(0.0 <= v <= 1.0 for v in rgb):
                out.append((param, "colour", rgb))
        elif kind not in (_PARAM_INT, _PARAM_BOOL):
            # A count or a checkbox read as a float is not a small number, it
            # is a denormal or a NaN, so the types that are not float-valued
            # are left where they are.  Glossiness is one of several that are
            # — the shaders declare it a percentage rather than a plain float.
            out.append((param, "value", struct.unpack_from("<f", scene, tail - 4)[0]))
    return out


#: Where each shader 3ds Max ships keeps the numbers that describe a surface.
#:
#: They agree on the front of the block — 0 ambient, 1 diffuse, 2 specular, 3
#: the self-illumination colour — and part ways over the floats behind it, so
#: the class the file names is what picks the reading.  Oren-Nayar-Blinn is
#: Blinn with a diffuse level and a roughness added on the end, which is why
#: the Blinn family reads at the same two places; Strauss is a shader of one
#: colour and keeps nothing where the others do.
#:
#: A plugin's own material that is not in this table is not read as though it
#: were: it keeps the older rule, that the first colour in the block is the
#: diffuse, and its finish is left alone.
#:
#: Some plugins put a level beside each colour rather than folding it in, so a
#: channel can name one of its own: ``diffuse_level`` and the rest multiply the
#: colour they belong to, and a channel whose level is zero is off however
#: bright its colour.
_SHADERS = {
    "blinn": {"diffuse": 1, "specular": 2, "glossiness": 5, "level": 6},
    "phong": {"diffuse": 1, "specular": 2, "glossiness": 5, "level": 6},
    "metal": {"diffuse": 1, "glossiness": 5, "level": 6},
    "oren-nayar-blinn": {"diffuse": 1, "specular": 2, "glossiness": 5, "level": 6},
    "anisotropic": {"diffuse": 1, "specular": 2, "glossiness": 7, "level": 5},
    "strauss": {"diffuse": 0, "glossiness": 1},
    # A renderer's own material is not one of the shaders 3ds Max ships, so
    # none of the layouts above fits it and the surface used to come out as
    # whatever colour the walk met first — for a V-Ray glass, the black diffuse
    # that glass properly has, with nothing to say it was see-through.  What
    # refraction it lets through is the one thing worth having beyond the
    # colours, since nothing else in a .max carries an opacity at all.
    #
    # The ids are read off the files rather than out of any documentation:
    # fifty-five VRayMtl blocks across three car scenes all carry the same
    # eight colours under the same ids, and the three that refract in one car
    # share a fog colour of (0.90, 0.96, 0.95) — the green a windscreen is.
    # Worth checking against a scene whose answer is known independently.
    # Parameter 3 is the reflection glossiness, which is how polished the
    # surface is and the difference between chrome and a matte panel.  Read off
    # the same car twice: 3ds Max's own FBX export of this scene states a
    # glossiness for each of its seventy materials, and for every one of them
    # parameter 3 of the .max holds that number — 0.3 for the paint, 0.65 for
    # the rough plastic, 0.82 for a brake caliper, 1.0 for the chrome and the
    # glass.  Without it every V-Ray surface came out at the same middling
    # roughness, so a windscreen was as satin as a bumper.
    # Parameter 63 is the index of refraction the reflection is shaped by,
    # which is what tells a mirror from a windscreen.  Matched against the
    # export of the same car: 999 for its chrome and the clear coat over its
    # paint, 8 for the paint under it, 1.52 for its glass and its plastic.
    "vraymtl": {"diffuse": 1, "specular": 2, "refraction": 5, "glossiness": 3,
                "ior": 63},
    # Corona keeps its surface in one block, every channel a colour with a
    # level beside it, and its glossiness at 180 where nothing else is near.
    #
    # These ids were checked against the answer rather than guessed at: five of
    # these cars ship a Corona scene and a V-Ray scene of the same model, with
    # the same material names in both.  Read this way, 174 of the 176 materials
    # that appear in both come out with the same diffuse, the same specular,
    # the same glossiness and the same opacity as the V-Ray twin the tool
    # already read — and the two that differ are a windscreen and a body the
    # artist tuned differently for each renderer, which the rest of their own
    # numbers agree about.
    #
    # Corona keeps two indices side by side and only one of them shapes the
    # reflection.  182 is the Fresnel index — what tells a mirror from a
    # bumper — and 183 is the index light bends by on the way *through*, which
    # is 1.52 on everything that is not glass because that is what it defaults
    # to.  Read at 183 every Corona surface in every scene came back at the
    # reflectance of window glass, and the Grecale's chrome, its polished steel
    # and its wing mirrors all drew as dark plastic.
    #
    # The file settles it rather than the documentation: 3ds Max exports these
    # under their own names, and for all four of that car's bright metals
    # `CoronaMtlPb|fresnelIor` is the number at 182 — 999 for the mirror, 50
    # for the steel, 8 and 6 for the two irons — while `CoronaMtlPb|ior` is the
    # 1.52 sitting at 183.  The parameters run in the order the export lists
    # them, which is the same check that fixes 180 as the reflection
    # glossiness: 2**(10 x 180) is the ShininessExponent of every one of them.
    "coronamtl": {
        "diffuse": 101, "diffuse_level": 121,
        "specular": 102, "specular_level": 122,
        "refraction": 103, "refraction_level": 123,
        "glossiness": 180, "ior": 182,
    },
}
#: Corona renamed its material when the newer one arrived; the block did not
#: change, and a scene saved by either reads the same.
_SHADERS["coronalegacymtl"] = _SHADERS["coronamtl"]

#: The shaders 3ds Max itself ships.  Their specular is a highlight to be
#: capped; a renderer's own is a reflectance to be taken at face value.
_MAX_SHADERS = {"blinn", "phong", "metal", "oren-nayar-blinn", "anisotropic",
                "strauss"}


def _appearance_of(params, layout, diffuse=None, specular=None):
    """What a block of parameters says the surface is, by a shader's layout.

    Each value comes from the id that holds it, and nothing is returned for a
    block that has no diffuse where the layout says one is — that block
    belongs to something else the material keeps, not to its surface.

    ``diffuse`` and ``specular`` stand in for the colours the block itself
    holds, for a material whose slot is filled by a colour rather than a
    picture: the one beside it is then a placeholder.  They go in *before* the
    level is applied, since a channel switched off is switched off whichever
    colour it was given.
    """
    stood_in = {"diffuse": diffuse, "specular": specular}

    def at(which: str, kind: str):
        if kind == "colour" and stood_in.get(which) is not None:
            return stood_in[which]
        if which not in layout:
            return None
        for param, got, value in params:
            if param == layout[which] and got == kind:
                return value
        return None

    def scaled(which: str):
        """A colour, dimmed by the level its shader keeps beside it."""
        colour = at(which, "colour")
        if colour is None:
            return None
        level = at(f"{which}_level", "value")
        if level is None or level == 1.0:
            return colour
        level = min(1.0, max(0.0, level))
        return tuple(c * level for c in colour)

    colour = scaled("diffuse")
    if colour is None:
        return None
    # What a material refracts is what it lets through, so it is the opposite
    # of its opacity.  Taken from the brightest channel: a tinted refraction is
    # still a measure of how much gets past.
    refraction = scaled("refraction")
    opacity = None
    if refraction is not None:
        opacity = 1.0 - min(1.0, max(0.0, max(refraction)))
    return {
        "colour": colour,
        "specular": scaled("specular"),
        "glossiness": at("glossiness", "value"),
        "level": at("level", "value"),
        "ior": at("ior", "value"),
        "opacity": opacity,
    }


def _asset_of(scene: bytes, entity, assets: dict):
    """The file a parameter block points at, by the identifier they share."""
    for idn, body, tail, _ in _chunks(scene, entity.start, entity.end):
        if idn != _ASSET_REF or tail - body < 16:
            continue
        block = scene[body:tail]
        for at in range(0, len(block) - 15):
            found = assets.get(block[at:at + 16])
            if found:
                return found
    return None


#: A CoronaColor is a map that is nothing but a colour, and parameter 52 is
#: that colour.  Read off a BMW: its tyres come to (0.02, 0.02, 0.02), the
#: black of rubber, and its ``red`` to (0.114, 0, 0).
_CORONA_COLOUR_MAP = "coronacolor"
_CORONA_COLOUR = 52

#: A Falloff is not a colour but a ramp between two of them by viewing angle,
#: and the end that matters is the near one — parameter 0 — because that is
#: what facing the camera means, and every number this reader hands the
#: renderer is a facing one.  It is a fallback and not a rule: a Falloff with a
#: map in its near slot shows that map, so what lies beneath is asked first.
_FALLOFF_MAP = "falloff"
_FALLOFF_NEAR = 0


def _colour_under(scene: bytes, entities: list, index, depth: int = 0,
                  seen: set | None = None):
    """A colour standing where a picture would, at or below one slot.

    A map slot does not have to hold a picture.  Corona fills one with a
    CoronaColor — a map that is a flat colour — and where a slot is filled at
    all the material's own colour beside it is a placeholder that means
    nothing: white for a tyre, mid grey for a red light.  Left unread, that
    placeholder is what gets painted.
    """
    if seen is None:
        seen = set()
    if index is None or index >= len(entities) or index in seen or depth > 4:
        return None
    seen.add(index)
    entity = entities[index]
    if depth and (entity.cls.get("super_id") or 0) == _MTL_CLASS:
        return None
    if (entity.cls.get("name") or "").strip().lower() == _CORONA_COLOUR_MAP:
        for ref in [index, *entity.refs]:
            if ref >= len(entities):
                continue
            for param, kind, value in _params_of(scene, entities[ref]):
                if param == _CORONA_COLOUR and kind == "colour":
                    return value
    for ref in entity.refs:
        found = _colour_under(scene, entities, ref, depth + 1, seen)
        if found:
            return found
    if (entity.cls.get("name") or "").strip().lower() == _FALLOFF_MAP:
        for ref in [index, *entity.refs]:
            if ref >= len(entities):
                continue
            for param, kind, value in _params_of(scene, entities[ref]):
                if param == _FALLOFF_NEAR and kind == "colour":
                    return value
    return None


def _asset_under(scene: bytes, entities: list, index, assets: dict,
                 depth: int = 0, seen: set | None = None):
    """The first file named at or below one entity, and no further.

    A map is rarely a bitmap directly — a Color Correction or an Output sits
    between the slot and the picture — so the slot is followed down.  The walk
    stops at a material, which is somebody else's business.
    """
    if seen is None:
        seen = set()
    if index is None or index >= len(entities) or index in seen or depth > 5:
        return None
    seen.add(index)
    entity = entities[index]
    if depth and (entity.cls.get("super_id") or 0) == _MTL_CLASS:
        return None
    found = _asset_of(scene, entity, assets)
    if found:
        return found
    for ref in entity.refs:
        found = _asset_under(scene, entities, ref, assets, depth + 1, seen)
        if found:
            return found
    return None


#: Which keyed reference holds which map, for the plugin materials whose
#: numbering has been read off the files.
#:
#: Without this the rule is the older one — the first picture anywhere below
#: the material — and for a renderer's own material that is usually the wrong
#: one, because most of them carry several maps and the diffuse is rarely the
#: first.  Read that way an Audi comes out with a red roof, because the mask
#: cut into its sunroof is the first picture its material names.
#:
#: The two renderers keep the keys in different places, which ``on`` says.  A
#: **VRayMtl** keys them on itself, behind its six parameter blocks: 7 is the
#: diffuse (a suede's colour, a blinker's lens), 8 the reflection (a Falloff,
#: which is what a V-Ray glass reflects by) and 10 the bump — a Noise, a tyre's
#: tread, a file called ``suade_bump.png``.
#:
#: A **CoronaMtl** keys them on its parameter block instead, and numbers them
#: from zero in the order the block declares its map slots — 141 upwards, which
#: is Corona's colour ids with forty added.  Across one car's sixty-one: 0 held
#: every ``_color`` file, 1 every ``_refl``, 3 the glass and the masks cut into
#: it, 6 all thirteen normal maps and every ``CoronaNormal``, and 8 and 9 the
#: two ``_aniso``.  Nothing else in the file says which is which — the slot
#: parameters themselves are written byte for byte identical whether they are
#: filled or not.
#:
#: Slot 1 is the reflection, and it is read for the same reason the diffuse is:
#: a filled slot makes the colour beside it a placeholder.  Car paint is where
#: this shows.  All three of the Grecale's layered paints put a Falloff there —
#: black facing you, white at grazing, with the paint's own CoronaColor beneath
#: it — which is an artist drawing the Fresnel curve by hand.  The flat white
#: parameter left in the block is not what reflects: read it and the whole body
#: comes out chrome, and the gold reflects white instead of gold.
_MAP_SLOTS = {
    "vraymtl": {"on": "self", "diffuse": 7, "bump": 10},
    "coronamtl": {"on": "block", "diffuse": 0, "specular": 1, "bump": 6},
}
#: Corona renamed its material when the newer one arrived; the block did not
#: change, and a scene saved by either keys its maps the same way.
_MAP_SLOTS["coronalegacymtl"] = _MAP_SLOTS["coronamtl"]


#: The materials that are a *list* rather than a surface.
#:
#: The distinction decides how the materials one names are treated.  A
#: Multi/Sub-Object is nothing but a numbered list, and a face's material id
#: picks a slot out of it.  Everything else that names other materials — a
#: Blend, a VRayBlendMtl, a Shellac — is a surface of its own, made by mixing
#: them, and a face wearing it wears one thing and not a choice of several.
#:
#: Treating the second as the first is how an Audi came out with a red roof: of
#: the forty-four slots its body wears, three held a Blend, each of those was
#: taken for a list and so written as no material at all, and every slot behind
#: them shifted down to fill the gap.  Every panel of the car was then painted
#: out of the wrong tin — glass where the grille should be, and the red of a
#: logo across the sunroof.
_LIST_MATERIALS = {"multi/sub-object", "multimaterial"}

#: Where a blend keeps how much of the coat over its base actually shows.
#:
#: A VRayBlendMtl holds it as a colour on its own block, at parameter 2, and an
#: Audi's paint sets it to a half — so its coat, which states the reflection of
#: a mirror, shows at half of that.  Taken whole, every panel and every one of
#: the scene's material balls comes out chrome.
_COAT_AMOUNT = {"vrayblendmtl": 2}

#: And where one keeps it as a map slot instead, which is a stronger statement
#: than a number: a CoronaLayeredMtl puts the amount of its first layer at slot
#: 11, and all three of the Grecale's paints fill it with a Falloff that is
#: black facing you and 0.86 at grazing.  That is a coat seen along the edges
#: of a panel and nowhere else — so facing the camera there is no coat, which
#: is also what 3ds Max's own export makes of these three: it writes the base
#: coat's reflection and shininess and says nothing about a layer at all.
_COAT_AMOUNT_SLOT = {"coronalayeredmtl": 11}


def _facing(ior) -> float:
    """How much of a reflection comes back facing you, from its index.

    The Fresnel value at normal incidence, which is the number that tells a
    mirror from a windscreen.  Kept here as well as in the reading of a
    material because choosing *which* layer is the coat needs it, and the
    strongest layer is not the one with the brightest colour.
    """
    if not ior or ior <= 1.0:
        return 1.0
    return ((ior - 1.0) / (ior + 1.0)) ** 2


def _resolve_blends(materials: dict) -> None:
    """Give a surface made of other materials the look of its base coat.

    A Blend is not a surface anybody described — it is two or three that are,
    with a mask saying where each shows.  What its own blocks hold is that
    mask, so a reader that takes the first picture below it paints a tyre with
    the map that mixes its dirt in.  What it looks like is its first
    ingredient: the base coat, with the rest laid over.

    All of it, and not only the parts it says nothing about: a colour found in
    a blend's own block is a stray number and not a surface, and taking it
    left the base's glossiness behind with it.  This is what 3ds Max's own FBX
    export does — a blend comes out of it carrying its base coat's colour, its
    reflection and its shininess.
    """
    done: set = set()

    def resolve(index, chain=()):
        material = materials.get(index)
        if (material is None or index in done or index in chain
                or material.is_list or not material.subs):
            return material
        base = resolve(material.subs[0], chain + (index,))
        done.add(index)
        if base is None:
            return material
        material.look = base.look
        material.texture = base.texture
        material.bump = base.bump
        # And a clear coat is what the layers over that base are: the most
        # reflective of them, since a coat is a coat and the rest are dirt.
        # A layer that reflects nothing leaves no coat at all, which is what
        # the dirt blended over a tyre comes to.
        best = 0.0
        for over in material.subs[1:]:
            laid = resolve(over, chain + (index,))
            if laid is None or laid.look.get("specular") is None:
                continue
            strength = max(laid.look["specular"]) * _facing(laid.look.get("ior"))
            strength *= material.coat_amount
            if strength > best:
                best = strength
                shown = tuple(c * material.coat_amount for c in laid.look["specular"])
                material.coat = (shown, laid.look.get("ior"),
                                 laid.look.get("glossiness"))
        return material

    for index in list(materials):
        resolve(index)


def _keyed_maps(entities: list, entity: _Entity, where: str) -> dict:
    """Where a material's maps hang, which is not the same for every renderer.

    V-Ray keys them on the material; Corona keys them on the parameter block
    the material holds, so the block is what is asked.
    """
    if where != "block":
        return entity.typed
    for ref in entity.refs:
        if ref >= len(entities):
            continue
        if (entities[ref].cls.get("name") or "").lower().startswith("parambloc"):
            return entities[ref].typed
    return {}


def _read_material(scene: bytes, entities: list, index: int, assets: dict):
    """A material, and whatever its references say it is made of.

    A material keeps its colours in parameter blocks and its maps behind more
    of them, so the walk goes down its references until it finds a picture —
    but not past another material, which is where a Multi/Sub-Object's own
    sub-materials begin.  Where the class is one whose reference order is
    known, the picture is taken from the slot that holds the diffuse rather
    than from whichever comes first.

    A parameter block says nothing about itself, so what is carried down the
    walk is the class that holds it: a Standard material refers to its shader,
    the shader to the block, and it is the shader — Blinn, Phong, Anisotropic
    — that says what the numbers in that block are.
    """
    if index >= len(entities):
        return None
    entity = entities[index]
    look = None
    plain = None                    # the first colour anywhere, as a fallback
    shading = "unknown"
    texture = None
    subs: list[int] = []

    bump = None
    amount = 1.0                    # how much of a coat a blend lets show
    painted = None                  # a colour the diffuse slot holds outright
    reflected = None                # and the same for the reflection slot
    named = (entity.cls.get("name") or "").strip().lower()
    at_amount = _COAT_AMOUNT.get(named)
    if at_amount is not None:
        for ref in entity.refs:
            if ref >= len(entities):
                continue
            for param, kind, value in _params_of(scene, entities[ref]):
                if param == at_amount and kind == "colour":
                    amount = max(0.0, min(1.0, max(value)))
    at_slot = _COAT_AMOUNT_SLOT.get(named)
    if at_slot is not None:
        shown = _colour_under(scene, entities,
                              _keyed_maps(entities, entity, "block").get(at_slot))
        if shown is not None:
            amount = max(0.0, min(1.0, max(shown)))
    slots = _MAP_SLOTS.get(named)
    if slots is not None:
        # The slots decide it, including when one is empty: a material with a
        # bump and no diffuse map wears no picture and is bumped all the same.
        keyed = _keyed_maps(entities, entity, slots["on"])
        diffuse = keyed.get(slots["diffuse"])
        texture = _asset_under(scene, entities, diffuse, assets)
        bump = _asset_under(scene, entities, keyed.get(slots["bump"]), assets)
        if texture is None:
            painted = _colour_under(scene, entities, diffuse)
        if "specular" in slots:
            reflected = _colour_under(scene, entities, keyed.get(slots["specular"]))

    queue = [(at, entity.cls.get("name") or "") for at in entity.refs]
    walked = set()
    while queue and len(walked) < 64:
        at, owner = queue.pop(0)
        if at in walked or at >= len(entities):
            continue
        walked.add(at)
        part = entities[at]
        if (part.cls.get("super_id") or 0) == _MTL_CLASS:
            subs.append(at)                     # a sub-material, not our own
            continue
        # A block belongs to whatever holds it, however many blocks deep.
        name = part.cls.get("name") or ""
        holder = owner if name.lower().startswith("parambloc") else name
        params = _params_of(scene, part)
        layout = _SHADERS.get(holder.strip().lower())
        # A shader's block wins wherever the walk finds it: a Standard
        # material keeps three more blocks of its own, and one of them holds a
        # filter colour that would otherwise pass for the colour of the
        # surface.
        if layout and look is None:
            look = _appearance_of(params, layout, painted, reflected)
            if look is not None and holder.strip().lower() in _MAX_SHADERS:
                shading = "phong"
        if plain is None:
            plain = next((v for _, kind, v in params if kind == "colour"), None)
        if texture is None and slots is None:
            texture = _asset_of(scene, part, assets)
        queue.extend((ref, holder) for ref in part.refs)
    # A plugin's material lays its block out as it pleases, so all that can be
    # said of one is that the first colour in it is the diffuse.
    if look is None:
        look = {"colour": plain, "specular": None, "glossiness": None,
                "level": None, "ior": None}
    # Where no shader layout claimed the block, the slot's colour is still
    # better than the placeholder beside it.
    if painted is not None and look["colour"] is None:
        look = dict(look, colour=painted)
    made = _Material(_material_name(scene, entity), look, texture, subs, bump,
                     named in _LIST_MATERIALS, shading)
    made.coat_amount = amount
    return made


class _Entity:
    __slots__ = ("index", "cls", "start", "end", "refs", "typed")

    def __init__(self, index: int, cls: dict, start: int, end: int):
        self.index = index
        self.cls = cls
        self.start = start
        self.end = end
        self.refs: list[int] = []
        self.typed: dict[int, int] = {}


#: What a Symmetry modifier's parameter block holds, by the id of each.
#:
#: Read off a Ferrari whose forty-two symmetric parts all agree: 0 is an int
#: naming the axis, 1 and 2 are the slice and weld switches — on for every one
#: of them — 3 is the weld threshold, and 4 is the flip, set on exactly one
#: part in the car.
_SYM_AXIS = 0
_SYM_THRESHOLD = 3


def _symmetry_of(scene: bytes, entities: list, index: int):
    """Which way a Symmetry modifier mirrors, and how near the seam welds.

    The whole and half of it: the ints and the bool have to be read straight
    out of the block, since the reader that serves the shaders throws away
    every parameter that is not float-valued.
    """
    axis, threshold = None, 0.0
    for ref in [index, *entities[index].refs]:
        if ref >= len(entities):
            continue
        for idn, body, tail, _ in _chunks(scene, entities[ref].start, entities[ref].end):
            if idn not in _PARAMS or tail - body < 8:
                continue
            param, kind = struct.unpack_from("<HH", scene, body)
            if param == _SYM_AXIS and kind == _PARAM_INT:
                axis = struct.unpack_from("<i", scene, tail - 4)[0]
            elif param == _SYM_THRESHOLD and kind not in (_PARAM_INT, _PARAM_BOOL,
                                                          _PARAM_TEXMAP):
                threshold = struct.unpack_from("<f", scene, tail - 4)[0]
    if axis is None or not 0 <= axis <= 2:
        return None
    return axis, max(0.0, threshold)


def _mirrored(mesh: _Mesh, axis: int, plane: float, threshold: float) -> _Mesh:
    """The mesh with its own mirror image joined to it.

    Which is what a Symmetry modifier is for, and half of what the artist
    modelled is what a reader that skips it comes away with — a car whose
    every mirrored panel is missing down one side.

    A vertex within the threshold of the plane is *on* it: the two halves share
    it rather than each keeping their own, which is the weld, and it is snapped
    exactly onto the plane so the seam closes. Everything else is copied across
    to the other side. A mirror reverses which way round a face is wound, so
    the copies are wound backwards to keep facing outwards, and a face whose
    every corner sits on the seam is not copied at all — it would be the same
    face twice.
    """
    count = len(mesh.positions) // 3
    out = _Mesh()
    out.positions = list(mesh.positions)
    out.uvs = list(mesh.uvs)

    #: Where each vertex of the mirrored half lives — itself, where it is on
    #: the plane and shared.
    twin = [0] * count
    for i in range(count):
        at = i * 3 + axis
        if abs(out.positions[at] - plane) <= threshold:
            out.positions[at] = plane
            twin[i] = i
        else:
            twin[i] = len(out.positions) // 3
            out.positions.extend(mesh.positions[i * 3:i * 3 + 3])
            out.positions[-3 + axis] = 2.0 * plane - mesh.positions[at]

    out.polygons = list(mesh.polygons)
    out.face_uvs = list(mesh.face_uvs)
    out.materials = list(mesh.materials)
    out.groups = list(mesh.groups)
    out.faces = mesh.faces
    out.edges = mesh.edges

    face, start = 0, 0
    for at, index in enumerate(mesh.polygons):
        if index >= 0:
            continue
        corners = list(mesh.polygons[start:at]) + [~index]
        mirrored = [twin[c] for c in corners]
        if mirrored != corners:                 # not a face lying on the seam
            reversed_corners = mirrored[::-1]
            out.polygons.extend(reversed_corners[:-1])
            out.polygons.append(~reversed_corners[-1])
            if mesh.face_uvs:
                out.face_uvs.extend(mesh.face_uvs[start:at + 1][::-1])
            if mesh.materials:
                out.materials.append(mesh.materials[face])
            if mesh.groups:
                out.groups.append(mesh.groups[face])
            out.faces += 1
        face += 1
        start = at + 1
    if len(out.face_uvs) != len(out.polygons):
        out.uvs, out.face_uvs = [], []
    return out


def _smoothing_of(scene: bytes, entities: list, index: int) -> int:
    """How many rounds a subdividing modifier asks for.

    Its first parameter is the iteration count, which is the one thing about
    it worth knowing here: the mesh under it is the cage, and this is how many
    times the cage was meant to be divided.
    """
    entity = entities[index]
    for ref in entity.refs[:2]:
        if ref >= len(entities):
            continue
        for idn, body, tail, _ in _chunks(scene, entities[ref].start, entities[ref].end):
            if idn not in _PARAMS or tail - body > 27:
                continue
            param, kind = struct.unpack_from("<HH", scene, body)
            if param == 0 and kind == 1:
                return max(0, min(8, struct.unpack_from("<i", scene, tail - 4)[0]))
    return 0


def _read_entities(scene: bytes, classes: list[dict]) -> list[_Entity]:
    """The scene list: one entity per top-level chunk, in file order."""
    outer = next(_chunks(scene, 0, len(scene)), None)
    if outer is None:
        return []
    _, start, end, _ = outer
    out: list[_Entity] = []
    for index, (idn, body, tail, container) in enumerate(_chunks(scene, start, end)):
        cls = classes[idn] if idn < len(classes) else {"name": f"class {idn}",
                                                       "super_id": 0, "class_id": 0}
        entity = _Entity(index, cls, body, tail)
        for cid, cb, ct, _ in _chunks(scene, body, tail):
            if cid == _REFS:
                entity.refs = list(struct.unpack_from("<%dI" % ((ct - cb) // 4), scene, cb))
            elif cid == _TYPED_REFS and ct - cb >= 4:
                words = struct.unpack_from("<%dI" % ((ct - cb) // 4), scene, cb)
                for at in range(1, len(words) - 1, 2):
                    entity.typed[words[at]] = words[at + 1]
                entity.refs = list(entity.typed.values())
        out.append(entity)
    return out


def _deep_find(scene: bytes, start: int, end: int, wanted: int, depth: int = 0):
    """Find a chunk anywhere below a range, not only among its own children.

    Controllers wrap their value in a block of their own, so the value is a
    level or two down from the controller itself.
    """
    for idn, body, tail, container in _chunks(scene, start, end):
        if idn == wanted:
            return body, tail
        if container and depth < 4:
            found = _deep_find(scene, body, tail, wanted, depth + 1)
            if found:
                return found
    return None


def _float_of(scene: bytes, entity: _Entity):
    """One float controller's value."""
    found = _deep_find(scene, entity.start, entity.end, _FLOAT)
    if found and found[1] - found[0] >= 4:
        return struct.unpack_from("<f", scene, found[0])[0]
    return None


def _controller_value(scene: bytes, entities: list, entity: _Entity, wanted: int,
                      default: tuple[float, float, float]) -> tuple[float, float, float]:
    """What a controller says, however it chooses to say it.

    A Position XYZ or Euler XYZ keeps nothing itself: it refers to three float
    controllers, one per axis, and each of those wraps a single value.  Some
    controllers do carry the three together, so both are read.
    """
    found = _deep_find(scene, entity.start, entity.end, wanted)
    if found and found[1] - found[0] >= 12:
        return struct.unpack_from("<3f", scene, found[0])

    axes = [entities[r] for r in entity.refs[:3] if r < len(entities)]
    if len(axes) == 3:
        values = [_float_of(scene, axis) for axis in axes]
        if all(v is not None for v in values):
            return tuple(values)
    return default


def _euler_from_quaternion(x: float, y: float, z: float, w: float):
    """A quaternion as the XYZ Euler angles an FBX record wants, in radians."""
    import math

    sinr = 2.0 * (w * x + y * z)
    cosr = 1.0 - 2.0 * (x * x + y * y)
    roll = math.atan2(sinr, cosr)
    sinp = 2.0 * (w * y - z * x)
    pitch = math.copysign(math.pi / 2, sinp) if abs(sinp) >= 1 else math.asin(sinp)
    siny = 2.0 * (w * z + x * y)
    cosy = 1.0 - 2.0 * (y * y + z * z)
    yaw = math.atan2(siny, cosy)
    return (roll, pitch, yaw)


def _object_offset(scene: bytes, node: _Entity) -> dict:
    """Where a node holds its mesh, which need not be where the node is.

    3ds Max keeps this apart from the node's own transform — it is the offset
    an FBX writes as the geometric transform, the one a child does not
    inherit — and a part that carries one is somewhere else entirely without
    it.
    """
    out = {"translation": (0.0, 0.0, 0.0), "rotation": (0.0, 0.0, 0.0),
           "scale": (1.0, 1.0, 1.0)}
    found = _find(scene, node.start, node.end, _OFFSET_POS)
    if found and found[1] - found[0] >= 12:
        out["translation"] = struct.unpack_from("<3f", scene, found[0])
    found = _find(scene, node.start, node.end, _OFFSET_ROT)
    if found and found[1] - found[0] >= 16:
        x, y, z, w = struct.unpack_from("<4f", scene, found[0])
        out["rotation"] = _euler_from_quaternion(x, y, z, w)
    found = _find(scene, node.start, node.end, _OFFSET_SCALE)
    if found and found[1] - found[0] >= 12:
        out["scale"] = struct.unpack_from("<3f", scene, found[0])
    return out


def _node_parent(scene: bytes, node: _Entity) -> int | None:
    """The entity a node hangs off, or nothing where it hangs off the scene.

    A child's controller says where it stands *relative to its parent*, so a
    scene read without this puts every part at the origin of the world instead:
    a car whose wheels are linked to its body comes out with the wheels
    somewhere below it and the body in the air.  The scene's own root is a node
    like any other and is not among the parts, so naming it comes to the same
    thing as naming nothing.
    """
    found = _find(scene, node.start, node.end, _PARENT)
    if found is None or found[1] - found[0] < 4:
        return None
    return struct.unpack_from("<I", scene, found[0])[0]


def _node_transform(scene: bytes, entities: list[_Entity], node: _Entity) -> dict:
    """Where a node stands: what its controller says, or nothing at all.

    Most scenes of this kind put the geometry in world space and leave every
    node at the origin, so an absent controller is the common case and not a
    failure.
    """
    out = {"translation": (0.0, 0.0, 0.0), "rotation": (0.0, 0.0, 0.0),
           "scale": (1.0, 1.0, 1.0)}
    at = node.typed.get(0)
    if at is None or at >= len(entities):
        return out
    controller = entities[at]
    parts = [entities[i] for i in controller.refs if i < len(entities)]
    for part in parts:
        name = (part.cls.get("name") or "").lower()
        if "position" in name:
            out["translation"] = _controller_value(scene, entities, part, _POINT3,
                                                   out["translation"])
        elif "euler" in name or "rotation" in name:
            out["rotation"] = _controller_value(scene, entities, part, _POINT3,
                                                out["rotation"])
        elif "scale" in name:
            out["scale"] = _controller_value(scene, entities, part, _SCALE, out["scale"])
    return out


# -------------------------------------------------------------------- build


def _node(name: str, props: list[Property] | None = None,
          children: list[Node] | None = None) -> Node:
    return Node(name=name, props=props or [], children=children or [])


def _s(value: str) -> Property:
    return Property("S", value)


def _i(value: int) -> Property:
    return Property("I", int(value))


def _l(value: int) -> Property:
    return Property("L", int(value))


def _d(value: float) -> Property:
    return Property("D", float(value))


def _array(code: str, values, load: bool) -> Property:
    width = 8 if code == "d" else 4
    info = ArrayInfo(length=len(values), encoding=0, byte_length=len(values) * width)
    return Property(code, list(values) if load else None, info)


def _p70(name: str, kind: str, *values) -> Node:
    return _node("P", [_s(name), _s(kind), _s(""), _s("A"), *values])


def _degrees(radians: float) -> float:
    return radians * 57.29577951308232


def is_compound(head: bytes) -> bool:
    """True for any OLE2 compound file — a .max, but also a .doc or an .xls.

    Detection works off a file's head, and the streams that say which kind it
    is live at an offset the head does not reach; this is what the head can
    honestly answer, and `is_max` settles it once the whole file is there.
    """
    return head[:8] == MAGIC


def is_max(data: bytes) -> bool:
    """True when *data* is a 3ds Max scene rather than another compound file."""
    if data[:8] != MAGIC:
        return False
    try:
        names = set(_Compound(data).names)
    except (ParseError, struct.error, IndexError):
        return False
    return "Scene" in names and any(n.startswith("ClassDirectory") for n in names)


def parse_max(data: bytes, path: str | None = None, *, load_arrays: bool = True
              ) -> Document:
    """Read a .max file into the record tree the rest of the tool works on."""
    compound = _Compound(data)
    scene = compound.stream("Scene")
    if not scene:
        raise ParseError("no Scene stream — this compound file is not a 3ds Max scene")

    classes = _read_classes(compound.stream("ClassDirectory3")
                            or compound.stream("ClassDirectory"))
    dlls = _read_dlls(compound.stream("DllDirectory"))
    assets = _read_assets(compound.stream("FileAssetMetaData3")
                          or compound.stream("FileAssetMetaData2"))
    summary = _read_summary(compound.stream("\x05SummaryInformation"))
    build = _read_version(compound.stream("Config"), compound.stream("SaveConfigData"))

    root = Node(name="")
    doc = Document(root=root, encoding="binary", format="max", path=path,
                   file_size=len(data), version=build)
    entities = _read_entities(scene, classes)

    # ---- the meshes, and the nodes that place them
    meshes: dict[int, _Mesh] = {}
    undecoded: dict[str, int] = {}
    for entity in entities:
        if (entity.cls.get("super_id") or 0) != 0x10:
            continue
        block = _find(scene, entity.start, entity.end, _MESH)
        if block is None:
            name = entity.cls.get("name") or "object"
            undecoded[name] = undecoded.get(name, 0) + 1
            continue
        try:
            mesh = _read_mesh(scene, block[0], block[1])
        except (ParseError, struct.error) as error:
            doc.warn(f"{entity.cls.get('name')} at entity {entity.index}: {error}")
            continue
        if mesh is not None:
            meshes[entity.index] = mesh

    # A parameter block names a file by the identifier the asset table gives
    # it, which is what ties a material to the picture it wears.
    by_id = {a["id"]: a["name"] for a in assets if a.get("id")}

    nodes = [e for e in entities if (e.cls.get("name") or "") == "Node"]
    placed = []
    materials: dict[int, _Material] = {}
    #: How many parts were modelled with a subdividing modifier, and the most
    #: rounds any of them asks for.
    smoothed = [0, 0]
    #: How many parts the reader mirrored for a Symmetry modifier.
    mirrored = [0]
    for node in nodes:
        found = _find(scene, node.start, node.end, _NAME)
        name = _text(scene[found[0]:found[1]]) if found else ""
        target = node.typed.get(1)
        mesh = meshes.get(target) if target is not None else None
        smoothing = 0
        symmetry = None
        if mesh is None and target is not None and target < len(entities):
            # A modifier sits between the node and its mesh; the base object is
            # what it was built from, so follow the references down to it.
            seen = set()
            queue = [target]
            while queue and mesh is None:
                at = queue.pop(0)
                if at in seen or at >= len(entities):
                    continue
                seen.add(at)
                kind = (entities[at].cls.get("name") or "").lower()
                if "smooth" in kind:
                    smoothing = max(smoothing, _smoothing_of(scene, entities, at))
                elif kind == "symmetry" and symmetry is None:
                    symmetry = _symmetry_of(scene, entities, at)
                mesh = meshes.get(at)
                if mesh is None:
                    queue.extend(entities[at].refs)
        offset = _object_offset(scene, node)
        if mesh is not None and symmetry is not None:
            # A modifier works about the object's pivot, and the mesh is stored
            # an object offset away from it — so the plane the artist mirrored
            # across sits at minus that offset in the mesh's own coordinates.
            # Checked against 3ds Max's own export of the same car: for all
            # forty-two of its symmetric parts, that is the plane that gives
            # back the width the export has.
            axis, threshold = symmetry
            mirrored[0] += 1
            mesh = _mirrored(mesh, axis, -offset["translation"][axis], threshold)
        wearing = node.typed.get(3)
        # Every material below this one, however deep: a slot of a
        # Multi/Sub-Object is often a Blend, and what that Blend is made of is
        # a level further down again.
        queue = [wearing] if wearing is not None else []
        while queue:
            at = queue.pop(0)
            if at is None or at in materials:
                continue
            found = _read_material(scene, entities, at, by_id)
            if found is None:
                continue
            materials[at] = found
            queue.extend(sub for sub in found.subs if sub not in materials)
        if smoothing:
            smoothed[0] += 1
            smoothed[1] = max(smoothed[1], smoothing)
        # Every node, and not only the ones that draw something.  A Dummy has
        # no geometry, and left out it has no record for its children to hang
        # from — so a Ferrari whose wheels are grouped under one comes out with
        # all four of them stacked at the origin, inside the car.
        placed.append((node, name, mesh, _node_transform(scene, entities, node),
                       wearing, offset))

    _resolve_blends(materials)

    # ---- the record tree
    creator = summary.get("application") or "Autodesk 3ds Max"
    header = [_node("Creator", [_s(creator)])]
    root.children.append(_node("FBXHeaderExtension", [], header))

    objects_node = _node("Objects", [], [])
    connections: list[Node] = []
    uid = 1000

    # One record per material, written before the parts that wear them so a
    # part can be connected as it is written.
    material_uids: dict[int, int] = {}
    texture_uids: dict[str, int] = {}
    # A slot must keep its number, so anything a list names gets a record even
    # where it is a list itself: leave one out and every slot behind it moves
    # up, and the whole car is painted out of the wrong tins.
    in_a_slot = {sub for material in materials.values() if material.is_list
                 for sub in material.subs}
    for index in sorted(materials):
        material = materials[index]
        if material.is_list and index not in in_a_slot:
            continue                    # a list is a list of slots, not a surface
        uid += 1
        material_uids[index] = uid
        look = material.look
        colour = look["colour"] or (0.6, 0.6, 0.6)
        props = [_p70("DiffuseColor", "Color", *(_d(c) for c in colour))]
        if look["specular"] is not None:
            props.append(_p70("SpecularColor", "Color",
                              *(_d(c) for c in look["specular"])))
        # Specular level is a percentage in the file and a factor here.
        if look["level"] is not None:
            props.append(_p70("SpecularFactor", "Number", _d(look["level"])))
        # Glossiness is 0 to 1 and the exponent an FBX material carries is
        # two to the ten times it, which is the conversion 3ds Max's own
        # exporter makes: read off its export of this same scene, where every
        # one of seventy materials lands on 2**(10 * glossiness) to four
        # decimals — 0.3 becomes 8, 0.65 becomes 90.51, 1.0 becomes 1024.
        # A percentage instead put a mirror and a matte panel within a few of
        # each other, and the whole car came out equally satin.
        if look["glossiness"] is not None:
            props.append(_p70("ShininessExponent", "Number",
                              _d(2.0 ** (10.0 * min(1.0, max(0.0, look["glossiness"]))))))
        # Only where the material says so: a .max carries no opacity otherwise,
        # and writing 1 for every material would say something the file does
        # not.
        if look.get("opacity") is not None and look["opacity"] < 1.0:
            props.append(_p70("Opacity", "Number", _d(look["opacity"])))
        # The index of refraction the reflection is shaped by.  What comes back
        # facing you is ((n-1)/(n+1))**2 of the colour beside it, which is the
        # difference between a mirror and a sheet of glass; both renderers
        # state it, and their own export carries it too.
        if look.get("ior") is not None and look["ior"] > 1.0:
            props.append(_p70("ReflectionIor", "Number", _d(look["ior"])))
        # The clear coat over it, written the same way its own reflection is.
        # A car's paint is a dark satin base under a mirror, and dropping the
        # mirror is dropping what makes paint look like paint.
        if material.coat is not None:
            coat_colour, coat_ior, coat_gloss = material.coat
            props.append(_p70("CoatColor", "Color", *(_d(c) for c in coat_colour)))
            if coat_ior is not None and coat_ior > 1.0:
                props.append(_p70("CoatIor", "Number", _d(coat_ior)))
            if coat_gloss is not None:
                props.append(_p70("CoatShininess", "Number",
                                  _d(2.0 ** (10.0 * min(1.0, max(0.0, coat_gloss))))))
        # Also as a property, which is where 3ds Max's own export puts it, and
        # so where the reading of a specular goes looking for it.
        props.append(_node("P", [_s("ShadingModel"), _s("KString"), _s(""), _s(""),
                                 _s(material.shading)]))
        objects_node.children.append(
            _node("Material",
                  [_l(uid), _s(f"{material.name or f'material{index}'}\x00\x01Material"),
                   _s("")],
                  [_node("Version", [_i(102)]),
                   _node("ShadingModel", [_s(material.shading)]),
                   _node("Properties70", [], props)]))

        # Each picture the material names, under the property it drives.  The
        # same file in two slots — which happens, a bump doubling as a
        # displacement — is one Texture record bound twice.
        for filename, drives in ((material.texture, "DiffuseColor"),
                                 (material.bump, "Bump")):
            if not filename:
                continue
            if filename not in texture_uids:
                uid += 2
                texture_uids[filename] = uid - 1
                objects_node.children.append(
                    _node("Texture",
                          [_l(uid - 1), _s(f"{filename}\x00\x01Texture"), _s("")],
                          [_node("Type", [_s("TextureVideoClip")]),
                           _node("Version", [_i(202)]),
                           _node("FileName", [_s(filename)]),
                           _node("RelativeFilename", [_s(filename)])]))
                objects_node.children.append(
                    _node("Video",
                          [_l(uid), _s(f"{filename}\x00\x01Video"), _s("Clip")],
                          [_node("Type", [_s("Clip")]),
                           _node("FileName", [_s(filename)]),
                           _node("RelativeFilename", [_s(filename)])]))
                connections.append(_node("C", [_s("OO"), _l(uid), _l(uid - 1)]))
            connections.append(_node("C", [_s("OP"), _l(texture_uids[filename]),
                                           _l(material_uids[index]), _s(drives)]))

    # Every part is numbered before any is written, so a child can name the
    # parent that places it whichever of the two the scene lists first.
    model_uids = {entity.index: uid + 2 * at + 2
                  for at, (entity, *_) in enumerate(placed)}

    for at, (entity, name, mesh, placement, wearing, offset) in enumerate(placed):
        # Two uids apiece whether or not there is geometry, so that the numbers
        # a child was promised above are the numbers it gets.
        geometry_uid, model_uid = uid + 1, uid + 2
        uid += 2
        label = name or f"object{at + 1}"
        geometry_children = [] if mesh is None else [
            _node("Vertices", [_array("d", mesh.positions, load_arrays)]),
            _node("PolygonVertexIndex", [_array("i", mesh.polygons, load_arrays)]),
            _node("GeometryVersion", [_i(124)]),
        ]
        if mesh is not None and mesh.uvs and mesh.face_uvs:
            geometry_children.append(_node("LayerElementUV", [_i(0)], [
                _node("Version", [_i(101)]),
                _node("Name", [_s("map1")]),
                _node("MappingInformationType", [_s("ByPolygonVertex")]),
                _node("ReferenceInformationType", [_s("IndexToDirect")]),
                _node("UV", [_array("d", mesh.uvs, load_arrays)]),
                _node("UVIndex", [_array("i", mesh.face_uvs, load_arrays)]),
            ]))
        # Which materials this part wears: the one its node names, or the list
        # a Multi/Sub-Object holds, which is what a face's material id picks
        # from. Everything else here counts from zero, so the ids are mapped
        # onto the slots this part actually has.
        worn = materials.get(wearing) if wearing is not None else None
        slots = []
        if worn is not None and worn.is_list:
            # Positionally, and with nothing left out: the numbers are what a
            # face's material id picks by.
            slots = [material_uids[sub] for sub in worn.subs if sub in material_uids]
        elif wearing in material_uids:
            slots = [material_uids[wearing]]

        if mesh is None:
            slots = []
        elif len(slots) > 1 and mesh.materials:
            per_face = [material % len(slots) for material in mesh.materials]
            geometry_children.append(_node("LayerElementMaterial", [_i(0)], [
                _node("Version", [_i(101)]),
                _node("MappingInformationType", [_s("ByPolygon")]),
                _node("ReferenceInformationType", [_s("IndexToDirect")]),
                _node("Materials", [_array("i", per_face, load_arrays)]),
            ]))
        elif slots:
            geometry_children.append(_node("LayerElementMaterial", [_i(0)], [
                _node("Version", [_i(101)]),
                _node("MappingInformationType", [_s("AllSame")]),
                _node("ReferenceInformationType", [_s("IndexToDirect")]),
                _node("Materials", [_array("i", [0], load_arrays)]),
            ]))
        # Which faces share a smooth normal, and so where an edge is hard.  A
        # .max stores no normals — only the cage — so without this the mesh can
        # only be shaded flat, and every crease on a car body rounds away.
        if mesh is not None and any(mesh.groups):
            geometry_children.append(_node("LayerElementSmoothing", [_i(0)], [
                _node("Version", [_i(102)]),
                _node("MappingInformationType", [_s("ByPolygon")]),
                _node("ReferenceInformationType", [_s("Direct")]),
                _node("Smoothing", [_array("i", mesh.groups, load_arrays)]),
            ]))
        if mesh is not None:
            geometry_children.append(
                _node("Layer", [_i(0)], [_node("Version", [_i(100)])]))
            objects_node.children.append(
                _node("Geometry",
                      [_l(geometry_uid), _s(f"{label}\x00\x01Geometry"), _s("Mesh")],
                      geometry_children))

        model_props = []
        translation = placement["translation"]
        rotation = placement["rotation"]
        scale = placement["scale"]
        if any(translation):
            model_props.append(_p70("Lcl Translation", "Lcl Translation",
                                    *(_d(v) for v in translation)))
        if any(rotation):
            model_props.append(_p70("Lcl Rotation", "Lcl Rotation",
                                    *(_d(_degrees(v)) for v in rotation)))
        if scale != (1.0, 1.0, 1.0):
            model_props.append(_p70("Lcl Scaling", "Lcl Scaling",
                                    *(_d(v) for v in scale)))
        if any(offset["translation"]):
            model_props.append(_p70("GeometricTranslation", "Vector3D",
                                    *(_d(v) for v in offset["translation"])))
        if any(offset["rotation"]):
            model_props.append(_p70("GeometricRotation", "Vector3D",
                                    *(_d(_degrees(v)) for v in offset["rotation"])))
        if offset["scale"] != (1.0, 1.0, 1.0):
            model_props.append(_p70("GeometricScaling", "Vector3D",
                                    *(_d(v) for v in offset["scale"])))
        # A node with nothing to draw is still a place to hang things from, and
        # an FBX calls that a Null.
        objects_node.children.append(
            _node("Model", [_l(model_uid), _s(f"{label}\x00\x01Model"),
                            _s("Mesh" if mesh is not None else "Null")],
                  [_node("Version", [_i(232)]),
                   _node("Properties70", [], model_props)]))
        under = model_uids.get(_node_parent(scene, entity), 0)
        connections.append(_node("C", [_s("OO"), _l(model_uid), _l(under)]))
        if mesh is not None:
            connections.append(_node("C", [_s("OO"), _l(geometry_uid), _l(model_uid)]))
        for slot in slots:
            connections.append(_node("C", [_s("OO"), _l(slot), _l(model_uid)]))

    root.children.append(_node("GlobalSettings", [], [
        _node("Version", [_i(1000)]),
        _node("Properties70", [], [
            # 3ds Max is Z up, right handed.
            _node("P", [_s("UpAxis"), _s("int"), _s("Integer"), _s(""), _i(2)]),
            _node("P", [_s("UpAxisSign"), _s("int"), _s("Integer"), _s(""), _i(1)]),
            _node("P", [_s("FrontAxis"), _s("int"), _s("Integer"), _s(""), _i(1)]),
            _node("P", [_s("FrontAxisSign"), _s("int"), _s("Integer"), _s(""), _i(-1)]),
            _node("P", [_s("CoordAxis"), _s("int"), _s("Integer"), _s(""), _i(0)]),
            _node("P", [_s("CoordAxisSign"), _s("int"), _s("Integer"), _s(""), _i(1)]),
            _node("P", [_s("UnitScaleFactor"), _s("double"), _s("Number"), _s(""), _d(1.0)]),
        ]),
    ]))
    # A node that draws nothing is a place to hang things from and not a part.
    drawn = [row for row in placed if row[2] is not None]
    root.children.append(_node("Definitions", [], [
        _node("Version", [_i(100)]),
        _node("Count", [_i(len(objects_node.children))]),
        _node("ObjectType", [_s("Geometry")], [_node("Count", [_i(len(drawn))])]),
        _node("ObjectType", [_s("Model")], [_node("Count", [_i(len(placed))])]),
        _node("ObjectType", [_s("Material")], [_node("Count", [_i(len(material_uids))])]),
    ]))
    root.children.append(objects_node)
    root.children.append(_node("Connections", [], connections))

    vertices = sum(len(row[2].positions) // 3 for row in drawn)
    doc.extra = {
        "streams": compound.names,
        "sector": compound.sector,
        "classes": [c for c in classes if c.get("name")],
        "dlls": dlls,
        "assets": assets,
        "summary": summary,
        "entities": len(entities),
        "nodes": len(nodes),
        "meshes": len(meshes),
        "placed": len(drawn),
        "vertices": vertices,
        "faces": sum(mesh.faces for mesh in meshes.values()),
        "undecoded": undecoded,
        "build": build,
        "materials": len(material_uids),
        "textures": sorted(texture_uids),
        "smoothed": smoothed[0],
        "mirrored": mirrored[0],
        "smoothing": smoothed[1],
    }
    if undecoded:
        doc.warn("no geometry read from "
                 + ", ".join(f"{count} {name}" for name, count in sorted(undecoded.items())))
    if not drawn:
        doc.warn("no Editable Poly geometry in this scene")
    return doc
