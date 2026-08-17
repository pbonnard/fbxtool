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
const zlib = require('zlib');
const { chromium } = require('playwright');
const { launch } = require('./chromium');

const ROOT = path.resolve(__dirname, '..', '..');
const PAGE = path.join(ROOT, 'web', 'dist', 'fbxview.html');

//: What each one writes. The readable glTF is two files in an archive, so it
//: arrives as one download and is taken apart again here.
const FORMATS = [
  { value: 'glb', files: 1, suffix: '.glb' },
  { value: 'gltf', files: 1, suffix: '.zip', unzip: true },
  { value: 'fbx', files: 1, suffix: '.fbx' },
];

/**
 * Take an archive apart, walking its central directory as a reader should.
 *
 * Not the writer's own code and not a library: the point of reading it back is
 * that something else can. The directory is what a reader trusts — a local
 * header repeats it, so agreeing with both is the check worth making.
 */
function unzip(file, into) {
  const bytes = fs.readFileSync(file);
  let end = bytes.length - 22;
  while (end >= 0 && bytes.readUInt32LE(end) !== 0x06054b50) end -= 1;
  if (end < 0) throw new Error('no end-of-central-directory record');
  const count = bytes.readUInt16LE(end + 10);
  let at = bytes.readUInt32LE(end + 16);
  const written = [];
  for (let n = 0; n < count; n++) {
    if (bytes.readUInt32LE(at) !== 0x02014b50) throw new Error('bad directory entry');
    const method = bytes.readUInt16LE(at + 10);
    const stored = bytes.readUInt32LE(at + 20);
    const size = bytes.readUInt32LE(at + 24);
    const nameLength = bytes.readUInt16LE(at + 28);
    const extra = bytes.readUInt16LE(at + 30);
    const comment = bytes.readUInt16LE(at + 32);
    const offset = bytes.readUInt32LE(at + 42);
    const name = bytes.toString('utf8', at + 46, at + 46 + nameLength);
    if (bytes.readUInt32LE(offset) !== 0x04034b50) throw new Error('bad local header');
    // The local header repeats the name and says how long its own extra field
    // is, which is where the bytes begin.
    const from = offset + 30 + bytes.readUInt16LE(offset + 26)
      + bytes.readUInt16LE(offset + 28);
    const payload = bytes.subarray(from, from + stored);
    const content = method === 8 ? zlib.inflateRawSync(payload) : payload;
    if (content.length !== size) throw new Error(`${name} is ${content.length}, not ${size}`);
    const to = path.join(into, name);
    fs.writeFileSync(to, content);
    written.push(to);
    at += 46 + nameLength + extra + comment;
  }
  return written;
}

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
    /* And what colour each of them is.
     *
     * The colour a car is wearing is the one thing on screen that need not be
     * in the file it came from: a skin states it beside the model. So an
     * export built from the file rather than from what is on screen comes out
     * of a car in Sakhir Orange as the grey it was unpainted, with its
     * textures orange and its paint not. */
    colours: Object.fromEntries(window.fbxtool.palette
      .map((entry) => [entry.name, FbxPalette.toHex(entry.colour)])),
  }));
}

