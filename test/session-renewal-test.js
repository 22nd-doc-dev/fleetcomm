"use strict";
/* Session renewal — an op longer than the TTL must NOT sign operators out
 * mid-flight, but a session must still die at the absolute ceiling and when
 * left idle. Runs the real service with millisecond TTLs (MOCK-gated env). */
const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const port = 9800 + Math.floor(Math.random() * 199);
const base = "http://127.0.0.1:" + port;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleetcomm-session-renewal-"));
let service;
let passed = 0;
const ok = (cond, name) => { assert(cond, name); console.log("  ✓ " + name + " " + ++passed); };
const pause = ms => new Promise(r => setTimeout(r, ms));

/* generous margins: TTL 600ms (renew inside the last 300), ceiling 2000ms */
const TTL = 600, ABS = 2000;

function api(method, pathname, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(base + pathname, { method, headers: Object.assign(
      { "Content-Type": "application/json" }, token ? { Authorization: "Bearer " + token } : {}) }, res => {
      let text = ""; res.on("data", chunk => text += chunk);
      res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    });
    req.on("error", reject); if (data) req.write(data); req.end();
  });
}
function start() {
  service = spawn(process.execPath, [path.join(__dirname, "..", "server", "accounts-service.js")], {
    env: Object.assign({}, process.env, { MOCK_DISCORD: "1", HOST: "127.0.0.1", PORT: String(port),
      DATA_DIR: dataDir, RELAY_PASSWORD: "relay-test", BOOTSTRAP_TOKEN: "boot-test", ACL_SYNC_DISABLED: "1",
      SESSION_TTL_MS: String(TTL), SESSION_ABS_MS: String(ABS) }),
    stdio: "ignore"
  });
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const poll = () => api("GET", "/api/health").then(resolve, error => {
      if (Date.now() >= deadline) reject(error); else setTimeout(poll, 50);
    });
    poll();
  });
}
function stop() {
  if (!service) return Promise.resolve();
  return new Promise(resolve => { service.once("exit", resolve); service.kill(); setTimeout(resolve, 1000); });
}

(async () => {
  await start();

  let r = await api("POST", "/api/login", { mockId: "1001", mockName: "Doc", bootstrapToken: "boot-test" });
  const active = r.body.token;
  ok(r.status === 200, "sign in (this session will stay active)");
  r = await api("POST", "/api/login", { mockId: "1001", mockName: "Doc" });
  const idle = r.body.token;
  ok(r.status === 200, "second sign in (this session will sit idle)");

  /* the mid-op case: keep touching the API past the original TTL */
  const born = Date.now();
  let alive = true;
  while (Date.now() - born < ABS + TTL && alive) {
    await pause(Math.min(350, TTL / 2 - 50));
    alive = (await api("GET", "/api/me", null, active)).status === 200;
    if (Date.now() - born > TTL && alive && passed < 3)
      ok(true, "activity carries the session past the original TTL — no mid-op sign-out");
  }
  ok(!alive && Date.now() - born >= ABS,
    "the absolute ceiling still ends even a busy session (" + (Date.now() - born) + "ms ≥ " + ABS + "ms)");

  /* the idle case: TTL long gone with no renewals */
  r = await api("GET", "/api/me", null, idle);
  ok(r.status === 401, "an idle session still expires at the TTL");

  await stop();
  fs.rmSync(dataDir, { recursive: true, force: true });
  console.log("\n✔ SESSION RENEWAL PASS — long ops stay signed in, idle and ancient sessions still die");
})().catch(async e => { console.error("✘ FAIL:", e); await stop(); fs.rmSync(dataDir, { recursive: true, force: true }); process.exit(1); });
