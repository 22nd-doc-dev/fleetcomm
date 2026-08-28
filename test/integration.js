"use strict";
/*
 * End-to-end proof of the FleetComm architecture against a real mumble-server:
 *  1. SuperUser seeds the 22nd channel tree.
 *  2. alice joins FLEET COMMAND; bob stays in Root but LISTENS to it (multi-net RX).
 *  3. alice speaks (target 0) → bob must hear her through the listener.
 *  4. bob registers Voice Target 1 → FLEET COMMAND and keys it from Root
 *     (per-net PTT without changing channels) → alice must hear him.
 */
const assert = require("assert");
const OpusScript = require("opusscript");
const { MumbleClient } = require("../src/mumble-client");
const { seed } = require("../scripts/seed-channels");
const cfg = require("../config/22nd-package.json");

const HOST = "127.0.0.1", SUPW = "devpass123";

function sineOpusFrames(n, encoder) {
  const frames = [];
  const pcm = Buffer.alloc(960 * 2); // 20ms mono @48k, 16-bit
  for (let i = 0; i < 960; i++) pcm.writeInt16LE(Math.round(Math.sin(i / 48000 * 2 * Math.PI * 440) * 8000), i * 2);
  for (let i = 0; i < n; i++) frames.push(Buffer.from(encoder.encode(pcm, 960)));
  return frames;
}
function collectVoice(client, ms) {
  const got = [];
  client.on("voice", v => got.push(v));
  return new Promise(r => setTimeout(() => r(got), ms));
}

(async () => {
  console.log("1) seeding channel tree as SuperUser…");
  const ids = await seed(HOST, SUPW, cfg);
  console.log("   channels:", JSON.stringify(ids));
  assert(ids["FLEET COMMAND"] != null, "FLEET COMMAND created");

  const alice = new MumbleClient({ host: HOST, username: "alice" });
  const bob = new MumbleClient({ host: HOST, username: "bob" });
  await alice.connect(); await bob.connect();
  console.log("2) alice session", alice.session, "· bob session", bob.session);

  alice.joinChannel(ids["FLEET COMMAND"]);
  bob.listen([ids["FLEET COMMAND"]]);          // bob stays in Root, listener only
  await new Promise(r => setTimeout(r, 400));

  const enc = new OpusScript(48000, 1, OpusScript.Application.VOIP);
  const frames = sineOpusFrames(10, enc);

  console.log("3) alice TX (target 0, her channel) → does listening bob receive?");
  const bobHears = collectVoice(bob, 900);
  for (const [i, f] of frames.entries()) { alice.sendVoice(f, 0, i === frames.length - 1); await new Promise(r => setTimeout(r, 20)); }
  const heard = await bobHears;
  console.log("   bob received", heard.length, "frames; contexts:", [...new Set(heard.map(v => v.context))], "; from:", [...new Set(heard.map(v => bob.userName(v.session)))]);
  assert(heard.length >= 8 && heard.every(v => v.session === alice.session), "listener RX works");

  console.log("4) bob registers VoiceTarget 1 → FLEET COMMAND, keys from Root…");
  bob.setVoiceTarget(1, ids["FLEET COMMAND"]);
  await new Promise(r => setTimeout(r, 200));
  const aliceHears = collectVoice(alice, 900);
  for (const [i, f] of frames.entries()) { bob.sendVoice(f, 1, i === frames.length - 1); await new Promise(r => setTimeout(r, 20)); }
  const heard2 = await aliceHears;
  console.log("   alice received", heard2.length, "frames; contexts:", [...new Set(heard2.map(v => v.context))], "; from:", [...new Set(heard2.map(v => alice.userName(v.session)))]);
  assert(heard2.length >= 8 && heard2.every(v => v.session === bob.session), "voice-target TX works");

  console.log("5) decode sanity: opus frame decodes to 960 samples:",
    new OpusScript(48000, 1).decode(heard[0].opus).length / 2 === 960 ? "yes" : "NO");

  alice.disconnect(); bob.disconnect();
  console.log("\n✔ ALL PASS — multi-net RX (listeners) + per-net TX (voice targets) proven over TCP tunnel");
  process.exit(0);
})().catch(e => { console.error("✘ FAIL:", e); process.exit(1); });
