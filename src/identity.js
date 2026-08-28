"use strict";
/* Per-user self-signed client certificate = stable identity on the relay.
   Generated once, persisted, reused for every connection. */
const fs = require("fs");
const path = require("path");
const selfsigned = require("selfsigned");

async function loadOrCreate(dir, name) {
  const file = path.join(dir, "fleetcomm-identity.json");
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) {}
  const pems = await selfsigned.generate(
    [{ name: "commonName", value: name || "FleetComm Operator" }],
    { days: 3650, keySize: 2048, algorithm: "sha256",
      extensions: [
        { name: "basicConstraints", cA: false },
        { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
        /* Mumble treats a cert as "strong" only when it carries an email SAN */
        { name: "subjectAltName", altNames: [{ type: 1, value: "operator@fleetcomm.local" }] }
      ] }
  );
  const id = { cert: pems.cert, key: pems.private };
  try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, JSON.stringify(id)); } catch (e) {}
  return id;
}
module.exports = { loadOrCreate };
