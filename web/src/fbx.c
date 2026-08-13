/* fbxtool WASM core: DEFLATE, binary FBX record walking, and mesh building.
 *
 * Freestanding — no libc, no imports.  Built for wasm32 with clang, and also
 * compiled natively by the test harness so the same code can be checked
 * against Python's zlib and the Python reader.
 *
 * The parser writes a flat "tree image" into linear memory: an array of node
 * descriptors and an array of property descriptors, both fixed-size records.
 * Strings and scalar values are left in the uploaded file buffer and located
 * by offset, so JavaScript reads them straight out of the same ArrayBuffer
 * with a DataView — nothing is copied across the boundary twice.
 */

typedef unsigned char u8;
typedef unsigned short u16;
typedef unsigned int u32;
typedef signed int i32;
typedef unsigned long long u64;
typedef signed long long i64;
typedef double f64;
typedef float f32;

#define NULL ((void *)0)

#ifdef FBX_NATIVE
#include <stdlib.h>
static void *heap_base_ptr = NULL;
#else
extern u8 __heap_base;
#endif

/* ------------------------------------------------------------------ memory */

static u32 heap_ptr;
static u32 heap_start;

#ifndef FBX_NATIVE
static u32 memory_bytes(void) { return (u32)__builtin_wasm_memory_size(0) * 65536u; }

static int memory_ensure(u32 need_end) {
    u32 have = memory_bytes();
    if (need_end <= have) return 1;
    u32 pages = (need_end - have + 65535u) / 65536u;
    if ((int)__builtin_wasm_memory_grow(0, pages) < 0) return 0;
    return 1;
}
#endif

static void heap_reset(void) {
#ifdef FBX_NATIVE
    if (!heap_base_ptr) heap_base_ptr = malloc(1u << 30);
    heap_start = 64;
    heap_ptr = heap_start;
#else
    heap_start = ((u32)&__heap_base + 15u) & ~15u;
    heap_ptr = heap_start;
#endif
}

static void *heap_alloc(u32 n) {
    if (!heap_ptr) heap_reset();
    n = (n + 15u) & ~15u;
    u32 at = heap_ptr;
    if (at + n < at) return NULL; /* overflow */
#ifdef FBX_NATIVE
    heap_ptr = at + n;
    return (u8 *)heap_base_ptr + at;
#else
    if (!memory_ensure(at + n)) return NULL;
    heap_ptr = at + n;
    return (void *)at;
#endif
}

/* Offset <-> pointer, so the native build can use a malloc'd block. */
#ifdef FBX_NATIVE
static void *at_off(u32 off) { return (u8 *)heap_base_ptr + off; }
static u32 to_off(void *p) { return (u32)((u8 *)p - (u8 *)heap_base_ptr); }
#else
static void *at_off(u32 off) { return (void *)off; }
static u32 to_off(void *p) { return (u32)p; }
#endif

static void mem_zero(void *dst, u32 n) {
    u8 *d = (u8 *)dst;
    while (n--) *d++ = 0;
}

static void mem_copy(void *dst, const void *src, u32 n) {
    u8 *d = (u8 *)dst;
    const u8 *s = (const u8 *)src;
    while (n--) *d++ = *s++;
}

/* clang may lower struct assignments and loops to these. */
void *memset(void *dst, int c, unsigned long n) {
    u8 *d = (u8 *)dst;
    while (n--) *d++ = (u8)c;
    return dst;
}

void *memcpy(void *dst, const void *src, unsigned long n) {
    mem_copy(dst, src, (u32)n);
    return dst;
}

/* ----------------------------------------------------------------- inflate */

/* Single-level 15-bit lookup tables: 32768 entries of (length << 9 | symbol).
 * 64 KiB per table, which buys a branch-free decode for the common case. */
#define HUFF_BITS 15
#define HUFF_SIZE (1 << HUFF_BITS)

typedef struct {
    u16 table[HUFF_SIZE];
} Huff;

typedef struct {
    const u8 *src;
    const u8 *src_end;
    u32 bitbuf;
    int bitcnt;
    u8 *dst;
    u8 *dst_end;
    int error;
} Inflator;

static u32 bits_need(Inflator *s, int n) {
    while (s->bitcnt < n) {
        u32 byte = (s->src < s->src_end) ? *s->src++ : 0;
        if (s->src > s->src_end) s->error = 1;
        s->bitbuf |= byte << s->bitcnt;
        s->bitcnt += 8;
    }
    return s->bitbuf & ((1u << n) - 1u);
}

