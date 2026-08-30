"use strict";
/* Accounts service proof: approval queue, relay gate, roles, and SERVER-ENFORCED net access. */
const assert = require("assert");
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { MumbleClient } = require("../src/mumble-client");

const TESTPORT = 8890 + Math.floor(Math.random() * 100);
const BASE = "http://127.0.0.1:" + TESTPORT;
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
function api(method, path, bodyObj, token) {
  return new Promise((resolve, reject) => {
    const data = bodyObj ? JSON.stringify(bodyObj) : null;
    const req = http.request(BASE + path, { method, headers: Object.assign(
      { "Content-Type": "application/json" }, token ? { Authorization: "Bearer " + token } : {}) },
      (res) => { let d = ""; res.on("data", c => d += c); res.on("end", () => resolve(JSON.parse(d))); });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}
async function waitForService(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const health = await api("GET", "/api/health");
      if (health.ok) return;
    } catch (error) {}
    await wait(100);
  }
  throw new Error("accounts service did not become ready");
}
(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleetcomm-accounts-"));
  const svc = spawn(process.execPath, [path.join(__dirname, "..", "server", "accounts-service.js")], {
    env: Object.assign({}, process.env, {
      MOCK_DISCORD: "1", HOST: "127.0.0.1", PORT: String(TESTPORT), DATA_DIR: dataDir,
      SUPW: "devpass123", MUMBLE_HOST: "127.0.0.1",
      RELAY_PASSWORD: "gate-pw-test", BOOTSTRAP_TOKEN: "boot-test-only"
    }), stdio: "inherit"
  });
  /* Startup synchronizes ACLs for every descendant of the org root; that is
     intentionally fail-closed and can take several seconds on a fresh relay. */
  await waitForService(60000);

  /* 1. first login needs the out-of-band setup code; there is no first-user race */
  const status = await api("GET", "/api/status");
  assert(status.ok && status.initialized === false, "fresh service reports uninitialized");
  const race = await api("POST", "/api/login", { mockId: "9999", mockName: "Race" });
  assert(!race.ok && race.bootstrapRequired, "first random caller cannot claim COMMAND");
  const doc = await api("POST", "/api/login", { mockId: "1001", mockName: "Doc", bootstrapToken: "boot-test-only" });
  assert(doc.ok && doc.account.role === "command", "setup-code holder bootstraps command");
  assert(doc.relay && doc.relay.password === "gate-pw-test" && doc.relay.tokens.length === 1, "command gets relay creds + a unique token");
  console.log("1) guarded bootstrap COMMAND ✓  tokens:", doc.relay.tokens.length);
  assert((fs.statSync(path.join(dataDir, "sessions.json")).mode & 0o777) === 0o600, "session database is private");

  /* 2. second login = pending, NO relay creds */
  const gully = await api("POST", "/api/login", { mockId: "1002", mockName: "Gully" });
  assert(gully.ok && gully.account.role === "pending" && gully.relay === null, "pending is gated off the relay");
  console.log("2) pending gated ✓");

  /* 3. approve → member gets creds */
  const ap = await api("POST", "/api/accounts/1002/role", { role: "member" }, doc.token);
  assert(ap.ok && ap.account.role === "member");
  const me2 = await api("GET", "/api/me", null, gully.token);
  assert(me2.relay && me2.relay.password === "gate-pw-test" && me2.relay.tokens.length === 1, "member gets one unique relay token");
  assert(me2.relay.tokens[0] !== doc.relay.tokens[0], "accounts never share relay authority tokens");
  console.log("3) approve → member creds ✓");

  /* 4. member cannot admin */
  const deny = await api("GET", "/api/accounts", null, gully.token);
  assert(!deny.ok, "member blocked from admin routes");
  console.log("4) admin routes gated ✓");

  /* 5. net access = command → server-enforced */
  const set = await api("POST", "/api/nets/access", { net: "COMMAND NET", level: "command" }, doc.token);
  assert(set.ok, "acl applied: " + JSON.stringify(set));
  const memberTok = me2.relay.tokens, cmdTok = doc.relay.tokens;
  const probeM = new MumbleClient({ host: "127.0.0.1", username: "probe-member", tokens: memberTok });
  const probeC = new MumbleClient({ host: "127.0.0.1", username: "probe-cmd", tokens: cmdTok });
  await probeM.connect(); await probeC.connect();
  await wait(350);
  const chan = probeM.channelByName("COMMAND NET");
  probeM.joinChannel(chan); probeC.joinChannel(chan);
  await new Promise(r => setTimeout(r, 600));
  const mAt = (probeM.users.get(probeM.session) || {}).channelId || 0;
  const cAt = (probeC.users.get(probeC.session) || {}).channelId || 0;
  console.log("5) member landed in channel", mAt, "· command landed in", cAt, "(target", chan + ")");
  assert(cAt === chan, "command role may enter");
  assert(mAt !== chan, "member role DENIED by relay");
  probeM.disconnect(); probeC.disconnect();

  /* 6. revoke removes the account's unique token from relay ACLs */
  await api("POST", "/api/accounts/1002/role", { role: "revoked" }, doc.token);
  const back = await api("POST", "/api/login", { mockId: "1002", mockName: "Gully" });
  assert(!back.ok, "revoked cannot log in");
  const retained = new MumbleClient({ host: "127.0.0.1", username: "probe-revoked", tokens: memberTok });
  await retained.connect(); await new Promise(r => setTimeout(r, 350));
  const retainedChan = retained.channelByName("COMMAND NET");
  retained.joinChannel(retainedChan); await new Promise(r => setTimeout(r, 600));
  const retainedAt = (retained.users.get(retained.session) || {}).channelId || 0;
  assert(retainedAt !== retainedChan, "a retained pre-revocation token no longer passes relay ACLs");
  retained.disconnect();
  console.log("6) revoke invalidates retained relay authority ✓");

  /* restore open access for other suites */
  await api("POST", "/api/nets/access", { net: "COMMAND NET", level: "open" }, doc.token);

  svc.kill();
  /* The service deliberately gates the org root.  Remove that test-only ACL
     after the assertions so a local relay is not left locked for the next run. */
  const cleanup = new MumbleClient({ host: "127.0.0.1", port: 64738, username: "SuperUser", password: "devpass123" });
  await cleanup.connect(); await new Promise(r => setTimeout(r, 350));
  const root = cleanup.channelByName("22ND EXPEDITIONARY FLEET");
  if (root != null) {
    cleanup.send("ACL", { channelId: root, inheritAcls: true, groups: [], acls: [], query: false });
    await new Promise(r => setTimeout(r, 350));
  }
  cleanup.disconnect();
  fs.rmSync(dataDir, { recursive: true, force: true });
  console.log("✔ ACCOUNTS PASS — queue, gate, roles, server-enforced net access");
  process.exit(0);
})().catch(e => { console.error("✘ FAIL:", e); process.exit(1); });
