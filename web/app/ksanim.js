/* The animations that sit beside an Assetto Corsa car.
 *
 * The same reader as `fbxtool/ksanim.py`, and it has to stay the same: a car
 * opened in the browser and the same car described by `fbxinfo` are meant to
 * be the same car. `tests/test_web.py` reads both and compares them.
 *
 * Everything under `animations/` next to a `.kn5` is one clip — `steer`,
 * `car_door_L`, `car_wiper`, `shift`, `capote`. A clip names some of the
 * model's nodes and gives each of them a row of placements, and the game plays
 * it by *position* rather than by time: the steering wheel is however far
 * through `steer.ksanim` the front wheels are turned, and a door is however
 * far through `car_door_L.ksanim` it has been opened. So there is no clock in
 * the file and no duration — there are N placements and the game picks between
 * them, which is why what this offers is a position and not a stopwatch.
 *
 * The format has no magic number. Two versions are in circulation and both are
 * read — of 1,461 clips across the 209 zipped cars to hand, 1,379 are version
 * 2 and 71 are version 1:
 *
 *   u32   version, 1 or 2
 *   u32   node count
 *   per node:
 *     u32       length of the node's name
 *     bytes     the name, UTF-8
 *     u32       key count
 *     per key:
 *       v1:  16 x f32   a 4x4 placement, the translation in the last row
 *       v2:  10 x f32   quaternion x y z w, translation x y z, scale x y z
 *
 * A key is the node's whole local placement and not a change to it. A BMW Z3's
 * `capote.ksanim` opens on translation (0.0080, 0.8766, -0.2755), a rotation
 * of half a degree and a scale of 0.909, and the model's own `capote` node
 * states those three to the last digit — so at the start of a clip an animated
 * node is exactly where the file already had it, and playing one replaces the
 * placement rather than composing with it.
 *
 * Both versions come out as the same sixteen numbers in the order everything
 * here holds a matrix: `m[col * 4 + row]`, the translation last. That is what
 * a `.kn5` node already writes and what glTF writes, so a version 1 key is
 * used exactly as it is read.
 */
'use strict';