static void bits_drop(Inflator *s, int n) {
    s->bitbuf >>= n;
    s->bitcnt -= n;
}

static u32 bits_get(Inflator *s, int n) {
    if (n == 0) return 0;
    u32 v = bits_need(s, n);
    bits_drop(s, n);
    return v;
}

static u32 bit_reverse(u32 code, int len) {
    u32 out = 0;
    for (int i = 0; i < len; i++) {
        out = (out << 1) | (code & 1u);
        code >>= 1;
    }
    return out;
}

/* Build a canonical Huffman lookup table from code lengths. */
static int huff_build(Huff *h, const u8 *lengths, int count) {
    u16 bl_count[16];
    u16 next_code[16];
    for (int i = 0; i < 16; i++) bl_count[i] = 0;
    for (int i = 0; i < count; i++) bl_count[lengths[i]]++;
    bl_count[0] = 0;

    /* Reject over-subscribed tables; an incomplete one is legal only when it
     * holds at most a single code (zlib allows that for the distance tree). */
    u32 left = 1;
    for (int len = 1; len < 16; len++) {
        left <<= 1;
        if (bl_count[len] > left) return 0;
        left -= bl_count[len];
    }

    u32 code = 0;
    for (int len = 1; len < 16; len++) {
        code = (code + bl_count[len - 1]) << 1;
        next_code[len] = (u16)code;
    }

    for (int i = 0; i < HUFF_SIZE; i++) h->table[i] = 0;

    for (int sym = 0; sym < count; sym++) {
        int len = lengths[sym];
        if (!len) continue;
        u32 c = next_code[len]++;
        u32 rev = bit_reverse(c, len);
        u16 entry = (u16)((len << 9) | sym);
        u32 step = 1u << len;
        for (u32 slot = rev; slot < HUFF_SIZE; slot += step) h->table[slot] = entry;
    }
    return 1;
}

static int huff_decode(Inflator *s, const Huff *h) {
    u32 peek = bits_need(s, HUFF_BITS);
    u16 entry = h->table[peek];
    int len = entry >> 9;
    if (len == 0) {
        s->error = 1;
        return -1;
    }
    bits_drop(s, len);
    return entry & 0x1ff;
}

static const u16 LEN_BASE[29] = {3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27,
                                 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195,
                                 227, 258};
static const u8 LEN_EXTRA[29] = {0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2,
                                 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0};
static const u16 DIST_BASE[30] = {1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97,
                                  129, 193, 257, 385, 513, 769, 1025, 1537, 2049,
                                  3073, 4097, 6145, 8193, 12289, 16385, 24577};
static const u8 DIST_EXTRA[30] = {0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6,
                                  7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13};
static const u8 CLEN_ORDER[19] = {16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3,
                                  13, 2, 14, 1, 15};

static int inflate_block(Inflator *s, const Huff *lit, const Huff *dist) {
    for (;;) {
        if (s->error) return 0;
        int sym = huff_decode(s, lit);
        if (sym < 0) return 0;
        if (sym < 256) {
            if (s->dst >= s->dst_end) return 0;
            *s->dst++ = (u8)sym;
        } else if (sym == 256) {
            return 1;
        } else {
            sym -= 257;
            if (sym >= 29) return 0;
            u32 length = LEN_BASE[sym] + bits_get(s, LEN_EXTRA[sym]);
            int dsym = huff_decode(s, dist);
            if (dsym < 0 || dsym >= 30) return 0;
            u32 offset = DIST_BASE[dsym] + bits_get(s, DIST_EXTRA[dsym]);
            u8 *from = s->dst - offset;
            if (offset == 0) return 0;
            if ((u32)(s->dst_end - s->dst) < length) return 0;
            for (u32 i = 0; i < length; i++) *s->dst++ = *from++;
        }
    }
}

static Huff *huff_scratch_lit;
static Huff *huff_scratch_dist;

static int huff_scratch_ready(void) {
    if (!huff_scratch_lit) {
        huff_scratch_lit = (Huff *)heap_alloc(sizeof(Huff));
        huff_scratch_dist = (Huff *)heap_alloc(sizeof(Huff));
    }
    return huff_scratch_lit && huff_scratch_dist;
}

