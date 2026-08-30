"use strict";
/*
 * FleetComm Accounts Service — runs on the relay droplet beside mumble-server.
 * Responsibilities:
 *   · verify Discord identities server-side (client never ships a secret)
 *   · hold the account registry: pending → member → command; revoke
 *   · gate the relay: only approved accounts receive the relay password + a unique token
 *   · apply per-net access (open / member / command) as REAL Mumble ACLs
 * Storage: JSON files in DATA_DIR (fleet-scale; atomic writes). No framework.
 *
 * Env: HOST (127.0.0.1) · PORT (8722) · DATA_DIR (/opt/fleetcomm-accounts/data)
 *      SUPW (mumble SuperUser pw) · BOOTSTRAP_TOKEN (one-time COMMAND claim code)
 *      MUMBLE_HOST (127.0.0.1) · RELAY_PASSWORD (serverpassword handed to approved users)
 *      ROOT_CHANNEL (org root whose COMMAND permissions this service manages)
 *      SESSION_TTL_HOURS (12)
 *      MOCK_DISCORD=1 (tests only: accept {mockId, mockName} instead of a real token)
 */
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
let MumbleClient;
try { ({ MumbleClient } = require("./mumble-client")); }
catch (error) { ({ MumbleClient } = require("../src/mumble-client")); }
let channelName;
try { ({ channelName } = require("./channel-name")); }
catch (error) { ({ channelName } = require("../src/channel-name")); }

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 8722);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error("invalid accounts service port");
const DATA = process.env.DATA_DIR || path.join(__dirname, "data");
const SUPW = process.env.SUPW_B64 ? Buffer.from(process.env.SUPW_B64, "base64").toString("utf8") : (process.env.SUPW || "");
const MUMBLE_HOST = process.env.MUMBLE_HOST || "127.0.0.1";
const RELAY_PASSWORD = process.env.RELAY_PASSWORD || "";
const ROOT_CHANNEL = process.env.ROOT_CHANNEL || "22ND EXPEDITIONARY FLEET";
const BOOTSTRAP_TOKEN = process.env.BOOTSTRAP_TOKEN || "";
const SESSION_TTL_HOURS = Number(process.env.SESSION_TTL_HOURS || 12);
if (!Number.isFinite(SESSION_TTL_HOURS) || SESSION_TTL_HOURS < 1 || SESSION_TTL_HOURS > 168)
  throw new Error("SESSION_TTL_HOURS must be between 1 and 168");
const SESSION_TTL_MS = SESSION_TTL_HOURS * 60 * 60 * 1000;
const MOCK = process.env.MOCK_DISCORD === "1";
const ACL_SYNC_DISABLED = process.env.ACL_SYNC_DISABLED === "1";
if (!["127.0.0.1", "::1", "localhost"].includes(HOST) && process.env.ALLOW_PUBLIC_ACCOUNTS !== "1")
  throw new Error("accounts service must bind to loopback (set ALLOW_PUBLIC_ACCOUNTS=1 only behind a trusted TLS proxy)");
fs.mkdirSync(DATA, { recursive: true, mode: 0o700 });
try { fs.chmodSync(DATA, 0o700); } catch (error) {}

function load(name, dflt) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, name), "utf8")); }
  catch (error) {
    if (error && error.code === "ENOENT") return dflt;
    throw new Error("invalid accounts state in " + name + ": " + error.message);
  }
}
function record(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid accounts state shape in " + name);
  return value;
}
function save(name, obj) {
  const p = path.join(DATA, name), tmp = p + ".tmp-" + process.pid + "-" + crypto.randomBytes(4).toString("hex");
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 1), { mode: 0o600 });
  fs.renameSync(tmp, p);
  try { fs.chmodSync(p, 0o600); } catch (error) {}
}
const db = {
  accounts: record(load("accounts.json", {}), "accounts.json"),   // discordId -> {discordName, callsign, role, relayToken, ...}
  sessions: record(load("sessions.json", {}), "sessions.json"),   // token -> {discordId, expiresAt}
  netAccess: record(load("netaccess.json", {}), "netaccess.json") // netName -> open|member|command
};
const persist = () => { save("accounts.json", db.accounts); save("sessions.json", db.sessions); save("netaccess.json", db.netAccess); };
let mutationTail = Promise.resolve();
function serializeMutation(work) {
  const run = mutationTail.then(work, work);
  mutationTail = run.catch(() => {});
  return run;
}
let migrated = false;
for (const account of Object.values(db.accounts)) {
  if (!account || typeof account !== "object") throw new Error("invalid account record");
  if (!["pending", "member", "command", "revoked"].includes(account.role)) { account.role = "pending"; migrated = true; }
  if (!/^u-[0-9a-f]{36}$/.test(String(account.relayToken || ""))) {
    account.relayToken = "u-" + crypto.randomBytes(18).toString("hex"); migrated = true;
  }
}
for (const [net, level] of Object.entries(db.netAccess)) {
  if (!["open", "member", "command"].includes(level)) { delete db.netAccess[net]; migrated = true; }
}
if (migrated) persist();

