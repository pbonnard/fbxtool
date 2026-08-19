/* A surface drawn from behind its own normal.
 *
 *   node web/test/facing.js <out.kn5> <in.kn5>
 *
 * Two cubes wound the same way and coloured the same black, differing only in
 * which way their normals point. The one facing outward shows what a black
 * surface shows: almost nothing. The one facing inward used to show the whole
 * room — the angle to the eye is past a right angle, and clamped back to
 * something a cosine will take it becomes exactly grazing, which is where a
 * Fresnel term goes to a mirror.
 *
 * A whole model at a time, too. A Smart Roadster out of a file converter
 * states every normal the wrong way about, and drew its 28 colours as one
 * pale grey with its near-black tyres among them.
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

async function load(page, file) {
  const before = await page.evaluate(() => window.fbxtool.loadCount);
  await page.setInputFiles('#file-input', [file]);
  await page.waitForFunction((seen) => window.fbxtool.loadCount > seen, before,
    { timeout: 120000 });
  await page.waitForTimeout(700);
  return page.evaluate(() => {
    const canvas = document.getElementById('viewport');
    const gl = canvas.getContext('webgl2');
    const half = 34;
    const px = new Uint8Array(half * 2 * half * 2 * 4);
    gl.readPixels(Math.round(canvas.width / 2) - half, Math.round(canvas.height / 2) - half,
      half * 2, half * 2, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let total = 0;
    for (let i = 0; i < px.length; i += 4) total += (px[i] + px[i + 1] + px[i + 2]) / 3;
    return Math.round(total / (px.length / 4));
  });
}

async function main() {
  const [outFile, inFile] = process.argv.slice(2);
  if (!outFile || !inFile) {
    console.error('usage: node web/test/facing.js <out.kn5> <in.kn5>');
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

  const outward = await load(page, outFile);
  check('a black surface facing the eye shows almost nothing',
    outward < 40, `${outward}`);

  const inward = await load(page, inFile);
  check('and one facing away shows no more than it does',
    inward < outward + 12, `${inward} against ${outward}`);

  check('no page errors', errors.length === 0, errors.join(' | ') || 'clean');

  await browser.close();
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