/* Decompress raw DEFLATE. Returns bytes written, or -1. */
static i32 inflate_raw(const u8 *src, u32 src_len, u8 *dst, u32 dst_cap) {
    if (!huff_scratch_ready()) return -1;
    Inflator s;
    s.src = src;
    s.src_end = src + src_len;
    s.bitbuf = 0;
    s.bitcnt = 0;
    s.dst = dst;
    s.dst_end = dst + dst_cap;
    s.error = 0;

    u8 lengths[320];
    int final = 0;
    while (!final) {
        final = (int)bits_get(&s, 1);
        u32 type = bits_get(&s, 2);
        if (s.error) return -1;

        if (type == 0) { /* stored */
            s.bitbuf = 0;
            s.bitcnt = 0;
            if (s.src + 4 > s.src_end) return -1;
            u32 len = (u32)s.src[0] | ((u32)s.src[1] << 8);
            u32 nlen = (u32)s.src[2] | ((u32)s.src[3] << 8);
            s.src += 4;
            if ((len ^ 0xffffu) != nlen) return -1;
            if (s.src + len > s.src_end) return -1;
            if ((u32)(s.dst_end - s.dst) < len) return -1;
            mem_copy(s.dst, s.src, len);
            s.dst += len;
            s.src += len;
        } else if (type == 1) { /* fixed Huffman */
            int i = 0;
            for (; i < 144; i++) lengths[i] = 8;
            for (; i < 256; i++) lengths[i] = 9;
            for (; i < 280; i++) lengths[i] = 7;
            for (; i < 288; i++) lengths[i] = 8;
            if (!huff_build(huff_scratch_lit, lengths, 288)) return -1;
            for (i = 0; i < 30; i++) lengths[i] = 5;
            if (!huff_build(huff_scratch_dist, lengths, 30)) return -1;
            if (!inflate_block(&s, huff_scratch_lit, huff_scratch_dist)) return -1;
        } else if (type == 2) { /* dynamic Huffman */
            u32 hlit = bits_get(&s, 5) + 257;
            u32 hdist = bits_get(&s, 5) + 1;
            u32 hclen = bits_get(&s, 4) + 4;
            if (hlit > 286 || hdist > 30) return -1;

            u8 clen[19];
            for (int i = 0; i < 19; i++) clen[i] = 0;
            for (u32 i = 0; i < hclen; i++) clen[CLEN_ORDER[i]] = (u8)bits_get(&s, 3);
            if (!huff_build(huff_scratch_lit, clen, 19)) return -1;

            u32 n = 0;
            while (n < hlit + hdist) {
                int sym = huff_decode(&s, huff_scratch_lit);
                if (sym < 0) return -1;
                if (sym < 16) {
                    lengths[n++] = (u8)sym;
                } else if (sym == 16) {
                    if (n == 0) return -1;
                    u8 prev = lengths[n - 1];
                    u32 repeat = 3 + bits_get(&s, 2);
                    while (repeat-- && n < hlit + hdist) lengths[n++] = prev;
                } else if (sym == 17) {
                    u32 repeat = 3 + bits_get(&s, 3);
                    while (repeat-- && n < hlit + hdist) lengths[n++] = 0;
                } else {
                    u32 repeat = 11 + bits_get(&s, 7);
                    while (repeat-- && n < hlit + hdist) lengths[n++] = 0;
                }
                if (s.error) return -1;
            }
            if (!huff_build(huff_scratch_lit, lengths, (int)hlit)) return -1;
            if (!huff_build(huff_scratch_dist, lengths + hlit, (int)hdist)) return -1;
            if (!inflate_block(&s, huff_scratch_lit, huff_scratch_dist)) return -1;
        } else {
            return -1;
        }
        if (s.error) return -1;
    }
    return (i32)(s.dst - dst);
}

/* Decompress a zlib stream (RFC 1950 header + DEFLATE). */
static i32 inflate_zlib(const u8 *src, u32 src_len, u8 *dst, u32 dst_cap) {
    if (src_len < 2) return -1;
    u32 cmf = src[0], flg = src[1];
    if ((cmf & 0x0f) != 8) return -1;
    if (((cmf << 8) | flg) % 31u != 0) return -1;
    if (flg & 0x20) return -1; /* preset dictionary unsupported */
    return inflate_raw(src + 2, src_len - 2, dst, dst_cap);
}

/* --------------------------------------------------------------- FBX parse */

#define NODE_STRIDE 32 /* bytes per node descriptor */
#define PROP_STRIDE 24 /* bytes per property descriptor */

typedef struct {
    u32 name_off;
    u32 name_len;
    u32 prop_start;
    u32 prop_count;
    u32 parent;      /* index of the containing record; 0 for top level */
    u32 src_offset;
    u32 depth;
    u32 reserved;
} NodeRec;

