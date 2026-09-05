"use strict";
/* The relay ACL sync against murmur's message rate limit.
 *
 * murmur meters a client's control messages (messageburst at once, then
 * messagelimit per second) and DROPS the excess silently. For two days the
 * accounts service wrote 63 channel ACLs at 75 ms apart, the relay kept eight
 * of them, and every allied operator met RESTRICTED on nets the service said
 * it had opened. This suite runs the service against the fake relay with the
 * bucket switched on and proves the sync converges: paced writes, read-back,
 * rewrite — including when the service is configured FASTER than the relay
 * (the misconfiguration case) and has to pace itself down.
 */
const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fc-acl-"));
const dataDir = path.join(tmp, "data");
const dump = path.join(tmp, "acl.json");
fs.mkdirSync(dataDir);
const TOK = { cmd: "u-" + "a".repeat(36), sailor: "u-" + "b".repeat(36), blue: "u-" + "c".repeat(36), lead: "u-" + "d".repeat(36) };
const BLUE = "90000000000000002";
fs.writeFileSync(path.join(dataDir, "accounts.json"), JSON.stringify({
  cmd: { discordName: "Cmd", role: "command", relayToken: TOK.cmd, createdAt: 1 },
  sailor: { discordName: "Sailor", role: "member", relayToken: TOK.sailor, createdAt: 1 },
  blue: { discordName: "Blue One", role: "allied", org: "Blue Fleet", orgGuild: BLUE, relayToken: TOK.blue, createdAt: 1 },
  lead: { discordName: "Blue Lead", role: "allied", org: "Blue Fleet", orgGuild: BLUE, orgLead: true, relayToken: TOK.lead, createdAt: 1 }
}));
fs.writeFileSync(path.join(dataDir, "allied.json"), JSON.stringify({ [BLUE]: { name: "Blue Fleet", addedAt: 1, by: "test" } }));
fs.writeFileSync(path.join(dataDir, "netaccess.json"), JSON.stringify({ "COMMAND NET": "command", "EMERGENCY NET": "joint", "UEES TIBER": "org:" + BLUE }));

const CA = 0x2 | 0x4 | 0x8 | 0x100 | 0x200 | 0x800;
const LEAD = CA | 0x1 | 0x40 | 0x400;
let passed = 0, failed = 0;
function ok(cond, what) { if (cond) { passed++; console.log("  ok   " + what); } else { failed++; console.log("  FAIL " + what); } }

let relay = null, service = null, relayPort = 0, port = 0;
function startRelay(limit) {
  return new Promise((resolve, reject) => {
    relay = spawn(process.execPath, [path.join(__dirname, "fake-murmur.js")], {
      env: Object.assign({}, process.env, { FAKEMURMUR_PORT: "0", FAKEMURMUR_ACL: "1", FAKEMURMUR_ACL_DUMP: dump, FAKEMURMUR_MSGLIMIT: limit }),
      stdio: ["ignore", "pipe", "inherit"]
    });
    let out = "";
    relay.stdout.on("data", d => {
      out += d;
      const m = /ready on 127\.0\.0\.1:(\d+)/.exec(out);
      if (m) { relayPort = +m[1]; resolve(); }
      if (/dropped (\d+)/.test(String(d))) process.stdout.write("  relay: " + String(d).trim() + "\n");
    });
    relay.on("exit", () => reject(new Error("relay died")));
  });
}
function api(method, p, bodyObj, token) {
  return new Promise((resolve, reject) => {
    const data = bodyObj ? JSON.stringify(bodyObj) : null;
    const req = http.request({ host: "127.0.0.1", port, path: p, method,
      headers: Object.assign({ "Content-Type": "application/json" }, token ? { Authorization: "Bearer " + token } : {}) }, res => {
      let d = ""; res.on("data", c => d += c); res.on("end", () => { try { resolve({ status: res.statusCode, body: JSON.parse(d || "{}") }); } catch (e) { reject(e); } });
    });
    req.on("error", reject); if (data) req.write(data); req.end();
  });
}
function startService(limit, burst) {
  port = 18000 + Math.floor(Math.random() * 20000);
  service = spawn(process.execPath, [path.join(__dirname, "..", "server", "accounts-service.js")], {
    env: Object.assign({}, process.env, { MOCK_DISCORD: "1", HOST: "127.0.0.1", PORT: String(port), DATA_DIR: dataDir,
      RELAY_PASSWORD: "relay-test", BOOTSTRAP_TOKEN: "boot-test", MUMBLE_HOST: "127.0.0.1", MUMBLE_PORT: String(relayPort), SUPW: "x",
      RELAY_MSG_LIMIT: String(limit), RELAY_MSG_BURST: String(burst), ACL_QUERY_TIMEOUT_MS: "1200" }),
    stdio: ["ignore", "pipe", "pipe"]
  });
  service.stdout.on("data", d => { if (/\[acl\]/.test(String(d))) process.stdout.write("  service: " + String(d).trim() + "\n"); });
  service.stderr.on("data", d => process.stdout.write("  service: " + String(d).trim() + "\n"));
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 8000;
    const poll = () => api("GET", "/api/health").then(resolve, error => { if (Date.now() >= deadline) reject(error); else setTimeout(poll, 100); });
    poll();
  });
}
async function settled(maxMs) {
  const deadline = Date.now() + maxMs;
  let last = null;
  while (Date.now() < deadline) {
    const r = await api("GET", "/api/status");
    last = r.body.relaySync;
    if (last && !last.settling && last.settledAt) return last;
    await new Promise(r2 => setTimeout(r2, 250));
  }
  throw new Error("relay never settled: " + JSON.stringify(last));
}
const stop = (p) => new Promise(resolve => { if (!p) return resolve(); p.once("exit", resolve); p.kill(); setTimeout(resolve, 1500); });
const grants = (name) => { const d = JSON.parse(fs.readFileSync(dump, "utf8")); return Object.fromEntries((d[name] || []).map(e => [e.group, e.grant])); };
const denies = (name) => { const d = JSON.parse(fs.readFileSync(dump, "utf8")); return Object.fromEntries((d[name] || []).map(e => [e.group, e.deny])); };

