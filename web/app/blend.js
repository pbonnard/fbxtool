/* Reader for Blender's .blend container.
 *
 * Mirrors fbxtool/blend.py: header, file-blocks and the SDNA description of
 * Blender's C structs. Datablock names are located through the SDNA rather
 * than fixed offsets, so they are found wherever a given Blender release puts
 * ID.name.
 *
 * The contents of individual structs are Blender's internal business and
 * change between releases, so no geometry is extracted — a .blend is reported,
 * not rendered.
 */
'use strict';

const FbxBlend = (function () {
  const MAGIC = 'BLENDER';
  const GZIP = [0x1f, 0x8b];
  const ZSTD = [0x28, 0xb5, 0x2f, 0xfd];

  const ID_TYPES = {
    AC: 'Action', AR: 'Armature', BR: 'Brush', CA: 'Camera', CF: 'CacheFile',
    CU: 'Curve', GD: 'GreasePencil', GR: 'Collection', IM: 'Image', IP: 'Ipo',
    KE: 'ShapeKey', LA: 'Light', LI: 'Library', LS: 'LineStyle', LT: 'Lattice',
    MA: 'Material', MB: 'MetaBall', MC: 'MovieClip', ME: 'Mesh', MS: 'Mask',
    NT: 'NodeTree', OB: 'Object', PA: 'ParticleSettings', PC: 'PaintCurve',
    PL: 'LightProbe', PT: 'Palette', SC: 'Scene', SN: 'Screen', SO: 'Sound',
    SQ: 'Sequence', TE: 'Texture', TX: 'Text', VF: 'VectorFont',
    WM: 'WindowManager', WO: 'World', WS: 'Workspace', SI: 'Simulation',
    HA: 'Hair', PO: 'PointCloud', VO: 'Volume',
  };

  const CLASS_SEP = '\u0000\u0001';  // as binary FBX writes it
  const startsWith = (bytes, signature) => signature.every((b, i) => bytes[i] === b);

  function looksLikeBlend(bytes) {
    if (bytes.length < 4) return false;
    const head = new TextDecoder('latin1').decode(bytes.subarray(0, 7));
    return head === MAGIC || startsWith(bytes, GZIP) || startsWith(bytes, ZSTD);
  }

  function describeVersion(stamp) {
    if (!stamp) return 'unknown';
    const major = Math.floor(stamp / 100);
    const rest = stamp % 100;
    return rest % 10 ? `${major}.${Math.floor(rest / 10)}${rest % 10}`
      : `${major}.${Math.floor(rest / 10)}`;
  }

  const node = (name, props = [], children = []) => ({ name, props, children });
  const S = (value) => ({ code: 'S', typeName: 'string', value: String(value) });
  const I = (value) => ({ code: 'I', typeName: 'int32', value: value | 0 });
  const L = (value) => ({ code: 'L', typeName: 'int64', value });

  /* ------------------------------------------------------------------ SDNA */

  const ARRAY_DIMENSION = /\[(\d+)\]/g;

  function readSdna(view, start, length, little) {
    const decoder = new TextDecoder('utf-8');
    const bytes = new Uint8Array(view.buffer, view.byteOffset + start, length);
    let position = 0;

    const tag = () => decoder.decode(bytes.subarray(position, position + 4));
    const align = () => { position = (position + 3) & ~3; };

    if (tag() !== 'SDNA') throw new Error("the DNA1 block does not start with 'SDNA'");
    position += 4;

    function readStrings(expected) {
      if (tag() !== expected) throw new Error(`expected ${expected}`);
      position += 4;
      const count = view.getUint32(start + position, little);
      position += 4;
      const out = [];
      for (let i = 0; i < count; i++) {
        let end = position;
        while (end < bytes.length && bytes[end] !== 0) end++;
        out.push(decoder.decode(bytes.subarray(position, end)));
        position = end + 1;
      }
      align();
      return out;
    }

    const names = readStrings('NAME');
    const types = readStrings('TYPE');

    if (tag() !== 'TLEN') throw new Error('expected TLEN');
    position += 4;
    const lengths = [];
    for (let i = 0; i < types.length; i++) {
      lengths.push(view.getUint16(start + position + i * 2, little));
    }
    position += types.length * 2;
    align();

    if (tag() !== 'STRC') throw new Error('expected STRC');
    position += 4;
    const structCount = view.getUint32(start + position, little);
    position += 4;
    const structs = [];
    for (let i = 0; i < structCount; i++) {
      const typeIndex = view.getUint16(start + position, little);
      const fieldCount = view.getUint16(start + position + 2, little);
      position += 4;
      const fields = [];
      for (let f = 0; f < fieldCount; f++) {
        fields.push([
          view.getUint16(start + position, little),
          view.getUint16(start + position + 2, little),
        ]);
        position += 4;
      }
      structs.push([typeIndex, fields]);
    }
    return { names, types, lengths, structs };
  }

  /** Byte offset of a named field, computed from the file's own SDNA. */
  function fieldOffset(sdna, structIndex, wanted, pointerSize) {
    if (structIndex === null || structIndex === undefined) return null;
    const entry = sdna.structs[structIndex];
    if (!entry) return null;
    let offset = 0;
    for (const [typeIndex, nameIndex] of entry[1]) {
      const name = sdna.names[nameIndex] || '';
      const bare = name.split('[')[0].replace(/^[*(]+/, '');
      if (bare === wanted) return offset;
      let size = name.startsWith('*') || name.startsWith('(*')
        ? pointerSize : (sdna.lengths[typeIndex] || 0);
      ARRAY_DIMENSION.lastIndex = 0;
      let match = ARRAY_DIMENSION.exec(name);
      while (match) {
        size *= Number(match[1]);
        match = ARRAY_DIMENSION.exec(name);
      }
      offset += size;
    }
    return null;
  }

  /** Field offsets and size for one SDNA struct, computed from the file. */
  function structInfo(sdna, name, pointerSize) {
    const index = structNamed(sdna, name);
    const info = { index, size: 0, offsets: {} };
    if (index === null) return info;
    const typeIndex = sdna.structs[index][0];
    info.size = sdna.lengths[typeIndex] || 0;
    let offset = 0;
    for (const [fieldType, fieldName] of sdna.structs[index][1]) {
      const raw = sdna.names[fieldName] || '';
      const bare = raw.split('[')[0].replace(/^[*(]+/, '');
      if (!(bare in info.offsets)) info.offsets[bare] = offset;
      let size = raw.startsWith('*') || raw.startsWith('(*')
        ? pointerSize : (sdna.lengths[fieldType] || 0);
      ARRAY_DIMENSION.lastIndex = 0;
      let match = ARRAY_DIMENSION.exec(raw);
      while (match) { size *= Number(match[1]); match = ARRAY_DIMENSION.exec(raw); }
      offset += size;
    }
    return info;
  }

  const hasFields = (info, ...fields) =>
    info.index !== null && fields.every((f) => f in info.offsets);

  /**
   * Pull a mesh out of the four parallel arrays Blender writes: MVert holds
   * the coordinates, MLoop the per-corner vertex indices, MPoly the run of
   * loops each polygon owns, MLoopUV the texture coordinates.
   */
  function extractMesh(view, bytes, base, structs, byAddress, little, pointerSize) {
    const { mesh, vert, poly, loop, loopUv } = structs;
    const readInt = (field) => view.getInt32(base + mesh.offsets[field], little);
    const follow = (field) => {
      if (!(field in mesh.offsets)) return null;
      const at = base + mesh.offsets[field];
      const address = pointerSize === 8
        ? Number(view.getBigUint64(at, little)) : view.getUint32(at, little);
      return byAddress.get(address) || null;
    };

    const totvert = readInt('totvert');
    const totpoly = readInt('totpoly');
    const totloop = readInt('totloop');
    if (totvert <= 0 || totloop <= 0) return null;

    const vertBlock = follow('mvert');
    const polyBlock = follow('mpoly');
    const loopBlock = follow('mloop');
    const uvBlock = follow('mloopuv');
    if (!vertBlock || !polyBlock || !loopBlock) return null;

    const positions = new Float64Array(totvert * 3);
    const normals = new Float64Array(totvert * 3);
    const coOffset = vert.offsets.co;
    const noOffset = vert.offsets.no;
    for (let i = 0; i < totvert; i++) {
      const at = vertBlock.body + i * vert.size;
      for (let k = 0; k < 3; k++) {
        positions[i * 3 + k] = view.getFloat32(at + coOffset + k * 4, little);
        if (noOffset !== undefined) {
          // Vertex normals are stored as normalised shorts.
          normals[i * 3 + k] = view.getInt16(at + noOffset + k * 2, little) / 32767;
        }
      }
    }

    const corner = new Uint32Array(totloop);
    const loopV = loop.offsets.v;
    for (let i = 0; i < totloop; i++) {
      corner[i] = view.getUint32(loopBlock.body + i * loop.size + loopV, little);
    }

    const indices = new Int32Array(totloop);
    const materials = new Int32Array(totpoly);
    const startOffset = poly.offsets.loopstart;
    const countOffset = poly.offsets.totloop;
    const matOffset = poly.offsets.mat_nr;
    let written = 0;
    let polygons = 0;
    for (let i = 0; i < totpoly; i++) {
      const at = polyBlock.body + i * poly.size;
      const start = view.getInt32(at + startOffset, little);
      const count = view.getInt32(at + countOffset, little);
      if (count < 3 || start < 0 || start + count > totloop) continue;
      for (let position = 0; position < count; position++) {
        const index = corner[start + position];
        // FBX-style run: each polygon's last index is complemented.
        indices[written++] = position === count - 1 ? ~index : index;
      }
      materials[polygons++] = matOffset === undefined
        ? 0 : view.getInt16(at + matOffset, little);
    }

    let uvs = null;
    if (uvBlock && hasFields(loopUv, 'uv')) {
      uvs = new Float64Array(totloop * 2);
      const uvOffset = loopUv.offsets.uv;
      for (let i = 0; i < totloop; i++) {
        const at = uvBlock.body + i * loopUv.size + uvOffset;
        uvs[i * 2] = view.getFloat32(at, little);
        uvs[i * 2 + 1] = view.getFloat32(at + 4, little);
      }
    }

    return {
      positions,
      normals: noOffset === undefined ? null : normals,
      indices: indices.subarray(0, written),
      materials: materials.subarray(0, polygons),
      uvs,
      totvert,
    };
  }

  function structNamed(sdna, name) {
    for (let i = 0; i < sdna.structs.length; i++) {
      if (sdna.types[sdna.structs[i][0]] === name) return i;
    }
    return null;
  }

  /* ----------------------------------------------------------------- parse */

  function parse(bytes) {
    const warnings = [];
    const extra = { compression: 'none' };

    if (startsWith(bytes, ZSTD)) {
      extra.compression = 'zstd';
      warnings.push('this file is Zstandard-compressed (Blender 3.0+ with Compress '
        + 'on); re-save it with Compress off, or decompress it first');
      return document_({ warnings, extra, root: { name: '', props: [], children: [
        node('BlenderFile', [], [node('Compression', [S('zstd')])]),
      ] } }, bytes.length);
    }
    if (startsWith(bytes, GZIP)) {
      // The browser can inflate gzip natively, but only asynchronously; the
      // caller path here is synchronous, so this is reported rather than read.
      extra.compression = 'gzip';
      warnings.push('this file is gzip-compressed; re-save it with Compress off, '
        + 'or decompress it first');
      return document_({ warnings, extra, root: { name: '', props: [], children: [
        node('BlenderFile', [], [node('Compression', [S('gzip')])]),
      ] } }, bytes.length);
    }

    const decoder = new TextDecoder('latin1');
    if (decoder.decode(bytes.subarray(0, 7)) !== MAGIC) return null;

    const pointerFlag = String.fromCharCode(bytes[7]);
    const endianFlag = String.fromCharCode(bytes[8]);
    const pointerSize = pointerFlag === '-' ? 8 : 4;
    const little = endianFlag !== 'V';
    const version = parseInt(decoder.decode(bytes.subarray(9, 12)), 10) || null;

    Object.assign(extra, {
      pointerSize,
      endianness: little ? 'little' : 'big',
      blenderVersion: version,
      blenderVersionText: describeVersion(version),
    });

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // code(4) + size(4) + old pointer + SDNA index(4) + count(4)
    const headerSize = 16 + pointerSize;
    const blocks = [];
    let sdna = { names: [], types: [], lengths: [], structs: [] };
    let position = 12;

    while (position + headerSize <= bytes.length) {
      const code = decoder.decode(bytes.subarray(position, position + 4)).replace(/\0+$/, '');
      const size = view.getUint32(position + 4, little);
      const oldPointer = pointerSize === 8
        ? Number(view.getBigUint64(position + 8, little))
        : view.getUint32(position + 8, little);
      const sdnaIndex = view.getUint32(position + 8 + pointerSize, little);
      const count = view.getUint32(position + 12 + pointerSize, little);
      const body = position + headerSize;

      if (code === 'ENDB') { blocks.push({ code, size, oldPointer, sdnaIndex, count, body }); break; }
      if (body + size > bytes.length) {
        warnings.push(`block '${code}' at ${position} claims ${size} bytes but the file ends`);
        break;
      }
      blocks.push({ code, size, oldPointer, sdnaIndex, count, body });
      if (code === 'DNA1') {
        try {
          sdna = readSdna(view, body, size, little);
        } catch (error) {
          warnings.push(`the DNA1 block could not be read: ${error.message}`);
        }
      }
      position = body + size;
    }

    if (!blocks.length) warnings.push('no file-blocks were found');
    else if (blocks[blocks.length - 1].code !== 'ENDB') {
      warnings.push('the file does not end with an ENDB block; it may be truncated');
    }

    const nameOffset = fieldOffset(sdna, structNamed(sdna, 'ID'), 'name', pointerSize);
    const counts = new Map();
    for (const block of blocks) counts.set(block.code, (counts.get(block.code) || 0) + 1);

    const root = { name: '', props: [], children: [] };
    root.children.push(node('BlenderFile', [], [
      node('Version', [I(version || 0)]),
      node('VersionText', [S(extra.blenderVersionText)]),
      node('PointerSize', [I(pointerSize)]),
      node('Endianness', [S(extra.endianness)]),
      node('Compression', [S('none')]),
      node('BlockCount', [I(blocks.length)]),
    ]));
    root.children.push(node('Blocks', [],
      [...counts.entries()].sort((a, b) => b[1] - a[1])
        .map(([code, n]) => node('Block', [S(code), I(n)]))));
    root.children.push(node('DNA', [], [
      node('Structs', [I(sdna.structs.length)]),
      node('Types', [I(sdna.types.length)]),
      node('Names', [I(sdna.names.length)]),
    ]));

    const decodeName = (block) => {
      if (nameOffset === null) return '';
      const at = block.body + nameOffset;
      let end = at;
      while (end < bytes.length && end < at + 66 && bytes[end] !== 0) end++;
      const text = new TextDecoder('utf-8').decode(bytes.subarray(at, end));
      return text.slice(0, 2) === block.code ? text.slice(2) : text;
    };

    const structs = {
      mesh: structInfo(sdna, 'Mesh', pointerSize),
      vert: structInfo(sdna, 'MVert', pointerSize),
      poly: structInfo(sdna, 'MPoly', pointerSize),
      loop: structInfo(sdna, 'MLoop', pointerSize),
      loopUv: structInfo(sdna, 'MLoopUV', pointerSize),
      material: structInfo(sdna, 'Material', pointerSize),
    };
    const byAddress = new Map();
    for (const block of blocks) if (block.oldPointer) byAddress.set(block.oldPointer, block);

    const canExtract = hasFields(structs.mesh, 'mvert', 'mpoly', 'mloop',
      'totvert', 'totpoly', 'totloop')
      && hasFields(structs.vert, 'co') && hasFields(structs.poly, 'loopstart', 'totloop')
      && hasFields(structs.loop, 'v');
    if (!canExtract && blocks.some((b) => b.code === 'ME')) {
      warnings.push('this Blender version stores mesh data as generic attributes '
        + 'rather than the MVert/MPoly/MLoop arrays; geometry was not extracted');
    }

    // The materials a mesh points at, in slot order, which is what a polygon's
    // material index refers to.
    const materialSlots = (base) => {
      if (!hasFields(structs.mesh, 'mat', 'totcol')) return [];
      const total = view.getInt16(base + structs.mesh.offsets.totcol, little);
      const at = base + structs.mesh.offsets.mat;
      const address = pointerSize === 8
        ? Number(view.getBigUint64(at, little)) : view.getUint32(at, little);
      const table = byAddress.get(address);
      if (total <= 0 || !table) return [];
      const slots = [];
      for (let i = 0; i < total; i++) {
        const entry = table.body + i * pointerSize;
        if (entry + pointerSize > bytes.length) break;
        const pointer = pointerSize === 8
          ? Number(view.getBigUint64(entry, little)) : view.getUint32(entry, little);
        slots.push(pointer);
      }
      return slots;
    };

    /**
     * A material's appearance, as the diffuse/specular pair FBX describes.
     *
     * Blender keeps a viewport colour on the datablock, plus the metallic,
     * roughness and specular values its viewport and EEVEE fall back on. A
     * metal has no diffuse and reflects its own colour; a dielectric reflects
     * 8% of `specular`, the convention the Principled BSDF uses. Roughness
     * becomes a Blinn-Phong exponent, which is what FBX materials carry.
     */
    const materialLook = (block) => {
      const field = (name, fallback) => (hasFields(structs.material, name)
        ? view.getFloat32(block.body + structs.material.offsets[name], little)
        : fallback);
      const base = hasFields(structs.material, 'r')
        ? [0, 1, 2].map((k) => view.getFloat32(
          block.body + structs.material.offsets.r + k * 4, little))
        : [0.8, 0.8, 0.8];
      const metallic = Math.min(Math.max(field('metallic', 0), 0), 1);
      const roughness = Math.min(Math.max(field('roughness', 0.5), 0.03), 1);
      const dielectric = 0.08 * Math.min(Math.max(field('spec', 0.5), 0), 1);
      return {
        colour: base.map((c) => c * (1 - metallic)),
        specular: base.map((c) => dielectric * (1 - metallic) + c * metallic),
        /* A Phong exponent, which is what an FBX material states. The
         * relation runs through the microfacet alpha: `alpha = roughness
         * squared` and `alpha = sqrt(2 / (n + 2))`, so `n` is two over the
         * fourth power. Squaring once instead loses the round trip and
         * hands back a surface far shinier than Blender was showing. */
        shininess: 2 / (roughness ** 4) - 2,
        metallic,
        // The fourth component of the viewport colour, which is where Blender
        // keeps a material's transparency.
        opacity: Math.min(Math.max(field('a', 1), 0), 1),
      };
    };

    const bulk = (code, values) => ({
      code,
      typeName: `${code === 'd' ? 'float64' : 'int32'}[]`,
      array: { length: values.length, encoding: 0,
               byteLength: values.length * (code === 'd' ? 8 : 4), dataOffset: 0 },
      values,
      value: null,
    });

    const objects = node('Objects', [], []);
    const connections = [];
    // Synthetic model UIDs are small integers; real ones are former memory
    // addresses, so the two cannot collide.
    let nextModelUid = 1;
    let meshCount = 0;

    for (const block of blocks) {
      const kind = ID_TYPES[block.code];
      if (!kind) continue;
      const label = decodeName(block);

      if (block.code === 'ME' && canExtract) {
        const data = extractMesh(view, bytes, block.body, structs, byAddress,
          little, pointerSize);
        if (data) {
          meshCount++;
          const children = [
            node('Vertices', [bulk('d', data.positions)]),
            node('PolygonVertexIndex', [bulk('i', data.indices)]),
            node('GeometryVersion', [I(124)]),
          ];
          if (data.normals) {
            children.push(node('LayerElementNormal', [I(0)], [
              node('MappingInformationType', [S('ByVertice')]),
              node('ReferenceInformationType', [S('Direct')]),
              node('Normals', [bulk('d', data.normals)]),
            ]));
          }
          if (data.uvs) {
            children.push(node('LayerElementUV', [I(0)], [
              node('Name', [S('UVMap')]),
              node('MappingInformationType', [S('ByPolygonVertex')]),
              node('ReferenceInformationType', [S('Direct')]),
              node('UV', [bulk('d', data.uvs)]),
            ]));
          }
          children.push(node('LayerElementMaterial', [I(0)], [
            node('MappingInformationType', [S('ByPolygon')]),
            node('ReferenceInformationType', [S('IndexToDirect')]),
            node('Materials', [bulk('i', data.materials)]),
          ]));
          children.push(node('Layer', [I(0)], [node('Version', [I(100)])]));

          objects.children.push(node('Geometry',
            [L(block.oldPointer), S(`${label}${CLASS_SEP}Geometry`), S('Mesh')],
            children));
          const modelUid = nextModelUid++;
          objects.children.push(node('Model',
            [L(modelUid), S(`${label}${CLASS_SEP}Model`), S('Mesh')],
            [node('Version', [I(232)])]));
          connections.push(node('C', [S('OO'), L(modelUid), L(0)]));
          connections.push(node('C', [S('OO'), L(block.oldPointer), L(modelUid)]));
          for (const pointer of materialSlots(block.body)) {
            if (pointer) connections.push(node('C', [S('OO'), L(pointer), L(modelUid)]));
          }
          continue;
        }
      }

      if (block.code === 'MA') {
        const look = materialLook(block);
        const D = (value) => ({ code: 'D', typeName: 'float64', value });
        objects.children.push(node('Material',
          [L(block.oldPointer), S(`${label}${CLASS_SEP}Material`), S('')], [
            node('Version', [I(102)]),
            node('ShadingModel', [S('phong')]),
            node('Properties70', [], [
              node('P', [S('DiffuseColor'), S('Color'), S(''), S('A'),
                ...look.colour.map(D)]),
              node('P', [S('SpecularColor'), S('Color'), S(''), S('A'),
                ...look.specular.map(D)]),
              node('P', [S('ShininessExponent'), S('Number'), S(''), S('A'),
                D(look.shininess)]),
              // Blender states metalness outright, so the reflectance above is
              // measured rather than inferred from a highlight colour.
              node('P', [S('Metallic'), S('Number'), S(''), S('A'),
                D(look.metallic)]),
              node('P', [S('Opacity'), S('Number'), S(''), S('A'),
                D(look.opacity)]),
            ]),
          ]));
        continue;
      }

      objects.children.push(node(kind,
        [L(block.oldPointer), S(`${label}${CLASS_SEP}${kind}`), S(block.code)],
        [node('Size', [I(block.size)])]));
    }
    if (objects.children.length) root.children.push(objects);
    if (connections.length) root.children.push(node('Connections', [], connections));
    extra.meshes = meshCount;

    Object.assign(extra, {
      blockCount: blocks.length,
      datablocks: objects.children.length,
      structCount: sdna.structs.length,
      typeCount: sdna.types.length,
      nameCount: sdna.names.length,
    });
    return document_({ warnings, extra, root }, bytes.length);
  }

  function document_({ warnings, extra, root }, size) {
    return {
      format: 'blend',
      encoding: 'binary',
      version: null,
      versionSource: null,
      wideOffsets: extra.pointerSize === 8,
      hasFooter: false,
      footerVersion: null,
      fileSize: size,
      root,
      warnings,
      extra,
    };
  }

  return { parse, looksLikeBlend, describeVersion };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = FbxBlend;
