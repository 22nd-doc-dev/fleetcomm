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

  /* ── an exe parked in a write-protected folder is caught BEFORE download ──
     The update is a rename in place; C:\Program Files refuses that to anything
     unelevated. One operator's updater failed silently there across four
     releases — the probe is what turns that into a sentence instead. */
  const { dirWritable } = require("../src/update-helper");
  assert.strictEqual(dirWritable(dir), true, "a normal folder probes writable");
  const lockedDir = path.join(dir, "locked");
  fs.mkdirSync(lockedDir);
  let lockedResult = null;
  if (process.platform === "win32") {
    /* chmod cannot revoke directory write access on Windows — Program Files
       blocks writes with a deny ACL, so the test uses the same mechanism. */
    const { execFileSync } = require("child_process");
    const who = process.env.USERNAME || "";
    let denied = false;
    try {
      execFileSync("icacls", [lockedDir, "/deny", who + ":(WD,AD)"], { stdio: "ignore" });
      denied = true;
      lockedResult = dirWritable(lockedDir);
    } finally {
      if (denied) execFileSync("icacls", [lockedDir, "/remove:d", who], { stdio: "ignore" });
    }
    assert.strictEqual(lockedResult, false, "a folder this process cannot write into probes unwritable");
  } else {
    fs.chmodSync(lockedDir, 0o500);
    lockedResult = dirWritable(lockedDir);
    fs.chmodSync(lockedDir, 0o700);   /* so cleanup can remove it */
    if (process.getuid && process.getuid() === 0) {
      console.log("  · running as root — the read-only-dir probe cannot be exercised");
    } else {
      assert.strictEqual(lockedResult, false, "a folder this process cannot write into probes unwritable");
    }
  }
  assert.strictEqual(fs.readdirSync(lockedDir).length, 0, "the probe leaves nothing behind");
  const mainSrc2 = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  assert(/dirWritable\(path\.dirname\(origExe\)\)/.test(mainSrc2),
    "do-update must probe the exe's folder before downloading");

  fs.rmSync(dir, { recursive: true, force: true });
  console.log("✔ UPDATE HELPER PASS — no shell, bounded swap, rollback preserved");
})().catch(error => { console.error("✘ FAIL:", error); process.exit(1); });