typedef struct {
    u32 code;      /* property type code, as its ASCII value */
    u32 array_len; /* element count for arrays, else 0 */
    u32 encoding;  /* 0 raw, 1 deflate */
    u32 byte_len;  /* payload bytes as stored in the file */
    u32 data_off;  /* file offset of the payload */
    u32 flags;     /* bit 0: is an array */
} PropRec;

/* Warning codes reported back to JS, which renders the text. */
#define W_PROP_LEN_MISMATCH 1
#define W_END_OFFSET_RANGE 2
#define W_END_OFFSET_MISMATCH 3
#define W_STRAY_BYTES 4
#define W_NO_FOOTER 5
#define W_FOOTER_VERSION 6
#define W_TRUNCATED_HEADER 7
#define W_BAD_PROP_CODE 8

#define MAX_WARNINGS 64
#define MAX_DEPTH 256

static const u8 *g_file;
static u32 g_file_len;
static u32 g_version;
static int g_wide;
static int g_has_footer;
static u32 g_footer_version;

static NodeRec *g_nodes;
static u32 g_node_count;
static u32 g_node_cap;
static PropRec *g_props;
static u32 g_prop_count;
static u32 g_prop_cap;

static u32 g_warnings[MAX_WARNINGS * 2];
static u32 g_warning_count;

static void warn(u32 code, u32 arg) {
    if (g_warning_count >= MAX_WARNINGS) return;
    g_warnings[g_warning_count * 2] = code;
    g_warnings[g_warning_count * 2 + 1] = arg;
    g_warning_count++;
}

static u32 rd_u32(u32 off) {
    const u8 *p = g_file + off;
    return (u32)p[0] | ((u32)p[1] << 8) | ((u32)p[2] << 16) | ((u32)p[3] << 24);
}

static u64 rd_u64(u32 off) {
    return (u64)rd_u32(off) | ((u64)rd_u32(off + 4) << 32);
}

static NodeRec *node_new(void) {
    if (g_node_count >= g_node_cap) {
        u32 cap = g_node_cap ? g_node_cap * 2 : 1024;
        NodeRec *grown = (NodeRec *)heap_alloc(cap * sizeof(NodeRec));
        if (!grown) return NULL;
        if (g_nodes) mem_copy(grown, g_nodes, g_node_count * sizeof(NodeRec));
        g_nodes = grown;
        g_node_cap = cap;
    }
    NodeRec *n = &g_nodes[g_node_count++];
    mem_zero(n, sizeof(NodeRec));
    return n;
}

static PropRec *prop_new(void) {
    if (g_prop_count >= g_prop_cap) {
        u32 cap = g_prop_cap ? g_prop_cap * 2 : 4096;
        PropRec *grown = (PropRec *)heap_alloc(cap * sizeof(PropRec));
        if (!grown) return NULL;
        if (g_props) mem_copy(grown, g_props, g_prop_count * sizeof(PropRec));
        g_props = grown;
        g_prop_cap = cap;
    }
    PropRec *p = &g_props[g_prop_count++];
    mem_zero(p, sizeof(PropRec));
    return p;
}

static u32 scalar_size(u32 code) {
    switch (code) {
        case 'C': return 1;
        case 'Y': return 2;
        case 'I': case 'F': return 4;
        case 'D': case 'L': return 8;
        default: return 0;
    }
}

static int is_array_code(u32 code) {
    return code == 'f' || code == 'd' || code == 'l' || code == 'i' || code == 'b';
}

/* Read one property, advancing *pos. Returns 0 on an unreadable stream. */
static int read_property(u32 *pos) {
    if (*pos >= g_file_len) return 0;
    u32 code = g_file[(*pos)++];
    PropRec *p = prop_new();
    if (!p) return 0;
    p->code = code;

    u32 size = scalar_size(code);
    if (size) {
        if (*pos + size > g_file_len) return 0;
        p->data_off = *pos;
        p->byte_len = size;
        *pos += size;
        return 1;
    }
    if (code == 'S' || code == 'R') {
        if (*pos + 4 > g_file_len) return 0;
        u32 len = rd_u32(*pos);
        *pos += 4;
        if (*pos + len > g_file_len) return 0;
        p->data_off = *pos;
        p->byte_len = len;
        *pos += len;
        return 1;
    }
    if (is_array_code(code)) {
        if (*pos + 12 > g_file_len) return 0;
        p->array_len = rd_u32(*pos);
        p->encoding = rd_u32(*pos + 4);
        p->byte_len = rd_u32(*pos + 8);
        *pos += 12;
        if (*pos + p->byte_len > g_file_len) return 0;
        p->data_off = *pos;
        p->flags = 1;
        *pos += p->byte_len;
        return 1;
    }
    warn(W_BAD_PROP_CODE, code);
    return 0;
}

