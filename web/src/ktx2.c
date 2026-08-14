/* KTX2 textures compressed with Basis Universal (ETC1S), decoded to pixels.
 *
 * glTF files that carry KHR_texture_basisu store their images as KTX2 with
 * Basis supercompression. A browser cannot decode one: it is not an image
 * format but a compressed texture, meant to be handed to the GPU in whatever
 * block format the GPU has. There is no image to hand it either — so this
 * unpacks one.
 *
 * ETC1S is a stripped-down ETC1: every 4x4 block is one base colour in 5:5:5,
 * one of eight intensity tables, and sixteen 2-bit selectors saying how far
 * each pixel moves along that intensity. Those two halves are stored as
 * codebooks shared by the whole file, and each block names an entry in each —
 * usually by predicting it from its neighbours and coding the difference.
 * Unpacking is therefore: read the two codebooks, read the Huffman tables,
 * then walk the blocks recovering endpoint and selector indices, and turn each
 * block into sixteen pixels.
 *
 * Written from Binomial's transcoder, whose bitstream this is.
 *
 * Included by fbx.c, sharing its allocator and build.
 */

/* ------------------------------------------------------------- bit reader */

/** Bits come out of the stream from the bottom of each byte upwards. */
typedef struct {
    const u8 *data;
    u32 size;
    u32 pos;
    u32 buf;
    u32 count;
    int failed;
} BBits;

static void bb_init(BBits *b, const u8 *data, u32 size) {
    b->data = data;
    b->size = size;
    b->pos = 0;
    b->buf = 0;
    b->count = 0;
    b->failed = 0;
}

static void bb_fill(BBits *b, u32 want) {
    while (b->count < want) {
        u32 c = 0;
        if (b->pos < b->size) c = b->data[b->pos++];
        else b->failed = 1;
        b->buf |= c << b->count;
        b->count += 8;
    }
}

static u32 bb_bits(BBits *b, u32 n) {
    if (n == 0) return 0;
    if (n > 25) {
        u32 low = bb_bits(b, 25);
        return low | (bb_bits(b, n - 25) << 25);
    }
    bb_fill(b, n);
    u32 value = b->buf & ((1u << n) - 1u);
    b->buf >>= n;
    b->count -= n;
    return value;
}

/** A variable-length integer: chunks of `chunk_bits`, each with a carry bit. */
static u32 bb_vlc(BBits *b, u32 chunk_bits) {
    u32 chunk_size = 1u << chunk_bits;
    u32 mask = chunk_size - 1u;
    u32 value = 0;
    u32 shift = 0;
    for (;;) {
        u32 s = bb_bits(b, chunk_bits + 1);
        value |= (s & mask) << shift;
        shift += chunk_bits;
        if ((s & chunk_size) == 0) break;
        if (shift >= 32) break;
    }
    return value;
}

/* --------------------------------------------------------------- huffman */

#define B_MAX_CODE_SIZE 16
#define B_MAX_SYMS_LOG2 14
#define B_MAX_SYMS (1u << B_MAX_SYMS_LOG2)
#define B_CODELENGTH_CODES 21
#define B_SMALL_ZERO_RUN_CODE 17
#define B_BIG_ZERO_RUN_CODE 18
#define B_SMALL_REPEAT_CODE 19
#define B_BIG_REPEAT_CODE 20

/** Canonical Huffman: counts per length, and the symbols in code order. */
typedef struct {
    u16 counts[B_MAX_CODE_SIZE + 1];
    u16 *symbols;
    u32 num_symbols;
} BHuff;

static int bh_build(BHuff *h, const u8 *code_sizes, u32 total_syms) {
    for (u32 i = 0; i <= B_MAX_CODE_SIZE; i++) h->counts[i] = 0;
    h->num_symbols = 0;
    h->symbols = (u16 *)heap_alloc((total_syms + 1) * 2u);
    if (!h->symbols) return 0;
    for (u32 i = 0; i < total_syms; i++) {
        if (code_sizes[i] > B_MAX_CODE_SIZE) return 0;
        h->counts[code_sizes[i]]++;
    }
    u32 at = 0;
    u16 offsets[B_MAX_CODE_SIZE + 2];
    offsets[0] = 0;
    offsets[1] = 0;
    for (u32 len = 1; len <= B_MAX_CODE_SIZE; len++) {
        offsets[len + 1] = (u16)(at + h->counts[len]);
        at += h->counts[len];
    }
    for (u32 i = 0; i < total_syms; i++) {
        u32 len = code_sizes[i];
        if (len) h->symbols[offsets[len]++] = (u16)i;
    }
    h->num_symbols = at;
    return 1;
}