function sameSecret(a, b) {
  const aa = Buffer.from(String(a || "")), bb = Buffer.from(String(b || ""));
  return aa.length > 0 && aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
function hasCommand() { return Object.values(db.accounts).some(account => account.role === "command"); }
function cleanSessions(now) {
  const at = now || Date.now();
  let changed = false;
  for (const [token, session] of Object.entries(db.sessions)) {
    if (!session || typeof session !== "object" || !session.discordId ||
        !Number.isFinite(Number(session.expiresAt)) || session.expiresAt <= at) {
      delete db.sessions[token]; changed = true;
    }
  }
  return changed;
}

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
        let d = ""; res.on("data", c => {
          d += c;
          if (d.length > 256 * 1024) req.destroy(new Error("discord response is too large"));
        });
        res.on("end", () => {
          if (res.statusCode !== 200) return reject(new Error("discord verification failed (" + res.statusCode + ")"));
          try {
            const u = JSON.parse(d);
            if (!/^\d{1,24}$/.test(String(u.id || ""))) throw new Error("discord returned an invalid account");
            resolve({ id: String(u.id), username: String(u.global_name || u.username || "Discord user").slice(0, 80) });
          }
          catch (e) { reject(e); }
        });
      });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("discord timeout")); });
  });
}

/* ── relay ACL application ── */
const PERM = { Write: 0x01, Traverse: 0x02, Enter: 0x04, Speak: 0x08, MakeChannel: 0x40,
  Whisper: 0x100, Text: 0x200, MakeTempChannel: 0x400, Listen: 0x800 };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const CHANNEL_ACCESS = PERM.Traverse | PERM.Enter | PERM.Speak | PERM.Whisper | PERM.Text | PERM.Listen;
function allowedAccounts(level) {
  return Object.values(db.accounts).filter(account => account.relayToken &&
    (level === "command" ? account.role === "command" : ["member", "command"].includes(account.role)));
}
function accessAcls(level) {
  if (level === "open") return [];
  return [{ applyHere: true, applySubs: true, group: "all", deny: CHANNEL_ACCESS }]
    .concat(allowedAccounts(level).map(account => ({ applyHere: true, applySubs: true,
      group: "#" + account.relayToken, grant: CHANNEL_ACCESS })));
}
function rootAcls() {
  const commandGrant = PERM.Write | PERM.MakeChannel | PERM.MakeTempChannel;
  return [{ applyHere: true, applySubs: true, group: "all", deny: CHANNEL_ACCESS }]
    .concat(allowedAccounts("member").map(account => ({ applyHere: true, applySubs: true,
      group: "#" + account.relayToken, grant: CHANNEL_ACCESS })))
    .concat(allowedAccounts("command").map(account => ({ applyHere: true, applySubs: true,
      group: "#" + account.relayToken, grant: commandGrant })));
}
async function withSuperUser(work) {
  if (ACL_SYNC_DISABLED) return;
  if (!SUPW) throw new Error("service has no SuperUser access configured");
  const c = new MumbleClient({ host: MUMBLE_HOST, username: "SuperUser", password: SUPW, release: "FleetComm-Accounts" });
  try { await c.connect(); await pause(350); await work(c); }
  finally { c.disconnect(); }
}
function applyAcl(c, channelId, acls) {
  c.send("ACL", { channelId, inheritAcls: true, groups: [], acls, query: false });
  return pause(350);
}
async function applyNetAccess(netName, level) {
  await withSuperUser(async c => {
    const id = c.channelByName(channelName(netName));
    if (id == null) throw new Error("net not found on relay: " + netName);
    await applyAcl(c, id, accessAcls(level));
  });
}
async function syncRelayAcls() {
  await withSuperUser(async c => {
    const rootId = c.channelByName(channelName(ROOT_CHANNEL));
    if (rootId == null) throw new Error("org root channel not found on relay");
    await applyAcl(c, rootId, rootAcls());
    const configured = new Map(Object.entries(db.netAccess).map(([name, level]) => [channelName(name), level]));
    /* Clear stale local ACLs from every descendant.  Otherwise an old
       channel-level grant could override the inherited org gate. */
    const inside = new Set([rootId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const [id, channel] of c.channels) {
        if (!inside.has(id) && inside.has(channel.parent)) { inside.add(id); changed = true; }
      }
    }
    for (const [id, channel] of c.channels) {
      if (id !== rootId && inside.has(id))
        await applyAcl(c, id, accessAcls(configured.get(channel.name) || "open"));
    }
  });
}

