"use strict";
/* Ship groups: a ship is not a channel you sit in, it is a group of nets you can
 * hear and reach all at once.
 *
 *   LSN ALL — receive every net under the ship WITHOUT tuning any of them
 *   TX ALL  — transmit to every net under the ship, likewise
 *
 * The point of the design is that neither depends on the subnets being tuned,
 * and that a whole ship costs ONE relay connection rather than one per subnet —
 * which is also what keeps an operator clear of murmur's per-IP connection rate
 * guard.
 */
const assert = require("assert");
const OpusScript = require("opusscript");
const { RadioStack } = require("../src/radio-stack");
const cfg = require("../config/22nd-package.json");

const HOST = "127.0.0.1", PORT = 64738;
const tiber = cfg.nets.find(n => n.name === "UEES TIBER");
const subnets = tiber.subnets.map(s => s.name);
const bridge = tiber.subnets.find(s => s.name === "TIBER BRIDGE");
const deck = tiber.subnets.find(s => s.name === "TIBER DECK");
const outside = cfg.nets.find(n => n.name === "EMERGENCY NET");
const wait = (ms) => new Promise(r => setTimeout(r, ms));

function frames(n) {
  const enc = new OpusScript(48000, 1, OpusScript.Application.VOIP);
  const pcm = Buffer.alloc(960 * 2);
  for (let i = 0; i < 960; i++) pcm.writeInt16LE(Math.round(Math.sin(i / 48000 * 2 * Math.PI * 440) * 8000), i * 2);
  const out = [];
  for (let i = 0; i < n; i++) out.push(Buffer.from(enc.encode(pcm, 960)));
  enc.delete();
  return out;
}

(async () => {
  /* the ship group: ONE connection for the whole ship */
  const ship = new RadioStack({ host: HOST, port: PORT, callsign: "TIBER-ACTUAL" });
  const gIdx = await ship.tune(tiber);
  assert.strictEqual(ship.nets.length, 1, "a ship group is a single connection, not one per subnet");
  console.log("1) ship group holds " + ship.nets.length + " connection for " + (subnets.length) + " subnets ✓");

  /* operators sitting on individual subnets */
  const onBridge = new RadioStack({ host: HOST, port: PORT, callsign: "BRIDGE-WATCH" });
  const onDeck = new RadioStack({ host: HOST, port: PORT, callsign: "DECK-WATCH" });
  const elsewhere = new RadioStack({ host: HOST, port: PORT, callsign: "MEDIC" });
  const bIdx = await onBridge.tune(bridge);
  const dIdx = await onDeck.tune(deck);
  const oIdx = await elsewhere.tune(outside);
  await wait(500);

  /* ── LSN ALL ── */
  const listened = ship.listenAll(gIdx, subnets);
  assert(listened >= 2, "listeners registered for the ship's subnets (" + listened + ")");
  await wait(500);

  const heard = [];
  ship.on("rx", (r) => heard.push(r.chan || "(unknown)"));

  for (const f of frames(8)) { onBridge.txFrame(bIdx, f, false, false); await wait(20); }
  onBridge.txFrame(bIdx, frames(1)[0], true, false);
  await wait(400);
  for (const f of frames(8)) { onDeck.txFrame(dIdx, f, false, false); await wait(20); }
  onDeck.txFrame(dIdx, frames(1)[0], true, false);
  await wait(400);
  for (const f of frames(8)) { elsewhere.txFrame(oIdx, f, false, false); await wait(20); }
  await wait(500);

  const fromBridge = heard.filter(c => c === "BRIDGE").length;
  const fromDeck = heard.filter(c => c === "DECK").length;
  const fromOutside = heard.filter(c => c === outside.name).length;
  console.log("2) LSN ALL heard → BRIDGE:" + fromBridge + " DECK:" + fromDeck + " outside-the-ship:" + fromOutside);
  assert(fromBridge > 0, "LSN ALL must hear BRIDGE without tuning it");
  assert(fromDeck > 0, "LSN ALL must hear DECK without tuning it");
  assert.strictEqual(fromOutside, 0, "LSN ALL must NOT pull in nets outside the ship");
  console.log("   every subnet heard, nothing outside the ship leaked in ✓");

  /* ── TX ALL ── */
  assert(ship.armBroadcast(gIdx), "TX ALL target armed");
  await wait(400);
  const got = { bridge: 0, deck: 0, outside: 0 };
  onBridge.on("rx", () => got.bridge++);
  onDeck.on("rx", () => got.deck++);
  elsewhere.on("rx", () => got.outside++);
  for (const f of frames(10)) { ship.txFrame(gIdx, f, false, true); await wait(20); }
  await wait(700);
  console.log("3) TX ALL reached →", JSON.stringify(got));
  assert(got.bridge >= 5 && got.deck >= 5, "TX ALL must reach every subnet");
  assert.strictEqual(got.outside, 0, "TX ALL must stay inside the ship");
  console.log("   reached every subnet, stayed inside the ship ✓");

  /* ── and it is opt-in: dropping the listeners stops the audio ── */
  assert(ship.unlistenAll(gIdx), "listeners dropped");
  await wait(500);
  const before = heard.length;
  for (const f of frames(8)) { onBridge.txFrame(bIdx, f, false, false); await wait(20); }
  await wait(600);
  assert.strictEqual(heard.length, before, "LSN ALL off means the ship hears nothing further");
  console.log("4) LSN ALL off → subnet traffic stops ✓");

  ship.destroy(); onBridge.destroy(); onDeck.destroy(); elsewhere.destroy();
  console.log("\n✔ SHIP GROUP PASS — hear and reach a whole ship without tuning any of it, on one connection");
  process.exit(0);
})().catch(e => { console.error("✘ FAIL:", e); process.exit(1); });
