/* Draco mesh decompression.
 *
 * A glTF file compressed with KHR_draco_mesh_compression keeps its accessors —
 * counts, types, even min/max — but not its vertices: those live in a Draco
 * block, and without decompressing it the mesh is not in the file at all.
 * This decodes that block.
 *
 * Written from the Draco bitstream specification (docs/spec in google/draco),
 * whose pseudo-code the function names below follow deliberately, so each one
 * can be read against the section it implements. Where the specification and
 * the shipping decoder disagree, the decoder wins — files are written by the
 * encoder, not by the prose — and each of those places is commented.
 *
 * What a mesh is, in Draco's terms: faces are built from a stream of EdgeBreaker
 * symbols, each of which either adds a triangle to the growing boundary or
 * splits it; a corner table records which corners are opposite each other, and
 * the vertices are recovered from that. Attribute values are then decoded as
 * integers, predicted from neighbours already decoded (a parallelogram of three
 * known corners, most often), and dequantized back to floats.
 *
 * Included by fbx.c so both share one translation unit, one bump allocator and
 * one set of build rules.
 */

/* Tracing, for the native build only: the decoder is a long sequence of stages
 * and a bug in one of them is otherwise silent. */

/* ------------------------------------------------------------- constants */

#define D_MESH_SEQUENTIAL 0
#define D_MESH_EDGEBREAKER 1
#define D_METADATA_FLAG 32768u

#define D_SEQ_GENERIC 0
#define D_SEQ_INTEGER 1
#define D_SEQ_QUANTIZATION 2
#define D_SEQ_NORMALS 3

#define D_PRED_NONE (-2)
#define D_PRED_DIFFERENCE 0
#define D_PRED_PARALLELOGRAM 1
#define D_PRED_MULTI_PARALLELOGRAM 2
#define D_PRED_CONSTRAINED_MULTI 4
#define D_PRED_TEX_COORDS_PORTABLE 5
#define D_PRED_GEOMETRIC_NORMAL 6

#define D_TRANSFORM_WRAP 1
#define D_TRANSFORM_NORMAL_OCT_CANON 3

#define D_TRAVERSAL_DEPTH_FIRST 0
#define D_TRAVERSAL_PREDICTION_DEGREE 1
#define D_MESH_VERTEX_ATTRIBUTE 0

#define D_STANDARD_EDGEBREAKER 0
#define D_VALENCE_EDGEBREAKER 2

#define D_TOPOLOGY_C 0
#define D_TOPOLOGY_S 1
#define D_TOPOLOGY_L 3
#define D_TOPOLOGY_R 5
#define D_TOPOLOGY_E 7

#define D_MIN_VALENCE 2
#define D_MAX_VALENCE 7
#define D_NUM_UNIQUE_VALENCES 6

#define D_MAX_PARALLELOGRAMS 4
#define D_MAX_PRIORITY 3
#define D_RIGHT_FACE_EDGE 1

#define D_IO_BASE 256u
#define D_L_RANS_BASE 4096u
#define D_TAGGED_RANS_BASE 16384u
#define D_TAGGED_RANS_PRECISION 4096u
#define D_RABS_P8_PRECISION 256u
#define D_RABS_L_BASE 4096u

/* Passed where a decoder index is expected to mean the mesh's own table. */
#define D_MESH_TABLE (-1)

#define D_MAX_ATT_DEC 8
#define D_MAX_ATTRIBUTES 16

/* Error codes handed back to the caller, so a failure can say which stage. */
#define D_ERR_NONE 0
#define D_ERR_MAGIC 1
#define D_ERR_VERSION 2
#define D_ERR_NOT_A_MESH 3
#define D_ERR_METHOD 4
#define D_ERR_TRUNCATED 5
#define D_ERR_MEMORY 6
#define D_ERR_LIMIT 7
#define D_ERR_UNSUPPORTED 8
#define D_ERR_CORRUPT 9

/* ------------------------------------------------------------- byte buffer */

typedef struct {
    const u8 *data;
    u32 size;
    u32 pos;
    /* Bit reading runs alongside: it starts at the current byte, and when it
     * ends the byte position advances by the bytes those bits covered. */
    u32 bit_start;
    u32 bit_off;
    int bit_mode;
    int failed;
} DBuf;

static void db_init(DBuf *b, const u8 *data, u32 size) {
    b->data = data;
    b->size = size;
    b->pos = 0;
    b->bit_start = 0;
    b->bit_off = 0;
    b->bit_mode = 0;
    b->failed = 0;
}

static u32 db_left(const DBuf *b) { return b->pos < b->size ? b->size - b->pos : 0; }

static u8 db_u8(DBuf *b) {
    if (b->pos + 1 > b->size) { b->failed = 1; return 0; }
    return b->data[b->pos++];
}

static u16 db_u16(DBuf *b) {
    if (b->pos + 2 > b->size) { b->failed = 1; return 0; }
    u16 v = (u16)(b->data[b->pos] | ((u16)b->data[b->pos + 1] << 8));
    b->pos += 2;
    return v;
}

static u32 db_u32(DBuf *b) {
    if (b->pos + 4 > b->size) { b->failed = 1; return 0; }
    u32 v = (u32)b->data[b->pos] | ((u32)b->data[b->pos + 1] << 8)
          | ((u32)b->data[b->pos + 2] << 16) | ((u32)b->data[b->pos + 3] << 24);
    b->pos += 4;
    return v;
}

static i32 db_i32(DBuf *b) { return (i32)db_u32(b); }

static f32 db_f32(DBuf *b) {
    u32 bits = db_u32(b);
    f32 out;
    mem_copy(&out, &bits, 4);
    return out;
}

/** LEB128, as varUI32 and varUI64 are both written. */
static u64 db_varint(DBuf *b) {
    u64 result = 0;
    u32 shift = 0;
    for (;;) {
        u8 in = db_u8(b);
        if (b->failed) return 0;
        result |= (u64)(in & 0x7f) << shift;
        if (!(in & 0x80)) break;
        shift += 7;
        if (shift > 63) { b->failed = 1; return 0; }
    }
    return result;
}

static u32 db_varu32(DBuf *b) { return (u32)db_varint(b); }

static void db_bits_start(DBuf *b) {
    b->bit_mode = 1;
    b->bit_start = b->pos;
    b->bit_off = 0;
}

/** Bits come out of each byte from the bottom up, first bit read the lowest. */
static u32 db_bits(DBuf *b, u32 n) {
    u32 value = 0;
    for (u32 i = 0; i < n; i++) {
        u32 off = b->bit_off + i;
        u32 at = b->bit_start + (off >> 3);
        u32 bit = 0;
        if (at < b->size) bit = (b->data[at] >> (off & 7)) & 1u;
        value |= bit << i;
    }
    b->bit_off += n;
    return value;
}

static void db_bits_end(DBuf *b) {
    b->pos = b->bit_start + ((b->bit_off + 7) >> 3);
    if (b->pos > b->size) { b->pos = b->size; b->failed = 1; }
    b->bit_mode = 0;
}

/* -------------------------------------------------------------------- rANS */

typedef struct {
    const u8 *buf;
    i32 offset;
    u32 state;
} Rans;

typedef struct {
    u32 prob;
    u32 cum_prob;
} RansSym;

static int rans_init(Rans *ans, const u8 *buf, u32 size, u32 l_rans_base) {
    if (size < 1) return 0;
    ans->buf = buf;
    u32 x = buf[size - 1] >> 6;
    if (x == 0) {
        ans->offset = (i32)size - 1;
        ans->state = buf[size - 1] & 0x3f;
    } else if (x == 1) {
        if (size < 2) return 0;
        ans->offset = (i32)size - 2;
        ans->state = ((u32)buf[size - 2] | ((u32)buf[size - 1] << 8)) & 0x3fffu;
    } else if (x == 2) {
        if (size < 3) return 0;
        ans->offset = (i32)size - 3;
        ans->state = ((u32)buf[size - 3] | ((u32)buf[size - 2] << 8)
                   | ((u32)buf[size - 1] << 16)) & 0x3fffffu;
    } else {
        if (size < 4) return 0;
        ans->offset = (i32)size - 4;
        ans->state = ((u32)buf[size - 4] | ((u32)buf[size - 3] << 8)
                   | ((u32)buf[size - 2] << 16) | ((u32)buf[size - 1] << 24)) & 0x3fffffffu;
    }
    ans->state += l_rans_base;
    return 1;
}

static u32 rans_read(Rans *ans, u32 l_rans_base, u32 precision,
                     const u32 *lut, const RansSym *table) {
    while (ans->state < l_rans_base && ans->offset > 0) {
        ans->state = ans->state * D_IO_BASE + ans->buf[--ans->offset];
    }
    u32 quo = ans->state / precision;
    u32 rem = ans->state % precision;
    u32 symbol = lut[rem];
    ans->state = quo * table[symbol].prob + rem - table[symbol].cum_prob;
    return symbol;
}

/** The binary variant, used for one-bit-per-item streams (seams, creases). */
static u32 rabs_desc_read(Rans *ans, u32 p0) {
    u32 p = D_RABS_P8_PRECISION - p0;
    if (ans->state < D_RABS_L_BASE && ans->offset > 0) {
        ans->state = ans->state * D_IO_BASE + ans->buf[--ans->offset];
    }
    u32 x = ans->state;
    u32 quot = x / D_RABS_P8_PRECISION;
    u32 rem = x % D_RABS_P8_PRECISION;
    u32 xn = quot * p;
    u32 val = rem < p;
    if (val) ans->state = xn + rem;
    else ans->state = x - xn - p;
    return val;
}

/* ------------------------------------------------------- symbol decoding */

typedef struct {
    u32 num_symbols;
    u32 precision;
    u32 l_rans_base;
    u32 *lut;          /* precision entries: remainder -> symbol */
    RansSym *table;    /* num_symbols entries */
    Rans ans;
} SymbolDecoder;

static int rans_precision_bits(int symbols_bit_length) {
    int bits = (3 * symbols_bit_length) / 2;
    if (bits < 12) bits = 12;
    if (bits > 20) bits = 20;
    return bits;
}

/** Read the probability table and build the lookup table it implies. */
static int symbol_decoder_create(SymbolDecoder *sd, DBuf *b, int symbols_bit_length) {
    int bits = rans_precision_bits(symbols_bit_length);
    sd->precision = 1u << bits;
    sd->l_rans_base = sd->precision * 4u;
    sd->num_symbols = db_varu32(b);
    if (b->failed) return 0;
    if (sd->num_symbols / 64u > db_left(b)) return 0;

    sd->table = (RansSym *)heap_alloc((sd->num_symbols + 1) * (u32)sizeof(RansSym));
    sd->lut = (u32 *)heap_alloc(sd->precision * 4u);
    if (!sd->table || !sd->lut) return 0;
    u32 *probs = (u32 *)heap_alloc((sd->num_symbols + 1) * 4u);
    if (!probs) return 0;
    mem_zero(probs, (sd->num_symbols + 1) * 4u);

    for (u32 i = 0; i < sd->num_symbols; i++) {
        u8 prob_data = db_u8(b);
        if (b->failed) return 0;
        u32 token = prob_data & 3u;
        if (token == 3u) {
            /* A run of symbols that never occur. */
            u32 offset = prob_data >> 2;
            if (i + offset >= sd->num_symbols) return 0;
            for (u32 j = 0; j < offset + 1; j++) probs[i + j] = 0;
            i += offset;
        } else {
            u32 prob = prob_data >> 2;
            for (u32 j = 0; j < token; j++) {
                u8 eb = db_u8(b);
                if (b->failed) return 0;
                prob |= (u32)eb << (8u * (j + 1u) - 2u);
            }
            probs[i] = prob;
        }
    }

    u32 cum_prob = 0, act_prob = 0;
    for (u32 i = 0; i < sd->num_symbols; i++) {
        sd->table[i].prob = probs[i];
        sd->table[i].cum_prob = cum_prob;
        cum_prob += probs[i];
        if (cum_prob > sd->precision) return 0;
        for (u32 j = act_prob; j < cum_prob; j++) sd->lut[j] = i;
        act_prob = cum_prob;
    }
    return cum_prob == sd->precision || sd->num_symbols == 0;
}

static int symbol_decoder_start(SymbolDecoder *sd, DBuf *b) {
    u64 size = db_varint(b);
    if (b->failed || size > db_left(b)) return 0;
    const u8 *head = b->data + b->pos;
    b->pos += (u32)size;
    return rans_init(&sd->ans, head, (u32)size, sd->l_rans_base);
}

static u32 symbol_decoder_next(SymbolDecoder *sd) {
    return rans_read(&sd->ans, sd->l_rans_base, sd->precision, sd->lut, sd->table);
}

#define D_SYMBOL_TAGGED 0
#define D_SYMBOL_RAW 1

/**
 * DecodeSymbols(): either a tag stream giving each group's bit length with the
 * values written raw behind it, or one rANS symbol per value.
 */
static int decode_symbols(DBuf *b, u32 num_values, u32 num_components, u32 *out) {
    if (num_values == 0) return 1;
    u32 scheme = db_u8(b);
    if (b->failed) return 0;

    if (scheme == D_SYMBOL_TAGGED) {
        SymbolDecoder sd;
        if (!symbol_decoder_create(&sd, b, 5)) return 0;
        if (!symbol_decoder_start(&sd, b)) return 0;
        if (sd.num_symbols == 0) return 0;
        /* The values are bits in the main buffer, read straight through: the
         * specification's per-group reset is not what the decoder does. */
        db_bits_start(b);
        u32 at = 0;
        for (u32 i = 0; i < num_values; i += num_components) {
            u32 bit_length = symbol_decoder_next(&sd);
            if (bit_length > 32) return 0;
            for (u32 j = 0; j < num_components && at < num_values; j++) {
                out[at++] = db_bits(b, bit_length);
            }
        }
        db_bits_end(b);
        return !b->failed;
    }
    if (scheme == D_SYMBOL_RAW) {
        u8 max_bit_length = db_u8(b);
        if (b->failed || max_bit_length < 1 || max_bit_length > 18) return 0;
        SymbolDecoder sd;
        if (!symbol_decoder_create(&sd, b, max_bit_length)) return 0;
        if (sd.num_symbols == 0) return 0;
        if (!symbol_decoder_start(&sd, b)) return 0;
        for (u32 i = 0; i < num_values; i++) out[i] = symbol_decoder_next(&sd);
        return 1;
    }
    return 0;
}

/* ------------------------------------------------------------ decoder state */