async function open(page, files) {
  const before = await page.evaluate(() => window.fbxtool.loadCount);
  // A folder goes through the folder picker, which is the only way a car's
  // skins and its lighting come with it.
  const folder = files.length === 1 && fs.statSync(files[0]).isDirectory();
  if (!folder) await page.setInputFiles('#file-input', []);
  await page.setInputFiles(folder ? '#folder-input' : '#file-input',
    folder ? files[0] : files);
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

  /* Every picture written at once, and each one still itself.
   *
   * The deflating an export spends its time on is handed to a handful of
   * workers, several pictures in the air together, and each answer has to find
   * its way back to the picture that asked. Matched to the wrong one they
   * would not fail — they would swap, and a car would export with its carpet
   * on the bonnet and nothing anywhere saying so. Node has no workers, so the
   * unit tests exercise the other path; this is the one that exercises this.
   *
   * Read back by inflating what was written, which is the only reading that
   * proves the bytes rather than the intent.
   */
  console.log('the pictures an export writes, all at once');
  const routed = await page.evaluate(async () => {
    const many = 12;
    const edge = 96;
    const made = [];
    for (let n = 0; n < many; n++) {
      const pixels = new Uint8ClampedArray(edge * edge * 4);
      for (let at = 0; at < pixels.length; at += 4) {
        // Distinct per picture and per texel, so a swap cannot look like a
        // match and neither can a stuck row.
        pixels[at] = (n * 21 + at) & 255;
        pixels[at + 1] = (n * 37 + (at >> 4)) & 255;
        pixels[at + 2] = (n * 11) & 255;
        pixels[at + 3] = 255;
      }
      made.push(pixels);
    }
    const written = await Promise.all(made.map((p) => FbxPng.encode(p, edge, edge)));

    const inflate = async (png) => {
      const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
      let at = 8;
      let colour = 0;
      const idat = [];
      while (at + 8 <= png.length) {
        const length = view.getUint32(at);
        const tag = String.fromCharCode(...png.subarray(at + 4, at + 8));
        if (tag === 'IHDR') colour = png[at + 8 + 9];
        if (tag === 'IDAT') idat.push(png.subarray(at + 8, at + 8 + length));
        at += 12 + length;
      }
      const stream = new Blob(idat).stream()
        .pipeThrough(new DecompressionStream('deflate'));
      const reader = stream.getReader();
      const parts = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
        total += value.length;
      }
      const raw = new Uint8Array(total);
      let to = 0;
      for (const part of parts) { raw.set(part, to); to += part.length; }
      return { raw, colour };
    };

    let wrong = 0;
    let solid = 0;
    for (let n = 0; n < many; n++) {
      if (!written[n]) { wrong++; continue; }
      const { raw, colour } = await inflate(written[n]);
      if (colour === 2) solid++;
      const channels = colour === 2 ? 3 : 4;
      const stride = edge * channels;
      for (let y = 0; y < edge && wrong === 0; y++) {
        // The filter byte in front of each row says the row is not filtered.
        if (raw[y * (stride + 1)] !== 0) { wrong++; break; }
        for (let x = 0; x < edge; x++) {
          const from = y * (stride + 1) + 1 + x * channels;
          const was = (y * edge + x) * 4;
          for (let k = 0; k < 3; k++) {
            if (raw[from + k] !== made[n][was + k]) { wrong++; break; }
          }
          if (wrong) break;
        }
      }
    }
    return { many, wrong, solid };
  });
  check('every picture written at once comes back as itself',
    routed.wrong === 0, `${routed.many - routed.wrong} of ${routed.many}`);
  /* And without an alpha channel, since none of them has one. A quarter of the
   * bytes of a car's textures are an alpha of 255 repeated, and deflating that
   * is time an export spends saying nothing. */
  check('and without an alpha channel none of them needed',
    routed.solid === routed.many, `${routed.solid} of ${routed.many}`);

  for (const entry of files) {
    const group = entry.split('+').every((f) => fs.existsSync(f)) ? entry.split('+') : [entry];
    console.log(group.map((f) => path.basename(f)).join(' + '));
    await open(page, group);
    /* Wearing a skin, where the folder brought one that paints. It is the case
     * an export is likeliest to get wrong, since the paint is the one thing on
     * screen that is not in the model. */
    const painting = await page.evaluate(() => {
      const skin = (window.fbxtool.skins || []).find((s) => s.paints.length);
      return skin ? skin.name : null;
    });
    if (painting) {
      await page.selectOption('#skin-select', painting);
      await page.waitForTimeout(1200);
      console.log(`  wearing ${painting}`);
    }
    const source = await census(page);

    for (const format of FORMATS) {
      written.length = 0;
      await open(page, group);
      if (painting) {
        await page.selectOption('#skin-select', painting);
        await page.waitForTimeout(1200);
      }
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
      let paths = written.map((name) => path.join(outDir, name));
      const sizes = paths.map((p) => fs.statSync(p).size);
      check(`${format.suffix} was written`, sizes.every((size) => size > 0),
        written.map((name, at) => `${name} ${(sizes[at] / 1024).toFixed(0)} KiB`).join(', '));
      if (format.unzip) {
        let members = [];
        try {
          members = unzip(paths[0], outDir);
        } catch (error) {
          check('the archive can be taken apart', false, String(error.message));
          continue;
        }
        check('the archive holds the pair', members.length === 2,
          members.map((p) => path.basename(p)).join(' + '));
        paths = members;
      }

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
      /* By name, and only for the materials that came back at all: one
       * covering no triangles is dropped by design, and the export says so.
       * Within a step or two of eight bits, since a colour goes out through a
       * factor written as a float and comes back through one. */
      const shifted = Object.keys(back.colours).filter((name) => {
        const held = source.colours[name];
        const now = back.colours[name];
        if (held === undefined || now === undefined) return false;
        return [1, 3, 5].some((k) =>
          Math.abs(parseInt(held.slice(k, k + 2), 16)
            - parseInt(now.slice(k, k + 2), 16)) > 2);
      });
      check(`${format.suffix} keeps the colour each material is`,
        shifted.length === 0,
        shifted.length
          ? `${shifted.length} moved, e.g. ${shifted[0]} `
            + `${source.colours[shifted[0]]} -> ${back.colours[shifted[0]]}`
          : `${Object.keys(back.colours).length} material(s)`);
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
