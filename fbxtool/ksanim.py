"""The animations that sit beside an Assetto Corsa car.

Everything under ``animations/`` next to a ``.kn5`` is one clip: ``steer``,
``car_door_L``, ``car_wiper``, ``shift``, ``capote``.  A clip names some of the
model's nodes and gives each of them a row of placements, and the game plays it
by *position* rather than by time — the steering wheel is however far through
``steer.ksanim`` the front wheels are turned, and a door is however far through
``car_door_L.ksanim`` it has been opened.  So there is no clock in the file and
no duration: there are N placements and the game picks between them.

The format has no magic number.  Two versions are in circulation and both are
here — of 1,461 clips across the 209 zipped cars to hand, 1,379 are version 2
and 71 are version 1::

    u32   version, 1 or 2
    u32   node count
    per node:
      u32       length of the node's name
      bytes     the name, UTF-8
      u32       key count
      per key:
        v1:  16 x f32   a 4x4 placement, the translation in the last row
        v2:  10 x f32   quaternion x y z w, translation x y z, scale x y z

A key is the node's whole local placement and not a change to it.  A BMW Z3's
``capote.ksanim`` opens on translation (0.0080, 0.8766, -0.2755), a rotation of
half a degree and a scale of 0.909, and the model's own ``capote`` node states
those three to the last digit — so at the start of a clip an animated node is
exactly where the file already had it, and playing one replaces the placement
rather than composing with it.

Both versions are decoded to the same sixteen numbers, in the order the rest of
this package holds a matrix: ``m[col * 4 + row]``, the translation last.  That
is what a ``.kn5`` node already writes and what glTF writes, so a version 1
key is used exactly as it is read.

There is no magic number to check, so :func:`is_ksanim` walks the structure and
asks whether it lands precisely on the end of the file.  That is a real test
rather than a formality: it accepts all 1,450 clips to hand to the last byte,
and it is what rejects the eleven ``._``-prefixed macOS resource forks that
come out of the same folders looking like clips and are not.
"""

from __future__ import annotations

import math
import os
import struct
from dataclasses import dataclass, field

from .model import ParseError

__all__ = ["Track", "Clip", "is_ksanim", "parse_ksanim", "read_clips",
           "beside", "DRIVER_PREFIX"]


#: How many bytes one key takes, per version.
_KEY_BYTES = {1: 64, 2: 40}

#: The most nodes and keys a clip is believed before it is called nonsense.
#: The largest to hand is a BMW Z3's ``steer.ksanim`` at 270 nodes, and the
#: longest row of keys is 303; these are far enough above both to leave any
#: real file alone while keeping a random file from asking for a gigabyte.
_MAX_NODES = 65536
_MAX_KEYS = 65536
_MAX_NAME = 1024

#: What a clip's nodes are called when they belong to the driver rather than to
#: the car.  The driver is a separate model that lives inside the game and not
#: beside the car, so these name nothing here however sound the clip is: of 123
#: clips across 22 cars, 48 are nothing but these.
DRIVER_PREFIX = "DRIVER:"


@dataclass
class Track:
    """One node of a clip, and where the clip puts it."""

    name: str
    keys: int
    #: One 4x4 per key, or ``None`` where the clip was read for its shape
    #: alone.  A steering clip is 270 nodes of 100 keys, and a reader that only
    #: wants to say so should not pay for 432,000 numbers to find out.
    matrices: list[list[float]] | None = None


@dataclass
class Clip:
    """One ``.ksanim``: the nodes it moves, and how far it moves them."""

    version: int
    tracks: list[Track] = field(default_factory=list)
    name: str = ""
    path: str | None = None

    @property
    def keys(self) -> int:
        """The longest row of keys in the clip, which is its length.

        Every clip to hand gives all of its nodes the same number, but nothing
        in the format requires that, and a clip is as long as its longest node.
        """
        return max((track.keys for track in self.tracks), default=0)

    @property
    def driver_only(self) -> bool:
        """Whether this clip is the driver's rather than the car's."""
        return bool(self.tracks) and all(
            track.name.startswith(DRIVER_PREFIX) for track in self.tracks)


