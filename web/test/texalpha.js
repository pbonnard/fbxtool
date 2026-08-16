/* Transparency that lives in a texture rather than in a factor.
 *
 *   node web/test/texalpha.js <blend.kn5> <mask.kn5> <opaque.kn5>
 *
 * Each fixture is the same shape: a solid red cube inside a larger blue one,
 * both of them wearing a flat colour texture, and the blue one's texture is
 * three-quarters transparent. What differs is only what its material says
 * about blending, and all three answers have to be different:
 *
 *   BLEND   the alpha is the coverage — a quarter of blue over the red core
 *   MASK    tested against the threshold, and 0.25 is under 0.5, so the shell
 *           is cut away entirely and the core is seen whole
 *   OPAQUE  the alpha is not coverage at all and is ignored — solid blue
 *
 * The last is the one that matters most in practice. A racing game's light
 * housings carry an ambient-occlusion map with an alpha channel of nothing at
 * all; read as coverage on a material that never asked for it, every lamp on
 * the car disappears.
 *
 * And a fourth, where the alpha is not merely ignored but zero throughout: the
 * colour still has to arrive. Multiplied by its own alpha on the way to the
 * GPU — which is what a browser does by default and all a 2D canvas can do —
 * it does not, and a Renault 5 Turbo whose seats, carpet and dashboard are all
 * `.dds` files with an empty alpha channel comes out as a black car.
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

/** Average colour of a square of canvas pixels, in 0-255. */
function sample(page, half) {
  return page.evaluate((size) => {
    const canvas = document.getElementById('viewport');
    const gl = canvas.getContext('webgl2');
    const cx = Math.round(canvas.width / 2);
    const cy = Math.round(canvas.height / 2);
    const pixels = new Uint8Array(size * size * 4 * 4);
    gl.readPixels(cx - size, cy - size, size * 2, size * 2,
      gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    const total = [0, 0, 0];
    for (let i = 0; i < pixels.length; i += 4) {
      total[0] += pixels[i]; total[1] += pixels[i + 1]; total[2] += pixels[i + 2];
    }
    const count = pixels.length / 4;
    return total.map((v) => Math.round(v / count));
  }, half);
}

async function load(page, file) {
  const before = await page.evaluate(() => window.fbxtool.loadCount);
  await page.setInputFiles('#file-input', [file]);
  await page.waitForFunction((seen) => window.fbxtool.loadCount > seen, before,
    { timeout: 120000 });
  await page.waitForTimeout(600);
  return {
    colour: await sample(page, 24),
    blended: await page.evaluate(() => window.fbxtool.viewer.transparentMaterials),
    layers: await page.evaluate(() => window.fbxtool.viewer.textureLayers),
  };
}

async function main() {
  const [blendFile, maskFile, opaqueFile, emptyFile] = process.argv.slice(2);
  if (!blendFile || !maskFile || !opaqueFile || !emptyFile) {
    console.error('usage: node web/test/texalpha.js '
      + '<blend.kn5> <mask.kn5> <opaque.kn5> <empty-alpha.kn5>');
    process.exit(2);
  }
  if (!fs.existsSync(PAGE)) {
    console.error(`${PAGE} is missing — run: python3 web/build.py`);
    process.exit(2);
  }

  const browser = await launch(chromium);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto(`file://${PAGE}`);
  await page.waitForFunction(() => document.body.dataset.ready === 'true', { timeout: 20000 });

  console.log('a shell whose material says it is blended');
  const blend = await load(page, blendFile);
  check('both textures decoded', blend.layers === 2, `${blend.layers} layer(s)`);
  check('the shell is drawn in the blended pass', blend.blended === 1,
    `${blend.blended} blended material(s)`);
  check('the core shows through it', blend.colour[0] > blend.colour[2],
    `rgb(${blend.colour})`);
  check('the shell is still there over it', blend.colour[2] > 12, `rgb(${blend.colour})`);

  console.log('\nthe same shell, cut out against the same alpha');
  const mask = await load(page, maskFile);
  check('nothing is drawn blended', mask.blended === 0,
    `${mask.blended} blended material(s)`);
  check('the shell is cut away below the threshold',
    mask.colour[0] > mask.colour[2] * 4, `rgb(${mask.colour})`);

  console.log('\nthe same shell again, saying nothing about blending');
  const opaque = await load(page, opaqueFile);
  check('nothing is drawn blended', opaque.blended === 0,
    `${opaque.blended} blended material(s)`);
  check('the alpha is ignored and the shell is solid',
    opaque.colour[2] > opaque.colour[0] * 4, `rgb(${opaque.colour})`);

  console.log('');
  console.log('and one whose alpha channel is empty from end to end');
  const empty = await load(page, emptyFile);
  check('nothing is drawn blended', empty.blended === 0,
    `${empty.blended} blended material(s)`);
  check('the colour survives being multiplied by nothing',
    empty.colour[2] > 60 && empty.colour[2] > empty.colour[0] * 4, `rgb(${empty.colour})`);

  check('no page errors', errors.length === 0, errors.join(' | ') || 'clean');

  await browser.close();
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
