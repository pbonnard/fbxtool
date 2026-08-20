"""What an Assetto Corsa shader name says about the material wearing it.

A ``.kn5`` material names its shader and then states three dozen loose numbers,
and which of those numbers mean anything depends entirely on the name: the same
``fresnelC`` is a windscreen's reflection on one material and nothing at all on
the next, and a ``txNormal`` is the panel's own relief on most shaders and the
dents in it on the ones that model a car being crashed.

The names are *compositional*, which is what makes a table of them tractable.
``ksPerPixelMultiMap_AT_NMDetail`` is ``ksPerPixelMultiMap`` with alpha testing
and a detail normal, and nothing about it needs a row of its own.  So a name is
read as a base with suffixes rather than looked up whole, which is what lets a
shader nobody here has seen — Custom Shaders Patch ships its own, and a car may
be built against any of them — still be described correctly as long as it was
named in the house style.

Everything here is settled by ``tools/shader_census.py`` over the cars to hand
rather than by what the names suggest.  Two of its findings shape the whole
module:

* ``ksAlphaRef`` is **zero on every alpha-tested material counted** — all 20 of
  the ``ksPerPixelAT`` ones, all 17 of the ``ksPerPixelAT_NM``.  A cutoff of
  nought cuts nothing out, so a grille taken at face value is a solid rectangle.
  The game's own shader has a default behind the number; so does this.

* ``blurLevel``, ``dirtyLevel`` and ``glowLevel`` are **zero on every material
  that states them** — every ``ksTyres`` and every ``ksBrakeDisc``.  They are
  what the game writes per frame out of wheel speed, dirt picked up and heat in
  the disc, and a car sitting still has none of any of them.  The maps they
  drive are bound all the same, and drawn at face value a parked car has glowing
  brakes and a blurred tyre.
"""

from __future__ import annotations

__all__ = ["describe", "slot_role", "light_weight", "reflectance", "tiling", "FAMILIES",
           "SLOT_ROLES", "RUNTIME_SLOTS", "ALPHA_REF_DEFAULT"]


#: What each texture slot is, wherever it is bound.  A slot means the same thing
#: across every shader that binds it — the census finds no counter-example —
#: with the one exception handled in :func:`slot_role`.
#:
#: The roles are this project's own names, shared with the palette and the
#: exporters.  ``baseColor``, ``normal``, ``emissive``, ``detail`` and
#: ``detailNormal`` already exist there; the rest are new and are named for what
#: the game means by them rather than for a PBR slot they are not.
SLOT_ROLES = {
    "txDiffuse": "baseColor",
    "txNormal": "normal",
    # Not a metallic-roughness map however much it looks like one: its channels
    # drive the game's own Blinn-Phong highlight, and read as PBR it is a map
    # drawn from the wrong end.  201 of the 528 materials counted bind one, so
    # it is the largest single thing a car loses on the way through here.
    "txMaps": "acMaps",
    "txDetail": "detail",
    "txNormalDetail": "detailNormal",
    # A real emissive map, unlike `txGlow` below: `ksPerPixelMultiMap_AT_emissive`
    # binds it beside a block of `ksEmissive1`..`ksEmissive6` channel levels.
    "txEmissive": "emissive",
    # Heat in a brake disc.  Bound by `ksBrakeDisc` and by almost nothing else —
    # 10 of the 10 that bind it here — and its level is nought on a car at rest.
    "txGlow": "glow",
    # What the surface turns into as it spins.  A tyre and a disc each bind a
    # blurred colour and a blurred relief, and `blurLevel` says how far between
    # the two the wheel currently is: nought, parked.
    "txBlur": "blur",
    "txNormalBlur": "normalBlur",
    # What a tyre picks up off the track, at `dirtyLevel` — nought, parked.
    "txDirty": "dirt",
    # And what a car accumulates as it is driven into things.
    "txDust": "dust",
    "txDamage": "damage",
    "txDamageMask": "damageMask",
}

#: Slots whose level the file states as nought because the game writes it per
#: frame.  Bound, carried, and not to be drawn at the level the file gives.
RUNTIME_SLOTS = frozenset({"txGlow", "txBlur", "txNormalBlur", "txDirty",
                           "txDust", "txDamage", "txDamageMask"})

#: The levels those slots are driven at, so a reader can tell a stated nought
#: from an absent one.
RUNTIME_LEVELS = {
    "txGlow": "glowLevel",
    "txBlur": "blurLevel",
    "txNormalBlur": "blurLevel",
    "txDirty": "dirtyLevel",
    "txDust": "dirt",
    "txDamage": "damageZones",
}

#: What the game cuts an alpha-tested surface at when the material says nought.
#: Every alpha-tested material counted says nought, so this is not a fallback for
#: an unusual file — it is what the number almost always means.
ALPHA_REF_DEFAULT = 0.5

