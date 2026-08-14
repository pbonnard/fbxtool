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
// roughness = sqrt(2 / (25 + 2)) = 0.2722
check('shininess becomes roughness', near(paint.roughness, Math.sqrt(2 / 27), 1e-9),
  paint.roughness.toFixed(4));
check('an opaque material has full opacity', paint.opacity === 1);

// The Shelby's materials are empty, so this is what its template supplies.
// Its specular of 0.2 lands just above the dielectric cap.
const template = FbxAnalyze.materialAppearance({
  DiffuseColor: [0.8, 0.8, 0.8], DiffuseFactor: 1,
  SpecularColor: [0.2, 0.2, 0.2], SpecularFactor: 1, ShininessExponent: 20,
});
check('template values give a plausible finish',
  nearAll(template.colour, [0.8, 0.8, 0.8]) && nearAll(template.specular, [0.16, 0.16, 0.16])
  && near(template.roughness, Math.sqrt(2 / 22), 1e-9), template.roughness.toFixed(4));

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

const glassPreset = FbxPalette.preset('glass');
check('presets carry an opacity', glassPreset && glassPreset.opacity < 1,
  glassPreset ? String(glassPreset.opacity) : 'missing');
check('every preset is complete', FbxPalette.PRESETS.every((p) => p.id && p.label
  && Array.isArray(p.colour) && typeof p.roughness === 'number'));

console.log('\npalette: saved assignments');
const written = FbxPalette.serialise({ paint: { colour: [0.2, 0.4, 0.6], opacity: 0.5 } });
const read = FbxPalette.parse(written);
check('an assignment round-trips',
  nearAll(read.paint.colour, [0.2, 0.4, 0.6]) && read.paint.opacity === 0.5);
check('values outside the range are pulled back',
  FbxPalette.parse(FbxPalette.serialise({ a: { roughness: 5, opacity: -2 } })).a.roughness === 1);
check('unknown fields are dropped',
  Object.keys(FbxPalette.parse('{"fbxtoolMaterials":1,"materials":{"a":{"nonsense":1}}}'))
    .length === 0);
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
check('an unusual reflectance uses the specular extension', (() => {
  // The extension defines F0 as 0.04 x specularColorFactor, so 16% is a
  // factor of 4 — and a tint survives, which a single strength could not.
  const m = asGltf({ specular: [0.16, 0.08, 0.04] });
  const factor = m.extensions && m.extensions.KHR_materials_specular.specularColorFactor;
  return factor && nearAll(factor, [4, 2, 1]);
})());
check('an ordinary dielectric does not need it', asGltf({}).extensions === undefined);

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
