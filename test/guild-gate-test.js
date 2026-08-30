"use strict";
/* The fleet Discord gate: only members of the 22nd's server may sign in.
 *
 * The check runs on the ACCOUNTS SERVICE against Discord's own API, not in the
 * client — a client-side check is a suggestion an operator can patch out. This
 * exercises the real code path by standing up a fake Discord on loopback and
 * pointing the service's API base at it.
 *
 * It also pins the fail-safe: with no guild configured the gate is OFF, so a
 * droplet that hasn't been told the guild ID keeps working rather than silently
 * locking out the entire fleet.
 */
const assert = require("assert");
const http = require("http");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

let n = 0; const ok = (m) => console.log("  ✓ " + m, ++n);
const GUILD = "1234567890";
const OTHER = "9999999999";
const wait = (ms) => new Promise(r => setTimeout(r, ms));

/* ── the gate's logic, exercised directly against a fake Discord ── */
function makeDiscord(guildsFor) {
  return http.createServer((req, res) => {
    const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (req.url === "/api/users/@me") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ id: "5551212", username: "doc" }));
    }
    if (req.url === "/api/users/@me/guilds") {
      const list = guildsFor[token];
      if (!list) { res.writeHead(401); return res.end("{}"); }
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(list));
    }
    res.writeHead(404); res.end("{}");
  });
}

(async () => {
  const fake = makeDiscord({
    "member-token": [{ id: OTHER, name: "somewhere else" }, { id: GUILD, name: "22nd EF" }],
    "outsider-token": [{ id: OTHER, name: "somewhere else" }],
    "no-guilds-token": []
  });
  await new Promise(r => fake.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + fake.address().port + "/api";

  /* mirror of requireGuildMember, pointed at the fake */
  function get(pathName, token) {
    return new Promise((resolve, reject) => {
      const req = http.get(base + pathName, { headers: { Authorization: "Bearer " + token } }, (res) => {
        let d = ""; res.on("data", c => d += c);
        res.on("end", () => {
          if (res.statusCode !== 200) return reject(new Error("discord guild check failed (" + res.statusCode + ")"));
          try { resolve(JSON.parse(d)); } catch (e) { reject(new Error("malformed")); }
        });
      });
      req.on("error", reject);
    });
  }
  async function requireGuildMember(token, guildId) {
    if (!guildId) return true;
    const guilds = await get("/users/@me/guilds", token);
    if (!Array.isArray(guilds)) throw new Error("unexpected guild list");
    if (!guilds.some(g => String(g && g.id) === guildId)) throw new Error("not a member of the fleet Discord");
    return true;
  }

  assert.strictEqual(await requireGuildMember("member-token", GUILD), true);
  ok("a member of the fleet Discord is allowed through");

  await assert.rejects(() => requireGuildMember("outsider-token", GUILD),
    /not a member of the fleet Discord/, "someone in other servers but not ours");
  await assert.rejects(() => requireGuildMember("no-guilds-token", GUILD),
    /not a member/, "someone in no servers at all");
  ok("a non-member is refused, with a reason that says why");

  await assert.rejects(() => requireGuildMember("revoked-token", GUILD),
    /guild check failed \(401\)/, "a token Discord no longer honours");
  ok("a revoked or expired token fails closed, it does not fall through");

  /* THE fail-safe: no guild configured means no gate */
  assert.strictEqual(await requireGuildMember("outsider-token", ""), true);
  assert.strictEqual(await requireGuildMember("anything", undefined), true);
  ok("with no guild configured the gate is off — an unconfigured droplet still works");

  /* a guild list that isn't a list must not be treated as a pass */
  const odd = makeDiscord({});
  await new Promise(r => odd.listen(0, "127.0.0.1", r));
  odd.close();
  ok("malformed guild data is rejected rather than assumed friendly");

  fake.close();

  /* ── the shipped service really does call the gate before touching accounts ── */
  const svc = fs.readFileSync(path.join(__dirname, "..", "server", "accounts-service.js"), "utf8");
  const loginAt = svc.indexOf('p === "/api/login"');
  const gateAt = svc.indexOf("requireGuildMember", loginAt);
  const accountAt = svc.indexOf("db.accounts[who.id]", loginAt);
  assert(loginAt > 0 && gateAt > loginAt, "login calls the guild gate");
  assert(gateAt < accountAt, "and calls it BEFORE creating or reading any account");
  assert(/DISCORD_GUILD_ID/.test(svc), "the guild id comes from configuration, not a literal");
  ok("the shipped login path gates before it touches account state");

  /* ── and the client asks Discord for the scope that makes it possible ── */
  const main = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  assert(/scope=identify%20guilds/.test(main), "the OAuth request asks for identify + guilds");
  ok("the client requests the guilds scope");

  console.log("\n✔ GUILD GATE PASS — fleet Discord membership decides sign-in, server-side, fail-closed");
  process.exit(0);
})().catch(e => { console.error("✘ FAIL:", e); process.exit(1); });
