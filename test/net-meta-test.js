"use strict";
const assert = require("assert");
const { decodeMeta, encodeMeta } = require("../src/net-meta");

const encoded = encodeMeta({ freq: "265.000", ship: true, ignored: "no" });
assert.deepStrictEqual(decodeMeta(encoded), { freq: "265.000", ship: true });
assert.deepStrictEqual(decodeMeta("Net 121.850 · ENCRYPTED"), { freq: "121.850", ship: null });
assert.deepStrictEqual(decodeMeta("untrusted description"), { freq: null, ship: null });
assert.deepStrictEqual(decodeMeta("FLEETCOMM_META:not-base64"), { freq: null, ship: null });
console.log("✔ NET META PASS — relay-persisted frequency and ship identity round-trip safely");