#: The shader bases, with what each one is beyond the suffixes on its name.
#:
#: ``family`` is what a renderer branches on; the flags are what it needs to
#: know without branching.  A base not listed here is still described — its
#: suffixes are read and its family comes out ``perPixel`` — since the list of
#: names is open and the suffixes are the part that carries the meaning.
FAMILIES = {
    "ksPerPixel": {"family": "perPixel"},
    # A per-texel highlight out of `txMaps`, a grain out of `txDetail` tiled
    # `detailUVMultiplier` times across the surface — a median of 100, and up to
    # 5000 — and `useDetail` saying whether the grain is worn at all.
    "ksPerPixelMultiMap": {"family": "multiMap", "detail": True,
                           "normalMap": True, "acMaps": True},
    # The world in a cube map, which nothing here has: the viewer lights from an
    # analytic sky, so this stays an approximation whichever way the switch is
    # set.  Its highlight is the tightest of any family — a median exponent of
    # 200 against the 20 a multi-map states — which is what chrome is.
    "ksPerPixelReflection": {"family": "reflection"},
    "ksPerPixelSimpleRefl": {"family": "reflection"},
    # A tyre: a clean tread, a blurred one, a dirty one, and two levels the game
    # writes per frame to say how far between them the wheel is.
    "ksTyres": {"family": "tyres", "normalMap": True},
    # A disc: the same blur, plus the heat glow.
    "ksBrakeDisc": {"family": "brakeDisc", "normalMap": True},
    # Always blended — 7 of the 7 counted — and the only family that is.
    "ksWindscreen": {"family": "windscreen", "blended": True},
    "ksBrokenGlass": {"family": "windscreen", "normalMap": True,
                      "blended": True},
    # A diffuse that answers a grazing light the way cloth and unpolished stone
    # do, at the `fRoughness` it states.
    "ksOrenNayar": {"family": "orenNayar"},
}

#: The suffixes a name is built out of, longest first so that ``NMDetail`` is
#: read as itself rather than as ``NM`` with ``Detail`` left over.
#:
#: A suffix is written both ways round and the same name may do both:
#: ``ksPerPixelAT`` runs it straight on, ``ksPerPixelAT_NM`` puts an underscore
#: before the next one, and ``ksPerPixelMultiMap_AT_NMDetail`` underscores every
#: one.  So each is tried underscored first and then bare.
_SUFFIXES = [
    ("NMDetail", {"normalMap": True, "detailNormal": True}),
    ("damage_dirt", {"damage": True, "dirt": True}),
    ("emissive", {"emissiveMap": True}),
    ("damage", {"damage": True}),
    ("UVMult", {"uvMultiplier": True}),
    ("dirt", {"dirt": True}),
    ("UV2", {"secondUv": True}),
    ("AT", {"alphaTested": True}),
    ("NM", {"normalMap": True}),
    ("NS", {}),
]

#: netKar Pro's shaders, which a few cars still carry.  They are the same
#: surfaces under an older prefix, so they are read as the ks- ones.
_ALIASES = {"ne": "ks", "sm": "ks"}

_FLAGS = ("alphaTested", "normalMap", "detail", "detailNormal", "acMaps",
          "damage", "dirt", "emissiveMap", "secondUv", "uvMultiplier",
          "blended")


def _alias(name: str) -> str:
    """A shader under another vendor's prefix, said the house way."""
    for prefix, house in _ALIASES.items():
        if name.startswith(prefix) and len(name) > len(prefix) \
                and name[len(prefix)].isupper():
            return house + name[len(prefix):]
    return name


def slot_role(slot: str, shader: str) -> str | None:
    """What a texture slot is on this shader, or ``None`` for one nothing knows.

    One slot changes meaning with the shader and it is the important one: on the
    families that model a car being crashed, ``txNormal`` is not the surface's
    own relief but the dents blended in as damage accumulates.  A car as saved
    has none, so drawn as relief it puts creases down the whole of a bonnet that
    has never been hit.
    """
    if slot == "txNormal" and describe(shader)["damage"]:
        return "damageNormal"
    return SLOT_ROLES.get(slot)


