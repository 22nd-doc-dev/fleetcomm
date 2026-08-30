"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { applyUpdate, isPortableExecutable, validVersion } = require("../src/update-helper");

function fakePe(file, marker) {
  const bytes = Buffer.alloc(256, 0);
  bytes.write("MZ", 0, "latin1");
  bytes.writeUInt32LE(128, 0x3c);
  bytes.write("PE\0\0", 128, "latin1");
  bytes.write(marker, 160, "utf8");
  fs.writeFileSync(file, bytes);
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleetcomm-updater-"));
  const exe = path.join(dir, "FleetComm.exe");
  const fresh = path.join(dir, "FleetComm-new.exe");
  const backup = exe + ".old";
  const stateFile = path.join(dir, "state.json");
  fakePe(exe, "OLD"); fakePe(fresh, "NEW");

  assert(validVersion("0.10.0") && !validVersion("../../bad"), "remote versions are constrained");
  assert(isPortableExecutable(fresh, 100), "PE signature is checked, not only MZ");
  const ok = await applyUpdate({ exe, fresh, backup, stateFile, target: "0.10.0", parentPid: 999,
    minimumBytes: 100 }, { noRelaunch: true, processAlive: () => false });
  assert(ok.ok && fs.existsSync(exe) && fs.existsSync(backup), "successful swap keeps a rollback copy");
  assert(fs.readFileSync(exe).includes(Buffer.from("NEW")), "new executable is in place");
  assert(JSON.parse(fs.readFileSync(stateFile)).status === "launched", "launch state persisted");

  const badFresh = path.join(dir, "bad.exe");
  fs.writeFileSync(badFresh, "not an exe");
  const failed = await applyUpdate({ exe, fresh: badFresh, backup: backup + "2", stateFile,
    target: "0.10.1", parentPid: 999, minimumBytes: 100 }, { noRelaunch: true, processAlive: () => false });
  assert(!failed.ok, "bad replacement is refused");
  assert(fs.readFileSync(exe).includes(Buffer.from("NEW")), "failed attempt leaves working executable untouched");
  assert(JSON.parse(fs.readFileSync(stateFile)).status === "failed", "failure is durable and blocks auto-retry");

  fs.rmSync(dir, { recursive: true, force: true });
  console.log("✔ UPDATE HELPER PASS — no shell, bounded swap, rollback preserved");
})().catch(error => { console.error("✘ FAIL:", error); process.exit(1); });
