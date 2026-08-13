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

    const objects = node('Objects', [], []);
    for (const block of blocks) {
      const kind = ID_TYPES[block.code];
      if (!kind) continue;
      let label = '';
      if (nameOffset !== null) {
        const at = block.body + nameOffset;
        let end = at;
        while (end < bytes.length && end < at + 66 && bytes[end] !== 0) end++;
        label = new TextDecoder('utf-8').decode(bytes.subarray(at, end));
        if (label.slice(0, 2) === block.code) label = label.slice(2);
      }
      objects.children.push(node(kind,
        [L(block.oldPointer), S(`${label}${CLASS_SEP}${kind}`), S(block.code)],
        [node('Size', [I(block.size)])]));
    }
    if (objects.children.length) root.children.push(objects);

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
