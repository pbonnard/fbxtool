/* Renders the analysis as HTML for the info panel — the browser counterpart of
 * fbxtool/report.py.
 */
'use strict';

const FbxReport = (function () {
  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function formatSize(bytes) {
    let value = bytes;
    for (const unit of ['B', 'KiB', 'MiB', 'GiB']) {
      if (value < 1024 || unit === 'GiB') {
        return unit === 'B' ? `${Math.round(value)} B` : `${value.toFixed(1)} ${unit}`;
      }
      value /= 1024;
    }
    return `${value} GiB`;
  }

  const number = (n) => n.toLocaleString('en-US');

  function rows(pairs) {
    const kept = pairs.filter(([, v]) => v !== null && v !== undefined && v !== '');
    if (!kept.length) return '';
    return `<dl>${kept.map(([k, v]) =>
      `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join('')}</dl>`;
  }

  function section(title, body, extra = '') {
    if (!body) return '';
    return `<section class="panel-section"><h2>${escapeHtml(title)}${extra}</h2>${body}</section>`;
  }

  function joinApp(name, version, vendor) {
    const parts = [name, version].filter(Boolean).join(' ');
    if (vendor && !parts.includes(vendor)) return parts ? `${parts} (${vendor})` : String(vendor);
    return parts;
  }

  const FORMAT_NAMES = {
    fbx: 'Autodesk FBX', obj: 'Wavefront OBJ', blend: 'Blender', gltf: 'glTF 2.0',
    max: 'Autodesk 3ds Max',
  };

  function objRows(doc, pairs) {
    const e = doc.extra || {};
    pairs.push(['Encoding', 'text']);
    if (e.objects && e.objects.length) pairs.push(['Objects (o)', e.objects.join(', ')]);
    if (e.groups && e.groups.length) pairs.push(['Groups (g)', e.groups.join(', ')]);
    if (e.libraries && e.libraries.length) {
      pairs.push(['Material libraries', e.libraries.join(', ')]);
      pairs.push(['Materials resolved', e.materialsResolved
        ? `${e.materialsResolved} from the .mtl`
        : 'none — drop the .mtl in to colour this model']);
    }
    if (e.smoothingGroups) pairs.push(['Smoothing groups', e.smoothingGroups]);
  }

  function blendRows(doc, pairs) {
    const e = doc.extra || {};
    pairs.push(['Blender version', e.blenderVersionText || 'unknown']);
    pairs.push(['Compression', e.compression || 'none']);
    if (e.compression && e.compression !== 'none') return;
    pairs.push(['Pointer size', `${e.pointerSize} bytes`]);
    pairs.push(['Endianness', e.endianness]);
    pairs.push(['File blocks', number(e.blockCount || 0)]);
    pairs.push(['Datablocks', number(e.datablocks || 0)]);
    pairs.push(['DNA', `${number(e.structCount || 0)} structs, `
      + `${number(e.typeCount || 0)} types, ${number(e.nameCount || 0)} field names`]);
  }

  function maxRows(doc, pairs) {
    const e = doc.extra || {};
    pairs.push(['Container', `compound file, ${number(e.sector || 0)}-byte sectors`]);
    pairs.push(['Written by', e.buildText || 'unknown']);
    pairs.push(['Scene', `${number(e.entities || 0)} entities, ${number(e.nodes || 0)} nodes`]);
    pairs.push(['Geometry', `${number(e.meshes || 0)} mesh object`
      + `${e.meshes === 1 ? '' : 's'}, `
      + `${number(e.vertices || 0)} vertices, ${number(e.faces || 0)} faces`]);
    if ((e.undecoded || []).length) {
      pairs.push(['Not read', e.undecoded.map((u) => `${u.count} ${u.name}`).join(', ')]);
    }
    pairs.push(['Classes', `${number((e.classes || []).length)} in `
      + `${number((e.dlls || []).length)} plugin(s)`]);
    if ((e.assets || []).length) {
      pairs.push(['Assets', `${number(e.assets.length)}: `
        + e.assets.slice(0, 4).map((a) => a.name).join(', ')
        + (e.assets.length > 4 ? ' …' : '')]);
    }
  }

  function gltfRows(doc, pairs) {
    const e = doc.extra || {};
    pairs.push(['Container', doc.encoding === 'binary'
      ? 'binary (.glb — JSON and a buffer chunk)' : 'text (.gltf)']);
    pairs.push(['glTF version', e.gltfVersion || 'unknown']);
    pairs.push(['Written by', e.generator || 'unknown']);
    pairs.push(['Meshes', `${number(e.meshes || 0)} `
      + `(${number(e.primitives || 0)} primitive${e.primitives === 1 ? '' : 's'})`]);
    pairs.push(['Nodes', number(e.nodes || 0)]);
    pairs.push(['Materials', number(e.materials || 0)]);
    pairs.push(['Images', number(e.images || 0)]);
    pairs.push(['Buffers', number(e.buffers || 0)]);
    if (e.extensions && e.extensions.length) {
      pairs.push(['Extensions used', e.extensions.join(', ')]);
    }
  }

  function fileSection(info) {
    const doc = info.doc;
    const version = info.version;
    const pairs = [
      ['Name', doc.fileName || '—'],
      ['Size', formatSize(doc.fileSize)],
      ['Format', FORMAT_NAMES[doc.format] || doc.format || 'Autodesk FBX'],
    ];
    if (doc.format === 'obj') {
      objRows(doc, pairs);
      if (doc.parseMilliseconds !== undefined) {
        pairs.push(['Parsed in', `${doc.parseMilliseconds.toFixed(1)} ms`]);
      }
      return section('File', rows(pairs));
    }
    if (doc.format === 'blend') {
      blendRows(doc, pairs);
      return section('File', rows(pairs));
    }
    if (doc.format === 'max') {
      maxRows(doc, pairs);
      if (doc.parseMilliseconds !== undefined) {
        pairs.push(['Parsed in', `${doc.parseMilliseconds.toFixed(1)} ms`]);
      }
      return section('File', rows(pairs));
    }
    if (doc.format === 'gltf') {
      gltfRows(doc, pairs);
      if (doc.parseMilliseconds !== undefined) {
        pairs.push(['Parsed in', `${doc.parseMilliseconds.toFixed(1)} ms`]);
      }
      return section('File', rows(pairs));
    }
    pairs.push(['Encoding', doc.encoding === 'binary' ? 'binary' : 'ASCII text']);
    pairs.push(['Version', version ? version.label : 'unknown']);
    if (version && version.notes) pairs.push(['Version note', version.notes]);
    if (doc.versionSource) pairs.push(['Version read from', doc.versionSource]);
    if (doc.encoding === 'binary') {
      pairs.push(['Node offsets', doc.wideOffsets ? '64-bit (version >= 7500)' : '32-bit']);
      pairs.push(['Footer', doc.hasFooter
        ? `present${doc.footerVersion ? `, version stamp ${doc.footerVersion}` : ''}`
        : 'missing']);
    }
    if (version && version.legacyLayout) {
      pairs.push(['Layout', 'legacy 6.x (objects addressed by name, not UID)']);
    }
    if (doc.parseMilliseconds !== undefined) {
      pairs.push(['Parsed in', `${doc.parseMilliseconds.toFixed(1)} ms`]);
    }
    return section('File', rows(pairs));
  }

  function metadataSection(info) {
    const h = info.header;
    const s = info.sceneInfo;
    const pairs = [
      ['Creator', h.creator],
      ['Created', h.creationTime],
      ['Header extension version', h.headerVersion],
      ['Encryption type', h.encryption],
      ['File id', h.fileId],
      ['Originally written by', joinApp(s.originalApplication, s.originalVersion, s.originalVendor)],
      ['Originally written', s.originalDateTime],
      ['Last saved by', joinApp(s.lastSavedApplication, s.lastSavedVersion, s.lastSavedVendor)],
      ['Last saved', s.lastSavedDateTime],
      ['Document url', s.documentUrl],
      ['Title', s.title],
      ['Author', s.author],
      ['Comment', s.comment],
    ];
    return section('Metadata', rows(pairs));
  }

  function settingsSection(info) {
    const s = info.globalSettings;
    if (!Object.keys(s).length) return '';
    const axes = [s.upAxis, s.frontAxis, s.coordAxis];
    const pairs = [];
    if (axes.some(Boolean)) {
      pairs.push(['Axis system',
        `up ${axes[0] || '?'}, front ${axes[1] || '?'}, right ${axes[2] || '?'}`]);
    }
    if (s.unitScale !== undefined) {
      let text = `${s.unitScale} cm per unit (${s.units || 'custom'})`;
      if (s.originalUnitScale !== undefined && s.originalUnitScale !== s.unitScale) {
        text += `, originally ${s.originalUnitScale}`;
      }
      pairs.push(['Units', text]);
    }
    pairs.push(['Time mode', s.timeMode]);
    if (s.customFrameRate) pairs.push(['Custom frame rate', s.customFrameRate]);
    if (s.timeSpanSeconds !== undefined) {
      pairs.push(['Time span', `${s.timeSpanSeconds.toFixed(3)} s`]);
    }
    return section('Global settings', rows(pairs));
  }

  function structureSection(info) {
    let body = rows([
      ['Total records', number(info.totalRecords)],
      ['Maximum nesting depth', info.maxDepth],
      ['Top-level sections', info.sections.length],
    ]);
    if (info.sections.length) {
      body += `<table class="counts">${info.sections.map(([name, count]) =>
        `<tr><td>${escapeHtml(name)}</td><td>${number(count)}</td></tr>`).join('')}</table>`;
    }
    const props = [...info.propertyCounts.entries()].sort((a, b) => b[1] - a[1]);
    if (props.length) {
      const total = props.reduce((sum, [, n]) => sum + n, 0);
      body += '<h3>Properties by type</h3>';
      body += `<table class="counts">${props.map(([name, count]) =>
        `<tr><td>${escapeHtml(name)}</td><td>${number(count)}</td></tr>`).join('')}`
        + `<tr class="total"><td>total</td><td>${number(total)}</td></tr></table>`;
      if (info.arrayBytes) {
        body += `<p class="note">Array payloads: ${formatSize(info.arrayBytes)} as stored</p>`;
      }
    }
    return section('Record structure', body);
  }

  function definitionsSection(info) {
    if (!info.definitions.length && info.definitionsCount === null) return '';
    let body = '';
    if (info.definitionsCount !== null) {
      body += `<p class="note">Declared object count: ${number(info.definitionsCount)}</p>`;
    }
    if (info.definitions.length) {
      body += '<table class="counts wide"><tr><th>object type</th><th>count</th><th>template</th></tr>';
      body += info.definitions.map((d) => {
        const template = d.template
          ? `${escapeHtml(d.template)} (${d.templateProperties} defaults)` : '—';
        return `<tr><td>${escapeHtml(d.type)}</td><td>${number(d.count)}</td><td>${template}</td></tr>`;
      }).join('');
      body += '</table>';
    }
    return section('Definitions', body);
  }

  function objectsSection(info) {
    if (!info.objects.length) return '';
    let body = `<p class="note">${number(info.objects.length)} object records`;
    const expected = info.expectedObjectCount;
    if (expected !== null && expected !== info.objects.length) {
      const diff = Math.abs(expected - info.objects.length);
      body += ` — Definitions implies ${number(expected)}, so ${number(diff)} `
        + (expected > info.objects.length ? 'are missing' : 'are extra');
    }
    body += '</p>';
    const counts = [...info.objectCounts.entries()].sort((a, b) => b[1] - a[1]);
    body += `<table class="counts">${counts.map(([kind, count]) =>
      `<tr><td>${escapeHtml(kind)}</td><td>${number(count)}</td></tr>`).join('')}</table>`;
    return section('Objects', body);
  }

  /**
   * What has been done to the scene since the file was read.
   *
   * The sections above describe the file; this one describes what is on
   * screen, and only appears once the two differ.
   */
  function editsSection(info) {
    const edits = info.edits;
    if (!edits) return '';
    const pairs = [
      ['Parts now', number(edits.parts)],
      ['Triangles now', number(edits.triangles)],
      ['Deleted', edits.removed.length ? `${number(edits.removed.length)} part(s), `
        + `${number(edits.removed.reduce((sum, p) => sum + p.triangles, 0))} triangles` : null],
      ['Split', edits.split.length
        ? edits.split.map((s) => `${s.name} into ${s.into}`).join(', ') : null],
      ['Materials changed', edits.assigned
        ? `${number(edits.assigned)} part(s) wear a material the file did not give them` : null],
      ['Materials added', edits.added && edits.added.length
        ? edits.added.join(', ') : null],
    ];
    let body = rows(pairs);
    if (edits.removed.length) {
      body += `<p class="note">${escapeHtml(edits.removed.map((p) => p.name).join(', '))}</p>`;
    }
    body += '<p class="note">The file itself is unchanged; an export writes '
      + 'what is on screen.</p>';
    return section('Edits', body);
  }

  function hierarchySection(info) {
    if (!info.roots.length && !info.orphans.length) return '';
    const lines = [];
    const edits = info.edits;
    const label = (obj) => {
      let text = obj.displayName;
      if (obj.subclass) text += `  [${obj.subclass}]`;
      if (obj.detail) text += `  (${obj.detail})`;
      // A model whose mesh has been taken out of the scene, or cut up.
      if (edits) {
        if (edits.removedModels.has(obj)) text += '  ← removed';
        else if (edits.editedModels.has(obj)) text += '  ← edited';
      }
      return text;
    };
    const walk = (node, prefix) => {
      const total = node.children.length;
      node.children.forEach((child, index) => {
        if (lines.length >= 400) return;
        const last = index === total - 1;
        lines.push(prefix + (last ? '└── ' : '├── ') + label(child.obj));
        const childPrefix = prefix + (last ? '    ' : '│   ');
        child.attachments.forEach((item, position) => {
          const attachmentLast = position === child.attachments.length - 1 && !child.children.length;
          lines.push(childPrefix + (attachmentLast ? '└── ' : '├── ')
            + `[${item.nodeType}] ${item.displayName}`
            + (item.detail ? ` (${item.detail})` : ''));
        });
        walk(child, childPrefix);
      });
    };
    for (const root of info.roots) {
      lines.push(root.label || 'RootNode');
      walk(root, '');
    }
    if (info.orphans.length) {
      lines.push('');
      lines.push(`Unparented models: ${info.orphans.length}`);
      for (const obj of info.orphans.slice(0, 40)) lines.push(`  ${label(obj)}`);
    }
    return section('Scene hierarchy', `<pre class="tree">${escapeHtml(lines.join('\n'))}</pre>`);
  }

  function connectionsSection(info) {
    if (!info.connections.length) return '';
    const names = {
      OO: 'object → object', OP: 'object → property',
      PO: 'property → object', PP: 'property → property',
    };
    const counts = [...info.connectionCounts.entries()].sort((a, b) => b[1] - a[1]);
    const body = `<p class="note">${number(info.connections.length)} connections</p>`
      + `<table class="counts wide">${counts.map(([kind, count]) =>
        `<tr><td>${escapeHtml(kind)}</td><td>${escapeHtml(names[kind] || 'unknown')}</td>`
        + `<td>${number(count)}</td></tr>`).join('')}</table>`;
    return section('Connections', body);
  }

  function animationSection(info) {
    const a = info.animation;
    if (!Object.keys(a).length) return '';
    const pairs = Object.entries(a)
      .filter(([k, v]) => k !== 'stacks' && k !== 'takes' && typeof v !== 'object');
    let body = rows(pairs);
    for (const stack of a.stacks || []) {
      body += `<p class="note">stack ${escapeHtml(stack.name)}`
        + (stack.durationSeconds !== undefined ? ` (${stack.durationSeconds.toFixed(3)} s)` : '')
        + '</p>';
    }
    for (const take of a.takes || []) body += `<p class="note">take ${escapeHtml(take)}</p>`;
    return section('Animation', body);
  }

  function warningsSection(info) {
    if (!info.warnings.length) return '';
    const items = info.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('');
    return section(`Warnings (${info.warnings.length})`, `<ul class="warnings">${items}</ul>`);
  }

  /** Render the record tree, lazily expandable below the top levels. */
  function recordTree(root, maxDepth = 2) {
    const summarise = (prop) => {
      if (prop.array) {
        const encoding = prop.array.encoding === 1 ? 'deflate' : 'raw';
        const stored = prop.array.byteLength ? ` ${formatSize(prop.array.byteLength)}` : '';
        return `*${number(prop.array.length)} [${prop.code}] ${encoding}${stored}`;
      }
      if (prop.code === 'S') {
        let text = String(prop.value).split('\u0000\u0001').join('::');
        if (text.length > 32) text = `${text.slice(0, 29)}...`;
        return `"${text}"`;
      }
      if (prop.code === 'R') return `<raw ${prop.value.length} B>`;
      if (typeof prop.value === 'boolean') return prop.value ? 'true' : 'false';
      return String(prop.value);
    };

    const render = (node, depth) => {
      const preview = node.props.slice(0, 3).map(summarise).join(', ')
        + (node.props.length > 3 ? `, +${node.props.length - 3} more` : '');
      const label = escapeHtml(node.name + (node.props.length ? `: ${preview}` : ''))
        + (node.children.length ? ` <span class="count">{${node.children.length}}</span>` : '');
      if (!node.children.length) return `<li>${label}</li>`;
      const open = depth < maxDepth ? ' open' : '';
      return `<li><details${open}><summary>${label}</summary><ul>`
        + node.children.map((c) => render(c, depth + 1)).join('') + '</ul></details></li>';
    };
    return `<ul class="record-tree">${root.children.map((c) => render(c, 0)).join('')}</ul>`;
  }

  function render(info) {
    return [
      fileSection(info),
      editsSection(info),
      warningsSection(info),
      metadataSection(info),
      settingsSection(info),
      hierarchySection(info),
      objectsSection(info),
      definitionsSection(info),
      connectionsSection(info),
      animationSection(info),
      structureSection(info),
    ].join('');
  }

  return { render, recordTree, formatSize, escapeHtml };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = FbxReport;
