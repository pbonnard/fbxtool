/* Glue for the WebAssembly core: uploads a file into linear memory, walks the
 * flat tree image the parser writes there, and hands geometry back to it.
 *
 * Loads in both the browser (inlined into the page) and Node (via require),
 * so the same code path is what the tests exercise.
 */
'use strict';

const FbxWasm = (function () {
  const NODE_STRIDE = 32;
  const PROP_STRIDE = 24;

  // Property type code -> bytes per element, for array payloads.
  const ARRAY_ELEMENT = { f: 4, d: 8, l: 8, i: 4, b: 1 };
  const ARRAY_TYPE_NAME = {
    f: 'float32', d: 'float64', l: 'int64', i: 'int32', b: 'bool',
  };
  const SCALAR_TYPE_NAME = {
    Y: 'int16', C: 'bool', I: 'int32', F: 'float32', D: 'float64', L: 'int64',
    S: 'string', R: 'raw',
  };

  const WARNINGS = {
    1: (a) => `record at offset ${a}: property list length disagrees with its header`,
    2: (a) => `record at offset ${a}: end offset out of range; that branch was cut short`,
    3: (a) => `record at offset ${a}: ends somewhere other than its declared end offset`,
    4: (a) => `record at offset ${a}: stray bytes where a nested record was expected`,
    5: () => 'footer magic not found; the file may be truncated',
    6: (a) => `footer version ${a} does not match the header version`,
    7: (a) => `file ends part-way through a top-level record header at ${a}`,
    8: (a) => `unknown property type code 0x${a.toString(16)}`,
  };

  let instance = null;
  let exports_ = null;
  let fileOffset = 0;
  let fileLength = 0;

  /** Views must be re-taken after anything that can grow memory. */
  function bytes() { return new Uint8Array(exports_.memory.buffer); }
  function view() { return new DataView(exports_.memory.buffer); }

  async function init(source) {
    let module_;
    if (source instanceof WebAssembly.Module) {
      module_ = source;
    } else if (typeof source === 'string') {
      const raw = atob(source);
      const buffer = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) buffer[i] = raw.charCodeAt(i);
      module_ = await WebAssembly.compile(buffer);
    } else {
      module_ = await WebAssembly.compile(source);
    }
    instance = await WebAssembly.instantiate(module_, {});
    exports_ = instance.exports;
    return exports_;
  }

  /** Copy a file into linear memory. Returns its offset. */
  function upload(data) {
    exports_.fbx_reset();
    const offset = exports_.fbx_alloc(data.length);
    if (!offset) throw new Error('out of WebAssembly memory');
    bytes().set(data, offset);
    fileOffset = offset;
    fileLength = data.length;
    return offset;
  }

  /* Descriptors record offsets relative to the start of the file, so they stay
   * valid wherever the upload landed; resolve them against that base. */
  function absolute(fileRelative) { return fileOffset + fileRelative; }

  function decodeUtf8(offset, length) {
    const slice = bytes().subarray(offset, offset + length);
    return new TextDecoder('utf-8').decode(slice);
  }

  function readScalar(code, at) {
    const dv = view();
    switch (code) {
      case 'C': return dv.getUint8(at) !== 0;
      case 'Y': return dv.getInt16(at, true);
      case 'I': return dv.getInt32(at, true);
      case 'F': return dv.getFloat32(at, true);
      case 'D': return dv.getFloat64(at, true);
      case 'L': {
        const big = dv.getBigInt64(at, true);
        // FBX UIDs comfortably fit a double; fall back to BigInt if not.
        return (big >= -9007199254740991n && big <= 9007199254740991n)
          ? Number(big) : big;
      }
      default: return null;
    }
  }

  /** Build the JavaScript tree from the flat image the parser wrote. */
  function readTree() {
    const count = exports_.fbx_node_count();
    const nodesAt = exports_.fbx_nodes_ptr();
    const propsAt = exports_.fbx_props_ptr();
    const dv = view();

    const props = [];
    const propCount = exports_.fbx_prop_count();
    for (let i = 0; i < propCount; i++) {
      const base = propsAt + i * PROP_STRIDE;
      const code = String.fromCharCode(dv.getUint32(base, true));
      const arrayLen = dv.getUint32(base + 4, true);
      const encoding = dv.getUint32(base + 8, true);
      const byteLen = dv.getUint32(base + 12, true);
      const dataOff = dv.getUint32(base + 16, true);
      const isArray = dv.getUint32(base + 20, true) === 1;

      if (isArray) {
        props.push({
          code,
          typeName: (ARRAY_TYPE_NAME[code] || code) + '[]',
          array: { length: arrayLen, encoding, byteLength: byteLen, dataOffset: dataOff },
          value: null,
        });
      } else if (code === 'S') {
        props.push({
          code, typeName: 'string',
          value: decodeUtf8(absolute(dataOff), byteLen),
        });
      } else if (code === 'R') {
        props.push({
          code, typeName: 'raw',
          value: bytes().slice(absolute(dataOff), absolute(dataOff) + byteLen),
        });
      } else {
        props.push({
          code,
          typeName: SCALAR_TYPE_NAME[code] || `unknown(${code})`,
          value: readScalar(code, absolute(dataOff)),
        });
      }
    }

    const nodes = new Array(count);
    for (let i = 0; i < count; i++) {
      const base = nodesAt + i * NODE_STRIDE;
      const nameOff = dv.getUint32(base, true);
      const nameLen = dv.getUint32(base + 4, true);
      const propStart = dv.getUint32(base + 8, true);
      const propCountHere = dv.getUint32(base + 12, true);
      const parent = dv.getUint32(base + 16, true);
      const srcOffset = dv.getUint32(base + 20, true);

      nodes[i] = {
        name: i === 0 ? '' : decodeUtf8(absolute(nameOff), nameLen),
        props: props.slice(propStart, propStart + propCountHere),
        children: [],
        offset: srcOffset,
      };
      // Records are emitted depth-first, so a parent always exists already.
      if (i > 0 && parent < i) nodes[parent].children.push(nodes[i]);
    }
    return nodes[0] || { name: '', props: [], children: [] };
  }

  function readWarnings() {
    const count = exports_.fbx_warning_count();
    const at = exports_.fbx_warnings_ptr();
    const dv = view();
    const out = [];
    for (let i = 0; i < count; i++) {
      const code = dv.getUint32(at + i * 8, true);
      const arg = dv.getUint32(at + i * 8 + 4, true);
      const format = WARNINGS[code];
      const text = format ? format(arg) : `warning ${code} (${arg})`;
      if (!out.includes(text)) out.push(text);
    }
    return out;
  }

  /** Parse binary FBX data. Returns null when it is not a binary FBX file. */
  function parseBinary(data) {
    upload(data);
    if (!exports_.fbx_parse(fileOffset, fileLength)) return null;
    return {
      encoding: 'binary',
      version: exports_.fbx_version(),
      wideOffsets: exports_.fbx_wide() !== 0,
      hasFooter: exports_.fbx_has_footer() !== 0,
      footerVersion: exports_.fbx_footer_version() || null,
      fileSize: fileLength,
      root: readTree(),
      warnings: readWarnings(),
    };
  }

  /* ---------------------------------------------------------------- arrays */

  /** Offset of an array payload in linear memory, inflating it if needed. */
  function payloadOffset(prop) {
    const info = prop.array;
    const elementSize = ARRAY_ELEMENT[prop.code] || 1;
    const expected = info.length * elementSize;
    const at = absolute(info.dataOffset);
    if (info.encoding === 0) return at; // already contiguous in memory
    const out = exports_.fbx_inflate(at, info.byteLength, expected);
    if (!out) throw new Error('could not inflate an array payload');
    return out;
  }

  /** An array payload as float64 in linear memory, converting if needed. */
  function asFloat64(prop) {
    const at = payloadOffset(prop);
    const count = prop.array.length;
    if (prop.code === 'd') return { offset: at, count };
    const out = exports_.fbx_alloc(count * 8);
    const buffer = exports_.memory.buffer;
    const dst = new Float64Array(buffer, out, count);
    if (prop.code === 'f') dst.set(new Float32Array(buffer, at, count));
    else if (prop.code === 'i') dst.set(new Int32Array(buffer, at, count));
    else return { offset: 0, count: 0 };
    return { offset: out, count };
  }

  /** An array payload as int32 in linear memory, converting if needed. */
  function asInt32(prop) {
    const at = payloadOffset(prop);
    const count = prop.array.length;
    if (prop.code === 'i') return { offset: at, count };
    const out = exports_.fbx_alloc(count * 4);
    const buffer = exports_.memory.buffer;
    const dst = new Int32Array(buffer, out, count);
    if (prop.code === 'l') {
      const src = new BigInt64Array(buffer, at, count);
      for (let i = 0; i < count; i++) dst[i] = Number(src[i]);
    } else if (prop.code === 'd') {
      dst.set(new Float64Array(buffer, at, count));
    } else {
      return { offset: 0, count: 0 };
    }
    return { offset: out, count };
  }

  /** Copy a JavaScript array into linear memory as float64. */
  function uploadFloat64(values) {
    const out = exports_.fbx_alloc(Math.max(values.length, 1) * 8);
    new Float64Array(exports_.memory.buffer, out, values.length).set(values);
    return { offset: out, count: values.length };
  }

  /** Copy a JavaScript array into linear memory as int32. */
  function uploadInt32(values) {
    const out = exports_.fbx_alloc(Math.max(values.length, 1) * 4);
    new Int32Array(exports_.memory.buffer, out, values.length).set(values);
    return { offset: out, count: values.length };
  }

  /* ------------------------------------------------------------------ mesh */

  const MAPPING = { none: 0, byPolygonVertex: 1, byVertex: 2 };
  const REFERENCE = { direct: 0, indexToDirect: 1 };

  /** Field order of the MeshParams block in fbx.c. */
  const PARAM_FIELDS = [
    'posOff', 'posCount', 'idxOff', 'idxCount',
    'nrmOff', 'nrmCount', 'nrmIndexOff', 'nrmIndexCount', 'nrmMapping', 'nrmReference',
    'uvOff', 'uvCount', 'uvIndexOff', 'uvIndexCount', 'uvMapping', 'uvReference',
    'matOff', 'matCount',
    'xformOff', 'normalXformOff', 'flipWinding', 'materialBase',
  ];

  const slot = (pair) => (pair ? pair.offset : 0);
  const size = (pair) => (pair ? pair.count : 0);

  /**
   * Triangulate a mesh.
   *
   * Every array is an {offset, count} pair in linear memory. `normals` and
   * `uvs` may each carry an `index` pair when the layer is IndexToDirect.
   */
  function buildMesh(spec) {
    const values = {
      posOff: spec.positions.offset, posCount: spec.positions.count,
      idxOff: spec.indices.offset, idxCount: spec.indices.count,
      nrmOff: slot(spec.normals), nrmCount: size(spec.normals),
      nrmIndexOff: slot(spec.normalIndex), nrmIndexCount: size(spec.normalIndex),
      nrmMapping: MAPPING[spec.normalMapping] || 0,
      nrmReference: REFERENCE[spec.normalReference] || 0,
      uvOff: slot(spec.uvs), uvCount: size(spec.uvs),
      uvIndexOff: slot(spec.uvIndex), uvIndexCount: size(spec.uvIndex),
      uvMapping: MAPPING[spec.uvMapping] || 0,
      uvReference: REFERENCE[spec.uvReference] || 0,
      matOff: slot(spec.materials), matCount: size(spec.materials),
      xformOff: spec.transform ? uploadFloat64(spec.transform).offset : 0,
      normalXformOff: spec.normalTransform ? uploadFloat64(spec.normalTransform).offset : 0,
      flipWinding: spec.flipWinding ? 1 : 0,
      materialBase: spec.materialBase || 0,
    };
    const block = exports_.fbx_alloc(PARAM_FIELDS.length * 4);
    const params = new Uint32Array(exports_.memory.buffer, block, PARAM_FIELDS.length);
    PARAM_FIELDS.forEach((name, i) => { params[i] = values[name] >>> 0; });

    const result = exports_.fbx_build_mesh(block);
    if (!result) throw new Error('mesh building ran out of memory');

    const dv = view();
    const triangleCount = dv.getUint32(result, true);
    const positionsAt = dv.getUint32(result + 4, true);
    const normalsAt = dv.getUint32(result + 8, true);
    const materialsAt = dv.getUint32(result + 12, true);
    const min = [16, 20, 24].map((o) => dv.getFloat32(result + o, true));
    const max = [28, 32, 36].map((o) => dv.getFloat32(result + o, true));
    const polygonCount = dv.getUint32(result + 40, true);
    const degenerate = dv.getUint32(result + 44, true);
    const uvAt = dv.getUint32(result + 48, true);
    const hasUv = dv.getUint32(result + 52, true) === 1;

    const vertices = triangleCount * 9;
    const buffer = exports_.memory.buffer;
    const empty = new Float32Array(0);
    return {
      triangleCount,
      polygonCount,
      degenerate,
      hasUv,
      min,
      max,
      // Views into linear memory — copied before the next parse, not retained.
      positions: triangleCount ? new Float32Array(buffer, positionsAt, vertices) : empty,
      normals: triangleCount ? new Float32Array(buffer, normalsAt, vertices) : empty,
      materials: triangleCount ? new Float32Array(buffer, materialsAt, triangleCount * 3) : empty,
      uvs: triangleCount ? new Float32Array(buffer, uvAt, triangleCount * 6) : empty,
    };
  }

  /** Mark the allocator so scratch from one build can be rewound after use. */
  function mark() { return exports_.fbx_heap_mark(); }
  function release(at) { exports_.fbx_heap_release(at); }

  return {
    init, parseBinary, buildMesh, payloadOffset, asFloat64, asInt32,
    uploadFloat64, uploadInt32, mark, release,
    get exports() { return exports_; },
    get fileOffset() { return fileOffset; },
    ARRAY_ELEMENT,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = FbxWasm;
