"use strict";
const assert = require("assert");
const { createGovernor } = require("../src/dial-governor");

/* virtual clock — the governor is pure, so every timing rule tests instantly */
let t = 1000000;
const clock = () => t;
const mk = (over) => createGovernor(Object.assign({ now: clock }, over));

(async () => {
  /* ── the budget: never more dials per window than murmur tolerates ── */
  let g = mk({ maxAttempts: 3, windowMs: 10000, paceMs: 0 });
  assert(g.acquire().ok && g.acquire().ok && g.acquire().ok, "budget grants up to the limit");
  let r = g.acquire();
  assert(!r.ok && r.reason === "window" && r.retryInMs > 0, "the dial past the budget is refused locally");
  t += 10001;
  assert(g.acquire().ok, "the window slides and dialing resumes");

  /* ── pacing: a recovery herd is spread out, not fired as a burst ── */
  g = mk({ paceMs: 1100 });
  assert.strictEqual(g.acquire().waitMs, 0, "first dial goes immediately");
  const second = g.acquire();
  assert(second.ok && second.waitMs >= 1100, "second concurrent dial is paced behind the first");
  const third = g.acquire();
  assert(third.ok && third.waitMs >= 2200, "each concurrent dial reserves its own slot");

  /* ── the ban signature: consecutive pre-auth resets open the circuit ── */
  g = mk({ holdMs: 90000, resetTrip: 2 });
  assert(g.acquire().ok, "dial 1 granted");
  assert.strictEqual(g.outcome("reset"), null, "one reset alone proves nothing");
  t += 4000;
  assert(g.acquire().ok, "dial 2 granted");
  const trip = g.outcome("reset");
  assert(trip && trip.heldForMs === 90000, "the second reset in quick succession opens the circuit");
  r = g.acquire();
  assert(!r.ok && r.reason === "ban-hold", "while held, every dial is refused before it costs the relay anything");
  assert(g.state().reason === "ban-hold" && g.state().holdMs > 0, "state exposes the hold for the UI");

  /* ── escalation: still banned on re-entry? hold longer than last time ── */
  t += 90001;
  assert(g.acquire().ok, "hold expired — one probe goes out");
  g.outcome("reset"); t += 1000; g.acquire();
  const trip2 = g.outcome("reset");
  assert(trip2 && trip2.heldForMs === 180000, "a re-trip doubles the hold (outlasts a fixed-length ban eventually)");

  /* ── success clears the slate ── */
  t += 180001;
  assert(g.acquire().ok, "post-hold dial granted");
  g.outcome("ok");
  g.acquire(); g.outcome("reset"); t += 1000; g.acquire();
  const trip3 = g.outcome("reset");
  assert(trip3 && trip3.heldForMs === 90000, "a successful connection resets the escalation ladder");

  /* ── relay DOWN is not a ban: refusals and timeouts never open the circuit ── */
  g = mk({ resetTrip: 2 });
  for (let i = 0; i < 4; i++) { if (g.acquire().ok) assert.strictEqual(g.outcome("other"), null); t += 2000; }
  assert.strictEqual(g.state().reason, "clear", "ECONNREFUSED/timeout hold nothing — that's an outage, not a ban");

  /* ── resets far apart don't trip (a restart yesterday is not a ban today) ── */
  g = mk({ resetTrip: 2, resetTripWindowMs: 45000 });
  g.acquire(); g.outcome("reset");
  t += 46000;
  g.acquire();
  assert.strictEqual(g.outcome("reset"), null, "stale resets age out of the trip window");

  /* ── the hold cap ── */
  g = mk({ holdMs: 90000, holdGrowth: 2, holdMaxMs: 200000, resetTrip: 1 });
  g.acquire(); assert.strictEqual(g.outcome("reset").heldForMs, 90000);
  t += 90001; g.acquire(); assert.strictEqual(g.outcome("reset").heldForMs, 180000);
  t += 180001; g.acquire(); assert.strictEqual(g.outcome("reset").heldForMs, 200000, "escalation caps");

  /* ── refusals are FREE — the invariant the whole design rests on ──
     The relink loops keep polling on their own cadence; if a refused acquire
     consumed budget or advanced pacing, the polling itself would pin the
     window full and the governor would become the lockout. */
  g = mk({ maxAttempts: 3, windowMs: 10000, paceMs: 0 });
  const first = t;
  g.acquire(); g.acquire(); g.acquire();          /* window exhausted at t=first */
  for (let i = 0; i < 200; i++) {
    t += 30;                                       /* hammer far faster than any real loop */
    const refused = g.acquire();
    assert(!refused.ok && refused.reason === "window", "every over-budget acquire refuses");
    assert(refused.retryInMs >= 1000, "window retry advice keeps its 1s floor");
    assert(g.state().reason === "window", "state() reports the window while it is full");
  }
  t = first + 10001;                               /* the ORIGINAL window ends on schedule */
  assert(g.acquire().ok, "200 hammered refusals moved nothing — the window still opened on time");

  /* ── a hold is never extended by asking ── */
  g = mk({ resetTrip: 1, holdMs: 50000 });
  g.acquire(); g.outcome("reset");                 /* circuit open 50s */
  let prev = Infinity;
  for (let i = 0; i < 40; i++) {
    t += 1000;
    const r = g.acquire();
    assert(!r.ok && r.reason === "ban-hold" && r.retryInMs < prev, "the hold only ever counts DOWN");
    prev = r.retryInMs;
  }
  t += 11000;
  assert(g.acquire().ok, "and lifts exactly on schedule");

  /* ── the SHIPPED DEFAULTS, replayed against the incident ──
     7 uncoordinated loops (6 net relinks + control) on the real 4→60s ladder
     produced 35 attempts/120s ungoverned — a guaranteed murmur ban. The same
     shape through a default-config governor must never trip a murmur model
     (ban when a rolling 120s window exceeds 10 accepted connections). */
  {
    const gov = createGovernor({ now: clock });     /* DEFAULTS, virtual clock */
    const backoff = (n) => Math.min(60000, 4000 * Math.pow(2, Math.min(4, n - 1)));
    const loops = Array.from({ length: 7 }, (_, i) => ({ nextAt: t + 4000 + i * 250, tries: 1 }));
    const granted = [];
    const end = t + 600000;                         /* a 10-minute outage */
    while (true) {
      const due = loops.reduce((a, b) => a.nextAt < b.nextAt ? a : b);
      if (due.nextAt > end) break;
      t = due.nextAt;
      const r = gov.acquire();
      if (r.ok) { granted.push(t + r.waitMs); gov.outcome("other"); }  /* relay down ≠ ban */
      due.tries++; due.nextAt = t + backoff(due.tries);
    }
    for (const at of granted) {
      const inWindow = granted.filter(x => x > at - 120000 && x <= at).length;
      assert(inWindow <= 10, "the governed incident never exceeds murmur's threshold (saw " + inWindow + " in 120s)");
    }
    assert(granted.length > 10, "and the relay is still genuinely probed throughout (" + granted.length + " dials in 10min)");
    const { DEFAULTS } = require("../src/dial-governor");
    assert(DEFAULTS.maxAttempts <= 8, "budget keeps headroom under murmur's 10");
    let ladder = DEFAULTS.holdMs, total = 0;
    while (ladder < 300000 && ladder < DEFAULTS.holdMaxMs) { total += ladder; ladder = Math.min(DEFAULTS.holdMaxMs, ladder * DEFAULTS.holdGrowth); }
    assert(ladder >= 300000, "the hold ladder reaches past a 300s murmur ban (the old 45s cap never could)");
  }

  /* ── the wiring contract: both dial paths consult the gate, and the hold
        message is exactly what the renderer parses ── */
  {
    const { RadioStack } = require("../src/radio-stack");
    const gov = mk({ resetTrip: 1, holdMs: 240000 });
    gov.acquire(); gov.outcome("reset");            /* circuit open: every dial refused */
    const stack = new RadioStack({ host: "127.0.0.1", callsign: "DOC", governor: gov });
    const rendererRegex = /^relay hold\b[^]*?(\d+)s/i;   /* keep in step with renderer/app.js */
    for (const dial of [() => stack.tune({ name: "X", channel: "X", freq: "1" }), () => stack.connectControl("ORG")]) {
      let msg = null;
      await dial().catch(e => { msg = e.message; });
      const m = rendererRegex.exec(msg || "");
      assert(m && Math.abs(Number(m[1]) - 240) <= 1, "the hold message carries seconds the renderer can read: " + msg);
    }
    /* the ban classifier: pre-auth resets trip, refusals/timeouts never do */
    const gov2 = mk({ resetTrip: 2 });
    const s2 = new RadioStack({ host: "127.0.0.1", callsign: "DOC", governor: gov2 });
    let holds = 0; s2.on("dial-hold", () => holds++);
    for (const boring of ["connect ECONNREFUSED 1.2.3.4:64738", "relay handshake timed out", "Server rejected: WrongUserPW"])
      { gov2.acquire(); s2._dialOutcome(new Error(boring)); t += 1000; }
    assert.strictEqual(holds, 0, "refused/unreachable/rejected never open the circuit");
    for (const bannish of ["read ECONNRESET", "Client network socket disconnected before secure TLS connection was established"])
      { gov2.acquire(); s2._dialOutcome(new Error(bannish)); t += 1000; }
    assert.strictEqual(holds, 1, "two pre-auth resets open it exactly once");
  }

  console.log("✔ DIAL GOVERNOR PASS — one budget for every dial, and a ban is outwaited, not hammered");
})().catch(error => { console.error("✘ FAIL:", error); process.exit(1); });
