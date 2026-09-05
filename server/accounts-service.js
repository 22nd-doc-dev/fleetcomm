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
 *      SESSION_TTL_HOURS (12) — idle timeout; active sessions renew themselves
 *      SESSION_ABS_HOURS (72) — hard ceiling: no session outlives this from creation
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
const MUMBLE_PORT = Number(process.env.MUMBLE_PORT) || 64738;
/* ── the relay's message budget ──
   murmur meters every client's control messages through a leaky bucket:
   `messageburst` may arrive at once, then `messagelimit` per second (the
   1.5 defaults are 5 and 1), and everything over the line is DROPPED — no
   error, no PermissionDenied, nothing on the socket. A 63-channel ACL sync
   paced at 75 ms therefore landed exactly eight writes per run for two days
   while this service reported success (handoff §27). These two MUST match the
   relay's ini; the defaults are murmur's own. Set them higher only after the
   relay's messagelimit/messageburst were raised AND the relay restarted. */
const RELAY_MSG_LIMIT = Math.max(0.2, Number(process.env.RELAY_MSG_LIMIT) || 1);
const RELAY_MSG_BURST = Math.max(1, Math.floor(Number(process.env.RELAY_MSG_BURST) || 5));
const ACL_QUERY_TIMEOUT_MS = Math.max(300, Number(process.env.ACL_QUERY_TIMEOUT_MS) || 5000);
const RELAY_PASSWORD = process.env.RELAY_PASSWORD || "";
const ROOT_CHANNEL = process.env.ROOT_CHANNEL || "22ND EXPEDITIONARY FLEET";
const BOOTSTRAP_TOKEN = process.env.BOOTSTRAP_TOKEN || "";
const SESSION_TTL_HOURS = Number(process.env.SESSION_TTL_HOURS || 12);
if (!Number.isFinite(SESSION_TTL_HOURS) || SESSION_TTL_HOURS < 1 || SESSION_TTL_HOURS > 168)
  throw new Error("SESSION_TTL_HOURS must be between 1 and 168");
/* Sessions RENEW while in use (an op longer than the TTL used to sign every
   operator out mid-flight) but never past an absolute ceiling from creation —
   so a stolen token still dies, and revocation semantics stay intact. */
const SESSION_ABS_HOURS = Number(process.env.SESSION_ABS_HOURS || 72);
if (!Number.isFinite(SESSION_ABS_HOURS) || SESSION_ABS_HOURS < SESSION_TTL_HOURS || SESSION_ABS_HOURS > 720)
  throw new Error("SESSION_ABS_HOURS must be between SESSION_TTL_HOURS and 720");
const MOCK = process.env.MOCK_DISCORD === "1";
/* millisecond overrides exist for the test rig only — production always
   speaks hours */
const SESSION_TTL_MS = MOCK && process.env.SESSION_TTL_MS
  ? Number(process.env.SESSION_TTL_MS) : SESSION_TTL_HOURS * 60 * 60 * 1000;
const SESSION_ABS_MS = MOCK && process.env.SESSION_ABS_MS
  ? Number(process.env.SESSION_ABS_MS) : SESSION_ABS_HOURS * 60 * 60 * 1000;
/* ── Discord guild gate ──
   Only members of the fleet's Discord may sign in. This is checked HERE, on the
   server, against Discord's own API — never in the client, which an operator
   could patch. It also means access follows the Discord: leave the server and
   your next sign-in fails, without anyone having to remember to revoke you.
   Unset = no gate, so a droplet that hasn't been told the guild ID keeps working
   instead of silently locking out the whole fleet. */
const GUILD_ID = String(process.env.DISCORD_GUILD_ID || "").trim();
/* ── allied task-force Discords ──
   A joint op needs other organisations on the relay without putting them on
   the fleet's rolls. COMMAND lists allied Discord servers (ACCOUNTS & ACCESS
   → ALLIED ORGANIZATIONS, or ALLIED_GUILD_IDS="id:Name,id:Name" as a seed);
   a Discord user who is in one of them but not in the fleet's signs in as
   standing ALLIED — auto-approved, tagged with the org, relay access limited
   to nets whose level is JOINT (the relay ACL enforces it), never a fleet
   personnel record, never a helmet-cam viewer. */
const ALLIED_SEED = String(process.env.ALLIED_GUILD_IDS || "").split(",").map(x => x.trim()).filter(Boolean)
  .map(x => { const i = x.indexOf(":"); return i > 0 ? { id: x.slice(0, i).trim(), name: x.slice(i + 1).trim() } : { id: x, name: "Allied org " + x }; });
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
  netAccess: record(load("netaccess.json", {}), "netaccess.json"),// netName -> open|joint|member|command
  allied: record(load("allied.json", {}), "allied.json"),          // guildId -> {name, addedAt, by}
  sounds: record(load("sounds.json", {}), "sounds.json")          // id -> {name, size, ext, by, at}
};
const persist = () => { save("accounts.json", db.accounts); save("sessions.json", db.sessions); save("netaccess.json", db.netAccess); save("allied.json", db.allied); };
for (const g of ALLIED_SEED) if (/^\d{5,25}$/.test(g.id) && !db.allied[g.id]) db.allied[g.id] = { name: g.name.slice(0, 60), addedAt: Date.now(), by: "env" };

