"use strict";
/*
 * Account heartbeat verdicts.
 *
 * The renderer polls /api/me every 12 seconds while connected. That poll can
 * fail two very different ways, and they must not be treated the same:
 *
 *   - The SERVER answered and said no (session expired, access revoked, role
 *     gone). That is a verdict — the operator must be signed out.
 *   - The REQUEST never completed (ECONNRESET, timeout, a Wi-Fi roam, the game
 *     saturating the uplink for a second). That is a blip. Ejecting on it tore
 *     down every tuned net and the Discord session over one lost packet, while
 *     the voice connections themselves rode it out on TCP retransmit — the
 *     operator was kicked off comms that were still perfectly healthy.
 *
 * So transport failures hold: stay on comms, keep polling, and surface a
 * warning once the outage is clearly not a one-off. Only a verdict ejects.
 * Revocation still propagates: the moment the service is reachable again, the
 * next poll delivers it.
 */

/* consecutive transport failures before the operator is told about it —
 * 3 polls = ~36s, long enough that a single blip never warns */
const WARN_AFTER = 3;
/* re-warn during a sustained outage (every 25 polls = ~5min), so a broken
 * endpoint isn't hidden behind one easily-missed log line for hours */
const REWARN_EVERY = 25;

const REASONS = {
  /* "unauthorized" covers BOTH an expired session and a revocation — the
     server deletes a revoked account's sessions, so the heartbeat can't tell
     them apart. Say the session ended and let the re-login say why, rather
     than confidently claiming an expiry that may not be one. */
  unauthorized: "Your sign-in session has ended — sign in with Discord again.",
  "access revoked by COMMAND": "Your FleetComm access was revoked by COMMAND."
};

/*
 * result — what ipc "acct" returned: {ok, authorized, transport?, error?}
 * fails  — consecutive transport failures so far
 * Returns {action: "ok"|"hold"|"eject", fails, warn, reason}.
 */
function assess(result, fails) {
  const r = result || {};
  if (r.transport) {
    const next = (fails || 0) + 1;
    const warn = next === WARN_AFTER || (next > WARN_AFTER && next % REWARN_EVERY === 0);
    return { action: "hold", fails: next, warn, reason: "" };
  }
  if (!r.ok || !r.authorized) {
    const reason = REASONS[r.error] || r.error || "Your FleetComm access changed. Sign in again.";
    return { action: "eject", fails: 0, warn: false, reason };
  }
  return { action: "ok", fails: 0, warn: false, reason: "" };
}

module.exports = { assess, WARN_AFTER, REWARN_EVERY };
