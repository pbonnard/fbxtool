# Aligning the exporter with the racing game's material handling

**All four are implemented.** What each one became is noted under it; the rest of
this document is the case as it was made, left as written so the reasoning stays
readable next to the code.

The game at `../game` ingests `assets/cars/<id>.glb` through `scripts/build-cars.mjs`, and its test
suites hold every shipped car to a set of material invariants. Eleven cars exported from this tool
were built into it on 15 Aug 2026; **six assertions failed across three suites**, and re-running the
same suites against the previously committed models passes all 52. So the failures are the
round-trip through this tool, not the game's pipeline.

This is what it costs today and what would close it, in order of how much is lost.

Everything below was measured by diffing each car's committed GLB against its re-export, and by
reading `../game/src/specgloss.ts`, `paint.ts` and their suites.

---

## 1. A dielectric's reflectance must stay at 4%

**Blocking. Nine of the eleven cars, 51 materials.** They render as mirrors and cannot be painted.

`web/app/gltf.js:141-147` emits `KHR_materials_specular` whenever the resolved specular differs
from 0.04:

```js
if (metallic < 0.5 && specular.some((c) => Math.abs(c - 0.04) > 0.005)) {
  out.extensions = {
    KHR_materials_specular: { specularColorFactor: specular.map((c) => c / 0.04) },
  };
}
```

The extension defines `F0 = 0.04 × specularColorFactor`, so a factor above 1 *is* a raised
reflectance. `analyze.js:361-369` already knows the danger and caps the source at 0.16:

> A Phong specular colour scales a highlight; it is not a Fresnel reflectance, and taken literally
> it turns every surface into a mirror — OBJ material libraries habitually write `Ks 0.9 0.9 0.9`.

That cap is the right instinct and it is set four times too high. 0.16 permits a factor of **4.0**,
and the Porsche 718 ships materials at **2.139** — F0 0.0856, more than twice a dielectric's.

The game's rule is stricter than "not a mirror" and is deliberate. `specgloss.test.ts:213` asserts
that **no material of any car exceeds F0 0.04**, because `../game/src/specgloss.ts` exists for
exactly this failure: a body whose F0 is raised cancels its own albedo in indirect light
(three gates diffuse by `1 - totalScatteringDielectric`), so a chart colour written to it does not
merely look subtle, it is gone. That file's correction only fires on the `ior: 1000` marker that
gltf-transform writes when converting spec-gloss, so nothing catches a raised
`specularColorFactor`, and these nine cars would ship as tinted mirrors with the paint chart
silently doing nothing.

Affected, by material count: BMW 530e 20, Porsche 718 RS 60 11, Lancia Delta 5, Fiat 500 R 4,
AMG GT 4, Porsche 356 A 3, Civic Si 2, Pajero Sport 1, BMW 850CSi 1.

**Change.** Clamp the factor so it can only ever *lower* reflectance:

```js
const factor = specular.map((c) => c / 0.04);
const peak = Math.max(...factor);
if (peak > 1) for (let i = 0; i < 3; i++) factor[i] /= peak;
if (factor.some((c) => c < 0.999)) {
  out.extensions = { KHR_materials_specular: { specularColorFactor: factor } };
}
```

A genuinely dull dielectric — cloth, some rubbers — still gets its lower reflectance and its hue,
and nothing can exceed 0.04. Dropping the extension entirely would also satisfy the game and is
the smaller change; the clamp is worth the extra three lines because it keeps the information the
extension was added to carry.

Worth doing in `analyze.js` instead if the 0.16 cap has no other consumer, since that is where the
comment explaining the hazard already lives. Check the viewer first — `blend.js:436` reads
`specular` too.

> **Done** in `gltf.js`, as the clamp above. The 0.16 cap stays where it is: it feeds the viewer's
> shading, and it is not the only source of a raised reflectance anyway — `blend.js:436` hands a
> Blender dielectric 8% with `Metallic` stated beside it, which the cap never sees. Clamping at the
> point of writing catches every path into the exporter rather than one of them.

## 2. Every texture slot but base colour is dropped

**Blocking for the four cars that had textures.** Not a bug so much as a shape: the palette carries
one image per material, end to end. `gltfin.js:370` reads `pbr.baseColorTexture` (or spec-gloss
`diffuseTexture`) and nothing else; `gltf.js:135` writes `baseColorTexture` and nothing else.

Measured, committed model → re-export:

