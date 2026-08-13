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

  function fileSection(info) {
    const doc = info.doc;
    const version = info.version;
    const pairs = [
      ['Name', doc.fileName || '—'],
      ['Size', formatSize(doc.fileSize)],
      ['Encoding', doc.encoding === 'binary' ? 'binary' : 'ASCII text'],
      ['Version', version ? version.label : 'unknown'],
    ];
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

  function hierarchySection(info) {
    if (!info.roots.length && !info.orphans.length) return '';
    const lines = [];
    const label = (obj) => {
      let text = obj.displayName;
      if (obj.subclass) text += `  [${obj.subclass}]`;
      if (obj.detail) text += `  (${obj.detail})`;
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
