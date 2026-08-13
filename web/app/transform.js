/* FBX node transforms.
 *
 * A mesh is stored in its model's local space, so rendering a scene means
 * composing each model's transform and walking it up the parent chain. FBX
 * builds a node's local matrix from more than translate/rotate/scale — there
 * are pivots, offsets, and pre/post rotations — in this order:
 *
 *   T * Roff * Rp * Rpre * R * Rpost^-1 * Rp^-1 * Soff * Sp * S * Sp^-1
 *
 * Most exporters write only T, R and S, but the rest are honoured when
 * present. Matrices are column-major, matching WebGL.
 */
'use strict';

const FbxTransform = (function () {
  const DEG = Math.PI / 180;

  function identity() {
    return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  }

  function multiply(a, b) {
    const out = new Array(16);
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1]
          + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
      }
    }
    return out;
  }

  function translation(x, y, z) {
    const m = identity();
    m[12] = x; m[13] = y; m[14] = z;
    return m;
  }

  function scaling(x, y, z) {
    const m = identity();
    m[0] = x; m[5] = y; m[10] = z;
    return m;
  }

  function rotationX(angle) {
    const c = Math.cos(angle); const s = Math.sin(angle);
    const m = identity();
    m[5] = c; m[6] = s; m[9] = -s; m[10] = c;
    return m;
  }

  function rotationY(angle) {
    const c = Math.cos(angle); const s = Math.sin(angle);
    const m = identity();
    m[0] = c; m[2] = -s; m[8] = s; m[10] = c;
    return m;
  }

  function rotationZ(angle) {
    const c = Math.cos(angle); const s = Math.sin(angle);
    const m = identity();
    m[0] = c; m[1] = s; m[4] = -s; m[5] = c;
    return m;
  }

  /** Euler angles in degrees, composed for the given rotation order. */
  const ORDERS = {
    0: 'XYZ', 1: 'XZY', 2: 'YZX', 3: 'YXZ', 4: 'ZXY', 5: 'ZYX', 6: 'XYZ',
  };

  function euler(angles, order = 0) {
    const [x, y, z] = angles.map((a) => (Number(a) || 0) * DEG);
    const rx = rotationX(x);
    const ry = rotationY(y);
    const rz = rotationZ(z);
    const parts = { X: rx, Y: ry, Z: rz };
    // "XYZ" means X turns first, so it multiplies a point first and sits
    // right-most in the product: R = Rz * Ry * Rx.
    const sequence = ORDERS[order] || 'XYZ';
    let out = identity();
    for (const axis of sequence) out = multiply(parts[axis], out);
    return out;
  }

  function invert(matrix) {
    // Only the rigid/affine cases occur here, but a general inverse keeps
    // pivot handling honest.
    const m = matrix;
    const a00 = m[0], a01 = m[1], a02 = m[2], a03 = m[3];
    const a10 = m[4], a11 = m[5], a12 = m[6], a13 = m[7];
    const a20 = m[8], a21 = m[9], a22 = m[10], a23 = m[11];
    const a30 = m[12], a31 = m[13], a32 = m[14], a33 = m[15];

    const b00 = a00 * a11 - a01 * a10;
    const b01 = a00 * a12 - a02 * a10;
    const b02 = a00 * a13 - a03 * a10;
    const b03 = a01 * a12 - a02 * a11;
    const b04 = a01 * a13 - a03 * a11;
    const b05 = a02 * a13 - a03 * a12;
    const b06 = a20 * a31 - a21 * a30;
    const b07 = a20 * a32 - a22 * a30;
    const b08 = a20 * a33 - a23 * a30;
    const b09 = a21 * a32 - a22 * a31;
    const b10 = a21 * a33 - a23 * a31;
    const b11 = a22 * a33 - a23 * a32;

    let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
    if (!det) return identity();
    det = 1 / det;
    return [
      (a11 * b11 - a12 * b10 + a13 * b09) * det,
      (a02 * b10 - a01 * b11 - a03 * b09) * det,
      (a31 * b05 - a32 * b04 + a33 * b03) * det,
      (a22 * b04 - a21 * b05 - a23 * b03) * det,
      (a12 * b08 - a10 * b11 - a13 * b07) * det,
      (a00 * b11 - a02 * b08 + a03 * b07) * det,
      (a32 * b02 - a30 * b05 - a33 * b01) * det,
      (a20 * b05 - a22 * b02 + a23 * b01) * det,
      (a10 * b10 - a11 * b08 + a13 * b06) * det,
      (a01 * b08 - a00 * b10 - a03 * b06) * det,
      (a30 * b04 - a31 * b02 + a33 * b00) * det,
      (a21 * b02 - a20 * b04 - a23 * b00) * det,
      (a11 * b07 - a10 * b09 - a12 * b06) * det,
      (a00 * b09 - a01 * b07 + a02 * b06) * det,
      (a31 * b01 - a30 * b03 - a32 * b00) * det,
      (a20 * b03 - a21 * b01 + a22 * b00) * det,
    ];
  }

  const vector = (props, name, fallback) => {
    const value = props[name];
    if (Array.isArray(value)) return [0, 1, 2].map((i) => Number(value[i]) || 0);
    if (typeof value === 'number') return [value, value, value];
    return fallback;
  };

  /** A node's local matrix, from whichever transform properties it carries. */
  function localMatrix(props) {
    const zero = [0, 0, 0];
    const one = [1, 1, 1];
    const order = typeof props.RotationOrder === 'number' ? props.RotationOrder : 0;

    const t = vector(props, 'Lcl Translation', zero);
    const r = vector(props, 'Lcl Rotation', zero);
    const s = vector(props, 'Lcl Scaling', one);
    const rOffset = vector(props, 'RotationOffset', zero);
    const rPivot = vector(props, 'RotationPivot', zero);
    const sOffset = vector(props, 'ScalingOffset', zero);
    const sPivot = vector(props, 'ScalingPivot', zero);
    const preRotation = vector(props, 'PreRotation', zero);
    const postRotation = vector(props, 'PostRotation', zero);

    let m = translation(t[0], t[1], t[2]);
    m = multiply(m, translation(rOffset[0], rOffset[1], rOffset[2]));
    m = multiply(m, translation(rPivot[0], rPivot[1], rPivot[2]));
    m = multiply(m, euler(preRotation, order));
    m = multiply(m, euler(r, order));
    m = multiply(m, invert(euler(postRotation, order)));
    m = multiply(m, translation(-rPivot[0], -rPivot[1], -rPivot[2]));
    m = multiply(m, translation(sOffset[0], sOffset[1], sOffset[2]));
    m = multiply(m, translation(sPivot[0], sPivot[1], sPivot[2]));
    m = multiply(m, scaling(s[0], s[1], s[2]));
    m = multiply(m, translation(-sPivot[0], -sPivot[1], -sPivot[2]));
    return m;
  }

  /**
   * The geometric transform, which offsets the mesh from its node without
   * being inherited by children.
   */
  function geometricMatrix(props) {
    const zero = [0, 0, 0];
    const one = [1, 1, 1];
    const t = vector(props, 'GeometricTranslation', zero);
    const r = vector(props, 'GeometricRotation', zero);
    const s = vector(props, 'GeometricScaling', one);
    if (t === zero && r === zero && s === one) return null;
    let m = translation(t[0], t[1], t[2]);
    m = multiply(m, euler(r, 0));
    m = multiply(m, scaling(s[0], s[1], s[2]));
    return m;
  }

  /** Determinant of the upper-left 3x3: negative means the transform mirrors. */
  function determinant3(m) {
    return m[0] * (m[5] * m[10] - m[6] * m[9])
      - m[4] * (m[1] * m[10] - m[2] * m[9])
      + m[8] * (m[1] * m[6] - m[2] * m[5]);
  }

  /** Inverse transpose of the upper-left 3x3, for transforming normals. */
  function normalMatrix(m) {
    const a = [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]];
    const det = a[0] * (a[4] * a[8] - a[5] * a[7])
      - a[3] * (a[1] * a[8] - a[2] * a[7])
      + a[6] * (a[1] * a[5] - a[2] * a[4]);
    if (!det) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
    const inv = 1 / det;
    // Transpose of the inverse, written directly.
    return [
      (a[4] * a[8] - a[5] * a[7]) * inv,
      (a[5] * a[6] - a[3] * a[8]) * inv,
      (a[3] * a[7] - a[4] * a[6]) * inv,
      (a[2] * a[7] - a[1] * a[8]) * inv,
      (a[0] * a[8] - a[2] * a[6]) * inv,
      (a[1] * a[6] - a[0] * a[7]) * inv,
      (a[1] * a[5] - a[2] * a[4]) * inv,
      (a[2] * a[3] - a[0] * a[5]) * inv,
      (a[0] * a[4] - a[1] * a[3]) * inv,
    ];
  }

  return {
    identity, multiply, localMatrix, geometricMatrix, normalMatrix, determinant3,
    euler, invert,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = FbxTransform;
