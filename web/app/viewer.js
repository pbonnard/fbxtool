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

  uniform mat4 uModelView;
  uniform mat4 uProjection;
  uniform mat3 uNormalMatrix;

  out vec3 vNormal;
  out vec3 vViewPosition;
  out float vMaterial;
  out vec2 vUv;

  void main() {
    vec4 viewPosition = uModelView * vec4(aPosition, 1.0);
    vViewPosition = viewPosition.xyz;
    vNormal = uNormalMatrix * aNormal;
    vMaterial = aMaterial;
    vUv = aUv;
    gl_Position = uProjection * viewPosition;
  }`;

  const FRAGMENT_SHADER = `#version 300 es
  precision highp float;

  in vec3 vNormal;
  in vec3 vViewPosition;
  in float vMaterial;
  in vec2 vUv;

  uniform int uMode;          // 0 file colours, 1 index colours, 2 clay, 3 normals
  uniform vec3 uClayColour;
  uniform sampler2D uPalette;      // two rows per material: colour, then finish
  uniform int uPaletteSize;
  // GLSL ES 3.0 has no default precision for array samplers, unlike sampler2D.
  uniform highp sampler2DArray uTextures; // one layer per distinct image
  uniform int uUseTextures;
  uniform mat3 uViewToWorld;  // the environment stays put as the camera orbits

  out vec4 fragColour;