typedef struct {
    u32 unique_id;
    u32 att_type;
    u32 data_type;
    u32 num_components;
    u32 normalized;
    i32 decoder_type;          /* SEQUENTIAL_ATTRIBUTE_ENCODER_* */
    i32 prediction_scheme;
    i32 transform_type;
    u32 compressed;
    u32 num_values;            /* entries to decode */
    u32 *symbols;              /* raw symbols */
    i32 *signed_values;        /* symbols as signed corrections */
    i32 *values;               /* portable (integer) values */
    f32 *dequantized;          /* final float values */
    /* quantization */
    f32 min_values[8];
    f32 range;
    u32 quantization_bits;
    /* wrap transform */
    i32 wrap_min, wrap_max;
    /* octahedral normals */
    i32 normal_max_q_val;
    u8 *flip_normal_bits;
    /* texture coordinates */
    u8 *orientations;
    u32 num_orientations;
    u32 orientation_at;
    /* constrained multi-parallelogram */
    u8 *is_crease_edge[D_MAX_PARALLELOGRAMS];
    u32 crease_count[D_MAX_PARALLELOGRAMS];
} DAttribute;

typedef struct {
    /* Which attribute data this decoder works on: -1 for the positions, which
     * use the mesh's own corner table, otherwise an index into attr_data. */
    i32 att_data_id;
    u32 decoder_type;          /* MESH_VERTEX_ATTRIBUTE or corner-based */
    u32 traversal_method;
    u32 num_attributes;
    DAttribute attributes[D_MAX_ATTRIBUTES];
    /* per attribute decoder traversal results */
    i32 *value_index_to_corner;    /* encoded_attribute_value_index_to_corner_map */
    u32 value_count;
    i32 *vertex_to_value_index;    /* vertex_to_encoded_attribute_value_index_map */
    i32 *indices_map;              /* point id -> attribute value index */
} DAttDecoder;

/**
 * One attribute's own view of the mesh: where its seams run, and the vertices
 * those seams split apart. Texture coordinates that are cut for unwrapping have
 * two values at one position, which is exactly what this records.
 */
typedef struct {
    u8 *is_edge_on_seam;           /* per corner */
    u8 *is_vert_on_seam;           /* per position vertex */
    i32 *corner_to_vertex;         /* from RecomputeVerticesInternal */
    i32 *face_to_vertex[3];
    i32 *vertex_to_left_most_corner;
    u32 num_new_vertices;
} DAttrData;

typedef struct {
    DBuf buf;
    u32 encoder_method;
    u32 eb_traversal_type;

    u32 num_encoded_vertices;
    u32 num_faces;
    u32 num_attribute_data;
    u32 num_encoded_symbols;
    u32 num_encoded_split_symbols;
    u32 num_verts;            /* num_encoded_vertices + num_encoded_split_symbols */
    u32 num_corners;          /* num_faces * 3 */
    u32 num_points;

    /* connectivity */
    i32 *face_to_vertex[3];
    u32 face_count;
    i32 *opposite_corners;
    i32 *corner_to_vertex0;
    i32 *vertex_corners;
    u8 *is_vert_hole;
    i32 *vertex_valences;
    i32 *active_corner_stack;
    u32 active_stack_size;
    i32 last_symbol;
    i32 active_context;
    i32 last_vert_added;

    /* topology splits */
    u32 num_topology_splits;
    i32 *source_symbol_id;
    i32 *split_symbol_id;
    u8 *source_edge_bit;
    u32 split_remaining;
    i32 *topology_split_id;
    i32 *split_active_corners;
    u32 split_active_count;

    /* traversal buffers */
    DBuf symbol_buf;
    u8 start_face_prob_zero;
    DBuf start_face_buf;
    u8 att_conn_prob_zero[D_MAX_ATT_DEC];
    DBuf att_conn_buf[D_MAX_ATT_DEC];

    /* valence traversal */
    u32 *valence_counters;
    u32 **valence_symbols;

    /* attribute seams and the vertices they split, one set per attribute data */
    DAttrData attr_data[D_MAX_ATT_DEC];

    /* attribute decoders */
    u32 num_att_dec;
    DAttDecoder att_dec[D_MAX_ATT_DEC];
    i32 curr_att_dec;
    u32 curr_att;
    /* Where the positions ended up: they are not always the first decoder. */
    i32 pos_att_dec;
    u32 pos_att;

    /* traversal scratch */
    u8 *is_face_visited;
    u8 *is_vertex_visited;
    i32 *corner_traversal_stack;
    u32 corner_stack_size;
    i32 *prediction_degree;
    i32 *traversal_stacks[D_MAX_PRIORITY];
    u32 traversal_stack_size[D_MAX_PRIORITY];
    i32 best_priority;

    i32 *corner_to_point_map;

    u32 error;
} Draco;

static Draco g_draco;

/* ------------------------------------------------------------------ corners */

static i32 d_next(i32 corner) {
    if (corner < 0) return corner;
    return (corner % 3) == 2 ? corner - 2 : corner + 1;
}

static i32 d_previous(i32 corner) {
    if (corner < 0) return corner;
    return (corner % 3) == 0 ? corner + 2 : corner - 1;
}

static i32 d_pos_opposite(Draco *d, i32 c) {
    if (c < 0 || (u32)c >= d->num_corners) return -1;
    return d->opposite_corners[c];
}

/**
 * Which attribute-data table a decoder traverses, or -1 for the mesh's own.
 *
 * A per-vertex decoder walks the mesh itself even when it owns attribute data;
 * only a per-corner decoder follows that attribute's seams.
 */
static i32 d_attr_table(Draco *d, i32 att_dec) {
    if (att_dec < 0) return -1;                 /* the mesh's own corner table */
    const DAttDecoder *ad = &d->att_dec[att_dec];
    if (ad->decoder_type == D_MESH_VERTEX_ATTRIBUTE) return -1;
    return ad->att_data_id;
}

static int d_is_corner_opposite_to_seam(Draco *d, i32 att_dec, i32 corner) {
    i32 table = d_attr_table(d, att_dec);
    if (table < 0 || corner < 0 || (u32)corner >= d->num_corners) return 0;
    u8 *seam = d->attr_data[table].is_edge_on_seam;
    return seam ? seam[corner] : 0;
}

/** Opposite(): across a seam an attribute has no neighbour, though the mesh does. */
static i32 d_opposite(Draco *d, i32 att_dec, i32 c) {
    if (d_attr_table(d, att_dec) < 0) return d_pos_opposite(d, c);
    if (d_is_corner_opposite_to_seam(d, att_dec, c)) return -1;
    return d_pos_opposite(d, c);
}

static i32 d_get_left_corner(Draco *d, i32 corner) {
    if (corner < 0) return -1;
    return d_pos_opposite(d, d_previous(corner));
}

static i32 d_get_right_corner(Draco *d, i32 corner) {
    if (corner < 0) return -1;
    return d_pos_opposite(d, d_next(corner));
}

static int d_is_edge_on_seam(Draco *d, u32 attr, i32 corner) {
    if (corner < 0 || (u32)corner >= d->num_corners) return 0;
    u8 *seam = d->attr_data[attr].is_edge_on_seam;
    return seam ? seam[corner] : 0;
}

/** Swing left around a vertex within one attribute's table, stopping at seams. */
static i32 d_attr_swing_left(Draco *d, u32 attr, i32 corner) {
    i32 c = d_next(corner);
    if (d_is_edge_on_seam(d, attr, c)) return -1;
    return d_next(d_pos_opposite(d, c));
}

static i32 d_swing_right(Draco *d, i32 att_dec, i32 corner) {
    return d_previous(d_opposite(d, att_dec, d_previous(corner)));
}

static i32 d_swing_left(Draco *d, i32 att_dec, i32 corner) {
    return d_next(d_opposite(d, att_dec, d_next(corner)));
}

/** The three vertices of a corner's face, starting at the corner itself. */
static void d_corner_to_verts(Draco *d, i32 att_dec, i32 corner_id,
                              i32 *v, i32 *n, i32 *p) {
    i32 *const *ftv = d->face_to_vertex;
    i32 table = d_attr_table(d, att_dec);
    if (table >= 0) ftv = d->attr_data[table].face_to_vertex;
    if (corner_id < 0 || (u32)corner_id >= d->num_corners) {
        *v = *n = *p = -1;
        return;
    }
    u32 local = (u32)corner_id % 3u;
    u32 face = (u32)corner_id / 3u;
    if (local == 0) { *v = ftv[0][face]; *n = ftv[1][face]; *p = ftv[2][face]; }
    else if (local == 1) { *v = ftv[1][face]; *n = ftv[2][face]; *p = ftv[0][face]; }
    else { *v = ftv[2][face]; *n = ftv[0][face]; *p = ftv[1][face]; }
}

static i32 d_corner_to_vert(Draco *d, i32 att_dec, i32 corner_id) {
    i32 v, n, p;
    d_corner_to_verts(d, att_dec, corner_id, &v, &n, &p);
    return v;
}

static void d_set_opposite_corners(Draco *d, i32 c, i32 opp_c) {
    if (c >= 0 && (u32)c < d->num_corners) d->opposite_corners[c] = opp_c;
    if (opp_c >= 0 && (u32)opp_c < d->num_corners) d->opposite_corners[opp_c] = c;
}

static void d_map_corner_to_vertex(Draco *d, i32 corner_id, i32 vert_id) {
    if (corner_id < 0 || (u32)corner_id >= d->num_corners) return;
    d->corner_to_vertex0[corner_id] = vert_id;
}

/** Where the fan around a vertex starts. Set only where the decoder sets it. */
static void d_set_left_most_corner(Draco *d, i32 vert_id, i32 corner_id) {
    if (vert_id >= 0 && (u32)vert_id < d->num_verts) d->vertex_corners[vert_id] = corner_id;
}

/** Walk left around a vertex so its stored corner is the first of its fan. */
static void d_update_vertex_to_corner_map(Draco *d, u32 vert) {
    i32 first_c = d->vertex_corners[vert];
    if (first_c < 0) return;
    i32 act_c = d_swing_left(d, D_MESH_TABLE, first_c);
    i32 c = first_c;
    while (act_c >= 0 && act_c != first_c) {
        c = act_c;
        act_c = d_swing_left(d, D_MESH_TABLE, act_c);
    }
    if (act_c != first_c) d->vertex_corners[vert] = c;
}

/* --------------------------------------------------- edgebreaker connectivity */

static void d_replace_verts(Draco *d, i32 from, i32 to) {
    for (u32 i = 0; i < d->face_count; i++) {
        if (d->face_to_vertex[0][i] == from) d->face_to_vertex[0][i] = to;
        if (d->face_to_vertex[1][i] == from) d->face_to_vertex[1][i] = to;
        if (d->face_to_vertex[2][i] == from) d->face_to_vertex[2][i] = to;
    }
}

static void d_update_corners_after_merge(Draco *d, i32 c, i32 v) {
    i32 opp_corner = d_pos_opposite(d, c);
    if (opp_corner >= 0) {
        i32 corner_n = d_next(opp_corner);
        while (corner_n >= 0) {
            d_map_corner_to_vertex(d, corner_n, v);
            corner_n = d_swing_left(d, D_MESH_TABLE, corner_n);
        }
    }
}

static void d_push_face(Draco *d, i32 v, i32 n, i32 p) {
    if (d->face_count >= d->num_faces) { d->error = D_ERR_CORRUPT; return; }
    d->face_to_vertex[0][d->face_count] = v;
    d->face_to_vertex[1][d->face_count] = n;
    d->face_to_vertex[2][d->face_count] = p;
    d->face_count++;
}

/** IsTopologySplit(): the splits are consumed from the back as symbols arrive. */
static int d_is_topology_split(Draco *d, i32 encoder_symbol_id,
                               i32 *out_face_edge, i32 *out_split_id) {
    if (d->split_remaining == 0) return 0;
    u32 last = d->split_remaining - 1;
    if (d->source_symbol_id[last] != encoder_symbol_id) return 0;
    *out_face_edge = d->source_edge_bit[last];
    *out_split_id = d->split_symbol_id[last];
    d->split_remaining--;
    return 1;
}

