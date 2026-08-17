/* Read Assetto Corsa's `.kn5` into the record tree every other reader
 * produces, so the report, the viewer, the material list and the exporter all
 * work on it unchanged.
 *
 * A `.kn5` is what ksEditor writes out of 3ds Max for the game to load: one
 * binary file holding the whole car, textures included.  Nothing in it is
 * addressed by name at run time, so the file is a plain forward walk — a
 * texture table, a material table, then a node tree whose meshes name their
 * material by index.
 *
 *   kn5                               here
 *   ------------------------------    ------------------------------------
 *   a texture                         Texture + Video, bytes on the clip
 *   a material                        Material, shader parameters and all
 *   txDiffuse / txNormal              an OP link naming DiffuseColor / NormalMap
 *   a dummy node                      Model (Null) with its transform
 *   a mesh node                       Model (Mesh) and a Geometry
 *   interleaved vertices              Vertices, LayerElementNormal, …UV
 *   ushort indices                    a polygon run, every third index negated
 *   Y up, metres, +Z to the front     declared as such in GlobalSettings
 *
 * Two things are turned round on the way in.  The game measures V downwards
 * from the top of a texture, as Direct3D does and FBX does not, so V is
 * flipped.  And the transforms are Direct3D's row-major 4x4 with the
 * translation in the last row — which is the same sixteen numbers in the same
 * order as a column-major matrix acting on column vectors, so they decompose
 * as they stand.
 *
 * Nothing else is moved.  The game's axes are right-handed with Y up and +Z
 * towards the front of the car, which leaves +X pointing at its left-hand
 * side; that is what GlobalSettings is made to say, rather than mirroring a
 * car to make it look like something else.
 */
'use strict';

