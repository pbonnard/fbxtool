"""Tests for the Assetto Corsa ``.ksanim`` reader.

A clip has no magic number and no lengths above the node level: a version, a
count, and then names and rows of placements written one after another.  So a
reader that mis-sizes one key walks off the rest of the file — and, since
nothing marks the end, walks off it *quietly*.  That is what most of these are
really checking.
"""

from __future__ import annotations

import math
import struct
from pathlib import Path

import pytest

import fbxbuild as fb
from fbxtool import analyze, kn5, ksanim
from fbxtool.model import ParseError
from fbxtool.report import render_text

NL = chr(10)

IDENTITY = (1.0, 0.0, 0.0, 0.0,
            0.0, 1.0, 0.0, 0.0,
            0.0, 0.0, 1.0, 0.0,
            0.0, 0.0, 0.0, 1.0)

#: An identity key in the version 2 spelling: no turn, no move, no scale.
STILL = ((0.0, 0.0, 0.0, 1.0), (0.0, 0.0, 0.0), (1.0, 1.0, 1.0))

#: And the same node a metre further up, so a row of keys goes somewhere.
MOVED = ((0.0, 0.0, 0.0, 1.0), (0.0, 1.0, 0.0), (1.0, 1.0, 1.0))


def test_a_clip_is_read_to_its_last_byte():
    """Nothing in the file says how long it is, so landing exactly on the end
    is the only evidence a clip was sized correctly all the way through."""
    data = fb.ksanim([("door", [STILL] * 3), ("handle", [STILL] * 7)])
    clip = ksanim.parse_ksanim(data, path="car_door_L.ksanim")

    assert clip.version == 2
    assert clip.name == "car_door_L"
    assert [(track.name, track.keys) for track in clip.tracks] == [
        ("door", 3), ("handle", 7)]
    assert ksanim.is_ksanim(data)


def test_a_clip_with_anything_left_over_is_not_one():
    """The check that does the work.  A file whose keys are the wrong size
    still reads a plausible name and a plausible count and then stops in the
    wrong place, and only the leftover says so."""
    data = fb.ksanim([("door", [STILL] * 3)])

    assert not ksanim.is_ksanim(data + b"\x00")
    assert not ksanim.is_ksanim(data[:-1])
    with pytest.raises(ParseError, match="left over"):
        ksanim.parse_ksanim(data + b"tail")


def test_the_resource_forks_a_mac_leaves_beside_a_clip_are_refused():
    """Eleven of the 1,461 clips in the cars to hand are not clips: a folder
    zipped on a Mac carries an ``._name.ksanim`` beside every real one, and
    read as a clip the first one asks for half a gigabyte of nodes."""
    fork = b"\x00\x05\x16\x07" + b"\x00\x02" + bytes(181)

    assert not ksanim.is_ksanim(fork)
    assert not ksanim.is_ksanim(b"")
    assert not ksanim.is_ksanim(b"just some text, honestly")


def test_a_version_this_does_not_read_is_said_rather_than_guessed():
    """Two are in circulation and both are read.  A third would have a key
    size nobody here knows, and guessing one walks off the file."""
    data = bytearray(fb.ksanim([("door", [STILL])]))
    data[0] = 3

    with pytest.raises(ParseError, match="version 3"):
        ksanim.parse_ksanim(bytes(data))


def test_both_spellings_of_a_key_come_out_the_same_sixteen_numbers():
    """Version 1 writes a 4x4 and version 2 writes a quaternion, a translation
    and a scale.  They are the same statement, and a caller should not have to
    know which one it was handed."""
    quarter = math.sqrt(0.5)
    turned = fb.ksanim([("door", [((0.0, quarter, 0.0, quarter),
                                   (1.0, 2.0, 3.0), (1.0, 1.0, 1.0))])])
    # The same quarter turn about +Y, written out in full: the translation in
    # the last row, which is where a `.kn5` node writes it too.
    same = fb.ksanim([("door", [(0.0, 0.0, -1.0, 0.0,
                                 0.0, 1.0, 0.0, 0.0,
                                 1.0, 0.0, 0.0, 0.0,
                                 1.0, 2.0, 3.0, 1.0)])], version=1)

    a = ksanim.parse_ksanim(turned, load_keys=True).tracks[0].matrices[0]
    b = ksanim.parse_ksanim(same, load_keys=True).tracks[0].matrices[0]

    assert [round(v, 6) for v in a] == [round(v, 6) for v in b]


