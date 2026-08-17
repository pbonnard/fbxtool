# fbxtool

Inspect model files and report what version they are and what is inside them,
with **no dependencies** and without the Autodesk FBX SDK.

| Format | Support |
| --- | --- |
| **FBX** binary and ASCII | full — inspect and render |
| **Wavefront OBJ** (+ `.mtl`) | full — inspect and render |
| **glTF 2.0** (`.gltf` and `.glb`) | full — inspect, render and export; Draco-compressed geometry is decompressed |
| **Blender `.blend`** | inspect and render, for the `MVert`/`MPoly`/`MLoop` layout |
| **3ds Max `.max`** | inspect and render — Editable Poly and Editable Mesh, with materials and the textures they name |
| **Assetto Corsa `.kn5`** | full — inspect and render, with the textures embedded in it decoded from DDS |

OBJ, glTF, `.blend`, `.max` and `.kn5` are normalised into the same record tree
as FBX, so every option and the viewer apply to them unchanged.

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

`o` and `g` are the file's own parts, and are kept apart: a car written as 164
groups reads as 164 parts rather than one mesh, which is what lets it be
exploded, picked at, edited part by part, and matched against the same scene
saved in another format. OBJ addresses one pool of vertices, normals and
texture coordinates from anywhere in the file, so a part is not a slice — each
pool is gathered as it is referenced and renumbered from zero, and every part
is connected to the whole material palette in palette order, since a
per-polygon material index counts the materials on that part's own model. A
file naming no parts at all is one part, as it always was; only a change of
name starts another, so `o Body` followed by `g Body` is one.

### glTF 2.0

`fbxinfo model.glb` — or `model.gltf`, whose `.bin` is read from beside it —
reports the container, the generator, and what the file holds: meshes,
primitives and triangles, nodes, materials, images, buffer views and accessors,
the component types in use, and the extensions the file names.

A `.glb` says what it is in its first four bytes. A `.gltf` is JSON, and the
only thing telling it from any other JSON is the `asset` block the
specification requires — which is looked for in the whole document rather than
in a head. JSON has no prescribed key order, and an exporter that sorts its
keys writes `accessors` first: pretty-printed one number to a line, that array
is 132 KB in a Sketchfab export of an E-Type, so the block that names the file
sits a long way past any sniffing window. Recognising it from a head alone is
how such a file gets refused for being what it is.

The mapping is the awkward part, since glTF stores what a graphics API wants
rather than what a scene description wants. Each primitive becomes one
`Geometry` and one `Model`, since a primitive has exactly one material; the
index list becomes an FBX polygon run with every third index complemented;
`POSITION` and `NORMAL` become `Vertices` and a `ByVertice` normal layer; and
`TEXCOORD_0` becomes a UV layer with V flipped, glTF measuring it downwards
from the top. Metallic-roughness becomes the material properties the rest of
the tool already reads — `DiffuseColor` and `SpecularColor` split by
metalness, and roughness back to a shininess exponent. What a file states
beyond that is read too: `KHR_materials_specular` for a tinted reflectance,
`KHR_materials_ior` for a dielectric that is not the assumed 4%,
`KHR_materials_transmission` for glass written over an opaque material, and
`KHR_materials_pbrSpecularGlossiness` — the older exporters' way of describing
a surface, where the metallic-roughness block beside it is only a stand-in.
What a material gives off and how it asked to be blended are read as
`EmissiveColor`, `AlphaMode` and `AlphaCutoff`: nothing here edits either, but
a material whose declared blending is not read is a badge that comes back a
solid rectangle. Every map a material wears becomes its own `Texture` record,
under the FBX property name for the slot it fills — `DiffuseColor`,
`NormalMap`, `AmbientOcclusion`, `EmissiveColor`, `MetallicRoughness` — with
the sampler's wrap modes beside it. Only the base colour is ever drawn; the
rest are read so that nothing downstream has to pretend the file had no normal
map.

Attributes may be interleaved behind a `byteStride`, indices may be 8, 16 or
32 bits, and a *sparse* accessor may overwrite some of what a buffer view
holds — all of which are handled, since real exporters use all of them.
Accessors are decoded only when the arrays are wanted, so a listing reads the
headers and nothing else. A node placed by a matrix and one placed by a
quaternion both come out as the Euler angles FBX writes.

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

### 3ds Max files

`.max` has no specification, no SDK-free reader and no documentation. What is
here was worked out from the files themselves, and it reads them: geometry,
node names and placement, the class table, the plugins, and every texture the
scene names with the path it had on the machine that made it.

A `.max` is a **Microsoft compound file** — the OLE2 container Word and Excel
used — holding a handful of streams. The scene is one of them, and it is a
tree of chunks written by each plugin's own save routine:

```
uint16 id
uint32 length          — counts its own header; bit 31 = holds child chunks
uint64 length          — when the 32-bit one is zero; there the flag is bit 63
```

The scene stream is a flat list of entities, and the rule that unlocks it is
that **a top-level chunk's id is its class**, indexing the class table, while
its *position* in the list is how other entities name it. So the 164th chunk
with id 31 is the 164th Editable Poly, and a node that refers to entity 648
means the 649th chunk. Entities point at each other through `0x2034`, an array
of indices, and `0x2035`, an array of (key, index) pairs where the key says
what the reference is *for* — 0 the transform, 1 the object, 3 the material.

Two geometry classes are read, and they share nothing but the block they sit
in:

| | Editable Poly | Editable Mesh |
| --- | --- | --- |
| vertices | `0x0100`, a flag word then x, y, z | `0x0914`, three floats |
| faces | `0x011a`, n-gons | `0x0912`, triangles |
| a face is | variable length | twenty bytes |
| UVs | `0x0128` + `0x012b` | `0x2394` + `0x2396` |

The face record of an Editable Poly is where the work was:

```
uint32 degree
uint32 vertex[degree]
uint16 flags
if flags & 0x01:  uint32                    the smoothing groups
if flags & 0x08:  uint16                    the material id
if flags & 0x10:  uint32
if flags & 0x20:  uint32 [2 * (degree - 3)] how the n-gon triangulates
```

Nothing is aligned. A quad is 34 bytes, so every second face starts on an odd
half-word, and a reader that assumes four-byte alignment gets three faces in
before it reads a vertex index as a degree. The `0x20` payload is what makes
the record variable: a mesh of nothing but quads parses under a fixed 14-byte
trailer and hides the rule until the first pentagon.

Where a part stands takes a walk of its own. A node's transform is a
Position/Rotation/Scale controller, and a Position XYZ holds nothing itself —
it refers to three float controllers, one per axis, each wrapping its single
value a level further down. A reader that looks only at the controller's own
chunks finds nothing and leaves the part at the origin. Separate from that is
the offset between a node and its mesh, which is what an FBX writes as the
geometric transform. Read both, and all 164 parts of the Smart land exactly
where its FBX export puts them — translation, rotation, scale and offset alike.

Separate again is what a node hangs off, in `0x0960`. A controller says where
a part stands *relative to its parent*, so a scene read as though every node
hung off the root puts each child at the world origin of its own local offset:
a Hummer whose wheels are linked to its body comes out with the wheels below
the ground and the body in the air. Read the link and the nine parts of that
car land where its own `.obj` export puts them, to within the decimal the
`.obj` rounds to.

Every node gets a record, including the ones that draw nothing. A **Dummy** is
a helper with no geometry at all, and it exists precisely to place what hangs
off it — so left out, its children have nothing to name and fall back to the
scene. A Ferrari that groups each wheel under one came out with all four
stacked at the origin, inside the car. A node with no mesh is written as a
`Null`, which is what an FBX calls the same thing.

A scene is usually modelled smooth and stored as its cage: 157 of the Smart's
164 parts carry a TurboSmooth, ×2, so what the file holds is a fraction of what
was drawn. The report says so, and the viewer opens on the rounds the modifier
asks for — 217,930 vertices become 6.4 million triangles in about half a
second, which is the car rather than the cage.

3ds Max 2022 and later can gzip each stream, which is undone on the way in —
in the browser by the same WebAssembly inflater that unpacks an FBX array.
Files that stop mid-sector are read to the end rather than refused; writers do
it, and the tail of one sector is no reason to lose 98 MB.

Materials come across too. A node names the material it wears through the same
typed reference list, and the material keeps its colours in parameter blocks:

```
uint16 id
uint16 type            2 for a colour
...flags
float  r, g, b         on the end
```

A renderer's own material is not one of the shaders 3ds Max ships, so none of
those layouts fits it and the surface came out as whatever colour the walk met
first. On a car that renders every window solid black: a V-Ray glass has a
black diffuse — glass takes its look from what it refracts, not from what it
scatters — and nothing said it was see-through. **VRayMtl** is now read for its
diffuse, its reflection and its refraction, that last as the opposite of an
opacity, which is the only thing in a `.max` that carries transparency at all.
The ids come off the files rather than out of any documentation: fifty-five
VRayMtl blocks across three car scenes carry the same eight colours under the
same ids, and id 5 settles itself — it is stored as a colour, which a
glossiness never is, and it is exactly zero on fourteen of twenty materials in
one car, implausible for a glossiness and exactly right for an opaque surface.

**CoronaMtl** is read too, and it took two things rather than one. Corona keeps
a level beside every colour instead of folding it in, so a channel is the pair
— a white refraction at level 0 is a solid surface, and the colour on its own
says the opposite. And it writes its numbers in shorter chunks than the shaders
3ds Max ships do: a scalar of nineteen bytes where the reader started reading
at twenty-one, so every number describing the surface fell under the cutoff and
was thrown away, the glossiness with it. A slot for a map is shorter still and
holds no value at all — read as a float it is 2.0, which would pass for a level
— so what tells the two apart is the type and not the size. Its ids: 101/102/103 the diffuse,
reflection and refraction, 121/122/123 their levels, 180 the glossiness. Its
name lives in the same block every material carries, written under an id of its
own — 0x0FA0 rather than 0x5431 — which is why a Corona scene used to come out
as a list of numbered materials while its V-Ray twin came out named. A
`CoronaLegacyMtl` writes the same block and reads the same way.

