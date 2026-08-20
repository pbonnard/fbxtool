#!/usr/bin/env python3
"""Count what Assetto Corsa's shaders are actually made of, across a pile of cars.

Every decision in the kn5 reader is settled by a count rather than by a guess —
which value 559 of 2006 materials write, which of them bind ``txGlow`` and what
they are — and a shader table is no different.  This is where those counts come
from::

    python3 tools/shader_census.py ~/Downloads/cars/kn5
    python3 tools/shader_census.py ~/Downloads/cars --json > census.json

What it reports, per shader name: how many materials wear it and across how many
cars, which parameters they state and what those parameters come to, and which
texture slots they bind.  Then the same two tables the other way round, since
"which shaders bind ``txMaps``" is the question a slot table has to answer and
"which shaders read ``fresnelEXP``" is the one a parameter table has to.

Only the file's head is read.  A car is mostly its textures — 111 of the 135 in
one of them are DDS, and the payloads run to eighty megabytes — and none of that
says anything about a shader, so the texture table is stepped over rather than
loaded and the node tree past the materials is never reached at all.
"""

from __future__ import annotations

import argparse
import json
import mmap
import statistics
import sys
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from fbxtool import kn5  # noqa: E402  (needs the path set up first)
from fbxtool.model import ParseError  # noqa: E402

#: Files that are the same car again, less of it.  A car ships its own lower
#: detail levels beside it and they wear the same materials under the same
#: names, so counted they treble every number without adding a fact; a collider
#: is a bare hull with no materials worth the name.  Countable on request, since
#: "does a LOD state the same shaders" is itself a question.
_ASIDES = ("_lod_b", "_lod_c", "_lod_d", "collider")


def _is_aside(path: Path) -> bool:
    stem = path.stem.lower()
    return any(stem == mark or stem.endswith(mark) for mark in _ASIDES)


def _skip_texture_table(cursor: kn5._Cursor) -> int:
    """Step over the texture table without lifting a byte of it.

    Not :func:`kn5._read_textures`, which slices every payload out to carry it:
    that is the right thing when a car is being opened and the wrong thing here,
    where three gigabytes of DDS would be copied to count some strings.  The
    walk is the same one — a kind, a name, a length, the bytes — with the bytes
    stepped past instead of taken.
    """
    count = cursor.i32()
    if count < 0:
        raise ParseError(f"the texture table claims {count} entries")
    seen = 0
    for _ in range(count):
        kind = cursor.i32()
        # A slot of kind nought is an empty one and is the whole of the record.
        if kind == 0:
            continue
        cursor.text()
        cursor.skip(cursor.u32())
        seen += 1
    return seen


def _materials(path: Path) -> list:
    """The material table of one car, and nothing else out of the file."""
    with path.open("rb") as handle:
        with mmap.mmap(handle.fileno(), 0, access=mmap.ACCESS_READ) as data:
            if not kn5.is_kn5(data[:8]):
                raise ParseError('not a kn5 file — it does not begin "sc6969"')
            cursor = kn5._Cursor(data)
            cursor.skip(6)
            version = cursor.i32()
            # From version 6 the header carries one more number, which every
            # file seen writes as zero and nothing reads.
            if version > 5:
                cursor.i32()
            _skip_texture_table(cursor)
            return kn5._read_materials(cursor, None)


def _stated(material) -> dict:
    """What a material says, as one number a name where there is one.

    A kn5 writes every parameter as a float, a pair, a triple and a quad all at
    once, and a material means whichever of those it filled in.  A census wants
    the number: the triple is kept apart only where it is set, since that is how
    ``ksEmissive`` says amber rather than a level.
    """
    out = {}
    for key, (a, _b, c, _d) in material.props.items():
        out[key] = list(c) if any(c) else float(a)
    return out


def _describe(values: list) -> dict:
    """What a parameter comes to across everything that states it."""
    numbers = [v for v in values if isinstance(v, float)]
    common = Counter(round(v, 4) for v in numbers).most_common(4)
    out = {
        "count": len(values),
        "colours": len(values) - len(numbers),
        "common": [[value, hits] for value, hits in common],
    }
    if numbers:
        out["min"] = min(numbers)
        out["median"] = statistics.median(numbers)
        out["max"] = max(numbers)
        # How many say nothing at all with it, which is the number that decides
        # whether a parameter is worth reading: 277 materials state a zero
        # `ksSpecular`, and given a highlight anyway a rubber seal comes up
        # polished.
        out["zero"] = sum(1 for v in numbers if v == 0.0)
    return out


