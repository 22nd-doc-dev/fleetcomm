"use strict";
/* Flight-stick buttons as first-class binds.
 *
 * The keyboard hook never sees a HOTAS — Oak's stick PTT from QLink did
 * nothing in FleetComm. The Gamepad API path turns polled button states into
 * the same events the bind engine speaks; these are the pure decisions.
 */
const assert = require("assert");
const { padKey, padLabel, pressedStates, diffButtons } = require("../src/pad-binds");

let k = 0; const ok = (m) => console.log("  ✓ " + m, ++k);

/* ── identity survives replugging ── */
const CHROME_ID = "T.16000M (Vendor: 044f Product: b10a)";
assert.strictEqual(padKey(CHROME_ID), padKey(CHROME_ID.replace(/\s+/g, "  ")),
  "whitespace quirks don't change the key");
assert(padKey("").length > 0, "an empty id still yields a usable key");
ok("bind identity keys on the device id, not the enumeration index");

/* ── labels are for operators, not USB descriptors ── */
assert.strictEqual(padLabel(CHROME_ID, 5), "T.16000M B5", "vendor/product hex is stripped: " + padLabel(CHROME_ID, 5));
assert.strictEqual(padLabel("Xbox 360 Controller (STANDARD GAMEPAD Vendor: 045e Product: 028e)", 2),
  "XBOX 360 CONTROLLE B2", "long names truncate but stay recognisable");
assert.strictEqual(padLabel(undefined, 0), "STICK B0", "a nameless device still gets a label");
ok("labels read like a control, not a device descriptor");

/* ── analog triggers count as buttons ── */
assert.deepStrictEqual(
  pressedStates([{ pressed: true, value: 1 }, { pressed: false, value: 0.3 }, { pressed: false, value: 0.7 }, null]),
  [true, false, true, false],
  "digital press, sub-threshold analog, past-threshold analog, missing entry");
ok("a half-pulled HOTAS trigger keys the net; a resting one doesn't");

/* ── transitions, not states, drive the engine ── */
assert.deepStrictEqual(diffButtons([false, false], [true, false]), [{ button: 0, down: true }], "press");
assert.deepStrictEqual(diffButtons([true, false], [false, false]), [{ button: 0, down: false }], "release");
assert.deepStrictEqual(diffButtons([true, false], [true, false]), [], "held button repeats nothing");
assert.deepStrictEqual(diffButtons(undefined, [true, false, true]), [],
  "first sight of a device is its baseline — stuck bits (VelocityOne holds 23 and 26 forever) and the waking press emit nothing");
assert.deepStrictEqual(diffButtons([true, false, true], [true, true, true]), [{ button: 1, down: true }],
  "after the baseline, only real transitions fire — a permanently-held bit never becomes a bind");
assert.deepStrictEqual(diffButtons([true], []), [{ button: 0, down: false }],
  "a vanished device releases its held buttons instead of wedging PTT open");
ok("state diffs give one clean event per transition — no repeats, no stuck keys");

console.log("\n✔ PAD BINDS PASS — stick buttons behave exactly like keys, including the edge cases");
