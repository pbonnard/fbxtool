/* Reader for COLLADA `.dae`, the format BeamNG.drive ships its cars in.
 *
 * Mirrors fbxtool/dae.py: the file is normalised into the same record tree the
 * FBX readers produce, so the report, the analysis and the WebAssembly
 * geometry pipeline all apply without knowing which format was loaded. The two
 * are held to each other record for record in `tests/test_web.py`, over every
 * `.dae` the game ships.
 *
 * The XML is scanned here rather than handed to `DOMParser`, for two reasons.
 * The page runs its readers under Node as well as in a browser, and Node has
 * no DOM; and a document is one element deep in places and thirty megabytes of
 * ASCII numbers in others, so what is wanted is a scan that leaves the big
 * text where it is and only reads it when something asks. What COLLADA
 * exporters write is a narrow subset — elements, attributes, text, comments —
 * and that is what this reads, refusing anything it does not recognise rather
 * than guessing at it.
 *
 * What a surface is does not live in the model: a BeamNG `.dae` carries a
 * lambert stub and names one image for a car's eighty-odd, and the materials
 * proper are in a `*.materials.json` beside it. That file is read where it is
 * supplied — with the model, before it, or dropped in afterwards.
 */
'use strict';

const FbxDae = (function () {
  //: What every COLLADA document opens with, whatever wrote it.
  const SCHEMA = 'collada.org/2005/11/COLLADASchema';

  function looksLikeDae(text) {
    const head = text.slice(0, 8192);
    return head.includes('<COLLADA') && head.includes(SCHEMA);
  }

  /* ------------------------------------------------------------------ XML */

  const ENTITIES = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  };

  /** A string with its entities resolved, which most of them have none of. */
  function unescape(text) {
    if (text.indexOf('&') < 0) return text;
    return text.replace(/&(#x?[0-9a-fA-F]+|\w+);/g, (whole, body) => {
      if (body[0] === '#') {
        const code = body[1] === 'x' || body[1] === 'X'
          ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
      }
      return ENTITIES[body] !== undefined ? ENTITIES[body] : whole;
    });
  }

  /**
   * The attributes of one start tag, by name with the namespace left on.
   *
   * COLLADA's own attributes carry no prefix, and the ones that do — the
   * schema declarations — are not read, so nothing here has to take one off.
   */
  function attributes(source, from, to) {
    const out = {};
    const re = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
    re.lastIndex = from;
    let match;
    while ((match = re.exec(source)) !== null && match.index < to) {
      const value = match[3] !== undefined ? match[3] : match[4];
      out[match[1]] = unescape(value);
    }
    return out;
  }

  /**
   * A document as a tree of `{ name, attrs, text, children }`.
   *
   * *name* has its namespace taken off, since a COLLADA element is the same
   * element whichever prefix the file bound the schema to.
   */
  function parseXml(source) {
    const root = { name: '#document', attrs: {}, text: '', children: [] };
    const stack = [root];
    let at = 0;
    while (at < source.length) {
      const open = source.indexOf('<', at);
      if (open < 0) break;
      if (open > at) {
        // Text belongs to whatever element is open; whitespace between two
        // elements is not text anybody wants.
        const raw = source.slice(at, open);
        const top = stack[stack.length - 1];
        if (raw.trim()) top.text += raw;
      }
      if (source.startsWith('<!--', open)) {
        const end = source.indexOf('-->', open + 4);
        at = end < 0 ? source.length : end + 3;
        continue;
      }
      if (source.startsWith('<![CDATA[', open)) {
        const end = source.indexOf(']]>', open + 9);
        const stop = end < 0 ? source.length : end;
        stack[stack.length - 1].text += source.slice(open + 9, stop);
        at = end < 0 ? source.length : end + 3;
        continue;
      }
      if (source.startsWith('<?', open) || source.startsWith('<!', open)) {
        // The XML declaration, and a doctype nobody here reads.
        const end = source.indexOf('>', open + 2);
        at = end < 0 ? source.length : end + 1;
        continue;
      }
      const close = source.indexOf('>', open + 1);
      if (close < 0) break;
      if (source[open + 1] === '/') {
        if (stack.length > 1) stack.pop();
        at = close + 1;
        continue;
      }
      const selfClosing = source[close - 1] === '/';
      const inner = source.slice(open + 1, selfClosing ? close - 1 : close);
      const space = inner.search(/[\s/]/);
      const full = space < 0 ? inner : inner.slice(0, space);
      const name = full.includes(':') ? full.slice(full.indexOf(':') + 1) : full;
      const element = {
        name,
        attrs: space < 0 ? {} : attributes(source, open + 1 + space, close),
        text: '',
        children: [],
      };
      stack[stack.length - 1].children.push(element);
      if (!selfClosing) stack.push(element);
      at = close + 1;
    }
    return root;
  }

  const find = (element, name) =>
    (element ? element.children.find((child) => child.name === name) : undefined) || null;
  const findAll = (element, name) =>
    (element ? element.children.filter((child) => child.name === name) : []);

  /** The whitespace-separated numbers in an array's body, or nothing. */
  function numbers(text) {
    if (!text) return [];
    const parts = text.split(/\s+/);
    const out = [];
    for (let i = 0; i < parts.length; i++) {
      if (!parts[i]) continue;
      out.push(Number(parts[i]));
    }
    return out;
  }

  function indices(text) {
    if (!text) return [];
    const parts = text.split(/\s+/);
    const out = new Array(parts.length);
    let n = 0;
    for (let i = 0; i < parts.length; i++) {
      if (!parts[i]) continue;
      out[n++] = parts[i] | 0;
    }
    out.length = n;
    return out;
  }

  /* ------------------------------------------------------------- geometry */

  /**
   * Every `<source>` of a mesh, by id.
   *
   * The stride comes from the `<accessor>` rather than being assumed: a
   * position source counts three to a vertex and a texture coordinate two, and
   * a file is free to write a third that nothing reads.
   */
  function readSources(mesh) {
    const out = new Map();
    for (const source of findAll(mesh, 'source')) {
      const ident = source.attrs.id;
      if (!ident) continue;
      const array = find(source, 'float_array');
      const technique = find(source, 'technique_common');
      const accessor = technique ? find(technique, 'accessor') : null;
      let stride = 1;
      if (accessor && accessor.attrs.stride) {
        const stated = parseInt(accessor.attrs.stride, 10);
        stride = Number.isFinite(stated) && stated > 0 ? stated : 1;
      }
      out.set(ident, { values: numbers(array ? array.text : ''), stride });
    }
    return out;
  }

  /**
   * Which source each `<vertices>` element stands for.
   *
   * A primitive names a `<vertices>` id rather than a source, and that element
   * holds the POSITION input pointing at the source proper. It is one hop and
   * it is always there, so it is followed rather than guessed past.
   */
  function vertexSources(mesh) {
    const out = new Map();
    for (const vertices of findAll(mesh, 'vertices')) {
      const ident = vertices.attrs.id;
      if (!ident) continue;
      for (const input of findAll(vertices, 'input')) {
        if (input.attrs.semantic === 'POSITION') {
          out.set(ident, String(input.attrs.source || '').replace(/^#/, ''));
        }
      }
    }
    return out;
  }

  /**
   * The drawable runs of a mesh, in the order the file writes them.
   *
   * `<triangles>` states no `vcount` because every polygon of it is three
   * corners; the two are otherwise the same record and are read as one.
   */
  function readPrimitives(mesh) {
    const out = [];
    for (const element of mesh.children) {
      if (element.name !== 'polylist' && element.name !== 'triangles') continue;
      const primitive = {
        material: element.attrs.material || '',
        p: indices(find(element, 'p') ? find(element, 'p').text : ''),
        inputs: new Map(),
        stride: 1,
        vcount: [],
      };
      let highest = 0;
      for (const input of findAll(element, 'input')) {
        const semantic = input.attrs.semantic || '';
        const stated = parseInt(input.attrs.offset || '0', 10);
        const offset = Number.isFinite(stated) ? stated : 0;
        if (offset > highest) highest = offset;
        // A file may state several UV sets; the first is the one drawn.
        if (primitive.inputs.has(semantic)) continue;
        primitive.inputs.set(semantic,
          [offset, String(input.attrs.source || '').replace(/^#/, '')]);
      }
      primitive.stride = highest + 1;
      if (element.name === 'triangles') {
        const corners = Math.floor(primitive.p.length / primitive.stride);
        primitive.vcount = new Array(Math.floor(corners / 3)).fill(3);
      } else {
        const counts = find(element, 'vcount');
        primitive.vcount = indices(counts ? counts.text : '');
      }
      out.push(primitive);
    }
    return out;
  }

  /** One `<geometry>` turned into arrays, or null where it draws nothing. */
  function buildMesh(geometry, paletteOf) {
    const meshElement = find(geometry, 'mesh');
    if (!meshElement) return null;
    const sources = readSources(meshElement);
    const vertices = vertexSources(meshElement);
    const primitives = readPrimitives(meshElement);
    if (!primitives.length) return null;

    // The position source is the one every primitive agrees on, and it is what
    // the polygon indices count against, so it is taken once for the geometry.
    let positionId = '';
    for (const primitive of primitives) {
      const entry = primitive.inputs.get('VERTEX');
      if (!entry) continue;
      positionId = vertices.has(entry[1]) ? vertices.get(entry[1]) : entry[1];
      if (positionId) break;
    }
    const positions = sources.get(positionId);
    if (!positions || !positions.values.length) return null;

    const mesh = {
      positions: positions.values,
      polygons: [],
      normals: [],
      faceNormals: [],
      uvs: [],
      faceUvs: [],
      faceMaterials: [],
      triangles: 0,
      polygonCount: 0,
    };

    for (const primitive of primitives) {
      const vertex = primitive.inputs.get('VERTEX');
      if (!vertex || !primitive.vcount.length) continue;
      const normal = primitive.inputs.get('NORMAL') || null;
      const texcoord = primitive.inputs.get('TEXCOORD') || null;
      const normalSource = normal ? sources.get(normal[1]) : null;
      const uvSource = texcoord ? sources.get(texcoord[1]) : null;
      // Each source's numbers are appended once, and the indices that follow
      // are moved along by however many entries stood in front of them.
      const normalBase = Math.floor(mesh.normals.length / 3);
      const uvBase = Math.floor(mesh.uvs.length / 2);
      if (normalSource) {
        for (let i = 0; i < normalSource.values.length; i++) {
          mesh.normals.push(normalSource.values[i]);
        }
      }
      if (uvSource) {
        for (let i = 0; i < uvSource.values.length; i++) mesh.uvs.push(uvSource.values[i]);
      }

      const slot = paletteOf(primitive.material);
      const stride = primitive.stride;
      let at = 0;
      for (let face = 0; face < primitive.vcount.length; face++) {
        const count = primitive.vcount[face];
        if (count < 3 || (at + count) * stride > primitive.p.length) {
          at += count;
          continue;
        }
        for (let corner = 0; corner < count; corner++) {
          const base = (at + corner) * stride;
          const index = primitive.p[base + vertex[0]];
          // The last corner of a polygon is written as its complement, which
          // is how the run says where one ends and the next starts.
          mesh.polygons.push(corner === count - 1 ? ~index : index);
          if (normal && normalSource) {
            mesh.faceNormals.push(normalBase + primitive.p[base + normal[0]]);
          } else if (mesh.normals.length) mesh.faceNormals.push(-1);
          if (texcoord && uvSource) {
            mesh.faceUvs.push(uvBase + primitive.p[base + texcoord[0]]);
          } else if (mesh.uvs.length) mesh.faceUvs.push(-1);
        }
        mesh.faceMaterials.push(slot);
        mesh.polygonCount += 1;
        mesh.triangles += count - 2;
        at += count;
      }
    }
    return mesh.polygons.length ? mesh : null;
  }

  /* ------------------------------------------------------------ placement */

  /** Two row-major 4x4 matrices, in the order they are written. */
  function multiply(a, b) {
    const out = new Array(16).fill(0);
    for (let row = 0; row < 4; row++) {
      for (let column = 0; column < 4; column++) {
        let sum = 0;
        for (let k = 0; k < 4; k++) sum += a[row * 4 + k] * b[k * 4 + column];
        out[row * 4 + column] = sum;
      }
    }
    return out;
  }

  /**
   * A COLLADA matrix as translation, Euler rotation in degrees, and scale.
   *
   * The matrix is sixteen numbers in row-major order acting on column vectors,
   * so the translation is the last *column* — elements 3, 7 and 11 — and not
   * the last row, which is where a Direct3D matrix keeps it. Read the other
   * way round every part of a car lands at the origin.
   */
  function decompose(m) {
    if (!m || m.length !== 16) return { translation: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };
    const translation = [m[3], m[7], m[11]];
    const columns = [
      [m[0], m[4], m[8]],
      [m[1], m[5], m[9]],
      [m[2], m[6], m[10]],
    ];
    const scale = columns.map((c) => Math.sqrt(c[0] * c[0] + c[1] * c[1] + c[2] * c[2]) || 1);
    const basis = columns.map((c, i) => c.map((v) => v / scale[i]));
    // A negative determinant is a mirror, and it is kept as a negative scale
    // rather than turned into a rotation that would come back inside out.
    const determinant =
      basis[0][0] * (basis[1][1] * basis[2][2] - basis[1][2] * basis[2][1])
      - basis[1][0] * (basis[0][1] * basis[2][2] - basis[0][2] * basis[2][1])
      + basis[2][0] * (basis[0][1] * basis[1][2] - basis[0][2] * basis[1][1]);
    if (determinant < 0) {
      scale[0] = -scale[0];
      basis[0] = basis[0].map((v) => -v);
    }
    const m00 = basis[0][0]; const m10 = basis[0][1]; const m20 = basis[0][2];
    const m11 = basis[1][1]; const m21 = basis[1][2];
    const m12 = basis[2][1]; const m22 = basis[2][2];
    let x; let y; let z;
    if (Math.abs(m20) < 1 - 1e-6) {
      y = Math.asin(-m20);
      x = Math.atan2(m21, m22);
      z = Math.atan2(m10, m00);
    } else {                                 // looking straight up or down
      y = m20 < 0 ? Math.PI / 2 : -Math.PI / 2;
      x = Math.atan2(-m12, m11);
      z = 0;
    }
    // Adding zero settles the sign of one: a turn of -0 degrees is a turn of
    // none, and the two readers here would otherwise write it differently for
    // no difference in the model.
    const degrees = (v) => (v * 180) / Math.PI + 0;
    return {
      translation: translation.map((v) => v + 0),
      rotation: [degrees(x), degrees(y), degrees(z)],
      scale: scale.map((v) => v + 0),
    };
  }

  /**
   * Every node under an element, with the matrix that places it.
   *
   * A node states its own placement and inherits its parent's, so the two are
   * multiplied on the way down.
   */
  function walk(element, matrix, out, depth = 0) {
    if (depth > 256) throw new Error('the node tree is nested more than 256 deep');
    for (const child of element.children) {
      if (child.name !== 'node') continue;
      let here = matrix;
      for (const placement of child.children) {
        if (placement.name !== 'matrix') continue;
        const values = numbers(placement.text);
        if (values.length === 16) here = multiply(here, values);
      }
      out.push([child, here]);
      walk(child, here, out, depth + 1);
    }
  }

  /* ------------------------------------------------------------- material */

  /** A `profile_COMMON` effect's diffuse colour, where it states one flat. */
  function colourOf(effect) {
    const profile = find(effect, 'profile_COMMON');
    if (!profile) return null;
    const technique = find(profile, 'technique');
    if (!technique) return null;
    for (const shading of ['lambert', 'phong', 'blinn', 'constant']) {
      const model = find(technique, shading);
      if (!model) continue;
      const diffuse = find(model, 'diffuse');
      if (!diffuse) continue;
      const colour = find(diffuse, 'color');
      if (!colour) return null;
      const values = numbers(colour.text);
      return values.length >= 3 ? [values[0], values[1], values[2]] : null;
    }
    return null;
  }

  /* ------------------------------------------------------- what it wears */

  /* What a BeamNG stage calls each thing, by what it means here. The game
   * writes two generations of material and a car may hold both: the newer one
   * states a base colour and a roughness the way glTF does, and the older one
   * a colour map and a Blinn-Phong specular, the way Torque3D always did. */
  const STAGE_MAPS = [
    ['baseColorMap', 'DiffuseColor'],
    ['colorMap', 'DiffuseColor'],          // the older generation's diffuse
    ['normalMap', 'NormalMap'],
    ['ambientOcclusionMap', 'AmbientOcclusion'],
    ['emissiveMap', 'EmissiveColor'],
  ];

  /**
   * What a car's `*.materials.json` says, by the material name it is for.
   *
   * `mapTo` is the name the model is expected to use and `name` is the
   * material's own; they are the same in 2,796 of the 2,861 entries in the
   * game, and where they differ it is `mapTo` that the model said. Both are
   * keyed, the first to claim a name keeping it.
   */
  function dressingFrom(texts) {
    const out = new Map();
    for (const text of texts) {
      let data = null;
      try { data = JSON.parse(String(text).replace(/^﻿/, '')); } catch (error) { continue; }
      if (!data || typeof data !== 'object') continue;
      for (const entry of Object.values(data)) {
        if (!entry || typeof entry !== 'object') continue;
        for (const key of ['mapTo', 'name']) {
          const named = entry[key];
          if (typeof named === 'string' && named && !out.has(named.toLowerCase())) {
            out.set(named.toLowerCase(), entry);
          }
        }
      }
    }
    return out;
  }

  //: Blender numbers a duplicate name and the model keeps the number while
  //: the material file does not: `bolide_main_001` is dressed by `bolide_main`.
  const DUPLICATE = /_\d{3}$/;

  function dressedAs(name, dressing) {
    if (!dressing || !dressing.size) return null;
    const lower = String(name).toLowerCase();
    if (dressing.has(lower)) return dressing.get(lower);
    const trimmed = lower.replace(DUPLICATE, '');
    return trimmed !== lower && dressing.has(trimmed) ? dressing.get(trimmed) : null;
  }

  /**
   * The first of a material's stages that says anything.
   *
   * Nearly every entry states four and fills one: the rest are the layers the
   * game blends over it, which nothing here draws.
   */
  function firstStage(entry) {
    const stages = entry && entry.Stages;
    if (Array.isArray(stages)) {
      for (const stage of stages) {
        if (stage && typeof stage === 'object' && Object.keys(stage).length) return stage;
      }
    }
    return {};
  }

  const scalar = (value) =>
    (typeof value === 'number' && Number.isFinite(value) ? value : null);

  /* --------------------------------------------------------------- output */

  //: How a binary FBX writes an object's name and its class, which is what
  //: the analysis normalises back into a name and a class.
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
    const supplied = options.materials;
    const dressing = dressingFrom(
      supplied instanceof Map ? [...supplied.values()]
        : (typeof supplied === 'string' ? [supplied] : []));
    let dressed = 0;
    /* Which slots each material has already had filled, so the older
     * generation's `colorMap` does not overwrite the newer's `baseColorMap`
     * on a car that states both. */
    const boundSlots = new Map();
    const document = parseXml(text);
    const root = document.children.find((child) => child.name === 'COLLADA');
    if (!root) throw new Error("the document's root element is not COLLADA");

    const warnings = [];
    const asset = find(root, 'asset');
    let creator = '';
    let upAxis = 'Y';
    let unitScale = 1;
    let unitName = '';
    if (asset) {
      let tool = find(asset, 'authoring_tool');
      const contributor = find(asset, 'contributor');
      if (contributor) {
        const inside = find(contributor, 'authoring_tool');
        if (inside) tool = inside;
      }
      if (tool && tool.text) creator = tool.text.trim();
      const axis = find(asset, 'up_axis');
      if (axis && axis.text) upAxis = axis.text.trim().toUpperCase().replace('_UP', '') || 'Y';
      const unit = find(asset, 'unit');
      if (unit) {
        unitName = unit.attrs.name || '';
        // Stated in metres a unit; the rest of this tool counts centimetres,
        // which is what an FBX states.
        const metres = Number(unit.attrs.meter);
        unitScale = (Number.isFinite(metres) ? metres : 1) * 100;
      }
    }

    const out = node('', [], []);
    out.children.push(node('FBXHeaderExtension', [], [
      node('Creator', [S(creator || 'COLLADA')]),
    ]));
    const axisIndex = { X: 0, Y: 1, Z: 2 }[upAxis] !== undefined ? { X: 0, Y: 1, Z: 2 }[upAxis] : 1;
    const front = axisIndex !== 2 ? 2 : 1;
    out.children.push(node('GlobalSettings', [], [
      node('Version', [I(1000)]),
      node('Properties70', [], [
        p70('UpAxis', 'int', I(axisIndex)),
        p70('UpAxisSign', 'int', I(1)),
        p70('FrontAxis', 'int', I(front)),
        p70('FrontAxisSign', 'int', I(1)),
        p70('CoordAxis', 'int', I(0)),
        p70('CoordAxisSign', 'int', I(1)),
        p70('UnitScaleFactor', 'double', D(unitScale)),
      ]),
    ]));

    const effects = new Map();
    let library = find(root, 'library_effects');
    if (library) {
      for (const effect of findAll(library, 'effect')) {
        if (effect.attrs.id) effects.set(effect.attrs.id, effect);
      }
    }
    const palette = [];
    const slotOf = new Map();
    library = find(root, 'library_materials');
    if (library) {
      for (const material of findAll(library, 'material')) {
        const ident = material.attrs.id || '';
        const name = material.attrs.name || ident;
        const instance = find(material, 'instance_effect');
        const url = instance ? String(instance.attrs.url || '').replace(/^#/, '') : '';
        slotOf.set(ident, palette.length);
        palette.push([name, effects.has(url) ? colourOf(effects.get(url)) : null]);
      }
    }

    const geometries = new Map();
    library = find(root, 'library_geometries');
    if (library) {
      for (const geometry of findAll(library, 'geometry')) {
        if (geometry.attrs.id) geometries.set(geometry.attrs.id, geometry);
      }
    }

    const objectsNode = node('Objects', [], []);
    const connections = [];
    const models = [];
    let uid = 1000;
    let drawn = 0;
    const nodes = [];
    const scenes = find(root, 'library_visual_scenes');
    if (scenes) {
      for (const scene of findAll(scenes, 'visual_scene')) {
        walk(scene, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], nodes);
      }
    }

    for (const [element, matrix] of nodes) {
      const instance = find(element, 'instance_geometry');
      if (!instance) continue;
      const target = String(instance.attrs.url || '').replace(/^#/, '');
      const geometry = geometries.get(target);
      if (!geometry) continue;
      // What each primitive's symbol stands for, which the instance binds.
      const bound = new Map();
      const bind = find(instance, 'bind_material');
      const common = bind ? find(bind, 'technique_common') : null;
      if (common) {
        for (const entry of findAll(common, 'instance_material')) {
          const symbol = entry.attrs.symbol || '';
          const to = String(entry.attrs.target || '').replace(/^#/, '');
          if (symbol && slotOf.has(to)) bound.set(symbol, slotOf.get(to));
        }
      }
      /* Which of the car's materials this part wears, in the order its own
       * primitives first ask for them, and the number each goes by *on this
       * part*: a per-polygon material index counts the materials connected to
       * the model that owns the geometry, so a part wearing three of the
       * thirty-nine numbers them nought, one and two. */
      const worn = [];
      const local = new Map();
      const slotFor = (symbol) => {
        if (!local.has(symbol)) {
          local.set(symbol, worn.length);
          worn.push(bound.has(symbol) ? bound.get(symbol) : 0);
        }
        return local.get(symbol);
      };
      const mesh = buildMesh(geometry, slotFor);
      if (!mesh) continue;
      const name = element.attrs.name || element.attrs.id || 'part';
      const geometryUid = uid;
      const modelUid = uid + 1;
      uid += 2;
      drawn += 1;

      const children = [
        node('Vertices', [array('d', mesh.positions)]),
        node('PolygonVertexIndex', [array('i', mesh.polygons)]),
        node('GeometryVersion', [I(124)]),
      ];
      if (mesh.normals.length && mesh.faceNormals.some((i) => i >= 0)) {
        children.push(node('LayerElementNormal', [I(0)], [
          node('Version', [I(101)]),
          node('Name', [S('')]),
          node('MappingInformationType', [S('ByPolygonVertex')]),
          node('ReferenceInformationType', [S('IndexToDirect')]),
          node('Normals', [array('d', mesh.normals)]),
          node('NormalsIndex', [array('i', mesh.faceNormals)]),
        ]));
      }
      if (mesh.uvs.length && mesh.faceUvs.some((i) => i >= 0)) {
        children.push(node('LayerElementUV', [I(0)], [
          node('Version', [I(101)]),
          node('Name', [S('map1')]),
          node('MappingInformationType', [S('ByPolygonVertex')]),
          node('ReferenceInformationType', [S('IndexToDirect')]),
          node('UV', [array('d', mesh.uvs)]),
          node('UVIndex', [array('i', mesh.faceUvs)]),
        ]));
      }
      children.push(node('LayerElementMaterial', [I(0)], [
        node('Version', [I(101)]),
        node('MappingInformationType', [S('ByPolygon')]),
        node('ReferenceInformationType', [S('IndexToDirect')]),
        node('Materials', [array('i', mesh.faceMaterials)]),
      ]));
      children.push(node('Layer', [I(0)], [node('Version', [I(100)])]));

      objectsNode.children.push(node(
        'Geometry', [L(geometryUid), S(`${name}${CLASS_SEP}Geometry`), S('Mesh')], children));
      const placed = decompose(matrix);
      const props = [];
      if (placed.translation.some((v) => v)) {
        props.push(p70('Lcl Translation', 'Lcl Translation', ...placed.translation.map(D)));
      }
      if (placed.rotation.some((v) => v)) {
        props.push(p70('Lcl Rotation', 'Lcl Rotation', ...placed.rotation.map(D)));
      }
      if (placed.scale[0] !== 1 || placed.scale[1] !== 1 || placed.scale[2] !== 1) {
        props.push(p70('Lcl Scaling', 'Lcl Scaling', ...placed.scale.map(D)));
      }
      const modelChildren = [node('Version', [I(232)])];
      if (props.length) modelChildren.push(node('Properties70', [], props));
      objectsNode.children.push(node(
        'Model', [L(modelUid), S(`${name}${CLASS_SEP}Model`), S('Mesh')], modelChildren));
      connections.push(node('C', [S('OO'), L(modelUid), L(0)]));
      connections.push(node('C', [S('OO'), L(geometryUid), L(modelUid)]));
      models.push([modelUid, worn]);
    }

    /* A material is written once and connected to the parts that wear it.
     *
     * Connecting every material to every model is the simpler rule, and it is
     * what a file of one part wants. But a car is 353 parts and 39 materials,
     * and all of them to all of them is 13,767 pairs — one texel apiece in the
     * palette the shader reads per fragment, which is wider than a card will
     * hold. Over that width the whole palette comes back as zeroes and the car
     * draws black, geometry and normals perfectly correct underneath. */
    let textureUid = 200000;
    palette.forEach(([name, colour], index) => {
      const materialUid = 100000 + index;
      const props = [];
      if (colour) props.push(p70('DiffuseColor', 'Color', ...colour.map(D)));

      /* And what the file beside the model says the surface is.
       *
       * Under a vendor prefix, because that is how the rest of this tool tells
       * an artist's own number from the exporter's approximation of it: a bare
       * `Opacity` is FBX's own property and read on its own terms, while a
       * prefixed one is what somebody set. */
      const entry = dressedAs(name, dressing);
      const stage = entry ? firstStage(entry) : {};
      const filled = Object.keys(stage).length > 0;
      if (filled) {
        dressed += 1;
        const base = stage.baseColorFactor || stage.diffuseColor;
        if (Array.isArray(base) && base.length >= 3
            && base.slice(0, 3).every((c) => scalar(c) !== null)) {
          props.push(p70('BeamNG|main|base_color', 'Color', ...base.slice(0, 3).map(D)));
        }
        for (const [key, spelt] of [['roughnessFactor', 'roughness'],
          ['metallicFactor', 'metalness'], ['opacityFactor', 'opacity']]) {
          const value = scalar(stage[key]);
          if (value !== null) props.push(p70(`BeamNG|main|${spelt}`, 'double', D(value)));
        }
        // A clear coat is what makes paint read as paint, and the shader
        // already draws one: what it wants is a colour to say how much comes
        // back and the index it is shaped by, which for lacquer is glass's.
        const coat = scalar(stage.clearCoatFactor);
        if (coat) {
          props.push(p70('CoatColor', 'Color', D(coat), D(coat), D(coat)));
          props.push(p70('CoatIor', 'double', D(1.5)));
        }
      }

      objectsNode.children.push(
        node('Material', [L(materialUid), S(`${name}${CLASS_SEP}Material`), S('')], [
          node('Version', [I(102)]),
          node('ShadingModel', [S('phong')]),
          node('Properties70', [], props),
        ]));

      // The pictures it wears, named as the file names them. Nothing is read
      // here: a texture record says which file a slot wants, and whoever
      // supplies the folder supplies the picture.
      for (const [key, slot] of STAGE_MAPS) {
        const named = stage[key];
        if (typeof named !== 'string' || !named) continue;
        const already = boundSlots.get(index) || [];
        if (already.includes(slot)) continue;
        already.push(slot);
        boundSlots.set(index, already);
        textureUid += 2;
        objectsNode.children.push(
          node('Texture', [L(textureUid), S(`${name}_${slot}${CLASS_SEP}Texture`), S('')], [
            node('Type', [S('TextureVideoClip')]),
            node('Version', [I(202)]),
            node('FileName', [S(named)]),
            node('RelativeFilename', [S(named)]),
          ]));
        objectsNode.children.push(
          node('Video', [L(textureUid + 1), S(`${named}${CLASS_SEP}Video`), S('Clip')], [
            node('Type', [S('Clip')]),
            node('FileName', [S(named)]),
            node('RelativeFilename', [S(named)]),
          ]));
        connections.push(node('C', [S('OP'), L(textureUid), L(materialUid), S(slot)]));
        connections.push(node('C', [S('OO'), L(textureUid + 1), L(textureUid)]));
      }
    });
    for (const [modelUid, worn] of models) {
      for (const slot of worn) {
        connections.push(node('C', [S('OO'), L(100000 + slot), L(modelUid)]));
      }
    }

    out.children.push(node('Definitions', [], [
      node('Version', [I(100)]),
      node('Count', [I(objectsNode.children.length)]),
    ]));
    out.children.push(objectsNode);
    out.children.push(node('Connections', [], connections));

    return {
      format: 'dae',
      encoding: 'dae',
      version: null,
      versionSource: null,
      wideOffsets: false,
      hasFooter: false,
      footerVersion: null,
      fileSize: text.length,
      root: out,
      warnings,
      extra: {
        colladaVersion: root.attrs.version || '',
        dressed,
        statedMaterials: dressing.size,
        parts: drawn,
        materials: palette.length,
        upAxis,
        unit: unitName,
      },
    };
  }

  return { parse, looksLikeDae, parseXml, decompose };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = FbxDae;
