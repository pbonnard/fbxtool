"""Tests for reporting and the command line interface."""

from __future__ import annotations

import json
import re

import pytest

import fbxbuild as fb

from fbxtool import analyze, parse_bytes, read_fbx, render_text, render_tree, to_dict
from fbxtool.cli import main
from fbxtool.versions import describe, dotted


def run(capsys, *argv) -> tuple[int, str, str]:
    status = main(list(argv))
    captured = capsys.readouterr()
    return status, captured.out, captured.err


def squeeze(text: str) -> str:
    """Collapse runs of spaces so assertions do not depend on column widths."""
    return re.sub(r"[ \t]+", " ", text)


def test_summary_report_mentions_the_key_facts(capsys, binary_cube):
    status, out, _ = run(capsys, binary_cube)
    out = squeeze(out)
    assert status == 0
    assert "Encoding: binary" in out
    assert "7400 (FBX 7.4.0 — FBX 2014 / 2015)" in out
    assert "Footer: present, version stamp 7400" in out
    assert "Node offsets: 32-bit" in out
    assert "fbxtool test fixture" in out
    assert "up +Y, front +Z, right +X" in out
    assert "Scene hierarchy" in out
    assert "pCube1" in out
    assert "[Geometry]" in out
    assert "Connections" in out


def test_ascii_report(capsys, sample_ascii_path):
    status, out, _ = run(capsys, sample_ascii_path)
    out = squeeze(out)
    assert status == 0
    assert "Encoding: ASCII text" in out
    assert "7300 (FBX 7.3.0 — FBX 2013)" in out
    assert "pCubeChild" in out
    assert "Warnings" not in out


def test_tree_output(capsys, binary_cube):
    _, out, _ = run(capsys, binary_cube, "--tree")
    assert "Record tree" in out
    assert "├── FBXHeaderExtension" in out
    assert "└── Connections" in out
    assert "Vertices" in out


def test_tree_depth_limit(capsys, binary_cube):
    _, out, _ = run(capsys, binary_cube, "--tree", "--depth", "1")
    assert "FBXHeaderExtension" in out
    assert "FBXVersion" not in out
    assert "records not shown" in out


def test_props_shows_array_previews(capsys, binary_cube):
    _, out, _ = run(capsys, binary_cube, "--tree", "--props")
    assert "*24 [d] deflate" in out
    assert "{-1, -1, 1, 1, -1, 1, ...}" in out


def test_objects_and_connections_listings(capsys, binary_cube):
    _, out, _ = run(capsys, binary_cube, "--objects", "--connections")
    out = squeeze(out)
    assert "Object list" in out
    assert "Model (Mesh)" in out
    assert "OO Model (Mesh) pCube1 -> RootNode" in out
    assert "OP Texture file1 -> Material lambert1 .DiffuseColor" in out


def test_brief_output(capsys, binary_cube, sample_ascii_path):
    _, out, _ = run(capsys, binary_cube, sample_ascii_path, "--brief")
    lines = out.strip().splitlines()
    assert len(lines) == 2
    assert "binary" in lines[0] and "4 objects" in lines[0]
    assert "ascii" in lines[1] and "5 objects" in lines[1]


def test_json_output_single_file(capsys, binary_cube):
    _, out, _ = run(capsys, binary_cube, "--json")
    data = json.loads(out)
    assert data["file"]["encoding"] == "binary"
    assert data["file"]["version"] == 7400
    assert data["file"]["version_dotted"] == "7.4.0"
    assert data["objects"]["count"] == 4
    assert data["connections"]["by_kind"] == {"OO": 3, "OP": 1}
    assert data["hierarchy"][0]["children"][0]["name"] == "pCube1"
    assert "records" not in data


def test_json_output_with_tree(capsys, binary_cube):
    _, out, _ = run(capsys, binary_cube, "--json", "--tree", "--depth", "2")
    data = json.loads(out)
    records = data["records"]["children"]
    assert records[0]["name"] == "FBXHeaderExtension"
    assert "children_omitted" in records[0]["children"][3]


def test_json_output_multiple_files(capsys, binary_cube, sample_ascii_path):
    _, out, _ = run(capsys, binary_cube, sample_ascii_path, "--json")
    data = json.loads(out)
    assert isinstance(data, list) and len(data) == 2
    assert {item["file"]["encoding"] for item in data} == {"binary", "ascii"}


def test_missing_file_reports_an_error(capsys, tmp_path):
    status, out, err = run(capsys, str(tmp_path / "nope.fbx"))
    assert status == 1
    assert "nope.fbx" in err


