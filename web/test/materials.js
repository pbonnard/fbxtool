/* The material list: grouping, editing, highlighting and remembering.
 *
 *   node web/test/materials.js <scene_parts.fbx>
 *
 * The fixture is one cube instanced by three models that share a single
 * material, so the render palette has three slots which are really one
 * material — the case the list has to group back together, and the case where
 * one edit has to reach every slot.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..', '..');
const PAGE = path.join(ROOT, 'web', 'dist', 'fbxview.html');

/* Three points that sit on the model, found by probing the default view. */
const ON_MODEL = [[0.30, 0.45], [0.40, 0.55], [0.65, 0.60]];

let failures = 0;

function check(label, condition, detail = '') {
  if (!condition) failures++;
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? `  — ${detail}` : ''}`);
}

/** The colour at each of the model points, averaged over a small window. */
function samples(page) {
  return page.evaluate((points) => {
    const canvas = document.getElementById('viewport');
    const gl = canvas.getContext('webgl2');
    const half = 5;
    return points.map(([fx, fy]) => {
      const size = half * 2;
      const pixels = new Uint8Array(size * size * 4);
      gl.readPixels(Math.round(canvas.width * fx) - half,
        Math.round(canvas.height * (1 - fy)) - half,
        size, size, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      const total = [0, 0, 0];
      for (let i = 0; i < pixels.length; i += 4) {
        total[0] += pixels[i]; total[1] += pixels[i + 1]; total[2] += pixels[i + 2];
      }
      return total.map((v) => Math.round(v / (pixels.length / 4)));
    });
  }, ON_MODEL);
}

const allRedder = (list) => list.every(([r, , b]) => r > b + 25);
const allBluer = (list) => list.every(([r, , b]) => b > r + 25);
const show = (list) => list.map((c) => `rgb(${c.join(',')})`).join(' ');

async function load(page, file) {
  const before = await page.evaluate(() => window.fbxtool.loadCount);
  await page.setInputFiles('#file-input', [file]);
  await page.waitForFunction((seen) => window.fbxtool.loadCount > seen, before,
    { timeout: 120000 });
  await page.waitForTimeout(400);
}

async function main() {
  const target = process.argv[2];
  if (!target) {
    console.error('usage: node web/test/materials.js <scene_parts.fbx>');
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
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`file://${PAGE}`);
  await page.waitForFunction(() => document.body.dataset.ready === 'true', { timeout: 20000 });
  await page.evaluate(() => { try { localStorage.clear(); } catch (e) { /* file:// */ } });

  await load(page, target);
  await page.click('.tab[data-target="tab-materials"]');
  const row = '.material[data-key="paint"]';

  console.log('grouping');
  const grouped = await page.evaluate(() => ({
    groups: window.fbxtool.materials.length,
    slots: window.fbxtool.palette.length,
    spread: window.fbxtool.materials[0].slots.length,
    share: window.fbxtool.materials[0].share,
    status: document.getElementById('materials-status').textContent,
    rows: document.querySelectorAll('.material').length,
  }));
  check('three slots are one material', grouped.groups === 1 && grouped.slots === 3,
    `${grouped.slots} slots, ${grouped.groups} material`);
  check('the material knows its slots', grouped.spread === 3);
  check('it covers the whole model', Math.abs(grouped.share - 1) < 1e-6);
  check('the list shows one row', grouped.rows === 1, grouped.status);

  console.log('\nediting');
  const before = await samples(page);
  check('the file colour is on screen', allRedder(before), show(before));

  await page.click(`${row} > summary`);
  await page.fill(`${row} input[type="color"]`, '#1b3f8b');
  await page.waitForTimeout(300);
  const edited = await page.evaluate(() => window.fbxtool.palette.map((e) => e.colour));
  check('every slot took the new colour',
    edited.length === 3 && edited.every((c) => c[2] > c[0] * 2),
    edited.map((c) => c.map((v) => v.toFixed(3)).join('/')).join('  '));
  // The pointer is still over the row, which marks the material — read the
  // painted colour with it out of the way.
  await page.mouse.move(10, 10);
  await page.waitForTimeout(300);
  const painted = await samples(page);
  check('and the model is painted with it', allBluer(painted), show(painted));

  await page.fill(`${row} input[data-field="roughness"]`, '0.9');
  await page.fill(`${row} input[data-field="opacity"]`, '0.4');
  await page.waitForTimeout(200);
  const finish = await page.evaluate(() => ({
    roughness: window.fbxtool.palette.map((e) => e.roughness),
    opacity: window.fbxtool.palette.map((e) => e.opacity),
    seeThrough: window.fbxtool.viewer.transparentMaterials,
    info: document.getElementById('mesh-info').textContent,
  }));
  check('roughness reaches every slot', finish.roughness.every((v) => Math.abs(v - 0.9) < 1e-6));
  check('opacity too, and the viewer notices',
    finish.opacity.every((v) => Math.abs(v - 0.4) < 1e-6) && finish.seeThrough === 3,
    finish.info);

  console.log('\nhighlighting');
  await page.hover(`${row} > summary`);
  await page.waitForTimeout(300);
  const marked = await samples(page);
  check('hovering a row marks it on the model', allRedder(marked), show(marked));
  const highlight = await page.evaluate(() => window.fbxtool.viewer.highlight);
  check('the viewer holds the group index', highlight === 0, String(highlight));
  await page.mouse.move(10, 10);
  await page.waitForTimeout(300);
  const unmarked = await samples(page);
  check('moving away puts it back', allBluer(unmarked), show(unmarked));

  console.log('\nsaving and restoring');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#materials-save'),
  ]);
  // A download lands under a temporary name; the extension is what marks it
  // as an assignment when it goes back in.
  const savedPath = path.join(path.dirname(await download.path()), 'assignment.json');
  await download.saveAs(savedPath);
  const saved = JSON.parse(fs.readFileSync(savedPath, 'utf8'));
  check('the assignment saves as JSON',
    saved.fbxtoolMaterials === 1 && Math.abs(saved.materials.paint.opacity - 0.4) < 1e-6,
    Object.keys(saved.materials || {}).join(', '));

  await page.click(`${row} button[data-action="reset"]`);
  await page.waitForTimeout(300);
  const restored = await samples(page);
  check('"From file" puts the material back', allRedder(restored), show(restored));
  check('and the assignment is dropped',
    await page.evaluate(() => Object.keys(window.fbxtool.overrides).length) === 0);

  // Applying a saved assignment is a drop, like any other companion file.
  await page.setInputFiles('#file-input', [savedPath]);
  await page.waitForTimeout(400);
  const reapplied = await samples(page);
  check('dropping the JSON back in applies it', allBluer(reapplied), show(reapplied));

  // Re-opening the model picks the assignment up from storage.
  await load(page, target);
  const remembered = await samples(page);
  const stored = await page.evaluate(() => Object.keys(window.fbxtool.overrides));
  check('re-opening the file remembers it', allBluer(remembered),
    `${show(remembered)} · overrides: ${stored.join(', ') || 'none'}`);

  await page.click('.tab[data-target="tab-materials"]');
  await page.click('#materials-clear');
  await page.waitForTimeout(300);
  const cleared = await samples(page);
  check('"Clear all" returns the whole file', allRedder(cleared), show(cleared));

  check('no page errors', errors.length === 0, errors.join(' | ') || 'clean');

  await browser.close();
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
