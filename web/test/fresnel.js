/* The Fresnel a game's material states, held against the one it is drawn with.
 *
 *   node web/test/fresnel.js <broad.kn5> <dull.kn5> <open.kn5> <capped.kn5>
 *
 * Schlick's term is one shape: a base at nothing rising to a mirror over a
 * fifth power. A `.kn5` writes both of those numbers loose — `fresnelEXP` for
 * how fast the reflection comes up as the surface turns away, and
 * `fresnelMaxLevel` for how far it is let get — and read as a base alone the
 * other two are simply lost.
 *
 * Both directions matter and both are here, each as a pair of cubes differing
 * in one number and nothing else.
 *
 * The exponent is the direction a car shows. A Jaguar Mk2's paint states a
 * base of nought, an exponent of a half and a ceiling of a quarter: a body
 * reflecting a quarter of the room from every angle but dead head-on. Taken as
 * its base alone it is nought — a matte panel — which is what its four skins
 * drew. 1428 of the 3427 materials across the 67 cars to hand state a base of
 * nought, so it is not one car's spelling.
 *
 * The ceiling is the other direction, and the commoner one: the median ceiling
 * across those same materials is 0.1, so rising to a mirror at a grazing angle
 * is the thing most of them spent a number saying they do not do.
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

/** How bright the middle of the viewport is, 0-255, averaged over the cube. */
function sample(page) {
  return page.evaluate(() => {
    const canvas = document.getElementById('viewport');
    const gl = canvas.getContext('webgl2');
    const half = 40;
    const cx = Math.round(canvas.width / 2);
    const cy = Math.round(canvas.height / 2);
    const px = new Uint8Array(half * 2 * half * 2 * 4);
    gl.readPixels(cx - half, cy - half, half * 2, half * 2, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let total = 0;
    for (let i = 0; i < px.length; i += 4) {
      total += (px[i] + px[i + 1] + px[i + 2]) / 3;
    }
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
  const [broadFile, dullFile, openFile, cappedFile] = process.argv.slice(2);
  if (!broadFile || !dullFile || !openFile || !cappedFile) {
    console.error('usage: node web/test/fresnel.js '
      + '<broad.kn5> <dull.kn5> <open.kn5> <capped.kn5>');
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

  console.log('how fast the reflection comes up — fresnelEXP');
  /* The two cubes state the same base of nought and the same ceiling of a
   * quarter, and differ only in how quickly they get there. A half is the
   * Jaguar's, and reaches the ceiling almost at once; five is Schlick's own,
   * and over a surface facing anywhere near you it is nothing at all. Read as
   * the base alone the two are identical, which is the reading this refuses. */
  const broad = await load(page, broadFile);
  const dull = await load(page, dullFile);
  check('a shallow exponent reflects and a steep one does not',
    broad > dull * 1.2, `broad ${broad} against dull ${dull}`);

  console.log('and how far it is let get — fresnelMaxLevel');
  /* The same base under two ceilings, with an exponent of nought between
   * them — the rise at its full height from every angle, which 626 of the
   * materials to hand write and which `pow` will not answer. So one is a
   * mirror everywhere and the other is held at the base it started from, and
   * a reader that takes the base for the whole sentence draws them alike. */
  const open = await load(page, openFile);
  const capped = await load(page, cappedFile);
  check('a ceiling at the base holds the reflection down',
    capped < open * 0.7, `capped ${capped} against open ${open}`);

  /* And the one thing both halves have to leave alone: the material is a
   * dielectric either way. A reflectance is the one number that tells a metal
   * from a dielectric, and reading the ceiling as one would turn a windscreen
   * into chrome. */
  const metals = await page.evaluate(() => window.fbxtool.palette
    .filter((entry) => (entry.metallic || 0) > 0).length);
  check('and neither turns the surface into a metal', metals === 0,
    `${metals} metal(s)`);

  check('no page errors', errors.length === 0, errors.join(' | ') || 'clean');

  await browser.close();
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
