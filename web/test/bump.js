/* Bump and normal maps, in the browser.
 *
 *   node web/test/bump.js <height.max> <height.png> <normal.max> <normal.png>
 *
 * A .max names the map its material is bumped by; the page has to read it out
 * of the right slot, tell a height map from a normal map, shade with it, and
 * write a normal map — never a height — into the glTF it exports.
 *
 * The shading is checked by taking the relief away and nothing else: same
 * camera, same lights, same colours, so any pixel that moves moved because of
 * the map.
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

/** Every lit pixel of the viewport, for comparing one render against another. */
function pixels(page) {
  return page.evaluate(() => {
    const canvas = document.getElementById('viewport');
    const gl = canvas.getContext('webgl2');
    const out = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, out);
    return Array.from(out);
  });
}

function differing(a, b) {
  let count = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (Math.abs(a[i] - b[i]) > 2 || Math.abs(a[i + 1] - b[i + 1]) > 2
      || Math.abs(a[i + 2] - b[i + 2]) > 2) count++;
  }
  return count;
}

async function load(page, files) {
  const before = await page.evaluate(() => window.fbxtool.loadCount);
  await page.setInputFiles('#file-input', files);
  await page.waitForFunction((seen) => window.fbxtool.loadCount > seen, before,
    { timeout: 120000 });
  await page.waitForTimeout(900);
}

function readGlb(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const jsonLength = view.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength)));
  const binAt = 20 + jsonLength;
  const bin = bytes.subarray(binAt + 8, binAt + 8 + view.getUint32(binAt, true));
  return { json, bin };
}

/**
 * The pixel at the middle of an image, decoded in the page.
 *
 * The middle rather than the average: a map's edges wrap, and the one column
 * where a ramp starts over leans the opposite way to all the others.
 */
function centrePixel(page, bytes) {
  return page.evaluate(async (data) => {
    const image = await createImageBitmap(new Blob([new Uint8Array(data)]));
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(image, 0, 0);
    const x = image.width >> 1;
    const y = image.height >> 1;
    const px = context.getImageData(x, y, 1, 1).data;
    return { r: px[0], g: px[1], b: px[2], width: image.width };
  }, Array.from(bytes));
}

async function main() {
  const [heightModel, heightImage, normalModel, normalImage] = process.argv.slice(2);
  const browser = await launch(chromium);
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto(`file://${PAGE}`);
  await page.waitForFunction(() => document.body.dataset.ready === 'true', { timeout: 20000 });

  console.log('a height map in the bump slot');
  await load(page, [heightModel, heightImage]);

  const state = await page.evaluate(() => ({
    bumpLayers: window.fbxtool.viewer.bumpLayers,
    colourLayers: window.fbxtool.viewer.textureLayers,
    slots: window.fbxtool.palette.map((m) => Object.keys(m.textures || {})).flat(),
    kinds: window.fbxtool.palette.map((m) => m.bumpIsNormalMap),
    layers: window.fbxtool.palette.map((m) => m.bumpLayer),
  }));
  check('the map reached the page in the normal slot',
    state.slots.includes('normal'), state.slots.join(', ') || 'none');
  check('and was uploaded as a layer of its own',
    state.bumpLayers === 1, `${state.bumpLayers} layer(s)`);
  check('the material points at it',
    state.layers.some((l) => l === 0), state.layers.join(', '));
  check('a grey map is read as a height, not a direction',
    state.kinds.every((k) => k === false), state.kinds.join(', '));

  const shaded = await pixels(page);
  // Take away the relief and nothing else.
  await page.evaluate(() => {
    for (const m of window.fbxtool.palette) m.bumpLayer = -1;
    window.fbxtool.viewer.setPalette(window.fbxtool.palette);
  });
  await page.waitForTimeout(700);
  const flat = await pixels(page);
  const moved = differing(shaded, flat);
  check('the surface is shaded by it', moved > 200, `${moved} pixels differ`);

  // ---- what an export makes of it, on a page that has not been meddled with
  console.log('\nand what the export makes of it');
  await page.reload();
  await page.waitForFunction(() => document.body.dataset.ready === 'true', { timeout: 20000 });
  await load(page, [heightModel, heightImage]);
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 180000 }),
    page.click('#export-gltf'),
  ]);
  const saved = path.join(path.dirname(await download.path()), 'bump.glb');
  await download.saveAs(saved);
  const { json, bin } = readGlb(new Uint8Array(fs.readFileSync(saved)));
  const material = (json.materials || []).find((m) => m.normalTexture);
  check('the export writes a normal texture', !!material,
    `${(json.materials || []).length} material(s)`);
  if (material) {
    const image = json.images[json.textures[material.normalTexture.index].source];
    const view = json.bufferViews[image.bufferView];
    const bytes = bin.subarray(view.byteOffset || 0, (view.byteOffset || 0) + view.byteLength);
    const middle = await centrePixel(page, bytes);
    const rgb = `rgb ${middle.r}, ${middle.g}, ${middle.b}`;
    /* The fixture is a height ramp getting brighter to the right and
     * downwards. Written straight out it would still be grey — the middle of
     * a ramp is mid-grey, every channel alike. Turned into the normals it
     * stands for it is mostly blue, because most of the surface still faces
     * outwards, which is the difference this is looking for. */
    check('it holds normals rather than the height it came from',
      middle.b > 200 && middle.b - middle.r > 50, rgb);
    /* And it leans the right way: a surface climbing towards +U and +V faces
     * away from both, so red and green sit below the middle. Backwards, every
     * bump on the model would read as a dent. */
    check('and they lean away from the climb, not into it',
      middle.r < 128 && middle.g < 128, rgb);
    check('the map keeps its own size', middle.width === 64, `${middle.width}px`);
  }

  console.log('\na normal map in the same slot');
  await page.reload();
  await page.waitForFunction(() => document.body.dataset.ready === 'true', { timeout: 20000 });
  await load(page, [normalModel, normalImage]);
  const asNormal = await page.evaluate(() => {
    const bumped = window.fbxtool.palette.filter((m) => m.bumpLayer >= 0);
    return {
      kinds: bumped.map((m) => m.bumpIsNormalMap),
      strength: bumped.map((m) => m.bumpStrength),
    };
  });
  check('a blue map is read as a direction',
    asNormal.kinds.length > 0 && asNormal.kinds.every((k) => k === true),
    asNormal.kinds.join(', ') || 'no bumped material');
  check('and is taken as written', asNormal.strength.every((s) => s === 1),
    asNormal.strength.join(', '));

  check('no console errors', errors.length === 0, errors.slice(0, 2).join(' | ') || 'clean');
  await browser.close();

  console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(1); });
