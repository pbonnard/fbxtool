/* Subdivision through the compiled module, under Node.
 *
 *   node web/test/subdivide.js [model.fbx]
 *
 * The maths is checked natively by tests/test_subdivide.py; this checks the
 * WebAssembly binary and the JavaScript that drives it — that a cage really
 * does come back with four times the polygons, its attributes intact, and
 * that a whole file of them survives the round trip.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..', 'app');
const FbxWasm = require(path.join(APP, 'wasm.js'));
const FbxAnalyze = require(path.join(APP, 'analyze.js'));

const WASM = path.join(__dirname, '..', 'build', 'fbx.wasm');

let failures = 0;

function check(label, condition, detail = '') {
  if (!condition) failures++;
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? `  — ${detail}` : ''}`);
}

/** The cube from tests/fbxbuild.py, as quads. */
const CUBE_VERTICES = [
  -1, -1, 1, 1, -1, 1, -1, 1, 1, 1, 1, 1,
  -1, 1, -1, 1, 1, -1, -1, -1, -1, 1, -1, -1,
];
const CUBE_QUADS = [0, 1, 3, ~2, 2, 3, 5, ~4, 4, 5, 7, ~6,
  6, 7, 1, ~0, 1, 7, 5, ~3, 6, 0, 2, ~4];

/** Read a record's numbers however the file stored them, as main.js does. */
function upload(node, asFloat) {
  if (!node) return null;
  const direct = node.props.find((p) => p.array);
  const inner = direct || (node.children.find((c) => c.name === 'a') || { props: [] })
    .props.find((p) => p.array);
  if (inner) {
    if (inner.values) {
      return asFloat ? FbxWasm.uploadFloat64(inner.values) : FbxWasm.uploadInt32(inner.values);
    }
    return asFloat ? FbxWasm.asFloat64(inner) : FbxWasm.asInt32(inner);
  }
  const scalars = FbxAnalyze.scalarValues(node);
  if (!scalars) return null;
  return asFloat ? FbxWasm.uploadFloat64(scalars) : FbxWasm.uploadInt32(scalars);
}

/** The layers a geometry record carries, in the shape the core wants. */
function specOf(entry) {
  const child = (name) => entry.children.find((c) => c.name === name);
  const positions = upload(child('Vertices'), true);
  const indices = upload(child('PolygonVertexIndex'), false);
  if (!positions || !indices) return null;

  const spec = {
    positions,
    indices,
    normals: null,
    normalMapping: 'none',
    normalReference: 'direct',
    uvs: null,
    uvMapping: 'none',
    uvReference: 'direct',
    materials: null,
  };
  const normalLayer = child('LayerElementNormal');
  if (normalLayer) {
    const map = FbxAnalyze.pathValue(normalLayer, ['MappingInformationType']);
    if (map === 'ByPolygonVertex') spec.normalMapping = 'byPolygonVertex';
    else if (map === 'ByVertice' || map === 'ByVertex') spec.normalMapping = 'byVertex';
    if (spec.normalMapping !== 'none') {
      spec.normals = upload(normalLayer.children.find((c) => c.name === 'Normals'), true);
    }
  }
  const materialLayer = child('LayerElementMaterial');
  if (materialLayer) {
    spec.materials = upload(materialLayer.children.find((c) => c.name === 'Materials'), false);
  }
  return spec;
}

async function main() {
  await FbxWasm.init(fs.readFileSync(WASM));

  console.log('a cube through the module');
  FbxWasm.exports.fbx_reset();
  const cage = {
    positions: FbxWasm.uploadFloat64(CUBE_VERTICES),
    indices: FbxWasm.uploadInt32(CUBE_QUADS),
    materials: FbxWasm.uploadInt32([0, 1, 2, 3, 4, 5]),
    normalMapping: 'none',
    uvMapping: 'none',
  };
  const flat = FbxWasm.buildMesh(cage);
  check('the cage is six quads', flat.polygonCount === 6 && flat.triangleCount === 12,
    `${flat.polygonCount} polygons, ${flat.triangleCount} triangles`);

  const once = FbxWasm.subdivide(cage, 1);
  check('one round gives a quad per corner', once.polygonCount === 24, `${once.polygonCount}`);
  check('and 8 + 12 + 6 points', once.positions.count / 3 === 26,
    `${once.positions.count / 3} vertices`);
  check('materials came with it', once.materials.count === 24);
  const smooth = FbxWasm.buildMesh({ ...once });
  check('which the mesh builder triangulates', smooth.triangleCount === 48,
    `${smooth.triangleCount} triangles`);
  // Catmull-Clark keeps a cube's face centres, so the box is unchanged, but
  // every corner is drawn in to five ninths.
  check('the box is the same size', Math.abs(smooth.max[0] - 1) < 1e-6,
    `max x ${smooth.max[0].toFixed(4)}`);

  const twice = FbxWasm.subdivide(cage, 2);
  check('two rounds multiply again', twice.polygonCount === 96
    && twice.positions.count / 3 === 98, `${twice.polygonCount} polygons`);

  const none = FbxWasm.subdivide(cage, 0);
  check('no rounds changes nothing', none.polygonCount === 6 && none.levels === 0);

  const target = process.argv[2];
  if (!target) {
    console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
    process.exit(failures ? 1 : 0);
  }

  console.log(`\n${path.basename(target)}`);
  const started = Date.now();
  const doc = FbxWasm.parseBinary(new Uint8Array(fs.readFileSync(target)));
  check('the file parsed', !!doc && doc.warnings.length === 0,
    `${Date.now() - started} ms`);

  const geometries = FbxAnalyze.findAllGeometry(doc);
  check('it holds meshes', geometries.length > 0, `${geometries.length} of them`);

  let cageTriangles = 0;
  let cageCorners = 0;
  let smoothTriangles = 0;
  let built = 0;
  const mark = FbxWasm.mark();
  const clock = Date.now();
  for (const entry of geometries) {
    const spec = specOf(entry);
    if (!spec) continue;
    cageCorners += spec.indices.count;
    const plain = FbxWasm.buildMesh(spec);
    cageTriangles += plain.triangleCount;
    const divided = FbxWasm.subdivide(spec, 1);
    if (divided) {
      const mesh = FbxWasm.buildMesh(divided);
      smoothTriangles += mesh.triangleCount;
      built++;
    }
    FbxWasm.release(mark);
  }
  const elapsed = Date.now() - clock;

  check('every mesh subdivided', built === geometries.length,
    `${built} of ${geometries.length}`);
  // Each polygon becomes one quad per corner, and each quad two triangles —
  // so a quad cage quadruples and a triangle cage sextuples, and both come to
  // exactly twice the corners that went in.
  check('every corner became a quad', smoothTriangles === cageCorners * 2,
    `${cageCorners.toLocaleString()} corners -> ${smoothTriangles.toLocaleString()} triangles`);
  console.log(`       ${cageTriangles.toLocaleString()} triangles in the cage, `
    + `${(smoothTriangles / cageTriangles).toFixed(1)}x after one round`);
  console.log(`       ${elapsed} ms for the whole file, `
    + `${(FbxWasm.exports.memory.buffer.byteLength / 1048576).toFixed(0)} MiB of memory`);

  console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
