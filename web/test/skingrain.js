/* The flat detail map a skin brings, which on some cars is the whole paint.
 *
 *   node web/test/skingrain.js <folder holding a .kn5 and skins/>
 *
 * A detail map is normally a grain — where the surface is lighter or darker
 * than itself, tiled dozens of times across a panel — and one that is a single
 * colour from corner to corner is no grain at all. A third of the detail maps
 * in the cars to hand are that, the slot filled in and never authored, and
 * drawn as grains the saturated ones repaint whatever wears them: a Jaguar Mk2
 * names a sixteen-pixel square of pure red and its four skins are a red one
 * and three in pale green. So they are refused.
 *
 * Except that a BMW Z3 states its paint in one and in nothing else. It carries
 * no `cm_skin.json`; its `extension/ext_config.ini` names `body` as the paint
 * and gives seven `[Material_CarPaint*]` sections keyed by skin that state
 * clear coat, fresnel and flakes and not one colour. `body` is a
 * `ksPerPixelMultiMap` over one grey ambient-occlusion sheet all thirteen
 * skins share byte for byte, and what changes between them is the
 * `metal_detail.dds` each lays over it — six of which are a single repeated
 * block: pure red for Hellrot, black for Schwarz, #cdae29 for Dakargelb.
 * Refused with the rest, all six draw the white of the sheet underneath.
 *
 * Which is the whole question here: where a flat picture came from is what
 * says what it is. The car's own is the same picture under every skin it has
 * and cannot be the thing that tells them apart. One the worn skin carries is
 * the one thing that changes when the skin does, which is what the paint is.
 *
 * The fixture is a cube wearing a grey panel map, a flat blue detail map of
 * the car's own, and two skins:
 *
 *   Rot     brings a flat red detail map and nothing else, and must paint
 *   Weiss   brings the panel map back and no detail map, so the car's own
 *           flat blue is still all there is and must still be refused
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

async function wear(page, name) {
  await page.selectOption('#skin-select', name);
  await page.waitForTimeout(900);
  return sample(page);
}

/** What the palette says the body does with its detail map. */
function grainOf(page) {
  return page.evaluate(() => {
    const entry = window.fbxtool.palette.find((m) => m.name === 'body');
    return entry ? { layer: entry.detailLayer, tiling: entry.detailTiling } : null;
  });
}

async function main() {
  const [folder] = process.argv.slice(2);
  if (!folder) {
    console.error('usage: node web/test/skingrain.js <folder>');
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

  const before = await page.evaluate(() => window.fbxtool.loadCount);
  await page.setInputFiles('#folder-input', folder);
  await page.waitForFunction((seen) => window.fbxtool.loadCount > seen, before,
    { timeout: 180000 });
  await page.waitForTimeout(900);

  console.log('the car as the file has it');
  const bare = await sample(page);
  /* Grey, and not the blue of the picture the car names. A flat map of the
   * car's own is the slot filled in and never authored, and drawn it would
   * paint every skin the same colour — which is the thing all of this is for
   * refusing. */
  check('a flat map the car itself carries is refused',
    Math.abs(bare[0] - bare[2]) < 12 && Math.abs(bare[1] - bare[2]) < 12,
    `rgb(${bare})`);
  const refused = await grainOf(page);
  check('and the tiling goes with it, so nothing bakes it into an export',
    refused && refused.layer === -1 && refused.tiling === 0,
    JSON.stringify(refused));

  console.log('\nwearing the skin that brings one of its own');
  const rot = await wear(page, 'Rot');
  check('a flat map the skin brings is the paint',
    rot[0] > rot[1] * 1.5 && rot[0] > rot[2] * 1.5, `rgb(${rot})`);
  check('and is brighter for it, not darker', rot[0] > bare[0] * 1.2,
    `rgb(${rot}) against rgb(${bare})`);
  const kept = await grainOf(page);
  check('and it is kept with its tiling, so an export carries it too',
    kept && kept.layer >= 0 && kept.tiling > 0, JSON.stringify(kept));

  console.log('\nwearing the skin that brings none');
  const weiss = await wear(page, 'Weiss');
  /* The car's own flat blue is all there is again, and it is refused again —
   * a skin that says nothing about the grain does not make the car's own
   * placeholder into a paint. */
  check('the car\'s own flat map is still refused under another skin',
    [0, 1, 2].every((k) => Math.abs(weiss[k] - bare[k]) <= 10),
    `rgb(${weiss}) against rgb(${bare})`);

  console.log('\nand with the skin taken off again');
  const off = await wear(page, '');
  check('the car is what it was', [0, 1, 2].every((k) => Math.abs(off[k] - bare[k]) <= 10),
    `rgb(${off}) against rgb(${bare})`);

  check('no page errors', errors.length === 0, errors.join(' | ') || 'clean');

  await browser.close();
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