/* -- the audit ledger: append-only by construction. Every privileged action
   lands here, and no API exists to clear or rewrite it - that is the design.
   A separate JSONL file, so the JSON-store rewrite cycle never touches it. -- */
const AUDIT_PATH = path.join(DATA, "audit.jsonl");
function audit(byName, byId, action, detail) {
  try {
    fs.appendFileSync(AUDIT_PATH,
      JSON.stringify({ at: Date.now(), by: String(byName || "?").slice(0, 80),
        id: String(byId || "").slice(0, 40), action: String(action || "").slice(0, 60),
        detail: String(detail || "").slice(0, 400) }) + "\n",
      { mode: 0o600 });
  } catch (error) { console.error("[audit] write failed:", error.message); }
}
function auditTail(limit) {
  try {
    return fs.readFileSync(AUDIT_PATH, "utf8").split("\n").filter(Boolean)
      .slice(-limit).reverse()
      .map(l => { try { return JSON.parse(l); } catch (error) { return null; } })
      .filter(Boolean);
  } catch (error) { return []; }
}

/* ── shared 1MC sound library ──
   Clips are fleet property, not per-machine files: a clip one COMMAND account
   uploads must be on the 1MC of every ship net for every COMMAND account.
   Audio bytes live as files under DATA/sounds; sounds.json is the index.
   COMMAND-only in both directions — the 1MC itself is COMMAND-gated, so
   nothing below COMMAND has any use for the bytes. */
const SOUNDS_DIR = path.join(DATA, "sounds");
const SOUND_EXT = /\.(wav|mp3|ogg|m4a|flac|webm)$/i;
const SOUND_MAX_BYTES = 4 * 1024 * 1024;   /* a 1MC clip is seconds long */
const SOUND_MAX_COUNT = 48;
try { fs.mkdirSync(SOUNDS_DIR, { recursive: true }); fs.chmodSync(SOUNDS_DIR, 0o700); } catch (error) {}
const soundPath = (id, ext) => path.join(SOUNDS_DIR, id + "." + ext);
const saveSounds = () => save("sounds.json", db.sounds);
let mutationTail = Promise.resolve();
function serializeMutation(work) {
  const run = mutationTail.then(work, work);
  mutationTail = run.catch(() => {});
  return run;
}
let migrated = false;
for (const account of Object.values(db.accounts)) {
  if (!account || typeof account !== "object") throw new Error("invalid account record");
  if (!["pending", "allied", "member", "element", "command", "revoked"].includes(account.role)) { account.role = "pending"; migrated = true; }
  if (!/^u-[0-9a-f]{36}$/.test(String(account.relayToken || ""))) {
    account.relayToken = "u-" + crypto.randomBytes(18).toString("hex"); migrated = true;
  }
}
for (const [net, level] of Object.entries(db.netAccess)) {
  if (!["open", "joint", "member", "command"].includes(level) && !/^org:\d{5,25}$/.test(level)) { delete db.netAccess[net]; migrated = true; }
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
function discordGet(pathName, token) {
  return new Promise((resolve, reject) => {
    const req = https.get("https://discord.com/api" + pathName,
      { headers: { Authorization: "Bearer " + token, "User-Agent": "FleetComm-Accounts" }, timeout: 10000 },
      (res) => {
        let d = "";
        res.on("data", c => { d += c; if (d.length > 512 * 1024) req.destroy(new Error("discord response is too large")); });
        res.on("end", () => {
          if (res.statusCode !== 200) return reject(new Error("discord guild check failed (" + res.statusCode + ")"));
          try { resolve(JSON.parse(d)); } catch (e) { reject(new Error("discord returned malformed data")); }
        });
      });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("discord timed out")); });
  });
}
/* Resolves to { fleet: true } for a member of the fleet's Discord, to
   { allied: { id, name } } for someone who is only in a listed allied Discord,
   and throws for everyone else. The fleet wins when both apply. */
async function requireGuildMember(token) {
  if (!GUILD_ID) return { fleet: true, alliedIn: [] };      /* gate not configured — allow */
  const guilds = await discordGet("/users/@me/guilds", token);
  if (!Array.isArray(guilds)) throw new Error("discord returned an unexpected guild list");
  /* every LISTED allied Discord the person is in — the approval queue's way to
     tell a recruit from an ally who joined the fleet's Discord as a guest */
  const alliedIn = guilds.filter(g => g && db.allied[String(g.id)]).map(g => String(g.id));
  const fleet = guilds.some(g => String(g && g.id) === GUILD_ID);
  const joined = await guildJoinDates(token, (fleet ? [GUILD_ID] : []).concat(alliedIn));
  if (fleet) return { fleet: true, alliedIn, joined };
  const allied = guilds.find(g => g && db.allied[String(g.id)]);
  if (allied) return { allied: { id: String(allied.id), name: db.allied[String(allied.id)].name }, alliedIn, joined };
  throw new Error(Object.keys(db.allied).length
    ? "not a member of the fleet Discord or of an allied task-force Discord"
    : "not a member of the fleet Discord");
}

/* When the person joined each Discord that matters — the fleet's and every
   listed allied one they are in. Whichever they joined FIRST is very likely
   their home: an ally guesting in the fleet's Discord joined their own org
   long before; a recruit joined the fleet's first. Needs the
   guilds.members.read scope (the app asks for it since 1.4.11); an older
   consent, or a Discord hiccup, just yields no date — a hint, never a gate. */
