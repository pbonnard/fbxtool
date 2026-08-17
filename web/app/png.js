/* Write a PNG, keeping the colour on a texel that is not there.
 *
 * The one thing a browser will not do for us. `canvas.toBlob` is the obvious
 * way to make a PNG and it cannot be used for an export, because a 2D canvas
 * holds its pixels premultiplied: a texel at zero alpha comes back black and
 * the colour that was on it is gone, since dividing it back out is a division
 * by nothing. The viewer's upload path has been careful about that for a while
 * — every `createImageBitmap` in it is told not to premultiply — and the
 * export was still going through a canvas, so a car's own textures came out
 * black wherever their alpha was empty. A Renault 5 Turbo has twenty-four such
 * among its forty-two: its rubber, its carpet, its interior body panels and
 * its brass, all of them a picture that matters under an alpha of nothing.
 *
 * So the file is written here instead, from the pixels as they stand. A PNG is
 * a signature, an IHDR, one zlib stream of filtered rows and an IEND, and
 * `CompressionStream('deflate')` is a zlib stream — the one part worth having
 * a library for is the part the platform already has.
 *
 * Rows are written unfiltered. Filtering is what makes a PNG small and this
 * gives that up: a photograph comes out perhaps a third larger than one an
 * encoder would write. It buys exactness and a hundred lines fewer, and an
 * exported `.glb` is not a delivery format for pictures.
 */
'use strict';

