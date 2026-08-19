# fbxtool

Inspect, render, edit and export 3D model files, with **no dependencies** and
without the Autodesk FBX SDK.

| Format | Support |
| --- | --- |
| **FBX** binary and ASCII, 6.x and 7.x | inspect, render, export |
| **Wavefront OBJ** (+ `.mtl`) | inspect, render |
| **COLLADA `.dae`** | inspect, render, materials from the `*.materials.json` beside it — the format BeamNG.drive ships its cars in |
| **glTF 2.0** (`.gltf`, `.glb`) | inspect, render, import, export; Draco decompressed |
| **Blender `.blend`** | inspect, render (`MVert`/`MPoly`/`MLoop` layout) |
| **3ds Max `.max`** | inspect, render — Editable Poly and Editable Mesh, materials, textures |
| **Assetto Corsa `.kn5`** | inspect, render, skins; embedded DDS decoded |

Every reader produces the same record tree, so all options, the analysis and
the viewer apply to all formats unchanged.

## Install

```sh
pip install .                  # installs the fbxinfo command
python3 -m fbxtool scene.fbx   # or run from a checkout, no install
```

Python 3.9+, standard library only (`struct`, `zlib`, `mmap`, `json`).

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

`fbxinfo` is the only entry point. Box drawing falls back to ASCII
automatically when the output encoding cannot represent it; `--ascii` forces it
everywhere.

### What gets reported

| Section | Contents |
| --- | --- |
| File | encoding, size, version stamp and product, 32/64-bit node offsets, footer and its version stamp |
| Metadata | creator, creation timestamp, file id, encryption type, originating and last-saving application |
| Global settings | axis system (up/front/right with sign), unit scale and name, time mode, time span |
| Record structure | total records, nesting depth, per-section counts, property histogram by type, stored array bytes |
| Definitions | declared object count, per-`ObjectType` counts, property templates |
| Objects | count by `Type (SubType)`, vertex and polygon counts, shading model, texture paths, cluster weights, curve key counts |
| Scene hierarchy | transform tree rebuilt from `Connections`, with geometry and materials as attachments |
| Connections | totals by kind (`OO`, `OP`), optionally each connection with both endpoints resolved |
| Animation | stacks, layers, curve and curve-node counts, stack durations, 6.x takes |
| Warnings | structural inconsistencies found while reading |

`--tree` prints the container itself. Array properties are summarised as
`*24 [d] deflate 87 B`; `--decode-arrays` also shows leading values.

## Format support

### FBX

- Binary and ASCII, versions 6000 to 7700 and beyond (unlisted stamps described generically).
- 6.x legacy layout: objects addressed by `Class::Name`, mesh stored on the `Model`, numbers written one property each, `Property` records with three strings, `Connect:` records.
- 7.x: UID addressing, `Geometry` records, array properties, `P` records.
- Node offsets widen to 64 bits at 7500.
- Full local-matrix composition: `T * Roff * Rp * Rpre * R * Rpost⁻¹ * Rp⁻¹ * Soff * Sp * S * Sp⁻¹`, node `RotationOrder`, geometric transforms, negative scale.
- UV and normal layers in `Direct` and `IndexToDirect`, per polygon vertex or per control point.
- Per-polygon material indices resolved through the connection graph.
- Encrypted files reported, not decrypted.

### Wavefront OBJ

- `v` / `vn` / `vt` / `f`, all five face-index syntaxes including negative indices.
- `usemtl` as a per-polygon material layer, `map_Kd` as a texture reference.
- `o` and `g` kept as separate parts; vertex pools gathered and renumbered per part.
- `.mtl` read from beside the file, or supplied separately.
- `d` and `Tr` for transparency.

### COLLADA `.dae`

