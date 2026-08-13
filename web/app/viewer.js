/* WebGL2 viewport: orbit camera, per-material shading, and axis correction.
 *
 * Geometry arrives already triangulated from the WebAssembly core, so this
 * only uploads buffers and draws.
 */
'use strict';

const FbxViewer = (function () {
  const VERTEX_SHADER = `#version 300 es
  precision highp float;
  layout(location = 0) in vec3 aPosition;
  layout(location = 1) in vec3 aNormal;
  layout(location = 2) in float aMaterial;

  uniform mat4 uModelView;
  uniform mat4 uProjection;
  uniform mat3 uNormalMatrix;

  out vec3 vNormal;
  out vec3 vViewPosition;
  out float vMaterial;

  void main() {
    vec4 viewPosition = uModelView * vec4(aPosition, 1.0);
    vViewPosition = viewPosition.xyz;
    vNormal = uNormalMatrix * aNormal;
    vMaterial = aMaterial;
    gl_Position = uProjection * viewPosition;
  }`;

  const FRAGMENT_SHADER = `#version 300 es
  precision highp float;

  in vec3 vNormal;
  in vec3 vViewPosition;
  in float vMaterial;

  uniform int uMode;          // 0 materials, 1 clay, 2 normals
  uniform vec3 uClayColour;

  out vec4 fragColour;

  // Distinct hues per material index without a lookup table.
  vec3 materialColour(float id) {
    float hue = fract(id * 0.6180339887);
    vec3 k = vec3(3.0, 2.0, 1.0);
    vec3 p = abs(fract(vec3(hue) + k / 3.0) * 6.0 - 3.0);
    vec3 rgb = clamp(p - 1.0, 0.0, 1.0);
    float sat = 0.55 + 0.25 * fract(id * 0.7548776662);
    return mix(vec3(0.85), rgb, sat);
  }

  void main() {
    // Flat-shade from screen-space derivatives when a normal is degenerate,
    // so meshes without usable normals still read as solid.
    vec3 normal = normalize(vNormal);
    if (!all(lessThan(abs(normal), vec3(1e3))) || dot(normal, normal) < 0.5) {
      normal = normalize(cross(dFdx(vViewPosition), dFdy(vViewPosition)));
    }
    if (!gl_FrontFacing) normal = -normal;

    if (uMode == 2) {
      fragColour = vec4(normal * 0.5 + 0.5, 1.0);
      return;
    }

    vec3 base = uMode == 0 ? materialColour(vMaterial) : uClayColour;

    vec3 viewDir = normalize(-vViewPosition);
    vec3 keyDir = normalize(vec3(0.4, 0.7, 0.8));
    vec3 fillDir = normalize(vec3(-0.6, 0.2, -0.4));

    float key = max(dot(normal, keyDir), 0.0);
    float fill = max(dot(normal, fillDir), 0.0) * 0.35;
    float rim = pow(1.0 - max(dot(normal, viewDir), 0.0), 2.5) * 0.35;

    vec3 halfway = normalize(keyDir + viewDir);
    float spec = pow(max(dot(normal, halfway), 0.0), 48.0) * 0.25;

    vec3 colour = base * (0.22 + 0.78 * key + fill) + vec3(spec) + vec3(0.35, 0.45, 0.6) * rim;
    fragColour = vec4(pow(clamp(colour, 0.0, 1.0), vec3(1.0 / 2.2)), 1.0);
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
      };
    }

    _initBuffers() {
      const gl = this.gl;
      this.vao = gl.createVertexArray();
      gl.bindVertexArray(this.vao);
      this.positionBuffer = gl.createBuffer();
      this.normalBuffer = gl.createBuffer();
      this.materialBuffer = gl.createBuffer();

      const attach = (buffer, location, size) => {
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.enableVertexAttribArray(location);
        gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0);
      };
      attach(this.positionBuffer, 0, 3);
      attach(this.normalBuffer, 1, 3);
      attach(this.materialBuffer, 2, 1);
      gl.bindVertexArray(null);
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
      gl.bindVertexArray(null);

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

      gl.useProgram(this.program);
      gl.uniformMatrix4fv(this.uniforms.modelView, false, modelView);
      gl.uniformMatrix4fv(this.uniforms.projection, false, projection);
      gl.uniformMatrix3fv(this.uniforms.normalMatrix, false, normalMatrix(modelView));
      gl.uniform1i(this.uniforms.mode, this.mode);
      gl.uniform3f(this.uniforms.clayColour, 0.72, 0.73, 0.76);

      gl.bindVertexArray(this.vao);
      gl.drawArrays(gl.TRIANGLES, 0, this.triangleCount * 3);
      gl.bindVertexArray(null);
    }
  }

  return { Viewer };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = FbxViewer;
