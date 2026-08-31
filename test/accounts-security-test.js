"use strict";
const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const port = 9200 + Math.floor(Math.random() * 300);
const base = "http://127.0.0.1:" + port;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleetcomm-account-security-"));
let service;

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
      DATA_DIR: dataDir, RELAY_PASSWORD: "relay-test", BOOTSTRAP_TOKEN: "boot-test", ACL_SYNC_DISABLED: "1" }),
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
  let result = await api("POST", "/api/login", { mockId: "attacker", mockName: "Race" });
  assert(result.status === 403 && result.body.bootstrapRequired, "random first user cannot claim COMMAND");
  result = await api("POST", "/api/login", { mockId: "doc", mockName: "Doc", bootstrapToken: "boot-test" });
  assert(result.status === 200 && result.body.account.role === "command", "setup code claims COMMAND");
  const sessionToken = result.body.token;
  const sessionsFile = path.join(dataDir, "sessions.json");
  assert((fs.statSync(sessionsFile).mode & 0o777) === 0o600, "session file mode is 600");
  const sessions = JSON.parse(fs.readFileSync(sessionsFile, "utf8"));
  assert(sessions[sessionToken].expiresAt > Date.now(), "session has an explicit expiry");
  const accounts = JSON.parse(fs.readFileSync(path.join(dataDir, "accounts.json"), "utf8"));
  assert(/^u-[0-9a-f]{36}$/.test(accounts.doc.relayToken), "account receives a unique relay token");

  /* ── shared 1MC sound library: COMMAND-only in both directions, round-trips ── */
  result = await api("POST", "/api/login", { mockId: "rating", mockName: "Rating" });
  const ratingToken = result.body.token;
  result = await api("GET", "/api/sounds", null, ratingToken);
  assert(result.status === 403, "non-COMMAND cannot even list the fleet clip library");
  const clipData = Buffer.from("RIFF-not-really-audio-but-bytes-are-bytes").toString("base64");
  result = await api("POST", "/api/sounds", { name: "boatswain call.wav", data: clipData }, sessionToken);
  assert(result.status === 200 && /^[a-f0-9]{16}$/.test(result.body.id), "COMMAND uploads a clip: " + JSON.stringify(result.body));
  const clipId = result.body.id;
  result = await api("POST", "/api/sounds", { name: "orders.txt", data: clipData }, sessionToken);
  assert(result.status === 400, "a non-audio extension is refused");
  result = await api("POST", "/api/sounds", { name: "boatswain call.wav", data: clipData }, sessionToken);
  assert(result.status === 400, "a duplicate clip name is refused");
  result = await api("GET", "/api/sounds", null, sessionToken);
  assert(result.body.sounds.length === 1 && result.body.sounds[0].name === "boatswain call.wav", "the library lists it");
  result = await api("GET", "/api/sounds/" + clipId, null, sessionToken);
  assert(result.body.ok && result.body.data === clipData, "clip bytes round-trip exactly");
  result = await api("POST", "/api/sounds/" + clipId + "/delete", null, ratingToken);
  assert(result.status === 403, "non-COMMAND cannot delete a clip");
  result = await api("POST", "/api/sounds/" + clipId + "/delete", null, sessionToken);
  assert(result.status === 200, "COMMAND deletes a clip");
  result = await api("GET", "/api/sounds", null, sessionToken);
  assert(result.body.sounds.length === 0, "and it is gone from the library");

  await stop();
  sessions[sessionToken].expiresAt = Date.now() - 1;
  fs.writeFileSync(sessionsFile, JSON.stringify(sessions), { mode: 0o600 });
  await start();
  result = await api("GET", "/api/me", null, sessionToken);
  assert(result.status === 401, "expired bearer token is rejected after restart");
  console.log("✔ ACCOUNTS SECURITY PASS — guarded bootstrap, private state, expiring sessions");
})().catch(error => { console.error("✘ FAIL:", error); process.exitCode = 1; })
  .finally(async () => { await stop(); fs.rmSync(dataDir, { recursive: true, force: true }); });
