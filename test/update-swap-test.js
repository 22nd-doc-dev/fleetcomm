"use strict";
/* The update swap, RUN — not reasoned about.
 *
 * Two earlier attempts at this bug were fixed by inspection because there was
 * no Windows here, and both times the app still opened the old version. The
 * actual cause was that the swap ran from the Electron binary inside the
 * portable build's temp unpack directory, which the portable launcher deletes
 * the moment the app exits — so our own shutdown killed the helper mid-swap.
 * The swap now runs under powershell.exe, which lives in System32 and survives.
 *
 * This executes the real script under PowerShell against stand-in executables:
 * the swap, the verification, the rollback, and the state file the loop guard
 * reads. Skips (does not fail) where PowerShell isn't installed.
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const PWSH = ["/opt/pwsh/pwsh", "/usr/bin/pwsh", "/usr/local/bin/pwsh", "pwsh"]
  .find(p => { try { execFileSync(p, ["-NoProfile", "-Command", "1"], { stdio: "ignore" }); return true; } catch (e) { return false; } });
if (!PWSH) {
  console.log("  · PowerShell not installed here — skipping the executed swap checks");
  console.log("\n✔ UPDATE SWAP SKIPPED (no PowerShell)");
  process.exit(0);
}
let k = 0; const ok = (m) => console.log("  ✓ " + m, ++k);

const SCRIPT = path.join(__dirname, "..", "src", "update-swap.ps1");
function fakeExe(file, byte) {
  const buf = Buffer.alloc(41 * 1024 * 1024, byte || 0);
  buf[0] = 0x4d; buf[1] = 0x5a;                      /* MZ */
  fs.writeFileSync(file, buf);
  try { fs.chmodSync(file, 0o755); } catch (e) {}   /* so the relaunch step can run here too */
}
function run(dir, opts) {
  const args = ["-NoProfile", "-NonInteractive", "-File", SCRIPT,
    "-Exe", path.join(dir, "FleetComm.exe"),
    "-Fresh", opts.fresh !== undefined ? opts.fresh : path.join(dir, "new.exe"),
    "-Backup", path.join(dir, "FleetComm.exe.old"),
    "-ParentPid", String(opts.pid || process.pid + 900000),
    "-StateFile", path.join(dir, "state.json"),
    "-Target", opts.target || "9.9.9",
    "-LogFile", path.join(dir, "swap.log")];
  let code = 0;
  try { execFileSync(PWSH, args, { stdio: "pipe", timeout: 90000 }); }
  catch (e) { code = e.status == null ? -1 : e.status; }
  const state = (() => { try { return JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8")); } catch (e) { return null; } })();
  const log = (() => { try { return fs.readFileSync(path.join(dir, "swap.log"), "utf8"); } catch (e) { return ""; } })();
  return { code, state, log };
}
const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), "fcswap-"));

/* ── a failed relaunch must NOT undo a good install ── */
{
  const d = mk();
  fakeExe(path.join(d, "FleetComm.exe"), 0x11);
  fakeExe(path.join(d, "new.exe"), 0x22);
  try { fs.chmodSync(path.join(d, "new.exe"), 0o644); } catch (e) {}   /* installs fine, won't start */
  const r = run(d, {});
  assert.strictEqual(fs.readFileSync(path.join(d, "FleetComm.exe"))[4096], 0x22,
    "the new binary must stay installed even though it could not be started");
  assert(r.state && r.state.status === "launched", "and the install is recorded as done: " + JSON.stringify(r.state));
  assert(/relaunch failed/.test(r.log), "the log says the relaunch is what failed:\n" + r.log);
  ok("a blocked relaunch does not throw away a successful install");
}

