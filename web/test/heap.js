/* Checks on the WebAssembly bump allocator, run under Node.
 *
 *   node web/test/heap.js <file.fbx>
 *
 * Assembling a scene builds one mesh per part and copies each result out, so
 * the core lets a caller mark the allocator and rewind to it. Getting that
 * wrong is quiet — memory grows without bound, or a rewound buffer is read
 * back as if it were still live — so it is checked here directly.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const FbxWasm = require(path.join(__dirname, '..', 'app', 'wasm.js'));
const FbxAnalyze = require(path.join(__dirname, '..', 'app', 'analyze.js'));

const WASM = path.join(__dirname, '..', 'build', 'fbx.wasm');

let failures = 0;

function check(label, condition, detail = '') {
  if (!condition) failures++;
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? `  — ${detail}` : ''}`);
}

/** The cube from tests/fbxbuild.py, as a mesh the core can triangulate. */
const CUBE_VERTICES = [
  -1, -1, 1, 1, -1, 1, -1, 1, 1, 1, 1, 1,
  -1, 1, -1, 1, 1, -1, -1, -1, -1, 1, -1, -1,
];
const CUBE_POLYGONS = [0, 1, 3, -3, 2, 3, 5, -5, 4, 5, 7, -7, 6, 7, 1, -1,
  1, 7, 5, -4, 6, 0, 2, -5];

function buildCube() {
  return FbxWasm.buildMesh({
    positions: FbxWasm.uploadFloat64(CUBE_VERTICES),
    indices: FbxWasm.uploadInt32(CUBE_POLYGONS),
  });
}

/** The values of the first deflated array in the file, as a plain array. */
function firstDeflatedArray(doc) {
  for (const [, node] of walk(doc.root)) {
    for (const prop of node.props) {
      if (prop.array && prop.array.encoding === 1 && prop.code === 'd') {
        // Inflating hands back an {offset, count} pair in linear memory.
        const at = FbxWasm.asFloat64(prop);
        return Array.from(
          new Float64Array(FbxWasm.exports.memory.buffer, at.offset, at.count));
      }
    }
  }
  return null;
}

function* walk(node, depth = 0) {
  for (const child of node.children) {
    yield [depth, child];
    yield* walk(child, depth + 1);
  }
}

async function main() {
  const target = process.argv[2];
  if (!target) {
    console.error('usage: node web/test/heap.js <file.fbx>');
    process.exit(2);
  }
  await FbxWasm.init(fs.readFileSync(WASM));
  const wasm = FbxWasm.exports;

  console.log('allocator');
  wasm.fbx_reset();
  const base = FbxWasm.mark();
  const first = wasm.fbx_alloc(4096);
  check('an allocation sits at the mark', first >= base, `${base} -> ${first}`);
  FbxWasm.release(base);
  check('the mark is restored after a release', FbxWasm.mark() === base);
  const again = wasm.fbx_alloc(4096);
  check('released memory is handed out again', again === first, `${first} vs ${again}`);

  FbxWasm.release(base);
  const top = FbxWasm.mark();
  FbxWasm.release(top + 1024);
  check('a mark above the heap is refused', FbxWasm.mark() === top);
  FbxWasm.release(0);
  check('a mark below the heap is refused', FbxWasm.mark() === top);

  console.log('\nreleasing between meshes');
  const before = wasm.memory.buffer.byteLength;
  const mark = FbxWasm.mark();
  let triangles = 0;
  for (let i = 0; i < 500; i++) {
    const mesh = buildCube();
    triangles = mesh.triangleCount;
    FbxWasm.release(mark);
  }
  check('each build produced a cube', triangles === 12, `${triangles} triangles`);
  check('500 builds did not grow linear memory',
    wasm.memory.buffer.byteLength === before,
    `${(before / 1048576).toFixed(1)} MiB -> `
    + `${(wasm.memory.buffer.byteLength / 1048576).toFixed(1)} MiB`);

  // Without the release, the same work keeps growing the heap — which is what
  // made assembling a large scene slow before the mark existed.
  const grew = FbxWasm.mark();
  for (let i = 0; i < 500; i++) buildCube();
  check('without a release the heap does grow', FbxWasm.mark() > grew,
    `${grew} -> ${FbxWasm.mark()}`);

  console.log('\ninflating after a release');
  const doc = FbxWasm.parseBinary(new Uint8Array(fs.readFileSync(target)));
  check('the file parsed', !!doc && doc.warnings.length === 0);
  const analysis = FbxAnalyze.analyze(doc);
  check('it holds objects', analysis.objects.length > 0, `${analysis.objects.length} objects`);

  // The mark is taken before anything has been inflated, which is how a scene
  // build starts. The inflate scratch tables are claimed at reset so they sit
  // below the mark; were they claimed lazily they would land above it, and the
  // release would hand their memory back while the core still pointed at them.
  const afterParse = FbxWasm.mark();
  const values = firstDeflatedArray(doc);
  check('a deflated array was found and read', values !== null && values.length > 0,
    values ? `${values.length} values` : 'none');

  FbxWasm.release(afterParse);

  // Now do what the next part of a scene does: upload its own arrays into the
  // memory the release handed back, then inflate. Anything the core still
  // holds a pointer to up there writes straight through this upload.
  const pattern = Array.from({ length: 40_000 }, (_, i) => i * 0.5);
  const upload = FbxWasm.uploadFloat64(pattern);

  let second = null;
  let failed = '';
  try {
    second = firstDeflatedArray(doc);
  } catch (error) {
    failed = error.message;
  }
  check('the same array reads back identically after a release',
    !failed && JSON.stringify(second) === JSON.stringify(values), failed);

  const readBack = new Float64Array(wasm.memory.buffer, upload.offset, upload.count);
  check('an upload made after a release is not written through',
    pattern.every((v, i) => readBack[i] === v),
    `${pattern.length} values`);

  console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