def test_a_quaternion_that_is_not_unit_length_turns_without_growing():
    """Four floats interpolated by whatever wrote them do not always arrive at
    unit length, and a rotation built from one that is not scales the node as
    well as turning it."""
    data = fb.ksanim([("door", [((0.0, 0.0, 0.0, 2.0),
                                 (0.0, 0.0, 0.0), (1.0, 1.0, 1.0))])])
    matrix = ksanim.parse_ksanim(data, load_keys=True).tracks[0].matrices[0]

    _, _, scale = kn5._placement(matrix)
    assert [round(v, 6) for v in scale] == [1.0, 1.0, 1.0]


def test_a_key_is_the_whole_of_a_node_s_placement():
    """Not a change to it.  A BMW Z3's soft top opens on the translation, the
    rotation and the scale its own model states for the same node, so playing
    a clip replaces a placement rather than composing with it — and read the
    other way round the first key would move a car that is not moving."""
    scale = (0.909, 0.909, 0.909)
    data = fb.ksanim([("capote", [((0.0, 0.0, 0.0, 1.0),
                                   (0.008, 0.8766, -0.2755), scale)])])
    matrix = ksanim.parse_ksanim(data, load_keys=True).tracks[0].matrices[0]

    translation, rotation, scaling = kn5._placement(matrix)
    assert [round(v, 4) for v in translation] == [0.008, 0.8766, -0.2755]
    assert [round(v, 4) for v in rotation] == [0.0, 0.0, 0.0]
    assert [round(v, 3) for v in scaling] == [0.909, 0.909, 0.909]


def test_the_shape_of_a_clip_is_read_without_its_keys():
    """A steering clip is 270 nodes of up to 200 keys, and a report that only
    wants to say so should not pay for 432,000 numbers to find out."""
    data = fb.ksanim([("wheel", [STILL] * 100)])

    shape = ksanim.parse_ksanim(data)
    assert shape.tracks[0].keys == 100
    assert shape.tracks[0].matrices is None

    full = ksanim.parse_ksanim(data, load_keys=True)
    assert len(full.tracks[0].matrices) == 100


def test_a_clip_is_as_long_as_its_longest_node():
    """Every clip to hand gives its nodes the same number of keys, except that
    seven of a BMW Z3 steering clip's 270 nodes have 200 where the other 263
    have 100.  Nothing in the format requires them to agree."""
    data = fb.ksanim([("hub", [STILL] * 100), ("needle", [STILL] * 200)])

    assert ksanim.parse_ksanim(data).keys == 200


# ------------------------------------------------- held against the car

def _car(tmp_path: Path, nodes: list[str]) -> Path:
    """A car of one mesh under however many named dummies."""
    material = fb.kn5_material("body", "ksPerPixel")
    vertices, indices = fb.kn5_cube(1.0)
    tree = fb.kn5_mesh("body", vertices, indices)
    for name in reversed(nodes):
        tree = fb.kn5_dummy(name, IDENTITY, tree, 1)
    car = tmp_path / "car.kn5"
    car.write_bytes(fb.build_kn5(6, textures=[], materials=[material],
                                 tree=fb.kn5_dummy("car", IDENTITY, tree, 1)))
    return car


def test_the_clips_beside_a_car_are_held_against_the_nodes_it_has(tmp_path):
    """A clip is read for what it says and then checked, rather than believed.

    Of 123 clips across 22 cars: 48 name nothing but the driver's rig, which is
    a separate model living inside the game rather than beside the car; 2 name
    nothing this car has, which is a clip copied from another car; 46 name some
    of it and 27 name all of it.
    """
    car = _car(tmp_path, ["capote", "wheel"])
    folder = tmp_path / "animations"
    folder.mkdir()
    (folder / "capote.ksanim").write_bytes(
        fb.ksanim([("capote", [STILL, MOVED])]))
    (folder / "steer.ksanim").write_bytes(
        fb.ksanim([("wheel", [STILL, MOVED]), ("someone_elses_needle", [STILL])]))
    (folder / "gas.ksanim").write_bytes(
        fb.ksanim([("DRIVER:RIG_Center", [STILL]), ("DRIVER:DRIVER", [STILL])]))
    (folder / "lights.ksanim").write_bytes(fb.ksanim([("Frunk", [STILL, MOVED])]))

    clips = {clip["name"]: clip
             for clip in kn5.parse_kn5(car.read_bytes(), path=str(car))
             .extra["animation_clips"]}

    assert clips["capote"]["matched"] == 1 and clips["capote"]["moved"] == 1
    assert clips["steer"]["matched"] == 1 and clips["steer"]["nodes"] == 2
    # The driver's own rig: sound, and nothing to do with this model.
    assert clips["gas"]["matched"] == 0 and clips["gas"]["driver"]
    # And a clip copied from another car, which is not the same thing.
    assert clips["lights"]["matched"] == 0 and not clips["lights"]["driver"]


