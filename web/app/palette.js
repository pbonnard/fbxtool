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
   * The colour a material was read as, before a metalness split it between
   * diffuse and reflectance. That is the one an artist set and the one the
   * controls edit; the split halves are what the shader wants. An entry from
   * an older assignment may not carry it, and its diffuse is the nearest
   * thing.
   */
  const baseOf = (file) => (file.base || file.colour);

  /**
   * Fold the user's settings into the palette, or restore the file's values
   * where nothing is set. Metalness follows the Principled convention: a metal
   * has no diffuse and reflects its own colour, a dielectric reflects 4%.
   */
  function apply(palette, overrides) {
    const settings = overrides || {};
    for (const entry of palette) {
      const origin = originOf(entry);
      const set = settings[origin] || null;
      const file = entry.fromFile;
      // A rename is a setting like any other, so it comes and goes with them.
      entry.name = set && typeof set.name === 'string' && set.name ? set.name : origin;
      entry.roughness = set && typeof set.roughness === 'number'
        ? set.roughness : file.roughness;
      const opacity = set && typeof set.opacity === 'number' ? set.opacity : null;
      entry.opacity = opacity === null ? file.opacity : opacity;

      /* How the file asked to be blended stands until the opacity is actually
       * edited — an opacity factor is not the only place transparency lives,
       * and a badge whose texture carries its own is drawn as a solid
       * rectangle the moment the factor alone is asked. Setting the opacity by
       * hand is a decision about transparency, and then the factor is the
       * answer. */
      entry.alphaMode = opacity === null ? (file.alphaMode || null) : null;
      entry.alphaCutoff = file.alphaCutoff === undefined ? null : file.alphaCutoff;
      // Nothing here edits what a surface gives off, so it is the file's.
      entry.emissive = file.emissive ? file.emissive.slice() : null;
      /* Images the file names and this assignment does not want: not removed
       * from the entry, only marked, so the row can still say what the file
       * names and the choice can be taken back. Whatever draws or writes them
       * asks this first. */
      entry.droppedMaps = set && Array.isArray(set.dropped) ? set.dropped.slice() : [];

      /* Colour and metalness are one setting in two halves — each is part of
       * how the other splits — so neither is recomputed until one of them is
       * actually set. Until then the file's own values stand as they were
       * read, tinted reflectance and all, however much else is overridden:
       * renaming a chrome material used to leave it a dark dielectric. */
      const metallic = set && typeof set.metallic === 'number' ? set.metallic : null;
      const colour = set && set.colour ? set.colour : null;
      if (metallic === null && colour === null) {
        entry.colour = file.colour.slice();
        entry.specular = file.specular.slice();
        entry.metallic = file.metallic || 0;
        continue;
      }
      // Whichever half was not set keeps what the file said it was.
      const m = metallic === null ? (file.metallic || 0) : metallic;
      const base = colour || baseOf(file);
      entry.colour = base.map((c) => c * (1 - m));
      entry.specular = base.map((c) => 0.04 * (1 - m) + c * m);
      entry.metallic = m;
    }
    return palette;
  }

  /** What a group's controls should read, given the current override. */
  function settingsFor(group, overrides) {
    const set = (overrides || {})[group.origin || group.name] || {};
    const file = group.entry.fromFile;
    return {
      colour: set.colour || baseOf(file),
      metallic: typeof set.metallic === 'number' ? set.metallic : (file.metallic || 0),
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
  const nothing = () => ({ materials: {}, parts: {} });

  function load(fileName) {
    try {
      const raw = window.localStorage.getItem(storageKey(fileName));
      return raw ? parse(raw) : nothing();
    } catch (error) {
      return nothing();
    }
  }

  function save(fileName, overrides, parts) {
    try {
      const settings = overrides && Object.keys(overrides).length;
      const worn = parts && Object.keys(parts).length;
      if (!settings && !worn) window.localStorage.removeItem(storageKey(fileName));
      else window.localStorage.setItem(storageKey(fileName), serialise(overrides, parts));
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * An assignment as a file: what each material looks like, and — where a part
   * has been dressed in something the file did not give it — which part wears
   * which. A part is named by the key its model is addressed by, so the map
   * still finds it when the file is read again.
   */
  function serialise(overrides, parts) {
    const data = { fbxtoolMaterials: 1, materials: overrides || {} };
    if (parts && Object.keys(parts).length) data.parts = parts;
    return `${JSON.stringify(data, null, 2)}\n`;
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
      // Nothing in the file to fall back on: this one was made here, and has
      // to be built again before anything can wear it.
      if (value.added === true) set.added = true;
      // Images the file names that this assignment leaves out.
      if (Array.isArray(value.dropped)) {
        const slots = value.dropped
          .filter((slot) => SLOTS.some(([name]) => name === slot));
        if (slots.length) set.dropped = [...new Set(slots)];
      }
      if (Object.keys(set).length) out[name] = set;
    }

    const parts = {};
    if (data.parts && typeof data.parts === 'object') {
      for (const [part, material] of Object.entries(data.parts)) {
        if (typeof material === 'string' && material) parts[String(part)] = material;
      }
    }
    return { materials: out, parts };
  }

  /* ------------------------------------------------------------- markup */

  const escape = (text) => String(text).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));

  /* ---------------------------------------------------------------- images */

  /**
   * The map slots, in the order they are worth reading: what the material
   * looks like first, then what shapes and lights it.
   */
  const SLOTS = [
    ['baseColor', 'Base colour'],
    ['metallicRoughness', 'Metal / rough'],
    ['normal', 'Normal'],
    ['occlusion', 'Occlusion'],
    ['emissive', 'Emissive'],
  ];

  const fileName = (path) => String(path).split(/[\\/]/).pop();

  /**
   * The images a material names, and whether each one is here.
   *
   * A file names its images by relative path and does not carry them, so a
   * material can name one that was never supplied — which is how a car arrives
   * with none of its maps and every material falls back to what it states
   * alone. Saying which file each slot wants, and which of them is missing, is
   * the difference between that being visible and being a mystery.
   */
  function maps(entry, supplied) {
    const found = [];
    const add = (slot, request) => {
      if (request) found.push({ slot, request });
    };
    add('baseColor', entry.texture);
    for (const [slot, request] of Object.entries(entry.textures || {})) add(slot, request);

    const order = new Map(SLOTS.map(([slot], index) => [slot, index]));
    found.sort((a, b) => (order.has(a.slot) ? order.get(a.slot) : 99)
      - (order.has(b.slot) ? order.get(b.slot) : 99));

    return found.map(({ slot, request }) => {
      const known = SLOTS.find(([name]) => name === slot);
      const embedded = !!request.embedded;
      // An image carried inside the file has no name of its own beyond the
      // record's; one named by path is known by its file.
      const name = request.path ? fileName(request.path) : (request.name || 'image');
      return {
        slot,
        label: known ? known[1] : slot,
        name,
        embedded,
        here: embedded || !supplied || supplied.has(name.toLowerCase()),
        dropped: (entry.droppedMaps || []).includes(slot),
      };
    });
  }

  /** The images block of one material's row. */
  function mapsMarkup(entry, supplied) {
    const images = maps(entry, supplied);
    if (!images.length) return '';
    const key = escape(originOf(entry));
    const rows = images.map((image) => {
      const note = image.dropped ? 'left out'
        : (image.embedded ? 'in the file' : (image.here ? '' : 'not supplied'));
      const mark = image.dropped ? ' dropped' : (image.here ? '' : ' absent');
      return `<span class="material-map${mark}">`
        + `<span class="material-map-slot">${escape(image.label)}</span>`
        + `<span class="material-map-file" title="${escape(image.name)}">`
        + `${escape(image.name)}</span>`
        + (note ? `<span class="material-map-note">${escape(note)}</span>` : '')
        + `<button type="button" class="material-map-drop" data-key="${key}"`
        + ` data-slot="${escape(image.slot)}" data-action="drop"`
        + ` title="${image.dropped ? 'use this image again' : 'leave this image out'}">`
        + `${image.dropped ? '+' : '×'}</button>`
        + '</span>';
    }).join('');
    return `<div class="material-maps"><span class="material-maps-title">Images</span>${rows}</div>`;
  }

  const percent = (share) => (share >= 0.001 ? `${(share * 100).toFixed(1)}%` : '<0.1%');

  function slider(group, field, value, label) {
    return `<label class="material-field"><span>${label}</span>`
      + `<input type="range" min="0" max="1" step="0.01" value="${value.toFixed(2)}"`
      + ` data-key="${escape(group.origin)}" data-field="${field}">`
      + `<output>${value.toFixed(2)}</output></label>`;
  }

  /**
   * The Materials tab: one row per material, biggest first.
   *
   * `supplied` is the set of image file names the page has been given, by
   * which a map a material names but nobody handed over is told apart from one
   * that is here.
   */
  function render(list, overrides, { supplied = null } = {}) {
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
      const images = maps(group.entry, supplied);
      // Worth seeing without opening the row: which materials wear images at
      // all, and whether any of them is waiting for a file.
      const absent = images.filter((image) => !image.here).length;
      const wears = images.length
        ? `<span class="material-images${absent ? ' absent' : ''}"`
          + ` title="${escape(images.map((i) => i.name).join(', '))}">`
          + `${images.length} image${images.length === 1 ? '' : 's'}`
          + `${absent ? ` · ${absent} missing` : ''}</span>` : '';
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
        + `<span class="material-name">${escape(group.name)}</span>${slots}${wears}`
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
        + mapsMarkup(group.entry, supplied)
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
    load, save, serialise, parse, render, keyOf, maps,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = FbxPalette;
