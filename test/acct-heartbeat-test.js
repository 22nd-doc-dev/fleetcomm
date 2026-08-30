"use strict";
/* The account heartbeat must never eject an operator over a transport blip.
 *
 * One ECONNRESET out of ~300 polls an hour used to tear down every tuned net
 * and the Discord session, while the voice sockets rode the same blip out on
 * TCP retransmit. Only a server VERDICT (expired session, revoked access) may
 * sign an operator out; a request that never completed proves nothing.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { assess, WARN_AFTER } = require("../src/acct-heartbeat");

/* ── a healthy poll is a healthy poll ── */
let v = assess({ ok: true, authorized: true, account: { role: "member" } }, 0);
assert.strictEqual(v.action, "ok");
assert.strictEqual(v.fails, 0);

/* ── transport failure: hold, never eject ── */
v = assess({ ok: false, transport: true, error: "read ECONNRESET" }, 0);
assert.strictEqual(v.action, "hold", "an ECONNRESET must not sign the operator out");
assert.strictEqual(v.fails, 1);
assert.strictEqual(v.warn, false, "a single blip is not worth an operator-facing warning");

/* even a long outage holds — revocation propagates when the service returns */
for (let fails = 0, i = 0; i < 50; i++) {
  v = assess({ ok: false, transport: true, error: "service timeout" }, fails);
  assert.strictEqual(v.action, "hold", "poll " + i + ": sustained outage still must not eject");
  fails = v.fails;
}

/* ── the warning fires exactly once, at the threshold ── */
v = assess({ ok: false, transport: true, error: "read ECONNRESET" }, WARN_AFTER - 1);
assert.strictEqual(v.warn, true, "the operator is told once the outage is clearly not a one-off");
v = assess({ ok: false, transport: true, error: "read ECONNRESET" }, WARN_AFTER);
assert.strictEqual(v.warn, false, "and is not nagged every 12s afterwards");

/* ── recovery resets the failure count ── */
v = assess({ ok: true, authorized: true, account: { role: "member" } }, 7);
assert.strictEqual(v.action, "ok");
assert.strictEqual(v.fails, 0, "one good poll forgives the streak");

/* ── server verdicts still eject, with operator-readable reasons ── */
v = assess({ ok: false, error: "unauthorized" }, 0);
assert.strictEqual(v.action, "eject", "an expired session is a verdict, not a blip");
assert(/session expired/i.test(v.reason), "and the toast explains it instead of saying 'unauthorized'");
assert(!/ECONNRESET|unauthorized/.test(v.reason), "no raw error codes in an operator-facing toast");

v = assess({ ok: false, error: "access revoked by COMMAND" }, 3);
assert.strictEqual(v.action, "eject");
assert(/revoked/i.test(v.reason));

v = assess({ ok: true, authorized: false, account: { role: "pending" } }, 0);
assert.strictEqual(v.action, "eject", "losing relay authorization is a verdict even with ok:true");

v = assess(null, 2);
assert.strictEqual(v.action, "eject", "a malformed result fails closed, not open");

/* ── the wiring exists: main flags transport failures, the renderer uses the
      verdict, and a dropped control connection schedules its own relink ── */
const mainSrc = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
const appSrc = fs.readFileSync(path.join(__dirname, "..", "renderer", "app.js"), "utf8");
const stackSrc = fs.readFileSync(path.join(__dirname, "..", "src", "radio-stack.js"), "utf8");
const preload = fs.readFileSync(path.join(__dirname, "..", "src", "preload.js"), "utf8");
assert(/transport:\s*true/.test(mainSrc), "the acct IPC handler must flag transport failures");
assert(/acctHeartbeat\.assess/.test(appSrc), "pollOps must route results through the heartbeat verdict");
assert(!/if \(!current\.ok \|\| !current\.authorized\) \{\s*\$\("disconnBtn"\)/.test(appSrc),
  "the old eject-on-any-failure branch must be gone");
assert(/acctHeartbeat/.test(preload), "the module must be exposed through the preload bridge");
assert(/control-down/.test(stackSrc) && /control-down[\s\S]{0,600}relinkControl/.test(mainSrc),
  "a dropped control connection must schedule its own reconnect");
assert(/n\.dead = true; try \{ n\.client\.disconnect/.test(stackSrc),
  "destroy() must mark nets dead before closing sockets, so teardown is not a 'drop'");

console.log("✔ ACCT HEARTBEAT PASS — blips hold the line, only verdicts sign you out");
