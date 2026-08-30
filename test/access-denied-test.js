"use strict";
/* Tuning a net you may not enter must FAIL, loudly.
 *
 * Joining a Mumble channel is fire-and-forget: the server answers a refused
 * Enter with PermissionDenied and simply leaves you where you were. FleetComm
 * used to ignore that, so a member could "tune" COMMAND NET, see it go green,
 * and sit in Root hearing nothing — an unplugged controller. tune() now waits
 * for the server to confirm the move, or to refuse it.
 */
const assert = require("assert");
const { RadioStack } = require("../src/radio-stack");
const { MumbleClient } = require("../src/mumble-client");
const { setToken } = require("../scripts/set-admin-token");
const selfsigned = require("selfsigned");
const cfg = require("../config/22nd-package.json");

const SAN = { name: "subjectAltName", altNames: [{ type: 1, value: "test@fleetcomm.local" }] };
const HOST = "127.0.0.1", SUPW = "devpass123", TOKEN = "cmd-deny-3312";
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const PERM = { Traverse: 0x02, Enter: 0x04, Speak: 0x08 };

(async () => {
  const rootId = await setToken(HOST, SUPW, TOKEN, cfg);
  const su = new MumbleClient({ host: HOST, username: "SuperUser", password: SUPW });
  await su.connect(); await wait(400);

  /* a net only the token holder may enter */
  const name = "RESTRICTED NET";
  let chan = su.channelByName(name);
  if (chan == null) { chan = await su.createChannel(name, rootId); await wait(400); }
  su.send("ACL", {
    channelId: chan, inheritAcls: false, groups: [],
    acls: [
      { applyHere: true, applySubs: true, userId: undefined, group: "all",
        grant: 0, deny: PERM.Enter },
      { applyHere: true, applySubs: true, group: "#" + TOKEN,
        grant: PERM.Traverse | PERM.Enter | PERM.Speak, deny: 0 }
    ]
  });
  await wait(600);
  console.log("1) created " + name + " with Enter denied to everyone but the command token");

  /* the operator WITHOUT the token must be refused, not silently parked */
  const pems = await selfsigned.generate([{ name: "commonName", value: "deny-rating" }], { days: 1, keySize: 2048, extensions: [SAN] });
  const rating = new RadioStack({ host: HOST, port: 64738, callsign: "RATING-DENY",
                                  cert: pems.cert, key: pems.private });
  let refused = false, msg = "";
  try { await rating.tune({ name, freq: "299.900", channel: name }); }
  catch (e) { refused = true; msg = e.message; }
  assert(refused, "tuning a restricted net must throw, not report success");
  assert(/don't have access/i.test(msg), "and the message must say it is an access problem: " + msg);
  console.log("2) non-holder REFUSED ✓ — \"" + msg.slice(0, 72) + "…\"");

  /* and it must not be left half-tuned */
  assert(rating.nets.every(n => n.dead), "the refused connection is torn down, not left dangling");
  console.log("3) the refused attempt left nothing half-open ✓");

  /* the token holder still gets in normally */
  const pems2 = await selfsigned.generate([{ name: "commonName", value: "deny-officer" }], { days: 1, keySize: 2048, extensions: [SAN] });
  const officer = new RadioStack({ host: HOST, port: 64738, callsign: "OFFICER-OK",
                                   tokens: [TOKEN], cert: pems2.cert, key: pems2.private });
  const idx = await officer.tune({ name, freq: "299.900", channel: name });
  assert(idx != null, "the token holder tunes normally");
  console.log("4) command-token holder tuned the same net ✓");

  /* an ordinary net is unaffected */
  const idx2 = await rating.tune(cfg.nets[1]);
  assert(idx2 != null, "an unrestricted net still tunes for everyone");
  console.log("5) unrestricted nets are unaffected ✓");

  officer.destroy(); rating.destroy();
  su.send("ChannelRemove", { channelId: chan });
  await wait(300); su.disconnect();
  console.log("\n✔ ACCESS DENIED PASS — a net you can't enter says so instead of pretending");
  process.exit(0);
})().catch(e => { console.error("✘ FAIL:", e); process.exit(1); });