/** NewActiveCornerReached(): one symbol, one triangle stitched onto the border. */
static void d_new_active_corner_reached(Draco *d, i32 new_corner, i32 symbol_id) {
    int check_topology_split = 0;
    i32 vert = -1, next = -1, prev = -1;
    i32 corner_a = -1, corner_b = -1;

    switch (d->last_symbol) {
    case D_TOPOLOGY_C:
        if (d->active_stack_size == 0) { d->error = D_ERR_CORRUPT; return; }
        corner_a = d->active_corner_stack[d->active_stack_size - 1];
        corner_b = d_previous(corner_a);
        while (d_pos_opposite(d, corner_b) >= 0) {
            corner_b = d_previous(d_pos_opposite(d, corner_b));
        }
        d_set_opposite_corners(d, corner_a, new_corner + 1);
        d_set_opposite_corners(d, corner_b, new_corner + 2);
        d->active_corner_stack[d->active_stack_size - 1] = new_corner;

        vert = d_corner_to_vert(d, D_MESH_TABLE, d_next(corner_a));
        next = d_corner_to_vert(d, D_MESH_TABLE, d_next(corner_b));
        prev = d_corner_to_vert(d, D_MESH_TABLE, d_previous(corner_a));
        if (d->eb_traversal_type == D_VALENCE_EDGEBREAKER) {
            d->vertex_valences[next] += 1;
            d->vertex_valences[prev] += 1;
        }
        d_push_face(d, vert, next, prev);
        if (vert >= 0 && (u32)vert < d->num_verts) d->is_vert_hole[vert] = 0;
        d_map_corner_to_vertex(d, new_corner, vert);
        d_map_corner_to_vertex(d, new_corner + 1, next);
        d_map_corner_to_vertex(d, new_corner + 2, prev);
        d_set_left_most_corner(d, prev, new_corner + 2);
        break;

    case D_TOPOLOGY_S: {
        if (d->active_stack_size == 0) { d->error = D_ERR_CORRUPT; return; }
        corner_b = d->active_corner_stack[--d->active_stack_size];
        for (u32 i = 0; i < d->split_active_count; i++) {
            if (d->topology_split_id[i] == symbol_id) {
                if (d->active_stack_size >= d->num_faces + 1) { d->error = D_ERR_CORRUPT; return; }
                d->active_corner_stack[d->active_stack_size++] = d->split_active_corners[i];
            }
        }
        if (d->active_stack_size == 0) { d->error = D_ERR_CORRUPT; return; }
        corner_a = d->active_corner_stack[d->active_stack_size - 1];
        d_set_opposite_corners(d, corner_a, new_corner + 2);
        d_set_opposite_corners(d, corner_b, new_corner + 1);
        d->active_corner_stack[d->active_stack_size - 1] = new_corner;

        vert = d_corner_to_vert(d, D_MESH_TABLE, d_previous(corner_a));
        next = d_corner_to_vert(d, D_MESH_TABLE, d_next(corner_a));
        prev = d_corner_to_vert(d, D_MESH_TABLE, d_previous(corner_b));
        d_map_corner_to_vertex(d, new_corner, vert);
        d_map_corner_to_vertex(d, new_corner + 1, next);
        d_map_corner_to_vertex(d, new_corner + 2, prev);
        i32 corner_n = d_next(corner_b);
        i32 vertex_n = d_corner_to_vert(d, D_MESH_TABLE, corner_n);
        if (d->eb_traversal_type == D_VALENCE_EDGEBREAKER && vertex_n >= 0 && vert >= 0) {
            d->vertex_valences[vert] += d->vertex_valences[vertex_n];
        }
        d_replace_verts(d, vertex_n, vert);
        if (d->eb_traversal_type == D_VALENCE_EDGEBREAKER) {
            d->vertex_valences[next] += 1;
            d->vertex_valences[prev] += 1;
        }
        d_push_face(d, vert, next, prev);
        d_set_left_most_corner(d, prev, new_corner + 2);
        /* The merged vertex takes over the fan of the one it swallowed, which
         * is then isolated. */
        d_set_left_most_corner(d, vert,
            (vertex_n >= 0 && (u32)vertex_n < d->num_verts)
                ? d->vertex_corners[vertex_n] : -1);
        d_update_corners_after_merge(d, new_corner + 1, vert);
        if (vertex_n >= 0 && (u32)vertex_n < d->num_verts) d->vertex_corners[vertex_n] = -1;
        break;
    }

    case D_TOPOLOGY_R:
        if (d->active_stack_size == 0) { d->error = D_ERR_CORRUPT; return; }
        corner_a = d->active_corner_stack[d->active_stack_size - 1];
        d_set_opposite_corners(d, new_corner + 2, corner_a);
        d->active_corner_stack[d->active_stack_size - 1] = new_corner;
        check_topology_split = 1;
        vert = d_corner_to_vert(d, D_MESH_TABLE, d_previous(corner_a));
        next = d_corner_to_vert(d, D_MESH_TABLE, d_next(corner_a));
        prev = ++d->last_vert_added;
        if (d->eb_traversal_type == D_VALENCE_EDGEBREAKER) {
            d->vertex_valences[vert] += 1;
            d->vertex_valences[next] += 1;
            d->vertex_valences[prev] += 2;
        }
        d_push_face(d, vert, next, prev);
        d_map_corner_to_vertex(d, new_corner + 2, prev);
        d_map_corner_to_vertex(d, new_corner, vert);
        d_map_corner_to_vertex(d, new_corner + 1, next);
        d_set_left_most_corner(d, prev, new_corner + 2);   /* the new vertex */
        d_set_left_most_corner(d, vert, new_corner);       /* corner "r" */
        break;

    case D_TOPOLOGY_L:
        if (d->active_stack_size == 0) { d->error = D_ERR_CORRUPT; return; }
        corner_a = d->active_corner_stack[d->active_stack_size - 1];
        d_set_opposite_corners(d, new_corner + 1, corner_a);
        d->active_corner_stack[d->active_stack_size - 1] = new_corner;
        check_topology_split = 1;
        vert = d_corner_to_vert(d, D_MESH_TABLE, d_next(corner_a));
        next = ++d->last_vert_added;
        prev = d_corner_to_vert(d, D_MESH_TABLE, d_previous(corner_a));
        if (d->eb_traversal_type == D_VALENCE_EDGEBREAKER) {
            d->vertex_valences[vert] += 1;
            d->vertex_valences[next] += 2;
            d->vertex_valences[prev] += 1;
        }
        d_push_face(d, vert, next, prev);
        d_map_corner_to_vertex(d, new_corner + 2, prev);
        d_map_corner_to_vertex(d, new_corner, vert);
        d_map_corner_to_vertex(d, new_corner + 1, next);
        d_set_left_most_corner(d, next, new_corner + 1);   /* the new vertex */
        d_set_left_most_corner(d, prev, new_corner + 2);   /* corner "r" */
        break;

    case D_TOPOLOGY_E:
        if (d->active_stack_size >= d->num_faces + 1) { d->error = D_ERR_CORRUPT; return; }
        d->active_corner_stack[d->active_stack_size++] = new_corner;
        check_topology_split = 1;
        vert = d->last_vert_added + 1;
        next = vert + 1;
        prev = next + 1;
        if (d->eb_traversal_type == D_VALENCE_EDGEBREAKER) {
            d->vertex_valences[vert] += 2;
            d->vertex_valences[next] += 2;
            d->vertex_valences[prev] += 2;
        }
        d_push_face(d, vert, next, prev);
        d->last_vert_added = prev;
        d_map_corner_to_vertex(d, new_corner, vert);
        d_map_corner_to_vertex(d, new_corner + 1, next);
        d_map_corner_to_vertex(d, new_corner + 2, prev);
        d_set_left_most_corner(d, vert, new_corner);
        d_set_left_most_corner(d, next, new_corner + 1);
        d_set_left_most_corner(d, prev, new_corner + 2);
        break;

    default:
        d->error = D_ERR_CORRUPT;
        return;
    }

    if (d->error) return;

    if (d->eb_traversal_type == D_VALENCE_EDGEBREAKER) {
        /* The next symbol is read from the context of this vertex's valence. */
        i32 active_valence = (next >= 0 && (u32)next < d->num_verts)
            ? d->vertex_valences[next] : D_MIN_VALENCE;
        i32 clamped = active_valence;
        if (clamped < D_MIN_VALENCE) clamped = D_MIN_VALENCE;
        if (clamped > D_MAX_VALENCE) clamped = D_MAX_VALENCE;
        d->active_context = clamped - D_MIN_VALENCE;
    }

    if (check_topology_split) {
        i32 encoder_symbol_id = (i32)d->num_encoded_symbols - symbol_id - 1;
        i32 split_edge, enc_split_id;
        while (d_is_topology_split(d, encoder_symbol_id, &split_edge, &enc_split_id)) {
            if (d->active_stack_size == 0) { d->error = D_ERR_CORRUPT; return; }
            i32 act_top_corner = d->active_corner_stack[d->active_stack_size - 1];
            i32 new_active_corner = (split_edge == D_RIGHT_FACE_EDGE)
                ? d_next(act_top_corner) : d_previous(act_top_corner);
            i32 dec_split_id = (i32)d->num_encoded_symbols - enc_split_id - 1;
            d->topology_split_id[d->split_active_count] = dec_split_id;
            d->split_active_corners[d->split_active_count] = new_active_corner;
            d->split_active_count++;
        }
    }
}

/** The symbol stream: one bit for C, three for everything else. */
static void d_decode_symbol(Draco *d) {
    if (d->eb_traversal_type == D_VALENCE_EDGEBREAKER) {
        if (d->active_context != -1) {
            u32 ctx = (u32)d->active_context;
            if (d->valence_counters[ctx] == 0) { d->error = D_ERR_CORRUPT; return; }
            u32 symbol_id = d->valence_symbols[ctx][--d->valence_counters[ctx]];
            static const i32 to_topology[5] = {
                D_TOPOLOGY_C, D_TOPOLOGY_S, D_TOPOLOGY_L, D_TOPOLOGY_R, D_TOPOLOGY_E
            };
            d->last_symbol = symbol_id < 5 ? to_topology[symbol_id] : -1;
            if (d->last_symbol < 0) d->error = D_ERR_CORRUPT;
        } else {
            d->last_symbol = D_TOPOLOGY_E;
        }
    } else {
        u32 symbol = db_bits(&d->symbol_buf, 1);
        if (symbol != D_TOPOLOGY_C) {
            u32 suffix = db_bits(&d->symbol_buf, 2);
            symbol |= suffix << 1;
        }
        d->last_symbol = (i32)symbol;
    }
}

/** ProcessInteriorEdges(): close the fans the symbols left open. */
static void d_process_interior_edges(Draco *d) {
    Rans ans;
    if (!rans_init(&ans, d->start_face_buf.data, d->start_face_buf.size, D_L_RANS_BASE)) {
        if (d->start_face_buf.size) d->error = D_ERR_CORRUPT;
        return;
    }
    while (d->active_stack_size > 0) {
        i32 corner_a = d->active_corner_stack[--d->active_stack_size];
        u32 interior_face = rabs_desc_read(&ans, d->start_face_prob_zero);
        if (!interior_face) continue;

        i32 corner_b = d_previous(corner_a);
        while (d_pos_opposite(d, corner_b) >= 0) corner_b = d_previous(d_pos_opposite(d, corner_b));
        i32 corner_c = d_next(corner_a);
        while (d_pos_opposite(d, corner_c) >= 0) corner_c = d_next(d_pos_opposite(d, corner_c));

        i32 new_corner = (i32)(d->face_count * 3u);
        d_set_opposite_corners(d, new_corner, corner_a);
        d_set_opposite_corners(d, new_corner + 1, corner_b);
        d_set_opposite_corners(d, new_corner + 2, corner_c);

        i32 temp_v, temp_p, next_a, next_b, next_c;
        d_corner_to_verts(d, D_MESH_TABLE, corner_a, &temp_v, &next_a, &temp_p);
        d_corner_to_verts(d, D_MESH_TABLE, corner_b, &temp_v, &next_b, &temp_p);
        d_corner_to_verts(d, D_MESH_TABLE, corner_c, &temp_v, &next_c, &temp_p);
        d_map_corner_to_vertex(d, new_corner, next_b);
        d_map_corner_to_vertex(d, new_corner + 1, next_c);
        d_map_corner_to_vertex(d, new_corner + 2, next_a);
        d_push_face(d, next_b, next_c, next_a);
        if (d->error) return;
        if (next_b >= 0) d->is_vert_hole[next_b] = 0;
        if (next_c >= 0) d->is_vert_hole[next_c] = 0;
        if (next_a >= 0) d->is_vert_hole[next_a] = 0;
    }
}

static void d_parse_topology_split_events(Draco *d) {
    DBuf *b = &d->buf;
    d->num_topology_splits = db_varu32(b);
    if (b->failed || d->num_topology_splits > d->num_faces) {
        d->error = D_ERR_CORRUPT;
        return;
    }
    u32 n = d->num_topology_splits;
    d->source_symbol_id = (i32 *)heap_alloc((n + 1) * 4u);
    d->split_symbol_id = (i32 *)heap_alloc((n + 1) * 4u);
    d->source_edge_bit = (u8 *)heap_alloc(n + 1);
    if (!d->source_symbol_id || !d->split_symbol_id || !d->source_edge_bit) {
        d->error = D_ERR_MEMORY;
        return;
    }
    i32 last_id = 0;
    for (u32 i = 0; i < n; i++) {
        u32 source_delta = db_varu32(b);
        u32 split_delta = db_varu32(b);
        d->source_symbol_id[i] = (i32)source_delta + last_id;
        if ((i32)split_delta > d->source_symbol_id[i]) { d->error = D_ERR_CORRUPT; return; }
        d->split_symbol_id[i] = d->source_symbol_id[i] - (i32)split_delta;
        last_id = d->source_symbol_id[i];
    }
    if (n > 0) {
        db_bits_start(b);
        for (u32 i = 0; i < n; i++) d->source_edge_bit[i] = (u8)db_bits(b, 1);
        db_bits_end(b);
    }
    d->split_remaining = n;
    if (b->failed) d->error = D_ERR_TRUNCATED;
}

/** A sub-buffer written as its size then its bytes. */
static int d_take_buffer(Draco *d, DBuf *out, int size_is_64) {
    DBuf *b = &d->buf;
    u64 size = size_is_64 ? db_varint(b) : (u64)db_varu32(b);
    if (b->failed || size > db_left(b)) { d->error = D_ERR_TRUNCATED; return 0; }
    db_init(out, b->data + b->pos, (u32)size);
    b->pos += (u32)size;
    return 1;
}

static void d_parse_attribute_connectivity(Draco *d) {
    for (u32 i = 0; i < d->num_attribute_data; i++) {
        d->att_conn_prob_zero[i] = db_u8(&d->buf);
        if (!d_take_buffer(d, &d->att_conn_buf[i], 0)) return;
    }
}

static void d_edgebreaker_traversal_start(Draco *d) {
    d->last_symbol = -1;
    d->active_context = -1;
    if (d->eb_traversal_type == D_STANDARD_EDGEBREAKER) {
        if (!d_take_buffer(d, &d->symbol_buf, 1)) return;
        db_bits_start(&d->symbol_buf);
        d->start_face_prob_zero = db_u8(&d->buf);
        if (!d_take_buffer(d, &d->start_face_buf, 0)) return;
        d_parse_attribute_connectivity(d);
    } else if (d->eb_traversal_type == D_VALENCE_EDGEBREAKER) {
        d->start_face_prob_zero = db_u8(&d->buf);
        if (!d_take_buffer(d, &d->start_face_buf, 0)) return;
        d_parse_attribute_connectivity(d);
        if (d->error) return;
        d->valence_counters = (u32 *)heap_alloc(D_NUM_UNIQUE_VALENCES * 4u);
        d->valence_symbols = (u32 **)heap_alloc(D_NUM_UNIQUE_VALENCES * (u32)sizeof(u32 *));
        if (!d->valence_counters || !d->valence_symbols) { d->error = D_ERR_MEMORY; return; }
        for (u32 i = 0; i < D_NUM_UNIQUE_VALENCES; i++) {
            d->valence_counters[i] = db_varu32(&d->buf);
            d->valence_symbols[i] = NULL;
            if (d->buf.failed) { d->error = D_ERR_TRUNCATED; return; }
            if (d->valence_counters[i] > 0) {
                if (d->valence_counters[i] > d->num_encoded_symbols + 1) {
                    d->error = D_ERR_CORRUPT;
                    return;
                }
                d->valence_symbols[i] = (u32 *)heap_alloc(d->valence_counters[i] * 4u);
                if (!d->valence_symbols[i]) { d->error = D_ERR_MEMORY; return; }
                if (!decode_symbols(&d->buf, d->valence_counters[i], 1, d->valence_symbols[i])) {
                    d->error = D_ERR_CORRUPT;
                    return;
                }
            }
        }
    } else {
        d->error = D_ERR_UNSUPPORTED;
    }
}