/**
 * One symbol.
 *
 * The encoder assigns canonical codes and writes them out low bit first, so
 * the code is rebuilt a bit at a time and compared against the first code of
 * each length.
 */
static u32 bh_decode(BBits *b, const BHuff *h) {
    u32 code = 0, first = 0, index = 0;
    for (u32 len = 1; len <= B_MAX_CODE_SIZE; len++) {
        code |= bb_bits(b, 1);
        u32 count = h->counts[len];
        if (code - first < count) return h->symbols[index + (code - first)];
        index += count;
        first = (first + count) << 1;
        code <<= 1;
    }
    b->failed = 1;
    return 0;
}

/** The order the code-length alphabet's own lengths are written in. */
static const u8 B_SORTED_CODELENGTH_CODES[B_CODELENGTH_CODES] = {
    B_SMALL_ZERO_RUN_CODE, B_BIG_ZERO_RUN_CODE, B_SMALL_REPEAT_CODE, B_BIG_REPEAT_CODE,
    0, 8, 7, 9, 6, 0xA, 5, 0xB, 4, 0xC, 3, 0xD, 2, 0xE, 1, 0xF, 0x10,
};

/** A Huffman table, itself Huffman-coded with runs and repeats. */
static int bh_read_table(BBits *b, BHuff *out) {
    u32 total_used_syms = bb_bits(b, B_MAX_SYMS_LOG2);
    out->num_symbols = 0;
    for (u32 i = 0; i <= B_MAX_CODE_SIZE; i++) out->counts[i] = 0;
    if (!total_used_syms) return 1;
    if (total_used_syms > B_MAX_SYMS) return 0;

    u8 code_length_code_sizes[B_CODELENGTH_CODES];
    mem_zero(code_length_code_sizes, B_CODELENGTH_CODES);
    u32 num_codelength_codes = bb_bits(b, 5);
    if (num_codelength_codes < 1 || num_codelength_codes > B_CODELENGTH_CODES) return 0;
    for (u32 i = 0; i < num_codelength_codes; i++) {
        code_length_code_sizes[B_SORTED_CODELENGTH_CODES[i]] = (u8)bb_bits(b, 3);
    }

    BHuff lengths;
    if (!bh_build(&lengths, code_length_code_sizes, B_CODELENGTH_CODES)) return 0;

    u8 *code_sizes = (u8 *)heap_alloc(total_used_syms + 1);
    if (!code_sizes) return 0;
    mem_zero(code_sizes, total_used_syms + 1);

    u32 at = 0;
    while (at < total_used_syms) {
        u32 c = bh_decode(b, &lengths);
        if (b->failed) return 0;
        if (c <= 16) {
            code_sizes[at++] = (u8)c;
        } else if (c == B_SMALL_ZERO_RUN_CODE) {
            at += bb_bits(b, 3) + 3;
        } else if (c == B_BIG_ZERO_RUN_CODE) {
            at += bb_bits(b, 7) + 11;
        } else {
            if (!at) return 0;
            u32 run = (c == B_SMALL_REPEAT_CODE) ? bb_bits(b, 2) + 3 : bb_bits(b, 7) + 7;
            u8 prev = code_sizes[at - 1];
            if (!prev) return 0;
            while (run--) {
                if (at >= total_used_syms) return 0;
                code_sizes[at++] = prev;
            }
        }
    }
    if (at != total_used_syms) return 0;
    return bh_build(out, code_sizes, total_used_syms);
}

/* ------------------------------------------------------------------ etc1s */

#define B_ENDPOINT_PRED_TOTAL_SYMBOLS ((4 * 4 * 4 * 4) + 1)
#define B_ENDPOINT_PRED_REPEAT_LAST (B_ENDPOINT_PRED_TOTAL_SYMBOLS - 1)
#define B_ENDPOINT_PRED_MIN_REPEAT 3
#define B_ENDPOINT_PRED_COUNT_VLC_BITS 4
#define B_SELECTOR_RLE_COUNT_THRESH 3
#define B_SELECTOR_RLE_COUNT_BITS 6
#define B_SELECTOR_RLE_COUNT_TOTAL (1u << B_SELECTOR_RLE_COUNT_BITS)
#define B_COLOR5_PAL0_PREV_HI 9
#define B_COLOR5_PAL1_PREV_HI 21

