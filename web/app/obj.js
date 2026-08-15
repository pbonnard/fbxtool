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
    /* Where each face starts in the polygon run and how many corners it has,
     * so a part can be cut out of the file's shared arrays afterwards. */
    const faceStart = [];
    const faceSize = [];
    const pieces = [];
    let piece = null;
    let pieceName = '';

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
        // Which part this face belongs to. A face before any `o` or `g` goes
        // into one of no name, which is what a file with no parts is.
        // Compared on the name as written: resolving it first made a file
        // that names no parts at all start a new one at every face.
        if (!piece || piece.name !== pieceName) {
          piece = { name: pieceName, faces: [] };
          pieces.push(piece);
        }
        piece.faces.push(faceMaterials.length);
        faceStart.push(polygons.length);
        faceSize.push(corners.length);
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
        pieceName = rest.join(' ');
      } else if (key === 'g') {
        groups.push(rest.join(' '));
        // `o Body` followed by `g Body` names one part twice, which is what
        // 3ds Max writes; only a change of name starts another.
        pieceName = rest.join(' ');
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

    /**
     * One part's share of the file, cut out of the arrays every part shares.
     *
     * OBJ indexes one pool of vertices, normals and texture coordinates from
     * anywhere in the file, so a part cannot simply take a slice: each of the
     * three is gathered as it is referenced and renumbered from zero. The
     * remap is a table per pool, stamped with the part being built rather than
     * cleared — on a car of 1.9 million vertices in 164 parts, clearing it
     * each time is most of the work.
     */
    const remaps = [
      { at: new Int32Array(positions.length / 3), seen: new Int32Array(positions.length / 3) },
      { at: new Int32Array(normals.length / 3 || 1), seen: new Int32Array(normals.length / 3 || 1) },
      { at: new Int32Array(uvs.length / 2 || 1), seen: new Int32Array(uvs.length / 2 || 1) },
    ];

    const cut = (faces, stamp) => {
      const outPositions = [];
      const outNormals = [];
      const outUvs = [];
      const outPolygons = [];
      const outFaceNormals = [];
      const outFaceUvs = [];
      const outFaceMaterials = [];

      const take = (pool, index, source, target, width) => {
        const map = remaps[pool];
        if (map.seen[index] !== stamp) {
          map.seen[index] = stamp;
          map.at[index] = target.length / width;
          for (let k = 0; k < width; k++) target.push(source[index * width + k]);
        }
        return map.at[index];
      };

      for (const face of faces) {
        const start = faceStart[face];
        const size = faceSize[face];
        for (let corner = 0; corner < size; corner++) {
          const written = polygons[start + corner];
          const vertex = written < 0 ? ~written : written;
          const local = take(0, vertex, positions, outPositions, 3);
          outPolygons.push(corner === size - 1 ? ~local : local);
          const normal = faceNormals[start + corner];
          outFaceNormals.push(normal >= 0 ? take(1, normal, normals, outNormals, 3) : -1);
          const uv = faceUvs[start + corner];
          outFaceUvs.push(uv >= 0 ? take(2, uv, uvs, outUvs, 2) : -1);
        }
        outFaceMaterials.push(faceMaterials[face]);
      }
      return {
        positions: outPositions,
        normals: outNormals,
        uvs: outUvs,
        polygons: outPolygons,
        faceNormals: outFaceNormals,
        faceUvs: outFaceUvs,
        faceMaterials: outFaceMaterials,
      };
    };

    /** The Geometry record for one part's arrays. */
    const geometryOf = (held) => {
      const geometry = [
        node('Vertices', [array('d', held.positions)]),
        node('PolygonVertexIndex', [array('i', held.polygons)]),
        node('GeometryVersion', [I(124)]),
      ];
      if (held.normals.length && held.faceNormals.some((i) => i >= 0)) {
        geometry.push(node('LayerElementNormal', [I(0)], [
          node('Version', [I(101)]),
          node('Name', [S('')]),
          node('MappingInformationType', [S('ByPolygonVertex')]),
          node('ReferenceInformationType', [S('IndexToDirect')]),
          node('Normals', [array('d', held.normals)]),
          node('NormalsIndex', [array('i', held.faceNormals)]),
        ]));
      }
      if (held.uvs.length && held.faceUvs.some((i) => i >= 0)) {
        geometry.push(node('LayerElementUV', [I(0)], [
          node('Version', [I(101)]),
          node('Name', [S('map1')]),
          node('MappingInformationType', [S('ByPolygonVertex')]),
          node('ReferenceInformationType', [S('IndexToDirect')]),
          node('UV', [array('d', held.uvs)]),
          node('UVIndex', [array('i', held.faceUvs)]),
        ]));
      }
      geometry.push(node('LayerElementMaterial', [I(0)], [
        node('Version', [I(101)]),
        node('MappingInformationType', [S('ByPolygon')]),
        node('ReferenceInformationType', [S('IndexToDirect')]),
        node('Materials', [array('i', held.faceMaterials)]),
      ]));
      geometry.push(node('Layer', [I(0)], [node('Version', [I(100)])]));
      return geometry;
    };

    /* A file's `o` and `g` lines are its parts, and they are kept apart: a car
     * written as 164 groups is 164 parts, which is what lets it be exploded,
     * picked at, edited part by part, and matched against the same scene saved
     * in another format. A file that names none is one part, as it always was,
     * and then nothing is cut up or copied. */
    const objectsNode = node('Objects', [], []);
    const connections = [];
    const models = [];

    if (pieces.length > 1) {
      pieces.forEach((held, index) => {
        const geometryUid = 1000 + index * 2;
        const modelUid = 1001 + index * 2;
        objectsNode.children.push(node('Geometry',
          [L(geometryUid), S(`${held.name || name}${CLASS_SEP}Geometry`), S('Mesh')],
          geometryOf(cut(held.faces, index + 1))));
        objectsNode.children.push(node('Model',
          [L(modelUid), S(`${held.name || name}${CLASS_SEP}Model`), S('Mesh')],
          [node('Version', [I(232)])]));
        connections.push(node('C', [S('OO'), L(modelUid), L(0)]));
        connections.push(node('C', [S('OO'), L(geometryUid), L(modelUid)]));
        models.push(modelUid);
      });
    } else {
      const geometryUid = 1;
      const modelUid = 2;
      objectsNode.children.push(node('Geometry',
        [L(geometryUid), S(`${name}${CLASS_SEP}Geometry`), S('Mesh')],
        geometryOf({ positions, normals, uvs, polygons, faceNormals, faceUvs, faceMaterials })));
      objectsNode.children.push(node('Model',
        [L(modelUid), S(`${name}${CLASS_SEP}Model`), S('Mesh')],
        [node('Version', [I(232)])]));
      connections.push(node('C', [S('OO'), L(modelUid), L(0)]));
      connections.push(node('C', [S('OO'), L(geometryUid), L(modelUid)]));
      models.push(modelUid);
    }

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
      // Every part is connected to the whole palette, in palette order: a
      // per-polygon material index refers to the materials on that part's own
      // model, counted in the order they connect, so the numbering only holds
      // if each model sees the same list.
      for (const model of models) connections.push(node('C', [S('OO'), L(uid), L(model)]));

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
      node('ObjectType', [S('Geometry')], [node('Count', [I(models.length)])]),
      node('ObjectType', [S('Model')], [node('Count', [I(models.length)])]),
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
        parts: models.length,
        smoothingGroups: smoothing,
        materialsResolved: palette.length - unresolved.length,
        materialsMissing: unresolved,
      },
    };
  }

  return { parse, parseMtl, looksLikeObj };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = FbxObj;