Those ids were settled against the answer rather than guessed at. Five of the
cars in one library ship a Corona scene *and* a V-Ray scene of the same model,
with the same material names in both, and V-Ray was already read. Of the 176
materials that appear in both, 174 come out with the same diffuse, the same
specular, the same glossiness and the same opacity from either file — and the
two that differ are a windscreen and a body the artist tuned separately for
each renderer, which the rest of their own numbers agree about.

Which id means *diffuse* is otherwise the plugin's own business — the names
live in the DLL and not in the file — but the file does say *which plugin*, and
for the shaders 3ds Max ships that is enough. A material refers to its shader, the shader to the block, and the class
table names the shader; the shaders 3ds Max itself ships agree on the front of
the block (0 ambient, 1 diffuse, 2 specular, 3 self-illumination) and publish
where their floats fall. So a **Standard** material is read for its colour,
what it reflects, its specular level and its glossiness — the last as the
shininess exponent 3ds Max's own exporter would write, glossiness × 100.
Oren-Nayar-Blinn is Blinn with two parameters added on the end, so the Blinn
family reads alike; Anisotropic keeps its specular level where Blinn keeps its
glossiness, and is read its own way round.

A plugin's own material that has not been studied — VRayLightMtl,
CoronaLightMtl, an Arnold surface — is not in that table and is not read as
though it were: it keeps the older rule, **the first colour-valued parameter is
the diffuse**, and nothing is claimed about its finish. What a VRay material
*reflects* sits two parameters further on with another between them, and
reading it by a shader's layout would put the reflection where the colour goes.

The same care applies to which *map* a material wears. A material's pictures
hang off its references, and taking the first one found is right only until a
material has more than one. A **VRayMtl** keys them on itself, behind its six
parameter blocks: 7 the diffuse, 8 the reflection, 10 the bump — and across one
car's seventeen the first map most of them carry is the bump, which taken as
the colour paints a black tyre pale grey with its own tread. A **CoronaMtl**
keys them on its parameter block instead and numbers them from zero: across
another car's sixty-one, 0 held every `_color` file, 1 every `_refl`, 3 the
glass and the masks cut into it, and 6 all thirteen normal maps. Nothing else
in the file says which is which — the slot parameters are written byte for byte
identical whether they are filled or not — and read the old way that car came
out with the mask cut into its sunroof painted across the roof in red, its
windows shaded by their own normal maps, and violet round every light. A class
whose numbering has not been read off the files keeps the older rule.

And a slot does not have to hold a picture. Corona fills one with a
**CoronaColor** — a map that is nothing but a colour, kept at parameter 52 —
and where a slot is filled at all, the colour beside it in the block is a
placeholder that means nothing. Read that placeholder instead and a BMW's
tyres come out white, and so does every rubber seal and trim on the car:
533,856 triangles of it, which is what made a black body look painted in
patches. The slot's colour goes in *before* the level is applied, since a
diffuse switched off is switched off whichever colour it was given — read the
other way round, a car paint with no diffuse at all turns white.

A material that names other materials is two different things and they must not
be confused. A **Multi/Sub-Object** is a numbered list, and a face's material id
picks a slot out of it. A **Blend** is a surface of its own, made by mixing
others, and a face wearing it wears one thing. Read the second as the first and
it is written as no material at all — and every slot behind it moves up to fill
the gap, so of the forty-four that Audi's body wears, the three holding a Blend
shifted everything after them and each panel was painted out of the wrong tin.
A Blend also takes its look and its maps from the base coat it is built on:
what its own blocks hold is the mask that mixes its ingredients, and read as a
colour that is a tyre painted with the map that blends its dirt in.

### The one modifier that is run

The stack is not run, with one exception. **TurboSmooth** only changes how
smooth a thing is, and the viewer's own subdivision covers it. **Symmetry**
changes what is *there*: the artist models half a car and the modifier mirrors
it, so a reader that skips it comes away with half of everything. A Ferrari
250GT was missing 41,531 vertices that way — forty-two of its parts arrived as
one side of themselves, while the eighty-two without the modifier were exact to
the vertex against 3ds Max's own export of the same scene.

So Symmetry is applied. It mirrors about the object's pivot, which sits at
minus the object offset in the mesh's own coordinates — the plane that, for all
forty-two, gives back exactly the width the export has. A vertex within the
modifier's threshold of the plane belongs to both halves and is snapped onto
it, which is the weld; keep two and the seam is a crack that shades as a hard
line down the middle of a panel that has none. Mirroring reverses which way
round a face is wound, so the copies are wound backwards, and a face lying
wholly on the seam is not copied at all.

Two things are still left alone: the **slice** the modifier can take along its
own plane, which matters only for a part that straddles it — two of that
Ferrari's forty-two — and **Shell**, which gives a surface thickness and leaves
six of its parts a single skin.

### Checked against 3ds Max's own export

One car ships both ways — an Audi SQ8 as four `.max` scenes and as 3ds Max's
own `.FBX` export of the same two, which makes the export an answer key for the
reader. Diffing the seventy materials each produces settled three things that
guesswork had left wrong.

A **VRayMtl keeps its reflection glossiness at parameter 3**: for every one of
the seventy, the number the export states is the number parameter 3 holds.
Without it every V-Ray surface fell back to one middling roughness, so a
windscreen was as satin as a bumper. The **exponent an FBX carries is
`2 ** (10 × glossiness)`** — 0.3 becomes 8, 0.65 becomes 90.51, 1.0 becomes
1024, exact to four decimals across all seventy — where this used to write the
glossiness as a percentage and put a mirror and a matte panel within a few of
each other. And a **material's name can live under 0x4000** as well as the two
ids already read: that is where a Blend, a Standard and a VRayCarPaintMtl keep
theirs, so those came out numbered while everything beside them was named — an
Audi's body being a Blend, `vray AUDI body grey` was in the file all along.

Read this way the two agree on every colour, every reflection and every
exponent of all seventy materials, to the last decimal the exporter's floats
carry. The two properties that still differ are spellings of the same thing: a
`SpecularFactor` of 1 against no factor at all, and an `Opacity` of 0.36
against a `TransparencyFactor` of 0.64.

### Bump and normal maps

A car is modelled smooth and detailed by its maps, so a viewer that draws only
the colour draws a tyre with no tread and a seat with no grain. The slot holds
two different things and the file never says which: a **normal map** states the
direction outright, three channels of a unit vector, and a **bump map** states
a height whose slope is the direction. Told apart the wrong way round, a height
read as a direction tips every normal towards the same corner. They are told
apart by looking: a tangent-space normal map is overwhelmingly blue with red
and green around the middle, which is the one thing a grey image cannot fake
however bright or dark it is.

Neither needs tangents on the mesh, which is as well because a `.max` has none.
The frame a map is written in — U to the right, V up, the normal out — is
recovered per pixel from how the position and the texture coordinate change
across neighbouring pixels, which is enough to solve for it. A height becomes a
slope by central differences, one texel either side.

An export cannot be so relaxed: glTF's `normalTexture` is a direction, and a
height written straight into it says every surface faces the way its own
brightness points. A height map is converted on the way out, by the same
differences and the same strength the viewer shades it with, so what the file
says is what the screen showed.

A **Multi/Sub-Object** becomes one material
per slot, and a face's material id picks between them. The Materials tab is
where a surface the file does not describe gets its finish, and an assignment
saved there is remembered for the file.

Textures are stranger: the file name is not in the scene at all. A parameter
block carries a sixteen-byte identifier, and `FileAssetMetaData3` maps that to
a name and the path it had on the machine that made it — `F:\rcartton\Smart 1
Brabus\specular.jpg`. The reader ties the two together and names the file, so
the image loads the way an `.obj`'s does: drop it in beside the model. A 3ds
Max before 2013 writes the same table as `FileAssetMetaData2`, with the path
alone where the newer one keeps a name in front of it, and both are read.

A `.max` stores no normals — only the cage — so what it is shaded by comes from
its **smoothing groups**: a bitmask per face saying which groups that face is
in. Two faces meeting along an edge share a normal where they share a group and
keep their own where they do not, which is how a car body has both a smooth
flank and a crisp shut line. They are the whole of the `0x01` word, all
thirty-two of them, and the material id is a field of its own behind `0x08` —
read as one word holding both, a body of sixteen materials comes out wearing
seven, two of them past the end of its own list, and every group below the
seventeenth is masked away besides. Measured against the same scene's `.obj` — 3ds Max's own bake of the
same modifier, with the normals it wrote — reading them recovers 84% of the
detail that masking them away had cost.

The level the file asks for is a ceiling rather than an instruction. The mesh
the viewer draws is unindexed and carries thirty floats a triangle — position,
normal, texture coordinate, material and part, three corners each — so its
weight on the card is a straight multiple of its triangles, and one round of
subdivision quadruples it. A Pontiac asking for ×1 is 4.65 million triangles
and 533 MiB of vertex buffers, which a real Firefox drew nothing at all for:
the model still read, the parts were still counted, the line still said how
many triangles were in it, and the viewport was empty. So the automatic level
is held to 384 MiB — counted over the parts that are drawn rather than the
meshes they share, and from corners rather than faces, since a cage of
five-sided faces subdivides to more than one of quads — and the line says what
was held back. Turning it up is one click, which is the right way round for a
choice nobody asked for.

The viewer says when it cannot draw, too. There was no `gl.getError`, no
`webglcontextlost` and no `isContextLost` in it, so a card that could not find
the room failed in silence; the card gives way a frame or more after the upload
that caused it, so it is said when it happens rather than when it is asked for.

