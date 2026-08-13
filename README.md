# fbxtool

Inspect model files and report what version they are and what is inside them,
with **no dependencies** and without the Autodesk FBX SDK.

| Format | Support |
| --- | --- |
| **FBX** binary and ASCII | full — inspect and render |
| **Wavefront OBJ** (+ `.mtl`) | full — inspect and render |
| **Blender `.blend`** | inspect and render, for the `MVert`/`MPoly`/`MLoop` layout |

OBJ and `.blend` are normalised into the same record tree as FBX, so every
option and the viewer apply to them unchanged.

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

### Wavefront OBJ

`fbxinfo model.obj` reads any `.mtl` the file names from the same directory and
produces the same report as for FBX: `v`/`vn`/`vt` become vertex, normal and UV
arrays, `f` becomes the polygon index run, `usemtl` becomes a per-polygon
material layer, and `map_Kd` becomes a texture reference. Face indices may be
given in any of the five OBJ syntaxes, including negative (relative) ones.

### Blender files

`fbxinfo scene.blend` reports the container: Blender version, pointer size,
endianness, compression, file-block counts by code, the SDNA (structs, types
and field names) and every datablock with its name and type.

Datablock names are located by computing the offset of `ID.name` **from the
file's own SDNA**, so they are found wherever a given release puts them rather
than at a hard-coded offset.

Meshes are extracted too, and render: `MVert` holds the coordinates, `MLoop`
the per-corner vertex indices, `MPoly` the run of loops each polygon owns, and
`MLoopUV` the texture coordinates — each reached by following the address the
block had when it was written. Materials come from the mesh's slot table, which
is what a polygon's material index refers to.

Every offset and struct size is computed from the file's own SDNA, so this
adapts to whatever a release put where rather than assuming a layout. Releases
that replaced these arrays with generic attributes (3.6 deprecated `MVert`, 4.0
removed it) are detected by their absence and **reported rather than guessed
at** — a wrong guess would render plausible nonsense.

Materials use the viewport display colour stored on the datablock. A material's
rendered appearance lives in its node tree, which is a separate problem.

Files saved with Blender's **Compress** option are wrapped — gzip up to 2.9x,
Zstandard from 3.0. Gzip is unwrapped automatically; Zstandard is detected and
reported rather than guessed at, since decompressing it would mean shipping a
second decompressor.

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

## Web version

`web/` holds a browser build that inspects **and renders** FBX files, with the
same reporting as the command line:

```sh
python3 web/build.py          # -> web/dist/fbxview.html
```

That produces one self-contained HTML file — the WebAssembly module, CSS and
JavaScript are all inlined, so it runs from a `file://` URL with no server, no
CDN and no network. Open it and drop a file in; nothing is uploaded anywhere.

| Layer | Where it runs |
| --- | --- |
| DEFLATE, binary record walking, polygon triangulation, normal generation | WebAssembly (`web/src/fbx.c`, freestanding, no libc, **no imports**) |
| ASCII FBX, OBJ and .blend reading, scene analysis, report | JavaScript — text and structure work with no hot loop |
| Rendering | WebGL2 with an orbit camera and per-material shading |

Every reader produces the same record tree, so the analysis and the geometry
pipeline do not care which one ran; ASCII FBX and OBJ meshes are triangulated
by the same WebAssembly code. Drop an `.obj` with its `.mtl` — together or
afterwards — exactly as you would with a texture.

Both readers are held to the Python implementation record for record —
`tests/test_web.py` runs the WASM module under Node and compares the whole
tree against `fbxtool.read_fbx` — and `web/test/browser.js` drives the built
page in Chromium, reading pixels back to confirm WebGL actually rasterised
something.

The viewer picks the up axis from the geometry when the vertex data clearly
disagrees with the declared `UpAxis`, which happens in practice: a model
resting on a ground plane has its minimum at zero along the up axis. The
choice is shown, and can be overridden.

### Whole scenes

A mesh is stored in its model's local space, so a file of many parts is a heap
of overlapping pieces until each one is placed. The viewer assembles the whole
scene by default: for every model that owns a geometry it builds the local
matrix FBX actually specifies —

```
T * Roff * Rp * Rpre * R * Rpost⁻¹ * Rp⁻¹ * Soff * Sp * S * Sp⁻¹
```

— composes it up the parent chain, and applies the geometric transform, which
offsets the mesh from its node without being inherited by children. Euler
angles follow the node's `RotationOrder`, where `XYZ` means the X turn happens
first. A negative scale mirrors, which exporters emit routinely: facing is
reversed, so the winding and the normals are corrected for it. One mesh shared
by several models — four wheels from one wheel — is drawn once per model.

`samples/scene_parts.fbx` is a three-part scene to try it on: one cube,
instanced by a chain of three models, the last of them mirrored. Any single
record can still be picked from the dropdown to see it on its own.

### Materials and textures

Surfaces are drawn in the file's own `DiffuseColor`, falling back to the
default in `Definitions` → `PropertyTemplate` when a material carries no
properties of its own — which is how Blender's exporter writes them, and why
such files otherwise render pure black. A per-polygon material index does not
name a material directly — it indexes the materials connected to the *model*
that owns the geometry, in connection order — so the palette is resolved
through the connection graph.

Diffuse textures are followed from `Material` through the object-to-property
connection that names `DiffuseColor`, then on to the `Video` clip holding the
image:

- **Embedded** images (a `Content` property of raw bytes) load on their own.
- **Referenced** images — just a filename, which is what most exporters write —
  need the image supplied. Drop it in with the `.fbx`, or afterwards; files are
  matched on basename, so the exporter's original absolute path does not
  matter. Until then the mesh renders in flat colour and the viewport says
  which filename it is waiting for.

