"use strict";
/* Two full radio stacks (DOC and REAPER-1-DELTA) against the live server:
   DOC tunes FLEET COMMAND + MEDICAL, REAPER tunes MEDICAL only.
   REAPER keys MEDICAL → DOC must get RX attributed to his MEDICAL slot (idx 1), not FLEET COMMAND. */
const assert = require("assert");
const OpusScript = require("opusscript");
const { RadioStack } = require("../src/radio-stack");
const cfg = require("../config/22nd-package.json");

(async () => {
  const doc = new RadioStack({ host: "127.0.0.1", port: 64738, callsign: 'LT. R. "DOC" SABBAH' });
  const reaper = new RadioStack({ host: "127.0.0.1", port: 64738, callsign: "REAPER 1-DELTA" });

  await doc.tune(cfg.nets[0]);           // idx 0: FLEET COMMAND
  await doc.tune(cfg.nets[1]);           // idx 1: MEDICAL
  const rIdx = await reaper.tune(cfg.nets[1]); // MEDICAL

  const got = [];
  doc.on("rx", (r) => got.push(r));

  const enc = new OpusScript(48000, 1, OpusScript.Application.VOIP);
  const pcm = Buffer.alloc(1920);
  for (let i = 0; i < 960; i++) pcm.writeInt16LE(Math.round(Math.sin(i / 48000 * 2 * Math.PI * 300) * 8000), i * 2);
  for (let i = 0; i < 10; i++) { reaper.txFrame(rIdx, Buffer.from(enc.encode(pcm, 960)), i === 9); await new Promise(r => setTimeout(r, 20)); }
  await new Promise(r => setTimeout(r, 600));

  console.log("DOC received", got.length, "frames; net idx:", [...new Set(got.map(g => g.idx))], "; from:", [...new Set(got.map(g => g.name))]);
  assert(got.length >= 8, "frames arrived");
  assert(got.every(g => g.idx === 1), "attributed to MEDICAL slot only");
  assert(got.every(g => g.name.indexOf("REAPER") === 0), "callsign attribution");
  console.log("MEDICAL roster as DOC sees it:", doc.roster(1));

  doc.destroy(); reaper.destroy();
  console.log("✔ RadioStack PASS — per-net attribution + callsigns work");
  process.exit(0);
})().catch(e => { console.error("✘ FAIL:", e); process.exit(1); });
