/* Reading glTF back in.
 *
 *   node web/test/gltfin.js <model.fbx> [more...]
 *
 * The reader is checked against the exporter, which is the one thing here that
 * can say whether a model survived the trip: each file is loaded, exported as a
 * .glb through the real button, and then that .glb is dropped back on the page.
 * What comes back has to be the same model — the same triangles, the same size,
 * the same materials with the same colours — even though every part of it took
 * a different route the second time.
 *
 * A .gltf with its buffer in a separate .bin is written by hand and dropped in
 * too, since that is the shape the reader gets from a real exporter and the one
 * a container hides.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');
const { launch } = require('./chromium');

const ROOT = path.resolve(__dirname, '..', '..');
const PAGE = path.join(ROOT, 'web', 'dist', 'fbxview.html');

let failures = 0;

function check(label, condition, detail = '') {
  if (!condition) failures++;
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? `  — ${detail}` : ''}`);
}

/** What the page is showing, in the terms both formats can be compared in. */
function state(page) {
  return page.evaluate(() => ({
    triangles: window.fbxtool.viewer.triangleCount,
    min: window.fbxtool.viewer.meshMin,
    max: window.fbxtool.viewer.meshMax,
    materials: window.fbxtool.palette.map((entry) => ({
      name: entry.name,
      colour: entry.colour,
      opacity: entry.opacity === undefined ? 1 : entry.opacity,
      metallic: entry.metallic || 0,
      specular: entry.specular || [0.04, 0.04, 0.04],
    })),
    upAxis: window.fbxtool.viewer.upAxis,
    format: window.fbxtool.doc && window.fbxtool.doc.format,
    warnings: (window.fbxtool.doc && window.fbxtool.doc.warnings) || [],
    info: document.getElementById('mesh-info').textContent,
  }));
}

/** Take a .glb apart into a .gltf and the .bin it points at. */
function unpack(bytes, directory, stem) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const jsonLength = view.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength)));
  const binAt = 20 + jsonLength;
  const binLength = view.getUint32(binAt, true);
  const bin = bytes.subarray(binAt + 8, binAt + 8 + binLength);

  // Images inside the container have to come out with it, as data: URIs, so
  // this stays a test of the buffer being elsewhere and nothing else.
  for (const image of json.images || []) {
    if (image.bufferView === undefined) continue;
    const imageView = json.bufferViews[image.bufferView];
    const slice = bin.subarray(imageView.byteOffset || 0,
      (imageView.byteOffset || 0) + imageView.byteLength);
    image.uri = `data:${image.mimeType || 'image/png'};base64,`
      + Buffer.from(slice).toString('base64');
    delete image.bufferView;
  }
  json.buffers[0].uri = `${stem}.bin`;
  json.buffers[0].byteLength = bin.length;

  const gltfPath = path.join(directory, `${stem}.gltf`);
  const binPath = path.join(directory, `${stem}.bin`);
  fs.writeFileSync(gltfPath, JSON.stringify(json));
  fs.writeFileSync(binPath, bin);
  return { gltfPath, binPath };
}

/**
 * A .gltf using what our own exporter never writes, so the round trip is not
 * the only thing the reader is measured against: attributes interleaved behind
 * a byteStride, 16-bit indices, a sparse accessor that moves one corner, a
 * primitive with no indices at all, and a node placed by a quaternion.
 *
 * The box is 2 x 1 x 5 locally — the fifth unit of depth coming from the
 * sparse override alone — scaled by two and turned a quarter turn about Y,
 * which swaps its width and its depth.
 */