def _quaternion_matrix(qx: float, qy: float, qz: float, qw: float,
                       tx: float, ty: float, tz: float,
                       sx: float, sy: float, sz: float) -> list[float]:
    """A version 2 key as the sixteen numbers version 1 writes directly.

    Composed the way a node's own placement is — the scale first, then the
    rotation, then the translation — because that is what the numbers are: a
    BMW Z3's soft top opens at the scale, rotation and translation its model
    states for the same node, and read in any other order it would not.
    """
    # Normalised, because a quaternion stored as four floats and interpolated
    # by whatever wrote it does not always arrive at unit length, and a
    # rotation built from one that is not scales the node as well as turning
    # it.
    length = math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw)
    if length > 1e-12:
        qx, qy, qz, qw = qx / length, qy / length, qz / length, qw / length
    else:
        qx = qy = qz = 0.0
        qw = 1.0
    return [
        (1 - 2 * (qy * qy + qz * qz)) * sx, (2 * (qx * qy + qz * qw)) * sx,
        (2 * (qx * qz - qy * qw)) * sx, 0.0,
        (2 * (qx * qy - qz * qw)) * sy, (1 - 2 * (qx * qx + qz * qz)) * sy,
        (2 * (qy * qz + qx * qw)) * sy, 0.0,
        (2 * (qx * qz + qy * qw)) * sz, (2 * (qy * qz - qx * qw)) * sz,
        (1 - 2 * (qx * qx + qy * qy)) * sz, 0.0,
        tx, ty, tz, 1.0,
    ]


def _walk(data: bytes, *, load_keys: bool,
          only: set[str] | None = None) -> tuple[int, list[Track]]:
    """Step through a clip, raising :class:`ParseError` at the first thing
    that does not fit.  Returns the version and the tracks."""
    if len(data) < 8:
        raise ParseError("not a .ksanim — it is too short to hold a header")
    version, count = struct.unpack_from("<II", data, 0)
    if version not in _KEY_BYTES:
        raise ParseError(f".ksanim version {version} — this reads 1 and 2")
    if count > _MAX_NODES:
        raise ParseError(f".ksanim claims {count:,} nodes, which is not a clip")
    stride = _KEY_BYTES[version]
    at = 8
    tracks: list[Track] = []
    for index in range(count):
        if at + 4 > len(data):
            raise ParseError(f".ksanim ends in the middle of node {index + 1} "
                             f"of {count}")
        (length,) = struct.unpack_from("<I", data, at)
        at += 4
        if length > _MAX_NAME or at + length + 4 > len(data):
            raise ParseError(f".ksanim gives node {index + 1} a name "
                             f"{length:,} bytes long")
        name = data[at:at + length].decode("utf-8", "replace")
        at += length
        (keys,) = struct.unpack_from("<I", data, at)
        at += 4
        if keys > _MAX_KEYS:
            raise ParseError(f".ksanim gives {name or 'a node'} {keys:,} keys")
        end = at + keys * stride
        if end > len(data):
            raise ParseError(f".ksanim ends in the middle of {name or 'a node'}")
        matrices = None
        if load_keys and (only is None or name in only):
            matrices = []
            for k in range(keys):
                start = at + k * stride
                if version == 1:
                    matrices.append(list(struct.unpack_from("<16f", data, start)))
                else:
                    matrices.append(_quaternion_matrix(
                        *struct.unpack_from("<10f", data, start)))
        tracks.append(Track(name=name, keys=keys, matrices=matrices))
        at = end
    if at != len(data):
        raise ParseError(f".ksanim has {len(data) - at:,} bytes left over after "
                         f"its {count:,} node(s)")
    return version, tracks


def _moves(track: Track) -> bool:
    """Whether a node goes anywhere over the clip.

    A clip written for one car and dropped beside another names that car's
    nodes and holds this one's still: a BMW Z3's ``steer.ksanim`` names 270
    nodes, 13 of which this car has, and every one of those 13 is the same
    placement in all 100 of its keys — the turning is in the 257 belonging to
    the BMW M Coupe the clip was authored against.  So naming a node here is
    not the same as moving one, and offering such a clip is offering a slider
    that does nothing.
    """
    if not track.matrices:
        return False
    first = track.matrices[0]
    return any(any(abs(a - b) > 1e-6 for a, b in zip(first, other))
               for other in track.matrices[1:])