/* ── the swap actually happens ── */
{
  const d = mk();
  fakeExe(path.join(d, "FleetComm.exe"), 0x11);
  fakeExe(path.join(d, "new.exe"), 0x22);
  const r = run(d, {});
  assert.strictEqual(r.code, 0, "swap should succeed\n" + r.log);
  const now = fs.readFileSync(path.join(d, "FleetComm.exe"));
  assert.strictEqual(now[4096], 0x22, "the NEW binary is in place, not the old one");
  assert(!fs.existsSync(path.join(d, "new.exe")), "the download was consumed");
  assert(r.state && r.state.status === "launched", "state records the install: " + JSON.stringify(r.state));
  assert.strictEqual(r.state.target, "9.9.9", "and records which version");
  /* Windows PowerShell 5.1 — the System32 one production actually uses — used
     to write this file with a BOM via Set-Content -Encoding UTF8; Node's
     JSON.parse rejects BOM'd JSON and the loop guard read {}. The script must
     emit BOM-less bytes on EVERY PowerShell (here we can only execute 7.x, so
     also assert the byte, not just the successful parse). */
  const rawState = fs.readFileSync(path.join(d, "state.json"));
  assert.notStrictEqual(rawState[0], 0xEF, "state.json must not start with a BOM");
  assert.strictEqual(rawState[0], 0x7B, "state.json starts with '{' so Node's JSON.parse accepts it");
  ok("the running executable is genuinely replaced by the downloaded one");
}

/* ── a corrupt or truncated download is refused, and the old build survives ── */
{
  const d = mk();
  fakeExe(path.join(d, "FleetComm.exe"), 0x11);
  fs.writeFileSync(path.join(d, "new.exe"), Buffer.alloc(1024, 7));   /* far too small, no MZ */
  const r = run(d, {});
  assert.notStrictEqual(r.code, 0, "a bad download must fail the swap");
  const now = fs.readFileSync(path.join(d, "FleetComm.exe"));
  assert.strictEqual(now[4096], 0x11, "the ORIGINAL executable is untouched");
  assert(r.state && r.state.status === "failed", "state records the failure");
  assert(/not a complete Windows executable/i.test(r.state.reason || ""), "with a usable reason: " + r.state.reason);
  ok("a corrupt download is refused and the working build is left alone");
}

/* ── a missing download fails safe rather than deleting the app ── */
{
  const d = mk();
  fakeExe(path.join(d, "FleetComm.exe"), 0x11);
  const r = run(d, { fresh: path.join(d, "does-not-exist.exe") });
  assert.notStrictEqual(r.code, 0);
  assert(fs.existsSync(path.join(d, "FleetComm.exe")), "the app must still exist");
  assert.strictEqual(fs.readFileSync(path.join(d, "FleetComm.exe"))[4096], 0x11, "and still be the old build");
  ok("a missing download never leaves the operator without an app");
}

/* ── the state file is exactly what the loop guard expects ── */
{
  const d = mk();
  fakeExe(path.join(d, "FleetComm.exe"), 0x11);
  fakeExe(path.join(d, "new.exe"), 0x22);
  const r = run(d, { target: "0.12.0" });
  const { reconcile, blocked } = require("../src/update-guard");
  const after = reconcile("0.12.0", r.state, false);
  assert(after.note && after.note.installed === "0.12.0", "a successful swap reconciles as installed");
  assert(!blocked(after.state, "0.12.1"), "and does not block the next version");
  ok("the state it writes is what the loop guard reads");
}

/* ── it logs, so a failure in the field can be diagnosed ── */
{
  const d = mk();
  fakeExe(path.join(d, "FleetComm.exe"), 0x11);
  fakeExe(path.join(d, "new.exe"), 0x22);
  const r = run(d, {});
  assert(/swap starting/.test(r.log) && /installed v/.test(r.log), "the log records what happened:\n" + r.log);
  ok("every run leaves a log an operator can send you");
}

/* ── and main.js hands off to System32 PowerShell, not our own binary ── */
{
  const main = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  assert(/WindowsPowerShell/.test(main) && /powershell\.exe/.test(main), "hands off to powershell.exe");
  assert(!/spawn\(process\.execPath, \[helper/.test(main),
    "must NOT spawn the updater from process.execPath — that path is deleted when a portable build exits");
  ok("the app launches the swap from System32, not the doomed unpack directory");
}

console.log("\n✔ UPDATE SWAP PASS — the executable is really replaced, and a bad one never is");
process.exit(0);
