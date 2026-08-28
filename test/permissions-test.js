"use strict";
/* Proves the command-token permission model against a live server:
   token holder can create a net under the org root; non-holder is denied. */
const assert = require("assert");
const { MumbleClient } = require("../src/mumble-client");
const { setToken } = require("../scripts/set-admin-token");
const selfsigned = require("selfsigned");
const SAN = { name: "subjectAltName", altNames: [{ type: 1, value: "test@fleetcomm.local" }] };
const cfg = require("../config/22nd-package.json");

const HOST = "127.0.0.1", SUPW = "devpass123", TOKEN = "cmd-alpha-2956";

(async () => {
  const pems = await selfsigned.generate([{ name: "commonName", value: "test-officer" }], { days: 1, keySize: 2048, extensions: [SAN] });
  const pems2 = await selfsigned.generate([{ name: "commonName", value: "test-rating" }], { days: 1, keySize: 2048, extensions: [SAN] });
  const rootId = await setToken(HOST, SUPW, TOKEN, cfg);
  console.log("1) command token installed on org root (channel", rootId + ")");

  const officer = new MumbleClient({ host: HOST, username: "officer-test", tokens: [TOKEN], cert: pems.cert, key: pems.private });
  const rating = new MumbleClient({ host: HOST, username: "rating-test", cert: pems2.cert, key: pems2.private });
  await officer.connect(); await rating.connect();
  await new Promise(r => setTimeout(r, 300));

  const newId = await officer.createChannel("STRIKE TWO", rootId);
  console.log("2) token holder created STRIKE TWO (channel", newId + ") ✓");

  let denied = false;
  try { await rating.createChannel("ROGUE NET", rootId); }
  catch (e) { denied = /PermissionDenied/.test(e.message); }
  assert(denied, "non-holder must be denied");
  console.log("3) non-holder DENIED channel creation ✓ (server-enforced)");

  /* cleanup */
  const admin = new MumbleClient({ host: HOST, username: "SuperUser", password: SUPW });
  await admin.connect(); await new Promise(r => setTimeout(r, 300));
  admin.send("ChannelRemove", { channelId: newId });
  await new Promise(r => setTimeout(r, 300));
  admin.disconnect(); officer.disconnect(); rating.disconnect();
  console.log("✔ PERMISSIONS PASS — command token model works");
  process.exit(0);
})().catch(e => { console.error("✘ FAIL:", e); process.exit(1); });
