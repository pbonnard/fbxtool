/* Reader for the flattened image inside a Photoshop document — `.psd`.
 *
 * A `.psd` is not a picture as far as a browser is concerned: `createImageBitmap`
 * refuses one, the way it refuses a KTX2, so a texture saved as one loads as
 * nothing and the surface wearing it falls back to a flat colour.  3ds Max
 * itself reads them, which is why car scenes name them — a tyre whose tread and
 * sidewall lettering live in a `.psd` comes out as a plain black ring without
 * this.
 *
 * What is read is the *composite*: the flattened picture Photoshop stores at
 * the end of the file for anything that cannot open the layer stack.  The
 * layers themselves are not read and do not need to be — the composite is what
 * a renderer samples, and it is what Photoshop shows when the file is opened.
 *
 * The layout
 * ==========
 *
 * Everything is big-endian, and the four sections in front of the picture are
 * each length-prefixed, so they are skipped rather than understood:
 *
 *   '8BPS'  uint16 version  byte[6]  uint16 channels
 *   uint32 height  uint32 width  uint16 depth  uint16 mode
 *   uint32 length; colour mode data
 *   uint32 length; image resources
 *   uint32 length; layer and mask info
 *   uint16 compression; the composite
 *
 * The composite is *planar* — the whole of one channel, then the whole of the
 * next — and not interleaved, which is the trap: read as RGB triples it comes
 * out as three bands of nonsense.
 */
'use strict';

const FbxPsd = (function () {
  //: Colour modes, as Photoshop numbers them.  Only the two that can be turned
  //: into pixels without a colour profile are read; a CMYK or Lab texture is
  //: rare in a model and would come out wrong rather than merely absent.
  const GREYSCALE = 1;
  const RGB = 3;

  const looksLikePsd = (bytes) => !!bytes && bytes.length > 26
    && bytes[0] === 0x38 && bytes[1] === 0x42 && bytes[2] === 0x50 && bytes[3] === 0x53;

  /**
   * One channel's rows, run-length encoded the way PackBits does it.
   *
   * A row is a run of ops: a byte n below 128 means copy the next n + 1 bytes,
   * above 128 means repeat the next byte 257 - n times, and exactly 128 means
   * nothing at all.  Each row's compressed length is in the table read before
   * this, which is what lets a row that ends early be skipped past rather than
   * run into the next one.
   */
  function unpackBits(bytes, at, end, out, into, wanted) {
    let write = into;
    while (at < end && write < into + wanted) {
      const n = bytes[at]; at += 1;
      if (n < 128) {
        const run = Math.min(n + 1, into + wanted - write, end - at);
        out.set(bytes.subarray(at, at + run), write);
        write += run; at += run;
      } else if (n > 128) {
        if (at >= end) break;
        const run = Math.min(257 - n, into + wanted - write);
        out.fill(bytes[at], write, write + run);
        write += run; at += 1;
      }
    }
    return write;
  }

  /**
   * The composite picture of a Photoshop document, as RGBA pixels.
   *
   * Returns null for anything it will not claim to understand — a 16- or
   * 32-bit document, a colour mode that needs a profile, a compression this
   * does not do — so the caller treats it as an image that would not decode
   * rather than as one drawn wrongly.
   */
  function decode(bytes) {
    if (!looksLikePsd(bytes)) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const version = view.getUint16(4, false);
    if (version !== 1) return null;         // 2 is a PSB, whose sizes are wider
    const channels = view.getUint16(12, false);
    const height = view.getUint32(14, false);
    const width = view.getUint32(18, false);
    const depth = view.getUint16(22, false);
    const mode = view.getUint16(24, false);
    if (depth !== 8) return null;
    if (mode !== RGB && mode !== GREYSCALE) return null;
    if (!width || !height || !channels) return null;
    // A texture large enough to be a mistake is one this should not try to
    // hold three copies of in memory.
    if (width > 16384 || height > 16384) return null;

    let at = 26;
    for (let section = 0; section < 3; section++) {
      if (at + 4 > bytes.length) return null;
      at += 4 + view.getUint32(at, false);
    }
    if (at + 2 > bytes.length) return null;
    const compression = view.getUint16(at, false);
    at += 2;

    const pixels = width * height;
    // Only the channels that are drawn with: three and an alpha for RGB, one
    // and an alpha for greyscale.  A document can carry spare channels behind
    // those and they are not part of the picture.
    const colours = mode === RGB ? 3 : 1;
    const wanted = Math.min(channels, colours + 1);
    const planes = [];

    if (compression === 0) {
      for (let c = 0; c < wanted; c++) {
        if (at + pixels > bytes.length) return null;
        planes.push(bytes.subarray(at, at + pixels));
        at += pixels;
      }
    } else if (compression === 1) {
      // Every channel's row lengths come first, all of them, before any of the
      // rows — so the table is the whole file's and not one channel's.
      const table = at;
      const rows = channels * height;
      if (table + rows * 2 > bytes.length) return null;
      at += rows * 2;
      for (let c = 0; c < channels; c++) {
        const keep = c < wanted;
        const plane = keep ? new Uint8Array(pixels) : null;
        let write = 0;
        for (let row = 0; row < height; row++) {
          const size = view.getUint16(table + (c * height + row) * 2, false);
          if (at + size > bytes.length) return null;
          if (keep) {
            write = unpackBits(bytes, at, at + size, plane, write,
                               Math.min(width, pixels - write));
          }
          at += size;
        }
        if (keep) planes.push(plane);
      }
    } else {
      return null;                          // 2 and 3 are zip, which no .psd
    }                                       // in the wild writes for this

    if (planes.length < colours) return null;
    const rgba = new Uint8ClampedArray(pixels * 4);
    const red = planes[0];
    const green = colours === 3 ? planes[1] : planes[0];
    const blue = colours === 3 ? planes[2] : planes[0];
    const alpha = planes.length > colours ? planes[colours] : null;
    for (let i = 0; i < pixels; i++) {
      rgba[4 * i] = red[i];
      rgba[4 * i + 1] = green[i];
      rgba[4 * i + 2] = blue[i];
      rgba[4 * i + 3] = alpha ? alpha[i] : 255;
    }
    return { width, height, rgba };
  }

  return { decode, looksLikePsd };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = FbxPsd;
