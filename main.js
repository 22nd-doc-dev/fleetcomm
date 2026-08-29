"use strict";
/* FleetComm — Electron main: window, global PTT hooks, radio stack owner. */
const { app, BrowserWindow, ipcMain, shell, screen } = require("electron");
const path = require("path");
const fs = require("fs");
const http = require("http");
const https = require("https");
const crypto = require("crypto");
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

/* ── self-update (Windows portable) ──
   Downloads the new exe straight from the release, then hands off to a tiny
   script that waits for us to exit, swaps the file on disk, and relaunches.
   No installer involved, and app-downloaded files carry no mark-of-the-web,
   so there's no SmartScreen prompt on the way back up. */
function downloadFile(url, dest, onPct, depth) {
  return new Promise((resolve, reject) => {
    if ((depth || 0) > 5) return reject(new Error("too many redirects"));
    const req = https.get(url, { timeout: 30000, headers: { "User-Agent": "FleetComm" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return downloadFile(res.headers.location, dest, onPct, (depth || 0) + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error("HTTP " + res.statusCode)); }
      const total = parseInt(res.headers["content-length"] || "0", 10);
      let got = 0;
      const out = fs.createWriteStream(dest);
      res.on("data", (ch) => { got += ch.length; if (total && onPct) onPct(Math.round(got / total * 100)); });
      res.pipe(out);
      out.on("finish", () => out.close(() => resolve(got)));
      out.on("error", reject);
      res.on("error", reject);
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("download timeout")); });
  });
}
/* ── Discord sign-in (PKCE, loopback — no client secret anywhere) ── */
const OAUTH_PORT = 53682;
let acctToken = null;
function b64url(buf) { return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
function postForm(url, form) {
  return new Promise((resolve, reject) => {
    const data = new URLSearchParams(form).toString();
    const u = new URL(url);
    const req = https.request({ hostname: u.hostname, path: u.pathname, method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(data) }, timeout: 15000 },
      (res) => { let d = ""; res.on("data", c => d += c); res.on("end", () => {
        try { const j = JSON.parse(d); res.statusCode === 200 ? resolve(j) : reject(new Error(j.error_description || j.error || ("HTTP " + res.statusCode))); }
        catch (e) { reject(e); } }); });
    req.on("error", reject); req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.write(data); req.end();
  });
}
function jsonCall(base, method, pathName, bodyObj, bearer) {
  return new Promise((resolve, reject) => {
    const u = new URL(base + pathName);
    const lib = u.protocol === "https:" ? https : http;
    const data = bodyObj ? JSON.stringify(bodyObj) : null;
    const req = lib.request({ hostname: u.hostname, port: u.port, path: u.pathname, method,
      headers: Object.assign({ "Content-Type": "application/json" },
        data ? { "Content-Length": Buffer.byteLength(data) } : {},
        bearer ? { Authorization: "Bearer " + bearer } : {}), timeout: 12000 },
      (res) => { let d = ""; res.on("data", c => d += c); res.on("end", () => {
        try { resolve(JSON.parse(d)); } catch (e) { reject(new Error("bad response")); } }); });
    req.on("error", reject); req.on("timeout", () => { req.destroy(); reject(new Error("service timeout")); });
    if (data) req.write(data); req.end();
  });
}
ipcMain.handle("discord-login", async () => {
  const cfg = require("./config/22nd-package.json").accounts;
  if (!cfg || !cfg.url || !cfg.discordClientId) return { ok: false, unconfigured: true };
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));
  const redirect = "http://127.0.0.1:" + OAUTH_PORT + "/callback";
  const authUrl = "https://discord.com/oauth2/authorize?response_type=code&client_id=" + cfg.discordClientId +
    "&scope=identify&redirect_uri=" + encodeURIComponent(redirect) + "&state=" + state +
    "&code_challenge=" + challenge + "&code_challenge_method=S256";
  let code;
  try {
    code = await new Promise((resolve, reject) => {
      const srv = http.createServer((req2, res2) => {
        const u = new URL(req2.url, "http://x");
        if (u.pathname !== "/callback") { res2.writeHead(404); return res2.end(); }
        res2.writeHead(200, { "Content-Type": "text/html" });
        res2.end("<body style='font-family:sans-serif;background:#0b0f13;color:#e8edf1;display:grid;place-items:center;height:100vh'><div><h2>FleetComm</h2>Signed in — you can close this tab and return to the app.</div></body>");
        srv.close();
        if (u.searchParams.get("state") !== state) return reject(new Error("state mismatch"));
        if (u.searchParams.get("error")) return reject(new Error(u.searchParams.get("error")));
        resolve(u.searchParams.get("code"));
      });
      srv.on("error", (e) => reject(new Error(e.code === "EADDRINUSE" ? "port 53682 busy — close other FleetComm sign-ins" : e.message)));
      srv.listen(OAUTH_PORT, "127.0.0.1", () => shell.openExternal(authUrl));
      setTimeout(() => { try { srv.close(); } catch (e) {} reject(new Error("sign-in timed out")); }, 180000);
    });
  } catch (e) { return { ok: false, error: e.message }; }
  try {
    const tok = await postForm("https://discord.com/api/oauth2/token", {
      client_id: cfg.discordClientId, grant_type: "authorization_code",
      code, redirect_uri: redirect, code_verifier: verifier
    });
    const login = await jsonCall(cfg.url, "POST", "/api/login", { discordToken: tok.access_token });
    if (login.ok) acctToken = login.token;
    return login;
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle("acct", async (ev, { method, path: p, body: b }) => {
  const cfg = require("./config/22nd-package.json").accounts;
  if (!cfg || !cfg.url) return { ok: false, error: "accounts service not configured" };
  if (!acctToken) return { ok: false, error: "not signed in" };
  try { return await jsonCall(cfg.url, method || "GET", p, b || null, acctToken); }
  catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle("do-update", async (ev, info) => {
  const pkgCfg = require("./config/22nd-package.json");
  const origExe = process.env.PORTABLE_EXECUTABLE_FILE;
  const tpl = pkgCfg.updates && pkgCfg.updates.exeTemplate;
  if (process.platform !== "win32" || !origExe || !tpl) return { ok: false, fallback: true };
  try {
    const url = tpl.split("{v}").join(info.version);
    const fresh = path.join(app.getPath("temp"), "FleetComm-" + info.version + ".exe");
    const bytes = await downloadFile(url, fresh, (pct) => sendWin("update-progress", pct));
    if (bytes < 50 * 1024 * 1024) throw new Error("download looks incomplete (" + bytes + " bytes)");
    const script = path.join(app.getPath("temp"), "fleetcomm-update.cmd");
    fs.writeFileSync(script, [
      "@echo off",
      "timeout /t 2 /nobreak >nul",
      'move /y "' + origExe + '" "' + origExe + '.old" >nul',
      'move /y "' + fresh + '" "' + origExe + '" >nul',
      'start "" "' + origExe + '"',
      'del "' + origExe + '.old" >nul 2>&1',
      'del "%~f0"'
    ].join("\r\n"));
    require("child_process").spawn("cmd.exe", ["/c", script], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    setTimeout(shutdown, 300);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
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
  win.on("closed", () => { win = null; shutdown(); });
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

ipcMain.handle("connect", async (ev, { host, port, callsign, nets, token, relayPassword, roleTokens }) => {
  if (stack) stack.destroy();
  const allTokens = [].concat(roleTokens || [], token ? [token] : []);
  stack = new RadioStack({ host, port: port || 64738, callsign,
    tokens: allTokens, password: relayPassword || "",
    cert: identity && identity.cert, key: identity && identity.key });
  stack.on("rx", (r) => sendWin("rx", { idx: r.idx, session: r.session, name: r.name, opus: r.opus, last: r.last }));
  stack.on("chat", (m) => sendWin("chat", m));
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
ipcMain.on("send-text", (ev, { idx, message }) => stack && stack.sendText(idx, message));
ipcMain.handle("atc-view", () => stack ? stack.atcView() : []);
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

/* ── unconditional shutdown ──
   Deliberately never calls uio.stop(): the input-hook library can wedge the
   main thread mid-stop, and the OS removes hooks at process death anyway.
   Teardown what matters (overlay window, relay sockets), then exit — with an
   absolute backstop. Nothing of FleetComm may outlive its window. */
let exiting = false;
function shutdown() {
  if (exiting) return;
  exiting = true;
  try { if (overlay) { overlay.destroy(); overlay = null; } } catch (e) {}
  try { if (stack) { stack.destroy(); stack = null; } } catch (e) {}
  setTimeout(() => { try { app.exit(0); } catch (e) { process.exit(0); } }, 200);
  setTimeout(() => process.exit(0), 1500);
}
app.on("window-all-closed", shutdown);
app.on("before-quit", shutdown);