/* Read a record and its subtree. Returns 1 for a record, 0 for the null
 * terminator, -1 on an unrecoverable stream error. */
static int read_node(u32 *pos, u32 parent_index, u32 depth) {
    u32 header = g_wide ? 24u : 12u;
    if (*pos + header + 1 > g_file_len) return -1;
    u32 start = *pos;

    u64 end_offset, num_props, prop_len;
    if (g_wide) {
        end_offset = rd_u64(*pos);
        num_props = rd_u64(*pos + 8);
        prop_len = rd_u64(*pos + 16);
    } else {
        end_offset = rd_u32(*pos);
        num_props = rd_u32(*pos + 4);
        prop_len = rd_u32(*pos + 8);
    }
    u32 p = *pos + header;
    u32 name_len = g_file[p++];

    if (end_offset == 0 && num_props == 0 && prop_len == 0 && name_len == 0) {
        *pos = p;
        return 0;
    }
    if (p + name_len > g_file_len) return -1;
    if (depth > MAX_DEPTH) return -1;

    u32 self = g_node_count;
    NodeRec *node = node_new();
    if (!node) return -1;
    node->name_off = p;
    node->name_len = name_len;
    node->src_offset = start;
    node->depth = depth;
    node->parent = parent_index;
    node->prop_start = g_prop_count;
    p += name_len;

    u32 prop_begin = p;
    for (u64 i = 0; i < num_props; i++) {
        if (!read_property(&p)) return -1;
    }
    g_nodes[self].prop_count = g_prop_count - g_nodes[self].prop_start;

    u32 consumed = p - prop_begin;
    if (consumed != (u32)prop_len) {
        warn(W_PROP_LEN_MISMATCH, start);
        p = prop_begin + (u32)prop_len; /* the header is authoritative */
    }

    if (!(end_offset > start && end_offset <= g_file_len)) {
        warn(W_END_OFFSET_RANGE, start);
        *pos = (p > start) ? p : start + 1;
        return 1;
    }

    while (p < (u32)end_offset) {
        if ((u32)end_offset - p < header + 1) {
            warn(W_STRAY_BYTES, start);
            break;
        }
        int r = read_node(&p, self, depth + 1);
        if (r < 0) return -1;
        if (r == 0) break;
    }

    if (p != (u32)end_offset) warn(W_END_OFFSET_MISMATCH, start);
    *pos = (u32)end_offset;
    return 1;
}

static const u8 FOOTER_PREFIX[13] = {0xF8, 0x5A, 0x8C, 0x6A, 0xDE, 0xF5, 0xD9,
                                     0x7E, 0xEC, 0xE9, 0x0C, 0xE3, 0x75};

static void read_footer(u32 pos) {
    u32 window = 256;
    u32 start = (g_file_len > window) ? g_file_len - window : 0;
    if (pos > 8 && pos - 8 < start) start = pos - 8;

    i32 found = -1;
    for (i32 i = (i32)g_file_len - 13; i >= (i32)start; i--) {
        int match = 1;
        for (int k = 0; k < 13; k++) {
            if (g_file[i + k] != FOOTER_PREFIX[k]) {
                match = 0;
                break;
            }
        }
        if (match) {
            found = i;
            break;
        }
    }
    if (found < 0) {
        warn(W_NO_FOOTER, 0);
        return;
    }
    g_has_footer = 1;
    if (found >= 124) {
        g_footer_version = rd_u32((u32)found - 124);
        if (g_footer_version != g_version) warn(W_FOOTER_VERSION, g_footer_version);
    }
}

