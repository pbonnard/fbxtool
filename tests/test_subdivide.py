"""Catmull-Clark subdivision, checked against hand-worked values.

The C core is compiled natively (as ``test_wasm_core`` does) and driven through
its own heap, so the maths is checked without a browser in the way.
"""

from __future__ import annotations

import ctypes
import struct

import pytest

import fbxbuild as fb

# Field order of SubdivParams and SubdivOut in web/src/fbx.c.
PARAMS = ["pos_off", "pos_count", "idx_off", "idx_count",
          "nrm_off", "nrm_count", "nrm_index_off", "nrm_index_count",
          "nrm_mapping", "nrm_reference",
          "uv_off", "uv_count", "uv_index_off", "uv_index_count",
          "uv_mapping", "uv_reference",
          "mat_off", "mat_count", "smooth_off", "smooth_count", "levels"]
OUT = ["pos_off", "pos_count", "idx_off", "idx_count", "nrm_off", "nrm_count",
       "uv_off", "uv_count", "mat_off", "mat_count", "smooth_off", "smooth_count",
       "polygon_count", "levels_done"]

MAP_BY_POLYGON_VERTEX = 1


class Heap:
    """Somewhere to put arrays the core can reach, and read them back."""

    def __init__(self, lib) -> None:
        self.lib = lib
        lib.fbx_reset()
        lib.test_heap_base.restype = ctypes.c_void_p
        lib.fbx_alloc.restype = ctypes.c_uint32
        lib.fbx_alloc.argtypes = [ctypes.c_uint32]
        lib.fbx_subdivide.restype = ctypes.c_uint32
        lib.fbx_subdivide.argtypes = [ctypes.c_uint32]
        self.base = lib.test_heap_base()

    def put(self, fmt: str, values) -> int:
        data = struct.pack(f"<{len(values)}{fmt}", *values)
        offset = self.lib.fbx_alloc(len(data) + 8)
        ctypes.memmove(self.base + offset, data, len(data))
        return offset

    def get(self, fmt: str, offset: int, count: int):
        size = struct.calcsize(f"<{count}{fmt}")
        buffer = (ctypes.c_char * size).from_address(self.base + offset)
        return struct.unpack(f"<{count}{fmt}", buffer.raw)

    def subdivide(self, positions, indices, *, levels=1, materials=(0,),
                  normals=None, uvs=None, smoothing=None) -> dict:
        values = dict.fromkeys(PARAMS, 0)
        values["pos_off"] = self.put("d", positions)
        values["pos_count"] = len(positions)
        values["idx_off"] = self.put("i", indices)
        values["idx_count"] = len(indices)
        values["mat_off"] = self.put("i", materials)
        values["mat_count"] = len(materials)
        if normals is not None:
            values["nrm_off"] = self.put("d", normals)
            values["nrm_count"] = len(normals)
            values["nrm_mapping"] = MAP_BY_POLYGON_VERTEX
        if uvs is not None:
            values["uv_off"] = self.put("d", uvs)
            values["uv_count"] = len(uvs)
            values["uv_mapping"] = MAP_BY_POLYGON_VERTEX
        if smoothing is not None:
            values["smooth_off"] = self.put("i", smoothing)
            values["smooth_count"] = len(smoothing)
        values["levels"] = levels

        block = self.put("I", [values[name] for name in PARAMS])
        result = self.lib.fbx_subdivide(block)
        assert result, "subdivision reported failure"
        out = dict(zip(OUT, self.get("I", result, len(OUT))))
        out["positions"] = self.get("d", out["pos_off"], out["pos_count"])
        out["indices"] = self.get("i", out["idx_off"], out["idx_count"])
        out["materials"] = self.get("i", out["mat_off"], out["mat_count"])
        if out["nrm_count"]:
            out["normals"] = self.get("d", out["nrm_off"], out["nrm_count"])
        if out["uv_count"]:
            out["uvs"] = self.get("d", out["uv_off"], out["uv_count"])
        if out["smooth_count"]:
            out["smoothing"] = self.get("I", out["smooth_off"], out["smooth_count"])
        return out


@pytest.fixture
def heap(lib) -> Heap:
    return Heap(lib)


def polygons_of(indices) -> list[list[int]]:
    """Split an FBX index run back into polygons."""
    out, current = [], []
    for value in indices:
        current.append(~value if value < 0 else value)
        if value < 0:
            out.append(current)
            current = []
    return out


#: A cube of quads: the shape a subdivision cage usually starts from.
CUBE_QUADS = [
    0, 1, 3, ~2,     # +z
    2, 3, 5, ~4,     # +y
    4, 5, 7, ~6,     # -z
    6, 7, 1, ~0,     # -y
    1, 7, 5, ~3,     # +x
    6, 0, 2, ~4,     # -x
]