- COLLADA 1.4.1, whichever prefix the file binds the schema to.
- `<polylist>` and `<triangles>`; `vcount` + `p` become an FBX polygon run with each polygon's last corner complemented.
- NORMAL and TEXCOORD sources read at the offsets their inputs state, as `IndexToDirect` layers; the `<vertices>` indirection followed to the position source.
- Texture coordinates **not** flipped — COLLADA measures V upwards, as FBX and OBJ do and unlike glTF.
- `<accessor>` strides read rather than assumed.
- Nodes placed by `<matrix>`, composed down the tree and decomposed to translation, Euler rotation and scale. The matrix is row-major acting on column vectors, so the translation is the last **column**; a negative determinant is kept as a negative scale.
- `<up_axis>` and `<unit>` become `GlobalSettings`.
- Materials from `profile_COMMON` — lambert, phong, blinn and constant — for a flat diffuse colour. Each part is connected only to the materials its own primitives ask for.
- **Materials from the file beside the model.** A BeamNG `.dae` carries a lambert stub and names one image for a car's eighty-odd; what its surfaces actually are lives in a `*.materials.json` in the same folder, read for both of the game's generations — the newer `baseColorMap`/`roughnessFactor`/`metallicFactor`/`clearCoatFactor`, and the older `colorMap`. Matched on `mapTo`, then `name`, then with Blender's `_001` duplicate suffix dropped.
- Base colour, normal and ambient-occlusion maps become texture records; roughness, metalness and base colour go on under a vendor prefix, and a clear coat becomes the coat the shader already draws.
- The sidecar names the picture its artist authored — `bolide_main_b.color.png` — where the game ships the one it converted, `bolide_main_b.color.DDS`, so a supplied image is matched on its name without the extension where the exact name is not there.
- Of 2,027 materials across the 88 cars that ship a sidecar, 537 are dressed from it, 341 are lights whose entries state nothing at all, and 1,149 are shared names defined in the game's own `common` package rather than beside the car.
- **Not read**: `library_animations` and `library_controllers`, neither of which is geometry; the `.cdae` beside a BeamNG car, which is the game's own compiled cache of the same model; the separate `roughnessMap` and `metallicMap` (the viewer wants the two in one picture, as glTF packs them); `opacityMap`; and the layers a material states beyond its first stage.

### glTF 2.0

- `.glb` and `.gltf`, with the `.bin` read from beside it or supplied separately.
- Reported: container, generator, meshes, primitives, triangles, nodes, materials, images, buffer views, accessors, component types, extensions.
- Interleaved attributes behind a `byteStride`; 8, 16 and 32-bit indices; sparse accessors; primitives with no indices.
- Nodes placed by matrix or by quaternion.
- Metallic-roughness mapped to material properties; V flipped on the way in and out.
- Extensions read: `KHR_materials_specular`, `KHR_materials_ior`, `KHR_materials_transmission`, `KHR_materials_pbrSpecularGlossiness`, `KHR_draco_mesh_compression`, `KHR_texture_basisu`.
- `EmissiveColor`, `AlphaMode` and `AlphaCutoff` read.
- Every map becomes its own `Texture` record under the FBX property name for its slot, with the sampler's wrap modes.

### Blender `.blend`

- Reported: Blender version, pointer size, endianness, compression, file-block counts by code, SDNA, every datablock with name and type.
- Meshes from `MVert`, `MLoop`, `MPoly` and `MLoopUV`; materials from the mesh slot table.
- Every offset and struct size computed from the file's own SDNA.
- Gzip-compressed files unwrapped; Zstandard detected and reported.
- Releases that replaced these arrays with generic attributes (3.6+, 4.0) detected and reported rather than guessed at.

### 3ds Max `.max`

- Microsoft compound file container; per-stream gzip (2022+) undone; files truncated mid-sector read to the end.
- Geometry: **Editable Poly** (`0x0100` vertices, `0x011a` n-gon faces, `0x0128`/`0x012b` UVs) and **Editable Mesh** (`0x0914`, `0x0912`, `0x2394`/`0x2396`).
- Node names, class table, plugins, parent links (`0x0960`), Dummy helpers.
- Placement from Position/Rotation/Scale controllers down to per-axis float controllers, plus the node-to-mesh offset.
- Smoothing groups (full 32-bit word) and material ids read as separate fields.
- **Symmetry** modifier applied — mirror plane, weld threshold, reversed winding, seam faces not duplicated.
- **TurboSmooth** not run; the viewer's own subdivision covers it.
- Materials: Standard (Blinn, Phong, Oren-Nayar-Blinn, Anisotropic), **VRayMtl**, **CoronaMtl** / **CoronaLegacyMtl**, **Multi/Sub-Object**, **Blend**, **VRayBlendMtl**, **CoronaLayeredMtl**, **CoronaColor**, Falloff.
- Diffuse, reflection, refraction (as the opposite of opacity), glossiness, reflection index of refraction, clear coat.
- Material names read from `0x5431`, `0x0FA0` and `0x4000`.
- Per-class texture slot numbering for VRayMtl and CoronaMtl; unknown classes fall back to first-colour-is-diffuse.
- Texture file names resolved through `FileAssetMetaData2` / `FileAssetMetaData3`.
- **Not read**: modifier stack beyond Symmetry, edge creases, the Slice option, Shell, uncollapsed primitives (Box, Line) and plugin classes (counted and named only).

