/* Putting a skin on a car, which is how an Assetto Corsa car gets its paint.
 *
 *   node web/test/skin.js <folder holding a .kn5 and skins/>
 *
 * A `.kn5` holds the car unpainted. Everything under `skins/<name>/` beside it
 * replaces the texture of that name, and the skin's own two settings files say
 * what colour the paint is and which material of the car it goes on. Read
 * straight, without any of that, an Audi S8 comes up white from end to end and
 * looks like something has gone wrong.
 *
 * The fixture is two cubes wearing a white panel map — which is what a paint
 * map is — beside three skins that between them cover every way this can go:
 *
 *   Red       states a colour and a material the car has, in its own config
 *   Pair      states two colours and no materials at all, and takes them from
 *             the car's own `extension/ext_config.ini` — which is where half
 *             of them are declared, once for the whole car. A Renault 5 names
 *             `body`, `body2` and `rim_colored` there, and its skins pair
 *             those with `extBody1`, `extBody2` and `extRims1` by order.
 *   Stranger  states a colour for a material the car has not got, which is
 *             what a config copied from another car does, and is answered by
 *             what the car itself calls its paint
 *   Bare      states no colour anywhere, and is offered for its pictures only
 *   Chip      states none either, but carries the `livery.png` every skin has
 *             — a rounded square of the paint over a band of dark reflection,
 *             which is the only thing left saying what colour it is
 *
 * The car also wears a material that takes almost none of the light, which is
 * what an Audi S8's wheels are: `ksAmbient` at 0.03 and `ksDiffuse` at 0.01
 * under the same white map as the paint. Read without those the rims, the lamp
 * housings and the carbon mirror caps all come up as bright as the body.
 *
 * Then a second car with no skins at all is opened over the top, since what
 * stood beside the last one does not stand beside this one and a picker still
 * offering the old paint is worse than no picker.
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

async function wear(page, name) {
  await page.selectOption('#skin-select', name);
  await page.waitForTimeout(900);
  return sample(page);
}

/**
 * The whole viewport as one number.
 *
 * The middle of it is the body and says nothing about the trim standing beside
 * it, and it is the trim that carries the picture only one skin replaces.
 */
function frameOf(page) {
  return page.evaluate(() => {
    const canvas = document.getElementById('viewport');
    const gl = canvas.getContext('webgl2');
    const px = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let hash = 2166136261;
    for (let at = 0; at < px.length; at += 4) {
      for (let k = 0; k < 3; k++) hash = Math.imul(hash ^ px[at + k], 16777619) >>> 0;
    }
    return hash;
  });
}

/** Everything the palette holds, as one string to compare against another. */
function paletteOf(page) {
  return page.evaluate(() => window.fbxtool.palette
    .map((m) => `${m.name}:${FbxPalette.toHex(m.colour)}:${m.layer}:${m.tintTexture}`)
    .join('|'));
}

/** What the palette says a material's colour is, as "#rrggbb". */
function colourOf(page, material) {
  return page.evaluate((name) => {
    const entry = window.fbxtool.palette.find((m) => m.name === name);
    return entry ? FbxPalette.toHex(entry.colour) : null;
  }, material);
}

