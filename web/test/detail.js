/* The grain a surface is tiled over with — a game's `txDetail`.
 *
 *   node web/test/detail.js <out-dir> <plain.kn5> <grained.kn5> <flat.kn5> <deep.kn5>
 *
 * A car's interior is one atlas of flat panels with the leather, the carpet
 * and the carbon laid over them, tiled sixty or a hundred times across: the
 * picture underneath is the shape and the grain is the surface. An Audi S8 has
 * thirty-eight materials wearing one, and nine of the fifteen files in each of
 * its skins go there — so without it a skin changes the badge and the number
 * plate and leaves the cabin exactly as it was.
 *
 * What the file does not say is how much of the grain the game mixes in, and
 * the two readings are far apart. Multiplied straight, a Mercedes E63's paint
 * — whose grain averages 0.24 — turns a white car graphite. So each grain is
 * taken as neutral at its own average, in linear light, and only what differs
 * from that average shows.
 *
 * All four fixtures are the same cube wearing the same mid-grey colour map.
 * One has no grain. One has a green one, dark and light in equal measure, and
 * must come out green without coming out darker. One's grain is nothing but
 * its own average, so it must do nothing at all — the strictest thing a grain
 * can be asked, and the one that says which light the multiply happened in:
 * read as the file writes it rather than as the card decodes it, a flat grain
 * over a grey panel turns it white. The last is dark enough that taking it as
 * neutral asks for forty-seven times the light back, where eight is as far as
 * anything here will lighten a surface.
 *
 * And each has to leave that way too. Neither glTF nor FBX has a second set of
 * coordinates to tile a map by, so a grain travels only by being multiplied
 * into the picture before it goes — and exported without that, a car's whole
 * cabin arrives flat. So each cube is written out both ways and opened again,
 * and has to come back what it was.
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

/** Average colour of the middle of the viewport, in 0-255. */
function sample(page) {
  return page.evaluate(() => {
    const canvas = document.getElementById('viewport');
    const gl = canvas.getContext('webgl2');
    const half = 24;
    const cx = Math.round(canvas.width / 2);
    const cy = Math.round(canvas.height / 2);
    const px = new Uint8Array(half * 2 * half * 2 * 4);
    gl.readPixels(cx - half, cy - half, half * 2, half * 2, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const total = [0, 0, 0];
    for (let i = 0; i < px.length; i += 4) {
      total[0] += px[i]; total[1] += px[i + 1]; total[2] += px[i + 2];
    }
    return total.map((v) => Math.round(v / (px.length / 4)));
  });
}

async function load(page, file) {
  const before = await page.evaluate(() => window.fbxtool.loadCount);
  await page.setInputFiles('#file-input', [file]);
  await page.waitForFunction((seen) => window.fbxtool.loadCount > seen, before,
    { timeout: 120000 });
  await page.waitForTimeout(700);
  return sample(page);
}

async function main() {
  const [outDir, plainFile, grainedFile, flatFile, deepFile] = process.argv.slice(2);
  if (!outDir || !plainFile || !grainedFile || !flatFile || !deepFile) {
    console.error('usage: node web/test/detail.js <out-dir> '
      + '<plain.kn5> <grained.kn5> <flat.kn5> <deep.kn5>');
    process.exit(2);
  }
  if (!fs.existsSync(PAGE)) {
    console.error(`${PAGE} is missing — run: python3 web/build.py`);
    process.exit(2);
  }

  const browser = await launch(chromium);
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  const written = [];
  page.on('download', async (item) => {
    const name = item.suggestedFilename();
    await item.saveAs(path.join(outDir, name));
    written.push(path.join(outDir, name));
  });
  await page.goto(`file://${PAGE}`);
  await page.waitForFunction(() => document.body.dataset.ready === 'true', { timeout: 20000 });

  console.log('the same cube, with and without a grain over it');
  const plain = await load(page, plainFile);
  check('the plain one is the grey its colour map is',
    Math.abs(plain[0] - plain[1]) < 8 && Math.abs(plain[1] - plain[2]) < 8, `rgb(${plain})`);

  const grained = await load(page, grainedFile);
  check('the grained one takes the cast of its grain',
    grained[1] > grained[0] * 1.25 && grained[1] > grained[2] * 1.25, `rgb(${grained})`);
  /* And is not darker for wearing one. Averaged as the file holds it rather
   * than in linear light, the divide comes out five times too small and this
   * is where it shows. */
  check('and is no darker overall than without it',
    grained[1] > plain[1] * 0.7, `rgb(${grained}) against rgb(${plain})`);

  /* And the two ways of doing the multiply, held against each other.
   *
   * The card does it where there is a card and a loop does it where there is
   * not, which means the file that leaves depends on what the machine has.
   * They are the same arithmetic on the same texels, so they must come to the
   * same bytes — and on a machine with a real GPU and on this software one
   * alike, they do, exactly. */
  const both = await page.evaluate(() => window.fbxtool.bakeBothWays(4));
  check('the card and the loop bake the same picture',
    both.length > 0 && both.every((one) => one.card && one.worst === 0),
    both.map((one) => `${one.name} ${one.card ? `worst ${one.worst}` : 'no card'}`)
      .join(', ') || 'nothing grained');

  const flat = await load(page, flatFile);
  /* A grain that is its own average is no grain: it says nothing differs from
   * the average anywhere, so the panel is the grey its colour map is. Read in
   * the light the file is written in rather than the light the card decodes it
   * into, the same grain comes out at twice what it should and whites the
   * panel out. */
  check('a grain that is nothing but its own average changes nothing',
    [0, 1, 2].every((k) => Math.abs(flat[k] - plain[k]) <= 10),
    `rgb(${flat}) against rgb(${plain})`);

  const deep = await load(page, deepFile);
  /* A grain dark enough that taking it as neutral asks for forty-seven times
   * the light back gets eight, which is as far as the viewer will lighten
   * anything. So the panel is much darker than its colour map, and the number
   * that made it so is the one the export has to use too. */
  check('a grain too dark to make neutral is held at the ceiling',
    deep[1] < plain[1] * 0.55, `rgb(${deep}) against rgb(${plain})`);

  /* And out again. The cube is still loaded and still grained, so writing it
   * now and opening what was written asks the one question the export has to
   * answer: the file it produces has nowhere to put a tiled second map, so
   * either the grain is in the picture or it is gone. */
  console.log('and the same cubes written out and opened again');
  for (const [label, source, from, cast] of [
    ['grained', grained, grainedFile, true], ['flat', flat, flatFile, false],
    ['deep', deep, deepFile, false]]) {
    for (const format of ['glb', 'fbx']) {
      await load(page, from);
      written.length = 0;
      await page.selectOption('#export-format', format);
      await page.click('#export-gltf');
      const until = Date.now() + 120000;
      while (!written.length && Date.now() < until) await page.waitForTimeout(150);
      if (!written.length) {
        check(`a .${format} was written for the ${label} one`, false, 'nothing arrived');
        continue;
      }
      const back = await load(page, written[0]);
      if (cast) {
        check(`the ${label} .${format} still takes the cast of its grain`,
          back[1] > back[0] * 1.25 && back[1] > back[2] * 1.25, `rgb(${back})`);
      }
      /* And is what it was, not merely something: multiplied in the wrong
       * light the answer lands somewhere else entirely, and the flat one is
       * where that shows — it has to arrive as grey as it left. */
      check(`the ${label} .${format} comes back what it went out`,
        [0, 1, 2].every((k) => Math.abs(back[k] - source[k]) <= 24),
        `rgb(${back}) against rgb(${source})`);
    }
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
