/* The paint jobs that sit beside an Assetto Corsa car.
 *
 * A `.kn5` carries one set of textures and the game puts another over the top
 * before it draws. Everything under `skins/<name>/` replaces the texture of
 * that name for as long as that skin is chosen, so what is *in* the file is
 * the car unpainted: an Audi S8's own textures are ambient occlusion over bare
 * grey, and its thirteen skins are what make it Alpine White or Sakhir Orange.
 *
 * Two files in a skin folder say more than the pictures do, and both are the
 * skin's own — nothing here needs the game installed to read them:
 *
 *   ext_config.ini   `CarPaintMaterial = booody_aooo` — which material of the
 *                    car is its paint. Custom Shaders Patch reads this to know
 *                    what to hand its car-paint shader.
 *   cm_skin.json     Content Manager's `carPaint.color`, as `#AARRGGBB` —
 *                    #FF1A2025 for Azurite Black Metallic, #FFFFFFFF for
 *                    Alpine White — beside its gloss and its reflectivity.
 *
 * Neither is always there, and a config copied from another car names a
 * material this one has not got. Both are read for what they say and checked
 * against the model rather than believed: a skin that names no material, or
 * names one that is not there, still brings its textures.
 */
'use strict';

const FbxSkins = (function () {
  //: `.../skins/<name>/<file>` — the folder a skin is, wherever it was dropped.
  const SKIN_PATH = /(?:^|\/)skins\/([^/]+)\/[^/]+$/i;
  const IMAGE = /\.(png|jpe?g|gif|bmp|webp|tga|ktx2|psd|dds)$/i;

  /** The skin a path belongs to, or null for a file outside one. */
  function skinOf(path) {
    const found = SKIN_PATH.exec(String(path).replace(/\\/g, '/'));
    return found ? found[1] : null;
  }

  /**
   * A colour as an `<input type="color">` spells it, alpha dropped.
   *
   * Content Manager writes `#AARRGGBB`, so the first pair is the alpha and
   * taking the first six characters would paint every car with its own
   * opacity — #FF1A2025 is a near-black blue and #FF1A20 is a red.
   */
  function rgbHex(value) {
    const text = String(value || '').trim().replace(/^#/, '');
    if (!/^[0-9a-f]+$/i.test(text)) return null;
    const lower = text.toLowerCase();
    if (lower.length === 8) return `#${lower.slice(2)}`;
    if (lower.length === 6) return `#${lower}`;
    if (lower.length === 3) return `#${[...lower].map((c) => c + c).join('')}`;
    return null;
  }

  /* The three shapes every one of these config readers wants: a section
   * heading, a `key = value` line with any trailing comment dropped, and the
   * line ending an ini file may be written with either of.
   *
   * A key may carry a digit: the numbered ones — PROP_0, PROP_1 — are how a
   * shader replacement lists what it restates — and so may a full stop: a
   * file writes PROP_... and [SHADER_REPLACEMENT_...] and lets the patch
   * number them, which is a spelling half these configs use.
   * keys it wants by name, so a wider key pattern finds more and mistakes
   * nothing. */
  const HEADING = /^\s*\[([^\]]*)\]/;
  const SETTING = /^[ \t]*([A-Za-z_0-9.]+)[ \t]*=([^;]*)/;
  const NEWLINE = /\r?\n/;

  /**
   * Which materials a config calls the car's paint, in the order it says them.
   *
   * Two spellings for the one thing, and a car uses whichever its author did:
   * `CarPaintMaterial = booody_aooo` on an Audi, and a `[Material_CarPaint_*]`
   * section with `Materials = body` on a Renault, once per paint. The order
   * matters — it is what pairs them with the colours.
   *
   * The rest of the file is `[INCLUDE]`s of things that live inside Custom
   * Shaders Patch rather than beside the car, so only what is written here is
   * read and the rest is left where it is.
   */
  function paintMaterials(text) {
    const out = [];
    let section = '';
    const add = (list) => {
      for (const name of String(list).split(',')) {
        const trimmed = name.trim();
        if (trimmed && !out.includes(trimmed)) out.push(trimmed);
      }
    };
    for (const line of String(text || '').split(NEWLINE)) {
      const heading = HEADING.exec(line);
      if (heading) { section = heading[1]; continue; }
      const setting = /^[ \t]*(CarPaintMaterial|Materials)[ \t]*=([^;]*)/i.exec(line);
      if (!setting) continue;
      const key = setting[1].toLowerCase();
      // `Materials` is a key half the sections in the file use, so it only
      // means the paint inside a section that says it is the paint.
      if (key === 'carpaintmaterial' || /^material_carpaint/i.test(section)) {
        add(setting[2]);
      }
    }
    return out;
  }

  /**
   * Every colour Content Manager's `cm_skin.json` states, in the order it does.
   *
   * One car calls its paint `carPaint` and another `extBody1`, `extBody2` and
   * `extRims1` — a Renault 5 states three and its config names three materials
   * to match, `body`, `body2` and `rim_colored`, in that order and with the
   * names corroborating. So the two lists are paired by position, which is the
   * only thing they share and is what the game does with them.
   *
   * A section without a colour is not a paint: the same file carries the
   * carpet, the interior and the driver's suit.
   */
  function paintColours(text) {
    let data;
    try {
      data = JSON.parse(String(text));
    } catch (error) {
      return [];
    }
    if (!data || typeof data !== 'object') return [];
    const out = [];
    for (const [key, value] of Object.entries(data)) {
      if (!value || typeof value !== 'object' || value.color === undefined) continue;
      const hex = rgbHex(value.color);
      if (!hex) continue;
      out.push({
        key,
        hex,
        // Content Manager's paint shop, switched on or off. Which is not the
        // same as whether the colour is the car's — see `stated`.
        enabled: value.enabled !== false,
        gloss: typeof value.gloss === 'number' ? value.gloss : null,
        reflection: typeof value.reflection === 'number' ? value.reflection : null,
      });
    }
    return out;
  }

  /**
   * Whether a colour is one a picker nobody opened was left holding.
   *
   * Plain white is the one Content Manager opens at. Black is the other, and
   * it arrives spelt several ways — #000000, #020202, #040505, #070707 — so
   * the test is that no channel rises above 8, which no eye can tell from
   * black anyway. The darkest colour any car here actually states is #00030F,
   * a Porsche 928's Dark Blue, so nothing real falls in the gap.
   */
  function unset(hex) {
    if (hex === '#ffffff') return true;
    const n = parseInt(String(hex).slice(1), 16);
    return Number.isFinite(n)
      && Math.max((n >> 16) & 255, (n >> 8) & 255, n & 255) <= 8;
  }

  /**
   * Whether a slot states a colour, or only holds the one it opens with.
   *
   * `enabled` is the paint shop's own switch, and reading it as *this paint is
   * not on the car* throws away most of what the file says. Of the 125 cars
   * whose models read here, 77 skins state a colour with the switch off that
   * the picker was never left holding, and not one of them brings the texture
   * that colour could have been baked into instead: a Ford Escort Cosworth's
   * Red says #7F0000 with the switch off and replaces nothing but its wheels
   * and its number plate, and the car is red. So a colour is the paint
   * whichever way the switch is set.
   *
   * What the picker was left holding is the other way about, and that is
   * settled by asking the chip rather than by trusting it. Of the 138 skins
   * here that say plain white with the switch off, 124 carry a chip that is
   * plainly some other colour — an Audi's Sakhir Orange among them. The blacks
   * are the same story told quieter: 32 say one, and where the car really is
   * black the chip says black too, while a Scirocco's twelve and a Skoda's
   * White are cars whose chips are the reds and blues and silvers their own
   * previews show. Every one of those 170 skins carries a chip, so handing the
   * question over never loses the answer.
   */
  function stated(colour) {
    return !!colour && (colour.enabled || !unset(colour.hex));
  }

  /* How far a stated brightness is followed down.
   *
   * `BrightnessAdjustment` is half of a pair: it darkens the coat because the
   * shader is about to add a great deal of specular back on top, and the
   * settings that do the adding — `AmbientSpecular`, `SpecularBase`,
   * `ClearCoatThickness` — sit in the same section. Taken alone it is only
   * the darkening, which is right while it is a compensation and wrong once
   * it is the whole description: a C-X75's rims state 0.05 beside a clear
   * coat of 3, meaning the surface has no colour of its own and is all
   * highlight. This viewer does not put that highlight back, so following the
   * 0.05 down turns bright silver wheels black.
   *
   * A quarter is where the two readings part. Of the 229 settings across the
   * cars to hand, 33 are under it — and 19 of those 33 are sections naming
   * their own materials, the rims and trim and carbon, against 27 of the 196
   * above. So what is under the floor is mostly not the car's paint at all.
   */
  const BRIGHTNESS_FLOOR = 0.25;
  /* The settings in one of those sections that this viewer has somewhere to
   * put. Everything else in them — the flakes, the clear coat, the cubemap
   * blur — describes a shader that is not this one. */
  const FINISH_KEYS = {
    reflectance: 'reflectance',
    smoothness: 'smoothness',
    metalness: 'metalness',
  };
  /**
   * Walk the `[Material_*]` sections of a config, handing each setting to
   * *visit* along with the materials that section is about.
   *
   * Three things are the same in every one of these files and are done here
   * once. A section names the materials it is for in `Materials`, and one
   * that names none is about whatever the file calls its paint in
   * `CarPaintMaterial` — which is gathered first, since it is written above
   * the sections that rely on it. A section naming `Skins` is only for those
   * skins; one folder's config can carry a block written for another. And a
   * trailing comment is not part of a value.
   */
  function eachMaterialSection(text, name, visit) {
    const lines = String(text || '').split(NEWLINE);
    /* What a section naming no materials of its own is about.
     *
     * Only where it is written outside the material sections. `CarPaintMaterial`
     * is spelt both ways: 165 of the 219 across the cars to hand sit above them
     * and name the car's paint once for the file, and 54 sit inside one and
     * name that section's own — a 550 Maranello writes four such sections, for
     * its body, its rims and its exhaust, each naming itself. Read as a
     * file-wide default those four all name every one of the others, and the
     * last section's word lands on the body: the rims' brightness of 0.5 came
     * out on the paint and a rosso corsa arrived half dark.
     */
    const fallback = [];
    let heading = '';
    for (const line of lines) {
      const mark = HEADING.exec(line);
      if (mark) { heading = mark[1]; continue; }
      if (/^material_carpaint/i.test(heading)) continue;
      const found = SETTING.exec(line);
      if (found && found[1].toLowerCase() === 'carpaintmaterial') {
        for (const one of found[2].split(',')) {
          const trimmed = one.trim();
          if (trimmed) fallback.push(trimmed);
        }
      }
    }
    let section = '';
    let mine = true;
    let materials = fallback;
    for (const line of lines) {
      const mark = HEADING.exec(line);
      if (mark) { section = mark[1]; mine = true; materials = fallback; continue; }
      if (!/^material_/i.test(section)) continue;
      const found = SETTING.exec(line);
      if (!found) continue;
      const key = found[1].toLowerCase();
      const value = found[2].trim();
      if (key === 'skins') {
        mine = value.split(',').some((one) => one.trim().toLowerCase()
          === String(name).toLowerCase());
      } else if (key === 'materials'
        || (key === 'carpaintmaterial' && /^material_carpaint/i.test(section))) {
        materials = value.split(',').map((one) => one.trim()).filter(Boolean);
      } else if (mine) {
        visit(key, value, materials, section);
      }
    }
  }
  /**
   * How much of its stated colour a paint is actually drawn at.
   *
   * `BrightnessAdjustment` sits in the same `[Material_CarPaint_*]` section
   * the rest of the paint is written in, and it is not a tweak: a Jaguar
   * C-X75's Silver states `#FFFFFF` in its `cm_skin.json` and 0.66 here, and
   * the two together are silver. Read without it the car is white — which is
   * a colour a paint shop has, and not the one on the preview beside the skin.
   *
   * The comment those settings carry, over and over, is "compensates for
   * ambient specular": a car's paint is drawn with a great deal of the room
   * added on top of it, so the coat underneath is stated darker than the
   * colour it is meant to come out as. Nothing is tinted — the whole of the
   * colour is scaled.
   *
   * 37 of the 135 cars to hand state one on a paint: 229 settings, 140 of
   * them in a skin rather than beside the car, and a median of 0.60. So it is
   * most of a colour, most of the time it is written at all.
   *
   * A section naming no `Materials` is about the paint the file names in
   * `CarPaintMaterial`, which is why that is gathered first; one that names
   * some is about those. A section naming the skins it is for is only for
   * those, the same as a colour is.
   */
  function paintBrightness(text, name) {
    const out = new Map();
    eachMaterialSection(text, name, (key, value, materials, section) => {
      if (key !== 'brightnessadjustment') return;
      if (!/^material_carpaint/i.test(section)) return;
      const scale = Number(value);
      // A blank or a word is not a number, and a surface stated darker than
      // the floor is one whose colour the file put in its highlight rather
      // than its coat — see `BRIGHTNESS_FLOOR`.
      if (!Number.isFinite(scale) || scale < BRIGHTNESS_FLOOR) return;
      for (const material of materials) out.set(material.toLowerCase(), scale);
    });
    return out;
  }

  /**
   * What a car's config says its surfaces are made of.
   *
   * `Reflectance`, `Smoothness` and `Metalness` are the three numbers this
   * viewer already has a slot for, and on a Custom Shaders Patch car they are
   * where the material actually lives. The `ks*` values inside the `.kn5` are
   * the pre-patch version of the same surface, left behind when the author
   * moved the description out to `[Material_Metal]` and `[Material_Glass]`
   * and the rest — so a car read from the model alone is read as the car it
   * used to be, and its chrome comes back as plastic.
   *
   * 1121 `[Material_*]` blocks sit beside the 135 cars to hand, and 423 state
   * a smoothness, 375 a reflectance, 194 a metalness.
   *
   * Held inside the unit range, which is what all three mean and not always
   * what they say: the highest smoothness written is 3, the highest
   * reflectance 2. The game does its own thing with the overshoot and there
   * is nothing here for it to mean.
   */
  function materialFinish(text, name) {
    const out = new Map();
    const put = (material, key, value) => {
      const at = material.toLowerCase();
      if (!out.has(at)) out.set(at, {});
      out.get(at)[key] = Math.min(1, Math.max(0, value));
    };
    eachMaterialSection(text, name, (key, value, materials) => {
      const wanted = FINISH_KEYS[key];
      if (!wanted) return;
      const number = Number(value);
      if (!Number.isFinite(number)) return;
      for (const material of materials) put(material, wanted, number);
    });
    return out;
  }

  /**
   * The colours a skin's own `ext_config.ini` states, for the ones with no
   * `cm_skin.json` to state them in.
   *
   * A chameleon paint is two: `ChameleonColorA` facing you and
   * `ChameleonColorB` at a grazing angle, each with an opacity after it. Only
   * the first is taken — there is one albedo here and A is what the car looks
   * like from where you are standing. A Clio V6's Illiad Blue is `#33007f`
   * turning to yellow at the edges, and read without it the car is white.
   *
   * A section that names the skins it is for is only for those: one folder's
   * config can carry a block written for another.
   */
  function configColours(text, name) {
    const out = [];
    let section = '';
    let mine = true;
    for (const line of String(text || '').split(NEWLINE)) {
      const heading = HEADING.exec(line);
      if (heading) { section = heading[1]; mine = true; continue; }
      if (!/^material_carpaint/i.test(section)) continue;
      const setting = /^[ \t]*([A-Za-z]+)[ \t]*=([^;]*)/.exec(line);
      if (!setting) continue;
      const key = setting[1].toLowerCase();
      const value = setting[2].trim();
      if (key === 'skins') {
        mine = value.split(',').some((s) => s.trim().toLowerCase() === String(name).toLowerCase());
      } else if (key === 'chameleoncolora' && mine) {
        const hex = rgbHex(value.split(',')[0]);
        if (hex) out.push({ key, hex, enabled: true, gloss: null, reflection: null });
      }
    }
    return out;
  }

  /**
   * The colour of the paint chip a skin carries a picture of.
   *
   * `livery.png` is the swatch Content Manager shows beside a skin's name: a
   * rounded square of the paint with a gloss sweeping over it, sixty-four
   * pixels square, and every one of the 189 skins to hand has one. It is a
   * picture rather than a statement, so it is read last and only where nothing
   * was stated — but read, it is exact. A Champagne Quartz chip is 1874 pixels
   * of #565D6B and its `cm_skin.json` says #565D6B.
   *
   * Two things make a plain average the wrong reading. The gloss is a wide
   * bright sweep, and under some of them is a band of dark reflection — a
   * Renault 5's Blanc Perle chip is white over black, and averaged it is a
   * mid-grey nobody painted. So this takes the commonest colour rather than
   * the mean, over the upper half where the paint is: colours are gathered
   * into 32 steps a channel, the fullest bucket wins, and what is returned is
   * the average of what fell in it — which for a flat chip is the one colour
   * it is drawn in, to the unit.
   *
   * *pixels* is RGBA, four bytes to a pixel, top row first.
   */
  function chipColour(pixels, width, height) {
    if (!pixels || !width || !height) return null;
    if (pixels.length < width * height * 4) return null;
    // A big picture is sampled rather than counted: a few cars carry the whole
    // livery sheet here instead of a chip, at two thousand pixels square.
    const step = Math.max(1, Math.ceil(Math.max(width, height) / 256));
    const rows = Math.max(1, Math.round(height / 2));
    const buckets = new Map();
    let best = null;
    for (let y = 0; y < rows; y += step) {
      for (let x = 0; x < width; x += step) {
        const at = (y * width + x) * 4;
        // A transparent corner is the chip's rounding, not a colour it is.
        if (pixels[at + 3] < 128) continue;
        const r = pixels[at];
        const g = pixels[at + 1];
        const b = pixels[at + 2];
        const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
        let bucket = buckets.get(key);
        if (!bucket) { bucket = [0, 0, 0, 0]; buckets.set(key, bucket); }
        bucket[0] += r; bucket[1] += g; bucket[2] += b; bucket[3] += 1;
        if (!best || bucket[3] > best[3]) best = bucket;
      }
    }
    if (!best) return null;
    const hex = (v) => Math.round(v / best[3]).toString(16).padStart(2, '0');
    return `#${hex(best[0])}${hex(best[1])}${hex(best[2])}`;
  }

  /** The first colour a skin states, which most of them state only one of. */
  function paintColour(text) {
    const found = paintColours(text);
    return found.length ? { hex: found[0].hex, enabled: found[0].enabled,
      gloss: found[0].gloss, reflection: found[0].reflection } : null;
  }

  /* The two other kinds of section that describe the car rather than a skin's
   * paint: one takes meshes away, one restates a material's numbers. */
  const REPLACEMENT_SECTION = /^[ \t]*\[(MODEL_REPLACEMENT|SHADER_REPLACEMENT)[^\]]*\]/i;
  const OFF = /^(0|0\.0+|false|no)$/i;

  /**
   * What a car's config takes away, and what it restates.
   *
   * `[MODEL_REPLACEMENT_*]` swaps one model for another, and the part of it
   * this can honour is `HIDE`: the meshes the swap is meant to remove. 100 of
   * the 101 such sections across the 135 cars to hand name some, and 77 of the
   * 101 are written in a skin rather than beside the car — a number plate a
   * livery does not want is the commonest thing in them. What is not honoured
   * is the other half, `INSERT`: bringing a second model in, placing it and
   * merging it is a whole car's worth of work and none of it is this.
   *
   * `[SHADER_REPLACEMENT_*]` restates a material. Its `PROP_n = name, value`
   * lines are the very numbers a `.kn5` states about a surface and this
   * already reads — `fresnelEXP`, `ksDiffuse`, `isAdditive`,
   * `detailUVMultiplier` and the rest — so they are put where the file's own
   * would have been and everything downstream follows.
   *
   * Only the sections that name `MATERIALS`. 53 of the 123 name `MESHES`
   * instead, and a material here is shared across every mesh that wears it:
   * one mesh's restatement applied to it would change parts the file never
   * named.
   */
  function carReplacements(text, name) {
    const hidden = new Set();
    const shaders = new Map();
    let kind = '';
    let mine = true;
    let active = true;
    let hide = [];
    let materials = [];
    let props = new Map();
    let shader = null;
    let transparent = null;
    const close = () => {
      if (kind && mine && active) {
        for (const one of hide) hidden.add(one.toLowerCase());
        for (const one of materials) {
          const at = one.toLowerCase();
          const held = shaders.get(at) || { props: new Map(), shader: null, transparent: null };
          for (const [key, value] of props) held.props.set(key, value);
          if (shader) held.shader = shader;
          if (transparent !== null) held.transparent = transparent;
          shaders.set(at, held);
        }
      }
      kind = ''; mine = true; active = true;
      hide = []; materials = []; props = new Map(); shader = null; transparent = null;
    };
    for (const line of String(text || '').split(NEWLINE)) {
      if (line.trimStart().startsWith('[')) {
        close();
        const mark = REPLACEMENT_SECTION.exec(line);
        if (mark) kind = mark[1].toUpperCase();
        continue;
      }
      if (!kind) continue;
      const setting = SETTING.exec(line);
      if (!setting) continue;
      const key = setting[1].toUpperCase();
      const value = setting[2].trim();
      const list = () => value.split(',').map((one) => one.trim()).filter(Boolean);
      if (key === 'ACTIVE') active = !OFF.test(value);
      else if (key === 'SKINS') {
        mine = list().some((one) => one.toLowerCase() === String(name).toLowerCase());
      } else if (key === 'HIDE' && kind === 'MODEL_REPLACEMENT') hide = list();
      else if (key === 'MATERIALS' && kind === 'SHADER_REPLACEMENT') materials = list();
      else if (kind !== 'SHADER_REPLACEMENT') continue;
      else if (key === 'SHADER') shader = value;
      else if (key === 'IS_TRANSPARENT') transparent = !OFF.test(value);
      else if (/^PROP_/.test(key)) {
        const [written, said] = list();
        const number = Number(said);
        if (written && Number.isFinite(number)) props.set(written, number);
      }
    }
    close();
    return { hidden, shaders };
  }
  /**
   * Group supplied files into the skins they came from.
   *
   * *pathOf* answers where a file was, since a `File` on its own only knows
   * its name — a directory picker fills in `webkitRelativePath` and a folder
   * drop has to be followed as it is walked.
   */
  function group(files, pathOf) {
    const skins = new Map();
    for (const file of files) {
      const name = skinOf(pathOf(file));
      if (!name) continue;
      if (!skins.has(name)) {
        skins.set(name, { name, images: new Map(), config: null, meta: null });
      }
      const skin = skins.get(name);
      const plain = file.name.toLowerCase();
      if (plain === 'ext_config.ini') skin.config = file;
      else if (plain === 'cm_skin.json') skin.meta = file;
      else if (IMAGE.test(file.name)) skin.images.set(plain, file);
    }
    return skins;
  }

  /**
   * Read what a skin states, and hold it against the car it is for.
   *
   * *worn* is every texture name the model names and *materials* every
   * material it has, both lowercased. A skin is worth offering for the
   * pictures it replaces even when it says nothing else; one that names a
   * material the car has not got — a config copied from another car, which
   * happens — keeps its textures and loses only its colour.
   */
  async function read(skin, { worn }) {
    const config = skin.config ? await skin.config.text() : '';
    let colours = skin.meta ? paintColours(await skin.meta.text()) : [];
    // Half of them have no `cm_skin.json` at all and say it in their config.
    if (!colours.length && config) colours = configColours(config, skin.name);
    return {
      name: skin.name,
      images: skin.images,
      replaces: [...skin.images.keys()].filter((n) => worn.has(n)).length,
      named: config ? paintMaterials(config) : [],
      colours,
      /* And how much of that colour each material is actually drawn at,
       * which is stated in the same section and is the difference between a
       * white car and a silver one. */
      brightness: config ? paintBrightness(config, skin.name) : new Map(),
      /* And what this skin says its surfaces are made of, over whatever the
       * car says about the same ones. */
      finish: config ? materialFinish(config, skin.name) : new Map(),
      /* And the meshes this skin takes away — a number plate a livery does not
       * want, which is the commonest thing a model replacement says and is
       * said in a skin far more often than beside the car. */
      hidden: config ? carReplacements(config, skin.name).hidden : new Set(),
      /* And the picture of the paint, which nearly all of them carry. Whether
       * it is worth reading is settled later, once the car has said which of
       * its materials the paint is: handed back rather than opened here, since
       * the pixels are the caller's to fetch. */
      livery: skin.images.get('livery.png') || null,
      paints: [],
    };
  }

  /**
   * Take the colour of a skin's chip as the colour it states, having none.
   *
   * Last of the three, and only where the other two said nothing: a picture is
   * weaker evidence than a setting, and where both are there they disagree
   * about a third of the time — usually because the setting is Content
   * Manager's untouched white and the chip is the paint.
   */
  function fromChip(skin, hex, pictures) {
    if (!hex || !skin.wantsChip) return skin;
    /* Marked as read off a picture, which is what settles how it is undone:
     * a chip is a picture of a swatch and so a display colour, where a paint
     * stated in a config is the game's own multiplier. */
    skin.colours = [{ key: 'livery', hex, enabled: true, gloss: null,
      reflection: null, picture: true }];
    skin.paints = pair(skin.settled || [], skin.colours,
      new Set(pictures.keys()), skin.brightness);
    return skin;
  }

  /**
   * The materials a paint shop's own slot names reach, for a car naming none.
   *
   * Three quarters of the cars here say which material the paint is, in a
   * config beside the skin or beside the car. The rest say it nowhere, and a
   * Lamborghini LM002's fourteen skins are the shape of it: every one states
   * its colour in `cm_skin.json` and not one of them, nor the car, carries an
   * `ext_config.ini` at all. Read for names alone the folder is silent and
   * fourteen good colours go nowhere.
   *
   * What is left is the name the paint shop filed the colour under. Content
   * Manager opens `carPaint` on a car that has told it nothing, and the
   * material the car actually wears is that name and a number: this one has
   * `carPaint02` over its doors and hood and `carPaint03` over its four
   * wheel-arch extenders, and the one stated colour belongs on both.
   *
   * Only a number, though. The same car has `carPaint_010101FF`, which is a
   * side-marker trim wearing its own colour in its own name — the author's
   * convention, and five materials here follow it. A slot name reaching that
   * would paint a black trim in body colour, so the tail has to be digits and
   * nothing else.
   */
  function slotMaterials(colours, materials) {
    const out = [];
    for (const colour of colours || []) {
      const slot = String(colour.key || '').toLowerCase();
      if (!slot) continue;
      for (const material of [...materials].sort()) {
        if (!material.startsWith(slot)) continue;
        const tail = material.slice(slot.length).replace(/^[_\-. ]+/, '');
        if (tail && !/^[0-9]+$/.test(tail)) continue;
        if (!out.includes(material)) out.push(material);
      }
    }
    return out;
  }

  /**
   * Which of the car's materials wear which of a skin's colours.
   *
   * One colour is the car's, however many materials the paint is spread over:
   * a Clio V6 names `wccarbody` and `aleron` — its body and its spoiler — and
   * states the one colour for both. Several are paired by order, which is the
   * only thing the two lists share.
   *
   * *brightness* is how much of that colour each material is drawn at, out of
   * the config beside it — see `paintBrightness`. A material the file says
   * nothing about is drawn at the whole of what it states.
   */
  function pair(named, colours, materials, brightness) {
    const out = [];
    const scales = brightness || new Map();
    for (let at = 0; at < named.length; at++) {
      const colour = colours.length === 1 ? colours[0] : colours[at];
      if (!stated(colour)) continue;
      if (!materials.has(named[at].toLowerCase())) continue;
      const scale = scales.get(named[at].toLowerCase());
      out.push({ material: named[at], hex: colour.hex,
        scale: typeof scale === 'number' ? scale : 1,
        picture: colour.picture === true });
    }
    return out;
  }

  /* Words that mark a material as some other part of the car than its
   * paint — the vocabulary its wheels, brakes, glass and cabin actually
   * carry. `CarPaintMaterial` has been seen naming one of these by mistake:
   * a Ferrari Mondial's own `extension/ext_config.ini` names `EXT_RIM_AO`,
   * the ambient occlusion baked into its wheel rims, and every one of its
   * twelve skins comes up unpainted for it — nothing wrong with the file,
   * the file just says the wrong thing.
   *
   * Matched whole, not as a substring: a car naming its side trim `Trim` is
   * not a rim for containing "rim" — that is the middle of "Trim" — and a
   * Honda Prelude's own `remap__prim_env_19_spec_` is not one either. Reading
   * either as a wheel is worse than missing it. */
  const NOT_PAINT_WORDS = new Set(['rim', 'wheel', 'tyre', 'tire', 'brake', 'caliper',
    'disc', 'glass', 'lens', 'chrome', 'light', 'lamp', 'mirror', 'interior', 'seat',
    'carpet', 'dash', 'leather', 'steer', 'pedal', 'gauge', 'plastic', 'plate',
    'exhaust', 'badge', 'logo']);

  /* A material name split into its words — on punctuation, digits and the
   * casing itself, so `EXT_RIM_AO` and `ExtRimAo` come apart the same way. */
  function words(name) {
    const out = [];
    for (const chunk of String(name).split(/[^A-Za-z]+/)) {
      if (chunk) out.push(...chunk.replace(/(?<=[a-z])(?=[A-Z])/g, ' ').toLowerCase().split(' '));
    }
    return out;
  }

  /* And what a car's paint is usually called, when it is named at all.
   * Takes precedence over NOT_PAINT_WORDS: a material naming its own
   * paintwork wins even where it also happens to carry one of the other
   * words. Matched as a substring rather than a whole word — unlike the
   * wheel-and-cabin vocabulary above, nothing in a car's own parts happens
   * to contain "paint". */
  const IS_PAINT = /body.?paint|car.?paint|paint|ext.?body|wc.?body|bodywork/i;

  /** Whether a material named as the car's paint reads like some other part. */
  function suspectPaint(name) {
    if (IS_PAINT.test(name)) return false;
    return words(name).some((word) => NOT_PAINT_WORDS.has(word)
      || (word.endsWith('s') && NOT_PAINT_WORDS.has(word.slice(0, -1))));
  }

  /**
   * The car's own material to use instead, where every material *named*
   * reads like a wheel, a brake, a lamp or the cabin rather than paint.
   *
   * Only where the car's own materials name exactly one thing that reads
   * like paint and is not the same kind of mistake itself. More than one
   * such material is not chosen among: the one thing this is sure of is
   * that *named* is probably wrong, and a wrong guess dressed as a
   * correction is worse than none.
   *
   * *materials* is every material name the car has, lowercased; *casing*
   * gets a lowered name back to how the file spelled it.
   */
  function paintCorrection(named, materials, casing) {
    if (!named.length || !named.every(suspectPaint)) return null;
    const candidates = [...materials].filter((m) => IS_PAINT.test(m) && !suspectPaint(m));
    if (candidates.length !== 1) return null;
    const found = candidates[0];
    return [casing.get(found) || found];
  }

  /**
   * Settle what a car's paint is called, and put each skin's colour on it.
   *
   * Three places say so, in the order they are trusted: the skin's own config;
   * the car's `extension/ext_config.ini`, since half of them declare it once
   * for the whole car; and last what the car's *other* skins agree it is.
   *
   * That last one is a reading of the folder rather than of one file, and it
   * is what a folder of skins usually needs. An Audi S8 has thirteen: three
   * name `booody_aooo`, which the car has, and five name `carpaint`, which it
   * has not — configs copied from another car, colour and all. Left there,
   * those five state a perfectly good colour and put it nowhere. Only a skin
   * that names nothing the car has is answered this way, and only from names
   * its own siblings used.
   */
  function settle(skins, { pictures, fallback, brightness, materialNames }) {
    /* The car's own word, read for each skin rather than once for the car: a
     * config states some of its settings per skin — a 550 Maranello writes
     * its body once for its reds and once for its silvers — so a single
     * reading of it is the reading for no skin at all. */
    const carSays = typeof brightness === 'function'
      ? brightness : () => brightness || new Map();
    //: Material name -> the picture it wears, both lowercased.
    const materials = new Set(pictures.keys());
    //: A lowered material name -> how the file actually spelled it.
    const casing = new Map();
    for (const name of materialNames || []) {
      const low = String(name).toLowerCase();
      if (!casing.has(low)) casing.set(low, name);
    }
    const known = [];
    for (const skin of skins) {
      for (const name of skin.named) {
        if (materials.has(name.toLowerCase()) && !known.includes(name)) known.push(name);
      }
    }
    for (const skin of skins) {
      let named = skin.named.filter((n) => materials.has(n.toLowerCase()));
      if (!named.length) named = (fallback || []).filter((n) => materials.has(n.toLowerCase()));
      if (!named.length) named = known;
      /* And for a car that named the paint in none of those three, the name
       * the paint shop filed the colour under. Weakest of the four, and last
       * for the same reason the chip is: a slot name is what Content Manager
       * opened at rather than anything the car said about itself. */
      if (!named.length) named = slotMaterials(skin.colours, materials);
      /* And whether what got settled on reads like the car's paint at all —
       * see `paintCorrection`. Corrected in place rather than only noted:
       * this is the viewer, and a car whose config points its paint at its
       * own wheel shading should not draw pale for it when the material it
       * plainly meant sits right there. `paintSuspect` says so regardless of
       * whether a correction was found, so the car can too. */
      if (named.length && named.every(suspectPaint)) {
        const corrected = paintCorrection(named, materials, casing);
        skin.paintSuspect = { stated: named, corrected };
        if (corrected) named = corrected;
      }
      skin.settled = named;
      /* A skin's own reading of how bright its paint is, over the car's.
       * Both are the same setting in the same shape of section — one written
       * beside the model for every skin, one written for this skin — and a
       * skin that states it means it for itself. */
      skin.brightness = new Map([...carSays(skin.name),
        ...(skin.brightness || new Map())]);
      skin.paints = pair(named, skin.colours, materials, skin.brightness);
      /* A skin that states a colour and ends with no material to put it on has
       * lost its paint: nothing among the files that came with the car says
       * which material the paint is, and not even the paint shop's own slot
       * name reaches one — usually because the car's own
       * `extension/ext_config.ini`, the one place a whole car declares it, was
       * not among them. Marked so the car can say so rather than coming up
       * unpainted as if nothing had gone wrong. */
      skin.paintLost = !!skin.colours.length && !skin.paints.length && !named.length;
      /* And whether the picture of the paint is worth reading, which is for
       * the skins that came out of all that with nothing on the car.
       *
       * Nothing painted rather than nothing stated: an Audi RS4's Nardo Grey
       * states two colours and neither is the body's — they are its wheels,
       * in slots the car pairs with nothing — and its body slot is the
       * untouched white that says nothing at all. Asked whether the skin
       * stated anything it answers yes and the body goes unpainted, which is
       * the one thing the chip is there to prevent.
       *
       * Only where the skin does not bring the paint's own picture. A skin
       * that replaces the very texture the paint material wears has put the
       * colour there already, and painting the chip over the top paints it
       * twice: a Lancia Beta Montecarlo's seven skins each replace the
       * `LANCIA_body.dds` that `lancia_body_paint` wears and say nothing else
       * at all, so read the other way round every one of its liveries comes
       * out under a flat wash of its own average.
       *
       * A chip is the weakest of the three readings and this is where it
       * stops: what the skin has already drawn beats a picture of a swatch. */
      skin.wantsChip = !!skin.livery && !skin.paints.length
        && !named.some((name) => {
          const picture = pictures.get(name.toLowerCase());
          return !!picture && skin.images.has(picture);
        });
    }
    return skins;
  }

  return { group, read, settle, pair, stated, unset, skinOf, rgbHex, paintMaterials, paintColour,
    paintColours, configColours, chipColour, fromChip, paintBrightness,
    materialFinish, carReplacements, slotMaterials, suspectPaint, paintCorrection };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = FbxSkins;
