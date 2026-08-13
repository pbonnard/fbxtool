# fbxtool

Inspect FBX files and report what version they are and what is inside them —
both the **binary** and the **ASCII** encodings, with **no dependencies** and
without the Autodesk FBX SDK.

```
$ fbxinfo samples/cube_binary.fbx
File
────
  Path:              samples/cube_binary.fbx
  Size:              4.1 KiB
  Encoding:          binary
  Version:           7400 (FBX 7.4.0 — FBX 2014 / 2015)
  Version note:      most widely supported version
  Version read from: header
  Node offsets:      32-bit
  Footer:            present, version stamp 7400

Metadata
────────
  Creator:                  fbxtool test fixture
  Created:                  2024-06-14 09:30:15.250
  Header extension version: 1003
  File id:                  000102030405060708090a0b0c0d0e0f
  Originally written by:    Maya 2024 (Autodesk)

Global settings
───────────────
  Axis system: up +Y, front +Z, right +X
  Units:       1 cm per unit (centimetres), originally 2.54
  Time mode:   30 fps
  Time span:   2.000 s

...

Scene hierarchy
───────────────
  RootNode
  └── pCube1  [Mesh]  uid=2000
      ├── [Geometry] Geometry (8 vertices, 24 polygon indices, 1 layer, 1 UV set)
      └── [Material] lambert1 (shading: lambert)
```

## Install

```sh
pip install .          # installs the fbxinfo command
```

Or run it straight from a checkout, with no install at all:

```sh
python3 -m fbxtool scene.fbx
```

Python 3.9+; standard library only (`struct`, `zlib`, `mmap`, `json`).

On Windows the report degrades to ASCII box drawing automatically when the
output encoding cannot represent the Unicode characters — which is what happens
when you redirect or pipe stdout, since it falls back to the active code page.
`--ascii` forces the same rendering everywhere.

## Command line

```
fbxinfo FILE [FILE ...] [options]

sections:
  --tree              print the raw record tree
  --depth N           limit --tree to N levels
  --props             print every property value, not just a preview
  --objects           list the Objects section entry by entry
  --connections       list connections individually, with names resolved
  --no-hierarchy      skip the reconstructed scene hierarchy
  -a, --all           everything: --tree --props --objects --connections
  --brief             one summary line per file

output:
  --json              emit JSON instead of text
  --indent N          JSON indent (default: 2, 0 for compact)
  --max-list N        cap listed objects/connections/hierarchy rows (default: 40)
  --decode-arrays     decode (and inflate) array payloads so values can be shown
  --max-array N       keep at most N values per decoded array (0 for all)
  --ascii             draw with plain ASCII instead of box-drawing characters
```

`fbxinfo` is the only entry point — the modules under `fbxtool/` are library
code, so running one directly (`python fbxtool/binary.py scene.fbx`) fails with
`ImportError: attempted relative import with no known parent package`. Use
`python -m fbxtool scene.fbx` from the directory containing the package, or
install it and use `fbxinfo`.

Examples:

```sh
fbxinfo scene.fbx                      # version, settings, objects, hierarchy
fbxinfo scene.fbx --tree --depth 3     # the record tree, three levels deep
fbxinfo scene.fbx --objects --props    # every object plus full property values
fbxinfo *.fbx --brief                  # one line per file
fbxinfo scene.fbx --json | jq .objects.by_kind
```

### What gets reported

| Section | Contents |
| --- | --- |
| File | encoding, size, version stamp and the product that writes it, 32/64-bit node offsets, binary footer and its version stamp |
| Metadata | creator, creation timestamp, file id, encryption type, originating and last-saving application from `SceneInfo` |
| Global settings | axis system (up/front/right with sign), unit scale and its name, time mode, time span |
| Record structure | total records, nesting depth, per-section record counts, property histogram by type, stored array bytes |
| Definitions | declared object count, per-`ObjectType` counts and property templates |
| Objects | count by `Type (SubType)`, plus per-object detail — vertex and polygon counts, shading model, texture paths, cluster weights, curve key counts |
| Scene hierarchy | the transform tree rebuilt from the `Connections` section, with geometry and materials shown as attachments |
| Connections | totals by kind (`OO`, `OP`), and optionally each connection with both endpoints resolved to names |
| Animation | stacks, layers, curve and curve-node counts, stack durations, 6.x takes |
| Warnings | anything structurally inconsistent found while reading (see below) |

### Record tree

`--tree` prints the container itself rather than its interpretation:

```
$ fbxinfo samples/cube_binary.fbx --tree --depth 2 --props
├── FBXHeaderExtension  {6}
│   ├── FBXHeaderExtensionVersion: 1003
│   ├── FBXVersion: 7400
│   ├── EncryptionType: 0
│   ├── CreationTimeStamp  {8}
│   │   └── ... 8 records not shown
│   ├── Creator: "fbxtool test fixture"
│   └── SceneInfo: "GlobalInfo::SceneInfo", "UserData"  {4}
...
└── Objects  {4}
    ├── Geometry: 1000, "Geometry::Geometry", "Mesh"  {5}
    ...
```

Array properties are summarised as `*24 [d] deflate 87 B`: element count, type
code, encoding, and bytes as stored. Add `--decode-arrays` to also show the
leading values.

The tree shows properties as the file stores them, so binary object names keep
their own order with the `\x00\x01` separator printed as `::` — a binary
`pCube1::Model` is the same object an ASCII file would write as
`Model::pCube1`. The interpreted sections normalise both to a name and a class.

## Library

```python
from fbxtool import read_fbx, analyze

doc = read_fbx("scene.fbx")
print(doc.encoding, doc.version)          # 'binary' 7400
print(doc.wide_offsets, doc.has_footer)   # False True

info = analyze(doc)
for obj in info.objects:
    print(obj.uid, obj.kind, obj.display_name, obj.detail)

for conn in info.connections:
    print(conn.kind, conn.src, "->", conn.dst, conn.prop)
```

