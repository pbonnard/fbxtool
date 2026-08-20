/* Taking a scene apart, and picking a part out of it with the mouse.
 *
 *   node web/test/parts.js <scene.fbx> [more...]
 *
 * The first file is expected to be the three-part sample scene, whose parts
 * are known and whose cubes touch when the scene is whole — which is what
 * makes "detached" something that can be measured rather than described: a
 * line of picks across the model finds one run of parts at rest and separate
 * runs with gaps between them once the scene is pulled apart.
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

/** Pick along a horizontal line, and report what was hit where. */
async function scanline(page, samples = 61, atY = 0.5) {
  return page.evaluate(async ({ samples: n, atY: y }) => {
    const canvas = document.getElementById('viewport');
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const hits = [];
    for (let i = 0; i < n; i++) {
      const x = (width * (i + 0.5)) / n;
      hits.push(window.fbxtool.viewer.pickPart(x, height * y));
    }
    return hits;
  }, { samples, atY });
}

/** How many separate stretches of model the line crossed. */
function runs(hits) {
  let count = 0;
  let previous = -1;
  for (const hit of hits) {
    if (hit >= 0 && previous < 0) count++;
    previous = hit;
  }
  return count;
}

async function main() {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.error('usage: node web/test/parts.js <scene.fbx> [...]');
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

  const load = async (file) => {
    const before = await page.evaluate(() => window.fbxtool.loadCount);
    await page.setInputFiles('#file-input', []);
    await page.setInputFiles('#file-input', [file]);
    await page.waitForFunction((seen) => window.fbxtool.loadCount > seen, before,
      { timeout: 180000 });
    await page.waitForTimeout(500);
  };

  const setExplode = async (percent) => {
    await page.evaluate((value) => {
      const slider = document.getElementById('explode-slider');
      slider.value = String(value);
      slider.dispatchEvent(new Event('input'));
    }, percent);
    await page.waitForTimeout(250);
  };

  for (const file of files) {
    console.log(path.basename(file));
    await load(file);

    const state = await page.evaluate(() => ({
      parts: window.fbxtool.partTable.map((p) => ({
        name: p.name, triangles: p.triangles, centre: p.centre,
      })),
      sceneParts: window.fbxtool.parts,
      triangles: window.fbxtool.viewer.triangleCount,
      sliderOff: document.getElementById('explode-slider').disabled,
    }));

    check('every part is in the table', state.parts.length === state.sceneParts,
      `${state.parts.length} of ${state.sceneParts}`);
    check('each with a name and its own share of the triangles',
      state.parts.every((p) => p.name && p.triangles > 0)
      && state.parts.reduce((sum, p) => sum + p.triangles, 0) === state.triangles,
      state.parts.slice(0, 3).map((p) => `${p.name}:${p.triangles}`).join(', '));
    check('the explode control is offered when there is more than one part',
      state.sliderOff === (state.parts.length < 2));

    // ---- picking
    await setExplode(0);
    const atRest = await scanline(page);
    const seen = new Set(atRest.filter((hit) => hit >= 0));
    check('a click finds the part under it', seen.size > 0,
      `${seen.size} distinct part(s) along the middle of the model`);
    check('and nothing where the model is not',
      atRest.some((hit) => hit < 0) || state.parts.length === 1,
      'the line ran off the model at some point');

    const first = atRest.find((hit) => hit >= 0);
    await page.evaluate((index) => window.fbxtool.selectPart(index), first);
    const named = await page.evaluate(() => ({
      index: window.fbxtool.selectedPart,
      shown: document.getElementById('part-info').hidden
        ? '' : document.getElementById('part-info').textContent,
      viewer: window.fbxtool.viewer.selectedPart,
    }));
    check('the one picked is named on screen',
      named.index === first && named.viewer === first
      && named.shown.includes(state.parts[first].name),
      named.shown.slice(0, 70));

    /* And drawn round rather than coloured over.
     *
     * The line comes off the same buffer of part numbers the mouse is picked
     * out of, so it is the silhouette of the part as it is actually seen. What
     * is checked here is that it appears when something is picked and goes
     * when it is let go.
     *
     * After a frame has actually been drawn, not merely after the selection
     * changed: the viewer marks itself for redrawing and paints on the next
     * animation frame, so reading the pixels straight away reads the frame
     * before — which says the line is still there long after it went. */
    const orange = () => page.evaluate(async () => {
      await new Promise((go) => requestAnimationFrame(() => requestAnimationFrame(go)));
      const canvas = document.getElementById('viewport');
      const gl = canvas.getContext('webgl2');
      const px = new Uint8Array(canvas.width * canvas.height * 4);
      gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, px);
      let hits = 0;
      for (let i = 0; i < px.length; i += 4) {
        // The line is the one strongly orange thing on screen: red high, green
        // about half of it, blue almost nothing.
        if (px[i] > 200 && px[i + 1] > 90 && px[i + 1] < 160 && px[i + 2] < 70) hits++;
      }
      return hits;
    });
    const drawn = await orange();
    check('the part picked is drawn round', drawn > 0, `${drawn} pixel(s) of line`);

    await page.evaluate(() => window.fbxtool.selectPart(-1));
    check('and let go again', await page.evaluate(() =>
      window.fbxtool.selectedPart === -1 && document.getElementById('part-info').hidden));
    const gone = await orange();
    check('and the line goes with it', gone === 0, `${gone} pixel(s) left`);

    // ---- taking it apart
    if (state.parts.length > 1) {
      const before = await page.evaluate(() => window.fbxtool.viewer.radius);
      await setExplode(100);
      const after = await page.evaluate(() => window.fbxtool.viewer.radius);
      check('the scene grows as it comes apart', after > before * 1.2,
        `radius ${before.toFixed(1)} -> ${after.toFixed(1)}`);

      await page.click('#reset-view');
      await page.waitForTimeout(300);
      const apart = await scanline(page);
      check('the parts are detached — the line crosses gaps between them',
        runs(apart) > runs(atRest),
        `${runs(atRest)} run(s) together, ${runs(apart)} apart`);
      check('and they are all still there',
        new Set(apart.filter((h) => h >= 0)).size >= seen.size,
        `${new Set(apart.filter((h) => h >= 0)).size} of ${seen.size} still found`);

      // Picking has to follow the parts to where they moved.
      const moved = apart.find((hit) => hit >= 0);
      check('a click still finds a part once it has moved', moved >= 0
        && moved < state.parts.length, `part ${moved}`);
      await setExplode(0);
    }
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
