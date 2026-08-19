/* What a car's config takes away, and what it restates about a material.
 *
 *   node web/test/replace.js <plain-car> <hidden-car> <restated-car> <skin-car>
 *
 * Two sections that describe the car rather than a skin's paint. A model
 * replacement's `HIDE` takes meshes away — a number plate a livery does not
 * want is the commonest thing in them, and 77 of the 101 across the 135 cars
 * to hand are written in a skin, so it has to follow the skin without the
 * scene being built again. A shader replacement restates a material in the
 * very numbers the model itself states, so what it says has to arrive as
 * though the model had said it.
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

/** The middle of the viewport, and what the one material came out as. */
function look(page) {
  return page.evaluate(() => {
    const canvas = document.getElementById('viewport');
    const gl = canvas.getContext('webgl2');
    const half = 30;
    const px = new Uint8Array(half * 2 * half * 2 * 4);
    gl.readPixels(Math.round(canvas.width / 2) - half, Math.round(canvas.height / 2) - half,
      half * 2, half * 2, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let total = 0;
    for (let i = 0; i < px.length; i += 4) total += (px[i] + px[i + 1] + px[i + 2]) / 3;
    const entry = window.fbxtool.palette.find((one) => one.name === 'panel');
    return {
      grey: Math.round(total / (px.length / 4)),
      hidden: window.fbxtool.partTable.filter((one) => one.hidden).map((one) => one.name),
      colour: entry ? Math.round(entry.colour[0] * 1000) / 1000 : null,
      roughness: entry ? Math.round(entry.roughness * 1000) / 1000 : null,
    };
  });
}

async function load(page, folder) {
  const before = await page.evaluate(() => window.fbxtool.loadCount);
  await page.setInputFiles('#folder-input', [folder]);
  await page.waitForFunction((seen) => window.fbxtool.loadCount > seen, before,
    { timeout: 120000 });
  await page.waitForTimeout(900);
  return look(page);
}

async function main() {
  const [plainCar, hiddenCar, restatedCar, skinCar] = process.argv.slice(2);
  if (!plainCar || !hiddenCar || !restatedCar || !skinCar) {
    console.error('usage: node web/test/replace.js '
      + '<plain-car> <hidden-car> <restated-car> <skin-car>');
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

  const plain = await load(page, plainCar);
  check('a car with nothing said about it draws its one mesh',
    plain.grey > 60 && plain.hidden.length === 0, `${plain.grey}, hidden ${plain.hidden}`);

  const gone = await load(page, hiddenCar);
  check('a mesh the config hides is not drawn',
    gone.hidden.join() === 'panel' && gone.grey < 20,
    `${gone.grey} against ${plain.grey}, hidden ${gone.hidden}`);

  const said = await load(page, restatedCar);
  /* The model says its material takes a fifth of the light and is nearly a
   * mirror; the config says two-thirds and blunt. What arrives has to be the
   * config's, in both — it is the same statement written in the other file. */
  check('and a material the config restates arrives restated',
    said.colour > plain.colour + 0.2 && said.roughness > plain.roughness + 0.2,
    `colour ${said.colour} against ${plain.colour}, `
    + `roughness ${said.roughness} against ${plain.roughness}`);

  /* And a hide written in a skin follows the skin, which is where three out
   * of four of them are written. */
  const bare = await load(page, skinCar);
  check('a car whose skin is not on keeps the mesh that skin hides',
    bare.hidden.length === 0, `hidden ${bare.hidden}`);
  await page.selectOption('#skin-select', 'Plain');
  await page.waitForTimeout(900);
  const worn = await look(page);
  check('and loses it when the skin goes on',
    worn.hidden.join() === 'panel' && worn.grey < 20,
    `${worn.grey}, hidden ${worn.hidden}`);
  await page.selectOption('#skin-select', '');
  await page.waitForTimeout(900);
  const off = await look(page);
  check('and has it back when the skin comes off',
    off.hidden.length === 0 && off.grey > 60, `${off.grey}, hidden ${off.hidden}`);

  check('no page errors', errors.length === 0, errors.join(' | ') || 'clean');

  await browser.close();
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