def test_one_round_of_a_cube(heap):
    """Six quads become twenty-four, and every point lands where it should."""
    out = heap.subdivide(fb.CUBE_VERTICES, CUBE_QUADS)
    assert out["levels_done"] == 1

    # 8 original corners + 12 edge points + 6 face points.
    assert out["pos_count"] // 3 == 26
    # One quad per corner of the cage, four corners each.
    assert out["polygon_count"] == 24
    assert out["idx_count"] == 96
    quads = polygons_of(out["indices"])
    assert len(quads) == 24
    assert all(len(q) == 4 for q in quads)
    assert max(max(q) for q in quads) == 25

    points = [tuple(out["positions"][i * 3:i * 3 + 3]) for i in range(26)]
    # A cube corner has three faces and three edges on it, so it is drawn in
    # to (F + 2R) / 3 — 5/9 of the way out for a cube of side two.
    for corner in points[:8]:
        assert sorted(abs(v) for v in corner) == pytest.approx([5 / 9] * 3)
    # Face points stay at the middle of each face, so the box does not shrink.
    box = max(max(abs(v) for v in p) for p in points)
    assert box == pytest.approx(1.0)
    # An edge point sits three quarters of the way out along its two axes.
    edges = [p for p in points[8:20]]
    for point in edges:
        magnitudes = sorted(abs(v) for v in point)
        assert magnitudes == pytest.approx([0.0, 0.75, 0.75])
    # Nothing moves the centre of a symmetrical shape.
    for axis in range(3):
        assert sum(p[axis] for p in points) == pytest.approx(0.0, abs=1e-12)


def test_two_rounds_multiply_again(heap):
    """Each round turns every corner into a quad, so the counts are exact."""
    once = heap.subdivide(fb.CUBE_VERTICES, CUBE_QUADS, levels=1)
    twice = heap.subdivide(fb.CUBE_VERTICES, CUBE_QUADS, levels=2)
    assert twice["levels_done"] == 2
    assert twice["polygon_count"] == once["idx_count"] == 96
    # 26 vertices + 48 edges + 24 faces.
    assert twice["pos_count"] // 3 == 98
    assert twice["idx_count"] == 384


def test_a_triangle_becomes_three_quads(heap):
    """Catmull-Clark is a quad scheme: an n-gon gives n quads, whatever n is."""
    positions = [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0]
    out = heap.subdivide(positions, [0, 1, ~2])
    assert out["polygon_count"] == 3
    assert all(len(q) == 4 for q in polygons_of(out["indices"]))
    # 3 corners + 3 edge points + 1 face point.
    assert out["pos_count"] // 3 == 7


