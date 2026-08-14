/* The smoothing control, driven in the browser.
 *
 *   node web/test/smoothing.js <cube.fbx> <scene.fbx>
 *
 * The maths is checked natively and the module is checked under Node; what is
 * left is the part a user touches — that picking a level rebuilds what is on
 * screen, that the viewport says so, and that a smoothed cube really does draw
 * as a rounder, denser thing than the cage it came from.
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
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? `  — ${detail}` : ''}`);
}

/** How much of the viewport the model covers, and how big it is. */
function state(page) {
  return page.evaluate(() => {
    const canvas = document.getElementById('viewport');
    const gl = canvas.getContext('webgl2');
    const pixels = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    // The model is what is brighter than the backdrop behind it.
    let lit = 0;
    for (let i = 0; i < pixels.length; i += 4 * 17) {
      if (pixels[i] > 110 && pixels[i + 1] > 110) lit++;
    }
    return {
      triangles: window.fbxtool.viewer.triangleCount,
      lit,
      info: document.getElementById('mesh-info').textContent,
    };
  });
}

async function setLevel(page, level) {
  await page.selectOption('#subdiv-select', String(level));
  await page.waitForFunction(
    (want) => document.getElementById('mesh-info').textContent.includes(want),
    level > 0 ? `smoothed ×${level}` : 'triangles',
    { timeout: 120000 },
  );
  await page.waitForTimeout(500);
  return state(page);
}

async function main() {
  const [cubeFile, sceneFile] = process.argv.slice(2);
  if (!cubeFile || !sceneFile) {
    console.error('usage: node web/test/smoothing.js <cube.fbx> <scene.fbx>');
    process.exit(2);
  }
  if (!fs.existsSync(PAGE)) {
    console.error(`${PAGE} is missing — run: python3 web/build.py`);
    process.exit(2);
  }

  const browser = await launch(chromium);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto(`file://${PAGE}`);
  await page.waitForFunction(() => document.body.dataset.ready === 'true', { timeout: 20000 });

  const load = async (file) => {
    const before = await page.evaluate(() => window.fbxtool.loadCount);
    await page.setInputFiles('#file-input', [file]);
    await page.waitForFunction((seen) => window.fbxtool.loadCount > seen, before,
      { timeout: 120000 });
    await page.waitForTimeout(400);
    return state(page);
  };

  console.log('a cube');
  const cage = await load(cubeFile);
  check('starts unsmoothed', cage.triangles === 12 && !/smoothed/.test(cage.info),
    `${cage.triangles} triangles`);

  const once = await setLevel(page, 1);
  check('one round turns six quads into twenty-four',
    once.triangles === 48, `${once.triangles} triangles`);
  check('and the viewport says so', /smoothed ×1/.test(once.info));
  // Catmull-Clark pulls the corners in, so the cube covers less of the screen.
  check('the shape is rounded, not merely denser', once.lit < cage.lit * 0.95,
    `${cage.lit} lit samples -> ${once.lit}`);

  const twice = await setLevel(page, 2);
  check('two rounds multiply again', twice.triangles === 192, `${twice.triangles} triangles`);
  // Each level converges on the same limit surface rather than shrinking
  // further, so what matters is that it is still the rounded shape.
  check('and stay on the rounded shape', twice.lit < cage.lit * 0.95,
    `${cage.lit} lit samples -> ${twice.lit}`);

  const back = await setLevel(page, 0);
  check('turning it off gives the cage back',
    back.triangles === 12 && !/smoothed/.test(back.info), `${back.triangles} triangles`);

  console.log('\nthe view while smoothing');
  // Move somewhere deliberate, as anyone comparing two levels would.
  const wanted = await page.evaluate(() => {
    const viewer = window.fbxtool.viewer;
    viewer.yaw = 2.1;
    viewer.pitch = 0.55;
    viewer.distance = viewer.radius * 1.3;
    viewer.dirty = true;
    return { yaw: viewer.yaw, pitch: viewer.pitch, distance: viewer.distance };
  });
  await setLevel(page, 1);
  const kept = await page.evaluate(() => {
    const viewer = window.fbxtool.viewer;
    return { yaw: viewer.yaw, pitch: viewer.pitch, distance: viewer.distance };
  });
  check('smoothing leaves the camera where it was',
    Math.abs(kept.yaw - wanted.yaw) < 1e-9 && Math.abs(kept.pitch - wanted.pitch) < 1e-9
    && Math.abs(kept.distance - wanted.distance) < 1e-9,
    `yaw ${kept.yaw.toFixed(2)}, distance ${kept.distance.toFixed(1)}`);

  // Reset view is still the way back.
  await page.click('#reset-view');
  await page.waitForTimeout(300);
  const reset = await page.evaluate(() => window.fbxtool.viewer.yaw);
  check('and Reset view still frames it afresh', Math.abs(reset - 0.9) < 1e-9,
    `yaw ${reset.toFixed(2)}`);
  await setLevel(page, 0);

  console.log('\nthe up axis');
  // Files declare this wrongly often enough that the answer is worth keeping.
  const wrongWayUp = await page.evaluate(() => document.getElementById('up-select').value);
  const other = wrongWayUp === 'z' ? 'y' : 'z';
  await page.selectOption('#up-select', other);
  await page.waitForTimeout(300);
  await setLevel(page, 1);
  check('a hand-picked axis survives a rebuild',
    await page.evaluate(() => window.fbxtool.viewer.upAxis) === other,
    `${wrongWayUp} -> ${other}`);
  await setLevel(page, 0);

  // Re-opening the same file should not need the same correction again.
  const beforeReload = await page.evaluate(() => window.fbxtool.loadCount);
  // Setting the same file again is not a change; empty it first.
  await page.setInputFiles('#file-input', []);
  await page.setInputFiles('#file-input', [cubeFile]);
  await page.waitForFunction((s) => window.fbxtool.loadCount > s, beforeReload,
    { timeout: 60000 });
  await page.waitForTimeout(400);
  const remembered = await page.evaluate(() => ({
    axis: window.fbxtool.viewer.upAxis,
    select: document.getElementById('up-select').value,
  }));
  check('and is remembered when the file is opened again',
    remembered.axis === other && remembered.select === other,
    `${remembered.axis} on the viewer, ${remembered.select} in the control`);
  // Leave nothing behind for the next file.
  await page.evaluate(() => {
    try { window.localStorage.clear(); } catch (error) { /* file:// */ }
  });

  console.log('\na scene of several parts');
  const parts = await load(sceneFile);
  check('the setting does not survive a new file',
    parts.triangles === 36 && !/smoothed/.test(parts.info), parts.info.slice(0, 60));
  const smoothed = await setLevel(page, 1);
  check('every part is smoothed', smoothed.triangles === 144,
    `${smoothed.triangles} triangles`);
  check('and they are still assembled as a scene', /3 parts/.test(smoothed.info),
    smoothed.info.slice(0, 70));

  check('no page errors', errors.length === 0, errors.join(' | ') || 'clean');

  await browser.close();
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
