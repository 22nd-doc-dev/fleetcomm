"use strict";
/* The persistent home: when a portable launch installs/refreshes its stable
   copy, and what the Start Menu shortcut must carry for pinning to work. */
const assert = require("assert");
const path = require("path");
const { plan, APP_ID } = require("../src/home-install");

const ok = (m) => console.log("  ✓ " + m);
const base = {
  platform: "win32",
  portableExe: "C:\\Users\\nailo\\Downloads\\FleetComm-1.3.1.exe",
  localAppData: "C:\\Users\\nailo\\AppData\\Local",
  startMenu: "C:\\Users\\nailo\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs",
  runningVersion: "1.3.2", homeVersion: null, homeExists: false
};

assert.strictEqual(plan(Object.assign({}, base, { platform: "darwin" })).active, false, "mac has the Dock");
assert.strictEqual(plan(Object.assign({}, base, { portableExe: undefined })).active, false, "dev / non-portable launch");
assert.strictEqual(plan(Object.assign({}, base, { startMenu: "" })).active, false, "no profile folders");
ok("only a Windows portable launch with a profile gets a home");

const first = plan(base);
assert.strictEqual(first.active, true);
assert.strictEqual(first.copy, true, "first launch installs the home copy");
assert.strictEqual(first.homeExe, path.join(base.localAppData, "Programs", "FleetComm", "FleetComm.exe"));
assert.strictEqual(first.shortcut.path, path.join(base.startMenu, "FleetComm.lnk"));
assert.strictEqual(first.shortcut.target, first.homeExe, "the shortcut points at the HOME copy, never the download");
assert.strictEqual(first.shortcut.appUserModelId, APP_ID, "the shortcut carries the process's AppUserModelID — that is what makes a pin resolve");
assert.strictEqual(first.shortcut.icon, first.homeExe);
ok("first launch: copy in, Start Menu shortcut at the home copy with the app id");

assert.strictEqual(plan(Object.assign({}, base, { homeExists: true, homeVersion: "1.3.1" })).copy, true, "older home copy is refreshed");
assert.strictEqual(plan(Object.assign({}, base, { homeExists: true, homeVersion: "1.3.2" })).copy, false, "same version: nothing to copy");
assert.strictEqual(plan(Object.assign({}, base, { homeExists: true, homeVersion: "1.4.0" })).copy, false, "a NEWER home copy is never downgraded by an old download");
assert.strictEqual(plan(Object.assign({}, base, { homeExists: true, homeVersion: null })).copy, true, "home copy without a stamp is re-laid");
ok("the home copy tracks the newest version ever run, never older");

const fromHome = plan(Object.assign({}, base, { portableExe: "c:\\users\\NAILO\\appdata\\local\\programs\\fleetcomm\\FLEETCOMM.EXE", homeExists: true, homeVersion: "1.3.2" }));
assert.strictEqual(fromHome.launchedFromHome, true, "case-insensitive path match");
assert.strictEqual(fromHome.copy, false, "launched from home: nothing to copy — the update swap keeps this file current in place");
assert.ok(fromHome.shortcut, "the shortcut is still refreshed from home");
ok("launching the home copy (a pinned FleetComm) copies nothing and keeps the shortcut fresh");

console.log("\n✔ HOME INSTALL PASS — a portable FleetComm gets a fixed address and a pinnable shortcut");