static void d_decode_edgebreaker_connectivity(Draco *d) {
    for (u32 i = 0; i < d->num_verts; i++) d->is_vert_hole[i] = 1;
    d->last_vert_added = -1;
    for (u32 i = 0; i < d->num_encoded_symbols; i++) {
        d_decode_symbol(d);
        if (d->error) return;
        d_new_active_corner_reached(d, (i32)(3u * i), (i32)i);
        if (d->error) return;
    }
    d_process_interior_edges(d);
}

static void d_decode_edgebreaker_connectivity_data(Draco *d) {
    DBuf *b = &d->buf;
    d->eb_traversal_type = db_u8(b);
    d->num_encoded_vertices = db_varu32(b);
    d->num_faces = db_varu32(b);
    d->num_attribute_data = db_u8(b);
    d->num_encoded_symbols = db_varu32(b);
    d->num_encoded_split_symbols = db_varu32(b);
    if (b->failed) { d->error = D_ERR_TRUNCATED; return; }

    if (d->num_faces == 0 || d->num_faces > (1u << 28) / 3u) { d->error = D_ERR_LIMIT; return; }
    if (d->num_faces < d->num_encoded_symbols) { d->error = D_ERR_CORRUPT; return; }
    if (d->num_encoded_split_symbols > d->num_encoded_symbols) { d->error = D_ERR_CORRUPT; return; }
    if (d->num_attribute_data >= D_MAX_ATT_DEC) { d->error = D_ERR_LIMIT; return; }

    d->num_verts = d->num_encoded_vertices + d->num_encoded_split_symbols;
    d->num_corners = d->num_faces * 3u;

    for (int i = 0; i < 3; i++) {
        d->face_to_vertex[i] = (i32 *)heap_alloc(d->num_faces * 4u);
    }
    d->opposite_corners = (i32 *)heap_alloc(d->num_corners * 4u);
    d->corner_to_vertex0 = (i32 *)heap_alloc(d->num_corners * 4u);
    d->vertex_corners = (i32 *)heap_alloc((d->num_verts + 1) * 4u);
    d->is_vert_hole = (u8 *)heap_alloc(d->num_verts + 1);
    d->vertex_valences = (i32 *)heap_alloc((d->num_verts + 1) * 4u);
    d->active_corner_stack = (i32 *)heap_alloc((d->num_faces + 2) * 4u);
    d->topology_split_id = (i32 *)heap_alloc((d->num_faces + 2) * 4u);
    d->split_active_corners = (i32 *)heap_alloc((d->num_faces + 2) * 4u);
    if (!d->face_to_vertex[2] || !d->opposite_corners || !d->corner_to_vertex0
        || !d->vertex_corners || !d->is_vert_hole || !d->vertex_valences
        || !d->active_corner_stack || !d->topology_split_id || !d->split_active_corners) {
        d->error = D_ERR_MEMORY;
        return;
    }
    for (u32 i = 0; i < d->num_corners; i++) {
        d->opposite_corners[i] = -1;
        d->corner_to_vertex0[i] = -1;
    }
    for (u32 i = 0; i <= d->num_verts; i++) {
        d->vertex_corners[i] = -1;
        d->vertex_valences[i] = 0;
    }
    d->face_count = 0;
    d->active_stack_size = 0;
    d->split_active_count = 0;

    d_parse_topology_split_events(d);
    if (d->error) return;
    d_edgebreaker_traversal_start(d);
    if (d->error) return;
    d_decode_edgebreaker_connectivity(d);
}

/* ------------------------------------------------- sequential connectivity */

static void d_decode_sequential_connectivity_data(Draco *d) {
    DBuf *b = &d->buf;
    d->num_faces = db_varu32(b);
    d->num_points = db_varu32(b);
    u32 method = db_u8(b);
    if (b->failed) { d->error = D_ERR_TRUNCATED; return; }
    if (d->num_faces == 0 || d->num_faces > (1u << 28) / 3u) { d->error = D_ERR_LIMIT; return; }

    d->num_corners = d->num_faces * 3u;
    d->num_verts = d->num_points;
    for (int i = 0; i < 3; i++) d->face_to_vertex[i] = (i32 *)heap_alloc(d->num_faces * 4u);
    if (!d->face_to_vertex[2]) { d->error = D_ERR_MEMORY; return; }
    d->face_count = d->num_faces;

    if (method == 0) {  /* SEQUENTIAL_COMPRESSED_INDICES */
        u32 *symbols = (u32 *)heap_alloc(d->num_corners * 4u);
        if (!symbols) { d->error = D_ERR_MEMORY; return; }
        if (!decode_symbols(b, d->num_corners, 1, symbols)) { d->error = D_ERR_CORRUPT; return; }
        i32 last = 0;
        for (u32 i = 0; i < d->num_faces; i++) {
            for (u32 j = 0; j < 3; j++) {
                u32 encoded = symbols[i * 3u + j];
                i32 diff = (i32)(encoded >> 1);
                if (encoded & 1u) diff = -diff;
                last = diff + last;
                d->face_to_vertex[j][i] = last;
            }
        }
    } else {            /* SEQUENTIAL_UNCOMPRESSED_INDICES */
        for (u32 i = 0; i < d->num_faces; i++) {
            for (u32 j = 0; j < 3; j++) {
                i32 v;
                if (d->num_points < 256) v = (i32)db_u8(b);
                else if (d->num_points < (1u << 16)) v = (i32)db_u16(b);
                else if (d->num_points < (1u << 21)) v = (i32)db_varu32(b);
                else v = (i32)db_u32(b);
                d->face_to_vertex[j][i] = v;
            }
        }
    }
    if (b->failed) d->error = D_ERR_TRUNCATED;
}

/* ------------------------------------------------------------ attribute seams */

/** DecodeAttributeSeams(): one bit per interior edge says whether it is a seam. */
static void d_decode_attribute_seams(Draco *d) {
    u32 extra = d->num_attribute_data;
    Rans ans[D_MAX_ATT_DEC];
    for (u32 a = 0; a < extra; a++) {
        if (!rans_init(&ans[a], d->att_conn_buf[a].data, d->att_conn_buf[a].size,
                       D_L_RANS_BASE)) {
            d->error = D_ERR_CORRUPT;
            return;
        }
        d->attr_data[a].is_edge_on_seam = (u8 *)heap_alloc(d->num_corners + 1);
        d->attr_data[a].is_vert_on_seam = (u8 *)heap_alloc(d->num_verts + 1);
        if (!d->attr_data[a].is_edge_on_seam || !d->attr_data[a].is_vert_on_seam) {
            d->error = D_ERR_MEMORY;
            return;
        }
        mem_zero(d->attr_data[a].is_edge_on_seam, d->num_corners + 1);
        mem_zero(d->attr_data[a].is_vert_on_seam, d->num_verts + 1);
    }
    if (extra == 0) return;

    for (u32 j = 0; j < d->num_faces; j++) {
        for (u32 k = 0; k < 3; k++) {
            i32 corner = (i32)(j * 3u + k);
            i32 v, n, p;
            d_corner_to_verts(d, D_MESH_TABLE, corner, &v, &n, &p);
            i32 opp_corner = d_pos_opposite(d, corner);
            if (opp_corner >= 0) {
                /* An interior edge is coded once, from its lower corner. */
                if (opp_corner >= corner) {
                    for (u32 a = 0; a < extra; a++) {
                        u32 val = rabs_desc_read(&ans[a], d->att_conn_prob_zero[a]);
                        if (!val) continue;
                        if (n >= 0) d->attr_data[a].is_vert_on_seam[n] = 1;
                        if (p >= 0) d->attr_data[a].is_vert_on_seam[p] = 1;
                        d->attr_data[a].is_edge_on_seam[corner] = 1;
                        i32 ov, on, op;
                        d_corner_to_verts(d, D_MESH_TABLE, opp_corner, &ov, &on, &op);
                        if (on >= 0) d->attr_data[a].is_vert_on_seam[on] = 1;
                        if (op >= 0) d->attr_data[a].is_vert_on_seam[op] = 1;
                        d->attr_data[a].is_edge_on_seam[opp_corner] = 1;
                    }
                }
            } else {
                /* A boundary edge is a seam for every attribute. */
                for (u32 a = 0; a < extra; a++) {
                    if (n >= 0) d->attr_data[a].is_vert_on_seam[n] = 1;
                    if (p >= 0) d->attr_data[a].is_vert_on_seam[p] = 1;
                    d->attr_data[a].is_edge_on_seam[corner] = 1;
                }
            }
        }
    }
}

static int d_is_vertex_on_attribute_seam(Draco *d, i32 attr, i32 vert) {
    if (attr < 0 || vert < 0 || (u32)vert > d->num_verts) return 0;
    u8 *marks = d->attr_data[attr].is_vert_on_seam;
    return marks ? marks[vert] : 0;
}

/** RecomputeVerticesInternal(): split a vertex wherever an attribute seam runs. */
static void d_recompute_vertices_internal(Draco *d, u32 attr) {
    DAttrData *ad = &d->attr_data[attr];
    u32 num_new_vertices = 0;

    for (int i = 0; i < 3; i++) {
        ad->face_to_vertex[i] = (i32 *)heap_alloc(d->num_faces * 4u);
        if (!ad->face_to_vertex[i]) { d->error = D_ERR_MEMORY; return; }
        mem_copy(ad->face_to_vertex[i], d->face_to_vertex[i], d->num_faces * 4u);
    }
    ad->corner_to_vertex = (i32 *)heap_alloc(d->num_corners * 4u);
    ad->vertex_to_left_most_corner = (i32 *)heap_alloc((d->num_corners + 1) * 4u);
    if (!ad->corner_to_vertex || !ad->vertex_to_left_most_corner) {
        d->error = D_ERR_MEMORY;
        return;
    }
    for (u32 i = 0; i < d->num_corners; i++) ad->corner_to_vertex[i] = -1;

    for (u32 v = 0; v < d->num_verts; v++) {
        i32 c = d->vertex_corners[v];
        if (c < 0) continue;
        i32 first_vert_id = (i32)num_new_vertices++;
        i32 first_c = c;
        if (d_is_vertex_on_attribute_seam(d, (i32)attr, (i32)v)) {
            i32 act_c = d_attr_swing_left(d, attr, first_c);
            while (act_c >= 0) {
                first_c = act_c;
                act_c = d_attr_swing_left(d, attr, act_c);
            }
        }
        ad->corner_to_vertex[first_c] = first_vert_id;
        ad->vertex_to_left_most_corner[first_vert_id] = first_c;
        i32 act_c = d_swing_right(d, D_MESH_TABLE, first_c);
        while (act_c >= 0 && act_c != first_c) {
            i32 next_act_c = d_next(act_c);
            if (d_is_edge_on_seam(d, attr, next_act_c)) {
                first_vert_id = (i32)num_new_vertices++;
                ad->vertex_to_left_most_corner[first_vert_id] = act_c;
            }
            ad->corner_to_vertex[act_c] = first_vert_id;
            act_c = d_swing_right(d, D_MESH_TABLE, act_c);
        }
    }
    ad->num_new_vertices = num_new_vertices;

    for (u32 i = 0; i < d->num_corners; i += 3) {
        u32 face = i / 3u;
        ad->face_to_vertex[0][face] = ad->corner_to_vertex[i];
        ad->face_to_vertex[1][face] = ad->corner_to_vertex[i + 1];
        ad->face_to_vertex[2][face] = ad->corner_to_vertex[i + 2];
    }
}

/** Attribute_AssignPointsToCorners(): a point per distinct set of attributes. */
static void d_assign_points_to_corners(Draco *d) {
    u32 count = 0;
    for (u32 i = 0; i < d->num_corners; i++) d->corner_to_point_map[i] = -1;

    for (u32 v = 0; v < d->num_verts; v++) {
        i32 c = d->vertex_corners[v];
        if (c < 0) continue;
        i32 deduplication_first_corner = c;
        if (!d->is_vert_hole[v]) {
            for (u32 attr = 0; attr < d->num_attribute_data; attr++) {
                if (!d->attr_data[attr].corner_to_vertex) continue;
                i32 cv, cn, cp;
                d_corner_to_verts(d, D_MESH_TABLE, c, &cv, &cn, &cp);
                if (!d_is_vertex_on_attribute_seam(d, (i32)attr, cv)) continue;
                i32 vert_id = d->attr_data[attr].corner_to_vertex[c];
                i32 act_c = d_swing_right(d, D_MESH_TABLE, c);
                int seam_found = 0;
                while (act_c >= 0 && act_c != c) {
                    i32 act_vert_id = d->attr_data[attr].corner_to_vertex[act_c];
                    if (act_vert_id != vert_id) {
                        deduplication_first_corner = act_c;
                        seam_found = 1;
                        break;
                    }
                    act_c = d_swing_right(d, D_MESH_TABLE, act_c);
                }
                if (seam_found) break;
            }
        }

        c = deduplication_first_corner;
        d->corner_to_point_map[c] = (i32)count++;
        i32 prev_c = c;
        c = d_swing_right(d, D_MESH_TABLE, c);
        while (c >= 0 && c != deduplication_first_corner) {
            int attribute_seam = 0;
            for (u32 attr = 0; attr < d->num_attribute_data; attr++) {
                i32 *map = d->attr_data[attr].corner_to_vertex;
                if (map && map[c] != map[prev_c]) {
                    attribute_seam = 1;
                    break;
                }
            }
            d->corner_to_point_map[c] = attribute_seam
                ? (i32)count++ : d->corner_to_point_map[prev_c];
            prev_c = c;
            c = d_swing_right(d, D_MESH_TABLE, c);
        }
    }
    d->num_points = count;
}

/* -------------------------------------------------------------- traversals */

static void d_on_new_vertex_visited(Draco *d, i32 vertex, i32 corner) {
    DAttDecoder *ad = &d->att_dec[d->curr_att_dec];
    if (ad->value_count >= d->num_corners) { d->error = D_ERR_CORRUPT; return; }
    ad->value_index_to_corner[ad->value_count] = corner;
    if (vertex >= 0) ad->vertex_to_value_index[vertex] = (i32)ad->value_count;
    ad->value_count++;
}

static int d_is_face_visited(Draco *d, i32 face_id) {
    if (face_id < 0) return 1;
    return d->is_face_visited[face_id];
}

/**
 * A vertex is on a boundary when swinging left from its left-most corner
 * leaves the mesh: the fan around it does not close.
 *
 * The traversal turns on this — an interior vertex is walked around, a
 * boundary one is not — so getting it wrong reorders the attribute values and
 * quietly hands every vertex its neighbour's position.
 */