The record tree is available directly, and is the same shape for both
encodings:

```python
root = doc.root
version = root.path_value("FBXHeaderExtension", "FBXVersion")

for depth, node in root.walk():
    print("  " * depth, node.name, len(node.props), len(node.children))

vertices = root.path("Objects", "Geometry", "Vertices")
print(vertices.props[0].array.length)     # element count, payload not decoded
```

Useful entry points:

| Name | Purpose |
| --- | --- |
| `read_fbx(path)` | sniff the encoding and parse a file |
| `parse_bytes(data)` | the same, for data already in memory |
| `parse_binary(data)` / `parse_ascii(text)` | force one reader |
| `detect_format(head)` | `"binary"`, `"ascii"` or `"unknown"` |
| `analyze(doc)` | scene-level facts (`Analysis`) |
| `render_text(analysis)` / `to_dict(analysis)` | the CLI's text and JSON output |
| `render_tree(node)` | record tree as a list of lines |
| `describe(stamp)` | version stamp → dotted version, product, layout flags |

Array payloads are **not** decoded by default — only measured — so inspecting a
large mesh does not pay for inflating it. Pass `load_arrays=True` (and
optionally `max_array_values=N`) to any reader when you want the values.

## Format notes

### Binary

```
"Kaydara FBX Binary  \x00"   21 bytes of magic
\x1a\x00                     2 unknown bytes
uint32                       version stamp, e.g. 7400
<node record>*               top-level records
<null record>                all-zero record header
<footer>                     file id, padding, version stamp, 16-byte magic
```

A node record is:

```
EndOffset          uint32   (uint64 from version 7500)
NumProperties      uint32   (uint64 from version 7500)
PropertyListLen    uint32   (uint64 from version 7500)
NameLen            uint8
Name               NameLen bytes
<property>*        NumProperties properties, PropertyListLen bytes in total
<node record>*     nested records, terminated by a null record when present
```

`EndOffset` is an absolute file offset, which is what lets a reader skip a
subtree without decoding it — and what makes a wrong one detectable.

Property type codes:

| Code | Type | | Code | Type |
| --- | --- | --- | --- | --- |
| `Y` | int16 | | `f` | float32 array |
| `C` | bool | | `d` | float64 array |
| `I` | int32 | | `l` | int64 array |
| `F` | float32 | | `i` | int32 array |
| `D` | float64 | | `b` | bool array |
| `L` | int64 | | `S` | string (length-prefixed) |
| | | | `R` | raw bytes (length-prefixed) |

Arrays carry `ArrayLength`, `Encoding` and `CompressedLength`; encoding `1`
means the payload is zlib-deflated.

### ASCII

Same tree, written as `Name: prop, prop {children}`. `;` starts a comment, a
trailing comma continues a property list onto the next line, and bulk data is
written as a `*N` count followed by an `a:` record holding the values. The
reader folds those `a:` records into a single array property so both encodings
describe arrays identically.

Object names differ between the encodings — binary writes
`pCube1\x00\x01Model`, ASCII writes `Model::pCube1` — and both are normalised
to a name plus a class.

### Versions

| Stamp | Version | Product |
| --- | --- | --- |
| 6000 | 6.0.0 | FBX 6.0 (legacy layout) |
| 6100 | 6.1.0 | FBX 2009 / 2010 (legacy layout) |
| 7000 | 7.0.0 | FBX 2010 |
| 7100 | 7.1.0 | FBX 2011 |
| 7200 | 7.2.0 | FBX 2012 |
| 7300 | 7.3.0 | FBX 2013 |
| 7400 | 7.4.0 | FBX 2014 / 2015 |
| 7500 | 7.5.0 | FBX 2016 / 2017 — node offsets widen to 64 bits |
| 7600 | 7.6.0 | FBX 2018 |
| 7700 | 7.7.0 | FBX 2019 / 2020 |

Unlisted stamps are still reported, with the dotted version derived from the
number and the 64-bit-offset and legacy-layout flags derived from the
thresholds above.

Below 7000 the scene layout differs: objects are addressed by `Class::Name`
rather than by a 64-bit UID, and connections are written as `Connect:` records.
Both layouts are handled, including the reconstructed hierarchy.

## Damaged files

Structural problems are collected as warnings rather than raised, so a partly
corrupt file still produces a report:

```
Warnings (2)
────────────
  ! record 'Objects' at offset 1204: ends at 3310 but the header declares 3312
  ! footer magic not found; the file may be truncated
```

Warnings cover mismatched property-list lengths, out-of-range or inconsistent
end offsets, unreadable array payloads, a missing or mismatched footer, and —
for ASCII — unclosed braces, stray `}` and records without a `:`. Only a file
that cannot be identified at all, or whose property stream is undecodable,
raises (`ParseError` / `UnsupportedFormatError`, both subclasses of
`FbxError`).

## Limitations

- This reports on files; it does not write or convert them.
- Mesh detail is read from the record structure (counts, layer elements). No
  geometry is evaluated — no triangulation, transforms or bounding boxes.
- Encrypted FBX files are reported as such but not decrypted.
- The version table ends at 7700; newer stamps are described generically.

## Development

```sh
pytest                          # no dependencies beyond pytest itself
python3 tools/make_samples.py   # regenerate samples/cube_binary.fbx
```

`samples/cube_ascii.fbx` is checked in as source; `samples/cube_binary.fbx` is
generated by the same minimal writer the tests use (`tests/fbxbuild.py`), which
covers typed properties, deflated arrays, nesting, the null terminator and the
footer.

## License

MIT