def describe(shader: str) -> dict:
    """What a shader name says, read as a base with suffixes.

    The result is the same shape for a name in :data:`FAMILIES` and for one
    nobody here has seen; ``known`` says which it was, so a caller that wants to
    be careful with a stranger can be.
    """
    name = _alias(str(shader or "").strip())
    flags = {flag: False for flag in _FLAGS}

    # The suffixes come off one at a time and in the order listed, so that a
    # name wearing several — `_AT_NMDetail` — gives up all of them.
    #
    # Underscored, the match ignores case: the separator is enough to say a
    # suffix is what it is.  Bare, it does not: `AT` run straight onto a name
    # has only its capitals to mark it out, and matching loosely would find one
    # at the end of any word ending in those letters.
    base = name
    peeled = True
    while peeled:
        peeled = False
        for suffix, says in _SUFFIXES:
            marked = "_" + suffix
            if len(base) > len(marked) and base.lower().endswith(marked.lower()):
                base = base[: -len(marked)]
            elif len(base) > len(suffix) and base.endswith(suffix):
                base = base[: -len(suffix)]
            else:
                continue
            flags.update(says)
            peeled = True
            break

    entry = FAMILIES.get(base) or FAMILIES.get(name)
    known = entry is not None
    # A name that peeled down to nothing recognisable is still described by its
    # suffixes; `ksPerPixel` is what every one of these families is underneath.
    if entry is None:
        entry = FAMILIES.get(name.split("_")[0], {"family": "perPixel"})
    family = entry.get("family", "perPixel")
    for flag in _FLAGS:
        if entry.get(flag):
            flags[flag] = True

    # A multi-map states its `txMaps` and its grain whichever suffixes follow.
    if family == "multiMap":
        flags["acMaps"] = True
        flags["detail"] = True
        flags["normalMap"] = True

    return {
        "shader": str(shader or ""),
        "base": base or name,
        "family": family,
        "known": known,
        **flags,
    }


# ------------------------------------------- what a surface is, as the game says

#: What a plainly lit surface takes from the light: ``ksAmbient`` and
#: ``ksDiffuse`` at the pair most materials state them at.  Of 1728 materials
#: across the 27 cars to hand, 0.5 and 0.6 is the commonest by a wide margin —
#: 278 of them, one in six, and the value the game's own editor starts at.
LIGHT_AMBIENT = 0.5
LIGHT_DIFFUSE = 0.6

#: What a material that leaves the Fresnel out means by it, and no ceiling on
#: the term where none is stated.
DEFAULT_FRESNEL_C = 0.05
DEFAULT_FRESNEL_MAX = 1.0


def light_weight(scalar) -> float:
    """How much of the light a material takes, against a plainly lit one.

    *scalar* is ``(name, default) -> float`` — a material's own reader, or a
    lookup into whatever the parameters were carried in.

    ``ksAmbient`` and ``ksDiffuse`` weight the two halves of the game's own
    lighting rather than tinting anything.  Both halves are diffuse, so in a
    viewer with one fixed light the two weights have nowhere to go but the
    albedo, where they are the same arithmetic: dimming the light that reaches a
    surface and dimming the surface come to the same picture.

    This is the whole of why an Audi S8 comes up white from end to end.  Its
    paint is 0.4 and 0.4 and its wheels are 0.03 and 0.01; its headlight
    housings are nothing at all.  The pictures under those are grey panel maps —
    the colour was never in the picture — so read without the weights the rims,
    the lamps and the carbon mirror caps all draw as bright as the body, and the
    body draws brighter than the game ever shows it.

    A quarter of them ask for more light than a plainly lit surface gets, which
    a dashboard or a lamp lens does on purpose.  A diffuse surface cannot return
    more than it was given, so that is where this stops.
    """
    weight = ((scalar("ksAmbient", LIGHT_AMBIENT) + scalar("ksDiffuse", LIGHT_DIFFUSE))
              / (LIGHT_AMBIENT + LIGHT_DIFFUSE))
    return min(max(weight, 0.0), 1.0)


def reflectance(scalar) -> float:
    """What a surface actually reflects facing you.

    ``fresnelC`` is the Schlick base and ``fresnelMaxLevel`` is a ceiling on the
    whole term — not the value at a grazing angle, which is what the pair reads
    like until you see the numbers.  A BMW Z3M's ``lightclear`` states 1.0 and
    0.03: read as a base it is a perfect mirror, and read as a ceiling it is the
    three per cent a clear lens reflects.  An Alfa TZ2's ``EXT_TYRE`` settles it
    — it states 5.0, which is not a reflectance at all and can only be a number
    something clamps, beside a ceiling of 0.02.

    The two always travel together: of 1853 materials across the cars to hand,
    1075 state both and 778 state neither, and not one states only one of them.
    So reading the first without the second is reading half of a sentence, and
    it is the half that turns a tail lamp and a tyre into mirrors.
    """
    facing = scalar("fresnelC", DEFAULT_FRESNEL_C)
    ceiling = scalar("fresnelMaxLevel", DEFAULT_FRESNEL_MAX)
    return min(max(min(facing, ceiling), 0.0), 1.0)


def tiling(scalar, name: str) -> float:
    """How many times a picture is tiled across a surface, where it says.

    ``ksPerPixelNM_UVMult`` gives the colour and the relief a multiplier each,
    at a median of 12.5 and 195 across the 32 materials that state them.  A
    stated nought is a multiplier nobody set rather than one set to nothing —
    half of them write it for the colour — and taken literally it would collapse
    the whole picture into its first texel.
    """
    stated = scalar(name, 0.0)
    return stated if stated > 0 else 1.0