**What is not decoded**: the modifier stack is not run, so a scene modelled
with TurboSmooth gives its cage — which is what the viewer's own smoothing is
for. Edge creases are not read, so subdivision rounds what 3ds Max would have
held sharp; the iteration count is taken as the highest any part asks for and
applied to all of them, which over-smooths the few that ask for less or none.
Primitives nobody collapsed (a Box, a Line) and classes from plugins are
counted and named in the report but have no vertices here.

Read on twelve car scenes from as many sources — 2016 to 2018 releases, 30 MB
to 449 MB, compressed and not — all twelve give geometry: 17 to 209 objects
each, and up to 2,025,975 vertices in 6.9 s. Eleven give materials, 9 to 67
apiece; the twelfth assigns none to any node, which is what its nodes say and
not something to work around. On the one that ships an FBX
export of the same scene beside it, the two agree exactly: 217,930 vertices and
the same bounds to the decimal.

### Assetto Corsa files

`fbxinfo car.kn5` reads Assetto Corsa's own model file — what ksEditor writes
out of 3ds Max for the game to load. One binary file holds the whole car:
its textures, its materials with every shader parameter, and the node tree
that places them.

```
$ fbxinfo f_e63.kn5
File
────
  Path:        f_e63.kn5
  Size:        78.9 MiB
  Format:      Assetto Corsa kn5
  Encoding:    binary
  kn5 version: 6
  Scene:       889 nodes, 396 meshes, 7 deep
  Geometry:    412,529 vertices, 454,543 triangles
  Not drawn:   11 inactive node(s), 6 hidden mesh(es)
  Materials:   150 (150 worn by a mesh)
  Metals:      16 reflect more facing you than a dielectric can
  Dimmed:      115 take less of the light than a plainly lit surface, down to none at all
  Shaders:     ksBrakeDisc, ksBrokenGlass, ksPerPixel, ksPerPixelAT, ksPerPixelAT_NM, ksPerPixelAlpha …
  Textures:    135 embedded, 58.8 MiB — 111 DDS, 24 PNG

Global settings
───────────────
  Axis system: up +Y, front +Z, right -X
  Units:       100 cm per unit (metres)
```

There is no specification and nothing above the record level says how long
anything is: the file is a texture table, a material table and a node tree,
read straight through from the first byte to the last. A field mis-sized
anywhere walks off the whole of the rest — which is why the tests check that
the cursor lands exactly on the end of the file, and why the reader refuses a
node class it does not know rather than carrying on.

Both versions in the wild are read; version 6 puts one more number in the
header and moves nothing else. A mesh's vertices are interleaved — position,
normal, UV and tangent, 44 bytes apiece, or 76 with weights on a skinned one —
and are unpacked only when arrays are asked for, which is what keeps `--brief`
on an 80 MB car down to a tenth of a second.

Two things are turned round on the way in. The game measures V downwards from
the top of a texture, as Direct3D does and FBX does not, so V is flipped; left
alone, every badge and number plate on the car is upside down. And the
transforms are Direct3D's row-major 4×4 with the translation in the last row —
the same sixteen numbers in the same order as a column-major matrix acting on
column vectors, so they decompose as they stand, except that a negative
determinant is kept as a negative scale. A right-hand wheel is the left one
turned half round, and taken as a rotation a genuinely mirrored part comes back
the right way round and inside out.

Nothing else is moved. The game's axes are right-handed with Y up and +Z
towards the front of the car, which leaves +X pointing at its left-hand side;
that is what `GlobalSettings` says, rather than mirroring a car to make it look
like something else.

**Materials.** A kn5 material states no colour of its own — `txDiffuse` is the
albedo — so the picture is the pattern and the material's colour is read
through it rather than replacing it. `ksSpecularEXP` is the shininess exponent,
and `fresnelC` is a reflectance facing you, so that is what it is written as,
rather than a Phong highlight that has to be capped before it is believed.
Every parameter the file names is also carried under the name it named it with,
so a shader setting with no FBX spelling is still there to read.

**How much of the light a material takes.** `ksAmbient` and `ksDiffuse` weight
the two halves of the game's own lighting rather than tinting anything. Both
halves are diffuse, so in a viewer with one fixed light they have nowhere to go
but the albedo, where they are the same arithmetic — dimming the light that
reaches a surface and dimming the surface come to the same picture. Of 1728
materials across the 27 cars to hand the commonest pair by a wide margin is
**0.5 and 0.6** — 278 of them, one in six, and the value the game's own editor
starts a material at — so that is what a plainly lit surface is and everything
is read against it. A quarter ask for more light than they were given, which a
dashboard or a lamp lens does on purpose; a diffuse surface cannot return more
than it got, so that is where it stops.

This is the whole of why an Audi S8 comes up white from end to end. Its paint
is 0.4 and 0.4 — three-quarters of a plainly lit surface — its wheels are 0.03
and 0.01, and its headlight housings are nothing at all. The pictures under
those are grey panel maps, because the colour was never in the picture, so read
without the weights the rims, the lamps and the carbon mirror caps all draw as
bright as the body. 94 of that car's 97 materials are dimmed, and the report
says how many.

**Metals.** A kn5 states no metalness. The game shades a car with a Blinn-Phong
highlight and a Schlick Fresnel over it — `fresnelC` facing you rising to
`fresnelMaxLevel` at grazing, over `fresnelEXP` — and chrome is simply a
material whose `fresnelC` an artist set high.

But that number is a reflectance at normal incidence, and it is the one place
the two kinds of surface cannot be confused: **no dielectric reflects more than
about 17% facing you** — diamond, at an index of refraction of 2.42 — **and no
metal less than about half**, iron and chromium being the dullest of them.
Glass and plastic sit near 4%, and an artist writing 15% for a windscreen is
still describing one. So a reflectance between the two is read as a surface
partly of each, and the diffuse and the reflectance are split by it the way
every other importer here splits them.

Nothing is read from a surface the file also says is see-through: light passes
through a dielectric and not through a conductor, so a windscreen with a strong
reflection is a windscreen.

What comes out is what you would pick by hand. Across fifteen cars it finds the
mirrors, the chrome, the alloy and the exhaust tips and nothing else: a
Cullinan's `mirror` at 1.00 and its `int_chrome` and `light_chrome` at 0.39; a
Puma's `Ext_chrome` at 0.70 and `Ext_exhaust` at 0.24. Where an artist stated
nothing it reads zero rather than guessing from a material's name — an Alfa
Brera's `chrome` and its `body` are the same numbers to three decimal places,
and the whole of the difference between them is the picture each one wears.

The viewer takes that as a stronger reflection but still draws the diffuse
under it, which is what the game itself does; only a material carrying a
metallic-roughness map has its diffuse cancelled per pixel. An exported `.glb`
carries the metalness as `metallicFactor`.

**Texture slots.** `txDiffuse`, `txNormal`, `txGlow` and `txDetail` fill the
slots that mean the same thing. Everything else keeps the game's own name —
`txMaps` is not a metallic-roughness map however much it looks like one, and a
map drawn from the wrong end is worse than one not drawn.

`txDetail` is the **grain a surface is tiled over with**, and it is most of
what a skin brings. A car's interior is one atlas of flat panels with the
leather, the carpet and the carbon laid over them sixty or a hundred times
across: the picture underneath is the shape and the grain is the surface. An
Audi S8 has thirty-eight materials wearing one, and nine of the fifteen files
in each of its skins go there — so without it a skin changes the badge and the
number plate and leaves the cabin exactly as it was.

What the file states is how many times to tile it and not how much of it to
mix in, and the two readings are far apart: multiplied straight, a Mercedes
E63's paint — whose grain averages 0.24 — turns a white car graphite. So each
grain is taken as **neutral at its own average**, measured in linear light,
and only what differs from that average shows. The colour a car was authored
stays where it was, and what arrives is the grain and the cast of the picture:
put `Alpine_White` on that Audi and its cabin goes from flat grey to tan
leather, which is the file the skin brought. On the shaders that model a car
being crashed, `txNormal` is not the surface's own relief either: it is the
dents, blended in as damage accumulates. The Mercedes' body names a
1024-square of them there, and drawn at face value every panel comes out beaten
in, with the sun catching each crease pink.

**What the game switched off.** A car ships with its own spares — a shattered
windscreen behind the clear one, a blurred disc inside each wheel, a low-detail
cockpit inside the real one — each of them a mesh marked invisible or a node
marked inactive. They are read, counted and reported, and they are not drawn;
visibility descends, so a node switched off takes the twelve meshes under it
with it. Drawn anyway, the Mercedes comes out with cracked glass in every
window and two cockpits.

**Textures.** They are carried as bytes on the `Video` clip, the way an
embedded FBX texture is, and one `Texture` record is shared by every material
that names it: a car's paint is worn by dozens, and copying sixty megabytes of
DDS once per slot describes nothing. A LOD or a skin carries no textures at all
and reads them from the car's main `.kn5` — so the ones a material names and
the file has not got are listed rather than left to be guessed at.

The viewer decodes DDS itself — BC1, BC2 and BC3, BC4 and BC5, and
uncompressed surfaces read by their channel masks. No browser will make an
image of one, and 111 of that Mercedes' 135 textures are DDS, so without it the
car opens as a grey model with no paint, no badges and no dials.

**A car in the file is a car unpainted.** A kn5 carries one set of textures
and the game puts another over the top before it draws: every file under
`skins/<name>/` beside the car replaces the texture of that name for as long
as that skin is chosen. An Audi S8's own textures are ambient occlusion over
bare grey — read straight, it comes up white from end to end, and it looks
like something has gone wrong. It has not: the car has thirteen skins beside
it, and `Alpine_White` alone puts fifteen of its textures over the top.

So the skins are counted and named in the report, the way an `.obj`'s material
libraries are, since a pale car is otherwise indistinguishable from a broken
reader. All five cars to hand have them, replacing between 2 and 15 textures
apiece.

Two files in a skin folder say more than the pictures do, and both are the
skin's own — nothing here needs the game installed to read either:

