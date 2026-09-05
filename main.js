"use strict";
/* FleetComm — Electron main: window, global PTT hooks, radio stack owner. */
const { app, BrowserWindow, ipcMain, shell, screen, session, desktopCapturer } = require("electron");
const homeInstallMod = require("./src/home-install");   /* used at the single-instance gate below — must precede it */
const path = require("path");
const fs = require("fs");
const http = require("http");
const https = require("https");
const crypto = require("crypto");
const { RadioStack } = require("./src/radio-stack");
const { createGovernor } = require("./src/dial-governor");
const { loadOrCreate } = require("./src/identity");

/* ONE dial budget for the whole app, across every stack ever constructed —
   murmur's autoban counts attempts per IP, so a fresh RadioStack must not
   mean a fresh allowance. Lives here, outlives "connect". The autotest rig
   dials loopback hard on purpose; it gets room, not exemption. */
const dialGovernor = process.env.FLEETCOMM_AUTOTEST
  ? createGovernor({ maxAttempts: 64, paceMs: 0 })
  : createGovernor();

/* ── never background this app ──
   backgroundThrottling:false already un-throttles timers, but Chromium ALSO
   marks an occluded window (game fullscreen in front — the normal case)
   as backgrounded/hidden, and Gamepad API sampling is gated on that state.
   Without these switches a flight-stick PTT works on the desktop and dies the
   moment the game has focus — the one condition that matters. */
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
/* Chromium's native occlusion tracker on Windows decides a window behind the
   game is "hidden": requestAnimationFrame stops, video decode is deprioritised,
   the document goes visibilityState=hidden. The two switches above stop the
   THROTTLING that follows, not the verdict itself — and the field saw cam
   feeds lag and the overlay go stale until the app was tabbed back. Disable
   the calculation: every FleetComm window is treated as visible, always. */
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");

/* The autotest rig gets a throwaway profile: it used to run against the
   operator's real userData/localStorage, leaving autotest state behind (a
   persisted "autotest-token" flipped a COMMAND gate on the NEXT run) and
   sharing the single-instance lock with a genuinely running FleetComm.
   Before the lock on purpose — the lock is scoped to userData. */
if (process.env.FLEETCOMM_AUTOTEST) {
  const tmp = require("os").tmpdir();
  /* sweep earlier rigs' throwaway profiles — they accumulate otherwise */
  try {
    for (const d of fs.readdirSync(tmp)) {
      if (d.startsWith("fleetcomm-autotest-")) { try { fs.rmSync(path.join(tmp, d), { recursive: true, force: true }); } catch (e) {} }
    }
  } catch (e) {}
  app.setPath("userData", fs.mkdtempSync(path.join(tmp, "fleetcomm-autotest-")));
}

/* Only one FleetComm at a time — a second launch just focuses the first. */
if (!app.requestSingleInstanceLock()) app.quit();
/* One identity for the taskbar: the running process and the Start Menu
   shortcut (see homeInstall) carry the same AppUserModelID, which is what
   lets a pin taken from the live window resolve to a file that survives
   both the portable launcher's temp unpack and the next update. */
if (process.platform === "win32") app.setAppUserModelId(homeInstallMod.APP_ID);
app.on("second-instance", () => {
  if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
});

let win = null, stack = null, uio = null, identity = null, keyLabel = (c) => "KEY " + c;
let connectGeneration = 0;
const boundedText = (value, max) => String(value == null ? "" : value).trim().slice(0, max);
const boundedInt = (value, min, max, fallback) => {
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
};
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
function lockLocalWindow(window) {
  /* The ONLY window a page may open is a cam pop-out (frame name fcpop-*):
     frameless, always on top of a borderless game, its own OS window, as many
     as the operator wants — a same-origin child plays the opener's MediaStream
     directly, so no second WebRTC leg. Everything else stays denied. */
  window.webContents.setWindowOpenHandler(({ frameName }) => {
    if (typeof frameName === "string" && frameName.startsWith("fcpop-")) {
      return { action: "allow", overrideBrowserWindowOptions: {
        frame: false, alwaysOnTop: true, resizable: true, minWidth: 240, minHeight: 150,
        backgroundColor: "#000000", title: "FleetComm cam", autoHideMenuBar: true, skipTaskbar: false,
        webPreferences: { contextIsolation: true, sandbox: false, nodeIntegration: false, backgroundThrottling: false }
      } };
    }
    return { action: "deny" };
  });
  window.webContents.on("did-create-window", (child) => {
    try { child.setAlwaysOnTop(true, "screen-saver"); child.setMenuBarVisibility(false); } catch (e) {}
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (url !== window.webContents.getURL()) event.preventDefault();
  });
  window.webContents.on("will-attach-webview", event => event.preventDefault());
}