def test_unrecognised_file_reports_an_error(capsys, tmp_path):
    path = tmp_path / "notes.txt"
    path.write_text("just some prose, nothing structured at all\n")
    status, _, err = run(capsys, str(path))
    assert status == 1
    assert "unrecognised format" in err
    # The path should appear once, not twice.
    assert err.count(str(path)) == 1


def test_one_bad_file_does_not_stop_the_others(capsys, binary_cube, tmp_path):
    bad = tmp_path / "bad.fbx"
    bad.write_text("nope\n")
    status, out, err = run(capsys, str(bad), binary_cube, "--brief")
    assert status == 1
    assert "bad.fbx" in err
    assert binary_cube in out


def test_warnings_section_is_shown(capsys, tmp_path):
    path = tmp_path / "truncated.fbx"
    path.write_bytes(fb.build_cube()[:-32])
    _, out, _ = run(capsys, str(path))
    assert "Warnings" in out
    assert "footer magic not found" in out


def test_render_tree_helper():
    doc = parse_bytes(fb.build_binary([fb.N("A", [fb.I(1)], [fb.N("B")])]))
    lines = render_tree(doc.root, show_props=True)
    assert lines == ["└── A: 1  {1}", "    └── B"]


def test_render_text_can_omit_the_hierarchy(binary_cube):
    info = analyze(read_fbx(binary_cube))
    assert "Scene hierarchy" not in render_text(info, show_hierarchy=False)


def test_to_dict_is_json_serialisable(sample_ascii_path):
    data = to_dict(analyze(read_fbx(sample_ascii_path)), include_tree=True)
    json.dumps(data)  # must not raise


@pytest.mark.parametrize(
    "stamp,expected",
    [(6100, "6.1.0"), (7400, "7.4.0"), (7500, "7.5.0"), (7700, "7.7.0")],
)
def test_dotted_versions(stamp, expected):
    assert dotted(stamp) == expected


def test_unknown_version_is_still_described():
    info = describe(9900)
    assert info.dotted == "9.9.0"
    assert info.product is None
    assert "unrecognised" in info.label
    assert info.wide_offsets is True


def test_legacy_layout_flag():
    assert describe(6100).legacy_layout is True
    assert describe(7100).legacy_layout is False


class _NarrowStream:
    """A stdout stand-in limited to a legacy Windows code page."""

    encoding = "cp1252"

    def __init__(self) -> None:
        self.text = ""

    def write(self, text: str) -> int:
        text.encode(self.encoding)  # raises exactly as the real stream would
        self.text += text
        return len(text)


def test_ascii_fallback_replaces_every_drawing_character():
    from fbxtool.report import ASCII_FALLBACKS, to_ascii

    rendered = to_ascii("─├└│—→…")
    assert rendered == "-++|-->..."
    assert not any(char in rendered for char in ASCII_FALLBACKS)


def test_output_degrades_when_the_stream_cannot_encode(monkeypatch, binary_cube):
    """A redirected stdout on Windows reports cp1252 and must not crash."""
    stream = _NarrowStream()
    monkeypatch.setattr("sys.stdout", stream)
    assert main([binary_cube]) == 0

    stream.text.encode("cp1252")  # must not raise
    assert "+-- pCube1" in stream.text
    assert "7400 (FBX 7.4.0 - FBX 2014 / 2015)" in stream.text
    assert not any(char in stream.text for char in "─├└│—")


def test_brief_output_also_degrades(monkeypatch, binary_cube):
    stream = _NarrowStream()
    monkeypatch.setattr("sys.stdout", stream)
    assert main([binary_cube, "--brief"]) == 0
    stream.text.encode("cp1252")
    assert "FBX 7.4.0 - FBX 2014 / 2015" in stream.text


def test_ascii_flag_forces_plain_output(capsys, binary_cube):
    _, out, _ = run(capsys, binary_cube, "--ascii", "--tree", "--depth", "1")
    assert "+-- FBXHeaderExtension" in out
    assert not any(char in out for char in "─├└│—")


def test_unicode_is_kept_when_the_stream_supports_it(capsys, binary_cube):
    _, out, _ = run(capsys, binary_cube, "--tree", "--depth", "1")
    assert "├── FBXHeaderExtension" in out
    assert "└──" in out


@pytest.mark.parametrize("encoding", ["utf-8", "UTF-8", "utf8"])
def test_unicode_encodings_need_no_fallback(encoding):
    from fbxtool.cli import _needs_ascii

    assert _needs_ascii(type("S", (), {"encoding": encoding})()) is False


@pytest.mark.parametrize("encoding", ["cp1252", "ascii", "cp437", "latin-1", None, ""])
def test_narrow_encodings_need_the_fallback(encoding):
    from fbxtool.cli import _needs_ascii

    assert _needs_ascii(type("S", (), {"encoding": encoding})()) is True