| | |
| --- | --- |
| `ext_config.ini` | which materials of the car are its paint. Two spellings for the one thing, and a car uses whichever its author did: `CarPaintMaterial = booody_aooo` on an Audi S8, and a `[Material_CarPaint_*]` section with `Materials = body` on a Renault 5, once per paint. |
| `cm_skin.json` | Content Manager's colours, as `#AARRGGBB`. The alpha comes first, so taking the first six characters paints the car with its own opacity: `#FF1A2025` is a near-black blue and `#FF1A20` is a red. |
| `ext_config.ini`, again | the colours themselves, for the half of them that have no `cm_skin.json`. A chameleon paint states two — `ChameleonColorA` facing you and `ChameleonColorB` at a grazing angle, each with an opacity after it — and only the first is taken, since there is one albedo here and A is what the car looks like from where you are standing. A Clio V6's Illiad Blue is `#33007f` turning to yellow at the edges. |
| `livery.png` | the picture of the paint, for the ones that state no colour at all — 69 of the 189 skins to hand, and every one of the 189 has the picture. |

**And last the chip, where nothing was stated.** `livery.png` is the swatch
Content Manager shows beside a skin's name: a rounded square of the paint with
a gloss sweeping over it, sixty-four pixels square. It is a picture rather than
a statement, so it is read after both files and never against them — where both
are there they disagree about a third of the time, usually because the setting
is Content Manager's untouched white. But read, it is exact: a Champagne Quartz
chip is 1874 pixels of `#565D6B` and its `cm_skin.json` says `#565D6B`.

Two things make a plain average the wrong reading. The gloss is a wide bright
sweep, and under some of them is a band of dark reflection — a Renault 5's
Blanc Perle chip is white over black, and averaged it is a mid-grey nobody
painted. So the *commonest* colour is taken, over the upper half where the
paint is: colours are gathered into 32 steps a channel, the fullest bucket
wins, and what comes back is the average of what fell in it. Without this an
Audi's Sakhir Orange — which says `#FFFFFF` and switches it off — and its
Silver Pearl, Silverstone and Moonstone, which have no `carPaint` section at
all, are four white cars.

**Where the skin names no material the car's own
`extension/ext_config.ini` is asked instead**, since half of them declare it
once for the whole car rather than once per skin. Without that only the Audi
of five cars to hand paints at all; with it the Renault does too, and the
Renault is the one that shows why the pairing has to be by *order*. Its config
names `body`, `body2` and `rim_colored`; its skins answer with `extBody1`,
`extBody2` and `extRims1` — three and three, in the same sequence and with the
names corroborating — and `01_blue_olympe` comes out a deep blue body under a
lighter blue roof on blue wheels, which is what it is.

**One colour is the car's, however many materials the paint is spread over.**
A Clio V6 names `wccarbody` and `aleron` — its body and its spoiler — and
states the one colour for both. Several colours are paired by order; one is
put on all of them.

A section that names the skins it is for is only for those, since one folder's
config can carry a block written for another. And a skin can state no colour
at all: four of that Clio's six say nothing about it anywhere in the folder,
their config naming the shader and no more. They are offered for the pictures
they do bring — the picker says *Acid_Yellow — 2 textures*, without a paint —
and nothing is invented for the rest.

**Last, a car's paint is settled across its own skins.** An Audi S8 has
thirteen: three name `booody_aooo`, which the car has, and five name
`carpaint`, which it has not — configs copied from another car, colour and all.
Left at what each file says, those five state a perfectly good colour and put
it nowhere. So a skin that names nothing the car has is answered by what its
own siblings called the paint, which takes that Audi from four skins painting
to nine. It is a reading of the folder rather than of one file, and only ever
from names the folder itself used.

Where nothing in the folder names a material — an Alfa Brera states three real
colours and has no `extension/` at all — nothing is guessed. Those skins bring
their textures and no paint, and say so.

That car's own `extension/ext_config.ini` is worth being clear about, since it
looks like the place to go. It is not: it holds the shader parameters for the
paint — clear coat, flake, Fresnel — and every `COLOR=` in its 1,490 lines is
a *light*, at intensities like `517,290,0`. Nor is it self-contained: it
`[INCLUDE]`s twelve files, of which one is beside the car and the rest live
inside Custom Shaders Patch. What is read from it is the one thing it does
state and the skins sometimes do not — which material is the paint.

Both are read for what they say and held against the model rather than
believed. A config copied from another car names a material this one has not
got — a Cullinan skin asks for `carpaint` on a car whose paint is called
`body` — and a slot that says its paint is *off* keeps the colour in its
texture instead. Neither is painted over; both still bring their pictures. An
Alfa Brera states three real colours and no material anywhere, and nothing is
guessed for it.

**The viewer offers them, and does not choose.** Open the car's folder and a
skin picker appears beside the geometry list, saying what each one brings —
*Alpine_White — 15 textures + 1 paint*. Choosing one puts its files over the
car's own, which is the one place a supplied file beats an embedded one and is
the game's own rule rather than a preference. Choosing nothing leaves the car
as the file has it, which is where it starts.

A new model empties the list, since what stood beside the last car does not
stand beside this one and a picker still offering the old paint is worse than
no picker. What arrives *without* a model is an addition to whatever is open —
a texture that was missing, a skin folder dropped afterwards — and is kept.

The paint **tints** the texture rather than replacing it. The map under a car's
paint is its panels in white on black — an Audi's `Skin_00.dds` is exactly that
— because the colour is what the game multiplies through it. Replaced by the
colour, the shut lines and the badge go with it; replaced by the map, the car
is white whichever skin is on. Every other material is left as it was: a bound
texture replaces the flat colour, as most tools and viewers treat it.

**A protected car** is a different thing again, and the report says which kind
of file it has been given rather than leaving a shattered model to be taken for
a bug in the reader. Three of fifteen cars to hand are published this way, and
they say so themselves: the last forty-two bytes are Custom Shaders Patch's
`__AC_SHADERS_PATCH_KN5ENC_v1__` marker, the offset the encrypted part starts
at, and a version. In front of it stands a whole, readable kn5 that has been
*spoiled to match* — every texture in the table replaced by one seventy-byte
PNG of a single blue pixel under the name of the picture that used to be there,
and the vertex stream scrambled.

Nothing in the model says the second part. Its counts are right, its normals
are unit vectors and every index is in range, so a reader has no reason to
doubt it — a Mercedes CLS63 comes out as a car-shaped explosion of shards. What
gives it away is the geometry against itself: **a triangle's corners in order
give it a facing, and the normals its vertices carry should agree**, because
the exporter wrote both from one surface. Two dozen triangles a mesh settles
it. Twelve sound cars sit between 95% and 100% agreeing; the three spoiled ones
sit on a coin toss — 49.6%, 50.1%, 50.8%.

So the file is reported as protected, the geometry as not the shape that was
modelled, and the textures as held back with the rest of it. **The game
decrypts what follows; nothing here does, and nothing here tries.** The stand-in
is not drawn either way — carried, it paints the whole car one translucent
blue — so what comes up is the model in its own material colours with every
texture listed as one to go and find. A car spoiled without the marker is
caught by the same geometry check and reported on its own.

Read on that car and its three LODs plus its collider: all five parse to the
last byte, 3,161 bytes to 82.7 MB, and the whole one renders — 434,279
triangles once its spares are left switched off, with 80 textures decoded, in
under a tenth of a second of parsing.

