/* What a surface gives off on its own — a game's `ksEmissive` and `txGlow`.
 *
 *   node web/test/emissive.js <dark.kn5> <lit.kn5> <mapped.kn5> <cold.kn5>
 *
 * A dial, a display and an LED are lit rather than pale: what makes them read
 * that way is that nothing about the room changes them, and a viewer with no
 * emissive term at all draws them as whatever paint they happen to be.
 *
 * The colour and the map are two different materials rather than two halves of
 * one. Across the 67 cars to hand, 29 materials state an emissive colour and
 * bind no map, 89 bind a map and state no colour, and not one does both — so
 * both roads are here, and each has to arrive.
 *
 * The fourth cube is the one that matters most. `txGlow` is bound almost only
 * by `ksBrakeDisc` — 36 of the 37 materials that bind it — and the level
 * beside it is the heat in the disc, which is nought in a car standing still.
 * Taken as a map to be drawn at full strength, every car in the library parks
 * with its brakes glowing.
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

/** The middle of the viewport, as [r, g, b] in 0-255. */
function sample(page) {
  return page.evaluate(() => {
    const canvas = document.getElementById('viewport');
    const gl = canvas.getContext('webgl2');
    const half = 40;
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

const grey = (rgb) => (rgb[0] + rgb[1] + rgb[2]) / 3;

async function load(page, file) {
  const before = await page.evaluate(() => window.fbxtool.loadCount);
  await page.setInputFiles('#file-input', [file]);
  await page.waitForFunction((seen) => window.fbxtool.loadCount > seen, before,
    { timeout: 120000 });
  await page.waitForTimeout(700);
  return sample(page);
}

async function main() {
  const [darkFile, litFile, mappedFile, coldFile] = process.argv.slice(2);
  if (!darkFile || !litFile || !mappedFile || !coldFile) {
    console.error('usage: node web/test/emissive.js '
      + '<dark.kn5> <lit.kn5> <mapped.kn5> <cold.kn5>');
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

  const dark = await load(page, darkFile);
  check('the plain cube is the grey its material is',
    Math.abs(dark[0] - dark[2]) < 8, `rgb(${dark})`);

  const lit = await load(page, litFile);
  /* Amber, and stated at twice white in its red — which is not a shade of
   * paint but how much brighter than the room the thing is meant to read. A
   * colour held under white on the way in arrives merely pale. */
  check('a stated emissive colour lights the surface',
    grey(lit) > grey(dark) * 1.3, `rgb(${lit}) against rgb(${dark})`);
  check('and in the colour it was stated in',
    lit[0] > lit[2] + 40, `rgb(${lit})`);

  const mapped = await load(page, mappedFile);
  check('a glow map lights it where the material states no colour',
    grey(mapped) > grey(dark) * 1.3, `rgb(${mapped}) against rgb(${dark})`);

  const cold = await load(page, coldFile);
  /* The same map, with the level beside it at nought. A brake disc binds one
   * and states its own heat, and a car standing still has none. */
  check('and a glow map at no level does not light it at all',
    Math.abs(grey(cold) - grey(dark)) <= 3, `rgb(${cold}) against rgb(${dark})`);

  check('no page errors', errors.length === 0, errors.join(' | ') || 'clean');

  await browser.close();
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
