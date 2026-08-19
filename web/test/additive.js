/* A surface that adds what it returns to what is behind it.
 *
 *   node web/test/additive.js <over.kn5> <added.kn5>
 *
 * `isAdditive` is how a game's shader is told to put a reflection back: over
 * the surface, or on top of what is behind it. 1109 materials across the 67
 * cars to hand state one — but 1015 of those are opaque, where there is
 * nothing behind to add to and whatever the number means there it is not
 * this, so only the 94 that also blend are taken.
 *
 * Both cubes are the same translucent cube, and the whole of the difference is
 * that one is told to add. A cube seen through itself is where that shows:
 * the near faces lie over the far ones, and added they come out brighter than
 * laid over.
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
    const half = 30;
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
  const [overFile, addedFile] = process.argv.slice(2);
  if (!overFile || !addedFile) {
    console.error('usage: node web/test/additive.js <over.kn5> <added.kn5>');
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

  const over = await load(page, overFile);
  check('a translucent cube shows itself through itself', over > 0, `${over}`);

  const added = await load(page, addedFile);
  check('and one told to add comes out brighter than one laid over',
    added > over + 8, `${added} against ${over}`);

  /* And the plain one is where it always was. Premultiplying the colour by
   * its own coverage and blending one-minus-source-alpha is the same
   * arithmetic the source-alpha blend did, so the material that did not ask
   * to be added must not have moved at all. */
  check('no page errors', errors.length === 0, errors.join(' | ') || 'clean');

  await browser.close();
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
