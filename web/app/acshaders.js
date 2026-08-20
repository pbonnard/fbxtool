/**
 * What an Assetto Corsa shader name says about the material wearing it.
 *
 * The same table as `fbxtool/acshaders.py`, and it has to stay the same: a car
 * opened in the browser and the same car described by `fbxinfo` are meant to be
 * the same car. `tests/test_acshaders.py` reads both and compares them.
 *
 * A `.kn5` material names its shader and then states three dozen loose numbers,
 * and which of those numbers mean anything depends entirely on the name. The
 * names are compositional — `ksPerPixelMultiMap_AT_NMDetail` is
 * `ksPerPixelMultiMap` with alpha testing and a detail normal — so a name is
 * read as a base with suffixes rather than looked up whole, which is what lets
 * a shader nobody here has seen still be described correctly.
 *
 * Everything here is settled by `tools/shader_census.py` over the cars to hand.
 * Two of its findings shape the whole module: `ksAlphaRef` is nought on every
 * alpha-tested material counted, and `blurLevel`, `dirtyLevel` and `glowLevel`
 * are nought on every material that states them — they are what the game writes
 * per frame out of wheel speed, dirt and heat, and a car sitting still has none
 * of any of them.
 */
const FbxAcShaders = (() => {
  /* What each texture slot is, wherever it is bound. The roles are this
   * project's own names, shared with the palette and the exporters. */
  const SLOT_ROLES = {
    txDiffuse: 'baseColor',
    txNormal: 'normal',
    /* Not a metallic-roughness map however much it looks like one: its channels
     * drive the game's own Blinn-Phong highlight, and read as PBR it is a map
     * drawn from the wrong end. 201 of the 528 materials counted bind one, so
     * it is the largest single thing a car loses on the way through here. */
    txMaps: 'acMaps',
    txDetail: 'detail',
    txNormalDetail: 'detailNormal',
    // A real emissive map, unlike `txGlow`: `ksPerPixelMultiMap_AT_emissive`
    // binds it beside a block of `ksEmissive1`..`ksEmissive6` channel levels.
    txEmissive: 'emissive',
    // Heat in a brake disc — 10 of the 10 that bind it — at nought on a car
    // at rest.
    txGlow: 'glow',
    /* What the surface turns into as it spins. A tyre and a disc each bind a
     * blurred colour and a blurred relief, and `blurLevel` says how far between
     * the two the wheel currently is: nought, parked. */
    txBlur: 'blur',
    txNormalBlur: 'normalBlur',
    // What a tyre picks up off the track, at `dirtyLevel` — nought, parked.
    txDirty: 'dirt',
    // And what a car accumulates as it is driven into things.
    txDust: 'dust',
    txDamage: 'damage',
    txDamageMask: 'damageMask',
  };

  /* Slots whose level the file states as nought because the game writes it per
   * frame. Bound, carried, and not to be drawn at the level the file gives. */
  const RUNTIME_SLOTS = new Set(['txGlow', 'txBlur', 'txNormalBlur', 'txDirty',
    'txDust', 'txDamage', 'txDamageMask']);

  /* The levels those slots are driven at, so a reader can tell a stated nought
   * from an absent one. */
  const RUNTIME_LEVELS = {
    txGlow: 'glowLevel',
    txBlur: 'blurLevel',
    txNormalBlur: 'blurLevel',
    txDirty: 'dirtyLevel',
    txDust: 'dirt',
    txDamage: 'damageZones',
  };

  /* What the game cuts an alpha-tested surface at when the material says
   * nought, which every alpha-tested material counted does. */
  const ALPHA_REF_DEFAULT = 0.5;

  /* The shader bases, with what each one is beyond the suffixes on its name. */
  const FAMILIES = {
    ksPerPixel: { family: 'perPixel' },
    /* A per-texel highlight out of `txMaps`, a grain out of `txDetail` tiled
     * `detailUVMultiplier` times across the surface — a median of 100, and up
     * to 5000 — and `useDetail` saying whether the grain is worn at all. */
    ksPerPixelMultiMap: {
      family: 'multiMap', detail: true, normalMap: true, acMaps: true,
    },
    /* The world in a cube map, which nothing here has: the viewer lights from
     * an analytic sky, so this stays an approximation whichever way the switch
     * is set. Its highlight is the tightest of any family — a median exponent
     * of 200 against the 20 a multi-map states — which is what chrome is. */
    ksPerPixelReflection: { family: 'reflection' },
    ksPerPixelSimpleRefl: { family: 'reflection' },
    // A tyre: a clean tread, a blurred one, a dirty one, and two levels the
    // game writes per frame to say how far between them the wheel is.
    ksTyres: { family: 'tyres', normalMap: true },
    // A disc: the same blur, plus the heat glow.
    ksBrakeDisc: { family: 'brakeDisc', normalMap: true },
    // Always blended — 7 of the 7 counted — and the only family that is.
    ksWindscreen: { family: 'windscreen', blended: true },
    ksBrokenGlass: { family: 'windscreen', normalMap: true, blended: true },
    // A diffuse that answers a grazing light the way cloth and unpolished
    // stone do, at the `fRoughness` it states.
    ksOrenNayar: { family: 'orenNayar' },
  };

  /* The suffixes a name is built out of, longest first so that `NMDetail` is
   * read as itself rather than as `NM` with `Detail` left over.
   *
   * A suffix is written both ways round and the same name may do both:
   * `ksPerPixelAT` runs it straight on, `ksPerPixelAT_NM` puts an underscore
   * before the next one, and `ksPerPixelMultiMap_AT_NMDetail` underscores every
   * one. So each is tried underscored first and then bare. */
  const SUFFIXES = [
    ['NMDetail', { normalMap: true, detailNormal: true }],
    ['damage_dirt', { damage: true, dirt: true }],
    ['emissive', { emissiveMap: true }],
    ['damage', { damage: true }],
    ['UVMult', { uvMultiplier: true }],
    ['dirt', { dirt: true }],
    ['UV2', { secondUv: true }],
    ['AT', { alphaTested: true }],
    ['NM', { normalMap: true }],
    ['NS', {}],
  ];

  /* netKar Pro's shaders, which a few cars still carry. They are the same
   * surfaces under an older prefix, so they are read as the ks- ones. */
  const ALIASES = { ne: 'ks', sm: 'ks' };

  const FLAGS = ['alphaTested', 'normalMap', 'detail', 'detailNormal', 'acMaps',
    'damage', 'dirt', 'emissiveMap', 'secondUv', 'uvMultiplier', 'blended'];

  /** A shader under another vendor's prefix, said the house way. */
  function alias(name) {
    for (const [prefix, house] of Object.entries(ALIASES)) {
      if (name.startsWith(prefix) && name.length > prefix.length
        && name[prefix.length] === name[prefix.length].toUpperCase()
        && name[prefix.length] !== name[prefix.length].toLowerCase()) {
        return house + name.slice(prefix.length);
      }
    }
    return name;
  }

  /**
   * What a shader name says, read as a base with suffixes.
   *
   * The result is the same shape for a name in `FAMILIES` and for one nobody
   * here has seen; `known` says which it was.
   */
  function describe(shader) {
    const name = alias(String(shader || '').trim());
    const out = { shader: String(shader || '') };
    for (const flag of FLAGS) out[flag] = false;

    /* The suffixes come off one at a time and in the order listed, so that a
     * name wearing several — `_AT_NMDetail` — gives up all of them.
     *
     * Underscored, the match ignores case: the separator is enough to say a
     * suffix is what it is. Bare, it does not: `AT` run straight onto a name
     * has only its capitals to mark it out, and matching loosely would find one
     * at the end of any word ending in those letters. */
    let base = name;
    let peeled = true;
    while (peeled) {
      peeled = false;
      for (const [suffix, says] of SUFFIXES) {
        const marked = `_${suffix}`;
        if (base.length > marked.length
          && base.toLowerCase().endsWith(marked.toLowerCase())) {
          base = base.slice(0, -marked.length);
        } else if (base.length > suffix.length && base.endsWith(suffix)) {
          base = base.slice(0, -suffix.length);
        } else {
          continue;
        }
        Object.assign(out, says);
        peeled = true;
        break;
      }
    }

    let entry = FAMILIES[base] || FAMILIES[name];
    out.known = entry !== undefined;
    /* A name that peeled down to nothing recognisable is still described by its
     * suffixes; `ksPerPixel` is what every one of these families is
     * underneath. */
    if (entry === undefined) {
      entry = FAMILIES[name.split('_')[0]] || { family: 'perPixel' };
    }
    out.family = entry.family || 'perPixel';
    for (const flag of FLAGS) if (entry[flag]) out[flag] = true;

    // A multi-map states its `txMaps` and its grain whichever suffixes follow.
    if (out.family === 'multiMap') {
      out.acMaps = true;
      out.detail = true;
      out.normalMap = true;
    }
    out.base = base || name;
    return out;
  }

  /**
   * What a texture slot is on this shader, or null for one nothing knows.
   *
   * One slot changes meaning with the shader and it is the important one: on
   * the families that model a car being crashed, `txNormal` is not the
   * surface's own relief but the dents blended in as damage accumulates. A car
   * as saved has none, so drawn as relief it puts creases down the whole of a
   * bonnet that has never been hit.
   */
  function slotRole(slot, shader) {
    if (slot === 'txNormal' && describe(shader).damage) return 'damageNormal';
    return SLOT_ROLES[slot] || null;
  }

  /* ------------------------------ what a surface is, as the game says it */

  /* What a plainly lit surface takes from the light: `ksAmbient` and
   * `ksDiffuse` at the pair most materials state them at. Of 1728 materials
   * across the 27 cars to hand, 0.5 and 0.6 is the commonest by a wide margin
   * — 278 of them, one in six, and the value the game's own editor starts a
   * material at. */
  const LIGHT_AMBIENT = 0.5;
  const LIGHT_DIFFUSE = 0.6;

  /* What a material that leaves the Fresnel out means by it, and no ceiling on
   * the term where none is stated. */
  const DEFAULT_FRESNEL_C = 0.05;
  const DEFAULT_FRESNEL_MAX = 1;

  /**
   * How much of the light a material takes, against a plainly lit one.
   *
   * `scalar` is `(name, default) -> number` — a material's own reader, or a
   * lookup into whatever the parameters were carried in.
   *
   * `ksAmbient` and `ksDiffuse` weight the two halves of the game's own
   * lighting rather than tinting anything. Both halves are diffuse, so in a
   * viewer with one fixed light the two weights have nowhere to go but the
   * albedo, where they are the same arithmetic: dimming the light that reaches
   * a surface and dimming the surface come to the same picture.
   *
   * This is the whole of why an Audi S8 comes up white from end to end. Its
   * paint is 0.4 and 0.4 and its wheels are 0.03 and 0.01; its headlight
   * housings are nothing at all. The pictures under those are grey panel maps
   * — the colour was never in the picture — so read without the weights the
   * rims, the lamps and the carbon mirror caps all draw as bright as the body.
   *
   * A quarter of them ask for more light than a plainly lit surface gets,
   * which a dashboard or a lamp lens does on purpose. A diffuse surface cannot
   * return more than it was given, so that is where this stops.
   */
  function lightWeight(scalar) {
    const weight = (scalar('ksAmbient', LIGHT_AMBIENT)
      + scalar('ksDiffuse', LIGHT_DIFFUSE)) / (LIGHT_AMBIENT + LIGHT_DIFFUSE);
    return Math.min(Math.max(weight, 0), 1);
  }

  /**
   * What a surface actually reflects facing you.
   *
   * `fresnelC` is the Schlick base and `fresnelMaxLevel` is a ceiling on the
   * whole term — not the value at a grazing angle, which is what the pair
   * reads like until you see the numbers. A BMW Z3M's `lightclear` states 1.0
   * and 0.03: read as a base it is a perfect mirror, and read as a ceiling it
   * is the three per cent a clear lens reflects. An Alfa TZ2's `EXT_TYRE`
   * settles it — it states 5.0, which is not a reflectance at all and can only
   * be a number something clamps, beside a ceiling of 0.02.
   *
   * The two always travel together: of 1853 materials across the cars to hand,
   * 1075 state both and 778 state neither, and not one states only one of
   * them. So reading the first without the second is reading half of a
   * sentence, and it is the half that turns a tail lamp and a tyre into
   * mirrors.
   */
  function reflectance(scalar) {
    const facing = scalar('fresnelC', DEFAULT_FRESNEL_C);
    const ceiling = scalar('fresnelMaxLevel', DEFAULT_FRESNEL_MAX);
    return Math.min(Math.max(Math.min(facing, ceiling), 0), 1);
  }

  /**
   * How many times a picture is tiled across a surface, where the shader
   * states it.
   *
   * `ksPerPixelNM_UVMult` gives the colour and the relief a multiplier each,
   * at a median of 12.5 and 195 across the 32 materials that state them. A
   * stated nought is a multiplier nobody set rather than one set to nothing —
   * half of them write it for the colour — and taken literally it would
   * collapse the whole picture into its first texel.
   */
  function tiling(scalar, name) {
    const stated = scalar(name, 0);
    return stated > 0 ? stated : 1;
  }

  /** A lookup into a plain object of stated numbers, as the two above want.
   *
   * A property read back out of a record tree is a number where the file wrote
   * one number and a list where it wrote several, and a `Number` property that
   * came through a template arrives as a list of one. All three mean the same
   * thing here, so all three are read. */
  const statedScalar = (stated) => (name, fallback) => {
    const raw = (stated || {})[name];
    const value = Array.isArray(raw) ? Number(raw[0]) : Number(raw);
    return Number.isFinite(value) ? value : fallback;
  };

  return {
    describe,
    slotRole,
    SLOT_ROLES,
    RUNTIME_SLOTS,
    RUNTIME_LEVELS,
    FAMILIES,
    ALPHA_REF_DEFAULT,
    lightWeight,
    reflectance,
    tiling,
    statedScalar,
    LIGHT_AMBIENT,
    LIGHT_DIFFUSE,
    DEFAULT_FRESNEL_C,
    DEFAULT_FRESNEL_MAX,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = FbxAcShaders;
