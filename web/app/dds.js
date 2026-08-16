/* Reader for a DirectDraw Surface — `.dds`.
 *
 * A `.dds` is not a picture as far as a browser is concerned: `createImageBitmap`
 * refuses one, the way it refuses a KTX2 or a `.psd`, so a texture saved as one
 * loads as nothing and the surface wearing it falls back to a flat colour.
 * Assetto Corsa stores almost every texture this way — 111 of the 135 in one
 * car — so without this a `.kn5` opens as a grey model with its paint, its
 * badges and its dials all missing.
 *
 * What is read is the top mip level, decoded to RGBA.  The smaller levels
 * follow it in the file and are not needed: the renderer builds its own.
 *
 * The layout
 * ==========
 *
 * Everything is little-endian:
 *
 *   'DDS ' uint32 headerSize(124) uint32 flags uint32 height uint32 width
 *   uint32 pitchOrLinearSize uint32 depth uint32 mipCount uint32[11] reserved
 *   -- DDS_PIXELFORMAT at byte 76 --
 *   uint32 size(32) uint32 flags uint32 fourCC
 *   uint32 rgbBitCount uint32 rMask uint32 gMask uint32 bMask uint32 aMask
 *   uint32 caps[4] uint32 reserved
 *   -- and, only when fourCC is 'DX10', twenty more bytes --
 *   uint32 dxgiFormat uint32 dimension uint32 miscFlag uint32 arraySize uint32 miscFlags2
 *
 * The block formats
 * =================
 *
 * BC1 (`DXT1`) packs a 4x4 tile into eight bytes: two 16-bit endpoint colours
 * and sixteen two-bit selectors.  When the first endpoint is not greater than
 * the second the tile is in its one-bit-alpha mode, and the fourth selector
 * means transparent rather than a third of the way along.
 *
 * BC2 (`DXT3`) and BC3 (`DXT5`) put eight bytes of alpha in front of that
 * tile: BC2 four bits a pixel, straight; BC3 the same interpolated scheme the
 * colour uses, two endpoints and three-bit selectors.
 *
 * BC4 and BC5 are the alpha block on its own — one channel, or two — which is
 * how a normal map is stored when only two of its channels are kept.  The
 * third is rebuilt from them, since a normal is a unit vector.
 *
 * Uncompressed surfaces are read by their channel masks rather than by a list
 * of layouts: a mask says which bits of each pixel are which channel, and
 * shifting by the lowest set bit and scaling by the width covers every
 * arrangement a file may use, B8G8R8A8 and R5G6B5 alike.
 */
'use strict';

