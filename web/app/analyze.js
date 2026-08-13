/* Scene-level interpretation of a parsed record tree — the browser counterpart
 * of fbxtool/analyze.py, working on whichever reader produced the tree.
 */
'use strict';

const FbxAnalyze = (function () {
  const NAME_CLASS_SEPARATOR = '\u0000\u0001';  // binary form; ASCII writes Class::Name instead
  const FBX_TIME_UNIT = 46186158000;

  const KNOWN_VERSIONS = {
    5000: ['FBX 5.0', 'pre-Autodesk Kaydara format'],
    5800: ['FBX 5.8', 'pre-Autodesk Kaydara format'],
    6000: ['FBX 6.0', 'legacy layout: Objects hold names instead of UIDs'],
    6100: ['FBX 2009 / 2010', 'legacy layout: Objects hold names instead of UIDs'],
    7000: ['FBX 2010', 'first release of the modern 7.x layout'],
    7100: ['FBX 2011', ''],
    7200: ['FBX 2012', ''],
    7300: ['FBX 2013', ''],
    7400: ['FBX 2014 / 2015', 'most widely supported version'],
    7500: ['FBX 2016 / 2017', 'binary node offsets widen to 64 bits'],
    7600: ['FBX 2018', ''],
    7700: ['FBX 2019 / 2020', ''],
  };

  const TIME_MODES = {
    0: 'DefaultMode', 1: '120 fps', 2: '100 fps', 3: '60 fps', 4: '50 fps',
    5: '48 fps', 6: '30 fps', 7: '30 fps (drop)', 8: 'NTSC drop frame',
    9: 'NTSC full frame', 10: 'PAL (25 fps)', 11: '24 fps (cinema)',
    12: '1000 fps', 13: 'cinema (drop)', 14: 'custom', 15: '96 fps',
    16: '72 fps', 17: '59.94 fps',
  };

  const AXIS_NAMES = { 0: 'X', 1: 'Y', 2: 'Z' };
  const UNITS = {
    1: 'centimetres', 2.54: 'inches', 30.48: 'feet', 100: 'metres',
    0.1: 'millimetres', 91.44: 'yards', 10: 'decimetres',
  };
  const TYPES_OUTSIDE_OBJECTS = new Set(['GlobalSettings']);

  function describeVersion(stamp) {
    if (stamp === null || stamp === undefined) return null;
    const major = Math.floor(stamp / 1000);
    const minor = Math.floor((stamp % 1000) / 100);
    const patch = stamp % 100;
    const dotted = `${major}.${minor}.${patch}`;
    const known = KNOWN_VERSIONS[stamp];
    return {
      stamp,
      dotted,
      product: known ? known[0] : null,
      notes: known ? known[1] : '',
      legacyLayout: stamp < 7000,
      wideOffsets: stamp >= 7500,
      label: known
        ? `${stamp} (FBX ${dotted} — ${known[0]})`
        : `${stamp} (FBX ${dotted} — unrecognised, newer than this tool)`,
    };
  }

  function splitObjectName(raw) {
    if (typeof raw !== 'string') return ['', ''];
    const sep = raw.indexOf(NAME_CLASS_SEPARATOR);
    if (sep >= 0) return [raw.slice(0, sep), raw.slice(sep + 2)];
    const colons = raw.indexOf('::');
    if (colons >= 0) return [raw.slice(colons + 2), raw.slice(0, colons)];
    return [raw, ''];
  }

  const child = (node, name) => (node ? node.children.find((c) => c.name === name) : undefined);
  const childAll = (node, name) => (node ? node.children.filter((c) => c.name === name) : []);
  const value = (node, index = 0) => (node && node.props[index] ? node.props[index].value : undefined);

  function pathValue(node, names, index = 0) {
    let cursor = node;
    for (const name of names) {
      cursor = child(cursor, name);
      if (!cursor) return undefined;
    }
    return value(cursor, index);
  }

  /** Flatten a Properties70/Properties60 block into a plain object. */
  function properties(node) {
    if (!node) return {};
    const block = child(node, 'Properties70') || child(node, 'Properties60');
    if (!block) return {};
    const out = {};
    for (const entry of block.children) {
      if (entry.name !== 'P' && entry.name !== 'Property') continue;
      const values = entry.props.map((p) => p.value);
      if (!values.length || typeof values[0] !== 'string') continue;
      let payload = entry.name === 'P' ? values.slice(4) : values.slice(3);
      if (!payload.length) payload = values.slice(1);
      out[values[0]] = payload.length === 1 ? payload[0] : payload;
    }
    return out;
  }

  function arrayLength(node) {
    if (!node) return null;
    for (const prop of node.props) {
      if (prop.array) return prop.array.length;
      if (prop.code === '*' && typeof prop.value === 'number') return prop.value;
    }
    const values = child(node, 'a');
    if (values && values.props[0] && values.props[0].array) return values.props[0].array.length;
    return null;
  }

  function countRecords(node) {
    let total = 0;
    for (const c of node.children) total += 1 + countRecords(c);
    return total;
  }

  function depthOf(node) {
    if (!node.children.length) return 0;
    let best = 0;
    for (const c of node.children) best = Math.max(best, depthOf(c));
    return best + 1;
  }

  function formatTimestamp(node) {
    if (!node) return '';
    const part = (name) => {
      const v = pathValue(node, [name]);
      return typeof v === 'number' ? v : 0;
    };
    const pad = (n, w = 2) => String(n).padStart(w, '0');
    const year = part('Year');
    if (!year) return '';
    return `${pad(year, 4)}-${pad(part('Month'))}-${pad(part('Day'))} `
      + `${pad(part('Hour'))}:${pad(part('Minute'))}:${pad(part('Second'))}`
      + `.${pad(part('Millisecond'), 3)}`;
  }

  function readSceneInfo(node) {
    const props = properties(node);
    const info = {};
    const map = {
      DocumentUrl: 'documentUrl',
      SrcDocumentUrl: 'sourceDocumentUrl',
      'Original|ApplicationVendor': 'originalVendor',
      'Original|ApplicationName': 'originalApplication',
      'Original|ApplicationVersion': 'originalVersion',
      'Original|DateTime_GMT': 'originalDateTime',
      'Original|FileName': 'originalFilename',
      'LastSaved|ApplicationVendor': 'lastSavedVendor',
      'LastSaved|ApplicationName': 'lastSavedApplication',
      'LastSaved|ApplicationVersion': 'lastSavedVersion',
      'LastSaved|DateTime_GMT': 'lastSavedDateTime',
    };
    for (const [key, label] of Object.entries(map)) {
      if (props[key] !== undefined && props[key] !== '') info[label] = props[key];
    }
    const meta = child(node, 'MetaData');
    if (meta) {
      for (const name of ['Title', 'Subject', 'Author', 'Keywords', 'Revision', 'Comment']) {
        const v = pathValue(meta, [name]);
        if (v) info[name.toLowerCase()] = v;
      }
    }
    return info;
  }

  function describeObject(entry, subclass) {
    if ((entry.name === 'Geometry' || entry.name === 'Model') && child(entry, 'Vertices')) {
      const bits = [];
      const verts = arrayLength(child(entry, 'Vertices'));
      if (verts !== null) bits.push(`${Math.floor(verts / 3)} vertices`);
      const indices = arrayLength(child(entry, 'PolygonVertexIndex'));
      if (indices !== null) bits.push(`${indices} polygon indices`);
      const layers = childAll(entry, 'Layer').length;
      if (layers) bits.push(`${layers} layer${layers === 1 ? '' : 's'}`);
      const uvs = childAll(entry, 'LayerElementUV').length;
      if (uvs) bits.push(`${uvs} UV set${uvs === 1 ? '' : 's'}`);
      return bits.join(', ');
    }
    if (entry.name === 'Texture' || entry.name === 'Video') {
      for (const key of ['RelativeFilename', 'FileName', 'Filename']) {
        const v = pathValue(entry, [key]);
        if (typeof v === 'string' && v) return v;
      }
      return '';
    }
    if (entry.name === 'Material') {
      const shading = pathValue(entry, ['ShadingModel']);
      return shading ? `shading: ${shading}` : '';
    }
    if (entry.name === 'Deformer' && subclass === 'Cluster') {
      const n = arrayLength(child(entry, 'Indexes'));
      return n === null ? '' : `${n} weighted vertices`;
    }
    if (entry.name === 'AnimationCurve') {
      const n = arrayLength(child(entry, 'KeyTime'));
      return n === null ? '' : `${n} keys`;
    }
    if (entry.name === 'NodeAttribute') {
      const flags = pathValue(entry, ['TypeFlags']);
      return flags ? `flags: ${flags}` : '';
    }
    return '';
  }

  /**
   * Default property values per object type, from Definitions.
   *
   * A property a file does not set is not unset — it takes the value from that
   * type's PropertyTemplate. Exporters lean on this: a material with no
   * Properties70 at all still has a colour.
   */
  function propertyTemplates(root) {
    const definitions = child(root, 'Definitions');
    if (!definitions) return {};
    const out = {};
    for (const entry of childAll(definitions, 'ObjectType')) {
      const template = child(entry, 'PropertyTemplate');
      const name = value(entry);
      if (template && typeof name === 'string' && name) out[name] = properties(template);
    }
    return out;
  }

  /** An object's properties, with its type's template defaults underneath. */
  function resolvedProperties(obj, templates) {
    return Object.assign({}, (templates || {})[obj.nodeType] || {}, properties(obj.node));
  }

  function analyze(doc) {
    const root = doc.root;
    const out = {
      doc,
      version: describeVersion(doc.version),
      header: {},
      sceneInfo: {},
      globalSettings: {},
      definitions: [],
      definitionsCount: null,
      definitionsOutsideObjects: 0,
      objects: [],
      objectCounts: new Map(),
      connections: [],
      connectionCounts: new Map(),
      sections: root.children.map((c) => [c.name, countRecords(c) + 1]),
      totalRecords: countRecords(root),
      maxDepth: depthOf(root),
      propertyCounts: new Map(),
      arrayBytes: 0,
      media: [],
      animation: {},
      roots: [],
      orphans: [],
      templates: propertyTemplates(root),
      warnings: doc.warnings.slice(),
    };

    (function countProps(node) {
      for (const c of node.children) {
        for (const prop of c.props) {
          const key = prop.typeName || prop.code;
          out.propertyCounts.set(key, (out.propertyCounts.get(key) || 0) + 1);
          if (prop.array) out.arrayBytes += prop.array.byteLength;
        }
        countProps(c);
      }
    })(root);

    // ---- header ----
    const ext = child(root, 'FBXHeaderExtension');
    if (ext) {
      out.header.headerVersion = pathValue(ext, ['FBXHeaderExtensionVersion'])
        ?? pathValue(ext, ['FBXHeaderVersion']);
      out.header.encryption = pathValue(ext, ['EncryptionType']);
      out.header.creator = pathValue(ext, ['Creator']);
      out.header.creationTime = formatTimestamp(child(ext, 'CreationTimeStamp'));
      const sceneInfo = child(ext, 'SceneInfo');
      if (sceneInfo) out.sceneInfo = readSceneInfo(sceneInfo);
    }
    if (!out.header.creator) out.header.creator = pathValue(root, ['Creator']);
    if (!out.header.creationTime) out.header.creationTime = pathValue(root, ['CreationTime']);
    const fileId = child(root, 'FileId');
    if (fileId && fileId.props.length) {
      const raw = fileId.props[0].value;
      if (raw instanceof Uint8Array) {
        out.header.fileId = Array.from(raw, (b) => b.toString(16).padStart(2, '0')).join('');
      } else if (raw !== null && raw !== undefined) {
        out.header.fileId = String(raw);
      }
    }

    // ---- global settings ----
    const settingsNode = child(root, 'GlobalSettings');
    if (settingsNode) {
      const props = properties(settingsNode);
      const settings = {};
      for (const axis of ['Up', 'Front', 'Coord']) {
        const idx = props[`${axis}Axis`];
        const sign = props[`${axis}AxisSign`];
        if (typeof idx === 'number') {
          const letter = AXIS_NAMES[idx] !== undefined ? AXIS_NAMES[idx] : String(idx);
          settings[`${axis.toLowerCase()}Axis`] = (typeof sign === 'number' && sign < 0 ? '-' : '+') + letter;
        }
      }
      const scale = props.UnitScaleFactor;
      if (typeof scale === 'number') {
        settings.unitScale = scale;
        settings.units = UNITS[Math.round(scale * 100000) / 100000] || 'custom';
      }
      if (typeof props.OriginalUnitScaleFactor === 'number') {
        settings.originalUnitScale = props.OriginalUnitScaleFactor;
      }
      if (typeof props.TimeMode === 'number') {
        settings.timeMode = TIME_MODES[props.TimeMode] || `mode ${props.TimeMode}`;
      }
      if (typeof props.CustomFrameRate === 'number' && props.CustomFrameRate > 0) {
        settings.customFrameRate = props.CustomFrameRate;
      }
      const start = props.TimeSpanStart;
      const stop = props.TimeSpanStop;
      if (typeof start === 'number' && typeof stop === 'number' && stop >= start) {
        settings.timeSpanSeconds = (stop - start) / FBX_TIME_UNIT;
      }
      out.globalSettings = settings;
    }

    // ---- definitions ----
    const definitions = child(root, 'Definitions');
    if (definitions) {
      const count = pathValue(definitions, ['Count']);
      if (typeof count === 'number') out.definitionsCount = count;
      for (const entry of childAll(definitions, 'ObjectType')) {
        const template = child(entry, 'PropertyTemplate');
        const typeName = value(entry) || '';
        const typeCount = pathValue(entry, ['Count']) || 0;
        if (TYPES_OUTSIDE_OBJECTS.has(typeName)) out.definitionsOutsideObjects += typeCount;
        out.definitions.push({
          type: typeName,
          count: typeCount,
          template: template ? value(template) : null,
          templateProperties: template ? Object.keys(properties(template)).length : 0,
        });
      }
    }
    out.expectedObjectCount = out.definitionsCount === null
      ? null : out.definitionsCount - out.definitionsOutsideObjects;

    // ---- objects ----
    const objects = child(root, 'Objects');
    if (objects) {
      for (const entry of objects.children) {
        const values = entry.props.map((p) => p.value);
        let uid = null;
        let rawName = '';
        let subclass = '';
        if (values.length && typeof values[0] === 'number') {
          uid = values[0];
          rawName = typeof values[1] === 'string' ? values[1] : '';
          subclass = typeof values[2] === 'string' ? values[2] : '';
        } else {
          rawName = typeof values[0] === 'string' ? values[0] : '';
          subclass = typeof values[1] === 'string' ? values[1] : '';
        }
        const [name, className] = splitObjectName(rawName);
        const obj = {
          nodeType: entry.name,
          uid,
          name,
          className: className || entry.name,
          subclass,
          detail: describeObject(entry, subclass),
          node: entry,
          get displayName() { return this.name || '<unnamed>'; },
          get kind() { return this.subclass ? `${this.nodeType} (${this.subclass})` : this.nodeType; },
        };
        out.objects.push(obj);
        out.objectCounts.set(obj.kind, (out.objectCounts.get(obj.kind) || 0) + 1);
        if ((obj.nodeType === 'Texture' || obj.nodeType === 'Video') && obj.detail) {
          out.media.push({ type: obj.nodeType, name: obj.displayName, path: obj.detail });
        }
      }
    }

    // ---- connections ----
    const connections = child(root, 'Connections') || child(root, 'Relations');
    if (connections) {
      for (const entry of connections.children) {
        if (entry.name !== 'C' && entry.name !== 'Connect') continue;
        const values = entry.props.map((p) => p.value);
        if (values.length < 3) continue;
        const kind = typeof values[0] === 'string' ? values[0] : '??';
        out.connections.push({
          kind,
          src: values[1],
          dst: values[2],
          prop: typeof values[3] === 'string' ? values[3] : null,
        });
        out.connectionCounts.set(kind, (out.connectionCounts.get(kind) || 0) + 1);
      }
    }

    // ---- animation ----
    const byType = new Map();
    for (const obj of out.objects) byType.set(obj.nodeType, (byType.get(obj.nodeType) || 0) + 1);
    for (const key of ['AnimationStack', 'AnimationLayer', 'AnimationCurve', 'AnimationCurveNode']) {
      if (byType.get(key)) out.animation[key] = byType.get(key);
    }
    const stacks = out.objects.filter((o) => o.nodeType === 'AnimationStack');
    if (stacks.length) {
      out.animation.stacks = stacks.map((stack) => {
        const props = properties(stack.node);
        const entry = { name: stack.displayName };
        if (typeof props.LocalStart === 'number' && typeof props.LocalStop === 'number'
            && props.LocalStop >= props.LocalStart) {
          entry.durationSeconds = (props.LocalStop - props.LocalStart) / FBX_TIME_UNIT;
        }
        return entry;
      });
    }
    const takes = child(root, 'Takes');
    if (takes) {
      const names = childAll(takes, 'Take').map((t) => value(t)).filter((n) => typeof n === 'string');
      if (names.length) out.animation.takes = names;
      const current = pathValue(takes, ['Current']);
      if (current) out.animation.currentTake = current;
    }

    buildHierarchy(out);
    return out;
  }

  function buildHierarchy(out) {
    const models = out.objects.filter((o) => o.nodeType === 'Model');
    if (!models.length) return;

    const byKey = new Map();
    for (const obj of out.objects) {
      if (obj.uid !== null && !byKey.has(obj.uid)) byKey.set(obj.uid, obj);
      const named = `${obj.className}::${obj.name}`;
      if (obj.name && !byKey.has(named)) byKey.set(named, obj);
    }

    const children = new Map();
    const parents = new Map();
    for (const conn of out.connections) {
      if (conn.kind !== 'OO' && conn.kind !== 'OP') continue;
      const kid = byKey.get(conn.src);
      if (!kid) continue;
      if (!children.has(conn.dst)) children.set(conn.dst, []);
      children.get(conn.dst).push(kid);
      if (!parents.has(kid)) parents.set(kid, []);
      parents.get(kid).push(conn.dst);
    }

    const visited = new Set();
    const keyOf = (obj) => (obj.uid !== null ? obj.uid : `${obj.className}::${obj.name}`);

    function attach(parentNode, obj, depth) {
      if (visited.has(obj) || depth > 128) return;
      visited.add(obj);
      const node = { obj, children: [], attachments: [] };
      parentNode.children.push(node);
      for (const kid of children.get(keyOf(obj)) || []) {
        if (kid.nodeType === 'Model') attach(node, kid, depth + 1);
        else if (['Geometry', 'Material', 'NodeAttribute'].includes(kid.nodeType)) {
          node.attachments.push(kid);
        }
      }
    }

    const sceneRoot = { obj: null, children: [], attachments: [], label: 'RootNode' };
    for (const key of [0, 'Model::Scene', 'Model::SceneRoot']) {
      for (const kid of children.get(key) || []) {
        if (kid.nodeType === 'Model') attach(sceneRoot, kid, 0);
      }
    }
    if (sceneRoot.children.length) out.roots.push(sceneRoot);

    if (!out.roots.length) {
      const modelSet = new Set(models);
      const floating = { obj: null, children: [], attachments: [], label: 'Models (no scene root record)' };
      for (const obj of models) {
        const parentObjs = (parents.get(obj) || []).map((k) => byKey.get(k));
        if (!parentObjs.some((p) => p && modelSet.has(p))) attach(floating, obj, 0);
      }
      if (floating.children.length) out.roots.push(floating);
      out.orphans = models.filter((m) => !visited.has(m));
    } else {
      out.orphans = models.filter((m) => !visited.has(m) && !(parents.get(m) || []).length);
    }
  }

  /** Pick the mesh geometry worth rendering: the one with the most vertices. */
  function findGeometry(doc) {
    const objects = doc.root.children.find((c) => c.name === 'Objects');
    if (!objects) return null;
    let best = null;
    let bestSize = -1;
    for (const entry of objects.children) {
      if (entry.name !== 'Geometry' && entry.name !== 'Model') continue;
      const vertices = entry.children.find((c) => c.name === 'Vertices');
      const indices = entry.children.find((c) => c.name === 'PolygonVertexIndex');
      if (!vertices || !indices) continue;
      const size = arrayLength(vertices) || 0;
      if (size > bestSize) { bestSize = size; best = entry; }
    }
    return best;
  }

  /** Every renderable geometry record, largest first. */
  function findAllGeometry(doc) {
    const objects = doc.root.children.find((c) => c.name === 'Objects');
    if (!objects) return [];
    return objects.children
      .filter((entry) => (entry.name === 'Geometry' || entry.name === 'Model')
        && entry.children.some((c) => c.name === 'Vertices')
        && entry.children.some((c) => c.name === 'PolygonVertexIndex'))
      .sort((a, b) => (arrayLength(a.children.find((c) => c.name === 'Vertices')) || 0)
        < (arrayLength(b.children.find((c) => c.name === 'Vertices')) || 0) ? 1 : -1);
  }

  return {
    analyze, describeVersion, splitObjectName, properties, arrayLength,
    child, childAll, pathValue, findGeometry, findAllGeometry, FBX_TIME_UNIT,
    propertyTemplates, resolvedProperties,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = FbxAnalyze;
