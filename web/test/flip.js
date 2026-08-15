/* Mirroring the model on its own axes.
 *
 *   node web/test/flip.js <scene_parts.fbx>
 *
 * The fixture has to be lopsided for any of this to mean anything: three cubes
 * in three places, so a mirror moves them somewhere a rotation could not.
 *
 * The camera is put straight on first — yaw and pitch at zero — which makes
 * the screen's X the model's X, and a mirror on X exactly a mirror of the
 * picture. What that catches is a flip applied in the wrong space, or after
 * the up axis rather than before it.
 *
 * The second thing at stake is which way round a triangle is wound. A mirror
 * reverses it, and a renderer that goes on culling by the old rule draws the
 * inside of the model instead of the outside — the same silhouette, so the
 * picture alone would not say. The normals pass says: a face pointing at the
 * camera still has to point at the camera afterwards.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { launch } = require('./chromium');

const ROOT = path.resolve(__dirname, '..', '..');
const PAGE = path.join(ROOT, 'web', 'dist', 'fbxview.html');

let failures = 0;

function check(label, condition, detail = '') {
  if (!condition) failures++;
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? `  · ${detail}` : ''}`);
}

/** The JSON chunk of a written .glb. */
function readGlbJson(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 12;
  while (at + 8 <= bytes.length) {
    const length = view.getUint32(at, true);
    if (view.getUint32(at + 4, true) === 0x4e4f534a) {
      return JSON.parse(Buffer.from(bytes.buffer, bytes.byteOffset + at + 8, length)
        .toString('utf8'));
    }
    at += 8 + length + ((4 - (length % 4)) % 4);
  }
  throw new Error('no JSON chunk in the exported .glb');
}

const determinant = (m) => m[0] * (m[5] * m[10] - m[6] * m[9])
  - m[4] * (m[1] * m[10] - m[2] * m[9]) + m[8] * (m[1] * m[6] - m[2] * m[5]);

/**
 * The model's outline, as a coarse grid of true and false.
 *
 * Read off the normals pass, where the model is saturated colour and both the
 * background and the floor are grey — so what is picked out is the model and
 * nothing else, whatever the light is doing.
 */
function silhouette(page, columns = 40, rows = 25) {
  return page.evaluate(({ columns: cols, rows: rws }) => {
    const canvas = document.getElementById('viewport');
    const gl = canvas.getContext('webgl2');
    const pixels = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    const grid = [];
    for (let row = 0; row < rws; row++) {
      const line = [];
      for (let col = 0; col < cols; col++) {
        const x = Math.floor((col + 0.5) * canvas.width / cols);
        const y = Math.floor((row + 0.5) * canvas.height / rws);
        const at = (y * canvas.width + x) * 4;
        const r = pixels[at];
        const g = pixels[at + 1];
        const b = pixels[at + 2];
        line.push(Math.max(r, g, b) - Math.min(r, g, b) > 30);
      }
      grid.push(line);
    }
    return grid;
  }, { columns, rows });
}

const covered = (grid) => grid.reduce((n, row) => n + row.filter(Boolean).length, 0);

/** How much of two outlines agree, as a fraction of the squares either covers. */
function agreement(a, b) {
  let both = 0;
  let either = 0;
  for (let row = 0; row < a.length; row++) {
    for (let col = 0; col < a[row].length; col++) {
      if (a[row][col] && b[row][col]) both++;
      if (a[row][col] || b[row][col]) either++;
    }
  }
  return either ? both / either : 1;
}

const mirrored = (grid) => grid.map((row) => row.slice().reverse());

