"""The checked-in sample files must stay readable by both readers."""

from __future__ import annotations

import pytest

from fbxtool import analyze, read_fbx


@pytest.fixture(params=["sample_ascii_path", "sample_binary_path"])
def sample(request):
    return request.getfixturevalue(request.param)


def test_samples_parse_without_warnings(sample):
    doc = read_fbx(sample)
    assert doc.warnings == []
    assert doc.version in (7300, 7400)


def test_samples_describe_the_same_scene(sample):
    info = analyze(read_fbx(sample))
    assert info.header["creation_time"] == "2024-06-14 09:30:15.250"
    assert info.global_settings["up_axis"] == "+Y"
    assert info.object_counts["Geometry (Mesh)"] == 1
    assert info.object_counts["Material"] == 1
    assert info.roots[0].children[0].obj.name == "pCube1"


def test_binary_sample_carries_a_matching_footer(sample_binary_path):
    doc = read_fbx(sample_binary_path)
    assert doc.encoding == "binary"
    assert doc.has_footer
    assert doc.footer_version == doc.version
    assert doc.wide_offsets is False


def test_both_encodings_agree_on_the_mesh(sample_ascii_path, sample_binary_path):
    details = []
    for path in (sample_ascii_path, sample_binary_path):
        info = analyze(read_fbx(path))
        geometry = next(obj for obj in info.objects if obj.node_type == "Geometry")
        details.append(geometry.detail)
    for detail in details:
        assert "8 vertices" in detail
        assert "24 polygon indices" in detail