function createOverlay() {
  const c = loadOvCfg();
  const disp = screen.getPrimaryDisplay().workArea;
  const b = c.bounds || { x: disp.x + disp.width - 340, y: disp.y + 60, width: 320, height: 260 };
  overlay = new BrowserWindow({
    ...b, frame: false, transparent: true, resizable: true, skipTaskbar: true,
    alwaysOnTop: true, hasShadow: false, minimizable: false, maximizable: false,
    focusable: false,
    webPreferences: {
      preload: path.join(__dirname, "src", "overlay-preload.js"),
      backgroundThrottling: false,   /* the overlay is only ever seen unfocused */
      nodeIntegration: false, contextIsolation: true, sandbox: false, webSecurity: true
    }
  });
  lockLocalWindow(overlay);
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
ipcMain.on("ov-edit", (ev, on) => setOvEdit(!!on));
ipcMain.on("ov-lock", () => setOvEdit(false));
ipcMain.on("ov-set", (ev, c) => {
  const cfg = loadOvCfg();
  cfg.opacity = Math.max(15, Math.min(100, Number(c && c.opacity) || 72));
  cfg.scale = Math.max(70, Math.min(180, Number(c && c.scale) || 100));
  saveOvCfg();
});
ipcMain.on("ov-state", (ev, nets) => {
  lastOvState = Array.isArray(nets) ? nets.slice(0, 32).map(net => ({
    name: String(net.name || "").slice(0, 80), freq: String(net.freq || "").slice(0, 16),
    who: net.who == null ? null : String(net.who).slice(0, 80), me: String(net.me || "").slice(0, 80),
    tx: !!net.tx, active: !!net.active, mon: !!net.mon
  })) : [];
  sendOverlay("ov-state", lastOvState);
});

/* ── update check ── */
const { cmpVer, reconcile: reconcileState, blocked, attempt } = require("./src/update-guard");
const { dirWritable, isPortableExecutable, validVersion, writeJsonAtomic } = require("./src/update-helper");
let availableUpdate = null, updateInProgress = false;
function fetchJson(url, depth) {
  return new Promise((resolve, reject) => {
    if ((depth || 0) > 5) return reject(new Error("too many redirects"));
    let parsed;
    try { parsed = new URL(url); } catch (error) { return reject(new Error("invalid update URL")); }
    if (parsed.protocol !== "https:") return reject(new Error("update URL must use HTTPS"));
    const req = https.get(url, { timeout: 8000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return fetchJson(new URL(res.headers.location, parsed).toString(), (depth || 0) + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error("HTTP " + res.statusCode)); }
      let d = "";
      res.on("data", (c) => {
        d += c;
        if (d.length > 256 * 1024) req.destroy(new Error("update response is too large"));
      });
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
    if (info.version && !validVersion(info.version)) throw new Error("update feed returned an invalid version");
    if (info.version && cmpVer(info.version, app.getVersion()) > 0) {
      availableUpdate = { status: "update", version: info.version, notes: String(info.notes || "").slice(0, 4000), url: u.releases || u.url };
      return availableUpdate;
    }
    availableUpdate = null;
    return { status: "current", version: app.getVersion() };
  } catch (e) { availableUpdate = null; return { status: "error", error: e.message }; }
}
ipcMain.handle("check-updates", () => checkUpdates());
/* Visual smoke series: the rig walks each station (and both watches) and asks
   for a capture — UI work is judged by looking at every page, not just COMMS.
   Double-gated: only in autotest runs that asked for screenshots. */
ipcMain.handle("autotest-shot", async (e, suffix) => {
  if (!process.env.FLEETCOMM_AUTOTEST || !process.env.FLEETCOMM_SHOT || !win) return { ok: false };
  try {
    /* "overlay" captures the in-game overlay window — its pixels matter as
       much as the board's and no other check ever looks at them */
    const src = String(suffix).startsWith("overlay") && overlay && !overlay.isDestroyed() ? overlay : win;
    const img = await src.webContents.capturePage();
    const p = process.env.FLEETCOMM_SHOT.replace(/\.png$/i, "") + "-" +
      String(suffix).replace(/[^a-z0-9-]/gi, "").slice(0, 24) + ".png";
    fs.writeFileSync(p, img.toPNG());
    console.log("[AUTOTEST] screenshot=" + p);
    return { ok: true };
  } catch (err) { console.log("[AUTOTEST] screenshot-failed=" + err.message); return { ok: false }; }
});

/* ── self-update (Windows portable) ──
   Downloads the new exe straight from the release, then hands off to a tiny
   script that waits for us to exit, swaps the file on disk, and relaunches.
   No installer involved, and app-downloaded files carry no mark-of-the-web,
   so there's no SmartScreen prompt on the way back up. */
function downloadFile(url, dest, onPct, depth) {
  return new Promise((resolve, reject) => {
    if ((depth || 0) > 5) return reject(new Error("too many redirects"));
    let parsed;
    try { parsed = new URL(url); } catch (error) { return reject(new Error("invalid download URL")); }
    if (parsed.protocol !== "https:") return reject(new Error("download URL must use HTTPS"));
    const req = https.get(url, { timeout: 30000, headers: { "User-Agent": "FleetComm" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        let next;
        try { next = new URL(res.headers.location, parsed).toString(); }
        catch (error) { return reject(new Error("invalid download redirect")); }
        return downloadFile(next, dest, onPct, (depth || 0) + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error("HTTP " + res.statusCode)); }
      const total = parseInt(res.headers["content-length"] || "0", 10);
      if (total > 512 * 1024 * 1024) { res.resume(); return reject(new Error("download is unexpectedly large")); }
      let got = 0;
      const out = fs.createWriteStream(dest, { mode: 0o600 });
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        try { out.destroy(); } catch (ignore) {}
        try { fs.unlinkSync(dest); } catch (ignore) {}
        reject(error);
      };
      res.on("data", (ch) => {
        got += ch.length;
        if (got > 512 * 1024 * 1024) return fail(new Error("download is unexpectedly large"));
        if (total && onPct) onPct(Math.round(got / total * 100));
      });
      res.pipe(out);
      out.on("finish", () => out.close(() => { if (!settled) { settled = true; resolve(got); } }));
      out.on("error", fail);
      res.on("error", fail);
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("download timeout")); });
  });
}
/* ── soundboard library (files live in userData/sounds) ── */
const soundsDir = () => {
  const d = path.join(app.getPath("userData"), "sounds");
  try { fs.mkdirSync(d, { recursive: true }); } catch (e) {}
  return d;
};
function soundFile(name) {
  const base = path.basename(boundedText(name, 255));
  if (!base || base === "." || base === "..") throw new Error("invalid sound name");
  const p = path.join(soundsDir(), base);
  const st = fs.lstatSync(p);
  if (!st.isFile() || st.isSymbolicLink()) throw new Error("sound is not a regular file");
  return { path: p, stat: st };
}
ipcMain.handle("sounds-list", () => {
  try {
    return fs.readdirSync(soundsDir())
      .filter(f => /\.(wav|mp3|ogg|m4a|flac|webm)$/i.test(f))
      // Renderer only needs the logical filename and size.  Do not expose the
      // user's absolute profile path across the IPC boundary.
      .map(f => {
        try { const file = soundFile(f); return { name: f, size: file.stat.size }; }
        catch (error) { return null; }
      }).filter(Boolean);
  } catch (e) { return []; }
});
/* The soundboard keys the net for everyone, so COMMAND-only is enforced here as
   well as in the UI — a renderer-side check alone is a suggestion, not a rule. */
function isCommand() {
  return acctRole === "command";
}
ipcMain.handle("sounds-add", async () => {
  if (!isCommand()) return { ok: false, error: "COMMAND authority required" };
  const { dialog } = require("electron");
  const r = await dialog.showOpenDialog(win, {
    title: "Add soundboard clips",
    properties: ["openFile", "multiSelections"],
    filters: [{ name: "Audio", extensions: ["wav", "mp3", "ogg", "m4a", "flac", "webm"] }]
  });
  if (r.canceled) return { ok: false, canceled: true };
  const added = [];
  for (const f of r.filePaths) {
    try {
      const base = path.basename(f).replace(/[^\w.\-' ]+/g, "_");
      const dest = path.join(soundsDir(), base);
      const stat = fs.statSync(f);
      if (stat.size > 12 * 1024 * 1024) continue; /* keep clips sane */
      /* Never follow an attacker-created destination symlink, and do not
         replace an existing clip behind the user's back. */
      fs.copyFileSync(f, dest, fs.constants.COPYFILE_EXCL);
      added.push(base);
    } catch (e) {}
  }
  return { ok: true, added };
});
ipcMain.handle("sounds-read", (ev, name) => {
  try {
    const data = fs.readFileSync(soundFile(name).path);
    return { ok: true, data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle("sounds-delete", (ev, name) => {
  try { fs.unlinkSync(soundFile(name).path); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});
/* Pick clips for the SHARED library: dialog + read, no local copy. The bytes go
   back to the renderer as base64, which uploads them to the accounts service —
   the library is fleet property there, not files on one machine. */
ipcMain.handle("sounds-pick", async () => {
  if (!isCommand()) return { ok: false, error: "COMMAND authority required" };
  const { dialog } = require("electron");
  const r = await dialog.showOpenDialog(win, {
    title: "Add clips to the fleet 1MC library",
    properties: ["openFile", "multiSelections"],
    filters: [{ name: "Audio", extensions: ["wav", "mp3", "ogg", "m4a", "flac", "webm"] }]
  });
  if (r.canceled) return { ok: false, canceled: true };
  const clips = [], skipped = [];
  for (const f of r.filePaths.slice(0, 12)) {
    try {
      /* apostrophes are part of real clip names — BOATSWAIN'S CALL must not
         become BOATSWAIN_S CALL on every ship's 1MC */
      const name = path.basename(f).replace(/[^\w.\-' ]+/g, "_");
      const stat = fs.statSync(f);
      if (stat.size > 4 * 1024 * 1024) { skipped.push(name + " (over 4MB)"); continue; }
      clips.push({ name, size: stat.size, data: fs.readFileSync(f).toString("base64") });
    } catch (e) { skipped.push(path.basename(f)); }
  }
  return { ok: true, clips, skipped };
});

/* ── Discord sign-in (PKCE, loopback — no client secret anywhere) ── */
const OAUTH_PORT = 53682;
let acctToken = null, acctRelay = null, acctRole = null;
function b64url(buf) { return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
function postForm(url, form) {
  return new Promise((resolve, reject) => {
    const data = new URLSearchParams(form).toString();
    const u = new URL(url);
    const req = https.request({ hostname: u.hostname, path: u.pathname, method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(data) }, timeout: 15000 },
      (res) => { let d = ""; res.on("data", c => {
        d += c;
        if (d.length > 256 * 1024) req.destroy(new Error("OAuth response is too large"));
      }); res.on("end", () => {
        try { const j = JSON.parse(d); res.statusCode === 200 ? resolve(j) : reject(new Error(j.error_description || j.error || ("HTTP " + res.statusCode))); }
        catch (e) { reject(e); } }); });
    req.on("error", reject); req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.write(data); req.end();
  });
}
const { accountBase, isInsecure, insecureNote } = require("./src/accounts-url");
const { shortFingerprint } = require("./src/relay-trust");
function jsonCall(base, method, pathName, bodyObj, bearer, maxResponse) {
  return new Promise((resolve, reject) => {
    let root, u;
    try {
      root = accountBase(base);
      u = new URL(pathName, root);
      if (u.origin !== root.origin || !u.pathname.startsWith("/api/")) throw new Error("invalid accounts path");
    } catch (error) { return reject(error); }
    const lib = u.protocol === "https:" ? https : http;
    const data = bodyObj ? JSON.stringify(bodyObj) : null;
    const req = lib.request({ hostname: u.hostname, port: u.port, path: u.pathname, method,
      headers: Object.assign({ "Content-Type": "application/json" },
        data ? { "Content-Length": Buffer.byteLength(data) } : {},
        bearer ? { Authorization: "Bearer " + bearer } : {}), timeout: 12000 },
      (res) => { let d = ""; res.on("data", c => {
        d += c;
        if (d.length > (maxResponse || 1024 * 1024)) req.destroy(new Error("accounts response is too large"));
      }); res.on("end", () => {
        /* httpStatus rides along so callers can tell a VERDICT (401/403 — the
           server judged us) from a server-side FAULT (5xx — it wraps its own
           internal errors as {ok:false} JSON). Without it, one transient 500
           on /api/me read as "access revoked" and ejected the whole fleet. */
        try { const body = JSON.parse(d);
              if (body && typeof body === "object") body.httpStatus = res.statusCode;
              resolve(body); }
        catch (e) { reject(new Error("bad response")); } }); });
    req.on("error", reject); req.on("timeout", () => { req.destroy(); reject(new Error("service timeout")); });
    if (data) req.write(data); req.end();
  });
}
function keepAccountSecrets(response) {
  if (!response || typeof response !== "object") return response;
  if (response.token) acctToken = response.token;
  if (Object.prototype.hasOwnProperty.call(response, "relay")) acctRelay = response.relay || null;
  /* main keeps its own record of the role: COMMAND checks here must key on
     what the SERVER said, and the relay payload carries credentials, not rank —
     isCommand() once tested a relay field the service never sends, so every
     COMMAND account was refused clip management by its own client */
  if (response.account && typeof response.account.role === "string") acctRole = response.account.role;
  const out = Object.assign({}, response);
  delete out.token;
  out.authorized = !!response.relay;
  delete out.relay;
  return out;
}
/* ── accounts endpoint override ──
   The accounts URL is baked into the packaged config, so if a release ever ships
   pointing at an endpoint that isn't live (v0.10.1 shipped aimed at :443 for a
   TLS deployment that was never performed), sign-in is dead for everyone until a
   whole new build reaches every operator. That is far too slow a recovery for a
   one-line mistake, so the address is overridable at runtime and persisted here.
   Empty override = use whatever the build shipped with. */
/* Pinned relay certificate — trust on first use, per host. See src/relay-trust.js. */
const pinFile = () => path.join(app.getPath("userData"), "relay-pins.json");
function readPins() { try { return JSON.parse(fs.readFileSync(pinFile(), "utf8")) || {}; } catch (e) { return {}; } }
function writePins(p) { try { fs.writeFileSync(pinFile(), JSON.stringify(p)); return true; } catch (e) { return false; } }
function getPin(host) { return readPins()[String(host)] || ""; }
function setPin(host, fp) { const p = readPins(); p[String(host)] = fp; writePins(p); }
ipcMain.handle("relay-pin", (ev, req) => {
  const host = String((req && req.host) || "");
  if (req && req.clear) { const p = readPins(); delete p[host]; writePins(p);
    return { ok: true, host, pin: "", shown: "" }; }
  const fp = getPin(host);
  return { ok: true, host, pin: fp, shown: shortFingerprint(fp) };
});
const endpointFile = () => path.join(app.getPath("userData"), "endpoint.json");
function accountsOverride() {
  try {
    const v = JSON.parse(fs.readFileSync(endpointFile(), "utf8")).accountsUrl;
    return /^https?:\/\/[^\s]+$/.test(v || "") ? v : "";
  } catch (e) { return ""; }
}
function accountsCfg() {
  const cfg = Object.assign({}, require("./config/22nd-package.json").accounts);
  const o = accountsOverride();
  if (o) cfg.url = o;
  return cfg;
}
ipcMain.handle("accounts-endpoint", (ev, req) => {
  const shipped = (require("./config/22nd-package.json").accounts || {}).url || "";
  const activeNow = accountsCfg().url || "";
  if (!req || req.get) return { shipped, override: accountsOverride(), active: activeNow,
                                insecure: isInsecure(activeNow), note: insecureNote(activeNow) };
  const v = String(req.url || "").trim();
  if (v && !/^https?:\/\/[^\s]+$/.test(v)) return { ok: false, error: "must start with http:// or https://" };
  try {
    fs.writeFileSync(endpointFile(), JSON.stringify({ accountsUrl: v }));
    const active = v || shipped;
    return { ok: true, shipped, override: v, active, insecure: isInsecure(active), note: insecureNote(active) };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle("discord-login", async (ev, request) => {
  const cfg = accountsCfg();
  if (!cfg || !cfg.url || !cfg.discordClientId) return { ok: false, unconfigured: true };
  if (isInsecure(cfg.url)) console.warn("[fleetcomm] accounts endpoint is not encrypted:", cfg.url);
  const bootstrapToken = String(request && request.bootstrapToken || "").trim().slice(0, 200);
  try {
    const status = await jsonCall(cfg.url, "GET", "/api/status");
    if (status && status.ok && !status.initialized && !bootstrapToken)
      return { ok: false, bootstrapRequired: true, error: "initial COMMAND setup code required" };
  } catch (error) { return { ok: false, error: error.message }; }
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));
  const redirect = "http://127.0.0.1:" + OAUTH_PORT + "/callback";
  const authUrl = "https://discord.com/oauth2/authorize?response_type=code&client_id=" + cfg.discordClientId +
    /* `guilds` lets the ACCOUNTS SERVICE confirm the operator is in the fleet's
       Discord; `guilds.members.read` lets it ask WHEN they joined each server
       that matters — the approval queue's home-organization hint (an ally
       guesting in the fleet's Discord joined their own org years earlier).
       The checks happen there, against Discord, never in this client. Adding
       a scope makes Discord show its consent screen once more, to everyone. */
    "&scope=identify%20guilds%20guilds.members.read&redirect_uri=" + encodeURIComponent(redirect) + "&state=" + state +
    "&code_challenge=" + challenge + "&code_challenge_method=S256";
  let code;
  try {
    code = await new Promise((resolve, reject) => {
      let settled = false;
      let timer;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { srv.close(); } catch (ignore) {}
        error ? reject(error) : resolve(value);
      };
      const srv = http.createServer((req2, res2) => {
        const u = new URL(req2.url, "http://x");
        if (u.pathname !== "/callback") { res2.writeHead(404); return res2.end(); }
        const error = u.searchParams.get("state") !== state ? new Error("state mismatch")
          : u.searchParams.get("error") ? new Error(u.searchParams.get("error"))
          : !u.searchParams.get("code") ? new Error("Discord did not return a sign-in code") : null;
        res2.writeHead(error ? 400 : 200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
          "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'" });
        res2.end("<body style='font-family:sans-serif;background:#0b0f13;color:#e8edf1;display:grid;place-items:center;height:100vh'><div><h2>FleetComm</h2>" +
          (error ? "Sign-in could not be completed. Return to FleetComm for details." : "Signed in — you can close this tab and return to the app.") + "</div></body>");
        finish(error, u.searchParams.get("code"));
      });
      srv.on("error", (e) => finish(new Error(e.code === "EADDRINUSE" ? "port 53682 busy — close other FleetComm sign-ins" : e.message)));
      srv.listen(OAUTH_PORT, "127.0.0.1", () => {
        try { shell.openExternal(authUrl).catch(finish); }
        catch (error) { finish(error); }
      });
      timer = setTimeout(() => finish(new Error("sign-in timed out")), 180000);
    });
  } catch (e) { return { ok: false, error: e.message }; }
  try {
    const tok = await postForm("https://discord.com/api/oauth2/token", {
      client_id: cfg.discordClientId, grant_type: "authorization_code",
      code, redirect_uri: redirect, code_verifier: verifier
    });
    const login = await jsonCall(cfg.url, "POST", "/api/login", { discordToken: tok.access_token, bootstrapToken });
    return login.ok ? keepAccountSecrets(login) : login;
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle("acct", async (ev, request) => {
  const { method, path: p, body: b } = request || {};
  const cfg = accountsCfg();
  if (!cfg || !cfg.url) return { ok: false, error: "accounts service not configured" };
  if (!acctToken) return { ok: false, error: "not signed in" };
  const verb = method === "POST" ? "POST" : "GET";
  const allowed = verb === "GET"
    ? ["/api/me", "/api/accounts", "/api/nets/access", "/api/sounds", "/api/cam-viewers", "/api/personnel", "/api/personnel/me", "/api/allied"].includes(p) || /^\/api\/sounds\/[a-f0-9]{16}$/.test(p)
    : p === "/api/callsign" || p === "/api/nets/access" || p === "/api/sounds" || p === "/api/allied" || /^\/api\/allied\/\d{5,25}\/remove$/.test(p)
      || /^\/api\/sounds\/[a-f0-9]{16}\/delete$/.test(p) || /^\/api\/accounts\/\d+\/role$/.test(p) || /^\/api\/accounts\/[A-Za-z0-9-]{1,40}\/orglead$/.test(p)
      || /^\/api\/personnel\/[A-Za-z0-9-]{1,40}\/callsign$/.test(p);
  if (!allowed) return { ok: false, error: "unsupported account operation" };
  /* clip payloads are base64 audio — megabytes, not the usual JSON kilobytes */
  const soundBytes = p.startsWith("/api/sounds") ? 8 * 1024 * 1024 : undefined;
  try {
    const response = await jsonCall(cfg.url, verb, p, b || null, acctToken, soundBytes);
    /* a 5xx is the server failing, not the server judging us — same class as a
       reset: no verdict was rendered, so the heartbeat must hold, not eject */
    if (response && response.httpStatus >= 500)
      return { ok: false, transport: true, error: "accounts service error " + response.httpStatus };
    return p === "/api/me" && response.ok ? keepAccountSecrets(response) : response;
  }
  /* transport:true = the request never completed (reset, timeout, DNS) — the
     server rendered NO verdict. The heartbeat must not treat this as revoked
     access; see src/acct-heartbeat.js. */
  catch (e) { return { ok: false, transport: true, error: e.message }; }
});

/* ── update attempt bookkeeping ──
   An updater that retries automatically after a failed swap is an updater that
   can spin: relaunch, see the same new version, try again, forever. So every
   automatic attempt is recorded before we hand off, and checked on the way back
   up. If we return still running the old version, that version gets exactly one
   automatic try and never another — it falls back to the banner, which explains
   what happened and leaves the decision with the operator. */
const updStatePath = () => path.join(app.getPath("userData"), "update-state.json");
function readUpdState() { try { return JSON.parse(fs.readFileSync(updStatePath(), "utf8")); } catch (e) { return {}; } }
/* Returns whether the record actually persisted. This matters: the loop guard
   lives in that file, so if we cannot write it we cannot promise a failed swap
   won't be retried forever — and in that case we decline to auto-install at all
   and leave it to the banner. Failing closed beats spinning. */
function writeUpdState(s) {
  try {
    writeJsonAtomic(updStatePath(), s);
    const saved = JSON.parse(fs.readFileSync(updStatePath(), "utf8"));
    return saved.target === s.target && saved.status === s.status;
  } catch (e) { return false; }
}
let updateNote = null;   /* what to tell the renderer about the last attempt */

function reconcileUpdate() {
  const before = readUpdState();
  const r = reconcileState(app.getVersion(), before, process.argv.includes("--update-failed"));
  if (r.note && r.note.installed && before.backup) {
    try { fs.unlinkSync(before.backup); } catch (error) {}
  }
  writeUpdState(r.state);
  updateNote = r.note;
}
function autoUpdateBlocked(version) { return blocked(readUpdState(), version); }

ipcMain.handle("update-note", () => updateNote);

function waitForFile(file, timeoutMs) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      if (fs.existsSync(file)) return resolve(true);
      if (Date.now() >= deadline) return resolve(false);
      setTimeout(poll, 250);
    };
    poll();
  });
}
/* Run the swap via the Task Scheduler: the task is started by the schedule
   service, not by us, so it is outside our process tree and survives whatever
   killed our directly-spawned children (portable-launcher cleanup, AV rules
   about unsigned apps starting PowerShell). schtasks /tr is capped at ~261
   chars, far too short for the full argument list — so the arguments are baked
   into a tiny wrapper script and the task just runs the wrapper. */
function scheduleSwapTask(powershell, swapScript, args, outLog) {
  const { spawnSync } = require("child_process");
  const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
  try {
    const wrap = swapScript.replace(/\.ps1$/, "") + "-wrap.ps1";
    const pairs = [];
    for (let i = args.indexOf("-Exe"); i >= 0 && i + 1 < args.length; i += 2) pairs.push(args[i] + " " + q(args[i + 1]));
    /* the task's "once at 23:59" schedule is only a dummy (we /run it now),
       but it is a REAL schedule too — left registered, it re-fired at 23:59
       that night, re-ran the swap against a consumed download and relaunched
       the app while the operator slept. The wrapper's last act is deleting
       its own task; a running task may delete itself. */
    /* BOM required: PowerShell 5.1 reads a BOM-less script as ANSI, which
       garbles profile paths on any non-ASCII Windows username (same 5.1
       dialect family as the Set-Content trap in update-swap.ps1) */
    fs.writeFileSync(wrap, "\ufeff& " + q(swapScript) + " " + pairs.join(" ") + " *>> " + q(outLog) + "\n" +
      "schtasks.exe /delete /tn FleetCommUpdate /f *>> " + q(outLog) + "\n");
    const tr = '"' + powershell + '" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + wrap + '"';
    const create = spawnSync("schtasks.exe", ["/create", "/f", "/tn", "FleetCommUpdate", "/sc", "once", "/st", "23:59", "/tr", tr], { encoding: "utf8", windowsHide: true });
    const run = spawnSync("schtasks.exe", ["/run", "/tn", "FleetCommUpdate"], { encoding: "utf8", windowsHide: true });
    try {
      fs.appendFileSync(outLog, new Date().toISOString() + " schtasks create rc=" + create.status + " " +
        String(create.stdout || "").trim() + String(create.stderr || "").trim() +
        " | run rc=" + run.status + " " + String(run.stdout || "").trim() + String(run.stderr || "").trim() + "\n");
    } catch (e) {}
    return run.status === 0;
  } catch (error) {
    try { fs.appendFileSync(outLog, new Date().toISOString() + " schtasks fallback threw: " + error.message + "\n"); } catch (e) {}
    return false;
  }
}
/* ── the persistent home ──
   A portable build unpacks to a throwaway temp folder every launch, so
   nothing about the running exe can be pinned. After the window is up, lay
   the newest launcher the operator has run at a fixed path and point a Start
   Menu shortcut (stamped with the app id) at it. The update swap replaces
   that file in place, so a pin taken there stays good forever. Decisions are
   in src/home-install.js; this is the filesystem half. Never blocks the
   radio: any failure is a console line. FLEETCOMM_HOME_ROOT redirects both
   folders so the rig can exercise the real copy without touching a profile. */
async function homeInstall() {
  try {
    const root = process.env.FLEETCOMM_HOME_ROOT;
    const localAppData = root ? path.join(root, "Local") : (process.env.LOCALAPPDATA || path.join(app.getPath("home"), "AppData", "Local"));
    const startMenu = root ? path.join(root, "StartMenu") : path.join(app.getPath("appData"), "Microsoft", "Windows", "Start Menu", "Programs");
    const base = { platform: process.platform, portableExe: process.env.PORTABLE_EXECUTABLE_FILE, localAppData, startMenu,
      runningVersion: app.getVersion(), homeVersion: null, homeExists: false };
    const pre = homeInstallMod.plan(base);
    if (!pre.active) return;
    base.homeExists = fs.existsSync(pre.homeExe);
    try { base.homeVersion = fs.readFileSync(pre.stamp, "utf8").trim() || null; } catch (e) { base.homeVersion = null; }
    const p = homeInstallMod.plan(base);
    let copied = false;
    if (p.copy) {
      fs.mkdirSync(p.homeDir, { recursive: true });
      const tmp = p.homeExe + ".new";
      await fs.promises.copyFile(process.env.PORTABLE_EXECUTABLE_FILE, tmp);
      if (!isPortableExecutable(tmp, 40 * 1024 * 1024)) { try { fs.unlinkSync(tmp); } catch (e) {} throw new Error("home copy failed verification"); }
      let placed = false;
      for (let i = 0; i < 5 && !placed; i++) {
        try { fs.renameSync(tmp, p.homeExe); placed = true; }
        catch (e) { await new Promise(r => setTimeout(r, 600)); }     /* AV may hold a fresh exe briefly */
      }
      if (!placed) { try { fs.unlinkSync(tmp); } catch (e) {} throw new Error("could not place the home copy"); }
      fs.writeFileSync(p.stamp, app.getVersion());
      copied = true;
    } else if (p.launchedFromHome && base.homeVersion !== app.getVersion()) {
      /* the swap updates the home exe in place but not the stamp — keep it honest */
      try { fs.mkdirSync(p.homeDir, { recursive: true }); fs.writeFileSync(p.stamp, app.getVersion()); } catch (e) {}
    }
    fs.mkdirSync(startMenu, { recursive: true });
    const hadShortcut = fs.existsSync(p.shortcut.path);
    const ok = shell.writeShortcutLink(p.shortcut.path, "create", {
      target: p.shortcut.target, cwd: p.shortcut.cwd, description: p.shortcut.description,
      icon: p.shortcut.icon, iconIndex: p.shortcut.iconIndex, appUserModelId: p.shortcut.appUserModelId });
    if (!ok) throw new Error("Start Menu shortcut refused");
    console.log("[fleetcomm] home install: " + (copied ? "copied v" + app.getVersion() : p.launchedFromHome ? "running from home" : "home current") +
      " -> " + p.homeExe + " shortcut=" + (hadShortcut ? "refreshed" : "created"));
    if (copied || !hadShortcut) sendWin("update-note", { home: p.homeExe, first: !hadShortcut });
  } catch (e) { console.warn("[fleetcomm] home install skipped: " + e.message); }
}
ipcMain.handle("do-update", async (ev, info) => {
  const pkgCfg = require("./config/22nd-package.json");
  const origExe = process.env.PORTABLE_EXECUTABLE_FILE;
  const tpl = pkgCfg.updates && pkgCfg.updates.exeTemplate;
  if (process.platform !== "win32" || !origExe || !tpl) return { ok: false, fallback: true };
  if (updateInProgress) return { ok: false, error: "an update is already in progress" };
  updateInProgress = true;
  try {
    const checked = availableUpdate && availableUpdate.version === info.version ? availableUpdate : await checkUpdates();
    if (!checked || checked.status !== "update" || checked.version !== info.version || !validVersion(checked.version))
      throw new Error("the requested release is no longer the available update");
    const version = checked.version;
    /* The update IS a rename of the exe in place. An exe parked in
       C:\Program Files (admin-only) fails that rename with EPERM every time —
       for one operator, silently, across four releases. Say so up front,
       before downloading ~100MB that can't be installed. */
    if (!dirWritable(path.dirname(origExe)))
      throw new Error("FleetComm can't update itself from where it's running — the folder \"" +
        path.dirname(origExe) + "\" is write-protected (C:\\Program Files works this way). " +
        "Move " + path.basename(origExe) + " to your Desktop or another normal folder and update from there.");
    const url = tpl.split("{v}").join(version);
    const nonce = process.pid + "-" + Date.now();
    const fresh = path.join(app.getPath("temp"), "FleetComm-" + version + "-" + nonce + ".exe");
    const bytes = await downloadFile(url, fresh, (pct) => sendWin("update-progress", pct));
    if (bytes < 40 * 1024 * 1024) throw new Error("download looks incomplete (" + bytes + " bytes)");
    if (!isPortableExecutable(fresh, 40 * 1024 * 1024)) throw new Error("downloaded file is not a valid Windows executable");

    /* ── running the swap ──
       NOT with process.execPath. On a portable build that is the Electron binary
       inside the temp directory electron-builder unpacks into — and the portable
       launcher DELETES that directory when we exit. The helper was being killed
       by our own shutdown, mid-wait, every single time: no swap, no error, and
       the operator relaunches into the old version.
       powershell.exe lives in System32, cannot be removed by our shutdown, and
       is resolved here by absolute path so a broken PATH can't break updates
       either. */
    const logFile = path.join(app.getPath("userData"), "update-helper.log");
    const swap = path.join(app.getPath("temp"), "fleetcomm-swap-" + nonce + ".ps1");
    fs.copyFileSync(path.join(__dirname, "src", "update-swap.ps1"), swap);
    const state = attempt(version, !!info.auto);
    if (!writeUpdState(state))
      throw new Error("can't record the attempt safely, so the update was not installed");

    const sysRoot = process.env.SystemRoot || process.env.windir || "C:\\Windows";
    const powershell = path.join(sysRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    if (!fs.existsSync(powershell)) throw new Error("PowerShell was not found, so the update can't be installed");
    const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", swap,
      "-Exe", origExe, "-Fresh", fresh, "-Backup", origExe + ".old",
      "-ParentPid", String(process.pid), "-StateFile", updStatePath(),
      "-Target", version, "-LogFile", logFile];
    try { fs.appendFileSync(logFile, new Date().toISOString() + " app: handing off to " + powershell + "\n"); } catch (e) {}
    /* The swap's stdout/stderr go to a file, not to "ignore": a swap that dies
       before its first Log line (param binding, policy, AV) used to vanish
       without a trace — five silent handoffs on one machine before anyone
       could say why. The child keeps its own handle after we close ours. */
    const swapOutPath = path.join(app.getPath("userData"), "swap-output.log");
    /* stale heartbeat from an earlier attempt must go BEFORE the spawn — the
       new installer may write its own within milliseconds */
    const alive = updStatePath() + ".alive";
    try { fs.unlinkSync(alive); } catch (e) {}
    let swapOut = "ignore";
    try { swapOut = fs.openSync(swapOutPath, "a"); } catch (e) {}
    const child = require("child_process").spawn(powershell, args, {
      detached: true, stdio: ["ignore", swapOut, swapOut], windowsHide: true,
      cwd: app.getPath("temp")     /* never our own unpack dir, which is about to vanish */
    });
    if (swapOut !== "ignore") try { fs.closeSync(swapOut); } catch (e) {}
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    let childExited = false;
    child.once("exit", () => { childExited = true; });
    child.unref();
    /* ── do not exit on faith ──
       On one machine every directly-spawned installer was killed at birth:
       spawn succeeded, then zero output, no swap, and the app had already
       exited — "it just closed and nothing happened". The swap script writes a
       heartbeat file the moment it executes; we leave only after seeing it.
       No heartbeat AND the child provably dead → relaunch the installer
       through the Task Scheduler, which runs it OUTSIDE our process tree,
       beyond whatever kills our children. (Only when provably dead: a swap
       that is merely slow to start must never gain a racing twin.)
       Still nothing → stay open and say so, instead of dying silently. */
    const appLog = (m) => { try { fs.appendFileSync(logFile, new Date().toISOString() + " app: " + m + "\n"); } catch (e) {} };
    let started = await waitForFile(alive, 8000);
    if (!started && !childExited) started = await waitForFile(alive, 12000);  /* just a slow cold start? */
    if (!started && childExited) {
      appLog("direct installer died without a heartbeat — falling back to the Task Scheduler");
      started = scheduleSwapTask(powershell, swap, args, swapOutPath) && (await waitForFile(alive, 12000));
    }
    if (!started) {
      appLog("no installer heartbeat by any route — giving up loudly");
      /* the app is STAYING OPEN, so the launch-time sweep won't run — a task
         we may have registered above still carries its (dummy but real) 23:59
         trigger, and left armed it would fire tonight and swap the exe out
         from under this running session. Disarm it before giving up. */
      try { require("child_process").spawnSync("schtasks.exe", ["/delete", "/tn", "FleetCommUpdate", "/f"], { windowsHide: true }); } catch (e) {}
      writeUpdState({ target: version, status: "failed", failedAt: Date.now(),
        reason: "Windows terminated the update installer before it could run" });
      updateInProgress = false;
      return { ok: false, error: "Windows blocked the update installer — likely antivirus. " +
        "Install the new version by hand; details are in swap-output.log." };
    }
    setTimeout(shutdown, 300);
    return { ok: true };
  } catch (e) {
    updateInProgress = false;
    return { ok: false, error: e.message };
  }
});
ipcMain.on("open-external", (ev, url) => {
  try { const parsed = new URL(url); if (parsed.protocol === "https:") shell.openExternal(parsed.toString()); }
  catch (error) {}
});
let curTheme = null;
ipcMain.on("theme", (ev, t) => {
  if (!t || !/^#[0-9a-f]{6}$/i.test(t.bg || "") || !/^#[0-9a-f]{6}$/i.test(t.ink || "")) {
    /* a silently dropped theme means the overlay and titlebar quietly stop
       following the board — say so, loudly, in the log */
    console.log("[theme] DROPPED invalid theme message: " + JSON.stringify(t));
    return;
  }
  curTheme = t;
  sendOverlay("ov-theme", t);
  if (process.platform !== "darwin" && win && !win.isDestroyed()) {
    try { win.setTitleBarOverlay({ color: t.bg, symbolColor: t.ink }); } catch (e) {}
  }
});

function createWindow() {
  const frameOpts = process.platform === "darwin"
    ? { titleBarStyle: "hidden", trafficLightPosition: { x: 12, y: 12 } }
    /* first paint before the renderer reports its theme — match the night bezel,
       not an older palette, so the controls never flash a foreign colour */
    : { titleBarStyle: "hidden", titleBarOverlay: { color: "#090F16", symbolColor: "#E7E0CD", height: 38 } };
  win = new BrowserWindow({
    width: 1180, height: 800, minWidth: 760, minHeight: 500,
    backgroundColor: "#090F16",
    title: "FleetComm",
    /* 22nd crest on the window/taskbar in dev runs; packaged Windows builds
       take it from the exe resources (build/icon.png via electron-builder) */
    icon: path.join(__dirname, "renderer", "crest.png"),
    ...frameOpts,
    webPreferences: {
      preload: path.join(__dirname, "src", "preload.js"),
      /* This app's whole purpose is to run while the GAME has focus, so an
         unfocused window is the normal case, not an idle one. Electron's default
         throttling starves renderer timers when the window is backgrounded,
         which is what made soundboard clips stutter and drop out mid-playback.
         Voice itself was unaffected only because mic capture runs on the audio
         thread in an AudioWorklet. */
      backgroundThrottling: false,
      nodeIntegration: false, contextIsolation: true, sandbox: false, webSecurity: true
    }
  });
  lockLocalWindow(win);
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  /* the theme can arrive before the frame is ready; re-apply it once shown */
  win.on("show", () => {
    if (process.platform === "darwin" || !curTheme) return;
    try { win.setTitleBarOverlay({ color: curTheme.bg, symbolColor: curTheme.ink }); } catch (e) {}
  });
  win.removeMenu && win.removeMenu();
  win.on("closed", () => { win = null; shutdown(); });
  /* Visual smoke: with FLEETCOMM_SHOT=<file.png> (autotest runs only), capture
     the window after the rig has connected and rendered. The [AUTOTEST] log
     proves behavior; this proves the pixels — a layout bug shows up here
     before an operator has to photograph their screen. */
  if (process.env.FLEETCOMM_SHOT && process.env.FLEETCOMM_AUTOTEST) {
    setTimeout(async () => {
      try {
        const img = await win.webContents.capturePage();
        fs.writeFileSync(process.env.FLEETCOMM_SHOT, img.toPNG());
        console.log("[AUTOTEST] screenshot=" + process.env.FLEETCOMM_SHOT);
      } catch (e) { console.log("[AUTOTEST] screenshot-failed=" + e.message); }
    }, 28000);   /* after the behavioral checks and their dialogs have cleared */
  }
}

app.whenReady().then(async () => {
  reconcileUpdate();
  /* Media permissions stay a MAIN-WINDOW-ONLY allowance. Audio is the mic;
     video is helmet-cam screen capture through the legacy desktop-capture
     constraint path (chromeMediaSourceId from the in-app picker). The overlay
     window is never granted capture of anything. */
  /* media for the main window, and WRITING to the clipboard (SETTINGS ▸ SYSTEM
     LOG ▸ COPY — the bug-report path — was refused by this very gate, so the
     one time an operator needed to hand over a log, the button did nothing) */
  const clipboardWrite = (permission) => permission === "clipboard-sanitized-write";
  session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    const isMainWindow = win && webContents === win.webContents;
    if (isMainWindow && clipboardWrite(permission)) return true;
    return !!(isMainWindow && permission === "media" &&
      (!details || !details.mediaType || details.mediaType === "audio" || details.mediaType === "video"));
  });
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const isMainWindow = win && webContents === win.webContents;
    if (isMainWindow && clipboardWrite(permission)) return callback(true);
    callback(!!(isMainWindow && permission === "media" &&
      (!details.mediaTypes || details.mediaTypes.every(t => t === "audio" || t === "video"))));
  });
  try { identity = await loadOrCreate(app.getPath("userData")); }
  catch (e) { console.warn("[fleetcomm] identity cert unavailable:", e.message); }
  createWindow();
  setTimeout(() => { homeInstall(); }, 3500);      /* after the board is up — it copies ~100MB once per version */
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
  /* belt to the wrapper's braces: sweep any FleetCommUpdate task an older
     build (or an interrupted swap) left registered, before it can re-fire */
  if (process.platform === "win32") {
    try {
      require("child_process").spawnSync("schtasks.exe", ["/delete", "/tn", "FleetCommUpdate", "/f"], { windowsHide: true });
    } catch (e) {}
  }
  setTimeout(async () => {
    if (updateNote) sendWin("update-note", updateNote);
    const r = await checkUpdates();
    if (r.status !== "update") return;
    sendWin("update-available", r);
    if (!autoUpdateBlocked(r.version)) sendWin("update-auto-offer", r);
  }, 2500);
});

ipcMain.handle("connect", async (ev, request) => {
  const generation = ++connectGeneration;
  const input = request || {};
  const host = boundedText(input.host, 253);
  const port = boundedInt(input.port, 1, 65535, 64738);
  const callsign = boundedText(input.callsign, 40);
  const token = boundedText(input.token, 200);
  if (!host || !/^[A-Za-z0-9.:[\]-]+$/.test(host) || !callsign || !Array.isArray(input.nets))
    return [{ ok: false, error: "invalid relay connection request" }];
  const nets = input.nets.slice(0, 64).map(net => ({
    name: boundedText(net && net.name, 120), channel: boundedText(net && net.channel, 120),
    freq: boundedText(net && net.freq, 16)
  })).filter(net => net.name && net.channel);
  if (stack) { stack.destroy(); stack = null; }
  const relay = acctRelay || {};
  const allTokens = [].concat(relay.tokens || [], !acctRelay && token ? [token] : []);
  const radio = new RadioStack({ host, port, callsign,
    tokens: allTokens, password: relay.password || "",
    rootChannel: require("./config/22nd-package.json").rootChannel,
    cert: identity && identity.cert, key: identity && identity.key,
    pin: getPin(host), onPin: (fp) => setPin(host, fp),
    governor: dialGovernor });
  stack = radio;
  radio.on("dial-hold", (h) => { if (stack === radio) sendWin("dial-hold", h); });
  radio.on("rx", (r) => { if (stack === radio) sendWin("rx", { idx: r.idx, session: r.session, name: r.name, opus: r.opus, last: r.last }); });
  radio.on("chat", (m) => { if (stack === radio) sendWin("chat", m); });
  radio.on("roster", (r) => { if (stack === radio) sendWin("roster", r); });
  radio.on("net-down", (r) => { if (stack === radio) sendWin("net-down", r); });
  radio.on("net-error", (r) => { if (stack === radio) sendWin("net-error", r); });
  /* helmet-cam signaling chunks, straight through to the renderer's codec */
  radio.on("signal", (s) => { if (stack === radio) sendWin("cam-signal", { actor: s.actor, from: s.from, message: s.message }); });
  /* ── control relink ──
     Tuned nets heal themselves in the renderer; the control connection is
     invisible there, so it heals here. Same shape as the renderer's backoff
     (4s, 8s, 16s, 32s, then capped at 60s, with jitter) and it stops the
     moment this stack is no longer the live one. Main-process timers are not
     throttled, so this keeps working while the operator is in-game. */
  const rootChannel = require("./config/22nd-package.json").rootChannel;
  let ctlTries = 0;
  const relinkControl = () => {
    if (stack !== radio) return;
    const wait = Math.min(60000, 4000 * Math.pow(2, Math.min(4, ctlTries++))) + Math.random() * 1500;
    setTimeout(async () => {
      if (stack !== radio) return;
      try { await radio.connectControl(rootChannel); ctlTries = 0; }
      catch (ignore) { relinkControl(); }
    }, wait);
  };
  radio.on("control-down", relinkControl);
  /* One silent control connection first: operators arrive tuned to nothing, but
     the ATC board and net editing still need a way to talk to the relay. */
  try {
    await radio.connectControl(rootChannel);
  } catch (e) {
    if (stack === radio) { try { radio.destroy(); } catch (ignore) {} stack = null; }
    return [{ ok: false, error: e.message }];
  }
  if (generation !== connectGeneration || stack !== radio)
    return [{ ok: false, error: "connection attempt superseded" }];

  /* ── pacing ──
     One tuned net is one TLS connection, so signing in with six nets is six
     connections from the same IP inside a fraction of a second. murmur counts
     connection ATTEMPTS per address (autobanAttempts/autobanTimeframe) and stops
     answering when the rate looks like an attack — which is where the
     "read ECONNRESET" and the rapid-reconnect message come from. A short stagger
     between nets keeps an ordinary sign-in well clear of that guard. */
  const results = [];
  let first = true;
  for (const n of nets) {
    if (!first) await new Promise(r => setTimeout(r, 140));
    first = false;
    if (generation !== connectGeneration) break;   /* superseded — stop dialling */
    try { results.push({ ok: true, idx: await radio.tune(n) }); }
    catch (e) { results.push({ ok: false, error: e.message, net: n.name }); }
  }
  if (generation !== connectGeneration || stack !== radio)
    return [{ ok: false, error: "connection attempt superseded" }];
  return results;
});
ipcMain.handle("tune", async (ev, net) => {
  if (!stack) return { ok: false, error: "not connected" };
  const input = net || {};
  const clean = { name: boundedText(input.name, 120), channel: boundedText(input.channel, 120), freq: boundedText(input.freq, 16) };
  if (!clean.name || !clean.channel) return { ok: false, error: "invalid net" };
  try { return { ok: true, idx: await stack.tune(clean) }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.on("detune", (ev, idx) => stack && stack.detune(boundedInt(idx, 0, 255, -1)));
ipcMain.on("tx-frame", (ev, frameInfo) => {
  if (!stack || !frameInfo) return;
  const frame = Buffer.from(frameInfo.frame || []);
  const idx = boundedInt(frameInfo.idx, 0, 255, -1);
  if (idx >= 0 && frame.length > 0 && frame.length <= 0x1fff) stack.txFrame(idx, frame, !!frameInfo.last, !!frameInfo.broadcast);
});
ipcMain.handle("listen-all", (ev, req) => {
  if (!stack) return { ok: false, error: "not connected" };
  const idx = boundedInt(req && req.idx, 0, 255, -1);
  const names = Array.isArray(req && req.names) ? req.names.slice(0, 64).map(n => boundedText(n, 120)).filter(Boolean) : [];
  if (idx < 0) return { ok: false, error: "invalid net" };
  if (!req.on) return { ok: true, listening: 0, dropped: stack.unlistenAll(idx) };
  const count = stack.listenAll(idx, names);
  return { ok: count > 0, listening: count, error: count ? "" : "no subnets found on the relay" };
});
ipcMain.handle("arm-broadcast", (ev, idx) => stack ? stack.armBroadcast(boundedInt(idx, 0, 255, -1)) : false);
ipcMain.on("net-mute", (ev, data) => {
  if (stack && data) stack.setMuted(boundedInt(data.idx, 0, 255, -1), !!data.muted);
});
ipcMain.on("send-text", (ev, data) => stack && data && stack.sendText(boundedInt(data.idx, 0, 255, -1), boundedText(data.message, 2000)));
ipcMain.handle("atc-view", () => stack ? stack.atcView() : []);
/* ── helmet cam ── */
ipcMain.handle("cam-peers", () => stack ? { peers: stack.camPeers(), limit: stack.signalLimit() } : { peers: [], limit: 5000 });
ipcMain.on("cam-signal", (ev, data) => {
  if (!stack || !data) return;
  const sessions = (Array.isArray(data.sessions) ? data.sessions : [data.sessions])
    .map(s => boundedInt(s, 0, 0xFFFFFFF, -1)).filter(s => s >= 0).slice(0, 64);
  const chunks = Array.isArray(data.chunks) ? data.chunks.slice(0, 12).map(c => boundedText(c, 4900)).filter(Boolean) : [];
  if (sessions.length && chunks.length) stack.sendSignal(sessions, chunks);
});
/* capture sources for the in-app picker — names + thumbnails only; the
   renderer opens the chosen one via the desktop-capture constraint */
ipcMain.handle("cam-sources", async () => {
  const sources = await desktopCapturer.getSources({ types: ["window", "screen"], thumbnailSize: { width: 240, height: 135 } });
  return sources.map(s => ({ id: s.id, name: String(s.name || "").slice(0, 80), thumb: s.thumbnail.toDataURL() }));
});
const NOSTACK = { ok: false, error: "not connected to the relay" };
ipcMain.handle("net-rename", (ev, data) => stack && data
  ? stack.renameNet(boundedText(data.net, 120), boundedText(data.name, 120)) : NOSTACK);
ipcMain.handle("net-move", (ev, data) => stack && data
  ? stack.moveNet(boundedText(data.net, 120), boundedText(data.parent, 120)) : NOSTACK);
ipcMain.handle("net-remove", (ev, net) => stack ? stack.removeNet(boundedText(net, 120)) : NOSTACK);
ipcMain.handle("net-meta", (ev, data) => stack && data
  ? stack.setNetMeta(boundedText(data.net, 120), { freq: boundedText(data.freq, 16), ship: !!data.ship }) : NOSTACK);
ipcMain.handle("create-net", async (ev, data) => {
  if (!stack) return { ok: false, error: "not connected" };
  const input = data || {};
  try { return Object.assign({ ok: true }, await stack.createNet(boundedText(input.name, 120),
    boundedText(input.rootChannel, 120), { freq: boundedText(input.freq, 16), ship: !!input.ship })); }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.on("disconnect", () => {
  connectGeneration++;
  if (stack) { stack.destroy(); stack = null; }
  /* An explicit disconnect is also a sign-out boundary.  Do not leave a
     bearer session or relay token available to a later renderer invocation. */
  acctToken = null; acctRelay = null; acctRole = null;
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
