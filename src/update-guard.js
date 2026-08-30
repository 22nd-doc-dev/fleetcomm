"use strict";
/* The rule that keeps the auto-updater from spinning.
 *
 * A self-updater relaunches the app it just replaced. If the swap silently
 * fails, the relaunched app sees the same newer version on the server and tries
 * again — force-closing and reopening the old build forever. So the decision to
 * try automatically is not "is there a newer version?" but "is there a newer
 * version that hasn't already failed to install?".
 *
 * Every automatic attempt is recorded before handing off, and reconciled on the
 * way back up. One automatic try per version, ever. After that it's the banner,
 * where a person decides. Pure functions, no Electron, so the rule is testable.
 */

function cmpVer(a, b) {
  const pa = String(a).replace(/^v/, "").split(".").map(Number);
  const pb = String(b).replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

/* Called at startup. Returns the state to persist and what to tell the user. */
function reconcile(currentVersion, state, failedFlag) {
  const st = Object.assign({}, state || {});
  if (!st.target) {
    return { state: st, note: failedFlag ? { failed: true, reason: "the swap couldn't complete" } : null };
  }
  if (cmpVer(currentVersion, st.target) >= 0) {
    return { state: {}, note: { installed: st.target } };      /* it landed — clear the slate */
  }
  st.status = "failed";
  st.fails = Math.min(1000, (st.fails || 0) + 1);
  st.reason = st.reason || (failedFlag ? "the swap couldn't complete" : "the app restarted on the old version");
  return { state: st, note: { failed: true, target: st.target, reason: st.reason } };
}

/* May we install this version automatically, with no human in the loop? */
function blocked(state, version) {
  const st = state || {};
  return st.target === version && ["pending", "launched", "failed"].includes(st.status);
}

/* Recorded immediately before we hand off to the swap script. */
function attempt(version, automatic) {
  return { target: version, attemptedAt: Date.now(), automatic: !!automatic, status: "pending", fails: 0 };
}

/* Should this launch announce a version change, and require the operator to
   acknowledge it? Keyed on the last version the operator ACKNOWLEDGED — not on
   update-state.json, which only knows about swaps this app performed itself. A
   hand-installed exe changes the version without ever touching that state, and
   "did the update actually take?" must have a visible answer either way.
   ackVersion == null is a fresh install: nothing to announce, start tracking. */
function versionNote(ackVersion, currentVersion) {
  if (ackVersion == null) return { show: false, store: true };
  if (ackVersion === currentVersion) return { show: false, store: false };
  return { show: true, store: false, from: ackVersion, to: currentVersion,
           upgraded: cmpVer(currentVersion, ackVersion) > 0 };
}

module.exports = { cmpVer, reconcile, blocked, attempt, versionNote };