const FbxKn5 = (function () {
  const CLASS_SEP = '\u0000\u0001';
  //: "sc6969", the six bytes every kn5 begins with.
  const MAGIC = [0x73, 0x63, 0x36, 0x39, 0x36, 0x39];

  const NODE_CLASSES = { 1: 'Node', 2: 'Mesh', 3: 'SkinnedMesh' };
  const BLEND_MODES = { 0: 'OPAQUE', 1: 'BLEND', 2: 'MASK' };
  const VERTEX = 44;
  const SKINNED_VERTEX = 76;

  /* The kn5 slots that mean something to an FBX material. */
  const SLOT_PROPERTIES = {
    txDiffuse: 'DiffuseColor',
    txNormal: 'NormalMap',
    txGlow: 'EmissiveColor',
  };

  /**
   * The FBX property a kn5 texture slot fills, under this shader.
   *
   * A slot with no FBX meaning keeps the name the game gives it: `txMaps` is
   * not a metallic-roughness map however much it looks like one — its channels
   * drive the game's own shader — and a map drawn from the wrong end is worse
   * than one not drawn.
   *
   * On the shaders that model a car being crashed, `txNormal` is not the
   * surface's own relief either — it is the dents, blended in as damage
   * accumulates. A car as saved has none, so drawing it puts creases down the
   * whole of a bonnet that has never been hit: the Mercedes' body names a
   * 1024-square of dents there, and taken at face value every panel comes out
   * beaten in, with the sun catching each crease pink.
   */
  function slotProperty(slot, shader) {
    if (slot === 'txNormal' && /damage/i.test(shader)) return slot;
    return SLOT_PROPERTIES[slot] || slot;
  }

  /* The most a dielectric reflects facing you: diamond, at an index of
   * refraction of 2.42. Glass and plastic sit near 0.04, and an artist writing
   * 0.15 for a windscreen is still describing one. Above this, nothing but a
   * conductor reflects that much — and below half, no conductor does. */
  const DIELECTRIC_CEILING = 0.17;
  const METAL_FLOOR = 0.5;

  /**
   * How much of a conductor a surface reflecting this much must be.
   *
   * A kn5 states no metalness. The game shades a car with a Blinn-Phong
   * highlight and a Schlick Fresnel over it, and chrome is simply a material
   * whose `fresnelC` an artist set high. But `fresnelC` is a reflectance at
   * normal incidence, and that is the one number where the two kinds of
   * surface cannot be confused.
   *
   * Nothing is read from a surface the file also says is see-through — light
   * passes through a dielectric and not through a conductor, so a windscreen
   * with a strong reflection is a windscreen.
   *
   * Where an artist stated nothing this reads zero, rather than guessing from
   * a material's name. Some cars are modelled entirely through the grazing
   * level, which is what paint does too: an Alfa Brera's chrome and its body
   * are the same numbers to three decimal places, and the difference between
   * them is in the picture each one wears.
   */
  function metalness(facing, blended) {
    if (blended || facing <= DIELECTRIC_CEILING) return 0;
    return Math.min(1, (facing - DIELECTRIC_CEILING)
      / (METAL_FLOOR - DIELECTRIC_CEILING));
  }

  /* Property defaults for a material that leaves one out, as the shaders do,
   * and no ceiling on the Fresnel term where none is stated. */
  const DEFAULT_FRESNEL_C = 0.05;
  const DEFAULT_FRESNEL_MAX = 1;

  /**
   * What a surface actually reflects facing you.
   *
   * `fresnelC` is the Schlick base and `fresnelMaxLevel` is a ceiling on the
   * whole term — not the value at a grazing angle, which is what the pair
   * reads like until you see the numbers. A BMW Z3M's `lightclear` states 1.0
   * and 0.03: read as a base it is a perfect mirror, and read as a ceiling it
   * is the three per cent a clear lens reflects. An Alfa TZ2's `EXT_TYRE`
   * settles it — it states 5.0, which is not a reflectance at all and can only
   * be a number something clamps, beside a ceiling of 0.02.
   *
   * The two always travel together: of 1853 materials across the cars to hand,
   * 1075 state both and 778 state neither, and not one states only one of
   * them. So reading the first without the second is reading half of a
   * sentence, and it is the half that turns a tail lamp and a tyre into
   * mirrors. The ceiling is below the base in 95 of them.
   *
   * What is not modelled is the ceiling at a grazing angle: the viewer's own
   * Schlick rises towards 1 at the edge where the game would hold it at
   * `fresnelMaxLevel`.
   */
  function reflectance(material) {
    const facing = scalarOf(material, 'fresnelC', DEFAULT_FRESNEL_C);
    const ceiling = scalarOf(material, 'fresnelMaxLevel', DEFAULT_FRESNEL_MAX);
    return Math.min(Math.max(Math.min(facing, ceiling), 0), 1);
  }

  /* What a plainly lit surface takes from the light: `ksAmbient` and
   * `ksDiffuse` at the pair most materials state them at. Of 1728 materials
   * across the 27 cars to hand, 0.5 and 0.6 is the commonest by a wide margin
   * — 278 of them, one in six, and the value the game's own editor starts a
   * material at. */
  const LIGHT_AMBIENT = 0.5;
  const LIGHT_DIFFUSE = 0.6;

  /**
   * How much of the light a material takes, against a plainly lit one.
   *
   * `ksAmbient` and `ksDiffuse` weight the two halves of the game's own
   * lighting rather than tinting anything. Both halves are diffuse, so in a
   * viewer with one fixed light the two weights have nowhere to go but the
   * albedo, where they are the same arithmetic: dimming the light that reaches
   * a surface and dimming the surface come to the same picture.
   *
   * This is the whole of why an Audi S8 comes up white from end to end. Its
   * paint is 0.4 and 0.4 and its wheels are 0.03 and 0.01; its headlight
   * housings are nothing at all. The pictures under those are grey panel maps
   * — the colour was never in the picture — so read without the weights the
   * rims, the lamps and the carbon mirror caps all draw as bright as the body,
   * and the body draws brighter than the game ever shows it.
   *
   * A quarter of them ask for more light than a plainly lit surface gets,
   * which a dashboard or a lamp lens does on purpose. A diffuse surface cannot
   * return more than it was given, so that is where this stops.
   */
  function lightWeight(material) {
    const weight = (scalarOf(material, 'ksAmbient', LIGHT_AMBIENT)
      + scalarOf(material, 'ksDiffuse', LIGHT_DIFFUSE)) / (LIGHT_AMBIENT + LIGHT_DIFFUSE);
    return Math.min(Math.max(weight, 0), 1);
  }

  /* A Custom Shaders Patch lamp block, and the two things wanted out of it. */
  const LAMP_SECTION = /^\s*\[(REFRACTING_HEADLIGHT[^\]]*)\]/;
  const LAMP_KEY = /^[ \t]*(SURFACE|GLASS_COLOR|EXTRA_GLASS_COLORIZATION)[ \t]*=([^;\n]*)/i;

  /**
   * What colour each lamp lens is, out of a car's own lighting config.
   *
   * A car's glass is one grey picture however many lamps wear it — a Renault 5
   * has nine materials sharing one 32-pixel square of `rgba(52, 60, 61, 47)`,
   * told apart only by the normal map moulding each pattern. What makes its
   * fog lamps yellow and its indicators amber is stated beside the model
   * instead, in the blocks Custom Shaders Patch reads to simulate a lamp:
   *
   *     [REFRACTING_HEADLIGHT_...]
   *     SURFACE = glass_fog
   *     GLASS_COLOR = 1, 0.80723137, 0.12472421
   *
   * Eighteen of them on that car, naming a mesh apiece and giving it a tint —
   * amber for the four indicators, red for the tail lamps, yellow for the fog
   * lamps and a plain quarter-grey for the headlights. Read without them every
   * lamp on the car is the same colourless glass, which is what the file holds
   * and not what anybody has seen the car as.
   *
   * `SURFACE` names a *mesh* rather than a material, and the two do not line
   * up: this car's `glass_fog` mesh wears the material its `glass_platelight`
   * mesh wears, and the two are given different colours. So the tint belongs
   * to the part.
   *
   * A block that turns the colouring off is taken at its word.
   */
  function lensColours(text) {
    const out = new Map();
    let section = '';
    let surfaces = [];
    let colour = null;
    let enabled = true;
    const close = () => {
      if (!colour || !enabled) return;
      for (const name of surfaces) {
        if (!out.has(name.toLowerCase())) out.set(name.toLowerCase(), colour);
      }
    };
    for (const line of String(text || '').split(/\r?\n/)) {
      const heading = LAMP_SECTION.exec(line);
      if (heading || line.trimStart().startsWith('[')) {
        close();
        section = heading ? heading[1] : '';
        surfaces = [];
        colour = null;
        enabled = true;
        continue;
      }
      if (!section) continue;
      const setting = LAMP_KEY.exec(line);
      if (!setting) continue;
      const key = setting[1].toUpperCase();
      const value = setting[2].trim();
      if (key === 'SURFACE') {
        surfaces = value.split(',').map((n) => n.trim()).filter(Boolean);
      } else if (key === 'EXTRA_GLASS_COLORIZATION') {
        enabled = !['0', '0.0', 'false', 'False'].includes(value);
      } else {
        const parts = value.split(',').map((p) => p.trim()).filter(Boolean);
        if (parts.length < 3) continue;
        const rgb = parts.slice(0, 3).map(Number);
        if (rgb.some((c) => !Number.isFinite(c))) continue;
        colour = rgb.map((c) => Math.min(Math.max(c, 0), 1));
      }
    }
    close();
    return out;
  }

  const node = (name, props = [], children = []) => ({ name, props, children });
  const S = (value) => ({ code: 'S', typeName: 'string', value: String(value) });
  const I = (value) => ({ code: 'I', typeName: 'int32', value: value | 0 });
  const L = (value) => ({ code: 'L', typeName: 'int64', value });
  const D = (value) => ({ code: 'D', typeName: 'float64', value: Number(value) });
  const R = (value) => ({ code: 'R', typeName: 'raw', value });

  const p70 = (name, kind, ...values) =>
    node('P', [S(name), S(kind), S(''), S('A'), ...values]);

  function array(code, values, length) {
    const size = code === 'd' ? 8 : 4;
    return {
      code,
      typeName: `${code === 'd' ? 'float64' : 'int32'}[]`,
      array: { length, encoding: 0, byteLength: length * size, dataOffset: 0 },
      values,
      value: null,
    };
  }

  /**
   * A node's translation, rotation in degrees, and scale.
   *
   * The sixteen numbers are Direct3D's: rows are the basis vectors and the
   * translation is the last of them.  Read as `m[col * 4 + row]` that is the
   * same element order as a column-major matrix acting on column vectors,
   * which is what the rest of the page works in.
   *
   * A mirrored node has a negative determinant and no rotation can produce
   * one, so the flip is kept where it belongs — as a negative scale on X.
   */
  function placementOf(m) {
    const basis = [0, 1, 2].map((row) => [0, 1, 2].map((col) => m[col * 4 + row]));
    const scale = [0, 1, 2].map((col) => Math.hypot(basis[0][col], basis[1][col], basis[2][col]));
    const determinant =
      basis[0][0] * (basis[1][1] * basis[2][2] - basis[1][2] * basis[2][1])
      - basis[0][1] * (basis[1][0] * basis[2][2] - basis[1][2] * basis[2][0])
      + basis[0][2] * (basis[1][0] * basis[2][1] - basis[1][1] * basis[2][0]);
    if (determinant < 0) scale[0] = -scale[0];
    const r = [0, 1, 2].map((row) => [0, 1, 2].map(
      (col) => (scale[col] ? basis[row][col] / scale[col] : 0)));
    // R = Rz · Ry · Rx, FBX's XYZ order.
    const clamped = Math.min(1, Math.max(-1, -r[2][0]));
    const y = Math.asin(clamped);
    let x;
    let z;
    if (Math.abs(r[2][0]) < 0.99999) {
      x = Math.atan2(r[2][1], r[2][2]);
      z = Math.atan2(r[1][0], r[0][0]);
    } else {                       // looking straight up or down
      x = Math.atan2(-r[1][2], r[1][1]);
      z = 0;
    }
    const degrees = 180 / Math.PI;
    return {
      translation: [m[12], m[13], m[14]],
      rotation: [x * degrees, y * degrees, z * degrees],
      scale,
    };
  }

  /* How many triangles of any one mesh are held against its normals, the share
   * that has to agree, and how many must have been looked at before saying so.
   * Twelve sound cars sit between 95% and 100%; a scrambled one is a coin toss. */
  const WINDING_SAMPLE = 24;
  const WINDING_FLOOR = 0.75;
  const WINDING_MINIMUM = 200;

  //: What Custom Shaders Patch writes at the very end of a car it has encrypted.
  const ENCRYPTED_MARKER = '__AC_SHADERS_PATCH_KN5ENC_v1__';

  /**
   * Where a Custom Shaders Patch encrypted section starts, if there is one.
   *
   * A protected car is a whole kn5 with the model deliberately spoiled — the
   * vertex stream scrambled, every texture replaced by one stand-in — followed
   * by the real thing in named, encrypted blocks, and then a trailer saying so
   * in plain text: this marker, the offset the encrypted part begins at, and a
   * version. The game decrypts it. Nothing here does, and nothing here tries;
   * what it can do is say which kind of file it has been given, so a shattered
   * car is a fact about the file rather than a mystery about the reader.
   */
  function encryptedFrom(bytes) {
    if (bytes.length < 64) return null;
    const tail = bytes.subarray(bytes.length - 64);
    const text = String.fromCharCode(...tail);
    const at = text.lastIndexOf(ENCRYPTED_MARKER);
    if (at < 0) return null;
    const after = bytes.length - 64 + at + ENCRYPTED_MARKER.length;
    if (after + 8 > bytes.length) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const start = view.getUint32(after, true);
    return start > 0 && start <= bytes.length ? start : null;
  }

  /**
   * Count triangles wound the way their own vertex normals point.
   *
   * A triangle's corners in order give it a facing, and every vertex of it
   * carries a normal that should agree. In a sound file they always do — the
   * exporter wrote both from the same surface — so the two are a check on each
   * other that needs nothing outside the mesh.
   *
   * Cars are published deliberately spoiled, with the vertex stream scrambled
   * so that anything but the game draws a shattered model. Nothing in the
   * header says so: the counts are right, the normals are unit vectors, and
   * every index is in range. This is what tells the difference.
   */
  function winding(view, mesh, tally) {
    const triangles = Math.floor(mesh.indices.count / 3);
    const take = Math.min(triangles, WINDING_SAMPLE);
    if (!take || !mesh.vertices.count) return;
    const step = Math.max(1, Math.floor(triangles / take)) * 3;
    const { positions, normals } = mesh.vertices;
    const idx = mesh.indices.raw;
    for (let at = 0; at + 2 < idx.length; at += step) {
      const i = idx[at], j = idx[at + 1], k = idx[at + 2];
      const ax = positions[i * 3], ay = positions[i * 3 + 1], az = positions[i * 3 + 2];
      const e1x = positions[j * 3] - ax;
      const e1y = positions[j * 3 + 1] - ay;
      const e1z = positions[j * 3 + 2] - az;
      const e2x = positions[k * 3] - ax;
      const e2y = positions[k * 3 + 1] - ay;
      const e2z = positions[k * 3 + 2] - az;
      const cx = e1y * e2z - e1z * e2y;
      const cy = e1z * e2x - e1x * e2z;
      const cz = e1x * e2y - e1y * e2x;
      const scale = Math.hypot(cx, cy, cz);
      if (scale < 1e-12) continue;             // a degenerate triangle faces nowhere
      const nx = normals[i * 3] + normals[j * 3] + normals[k * 3];
      const ny = normals[i * 3 + 1] + normals[j * 3 + 1] + normals[k * 3 + 1];
      const nz = normals[i * 3 + 2] + normals[j * 3 + 2] + normals[k * 3 + 2];
      const facing = cx * nx + cy * ny + cz * nz;
      if (facing > 0.02 * scale) tally[0] += 1;
      else if (facing < -0.02 * scale) tally[1] += 1;
    }
  }

  /** True when these bytes are an Assetto Corsa model file. */
  function looksLikeKn5(bytes) {
    if (!bytes || bytes.length < 10) return false;
    return MAGIC.every((byte, i) => bytes[i] === byte);
  }

  /** A forward walk over the file, which is all the format ever needs. */
  class Cursor {
    constructor(bytes) {
      this.bytes = bytes;
      this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      this.at = 0;
      this.decoder = new TextDecoder('utf-8');
    }

    take(count) {
      const start = this.at;
      this.at += count;
      if (this.at > this.bytes.length) {
        throw new Error(`the file ends inside a record at byte ${start}`);
      }
      return start;
    }

    u8() { return this.bytes[this.take(1)]; }

    i32() { return this.view.getInt32(this.take(4), true); }

    u32() { return this.view.getUint32(this.take(4), true); }

    f32() { return this.view.getFloat32(this.take(4), true); }

    floats(count) {
      const start = this.take(4 * count);
      const out = new Array(count);
      for (let i = 0; i < count; i++) out[i] = this.view.getFloat32(start + 4 * i, true);
      return out;
    }

    text() {
      const length = this.u32();
      if (length > this.bytes.length - this.at) {
        throw new Error(`a ${length}-byte name at ${this.at} runs past the file`);
      }
      const start = this.take(length);
      return this.decoder.decode(this.bytes.subarray(start, start + length));
    }

    blob(length) {
      const start = this.take(length);
      return this.bytes.subarray(start, start + length);
    }

    skip(count) { this.take(count); }
  }

  /* ---------------------------------------------------------------- tables */

  function readTextures(cursor) {
    const count = cursor.i32();
    if (count < 0) throw new Error(`the texture table claims ${count} entries`);
    const textures = [];
    for (let i = 0; i < count; i++) {
      const kind = cursor.i32();
      const name = cursor.text();
      const size = cursor.u32();
      // A slot marked inactive still carries its bytes; the game just does not
      // load it. Dropping the payload would move the cursor off the next record.
      textures.push({ kind, name, size, data: cursor.blob(size) });
    }
    return textures;
  }

  function readMaterials(cursor) {
    const count = cursor.i32();
    if (count < 0) throw new Error(`the material table claims ${count} entries`);
    const materials = [];
    for (let i = 0; i < count; i++) {
      const name = cursor.text();
      const shader = cursor.text();
      const blend = cursor.u8();
      const alphaTested = cursor.u8() !== 0;
      const depthMode = cursor.i32();
      const props = new Map();
      const propCount = cursor.i32();
      for (let k = 0; k < propCount; k++) {
        const key = cursor.text();
        props.set(key, [cursor.f32(), cursor.floats(2), cursor.floats(3), cursor.floats(4)]);
      }
      const slots = [];
      const slotCount = cursor.i32();
      for (let k = 0; k < slotCount; k++) {
        slots.push({ slot: cursor.text(), number: cursor.i32(), texture: cursor.text() });
      }
      materials.push({ name, shader, blend, alphaTested, depthMode, props, slots });
    }
    return materials;
  }

  const scalarOf = (material, key, fallback) => (material.props.has(key)
    ? material.props.get(key)[0] : fallback);

  /* A payload every texture in the file shares is not a texture — and no real
   * one is this small. 4 KiB is roomy for a 1x1 placeholder and far under a
   * 16x16 swatch a car actually uses, of which several are genuinely repeated. */
  const PLACEHOLDER_LIMIT = 4096;

  /**
   * True when the texture table holds one stand-in image over and over.
   *
   * Cars are published with their textures stripped out and something else put
   * in the file after the node tree: every entry in the table is then the same
   * seventy-byte PNG of a single blue pixel, under the name of the picture that
   * used to be there. Drawn, that paints the whole car one translucent blue;
   * read for what it is, the car comes back in its own material colours with
   * every texture listed as one to go and find.
   */
  function placeholders(textures) {
    if (textures.length < 2) return false;
    const first = textures[0].data;
    if (!first.length || first.length > PLACEHOLDER_LIMIT) return false;
    return textures.every((texture) => texture.data.length === first.length
      && texture.data.every((byte, at) => byte === first[at]));
  }

  /* -------------------------------------------------------------- geometry */

  /** Unpack the interleaved vertex stream into the three layers FBX wants. */
  function readVertices(cursor, stride) {
    const count = cursor.u32();
    const start = cursor.at;
    cursor.skip(count * stride);
    const positions = new Float64Array(count * 3);
    const normals = new Float64Array(count * 3);
    const uvs = new Float64Array(count * 2);
    const { view } = cursor;
    for (let i = 0; i < count; i++) {
      const at = start + i * stride;
      positions[i * 3] = view.getFloat32(at, true);
      positions[i * 3 + 1] = view.getFloat32(at + 4, true);
      positions[i * 3 + 2] = view.getFloat32(at + 8, true);
      normals[i * 3] = view.getFloat32(at + 12, true);
      normals[i * 3 + 1] = view.getFloat32(at + 16, true);
      normals[i * 3 + 2] = view.getFloat32(at + 20, true);
      uvs[i * 2] = view.getFloat32(at + 24, true);
      // The game measures V down from the top of the texture; FBX up.
      uvs[i * 2 + 1] = 1 - view.getFloat32(at + 28, true);
    }
    return { count, positions, normals, uvs };
  }

  function readIndices(cursor) {
    const count = cursor.u32();
    const start = cursor.at;
    cursor.skip(count * 2);
    const polygons = new Int32Array(count);
    const { view } = cursor;
    for (let i = 0; i < count; i++) polygons[i] = view.getUint16(start + i * 2, true);
    // Kept before the run is written, since the check on the geometry wants the
    // corners as the file gave them.
    const raw = Int32Array.from(polygons);
    // A polygon run, as FBX writes it: the last corner of each triangle is
    // stored as its complement.
    for (let i = 2; i < count; i += 3) polygons[i] = ~polygons[i];
    return { count, polygons, raw };
  }

  function readMesh(cursor, skinned) {
    const mesh = {
      castShadows: cursor.u8() !== 0,
      visible: cursor.u8() !== 0,
      transparent: cursor.u8() !== 0,
      bones: 0,
      renderable: true,
    };
    if (skinned) {
      const bones = cursor.i32();
      for (let i = 0; i < bones; i++) { cursor.text(); cursor.skip(64); }
      mesh.bones = bones;
    }
    const vertices = readVertices(cursor, skinned ? SKINNED_VERTEX : VERTEX);
    const indices = readIndices(cursor);
    mesh.vertices = vertices;
    mesh.indices = indices;
    mesh.material = cursor.i32();
    mesh.layer = cursor.u32();
    mesh.lodIn = cursor.f32();
    mesh.lodOut = cursor.f32();
    if (!skinned) {
      // A bounding sphere, then whether the game draws it at all. A skinned
      // mesh moves, so it carries neither.
      cursor.skip(12);
      mesh.radius = cursor.f32();
      mesh.renderable = cursor.u8() !== 0;
    }
    return mesh;
  }

  /* ------------------------------------------------------------------ read */

  function parse(bytes) {
    const warnings = [];
    const cursor = new Cursor(bytes);
    cursor.skip(6);
    const version = cursor.i32();
    // From version 6 the header carries one more number, which every file seen
    // writes as zero and nothing reads. It has to be stepped over all the same.
    if (version > 5) cursor.i32();
    if (version !== 5 && version !== 6) {
      warnings.push(`kn5 version ${version} — this reads 5 and 6`);
    }

    const textures = readTextures(cursor);
    const materials = readMaterials(cursor);

    const objects = [];
    const connections = [];
    let next = 1000;
    const uid = () => { next += 1; return next; };
    const connect = (kind, source, target, ...extra) => {
      connections.push(node('C', [S(kind), L(source), L(target), ...extra.map(S)]));
    };

    /* ---- textures: one Texture and one Video per distinct image
     *
     * Shared rather than made afresh per material. A car's paint, its detail
     * map and its normal map are worn by dozens of materials each, and copying
     * sixty megabytes of DDS once per slot is not a description of anything.
     */
    // A stripped file names its textures and holds none of them. Carrying the
    // stand-in would paint the whole car with it.
    const stripped = placeholders(textures);
    const carried = new Map(stripped ? []
      : textures.map((texture) => [texture.name, texture]));
    const named = [];
    for (const material of materials) {
      for (const entry of material.slots) named.push(entry.texture);
    }
    const textureUids = new Map();
    for (const name of [...carried.keys(), ...named]) {
      if (!name || textureUids.has(name)) continue;
      const textureUid = uid();
      const videoUid = uid();
      textureUids.set(name, textureUid);
      objects.push(node('Texture', [L(textureUid), S(`${name}${CLASS_SEP}Texture`), S('')], [
        node('Type', [S('TextureVideoClip')]),
        node('Version', [I(202)]),
        node('FileName', [S(name)]),
        node('RelativeFilename', [S(name)]),
        node('Properties70', [], [
          // The game wraps every texture; nothing in the file says otherwise,
          // and a tread that came back clamped would show.
          p70('WrapModeU', 'enum', I(0)),
          p70('WrapModeV', 'enum', I(0)),
        ]),
      ]));
      const clip = [
        node('Type', [S('Clip')]),
        node('FileName', [S(name)]),
        node('RelativeFilename', [S(name)]),
      ];
      const held = carried.get(name);
      if (held && held.data.length) clip.push(node('Content', [R(held.data)]));
      objects.push(node('Video', [L(videoUid), S(`${name}${CLASS_SEP}Video`), S('Clip')], clip));
      connect('OO', videoUid, textureUid);
    }

    /* ---- materials */
    let metals = 0;
    let dimmed = 0;
    const materialUids = materials.map((material) => {
      const id = uid();
      /* What comes back facing you. The game's shaders spell a Schlick Fresnel
       * out in full — `fresnelC` as the base, rising over `fresnelEXP` and held
       * under `fresnelMaxLevel` — and the reflectance is what the two of those
       * come to, not what the first of them says alone. */
      const facing = reflectance(material);
      const alphaMode = material.alphaTested ? 'MASK'
        : (BLEND_MODES[material.blend] || 'OPAQUE');
      const metal = metalness(facing, alphaMode === 'BLEND');
      if (metal) metals += 1;
      /* Split between the two halves of the surface the way every importer
       * here does: what is left of the diffuse once the metal has taken its
       * share, and a reflectance that is the dielectric's on that share and the
       * conductor's own on the rest.
       *
       * A kn5 material states no colour of its own — `txDiffuse` is the albedo
       * — but it does state how much of the light it takes, and that is a
       * greyscale the picture is read through. So the colour being split is
       * that weight rather than white, and it multiplies the map instead of
       * standing in for one. */
      const weight = lightWeight(material);
      if (weight < 0.999) dimmed += 1;
      const diffuse = (1 - metal) * weight;
      const specular = facing * (1 - metal) + metal;
      const props = [
        p70('DiffuseColor', 'Color', D(diffuse), D(diffuse), D(diffuse)),
        p70('SpecularColor', 'Color', D(specular), D(specular), D(specular)),
        p70('Metallic', 'Number', D(metal)),
      ];
      props.push(p70('ShininessExponent', 'Number',
        D(Math.max(scalarOf(material, 'ksSpecularEXP', 20), 0))));
      props.push(p70('Opacity', 'Number', D(1)));
      props.push(p70('AlphaMode', 'KString', S(alphaMode)));
      props.push(p70('ShaderName', 'KString', S(material.shader)));
      // And that the colour above is read through the picture rather than
      // replaced by it, which is the usual way round. Everything a kn5 states
      // about a surface is stated for the whole of it and the picture is the
      // pattern, so the two multiply.
      props.push(p70('TintsTexture', 'Bool', I(1)));
      if (material.alphaTested) {
        props.push(p70('AlphaCutoff', 'Number', D(scalarOf(material, 'ksAlphaRef', 0.5))));
      }
      // What the surface gives off on its own. `ksEmissive` is written as a
      // colour when it is one and as a single number when it is not.
      const emissive = material.props.get('ksEmissive');
      if (emissive) {
        const colour = emissive[2].some((v) => v) ? emissive[2]
          : [emissive[0], emissive[0], emissive[0]];
        props.push(p70('EmissiveColor', 'Color', ...colour.map(D)));
        props.push(p70('EmissiveFactor', 'Number', D(1)));
      }
      // Then everything the file said, under the name it said it with, so that
      // a shader parameter with no FBX spelling is still there to be read. A
      // parameter that happens to be spelt like one of the properties above is
      // left alone rather than allowed to overwrite what was read from it.
      const written = new Set(props.map((entry) => entry.props[0].value));
      for (const [key, [a, b, c, d]] of material.props) {
        if (written.has(key)) continue;
        if (d.some((v) => v)) props.push(p70(key, 'Vector4D', ...d.map(D)));
        else if (c.some((v) => v)) props.push(p70(key, 'Color', ...c.map(D)));
        else if (b.some((v) => v)) props.push(p70(key, 'Vector2D', ...b.map(D)));
        else props.push(p70(key, 'Number', D(a)));
      }
      objects.push(node('Material',
        [L(id), S(`${material.name}${CLASS_SEP}Material`), S('')], [
          node('Version', [I(102)]),
          node('ShadingModel', [S('phong')]),
          node('Properties70', [], props),
        ]));
      const seen = new Set();
      for (const entry of material.slots) {
        const target = textureUids.get(entry.texture);
        if (target === undefined || seen.has(entry.slot)) continue;
        seen.add(entry.slot);
        connect('OP', target, id, slotProperty(entry.slot, material.shader));
      }
      return id;
    });

    /* ---- the node tree */
    const scene = {
      nodes: 0, meshes: 0, skinned: 0, bones: 0, vertices: 0, triangles: 0,
      inactive: 0, hidden: 0, depth: 0, lods: [], used: new Set(),
      //: Triangles wound with their own normals, and against them.
      winding: [0, 0],
    };

    function walk(parent, depth) {
      if (depth > 256) throw new Error('the node tree nests deeper than 256 levels');
      if (depth > scene.depth) scene.depth = depth;
      const classId = cursor.i32();
      if (!NODE_CLASSES[classId]) {
        throw new Error(`node class ${classId} at byte ${cursor.at - 4} is not one `
          + 'this reader knows');
      }
      const name = cursor.text();
      const children = cursor.i32();
      if (children < 0) throw new Error(`${name || 'a node'} claims ${children} children`);
      const active = cursor.u8() !== 0;
      scene.nodes += 1;
      if (!active) scene.inactive += 1;

      const id = uid();
      const props = [];
      let mesh = null;

      if (classId === 1) {
        const place = placementOf(cursor.floats(16));
        if (place.translation.some((v) => v)) {
          props.push(p70('Lcl Translation', 'Lcl Translation', ...place.translation.map(D)));
        }
        if (place.rotation.some((v) => v)) {
          props.push(p70('Lcl Rotation', 'Lcl Rotation', ...place.rotation.map(D)));
        }
        if (place.scale.some((v) => v !== 1)) {
          props.push(p70('Lcl Scaling', 'Lcl Scaling', ...place.scale.map(D)));
        }
        if (/^LOD_/i.test(name)) scene.lods.push(name);
      } else {
        // A mesh sits where its parent puts it: the format gives it no
        // transform of its own.
        mesh = readMesh(cursor, classId === 3);
        winding(cursor.view, mesh, scene.winding);
        scene.meshes += 1;
        scene.vertices += mesh.vertices.count;
        scene.triangles += Math.floor(mesh.indices.count / 3);
        scene.bones += mesh.bones;
        if (classId === 3) scene.skinned += 1;
        if (!mesh.visible || !mesh.renderable) scene.hidden += 1;
        props.push(p70('Visibility', 'Visibility',
          D(mesh.visible && mesh.renderable ? 1 : 0)));
      }
      if (!active) props.push(p70('Visibility', 'Visibility', D(0)));

      const label = name || `node${id}`;
      objects.push(node('Model', [L(id), S(`${label}${CLASS_SEP}Model`),
        S(mesh ? 'Mesh' : 'Null')], [
        node('Version', [I(232)]),
        node('Properties70', [], props),
      ]));
      connect('OO', id, parent);

      if (mesh) {
        const geometryUid = uid();
        objects.push(node('Geometry',
          [L(geometryUid), S(`${label}${CLASS_SEP}Geometry`), S('Mesh')], [
            node('Vertices', [array('d', mesh.vertices.positions, mesh.vertices.count * 3)]),
            node('PolygonVertexIndex', [array('i', mesh.indices.polygons, mesh.indices.count)]),
            node('GeometryVersion', [I(124)]),
            node('LayerElementNormal', [I(0)], [
              node('Version', [I(101)]),
              node('MappingInformationType', [S('ByVertice')]),
              node('ReferenceInformationType', [S('Direct')]),
              node('Normals', [array('d', mesh.vertices.normals, mesh.vertices.count * 3)]),
            ]),
            node('LayerElementUV', [I(0)], [
              node('Version', [I(101)]),
              node('Name', [S('map1')]),
              node('MappingInformationType', [S('ByVertice')]),
              node('ReferenceInformationType', [S('Direct')]),
              node('UV', [array('d', mesh.vertices.uvs, mesh.vertices.count * 2)]),
            ]),
            // One mesh wears one material, which is the whole of what the game
            // allows: a part that needs two is two parts.
            node('LayerElementMaterial', [I(0)], [
              node('Version', [I(101)]),
              node('MappingInformationType', [S('AllSame')]),
              node('ReferenceInformationType', [S('IndexToDirect')]),
              node('Materials', [array('i', new Int32Array([0]), 1)]),
            ]),
            node('Layer', [I(0)], [node('Version', [I(100)])]),
          ]));
        connect('OO', geometryUid, id);
        if (mesh.material >= 0 && mesh.material < materialUids.length) {
          scene.used.add(mesh.material);
          connect('OO', materialUids[mesh.material], id);
        } else if (materialUids.length) {
          warnings.push(`${label} names material ${mesh.material}, which is not in `
            + 'the material table');
        }
      }

      for (let i = 0; i < children; i++) walk(id, depth + 1);
    }

    walk(0, 0);

    // Whether the geometry describes the surface its own normals describe.
    const [sound, against] = scene.winding;
    const sampled = sound + against;
    const agreement = sampled ? sound / sampled : 1;
    const scrambled = sampled >= WINDING_MINIMUM && agreement < WINDING_FLOOR;
    const encrypted = encryptedFrom(bytes);
    const percent = `${Math.round(agreement * 100)}%`;
    if (encrypted === null && cursor.at !== bytes.length) {
      warnings.push(`${bytes.length - cursor.at} byte(s) past the end of the node `
        + 'tree were not read');
    }

    const missing = [...new Set(named.filter((name) => name && !carried.has(name)))].sort();
    if (encrypted !== null) {
      warnings.push("this car is protected: it ends with Custom Shaders Patch's "
        + `${ENCRYPTED_MARKER} marker, and the ${bytes.length - encrypted} bytes `
        + 'before it are the model, encrypted. What is in front of that has been '
        + `spoiled to match — ${percent} of its triangles are wound against their `
        + 'own normals and every texture is one stand-in image. The game decrypts '
        + 'it; nothing here does. What is drawn is not the shape that was modelled');
    } else if (scrambled) {
      warnings.push(`only ${percent} of this car's triangles are wound the way their `
        + "own normals point, where a sound one is all of them — this car's "
        + 'geometry was spoiled before it was published, and what is drawn from it '
        + 'is not the shape that was modelled');
    }
    if (stripped && encrypted === null) {
      warnings.push(`every one of the ${textures.length} entries in the texture `
        + 'table is the same stand-in image — this car was published with its '
        + 'textures stripped out, and they are not in the file under any name '
        + 'it gives');
    } else if (missing.length && !stripped) {
      warnings.push(`${missing.length} texture(s) are named by a material but not in `
        + "this file — a LOD or a skin reads them from the car's main .kn5");
    }
    if (!scene.meshes) warnings.push('no meshes in this file');

    /* ---- the document */
    const creator = `Assetto Corsa kn5 version ${version}`;
    const root = { name: '', props: [], children: [] };
    root.children.push(node('FBXHeaderExtension', [], [
      node('FBXVersion', [I(7400)]),
      node('Creator', [S(creator)]),
    ]));
    root.children.push(node('Creator', [S(creator)]));
    root.children.push(node('GlobalSettings', [], [
      node('Version', [I(1000)]),
      node('Properties70', [], [
        // Right handed, Y up, in metres, with +Z towards the front of the car
        // — which leaves the third axis pointing at its left side.
        node('P', [S('UpAxis'), S('int'), S('Integer'), S(''), I(1)]),
        node('P', [S('UpAxisSign'), S('int'), S('Integer'), S(''), I(1)]),
        node('P', [S('FrontAxis'), S('int'), S('Integer'), S(''), I(2)]),
        node('P', [S('FrontAxisSign'), S('int'), S('Integer'), S(''), I(1)]),
        node('P', [S('CoordAxis'), S('int'), S('Integer'), S(''), I(0)]),
        node('P', [S('CoordAxisSign'), S('int'), S('Integer'), S(''), I(-1)]),
        node('P', [S('UnitScaleFactor'), S('double'), S('Number'), S(''), D(100)]),
      ]),
    ]));

    const counts = new Map();
    for (const entry of objects) counts.set(entry.name, (counts.get(entry.name) || 0) + 1);
    root.children.push(node('Definitions', [], [
      node('Version', [I(100)]),
      node('Count', [I(objects.length)]),
      ...[...counts].map(([name, count]) =>
        node('ObjectType', [S(name)], [node('Count', [I(count)])])),
    ]));
    root.children.push(node('Objects', [], objects));
    root.children.push(node('Connections', [], connections));

    return {
      root,
      format: 'kn5',
      encoding: 'binary',
      version: null,
      versionSource: null,
      wideOffsets: false,
      hasFooter: false,
      footerVersion: null,
      warnings,
      extra: {
        kn5Version: version,
        textures: textures.length,
        placeholderTextures: stripped ? textures.length : 0,
        textureBytes: stripped ? 0
          : textures.reduce((sum, texture) => sum + texture.size, 0),
        missingTextures: missing,
        materials: materials.length,
        materialsUsed: scene.used.size,
        metals,
        dimmed,
        shaders: [...new Set(materials.map((m) => m.shader))].sort(),
        nodes: scene.nodes,
        meshes: scene.meshes,
        skinnedMeshes: scene.skinned,
        bones: scene.bones,
        inactiveNodes: scene.inactive,
        hiddenMeshes: scene.hidden,
        vertices: scene.vertices,
        triangles: scene.triangles,
        treeDepth: scene.depth,
        lods: scene.lods,
        encrypted: encrypted !== null,
        encryptedFrom: encrypted,
        windingAgreement: sampled ? Math.round(agreement * 1e4) / 1e4 : null,
        scrambled,
      },
    };
  }

  return { looksLikeKn5, lensColours, parse, placementOf, NODE_CLASSES };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = FbxKn5;
