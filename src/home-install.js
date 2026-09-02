"use strict";
/*
 * The persistent home for a portable build — so FleetComm can be pinned.
 *
 * electron-builder's portable exe unpacks itself into a fresh temp folder on
 * every launch and runs from there; the folder is deleted on exit. So a
 * taskbar pin taken from the running window points at a file that no longer
 * exists, and Windows has no stable identity to group the button under.
 * "Why can't I pin it?" — Nailo, 2026-09-02.
 *
 * The cure is two-part and this module decides the first: keep ONE copy of
 * the launcher at a fixed path (%LOCALAPPDATA%\Programs\FleetComm\
 * FleetComm.exe) that always holds the newest version the operator has run,
 * and point a Start Menu shortcut at it. main.js sets the AppUserModelID on
 * the process and stamps the same id on the shortcut; with both in place,
 * pinning from the running window resolves to the shortcut, and the pin
 * survives updates because the swap replaces the file in place.
 *
 * Pure: takes what it needs, returns a plan. The filesystem work lives in
 * main.js and is fed by this.
 */
/* Windows semantics on every platform: the feature only exists on Windows, but
   the suite runs on Linux CI, where a POSIX join of a C:\ path produces mixed
   separators and the launched-from-home comparison silently fails */
const path = require("path").win32;
const { cmpVer } = require("./update-guard");

const APP_ID = "space.fleetcomm.app";       /* = build.appId in package.json */
const HOME_DIR_NAME = "FleetComm";
const EXE_NAME = "FleetComm.exe";
const SHORTCUT_NAME = "FleetComm.lnk";
const STAMP_NAME = "version.txt";

function samePath(a, b) {
  return path.resolve(String(a || "")).toLowerCase() === path.resolve(String(b || "")).toLowerCase();
}

/*
 * opts:
 *   platform        process.platform
 *   portableExe     process.env.PORTABLE_EXECUTABLE_FILE (undefined in dev / non-portable)
 *   localAppData    %LOCALAPPDATA%
 *   startMenu       the user's Start Menu Programs folder
 *   runningVersion  app.getVersion()
 *   homeVersion     contents of the home stamp file, or null when absent
 *   homeExists      whether the home exe is on disk
 *
 * returns { active:false } when nothing applies, else
 *   { active:true, homeDir, homeExe, stamp, shortcut, copy, launchedFromHome, appId }
 */
function plan(opts) {
  const o = opts || {};
  if (o.platform !== "win32") return { active: false, why: "not windows" };
  if (!o.portableExe) return { active: false, why: "not a portable launch" };
  if (!o.localAppData || !o.startMenu) return { active: false, why: "no profile folders" };
  const homeDir = path.join(o.localAppData, "Programs", HOME_DIR_NAME);
  const homeExe = path.join(homeDir, EXE_NAME);
  const launchedFromHome = samePath(o.portableExe, homeExe);
  /* copy when the home copy is missing or older than what is running; never
     downgrade a newer home copy because someone opened an old download */
  let copy = false;
  if (!launchedFromHome) {
    if (!o.homeExists) copy = true;
    else if (!o.homeVersion) copy = true;
    else copy = cmpVer(String(o.runningVersion || "0.0.0"), String(o.homeVersion)) > 0;
  }
  return {
    active: true, appId: APP_ID, homeDir, homeExe, launchedFromHome, copy,
    stamp: path.join(homeDir, STAMP_NAME),
    shortcut: {
      path: path.join(o.startMenu, SHORTCUT_NAME),
      target: homeExe, cwd: homeDir, description: "FleetComm — 22nd Expeditionary Fleet radio",
      icon: homeExe, iconIndex: 0, appUserModelId: APP_ID
    }
  };
}

module.exports = { plan, APP_ID, EXE_NAME, SHORTCUT_NAME, STAMP_NAME };
