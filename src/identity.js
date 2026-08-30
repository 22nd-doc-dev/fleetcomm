"use strict";
/* Per-user self-signed client certificate = stable identity on the relay.
   Generated once, persisted, reused for every connection. */
const fs = require("fs");
const path = require("path");
const selfsigned = require("selfsigned");

async function loadOrCreate(dir, name) {
  const file = path.join(dir, "fleetcomm-identity.json");
  try {
    const existing = JSON.parse(fs.readFileSync(file, "utf8"));
    try { fs.chmodSync(file, 0o600); } catch (error) {}
    return existing;
  } catch (e) {}
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
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify(id), { mode: 0o600 });
    fs.chmodSync(file, 0o600);
  } catch (e) {}
  return id;
}
module.exports = { loadOrCreate };
