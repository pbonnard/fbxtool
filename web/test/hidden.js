/* Geometry a file switched off, and whether the page draws it.
 *
 *   node web/test/hidden.js <switched.kn5>
 *
 * A scene is not only the geometry it holds: it is the geometry it holds
 * *switched on*. An Assetto Corsa car ships with its own spares — a shattered
 * windscreen behind the clear one, a blurred disc inside each wheel, a
 * low-detail cockpit inside the real one — every one of them switched off
 * until the game wants it. Drawn anyway, a Mercedes comes out with cracked
 * glass in every window and two cockpits.
 *
 * The fixture holds three triangles: one drawn, one on a mesh the file marks
 * invisible, and one under a node the file marks inactive — which is how the
 * four blurred wheels are switched off, a node at a time, rather than mesh by
 * mesh. Only the first should reach the screen.
 */
'use strict';

const fs = require('fs');
const path = require('path');
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
  const target = process.argv[2];
  if (!target) {
    console.error('usage: node web/test/hidden.js <switched.kn5>');
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

  const before = await page.evaluate(() => window.fbxtool.loadCount);
  await page.setInputFiles('#file-input', [target]);
  await page.waitForFunction((seen) => window.fbxtool.loadCount > seen, before,
    { timeout: 120000 });
  await page.waitForTimeout(500);

  const result = await page.evaluate(() => ({
    format: window.fbxtool.doc.format,
    meshes: window.fbxtool.doc.extra.meshes,
    hidden: window.fbxtool.doc.extra.hiddenMeshes,
    inactive: window.fbxtool.doc.extra.inactiveNodes,
    parts: window.fbxtool.parts,
    triangles: window.fbxtool.viewer.triangleCount,
  }));

  console.log('what the file holds, and what is drawn');
  check('read as a kn5', result.format === 'kn5');
  check('all three meshes are in the file', result.meshes === 3,
    `${result.meshes} mesh(es)`);
  check('the file says one mesh is invisible', result.hidden === 1);
  check('the file says one node is inactive', result.inactive === 1);
  check('only the drawn part is a part', result.parts === 1, `${result.parts} part(s)`);
  check('only its triangle is drawn', result.triangles === 1,
    `${result.triangles} triangle(s)`);
  check('no page errors', errors.length === 0, errors.join(' | ') || 'clean');

  await browser.close();
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
