/* What a Custom Shaders Patch car says its surfaces are made of.
 *
 *   node web/test/finish.js <plain-car> <polished-car> <matte-car>
 *
 * `Reflectance`, `Smoothness` and `Metalness` sit in the `[Material_*]`
 * blocks beside the model, and on a patched car they are where the material
 * actually lives: the `ks*` values still inside the `.kn5` describe the same
 * surface as it was before the author moved the description out. Read from
 * the model alone, a car is read as the car it used to be — its chrome comes
 * back as plastic and its glass as a matte panel.
 *
 * 1121 of those blocks sit beside the 135 cars to hand: 423 state a
 * smoothness, 375 a reflectance, 194 a metalness.
 *
 * Each folder here is the same cube wearing the same material, and the two
 * that carry a config differ from the first only in what that config says.
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

const near = (a, b, slack = 0.02) => Math.abs(a - b) <= slack;

/** How the one material came out, and how bright the middle of the cube is. */
async function load(page, folder) {
  const before = await page.evaluate(() => window.fbxtool.loadCount);
  await page.setInputFiles('#folder-input', [folder]);
  await page.waitForFunction((seen) => window.fbxtool.loadCount > seen, before,
    { timeout: 120000 });
  await page.waitForTimeout(800);
  return page.evaluate(() => {
    const entry = window.fbxtool.palette.find((one) => one.name === 'panel');
    const canvas = document.getElementById('viewport');
    const gl = canvas.getContext('webgl2');
    const half = 30;
    const px = new Uint8Array(half * 2 * half * 2 * 4);
    gl.readPixels(Math.round(canvas.width / 2) - half, Math.round(canvas.height / 2) - half,
      half * 2, half * 2, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let total = 0;
    for (let i = 0; i < px.length; i += 4) total += (px[i] + px[i + 1] + px[i + 2]) / 3;
    return {
      roughness: entry ? entry.roughness : null,
      metallic: entry ? entry.metallic || 0 : null,
      specular: entry ? entry.specular[0] : null,
      grey: Math.round(total / (px.length / 4)),
    };
  });
}

async function main() {
  const [plainCar, polishedCar, matteCar] = process.argv.slice(2);
  if (!plainCar || !polishedCar || !matteCar) {
    console.error('usage: node web/test/finish.js <plain-car> <polished-car> <matte-car>');
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
  /* The cube's material states a `fresnelC` of 0.05 and a specular exponent
   * that reads as half rough, and with nothing beside the car to say
   * otherwise that is what it is. */
  check('a car with nothing beside it is the material its model states',
    near(plain.specular, 0.05) && plain.metallic === 0,
    `f0 ${plain.specular}, metal ${plain.metallic}, rough ${plain.roughness}`);

  const polished = await load(page, polishedCar);
  /* Smoothness 0.95, reflectance 0.9, metalness 1 — which is chrome, and is
   * three numbers the model itself has no way of saying. */
  check('a config that says polished metal makes it polished metal',
    near(polished.roughness, 0.05) && polished.metallic === 1,
    `rough ${polished.roughness}, metal ${polished.metallic}`);
  /* And a metal reflects its own colour rather than a dielectric's four per
   * cent, which is the split the shader shades with and not something the
   * config states directly. */
  check('and reflects its own colour, not a dielectric\'s',
    polished.specular > 0.5, `f0 ${polished.specular}`);
  /* And it reaches the picture, darker rather than brighter: a metal keeps no
   * diffuse of its own, so all it has to show is what the room puts in it, and
   * this room is a dark one with the light above. A white matte cube under the
   * same light is the brighter of the two, and that is the whole difference
   * between chrome and the plastic it was being drawn as. */
  check('which reaches the picture', polished.grey < plain.grey - 20,
    `${polished.grey} against ${plain.grey}`);

  const matte = await load(page, matteCar);
  /* Smoothness 3 — past anything that means something — and a reflectance of
   * 0.02. Both are held inside the unit range on the way in. */
  check('a smoothness past one is held at one', near(matte.roughness, 0.05),
    `rough ${matte.roughness}`);
  check('and a stated reflectance stands where the model stated another',
    near(matte.specular, 0.02), `f0 ${matte.specular}`);

  check('no page errors', errors.length === 0, errors.join(' | ') || 'clean');

  await browser.close();
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