/* Returns 1 on success, 0 when the data is not a binary FBX file. */
__attribute__((export_name("fbx_parse"))) int fbx_parse(u32 file_off, u32 len) {
    /* The file buffer already lives in the heap, so the heap is left alone;
     * call fbx_reset() before uploading a new file. */
    g_nodes = NULL;
    g_props = NULL;
    g_node_count = g_node_cap = 0;
    g_prop_count = g_prop_cap = 0;
    g_warning_count = 0;
    g_has_footer = 0;
    g_footer_version = 0;
    g_version = 0;

    g_file = (const u8 *)at_off(file_off);
    g_file_len = len;
    if (len < 27) return 0;

    static const char magic[21] = "Kaydara FBX Binary  ";
    for (int i = 0; i < 20; i++) {
        if (g_file[i] != (u8)magic[i]) return 0;
    }
    if (g_file[20] != 0) return 0;

    g_version = rd_u32(23);
    g_wide = g_version >= 7500;

    /* A synthetic root at index 0 so the tree has a single entry point. */
    NodeRec *root = node_new();
    if (!root) return 0;
    root->parent = 0xffffffffu;

    u32 pos = 27;
    while (pos < len) {
        u32 header = g_wide ? 24u : 12u;
        if (len - pos < header + 1) {
            warn(W_TRUNCATED_HEADER, pos);
            break;
        }
        int r = read_node(&pos, 0, 1);
        if (r <= 0) break;
    }
    read_footer(pos);
    return 1;
}

__attribute__((export_name("fbx_alloc"))) u32 fbx_alloc(u32 n) {
    if (!heap_ptr) heap_reset();
    void *p = heap_alloc(n);
    return p ? to_off(p) : 0;
}

__attribute__((export_name("fbx_reset"))) void fbx_reset(void) {
    heap_reset();
    huff_scratch_lit = NULL;
    huff_scratch_dist = NULL;
}

__attribute__((export_name("fbx_version"))) u32 fbx_version(void) { return g_version; }
__attribute__((export_name("fbx_wide"))) int fbx_wide(void) { return g_wide; }
__attribute__((export_name("fbx_has_footer"))) int fbx_has_footer(void) { return g_has_footer; }
__attribute__((export_name("fbx_footer_version"))) u32 fbx_footer_version(void) { return g_footer_version; }
__attribute__((export_name("fbx_node_count"))) u32 fbx_node_count(void) { return g_node_count; }
__attribute__((export_name("fbx_prop_count"))) u32 fbx_prop_count(void) { return g_prop_count; }
__attribute__((export_name("fbx_nodes_ptr"))) u32 fbx_nodes_ptr(void) { return to_off(g_nodes); }
__attribute__((export_name("fbx_props_ptr"))) u32 fbx_props_ptr(void) { return to_off(g_props); }
__attribute__((export_name("fbx_warning_count"))) u32 fbx_warning_count(void) { return g_warning_count; }
__attribute__((export_name("fbx_warnings_ptr"))) u32 fbx_warnings_ptr(void) { return to_off(g_warnings); }
__attribute__((export_name("fbx_node_stride"))) u32 fbx_node_stride(void) { return NODE_STRIDE; }
__attribute__((export_name("fbx_prop_stride"))) u32 fbx_prop_stride(void) { return PROP_STRIDE; }

/* Inflate an array payload into a fresh heap block; returns its offset, or 0. */
__attribute__((export_name("fbx_inflate"))) u32 fbx_inflate(u32 src_off, u32 src_len,
                                                            u32 out_len) {
    u8 *dst = (u8 *)heap_alloc(out_len ? out_len : 1);
    if (!dst) return 0;
    i32 n = inflate_zlib((const u8 *)at_off(src_off), src_len, dst, out_len);
    if (n < 0) return 0;
    return to_off(dst);
}

/* --------------------------------------------------------------- mesh build
 *
 * FBX stores polygons as a flat index run in which the last index of each
 * polygon is stored as its bitwise complement.  Polygons are fanned into
 * triangles; normals and UVs come from the file when it supplies them, through
 * an index array when the layer says IndexToDirect, and normals fall back to
 * the face normal otherwise.
 */

/* Attribute mapping and reference modes, matching the FBX layer element
 * declarations. IndexToDirect adds a level of indirection through an index
 * array, which is what most exporters use for UVs. */
#define MAP_NONE 0
#define MAP_BY_POLYGON_VERTEX 1
#define MAP_BY_VERTEX 2

#define REF_DIRECT 0
#define REF_INDEX_TO_DIRECT 1

/* Parameter block filled by JavaScript; there are too many inputs to pass as
 * arguments, and this keeps the two sides' layouts in one place. */
typedef struct {
    u32 pos_off, pos_count;         /* f64 triples */
    u32 idx_off, idx_count;         /* i32 polygon vertex indices */
    u32 nrm_off, nrm_count;         /* f64 triples */
    u32 nrm_index_off, nrm_index_count;
    u32 nrm_mapping, nrm_reference;
    u32 uv_off, uv_count;           /* f64 pairs */
    u32 uv_index_off, uv_index_count;
    u32 uv_mapping, uv_reference;
    u32 mat_off, mat_count;         /* i32, one per polygon or one overall */
} MeshParams;

