/* Which way up a texture reaches the GPU, and whether its colour survives.
 *
 *   node web/test/texorient.js
 *
 * FBX texture space has V running upwards, so the first row of a texture — the
 * one sampled at V=0 — has to be the *bottom* row of the picture. The viewer
 * turns each image over on the way in rather than in the shader, so the UVs
 * stay as the file wrote them.
 *
 * That turn is easy to lose without anything saying so. `UNPACK_FLIP_Y_WEBGL`
 * is what a canvas or an ImageData upload obeys, and an `ImageBitmap` ignores
 * it in silence — no error, no warning, every texture on the car upside down
 * and nothing but a look at the screen to tell you. A model is a poor witness
 * for this: a car's UV islands are scattered over the sheet, so a flip moves
 * the paint about rather than turning the car over, and it reads as some other
 * fault entirely.
 *
 * So this asks the array texture directly, through the viewer's own upload,
 * with a picture that cannot be mistaken either way up — and with an alpha
 * channel of nothing, since a colour multiplied by that is lost before it is
 * ever drawn.
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

async function main() {
  if (!fs.existsSync(PAGE)) {
    console.error(`${PAGE} is missing — run: python3 web/build.py`);
    process.exit(2);
  }
  const browser = await launch(chromium);
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto(`file://${PAGE}`);
  await page.waitForFunction(() => document.body.dataset.ready === 'true', { timeout: 20000 });

  const result = await page.evaluate(async () => {
    const width = 8;
    const height = 8;
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const at = (y * width + x) * 4;
        const top = y < height / 2;
        rgba[at] = top ? 220 : 20;          // red at the top, blue at the bottom
        rgba[at + 1] = 0;
        rgba[at + 2] = top ? 20 : 220;
        rgba[at + 3] = 0;                   // and nothing at all in the alpha
      }
    }
    const image = await createImageBitmap(new ImageData(rgba, width, height),
      { premultiplyAlpha: 'none' });

    const { viewer } = window.fbxtool;
    await viewer.setTextures([image], 32);

    const gl = viewer.gl;
    const frame = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, frame);
    gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0,
      viewer.textureArray, 0, 0);
    const read = (row) => {
      const px = new Uint8Array(4);
      gl.readPixels(0, row, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return Array.from(px);
    };
    // Row 0 of a GL texture is the one sampled at V=0.
    const out = { atV0: read(0), atV1: read(31), error: gl.getError() };
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return out;
  });

  console.log('an eight-square, red over blue, with an empty alpha channel');
  check('V=0 samples the bottom of the picture', result.atV0[2] > result.atV0[0],
    `rgba(${result.atV0})`);
  check('V=1 samples the top of it', result.atV1[0] > result.atV1[2],
    `rgba(${result.atV1})`);
  check('the colour survived an alpha of nothing',
    Math.max(result.atV0[0], result.atV0[2]) > 150, `rgba(${result.atV0})`);
  check('the alpha is still what it was', result.atV0[3] === 0, `rgba(${result.atV0})`);
  check('no GL error', result.error === 0, String(result.error));
  check('no page errors', errors.length === 0, errors.join(' | ') || 'clean');

  await browser.close();
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