static int d_is_on_position_boundary(Draco *d, i32 vert_id) {
    if (vert_id < 0 || (u32)vert_id >= d->num_verts) return 1;
    i32 corner = d->vertex_corners[vert_id];
    if (corner < 0) return 1;
    return d_swing_left(d, D_MESH_TABLE, corner) < 0;
}

/** The same within one attribute's table, where a seam is a boundary too. */
static int d_is_on_attribute_boundary(Draco *d, i32 att_dec, i32 vert) {
    i32 table = d_attr_table(d, att_dec);
    if (table < 0) return d_is_on_position_boundary(d, vert);
    DAttrData *ad = &d->attr_data[table];
    i32 corner = (vert >= 0 && ad->vertex_to_left_most_corner)
        ? ad->vertex_to_left_most_corner[vert] : -1;
    if (corner < 0) return 1;
    return d_attr_swing_left(d, (u32)table, corner) < 0;
}


/** The depth-first traversal that fixes the order attribute values were coded in. */
static void d_traverser_process_corner(Draco *d, i32 corner_id, int attribute_pass) {
    i32 att_dec = d->curr_att_dec;
    i32 face = corner_id / 3;
    if (d_is_face_visited(d, face)) return;

    d->corner_stack_size = 0;
    d->corner_traversal_stack[d->corner_stack_size++] = corner_id;
    i32 v, next_vert, prev_vert;
    d_corner_to_verts(d, att_dec, corner_id, &v, &next_vert, &prev_vert);
    if (next_vert >= 0 && !d->is_vertex_visited[next_vert]) {
        d->is_vertex_visited[next_vert] = 1;
        d_on_new_vertex_visited(d, next_vert, d_next(corner_id));
    }
    if (prev_vert >= 0 && !d->is_vertex_visited[prev_vert]) {
        d->is_vertex_visited[prev_vert] = 1;
        d_on_new_vertex_visited(d, prev_vert, d_previous(corner_id));
    }

    while (d->corner_stack_size > 0) {
        corner_id = d->corner_traversal_stack[d->corner_stack_size - 1];
        i32 face_id = corner_id / 3;
        if (corner_id < 0 || d_is_face_visited(d, face_id)) {
            d->corner_stack_size--;
            continue;
        }
        for (;;) {
            face_id = corner_id / 3;
            d->is_face_visited[face_id] = 1;
            i32 vert_id = d_corner_to_vert(d, att_dec, corner_id);
            if (vert_id >= 0 && !d->is_vertex_visited[vert_id]) {
                int on_boundary = attribute_pass
                    ? d_is_on_attribute_boundary(d, att_dec, vert_id)
                    : d_is_on_position_boundary(d, vert_id);
                d->is_vertex_visited[vert_id] = 1;
                d_on_new_vertex_visited(d, vert_id, corner_id);
                if (d->error) return;
                if (!on_boundary) {
                    corner_id = d_get_right_corner(d, corner_id);
                    if (corner_id < 0) break;
                    continue;
                }
            }
            i32 right_corner_id, left_corner_id;
            if (attribute_pass) {
                /* An attribute stops at its seams even where the mesh goes on. */
                int right_seam = d_is_corner_opposite_to_seam(d, att_dec, d_next(corner_id));
                right_corner_id = right_seam ? -1 : d_get_right_corner(d, corner_id);
                int left_seam = d_is_corner_opposite_to_seam(d, att_dec, d_previous(corner_id));
                left_corner_id = left_seam ? -1 : d_get_left_corner(d, corner_id);
            } else {
                right_corner_id = d_get_right_corner(d, corner_id);
                left_corner_id = d_get_left_corner(d, corner_id);
            }
            i32 right_face_id = right_corner_id < 0 ? -1 : right_corner_id / 3;
            i32 left_face_id = left_corner_id < 0 ? -1 : left_corner_id / 3;
            if (d_is_face_visited(d, right_face_id)) {
                if (d_is_face_visited(d, left_face_id)) {
                    d->corner_stack_size--;     /* both sides done */
                    break;
                }
                corner_id = left_corner_id;
            } else {
                if (d_is_face_visited(d, left_face_id)) {
                    corner_id = right_corner_id;
                } else {
                    /* Both sides open: the split is taken right first, with
                     * the left kept underneath it for afterwards. */
                    if (d->corner_stack_size >= d->num_corners) { d->error = D_ERR_CORRUPT; return; }
                    d->corner_traversal_stack[d->corner_stack_size - 1] = left_corner_id;
                    d->corner_traversal_stack[d->corner_stack_size++] = right_corner_id;
                    break;
                }
            }
        }
    }
}

static void d_add_corner_to_traversal_stack(Draco *d, i32 ci, i32 priority) {
    d->traversal_stacks[priority][d->traversal_stack_size[priority]++] = ci;
    if (priority < d->best_priority) d->best_priority = priority;
}

static i32 d_compute_priority(Draco *d, i32 corner_id) {
    i32 v_tip, next_vert, prev_vert;
    d_corner_to_verts(d, d->curr_att_dec, corner_id, &v_tip, &next_vert, &prev_vert);
    i32 priority = 0;
    if (v_tip >= 0 && !d->is_vertex_visited[v_tip]) {
        i32 degree = ++d->prediction_degree[v_tip];
        priority = degree > 1 ? 1 : 2;
    }
    if (priority >= D_MAX_PRIORITY) priority = D_MAX_PRIORITY - 1;
    return priority;
}

static i32 d_pop_next_corner_to_traverse(Draco *d) {
    for (i32 i = d->best_priority; i < D_MAX_PRIORITY; i++) {
        if (d->traversal_stack_size[i] > 0) {
            i32 ret = d->traversal_stacks[i][--d->traversal_stack_size[i]];
            d->best_priority = i;
            return ret;
        }
    }
    return -1;
}

/** The other traversal order: corners whose tip is nearly surrounded come first. */
static void d_prediction_degree_traverse(Draco *d, i32 corner_id) {
    i32 att_dec = d->curr_att_dec;
    if (d_is_face_visited(d, corner_id / 3)) return;

    d->traversal_stacks[0][d->traversal_stack_size[0]++] = corner_id;
    d->best_priority = 0;

    i32 tip_vertex, next_vert, prev_vert;
    d_corner_to_verts(d, att_dec, corner_id, &tip_vertex, &next_vert, &prev_vert);
    if (next_vert >= 0 && !d->is_vertex_visited[next_vert]) {
        d->is_vertex_visited[next_vert] = 1;
        d_on_new_vertex_visited(d, next_vert, d_next(corner_id));
    }
    if (prev_vert >= 0 && !d->is_vertex_visited[prev_vert]) {
        d->is_vertex_visited[prev_vert] = 1;
        d_on_new_vertex_visited(d, prev_vert, d_previous(corner_id));
    }
    if (tip_vertex >= 0 && !d->is_vertex_visited[tip_vertex]) {
        d->is_vertex_visited[tip_vertex] = 1;
        d_on_new_vertex_visited(d, tip_vertex, corner_id);
    }

    while ((corner_id = d_pop_next_corner_to_traverse(d)) >= 0) {
        if (d_is_face_visited(d, corner_id / 3)) continue;
        for (;;) {
            i32 face_id = corner_id / 3;
            d->is_face_visited[face_id] = 1;
            i32 vert_id;
            d_corner_to_verts(d, att_dec, corner_id, &vert_id, &next_vert, &prev_vert);
            if (vert_id >= 0 && !d->is_vertex_visited[vert_id]) {
                d->is_vertex_visited[vert_id] = 1;
                d_on_new_vertex_visited(d, vert_id, corner_id);
                if (d->error) return;
            }
            i32 right_corner_id = d_get_right_corner(d, corner_id);
            i32 left_corner_id = d_get_left_corner(d, corner_id);
            i32 right_face_id = right_corner_id < 0 ? -1 : right_corner_id / 3;
            i32 left_face_id = left_corner_id < 0 ? -1 : left_corner_id / 3;
            int is_right_visited = d_is_face_visited(d, right_face_id);
            int is_left_visited = d_is_face_visited(d, left_face_id);
            int descended = 0;
            if (!is_left_visited) {
                i32 priority = d_compute_priority(d, left_corner_id);
                if (is_right_visited && priority <= d->best_priority) {
                    corner_id = left_corner_id;
                    descended = 1;
                } else {
                    d_add_corner_to_traversal_stack(d, left_corner_id, priority);
                }
            }
            if (!descended && !is_right_visited) {
                i32 priority = d_compute_priority(d, right_corner_id);
                if (priority <= d->best_priority) {
                    corner_id = right_corner_id;
                    descended = 1;
                } else {
                    d_add_corner_to_traversal_stack(d, right_corner_id, priority);
                }
            }
            if (!descended) break;
        }
    }
}

static void d_generate_sequence(Draco *d) {
    DAttDecoder *ad = &d->att_dec[d->curr_att_dec];
    ad->value_count = 0;
    if (d->encoder_method != D_MESH_EDGEBREAKER) {
        for (u32 i = 0; i < d->num_points; i++) {
            ad->value_index_to_corner[i] = (i32)i;
            ad->vertex_to_value_index[i] = (i32)i;
        }
        ad->value_count = d->num_points;
        return;
    }
    if (ad->traversal_method == D_TRAVERSAL_PREDICTION_DEGREE) {
        for (u32 i = 0; i < d->num_corners; i++) d->prediction_degree[i] = 0;
        for (i32 i = 0; i < D_MAX_PRIORITY; i++) d->traversal_stack_size[i] = 0;
        d->best_priority = 0;
    }
    for (u32 i = 0; i < d->num_faces; i++) {
        if (ad->traversal_method == D_TRAVERSAL_DEPTH_FIRST) {
            /* A decoder with its own table follows that attribute's seams;
             * one without walks the mesh itself. */
            d_traverser_process_corner(d, (i32)(3u * i),
                                       d_attr_table(d, d->curr_att_dec) >= 0);
        } else {
            d_prediction_degree_traverse(d, (i32)(3u * i));
        }
        if (d->error) return;
    }
}

static void d_update_point_to_attribute_index_mapping(Draco *d) {
    DAttDecoder *ad = &d->att_dec[d->curr_att_dec];
    for (u32 i = 0; i < d->num_points; i++) ad->indices_map[i] = -1;
    for (u32 f = 0; f < d->num_faces; f++) {
        for (u32 p = 0; p < 3; p++) {
            i32 corner = (i32)(f * 3u + p);
            i32 point_id = d->corner_to_point_map[corner];
            if (point_id < 0 || (u32)point_id >= d->num_points) continue;
            i32 vert, next, prev;
            d_corner_to_verts(d, d->curr_att_dec, corner, &vert, &next, &prev);
            if (vert < 0) continue;
            ad->indices_map[point_id] = ad->vertex_to_value_index[vert];
        }
    }
}

/* ---------------------------------------------------------- prediction */

static u32 d_num_components(Draco *d) {
    DAttribute *a = &d->att_dec[d->curr_att_dec].attributes[d->curr_att];
    /* Octahedral normals are always a pair, whatever the attribute declares. */
    if (a->decoder_type == D_SEQ_NORMALS) return 2;
    return a->num_components;
}

static void d_wrap_compute_original(Draco *d, const i32 *pred, const i32 *corr, i32 *out) {
    DAttribute *a = &d->att_dec[d->curr_att_dec].attributes[d->curr_att];
    u32 nc = d_num_components(d);
    i32 min = a->wrap_min, max = a->wrap_max;
    i32 max_dif = 1 + max - min;
    for (u32 i = 0; i < nc; i++) {
        i32 clamped = pred[i];
        if (clamped > max) clamped = max;
        else if (clamped < min) clamped = min;
        i32 value = clamped + corr[i];
        if (value > max) value -= max_dif;
        else if (value < min) value += max_dif;
        out[i] = value;
    }
}

static i32 d_mod_max(i32 x, i32 center, i32 max_quantized) {
    if (x > center) return x - max_quantized;
    if (x < -center) return x + max_quantized;
    return x;
}

static void d_invert_diamond(i32 *s_io, i32 *t_io, i32 center) {
    i32 s = *s_io, t = *t_io;
    i32 sign_s, sign_t;
    if (s >= 0 && t >= 0) { sign_s = 1; sign_t = 1; }
    else if (s <= 0 && t <= 0) { sign_s = -1; sign_t = -1; }
    else { sign_s = s > 0 ? 1 : -1; sign_t = t > 0 ? 1 : -1; }
    i32 corner_s = sign_s * center;
    i32 corner_t = sign_t * center;
    s = 2 * s - corner_s;
    t = 2 * t - corner_t;
    i32 temp;
    if (sign_s * sign_t >= 0) { temp = s; s = -t; t = -temp; }
    else { temp = s; s = t; t = temp; }
    *s_io = (s + corner_s) / 2;
    *t_io = (t + corner_t) / 2;
}

static i32 d_rotation_count(const i32 *pred) {
    i32 sign_x = pred[0], sign_y = pred[1];
    if (sign_x == 0) {
        if (sign_y == 0) return 0;
        return sign_y > 0 ? 3 : 1;
    }
    if (sign_x > 0) return sign_y >= 0 ? 2 : 1;
    return sign_y <= 0 ? 0 : 3;
}

static void d_rotate_point(const i32 *p, i32 rotation_count, i32 *out) {
    switch (rotation_count) {
    case 1: out[0] = p[1]; out[1] = -p[0]; return;
    case 2: out[0] = -p[0]; out[1] = -p[1]; return;
    case 3: out[0] = -p[1]; out[1] = p[0]; return;
    default: out[0] = p[0]; out[1] = p[1]; return;
    }
}

static int d_is_in_bottom_left(const i32 *p) {
    if (p[0] == 0 && p[1] == 0) return 1;
    return p[0] < 0 && p[1] <= 0;
}

static int d_most_significant_bit(i32 n) {
    int msb = -1;
    while (n != 0) { msb++; n >>= 1; }
    return msb;
}

