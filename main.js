"use strict";
/* FleetComm — Electron main: window, global PTT hooks, radio stack owner. */
const { app, BrowserWindow, ipcMain, shell, screen } = require("electron");
const path = require("path");
const fs = require("fs");
const https = require("https");
const { RadioStack } = require("./src/radio-stack");
const { loadOrCreate } = require("./src/identity");

/* Only one FleetComm at a time — a second launch just focuses the first. */
if (!app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", () => {
  if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
});

let win = null, stack = null, uio = null, identity = null, keyLabel = (c) => "KEY " + c;
/* every message to a window goes through these guards — windows can be gone */
function sendWin(ch, data) { if (win && !win.isDestroyed()) win.webContents.send(ch, data); }
function sendOverlay(ch, data) { if (overlay && !overlay.isDestroyed()) overlay.webContents.send(ch, data); }
let overlay = null, ovEditing = false, ovCfg = null, lastOvState = [];
const ovCfgPath = () => path.join(app.getPath("userData"), "overlay.json");
function loadOvCfg() {
  if (ovCfg) return ovCfg;
  try { ovCfg = JSON.parse(fs.readFileSync(ovCfgPath(), "utf8")); }
  catch (e) { ovCfg = { opacity: 72, scale: 100, bounds: null }; }
  return ovCfg;
}
function saveOvCfg() { try { fs.writeFileSync(ovCfgPath(), JSON.stringify(ovCfg)); } catch (e) {} }

function createOverlay() {
  const c = loadOvCfg();
  const disp = screen.getPrimaryDisplay().workArea;
  const b = c.bounds || { x: disp.x + disp.width - 340, y: disp.y + 60, width: 320, height: 260 };
  overlay = new BrowserWindow({
    ...b, frame: false, transparent: true, resizable: true, skipTaskbar: true,
    alwaysOnTop: true, hasShadow: false, minimizable: false, maximizable: false,
    focusable: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });
  overlay.setAlwaysOnTop(true, "screen-saver");
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlay.setIgnoreMouseEvents(true, { forward: true });
  overlay.loadFile(path.join(__dirname, "renderer", "overlay.html"));
  overlay.webContents.on("did-finish-load", () => {
    sendOverlay("ov-config", { opacity: c.opacity, scale: c.scale });
    if (curTheme) sendOverlay("ov-theme", curTheme);
    sendOverlay("ov-state", lastOvState);
  });
  const persistBounds = () => { if (overlay) { ovCfg.bounds = overlay.getBounds(); saveOvCfg(); } };
  overlay.on("moved", persistBounds);
  overlay.on("resized", persistBounds);
  overlay.on("closed", () => { overlay = null; });
}
function setOvEdit(on) {
  if (!overlay) return;
  ovEditing = on;
  if (overlay.isDestroyed()) { overlay = null; return; }
  overlay.setIgnoreMouseEvents(!on, { forward: true });
  overlay.setFocusable(on);
  sendOverlay("ov-edit", on);
  sendWin("ov-edit-state", on);
}
ipcMain.on("ov-toggle", () => {
  if (overlay) { setOvEdit(false); try { overlay.destroy(); } catch (e) {} overlay = null; }
  else createOverlay();
  sendWin("ov-shown", !!overlay);
});
ipcMain.on("ov-edit", (ev, on) => setOvEdit(on));
ipcMain.on("ov-lock", () => setOvEdit(false));
ipcMain.on("ov-set", (ev, c) => { ovCfg.opacity = c.opacity; ovCfg.scale = c.scale; saveOvCfg(); });
ipcMain.on("ov-state", (ev, nets) => {
  lastOvState = nets;
  sendOverlay("ov-state", nets);
});

/* ── update check ── */
function cmpVer(a, b) {
  const pa = String(a).replace(/^v/, "").split(".").map(Number);
  const pb = String(b).replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) > (pb[i] || 0)) return 1; if ((pa[i] || 0) < (pb[i] || 0)) return -1; }
  return 0;
}
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 8000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
        return fetchJson(res.headers.location).then(resolve, reject);
      let d = "";
      res.on("data", (c) => d += c);
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
  });
}
async function checkUpdates() {
  const pkgCfg = require("./config/22nd-package.json");
  const u = pkgCfg.updates;
  if (!u || !/^https:/.test(u.url || "")) return { status: "unconfigured" };
  try {
    const info = await fetchJson(u.url);
    if (info.version && cmpVer(info.version, app.getVersion()) > 0)
      return { status: "update", version: info.version, notes: info.notes || "", url: u.releases || u.url };
    return { status: "current", version: app.getVersion() };
  } catch (e) { return { status: "error", error: e.message }; }
}
ipcMain.handle("check-updates", () => checkUpdates());
ipcMain.on("open-external", (ev, url) => { if (/^https?:/.test(url)) shell.openExternal(url); });
let curTheme = null;
ipcMain.on("theme", (ev, t) => {
  curTheme = t;
  sendOverlay("ov-theme", t);
  if (process.platform !== "darwin" && win && !win.isDestroyed()) {
    try { win.setTitleBarOverlay({ color: t.bg, symbolColor: t.ink }); } catch (e) {}
  }
});

