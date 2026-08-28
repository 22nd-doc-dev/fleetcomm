"use strict";
/*
 * Seeds the org channel tree on a Mumble server from a package config.
 * Usage: node scripts/seed-channels.js <host> <SuperUser-password> [configPath]
 * Idempotent: skips channels that already exist.
 */
const { MumbleClient } = require("../src/mumble-client");

/* Mumble's default channel-name rules disallow some chars (e.g. "/") */
function chanName(name) { return name.replace(/[^ \-=\w#\[\]{}()@|]/g, "-"); }
const pause = (ms) => new Promise(r => setTimeout(r, ms));

async function seed(host, superPw, cfg, port) {
  const c = new MumbleClient({ host, port: port || 64738, username: "SuperUser", password: superPw });
  await c.connect();
  await new Promise(r => setTimeout(r, 300)); // let channel states land
  let rootId = c.channelByName(chanName(cfg.rootChannel));
  if (rootId == null) { rootId = await c.createChannel(chanName(cfg.rootChannel), 0, cfg.org + " operating area"); await pause(400); }
  const ids = { __root: rootId };
  for (const net of cfg.nets) {
    const nm = chanName(net.name);
    let id = c.channelByName(nm);
    if (id == null) { id = await c.createChannel(nm, rootId, "Net " + net.freq + (net.enc ? " · ENCRYPTED" : "")); await pause(400); } // stay under the server's flood limiter
    ids[net.name] = id;
  }
  c.disconnect();
  return ids;
}
module.exports = { seed };

if (require.main === module) {
  const [host, pw, cfgPath] = process.argv.slice(2);
  if (!host || !pw) { console.error("usage: node scripts/seed-channels.js <host> <SuperUser-pw> [config]"); process.exit(1); }
  const cfg = require(cfgPath ? require("path").resolve(cfgPath) : "../config/22nd-package.json");
  seed(host, pw, cfg).then(ids => { console.log("Channel tree ready:", ids); process.exit(0); })
    .catch(e => { console.error("seed failed:", e.message); process.exit(1); });
}