const FbxDds = (function () {
  const MAGIC = 0x20534444;                    // "DDS "
  const FOURCC = 0x00000004;                   // DDPF_FOURCC
  const RGB = 0x00000040;                      // DDPF_RGB
  const LUMINANCE = 0x00020000;                // DDPF_LUMINANCE
  const ALPHAPIXELS = 0x00000001;

  const code = (text) => text.charCodeAt(0) | (text.charCodeAt(1) << 8)
    | (text.charCodeAt(2) << 16) | (text.charCodeAt(3) << 24);

  const DXT1 = code('DXT1');
  const DXT2 = code('DXT2');
  const DXT3 = code('DXT3');
  const DXT4 = code('DXT4');
  const DXT5 = code('DXT5');
  const ATI1 = code('ATI1');
  const BC4U = code('BC4U');
  const ATI2 = code('ATI2');
  const BC5U = code('BC5U');
  const DX10 = code('DX10');

  //: The DXGI formats that are one of the block layouts read here.
  const DXGI = {
    70: DXT1, 71: DXT1, 72: DXT1,              // BC1 typeless / unorm / sRGB
    73: DXT3, 74: DXT3, 75: DXT3,              // BC2
    76: DXT5, 77: DXT5, 78: DXT5,              // BC3
    79: ATI1, 80: ATI1,                        // BC4 typeless / unorm
    82: ATI2, 83: ATI2,                        // BC5 typeless / unorm
    87: 'bgra8', 88: 'bgra8', 91: 'bgra8',
    28: 'rgba8', 29: 'rgba8',
  };

  /** True when these bytes are a DirectDraw Surface. */
  function looksLikeDds(bytes) {
    if (!bytes || bytes.length < 128) return false;
    return bytes[0] === 0x44 && bytes[1] === 0x44 && bytes[2] === 0x53 && bytes[3] === 0x20;
  }

  /** Where the lowest set bit of a mask is, and how wide the field is. */
  function field(mask) {
    if (!mask) return null;
    let shift = 0;
    while (!((mask >>> shift) & 1)) shift += 1;
    let width = 0;
    while ((mask >>> (shift + width)) & 1) width += 1;
    return { shift, width, max: (1 << width) - 1 };
  }

  const expand = (value, spec) => (spec.max ? Math.round((value * 255) / spec.max) : 0);

  /** One 16-bit endpoint as three 8-bit channels. */
  function unpack565(value, out) {
    const r = (value >> 11) & 0x1f;
    const g = (value >> 5) & 0x3f;
    const b = value & 0x1f;
    out[0] = (r << 3) | (r >> 2);
    out[1] = (g << 2) | (g >> 4);
    out[2] = (b << 3) | (b >> 2);
  }

  /**
   * The colour half of a BC1/BC2/BC3 tile, written into *rgba*.
   *
   * `punchThrough` is BC1's own mode, taken from the endpoint order; BC2 and
   * BC3 carry their alpha separately and always use four opaque colours.
   */
  function colourBlock(view, at, rgba, width, height, x0, y0, punchThrough) {
    const c0 = view.getUint16(at, true);
    const c1 = view.getUint16(at + 2, true);
    const bits = view.getUint32(at + 4, true);
    const palette = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]];
    const alpha = [255, 255, 255, 255];
    unpack565(c0, palette[0]);
    unpack565(c1, palette[1]);
    if (!punchThrough || c0 > c1) {
      for (let k = 0; k < 3; k++) {
        palette[2][k] = (2 * palette[0][k] + palette[1][k] + 1) / 3 | 0;
        palette[3][k] = (palette[0][k] + 2 * palette[1][k] + 1) / 3 | 0;
      }
    } else {
      for (let k = 0; k < 3; k++) {
        palette[2][k] = (palette[0][k] + palette[1][k]) >> 1;
        palette[3][k] = 0;
      }
      alpha[3] = 0;
    }
    for (let y = 0; y < 4; y++) {
      const row = y0 + y;
      if (row >= height) break;
      for (let x = 0; x < 4; x++) {
        const column = x0 + x;
        if (column >= width) continue;
        const pick = (bits >>> (2 * (4 * y + x))) & 3;
        const to = 4 * (row * width + column);
        rgba[to] = palette[pick][0];
        rgba[to + 1] = palette[pick][1];
        rgba[to + 2] = palette[pick][2];
        rgba[to + 3] = alpha[pick];
      }
    }
  }

  /**
   * The eight-byte interpolated block BC3 uses for alpha and BC4/BC5 for a
   * channel of their own, written into *channel* of *rgba*.
   */
  function interpolatedBlock(view, at, rgba, width, height, x0, y0, channel) {
    const a0 = view.getUint8(at);
    const a1 = view.getUint8(at + 1);
    const values = [a0, a1, 0, 0, 0, 0, 0, 0];
    if (a0 > a1) {
      for (let k = 1; k < 7; k++) values[k + 1] = ((7 - k) * a0 + k * a1) / 7 | 0;
    } else {
      for (let k = 1; k < 5; k++) values[k + 1] = ((5 - k) * a0 + k * a1) / 5 | 0;
      values[6] = 0;
      values[7] = 255;
    }
    // Sixteen three-bit selectors over six bytes, read as two 24-bit halves so
    // no selector straddles the read.
    const low = view.getUint8(at + 2) | (view.getUint8(at + 3) << 8)
      | (view.getUint8(at + 4) << 16);
    const high = view.getUint8(at + 5) | (view.getUint8(at + 6) << 8)
      | (view.getUint8(at + 7) << 16);
    for (let i = 0; i < 16; i++) {
      const y = y0 + (i >> 2);
      const x = x0 + (i & 3);
      if (y >= height || x >= width) continue;
      const pick = i < 8 ? (low >>> (3 * i)) & 7 : (high >>> (3 * (i - 8))) & 7;
      rgba[4 * (y * width + x) + channel] = values[pick];
    }
  }

  /** The four-bit-a-pixel alpha BC2 puts in front of its colour tile. */
  function explicitAlphaBlock(view, at, rgba, width, height, x0, y0) {
    for (let y = 0; y < 4; y++) {
      const row = y0 + y;
      const pair = view.getUint16(at + 2 * y, true);
      if (row >= height) break;
      for (let x = 0; x < 4; x++) {
        const column = x0 + x;
        if (column >= width) continue;
        const value = (pair >> (4 * x)) & 0xf;
        rgba[4 * (row * width + column) + 3] = value * 17;
      }
    }
  }

  /** A normal map stored as two channels has the third rebuilt from them. */
  function rebuildBlue(rgba) {
    for (let i = 0; i < rgba.length; i += 4) {
      const x = (rgba[i] / 127.5) - 1;
      const y = (rgba[i + 1] / 127.5) - 1;
      const z = Math.sqrt(Math.max(0, 1 - x * x - y * y));
      rgba[i + 2] = Math.round((z + 1) * 127.5);
      rgba[i + 3] = 255;
    }
  }

  function decodeBlocks(view, at, width, height, fourCC, rgba) {
    const wide = Math.max(1, Math.ceil(width / 4));
    const tall = Math.max(1, Math.ceil(height / 4));
    const stride = fourCC === DXT1 || fourCC === ATI1 ? 8 : 16;
    if (at + wide * tall * stride > view.byteLength) return false;
    for (let ty = 0; ty < tall; ty++) {
      for (let tx = 0; tx < wide; tx++) {
        const block = at + (ty * wide + tx) * stride;
        const x0 = tx * 4;
        const y0 = ty * 4;
        if (fourCC === DXT1) {
          colourBlock(view, block, rgba, width, height, x0, y0, true);
        } else if (fourCC === DXT2 || fourCC === DXT3) {
          explicitAlphaBlock(view, block, rgba, width, height, x0, y0);
          colourBlock(view, block + 8, rgba, width, height, x0, y0, false);
        } else if (fourCC === DXT4 || fourCC === DXT5) {
          colourBlock(view, block + 8, rgba, width, height, x0, y0, false);
          interpolatedBlock(view, block, rgba, width, height, x0, y0, 3);
        } else if (fourCC === ATI1) {
          interpolatedBlock(view, block, rgba, width, height, x0, y0, 0);
        } else {                                       // ATI2 / BC5: red, green
          interpolatedBlock(view, block, rgba, width, height, x0, y0, 0);
          interpolatedBlock(view, block + 8, rgba, width, height, x0, y0, 1);
        }
      }
    }
    if (fourCC === ATI1) {
      // One channel is the picture, not the red of a picture missing two.
      for (let i = 0; i < rgba.length; i += 4) {
        rgba[i + 1] = rgba[i];
        rgba[i + 2] = rgba[i];
        rgba[i + 3] = 255;
      }
    } else if (fourCC === ATI2) {
      rebuildBlue(rgba);
    }
    return true;
  }

  function decodePlain(view, at, width, height, format, rgba) {
    const bytes = format.bits / 8;
    if (at + width * height * bytes > view.byteLength) return false;
    const red = field(format.rMask);
    const green = field(format.gMask);
    const blue = field(format.bMask);
    const alpha = field(format.aMask);
    // A luminance surface has one channel and means it for all three.
    const grey = format.luminance && !green && !blue;
    for (let i = 0; i < width * height; i++) {
      const to = at + i * bytes;
      let pixel = 0;
      for (let k = 0; k < bytes; k++) pixel |= view.getUint8(to + k) << (8 * k);
      pixel >>>= 0;
      const r = red ? expand((pixel >>> red.shift) & red.max, red) : 0;
      rgba[4 * i] = r;
      rgba[4 * i + 1] = grey ? r
        : (green ? expand((pixel >>> green.shift) & green.max, green) : 0);
      rgba[4 * i + 2] = grey ? r
        : (blue ? expand((pixel >>> blue.shift) & blue.max, blue) : 0);
      rgba[4 * i + 3] = alpha ? expand((pixel >>> alpha.shift) & alpha.max, alpha) : 255;
    }
    return true;
  }

  /**
   * The top mip level of a DDS, as RGBA pixels.
   *
   * Returns null for anything this does not decode — a cube map's later faces,
   * a floating-point surface, BC6H or BC7 — rather than a guess.  A texture
   * nobody can tell is wrong is one nobody fixes.
   */
  function decode(bytes) {
    if (!looksLikeDds(bytes)) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(0, true) !== MAGIC || view.getUint32(4, true) !== 124) return null;
    const height = view.getUint32(12, true);
    const width = view.getUint32(16, true);
    if (!width || !height || width > 16384 || height > 16384) return null;

    const flags = view.getUint32(80, true);
    let fourCC = (flags & FOURCC) ? view.getUint32(84, true) : 0;
    const bits = view.getUint32(88, true);
    const format = {
      bits,
      rMask: view.getUint32(92, true),
      gMask: view.getUint32(96, true),
      bMask: view.getUint32(100, true),
      aMask: (flags & ALPHAPIXELS) ? view.getUint32(104, true) : 0,
      luminance: (flags & LUMINANCE) !== 0,
    };
    let at = 128;
    if (fourCC === DX10) {
      if (bytes.length < 148) return null;
      const dxgi = DXGI[view.getUint32(128, true)];
      at = 148;
      if (dxgi === undefined) return null;
      if (dxgi === 'bgra8' || dxgi === 'rgba8') {
        fourCC = 0;
        format.bits = 32;
        format.rMask = dxgi === 'bgra8' ? 0x00ff0000 : 0x000000ff;
        format.gMask = 0x0000ff00;
        format.bMask = dxgi === 'bgra8' ? 0x000000ff : 0x00ff0000;
        format.aMask = 0xff000000;
      } else {
        fourCC = dxgi;
      }
    }

    const rgba = new Uint8ClampedArray(width * height * 4);
    let done;
    if (fourCC === BC4U) done = decodeBlocks(view, at, width, height, ATI1, rgba);
    else if (fourCC === BC5U) done = decodeBlocks(view, at, width, height, ATI2, rgba);
    else if (fourCC) {
      if (fourCC !== DXT1 && fourCC !== DXT2 && fourCC !== DXT3 && fourCC !== DXT4
        && fourCC !== DXT5 && fourCC !== ATI1 && fourCC !== ATI2) return null;
      done = decodeBlocks(view, at, width, height, fourCC, rgba);
    } else if ((flags & (RGB | LUMINANCE)) && bits >= 8 && bits <= 32 && bits % 8 === 0) {
      done = decodePlain(view, at, width, height, format, rgba);
    } else {
      return null;
    }
    return done ? { width, height, rgba } : null;
  }

  return { decode, looksLikeDds };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = FbxDds;