function handWritten() {
  const stride = 24;                             // position and normal, floats
  const corners = [
    [-1, -0.5, -2], [1, -0.5, -2], [1, 0.5, -2], [-1, 0.5, -2],
    [-1, -0.5, 2], [1, -0.5, 2], [1, 0.5, 2], [-1, 0.5, 2],
  ];
  const bytes = new Uint8Array(316);
  const floats = new DataView(bytes.buffer);
  corners.forEach((corner, index) => {
    for (let k = 0; k < 3; k++) floats.setFloat32(index * stride + k * 4, corner[k], true);
    floats.setFloat32(index * stride + 12 + 4, 1, true);        // normal +Y
  });
  const faces = [
    [0, 1, 2], [0, 2, 3], [5, 4, 7], [5, 7, 6], [4, 0, 3], [4, 3, 7],
    [1, 5, 6], [1, 6, 2], [3, 2, 6], [3, 6, 7], [4, 5, 1], [4, 1, 0],
  ];
  faces.flat().forEach((index, at) => floats.setUint16(192 + at * 2, index, true));
  // The sparse accessor drags corner 0 a unit further back, so the box is
  // 2 x 1 x 5 only if it was applied — no other corner reaches that far.
  floats.setUint16(264, 0, true);
  const moved = [-1, -0.5, -3];
  for (let k = 0; k < 3; k++) floats.setFloat32(268 + k * 4, moved[k], true);
  // An unindexed triangle, small enough to sit inside the box.
  [[0, 0, 0], [0.1, 0, 0], [0, 0.1, 0]].flat()
    .forEach((value, at) => floats.setFloat32(280 + at * 4, value, true));

  const view = (byteOffset, byteLength, extra = {}) =>
    ({ buffer: 0, byteOffset, byteLength, ...extra });
  return {
    asset: { version: '2.0', generator: 'fbxtool test' },
    scene: 0,
    scenes: [{ nodes: [0, 1] }],
    nodes: [
      {
        name: 'box', mesh: 0, translation: [5, 0, 0], scale: [2, 2, 2],
        rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2],
      },
      {
        name: 'speck', mesh: 1, translation: [5, 0, 0], scale: [2, 2, 2],
        rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2],
      },
    ],
    meshes: [
      { name: 'box', primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2 }] },
      { name: 'speck', primitives: [{ attributes: { POSITION: 3 } }] },
    ],
    buffers: [{
      byteLength: bytes.length,
      uri: `data:application/octet-stream;base64,${Buffer.from(bytes).toString('base64')}`,
    }],
    bufferViews: [
      view(0, 192, { byteStride: stride }),
      view(192, 72),
      view(264, 2),
      view(268, 12),
      view(280, 36),
    ],
    accessors: [
      {
        bufferView: 0, byteOffset: 0, componentType: 5126, count: 8, type: 'VEC3',
        sparse: {
          count: 1,
          indices: { bufferView: 2, byteOffset: 0, componentType: 5123 },
          values: { bufferView: 3, byteOffset: 0 },
        },
      },
      { bufferView: 0, byteOffset: 12, componentType: 5126, count: 8, type: 'VEC3' },
      { bufferView: 1, componentType: 5123, count: 36, type: 'SCALAR' },
      { bufferView: 4, componentType: 5126, count: 3, type: 'VEC3' },
    ],
  };
}

