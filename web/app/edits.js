/* Taking a part out of a scene, and taking a part apart.
 *
 * The geometry behind the two edits the viewer offers, kept away from the DOM
 * so it can be run on its own. A piece is a triangle soup — nine floats of
 * position per triangle, nine of normal, six of UV, three of material slot —
 * and both splits answer with lists of triangle indices into it rather than
 * with new vertex data. Nothing is copied until `slice`, so splitting a split
 * costs no more than splitting once.
 */
'use strict';

const FbxEdits = (function () {
  /**
   * Number the corners, welding the ones that stand at the same point.
   *
   * Exact equality is the right test here and not a tolerance: every corner of
   * a part came out of one triangulation of one vertex array through one
   * matrix, so two corners of the same vertex are the same bits. What differs
   * by a rounding step belongs to a different vertex, whatever it looks like on
   * screen. Zero is the one value with two spellings, so it is spelled once.
   */
  function weldCorners(piece) {
    const count = piece.triangleCount * 3;
    const positions = piece.positions;
    const bits = new Int32Array(positions.buffer, positions.byteOffset, count * 3);
    const ids = new Int32Array(count);
    const seen = new Map();
    let next = 0;
    for (let corner = 0; corner < count; corner++) {
      const at = corner * 3;
      const key = `${positions[at] === 0 ? 0 : bits[at]},`
        + `${positions[at + 1] === 0 ? 0 : bits[at + 1]},`
        + `${positions[at + 2] === 0 ? 0 : bits[at + 2]}`;
      let id = seen.get(key);
      if (id === undefined) { id = next++; seen.set(key, id); }
      ids[corner] = id;
    }
    return { ids, vertexCount: next };
  }

  /**
   * The loose pieces of a part: triangles joined through shared vertices, in
   * groups, biggest first. A wheel modelled as rim, tyre and hub and saved as
   * one mesh comes back as three.
   */
  function shells(piece) {
    const { ids, vertexCount } = weldCorners(piece);
    const parent = new Int32Array(vertexCount);
    for (let i = 0; i < vertexCount; i++) parent[i] = i;
    const find = (start) => {
      let node = start;
      while (parent[node] !== node) {
        parent[node] = parent[parent[node]];   // halve the path on the way up
        node = parent[node];
      }
      return node;
    };
    const join = (a, b) => {
      const rootA = find(a);
      const rootB = find(b);
      if (rootA !== rootB) parent[rootB] = rootA;
    };

    const faces = piece.triangleCount;
    for (let face = 0; face < faces; face++) {
      join(ids[face * 3], ids[face * 3 + 1]);
      join(ids[face * 3], ids[face * 3 + 2]);
    }

    const groups = new Map();
    for (let face = 0; face < faces; face++) {
      const root = find(ids[face * 3]);
      let group = groups.get(root);
      if (!group) groups.set(root, group = []);
      group.push(face);
    }
    return [...groups.values()]
      .sort((a, b) => b.length - a.length)
      .map((group) => Int32Array.from(group));
  }

  /**
   * The part grouped by the material each triangle wears, in slot order. One
   * mesh holding a car's body and its glass comes back as two.
   */
  function byMaterial(piece) {
    const groups = new Map();
    for (let face = 0; face < piece.triangleCount; face++) {
      const slot = piece.materials[face * 3];
      let group = groups.get(slot);
      if (!group) groups.set(slot, group = []);
      group.push(face);
    }
    return [...groups.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([slot, faces]) => ({ slot, faces: Int32Array.from(faces) }));
  }

  /** The named triangles of a piece, as a piece in their own right. */
  function slice(piece, faces) {
    if (!faces) return piece;
    const count = faces.length;
    const positions = new Float32Array(count * 9);
    const normals = new Float32Array(count * 9);
    const uvs = new Float32Array(piece.uvs && piece.uvs.length ? count * 6 : 0);
    const materials = new Float32Array(count * 3);
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];

    for (let i = 0; i < count; i++) {
      const face = faces[i];
      for (let k = 0; k < 9; k++) {
        positions[i * 9 + k] = piece.positions[face * 9 + k];
        normals[i * 9 + k] = piece.normals[face * 9 + k];
      }
      for (let corner = 0; corner < 3; corner++) {
        for (let k = 0; k < 3; k++) {
          const value = positions[i * 9 + corner * 3 + k];
          if (value < min[k]) min[k] = value;
          if (value > max[k]) max[k] = value;
        }
      }
      if (uvs.length) {
        for (let k = 0; k < 6; k++) uvs[i * 6 + k] = piece.uvs[face * 6 + k];
      }
      for (let k = 0; k < 3; k++) materials[i * 3 + k] = piece.materials[face * 3 + k];
    }

    return {
      ...piece,
      positions,
      normals,
      uvs,
      materials,
      triangleCount: count,
      // A slice is counted in the triangles it kept: which polygons they were
      // cut from is a fact about the file, not about what is left of it.
      polygonCount: count,
      min,
      max,
    };
  }

  /**
   * The same piece wearing one material throughout.
   *
   * A copy rather than a repaint in place: a piece cut from a part that has
   * not been split is that part's own piece, and the part must still be there
   * to go back to.
   */
  function paint(piece, slot) {
    const materials = new Float32Array(piece.triangleCount * 3);
    materials.fill(slot);
    return { ...piece, materials };
  }

  /** Read a list of triangles back through the one it was taken from. */
  function through(outer, inner) {
    if (!outer) return inner;
    const out = new Int32Array(inner.length);
    for (let i = 0; i < inner.length; i++) out[i] = outer[inner[i]];
    return out;
  }

  /** Every triangle of a piece, in order — what a whole part stands for. */
  function every(count) {
    const faces = new Int32Array(count);
    for (let i = 0; i < count; i++) faces[i] = i;
    return faces;
  }

  return { shells, byMaterial, slice, paint, through, every, weldCorners };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = FbxEdits;
