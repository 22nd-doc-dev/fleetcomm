"use strict";
/*
 * Seeds the org channel tree on a Mumble server from a package config.
 * Usage: node scripts/seed-channels.js <host> <SuperUser-password> [configPath]
 * Idempotent: skips channels that already exist.
 */
const { MumbleClient } = require("../src/mumble-client");
const { encodeMeta } = require("../src/net-meta");
const { channelName: chanName } = require("../src/channel-name");

/* Mumble's default channel-name rules disallow some chars (e.g. "/") */
const pause = (ms) => new Promise(r => setTimeout(r, ms));

async function seed(host, superPw, cfg, port) {
  const c = new MumbleClient({ host, port: port || 64738, username: "SuperUser", password: superPw });
  await c.connect();
  await new Promise(r => setTimeout(r, 300)); // let channel states land
  let rootId = c.channelByName(chanName(cfg.rootChannel));
  if (rootId == null) { rootId = await c.createChannel(chanName(cfg.rootChannel), 0, cfg.org + " operating area"); await pause(400); }
  const ids = { __root: rootId };
  async function addAll(items, parentId, prefix) {
    for (const item of items || []) {
      const name = chanName(item.name);
      let id = c.channelByName(name);
      if (id == null) {
        /* murmur throttles bulk channel creation with a slowly-refilling
           bucket (proven against the droplet: a fixed 400ms pace stalls
           partway through a 44-channel tree). Ride it out per channel —
           and re-check by name first on every retry, because a creation can
           LAND while its ack loses the race with our timeout. */
        for (let attempt = 1; ; attempt++) {
          try { id = await c.createChannel(name, parentId, encodeMeta(item)); break; }
          catch (e) {
            id = c.channelByName(name);
            if (id != null) break;
            if (!/timeout creating/.test(e.message) || attempt >= 12) throw e;
            await pause(2500);
          }
        }
        await pause(400); // baseline pacing between creations
      }
      const key = prefix ? prefix + "/" + item.name : item.name;
      ids[key] = id;
      await addAll(item.subnets, id, key);
    }
  }
  await addAll(cfg.nets, rootId, "");
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
