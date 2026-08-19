/* The shape that goes with a grain — a game's `txNormalDetail`.
 *
 *   node web/test/relief.js <plain.kn5> <tilted.kn5> <off.kn5>
 *
 * A grain is two maps: what colour the surface is at that scale, and what
 * shape it is. Every one of the 575 materials across the 67 cars to hand that
 * binds the second binds the first as well, and only three of them are the
 * same file — so the shape is its own picture, of the leather rather than of
 * the panel, and without it the leather is a photograph of leather on
 * something flat.
 *
 * All three cubes wear the same colour map and the same grain. The second
 * carries a relief for that grain which tilts the whole surface one way, so
 * what it does shows in how the sun catches it; the third carries the same
 * relief at a blend of nought, which 53 of those 575 materials write and which
 * has to come back indistinguishable from carrying none.
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

function sample(page) {
  return page.evaluate(() => {
    const canvas = document.getElementById('viewport');
    const gl = canvas.getContext('webgl2');
    const half = 36;
    const px = new Uint8Array(half * 2 * half * 2 * 4);
    gl.readPixels(Math.round(canvas.width / 2) - half, Math.round(canvas.height / 2) - half,
      half * 2, half * 2, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let total = 0;
    for (let i = 0; i < px.length; i += 4) total += (px[i] + px[i + 1] + px[i + 2]) / 3;
    return Math.round(total / (px.length / 4));
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
  const [plainFile, tiltedFile, offFile] = process.argv.slice(2);
  if (!plainFile || !tiltedFile || !offFile) {
    console.error('usage: node web/test/relief.js <plain.kn5> <tilted.kn5> <off.kn5>');
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

  const plain = await load(page, plainFile);
  const tilted = await load(page, tiltedFile);
  check('the grain\'s own relief turns the surface it is on',
    Math.abs(tilted - plain) > 6, `${tilted} against ${plain}`);

  const off = await load(page, offFile);
  check('and a relief the file blends at nothing does nothing',
    Math.abs(off - plain) <= 1, `${off} against ${plain}`);

  check('no page errors', errors.length === 0, errors.join(' | ') || 'clean');

  await browser.close();
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
