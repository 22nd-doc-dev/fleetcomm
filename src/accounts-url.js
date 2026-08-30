"use strict";
/* Validating the accounts endpoint — and being honest about it.
 *
 * HTTPS is the right default and stays the default. But the 22nd's accounts
 * service has run as plain http on :8722 since day one, and v0.10.1 introduced
 * an HTTPS *requirement* in the same release that pointed the client at a TLS
 * endpoint nobody had deployed. The two changes only work together; shipped
 * apart they lock every operator out of the fleet — first with ECONNREFUSED on
 * :443, then with "accounts service must use HTTPS" once the address was
 * corrected.
 *
 * So plain http is permitted and *reported* rather than refused. The app shows
 * the exposure in Settings and logs it at sign-in, so nobody is unaware that
 * credentials cross the wire in the clear. When TLS is actually deployed, point
 * the endpoint at https and this warning disappears on its own.
 *
 * Pure functions, no Electron, so the rule is testable — the missing piece last
 * time was that nothing exercised this path before release.
 */

const LOOPBACK = ["127.0.0.1", "::1", "localhost"];

/* Throws for anything that isn't a usable http(s) endpoint. */
function accountBase(raw) {
  const u = new URL(String(raw || ""));
  if (u.protocol !== "https:" && u.protocol !== "http:")
    throw new Error("accounts service must use http:// or https://");
  return u;
}

/* True when credentials would travel unencrypted across a network.
   Loopback is exempt: it never leaves the machine. */
function isInsecure(raw) {
  try {
    const u = accountBase(raw);
    return u.protocol === "http:" && !LOOPBACK.includes(u.hostname);
  } catch (e) { return false; }
}

/* One short sentence for the UI, or "" when there is nothing to warn about. */
function insecureNote(raw) {
  return isInsecure(raw)
    ? "Unencrypted — sign-in and relay credentials cross the network in the clear."
    : "";
}

module.exports = { accountBase, isInsecure, insecureNote, LOOPBACK };
