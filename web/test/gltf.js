/* The glTF export: written by the page, checked here.
 *
 *   node web/test/gltf.js <model.fbx> [more...]
 *
 * Each file is loaded in the browser and exported through the real button,
 * then the GLB that comes back is taken apart: the container, the accessors
 * and the buffer arithmetic, the node tree, and whether what came out
 * describes the same model that went in. When the Khronos glTF-Validator is
 * installed it is run as well, which is the only check here that speaks for
 * the specification rather than for this test.
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

  let stored = 0;
  for (const mesh of json.meshes) {
    for (const primitive of mesh.primitives) {
      const positions = json.accessors[primitive.attributes.POSITION];
      const indices = json.accessors[primitive.indices];
      stored += indices.count / 3;
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
      // A material with a texture needs coordinates to sample it by.
      const material = json.materials && json.materials[primitive.material];
      const textured = material && material.pbrMetallicRoughness
        && material.pbrMetallicRoughness.baseColorTexture;
      if (textured && primitive.attributes.TEXCOORD_0 === undefined) {
        problems.push('a primitive uses a texture but has no TEXCOORD_0');
      }
      // Every index must point at a vertex this primitive actually has.
      const view = json.bufferViews[indices.bufferView];
      const at = (view.byteOffset || 0) + (indices.byteOffset || 0);
      const read = new Uint32Array(bin.buffer, bin.byteOffset + at, indices.count);
      let highest = 0;
      for (const value of read) if (value > highest) highest = value;
      if (highest >= positions.count) problems.push('an index points past the vertices');
    }
  }
  return { problems, stored };
}

const identity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** Column-major, as glTF writes them. */
function multiply(a, b) {
  const out = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = sum;
    }
  }
  return out;
}

function apply(m, x, y, z) {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}

/**
 * Walk the node tree, handing back every placed mesh with its world matrix.
 *
 * The root node carries the axis and unit conversion; it is skipped here so
 * the result is in the same space the viewer measured, which is what the
 * checks below compare against. That the root matrix itself is right is the
 * round-trip test's business.
 */
function placements(json) {
  const out = [];
  const walk = (index, matrix, depth) => {
    const node = json.nodes[index];
    const local = node.matrix ? multiply(matrix, node.matrix) : matrix;
    if (node.mesh !== undefined) out.push({ mesh: node.mesh, matrix: local, depth });
    for (const child of node.children || []) walk(child, local, depth + 1);
  };
  const root = json.nodes[json.scenes[json.scene || 0].nodes[0]];
  for (const child of root.children || []) walk(child, identity(), 1);
  return out;
}

