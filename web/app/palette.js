/* Material assignments.
 *
 * The render palette is one entry per material slot, in the order the
 * per-polygon material index refers to — and a scene of many parts repeats the
 * same material once per part, so the Shelby's 20 materials arrive as 62
 * slots. This module groups those slots back into materials, applies whatever
 * the user has set on top of what the file said, and remembers it.
 *
 * An override never destroys the file's own values: each entry keeps them, so
 * clearing an override puts the material back exactly as it was read.
 */
'use strict';

const FbxPalette = (function () {
  /* ------------------------------------------------------------- colour */

  /* Shading works in linear light; a colour input speaks sRGB. */
  function toSrgb(value) {
    const c = Math.min(Math.max(value, 0), 1);
    return c <= 0.0031308 ? c * 12.92 : 1.055 * (c ** (1 / 2.4)) - 0.055;
  }

  function fromSrgb(value) {
    const c = Math.min(Math.max(value, 0), 1);
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }

  const pair = (v) => Math.round(v * 255).toString(16).padStart(2, '0');

  /** Linear rgb -> "#rrggbb" for an <input type="color">. */
  function toHex(rgb) {
    return `#${[0, 1, 2].map((i) => pair(toSrgb(Number(rgb[i]) || 0))).join('')}`;
  }

  /** "#rrggbb" -> linear rgb. */
  function fromHex(hex) {
    const text = String(hex).replace('#', '');
    const full = text.length === 3 ? [...text].map((c) => c + c).join('') : text;
    return [0, 1, 2].map((i) => fromSrgb(parseInt(full.slice(i * 2, i * 2 + 2), 16) / 255));
  }

  /* ------------------------------------------------------------ presets */

  /* Starting points for the usual surfaces. Colours are linear. */
  const PRESETS = [
    { id: 'paint', label: 'Body paint', colour: [0.35, 0.02, 0.02], metallic: 0, roughness: 0.25 },
    { id: 'chrome', label: 'Chrome', colour: [0.86, 0.87, 0.89], metallic: 1, roughness: 0.08 },
    { id: 'brushed', label: 'Brushed metal', colour: [0.55, 0.56, 0.58], metallic: 1, roughness: 0.35 },
    { id: 'glass', label: 'Glass', colour: [0.7, 0.75, 0.78], metallic: 0, roughness: 0.05, opacity: 0.25 },
    { id: 'rubber', label: 'Rubber', colour: [0.015, 0.015, 0.017], metallic: 0, roughness: 0.75 },
    { id: 'leather', label: 'Leather', colour: [0.055, 0.03, 0.02], metallic: 0, roughness: 0.55 },
    { id: 'plastic', label: 'Plastic', colour: [0.035, 0.035, 0.038], metallic: 0, roughness: 0.45 },
    { id: 'wood', label: 'Wood', colour: [0.1, 0.045, 0.02], metallic: 0, roughness: 0.35 },
    { id: 'fabric', label: 'Fabric', colour: [0.045, 0.04, 0.038], metallic: 0, roughness: 0.95 },
    { id: 'lamp', label: 'Lamp glass', colour: [0.6, 0.58, 0.5], metallic: 0, roughness: 0.15, opacity: 0.5 },
  ];

  const preset = (id) => PRESETS.find((p) => p.id === id) || null;

  /* ------------------------------------------------------------ grouping */

  /** A material's identity: its UID where the file has one, else its name. */
  const keyOf = (entry) => (entry.uid === undefined || entry.uid === null
    ? `name:${originOf(entry)}` : `uid:${entry.uid}`);

  /**
   * The name a material was read under, which is what its settings are filed
   * against. A material can be renamed, and everything it wears has to follow
   * the rename rather than be lost by it.
   */
  const originOf = (entry) => ((entry.fromFile && entry.fromFile.name) || entry.name);

  /**
   * Group palette slots by material, largest surface first.
   *
   * `slotTriangles` counts triangles per slot, so the list opens on whatever
   * covers the model rather than on whatever happens to be first.
   */
  function groups(palette, slotTriangles) {
    const counts = slotTriangles || [];
    const byKey = new Map();
    palette.forEach((entry, slot) => {
      const key = keyOf(entry);
      let group = byKey.get(key);
      if (!group) {
        group = {
          key,
          // What it is called now, and what it is filed under.
          name: entry.name || '(unnamed)',
          origin: originOf(entry),
          slots: [],
          triangles: 0,
          entry,
        };
        byKey.set(key, group);
      }
      group.slots.push(slot);
      group.triangles += counts[slot] || 0;
    });

    const total = [...byKey.values()].reduce((sum, g) => sum + g.triangles, 0);
    const list = [...byKey.values()];
    list.sort((a, b) => b.triangles - a.triangles || a.name.localeCompare(b.name));
    list.forEach((group, index) => {
      group.index = index;
      group.share = total ? group.triangles / total : 0;
      // The shader compares this against the highlighted group.
      for (const slot of group.slots) palette[slot].group = index;
    });
    return list;
  }

  /* ----------------------------------------------------------- overrides */

  /**
   * Fold the user's settings into the palette, or restore the file's values
   * where nothing is set. Metalness follows the Principled convention: a metal
   * has no diffuse and reflects its own colour, a dielectric reflects 4%.
   */
  function apply(palette, overrides) {
    const settings = overrides || {};
    for (const entry of palette) {
      const origin = originOf(entry);
      const set = settings[origin];
      // A rename is a setting like any other, so it comes and goes with them.
      entry.name = set && typeof set.name === 'string' && set.name ? set.name : origin;
      if (!set) {
        entry.colour = entry.fromFile.colour.slice();
        entry.specular = entry.fromFile.specular.slice();
        entry.roughness = entry.fromFile.roughness;
        entry.opacity = entry.fromFile.opacity;
        entry.metallic = entry.fromFile.metallic || 0;
        continue;
      }
      const base = set.colour || entry.fromFile.colour;
      const metallic = typeof set.metallic === 'number' ? set.metallic : 0;
      entry.colour = base.map((c) => c * (1 - metallic));
      entry.specular = base.map((c) => 0.04 * (1 - metallic) + c * metallic);
      entry.metallic = metallic;
      entry.roughness = typeof set.roughness === 'number'
        ? set.roughness : entry.fromFile.roughness;
      entry.opacity = typeof set.opacity === 'number' ? set.opacity : entry.fromFile.opacity;
    }
    return palette;
  }

  /** What a group's controls should read, given the current override. */
  function settingsFor(group, overrides) {
    const set = (overrides || {})[group.origin || group.name] || {};
    const file = group.entry.fromFile;
    return {
      colour: set.colour || file.colour,
      metallic: typeof set.metallic === 'number' ? set.metallic : 0,
      roughness: typeof set.roughness === 'number' ? set.roughness : file.roughness,
      opacity: typeof set.opacity === 'number' ? set.opacity : file.opacity,
      name: typeof set.name === 'string' && set.name ? set.name : (group.origin || group.name),
      renamed: typeof set.name === 'string' && !!set.name,
      edited: Object.keys(set).length > 0,
    };
  }

  /* --------------------------------------------------------- persistence */

  const storageKey = (fileName) => `fbxtool:materials:${fileName || 'unnamed'}`;

  /** Storage is unavailable in some browsers on file:// URLs; degrade quietly. */
  function load(fileName) {
    try {
      const raw = window.localStorage.getItem(storageKey(fileName));
      return raw ? parse(raw) : {};
    } catch (error) {
      return {};
    }
  }

  function save(fileName, overrides) {
    try {
      if (!overrides || !Object.keys(overrides).length) {
        window.localStorage.removeItem(storageKey(fileName));
      } else {
        window.localStorage.setItem(storageKey(fileName), serialise(overrides));
      }
      return true;
    } catch (error) {
      return false;
    }
  }

  function serialise(overrides) {
    return `${JSON.stringify({ fbxtoolMaterials: 1, materials: overrides }, null, 2)}\n`;
  }

  /** Read a saved assignment, tolerating anything that is not one. */
  function parse(text) {
    let data;
    try {
      data = JSON.parse(text);
    } catch (error) {
      throw new Error('that file is not a material assignment');
    }
    const materials = data && data.materials;
    if (!data || !data.fbxtoolMaterials || typeof materials !== 'object' || !materials) {
      throw new Error('that file is not a material assignment');
    }
    const out = {};
    for (const [name, value] of Object.entries(materials)) {
      if (!value || typeof value !== 'object') continue;
      const set = {};
      if (Array.isArray(value.colour) && value.colour.length >= 3) {
        set.colour = [0, 1, 2].map((i) => Math.max(0, Number(value.colour[i]) || 0));
      }
      for (const field of ['metallic', 'roughness', 'opacity']) {
        if (typeof value[field] === 'number' && isFinite(value[field])) {
          set[field] = Math.min(1, Math.max(0, value[field]));
        }
      }
      // A material can be renamed; the file's own name stays the key, so an
      // assignment written here still finds it.
      if (typeof value.name === 'string' && value.name.trim()) {
        set.name = value.name.trim().slice(0, 120);
      }
      if (Object.keys(set).length) out[name] = set;
    }
    return out;
  }

  /* ------------------------------------------------------------- markup */

  const escape = (text) => String(text).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));

  const percent = (share) => (share >= 0.001 ? `${(share * 100).toFixed(1)}%` : '<0.1%');

  function slider(group, field, value, label) {
    return `<label class="material-field"><span>${label}</span>`
      + `<input type="range" min="0" max="1" step="0.01" value="${value.toFixed(2)}"`
      + ` data-key="${escape(group.origin)}" data-field="${field}">`
      + `<output>${value.toFixed(2)}</output></label>`;
  }

  /** The Materials tab: one row per material, biggest first. */
  function render(list, overrides) {
    if (!list.length) {
      return '<section class="panel-section placeholder"><h2>No materials</h2>'
        + '<p>This file connects no materials to its meshes, so there is nothing '
        + 'to assign. The viewer draws it in clay.</p></section>';
    }
    const rows = list.map((group) => {
      const set = settingsFor(group, overrides);
      const hex = toHex(set.colour);
      const slots = group.slots.length > 1
        ? `<span class="material-slots">${group.slots.length} parts</span>` : '';
      const options = PRESETS.map((p) => `<option value="${p.id}">${escape(p.label)}</option>`)
        .join('');
      // Renamed rows say what the file called it, so the report and the
      // records that still use that name can be found from here.
      const was = set.renamed
        ? `<span class="material-was" title="the name in the file">was `
          + `${escape(group.origin)}</span>` : '';
      return `<details class="material${set.edited ? ' edited' : ''}"`
        + ` data-key="${escape(group.origin)}" data-index="${group.index}">`
        + '<summary>'
        + `<span class="swatch" style="background:${hex}"></span>`
        + `<span class="material-name">${escape(group.name)}</span>${slots}`
        + `<span class="material-share">${percent(group.share)}</span>`
        + '</summary>'
        + '<div class="material-edit">'
        + '<label class="material-field material-rename"><span>Name</span>'
        + `<input type="text" value="${escape(set.name)}" spellcheck="false"`
        + ` data-key="${escape(group.origin)}" data-field="name"`
        + ' aria-label="Material name"></label>'
        + was
        + '<label class="material-field"><span>Colour</span>'
        + `<input type="color" value="${hex}" data-key="${escape(group.origin)}"`
        + ' data-field="colour"></label>'
        + slider(group, 'metallic', set.metallic, 'Metal')
        + slider(group, 'roughness', set.roughness, 'Rough')
        + slider(group, 'opacity', set.opacity, 'Opacity')
        + '<div class="material-actions">'
        + `<select data-key="${escape(group.origin)}" data-field="preset">`
        + `<option value="">Preset…</option>${options}</select>`
        + `<button type="button" data-key="${escape(group.origin)}" data-action="reset">`
        + 'From file</button>'
        + '</div></div></details>';
    }).join('');
    return `<div class="material-list">${rows}</div>`;
  }

  return {
    toSrgb, fromSrgb, toHex, fromHex,
    PRESETS, preset, groups, apply, settingsFor,
    load, save, serialise, parse, render, keyOf,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = FbxPalette;