async function main() {
  const target = process.argv[2];
  if (!target) {
    console.error('usage: node web/test/flip.js <scene_parts.fbx>');
    process.exit(2);
  }
  if (!fs.existsSync(PAGE)) {
    console.error(`${PAGE} is missing — run: python3 web/build.py`);
    process.exit(2);
  }

  const browser = await launch(chromium);
  const page = await browser.newPage({ viewport: { width: 1200, height: 760 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`file://${PAGE}`);
  await page.waitForFunction(() => document.body.dataset.ready === 'true', { timeout: 20000 });
  await page.evaluate(() => { try { localStorage.clear(); } catch (e) { /* file:// */ } });

  await page.setInputFiles('#file-input', [target]);
  await page.waitForFunction(() => window.fbxtool.loadCount > 0, { timeout: 120000 });
  await page.waitForTimeout(500);

  // Straight on, and drawn as normals: the screen's X is the model's X, and
  // the model is the only saturated thing in the picture.
  await page.selectOption('#mode-select', '3');
  await page.evaluate(() => {
    const v = window.fbxtool.viewer;
    v.yaw = 0;
    v.pitch = 0;
    v.dirty = true;
  });
  await page.waitForTimeout(400);

  console.log('a model, seen straight on');
  const upright = await silhouette(page);
  check('the model is drawn, and is not the whole picture',
    covered(upright) > 40 && covered(upright) < 40 * 25 * 0.9,
    `${covered(upright)} of ${40 * 25} squares`);
  check('and it is lopsided, so a mirror is visible at all',
    agreement(upright, mirrored(upright)) < 0.85,
    `${(agreement(upright, mirrored(upright)) * 100).toFixed(0)}% symmetric`);

  console.log('\nmirrored on X');
  await page.click('#flip-x');
  await page.waitForTimeout(400);
  const flipped = await silhouette(page);
  check('the button says so', await page.getAttribute('#flip-x', 'aria-pressed') === 'true');
  check('and the page holds it as a flip on X alone',
    JSON.stringify(await page.evaluate(() => window.fbxtool.flips)) === '[true,false,false]',
    JSON.stringify(await page.evaluate(() => window.fbxtool.flips)));
  check('the picture is the mirror of what it was',
    agreement(flipped, mirrored(upright)) > 0.9,
    `${(agreement(flipped, mirrored(upright)) * 100).toFixed(0)}% of the mirrored outline`);
  check('which is not the picture it was',
    agreement(flipped, upright) < 0.85,
    `${(agreement(flipped, upright) * 100).toFixed(0)}% of the original`);

  /* Winding. In the normals pass a surface facing the camera is drawn with a
   * normal pointing at it — blue, in the +Z half. Mirrored, the near faces are
   * still the near faces, so they are still blue; drawn by the old winding
   * rule they would be culled and the far side of the model drawn instead,
   * whose normals point the other way. */
  const facing = () => page.evaluate(() => {
    const canvas = document.getElementById('viewport');
    const gl = canvas.getContext('webgl2');
    const pixels = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    let toward = 0;
    let away = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      const r = pixels[i];
      const g = pixels[i + 1];
      const b = pixels[i + 2];
      if (Math.max(r, g, b) - Math.min(r, g, b) <= 30) continue;
      // The normal is packed as n * 0.5 + 0.5, so 128 is the horizon.
      if (b > 140) toward++;
      else if (b < 116) away++;
    }
    return { toward, away };
  });
  const front = await facing();
  check('what faces the camera is still what is drawn',
    front.toward > front.away * 4,
    `${front.toward} pixels facing us, ${front.away} facing away`);

  console.log('\nout through the export');
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 180000 }),
    page.click('#export-gltf'),
  ]);
  const saved = path.join(path.dirname(await download.path()), 'flipped.glb');
  await download.saveAs(saved);
  const json = readGlbJson(new Uint8Array(fs.readFileSync(saved)));
  const matrix = json.nodes[0].matrix;
  check('the root node carries the mirror', matrix && determinant(matrix) < 0,
    matrix ? `determinant ${determinant(matrix).toExponential(2)}` : 'no matrix');
  check('on the axis that was mirrored and no other',
    matrix[0] < 0 && matrix[5] >= 0 && matrix[10] >= 0,
    matrix ? `${matrix[0]}, ${matrix[5]}, ${matrix[10]}` : '');

  console.log('\nand back');
  await page.click('#flip-x');
  await page.waitForTimeout(400);
  const restored = await silhouette(page);
  check('clicking again puts the model back',
    agreement(restored, upright) > 0.95,
    `${(agreement(restored, upright) * 100).toFixed(0)}% of the original`);
  check('and the button lets go', await page.getAttribute('#flip-x', 'aria-pressed') === 'false');

  console.log('\nthe other two axes');
  await page.click('#flip-y');
  await page.click('#flip-z');
  await page.waitForTimeout(400);
  check('each axis has its own button',
    JSON.stringify(await page.evaluate(() => window.fbxtool.flips)) === '[false,true,true]',
    JSON.stringify(await page.evaluate(() => window.fbxtool.flips)));
  const twice = await silhouette(page);
  check('two mirrors still leave the model on screen', covered(twice) > 40,
    `${covered(twice)} squares`);

  // Mirroring on the axis that points up turns the model over, and the floor
  // it stands on has to follow it rather than cut through it.
  const floor = await page.evaluate(() => {
    const v = window.fbxtool.viewer;
    return { ground: v._groundHeight(), min: v.meshMin, max: v.meshMax, up: v.upAxis };
  });
  const axis = floor.up === 'z' ? 2 : 1;
  const middle = (floor.min[axis] + floor.max[axis]) / 2;
  check('the floor drops to what is now the lowest point',
    Math.abs(floor.ground - (middle - floor.max[axis])) < 1e-3,
    `${floor.ground.toFixed(3)} against ${(middle - floor.max[axis]).toFixed(3)}`);

  check('no page errors', errors.length === 0, errors.join(' | ') || 'clean');

  await browser.close();
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
