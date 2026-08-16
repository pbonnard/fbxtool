/* The page's own reading of an Assetto Corsa `.kn5`, dumped for comparison.
 *
 *   node web/test/kn5.js <car.kn5>
 *
 * There are two readers of every format here — one in Python and one in the
 * page — and a format with no offsets in it is exactly where they drift apart
 * without anyone noticing: a field mis-sized in one of them walks off the rest
 * of the file and produces a different car, not an error.  So this prints what
 * the page read, and the Python suite holds it against what it read itself.
 *
 * No browser is involved: `kn5.js` depends on nothing but the bytes.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const FbxKn5 = require(path.join(__dirname, '..', 'app', 'kn5.js'));

const file = process.argv[2];
if (!file) {
  console.error('usage: node web/test/kn5.js <car.kn5>');
  process.exit(2);
}

const bytes = new Uint8Array(fs.readFileSync(file));
if (!FbxKn5.looksLikeKn5(bytes)) {
  console.error(`${file} does not begin "sc6969"`);
  process.exit(1);
}

const doc = FbxKn5.parse(bytes);
const objects = doc.root.children.find((c) => c.name === 'Objects');
const connections = doc.root.children.find((c) => c.name === 'Connections');

const plain = (value) => String(value).split('\u0000')[0];
const counts = {};
for (const entry of objects.children) counts[entry.name] = (counts[entry.name] || 0) + 1;

/** Every array, by the record that holds it, so a drift shows up where it is. */
function arrays(entry) {
  const out = {};
  (function walk(node, name) {
    for (const prop of node.props) {
      if (prop.array) out[name] = { length: prop.array.length };
    }
    for (const child of node.children) walk(child, child.name);
  })(entry, entry.name);
  return out;
}

/** A Properties70 block as a name -> values object. */
function properties(entry) {
  const block = entry.children.find((c) => c.name === 'Properties70');
  const out = {};
  if (!block) return out;
  for (const p of block.children) {
    const values = p.props.slice(4).map((v) => v.value);
    out[p.props[0].value] = values.length === 1 ? values[0] : values;
  }
  return out;
}

const first = objects.children.find((o) => o.name === 'Geometry');
const values = (node, name) => {
  const found = node && node.children.find((c) => c.name === name);
  return found ? Array.from(found.props[0].values).slice(0, 12) : null;
};
const layer = (node, name) => node.children.find((c) => c.name === name);

console.log(JSON.stringify({
  format: doc.format,
  encoding: doc.encoding,
  extra: doc.extra,
  counts,
  connections: connections.children.length,
  warnings: doc.warnings,
  materials: objects.children.filter((o) => o.name === 'Material')
    .map((m) => ({ name: plain(m.props[1].value), props: properties(m) })),
  models: objects.children.filter((o) => o.name === 'Model')
    .map((m) => ({
      name: plain(m.props[1].value),
      subclass: m.props[2].value,
      props: properties(m),
    })),
  links: connections.children.map((c) => c.props.map((p) => p.value)),
  firstGeometry: first && {
    name: plain(first.props[1].value),
    arrays: arrays(first),
    vertices: values(first, 'Vertices'),
    polygons: values(first, 'PolygonVertexIndex'),
    normals: values(layer(first, 'LayerElementNormal'), 'Normals'),
    uv: values(layer(first, 'LayerElementUV'), 'UV'),
  },
}));