UV and normal layers are read for both `Direct` and `IndexToDirect` reference
modes, per polygon vertex or per control point. Shading modes are **File
colours**, **Index colours** (a hue per material index — useful when the real
colours are near-identical greys), **Clay** and **Normals**, with textures
toggleable.

### How it is shaded

A GGX specular lobe over a Lambert diffuse, lit by one sun and by an analytic
studio environment — a dark floor, a bright horizon band and an overhead
softbox. A car is mostly reflections, so the environment is what makes a panel
read as a panel; the same environment is drawn behind the model, dimmed, so
what it reflects is what you can see.

The files describe Lambert and Phong materials, which have to be mapped onto
that:

| In the file | Used as |
| --- | --- |
| `DiffuseColor` × `DiffuseFactor` | albedo |
| `SpecularColor` × `SpecularFactor` | reflectance at normal incidence |
| `Shininess` / `ShininessExponent` | roughness, `sqrt(2 / (exponent + 2))` |
| `Opacity`, `TransparencyFactor` | how much the surface hides |

A Phong specular colour scales a highlight — it is not a Fresnel reflectance,
and taken literally it makes a mirror of everything, since OBJ libraries
habitually write `Ks 0.9 0.9 0.9`. It is capped at 0.16, the brightest a
dielectric reaches, unless the file states a metalness outright. A `.blend`
does: its materials carry `metallic`, `roughness` and `specular`, so those are
read and converted rather than guessed at.

Colour is managed end to end: images upload as `SRGB8_ALPHA8` so the sampler
returns linear values, material colours are linear as written, shading happens
in linear light, and the result is tone-mapped through a filmic curve before
being encoded back to sRGB. Highlights roll off instead of clipping.

### Assigning materials

Files are often vague about how a surface should look. The Shelby's twenty
materials carry no properties at all — every one of them falls back to the same
grey — so the **Materials** tab lets you say what they are: a colour, how
metallic and how rough, and how much light gets through, with presets for the
usual surfaces. The file's own values are always kept, so *From file* puts any
material back exactly as it was read.

The list groups the render palette by material rather than by slot, which
matters more than it sounds: a scene of many parts repeats the same material
once per part, so the Shelby arrives as 62 slots that are really 20 materials —
`Chrome` alone is used by 24 of the 44 parts. Rows are ordered by how much of
the model each covers (`Chrome` 49.5%, `Carroserie` 13.1%), and hovering one
marks it on the model, which is the quickest way to find out what
`Material.002` actually is.

Editing is instant even on a 553,006-triangle scene: materials live in a
texture the shader reads per fragment, so a change is a few texels and the
geometry is never touched.

Assignments are remembered per file, and **Save assignment** writes them out as
JSON:

```json
{ "fbxtoolMaterials": 1,
  "materials": { "Carroserie": { "colour": [0.02, 0.05, 0.26], "roughness": 0.25 } } }
```

Drop that file back in — on its own or alongside the model — to apply it again,
so an assignment can travel with a model that does not carry its own.

### Transparency

A material below full opacity is drawn in a second, blended pass: solid
surfaces first so the depth buffer is finished, then the see-through ones with
depth read but not written, back faces before front faces so the far side of a
windscreen is laid down before the near side goes over it. Files with nothing
transparent never pay for the second pass.

How much a sheet hides is not only its opacity — it is also what it reflects,
and at a grazing angle glass reflects nearly everything, which is why a
windscreen turns opaque as it swings away from you. The blend follows that.

Transparency reaches the viewer from every format: `Opacity` and
`TransparencyFactor` in FBX, `d` and `Tr` in an OBJ material library, and the
alpha of a Blender material's colour. Both the Mercedes FBX and the `.blend` of
the same car carry it — `WindowsTint` at 0.5, `Lights_Glass` at 0.25 — so the
windows show the interior rather than a black panel.

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
- Mesh detail is read from the record structure (counts, layer elements). The
  Python side evaluates no geometry — no triangulation, transforms or bounding
  boxes; that happens in the web viewer.
- Encrypted FBX files are reported as such but not decrypted.
- The version table ends at 7700; newer stamps are described generically.

## Development

```sh
pytest                          # no dependencies beyond pytest itself
python3 tools/make_samples.py   # regenerate the generated files in samples/
python3 web/build.py            # rebuild web/dist/fbxview.html
```

The JavaScript and WebAssembly layers have their own harnesses, each run by
`pytest` and each usable on its own:

```sh
node web/test/units.js                        # transform maths, material mapping
node web/test/heap.js samples/cube_binary.fbx # the WASM bump allocator
node web/test/dump.js samples/cube_binary.fbx # the WASM reader's whole tree
node web/test/browser.js samples/*.fbx        # the built page in Chromium
node web/test/transparency.js glass.fbx       # reads pixels through glass
node web/test/materials.js samples/scene_parts.fbx   # the material list
```

`tests/fbxbuild.py` also writes `.blend` fixtures — a real header, file-blocks
and SDNA — so the container reader is testable without Blender installed.

The web tests skip cleanly when `clang` or `node` is unavailable. Point
`FBXTOOL_SAMPLE` at a real exporter's `.fbx` — and `FBXTOOL_BLEND` at a real
`.blend` — to also run the tests that need one; no such file is checked in.

`samples/cube_ascii.fbx` is checked in as source; `samples/cube_binary.fbx` and
`samples/scene_parts.fbx` are generated by the same minimal writer the tests
use (`tests/fbxbuild.py`), which covers typed properties, deflated arrays,
nesting, the null terminator and the footer.

## License

MIT
