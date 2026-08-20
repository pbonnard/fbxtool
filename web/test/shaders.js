/* The switch between a game's own material model and the approximation of it.
 *
 *   node web/test/shaders.js <out-dir> <chrome.kn5> <paint.kn5> <plain.fbx>
 *
 * A `.kn5` states no metalness. The reader infers one from how much the surface
 * reflects facing you — no dielectric reflects more than about 17% and no
 * conductor less than half — and splits the colour between a diffuse and a
 * conductor's reflectance on the strength of it. That inference is a good
 * reading of the file and it is still a reading: the game shades a car with a
 * Blinn-Phong highlight and a Fresnel over it, and chrome is a material whose
 * reflection an artist set high rather than a metal.
 *
 * So the switch. On, the surface is what the game says: the whole of the light
 * it takes as its albedo, the Fresnel it stated as its reflection, and no
 * conductor anywhere. Off, it is what this tool derives, which is what it drew
 * before the switch existed.
 *
 * Three things are checked. That the switch moves the pixels. That it settles
 * the file as well as the view, in both spellings — what you are looking at is
 * what comes out. And that a file stating no shader at all never sees it, since
 * a switch with nothing to switch to is worse than no switch.
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
  const [outDir, carFile, paintFile, plainFile] = process.argv.slice(2);
  if (!outDir || !carFile || !paintFile || !plainFile) {
    console.error('usage: node web/test/shaders.js '
      + '<out-dir> <chrome.kn5> <paint.kn5> <plain.fbx>');
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
    const to = path.join(outDir, `${written.length}-${item.suggestedFilename()}`);
    await item.saveAs(to);
    written.push(to);
  });
  await page.goto(`file://${PAGE}`);
  await page.waitForFunction(() => document.body.dataset.ready === 'true', { timeout: 20000 });

  console.log('a car states a game material, so the switch is there and on');
  await load(page, carFile);
  const shown = await page.evaluate(() => ({
    hidden: document.getElementById('shaders-label').hidden,
    checked: document.getElementById('shaders-toggle').checked,
    // What the palette carries of the game's own reading, beside the derived
    // one. Both, always: the switch is a uniform and not a rebuild.
    ac: (window.fbxtool.palette[0] || {}).ac || null,
    metallic: (window.fbxtool.palette[0] || {}).metallic,
  }));
  check('the switch is offered', shown.hidden === false, JSON.stringify(shown));
  check('and starts on, the game\'s own reading being the better one for a car',
    shown.checked === true, String(shown.checked));
  check('the palette carries what the game stated', shown.ac
    && typeof shown.ac.weight === 'number' && typeof shown.ac.facing === 'number',
    JSON.stringify(shown.ac));
  /* The fixture is chrome as a `.kn5` spells it: a reflection an artist set
   * high, which the reader reads as a conductor. That inference is the whole of
   * what the switch turns off, so a fixture without it would prove nothing. */
  check('and the derived reading made a metal of it', shown.metallic > 0.5,
    String(shown.metallic));

  console.log('and it moves the pixels');
  const on = await sample(page);
  await setSwitch(page, false);
  const off = await sample(page);
  check('the two readings do not draw the same surface',
    Math.abs(on - off) > 3, `on ${on} against off ${off}`);

  console.log('and a colour set by hand survives it');
  /* The regression this guards. A skin's paint and a colour set by hand are
   * multiplied into the albedo before the switch is ever read, so a switch that
   * substituted the file's own weight instead would unpaint every car the
   * moment it went on. What it does is undo the split, which keeps both — and
   * on a material the reader read as no conductor at all, which is most of them
   * and which this second car is, it leaves the albedo exactly where it was.
   *
   * A different car, because the chrome above is the one case where this cannot
   * hold: read as a pure conductor its diffuse was multiplied by nought, and a
   * paint on it was lost to the same nought long before the switch existed. */
  await load(page, paintFile);
  await setSwitch(page, true);
  const painted = await sample(page);
  await page.evaluate(() => window.fbxtool.editMaterial(
    window.fbxtool.palette[0].name, { colour: [0.02, 0.02, 0.02] }));
  await page.waitForTimeout(500);
  const darkened = await sample(page);
  check('a material darkened by hand is drawn darker with the switch on',
    darkened < painted - 3, `${painted} then ${darkened}`);
  await page.evaluate(() => window.fbxtool.clearMaterials());
  await page.waitForTimeout(500);
  await load(page, carFile);
  await setSwitch(page, true);

  console.log('the file follows the view, in both spellings');
  for (const [format, extension] of [['glb', 'glb'], ['fbx', 'fbx']]) {
    await page.selectOption('#export-format', format);
    for (const want of [true, false]) {
      const before = written.length;
      await setSwitch(page, want);
      await page.click('#export-gltf');
      const until = Date.now() + 120000;
      while (written.length === before && Date.now() < until) await page.waitForTimeout(150);
      check(`a .${extension} was written with the switch ${want ? 'on' : 'off'}`,
        written.length > before, `${written.length} file(s)`);
    }
  }

  /* The glTF pair, taken apart. With the switch on there is no conductor and
   * the base colour is the whole of the light the surface takes; with it off
   * the metalness the reader inferred is there and the colour is split by it. */
  const glbs = written.filter((f) => f.endsWith('.glb'));
  const read = (file) => {
    const buffer = fs.readFileSync(file);
    const length = buffer.readUInt32LE(12);
    return JSON.parse(buffer.slice(20, 20 + length).toString('utf8')).materials[0];
  };
  const kept = read(glbs[0]);
  const derived = read(glbs[1]);
  check('the game\'s own reading writes no conductor',
    kept.pbrMetallicRoughness.metallicFactor === 0,
    String(kept.pbrMetallicRoughness.metallicFactor));
  check('and the approximation writes the one it inferred',
    derived.pbrMetallicRoughness.metallicFactor > 0.5,
    String(derived.pbrMetallicRoughness.metallicFactor));
  check('each says which of the two it holds',
    kept.extras.shaderModel === 'ac' && derived.extras.shaderModel === 'pbr',
    `${kept.extras.shaderModel} / ${derived.extras.shaderModel}`);
  /* And what does not change either way: the core stays inside what a stranger
   * can render. Keeping the game's own numbers was never an argument for
   * writing a file that renders wrong everywhere else — they go in `extras`. */
  for (const [label, made] of [['kept', kept], ['derived', derived]]) {
    const spec = (made.extensions || {}).KHR_materials_specular;
    check(`the ${label} file still holds a dielectric at what one reflects`,
      !spec || spec.specularColorFactor.every((c) => c <= 1.0001),
      spec ? JSON.stringify(spec.specularColorFactor) : 'not written');
  }

  console.log('a file stating no game material is never offered the switch');
  await load(page, plainFile);
  const plain = await page.evaluate(() => ({
    hidden: document.getElementById('shaders-label').hidden,
    checked: document.getElementById('shaders-toggle').checked,
    ac: (window.fbxtool.palette[0] || {}).ac || null,
  }));
  check('the switch is hidden', plain.hidden === true, JSON.stringify(plain));
  check('and unticked with it, so the exporter reads what the toolbar shows',
    plain.checked === false, String(plain.checked));
  check('and the palette states no game reading at all',
    plain.ac === null, JSON.stringify(plain.ac));

  check('no page errors', errors.length === 0, errors.join(' | ') || 'clean');
  await browser.close();
  console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
