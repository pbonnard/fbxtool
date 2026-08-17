/* Write the scene out as a glTF 2.0 binary file.
 *
 * The scene arrives as it is held for drawing: a set of meshes in their own
 * local space, and a tree of nodes that place them. Both survive the trip —
 * a mesh used by twenty-four wheels is written once and pointed at
 * twenty-four times, and a part keeps its name and its place in the tree.
 *
 * The rest is where the formats disagree. A glTF primitive has exactly one
 * material, so each mesh is split into one primitive per material. Triangles
 * arrive unindexed — three vertices each, however many they share — so every
 * primitive is welded, which halves the file. And glTF is Y-up in metres,
 * while these files are often Z-up in centimetres, so that difference goes on
 * the root node's matrix rather than into the vertex data.
 */
'use strict';

const FbxGltf = (function () {
  const FLOAT = 5126;
  const UNSIGNED_INT = 5125;
  const ARRAY_BUFFER = 34962;
  const ELEMENT_ARRAY_BUFFER = 34963;
  const OPAQUE = 0.996;

  /**
   * Drop repeated vertices.
   *
   * Two vertices are the same when every component matches bit for bit, which
   * is what a shared corner of a triangulated polygon gives us. Positions are
   * hashed through their bit patterns, so no tolerance is involved and nothing
   * that differs is ever merged.
   */
  function weld(triangles, source, wantUv) {
    const { positions, normals, uvs } = source;
    const bits = new Uint32Array(positions.buffer, positions.byteOffset, positions.length);
    const buckets = new Map();
    const index = new Uint32Array(triangles.length * 3);
    // At most three vertices per triangle survive, so the room is known up
    // front — worth preallocating on a scene of half a million triangles.
    const outPositions = new Float32Array(triangles.length * 9);
    const outNormals = new Float32Array(triangles.length * 9);
    const outUvs = wantUv ? new Float32Array(triangles.length * 6) : null;
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    let next = 0;

    for (let t = 0; t < triangles.length; t++) {
      const triangle = triangles[t];
      for (let corner = 0; corner < 3; corner++) {
        const vertex = triangle * 3 + corner;
        const p = vertex * 3;
        const uv = vertex * 2;
        let hash = 2166136261;
        for (let k = 0; k < 3; k++) hash = Math.imul(hash ^ bits[p + k], 16777619);
        hash >>>= 0;

        let found = -1;
        const bucket = buckets.get(hash);
        if (bucket) {
          for (const candidate of bucket) {
            const q = candidate * 3;
            if (outPositions[q] !== positions[p] || outPositions[q + 1] !== positions[p + 1]
              || outPositions[q + 2] !== positions[p + 2]) continue;
            if (outNormals[q] !== normals[p] || outNormals[q + 1] !== normals[p + 1]
              || outNormals[q + 2] !== normals[p + 2]) continue;
            if (wantUv && (outUvs[candidate * 2] !== uvs[uv]
              || outUvs[candidate * 2 + 1] !== uvs[uv + 1])) continue;
            found = candidate;
            break;
          }
        }
        if (found < 0) {
          found = next++;
          const out = found * 3;
          for (let k = 0; k < 3; k++) {
            const value = positions[p + k];
            outPositions[out + k] = value;
            outNormals[out + k] = normals[p + k];
            if (value < min[k]) min[k] = value;
            if (value > max[k]) max[k] = value;
          }
          if (wantUv) {
            outUvs[found * 2] = uvs[uv];
            outUvs[found * 2 + 1] = uvs[uv + 1];
          }
          if (bucket) bucket.push(found);
          else buckets.set(hash, [found]);
        }
        index[t * 3 + corner] = found;
      }
    }

    return {
      index,
      positions: outPositions.slice(0, next * 3),
      normals: outNormals.slice(0, next * 3),
      uvs: wantUv ? outUvs.slice(0, next * 2) : null,
      min,
      max,
    };
  }

  /**
   * The root node's matrix: the up axis put right, units turned into metres,
   * and any axis the viewer mirrored mirrored here too.
   *
   * A column is where one of the mesh's own axes ends up, so mirroring an axis
   * is negating its column. glTF allows that and says what it means: where the
   * determinant of a node's transform is negative, a renderer reverses the
   * winding it treats as front-facing, which is the same rule the viewer
   * follows.
   */
  function rootMatrix(upAxis, scale, flips) {
    const s = scale || 1;
    // Column-major, as glTF and WebGL both are.
    const m = upAxis === 'z'
      // Mesh +Z becomes world +Y, mesh +Y becomes world -Z.
      ? [s, 0, 0, 0, 0, 0, -s, 0, 0, s, 0, 0, 0, 0, 0, 1]
      : [s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, 0, 0, 0, 1];
    for (let axis = 0; axis < 3; axis++) {
      if (!(flips || [])[axis]) continue;
      for (let row = 0; row < 3; row++) m[axis * 4 + row] = -m[axis * 4 + row];
    }
    return m;
  }

  /**
   * One glTF material from one palette entry.
   *
   * `slots` names the texture written into each map, by index, and says
   * whether the base colour image carries an alpha channel. A bare number is
   * taken as the base colour index, which is what this used to take.
   */
  function material(entry, slots) {
    const at = typeof slots === 'number' ? { baseColor: slots } : (slots || {});
    const metallic = typeof entry.metallic === 'number'
      ? Math.min(Math.max(entry.metallic, 0), 1) : 0;
    const colour = entry.colour || [0.8, 0.8, 0.8];
    const specular = entry.specular || [0.04, 0.04, 0.04];
    const opacity = typeof entry.opacity === 'number' ? entry.opacity : 1;
    // Our palette splits a metal's colour between diffuse and reflectance;
    // glTF puts the whole thing in the base colour and flags it as metal.
    const base = metallic >= 0.999
      ? specular : colour.map((c) => Math.min(c / Math.max(1 - metallic, 1e-3), 1));

    const out = {
      name: entry.name || 'material',
      pbrMetallicRoughness: {
        baseColorFactor: [base[0], base[1], base[2], opacity],
        metallicFactor: metallic,
        roughnessFactor: typeof entry.roughness === 'number' ? entry.roughness : 0.5,
      },
      alphaMode: alphaModeOf(entry, opacity, at),
    };
    if (out.alphaMode === 'MASK' && typeof entry.alphaCutoff === 'number') {
      out.alphaCutoff = Math.min(Math.max(entry.alphaCutoff, 0), 1);
    }
    if (at.baseColor >= 0) {
      out.pbrMetallicRoughness.baseColorTexture = { index: at.baseColor };
    }
    // The maps this tool does not edit, written back exactly as they came in.
    // Nothing here is decoded or shown: an index and its image are the whole
    // of it, and a normal map that survives the round trip is the difference
    // between a shut line and a stripe painted on the panel.
    if (at.metallicRoughness >= 0) {
      out.pbrMetallicRoughness.metallicRoughnessTexture = { index: at.metallicRoughness };
    }
    if (at.normal >= 0) out.normalTexture = { index: at.normal };
    if (at.occlusion >= 0) out.occlusionTexture = { index: at.occlusion };
    // An emissive image multiplies the factor, which glTF defaults to black —
    // so passing the map through without the colour beside it writes a map
    // that can never light anything.
    const emissive = entry.emissive || (at.emissive >= 0 ? [1, 1, 1] : null);
    if (emissive && emissive.some((c) => c > 0)) {
      out.emissiveFactor = emissive.map((c) => Math.min(Math.max(c, 0), 1));
      if (at.emissive >= 0) out.emissiveTexture = { index: at.emissive };
    }
    // glTF fixes a dielectric's reflectance at 4% unless this extension says
    // otherwise. The extension defines it as 0.04 × specularColorFactor, so
    // that is what the factor is, colour and all — writing the strength
    // instead would lose a tinted reflectance and read low anywhere else.
    //
    // A factor above 1 raises the reflectance, and that is never what a source
    // file meant: a Phong highlight colour is not a Fresnel term, and taken
    // literally it makes a mirror of a painted panel — one whose albedo is
    // then cancelled in indirect light, so repainting it does nothing. The
    // factor is scaled down to its brightest channel, which keeps a dull
    // dielectric's lower reflectance and its hue while capping every material
    // at the 4% a dielectric actually has.
    if (metallic < 0.5) {
      const factor = specular.map((c) => c / 0.04);
      const peak = Math.max(factor[0], factor[1], factor[2]);
      if (peak > 1) for (let i = 0; i < 3; i++) factor[i] /= peak;
      if (factor.some((c) => c < 0.999)) {
        out.extensions = { KHR_materials_specular: { specularColorFactor: factor } };
      }
    }
    return out;
  }

  /**
   * Whether a material is drawn blended, and how.
   *
   * An opacity factor is not the only place transparency lives: a badge is a
   * decal whose texture is mostly transparent and whose factor is 1, so asking
   * the factor alone turns it into a solid rectangle stuck to the car. What
   * the file declared stands, whichever way it declared it, unless the opacity
   * has actually been edited here. A file that declared nothing at all — an
   * FBX, an .obj, a .blend, none of which have the field — is read from its
   * base colour image instead, since an alpha channel there is the only place
   * its transparency could be.
   */
  function alphaModeOf(entry, opacity, at) {
    if (opacity < OPAQUE) return 'BLEND';
    const stated = entry.alphaMode;
    if (stated === 'BLEND' || stated === 'MASK' || stated === 'OPAQUE') return stated;
    if (at.baseColorHasAlpha) return 'BLEND';
    return 'OPAQUE';
  }

  /** Whether a matrix is the identity, and so not worth writing. */
  function isIdentity(m) {
    for (let i = 0; i < 16; i++) {
      if (m[i] !== (i % 5 === 0 ? 1 : 0)) return false;
    }
    return true;
  }

  /**
   * Build a GLB.
   *
   * `meshes` are in their own local space; `nodes` is a tree that places them,
   * each naming a mesh by index or none. `images` maps a material name to
   * {bytes, mimeType, wrapS, wrapT, hasAlpha} for its base colour texture, and
   * `textures` maps a material name to the other maps it wears, each an
   * {slot, bytes, mimeType, wrapS, wrapT} passed through untouched.
   */
  function build(scene) {
    const { name = 'scene', upAxis = 'y', unitScale = 1, flips = null } = scene;
    const meshes = scene.meshes || [];
    const roots = scene.nodes || [];
    const images = scene.images instanceof Map ? scene.images : new Map();
    const extraTextures = scene.textures instanceof Map ? scene.textures : new Map();
    const drawn = meshes.reduce((sum, m) => sum + (m.mesh ? m.mesh.triangleCount : 0), 0);
    if (!drawn) throw new Error('there is no geometry to export');

    const json = {
      asset: { version: '2.0', generator: 'fbxtool' },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [],
      meshes: [],
      accessors: [],
      bufferViews: [],
      buffers: [],
      materials: [],
    };
    const chunks = [];
    let offset = 0;

    /** Append bytes to the binary chunk, keeping every view 4-byte aligned. */
    const store = (view) => {
      const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
      chunks.push(bytes);
      const at = offset;
      offset += bytes.length;
      const padding = (4 - (offset % 4)) % 4;
      if (padding) {
        chunks.push(new Uint8Array(padding));
        offset += padding;
      }
      json.bufferViews.push({ buffer: 0, byteOffset: at, byteLength: bytes.length });
      return json.bufferViews.length - 1;
    };

    const accessor = (bufferView, componentType, count, type, extra = {}) => {
      json.accessors.push(Object.assign({ bufferView, componentType, count, type }, extra));
      return json.accessors.length - 1;
    };

    /* ---- materials, written once however many meshes use them.
     *
     * A material is keyed by its name and by whether it is being used with
     * texture coordinates: glTF will not have a primitive name a texture it
     * has no coordinates for, and the same material can be used both ways. */
    const materialIndex = new Map();
    const slotIndex = new Map();
    const samplerIndex = new Map();
    const imageIndex = new Map();
    const textureIndex = new Map();

    // A sampler per pair of wrap modes rather than one shared repeat: an
    // imported sampler carries them, and a tiling tread that comes back
    // clamped is a visible change on a wheel.
    const samplerFor = (wrapS, wrapT) => {
      const s = wrapS || 10497;
      const t = wrapT || 10497;
      const key = `${s}|${t}`;
      if (samplerIndex.has(key)) return samplerIndex.get(key);
      json.samplers = json.samplers || [];
      json.samplers.push({ wrapS: s, wrapT: t });
      const index = json.samplers.length - 1;
      samplerIndex.set(key, index);
      return index;
    };

    /* One texture from one image, both stored once however many materials or
     * maps point at them: a car whose panels share a normal map should not
     * carry it twenty times. Two images are the same image when they are the
     * same bytes — the caller reads each source file once, so that holds. */
    const textureFor = (label, image) => {
      if (!image || !image.bytes || !image.bytes.length) return -1;
      let source = imageIndex.get(image.bytes);
      if (source === undefined) {
        const imageView = store(image.bytes);
        json.images = json.images || [];
        json.images.push({ name: label, bufferView: imageView, mimeType: image.mimeType });
        source = json.images.length - 1;
        imageIndex.set(image.bytes, source);
      }
      const sampler = samplerFor(image.wrapS, image.wrapT);
      const key = `${source}|${sampler}`;
      if (textureIndex.has(key)) return textureIndex.get(key);
      json.textures = json.textures || [];
      json.textures.push({ sampler, source });
      const index = json.textures.length - 1;
      textureIndex.set(key, index);
      return index;
    };

    const SLOTS = new Set(['normal', 'occlusion', 'emissive', 'metallicRoughness']);

    /** Every map a material wears, written and named by index. */
    const slotsFor = (entry) => {
      if (slotIndex.has(entry.name)) return slotIndex.get(entry.name);
      const at = {};
      const base = images.get(entry.name);
      if (base) {
        at.baseColor = textureFor(entry.name, base);
        at.baseColorHasAlpha = !!base.hasAlpha;
      }
      for (const map of extraTextures.get(entry.name) || []) {
        if (!SLOTS.has(map.slot)) continue;
        at[map.slot] = textureFor(`${entry.name} ${map.slot}`, map);
      }
      slotIndex.set(entry.name, at);
      return at;
    };

    const wearsTextures = (entry) => images.has(entry.name)
      || (extraTextures.get(entry.name) || []).length > 0;

    const materialFor = (entry, withUv) => {
      // The same material twice only when it is used both with and without
      // coordinates to sample its texture by — glTF will not have a primitive
      // name a texture it cannot sample. With no texture there is nothing to
      // tell the two apart, so there is only ever one.
      const textured = withUv && wearsTextures(entry);
      const key = `${entry.name}|${textured ? 'uv' : 'flat'}`;
      if (materialIndex.has(key)) return materialIndex.get(key);
      const index = json.materials.length;
      json.materials.push(material(entry, textured ? slotsFor(entry) : null));
      materialIndex.set(key, index);
      return index;
    };

    /* ---- meshes, each split into one primitive per material */
    let vertices = 0;
    let primitives = 0;
    const meshIndex = new Map();

    const meshFor = (which) => {
      if (meshIndex.has(which)) return meshIndex.get(which);
      const entry = meshes[which];
      const mesh = entry && entry.mesh;
      if (!mesh || !mesh.triangleCount) {
        meshIndex.set(which, -1);
        return -1;
      }
      const palette = entry.palette || [];

      // Which material each triangle belongs to, folded back to one entry per
      // material rather than one per slot.
      const groupOf = (slot) => {
        const material_ = palette[slot];
        return material_ && Number.isInteger(material_.group) ? material_.group : slot;
      };
      const byGroup = new Map();
      for (let t = 0; t < mesh.triangleCount; t++) {
        const slot = Math.round(mesh.materials[t * 3]) || 0;
        const group = palette.length ? groupOf(slot) : 0;
        let list = byGroup.get(group);
        if (!list) byGroup.set(group, (list = { slot, triangles: [] }));
        list.triangles.push(t);
      }

      const out = { primitives: [] };
      if (entry.name) out.name = entry.name;
      for (const part of byGroup.values()) {
        const paletteEntry = palette[part.slot];
        const wantUv = !!mesh.hasUv;
        const welded = weld(part.triangles, mesh, wantUv);
        vertices += welded.positions.length / 3;

        const positionView = store(welded.positions);
        json.bufferViews[positionView].target = ARRAY_BUFFER;
        const normalView = store(welded.normals);
        json.bufferViews[normalView].target = ARRAY_BUFFER;
        const indexView = store(welded.index);
        json.bufferViews[indexView].target = ELEMENT_ARRAY_BUFFER;

        const attributes = {
          POSITION: accessor(positionView, FLOAT, welded.positions.length / 3, 'VEC3',
            { min: welded.min, max: welded.max }),
          NORMAL: accessor(normalView, FLOAT, welded.normals.length / 3, 'VEC3'),
        };
        if (welded.uvs) {
          /* glTF measures V downwards from the top of a texture and FBX
           * upwards, so the coordinates are turned over on the way out — as
           * the reader turns them over on the way in, and as the kn5 reader
           * turns the game's own round for the same reason.
           *
           * The picture itself goes across untouched, which is the whole
           * reason this has to be the coordinates: one image is shared by
           * every material that names it, so turning it over would move every
           * other surface wearing it. And a tiled UV is turned over just the
           * same — 1 − 60 is off the end of the sheet, but a repeating
           * sampler lands it on the same texels the right way up. */
          const uvs = welded.uvs;
          for (let at = 1; at < uvs.length; at += 2) uvs[at] = 1 - uvs[at];
          const uvView = store(uvs);
          json.bufferViews[uvView].target = ARRAY_BUFFER;
          attributes.TEXCOORD_0 = accessor(uvView, FLOAT, uvs.length / 2, 'VEC2');
        }

        const primitive = {
          attributes,
          indices: accessor(indexView, UNSIGNED_INT, welded.index.length, 'SCALAR'),
        };
        if (paletteEntry) primitive.material = materialFor(paletteEntry, wantUv);
        out.primitives.push(primitive);
        primitives++;
      }
      json.meshes.push(out);
      const index = json.meshes.length - 1;
      meshIndex.set(which, index);
      return index;
    };

    /* ---- nodes: the tree, as it was */
    const root = { name, matrix: rootMatrix(upAxis, unitScale, flips) };
    json.nodes.push(root);

    const emit = (node) => {
      const out = {};
      if (node.name) out.name = node.name;
      if (node.matrix && !isIdentity(node.matrix)) out.matrix = Array.from(node.matrix);
      json.nodes.push(out);
      const index = json.nodes.length - 1;
      if (node.mesh !== null && node.mesh !== undefined) {
        const at = meshFor(node.mesh);
        if (at >= 0) out.mesh = at;
      }
      const children = (node.children || []).map(emit).filter((child) => child >= 0);
      if (children.length) out.children = children;
      return index;
    };

    const children = roots.map(emit);
    if (children.length) root.children = children;

    if (!json.materials.length) delete json.materials;
    const used = new Set();
    for (const m of json.materials || []) {
      for (const key of Object.keys(m.extensions || {})) used.add(key);
    }
    if (used.size) json.extensionsUsed = [...used];
    json.buffers.push({ byteLength: offset });

    // ---- container: a JSON chunk and a binary chunk, both 4-byte aligned.
    const encoder = new TextEncoder();
    let jsonBytes = encoder.encode(JSON.stringify(json));
    const jsonPadding = (4 - (jsonBytes.length % 4)) % 4;
    if (jsonPadding) {
      const padded = new Uint8Array(jsonBytes.length + jsonPadding);
      padded.set(jsonBytes);
      padded.fill(0x20, jsonBytes.length);            // spaces, as the spec says
      jsonBytes = padded;
    }

    const total = 12 + 8 + jsonBytes.length + 8 + offset;
    const glb = new ArrayBuffer(total);
    const view = new DataView(glb);
    const bytes = new Uint8Array(glb);
    view.setUint32(0, 0x46546c67, true);              // "glTF"
    view.setUint32(4, 2, true);
    view.setUint32(8, total, true);
    view.setUint32(12, jsonBytes.length, true);
    view.setUint32(16, 0x4e4f534a, true);             // "JSON"
    bytes.set(jsonBytes, 20);
    let at = 20 + jsonBytes.length;
    view.setUint32(at, offset, true);
    view.setUint32(at + 4, 0x004e4942, true);         // "BIN\0"
    at += 8;
    for (const chunk of chunks) {
      bytes.set(chunk, at);
      at += chunk.length;
    }

    // How many triangles a viewer will draw: a mesh instanced twice is drawn
    // twice, though it is stored once.
    let placed = 0;
    const count = (node) => {
      if (node.mesh !== null && node.mesh !== undefined) {
        const mesh = meshes[node.mesh] && meshes[node.mesh].mesh;
        if (mesh) placed += mesh.triangleCount;
      }
      (node.children || []).forEach(count);
    };
    roots.forEach(count);

    return {
      glb,
      // The same document taken apart, for the spelling that keeps the two
      // in separate files. The binary is a window on the chunk already
      // written rather than a second copy of it.
      json,
      binary: new Uint8Array(glb, 20 + jsonBytes.length + 8, offset),
      stats: {
        primitives,
        meshes: json.meshes.length,
        nodes: json.nodes.length,
        materials: (json.materials || []).length,
        images: (json.images || []).length,
        textures: (json.textures || []).length,
        triangles: placed,
        stored: drawn,
        vertices,
        bytes: total,
        // What actually came out, so the caller can say what did not. Names
        // are how the game finds a body panel and a wheel, and a name that
        // goes missing here goes missing there.
        materialNames: (json.materials || []).map((m) => m.name),
        nodeNames: json.nodes.slice(1).map((n) => n.name).filter(Boolean),
      },
    };
  }

  /**
   * A built document as a `.gltf` beside its `.bin`, which is the other
   * spelling of the same file.
   *
   * The JSON is the same in both; all that changes is that the buffer names
   * the file its bytes are in rather than being handed the chunk behind it.
   * Written with indentation, since the point of this spelling is that a
   * person can open it.
   */
  function separate(built, binName) {
    const json = Object.assign({}, built.json, {
      buffers: built.json.buffers.map((buffer, at) =>
        (at === 0 ? Object.assign({}, buffer, { uri: binName }) : buffer)),
    });
    return { gltf: JSON.stringify(json, null, 2), bin: built.binary };
  }

  return { build, separate, weld, rootMatrix, material };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = FbxGltf;
