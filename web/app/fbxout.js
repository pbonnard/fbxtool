/* Write the scene out as a binary FBX.
 *
 * Everything else here reads FBX; this is the one thing that writes it. The
 * record tree it builds is the same one every reader in this repository
 * produces — a `Definitions` block, an `Objects` block of `Model`, `Geometry`,
 * `Material`, `Texture` and `Video` records, and a `Connections` block wiring
 * them together — so what comes out is read back by the same code that read
 * what went in, and the two can be held against each other.
 *
 * Where the formats disagree, FBX is the more accommodating of the two:
 *
 *   - a mesh may wear several materials, so one geometry carries a material
 *     index per polygon rather than being split into one primitive apiece;
 *   - a node states a translation, a rotation in degrees and a scale rather
 *     than a matrix, so each placement is decomposed — and a mirrored node
 *     keeps its flip as a negative X scale, since no rotation produces a
 *     negative determinant;
 *   - the up axis and the units live in `GlobalSettings`, so the geometry is
 *     written exactly as the file holds it and nothing is scaled on the way
 *     out.
 *
 * The container is version 7400: a header, a stream of nested records, a null
 * record, and a footer. Each record states where the next one begins, so the
 * whole tree is measured before any of it is written. Array properties are
 * deflated where that makes them smaller, which is what the format is for — a
 * car's positions and normals are megabytes of float64 and compress to a
 * fraction.
 */
'use strict';

