"""3ds Max scenes: the container, the chunk tree and the geometry inside it.

The fixture is written by ``fbxbuild.build_max`` — a compound file assembled
byte by byte — so these run against a file this project produced from its own
understanding of the format, and the reader has to agree with it rather than
with itself.
"""

from __future__ import annotations

import struct

import pytest

import fbxbuild as fb
from fbxtool import read_fbx
from fbxtool.maxfile import is_compound, is_max, parse_max, version_text
from fbxtool.model import ParseError
from fbxtool.reader import detect_format, parse_bytes
from fbxtool.report import render_text
from fbxtool.analyze import analyze


def _geometry(doc):
    objects = next(n for n in doc.root.children if n.name == "Objects")
    return [n for n in objects.children if n.name == "Geometry"]


def test_a_max_is_recognised():
    data = fb.build_max()
    assert is_compound(data[:512])
    assert is_max(data)
    assert detect_format(data[:8192]) == "max"


def test_another_compound_file_is_not_a_max():
    """The magic is shared with .doc and .xls; the streams are what differ."""
    data = bytearray(fb.build_max())
    # Rename the Scene stream, leaving a compound file that is not a scene.
    at = data.find("Scene".encode("utf-16-le"))
    assert at > 0
    data[at:at + 10] = "Sheet".encode("utf-16-le")
    assert is_compound(bytes(data))
    assert not is_max(bytes(data))
    with pytest.raises(ParseError):
        parse_max(bytes(data))


def test_the_cube_comes_out_whole():
    doc = parse_max(fb.build_max(), load_arrays=True)
    geometry = _geometry(doc)
    assert len(geometry) == 1
    vertices = geometry[0].get("Vertices").props[0].value
    assert len(vertices) == 24
    assert min(vertices) == -1.0 and max(vertices) == 1.0

    polygons = geometry[0].get("PolygonVertexIndex").props[0].value
    assert len(polygons) == 24                      # six quads
    # Every fourth index closes its polygon, and a run closes with a negation.
    assert all(polygons[i] < 0 for i in range(3, len(polygons), 4))
    assert all(polygons[i] >= 0 for i in range(len(polygons)) if i % 4 != 3)
    assert sorted({~v if v < 0 else v for v in polygons}) == list(range(8))


def test_the_map_channel_becomes_uvs():
    doc = parse_max(fb.build_max(with_uvs=True), load_arrays=True)
    layer = _geometry(doc)[0].get("LayerElementUV")
    assert layer is not None
    assert layer.get("MappingInformationType").props[0].value == "ByPolygonVertex"
    assert len(layer.get("UV").props[0].value) == 12          # four points
    assert len(layer.get("UVIndex").props[0].value) == 24     # one per corner

    plain = parse_max(fb.build_max(with_uvs=False), load_arrays=True)
    assert _geometry(plain)[0].get("LayerElementUV") is None


def test_the_node_gives_the_mesh_its_name():
    doc = parse_max(fb.build_max(name="wheel_fl"), load_arrays=True)
    objects = next(n for n in doc.root.children if n.name == "Objects")
    names = [n.props[1].value for n in objects.children]
    assert any(name.startswith("wheel_fl") for name in names)
    assert doc.extra["nodes"] == 1 and doc.extra["placed"] == 1


def test_a_scene_is_read_as_z_up():
    """3ds Max is Z up, and nothing in the geometry says so on its own."""
    info = analyze(parse_max(fb.build_max()))
    assert info.global_settings.get("up_axis") == "+Z"


def test_the_version_stamp_says_which_max_wrote_it():
    doc = parse_max(fb.build_max(build=(20 * 1000) << 16 | 966))
    assert doc.extra["build"] == 0x4E2003C6
    assert version_text(doc.extra["build"]) == "20.0 (3ds Max 2018), build 966"
    assert version_text((24 * 1000) << 16 | 12) == "24.0 (3ds Max 2022), build 12"
    assert version_text(None) == "unknown"


def test_the_class_table_and_the_plugins_are_read():
    doc = parse_max(fb.build_max())
    names = [c["name"] for c in doc.extra["classes"]]
    assert names == ["Editable Poly", "Node"]
    assert doc.extra["dlls"][0]["file"] == "epoly.dlo"


def test_every_texture_the_scene_names_is_listed_with_where_it_lived():
    """The paths are a modeller's own directories, and worth reporting."""
    assets = parse_max(fb.build_max()).extra["assets"]
    assert assets == [{"kind": "Bitmap", "name": "paint.jpg",
                       "path": "C:\\models\\paint.jpg"}]