async function main() {
  const [folder, other] = process.argv.slice(2);
  if (!folder || !other) {
    console.error('usage: node web/test/skin.js <folder> <other.kn5>');
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

  const before = await page.evaluate(() => window.fbxtool.loadCount);
  await page.setInputFiles('#folder-input', folder);
  await page.waitForFunction((seen) => window.fbxtool.loadCount > seen, before,
    { timeout: 180000 });
  await page.waitForTimeout(900);

  const offered = await page.evaluate(() => {
    const select = document.getElementById('skin-select');
    return { hidden: select.hidden, options: [...select.options].map((o) => o.textContent) };
  });
  console.log('what the folder brought');
  check('the picker is offered', offered.hidden === false);
  check('every skin is listed, and what each brings', offered.options.length === 7,
    offered.options.join(' | '));
  check('the one that states a material in its own config says so',
    offered.options.some((o) => /^Red — 1 texture \+ 1 paint$/.test(o)),
    offered.options.join(' | '));
  check('the one whose config is for another car is answered by the car',
    offered.options.some((o) => /^Stranger — 1 texture \+ 2 paints$/.test(o)),
    offered.options.join(' | '));
  check('and the one that states no colour is offered for its pictures',
    offered.options.some((o) => /^Bare — 2 textures$/.test(o)),
    offered.options.join(' | '));
  check('the one taking its materials from the car states both',
    offered.options.some((o) => /^Pair — 1 texture \+ 2 paints$/.test(o)),
    offered.options.join(' | '));

  console.log('\nthe car as the file has it');
  const bare = await wear(page, '');
  check('white, which is what the paint map is', Math.min(...bare) > 120, `rgb(${bare})`);
  /* And the one that takes almost none of the light is not white, under the
   * same map. `ksAmbient` and `ksDiffuse` weight the two halves of the game's
   * own lighting, and both halves are diffuse — so with one fixed light they
   * have nowhere to go but the albedo. */
  const paint = await colourOf(page, 'carpaint');
  const dim = await colourOf(page, 'sill');
  check('a material stating no weights takes the light as it comes',
    paint === '#ffffff', paint);
  check('and one stating almost none is nearly black', dim === '#363636', dim);

  console.log('\nwearing the skin that names its paint');
  const red = await wear(page, 'Red');
  /* Red, and the map still under it.
   *
   * Twice its own green rather than three times: a paint a config states is
   * the game's own multiplier and goes on as the number it says, so the `20`
   * of `#DD2010` is an eighth of the light and not the fiftieth the sRGB
   * curve would make of it. A stated colour is less saturated in the light
   * than it looks in a picker, which is the whole of what that reading is. */
  check('painted, and the map still under it',
    red[0] > red[1] * 2 && red[0] > red[2] * 2, `rgb(${red})`);
  check('and darker than the bare car, since a tint multiplies',
    red[1] < bare[1], `rgb(${red}) against rgb(${bare})`);

  console.log('\nwearing the one that takes its materials from the car itself');
  await wear(page, 'Pair');
  const first = await colourOf(page, 'carpaint');
  const second = await colourOf(page, 'trim');
  /* The colours the skin states, shown as the light they are rather than as
   * the swatch they were written as: `#2010dd` taken straight is a brighter,
   * bluer thing than the same six characters read through the sRGB curve, and
   * this is what it looks like once it is light. */
  check('the first colour went on the first material named', first === '#6347ef', first);
  check('and the second on the second, paired by order', second === '#47ef63', second);

  console.log('\nwearing the one whose config names a material this car has not got');
  const stranger = await wear(page, 'Stranger');
  check('the car answers with its own paint',
    stranger[0] > stranger[1] * 2, `rgb(${stranger})`);

  console.log('\nand the one that states no colour at all');
  const unpainted = await wear(page, 'Bare');
  check('nothing is invented for it', Math.min(...unpainted) > 120, `rgb(${unpainted})`);
  /* But its picture is on, which is the only thing it brings. Nothing else
   * here can say so: every other skin changes the colour as well, and a
   * colour that changed is what the eye reads as the skin having changed —
   * so a switch that never re-read the pictures at all would pass every
   * check but this one. */
  check('and the picture it brought is the one being drawn',
    unpainted[0] < bare[0] - 8 && Math.abs(unpainted[0] - unpainted[2]) < 6,
    `rgb(${unpainted}) against rgb(${bare})`);

  console.log('\nand the one whose colour is only in the picture of it');
  await wear(page, 'Chip');
  const chip = await colourOf(page, 'carpaint');
  check('the chip is read, over the dark band under it', chip === '#2010dd', chip);
  /* And the one that brings the paint's own picture, whose chip is not
   * read. The colour is in that picture already, and a chip over the top
   * paints it twice: a Lancia Beta Montecarlo's seven skins each replace
   * the `LANCIA_body.dds` its `lancia_body_paint` wears and state nothing
   * else at all, so read the other way round every one of its liveries
   * comes out under a flat wash of its own average. */
  await wear(page, 'Livery');
  const carried = await colourOf(page, 'carpaint');
  check('a skin bringing the paint its picture is not painted over it',
    carried !== '#2010dd', carried);
  check('and the material is left as the car had it',
    carried === await colourOf(page, 'trim'),
    `${carried} against ${await colourOf(page, 'trim')}`);

  console.log('\nand taking it off again');
  const off = await wear(page, '');
  check('the car is as it was', Math.abs(off[0] - bare[0]) < 6, `rgb(${off})`);

  /* Switching from one skin to another, which is not the same question.
   *
   * Taking a skin off puts the car back; putting a second one on has to put
   * back everything the first brought that the second does not — and that is
   * the half nobody looks for, because the colour changes and the eye reads
   * that as the skin having changed. Only `Red` here brings a paint map that
   * is not the car's own, so every switch away from it is a chance to leave a
   * picture behind.
   *
   * What is checked is that a skin worn after another is the same as that skin
   * worn from the bare car: every ordered pair, held against the state it
   * should always be.
   */
  console.log('');
  console.log('switching from one skin to another');
  const worn = ['Red', 'Pair', 'Chip', 'Bare'];
  const alone = {};
  for (const name of worn) {
    await wear(page, '');
    await wear(page, name);
    alone[name] = { frame: await frameOf(page), palette: await paletteOf(page) };
  }
  for (const first of worn) {
    for (const second of worn) {
      if (first === second) continue;
      await wear(page, '');
      await wear(page, first);
      await wear(page, second);
      const frame = await frameOf(page);
      const palette = await paletteOf(page);
      const same = frame === alone[second].frame && palette === alone[second].palette;
      check(`${second} after ${first} is ${second}`, same,
        same ? '' : `frame ${frame} against ${alone[second].frame}`);
    }
  }

  console.log('');
  console.log('opening another car over the top of it');
  const loaded = await page.evaluate(() => window.fbxtool.loadCount);
  await page.setInputFiles('#file-input', [other]);
  await page.waitForFunction((seen) => window.fbxtool.loadCount > seen, loaded,
    { timeout: 120000 });
  await page.waitForTimeout(700);
  const after = await page.evaluate(() => {
    const select = document.getElementById('skin-select');
    return { hidden: select.hidden, options: select.options.length };
  });
  check('the picker is put away', after.hidden === true);
  check("and the last car's skins are not still in it", after.options === 0,
    `${after.options} left`);

  check('no page errors', errors.length === 0, errors.join(' | ') || 'clean');

  await browser.close();
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
