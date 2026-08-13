/* Dump a parsed FBX tree as JSON, using the WebAssembly core under Node.
 *
 *   node web/test/dump.js <file.fbx>
 *
 * The Python test suite runs this and compares the result against its own
 * reader, so the two implementations are held to the same output.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const FbxWasm = require(path.join(__dirname, '..', 'app', 'wasm.js'));
const FbxAscii = require(path.join(__dirname, '..', 'app', 'ascii.js'));

const WASM = path.join(__dirname, '..', 'build', 'fbx.wasm');

function describeProp(prop) {
  if (prop.array) {
    return ['A', prop.code, prop.array.length, prop.array.encoding, prop.array.byteLength];
  }
  if (prop.value instanceof Uint8Array) return ['R', Array.from(prop.value)];
  if (typeof prop.value === 'string') return ['S', prop.code, prop.value];
  if (typeof prop.value === 'bigint') return ['N', prop.code, Number(prop.value)];
  return ['N', prop.code, prop.value];
}

function flatten(root) {
  const out = [];
  (function walk(node, depth) {
    for (const child of node.children) {
      out.push([depth, child.name, child.props.length, child.children.length,
                child.offset === undefined ? null : child.offset,
                child.props.map(describeProp)]);
      walk(child, depth + 1);
    }
  })(root, 0);
  return out;
}

async function main() {
  const target = process.argv[2];
  if (!target) {
    console.error('usage: node web/test/dump.js <file.fbx>');
    process.exit(2);
  }
  await FbxWasm.init(fs.readFileSync(WASM));
  const data = new Uint8Array(fs.readFileSync(target));

  let doc = FbxWasm.parseBinary(data);
  if (!doc) {
    const text = new TextDecoder('utf-8').decode(data);
    if (!FbxAscii.looksLikeAscii(text)) {
      console.log(JSON.stringify({ error: 'not an FBX file' }));
      return;
    }
    doc = FbxAscii.parse(text);
  }

  console.log(JSON.stringify({
    encoding: doc.encoding,
    version: doc.version,
    wide: doc.wideOffsets,
    hasFooter: doc.hasFooter,
    footerVersion: doc.footerVersion,
    warnings: doc.warnings,
    nodes: flatten(doc.root),
  }));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
