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
  //: BC7 only ever arrives through a DX10 header, so it has no fourCC of
  //: its own in any file; this one is ours, to say so past the header.
  const BC7 = code('BC7 ');

  //: The DXGI formats that are one of the block layouts read here.
  const DXGI = {
    70: DXT1, 71: DXT1, 72: DXT1,              // BC1 typeless / unorm / sRGB
    73: DXT3, 74: DXT3, 75: DXT3,              // BC2
    76: DXT5, 77: DXT5, 78: DXT5,              // BC3
    79: ATI1, 80: ATI1,                        // BC4 typeless / unorm
    82: ATI2, 83: ATI2,                        // BC5 typeless / unorm
    97: BC7, 98: BC7, 99: BC7,                 // BC7 typeless / unorm / sRGB
    87: 'bgra8', 91: 'bgra8',
    // B8G8R8X8: the fourth byte is padding rather than an alpha, and reading
    // it as one hides the picture. An Alfa A110's are all zero there, so its
    // twenty-two BGRX textures would come out fully transparent.
    88: 'bgrx8', 92: 'bgrx8', 93: 'bgrx8',
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

  /** One 16-bit endpoint as three 8-bit channels. */
  function unpack565(value, out, at) {
    const r = (value >> 11) & 0x1f;
    const g = (value >> 5) & 0x3f;
    const b = value & 0x1f;
    out[at] = (r << 3) | (r >> 2);
    out[at + 1] = (g << 2) | (g >> 4);
    out[at + 2] = (b << 3) | (b >> 2);
  }

  /* Room for one tile's four colours, and for the eight steps an interpolated
   * block runs through, kept here rather than made afresh for each.
   *
   * A tile is sixteen pixels, so a 2048-square picture is 262,144 of them, and
   * a fresh `[[0,0,0],[0,0,0],[0,0,0],[0,0,0]]` apiece is a million small
   * arrays for one texture — which is a car's worth of work handed to the
   * collector rather than to the decoder. One block is decoded at a time and
   * read before the next begins, so there is nothing to keep them apart for.
   */
  //: One BC7 tile's sixteen bytes, and a fifth word to shift into.
  const BC7_WORDS = new Uint32Array(5);
  const TILE = new Uint8Array(12);      // four colours, three channels each
  const TILE_ALPHA = new Uint8Array([255, 255, 255, 255]);
  const STEPS = new Uint8Array(8);

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
    unpack565(c0, TILE, 0);
    unpack565(c1, TILE, 3);
    if (!punchThrough || c0 > c1) {
      for (let k = 0; k < 3; k++) {
        TILE[6 + k] = (2 * TILE[k] + TILE[3 + k] + 1) / 3 | 0;
        TILE[9 + k] = (TILE[k] + 2 * TILE[3 + k] + 1) / 3 | 0;
      }
      // Put back whatever the last block through here left it as.
      TILE_ALPHA[3] = 255;
    } else {
      for (let k = 0; k < 3; k++) {
        TILE[6 + k] = (TILE[k] + TILE[3 + k]) >> 1;
        TILE[9 + k] = 0;
      }
      TILE_ALPHA[3] = 0;
    }
    for (let y = 0; y < 4; y++) {
      const row = y0 + y;
      if (row >= height) break;
      for (let x = 0; x < 4; x++) {
        const column = x0 + x;
        if (column >= width) continue;
        const pick = (bits >>> (2 * (4 * y + x))) & 3;
        const to = 4 * (row * width + column);
        const from = pick * 3;
        rgba[to] = TILE[from];
        rgba[to + 1] = TILE[from + 1];
        rgba[to + 2] = TILE[from + 2];
        rgba[to + 3] = TILE_ALPHA[pick];
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
    const values = STEPS;
    values[0] = a0;
    values[1] = a1;
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

  // ------------------------------------------------------------------- BC7

  /* BC7 is the last of the block formats and the only one with modes: eight of
   * them, each cutting a 4x4 tile up differently and spending its 128 bits
   * differently. A block says which by how many zeros it begins with, and
   * everything after that follows from the mode — how many subsets the tile is
   * cut into, how wide an endpoint is, whether alpha is stored apart from
   * colour, and how many bits an index gets.
   *
   * It is what a modern car is saved in. Sixteen textures across five of the
   * cars to hand are BC7 and every one of them is bound to a material: a BMW
   * Z3M's `dirty-glass`, an Alfa TZ2's brake disc, a Donkervoort's gauges.
   * Refused, each is a surface with no picture on it.
   *
   * The tables are the specification's, transcribed: which subset each of the
   * sixteen pixels belongs to under each of the 64 partitions, and which pixel
   * anchors each subset. An anchor stores one bit fewer, its high bit being
   * implicitly zero — that is what makes an endpoint pair unambiguous, and it
   * is where a decoder written from memory goes wrong. What settles whether
   * this one is right is not reading it back: every BC7 texture in the cars to
   * hand is decoded here and compared against Pillow, texel for texel.
   */
  const bitsOf = (text) => Uint8Array.from(text, (c) => c.charCodeAt(0) - 48);

  const PARTITION2 = [
    '0011001100110011', '0001000100010001', '0111011101110111', '0001001100110111',
    '0000000100010011', '0011011101111111', '0001001101111111', '0000000100110111',
    '0000000000010011', '0011011111111111', '0000000101111111', '0000000000010111',
    '0001011111111111', '0000000011111111', '0000111111111111', '0000000000001111',
    '0000100011101111', '0111000100000000', '0000000010001110', '0111001100010000',
    '0011000100000000', '0000100011001110', '0000000010001100', '0111001100110001',
    '0011000100010000', '0000100010001100', '0110011001100110', '0011011001101100',
    '0001011111101000', '0000111111110000', '0111000110001110', '0011100110011100',
    '0101010101010101', '0000111100001111', '0101101001011010', '0011001111001100',
    '0011110000111100', '0101010110101010', '0110100101101001', '0101101010100101',
    '0111001111001110', '0001001111001000', '0011001001001100', '0011101111011100',
    '0110100110010110', '0011110011000011', '0110011010011001', '0000011001100000',
    '0100111001000000', '0010011100100000', '0000001001110010', '0000010011100100',
    '0110110010010011', '0011011011001001', '0110001110011100', '0011100111000110',
    '0110110011001001', '0110001100111001', '0111111010000001', '0001100011100111',
    '0000111100110011', '0011001111110000', '0010001011101110', '0100010001110111',
  ].map(bitsOf);

  const PARTITION3 = [
    '0011001102212222', '0001001122112221', '0000200122112211', '0222002200110111',
    '0000000011221122', '0011001100220022', '0022002211111111', '0011001122112211',
    '0000000011112222', '0000111111112222', '0000111122222222', '0012001200120012',
    '0112011201120112', '0122012201220122', '0011011211221222', '0011200122002220',
    '0001001101121122', '0111001120012200', '0000112211221122', '0022002200221111',
    '0111011102220222', '0001000122212221', '0000001101220122', '0000110022102210',
    '0122012200110000', '0012001211222222', '0110122112210110', '0000011012211221',
    '0022110211020022', '0110011020022222', '0011012201220011', '0000200022112221',
    '0000000211221222', '0222002200120011', '0011001200220222', '0120012001200120',
    '0000111122220000', '0120120120120120', '0120201212010120', '0011220011220011',
    '0011112222000011', '0101010122222222', '0000000021212121', '0022112200221122',
    '0022001100220011', '0220122102201221', '0101222222220101', '0000212121212121',
    '0101010101012222', '0222011102220111', '0002111200021112', '0000211221122112',
    '0222011101110222', '0002111211120002', '0110011001102222', '0000000021122112',
    '0110011022222222', '0022001100110022', '0022112211220022', '0000000000002112',
    '0002000100020001', '0222122202221222', '0101222222222222', '0111201122012220',
  ].map(bitsOf);

  //: Which pixel anchors the second subset of a two-subset partition, and the
  //: second and third of a three-subset one. The first is always pixel zero.
  const ANCHOR2 = Uint8Array.from([
    15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15,
    15, 2, 8, 2, 2, 8, 8, 15, 2, 8, 2, 2, 8, 8, 2, 2,
    15, 15, 6, 8, 2, 8, 15, 15, 2, 8, 2, 2, 2, 15, 15, 6,
    6, 2, 6, 8, 15, 15, 2, 2, 15, 15, 15, 15, 15, 2, 2, 15,
  ]);
  const ANCHOR3_SECOND = Uint8Array.from([
    3, 3, 15, 15, 8, 3, 15, 15, 8, 8, 6, 6, 6, 5, 3, 3,
    3, 3, 8, 15, 3, 3, 6, 10, 5, 8, 8, 6, 8, 5, 15, 15,
    8, 15, 3, 5, 6, 10, 8, 15, 15, 3, 15, 5, 15, 15, 15, 15,
    3, 15, 5, 5, 5, 8, 5, 10, 5, 10, 8, 13, 15, 12, 3, 3,
  ]);
  const ANCHOR3_THIRD = Uint8Array.from([
    15, 8, 8, 3, 15, 15, 3, 8, 15, 15, 15, 15, 15, 15, 15, 8,
    15, 8, 15, 3, 15, 8, 15, 8, 3, 15, 6, 10, 15, 15, 10, 8,
    15, 3, 15, 10, 10, 8, 9, 10, 6, 15, 8, 15, 3, 6, 6, 8,
    15, 3, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 3, 15, 15, 8,
  ]);

  /* What each mode spends its bits on, in the order the block states them:
   * how many subsets, then the widths of the partition, the rotation, the
   * index selector, a colour endpoint, an alpha endpoint, the per-endpoint
   * parity bits, the per-subset shared parity bits, and the two index sets. */
  const BC7_MODES = [
    { ns: 3, pb: 4, rb: 0, isb: 0, cb: 4, ab: 0, epb: 1, spb: 0, ib: 3, ib2: 0 },
    { ns: 2, pb: 6, rb: 0, isb: 0, cb: 6, ab: 0, epb: 0, spb: 1, ib: 3, ib2: 0 },
    { ns: 3, pb: 6, rb: 0, isb: 0, cb: 5, ab: 0, epb: 0, spb: 0, ib: 2, ib2: 0 },
    { ns: 2, pb: 6, rb: 0, isb: 0, cb: 7, ab: 0, epb: 1, spb: 0, ib: 2, ib2: 0 },
    { ns: 1, pb: 0, rb: 2, isb: 1, cb: 5, ab: 6, epb: 0, spb: 0, ib: 2, ib2: 3 },
    { ns: 1, pb: 0, rb: 2, isb: 0, cb: 7, ab: 8, epb: 0, spb: 0, ib: 2, ib2: 2 },
    { ns: 1, pb: 0, rb: 0, isb: 0, cb: 7, ab: 7, epb: 1, spb: 0, ib: 4, ib2: 0 },
    { ns: 2, pb: 6, rb: 0, isb: 0, cb: 5, ab: 5, epb: 1, spb: 0, ib: 2, ib2: 0 },
  ];

  //: How far along the two endpoints an index sits, in sixty-fourths.
  const WEIGHTS = {
    2: [0, 21, 43, 64],
    3: [0, 9, 18, 27, 37, 46, 55, 64],
    4: [0, 4, 9, 13, 17, 21, 26, 30, 34, 38, 43, 47, 51, 55, 60, 64],
  };

  /** A value of *width* bits stretched over the full eight, as the spec says. */
  function stretch(value, width) {
    if (width >= 8) return value & 255;
    return ((value << (8 - width)) | (value >>> Math.max(0, 2 * width - 8))) & 255;
  }

  const between = (a, b, weight) => (((64 - weight) * a + weight * b + 32) >> 6);

  /** One sixteen-byte BC7 tile, written into *rgba*. */
  function bc7Block(view, at, rgba, width, height, x0, y0) {
    /* The tile's sixteen bytes taken in four reads rather than in a hundred
     * and twenty-eight.
     *
     * Every field of a BC7 block is a run of bits at some offset, and reading
     * them a bit at a time out of the view is a call apiece — around a hundred
     * and thirty per tile, which on a 2048-square picture is thirty-three
     * million of them to say what four reads and a shift already said. The
     * fifth word is room to shift into, so a field lying across the end of one
     * word needs no special case; no field here is longer than eight bits, so
     * nothing reaches past it.
     */
    BC7_WORDS[0] = view.getUint32(at, true);
    BC7_WORDS[1] = view.getUint32(at + 4, true);
    BC7_WORDS[2] = view.getUint32(at + 8, true);
    BC7_WORDS[3] = view.getUint32(at + 12, true);
    BC7_WORDS[4] = 0;
    let bit = 0;
    const read = (count) => {
      if (count <= 0) return 0;
      const word = bit >>> 5;
      const offset = bit & 31;
      let out = BC7_WORDS[word] >>> offset;
      if (offset + count > 32) out |= BC7_WORDS[word + 1] << (32 - offset);
      bit += count;
      return out & ((1 << count) - 1);
    };
    const put = (x, y, r, g, b, a) => {
      if (x0 + x >= width || y0 + y >= height) return;
      const to = ((y0 + y) * width + (x0 + x)) * 4;
      rgba[to] = r; rgba[to + 1] = g; rgba[to + 2] = b; rgba[to + 3] = a;
    };

    let mode = -1;
    for (let m = 0; m < 8; m++) {
      if (read(1)) { mode = m; break; }
    }
    // Eight zero bits is a mode the format reserves, and a block in it reads
    // as nothing at all rather than as whatever happens to follow.
    if (mode < 0) {
      for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) put(x, y, 0, 0, 0, 0);
      return;
    }

    const spec = BC7_MODES[mode];
    const partition = spec.pb ? read(spec.pb) : 0;
    const rotation = spec.rb ? read(spec.rb) : 0;
    const swapped = spec.isb ? read(spec.isb) : 0;
    const ends = spec.ns * 2;

    const channel = (count) => {
      const out = new Array(ends);
      for (let i = 0; i < ends; i++) out[i] = read(count);
      return out;
    };
    const red = channel(spec.cb);
    const green = channel(spec.cb);
    const blue = channel(spec.cb);
    const alpha = spec.ab ? channel(spec.ab) : new Array(ends).fill(255);

    /* The parity bits, which are the last bit of every endpoint and are stored
     * away from it: one for each end, or one shared by both ends of a subset. */
    let colourWidth = spec.cb;
    let alphaWidth = spec.ab;
    if (spec.epb || spec.spb) {
      const parity = new Array(ends);
      if (spec.epb) {
        for (let i = 0; i < ends; i++) parity[i] = read(1);
      } else {
        for (let i = 0; i < spec.ns; i++) {
          const shared = read(1);
          parity[2 * i] = shared;
          parity[2 * i + 1] = shared;
        }
      }
      for (let i = 0; i < ends; i++) {
        red[i] = (red[i] << 1) | parity[i];
        green[i] = (green[i] << 1) | parity[i];
        blue[i] = (blue[i] << 1) | parity[i];
        if (spec.ab) alpha[i] = (alpha[i] << 1) | parity[i];
      }
      colourWidth += 1;
      if (spec.ab) alphaWidth += 1;
    }
    for (let i = 0; i < ends; i++) {
      red[i] = stretch(red[i], colourWidth);
      green[i] = stretch(green[i], colourWidth);
      blue[i] = stretch(blue[i], colourWidth);
      if (spec.ab) alpha[i] = stretch(alpha[i], alphaWidth);
    }

    // Which subset each pixel belongs to, and which pixel anchors each subset.
    const table = spec.ns === 3 ? PARTITION3[partition]
      : (spec.ns === 2 ? PARTITION2[partition] : null);
    const anchors = [0];
    if (spec.ns === 2) {
      anchors.push(ANCHOR2[partition]);
    } else if (spec.ns === 3) {
      anchors.push(ANCHOR3_SECOND[partition], ANCHOR3_THIRD[partition]);
    }
    const subsetOf = (pixel) => (table ? table[pixel] : 0);

    const primary = new Uint8Array(16);
    for (let p = 0; p < 16; p++) {
      primary[p] = read(spec.ib - (anchors[subsetOf(p)] === p ? 1 : 0));
    }
    let secondary = null;
    if (spec.ib2) {
      secondary = new Uint8Array(16);
      // A mode with a second index set has one subset, so pixel zero is the
      // only anchor there is.
      for (let p = 0; p < 16; p++) secondary[p] = read(spec.ib2 - (p === 0 ? 1 : 0));
    }

    const colourWeights = WEIGHTS[spec.ib2 && swapped ? spec.ib2 : spec.ib];
    const alphaWeights = WEIGHTS[spec.ib2 ? (swapped ? spec.ib : spec.ib2) : spec.ib];

    for (let p = 0; p < 16; p++) {
      const first = subsetOf(p) * 2;
      const second = first + 1;
      const ci = spec.ib2 && swapped ? secondary[p] : primary[p];
      const ai = spec.ib2 ? (swapped ? primary[p] : secondary[p]) : primary[p];
      const cw = colourWeights[ci];
      const aw = alphaWeights[ai];
      let r = between(red[first], red[second], cw);
      let g = between(green[first], green[second], cw);
      let b = between(blue[first], blue[second], cw);
      let a = spec.ab ? between(alpha[first], alpha[second], aw) : 255;
      /* A rotation says one of the colour channels is really the alpha, which
       * is how a mode with one endpoint pair spends its bits on whichever
       * channel needs them most. */
      if (rotation === 1) { const swap = a; a = r; r = swap; } else if (rotation === 2) {
        const swap = a; a = g; g = swap;
      } else if (rotation === 3) { const swap = a; a = b; b = swap; }
      put(p & 3, p >> 2, r, g, b, a);
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
        } else if (fourCC === BC7) {
          bc7Block(view, block, rgba, width, height, x0, y0);
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
    /* What each channel's value comes out as, worked out once for the whole
     * surface rather than per pixel. A mask is fixed for the picture, so the
     * answer for a five-bit channel is one of thirty-two numbers and for an
     * eight-bit one it is the number itself — against a multiply, a divide and
     * a rounding four times over for every pixel of it. */
    const table = (spec) => {
      if (!spec) return null;
      const out = new Uint8Array(spec.max + 1);
      for (let value = 0; value <= spec.max; value++) {
        out[value] = spec.max ? Math.round((value * 255) / spec.max) : 0;
      }
      return out;
    };
    const redTable = table(red);
    const greenTable = table(green);
    const blueTable = table(blue);
    const alphaTable = table(alpha);
    const count = width * height;
    for (let i = 0; i < count; i++) {
      const to = at + i * bytes;
      /* Whole pixels where the width is one the view can read, which is every
       * layout but the packed 24-bit ones: four `getUint8` calls a pixel is
       * sixteen million of them on a 2048-square surface, and they say the
       * same thing one little-endian read does. */
      let pixel = 0;
      if (bytes === 4) pixel = view.getUint32(to, true);
      else if (bytes === 2) pixel = view.getUint16(to, true);
      else if (bytes === 1) pixel = view.getUint8(to);
      else for (let k = 0; k < bytes; k++) pixel |= view.getUint8(to + k) << (8 * k);
      pixel >>>= 0;
      const r = red ? redTable[(pixel >>> red.shift) & red.max] : 0;
      const out = 4 * i;
      rgba[out] = r;
      rgba[out + 1] = grey ? r
        : (green ? greenTable[(pixel >>> green.shift) & green.max] : 0);
      rgba[out + 2] = grey ? r
        : (blue ? blueTable[(pixel >>> blue.shift) & blue.max] : 0);
      rgba[out + 3] = alpha ? alphaTable[(pixel >>> alpha.shift) & alpha.max] : 255;
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
    /* A DX10 header states its layout as a number instead of as masks and
     * flags, so a surface that arrives that way says `DDPF_FOURCC` and nothing
     * else — and the uncompressed ones have to be let past the flag test on
     * the strength of that number rather than of a bit nobody set. */
    let plain = false;
    if (fourCC === DX10) {
      if (bytes.length < 148) return null;
      const dxgi = DXGI[view.getUint32(128, true)];
      at = 148;
      if (dxgi === undefined) return null;
      if (dxgi === 'bgra8' || dxgi === 'bgrx8' || dxgi === 'rgba8') {
        const bgr = dxgi !== 'rgba8';
        fourCC = 0;
        plain = true;
        format.bits = 32;
        format.rMask = bgr ? 0x00ff0000 : 0x000000ff;
        format.gMask = 0x0000ff00;
        format.bMask = bgr ? 0x000000ff : 0x00ff0000;
        // No mask at all is what `decodePlain` reads as solid.
        format.aMask = dxgi === 'bgrx8' ? 0 : 0xff000000;
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
        && fourCC !== DXT5 && fourCC !== ATI1 && fourCC !== ATI2
        && fourCC !== BC7) return null;
      done = decodeBlocks(view, at, width, height, fourCC, rgba);
    } else if (plain) {
      done = decodePlain(view, at, width, height, format, rgba);
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
