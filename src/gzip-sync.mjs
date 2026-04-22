'use strict';

/**
 * @fileoverview gzip-sync.mjs - Synchronous GZIP compression for browser and Node.js
 *
 * DEFLATE is a complex format; to read this code, you should probably check the RFC first:
 * https://tools.ietf.org/html/rfc1951
 *
 * You may also wish to take a look at the guide:
 * https://gist.github.com/101arrowz/253f31eb5abc3d9275ab943003ffecad
 *
 * Some of the following code is similar to that of UZIP.js:
 * https://github.com/photopea/UZIP.js
 * However, the vast majority of the codebase has diverged from UZIP.js
 * to increase performance and reduce bundle size.
 *
 * Requires: Uint8Array, Uint16Array, Int32Array (IE 10+, all modern browsers).
 * For environments without TypedArrays (e.g. Android 4.x WebView), include polyfill first.
 *
 * @author   Arjun Barrett <arjunbarrett@gmail.com>
 * @license  MIT
 * @version  0.1.0
 */

  // ─── Aliases ─────────────────────────────────────────────────────────────────

  /** @const */
  var u8 = Uint8Array;
  /** @const */
  var u16 = Uint16Array;
  /** @const */
  var i32 = Int32Array;

  // ─── Lookup Tables ───────────────────────────────────────────────────────────

  /**
   * Fixed-length extra bits (DEFLATE fixed block codes).
   * Maps code index 0–31 to the number of extra bits.
   * @type {Uint8Array}
   */
  var fleb = new u8([
    0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2,
    3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0, 0, 0, 0,
  ]);

  /**
   * Fixed-distance extra bits.
   * Maps distance code index 0–31 to the number of extra bits.
   * @type {Uint8Array}
   */
  var fdeb = new u8([
    0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6,
    7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13, 0, 0,
  ]);

  /**
   * Code-length order for the DEFLATE fixed block.
   * Specifies the sequence of code lengths (16 entries) used to decode
   * the code-length alphabet itself.
   * @type {Uint8Array}
   */
  var clim = new u8([
    16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15,
  ]);

  /**
   * Builds the base offset and reverse lookup tables from extra-bit arrays.
   *
   * The DEFLATE format encodes literals/distances as (base + extra_bits).
   * This function precomputes those bases and a reverse mapping
   * from (base + extra_bits) back to the symbol index, so lookups during
   * decompression are O(1).
   *
   * @private
   * @param {Uint8Array} eb - Extra-bit table (e.g. fleb or fdeb)
   * @param {number} start - Starting base value
   * @returns {{b: Uint16Array, r: Int32Array}} b = base offsets, r = reverse lookup
   */
  var freb = function (eb, start) {
    var b = new u16(31);
    for (var i = 0; i < 31; ++i) {
      b[i] = start += 1 << eb[i - 1];
    }
    var bl = b[30];
    var r = new i32(bl);
    for (var j = 1; j < 30; ++j) {
      var bj = b[j];
      var bjp1 = b[j + 1];
      for (var k = bj; k < bjp1; ++k) {
        r[k] = ((k - bj) << 5) | j;
      }
    }
    return { b: b, r: r };
  };

  var frebOut = freb(fleb, 2);
  var fl = frebOut.b;
  var revfl = frebOut.r;
  // Override index 28: base=258, reverse lookup for symbol 258 maps back to index 28
  fl[28] = 258;
  revfl[258] = 28;

  var frebOut2 = freb(fdeb, 0);
  var fd = frebOut2.b;
  var revfd = frebOut2.r;

  /**
   * 16-bit bit-reversal table. For any 15-bit value i, rev[i] gives the
   * bit-reversed version, used to index into canonical Huffman tables.
   *
   * Example: rev[0b101010101010101] = 0b0101010101010101
   *
   * @type {Uint16Array}
   */
  var rev = new u16(32768);
  for (var ri = 0; ri < 32768; ++ri) {
    var x = ((ri & 0xaaaa) >> 1) | ((ri & 0x5555) << 1);
    x = ((x & 0xcccc) >> 2) | ((x & 0x3333) << 2);
    x = ((x & 0xf0f0) >> 4) | ((x & 0x0f0f) << 4);
    rev[ri] = (((x & 0xff00) >> 8) | ((x & 0x00ff) << 8)) >> 1;
  }

  /**
   * Builds a canonical Huffman lookup table.
   *
   * Canonical Huffman codes are constructed so that shorter codes appear
   * numerically before longer codes. Given a code-length table (cd),
   * this function generates two lookup tables:
   *   - forward lookup (r=0): code value -> symbol index
   *   - reverse lookup (r=1): reversed bits -> (symbol_index << 4) | code_length
   *
   * @private
   * @param {Uint8Array} cd - Code-length map: index = symbol, value = bit length (0–15)
   * @param {number} mb - Maximum bit length (must be ≤ 15)
   * @param {0|1} r - 0 = forward lookup, 1 = reverse lookup
   * @returns {Uint16Array} Lookup table
   */
  var hMap = function (cd, mb, r) {
    var s = cd.length;
    var i = 0;
    var l = new u16(mb);
    for (; i < s; ++i) {
      if (cd[i]) ++l[cd[i] - 1];
    }
    var le = new u16(mb);
    for (i = 1; i < mb; ++i) {
      le[i] = (le[i - 1] + l[i - 1]) << 1;
    }
    var co;
    if (r) {
      co = new u16(1 << mb);
      var rvb = 15 - mb;
      for (i = 0; i < s; ++i) {
        if (cd[i]) {
          var sv = (i << 4) | cd[i];
          var rv = mb - cd[i];
          var v = le[cd[i] - 1]++ << rv;
          var m = v | ((1 << rv) - 1);
          for (; v <= m; ++v) {
            co[rev[v] >> rvb] = sv;
          }
        }
      }
    } else {
      co = new u16(s);
      for (i = 0; i < s; ++i) {
        if (cd[i]) {
          co[i] = rev[le[cd[i] - 1]++] >> (15 - cd[i]);
        }
      }
    }
    return co;
  };

  // Fixed literal/length tree (288 symbols: 0-255 literals + 256 end-of-block + 257-285 length codes)
  var flt = new u8(288);
  for (var _i = 0; _i < 144; ++_i) flt[_i] = 8;
  for (var _i2 = 144; _i2 < 256; ++_i2) flt[_i2] = 9;
  for (var _i3 = 256; _i3 < 280; ++_i3) flt[_i3] = 7;
  for (var _i4 = 280; _i4 < 288; ++_i4) flt[_i4] = 8;

  // Fixed distance tree (32 symbols, all bit length 5)
  var fdt = new u8(32);
  for (var _i5 = 0; _i5 < 32; ++_i5) fdt[_i5] = 5;

  /** Fixed-length canonical Huffman lookup (forward) @type {Uint16Array} */
  var flm = hMap(flt, 9, 0);
  /** Fixed-length reverse lookup table @type {Uint16Array} */
  var flrm = hMap(flt, 9, 1);
  /** Fixed-distance forward lookup @type {Uint16Array} */
  var fdm = hMap(fdt, 5, 0);
  /** Fixed-distance reverse lookup @type {Uint16Array} */
  var fdrm = hMap(fdt, 5, 1);

  // ─── Utility Helpers ─────────────────────────────────────────────────────────

  /**
   * Returns the maximum value in a typed or plain array.
   * @private
   * @param {ArrayLike<number>} a
   * @returns {number}
   */
  var max = function (a) {
    var m = a[0];
    var len = a.length;
    for (var i = 1; i < len; ++i) {
      if (a[i] > m) m = a[i];
    }
    return m;
  };

  /**
   * Converts a bit position to the next byte boundary.
   * i.e. the byte index that contains the bit at position p.
   * @private
   * @param {number} p - Bit position
   * @returns {number} Byte index
   */
  var shft = function (p) {
    return ((p + 7) / 8) | 0;
  };

  /**
   * Typed-array aware slice.
   * Creates a new Uint8Array copy of a sub-range.
   * Using subarray() + copy would allow the GC to reclaim the original
   * reference, while being more compatible than Array#slice.
   *
   * @private
   * @param {Uint8Array} v - Source buffer
   * @param {number} s - Start index (inclusive)
   * @param {number} [e] - End index (exclusive)
   * @returns {Uint8Array} New slice
   */
  var slc = function (v, s, e) {
    if (s == null || s < 0) s = 0;
    if (e == null || e > v.length) e = v.length;
    return new u8(v.subarray(s, e));
  };

  // ─── Error Handling ──────────────────────────────────────────────────────────

  /**
   * Error codes returned by {@link FlateError#code}.
   * @readonly
   * @enum {number}
   */
  var FlateErrorCode = {
    /** Compressed data ended before the logical block was complete. */
    UnexpectedEOF: 0,
    /** A block type code was encountered that is not valid. */
    InvalidBlockType: 1,
    /** A literal/length code was encountered that is not valid. */
    InvalidLengthLiteral: 2,
    /** A distance code was encountered that references data before the output window start. */
    InvalidDistance: 3,
    /** The logical end of the compressed stream has been reached. */
    StreamFinished: 4,
    /** A stream handler was expected but none was provided. */
    NoStreamHandler: 5,
    /** The GZIP or ZLIB header is malformed. */
    InvalidHeader: 6,
    /** A callback function is required but was not provided. */
    NoCallback: 7,
    /** Text data is not valid UTF-8. */
    InvalidUTF8: 8,
    /** An extra field exceeds the maximum allowed length. */
    ExtraFieldTooLong: 9,
    /** A date/timestamp in a ZIP entry is outside the valid range (1980–2099). */
    InvalidDate: 10,
    /** A filename in a ZIP entry exceeds the maximum allowed length. */
    FilenameTooLong: 11,
    /** A stream is still actively processing when it should be finished. */
    StreamFinishing: 12,
    /** ZIP data (e.g. central directory, local file header) is invalid. */
    InvalidZipData: 13,
    /** The compression method used in a ZIP entry is not supported. */
    UnknownCompressionMethod: 14,
  };

  /** @private @type {string[]} Human-readable messages, indexed by error code. */
  var ec = [
    'unexpected EOF',
    'invalid block type',
    'invalid length/literal',
    'invalid distance',
    'stream finished',
    'no stream handler', // 5 — determined by compression function
    'no callback',       // 6
    'invalid UTF-8 data', // 7
    'extra field too long', // 8
    'date not in range 1980-2099', // 9
    'filename too long',  // 10
    'stream finishing',   // 11
    'invalid zip data',   // 12
    // 13 — determined by unknown compression method
  ];

  /**
   * Creates and optionally throws a FlateError.
   *
   * @private
   * @param {number} ind - Error code index
   * @param {string|0} [msg] - Override message, or 0 for no throw
   * @param {1} [nt] - Pass 1 to return the error without throwing
   * @returns {Error} The error object
   */
  var err = function (ind, msg, nt) {
    var e = new Error(msg || ec[ind]);
    e.code = ind;
    if (typeof Error.captureStackTrace === 'function') {
      Error.captureStackTrace(e, err);
    }
    if (!nt) throw e;
    return e;
  };

  // ─── Bit-Writing Utilities ───────────────────────────────────────────────────

  /**
   * Writes up to 16 bits of value v starting at bit position p
   * into the byte array d. Bits are written LSB-first (little-endian within each byte).
   *
   * @private
   * @param {Uint8Array} d - Output buffer
   * @param {number} p - Bit offset to start writing (0 = LSB of d[0])
   * @param {number} v - Unsigned integer value to write
   * @returns {void}
   */
  var wbits = function (d, p, v) {
    v <<= p & 7;
    var o = (p / 8) | 0;
    d[o] |= v;
    d[o + 1] |= v >> 8;
  };

  /**
   * Writes up to 24 bits of value v starting at bit position p.
   * Same as wbits but handles an additional byte for larger values.
   *
   * @private
   * @param {Uint8Array} d - Output buffer
   * @param {number} p - Bit offset
   * @param {number} v - Unsigned integer value to write
   * @returns {void}
   */
  var wbits16 = function (d, p, v) {
    v <<= p & 7;
    var o = (p / 8) | 0;
    d[o] |= v;
    d[o + 1] |= v >> 8;
    d[o + 2] |= v >> 16;
  };

  // ─── Huffman Tree Builder ────────────────────────────────────────────────────

  /**
   * Huffman tree node used during tree construction.
   * @private
   * @typedef {Object} HuffNode
   * @property {number} s - Symbol index (-1 for internal nodes)
   * @property {number} f - Frequency count
   * @property {HuffNode} [l] - Left child
   * @property {HuffNode} [r] - Right child
   */

  /**
   * Generates code lengths for a canonical Huffman code given frequency counts.
   *
   * Uses the Hoffmann algorithm with a binary heap to build the tree.
   * If the longest code exceeds maxBits (mb), excess symbols are redistributed
   * to shorter codes while maintaining the prefix-free property.
   *
   * @private
   * @param {Uint16Array} d - Frequency table; d[i] = count of symbol i
   * @param {number} mb - Maximum allowed code length
   * @returns {{t: Uint8Array, l: number}} t = code lengths, l = actual max bit length
   */
  var hTree = function (d, mb) {
    var t = [];
    for (var di = 0; di < d.length; ++di) {
      if (d[di]) t.push({ s: di, f: d[di] });
    }
    var s = t.length;
    var t2 = t.slice();
    if (!s) return { t: et, l: 0 };
    if (s == 1) {
      var v = new u8(t[0].s + 1);
      v[t[0].s] = 1;
      return { t: v, l: 1 };
    }
    t.sort(function (a, b) { return a.f - b.f; });
    t.push({ s: -1, f: 25001 });

    var lNode = t[0];
    var rNode = t[1];
    var i0 = 0, i1 = 1, i2 = 2;
    t[0] = { s: -1, f: lNode.f + rNode.f, l: lNode, r: rNode };

    while (i1 != s - 1) {
      lNode = t[t[i0].f < t[i2].f ? i0++ : i2++];
      rNode = t[i0 != i1 && t[i0].f < t[i2].f ? i0++ : i2++];
      t[i1++] = { s: -1, f: lNode.f + rNode.f, l: lNode, r: rNode };
    }

    var maxSym = t2[0].s;
    for (var mi = 1; mi < s; ++mi) {
      if (t2[mi].s > maxSym) maxSym = t2[mi].s;
    }

    var tr = new u16(maxSym + 1);
    var mbt = ln(t[i1 - 1], tr, 0);

    if (mbt > mb) {
      var dt = 0;
      var lft = mbt - mb;
      var cst = 1 << lft;
      t2.sort(function (a, b) { return tr[b.s] - tr[a.s] || a.f - b.f; });
      for (var ti = 0; ti < s; ++ti) {
        var si2 = t2[ti].s;
        if (tr[si2] > mb) {
          dt += cst - (1 << (mbt - tr[si2]));
          tr[si2] = mb;
        } else break;
      }
      dt >>= lft;
      while (dt > 0) {
        var si3 = t2[ti].s;
        if (tr[si3] < mb) dt -= 1 << (mb - tr[si3]++ - 1);
        else ++ti;
      }
      for (; ti >= 0 && dt; --ti) {
        var si4 = t2[ti].s;
        if (tr[si4] == mb) {
          --tr[si4];
          ++dt;
        }
      }
      mbt = mb;
    }

    return { t: new u8(tr), l: mbt };
  };

  /**
   * Assigns bit lengths (depths) to each symbol in the Huffman tree.
   * Recursively traverses from node n and fills the output array l.
   *
   * @private
   * @param {HuffNode} n - Current node
   * @param {Uint16Array} l - Output length map
   * @param {number} d - Current depth
   * @returns {number} Maximum depth encountered
   */
  var ln = function (n, l, d) {
    return n.s == -1
      ? Math.max(ln(n.l, l, d + 1), ln(n.r, l, d + 1))
      : (l[n.s] = d);
  };

  // ─── Length-Code Generator ───────────────────────────────────────────────────

  /**
   * Generates run-length encoded length symbols for the DEFLATE block header.
   *
   * Converts a sequence of literal/length code lengths into a compact
   * representation using DEFLATE's special repeat codes:
   *   16  = repeat previous code length (3–6 times)
   *   17  = insert zero code length (3–10 times)
   *   18  = insert zero code length (11–138 times)
   *
   * @private
   * @param {Uint8Array} c - Input code-length sequence
   * @returns {{c: Uint8Array, n: number}} c = encoded symbols, n = symbol count
   */
  var lc = function (c) {
    var slen = c.length;
    while (slen && !c[--slen]);
    var cl = new u16(++slen);
    var cli = 0;
    var cln = c[0];
    var cls = 1;
    var w = function (val) { cl[cli++] = val; };
    for (var i = 1; i <= slen; ++i) {
      if (c[i] == cln && i != slen) ++cls;
      else {
        if (!cln && cls > 2) {
          for (; cls > 138; cls -= 138) w(32754);
          if (cls > 2) {
            w(cls > 10 ? ((cls - 11) << 5) | 28690 : ((cls - 3) << 5) | 12305);
            cls = 0;
          }
        } else if (cls > 3) {
          w(cln);
          --cls;
          for (; cls > 6; cls -= 6) w(8304);
          if (cls > 2) {
            w(((cls - 3) << 5) | 8208);
            cls = 0;
          }
        }
        while (cls--) w(cln);
        cls = 1;
        cln = c[i];
      }
    }
    return { c: cl.subarray(0, cli), n: slen };
  };

  /**
   * Calculates the total encoded bit length given a frequency table and a code-length table.
   *
   * @private
   * @param {Uint16Array} cf - Frequency table
   * @param {Uint8Array} cl - Code-length table
   * @returns {number} Total bits
   */
  var clen = function (cf, cl) {
    var total = 0;
    for (var ci = 0; ci < cl.length; ++ci) total += cf[ci] * cl[ci];
    return total;
  };

  // ─── DEFLATE Block Writer ────────────────────────────────────────────────────

  /**
   * Writes a DEFLATE "no compression" (type 0) block.
   * Stores data literally with a 4-byte check (uncompressed length LEN, ~LEN).
   *
   * @private
   * @param {Uint8Array} out - Output buffer
   * @param {number} pos - Current bit position in output
   * @param {Uint8Array} dat - Uncompressed data
   * @returns {number} New bit position
   */
  var wfblk = function (out, pos, dat) {
    var s = dat.length;
    var o = shft(pos + 2);
    out[o] = s & 255;
    out[o + 1] = s >> 8;
    out[o + 2] = out[o] ^ 255;
    out[o + 3] = out[o + 1] ^ 255;
    for (var fi = 0; fi < s; ++fi) out[o + fi + 4] = dat[fi];
    return (o + 4 + s) * 8;
  };

  /**
   * Writes a full DEFLATE compressed block using dynamic Huffman coding.
   *
   * Chooses between fixed, dynamic, and uncompressed encoding based on
   * the estimated output size, then emits the appropriate bit sequence
   * including the Huffman tables for the dynamic case.
   *
   * @private
   * @param {Uint8Array} dat - Original input data
   * @param {Uint8Array} out - Output buffer
   * @param {number} final_ - 1 if this is the last block (BFINAL=1)
   * @param {Int32Array} syms - Symbol sequence (literals or length/distance pairs)
   * @param {Uint16Array} lf - Literal/length frequency table
   * @param {Uint16Array} df - Distance frequency table
   * @param {number} eb - Extra bits count already consumed
   * @param {number} li - Number of symbols in syms
   * @param {number} bs - Start byte index of this block's data
   * @param {number} bl - Number of bytes in this block
   * @param {number} p - Current bit position
   * @returns {number} New bit position after writing
   */
  var wblk = function (dat, out, final_, syms, lf, df, eb, li, bs, bl, p) {
    wbits(out, p++, final_);
    ++lf[256];

    var hTreeOut1 = hTree(lf, 15);
    var dlt = hTreeOut1.t;
    var mlb = hTreeOut1.l;

    var hTreeOut2 = hTree(df, 15);
    var ddt = hTreeOut2.t;
    var mdb = hTreeOut2.l;

    var lcOut = lc(dlt);
    var lclt = lcOut.c;
    var nlc = lcOut.n;

    var lcOut2 = lc(ddt);
    var lcdt = lcOut2.c;
    var ndc = lcOut2.n;

    var lcfreq = new u16(19);
    for (var li2 = 0; li2 < lclt.length; ++li2) ++lcfreq[lclt[li2] & 31];
    for (var di2 = 0; di2 < lcdt.length; ++di2) ++lcfreq[lcdt[di2] & 31];

    var hTreeOut3 = hTree(lcfreq, 7);
    var lct = hTreeOut3.t;
    var mlcb = hTreeOut3.l;

    var nlcc = 19;
    for (; nlcc > 4 && !lct[clim[nlcc - 1]]; --nlcc);

    var flen = (bl + 5) << 3;
    var ftlen = clen(lf, flt) + clen(df, fdt) + eb;
    var dtlen =
      clen(lf, dlt) +
      clen(df, ddt) +
      eb +
      14 +
      3 * nlcc +
      clen(lcfreq, lct) +
      2 * lcfreq[16] +
      3 * lcfreq[17] +
      7 * lcfreq[18];

    if (bs >= 0 && flen <= ftlen && flen <= dtlen) {
      return wfblk(out, p, dat.subarray(bs, bs + bl));
    }

    var lm, ll, dm, dl;
    wbits(out, p, 1 + (dtlen < ftlen ? 1 : 0));
    p += 2;

    if (dtlen < ftlen) {
      lm = hMap(dlt, mlb, 0);
      ll = dlt;
      dm = hMap(ddt, mdb, 0);
      dl = ddt;

      var llm = hMap(lct, mlcb, 0);
      wbits(out, p, nlc - 257);
      wbits(out, p + 5, ndc - 1);
      wbits(out, p + 10, nlcc - 4);
      p += 14;
      for (var ci2 = 0; ci2 < nlcc; ++ci2) wbits(out, p + 3 * ci2, lct[clim[ci2]]);
      p += 3 * nlcc;

      var lcts = [lclt, lcdt];
      for (var it = 0; it < 2; ++it) {
        var clct = lcts[it];
        for (var cj = 0; cj < clct.length; ++cj) {
          var len = clct[cj] & 31;
          wbits(out, p, llm[len]);
          p += lct[len];
          if (len > 15) {
            wbits(out, p, (clct[cj] >> 5) & 127);
            p += clct[cj] >> 12;
          }
        }
      }
    } else {
      lm = flm;
      ll = flt;
      dm = fdm;
      dl = fdt;
    }

    for (var si = 0; si < li; ++si) {
      var sym = syms[si];
      if (sym > 255) {
        var symLen = (sym >> 18) & 31;
        wbits16(out, p, lm[symLen + 257]);
        p += ll[symLen + 257];
        if (symLen > 7) {
          wbits(out, p, (sym >> 23) & 31);
          p += fleb[symLen];
        }
        var dst = sym & 31;
        wbits16(out, p, dm[dst]);
        p += dl[dst];
        if (dst > 3) {
          wbits16(out, p, (sym >> 5) & 8191);
          p += fdeb[dst];
        }
      } else {
        wbits16(out, p, lm[sym]);
        p += ll[sym];
      }
    }

    wbits16(out, p, lm[256]);
    return p + ll[256];
  };

  // ─── DEFLATE Compressor ──────────────────────────────────────────────────────

  /**
   * Deflate options (nice << 13) | chain.
   * Pre-computed settings for each compression level:
   *   nice = maximum match length to stop searching
   *   chain = number of hash chains to check before accepting a match
   * @type {Int32Array}
   * @private
   */
  var deo = new i32([
    65540, 131080, 131088, 131104, 262176, 1048704, 1048832, 2114560, 2117632,
  ]);

  /** Empty zero-length Uint8Array, used as the tree for empty symbols. @private @const */ /** @type {Uint8Array} */
  var et = new u8(0);

  /**
   * @typedef {Object} DeflateState
   * @property {Uint16Array} [h] - Hash table head (rolling)
   * @property {Uint16Array} [p] - Previous position table (rolling)
   * @property {number} [i] - Current input byte index
   * @property {number} [z] - Total input size
   * @property {number} [w] - Window start position (for dictionary)
   * @property {number} [r] - Remaining bits from previous byte (for bit alignment)
   * @property {number} l - Last block flag (1 = continue, 0 = final)
   */

  /**
   * Core DEFLATE compression algorithm.
   *
   * Uses LZ77 (Lempel-Ziv) with a sliding window and lazy matching.
   * The algorithm tracks hash chains of recent byte sequences and searches
   * for the longest match at each position, balancing speed vs compression ratio.
   *
   * @private
   * @param {Uint8Array} dat - Input data
   * @param {number} lvl - Compression level (0–9); 0 = no compression (store only)
   * @param {number} plvl - Pre-computed memory level parameter (from level)
   * @param {number} pre - Number of bytes to reserve at the start of output
   * @param {number} post - Number of bytes to reserve at the end of output
   * @param {DeflateState} st - Compression state (for incremental streaming)
   * @returns {Uint8Array} Compressed data (DEFLATE format)
   */
  var dflt = function (dat, lvl, plvl, pre, post, st) {
    var s = st.z || dat.length;
    var outBuf = new u8(pre + s + 5 * (1 + Math.ceil(s / 7000)) + post);
    var w = outBuf.subarray(pre, outBuf.length - post);
    var lst = st.l;
    var pos = ((st.r || 0) & 7);
    if (lvl) {
      if (pos) w[0] = st.r >> 3;
      var opt = deo[lvl - 1];
      var n = opt >> 13;
      var c = opt & 8191;
      var msk = (1 << plvl) - 1;
      var prev = st.p || new u16(32768);
      var head = st.h || new u16(msk + 1);
      var bs1 = Math.ceil(plvl / 3);
      var bs2 = 2 * bs1;
      var hsh = function (i) {
        return (dat[i] ^ (dat[i + 1] << bs1) ^ (dat[i + 2] << bs2)) & msk;
      };
      var syms = new i32(25000);
      var lf = new u16(288);
      var df = new u16(32);
      var lcCnt = 0;
      var ebCnt = 0;
      var i = st.i || 0;
      var li = 0;
      var wi = st.w || 0;
      var bs = 0;
      for (; i + 2 < s; ++i) {
        var hv = hsh(i);
        var imod = i & 32767;
        var pimod = head[hv];
        prev[imod] = pimod;
        head[hv] = imod;
        if (wi <= i) {
          var rem = s - i;
          if ((lcCnt > 7000 || li > 24576) && (rem > 423 || !lst)) {
            pos = wblk(dat, w, 0, syms, lf, df, ebCnt, li, bs, i - bs, pos);
            li = 0;
            lcCnt = 0;
            ebCnt = 0;
            bs = i;
            for (var lfj = 0; lfj < 286; ++lfj) lf[lfj] = 0;
            for (var dfj = 0; dfj < 30; ++dfj) df[dfj] = 0;
          }
          var l = 2;
          var d = 0;
          var ch = c;
          var dif = (imod - pimod) & 32767;
          if (rem > 2 && hv == hsh(i - dif)) {
            var maxn = Math.min(n, rem) - 1;
            var maxd = Math.min(32767, i);
            var ml = Math.min(258, rem);
            while (dif <= maxd && --ch && imod != pimod) {
              if (dat[i + l] == dat[i + l - dif]) {
                var nl = 0;
                for (; nl < ml && dat[i + nl] == dat[i + nl - dif]; ++nl);
                if (nl > l) {
                  l = nl;
                  d = dif;
                  if (nl > maxn) break;
                  var mmd = Math.min(dif, nl - 2);
                  var md = 0;
                  for (var mj = 0; mj < mmd; ++mj) {
                    var ti = (i - dif + mj) & 32767;
                    var pti = prev[ti];
                    var cd = (ti - pti) & 32767;
                    if (cd > md) {
                      md = cd;
                      pimod = ti;
                    }
                  }
                }
              }
              imod = pimod;
              pimod = prev[imod];
              dif += (imod - pimod) & 32767;
            }
          }
          if (d) {
            syms[li++] = 268435456 | (revfl[l] << 18) | revfd[d];
            var lin = revfl[l] & 31;
            var din = revfd[d] & 31;
            ebCnt += fleb[lin] + fdeb[din];
            ++lf[257 + lin];
            ++df[din];
            wi = i + l;
            ++lcCnt;
          } else {
            syms[li++] = dat[i];
            ++lf[dat[i]];
          }
        }
      }
      for (i = Math.max(i, wi); i < s; ++i) {
        syms[li++] = dat[i];
        ++lf[dat[i]];
      }
      pos = wblk(dat, w, lst, syms, lf, df, ebCnt, li, bs, i - bs, pos);
      if (!lst) {
        st.r = (pos & 7) | (w[(pos / 8) | 0] << 3);
        pos -= 7;
        st.h = head;
        st.p = prev;
        st.i = i;
        st.w = wi;
      }
    } else {
      // Level 0: store-only (no compression)
      for (var si2 = st.w || 0; si2 < s + lst; si2 += 65535) {
        var e = si2 + 65535;
        if (e >= s) {
          w[(pos / 8) | 0] = lst;
          e = s;
        }
        pos = wfblk(w, pos + 1, dat.subarray(si2, e));
      }
      st.i = s;
    }
    return slc(outBuf, 0, pre + shft(pos) + post);
  };

  // ─── CRC32 ───────────────────────────────────────────────────────────────────

  /**
   * CRC32 implementation used by GZIP and ZIP formats.
   *
   * Pre-computes the 256-entry lookup table using the standard polynomial
   * 0xEDB88320 (reversed representation). Then processes data byte-by-byte
   * using the table for O(n) performance.
   *
   * @private
   * @typedef {Object} CRC32
   * @property {function(Uint8Array): void} p - Process a chunk of data
   * @property {function(): number} d - Get final digest (as unsigned 32-bit)
   */

  /** @type {Int32Array} CRC32 lookup table @private */
  var crct = (function () {
    var t = new i32(256);
    for (var ci3 = 0; ci3 < 256; ++ci3) {
      var c = ci3;
      var k = 9;
      while (--k) c = (c & 1 && -306674912) ^ (c >>> 1);
      t[ci3] = c;
    }
    return t;
  }());

  /**
   * Creates a new CRC32 running checksum instance.
   * @private
   * @returns {CRC32}
   */
  var crc = function () {
    var c = -1;
    return {
      /** @param {Uint8Array} d */
      p: function (d) {
        var cr = c;
        for (var di3 = 0; di3 < d.length; ++di3) {
          cr = crct[(cr & 255) ^ d[di3]] ^ (cr >>> 8);
        }
        c = cr;
      },
      /** @returns {number} */
      d: function () { return ~c; },
    };
  };

  // ─── GZIP Format ────────────────────────────────────────────────────────────

  /**
   * Options for the {@link gzipSync} function.
   *
   * @typedef {Object} GzipOptions
   * @property {0|1|2|3|4|5|6|7|8|9} [level=6] - Compression level.
   *   0 = no compression (store only), 1 = fastest, 9 = best compression.
   * @property {0|1|2|3|4|5|6|7|8|9|10|11|12} [mem] - Memory level.
   *   Higher values use more RAM but are faster. Default is auto-calculated.
   * @property {Uint8Array} [dictionary] - Pre-defined dictionary to improve
   *   compression of data with common prefixes (up to 32 KiB used).
   * @property {Date|string|number} [mtime] - Modification time in the GZIP header.
   *   Defaults to the current time. Use 0 to omit.
   * @property {string} [filename] - Filename stored in the GZIP header.
   */

  /**
   * DEFLATE options (subset of GzipOptions).
   *
   * @typedef {Object} DeflateOptions
   * @property {0|1|2|3|4|5|6|7|8|9} [level=6]
   * @property {0|1|2|3|4|5|6|7|8|9|10|11|12} [mem]
   * @property {Uint8Array} [dictionary]
   */

  /**
   * Applies DEFLATE options and handles dictionary pre-processing.
   *
   * @private
   * @param {Uint8Array} dat - Input data
   * @param {DeflateOptions} opt - Compression options
   * @param {number} pre - Prefix bytes to reserve in output
   * @param {number} post - Postfix bytes to reserve in output
   * @param {DeflateState} [st] - Optional streaming state
   * @returns {Uint8Array}
   */
  var dopt = function (dat, opt, pre, post, st) {
    if (!st) {
      st = { l: 1 };
      if (opt.dictionary) {
        var dict = opt.dictionary.subarray(-32768);
        var newDat = new u8(dict.length + dat.length);
        newDat.set(dict);
        newDat.set(dat, dict.length);
        dat = newDat;
        st.w = dict.length;
      }
    }
    var lvl = opt.level == null ? 6 : opt.level;
    var plvl;
    if (opt.mem == null) {
      plvl = st.l
        ? Math.ceil(Math.max(8, Math.min(13, Math.log(dat.length))) * 1.5)
        : 20;
    } else {
      plvl = 12 + opt.mem;
    }
    return dflt(dat, lvl, plvl, pre, post, st);
  };

  /**
   * Writes an unsigned integer v into byte array d starting at byte index b.
   * Uses little-endian byte order (LSB first).
   *
   * @private
   * @param {Uint8Array} d - Output buffer
   * @param {number} b - Starting byte index
   * @param {number} v - Unsigned integer to write
   * @returns {void}
   */
  var wbytes = function (d, b, v) {
    for (; v; ++b) {
      d[b] = v;
      v >>>= 8;
    }
  };

  /**
   * Writes the GZIP header (10 + optional filename bytes) into buffer c.
   *
   * GZIP header layout:
   *   [0-1]  Magic: 0x1F 0x8B (GZIP signature)
   *   [2]    Compression method: 8 = DEFLATE
   *   [3]    Flags: 8 = FNAME (filename present)
   *   [4-7]  Modification time (MTIME) as Unix timestamp
   *   [8]    Extra flags: 2 = maximum compression, 4 = fast encoder
   *   [9]    Operating system: 3 = Unix
   *   [10+]  Filename (null-terminated ASCII), if provided
   *
   * @private
   * @param {Uint8Array} c - Output buffer (must be pre-allocated with gzhl bytes)
   * @param {GzipOptions} o - GZIP options
   * @returns {void}
   */
  var gzh = function (c, o) {
    var fn = o.filename;
    c[0] = 31;
    c[1] = 139;
    c[2] = 8;
    c[8] = o.level < 2 ? 4 : o.level == 9 ? 2 : 0;
    c[9] = 3; // OS: Unix
    if (o.mtime != 0) {
      var mtimeVal = typeof o.mtime === 'number'
        ? Math.floor(o.mtime / 1000)
        : Math.floor((new Date(/** @type {string|number} */ (o.mtime) || Date.now()).getTime()) / 1000);
      wbytes(c, 4, mtimeVal);
    }
    if (fn) {
      c[3] = 8; // FNAME flag
      for (var gi = 0; gi <= fn.length; ++gi) c[gi + 10] = fn.charCodeAt(gi);
    }
  };

  /**
   * Computes the GZIP header length in bytes.
   *
   * @private
   * @param {GzipOptions} o
   * @returns {number} Header size (10 + optional filename length)
   */
  var gzhl = function (o) {
    return 10 + (o.filename ? o.filename.length + 1 : 0);
  };

  // ─── TextEncoder ─────────────────────────────────────────────────────────────

  /**
   * TextEncoder instance, if available in the environment.
   * Falls back to null on IE/old environments (strToU8 has its own fallback).
   * @private @type {TextEncoder|null */
  var te = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;

  // ─── Public API ──────────────────────────────────────────────────────────────

  /**
   * Converts a string into a Uint8Array using UTF-8 encoding.
   *
   * This is the standard way to prepare string data for compression.
   * When TextEncoder is available (all modern browsers, IE 11+) it uses
   * the native implementation for maximum performance.
   * When TextEncoder is unavailable (IE 10 and below), a compatible
   * pure-JS fallback is used automatically.
   *
   * @example
   * var data = strToU8('Hello World');
   * var compressed = gzipSync(data);
   *
   * @example
   * // Binary/Latin-1 encoding (each char -> single byte, no UTF-8 transform)
   * var binary = strToU8(binaryString, true);
   *
   * @param {string} str - The string to encode
   * @param {boolean} [latin1=false] - If true, encodes as Latin-1 (ISO-8859-1)
   *   instead of UTF-8. Use this only when decoding raw binary strings
   *   from non-text sources.
   * @returns {Uint8Array} UTF-8 (or Latin-1) encoded byte sequence
   */
  var strToU8 = function (str, latin1) {
    if (latin1) {
      var ar = new u8(str.length);
      for (var si5 = 0; si5 < str.length; ++si5) ar[si5] = str.charCodeAt(si5) & 0xff;
      return ar;
    }
    if (te) return te.encode(str);
    var l = str.length;
    var ar2 = new u8(str.length + (str.length >> 1));
    var ai = 0;
    var w2 = function (val) { ar2[ai++] = val; };
    for (var i2 = 0; i2 < l; ++i2) {
      if (ai + 5 > ar2.length) {
        var n2 = new u8(ai + 8 + ((l - i2) << 1));
        n2.set(ar2);
        ar2 = n2;
      }
      var c = str.charCodeAt(i2);
      if (c < 128 || latin1) {
        w2(c);
      } else if (c < 2048) {
        w2(192 | (c >> 6));
        w2(128 | (c & 63));
      } else if (c > 55295 && c < 57344) {
        // Surrogate pair: decode the pair first, then encode as 4-byte UTF-8
        // 65536 + ((high & 0x03FF) << 10) | (low & 0x03FF)
        c = 65536 | ((c & 1023) << 10) | (str.charCodeAt(++i2) & 1023);
        w2(240 | (c >> 18));
        w2(128 | ((c >> 12) & 63));
        w2(128 | ((c >> 6) & 63));
        w2(128 | (c & 63));
      } else {
        w2(224 | (c >> 12));
        w2(128 | ((c >> 6) & 63));
        w2(128 | (c & 63));
      }
    }
    return slc(ar2, 0, ai);
  };

  /**
   * Synchronously compresses data using the GZIP format.
   *
   * GZIP is a container format around DEFLATE. It adds:
   *   - 10-byte header (magic, method, flags, timestamp, OS)
   *   - Optional filename field
   *   - 8-byte footer: CRC-32 checksum + original uncompressed size (ISIZE)
   *
   * Output is compatible with standard gzip utilities (gzip, zlib gunzip, etc.)
   *
   * @example
   * var data = strToU8('Hello World');
   * var compressed = gzipSync(data, { level: 6 });
   *
   * @example
   * // With a dictionary for repeated data patterns
   * var dict = strToU8('common-prefix-');
   * var compressed = gzipSync(data, { dictionary: dict, level: 9 });
   *
   * @param {Uint8Array} data - Raw bytes to compress
   * @param {GzipOptions} [opts] - Compression options
   * @param {number} [opts.level=6] - Compression level (0–9)
   * @param {0|1|2|3|4|5|6|7|8|9|10|11|12} [opts.mem] - Memory level
   * @param {Uint8Array} [opts.dictionary] - Up to 32 KiB dictionary
   * @param {Date|string|number} [opts.mtime] - Modification timestamp
   * @param {string} [opts.filename] - Filename in header
   * @returns {Uint8Array} GZIP-compressed byte sequence
   */
  var gzipSync = function (data, opts) {
    if (!opts) opts = {};
    var crcInst = crc();
    var l = data.length;
    crcInst.p(data);
    var gzipHdrLen = gzhl(opts);
    var deflated = dopt(data, opts, gzipHdrLen, 8);
    var s = deflated.length;
    gzh(deflated, opts);
    wbytes(deflated, s - 8, crcInst.d());
    wbytes(deflated, s - 4, l);
    return deflated;
  };

// === ES Module exports ===

export { FlateErrorCode, strToU8, gzipSync };
