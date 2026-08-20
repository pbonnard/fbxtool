"""Tests for the Assetto Corsa shader table.

Two things are being checked.  The first is that the table describes the
seventeen shader names ``tools/shader_census.py`` actually found across the cars
to hand, rather than the ones the format's documentation suggests — a car may
wear any name, and the ones it does wear are what matters.

The second is that the Python table and the JavaScript one say the same thing.
They are the same table written twice, because a car opened in the browser and
the same car described by ``fbxinfo`` are meant to be the same car; two copies
of a table drift, and this is what stops them.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from fbxtool import acshaders

ROOT = Path(__file__).resolve().parent.parent
MODULE = ROOT / "web" / "app" / "acshaders.js"

needs_node = pytest.mark.skipif(shutil.which("node") is None,
                                reason="node is required")


#: Every shader name the census found, with what the table has to make of it.
#:
#: Counts are from ``tools/shader_census.py`` over the ten cars extracted to
#: hand — 528 materials.  They are here so that a name is not merely handled but
#: handled because something wears it.
CENSUS = [
    # name, materials, family, the flags that must be on
    ("ksPerPixelReflection", 105, "reflection", set()),
    ("ksPerPixelMultiMap_NMDetail", 102, "multiMap",
     {"normalMap", "detail", "detailNormal", "acMaps"}),
    ("ksPerPixelMultiMap", 94, "multiMap", {"normalMap", "detail", "acMaps"}),
    ("ksPerPixel", 72, "perPixel", set()),
    ("ksPerPixelNM", 45, "perPixel", {"normalMap"}),
    ("ksPerPixelNM_UVMult", 32, "perPixel", {"normalMap", "uvMultiplier"}),
    ("ksPerPixelAT", 20, "perPixel", {"alphaTested"}),
    ("ksPerPixelAT_NM", 17, "perPixel", {"alphaTested", "normalMap"}),
    ("ksTyres", 10, "tyres", {"normalMap"}),
    ("ksBrakeDisc", 10, "brakeDisc", {"normalMap"}),
    ("ksWindscreen", 7, "windscreen", {"blended"}),
    ("ksPerPixelSimpleRefl", 5, "reflection", set()),
    ("ksBrokenGlass", 3, "windscreen", {"normalMap", "blended"}),
    ("ksPerPixelMultiMap_AT_emissive", 3, "multiMap",
     {"alphaTested", "normalMap", "detail", "acMaps", "emissiveMap"}),
    ("ksPerPixelMultiMap_damage_dirt", 1, "multiMap",
     {"normalMap", "detail", "acMaps", "damage", "dirt"}),
    ("ksPerPixelMultiMap_AT_NMDetail", 1, "multiMap",
     {"alphaTested", "normalMap", "detail", "detailNormal", "acMaps"}),
    ("ksOrenNayar", 1, "orenNayar", set()),
]

#: And every texture slot they bind between them, with what it is.
CENSUS_SLOTS = {
    "txDiffuse": "baseColor",
    "txNormal": "normal",
    "txMaps": "acMaps",
    "txDetail": "detail",
    "txNormalDetail": "detailNormal",
    "txNormalBlur": "normalBlur",
    "txBlur": "blur",
    "txDirty": "dirt",
    "txGlow": "glow",
    "txEmissive": "emissive",
    "txDamageMask": "damageMask",
    "txDamage": "damage",
    "txDust": "dust",
}

FLAGS = ("alphaTested", "normalMap", "detail", "detailNormal", "acMaps",
         "damage", "dirt", "emissiveMap", "secondUv", "uvMultiplier", "blended")


@pytest.mark.parametrize("name,count,family,on",
                         CENSUS, ids=[row[0] for row in CENSUS])
def test_every_shader_a_car_actually_wears_is_described(name, count, family, on):
    """The seventeen names across 528 materials, and what each one is."""
    said = acshaders.describe(name)
    assert said["family"] == family
    assert said["known"], f"{name} fell through to a guess"
    assert {flag for flag in FLAGS if said[flag]} == on


def test_every_slot_those_shaders_bind_has_a_role():
    """A slot with no role is a texture that never reaches the palette, which
    is how ``txMaps`` — bound by 201 of the 528 — came to be dropped."""
    assert acshaders.SLOT_ROLES == CENSUS_SLOTS


def test_a_suffix_is_read_whether_it_is_underscored_or_run_straight_on():
    """``ksPerPixelAT`` runs it on and ``ksPerPixelAT_NM`` underscores it, and
    the same shader is meant by both spellings of the same suffix."""
    assert acshaders.describe("ksPerPixelAT")["alphaTested"]
    assert acshaders.describe("ksPerPixel_AT")["alphaTested"]
    assert acshaders.describe("ksPerPixelNM")["normalMap"]
    assert acshaders.describe("ksPerPixel_NM")["normalMap"]


def test_a_bare_suffix_is_matched_on_its_capitals():
    """Bare, ``AT`` has only its capitals to mark it out as a suffix rather
    than as the end of a word, so the match is case-sensitive there.  Matched
    loosely, anything ending in those two letters becomes alpha tested."""
    assert not acshaders.describe("ksSomethingFlat")["alphaTested"]
    assert not acshaders.describe("ksPerPixelMultiMap")["alphaTested"]


def test_a_shader_nobody_here_has_seen_is_still_described_by_its_suffixes():
    """The list of names is open — Custom Shaders Patch ships its own — and a
    stranger named in the house style still says what it is.  ``known`` is how
    a caller tells the two apart."""
    said = acshaders.describe("cspFancyThing_AT_NMDetail")
    assert not said["known"]
    assert said["family"] == "perPixel"
    assert said["alphaTested"] and said["detailNormal"] and said["normalMap"]


def test_the_damage_shaders_normal_map_is_the_dents_and_not_the_panel():
    """A car as saved has no damage, so drawn as relief the dents put creases
    down the whole of a bonnet that has never been hit."""
    assert acshaders.slot_role("txNormal", "ksPerPixelMultiMap") == "normal"
    assert (acshaders.slot_role("txNormal", "ksPerPixelMultiMap_damage_dirt")
            == "damageNormal")


def test_the_levels_a_parked_car_states_as_nought_are_marked_as_runtime():
    """``glowLevel``, ``blurLevel`` and ``dirtyLevel`` are nought on every
    material that states them, across every ``ksTyres`` and ``ksBrakeDisc``
    counted: they are what the game writes per frame out of heat, wheel speed
    and dirt.  Drawn at face value a parked car has glowing brakes."""
    for slot in ("txGlow", "txBlur", "txNormalBlur", "txDirty"):
        assert slot in acshaders.RUNTIME_SLOTS
    assert acshaders.RUNTIME_LEVELS["txGlow"] == "glowLevel"
    # And the maps a surface actually wears are not among them.
    for slot in ("txDiffuse", "txNormal", "txMaps", "txDetail"):
        assert slot not in acshaders.RUNTIME_SLOTS


def test_an_alpha_tested_material_that_states_no_cutoff_gets_the_games_own():
    """Every alpha-tested material counted states ``ksAlphaRef`` as nought —
    all 20 of the ``ksPerPixelAT`` and all 17 of the ``ksPerPixelAT_NM``.  A
    cutoff of nought cuts nothing out, so a grille taken at face value is a
    solid rectangle."""
    assert acshaders.ALPHA_REF_DEFAULT == 0.5


# ------------------------------------------------------- the two tables agree


def _from_node(expression: str):
    script = (
        f"const S=require({str(MODULE)!r});"
        f"console.log(JSON.stringify({expression}));"
    )
    result = subprocess.run(["node", "-e", script], capture_output=True,
                            text=True, encoding="utf-8", errors="replace")
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


@needs_node
def test_the_javascript_table_describes_every_shader_the_same_way():
    """Two copies of one table drift.  This is what stops them."""
    names = [row[0] for row in CENSUS] + [
        "cspFancyThing_AT_NMDetail", "ksSomethingFlat", "nePerPixelNM", "",
    ]
    said = _from_node(f"{json.dumps(names)}.map((n) => S.describe(n))")
    for name, theirs in zip(names, said):
        ours = acshaders.describe(name)
        assert theirs["family"] == ours["family"], name
        assert theirs["base"] == ours["base"], name
        assert theirs["known"] == ours["known"], name
        for flag in FLAGS:
            assert theirs[flag] == ours[flag], f"{name}.{flag}"


@needs_node
def test_the_javascript_table_holds_the_same_slots_and_levels():
    said = _from_node("({slots: S.SLOT_ROLES, levels: S.RUNTIME_LEVELS, "
                      "runtime: [...S.RUNTIME_SLOTS], ref: S.ALPHA_REF_DEFAULT})")
    assert said["slots"] == acshaders.SLOT_ROLES
    assert said["levels"] == acshaders.RUNTIME_LEVELS
    assert set(said["runtime"]) == set(acshaders.RUNTIME_SLOTS)
    assert said["ref"] == acshaders.ALPHA_REF_DEFAULT


@needs_node
def test_the_javascript_table_diverts_a_damage_normal_the_same_way():
    said = _from_node("[S.slotRole('txNormal', 'ksPerPixelMultiMap'), "
                      "S.slotRole('txNormal', 'ksPerPixelMultiMap_damage_dirt'), "
                      "S.slotRole('txNothing', 'ksPerPixel')]")
    assert said == ["normal", "damageNormal", None]