| car | textures | texture slots | what is lost |
|---|---|---|---|
| Mercedes-AMG GT | 24 → 13 | 25 → 13 | 9 normal, 2 metallicRoughness, 1 emissive |
| Porsche 356 A | 39 → 18 | 49 → 19 | 30 slots |
| Lancia Delta | 14 → 11 | 22 → 18 | 4 slots |
| Civic Si | 11 → 9 | 18 → 15 | 3 slots |

The AMG GT's is the clearest: it goes from `{baseColor: 13, normal: 9, metallicRoughness: 2,
emissive: 1}` to `{baseColor: 13}`. Every normal map on the car is gone, which on a body panel is
the difference between a shut line and a painted-on stripe.

This matters more than it looks, because the game's own converter works hard for exactly these
slots. `../game/scripts/fbx-textures.py` runs Blender headless purely as an FBX *parser*, walking
the map graph to its leaves, and recovers four: diffuse, bump/normal, gloss inverted into
roughness, and opacity. That is what took the 190 SL from 0 textures to 111. Re-exporting such a
car through this tool undoes it.

**Change, minimal version: pass through what is not edited.** The tool's job is materials and
geometry; it has no opinion about a normal map. Keep the imported material's other texture
references and their images as opaque payload on the palette entry, and write them back out
unchanged. Nothing needs to decode or display them — an untouched `normalTexture` index plus its
image bytes is enough, and it costs one map lookup per slot rather than a rework of the palette.

The full version — reading, showing and editing all four slots — is a real feature and worth
scoping separately. The pass-through removes the data loss without it.

While in there: `gltf.js:228` writes one shared `sampler: 0`. Imported samplers carry wrap modes,
and a tiling trim or tread that comes back clamped is a visible change on a wheel.

> **Done**, the minimal version. The reader gives every map its own `Texture` record under the FBX
> property name for the slot it fills, with the sampler's wrap modes beside it; the palette carries
> them as opaque payload; the writer puts them back. Four slots survive — normal, metallic-roughness,
> occlusion, emissive — and an image several materials share is now stored once, which it was not
> before and matters more now that three times as many are written. Two things came with it that the
> pass-through would be dead weight without: `emissiveFactor`, since glTF defaults it to black and an
> emissive map multiplied by black lights nothing, and per-sampler wrap modes. Mirrored repeat has no
> FBX spelling and comes back repeating. `Bump` is read as a normal map, which is an assumption — the
> slot holds a height map in principle and a tangent-space normal map in practice.
>
> Not done, as scoped: reading, showing and editing the four slots. That is still a real feature.

## 3. An export should say what it dropped

**Safety, and it would have caught both of the remaining failures.** Materials and nodes disappear
silently:

| car | materials | nodes |
|---|---|---|
| Land Cruiser J100 | 19 → 14 | 174 → 166 |
| BMW 850CSi | 19 → 15 | 53 → 49 |
| Mercedes-AMG GT | 23 → 23 | 91 → 40 |
| BMW 530e | 34 → 32 | 238 → 238 |

Most of that is deliberate — the Land Cruiser lost four `LicPlate_*` materials and the 850CSi lost
`Object_24`–`Object_27`, which is somebody removing a number plate, and doing it here is better
than doing it at runtime. But two are not:

- **Land Cruiser: `Toyota_Land_Cruiser_Mk7f_J100_VX_2005_carpaint` is gone** along with the
  plates, leaving `..._carpaint_second`. That is the material the game files as this car's
  bodywork, so the car is no longer paintable and three assertions fail on it. Whether the merge
  was intended is a question only the edit knows — the point is that nothing said it happened.
- **AMG GT: 91 nodes → 40.** Names are how the game finds things: `strip.json` names nodes to
  remove and `cars.generated.ts` names the four wheel nodes, looked up by name at mount, where a
  missing one throws on the way to the grid rather than merely looking wrong.

**Change.** On export, diff against what was imported and print it — *n* materials removed (named),
*n* nodes removed, *n* renamed. A line of text. Removing a plate then reads as four expected names
rather than as silence.

> **Done.** The writer hands back the names it wrote; the export diffs them against every `Material`
> and `Model` in the file. The status line carries the counts and the first three names of each, the
> console the whole list, and `lastExport.dropped` the same for anything checking it. An export that
> dropped nothing says so, which is the other half of not being silent. A single geometry has no
> scene to compare against and reports nothing.

## 4. `alphaMode` is decided by the opacity factor alone

`gltf.js:132` sets `alphaMode: opacity < OPAQUE ? 'BLEND' : 'OPAQUE'`, which is the wrong question
to ask: an opacity *factor* is not the only place transparency lives.

The AMG GT went from 6 BLEND materials to 3. The three that flipped are
`MMercedesAMG_GT_2015BadgeA_Material1`, `...CalliperBadgeA_Material1` and
`...InteriorA_Material1`, and in every case the source declared `BLEND` with **no
`baseColorFactor` at all** — so alpha defaulted to 1 and the transparency was in the texture's own
alpha channel. Two of the three are badges, which is the case that shows: a badge is a decal whose
texture is mostly transparent, and drawn opaque it is a solid rectangle stuck to the car.

**Change.** Keep the imported `alphaMode` and `alphaCutoff` unless the opacity is actually edited,
and treat a base-colour image with an alpha channel as reason for `BLEND`.

This one is mild: `../game/src/blending.ts` corrects materials that declare blending they do not
use, so a false BLEND is handled. A false OPAQUE is not — nothing can put transparency back.

> **Done.** The reader records `AlphaMode` and `AlphaCutoff`; the palette keeps them until the
> opacity is actually edited, at which point the factor is the answer; the writer uses them. A file
> that declared `OPAQUE` is taken at its word too — that is what keeping the imported mode means, and
> glTF's own default is `OPAQUE`, so a document that omits the field is asking for it. The
> alpha-channel rule therefore only fires for formats with no such field at all — FBX, `.obj`,
> `.blend`, `.max` — which is where it is the only signal there is. A PNG is read for a colour type
> with alpha or a `tRNS` chunk; a canvas re-encode is checked pixel by pixel, since it always writes
> RGBA and its header would otherwise call every KTX2 texture transparent.

---

## What the game already corrects — do not duplicate these

Worth knowing so effort does not go into the wrong half. Each of these is a documented correction
applied at load, and an export that "helps" by pre-correcting them will fight the code:

- **Green glass** (`tint.ts`) — real glass is green and modellers record it as base colour where
  their renderer read it as absorption. The game neutralises it, keeping luminance, and leaves
  anything red-leading alone so tail lights survive. Export the model's own colour.
- **Doubly-mirrored wheels** (`winding.ts`) — a geometry every instance of which is mirrored gets
  re-wound. Do not pre-flip.
- **Rigid skins** (`deskin.ts`) — a skinned mesh nothing animates is replaced with a plain one.
  Better still, do not export skins at all.
- **Axes and units** (`orient-car.mjs`) — normalised at ingest to +Y up, +Z forward, origin on the
  ground plane. `gltf.js:103` already does the up-axis part.
- **Colliding node names** (`unique-names.mjs`) — made unique after three.js sanitises them.

And two things the game needs that are easy to lose: **material names are the key** for
`paint.json`, `carColours.json` and the garage's colour chart, and **node names are the key** for
`strip.json` and the wheels. Both survive the current exporter intact, which is worth keeping.

## Follow-ups on the game side, not this tool's problem

- `paint.json`'s Land Cruiser entry points at a material the edited model no longer has. Repoint it
  at `..._carpaint_second` or restore the name on export — depends on §3.
- `strip.json`'s `1996_bmw_850csi_e31: Object_25` is now redundant; the edit already removed it.
  Deleting the entry is the fix.
- Neither is caught by `pnpm build`, which runs the stamp gates, `tsc` and `vite build` and never
  looks at a material. Only `pnpm test` catches this class.

## Where it landed

| | |
|---|---|
| §1 reflectance | `web/app/gltf.js` — `material()` |
| §2 texture slots | `web/app/analyze.js` `textureSlot`/`wrapModes`, `gltfin.js` `emitTexture`, `main.js` `materialTextures`/`textureBytes`, `gltf.js` `textureFor`/`slotsFor`/`samplerFor` |
| §3 what was dropped | `main.js` `reportDropped`/`describeDropped`, on names `gltf.js` hands back in `stats` |
| §4 blending | `analyze.js` `materialAppearance`, `palette.js` `apply`, `gltf.js` `alphaModeOf` |

The glTF reader is two parallel implementations, so §2 and §4's reading half is mirrored in
`fbxtool/gltf.py`. Checks are in `web/test/units.js` (Node, no browser) and `tests/test_gltf.py`,
with the browser export harness `web/test/gltf.js` extended to assert that no dielectric leaves
above 4%, that every texture names an image and a sampler that are there, and that an edit says
what it removed. The browser suites need the WebAssembly build (`python web/build.py`), which
wants a clang that can target wasm; they were not run here.
