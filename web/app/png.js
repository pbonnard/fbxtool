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
    const stride = width * 4;
    // One filter byte in front of each row, saying the row is not filtered.
    const raw = new Uint8Array((stride + 1) * height);
    for (let y = 0; y < height; y++) {
      raw.set(pixels.subarray(y * stride, y * stride + stride), y * (stride + 1) + 1);
    }
    const header = new Uint8Array(13);
    const view = new DataView(header.buffer);
    view.setUint32(0, width);
    view.setUint32(4, height);
    header[8] = 8;                       // eight bits a channel
    header[9] = 6;                       // truecolour with alpha
    header[10] = 0;                      // deflate, which is the only one
    header[11] = 0;                      // and the only filter method
    header[12] = 0;                      // written in one pass, not interlaced

    const deflated = await drain(new Blob([raw]).stream()
      .pipeThrough(new CompressionStream('deflate')));
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
