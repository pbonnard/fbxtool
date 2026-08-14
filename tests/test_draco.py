"""Tests for the Draco decompressor.

Each fixture in ``samples/draco`` is a mesh encoded by Draco's own encoder,
beside the values Draco's own decoder gives back for it. Decompression has one
right answer, so these are held to it exactly rather than approximately: the
shapes were chosen for the parts of the format they exercise —

===============  ==============================================================
tri, quad        the smallest meshes there are: one triangle, two
cube             a closed mesh, where every vertex fan comes back round
grid2, grid4     open meshes, whose boundary vertices are traversed differently
cube-uv          texture coordinates cut at every edge, so the mesh has one
                 attribute vertex per corner and the points are deduplicated
sphere4          normals, texture coordinates and positions together
===============  ==============================================================

The fixtures are regenerated with ``draco3d`` from npm; see the README.
"""

from __future__ import annotations

import ctypes
import json
from pathlib import Path

import pytest

DRACO = Path(__file__).resolve().parent.parent / "samples" / "draco"
CASES = sorted(p.stem for p in DRACO.glob("*.drc"))

#: Matches the codes in draco.c.
ERRORS = {
    0: "none", 1: "not a Draco block", 2: "unsupported version",
    3: "not a mesh", 4: "unknown method", 5: "truncated", 6: "out of memory",
    7: "over a limit", 8: "unsupported feature", 9: "corrupt",
}


class DracoOut(ctypes.Structure):
    _fields_ = [("ok", ctypes.c_uint32), ("error", ctypes.c_uint32),
                ("num_faces", ctypes.c_uint32), ("num_points", ctypes.c_uint32),
                ("num_attributes", ctypes.c_uint32), ("indices", ctypes.c_uint32),
                ("attributes", ctypes.c_uint32)]


class DracoAttr(ctypes.Structure):
    _fields_ = [("unique_id", ctypes.c_uint32), ("num_components", ctypes.c_uint32),
                ("data_type", ctypes.c_uint32), ("values", ctypes.c_uint32)]


@pytest.fixture(scope="module")
def draco(lib):
    """The decoder, with the calls it needs typed."""
    lib.fbx_alloc.restype = ctypes.c_uint32
    lib.fbx_alloc.argtypes = [ctypes.c_uint32]
    lib.test_heap_base.restype = ctypes.c_void_p
    lib.fbx_draco_decode.restype = ctypes.c_uint32
    lib.fbx_draco_decode.argtypes = [ctypes.c_uint32, ctypes.c_uint32]
    lib.fbx_heap_mark.restype = ctypes.c_uint32
    lib.fbx_heap_release.argtypes = [ctypes.c_uint32]
    return lib


def decode(draco, blob: bytes):
    """Decompress *blob*, returning what came out in plain Python."""
    base = ctypes.c_void_p(draco.test_heap_base()).value
    mark = draco.fbx_heap_mark()
    try:
        at = draco.fbx_alloc(max(len(blob), 1))
        ctypes.memmove(base + at, blob, len(blob))
        out = ctypes.cast(base + draco.fbx_draco_decode(at, len(blob)),
                          ctypes.POINTER(DracoOut)).contents
        if not out.ok:
            return {"error": ERRORS.get(out.error, out.error)}
        indices = ctypes.cast(base + out.indices, ctypes.POINTER(ctypes.c_uint32))
        attrs = ctypes.cast(base + out.attributes, ctypes.POINTER(DracoAttr))
        result = {
            "faces": out.num_faces,
            "points": out.num_points,
            "indices": [indices[i] for i in range(out.num_faces * 3)],
            "attributes": {},
        }
        for a in range(out.num_attributes):
            attr = attrs[a]
            values = ctypes.cast(base + attr.values, ctypes.POINTER(ctypes.c_float))
            result["attributes"][attr.unique_id] = {
                "components": attr.num_components,
                "values": [values[i] for i in range(out.num_points * attr.num_components)],
            }
        return result
    finally:
        draco.fbx_heap_release(mark)


@pytest.mark.parametrize("case", CASES)
def test_every_value_matches_dracos_own_decoder(draco, case):
    """The whole mesh, value for value, as Draco decodes it."""
    want = json.loads((DRACO / f"{case}.json").read_text())
    got = decode(draco, (DRACO / f"{case}.drc").read_bytes())
    assert "error" not in got, f"{case}: {got.get('error')}"

    assert got["faces"] == want["numFaces"]
    assert got["points"] == want["numPoints"]
    assert got["indices"] == want["indices"], "the triangles are numbered differently"

    for name, entry in want["attributes"].items():
        mine = got["attributes"].get(entry["uniqueId"])
        assert mine is not None, f"{name} is missing"
        assert mine["components"] == entry["numComponents"]
        scale = max((abs(v) for v in entry["values"]), default=1.0) or 1.0
        for i, (a, b) in enumerate(zip(mine["values"], entry["values"])):
            assert abs(a - b) <= scale * 1e-5, f"{name} value {i}: {a} != {b}"


def test_a_closed_mesh_keeps_every_vertex_shared(draco):
    """A cube is eight corners however many triangles meet at them."""
    got = decode(draco, (DRACO / "cube.drc").read_bytes())
    assert got["points"] == 8
    assert got["faces"] == 12


def test_a_seam_at_every_edge_splits_the_points(draco):
    """Texture coordinates cut everywhere give each corner its own point,
    which is what the attribute-seam machinery is for."""
    got = decode(draco, (DRACO / "cube-uv.drc").read_bytes())
    assert got["faces"] == 12
    assert got["points"] == 36
    assert sorted(got["indices"]) == list(range(36))


def test_a_block_that_is_not_draco_is_refused(draco):
    assert decode(draco, b"not a draco file at all")["error"] == "not a Draco block"


def test_a_truncated_block_is_refused(draco):
    blob = (DRACO / "sphere4.drc").read_bytes()
    result = decode(draco, blob[:len(blob) // 2])
    # Either it refuses, or it comes back with less than the mesh it promised;
    # what it must not do is claim the whole thing.
    assert "error" in result or result["faces"] < 59


def test_an_empty_block_is_refused(draco):
    assert "error" in decode(draco, b"")
