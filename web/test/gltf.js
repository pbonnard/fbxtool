/* The glTF export: written by the page, checked here.
 *
 *   node web/test/gltf.js <model.fbx> [more...]
 *
 * Each file is loaded in the browser and exported through the real button,
 * then the GLB that comes back is taken apart: the container, the accessors
 * and the buffer arithmetic, and whether what came out describes the same
 * model that went in. When the Khronos glTF-Validator is installed it is run
 * as well, which is the only check here that speaks for the specification
 * rather than for this test.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { launch } = require('./chromium');

const ROOT = path.resolve(__dirname, '..', '..');
const PAGE = path.join(ROOT, 'web', 'dist', 'fbxview.html');

let validator = null;
try {
  validator = require('gltf-validator');
} catch (error) {
  validator = null;
}

let failures = 0;

function check(label, condition, detail = '') {
  if (!condition) failures++;
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? `  — ${detail}` : ''}`);
}

const COMPONENT_SIZE = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const COMPONENT_COUNT = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

/** Split a GLB into its JSON and its binary chunk, checking the container. */
function readGlb(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const problems = [];
  if (view.getUint32(0, true) !== 0x46546c67) problems.push('bad magic');
  if (view.getUint32(4, true) !== 2) problems.push('not glTF 2');
  if (view.getUint32(8, true) !== bytes.length) problems.push('length disagrees with the file');

  const jsonLength = view.getUint32(12, true);
  if (view.getUint32(16, true) !== 0x4e4f534a) problems.push('first chunk is not JSON');
  if (jsonLength % 4) problems.push('JSON chunk is not 4-byte aligned');
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength)));

  const binAt = 20 + jsonLength;
  const binLength = view.getUint32(binAt, true);
  if (view.getUint32(binAt + 4, true) !== 0x004e4942) problems.push('second chunk is not BIN');
  if (binLength % 4) problems.push('BIN chunk is not 4-byte aligned');
  const bin = bytes.subarray(binAt + 8, binAt + 8 + binLength);
  return { json, bin, problems };
}

/** Everything the file says about itself has to add up. */
function inspect(json, bin) {
  const problems = [];
  const buffer = json.buffers[0];
  if (buffer.byteLength !== bin.length) problems.push('buffer length disagrees with the chunk');

  json.bufferViews.forEach((bufferView, index) => {
    const end = (bufferView.byteOffset || 0) + bufferView.byteLength;
    if (end > bin.length) problems.push(`bufferView ${index} runs past the buffer`);
  });

  json.accessors.forEach((accessor, index) => {
    const size = COMPONENT_SIZE[accessor.componentType] * COMPONENT_COUNT[accessor.type];
    const bufferView = json.bufferViews[accessor.bufferView];
    const at = (bufferView.byteOffset || 0) + (accessor.byteOffset || 0);
    if (at % 4) problems.push(`accessor ${index} is not 4-byte aligned`);
    if (accessor.count * size > bufferView.byteLength) {
      problems.push(`accessor ${index} claims more than its bufferView holds`);
    }
  });

  let triangles = 0;
  for (const primitive of json.meshes[0].primitives) {
    const positions = json.accessors[primitive.attributes.POSITION];
    const indices = json.accessors[primitive.indices];
    triangles += indices.count / 3;
    if (indices.count % 3) problems.push('an index count is not a whole number of triangles');
    if (!positions.min || !positions.max) problems.push('POSITION has no min/max');
    for (const name of Object.keys(primitive.attributes)) {
      if (json.accessors[primitive.attributes[name]].count !== positions.count) {
        problems.push(`${name} has a different count from POSITION`);
      }
    }
    if (primitive.material !== undefined && !json.materials[primitive.material]) {
      problems.push('a primitive names a material that is not there');
    }
    // Every index must point at a vertex this primitive actually has.
    const view = json.bufferViews[indices.bufferView];
    const at = (view.byteOffset || 0) + (indices.byteOffset || 0);
    const read = new Uint32Array(bin.buffer, bin.byteOffset + at, indices.count);
    let highest = 0;
    for (const value of read) if (value > highest) highest = value;
    if (highest >= positions.count) problems.push('an index points past the vertices');
  }
  return { problems, triangles };
}