### Assetto Corsa `.kn5`

- Both versions in the wild; texture table, material table and node tree read straight through.
- Reported: scene node/mesh counts and depth, geometry counts, inactive nodes and hidden meshes, material count, metals, dimmed materials, shader names, embedded texture count and size.
- Interleaved vertices (44 bytes, 76 skinned), unpacked lazily.
- V stored negated and undone on the way in, leaving it upwards in `[0, 1]` as the other readers write it; Direct3D row-major transforms decomposed, negative determinant kept as negative scale.
- **Materials**: `txDiffuse` as albedo, `ksSpecularEXP` as shininess exponent, `ksSpecular` as highlight strength, `fresnelC` / `fresnelEXP` / `fresnelMaxLevel` as a Schlick Fresnel with a ceiling. Every named parameter also carried under its own name.
- `ksAmbient` and `ksDiffuse` read as how much of the light a material takes, against a 0.5/0.6 baseline.
- Metalness inferred from reflectance at normal incidence (dielectrics below ~17%, metals above ~50%); nothing inferred from a see-through surface.
- Texture slots: `txDiffuse`, `txNormal`, `txGlow`, `txDetail` mapped; everything else keeps the game's own name.
- `txDetail` applied as a tiled grain, neutral at its own average.
- Meshes marked invisible and nodes marked inactive are read, counted, reported and not drawn; visibility descends.
- Textures carried on the `Video` clip and shared between materials; textures a material names but the file lacks are listed.
- `AlphaBlend` and alpha-tested materials reported with their `AlphaMode`.
- **Lamp lens colours** read from `GLASS_COLOR` in the whole `extension/` folder, keyed by mesh; a white or grey tint darkens, a saturated one replaces and reduces what shows through.
- **Protected cars** detected by the `__AC_SHADERS_PATCH_KN5ENC_v1__` marker and by triangle winding disagreeing with vertex normals; reported, never decrypted.
- **Not read**: `animations/`, `data.acd`, `.knh` hierarchies, the encrypted half of a protected car.

#### Skins

- Every folder under `skins/<name>/` is offered in the viewer, replacing the car's textures by name.
- Which materials are the paint, in order of trust: the skin's `ext_config.ini`, the car's `extension/ext_config.ini`, then what the car's other skins agree on. Both `CarPaintMaterial = …` and `[Material_CarPaint_*]` + `Materials = …` spellings.
- Colours from `cm_skin.json` (`#AARRGGBB`), from `ChameleonColorA` in `ext_config.ini`, or from the `livery.png` chip.
- `enabled` is the paint shop's switch, not a claim about the car: a stated colour is the paint either way, except plain white or anything with no channel above 8, which are what an untouched picker holds and are handed to the chip instead.
- The chip is read only where nothing landed on the car and the skin does not bring the paint's own texture; the commonest colour over the upper half, 32 steps a channel.
- Materials and colours paired by order; one colour is spread over however many materials are named.
- Names held against the model — a material the car has not got is not painted.
- The paint **tints** its texture rather than replacing it.

## Web viewer

```sh
python3 web/build.py          # -> web/dist/fbxview.html
```

One self-contained HTML file — WebAssembly, CSS and JavaScript inlined. Runs
from `file://` with no server, no CDN and no network; nothing is uploaded.

| Layer | Where it runs |
| --- | --- |
| DEFLATE, binary record walking, triangulation, normal generation | WebAssembly (`web/src/fbx.c`, freestanding, no libc, no imports) |
| ASCII FBX, OBJ, `.blend` and `.max` reading, analysis, report | JavaScript |
| Rendering | WebGL2, orbit camera, per-material shading |

### Opening files

- Drop a file, drop a whole folder, or use **Open folder**; a folder is read as far as 512 files, models and their images first.
- The model is picked by extension, not by order; where a folder holds the same scene several ways, the one with the most to draw opens (a subdividing cage counted for what it becomes, ties within a tenth broken by what else each file carries).
- Where the opened file has no maps at all, materials are borrowed from a sibling file, matched part by part on punctuation-stripped names.
- Images matched by file name rather than path, with URI escapes undone; supplied with the model or afterwards.
- Missing images named in the viewport and in the Materials tab.