def test_a_clip_that_names_this_car_and_moves_none_of_it_is_said_so(tmp_path):
    """The third kind, and the one a count of matches hides.

    A BMW Z3's ``steer.ksanim`` names 270 nodes and 13 of them are on the car —
    which reads like the best clip in the folder, and is not.  Every one of
    those 13 is the same placement in all 100 of its keys: the turning is in
    the 257 nodes belonging to the BMW M Coupe the clip was authored against.
    Offered on its matches it would be a slider that does nothing.
    """
    car = _car(tmp_path, ["wheel", "capote"])
    folder = tmp_path / "animations"
    folder.mkdir()
    (folder / "steer.ksanim").write_bytes(fb.ksanim([
        ("wheel", [STILL] * 100),                    # here, and held still
        ("someone_elses_needle", [STILL, MOVED])]))  # the moving is over there
    (folder / "capote.ksanim").write_bytes(fb.ksanim([("capote", [STILL, MOVED])]))

    doc = kn5.parse_kn5((tmp_path / "car.kn5").read_bytes(), path=str(car))
    clips = {clip["name"]: clip for clip in doc.extra["animation_clips"]}

    assert clips["steer"]["matched"] == 1
    assert clips["steer"]["moved"] == 0
    line = next(l for l in render_text(analyze(doc)).split(NL) if "Animations:" in l)
    # And the one that does move something is what the report leads with,
    # however many more nodes the other one names.
    assert "capote moves 1 of this car's nodes" in line
    assert "1 naming nodes here and moving none of them" in line


def test_a_file_in_the_animations_folder_that_is_not_a_clip_is_stepped_over(tmp_path):
    """One unreadable file beside a car is not a reason to report none of the
    others: the folder is what a mod pack was unzipped into."""
    car = _car(tmp_path, ["capote"])
    folder = tmp_path / "animations"
    folder.mkdir()
    (folder / "capote.ksanim").write_bytes(fb.ksanim([("capote", [STILL])]))
    (folder / "._capote.ksanim").write_bytes(b"\x00\x05\x16\x07" + bytes(120))
    (folder / "readme.txt").write_text("not a clip", encoding="utf-8")

    clips = kn5.parse_kn5(car.read_bytes(), path=str(car)).extra["animation_clips"]

    assert [clip["name"] for clip in clips] == ["capote"]


def test_a_car_with_no_animations_beside_it_says_nothing_about_them(tmp_path):
    """The commonest case, and it must not read as an empty folder found."""
    car = _car(tmp_path, ["capote"])
    doc = kn5.parse_kn5(car.read_bytes(), path=str(car))

    assert doc.extra["animation_clips"] == []
    assert "Animations" not in render_text(analyze(doc))


def test_what_lands_on_the_car_is_what_the_report_leads_with(tmp_path):
    """A count alone says a folder was found.  What is worth reading is which
    clip moves this car and how much of it — and, for the ones that move none
    of it, which of the two reasons it is."""
    car = _car(tmp_path, ["capote", "wheel"])
    folder = tmp_path / "animations"
    folder.mkdir()
    (folder / "steer.ksanim").write_bytes(fb.ksanim([
        ("wheel", [STILL] * 99 + [MOVED]), ("capote", [STILL] * 99 + [MOVED])]))
    (folder / "gas.ksanim").write_bytes(fb.ksanim([("DRIVER:DRIVER", [STILL])]))
    (folder / "lights.ksanim").write_bytes(fb.ksanim([("Frunk", [STILL, MOVED])]))

    text = render_text(analyze(kn5.parse_kn5(car.read_bytes(), path=str(car))))
    line = next(l for l in text.split(NL) if "Animations:" in l)

    assert "3 beside the file" in line
    assert "steer moves 2 of this car's nodes over 100 key(s)" in line
    assert "1 the driver's rig" in line
    assert "1 naming nothing this car has" in line
