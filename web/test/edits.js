/* Deleting a part out of a scene, and cutting one into its pieces.
 *
 *   node web/test/edits.js <scene.fbx> [more...]
 *
 * What makes these checkable rather than merely visible is that nothing is
 * allowed to go missing: a delete takes exactly its own triangles out of the
 * screen, the report and the export, a split moves none at all, and undo puts
 * the scene back to the count it started from. Every number is compared with
 * what the same page said a moment earlier, so a change of convention here
 * cannot quietly agree with itself.
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

/** Everything the page will admit to about the scene as it now stands. */
const state = (page) => page.evaluate(() => {
  const table = window.fbxtool.partTable;
  const report = document.getElementById('panel').textContent;
  return {
    parts: table.length,
    names: table.map((part) => part.name),
    triangles: table.reduce((sum, part) => sum + part.triangles, 0),
    drawn: window.fbxtool.viewer.triangleCount,
    edits: window.fbxtool.edits && {
      removed: window.fbxtool.edits.removed.map((r) => r.name),
      split: window.fbxtool.edits.split.length,
      assigned: window.fbxtool.edits.assigned,
      added: window.fbxtool.edits.added,
      parts: window.fbxtool.edits.parts,
      triangles: window.fbxtool.edits.triangles,
    },
    reported: report.includes('Edits'),
    marks: (report.match(/← (removed|edited)/g) || []).length,
    status: document.getElementById('status').textContent,
    restoreOffered: !document.getElementById('restore-all').hidden,
  };
});

/** Write a glTF and report what went into it. */
async function exported(page) {
  const before = await page.evaluate(() => {
    window.__stats = window.fbxtool.lastExport;
    window.fbxtool.exportGltf();
    return true;
  });
  if (!before) return null;
  await page.waitForFunction(
    () => window.fbxtool.lastExport && window.fbxtool.lastExport !== window.__stats,
    { timeout: 300000 },
  );
  return page.evaluate(() => window.fbxtool.lastExport);
}

/** Pick along a horizontal line, and report what was hit. */
const scanline = (page, samples = 41) => page.evaluate((n) => {
  const canvas = document.getElementById('viewport');
  const hits = [];
  for (let i = 0; i < n; i++) {
    hits.push(window.fbxtool.viewer.pickPart(
      (canvas.clientWidth * (i + 0.5)) / n, canvas.clientHeight * 0.5));
  }
  return hits;
}, samples);

