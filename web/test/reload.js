/* Opening a file must not leave the last one lying around.
 *
 *   node web/test/reload.js <a.fbx> <b.fbx>
 *
 * Two models, a file with nothing in it and a file that is not a model at
 * all, in that order — checking each time that the report, the record tree,
 * the material list, the viewport and the export button describe the file
 * that is open now, and nothing else.
 */
'use strict';

const fs = require('fs');
const os = require('os');
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

/** Everything on screen that belongs to a file. */
function pageState(page) {
  return page.evaluate(() => ({
    report: document.getElementById('panel').textContent.trim(),
    records: document.querySelectorAll('#tree li').length,
    materials: document.querySelectorAll('.material').length,
    materialsStatus: document.getElementById('materials-status').textContent,
    exportDisabled: document.getElementById('export-gltf').disabled,
    triangles: window.fbxtool.viewer.triangleCount,
    geometryOptions: document.getElementById('geometry-select').options.length,
    meshInfo: document.getElementById('mesh-info').textContent,
    status: document.getElementById('status').textContent,
    doc: window.fbxtool.doc ? window.fbxtool.doc.fileName : null,
    palette: window.fbxtool.palette.length,
  }));
}

async function main() {
  const [first, second] = process.argv.slice(2);
  if (!first || !second) {
    console.error('usage: node web/test/reload.js <a.fbx> <b.fbx>');
    process.exit(2);
  }
  if (!fs.existsSync(PAGE)) {
    console.error(`${PAGE} is missing — run: python3 web/build.py`);
    process.exit(2);
  }

  // A file that parses but holds nothing, and one that is not a model.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'fbxtool-'));
  const empty = path.join(scratch, 'empty.fbx');
  fs.writeFileSync(empty, '; FBX 7.4.0 project file\nFBXHeaderExtension:  {\n\tFBXVersion: 7400\n}\n');
  const notAModel = path.join(scratch, 'notes.txt');
  fs.writeFileSync(notAModel, 'this is not a model at all\n');

  const browser = await launch(chromium);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto(`file://${PAGE}`);
  await page.waitForFunction(() => document.body.dataset.ready === 'true', { timeout: 20000 });

  const load = async (file) => {
    const before = await page.evaluate(() => window.fbxtool.loadCount);
    await page.setInputFiles('#file-input', [file]);
    await page.waitForFunction((seen) => window.fbxtool.loadCount > seen, before,
      { timeout: 120000 });
    await page.waitForTimeout(300);
    return pageState(page);
  };

  console.log('first model');
  const one = await load(first);
  check('it is described', one.records > 0 && one.report.includes(path.basename(first)),
    `${one.records} records`);
  check('its materials are listed', one.materials > 0, one.materialsStatus);
  check('and it can be exported', !one.exportDisabled && one.triangles > 0,
    `${one.triangles} triangles`);

  console.log('\na second model');
  const two = await load(second);
  check('the report is the new file', two.report.includes(path.basename(second))
    && !two.report.includes(path.basename(first)));
  check('the records are the new file', two.records > 0 && two.records !== one.records,
    `${one.records} -> ${two.records}`);
  check('the material list is the new file',
    two.materials > 0 && two.materialsStatus !== one.materialsStatus,
    `${one.materialsStatus} -> ${two.materialsStatus}`);

  console.log('\na file with nothing in it');
  const bare = await load(empty);
  check('the report is that file', bare.report.includes('empty.fbx'));
  check('nothing of the last file is left in the material list',
    bare.materials === 0 && bare.palette === 0, bare.materialsStatus);
  check('the export button is off', bare.exportDisabled);
  check('and the viewport is empty', bare.triangles === 0 && bare.geometryOptions === 0,
    bare.meshInfo);

  console.log('\na file that is not a model');
  const rejected = await load(notAModel);
  check('it says so', /not a model we recognise/.test(rejected.status), rejected.status);
  check('the report is emptied', /Nothing loaded yet/.test(rejected.report));
  check('so is the record tree', rejected.records === 0);
  check('so is the material list', rejected.materials === 0 && rejected.palette === 0);
  check('nothing is left to export', rejected.exportDisabled && rejected.triangles === 0);
  check('and no document is held', rejected.doc === null);

  console.log('\nopening a model again');
  const again = await load(first);
  check('everything comes back', again.records > 0 && again.materials > 0
    && !again.exportDisabled && again.triangles > 0,
    `${again.records} records, ${again.materials} materials`);

  check('no page errors', errors.length === 0, errors.join(' | ') || 'clean');

  await browser.close();
  fs.rmSync(scratch, { recursive: true, force: true });
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
