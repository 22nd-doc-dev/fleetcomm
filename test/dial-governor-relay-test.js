"use strict";
/* The rate-limit incident, RUN — not reasoned about.
 *
 * 2026-08-31: an operator was locked out by "the relay is rate-limiting
 * connections from your network", permanently — the relink loops kept dialing
 * on cadences that re-armed murmur's per-IP autoban every time it lifted.
 *
 * This drives the REAL RadioStack against fake-murmur with its autoban armed
 * (murmur-faithful: N accepted connections per window bans the N+1th, then
 * drop-at-accept for a fixed ban; attempts while banned are not recorded):
 *   1. WITHOUT a governor, a naive retry loop re-trips the ban — proving this
 *      test can see the failure mode;
 *   2. WITH the governor, the ban trips once, every further retry is refused
 *      locally (zero relay traffic), and the stack heals after the hold.
 * No mumble-server needed; runs anywhere node runs. Port is OS-assigned so
 * parallel runs never collide.
 */
const assert = require("assert");
const path = require("path");
const tls = require("tls");
const { spawn } = require("child_process");
const { RadioStack } = require("../src/radio-stack");
const { createGovernor } = require("../src/dial-governor");

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let k = 0; const ok = (m) => console.log("  ✓ " + m, ++k);

function startFake(env) {
  const child = spawn(process.execPath, [path.join(__dirname, "fake-murmur.js")], {
    env: Object.assign({}, process.env, { FAKEMURMUR_PORT: "0" }, env || {}),
    stdio: ["ignore", "pipe", "inherit"]
  });
  const state = { child, trips: 0 };
  state.ready = new Promise((res, rej) => {
    /* a fake that can't start must FAIL the test fast, never hang it */
    const dead = setTimeout(() => rej(new Error("fake-murmur produced no ready line in 10s")), 10000);
    child.on("exit", (code) => rej(new Error("fake-murmur exited early (code " + code + ")")));
    child.stdout.on("data", (d) => {
      const line = String(d);
      const up = /ready on 127\.0\.0\.1:(\d+)/.exec(line);
      if (up) { clearTimeout(dead); state.port = Number(up[1]); res(); }
      const m = /AUTOBAN TRIPPED #(\d+)/.exec(line);
      if (m) state.trips = Number(m[1]);
    });
  });
  return state;
}
/* trip counts arrive over the child's stdout — wait for them, don't guess */
async function tripsReach(fake, n, ms) {
  const deadline = Date.now() + ms;
  while (fake.trips < n && Date.now() < deadline) await sleep(100);
  return fake.trips >= n;
}

/* dial the way another client on the network would */
function rawDial(port) {
  return new Promise(res => {
    const s = tls.connect({ host: "127.0.0.1", port, rejectUnauthorized: false, timeout: 2000 },
      () => { s.destroy(); res(); });
    s.on("error", () => res());
    s.on("timeout", () => { s.destroy(); res(); });
  });
}

const NET = { name: "COMMAND NET", channel: "COMMAND NET", freq: "265.000" };

(async () => {
  /* autoban 3,6,5: the 4th accepted connection inside 6s bans for 5s */
  const fake = startFake({ FAKEMURMUR_AUTOBAN: "3,6,5" });
  await fake.ready;
  try {
    /* ── 1. the disease: a naive retry loop re-trips the ban ── */
    for (let i = 0; i < 4; i++) await rawDial(fake.port);
    assert(await tripsReach(fake, 1, 5000), "the guard trips like murmur's");
    const naive = new RadioStack({ host: "127.0.0.1", port: fake.port, callsign: "NAIVE" });
    const naiveCap = Date.now() + 30000;         /* condition-driven, generous cap */
    while (fake.trips < 2 && Date.now() < naiveCap) {
      try { await naive.tune(NET); } catch (e) { await sleep(300); }
    }
    naive.destroy();
    assert(await tripsReach(fake, 2, 3000),
      "without a governor, retrying re-trips the lifted ban (trips=" + fake.trips + ")");
    ok("reproduced: naive retry cadence keeps the relay's guard tripped");

    /* ── 2. the cure: the governor holds until the ban lifts, then heals ── */
    await sleep(5200);                           /* let the naive run's ban lift */
    const tripsBefore = fake.trips;
    const governor = createGovernor({
      maxAttempts: 6, windowMs: 8000, paceMs: 50,
      resetTrip: 2, resetTripWindowMs: 8000,
      holdMs: 6000, holdGrowth: 2, holdMaxMs: 30000   /* hold outlasts the 5s ban */
    });
    for (let i = 0; i < 4; i++) await rawDial(fake.port);   /* someone else re-trips it */
    assert(await tripsReach(fake, tripsBefore + 1, 5000), "ban active again for the governed run");

    const stack = new RadioStack({ host: "127.0.0.1", port: fake.port, callsign: "DOC", governor });
    let held = 0; stack.on("dial-hold", () => held++);
    let idx = null, localRefusals = 0;
    const deadline = Date.now() + 25000;
    while (idx == null && Date.now() < deadline) {   /* the renderer's relink shape */
      try { idx = await stack.tune(NET); }
      catch (e) { if (/^relay hold/.test(e.message)) localRefusals++; }
      await sleep(300);
    }
    assert(idx != null, "the stack heals on its own once the ban lifts");
    assert(held === 1, "the circuit opened exactly once (dial-hold emitted " + held + "x)");
    assert(localRefusals > 5, "held retries were refused locally, not sent to the relay (" + localRefusals + " refusals)");
    assert.strictEqual(fake.trips, tripsBefore + 1,
      "the governed client NEVER re-trips the ban (trips stayed at " + fake.trips + ")");
    stack.destroy();
    ok("governed: ban trips once, retries stay local, connection heals after the hold");

    console.log("\n✔ DIAL GOVERNOR RELAY PASS — the ban is outwaited and the operator gets back on comms");
  } finally { fake.child.kill(); }
})().catch(error => { console.error("✘ FAIL:", error); process.exitCode = 1; });
