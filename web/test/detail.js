/* The grain a surface is tiled over with — a game's `txDetail`.
 *
 *   node web/test/detail.js <plain.kn5> <grained.kn5>
 *
 * A car's interior is one atlas of flat panels with the leather, the carpet
 * and the carbon laid over them, tiled sixty or a hundred times across: the
 * picture underneath is the shape and the grain is the surface. An Audi S8 has
 * thirty-eight materials wearing one, and nine of the fifteen files in each of
 * its skins go there — so without it a skin changes the badge and the number
 * plate and leaves the cabin exactly as it was.
 *
 * What the file does not say is how much of the grain the game mixes in, and
 * the two readings are far apart. Multiplied straight, a Mercedes E63's paint
 * — whose grain averages 0.24 — turns a white car graphite. So each grain is
 * taken as neutral at its own average, in linear light, and only what differs
 * from that average shows.
 *
 * Both fixtures are the same cube wearing the same mid-grey colour map. One
 * has no grain; the other has a green one, dark and light in equal measure. So
 * the second must come out green, and must not come out darker.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const { launch } = require('./chromium');

const ROOT = path.resolve(__dirname, '..', '..');
const PAGE = path.join(ROOT, 'web', 'dist', 'fbxview.html');

let failures = 0;

function check(label, condition, detail = '') {
  if (!condition) failures++;
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? `  — ${detail}` : ''}`);
}

/** Average colour of the middle of the viewport, in 0-255. */
function sample(page) {
  return page.evaluate(() => {
    const canvas = document.getElementById('viewport');
    const gl = canvas.getContext('webgl2');
    const half = 24;
    const cx = Math.round(canvas.width / 2);
    const cy = Math.round(canvas.height / 2);
    const px = new Uint8Array(half * 2 * half * 2 * 4);
    gl.readPixels(cx - half, cy - half, half * 2, half * 2, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const total = [0, 0, 0];
    for (let i = 0; i < px.length; i += 4) {
      total[0] += px[i]; total[1] += px[i + 1]; total[2] += px[i + 2];
    }
    return total.map((v) => Math.round(v / (px.length / 4)));
  });
}

async function load(page, file) {
  const before = await page.evaluate(() => window.fbxtool.loadCount);
  await page.setInputFiles('#file-input', [file]);
  await page.waitForFunction((seen) => window.fbxtool.loadCount > seen, before,
    { timeout: 120000 });
  await page.waitForTimeout(700);
  return sample(page);
}

async function main() {
  const [plainFile, grainedFile] = process.argv.slice(2);
  if (!plainFile || !grainedFile) {
    console.error('usage: node web/test/detail.js <plain.kn5> <grained.kn5>');
    process.exit(2);
  }
  if (!fs.existsSync(PAGE)) {
    console.error(`${PAGE} is missing — run: python3 web/build.py`);
    process.exit(2);
  }

  const browser = await launch(chromium);
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto(`file://${PAGE}`);
  await page.waitForFunction(() => document.body.dataset.ready === 'true', { timeout: 20000 });

  console.log('the same cube, with and without a grain over it');
  const plain = await load(page, plainFile);
  check('the plain one is the grey its colour map is',
    Math.abs(plain[0] - plain[1]) < 8 && Math.abs(plain[1] - plain[2]) < 8, `rgb(${plain})`);

  const grained = await load(page, grainedFile);
  check('the grained one takes the cast of its grain',
    grained[1] > grained[0] * 1.25 && grained[1] > grained[2] * 1.25, `rgb(${grained})`);
  /* And is not darker for wearing one. Averaged as the file holds it rather
   * than in linear light, the divide comes out five times too small and this
   * is where it shows. */
  check('and is no darker overall than without it',
    grained[1] > plain[1] * 0.7, `rgb(${grained}) against rgb(${plain})`);
  check('no page errors', errors.length === 0, errors.join(' | ') || 'clean');

  await browser.close();
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
