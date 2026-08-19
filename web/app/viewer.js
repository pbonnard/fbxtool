/* WebGL2 viewport: orbit camera, per-material shading, and axis correction.
 *
 * Geometry arrives already triangulated from the WebAssembly core, so this
 * only uploads buffers and draws.
 *
 * Shading is physically based: a GGX specular lobe over a Lambert diffuse,
 * lit by one sun and by an analytic studio environment. A car is mostly
 * reflections, so the environment — not the sun — is what makes it read as a
 * real surface, and the same environment is drawn behind the model so what it
 * reflects is what you can see.
 */
'use strict';

const FbxViewer = (function () {
  /* Below this, a material is drawn in the blended pass. Some exporters write
   * 0.999 for "opaque", which is not worth a second pass. */
  const OPAQUE = 0.996;

  /* What a material says about its own coverage, as the shader numbers it.
   * `BLEND` takes the alpha of its colour texture as it is; `MASK` cuts the
   * surface away below the threshold beside it and is solid everywhere else.
   * Anything the file did not say is opaque. */
  const ALPHA_MODES = { BLEND: 1, MASK: 2, OPAQUE: 0 };

  /* How far a grain is allowed to lighten or darken the surface under it.
   *
   * A grain is taken as neutral at its own average, which means dividing by
   * that average — and a map that is almost black, or one whose alpha came
   * back as nothing, asks to be multiplied by a number with no ceiling. An
   * Audi S8's paint asks for ten and gets eight. Read from here by the export
   * as well, since what is written out has to be what was on screen. */
  const GRAIN_FLOOR = 0.1;
  const GRAIN_CEILING = 8;

  /* How many rows of the palette a material takes, and the power a plain
   * Schlick Fresnel rises over.
   *
   * Five is the shape of the term every file but a game's own implies, so it
   * is what a material that states no exponent gets — and it is the ceiling
   * on a stated one as well, since the number is there to say a surface
   * reflects across more of itself than a fifth power does, never less. */
  const PALETTE_ROWS = 7;
  const SCHLICK_POWER = 5;

  /* The three-quarter view a model opens on. */
  const VIEW_YAW = 0.9;
  const VIEW_PITCH = 0.28;
  const QUARTER_TURN = Math.PI / 2;

  /* Shared by the model and background shaders: one studio environment, in
   * linear radiance. A bright horizon band is what paint and chrome pick up. */
  const ENVIRONMENT = `
  const vec3 ENV_ZENITH  = vec3(0.090, 0.110, 0.150);
  const vec3 ENV_HORIZON = vec3(0.380, 0.400, 0.440);
  const vec3 ENV_GROUND  = vec3(0.012, 0.013, 0.016);
  const vec3 ENV_SOFTBOX = vec3(0.900, 0.910, 0.950);
  const vec3 SUN_COLOUR  = vec3(2.600, 2.520, 2.360);
  const vec3 SUN_DIR     = normalize(vec3(0.35, 0.85, 0.40));

  /** Radiance arriving from direction dir, sun excluded. */
  vec3 environmentColour(vec3 dir) {
    float t = clamp(dir.y, -1.0, 1.0);
    // A narrow band where the halves meet: wide enough to catch a curved
    // panel, tight enough to read as a horizon rather than a grey wash.
    vec3 base = t >= 0.0
      ? mix(ENV_HORIZON, ENV_ZENITH, smoothstep(0.0, 0.16, t))
      : mix(ENV_HORIZON, ENV_GROUND, smoothstep(0.0, 0.12, -t));
    // An overhead softbox, so bonnets and roofs have something to reflect.
    return base + ENV_SOFTBOX * smoothstep(0.62, 0.99, t);
  }

  /** Cosine-weighted average of that environment about a normal. */
  vec3 environmentIrradiance(vec3 n) {
    vec3 sky = mix(ENV_HORIZON, ENV_ZENITH, 0.55) + ENV_SOFTBOX * 0.06;
    vec3 ground = mix(ENV_HORIZON, ENV_GROUND, 0.7);
    return mix(ground, sky, clamp(n.y * 0.5 + 0.5, 0.0, 1.0));
  }

  /** What a surface of this roughness reflects: sharp, then blurring out. */
  vec3 environmentSpecular(vec3 r, float roughness) {
    return mix(environmentColour(r), environmentIrradiance(r),
               clamp(roughness * 1.4, 0.0, 1.0));
  }

  // Filmic curve, so highlights roll off instead of clipping to white.
  vec3 toneMap(vec3 x) {
    return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
  }

  // Linear -> sRGB, the real piecewise transfer rather than a 2.2 power.
  vec3 encodeSrgb(vec3 c) {
    vec3 low = c * 12.92;
    vec3 high = 1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055;
    return mix(low, high, step(vec3(0.0031308), c));
  }`;

  /* Shared by the model and the ground: how much sun reaches a point.
   *
   * The map is rendered once per mesh from the sun's direction, so orbiting
   * the camera costs nothing. Comparison sampling gives 2x2 filtering in the
   * hardware, and four taps around the point soften the edge further. */
  const SHADOW_LOOKUP = `
  uniform highp sampler2DShadow uShadowMap;
  uniform mat4 uShadowMatrix;
  uniform float uShadowTexel;   // one texel in shadow-map space
  uniform int uShadowReady;

  float sunlight(vec3 worldPosition, float slope) {
    if (uShadowReady == 0) return 1.0;
    vec4 shadowPosition = uShadowMatrix * vec4(worldPosition, 1.0);
    vec3 coord = shadowPosition.xyz / shadowPosition.w * 0.5 + 0.5;
    // Nothing outside the map is in shadow: it simply was not drawn.
    if (coord.x < 0.0 || coord.x > 1.0 || coord.y < 0.0 || coord.y > 1.0
        || coord.z > 1.0) return 1.0;
    // A surface facing away from the sun needs more slack against its own depth.
    coord.z -= mix(0.0015, 0.006, clamp(slope, 0.0, 1.0));
    float sum = 0.0;
    for (int y = -1; y <= 1; y += 2) {
      for (int x = -1; x <= 1; x += 2) {
        vec2 at = coord.xy + vec2(float(x), float(y)) * uShadowTexel;
        sum += texture(uShadowMap, vec3(at, coord.z));
      }
    }
    return sum * 0.25;
  }`;

  /* Depth only, from the sun's point of view. */
  const SHADOW_VERTEX = `#version 300 es
  precision highp float;
  layout(location = 0) in vec3 aPosition;
  layout(location = 4) in float aPart;
  uniform mat4 uShadowMatrix;
  uniform mat4 uModel;

  /* Pulling a scene apart: every part slides away from the middle, along the
   * line from the model's centre to its own, so nothing crosses anything else
   * and each piece ends up where you would expect to find it. */
  uniform highp sampler2D uParts;   // one texel per part: its centre
  uniform int uPartCount;
  uniform float uExplode;
  uniform vec3 uCentre;

  vec3 explode(vec3 position, float part) {
    if (uExplode <= 0.0 || uPartCount <= 0) return position;
    int index = int(part + 0.5);
    if (index < 0 || index >= uPartCount) return position;
    vec3 centre = texelFetch(uParts, ivec2(index, 0), 0).xyz;
    return position + (centre - uCentre) * uExplode;
  }
  void main() {
    gl_Position = uShadowMatrix * uModel * vec4(explode(aPosition, aPart), 1.0);
  }`;

  const SHADOW_FRAGMENT = `#version 300 es
  precision highp float;
  void main() {}`;

  /* The floor the model stands on: a disc under the scene, fading out. */
  const GROUND_VERTEX = `#version 300 es
  precision highp float;
  layout(location = 0) in vec2 aCorner;
  uniform mat4 uModelView;
  uniform mat4 uProjection;
  uniform float uRadius;
  uniform float uHeight;
  out vec3 vWorld;
  void main() {
    vWorld = vec3(aCorner.x * uRadius, uHeight, aCorner.y * uRadius);
    gl_Position = uProjection * uModelView * vec4(vWorld, 1.0);
  }`;

  const GROUND_FRAGMENT = `#version 300 es
  precision highp float;
  in vec3 vWorld;
  uniform float uRadius;
  out vec4 fragColour;
${ENVIRONMENT}
${SHADOW_LOOKUP}

  void main() {
    // Lit by the sky above it, darkened where the model blocks the sun.
    float shadow = sunlight(vWorld, 0.0);
    vec3 sky = mix(ENV_HORIZON, ENV_ZENITH, 0.55) + ENV_SOFTBOX * 0.06;
    vec3 albedo = vec3(0.06);
    vec3 lit = albedo * (sky + SUN_COLOUR * max(SUN_DIR.y, 0.0) * shadow * 0.45);

    // A pool of floor around the model rather than a room: solid under it,
    // gone a few radii out, with no edge anywhere to give it away.
    float fade = 1.0 - smoothstep(0.08, 0.5, length(vWorld.xz) / uRadius);
    fragColour = vec4(encodeSrgb(toneMap(lit)), fade);
  }`;

  /* A full-screen triangle showing the environment behind the model. */
  const BACKGROUND_VERTEX = `#version 300 es
  precision highp float;
  out vec2 vClip;
  void main() {
    vec2 corner = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
    vClip = corner * 2.0 - 1.0;
    gl_Position = vec4(vClip, 1.0, 1.0);
  }`;

  const BACKGROUND_FRAGMENT = `#version 300 es
  precision highp float;
  in vec2 vClip;
  uniform mat4 uInvProjection;
  uniform mat3 uViewToWorld;
  out vec4 fragColour;
${ENVIRONMENT}
  void main() {
    vec4 atNear = uInvProjection * vec4(vClip, 1.0, 1.0);
    vec3 dir = normalize(uViewToWorld * normalize(atNear.xyz / atNear.w));
    // Darkened: the backdrop should not compete with the model it lights.
    fragColour = vec4(encodeSrgb(toneMap(environmentColour(dir) * 0.2)), 1.0);
  }`;
  const VERTEX_SHADER = `#version 300 es
  precision highp float;
  layout(location = 0) in vec3 aPosition;
  layout(location = 1) in vec3 aNormal;
  layout(location = 2) in float aMaterial;
  layout(location = 3) in vec2 aUv;
  layout(location = 4) in float aPart;

  uniform mat4 uModelView;
  uniform mat4 uProjection;
  uniform mat3 uNormalMatrix;
  uniform mat4 uModel;

  out vec3 vNormal;
  out vec3 vViewPosition;
  out vec3 vWorld;
  out float vMaterial;
  out vec2 vUv;
  flat out int vPart;

  /* Pulling a scene apart: every part slides away from the middle, along the
   * line from the model's centre to its own, so nothing crosses anything else
   * and each piece ends up where you would expect to find it. */
  uniform highp sampler2D uParts;   // one texel per part: its centre
  uniform int uPartCount;
  uniform float uExplode;
  uniform vec3 uCentre;

  vec3 explode(vec3 position, float part) {
    if (uExplode <= 0.0 || uPartCount <= 0) return position;
    int index = int(part + 0.5);
    if (index < 0 || index >= uPartCount) return position;
    vec3 centre = texelFetch(uParts, ivec2(index, 0), 0).xyz;
    return position + (centre - uCentre) * uExplode;
  }

  void main() {
    vec3 position = explode(aPosition, aPart);
    vec4 viewPosition = uModelView * vec4(position, 1.0);
    vViewPosition = viewPosition.xyz;
    // The same space the environment and the shadow map are in: the model
    // placed and turned the right way up, before the camera.
    vWorld = (uModel * vec4(position, 1.0)).xyz;
    vNormal = uNormalMatrix * aNormal;
    vMaterial = aMaterial;
    vUv = aUv;
    vPart = int(aPart + 0.5);
    gl_Position = uProjection * viewPosition;
  }`;

  /* The same geometry again, drawn as part numbers rather than as a picture,
   * so a click can be answered with the part under it. */
  const PICK_VERTEX = `#version 300 es
  precision highp float;
  layout(location = 0) in vec3 aPosition;
  layout(location = 4) in float aPart;
  uniform mat4 uModelView;
  uniform mat4 uProjection;
  flat out int vPart;

  /* Pulling a scene apart: every part slides away from the middle, along the
   * line from the model's centre to its own, so nothing crosses anything else
   * and each piece ends up where you would expect to find it. */
  uniform highp sampler2D uParts;   // one texel per part: its centre
  uniform int uPartCount;
  uniform float uExplode;
  uniform vec3 uCentre;

  vec3 explode(vec3 position, float part) {
    if (uExplode <= 0.0 || uPartCount <= 0) return position;
    int index = int(part + 0.5);
    if (index < 0 || index >= uPartCount) return position;
    vec3 centre = texelFetch(uParts, ivec2(index, 0), 0).xyz;
    return position + (centre - uCentre) * uExplode;
  }

  void main() {
    vPart = int(aPart + 0.5);
    gl_Position = uProjection * uModelView * vec4(explode(aPosition, aPart), 1.0);
  }`;

  const PICK_FRAGMENT = `#version 300 es
  precision highp float;
  flat in int vPart;
  out vec4 fragColour;
  void main() {
    // Numbered from one, so that nothing at all reads as zero.
    int id = vPart + 1;
    fragColour = vec4(
      float(id & 255) / 255.0,
      float((id >> 8) & 255) / 255.0,
      float((id >> 16) & 255) / 255.0,
      1.0);
  }`;

  const FRAGMENT_SHADER = `#version 300 es
  precision highp float;

  in vec3 vNormal;
  in vec3 vViewPosition;
  in vec3 vWorld;
  in float vMaterial;
  in vec2 vUv;
  flat in int vPart;

  uniform int uMode;          // 0 file colours, 1 index colours, 2 clay, 3 normals
  uniform vec3 uClayColour;
  //: Row 1 of the part texture: what colour of lens each part is, and whether
  //: it is one at all. A part's own, since a car's lamps share one material.
  uniform highp sampler2D uParts;
  // Explicitly high, since a fragment shader defaults an int to medium and the
  // vertex stage does not — and a uniform whose precision differs between the
  // two is a program that will not link.
  uniform highp int uPartCount;
  uniform sampler2D uPalette;      // two rows per material: colour, then finish
  uniform int uPaletteSize;
  // GLSL ES 3.0 has no default precision for array samplers, unlike sampler2D.
  uniform highp sampler2DArray uTextures; // one layer per distinct image
  // Metallic-roughness maps, stored linear: these are numbers, not a picture.
  uniform highp sampler2DArray uFinish;
  // Bump and normal maps, linear for the same reason.
  uniform highp sampler2DArray uBump;
  uniform highp sampler2DArray uDetail;
  uniform int uUseTextures;
  uniform mat3 uViewToWorld;  // the environment stays put as the camera orbits
  uniform int uPass;          // 0 opaque, 1 blended
  uniform float uOpaqueLimit;
  uniform int uHighlight;     // material group to pick out, or -1
  uniform int uSelected;      // part picked with the mouse, or -1

  out vec4 fragColour;
${ENVIRONMENT}
${SHADOW_LOOKUP}

  const float PI = 3.141592653589793;

  // Distinct hues per material index without a lookup table.
  vec3 indexColour(float id) {
    float hue = fract(id * 0.6180339887);
    vec3 k = vec3(3.0, 2.0, 1.0);
    vec3 p = abs(fract(vec3(hue) + k / 3.0) * 6.0 - 3.0);
    vec3 rgb = clamp(p - 1.0, 0.0, 1.0);
    float sat = 0.55 + 0.25 * fract(id * 0.7548776662);
    return mix(vec3(0.85), rgb, sat);
  }

  /* Trowbridge-Reitz (GGX) normal distribution. */
  float distributionGgx(float noh, float a) {
    float a2 = a * a;
    float d = noh * noh * (a2 - 1.0) + 1.0;
    return a2 / max(PI * d * d, 1e-7);
  }

  /* Height-correlated Smith visibility, the fast approximation. */
  float visibilitySmith(float nov, float nol, float a) {
    float l = nol * (nov * (1.0 - a) + a);
    float v = nov * (nol * (1.0 - a) + a);
    return 0.5 / max(l + v, 1e-5);
  }

  vec3 fresnelSchlick(vec3 f0, float u) {
    return f0 + (1.0 - f0) * pow(1.0 - u, 5.0);
  }

  /* The same term with the two numbers a game's material spends on it.
   *
   * Schlick's is one shape — a base rising to a mirror over a fifth power —
   * and a kn5 writes both of those loose: fresnelEXP is how fast the
   * reflection comes up as the surface turns away, and fresnelMaxLevel is
   * how far it is let get. Reading only the base is reading the smallest of
   * the three: a Jaguar's paint states nought, half and a quarter, which is a
   * body reflecting a quarter of what is around it everywhere but dead
   * head-on — and taken as a base alone it is a matte panel.
   *
   * The ceiling holds in the other direction just as often. The median
   * across the 3427 materials to hand is 0.1, so what a fifth power does at a
   * grazing angle — rise to a mirror — is the thing most of them spent a
   * number saying they do not do.
   */
  vec3 fresnelStated(vec3 f0, float u, float power, float ceiling) {
    // An exponent of nought is the rise at its full height from every angle,
    // which 626 of the materials to hand ask for and pow() will not answer.
    float rise = power <= 0.0 ? 1.0 : pow(1.0 - u, power);
    return min(f0 + (1.0 - f0) * rise, vec3(ceiling));
  }

  /* The frame a tangent-space map is written in, worked out here rather than
   * stored on the mesh.
   *
   * A normal map is written against the surface's own axes — U to the right, V
   * up, the normal out — and turning one back into a world direction needs
   * those axes. A mesh usually does not carry them, and a .max never does, so
   * they are recovered from how the position and the texture coordinate change
   * across neighbouring pixels: two vectors along the surface and two along
   * the map, which is enough to solve for the frame. Degenerate where a
   * triangle has no area in one of the two, which is what the guard is for.
   */
  mat3 surfaceFrame(vec3 n, vec3 position, vec2 uv) {
    vec3 dpx = dFdx(position);
    vec3 dpy = dFdy(position);
    vec2 duvx = dFdx(uv);
    vec2 duvy = dFdy(uv);
    vec3 perpY = cross(dpy, n);
    vec3 perpX = cross(n, dpx);
    vec3 tangent = perpY * duvx.x + perpX * duvy.x;
    vec3 bitangent = perpY * duvx.y + perpX * duvy.y;
    float longest = max(dot(tangent, tangent), dot(bitangent, bitangent));
    if (longest < 1e-16) return mat3(1.0);
    return mat3(tangent * inversesqrt(longest), bitangent * inversesqrt(longest), n);
  }

  /* Karis' analytic fit for the split-sum environment BRDF. */
  vec3 environmentBrdf(vec3 f0, float roughness, float nov) {
    const vec4 c0 = vec4(-1.0, -0.0275, -0.572, 0.022);
    const vec4 c1 = vec4(1.0, 0.0425, 1.04, -0.04);
    vec4 r = roughness * c0 + c1;
    float a004 = min(r.x * r.x, exp2(-9.28 * nov)) * r.x + r.y;
    vec2 ab = vec2(-1.04, 1.04) * a004 + r.zw;
    return f0 * ab.x + ab.y;
  }

  void main() {
    // Flat-shade from screen-space derivatives when a normal is degenerate,
    // so meshes without usable normals still read as solid.
    vec3 normal = normalize(vNormal);
    if (!all(lessThan(abs(normal), vec3(1e3))) || dot(normal, normal) < 0.5) {
      normal = normalize(cross(dFdx(vViewPosition), dFdy(vViewPosition)));
    }
    if (!gl_FrontFacing) normal = -normal;

    // The material index is a whole number carried in a float attribute.
    int slot = clamp(int(vMaterial + 0.5), 0, max(uPaletteSize - 1, 0));

    /* What the surface is shaped like between its own vertices.
     *
     * The fourth row says which map, how strongly, and which of the two kinds
     * it is. A normal map states the direction outright, three channels for
     * three components. A bump map states a height and the direction is its
     * slope, taken from the neighbouring texels — which is why it is sampled
     * four more times rather than once.
     *
     * This happens before anything is shaded and before the normal preview, so
     * what lights the surface and what is drawn as its normal are the same
     * thing.
     */
    if (uPaletteSize > 0 && uUseTextures == 1) {
      vec4 relief = texelFetch(uPalette, ivec2(slot, 3), 0);
      int bumpLayer = int(relief.r + 0.5) - 1;
      if (bumpLayer >= 0) {
        vec3 uvw = vec3(vUv, float(bumpLayer));
        vec3 tangentNormal;
        if (relief.b > 0.5) {
          tangentNormal = texture(uBump, uvw).xyz * 2.0 - 1.0;
          tangentNormal.xy *= relief.g;
        } else {
          // Central differences, a texel either side. The height is the red
          // channel: a bump map is grey, and where it is not, red is the
          // channel every convention agrees on.
          float left = textureOffset(uBump, uvw, ivec2(-1, 0)).r;
          float right = textureOffset(uBump, uvw, ivec2(1, 0)).r;
          float down = textureOffset(uBump, uvw, ivec2(0, -1)).r;
          float up = textureOffset(uBump, uvw, ivec2(0, 1)).r;
          tangentNormal = vec3((left - right) * relief.g, (down - up) * relief.g, 1.0);
        }
        if (dot(tangentNormal, tangentNormal) > 1e-8) {
          mat3 frame = surfaceFrame(normal, vViewPosition, vUv);
          normal = normalize(frame * normalize(tangentNormal));
        }
      }
    }

    if (uMode == 3) {
      fragColour = vec4(normal * 0.5 + 0.5, 1.0);
      return;
    }

    vec3 albedo;
    vec3 f0 = vec3(0.04);       // a plain dielectric, unless the file says more
    float roughness = 0.55;
    float opacity = 1.0;
    int group = -1;
    // A clear coat: a sharp mirror laid over whatever the surface otherwise
    // is. Zero for everything that has none, which is most things.
    float coatF0 = 0.0;
    float coatRoughness = 0.05;
    /* How the file asked to be blended: 0 opaque, 1 blended by the alpha of
     * its own colour texture, 2 cut out against it.
     *
     * An opacity factor is not the only place transparency lives, and on a
     * racing game's cars it is not where any of it lives: a windscreen states
     * no factor at all and keeps its 26% in the alpha channel of the picture
     * it wears, a badge keeps its outline there, and a tail lamp its tint.
     * Read as a factor alone every one of them is a solid panel. */
    int alphaMode = 0;
    float alphaCutoff = 0.0;
    // The third row holds opacity and which material group this slot belongs
    // to; the group is wanted in every shading mode, for the highlight.
    vec4 extra = vec4(0.0, -1.0, 0.0, 0.0);
    if (uPaletteSize > 0) {
      extra = texelFetch(uPalette, ivec2(slot, 2), 0);
      opacity = clamp(extra.r, 0.0, 1.0);
      group = int(extra.g + 0.5);
      vec4 over = texelFetch(uPalette, ivec2(slot, 4), 0);
      coatF0 = clamp(over.r, 0.0, 1.0);
      coatRoughness = clamp(over.g, 0.05, 1.0);
      alphaMode = int(over.b + 0.5);
      alphaCutoff = over.a;
    }
    // How much of a colour a lamp lens is, which is how much of a filter it
    // is. Not the same as the tint flag below, which says whether a
    // material colour is read through its picture.
    float lensFilter = 0.0;
    // And the picture itself, kept for the metalness split further down.
    vec3 picture = vec3(1.0);
    if (uMode == 0 && uPaletteSize > 0) {
      vec4 entry = texelFetch(uPalette, ivec2(slot, 0), 0);
      vec4 finish = texelFetch(uPalette, ivec2(slot, 1), 0);
      albedo = entry.rgb;
      f0 = finish.rgb;
      roughness = clamp(finish.a, 0.05, 1.0);
      // The alpha of the first row carries this material's texture layer,
      // offset by one so that zero means "no texture".
      int layer = int(entry.a + 0.5) - 1;
      // Whether the colour tints the texture or the texture replaces it.
      bool tinted = texelFetch(uPalette, ivec2(slot, 3), 0).a > 0.5;
      if (uUseTextures == 1 && layer >= 0) {
        // A bound diffuse texture replaces the flat colour, as most DCC tools
        // and viewers treat it — unless the material says the colour is a tint
        // to be multiplied through it, which is how a car's paint is stated.
        // The sampler is sRGB, so this is already linear.
        vec4 painted = texture(uTextures, vec3(vUv, float(layer)));
        picture = painted.rgb;
        albedo = tinted ? painted.rgb * albedo : painted.rgb;
        /* …and its fourth channel is how much of the surface is there, for a
         * material that said that is where its transparency lives.
         *
         * Cut out at or below the threshold rather than under it: a file that
         * states a threshold of zero means "drop what is not there at all",
         * and taken strictly that would keep every hole in a grille. One
         * eight-bit step is the floor, because the sampler filters between
         * mip levels and a badge's transparent surround comes back a hair
         * above zero a level or two down — kept, it draws as a solid box
         * around the badge, since a cut-out surface is opaque wherever it is
         * drawn at all. */
        if (alphaMode == 2 && painted.a <= max(alphaCutoff, 1.0 / 255.0)) discard;
        if (alphaMode == 1) opacity *= painted.a;

        /* The grain tiled over it, where the material wears one.
         *
         * A game's interior is one atlas of flat panels with the leather, the
         * carpet and the carbon laid over them — tiled sixty or a hundred
         * times across, so the picture underneath is the shape and the grain
         * is the surface.
         *
         * Taken as neutral at its own average, since the file says how many
         * times to tile it and not how much of it to mix in. The two readings
         * are far apart: a Mercedes E63's paint wears a grain averaging 0.24,
         * so multiplied straight its white body comes out graphite. This way
         * the colour a car was authored stays where it was, and what arrives
         * is the grain and the cast of the picture. */
        vec4 grain = texelFetch(uPalette, ivec2(slot, 5), 0);
        int detailLayer = int(grain.r + 0.5) - 1;
        if (detailLayer >= 0) {
          vec3 tiled = texture(uDetail,
            vec3(vUv * max(grain.g, 1e-4), float(detailLayer))).rgb;
          albedo *= clamp(tiled * grain.b, 0.0, 4.0);
        }
      }
      /* The lens this part is, where the car's lighting says it is one.
       *
       * A lamp's glass is the same colourless picture as every other lamp's on
       * the car; what makes one amber and another yellow is stated beside the
       * model, per mesh. So it tints what the surface lets through rather than
       * replacing it — a yellow lens over a grey reflector, which is what a
       * lamp is. */
      if (uPartCount > 0) {
        vec4 lens = texelFetch(uParts, ivec2(vPart, 1), 0);
        if (lens.a > 0.5) {
          /* How much of a colour of its own the lens is, which is the whole of
           * what this turns on. A tint stated white or grey is a darkening of
           * the glass that is there — so it multiplies, and white changes
           * nothing. A tint stated amber is the lens: the picture under it is
           * one flat grey square shared by every lamp on the car and carries
           * nothing to keep, so the colour stands in its place. */
          lensFilter = max(lens.r, max(lens.g, lens.b))
            - min(lens.r, min(lens.g, lens.b));
          albedo = mix(albedo * lens.rgb, lens.rgb, lensFilter);
        }
      }

      /* A metallic-roughness map, where the material has one.
       *
       * The palette arrives already split into a diffuse and a reflectance by
       * one metalness for the whole material. A map says the metalness is
       * different at every texel — so the split is undone and done again here,
       * per pixel. Without this a tyre whose file leaves metallicFactor out
       * takes glTF's default of 1 and draws as a white mirror: at full
       * metalness the diffuse term is cancelled outright, and the tread the
       * base colour image carries never reaches the screen. */
      int finishLayer = int(extra.b + 0.5) - 1;
      if (uUseTextures == 1 && finishLayer >= 0) {
        // glTF keeps roughness in green and metalness in blue, each of them
        // multiplying the factor stated beside it.
        vec3 mr = texture(uFinish, vec3(vUv, float(finishLayer))).rgb;
        float stated = clamp(extra.a, 0.0, 1.0);
        /* The colour before the split, which is what the metalness is applied
         * to again per pixel.
         *
         * The two halves put back together, times the picture where the
         * material reads its colour through one. Taking the albedo as it
         * stands instead undoes nothing: a material tinting its texture has
         * already had the split multiplied into it, and at full metalness that
         * is zero — and a glTF whose base colour factor multiplies its base
         * colour image, which is what glTF says it does, would draw black. */
        vec3 factor = stated >= 0.999 ? f0
          : entry.rgb / max(1.0 - stated, 1e-3);
        vec3 base = layer >= 0 ? (tinted ? picture * factor : picture) : factor;
        float m = clamp(stated * mr.b, 0.0, 1.0);
        roughness = clamp(roughness * mr.g, 0.05, 1.0);
        albedo = base * (1.0 - m);
        f0 = mix(vec3(0.04), base, m);
      }
    } else if (uMode == 1) {
      albedo = indexColour(vMaterial);
      opacity = 1.0;
      alphaMode = 0;
    } else {
      albedo = uClayColour;
      opacity = 1.0;
      alphaMode = 0;
    }

    // Picking a material out of the list marks where it is on the model.
    bool marked = uHighlight >= 0 && group == uHighlight;
    if (marked) albedo = mix(albedo, vec3(1.0, 0.42, 0.05), 0.85);
    // A part chosen with the mouse, kept a different colour from a material
    // picked out of the list, and kept light enough to still read as itself.
    if (uSelected >= 0 && vPart == uSelected) {
      albedo = mix(albedo, vec3(0.15, 0.62, 1.0), 0.55);
    }

    /* Each pass takes the half of the scene it is set up to draw.
     *
     * Which half a triangle belongs to is a property of its material and not
     * of the pixel: a windscreen whose alpha comes out of a texture is see-
     * through wherever that texture is, and drawing the sheet in the solid
     * pass where it happens to be opaque would lay down depth the glass behind
     * it then fails against. Cut-out materials stay solid — a grille with its
     * holes dropped is opaque everywhere it is drawn at all. */
    bool blended = opacity < uOpaqueLimit || alphaMode == 1;
    if (blended != (uPass == 1)) discard;

    vec3 viewDir = normalize(-vViewPosition);
    // Lighting happens in world space so the environment does not swing around
    // with the camera; only the two directions need rotating.
    vec3 n = normalize(uViewToWorld * normal);
    vec3 v = normalize(uViewToWorld * viewDir);
    vec3 r = reflect(-v, n);
    float nov = clamp(dot(n, v), 1e-4, 1.0);
    float a = max(roughness * roughness, 1e-3);

    // Specular takes its energy from the surface, so diffuse gives some up.
    vec3 diffuseColour = albedo * (1.0 - max(max(f0.r, f0.g), f0.b));

    // One sun.
    vec3 l = SUN_DIR;
    vec3 h = normalize(l + v);
    float nol = max(dot(n, l), 0.0);
    float noh = max(dot(n, h), 0.0);
    float voh = max(dot(v, h), 0.0);
    /* What the coat reflects, and so what it keeps from reaching the paint
     * under it. A clear coat is a second, sharper surface: light bounces off
     * it first, and only what it lets through — one minus its Fresnel — meets
     * the base at all. Left out, a car's paint is whatever its base coat
     * alone is, which for a V-Ray body is dark satin and reads as plastic. */
    float coatA = max(coatRoughness * coatRoughness, 1e-3);
    float coatFacing = coatF0 > 0.0 ? fresnelSchlick(vec3(coatF0), nov).r : 0.0;
    float under = 1.0 - coatFacing;

    /* How much of the sun's highlight this surface takes.
     *
     * A game's material states it outright and most other files do not, so a
     * material that says nothing takes all of it. It weighs the sun's
     * highlight alone: what the surface returns of the world around it is a
     * Fresnel term and is stated separately, so chrome told to take no
     * highlight is still chrome. */
    float sunSpecular = uPaletteSize > 0 && uMode == 0
      ? texelFetch(uPalette, ivec2(slot, 5), 0).a : 1.0;

    /* And the shape of what this surface returns of the world around it: how
     * fast it comes up as the surface turns away, and how far it is let get.
     * A file that stated neither is the plain Schlick, which is what the two
     * defaults are. */
    vec2 shape = vec2(${SCHLICK_POWER}.0, 1.0);
    if (uPaletteSize > 0 && uMode == 0) {
      shape = texelFetch(uPalette, ivec2(slot, 6), 0).rg;
    }

    vec3 direct = vec3(0.0);
    if (nol > 0.0) {
      vec3 specular = fresnelStated(f0, voh, shape.x, shape.y)
        * (distributionGgx(noh, a) * visibilitySmith(nov, nol, a) * sunSpecular);
      vec3 beneath = (diffuseColour / PI + specular) * under;
      if (coatF0 > 0.0) {
        float coatSpec = fresnelSchlick(vec3(coatF0), voh).r
          * (distributionGgx(noh, coatA) * visibilitySmith(nov, nol, coatA));
        beneath += vec3(coatSpec);
      }
      // Whatever the model puts between this point and the sun.
      float shadow = sunlight(vWorld, 1.0 - nol);
      direct = beneath * SUN_COLOUR * nol * shadow;
    }

    /* The environment, which is what makes a curved surface read as a surface
     * — and on car paint is the whole of what makes it read as paint.
     *
     * The split-sum fit integrates a Schlick over the lobe, so what is handed
     * to it is this surface's own Fresnel already evaluated at this angle
     * rather than its head-on base. For a material that stated nothing the
     * two are the same reading; for one that stated a broad rise held under a
     * low ceiling they are a body reflecting the room against a matte panel. */
    vec3 reflectance = environmentBrdf(
      fresnelStated(f0, nov, shape.x, shape.y), roughness, nov);
    vec3 ambient = (diffuseColour * environmentIrradiance(n)
      + environmentSpecular(r, roughness) * reflectance) * under;
    vec3 coatReflectance = vec3(0.0);
    if (coatF0 > 0.0) {
      coatReflectance = environmentBrdf(vec3(coatF0), coatRoughness, nov);
      ambient += environmentSpecular(r, coatRoughness) * coatReflectance;
    }

    /* What a sheet of glass hides is what it lets through plus what it
     * reflects, and at a grazing angle it reflects nearly everything — which
     * is why a windscreen goes opaque as it turns away from you.
     *
     * And a lens you can see a colour in is a lens you cannot see through. A
     * tint is a filter: what makes it amber is that it stops everything but
     * the amber, so the more of a colour it is the less of what stands behind
     * it comes past. How saturated it is says that and how dark it is does not
     * — a headlight's plain quarter grey is a darkening, not a filter, and it
     * stays as clear as it was. */
    float mirrored = clamp(dot(reflectance * under + coatReflectance,
                               vec3(0.2126, 0.7152, 0.0722)), 0.0, 1.0);
    float coverage = clamp(opacity + (1.0 - opacity) * max(mirrored, lensFilter), 0.0, 1.0);

    // A marked material glows a little, so it reads even where it is in shadow.
    vec3 lit = direct + ambient + (marked ? vec3(0.35, 0.12, 0.01) : vec3(0.0));
    fragColour = vec4(encodeSrgb(toneMap(lit)), marked ? 1.0 : coverage);
  }`;

  /* ------------------------------------------------------------- matrices */

  function identity() {
    return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  }

  /** The sun, matching SUN_DIR in the shaders. */
  const SUN = (() => {
    const v = [0.35, 0.85, 0.40];
    const length = Math.hypot(...v);
    return v.map((c) => c / length);
  })();

  /** A symmetric box, for the sun's view of the scene. */
  function orthographic(radius, depth) {
    const near = 0.01;
    const out = new Float32Array(16);
    out[0] = 1 / radius;
    out[5] = 1 / radius;
    out[10] = -2 / (depth - near);
    out[14] = -(depth + near) / (depth - near);
    out[15] = 1;
    return out;
  }

  function perspective(fovY, aspect, near, far) {
    const f = 1 / Math.tan(fovY / 2);
    const out = new Float32Array(16);
    out[0] = f / aspect;
    out[5] = f;
    out[10] = (far + near) / (near - far);
    out[11] = -1;
    out[14] = (2 * far * near) / (near - far);
    return out;
  }

  function lookAt(eye, target, up) {
    const z = normalize([eye[0] - target[0], eye[1] - target[1], eye[2] - target[2]]);
    let x = normalize(cross(up, z));
    if (!isFinite(x[0]) || (x[0] === 0 && x[1] === 0 && x[2] === 0)) x = [1, 0, 0];
    const y = cross(z, x);
    const out = new Float32Array(16);
    out[0] = x[0]; out[4] = x[1]; out[8] = x[2];
    out[1] = y[0]; out[5] = y[1]; out[9] = y[2];
    out[2] = z[0]; out[6] = z[1]; out[10] = z[2];
    out[12] = -(x[0] * eye[0] + x[1] * eye[1] + x[2] * eye[2]);
    out[13] = -(y[0] * eye[0] + y[1] * eye[1] + y[2] * eye[2]);
    out[14] = -(z[0] * eye[0] + z[1] * eye[1] + z[2] * eye[2]);
    out[15] = 1;
    return out;
  }

  function multiply(a, b) {
    const out = new Float32Array(16);
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1]
          + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
      }
    }
    return out;
  }

  function cross(a, b) {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  }

  function normalize(v) {
    const len = Math.hypot(v[0], v[1], v[2]);
    return len ? [v[0] / len, v[1] / len, v[2] / len] : [0, 0, 0];
  }

  /** Upper-left 3x3 of a matrix; adequate while the model matrix is a rotation,
   *  or a rotation with an axis mirrored — both are their own inverse
   *  transpose, which is what a normal is properly carried by. */
  function normalMatrix(m) {
    return new Float32Array([m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]]);
  }

  /** Inverse of a matrix from `perspective`, which is sparse enough to invert
   *  term by term. */
  function inversePerspective(p) {
    const out = new Float32Array(16);
    out[0] = 1 / p[0];
    out[5] = 1 / p[5];
    out[11] = 1 / p[14];
    out[14] = -1;
    out[15] = p[10] / p[14];
    return out;
  }

  /** The rotation that takes view space back to world space. A view matrix
   *  from `lookAt` is orthonormal, so its inverse is its transpose. */
  function viewToWorld(view) {
    return new Float32Array([
      view[0], view[4], view[8],
      view[1], view[5], view[9],
      view[2], view[6], view[10],
    ]);
  }

  /** Rotate Z-up geometry into the viewer's Y-up world: -90 degrees about X,
   *  so mesh +Z becomes world +Y and mesh +Y becomes world -Z.  Columns are
   *  the images of the basis vectors, this being column-major. */
  function zUpToYUp() {
    const m = identity();
    m[0] = 1; m[1] = 0; m[2] = 0;    // X -> X
    m[4] = 0; m[5] = 0; m[6] = -1;   // Y -> -Z
    m[8] = 0; m[9] = 1; m[10] = 0;   // Z -> Y
    return m;
  }

  /* --------------------------------------------------------------- viewer */

  class Viewer {
    constructor(canvas) {
      this.canvas = canvas;
      this.gl = canvas.getContext('webgl2', {
        antialias: true, alpha: false, depth: true, preserveDrawingBuffer: true,
      });
      if (!this.gl) throw new Error('WebGL2 is not available in this browser');
      /* What the last upload cost and whether it worked. A scene of several
       * million triangles is hundreds of megabytes of vertex buffers, and a
       * card that cannot find the room says so once, quietly, in a return
       * value nobody reads — leaving a viewport that draws nothing over a
       * status line that says how many triangles are in it. */
      this.uploadError = null;
      this.uploadBytes = 0;
      // Losing the context happens a frame or more after the upload that
      // caused it, so there is nobody left to return a failure to: whoever
      // wants to say so is told when it happens.
      this.canvas.addEventListener('webglcontextlost', (event) => {
        event.preventDefault();
        this.uploadError = 'the graphics context was lost';
        if (this.onDrawFailure) this.onDrawFailure(this.uploadError, this.uploadBytes);
      });

      this.mode = 0;
      this.upAxis = 'y';
      /** Which of the mesh's own axes are mirrored, as ±1 per axis. */
      this.flips = [1, 1, 1];
      this.hasUv = false;
      this.showTextures = true;
      this.triangleCount = 0;
      this.yaw = 0.7;
      this.pitch = 0.35;
      this.distance = 4;
      this.target = [0, 0, 0];
      this.radius = 1;
      /** Quarter turns added to the heading the model opens on. */
      this.heading = 0;
      this.autoRotate = false;
      this.dirty = true;
      this._frame = 0;

      this._initProgram();
      this._initBuffers();
      this._initGround();
      this._bindInput();

      const gl = this.gl;
      gl.enable(gl.DEPTH_TEST);
      gl.enable(gl.CULL_FACE);
      gl.cullFace(gl.BACK);
      gl.clearColor(0.086, 0.094, 0.114, 1);

      this._loop = this._loop.bind(this);
      requestAnimationFrame(this._loop);
    }

    _compile(type, source) {
      const gl = this.gl;
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        throw new Error(`shader failed to compile: ${gl.getShaderInfoLog(shader)}`);
      }
      return shader;
    }

    _initProgram() {
      const gl = this.gl;
      const program = gl.createProgram();
      gl.attachShader(program, this._compile(gl.VERTEX_SHADER, VERTEX_SHADER));
      gl.attachShader(program, this._compile(gl.FRAGMENT_SHADER, FRAGMENT_SHADER));
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        throw new Error(`program failed to link: ${gl.getProgramInfoLog(program)}`);
      }
      this.program = program;
      this.uniforms = {
        modelView: gl.getUniformLocation(program, 'uModelView'),
        projection: gl.getUniformLocation(program, 'uProjection'),
        normalMatrix: gl.getUniformLocation(program, 'uNormalMatrix'),
        mode: gl.getUniformLocation(program, 'uMode'),
        clayColour: gl.getUniformLocation(program, 'uClayColour'),
        palette: gl.getUniformLocation(program, 'uPalette'),
        paletteSize: gl.getUniformLocation(program, 'uPaletteSize'),
        textures: gl.getUniformLocation(program, 'uTextures'),
        finish: gl.getUniformLocation(program, 'uFinish'),
        bump: gl.getUniformLocation(program, 'uBump'),
        detail: gl.getUniformLocation(program, 'uDetail'),
        useTextures: gl.getUniformLocation(program, 'uUseTextures'),
        viewToWorld: gl.getUniformLocation(program, 'uViewToWorld'),
        pass: gl.getUniformLocation(program, 'uPass'),
        opaqueLimit: gl.getUniformLocation(program, 'uOpaqueLimit'),
        highlight: gl.getUniformLocation(program, 'uHighlight'),
        selected: gl.getUniformLocation(program, 'uSelected'),
        parts: gl.getUniformLocation(program, 'uParts'),
        partCount: gl.getUniformLocation(program, 'uPartCount'),
        explode: gl.getUniformLocation(program, 'uExplode'),
        centre: gl.getUniformLocation(program, 'uCentre'),
      };

      this.pickProgram = this._link(PICK_VERTEX, PICK_FRAGMENT, 'pick');
      this.pickUniforms = {
        modelView: gl.getUniformLocation(this.pickProgram, 'uModelView'),
        projection: gl.getUniformLocation(this.pickProgram, 'uProjection'),
        parts: gl.getUniformLocation(this.pickProgram, 'uParts'),
        partCount: gl.getUniformLocation(this.pickProgram, 'uPartCount'),
        explode: gl.getUniformLocation(this.pickProgram, 'uExplode'),
        centre: gl.getUniformLocation(this.pickProgram, 'uCentre'),
      };

      const background = gl.createProgram();
      gl.attachShader(background, this._compile(gl.VERTEX_SHADER, BACKGROUND_VERTEX));
      gl.attachShader(background, this._compile(gl.FRAGMENT_SHADER, BACKGROUND_FRAGMENT));
      gl.linkProgram(background);
      if (!gl.getProgramParameter(background, gl.LINK_STATUS)) {
        throw new Error(`background program failed to link: ${gl.getProgramInfoLog(background)}`);
      }
      this.backgroundProgram = background;
      this.backgroundUniforms = {
        invProjection: gl.getUniformLocation(background, 'uInvProjection'),
        viewToWorld: gl.getUniformLocation(background, 'uViewToWorld'),
      };
      // A vertex array is still required to draw, even with no attributes.
      this.backgroundVao = gl.createVertexArray();

      this.shadowProgram = this._link(SHADOW_VERTEX, SHADOW_FRAGMENT, 'shadow');
      this.shadowUniforms = {
        parts: gl.getUniformLocation(this.shadowProgram, 'uParts'),
        partCount: gl.getUniformLocation(this.shadowProgram, 'uPartCount'),
        explode: gl.getUniformLocation(this.shadowProgram, 'uExplode'),
        centre: gl.getUniformLocation(this.shadowProgram, 'uCentre'),
        shadowMatrix: gl.getUniformLocation(this.shadowProgram, 'uShadowMatrix'),
        model: gl.getUniformLocation(this.shadowProgram, 'uModel'),
      };

      this.groundProgram = this._link(GROUND_VERTEX, GROUND_FRAGMENT, 'ground');
      this.groundUniforms = {
        modelView: gl.getUniformLocation(this.groundProgram, 'uModelView'),
        projection: gl.getUniformLocation(this.groundProgram, 'uProjection'),
        radius: gl.getUniformLocation(this.groundProgram, 'uRadius'),
        height: gl.getUniformLocation(this.groundProgram, 'uHeight'),
      };
      this.uniforms.model = gl.getUniformLocation(program, 'uModel');
      for (const [name, uniforms] of [[this.groundProgram, this.groundUniforms],
        [program, this.uniforms]]) {
        Object.assign(uniforms, {
          shadowMap: gl.getUniformLocation(name, 'uShadowMap'),
          shadowMatrix: gl.getUniformLocation(name, 'uShadowMatrix'),
          shadowTexel: gl.getUniformLocation(name, 'uShadowTexel'),
          shadowReady: gl.getUniformLocation(name, 'uShadowReady'),
        });
      }
    }

    _link(vertexSource, fragmentSource, label) {
      const gl = this.gl;
      const program = gl.createProgram();
      gl.attachShader(program, this._compile(gl.VERTEX_SHADER, vertexSource));
      gl.attachShader(program, this._compile(gl.FRAGMENT_SHADER, fragmentSource));
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        throw new Error(`${label} program failed to link: ${gl.getProgramInfoLog(program)}`);
      }
      return program;
    }

    /** A depth buffer rendered from the sun, and a quad for the floor. */
    _initGround() {
      const gl = this.gl;
      this.shadowSize = 2048;
      this.shadowTexture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.shadowTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, this.shadowSize,
        this.shadowSize, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
      // Comparison sampling: the hardware filters the depth test itself.
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindTexture(gl.TEXTURE_2D, null);

      this.shadowBuffer = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.shadowBuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D,
        this.shadowTexture, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      this.shadowReady = false;
      this.shadowStale = true;
      this.showGround = true;
      this.shadowRenders = 0;

      this.groundVao = gl.createVertexArray();
      gl.bindVertexArray(this.groundVao);
      this.groundBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.groundBuffer);
      gl.bufferData(gl.ARRAY_BUFFER,
        new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.bindVertexArray(null);
    }

    /**
     * The sun's view of the scene: an orthographic box just large enough to
     * hold the model, so the depth map spends its resolution on the model.
     */
    _shadowMatrix() {
      const radius = Math.max(this.radius, 1e-4) * 1.15;
      const distance = radius * 3;
      const eye = SUN.map((v) => v * distance);
      const view = lookAt(eye, [0, 0, 0], [0, 1, 0]);
      const projection = orthographic(radius, radius * 4);
      return multiply(projection, view);
    }

    _initBuffers() {
      const gl = this.gl;
      this.vao = gl.createVertexArray();
      gl.bindVertexArray(this.vao);
      this.positionBuffer = gl.createBuffer();
      this.normalBuffer = gl.createBuffer();
      this.materialBuffer = gl.createBuffer();
      this.uvBuffer = gl.createBuffer();
      this.partBuffer = gl.createBuffer();

      const attach = (buffer, location, size) => {
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.enableVertexAttribArray(location);
        gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0);
      };
      attach(this.positionBuffer, 0, 3);
      attach(this.normalBuffer, 1, 3);
      attach(this.materialBuffer, 2, 1);
      attach(this.uvBuffer, 3, 2);
      attach(this.partBuffer, 4, 1);
      /* The triangles sorted into the two halves of the scene, solid first.
       * An element buffer is no concern of `drawArrays`, so the passes that
       * want the whole mesh go on reading it exactly as they did. */
      this.orderBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.orderBuffer);
      gl.bindVertexArray(null);

      this.paletteTexture = gl.createTexture();
      this.paletteSize = 0;
      gl.bindTexture(gl.TEXTURE_2D, this.paletteTexture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindTexture(gl.TEXTURE_2D, null);

      this.textureArray = gl.createTexture();
      this.textureLayers = 0;
      this.finishArray = gl.createTexture();
      this.finishLayers = 0;
      this.bumpArray = gl.createTexture();
      this.bumpLayers = 0;
      this.detailArray = gl.createTexture();
      this.detailLayers = 0;
      this.hasTransparency = false;
      this.transparentMaterials = 0;
      this.highlight = -1;

      // One texel per part, holding where its middle is: the explode reads it
      // per vertex, so pulling the scene apart costs nothing to rebuild.
      this.partTexture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.partTexture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindTexture(gl.TEXTURE_2D, null);
      this.parts = [];
      this.partCount = 0;
      this.explode = 0;
      this.selectedPart = -1;
      this.pickBuffer = null;
      this.pickTexture = null;
      this.pickDepth = null;
      this.pickSize = [0, 0];
    }

    /**
     * The scene's parts: what each is called, where its middle is, and how big
     * it is. The centres drive the explode; the rest is what a click reports.
     */
    setParts(parts) {
      const gl = this.gl;
      this.parts = Array.isArray(parts) ? parts : [];
      this.partCount = this.parts.length;
      this.selectedPart = -1;
      if (!this.partCount) { this.dirty = true; return; }
      /* Two rows: where each part's middle is, and what colour of lens it is.
       *
       * The second is a part's own and not its material's — a car's glass is
       * one grey picture however many lamps wear it, and what makes a Renault
       * 5's fog lamps yellow and its indicators amber is stated per mesh in
       * the car's lighting config. Its `glass_fog` mesh wears the material its
       * `glass_platelight` mesh wears, and the two are given different
       * colours, so there is nowhere else for it to go. */
      const data = new Float32Array(this.partCount * 8);
      this.parts.forEach((part, i) => {
        const centre = part.centre || [0, 0, 0];
        data[i * 4] = centre[0];
        data[i * 4 + 1] = centre[1];
        data[i * 4 + 2] = centre[2];
        data[i * 4 + 3] = 1;
        const lens = Array.isArray(part.lens) ? part.lens : null;
        const at = (this.partCount + i) * 4;
        data[at] = lens ? lens[0] : 1;
        data[at + 1] = lens ? lens[1] : 1;
        data[at + 2] = lens ? lens[2] : 1;
        data[at + 3] = lens ? 1 : 0;
      });
      gl.bindTexture(gl.TEXTURE_2D, this.partTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, this.partCount, 2, 0,
        gl.RGBA, gl.FLOAT, data);
      gl.bindTexture(gl.TEXTURE_2D, null);
      this._updateRadius();
      this.dirty = true;
    }

    /** Hand a program everything the explode needs. */
    _bindParts(uniforms) {
      const gl = this.gl;
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, this.partTexture);
      gl.uniform1i(uniforms.parts, 3);
      gl.uniform1i(uniforms.partCount, this.partCount);
      gl.uniform1f(uniforms.explode, this.explode || 0);
      const centre = this.modelCentre || [0, 0, 0];
      gl.uniform3f(uniforms.centre, centre[0], centre[1], centre[2]);
      gl.activeTexture(gl.TEXTURE0);
    }

    /**
     * Upload the scene's real materials, one column per material in the order
     * they connect to the model, which is what the per-polygon material index
     * refers to.
     *
     * Seven rows: the diffuse colour with the texture layer in alpha, the
     * specular colour with roughness in alpha, then opacity, the material
     * group, the metallic-roughness map's layer and the metalness that map
     * scales, then the relief — which map shapes the surface, how strongly and
     * which kind it is — then the clear coat, which is how much a mirror
     * laid over the whole reflects and how polished that mirror is, beside how
     * the file asked to be blended and the threshold it asked to be cut at,
     * then the grain, and last the shape of the Fresnel: how fast what the
     * surface returns of the world rises as it turns away, and how far it is
     * let get.
     *
     * Floats, because the values are linear and eight bits of a linear ramp
     * bands badly in the darks — the Mercedes' interior sits at 0.05.
     */
    setPalette(materials) {
      const gl = this.gl;
      this.paletteSize = materials.length;
      this.hasTransparency = false;
      this.transparentMaterials = 0;
      if (!materials.length) {
        this.blendedSlots = null;
        this.orderStale = true;
        this.dirty = true;
        return;
      }
      const width = materials.length;
      const data = new Float32Array(width * PALETTE_ROWS * 4);
      //: Which slots are see-through, which is the same question the shader
      //: asks of the same two numbers a few lines from the bottom.
      const blendedSlots = new Uint8Array(width);
      materials.forEach((material, i) => {
        const rgb = material.colour || [0.72, 0.73, 0.76];
        const specular = material.specular || [0.04, 0.04, 0.04];
        for (let k = 0; k < 3; k++) {
          data[i * 4 + k] = Math.max(0, rgb[k] || 0);
          data[(width + i) * 4 + k] = Math.max(0, specular[k] || 0);
        }
        // Layer index + 1, so 0 reads as "this material has no texture".
        const layer = Number.isInteger(material.layer) ? material.layer : -1;
        data[i * 4 + 3] = Math.max(0, layer + 1);
        data[(width + i) * 4 + 3] = Math.min(1, Math.max(0.05,
          typeof material.roughness === 'number' ? material.roughness : 0.5));
        const opacity = typeof material.opacity === 'number'
          ? Math.min(1, Math.max(0, material.opacity)) : 1;
        data[(width * 2 + i) * 4] = opacity;
        // Which material this slot belongs to, for the highlight.
        data[(width * 2 + i) * 4 + 1] = Number.isInteger(material.group) ? material.group : -1;
        // The metallic-roughness map, the same way round as the diffuse one,
        // and the metalness it multiplies.
        const finishLayer = Number.isInteger(material.finishLayer) ? material.finishLayer : -1;
        data[(width * 2 + i) * 4 + 2] = Math.max(0, finishLayer + 1);
        data[(width * 2 + i) * 4 + 3] = typeof material.metallic === 'number'
          ? Math.min(1, Math.max(0, material.metallic)) : 0;
        // The map that shapes the surface: which layer, how strongly it is
        // taken, and whether it states a direction or a height.
        const bumpLayer = Number.isInteger(material.bumpLayer) ? material.bumpLayer : -1;
        data[(width * 3 + i) * 4] = Math.max(0, bumpLayer + 1);
        data[(width * 3 + i) * 4 + 1] = typeof material.bumpStrength === 'number'
          ? Math.max(0, material.bumpStrength) : 1;
        data[(width * 3 + i) * 4 + 2] = material.bumpIsNormalMap ? 1 : 0;
        /* Whether this material's colour tints its texture or is replaced by
         * it. Replaced, ordinarily — that is what most tools and viewers do
         * with a bound diffuse map, and a file's flat colour is a stand-in for
         * the picture rather than a thing to multiply through it. But the map
         * under a car's paint is the panels in white on black, and the colour
         * is what the game multiplies through it: replaced by the colour the
         * shut lines and the badge go with it, replaced by the map the car is
         * white whichever skin is on. */
        data[(width * 3 + i) * 4 + 3] = material.tintTexture ? 1 : 0;
        // The clear coat: how much of it comes back facing you, and how
        // polished it is. Nothing at zero, which is every surface without one.
        data[(width * 4 + i) * 4] = typeof material.coat === 'number'
          ? Math.min(1, Math.max(0, material.coat)) : 0;
        data[(width * 4 + i) * 4 + 1] = typeof material.coatRoughness === 'number'
          ? Math.min(1, Math.max(0.05, material.coatRoughness)) : 0.05;
        /* How the file asked to be blended, and against what.
         *
         * Only meaningful with a colour texture to read the alpha out of, so a
         * material that names none is left opaque rather than sent to a pass
         * that would draw it exactly as the solid one already had.
         */
        const painted = Number.isInteger(material.layer) && material.layer >= 0;
        const mode = painted ? ALPHA_MODES[material.alphaMode] || 0 : 0;
        data[(width * 4 + i) * 4 + 2] = mode;
        data[(width * 4 + i) * 4 + 3] = typeof material.alphaCutoff === 'number'
          ? Math.min(1, Math.max(0, material.alphaCutoff)) : 0.5;
        /* The grain tiled over the surface, and how many times across it.
         *
         * A game's interior is one atlas of flat panels with the leather, the
         * carpet and the carbon laid over them a hundred times across — an
         * Audi S8 has thirty-eight materials wearing one, and it is where nine
         * of the fifteen files in each of its skins go. Without it the cabin
         * is the atlas: flat grey shapes, and a skin that changes nothing. */
        const detailLayer = Number.isInteger(material.detailLayer)
          ? material.detailLayer : -1;
        data[(width * 5 + i) * 4] = Math.max(0, detailLayer + 1);
        data[(width * 5 + i) * 4 + 1] = typeof material.detailTiling === 'number'
          ? Math.max(0, material.detailTiling) : 1;
        // Taken as neutral at its own average, so a grain changes the surface
        // and not how bright the car is.
        data[(width * 5 + i) * 4 + 2] = typeof material.detailScale === 'number'
          ? Math.min(GRAIN_CEILING, Math.max(GRAIN_FLOOR, material.detailScale)) : 1;
        /* How much of the sun's highlight the surface takes, where the file
         * says. Nothing states it but a game's material, and one that says
         * nothing takes all of it. */
        data[(width * 5 + i) * 4 + 3] = typeof material.specularWeight === 'number'
          ? Math.min(1, Math.max(0, material.specularWeight)) : 1;
        /* And the shape of the Fresnel this surface returns the world with.
         *
         * A file that says nothing gets the plain Schlick — a fifth power,
         * with nothing over it — which is what every reader but a game's own
         * means by a reflection. A `.kn5` says both, and both matter: the
         * exponent is what makes a windscreen a sheet of glass across the
         * whole of itself rather than a rim of light at its edge, and the
         * ceiling is what keeps a rubber seal from turning to chrome there. */
        data[(width * 6 + i) * 4] = typeof material.fresnelExp === 'number'
          ? Math.min(SCHLICK_POWER, Math.max(0, material.fresnelExp)) : SCHLICK_POWER;
        data[(width * 6 + i) * 4 + 1] = typeof material.fresnelCeiling === 'number'
          ? Math.min(1, Math.max(0, material.fresnelCeiling)) : 1;
        if (opacity < OPAQUE || mode === 1) {
          this.hasTransparency = true;
          this.transparentMaterials++;
          blendedSlots[i] = 1;
        }
      });
      /* And whether that answer moved. Most of what this is called for — a
       * colour, a roughness, a name — leaves it where it was, and only a
       * material crossing between the two halves is worth walking half a
       * million triangles for. The sun's view changes with it. */
      const was = this.blendedSlots;
      let moved = !was || was.length !== width;
      if (!moved) {
        for (let i = 0; i < width; i++) {
          if (was[i] !== blendedSlots[i]) { moved = true; break; }
        }
      }
      if (moved) {
        this.orderStale = true;
        this.shadowStale = true;
      }
      this.blendedSlots = blendedSlots;
      gl.bindTexture(gl.TEXTURE_2D, this.paletteTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, PALETTE_ROWS, 0,
        gl.RGBA, gl.FLOAT, data);
      gl.bindTexture(gl.TEXTURE_2D, null);
      this.dirty = true;
    }

    /**
     * Upload decoded images as a 2D array texture, one layer each.
     *
     * Array layers must share dimensions, so every image is drawn into a
     * common square first. That costs some fidelity on non-square textures but
     * keeps the whole mesh to a single draw call.
     */
    async setTextures(images, edge = 1024) {
      this.textureLayers = images.length;
      // sRGB storage: image files hold display-encoded colour, and shading has
      // to happen in linear light. The sampler undoes the encoding for free.
      return this._uploadArray(this.textureArray, images, this.gl.SRGB8_ALPHA8, edge);
    }

    /**
     * The same, for the maps that are numbers rather than pictures.
     *
     * A metallic-roughness map is measured, not seen: its green is a roughness
     * and its blue a metalness, both already linear. Decoding it as sRGB would
     * bend both curves, so it is stored as it was written.
     */
    async setFinishTextures(images, edge = 1024) {
      this.finishLayers = images.length;
      return this._uploadArray(this.finishArray, images, this.gl.RGBA8, edge);
    }

    /**
     * The same again, for the maps that say what shape the surface is.
     *
     * A normal map holds a direction and a bump map a height; neither is a
     * picture, and decoding either as sRGB would bend what it says. Stored as
     * written, like the metallic-roughness maps beside them.
     */
    async setBumpTextures(images, edge = 1024) {
      this.bumpLayers = images.length;
      return this._uploadArray(this.bumpArray, images, this.gl.RGBA8, edge);
    }

    /**
     * The grain a surface is tiled over with, which is a picture and not a
     * measurement — so sRGB, as the base colour is.
     */
    async setDetailTextures(images, edge = 1024) {
      this.detailLayers = images.length;
      return this._uploadArray(this.detailArray, images, this.gl.SRGB8_ALPHA8, edge);
    }

    async _uploadArray(target, images, internalFormat, edge = 1024) {
      const gl = this.gl;
      if (!images.length) { this.dirty = true; return; }

      const size = Math.min(edge, gl.getParameter(gl.MAX_TEXTURE_SIZE));
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, target);
      gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, internalFormat, size, size, images.length,
        0, gl.RGBA, gl.UNSIGNED_BYTE, null);

      /* Resized by the decoder rather than drawn through a 2D canvas.
       *
       * A canvas holds its pixels premultiplied, and unmultiplying at zero
       * alpha is a division by nothing: a texel that is fully transparent
       * comes back black and takes its colour with it. That is only a texel
       * nobody sees — until the material wearing it never asked for alpha at
       * all, and then it is the whole picture. A `.dds` written out of this
       * game routinely carries an alpha channel of nothing beside a colour
       * that matters: one Renault 5 Turbo has twenty-four of them, its seats,
       * its carpet, its dashboard and its interior plastic among them, and
       * every one drew as a black panel.
       *
       * `createImageBitmap` resizes without that, so long as it is told not to
       * premultiply — at every step, since one default anywhere in the chain
       * has already thrown the colour away by the time the next is asked.
       */
      for (let layer = 0; layer < images.length; layer++) {
        // eslint-disable-next-line no-await-in-loop -- one square at a time,
        // rather than every texture of a car resident at once.
        const bitmap = await createImageBitmap(images[layer], {
          resizeWidth: size,
          resizeHeight: size,
          resizeQuality: 'high',
          premultiplyAlpha: 'none',
          /* FBX texture space has V running upwards; turn the picture over
           * here rather than in the shader so the UVs stay as the file wrote
           * them.
           *
           * It has to be asked for *of the bitmap*. `UNPACK_FLIP_Y_WEBGL` is
           * what a canvas or an ImageData upload obeys, and an ImageBitmap
           * ignores it without a word — no error, no warning, every texture on
           * the car quietly upside down. */
          imageOrientation: 'flipY',
        });
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, target);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, layer, size, size, 1,
          gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
        bitmap.close();
      }

      gl.bindTexture(gl.TEXTURE_2D_ARRAY, target);
      gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.REPEAT);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
      this.dirty = true;
    }

    /**
     * Upload a mesh. Buffers are copied, so WASM memory may be reused after.
     *
     * `keepCamera` is for rebuilding what is already on screen — smoothing it,
     * say — where being thrown back to the default view would lose the very
     * thing the user was looking at.
     */
    setMesh(mesh, { keepCamera = false } = {}) {
      const gl = this.gl;
      // Anything already pending is not this upload's doing.
      while (gl.getError() !== gl.NO_ERROR) { /* drain */ }
      this.uploadError = null;
      this.uploadBytes = (mesh.positions.length + mesh.normals.length
        + mesh.materials.length + mesh.uvs.length + mesh.triangleCount * 3) * 4;
      gl.bindVertexArray(this.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, mesh.positions, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.normalBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, mesh.normals, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.materialBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, mesh.materials, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.uvBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, mesh.uvs, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.partBuffer);
      gl.bufferData(gl.ARRAY_BUFFER,
        mesh.parts || new Float32Array(mesh.triangleCount * 3), gl.STATIC_DRAW);
      gl.bindVertexArray(null);
      const failed = gl.getError();
      if (failed !== gl.NO_ERROR || gl.isContextLost()) {
        this.uploadError = failed === gl.OUT_OF_MEMORY
          ? 'the graphics card could not find room for it'
          : (gl.isContextLost() ? 'the graphics context was lost'
            : `the graphics card refused it (0x${failed.toString(16)})`);
        if (this.onDrawFailure) this.onDrawFailure(this.uploadError, this.uploadBytes);
      }
      this.hasUv = mesh.hasUv;

      /* Which slot each triangle wears, for sorting them into solid and
       * see-through. Held by reference: this is the array the caller already
       * keeps for the scene it is showing. */
      this.meshMaterials = mesh.materials;
      this.orderStale = true;
      this.triangleCount = mesh.triangleCount;
      this.meshMin = mesh.min.slice();
      this.meshMax = mesh.max.slice();
      if (keepCamera) this.measure(mesh.min, mesh.max);
      else this.frame(mesh.min, mesh.max);
      // The sun's view of the scene only changes when the scene does.
      this.shadowStale = true;
      this.dirty = true;
    }

    clear() {
      this.triangleCount = 0;
      this.shadowReady = false;
      this.dirty = true;
    }

    /** Point the camera at a bounding box. */
    /** Where the model is and how big it is — which the floor and the sun's
     *  view need whether or not the camera moves. */
    measure(min, max) {
      this.modelCentre = [0, 1, 2].map((i) => (min[i] + max[i]) / 2);
      const size = [0, 1, 2].map((i) => Math.abs(max[i] - min[i]));
      this.baseRadius = Math.max(Math.hypot(size[0], size[1], size[2]) / 2, 1e-4);
      this._updateRadius();
      this.dirty = true;
    }

    /** How far the model reaches once the explode has moved its parts. */
    _updateRadius() {
      this.radius = this.baseRadius || this.radius || 1e-4;
      if (!(this.explode > 0) || !this.parts.length || !this.modelCentre) return;
      const centre = this.modelCentre;
      const min = [Infinity, Infinity, Infinity];
      const max = [-Infinity, -Infinity, -Infinity];
      for (const part of this.parts) {
        if (!part.min || !part.max || !part.centre) continue;
        for (let k = 0; k < 3; k++) {
          const shift = (part.centre[k] - centre[k]) * this.explode;
          if (part.min[k] + shift < min[k]) min[k] = part.min[k] + shift;
          if (part.max[k] + shift > max[k]) max[k] = part.max[k] + shift;
        }
      }
      if (!Number.isFinite(min[0])) return;
      // Measured from the centre the model is drawn around, which does not
      // move: it is what everything else moves away from.
      let reach = 0;
      for (let k = 0; k < 3; k++) {
        reach += Math.max(Math.abs(max[k] - centre[k]), Math.abs(centre[k] - min[k])) ** 2;
      }
      this.radius = Math.max(Math.sqrt(reach), this.baseRadius);
    }

    /** Point the camera at a bounding box. */
    frame(min, max) {
      this.measure(min, max);
      this.target = [0, 0, 0];
      this.distance = this.radius * 2.6;
      this.yaw = VIEW_YAW + this.heading * QUARTER_TURN;
      this.pitch = VIEW_PITCH;
      this.dirty = true;
    }

    setMode(mode) { this.mode = mode; this.dirty = true; }

    /** How far apart to pull the parts: 0 is the model as it was built. */
    setExplode(amount) {
      const next = Math.max(0, Number(amount) || 0);
      if (next === this.explode) return;
      this.explode = next;
      // A scene pulled apart is a bigger scene: the floor spreads with it, and
      // so does the box the sun's view is fitted to.
      this._updateRadius();
      this.shadowStale = true;
      this.dirty = true;
    }

    /** Pick one part out on the model, or -1 for none. */
    setSelectedPart(index) {
      const next = Number.isInteger(index) && index >= 0 && index < this.partCount
        ? index : -1;
      if (next === this.selectedPart) return;
      this.selectedPart = next;
      this.dirty = true;
    }
    /** Pick a material group out on the model, or -1 for none. */
    setHighlight(group) {
      const next = Number.isInteger(group) ? group : -1;
      if (next === this.highlight) return;
      this.highlight = next;
      this.dirty = true;
    }
    setShowTextures(on) { this.showTextures = on; this.dirty = true; }
    setUpAxis(axis) {
      if (axis === this.upAxis) return;
      this.upAxis = axis;
      // Turning the model turns it under the sun as well.
      this.shadowStale = true;
      this.dirty = true;
    }

    /**
     * Mirror the mesh on any of its own axes — `[x, y, z]`, each true to flip.
     *
     * A mirror reverses which way round a triangle is wound, so what was the
     * front face is now the back and the model would be drawn inside out. One
     * mirror does that, and so does three; two cancel. `frontFace` says which
     * winding counts as the front, and switching it there leaves every pass
     * that culls — the shadow map, the see-through pass — asking for the same
     * side it always asked for.
     */
    setFlips(flips) {
      const next = [0, 1, 2].map((i) => ((flips || [])[i] ? -1 : 1));
      if (next.every((v, i) => v === this.flips[i])) return;
      this.flips = next;
      const mirrored = next[0] * next[1] * next[2] < 0;
      this.gl.frontFace(mirrored ? this.gl.CW : this.gl.CCW);
      this.shadowStale = true;
      this.dirty = true;
    }
    /**
     * Which way round the model is looked at, in quarter turns about the up
     * axis, taking effect now and on every reframing from here on.
     *
     * No file says which end of a model is its front. The axis declarations
     * come close, but they are a convention of the format rather than a
     * reading of the scene — every 3ds Max file says front is -Y whichever way
     * the artist actually laid the car out — so a model whose length runs
     * across that declaration opens showing whatever end happens to face the
     * camera. Turning it round is therefore a thing to be told, not guessed,
     * and unlike a mirror it is only a view: the export is unmoved.
     */
    setHeading(quarters) {
      const next = ((Math.round(Number(quarters) || 0) % 4) + 4) % 4;
      if (next === this.heading) return;
      // Turn what is on screen by the difference, so the view the user is
      // looking at swings round rather than jumping back to the default one.
      this.yaw += (next - this.heading) * QUARTER_TURN;
      this.heading = next;
      this.dirty = true;
    }

    setAutoRotate(on) { this.autoRotate = on; this.dirty = true; }
    setShowGround(on) { this.showGround = on !== false; this.dirty = true; }

    resetView() {
      this.yaw = VIEW_YAW + this.heading * QUARTER_TURN;
      this.pitch = VIEW_PITCH;
      this.distance = this.radius * 2.6;
      this.target = [0, 0, 0];
      this.dirty = true;
    }

    _bindInput() {
      const canvas = this.canvas;
      let dragging = null;
      let lastX = 0;
      let lastY = 0;

      canvas.addEventListener('pointerdown', (event) => {
        dragging = (event.button === 2 || event.shiftKey) ? 'pan' : 'orbit';
        lastX = event.clientX;
        lastY = event.clientY;
        canvas.setPointerCapture(event.pointerId);
      });
      canvas.addEventListener('pointermove', (event) => {
        if (!dragging) return;
        const dx = event.clientX - lastX;
        const dy = event.clientY - lastY;
        lastX = event.clientX;
        lastY = event.clientY;
        if (dragging === 'orbit') {
          this.yaw -= dx * 0.008;
          this.pitch = Math.max(-1.5533, Math.min(1.5533, this.pitch - dy * 0.008));
        } else {
          const scale = this.distance * 0.0016;
          this.target[0] -= dx * scale * Math.cos(this.yaw);
          this.target[2] += dx * scale * Math.sin(this.yaw);
          this.target[1] += dy * scale;
        }
        this.dirty = true;
      });
      const stop = (event) => {
        dragging = null;
        if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      };
      canvas.addEventListener('pointerup', stop);
      canvas.addEventListener('pointercancel', stop);
      canvas.addEventListener('contextmenu', (event) => event.preventDefault());
      canvas.addEventListener('wheel', (event) => {
        event.preventDefault();
        const factor = Math.exp(event.deltaY * 0.0012);
        this.distance = Math.max(this.radius * 0.05, Math.min(this.radius * 40, this.distance * factor));
        this.dirty = true;
      }, { passive: false });
    }

    _resize() {
      const canvas = this.canvas;
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
      const height = Math.max(1, Math.round(canvas.clientHeight * ratio));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
        this.dirty = true;
      }
    }

    _loop() {
      this._resize();
      if (this.autoRotate && this.triangleCount) {
        this.yaw += 0.004;
        this.dirty = true;
      }
      if (this.dirty) {
        this.render();
        this.dirty = false;
      }
      this._frame++;
      requestAnimationFrame(this._loop);
    }

    /** Where the floor sits: under the model, along whichever axis is up. */
    _groundHeight() {
      if (!this.meshMin) return 0;
      const axis = this.upAxis === 'z' ? 2 : 1;
      // The model matrix centres the mesh, so its lowest point ends up here.
      let lowest = this.meshMin[axis];
      // Mirrored on the axis that points up, what hangs lowest is what stood
      // highest — otherwise the floor cuts through the model it stands under.
      let highest = this.meshMax[axis];
      // Pulled apart, the lowest part is not the one it was: the floor drops
      // to meet whichever piece now hangs the furthest down.
      if (this.explode > 0) {
        const centre = this.modelCentre || [0, 0, 0];
        for (const part of this.parts) {
          if (!part.min || !part.centre) continue;
          const shift = (part.centre[axis] - centre[axis]) * this.explode;
          if (part.min[axis] + shift < lowest) lowest = part.min[axis] + shift;
          if (part.max && part.max[axis] + shift > highest) highest = part.max[axis] + shift;
        }
      }
      const middle = (this.meshMin[axis] + this.meshMax[axis]) / 2;
      return this.flips[axis] < 0 ? middle - highest : lowest - middle;
    }

    /** Draw the model into the depth buffer, seen from the sun. */
    _renderShadowMap(model, shadowMatrix) {
      const gl = this.gl;
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.shadowBuffer);
      gl.viewport(0, 0, this.shadowSize, this.shadowSize);
      gl.clear(gl.DEPTH_BUFFER_BIT);
      gl.useProgram(this.shadowProgram);
      gl.uniformMatrix4fv(this.shadowUniforms.shadowMatrix, false, shadowMatrix);
      gl.uniformMatrix4fv(this.shadowUniforms.model, false, model);
      this._bindParts(this.shadowUniforms);
      // Only back faces go in the map, which keeps a surface from shadowing
      // itself along every edge it faces the sun with.
      gl.cullFace(gl.FRONT);
      gl.bindVertexArray(this.vao);
      if (this.orderReady) {
        gl.drawElements(gl.TRIANGLES, this.opaqueTriangles * 3, gl.UNSIGNED_INT, 0);
      } else {
        gl.drawArrays(gl.TRIANGLES, 0, this.triangleCount * 3);
      }
      gl.bindVertexArray(null);
      gl.cullFace(gl.BACK);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      // The map is a different size from the canvas, so put the viewport back.
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      this.shadowReady = true;
      this.shadowStale = false;
      this.shadowRenders++;
    }

    /**
     * The triangles sorted into the two halves of the scene, solid first.
     *
     * Which half a triangle is in is settled by its material and by nothing
     * else — that is what the shader's own test says — so it can be settled
     * once here rather than per fragment. What it buys is the sun's view of
     * the car: a depth map has no way to be partly shaded, so a windscreen
     * put into one is a windscreen that throws the shadow of a steel plate,
     * onto the floor and onto the cabin under it. Glass is left out of it.
     *
     * Left out whatever is being drawn, rather than only in the mode that
     * draws it see-through. The other modes are ways of looking at the model
     * and not claims about it, and a shadow that changed with the colour
     * scheme would have to be redrawn every time one was picked.
     *
     * The solid pass is not sorted and still reads the whole mesh: index
     * colours and clay hold every material opaque, so in those modes the
     * see-through half is drawn there and has to be reached.
     */
    _order() {
      const gl = this.gl;
      if (!this.orderStale) return this.orderReady;
      this.orderStale = false;
      this.orderReady = false;
      this.opaqueTriangles = 0;
      this.blendedTriangles = 0;
      const slots = this.blendedSlots;
      const materials = this.meshMaterials;
      if (!slots || !materials || !this.hasTransparency || !this.triangleCount) {
        return false;                    // nothing to separate: draw it all
      }
      const triangles = Math.min(this.triangleCount, (materials.length / 3) | 0);
      const seeThrough = (t) => {
        const slot = Math.round(materials[t * 3]);
        return slot >= 0 && slot < slots.length && slots[slot] === 1;
      };
      // Counted before it is filled, so the room is taken once and exactly.
      let blended = 0;
      for (let t = 0; t < triangles; t++) if (seeThrough(t)) blended++;
      if (!blended) return false;        // every triangle is solid after all
      const order = new Uint32Array(triangles * 3);
      let solidAt = 0;
      let blendedAt = (triangles - blended) * 3;
      for (let t = 0; t < triangles; t++) {
        const at = seeThrough(t) ? blendedAt : solidAt;
        order[at] = t * 3;
        order[at + 1] = t * 3 + 1;
        order[at + 2] = t * 3 + 2;
        if (seeThrough(t)) blendedAt += 3; else solidAt += 3;
      }
      gl.bindVertexArray(this.vao);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.orderBuffer);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, order, gl.STATIC_DRAW);
      gl.bindVertexArray(null);
      this.opaqueTriangles = triangles - blended;
      this.blendedTriangles = blended;
      this.orderReady = true;
      return true;
    }

    /** Hand a program the shadow map and where to look in it. */
    _bindShadow(uniforms, shadowMatrix, on) {
      const gl = this.gl;
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, this.shadowTexture);
      gl.uniform1i(uniforms.shadowMap, 2);
      gl.uniformMatrix4fv(uniforms.shadowMatrix, false, shadowMatrix);
      gl.uniform1f(uniforms.shadowTexel, 1 / this.shadowSize);
      gl.uniform1i(uniforms.shadowReady, on ? 1 : 0);
      gl.activeTexture(gl.TEXTURE0);
    }

    /** Where the model, the camera and the sun are: the same for every pass. */
    _camera() {
      const centre = this.modelCentre || [0, 0, 0];

      let model = identity();
      if (this.upAxis === 'z') model = zUpToYUp();
      // A mirrored axis is negated after the centring below, so the model
      // turns over about its own middle and stays where it was on screen.
      if (this.flips.some((f) => f < 0)) {
        const mirror = identity();
        mirror[0] = this.flips[0];
        mirror[5] = this.flips[1];
        mirror[10] = this.flips[2];
        model = multiply(model, mirror);
      }
      // Centre the model at the origin before the up-axis rotation.
      const translate = identity();
      translate[12] = -centre[0];
      translate[13] = -centre[1];
      translate[14] = -centre[2];
      model = multiply(model, translate);

      const eye = [
        this.target[0] + this.distance * Math.cos(this.pitch) * Math.sin(this.yaw),
        this.target[1] + this.distance * Math.sin(this.pitch),
        this.target[2] + this.distance * Math.cos(this.pitch) * Math.cos(this.yaw),
      ];
      const view = lookAt(eye, this.target, [0, 1, 0]);
      const modelView = multiply(view, model);
      const aspect = this.canvas.width / Math.max(this.canvas.height, 1);
      const near = Math.max(this.radius * 0.005, 1e-3);
      const projection = perspective(0.9, aspect, near, this.radius * 100 + 10);
      return {
        model,
        view,
        modelView,
        projection,
        toWorld: viewToWorld(view),
        shadowMatrix: this._shadowMatrix(),
      };
    }

    /**
     * Which part is under a point on the canvas, or -1.
     *
     * The scene is drawn again into a buffer of part numbers rather than
     * colours and one pixel is read back, so the answer accounts for whatever
     * the picture accounts for — the explode, the up axis, what is in front of
     * what — without a second copy of any of it.
     */
    pickPart(x, y) {
      const gl = this.gl;
      if (!this.triangleCount || !this.partCount) return -1;
      const ratio = this.canvas.width / Math.max(this.canvas.clientWidth, 1);
      const px = Math.round(x * ratio);
      const py = Math.round(y * ratio);
      if (px < 0 || py < 0 || px >= this.canvas.width || py >= this.canvas.height) return -1;

      if (!this.pickBuffer || this.pickSize[0] !== this.canvas.width
        || this.pickSize[1] !== this.canvas.height) {
        if (this.pickBuffer) {
          gl.deleteFramebuffer(this.pickBuffer);
          gl.deleteTexture(this.pickTexture);
          gl.deleteRenderbuffer(this.pickDepth);
        }
        this.pickTexture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, this.pickTexture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, this.canvas.width, this.canvas.height,
          0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        this.pickDepth = gl.createRenderbuffer();
        gl.bindRenderbuffer(gl.RENDERBUFFER, this.pickDepth);
        gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16,
          this.canvas.width, this.canvas.height);
        this.pickBuffer = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.pickBuffer);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D,
          this.pickTexture, 0);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER,
          this.pickDepth);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.bindTexture(gl.TEXTURE_2D, null);
        gl.bindRenderbuffer(gl.RENDERBUFFER, null);
        this.pickSize = [this.canvas.width, this.canvas.height];
      }

      const camera = this._camera();
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.pickBuffer);
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.useProgram(this.pickProgram);
      gl.uniformMatrix4fv(this.pickUniforms.modelView, false, camera.modelView);
      gl.uniformMatrix4fv(this.pickUniforms.projection, false, camera.projection);
      this._bindParts(this.pickUniforms);
      gl.bindVertexArray(this.vao);
      // Both sides: a part seen through its own back face is still that part.
      gl.disable(gl.CULL_FACE);
      gl.drawArrays(gl.TRIANGLES, 0, this.triangleCount * 3);
      gl.enable(gl.CULL_FACE);
      gl.bindVertexArray(null);

      const pixel = new Uint8Array(4);
      gl.readPixels(px, this.canvas.height - 1 - py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      // The picture was drawn over; put it back on the next frame.
      this.dirty = true;

      const id = pixel[0] | (pixel[1] << 8) | (pixel[2] << 16);
      return id > 0 && id <= this.partCount ? id - 1 : -1;
    }

    render() {
      const gl = this.gl;
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      if (!this.triangleCount) return;

      /* Settled before anything else binds the array: hanging the element
       * buffer off it means binding it, and doing that in the middle of a
       * frame would take the attributes out from under the next draw. */
      this._order();

      const { model, view, modelView, projection, toWorld, shadowMatrix } = this._camera();

      // The sun's view of the model, redrawn only when the model changes —
      // orbiting the camera leaves the shadows exactly where they were.
      if (this.showGround && this.shadowStale) this._renderShadowMap(model, shadowMatrix);
      const shadowOn = this.showGround && this.shadowReady;

      // The environment first, behind everything, writing no depth.
      gl.useProgram(this.backgroundProgram);
      gl.uniformMatrix4fv(this.backgroundUniforms.invProjection, false,
        inversePerspective(projection));
      gl.uniformMatrix3fv(this.backgroundUniforms.viewToWorld, false, toWorld);
      gl.depthMask(false);
      gl.disable(gl.DEPTH_TEST);
      gl.bindVertexArray(this.backgroundVao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindVertexArray(null);
      gl.enable(gl.DEPTH_TEST);
      gl.depthMask(true);

      // The floor the model stands on, and the shadow it drops onto it.
      if (this.showGround) {
        gl.useProgram(this.groundProgram);
        gl.uniformMatrix4fv(this.groundUniforms.modelView, false, view);
        gl.uniformMatrix4fv(this.groundUniforms.projection, false, projection);
        gl.uniform1f(this.groundUniforms.radius, this.radius * 6);
        gl.uniform1f(this.groundUniforms.height, this._groundHeight());
        this._bindShadow(this.groundUniforms, shadowMatrix, shadowOn);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.disable(gl.CULL_FACE);
        gl.bindVertexArray(this.groundVao);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        gl.bindVertexArray(null);
        gl.enable(gl.CULL_FACE);
        gl.disable(gl.BLEND);
      }

      gl.useProgram(this.program);
      gl.uniformMatrix4fv(this.uniforms.model, false, model);
      this._bindShadow(this.uniforms, shadowMatrix, shadowOn);
      gl.uniformMatrix3fv(this.uniforms.viewToWorld, false, toWorld);
      gl.uniformMatrix4fv(this.uniforms.modelView, false, modelView);
      gl.uniformMatrix4fv(this.uniforms.projection, false, projection);
      gl.uniformMatrix3fv(this.uniforms.normalMatrix, false, normalMatrix(modelView));
      gl.uniform1i(this.uniforms.mode, this.mode);
      gl.uniform3f(this.uniforms.clayColour, 0.72, 0.73, 0.76);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.paletteTexture);
      gl.uniform1i(this.uniforms.palette, 0);
      gl.uniform1i(this.uniforms.paletteSize, this.paletteSize);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.textureArray);
      gl.uniform1i(this.uniforms.textures, 1);
      gl.activeTexture(gl.TEXTURE4);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.finishArray);
      gl.uniform1i(this.uniforms.finish, 4);
      gl.activeTexture(gl.TEXTURE5);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.bumpArray);
      gl.uniform1i(this.uniforms.bump, 5);
      gl.activeTexture(gl.TEXTURE6);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.detailArray);
      gl.uniform1i(this.uniforms.detail, 6);
      gl.activeTexture(gl.TEXTURE0);
      // Any kind of map counts: a material can carry a bump or a metallic-roughness
      // map and no picture at all, and turning textures off has to turn the
      // whole of what they say off with them.
      gl.uniform1i(this.uniforms.useTextures,
        ((this.textureLayers > 0 || this.finishLayers > 0 || this.bumpLayers > 0
          || this.detailLayers > 0)
          && this.hasUv && this.showTextures !== false) ? 1 : 0);
      gl.uniform1f(this.uniforms.opaqueLimit, OPAQUE);
      gl.uniform1i(this.uniforms.highlight,
        Number.isInteger(this.highlight) ? this.highlight : -1);
      gl.uniform1i(this.uniforms.selected, this.selectedPart);
      this._bindParts(this.uniforms);

      gl.bindVertexArray(this.vao);
      const vertices = this.triangleCount * 3;
      // Solid surfaces first, so anything blended over them tests against a
      // finished depth buffer.
      gl.uniform1i(this.uniforms.pass, 0);
      gl.drawArrays(gl.TRIANGLES, 0, vertices);

      // Then the see-through half, back faces before front so the far side of
      // a windscreen is laid down before the near side blends over it. Depth
      // is read but not written: two sheets of glass must not hide each other.
      if (this.hasTransparency && this.mode === 0) {
        gl.uniform1i(this.uniforms.pass, 1);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.depthMask(false);
        // Its own half where that is known, the whole mesh where it is not.
        const from = this.opaqueTriangles * 3 * 4;
        const only = this.blendedTriangles * 3;
        const draw = () => {
          if (this.orderReady) gl.drawElements(gl.TRIANGLES, only, gl.UNSIGNED_INT, from);
          else gl.drawArrays(gl.TRIANGLES, 0, vertices);
        };
        gl.cullFace(gl.FRONT);
        draw();
        gl.cullFace(gl.BACK);
        draw();
        gl.depthMask(true);
        gl.disable(gl.BLEND);
      }
      gl.bindVertexArray(null);
    }
  }

  return { Viewer, GRAIN_FLOOR, GRAIN_CEILING };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = FbxViewer;
