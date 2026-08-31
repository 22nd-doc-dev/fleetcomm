"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const html = fs.readFileSync(path.join(__dirname, "..", "renderer", "index.html"), "utf8");
const config = require("../config/22nd-package.json");
const deployment = ["README.md", "server/deploy.sh", "server/setup-accounts.sh"]
  .map(file => fs.readFileSync(path.join(__dirname, "..", file), "utf8")).join("\n");

assert(/script-src[^;]*'unsafe-eval'/.test(html),
  "renderer CSP must permit opusscript's generated Emscripten bindings");
assert(/id="startupFail"/.test(html), "renderer has a fail-visible startup sentinel");
assert(/id="signLegacy" style="display:none"/.test(html),
  "legacy sign-in must stay hidden unless renderer initialization explicitly enables it");
const app = fs.readFileSync(path.join(__dirname, "..", "renderer", "app.js"), "utf8");
assert(/window\.addEventListener\("error"/.test(app) && /window\.addEventListener\("unhandledrejection"/.test(app),
  "renderer startup and asynchronous failures must be visible to the operator");
assert(config.accounts && /^https?:\/\//.test(config.accounts.url) && config.accounts.discordClientId,
  "production package enables Discord account mode");
/* The accounts endpoint must match what is actually LISTENING on the droplet.
   v0.10.1 shipped pointing at :443 for a TLS deployment that was never run, so
   every operator got "connect ECONNREFUSED 68.183.103.215:443" at sign-in.
   TLS was deployed 2026-08-30 (nginx on :443, LE shortlived IP certificate,
   plain :8722 loopback-only) and confirmed live before this line changed —
   which is the only order in which it may ever change. */
assert(config.server.host === "68.183.103.215" && config.accounts.url === "https://68.183.103.215",
  "production endpoints use the operator-controlled relay IP");
assert(!/22nd\.space/.test(JSON.stringify(config)), "production config must not depend on an unowned domain");
assert(!/22nd\.space/.test(deployment), "deployment instructions must not depend on an unowned domain");
assert(/--ip-address/.test(deployment) && /shortlived/.test(deployment),
  "deployment provisions a trusted short-lived certificate for the relay IP");

/* A 2026-08-30 autotest run against a real profile persisted 127.0.0.1 into
   hostOverride, and the app dialed the operator's own machine for two days —
   reported as a relay ban that never existed. Two guards must both hold:
   the startup heal that drops a loopback override outside the rig, and the
   persist path that clears (never just skips) an override equal to the
   shipped host, gated so the rig can never write host prefs at all. */
assert(/bridge\.autotestHost && \/\^\(127\\\./.test(app.replace(/!\s*/g, "!")) || /!bridge\.autotestHost[^\n]*127\\\./.test(app),
  "startup must heal a loopback hostOverride outside the autotest rig");
assert(/!bridge\.autotestHost[^\n]*store\.set\("hostOverride", host !== pkg\.server\.host \? host : ""\)/.test(app),
  "connecting on the shipped host must CLEAR a stale override, and the rig must never persist one");
{
  const healRe = /^(127\.|localhost$|::1$|\[::1\]$)/i;
  assert(healRe.test("127.0.0.1") && healRe.test("localhost") && healRe.test("::1"),
    "the heal recognizes every loopback spelling");
  assert(!healRe.test("68.183.103.215") && !healRe.test("relay.example.org"),
    "and never touches a real relay host");
}

console.log("✔ RENDERER BOOTSTRAP PASS — Opus policy and fail-visible authentication startup are guarded");