typedef struct {
    u8 color5[3];
    u8 inten5;
} BEndpoint;

typedef struct {
    u8 rows[4];              /* four rows of four 2-bit selectors */
} BSelector;

/** ETC1's eight intensity tables: how far each selector moves the base colour. */
static const i32 B_INTEN[8][4] = {
    { -8, -2, 2, 8 }, { -17, -5, 5, 17 }, { -29, -9, 9, 29 }, { -42, -13, 13, 42 },
    { -60, -18, 18, 60 }, { -80, -24, 24, 80 }, { -106, -33, 33, 106 },
    { -183, -47, 47, 183 },
};

typedef struct {
    /* codebooks */
    u32 num_endpoints;
    BEndpoint *endpoints;
    u32 num_selectors;
    BSelector *selectors;
    /* models */
    BHuff endpoint_pred;
    BHuff delta_endpoint;
    BHuff selector;
    BHuff selector_history_rle;
    u32 selector_history_size;
    /* per-slice scratch */
    u16 *pred_bits[2];
    u16 *pred_endpoint[2];
    i32 *history;
    u32 history_rover;
} Basis;

static Basis g_basis;

static u8 b_clamp255(i32 v) { return (u8)(v < 0 ? 0 : (v > 255 ? 255 : v)); }

/** The four colours a block can use: its base colour, moved four ways. */
static void b_block_colors(const BEndpoint *e, u8 out[4][3]) {
    i32 base[3];
    for (int c = 0; c < 3; c++) {
        u32 v = e->color5[c];
        base[c] = (i32)((v << 3) | (v >> 2));       /* 5 bits to 8 */
    }
    const i32 *inten = B_INTEN[e->inten5 & 7];
    for (int i = 0; i < 4; i++) {
        for (int c = 0; c < 3; c++) out[i][c] = b_clamp255(base[c] + inten[i]);
    }
}

/** The same for an alpha slice, which carries its value in the green channel. */
static void b_block_alphas(const BEndpoint *e, u8 out[4]) {
    u32 v = e->color5[1];
    i32 g = (i32)((v << 3) | (v >> 2));
    const i32 *inten = B_INTEN[e->inten5 & 7];
    for (int i = 0; i < 4; i++) out[i] = b_clamp255(g + inten[i]);
}

/** The endpoint and selector codebooks, shared by every image in the file. */
static int b_decode_palettes(Basis *b, const u8 *endpoint_data, u32 endpoint_size,
                             const u8 *selector_data, u32 selector_size) {
    BBits bits;
    bb_init(&bits, endpoint_data, endpoint_size);

    BHuff color_delta0, color_delta1, color_delta2, inten_delta;
    if (!bh_read_table(&bits, &color_delta0)) return 0;
    if (!bh_read_table(&bits, &color_delta1)) return 0;
    if (!bh_read_table(&bits, &color_delta2)) return 0;
    if (!bh_read_table(&bits, &inten_delta)) return 0;

    int grayscale = bb_bits(&bits, 1) != 0;
    b->endpoints = (BEndpoint *)heap_alloc((b->num_endpoints + 1) * (u32)sizeof(BEndpoint));
    if (!b->endpoints) return 0;

    u8 prev_color5[3] = { 16, 16, 16 };
    u32 prev_inten = 0;
    for (u32 i = 0; i < b->num_endpoints; i++) {
        u32 delta = bh_decode(&bits, &inten_delta);
        b->endpoints[i].inten5 = (u8)((delta + prev_inten) & 7);
        prev_inten = b->endpoints[i].inten5;
        for (u32 c = 0; c < (grayscale ? 1u : 3u); c++) {
            const BHuff *model = prev_color5[c] <= B_COLOR5_PAL0_PREV_HI ? &color_delta0
                : (prev_color5[c] <= B_COLOR5_PAL1_PREV_HI ? &color_delta1 : &color_delta2);
            u32 d = bh_decode(&bits, model);
            u8 v = (u8)((prev_color5[c] + d) & 31);
            b->endpoints[i].color5[c] = v;
            prev_color5[c] = v;
        }
        if (grayscale) {
            b->endpoints[i].color5[1] = b->endpoints[i].color5[0];
            b->endpoints[i].color5[2] = b->endpoints[i].color5[0];
        }
        if (bits.failed) return 0;
    }

    bb_init(&bits, selector_data, selector_size);
    b->selectors = (BSelector *)heap_alloc((b->num_selectors + 1) * (u32)sizeof(BSelector));
    if (!b->selectors) return 0;

    if (bb_bits(&bits, 1)) return 0;            /* a global codebook, which this does not carry */
    if (bb_bits(&bits, 1)) return 0;            /* nor a hybrid one */
    int raw = bb_bits(&bits, 1) != 0;

    if (raw) {
        for (u32 i = 0; i < b->num_selectors; i++) {
            for (u32 j = 0; j < 4; j++) b->selectors[i].rows[j] = (u8)bb_bits(&bits, 8);
        }
    } else {
        BHuff delta_selector;
        if (!bh_read_table(&bits, &delta_selector)) return 0;
        u8 prev[4] = { 0, 0, 0, 0 };
        for (u32 i = 0; i < b->num_selectors; i++) {
            for (u32 j = 0; j < 4; j++) {
                u8 byte;
                if (!i) byte = (u8)bb_bits(&bits, 8);
                else byte = (u8)(bh_decode(&bits, &delta_selector) ^ prev[j]);
                prev[j] = byte;
                b->selectors[i].rows[j] = byte;
            }
            if (bits.failed) return 0;
        }
    }
    return !bits.failed;
}