/* ── helpers ── */
function tokensFor(acc) {
  if (!acc.relayToken) acc.relayToken = "u-" + crypto.randomBytes(18).toString("hex");
  return [acc.relayToken];
}
function pub(acc, id) {
  return { discordId: id, discordName: acc.discordName, callsign: acc.callsign || null, role: acc.role, lastSeen: acc.lastSeen || null, createdAt: acc.createdAt };
}
function relayFor(acc) {
  if (acc.role === "pending" || acc.role === "revoked") return null;
  return { password: RELAY_PASSWORD, tokens: tokensFor(acc) };
}
function auth(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || "");
  if (!m) return null;
  const session = db.sessions[m[1]];
  if (!session || typeof session !== "object" || !Number.isFinite(Number(session.expiresAt)) || session.expiresAt <= Date.now()) {
    if (session) { delete db.sessions[m[1]]; persist(); }
    return null;
  }
  const id = session.discordId;
  return id && db.accounts[id] ? { id, acc: db.accounts[id] } : null;
}
function body(req) {
  return new Promise((resolve, reject) => {
    let d = "", done = false;
    req.on("data", c => {
      if (done) return;
      d += c;
      if (d.length > 65536) { done = true; reject(Object.assign(new Error("request body too large"), { statusCode: 413 })); }
    });
    req.on("end", () => {
      if (done) return;
      try { done = true; resolve(d ? JSON.parse(d) : {}); }
      catch (e) { done = true; reject(Object.assign(new Error("bad json"), { statusCode: 400 })); }
    });
    req.on("error", error => { if (!done) { done = true; reject(error); } });
  });
}
function send(res, code, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(s),
    "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer" });
  res.end(s);
}

