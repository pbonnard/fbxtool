/* Does the viewer actually draw through a transparent material?
 *
 *   node web/test/transparency.js <glass.fbx>
 *
 * The fixture is a solid red cube inside a larger, mostly see-through blue
 * one. If the blended pass is missing or drawn in the wrong order, the shell
 * hides the core and the middle of the viewport comes back blue — so reading
 * the pixels there settles it.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..', '..');
const PAGE = path.join(ROOT, 'web', 'dist', 'fbxview.html');

let failures = 0;

function check(label, condition, detail = '') {
  if (!condition) failures++;
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? `  — ${detail}` : ''}`);
}

/** Average colour of a square of canvas pixels, in 0-255. */
async function sample(page, fx, fy, halfSize) {
  return page.evaluate(({ x, y, half }) => {
    const canvas = document.getElementById('viewport');
    const gl = canvas.getContext('webgl2');
    const cx = Math.round(canvas.width * x);
    // readPixels counts from the bottom, the page from the top.
    const cy = Math.round(canvas.height * (1 - y));
    const size = half * 2;
    const pixels = new Uint8Array(size * size * 4);
    gl.readPixels(cx - half, cy - half, size, size, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    const total = [0, 0, 0];
    for (let i = 0; i < pixels.length; i += 4) {
      total[0] += pixels[i]; total[1] += pixels[i + 1]; total[2] += pixels[i + 2];
    }
    const count = pixels.length / 4;
    return total.map((v) => Math.round(v / count));
  }, { x: fx, y: fy, half: halfSize });
}

async function load(page, file) {
  const before = await page.evaluate(() => window.fbxtool.loadCount);
  await page.setInputFiles('#file-input', [file]);
  await page.waitForFunction((seen) => window.fbxtool.loadCount > seen, before,
    { timeout: 120000 });
  await page.waitForTimeout(500);
}

async function main() {
  const target = process.argv[2];
  if (!target) {
    console.error('usage: node web/test/transparency.js <glass.fbx>');
    process.exit(2);
  }
  if (!fs.existsSync(PAGE)) {
    console.error(`${PAGE} is missing — run: python3 web/build.py`);
    process.exit(2);
  }

  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto(`file://${PAGE}`);
  await page.waitForFunction(() => document.body.dataset.ready === 'true', { timeout: 20000 });

  await load(page, target);

  const state = await page.evaluate(() => ({
    triangles: window.fbxtool.viewer.triangleCount,
    transparent: window.fbxtool.viewer.transparentMaterials,
    hasTransparency: window.fbxtool.viewer.hasTransparency,
    info: document.getElementById('mesh-info').textContent,
  }));
  console.log('transparency');
  check('the file loaded', state.triangles === 24, `${state.triangles} triangles`);
  check('one material is see-through', state.transparent === 1 && state.hasTransparency,
    `${state.transparent} of 2`);
  check('the viewport says so', /see-through/.test(state.info), state.info);

  // The middle of the canvas is the core, seen through two sheets of glass.
  const core = await sample(page, 0.5, 0.5, 12);
  check('the core shows through the shell', core[0] > core[2] + 20,
    `centre rgb(${core.join(', ')})`);

  // Low on the left the shell covers background rather than the core. The
  // backdrop is a gradient, so the comparison has to be at the same height.
  const shell = await sample(page, 0.28, 0.72, 6);
  const background = await sample(page, 0.08, 0.72, 6);
  check('the shell reads as blue glass', shell[2] > shell[0] + 8,
    `shell rgb(${shell.join(', ')})`);
  check('the glass sits over the backdrop rather than replacing it',
    shell[2] > background[2] && shell[2] < background[2] + 60,
    `background rgb(${background.join(', ')})`);

  // Clay and the other shading modes have no material colours to be
  // transparent with, so they draw everything in the solid pass.
  await page.selectOption('#mode-select', '2');
  await page.waitForTimeout(400);
  const clay = await sample(page, 0.5, 0.5, 12);
  check('clay mode draws the shell solid', clay[0] > 40 && Math.abs(clay[0] - clay[2]) < 40,
    `centre rgb(${clay.join(', ')})`);

  check('no page errors', errors.length === 0, errors.join(' | ') || 'clean');

  await browser.close();
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