/** The models the per-block indices are coded with. */
static int b_decode_tables(Basis *b, const u8 *data, u32 size) {
    BBits bits;
    bb_init(&bits, data, size);
    if (!bh_read_table(&bits, &b->endpoint_pred)) return 0;
    if (!bh_read_table(&bits, &b->delta_endpoint)) return 0;
    if (!bh_read_table(&bits, &b->selector)) return 0;
    if (!bh_read_table(&bits, &b->selector_history_rle)) return 0;
    b->selector_history_size = bb_bits(&bits, 13);
    if (!b->selector_history_size) return 0;
    return !bits.failed;
}

/* The history buffer is a move-to-front approximation: an entry that is used
 * moves halfway to the front, and new entries land at a rover. */
static void b_history_add(Basis *b, i32 value) {
    b->history[b->history_rover++] = value;
    if (b->history_rover == b->selector_history_size) {
        b->history_rover = b->selector_history_size / 2;
    }
}

static void b_history_use(Basis *b, u32 index) {
    if (index) {
        i32 x = b->history[index / 2];
        b->history[index / 2] = b->history[index];
        b->history[index] = x;
    }
}

/**
 * One slice: the blocks of one image, written into `dst` as RGBA.
 *
 * `alpha_only` writes the alpha channel instead of the colour, which is how a
 * file with transparency stores it — as a second greyscale slice.
 */
