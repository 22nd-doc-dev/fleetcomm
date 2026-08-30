"use strict";
/* Trusting the relay's certificate.
 *
 * Mumble servers almost universally present a self-signed certificate — that is
 * normal for the protocol, not a misconfiguration. Two wrong answers exist:
 *
 *   rejectUnauthorized: true   → refuses to connect to any ordinary Mumble
 *                                server at all. This is what shipped in
 *                                v0.10.x and it broke every operator with
 *                                "self signed certificate".
 *   rejectUnauthorized: false  → connects to anything, verifies nothing, and
 *                                hands the relay password to whoever answers.
 *
 * So we do what real Mumble clients do: trust on first use, then pin. The first
 * connection records the certificate's SHA-256 fingerprint; every later
 * connection must present the same one. A changed fingerprint stops the
 * connection and says so plainly, because on an unchanged server it means
 * someone is between you and the relay.
 *
 * Pure functions, no Electron, no sockets — the certificate path is the one
 * thing every relay test skips, because tests run on loopback.
 */

function normalize(fp) {
  return String(fp || "").toUpperCase().replace(/[^0-9A-F]/g, "");
}

/* expected: the pinned fingerprint we stored (or "" the first time)
   seen:     what the server just presented
   → { ok, learn, error } */
function checkPin(expected, seen) {
  const want = normalize(expected), got = normalize(seen);
  if (!got) return { ok: false, learn: false, error: "the relay presented no certificate" };
  if (!want) return { ok: true, learn: true };                    /* first contact — remember it */
  if (want === got) return { ok: true, learn: false };
  return {
    ok: false, learn: false,
    error: "the relay's certificate has changed since you last connected. " +
           "If the server was genuinely reinstalled this is expected — clear the pinned " +
           "certificate in Settings to accept the new one. If it was not, stop: something " +
           "is intercepting the connection."
  };
}

/* Short form for display: last 16 hex digits, grouped. */
function shortFingerprint(fp) {
  const n = normalize(fp);
  return n ? n.slice(-16).replace(/(.{4})(?=.)/g, "$1 ") : "";
}

/* Loopback regenerates certificates freely and never crosses a network, so it
   is exempt: pinning it would just make local testing noisy. */
function pinRequired(host) {
  return !["127.0.0.1", "::1", "localhost"].includes(String(host || ""));
}

module.exports = { normalize, checkPin, shortFingerprint, pinRequired };
