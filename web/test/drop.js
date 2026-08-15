/* Dropping a folder, which is how a downloaded model arrives.
 *
 *   node web/test/drop.js <pyramid.obj> <pyramid.mtl> <checker.png>
 *
 * A model downloaded as a folder keeps its images in a subfolder beside it —
 * a Sketchfab glTF has `textures/` — and the document names them by relative
 * path. `dataTransfer.files` does not go into a folder, so dropping one used
 * to hand over the document and nothing else: the model arrived with none of
 * its images, and every material fell back to whatever it states alone.
 *
 * The drop is built here rather than performed: Playwright cannot drag a real
 * folder in, so the entries a browser would hand the page are stood up in the
 * page itself and the same event dispatched. What is under test is what the
 * page does with them.
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

const read = (file) => ({
  name: path.basename(file),
  data: Array.from(new Uint8Array(fs.readFileSync(file))),
});

/**
 * Stand up the entries a folder drop hands over, and dispatch it.
 *
 * `tree` is {name, files, dirs}, each file {name, data}. The shape mirrors the
 * FileSystemEntry interface the page reads: `webkitGetAsEntry` on each item,
 * then `createReader().readEntries` a batch at a time until it says no more.
 */
function dropFolder(page, tree) {
  return page.evaluate((folder) => {
    const fileEntry = (f) => ({
      isFile: true,
      isDirectory: false,
      name: f.name,
      file: (resolve) => resolve(new File([new Uint8Array(f.data)], f.name)),
    });
    const dirEntry = (d) => ({
      isFile: false,
      isDirectory: true,
      name: d.name,
      createReader() {
        let done = false;
        return {
          readEntries(resolve) {
            if (done) { resolve([]); return; }
            done = true;
            resolve([...(d.files || []).map(fileEntry), ...(d.dirs || []).map(dirEntry)]);
          },
        };
      },
    });
    const root = dirEntry(folder);
    const event = new Event('drop', { bubbles: true });
    Object.defineProperty(event, 'dataTransfer', {
      value: { items: [{ webkitGetAsEntry: () => root }], files: [] },
    });
    document.dispatchEvent(event);
  }, tree);
}

