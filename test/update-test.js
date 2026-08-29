"use strict";
/* Proof that the auto-updater cannot force-close/reopen in a loop.
 *
 * The failure this guards against, seen in the field on v0.9.x: the swap
 * script relaunched the app whether or not the exe was actually replaced, so a
 * failed swap came back on the OLD version, saw the same newer release, and
 * tried again — forever.
 */
const assert = require("assert");
const { cmpVer, reconcile, blocked, attempt } = require("../src/update-guard");

let n = 0;
const ok = (m) => console.log("  ✓ " + m, ++n);

/* ── version comparison ── */
assert(cmpVer("0.9.1", "0.9.0") > 0);
assert(cmpVer("0.9.0", "0.9.1") < 0);
assert(cmpVer("0.10.0", "0.9.9") > 0, "0.10 must beat 0.9 — string compare would get this wrong");
assert(cmpVer("v1.0.0", "1.0.0") === 0, "a leading v is tolerated");
assert(cmpVer("1.0", "1.0.0") === 0, "missing patch counts as zero");
ok("version comparison");

/* ── the happy path: the update lands ── */
{
  const st = attempt("0.9.1");
  assert(st.target === "0.9.1" && st.fails === 0);
  const r = reconcile("0.9.1", st, false);        /* we came back as the new version */
  assert(r.note.installed === "0.9.1", "reports the install");
  assert(!r.state.target, "slate is wiped so the next version starts clean");
  assert(!blocked(r.state, "0.9.2"), "a later version is still eligible");
  ok("successful update is recorded and the slate cleared");
}

/* ── the loop: swap fails, app returns on the old version ── */
{
  let state = attempt("0.9.1");
  assert(!blocked(state, "0.9.1"), "first automatic attempt is allowed");

  /* relaunch #1 — still 0.9.0, so the swap didn't take */
  let r = reconcile("0.9.0", state, false);
  state = r.state;
  assert(r.note.failed, "failure is surfaced, not swallowed");
  assert(blocked(state, "0.9.1"), "THE LOOP IS BROKEN: no second automatic attempt");

  /* however many times it comes back up, it must never auto-retry that version */
  for (let i = 0; i < 25; i++) {
    r = reconcile("0.9.0", state, false);
    state = r.state;
    assert(blocked(state, "0.9.1"), "still blocked on pass " + i);
  }
  assert(state.fails >= 26, "each return is counted");
  ok("a failed swap can never spin — one automatic try per version, ever");

  /* the operator is still free to install it by hand, and a LATER release
     is not punished for the failure of an earlier one */
  assert(!blocked(state, "0.9.2"), "a newer version is still eligible for auto-install");
  ok("a later release is not blocked by an earlier failure");
}

/* ── the script told us explicitly that it failed ── */
{
  const r = reconcile("0.9.0", attempt("0.9.1"), true);
  assert(/swap couldn't complete/.test(r.note.reason), "uses the explicit reason: " + r.note.reason);
  ok("--update-failed flag gives the operator the real reason");
}

/* ── no attempt on record: nothing to report, nothing blocked ── */
{
  const r = reconcile("0.9.0", {}, false);
  assert(r.note === null, "quiet when no update was attempted");
  assert(!blocked(r.state, "0.9.1"), "and nothing is blocked");
  ok("a clean install reports nothing");
}

/* ── a downgrade or sidegrade still counts as landed ── */
{
  const r = reconcile("1.0.0", attempt("0.9.1"), false);
  assert(r.note.installed === "0.9.1", "running newer than the target means it landed");
  ok("running ahead of the target counts as installed");
}

console.log("\n✔ UPDATE GUARD PASS — a failed swap falls back to the banner instead of looping");
process.exit(0);
