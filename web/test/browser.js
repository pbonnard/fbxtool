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

  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
  });
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

  for (const file of files) {
    const name = path.basename(file);
    console.log(`${name}`);
    const started = Date.now();

    await page.setInputFiles('#file-input', file);
    await page.waitForFunction(
      () => window.fbxtool && window.fbxtool.doc !== null,
      { timeout: 60000 },
    );
    // Let the render loop draw at least one frame with the new mesh.
    await page.waitForTimeout(600);

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
        version: doc.version,
        records: analysis.totalRecords,
        objects: analysis.objects.length,
        connections: analysis.connections.length,
        warnings: doc.warnings,
        parseMs: doc.parseMilliseconds,
        hasFooter: doc.hasFooter,
        triangles: viewer ? viewer.triangleCount : 0,
        meshInfo: document.getElementById('mesh-info').textContent,
        status: document.getElementById('status').textContent,
        reportSections: document.querySelectorAll('#panel .panel-section').length,
        reportText: document.getElementById('panel').textContent,
        treeItems: document.querySelectorAll('#tree li').length,
        litSamples: lit,
        distinctColours: distinct.size,
      };
    });

    check('parsed', result.records > 0, `${result.encoding}, FBX ${result.version}`);
    check('records found', result.records > 0, `${result.records.toLocaleString()} records`);
    check('report rendered', result.reportSections >= 5, `${result.reportSections} sections`);
    check('record tree rendered', result.treeItems > 0, `${result.treeItems} nodes shown`);
    check('triangles built', result.triangles > 0, `${result.triangles.toLocaleString()} triangles`);
    check('pixels drawn', result.litSamples > 100,
      `${result.litSamples} lit samples, ${result.distinctColours} distinct colours`);
    check('no warnings', result.warnings.length === 0,
      result.warnings.length ? result.warnings.join('; ') : 'clean');
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
