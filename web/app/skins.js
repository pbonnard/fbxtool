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
    for (const line of String(text || '').split(/\r?\n/)) {
      const heading = /^\s*\[([^\]]*)\]/.exec(line);
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
    for (const line of String(text || '').split(/\r?\n/)) {
      const heading = /^\s*\[([^\]]*)\]/.exec(line);
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
    skin.colours = [{ key: 'livery', hex, enabled: true, gloss: null, reflection: null }];
    skin.paints = pair(skin.settled || [], skin.colours, new Set(pictures.keys()));
    return skin;
  }

  /**
   * Which of the car's materials wear which of a skin's colours.
   *
   * One colour is the car's, however many materials the paint is spread over:
   * a Clio V6 names `wccarbody` and `aleron` — its body and its spoiler — and
   * states the one colour for both. Several are paired by order, which is the
   * only thing the two lists share.
   */
  function pair(named, colours, materials) {
    const out = [];
    for (let at = 0; at < named.length; at++) {
      const colour = colours.length === 1 ? colours[0] : colours[at];
      if (!stated(colour)) continue;
      if (!materials.has(named[at].toLowerCase())) continue;
      out.push({ material: named[at], hex: colour.hex });
    }
    return out;
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
  function settle(skins, { pictures, fallback }) {
    //: Material name -> the picture it wears, both lowercased.
    const materials = new Set(pictures.keys());
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
      skin.settled = named;
      skin.paints = pair(named, skin.colours, materials);
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
    paintColours, configColours, chipColour, fromChip };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = FbxSkins;
