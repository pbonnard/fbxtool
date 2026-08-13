"""Mapping between FBX version stamps and the products that write them.

The version stamp is an integer such as ``7400``, which is read as version
``7.4.0``.  Autodesk kept the file version stable across several SDK releases,
so a single stamp can correspond to more than one product year.
"""

from __future__ import annotations

from dataclasses import dataclass

__all__ = ["VersionInfo", "describe", "dotted", "KNOWN_VERSIONS"]


#: Version stamp -> (product label, notes).  Compiled from the FBX SDK release
#: notes; stamps not listed here are still reported, just without a label.
KNOWN_VERSIONS: dict[int, tuple[str, str]] = {
    5000: ("FBX 5.0", "pre-Autodesk Kaydara format"),
    5800: ("FBX 5.8", "pre-Autodesk Kaydara format"),
    6000: ("FBX 6.0", "legacy layout: Objects hold names instead of UIDs"),
    6100: ("FBX 2009 / 2010", "legacy layout: Objects hold names instead of UIDs"),
    7000: ("FBX 2010", "first release of the modern 7.x layout"),
    7100: ("FBX 2011", ""),
    7200: ("FBX 2012", ""),
    7300: ("FBX 2013", ""),
    7400: ("FBX 2014 / 2015", "most widely supported version"),
    7500: ("FBX 2016 / 2017", "binary node offsets widen to 64 bits"),
    7600: ("FBX 2018", ""),
    7700: ("FBX 2019 / 2020", ""),
}

#: Below this stamp the 6.x-style scene layout is used.
LEGACY_VERSION_CUTOFF = 7000

#: At and above this stamp binary node records use 64-bit offsets and counts.
WIDE_OFFSET_VERSION = 7500


@dataclass(frozen=True)
class VersionInfo:
    """Everything we can say about a version stamp."""

    stamp: int
    dotted: str
    product: str | None
    notes: str
    legacy_layout: bool
    wide_offsets: bool

    @property
    def label(self) -> str:
        """A one-line description, e.g. ``7400 (FBX 7.4.0 — FBX 2014 / 2015)``."""
        if self.product:
            return f"{self.stamp} (FBX {self.dotted} — {self.product})"
        return f"{self.stamp} (FBX {self.dotted} — unrecognised, newer than this tool)"


def dotted(stamp: int) -> str:
    """``7400`` -> ``"7.4.0"``."""
    major, rest = divmod(int(stamp), 1000)
    minor, patch = divmod(rest, 100)
    return f"{major}.{minor}.{patch}"


def describe(stamp: int | None) -> VersionInfo | None:
    """Look up *stamp*; unknown stamps still get a dotted form and flags."""
    if stamp is None:
        return None
    stamp = int(stamp)
    product, notes = KNOWN_VERSIONS.get(stamp, (None, ""))
    return VersionInfo(
        stamp=stamp,
        dotted=dotted(stamp),
        product=product,
        notes=notes,
        legacy_layout=stamp < LEGACY_VERSION_CUTOFF,
        wide_offsets=stamp >= WIDE_OFFSET_VERSION,
    )