### Scene

- Whole-scene assembly with instancing — one mesh shared by several models drawn once per model.
- **Up axis** picked from the geometry where it clearly disagrees with the declared `UpAxis`, shown, overridable, remembered per file.
- **Flip X / Y / Z**, remembered per file, written into the export; winding switched for an odd number of mirrored axes.
- **Turn** — a quarter turn of the camera about the up axis, remembered per file, never exported.
- **Explode** slider, in the vertex shader, with the shadow pass and ground plane following.
- **Click to select** a part by index buffer read-back; part name, triangle count, bounds and materials shown.
- **Delete** (`Delete`) and **split** a part — `split` by connected geometry, `by material` by the file's own grouping. Held as a segment list, so edits are cheap and re-splittable.
- **Smooth ×1 / ×2** — Catmull-Clark over polygons before triangulation, with open borders smoothed as curves, normals and UVs subdivided linearly. Automatic level held to a 384 MiB vertex-buffer budget, and said when held back.
- `Ctrl+Z` / `Ctrl+Y` undo and redo; **Restore all** puts the scene back.
- **Ground** — a floor at the model's lowest point with a self-shadowing depth-map shadow; toggleable.
- WebGL context loss and out-of-memory reported rather than failing silently.

### Materials

- **Materials** tab: colour, metalness, roughness, transparency, presets, rename, *From file*, **Clear all**.
- Grouped by material rather than by slot, ordered by how much of the model each covers, hover to highlight.
- Per-row image list — slot, file, and whether it arrived — with `×` to drop a map and `+` to take it back.
- Change what a part is made of, including **+ new material**.
- **Save assignment** writes JSON (`fbxtoolMaterials`), keyed on the file's own material names and on model UIDs/names; drop it back in to reapply, in any order. Materials the file lacks are built.
- Shading modes: **File colours**, **Index colours**, **Clay**, **Normals**, textures toggleable.

### Shading

- GGX specular over Lambert diffuse, one sun plus an analytic studio environment, drawn behind the model.
- `Shininess` ↔ roughness as the fourth root of `2 / (exponent + 2)`, both directions.
- Renderer-native parameters preferred over the Phong approximation, matched with the vendor prefix and separators removed: `base_color`/`baseColor`, `roughness`/`specularRoughness`, `metalness`/`metallic`, `opacity`/`transparency`.
- Reflection **index of refraction** read where stated (`reflection_ior`, `fresnelIor`, `ReflectionIor`) and turned into `((n-1)/(n+1))²`; Phong specular colour otherwise capped at 0.16.
- **Clear coat** as a second specular lobe with its own roughness, scaled by the blend amount, taking its share out of what reaches the base.
- Bump maps told from normal maps by inspection; tangent frame recovered per pixel from screen-space derivatives, so no mesh tangents are needed.
- **Transparency** in a second blended pass — solid first, then back faces before front faces, depth read but not written. Coverage from `Opacity`, `TransparencyFactor`, OBJ `d`/`Tr`, Blender alpha, or per-pixel from a blended material's colour texture. Cut-out materials tested against alpha and kept in the solid pass. Files with nothing transparent never pay for the second pass.
- Colour managed end to end: sRGB upload, linear shading, filmic tone map, sRGB out.

### Image decoding

| Format | What is decoded |
| --- | --- |
| **DDS** | BC1, BC2, BC3, BC4, BC5 (third channel rebuilt), BC7 (all eight modes); uncompressed surfaces by channel mask; DX10 headers. BC6H and floating-point declined. |
| **KTX2 / Basis** | ETC1S, including alpha slices (`web/src/ktx2.c`) |
| **Draco** | EdgeBreaker (standard and valence) and sequential connectivity, rANS tagged and raw, attribute seams, depth-first and prediction-degree traversal, difference / parallelogram / constrained multi-parallelogram / portable texture coordinate / geometric normal predictions, wrap and octahedral transforms (`web/src/draco.c`) |
| **PSD** | the flattened composite, raw and PackBits; 16-bit, CMYK and PSB declined |

Colour and alpha are kept unpremultiplied all the way to the GPU.

## Export

**Export** writes what is on screen — assigned materials, deleted and split
parts included.

| | |
| --- | --- |
| `.glb` | one self-contained binary file |
| `.gltf` + `.bin`, zipped | the same document with readable JSON, both in one `.zip` |
| `.fbx` | binary FBX 7.4 |

