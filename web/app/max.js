/* Read Autodesk 3ds Max scenes — .max — into the record tree every other
 * reader here produces, so the report, the viewer and the exporter work on
 * them unchanged. The Python side, fbxtool/maxfile.py, is the same reader and
 * carries the account of the format; what follows is only what the two have
 * to agree on:
 *
 *   a .max is an OLE2 compound file; the scene is one of its streams
 *   a chunk is uint16 id, uint32 length, bit 31 of the length = has children
 *   a zero length means a uint64 follows, and there the flag is bit 63
 *   the scene is a flat list of entities; a chunk's id IS its class
 *   an entity's position in that list is how other entities name it
 *
 * Geometry comes out of Editable Poly objects. The modifier stack is not run,
 * so a scene modelled with TurboSmooth gives its cage — which is what the
 * smoothing control in the viewer is for.
 */
'use strict';

const FbxMax = (function () {
  // Written as an escape: the page inlines this script into its HTML, and
  // an HTML parser turns a raw NUL into a replacement character.
  const CLASS_SEP = '\u0000\u0001';
  const MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  const FREE = 0xffffffff;
  const END = 0xfffffffe;

  const MESH = 0x08fe;
  const VERTS = 0x0100;
  const EDGES = 0x010a;
  const FACES = 0x011a;
  const MAP_VERTS = 0x0128;
  const MAP_FACES = 0x012b;
  // The same block holds an Editable Mesh, which is a different shape: three
  // corners to a face, and no flag word in front of a vertex.
  const TRI_VERTS = 0x0914;
  const TRI_FACES = 0x0912;
  const TRI_MAP_VERTS = 0x2394;
  const TRI_MAP_FACES = 0x2396;
  const NAME = 0x0962;
  const PARENT = 0x0960;
  const OFFSET_POS = 0x096a;
  const OFFSET_ROT = 0x096b;
  const OFFSET_SCALE = 0x096c;
  const REFS = 0x2034;
  const TYPED_REFS = 0x2035;
  const POINT3 = 0x2503;
  const SCALE = 0x2505;
  const FLOAT = 0x2501;
  const CLASS_NAME = 0x2042;
  const CLASS_IDS = 0x2060;
  // A material and its parameter blocks.
  // The block a material keeps its name in, under each of the three ids it is
  // written with. 0x5431 is where 3ds Max's own materials put it, 0x0fa0 is
  // Corona's, and 0x4000 is what a Blend, a Standard and a VRayCarPaintMtl
  // use — which is why those came out numbered rather than named.
  const MTL_BASES = [0x5431, 0x0fa0, 0x4000];
  const MTL_NAME = 0x4001;
  // One parameter of a ParamBlock2, under either of the two ids the block is
  // written with. Which one a file uses is the writer's own business and not
  // the parameter's: the payload behind both is the same `uint16 id; uint16
  // type;` record, and a 3ds Max 2012 scene whose materials all come out grey
  // is one whose every parameter sits under 0x000e.
  const PARAMS = [0x000e, 0x100e];
  const ASSET_REF = 0x0003;
  const MTL_CLASS = 0xc00;
  // A parameter's type, of the list the SDK publishes. Only these two are
  // whole numbers; the rest of what a shader keeps is float-valued.
  const PARAM_INT = 1;
  const PARAM_BOOL = 4;
  const PARAM_TEXMAP = 15;          // a slot for a map, with no value of its own

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
      array: {
        length: values.length, encoding: 0, byteLength: values.length * size, dataOffset: 0,
      },
      values,
      value: null,
    };
  }

  const p70 = (name, kind, ...values) =>
    node('P', [S(name), S(kind), S(''), S('A'), ...values]);

  /**
   * Undo the gzip wrapper 3ds Max 2022 and later put round a stream.
   *
   * The header is ten bytes and whatever its flags add; the last four say how
   * much comes out, which is exactly the buffer to ask for. The inflating
   * itself is the WebAssembly module's, the same one that unpacks an FBX.
   */
  function gunzip(bytes) {
    if (bytes.length < 18) throw new Error('a compressed stream is too short');
    const flags = bytes[3];
    let at = 10;
    if (flags & 0x04) at += 2 + (bytes[at] | (bytes[at + 1] << 8));   // extra
    if (flags & 0x08) { while (at < bytes.length && bytes[at]) at += 1; at += 1; }
    if (flags & 0x10) { while (at < bytes.length && bytes[at]) at += 1; at += 1; }
    if (flags & 0x02) at += 2;                                        // header crc
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const size = view.getUint32(bytes.length - 4, true);
    if (typeof FbxWasm === 'undefined' || !FbxWasm.inflateRaw) {
      throw new Error('this .max is compressed, and the WebAssembly module '
        + 'that would inflate it is not loaded');
    }
    return FbxWasm.inflateRaw(bytes.subarray(at, bytes.length - 8), size);
  }

  /** True for any compound file; only reading it says whether it is a .max. */
  function looksLikeMax(bytes) {
    if (!bytes || bytes.length < 512) return false;
    for (let i = 0; i < 8; i++) if (bytes[i] !== MAGIC[i]) return false;
    return true;
  }

  /* ------------------------------------------------------------ container */

  class Compound {
    constructor(bytes) {
      this.bytes = bytes;
      this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const shift = this.view.getUint16(0x1e, true);
      const miniShift = this.view.getUint16(0x20, true);
      if (shift < 7 || shift > 20) throw new Error(`impossible sector size (1 << ${shift})`);
      this.sector = 1 << shift;
      this.mini = 1 << miniShift;
      this.fatCount = this.view.getUint32(0x2c, true);
      this.dirStart = this.view.getUint32(0x30, true);
      this.cutoff = this.view.getUint32(0x38, true);
      this.miniStart = this.view.getUint32(0x3c, true);
      this.miniCount = this.view.getUint32(0x40, true);
      this.difatStart = this.view.getUint32(0x44, true);
      this.difatCount = this.view.getUint32(0x48, true);
      this.fat = this.readFat();
      this.entries = this.readDirectory();
      const root = this.entries[0];
      this.miniStream = root ? this.chain(root.start, root.size, false) : new Uint8Array(0);
      this.miniFat = this.readMiniFat();
    }

    sectorAt(number) {
      const at = (number + 1) * this.sector;
      if (at >= this.bytes.length) throw new Error('a sector runs past the end');
      return at;
    }

    /** A sector's bytes, padded when the file stops mid-sector — which files
     *  in the wild do, and which is no reason to refuse the other 98 MB. */
    sectorBytes(number) {
      const at = this.sectorAt(number);
      const have = Math.min(this.sector, this.bytes.length - at);
      if (have === this.sector) return this.bytes.subarray(at, at + this.sector);
      const out = new Uint8Array(this.sector);
      out.set(this.bytes.subarray(at, at + have));
      return out;
    }

    words(at, count) {
      const out = new Array(count);
      for (let i = 0; i < count; i++) out[i] = this.view.getUint32(at + i * 4, true);
      return out;
    }

    readFat() {
      const sectors = this.words(0x4c, 109);
      let next = this.difatStart;
      let left = this.difatCount;
      while (next !== END && next !== FREE && left > 0) {
        const at = this.sectorAt(next);
        const values = this.words(at, this.sector / 4);
        sectors.push(...values.slice(0, -1));
        next = values[values.length - 1];
        left -= 1;
      }
      const fat = [];
      for (const number of sectors.slice(0, this.fatCount)) {
        if (number === END || number === FREE) continue;
        fat.push(...this.words(this.sectorAt(number), this.sector / 4));
      }
      return fat;
    }

    readMiniFat() {
      const out = [];
      let sector = this.miniStart;
      let left = this.miniCount;
      while (sector !== END && sector !== FREE && left > 0) {
        out.push(...this.words(this.sectorAt(sector), this.sector / 4));
        sector = sector < this.fat.length ? this.fat[sector] : END;
        left -= 1;
      }
      return out;
    }

    chain(start, size, mini) {
      const out = new Uint8Array(size);
      const table = mini ? this.miniFat : this.fat;
      const step = mini ? this.mini : this.sector;
      let sector = start;
      let at = 0;
      let guard = 0;
      while (sector !== END && sector !== FREE && at < size) {
        const take = Math.min(step, size - at);
        if (mini) {
          out.set(this.miniStream.subarray(sector * this.mini, sector * this.mini + take), at);
        } else {
          out.set(this.sectorBytes(sector).subarray(0, take), at);
        }
        at += take;
        sector = sector < table.length ? table[sector] : END;
        guard += 1;
        if (guard > table.length + 2) throw new Error('a stream loops back on itself');
      }
      return out;
    }

    readDirectory() {
      const raw = [];
      let sector = this.dirStart;
      while (sector !== END && sector !== FREE && raw.length < 4096) {
        const at = this.sectorAt(sector);
        for (let off = 0; off + 128 <= this.sector; off += 128) raw.push(at + off);
        sector = sector < this.fat.length ? this.fat[sector] : END;
      }
      const out = [];
      for (const at of raw) {
        const length = this.view.getUint16(at + 64, true);
        const kind = this.bytes[at + 66];
        if (!kind) continue;
        let name = '';
        for (let i = 0; i + 1 < Math.min(length - 2, 64); i += 2) {
          name += String.fromCharCode(this.view.getUint16(at + i, true));
        }
        out.push({
          name,
          kind,
          start: this.view.getUint32(at + 116, true),
          size: this.view.getUint32(at + 120, true),
        });
      }
      return out;
    }

    stream(name) {
      const entry = this.entries.find((e) => e.name === name && e.kind === 2);
      if (!entry) return new Uint8Array(0);
      const data = this.chain(entry.start, entry.size, entry.size < this.cutoff);
      // 3ds Max 2022 and later can gzip what it writes, stream by stream.
      if (data.length > 2 && data[0] === 0x1f && data[1] === 0x8b) return gunzip(data);
      return data;
    }

    get names() {
      return this.entries.filter((e) => e.kind === 2).map((e) => e.name);
    }
  }

  /* --------------------------------------------------------------- chunks */

  /** Call `visit` with every chunk in a range: (id, body, end, container). */
  function chunks(view, start, end, visit) {
    let at = start;
    while (at + 6 <= end) {
      const id = view.getUint16(at, true);
      let length = view.getUint32(at + 2, true);
      let container = (length & 0x80000000) !== 0;
      length >>>= 0;
      length &= 0x7fffffff;
      let head = 6;
      if (length === 0) {
        if (at + 14 > end) return;
        const low = view.getUint32(at + 6, true);
        const high = view.getUint32(at + 10, true);
        container = (high & 0x80000000) !== 0;
        length = (high & 0x7fffffff) * 4294967296 + low;
        head = 14;
      }
      if (length < head || at + length > end) return;
      if (visit(id, at + head, at + length, container) === false) return;
      at += length;
    }
  }

  function findChunk(view, start, end, wanted) {
    let found = null;
    chunks(view, start, end, (id, body, tail) => {
      if (id === wanted) { found = [body, tail]; return false; }
      return true;
    });
    return found;
  }

  function text(view, bytes, start, end) {
    let out = '';
    for (let at = start; at + 1 < end; at += 2) {
      const code = view.getUint16(at, true);
      if (!code) break;
      out += String.fromCharCode(code);
    }
    return out;
  }

  /* -------------------------------------------------------------- streams */

  function readClasses(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const out = [];
    chunks(view, 0, bytes.length, (id, body, tail, container) => {
      if (!container) return true;
      const entry = { name: '', superId: 0, classId: 0, dll: -1 };
      chunks(view, body, tail, (cid, cb, ct) => {
        if (cid === CLASS_NAME) entry.name = text(view, bytes, cb, ct);
        else if (cid === CLASS_IDS && ct - cb >= 16) {
          entry.dll = view.getInt32(cb, true);
          entry.classId = view.getUint32(cb + 4, true);
          entry.superId = view.getUint32(cb + 12, true);
        }
        return true;
      });
      out.push(entry);
      return true;
    });
    return out;
  }

  function readDlls(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const out = [];
    chunks(view, 0, bytes.length, (id, body, tail, container) => {
      if (!container) return true;
      const entry = { description: '', file: '' };
      chunks(view, body, tail, (cid, cb, ct) => {
        if (cid === 0x2039) entry.description = text(view, bytes, cb, ct);
        else if (cid === 0x2037) entry.file = text(view, bytes, cb, ct);
        return true;
      });
      if (entry.description || entry.file) out.push(entry);
      return true;
    });
    return out;
  }

  /**
   * Every file the scene refers to: kind, name, and where it lived.
   *
   * How many strings a record holds is the table's own version: the newer one
   * writes the kind, the file's name and the path it lived at, the older one
   * the kind and the path alone. Both are read, since a scene saved by 3ds Max
   * 2012 keeps the older table and otherwise comes out with no textures at all.
   */
  function readAssets(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const out = [];
    let at = 16;
    let start = 0;
    while (at + 4 <= bytes.length) {
      const strings = [];
      while (strings.length < 3 && at + 4 <= bytes.length) {
        const count = view.getUint32(at, true);
        if (!count || count > 4096 || at + 6 + count * 2 > bytes.length) break;
        strings.push(text(view, bytes, at + 4, at + 4 + count * 2));
        at += 4 + count * 2 + 2;
      }
      if (strings.length >= 2) {
        const path = strings[strings.length - 1];
        // The identifier is the sixteen bytes in front of the record, and it
        // is how a material's parameter block names this file. Where the
        // record does not name the file apart from its path, the name is the
        // last step of that path.
        out.push({
          kind: strings[0],
          name: strings.length >= 3 ? strings[1]
            : path.replace(/\\/g, '/').split('/').pop(),
          path,
          id: Array.from(bytes.subarray(start, start + 16)).join(','),
        });
        start = at;
        at += 16;
      } else break;
    }
    return out;
  }

  function readVersion(config, saveConfig) {
    for (const bytes of [saveConfig, config]) {
      if (!bytes || !bytes.length) continue;
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      let stamp = null;
      chunks(view, 0, bytes.length, (id, body, tail) => {
        if (id === 0x2170 && tail - body >= 4) { stamp = view.getUint32(body, true); return false; }
        return true;
      });
      if (stamp) return stamp;
    }
    return null;
  }

  /** What a saved version number says, as 3ds Max counts them. */
  function versionText(stamp) {
    if (!stamp) return 'unknown';
    const release = stamp >>> 16;
    const build = stamp & 0xffff;
    if (release < 1000 || release > 60000) return String(stamp);
    const major = Math.floor(release / 1000);
    const minor = release % 1000;
    return `${major}.${minor} (3ds Max ${1998 + major}), build ${build}`;
  }

  /* ----------------------------------------------------------------- mesh */

  /** `uint32 count`, then that many points of `stride` bytes ending in x,y,z. */
  function readPoints(view, start, end, stride) {
    if (end - start < 4) return [];
    const count = view.getUint32(start, true);
    if (count > Math.floor((end - start - 4) / stride)) {
      throw new Error(`a point array claims ${count} points it has not got`);
    }
    const out = new Float64Array(count * 3);
    let at = start + 4 + (stride - 12);
    for (let i = 0; i < count; i++) {
      out[i * 3] = view.getFloat32(at, true);
      out[i * 3 + 1] = view.getFloat32(at + 4, true);
      out[i * 3 + 2] = view.getFloat32(at + 8, true);
      at += stride;
    }
    return out;
  }

  /**
   * The face list. Every face is a degree, that many vertex indices, and then
   * whatever its flag word says it carries — read for their length as much as
   * their meaning, since one wrong size reads the next face out of this one.
   */
  function readFaces(view, start, end, vertices) {
    if (end - start < 4) return { polygons: [], materials: [], groups: [], faces: 0 };
    const count = view.getUint32(start, true);
    const polygons = [];
    const materials = [];
    const groups = [];
    let at = start + 4;
    let faces = 0;
    for (let face = 0; face < count; face++) {
      if (at + 4 > end) break;
      const degree = view.getUint32(at, true);
      at += 4;
      if (degree < 3 || degree > 4096 || at + 4 * degree + 2 > end) {
        throw new Error(`a face of ${degree} corners`);
      }
      for (let k = 0; k < degree; k++) {
        const corner = view.getUint32(at + k * 4, true);
        if (corner >= vertices) throw new Error('a face names a vertex the mesh has not got');
        polygons.push(k === degree - 1 ? ~corner : corner);
      }
      at += 4 * degree;
      const flags = view.getUint16(at, true);
      at += 2;
      let material = 0;
      let smoothing = 0;
      if (flags & 0x01) {
        // The whole word is the smoothing groups, all thirty-two of them. The
        // groups say which faces share a smooth normal and, by their absence,
        // where an edge is hard — without them a mesh that stores no normals
        // of its own can only be shaded flat, and every crease on a car body
        // rounds away.
        smoothing = view.getUint32(at, true);
        at += 4;
      }
      if (flags & 0x08) {
        // The material id, in a field of its own, and absent where it is
        // zero. It is the slot a Multi/Sub-Object hands the face.
        //
        // Which field holds which was read off a car whose answer is known:
        // over its body, the 0x01 word takes sixteen values that are sparse
        // bit patterns up to bit 24, while the 0x08 field takes exactly 1 to
        // 15 — the slots of the sixteen-material list that body wears. Its
        // wheels, on a four-material list, use 1 to 3, and its tyres, which
        // wear a single material, carry no 0x08 field at all. Read the other
        // way round the body wore seven materials, two of them past the end
        // of its own list.
        material = view.getUint16(at, true);
        at += 2;
      }
      if (flags & 0x10) at += 4;
      if (flags & 0x20) at += 8 * (degree - 3);
      materials.push(material);
      groups.push(smoothing);
      faces += 1;
    }
    return { polygons, materials, groups, faces };
  }

  function readMapFaces(view, start, end) {
    const out = [];
    let at = start;
    while (at + 4 <= end) {
      const degree = view.getUint32(at, true);
      at += 4;
      if (degree < 3 || degree > 4096 || at + 4 * degree > end) break;
      for (let k = 0; k < degree; k++) out.push(view.getUint32(at + k * 4, true));
      at += 4 * degree;
    }
    return out;
  }

  /** An Editable Mesh face: three corners and two words about them. */
  function readTriangles(view, start, end, vertices) {
    if (end - start < 4) return [];
    const count = view.getUint32(start, true);
    if (count > Math.floor((end - start - 4) / 20)) {
      throw new Error(`a face array claims ${count} faces it has not got`);
    }
    const out = [];
    let at = start + 4;
    for (let i = 0; i < count; i++) {
      const a = view.getUint32(at, true);
      const b = view.getUint32(at + 4, true);
      const c = view.getUint32(at + 8, true);
      if (a >= vertices || b >= vertices || c >= vertices) {
        throw new Error('a face names a vertex the mesh has not got');
      }
      out.push([a, b, c]);
      at += 20;
    }
    return out;
  }

  /** A map channel's faces, three indices each and no more. */
  function readIndexTriples(view, start, end) {
    if (end - start < 4) return [];
    const count = view.getUint32(start, true);
    if (count > Math.floor((end - start - 4) / 12)) return [];
    const out = [];
    for (let i = 0; i < count * 3; i++) out.push(view.getUint32(start + 4 + i * 4, true));
    return out;
  }

  function readMesh(view, start, end) {
    let positions = null;
    let polygons = null;
    let materials = null;
    let groups = null;
    let faces = 0;
    let edges = 0;
    let pending = null;
    let uvs = null;
    let faceUvs = null;
    // Vertices first whatever the order in the file: a face is checked against
    // them, and an Editable Mesh writes its faces first.
    const found = [];
    chunks(view, start, end, (id, body, tail) => { found.push([id, body, tail]); return true; });
    found.sort((a, b) => (a[0] === VERTS || a[0] === TRI_VERTS ? 0 : 1)
      - (b[0] === VERTS || b[0] === TRI_VERTS ? 0 : 1));
    for (const [id, body, tail] of found) {
      if (id === VERTS && !positions) positions = readPoints(view, body, tail, 16);
      else if (id === EDGES && tail - body >= 4) edges = view.getUint32(body, true);
      else if (id === FACES && positions) {
        const read = readFaces(view, body, tail, positions.length / 3);
        polygons = read.polygons;
        materials = read.materials;
        groups = read.groups;
        faces = read.faces;
      } else if (id === MAP_VERTS) pending = readPoints(view, body, tail, 12);
      else if (id === MAP_FACES && !uvs && pending && pending.length) {
        uvs = pending;
        faceUvs = readMapFaces(view, body, tail);
        pending = null;
      } else if (id === TRI_VERTS && !positions) {
        positions = readPoints(view, body, tail, 12);
      } else if (id === TRI_FACES && positions) {
        const triangles = readTriangles(view, body, tail, positions.length / 3);
        polygons = [];
        materials = [];
        // An Editable Mesh keeps its smoothing groups elsewhere; none read.
        groups = [];
        for (const [a, b, c] of triangles) {
          polygons.push(a, b, ~c);
          materials.push(0);
          groups.push(0);
        }
        faces = triangles.length;
      } else if (id === TRI_MAP_VERTS) pending = readPoints(view, body, tail, 12);
      else if (id === TRI_MAP_FACES && !uvs && pending && pending.length) {
        uvs = pending;
        faceUvs = readIndexTriples(view, body, tail);
        pending = null;
      }
    }
    if (!positions || !polygons || !polygons.length) return null;
    if (!faceUvs || faceUvs.length !== polygons.length) { uvs = null; faceUvs = null; }
    return { positions, polygons, materials, groups, faces, edges, uvs, faceUvs };
  }

  /* ------------------------------------------------------------ materials */

  /**
   * What the scene calls a material.
   *
   * 3ds Max's own materials keep the name in the block every `MtlBase`
   * carries; a plugin's material writes the same block under an id of its own
   * — Corona's is 0x0FA0 — with the same name chunk inside it. Both are read,
   * since a Corona scene otherwise comes out as a list of numbered materials
   * and its V-Ray twin as a list of named ones.
   */
  function materialName(view, bytes, entity) {
    for (const wanted of MTL_BASES) {
      const block = findChunk(view, entity.start, entity.end, wanted);
      if (!block) continue;
      const found = findChunk(view, block[0], block[1], MTL_NAME);
      if (found) return text(view, bytes, found[0], found[1]);
    }
    return '';
  }

  /**
   * Every parameter of a parameter block, under the id the file gives it.
   *
   * A parameter is `uint16 id; uint16 type;` then flags and its value, and the
   * value is the last four bytes or, for a colour, the last twelve. What an id
   * *means* is the plugin's business — but the class table says which plugin,
   * and for the shaders 3ds Max itself ships the layout is published.
   *
   * How much flag sits between the two varies, so a scalar can be as little as
   * nineteen bytes. That is exactly what a Corona material writes, and every
   * number describing its surface — its glossiness above all — was below the
   * cutoff and thrown away. A slot for a map is smaller still and carries no
   * value at all, which its type is what says.
   */
  function paramsOf(view, entity) {
    const out = [];
    chunks(view, entity.start, entity.end, (id, body, tail) => {
      const size = tail - body;
      if (!PARAMS.includes(id) || size < 19) return true;
      const param = view.getUint16(body, true);
      const kind = view.getUint16(body + 2, true);
      if (kind === PARAM_TEXMAP) return true;
      if (size >= 27) {
        const rgb = [view.getFloat32(tail - 12, true), view.getFloat32(tail - 8, true),
          view.getFloat32(tail - 4, true)];
        if (rgb.every((v) => v >= 0 && v <= 1)) out.push({ id: param, colour: rgb });
      } else if (kind !== PARAM_INT && kind !== PARAM_BOOL) {
        // A count or a checkbox read as a float is not a small number, it is
        // a denormal or a NaN, so the types that are not float-valued are
        // left where they are. Glossiness is one of several that are — the
        // shaders declare it a percentage rather than a plain float.
        const value = view.getFloat32(tail - 4, true);
        if (Number.isFinite(value)) out.push({ id: param, value });
      }
      return true;
    });
    return out;
  }

  /**
   * Where each shader 3ds Max ships keeps the numbers that describe a surface.
   *
   * They agree on the front of the block — 0 ambient, 1 diffuse, 2 specular,
   * 3 the self-illumination colour — and part ways over the floats behind it,
   * so the class the file names is what picks the reading. Oren-Nayar-Blinn is
   * Blinn with a diffuse level and a roughness added on the end, which is why
   * the Blinn family reads at the same two places; Strauss is a shader of one
   * colour and keeps nothing where the others do.
   *
   * A plugin's own material that is not in this table is not read as though it
   * were: it keeps today's rule, that the first colour in the block is the
   * diffuse, and its finish is left to the Materials tab.
   *
   * Some plugins put a level beside each colour rather than folding it in, so
   * a channel can name one of its own: `diffuseLevel` and the rest multiply
   * the colour they belong to, and a channel whose level is zero is off
   * however bright its colour.
   */
  const SHADERS = new Map([
    ['blinn', { diffuse: 1, specular: 2, glossiness: 5, level: 6 }],
    ['phong', { diffuse: 1, specular: 2, glossiness: 5, level: 6 }],
    ['metal', { diffuse: 1, glossiness: 5, level: 6 }],
    ['oren-nayar-blinn', { diffuse: 1, specular: 2, glossiness: 5, level: 6 }],
    ['anisotropic', { diffuse: 1, specular: 2, glossiness: 7, level: 5 }],
    ['strauss', { diffuse: 0, glossiness: 1 }],
    /* A renderer's own material is not one of the shaders 3ds Max ships, so
     * none of the layouts above fits it and the surface used to come out as
     * whatever colour the walk met first — for a V-Ray glass, the black
     * diffuse that glass properly has, with nothing to say it was see-through.
     * What it refracts is the one thing worth having beyond the colours, since
     * nothing else in a .max carries an opacity at all.
     *
     * The ids are read off the files rather than out of any documentation:
     * fifty-five VRayMtl blocks across three car scenes all carry the same
     * eight colours under the same ids, and the three that refract in one car
     * share a fog colour of (0.90, 0.96, 0.95) — the green a windscreen is. */
    /* Parameter 3 is the reflection glossiness, which is how polished the
     * surface is and the difference between chrome and a matte panel. Read
     * off the same car twice: 3ds Max's own FBX export of this scene states a
     * glossiness for each of its seventy materials, and for every one of them
     * parameter 3 of the .max holds that number. */
    ['vraymtl', { diffuse: 1, specular: 2, refraction: 5, glossiness: 3 }],
    /* Corona keeps its surface in one block, every channel a colour with a
     * level beside it, and its glossiness at 180 where nothing else is near.
     *
     * These ids were checked against the answer rather than guessed at: five
     * of these cars ship a Corona scene and a V-Ray scene of the same model,
     * with the same material names in both. Read this way, 174 of the 176
     * materials that appear in both come out with the same diffuse, specular,
     * glossiness and opacity as the V-Ray twin the tool already read — and the
     * two that differ are a windscreen and a body the artist tuned separately
     * for each renderer, which the rest of their own numbers agree about.
     *
     * Corona renamed the material when the newer one arrived; the block did
     * not change, so a scene saved by either reads the same. */
    ['coronamtl', {
      diffuse: 101, diffuseLevel: 121,
      specular: 102, specularLevel: 122,
      refraction: 103, refractionLevel: 123,
      glossiness: 180,
    }],
  ]);
  SHADERS.set('coronalegacymtl', SHADERS.get('coronamtl'));

  /** A shader's own name for itself, or nothing when the plugin is its own. */
  const shaderLayout = (name) => SHADERS.get(String(name || '').trim().toLowerCase()) || null;

  /**
   * What a block of parameters says the surface is, read by a shader's layout.
   *
   * Each value comes from the id that holds it, and nothing is returned for a
   * block that has no diffuse where the layout says one is — that block
   * belongs to something else the material keeps, not to its surface.
   */
  function appearanceOf(params, layout, diffuse = null) {
    const at = (which, key) => {
      // `diffuse` stands in for the colour the block itself holds, for a
      // material whose diffuse slot is filled by a colour rather than a
      // picture: the one beside it is then a placeholder. It goes in before
      // the level is applied, since a diffuse switched off is switched off
      // whichever colour it was given.
      if (which === 'diffuse' && key === 'colour' && diffuse) return diffuse;
      if (layout[which] === undefined) return null;
      const found = params.find((p) => p.id === layout[which] && p[key] !== undefined);
      return found ? found[key] : null;
    };
    /** A colour, dimmed by the level its shader keeps beside it. */
    const scaled = (which) => {
      const colour = at(which, 'colour');
      if (!colour) return null;
      const stated = at(`${which}Level`, 'value');
      if (stated === null || stated === 1) return colour;
      const level = Math.min(1, Math.max(0, stated));
      return colour.map((c) => c * level);
    };

    const colour = scaled('diffuse');
    if (!colour) return null;
    // What a material refracts is what it lets through, so it is the opposite
    // of its opacity. Taken from the brightest channel: a tinted refraction is
    // still a measure of how much gets past.
    const refraction = scaled('refraction');
    return {
      colour,
      specular: scaled('specular'),
      glossiness: at('glossiness', 'value'),
      level: at('level', 'value'),
      opacity: refraction === null
        ? null : 1 - Math.min(1, Math.max(0, Math.max(...refraction))),
    };
  }

  /** The file a parameter block points at, by the identifier they share. */
  function assetOf(view, bytes, entity, assets) {
    let found = null;
    chunks(view, entity.start, entity.end, (id, body, tail) => {
      if (id !== ASSET_REF || tail - body < 16) return true;
      for (let at = body; at + 16 <= tail; at++) {
        const key = Array.from(bytes.subarray(at, at + 16)).join(',');
        if (assets.has(key)) { found = assets.get(key); return false; }
      }
      return true;
    });
    return found;
  }

  /* A CoronaColor is a map that is nothing but a colour, and parameter 52 is
   * that colour. Read off a BMW: its tyres come to (0.02, 0.02, 0.02), the
   * black of rubber, and its `red` to (0.114, 0, 0). */
  const CORONA_COLOUR_MAP = 'coronacolor';
  const CORONA_COLOUR = 52;

  /**
   * A colour standing where a picture would, at or below one slot.
   *
   * A map slot does not have to hold a picture. Corona fills one with a
   * CoronaColor — a map that is a flat colour — and where a slot is filled at
   * all the material's own colour beside it is a placeholder that means
   * nothing: white for a tyre, mid grey for a red light. Left unread, that
   * placeholder is what gets painted.
   */
  function colourUnder(view, entities, index, depth = 0, seen = new Set()) {
    if (index === undefined || index >= entities.length || seen.has(index) || depth > 4) {
      return null;
    }
    seen.add(index);
    const entity = entities[index];
    if (depth && (entity.cls.superId || 0) === MTL_CLASS) return null;
    if (String(entity.cls.name || '').trim().toLowerCase() === CORONA_COLOUR_MAP) {
      for (const ref of [index, ...entity.refs]) {
        if (ref >= entities.length) continue;
        for (const p of paramsOf(view, entities[ref])) {
          if (p.id === CORONA_COLOUR && p.colour !== undefined) return p.colour;
        }
      }
    }
    for (const ref of entity.refs) {
      const found = colourUnder(view, entities, ref, depth + 1, seen);
      if (found) return found;
    }
    return null;
  }

  /**
   * The first file named at or below one entity, and no further.
   *
   * A map is rarely a bitmap directly — a Color Correction or an Output sits
   * between the slot and the picture — so the slot is followed down. The walk
   * stops at a material, which is somebody else's business.
   */
  function assetUnder(view, bytes, entities, index, assets, depth = 0, seen = new Set()) {
    if (index === undefined || index >= entities.length || seen.has(index) || depth > 5) {
      return null;
    }
    seen.add(index);
    const entity = entities[index];
    if (depth && (entity.cls.superId || 0) === MTL_CLASS) return null;
    const found = assetOf(view, bytes, entity, assets);
    if (found) return found;
    for (const ref of entity.refs) {
      const under = assetUnder(view, bytes, entities, ref, assets, depth + 1, seen);
      if (under) return under;
    }
    return null;
  }

  /**
   * Which keyed reference holds which map, for the plugin materials whose
   * numbering has been read off the files.
   *
   * Without this the rule is the older one — the first picture anywhere below
   * the material — and for a renderer's own material that is usually the wrong
   * one, because most of them carry several maps and the diffuse is rarely the
   * first. Read that way an Audi comes out with a red roof, because the mask
   * cut into its sunroof is the first picture its material names.
   *
   * The two renderers keep the keys in different places, which `on` says. A
   * VRayMtl keys them on itself, behind its six parameter blocks: 7 is the
   * diffuse (a suede's colour, a blinker's lens), 8 the reflection (a Falloff,
   * which is what a V-Ray glass reflects by) and 10 the bump — a Noise, a
   * tyre's tread, a file called `suade_bump.png`.
   *
   * A CoronaMtl keys them on its parameter block instead, and numbers them
   * from zero in the order the block declares its map slots — 141 upwards,
   * which is Corona's colour ids with forty added. Across one car's sixty-one:
   * 0 held every `_color` file, 1 every `_refl`, 3 the glass and the masks cut
   * into it, 6 all thirteen normal maps and every `CoronaNormal`, and 8 and 9
   * the two `_aniso`. Nothing else in the file says which is which — the slot
   * parameters themselves are written byte for byte identical whether they are
   * filled or not.
   */
  /**
   * The materials that are a *list* rather than a surface.
   *
   * A Multi/Sub-Object is nothing but a numbered list, and a face's material
   * id picks a slot out of it. Everything else that names other materials — a
   * Blend, a VRayBlendMtl, a Shellac — is a surface of its own, made by mixing
   * them, and a face wearing it wears one thing and not a choice of several.
   *
   * Treating the second as the first is how an Audi came out with a red roof:
   * of the forty-four slots its body wears, three held a Blend, each of those
   * was taken for a list and so written as no material at all, and every slot
   * behind them shifted down to fill the gap.
   */
  const LIST_MATERIALS = new Set(['multi/sub-object', 'multimaterial']);

  const MAP_SLOTS = {
    vraymtl: { on: 'self', diffuse: 7, bump: 10 },
    coronamtl: { on: 'block', diffuse: 0, bump: 6 },
  };
  // Corona renamed its material when the newer one arrived; the block did not
  // change, and a scene saved by either keys its maps the same way.
  MAP_SLOTS.coronalegacymtl = MAP_SLOTS.coronamtl;

  /**
   * Where a material's maps hang, which is not the same for every renderer.
   *
   * V-Ray keys them on the material; Corona keys them on the parameter block
   * the material holds, so the block is what is asked.
   */
  function keyedMaps(entities, entity, where) {
    if (where !== 'block') return entity.typed;
    for (const ref of entity.refs) {
      if (ref >= entities.length) continue;
      if (/^parambloc/i.test(String(entities[ref].cls.name || ''))) return entities[ref].typed;
    }
    return {};
  }

  /**
   * A material, and whatever its references say it is made of. The walk stops
   * at another material, which is where a Multi/Sub-Object's own sub-materials
   * begin. Where the class is one whose reference order is known, the picture
   * is taken from the slot that holds the diffuse rather than from whichever
   * comes first.
   *
   * A parameter block says nothing about itself, so what is carried down the
   * walk is the class that holds it: a Standard material refers to its shader,
   * the shader to the block, and it is the shader — Blinn, Phong, Anisotropic
   * — that says what the numbers in that block are.
   */
  function readMaterial(view, bytes, entities, index, assets) {
    if (index >= entities.length) return null;
    const entity = entities[index];
    let look = null;
    let plain = null;                 // the first colour anywhere, as a fallback
    let texture = null;
    const subs = [];
    let bump = null;
    let painted = null;             // a colour the diffuse slot holds outright
    const slots = MAP_SLOTS[String(entity.cls.name || '').trim().toLowerCase()];
    if (slots) {
      // The slots decide it, including when one is empty: a material with a
      // bump and no diffuse map wears no picture and is bumped all the same.
      const keyed = keyedMaps(entities, entity, slots.on);
      const diffuse = keyed[slots.diffuse];
      texture = assetUnder(view, bytes, entities, diffuse, assets);
      bump = assetUnder(view, bytes, entities, keyed[slots.bump], assets);
      if (!texture) painted = colourUnder(view, entities, diffuse);
    }
    const queue = entity.refs.map((at) => [at, entity.cls.name]);
    const walked = new Set();
    while (queue.length && walked.size < 64) {
      const [at, owner] = queue.shift();
      if (walked.has(at) || at >= entities.length) continue;
      walked.add(at);
      const part = entities[at];
      if ((part.cls.superId || 0) === MTL_CLASS) { subs.push(at); continue; }
      // A block belongs to whatever holds it, however many blocks deep.
      const name = String(part.cls.name || '');
      const holder = /^parambloc/i.test(name) ? owner : name;
      const params = paramsOf(view, part);
      const layout = shaderLayout(holder);
      // A shader's block wins wherever the walk finds it: a Standard material
      // keeps three more blocks of its own, and one of them holds a filter
      // colour that would otherwise pass for the colour of the surface.
      if (layout && !look) look = appearanceOf(params, layout, painted);
      if (!plain) {
        const first = params.find((p) => p.colour !== undefined);
        if (first) plain = first.colour;
      }
      if (!texture && !slots) texture = assetOf(view, bytes, part, assets);
      for (const ref of part.refs) queue.push([ref, holder]);
    }
    // A plugin's material lays its block out as it pleases, so all that can be
    // said of one is that the first colour in it is the diffuse.
    if (!look) {
      look = { colour: plain, specular: null, glossiness: null, level: null, opacity: null };
    }
    // Where no shader layout claimed the block, the slot's colour is still
    // better than the placeholder beside it.
    if (painted && !look.colour) look = { ...look, colour: painted };
    const kind = String(entity.cls.name || '').trim().toLowerCase();
    return {
      name: materialName(view, bytes, entity),
      look,
      texture,
      bump,
      // The materials this one names. For a Multi/Sub-Object they are its
      // slots, and a face picks between them; for anything else — a Blend, a
      // VRayBlendMtl — they are what this surface is made of, and it is a
      // surface in its own right.
      subs,
      isList: LIST_MATERIALS.has(kind),
    };
  }

  /* ---------------------------------------------------------------- scene */

  /* What a Symmetry modifier's parameter block holds, by the id of each.
   *
   * Read off a Ferrari whose forty-two symmetric parts all agree: 0 is an int
   * naming the axis, 1 and 2 are the slice and weld switches — on for every
   * one of them — 3 is the weld threshold, and 4 is the flip, set on exactly
   * one part in the car. */
  const SYM_AXIS = 0;
  const SYM_THRESHOLD = 3;

  /**
   * Which way a Symmetry modifier mirrors, and how near the seam welds.
   *
   * The whole and half of it: the ints and the bool have to be read straight
   * out of the block, since the reader that serves the shaders throws away
   * every parameter that is not float-valued.
   */
  function symmetryOf(view, entities, index) {
    let axis = null;
    let threshold = 0;
    for (const ref of [index, ...entities[index].refs]) {
      if (ref >= entities.length) continue;
      chunks(view, entities[ref].start, entities[ref].end, (id, body, tail) => {
        if (!PARAMS.includes(id) || tail - body < 8) return true;
        const param = view.getUint16(body, true);
        const kind = view.getUint16(body + 2, true);
        if (param === SYM_AXIS && kind === PARAM_INT) {
          axis = view.getInt32(tail - 4, true);
        } else if (param === SYM_THRESHOLD
          && kind !== PARAM_INT && kind !== PARAM_BOOL && kind !== PARAM_TEXMAP) {
          threshold = view.getFloat32(tail - 4, true);
        }
        return true;
      });
    }
    if (axis === null || axis < 0 || axis > 2) return null;
    return { axis, threshold: Math.max(0, threshold) };
  }

  /**
   * The mesh with its own mirror image joined to it.
   *
   * Which is what a Symmetry modifier is for, and half of what the artist
   * modelled is what a reader that skips it comes away with — a car whose
   * every mirrored panel is missing down one side.
   *
   * A vertex within the threshold of the plane is *on* it: the two halves
   * share it rather than each keeping their own, which is the weld, and it is
   * snapped exactly onto the plane so the seam closes. Everything else is
   * copied across. A mirror reverses which way round a face is wound, so the
   * copies are wound backwards to keep facing outwards, and a face whose every
   * corner sits on the seam is not copied at all — it would be the same face
   * twice.
   */
  function mirrored(mesh, axis, plane, threshold) {
    const count = mesh.positions.length / 3;
    const positions = Array.from(mesh.positions);
    const twin = new Int32Array(count);
    for (let i = 0; i < count; i++) {
      const at = i * 3 + axis;
      if (Math.abs(positions[at] - plane) <= threshold) {
        positions[at] = plane;
        twin[i] = i;
      } else {
        twin[i] = positions.length / 3;
        positions.push(mesh.positions[i * 3], mesh.positions[i * 3 + 1],
          mesh.positions[i * 3 + 2]);
        positions[positions.length - 3 + axis] = 2 * plane - mesh.positions[at];
      }
    }

    const out = {
      positions,
      polygons: Array.from(mesh.polygons),
      uvs: mesh.uvs ? Array.from(mesh.uvs) : mesh.uvs,
      faceUvs: mesh.faceUvs ? Array.from(mesh.faceUvs) : mesh.faceUvs,
      materials: mesh.materials ? Array.from(mesh.materials) : mesh.materials,
      groups: mesh.groups ? Array.from(mesh.groups) : mesh.groups,
      faces: mesh.faces,
      edges: mesh.edges,
    };

    let face = 0;
    let start = 0;
    for (let at = 0; at < mesh.polygons.length; at++) {
      const index = mesh.polygons[at];
      if (index >= 0) continue;
      const corners = mesh.polygons.slice(start, at).concat([~index]);
      const copy = corners.map((c) => twin[c]);
      if (copy.some((c, i) => c !== corners[i])) {
        const back = copy.slice().reverse();
        for (let k = 0; k < back.length - 1; k++) out.polygons.push(back[k]);
        out.polygons.push(~back[back.length - 1]);
        if (mesh.faceUvs && mesh.faceUvs.length) {
          const slice = Array.from(mesh.faceUvs.slice(start, at + 1)).reverse();
          for (const u of slice) out.faceUvs.push(u);
        }
        if (mesh.materials && mesh.materials.length) out.materials.push(mesh.materials[face]);
        if (mesh.groups && mesh.groups.length) out.groups.push(mesh.groups[face]);
        out.faces += 1;
      }
      face += 1;
      start = at + 1;
    }
    if (out.faceUvs && out.faceUvs.length !== out.polygons.length) {
      out.uvs = [];
      out.faceUvs = [];
    }
    return out;
  }

  /**
   * How many rounds a subdividing modifier asks for. Its first parameter is
   * the iteration count, which is the one thing about it worth knowing here:
   * the mesh under it is the cage, and this is how many times the cage was
   * meant to be divided.
   */
  function smoothingOf(view, entities, index) {
    let out = 0;
    for (const ref of entities[index].refs.slice(0, 2)) {
      if (ref >= entities.length) continue;
      chunks(view, entities[ref].start, entities[ref].end, (id, body, tail) => {
        if (!PARAMS.includes(id) || tail - body > 27) return true;
        const param = view.getUint16(body, true);
        const kind = view.getUint16(body + 2, true);
        if (param === 0 && kind === 1) {
          out = Math.max(0, Math.min(8, view.getInt32(tail - 4, true)));
          return false;
        }
        return true;
      });
    }
    return out;
  }

  function readEntities(view, length, classes) {
    const out = [];
    let outer = null;
    chunks(view, 0, length, (id, body, tail) => { outer = [body, tail]; return false; });
    if (!outer) return out;
    chunks(view, outer[0], outer[1], (id, body, tail) => {
      const cls = classes[id] || { name: `class ${id}`, superId: 0, classId: 0 };
      const entity = { index: out.length, cls, start: body, end: tail, refs: [], typed: {} };
      chunks(view, body, tail, (cid, cb, ct) => {
        if (cid === REFS) {
          for (let at = cb; at + 4 <= ct; at += 4) entity.refs.push(view.getUint32(at, true));
        } else if (cid === TYPED_REFS && ct - cb >= 4) {
          entity.refs = [];
          for (let at = cb + 4; at + 8 <= ct; at += 8) {
            const key = view.getUint32(at, true);
            const target = view.getUint32(at + 4, true);
            entity.typed[key] = target;
            entity.refs.push(target);
          }
        }
        return true;
      });
      out.push(entity);
      return true;
    });
    return out;
  }

  /**
   * Find a chunk anywhere below a range, not only among its own children:
   * a controller wraps its value in a block of its own.
   */
  function deepFind(view, start, end, wanted, depth = 0) {
    let out = null;
    chunks(view, start, end, (id, body, tail, container) => {
      if (id === wanted) { out = [body, tail]; return false; }
      if (container && depth < 4) {
        const found = deepFind(view, body, tail, wanted, depth + 1);
        if (found) { out = found; return false; }
      }
      return true;
    });
    return out;
  }

  function floatOf(view, entity) {
    const found = deepFind(view, entity.start, entity.end, FLOAT);
    return found && found[1] - found[0] >= 4 ? view.getFloat32(found[0], true) : null;
  }

  /**
   * What a controller says, however it chooses to say it. A Position XYZ or
   * an Euler XYZ keeps nothing itself: it refers to three float controllers,
   * one per axis, and each of those wraps a single value.
   */
  function controllerValue(view, entities, entity, wanted, fallback) {
    const found = deepFind(view, entity.start, entity.end, wanted);
    if (found && found[1] - found[0] >= 12) {
      return [view.getFloat32(found[0], true), view.getFloat32(found[0] + 4, true),
        view.getFloat32(found[0] + 8, true)];
    }
    const axes = entity.refs.slice(0, 3)
      .filter((r) => r < entities.length).map((r) => entities[r]);
    if (axes.length === 3) {
      const values = axes.map((axis) => floatOf(view, axis));
      if (values.every((v) => v !== null)) return values;
    }
    return fallback;
  }

  /** A quaternion as the XYZ Euler angles an FBX record wants, in radians. */
  function eulerFromQuaternion(x, y, z, w) {
    const sinr = 2 * (w * x + y * z);
    const cosr = 1 - 2 * (x * x + y * y);
    const sinp = 2 * (w * y - z * x);
    const siny = 2 * (w * z + x * y);
    const cosy = 1 - 2 * (y * y + z * z);
    return [
      Math.atan2(sinr, cosr),
      Math.abs(sinp) >= 1 ? Math.sign(sinp) * Math.PI / 2 : Math.asin(sinp),
      Math.atan2(siny, cosy),
    ];
  }

  /**
   * Where a node holds its mesh, which need not be where the node is.
   *
   * 3ds Max keeps this apart from the node's own transform — it is the offset
   * an FBX writes as the geometric transform, the one a child does not
   * inherit — and a part that carries one is somewhere else entirely without
   * it.
   */
  function objectOffset(view, nodeEntity) {
    const out = { translation: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };
    const position = findChunk(view, nodeEntity.start, nodeEntity.end, OFFSET_POS);
    if (position && position[1] - position[0] >= 12) {
      out.translation = [0, 4, 8].map((at) => view.getFloat32(position[0] + at, true));
    }
    const rotation = findChunk(view, nodeEntity.start, nodeEntity.end, OFFSET_ROT);
    if (rotation && rotation[1] - rotation[0] >= 16) {
      const q = [0, 4, 8, 12].map((at) => view.getFloat32(rotation[0] + at, true));
      out.rotation = eulerFromQuaternion(q[0], q[1], q[2], q[3]);
    }
    const scale = findChunk(view, nodeEntity.start, nodeEntity.end, OFFSET_SCALE);
    if (scale && scale[1] - scale[0] >= 12) {
      out.scale = [0, 4, 8].map((at) => view.getFloat32(scale[0] + at, true));
    }
    return out;
  }

  /**
   * The entity a node hangs off, or nothing where it hangs off the scene.
   *
   * A child's controller says where it stands *relative to its parent*, so a
   * scene read without this puts every part at the origin of the world
   * instead: a car whose wheels are linked to its body comes out with the
   * wheels somewhere below it and the body in the air. The scene's own root is
   * a node like any other and is not among the parts, so naming it comes to
   * the same thing as naming nothing.
   */
  function nodeParent(view, nodeEntity) {
    const found = findChunk(view, nodeEntity.start, nodeEntity.end, PARENT);
    if (!found || found[1] - found[0] < 4) return -1;
    return view.getUint32(found[0], true);
  }

  function nodeTransform(view, entities, nodeEntity) {
    const out = { translation: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };
    const at = nodeEntity.typed[0];
    if (at === undefined || at >= entities.length) return out;
    for (const index of entities[at].refs) {
      if (index >= entities.length) continue;
      const part = entities[index];
      const name = (part.cls.name || '').toLowerCase();
      if (name.includes('position')) {
        out.translation = controllerValue(view, entities, part, POINT3, out.translation);
      } else if (name.includes('euler') || name.includes('rotation')) {
        out.rotation = controllerValue(view, entities, part, POINT3, out.rotation);
      } else if (name.includes('scale')) {
        out.scale = controllerValue(view, entities, part, SCALE, out.scale);
      }
    }
    return out;
  }

  /* ---------------------------------------------------------------- parse */

  function parse(bytes) {
    const warnings = [];
    const compound = new Compound(bytes);
    const scene = compound.stream('Scene');
    if (!scene.length) throw new Error('no Scene stream — this is not a 3ds Max scene');
    const view = new DataView(scene.buffer, scene.byteOffset, scene.byteLength);

    const classDirectory = compound.stream('ClassDirectory3').length
      ? compound.stream('ClassDirectory3') : compound.stream('ClassDirectory');
    const classes = readClasses(classDirectory);
    const dlls = readDlls(compound.stream('DllDirectory'));
    const assetTable = compound.stream('FileAssetMetaData3').length
      ? compound.stream('FileAssetMetaData3') : compound.stream('FileAssetMetaData2');
    const assets = readAssets(assetTable);
    const build = readVersion(compound.stream('Config'), compound.stream('SaveConfigData'));
    const entities = readEntities(view, scene.length, classes);

    const meshes = new Map();
    const undecoded = new Map();
    for (const entity of entities) {
      if ((entity.cls.superId || 0) !== 0x10) continue;
      const block = findChunk(view, entity.start, entity.end, MESH);
      if (!block) {
        const name = entity.cls.name || 'object';
        undecoded.set(name, (undecoded.get(name) || 0) + 1);
        continue;
      }
      try {
        const mesh = readMesh(view, block[0], block[1]);
        if (mesh) meshes.set(entity.index, mesh);
      } catch (error) {
        warnings.push(`${entity.cls.name} at entity ${entity.index}: ${error.message}`);
      }
    }

    // A parameter block names a file by the identifier the asset table gives
    // it, which is what ties a material to the picture it wears.
    const byId = new Map(assets.filter((a) => a.id).map((a) => [a.id, a.name]));

    const nodes = entities.filter((e) => (e.cls.name || '') === 'Node');
    const placed = [];
    const materials = new Map();
    // How many parts were modelled with a subdividing modifier, and the most
    // rounds any of them asks for.
    let smoothedParts = 0;
    let mirroredParts = 0;
    let smoothedRounds = 0;
    for (const nodeEntity of nodes) {
      const found = findChunk(view, nodeEntity.start, nodeEntity.end, NAME);
      const name = found ? text(view, scene, found[0], found[1]) : '';
      const target = nodeEntity.typed[1];
      let mesh = target === undefined ? null : meshes.get(target);
      let smoothing = 0;
      let symmetry = null;
      if (!mesh && target !== undefined) {
        // A modifier sits between the node and its mesh; the base object is
        // what it was built from, so follow the references down to it.
        const seen = new Set();
        const queue = [target];
        while (queue.length && !mesh) {
          const at = queue.shift();
          if (seen.has(at) || at >= entities.length) continue;
          seen.add(at);
          const modifier = (entities[at].cls.name || '').toLowerCase();
          if (modifier.includes('smooth')) {
            smoothing = Math.max(smoothing, smoothingOf(view, entities, at));
          } else if (modifier === 'symmetry' && !symmetry) {
            symmetry = symmetryOf(view, entities, at);
          }
          mesh = meshes.get(at);
          if (!mesh) queue.push(...entities[at].refs);
        }
      }
      const offset = objectOffset(view, nodeEntity);
      if (mesh && symmetry) {
        // A modifier works about the object's pivot, and the mesh is stored an
        // object offset away from it — so the plane the artist mirrored across
        // sits at minus that offset in the mesh's own coordinates. Checked
        // against 3ds Max's own export of the same car: for all forty-two of
        // its symmetric parts, that is the plane that gives back the width the
        // export has.
        mesh = mirrored(mesh, symmetry.axis, -offset.translation[symmetry.axis],
          symmetry.threshold);
        mirroredParts += 1;
      }
      if (smoothing) {
        smoothedParts += 1;
        smoothedRounds = Math.max(smoothedRounds, smoothing);
      }
      const wearing = nodeEntity.typed[3];
      // Every material below this one, however deep: a slot of a
      // Multi/Sub-Object is often a Blend, and what that Blend is made of is a
      // level further down again.
      const pending = wearing === undefined ? [] : [wearing];
      while (pending.length) {
        const at = pending.shift();
        if (at === undefined || materials.has(at)) continue;
        const found = readMaterial(view, scene, entities, at, byId);
        if (!found) continue;
        materials.set(at, found);
        for (const sub of found.subs) if (!materials.has(sub)) pending.push(sub);
      }
      // Every node, and not only the ones that draw something. A Dummy has no
      // geometry, and left out it has no record for its children to hang from
      // — so a Ferrari whose wheels are grouped under one comes out with all
      // four of them stacked at the origin, inside the car.
      placed.push({
        name,
        mesh,
        wearing,
        index: nodeEntity.index,
        parent: nodeParent(view, nodeEntity),
        placement: nodeTransform(view, entities, nodeEntity),
        offset,
      });
    }

    const root = node('', [], []);
    root.children.push(node('FBXHeaderExtension', [], [
      node('Creator', [S('Autodesk 3ds Max')]),
    ]));

    const objects = [];
    const connections = [];
    let uid = 1000;
    let vertices = 0;

    // One record per material, written before the parts that wear them.
    const materialUids = new Map();
    const textureUids = new Map();
    /* Give a surface made of other materials the look of its base coat.
     *
     * A Blend is not a surface anybody described — it is two or three that
     * are, with a mask saying where each shows. What its own blocks hold is
     * that mask, so a reader that takes the first picture below it paints a
     * tyre with the map that mixes its dirt in. What it looks like is its
     * first ingredient: the base coat, with the rest laid over. */
    const resolved = new Set();
    const resolveBlend = (index, chain = new Set()) => {
      const material = materials.get(index);
      if (!material || resolved.has(index) || chain.has(index)
        || material.isList || !material.subs.length) return material;
      const base = resolveBlend(material.subs[0], new Set([...chain, index]));
      resolved.add(index);
      if (!base) return material;
      material.look = base.look;
      material.texture = base.texture;
      material.bump = base.bump;
      return material;
    };
    for (const index of [...materials.keys()]) resolveBlend(index);

    // A slot must keep its number, so anything a list names gets a record even
    // where it is a list itself: leave one out and every slot behind it moves
    // up, and the whole car is painted out of the wrong tins.
    const inASlot = new Set();
    for (const material of materials.values()) {
      if (material.isList) for (const sub of material.subs) inASlot.add(sub);
    }
    for (const index of [...materials.keys()].sort((a, b) => a - b)) {
      const material = materials.get(index);
      // A list is a list of slots, not a surface.
      if (material.isList && !inASlot.has(index)) continue;
      uid += 1;
      materialUids.set(index, uid);
      const look = material.look;
      const props = [p70('DiffuseColor', 'Color',
        ...(look.colour || [0.6, 0.6, 0.6]).map(D))];
      if (look.specular) props.push(p70('SpecularColor', 'Color', ...look.specular.map(D)));
      // Specular level is a percentage in the file and a factor here.
      if (look.level !== null) props.push(p70('SpecularFactor', 'Number', D(look.level)));
      // Glossiness is 0 to 1 and the exponent an FBX material carries is two
      // to the ten times it, which is the conversion 3ds Max's own exporter
      // makes: read off its export of this same scene, where every one of
      // seventy materials lands on 2**(10 * glossiness) to four decimals —
      // 0.3 becomes 8, 0.65 becomes 90.51, 1.0 becomes 1024. A percentage
      // instead put a mirror and a matte panel within a few of each other,
      // and the whole car came out equally satin.
      if (look.glossiness !== null) {
        props.push(p70('ShininessExponent', 'Number',
          D(2 ** (10 * Math.min(1, Math.max(0, look.glossiness))))));
      }
      // Only where the material says so: a .max carries no opacity otherwise,
      // and writing 1 for every material would say something the file does not.
      if (look.opacity !== null && look.opacity !== undefined && look.opacity < 1) {
        props.push(p70('Opacity', 'Number', D(look.opacity)));
      }
      objects.push(node('Material',
        [L(uid), S(`${material.name || `material${index}`}${CLASS_SEP}Material`), S('')], [
          node('Version', [I(102)]),
          node('ShadingModel', [S('phong')]),
          node('Properties70', [], props),
        ]));

      // Each picture the material names, under the property it drives. The
      // same file in two slots — which happens, a bump doubling as a
      // displacement — is one Texture record bound twice.
      for (const [filename, drives] of [[material.texture, 'DiffuseColor'],
        [material.bump, 'Bump']]) {
        if (!filename) continue;
        if (!textureUids.has(filename)) {
          uid += 2;
          textureUids.set(filename, uid - 1);
          objects.push(node('Texture',
            [L(uid - 1), S(`${filename}${CLASS_SEP}Texture`), S('')], [
              node('Type', [S('TextureVideoClip')]),
              node('Version', [I(202)]),
              node('FileName', [S(filename)]),
              node('RelativeFilename', [S(filename)]),
            ]));
          objects.push(node('Video',
            [L(uid), S(`${filename}${CLASS_SEP}Video`), S('Clip')], [
              node('Type', [S('Clip')]),
              node('FileName', [S(filename)]),
              node('RelativeFilename', [S(filename)]),
            ]));
          connections.push(node('C', [S('OO'), L(uid), L(uid - 1)]));
        }
        connections.push(node('C', [S('OP'), L(textureUids.get(filename)),
          L(materialUids.get(index)), S(drives)]));
      }
    }
    // Every part is numbered before any is written, so a child can name the
    // parent that places it whichever of the two the scene lists first.
    const modelUids = new Map(placed.map((entry, at) => [entry.index, uid + 2 * at + 2]));

    placed.forEach((entry, index) => {
      // Two uids apiece whether or not there is geometry, so that the numbers
      // a child was promised above are the numbers it gets.
      const geometryUid = ++uid;
      const modelUid = ++uid;
      const label = entry.name || `object${index + 1}`;
      if (entry.mesh) vertices += entry.mesh.positions.length / 3;
      const children = entry.mesh ? [
        node('Vertices', [array('d', entry.mesh.positions)]),
        node('PolygonVertexIndex', [array('i', entry.mesh.polygons)]),
        node('GeometryVersion', [I(124)]),
      ] : [];
      if (entry.mesh && entry.mesh.uvs && entry.mesh.faceUvs) {
        children.push(node('LayerElementUV', [I(0)], [
          node('Version', [I(101)]),
          node('Name', [S('map1')]),
          node('MappingInformationType', [S('ByPolygonVertex')]),
          node('ReferenceInformationType', [S('IndexToDirect')]),
          node('UV', [array('d', entry.mesh.uvs)]),
          node('UVIndex', [array('i', entry.mesh.faceUvs)]),
        ]));
      }
      // Which materials this part wears: the one its node names, or the list a
      // Multi/Sub-Object holds, which is what a face's material id picks from.
      const worn = entry.wearing === undefined ? null : materials.get(entry.wearing);
      let slots = [];
      if (worn && worn.isList) {
        // Positionally, and with nothing left out: the numbers are what a
        // face's material id picks by.
        slots = worn.subs.filter((sub) => materialUids.has(sub))
          .map((sub) => materialUids.get(sub));
      } else if (materialUids.has(entry.wearing)) {
        slots = [materialUids.get(entry.wearing)];
      }
      if (!entry.mesh) slots = [];
      else if (slots.length > 1 && entry.mesh.materials) {
        children.push(node('LayerElementMaterial', [I(0)], [
          node('Version', [I(101)]),
          node('MappingInformationType', [S('ByPolygon')]),
          node('ReferenceInformationType', [S('IndexToDirect')]),
          node('Materials', [array('i', entry.mesh.materials.map((m) => m % slots.length))]),
        ]));
      } else if (slots.length) {
        children.push(node('LayerElementMaterial', [I(0)], [
          node('Version', [I(101)]),
          node('MappingInformationType', [S('AllSame')]),
          node('ReferenceInformationType', [S('IndexToDirect')]),
          node('Materials', [array('i', [0])]),
        ]));
      }
      // Which faces share a smooth normal, and so where an edge is hard. A
      // .max stores no normals — only the cage — so without this the mesh can
      // only be shaded flat, and every crease on a car body rounds away.
      if (entry.mesh && entry.mesh.groups && entry.mesh.groups.some((g) => g)) {
        children.push(node('LayerElementSmoothing', [I(0)], [
          node('Version', [I(102)]),
          node('MappingInformationType', [S('ByPolygon')]),
          node('ReferenceInformationType', [S('Direct')]),
          node('Smoothing', [array('i', entry.mesh.groups)]),
        ]));
      }
      if (entry.mesh) {
        children.push(node('Layer', [I(0)], [node('Version', [I(100)])]));
        objects.push(node('Geometry',
          [L(geometryUid), S(`${label}${CLASS_SEP}Geometry`), S('Mesh')], children));
      }

      // Only what the node actually says: most scenes of this kind leave
      // every node at the origin with the geometry already in world space,
      // and three records apiece saying so would be 164 of nothing.
      const { translation, rotation, scale } = entry.placement;
      const placementProps = [];
      if (translation.some((v) => v)) {
        placementProps.push(p70('Lcl Translation', 'Lcl Translation', ...translation.map(D)));
      }
      if (rotation.some((v) => v)) {
        placementProps.push(p70('Lcl Rotation', 'Lcl Rotation',
          ...rotation.map((v) => D(v * 57.29577951308232))));
      }
      if (scale.some((v) => v !== 1)) {
        placementProps.push(p70('Lcl Scaling', 'Lcl Scaling', ...scale.map(D)));
      }
      const offset = entry.offset;
      if (offset.translation.some((v) => v)) {
        placementProps.push(p70('GeometricTranslation', 'Vector3D',
          ...offset.translation.map(D)));
      }
      if (offset.rotation.some((v) => v)) {
        placementProps.push(p70('GeometricRotation', 'Vector3D',
          ...offset.rotation.map((v) => D(v * 57.29577951308232))));
      }
      if (offset.scale.some((v) => v !== 1)) {
        placementProps.push(p70('GeometricScaling', 'Vector3D', ...offset.scale.map(D)));
      }
      // A node with nothing to draw is still a place to hang things from, and
      // an FBX calls that a Null.
      objects.push(node('Model',
        [L(modelUid), S(`${label}${CLASS_SEP}Model`), S(entry.mesh ? 'Mesh' : 'Null')], [
          node('Version', [I(232)]),
          node('Properties70', [], placementProps),
        ]));
      // A parent that carries no geometry of its own has no record to hang
      // from, so its children hang from the scene as they did before.
      const under = modelUids.get(entry.parent) || 0;
      connections.push(node('C', [S('OO'), L(modelUid), L(under)]));
      if (entry.mesh) connections.push(node('C', [S('OO'), L(geometryUid), L(modelUid)]));
      for (const slot of slots) {
        connections.push(node('C', [S('OO'), L(slot), L(modelUid)]));
      }
    });

    root.children.push(node('GlobalSettings', [], [
      node('Version', [I(1000)]),
      node('Properties70', [], [
        // 3ds Max is Z up, right handed. Its unit is what the scene was built
        // in, which the file records elsewhere; a centimetre is the default
        // and the one these scenes use.
        node('P', [S('UpAxis'), S('int'), S('Integer'), S(''), I(2)]),
        node('P', [S('UpAxisSign'), S('int'), S('Integer'), S(''), I(1)]),
        node('P', [S('FrontAxis'), S('int'), S('Integer'), S(''), I(1)]),
        node('P', [S('FrontAxisSign'), S('int'), S('Integer'), S(''), I(-1)]),
        node('P', [S('CoordAxis'), S('int'), S('Integer'), S(''), I(0)]),
        node('P', [S('CoordAxisSign'), S('int'), S('Integer'), S(''), I(1)]),
        node('P', [S('UnitScaleFactor'), S('double'), S('Number'), S(''), D(1.0)]),
      ]),
    ]));

    // A node that draws nothing is a place to hang things from and not a part.
    const drawn = placed.filter((entry) => entry.mesh);
    root.children.push(node('Definitions', [], [
      node('Version', [I(100)]),
      node('Count', [I(objects.length)]),
      node('ObjectType', [S('Geometry')], [node('Count', [I(drawn.length)])]),
      node('ObjectType', [S('Model')], [node('Count', [I(placed.length)])]),
      node('ObjectType', [S('Material')], [node('Count', [I(materialUids.size)])]),
    ]));
    root.children.push(node('Objects', [], objects));
    root.children.push(node('Connections', [], connections));

    if (undecoded.size) {
      warnings.push(`no geometry read from ${[...undecoded]
        .map(([name, count]) => `${count} ${name}`).join(', ')}`);
    }
    if (!drawn.length) warnings.push('no Editable Poly geometry in this scene');

    let faces = 0;
    for (const mesh of meshes.values()) faces += mesh.faces;
    return {
      root,
      format: 'max',
      encoding: 'binary',
      version: build,
      versionSource: build ? 'Config' : null,
      wideOffsets: false,
      hasFooter: false,
      footerVersion: null,
      warnings,
      extra: {
        streams: compound.names,
        sector: compound.sector,
        build,
        buildText: versionText(build),
        classes: classes.filter((c) => c.name),
        dlls,
        assets,
        entities: entities.length,
        nodes: nodes.length,
        meshes: meshes.size,
        placed: drawn.length,
        vertices,
        faces,
        undecoded: [...undecoded].map(([name, count]) => ({ name, count })),
        materials: materialUids.size,
        textures: [...textureUids.keys()].sort(),
        smoothed: smoothedParts,
        mirrored: mirroredParts,
        smoothing: smoothedRounds,
      },
    };
  }

  return { looksLikeMax, parse, versionText, Compound, chunks };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = FbxMax;
