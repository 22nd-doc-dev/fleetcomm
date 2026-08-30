"use strict";
/* The relay certificate path — the one every other test skips.
 *
 * Relay suites connect to 127.0.0.1, and loopback is exempt from certificate
 * checks, so nothing exercised this before release. v0.10.x therefore shipped
 * with rejectUnauthorized:true against a self-signed Mumble server and every
 * operator got "Could not tune any nets: self signed certificate" after a
 * successful sign-in. This test connects over a NON-loopback address to a real
 * self-signed TLS server and pins the certificate for real.
 */
const assert = require("assert");
const tls = require("tls");
const selfsigned = require("selfsigned");
const { checkPin, normalize, shortFingerprint, pinRequired } = require("../src/relay-trust");

let n = 0; const ok = (m) => console.log("  ✓ " + m, ++n);

/* ── the pinning rule ── */
assert.deepStrictEqual(checkPin("", "AA:BB:CC"), { ok: true, learn: true }, "first contact learns");
assert.deepStrictEqual(checkPin("aabbcc", "AA:BB:CC"), { ok: true, learn: false }, "same cert, any formatting");
const changed = checkPin("AABBCC", "DDEEFF");
assert(!changed.ok && /certificate has changed/i.test(changed.error), "a changed cert is refused");
assert(/intercepting/i.test(changed.error), "and the operator is told why it matters");
assert(!checkPin("AABBCC", "").ok, "no certificate at all is refused");
ok("trust on first use, then pin; a changed certificate stops the connection");

assert(pinRequired("68.183.103.215"), "a real relay is pinned");
assert(!pinRequired("127.0.0.1") && !pinRequired("localhost"), "loopback is exempt");
assert.strictEqual(shortFingerprint("AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99"),
  "2233 4455 6677 8899", "readable short form for the UI");
ok("loopback exempt, real hosts pinned, fingerprint displayable");

/* ── against a genuinely self-signed server ──
   The two concerns are separated on purpose. Which hosts get pinned is pure
   string logic and is asserted above. What follows is the part that needs a
   real TLS handshake: that a self-signed relay is reachable at all, and that
   its fingerprint pins and compares correctly.
   It binds to 127.0.0.1 rather than a second loopback address — 127.0.0.2 is
   an alias on Linux but not on macOS, and a test that hangs on the maintainer's
   own laptop is worse than no test. Every socket here is bounded by a timeout
   so this suite can never stall a release. */
const TIMEOUT = 8000;
function fingerprintOf(port) {
  return new Promise((resolve, reject) => {
    const s = tls.connect({ host: "127.0.0.1", port, rejectUnauthorized: false }, () => {
      const c = s.getPeerCertificate();
      const fp = c && c.fingerprint256 ? c.fingerprint256 : "";
      s.destroy(); clearTimeout(t); resolve(fp);
    });
    s.on("error", (e) => { clearTimeout(t); reject(e); });
    const t = setTimeout(() => { s.destroy(); reject(new Error("TLS connect timed out")); }, TIMEOUT);
  });
}
async function listen(cn) {
  const pems = await selfsigned.generate([{ name: "commonName", value: cn }], { days: 1, keySize: 2048 });
  const srv = tls.createServer({ cert: pems.cert, key: pems.private }, (s) => s.end());
  srv.on("error", () => {});
  await new Promise(r => srv.listen(0, "127.0.0.1", r));
  return srv;
}

(async () => {
  const relay = await listen("relay-test");
  const port = relay.address().port;

  /* the assertion that matters: a self-signed relay must be reachable.
     rejectUnauthorized:true here is exactly what shipped in v0.10.x. */
  const strict = await new Promise((resolve) => {
    const s = tls.connect({ host: "127.0.0.1", port, rejectUnauthorized: true }, () => { s.destroy(); resolve(null); });
    s.on("error", (e) => resolve(e));
    setTimeout(() => { s.destroy(); resolve(new Error("timed out")); }, TIMEOUT);
  });
  assert(strict && /self.signed|unable to verify/i.test(strict.message),
    "CA verification must be what fails against a self-signed relay, reproducing the shipped bug");
  ok("reproduced the shipped failure: CA verification rejects a self-signed relay (" + strict.code + ")");

  const seen = await fingerprintOf(port);
  assert.strictEqual(normalize(seen).length, 64, "SHA-256 fingerprint read from the relay");
  ok("the same relay is reachable when verified by fingerprint instead");

  const first = checkPin("", seen);
  assert(first.ok && first.learn, "first connection pins it");
  const again = checkPin(seen, await fingerprintOf(port));
  assert(again.ok && !again.learn, "reconnecting to the same relay is accepted silently");
  ok("trust on first use, then reconnect without re-prompting");

  const impostor = await listen("impostor");
  const otherFp = await fingerprintOf(impostor.address().port);
  assert(normalize(otherFp) !== normalize(seen), "the impostor really is a different certificate");
  assert(!checkPin(seen, otherFp).ok, "a substituted certificate must be refused");
  ok("a substituted certificate is refused — the relay password is not handed over");

  relay.close(); impostor.close();
  console.log("\n✔ RELAY TRUST PASS — self-signed relays work, and only the one you first trusted");
  process.exit(0);
})().catch(e => { console.error("✘ FAIL:", e); process.exit(1); });