const FbxPng = (function () {
  const MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

  //: The usual reversed-polynomial table, built once.
  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  /** A chunk: its length, its tag, its body, and the CRC over the last two. */
  function chunk(tag, body) {
    const out = new Uint8Array(12 + body.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, body.length);
    for (let i = 0; i < 4; i++) out[4 + i] = tag.charCodeAt(i);
    out.set(body, 8);
    view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
    return out;
  }

  /* The deflating done somewhere other than here.
   *
   * `CompressionStream` is the platform's own deflate, and it is one thread of
   * it. An export is a hundred pictures and forty megapixels — an Audi S8's is
   * 96 and 40.7 — and nine tenths of what an export costs is that one thread
   * working through them. Measured: 3.5 seconds of a 4.0-second export, with
   * everything else in this file together under a fifth of a second.
   *
   * So the deflate alone goes to a handful of workers. Nothing else does: the
   * rows are still packed here and the chunks still written here, and what
   * crosses is one buffer of bytes and one buffer back. The worker is written
   * out as text because a page that is one file has nowhere to point a worker
   * at — and a `blob:` URL is somewhere, even from `file://`.
   */
  const WORKER = `
    onmessage = async (event) => {
      const { id, raw } = event.data;
      try {
        const reader = new Blob([raw]).stream()
          .pipeThrough(new CompressionStream('deflate')).getReader();
        const parts = [];
        let total = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          parts.push(value);
          total += value.length;
        }
        const out = new Uint8Array(total);
        let at = 0;
        for (const part of parts) { out.set(part, at); at += part.length; }
        postMessage({ id, out }, [out.buffer]);
      } catch (error) {
        postMessage({ id, out: null });      // the caller deflates it itself
      }
    };`;

  //: The workers, made once and kept: false where this is somewhere without
  //: them, which is somewhere the export still works and takes longer.
  let pool = null;

  function deflaters() {
    if (pool !== null) return pool;
    pool = false;
    if (typeof Worker !== 'function' || typeof URL === 'undefined'
      || typeof URL.createObjectURL !== 'function'
      || typeof Blob !== 'function') return pool;
    try {
      /* Not revoked. The URL is one small blob for the life of the page, and
       * a worker that has not finished starting when it goes never starts. */
      const url = URL.createObjectURL(new Blob([WORKER], { type: 'text/javascript' }));
      const cores = (typeof navigator !== 'undefined'
        && navigator.hardwareConcurrency) || 4;
      const waiting = new Map();
      const made = [];
      for (let i = 0; i < Math.max(1, Math.min(6, cores - 1)); i++) {
        const worker = new Worker(url);
        worker.onmessage = (event) => {
          const wanted = waiting.get(event.data.id);
          if (!wanted) return;
          waiting.delete(event.data.id);
          wanted.settle(event.data.out || null);
        };
        // A worker that has fallen over answers nothing, so everything it was
        // holding is handed back unanswered rather than left waiting forever.
        worker.onerror = () => {
          for (const [id, wanted] of [...waiting]) {
            if (wanted.worker !== worker) continue;
            waiting.delete(id);
            wanted.settle(null);
          }
        };
        made.push(worker);
      }
      pool = { made, waiting, at: 0, id: 0 };
    } catch (error) {
      pool = false;                    // no workers here: this thread will do
    }
    return pool;
  }

  /** *raw* deflated, on a worker where there is one and here where there is not. */
  async function deflate(raw) {
    const farm = deflaters();
    if (farm) {
      const worker = farm.made[farm.at++ % farm.made.length];
      const id = farm.id++;
      /* Copied across rather than handed over. A transfer would save a few
       * milliseconds on sixteen megabytes and leave nothing to fall back to
       * when the worker cannot answer, which is the wrong trade. */
      const out = await new Promise((settle) => {
        farm.waiting.set(id, { settle, worker });
        try {
          worker.postMessage({ id, raw });
        } catch (error) {
          farm.waiting.delete(id);
          settle(null);
        }
      });
      if (out) return out;
    }
    return drain(new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate')));
  }

  /** Everything a stream hands back, joined. */
  async function drain(stream) {
    const reader = stream.getReader();
    const parts = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      total += value.length;
    }
    const out = new Uint8Array(total);
    let at = 0;
    for (const part of parts) { out.set(part, at); at += part.length; }
    return out;
  }

  /** Whether this is somewhere a PNG can be written at all. */
  function available() {
    return typeof CompressionStream === 'function';
  }

  /**
   * *pixels* as a PNG, eight-bit RGBA, top row first.
   *
   * Returns null where the platform has no deflate to offer, which leaves the
   * caller to fall back rather than to write a file nothing can read.
   */
  async function encode(pixels, width, height) {
    if (!available() || !width || !height) return null;
    if (!pixels || pixels.length < width * height * 4) return null;
    /* Whether the alpha channel is saying anything at all.
     *
     * Where it is not, the picture is written without one — which is a quarter
     * less to deflate, and deflating is what an export spends its time on. A
     * car's textures are mostly solid: an Audi S8 writes 96 pictures on the
     * way out and the alpha of most of them is nothing but 255 repeated four
     * million times. Nothing is lost by leaving it out; a picture with an
     * alpha that matters keeps it, which is the whole reason this file is
     * written here rather than by a canvas. */
    const texels = width * height * 4;
    let solid = true;
    for (let at = 3; at < texels; at += 4) {
      if (pixels[at] !== 255) { solid = false; break; }
    }
    const channels = solid ? 3 : 4;
    const stride = width * channels;
    // One filter byte in front of each row, saying the row is not filtered.
    const raw = new Uint8Array((stride + 1) * height);
    if (solid) {
      let from = 0;
      for (let y = 0; y < height; y++) {
        let to = y * (stride + 1) + 1;
        for (let x = 0; x < width; x++) {
          raw[to] = pixels[from];
          raw[to + 1] = pixels[from + 1];
          raw[to + 2] = pixels[from + 2];
          to += 3;
          from += 4;
        }
      }
    } else {
      for (let y = 0; y < height; y++) {
        raw.set(pixels.subarray(y * stride, y * stride + stride), y * (stride + 1) + 1);
      }
    }
    const header = new Uint8Array(13);
    const view = new DataView(header.buffer);
    view.setUint32(0, width);
    view.setUint32(4, height);
    header[8] = 8;                       // eight bits a channel
    header[9] = solid ? 2 : 6;           // truecolour, with an alpha or without
    header[10] = 0;                      // deflate, which is the only one
    header[11] = 0;                      // and the only filter method
    header[12] = 0;                      // written in one pass, not interlaced

    const deflated = await deflate(raw);
    if (!deflated) return null;
    const parts = [new Uint8Array(MAGIC), chunk('IHDR', header),
      chunk('IDAT', deflated), chunk('IEND', new Uint8Array(0))];
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const part of parts) { out.set(part, at); at += part.length; }
    return out;
  }

  return { encode, available, crc32 };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = FbxPng;
