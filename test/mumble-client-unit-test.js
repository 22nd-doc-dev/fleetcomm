"use strict";
const assert = require("assert");
const { MumbleClient, MSG } = require("../src/mumble-client");

const client = new MumbleClient({ host: "127.0.0.1", username: "unit" });
const writes = [];
client.sock = { destroyed: false, write(value) { writes.push(Buffer.from(value)); } };
client.sendVoice(Buffer.from([1, 2, 3]), 1, true);
assert.strictEqual(writes.length, 1);
assert.strictEqual(writes[0].readUInt16BE(0), MSG.UDPTunnel);
assert.throws(() => client.sendVoice(Buffer.alloc(0)), /13-bit/);
assert.throws(() => client.sendVoice(Buffer.alloc(0x2000)), /13-bit/);
console.log("✔ MUMBLE CLIENT UNIT PASS — voice framing rejects corrupt size boundaries");
