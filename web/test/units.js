/* Unit checks for the pure-JavaScript modules, run under Node.
 *
 *   node web/test/units.js
 *
 * The browser harness proves a file ends up on screen; this proves the maths
 * that puts it there. Expected values are worked out by hand rather than
 * captured from the code, so a change of convention has to fail here.
 */
'use strict';

const path = require('path');

const APP = path.resolve(__dirname, '..', 'app');
const T = require(path.join(APP, 'transform.js'));
const FbxAscii = require(path.join(APP, 'ascii.js'));
const FbxAnalyze = require(path.join(APP, 'analyze.js'));
const FbxPalette = require(path.join(APP, 'palette.js'));
const FbxGltf = require(path.join(APP, 'gltf.js'));
const FbxGltfIn = require(path.join(APP, 'gltfin.js'));
const FbxEdits = require(path.join(APP, 'edits.js'));

let failures = 0;

function check(label, condition, detail = '') {
  if (!condition) failures++;
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? `  — ${detail}` : ''}`);
}

/** Apply a column-major 4x4 to a point. */
function apply(m, p) {
  return [0, 1, 2].map((r) => m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r]);
}

const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;
const nearAll = (a, b, tol = 1e-9) => a.length === b.length
  && a.every((v, i) => near(v, b[i], tol));
const show = (v) => `[${v.map((x) => (Math.abs(x) < 1e-12 ? 0 : x).toFixed(3)).join(', ')}]`;

console.log('transform: basics');
check('identity leaves a point alone', nearAll(apply(T.identity(), [1, 2, 3]), [1, 2, 3]));
check('multiply applies the right-hand matrix first',
  // Scale by 2 then translate by 10: T * S maps 1 to 12, S * T maps 1 to 22.
  nearAll(apply(T.multiply(T.localMatrix({ 'Lcl Translation': [10, 0, 0] }),
    T.localMatrix({ 'Lcl Scaling': [2, 2, 2] })), [1, 0, 0]), [12, 0, 0]));

console.log('\ntransform: rotation');
// Right-handed, counter-clockwise looking down the axis towards the origin.
check('90° about X sends +Y to +Z', nearAll(apply(T.euler([90, 0, 0]), [0, 1, 0]), [0, 0, 1]));
check('90° about Y sends +Z to +X', nearAll(apply(T.euler([0, 90, 0]), [0, 0, 1]), [1, 0, 0]));
check('90° about Z sends +X to +Y', nearAll(apply(T.euler([0, 0, 90]), [1, 0, 0]), [0, 1, 0]));

// Order matters: FBX EulerXYZ turns about X first, so X is right-most in the
// product (R = Rz * Ry * Rx). Taking (1,0,0): X leaves it, then Y sends it to
// (0,0,-1). The opposite composition would give (0,1,0) instead.
const xyz = apply(T.euler([90, 90, 0], 0), [1, 0, 0]);
check('EulerXYZ turns about X first', nearAll(xyz, [0, 0, -1]), show(xyz));
// EulerZYX is the same three turns in the opposite order: Z first, X last.
const zyx = apply(T.euler([90, 90, 0], 5), [1, 0, 0]);
check('EulerZYX turns about Z first', nearAll(zyx, [0, 1, 0]), show(zyx));

console.log('\ntransform: the local matrix chain');
check('translation, rotation and scale compose in FBX order',
  // Scale (2,3,4) first, then turn 90° about Z, then translate: the point
  // (1,0,0) becomes (0,2,0) after scale+turn, and lands at (5,2,0).
  nearAll(apply(T.localMatrix({
    'Lcl Translation': [5, 0, 0],
    'Lcl Rotation': [0, 0, 90],
    'Lcl Scaling': [2, 3, 4],
  }), [1, 0, 0]), [5, 2, 0]));

check('a rotation pivot turns about its own point',
  // Turning 180° about Z around the pivot (10,0,0) reflects x through 10.
  nearAll(apply(T.localMatrix({
    'Lcl Rotation': [0, 0, 180],
    RotationPivot: [10, 0, 0],
  }), [11, 0, 0]), [9, 0, 0], 1e-9));

check('a scaling pivot scales about its own point',
  nearAll(apply(T.localMatrix({
    'Lcl Scaling': [3, 1, 1],
    ScalingPivot: [4, 0, 0],
  }), [5, 0, 0]), [7, 0, 0]));

check('a pre-rotation sits outside the local rotation',
  // Rpre is left of R in the chain, so a point turns by R first: (1,0,0)
  // becomes (0,1,0) about Z, and the pre-rotation about X lifts it to (0,0,1).
  // Composed the other way round the point would stop at (0,1,0).
  nearAll(apply(T.localMatrix({
    'Lcl Rotation': [0, 0, 90],
    PreRotation: [90, 0, 0],
  }), [1, 0, 0]), [0, 0, 1]));

check('a post-rotation is undone, as the chain inverts it',
  nearAll(apply(T.localMatrix({
    'Lcl Rotation': [0, 0, 90],
    PostRotation: [0, 0, 90],
  }), [1, 0, 0]), [1, 0, 0], 1e-12));

check('RotationOrder is honoured',
  nearAll(apply(T.localMatrix({ 'Lcl Rotation': [90, 90, 0], RotationOrder: 5 }),
    [1, 0, 0]), [0, 1, 0]));

console.log('\ntransform: mirroring and normals');
check('a positive transform keeps its winding',
  T.determinant3(T.localMatrix({ 'Lcl Scaling': [2, 3, 4] })) > 0);
check('a negative scale mirrors',
  T.determinant3(T.localMatrix({ 'Lcl Scaling': [1, -1, 1] })) < 0);
check('two negative scales do not mirror',
  T.determinant3(T.localMatrix({ 'Lcl Scaling': [-1, -1, 1] })) > 0);
check('the normal matrix undoes a non-uniform scale',
  // Squashing y by 1/2 must stretch the y of a normal by 2, not squash it.
  nearAll(T.normalMatrix(T.localMatrix({ 'Lcl Scaling': [1, 0.5, 1] })),
    [1, 0, 0, 0, 2, 0, 0, 0, 1]));
check('the normal matrix keeps a rotation as it is',
  nearAll(T.normalMatrix(T.euler([0, 0, 90])).map((v) => Math.round(v * 1e9) / 1e9),
    [0, 1, 0, -1, 0, 0, 0, 0, 1]));

console.log('\ntransform: the geometric transform');
check('absent geometric properties mean no matrix',
  T.geometricMatrix({ 'Lcl Translation': [1, 2, 3] }) === null);
check('a geometric translation offsets the mesh',
  nearAll(apply(T.geometricMatrix({ GeometricTranslation: [0, 0, 7] }), [0, 0, 0]),
    [0, 0, 7]));

console.log('\nanalyze: PropertyTemplate defaults');
const ascii = `
FBXHeaderExtension:  {
\tFBXVersion: 7400
}
Definitions:  {
\tObjectType: "Material" {
\t\tPropertyTemplate: "FbxSurfacePhong" {
\t\t\tProperties70:  {
\t\t\t\tP: "DiffuseColor", "Color", "", "A", 0.8, 0.1, 0.05
\t\t\t\tP: "ShininessExponent", "Number", "", "A", 20
\t\t\t}
\t\t}
\t}
}
Objects:  {
\tMaterial: 3000, "Material::plain", "" {
\t\tShadingModel: "phong"
\t}
\tMaterial: 3001, "Material::painted", "" {
\t\tShadingModel: "phong"
\t\tProperties70:  {
\t\t\tP: "DiffuseColor", "Color", "", "A", 0, 0.5, 1
\t\t}
\t}
}
Connections:  {
}
`;
const doc = FbxAscii.parse(ascii);
const info = FbxAnalyze.analyze(doc);
const templates = FbxAnalyze.propertyTemplates(doc.root);
check('the template is read', templates.Material
  && nearAll(templates.Material.DiffuseColor || [], [0.8, 0.1, 0.05]),
  JSON.stringify(templates.Material));
check('analyze carries the templates', info.templates
  && info.templates.Material !== undefined);

const plain = info.objects.find((o) => o.displayName === 'plain');
const painted = info.objects.find((o) => o.displayName === 'painted');
check('a material with no properties falls back to the template',
  nearAll(FbxAnalyze.resolvedProperties(plain, templates).DiffuseColor, [0.8, 0.1, 0.05]));
check('the template also supplies scalars',
  FbxAnalyze.resolvedProperties(plain, templates).ShininessExponent === 20);
check('a material with its own colour keeps it',
  nearAll(FbxAnalyze.resolvedProperties(painted, templates).DiffuseColor, [0, 0.5, 1]));
check('and still inherits what it does not set',
  FbxAnalyze.resolvedProperties(painted, templates).ShininessExponent === 20);

console.log('\nanalyze: material appearance');
// The Mercedes writes exactly this: a Phong material with a specular tint of
// its own colour at a quarter strength, and a shininess of 25.
const paint = FbxAnalyze.materialAppearance({
  DiffuseColor: [0.582, 0.579, 0.563],
  SpecularColor: [0.582, 0.579, 0.563],
  SpecularFactor: 0.25,
  ShininessExponent: 25,
});
check('the diffuse colour comes through', nearAll(paint.colour, [0.582, 0.579, 0.563]));
check('the specular factor scales the specular colour',
  nearAll(paint.specular, [0.1455, 0.14475, 0.14075], 1e-6), show(paint.specular));
/* An exponent meets a roughness through the microfacet alpha, and there are
 * two squarings in the way of it: `alpha = sqrt(2 / (n + 2))` is the relation,
 * and `alpha = roughness * roughness` is what a modern renderer means by the
 * word. So the roughness is the fourth root — 0.5217 for an exponent of 25.
 * Handing the alpha over as the roughness instead squares it twice, and 25 is
 * drawn as 340. */
check('shininess becomes roughness', near(paint.roughness, (2 / 27) ** 0.25, 1e-9),
  paint.roughness.toFixed(4));
check('and the exponent survives the round trip',
  near(2 / paint.roughness ** 4 - 2, 25, 1e-6), (2 / paint.roughness ** 4 - 2).toFixed(4));
check('an opaque material has full opacity', paint.opacity === 1);

// The Shelby's materials are empty, so this is what its template supplies.
// Its specular of 0.2 lands just above the dielectric cap.
const template = FbxAnalyze.materialAppearance({
  DiffuseColor: [0.8, 0.8, 0.8], DiffuseFactor: 1,
  SpecularColor: [0.2, 0.2, 0.2], SpecularFactor: 1, ShininessExponent: 20,
});
check('template values give a plausible finish',
  nearAll(template.colour, [0.8, 0.8, 0.8]) && nearAll(template.specular, [0.16, 0.16, 0.16])
  && near(template.roughness, (2 / 22) ** 0.25, 1e-9), template.roughness.toFixed(4));

check('a diffuse factor scales the colour',
  nearAll(FbxAnalyze.materialAppearance({ DiffuseColor: [1, 0.5, 0], DiffuseFactor: 0.5 })
    .colour, [0.5, 0.25, 0]));
check('a Lambert material falls back to a dielectric specular',
  nearAll(FbxAnalyze.materialAppearance({ DiffuseColor: [1, 1, 1] }).specular,
    [0.04, 0.04, 0.04]));
// `Ks 0.9 0.9 0.9` is ordinary in an OBJ material library, and as a Fresnel
// reflectance it would make a mirror of a painted wall.
check('a Phong highlight colour is capped at a dielectric reflectance',
  nearAll(FbxAnalyze.materialAppearance({ SpecularColor: [0.9, 0.9, 0.9] }).specular,
    [0.16, 0.16, 0.16], 1e-9));
check('the cap keeps the tint',
  nearAll(FbxAnalyze.materialAppearance({ SpecularColor: [0.8, 0.4, 0.2] }).specular,
    [0.16, 0.08, 0.04], 1e-9));
check('a stated metalness is left alone',
  nearAll(FbxAnalyze.materialAppearance({ SpecularColor: [0.9, 0.8, 0.4], Metallic: 1 })
    .specular, [0.9, 0.8, 0.4]));
check('a scalar colour is spread across the channels',
  nearAll(FbxAnalyze.materialAppearance({ DiffuseColor: 0.5 }).colour, [0.5, 0.5, 0.5]));
check('a mirror is still given some roughness',
  FbxAnalyze.materialAppearance({ ShininessExponent: 1e9 }).roughness === 0.05);
check('no properties at all still gives a usable material', (() => {
  const look = FbxAnalyze.materialAppearance({});
  return look.colour.length === 3 && look.roughness > 0 && look.opacity === 1;
})());
check('transparency becomes opacity',
  FbxAnalyze.materialAppearance({ TransparencyFactor: 0.25 }).opacity === 0.75);
check('opacity is read when transparency is absent',
  FbxAnalyze.materialAppearance({ Opacity: 0.4 }).opacity === 0.4);

console.log('\nanalyze: which property carries the base colour');
check('standard FBX', FbxAnalyze.drivesBaseColour('DiffuseColor'));
check('the short form', FbxAnalyze.drivesBaseColour('Diffuse'));
// What 3ds Max with Corona writes, and what Maya writes.
check('a vendor property', FbxAnalyze.drivesBaseColour('3dsMax|CoronaMtlPb|texmapDiffuse'));
check('another vendor property', FbxAnalyze.drivesBaseColour('Maya|baseColor'));
check('bump maps are not base colour',
  !FbxAnalyze.drivesBaseColour('3dsMax|CoronaMtlPb|texmapBump'));
check('nor are glossiness maps',
  !FbxAnalyze.drivesBaseColour('3dsMax|CoronaMtlPb|texmapReflectGlossiness'));
check('nor normal maps', !FbxAnalyze.drivesBaseColour('3dsMax|CoronaNormalPb|normalMap'));
check('nor a missing property', !FbxAnalyze.drivesBaseColour(null)
  && !FbxAnalyze.drivesBaseColour(undefined) && !FbxAnalyze.drivesBaseColour(''));

console.log('\nanalyze: the other maps, which are carried rather than drawn');
check('a normal map is named as one',
  FbxAnalyze.textureSlot('NormalMap') === 'normal'
  && FbxAnalyze.textureSlot('3dsMax|CoronaMtlPb|texmapBump') === 'normal');
check('so are the rest of the slots glTF keeps',
  FbxAnalyze.textureSlot('EmissiveColor') === 'emissive'
  && FbxAnalyze.textureSlot('AmbientOcclusion') === 'occlusion'
  && FbxAnalyze.textureSlot('MetallicRoughness') === 'metallicRoughness');
check('a glossiness map is still nothing this tool can place',
  FbxAnalyze.textureSlot('3dsMax|CoronaMtlPb|texmapReflectGlossiness') === null);
/* V-Ray and Corona both write the underscored spelling, and between them that
 * is most of what comes out of 3ds Max: a Toyota, a Mini and a Volkswagen in
 * one library named every one of their maps `3dsMax|maps|texmap_diffuse` and
 * not one of them bound. */
check('the underscored spelling is the same slot',
  FbxAnalyze.textureSlot('3dsMax|maps|texmap_diffuse') === 'baseColor'
  && FbxAnalyze.textureSlot('3dsMax|maps|texmap_bump') === 'normal',
  String(FbxAnalyze.textureSlot('3dsMax|maps|texmap_diffuse')));
check('and reflection is still not one of them',
  FbxAnalyze.textureSlot('3dsMax|maps|texmap_reflection') === null
  && FbxAnalyze.textureSlot('3dsMax|maps|texmap_reflectionGlossiness') === null);
check('a base colour under any of its spellings',
  ['Maya|base_color', '3dsMax|main|base_color', 'Maya|baseColor', 'DiffuseColor']
    .every((name) => FbxAnalyze.drivesBaseColour(name)));
check('wrap modes come back as the numbers glTF writes',
  FbxAnalyze.wrapModes({ WrapModeU: 1, WrapModeV: 0 }).wrapS === 33071
  && FbxAnalyze.wrapModes({ WrapModeU: 1, WrapModeV: 0 }).wrapT === 10497);
check('and a texture that says nothing repeats',
  FbxAnalyze.wrapModes({}).wrapS === 10497 && FbxAnalyze.wrapModes({}).wrapT === 10497);

console.log('\nanalyze: emission and blending');
check('an emissive colour is scaled by its factor',
  nearAll(FbxAnalyze.materialAppearance({ EmissiveColor: [1, 0.5, 0], EmissiveFactor: 0.5 })
    .emissive, [0.5, 0.25, 0]));
check('a material that gives off nothing says so',
  nearAll(FbxAnalyze.materialAppearance({}).emissive, [0, 0, 0]));
check('a declared alpha mode is read',
  FbxAnalyze.materialAppearance({ AlphaMode: 'BLEND' }).alphaMode === 'BLEND'
  && FbxAnalyze.materialAppearance({ AlphaMode: 'MASK', AlphaCutoff: 0.3 }).alphaCutoff === 0.3);
check('and a file that declares none says nothing',
  FbxAnalyze.materialAppearance({}).alphaMode === null);

console.log('\ngltf in: recognising the file at all');
/* JSON has no prescribed key order, and an exporter that sorts its keys writes
 * `accessors` first. Pretty-printed one number to a line that array runs to
 * 132 KB in a Sketchfab export of an E-Type, which puts the one block naming
 * the file a glTF far past any head worth sniffing. */
const farOff = new TextEncoder().encode(`{\n  "accessors": [${' '.repeat(200000)}],\n`
  + '  "asset": {\n    "generator": "Sketchfab-16.99.0",\n    "version": "2.0"\n  }\n}\n');
check('a .gltf is recognised however far in its asset block sits',
  FbxGltfIn.looksLikeGltf(farOff), `"asset" at byte ${farOff.indexOf(0x61, 6)}`);
check('a .glb is still known from its magic',
  FbxGltfIn.looksLikeGltf(new TextEncoder().encode('glTF\0\0\0\0\0\0\0')));
check('a stray JSON file is still not claimed',
  !FbxGltfIn.looksLikeGltf(new TextEncoder().encode(
    `{"fbxtoolMaterials":1,"materials":{"asset":{"opacity":1}}${' '.repeat(9000)}}`)));
check('nor is a binary file that never opens a brace',
  !FbxGltfIn.looksLikeGltf(new TextEncoder().encode('Kaydara FBX Binary  \0\0')));
check('nor a glTF 1 document',
  !FbxGltfIn.looksLikeGltf(new TextEncoder().encode('{"asset":{"version":"1.0"}}')));

console.log('\ngltf in: what a material brings with it');
/* A document whose one material wears four maps, declares blending it does not
 * spend on its base colour factor, glows, and samples one of its images
 * clamped. Everything here but the base colour is carried rather than drawn,
 * and all of it is what an export has to put back. */
const image = (tag) => ({ uri: `data:image/png;base64,${Buffer.from(tag).toString('base64')}` });
const document = {
  asset: { version: '2.0' },
  scene: 0,
  scenes: [{ nodes: [] }],
  images: [image('base'), image('norm'), image('emis'), image('mr')],
  samplers: [{ wrapS: 10497, wrapT: 10497 }, { wrapS: 33071, wrapT: 33071 }],
  textures: [
    { sampler: 1, source: 0 }, { sampler: 0, source: 1 },
    { sampler: 0, source: 2 }, { sampler: 0, source: 3 },
  ],
  materials: [{
    name: 'badge',
    alphaMode: 'BLEND',
    emissiveFactor: [0.5, 0.25, 0],
    pbrMetallicRoughness: {
      metallicFactor: 0,
      roughnessFactor: 0.4,
      baseColorTexture: { index: 0 },
      metallicRoughnessTexture: { index: 3 },
    },
    normalTexture: { index: 1 },
    emissiveTexture: { index: 2 },
  }],
};
const readBack = FbxGltfIn.parse(
  new TextEncoder().encode(JSON.stringify(document)));
const readInfo = FbxAnalyze.analyze(readBack);
const badgeMaterial = readInfo.objects.find((o) => o.displayName === 'badge');
const badgeProps = FbxAnalyze.resolvedProperties(badgeMaterial, readInfo.templates);
const badgeLook = FbxAnalyze.materialAppearance(badgeProps);
check('four maps come across, not one',
  readInfo.objects.filter((o) => o.nodeType === 'Texture').length === 4,
  `${readInfo.objects.filter((o) => o.nodeType === 'Texture').length} texture(s)`);
const boundSlots = readInfo.connections
  .filter((c) => c.kind === 'OP')
  .map((c) => FbxAnalyze.textureSlot(c.prop))
  .sort();
check('each under the slot it fills',
  boundSlots.join(',') === 'baseColor,emissive,metallicRoughness,normal',
  boundSlots.join(','));
check('the clamped sampler comes with the texture it clamps', (() => {
  const clamped = readInfo.objects.filter((o) => o.nodeType === 'Texture')
    .map((o) => FbxAnalyze.wrapModes(FbxAnalyze.properties(o.node)))
    .filter((w) => w.wrapS === 33071);
  return clamped.length === 1;
})());
check('the declaration of blending survives at full opacity',
  badgeLook.alphaMode === 'BLEND' && badgeLook.opacity === 1);
check('and so does what the material gives off',
  nearAll(badgeLook.emissive, [0.5, 0.25, 0], 1e-9), show(badgeLook.emissive));

/* glTF names what sits beside it with a URI, and a URI escapes what it cannot
 * hold: a space becomes %20, and so does every byte of a name that is not
 * ASCII. The file on disk has no escapes in it, so the name has to come back
 * out of the URI before anything can be matched against what was supplied. */
const escaped = FbxGltfIn.parse(new TextEncoder().encode(JSON.stringify({
  asset: { version: '2.0' },
  scene: 0,
  scenes: [{ nodes: [] }],
  images: [{ uri: 'textures/tyre%20map%C3%A9.png' }],
  textures: [{ source: 0 }],
  materials: [{ name: 'm', pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
})));
const escapedTexture = FbxAnalyze.analyze(escaped).objects.find((o) => o.nodeType === 'Texture');
check('an escaped image URI names the file it actually is',
  FbxAnalyze.pathValue(escapedTexture.node, ['RelativeFilename']) === 'textures/tyre mapé.png',
  FbxAnalyze.pathValue(escapedTexture.node, ['RelativeFilename']));
check('a buffer named the same way is asked for by that name too', (() => {
  const doc = FbxGltfIn.parse(new TextEncoder().encode(JSON.stringify({
    asset: { version: '2.0' },
    buffers: [{ uri: 'my%20scene.bin', byteLength: 4 }],
  })));
  return doc.warnings.some((w) => /my scene\.bin/.test(w));
})());
check('and a stray per-cent that is no escape is left as it is', (() => {
  const doc = FbxGltfIn.parse(new TextEncoder().encode(JSON.stringify({
    asset: { version: '2.0' },
    buffers: [{ uri: '100%.bin', byteLength: 4 }],
  })));
  return doc.warnings.some((w) => /100%\.bin/.test(w));
})());

console.log('\npalette: colour inputs');
// A colour input speaks sRGB; shading is linear. Mid grey is the giveaway:
// 0.5 linear encodes to #bcbcbc, not #808080.
check('linear to sRGB and back', near(FbxPalette.fromSrgb(FbxPalette.toSrgb(0.37)), 0.37, 1e-12));
check('mid linear grey is not mid sRGB grey', FbxPalette.toHex([0.5, 0.5, 0.5]) === '#bcbcbc',
  FbxPalette.toHex([0.5, 0.5, 0.5]));
check('black and white survive',
  FbxPalette.toHex([0, 0, 0]) === '#000000' && FbxPalette.toHex([1, 1, 1]) === '#ffffff');
check('a hex colour comes back linear',
  nearAll(FbxPalette.fromHex('#bcbcbc'), [0.5, 0.5, 0.5], 0.005),
  show(FbxPalette.fromHex('#bcbcbc')));
check('short hex works too', nearAll(FbxPalette.fromHex('#fff'), [1, 1, 1]));

console.log('\npalette: grouping');
const entry = (name, uid) => ({
  name,
  uid,
  colour: [0.8, 0.8, 0.8],
  specular: [0.04, 0.04, 0.04],
  roughness: 0.3,
  opacity: 1,
  fromFile: { colour: [0.8, 0.8, 0.8], specular: [0.04, 0.04, 0.04], roughness: 0.3, opacity: 1 },
});
// Three slots, two materials: the first is used by two parts.
const slots = [entry('paint', 10), entry('glass', 11), entry('paint', 10)];
const list = FbxPalette.groups(slots, [30, 90, 10]);
check('slots of one material become one row', list.length === 2, `${list.length} rows`);
check('the biggest surface comes first', list[0].name === 'glass', list.map((g) => g.name).join(', '));
check('a shared material keeps all its slots',
  list[1].slots.length === 2 && list[1].triangles === 40,
  `${list[1].slots.length} slots, ${list[1].triangles} triangles`);
check('shares add up to one',
  near(list.reduce((sum, g) => sum + g.share, 0), 1, 1e-9));
check('every slot learns its group',
  slots[0].group === 1 && slots[2].group === 1 && slots[1].group === 0);

console.log('\npalette: assignments');
FbxPalette.apply(slots, { paint: { colour: [0.2, 0.4, 0.6], roughness: 0.9 } });
check('an assignment reaches every slot of its material',
  nearAll(slots[0].colour, [0.2, 0.4, 0.6]) && nearAll(slots[2].colour, [0.2, 0.4, 0.6])
  && slots[0].roughness === 0.9 && slots[2].roughness === 0.9);
check('and leaves the other material alone',
  nearAll(slots[1].colour, [0.8, 0.8, 0.8]) && slots[1].roughness === 0.3);
FbxPalette.apply(slots, {});
check('clearing it restores the file exactly',
  nearAll(slots[0].colour, [0.8, 0.8, 0.8]) && slots[0].roughness === 0.3
  && nearAll(slots[0].specular, [0.04, 0.04, 0.04]) && slots[0].opacity === 1);

FbxPalette.apply(slots, { paint: { colour: [0.9, 0.8, 0.5], metallic: 1 } });
check('a metal takes its reflectance from its colour',
  nearAll(slots[0].specular, [0.9, 0.8, 0.5]) && nearAll(slots[0].colour, [0, 0, 0]),
  show(slots[0].specular));
FbxPalette.apply(slots, { paint: { colour: [0.9, 0.8, 0.5], metallic: 0 } });
check('a dielectric reflects four per cent', nearAll(slots[0].specular, [0.04, 0.04, 0.04]));

/* A material the file states a metalness for arrives already split between a
 * diffuse and a reflectance, and `base` is what it was before the split. The
 * controls edit that, and everything the user has not set has to fall back to
 * the file rather than to zero — a metal whose metalness fell back to zero
 * became a dark dielectric the moment anything at all was set on it, and that
 * was what got remembered against the file. */
const metal = () => {
  const made = entry('chrome', 12);
  made.fromFile = {
    name: 'chrome',
    colour: [0, 0, 0],                 // a full metal keeps no diffuse
    base: [0.86, 0.87, 0.89],
    specular: [0.86, 0.87, 0.89],
    roughness: 0.08,
    opacity: 1,
    metallic: 1,
  };
  return made;
};
const chromeRow = FbxPalette.groups([metal()], [10])[0];
const asRead = FbxPalette.settingsFor(chromeRow, {});
check('the controls open on the metalness the file states', asRead.metallic === 1,
  String(asRead.metallic));
check('and on the colour before it was split, not on the black half',
  nearAll(asRead.colour, [0.86, 0.87, 0.89]), show(asRead.colour));

const renamedMetal = [metal()];
FbxPalette.apply(renamedMetal, { chrome: { name: 'Bumper' } });
check('a rename leaves a metal a metal',
  renamedMetal[0].metallic === 1 && nearAll(renamedMetal[0].specular, [0.86, 0.87, 0.89])
  && nearAll(renamedMetal[0].colour, [0, 0, 0]),
  show(renamedMetal[0].specular));

const roughMetal = [metal()];
FbxPalette.apply(roughMetal, { chrome: { roughness: 0.4 } });
check('and so does roughing it up',
  roughMetal[0].roughness === 0.4 && roughMetal[0].metallic === 1
  && nearAll(roughMetal[0].specular, [0.86, 0.87, 0.89]),
  show(roughMetal[0].specular));

const repainted = [metal()];
FbxPalette.apply(repainted, { chrome: { colour: [0.9, 0.1, 0.1] } });
check('setting only the colour keeps the file\'s metalness under it',
  repainted[0].metallic === 1 && nearAll(repainted[0].specular, [0.9, 0.1, 0.1]),
  show(repainted[0].specular));

const demetalled = [metal()];
FbxPalette.apply(demetalled, { chrome: { metallic: 0 } });
check('and turning the metalness off paints it with the colour it had',
  nearAll(demetalled[0].colour, [0.86, 0.87, 0.89])
  && nearAll(demetalled[0].specular, [0.04, 0.04, 0.04]),
  show(demetalled[0].colour));

/* A material that declared blending keeps that declaration until somebody
 * actually sets an opacity, at which point the factor is the answer. */
const badge = () => {
  const made = entry('badge', 13);
  made.fromFile = {
    name: 'badge',
    colour: [0.8, 0.8, 0.8],
    base: [0.8, 0.8, 0.8],
    specular: [0.04, 0.04, 0.04],
    emissive: [0, 0, 0],
    roughness: 0.4,
    opacity: 1,
    metallic: 0,
    alphaMode: 'BLEND',
    alphaCutoff: null,
  };
  return made;
};
const asRead2 = [badge()];
FbxPalette.apply(asRead2, {});
check('a declared alpha mode survives being read', asRead2[0].alphaMode === 'BLEND');
FbxPalette.apply(asRead2, { badge: { roughness: 0.9 } });
check('and survives an edit that is not about transparency',
  asRead2[0].alphaMode === 'BLEND');
FbxPalette.apply(asRead2, { badge: { opacity: 1 } });
check('but setting the opacity by hand is the decision about transparency',
  asRead2[0].alphaMode === null);

/* Before `base` was written down there is only the split diffuse to go on. */
const older = [metal()];
delete older[0].fromFile.base;
check('an assignment from before it kept a base still reads',
  nearAll(FbxPalette.settingsFor(FbxPalette.groups(older, [10])[0], {}).colour, [0, 0, 0]));

console.log('\npalette: what a material is read as');
const readAs = (props) => FbxAnalyze.materialAppearance(props);
// The material .glb fixtures carry: base 0.8/0.1/0.05, metalness 0.25.
const fromGlb = readAs({
  DiffuseColor: [0.6, 0.075, 0.0375],
  SpecularColor: [0.23, 0.055, 0.0425],
  Metallic: 0.25,
  ShininessExponent: 10.5,
});
check('a metalness already split is put back together for the controls',
  nearAll(fromGlb.base, [0.8, 0.1, 0.05], 1e-6) && fromGlb.metallic === 0.25,
  show(fromGlb.base));
check('a full metal takes its base back from its reflectance',
  nearAll(readAs({ DiffuseColor: [0, 0, 0], SpecularColor: [0.86, 0.87, 0.89], Metallic: 1 }).base,
    [0.86, 0.87, 0.89]));
check('a material with no metalness is its own base',
  nearAll(readAs({ DiffuseColor: [0.4, 0.5, 0.6] }).base, [0.4, 0.5, 0.6]));
// A Physical Material states its metalness rather than splitting it first.
const physical = readAs({
  '3dsMax|main|base_color': [0.8, 0.1, 0.05],
  '3dsMax|main|metalness': 1,
  '3dsMax|main|roughness': 0.3,
});
check('a stated metalness is split here, and the base kept whole',
  nearAll(physical.base, [0.8, 0.1, 0.05]) && nearAll(physical.specular, [0.8, 0.1, 0.05])
  && nearAll(physical.colour, [0, 0, 0]) && physical.roughness === 0.3,
  show(physical.base));

console.log('\npalette: renaming');
// The real shape: an entry remembers the name it was read under.
const named = (name, uid) => {
  const made = entry(name, uid);
  made.fromFile.name = name;
  return made;
};
const two = [named('paint', 10), named('glass', 11)];
FbxPalette.apply(two, { paint: { name: 'Body red', colour: [0.3, 0.02, 0.02] } });
check('a renamed material answers to its new name', two[0].name === 'Body red', two[0].name);
check('and its settings are still filed under the name the file gave it',
  nearAll(two[0].colour, [0.3, 0.02, 0.02]) && two[1].name === 'glass');
const renamedRows = FbxPalette.groups(two, [10, 5]);
check('the list shows the new name and keeps the old one to file under',
  renamedRows[0].name === 'Body red' && renamedRows[0].origin === 'paint',
  `${renamedRows[0].name} was ${renamedRows[0].origin}`);
const renamedSettings = FbxPalette.settingsFor(renamedRows[0], { paint: { name: 'Body red' } });
check('the editor reads the new name back',
  renamedSettings.name === 'Body red' && renamedSettings.renamed === true);
FbxPalette.apply(two, {});
check('and clearing the assignment gives the file\'s name back', two[0].name === 'paint');
const savedName = FbxPalette.parse(
  FbxPalette.serialise({ paint: { name: 'Body red', opacity: 0.5 } })).materials;
check('a saved assignment carries the name with the rest',
  savedName.paint.name === 'Body red' && savedName.paint.opacity === 0.5);
check('a blank name is not a rename',
  !FbxPalette.parse(FbxPalette.serialise({ paint: { name: '   ' } })).materials.paint);

const glassPreset = FbxPalette.preset('glass');
check('presets carry an opacity', glassPreset && glassPreset.opacity < 1,
  glassPreset ? String(glassPreset.opacity) : 'missing');
check('every preset is complete', FbxPalette.PRESETS.every((p) => p.id && p.label
  && Array.isArray(p.colour) && typeof p.roughness === 'number'));

console.log('\npalette: the images a material names');
const namedMaps = {
  name: 'tire',
  texture: { name: 'tire_baseColor', path: 'textures/tire_baseColor.png', embedded: null },
  textures: {
    normal: { name: 'tire_normal', path: 'textures\\tire_normal.png', embedded: null },
    metallicRoughness: { name: 'tire_mr', path: 'tire_metallicRoughness.png', embedded: null },
  },
};
const listed = FbxPalette.maps(namedMaps, new Set(['tire_basecolor.png']));
check('every slot is listed, base colour first and the finish beside it',
  listed.map((m) => m.slot).join(',') === 'baseColor,metallicRoughness,normal',
  listed.map((m) => m.slot).join(','));
check('by the file name, whichever separator the path used',
  listed.map((m) => m.name).join(' ')
  === 'tire_baseColor.png tire_metallicRoughness.png tire_normal.png',
  listed.map((m) => m.name).join(' '));
check('and each says whether it is here', listed[0].here === true
  && listed[1].here === false && listed[2].here === false,
  listed.map((m) => `${m.name}:${m.here}`).join(' '));
check('an image carried inside the file is always here', (() => {
  const inside = FbxPalette.maps(
    { texture: { name: 'checker', path: '', embedded: new Uint8Array([1]) } }, new Set());
  return inside.length === 1 && inside[0].here && inside[0].embedded
    && inside[0].name === 'checker';
})());
check('a material with no images lists none',
  FbxPalette.maps({ name: 'paint' }, new Set()).length === 0);
check('with nothing supplied to compare against, nothing is called missing',
  FbxPalette.maps(namedMaps, null).every((m) => m.here));

const markup = FbxPalette.render(FbxPalette.groups([Object.assign(entry('tire', 20), namedMaps)],
  [10]), {}, { supplied: new Set(['tire_basecolor.png']) });
check('the row says how many images and how many are waiting',
  /3 images/.test(markup) && /2 missing/.test(markup));
check('and names each file against its slot',
  /Base colour/.test(markup) && /tire_metallicRoughness\.png/.test(markup)
  && /not supplied/.test(markup));

console.log('\npalette: the shader a game material names');
/* A car states its shader and nothing else does. The row carries the family,
 * since ksPerPixelMultiMap_NMDetail is twenty-seven characters and a car has
 * thirty of them; the whole name is in the tooltip and in the opened row. */
const shaded = FbxPalette.render(FbxPalette.groups([Object.assign(
  entry('body', 20),
  { shader: 'ksPerPixelMultiMap_NMDetail', shaderFamily: 'multiMap' })],
[10]), {}, { supplied: new Set() });
check('the row names the shader itself, suffixes and all',
  /material-shader" title="ksPerPixelMultiMap_NMDetail">ksPerPixelMultiMap_NMDetail</.test(shaded));
check('and the opened row says what family that comes to',
  /<code>ksPerPixelMultiMap_NMDetail[^<]*multiMap<\/code>/.test(shaded));
check('a file that names no shader says nothing about one',
  !/material-shader/.test(FbxPalette.render(
    FbxPalette.groups([entry('plain', 20)], [10]), {}, { supplied: new Set() })));
check('and the name is escaped like everything else',
  !/<script>/.test(FbxPalette.render(FbxPalette.groups([Object.assign(
    entry('x', 1), { shader: '<script>bad<\/script>', shaderFamily: 'perPixel' })],
  [1]), {}, { supplied: new Set() })));

console.log('\npalette: leaving an image out');
const leftOut = FbxPalette.maps(
  Object.assign({ droppedMaps: ['normal'] }, namedMaps), new Set());
check('the slot left out is marked and the others are not',
  leftOut.map((m) => `${m.slot}:${m.dropped ? 1 : 0}`).join(' ')
  === 'baseColor:0 metallicRoughness:0 normal:1',
  leftOut.map((m) => `${m.slot}:${m.dropped ? 1 : 0}`).join(' '));
const droppedPalette = FbxPalette.apply(
  [Object.assign(entry('tire', 20), namedMaps)], { tire: { dropped: ['normal'] } });
check('an assignment is what marks the slot',
  droppedPalette[0].droppedMaps.join(',') === 'normal',
  JSON.stringify(droppedPalette[0].droppedMaps));
const droppedMarkup = FbxPalette.render(
  FbxPalette.groups(droppedPalette, [10]),
  { tire: { dropped: ['normal'] } }, { supplied: new Set() });
check('the row says the image was left out, and goes on naming it',
  /left out/.test(droppedMarkup) && /tire_normal\.png/.test(droppedMarkup),
  droppedMarkup);
check('and offers to take that back',
  /data-action="drop"/.test(droppedMarkup) && /data-slot="normal"/.test(droppedMarkup));
check('an assignment carries which images were left out',
  FbxPalette.parse(FbxPalette.serialise({ tire: { dropped: ['normal', 'normal'] } }))
    .materials.tire.dropped.join(',') === 'normal',
  JSON.stringify(FbxPalette.parse(
    FbxPalette.serialise({ tire: { dropped: ['normal', 'normal'] } })).materials.tire));
check('and a slot no version of this tool ever wrote is not one of them',
  !FbxPalette.parse(FbxPalette.serialise({ tire: { dropped: ['nonsense'] } }))
    .materials.tire);
check('the file name is escaped like everything else',
  !/<script>/.test(FbxPalette.render(
    FbxPalette.groups([Object.assign(entry('x', 21), {
      texture: { name: '<script>', path: '', embedded: new Uint8Array([1]) },
    })], [1]), {}, {})));

console.log('\npalette: saved assignments');
const written = FbxPalette.serialise({ paint: { colour: [0.2, 0.4, 0.6], opacity: 0.5 } });
const read = FbxPalette.parse(written).materials;
check('an assignment round-trips',
  nearAll(read.paint.colour, [0.2, 0.4, 0.6]) && read.paint.opacity === 0.5);
check('values outside the range are pulled back',
  FbxPalette.parse(FbxPalette.serialise({ a: { roughness: 5, opacity: -2 } }))
    .materials.a.roughness === 1);
check('unknown fields are dropped',
  Object.keys(FbxPalette.parse('{"fbxtoolMaterials":1,"materials":{"a":{"nonsense":1}}}')
    .materials).length === 0);

// A material the viewer invented, and the part wearing it: neither is in the
// file, so an assignment that does not carry them cannot bring them back.
const invented = FbxPalette.serialise(
  { 'New material': { added: true, name: 'Grass', colour: [0, 0.7, 0.1] } },
  { 2002: 'New material' },
);
const restored = FbxPalette.parse(invented);
check('an added material is written down as one', restored.materials['New material'].added === true,
  JSON.stringify(restored.materials['New material']));
check('with the name and colour given to it',
  restored.materials['New material'].name === 'Grass'
  && nearAll(restored.materials['New material'].colour, [0, 0.7, 0.1]));
check('and the part wearing it, by the key its model is addressed by',
  restored.parts['2002'] === 'New material', JSON.stringify(restored.parts));
check('an assignment with nobody dressed says so',
  Object.keys(FbxPalette.parse(FbxPalette.serialise({ a: { opacity: 1 } })).parts).length === 0);
check('and one written without parts does not mention them',
  !/parts/.test(FbxPalette.serialise({ a: { opacity: 1 } })));
for (const junk of ['not json at all', '{}', '{"materials":{}}', '[]', 'null']) {
  let refused = false;
  try { FbxPalette.parse(junk); } catch (error) { refused = true; }
  check(`refuses ${JSON.stringify(junk).slice(0, 24)}`, refused);
}

console.log('\ngltf: welding');
// A square as two triangles: four corners, two of them shared.
const square = {
  positions: new Float32Array([
    0, 0, 0, 1, 0, 0, 0, 1, 0,
    1, 0, 0, 1, 1, 0, 0, 1, 0,
  ]),
  normals: new Float32Array(Array.from({ length: 18 }, (_, i) => (i % 3 === 2 ? 1 : 0))),
  uvs: new Float32Array(12),
};
const welded = FbxGltf.weld([0, 1], square, false);
check('shared corners are merged', welded.positions.length / 3 === 4,
  `${welded.positions.length / 3} vertices from 6 corners`);
check('the triangles still point at the right corners', welded.index.length === 6
  && Array.from(welded.index).every((i) => i < 4), Array.from(welded.index).join(','));
check('the bounds come out of the data', nearAll(welded.min, [0, 0, 0])
  && nearAll(welded.max, [1, 1, 0]));

// Vertices that differ in any component are not the same vertex.
const split = {
  positions: square.positions,
  normals: new Float32Array(Array.from({ length: 18 }, (_, i) => (i % 3 === 0 ? 1 : 0))),
  uvs: square.uvs,
};
const bothNormals = FbxGltf.weld([0, 1], {
  positions: square.positions,
  normals: new Float32Array([...square.normals.slice(0, 9), ...split.normals.slice(9)]),
  uvs: square.uvs,
}, false);
check('a different normal makes a different vertex',
  bothNormals.positions.length / 3 === 6, `${bothNormals.positions.length / 3} vertices`);

console.log('\ngltf: the root matrix');
check('a Y-up scene only scales',
  nearAll(FbxGltf.rootMatrix('y', 0.01), [0.01, 0, 0, 0, 0, 0.01, 0, 0, 0, 0, 0.01, 0, 0, 0, 0, 1]));
// Z up: the mesh's +Z has to come out as glTF's +Y.
const zUp = FbxGltf.rootMatrix('z', 1);
const applied = (m, p) => [0, 1, 2].map((r) => m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2]);
check('a Z-up scene is turned upright', nearAll(applied(zUp, [0, 0, 1]), [0, 1, 0])
  && nearAll(applied(zUp, [0, 1, 0]), [0, 0, -1]), show(applied(zUp, [0, 0, 1])));

// A mirrored axis rides on the same matrix, so what leaves is what was shown.
const flippedX = FbxGltf.rootMatrix('y', 1, [true, false, false]);
check('a mirrored axis comes out negated, and only that axis',
  nearAll(applied(flippedX, [1, 2, 3]), [-1, 2, 3]), show(applied(flippedX, [1, 2, 3])));
check('and it mirrors after the up axis is put right, not before', (() => {
  const m = FbxGltf.rootMatrix('z', 1, [false, false, true]);
  // Mesh +Z is up and mirrored, so it comes out pointing down.
  return nearAll(applied(m, [0, 0, 1]), [0, -1, 0]) && nearAll(applied(m, [1, 0, 0]), [1, 0, 0]);
})(), show(applied(FbxGltf.rootMatrix('z', 1, [false, false, true]), [0, 0, 1])));
check('two mirrors leave the handedness alone', (() => {
  const det = (m) => m[0] * (m[5] * m[10] - m[6] * m[9])
    - m[4] * (m[1] * m[10] - m[2] * m[9]) + m[8] * (m[1] * m[6] - m[2] * m[5]);
  return det(FbxGltf.rootMatrix('y', 1, [true, false, false])) < 0
    && det(FbxGltf.rootMatrix('y', 1, [true, true, false])) > 0
    && det(FbxGltf.rootMatrix('y', 1, [true, true, true])) < 0;
})());
check('the scale still applies with a mirror on',
  nearAll(applied(FbxGltf.rootMatrix('y', 0.01, [false, true, false]), [0, 100, 0]), [0, -1, 0]));
check('and no mirror at all is the matrix it always was',
  nearAll(FbxGltf.rootMatrix('y', 0.01, [false, false, false]),
    FbxGltf.rootMatrix('y', 0.01)));

console.log('\ngltf: materials');
const asGltf = (entry) => FbxGltf.material(Object.assign({
  name: 'm', colour: [0.5, 0.25, 0.1], specular: [0.04, 0.04, 0.04], roughness: 0.4, opacity: 1,
}, entry), -1);
check('a plain material keeps its colour and roughness', (() => {
  const m = asGltf({});
  return nearAll(m.pbrMetallicRoughness.baseColorFactor, [0.5, 0.25, 0.1, 1])
    && m.pbrMetallicRoughness.roughnessFactor === 0.4
    && m.pbrMetallicRoughness.metallicFactor === 0
    && m.alphaMode === 'OPAQUE';
})());
check('a see-through material is blended', (() => {
  const m = asGltf({ opacity: 0.3 });
  return m.alphaMode === 'BLEND' && m.pbrMetallicRoughness.baseColorFactor[3] === 0.3;
})());
check('a metal carries its reflectance as its base colour', (() => {
  const m = asGltf({ colour: [0, 0, 0], specular: [0.9, 0.8, 0.5], metallic: 1 });
  return nearAll(m.pbrMetallicRoughness.baseColorFactor, [0.9, 0.8, 0.5, 1])
    && m.pbrMetallicRoughness.metallicFactor === 1;
})());
/* The extension defines F0 as 0.04 x specularColorFactor, so a factor above 1
 * raises a dielectric's reflectance above the 4% it actually has — and a body
 * panel whose F0 is raised cancels its own albedo in indirect light, so
 * repainting it does nothing at all. The factor can only ever lower it. */
check('a raised reflectance is brought back to a dielectric\'s', (() => {
  const m = asGltf({ specular: [0.16, 0.08, 0.04] });
  const factor = m.extensions && m.extensions.KHR_materials_specular.specularColorFactor;
  return factor && nearAll(factor, [1, 0.5, 0.25]);
})());
check('and the tint survives being brought back', (() => {
  const m = asGltf({ specular: [0.8, 0.4, 0.2] });
  const factor = m.extensions.KHR_materials_specular.specularColorFactor;
  return nearAll(factor, [1, 0.5, 0.25]) && Math.max(...factor) <= 1;
})());
check('a genuinely dull dielectric keeps its lower reflectance', (() => {
  const m = asGltf({ specular: [0.02, 0.02, 0.02] });
  return nearAll(m.extensions.KHR_materials_specular.specularColorFactor, [0.5, 0.5, 0.5]);
})());
check('an ordinary dielectric does not need it', asGltf({}).extensions === undefined);
check('nor does one already at the cap', asGltf({ specular: [0.16, 0.16, 0.16] })
  .extensions === undefined);
check('a metal is not touched by any of it',
  asGltf({ colour: [0, 0, 0], specular: [0.9, 0.8, 0.5], metallic: 1 }).extensions === undefined);

console.log('\ngltf: how a material is blended');
check('an opacity factor still asks for blending',
  asGltf({ opacity: 0.3 }).alphaMode === 'BLEND');
// The AMG GT's badges: BLEND declared, no baseColorFactor at all, so the
// transparency is in the texture's own alpha channel.
check('a material that declared blending keeps it at full opacity',
  asGltf({ alphaMode: 'BLEND' }).alphaMode === 'BLEND');
check('a cutout keeps its threshold', (() => {
  const m = asGltf({ alphaMode: 'MASK', alphaCutoff: 0.2 });
  return m.alphaMode === 'MASK' && m.alphaCutoff === 0.2;
})());
check('an image with an alpha channel is reason enough on its own',
  FbxGltf.material({ name: 'badge', colour: [1, 1, 1], specular: [0.04, 0.04, 0.04],
    roughness: 0.5, opacity: 1 }, { baseColor: 0, baseColorHasAlpha: true })
    .alphaMode === 'BLEND');
check('and a plain opaque material is left opaque',
  FbxGltf.material({ name: 'panel', colour: [1, 1, 1], specular: [0.04, 0.04, 0.04],
    roughness: 0.5, opacity: 1 }, { baseColor: 0 }).alphaMode === 'OPAQUE');
check('a file that says opaque is taken at its word all the same',
  FbxGltf.material({ name: 'panel', colour: [1, 1, 1], specular: [0.04, 0.04, 0.04],
    roughness: 0.5, opacity: 1, alphaMode: 'OPAQUE' },
  { baseColor: 0, baseColorHasAlpha: true }).alphaMode === 'OPAQUE');
check('and transparency the factor states is never lost to it',
  FbxGltf.material({ name: 'glass', colour: [1, 1, 1], specular: [0.04, 0.04, 0.04],
    roughness: 0.5, opacity: 0.3, alphaMode: 'OPAQUE' }, {}).alphaMode === 'BLEND');

console.log('\ngltf: the maps a material wears');
const mapped = FbxGltf.material({
  name: 'body', colour: [0.5, 0.5, 0.5], specular: [0.04, 0.04, 0.04],
  roughness: 0.4, opacity: 1, emissive: [1, 0.5, 0],
}, { baseColor: 0, normal: 1, metallicRoughness: 2, occlusion: 3, emissive: 4 });
check('every slot is written where glTF keeps it',
  mapped.pbrMetallicRoughness.baseColorTexture.index === 0
  && mapped.normalTexture.index === 1
  && mapped.pbrMetallicRoughness.metallicRoughnessTexture.index === 2
  && mapped.occlusionTexture.index === 3
  && mapped.emissiveTexture.index === 4,
  JSON.stringify(mapped.normalTexture));
check('an emissive map travels with the colour that lets it show',
  nearAll(mapped.emissiveFactor, [1, 0.5, 0]));
check('an emissive map with no colour beside it is still lit',
  nearAll(FbxGltf.material({ name: 'lamp', colour: [1, 1, 1], specular: [0.04, 0.04, 0.04],
    roughness: 0.5, opacity: 1 }, { emissive: 0 }).emissiveFactor, [1, 1, 1]));
check('a material that gives off nothing says nothing about it',
  asGltf({}).emissiveFactor === undefined);

console.log('\ngltf: the container');
const built = FbxGltf.build({
  name: 'square',
  meshes: [{
    name: 'square',
    mesh: {
      triangleCount: 2,
      hasUv: false,
      positions: square.positions,
      normals: square.normals,
      uvs: square.uvs,
      materials: new Float32Array([0, 0, 0, 1, 1, 1]),
    },
    palette: [
      { name: 'a', group: 0, colour: [1, 0, 0], specular: [0.04, 0.04, 0.04], roughness: 0.5, opacity: 1 },
      { name: 'b', group: 1, colour: [0, 0, 1], specular: [0.04, 0.04, 0.04], roughness: 0.5, opacity: 1 },
    ],
  }],
  // The same mesh under two nodes: written once, drawn twice.
  nodes: [
    { name: 'left', matrix: null, mesh: 0, children: [] },
    {
      name: 'right',
      matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 3, 0, 0, 1],
      mesh: 0,
      children: [],
    },
  ],
});
const glb = new Uint8Array(built.glb);
const dv = new DataView(built.glb);
check('it starts with the glTF magic', dv.getUint32(0, true) === 0x46546c67);
check('the header length matches the file', dv.getUint32(8, true) === glb.length,
  `${dv.getUint32(8, true)} against ${glb.length}`);
const jsonLength = dv.getUint32(12, true);
check('the JSON chunk is aligned and tagged',
  jsonLength % 4 === 0 && dv.getUint32(16, true) === 0x4e4f534a);
check('the binary chunk is aligned and tagged',
  dv.getUint32(20 + jsonLength + 4, true) === 0x004e4942
  && dv.getUint32(20 + jsonLength, true) % 4 === 0);
const gltf = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLength)));
check('one primitive per material', gltf.meshes[0].primitives.length === 2
  && gltf.materials.length === 2, `${gltf.meshes[0].primitives.length} primitives`);
check('a mesh used twice is written once', gltf.meshes.length === 1
  && gltf.nodes.filter((n) => n.mesh !== undefined).length === 2,
  `${gltf.meshes.length} mesh(es), ${gltf.nodes.length} nodes`);
check('the tree hangs off a root that carries the axis',
  Array.isArray(gltf.nodes[0].matrix) && (gltf.nodes[0].children || []).length === 2);
check('a node keeps its own place', (() => {
  const right = gltf.nodes.find((n) => n.name === 'right');
  return right && right.matrix && right.matrix[12] === 3;
})());
check('and its name', gltf.nodes.some((n) => n.name === 'left'));
check('both placements are counted, one is stored',
  built.stats.triangles === 4 && built.stats.stored === 2,
  `${built.stats.triangles} drawn, ${built.stats.stored} stored`);
check('the buffer is as long as the chunk says',
  gltf.buffers[0].byteLength === dv.getUint32(20 + jsonLength, true));
check('every accessor sits inside its bufferView', gltf.accessors.every((a) => {
  const view = gltf.bufferViews[a.bufferView];
  const size = { SCALAR: 1, VEC2: 2, VEC3: 3 }[a.type] * (a.componentType === 5125 ? 4 : 4);
  return a.count * size <= view.byteLength && ((view.byteOffset || 0) % 4) === 0;
}));
check('it says what it wrote, by name',
  built.stats.materialNames.join(',') === 'a,b'
  && built.stats.nodeNames.join(',') === 'left,right',
  `${built.stats.materialNames.join(',')} · ${built.stats.nodeNames.join(',')}`);

console.log('\ngltf: textures and samplers');
/* A square wearing one material, with a base colour and a normal map. The
 * normal map is the same image two materials share, which has to be stored
 * once however many point at it. */
const png = (tag) => Uint8Array.from([0x89, 0x50, 0x4e, 0x47, tag]);
const baseImage = png(1);
const sharedNormal = png(2);
const textured = FbxGltf.build({
  name: 'square',
  meshes: [{
    name: 'square',
    mesh: {
      triangleCount: 2,
      hasUv: true,
      positions: square.positions,
      normals: square.normals,
      uvs: square.uvs,
      materials: new Float32Array([0, 0, 0, 1, 1, 1]),
    },
    palette: [
      { name: 'a', group: 0, colour: [1, 0, 0], specular: [0.04, 0.04, 0.04], roughness: 0.5, opacity: 1 },
      { name: 'b', group: 1, colour: [0, 0, 1], specular: [0.04, 0.04, 0.04], roughness: 0.5, opacity: 1 },
    ],
  }],
  nodes: [{ name: 'only', matrix: null, mesh: 0, children: [] }],
  images: new Map([
    ['a', { bytes: baseImage, mimeType: 'image/png', wrapS: 33071, wrapT: 33071, hasAlpha: true }],
  ]),
  textures: new Map([
    ['a', [{ slot: 'normal', bytes: sharedNormal, mimeType: 'image/png' }]],
    ['b', [{ slot: 'normal', bytes: sharedNormal, mimeType: 'image/png' }]],
  ]),
});
const withMaps = JSON.parse(new TextDecoder().decode(
  new Uint8Array(textured.glb).subarray(20, 20 + new DataView(textured.glb).getUint32(12, true))));
check('an image two materials share is stored once', withMaps.images.length === 2,
  `${withMaps.images.length} image(s)`);
check('a clamped sampler is not the repeating one',
  withMaps.samplers.length === 2
  && withMaps.samplers.some((s) => s.wrapS === 33071 && s.wrapT === 33071)
  && withMaps.samplers.some((s) => s.wrapS === 10497 && s.wrapT === 10497),
  JSON.stringify(withMaps.samplers));
check('the maps land on the materials that wear them', (() => {
  const a = withMaps.materials.find((m) => m.name === 'a');
  const b = withMaps.materials.find((m) => m.name === 'b');
  return a.pbrMetallicRoughness.baseColorTexture && a.normalTexture
    && b.normalTexture && !b.pbrMetallicRoughness.baseColorTexture;
})());
check('a material with only a normal map is still blended by its image',
  withMaps.materials.find((m) => m.name === 'a').alphaMode === 'BLEND');
check('and a material with a map is written as textured',
  textured.stats.images === 2 && textured.stats.textures >= 2,
  `${textured.stats.images} image(s), ${textured.stats.textures} texture(s)`);
console.log('\nedits: taking a part apart');
/* Six triangles making three loose pieces, laid out so that the two ways of
 * splitting disagree — the shells cut it 3/2/1, the materials 3/3:
 *
 *   A: t0 t1 t2   at the origin      materials 0 0 1
 *   B: t3 t4      ten units along    materials 1 1
 *   C: t5         twenty along       material  0
 */
const piecePart = (() => {
  const triangles = [
    { corners: [[0, 0, 0], [1, 0, 0], [1, 1, 0]], material: 0 },
    { corners: [[0, 0, 0], [1, 1, 0], [0, 1, 0]], material: 0 },
    { corners: [[1, 0, 0], [2, 0, 0], [1, 1, 0]], material: 1 },
    { corners: [[10, 0, 0], [11, 0, 0], [11, 1, 0]], material: 1 },
    { corners: [[10, 0, 0], [11, 1, 0], [10, 1, 0]], material: 1 },
    { corners: [[20, 0, 0], [21, 0, 0], [21, 1, 0]], material: 0 },
  ];
  const positions = new Float32Array(triangles.length * 9);
  const normals = new Float32Array(triangles.length * 9);
  const uvs = new Float32Array(triangles.length * 6);
  const materials = new Float32Array(triangles.length * 3);
  triangles.forEach((triangle, t) => {
    triangle.corners.forEach((corner, c) => {
      corner.forEach((value, k) => { positions[t * 9 + c * 3 + k] = value; });
      normals[t * 9 + c * 3 + 2] = 1;
      uvs[t * 6 + c * 2] = t;              // u names the triangle,
      uvs[t * 6 + c * 2 + 1] = c;          // v the corner
      materials[t * 3 + c] = triangle.material;
    });
  });
  return {
    positions, normals, uvs, materials, hasUv: true, name: 'test',
    triangleCount: triangles.length, polygonCount: triangles.length,
    min: [0, 0, 0], max: [21, 1, 0],
  };
})();

const shells = FbxEdits.shells(piecePart);
check('the loose pieces come back biggest first',
  shells.length === 3 && shells.map((s) => s.length).join(',') === '3,2,1',
  shells.map((s) => `[${s.join(' ')}]`).join(' '));
check('and each holds the triangles that touch',
  shells[0].join(' ') === '0 1 2' && shells[1].join(' ') === '3 4'
  && shells[2].join(' ') === '5');
check('triangles are welded by where their corners are, not by being one vertex',
  // t0 and t1 share two corners, written out twice each in the soup.
  shells[0].length === 3);

const materialGroups = FbxEdits.byMaterial(piecePart);
check('by material cuts it a different way, in slot order',
  materialGroups.length === 2 && materialGroups[0].slot === 0 && materialGroups[1].slot === 1,
  materialGroups.map((g) => `${g.slot}:[${[...g.faces].join(' ')}]`).join(' '));
check('with every triangle in exactly one group',
  materialGroups[0].faces.join(' ') === '0 1 5'
  && materialGroups[1].faces.join(' ') === '2 3 4');

const middle = FbxEdits.slice(piecePart, shells[1]);
check('a slice holds only the triangles named', middle.triangleCount === 2);
check('and is measured where it actually stands',
  middle.min.join(',') === '10,0,0' && middle.max.join(',') === '11,1,0',
  `${middle.min.join(',')} .. ${middle.max.join(',')}`);
check('carrying its materials, normals and UVs across',
  [...middle.materials].every((m) => m === 1)
  && middle.uvs[0] === 3 && middle.uvs[6] === 4
  && [...middle.normals].filter((n) => n === 1).length === 6,
  `uvs start ${middle.uvs[0]}, ${middle.uvs[6]}`);
check('slicing nothing keeps the part it was given',
  FbxEdits.slice(piecePart, null) === piecePart);

const oneMaterial = FbxEdits.paint(piecePart, 7);
check('a part can be given one material throughout',
  [...oneMaterial.materials].every((slot) => slot === 7)
  && oneMaterial.triangleCount === piecePart.triangleCount);
check('and the part it was painted from is left as it was',
  [...piecePart.materials].join('') === '000000111111111000',
  [...piecePart.materials].join(''));
check('painting keeps the geometry itself untouched',
  oneMaterial.positions === piecePart.positions
  && oneMaterial.normals === piecePart.normals);
check('a split of a split still points at the original triangles',
  // The second shell is triangles 3 and 4; its own first triangle is 3.
  [...FbxEdits.through(shells[1], Int32Array.from([0]))].join(',') === '3');
check('and every() names them all in order',
  [...FbxEdits.every(3)].join(',') === '0,1,2');

check('an empty scene is refused', (() => {
  try {
    FbxGltf.build({ meshes: [{ mesh: { triangleCount: 0 } }], nodes: [] });
    return false;
  } catch (error) {
    return /no geometry/.test(error.message);
  }
})());

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