function createWindow() {
  const frameOpts = process.platform === "darwin"
    ? { titleBarStyle: "hidden", trafficLightPosition: { x: 12, y: 12 } }
    : { titleBarStyle: "hidden", titleBarOverlay: { color: "#0b141f", symbolColor: "#93a7ba", height: 38 } };
  win = new BrowserWindow({
    width: 1180, height: 800, minWidth: 760, minHeight: 500,
    backgroundColor: "#0b141f",
    title: "FleetComm",
    ...frameOpts,
    webPreferences: { nodeIntegration: true, contextIsolation: false } // prototype; harden before wide release
  });
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  win.removeMenu && win.removeMenu();
  win.on("closed", () => {
    win = null;
    if (overlay) { try { setOvEdit(false); overlay.destroy(); } catch (e) {} overlay = null; }
    if (stack) { try { stack.destroy(); } catch (e) {} stack = null;
    }
    app.quit();
    /* dead-man's switch: if anything (a wedged native hook, a stuck teardown)
       keeps the process alive past this point, force-exit. Nothing of FleetComm
       may outlive its window. */
    const t = setTimeout(() => { try { app.exit(0); } catch (e) { process.exit(0); } }, 2000);
    if (t.unref) t.unref();
  });
}

app.whenReady().then(async () => {
  try { identity = await loadOrCreate(app.getPath("userData")); }
  catch (e) { console.warn("[fleetcomm] identity cert unavailable:", e.message); }
  createWindow();
  /* Global PTT — works while Star Citizen has focus.
     macOS: needs System Settings → Privacy & Security → Accessibility for the app/terminal. */
  try {
    const { uIOhook, UiohookKey } = require("uiohook-napi");
    const rev = {};
    for (const [name, code] of Object.entries(UiohookKey)) if (!(code in rev)) rev[code] = name;
    keyLabel = (c) => rev[c] || "KEY " + c;
    uio = uIOhook;
    uio.on("keydown", (e) => sendWin("gkey", { type: "key", code: e.keycode, label: keyLabel(e.keycode), down: true }));
    uio.on("keyup", (e) => sendWin("gkey", { type: "key", code: e.keycode, label: keyLabel(e.keycode), down: false }));
    uio.on("mousedown", (e) => { if (e.button > 2) sendWin("gkey", { type: "mouse", code: e.button, label: "MOUSE " + e.button, down: true }); });
    uio.on("mouseup", (e) => { if (e.button > 2) sendWin("gkey", { type: "mouse", code: e.button, label: "MOUSE " + e.button, down: false }); });
    uio.start();
    console.log("[fleetcomm] global PTT hooks active");
  } catch (e) {
    console.warn("[fleetcomm] global PTT unavailable (" + e.message + ") — in-window keys still work");
  }
});

ipcMain.handle("connect", async (ev, { host, port, callsign, nets, token }) => {
  if (stack) stack.destroy();
  stack = new RadioStack({ host, port: port || 64738, callsign,
    tokens: token ? [token] : [],
    cert: identity && identity.cert, key: identity && identity.key });
  stack.on("rx", (r) => sendWin("rx", { idx: r.idx, session: r.session, name: r.name, opus: r.opus, last: r.last }));
  stack.on("roster", (r) => sendWin("roster", r));
  stack.on("net-down", (r) => sendWin("net-down", r));
  stack.on("net-error", (r) => sendWin("net-error", r));
  const results = [];
  for (const n of nets) {
    try { results.push({ ok: true, idx: await stack.tune(n) }); }
    catch (e) { results.push({ ok: false, error: e.message, net: n.name }); }
  }
  return results;
});
ipcMain.handle("tune", async (ev, net) => {
  if (!stack) return { ok: false, error: "not connected" };
  try { return { ok: true, idx: await stack.tune(net) }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.on("detune", (ev, idx) => stack && stack.detune(idx));
ipcMain.on("tx-frame", (ev, { idx, frame, last }) => stack && stack.txFrame(idx, Buffer.from(frame), last));
ipcMain.on("net-mute", (ev, { idx, muted }) => stack && stack.setMuted(idx, muted));
ipcMain.handle("create-net", async (ev, { name, rootChannel }) => {
  if (!stack) return { ok: false, error: "not connected" };
  try { return { ok: true, id: await stack.createNet(name, rootChannel) }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.on("disconnect", () => { if (stack) { stack.destroy(); stack = null; } });

app.whenReady().then(() => {
  setTimeout(async () => {
    const r = await checkUpdates();
    if (r.status === "update") sendWin("update-available", r);
  }, 3500);
});

app.on("will-quit", () => { if (uio) { try { uio.stop(); } catch (e) {} uio = null; } });

app.on("window-all-closed", () => {
  if (overlay) { try { overlay.close(); } catch (e) {} }
  if (stack) stack.destroy();
  if (uio) { try { uio.stop(); } catch (e) {} }
  app.quit();
});
