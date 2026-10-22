/* Schema-free protobuf wire-format encoder/decoder (JS port of pbdec.py / pbenc.py)
 *
 * Parse results are uniformly represented as triple arrays: [[fieldNumber, wireType, value], ...]
 *   wireType 0 (varint)  -> value: number
 *   wireType 1 (64bit)   -> value: number (read as unsigned, little-endian)
 *   wireType 2 (bytes)   -> value: Uint8Array
 *   wireType 5 (32bit)   -> value: number
 *
 * Note: JS bitwise ops are 32-bit, so varints over 31 bits must be accumulated with multiplication.
 */
(function (global) {
  'use strict';

  var MJ = global.__mj || (global.__mj = {});

  // ---------------------------------------------------------------- Decoding
  function numberIfSafe(value) {
    return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
  }

  function readVarint(buf, pos) {
    var result = 0n;
    var shift = 0n;
    var count = 0;
    while (pos < buf.length && count < 10) {
      var b = buf[pos++];
      result |= BigInt(b & 0x7f) << shift;
      count++;
      if ((b & 0x80) === 0) return [numberIfSafe(result), pos];
      shift += 7n;
    }
    if (count >= 10) throw new Error('varint 过长');
    throw new Error('varint 截断');
  }

  /** Parse a protobuf buffer, returning [[fn, wt, value], ...]; throws on failure. */
  function parse(buf) {
    if (buf instanceof ArrayBuffer) buf = new Uint8Array(buf);
    var out = [];
    var pos = 0;
    while (pos < buf.length) {
      var r = readVarint(buf, pos);
      var key = r[0];
      if (typeof key === 'bigint') throw new Error('字段号过大');
      pos = r[1];
      var fn = Math.floor(key / 8);
      var wt = key & 7;
      if (fn === 0) throw new Error('字段号 0');
      if (wt === 0) {
        r = readVarint(buf, pos);
        out.push([fn, 0, r[0]]);
        pos = r[1];
      } else if (wt === 2) {
        r = readVarint(buf, pos);
        var len = r[0];
        if (typeof len === 'bigint') throw new Error('长度过大');
        pos = r[1];
        if (pos + len > buf.length) throw new Error('长度越界');
        out.push([fn, 2, buf.subarray(pos, pos + len)]);
        pos += len;
      } else if (wt === 5) {
        if (pos + 4 > buf.length) throw new Error('fixed32 越界');
        out.push([fn, 5, (buf[pos] | (buf[pos + 1] << 8) |
                          (buf[pos + 2] << 16) | (buf[pos + 3] << 24)) >>> 0]);
        pos += 4;
      } else if (wt === 1) {
        if (pos + 8 > buf.length) throw new Error('fixed64 越界');
        var fixed = 0n;
        for (var j = 0; j < 8; j++) fixed |= BigInt(buf[pos + j]) << BigInt(j * 8);
        out.push([fn, 1, numberIfSafe(fixed)]);
        pos += 8;
      } else {
        throw new Error('不支持的 wire type ' + wt);
      }
    }
    return out;
  }

  /** Return the value of the first matching field only; undefined if absent. */
  function get(buf, fn) {
    var fs = parse(buf);
    for (var i = 0; i < fs.length; i++) if (fs[i][0] === fn) return fs[i][2];
    return undefined;
  }

  /** Convert to a {fn: value} dictionary (for repeated field names, the last one wins). */
  function dict(buf) {
    var d = {};
    var fs = parse(buf);
    for (var i = 0; i < fs.length; i++) d[fs[i][0]] = fs[i][2];
    return d;
  }

  /** Decode a packed varint array. */
  function unpack(buf) {
    var out = [];
    var pos = 0;
    while (pos < buf.length) {
      var r = readVarint(buf, pos);
      out.push(r[0]);
      pos = r[1];
    }
    return out;
  }

  // ---------------------------------------------------------------- Encoding
  function varintBytes(n) {
    n = typeof n === 'bigint' ? n : BigInt(Math.trunc(n));
    n = BigInt.asUintN(64, n);
    var out = [];
    do {
      var b = Number(n & 0x7fn);
      n >>= 7n;
      out.push(n ? b | 0x80 : b);
    } while (n);
    return out;
  }

  /** Accumulating writer. */
  function Writer() { this.parts = []; this.len = 0; }
  Writer.prototype.raw = function (arr) {
    this.parts.push(arr);
    this.len += arr.length;
    return this;
  };
  Writer.prototype.tag = function (fn, wt) {
    return this.raw(varintBytes(fn * 8 + wt));
  };
  /** varint field */
  Writer.prototype.v = function (fn, n) {
    this.tag(fn, 0);
    return this.raw(varintBytes(n));
  };
  /** length-delimited field (bytes / sub-message / string) */
  Writer.prototype.s = function (fn, val) {
    if (typeof val === 'string') val = utf8(val);
    if (val instanceof Writer) val = val.bytes();
    this.tag(fn, 2);
    this.raw(varintBytes(val.length));
    return this.raw(val);
  };
  Writer.prototype.f32 = function (fn, n) {
    this.tag(fn, 5);
    return this.raw([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);
  };
  Writer.prototype.f64 = function (fn, n) {
    this.tag(fn, 1);
    n = typeof n === 'bigint' ? n : BigInt(Math.trunc(n));
    n = BigInt.asUintN(64, n);
    var out = [];
    for (var i = 0; i < 8; i++) {
      out.push(Number(n & 0xffn));
      n >>= 8n;
    }
    return this.raw(out);
  };
  /** Packed repeated varint (always packed, even for a single element, to match the original wire format) */
  Writer.prototype.packed = function (fn, list) {
    var body = [];
    for (var i = 0; i < list.length; i++) body = body.concat(varintBytes(list[i]));
    this.tag(fn, 2);
    this.raw(varintBytes(body.length));
    return this.raw(body);
  };
  Writer.prototype.bytes = function () {
    var out = new Uint8Array(this.len);
    var off = 0;
    for (var i = 0; i < this.parts.length; i++) {
      var p = this.parts[i];
      if (p instanceof Uint8Array) out.set(p, off);
      else for (var j = 0; j < p.length; j++) out[off + j] = p[j];
      off += p.length;
    }
    return out;
  };

  function W() { return new Writer(); }

  /** Re-encode one field with its original wire type (used when rewriting while preserving order). */
  function reencode(w, fn, wt, val) {
    if (wt === 0) return w.v(fn, val);
    if (wt === 2) return w.s(fn, val);
    if (wt === 5) return w.f32(fn, val);
    if (wt === 1) return w.f64(fn, val);
    throw new Error('不支持的 wire type ' + wt);
  }

  /** Change the varint value of field fn in blob to value (keeping field order); append it if absent. */
  function setVarint(blob, fn, value) {
    var w = W(), done = false;
    var fs = parse(blob);
    for (var i = 0; i < fs.length; i++) {
      var f = fs[i];
      if (f[0] === fn && f[1] === 0) {
        if (!done) { w.v(fn, value); done = true; }
      } else reencode(w, f[0], f[1], f[2]);
    }
    if (!done) w.v(fn, value);
    return w.bytes();
  }

  /** Change the bytes value of field fn in blob to value (keeping field order); append it if absent. */
  function setBytes(blob, fn, value) {
    var w = W(), done = false;
    var fs = parse(blob);
    for (var i = 0; i < fs.length; i++) {
      var f = fs[i];
      if (f[0] === fn && f[1] === 2) {
        if (!done) { w.s(fn, value); done = true; }
      } else reencode(w, f[0], f[1], f[2]);
    }
    if (!done) w.s(fn, value);
    return w.bytes();
  }

  // ---------------------------------------------------------------- Utilities
  function utf8(str) {
    if (global.TextEncoder) return new TextEncoder().encode(str);
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return new Uint8Array(out);
  }

  function fromUtf8(buf) {
    if (global.TextDecoder) return new TextDecoder().decode(buf);
    var s = '';
    for (var i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]);
    return s;
  }

  function b64decode(s) {
    var bin = global.atob(s);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function eq(a, b) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  MJ.proto = {
    parse: parse, get: get, dict: dict, unpack: unpack,
    W: W, Writer: Writer, reencode: reencode,
    setVarint: setVarint, setBytes: setBytes,
    utf8: utf8, fromUtf8: fromUtf8, b64decode: b64decode, eq: eq
  };
})(typeof window !== 'undefined' ? window : globalThis);
