/* Reader for Wavefront OBJ and its MTL material library.
 *
 * Mirrors fbxtool/obj.py: the file is normalised into the same record tree the
 * FBX readers produce, so the report, the analysis and the WebAssembly
 * geometry pipeline all apply without knowing which format was loaded.
 */
'use strict';

const FbxObj = (function () {
  const LEADING = /^\s*(#|v |vn |vt |f |o |g |usemtl |mtllib |s |l |p )/gm;

  function looksLikeObj(text) {
    const head = text.slice(0, 8192);
    const hits = head.match(LEADING);
    if (!hits) return false;
    return hits.some((h) => ['v', 'f', 'vn', 'vt'].includes(h.trim()));
  }

  const numbers = (parts, count) => {
    const out = [];
    for (const item of parts) {
      const value = Number(item);
      if (!Number.isFinite(value)) break;
      out.push(value);
    }
    while (out.length < count) out.push(0);
    return out.slice(0, count);
  };

  /** OBJ indices are 1-based; negatives count back from the end so far. */
  function resolveIndex(index, count) {
    if (index > 0) return index - 1;
    if (index < 0) return count + index;
    return -1;
  }

  function parseMtl(text) {
    const materials = [];
    let current = null;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.split('#')[0].trim();
      if (!line) continue;
      const parts = line.split(/\s+/);
      const key = parts[0].toLowerCase();
      const rest = parts.slice(1);
      if (key === 'newmtl') {
        current = { name: rest.join(' '), diffuse: [0.8, 0.8, 0.8], map: '' };
        materials.push(current);
        continue;
      }
      if (!current) continue;
      if (key === 'kd') current.diffuse = numbers(rest, 3);
      else if (key === 'ks') current.specular = numbers(rest, 3);
      else if (key === 'ka') current.ambient = numbers(rest, 3);
      else if (key === 'ns') current.shininess = numbers(rest, 1)[0];
      // Dissolve, written either way round: `d 1` and `Tr 0` both mean opaque.
      else if (key === 'd') current.opacity = numbers(rest, 1)[0];
      else if (key === 'tr') current.opacity = 1 - numbers(rest, 1)[0];
      else if (key === 'map_kd' || (key === 'map_ka' && !current.map)) {
        // Skip option flags such as "-s 1 1 1" before the filename.
        const cleaned = [];
        let skip = 0;
        for (const token of rest) {
          if (skip) { skip--; continue; }
          if (token.startsWith('-')) { skip = ['-s', '-o', '-t'].includes(token) ? 3 : 1; continue; }
          cleaned.push(token);
        }
        current.map = cleaned.join(' ');
      }
    }
    return materials;
  }

  /* ---------------------------------------------------------------- records */

  // Object names carry the class after this separator, as binary FBX writes it,
  // so the shared analysis splits them the same way for either format.
  const CLASS_SEP = '\u0000\u0001';

  const node = (name, props = [], children = []) => ({ name, props, children });
  const S = (value) => ({ code: 'S', typeName: 'string', value: String(value) });
  const I = (value) => ({ code: 'I', typeName: 'int32', value: value | 0 });
  const L = (value) => ({ code: 'L', typeName: 'int64', value });
  const D = (value) => ({ code: 'D', typeName: 'float64', value: Number(value) });

  function array(code, values) {
    const size = code === 'd' ? 8 : 4;
    return {
      code,
      typeName: `${code === 'd' ? 'float64' : 'int32'}[]`,
      array: { length: values.length, encoding: 0, byteLength: values.length * size, dataOffset: 0 },
      values,
      value: null,
    };
  }

  const p70 = (name, kind, ...values) =>
    node('P', [S(name), S(kind), S(''), S('A'), ...values]);

  function parse(text, options = {}) {
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const supplied = options.materials || new Map();
    const warnings = [];

    const positions = [];
    const normals = [];
    const uvs = [];
    const polygons = [];
    const faceNormals = [];
    const faceUvs = [];
    const faceMaterials = [];
    const objects = [];
    const groups = [];
    const libraries = [];
    const comments = [];
    const materialOrder = [];
    const materialIndex = new Map();
    let currentMaterial = -1;
    let smoothing = 0;

    const lines = text.split(/\r?\n/);
    for (let number = 0; number < lines.length; number++) {
      const stripped = lines[number].trim();
      if (!stripped) continue;
      if (stripped[0] === '#') {
        if (comments.length < 8) comments.push(stripped.replace(/^#+\s*/, ''));
        continue;
      }
      const parts = stripped.split(/\s+/);
      const key = parts[0].toLowerCase();
      const rest = parts.slice(1);

      if (key === 'v') {
        positions.push(...numbers(rest, 3));
      } else if (key === 'vn') {
        normals.push(...numbers(rest, 3));
      } else if (key === 'vt') {
        uvs.push(...numbers(rest, 2));
      } else if (key === 'f') {
        const corners = [];
        for (const token of rest) {
          const bits = token.split('/');
          const vertex = parseInt(bits[0], 10);
          if (!Number.isFinite(vertex)) continue;
          corners.push([
            vertex,
            bits.length > 1 && bits[1] ? parseInt(bits[1], 10) : 0,
            bits.length > 2 && bits[2] ? parseInt(bits[2], 10) : 0,
          ]);
        }
        if (corners.length < 3) {
          warnings.push(`line ${number + 1}: face with fewer than three corners; skipped`);
          continue;
        }
        const vertexTotal = positions.length / 3;
        const uvTotal = uvs.length / 2;
        const normalTotal = normals.length / 3;
        corners.forEach(([vertex, uv, normal], position) => {
          let index = resolveIndex(vertex, vertexTotal);
          if (index < 0 || index >= vertexTotal) {
            warnings.push(`line ${number + 1}: vertex index ${vertex} is out of range`);
            index = 0;
          }
          const last = position === corners.length - 1;
          polygons.push(last ? ~index : index);
          faceUvs.push(uv ? resolveIndex(uv, uvTotal) : -1);
          faceNormals.push(normal ? resolveIndex(normal, normalTotal) : -1);
        });
        faceMaterials.push(currentMaterial >= 0 ? currentMaterial : 0);
      } else if (key === 'usemtl') {
        const name = rest.join(' ');
        if (!materialIndex.has(name)) {
          materialIndex.set(name, materialOrder.length);
          materialOrder.push(name);
        }
        currentMaterial = materialIndex.get(name);
      } else if (key === 'mtllib') {
        libraries.push(...rest);
      } else if (key === 'o') {
        objects.push(rest.join(' '));
      } else if (key === 'g') {
        groups.push(rest.join(' '));
      } else if (key === 's') {
        smoothing++;
      }
    }

    if (!positions.length) warnings.push('no vertices were found');

    // Materials come from whichever .mtl files the user supplied.
    const defined = new Map();
    for (const [, content] of supplied) {
      for (const material of parseMtl(content)) {
        if (!defined.has(material.name)) defined.set(material.name, material);
      }
    }
    let used = materialOrder;
    if (!used.length) used = defined.size ? [...defined.keys()] : ['default'];
    const palette = used.map((name) => defined.get(name)
      || { name, diffuse: [0.8, 0.8, 0.8], map: '', missing: true });
    const unresolved = palette.filter((m) => m.missing).map((m) => m.name);
    if (unresolved.length && libraries.length && !defined.size) {
      warnings.push(`material library not supplied: ${libraries.join(', ')}`
        + ' — drop the .mtl in to colour this model');
    }

    const name = objects[0] || groups[0] || 'mesh';
    const root = { name: '', props: [], children: [] };
    root.children.push(node('FBXHeaderExtension', [], [
      node('Creator', [S(comments[0] || 'Wavefront OBJ')]),
    ]));

    const geometryUid = 1;
    const modelUid = 2;
    const geometry = [
      node('Vertices', [array('d', positions)]),
      node('PolygonVertexIndex', [array('i', polygons)]),
      node('GeometryVersion', [I(124)]),
    ];
    if (normals.length && faceNormals.some((i) => i >= 0)) {
      geometry.push(node('LayerElementNormal', [I(0)], [
        node('Version', [I(101)]),
        node('MappingInformationType', [S('ByPolygonVertex')]),
        node('ReferenceInformationType', [S('IndexToDirect')]),
        node('Normals', [array('d', normals)]),
        node('NormalsIndex', [array('i', faceNormals)]),
      ]));
    }
    if (uvs.length && faceUvs.some((i) => i >= 0)) {
      geometry.push(node('LayerElementUV', [I(0)], [
        node('Version', [I(101)]),
        node('Name', [S('map1')]),
        node('MappingInformationType', [S('ByPolygonVertex')]),
        node('ReferenceInformationType', [S('IndexToDirect')]),
        node('UV', [array('d', uvs)]),
        node('UVIndex', [array('i', faceUvs)]),
      ]));
    }
    geometry.push(node('LayerElementMaterial', [I(0)], [
      node('Version', [I(101)]),
      node('MappingInformationType', [S('ByPolygon')]),
      node('ReferenceInformationType', [S('IndexToDirect')]),
      node('Materials', [array('i', faceMaterials)]),
    ]));
    geometry.push(node('Layer', [I(0)], [node('Version', [I(100)])]));

    const objectsNode = node('Objects', [], [
      node('Geometry', [L(geometryUid), S(`${name}${CLASS_SEP}Geometry`), S('Mesh')], geometry),
      node('Model', [L(modelUid), S(`${name}${CLASS_SEP}Model`), S('Mesh')],
        [node('Version', [I(232)])]),
    ]);
    const connections = [
      node('C', [S('OO'), L(modelUid), L(0)]),
      node('C', [S('OO'), L(geometryUid), L(modelUid)]),
    ];

    palette.forEach((material, index) => {
      const uid = 100 + index;
      const props = [p70('DiffuseColor', 'Color', ...material.diffuse.map(D))];
      if (material.specular) props.push(p70('SpecularColor', 'Color', ...material.specular.map(D)));
      if (material.shininess !== undefined) props.push(p70('Shininess', 'double', D(material.shininess)));
      if (material.opacity !== undefined) props.push(p70('Opacity', 'double', D(material.opacity)));
      objectsNode.children.push(
        node('Material', [L(uid), S(`${material.name}${CLASS_SEP}Material`), S('')], [
          node('Version', [I(102)]),
          node('ShadingModel', [S('phong')]),
          node('Properties70', [], props),
        ]),
      );
      connections.push(node('C', [S('OO'), L(uid), L(modelUid)]));

      if (material.map) {
        const textureUid = 200 + index;
        const videoUid = 300 + index;
        objectsNode.children.push(
          node('Texture', [L(textureUid), S(`${material.name}_map${CLASS_SEP}Texture`), S('')], [
            node('Type', [S('TextureVideoClip')]),
            node('FileName', [S(material.map)]),
            node('RelativeFilename', [S(material.map)]),
          ]),
        );
        objectsNode.children.push(
          node('Video', [L(videoUid), S(`${material.map}${CLASS_SEP}Video`), S('Clip')], [
            node('Type', [S('Clip')]),
            node('RelativeFilename', [S(material.map)]),
          ]),
        );
        connections.push(node('C', [S('OP'), L(textureUid), L(uid), S('DiffuseColor')]));
        connections.push(node('C', [S('OO'), L(videoUid), L(textureUid)]));
      }
    });

    root.children.push(node('Definitions', [], [
      node('Version', [I(100)]),
      node('Count', [I(objectsNode.children.length)]),
      node('ObjectType', [S('Geometry')], [node('Count', [I(1)])]),
      node('ObjectType', [S('Model')], [node('Count', [I(1)])]),
      node('ObjectType', [S('Material')], [node('Count', [I(palette.length)])]),
    ]));
    root.children.push(objectsNode);
    root.children.push(node('Connections', [], connections));

    return {
      format: 'obj',
      encoding: 'obj',
      version: null,
      versionSource: null,
      wideOffsets: false,
      hasFooter: false,
      footerVersion: null,
      fileSize: text.length,
      root,
      warnings,
      extra: {
        objects, groups, libraries, comments,
        smoothingGroups: smoothing,
        materialsResolved: palette.length - unresolved.length,
        materialsMissing: unresolved,
      },
    };
  }

  return { parse, parseMtl, looksLikeObj };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = FbxObj;
