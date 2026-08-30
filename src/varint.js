"use strict";
/* Mumble varint (positive subset for encode; full decode) */
function encode(n) {
  if (!Number.isSafeInteger(n) || n < 0 || n > 0xffffffff) throw new RangeError("varint encode expects uint32");
  if (n < 0x80) return Buffer.from([n]);
  if (n < 0x4000) return Buffer.from([0x80 | (n >> 8), n & 0xff]);
  if (n < 0x200000) return Buffer.from([0xC0 | (n >> 16), (n >> 8) & 0xff, n & 0xff]);
  if (n < 0x10000000) return Buffer.from([0xE0 | (n >> 24), (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);
  const b = Buffer.alloc(5); b[0] = 0xF0; b.writeUInt32BE(n >>> 0, 1); return b;
}
/* returns {value, length} or null if buffer too short */
function decode(buf, off) {
  if (off >= buf.length) return null;
  const b0 = buf[off];
  if ((b0 & 0x80) === 0x00) return { value: b0, length: 1 };
  if ((b0 & 0xC0) === 0x80) {
    if (off + 2 > buf.length) return null;
    return { value: ((b0 & 0x3F) << 8) | buf[off + 1], length: 2 };
  }
  if ((b0 & 0xE0) === 0xC0) {
    if (off + 3 > buf.length) return null;
    return { value: ((b0 & 0x1F) << 16) | (buf[off + 1] << 8) | buf[off + 2], length: 3 };
  }
  if ((b0 & 0xF0) === 0xE0) {
    if (off + 4 > buf.length) return null;
    return { value: (((b0 & 0x0F) << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3]) >>> 0, length: 4 };
  }
  if ((b0 & 0xFC) === 0xF0) {
    if (off + 5 > buf.length) return null;
    return { value: buf.readUInt32BE(off + 1), length: 5 };
  }
  if ((b0 & 0xFC) === 0xF4) { /* 64-bit — return as Number (voice never needs it) */
    if (off + 9 > buf.length) return null;
    return { value: Number(buf.readBigUInt64BE(off + 1)), length: 9 };
  }
  if ((b0 & 0xFC) === 0xF8) { /* negative recursive */
    const inner = decode(buf, off + 1);
    if (!inner) return null;
    return { value: -inner.value, length: 1 + inner.length };
  }
  /* 0xFC: byte-inverted negative two-bit */
  return { value: -(b0 & 0x03) - 1, length: 1 };
}
module.exports = { encode, decode };