async function main() {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.error('usage: node web/test/edits.js <scene.fbx> [...]');
    process.exit(2);
  }
  if (!fs.existsSync(PAGE)) {
    console.error(`${PAGE} is missing — run: python3 web/build.py`);
    process.exit(2);
  }

  const browser = await launch(chromium);
  const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto(`file://${PAGE}`);
  await page.waitForFunction(() => document.body.dataset.ready === 'true', { timeout: 20000 });

  for (const file of files) {
    console.log(path.basename(file));
    const before = await page.evaluate(() => window.fbxtool.loadCount);
    await page.setInputFiles('#file-input', []);
    await page.setInputFiles('#file-input', [file]);
    await page.waitForFunction((seen) => window.fbxtool.loadCount > seen, before,
      { timeout: 300000 });
    await page.waitForTimeout(500);

    const start = await state(page);
    check('the file opens with nothing edited',
      start.parts > 0 && !start.edits && !start.reported && !start.restoreOffered,
      `${start.parts} parts, ${start.triangles.toLocaleString()} triangles`);
    check('and the screen holds every triangle the parts do',
      start.drawn === start.triangles, `${start.drawn} drawn`);

    // ---- delete
    const biggest = await page.evaluate(() => {
      const table = window.fbxtool.partTable;
      let at = 0;
      table.forEach((part, index) => { if (part.triangles > table[at].triangles) at = index; });
      window.fbxtool.selectPart(at);
      return { at, name: table[at].name, triangles: table[at].triangles };
    });
    await page.click('#part-delete');
    await page.waitForTimeout(200);
    const cut = await state(page);
    check('deleting a part takes it out of the scene',
      cut.parts === start.parts - 1 && !cut.names.includes(biggest.name),
      `${biggest.name} — ${biggest.triangles.toLocaleString()} triangles`);
    check('and takes exactly its own triangles with it',
      cut.triangles === start.triangles - biggest.triangles && cut.drawn === cut.triangles,
      `${start.triangles.toLocaleString()} -> ${cut.triangles.toLocaleString()}`);
    check('the report says so, and marks the model it came from',
      cut.reported && cut.edits && cut.edits.removed.includes(biggest.name) && cut.marks > 0,
      `${cut.marks} mark(s)`);
    check('and there is a way to put it back', cut.restoreOffered);

    const written = await exported(page);
    check('an export writes what is on screen, not what the file held',
      written && written.triangles === cut.drawn,
      written ? `${written.triangles.toLocaleString()} written, `
        + `${written.meshes} mesh(es) in ${written.nodes} node(s)` : 'nothing written');

    // ---- undo
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(200);
    const back = await state(page);
    check('undo puts the part back where it was',
      back.parts === start.parts && back.triangles === start.triangles
      && back.names.join('|') === start.names.join('|'),
      `${back.parts} parts, ${back.triangles.toLocaleString()} triangles`);
    check('and the report stops describing an edit', !back.reported && !back.edits);

    // ---- split
    const splittable = await page.evaluate(() => {
      // Try the parts in turn: the first that comes apart is the one to use.
      const table = window.fbxtool.partTable;
      const order = table.map((part, index) => index)
        .sort((a, b) => table[b].triangles - table[a].triangles);
      for (const index of order.slice(0, 12)) {
        const was = window.fbxtool.partTable.length;
        window.fbxtool.selectPart(index);
        window.fbxtool.splitPart(index, 'shells');
        if (window.fbxtool.partTable.length > was) {
          const made = window.fbxtool.partTable.length - was + 1;
          return { index, name: table[index].name, triangles: table[index].triangles, made };
        }
      }
      return null;
    });

    if (splittable) {
      const split = await state(page);
      check('splitting a part cuts it into its loose pieces',
        split.parts === back.parts + splittable.made - 1,
        `${splittable.name} into ${splittable.made}`);
      check('and moves no triangles at all',
        split.triangles === back.triangles && split.drawn === back.drawn,
        `${split.triangles.toLocaleString()} still there`);
      const pieces = split.names.filter((name) => name.startsWith(`${splittable.name} #`));
      check('the pieces are named after the part they came out of',
        pieces.length === splittable.made, pieces.slice(0, 3).join(', '));
      const kept = await page.evaluate((name) => window.fbxtool.partTable
        .filter((part) => part.name.startsWith(`${name} #`))
        .reduce((sum, part) => sum + part.triangles, 0), splittable.name);
      check('and between them they hold the whole of it',
        kept === splittable.triangles,
        `${kept.toLocaleString()} of ${splittable.triangles.toLocaleString()}`);

      const hits = await scanline(page);
      check('a click still finds a part once the scene has been cut up',
        hits.some((hit) => hit >= 0) && hits.every((hit) => hit < split.parts),
        `${new Set(hits.filter((h) => h >= 0)).size} distinct part(s) along the middle`);

      // One of the new pieces can be taken out on its own.
      const piece = await page.evaluate((name) => {
        const at = window.fbxtool.partTable.findIndex((part) => part.name.startsWith(`${name} #`));
        window.fbxtool.selectPart(at);
        return { at, triangles: window.fbxtool.partTable[at].triangles };
      }, splittable.name);
      await page.keyboard.press('Delete');
      await page.waitForTimeout(200);
      const trimmed = await state(page);
      check('and deleted on its own, leaving the rest of the part behind',
        trimmed.triangles === split.triangles - piece.triangles
        && trimmed.parts === split.parts - 1,
        `${piece.triangles.toLocaleString()} triangles off one piece`);
      const half = await exported(page);
      check('which the export writes as the part it is now',
        half && half.triangles === trimmed.drawn,
        half ? `${half.triangles.toLocaleString()} written` : 'nothing written');
    } else {
      check('a part that is all one piece is left alone',
        (await state(page)).status.includes('nothing to split'),
        (await state(page)).status);
    }

    // ---- by material
    const byMaterial = await page.evaluate(() => {
      const table = window.fbxtool.partTable;
      const at = table.findIndex((part) => (part.materials || []).length > 1);
      if (at < 0) return null;
      const was = table.length;
      const name = table[at].name;
      const triangles = table[at].triangles;
      window.fbxtool.selectPart(at);
      window.fbxtool.splitPart(at, 'material');
      const made = window.fbxtool.partTable.length - was + 1;
      return made > 1 ? { name, triangles, made } : null;
    });
    if (byMaterial) {
      const kept = await page.evaluate((name) => window.fbxtool.partTable
        .filter((part) => part.name.startsWith(`${name} · `))
        .map((part) => ({ name: part.name, triangles: part.triangles })), byMaterial.name);
      check('a part can be cut up by the materials it wears',
        kept.length === byMaterial.made
        && kept.reduce((sum, part) => sum + part.triangles, 0) === byMaterial.triangles,
        kept.map((k) => `${k.name.split(' · ').pop()}:${k.triangles}`).join(', '));
    } else {
      console.log('  --   no part in this file wears more than one material');
    }

    // ---- materials
    const beforeMaterials = await state(page);
    const dressed = await page.evaluate(() => {
      const groups = window.fbxtool.materials;
      if (groups.length < 2) return null;
      const worn = (window.fbxtool.partTable[0].materials || [])[0];
      const target = groups.find((group) => group.name !== worn) || groups[0];
      window.fbxtool.selectPart(0);
      window.fbxtool.assignMaterial(0, target.slots[0]);
      return {
        name: target.name,
        wearing: window.fbxtool.partTable[0].materials,
        triangles: window.fbxtool.viewer.triangleCount,
        palette: window.fbxtool.palette.length,
      };
    });
    if (dressed) {
      const after = await state(page);
      check('a part can be given a different material',
        dressed.wearing.length === 1 && dressed.wearing[0] === dressed.name,
        `${after.names[0]} wears ${dressed.wearing.join(', ')}`);
      check('and the geometry is untouched by it',
        dressed.triangles === beforeMaterials.drawn && after.parts === beforeMaterials.parts,
        `${dressed.triangles.toLocaleString()} triangles, ${after.parts} parts`);
      check('the report counts it as a change to the scene',
        after.edits && after.edits.assigned === 1, `${after.edits && after.edits.assigned}`);
    }

    const added = await page.evaluate(() => {
      const before = window.fbxtool.palette.length;
      window.fbxtool.selectPart(0);
      window.fbxtool.addMaterial(0);
      const name = window.fbxtool.edits.added[0];
      const wearing = window.fbxtool.partTable[0].materials.slice();
      const grown = window.fbxtool.palette.length;
      window.fbxtool.undo();
      const undone = window.fbxtool.palette.length;
      window.fbxtool.redo();
      return { before, name, wearing, grown, undone, redone: window.fbxtool.palette.length };
    });
    check('a material that is not in the file can be added and worn',
      added.grown === added.before + 1 && added.wearing.length === 1
      && added.wearing[0] === added.name, `${added.name} on the first part`);
    check('undo takes it back off the palette, redo puts it back',
      added.undone === added.before && added.redone === added.before + 1,
      `${added.before} -> ${added.grown} -> ${added.undone} -> ${added.redone}`);
    const dressedExport = await exported(page);
    check('and an export writes the scene wearing it',
      dressedExport && dressedExport.triangles === (await state(page)).drawn,
      dressedExport ? `${dressedExport.triangles.toLocaleString()} written, `
        + `${dressedExport.materials} material(s)` : 'nothing written');

    // ---- restore
    // Whatever the file allowed above, leave the scene edited so that putting
    // it all back is the same test for every file.
    const offered = await page.evaluate(() => {
      if (!window.fbxtool.edits) {
        window.fbxtool.selectPart(0);
        window.fbxtool.deletePart(0);
      }
      return !!window.fbxtool.edits && !document.getElementById('restore-all').hidden;
    });
    check('an edited scene offers to put itself back', offered);
    await page.click('#restore-all');
    await page.waitForTimeout(300);
    const whole = await state(page);
    check('and everything goes back at once',
      whole.parts === start.parts && whole.triangles === start.triangles
      && !whole.edits && !whole.reported && whole.marks === 0,
      `${whole.parts} parts, ${whole.triangles.toLocaleString()} triangles`);
    const again = await exported(page);
    check('with the export writing the whole file once more',
      again && again.triangles === start.drawn,
      again ? `${again.triangles.toLocaleString()} written` : 'nothing written');
    console.log('');
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
