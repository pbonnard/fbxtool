/* Read glTF 2.0 — a .glb container or a .gltf document — into the record tree
 * every other reader produces, so the report, the viewer, the material list
 * and the exporter all work on it unchanged.
 *
 * The two formats disagree about almost everything, and the mapping is where
 * the work is:
 *
 *   glTF                              here
 *   ------------------------------    ------------------------------------
 *   one primitive, one material       one Geometry and one Model each
 *   indices into shared attributes    a polygon run, every third index negated
 *   normals and UVs per vertex        layer elements mapped ByVertice
 *   a node's matrix or its TRS        Lcl Translation / Rotation / Scaling
 *   metallic-roughness               DiffuseColor, SpecularColor, Metallic
 *   Y up, metres                      declared as such in GlobalSettings
 *
 * Buffers may be inside the .glb, spelled out in a data: URI, or in a .bin
 * file beside the document — which the caller supplies, the way an .mtl or a
 * texture is supplied.
 */
'use strict';

const FbxGltfIn = (function () {
  const CLASS_SEP = '\u0000\u0001';
  const MAGIC = 0x46546c67;                     // "glTF"

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

  /** A .glb starts with its magic; a .gltf is JSON, whitespace aside. */
  function looksLikeGltf(bytes) {
    if (!bytes || bytes.length < 12) return false;
    const view = new DataView(bytes.buffer, bytes.byteOffset, Math.min(bytes.length, 12));
    if (view.getUint32(0, true) === MAGIC) return true;
    for (let i = 0; i < Math.min(bytes.length, 64); i++) {
      const c = bytes[i];
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d || c === 0xef
        || c === 0xbb || c === 0xbf) continue;
      if (c !== 0x7b) return false;              // "{"
      // Only a document that says so, so a stray JSON file is not claimed.
      const head = new TextDecoder('utf-8').decode(bytes.subarray(0, 4096));
      return /"asset"\s*:/.test(head) && /"version"\s*:\s*"2/.test(head);
    }
    return false;
  }

  /** Split a .glb into its JSON and its binary chunk. */
  function readContainer(bytes, warnings) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(0, true) !== MAGIC) {
      return { json: JSON.parse(new TextDecoder('utf-8').decode(bytes)), binary: null };
    }
    const version = view.getUint32(4, true);
    if (version !== 2) warnings.push(`glTF container version ${version}, not 2`);
    const total = view.getUint32(8, true);
    if (total !== bytes.length) {
      warnings.push(`the header says ${total} bytes, the file has ${bytes.length}`);
    }
    let json = null;
    let binary = null;
    let at = 12;
    while (at + 8 <= bytes.length) {
      const length = view.getUint32(at, true);
      const kind = view.getUint32(at + 4, true);
      const start = at + 8;
      const end = Math.min(start + length, bytes.length);
      if (kind === 0x4e4f534a) json = JSON.parse(new TextDecoder('utf-8').decode(bytes.subarray(start, end)));
      else if (kind === 0x004e4942) binary = bytes.subarray(start, end);
      at = start + length + ((4 - (length % 4)) % 4);
    }
    if (!json) throw new Error('this .glb has no JSON chunk');
    return { json, binary };
  }

  const BASE64 = /^data:[^;,]*;base64,/i;

  /** Decode a data: URI into bytes. */
  function fromDataUri(uri) {
    const comma = uri.indexOf(',');
    if (comma < 0) return null;
    if (BASE64.test(uri)) {
      const text = atob(uri.slice(comma + 1));
      const out = new Uint8Array(text.length);
      for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
      return out;
    }
    return new TextEncoder().encode(decodeURIComponent(uri.slice(comma + 1)));
  }

  const baseName = (path) => String(path).split(/[\\/]/).pop().toLowerCase();

  const COMPONENT = {
    5120: { array: Int8Array, size: 1 },
    5121: { array: Uint8Array, size: 1 },
    5122: { array: Int16Array, size: 2 },
    5123: { array: Uint16Array, size: 2 },
    5125: { array: Uint32Array, size: 4 },
    5126: { array: Float32Array, size: 4 },
  };
  const COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };

  /** An accessor's values, de-interleaved into a plain array. */
  function readAccessor(json, buffers, index, warnings) {
    const accessor = json.accessors && json.accessors[index];
    if (!accessor) return null;
    const type = COMPONENT[accessor.componentType];
    const width = COMPONENTS[accessor.type];
    if (!type || !width) {
      warnings.push(`accessor ${index} has a component type this reader does not know`);
      return null;
    }
    // An accessor with neither a view nor a sparse override has nothing behind
    // it — which is how a compressed file describes what it took away. Reading
    // it as zeros would build a mesh with every vertex at the origin: present,
    // counted, and invisible.
    if (accessor.bufferView === undefined && !accessor.sparse) {
      warnings.push(`accessor ${index} has no data behind it`);
      return null;
    }
    const out = new Array(accessor.count * width).fill(0);
    const view = accessor.bufferView !== undefined
      ? json.bufferViews[accessor.bufferView] : null;
    if (view) {
      const bytes = buffers[view.buffer || 0];
      if (!bytes) {
        warnings.push('a buffer this file names was not supplied');
        return null;
      }
      const stride = view.byteStride || width * type.size;
      const base = (view.byteOffset || 0) + (accessor.byteOffset || 0);
      for (let i = 0; i < accessor.count; i++) {
        const at = base + i * stride;
        if (at + width * type.size > bytes.byteLength) break;
        const slice = new type.array(bytes.buffer, bytes.byteOffset + at, width);
        for (let k = 0; k < width; k++) out[i * width + k] = slice[k];
      }
    }
    // A sparse accessor overrides some of what the view holds.
    if (accessor.sparse) {
      const { count, indices, values } = accessor.sparse;
      const indexType = COMPONENT[indices.componentType];
      const indexView = json.bufferViews[indices.bufferView];
      const valueView = json.bufferViews[values.bufferView];
      const indexBytes = buffers[indexView.buffer || 0];
      const valueBytes = buffers[valueView.buffer || 0];
      if (indexType && indexBytes && valueBytes) {
        const at = new indexType.array(indexBytes.buffer,
          indexBytes.byteOffset + (indexView.byteOffset || 0) + (indices.byteOffset || 0), count);
        const to = new type.array(valueBytes.buffer,
          valueBytes.byteOffset + (valueView.byteOffset || 0) + (values.byteOffset || 0),
          count * width);
        for (let i = 0; i < count; i++) {
          for (let k = 0; k < width; k++) out[at[i] * width + k] = to[i * width + k];
        }
      }
    }
    return out;
  }

  /* ------------------------------------------------------------ transforms */

  /** Euler angles in degrees for R = Rz * Ry * Rx, which is FBX's XYZ order. */
  function eulerFromMatrix(m) {
    // Column-major, the upper-left 3x3 with any scale divided out first.
    const scale = [0, 1, 2].map((c) => Math.hypot(m[c * 4], m[c * 4 + 1], m[c * 4 + 2]) || 1);
    const r = [0, 1, 2].map((c) => [0, 1, 2].map((k) => m[c * 4 + k] / scale[c]));
    const sy = -r[0][2];
    const clamp = Math.min(1, Math.max(-1, sy));
    const y = Math.asin(clamp);
    let x;
    let z;
    if (Math.abs(clamp) < 0.999999) {
      x = Math.atan2(r[1][2], r[2][2]);
      z = Math.atan2(r[0][1], r[0][0]);
    } else {
      x = Math.atan2(-r[2][1], r[1][1]);
      z = 0;
    }
    const degrees = 180 / Math.PI;
    return { rotation: [x * degrees, y * degrees, z * degrees], scale };
  }

  /** A node's placement, however it was written. */
  function placementOf(gltfNode) {
    if (Array.isArray(gltfNode.matrix) && gltfNode.matrix.length === 16) {
      const m = gltfNode.matrix;
      const { rotation, scale } = eulerFromMatrix(m);
      return { translation: [m[12], m[13], m[14]], rotation, scale };
    }
    const t = gltfNode.translation || [0, 0, 0];
    const s = gltfNode.scale || [1, 1, 1];
    const q = gltfNode.rotation || [0, 0, 0, 1];
    // Quaternion to the same rotation matrix, then to Euler.
    const [x, y, z, w] = q;
    const m = [
      1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 0,
      2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 0,
      2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y), 0,
      0, 0, 0, 1,
    ];
    return { translation: t, rotation: eulerFromMatrix(m).rotation, scale: s };
  }

  /**
   * A Draco-compressed primitive, decompressed into the same arrays the plain
   * path reads from accessors.
   *
   * The block holds the whole primitive — its triangles and every attribute —
   * so the accessors are only consulted for which unique id is which
   * attribute. What comes back is copied out of the module's memory before it
   * is handed anything else to do.
   */
  function decompress(json, buffers, draco, warnings) {
    const view = (json.bufferViews || [])[draco.bufferView];
    const bytes = view ? buffers[view.buffer || 0] : null;
    if (!view || !bytes) {
      warnings.push('a Draco block points at a buffer that was not supplied');
      return null;
    }
    const start = view.byteOffset || 0;
    const block = bytes.subarray(start, start + view.byteLength);

    const mark = FbxWasm.mark();
    try {
      const out = FbxWasm.decodeDraco(block);
      const take = (name, components) => {
        const id = (draco.attributes || {})[name];
        if (id === undefined) return null;
        const found = out.attributes.find((a) => a.uniqueId === id);
        if (!found) {
          warnings.push(`a Draco block has no ${name} where the file says it does`);
          return null;
        }
        if (components && found.components !== components) return null;
        return found.values.slice();          // out of the module's memory
      };
      return {
        positions: take('POSITION', 3),
        normals: take('NORMAL', 3),
        uvs: take('TEXCOORD_0', 2),
        indices: Array.from(out.indices),
        vertexCount: out.numPoints,
      };
    } catch (error) {
      warnings.push(`a Draco block would not decompress: ${error.message}`);
      return null;
    } finally {
      FbxWasm.release(mark);
    }
  }

  /* --------------------------------------------------------------- reading */

  /**
   * Parse a glTF document or container.
   *
   * `options.files` maps a lowercased basename to bytes, for the `.bin` and
   * images a `.gltf` refers to by name.
   */
  function parse(bytes, options = {}) {
    const warnings = [];
    const supplied = options.files || new Map();
    const { json, binary } = readContainer(bytes, warnings);
    if (!json.asset || !/^2\./.test(String(json.asset.version || ''))) {
      warnings.push(`glTF version ${json.asset && json.asset.version} — this reads 2.x`);
    }

    // Buffers: the container's own, a data: URI, or a file dropped alongside.
    const buffers = (json.buffers || []).map((buffer, index) => {
      if (buffer.uri === undefined) return binary;
      if (/^data:/i.test(buffer.uri)) return fromDataUri(buffer.uri);
      const file = supplied.get(baseName(buffer.uri));
      if (!file) {
        warnings.push(`buffer ${index} is in ${buffer.uri}, which was not supplied`
          + ' — drop it in beside the model');
        return null;
      }
      return file;
    });

    const objects = [];
    const connections = [];
    let nextUid = 1000;
    const uid = () => ++nextUid;

    /* ---- materials */
    const materialUids = (json.materials || []).map((material, index) => {
      const id = uid();
      const pbr = material.pbrMetallicRoughness || {};
      const base = pbr.baseColorFactor || [0.8, 0.8, 0.8, 1];
      const metallic = pbr.metallicFactor === undefined ? 1 : pbr.metallicFactor;
      const roughness = pbr.roughnessFactor === undefined ? 1 : pbr.roughnessFactor;
      // Metal takes its reflectance from the base colour, a dielectric 4% —
      // unless KHR_materials_specular says otherwise, which is the one place
      // glTF records a reflectance of its own.
      const extension = (material.extensions || {}).KHR_materials_specular || {};
      const tint = extension.specularColorFactor || [1, 1, 1];
      const strength = extension.specularFactor === undefined ? 1 : extension.specularFactor;
      const specular = [0, 1, 2].map((k) =>
        0.04 * tint[k] * strength * (1 - metallic) + base[k] * metallic);
      const diffuse = [0, 1, 2].map((k) => base[k] * (1 - metallic));
      const props = [
        p70('DiffuseColor', 'Color', ...diffuse.map(D)),
        p70('SpecularColor', 'Color', ...specular.map(D)),
        // Roughness back to the exponent an FBX material carries.
        p70('ShininessExponent', 'Number',
          D(2 / Math.max(roughness * roughness, 1e-4) - 2)),
        p70('Metallic', 'Number', D(metallic)),
        p70('Opacity', 'Number',
          D(material.alphaMode === 'BLEND' && base[3] !== undefined ? base[3] : 1)),
      ];
      objects.push(node('Material',
        [L(id), S(`${material.name || `material${index}`}${CLASS_SEP}Material`), S('')], [
          node('Version', [I(102)]),
          node('ShadingModel', [S('phong')]),
          node('Properties70', [], props),
        ]));

      // The base colour image, wherever it lives.
      const textureIndex = pbr.baseColorTexture && pbr.baseColorTexture.index;
      const texture = textureIndex !== undefined && json.textures
        ? json.textures[textureIndex] : null;
      // A texture names its image directly, or through the extension that
      // says the image is a KTX2 rather than a PNG.
      const source = texture
        ? (texture.source !== undefined ? texture.source
          : ((texture.extensions || {}).KHR_texture_basisu || {}).source)
        : undefined;
      const image = source !== undefined && json.images ? json.images[source] : null;
      if (image) {
        const textureUid = uid();
        const videoUid = uid();
        // An image spelled out in the document itself has no file name.
        const filename = image.uri && !/^data:/i.test(image.uri) ? image.uri : '';
        const name = image.name || filename || `image${source}`;
        objects.push(node('Texture', [L(textureUid), S(`${name}${CLASS_SEP}Texture`), S('')], [
          node('Type', [S('TextureVideoClip')]),
          node('Version', [I(202)]),
          node('FileName', [S(filename)]),
          node('RelativeFilename', [S(filename)]),
        ]));
        const video = [
          node('Type', [S('Clip')]),
          node('FileName', [S(filename)]),
          node('RelativeFilename', [S(filename)]),
        ];
        // An image inside the container travels with it, as embedded content.
        let content = null;
        if (image.bufferView !== undefined && json.bufferViews) {
          const view = json.bufferViews[image.bufferView];
          const bytesFor = buffers[view.buffer || 0];
          if (bytesFor) {
            content = bytesFor.subarray(view.byteOffset || 0,
              (view.byteOffset || 0) + view.byteLength);
          }
        } else if (image.uri && /^data:/i.test(image.uri)) {
          content = fromDataUri(image.uri);
        }
        if (content && content.length) {
          video.push(node('Content', [{ code: 'R', typeName: 'raw', value: content }]));
        }
        objects.push(node('Video', [L(videoUid), S(`${name}${CLASS_SEP}Video`), S('Clip')], video));
        connections.push(node('C', [S('OP'), L(textureUid), L(id), S('DiffuseColor')]));
        connections.push(node('C', [S('OO'), L(videoUid), L(textureUid)]));
      }
      return id;
    });

    /* ---- meshes: one Geometry and one Model per primitive */
    let triangleless = 0;
    let compressed = 0;
    const meshParts = (json.meshes || []).map((mesh, meshIndex) =>
      (mesh.primitives || []).map((primitive, primitiveIndex) => {
        const mode = primitive.mode === undefined ? 4 : primitive.mode;
        if (mode !== 4) {
          warnings.push(`mesh ${meshIndex} uses drawing mode ${mode}, which this reader `
            + 'does not turn into polygons');
          return null;
        }
        // Draco replaces the vertex streams with a compressed block of its
        // own: the accessors it leaves behind describe a mesh that is not
        // there, so everything comes out of the block instead.
        const draco = (primitive.extensions || {}).KHR_draco_mesh_compression;
        const decoded = draco ? decompress(json, buffers, draco, warnings) : null;
        if (draco && !decoded) {
          compressed++;
          return null;
        }

        const positions = decoded ? decoded.positions
          : readAccessor(json, buffers, primitive.attributes.POSITION, warnings);
        if (!positions || !positions.length) return null;

        const vertexCount = positions.length / 3;
        let indices = decoded ? decoded.indices
          : (primitive.indices !== undefined
            ? readAccessor(json, buffers, primitive.indices, warnings) : null);
        if (!indices) {
          indices = new Array(vertexCount);
          for (let i = 0; i < vertexCount; i++) indices[i] = i;
        }
        if (indices.length < 3) {
          triangleless++;
          return null;
        }
        // A polygon run, as FBX writes it: the last corner of each triangle
        // is stored as its complement.
        const polygons = new Array(indices.length);
        for (let i = 0; i + 2 < indices.length; i += 3) {
          polygons[i] = indices[i];
          polygons[i + 1] = indices[i + 1];
          polygons[i + 2] = ~indices[i + 2];
        }

        const geometry = [
          node('Vertices', [array('d', positions)]),
          node('PolygonVertexIndex', [array('i', polygons)]),
          node('GeometryVersion', [I(124)]),
        ];
        const normals = decoded ? decoded.normals
          : (primitive.attributes.NORMAL !== undefined
            ? readAccessor(json, buffers, primitive.attributes.NORMAL, warnings) : null);
        if (normals && normals.length === positions.length) {
          geometry.push(node('LayerElementNormal', [I(0)], [
            node('Version', [I(101)]),
            node('MappingInformationType', [S('ByVertice')]),
            node('ReferenceInformationType', [S('Direct')]),
            node('Normals', [array('d', normals)]),
          ]));
        }
        const uvs = decoded ? decoded.uvs
          : (primitive.attributes.TEXCOORD_0 !== undefined
            ? readAccessor(json, buffers, primitive.attributes.TEXCOORD_0, warnings) : null);
        if (uvs && uvs.length === vertexCount * 2) {
          // glTF measures V downwards from the top; FBX upwards.
          const flipped = new Array(uvs.length);
          for (let i = 0; i < uvs.length; i += 2) {
            flipped[i] = uvs[i];
            flipped[i + 1] = 1 - uvs[i + 1];
          }
          geometry.push(node('LayerElementUV', [I(0)], [
            node('Version', [I(101)]),
            node('Name', [S('map1')]),
            node('MappingInformationType', [S('ByVertice')]),
            node('ReferenceInformationType', [S('Direct')]),
            node('UV', [array('d', flipped)]),
          ]));
        }
        geometry.push(node('LayerElementMaterial', [I(0)], [
          node('Version', [I(101)]),
          node('MappingInformationType', [S('AllSame')]),
          node('ReferenceInformationType', [S('IndexToDirect')]),
          node('Materials', [array('i', [0])]),
        ]));
        geometry.push(node('Layer', [I(0)], [node('Version', [I(100)])]));

        const label = mesh.name || `mesh${meshIndex}`;
        const suffix = (mesh.primitives || []).length > 1 ? `/${primitiveIndex}` : '';
        const geometryUid = uid();
        objects.push(node('Geometry',
          [L(geometryUid), S(`${label}${suffix}${CLASS_SEP}Geometry`), S('Mesh')], geometry));
        return { geometryUid, material: primitive.material, label: label + suffix };
      }).filter(Boolean));

    /* ---- nodes: the hierarchy, and where each mesh sits in it */
    const nodeUids = (json.nodes || []).map(() => uid());
    (json.nodes || []).forEach((gltfNode, index) => {
      const id = nodeUids[index];
      const { translation, rotation, scale } = placementOf(gltfNode);
      const props = [
        p70('Lcl Translation', 'Lcl Translation', ...translation.map(D)),
        p70('Lcl Rotation', 'Lcl Rotation', ...rotation.map(D)),
        p70('Lcl Scaling', 'Lcl Scaling', ...scale.map(D)),
      ];
      const parts = gltfNode.mesh !== undefined ? (meshParts[gltfNode.mesh] || []) : [];
      objects.push(node('Model',
        [L(id), S(`${gltfNode.name || `node${index}`}${CLASS_SEP}Model`),
          S(parts.length ? 'Mesh' : 'Null')], [
          node('Version', [I(232)]),
          node('Properties70', [], props),
        ]));

      // A node with several primitives becomes one model per primitive, each
      // hanging off it, so every one keeps its own material.
      parts.forEach((part, at) => {
        let owner = id;
        if (parts.length > 1) {
          owner = uid();
          objects.push(node('Model',
            [L(owner), S(`${part.label}${CLASS_SEP}Model`), S('Mesh')], [
              node('Version', [I(232)]),
              node('Properties70', [], []),
            ]));
          connections.push(node('C', [S('OO'), L(owner), L(id)]));
        }
        connections.push(node('C', [S('OO'), L(part.geometryUid), L(owner)]));
        if (part.material !== undefined && materialUids[part.material] !== undefined) {
          connections.push(node('C', [S('OO'), L(materialUids[part.material]), L(owner)]));
        }
        if (at > 0 && parts.length === 1) warnings.push('a node names more than one mesh');
      });
    });

    (json.nodes || []).forEach((gltfNode, index) => {
      for (const child of gltfNode.children || []) {
        if (nodeUids[child] !== undefined) {
          connections.push(node('C', [S('OO'), L(nodeUids[child]), L(nodeUids[index])]));
        }
      }
    });
    // Whatever the scene lists at the top level hangs off the root.
    const scene = json.scenes && json.scenes[json.scene === undefined ? 0 : json.scene];
    for (const root of (scene && scene.nodes) || []) {
      if (nodeUids[root] !== undefined) {
        connections.push(node('C', [S('OO'), L(nodeUids[root]), L(0)]));
      }
    }
    if (triangleless) warnings.push(`${triangleless} primitive(s) held no triangles`);
    if (compressed) {
      warnings.push(`${compressed} mesh part(s) are compressed with Draco and `
        + 'would not decompress, so their geometry is missing');
    }

    /* ---- the document */
    const generator = (json.asset && json.asset.generator) || 'glTF 2.0';
    const root = { name: '', props: [], children: [] };
    root.children.push(node('FBXHeaderExtension', [], [
      node('FBXVersion', [I(7400)]),
      node('Creator', [S(generator)]),
    ]));
    root.children.push(node('Creator', [S(generator)]));
    root.children.push(node('GlobalSettings', [], [
      node('Version', [I(1000)]),
      node('Properties70', [], [
        // glTF is Y up, right handed, in metres.
        node('P', [S('UpAxis'), S('int'), S('Integer'), S(''), I(1)]),
        node('P', [S('UpAxisSign'), S('int'), S('Integer'), S(''), I(1)]),
        node('P', [S('FrontAxis'), S('int'), S('Integer'), S(''), I(2)]),
        node('P', [S('FrontAxisSign'), S('int'), S('Integer'), S(''), I(1)]),
        node('P', [S('CoordAxis'), S('int'), S('Integer'), S(''), I(0)]),
        node('P', [S('CoordAxisSign'), S('int'), S('Integer'), S(''), I(1)]),
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
      format: 'gltf',
      encoding: binary ? 'binary' : 'text',
      version: null,
      versionSource: null,
      wideOffsets: false,
      hasFooter: false,
      footerVersion: null,
      warnings,
      extra: {
        generator,
        gltfVersion: (json.asset && json.asset.version) || '',
        meshes: (json.meshes || []).length,
        primitives: meshParts.reduce((sum, parts) => sum + parts.length, 0),
        nodes: (json.nodes || []).length,
        materials: (json.materials || []).length,
        images: (json.images || []).length,
        buffers: (json.buffers || []).length,
        extensions: json.extensionsUsed || [],
      },
    };
  }

  return { looksLikeGltf, parse, eulerFromMatrix, placementOf, readContainer };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = FbxGltfIn;
