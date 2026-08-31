"use strict";
/* Dead-link detection, RUN.
 *
 * A black-holed TCP path (NAT table expiry, network change mid-op) used to
 * take 10-16 minutes to surface: writes buffer forever, no error, no close —
 * the net looked tuned while the operator sat in silence and the relink loop
 * could not fire. The server echoes every 5s keepalive, so receive-silence is
 * the tell. Two live checks against fake-murmur:
 *   1. a healthy link with echoes flowing must NOT be declared dead
 *   2. a link the server goes silent on must close within seconds
 */
const assert = require("assert");
const path = require("path");
const { spawn } = require("child_process");
const { MumbleClient } = require("../src/mumble-client");

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let k = 0; const ok = (m) => console.log("  ✓ " + m, ++k);

function startFake(env) {
  const child = spawn(process.execPath, [path.join(__dirname, "fake-murmur.js")], {
    env: Object.assign({}, process.env, { FAKEMURMUR_PORT: "0" }, env || {}),
    stdio: ["ignore", "pipe", "inherit"]
  });
  const state = { child };
  state.ready = new Promise((res, rej) => {
    const dead = setTimeout(() => rej(new Error("fake-murmur produced no ready line in 10s")), 10000);
    child.on("exit", (code) => rej(new Error("fake-murmur exited early (code " + code + ")")));
    child.stdout.on("data", d => {
      const up = /ready on 127\.0\.0\.1:(\d+)/.exec(String(d));
      if (up) { clearTimeout(dead); state.port = Number(up[1]); res(); }
    });
  });
  return state;
}

(async () => {
  /* ── 1. echoes keep a healthy link alive ── */
  const healthy = startFake();
  await healthy.ready;
  try {
    const c = new MumbleClient({ host: "127.0.0.1", port: healthy.port, username: "DOC|265.000", deadAfterMs: 8000 });
    let closed = false;
    c.on("close", () => { closed = true; });
    await c.connect();
    await sleep(12000);   /* two+ echo cycles past deadAfterMs — dies here iff echoes aren't counted */
    assert(!closed, "a link with ping echoes flowing must never be declared dead");
    c.disconnect();
    ok("healthy link survives well past the silence threshold (echoes count as life)");
  } finally { healthy.child.kill(); }

  /* ── 2. a silent link dies in seconds, not minutes ── */
  const mute = startFake({ FAKEMURMUR_MUTE_AFTER_MS: "1000" });
  await mute.ready;
  try {
    const c = new MumbleClient({ host: "127.0.0.1", port: mute.port, username: "DOC|265.000", deadAfterMs: 6000 });
    const t0 = Date.now();
    const closedAt = new Promise(res => c.on("close", () => res(Date.now() - t0)));
    c.on("error", () => {});      /* the dead-link error — surfaced via close */
    await c.connect();
    const elapsed = await Promise.race([closedAt, sleep(30000).then(() => -1)]);
    assert(elapsed !== -1, "a silent link must be closed by the client, not ride TCP for minutes");
    assert(elapsed >= 6000, "and not before the silence threshold (closed at " + elapsed + "ms)");
    assert(elapsed < 20000, "detection is prompt (closed at " + elapsed + "ms)");
    ok("black-holed link surfaced as a close in " + (elapsed / 1000).toFixed(1) + "s — relink can do its job");
  } finally { mute.child.kill(); }

  console.log("\n✔ DEAD LINK PASS — silence is detected while the op is still going");
})().catch(error => { console.error("✘ FAIL:", error); process.exitCode = 1; });