async function guildJoinDates(token, ids) {
  const out = {};
  await Promise.all(ids.map(async id => {
    try {
      const m = await discordGet("/users/@me/guilds/" + id + "/member", token);
      const t = Date.parse(m && m.joined_at);
      if (Number.isFinite(t)) out[id] = t;
    } catch (error) { /* scope not granted, or throttled */ }
  }));
  return out;
}
function verifyDiscord(body) {
  /* a real token verifies for real even on a mock rig — the web OAuth flow
     (portal callback) coexists with mock dev sign-ins */
  if (MOCK && !body.discordToken) {
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
/* "org:<guildId>" = that allied organisation's own net: its operators plus the
   fleet's COMMAND (the task-force coordinator can reach every command net);
   fleet members stay out unless COMMAND opens it to JOINT */
function allowedAccounts(level) {
  const org = /^org:(\d{5,25})$/.exec(String(level));
  return Object.values(db.accounts).filter(account => account.relayToken &&
    (level === "command" ? account.role === "command"
      : level === "allied" ? account.role === "allied"
      : level === "joint" ? ["allied", "member", "element", "command"].includes(account.role)
      : org ? ((account.role === "allied" && account.orgGuild === org[1]) || account.role === "command")
      : ["member", "element", "command"].includes(account.role)));
}
function accessAcls(level) {
  /* "open" = anyone the fleet approved; allied operators are NOT that — the
     root already denies them Enter, and an open net inherits it */
  if (level === "open") return [];
  const org = /^org:(\d{5,25})$/.exec(String(level));
  const leadGrant = CHANNEL_ACCESS | PERM.Write | PERM.MakeChannel | PERM.MakeTempChannel;
  return [{ applyHere: true, applySubs: true, group: "all", deny: CHANNEL_ACCESS }]
    .concat(allowedAccounts(level).map(account => ({ applyHere: true, applySubs: true,
      group: "#" + account.relayToken,
      /* an ORG LEAD may create, rename and delete nets inside its own org's
         channels — Write + MakeChannel here, inherited by every subchannel */
      grant: (org && account.role === "allied" && account.orgLead === true && account.orgGuild === org[1]) ? leadGrant : CHANNEL_ACCESS })));
}
function rootAcls() {
  const commandGrant = PERM.Write | PERM.MakeChannel | PERM.MakeTempChannel;
  return [{ applyHere: true, applySubs: true, group: "all", deny: CHANNEL_ACCESS }]
    .concat(allowedAccounts("member").map(account => ({ applyHere: true, applySubs: true,
      group: "#" + account.relayToken, grant: CHANNEL_ACCESS })))
    /* allied: Traverse only — murmur needs it on every ancestor to reach a
       JOINT net's own grant; Enter/Speak stay denied everywhere else */
    .concat(allowedAccounts("allied").map(account => ({ applyHere: true, applySubs: true,
      group: "#" + account.relayToken, grant: PERM.Traverse })))
    .concat(allowedAccounts("command").map(account => ({ applyHere: true, applySubs: true,
      group: "#" + account.relayToken, grant: commandGrant })));
}
/* The budget never lets a SuperUser session exceed the relay's numbers. It
   starts under the line (Version + Authenticate already drew on the bucket,
   and the 5 s keepalive ping shares it) and, when a read-back gets no answer
   — a dropped query — halves its rate for the rest of the process: a service
   configured faster than the relay converges instead of timing out forever. */
const relayBudget = { rate: RELAY_MSG_LIMIT, burst: RELAY_MSG_BURST, slowed: 0 };
class MessageBudget {
  constructor() { this.level = 2; this.last = Date.now(); }          /* the handshake's two messages */
  rate() { return Math.max(0.2, relayBudget.rate * 0.9 - 0.25); }    /* margin + the keepalive's share */
  async take() {
    const now = Date.now();
    this.level = Math.max(0, this.level - (now - this.last) / 1000 * relayBudget.rate);
    this.last = now;
    const cap = Math.max(1, relayBudget.burst - 1);
    if (this.level + 1 > cap) {
      const wait = Math.ceil((this.level + 1 - cap) / this.rate() * 1000);
      await pause(wait);
      this.level = Math.max(0, this.level - wait / 1000 * relayBudget.rate);
      this.last = Date.now();
    }
    this.level += 1;
  }
  static slow() {
    relayBudget.rate = Math.max(0.5, relayBudget.rate / 2); relayBudget.burst = 1; relayBudget.slowed++;
    console.error("[acl] the relay dropped a query — pacing down to " + relayBudget.rate.toFixed(2) + " msg/s (RELAY_MSG_LIMIT/RELAY_MSG_BURST should match the relay's messagelimit/messageburst)");
  }
}
async function withSuperUser(work) {
  if (ACL_SYNC_DISABLED) return;
  if (!SUPW) throw new Error("service has no SuperUser access configured");
  const c = new MumbleClient({ host: MUMBLE_HOST, port: MUMBLE_PORT, username: "SuperUser", password: SUPW, release: "FleetComm-Accounts" });
  c.budget = new MessageBudget();
  try { await c.connect(); await pause(350); return await work(c); }
  finally { c.disconnect(); }
}
async function writeAcl(c, channelId, acls) {
  await c.budget.take();
  c.send("ACL", { channelId, inheritAcls: true, groups: [], acls, query: false });
}
/* murmur answers an ACL query with the channel's list — its own entries plus
   the inherited ones flagged as such. No answer inside the timeout means the
   query itself was dropped (or the relay is a stand-in that ignores ACLs). */
function queryAcl(c, channelId) {
  return new Promise((resolve) => {
    const t = setTimeout(() => { c.off("ACL", on); resolve(null); }, ACL_QUERY_TIMEOUT_MS);
    const on = (m) => { if (Number(m.channelId || 0) === Number(channelId)) { clearTimeout(t); c.off("ACL", on); resolve(m); } };
    c.on("ACL", on);
    c.budget.take().then(() => c.send("ACL", { channelId, query: true }));
  });
}
/* an ACL entry as murmur stores it: the fields that decide access, defaults
   applied, inherited ones dropped — so a read-back compares to what we sent */
function normalizeAcl(entries, fromRelay) {
  return (entries || []).filter(e => e && (!fromRelay || e.inherited === false))
    .map(e => JSON.stringify({ h: e.applyHere !== false, s: e.applySubs !== false, u: e.userId == null ? null : Number(e.userId),
      g: String(e.group || ""), a: Number(e.grant || 0), d: Number(e.deny || 0) })).sort().join("|");
}
const aclClean = new Set();                 /* channels read back with no local ACLs since this process started */
let relayAnswersQueries = true;
/* ── the sync ──
   Root carries the standing grants; every gated net (JOINT / COMMAND / an
   org's) gets its own list; every other channel under the root must carry
   NO local ACLs, or a stale grant would override the inherited gate. Writes
   are paced to the relay's budget, then every gated net — and, once per
   process, every open channel — is read back; whatever the relay dropped is
   written again and read again, three rounds. A net named in NET ACCESS
   that is not on the relay (yet) is simply not there to write. */
async function syncRelayAcls() {
  const report = { written: 0, verified: 0, rewritten: 0, skipped: 0 };
  await withSuperUser(async c => {
    const rootId = c.channelByName(channelName(ROOT_CHANNEL));
    if (rootId == null) throw new Error("org root channel not found on relay");
    const configured = new Map(Object.entries(db.netAccess).map(([name, level]) => [channelName(name), level]));
    const inside = new Set([rootId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const [id, channel] of c.channels) {
        if (!inside.has(id) && inside.has(channel.parent)) { inside.add(id); changed = true; }
      }
    }
    const nameOf = (id) => (c.channels.get(id) || {}).name || ("#" + id);
    const plan = [[rootId, rootAcls()]];
    for (const [id, channel] of c.channels) if (id !== rootId && inside.has(id)) plan.push([id, accessAcls(configured.get(channel.name) || "open")]);
    /* write pass: the gated lists. Open channels are only READ (below) — and
       once found clean, not even that again until the service restarts */
    let pending = [];
    for (const [id, acls] of plan) {
      if (!acls.length && aclClean.has(nameOf(id))) { report.skipped++; continue; }
      if (acls.length) { await writeAcl(c, id, acls); report.written++; }
      pending.push([id, acls]);
    }
    /* read-back rounds */
    let timeouts = 0;
    for (let round = 0; round < 3 && pending.length && relayAnswersQueries; round++) {
      const next = [];
      for (const [id, acls] of pending) {
        if (!relayAnswersQueries) { next.push([id, acls]); continue; }
        const reply = await queryAcl(c, id);
        if (!reply) {
          timeouts++;
          if (report.verified === 0 && timeouts >= 4) { relayAnswersQueries = false; console.error("[acl] the relay does not answer ACL queries — writes go unverified"); }
          else MessageBudget.slow();
          next.push([id, acls]); continue;
        }
        report.verified++;
        const same = normalizeAcl(reply.acls, true) === normalizeAcl(acls, false);
        if (same) { if (!acls.length) aclClean.add(nameOf(id)); continue; }
        if (round < 2) { await writeAcl(c, id, acls); report.rewritten++; }
        next.push([id, acls]);
      }
      pending = next;
    }
    if (!relayAnswersQueries) {
      /* a relay that never answers (a stand-in): write the open channels blind, as before */
      for (const [id, acls] of pending) if (!acls.length) { await writeAcl(c, id, acls); report.written++; }
    } else if (pending.length) {
      throw new Error("the relay kept dropping ACL writes on " + pending.map(([id]) => nameOf(id)).join(", "));
    }
  });
  return report;
}
async function syncRelayAclsWithRetry() {
  let lastError;
  for (let attempt = 0; attempt < 5; attempt++) {
    try { return await syncRelayAcls(); }
    catch (error) {
      lastError = error;
      if (attempt < 4) await pause(500 * (2 ** attempt));
    }
  }
  throw lastError || new Error("relay ACL synchronization failed");
}
/* ── the background runner ──
   A standing change answers at once; the relay follows within the budget
   (seconds on a relay whose limits were raised, half a minute on murmur's
   defaults). Until it has, /api/me and /api/accounts say `relaySync.settling`
   — the app holds "RESTRICTED" back as "ACCESS PENDING" and re-tunes when the
   relay has caught up. One run covers every change queued while it ran; a
   failing relay is retried with backoff, forever, and the error is shown. */
const relaySync = { running: false, queued: false, since: 0, settledAt: 0, error: null, last: null };
function relaySyncState() {
  return { settling: relaySync.running || relaySync.queued, since: relaySync.since || null, settledAt: relaySync.settledAt || null,
    error: relaySync.error, last: relaySync.last, budget: { limit: relayBudget.rate, burst: relayBudget.burst, slowed: relayBudget.slowed } };
}
function requestRelaySync(reason) {
  relaySync.queued = true;
  if (relaySync.running) return;
  relaySync.running = true; relaySync.since = Date.now();
  (async () => {
    let failures = 0;
    while (relaySync.queued) {
      relaySync.queued = false;
      const t0 = Date.now();
      try {
        const report = await syncRelayAclsWithRetry();
        relaySync.error = null; failures = 0;
        relaySync.last = Object.assign({ at: Date.now(), ms: Date.now() - t0, reason }, report || {});
        if (!ACL_SYNC_DISABLED) console.log("[acl] relay in step (" + reason + ", " + (Date.now() - t0) + " ms): " + JSON.stringify(report));
      } catch (error) {
        failures++; relaySync.error = error.message; relaySync.queued = true;
        console.error("[acl] relay sync failed (" + reason + ", attempt " + failures + "): " + error.message);
        await pause(Math.min(60000, 5000 * failures));
      }
    }
    relaySync.running = false; relaySync.settledAt = Date.now();
  })();
}

/* ── helpers ── */
function tokensFor(acc) {
  if (!acc.relayToken) acc.relayToken = "u-" + crypto.randomBytes(18).toString("hex");
  return [acc.relayToken];
}
function pub(acc, id) {
  return { discordId: id, discordName: acc.discordName, callsign: acc.callsign || null, onAir: liveCallsign(id), role: acc.role, org: acc.org || null, orgGuild: acc.orgGuild || null, orgLead: acc.orgLead === true,
    inFleet: acc.inFleet === undefined ? null : acc.inFleet === true, alliedIn: Array.isArray(acc.alliedIn) ? acc.alliedIn : [],
    guildJoined: acc.guildJoined && typeof acc.guildJoined === "object" ? acc.guildJoined : {}, lastSeen: acc.lastSeen || null, createdAt: acc.createdAt };
}
/* what an allied client needs to draw its board: the nets it may enter (JOINT
   + its org's), its org's own nets (what an org lead may edit), and the flag */
function alliedView(acc) {
  if (acc.role !== "allied") return {};
  const mine = "org:" + acc.orgGuild;
  return {
    jointNets: Object.entries(db.netAccess).filter(([, l]) => l === "joint" || l === mine).map(([n]) => n),
    orgNets: Object.entries(db.netAccess).filter(([, l]) => l === mine).map(([n]) => n),
    orgLead: acc.orgLead === true
  };
}
function relayFor(acc) {
  if (acc.role === "pending" || acc.role === "revoked") return null;
  return { password: RELAY_PASSWORD, tokens: tokensFor(acc) };
}
function auth(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || "");
  if (!m) return null;
  const session = db.sessions[m[1]];
  const now = Date.now();
  if (!session || typeof session !== "object" || !Number.isFinite(Number(session.expiresAt)) || session.expiresAt <= now) {
    if (session) { delete db.sessions[m[1]]; persist(); }
    return null;
  }
  /* sliding renewal: any authenticated activity in the back half of the TTL
     extends the session, capped at the absolute ceiling. Renewing at most
     once per half-TTL keeps the persist() cadence negligible. */
  const absEnd = (Number(session.createdAt) || now) + SESSION_ABS_MS;
  if (session.expiresAt - now < SESSION_TTL_MS / 2 && session.expiresAt < absEnd) {
    session.expiresAt = Math.min(now + SESSION_TTL_MS, absEnd);
    persist();
  }
  const id = session.discordId;
  return id && db.accounts[id] ? { id, acc: db.accounts[id], session } : null;
}
/* the callsign an account is on the air under right now — its newest live
   session's, or null when it is not signed into the app */
function liveCallsign(id) {
  const now = Date.now();
  let best = null;
  for (const sess of Object.values(db.sessions)) {
    if (!sess || sess.discordId !== id || !sess.callsign || !(sess.expiresAt > now)) continue;
    if (!best || (sess.createdAt || 0) > (best.createdAt || 0)) best = sess;
  }
  return best ? best.callsign : null;
}
function body(req, limit) {
  const max = limit || 65536;   /* only the clip upload route asks for more */
  return new Promise((resolve, reject) => {
    let d = "", done = false;
    req.on("data", c => {
      if (done) return;
      d += c;
      if (d.length > max) { done = true; reject(Object.assign(new Error("request body too large"), { statusCode: 413 })); }
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

/* ── the portal personnel layer (profiles, awards, CoC, availability, SSO, bot) ── */
let createPortalApi;
try { createPortalApi = require("./portal-api"); }
catch (error) { createPortalApi = require("../server/portal-api"); }
const portal = createPortalApi({ load, save, record, send, body, auth, serializeMutation,
  db, MOCK, SESSION_TTL_MS, verifyDiscord, requireGuildMember, persist, audit, auditTail, dataDir: DATA });

/* ── routes ── */
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    const p = url.pathname;
    /* CORS first (the portal may live on another origin), then the portal's
       own routes; everything the portal doesn't claim falls through unchanged */
    if (portal.cors(req, res)) return;
    if (await portal.handle(req, res, url)) return;
    if (p === "/api/health" && req.method === "GET") return send(res, 200, { ok: true, service: "fleetcomm-accounts" });
    if (p === "/api/status" && req.method === "GET")
      return send(res, 200, { ok: true, initialized: hasCommand(), mock: MOCK, relaySync: relaySyncState() });

    if (p === "/api/login" && req.method === "POST") {
      const b = await body(req);
      const who = await verifyDiscord(b);
      /* fleet Discord membership is checked before ANY account state is touched,
         so a non-member never lands in the queue in the first place */
      let gate = { fleet: true, alliedIn: [] };
      if (!MOCK && b.discordToken) gate = await requireGuildMember(String(b.discordToken));
      else if (MOCK && b.mockAllied) {            /* the rig's stand-in for an allied Discord */
        if (!db.allied[String(b.mockAllied)]) return send(res, 403, { ok: false, error: "not a member of the fleet Discord or of an allied task-force Discord" });
        gate = { allied: { id: String(b.mockAllied), name: db.allied[String(b.mockAllied)].name }, alliedIn: [String(b.mockAllied)] };
      } else if (MOCK && Array.isArray(b.mockAlsoIn)) {   /* a fleet-Discord member who is ALSO in listed allied Discords */
        gate = { fleet: true, alliedIn: b.mockAlsoIn.map(String).filter(id => db.allied[id]) };
      }
      if (MOCK && b.mockJoined && typeof b.mockJoined === "object")   /* the rig's join dates, guildId -> ms */
        gate.joined = Object.fromEntries(Object.entries(b.mockJoined).filter(([k, v]) => /^[0-9]{5,25}$/.test(k) && Number.isFinite(Number(v))).map(([k, v]) => [k, Number(v)]));
      let acc = db.accounts[who.id];
      /* an allied operator never enters the approval queue and never becomes
         a fleet record: standing ALLIED from the first sign-in, org attached.
         A fleet member who is ALSO in an allied Discord stays a fleet member. */
      if (gate.allied && (!acc || acc.role === "pending" || acc.role === "allied")) {
        const fresh = !acc || acc.role !== "allied" || !acc.relayToken;
        if (!acc) acc = db.accounts[who.id] = { discordName: who.username, role: "allied", createdAt: Date.now() };
        acc.role = "allied"; acc.org = gate.allied.name; acc.orgGuild = gate.allied.id;
        /* A NEW token is worthless until the relay's ACLs list it. The sync
           runs in the background; the answer says the relay is settling and
           the app holds RESTRICTED back as ACCESS PENDING until it has. */
        if (fresh) { tokensFor(acc); persist(); requestRelaySync("allied sign-in " + who.username); }
      }
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
          try { persist(); }
          catch (error) {
            if (previous) db.accounts[who.id] = previous; else delete db.accounts[who.id];
            throw error;
          }
          requestRelaySync("bootstrap");
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
      acc.inFleet = !!gate.fleet; acc.alliedIn = gate.alliedIn || [];   /* refreshed on every sign-in */
      if (gate.joined && Object.keys(gate.joined).length) acc.guildJoined = Object.assign({}, acc.guildJoined || {}, gate.joined);
      const token = crypto.randomBytes(24).toString("hex");
      db.sessions[token] = { discordId: who.id, createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL_MS };
      cleanSessions();
      persist();
      return send(res, 200, { ok: true, token, account: Object.assign(pub(acc, who.id), alliedView(acc)), relay: relayFor(acc), relaySync: relaySyncState() });
    }

    const a = auth(req);
    if (!a) return send(res, 401, { ok: false, error: "unauthorized" });

    if (p === "/api/me" && req.method === "GET") {
      if (Date.now() - (a.acc.lastSeen || 0) > 60000) { a.acc.lastSeen = Date.now(); persist(); }
      const me = Object.assign(pub(a.acc, a.id), { sessionCallsign: a.session.callsign || null }, alliedView(a.acc));
      return send(res, 200, { ok: true, account: me, relay: relayFor(a.acc), relaySync: relaySyncState() });
    }
    /* sign out: the presenting session dies server-side, not just in the
       browser — a shared machine can't resurrect it from a saved token */
    if (p === "/api/logout" && req.method === "POST") {
      const tok = (/^Bearer (.+)$/.exec(req.headers.authorization || "") || [])[1];
      if (tok && db.sessions[tok]) { delete db.sessions[tok]; persist(); }
      return send(res, 200, { ok: true });
    }
    /* The app's callsign is a TACTICAL name for this session — TIBER DOC 1
       tonight, WARRIOR TAC 4 tomorrow — not who the operator is. It is filed
       on the presenting session and dies with it; the account's callsign is
       the site's (personnel records, the muster) and the app never writes it.
       Until 2026-09-03 this overwrote the account, so every op renamed people
       on the portal. */
    if (p === "/api/callsign" && req.method === "POST") {
      const b = await body(req);
      const cs = String(b.callsign || "").trim().toUpperCase().replace(/[^ A-Z0-9_.\-'"()[\]]+/g, "").slice(0, 40);
      if (!cs) return send(res, 400, { ok: false, error: "empty callsign" });
      a.session.callsign = cs; persist();
      return send(res, 200, { ok: true, account: Object.assign(pub(a.acc, a.id), { sessionCallsign: cs }) });
    }

    /* command-only below */
    if (a.acc.role !== "command") return send(res, 403, { ok: false, error: "COMMAND role required" });

    const leadRoute = /^\/api\/accounts\/([A-Za-z0-9-]{1,40})\/orglead$/.exec(p);
    if (leadRoute && req.method === "POST") {
      const b = await body(req);
      const target = db.accounts[leadRoute[1]];
      if (!target) return send(res, 404, { ok: false, error: "no such account" });
      if (target.role !== "allied") return send(res, 400, { ok: false, error: "only an ALLIED account can lead an organization" });
      const lead = b.lead === true;
      await serializeMutation(async () => { target.orgLead = lead; tokensFor(target); persist(); });
      audit(a.acc.callsign || a.acc.discordName, a.id, "standing", (target.callsign || target.discordName || leadRoute[1]) + ": org lead " + (lead ? "granted" : "removed") + " (" + (target.org || "?") + ")");
      requestRelaySync("org lead " + (target.discordName || leadRoute[1]));
      return send(res, 200, { ok: true, account: pub(target, leadRoute[1]), relaySync: relaySyncState() });
    }
    if (p === "/api/allied" && req.method === "GET") {
      return send(res, 200, { ok: true, allied: Object.entries(db.allied).map(([id, g]) => ({ guildId: id, name: g.name, addedAt: g.addedAt || null,
        accounts: Object.values(db.accounts).filter(x => x.role === "allied" && x.orgGuild === id).length })) });
    }
    if (p === "/api/allied" && req.method === "POST") {
      const b = await body(req);
      const id = String(b.guildId || "").trim(), name = String(b.name || "").trim().replace(/\s+/g, " ").slice(0, 60);
      if (!/^\d{5,25}$/.test(id)) return send(res, 400, { ok: false, error: "guildId must be the Discord server id (a number)" });
      if (!name) return send(res, 400, { ok: false, error: "name required" });
      if (id === GUILD_ID) return send(res, 400, { ok: false, error: "that is the fleet's own Discord" });
      db.allied[id] = { name, addedAt: Date.now(), by: a.id }; persist();
      audit(a.acc.callsign || a.acc.discordName, a.id, "allied", "added " + name + " (" + id + ")");
      return send(res, 200, { ok: true });
    }
    const alliedRemove = /^\/api\/allied\/(\d{5,25})\/remove$/.exec(p);
    if (alliedRemove && req.method === "POST") {
      if (!db.allied[alliedRemove[1]]) return send(res, 404, { ok: false, error: "no such allied org" });
      const name = db.allied[alliedRemove[1]].name;
      delete db.allied[alliedRemove[1]]; persist();
      audit(a.acc.callsign || a.acc.discordName, a.id, "allied", "removed " + name + " (" + alliedRemove[1] + ") — its operators keep ALLIED standing until revoked");
      return send(res, 200, { ok: true });
    }
    if (p === "/api/accounts" && req.method === "GET") {
      return send(res, 200, { ok: true, accounts: Object.entries(db.accounts).map(([id, acc]) => pub(acc, id)), relaySync: relaySyncState(), fleetGuild: GUILD_ID || null });
    }

    let m;
    /* ── shared 1MC sound library (COMMAND only, like the 1MC itself) ── */
    if (p === "/api/sounds" && req.method === "GET") {
      return send(res, 200, { ok: true, sounds: Object.entries(db.sounds)
        .map(([id, s]) => ({ id, name: s.name, size: s.size }))
        .sort((x, y) => x.name.localeCompare(y.name)) });
    }
    if (p === "/api/sounds" && req.method === "POST") {
      /* base64 inflates 4/3, plus JSON overhead — 6MB of body carries a 4MB clip */
      const b = await body(req, 6 * 1024 * 1024);
      /* clip files are stored by id, so the name is pure display metadata —
         apostrophes are safe and BOATSWAIN'S CALL should read like one */
      const name = String(b.name || "").replace(/[^\w.\-' ]+/g, "_").slice(0, 80);
      if (!SOUND_EXT.test(name)) return send(res, 400, { ok: false, error: "clip must be wav/mp3/ogg/m4a/flac/webm" });
      if (Object.keys(db.sounds).length >= SOUND_MAX_COUNT)
        return send(res, 400, { ok: false, error: "sound library is full (" + SOUND_MAX_COUNT + " clips) — delete some first" });
      let bytes;
      try { bytes = Buffer.from(String(b.data || ""), "base64"); } catch (e) { bytes = Buffer.alloc(0); }
      if (!bytes.length) return send(res, 400, { ok: false, error: "empty clip" });
      if (bytes.length > SOUND_MAX_BYTES) return send(res, 400, { ok: false, error: "clip is over 4MB — 1MC clips are seconds long" });
      if (Object.values(db.sounds).some(s => s.name === name))
        return send(res, 400, { ok: false, error: "a clip named " + name + " already exists" });
      const id = crypto.randomBytes(8).toString("hex");
      const ext = name.match(SOUND_EXT)[1].toLowerCase();
      fs.writeFileSync(soundPath(id, ext), bytes, { mode: 0o600 });
      db.sounds[id] = { name, size: bytes.length, ext, by: a.id, at: Date.now() };
      saveSounds();
      return send(res, 200, { ok: true, id, name, size: bytes.length });
    }
    if ((m = /^\/api\/sounds\/([a-f0-9]{16})$/.exec(p)) && req.method === "GET") {
      const s = db.sounds[m[1]];
      if (!s) return send(res, 404, { ok: false, error: "no such clip" });
      try { return send(res, 200, { ok: true, id: m[1], name: s.name, data: fs.readFileSync(soundPath(m[1], s.ext)).toString("base64") }); }
      catch (e) { return send(res, 404, { ok: false, error: "clip bytes are missing on the server" }); }
    }
    if ((m = /^\/api\/sounds\/([a-f0-9]{16})\/delete$/.exec(p)) && req.method === "POST") {
      const s = db.sounds[m[1]];
      if (!s) return send(res, 404, { ok: false, error: "no such clip" });
      try { fs.unlinkSync(soundPath(m[1], s.ext)); } catch (e) {}
      delete db.sounds[m[1]];
      saveSounds();
      return send(res, 200, { ok: true });
    }
    /* manual (pre-Discord) member ids are m-<hex>, so the id segment is wider
       than a Discord snowflake */
    if ((m = /^\/api\/accounts\/([A-Za-z0-9-]{1,40})\/role$/.exec(p)) && req.method === "POST") {
      const b = await body(req);
      if (!["pending", "allied", "member", "element", "command", "revoked"].includes(b.role)) return send(res, 400, { ok: false, error: "bad role" });
      if (m[1] === a.id && b.role !== "command") return send(res, 400, { ok: false, error: "cannot demote yourself" });
      /* ALLIED standing needs an organization: an ally who sits in the fleet's
         own Discord arrives as pending/member, and COMMAND files them under
         their org here. The org must be on the allied list. */
      const orgGuild = b.orgGuild !== undefined ? String(b.orgGuild || "").trim() : null;
      if (b.role === "allied") {
        const target0 = db.accounts[m[1]];
        const chosen = orgGuild || (target0 && target0.orgGuild) || "";
        if (!chosen || !db.allied[chosen]) return send(res, 400, { ok: false, error: "ALLIED standing needs one of the listed allied organizations (orgGuild)" });
      }
      const updated = await serializeMutation(async () => {
        const target = db.accounts[m[1]];
        if (!target) throw Object.assign(new Error("no such account"), { statusCode: 404 });
        /* the fleet must never lock itself out: refuse to remove the last
           administrator (COMMAND role or itAdmin flag) standing */
        if (target.role === "command" && b.role !== "command") {
          const admins = Object.entries(db.accounts).filter(([id, acc]) =>
            (acc.role === "command" && id !== m[1]) || acc.itAdmin === true).length;
          if (!admins) throw Object.assign(new Error("cannot remove the fleet's last administrator"), { statusCode: 400 });
        }
        const previousRole = target.role;
        const removedSessions = {};
        target.role = b.role;
        if (b.role === "allied") {
          const chosen = orgGuild || target.orgGuild;
          target.orgGuild = chosen; target.org = db.allied[chosen].name;
        } else if (b.role !== "revoked") { delete target.orgLead; }   /* a fleet standing carries no org lead */
        audit(a.acc.callsign || a.acc.discordName, a.id, "standing",
          (target.callsign || target.discordName || m[1]) + ": " + previousRole + " -> " + b.role);
        try { portal.onStanding(m[1], previousRole, b.role); } catch (error) { console.error("[portal] onStanding:", error.message); }
        tokensFor(target);
        if (b.role === "revoked") {
          for (const [sessionToken, session] of Object.entries(db.sessions)) {
            if (session && session.discordId === m[1]) { removedSessions[sessionToken] = session; delete db.sessions[sessionToken]; }
          }
        }
        persist();
        return pub(target, m[1]);
      });
      requestRelaySync("standing " + (updated.discordName || m[1]));
      return send(res, 200, { ok: true, account: updated, relaySync: relaySyncState() });
    }
    if (p === "/api/nets/access" && req.method === "GET") {
      return send(res, 200, { ok: true, access: db.netAccess });
    }
    if (p === "/api/nets/access" && req.method === "POST") {
      const b = await body(req);
      const netName = String(b.net || "").trim().slice(0, 120);
      const orgLevel = /^org:(\d{5,25})$/.exec(String(b.level || ""));
      if (!netName || (!["open", "joint", "member", "command"].includes(b.level) && !orgLevel)) return send(res, 400, { ok: false, error: "need net + level(open|joint|member|command|org:<guildId>)" });
      if (orgLevel && !db.allied[orgLevel[1]]) return send(res, 400, { ok: false, error: "no allied organization with that Discord id" });
      await serializeMutation(async () => { db.netAccess[netName] = b.level; persist(); });
      requestRelaySync("net access " + netName + " -> " + b.level);
      return send(res, 200, { ok: true, access: db.netAccess, relaySync: relaySyncState() });
    }
    return send(res, 404, { ok: false, error: "no such route" });
  } catch (e) {
    return send(res, e.statusCode || 500, { ok: false, error: e.message });
  }
});
/* role changes legitimately hold their request open through a fail-closed
   full-tree ACL sync — budget for the fleet's real channel count with room
   to grow, not for a toy tree */
server.requestTimeout = 45000;
server.headersTimeout = 16000;
server.keepAliveTimeout = 5000;
server.maxRequestsPerSocket = 100;
server.listen(PORT, HOST, () => console.log("[fleetcomm-accounts] listening on " + HOST + ":" + PORT + (MOCK ? " (MOCK DISCORD MODE)" : "")));
requestRelaySync("startup");