def is_ksanim(data: bytes) -> bool:
    """Whether these bytes are a clip.

    There is no magic number, so the structure is walked and has to land
    exactly on the end of the file.  Anything else — a resource fork, a text
    file, a picture — runs off the end or finishes early.
    """
    try:
        _walk(data, load_keys=False)
    except (ParseError, struct.error):
        return False
    return True


def parse_ksanim(data: bytes, *, path: str | None = None,
                 load_keys: bool = False,
                 only: set[str] | None = None) -> Clip:
    """Parse one ``.ksanim``.

    *load_keys* decodes every placement.  Left off — which is what a count
    wants — the clip is read for its shape alone and the keys are stepped over,
    since a steering clip is 270 nodes of up to 200 keys and saying so needs
    none of them.

    *only* narrows that to the nodes named in it, which is how a car reads a
    clip: two thirds of the nodes a steering clip names belong to some other
    model, and decoding their placements is work done to throw away.
    """
    try:
        version, tracks = _walk(data, load_keys=load_keys, only=only)
    except struct.error as error:  # pragma: no cover - _walk checks the lengths
        raise ParseError(f"could not read a .ksanim: {error}") from error
    name = os.path.splitext(os.path.basename(path))[0] if path else ""
    return Clip(version=version, tracks=tracks, name=name, path=path)


#: How many clips are read from a folder before the rest are counted and left.
#: The most beside any car to hand is 27; this is well clear of that and keeps
#: a folder somebody has emptied a mod pack into from being walked in full.
CLIP_LIMIT = 64


def beside(path: str | None, *, load_keys: bool = False,
           only: set[str] | None = None) -> list[Clip]:
    """Every clip in the ``animations/`` folder next to a model.

    Sorted by name, because the folder's own order is the file system's and a
    report that changes between two machines reads like a file that did.
    """
    if path is None:
        return []
    folder = os.path.join(os.path.dirname(os.path.abspath(path)), "animations")
    try:
        entries = sorted(os.listdir(folder))
    except OSError:
        return []
    out: list[Clip] = []
    for entry in entries:
        if not entry.lower().endswith(".ksanim"):
            continue
        if len(out) >= CLIP_LIMIT:
            break
        try:
            with open(os.path.join(folder, entry), "rb") as handle:
                data = handle.read()
        except OSError:
            continue
        try:
            out.append(parse_ksanim(data, path=os.path.join(folder, entry),
                                    load_keys=load_keys, only=only))
        except ParseError:
            # Not a clip, whatever it is called.  A folder copied off a Mac
            # carries an `._name.ksanim` beside every real one, and eleven of
            # the 1,461 files to hand are exactly that.
            continue
    return out


def read_clips(path: str | None, named: set[str]) -> list[dict]:
    """The clips beside a car, each held against the nodes the model has.

    *named* is every node name in the model, as the model spells them.  A clip
    is read for what it says and then checked, rather than believed: a clip
    naming nothing this car has is a clip copied from another car, and one
    naming nothing but ``DRIVER:`` nodes is the driver's rig, which is a
    separate model living inside the game rather than beside the car.  Neither
    is a fault in the file and both are worth saying rather than leaving to
    look like one.

    Across 22 cars and their 123 clips: 48 are nothing but the driver's, 2 name
    nothing this car has, 46 name some of it and 27 name all of it.

    And naming is not moving.  A clip written for one car and dropped beside
    another names some of the same nodes and holds them still, so what lands is
    counted twice over: how many of its nodes this car has, and how many of
    those it takes anywhere.
    """
    out: list[dict] = []
    # Only this car's nodes are decoded.  Two thirds of what a steering clip
    # names belongs to some other model, and its placements are work to throw
    # away.
    for clip in beside(path, load_keys=True, only=named):
        landed = [track for track in clip.tracks if track.name in named]
        out.append({
            "name": clip.name,
            "version": clip.version,
            "nodes": len(clip.tracks),
            "keys": clip.keys,
            "matched": len(landed),
            "moved": sum(1 for track in landed if _moves(track)),
            "driver": clip.driver_only,
        })
    return out
