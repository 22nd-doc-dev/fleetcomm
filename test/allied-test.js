/* Joint task force: allied Discords, the ALLIED standing, the JOINT net level.
   Runs the accounts service on a loopback port in MOCK mode (no Discord, no
   relay ACL writes) and drives it over HTTP like the app would. */
"use strict";
const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const port = 8700 + Math.floor(Math.random() * 200);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fc-allied-"));
let service;
let passed = 0;
function ok(cond, msg) { assert.ok(cond, msg); passed++; console.log("  ✓ " + msg + " " + passed); }
function api(method, pathname, body, token) {
  const data = body ? JSON.stringify(body) : null;
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: pathname,
      headers: Object.assign({ "content-type": "application/json" }, token ? { authorization: "Bearer " + token } : {}) }, res => {
      let text = ""; res.on("data", c => text += c);
      res.on("end", () => { try { resolve({ status: res.statusCode, body: JSON.parse(text) }); } catch (e) { resolve({ status: res.statusCode, body: { raw: text } }); } });
    });
    req.on("error", reject); if (data) req.write(data); req.end();
  });
}
function start() {
  service = spawn(process.execPath, [path.join(__dirname, "..", "server", "accounts-service.js")], {
    env: Object.assign({}, process.env, { MOCK_DISCORD: "1", HOST: "127.0.0.1", PORT: String(port),
      DATA_DIR: dataDir, RELAY_PASSWORD: "relay-test", BOOTSTRAP_TOKEN: "boot-test", ACL_SYNC_DISABLED: "1",
      ALLIED_GUILD_IDS: "90000000000000001:Seeded Squadron" }),
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
  /* fleet COMMAND bootstraps */
  let r = await api("POST", "/api/login", { mockId: "doc", mockName: "Doc", bootstrapToken: "boot-test" });
  ok(r.status === 200 && r.body.account.role === "command", "COMMAND bootstraps the service");
  const doc = r.body.token;

  /* the allied list: seeded from env, managed by COMMAND */
  r = await api("GET", "/api/allied", null, doc);
  ok(r.status === 200 && r.body.allied.length === 1 && r.body.allied[0].name === "Seeded Squadron", "ALLIED_GUILD_IDS seeds the allied list");
  r = await api("POST", "/api/allied", { guildId: "90000000000000002", name: "  Blue   Fleet " }, doc);
  ok(r.status === 200, "COMMAND adds an allied Discord");
  r = await api("POST", "/api/allied", { guildId: "not-a-snowflake", name: "X" }, doc);
  ok(r.status === 400, "a guild id must be a Discord server id");
  r = await api("GET", "/api/allied", null, doc);
  ok(r.body.allied.some(g => g.guildId === "90000000000000002" && g.name === "Blue Fleet"), "the list carries the new org with its name tidied");

  /* an allied operator signs in: ALLIED standing, no queue, org attached, relay access */
  r = await api("POST", "/api/login", { mockId: "blue-1", mockName: "Blue One", mockAllied: "90000000000000002" });
  ok(r.status === 200 && r.body.account.role === "allied" && r.body.account.org === "Blue Fleet", "an allied Discord member signs in as ALLIED, auto-approved, org attached");
  ok(r.body.relay && r.body.relay.password === "relay-test" && r.body.relay.tokens.length === 1, "ALLIED standing carries relay credentials");
  const blue = r.body.token;
  ok(Array.isArray(r.body.account.jointNets) && r.body.account.orgLead === false, "the sign-in answer already carries the allied view (no empty board until the first heartbeat)");
  r = await api("POST", "/api/login", { mockId: "stranger", mockName: "Stranger", mockAllied: "90000000000000009" });
  ok(r.status === 403, "a member of an unlisted Discord is refused before any account exists");
  r = await api("GET", "/api/accounts", null, doc);
  if (!r.body.accounts) console.log("DEBUG /api/accounts:", r.status, JSON.stringify(r.body).slice(0, 200));
  ok(!r.body.accounts.some(x => x.discordId === "stranger"), "no account is created for the refused sign-in");
  ok(r.body.accounts.find(x => x.discordId === "blue-1").org === "Blue Fleet", "COMMAND sees the allied operator's org on the roster");

  /* a fleet member who is also in an allied Discord stays a fleet member */
  r = await api("POST", "/api/login", { mockId: "oak", mockName: "Oak" });
  const oak = r.body.token;
  r = await api("POST", "/api/accounts/oak/role", { role: "member" }, doc);
  ok(r.status === 200, "COMMAND approves a fleet member");
  r = await api("POST", "/api/login", { mockId: "oak", mockName: "Oak" });
  ok(r.body.account.role === "member", "a fleet member's standing is untouched by later sign-ins");

  /* JOINT net level */
  r = await api("POST", "/api/nets/access", { net: "JTF COORD", level: "joint" }, doc);
  ok(r.status === 200 && r.body.access["JTF COORD"] === "joint", "COMMAND marks a net JOINT");
  r = await api("POST", "/api/nets/access", { net: "UEES TIBER", level: "member" }, doc);
  ok(r.status === 200, "a ship net stays members-only");
  r = await api("POST", "/api/nets/access", { net: "X", level: "everyone" }, doc);
  ok(r.status === 400, "unknown levels are refused");
  r = await api("GET", "/api/me", null, blue);
  ok(r.status === 200 && Array.isArray(r.body.account.jointNets) && r.body.account.jointNets.includes("JTF COORD") && !r.body.account.jointNets.includes("UEES TIBER"),
     "an allied /api/me lists exactly the JOINT nets");
  r = await api("GET", "/api/me", null, oak);
  ok(r.body.account.jointNets === undefined, "a fleet member's /api/me carries no allied filter");
  /* an org's own net */
  r = await api("POST", "/api/nets/access", { net: "BLUE FLEET COMMAND", level: "org:90000000000000002" }, doc);
  ok(r.status === 200 && r.body.access["BLUE FLEET COMMAND"] === "org:90000000000000002", "COMMAND scopes a net to one allied organization");
  r = await api("POST", "/api/nets/access", { net: "X", level: "org:90000000000000009" }, doc);
  ok(r.status === 400, "an org level must name a listed allied organization");
  r = await api("GET", "/api/me", null, blue);
  ok(r.body.account.jointNets.includes("BLUE FLEET COMMAND") && r.body.account.jointNets.includes("JTF COORD"), "an allied /api/me lists the org's own nets with the JOINT ones");
  r = await api("POST", "/api/login", { mockId: "seed-1", mockName: "Seed One", mockAllied: "90000000000000001" });
  ok(r.status === 200 && r.body.account.org === "Seeded Squadron", "a second org's operator signs in");
  r = await api("GET", "/api/me", null, r.body.token);
  ok(!r.body.account.jointNets.includes("BLUE FLEET COMMAND") && r.body.account.jointNets.includes("JTF COORD"), "another org's operator does not see Blue Fleet's own net");

  /* an ally who sits in the fleet's Discord: COMMAND files them under an org */
  r = await api("POST", "/api/login", { mockId: "guest", mockName: "Guest" });
  const guest = r.body.token;
  ok(r.body.account.role === "pending", "a fleet-Discord arrival starts pending as before");
  r = await api("POST", "/api/accounts/guest/role", { role: "allied" }, doc);
  ok(r.status === 400, "ALLIED standing without an organization is refused");
  r = await api("POST", "/api/accounts/guest/role", { role: "allied", orgGuild: "90000000000000009" }, doc);
  ok(r.status === 400, "an unlisted organization is refused");
  r = await api("POST", "/api/accounts/guest/role", { role: "allied", orgGuild: "90000000000000002" }, doc);
  ok(r.status === 200 && r.body.account.role === "allied" && r.body.account.org === "Blue Fleet" && r.body.account.orgGuild === "90000000000000002", "COMMAND files a fleet-Discord account as ALLIED under Blue Fleet");
  r = await api("GET", "/api/me", null, guest);
  ok(r.body.account.role === "allied" && r.body.account.jointNets.includes("BLUE FLEET COMMAND"), "the converted account sees its organization's nets");
  r = await api("POST", "/api/accounts/guest/role", { role: "allied", orgGuild: "90000000000000001" }, doc);
  ok(r.status === 200 && r.body.account.org === "Seeded Squadron", "COMMAND moves an allied operator to another organization");
  r = await api("POST", "/api/login", { mockId: "guest", mockName: "Guest" });
  ok(r.body.account.role === "allied" && r.body.account.org === "Seeded Squadron", "a later sign-in through the fleet Discord keeps ALLIED standing and the org");

  /* ORG LEAD: COMMAND flags an allied operator; they may manage their org's nets (relay-enforced) */
  r = await api("POST", "/api/accounts/blue-1/orglead", { lead: true }, doc);
  ok(r.status === 200 && r.body.account.orgLead === true, "COMMAND makes an allied operator an organization lead");
  r = await api("GET", "/api/me", null, blue);
  ok(r.body.account.orgLead === true && r.body.account.orgNets.includes("BLUE FLEET COMMAND") && !r.body.account.orgNets.includes("JTF COORD"), "the lead's /api/me lists its org's own nets apart from the JOINT ones");
  r = await api("POST", "/api/accounts/oak/orglead", { lead: true }, doc);
  ok(r.status === 400, "only an ALLIED account can lead an organization");
  r = await api("POST", "/api/accounts/blue-1/orglead", { lead: true }, blue);
  ok(r.status === 403, "an allied operator cannot grant leads");
  r = await api("POST", "/api/accounts/blue-1/orglead", { lead: false }, doc);
  ok(r.status === 200 && r.body.account.orgLead === false, "COMMAND removes the lead again");

  /* what ALLIED may not do */
  r = await api("POST", "/api/nets/access", { net: "JTF COORD", level: "open" }, blue);
  ok(r.status === 403, "an allied operator cannot change net access");
  r = await api("GET", "/api/accounts", null, blue);
  ok(r.status === 403, "an allied operator cannot read the roster");
  r = await api("GET", "/api/allied", null, blue);
  ok(r.status === 403, "an allied operator cannot read the allied list");
  r = await api("POST", "/api/callsign", { callsign: "Blue Actual" }, blue);
  ok(r.status === 200 && r.body.account.sessionCallsign === "BLUE ACTUAL", "an allied operator sets an op callsign like anyone else");

  /* standing changes */
  r = await api("POST", "/api/accounts/blue-1/role", { role: "revoked" }, doc);
  ok(r.status === 200, "COMMAND revokes an allied operator");
  r = await api("GET", "/api/me", null, blue);
  ok(r.status === 401, "revocation ends the allied session");
  r = await api("POST", "/api/login", { mockId: "blue-1", mockName: "Blue One", mockAllied: "90000000000000002" });
  ok(r.status === 403, "a revoked allied operator cannot sign back in");
  r = await api("POST", "/api/accounts/blue-1/role", { role: "allied" }, doc);
  ok(r.status === 200, "COMMAND reinstates ALLIED standing");
  r = await api("POST", "/api/accounts/blue-1/role", { role: "member" }, doc);
  ok(r.status === 200, "an allied operator can be made a fleet member if they join the fleet");

  /* removing an org */
  r = await api("POST", "/api/allied/90000000000000002/remove", {}, doc);
  ok(r.status === 200, "COMMAND removes an allied org");
  r = await api("POST", "/api/login", { mockId: "blue-2", mockName: "Blue Two", mockAllied: "90000000000000002" });
  ok(r.status === 403, "new sign-ins from a removed org are refused");

  await stop();
  console.log("\n✔ ALLIED PASS — allied Discords sign in as ALLIED, reach only JOINT nets, and COMMAND runs the list from the app (" + passed + " checks)");
})().catch(async error => { console.error("\n✘ FAIL:", error); await stop(); process.exit(1); });
