"use strict";
/*
 * Detached Windows update helper.
 *
 * This runs under Electron's Node mode, not cmd.exe. The old batch helper used
 * ping loops as a sleep primitive; when a swap failed, operators saw command
 * windows repeatedly opening and the old build could be relaunched into the
 * same automatic attempt. This helper has one bounded attempt, one relaunch,
 * an on-disk result, and no shell at all.
 */
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function validVersion(version) {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(String(version || ""));
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error && error.code === "EPERM"; }
}

async function waitForExit(pid, timeoutMs, alive) {
  const check = alive || processAlive;
  const deadline = Date.now() + Math.max(0, timeoutMs || 0);
  while (check(pid)) {
    if (Date.now() >= deadline) return false;
    await sleep(250);
  }
  return true;
}

function isPortableExecutable(file, minimumBytes) {
  let fd;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size < (minimumBytes || 1024 * 1024)) return false;
    const head = Buffer.alloc(64);
    fd = fs.openSync(file, "r");
    if (fs.readSync(fd, head, 0, head.length, 0) !== head.length) return false;
    if (head.toString("latin1", 0, 2) !== "MZ") return false;
    const peOffset = head.readUInt32LE(0x3c);
    if (peOffset < 64 || peOffset > stat.size - 4) return false;
    const pe = Buffer.alloc(4);
    if (fs.readSync(fd, pe, 0, 4, peOffset) !== 4) return false;
    return pe.equals(Buffer.from([0x50, 0x45, 0x00, 0x00]));
  } catch (error) { return false; }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch (error) {} }
}

function writeJsonAtomic(file, value) {
  const tmp = file + ".tmp-" + process.pid;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function appendLog(file, message) {
  if (!file) return;
  try { fs.appendFileSync(file, new Date().toISOString() + " " + message + "\n", { mode: 0o600 }); }
  catch (error) {}
}

function cleanRelaunchEnv() {
  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

function relaunch(exe, args, spawnFn) {
  const child = (spawnFn || spawn)(exe, args || [], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: cleanRelaunchEnv()
  });
  child.unref();
}

async function retryRename(from, to, attempts) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try { fs.renameSync(from, to); return; }
    catch (error) {
      last = error;
      if (!error || !["EACCES", "EPERM", "EBUSY"].includes(error.code)) throw error;
      await sleep(250);
    }
  }
  throw last || new Error("rename failed");
}

function validatePayload(payload) {
  if (!payload || !validVersion(payload.target)) throw new Error("invalid update target");
  for (const key of ["exe", "fresh", "backup", "stateFile"]) {
    if (!path.isAbsolute(String(payload[key] || ""))) throw new Error("invalid update path: " + key);
  }
  const unique = new Set([payload.exe, payload.fresh, payload.backup]);
  if (unique.size !== 3) throw new Error("update paths must be distinct");
  if (!Number.isInteger(payload.parentPid) || payload.parentPid <= 0) throw new Error("invalid parent pid");
  return payload;
}

async function applyUpdate(rawPayload, deps) {
  const payload = validatePayload(rawPayload);
  const log = message => appendLog(payload.logFile, message);
  const writeState = state => writeJsonAtomic(payload.stateFile, Object.assign({ target: payload.target }, state));
  const doRelaunch = !(deps && deps.noRelaunch);
  const spawnFn = deps && deps.spawn;
  let movedOld = false;
  try {
    if (!isPortableExecutable(payload.fresh, payload.minimumBytes))
      throw new Error("downloaded file is not a complete Windows executable");
    if (!(await waitForExit(payload.parentPid, payload.parentTimeoutMs || 30000, deps && deps.processAlive)))
      throw new Error("FleetComm did not exit before the update deadline");

    if (fs.existsSync(payload.backup) && fs.existsSync(payload.exe)) fs.unlinkSync(payload.backup);
    await retryRename(payload.exe, payload.backup, payload.renameAttempts || 40);
    movedOld = true;
    await retryRename(payload.fresh, payload.exe, payload.renameAttempts || 40);
    if (!isPortableExecutable(payload.exe, payload.minimumBytes))
      throw new Error("replacement executable failed verification");

    writeState({ status: "launched", launchedAt: Date.now(), backup: payload.backup });
    log("replacement installed; launching v" + payload.target);
    if (doRelaunch) relaunch(payload.exe, ["--update-applied=" + payload.target], spawnFn);
    return { ok: true };
  } catch (error) {
    const reason = String(error && error.message || error || "unknown update error").slice(0, 300);
    log("update failed: " + reason);
    try {
      if (movedOld && fs.existsSync(payload.backup)) {
        if (fs.existsSync(payload.exe)) fs.unlinkSync(payload.exe);
        fs.renameSync(payload.backup, payload.exe);
      }
    } catch (restoreError) { log("restore failed: " + restoreError.message); }
    try { if (payload.fresh !== payload.exe) fs.unlinkSync(payload.fresh); } catch (cleanupError) {}
    writeState({ status: "failed", failedAt: Date.now(), reason });
    if (doRelaunch && fs.existsSync(payload.exe)) {
      try { relaunch(payload.exe, ["--update-failed"], spawnFn); }
      catch (spawnError) { log("old-version relaunch failed: " + spawnError.message); }
    }
    return { ok: false, error: reason };
  }
}

async function runCli(payloadFile) {
  let payload;
  try { payload = JSON.parse(fs.readFileSync(payloadFile, "utf8")); }
  finally { try { fs.unlinkSync(payloadFile); } catch (error) {} }
  try {
    const result = await applyUpdate(payload);
    process.exitCode = result.ok ? 0 : 1;
  } finally {
    if (/^fleetcomm-update-helper-\d+-\d+\.js$/.test(path.basename(__filename))) {
      try { fs.unlinkSync(__filename); } catch (error) {}
    }
  }
}

if (require.main === module) {
  runCli(process.argv[2]).catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { applyUpdate, isPortableExecutable, processAlive, validVersion, waitForExit, writeJsonAtomic };
