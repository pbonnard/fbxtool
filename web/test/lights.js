/* A car's own lamps, and the switch that turns them on.
 *
 *   node web/test/lights.js <lamp-car> <plain-car>
 *
 * A car's lighting config names meshes rather than materials: one lamp
 * housing wears the same red plastic as the next and they are told to light up
 * differently. 56 of the 135 cars to hand carry those sections, and they are
 * the whole of what makes a lamp read as a lamp rather than as red plastic.
 *
 * The switch is offered only where the car brought a config that says what its
 * lights are, and it starts off — a car photographed in a showroom has its
 * lamps dark, and lighting them is a thing to ask for.
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
    const half = 40;
    const px = new Uint8Array(half * 2 * half * 2 * 4);
    gl.readPixels(Math.round(canvas.width / 2) - half, Math.round(canvas.height / 2) - half,
      half * 2, half * 2, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const total = [0, 0, 0];
    for (let i = 0; i < px.length; i += 4) {
      total[0] += px[i]; total[1] += px[i + 1]; total[2] += px[i + 2];
    }
    return total.map((v) => Math.round(v / (px.length / 4)));
  });
}

const grey = (rgb) => (rgb[0] + rgb[1] + rgb[2]) / 3;

async function load(page, folder) {
  const before = await page.evaluate(() => window.fbxtool.loadCount);
  await page.setInputFiles('#folder-input', [folder]);
  await page.waitForFunction((seen) => window.fbxtool.loadCount > seen, before,
    { timeout: 120000 });
  await page.waitForTimeout(800);
}

async function main() {
  const [lampCar, plainCar] = process.argv.slice(2);
  if (!lampCar || !plainCar) {
    console.error('usage: node web/test/lights.js <lamp-car> <plain-car>');
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

  await load(page, plainCar);
  check('a car that brought no lighting config is offered no switch',
    await page.evaluate(() => document.getElementById('lights-label').hidden));

  await load(page, lampCar);
  check('and one that did is offered one',
    await page.evaluate(() => !document.getElementById('lights-label').hidden));
  check('which starts off',
    await page.evaluate(() => !document.getElementById('lights-toggle').checked));

  const off = await sample(page);
  await page.check('#lights-toggle');
  await page.waitForTimeout(700);
  const on = await sample(page);

  check('the lamp is brighter with the lights on',
    grey(on) > grey(off) * 1.4, `rgb(${on}) against rgb(${off})`);
  /* And in the colour the config states rather than the colour of the plastic:
   * the mesh wears a plain grey map and the section says red. */
  check('and in the colour the config states', on[0] > on[2] + 40, `rgb(${on})`);
  /* The unlit colour is stated too, at a twentieth of the lit one, so the
   * lamp is not simply black with the switch off. */
  check('and sits at the unlit colour rather than at nothing',
    off[0] > off[2] + 4, `rgb(${off})`);

  await page.uncheck('#lights-toggle');
  await page.waitForTimeout(700);
  const back = await sample(page);
  check('and goes out again', Math.abs(grey(back) - grey(off)) <= 2,
    `rgb(${back}) against rgb(${off})`);

  check('no page errors', errors.length === 0, errors.join(' | ') || 'clean');

  await browser.close();
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