def test_an_ngon_keeps_every_corner():
    """A face past four corners carries its triangulation, which is what makes
    the record variable length: read that size wrong and the next face is read
    out of the middle of this one."""
    data = fb.build_max()
    doc = parse_max(data, load_arrays=True)
    before = doc.extra["faces"]

    # A pentagon and a triangle, to move the following faces off alignment.
    faces = struct.pack("<I", 3) + b"".join([
        fb._max_face([0, 1, 2, 3, 4]),
        fb._max_face([5, 6, 7]),
        fb._max_face([0, 4, 7, 5]),
    ])
    mesh = (fb._max_chunk(0x0100, _cube_points())
            + fb._max_chunk(0x011A, faces))
    scene = fb._max_wide_chunk(0x2023,
                               fb._max_chunk(0x0000,
                                             fb._max_chunk(0x08FE, mesh, container=True),
                                             container=True)
                               + fb._max_chunk(0x0001,
                                               fb._max_chunk(0x2035,
                                                             struct.pack("<3I", 0x10, 1, 0))
                                               + fb._max_chunk(0x0962,
                                                               fb._max_utf16("ngon")),
                                               container=True))
    mixed = fb._max_compound({
        "Scene": scene,
        "ClassDirectory3": (fb._max_class("Editable Poly", 0x10, 0x1BF8338D)
                            + fb._max_class("Node", 0x01, 0x01)),
    })
    doc = parse_max(mixed, load_arrays=True)
    assert doc.warnings == []
    assert doc.extra["faces"] == 3 and before == 6
    polygons = _geometry(doc)[0].get("PolygonVertexIndex").props[0].value
    assert len(polygons) == 5 + 3 + 4
    assert polygons[:5] == [0, 1, 2, 3, -5]
    assert polygons[5:8] == [5, 6, -8]


def _cube_points() -> bytes:
    points = [(-1, -1, -1), (1, -1, -1), (1, 1, -1), (-1, 1, -1),
              (-1, -1, 1), (1, -1, 1), (1, 1, 1), (-1, 1, 1)]
    out = struct.pack("<I", len(points))
    for x, y, z in points:
        out += struct.pack("<I3f", 0, x, y, z)
    return out


def test_a_scene_with_nothing_it_can_read_says_so():
    """A file of primitives nobody collapsed has no geometry to give."""
    scene = fb._max_wide_chunk(0x2023, fb._max_chunk(0x0000, b"", container=True))
    data = fb._max_compound({
        "Scene": scene,
        "ClassDirectory3": fb._max_class("Box", 0x10, 0x10),
    })
    doc = parse_max(data)
    assert doc.extra["placed"] == 0
    assert any("Box" in w for w in doc.warnings)
    assert any("no Editable Poly" in w for w in doc.warnings)


def test_reading_it_from_disk_and_reporting_it(tmp_path):
    path = tmp_path / "scene.max"
    path.write_bytes(fb.build_max())
    doc = read_fbx(path, load_arrays=True)
    assert doc.format == "max"
    assert doc.file_size == path.stat().st_size

    text = render_text(analyze(doc))
    assert "Autodesk 3ds Max" in text
    assert "3ds Max 2018" in text
    assert "1 mesh object, 8 vertices, 6 faces" in text
    assert "paint.jpg" in text


def test_parse_bytes_takes_one_too():
    doc = parse_bytes(fb.build_max(), path="scene.max")
    assert doc.format == "max" and doc.extra["meshes"] == 1


def test_a_truncated_file_is_refused():
    data = fb.build_max()[:600]
    with pytest.raises((ParseError, struct.error)):
        parse_max(data)


def test_an_editable_mesh_is_read_as_well():
    """The other geometry class: triangles, and no flag word before a vertex.

    Half the scenes in the wild are modelled this way, and it shares only the
    block it sits in with an Editable Poly.
    """
    doc = parse_max(fb.build_max(kind="mesh"), load_arrays=True)
    assert doc.warnings == []
    assert doc.extra["meshes"] == 1
    assert doc.extra["faces"] == 12                      # six quads, cut in two
    geometry = _geometry(doc)[0]
    vertices = geometry.get("Vertices").props[0].value
    assert len(vertices) == 24 and min(vertices) == -1.0 and max(vertices) == 1.0
    polygons = geometry.get("PolygonVertexIndex").props[0].value
    assert len(polygons) == 36
    assert all(polygons[i] < 0 for i in range(2, len(polygons), 3))
    assert geometry.get("LayerElementUV") is not None


def test_compressed_streams_are_inflated():
    """3ds Max 2022 and later can gzip what it writes, stream by stream."""
    plain = parse_max(fb.build_max(), load_arrays=True)
    packed = fb.build_max(compressed=True)
    assert packed != fb.build_max()
    doc = parse_max(packed, load_arrays=True)
    assert doc.warnings == []
    assert _geometry(doc)[0].get("Vertices").props[0].value == \
        _geometry(plain)[0].get("Vertices").props[0].value
    assert doc.extra["classes"] and doc.extra["assets"]


def test_a_file_that_stops_mid_sector_is_still_read():
    """Writers do it, and the tail of one sector is no reason to refuse 30 MB."""
    data = fb.build_max()
    doc = parse_max(data[:-200], load_arrays=True)
    assert doc.extra["meshes"] == 1
    assert len(_geometry(doc)[0].get("Vertices").props[0].value) == 24