static int b_transcode_slice(Basis *b, const u8 *data, u32 size,
                             u32 blocks_x, u32 blocks_y, u32 width, u32 height,
                             u8 *dst, int alpha_only) {
    BBits bits;
    bb_init(&bits, data, size);

    for (u32 i = 0; i < b->selector_history_size; i++) b->history[i] = 0;
    b->history_rover = b->selector_history_size / 2;
    for (int i = 0; i < 2; i++) {
        for (u32 x = 0; x < blocks_x; x++) {
            b->pred_bits[i][x] = 0;
            b->pred_endpoint[i][x] = 0;
        }
    }

    u32 total_blocks = blocks_x * blocks_y;
    u32 selector_rle_count = 0;
    u32 cur_pred_bits = 0;
    u32 prev_endpoint_pred_sym = 0;
    u32 endpoint_pred_repeat = 0;
    u32 prev_endpoint_index = 0;
    const u32 history_first_symbol = b->num_selectors;
    const u32 history_rle_symbol = b->selector_history_size + history_first_symbol;

    for (u32 block_y = 0; block_y < blocks_y; block_y++) {
        u32 cur_array = block_y & 1;
        for (u32 block_x = 0; block_x < blocks_x; block_x++) {
            /* One symbol carries the prediction for a 2x2 group of blocks:
             * two bits per block, the upper half kept for the row below. */
            if ((block_x & 1) == 0) {
                if ((block_y & 1) == 0) {
                    if (endpoint_pred_repeat) {
                        endpoint_pred_repeat--;
                        cur_pred_bits = prev_endpoint_pred_sym;
                    } else {
                        cur_pred_bits = bh_decode(&bits, &b->endpoint_pred);
                        if (cur_pred_bits == B_ENDPOINT_PRED_REPEAT_LAST) {
                            endpoint_pred_repeat = bb_vlc(&bits, B_ENDPOINT_PRED_COUNT_VLC_BITS)
                                + B_ENDPOINT_PRED_MIN_REPEAT - 1;
                            cur_pred_bits = prev_endpoint_pred_sym;
                        } else {
                            prev_endpoint_pred_sym = cur_pred_bits;
                        }
                    }
                    b->pred_bits[cur_array ^ 1][block_x] = (u16)(cur_pred_bits >> 4);
                } else {
                    cur_pred_bits = b->pred_bits[cur_array][block_x];
                }
            }

            u32 pred = cur_pred_bits & 3;
            cur_pred_bits >>= 2;

            u32 endpoint_index;
            if (pred == 0) {                       /* the block to the left */
                if (!block_x) return 0;
                endpoint_index = prev_endpoint_index;
            } else if (pred == 1) {                /* the block above */
                if (!block_y) return 0;
                endpoint_index = b->pred_endpoint[cur_array ^ 1][block_x];
            } else if (pred == 2) {                /* above and to the left */
                if (!block_x || !block_y) return 0;
                endpoint_index = b->pred_endpoint[cur_array ^ 1][block_x - 1];
            } else {                               /* a coded difference */
                u32 delta = bh_decode(&bits, &b->delta_endpoint);
                endpoint_index = delta + prev_endpoint_index;
                if (endpoint_index >= b->num_endpoints) endpoint_index -= b->num_endpoints;
            }
            b->pred_endpoint[cur_array][block_x] = (u16)endpoint_index;
            prev_endpoint_index = endpoint_index;

            u32 selector_index = 0;
            {
                u32 selector_sym;
                if (selector_rle_count > 0) {
                    selector_rle_count--;
                    selector_sym = b->num_selectors;
                } else {
                    selector_sym = bh_decode(&bits, &b->selector);
                    if (selector_sym == history_rle_symbol) {
                        u32 run = bh_decode(&bits, &b->selector_history_rle);
                        if (run == B_SELECTOR_RLE_COUNT_TOTAL - 1) {
                            selector_rle_count = bb_vlc(&bits, 7) + B_SELECTOR_RLE_COUNT_THRESH;
                        } else {
                            selector_rle_count = run + B_SELECTOR_RLE_COUNT_THRESH;
                        }
                        if (selector_rle_count > total_blocks) return 0;
                        selector_sym = b->num_selectors;
                        selector_rle_count--;
                    }
                }
                if (selector_sym >= b->num_selectors) {
                    u32 history_index = selector_sym - b->num_selectors;
                    if (history_index >= b->selector_history_size) return 0;
                    selector_index = (u32)b->history[history_index];
                    if (history_index) b_history_use(b, history_index);
                } else {
                    selector_index = selector_sym;
                    if (b->selector_history_size) b_history_add(b, (i32)selector_index);
                }
            }

            if (endpoint_index >= b->num_endpoints || selector_index >= b->num_selectors) return 0;
            if (bits.failed) return 0;

            const BEndpoint *endpoint = &b->endpoints[endpoint_index];
            const BSelector *selector = &b->selectors[selector_index];
            u32 max_x = blocks_x * 4 > width ? 0 : 4;
            if (!max_x) max_x = width - block_x * 4 < 4 ? width - block_x * 4 : 4;
            u32 max_y = height - block_y * 4 < 4 ? height - block_y * 4 : 4;
            if (block_x * 4 >= width || block_y * 4 >= height) continue;

            if (alpha_only) {
                u8 alphas[4];
                b_block_alphas(endpoint, alphas);
                for (u32 y = 0; y < max_y; y++) {
                    u32 row = selector->rows[y];
                    u8 *out = dst + ((block_y * 4 + y) * width + block_x * 4) * 4;
                    for (u32 x = 0; x < max_x; x++) out[x * 4 + 3] = alphas[(row >> (x * 2)) & 3];
                }
            } else {
                u8 colors[4][3];
                b_block_colors(endpoint, colors);
                for (u32 y = 0; y < max_y; y++) {
                    u32 row = selector->rows[y];
                    u8 *out = dst + ((block_y * 4 + y) * width + block_x * 4) * 4;
                    for (u32 x = 0; x < max_x; x++) {
                        const u8 *c = colors[(row >> (x * 2)) & 3];
                        out[x * 4 + 0] = c[0];
                        out[x * 4 + 1] = c[1];
                        out[x * 4 + 2] = c[2];
                        out[x * 4 + 3] = 255;
                    }
                }
            }
        }
    }
    return 1;
}

