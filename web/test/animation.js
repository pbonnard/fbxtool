/* The animations that sit beside an Assetto Corsa car, played.
 *
 *   node web/test/animation.js <folder holding a .kn5 and animations/>
 *
 * Everything under `animations/` beside a `.kn5` is one clip, and a clip names
 * some of the model's nodes and gives each of them a row of placements. There
 * is no clock in the file: the game plays one by *position* — the wheel is
 * however far through `steer.ksanim` it is turned, the door however far
 * through `car_door_L.ksanim` it is open — so what this drives is a slider
 * from nought to one.
 *
 * The fixture is a car of two cubes, one behind the other. The near one hangs
 * off a node called `door` and the far one off `body`, and beside them:
 *
 *   swing       moves `door` a quarter turn about its own hinge, over three
 *               keys. At position 0 it must stand exactly where the file has
 *               it, because a key is the node's whole placement and the first
 *               one is what the model already said; at position 1 it must have
 *               gone somewhere, and `body` must not have moved with it.
 *   sink        moves `rig`, which is the node `door` hangs off and which
 *               carries no mesh at all. Nothing names the door, and the door
 *               has to move anyway — a clip that only reached the nodes that
 *               hold meshes would leave every rigged car still.
 *   stranger    names a node this car has not got, which is a clip copied from
 *               another car. It brings nothing and must not be offered.
 *   gas         names nothing but `DRIVER:` nodes — the driver's rig, which is
 *               a separate model living inside the game rather than beside the
 *               car. 48 of the 123 clips across the cars to hand are this, and
 *               it must not be offered either.
 *
 * And the picture is read three ways round, because the position is used in
 * three shaders and a car that moves in one of them is worse than one that
 * moves in none: what is drawn, what the ground shadow is drawn from, and what
 * a click on the moved part comes back as.
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

/** The whole viewport as one number, so two draws can be told apart. */
function frameOf(page) {
  return page.evaluate(() => {
    const canvas = document.getElementById('viewport');
    const gl = canvas.getContext('webgl2');
    const px = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let hash = 2166136261;
    let lit = 0;
    for (let at = 0; at < px.length; at += 4) {
      for (let k = 0; k < 3; k++) hash = Math.imul(hash ^ px[at + k], 16777619) >>> 0;
      if (px[at] + px[at + 1] + px[at + 2] > 24) lit++;
    }
    return { hash, lit };
  });
}

/** Where the viewer has been told to put each part. */
function poseOf(page) {
  return page.evaluate(() => {
    const view = window.fbxtool.viewer;
    return { animated: !!view.animated, parts: view.partCount };
  });
}

async function place(page, position) {
  await page.fill('#anim-slider', String(Math.round(position * 1000)));
  await page.dispatchEvent('#anim-slider', 'input');
  await page.waitForTimeout(400);
  return frameOf(page);
}

