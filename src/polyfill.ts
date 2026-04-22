/**
 * Minimal polyfill for gzip-sync.js
 * Covers environments missing TextEncoder and Typed Arrays (e.g. Android 4.x WebView, iOS < 10, older WebView)
 *
 * Usage: include this script BEFORE gzip-sync, or bundle it at the top.
 * All checks are conditional — modern browsers pay zero overhead.
 */

(function (global) {
  'use strict';

  // ── Typed Arrays ──────────────────────────────────────────────────────────────
  // Android 4.4 WebView (Chromium 30) and below lack TypedArrays entirely.
  // Check both the constructors and .subarray (some envs have the former but not the latter).

  if (typeof Uint8Array === 'undefined' || !Uint8Array.prototype.subarray) {
    var MAX_ARRAY_INDEX = Math.pow(2, 53) - 1;

    function strToBytes(s) {
      var len = s.length | 0;
      var bytes = new Array(len);
      for (var i = 0; i < len; i++) bytes[i] = s.charCodeAt(i) & 0xFF;
      return bytes;
    }

    global.Uint8Array = function (arr) {
      if (typeof arr === 'number') {
        this.length = arr | 0;
        for (var i = 0; i < this.length; i++) this[i] = 0;
      } else {
        var b = arr ? (Array.isArray(arr) ? arr : strToBytes(String(arr))) : [];
        this.length = b.length;
        for (var j = 0; j < this.length; j++) this[j] = b[j];
      }
    };
    global.Uint8Array.prototype = [];
    global.Uint8Array.prototype.constructor = global.Uint8Array;
    global.Uint8Array.prototype.subarray = function (s, e) {
      s = s | 0;
      e = e | 0;
      if (s < 0) s = this.length + s;
      if (e < 0) e = this.length + e;
      if (s < 0) s = 0;
      if (e > this.length) e = this.length;
      if (s >= e) return new global.Uint8Array(0);
      var len = e - s;
      var r = new global.Uint8Array(len);
      for (var i = 0; i < len; i++) r[i] = this[s + i];
      return r;
    };
    global.Uint8Array.prototype.set = function (src, offset) {
      offset = offset | 0;
      var srcLen = src.length | 0;
      for (var i = 0; i < srcLen; i++) this[offset + i] = src[i];
    };
    global.Uint8Array.BYTES_PER_ELEMENT = 1;

    global.Uint16Array = function (arr) {
      var b = arr ? (Array.isArray(arr) ? arr : []) : [];
      this.length = b.length;
      for (var j = 0; j < this.length; j++) this[j] = b[j] | 0;
    };
    global.Uint16Array.prototype = [];
    global.Uint16Array.prototype.constructor = global.Uint16Array;
    global.Uint16Array.prototype.subarray = global.Uint8Array.prototype.subarray;
    global.Uint16Array.prototype.set = global.Uint8Array.prototype.set;
    global.Uint16Array.BYTES_PER_ELEMENT = 2;

    global.Int32Array = function (arr) {
      var b = arr ? (Array.isArray(arr) ? arr : []) : [];
      this.length = b.length;
      for (var j = 0; j < this.length; j++) this[j] = b[j] | 0;
    };
    global.Int32Array.prototype = [];
    global.Int32Array.prototype.constructor = global.Int32Array;
    global.Int32Array.prototype.subarray = global.Uint8Array.prototype.subarray;
    global.Int32Array.prototype.set = global.Uint8Array.prototype.set;
    global.Int32Array.BYTES_PER_ELEMENT = 4;
  }

  // ── TextEncoder ──────────────────────────────────────────────────────────────
  // iOS < 10, Edge < 79, Android WebView < 74
  // We only need encode() — gzip-sync does not use TextDecoder.
  if (typeof global.TextEncoder === 'undefined') {
    global.TextEncoder = function () {};
    global.TextEncoder.prototype.encode = function (str) {
      var len = str.length | 0;
      var buf = new Uint8Array(len * 4);
      var outLen = 0;
      for (var i = 0; i < len; i++) {
        var c = str.charCodeAt(i);
        if (c < 0x80) {
          buf[outLen++] = c;
        } else if (c < 0x800) {
          buf[outLen++] = 0xC0 | (c >> 6);
          buf[outLen++] = 0x80 | (c & 0x3F);
        } else if (c < 0xD800 || c > 0xDFFF) {
          buf[outLen++] = 0xE0 | (c >> 12);
          buf[outLen++] = 0x80 | ((c >> 6) & 0x3F);
          buf[outLen++] = 0x80 | (c & 0x3F);
        } else {
          // surrogate pair
          var cp = 0x10000 + (((c & 0x3FF) << 10) | (str.charCodeAt(++i) & 0x3FF));
          buf[outLen++] = 0xF0 | (cp >> 18);
          buf[outLen++] = 0x80 | ((cp >> 12) & 0x3F);
          buf[outLen++] = 0x80 | ((cp >> 6) & 0x3F);
          buf[outLen++] = 0x80 | (cp & 0x3F);
        }
      }
      return buf.subarray(0, outLen);
    };
  }

})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : global);