/** Every triangle of a placed mesh, in world space. */
function trianglesOf(json, bin, placement) {
  const out = [];
  for (const primitive of json.meshes[placement.mesh].primitives) {
    const positions = json.accessors[primitive.attributes.POSITION];
    const indices = json.accessors[primitive.indices];
    const positionView = json.bufferViews[positions.bufferView];
    const indexView = json.bufferViews[indices.bufferView];
    const p = new Float32Array(bin.buffer, bin.byteOffset + (positionView.byteOffset || 0),
      positions.count * 3);
    const i = new Uint32Array(bin.buffer, bin.byteOffset + (indexView.byteOffset || 0),
      indices.count);
    for (let t = 0; t < indices.count / 3; t++) {
      const corners = [];
      for (let c = 0; c < 3; c++) {
        const at = i[t * 3 + c] * 3;
        corners.push(apply(placement.matrix, p[at], p[at + 1], p[at + 2]));
      }
      out.push(corners);
    }
  }
  return out;
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
    await page.setInputFiles('#file-input', []);
    await page.setInputFiles('#file-input', group);
    await page.waitForFunction((seen) => window.fbxtool.loadCount > seen, before,
      { timeout: 180000 });
    await page.waitForTimeout(400);

    const source = await page.evaluate(() => ({
      triangles: window.fbxtool.viewer.triangleCount,
      materials: window.fbxtool.materials.length,
      parts: window.fbxtool.parts,
      hasUv: window.fbxtool.viewer.hasUv,
      textures: window.fbxtool.viewer.textureLayers,
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

    // ---- the scene graph
    const placed = placements(json);
    const drawn = placed.reduce((sum, p) => sum + json.meshes[p.mesh].primitives
      .reduce((n, prim) => n + json.accessors[prim.indices].count / 3, 0), 0);
    check('every triangle came across', drawn === source.triangles,
      `${drawn.toLocaleString()} of ${source.triangles.toLocaleString()}`);
    check('the root node carries the axis and the units',
      json.nodes.length >= 1 && Array.isArray(json.nodes[0].matrix)
      && json.nodes[0].matrix.length === 16);
    check('one node per part', placed.length === source.parts,
      `${placed.length} placed, ${source.parts} parts`);

    // A mesh used twice is stored once: the file holds fewer triangles than
    // are drawn exactly when something is instanced.
    const instanced = placed.length > new Set(placed.map((p) => p.mesh)).size;
    check('a mesh used more than once is stored once',
      instanced ? inspected.stored < drawn : inspected.stored === drawn,
      `${inspected.stored.toLocaleString()} stored, ${drawn.toLocaleString()} drawn`
      + `, ${json.meshes.length} mesh(es) for ${placed.length} node(s)`);

    check('welding dropped the repeated vertices', stats.vertices < inspected.stored * 3,
      `${stats.vertices.toLocaleString()} vertices for `
      + `${(inspected.stored * 3).toLocaleString()} corners`);

    // ---- the geometry itself, where the parts stand
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (const placement of placed) {
      const mesh = json.meshes[placement.mesh];
      for (const primitive of mesh.primitives) {
        const positions = json.accessors[primitive.attributes.POSITION];
        const view = json.bufferViews[positions.bufferView];
        const p = new Float32Array(bin.buffer, bin.byteOffset + (view.byteOffset || 0),
          positions.count * 3);
        // Every vertex, placed: the corners of a rotated box would sit outside
        // the model and this is compared against the real thing.
        for (let v = 0; v < positions.count; v++) {
          const point = apply(placement.matrix, p[v * 3], p[v * 3 + 1], p[v * 3 + 2]);
          for (let k = 0; k < 3; k++) {
            if (point[k] < min[k]) min[k] = point[k];
            if (point[k] > max[k]) max[k] = point[k];
          }
        }
      }
    }
    const near = (a, b) => Math.abs(a - b) <= Math.max(1e-4, Math.abs(b) * 1e-4);
    check('the model came out the same size, in the same place',
      source.bounds && [0, 1, 2].every((k) => near(min[k], source.bounds.min[k])
        && near(max[k], source.bounds.max[k])),
      `${min.map((v) => v.toFixed(2))} .. ${max.map((v) => v.toFixed(2))}`);

    // On a small mesh, compare the triangles themselves rather than their
    // extremes: every corner of every triangle, placed by its node.
    if (source.triangles <= 5000) {
      const original = await page.evaluate(() => Array.from(window.fbxtool.exportMesh().positions));
      const key = (a, b, c) => [a, b, c].map((v) => v.toFixed(3)).join(',');
      const wanted = new Set();
      for (let t = 0; t < source.triangles; t++) {
        const corners = [];
        for (let c = 0; c < 3; c++) {
          const at = (t * 3 + c) * 3;
          corners.push(key(original[at], original[at + 1], original[at + 2]));
        }
        wanted.add(corners.sort().join(' | '));
      }
      const found = new Set();
      for (const placement of placed) {
        for (const triangle of trianglesOf(json, bin, placement)) {
          found.add(triangle.map((c) => key(c[0], c[1], c[2])).sort().join(' | '));
        }
      }
      check('every triangle is the same triangle it was, where it was',
        found.size === wanted.size && [...wanted].every((t) => found.has(t)),
        `${found.size} of ${wanted.size} match`);
    }

    // ---- materials and textures
    const used = new Set();
    for (const mesh of json.meshes) {
      for (const primitive of mesh.primitives) used.add(primitive.material);
    }
    check('no more materials than the scene has, and none unused',
      used.size === (json.materials || []).length
      && (json.materials || []).length <= Math.max(source.materials, 1),
      `${(json.materials || []).length} materials, ${source.materials} in the scene`);

    check('the textures came too', (json.images || []).length === source.textures,
      `${(json.images || []).length} image(s) exported, ${source.textures} on screen`);
    const readable = (json.images || []).every((image) =>
      image.mimeType === 'image/png' || image.mimeType === 'image/jpeg');
    check('in a format glTF allows', readable,
      [...new Set((json.images || []).map((i) => i.mimeType))].join(', ') || 'none');

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
    // ---- the same scene with a part taken out of it, and another cut up
    const left = await page.evaluate(() => {
      if (window.fbxtool.partTable.length < 2) return null;
      const table = window.fbxtool.partTable;
      let biggest = 0;
      table.forEach((part, index) => {
        if (part.triangles > table[biggest].triangles) biggest = index;
      });
      window.fbxtool.selectPart(biggest);
      window.fbxtool.splitPart(biggest, 'shells');   // refused if it is all one piece
      window.fbxtool.selectPart(0);
      window.fbxtool.deletePart(0);
      // A material of the viewer's own, on a part that came out of the file.
      window.fbxtool.selectPart(0);
      window.fbxtool.addMaterial(0);
      return window.fbxtool.viewer.triangleCount;
    });
    if (left) {
      const [edited] = await Promise.all([
        page.waitForEvent('download', { timeout: 180000 }),
        page.click('#export-gltf'),
      ]);
      const editedPath = path.join(path.dirname(await edited.path()), 'edited.glb');
      await edited.saveAs(editedPath);
      const editedBytes = new Uint8Array(fs.readFileSync(editedPath));
      const cut = readGlb(editedBytes);
      const remaining = placements(cut.json).reduce((sum, p) => sum
        + cut.json.meshes[p.mesh].primitives
          .reduce((n, prim) => n + cut.json.accessors[prim.indices].count / 3, 0), 0);
      check('an edited scene exports as what is left of it', remaining === left,
        `${remaining.toLocaleString()} of ${left.toLocaleString()}`);
      const invented = (cut.json.materials || []).find((m) => m.name === 'New material');
      const wears = placements(cut.json).some((p) => cut.json.meshes[p.mesh].primitives
        .some((prim) => cut.json.materials[prim.material]
          && cut.json.materials[prim.material].name === 'New material'));
      check('with a material the file never had, on the part it was given to',
        !!invented && wears, invented ? 'written and used' : 'missing');
      if (validator) {
        const report = await validator.validateBytes(editedBytes);
        check('and what comes out is still a valid glTF',
          report.issues.numErrors === 0 && report.issues.numWarnings === 0,
          `${report.issues.numErrors} error(s), ${report.issues.numWarnings} warning(s)`);
      }
      await page.evaluate(() => window.fbxtool.restoreAll());
    }

    console.log(`       ${(stats.bytes / 1048576).toFixed(1)} MiB · `
      + `${stats.meshes} mesh(es) in ${stats.nodes} node(s) · `
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
