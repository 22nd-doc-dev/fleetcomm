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

console.log("✔ RENDERER BOOTSTRAP PASS — Opus policy and fail-visible authentication startup are guarded");