typedef struct {
    u32 triangle_count;
    u32 positions_off;
    u32 normals_off;
    u32 material_off;
    f32 min[3];
    f32 max[3];
    u32 polygon_count;
    u32 degenerate_count;
    u32 uv_off;
    u32 has_uv;
} MeshOut;

static MeshOut *g_mesh;

static void normalize3(f32 *v) {
    f32 x = v[0], y = v[1], z = v[2];
    f32 len2 = x * x + y * y + z * z;
    if (len2 <= 0.0f) {
        v[0] = 0.0f;
        v[1] = 1.0f;
        v[2] = 0.0f;
        return;
    }
    f32 inv = 1.0f / __builtin_sqrtf(len2);
    v[0] = x * inv;
    v[1] = y * inv;
    v[2] = z * inv;
}

/* Resolve which element of an attribute array a polygon vertex refers to.
 * Returns 0xffffffff when the file does not supply one. */
static u32 attribute_slot(u32 mapping, u32 reference, const i32 *index,
                          u32 index_count, u32 corner, u32 control_point) {
    if (mapping == MAP_NONE) return 0xffffffffu;
    u32 raw = (mapping == MAP_BY_POLYGON_VERTEX) ? corner : control_point;
    if (reference == REF_INDEX_TO_DIRECT) {
        if (!index || raw >= index_count) return 0xffffffffu;
        i32 value = index[raw];
        if (value < 0) return 0xffffffffu;
        return (u32)value;
    }
    return raw;
}

