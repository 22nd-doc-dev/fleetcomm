"use strict";
/*
 * FleetComm Accounts Service — runs on the relay droplet beside mumble-server.
 * Responsibilities:
 *   · verify Discord identities server-side (client never ships a secret)
 *   · hold the account registry: pending → member → command; revoke
 *   · gate the relay: only approved accounts receive the relay password + role tokens
 *   · apply per-net access (open / member / command) as REAL Mumble ACLs
 * Storage: JSON files in DATA_DIR (fleet-scale; atomic writes). No framework.
 *
 * Env: PORT (8722) · DATA_DIR (/opt/fleetcomm-accounts/data) · SUPW (mumble SuperUser pw)
 *      MUMBLE_HOST (127.0.0.1) · RELAY_PASSWORD (serverpassword handed to approved users)
 *      ADMIN_TOKEN (the command MakeChannel token, returned to command accounts)
 *      MOCK_DISCORD=1 (tests only: accept {mockId, mockName} instead of a real token)
 */
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { MumbleClient } = require("./mumble-client");

const PORT = +(process.env.PORT || 8722);
const DATA = process.env.DATA_DIR || path.join(__dirname, "data");
const SUPW = process.env.SUPW || "";
const MUMBLE_HOST = process.env.MUMBLE_HOST || "127.0.0.1";
const RELAY_PASSWORD = process.env.RELAY_PASSWORD || "";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const MOCK = process.env.MOCK_DISCORD === "1";
fs.mkdirSync(DATA, { recursive: true });

function load(name, dflt) { try { return JSON.parse(fs.readFileSync(path.join(DATA, name), "utf8")); } catch (e) { return dflt; } }
function save(name, obj) {
  const p = path.join(DATA, name), tmp = p + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 1)); fs.renameSync(tmp, p);
}
const db = {
  accounts: load("accounts.json", {}),   // discordId -> {discordName, callsign, role, createdAt, lastSeen}
  sessions: load("sessions.json", {}),   // token -> discordId
  netAccess: load("netaccess.json", {}), // netName -> open|member|command
  roleTokens: load("roletokens.json", null)
};
if (!db.roleTokens) {
  db.roleTokens = { member: "m-" + crypto.randomBytes(12).toString("hex"), command: "c-" + crypto.randomBytes(12).toString("hex") };
  save("roletokens.json", db.roleTokens);
}
const persist = () => { save("accounts.json", db.accounts); save("sessions.json", db.sessions); save("netaccess.json", db.netAccess); };

/* ── Discord verification ── */
function verifyDiscord(body) {
  if (MOCK) {
    if (!body.mockId) return Promise.reject(new Error("mock login requires mockId"));
    return Promise.resolve({ id: String(body.mockId), username: body.mockName || "mock-user" });
  }
  return new Promise((resolve, reject) => {
    const req = https.get("https://discord.com/api/users/@me",
      { headers: { Authorization: "Bearer " + body.discordToken, "User-Agent": "FleetComm-Accounts" }, timeout: 10000 },
      (res) => {
        let d = ""; res.on("data", c => d += c);
        res.on("end", () => {
          if (res.statusCode !== 200) return reject(new Error("discord verification failed (" + res.statusCode + ")"));
          try { const u = JSON.parse(d); resolve({ id: u.id, username: u.global_name || u.username }); }
          catch (e) { reject(e); }
        });
      });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("discord timeout")); });
  });
}

/* ── relay ACL application ── */
const PERM = { Enter: 0x04, Speak: 0x08, Whisper: 0x100, Text: 0x200 };
function chanName(n) { return n.replace(/[^ \-=\w#\[\]{}()@|]/g, "-"); }
async function applyNetAccess(netName, level) {
  if (!SUPW) throw new Error("service has no SuperUser access configured");
  const c = new MumbleClient({ host: MUMBLE_HOST, username: "SuperUser", password: SUPW, release: "FleetComm-Accounts" });
  await c.connect();
  await new Promise(r => setTimeout(r, 350));
  const id = c.channelByName(chanName(netName));
  if (id == null) { c.disconnect(); throw new Error("net not found on relay: " + netName); }
  const acls = [];
  if (level !== "open") {
    const tok = level === "command" ? db.roleTokens.command : db.roleTokens.member;
    acls.push({ applyHere: true, applySubs: true, group: "all", deny: PERM.Enter | PERM.Speak });
    acls.push({ applyHere: true, applySubs: true, group: "#" + tok, grant: PERM.Enter | PERM.Speak | PERM.Whisper | PERM.Text });
    if (level === "member") /* command implies member */
      acls.push({ applyHere: true, applySubs: true, group: "#" + db.roleTokens.command, grant: PERM.Enter | PERM.Speak | PERM.Whisper | PERM.Text });
  }
  c.send("ACL", { channelId: id, inheritAcls: true, groups: [], acls, query: false });
  await new Promise(r => setTimeout(r, 350));
  c.disconnect();
}

/* ── helpers ── */
function tokensFor(acc) {
  const t = [db.roleTokens.member];
  if (acc.role === "command") { t.push(db.roleTokens.command); if (ADMIN_TOKEN) t.push(ADMIN_TOKEN); }
  return t;
}
function pub(acc, id) {
  return { discordId: id, discordName: acc.discordName, callsign: acc.callsign || null, role: acc.role, lastSeen: acc.lastSeen || null, createdAt: acc.createdAt };
}
function relayFor(acc) {
  if (acc.role === "pending" || acc.role === "revoked") return null;
  return { password: RELAY_PASSWORD, tokens: tokensFor(acc), adminToken: acc.role === "command" ? (ADMIN_TOKEN || null) : null };
}
function auth(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || "");
  if (!m) return null;
  const id = db.sessions[m[1]];
  return id && db.accounts[id] ? { id, acc: db.accounts[id] } : null;
}
function body(req) {
  return new Promise((resolve, reject) => {
    let d = ""; req.on("data", c => { d += c; if (d.length > 65536) req.destroy(); });
    req.on("end", () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(new Error("bad json")); } });
  });
}
function send(res, code, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(s) });
  res.end(s);
}