static void d_octahedron_compute_original(Draco *d, const i32 *pred_vals,
                                          const i32 *corr_vals, i32 *out) {
    DAttribute *a = &d->att_dec[d->curr_att_dec].attributes[d->curr_att];
    int bits = d_most_significant_bit(a->normal_max_q_val) + 1;
    i32 max_quantized = (1 << bits) - 1;
    i32 max_value = max_quantized - 1;
    i32 center = max_value / 2;

    i32 pred[2] = { pred_vals[0] - center, pred_vals[1] - center };
    int in_diamond = (pred[0] < 0 ? -pred[0] : pred[0])
                   + (pred[1] < 0 ? -pred[1] : pred[1]) <= center;
    if (!in_diamond) d_invert_diamond(&pred[0], &pred[1], center);
    int in_bottom_left = d_is_in_bottom_left(pred);
    i32 rotation = d_rotation_count(pred);
    if (!in_bottom_left) {
        i32 rotated[2];
        d_rotate_point(pred, rotation, rotated);
        pred[0] = rotated[0];
        pred[1] = rotated[1];
    }
    i32 orig[2] = { pred[0] + corr_vals[0], pred[1] + corr_vals[1] };
    orig[0] = d_mod_max(orig[0], center, max_quantized);
    orig[1] = d_mod_max(orig[1], center, max_quantized);
    if (!in_bottom_left) {
        i32 rotated[2];
        d_rotate_point(orig, (4 - rotation) % 4, rotated);
        orig[0] = rotated[0];
        orig[1] = rotated[1];
    }
    if (!in_diamond) d_invert_diamond(&orig[0], &orig[1], center);
    out[0] = orig[0] + center;
    out[1] = orig[1] + center;
}

static void d_transform_compute_original(Draco *d, const i32 *pred, const i32 *corr, i32 *out) {
    DAttribute *a = &d->att_dec[d->curr_att_dec].attributes[d->curr_att];
    if (a->transform_type == D_TRANSFORM_NORMAL_OCT_CANON) {
        d_octahedron_compute_original(d, pred, corr, out);
    } else {
        d_wrap_compute_original(d, pred, corr, out);
    }
}

/** The parallelogram rule: the fourth corner of three already decoded. */
static int d_compute_parallelogram_prediction(Draco *d, i32 data_entry_id, i32 ci,
                                              const i32 *in_data, u32 nc, i32 *out) {
    i32 att_dec = d->curr_att_dec;
    i32 oci = d_opposite(d, att_dec, ci);
    if (oci < 0) return 0;
    DAttDecoder *ad = &d->att_dec[att_dec];
    i32 v, n, p;
    d_corner_to_verts(d, att_dec, oci, &v, &n, &p);
    if (v < 0 || n < 0 || p < 0) return 0;
    i32 vert_opp = ad->vertex_to_value_index[v];
    i32 vert_next = ad->vertex_to_value_index[n];
    i32 vert_prev = ad->vertex_to_value_index[p];
    if (vert_opp < data_entry_id && vert_next < data_entry_id && vert_prev < data_entry_id
        && vert_opp >= 0 && vert_next >= 0 && vert_prev >= 0) {
        for (u32 c = 0; c < nc; c++) {
            out[c] = (in_data[(u32)vert_next * nc + c] + in_data[(u32)vert_prev * nc + c])
                   - in_data[(u32)vert_opp * nc + c];
        }
        return 1;
    }
    return 0;
}

static void d_prediction_difference(Draco *d, u32 num_values, const i32 *signed_values,
                                    i32 *out_values) {
    u32 nc = d_num_components(d);
    i32 zero[8] = { 0, 0, 0, 0, 0, 0, 0, 0 };
    d_transform_compute_original(d, zero, signed_values, out_values);
    for (u32 i = nc; i < nc * num_values; i += nc) {
        d_transform_compute_original(d, &out_values[i - nc], &signed_values[i], &out_values[i]);
    }
}

static void d_prediction_parallelogram(Draco *d, u32 num_values, const i32 *signed_values,
                                       i32 *out_values) {
    DAttDecoder *ad = &d->att_dec[d->curr_att_dec];
    u32 nc = d_num_components(d);
    i32 pred[8];
    for (u32 i = 0; i < nc; i++) pred[i] = 0;
    d_wrap_compute_original(d, pred, signed_values, out_values);
    for (u32 p = 1; p < num_values; p++) {
        i32 corner_id = ad->value_index_to_corner[p];
        u32 dst = p * nc;
        if (!d_compute_parallelogram_prediction(d, (i32)p, corner_id, out_values, nc, pred)) {
            d_wrap_compute_original(d, &out_values[dst - nc], &signed_values[dst], &out_values[dst]);
        } else {
            d_wrap_compute_original(d, pred, &signed_values[dst], &out_values[dst]);
        }
        if (p < 8) {
        }
    }
}

/** Several parallelograms averaged, with the creases the encoder marked left out. */
static void d_prediction_constrained_multi(Draco *d, u32 num_values,
                                           const i32 *signed_values, i32 *out_values) {
    DAttDecoder *ad = &d->att_dec[d->curr_att_dec];
    DAttribute *a = &ad->attributes[d->curr_att];
    u32 nc = d_num_components(d);
    i32 pred_vals[D_MAX_PARALLELOGRAMS][8];
    i32 multi_pred[8];
    u32 crease_pos[D_MAX_PARALLELOGRAMS] = { 0, 0, 0, 0 };

    for (u32 i = 0; i < nc; i++) pred_vals[0][i] = 0;
    d_transform_compute_original(d, pred_vals[0], signed_values, out_values);

    for (u32 p = 1; p < num_values; p++) {
        i32 start_corner_id = ad->value_index_to_corner[p];
        i32 corner_id = start_corner_id;
        u32 num_parallelograms = 0;
        int first_pass = 1;
        while (corner_id >= 0) {
            if (d_compute_parallelogram_prediction(d, (i32)p, corner_id, out_values, nc,
                                                   pred_vals[num_parallelograms])) {
                if (++num_parallelograms == D_MAX_PARALLELOGRAMS) break;
            }
            corner_id = first_pass ? d_swing_left(d, d->curr_att_dec, corner_id)
                                   : d_swing_right(d, d->curr_att_dec, corner_id);
            if (corner_id == start_corner_id) break;
            if (corner_id < 0 && first_pass) {
                first_pass = 0;
                corner_id = d_swing_right(d, d->curr_att_dec, start_corner_id);
            }
        }

        u32 num_used = 0;
        if (num_parallelograms > 0) {
            for (u32 i = 0; i < nc; i++) multi_pred[i] = 0;
            for (u32 i = 0; i < num_parallelograms; i++) {
                u32 context = num_parallelograms - 1u;
                u8 *creases = a->is_crease_edge[context];
                int is_crease = 0;
                if (creases && crease_pos[context] < a->crease_count[context]) {
                    is_crease = creases[crease_pos[context]];
                }
                crease_pos[context]++;
                if (is_crease) continue;
                num_used++;
                for (u32 j = 0; j < nc; j++) multi_pred[j] += pred_vals[i][j];
            }
        }
        u32 dst = p * nc;
        if (num_used == 0) {
            d_transform_compute_original(d, &out_values[dst - nc], &signed_values[dst],
                                         &out_values[dst]);
        } else {
            for (u32 c = 0; c < nc; c++) multi_pred[c] /= (i32)num_used;
            d_transform_compute_original(d, multi_pred, &signed_values[dst], &out_values[dst]);
        }
    }
}

static u64 d_int_sqrt(u64 number) {
    if (number == 0) return 0;
    u64 act_number = number;
    u64 square_root = 1;
    while (act_number >= 2) {
        square_root *= 2;
        act_number /= 4;
    }
    do {
        square_root = (square_root + number / square_root) / 2;
    } while (square_root * square_root > number);
    return square_root;
}

/** The position of an attribute entry, in the portable integer space. */
static void d_position_for_entry(Draco *d, i32 entry_id, i64 *pos) {
    DAttDecoder *ad = &d->att_dec[d->curr_att_dec];
    i32 corner = ad->value_index_to_corner[entry_id];
    i32 point_id = (corner >= 0 && (u32)corner < d->num_corners)
        ? d->corner_to_point_map[corner] : -1;
    i32 mapped = -1;
    if (d->pos_att_dec < 0) { pos[0] = pos[1] = pos[2] = 0; return; }
    DAttDecoder *pos_dec = &d->att_dec[d->pos_att_dec];
    if (d->encoder_method == D_MESH_EDGEBREAKER) {
        if (point_id >= 0 && (u32)point_id < d->num_points && pos_dec->indices_map) {
            mapped = pos_dec->indices_map[point_id];
        }
    } else {
        mapped = entry_id;
    }
    const i32 *pos_orig = pos_dec->attributes[d->pos_att].values;
    if (mapped < 0 || !pos_orig) { pos[0] = pos[1] = pos[2] = 0; return; }
    for (int i = 0; i < 3; i++) pos[i] = pos_orig[mapped * 3 + i];
}

/** Texture coordinates predicted by unfolding the neighbouring triangle. */
static void d_prediction_tex_coords(Draco *d, u32 num_values, const i32 *signed_values,
                                    i32 *out_values) {
    DAttDecoder *ad = &d->att_dec[d->curr_att_dec];
    DAttribute *a = &ad->attributes[d->curr_att];
    u32 nc = 2;
    i32 predicted[2];

    for (u32 p = 0; p < num_values; p++) {
        i32 corner_id = ad->value_index_to_corner[p];
        i32 vert_id, next_vert_id, prev_vert_id;
        d_corner_to_verts(d, d->curr_att_dec, corner_id, &vert_id, &next_vert_id, &prev_vert_id);
        i32 next_data_id = next_vert_id >= 0 ? ad->vertex_to_value_index[next_vert_id] : -1;
        i32 prev_data_id = prev_vert_id >= 0 ? ad->vertex_to_value_index[prev_vert_id] : -1;

        int done = 0;
        if (prev_data_id >= 0 && next_data_id >= 0
            && prev_data_id < (i32)p && next_data_id < (i32)p) {
            i64 n_uv[2] = { out_values[next_data_id * 2], out_values[next_data_id * 2 + 1] };
            i64 p_uv[2] = { out_values[prev_data_id * 2], out_values[prev_data_id * 2 + 1] };
            if (p_uv[0] == n_uv[0] && p_uv[1] == n_uv[1]) {
                predicted[0] = (i32)p_uv[0];
                predicted[1] = (i32)p_uv[1];
                done = 1;
            } else {
                i64 tip_pos[3], next_pos[3], prev_pos[3];
                d_position_for_entry(d, (i32)p, tip_pos);
                d_position_for_entry(d, next_data_id, next_pos);
                d_position_for_entry(d, prev_data_id, prev_pos);
                i64 pn[3], cn[3];
                for (int i = 0; i < 3; i++) pn[i] = prev_pos[i] - next_pos[i];
                i64 pn_norm2 = pn[0] * pn[0] + pn[1] * pn[1] + pn[2] * pn[2];
                if (pn_norm2 != 0) {
                    for (int i = 0; i < 3; i++) cn[i] = tip_pos[i] - next_pos[i];
                    i64 cn_dot_pn = cn[0] * pn[0] + cn[1] * pn[1] + cn[2] * pn[2];
                    i64 pn_uv[2] = { p_uv[0] - n_uv[0], p_uv[1] - n_uv[1] };
                    i64 x_uv[2] = {
                        pn_uv[0] * cn_dot_pn + n_uv[0] * pn_norm2,
                        pn_uv[1] * cn_dot_pn + n_uv[1] * pn_norm2,
                    };
                    i64 x_pos[3];
                    for (int i = 0; i < 3; i++) x_pos[i] = next_pos[i] + (pn[i] * cn_dot_pn) / pn_norm2;
                    i64 cx[3];
                    for (int i = 0; i < 3; i++) cx[i] = tip_pos[i] - x_pos[i];
                    i64 cx_norm2 = cx[0] * cx[0] + cx[1] * cx[1] + cx[2] * cx[2];
                    i64 temp[2] = { pn_uv[1], -pn_uv[0] };
                    i64 norm = (i64)d_int_sqrt((u64)(cx_norm2 * pn_norm2));
                    i64 cx_uv[2] = { temp[0] * norm, temp[1] * norm };
                    int orientation = 1;
                    if (a->num_orientations > 0) {
                        orientation = a->orientations[--a->num_orientations];
                    }
                    i64 sum[2];
                    if (orientation) {
                        sum[0] = x_uv[0] + cx_uv[0];
                        sum[1] = x_uv[1] + cx_uv[1];
                    } else {
                        sum[0] = x_uv[0] - cx_uv[0];
                        sum[1] = x_uv[1] - cx_uv[1];
                    }
                    predicted[0] = (i32)(sum[0] / pn_norm2);
                    predicted[1] = (i32)(sum[1] / pn_norm2);
                    done = 1;
                }
            }
        }
        if (!done) {
            i32 data_offset = 0;
            int have = 0;
            if (prev_data_id >= 0 && prev_data_id < (i32)p) {
                data_offset = prev_data_id * (i32)nc;
                have = 1;
            }
            if (next_data_id >= 0 && next_data_id < (i32)p) {
                data_offset = next_data_id * (i32)nc;
                have = 1;
            } else if (p > 0) {
                data_offset = (i32)(p - 1) * (i32)nc;
                have = 1;
            }
            if (!have) {
                predicted[0] = 0;
                predicted[1] = 0;
            } else {
                predicted[0] = out_values[data_offset];
                predicted[1] = out_values[data_offset + 1];
            }
        }
        u32 dst = p * nc;
        d_wrap_compute_original(d, predicted, &out_values[dst], &out_values[dst]);
    }
}