__attribute__((export_name("fbx_build_mesh"))) u32 fbx_build_mesh(u32 params_off) {
    const MeshParams *p = (const MeshParams *)at_off(params_off);
    const f64 *positions = (const f64 *)at_off(p->pos_off);
    const i32 *indices = (const i32 *)at_off(p->idx_off);
    const f64 *normals = p->nrm_off ? (const f64 *)at_off(p->nrm_off) : NULL;
    const i32 *normal_index = p->nrm_index_off ? (const i32 *)at_off(p->nrm_index_off) : NULL;
    const f64 *uvs = p->uv_off ? (const f64 *)at_off(p->uv_off) : NULL;
    const i32 *uv_index = p->uv_index_off ? (const i32 *)at_off(p->uv_index_off) : NULL;
    const i32 *materials = p->mat_off ? (const i32 *)at_off(p->mat_off) : NULL;

    u32 idx_count = p->idx_count;
    u32 vertex_count = p->pos_count / 3;

    /* Pass one: how many triangles will the polygons fan into? */
    u32 triangles = 0, polygons = 0, run = 0;
    for (u32 i = 0; i < idx_count; i++) {
        run++;
        if (indices[i] < 0) {
            if (run >= 3) triangles += run - 2;
            polygons++;
            run = 0;
        }
    }
    if (run >= 3) {           /* a trailing polygon with no terminator */
        triangles += run - 2;
        polygons++;
    }

    MeshOut *out = (MeshOut *)heap_alloc(sizeof(MeshOut));
    if (!out) return 0;
    mem_zero(out, sizeof(MeshOut));
    g_mesh = out;
    out->polygon_count = polygons;
    if (!triangles) return to_off(out);

    f32 *pos_out = (f32 *)heap_alloc(triangles * 9 * sizeof(f32));
    f32 *nrm_out = (f32 *)heap_alloc(triangles * 9 * sizeof(f32));
    f32 *mat_out = (f32 *)heap_alloc(triangles * 3 * sizeof(f32));
    f32 *uv_out = (f32 *)heap_alloc(triangles * 6 * sizeof(f32));
    if (!pos_out || !nrm_out || !mat_out || !uv_out) return 0;
    out->positions_off = to_off(pos_out);
    out->normals_off = to_off(nrm_out);
    out->material_off = to_off(mat_out);
    out->uv_off = to_off(uv_out);
    out->has_uv = uvs ? 1u : 0u;

    f32 lo[3] = {3.4e38f, 3.4e38f, 3.4e38f};
    f32 hi[3] = {-3.4e38f, -3.4e38f, -3.4e38f};

    u32 write = 0, poly = 0, start = 0, degenerate = 0;

    for (u32 i = 0; i <= idx_count; i++) {
        int last = (i == idx_count) ? 1 : (indices[i] < 0);
        if (!last) continue;
        u32 end = (i == idx_count) ? idx_count : i + 1;
        u32 n = end - start;
        if (n < 3) {
            start = end;
            if (i < idx_count) poly++;
            continue;
        }

        f32 material = 0.0f;
        if (materials && p->mat_count) {
            u32 slot = (p->mat_count == 1) ? 0
                     : (poly < p->mat_count ? poly : p->mat_count - 1);
            material = (f32)materials[slot];
        }

        for (u32 t = 1; t + 1 < n; t++) {
            u32 corner[3] = {start, start + t, start + t + 1};
            f32 tri[3][3];
            u32 control[3];
            int ok = 1;
            for (int c = 0; c < 3; c++) {
                i32 raw = indices[corner[c]];
                u32 vi = (u32)(raw < 0 ? ~raw : raw);
                if (vi >= vertex_count) { ok = 0; break; }
                control[c] = vi;
                tri[c][0] = (f32)positions[vi * 3 + 0];
                tri[c][1] = (f32)positions[vi * 3 + 1];
                tri[c][2] = (f32)positions[vi * 3 + 2];
            }
            if (!ok) { degenerate++; continue; }

            f32 face[3];
            f32 ax = tri[1][0] - tri[0][0], ay = tri[1][1] - tri[0][1], az = tri[1][2] - tri[0][2];
            f32 bx = tri[2][0] - tri[0][0], by = tri[2][1] - tri[0][1], bz = tri[2][2] - tri[0][2];
            face[0] = ay * bz - az * by;
            face[1] = az * bx - ax * bz;
            face[2] = ax * by - ay * bx;
            normalize3(face);

            for (int c = 0; c < 3; c++) {
                u32 base = write * 9 + c * 3;
                for (int k = 0; k < 3; k++) {
                    f32 v = tri[c][k];
                    pos_out[base + k] = v;
                    if (v < lo[k]) lo[k] = v;
                    if (v > hi[k]) hi[k] = v;
                }

                f32 nv[3] = {face[0], face[1], face[2]};
                if (normals) {
                    u32 slot = attribute_slot(p->nrm_mapping, p->nrm_reference,
                                              normal_index, p->nrm_index_count,
                                              corner[c], control[c]);
                    if (slot != 0xffffffffu && slot * 3 + 2 < p->nrm_count) {
                        nv[0] = (f32)normals[slot * 3 + 0];
                        nv[1] = (f32)normals[slot * 3 + 1];
                        nv[2] = (f32)normals[slot * 3 + 2];
                    }
                }
                normalize3(nv);
                nrm_out[base + 0] = nv[0];
                nrm_out[base + 1] = nv[1];
                nrm_out[base + 2] = nv[2];

                f32 u = 0.0f, v = 0.0f;
                if (uvs) {
                    u32 slot = attribute_slot(p->uv_mapping, p->uv_reference,
                                              uv_index, p->uv_index_count,
                                              corner[c], control[c]);
                    if (slot != 0xffffffffu && slot * 2 + 1 < p->uv_count) {
                        u = (f32)uvs[slot * 2 + 0];
                        v = (f32)uvs[slot * 2 + 1];
                    }
                }
                uv_out[(write * 3 + c) * 2 + 0] = u;
                uv_out[(write * 3 + c) * 2 + 1] = v;

                mat_out[write * 3 + c] = material;
            }
            write++;
        }
        start = end;
        if (i < idx_count) poly++;
    }

    out->triangle_count = write;
    out->degenerate_count = degenerate;
    for (int k = 0; k < 3; k++) {
        out->min[k] = (write ? lo[k] : 0.0f);
        out->max[k] = (write ? hi[k] : 0.0f);
    }
    return to_off(out);
}

#ifdef FBX_NATIVE
/* Test-harness entry points, compiled only for the native build. */
i32 test_inflate_zlib(const u8 *src, u32 src_len, u8 *dst, u32 cap) {
    if (!heap_ptr) heap_reset();
    huff_scratch_lit = NULL;
    huff_scratch_dist = NULL;
    return inflate_zlib(src, src_len, dst, cap);
}

i32 test_inflate_raw(const u8 *src, u32 src_len, u8 *dst, u32 cap) {
    if (!heap_ptr) heap_reset();
    huff_scratch_lit = NULL;
    huff_scratch_dist = NULL;
    return inflate_raw(src, src_len, dst, cap);
}

void *test_heap_base(void) {
    if (!heap_ptr) heap_reset();
    return heap_base_ptr;
}
#endif
