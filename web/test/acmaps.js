/* The game's own per-texel finish — what a `.kn5` calls `txMaps`.
 *
 *   node web/test/acmaps.js <dark.kn5> <bright.kn5> <tiled.kn5>
 *
 * 201 of the 528 materials across the cars to hand bind one. That is every
 * `ksPerPixelMultiMap`, which is what a car's body wears, and it is what keeps
 * a badge, a shut line and a chrome strip from taking the same highlight as
 * the panel around them. Stated for the whole material instead, a body is one
 * uniform gloss and the trim on it disappears.
 *
 * What its channels are was settled by decoding them rather than by reading
 * the name — `tools/maps_channels.js`, over the 221 that could be decoded. Red
 * is the level: it varies on 175 of them, and where it does not it sits at an
 * arbitrary constant, which is what a level does. Green is a multiplier over
 * it: it is flat on 142, and 133 of those are flat at exactly 1, which is what
 * a multiplier's default looks like and not what an unused channel looks like.
 *
 * The two cars here differ in one thing: the red channel of the map, at nought
 * and at one. So with the switch on they take no highlight and all of it, and
 * with it off they are the same car twice — because off is the reading that
 * has nowhere to put the map, which is the state this whole thing came from.
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

/** How bright the middle of the viewport is, 0-255, averaged over the cube. */
function sample(page) {
  return page.evaluate(() => {
    const canvas = document.getElementById('viewport');
    const gl = canvas.getContext('webgl2');
    const half = 40;
    const cx = Math.round(canvas.width / 2);
    const cy = Math.round(canvas.height / 2);
    const px = new Uint8Array(half * 2 * half * 2 * 4);
    gl.readPixels(cx - half, cy - half, half * 2, half * 2, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let total = 0;
    for (let i = 0; i < px.length; i += 4) total += (px[i] + px[i + 1] + px[i + 2]) / 3;
    return Math.round(total / (px.length / 4));
  });
}

async function load(page, file) {
  const before = await page.evaluate(() => window.fbxtool.loadCount);
  await page.setInputFiles('#file-input', [file]);
  await page.waitForFunction((seen) => window.fbxtool.loadCount > seen, before,
    { timeout: 120000 });
  await page.waitForTimeout(700);
}

async function setSwitch(page, on) {
  await page.evaluate((want) => {
    const box = document.getElementById('shaders-toggle');
    if (box.checked !== want) box.click();
  }, on);
  await page.waitForTimeout(500);
}

async function main() {
  const [darkFile, brightFile, tiledFile] = process.argv.slice(2);
  if (!darkFile || !brightFile || !tiledFile) {
    console.error('usage: node web/test/acmaps.js <dark.kn5> <bright.kn5> <tiled.kn5>');
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
  await page.goto(`file://${PAGE}`);
  await page.waitForFunction(() => document.body.dataset.ready === 'true', { timeout: 20000 });

  console.log('the map reaches the palette at all');
  await load(page, darkFile);
  const held = await page.evaluate(() => {
    const entry = window.fbxtool.palette[0] || {};
    return {
      // Bound under a slot of its own, and not mistaken for a PBR map: read as
      // a metallic-roughness one, a bright mask makes chrome of every panel.
      acMaps: !!(entry.textures && entry.textures.acMaps),
      metallicRoughness: !!(entry.textures && entry.textures.metallicRoughness),
      layer: entry.acMapsLayer,
    };
  });
  check('it is carried under a slot of its own', held.acMaps === true,
    JSON.stringify(held));
  check('and not as the metallic-roughness map it resembles',
    held.metallicRoughness === false, String(held.metallicRoughness));
  check('and it reached a texture layer', held.layer >= 0, String(held.layer));

  console.log('with the switch on, the level in it weighs the highlight');
  await setSwitch(page, true);
  const darkOn = await sample(page);
  await load(page, brightFile);
  await setSwitch(page, true);
  const brightOn = await sample(page);
  check('a map stating no highlight draws darker than one stating all of it',
    brightOn > darkOn + 2, `dark ${darkOn} against bright ${brightOn}`);

  console.log('and with it off the map has nowhere to go, as before');
  await setSwitch(page, false);
  const brightOff = await sample(page);
  await load(page, darkFile);
  await setSwitch(page, false);
  const darkOff = await sample(page);
  check('the two cars are the same car twice',
    Math.abs(brightOff - darkOff) <= 1, `dark ${darkOff} against bright ${brightOff}`);

  console.log('and a shader stating its two scales apart gets both');
  /* `ksPerPixelNM_UVMult` gives the colour and the relief a multiplier each —
   * 32 materials across the cars to hand, at a median of 12.5 and 195 — which
   * is how a tyre sidewall carries lettering at one scale and a grain at
   * another off two pictures otherwise the same size. Tiled, a four-texel
   * chequer becomes a fine weave, which is a different picture and so a
   * different brightness; untiled it is four big squares. */
  await load(page, tiledFile);
  await setSwitch(page, true);
  const tiled = await sample(page);
  await setSwitch(page, false);
  const flat = await sample(page);
  check('the colour is tiled by what the material states',
    Math.abs(tiled - flat) > 2, `tiled ${tiled} against untiled ${flat}`);
  const stated = await page.evaluate(() => (window.fbxtool.palette[0] || {}).ac || null);
  check('and the two scales are carried apart',
    stated && stated.diffuseTiling === 8 && stated.normalTiling === 4,
    JSON.stringify(stated));
  /* And the half of them that state nought for the colour mean a multiplier
   * nobody set, not one set to nothing: taken literally the whole picture
   * collapses into its first texel. */
  await load(page, darkFile);
  const none = await page.evaluate(() => (window.fbxtool.palette[0] || {}).ac || null);
  check('a material stating no multiplier is tiled once',
    none && none.diffuseTiling === 1 && none.normalTiling === 1,
    JSON.stringify(none));

  check('no page errors', errors.length === 0, errors.join(' | ') || 'clean');
  await browser.close();
  console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
