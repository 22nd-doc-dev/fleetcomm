"use strict";
const assert = require("assert");
const { channelName } = require("../src/channel-name");
assert.strictEqual(channelName("ATC / DECK"), "ATC - DECK", "display slash maps to relay-safe name");
assert.strictEqual(channelName("  MEDICAL  "), "MEDICAL");
assert.strictEqual(channelName("<bad>&name"), "-bad--name");
console.log("✔ CHANNEL NAME PASS — display names resolve to the same relay names the seeder creates");
