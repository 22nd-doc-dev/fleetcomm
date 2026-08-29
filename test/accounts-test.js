"use strict";
/* Accounts service proof: approval queue, relay gate, roles, and SERVER-ENFORCED net access. */
const assert = require("assert");
const { spawn } = require("child_process");
const http = require("http");
const { MumbleClient } = require("../src/mumble-client");

const TESTPORT = 8890 + Math.floor(Math.random() * 100);
const BASE = "http://127.0.0.1:" + TESTPORT;
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
(async () => {
  const svc = spawn(process.execPath, ["/tmp/acct-smoke/accounts-service.js"], {
    env: Object.assign({}, process.env, {
      MOCK_DISCORD: "1", PORT: String(TESTPORT), DATA_DIR: "/tmp/acct-smoke/data",
      SUPW: "devpass123", MUMBLE_HOST: "127.0.0.1",
      RELAY_PASSWORD: "gate-pw-test", ADMIN_TOKEN: "adm-tok-test"
    }), stdio: "inherit"
  });
  await new Promise(r => setTimeout(r, 900));

  /* 1. first login = COMMAND */
  const doc = await api("POST", "/api/login", { mockId: "1001", mockName: "Doc" });
  assert(doc.ok && doc.account.role === "command", "first login bootstraps command");
  assert(doc.relay && doc.relay.password === "gate-pw-test" && doc.relay.tokens.length >= 2, "command gets relay creds + role tokens");
  console.log("1) bootstrap COMMAND ✓  tokens:", doc.relay.tokens.length);

  /* 2. second login = pending, NO relay creds */
  const gully = await api("POST", "/api/login", { mockId: "1002", mockName: "Gully" });
  assert(gully.ok && gully.account.role === "pending" && gully.relay === null, "pending is gated off the relay");
  console.log("2) pending gated ✓");

  /* 3. approve → member gets creds */
  const ap = await api("POST", "/api/accounts/1002/role", { role: "member" }, doc.token);
  assert(ap.ok && ap.account.role === "member");
  const me2 = await api("GET", "/api/me", null, gully.token);
  assert(me2.relay && me2.relay.password === "gate-pw-test" && me2.relay.adminToken === null, "member creds, no admin token");
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
  await new Promise(r => setTimeout(r, 350));
  const chan = probeM.channelByName("COMMAND NET");
  probeM.joinChannel(chan); probeC.joinChannel(chan);
  await new Promise(r => setTimeout(r, 600));
  const mAt = (probeM.users.get(probeM.session) || {}).channelId || 0;
  const cAt = (probeC.users.get(probeC.session) || {}).channelId || 0;
  console.log("5) member landed in channel", mAt, "· command landed in", cAt, "(target", chan + ")");
  assert(cAt === chan, "command role may enter");
  assert(mAt !== chan, "member role DENIED by relay");
  /* restore open access for other tests */
  await api("POST", "/api/nets/access", { net: "COMMAND NET", level: "open" }, doc.token);
  probeM.disconnect(); probeC.disconnect();

  /* 6. revoke */
  await api("POST", "/api/accounts/1002/role", { role: "revoked" }, doc.token);
  const back = await api("POST", "/api/login", { mockId: "1002", mockName: "Gully" });
  assert(!back.ok, "revoked cannot log in");
  console.log("6) revoke ✓");

  svc.kill();
  console.log("✔ ACCOUNTS PASS — queue, gate, roles, server-enforced net access");
  process.exit(0);
})().catch(e => { console.error("✘ FAIL:", e); process.exit(1); });
