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
const { launch } = require('./chromium');

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
  // Emptied first: choosing the file already in the input is no change at all,
  // and nothing would happen.
  await page.setInputFiles('#file-input', []);
  await page.setInputFiles('#file-input', [file]);
  await page.waitForFunction((seen) => window.fbxtool.loadCount > seen, before,
    { timeout: 120000 });
  await page.waitForTimeout(400);
}

async function main() {
  const target = process.argv[2];
  if (!target) {
    console.error('usage: node web/test/materials.js <scene_parts.fbx> [other.glb]');
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

  /* An assignment need not arrive after the model. Both of these orders used
   * to lose it: opening a file starts from whatever storage remembers, which
   * is nothing here, and that ran after the assignment rather than before. */
  console.log('\ndropped with the model, and before it');
  /* On a page that has nothing open and nothing remembered — which is where
   * this is really done, and where it used to be lost. With the same file
   * already open the bug hides, because applying the assignment writes it to
   * storage under that name and the load reads it straight back. */
  const fresh = async () => {
    await page.evaluate(() => window.fbxtool.clearMaterials());
    await page.waitForTimeout(200);
    await page.reload();
    await page.waitForFunction(() => document.body.dataset.ready === 'true', { timeout: 20000 });
  };

  await fresh();
  await page.setInputFiles('#file-input', [target, savedPath]);
  await page.waitForFunction(() => window.fbxtool.loadCount > 0, { timeout: 180000 });
  await page.waitForTimeout(400);
  const together = await samples(page);
  check('a model and an assignment dropped together arrive together',
    allBluer(together), show(together));

  await fresh();
  await page.setInputFiles('#file-input', [savedPath]);
  await page.waitForTimeout(300);
  const waiting = await page.evaluate(() => document.getElementById('status').textContent);
  check('an assignment on its own waits for a model', /open a model/.test(waiting), waiting);
  await load(page, target);
  const later = await samples(page);
  check('and is put on the next one opened', allBluer(later), show(later));
  await page.evaluate(() => window.fbxtool.clearMaterials());

  /* The same three orders on another format, since a .glb is exactly the file
   * you drag in with its assignment rather than after it. Read off the palette
   * rather than off the screen: what a colour looks like is this file's
   * business, but whether the assignment arrived is not. */
  const second = process.argv[3];
  if (second) {
    console.log(`
${path.basename(second)}`);
    await fresh();
    await load(page, second);
    // Reloading the page put the Report tab back in front, and the save
    // button lives on the Materials one.
    await page.click('.tab[data-target="tab-materials"]');
    const chosen = await page.evaluate(() => {
      const group = window.fbxtool.materials[0];
      window.fbxtool.editMaterial(group.origin, { colour: [0, 0.75, 0], roughness: 0.9 });
      window.fbxtool.renameMaterial(group.origin, 'Dropped in');
      return group.origin;
    });
    const [saved2] = await Promise.all([
      page.waitForEvent('download'),
      page.click('#materials-save'),
    ]);
    const secondPath = path.join(path.dirname(await saved2.path()), 'second.json');
    await saved2.saveAs(secondPath);

    const worn = () => page.evaluate((key) => {
      const entry = window.fbxtool.palette.find((m) => m.fromFile.name === key);
      return {
        green: entry ? Number(entry.colour[1].toFixed(2)) : -1,
        name: entry ? entry.name : '',
        overrides: Object.keys(window.fbxtool.overrides).length,
      };
    }, chosen);

    await fresh();
    await page.setInputFiles('#file-input', [second, secondPath]);
    await page.waitForFunction(() => window.fbxtool.loadCount > 0, { timeout: 180000 });
    await page.waitForTimeout(400);
    const bothAtOnce = await worn();
    check('dropped together, the assignment is on the model',
      bothAtOnce.green === 0.75 && bothAtOnce.name === 'Dropped in',
      JSON.stringify(bothAtOnce));

    await fresh();
    await page.setInputFiles('#file-input', [secondPath]);
    await page.waitForTimeout(300);
    await load(page, second);
    const afterwards = await worn();
    check('and the same when it goes in first',
      afterwards.green === 0.75 && afterwards.name === 'Dropped in',
      JSON.stringify(afterwards));
    await page.evaluate(() => window.fbxtool.clearMaterials());
  }

  /* A material added here is in no file, so nothing but the assignment can
   * ever bring it back — and a material nobody wears is not much of a
   * restoration, so the part has to be dressed in it again too. */
  console.log('\nmaterials made here');
  await fresh();
  await load(page, target);
  await page.click('.tab[data-target="tab-materials"]');
  const made = await page.evaluate(() => {
    window.fbxtool.selectPart(0);
    window.fbxtool.addMaterial(0);
    window.fbxtool.editMaterial('New material', { colour: [0, 0.7, 0.1], roughness: 0.8 });
    window.fbxtool.renameMaterial('New material', 'Grass');
    return {
      palette: window.fbxtool.palette.length,
      wearing: window.fbxtool.partTable[0].materials.join(''),
      written: JSON.stringify(window.fbxtool.overrides['New material']),
    };
  });
  check('a material added here is written down as one',
    /"added":true/.test(made.written), made.written);

  const [addedFile] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#materials-save'),
  ]);
  const addedPath = path.join(path.dirname(await addedFile.path()), 'added.json');
  await addedFile.saveAs(addedPath);
  const addedJson = JSON.parse(fs.readFileSync(addedPath, 'utf8'));
  check('and so is the part wearing it',
    Object.values(addedJson.parts || {}).includes('New material'),
    JSON.stringify(addedJson.parts || {}));

  const dressed = () => page.evaluate(() => {
    const material = window.fbxtool.palette.find((m) => m.fromFile.name === 'New material');
    const at = window.fbxtool.partTable.findIndex((part) => part.materials.length === 1
      && part.materials[0] === 'New material');
    return {
      there: !!material,
      name: material ? material.name : '',
      green: material ? Number(material.colour[1].toFixed(2)) : -1,
      worn: at,
      edits: !!window.fbxtool.edits,
    };
  });

  // Re-opening the model: the assignment comes out of storage.
  await load(page, target);
  const remade = await dressed();
  check('re-opening the model builds it again, worn by the same part',
    remade.there && remade.name === 'Grass' && remade.green === 0.7 && remade.worn === 0,
    JSON.stringify(remade));
  check('and what was restored reads as the scene, not as an unsaved edit',
    !remade.edits);

  // And from the file itself, on a page that remembers nothing.
  await fresh();
  await page.setInputFiles('#file-input', [target, addedPath]);
  await page.waitForFunction(() => window.fbxtool.loadCount > 0, { timeout: 180000 });
  await page.waitForTimeout(400);
  const fromFile = await dressed();
  check('a saved assignment brings it back on its own',
    fromFile.there && fromFile.name === 'Grass' && fromFile.green === 0.7 && fromFile.worn === 0,
    JSON.stringify(fromFile));

  await page.click('.tab[data-target="tab-materials"]');
  await page.click('#materials-clear');
  await page.waitForTimeout(300);
  const swept = await dressed();
  check('"Clear all" takes it away again', !swept.there && swept.worn < 0,
    JSON.stringify(swept));

  /* An assignment is a list of materials, and a material in it that the file
   * has not got is one the viewer must build — whether or not anything wears
   * it, and whether or not it is marked as ours. Written by hand here, which
   * is also what an assignment saved by an older build looks like. */
  console.log('\nmaterials the file has not got');
  const strangerPath = path.join(path.dirname(await addedFile.path()), 'stranger.json');
  fs.writeFileSync(strangerPath, JSON.stringify({
    fbxtoolMaterials: 1,
    materials: {
      paint: { roughness: 0.2 },
      Violet: { colour: [0.6, 0.1, 0.7], name: 'Deep violet' },
    },
  }, null, 2));

  const listed = () => page.evaluate(() => ({
    palette: window.fbxtool.palette.map((m) => m.name),
    rows: [...document.querySelectorAll('.material .material-name')].map((e) => e.textContent),
    worn: window.fbxtool.partTable.some((part) => part.materials.includes('Violet')),
    colour: (window.fbxtool.palette.find((m) => m.fromFile.name === 'Violet') || {}).colour,
  }));

  await fresh();
  await page.setInputFiles('#file-input', [target, strangerPath]);
  await page.waitForFunction(() => window.fbxtool.loadCount > 0, { timeout: 180000 });
  await page.waitForTimeout(400);
  const stranger = await listed();
  check('a material only the assignment knows about is built anyway',
    stranger.palette.includes('Deep violet') && stranger.rows.includes('Deep violet'),
    stranger.rows.join(', '));
  check('with the colour it was given, and nobody wearing it',
    stranger.colour && Math.abs(stranger.colour[2] - 0.7) < 1e-6 && !stranger.worn,
    JSON.stringify(stranger.colour));

  // The same list when one geometry is shown on its own, which is a different
  // palette put together a different way.
  await page.selectOption('#geometry-select', '0');
  await page.waitForTimeout(700);
  const alone = await listed();
  check('and it is there for one geometry on its own too',
    alone.palette.includes('Deep violet') && alone.rows.includes('Deep violet'),
    alone.rows.join(', '));
  await page.selectOption('#geometry-select', 'scene');
  await page.waitForTimeout(700);
  await page.evaluate(() => window.fbxtool.clearMaterials());

  check('no page errors', errors.length === 0, errors.join(' | ') || 'clean');

  await browser.close();
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
