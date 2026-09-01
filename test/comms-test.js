"use strict";
/* v0.5 proof: text chat between stacks + simulcast TX to two nets at once. */
const assert = require("assert");
const OpusScript = require("opusscript");
const { RadioStack } = require("../src/radio-stack");
const cfg = require("../config/22nd-package.json");

(async () => {
  const doc = new RadioStack({ host: "127.0.0.1", port: 64738, callsign: "DOC-T5" });
  const gully = new RadioStack({ host: "127.0.0.1", port: 64738, callsign: "GULLY-T5" });
  const dCmd = await doc.tune(cfg.nets[0]);   // COMMAND NET
  const dMed = await doc.tune(cfg.nets[1]);   // EMERGENCY NET
  const gCmd = await gully.tune(cfg.nets[0]);
  const gMed = await gully.tune(cfg.nets[1]);
  await new Promise(r => setTimeout(r, 400));

  /* 1) chat */
  const chats = [];
  gully.on("chat", (m) => chats.push(m));
  doc.sendText(dMed, "MEDICAL check — how copy?");
  await new Promise(r => setTimeout(r, 600));
  console.log("1) chat received:", JSON.stringify(chats));
  assert(chats.length === 1 && chats[0].idx === gMed && /how copy/.test(chats[0].message) && /DOC-T5/.test(chats[0].from), "chat routed to right net w/ sender");

  /* 2) simulcast: doc TXes BOTH nets at once; gully hears on both slots */
  const rx = { [gCmd]: 0, [gMed]: 0 };
  gully.on("rx", (r) => { rx[r.idx] = (rx[r.idx] || 0) + 1; });
  const enc = new OpusScript(48000, 1, OpusScript.Application.VOIP);
  const pcm = Buffer.alloc(1920);
  for (let i = 0; i < 960; i++) pcm.writeInt16LE(Math.round(Math.sin(i / 48000 * 2 * Math.PI * 500) * 8000), i * 2);
  for (let k = 0; k < 10; k++) {
    const f = Buffer.from(enc.encode(pcm, 960));
    doc.txFrame(dCmd, f, k === 9); doc.txFrame(dMed, f, k === 9);
    await new Promise(r => setTimeout(r, 20));
  }
  await new Promise(r => setTimeout(r, 500));
  console.log("2) simulcast rx counts:", JSON.stringify(rx));
  assert(rx[gCmd] >= 8 && rx[gMed] >= 8, "frames arrived on BOTH nets");

  /* 3) atcView sees the org */
  const view = doc.atcView();
  const cmdBox = view.find(c => c.name === "COMMAND NET");
  console.log("3) atcView channels:", view.length, "· COMMAND NET occupants:", cmdBox && cmdBox.users.join(","));
  assert(view.length >= 8 && cmdBox && cmdBox.users.length >= 2, "atc view populated");

  doc.destroy(); gully.destroy();
  console.log("✔ COMMS PASS — chat routing, simulcast TX, ATC view");
  process.exit(0);
})().catch(e => { console.error("✘ FAIL:", e); process.exit(1); });
