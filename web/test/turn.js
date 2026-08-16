/* Turning the model round to face the other way.
 *
 *   node web/test/turn.js <scene_parts.fbx>
 *
 * No file says which end of a model is its front. The axis declarations look
 * like they do, but they are a convention of the format — every 3ds Max scene
 * says front is -Y whichever way the artist laid the car out — so a model whose
 * length runs across that declaration opens showing its back. The answer is to
 * be told, once, and remembered.
 *
 * Two things are at stake. The turn has to actually be a turn: the picture
 * changes, four of them come back to where they started, and reframing keeps
 * it rather than snapping to the default view. And it has to stay a view: a
 * mirror is written into the export, a heading is not, so what leaves the tool
 * after turning it round is the model exactly where the file put it.
 *
 * The fixture has to be lopsided for any of this to be visible: three cubes in
 * three places, so the view from the other side is not the view from here.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { launch } = require('./chromium');

const ROOT = path.resolve(__dirname, '..', '..');
const PAGE = path.join(ROOT, 'web', 'dist', 'fbxview.html');
const QUARTER = Math.PI / 2;

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

/**
 * The model's outline, as a coarse grid of true and false — read off the
 * normals pass, where the model is saturated colour and the background and the
 * floor are grey.
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
        line.push(Math.max(pixels[at], pixels[at + 1], pixels[at + 2])
          - Math.min(pixels[at], pixels[at + 1], pixels[at + 2]) > 30);
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

const heading = (page) => page.evaluate(() => window.fbxtool.heading);
const yawOf = (page) => page.evaluate(() => window.fbxtool.viewer.yaw);
const pressed = (page) => page.getAttribute('#turn-button', 'aria-pressed');

async function main() {
  const target = process.argv[2];
  if (!target) {
    console.error('usage: node web/test/turn.js <scene_parts.fbx>');
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

  const load = async () => {
    await page.setInputFiles('#file-input', []);
    const before = await page.evaluate(() => window.fbxtool.loadCount);
    await page.setInputFiles('#file-input', [target]);
    await page.waitForFunction((n) => window.fbxtool.loadCount > n, before, { timeout: 120000 });
    await page.waitForTimeout(600);
  };

  await load();
  // Drawn as normals, where the model is the only saturated thing in the frame.
  await page.selectOption('#mode-select', '3');
  await page.waitForTimeout(400);

  console.log('a model, as it opens');
  const opened = await silhouette(page);
  const openYaw = await yawOf(page);
  check('it is drawn, and is not the whole picture',
    covered(opened) > 40 && covered(opened) < 40 * 25 * 0.9,
    `${covered(opened)} of ${40 * 25} squares`);
  check('facing no particular way yet', await heading(page) === 0);
  check('and the button says as much', await pressed(page) === 'false');

  console.log('\nturned round to face the other way');
  await page.click('#turn-button');
  await page.click('#turn-button');
  await page.waitForTimeout(400);
  const around = await silhouette(page);
  check('the page holds two quarter turns', await heading(page) === 2);
  check('the button says so', await pressed(page) === 'true');
  check('the camera swung round by half a turn',
    Math.abs((await yawOf(page)) - (openYaw + 2 * QUARTER)) < 1e-6,
    `yaw ${openYaw.toFixed(3)} → ${(await yawOf(page)).toFixed(3)}`);
  check('and the picture is a different one',
    agreement(around, opened) < 0.85,
    `${(agreement(around, opened) * 100).toFixed(0)}% of the opening outline`);

  console.log('\nreframed');
  await page.click('#reset-view');
  await page.waitForTimeout(400);
  check('reset keeps the model facing the way it was turned',
    Math.abs((await yawOf(page)) - (openYaw + 2 * QUARTER)) < 1e-6,
    `yaw ${(await yawOf(page)).toFixed(3)}`);
  check('and the picture with it',
    agreement(await silhouette(page), around) > 0.9);

  console.log('\nall the way round');
  await page.click('#turn-button');
  await page.click('#turn-button');
  await page.waitForTimeout(400);
  check('four quarter turns come back to none', await heading(page) === 0);
  check('the button says so too', await pressed(page) === 'false');
  check('and so does the picture',
    agreement(await silhouette(page), opened) > 0.9,
    `${(agreement(await silhouette(page), opened) * 100).toFixed(0)}% of the opening outline`);

  console.log('\nopened again tomorrow');
  await page.click('#turn-button');
  await page.waitForTimeout(300);
  await load();
  await page.selectOption('#mode-select', '3');
  await page.waitForTimeout(400);
  check('the file is remembered facing the way it was left',
    await heading(page) === 1, `heading ${await heading(page)}`);
  check('which is the view it opens on',
    Math.abs((await yawOf(page)) - (openYaw + QUARTER)) < 1e-6,
    `yaw ${(await yawOf(page)).toFixed(3)}`);
  check('and the button still says so', await pressed(page) === 'true');

  /* A mirror goes out with the export; a heading does not. Turning the camera
   * round leaves the model where the file put it, so the root node is as it
   * would have been untouched. */
  console.log('\nout through the export');
  const exportRoot = async (name) => {
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 180000 }),
      page.click('#export-gltf'),
    ]);
    const saved = path.join(path.dirname(await download.path()), name);
    await download.saveAs(saved);
    const json = readGlbJson(new Uint8Array(fs.readFileSync(saved)));
    return JSON.stringify(json.nodes[0].matrix || null);
  };
  const turnedOut = await exportRoot('turned.glb');
  await page.click('#turn-button');
  await page.click('#turn-button');
  await page.click('#turn-button');
  await page.waitForTimeout(300);
  check('back to facing no particular way', await heading(page) === 0);
  const straightOut = await exportRoot('straight.glb');
  check('what leaves is the same either way round — a heading is only a view',
    turnedOut === straightOut, `${turnedOut} vs ${straightOut}`);

  check('and nothing threw along the way', errors.length === 0, errors.join(' | '));

  await browser.close();
  console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