async function main() {
  const [model, library, image] = process.argv.slice(2);
  if (!model || !library || !image) {
    console.error('usage: node web/test/drop.js <pyramid.obj> <pyramid.mtl> <checker.png>');
    process.exit(2);
  }
  if (!fs.existsSync(PAGE)) {
    console.error(`${PAGE} is missing — run: python3 web/build.py`);
    process.exit(2);
  }

  const browser = await launch(chromium);
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto(`file://${PAGE}`);
  await page.waitForFunction(() => document.body.dataset.ready === 'true', { timeout: 20000 });

  /* The model at the top, its image a folder down, and a licence beside it —
   * which is what a download looks like, and which used to be taken for the
   * model on the strength of coming first in the folder. */
  const folder = {
    name: 'pyramid',
    files: [
      { name: 'license.txt', data: Array.from(Buffer.from('All rights reserved.\n')) },
      read(model),
      read(library),
    ],
    dirs: [{ name: 'textures', files: [read(image)] }],
  };

  console.log('a folder, dropped');
  const before = await page.evaluate(() => window.fbxtool.loadCount);
  await dropFolder(page, folder);
  await page.waitForFunction((seen) => window.fbxtool.loadCount > seen, before,
    { timeout: 60000 });
  await page.waitForTimeout(600);

  const loaded = await page.evaluate(() => ({
    name: window.fbxtool.doc && window.fbxtool.doc.fileName,
    triangles: window.fbxtool.viewer.triangleCount,
    textures: window.fbxtool.viewer.textureLayers,
    missing: window.fbxtool.missingTextures,
  }));
  check('the model is the model, not the licence beside it',
    loaded.name === path.basename(model), String(loaded.name));
  check('and it has its geometry', loaded.triangles > 0, `${loaded.triangles} triangles`);
  check('the image a folder down came with it',
    loaded.textures === 1 && loaded.missing.length === 0,
    `${loaded.textures} texture(s), missing: ${loaded.missing.join(', ') || 'none'}`);

  /* The same drop with nothing but the files at the top level, which is what
   * `dataTransfer.files` alone ever offered: the model reads, and it says
   * which image it is waiting for rather than pretending it has one.
   *
   * On a fresh page, since an image handed over once is kept for whatever
   * opens next — dropping a texture in after the model is how a missing one
   * gets supplied, and that must go on working. */
  console.log('\nthe same, with the folder left behind');
  await page.reload();
  await page.waitForFunction(() => document.body.dataset.ready === 'true', { timeout: 20000 });
  const flat = await page.evaluate(() => window.fbxtool.loadCount);
  await dropFolder(page, { name: 'pyramid', files: folder.files, dirs: [] });
  await page.waitForFunction((seen) => window.fbxtool.loadCount > seen, flat,
    { timeout: 60000 });
  await page.waitForTimeout(600);
  const without = await page.evaluate(() => ({
    triangles: window.fbxtool.viewer.triangleCount,
    textures: window.fbxtool.viewer.textureLayers,
    missing: window.fbxtool.missingTextures,
  }));
  check('the model still reads', without.triangles > 0, `${without.triangles} triangles`);
  check('and names the image it is waiting for',
    without.textures === 0 && without.missing.length === 1,
    `missing: ${without.missing.join(', ') || 'none'}`);

  /* The same folder through the picker rather than a drop. A file picker
   * cannot reach into a subfolder, so this is a directory picker: the one way
   * a downloaded model opens with its images from the button rather than by
   * being dragged. */
  console.log('\nthe same folder, picked rather than dropped');
  await page.reload();
  await page.waitForFunction(() => document.body.dataset.ready === 'true', { timeout: 20000 });
  check('the page offers a directory picker',
    await page.evaluate(() => {
      const input = document.getElementById('folder-input');
      return !!document.getElementById('picker-folder') && !!input && input.webkitdirectory;
    }));

  /* Nobody agrees where the images go. `textures/` is what Sketchfab writes,
   * `maps/` is what plenty of others write, and a model saved out of a tool
   * often has them loose beside it — sometimes with the model itself a folder
   * down. None of that is worth knowing about: the whole folder is read and
   * an image is matched to what names it by file name, not by path. */
  const layouts = [
    ['textures/', '.', 'textures'],
    ['maps/', '.', 'maps'],
    ['loose beside the model', '.', '.'],
    ['source/ with textures/', 'source', 'textures'],
    ['further down still', '.', path.join('tex', 'hi')],
  ];

  for (const [label, where, images] of layouts) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fbxtool-drop-'));
    const tree = path.join(root, 'pyramid');
    fs.mkdirSync(path.join(tree, where), { recursive: true });
    fs.mkdirSync(path.join(tree, images), { recursive: true });
    fs.writeFileSync(path.join(tree, 'license.txt'), 'All rights reserved.\n');
    fs.copyFileSync(model, path.join(tree, where, path.basename(model)));
    fs.copyFileSync(library, path.join(tree, where, path.basename(library)));
    fs.copyFileSync(image, path.join(tree, images, path.basename(image)));

    await page.reload();
    await page.waitForFunction(() => document.body.dataset.ready === 'true', { timeout: 20000 });
    const picked = await page.evaluate(() => window.fbxtool.loadCount);
    await page.setInputFiles('#folder-input', [tree]);
    await page.waitForFunction((seen) => window.fbxtool.loadCount > seen, picked,
      { timeout: 60000 });
    await page.waitForTimeout(500);
    const found = await page.evaluate(() => ({
      name: window.fbxtool.doc && window.fbxtool.doc.fileName,
      textures: window.fbxtool.viewer.textureLayers,
      missing: window.fbxtool.missingTextures,
    }));
    check(`the model and its image, with the images in ${label}`,
      found.name === path.basename(model) && found.textures === 1
      && found.missing.length === 0,
      `${found.name} · ${found.textures} texture(s)`
      + `, missing: ${found.missing.join(', ') || 'none'}`);
    fs.rmSync(root, { recursive: true, force: true });
  }

  /* A folder holding the same scene saved twice, as a downloaded model
   * usually is: one saving kept the mesh, the other kept the maps. The richer
   * mesh is what gets opened — a vertex count is a fact — and the materials
   * come from the other only because this one has none of its own. */
  const twins = process.argv.slice(5, 7);
  if (twins.length === 2 && twins.every((f) => fs.existsSync(f))) {
    console.log('\nthe same scene saved twice');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fbxtool-twin-'));
    const tree = path.join(root, 'twins');
    fs.mkdirSync(tree, { recursive: true });
    for (const f of twins) fs.copyFileSync(f, path.join(tree, path.basename(f)));

    await page.reload();
    await page.waitForFunction(() => document.body.dataset.ready === 'true', { timeout: 20000 });
    const seen = await page.evaluate(() => window.fbxtool.loadCount);
    await page.setInputFiles('#folder-input', [tree]);
    await page.waitForFunction((was) => window.fbxtool.loadCount > was, seen,
      { timeout: 120000 });
    await page.waitForTimeout(1200);
    const merged = await page.evaluate(() => ({
      survey: window.fbxtool.lastSurvey,
      opened: window.fbxtool.doc && window.fbxtool.doc.fileName,
      triangles: window.fbxtool.viewer.triangleCount,
      textures: window.fbxtool.viewer.textureLayers,
      assigned: (window.fbxtool.edits || {}).assigned || 0,
      names: window.fbxtool.materials.map((g) => g.name),
    }));
    const rich = path.basename(twins[0]);
    const mapped = path.basename(twins[1]);
    check('both files are read before either is opened',
      !!merged.survey && merged.survey.files.length === 2,
      merged.survey ? merged.survey.files.map((f) => f.name).join(', ') : 'no survey');
    check('the one with the geometry is the one opened',
      merged.opened === rich && merged.survey.base === rich, String(merged.opened));
    check('and it is the whole mesh, not the scrap beside it',
      merged.triangles === 12, `${merged.triangles} triangles`);
    check('the other is read for its materials',
      merged.survey.donor === mapped, String(merged.survey.donor));
    check('which reach the part that answers to the same name',
      merged.assigned === 1, `${merged.assigned} part(s) reassigned`);
    check('bringing the image with them',
      merged.textures === 1, `${merged.textures} texture(s)`);
    check('and undoing gives the file its own back', await page.evaluate(() => {
      window.fbxtool.undo();
      return (window.fbxtool.edits || {}).assigned || 0;
    }) === 0);
    fs.rmSync(root, { recursive: true, force: true });
  }

  check('no page errors', errors.length === 0, errors.join(' | ') || 'clean');
  await browser.close();
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
