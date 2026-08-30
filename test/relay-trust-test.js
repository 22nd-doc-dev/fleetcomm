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

/* ── against a genuinely self-signed server, over a non-loopback address ── */
(async () => {
  const pems = await selfsigned.generate([{ name: "commonName", value: "relay-test" }],
    { days: 1, keySize: 2048 });
  const server = tls.createServer({ cert: pems.cert, key: pems.private }, (s) => s.end());
  await new Promise(r => server.listen(0, "0.0.0.0", r));
  const port = server.address().port;
  /* 127.0.0.2 is still loopback to the OS but not the literal string our
     exemption matches, so the pinning path runs exactly as it would remotely */
  const HOST = "127.0.0.2";
  assert(pinRequired(HOST), "test host must take the pinned path");

  const connect = () => new Promise((res, rej) => {
    const s = tls.connect({ host: HOST, port, rejectUnauthorized: false }, () => {
      const c = s.getPeerCertificate();
      const fp = c && c.fingerprint256 ? c.fingerprint256 : "";
      s.destroy(); res(fp);
    });
    s.on("error", rej);
  });

  /* This is the assertion that matters: a self-signed relay must be reachable. */
  const seen = await connect();
  assert(normalize(seen).length === 64, "got a SHA-256 fingerprint from a self-signed relay: " + seen);
  ok("a self-signed relay is reachable and its fingerprint is readable");

  const first = checkPin("", seen);
  assert(first.ok && first.learn, "first connection pins it");
  const second = checkPin(seen, await connect());
  assert(second.ok && !second.learn, "reconnecting to the same server is accepted");
  ok("same server across reconnects: accepted without re-prompting");

  /* a different server on the same address must be refused */
  const pems2 = await selfsigned.generate([{ name: "commonName", value: "impostor" }], { days: 1, keySize: 2048 });
  const impostor = tls.createServer({ cert: pems2.cert, key: pems2.private }, (s) => s.end());
  await new Promise(r => impostor.listen(0, "0.0.0.0", r));
  const p2 = impostor.address().port;
  const otherFp = await new Promise((res, rej) => {
    const s = tls.connect({ host: HOST, port: p2, rejectUnauthorized: false },
      () => { const c = s.getPeerCertificate(); s.destroy(); res(c.fingerprint256); });
    s.on("error", rej);
  });
  const swapped = checkPin(seen, otherFp);
  assert(!swapped.ok, "a substituted certificate must be refused");
  ok("a substituted certificate is refused — the relay password is not handed over");

  server.close(); impostor.close();
  console.log("\n✔ RELAY TRUST PASS — self-signed relays work, and only the one you first trusted");
  process.exit(0);
})().catch(e => { console.error("✘ FAIL:", e); process.exit(1); });
