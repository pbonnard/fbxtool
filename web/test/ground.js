/* Ground contact: the floor under the model and the shadow it drops on it.
 *
 *   node web/test/ground.js <scene_parts.fbx>
 *
 * The fixture's cubes sit above the floor, so their shadows land on open
 * ground. The sun is fixed in the world, so the camera is swung round to face
 * it before the floor is read back.
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

/**
 * A grid of green values across the lower part of the viewport, where the
 * floor is. Rows count up from the bottom of the image, as readPixels does.
 */
function floorSamples(page) {
  return page.evaluate(() => {
    const canvas = document.getElementById('viewport');
    const gl = canvas.getContext('webgl2');
    const pixels = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    const out = [];
    for (const fy of [0.04, 0.08, 0.14, 0.2, 0.26, 0.32]) {
      for (const fx of [0.15, 0.25, 0.35, 0.45, 0.5, 0.55, 0.65, 0.75, 0.85]) {
        const at = (Math.round(canvas.height * fy) * canvas.width
          + Math.round(canvas.width * fx)) * 4;
        out.push(pixels[at + 1]);
      }
    }
    return out;
  });
}

/** The backdrop, read where nothing else can be: the top row of the frame. */
function skySample(page) {
  return page.evaluate(() => {
    const canvas = document.getElementById('viewport');
    const gl = canvas.getContext('webgl2');
    const pixels = new Uint8Array(canvas.width * 4);
    // readPixels counts up from the bottom, so the last row is the top one.
    gl.readPixels(0, canvas.height - 1, canvas.width, 1,
      gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    let total = 0;
    for (let at = 0; at < canvas.width; at++) total += pixels[at * 4 + 1];
    return Math.round(total / canvas.width);
  });
}

async function main() {
  const target = process.argv[2];
  if (!target) {
    console.error('usage: node web/test/ground.js <scene_parts.fbx>');
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

  const before = await page.evaluate(() => window.fbxtool.loadCount);
  await page.setInputFiles('#file-input', [target]);
  await page.waitForFunction((seen) => window.fbxtool.loadCount > seen, before,
    { timeout: 120000 });
  // The sun sits over one shoulder of the default view, so its shadows fall
  // away from the camera. Turn round to face it.
  await page.evaluate(() => {
    const viewer = window.fbxtool.viewer;
    viewer.yaw = 0.9 + Math.PI;
    viewer.dirty = true;
  });
  await page.waitForTimeout(700);

  console.log('the floor');
  const lit = await floorSamples(page);
  const shadowState = await page.evaluate(() => ({
    ready: window.fbxtool.viewer.shadowReady,
    renders: window.fbxtool.viewer.shadowRenders,
    height: window.fbxtool.viewer._groundHeight(),
  }));
  check('the shadow map was rendered', shadowState.ready && shadowState.renders === 1,
    `${shadowState.renders} render(s)`);
  check('the floor sits under the model', Math.abs(shadowState.height + 2) < 1e-6,
    `y = ${shadowState.height}`);

  /* Floor pixels are the ones between the darkest shadow and the model, and
   * a showroom floor is dark: it is there to catch a shadow rather than to be
   * looked at, and the model standing on it is brighter than any of it. So
   * what says the floor is lit is the backdrop it is held against — a floor
   * at 14 over a backdrop of 2 is a lit floor, while the same band read
   * against a fixed threshold is a bar the model clears on its behalf. */
  const backdrop = await skySample(page);
  const middle = [...lit].sort((a, b) => a - b)[Math.floor(lit.length / 2)];
  const darkest = Math.min(...lit);
  check('the floor is lit', middle > backdrop + 6 && middle > backdrop * 3,
    `floor ${middle} over a backdrop of ${backdrop}`);
  check('and something on it is in shadow', darkest * 2 < middle,
    `darkest ${darkest} against ${middle}`);

  console.log('\norbiting');
  await page.evaluate(() => {
    const viewer = window.fbxtool.viewer;
    viewer.yaw += 0.6;
    viewer.pitch = 0.5;
    viewer.dirty = true;
  });
  await page.waitForTimeout(500);
  const after = await page.evaluate(() => window.fbxtool.viewer.shadowRenders);
  check('moving the camera does not redraw the shadow map', after === 1, `${after} render(s)`);

  console.log('\nturning it off');
  /* Compared from the same camera, and sample by sample.
   *
   * What counts is the floor going away rather than any particular
   * brightness, and taking the brightest of the band for the floor only held
   * while the floor was the brightest thing low in the frame. It is not: a
   * showroom floor is darker than the model standing on it, so the brightest
   * sample is the model and it is there either way. What the floor's own
   * pixels do is drop to the backdrop while the model's stay where they were,
   * and the two readings can be asked that directly. */
  const standing = await floorSamples(page);
  await page.uncheck('#ground-toggle');
  await page.waitForTimeout(500);
  const bare = await floorSamples(page);
  const fell = standing.filter((value, at) => value - bare[at] > 4).length;
  const rose = standing.filter((value, at) => bare[at] > value + 2).length;
  check('the floor goes with it', fell > standing.length / 3 && rose === 0,
    `${fell} of ${standing.length} sample(s) fell, ${rose} rose`);
  await page.check('#ground-toggle');
  await page.waitForTimeout(500);
  const back = await floorSamples(page);
  const restored = standing.filter((value, at) => Math.abs(back[at] - value) <= 2).length;
  check('and comes back', restored === standing.length,
    `${restored} of ${standing.length} sample(s) back where they were`);

  console.log('\nthe up axis');
  const heights = await page.evaluate(() => {
    const viewer = window.fbxtool.viewer;
    const asY = viewer._groundHeight();
    viewer.setUpAxis('z');
    const asZ = viewer._groundHeight();
    const stale = viewer.shadowStale;
    viewer.setUpAxis('y');
    return { asY, asZ, stale };
  });
  check('the floor follows whichever axis is up', heights.asY !== heights.asZ,
    `y up ${heights.asY}, z up ${heights.asZ}`);
  check('and the shadow map is redrawn for it', heights.stale);

  check('no page errors', errors.length === 0, errors.join(' | ') || 'clean');

  await browser.close();
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