- Hierarchy, names, parents and instancing kept; each mesh written once in its own local space.
- glTF: one primitive per material, materials covering no triangles dropped, primitives welded, V flipped, up axis and units on the root node's matrix.
- FBX: several materials per mesh with a per-polygon index, up axis and units in `GlobalSettings`, nodes decomposed to translation/rotation/scale with mirrors kept as a negative X scale, arrays deflated where that helps, textures embedded once per `Video` record.
- Textures embedded; PNG and JPEG passed through untouched, everything else encoded as PNG by the built-in writer (not `canvas.toBlob`, which premultiplies). Alpha dropped where it says nothing.
- Deflate parallelised across workers, with a single-threaded fallback.
- `txDetail` grain baked into the base colour on the GPU, with a CPU fallback that agrees byte for byte.
- Bump maps converted to normal maps on the way out.
- Reports what it left behind: materials removed by name, nodes removed, nodes renamed, and any map a material names that was not supplied.
- Zip writer: local headers, central directory, `deflate-raw`, stored where deflate does not help. No ZIP64.
- Checked against the **Khronos glTF-Validator** and re-opened in the page on every sample.
- **Not exported**: animation, skins, morph targets, cameras, lights, tangents, vertex colours, second UV sets. Geometric offsets are baked into vertices.

## Library

```python
from fbxtool import read_fbx, analyze

doc = read_fbx("scene.fbx")
print(doc.encoding, doc.version)          # 'binary' 7400
print(doc.wide_offsets, doc.has_footer)   # False True

info = analyze(doc)
for obj in info.objects:
    print(obj.uid, obj.kind, obj.display_name, obj.detail)
```

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

The record tree is reachable directly through `doc.root` — `path()`,
`path_value()` and `walk()`. Array payloads are **not** decoded by default,
only measured; pass `load_arrays=True` (and optionally `max_array_values=N`).

## FBX versions

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

Unlisted stamps are still reported, with the dotted version and the layout
flags derived from the number.

## Damaged files

Structural problems are collected as warnings rather than raised, so a partly
corrupt file still produces a report — mismatched property-list lengths,
out-of-range or inconsistent end offsets, unreadable array payloads, a missing
or mismatched footer, and for ASCII unclosed braces, stray `}` and records
without a `:`.

Only a file that cannot be identified at all, or whose property stream is
undecodable, raises: `ParseError` / `UnsupportedFormatError`, both subclasses
of `FbxError`.

## Limitations

- Nothing writes OBJ or `.blend`; nothing on the Python side writes anything. The web viewer exports glTF and FBX.
- The Python side evaluates no geometry — no triangulation, transforms or bounding boxes; that happens in the web viewer.
- Encrypted FBX files are reported, not decrypted.
- The version table ends at 7700; newer stamps are described generically.
- Deletes and splits last only for the session; assignments remember whole parts only.

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
node web/test/ground.js samples/scene_parts.fbx      # the floor and its shadow
node web/test/gltf.js samples/cube_textured.fbx      # export, then validate it
node web/test/subdivide.js model.fbx                 # smoothing through the module
node web/test/smoothing.js samples/cube_binary.fbx samples/scene_parts.fbx
node web/test/gltfin.js samples/cube_textured.fbx    # export, then read it back
node web/test/reload.js a.fbx b.fbx                  # one file replacing another
node web/test/parts.js samples/scene_parts.fbx       # the explode, and picking
node web/test/flip.js samples/scene_parts.fbx        # mirroring, and its winding
node web/test/turn.js samples/scene_parts.fbx        # facing the other way
node web/test/skin.js <car folder> <other.kn5>       # putting a skin on a car
node web/test/drop.js samples/pyramid.obj samples/pyramid.mtl samples/checker.png
node web/test/edits.js samples/Shelby.fbx            # deleting and splitting
```

`tests/fbxbuild.py` writes `.blend` and glTF fixtures, so those readers are
testable without Blender or an exporter installed. The Draco fixtures in
`samples/draco` and the KTX2 fixtures in `samples/ktx2` are encoded by Google's
and Binomial's own encoders and checked against their own decoders; those
packages are test-time oracles only — nothing ships with a dependency.

The web tests skip cleanly when `clang` or `node` is unavailable. Building the
module needs `clang` **and** `wasm-ld`, which ships with LLVM's `lld` rather
than with clang itself; `web/build.py` finds it beside clang or in the
toolchain directories, and says what is missing if it cannot.

## License

MIT
