/* The three spellings the export is written in, each read back.
 *
 *   node web/test/exports.js <out-dir> <model> [more...]
 *
 * `web/test/gltf.js` takes a `.glb` apart byte by byte; this asks a different
 * question of all three. Each file is loaded in the page, written out as a
 * `.glb`, as a `.gltf` beside a `.bin`, and as an `.fbx` — and each of those is
 * then opened in the same page and held against what went in. A format nobody
 * can read back is not an export, and the page is the reader that says so.
 *
 * The counts have to survive the trip. Triangles are the strict one: welding
 * and splitting change how a model is *stored* and not how much of it there
 * is. Parts and materials are checked too, since a name is what everything
 * downstream finds a body panel by.
 *
 * What is written is left in *out-dir* rather than a temporary of its own, so
 * the caller can read it with something that is not this page.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { launch } = require('./chromium');

const ROOT = path.resolve(__dirname, '..', '..');
const PAGE = path.join(ROOT, 'web', 'dist', 'fbxview.html');

//: What each one writes, and how many files come back from it.
const FORMATS = [
  { value: 'glb', files: 1, suffix: '.glb' },
  { value: 'gltf', files: 2, suffix: '.gltf' },
  { value: 'fbx', files: 1, suffix: '.fbx' },
];

let failures = 0;

function check(label, condition, detail = '') {
  if (!condition) failures++;
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? `  — ${detail}` : ''}`);
}

/**
 * What the page holds, which is what an export has to come back as.
 *
 * *drawn* is the materials that actually cover triangles. A material covering
 * none is dropped on the way out, by design and with the export saying so —
 * the Mercedes sample states 23 and draws with 17 — so it is the drawn ones
 * that have to survive.
 */
function census(page) {
  return page.evaluate(() => ({
    triangles: window.fbxtool.viewer.triangleCount,
    parts: window.fbxtool.parts,
    materials: window.fbxtool.materials.length,
    textures: window.fbxtool.viewer.textureLayers,
    drawn: window.fbxtool.materials
      .filter((group) => group.triangles > 0).map((group) => group.name).sort(),
    names: window.fbxtool.materials.map((group) => group.name).sort(),
  }));
}

async function open(page, files) {
  const before = await page.evaluate(() => window.fbxtool.loadCount);
  await page.setInputFiles('#file-input', []);
  await page.setInputFiles('#file-input', files);
  await page.waitForFunction((seen) => window.fbxtool.loadCount > seen, before,
    { timeout: 300000 });
  await page.waitForTimeout(400);
  return census(page);
}

async function main() {
  const [outDir, ...files] = process.argv.slice(2);
  if (!outDir || !files.length) {
    console.error('usage: node web/test/exports.js <out-dir> <model> [...]');
    process.exit(2);
  }
  if (!fs.existsSync(PAGE)) {
    console.error(`${PAGE} is missing — run: python3 web/build.py`);
    process.exit(2);
  }

  const browser = await launch(chromium);
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  const written = [];
  page.on('download', async (item) => {
    const name = item.suggestedFilename();
    await item.saveAs(path.join(outDir, name));
    written.push(name);
  });
  await page.goto(`file://${PAGE}`);
  await page.waitForFunction(() => document.body.dataset.ready === 'true', { timeout: 20000 });

  for (const entry of files) {
    const group = entry.split('+').every((f) => fs.existsSync(f)) ? entry.split('+') : [entry];
    console.log(group.map((f) => path.basename(f)).join(' + '));
    const source = await open(page, group);

    for (const format of FORMATS) {
      written.length = 0;
      await open(page, group);
      await page.selectOption('#export-format', format.value);
      await page.click('#export-gltf');
      const until = Date.now() + 300000;
      while (written.length < format.files && Date.now() < until) {
        await page.waitForTimeout(150);
      }
      if (written.length < format.files) {
        check(`${format.suffix} was written`, false,
          `${written.length} of ${format.files} file(s)`);
        continue;
      }
      const paths = written.map((name) => path.join(outDir, name));
      const sizes = paths.map((p) => fs.statSync(p).size);
      check(`${format.suffix} was written`, sizes.every((size) => size > 0),
        written.map((name, at) => `${name} ${(sizes[at] / 1024).toFixed(0)} KiB`).join(', '));

      const back = await open(page, paths);
      // The strict one. Welding and splitting change how a model is stored,
      // not how much of it there is.
      check(`${format.suffix} comes back with every triangle`,
        back.triangles === source.triangles,
        `${back.triangles.toLocaleString()} of ${source.triangles.toLocaleString()}`);
      /* Parts survive an FBX exactly, because a mesh there may wear several
       * materials and carry an index per polygon saying which. A glTF
       * primitive has exactly one, so a mesh with seventeen comes back as
       * seventeen parts — which is a real difference between the two and one
       * reason to pick the older format. */
      const kept = format.value === 'fbx'
        ? back.parts === source.parts : back.parts >= source.parts;
      check(`${format.suffix} comes back with every part`, kept,
        `${back.parts} ${format.value === 'fbx' ? 'of' : 'for'} ${source.parts}`);
      const missing = source.drawn.filter((name) => !back.names.includes(name));
      check(`${format.suffix} keeps every material that covers anything`,
        missing.length === 0,
        missing.length ? `${missing.length} gone: ${missing.slice(0, 3).join(', ')}`
          : `${source.drawn.length} of ${source.materials} stated`);
      check(`${format.suffix} keeps the pictures`, back.textures === source.textures,
        `${back.textures} of ${source.textures}`);
    }
    console.log('');
  }

  check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | ') || 'clean');
  await browser.close();
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