async function main() {
  // The hand-written file needs no model; anything named is round-tripped too.
  const files = process.argv.slice(2);
  if (!fs.existsSync(PAGE)) {
    console.error(`${PAGE} is missing — run: python3 web/build.py`);
    process.exit(2);
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'fbxtool-gltfin-'));
  const browser = await launch(chromium);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto(`file://${PAGE}`);
  await page.waitForFunction(() => document.body.dataset.ready === 'true', { timeout: 20000 });

  const load = async (group) => {
    const before = await page.evaluate(() => window.fbxtool.loadCount);
    await page.setInputFiles('#file-input', []);
    await page.setInputFiles('#file-input', group);
    await page.waitForFunction((seen) => window.fbxtool.loadCount > seen, before,
      { timeout: 180000 });
    await page.waitForTimeout(300);
    return state(page);
  };

  console.log('a hand-written .gltf');
  const oddPath = path.join(work, 'odd.gltf');
  fs.writeFileSync(oddPath, JSON.stringify(handWritten()));
  const odd = await load([oddPath]);
  check('reads without complaint', odd.format === 'gltf' && odd.warnings.length === 0,
    odd.warnings.slice(0, 2).join('; ') || `format ${odd.format}`);
  check('16-bit indices and an unindexed primitive both count',
    odd.triangles === 13, `${odd.triangles} triangles`);
  // The viewer may convert the axes and the units, which permutes and scales
  // the box; its proportions survive either, and pin every part of the read.
  const extents = [0, 1, 2].map((k) => odd.max[k] - odd.min[k]).sort((a, b) => a - b);
  const largest = extents[2] || 1;
  const shape = extents.map((v) => v / largest);
  // 4 x 2 x 10 after the scale; ignore the sparse corner and it is 4 x 2 x 8.
  check('interleaving, the quaternion and the sparse corner give a 2 x 1 x 5 box',
    [0.2, 0.4, 1].every((want, k) => Math.abs(shape[k] - want) < 2e-3),
    shape.map((v) => v.toFixed(3)).join(' : '));
  const centre = [0, 1, 2].map((k) => Math.abs((odd.max[k] + odd.min[k]) / 2) / largest)
    .sort((a, b) => a - b);
  check('and stand it where the node says, a quarter turn round',
    Math.abs(centre[2] - 0.4) < 2e-3 && centre[1] < 2e-3,
    centre.map((v) => v.toFixed(3)).join(', '));
  console.log('');

  for (const entry of files) {
    const group = entry.split('+').every((f) => fs.existsSync(f)) ? entry.split('+') : [entry];
    const stem = path.basename(group[0]).replace(/\.[^.]+$/, '').replace(/[^\w-]+/g, '_');
    console.log(group.map((f) => path.basename(f)).join(' + '));

    const source = await load(group);
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 180000 }),
      page.click('#export-gltf'),
    ]);
    const glbPath = path.join(work, `${stem}.glb`);
    await download.saveAs(glbPath);
    const bytes = new Uint8Array(fs.readFileSync(glbPath));

    const back = await load([glbPath]);
    check('the .glb is recognised from its bytes', back.format === 'gltf',
      `read as ${back.format}`);
    check('with nothing to complain about', back.warnings.length === 0,
      back.warnings.slice(0, 2).join('; ') || 'no warnings');
    check('every triangle came back', back.triangles === source.triangles,
      `${back.triangles.toLocaleString()} of ${source.triangles.toLocaleString()}`);

    // The exporter puts the up axis and the units on the root node's matrix,
    // so what comes back is the same model turned upright and measured in
    // metres. That is one scale factor and one quarter turn, and both have to
    // survive: the shape to a single scale, and the height along Y, which is
    // the axis glTF requires.
    const extent = (s) => [0, 1, 2].map((k) => s.max[k] - s.min[k]);
    const sizeWas = extent(source);
    const sizeNow = extent(back);
    const scale = Math.max(...sizeNow) / Math.max(...sizeWas);
    const near = (a, b) => Math.abs(a - b) <= Math.max(1e-4, Math.abs(b) * 2e-4);
    const sorted = (v) => [...v].sort((a, b) => a - b);
    check('the same shape, to a single scale',
      sorted(sizeNow).every((v, k) => near(v, sorted(sizeWas)[k] * scale)),
      `${sizeNow.map((v) => v.toFixed(3))} = ${sizeWas.map((v) => v.toFixed(1))} x `
      + scale.toPrecision(3));
    check('standing the way glTF asks, with its height along Y',
      near(sizeNow[1], sizeWas[source.upAxis === 'z' ? 2 : 1] * scale),
      `${source.upAxis} up became ${sizeNow[1].toFixed(3)} tall`);

    // Only materials that cover triangles are exported, so the count can fall.
    check('the materials came with it',
      back.materials.length > 0 && back.materials.length <= Math.max(source.materials.length, 1),
      `${back.materials.length} of ${source.materials.length}`);
    const wanted = new Map(source.materials.map((m) => [m.name, m]));
    const wrong = back.materials.filter((m) => {
      const was = wanted.get(m.name);
      if (!was) return true;
      if (Math.abs(m.opacity - was.opacity) > 2e-3) return true;
      // Metal keeps its colour in the base colour rather than the diffuse, so
      // compare what each one reflects rather than the field it sits in.
      const lit = (entry) => [0, 1, 2].map((k) =>
        entry.colour[k] * (1 - entry.metallic) + entry.colour[k] * entry.metallic);
      if ([0, 1, 2].some((k) => Math.abs(lit(m)[k] - lit(was)[k]) > 6e-3)) return true;
      /* A dielectric's reflectance comes back as it went.
       *
       * `KHR_materials_specular` is still held at the 4% a dielectric has —
       * above that the surface renders as a mirror and cancels its own albedo
       * in indirect light, so a colour written to it does nothing, and that
       * is what everything downstream of this reads. But the number the file
       * actually stated is written beside it under `extras` and read back
       * here, so the trip through a glTF no longer costs it. */
      if (was.metallic >= 0.5) return false;
      return [0, 1, 2].some((k) => Math.abs(m.specular[k] - was.specular[k]) > 4e-3);
    });
    check('each with its name, its colour and its transparency', wrong.length === 0,
      wrong.slice(0, 3).map((m) => m.name).join(', ') || 'all match');

    // The same file again, but with the vertices in a .bin beside it.
    const { gltfPath, binPath } = unpack(bytes, work, stem);
    const alone = await load([gltfPath]);
    check('a .gltf without its .bin says what is missing',
      alone.warnings.some((w) => /not supplied/.test(w)),
      alone.warnings.slice(0, 1).join('') || 'no warning');

    const together = await load([gltfPath, binPath]);
    check('and reads in full when the .bin comes too',
      together.triangles === source.triangles && together.warnings.length === 0,
      `${together.triangles.toLocaleString()} triangles, `
      + `${together.warnings.length} warning(s)`);

    // Dropping the .bin afterwards has to work as well: that is what happens
    // when someone opens the model first and sees it empty.
    await load([gltfPath]);
    const before = await page.evaluate(() => window.fbxtool.loadCount);
    await page.setInputFiles('#file-input', []);
    await page.setInputFiles('#file-input', [binPath]);
    await page.waitForFunction((seen) => window.fbxtool.loadCount > seen, before,
      { timeout: 180000 });
    await page.waitForTimeout(300);
    const late = await state(page);
    check('or when the .bin is dropped in afterwards',
      late.triangles === source.triangles, `${late.triangles.toLocaleString()} triangles`);
    console.log('');
  }

  check('no page errors', errors.length === 0, errors.join(' | ') || 'clean');
  await browser.close();
  fs.rmSync(work, { recursive: true, force: true });
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