/** Normals predicted from the faces around a corner, then re-quantized. */
static void d_prediction_geometric_normal(Draco *d, u32 num_values,
                                          const i32 *signed_values, i32 *out_values) {
    DAttDecoder *ad = &d->att_dec[d->curr_att_dec];
    DAttribute *a = &ad->attributes[d->curr_att];
    int bits = d_most_significant_bit(a->normal_max_q_val) + 1;
    i32 max_quantized = (1 << bits) - 1;
    i32 max_value = max_quantized - 1;
    i32 center = max_value / 2;

    for (u32 data_id = 0; data_id < num_values; data_id++) {
        i32 corner_id = ad->value_index_to_corner[data_id];
        /* The area-weighted sum of the normals of every face around the corner. */
        i64 normal[3] = { 0, 0, 0 };
        i64 pos_cent[3];
        {
            i32 v, n, p;
            d_corner_to_verts(d, d->curr_att_dec, corner_id, &v, &n, &p);
            i32 data = v >= 0 ? ad->vertex_to_value_index[v] : -1;
            if (data >= 0) d_position_for_entry(d, data, pos_cent);
            else pos_cent[0] = pos_cent[1] = pos_cent[2] = 0;
        }
        i32 corner = corner_id;
        i32 start_corner = corner;
        int left_traversal = 1;
        while (corner >= 0) {
            i64 pos_next[3], pos_prev[3];
            {
                i32 v, n, p;
                d_corner_to_verts(d, d->curr_att_dec, d_next(corner), &v, &n, &p);
                i32 data = v >= 0 ? ad->vertex_to_value_index[v] : -1;
                if (data >= 0) d_position_for_entry(d, data, pos_next);
                else pos_next[0] = pos_next[1] = pos_next[2] = 0;
                d_corner_to_verts(d, d->curr_att_dec, d_previous(corner), &v, &n, &p);
                data = v >= 0 ? ad->vertex_to_value_index[v] : -1;
                if (data >= 0) d_position_for_entry(d, data, pos_prev);
                else pos_prev[0] = pos_prev[1] = pos_prev[2] = 0;
            }
            i64 delta_next[3], delta_prev[3];
            for (int i = 0; i < 3; i++) {
                delta_next[i] = pos_next[i] - pos_cent[i];
                delta_prev[i] = pos_prev[i] - pos_cent[i];
            }
            normal[0] += delta_next[1] * delta_prev[2] - delta_next[2] * delta_prev[1];
            normal[1] += delta_next[2] * delta_prev[0] - delta_next[0] * delta_prev[2];
            normal[2] += delta_next[0] * delta_prev[1] - delta_next[1] * delta_prev[0];

            if (left_traversal) {
                corner = d_swing_left(d, d->curr_att_dec, corner);
                if (corner < 0) {
                    corner = d_swing_right(d, d->curr_att_dec, start_corner);
                    left_traversal = 0;
                } else if (corner == start_corner) {
                    corner = -1;
                }
            } else {
                corner = d_swing_right(d, d->curr_att_dec, corner);
                if (corner == start_corner) corner = -1;
            }
        }

        i64 abs_sum = 0;
        for (int i = 0; i < 3; i++) abs_sum += normal[i] < 0 ? -normal[i] : normal[i];
        i64 upper_bound = 1 << 29;
        if (abs_sum > upper_bound) {
            i64 quotient = abs_sum / upper_bound;
            for (int i = 0; i < 3; i++) normal[i] /= quotient;
        }

        i32 pred3[3] = { (i32)normal[0], (i32)normal[1], (i32)normal[2] };
        /* CanonicalizeIntegerVector: onto the octahedron's surface. */
        i32 sum = 0;
        for (int i = 0; i < 3; i++) sum += pred3[i] < 0 ? -pred3[i] : pred3[i];
        if (sum == 0) {
            pred3[0] = center;
            pred3[1] = 0;
            pred3[2] = 0;
        } else {
            pred3[0] = (i32)(((i64)pred3[0] * center) / sum);
            pred3[1] = (i32)(((i64)pred3[1] * center) / sum);
            i32 abs01 = (pred3[0] < 0 ? -pred3[0] : pred3[0])
                      + (pred3[1] < 0 ? -pred3[1] : pred3[1]);
            pred3[2] = pred3[2] >= 0 ? center - abs01 : -(center - abs01);
        }
        if (a->flip_normal_bits && a->flip_normal_bits[data_id]) {
            for (int i = 0; i < 3; i++) pred3[i] = -pred3[i];
        }

        /* IntegerVectorToQuantizedOctahedralCoords. */
        i32 s, t;
        if (pred3[0] >= 0) {
            s = pred3[1] + center;
            t = pred3[2] + center;
        } else {
            i32 abs1 = pred3[1] < 0 ? -pred3[1] : pred3[1];
            i32 abs2 = pred3[2] < 0 ? -pred3[2] : pred3[2];
            s = pred3[1] < 0 ? abs2 : max_value - abs2;
            t = pred3[2] < 0 ? abs1 : max_value - abs1;
        }
        /* CanonicalizeOctahedralCoords. */
        if ((s == 0 && t == 0) || (s == 0 && t == max_value) || (s == max_value && t == 0)) {
            s = max_value;
            t = max_value;
        } else if (s == 0 && t > center) {
            t = center - (t - center);
        } else if (s == max_value && t < center) {
            t = center + (center - t);
        } else if (t == max_value && s < center) {
            s = center + (center - s);
        } else if (t == 0 && s > center) {
            s = center - (s - center);
        }

        i32 pred_oct[2] = { s, t };
        u32 dst = data_id * 2u;
        d_octahedron_compute_original(d, pred_oct, &out_values[dst], &out_values[dst]);
    }
    (void)signed_values;
    (void)max_quantized;
}

/* ------------------------------------------------- attribute decoding */

static void d_parse_prediction_rans_data(Draco *d, u8 *prob_zero, DBuf *out) {
    *prob_zero = db_u8(&d->buf);
    if (!d_take_buffer(d, out, 0)) return;
}

static void d_decode_prediction_data(Draco *d, i32 method) {
    DAttribute *a = &d->att_dec[d->curr_att_dec].attributes[d->curr_att];
    DBuf rans_buf;
    u8 prob_zero = 0;

    if (method == D_PRED_CONSTRAINED_MULTI) {
        for (u32 i = 0; i < D_MAX_PARALLELOGRAMS; i++) {
            u32 num_flags = db_varu32(&d->buf);
            a->crease_count[i] = num_flags;
            a->is_crease_edge[i] = NULL;
            if (num_flags == 0) continue;
            if (num_flags > d->num_corners + 1u) { d->error = D_ERR_CORRUPT; return; }
            d_parse_prediction_rans_data(d, &prob_zero, &rans_buf);
            if (d->error) return;
            a->is_crease_edge[i] = (u8 *)heap_alloc(num_flags);
            if (!a->is_crease_edge[i]) { d->error = D_ERR_MEMORY; return; }
            Rans ans;
            if (!rans_init(&ans, rans_buf.data, rans_buf.size, D_L_RANS_BASE)) {
                d->error = D_ERR_CORRUPT;
                return;
            }
            for (u32 j = 0; j < num_flags; j++) {
                a->is_crease_edge[i][j] = (u8)rabs_desc_read(&ans, prob_zero);
            }
        }
    } else if (method == D_PRED_TEX_COORDS_PORTABLE) {
        u32 num_orientations = db_u32(&d->buf);
        if (d->buf.failed || num_orientations > d->num_corners + 1u) {
            d->error = D_ERR_CORRUPT;
            return;
        }
        d_parse_prediction_rans_data(d, &prob_zero, &rans_buf);
        if (d->error) return;
        a->orientations = (u8 *)heap_alloc(num_orientations + 1u);
        if (!a->orientations) { d->error = D_ERR_MEMORY; return; }
        Rans ans;
        if (!rans_init(&ans, rans_buf.data, rans_buf.size, D_L_RANS_BASE)) {
            d->error = D_ERR_CORRUPT;
            return;
        }
        int last_orientation = 1;
        for (u32 i = 0; i < num_orientations; i++) {
            if (rabs_desc_read(&ans, prob_zero) == 0) last_orientation = !last_orientation;
            a->orientations[i] = (u8)last_orientation;
        }
        a->num_orientations = num_orientations;
    } else if (method == D_PRED_GEOMETRIC_NORMAL) {
        /* The transform data comes first for this one. */
        if (a->transform_type == D_TRANSFORM_NORMAL_OCT_CANON) {
            a->normal_max_q_val = db_i32(&d->buf);
            (void)db_i32(&d->buf);          /* unused centre value */
        } else if (a->transform_type == D_TRANSFORM_WRAP) {
            a->wrap_min = db_i32(&d->buf);
            a->wrap_max = db_i32(&d->buf);
        }
        d_parse_prediction_rans_data(d, &prob_zero, &rans_buf);
        if (d->error) return;
        a->flip_normal_bits = (u8 *)heap_alloc(a->num_values + 1u);
        if (!a->flip_normal_bits) { d->error = D_ERR_MEMORY; return; }
        Rans ans;
        if (!rans_init(&ans, rans_buf.data, rans_buf.size, D_L_RANS_BASE)) {
            d->error = D_ERR_CORRUPT;
            return;
        }
        for (u32 i = 0; i < a->num_values; i++) {
            a->flip_normal_bits[i] = (u8)rabs_desc_read(&ans, prob_zero);
        }
    }

    if (method != D_PRED_GEOMETRIC_NORMAL) {
        if (a->transform_type == D_TRANSFORM_WRAP) {
            a->wrap_min = db_i32(&d->buf);
            a->wrap_max = db_i32(&d->buf);
        } else if (a->transform_type == D_TRANSFORM_NORMAL_OCT_CANON) {
            a->normal_max_q_val = db_i32(&d->buf);
            (void)db_i32(&d->buf);
        }
    }
    if (d->buf.failed) d->error = D_ERR_TRUNCATED;
}

static void d_decode_integer_values(Draco *d) {
    DAttDecoder *ad = &d->att_dec[d->curr_att_dec];
    DAttribute *a = &ad->attributes[d->curr_att];
    u32 nc = d_num_components(d);
    u32 num_entries = a->num_values;
    u32 num_values = num_entries * nc;

    a->symbols = (u32 *)heap_alloc((num_values + 1u) * 4u);
    a->signed_values = (i32 *)heap_alloc((num_values + 1u) * 4u);
    a->values = (i32 *)heap_alloc((num_values + 1u) * 4u);
    if (!a->symbols || !a->signed_values || !a->values) { d->error = D_ERR_MEMORY; return; }
    mem_zero(a->symbols, (num_values + 1u) * 4u);

    if (a->compressed > 0) {
        if (!decode_symbols(&d->buf, num_values, nc, a->symbols)) {
            d->error = D_ERR_CORRUPT;
            return;
        }
    } else {
        /* Written straight out, in as many bytes as the values need. */
        u32 bytes = 0;
        u8 size = db_u8(&d->buf);
        bytes = size;
        for (u32 i = 0; i < num_values; i++) {
            u32 v = 0;
            for (u32 k = 0; k < bytes; k++) v |= (u32)db_u8(&d->buf) << (8u * k);
            a->symbols[i] = v;
        }
        if (d->buf.failed) { d->error = D_ERR_TRUNCATED; return; }
    }

    if (num_values > 0) {
        if (a->transform_type == D_TRANSFORM_NORMAL_OCT_CANON) {
            /* Octahedral corrections are already signed the way they are used. */
            for (u32 i = 0; i < num_values; i++) a->signed_values[i] = (i32)a->symbols[i];
        } else {
            for (u32 i = 0; i < num_values; i++) {
                u32 val = a->symbols[i];
                int positive = !(val & 1u);
                val >>= 1;
                a->signed_values[i] = positive ? (i32)val : -(i32)val - 1;
            }
        }
    }

    for (u32 i = 0; i < num_values; i++) a->values[i] = a->signed_values[i];

    if (a->prediction_scheme != D_PRED_NONE) {
        d_decode_prediction_data(d, a->prediction_scheme);
        if (d->error) return;
        switch (a->prediction_scheme) {
        case D_PRED_DIFFERENCE:
            d_prediction_difference(d, num_entries, a->signed_values, a->values);
            break;
        case D_PRED_PARALLELOGRAM:
            d_prediction_parallelogram(d, num_entries, a->signed_values, a->values);
            break;
        case D_PRED_CONSTRAINED_MULTI:
            d_prediction_constrained_multi(d, num_entries, a->signed_values, a->values);
            break;
        case D_PRED_TEX_COORDS_PORTABLE:
            d_prediction_tex_coords(d, num_entries, a->signed_values, a->values);
            break;
        case D_PRED_GEOMETRIC_NORMAL:
            d_prediction_geometric_normal(d, num_entries, a->signed_values, a->values);
            break;
        default:
            d->error = D_ERR_UNSUPPORTED;
            return;
        }
    }
}

static void d_decode_portable_attributes(Draco *d) {
    DAttDecoder *ad = &d->att_dec[d->curr_att_dec];
    for (u32 i = 0; i < ad->num_attributes; i++) {
        d->curr_att = i;
        DAttribute *a = &ad->attributes[i];
        a->prediction_scheme = (i8)db_u8(&d->buf);
        if (a->prediction_scheme != D_PRED_NONE) {
            a->transform_type = (i8)db_u8(&d->buf);
            a->compressed = db_u8(&d->buf);
        }
        if (d->buf.failed) { d->error = D_ERR_TRUNCATED; return; }
        if (a->prediction_scheme != D_PRED_NONE) {
            d_decode_integer_values(d);
            if (d->error) return;
        }
    }
}

static void d_decode_data_needed_by_portable_transforms(Draco *d) {
    DAttDecoder *ad = &d->att_dec[d->curr_att_dec];
    for (u32 i = 0; i < ad->num_attributes; i++) {
        d->curr_att = i;
        DAttribute *a = &ad->attributes[i];
        if (a->decoder_type == D_SEQ_NORMALS) {
            a->quantization_bits = db_u8(&d->buf);
        } else if (a->decoder_type == D_SEQ_QUANTIZATION) {
            u32 nc = d_num_components(d);
            for (u32 j = 0; j < nc && j < 8; j++) a->min_values[j] = db_f32(&d->buf);
            a->range = db_f32(&d->buf);
            a->quantization_bits = db_u8(&d->buf);
        }
    }
    if (d->buf.failed) d->error = D_ERR_TRUNCATED;
}

static void d_octahedral_to_unit_vector(f32 in_s, f32 in_t, f32 *out) {
    f32 s = in_s, t = in_t;
    f32 spt = s + t;
    f32 smt = s - t;
    f32 x_sign = 1.0f;
    if (!(spt >= 0.5f && spt <= 1.5f && smt >= -0.5f && smt <= 0.5f)) {
        x_sign = -1.0f;
        if (spt <= 0.5f) { s = 0.5f - in_t; t = 0.5f - in_s; }
        else if (spt >= 1.5f) { s = 1.5f - in_t; t = 1.5f - in_s; }
        else if (smt <= -0.5f) { s = in_t - 0.5f; t = in_s + 0.5f; }
        else { s = in_t + 0.5f; t = in_s - 0.5f; }
        spt = s + t;
        smt = s - t;
    }
    f32 y = 2.0f * s - 1.0f;
    f32 z = 2.0f * t - 1.0f;
    f32 a = 2.0f * spt - 1.0f;
    f32 b = 3.0f - 2.0f * spt;
    f32 c = 2.0f * smt + 1.0f;
    f32 e = 1.0f - 2.0f * smt;
    f32 min1 = a < b ? a : b;
    f32 min2 = c < e ? c : e;
    f32 x = (min1 < min2 ? min1 : min2) * x_sign;
    f32 norm2 = x * x + y * y + z * z;
    if (norm2 < 1e-6f) {
        out[0] = out[1] = out[2] = 0.0f;
    } else {
        f32 inv = 1.0f / __builtin_sqrtf(norm2);
        out[0] = x * inv;
        out[1] = y * inv;
        out[2] = z * inv;
    }
}

