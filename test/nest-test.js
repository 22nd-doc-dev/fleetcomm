"use strict";
/* Proof: keying a PARENT net with nest broadcast armed reaches operators
   sitting on its SUBNETS — server-side fan-out, one transmission. */
const assert = require("assert");
const OpusScript = require("opusscript");
const { RadioStack } = require("../src/radio-stack");
const cfg = require("../config/22nd-package.json");

const tiber = cfg.nets.find(n => n.name === "UEES TIBER");
const bridge = tiber.subnets.find(s => s.name === "BRIDGE");
const deck = tiber.subnets.find(s => s.name === "DECK");

(async () => {
  const capt = new RadioStack({ host: "127.0.0.1", port: 64738, callsign: "CAPT-NEST" });
  const onBridge = new RadioStack({ host: "127.0.0.1", port: 64738, callsign: "BRIDGE-WATCH" });
  const onDeck = new RadioStack({ host: "127.0.0.1", port: 64738, callsign: "DECK-WATCH" });
  const outsider = new RadioStack({ host: "127.0.0.1", port: 64738, callsign: "MEDICAL-WATCH" });

  const pIdx = await capt.tune(tiber);           // parent
  const bIdx = await onBridge.tune(bridge);      // subnet
  const dIdx = await onDeck.tune(deck);          // subnet
  const oIdx = await outsider.tune(cfg.nets[1]); // MEDICAL — outside the nest
  await new Promise(r => setTimeout(r, 400));

  assert(capt.armBroadcast(pIdx), "broadcast target armed");
  await new Promise(r => setTimeout(r, 300));

  const got = { bridge: 0, deck: 0, outside: 0 };
  onBridge.on("rx", () => got.bridge++);
  onDeck.on("rx", () => got.deck++);
  outsider.on("rx", () => got.outside++);

  const enc = new OpusScript(48000, 1, OpusScript.Application.VOIP);
  const pcm = Buffer.alloc(1920);
  for (let i = 0; i < 960; i++) pcm.writeInt16LE(Math.round(Math.sin(i / 48000 * 2 * Math.PI * 420) * 8000), i * 2);
  for (let k = 0; k < 10; k++) {
    capt.txFrame(pIdx, Buffer.from(enc.encode(pcm, 960)), k === 9, true); // broadcast=true
    await new Promise(r => setTimeout(r, 20));
  }
  await new Promise(r => setTimeout(r, 600));

  console.log("nest broadcast rx →", JSON.stringify(got));
  assert(got.bridge >= 8, "BRIDGE (subnet) heard the parent transmission");
  assert(got.deck >= 8, "DECK (subnet) heard the parent transmission");
  assert(got.outside === 0, "MEDICAL (outside the nest) heard nothing");

  /* and without broadcast, subnets should NOT hear it */
  const got2 = { bridge: 0 };
  onBridge.removeAllListeners("rx");
  onBridge.on("rx", () => got2.bridge++);
  for (let k = 0; k < 8; k++) {
    capt.txFrame(pIdx, Buffer.from(enc.encode(pcm, 960)), k === 7, false); // normal TX
    await new Promise(r => setTimeout(r, 20));
  }
  await new Promise(r => setTimeout(r, 500));
  console.log("normal TX leak into subnet →", got2.bridge);
  assert(got2.bridge === 0, "without NEST armed, parent TX stays on the parent net");

  [capt, onBridge, onDeck, outsider].forEach(s => s.destroy());
  console.log("✔ NEST PASS — parent broadcast reaches every subnet, and only when armed");
  process.exit(0);
})().catch(e => { console.error("✘ FAIL:", e); process.exit(1); });