const FbxKsanim = (function () {
  //: How many bytes one key takes, per version.
  const KEY_BYTES = { 1: 64, 2: 40 };

  /* The most nodes and keys a clip is believed before it is called nonsense.
   * The largest to hand is a BMW Z3's `steer.ksanim` at 270 nodes, and the
   * longest row of keys is 303; these are far enough above both to leave any
   * real file alone while keeping a random file from asking for a gigabyte. */
  const MAX_NODES = 65536;
  const MAX_KEYS = 65536;
  const MAX_NAME = 1024;

  /* What a clip's nodes are called when they belong to the driver rather than
   * to the car. The driver is a separate model that lives inside the game and
   * not beside the car, so these name nothing here however sound the clip is:
   * of 123 clips across 22 cars, 48 are nothing but these. */
  const DRIVER_PREFIX = 'DRIVER:';

  const UTF8 = new TextDecoder('utf-8');

  /**
   * A version 2 key as the sixteen numbers version 1 writes directly.
   *
   * Composed the way a node's own placement is — the scale first, then the
   * rotation, then the translation — because that is what the numbers are: a
   * BMW Z3's soft top opens at the scale, rotation and translation its model
   * states for the same node, and read in any other order it would not.
   */
  function keyMatrix(v, at) {
    let [qx, qy, qz, qw] = [v[at], v[at + 1], v[at + 2], v[at + 3]];
    /* Normalised, because a quaternion stored as four floats and interpolated
     * by whatever wrote it does not always arrive at unit length, and a
     * rotation built from one that is not scales the node as well as turning
     * it. */
    const length = Math.hypot(qx, qy, qz, qw);
    if (length > 1e-12) { qx /= length; qy /= length; qz /= length; qw /= length; }
    else { qx = 0; qy = 0; qz = 0; qw = 1; }
    const tx = v[at + 4]; const ty = v[at + 5]; const tz = v[at + 6];
    const sx = v[at + 7]; const sy = v[at + 8]; const sz = v[at + 9];
    return [
      (1 - 2 * (qy * qy + qz * qz)) * sx, (2 * (qx * qy + qz * qw)) * sx,
      (2 * (qx * qz - qy * qw)) * sx, 0,
      (2 * (qx * qy - qz * qw)) * sy, (1 - 2 * (qx * qx + qz * qz)) * sy,
      (2 * (qy * qz + qx * qw)) * sy, 0,
      (2 * (qx * qz + qy * qw)) * sz, (2 * (qy * qz - qx * qw)) * sz,
      (1 - 2 * (qx * qx + qy * qy)) * sz, 0,
      tx, ty, tz, 1,
    ];
  }

  /**
   * Step through a clip, throwing at the first thing that does not fit.
   *
   * There is no magic number and nothing marks the end, so landing exactly on
   * the last byte is the only evidence the file was sized correctly all the
   * way through. That is a real test rather than a formality: it accepts all
   * 1,450 clips to hand to the last byte, and it is what rejects the eleven
   * `._`-prefixed macOS resource forks that come out of the same folders
   * looking like clips and are not.
   */
  function walk(bytes, loadKeys, only) {
    if (!bytes || bytes.byteLength < 8) {
      throw new Error('not a .ksanim — it is too short to hold a header');
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const version = view.getUint32(0, true);
    const count = view.getUint32(4, true);
    if (!KEY_BYTES[version]) {
      throw new Error(`.ksanim version ${version} — this reads 1 and 2`);
    }
    if (count > MAX_NODES) {
      throw new Error(`.ksanim claims ${count} nodes, which is not a clip`);
    }
    const stride = KEY_BYTES[version];
    const tracks = [];
    let at = 8;
    for (let index = 0; index < count; index++) {
      if (at + 4 > bytes.byteLength) {
        throw new Error(`.ksanim ends in the middle of node ${index + 1} of ${count}`);
      }
      const length = view.getUint32(at, true);
      at += 4;
      if (length > MAX_NAME || at + length + 4 > bytes.byteLength) {
        throw new Error(`.ksanim gives node ${index + 1} a name ${length} bytes long`);
      }
      const name = UTF8.decode(bytes.subarray(at, at + length));
      at += length;
      const keys = view.getUint32(at, true);
      at += 4;
      if (keys > MAX_KEYS) throw new Error(`.ksanim gives ${name || 'a node'} ${keys} keys`);
      const end = at + keys * stride;
      if (end > bytes.byteLength) {
        throw new Error(`.ksanim ends in the middle of ${name || 'a node'}`);
      }
      let matrices = null;
      if (loadKeys && (!only || only.has(name))) {
        matrices = [];
        /* Read once into a float array rather than a getFloat32 per number:
         * a steering clip is 270 nodes of up to 200 keys, which is 432,000 of
         * them, and this runs while somebody is waiting for a car to appear.
         * The copy is what makes the alignment safe — a clip's keys start at
         * whatever byte its names left off at. */
        const raw = new Float32Array(
          bytes.buffer.slice(bytes.byteOffset + at, bytes.byteOffset + end));
        const step = stride / 4;
        for (let k = 0; k < keys; k++) {
          matrices.push(version === 1
            ? Array.from(raw.subarray(k * step, k * step + 16))
            : keyMatrix(raw, k * step));
        }
      }
      tracks.push({ name, keys, matrices });
      at = end;
    }
    if (at !== bytes.byteLength) {
      throw new Error(`.ksanim has ${bytes.byteLength - at} bytes left over after `
        + `its ${count} node(s)`);
    }
    return { version, tracks };
  }

  /** Whether these bytes are a clip. */
  function looksLikeKsanim(bytes) {
    try {
      walk(bytes, false, null);
    } catch (error) {
      return false;
    }
    return true;
  }

  /**
   * Parse one clip.
   *
   * *loadKeys* decodes every placement. Left off, the clip is read for its
   * shape alone and the keys are stepped over.
   *
   * *only* narrows that to the nodes named in it, which is how a car reads a
   * clip: two thirds of the nodes a steering clip names belong to some other
   * model, and decoding their placements is work done to throw away.
   */
  function parse(bytes, { name = '', loadKeys = false, only = null } = {}) {
    const { version, tracks } = walk(bytes, loadKeys, only);
    return {
      name,
      version,
      tracks,
      /* The clip's length, which is its longest node. Every clip to hand gives
       * all of its nodes the same number, except that seven of a BMW Z3
       * steering clip's 270 nodes have 200 keys where the other 263 have 100 —
       * so a position is taken along each node's own row rather than along one
       * shared with the rest. */
      keys: tracks.reduce((most, track) => Math.max(most, track.keys), 0),
      driverOnly: tracks.length > 0
        && tracks.every((track) => track.name.startsWith(DRIVER_PREFIX)),
    };
  }

  /**
   * Where a clip puts each of its nodes at a position through it.
   *
   * *position* runs 0 to 1, which is how the game drives one: not a time, but
   * how far the wheel is turned or the door is open. The key is picked rather
   * than blended between — the clips are written with a hundred of them for
   * exactly this, and a placement is a rotation and a scale as well as a
   * translation, which do not average correctly element by element.
   *
   * A node is sampled along its own row, since the rows need not be the same
   * length.
   */
  function poseAt(clip, position) {
    const out = new Map();
    if (!clip || !clip.tracks) return out;
    const p = Math.min(1, Math.max(0, Number(position) || 0));
    for (const track of clip.tracks) {
      if (!track.matrices || !track.matrices.length) continue;
      const at = Math.round(p * (track.matrices.length - 1));
      out.set(track.name, track.matrices[at]);
    }
    return out;
  }

  /**
   * Whether a node goes anywhere over the clip.
   *
   * A clip written for one car and dropped beside another names that car's
   * nodes and holds this one's still: a BMW Z3's `steer.ksanim` names 270
   * nodes, 13 of which this car has, and every one of those 13 is the same
   * placement in all 100 of its keys — the turning is in the 257 belonging to
   * the BMW M Coupe the clip was authored against. So naming a node here is
   * not the same as moving one, and a picker that offered such a clip would be
   * offering a slider that does nothing.
   */
  function moves(track) {
    if (!track || !track.matrices || track.matrices.length < 2) return false;
    const first = track.matrices[0];
    return track.matrices.some(
      (other) => other.some((value, at) => Math.abs(value - first[at]) > 1e-6));
  }

  return { parse, poseAt, moves, looksLikeKsanim, DRIVER_PREFIX };
}());

if (typeof module !== 'undefined' && module.exports) module.exports = FbxKsanim;
