/* End-to-end check of the built page in a real browser.
 *
 *   node web/test/browser.js <file.fbx> [more.fbx ...]
 *
 * Loads dist/fbxview.html from a file:// URL, feeds each file through the real
 * file input, and asserts on what the page actually produced — including
 * reading back pixels to confirm WebGL drew something.  Writes a screenshot
 * per file into web/build/.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const { launch } = require('./chromium');

const ROOT = path.resolve(__dirname, '..', '..');
const PAGE = path.join(ROOT, 'web', 'dist', 'fbxview.html');
const OUT = path.join(ROOT, 'web', 'build');

let failures = 0;

function check(label, condition, detail = '') {
  const mark = condition ? 'ok  ' : 'FAIL';
  if (!condition) failures++;
  console.log(`  ${mark} ${label}${detail ? `  — ${detail}` : ''}`);
}

async function main() {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.error('usage: node web/test/browser.js <file.fbx> [...]');
    process.exit(2);
  }
  if (!fs.existsSync(PAGE)) {
    console.error(`${PAGE} is missing — run: python3 web/build.py`);
    process.exit(2);
  }
  fs.mkdirSync(OUT, { recursive: true });

  const browser = await launch(chromium);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(String(error)));

  await page.goto(`file://${PAGE}`);
  await page.waitForFunction(() => document.body.dataset.ready === 'true', { timeout: 20000 });
  console.log('page loaded, WebAssembly instantiated\n');

  const webgl = await page.evaluate(() => !!(window.fbxtool && window.fbxtool.viewer));
  check('WebGL2 context created', webgl);

  for (const entry of files) {
    // "a.fbx+b.png" loads several files together, as a drop would — but only
    // when every piece is a file. Real models are called things like
    // "Mercedes+Benz+GLS+580.fbx".
    const pieces = entry.split('+');
    const group = pieces.length > 1 && pieces.every((f) => fs.existsSync(f))
      ? pieces : [entry];
    const file = group[0];
    const suppliedImage = group.slice(1).some((f) => /\.(png|jpe?g|gif|bmp|webp)$/i.test(f));
    const expectTexture = suppliedImage || /textured/i.test(file);
    const name = group.map((f) => path.basename(f)).join(' + ');
    console.log(`${name}`);
    const started = Date.now();

    // The page counts finished loads, so waiting is exact even when a previous
    // file already left a document and a mesh in place.
    const before = await page.evaluate(() => window.fbxtool.loadCount);
    await page.setInputFiles('#file-input', group);
    await page.waitForFunction(
      (seen) => window.fbxtool.loadCount > seen,
      before,
      { timeout: 180000 },
    );
    // Let the render loop draw at least one frame with the new mesh.
    await page.waitForTimeout(700);

    const result = await page.evaluate(() => {
      const { doc, analysis, viewer } = window.fbxtool;
      const canvas = document.getElementById('viewport');
      const gl = canvas.getContext('webgl2');
      // Sample the framebuffer to prove something was actually rasterised.
      const pixels = new Uint8Array(canvas.width * canvas.height * 4);
      gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      const background = [pixels[0], pixels[1], pixels[2]];
      let lit = 0;
      const distinct = new Set();
      for (let i = 0; i < pixels.length; i += 4 * 97) {
        const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
        if (Math.abs(r - background[0]) + Math.abs(g - background[1])
            + Math.abs(b - background[2]) > 24) {
          lit++;
          distinct.add((r >> 4) * 256 + (g >> 4) * 16 + (b >> 4));
        }
      }
      return {
        encoding: doc.encoding,
        format: doc.format || 'fbx',
        meshes: (doc.extra && doc.extra.meshes) || 0,
        // A `.kn5` carries its textures inside it, so whether any were drawn
        // is answerable from the file alone rather than from its name — unless
        // it was published with them stripped out, and then there are none to
        // draw and the report says so.
        embedded: (doc.extra && !doc.extra.placeholderTextures
          && doc.extra.textures) || 0,
        version: doc.version,
        records: analysis.totalRecords,
        objects: analysis.objects.length,
        connections: analysis.connections.length,
        warnings: doc.warnings,
        parseMs: doc.parseMilliseconds,
        hasFooter: doc.hasFooter,
        triangles: viewer ? viewer.triangleCount : 0,
        textureLayers: viewer ? viewer.textureLayers : 0,
        hasUv: viewer ? viewer.hasUv : false,
        missingTextures: window.fbxtool.missingTextures || [],
        meshInfo: document.getElementById('mesh-info').textContent,
        status: document.getElementById('status').textContent,
        reportSections: document.querySelectorAll('#panel .panel-section').length,
        reportText: document.getElementById('panel').textContent,
        treeItems: document.querySelectorAll('#tree li').length,
        litSamples: lit,
        distinctColours: distinct.size,
      };
    });

    check('parsed', result.records > 0,
      `${result.format}${result.version ? `, version ${result.version}` : ''}`);
    check('records found', result.records > 0, `${result.records.toLocaleString()} records`);
    // A .blend reports its container only, so it has fewer sections.
    const minimumSections = result.format === 'blend' ? 2 : 5;
    check('report rendered', result.reportSections >= minimumSections,
      `${result.reportSections} sections`);
    check('record tree rendered', result.treeItems > 0, `${result.treeItems} nodes shown`);
    // A .blend renders when its meshes use the MVert/MPoly/MLoop layout.
    const expectMesh = result.format !== 'blend' || result.meshes > 0;
    if (expectMesh) {
      check('triangles built', result.triangles > 0,
        `${result.triangles.toLocaleString()} triangles`);
      check('pixels drawn', result.litSamples > 100,
        `${result.litSamples} lit samples, ${result.distinctColours} distinct colours`);
    } else {
      check('container described', /Blender/.test(result.reportText),
        `${result.reportSections} sections`);
    }
    check('no warnings', result.warnings.length === 0,
      result.warnings.length ? result.warnings.join('; ') : 'clean');
    if (result.format === 'kn5' && result.embedded > 0) {
      // Every one of them is a DDS, which no browser will decode: a car whose
      // textures did not come back is a grey model with no paint on it.
      check('embedded textures decoded', result.textureLayers > 0,
        `${result.textureLayers} of ${result.embedded} layer(s)`);
    }
    if (expectTexture) {
      check('UVs present', result.hasUv);
      check('texture uploaded', result.textureLayers > 0,
        `${result.textureLayers} layer(s)`);
      check('no missing textures', result.missingTextures.length === 0,
        result.missingTextures.join(', ') || 'none');
    }
    console.log(`       ${result.meshInfo}`);
    console.log(`       parsed in ${result.parseMs.toFixed(0)} ms, `
      + `total ${(Date.now() - started)} ms including render`);

    const shot = path.join(OUT, `shot-${name.replace(/\.fbx$/i, '')}.png`);
    await page.screenshot({ path: shot });
    console.log(`       screenshot ${path.relative(ROOT, shot)}\n`);
  }

  check('no console errors', consoleErrors.length === 0, consoleErrors.join(' | ') || 'clean');

  await browser.close();
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
