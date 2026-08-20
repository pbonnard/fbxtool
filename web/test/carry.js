/* Everything a game states about a surface, and what a glTF can be made to
 * hold of it.
 *
 *   node web/test/carry.js <out-dir> <everything.kn5>
 *
 * glTF describes one shading model and a `.kn5` states rather more than that.
 * What has a slot goes in it — the colour, the metalness, the roughness, the
 * alpha and its threshold. What has an extension goes there: an emissive past
 * white is the factor at its brightest channel with the rest in
 * `KHR_materials_emissive_strength`, which is the same light written the way
 * the format allows. Everything else goes in `extras`, which readers that do
 * not know it ignore — and dropped instead, a car written out and opened
 * again is a PBR approximation of the car that went in.
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

const near = (a, b, slack = 1e-4) => Math.abs(a - b) <= slack;

async function main() {
  const [outDir, model] = process.argv.slice(2);
  if (!outDir || !model) {
    console.error('usage: node web/test/carry.js <out-dir> <everything.kn5>');
    process.exit(2);
  }
  if (!fs.existsSync(PAGE)) {
    console.error(`${PAGE} is missing — run: python3 web/build.py`);
    process.exit(2);
  }

  const browser = await launch(chromium);
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  const written = [];
  page.on('download', async (item) => {
    const to = path.join(outDir, item.suggestedFilename());
    await item.saveAs(to);
    written.push(to);
  });
  await page.goto(`file://${PAGE}`);
  await page.waitForFunction(() => document.body.dataset.ready === 'true', { timeout: 20000 });

  const open = async (target, file) => {
    const seen = await target.evaluate(() => window.fbxtool.loadCount);
    await target.setInputFiles('#file-input', [file]);
    await target.waitForFunction((was) => window.fbxtool.loadCount > was, seen,
      { timeout: 120000 });
    await target.waitForTimeout(800);
  };
  await open(page, model);

  await page.selectOption('#export-format', 'glb');
  await page.click('#export-gltf');
  const until = Date.now() + 120000;
  while (!written.length && Date.now() < until) await page.waitForTimeout(150);
  if (!written.length) {
    check('a .glb was written', false, 'nothing arrived');
    process.exit(1);
  }
  const buffer = fs.readFileSync(written[0]);
  const length = buffer.readUInt32LE(12);
  const json = JSON.parse(buffer.slice(20, 20 + length).toString('utf8'));
  const material = json.materials[0];
  const extras = material.extras || {};

  /* The emissive is stated as 10, 9, 0 — a display rather than a paint. The
   * factor has to stay inside the unit range and the strength carries the
   * rest, and the two multiplied are the light that went in. */
  check('an emissive past white keeps its strength',
    near(material.emissiveFactor[0] * 10, 10, 0.01)
    && near(material.emissiveFactor[1] * 10, 9, 0.01)
    && material.extensions.KHR_materials_emissive_strength.emissiveStrength === 10,
    JSON.stringify(material.emissiveFactor));
  check('and the extension is declared',
    (json.extensionsUsed || []).includes('KHR_materials_emissive_strength'),
    JSON.stringify(json.extensionsUsed));

  /* The reflectance the file stated, beside the capped one the extension
   * carries: `KHR_materials_specular` is held at the 4% a dielectric has, so
   * without this the 0.07 would be gone. */
  check('the reflectance it stated is carried',
    extras.reflectance && near(extras.reflectance[0], 0.07, 0.001),
    JSON.stringify(extras.reflectance));

  /* And the extension itself is still held at the 4% a dielectric has, which
   * is what every reader but this one goes by. Carrying the stated number was
   * never an argument for raising that. */
  const spec = (material.extensions || {}).KHR_materials_specular;
  check('while the extension stays inside what a dielectric reflects',
    !spec || spec.specularColorFactor.every((c) => c <= 1.0001),
    spec ? JSON.stringify(spec.specularColorFactor) : 'not written, being above the cap');

  check('and the shape of what it returns',
    near(extras.fresnelExp, 3.5, 0.01) && near(extras.fresnelCeiling, 0.6, 0.01),
    `exp ${extras.fresnelExp}, ceiling ${extras.fresnelCeiling}`);
  check('how it answers the sun',
    near(extras.specularWeight, 0.5, 0.01) && extras.sunRoughness > 0,
    `weight ${extras.specularWeight}, roughness ${extras.sunRoughness}`);
  check('that what it returns is added',
    extras.additive === true, String(extras.additive));
  check('how often its grain is tiled and how much of the grain shapes it',
    near(extras.detailTiling, 20, 0.01) && near(extras.detailNormalBlend, 0.3, 0.01),
    `tiling ${extras.detailTiling}, blend ${extras.detailNormalBlend}`);
  check('the grain\'s own relief, which glTF has no second normal slot for',
    extras.detailNormalTexture && extras.detailNormalTexture.index >= 0,
    JSON.stringify(extras.detailNormalTexture));
  /* The game's own per-texel finish. 201 of the 528 materials across the cars
   * to hand bind one — every `ksPerPixelMultiMap`, which is what a car's body
   * wears — and with nothing here to name it, it matched no slot, never
   * reached the palette and never reached the file: the largest single thing a
   * car lost on the way through. Written under `extras` rather than as the
   * metallic-roughness map it resembles, since its channels drive a
   * Blinn-Phong highlight and put in that slot every panel comes out with a
   * metalness and a roughness nobody wrote. */
  check('the game\'s own per-texel finish, which is not a PBR map',
    extras.acMapsTexture && extras.acMapsTexture.index >= 0,
    JSON.stringify(extras.acMapsTexture));
  check('and it is not mistaken for a metallic-roughness map',
    !(material.pbrMetallicRoughness || {}).metallicRoughnessTexture,
    JSON.stringify((material.pbrMetallicRoughness || {}).metallicRoughnessTexture));
  check('the shading model the file named',
    extras.shader === 'ksPerPixelMultiMap_NMDetail', String(extras.shader));
  check('and that its colour is read through its picture',
    extras.tintsTexture === true, String(extras.tintsTexture));

  /* And what the file said in its own words, so anything not derived above is
   * still there to be derived later. */
  const stated = extras.stated || {};
  const wanted = ['ksAmbient', 'ksDiffuse', 'ksSpecular', 'ksSpecularEXP', 'ksAlphaRef',
    'fresnelC', 'fresnelEXP', 'fresnelMaxLevel', 'isAdditive', 'sunSpecular',
    'sunSpecularEXP', 'useDetail', 'detailUVMultiplier', 'detailNormalBlend'];
  const missing = wanted.filter((key) => stated[key] === undefined);
  check('every parameter the file stated in its own words',
    missing.length === 0, missing.length ? `missing ${missing.join(', ')}` : `${wanted.length} of them`);
  check('including the one written as a colour',
    Array.isArray(stated.ksEmissive) && stated.ksEmissive[0] === 10,
    JSON.stringify(stated.ksEmissive));

  /* And out and back again, in both spellings.
   *
   * The point of carrying all of it is that a car written out and opened
   * again is the car that went in. glTF keeps the extra in `extras` and FBX
   * under the names the properties arrived with — different corners, the same
   * surface — so the reading has to come back the same either way.
   */
  const KEEP = ['colour', 'specular', 'roughness', 'metallic', 'emissive', 'opacity',
    'alphaMode', 'alphaCutoff', 'specularWeight', 'sunRoughness', 'additive',
    'fresnelExp', 'fresnelCeiling', 'detailTiling', 'detailNormalBlend',
    'tintTexture', 'shader'];
  const readBack = () => page.evaluate((keys) => {
    const entry = window.fbxtool.palette[0];
    const out = {};
    for (const key of keys) {
      const value = entry[key];
      out[key] = Array.isArray(value) ? value.map((v) => Math.round(v * 1e4) / 1e4)
        : (typeof value === 'number' ? Math.round(value * 1e4) / 1e4 : value);
    }
    return out;
  }, KEEP);

  // Already open, and re-selecting the file that is open fires nothing.
  const original = await readBack();
  for (const format of ['glb', 'fbx']) {
    written.length = 0;
    await page.selectOption('#export-format', format);
    await page.click('#export-gltf');
    const waited = Date.now() + 120000;
    while (!written.length && Date.now() < waited) await page.waitForTimeout(150);
    if (!written.length) {
      check(`a .${format} was written`, false, 'nothing arrived');
      continue;
    }
    await open(page, written[0]);
    const back = await readBack();
    const moved = KEEP.filter((key) =>
      JSON.stringify(original[key]) !== JSON.stringify(back[key]));
    check(`every value survives the trip through a .${format}`, moved.length === 0,
      moved.length ? moved.map((k) =>
        `${k} ${JSON.stringify(original[k])} -> ${JSON.stringify(back[k])}`).join('; ')
        : `${KEEP.length} of them`);
    // Back to the model itself for the next spelling.
    await open(page, model);
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