/* ── routes ── */
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    const p = url.pathname;
    if (p === "/api/health") return send(res, 200, { ok: true, service: "fleetcomm-accounts" });

    if (p === "/api/login" && req.method === "POST") {
      const b = await body(req);
      const who = await verifyDiscord(b);
      let acc = db.accounts[who.id];
      if (!acc) {
        const first = Object.keys(db.accounts).length === 0;
        acc = db.accounts[who.id] = { discordName: who.username, role: first ? "command" : "pending", createdAt: Date.now() };
      }
      if (acc.role === "revoked") return send(res, 403, { ok: false, error: "access revoked by COMMAND" });
      acc.discordName = who.username; acc.lastSeen = Date.now();
      const token = crypto.randomBytes(24).toString("hex");
      db.sessions[token] = who.id;
      /* keep session table bounded */
      const keys = Object.keys(db.sessions);
      if (keys.length > 2000) delete db.sessions[keys[0]];
      persist();
      return send(res, 200, { ok: true, token, account: pub(acc, who.id), relay: relayFor(acc) });
    }

    const a = auth(req);
    if (!a) return send(res, 401, { ok: false, error: "unauthorized" });

    if (p === "/api/me" && req.method === "GET") {
      a.acc.lastSeen = Date.now(); persist();
      return send(res, 200, { ok: true, account: pub(a.acc, a.id), relay: relayFor(a.acc) });
    }
    if (p === "/api/callsign" && req.method === "POST") {
      const b = await body(req);
      const cs = String(b.callsign || "").trim().toUpperCase().slice(0, 40);
      if (!cs) return send(res, 400, { ok: false, error: "empty callsign" });
      a.acc.callsign = cs; persist();
      return send(res, 200, { ok: true, account: pub(a.acc, a.id) });
    }

    /* command-only below */
    if (a.acc.role !== "command") return send(res, 403, { ok: false, error: "COMMAND role required" });

    if (p === "/api/accounts" && req.method === "GET") {
      return send(res, 200, { ok: true, accounts: Object.entries(db.accounts).map(([id, acc]) => pub(acc, id)) });
    }
    let m;
    if ((m = /^\/api\/accounts\/(\d+)\/role$/.exec(p)) && req.method === "POST") {
      const b = await body(req);
      if (!["pending", "member", "command", "revoked"].includes(b.role)) return send(res, 400, { ok: false, error: "bad role" });
      const target = db.accounts[m[1]];
      if (!target) return send(res, 404, { ok: false, error: "no such account" });
      if (m[1] === a.id && b.role !== "command") return send(res, 400, { ok: false, error: "cannot demote yourself" });
      target.role = b.role; persist();
      return send(res, 200, { ok: true, account: pub(target, m[1]) });
    }
    if (p === "/api/nets/access" && req.method === "GET") {
      return send(res, 200, { ok: true, access: db.netAccess });
    }
    if (p === "/api/nets/access" && req.method === "POST") {
      const b = await body(req);
      if (!b.net || !["open", "member", "command"].includes(b.level)) return send(res, 400, { ok: false, error: "need net + level(open|member|command)" });
      await applyNetAccess(b.net, b.level);
      db.netAccess[b.net] = b.level; persist();
      return send(res, 200, { ok: true, access: db.netAccess });
    }
    return send(res, 404, { ok: false, error: "no such route" });
  } catch (e) {
    return send(res, 500, { ok: false, error: e.message });
  }
});
server.listen(PORT, () => console.log("[fleetcomm-accounts] listening on :" + PORT + (MOCK ? " (MOCK DISCORD MODE)" : "")));