/* ── routes ── */
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    const p = url.pathname;
    if (p === "/api/health" && req.method === "GET") return send(res, 200, { ok: true, service: "fleetcomm-accounts" });
    if (p === "/api/status" && req.method === "GET")
      return send(res, 200, { ok: true, initialized: hasCommand() });

    if (p === "/api/login" && req.method === "POST") {
      const b = await body(req);
      const who = await verifyDiscord(b);
      let acc = db.accounts[who.id];
      const initialized = hasCommand();
      if (!initialized) {
        if (!BOOTSTRAP_TOKEN)
          return send(res, 503, { ok: false, bootstrapRequired: true, error: "COMMAND bootstrap is not configured" });
        if (!sameSecret(b.bootstrapToken, BOOTSTRAP_TOKEN))
          return send(res, 403, { ok: false, bootstrapRequired: true, error: "initial COMMAND setup code required" });
        /* Two first-run sign-ins can arrive together.  Serialize the one-time
           claim and re-check inside the lock so the bootstrap code cannot mint
           two COMMAND accounts. */
        await serializeMutation(async () => {
          if (hasCommand()) return;
          const previous = db.accounts[who.id] ? Object.assign({}, db.accounts[who.id]) : null;
          acc = db.accounts[who.id] || (db.accounts[who.id] = { discordName: who.username, role: "command", createdAt: Date.now() });
          acc.role = "command";
          tokensFor(acc);
          try { persist(); await syncRelayAcls(); }
          catch (error) {
            if (previous) db.accounts[who.id] = previous; else delete db.accounts[who.id];
            persist();
            throw error;
          }
        });
        /* A concurrent request may have lost the claim to another identity;
           it still gets a normal pending account instead of a phantom COMMAND. */
        acc = db.accounts[who.id];
        if (!acc) acc = db.accounts[who.id] = { discordName: who.username, role: "pending", createdAt: Date.now() };
      } else if (!acc) {
        acc = db.accounts[who.id] = { discordName: who.username, role: "pending", createdAt: Date.now() };
      }
      if (acc.role === "revoked") return send(res, 403, { ok: false, error: "access revoked by COMMAND" });
      acc.discordName = who.username; acc.lastSeen = Date.now();
      const token = crypto.randomBytes(24).toString("hex");
      db.sessions[token] = { discordId: who.id, createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL_MS };
      cleanSessions();
      persist();
      return send(res, 200, { ok: true, token, account: pub(acc, who.id), relay: relayFor(acc) });
    }

    const a = auth(req);
    if (!a) return send(res, 401, { ok: false, error: "unauthorized" });

    if (p === "/api/me" && req.method === "GET") {
      if (Date.now() - (a.acc.lastSeen || 0) > 60000) { a.acc.lastSeen = Date.now(); persist(); }
      return send(res, 200, { ok: true, account: pub(a.acc, a.id), relay: relayFor(a.acc) });
    }
    if (p === "/api/callsign" && req.method === "POST") {
      const b = await body(req);
      const cs = String(b.callsign || "").trim().toUpperCase().replace(/[^ A-Z0-9_.\-'"()[\]]+/g, "").slice(0, 40);
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
      if (m[1] === a.id && b.role !== "command") return send(res, 400, { ok: false, error: "cannot demote yourself" });
      const updated = await serializeMutation(async () => {
        const target = db.accounts[m[1]];
        if (!target) throw Object.assign(new Error("no such account"), { statusCode: 404 });
        const previousRole = target.role;
        const removedSessions = {};
        target.role = b.role;
        tokensFor(target);
        if (b.role === "revoked") {
          for (const [sessionToken, session] of Object.entries(db.sessions)) {
            if (session && session.discordId === m[1]) { removedSessions[sessionToken] = session; delete db.sessions[sessionToken]; }
          }
        }
        persist();
        try { await syncRelayAcls(); }
        catch (error) {
          target.role = previousRole;
          Object.assign(db.sessions, removedSessions);
          persist();
          throw error;
        }
        return pub(target, m[1]);
      });
      return send(res, 200, { ok: true, account: updated });
    }
    if (p === "/api/nets/access" && req.method === "GET") {
      return send(res, 200, { ok: true, access: db.netAccess });
    }
    if (p === "/api/nets/access" && req.method === "POST") {
      const b = await body(req);
      const netName = String(b.net || "").trim().slice(0, 120);
      if (!netName || !["open", "member", "command"].includes(b.level)) return send(res, 400, { ok: false, error: "need net + level(open|member|command)" });
      await serializeMutation(async () => {
        const hadPrevious = Object.prototype.hasOwnProperty.call(db.netAccess, netName);
        const previous = db.netAccess[netName];
        /* Persist the desired policy first.  If the relay rejects it, roll the
           JSON state back; a restart will then re-apply the last known policy. */
        db.netAccess[netName] = b.level;
        try {
          persist();
          await applyNetAccess(netName, b.level);
        } catch (error) {
          if (hadPrevious) db.netAccess[netName] = previous; else delete db.netAccess[netName];
          try { persist(); } catch (persistError) {}
          throw error;
        }
      });
      return send(res, 200, { ok: true, access: db.netAccess });
    }
    return send(res, 404, { ok: false, error: "no such route" });
  } catch (e) {
    return send(res, e.statusCode || 500, { ok: false, error: e.message });
  }
});
server.requestTimeout = 15000;
server.headersTimeout = 16000;
server.keepAliveTimeout = 5000;
server.maxRequestsPerSocket = 100;
syncRelayAcls().then(() => {
  server.listen(PORT, HOST, () => console.log("[fleetcomm-accounts] listening on " + HOST + ":" + PORT + (MOCK ? " (MOCK DISCORD MODE)" : "")));
}).catch(error => {
  console.error("[fleetcomm-accounts] ACL synchronization failed:", error.message);
  process.exitCode = 1;
});