async function main() {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.error('usage: node web/test/gltf.js <model.fbx> [...]');
    process.exit(2);
  }
  if (!fs.existsSync(PAGE)) {
    console.error(`${PAGE} is missing — run: python3 web/build.py`);
    process.exit(2);
  }
  console.log(validator
    ? 'Khronos glTF-Validator found\n'
    : 'Khronos glTF-Validator not installed — structural checks only\n');

  const browser = await launch(chromium);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto(`file://${PAGE}`);
  await page.waitForFunction(() => document.body.dataset.ready === 'true', { timeout: 20000 });

  for (const entry of files) {
    const group = entry.split('+').every((f) => fs.existsSync(f)) ? entry.split('+') : [entry];
    console.log(group.map((f) => path.basename(f)).join(' + '));

    const before = await page.evaluate(() => window.fbxtool.loadCount);
    await page.setInputFiles('#file-input', group);
    await page.waitForFunction((seen) => window.fbxtool.loadCount > seen, before,
      { timeout: 180000 });

    const source = await page.evaluate(() => ({
      triangles: window.fbxtool.viewer.triangleCount,
      materials: window.fbxtool.materials.length,
      hasUv: window.fbxtool.viewer.hasUv,
      bounds: window.fbxtool.materials.length
        ? { min: window.fbxtool.viewer.meshMin, max: window.fbxtool.viewer.meshMax } : null,
      palette: window.fbxtool.palette.map((entry) => ({
        name: entry.name,
        colour: entry.colour,
        opacity: entry.opacity,
        metallic: entry.metallic,
      })),
    }));

    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 180000 }),
      page.click('#export-gltf'),
    ]);
    const saved = path.join(path.dirname(await download.path()), 'export.glb');
    await download.saveAs(saved);
    const bytes = new Uint8Array(fs.readFileSync(saved));
    const stats = await page.evaluate(() => window.fbxtool.lastExport);

    const { json, bin, problems } = readGlb(bytes);
    check('the container is a glTF 2 binary', problems.length === 0, problems.join('; '));

    const inspected = inspect(json, bin);
    check('the file describes itself consistently', inspected.problems.length === 0,
      inspected.problems.slice(0, 3).join('; '));
    check('every triangle came across', inspected.triangles === source.triangles,
      `${inspected.triangles.toLocaleString()} of ${source.triangles.toLocaleString()}`);
    // A material that covers no triangles — the Mercedes has six leftover
    // wireframe colours — writes no primitive, so the counts need not match.
    const used = json.meshes[0].primitives.map((p) => p.material);
    check('one primitive per material, and no more materials than the file has',
      used.length <= Math.max(source.materials, 1)
      && new Set(used).size === used.length
      && (json.materials || []).length === used.length,
      `${used.length} primitives, ${source.materials} materials in the scene`);
    check('welding dropped the repeated vertices', stats.vertices < source.triangles * 3,
      `${stats.vertices.toLocaleString()} vertices for `
      + `${(source.triangles * 3).toLocaleString()} corners`);
    check('the scene has a root node with a matrix',
      json.nodes.length === 1 && Array.isArray(json.nodes[0].matrix)
      && json.nodes[0].matrix.length === 16);

    // The vertex data is written as the mesh holds it — the up axis and the
    // units ride on the root matrix — so the extremes have to survive exactly.
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (const primitive of json.meshes[0].primitives) {
      const positions = json.accessors[primitive.attributes.POSITION];
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], positions.min[k]);
        max[k] = Math.max(max[k], positions.max[k]);
      }
    }
    const near = (a, b) => Math.abs(a - b) <= Math.max(1e-4, Math.abs(b) * 1e-5);
    check('the model came out the same size as it went in',
      source.bounds && [0, 1, 2].every((k) => near(min[k], source.bounds.min[k])
        && near(max[k], source.bounds.max[k])),
      `${min.map((v) => v.toFixed(2))} .. ${max.map((v) => v.toFixed(2))}`);

    // On a small mesh, compare the triangles themselves rather than their
    // extremes: every corner of every triangle, back from the indices.
    if (source.triangles <= 5000) {
      const original = await page.evaluate(() => {
        const mesh = window.fbxtool.viewer;
        return Array.from(window.fbxtool.exportMesh().positions);
      });
      const key = (a, b, c) => [a, b, c].map((v) => v.toFixed(4)).join(',');
      const wantedTriangles = new Set();
      for (let t = 0; t < source.triangles; t++) {
        const corners = [];
        for (let c = 0; c < 3; c++) {
          const at = (t * 3 + c) * 3;
          corners.push(key(original[at], original[at + 1], original[at + 2]));
        }
        wantedTriangles.add(corners.sort().join(' | '));
      }
      const found = new Set();
      for (const primitive of json.meshes[0].primitives) {
        const positions = json.accessors[primitive.attributes.POSITION];
        const indices = json.accessors[primitive.indices];
        const positionView = json.bufferViews[positions.bufferView];
        const indexView = json.bufferViews[indices.bufferView];
        const p = new Float32Array(bin.buffer,
          bin.byteOffset + (positionView.byteOffset || 0), positions.count * 3);
        const i = new Uint32Array(bin.buffer,
          bin.byteOffset + (indexView.byteOffset || 0), indices.count);
        for (let t = 0; t < indices.count / 3; t++) {
          const corners = [];
          for (let c = 0; c < 3; c++) {
            const at = i[t * 3 + c] * 3;
            corners.push(key(p[at], p[at + 1], p[at + 2]));
          }
          found.add(corners.sort().join(' | '));
        }
      }
      check('every triangle is the same triangle it was',
        found.size === wantedTriangles.size
        && [...wantedTriangles].every((t) => found.has(t)),
        `${found.size} of ${wantedTriangles.size} match`);
    }

    // Materials keep their colour, their transparency and their metalness.
    const wanted = new Map(source.palette.map((m) => [m.name, m]));
    const wrong = (json.materials || []).filter((m) => {
      const entry = wanted.get(m.name);
      if (!entry) return true;
      const factor = m.pbrMetallicRoughness.baseColorFactor;
      const opaque = (entry.opacity === undefined ? 1 : entry.opacity) >= 0.996;
      if (Math.abs(factor[3] - (entry.opacity === undefined ? 1 : entry.opacity)) > 1e-4) return true;
      if ((m.alphaMode === 'BLEND') === opaque) return true;
      const metallic = entry.metallic || 0;
      if (metallic < 0.999
        && [0, 1, 2].some((k) => Math.abs(factor[k] - entry.colour[k] / (1 - metallic)) > 1e-3
          && factor[k] < 1)) return true;
      return false;
    });
    check('materials keep their colour and their transparency', wrong.length === 0,
      wrong.slice(0, 3).map((m) => m.name).join(', ') || 'all match');

    if (validator) {
      const report = await validator.validateBytes(bytes);
      const messages = (report.issues.messages || [])
        .filter((m) => m.severity <= 1)
        .map((m) => `${m.code} at ${m.pointer}`);
      check('the Khronos validator is happy',
        report.issues.numErrors === 0 && report.issues.numWarnings === 0,
        messages.slice(0, 4).join('; ') || 'no errors, no warnings');
    }
    console.log(`       ${(stats.bytes / 1048576).toFixed(1)} MiB · `
      + `${stats.primitives} primitives · ${stats.images} image(s)\n`);
  }

  check('no page errors', errors.length === 0, errors.join(' | ') || 'clean');
  await browser.close();
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
