"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { loadOrCreate } = require("../src/identity");

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleetcomm-identity-"));
  try {
    const first = await loadOrCreate(dir, "Test Operator");
    assert(first.cert.includes("BEGIN CERTIFICATE") && first.key.includes("PRIVATE KEY"));
    const file = path.join(dir, "fleetcomm-identity.json");
    /* POSIX modes are a fiction on Windows (stat always reports 0o666); there
       the file's privacy comes from the user profile's ACL, not the mode bits. */
    const posix = process.platform !== "win32";
    if (posix) assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600, "identity file must be private");
    fs.chmodSync(file, 0o644);
    const second = await loadOrCreate(dir, "Different Name");
    assert.deepStrictEqual(second, first, "the persisted identity must be stable");
    if (posix) assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600, "existing identity permissions are repaired");
    console.log("✔ IDENTITY PASS — stable certificate persisted with private permissions");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
})().catch(error => { console.error("✘ FAIL:", error); process.exitCode = 1; });