/** Back to the values the file describes: floats, dequantized or unit normals. */
static void d_transform_attributes_to_original_format(Draco *d) {
    DAttDecoder *ad = &d->att_dec[d->curr_att_dec];
    for (u32 i = 0; i < ad->num_attributes; i++) {
        d->curr_att = i;
        DAttribute *a = &ad->attributes[i];
        u32 nc = d_num_components(d);
        u32 num_values = a->num_values;

        if (a->decoder_type == D_SEQ_NORMALS) {
            a->dequantized = (f32 *)heap_alloc((num_values * 3u + 3u) * 4u);
            if (!a->dequantized) { d->error = D_ERR_MEMORY; return; }
            int bits = d_most_significant_bit(a->normal_max_q_val) + 1;
            i32 max_quantized = (1 << bits) - 1;
            f32 scale = 1.0f / (f32)(max_quantized - 1);
            for (u32 v = 0; v < num_values; v++) {
                f32 out[3];
                d_octahedral_to_unit_vector((f32)a->values[v * 2] * scale,
                                            (f32)a->values[v * 2 + 1] * scale, out);
                for (int k = 0; k < 3; k++) a->dequantized[v * 3 + k] = out[k];
            }
            a->num_components = 3;
        } else if (a->decoder_type == D_SEQ_QUANTIZATION) {
            a->dequantized = (f32 *)heap_alloc((num_values * nc + nc) * 4u);
            if (!a->dequantized) { d->error = D_ERR_MEMORY; return; }
            i32 max_quantized = (i32)((1u << a->quantization_bits) - 1u);
            /* One step, then one multiply — the order the decoder uses, which
             * is the only way to land on the same float it does. */
            f32 delta = max_quantized > 0 ? a->range / (f32)max_quantized : 0.0f;
            for (u32 v = 0; v < num_values; v++) {
                for (u32 c = 0; c < nc; c++) {
                    a->dequantized[v * nc + c] =
                        (f32)a->values[v * nc + c] * delta + a->min_values[c];
                }
            }
        } else {
            /* Already integers in their original form. */
            a->dequantized = (f32 *)heap_alloc((num_values * nc + nc) * 4u);
            if (!a->dequantized) { d->error = D_ERR_MEMORY; return; }
            for (u32 v = 0; v < num_values * nc; v++) a->dequantized[v] = (f32)a->values[v];
        }
    }
}

static void d_parse_attribute_decoders_data(Draco *d) {
    DBuf *b = &d->buf;
    d->num_att_dec = db_u8(b);
    if (b->failed) { d->error = D_ERR_TRUNCATED; return; }
    if (d->num_att_dec == 0 || d->num_att_dec > D_MAX_ATT_DEC) { d->error = D_ERR_LIMIT; return; }

    for (u32 i = 0; i < d->num_att_dec; i++) {
        DAttDecoder *ad = &d->att_dec[i];
        if (d->encoder_method == D_MESH_EDGEBREAKER) {
            ad->att_data_id = (i8)db_u8(b);
            ad->decoder_type = db_u8(b);
            ad->traversal_method = db_u8(b);
            if (ad->att_data_id >= (i32)d->num_attribute_data) { d->error = D_ERR_CORRUPT; return; }
        } else {
            ad->att_data_id = -1;
            ad->decoder_type = D_MESH_VERTEX_ATTRIBUTE;
            ad->traversal_method = D_TRAVERSAL_DEPTH_FIRST;
        }
    }
    for (u32 i = 0; i < d->num_att_dec; i++) {
    }
    for (u32 i = 0; i < d->num_att_dec; i++) {
        DAttDecoder *ad = &d->att_dec[i];
        ad->num_attributes = db_varu32(b);
        if (b->failed || ad->num_attributes > D_MAX_ATTRIBUTES) { d->error = D_ERR_LIMIT; return; }
        for (u32 j = 0; j < ad->num_attributes; j++) {
            DAttribute *a = &ad->attributes[j];
            a->att_type = db_u8(b);
            a->data_type = db_u8(b);
            a->num_components = db_u8(b);
            a->normalized = db_u8(b);
            a->unique_id = db_varu32(b);
            if (a->num_components == 0 || a->num_components > 8) { d->error = D_ERR_LIMIT; return; }
            if (a->att_type == 0 && d->pos_att_dec < 0) {   /* GeometryAttribute::POSITION */
                d->pos_att_dec = (i32)i;
                d->pos_att = j;
            }
        }
        for (u32 j = 0; j < ad->num_attributes; j++) {
            ad->attributes[j].decoder_type = db_u8(b);
        }
    }
    if (b->failed) d->error = D_ERR_TRUNCATED;
}

static void d_decode_attribute_data(Draco *d) {
    d_parse_attribute_decoders_data(d);
    if (d->error) return;

    u32 map_size = d->num_corners > d->num_verts ? d->num_corners : d->num_verts;
    map_size += 1u;

    for (u32 i = 0; i < d->num_att_dec; i++) {
        DAttDecoder *ad = &d->att_dec[i];
        ad->value_index_to_corner = (i32 *)heap_alloc((d->num_corners + 1u) * 4u);
        ad->vertex_to_value_index = (i32 *)heap_alloc(map_size * 4u);
        if (!ad->value_index_to_corner || !ad->vertex_to_value_index) {
            d->error = D_ERR_MEMORY;
            return;
        }
        for (u32 k = 0; k < map_size; k++) ad->vertex_to_value_index[k] = -1;
    }

    if (d->encoder_method == D_MESH_EDGEBREAKER) {
        d_decode_attribute_seams(d);
        if (d->error) return;
        for (u32 i = 0; i < d->num_verts; i++) {
            if (d->is_vert_hole[i]) d_update_vertex_to_corner_map(d, i);
        }
        for (u32 a = 0; a < d->num_attribute_data; a++) {
            d_recompute_vertices_internal(d, a);
            if (d->error) return;
        }
        d->corner_to_point_map = (i32 *)heap_alloc((d->num_corners + 1u) * 4u);
        if (!d->corner_to_point_map) { d->error = D_ERR_MEMORY; return; }
        d_assign_points_to_corners(d);
    }

    d->is_face_visited = (u8 *)heap_alloc(d->num_faces + 1u);
    d->is_vertex_visited = (u8 *)heap_alloc(map_size);
    d->corner_traversal_stack = (i32 *)heap_alloc((d->num_corners + 1u) * 4u);
    d->prediction_degree = (i32 *)heap_alloc(map_size * 4u);
    for (i32 i = 0; i < D_MAX_PRIORITY; i++) {
        d->traversal_stacks[i] = (i32 *)heap_alloc((d->num_corners + 1u) * 4u);
        if (!d->traversal_stacks[i]) { d->error = D_ERR_MEMORY; return; }
    }
    if (!d->is_face_visited || !d->is_vertex_visited || !d->corner_traversal_stack
        || !d->prediction_degree) {
        d->error = D_ERR_MEMORY;
        return;
    }

    for (u32 i = 0; i < d->num_att_dec; i++) {
        d->curr_att_dec = (i32)i;
        mem_zero(d->is_face_visited, d->num_faces + 1u);
        mem_zero(d->is_vertex_visited, map_size);
        d_generate_sequence(d);
        if (d->error) return;
        if (d->encoder_method == D_MESH_EDGEBREAKER) {
            d->att_dec[i].indices_map = (i32 *)heap_alloc((d->num_points + 1u) * 4u);
            if (!d->att_dec[i].indices_map) { d->error = D_ERR_MEMORY; return; }
            d_update_point_to_attribute_index_mapping(d);
        }
    }

    for (u32 i = 0; i < d->num_att_dec; i++) {
        for (u32 j = 0; j < d->att_dec[i].num_attributes; j++) {
            d->att_dec[i].attributes[j].num_values = d->att_dec[i].value_count;
        }
    }

    for (u32 i = 0; i < d->num_att_dec; i++) {
        d->curr_att_dec = (i32)i;
        d_decode_portable_attributes(d);
        if (d->error) return;
        d_decode_data_needed_by_portable_transforms(d);
        if (d->error) return;
        d_transform_attributes_to_original_format(d);
        if (d->error) return;
    }
}

/* ------------------------------------------------------------------ entry */

typedef struct {
    u32 unique_id;
    u32 num_components;
    u32 data_type;
    u32 values;        /* offset to f32[num_points * num_components] */
} DracoAttrOut;

typedef struct {
    u32 ok;
    u32 error;
    u32 num_faces;
    u32 num_points;
    u32 num_attributes;
    u32 indices;       /* offset to u32[num_faces * 3] */
    u32 attributes;    /* offset to DracoAttrOut[num_attributes] */
} DracoOut;

/**
 * Decode one Draco block into per-point attribute arrays and a triangle list —
 * which is what glTF wants back, its vertices being Draco's points.
 */
FBX_EXPORT("fbx_draco_decode") u32 fbx_draco_decode(u32 src_off, u32 src_len) {
    Draco *d = &g_draco;
    mem_zero(d, (u32)sizeof(Draco));
    d->pos_att_dec = -1;
    /* The result lives in the heap the caller reads through, not in a static:
     * only heap offsets mean anything on the other side. */
    DracoOut *out = (DracoOut *)heap_alloc((u32)sizeof(DracoOut));
    if (!out) return 0;
    mem_zero(out, (u32)sizeof(DracoOut));

    const u8 *src = (const u8 *)at_off(src_off);
    db_init(&d->buf, src, src_len);
    DBuf *b = &d->buf;

    if (src_len < 9 || src[0] != 'D' || src[1] != 'R' || src[2] != 'A'
        || src[3] != 'C' || src[4] != 'O') {
        out->error = D_ERR_MAGIC;
        return to_off(out);
    }
    b->pos = 5;
    u32 major = db_u8(b);
    u32 minor = db_u8(b);
    u32 encoder_type = db_u8(b);
    d->encoder_method = db_u8(b);
    u32 flags = db_u16(b);

    if (major != 2 || minor > 2) { out->error = D_ERR_VERSION; return to_off(out); }
    if (encoder_type != 1) { out->error = D_ERR_NOT_A_MESH; return to_off(out); }
    if (d->encoder_method != D_MESH_SEQUENTIAL && d->encoder_method != D_MESH_EDGEBREAKER) {
        out->error = D_ERR_METHOD;
        return to_off(out);
    }

    if (flags & D_METADATA_FLAG) {
        /* Metadata is names and strings for the file's own use; step over it. */
        u32 num_att_metadata = db_varu32(b);
        for (u32 i = 0; i < num_att_metadata && !b->failed; i++) {
            (void)db_varu32(b);
            /* Each element: entries of key/value, then nested elements. */
            u32 depth = 1;
            while (depth > 0 && !b->failed) {
                u32 num_entries = db_varu32(b);
                for (u32 e = 0; e < num_entries && !b->failed; e++) {
                    u32 ks = db_u8(b);
                    b->pos += ks;
                    u32 vs = db_u8(b);
                    b->pos += vs;
                }
                u32 num_sub = db_varu32(b);
                depth--;
                for (u32 s = 0; s < num_sub && !b->failed; s++) {
                    u32 ks = db_u8(b);
                    b->pos += ks;
                    depth++;
                }
                if (b->pos > b->size) b->failed = 1;
            }
        }
        /* The file-level element, in the same shape. */
        u32 depth = 1;
        while (depth > 0 && !b->failed) {
            u32 num_entries = db_varu32(b);
            for (u32 e = 0; e < num_entries && !b->failed; e++) {
                u32 ks = db_u8(b);
                b->pos += ks;
                u32 vs = db_u8(b);
                b->pos += vs;
            }
            u32 num_sub = db_varu32(b);
            depth--;
            for (u32 s = 0; s < num_sub && !b->failed; s++) {
                u32 ks = db_u8(b);
                b->pos += ks;
                depth++;
            }
            if (b->pos > b->size) b->failed = 1;
        }
        if (b->failed) { out->error = D_ERR_TRUNCATED; return to_off(out); }
    }

    if (d->encoder_method == D_MESH_EDGEBREAKER) {
        d_decode_edgebreaker_connectivity_data(d);
    } else {
        d_decode_sequential_connectivity_data(d);
    }
    if (d->error) { out->error = d->error; return to_off(out); }

    d_decode_attribute_data(d);
    if (d->error) { out->error = d->error; return to_off(out); }

    /* ---- hand back points and triangles */
    u32 total_attributes = 0;
    for (u32 i = 0; i < d->num_att_dec; i++) total_attributes += d->att_dec[i].num_attributes;

    u32 *indices = (u32 *)heap_alloc(d->num_corners * 4u);
    DracoAttrOut *out_attrs =
        (DracoAttrOut *)heap_alloc((total_attributes + 1u) * (u32)sizeof(DracoAttrOut));
    if (!indices || !out_attrs) { out->error = D_ERR_MEMORY; return to_off(out); }

    for (u32 f = 0; f < d->num_faces; f++) {
        for (u32 k = 0; k < 3; k++) {
            i32 point;
            if (d->encoder_method == D_MESH_EDGEBREAKER) {
                point = d->corner_to_point_map[f * 3u + k];
            } else {
                point = d->face_to_vertex[k][f];
            }
            indices[f * 3u + k] = point < 0 ? 0u : (u32)point;
        }
    }

    u32 at = 0;
    for (u32 i = 0; i < d->num_att_dec; i++) {
        DAttDecoder *ad = &d->att_dec[i];
        for (u32 j = 0; j < ad->num_attributes; j++) {
            d->curr_att_dec = (i32)i;
            d->curr_att = j;
            DAttribute *a = &ad->attributes[j];
            u32 nc = a->decoder_type == D_SEQ_NORMALS ? 3u : a->num_components;
            f32 *values = (f32 *)heap_alloc((d->num_points * nc + nc) * 4u);
            if (!values) { out->error = D_ERR_MEMORY; return to_off(out); }
            for (u32 p = 0; p < d->num_points; p++) {
                i32 index = (d->encoder_method == D_MESH_EDGEBREAKER)
                    ? ad->indices_map[p] : (i32)p;
                for (u32 c = 0; c < nc; c++) {
                    f32 v = 0.0f;
                    if (index >= 0 && (u32)index < a->num_values && a->dequantized) {
                        v = a->dequantized[(u32)index * nc + c];
                    }
                    values[p * nc + c] = v;
                }
            }
            out_attrs[at].unique_id = a->unique_id;
            out_attrs[at].num_components = nc;
            out_attrs[at].data_type = a->data_type;
            out_attrs[at].values = to_off(values);
            at++;
        }
    }

    out->ok = 1;
    out->error = D_ERR_NONE;
    out->num_faces = d->num_faces;
    out->num_points = d->num_points;
    out->num_attributes = total_attributes;
    out->indices = to_off(indices);
    out->attributes = to_off(out_attrs);
    return to_off(out);
}
