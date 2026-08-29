"use strict";
/*
 * Grants channel-creation authority to holders of a "command token".
 * The token is a passphrase; anyone who enters it in FleetComm settings can
 * create nets on the fly. Enforced by the SERVER via Mumble ACLs — clients
 * without the token get PermissionDenied no matter what they send.
 *
 * Usage: node scripts/set-admin-token.js <host> <SuperUser-pw> <token> [configPath]
 * Re-running replaces the previous token (old one stops working).
 */
const path = require("path");
const { MumbleClient } = require("../src/mumble-client");

const PERM = { Write: 0x01, MakeChannel: 0x40, MakeTempChannel: 0x400 };
function chanName(name) { return name.replace(/[^ \-=\w#\[\]{}()@|]/g, "-"); }

async function setToken(host, supw, token, cfg, port) {
  const c = new MumbleClient({ host, port: port || 64738, username: "SuperUser", password: supw });
  await c.connect();
  await new Promise(r => setTimeout(r, 400));
  const rootId = c.channelByName(chanName(cfg.rootChannel));
  if (rootId == null) throw new Error("org root channel not found — run the seed first");
  c.send("ACL", {
    channelId: rootId,
    inheritAcls: true,
    groups: [],
    acls: [{
      applyHere: true, applySubs: true,
      group: "#" + token,
      grant: PERM.Write | PERM.MakeChannel | PERM.MakeTempChannel
    }],
    query: false
  });
  await new Promise(r => setTimeout(r, 400));
  c.disconnect();
  return rootId;
}
module.exports = { setToken };

if (require.main === module) {
  const [host, pw, token, cfgPath] = process.argv.slice(2);
  if (!host || !pw || !token) { console.error("usage: node scripts/set-admin-token.js <host> <SuperUser-pw> <token>"); process.exit(1); }
  const cfg = require(cfgPath ? path.resolve(cfgPath) : "../config/22nd-package.json");
  setToken(host, pw, token, cfg)
    .then(() => { console.log("Command token set. Holders can now create nets under \"" + cfg.rootChannel + "\"."); process.exit(0); })
    .catch(e => { console.error("failed:", e.message); process.exit(1); });
}