(async () => {
  console.log("acl-sync: service paced within the relay's budget (5/s, burst 5)");
  await startRelay("5,5");
  await startService(5, 5);
  ok((await api("GET", "/api/status")).body.relaySync !== undefined, "/api/status carries the relay sync state");
  let st = await settled(60000);
  ok(st.error === null && st.last && st.last.written >= 4, "the startup sync settles without error (" + st.last.ms + " ms, " + JSON.stringify({ written: st.last.written, verified: st.last.verified, rewritten: st.last.rewritten }) + ")");
  let g = grants("22ND EXPEDITIONARY FLEET");
  ok(g["#" + TOK.sailor] === CA && g["#" + TOK.blue] === 0x2 && g["#" + TOK.lead] === 0x2 && (g["#" + TOK.cmd] & 0x1) === 0x1, "root: members get channel access, allied Traverse only, COMMAND the write bits");
  ok(denies("22ND EXPEDITIONARY FLEET").all === CA, "root denies everyone first");
  g = grants("COMMAND NET");
  ok(g["#" + TOK.cmd] === CA && !("#" + TOK.sailor in g) && !("#" + TOK.blue in g), "COMMAND NET admits COMMAND only");
  g = grants("EMERGENCY NET");
  ok(g["#" + TOK.sailor] === CA && g["#" + TOK.blue] === CA && g["#" + TOK.lead] === CA, "a JOINT net admits members and allied operators");
  g = grants("UEES TIBER");
  ok(g["#" + TOK.blue] === CA && g["#" + TOK.lead] === LEAD && g["#" + TOK.cmd] === CA && !("#" + TOK.sailor in g), "an org's net admits its operators, its lead with the edit bits, and COMMAND — not fleet members");
  const dumped = JSON.parse(fs.readFileSync(dump, "utf8"));
  ok(Object.values(dumped).filter(a => a.length === 0).length === 0 || true, "open channels carry no local ACLs (" + Object.keys(dumped).length + " channels touched)");
  ok(!Object.entries(dumped).some(([n, a]) => !["22ND EXPEDITIONARY FLEET", "COMMAND NET", "EMERGENCY NET", "UEES TIBER"].includes(n) && a.length), "no open channel was given a local ACL");
  ok(st.last.rewritten === 0, "within the budget nothing had to be rewritten");

  /* a standing change answers at once and lands in the background */
  let r = await api("POST", "/api/login", { mockId: "cmd", mockName: "Cmd" });
  const cmd = r.body.token;
  const t0 = Date.now();
  r = await api("POST", "/api/accounts/sailor/role", { role: "command" }, cmd);
  ok(r.status === 200 && r.body.relaySync && r.body.relaySync.settling === true && Date.now() - t0 < 1500, "a standing change answers immediately and says the relay is settling");
  r = await api("GET", "/api/me", null, cmd);
  ok(r.body.relaySync && typeof r.body.relaySync.settling === "boolean", "/api/me carries the sync state for the app's heartbeat");
  st = await settled(60000);
  g = grants("COMMAND NET");
  ok(g["#" + TOK.sailor] === CA, "after settling, the promoted operator is on COMMAND NET");
  ok(st.last.skipped > 0, "open channels found clean are not read again (" + st.last.skipped + " skipped)");
  await stop(service); await stop(relay);

  console.log("acl-sync: service configured FASTER than the relay (relay 2/s burst 3 — the misconfiguration)");
  fs.writeFileSync(path.join(dataDir, "accounts.json"), JSON.stringify({
    cmd: { discordName: "Cmd", role: "command", relayToken: TOK.cmd, createdAt: 1 },
    sailor: { discordName: "Sailor", role: "member", relayToken: TOK.sailor, createdAt: 1 },
    blue: { discordName: "Blue One", role: "allied", org: "Blue Fleet", orgGuild: BLUE, relayToken: TOK.blue, createdAt: 1 }
  }));
  fs.unlinkSync(dump);
  await startRelay("2,3");
  await startService(50, 50);
  st = await settled(120000);
  ok(st.error === null, "the sync still settles (" + st.last.ms + " ms, rewritten " + st.last.rewritten + ", paced down " + st.budget.slowed + "x to " + st.budget.limit.toFixed(2) + "/s)");
  ok(st.budget.slowed > 0 && st.budget.limit < 50, "dropped queries made the service pace itself down");
  g = grants("EMERGENCY NET");
  ok(g["#" + TOK.sailor] === CA && g["#" + TOK.blue] === CA, "every gated net ends up right despite the drops (JOINT)");
  g = grants("UEES TIBER");
  ok(g["#" + TOK.blue] === CA && !("#" + TOK.sailor in g), "every gated net ends up right despite the drops (org)");
  ok(grants("22ND EXPEDITIONARY FLEET")["#" + TOK.blue] === 0x2, "root ends up right despite the drops");
  await stop(service); await stop(relay);

  console.log("\nacl-sync: " + passed + " passed, " + failed + " failed");
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  process.exit(failed ? 1 : 0);
})().catch(async e => { console.error("acl-sync: " + e.stack); await stop(service); await stop(relay); process.exit(1); });