def test_an_open_border_follows_its_own_curve(heap):
    """A border is smoothed as a curve, and only by what is on the border.

    Every vertex of a lone quad is on the border, so each is pulled an eighth
    of the way towards each of its two neighbours — (0,0) with neighbours at
    (2,0) and (0,2) lands at (0.25, 0.25). The surface inside plays no part,
    which is what keeps two meshes that share an edge from parting company.
    """
    positions = [0.0, 0.0, 0.0, 2.0, 0.0, 0.0, 2.0, 2.0, 0.0, 0.0, 2.0, 0.0]
    out = heap.subdivide(positions, [0, 1, 2, ~3])
    points = [tuple(out["positions"][i * 3:i * 3 + 3]) for i in range(out["pos_count"] // 3)]

    assert points[0] == pytest.approx((0.25, 0.25, 0.0))
    assert points[2] == pytest.approx((1.75, 1.75, 0.0))
    # Border edge points stay at the midpoints, so the sheet still reaches 0..2.
    assert max(p[0] for p in points) == pytest.approx(2.0)
    assert min(p[0] for p in points) == pytest.approx(0.0)
    # And a flat sheet stays flat.
    assert all(p[2] == pytest.approx(0.0) for p in points)


def test_several_borders_meeting_at_a_point(heap):
    """Two quads joined at one corner — which real car parts are full of.

    That corner sits on four border edges, not the two the border rule is
    written for. Summing all four instead of averaging them throws the point
    away from the mesh: one part of a Smart Brabus grew nearly four times
    across before this was handled.
    """
    positions = [
        0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0, 0.0,
        2.0, 1.0, 0.0, 2.0, 2.0, 0.0, 1.0, 2.0, 0.0,
    ]
    # The second quad hangs off vertex 2, sharing nothing else.
    out = heap.subdivide(positions, [0, 1, 2, ~3, 2, 4, 5, ~6])
    points = [tuple(out["positions"][i * 3:i * 3 + 3])
              for i in range(out["pos_count"] // 3)]

    shared = points[2]
    assert shared == pytest.approx((1.0, 1.0, 0.0)), "the shared corner should stay put"
    for axis in range(3):
        lowest = min(positions[axis::3])
        highest = max(positions[axis::3])
        assert min(p[axis] for p in points) >= lowest - 1e-9
        assert max(p[axis] for p in points) <= highest + 1e-9


@pytest.mark.parametrize("name,positions,indices", [
    ("cube", fb.CUBE_VERTICES, CUBE_QUADS),
    ("triangle", [0.0, 0.0, 0.0, 3.0, 0.0, 0.0, 0.0, 4.0, 0.0], [0, 1, ~2]),
    ("quad", [0.0, 0.0, 0.0, 2.0, 0.0, 0.0, 2.0, 2.0, 0.0, 0.0, 2.0, 0.0], [0, 1, 2, ~3]),
])
def test_nothing_lands_outside_the_cage(heap, name, positions, indices):
    """Every point of a subdivided mesh is a weighted average of cage points,
    all the weights positive — so nothing can end up beyond the cage's box."""
    out = heap.subdivide(positions, indices, levels=2)
    points = [tuple(out["positions"][i * 3:i * 3 + 3])
              for i in range(out["pos_count"] // 3)]
    for axis in range(3):
        lowest = min(positions[axis::3])
        highest = max(positions[axis::3])
        assert min(p[axis] for p in points) >= lowest - 1e-9, f"{name} spilled below"
        assert max(p[axis] for p in points) <= highest + 1e-9, f"{name} spilled above"


def test_materials_follow_their_polygon(heap):
    """Each new quad belongs to the material of the polygon it came from."""
    out = heap.subdivide(fb.CUBE_VERTICES, CUBE_QUADS,
                         materials=[0, 1, 2, 3, 4, 5])
    assert out["mat_count"] == 24
    # Four quads per face, in face order.
    assert list(out["materials"]) == [f for f in range(6) for _ in range(4)]

    # A file that says AllSame writes one value for the whole mesh.
    same = heap.subdivide(fb.CUBE_VERTICES, CUBE_QUADS, materials=[7])
    assert set(same["materials"]) == {7}


def test_corner_data_is_carried_across(heap):
    """Normals and UVs are subdivided linearly, which keeps seams where they are."""
    # One quad, with a UV per corner and a constant normal.
    positions = [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0, 0.0]
    uvs = [0.0, 0.0, 1.0, 0.0, 1.0, 1.0, 0.0, 1.0]
    normals = [0.0, 0.0, 1.0] * 4
    out = heap.subdivide(positions, [0, 1, 2, ~3], uvs=uvs, normals=normals)

    assert out["uv_count"] == out["idx_count"] * 2
    assert out["nrm_count"] == out["idx_count"] * 3
    # The first new quad runs corner -> edge -> centre -> edge.
    assert list(out["uvs"][:8]) == pytest.approx([0.0, 0.0, 0.5, 0.0, 0.5, 0.5, 0.0, 0.5])
    # A constant normal stays constant everywhere.
    assert all(v == pytest.approx(n) for v, n in
               zip(out["normals"], [0.0, 0.0, 1.0] * (out["nrm_count"] // 3)))


def test_zero_levels_is_a_pass_through(heap):
    out = heap.subdivide(fb.CUBE_VERTICES, CUBE_QUADS, levels=0)
    assert out["levels_done"] == 0
    assert out["pos_count"] == len(fb.CUBE_VERTICES)
    assert list(out["indices"]) == CUBE_QUADS


def test_an_empty_mesh_is_refused_quietly(heap):
    out = heap.subdivide([], [], levels=1)
    assert out["pos_count"] == 0
    assert out["polygon_count"] == 0


def test_smoothing_groups_follow_their_polygon(heap):
    """Each quad a face becomes is still part of that face, so it keeps the
    groups that say which of its edges are hard.  Losing them between rounds
    would leave a subdivided cage with nothing to shade by but its facets."""
    # A quad and a triangle, in groups 1 and 4.
    positions = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 2, 0, 0]
    indices = [0, 1, 2, ~3, 1, 4, ~2]
    out = heap.subdivide(positions, indices, levels=1, materials=[0, 0],
                         smoothing=[1, 4])
    assert out["smooth_count"] == out["polygon_count"]
    # Four quads out of the quad, three out of the triangle.
    assert list(out["smoothing"]) == [1, 1, 1, 1, 4, 4, 4]


def test_a_second_round_keeps_them(heap):
    positions = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]
    out = heap.subdivide(positions, [0, 1, 2, ~3], levels=2, smoothing=[9])
    assert set(out["smoothing"]) == {9}
    assert out["smooth_count"] == out["polygon_count"] == 16


def test_a_cage_with_no_groups_gets_none(heap):
    positions = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]
    out = heap.subdivide(positions, [0, 1, 2, ~3], levels=1)
    assert out["smooth_count"] == 0
