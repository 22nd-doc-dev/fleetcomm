"use strict";
const assert = require("assert");
const varint = require("../src/varint");

for (const value of [0, 1, 127, 128, 16383, 16384, 0x1fffff, 0x200000,
  0x0fffffff, 0x10000000, 0x7fffffff, 0xffffffff]) {
  const encoded = varint.encode(value);
  const decoded = varint.decode(encoded, 0);
  assert(decoded && decoded.value === value && decoded.length === encoded.length,
    "uint32 round-trip failed for " + value);
  assert.strictEqual(varint.decode(encoded.subarray(0, encoded.length - 1), 0), null,
    "truncated value must wait for more bytes");
}
for (const bad of [-1, 1.5, Number.NaN, 0x100000000]) {
  assert.throws(() => varint.encode(bad), RangeError);
}
assert.strictEqual(varint.decode(Buffer.alloc(0), 0), null);
console.log("✔ VARINT PASS — boundaries round-trip and malformed inputs fail closed");
