"use strict";
/* Long operations: nets must survive silence, and heal after a blip.
 *
 * A dropped net during a two-hour op leaves an operator silently off comms.
 * Two things matter and this checks both against a live relay:
 *
 *   1. There is NO idle or silence timeout. Nobody speaking for a long stretch
 *      must not cost you the net — what murmur actually drops you for is
 *      hearing NOTHING from your client for `timeout` seconds (30 by default).
 *      The client keepalive must therefore give plenty of margin under load.
 *   2. When a link really does drop, reconnecting must work.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { RadioStack } = require("../src/radio-stack");
const cfg = require("../config/22nd-package.json");

const HOST = "127.0.0.1", PORT = 64738;
const wait = (ms) => new Promise(r => setTimeout(r, ms));
let k = 0; const ok = (m) => console.log("  ✓ " + m, ++k);

(async () => {
  /* ── the keepalive gives real margin against murmur's 30s cutoff ── */
  const client = fs.readFileSync(path.join(__dirname, "..", "src", "mumble-client.js"), "utf8");
  const m = client.match(/this\.send\("Ping"[\s\S]{0,120}?\},\s*(\d+)\);/);
  assert(m, "the keepalive interval must be findable");
  const interval = Number(m[1]);
  const SERVER_TIMEOUT = 30000;
  assert(interval <= 10000, "keepalive is " + interval + "ms — too slack against a 30s server timeout");
  assert(SERVER_TIMEOUT / interval >= 5,
    "only " + (SERVER_TIMEOUT / interval) + " pings fit in the server's window; a single delayed timer under game load drops the net");
  ok("keepalive every " + interval + "ms — " + (SERVER_TIMEOUT / interval) + " chances inside murmur's 30s window");

  /* ── a silent net survives well past the server timeout ── */
  const doc = new RadioStack({ host: HOST, port: PORT, callsign: "QUIET-DOC" });
  const oak = new RadioStack({ host: HOST, port: PORT, callsign: "QUIET-OAK" });
  const dI = await doc.tune(cfg.nets[0]);
  const oI = await oak.tune(cfg.nets[0]);
  await wait(500);

  let down = false;
  doc.on("net-down", () => { down = true; });
  console.log("   holding a silent net for 40s (murmur's timeout is 30s)…");
  await wait(40000);
  assert(!down, "a net with nobody talking on it must NOT be dropped");
  const roster = doc.roster(dI).map(u => u.name);
  assert(roster.length >= 2, "and both operators are still on it: " + roster.join(", "));
  ok("40s of total silence: still connected, roster intact — there is no idle timeout");

  /* ── after a genuine drop, retuning works ── */
  oak.detune(oI);
  await wait(800);
  const again = await oak.tune(cfg.nets[0]);
  assert(again != null, "a dropped net can be retuned");
  await wait(600);
  assert(doc.roster(dI).length >= 2, "and the operator is back on the net");
  ok("a dropped net reconnects and rejoins the roster");

  /* ── the app schedules that reconnect itself, with backoff ── */
  const app = fs.readFileSync(path.join(__dirname, "..", "renderer", "app.js"), "utf8");
  assert(/scheduleRelink/.test(app) && /net-down[\s\S]{0,400}scheduleRelink/.test(app),
    "a lost link must schedule its own reconnect");
  assert(/Math\.min\(60000/.test(app), "with a capped backoff");
  assert(/Math\.random\(\)/.test(app), "and jitter, so several nets don't retry in lockstep");
  ok("the client reconnects automatically, backed off and staggered");

  doc.destroy(); oak.destroy();
  console.log("\n✔ KEEPALIVE PASS — silence never costs you a net, and a blip heals itself");
  process.exit(0);
})().catch(e => { console.error("✘ FAIL:", e); process.exit(1); });