async function main() {
  const [folder] = process.argv.slice(2);
  if (!folder) {
    console.error('usage: node web/test/animation.js <folder>');
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
  await page.goto(`file://${PAGE}`);
  await page.waitForFunction(() => document.body.dataset.ready === 'true', { timeout: 20000 });

  const before = await page.evaluate(() => window.fbxtool.loadCount);
  await page.setInputFiles('#folder-input', folder);
  await page.waitForFunction((seen) => window.fbxtool.loadCount > seen, before,
    { timeout: 180000 });
  await page.waitForTimeout(900);

  console.log('what the folder brought');
  const offered = await page.evaluate(() => {
    const select = document.getElementById('anim-select');
    return {
      hidden: select.hidden,
      options: [...select.options].map((o) => o.textContent),
      values: [...select.options].map((o) => o.value),
    };
  });
  check('the picker is offered', offered.hidden === false);
  check('the clip that moves a node of this car is listed',
    offered.options.some((o) => /^swing — 1 node$/.test(o)), offered.options.join(' | '));
  check('and so is the one that moves the node above it',
    offered.values.includes('sink'), offered.options.join(' | '));
  check('the one naming a node this car has not got is not offered',
    !offered.values.includes('stranger'), offered.options.join(' | '));
  check('nor is the driver\'s own rig', !offered.values.includes('gas'),
    offered.options.join(' | '));
  check('and both are counted rather than left unsaid',
    offered.options.some((o) => /2 more move nothing here.*driver/.test(o)),
    offered.options.join(' | '));

  const still = frameOf(page);
  check('nothing is moving until something is chosen',
    (await poseOf(page)).animated === false);

  console.log('\nthe clip that swings the door');
  await page.selectOption('#anim-select', 'swing');
  await page.waitForTimeout(600);
  const shut = frameOf(page);
  /* The strictest thing a clip can be asked. A key is the node's whole local
   * placement and the first one is what the model already stated, so the car
   * at position 0 has to be the car the file describes — pixel for pixel.
   * Read as a change to the placement rather than as the placement, the first
   * key would move a car that is not moving. */
  check('at the start of a clip the car is exactly what the file has',
    (await shut).hash === (await still).hash,
    `${(await shut).hash} against ${(await still).hash}`);

  const open = await place(page, 1);
  check('and at the end of it the car has moved',
    open.hash !== (await still).hash, `${open.hash} against ${(await still).hash}`);
  check('the viewer knows it is moving one', (await poseOf(page)).animated === true);

  const half = await place(page, 0.5);
  check('and halfway is neither', half.hash !== open.hash
    && half.hash !== (await still).hash, `${half.hash}`);

  /* The door is one of two cubes and the other must be where it was. Told to
   * move a part, a viewer that moves the whole model looks entirely correct
   * until something stands beside it. */
  console.log('\nand what it leaves alone');
  const named = await page.evaluate(() => window.fbxtool.partTable.map((p) => p.name));
  check('the car is still two parts', named.length === 2, named.join(', '));
  /* Read against the clip's own account of itself: it names one node of this
   * car, so one node is what may move however many the file lists. */
  const said = await page.evaluate(() => window.fbxtool.clips);
  check('and the clip says it moves one of them',
    said.some((clip) => clip.name === 'swing' && clip.matched === 1
      && clip.version === 2 && clip.keys === 3), JSON.stringify(said));

  console.log('\nthe clip that moves the node above the mesh');
  await page.selectOption('#anim-select', 'sink');
  await page.waitForTimeout(600);
  const rigStill = frameOf(page);
  const rigMoved = await place(page, 1);
  check('a clip naming a node that carries no mesh still moves what hangs off it',
    rigMoved.hash !== (await rigStill).hash,
    `${rigMoved.hash} against ${(await rigStill).hash}`);

  console.log('\nand the three shaders that have to agree about it');
  /* The picture, the shadow and the part under the mouse are three passes over
   * the same geometry, and the position is applied in each. A car that moves
   * in one of them is worse than one that moves in none: the shadow of a shut
   * door under an open one, and a click that lands on where a part used to be.
   */
  await page.selectOption('#anim-select', 'swing');
  await page.waitForTimeout(500);
  await place(page, 1);
  const picked = await page.evaluate(() => {
    const view = window.fbxtool.viewer;
    const canvas = document.getElementById('viewport');
    const seen = new Set();
    // Read the pick buffer across the whole picture: whatever the moved part
    // is now over, it is what a click there has to report.
    for (let y = 0; y < canvas.clientHeight; y += 8) {
      for (let x = 0; x < canvas.clientWidth; x += 8) {
        const at = view.pickPart(x, y);
        if (at >= 0) seen.add(at);
      }
    }
    return [...seen].sort();
  });
  check('the mouse can still find both parts once one has moved',
    picked.length === 2, `parts ${picked.join(', ')}`);


  console.log('\nand the button that sweeps the position');
  await page.fill('#anim-slider', '0');
  await page.dispatchEvent('#anim-slider', 'input');
  await page.waitForTimeout(300);
  await page.click('#anim-play');
  await page.waitForTimeout(700);
  const sweeping = await page.evaluate(() => ({
    at: Number(document.getElementById('anim-slider').value),
    says: document.getElementById('anim-play').textContent,
  }));
  check('the position moves along on its own', sweeping.at > 0, `at ${sweeping.at}`);
  check('and the button offers to stop', sweeping.says === 'stop', sweeping.says);

  await page.click('#anim-play');
  await page.waitForTimeout(500);
  const held = await page.evaluate(() => Number(
    document.getElementById('anim-slider').value));
  await page.waitForTimeout(500);
  const stopped = await page.evaluate(() => ({
    at: Number(document.getElementById('anim-slider').value),
    says: document.getElementById('anim-play').textContent,
  }));
  check('stopping leaves it where it was rather than at either end',
    stopped.at === held && stopped.at > 0, `${held} then ${stopped.at}`);
  check('and the button offers to play again', stopped.says === 'play', stopped.says);

  /* Dragging is the other way of playing one, and the two must not both be
   * driving the slider: a sweep left running under the hand fights it. */
  await page.click('#anim-play');
  await page.waitForTimeout(300);
  await page.fill('#anim-slider', '250');
  await page.dispatchEvent('#anim-slider', 'input');
  await page.waitForTimeout(600);
  const dragged = await page.evaluate(() => Number(
    document.getElementById('anim-slider').value));
  check('taking hold of the slider stops the sweep', dragged === 250, `at ${dragged}`);

  console.log('\nand taking it off again');
  await page.selectOption('#anim-select', '');
  await page.waitForTimeout(600);
  const back = frameOf(page);
  check('the car is what it was', (await back).hash === (await still).hash,
    `${(await back).hash} against ${(await still).hash}`);
  check('and nothing is moving', (await poseOf(page)).animated === false);

  check('no page errors', errors.length === 0, errors.join(' | ') || 'clean');

  await browser.close();
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
