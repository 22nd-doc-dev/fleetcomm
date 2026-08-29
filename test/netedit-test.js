"use strict";
/* Proof for the right-click net editor, end to end against a live relay:
 *
 *  - the Write bit added to the command token actually lets COMMAND rename,
 *    re-home and delete nets (this is what `npm run admin-token` installs);
 *  - those edits go out over ANY live connection, so you do NOT have to be
 *    tuned to a net to edit it — the old code required it and that greyed out
 *    most of the right-click menu;
 *  - every call reports what the relay really did instead of assuming success;
 *  - an operator WITHOUT the token is refused by the server, not by the UI.
 */
const assert = require("assert");
const { RadioStack } = require("../src/radio-stack");
const { MumbleClient } = require("../src/mumble-client");
const { setToken } = require("../scripts/set-admin-token");
const selfsigned = require("selfsigned");
const cfg = require("../config/22nd-package.json");

const SAN = { name: "subjectAltName", altNames: [{ type: 1, value: "test@fleetcomm.local" }] };
const HOST = "127.0.0.1", SUPW = "devpass123", TOKEN = "cmd-edit-7741";
const wait = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const pems = await selfsigned.generate([{ name: "commonName", value: "edit-officer" }], { days: 1, keySize: 2048, extensions: [SAN] });
  const rootId = await setToken(HOST, SUPW, TOKEN, cfg);
  console.log("1) command token installed on org root (channel " + rootId + ")");

  /* COMMAND, tuned to exactly ONE net */
  const cmd = new RadioStack({ host: HOST, port: 64738, callsign: "EDIT-CMD",
                               tokens: [TOKEN], cert: pems.cert, key: pems.private });
  const homeIdx = await cmd.tune(cfg.nets[0]);
  assert(homeIdx != null, "COMMAND tuned one net");
  await wait(400);

  /* a scratch net that is deliberately never tuned by anyone */
  const su = new MumbleClient({ host: HOST, username: "SuperUser", password: SUPW });
  await su.connect(); await wait(400);
  const scratchId = await su.createChannel("EDIT PROBE", rootId);
  await wait(400);
  console.log("2) scratch net EDIT PROBE created (id " + scratchId + ") — never tuned by anyone");

  let r = await cmd.renameNet("EDIT PROBE", "EDIT PROBE II");
  assert(r.ok, "rename an untuned net: " + JSON.stringify(r));
  await wait(400);
  assert(su.channelByName("EDIT PROBE II") != null, "relay shows the new name");
  assert(su.channelByName("EDIT PROBE") == null, "old name is gone");
  console.log("3) COMMAND renamed an UNTUNED net ✓");

  r = await cmd.moveNet("EDIT PROBE II", "UEES TIBER");
  assert(r.ok, "re-home: " + JSON.stringify(r));
  await wait(400);
  assert(su.channels.get(su.channelByName("EDIT PROBE II")).parent === su.channelByName("UEES TIBER"),
         "re-homed under UEES TIBER");
  console.log("4) re-homed under UEES TIBER ✓");

  r = await cmd.moveNet("EDIT PROBE II", "NO SUCH NET");
  assert(!r.ok && /no net named/i.test(r.error), "unknown parent must be reported: " + JSON.stringify(r));
  r = await cmd.renameNet("GHOST NET", "WHATEVER");
  assert(!r.ok, "unknown net must be rejected");
  console.log("5) unknown parent and unknown net reported honestly, not silently ✓");

  /* an operator without the token must be refused by the SERVER */
  const pems2 = await selfsigned.generate([{ name: "commonName", value: "edit-rating" }], { days: 1, keySize: 2048, extensions: [SAN] });
  const rating = new RadioStack({ host: HOST, port: 64738, callsign: "EDIT-RATING",
                                  cert: pems2.cert, key: pems2.private });
  await rating.tune(cfg.nets[0]);
  await wait(400);
  const bad = await rating.renameNet("EDIT PROBE II", "HIJACKED");
  assert(!bad.ok, "non-holder must NOT be able to rename: " + JSON.stringify(bad));
  await wait(300);
  assert(su.channelByName("HIJACKED") == null, "and the relay kept the old name");
  console.log("6) non-COMMAND rename DENIED by the relay ✓ (" + bad.error + ")");

  r = await cmd.removeNet("EDIT PROBE II");
  assert(r.ok, "delete: " + JSON.stringify(r));
  await wait(400);
  assert(su.channelByName("EDIT PROBE II") == null, "channel really gone from the relay");
  console.log("7) deleted from the relay ✓");

  cmd.destroy(); rating.destroy(); su.disconnect();
  console.log("\n✔ NET EDIT PASS — untuned edits work, Write bit is live, refusals are honest");
  process.exit(0);
})().catch(e => { console.error("✘ FAIL:", e); process.exit(1); });