def census(paths: list, lods: bool = False) -> dict:
    """Walk every kn5 under *paths* and count what their materials are made of."""
    files = []
    for entry in paths:
        found = sorted(entry.rglob("*.kn5")) if entry.is_dir() else [entry]
        files.extend(f for f in found if lods or not _is_aside(f))

    shaders: dict = defaultdict(lambda: {
        "materials": 0,
        "cars": set(),
        "props": defaultdict(list),
        "slots": Counter(),
        "blend": Counter(),
        "alphaTested": 0,
    })
    slots_by_shader: dict = defaultdict(Counter)
    props_by_shader: dict = defaultdict(Counter)
    read = []
    failed = []

    for path in files:
        try:
            materials = _materials(path)
        except (ParseError, OSError, ValueError) as error:
            failed.append((str(path), str(error)))
            continue
        read.append(str(path))
        # The car, not the file: a folder holds the model, its LODs and its
        # collider, and they are one car however many of them were counted.
        car = path.parent.name
        for material in materials:
            entry = shaders[material.shader]
            entry["materials"] += 1
            entry["cars"].add(car)
            entry["blend"][material.blend] += 1
            entry["alphaTested"] += 1 if material.alpha_tested else 0
            for key, value in _stated(material).items():
                entry["props"][key].append(value)
                props_by_shader[key][material.shader] += 1
            # A slot bound twice in one material is bound once as far as this is
            # concerned; the file does it, and counted twice it reads as though
            # twice as many materials wore the map.
            for slot in {name for name, _number, texture in material.slots if texture}:
                entry["slots"][slot] += 1
                slots_by_shader[slot][material.shader] += 1

    out = {
        "files": len(read),
        "failed": failed,
        "shaders": {},
        "slots": {slot: dict(hits.most_common()) for slot, hits in
                  sorted(slots_by_shader.items(), key=lambda kv: -sum(kv[1].values()))},
        "props": {key: dict(hits.most_common()) for key, hits in
                  sorted(props_by_shader.items(), key=lambda kv: -sum(kv[1].values()))},
    }
    for name, entry in sorted(shaders.items(), key=lambda kv: -kv[1]["materials"]):
        out["shaders"][name] = {
            "materials": entry["materials"],
            "cars": len(entry["cars"]),
            "alphaTested": entry["alphaTested"],
            "blend": dict(sorted(entry["blend"].items())),
            "slots": dict(entry["slots"].most_common()),
            "props": {key: _describe(values) for key, values in
                      sorted(entry["props"].items(), key=lambda kv: -len(kv[1]))},
        }
    return out


def report(data: dict, least: int) -> str:
    """The same, as something to read."""
    lines = [f"{data['files']} file(s) read, "
             f"{len(data['shaders'])} distinct shader(s)"]
    if data["failed"]:
        lines.append(f"{len(data['failed'])} file(s) refused:")
        for path, why in data["failed"][:10]:
            lines.append(f"  {path}: {why}")

    total = sum(s["materials"] for s in data["shaders"].values())
    lines.append(f"\n{total} material(s) in all\n")
    lines.append("shader                                    materials  cars  slots")
    lines.append("-" * 78)
    for name, entry in data["shaders"].items():
        if entry["materials"] < least:
            continue
        slots = ", ".join(entry["slots"]) or "-"
        lines.append(f"{name[:40]:<40}  {entry['materials']:>9}  {entry['cars']:>4}  {slots}")

    lines.append("\nslot                     bound by")
    lines.append("-" * 78)
    for slot, hits in data["slots"].items():
        worn = sum(hits.values())
        top = ", ".join(f"{name} ({count})" for name, count in list(hits.items())[:3])
        more = f", +{len(hits) - 3}" if len(hits) > 3 else ""
        lines.append(f"{slot:<24} {worn:>5}  {top}{more}")

    lines.append("\nparameter                stated by")
    lines.append("-" * 78)
    for key, hits in data["props"].items():
        said = sum(hits.values())
        lines.append(f"{key:<24} {said:>5}  across {len(hits)} shader(s)")

    lines.append("\nper shader\n" + "=" * 78)
    for name, entry in data["shaders"].items():
        if entry["materials"] < least:
            continue
        lines.append(f"\n{name} - {entry['materials']} material(s), "
                     f"{entry['cars']} car(s), "
                     f"{entry['alphaTested']} alpha tested, "
                     f"blend {entry['blend']}")
        for slot, count in entry["slots"].items():
            lines.append(f"    slot  {slot:<20} {count:>5}")
        for key, stats in entry["props"].items():
            common = " ".join(f"{value}x{hits}" for value, hits in stats["common"])
            spread = (f"min {stats['min']:g} median {stats['median']:g} "
                      f"max {stats['max']:g} zero {stats['zero']}"
                      if "median" in stats else "")
            lines.append(f"    prop  {key:<20} {stats['count']:>5}  {spread}")
            if common:
                lines.append(f"          {'':<20} {'':>5}  commonest {common}")
    return "\n".join(lines)


def main(argv: list | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Count what Assetto Corsa's shaders are made of, across a "
                    "pile of cars.")
    parser.add_argument("paths", metavar="PATH", nargs="+", type=Path,
                        help="a .kn5, or a folder to search for them")
    parser.add_argument("--json", action="store_true",
                        help="emit the counts as JSON instead of a report")
    parser.add_argument("--lods", action="store_true",
                        help="count the lower detail levels and colliders too, "
                             "which otherwise are the same car again")
    parser.add_argument("--min", dest="least", type=int, default=1, metavar="N",
                        help="only detail shaders worn by at least N materials")
    args = parser.parse_args(argv)

    data = census(args.paths, lods=args.lods)
    if not data["files"]:
        print("no .kn5 files found", file=sys.stderr)
        return 1
    if args.json:
        # Sets are not JSON; `cars` was counted on the way out.
        print(json.dumps(data, indent=2))
    else:
        print(report(data, args.least))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
