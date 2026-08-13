/* Write the assembled scene out as a glTF 2.0 binary file.
 *
 * What the viewer holds is already most of a glTF: one combined mesh with a
 * material index per vertex, and a palette of resolved materials. The work is
 * in the three places the formats disagree.
 *
 * A glTF primitive has exactly one material, so the mesh is split into one
 * primitive per material. Triangles arrive unindexed — three vertices each,
 * however many they share — so each primitive is welded, which halves the
 * file. And glTF is Y-up in metres, while these files are often Z-up in
 * centimetres, so the difference goes on the root node's matrix rather than
 * into the vertex data.
 */
'use strict';

const FbxGltf = (function () {
  const FLOAT = 5126;
  const UNSIGNED_INT = 5125;
  const ARRAY_BUFFER = 34962;
  const ELEMENT_ARRAY_BUFFER = 34963;
  const OPAQUE = 0.996;

  const luminance = (rgb) => 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];

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

  /** The root node's matrix: the up axis put right, and units turned into metres. */
  function rootMatrix(upAxis, scale) {
    const s = scale || 1;
    // Column-major, as glTF and WebGL both are.
    if (upAxis === 'z') {
      // Mesh +Z becomes world +Y, mesh +Y becomes world -Z.
      return [s, 0, 0, 0, 0, 0, -s, 0, 0, s, 0, 0, 0, 0, 0, 1];
    }
    return [s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, 0, 0, 0, 1];
  }

  /** One glTF material from one palette entry. */
  function material(entry, textureIndex) {
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
      alphaMode: opacity < OPAQUE ? 'BLEND' : 'OPAQUE',
    };
    if (textureIndex >= 0) {
      out.pbrMetallicRoughness.baseColorTexture = { index: textureIndex };
    }
    // glTF fixes a dielectric's reflectance at 4% unless this extension says
    // otherwise, and it tops out at 8% — which is where our own cap lands.
    const reflectance = luminance(specular);
    if (metallic < 0.5 && Math.abs(reflectance - 0.04) > 0.005) {
      out.extensions = {
        KHR_materials_specular: {
          specularFactor: Math.min(reflectance / 0.08, 1),
        },
      };
    }
    return out;
  }

  /**
   * Build a GLB.
   *
   * `images` maps a material name to {bytes, mimeType} for its base colour
   * texture; anything missing simply exports without one.
   */
  function build(scene) {
    const { mesh, palette = [], upAxis = 'y', unitScale = 1, name = 'scene' } = scene;
    const images = scene.images instanceof Map ? scene.images : new Map();
    if (!mesh || !mesh.triangleCount) throw new Error('there is no geometry to export');

    // Which material each triangle belongs to, folded back to one entry per
    // material rather than one per slot.
    const groupOf = (slot) => {
      const entry = palette[slot];
      return entry && Number.isInteger(entry.group) ? entry.group : slot;
    };
    const byGroup = new Map();
    for (let t = 0; t < mesh.triangleCount; t++) {
      const slot = Math.round(mesh.materials[t * 3]) || 0;
      const group = palette.length ? groupOf(slot) : 0;
      let list = byGroup.get(group);
      if (!list) byGroup.set(group, (list = { slot, triangles: [] }));
      list.triangles.push(t);
    }

    const json = {
      asset: { version: '2.0', generator: 'fbxtool' },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ name, matrix: rootMatrix(upAxis, unitScale), mesh: 0 }],
      meshes: [{ name, primitives: [] }],
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

    let vertices = 0;
    for (const part of byGroup.values()) {
      const entry = palette[part.slot];
      const wantUv = !!(mesh.hasUv && entry && entry.texture);
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
        const uvView = store(welded.uvs);
        json.bufferViews[uvView].target = ARRAY_BUFFER;
        attributes.TEXCOORD_0 = accessor(uvView, FLOAT, welded.uvs.length / 2, 'VEC2');
      }

      const primitive = {
        attributes,
        indices: accessor(indexView, UNSIGNED_INT, welded.index.length, 'SCALAR'),
      };
      if (entry) {
        let textureIndex = -1;
        const image = images.get(entry.name);
        if (image && welded.uvs) {
          const imageView = store(image.bytes);
          json.images = json.images || [];
          json.images.push({ bufferView: imageView, mimeType: image.mimeType });
          json.samplers = json.samplers || [{ wrapS: 10497, wrapT: 10497 }];
          json.textures = json.textures || [];
          json.textures.push({ sampler: 0, source: json.images.length - 1 });
          textureIndex = json.textures.length - 1;
        }
        json.materials.push(material(entry, textureIndex));
        primitive.material = json.materials.length - 1;
      }
      json.meshes[0].primitives.push(primitive);
    }

    if (!json.materials.length) delete json.materials;
    const usesSpecular = (json.materials || []).some((m) => m.extensions);
    if (usesSpecular) json.extensionsUsed = ['KHR_materials_specular'];
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

    return {
      glb,
      stats: {
        primitives: json.meshes[0].primitives.length,
        materials: (json.materials || []).length,
        images: (json.images || []).length,
        triangles: mesh.triangleCount,
        vertices,
        bytes: total,
      },
    };
  }

  return { build, weld, rootMatrix, material };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = FbxGltf;