const FbxOut = (function () {
  //: What every FBX file begins with: twenty characters, a NUL, then 0x1A
  //: and a second NUL, and the version — twenty-seven bytes in all.
  const MAGIC = 'Kaydara FBX Binary  \u0000';
  const VERSION = 7400;
  //: FBX spells a name as `Name\0\1Class` — a NUL and a SOH between the two, written
  //: here as escapes so that nothing in the way can lose them.
  const CLASS_SEP = '\u0000\u0001';
  //: The 16 bytes a writer leaves after the last record, and the 16 it ends
  //: with. Neither means anything to a reader; both are expected to be there.
  const FOOTER_ID = [0xfa, 0xbc, 0xab, 0x09, 0xd0, 0xc8, 0xd4, 0x66,
    0xb1, 0x76, 0xfb, 0x83, 0x1c, 0xf7, 0x26, 0x7e];
  const FOOTER_MAGIC = [0xf8, 0x5a, 0x8c, 0x6a, 0xde, 0xf5, 0xd9, 0x7e,
    0xec, 0xe9, 0x0c, 0xe3, 0x75, 0x8f, 0x29, 0x0b];

  const node = (name, props = [], children = []) => ({ name, props, children });
  const S = (value) => ({ code: 'S', value: String(value) });
  const I = (value) => ({ code: 'I', value: value | 0 });
  const L = (value) => ({ code: 'L', value });
  const D = (value) => ({ code: 'D', value: Number(value) });
  const R = (value) => ({ code: 'R', value });
  const arrayOf = (code, values) => ({ code, array: values });
  const p70 = (name, kind, ...values) =>
    node('P', [S(name), S(kind), S(''), S('A'), ...values]);

  // ------------------------------------------------------------- placement

  /** Euler angles in degrees for R = Rz · Ry · Rx, which is FBX's XYZ order. */
  function euler(m) {
    const clamp = Math.max(-1, Math.min(1, -m[2][0]));
    const y = Math.asin(clamp);
    let x;
    let z;
    if (Math.abs(m[2][0]) < 0.99999) {
      x = Math.atan2(m[2][1], m[2][2]);
      z = Math.atan2(m[1][0], m[0][0]);
    } else {                          // straight up or down: x and z are one turn
      x = Math.atan2(-m[1][2], m[1][1]);
      z = 0;
    }
    return [x, y, z].map((v) => (v * 180) / Math.PI);
  }

  /**
   * A node's translation, rotation in degrees and scale, from its matrix.
   *
   * *matrix* is column-major acting on column vectors, which is what the
   * viewer works in. A mirrored node has a negative determinant and no
   * rotation can produce one, so the flip is kept where it belongs.
   */
  function placement(matrix) {
    const m = matrix || [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const translation = [m[12], m[13], m[14]];
    const basis = [0, 1, 2].map((row) => [0, 1, 2].map((col) => m[col * 4 + row]));
    const scale = [0, 1, 2].map((col) =>
      Math.hypot(basis[0][col], basis[1][col], basis[2][col]));
    const determinant =
      basis[0][0] * (basis[1][1] * basis[2][2] - basis[1][2] * basis[2][1])
      - basis[0][1] * (basis[1][0] * basis[2][2] - basis[1][2] * basis[2][0])
      + basis[0][2] * (basis[1][0] * basis[2][1] - basis[1][1] * basis[2][0]);
    if (determinant < 0) scale[0] = -scale[0];
    const unit = [0, 1, 2].map((row) => [0, 1, 2].map((col) =>
      (scale[col] ? basis[row][col] / scale[col] : 0)));
    return { translation, rotation: euler(unit), scale };
  }

  // ------------------------------------------------------------- the tree

  /** Hands out the ids records address each other by. */
  function builder() {
    const objects = [];
    const connections = [];
    let next = 1000;
    return {
      objects,
      connections,
      uid: () => (next += 1),
      connect(kind, source, target, extra) {
        const props = [S(kind), L(source), L(target)];
        if (extra !== undefined) props.push(S(extra));
        connections.push(node('C', props));
      },
    };
  }

  /**
   * One geometry, welded, with a material index per polygon.
   *
   * Welding is what FBX's `PolygonVertexIndex` is for: a cube arrives as
   * thirty-six corners and is stored as twenty-four vertices addressed by
   * thirty-six indices. Normals and coordinates are written per vertex, since
   * the weld already split them wherever they differed.
   *
   * The last corner of each polygon is stored as its complement, which is how
   * FBX says where one polygon ends and the next begins.
   */
  function geometry(entry, slots, build) {
    const mesh = entry.mesh;
    const wantUv = !!mesh.hasUv;
    const triangles = [];
    const perPolygon = [];
    for (let t = 0; t < mesh.triangleCount; t++) {
      triangles.push(t);
      perPolygon.push(slots.get(t) || 0);
    }
    const welded = FbxGltf.weld(triangles, mesh, wantUv);
    const polygons = new Int32Array(welded.index.length);
    for (let at = 0; at < welded.index.length; at++) {
      const value = welded.index[at];
      polygons[at] = (at % 3 === 2) ? (-value - 1) : value;
    }

    const children = [
      node('Version', [I(124)]),
      node('Vertices', [arrayOf('d', welded.positions)]),
      node('PolygonVertexIndex', [arrayOf('i', polygons)]),
      node('LayerElementNormal', [I(0)], [
        node('Version', [I(102)]),
        node('Name', [S('')]),
        node('MappingInformationType', [S('ByVertice')]),
        node('ReferenceInformationType', [S('Direct')]),
        node('Normals', [arrayOf('d', welded.normals)]),
      ]),
    ];
    if (wantUv && welded.uvs) {
      children.push(node('LayerElementUV', [I(0)], [
        node('Version', [I(101)]),
        node('Name', [S('map1')]),
        node('MappingInformationType', [S('ByVertice')]),
        node('ReferenceInformationType', [S('Direct')]),
        node('UV', [arrayOf('d', welded.uvs)]),
      ]));
    }
    // One index per polygon into the materials hung off this model, in the
    // order they are connected — which is how a reader here resolves them.
    children.push(node('LayerElementMaterial', [I(0)], [
      node('Version', [I(101)]),
      node('Name', [S('')]),
      node('MappingInformationType', [S('ByPolygon')]),
      node('ReferenceInformationType', [S('IndexToDirect')]),
      node('Materials', [arrayOf('i', Int32Array.from(perPolygon))]),
    ]));
    const layer = [
      node('Version', [I(100)]),
      node('LayerElement', [], [
        node('Type', [S('LayerElementNormal')]), node('TypedIndex', [I(0)])]),
      node('LayerElement', [], [
        node('Type', [S('LayerElementMaterial')]), node('TypedIndex', [I(0)])]),
    ];
    if (wantUv && welded.uvs) {
      layer.push(node('LayerElement', [], [
        node('Type', [S('LayerElementUV')]), node('TypedIndex', [I(0)])]));
    }
    children.push(node('Layer', [I(0)], layer));

    const uid = build.uid();
    const label = entry.name || 'mesh';
    build.objects.push(node('Geometry',
      [L(uid), S(`${label}${CLASS_SEP}Geometry`), S('Mesh')], children));
    return { uid, vertices: welded.positions.length / 3, triangles: mesh.triangleCount };
  }

  /**
   * One material, written as the phong record every FBX reader expects.
   *
   * The palette holds a colour already split between diffuse and reflectance
   * by one metalness. Both halves are written, and the metalness beside them,
   * so a reader that understands it can put the two back together and one
   * that does not still sees a plausible surface.
   */
  function materialRecord(entry, build) {
    const colour = entry.colour || [0.8, 0.8, 0.8];
    const specular = entry.specular || [0.04, 0.04, 0.04];
    const roughness = typeof entry.roughness === 'number' ? entry.roughness : 0.5;
    const props = [
      p70('DiffuseColor', 'Color', ...colour.map(D)),
      p70('SpecularColor', 'Color', ...specular.map(D)),
      p70('Metallic', 'Number', D(typeof entry.metallic === 'number' ? entry.metallic : 0)),
/* FBX states a Phong exponent, not a roughness. The two meet through
       * the microfacet alpha — `alpha = roughness squared` and
       * `alpha = sqrt(2 / (n + 2))` — so the exponent is two over the fourth
       * power, which is what every reader here turns back into a roughness. */
      p70('ShininessExponent', 'Number',
        D(Math.max(2 / Math.max(roughness ** 4, 1e-6) - 2, 0))),
      p70('Opacity', 'Number', D(typeof entry.opacity === 'number' ? entry.opacity : 1)),
    ];
    const emissive = entry.emissive || [0, 0, 0];
    if (emissive.some((c) => c > 0)) {
      props.push(p70('EmissiveColor', 'Color', ...emissive.map(D)));
      props.push(p70('EmissiveFactor', 'Number', D(1)));
    }
    /* And whether the colour above is read through the picture or replaced by
     * it. A game's material means the first and most files mean the second, so
     * what the material said on the way in is what it says on the way out —
     * without which a car exported wearing a skin loses its paint. */
    if (entry.tintTexture) props.push(p70('TintsTexture', 'Bool', I(1)));
    if (entry.alphaMode) props.push(p70('AlphaMode', 'KString', S(entry.alphaMode)));
    if (typeof entry.alphaCutoff === 'number') {
      props.push(p70('AlphaCutoff', 'Number', D(entry.alphaCutoff)));
    }
    /* And the shading model the file named, beside everything else it said in
     * its own words.
     *
     * This is the one thing FBX is better at than glTF here: it has no fixed
     * set of material properties, so a game's own parameters go back under the
     * names they arrived with and need no corner of the file to hide in. Which
     * is exactly how they arrived — the kn5 reader writes them the same way —
     * so a car written out and opened again derives the same surface from the
     * same numbers rather than from a PBR approximation of them.
     */
    if (entry.shader) props.push(p70('ShaderName', 'KString', S(entry.shader)));
    for (const [key, value] of Object.entries(entry.stated || {})) {
      if (typeof value === 'number') props.push(p70(key, 'Number', D(value)));
      else if (typeof value === 'boolean') props.push(p70(key, 'Bool', I(value ? 1 : 0)));
      else if (Array.isArray(value) && value.length === 3) {
        props.push(p70(key, 'Color', ...value.map(D)));
      } else if (Array.isArray(value) && value.length) {
        props.push(p70(key, `Vector${value.length}D`, ...value.map(D)));
      }
    }
    /* The clear coat, where the file stated one. A coat states no index of
     * refraction here, so the colour is the whole of how much it reflects —
     * which is what a reader takes it for when none is named beside it. */
    if (typeof entry.coat === 'number' && entry.coat > 0) {
      props.push(p70('CoatColor', 'Color', D(entry.coat), D(entry.coat), D(entry.coat)));
      const rough = typeof entry.coatRoughness === 'number' ? entry.coatRoughness : 0.05;
      props.push(p70('CoatShininess', 'Number',
        D(Math.max(2 / Math.max(rough ** 4, 1e-6) - 2, 0))));
    }
    const uid = build.uid();
    build.objects.push(node('Material',
      [L(uid), S(`${entry.name || 'material'}${CLASS_SEP}Material`), S('')], [
        node('Version', [I(102)]),
        node('ShadingModel', [S('phong')]),
        node('Properties70', [], props),
      ]));
    return uid;
  }

  /**
   * One Texture and one Video per picture, shared by everything wearing it.
   *
   * The bytes go in the Video's `Content`, which is where an embedded texture
   * lives in an FBX and is how a car's paint travels with it in one file.
   */
  /**
   * One Texture and one Video per picture, shared by everything wearing it.
   *
   * The bytes go in the Video's `Content`, which is where an embedded texture
   * lives in an FBX and is how a car's paint travels with it in one file.
   * Shared, and not copied per material: a Renault 5's paint, its detail map
   * and its normal map are worn by dozens each, and written once per wearer
   * the file comes out three times the size of the car it was made from.
   *
   * Two pictures are the same picture when they are the same bytes, which they
   * are when the same file was decoded for both. The Texture over it is shared
   * only when the wrapping matches too, since that is what a Texture states.
   */
  function textures(build) {
    const videos = new Map();
    const wrapped = new Map();
    return function record(name, image) {
      if (!image || !image.bytes || !image.bytes.length) return -1;
      const kind = (image.mimeType || 'image/png').split('/').pop().replace('jpeg', 'jpg');
      const file = `${name}.${kind}`;
      let videoUid = videos.get(image.bytes);
      if (videoUid === undefined) {
        videoUid = build.uid();
        build.objects.push(node('Video',
          [L(videoUid), S(`${name}${CLASS_SEP}Video`), S('Clip')], [
            node('Type', [S('Clip')]),
            node('FileName', [S(file)]),
            node('RelativeFilename', [S(file)]),
            node('Content', [R(image.bytes)]),
          ]));
        videos.set(image.bytes, videoUid);
      }
      const key = `${videoUid}|${image.wrapS}|${image.wrapT}`;
      if (wrapped.has(key)) return wrapped.get(key);
      const textureUid = build.uid();
      build.objects.push(node('Texture',
        [L(textureUid), S(`${name}${CLASS_SEP}Texture`), S('')], [
          node('Type', [S('TextureVideoClip')]),
          node('Version', [I(202)]),
          node('FileName', [S(file)]),
          node('RelativeFilename', [S(file)]),
          node('Properties70', [], [
            // 0 repeats and 1 clamps, which is the other way round from how
            // glTF numbers them; 33071 is glTF's CLAMP_TO_EDGE.
            p70('WrapModeU', 'enum', I(image.wrapS === 33071 ? 1 : 0)),
            p70('WrapModeV', 'enum', I(image.wrapT === 33071 ? 1 : 0)),
          ]),
        ]));
      build.connect('OO', videoUid, textureUid);
      wrapped.set(key, textureUid);
      return textureUid;
    };
  }

  //: Which FBX property each of the maps carried across drives. A slot with no
  //: FBX spelling keeps the name it came with rather than being invented one.
  const SLOT_PROPERTIES = {
    baseColor: 'DiffuseColor',
    normal: 'NormalMap',
    emissive: 'EmissiveColor',
    occlusion: 'AmbientColor',
    metallicRoughness: 'SpecularFactor',
  };

  /**
   * Build the record tree for a scene.
   *
   * *scene* is what the glTF export is handed, so the two write the same model
   * from the same numbers and can be compared.
   */
  function build(scene) {
    const meshes = scene.meshes || [];
    const roots = scene.nodes || [];
    const images = scene.images instanceof Map ? scene.images : new Map();
    const extraTextures = scene.textures instanceof Map ? scene.textures : new Map();
    const drawn = meshes.reduce((sum, m) => sum + (m.mesh ? m.mesh.triangleCount : 0), 0);
    if (!drawn) throw new Error('there is no geometry to export');

    const make = builder();
    const rootUid = 0;

    // ---- materials, once each however many meshes wear them
    const materialUid = new Map();
    const pictureFor = textures(make);
    const worn = new Set();
    const materialFor = (entry) => {
      if (materialUid.has(entry.name)) return materialUid.get(entry.name);
      const uid = materialRecord(entry, make);
      materialUid.set(entry.name, uid);
      // And the maps it wears, hung off it by the property each one drives.
      const wearing = [];
      const base = images.get(entry.name);
      if (base) wearing.push({ slot: 'baseColor', image: base });
      for (const map of extraTextures.get(entry.name) || []) {
        wearing.push({ slot: map.slot, image: map });
      }
      const seen = new Set();
      for (const map of wearing) {
        const property = SLOT_PROPERTIES[map.slot] || map.slot;
        if (seen.has(property)) continue;
        seen.add(property);
        const label = map.slot === 'baseColor' ? entry.name : `${entry.name} ${map.slot}`;
        const picture = pictureFor(label, map.image !== undefined ? map.image : map);
        if (picture < 0) continue;
        make.connect('OP', picture, uid, property);
        worn.add(picture);
      }
      return uid;
    };

    /* ---- one model per node, and one geometry under each that has a mesh */
    let vertices = 0;
    let placed = 0;
    let stored = 0;
    let geometries = 0;
    const nodeNames = [];

    /* A mesh used by several nodes is written once and connected to each,
     * which FBX allows and which is how the file this came from held it: the
     * three-part sample scene is one cube under three transforms. The
     * materials go on in the same order every time, since the order is what
     * the per-polygon indices are numbered against. */
    const shared = new Map();
    const geometryFor = (which, part) => {
      if (shared.has(which)) return shared.get(which);
      const palette = part.palette || [];
      const groupOf = (slot) => {
        const found = palette[slot];
        return found && Number.isInteger(found.group) ? found.group : slot;
      };
      const order = [];
      const seen = new Map();
      const slots = new Map();
      for (let t = 0; t < part.mesh.triangleCount; t++) {
        const slot = Math.round(part.mesh.materials[t * 3]) || 0;
        const group = palette.length ? groupOf(slot) : 0;
        if (!seen.has(group)) {
          seen.set(group, order.length);
          order.push(palette[slot] || { name: `material${group}` });
        }
        slots.set(t, seen.get(group));
      }
      const wrote = geometry(part, slots, make);
      vertices += wrote.vertices;
      stored += wrote.triangles;
      geometries += 1;
      const held = { uid: wrote.uid, triangles: wrote.triangles,
        materials: order.map(materialFor) };
      shared.set(which, held);
      return held;
    };

    const emit = (entry, parentUid) => {
      const uid = make.uid();
      const named = entry.mesh !== null && entry.mesh !== undefined
        ? meshes[entry.mesh] : null;
      const part = named && named.mesh && named.mesh.triangleCount ? named : null;
      const name = entry.name || `node${uid}`;
      const { translation, rotation, scale } = placement(entry.matrix);
      const props = [];
      if (translation.some((v) => v !== 0)) {
        props.push(p70('Lcl Translation', 'Lcl Translation', ...translation.map(D)));
      }
      if (rotation.some((v) => Math.abs(v) > 1e-9)) {
        props.push(p70('Lcl Rotation', 'Lcl Rotation', ...rotation.map(D)));
      }
      if (scale.some((v) => v !== 1)) {
        props.push(p70('Lcl Scaling', 'Lcl Scaling', ...scale.map(D)));
      }
      make.objects.push(node('Model',
        [L(uid), S(`${name}${CLASS_SEP}Model`), S(part ? 'Mesh' : 'Null')], [
          node('Version', [I(232)]),
          node('Properties70', [], props),
        ]));
      make.connect('OO', uid, parentUid);
      if (entry.name) nodeNames.push(entry.name);

      if (part) {
        const held = geometryFor(entry.mesh, part);
        for (const material of held.materials) make.connect('OO', material, uid);
        make.connect('OO', held.uid, uid);
        placed += held.triangles;
      }
      for (const child of entry.children || []) emit(child, uid);
    };

    for (const entry of roots) emit(entry, rootUid);

    // ---- and the file around them
    const settings = scene.settings || {};
    const upAxis = (scene.upAxis || 'y').toLowerCase() === 'z' ? 2 : 1;
    const tree = node('', [], []);
    tree.children.push(node('FBXHeaderExtension', [], [
      node('FBXHeaderVersion', [I(1003)]),
      node('FBXVersion', [I(VERSION)]),
      node('Creator', [S('fbxtool')]),
    ]));
    tree.children.push(node('Creator', [S('fbxtool')]));
    tree.children.push(node('GlobalSettings', [], [
      node('Version', [I(1000)]),
      node('Properties70', [], [
        p70('UpAxis', 'int', I(upAxis)),
        p70('UpAxisSign', 'int', I(1)),
        p70('FrontAxis', 'int', I(upAxis === 2 ? 1 : 2)),
        p70('FrontAxisSign', 'int', I(1)),
        p70('CoordAxis', 'int', I(0)),
        p70('CoordAxisSign', 'int', I(1)),
        // Centimetres per unit, which is what FBX counts and what the file
        // this came from stated. Nothing is scaled on the way out.
        p70('UnitScaleFactor', 'double', D(
          typeof settings.unitScale === 'number' ? settings.unitScale : 1)),
      ]),
    ]));

    const counts = new Map();
    for (const object of make.objects) {
      counts.set(object.name, (counts.get(object.name) || 0) + 1);
    }
    tree.children.push(node('Definitions', [], [
      node('Version', [I(100)]),
      node('Count', [I(make.objects.length)]),
      ...[...counts].map(([name, count]) =>
        node('ObjectType', [S(name)], [node('Count', [I(count)])])),
    ]));
    tree.children.push(node('Objects', [], make.objects));
    tree.children.push(node('Connections', [], make.connections));

    const materialNames = [...materialUid.keys()];
    return {
      tree,
      stats: {
        meshes: geometries,
        nodes: nodeNames.length,
        primitives: geometries,
        materials: materialNames.length,
        images: worn.size,
        textures: worn.size,
        triangles: placed,
        stored,
        vertices,
        materialNames,
        nodeNames,
      },
    };
  }

  // ------------------------------------------------------- the binary file

  const ARRAY_WIDTH = { f: 4, d: 8, l: 8, i: 4, b: 1 };

  /** Everything a compression stream hands back, joined. */
  async function drain(stream) {
    const reader = stream.getReader();
    const parts = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      total += value.length;
    }
    const out = new Uint8Array(total);
    let at = 0;
    for (const part of parts) { out.set(part, at); at += part.length; }
    return out;
  }

  /** An array property's values as the bytes that stand for them. */
  function rawArray(property) {
    const width = ARRAY_WIDTH[property.code];
    const values = property.array;
    const out = new Uint8Array(values.length * width);
    const view = new DataView(out.buffer);
    for (let at = 0; at < values.length; at++) {
      const to = at * width;
      if (property.code === 'd') view.setFloat64(to, values[at], true);
      else if (property.code === 'f') view.setFloat32(to, values[at], true);
      else if (property.code === 'i') view.setInt32(to, values[at], true);
      else if (property.code === 'l') view.setBigInt64(to, BigInt(values[at]), true);
      else out[to] = values[at] ? 1 : 0;
    }
    return out;
  }

  /**
   * Settle what every array property will occupy, deflating where that helps.
   *
   * FBX allows either, one array at a time, and says which it used. A car's
   * positions and normals are megabytes of float64 that compress to a
   * fraction; a nine-value array does not, and is left alone rather than
   * written larger than it was.
   */
  async function measure(record, out) {
    for (const property of record.props) {
      if (!property.array) continue;
      const raw = rawArray(property);
      let payload = raw;
      let encoding = 0;
      if (raw.length >= 64 && typeof CompressionStream === 'function') {
        const packed = await drain(new Blob([raw]).stream()
          .pipeThrough(new CompressionStream('deflate')));
        if (packed.length < raw.length) { payload = packed; encoding = 1; }
      }
      out.set(property, { payload, encoding, count: property.array.length });
    }
    for (const child of record.children) await measure(child, out);
  }

  const TEXT = new TextEncoder();

  function propertySize(property, packed) {
    switch (property.code) {
      case 'Y': return 3;
      case 'C': return 2;
      case 'I': case 'F': return 5;
      case 'D': case 'L': return 9;
      case 'S': case 'R': return 5 + (property.code === 'S'
        ? TEXT.encode(property.value).length : property.value.length);
      default: return 13 + packed.get(property).payload.length;
    }
  }

  /** How long a record is, including everything nested inside it. */
  function recordSize(record, packed, sizes) {
    let props = 0;
    for (const property of record.props) props += propertySize(property, packed);
    let children = 0;
    for (const child of record.children) children += recordSize(child, packed, sizes);
    // Every record with children is followed by a null one saying they end.
    const total = 13 + TEXT.encode(record.name).length + props
      + children + (record.children.length ? 13 : 0);
    sizes.set(record, { total, props });
    return total;
  }

  /** A writer over a fixed-size buffer, which is what the measuring is for. */
  function cursor(bytes) {
    const view = new DataView(bytes.buffer);
    let at = 0;
    return {
      get at() { return at; },
      u8(v) { bytes[at] = v; at += 1; },
      u32(v) { view.setUint32(at, v, true); at += 4; },
      i32(v) { view.setInt32(at, v, true); at += 4; },
      i16(v) { view.setInt16(at, v, true); at += 2; },
      f32(v) { view.setFloat32(at, v, true); at += 4; },
      f64(v) { view.setFloat64(at, v, true); at += 8; },
      i64(v) { view.setBigInt64(at, BigInt(v), true); at += 8; },
      raw(v) { bytes.set(v, at); at += v.length; },
      skip(n) { at += n; },
    };
  }

  function writeProperty(out, property, packed) {
    out.u8(property.code.charCodeAt(0));
    switch (property.code) {
      case 'Y': out.i16(property.value); return;
      case 'C': out.u8(property.value ? 1 : 0); return;
      case 'I': out.i32(property.value); return;
      case 'F': out.f32(property.value); return;
      case 'D': out.f64(property.value); return;
      case 'L': out.i64(property.value); return;
      case 'S': {
        const text = TEXT.encode(property.value);
        out.u32(text.length);
        out.raw(text);
        return;
      }
      case 'R':
        out.u32(property.value.length);
        out.raw(property.value);
        return;
      default: {
        const held = packed.get(property);
        out.u32(held.count);
        out.u32(held.encoding);
        out.u32(held.payload.length);
        out.raw(held.payload);
      }
    }
  }

  function writeRecord(out, record, packed, sizes) {
    const size = sizes.get(record);
    const name = TEXT.encode(record.name);
    out.u32(out.at + size.total);            // where the next record begins
    out.u32(record.props.length);
    out.u32(size.props);
    out.u8(name.length);
    out.raw(name);
    for (const property of record.props) writeProperty(out, property, packed);
    for (const child of record.children) writeRecord(out, child, packed, sizes);
    if (record.children.length) out.skip(13);
  }

  /**
   * The whole file: a header, the records, a null record and a footer.
   *
   * Nothing in the footer means anything to a reader — it is a fixed sixteen
   * bytes, a pad to the next sixteen, the version again and a second fixed
   * sixteen — but a file without one is a file some importers refuse, so it is
   * written the way every other writer writes it.
   */
  async function serialise(tree) {
    const packed = new Map();
    await measure(tree, packed);
    const sizes = new Map();
    let body = 0;
    for (const record of tree.children) body += recordSize(record, packed, sizes);

    const head = MAGIC.length + 2 + 4;
    const afterRecords = head + body + 13;   // and the null record that ends them
    const beforePad = afterRecords + 16;
    let pad = (16 - (beforePad % 16)) % 16;
    if (pad === 0) pad = 16;
    const total = beforePad + pad + 4 + 4 + 120 + 16;

    const bytes = new Uint8Array(total);
    const out = cursor(bytes);
    out.raw(TEXT.encode(MAGIC));
    out.u8(0x1a);
    out.u8(0x00);
    out.u32(VERSION);
    for (const record of tree.children) writeRecord(out, record, packed, sizes);
    out.skip(13);                            // the null record
    out.raw(new Uint8Array(FOOTER_ID));
    out.skip(pad);
    out.u32(0);
    out.u32(VERSION);
    out.skip(120);
    out.raw(new Uint8Array(FOOTER_MAGIC));
    return bytes;
  }

  return { build, serialise, placement, euler, VERSION };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = FbxOut;