/* -------------------------------------------------------------- container */

#define K_ERR_NONE 0
#define K_ERR_MAGIC 1
#define K_ERR_TRUNCATED 2
#define K_ERR_NOT_ETC1S 3
#define K_ERR_SUPERCOMPRESSION 4
#define K_ERR_MEMORY 5
#define K_ERR_CORRUPT 6
#define K_ERR_LIMIT 7

typedef struct {
    u32 ok;
    u32 error;
    u32 width;
    u32 height;
    u32 has_alpha;
    u32 levels;
    u32 rgba;            /* offset of width * height * 4 bytes */
} Ktx2Out;

static const u8 KTX2_MAGIC[12] = {
    0xAB, 0x4B, 0x54, 0x58, 0x20, 0x32, 0x30, 0xBB, 0x0D, 0x0A, 0x1A, 0x0A
};

static u32 k_u32(const u8 *p) {
    return (u32)p[0] | ((u32)p[1] << 8) | ((u32)p[2] << 16) | ((u32)p[3] << 24);
}

static u64 k_u64(const u8 *p) { return (u64)k_u32(p) | ((u64)k_u32(p + 4) << 32); }

/**
 * Decode the full-size image of a KTX2 texture into RGBA.
 *
 * Only level 0 is unpacked: the viewer builds its own mipmaps, and the smaller
 * levels are the same picture again.
 */