A material the file marks `AlphaBlend` or alpha-tested says so in its
`AlphaMode`, and its transparency lives in the alpha channel of its diffuse
texture — which is where the viewer reads it from, per pixel. See
[Transparency](#transparency).

What is not read: the animations in `animations/`, the physics in `data.acd`,
and the `.knh` hierarchies beside the model, none of which are geometry — nor
the encrypted half of a protected car, which is somebody's work kept back on
purpose.

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

Drop the whole folder, and everything under it comes with the model — which is
what a downloaded model needs, since it keeps its images in a subfolder beside
the document and names them by relative path. A drop only ever offered the
files at the top level, so dropping the folder used to hand over the document
and nothing else: the model arrived with none of its images, and every material
fell back to whatever it states on its own. On a car that is a set of white
chrome tyres, because glTF's default for a metalness a file leaves out is 1 and
the map that qualifies it was in the folder that did not come. The model is
picked out by extension rather than by being first, so a licence or a readme
sitting beside it is not mistaken for it.

**Open folder** does the same from the button. A file picker cannot reach into
a subfolder — the page is handed the files chosen and nothing else — so opening
`scene.gltf` by hand gets the document without its images however carefully it
is picked; a directory picker hands over everything under the folder at once.
A folder that turns out to be a library rather than a model is read as far as
512 files, models and their images first, and says how many it left.

A folder often holds the same scene saved several ways, and the ways disagree
about what survived. Every model in a drop is read before any of them is
opened, and the one with the most to draw is the one that opens — which is a
fact rather than a judgement, and worth deciding rather than taking whichever
file came first. A cage with a subdividing modifier counts for what it becomes:
a 217,930-vertex `.max` beats the 1,912,893-vertex `.obj` baked out of it,
because the tool subdivides further than the export did — 6.4 million triangles
against 1.9.

Not by a hair, though. Two savings of one scene differ by a rounding when they
differ at all, and a mesh chosen on that margin can arrive with nothing on it:
another Smart's `.obj` has two per cent more vertices than its `.max` and two
`wire_` placeholders where the `.max` has 25 materials and two textures.
Anything within a tenth counts as the same mesh, and then what each file
carries besides is what separates them.

Where that file has no maps at all, materials are taken from whichever of the
others does, matched part by part. The parts answer to the same names —
`desirefx.me_002` in the `.max` is `desirefx_me_002` in the `.obj`, the exporter
having replaced what a name cannot hold — so matching with the punctuation taken
out lines up 164 of 164 on that car, and 93 of 94, 118 of 125 and 220 of 220 on
three others. Material names are no use for this: a `.max` gives them names of
its own making where the `.fbx` beside it has `Aluminium Brushed`.

It is deliberately only done where the opened file has nothing. Which file has
the *better* materials is not a fact and counting does not find it: a Ferrari's
`.fbx` has 58 materials under real names against the `.max`'s 47 under invented
ones, and more texture records besides — and taking them turns a white car grey,
because they are V-Ray materials whose Phong approximation is empty.
`Carpaint Blue` reads as 0.16 grey and `Aluminium Clean` as black. What comes
from where is said out loud, and Ctrl+Z puts the file's own materials back.

A scene of one part is not dressed from a donor of many, since the whole model
would come out in whatever that single name happens to wear.

Where the images sit inside the folder does not matter. `textures/` is what
Sketchfab writes, `maps/` is what plenty of others write, and a model saved out
of a tool often has them loose beside it — sometimes with the model itself a
folder down. Everything under the folder is read, and an image is matched to
whatever names it by file name rather than by path, which is also what lets an
FBX naming `C:\Users\…\Brabus\specular.jpg` find the file it means. Names are
matched with their URI escapes undone: a glTF written by an exporter that
escapes properly names `tyre%20map.png` for a file called `tyre map.png`, and
every byte of a name that is not ASCII is escaped the same way.

| Layer | Where it runs |
| --- | --- |
| DEFLATE, binary record walking, polygon triangulation, normal generation | WebAssembly (`web/src/fbx.c`, freestanding, no libc, **no imports**) |
| ASCII FBX, OBJ, .blend and .max reading, scene analysis, report | JavaScript — text and structure work with no hot loop |
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
choice is shown, and can be overridden — and an override outranks both the
declaration and the guess from then on. It is remembered per file, so a model
the viewer reads the wrong way up is corrected once rather than on every open,
and nothing that rebuilds the mesh takes the correction back.

Beside it, **flip X / Y / Z** mirrors the model on any of its own axes, singly
or together, and is remembered per file the same way. Models come handed the
wrong way round — a right-hand-drive car out of a left-handed exporter, a part
modelled once and meant for both sides — and this is the correction for it. A
mirror is not a view setting: it rides out on the root node's matrix beside the
up axis and the units, so what is exported is what is on screen.

Mirroring reverses which way round a triangle is wound, and a renderer that
goes on culling by the old rule draws the *inside* of the model — the same
silhouette, so the picture alone does not give it away. The viewer switches
which winding counts as front-facing whenever an odd number of axes is
mirrored, which leaves every pass that culls asking for the same side it always
asked for; glTF states the same rule for a node whose transform has a negative
determinant, so the exported file needs nothing else said about it. And the
normals need no correction at all: a rotation with an axis mirrored is its own
inverse transpose, which is what carries a normal properly.

**Turn** is the third correction of this kind, and the only one that is purely
a view. Nothing in any of these formats says which end of a model is its front.
The axis declarations look like they do — `FrontAxis` sits right there beside
`UpAxis` — but they are a property of the format rather than a reading of the
scene: every `.max` says front is `-Y` and every glTF says `+Z`, whichever way
the artist actually laid the car out. A Maserati Grecale modelled down the X
axis therefore opens showing its rear, and no amount of reading the file harder
will say so. Turn swings the camera a quarter turn about the up axis, four of
them coming back to where it started, and is remembered per file so a model
that has been turned round once stays turned round. Unlike a mirror it is not
written into the export: the model stays exactly where the file put it, and
only the camera moves.

### Legacy 6.x files

FBX 6.x — anything the SDK still writes as version 6100, and plenty of models
in the wild — is not a slightly older 7.x. Three things differ, and the viewer
handles all three:

| | 7.x | 6.x |
| --- | --- | --- |
| objects are addressed by | UID | name, with the class after a separator |
| the mesh lives in | its own `Geometry` record | the `Model` itself |
| numbers are written as | one array property | one property each |

That last one is why such a file can parse cleanly, report its 31,280 records
and its whole object table, and still draw nothing: `Vertices` is not an array
at all, it is 700 separate doubles in a row. Records are read as either now,
and a 6.x scene assembles part by part like any other — the Ferrari 250 that
prompted this is 94 models, 485,888 triangles, addressed entirely by name.

Property blocks differ too: 7.x writes `P` records with four strings before the
value, 6.x writes `Property` records with three.

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

### Taking it apart

Once a scene is assembled it is one solid object, and the parts inside it are
hidden by the ones in front. The **explode** slider pulls them out: each part
slides away from the middle of the model, along the line from the model's
centre to its own —

```
position += (partCentre - modelCentre) * explode      // 0 … 1.5
```

— so parts move apart in proportion to how far out they already are, nothing
crosses anything else, and each piece ends up on the side it came from. A part
is one placed model, the same unit the dropdown lists: 3 for `scene_parts`, 44
for the Shelby, 34 for the Pantera. The shift happens in the vertex shader,
reading a texture of part centres, so a 240,000-triangle scene comes apart at
frame rate; the shadow pass and the ground plane read the same centres, so the
shadow follows each part and the floor stays under the lowest one.

**Click a part to select it.** The click is answered by drawing the scene again
into an offscreen buffer where each pixel holds the part index it belongs to,
and reading back the one pixel under the cursor. That is exact rather than a
guess — no ray to intersect, no tolerance to tune — and because it is the same
geometry through the same vertex shader, it keeps working through the explode,
the up-axis correction and the smoothing without knowing about any of them. The
part is washed blue in the render — a different colour from the orange a
material picked out of the list uses — and named underneath:

```
Body_Shell · 30 140 triangles · 4.4 × 1.1 × 1.9 units · CarPaint, Chrome
```

Dragging orbits the camera as before — only a press and release without a drag
counts as a pick. `Escape`, or a click on empty space, lets go.

### Deleting a part, and splitting one

A selected part can be taken out of the scene (`Delete`) or cut into the pieces
it is really made of (`split`, or `S`). Neither touches the file: what changes
is the scene the viewer holds, which is kept as a list of **segments** over the
meshes already built —

| | a segment says |
| --- | --- |
| whole part | the part it came from |
| split part | the part it came from, and which of its triangles it kept |
| deleted part | nothing — it is not in the list |

— so an edit is a new list, not new geometry. A delete costs one rebuild of the
combined mesh and no triangulation at all; splitting a 122,112-triangle wheel
into its 41 loose pieces takes about 60 ms, and splitting a piece again is no
dearer than splitting it the first time, because the second list is read back
through the first.

**Split** comes in two kinds:

- **`split`** follows the geometry. Triangles that share a vertex stay
  together, so a wheel saved as one mesh comes back as rim, tyre, hub and every
  wheel nut separately. Corners are welded by being at the same point exactly,
  which is the right test rather than a tolerance: every corner of a part came
  out of one triangulation through one matrix, so two corners of one vertex are
  the same bits, and what differs by a rounding step is a different vertex.
- **`by material`** follows the file's own grouping — one piece per material —
  which separates glass from bodywork on the files that ship them merged.

Deleting reaches as far as the scene does. The part stops being drawn, stops
being counted in the mesh line, and stops being written by **Export glTF** —
the export walks the same segment list, so a part deleted leaves its node
empty and the branch is pruned, while parts nobody touched go on sharing their
mesh and their instancing is kept. A part that has been split and partly
deleted is written as the triangles that are left. The Report panel grows an
**Edits** section with the resulting counts, and marks the models in the scene
hierarchy `← removed` or `← edited`. Nothing writes to the file on disk.

A split is a grouping the viewer holds, not a break in the file's structure, so
the export writes a split part as the one mesh on the one node it has always
been — minus whatever pieces were deleted. Reading that export back gives the
same triangles in the same places, with the surviving pieces of a split part
gathered back into one: 73 parts and 539,090 triangles on screen come back as
59 parts and 539,090 triangles, and the Khronos validator reports nothing.

`Ctrl+Z` and `Ctrl+Y` step back and forth through every edit, and **Restore
all** — which appears in the controls once something has been edited — puts the
whole scene back at once. Changing the smoothing level rebuilds the geometry
and so renumbers its triangles; the edits cannot survive that, so the scene
comes back whole and says so.

### Changing what a part is made of

The dropdown in the part readout says what the selected part wears and gives it
something else — any material already in the file, or **+ new material**, which
adds one to the palette and puts it on. A new material starts as a plain grey
so that adding one shows; the **Materials** tab is where it becomes what it
needs to be, and it is edited, renamed, saved and reset there like any material
the file brought with it.

The whole part takes the material, because a part is the unit being dressed. To
repaint only some of it, split it first — `by material` on a body that ships
with its glass merged in gives two parts, and each can then be dressed on its
own. `as the file has it` puts a part back in what it came in.

This is the same kind of edit as a delete: it lives in the segment list, so
`Ctrl+Z` undoes it, **Restore all** clears it, and the Report's **Edits**
section counts the parts wearing something new and names the materials added.
Unlike a delete, it also outlives the session — dressing a part is a fact about
its material, so it is written into the assignment for the model along with the
colours, and comes back with them ([Assigning materials](#assigning-materials)).
The export follows too — a material given by hand is written onto the end of
that part's own palette and its triangles pointed at it, so a part reassigned
no longer shares a mesh with the untouched instances of the same geometry,
while everything else goes on sharing as before. A material the file never had
comes out as a material in the `.glb`, used by the part it was given to, and
the Khronos validator reports nothing.

### Smoothing a cage

A model can look faceted not because the viewer is dropping detail but because
the file holds a **control mesh**: the subdivision modifier lives in the
modelling package's own scene file, and what the FBX exporter writes is the
cage it was applied to. The same model exported to OBJ often has the modifier
baked in, which is why one looks smooth and the other angular — a Smart Brabus
that prompted this carries 217,930 vertices in its FBX and 1,912,893 in its
OBJ, across the same 164 objects.

**Smooth ×1** and **×2** run Catmull-Clark over the polygons, before anything
is triangulated:

```
a face point at the centroid of each polygon,
an edge point between the two ends of an edge and the faces beside it,
each original vertex moved to where its neighbours pull it,
and every n-sided polygon replaced by n quads.
```

An open border is smoothed as a curve on its own, so two meshes that share an
edge do not part company — and where several borders meet at one point, which
exported car parts are full of, their neighbours are averaged rather than
summed. Normals and UVs are subdivided linearly rather than smoothed, which
keeps hard edges and texture seams exactly where the file put them; materials
follow the polygon they came from.

Because the normals are the file's own, what changes is the *shape*, not the
shading: a cage is usually smooth-shaded already, and what gave it away was the
angular outline. Expect a rounder silhouette and softer creases rather than a
different-looking surface — at a whole-car zoom that is around 6% of the
pixels, so the triangle count in the viewport is the reliable tell.

Each round turns every corner into a quad, so the triangle count comes to
twice the corners that went in — quads quadruple, triangles sextuple. The
Smart's 383,811 triangles become 1,619,562 in about 350 ms. Level 2 multiplies
again and can run out of memory on a large mesh; a part that will not fit is
drawn as it came rather than dropped, and the viewport says how many.

### Materials and textures

Surfaces are drawn in the file's own `DiffuseColor`, falling back to the
default in `Definitions` → `PropertyTemplate` when a material carries no
properties of its own — which is how Blender's exporter writes them, and why
such files otherwise render pure black. A per-polygon material index does not
name a material directly — it indexes the materials connected to the *model*
that owns the geometry, in connection order — so the palette is resolved
through the connection graph.

Textures are followed from `Material` through the object-to-property connection
that drives its base colour, then down to whatever image is at the end.

Each row in the Materials tab says which images its material names — the slot,
the file, and whether that file is here. A model names its images by relative
path and does not carry them, so a material can perfectly well name one nobody
supplied; a row then reads *3 images · 2 missing* without being opened, and
names the two inside. That is what makes a white chrome tyre legible: the
metalness slider says 1.00 because the file left the factor out, and the row
beside it says the map that qualifies it is `tire_metallicRoughness.png` and
that it never arrived.

An image can also be left out. The `×` beside a row's file drops that one map:
the viewer stops sampling it, the export is written without it, and the row goes
on naming the file with a `+` to take the choice back. Nothing is destroyed —
the file still says what it says, and the decision is stored with the rest of
the assignment, so it survives a save and a reload. That is for the map that
fights the model rather than helps it: a normal map baked against different
geometry, a lightmap from another renderer, an ambient occlusion pass already
in the base colour.

Two things make that less simple than it sounds. Exporters name the property
after their own renderer — `3dsMax|CoronaMtlPb|texmapDiffuse`, `Maya|baseColor`
— so the vendor prefix and every separator are dropped before matching, since
the same slot is `texmapDiffuse` to one renderer and `texmap_diffuse` to the
next. V-Ray and Corona both write the underscored form, which is most of what
leaves 3ds Max: a Toyota, a Mini and a Volkswagen in one library named every
map `3dsMax|maps|texmap_diffuse`, and not one of them bound until the
separators went. Each slot is told from the others by the same means — a bump
or normal map is recognised as one and kept for the export, and a glossiness
map as nothing either the viewer or glTF has a place for, and left alone. And
the image is often several links down, with colour corrections
or mixes in between, so the chain is walked to the first record that names a
file or carries the bytes. A chain that ends at no image at all is a procedural
map, and nothing is drawn for it.

The `Video` clip is usually where the filename lives:

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

A metallic-roughness map is read too, where a material has one. It is never
shown as a picture — it is not one; its green is a roughness and its blue a
metalness, both linear, and both multiplying the factor stated beside them. It
has to be read because glTF's default for a factor a file leaves out is 1, and
a material that keeps its metalness in a map habitually leaves the factor out:
the Jaguar's tyres state none at all. Taken as the factor alone they are pure
metal, and a metal keeps no diffuse — so the tread the base colour image
carries never reaches the screen and the tyre draws as a white mirror. The
palette arrives split into a diffuse and a reflectance by one metalness for the
whole material; where there is a map that split is undone and done again per
pixel.

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

That mapping is the fallback, not the first choice. A material carries its own
renderer's parameters beside the Phong ones, under the same vendor prefix the
texture connections go by — `3dsMax|main|base_color`, `3dsMax|main|roughness`,
`3dsMax|main|metalness`, `Maya|baseColor`, `Maya|specularRoughness`,
`Maya|metalness` — and those are the numbers the artist set, where the Phong
values next to them are the exporter's approximation of the same surface. So
the prefix is dropped and a stated base colour, roughness, metalness or opacity
is read instead of being reconstructed:

| Stated by the file | Used as |
| --- | --- |
| `base_color` / `baseColor` | albedo, with no diffuse factor in front of it |
| `roughness` / `specularRoughness` | roughness directly |
| `metalness` / `metallic` | folded in: a metal reflects its own colour and keeps no diffuse, a dielectric reflects 4% |
| `opacity`, `transparency` | how much the surface hides |

A Phong specular colour scales a highlight — it is not a Fresnel reflectance,
and taken literally it makes a mirror of everything, since OBJ libraries
habitually write `Ks 0.9 0.9 0.9`. It is capped at 0.16, the brightest a
dielectric reaches, unless the file states a metalness outright. A `.blend`
does, and so do glTF and an FBX written from a Physical Material or a
standardSurface, so those are read and converted rather than guessed at.

### The index of refraction beside a reflection

A renderer's own material states something better than either, and it is the
whole of what tells a mirror from a windscreen. V-Ray and Corona both write a
reflection *colour* and, beside it, the **index of refraction** the reflection
is shaped by — and what comes back facing you is `((n-1)/(n+1))²` of that
colour, not the colour itself.

Across one Audi: its chrome and the clear coat over its paint say **999**,
which is an artist writing *metal*, and comes to 0.996; its glass, its gloss
black and its plastic all say **1.52**, the index of glass, and come to 0.043;
the paint under the coat says **8**. Every one of them states a reflection
colour of 1.0 or thereabouts, so the colour alone cannot tell them apart —
capped, the chrome draws as white plastic; taken at face value, the windscreen
draws as a sheet of chrome. Read with the index, chrome mirrors, glass is four
per cent facing you and nearly all of it edge-on, and the shader's own Fresnel
does the rest.

It is matched the way a texture slot is, on the letters with the vendor and the
separators taken out, so V-Ray's `reflection_ior`, Corona's `fresnelIor` and
this reader's own `ReflectionIor` are one thing. The map slots that merely
*drive* an index — `texmapFresnelIor` and the like — are not, and neither is
the refraction's own `ior`.

**Which of Corona's two indices.** A CoronaMtl keeps both, next to each other:
the Fresnel index at parameter **182** and the refraction index at **183**.
Only 182 shapes a reflection; 183 is what light bends by on the way *through*,
and it is 1.52 on everything that is not glass because that is the default
nobody changes. Read at 183, every Corona surface in every scene came back at
the reflectance of window glass — a Maserati's chrome, its polished steel and
its wing mirrors all drew as dark plastic.

3ds Max settles it by exporting both under their own names: for all four of
that car's bright metals `CoronaMtlPb|fresnelIor` is the number at 182 — 999
for the mirror, 50 for the steel, 8 and 6 for the two irons — while
`CoronaMtlPb|ior` is the 1.52 at 183. The same export writes a specular factor
of `10 × glossiness × min(1, fresnelIor / 16)`, which comes out exactly right
for all seven materials that carry one, 182 in hand and not 183.

The Audi settles it a second time, and independently: that car ships a Corona
scene and a V-Ray scene of the same model, read down two entirely separate
paths — parameter 63 and reference key 8 on one side, 182 and block slot 1 on
the other. Scored material by material against its V-Ray twin, the Corona
reading went from a mean reflectance error of **0.125** to **0.004**, and from
38 to **50 of its 52** shared materials agreeing within 0.03. Every chrome on
the car — `window frame chrome`, `chrome logo`, `rims brushed steel`, `matte
chrome reflector` — moved from 0.043, the reflectance of glass, to the 0.996 of
its twin, while every pane of glass stayed at 0.043.

**A reflection slot is read like a diffuse one.** A filled slot makes the
colour beside it a placeholder, and Corona's reflection slot is slot 1. Car
paint is where it shows: all three of that Maserati's layered paints leave the
reflection colour at white and put the real one in the slot, as a Falloff —
black facing you, white at grazing, with the paint's own `CoronaColor`
underneath. Read the white and the whole body comes out chrome; the gold badge
reflects white instead of gold.

A Falloff is not a colour but a ramp between two of them by viewing angle, so
what is taken from one is its **near** end, because that is what facing the
camera means and the shader's own Fresnel takes it the rest of the way. It is a
fallback and not a rule: a Falloff with a map in its near slot shows that map,
so what lies beneath is asked first.

Where no index is stated the cap stands, and it has to. A legacy FBX 6.x export
carries the reflection and loses the index; that Ferrari's every material
states 1.0, and taken at face value the whole car turns to mirror and its dark
blue reads as grey. The `.max` beside it keeps the index and reads the colour
the file actually gives.

### The clear coat

A car's paint is two surfaces and not one. The base is dark and half rough —
that Audi's is a reflection of 0.047 at an index of 8, and a glossiness of 0.3
— and over it sits a **clear coat**: a separate material with a reflection of
1.0 at an index of 999 and a glossiness of 1, which is to say a sharp mirror.
Read only the base and the car draws as flat plastic; that is what makes paint
look like paint.

A blend states how much of that coat shows, and it matters. A VRayBlendMtl
keeps it as a colour at parameter 2 of its own block, and the Audi's paint sets
it to a **half** — taken whole, every panel and every material ball in the
scene beside it comes out chrome. The coat is scaled by it, and a coat scaled
to nothing is no coat at all, which is what the dirt blended over the Hummer's
tyre comes to: only the most reflective layer over the base counts, and a layer
that reflects nothing leaves the surface alone.

A CoronaLayeredMtl says it as a *map* rather than a number, at slot 11, which
is a stronger statement: all three of the Maserati's paints fill it with a
Falloff that is black facing you and 0.86 at grazing. That is a coat seen along
the edge of a panel and nowhere else, so facing the camera there is none — and
that is what 3ds Max's own export makes of those three as well, writing the
base coat's reflection and shininess and saying nothing about a layer at all.

The shader draws it as a second specular lobe with its own roughness, and takes
what it reflects out of what reaches the base — one minus the coat's Fresnel —
so the two do not both spend the same light. Glass under a coat hides what
either of them mirrors.

Colour is managed end to end: images upload as `SRGB8_ALPHA8` so the sampler
returns linear values, material colours are linear as written, shading happens
in linear light, and the result is tone-mapped through a filmic curve before
being encoded back to sRGB. Highlights roll off instead of clipping.

### Exporting glTF

**Export glTF** writes what is on screen as a `.glb`: the scene as it stands,
with whatever materials you have assigned and whatever parts you have deleted
or split, in one self-contained binary file.

The scene keeps its shape. Each mesh is written once in its own local space and
placed by a node, so a hierarchy stays a hierarchy — a part keeps its name and
its parent — and a mesh used by several models is stored once and pointed at
from each. The three-part sample scene, which is one cube under three
transforms, exports as one mesh of twelve triangles drawn thirty-six times; the
De Tomaso Pantera exports as 33 meshes in 84 nodes, eleven deep.

What is left is where the formats disagree:

- a glTF primitive has exactly one material, so each mesh is split into one
  primitive per material, and materials covering no triangles are dropped (the
  Mercedes' 23 become 17);
- triangles arrive unindexed, three vertices each however many they share, so
  every primitive is welded: the Mercedes' 1,083,708 corners come out as
  245,514 vertices, which is what makes it 11.6 MiB instead of 35;
- glTF is Y-up in metres while these files are often Z-up in centimetres, so
  that difference goes on the root node's matrix rather than into the vertex
  data — the geometry is written exactly as the file holds it.

Materials map onto metallic-roughness directly: base colour and opacity,
roughness, metalness, what the surface gives off, and `KHR_materials_specular`
when a dielectric's reflectance is not the 4% glTF assumes. A material is
written once however many meshes use it.

That extension can only ever *lower* a reflectance. It defines F0 as
`0.04 × specularColorFactor`, so a factor above 1 is a raised one — and a
dielectric that reflects more than 4% renders as a mirror and cancels its own
albedo in indirect light, which means a colour written to it does nothing at
all. A Phong specular colour is not a Fresnel term, and OBJ material libraries
habitually write `Ks 0.9 0.9 0.9`, so raised factors are what a naive
conversion produces rather than what any file meant. The whole factor is
scaled down to its brightest channel, which caps the reflectance and keeps the
hue: cloth and rubber still come out duller than 4%, and nothing comes out
above it.

How a material is blended is not decided by the opacity factor alone, which is
the wrong question to ask — a badge is a decal whose transparency lives in its
texture's alpha channel and whose factor is 1, and drawn opaque it is a solid
rectangle stuck to the car. What the file declared stands, whichever way it
declared it, unless the opacity is actually edited here; a file with no such
field — an FBX, an `.obj`, a `.blend` — is read from its base colour image
instead, since an alpha channel there is the only place its transparency could
be.

Textures come too, and not only the base colour. The maps this tool neither
shows nor edits — normal, metallic-roughness, occlusion, emissive — are
carried through as opaque payload and written back where they were found:
nothing decodes them, and an untouched index beside its image bytes is the
whole of it. On a body panel that is the difference between a shut line and a
stripe painted on. Samplers travel with them, so a tiling tread does not come
back clamped, and an image several materials share is stored once. Bytes that
are already PNG or JPEG are embedded untouched; anything else is drawn once
and encoded as a PNG, which is how a texture that arrived as KTX2 leaves as a
picture — the Pantera's nineteen Basis textures export as nineteen PNGs.

An export says what it left behind. Materials that cover no triangles are
dropped, and so is any part taken out here — which is a decision worth making
here rather than at runtime, but not one worth making in silence. So the
export diffs itself against the file it came from and prints what went:
*n* materials removed, by name, *n* nodes removed, *n* renamed. Removing a
number plate then reads as four expected names rather than as nothing at all.

It also says when a map a material names was not supplied, which is the one
omission that changes what the values left behind mean. A factor multiplies its
map: `metallicFactor` with no `metallicRoughnessTexture` beside it asserts a
surface the file never claimed, and glTF's default for that factor is 1 — so a
tyre exported without its map is a mirror, permanently, in a file nothing
downstream can put right. Supplying the images and exporting again is the fix,
and it is worth being told rather than left to notice.
Names are the keys everything downstream finds a body panel or a wheel by, and
a merge nobody noticed is a car that can no longer be painted.

What still does not survive: animation, skins and morph targets; cameras and
lights; tangents, vertex colours and second UV sets. The geometric offset a
mesh carries is baked into its vertices, since glTF has no such thing.

The export is checked against the **Khronos glTF-Validator**
(`npm i -g gltf-validator`) on every sample, alongside checks that the model
that comes out is the one that went in: every triangle placed by its node
against the same bounds, one node per part, a mesh used twice stored once, and
on small meshes every triangle compared corner by corner.

### Draco compression

Most glTF found in the wild is compressed: `KHR_draco_mesh_compression`
replaces the vertex streams with a block of its own, leaving accessors that
carry counts, types and bounds but no data. A reader that ignores it builds a
mesh with every vertex at the origin — present, counted, and invisible.

So the decompressor is written here, in `web/src/draco.c`, from the Draco
bitstream specification with the shipping decoder consulted wherever the two
disagree — and they do, in ways that matter:

- the specification's depth-first traversal is keyed on "attributes decoder 0
  is the positions", which files need not honour: they are keyed by a signed
  attribute-data id, and this one puts the positions second;
- `SetLeftMostCorner` is folded into `MapCornerToVertex` in the prose but is
  separate in the decoder, and it decides where the fan around a vertex
  starts — which decides the order points are numbered in;
- a vertex is on a boundary when swinging left from its left-most corner
  leaves the mesh, not when it has no corner at all;
- the tagged symbol decoder reads its bits straight through rather than
  realigning per group.

What it implements: EdgeBreaker connectivity (standard and valence traversal)
and sequential connectivity, rANS symbol decoding both tagged and raw, the
attribute seams that split a vertex where a texture is cut, depth-first and
prediction-degree traversal, and the prediction schemes — difference,
parallelogram, constrained multi-parallelogram, portable texture coordinates
and geometric normals — with the wrap and octahedral transforms.

It is held to Draco's own decoder, not to a tolerance. Every checked-in
fixture in `samples/draco` decodes to the same values Google's decoder gives,
and on a 1.9 MiB compressed car of 240,144 triangles across 33 primitives,
every index and every attribute value matches exactly.

### Basis Universal textures

The other half of a compressed glTF is its textures: `KHR_texture_basisu`
stores them as KTX2 with Basis supercompression, which is not an image format
at all — it holds blocks meant to be handed to a GPU, and no browser will make
a picture of one. So that is decoded here too, in `web/src/ktx2.c`.

ETC1S is a stripped-down ETC1: every 4x4 block is one base colour in 5:5:5,
one of eight intensity tables, and sixteen 2-bit selectors saying how far each
pixel moves along that intensity. Both halves live in codebooks shared by the
whole file, and each block names an entry in each — usually by predicting it
from its neighbours and coding only the difference. Unpacking is therefore:
read the codebooks, read the Huffman tables, walk the blocks recovering
endpoint and selector indices, and turn each block into sixteen pixels. Files
with transparency carry a second, greyscale slice for the alpha channel.

It is held to Binomial's own transcoder: every fixture in `samples/ktx2`
decodes byte for byte, and so do all 36 textures of the compressed car —
including its alpha slices, its 1024x1024 and its non-square images.

### Photoshop documents

The same problem, from the other direction: a `.psd` is a document rather than
a picture, `createImageBitmap` refuses one, and 3ds Max reads them happily — so
car scenes name them for their textures and the surfaces wearing them come out
flat. What is read is the *composite*, the flattened picture Photoshop stores
at the end for anything that cannot open the layer stack, in `web/app/psd.js`.
It is stored planar, the whole of one channel before the next, and coded either
raw or with PackBits; both are read, and 16-bit, CMYK and PSB documents are
declined rather than guessed at. A Hummer's `tire .psd` — 1024x1024, RLE, three
channels — decodes to the same bytes as an independent reader in 15 ms.

Something the tool has been given and cannot read is not something it is
missing, and the two are said differently: one asks for the folder, the other
asks for a PNG.

### DirectDraw surfaces

The same problem again, and the one that matters most: a `.dds` holds blocks
meant for a GPU rather than a picture, no browser will decode one, and Assetto
Corsa keeps almost every texture in one — 111 of the 135 inside a single
Mercedes. `web/app/dds.js` decodes the top mip level to RGBA: BC1, BC2 and BC3,
BC4 and BC5 (whose missing third channel is rebuilt, since a normal is a unit
vector), and uncompressed surfaces read by their **channel masks** rather than
by a table of layouts — a mask says which bits of a pixel are which channel, so
B8G8R8A8 and R5G6B5 need no entry apiece.

BC3's alpha is where a decoder goes wrong quietly: sixteen three-bit selectors
over six bytes, which read as one 48-bit number come out as zero. Glass and a
spinning wheel are both fully transparent textures in a car, so alpha read as
zero is indistinguishable from alpha not read at all — and the tests hold the
interpolated ramp against the values the block was written with. BC6H, BC7 and
floating-point surfaces are declined rather than guessed at.

**Colour and alpha are kept apart all the way to the GPU**, which is less
obvious than it sounds. Multiplied together — which is what a browser does by
default, and the only thing a 2D canvas can do, since that is how it stores
pixels — a texel at zero alpha loses its colour outright: dividing it back out
is a division by nothing. On a texel nobody sees that costs nothing. On a
material that never asked for alpha in the first place it costs the whole
picture, and a `.dds` written out of this game routinely carries an alpha
channel of nothing at all beside a colour that matters — an A8R8G8B8 whose
alpha byte was simply never written, or an A8L8 that is really an L8. A Renault
5 Turbo has twenty-four of them: its seats, its carpet, its dashboard, its
interior plastic and its rubber, every one of which drew as a black panel.
Resizing with `createImageBitmap` instead of a canvas keeps them, so long as
every call in the chain is told not to premultiply — one default anywhere has
already thrown the colour away by the time the next asks for it back.

The turn each texture takes on the way in has to be asked for of the bitmap
too. V runs upwards in FBX texture space, so V=0 must sample the *bottom* of
the picture, and the viewer turns each image over rather than doing it in the
shader — but `UNPACK_FLIP_Y_WEBGL` is what a canvas or an `ImageData` upload
obeys, and an `ImageBitmap` ignores it in silence. A model is a poor witness to
that: a car's UV islands are scattered over the sheet, so a flip moves the
paint about rather than turning the car over, and it reads as some other fault
entirely. The array texture is asked directly instead, with a picture that
cannot be mistaken either way up.

### Importing glTF

The same page reads glTF back, so a `.glb` or a `.gltf` opens like any other
model — dropped in, reported on, rendered, its materials editable, and
exportable again. A `.gltf` naming a `.bin` says so if it arrives alone; drop
the `.bin` in with it, or afterwards, and the model fills in.

Reading is checked against the export: every sample is written out as a `.glb`
and opened again, and what comes back has to be the same triangles, the same
size in the same place, and the same materials with the same colours — the
Mercedes' 361,236 triangles included. Since our own exporter writes only the
easy shapes, a hand-written file covers the rest: attributes interleaved behind
a `byteStride`, 16-bit indices, a sparse accessor, a primitive with no indices
at all, and nodes placed by a quaternion and by a matrix.

The reader exists twice — once in Python for `fbxinfo`, once in JavaScript for
the page — and the two are held to the same records, property for property and
array length for array length, on both containers.

### Ground contact

A model floating on nothing reads as a render however well it is lit, so the
viewer puts a floor under it and drops a shadow onto it. The floor sits at the
model's lowest point along whichever axis is up, and fades out a few radii
away, so it reads as a pool of ground rather than a room with edges.

The shadow is a depth map rendered from the sun, once per mesh — orbiting the
camera does not redraw it, which is what keeps a 553,006-triangle scene
interactive. The model samples it too, so it shadows itself: wheel arches and
the underside of a car go dark the way they should. Only back faces go into the
map, which is what stops a surface shadowing itself along every edge it turns
towards the sun.

The **ground** checkbox turns the whole thing off.

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

A material can also be **renamed** — files call things `Material.002`, or call
them in a language you do not read — and the name is what the glTF export
writes. What it is *filed* under does not change: settings stay keyed on the
name the file gave it, so a colour set before a rename and one set after land
on the same material, *From file* undoes the rename along with everything else,
and the row keeps saying `was Chrome` so the name in the Records tab is still
findable. Renaming a material onto a name already in use is refused rather than
done, since two materials of one name are one material to a glTF.

Assignments are remembered per file, and **Save assignment** writes them out as
JSON:

```json
{ "fbxtoolMaterials": 1,
  "materials": {
    "Carroserie": { "colour": [0.02, 0.05, 0.26], "roughness": 0.25 },
    "Material.002": { "name": "Wheel black", "roughness": 0.8 },
    "New material": { "added": true, "name": "Grass", "colour": [0, 0.7, 0.1] } },
  "parts": { "2001": "New material" } }
```

The key is always the file's own name — that is what makes a rename portable —
and `name` is what to call it instead. `parts` says who wears what, keyed by
the model's own address — the UID a 7.x file gives it, the name a 6.x one does
— so the map still finds the part when the file is read again.

**Any material the assignment names that the file has not got is built**, and
`added` only records where it came from. An assignment is a list of materials,
so a material in it exists whether or not the file knows the name, whether or
not anything is wearing it, and whether or not it was made here — which is what
makes one written by hand, or by an older version, work as well as one saved
yesterday.

"Has not got" is asked under both names. Export a model wearing a material made
here and it comes back inside the `.glb` under the name it *goes by* — `Grass`
— while the assignment still files it under the one it was born with, `New
material`. Opening that export with the assignment beside it would otherwise
build a second Grass; the file already provides it, so nothing is built.

Drop that file back in to apply it again, so an assignment can travel with a
model that does not carry its own. Any order will do: with the model, before it
— it waits for one to be opened — or after it. Opening a model starts from
whatever was remembered for that file, so an assignment arriving with it is put
on afterwards rather than before, which is the only order that survives the
load.

So everything about the materials comes back: what they look like, what they
are called, the ones added by hand, and which parts were dressed in them —
from the file, or from what the viewer remembers per model, whichever arrives.
A restored assignment reads as the scene rather than as an unsaved edit: the
Report shows no **Edits** section for it, and **Restore all** goes back to it
rather than past it. **Clear all** drops the lot and returns the file's own.

What does *not* come back is the cutting up: deletes and splits live only as
long as the session, and a material put on one piece of a split part goes with
it — a piece has no name to file it under. Whole parts are what an assignment
can speak about.

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

A factor is not the only place it lives, though, and on a game's cars it is not
where any of it lives. A material that says it is **blended** takes its
coverage from the alpha channel of the colour texture it wears, per pixel: a
Rolls-Royce Cullinan's windscreen states no factor at all and keeps its 26% in
a 128-square of grey, its interior glazing keeps a mask cut to the shape of
each window, and its tail lamps keep their tint the same way. Read as a factor
alone every one of them is a solid panel. A material that says it is **cut
out** is tested against that alpha instead and stays in the solid pass, since a
grille with its holes dropped is opaque everywhere it is drawn at all — cut at
or below the threshold rather than under it, so a file stating zero drops what
is not there, and never above one eight-bit step, because the sampler filters
between mip levels and a badge's transparent surround comes back a hair above
zero a level or two down.

Which pass a triangle belongs to is a property of its material, not of the
pixel: a sheet whose alpha comes out of a texture goes in the blended pass
wherever that texture puts it, so it never lays down depth that the glass
behind it then fails against. Only a material that says nothing about blending,
or that has no colour texture to say it with, stays in the solid pass — so a
file with nothing transparent still never pays for the second pass.

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

- Nothing here writes FBX, OBJ or `.blend`. The web viewer exports glTF, and
  that is the only file it produces.
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
node web/test/ground.js samples/scene_parts.fbx      # the floor and its shadow
node web/test/gltf.js samples/cube_textured.fbx      # export, then validate it
node web/test/subdivide.js model.fbx                 # smoothing through the module
node web/test/smoothing.js samples/cube_binary.fbx samples/scene_parts.fbx
node web/test/gltfin.js samples/cube_textured.fbx     # export, then read it back
node web/test/reload.js a.fbx b.fbx                  # one file replacing another
node web/test/parts.js samples/scene_parts.fbx       # the explode, and picking
node web/test/flip.js samples/scene_parts.fbx        # mirroring, and its winding
node web/test/turn.js samples/scene_parts.fbx        # facing the other way, remembered
node web/test/drop.js samples/pyramid.obj samples/pyramid.mtl samples/checker.png
node web/test/edits.js samples/Shelby.fbx            # deleting and splitting
```

`tests/fbxbuild.py` also writes `.blend` fixtures — a real header, file-blocks
and SDNA — so the container reader is testable without Blender installed, and
glTF fixtures in both containers, written to be awkward on purpose.

The Draco fixtures in `samples/draco` are meshes encoded by Draco's own
encoder, each beside the values Draco's own decoder gives back for it, and the
KTX2 fixtures in `samples/ktx2` are pictures encoded by Binomial's own encoder
beside the pixels its own transcoder gives back. They are regenerated with
`npm i draco3d basis_universal three` and the scripts in the commits that added
them; those packages are test-time oracles only — nothing ships with a
dependency.

The web tests skip cleanly when `clang` or `node` is unavailable.

Building the module needs two things, not one. `clang` compiles it, and
`wasm-ld` links it — which ships with LLVM's `lld` rather than with clang
itself, so a clang that compiles for wasm32 quite happily can still fail to
link. clang looks that linker up on `PATH` and nowhere else (`--ld-path` is
accepted and ignored for this target), so `web/build.py` finds it beside clang
or in the toolchain's own directories and puts it there; if it cannot, it says
what is missing rather than passing clang's `unable to execute command:
program not executable` along. `conda install -c conda-forge lld` is one way to
get it.

The browser harnesses need playwright and, for the export, the Khronos
glTF-Validator (`npm i -g playwright gltf-validator`); `pytest` points Node at
the global install for you.

Two real Blender exports are checked in, and the tests that need a file a real
exporter wrote use them:

| | |
| --- | --- |
| `samples/Mercedes+Benz+GLS+580.fbx` | one mesh of 361,236 triangles, 23 materials, transparent glass |
| `samples/Shelby.fbx` | 44 parts in their own spaces, one material on 24 of them, 20 materials carrying nothing at all |

`FBXTOOL_SAMPLE` and `FBXTOOL_SCENE` point those tests at your own files;
`FBXTOOL_BLEND` does the same for a `.blend` and `FBXTOOL_KN5` for an Assetto
Corsa car, of which none of either is checked in — a car is tens of megabytes
and not ours to redistribute.

`samples/cube_ascii.fbx` is checked in as source; `samples/cube_binary.fbx` and
`samples/scene_parts.fbx` are generated by the same minimal writer the tests
use (`tests/fbxbuild.py`), which covers typed properties, deflated arrays,
nesting, the null terminator and the footer.

## License

MIT