${ENVIRONMENT}

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

    if (uMode == 3) {
      fragColour = vec4(normal * 0.5 + 0.5, 1.0);
      return;
    }

    vec3 albedo;
    vec3 f0 = vec3(0.04);       // a plain dielectric, unless the file says more
    float roughness = 0.55;
    if (uMode == 0 && uPaletteSize > 0) {
      // The material index is a whole number carried in a float attribute.
      int slot = clamp(int(vMaterial + 0.5), 0, uPaletteSize - 1);
      vec4 entry = texelFetch(uPalette, ivec2(slot, 0), 0);
      vec4 finish = texelFetch(uPalette, ivec2(slot, 1), 0);
      albedo = entry.rgb;
      f0 = finish.rgb;
      roughness = clamp(finish.a, 0.05, 1.0);
      // The alpha of the first row carries this material's texture layer,
      // offset by one so that zero means "no texture".
      int layer = int(entry.a + 0.5) - 1;
      if (uUseTextures == 1 && layer >= 0) {
        // A bound diffuse texture replaces the flat colour, as most DCC tools
        // and viewers treat it. The sampler is sRGB, so this is already linear.
        albedo = texture(uTextures, vec3(vUv, float(layer))).rgb;
      }
    } else if (uMode == 1) {
      albedo = indexColour(vMaterial);
    } else {
      albedo = uClayColour;
    }

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
    vec3 direct = vec3(0.0);
    if (nol > 0.0) {
      vec3 specular = fresnelSchlick(f0, voh)
        * (distributionGgx(noh, a) * visibilitySmith(nov, nol, a));
      direct = (diffuseColour / PI + specular) * SUN_COLOUR * nol;
    }

    // The environment, which is what makes a curved surface read as a surface.
    vec3 ambient = diffuseColour * environmentIrradiance(n)
      + environmentSpecular(r, roughness) * environmentBrdf(f0, roughness, nov);

    fragColour = vec4(encodeSrgb(toneMap(direct + ambient)), 1.0);
  }`;

  /* ------------------------------------------------------------- matrices */

  function identity() {
    return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
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

  /** Upper-left 3x3 of a matrix; adequate while the model matrix is a rotation. */
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

      this.mode = 0;
      this.upAxis = 'y';
      this.hasUv = false;
      this.showTextures = true;
      this.triangleCount = 0;
      this.yaw = 0.7;
      this.pitch = 0.35;
      this.distance = 4;
      this.target = [0, 0, 0];
      this.radius = 1;
      this.autoRotate = false;
      this.dirty = true;
      this._frame = 0;

      this._initProgram();
      this._initBuffers();
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
        useTextures: gl.getUniformLocation(program, 'uUseTextures'),
        viewToWorld: gl.getUniformLocation(program, 'uViewToWorld'),
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
    }

    _initBuffers() {
      const gl = this.gl;
      this.vao = gl.createVertexArray();
      gl.bindVertexArray(this.vao);
      this.positionBuffer = gl.createBuffer();
      this.normalBuffer = gl.createBuffer();
      this.materialBuffer = gl.createBuffer();
      this.uvBuffer = gl.createBuffer();

      const attach = (buffer, location, size) => {
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.enableVertexAttribArray(location);
        gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0);
      };
      attach(this.positionBuffer, 0, 3);
      attach(this.normalBuffer, 1, 3);
      attach(this.materialBuffer, 2, 1);
      attach(this.uvBuffer, 3, 2);
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
    }

    /**
     * Upload the scene's real materials, one column per material in the order
     * they connect to the model, which is what the per-polygon material index
     * refers to.
     *
     * Two rows: the diffuse colour with the texture layer in alpha, then the
     * specular colour with roughness in alpha. Floats, because the values are
     * linear and eight bits of a linear ramp bands badly in the darks — the
     * Mercedes' interior sits at 0.05.
     */
    setPalette(materials) {
      const gl = this.gl;
      this.paletteSize = materials.length;
      if (!materials.length) { this.dirty = true; return; }
      const width = materials.length;
      const data = new Float32Array(width * 2 * 4);
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
      });
      gl.bindTexture(gl.TEXTURE_2D, this.paletteTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, 2, 0,
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
    setTextures(images, edge = 1024) {
      const gl = this.gl;
      this.textureLayers = images.length;
      if (!images.length) { this.dirty = true; return; }

      const size = Math.min(edge, gl.getParameter(gl.MAX_TEXTURE_SIZE));
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const context = canvas.getContext('2d');

      gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.textureArray);
      // sRGB storage: image files hold display-encoded colour, and shading has
      // to happen in linear light. The sampler undoes the encoding for free.
      gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.SRGB8_ALPHA8, size, size, images.length,
        0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      images.forEach((image, layer) => {
        context.clearRect(0, 0, size, size);
        // FBX texture space has V running upwards; flip once here rather than
        // in the shader so the UVs stay as the file wrote them.
        context.save();
        context.translate(0, size);
        context.scale(1, -1);
        context.drawImage(image, 0, 0, size, size);
        context.restore();
        gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, layer, size, size, 1,
          gl.RGBA, gl.UNSIGNED_BYTE, canvas);
      });
      gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.REPEAT);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
      this.dirty = true;
    }

    /** Upload a mesh. Buffers are copied, so WASM memory may be reused after. */
    setMesh(mesh) {
      const gl = this.gl;
      gl.bindVertexArray(this.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, mesh.positions, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.normalBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, mesh.normals, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.materialBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, mesh.materials, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.uvBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, mesh.uvs, gl.STATIC_DRAW);
      gl.bindVertexArray(null);
      this.hasUv = mesh.hasUv;

      this.triangleCount = mesh.triangleCount;
      this.frame(mesh.min, mesh.max);
      this.dirty = true;
    }

    clear() {
      this.triangleCount = 0;
      this.dirty = true;
    }

    /** Point the camera at a bounding box. */
    frame(min, max) {
      const centre = [0, 1, 2].map((i) => (min[i] + max[i]) / 2);
      const size = [0, 1, 2].map((i) => Math.abs(max[i] - min[i]));
      const radius = Math.max(Math.hypot(size[0], size[1], size[2]) / 2, 1e-4);
      this.modelCentre = centre;
      this.radius = radius;
      this.target = [0, 0, 0];
      this.distance = radius * 2.6;
      this.yaw = 0.9;
      this.pitch = 0.28;
      this.dirty = true;
    }

    setMode(mode) { this.mode = mode; this.dirty = true; }
    setShowTextures(on) { this.showTextures = on; this.dirty = true; }
    setUpAxis(axis) { this.upAxis = axis; this.dirty = true; }
    setAutoRotate(on) { this.autoRotate = on; this.dirty = true; }

    resetView() {
      this.yaw = 0.9;
      this.pitch = 0.28;
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

    render() {
      const gl = this.gl;
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      if (!this.triangleCount) return;

      const centre = this.modelCentre || [0, 0, 0];

      let model = identity();
      if (this.upAxis === 'z') model = zUpToYUp();
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
      const toWorld = viewToWorld(view);

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

      gl.useProgram(this.program);
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
      gl.uniform1i(this.uniforms.useTextures,
        (this.textureLayers > 0 && this.hasUv && this.showTextures !== false) ? 1 : 0);

      gl.bindVertexArray(this.vao);
      gl.drawArrays(gl.TRIANGLES, 0, this.triangleCount * 3);
      gl.bindVertexArray(null);
    }
  }

  return { Viewer };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = FbxViewer;