FBX_EXPORT("fbx_ktx2_decode") u32 fbx_ktx2_decode(u32 src_off, u32 src_len) {
    Ktx2Out *out = (Ktx2Out *)heap_alloc((u32)sizeof(Ktx2Out));
    if (!out) return 0;
    mem_zero(out, (u32)sizeof(Ktx2Out));

    const u8 *src = (const u8 *)at_off(src_off);
    /* What it is comes before how complete it is: a caller handed the wrong
     * kind of file should be told that, not that its file is short. */
    for (u32 i = 0; i < 12; i++) {
        if (i >= src_len || src[i] != KTX2_MAGIC[i]) {
            out->error = K_ERR_MAGIC;
            return to_off(out);
        }
    }
    if (src_len < 80) { out->error = K_ERR_TRUNCATED; return to_off(out); }

    u32 vk_format = k_u32(src + 12);
    u32 width = k_u32(src + 20);
    u32 height = k_u32(src + 24);
    u32 layers = k_u32(src + 32);
    u32 faces = k_u32(src + 36);
    u32 levels = k_u32(src + 40);
    u32 scheme = k_u32(src + 44);
    u64 sgd_offset = k_u64(src + 64);
    u64 sgd_length = k_u64(src + 72);

    if (vk_format != 0) { out->error = K_ERR_NOT_ETC1S; return to_off(out); }
    if (scheme != 1) { out->error = K_ERR_SUPERCOMPRESSION; return to_off(out); }
    if (!width || !height) { out->error = K_ERR_CORRUPT; return to_off(out); }
    if (width > 16384 || height > 16384) { out->error = K_ERR_LIMIT; return to_off(out); }
    if (levels == 0) levels = 1;
    if (faces != 1 || layers > 1) { out->error = K_ERR_LIMIT; return to_off(out); }
    if (sgd_offset + sgd_length > src_len || sgd_length < 20) {
        out->error = K_ERR_TRUNCATED;
        return to_off(out);
    }

    /* The level index: level 0 is the full-size image. */
    if (80 + (u64)levels * 24 > src_len) { out->error = K_ERR_TRUNCATED; return to_off(out); }
    u64 level_offset = k_u64(src + 80);
    u64 level_length = k_u64(src + 88);
    if (level_offset + level_length > src_len) {
        out->error = K_ERR_TRUNCATED;
        return to_off(out);
    }

    /* Basis global data: the two codebooks, the models, and one descriptor
     * per image saying where its slices are inside the level. */
    const u8 *sgd = src + (u32)sgd_offset;
    Basis *b = &g_basis;
    mem_zero(b, (u32)sizeof(Basis));
    b->num_endpoints = (u32)sgd[0] | ((u32)sgd[1] << 8);
    b->num_selectors = (u32)sgd[2] | ((u32)sgd[3] << 8);
    u32 endpoints_length = k_u32(sgd + 4);
    u32 selectors_length = k_u32(sgd + 8);
    u32 tables_length = k_u32(sgd + 12);
    u32 extended_length = k_u32(sgd + 16);
    (void)extended_length;

    u32 descs_length = levels * 20u;
    u64 need = 20ull + descs_length + endpoints_length + selectors_length + tables_length;
    if (need > sgd_length) { out->error = K_ERR_TRUNCATED; return to_off(out); }
    if (!b->num_endpoints || !b->num_selectors) { out->error = K_ERR_CORRUPT; return to_off(out); }

    const u8 *descs = sgd + 20;
    const u8 *endpoint_data = descs + descs_length;
    const u8 *selector_data = endpoint_data + endpoints_length;
    const u8 *table_data = selector_data + selectors_length;

    if (!b_decode_palettes(b, endpoint_data, endpoints_length,
                           selector_data, selectors_length)) {
        out->error = K_ERR_CORRUPT;
        return to_off(out);
    }
    if (!b_decode_tables(b, table_data, tables_length)) {
        out->error = K_ERR_CORRUPT;
        return to_off(out);
    }

    /* The level-0 image descriptor. */
    u32 flags = k_u32(descs + 0);
    u32 rgb_offset = k_u32(descs + 4);
    u32 rgb_length = k_u32(descs + 8);
    u32 alpha_offset = k_u32(descs + 12);
    u32 alpha_length = k_u32(descs + 16);
    (void)flags;
    if ((u64)rgb_offset + rgb_length > level_length) {
        out->error = K_ERR_TRUNCATED;
        return to_off(out);
    }

    u32 blocks_x = (width + 3) / 4;
    u32 blocks_y = (height + 3) / 4;
    u32 pixels = width * height;
    u8 *rgba = (u8 *)heap_alloc(pixels * 4u);
    b->pred_bits[0] = (u16 *)heap_alloc((blocks_x + 1) * 2u);
    b->pred_bits[1] = (u16 *)heap_alloc((blocks_x + 1) * 2u);
    b->pred_endpoint[0] = (u16 *)heap_alloc((blocks_x + 1) * 2u);
    b->pred_endpoint[1] = (u16 *)heap_alloc((blocks_x + 1) * 2u);
    b->history = (i32 *)heap_alloc((b->selector_history_size + 1) * 4u);
    if (!rgba || !b->pred_bits[1] || !b->pred_endpoint[1] || !b->history) {
        out->error = K_ERR_MEMORY;
        return to_off(out);
    }
    for (u32 i = 0; i < pixels; i++) {
        rgba[i * 4 + 0] = 0;
        rgba[i * 4 + 1] = 0;
        rgba[i * 4 + 2] = 0;
        rgba[i * 4 + 3] = 255;
    }

    const u8 *level = src + (u32)level_offset;
    if (!b_transcode_slice(b, level + rgb_offset, rgb_length, blocks_x, blocks_y,
                           width, height, rgba, 0)) {
        out->error = K_ERR_CORRUPT;
        return to_off(out);
    }
    if (alpha_length) {
        if ((u64)alpha_offset + alpha_length > level_length) {
            out->error = K_ERR_TRUNCATED;
            return to_off(out);
        }
        if (!b_transcode_slice(b, level + alpha_offset, alpha_length, blocks_x, blocks_y,
                               width, height, rgba, 1)) {
            out->error = K_ERR_CORRUPT;
            return to_off(out);
        }
    }

    out->ok = 1;
    out->width = width;
    out->height = height;
    out->has_alpha = alpha_length ? 1u : 0u;
    out->levels = levels;
    out->rgba = to_off(rgba);
    return to_off(out);
}
