"use strict";
/*
 * Dial governor — one budget for every connection to the relay.
 *
 * murmur counts connection ATTEMPTS per IP (autobanAttempts inside
 * autobanTimeframe, default 10 inside 120s) and answers a violation by
 * dropping every connection from that address for autobanTime (default 300s),
 * at accept — before TLS — which the client sees as ECONNRESET.
 *
 * FleetComm dials from several independent places: sign-in, one relink loop
 * per dropped net, and main's control relink. Each is individually polite;
 * TOGETHER they can exceed the threshold (six nets healing after an outage is
 * 7 attempts in seconds, and every 60s thereafter), and none of them ever
 * held long enough to outlast a 300s ban — so the ban re-armed the moment it
 * lifted, forever. The operator-facing symptom: "the relay is rate-limiting
 * connections from your network", permanently.
 *
 * Every dial must pass through here first:
 *   - a rolling attempts-per-window budget stays well under murmur's default
 *   - consecutive pre-auth resets look like an active ban and open the
 *     circuit, escalating: refusals are LOCAL (no relay traffic) and the hold
 *     grows until it outlasts the ban
 *   - callers keep their own loops; a refused acquire costs the relay nothing
 *
 * Pure module: no sockets, no timers — callers pass outcomes in and read
 * delays out, so every rule here is testable headlessly.
 */

const DEFAULTS = {
  maxAttempts: 8,        /* dials allowed per window — murmur's default is 10 */
  windowMs: 120000,      /* murmur autobanTimeframe default */
  paceMs: 400,           /* minimum gap between dials, tames recovery herds */
  resetTrip: 2,          /* consecutive pre-auth resets that open the circuit */
  resetTripWindowMs: 45000,  /* ...if they land this close together */
  holdMs: 90000,         /* first circuit hold — short, deploys cause resets too */
  holdGrowth: 2,         /* every re-trip doubles the hold... */
  holdMaxMs: 720000      /* ...capped at 12 minutes */
};

function createGovernor(options) {
  const cfg = Object.assign({}, DEFAULTS, options || {});
  const now = cfg.now || Date.now;
  let attempts = [];         /* timestamps of granted dials */
  let lastDial = 0;
  let resets = [];           /* timestamps of pre-auth resets */
  let holdUntil = 0;
  let holdLevel = 0;

  function prune(t) {
    attempts = attempts.filter(x => t - x < cfg.windowMs);
    resets = resets.filter(x => t - x < cfg.resetTripWindowMs);
  }

  return {
    /* Ask permission to dial. Returns:
       { ok: true, waitMs }            — go, after waitMs of pacing (may be 0)
       { ok: false, retryInMs, reason } — do NOT dial; ask again later.
       A granted acquire consumes budget immediately, so concurrent callers
       cannot all reserve the same slot. */
    acquire() {
      const t = now();
      prune(t);
      if (t < holdUntil) {
        return { ok: false, retryInMs: holdUntil - t, reason: "ban-hold" };
      }
      if (attempts.length >= cfg.maxAttempts) {
        const retryInMs = attempts[0] + cfg.windowMs - t;
        return { ok: false, retryInMs: Math.max(1000, retryInMs), reason: "window" };
      }
      const waitMs = Math.max(0, lastDial + cfg.paceMs - t);
      lastDial = t + waitMs;
      attempts.push(t + waitMs);
      return { ok: true, waitMs };
    },

    /* Report how a granted dial ended:
       "ok"    — TLS + sync completed; the relay accepted this address
       "reset" — dropped before auth (ECONNRESET / hang up): the ban signature
       "other" — refused/unreachable/timeout: relay down, NOT a ban */
    outcome(kind) {
      const t = now();
      if (kind === "ok") { resets = []; holdLevel = 0; return null; }
      if (kind !== "reset") return null;
      resets.push(t);
      prune(t);
      if (resets.length >= cfg.resetTrip) {
        const hold = Math.min(cfg.holdMaxMs, cfg.holdMs * Math.pow(cfg.holdGrowth, holdLevel));
        holdLevel++;
        holdUntil = t + hold;
        resets = [];
        return { heldForMs: hold };   /* callers surface this to the operator */
      }
      return null;
    },

    /* for UI: how long until dialing is allowed again (0 = now) */
    state() {
      const t = now();
      prune(t);
      if (t < holdUntil) return { holdMs: holdUntil - t, reason: "ban-hold" };
      if (attempts.length >= cfg.maxAttempts)
        return { holdMs: Math.max(0, attempts[0] + cfg.windowMs - t), reason: "window" };
      return { holdMs: 0, reason: "clear" };
    }
  };
}

module.exports = { createGovernor, DEFAULTS };
