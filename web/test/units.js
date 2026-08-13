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

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
