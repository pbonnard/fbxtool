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


def test_textured_sample_carries_an_embedded_image(sample_textured_path):
    """The texture rides inside the file, so it needs nothing alongside it."""
    doc = read_fbx(sample_textured_path)
    info = analyze(doc)
    assert doc.warnings == []
    assert info.object_counts["Texture"] == 1
    assert info.object_counts["Video (Clip)"] == 1

    video = doc.root.path("Objects", "Video")
    content = video.get("Content").props[0].value
    assert content[:8] == b"\x89PNG\r\n\x1a\n", "the embedded payload should be a PNG"
    assert len(content) > 100


def test_textured_sample_uses_indexed_uvs(sample_textured_path):
    """IndexToDirect is what real exporters write, so the fixture uses it."""
    geometry = read_fbx(sample_textured_path).root.path("Objects", "Geometry")
    uv = geometry.get("LayerElementUV")
    assert uv.path_value("MappingInformationType") == "ByPolygonVertex"
    assert uv.path_value("ReferenceInformationType") == "IndexToDirect"
    assert uv.get("UV").props[0].array.length == 8        # four corners
    assert uv.get("UVIndex").props[0].array.length == 24  # one per polygon vertex


def test_scene_sample_is_in_step_with_the_writer(sample_scene_path):
    """The checked-in multi-part scene is generated, so it must not drift."""
    import fbxbuild as fb

    from pathlib import Path

    assert Path(sample_scene_path).read_bytes() == fb.build_scene(version=7400), (
        "run tools/make_samples.py to regenerate samples/"
    )


def test_scene_sample_instances_one_mesh(sample_scene_path):
    info = analyze(read_fbx(sample_scene_path))
    assert info.doc.warnings == []
    assert info.object_counts["Model (Mesh)"] == 3
    assert info.object_counts["Geometry (Mesh)"] == 1
    # hub -> arm -> mirror, each carrying the same geometry.
    root = info.roots[0].children[0]
    assert root.obj.name == "hub"
    assert root.children[0].obj.name == "arm"
    assert root.children[0].children[0].obj.name == "mirror"


def test_shelby_is_the_multi_part_case(real_scene_path):
    """The scene that made whole-scene assembly necessary.

    Forty-four parts, each in its own space, materials that carry nothing at
    all, and one mesh instanced by two dozen models.
    """
    info = analyze(read_fbx(real_scene_path))
    assert info.doc.warnings == []
    assert info.object_counts["Model (Mesh)"] == 44
    assert info.object_counts["Geometry (Mesh)"] == 44
    assert info.object_counts["Material"] == 20
    assert info.object_counts["Model (Camera)"] == 1

    from fbxtool.analyze import resolved_properties

    materials = [o for o in info.objects if o.node_type == "Material"]
    # Every one carries an empty Properties70 — a container and nothing in it.
    assert all(len(getattr(o.node.get("Properties70"), "children", [])) == 0
               for o in materials)
    # So every colour comes from the template, and they are all the same grey.
    colours = {tuple(resolved_properties(o, info.templates)["DiffuseColor"])
               for o in materials}
    assert colours == {(0.8, 0.8, 0.8)}

    # One geometry is shared by many models, which is what the material list
    # has to group back together.
    by_uid = {o.uid: o for o in info.objects if o.uid is not None}
    slots = [c.src for c in info.connections
             if c.kind == "OO" and by_uid.get(c.src) is not None
             and by_uid[c.src].node_type == "Material"
             and by_uid.get(c.dst) is not None and by_uid[c.dst].node_type == "Model"]
    assert len(slots) > len(set(slots)), "materials should repeat across parts"
