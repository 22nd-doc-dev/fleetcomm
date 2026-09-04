"use strict";
/* FleetComm v0.5 renderer — command console. */
const bridge = window.fleetcomm;
if (!bridge) throw new Error("FleetComm preload bridge unavailable");
const ipcRenderer = bridge.ipc;
function reportRendererError(error) {
  const message = error && (error.message || error.reason && error.reason.message) || String(error || "unknown error");
  console.error("[fleetcomm] renderer error:", message);
  const output = document.getElementById("connErr");
  if (output) output.textContent = "FleetComm interface error: " + message;
}
window.addEventListener("error", event => reportRendererError(event.error || event.message));
window.addEventListener("unhandledrejection", event => reportRendererError(event.reason));
const webFrame = { setZoomFactor: factor => bridge.zoom.set(factor) };
const pkg = bridge.config;
class OpusScript {
  constructor(sampleRate, channels, application) { this.id = bridge.opus.create(sampleRate, channels, application); }
  encode(pcm, frameSize) { return bridge.opus.encode(this.id, exactBuffer(pcm), frameSize); }
  decode(frame) { return bridge.opus.decode(this.id, exactBuffer(frame)); }
  encoderCTL(request, value) { return bridge.opus.ctl(this.id, request, value); }
  delete() { bridge.opus.destroy(this.id); }
}
OpusScript.Application = bridge.opus.applications;
function exactBuffer(value) {
  if (value instanceof ArrayBuffer) return value;
  if (ArrayBuffer.isView(value)) return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
  throw new TypeError("expected binary audio data");
}
function pcm16(floatSamples) {
  const buffer = new ArrayBuffer(floatSamples.length * 2), view = new DataView(buffer);
  for (let i = 0; i < floatSamples.length; i++) {
    const sample = Math.max(-1, Math.min(1, floatSamples[i]));
    view.setInt16(i * 2, (sample * 32767) | 0, true);
  }
  return buffer;
}

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
};
const $ = (id) => document.getElementById(id);

/* ── persisted prefs ── */
let fx = store.get("fx", true), fxPreset = store.get("fxPreset", "standard");
/* the radio-voice dial: 0 clean · 50 standard · 100 heavy, continuous between.
   Pre-1.0.1 profiles have only fxPreset — seed the dial from it. */
let fxIntensity = Math.round(bridge.fxCurve.clamp01(
  store.get("fxIntensity", bridge.fxCurve.anchorValue(fxPreset)) / 100) * 100);
let themeMode = store.get("themeMode", "dark");
/* night-watch defaults — ink paper, bone text, gold accent, vermilion TX.
   These must track the [data-theme="dark"] stylesheet tokens or "RESET TO
   DARK DEFAULTS" hands back a palette that doesn't match the dark theme. */
const THEME_DEFAULTS = { bg: "#0C141C", panel: "#111E29", bez: "#090F16", ink: "#E7E0CD",
  muted: "#77828F", line: "#263039", accent: "#C9A96A", grn: "#5CA877", amber: "#CE7250", red: "#C0604A" };
let customTheme = Object.assign({}, THEME_DEFAULTS, store.get("customTheme", {}));
/* pre-1.0 builds persisted the full avionics palette on every launch, so the
   stored object shadows every new default. A profile still carrying the old
   defaults UNTOUCHED never chose them — hand it the night watch. */
{
  const pre10 = { bg: "#0b0f13", panel: "#11161b", bez: "#1c2126", ink: "#e8edf1",
    muted: "#8b979f", line: "#242b32", accent: "#4fd4e8", grn: "#49d17c", amber: "#ffb648", red: "#ff5a5a" };
  if (Object.keys(pre10).every(k => customTheme[k] === pre10[k])) {
    customTheme = Object.assign({}, THEME_DEFAULTS);
  }
}
let autoUpdate = store.get("autoUpdate", true);

/* ══ legibility ══
   Two separate levers, because they fix different problems: the typeface helps
   with character confusion at a glance, the scale helps when the type is simply
   too small for the screen you're on. Both persist, and the scale is applied
   with the frame zoom so every part of the board grows together — panels,
   spacing and controls, not just the text. */
let uiFont = store.get("uiFont", "legible");
let uiScale = Math.min(1.6, Math.max(0.8, Number(store.get("uiScale", 1)) || 1));
function applyFont() {
  document.documentElement.setAttribute("data-font", uiFont);
  const el = $("sfontsel"); if (el) el.value = uiFont;
  store.set("uiFont", uiFont);
}
function applyScale() {
  uiScale = Math.min(1.6, Math.max(0.8, uiScale));
  try { webFrame.setZoomFactor(uiScale); } catch (e) {}
  const el = $("scaleval"); if (el) el.textContent = Math.round(uiScale * 100) + "%";
  store.set("uiScale", uiScale);
}
function bumpScale(d) { uiScale = Math.round((uiScale + d) * 20) / 20; applyScale(); }
/* tagged nets can drop their name and stand on the badge alone — for a narrow
   channel column. Full names are the default; the truncated board keeps the
   full wire name in each row's tooltip. */
let nameTrunc = store.get("nameTrunc", false);
function applyNameTrunc() {
  document.documentElement.toggleAttribute("data-nettrunc", !!nameTrunc);
  const el = $("snametrunc"); if (el) el.classList.toggle("on", !!nameTrunc);
  store.set("nameTrunc", nameTrunc);
}
/* helmet-cam feeds wear faint scanlines by default — a field feed, not a
   stream. Pure CSS on a root attribute; SYS turns it off for clean video. */
let camScanFx = store.get("camScanFx", true);
function applyCamScanFx() {
  document.documentElement.toggleAttribute("data-camscan", !!camScanFx);
  const el = $("sscanfx"); if (el) el.classList.toggle("on", !!camScanFx);
  store.set("camScanFx", camScanFx);
}
let myCallsigns = store.get("callsigns", []);
let callsign = store.get("callsign", "");
/* declared up here because renderNets() and addLog() run at boot, long before the
   ACCOUNTS section that uses them — a later let/const would be a TDZ crash */
let alliedMode = null;                            /* { org, joint: Set<netName> } for an ALLIED account */
const sysLines = [];                              /* SETTINGS ▸ SYSTEM LOG ring (400) */
let cmdToken = store.get("cmdToken", "");
/* Relay back-off. One tuned net is one connection, so a sign-in is several
   connections at once; murmur's per-IP rate guard answers a burst by dropping
   it, which surfaces as ECONNRESET. Backing off is the cure — hammering is what
   keeps it angry. */
let connectFails = 0, holdTimer = null, lastHoldLog = 0, holdUntilTs = 0;
const fmtHold = (s) => s < 90 ? s + "s" : Math.floor(s / 60) + "m" + (s % 60 ? " " + (s % 60) + "s" : "");
/* BOTH connect buttons — the hold used to grab only the Discord-mode one,
   leaving legacy mode's visible button clickable straight through a hold */
const connBtns = () => [$("connectBtn"), $("connectLegacyBtn")].filter(Boolean);
function holdConnect(seconds, why) {
  /* never SHORTEN an active hold — the governor's dial-hold and this dial's
     own error can race, and the longer figure is the authoritative one */
  if (Date.now() + seconds * 1000 < holdUntilTs) return;
  clearInterval(holdTimer);
  let left = seconds;
  holdUntilTs = Date.now() + seconds * 1000;
  connBtns().forEach(b => { b.disabled = true; });
  /* say what is actually wrong — a relay that is DOWN got described as
     "rate-limiting" for years, which sent operators hunting the wrong problem
     (and once sent the maintainer chasing a ban during a planned restart) */
  const reason = why || "The relay is rate-limiting connections from your network. " +
    "Retrying is what keeps it tripped —";
  const tick = () => {
    $("connErr").textContent = reason + " holding for " + fmtHold(left) + ".";
    if (left-- <= 0) {
      clearInterval(holdTimer);
      holdUntilTs = 0;
      connBtns().forEach(b => { b.disabled = false; b.textContent = "CONNECT ▸"; });
      $("connErr").textContent = "Ready to try again.";
    }
  };
  tick();
  holdTimer = setInterval(tick, 1000);
}
let netPrefs = store.get("netPrefs", {});
/* one-time sweep: drop per-net keys older builds assigned on the operator's
   behalf, so nobody has to hunt down an F-key they never set */
if (!store.get("bindsCleared", false)) {
  Object.keys(netPrefs).forEach(k => { if (netPrefs[k]) netPrefs[k].bind = null; });
  store.set("netPrefs", netPrefs); store.set("bindsCleared", true);
} // freq -> {txOn, vol, pan, mon, bind, bcast}
let collapsed = store.get("collapsed", {}); // parent net name -> true
/* the operator's own arrangement of the board — names only, never sent anywhere */
let netOrder = store.get("netOrder", []);
/* No default talk key. Space was assigned out of the box, which meant an
   operator who never opened Settings was transmitting on whatever the game also
   uses for that key. Cycling stays on PgUp/PgDn — that's navigation, not a
   transmit key, and it can't put you on air by accident.
   The version suffix is bumped so existing installs drop the old Space bind. */
let masterBinds = store.get("masterBinds6", {
  active: null,
  cycUp: { src: "label", label: "PageUp" },
  cycDn: { src: "label", label: "PageDown" }
});

/* ── net model: flattened package with hierarchy ── */
let nets = [];   // {cfg, depth, parent, tuned, idx, mon, txOn, vol, pan, bind, roster:Map, speaking:Map, chat:[]}
/* a row-reorder drag is in flight (armed from the ⠿ grip — see the drag IIFE
   near the bottom). renderNets resets it: a full rebuild detaches the drag
   source, so its dragend never reaches the netlist delegate. pollOps skips
   tree re-syncs while it is true. */
let rowDragging = false;
let selectedI = 0, connected = false, openMic = false, override = false, micState = "none";
function buildNets() {
  nets = [];
  const add = (cfg, depth, parent) => {
    const p = netPrefs[cfg.freq] || {};
    const localCfg = Object.assign({}, cfg);
    nets.push({
      cfg: localCfg, depth, parent, tuned: false, idx: null,
      mon: p.mon !== undefined ? p.mon : true,
      txOn: !!p.txOn, vol: Math.max(0, Math.min(100, Number(p.vol !== undefined ? p.vol : 75) || 0)),
      pan: Math.max(-100, Math.min(100, Number(p.pan) || 0)),
      bind: p.bind || null, bcast: p.bcast || false,
      group: !!cfg.ship, lsnAll: p.lsnAll || false, txAll: p.txAll || false,
      roster: new Map(), speaking: new Map(), chat: [], tx: false
    });
    for (const child of cfg.subnets || []) add(child, depth + 1, cfg.name);
  };
  for (const n of pkg.nets) add(n, 0, null);
}
buildNets();
function savePrefs() {
  nets.forEach(n => { netPrefs[n.cfg.freq] = { txOn: n.txOn, vol: n.vol, pan: n.pan, mon: n.mon,
    bind: n.bind, bcast: n.bcast, lsnAll: n.lsnAll, txAll: n.txAll }; });
  store.set("netPrefs", netPrefs);
  store.set("collapsed", collapsed);
}
const sel = () => nets[selectedI];
const { buildTree, validParents, channelName, canReorder, reorder, mergeOrder } = bridge.netTree;
/* The display order is derived from parentage every render — see src/net-tree.js.
   `tree` is rebuilt by renderNets and read by anything that needs to know the
   shape of the board (PgUp/PgDn order, the parent dropdown, nest counts). */
let tree = { rows: [], kids: [], parentIdx: [], depth: [], roots: [] };
function netShapes() { return nets.map(n => ({ name: n.cfg.name, parent: n.parent })); }
function rebuildTree() {
  pruneCollapsed();
  tree = buildTree(netShapes(), collapsed, netOrder);
  nets.forEach((n, i) => {           /* keep the stored depth in step with the real one */
    n.depth = tree.depth[i];
    if (tree.parentIdx[i] === -1) n.parent = null;   /* an orphan really is top level now */
  });
  return tree;
}
const kidsOf = (name) => nets.filter(x => x.parent === name);
/* Every net aboard a ship: whatever the relay tree shows, plus anything the
   package declared, so LSN ALL works before the subnets have ever been tuned. */
function subnetNamesOf(n) {
  const fromTree = kidsOf(n.cfg.name).map(x => x.cfg.name);
  const fromCfg = (n.cfg.subnets || []).map(x => (typeof x === "string" ? x : x.name)).filter(Boolean);
  return [...new Set(fromTree.concat(fromCfg))];
}
const isParent = (n) => {
  const i = nets.indexOf(n);
  return (i >= 0 && tree.kids[i] && tree.kids[i].length > 0) || (n.cfg.subnets || []).length > 0;
};
const isShip = (n) => !!n.cfg.ship;

/* ══ color helpers + theme engine ══ */
function hexRgb(h) { h = h.replace("#", ""); return [parseInt(h.slice(0,2),16), parseInt(h.slice(2,4),16), parseInt(h.slice(4,6),16)]; }
function mixHex(h1, h2, t) { const a = hexRgb(h1), b = hexRgb(h2); return "rgb(" + a.map((v,i) => Math.round(v + (b[i]-v)*t)).join(",") + ")"; }
function rgbaHex(h, al) { return "rgba(" + hexRgb(h).join(",") + "," + al + ")"; }
/* Read a live CSS custom property as #rrggbb.
   The window controls are painted by Windows from colors we hand it, so they
   have to come from the palette that is ACTUALLY applied — not a copy. They
   were hardcoded to the pre-0.6 palette (#0c1b23 / #e9eff4) while the bezel had
   moved to #1c2126, which is why the minimise/maximise/close buttons sat in a
   slightly different colour to the header right beside them. */
function cssHex(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  if (/^#[0-9a-f]{6}$/i.test(v)) return v.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(v)) return "#" + v.slice(1).split("").map(c => c + c).join("").toLowerCase();
  const m = v.match(/^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i);
  if (m) return "#" + [1, 2, 3].map(i => Number(m[i]).toString(16).padStart(2, "0")).join("");
  return fallback;
}
function luminance(h) { const [r,g,b] = hexRgb(h); return (0.299*r + 0.587*g + 0.114*b) / 255; }
let dark = themeMode !== "light";
function applyTheme() {
  const r = document.documentElement;
  /* clear EVERY var custom mode can set, or switching back to night/day
     leaves the bezel and status colors stuck on the old custom palette */
  ["--bg","--panel","--tint","--bez","--bez2","--bezline","--line","--line2","--ink","--muted",
   "--holo","--holo-bright","--holo-tint","--grn","--grn-tint","--amber","--amber-tint",
   "--tx","--tx-tint","--ok","--ok-tint","--red","--red-tint","--grid","--lamp-off","--sel-ink"]
    .forEach(k => r.style.removeProperty(k));
  let msg;
  if (themeMode === "custom") {
    const t = customTheme;
    dark = luminance(t.bg) < 0.5;
    r.setAttribute("data-theme", dark ? "dark" : "light");
    const set = (k, v) => r.style.setProperty(k, v);
    set("--bg", t.bg); set("--panel", t.panel);
    set("--bez", t.bez); set("--bez2", mixHex(t.bez, t.ink, 0.06)); set("--bezline", mixHex(t.bez, t.ink, 0.22));
    set("--tint", mixHex(t.panel, t.bg, 0.5));
    set("--line", t.line); set("--line2", mixHex(t.line, t.ink, 0.22));
    set("--ink", t.ink); set("--muted", t.muted);
    set("--holo", t.accent); set("--holo-bright", t.accent); set("--holo-tint", rgbaHex(t.accent, 0.14));
    set("--grn", t.grn); set("--grn-tint", rgbaHex(t.grn, 0.13));
    set("--amber", t.amber); set("--amber-tint", rgbaHex(t.amber, 0.13));
    set("--tx", t.amber); set("--tx-tint", rgbaHex(t.amber, 0.13));
    set("--ok", t.grn); set("--ok-tint", rgbaHex(t.grn, 0.12));
    set("--red", t.red); set("--red-tint", rgbaHex(t.red, 0.14));
    set("--lamp-off", mixHex(t.panel, t.ink, 0.2));
    /* selection ink must contrast the ACCENT it sits on, not the theme —
       a dark custom accent needs bone text, a light one needs ink */
    set("--sel-ink", luminance(t.accent) < 0.5 ? "#F2EDE0" : "#16222C");
    msg = { dark, bg: cssHex("--bez", t.bez), ink: cssHex("--ink", t.ink),
      palette: { panelRGB: hexRgb(t.panel).join(","), ink: t.ink, muted: t.muted, accent: t.grn, accentRGB: hexRgb(t.grn).join(",") } };
  } else {
    dark = themeMode === "dark";
    r.setAttribute("data-theme", dark ? "dark" : "light");
    /* take the bezel and text colours from the stylesheet that just applied, so
       the window controls always match the header they sit in */
    msg = { dark, bg: cssHex("--bez", dark ? "#090F16" : "#EAE3D1"),
            ink: cssHex("--ink", dark ? "#E7E0CD" : "#16222C"), palette: null };
  }
  store.set("themeMode", themeMode); store.set("customTheme", customTheme);
  $("sthemesel").value = themeMode;
  $("customcolors").style.display = themeMode === "custom" ? "flex" : "none";
  Object.keys(THEME_DEFAULTS).forEach(k => { const el = $("c_" + k); if (el) el.value = customTheme[k]; });
  ipcRenderer.send("theme", msg);
}

/* ══ keybind engine (global hook first, DOM fallback) ══ */
const MODS = ["ALT", "CTRL", "SHIFT", "META"];
function normMod(label) {
  const l = String(label).toUpperCase();
  if (l.startsWith("ALT")) return "ALT";
  if (l.startsWith("CTRL") || l.startsWith("CONTROL")) return "CTRL";
  if (l.startsWith("SHIFT")) return "SHIFT";
  if (l.startsWith("META") || l.startsWith("CMD") || l.startsWith("OS")) return "META";
  return null;
}
const heldMods = new Set();
let gActive = false, capturing = null; // {kind:'net',i}|{kind:'master',which}
function modsEqual(a, b) { return a.length === b.length && a.every(m => b.includes(m)); }
function bindLabel(mods, label) { return (mods.length ? mods.join("+") + "+" : "") + label; }
function matchDown(b, src, code, label, mods) {
  if (!b) return false;
  if (b.src === "label") return b.label === label && mods.length === 0;
  return b.src === src && b.code === code && modsEqual(b.mods || [], mods);
}
function matchUp(b, src, code, label) {
  if (!b) return false;
  if (b.src === "label") return b.label === label;
  return b.src === src && b.code === code;
}
/* Resolve the captured net AT WRITE TIME by name — a raw index taken at click
   time goes stale the moment anything reindexes nets[] (another COMMAND
   account deleting a net used to make the next keypress bind the WRONG net,
   or throw and leave capture armed forever, eating every key including PTT). */
function captureTarget() {
  return capturing.kind === "net" ? nets.find(x => x.cfg.name === capturing.name) : null;
}
function finishCapture(src, code, label, mods) {
  const bind = { src, code, label: bindLabel(mods, label), mods };
  if (capturing.kind === "net") {
    const t = captureTarget();
    if (t) { t.bind = bind; savePrefs(); } else toast("That net left the board — key not bound.");
  } else { masterBinds[capturing.which] = bind; store.set("masterBinds6", masterBinds); }
  capturing = null; renderNets(); renderMasterBinds();
  tut.armed = false; tutEvent("bound");
}
/* Exit capture without binding: keep=false writes null ("unbound") through the
   same two storage paths finishCapture uses; keep=true just walks away.
   null is already a first-class bind value everywhere downstream — matchDown/
   matchUp refuse it, cards render "KEY", masters render "set key". */
function abortCapture(keep) {
  if (!keep) {
    if (capturing.kind === "net") {
      const t = captureTarget();
      if (t) { t.bind = null; savePrefs(); }
    } else { masterBinds[capturing.which] = null; store.set("masterBinds6", masterBinds); }
  }
  capturing = null; renderNets(); renderMasterBinds();
}
function onKeyDown(src, code, label, mods) {
  if (capturing) {
    /* Two ways out before anything binds — labels are identical on the
       uiohook and DOM paths (verified against UiohookKey): ESC cancels and
       keeps the old key, BACKSPACE or DELETE sets the action to UNBOUND.
       Command's ask: cycle-selected-net must be clearable. Plain keys only,
       so CTRL+BACKSPACE etc. still capture as a combo. */
    if (!mods.length && label === "Escape") { abortCapture(true); return; }
    if (!mods.length && (label === "Backspace" || label === "Delete" || label === "NumpadDelete")) { abortCapture(false); return; }
    finishCapture(src, code, label, mods); return;
  }
  /* typing must never transmit — but that guard is for KEYBOARDS. A flight
     stick button can't put characters in a text field, and an operator typing
     in chat mid-op still expects stick PTT to key the net. */
  if (src !== "pad" && document.activeElement && /INPUT|TEXTAREA/.test(document.activeElement.tagName)) return;
  if (matchDown(masterBinds.cycUp, src, code, label, mods)) { cycleSel(-1); return; }
  if (matchDown(masterBinds.cycDn, src, code, label, mods)) { cycleSel(1); return; }
  if (matchDown(masterBinds.active, src, code, label, mods)) { pttAll(true); return; }
  nets.forEach((n, i) => {
    if (!matchDown(n.bind, src, code, label, mods)) return;
    if (n.tuned) requestTX(i, "bind");
    else bindDormant(n);
  });
}
/* a key bound to a net that isn't tuned does nothing — say so, once, rather
   than let the operator wonder which net (if any) just heard them */
const dormantSaid = new Map();
const netLabel = (n) => (n.cfg.tag ? n.cfg.tag + " " : "") + (n.cfg.display || n.cfg.name);
function bindDormant(n) {
  const last = dormantSaid.get(n.cfg.name) || 0;
  if (Date.now() - last < 5000) return;
  dormantSaid.set(n.cfg.name, Date.now());
  toast(netLabel(n) + " is not tuned — its key is idle. TUNE it first.");
}
function onKeyUp(src, code, label) {
  if (matchUp(masterBinds.active, src, code, label)) pttAll(false);
  nets.forEach((n, i) => { if (matchUp(n.bind, src, code, label)) releaseTX(i, "bind"); });
}
/* the OS auto-repeats a held key and the hook faithfully relays every repeat —
   the DOM path drops them via e.repeat, this one has to remember what is down,
   or a PageUp held a beat too long cycles two or three nets */
const gHeld = new Set();
function onGKey(k) {
  gActive = true;
  const hk = k.type + ":" + k.code;
  if (k.down) { if (gHeld.has(hk)) return; gHeld.add(hk); } else gHeld.delete(hk);
  const mod = normMod(k.label);
  if (mod) { k.down ? heldMods.add(mod) : heldMods.delete(mod); if (capturing) return; }
  if (k.down && !mod) onKeyDown("g", hk, k.label, [...heldMods]);
  if (!k.down && !mod) onKeyUp("g", hk, k.label);
}
ipcRenderer.on("gkey", (ev, k) => onGKey(k));
window.addEventListener("keydown", (e) => {
  if (e.repeat) return;
  if (gActive) { if (e.key === "PageUp" || e.key === "PageDown" || (e.code === "Space" && !/INPUT|TEXTAREA/.test(document.activeElement.tagName))) e.preventDefault(); return; }
  const mods = MODS.filter(m => ({ ALT: e.altKey, CTRL: e.ctrlKey, SHIFT: e.shiftKey, META: e.metaKey })[m]);
  if (normMod(e.key)) return;
  if (capturing) e.preventDefault();
  onKeyDown("dom", e.code, e.code.replace(/^Key|^Digit/, ""), mods);
});
window.addEventListener("keyup", (e) => { if (!gActive) onKeyUp("dom", e.code, e.code.replace(/^Key|^Digit/, "")); });

/* ── gamepad / flight stick binds ──
   HOTAS and gamepad buttons never reach the keyboard hook — a stick PTT that
   worked in QLink did nothing here. The Gamepad API sees them, so poll it at
   ~60Hz and feed button transitions into the SAME bind engine as keys: press
   a stick button while capturing and it binds; hold it and it keys the net.
   Analog triggers count past 60%. Main disables occlusion backgrounding so
   sampling keeps running while the game has focus — the whole point. */
const padStates = new Map();   /* padKey -> pressed-state array */
const padAnnounced = new Set();
let padBgSeen = false;
function pollPads(padsOverride) {
  let pads;
  try { pads = padsOverride || (navigator.getGamepads ? navigator.getGamepads() : []); }
  catch (e) { return; }
  const seen = new Set();
  for (const gp of pads) {
    if (!gp) continue;
    const key = bridge.padBinds.padKey(gp.id);
    seen.add(key);
    if (!padAnnounced.has(key)) {
      padAnnounced.add(key);
      addLog("sys", "", "controller detected — " + key + " (" + (gp.buttons || []).length +
        " buttons; bind them like keys: click any KEY control, then press the button — " +
        "the press that woke the controller is its baseline, press again)" +
        (document.hasFocus() ? "" : " [window unfocused]"));
      console.log("[pad] detected " + JSON.stringify(gp.id) + " key=" + key + " buttons=" + (gp.buttons || []).length +
        " axes=" + (gp.axes || []).length + " mapping=" + gp.mapping + " focus=" + document.hasFocus());
    }
    /* GamepadButton is a host object: pressed/value are PROTOTYPE getters, and
       contextBridge copies own properties only — so gp.buttons crossed into
       the preload world as a list of empty objects and pressedStates() saw
       every real stick as all-false, forever. (The rig's plain-object fake pad
       survived the bridge, which is why the test was green while Oak's stick
       did nothing.) Unwrap to plain values on THIS side of the bridge. */
    const plainButtons = Array.from(gp.buttons || [], b => ({ pressed: !!(b && b.pressed), value: (b && +b.value) || 0 }));
    const curr = bridge.padBinds.pressedStates(plainButtons);
    const events = bridge.padBinds.diffButtons(padStates.get(key), curr);
    padStates.set(key, curr);
    /* --enable-logging trace of every transition: the only way to see what a
       stick actually reports when the operator is at the desk and I am not */
    if (bridge.autotestHost) {
      for (const ev of events) console.log("[pad] " + key + " b" + ev.button + (ev.down ? " DOWN" : " up") + " focus=" + document.hasFocus() + " capturing=" + !!capturing);
      /* raw dump whenever ANY reported value moves — the VelocityOne showed
         32 buttons and 10 axes and never a transition, so see what a press
         actually changes (rate-limited per pad) */
      const sig = (gp.buttons || []).map(b => (b.value || (b.pressed ? 1 : 0)).toFixed(1)).join("") + "|" +
        (gp.axes || []).map(a => a.toFixed(1)).join(",");
      const rawKey = "raw:" + key, last = padStates.get(rawKey);
      if (last && last.sig !== sig && Date.now() - last.at > 100) {
        console.log("[pad] raw " + key + " btn=[" + (gp.buttons || []).map((b, j) => (b.pressed || b.value > 0.3) ? j + ":" + (b.value || 1).toFixed(1) : "").filter(Boolean).join(" ") +
          "] axes=[" + (gp.axes || []).map(a => a.toFixed(2)).join(",") + "] ts=" + Math.round(gp.timestamp || 0));
        padStates.set(rawKey, { sig, at: Date.now() });
      } else if (!last) padStates.set(rawKey, { sig, at: 0 });
    }
    /* diagnostic for the in-game failure: Chromium's per-backend focus rules
       decide whether stick input still flows while the game has focus, and it
       differs BY DEVICE. This line appearing in an operator's log proves
       background delivery works on their rig; binds pressed in game with no
       line means the focus gate ate them. */
    if (!padBgSeen && events.length && !document.hasFocus()) {
      padBgSeen = true;
      addLog("sys", "", "stick input received while another window has focus — background delivery works for " + key);
    }
    for (const ev of events) {
      const code = key + "#b" + ev.button;
      const label = bridge.padBinds.padLabel(gp.id, ev.button);
      if (ev.down) onKeyDown("pad", code, label, []);
      else onKeyUp("pad", code, label);
    }
  }
  /* a stick unplugged (or dropped by Chromium) mid-press must release what it
     held, or PTT wedges open — the module always supported it, the loop never
     asked */
  if (!padsOverride) for (const [key, prev] of padStates) {
    if (key.startsWith("raw:") || seen.has(key)) continue;
    for (const ev of bridge.padBinds.diffButtons(prev, [])) onKeyUp("pad", key + "#b" + ev.button, bridge.padBinds.padLabel(key, ev.button));
    padStates.delete(key);
  }
}
setInterval(pollPads, 16);
window.addEventListener("gamepadconnected", () => pollPads());

/* ══ AUDIO ══ */
let ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });   /* replaceable: see rebuildAudioEngine() */
/* ── master busses ──
   Two independent levels in the header: VOICE scales everything the nets play
   locally (every RX chain, chirps, squelch tails — one gain node they all
   route through), 1MC scales how loud clips are piped — both what the fleet
   hears and the sender's own monitor. Per-net volume knobs still do their job
   underneath; these are the room-level trims. */
let masterGain = ctx.createGain();
masterGain.connect(ctx.destination);
let masterVol = Math.max(0, Math.min(150, Number(store.get("masterVol", 100)) || 100));
/* 1MC clips at 100% flattened the stress test — everyone starts at 35 now.
   New store key on purpose: applyMasterVols() wrote the old default back on
   every launch, so "never touched" and "chose 100" are indistinguishable. */
let sbVol = Math.max(0, Math.min(150, Number(store.get("sbVol2", 35)) || 0));
function applyMasterVols() {
  masterGain.gain.value = masterVol / 100;
  $("masterVolSl").value = masterVol; $("masterVolVal").textContent = masterVol + "%";
  $("sbVolSl").value = sbVol; $("sbVolVal").textContent = sbVol + "%";
  store.set("masterVol", masterVol); store.set("sbVol2", sbVol);
}
$("masterVolSl").addEventListener("input", function () { masterVol = +this.value; applyMasterVols(); });
$("sbVolSl").addEventListener("input", function () { sbVol = +this.value; applyMasterVols(); });
applyMasterVols();
const FRAME = 960;
let capNode = null, capStream = null, txSet = new Set(), txEndPending = new Set(), bcastIdx = new Set();
const encoder = new OpusScript(48000, 1, OpusScript.Application.VOIP);
try { encoder.encoderCTL(4002, 40000); } catch (e) {}
/* ── audio devices ──
   Operators run headsets, stream decks and virtual cables; "whatever the OS
   picked" is not good enough when the wrong choice means transmitting desktop
   audio or hearing the net through speakers the mic can pick up. Both
   selections persist and the mic is re-opened in place when changed. */
let micDevice = store.get("micDevice", "");
/* transmit gate threshold (RMS 0..1) and its hold counter; 0 disables the gate */
let micGate = Math.max(0, Math.min(0.2, Number(store.get("micGate", 0.012)) || 0));
let gateHold = 0, aecOn = true;
let outDevice = store.get("outDevice", "");
async function listAudioDevices() {
  let devices = [];
  try { devices = await navigator.mediaDevices.enumerateDevices(); } catch (e) { return; }
  const fill = (el, kind, chosen) => {
    const opts = ['<option value="">System default</option>'];
    devices.filter(d => d.kind === kind).forEach((d, i) => {
      /* labels are blank until mic permission is granted at least once */
      const name = d.label || (kind === "audioinput" ? "Input " : "Output ") + (i + 1);
      opts.push('<option value="' + escAttr(d.deviceId) + '">' + esc(name) + "</option>");
    });
    el.innerHTML = opts.join("");
    el.value = devices.some(d => d.deviceId === chosen) ? chosen : "";
  };
  fill($("micSel"), "audioinput", micDevice);
  fill($("outSel"), "audiooutput", outDevice);
}
async function applyOutputDevice() {
  /* Only ever re-route when the operator has actually PICKED a device.
     Calling setSinkId("") re-creates the output stream even though nothing
     changed, and Chromium's echo canceller pairs the capture stream with a
     known render device — re-routing after the mic is open leaves it without a
     reference, and the room comes straight back down the net as echo. */
  if (!outDevice) return;
  try {
    if (typeof ctx.setSinkId === "function") await ctx.setSinkId(outDevice);
  } catch (e) { toast("Couldn't switch output device: " + e.message); }
}
/* the slider is 0-60 on a curve, so the useful low end has real resolution */
const gateToSlider = (g) => Math.round(Math.sqrt(Math.max(0, g) / 0.06) * 60);
const sliderToGate = (v) => (v <= 0 ? 0 : Math.pow(v / 60, 2) * 0.06);
function renderGate() {
  $("micGateSl").value = String(gateToSlider(micGate));
  $("micGateVal").textContent = micGate <= 0 ? "off" : Math.round(micGate * 1000) / 10 + "%";
  $("gateHint").classList.toggle("warn", micGate <= 0);
  $("gateHint").textContent = micGate <= 0
    ? "Gate off — everything your microphone hears goes out, including your speakers."
    : "Below this level nothing is sent, so the room and your speakers don't ride out over the net";
  $("outHint").classList.toggle("warn", !aecOn);
  if (!aecOn) $("outHint").textContent =
    "This microphone reports no echo cancellation — on speakers, everyone else will hear themselves. Use a headset.";
}
$("micGateSl").addEventListener("input", function () {
  micGate = sliderToGate(Number(this.value)); store.set("micGate", micGate); renderGate();
});
$("micSel").addEventListener("change", async function () {
  micDevice = this.value; store.set("micDevice", micDevice);
  if (capNode) {                       /* re-open the mic on the new device */
    try { capNode.disconnect(); } catch (e) {}
    capNode = null;
    if (await ensureMic()) toast("Microphone switched.");
    else toast("Couldn't open that microphone — falling back to the default.");
  } else toast("Microphone set — it opens on your next transmission.");
});
$("outSel").addEventListener("change", async function () {
  outDevice = this.value; store.set("outDevice", outDevice);
  await applyOutputDevice();
  toast("Output device set.");
});
try { navigator.mediaDevices.addEventListener("devicechange", listAudioDevices); } catch (e) {}

async function ensureMic() {
  if (capNode) return true;
  /* PTT down and the mic button can land on the same tick, both passing the
     capNode check above — the loser of that race opened a second stream and
     re-added the worklet module, which throws on the duplicate processor name
     and reported the microphone as unavailable. Share one attempt instead. */
  if (ensureMic.inflight) return ensureMic.inflight;
  ensureMic.inflight = openMicOnce();
  try { return await ensureMic.inflight; } finally { ensureMic.inflight = null; }
}
async function openMicOnce() {
  try {
    const audioReq = { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    if (micDevice) audioReq.deviceId = { exact: micDevice };
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: audioReq }); }
    catch (e) {
      if (!micDevice) throw e;
      /* the saved device may be unplugged — don't leave the operator mute */
      delete audioReq.deviceId;
      stream = await navigator.mediaDevices.getUserMedia({ audio: audioReq });
      toast("Saved microphone unavailable — using the system default.");
    }
    /* a device switch replaces the stream — stop the old one or the previous
       microphone stays held open for the rest of the session */
    if (capStream) { try { capStream.getTracks().forEach(t => t.stop()); } catch (e) {} }
    capStream = stream;
    listAudioDevices();          /* labels are only readable once permission is granted */
    if (outDevice) applyOutputDevice();
    /* Report whether the browser actually granted echo cancellation. When it
       didn't — some USB interfaces and virtual cables simply don't offer it —
       the operator needs to know, because on speakers that is audible echo for
       everyone else on the net, not for them. */
    try {
      const t = stream.getAudioTracks()[0], st = t && t.getSettings ? t.getSettings() : {};
      aecOn = st.echoCancellation !== false;
      if (!aecOn) addLog("sys", "", "echo cancellation unavailable on this microphone — use a headset");
      /* the field report "laggy and doubled on first launch, fine after a
         restart" needs the engine's state on record: this line is what to
         quote next time */
      if (ctx.state !== "running") { try { ctx.resume(); } catch (e2) {} }
      addLog("sys", "", "mic open — " + (aecOn ? "echo cancel on" : "NO echo cancel") + ", " +
        (st.sampleRate || "?") + " Hz capture, engine " + ctx.state + " @ " + ctx.sampleRate + " Hz, output latency " +
        Math.round((ctx.outputLatency || ctx.baseLatency || 0) * 1000) + " ms");
    } catch (e) { aecOn = true; }
    renderMic(); renderGate();
    const src = ctx.createMediaStreamSource(stream);
    const workletCode = `class Cap extends AudioWorkletProcessor{
      constructor(){super();this.buf=new Float32Array(${FRAME});this.n=0;}
      process(inputs){const ch=inputs[0][0];if(!ch)return true;let i=0;
        while(i<ch.length){const t=Math.min(${FRAME}-this.n,ch.length-i);
          this.buf.set(ch.subarray(i,i+t),this.n);this.n+=t;i+=t;
          if(this.n===${FRAME}){this.port.postMessage(this.buf.slice(0));this.n=0;}}
        return true;}}
      registerProcessor("cap",Cap);`;
    /* registerProcessor throws on a duplicate name, so the module can only be
       added to this ctx ONCE — re-adding it on a device switch made every mic
       switch fail with "Couldn't open that microphone". */
    if (!ensureMic.workletLoaded) {
      const workletUrl = URL.createObjectURL(new Blob([workletCode], { type: "application/javascript" }));
      try { await ctx.audioWorklet.addModule(workletUrl); } finally { URL.revokeObjectURL(workletUrl); }
      ensureMic.workletLoaded = true;
    }
    capNode = new AudioWorkletNode(ctx, "cap");
    src.connect(capNode);
    const silent = ctx.createGain(); silent.gain.value = 0;
    capNode.connect(silent); silent.connect(ctx.destination); // keep the pull-based worklet graph alive without monitoring the mic
    capNode.port.onmessage = (ev) => {
      if (txSet.size === 0 && txEndPending.size === 0) return;
      const f32 = ev.data;
      /* ── transmit gate ──
         Below the threshold we send silence rather than the room. Echo
         cancellation only ever gets you most of the way there, and what leaks
         through is exactly this: quiet speaker bleed, riding out over the net
         under everyone else's voice. Fast to open so word onsets survive, slow
         to close so word endings do. */
      let sum = 0;
      for (let i = 0; i < f32.length; i++) sum += f32[i] * f32[i];
      const rms = Math.sqrt(sum / f32.length);
      if (rms >= micGate) gateHold = 12;              /* ~240 ms of hold */
      else if (gateHold > 0) gateHold--;
      const open = micGate <= 0 || gateHold > 0;
      if (!open) f32.fill(0);
      const i16 = pcm16(f32);
      let opus; try { opus = encoder.encode(i16, FRAME); } catch (e) { return; }
      for (const idx of txSet) ipcRenderer.send("tx-frame", { idx, frame: opus, last: false, broadcast: bcastIdx.has(idx) });
      for (const idx of txEndPending) { ipcRenderer.send("tx-frame", { idx, frame: opus, last: true, broadcast: bcastIdx.has(idx) }); txEndPending.delete(idx); }
    };
    micState = "ok"; renderMic(); return true;
  } catch (e) { micState = "denied"; renderMic(); toast("Microphone unavailable: " + e.message); return false; }
}
/* Preset parameter values live in src/fx-curve.js now — the presets are
   anchors at 0/50/100 on the fxIntensity dial and the module guarantees the
   anchor sound is bit-identical to the old FXP table. */
function fxP() { return bridge.fxCurve.paramsAt(fxIntensity / 100); }
let noiseBuf = null;
function getNoiseBuf() {
  if (noiseBuf) return noiseBuf;
  noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return noiseBuf;
}
function shaperCurve(drive) {
  const k = drive * 30, n = 512, c = new Float32Array(n);
  for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; c[i] = ((1 + k) * x) / (1 + k * Math.abs(x)); }
  return c;
}
function makeChain(n) {
  n.gainNode = ctx.createGain(); n.gainNode.gain.value = n.vol / 100;
  n.panNode = ctx.createStereoPanner(); n.panNode.pan.value = n.pan / 100;
  wireChain(n);
}
function wireChain(n) {
  (n.fxNodes || []).forEach(x => { try { x.disconnect(); } catch (e) {} });
  [n.gainNode, n.panNode].forEach(x => { try { x.disconnect(); } catch (e) {} });
  if (n.noiseSrc) { try { n.noiseSrc.stop(); } catch (e) {} n.noiseSrc = null; }
  const p = fxP(), nodes = [];
  let head = n.gainNode;
  for (let i = 0; i < p.stages; i++) { const hp = ctx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = p.hp; hp.Q.value = 0.7; head.connect(hp); nodes.push(hp); head = hp; }
  for (let i = 0; i < p.stages; i++) { const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = p.lp; lp.Q.value = 0.7; head.connect(lp); nodes.push(lp); head = lp; }
  if (p.drive > 0) { const ws = ctx.createWaveShaper(); ws.curve = shaperCurve(p.drive); ws.oversample = "2x"; head.connect(ws); nodes.push(ws); head = ws; }
  if (p.comp) { const cp = ctx.createDynamicsCompressor(); cp.threshold.value = p.comp.th; cp.ratio.value = p.comp.ratio; cp.attack.value = p.comp.atk; cp.release.value = p.comp.rel; cp.knee.value = 4; head.connect(cp); nodes.push(cp); head = cp; }
  head.connect(n.panNode); n.panNode.connect(masterGain);
  n.noiseGain = ctx.createGain(); n.noiseGain.gain.value = 0;
  if (p.noise > 0) { const src = ctx.createBufferSource(); src.buffer = getNoiseBuf(); src.loop = true; src.connect(n.noiseGain); n.noiseGain.connect(n.panNode); src.start(); n.noiseSrc = src; nodes.push(n.noiseGain); }
  n.fxNodes = nodes;
}
function squelchTail(n) {
  const p = fxP();
  if (!p.tail || !fx) return;
  try {
    const src = ctx.createBufferSource(); src.buffer = getNoiseBuf();
    const g = ctx.createGain(); const t = ctx.currentTime;
    g.gain.setValueAtTime(p.tail, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    src.connect(g); g.connect(n.panNode); src.start(t, Math.random(), 0.1);
  } catch (e) {}
}
const decoders = new Map();
function playFrame(n, session, opusBuf) {
  const key = n.cfg.freq + ":" + session;
  let d = decoders.get(key);
  if (!d) { d = { dec: new OpusScript(48000, 1), cursor: 0, lastUsed: 0 }; decoders.set(key, d); }
  d.lastUsed = Date.now();
  let pcm; try { pcm = d.dec.decode(opusBuf); } catch (e) { return; }
  const cnt = pcm.byteLength / 2, ab = ctx.createBuffer(1, cnt, 48000), chd = ab.getChannelData(0);
  const view = new DataView(pcm);
  for (let i = 0; i < cnt; i++) chd[i] = view.getInt16(i * 2, true) / 32768;
  const src = ctx.createBufferSource(); src.buffer = ab; src.connect(n.gainNode);
  /* a context that isn't running never advances currentTime: frames would
     queue at a frozen cursor and all fire at once when it wakes */
  if (ctx.state !== "running") { try { ctx.resume(); } catch (e) {} }
  d.cursor = Math.max(ctx.currentTime + 0.06, d.cursor);
  /* BACKLOG POLICY — never move the cursor BACKWARDS. The old reset put new
     frames underneath audio already scheduled, and the net played over itself
     — the field's "rrraaadio check overlaying itself" on a busy first launch.
     Past 750 ms of backlog, drop THIS frame: what is queued plays out clean,
     the delay stays bounded, a syllable is lost instead of the transmission. */
  if (d.cursor > ctx.currentTime + 0.75) { d.dropped = (d.dropped || 0) + 1; audioDrops++; return; }
  src.start(d.cursor); d.cursor += cnt / 48000;
}
let audioDrops = 0, audioHeals = 0;
/* ── audio-clock watchdog ──
   currentTime is frames RENDERED ÷ sample rate, and the output device is what
   pulls the frames — so the context clock tracks wall time exactly as long as
   the output stream was opened for the format the device actually runs. The
   2026-09-03 field log settled what "first-launch garble" is: the clock ran
   at a FLAT 65% of wall time for an hour (~2/3 — a 32 kHz device consuming
   audio rendered for 48 kHz), which is a stale stream format, not a busy
   machine (starvation is erratic, never a flat ratio). A headset that changes
   format underneath a running stream — Bluetooth dropping to its headset
   profile when the mic opens — is the classic. Voice stretches
   ("rrraaadio check"), frames arrive faster than they play, the backlog
   drops syllables; a relaunch fixed it because a fresh stream negotiates the
   device's CURRENT format. The heal does exactly that without the relaunch:
   route the context to the silent sink and back, which forces the output
   stream to be re-created (setSinkId to the SAME sink is a spec no-op). */
const clockWatch = { t: performance.now(), c: ctx.currentTime, drops: 0, off: 0, ok: 0, healed: 0, lastHeal: 0, said: 0, saidDrops: 0, ailing: false };
function audioClockSample(audioMs, wallMs) {
  const ratio = audioMs / wallMs, pct = Math.round(ratio * 100);
  const off = ctx.state === "running" && (ratio < 0.85 || ratio > 1.15);
  if (!off) {
    clockWatch.off = 0;
    if (clockWatch.ailing && ++clockWatch.ok >= 3) {
      clockWatch.ailing = false; clockWatch.healed = 0;
      addLog("sys", "", "audio engine clock back on rate (" + pct + "%)");
    }
    return null;
  }
  clockWatch.ok = 0;
  if (++clockWatch.off < 3) return null;          /* three flat seconds, not one hiccup */
  const now = Date.now();
  if (!clockWatch.ailing) {
    clockWatch.ailing = true;
    addLog("sys", "", "audio engine clock off rate \u2014 advanced " + Math.round(audioMs) + " ms in " + Math.round(wallMs) + " ms (" + pct + "%): the output device is taking audio " +
      (ratio < 1 ? "slower" : "faster") + " than the engine renders it, so voice sounds " + (ratio < 1 ? "stretched" : "rushed") +
      " (a headset that changed format \u2014 Bluetooth switching to its headset profile is the classic) \u2014 re-opening the output");
  }
  if (clockWatch.healed >= 4) {
    if (now - clockWatch.said > 300000) {
      clockWatch.said = now;
      addLog("sys", "", "audio engine clock still off rate (" + pct + "%) after re-opening the output and rebuilding the engine \u2014 restart FleetComm; if it comes back, set the output device to 48000 Hz in Windows sound settings and say which headset");
    }
    return null;
  }
  if (now - clockWatch.lastHeal < 20000) return null;
  clockWatch.lastHeal = now; clockWatch.healed++; clockWatch.off = 0;
  /* first try the cheap detour (a new output stream, no silence); if the
     clock is still off after that, the device parameters Chromium holds are
     stale and only a NEW engine re-asks the device — rebuild */
  return clockWatch.healed === 1 ? healAudioClock(pct) : rebuildAudioEngine("clock at " + pct + "%");
}
/* ── the full rebuild ──
   The renderer caches an output device's parameters (rate, buffer) when a
   sink is first opened; a headset that changed format after that (Bluetooth
   dropping to its headset profile when the mic opened) keeps being driven
   with the old numbers, and a new stream on the same cached sink inherits
   them — which is why "restart FleetComm" was the only cure in the field.
   Closing the context, letting the sink cache expire, and building a fresh
   engine re-asks the device. Everything that hung off the old context is
   rebuilt: master bus, every tuned net's chain, the capture worklet, the
   noise bed; decoder cursors restart against the new clock. */
let REBUILD_PAUSE_MS = 6000;                       /* the rig shortens it */
let audioRebuilds = 0;
async function rebuildAudioEngine(reason) {
  audioRebuilds++;
  const micWasOpen = !!capNode;
  addLog("sys", "", "audio engine rebuild \u2014 " + reason + "; " + (REBUILD_PAUSE_MS / 1000) + " s of silence while the device is re-asked for its format");
  const old = ctx;
  if (capNode) { try { capNode.disconnect(); } catch (e) {} capNode = null; }
  for (const n of nets) {
    (n.fxNodes || []).forEach(x => { try { x.disconnect(); } catch (e) {} });
    if (n.noiseSrc) { try { n.noiseSrc.stop(); } catch (e) {} n.noiseSrc = null; }
    [n.gainNode, n.panNode, n.noiseGain].forEach(x => { if (x) { try { x.disconnect(); } catch (e) {} } });
  }
  try { await old.close(); } catch (e) {}
  await new Promise(r => setTimeout(r, REBUILD_PAUSE_MS));
  ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
  masterGain = ctx.createGain(); masterGain.connect(ctx.destination); masterGain.gain.value = masterVol / 100;
  noiseBuf = null;
  for (const n of nets) if (n.gainNode) makeChain(n);   /* a tuned net's chain, on the new engine */
  for (const d of decoders.values()) d.cursor = 0;
  ensureMic.workletLoaded = false;                       /* the worklet module is per context */
  if (outDevice) { try { await applyOutputDevice(); } catch (e) {} }
  if (ctx.state !== "running") { try { await ctx.resume(); } catch (e) {} }
  if (micWasOpen) await ensureMic();
  clockWatch.t = performance.now(); clockWatch.c = ctx.currentTime;
  addLog("sys", "", "audio engine rebuilt \u2014 " + ctx.state + " @ " + ctx.sampleRate + " Hz, output latency " +
    Math.round((ctx.outputLatency || ctx.baseLatency || 0) * 1000) + " ms" + (micWasOpen ? ", microphone re-opened" : "") + "; watching");
}
async function healAudioClock(pct) {
  audioHeals++;
  try {
    if (typeof ctx.setSinkId === "function") {
      await ctx.setSinkId({ type: "none" });        /* off the device entirely ... */
      await ctx.setSinkId(outDevice || "");         /* ... and back: a NEW stream, today's format */
    } else { await ctx.suspend(); }
    if (ctx.state !== "running") await ctx.resume();
  } catch (e) { addLog("sys", "", "couldn't re-open the audio output: " + e.message); try { await ctx.resume(); } catch (e2) {} }
  for (const d of decoders.values()) d.cursor = 0;  /* schedule fresh against the healed clock */
  if (capNode) {                                    /* re-pair echo cancellation with the new output stream */
    try { capNode.disconnect(); } catch (e) {}
    capNode = null; await ensureMic();
  }
  clockWatch.t = performance.now(); clockWatch.c = ctx.currentTime;
  addLog("sys", "", "audio output re-opened \u2014 engine " + ctx.state + " @ " + ctx.sampleRate + " Hz, output latency " +
    Math.round((ctx.outputLatency || ctx.baseLatency || 0) * 1000) + " ms (clock was at " + pct + "%; watching)");
}
setInterval(() => {
  const nowT = performance.now(), nowC = ctx.currentTime;
  const wall = nowT - clockWatch.t, audio = (nowC - clockWatch.c) * 1000;
  clockWatch.t = nowT; clockWatch.c = nowC;
  const newDrops = audioDrops - clockWatch.drops; clockWatch.drops = audioDrops;
  if (wall > 900 && wall < 3000) audioClockSample(audio, wall);   /* a late tick is not a slow clock */
  if (newDrops > 10 && Date.now() - clockWatch.saidDrops > 300000) {
    clockWatch.saidDrops = Date.now();
    addLog("sys", "", "audio backlog \u2014 dropped " + newDrops + " frames in the last second (they arrived faster than the engine played them: a network burst, or the machine busy)");
  }
}, 1000);
setInterval(() => {
  const cutoff = Date.now() - 60000;
  for (const [key, value] of decoders) {
    if (value.lastUsed < cutoff) { value.dec.delete(); decoders.delete(key); }
  }
}, 30000);
function beep(f1, f2, dur, g0) {
  if (!fx) return;
  try {
    if (ctx.state === "suspended") ctx.resume();
    const t = ctx.currentTime, o = ctx.createOscillator(), g = ctx.createGain();
    o.type = "square"; o.frequency.setValueAtTime(f1, t); o.frequency.linearRampToValueAtTime(f2, t + dur);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(g0, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(masterGain); o.start(t); o.stop(t + dur + 0.02);
  } catch (e) {}
}
const chirpCount = { down: 0, up: 0 };            /* the rig counts what it cannot hear */
const chirpDown = () => { chirpCount.down++; beep(1650, 1250, 0.07, 0.06); };
const chirpUp = () => { chirpCount.up++; beep(1150, 1500, 0.05, 0.045); };

/* ══ TX control ══ */
function txReasons(n) { if (!n._txReasons) n._txReasons = new Set(); return n._txReasons; }
async function requestTX(i, reason) {
  const n = nets[i];
  if (!n || !n.tuned || !connected) return;
  txReasons(n).add(reason);
  if (n.tx) return;
  if (!(await ensureMic())) return;
  /* The key/open-mic control may have been released while the browser's mic
     permission prompt was open. Re-check intent after the await or the radio
     can become stuck transmitting without any key still held. */
  if (!connected || !n.tuned || txReasons(n).size === 0 || n.tx) return;
  n.tx = true; txEndPending.delete(n.idx); txSet.add(n.idx);
  /* the key-down chirp belongs to the CARRIER, not to the button that raised
     it: the first net to go live chirps, whatever keyed it. Per-net keys used
     to key silently (the chirps lived in the master-PTT handler only) —
     Sven, IF-55 bind, 2026-09-02. Per-net keys also log their own TX line;
     the master PTT logs all its targets in one line up front. */
  if (txSet.size === 1) chirpDown();
  if (reason === "bind") addLog("tx", n.cfg.name, "TX START — " + callsign + " (net key)");
  if (n.bcast) { bcastIdx.add(n.idx); await ipcRenderer.invoke("arm-broadcast", n.idx); } else bcastIdx.delete(n.idx);
  netDyn(i); sendOv(); renderTxTargets();
}
function finishTX(i) {
  const n = nets[i];
  if (!n || !n.tx) return;
  n.tx = false; txSet.delete(n.idx); txEndPending.add(n.idx);
  if (txSet.size === 0) chirpUp();                /* last carrier down → key-up chirp */
  netDyn(i); sendOv(); renderTxTargets();
}
function releaseTX(i, reason) {
  const n = nets[i]; if (!n) return;
  txReasons(n).delete(reason);
  if (txReasons(n).size === 0) { const was = n.tx; finishTX(i); if (was && reason === "bind") addLog("tx", n.cfg.name, "TX END (net key)"); }
}
function syncReasonTargets(reason, active) {
  const targets = active ? new Set(txTargetIdxs()) : new Set();
  nets.forEach((n, i) => {
    if (targets.has(i)) requestTX(i, reason);
    else releaseTX(i, reason);
  });
}
function syncActiveTxTargets() {
  syncReasonTargets("ptt", pttHeld);
  syncReasonTargets("open", openMic);
}
function clearTxState() {
  nets.forEach((n, i) => { if (n._txReasons) n._txReasons.clear(); finishTX(i); });
  txSet.clear(); txEndPending.clear(); bcastIdx.clear(); pttHeld = false; openMic = false;
}
function txTargetIdxs() {
  return nets.map((n, i) => i).filter(i => nets[i].tuned && (override ? true : nets[i].txOn));
}
let pttHeld = false;
async function pttAll(down) {
  if (down === pttHeld) return;
  pttHeld = down;
  $("ptt").classList.toggle("hot", down || openMic);
  const t = txTargetIdxs();
  if (down) {
    if (!t.length) { toast("No net has TX enabled — toggle TX on at least one net."); pttHeld = false; $("ptt").classList.remove("hot"); return; }
    addLog("tx", txNames(t), "TX START — " + callsign);
    syncReasonTargets("ptt", true);
  } else if (!openMic) {
    syncReasonTargets("ptt", false);
    addLog("tx", "", "TX END");
  } else {
    syncReasonTargets("ptt", false);
  }
}
function txNames(t) { return t.map(i => nets[i].cfg.name).join(", "); }
async function setOpenMic(on) {
  openMic = on;
  $("openMicBtn").classList.toggle("latched", on);
  $("openMicBtn").textContent = on ? "OPEN MIC ENGAGED — click to end" : "OPEN MIC — continuous";
  $("ptt").classList.toggle("hot", on || pttHeld);
  const t = txTargetIdxs();
  if (on) {
    if (!t.length) { toast("No net has TX enabled."); setOpenMic(false); return; }
    addLog("tx", txNames(t), "OPEN MIC ENGAGED — " + callsign);
    syncReasonTargets("open", true);
  } else {
    syncReasonTargets("open", false);
    addLog("tx", "", "OPEN MIC ENDED");
  }
}
function setOverride(on) {
  if (!cmdToken) { toast("COMMAND OVERRIDE requires a command token (⚙ Settings)."); return; }
  override = on;
  $("overrideBtn").classList.toggle("latched", on);
  $("overrideBtn").textContent = on ? "OVERRIDE ENGAGED — click to end" : "CMD OVERRIDE — all tuned";
  addLog("sys", "", on ? "COMMAND OVERRIDE ENGAGED — PTT now keys every tuned net" : "Command override disengaged");
  if (openMic || pttHeld) syncActiveTxTargets();
  renderTxTargets();
}

/* ══ RENDER ══ */
const netlist = $("netlist");
function renderNets() {
  /* a full rebuild detaches any in-flight drag source, so its dragend fires on
     an orphaned node and never reaches the netlist delegate — without this the
     rowDragging latch stuck true and silently disabled the 12s tree re-sync */
  rowDragging = false;
  netlist.innerHTML = "";
  rebuildTree();
  const alliedVisible = alliedMode ? alliedVisibleNames() : null;
  tree.rows.forEach((row) => {
    if (alliedVisible && !alliedVisible.has(nets[row.i].cfg.name)) return;
    const i = row.i, n = nets[i];
    const kids = row.kids.map(k => nets[k]);
    const par = kids.length > 0 || (n.cfg.subnets || []).length > 0;
    const anyKidTuned = kids.some(k => k.tuned);
    const d = document.createElement("div");
    d.style.setProperty("--lvl", row.depth);
    d.className = "net" + (n.cfg.tag ? " hastag" : "") + (row.depth ? " sub" : "") + (par ? " parent" : "") +
      (par && anyKidTuned ? " hasnest" : "") + (par && n.bcast ? " bcast" : "") +
      (i === selectedI ? " sel" : "") + (n.tuned ? "" : " untuned") +
      (n.tx ? " tx-live" : (n.speaking.size ? " rx-live" : ""));
    d.dataset.i = i;
    /* Reorder drags arm ONLY from the ⠿ grip (pointerdown handler below).
       With the whole card draggable, pressing a VOL/L·R slider started a row
       drag instead of moving the slider — "the sliders don't slide". */
    d.draggable = false;
    const ship = isShip(n);
    if (ship) d.classList.add("shipgroup");
    /* Name first. The callsign of the net is what an operator scans for mid-op;
       the frequency is reference detail, so it drops to a small line underneath
       instead of leading the row. */
    let h = '<div class="nt" data-sel>' +
      (par ? '<button class="chev" data-chev title="collapse / expand nest">' + (collapsed[n.cfg.name] ? "▸" : "▾") + '</button>' : "") +
      '<span class="grip" data-grip title="Drag to reorder">⠿</span>' +
      /* the bracket-tag from the channel plan, worn as a badge; the row title
         keeps the full wire name so truncated boards still tell you where
         you are on hover */
      (n.cfg.tag ? '<span class="tagbadge">' + esc(n.cfg.tag) + "</span>" : "") +
      '<span class="nmwrap" title="' + escAttr(n.cfg.name) + '"><b class="nm">' + esc(n.cfg.display || n.cfg.name) +
      (n.cfg.enc ? ' <span class="enc">⚿</span>' : "") + '</b>' +
      '<span class="fq num">' + esc(n.cfg.freq) + '</span></span>' +
      /* present on every row, shown by CSS only while the row is tx-live —
         the strobing ON AIR badge, so the net carrying your voice is
         unmistakable at a glance (the in-place class toggle relies on the
         badge already being in the DOM) */
      '<span class="onair">ON AIR</span>' +
      (ship ? '<span class="shipbadge">SHIP</span>' : "") +
      /* A ship's count must reflect the GROUP, not per-subnet tuning: with LSN
         ALL or the 1MC live you have the whole ship without tuning anything,
         and "0/6 NETS" on a fully-up ship read as a fault. Non-ship nests keep
         the tuned-x-of-y count — tuning is how those actually work. */
      (par ? '<span class="nestcount' + (ship && n.tuned && (n.lsnAll || n.txAll) ? " live" : "") + '">' +
        (ship && n.tuned && (n.lsnAll || n.txAll)
          ? "ALL " + kids.length + " NETS"
          : (ship ? kids.filter(k => k.tuned).length + "/" + kids.length + " NETS"
                  : kids.filter(k => k.tuned).length + "/" + kids.length + " NEST")) + '</span>' : "") +
      /* the container-channel roster is meaningless on a ship row — nobody
         sits in the container, so the stray "0" just looked broken */
      (ship ? "" : '<span class="cnt num" data-cnt>' + (n.tuned ? n.roster.size : "·") + '</span>') + '</div>';

    if (ship) {
      /* A ship is a GROUP, not a channel you sit in. Two controls, and neither
         needs its subnets tuned: LSN ALL hears the whole ship, the 1MC reaches
         the whole ship (the general announcing circuit — voice and clips). */
      h += '<div class="nrow">' +
        '<button class="ann wide' + (n.lsnAll ? " lit-g" : "") + '" data-lsnall' +
          ' title="Hear every net aboard this ship — no need to tune them">LSN ALL</button>' +
        '<button class="ann wide' + (n.txAll ? " lit-a" : "") + '" data-txall' +
          ' title="1MC — transmit to every net aboard this ship, no need to tune them">1MC</button>' +
        '<button class="keyb mono" data-key title="Talk key for the 1MC — click, press a key (BACKSPACE clears, ESC cancels)">' + esc(n.bind ? n.bind.label : "KEY") + '</button>' +
        (n.tuned ? '<button class="x" data-x title="Leave the ship group">✕</button>' : "") +
        '</div>';
      if (n.tuned) h += '<div class="srow"><label>VOL</label><input type="range" min="0" max="100" value="' + n.vol + '" data-vol>' +
        '<label>L\u00b7R</label><input type="range" class="pan" min="-100" max="100" value="' + n.pan + '" data-pan></div>';
    } else if (n.tuned) {
      h += '<div class="nrow">' +
        '<button class="ann' + (n.mon ? " lit-g" : "") + '" data-mon>LSN</button>' +
        '<button class="ann' + (n.txOn ? " lit-a" : "") + '" data-txon>TX</button>' +
        '<button class="keyb mono" data-key title="Per-net talk key — click, press a key or combo (BACKSPACE clears, ESC cancels)">' + esc(n.bind ? n.bind.label : "KEY") + '</button>' +
        '<button class="x" data-x title="Detune">✕</button></div>' +
        '<div class="srow"><label>VOL</label><input type="range" min="0" max="100" value="' + n.vol + '" data-vol>' +
        '<label>L\u00b7R</label><input type="range" class="pan" min="-100" max="100" value="' + n.pan + '" data-pan></div>';
    } else {
      h += n.denied
        ? '<div class="denied" title="' + escAttr(n.denied) + '">RESTRICTED — NO ACCESS</div>'
        : n.relinking
        ? '<div class="relinking">RECONNECTING…</div>'
        : '<button class="tunebtn" data-tune>TUNE ▸</button>';
    }
    d.innerHTML = h;
    netlist.appendChild(d);
  });
  $("monCount").textContent = nets.filter(n => n.tuned).length + " TUNED";
  renderCenter(); renderTxTargets(); sendOv();
}
function netDyn(i) {
  const n = nets[i], el = netlist.querySelector('[data-i="' + i + '"]');
  if (!el) return;
  el.classList.toggle("tx-live", !!n.tx);
  el.classList.toggle("rx-live", !n.tx && n.speaking.size > 0);
  const c = el.querySelector("[data-cnt]"); if (c) c.textContent = n.tuned ? n.roster.size : "—";
  if (i === selectedI) renderRoster();
}
function renderChatTabs() {
  const tuned = nets.map((n, i) => i).filter(i => nets[i].tuned);
  $("chatTabs").innerHTML = tuned.map(i =>
    '<button class="ctab' + (i === selectedI ? " on" : "") + '" data-ci="' + i + '">' + esc(nets[i].cfg.name) +
    (nets[i].chat.length ? ' <span class="num">' + nets[i].chat.length + '</span>' : "") + '</button>').join("") ||
    '<span class="hint">no nets tuned</span>';
}
function renderCenter() {
  const n = sel();
  $("rosterTitle").textContent = "ON NET — " + (n ? n.cfg.name : "");
  $("chatTitle").textContent = "NET TEXT — " + (n ? n.cfg.name : "");
  renderChatTabs();
  renderRoster(); renderChat(); renderChat2(); renderSoundboard();
  const can = n && n.tuned && n.mon;
  $("chatIn").disabled = !can;
  $("chatIn").placeholder = can ? "message " + n.cfg.name + "…" : (n && n.tuned ? "enable LISTEN on this net to chat" : "tune this net to chat");
}
function renderRoster() {
  const n = sel(), box = $("rosterChips");
  if (!n || !n.tuned) { box.innerHTML = '<span class="hint">' + (n ? "net not tuned — TUNE it to see who's aboard" : "") + '</span>'; $("rosterCount").textContent = ""; return; }
  const now = Date.now(); let h = "";
  const meSpeaking = n.tx;
  h += '<div class="rchip me' + (meSpeaking ? " speaking" : "") + '"><b>' + esc(callsign) + '</b><span>YOU' + (meSpeaking ? " · TX" : "") + '</span></div>';
  for (const [sess, name] of n.roster) {
    if (name === callsign) continue;
    const sp = (n.speaking.get(sess) || 0) > now;
    h += '<div class="rchip' + (sp ? " speaking" : "") + '"><b>' + esc(name) + '</b><span>' + (sp ? "SPEAKING" : "ON NET") + '</span></div>';
  }
  box.innerHTML = h;
  $("rosterCount").textContent = n.roster.size + " KNOWN";
}
function renderChat() {
  const n = sel(), feed = $("chatFeed");
  feed.innerHTML = !n ? "" : n.chat.map(m =>
    '<div class="cm' + (m.mine ? " mine" : "") + '"><span class="t">' + esc(m.t) + '</span><b>' + esc(m.from) + '</b>' + esc(m.msg) + '</div>'
  ).join("");
  feed.scrollTop = feed.scrollHeight;
}
/* the board's mini chat mirrors the SELECTED net — the CHAT page keeps the tabs */
function renderChat2() {
  const n = sel(), feed = $("chatFeed2");
  $("chatNet2").textContent = n ? n.cfg.name : "";
  feed.innerHTML = !n ? "" : n.chat.map(m =>
    '<div class="cm' + (m.mine ? " mine" : "") + '"><span class="t">' + esc(m.t) + '</span><b>' + esc(m.from) + '</b>' + esc(m.msg) + '</div>'
  ).join("");
  feed.scrollTop = feed.scrollHeight;
  const can = n && n.tuned && n.mon;
  $("chatIn2").disabled = !can;
  $("chatIn2").placeholder = can ? "message " + n.cfg.name + "…" : (n && n.tuned ? "enable LISTEN on this net to chat" : "tune this net to chat");
}
function esc(s) { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }
function escAttr(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function renderTxTargets() {
  const t = txTargetIdxs(), el = $("txTargets");
  if (override) el.innerHTML = '<span class="ann lit-a">OVERRIDE — ALL TUNED</span>';
  else if (t.length) el.innerHTML = t.map(i => '<span class="ann lit-a">' + esc(nets[i].cfg.name) + '</span>').join("");
  else el.innerHTML = '<span class="ann">NO NET</span>';
  document.body.classList.toggle("ovr", override);
  $("overrideBtn").style.display = cmdToken ? "block" : "none";
}
function renderMic() {
  $("micLbl").className = "v" + (micState === "ok" ? " ok" : micState === "denied" ? " warn" : " dim");
  $("micLbl").textContent = micState === "ok" ? "LIVE" : micState === "denied" ? "BLOCKED" : "NOT REQ";
  $("micBtn").className = "wide" + (micState === "ok" ? " ok" : "");
  $("micBtn").textContent = micState === "ok" ? "✓ MICROPHONE ENABLED" : "ENABLE MICROPHONE";
}
function renderMasterBinds() {
  const unbound = !masterBinds.active;
  $("pttRow").classList.toggle("unbound", unbound);
  $("pttHint").textContent = unbound
    ? "No talk key set — only the on-screen PTT works until you choose one."
    : "Transmits on every net with TX armed";
  $("ptt").classList.toggle("needsbind", unbound);
  $("bindActive").textContent = masterBinds.active ? masterBinds.active.label : "set key";
  $("bindCycUp").textContent = masterBinds.cycUp ? masterBinds.cycUp.label : "set key";
  $("bindCycDn").textContent = masterBinds.cycDn ? masterBinds.cycDn.label : "set key";
  /* capture over (bound, cleared, or cancelled) — drop the listening chrome
     that used to stick to the badges forever */
  ["bindActive", "bindCycUp", "bindCycDn"].forEach(id => $(id).classList.remove("listen"));
  $("pttKeyLbl").textContent = (masterBinds.active ? masterBinds.active.label : "—").toUpperCase();
}
/* transmission log */
const logFeed = $("logFeed");
let logN = 0;
function addLog(kind, netName, msg) {
  if (kind === "sys" && !netName) { addSysLog(msg); return; }
  logN++;
  if (logN > 400) { logFeed.removeChild(logFeed.firstChild); }
  const d = document.createElement("div");
  d.className = "le " + kind;
  d.innerHTML = '<span class="t mono">' + utc() + '</span>  ' +
    (netName ? '<span class="n">' + esc(netName) + '</span>  ' : "") + '<span class="m">' + esc(msg) + '</span>';
  logFeed.appendChild(d);
  logFeed.scrollTop = logFeed.scrollHeight;
}
function utc() { return new Date().toISOString().slice(11, 19); }

/* Takes what a person actually types — "250", "290.5", "290,500", " 118.25 " —
   and returns the NNN.NNN the board displays. Empty string for anything that
   isn't a frequency, so callers can fall back to what the net already had. */
/* A rename has to carry the local state that was filed under the old name:
   the collapse flag for the nest, and every child's parent pointer. Miss these
   and the tree quietly reshuffles itself the next time it renders. */
function renameLocal(oldName, newName) {
  if (Object.prototype.hasOwnProperty.call(collapsed, oldName)) {
    collapsed[newName] = collapsed[oldName];
    delete collapsed[oldName];
  }
  nets.forEach(x => { if (x.parent === oldName) x.parent = newName; });
}

/* Collapse flags are keyed by net name, so names that no longer exist keep
   folding things away long after the net is gone — that's how a nest could
   swallow a net that wasn't even in it. Sweep them whenever the tree changes. */
/* The relay is the authority on the shape of the tree. After any edit we ask it
   what actually happened rather than trusting our own optimistic update — that
   is what let the board show a net still nested under TIBER when the server had
   already moved it somewhere else. */
async function syncTreeFromRelay() {
  let view;
  try { view = await ipcRenderer.invoke("atc-view"); } catch (e) { return false; }
  if (!Array.isArray(view) || !view.length) return false;
  const byId = new Map(view.map(c => [c.id, c]));
  const relayRows = view.filter(c => c.name && c.name !== channelName(pkg.rootChannel));
  if (!relayRows.length) return false;
  const relayNames = new Set(relayRows.map(c => c.name));
  const selectedName = sel() && sel().cfg.name;
  let changed = false;
  for (const ch of relayRows) {
    let n = nets.find(item => channelName(item.cfg.channel || item.cfg.name) === ch.name);
    if (!n) {
      const pref = netPrefs[ch.freq] || {};
      n = { cfg: { name: ch.name, freq: ch.freq || "———.———", enc: false, ship: !!ch.ship, subnets: [] },
        depth: 0, parent: null, tuned: false, idx: null, mon: pref.mon !== false, txOn: !!pref.txOn,
        vol: Math.max(0, Math.min(100, Number(pref.vol == null ? 75 : pref.vol) || 0)),
        pan: Math.max(-100, Math.min(100, Number(pref.pan) || 0)), bind: pref.bind || null,
        bcast: !!pref.bcast, group: !!ch.ship, lsnAll: !!pref.lsnAll, txAll: !!pref.txAll,
        roster: new Map(), speaking: new Map(), chat: [], tx: false };
      nets.push(n); changed = true;
    }
    if (ch.freq && n.cfg.freq !== ch.freq) { n.cfg.freq = ch.freq; changed = true; }
    if (ch.ship != null && !!n.cfg.ship !== !!ch.ship) { n.cfg.ship = !!ch.ship; n.group = !!ch.ship; changed = true; }
  }
  const beforeLength = nets.length;
  nets = nets.filter(n => n.tuned || relayNames.has(channelName(n.cfg.channel || n.cfg.name)));
  if (nets.length !== beforeLength) changed = true;
  for (const n of nets) {
    const ch = relayRows.find(c => c.name === channelName(n.cfg.channel || n.cfg.name));
    if (!ch) continue;
    const par = byId.get(ch.parent);
    const parentNet = par && nets.find(item => channelName(item.cfg.channel || item.cfg.name) === par.name);
    const parentName = parentNet ? parentNet.cfg.name : null;
    if ((n.parent || null) !== parentName) { n.parent = parentName; changed = true; }
  }
  if (selectedName) {
    const selected = nets.findIndex(n => n.cfg.name === selectedName);
    if (selected >= 0) selectedI = selected;
  }
  if (changed) { savePrefs(); renderNets(); }
  return changed;
}

function pruneCollapsed() {
  const live = new Set(nets.map(n => n.cfg.name));
  Object.keys(collapsed).forEach(k => { if (!live.has(k)) delete collapsed[k]; });
}
function normFreq(raw) {
  const s = String(raw == null ? "" : raw).trim().replace(",", ".");
  if (!s) return "";
  const m = s.match(/^(\d{1,3})(?:\.(\d{0,3}))?$/);
  if (!m) return "";
  return m[1] + "." + (m[2] || "").padEnd(3, "0");
}

/* ══ TX arming ══
   Cycling with PgUp/PgDn — or clicking a net's name — makes that net THE net
   you talk on, and disarms the others. Simulcast still works the way it always
   has: pick your primary here, then click the TX annunciator on any extra nets
   to stack them on top. If you rotate while you're already keyed, the
   transmission follows you — the net you left closes and the new one opens, so
   the mic is never left hot on a net you've moved off. COMMAND OVERRIDE is
   left alone entirely; while it's engaged PTT keys every tuned net by design. */
function armTxExclusive(i) {
  const n = nets[i];
  if (!n || !n.tuned) return;
  const keyed = pttHeld || openMic;
  nets.forEach((x, j) => {
    if (!x.tuned) return;
    x.txOn = (j === i);
  });
  if (keyed && !override) syncActiveTxTargets();
  savePrefs();
  renderTxTargets();
}
function cycleSel(dir) {
  /* walk the board in the order it's displayed — array order stopped matching
     the list the moment nets could be re-homed */
  const tuned = tree.rows.map(r => r.i).filter(i => nets[i].tuned);
  if (!tuned.length) return;
  const pos = Math.max(0, tuned.indexOf(selectedI));
  selectedI = tuned[(pos + dir + tuned.length) % tuned.length];
  armTxExclusive(selectedI);   /* the net you cycle to becomes the one you talk on */
  renderNets(); chirpUp();
  addLog("sys", nets[selectedI].cfg.name, "selected — TX armed");
}
function sendOv() {
  camTalkSync();
  ipcRenderer.send("ov-state", nets.filter(n => n.tuned).map(n => {
    const now = Date.now();
    let who = null;
    for (const [sess, until] of n.speaking) if (until > now) { who = n.roster.get(sess) || "?"; break; }
    return { name: (n.cfg.tag ? n.cfg.tag + " · " : "") + (n.cfg.display || n.cfg.name),
      freq: n.cfg.freq, who, tx: n.tx, active: nets[selectedI] === n, mon: n.mon, me: callsign };
  }));
}

/* ══ net interactions ══ */
netlist.addEventListener("click", async (e) => {
  const card = e.target.closest(".net"); if (!card) return;
  const i = +card.dataset.i, n = nets[i];
  if (e.target.closest("[data-chev]")) {
    collapsed[n.cfg.name] = !collapsed[n.cfg.name]; savePrefs(); renderNets(); return;
  }
  /* ── ship group controls ──
     Both join the ship group first if it isn't up yet, so an operator never has
     to know that a connection exists underneath. */
  if (e.target.closest("[data-lsnall]")) {
    if (!n.tuned && !(await tuneNet(i))) return;
    n.lsnAll = !n.lsnAll;
    n.mon = n.lsnAll || n.mon;
    const r = await ipcRenderer.invoke("listen-all",
      { idx: n.idx, on: n.lsnAll, names: subnetNamesOf(n) });
    if (n.lsnAll && !(r && r.ok)) {
      n.lsnAll = false;
      toast("Couldn't listen to " + n.cfg.name + ((r && r.error) ? " — " + r.error : "."));
    } else {
      addLog("sys", n.cfg.name, n.lsnAll
        ? "LSN ALL — hearing every net aboard (" + r.listening + ")"
        : "LSN ALL off");
    }
    savePrefs(); renderNets(); return;
  }
  if (e.target.closest("[data-txall]")) {
    if (!n.tuned && !(await tuneNet(i))) return;
    n.txAll = !n.txAll;
    n.bcast = n.txAll;                 /* the stack arms the same children target */
    n.txOn = n.txAll;
    if (n.txAll) {
      const ok = await ipcRenderer.invoke("arm-broadcast", n.idx);
      if (!ok) { n.txAll = false; n.bcast = false; n.txOn = false; toast("Couldn't arm the 1MC."); }
      else addLog("sys", n.cfg.name, "1MC armed — transmits to every net aboard");
    } else addLog("sys", n.cfg.name, "1MC off");
    savePrefs(); renderNets(); return;
  }
  if (e.target.closest("[data-sel]")) {
    selectedI = i;
    if (n.tuned) armTxExclusive(i);
    renderNets(); return;
  }
  if (e.target.closest("[data-tune]")) { await tuneNet(i); return; }
  if (e.target.closest("[data-mon]")) { n.mon = !n.mon; ipcRenderer.send("net-mute", { idx: n.idx, muted: !n.mon }); savePrefs(); renderNets(); return; }
  if (e.target.closest("[data-txon]")) { n.txOn = !n.txOn; if (pttHeld || openMic) syncActiveTxTargets(); savePrefs(); renderNets(); return; }
  if (e.target.closest("[data-x]")) {
    n.relinking = false; stopRelink(n.cfg.name);
    ipcRenderer.send("detune", n.idx);
    txSet.delete(n.idx); txEndPending.delete(n.idx); bcastIdx.delete(n.idx); txReasons(n).clear();
    n.tuned = false; n.idx = null; n.roster.clear(); n.speaking.clear(); n.tx = false;
    addLog("sys", n.cfg.name, "detuned"); savePrefs(); renderNets(); return;
  }
  if (e.target.closest("[data-key]")) {
    /* capture holds the net's NAME, never its index — the 12s tree re-sync
       can push/remove nets and reindex the array while a capture is armed */
    capturing = { kind: "net", name: n.cfg.name };
    const b = card.querySelector("[data-key]");
    b.classList.add("listen"); b.textContent = "press…";
  }
});
netlist.addEventListener("input", (e) => {
  const i = +e.target.closest(".net").dataset.i, n = nets[i];
  if (e.target.hasAttribute("data-vol")) { n.vol = +e.target.value; if (n.gainNode) n.gainNode.gain.value = n.vol / 100; }
  if (e.target.hasAttribute("data-pan")) { n.pan = +e.target.value; if (n.panNode) n.panNode.pan.value = n.pan / 100; }
  savePrefs();
});
async function tuneNet(i, silent) {
  const n = nets[i];
  if (n.tuned) return true;
  const cfg = { name: n.cfg.name, freq: n.cfg.freq, channel: n.cfg.channel || n.cfg.name };
  let r = await ipcRenderer.invoke("tune", cfg);
  if (!r.ok && /not found/.test(r.error || "")) {
    if (!cmdToken) { if (!silent) toast("Net \"" + n.cfg.name + "\" doesn't exist on the relay yet — command authority required to create it."); return false; }
    const parent = n.parent || pkg.rootChannel;
    const made = await ipcRenderer.invoke("create-net", { name: n.cfg.name, rootChannel: parent, freq: n.cfg.freq, ship: !!n.cfg.ship });
    if (!made.ok) { if (!silent) toast(/PermissionDenied/.test(made.error) ? "The relay refused net creation here \u2014 COMMAND may create anywhere; an organization lead only inside their own organization's nets." : "Create failed: " + made.error); return false; }
    if (made.name && made.name !== n.cfg.name) {
      renameLocal(n.cfg.name, made.name); n.cfg.name = made.name; cfg.name = made.name; cfg.channel = made.name;
    }
    addLog("sys", n.cfg.name, "net created on relay by " + callsign);
    r = await ipcRenderer.invoke("tune", cfg);
  }
  if (!r.ok) {
    /* a governor-held dial cost the relay nothing — log it once a minute
       total, not once per net per attempt, and keep the relink loop alive */
    if (/^relay hold/i.test(r.error || "")) {
      if (Date.now() - lastHoldLog > 60000) { lastHoldLog = Date.now(); addLog("sys", "", r.error); }
      return false;
    }
    /* An access refusal is not a technical failure — say so in those terms, and
       mark the net on the board so it's obvious you can't use it rather than
       leaving you pressing a control that does nothing. */
    const denied = /don't have access|PermissionDenied|refused you access/i.test(r.error || "");
    n.denied = denied ? (r.error || "").replace(/\s*\(PermissionDenied[^)]*\)/, "") : null;
    if (!silent) toast(denied
      ? n.cfg.name + " is restricted — your account doesn't have access to it."
      : "Tune failed: " + r.error);
    if (denied) addLog("sys", n.cfg.name, "ACCESS DENIED — restricted net");
    renderNets();
    return false;
  }
  n.denied = null;
  n.tuned = true; n.idx = r.idx; tutEvent("tuned");
  makeChain(n);
  if (n.bcast) ipcRenderer.invoke("arm-broadcast", n.idx);
  if (!n.mon) ipcRenderer.send("net-mute", { idx: n.idx, muted: true });
  addLog("sys", n.cfg.name, "tuned — " + n.cfg.freq + " MHz");
  renderNets();
  return true;
}
/* Electron has no window.prompt — every net edit goes through this dialog. */
let dlgMode = "new", dlgIdx = null;
function openNetDialog(mode, i) {
  if (!connected) { toast("Connect first."); return; }
  if (!cmdToken) { toast("Editing nets requires COMMAND authority."); return; }
  dlgMode = mode; dlgIdx = (i == null ? null : i);
  $("dlgFreq").parentElement.style.display = "";
  $("dlgParent").parentElement.style.display = "";
  $("dlgShip").parentElement.style.display = "";
  $("dlgName").placeholder = "e.g. STRIKE TWO";
  $("dlgErr").textContent = "";
  /* any net may be a parent, at any depth — except the net being edited and
     its own descendants, which would orphan that whole branch */
  const legal = mode === "edit" && i != null
    ? validParents(nets.map(x => ({ name: x.cfg.name, parent: x.parent })), i)
    : nets.map((x, j) => j);
  const opts = ['<option value="">— top level —</option>'].concat(
    legal.map(j => nets[j]).map(n => '<option value="' + escAttr(n.cfg.name) + '">under ' +
      "  ".repeat(n.depth || 0) + esc(n.cfg.name) + "</option>"));
  $("dlgParent").innerHTML = opts.join("");
  if (mode === "edit") {
    const n = nets[i];
    $("dlgTitle").textContent = "NET PROPERTIES — " + n.cfg.name;
    $("dlgName").value = n.cfg.name; $("dlgFreq").value = n.cfg.freq;
    $("dlgParent").value = n.parent || ""; $("dlgShip").checked = !!n.cfg.ship;
    $("dlgOk").textContent = "APPLY ▸";
  } else {
    const parentFrom = i != null ? (nets[i].depth === 0 ? nets[i].cfg.name : nets[i].parent) : (sel() ? (sel().depth === 0 ? sel().cfg.name : sel().parent) : "");
    $("dlgTitle").textContent = "NEW NET";
    $("dlgName").value = ""; $("dlgFreq").value = ""; $("dlgShip").checked = false;
    $("dlgParent").value = parentFrom || "";
    $("dlgOk").textContent = "CREATE ▸";
  }
  $("dlg").classList.add("on");
  setTimeout(() => $("dlgName").focus(), 30);
}
$("addNetBtn").addEventListener("click", () => openNetDialog("new", null));
$("dlgCancel").addEventListener("click", () => $("dlg").classList.remove("on"));
$("dlg").addEventListener("keydown", (e) => {
  if (e.key === "Escape") $("dlg").classList.remove("on");
  if (e.key === "Enter") $("dlgOk").click();
  e.stopPropagation();
});
$("dlgOk").addEventListener("click", async function () {
  if (dlgMode === "delete") {
    const n = nets[dlgIdx];
    if ($("dlgName").value.trim().toUpperCase() !== n.cfg.name) { $("dlgErr").textContent = "Name doesn't match — nothing deleted."; return; }
    const r = await ipcRenderer.invoke("net-remove", n.cfg.name);
    $("dlg").classList.remove("on");
    $("dlgOk").textContent = "CREATE ▸";
    if (!r.ok) { toast("Delete failed — " + (r.error || "the relay refused it.")); return; }
    addLog("sys", n.cfg.name, "net DELETED from relay by " + callsign);
    nets.splice(dlgIdx, 1); selectedI = Math.min(selectedI, nets.length - 1); renderNets();
    return;
  }
  if (dlgMode === "edit") {
    const n = nets[dlgIdx];
    const newName = $("dlgName").value.trim().toUpperCase();
    const newFreq = normFreq($("dlgFreq").value) || n.cfg.freq;
    const newParent = $("dlgParent").value;
    this.disabled = true; this.textContent = "APPLYING…";
    let r = { ok: true };
    if (newName && newName !== n.cfg.name) {
      r = await ipcRenderer.invoke("net-rename", { net: n.cfg.name, name: newName });
      if (r.ok) { const acceptedName = r.name || newName;
                  addLog("sys", n.cfg.name, "renamed to " + acceptedName + " by " + callsign);
                  renameLocal(n.cfg.name, acceptedName); n.cfg.name = acceptedName; }
    }
    if (r.ok && (newParent || "") !== (n.parent || "")) {
      r = await ipcRenderer.invoke("net-move", { net: n.cfg.name, parent: newParent });
      if (r.ok) { n.parent = newParent || null; n.depth = newParent ? 1 : 0;
                  addLog("sys", n.cfg.name, newParent ? "nested under " + newParent : "moved to top level"); }
    }
    if (r.ok && (newFreq !== n.cfg.freq || !!$("dlgShip").checked !== !!n.cfg.ship)) {
      r = await ipcRenderer.invoke("net-meta", { net: n.cfg.name, freq: newFreq, ship: !!$("dlgShip").checked });
      if (r.ok) { n.cfg.freq = newFreq; n.cfg.ship = $("dlgShip").checked; }
    }
    this.disabled = false; this.textContent = "CREATE ▸";
    if (!r.ok) { $("dlgErr").textContent = r.error || "The relay refused that change."; return; }
    savePrefs(); $("dlg").classList.remove("on"); renderNets(); renderSoundboard();
    /* confirm against the relay, so the board shows where the net really is */
    if (await syncTreeFromRelay()) addLog("sys", n.cfg.name, "tree re-synced from the relay");
    return;
  }
  const name = $("dlgName").value.trim().toUpperCase();
  const freqRaw = $("dlgFreq").value.trim();
  const parent = $("dlgParent").value;
  if (!name) { $("dlgErr").textContent = "Give the net a name."; return; }
  if (nets.some(n => n.cfg.name === name)) { $("dlgErr").textContent = "A net by that name is already on your board."; return; }
  const freq = normFreq(freqRaw) || "———.———";
  this.disabled = true; this.textContent = "CREATING…";
  const cfg = { name, freq, enc: false, ship: $("dlgShip").checked, subnets: [] };
  /* any net can be a parent — requiring depth 0 here silently dropped the
     parent when you nested under a subnet, and the new net was created at the
     org root instead of where you asked for it */
  const p = parent ? nets.find(n => n.cfg.name === parent) : null;
  nets.push({ cfg, depth: p ? 1 : 0, parent: p ? p.cfg.name : null, tuned: false, idx: null,
    mon: true, txOn: false, vol: 75, pan: 0, bind: null, bcast: false,
    roster: new Map(), speaking: new Map(), chat: [], tx: false });
  const i = nets.length - 1;
  renderNets();
  const ok = await tuneNet(i);
  this.disabled = false; this.textContent = "CREATE ▸";
  if (!ok) { nets.splice(i, 1); renderNets(); $("dlgErr").textContent = "The relay refused to create that net."; return; }
  $("dlg").classList.remove("on");
  selectedI = i; renderNets();
  if (await syncTreeFromRelay()) addLog("sys", name, "tree re-synced from the relay");
});

/* ══ NET CONTEXT MENU + PROPERTIES (COMMAND only) ══ */
let ctxNet = null;
netlist.addEventListener("contextmenu", (e) => {
  const card = e.target.closest(".net"); if (!card) return;
  e.preventDefault();
  if (!cmdToken) { toast("Editing nets requires COMMAND authority."); return; }
  ctxNet = +card.dataset.i;
  const m = $("ctx");
  m.style.display = "block";
  const vw = window.innerWidth, vh = window.innerHeight, r = m.getBoundingClientRect();
  m.style.left = Math.min(e.clientX, vw - r.width - 8) + "px";
  m.style.top = Math.min(e.clientY, vh - r.height - 8) + "px";
  /* everything here goes out over whichever relay connection is live, so the
     only thing that can disable an item is not being connected at all */
  m.querySelectorAll(".ctxi").forEach(b => { b.disabled = !connected; });
});
window.addEventListener("click", () => { $("ctx").style.display = "none"; });
window.addEventListener("blur", () => { $("ctx").style.display = "none"; });
$("ctx").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-act]"); if (!b || ctxNet == null) return;
  const i = ctxNet, n = nets[i];
  $("ctx").style.display = "none";
  if (b.dataset.act === "props" || b.dataset.act === "rename") { openNetDialog("edit", i); return; }
  if (b.dataset.act === "sub") { openNetDialog("new", i); return; }
  if (b.dataset.act === "access") { showPage("pgAcct"); toast("Set access for " + n.cfg.name + " in the NET ACCESS list."); return; }
  if (b.dataset.act === "delete") {
    openConfirmDelete(i);
  }
});
function openConfirmDelete(i) {
  const n = nets[i];
  dlgMode = "delete"; dlgIdx = i;
  $("dlgTitle").textContent = "DELETE " + n.cfg.name;
  $("dlgName").value = ""; $("dlgName").placeholder = "type the net name to confirm";
  $("dlgFreq").parentElement.style.display = "none";
  $("dlgParent").parentElement.style.display = "none";
  $("dlgShip").parentElement.style.display = "none";
  $("dlgErr").textContent = "This removes the net from the relay for everyone.";
  $("dlgOk").textContent = "DELETE ▸";
  $("dlg").classList.add("on");
  setTimeout(() => $("dlgName").focus(), 30);
}

/* ══ SOUNDBOARD (ship nets only) ══
   A clip is decoded, resampled to 48k mono, Opus-encoded and pushed down the
   same TX path as the mic — so it honours nest broadcast and everyone on the
   net (or the whole nest) hears it exactly like a transmission. */
let sbSounds = [], sbPlaying = null;
const sbCache = new Map();   /* id/name -> decoded AudioBuffer, so a 4MB clip downloads once */
/* The library is FLEET property when signed in with Discord: clips live on the
   accounts service, shared by every COMMAND account, and appear on the 1MC of
   every ship net. The local per-machine library remains only as the fallback
   for legacy/token mode (and the offline test rig). */
const sharedSoundLib = () => discordMode && !!acct;
async function refreshSounds() {
  if (discordMode) {
    if (sharedSoundLib() && cmdToken) {
      const r = await ipcRenderer.invoke("acct", { method: "GET", path: "/api/sounds" });
      sbSounds = r && r.ok && Array.isArray(r.sounds) ? r.sounds : [];
    } else sbSounds = [];
    renderSoundboard(); renderSoundLib();
    return;
  }
  sbSounds = await ipcRenderer.invoke("sounds-list");
  renderSoundboard(); renderSoundLib();
}
/* fetch + decode a clip, from the fleet library (by id) or local disk (by name) */
async function clipBuffer(s) {
  const key = s.id || s.name;
  if (sbCache.has(key)) return sbCache.get(key);
  let bytes;
  if (s.id) {
    const r = await ipcRenderer.invoke("acct", { method: "GET", path: "/api/sounds/" + s.id });
    if (!r || !r.ok) throw new Error((r && r.error) || "couldn't fetch the clip from the fleet library");
    bytes = Uint8Array.from(atob(r.data), c => c.charCodeAt(0)).buffer;
  } else {
    const r = await ipcRenderer.invoke("sounds-read", s.name);
    if (!r.ok) throw new Error(r.error);
    bytes = r.data;
  }
  const audio = await ctx.decodeAudioData(bytes);
  sbCache.set(key, audio);
  return audio;
}
/* ── SYS-page sound library (COMMAND) ──
   Uploads and deletions happen HERE, not on individual ship rows: the library
   is one fleet-wide list, and every clip in it appears on the 1MC of every
   ship net. Signed in with Discord it syncs through the accounts service; in
   legacy token mode it manages this machine's local clips. */
function renderSoundLib() {
  const box = $("sndLib");
  if (!box) return;
  box.style.display = cmdToken ? "" : "none";
  if (!cmdToken) return;
  $("sndLibHint").textContent = sharedSoundLib()
    ? "Clips here are shared with every COMMAND account and appear on the 1MC of every ship net."
    : "Legacy mode — clips are stored on this machine only, and appear on the 1MC of every ship net.";
  $("sndLibList").innerHTML = sbSounds.length
    ? sbSounds.map(s => '<div class="sndrow"><b>' + esc(s.name.replace(/\.[^.]+$/, "")) + '</b>' +
        '<span class="num">' + Math.max(1, Math.round((s.size || 0) / 1024)) + ' KB</span>' +
        '<button class="icobtn" data-sdel="' + escAttr(s.id || s.name) + '">✕ REMOVE</button></div>').join("")
    : '<p class="hint">No clips yet — ADD CLIPS loads the 1MC of every ship net.</p>';
}
$("sndLibAdd").addEventListener("click", async () => {
  if (!sharedSoundLib()) {   /* legacy: old local copy flow */
    const r = await ipcRenderer.invoke("sounds-add");
    if (r.ok && r.added.length) { toast("Added " + r.added.length + " clip(s)."); refreshSounds(); }
    return;
  }
  const picked = await ipcRenderer.invoke("sounds-pick");
  if (!picked || !picked.ok) { if (picked && !picked.canceled) toast(picked.error || "Couldn't read those files."); return; }
  let added = 0; const errors = (picked.skipped || []).slice();
  for (const clip of picked.clips) {
    const r = await ipcRenderer.invoke("acct", { method: "POST", path: "/api/sounds", body: { name: clip.name, data: clip.data } });
    if (r && r.ok) added++; else errors.push(clip.name + (r && r.error ? " (" + r.error + ")" : ""));
  }
  if (added) toast("Added " + added + " clip(s) to the fleet library.");
  if (errors.length) toast("Not added: " + errors.join(", "));
  refreshSounds();
});
$("sndLibList").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-sdel]"); if (!b) return;
  if (sharedSoundLib()) {
    const r = await ipcRenderer.invoke("acct", { method: "POST", path: "/api/sounds/" + b.dataset.sdel + "/delete" });
    if (!r || !r.ok) toast((r && r.error) || "Couldn't remove the clip.");
  } else await ipcRenderer.invoke("sounds-delete", b.dataset.sdel);
  sbCache.delete(b.dataset.sdel);
  refreshSounds();
});
/* ── the 1MC ──
   The ship's general announcing circuit: one call heard on every net aboard.
   COMMAND only, and only on a ship net. It plays down the same TX path as the
   mic, so a clip goes out to everyone on the net (or the whole nest when
   broadcast is armed) — that is not something a rating should be able to key.
   Non-COMMAND operators never see the panel at all.
   For COMMAND it stays visible on a ship net even before the net is tuned, with
   a line saying what is missing: an empty space you have to guess your way into
   is how this ended up feeling like it wasn't there. */
function renderSoundboard() {
  const n = sel();
  const ship = !!(n && isShip(n));
  const show = ship && !!cmdToken;
  $("sbPanel").style.display = show ? "block" : "none";
  if (!show) return;
  $("sbNet").textContent = n.cfg.name + (n.bcast ? " (NEST)" : "");
  if (!n.tuned) {
    $("sbList").innerHTML = '<span class="hint">tune ' + esc(n.cfg.name) +
      ' to pipe the 1MC';
    return;
  }
  /* clip management lives in SYS — every ship net shows the same fleet library */
  $("sbList").innerHTML = sbSounds.length
    ? sbSounds.map(s => { const key = s.id || s.name;
        return '<button class="sbBtn' + (sbPlaying === key ? " playing" : "") + '" data-snd="' + escAttr(key) + '">' +
        esc(s.name.replace(/\.[^.]+$/, "")) + '</button>'; }).join("")
    : '<span class="hint">no clips in the library — add them under SETTINGS ▸ 1MC SOUND LIBRARY</span>';
}
$("sbAdd").addEventListener("click", () => showPage("settings"));
$("sbList").addEventListener("click", (e) => {
  const b = e.target.closest("[data-snd]"); if (!b) return;
  const s = sbSounds.find(x => (x.id || x.name) === b.dataset.snd); if (!s) return;
  playClipOnNet(s, sel());
});
async function playClipOnNet(s, net) {
  const name = s.name, sbKey = s.id || s.name;
  if (!net || !net.tuned) { toast("Tune the net first."); return; }
  if (sbPlaying) { toast("A clip is already playing."); return; }
  let audio;
  try { audio = await clipBuffer(s); }
  catch (e) { toast("Couldn't play " + name + ": " + e.message); return; }
  /* mix to mono at the context's 48k rate */
  const len = audio.length, chans = audio.numberOfChannels;
  const mono = new Float32Array(len);
  for (let c = 0; c < chans; c++) {
    const d = audio.getChannelData(c);
    for (let i = 0; i < len; i++) mono[i] += d[i] / chans;
  }
  /* ── level ──
     Clips are mastered anywhere from quiet to brick-walled, while voice arrives
     at whatever the mic's AGC settled on. Sending a clip at full scale is why
     they came in far hotter than people, so peak-normalise each clip to a fixed
     target with headroom. Everything lands at a predictable level regardless of
     how the file was recorded. */
  let peak = 0;
  for (let i = 0; i < len; i++) { const a = mono[i] < 0 ? -mono[i] : mono[i]; if (a > peak) peak = a; }
  const CLIP_TARGET = 0.18;                      /* well under voice — a clip should sit behind people, not over them */
  /* the 1MC master trim rides on top of normalisation: it scales what the
     fleet hears, and is independent of VOICE VOL */
  const norm = (peak > 0.0001 ? Math.min(4, CLIP_TARGET / peak) : 1) * (sbVol / 100);

  /* ── where a clip goes ──
     It is the SHIPWIDE soundboard, so on a ship group it always reaches the
     whole ship. Requiring TX ALL to be armed first meant clips quietly played
     into the ship's own empty container channel and nobody heard them. Arming
     is about YOUR voice; the soundboard's reach is what the feature is. */
  const shipwide = !!net.cfg.ship;
  const broadcast = shipwide || !!net.bcast;
  if (broadcast) {
    const armed = await ipcRenderer.invoke("arm-broadcast", net.idx);
    if (!armed) { toast("Couldn't reach the ship's nets — clip not played."); sbPlaying = null; renderSoundboard(); return; }
  }

  sbPlaying = sbKey; renderSoundboard();
  const where = net.cfg.name + (broadcast ? (shipwide ? " (1MC)" : " (nest)") : "");
  addLog("tx", where, "1MC — " + name + " — piped by " + callsign);
  /* tell everyone else on the net who keyed it; the audio alone doesn't say */
  try { ipcRenderer.send("send-text", { idx: net.idx, message: "1MC — " + callsign + " piped " + name }); } catch (e) {}

  /* NO local monitor — command's 1.0.1 call. Piping a clip while listening to
     a subnet of the same ship played it TWICE (the monitor plus the delayed
     net copy through that other session). The button highlight, the COMM LOG
     "TX" line and the net chat line are the sender's confirmation; operators
     tuned into a target subnet hear the real thing like everyone else. Note
     murmur never echoes a session's own transmission back to it, so with only
     the ship group tuned the sender intentionally hears nothing. */

  const enc = new OpusScript(48000, 1, OpusScript.Application.AUDIO);
  const i16 = new ArrayBuffer(FRAME * 2), i16view = new DataView(i16);
  let pos = 0;
  /* ── pacing ──
     setInterval(…, 20) drifts, and Electron throttles renderer timers hard when
     the window isn't focused — which for this app is the normal case, because
     you're in the game. That throttling is what made clips stutter and drop out
     mid-playback. So we work from the clock: on every tick, send however many
     20 ms frames are actually due. A late tick catches up instead of losing
     audio. (backgroundThrottling is also disabled on the window now, which
     stops the timer being starved in the first place — this is the belt to
     that's braces.) */
  const started = performance.now();
  let sent = 0;
  const finish = (ok) => {
    clearInterval(pump);
    if (ok) { try { ipcRenderer.send("tx-frame", { idx: net.idx, frame: enc.encode(new ArrayBuffer(FRAME * 2), FRAME), last: true, broadcast: broadcast }); } catch (e) {} }
    try { enc.delete(); } catch (e) {}
    sbPlaying = null; renderSoundboard();
  };
  const pump = setInterval(() => {
    if (!connected || !net.tuned || net.idx == null) return finish(false);
    const due = Math.floor((performance.now() - started) / 20) + 1;
    let guard = 0;
    while (sent < due && pos < len && guard++ < 50) {     /* cap the catch-up burst */
      for (let i = 0; i < FRAME; i++) {
        const v = pos + i < len ? mono[pos + i] * norm : 0;
        i16view.setInt16(i * 2, (Math.max(-1, Math.min(1, v)) * 32767) | 0, true);
      }
      pos += FRAME; sent++;
      try { ipcRenderer.send("tx-frame", { idx: net.idx, frame: enc.encode(i16, FRAME), last: false, broadcast: broadcast }); } catch (e) {}
    }
    if (pos >= len) finish(true);
  }, 20);
}

/* ══ IPC: voice / roster / chat ══ */
function onRx(r) {
  const conn = nets.findIndex(x => x.idx === r.idx); if (conn < 0) return;
  /* My own voice arriving on ANOTHER of my connections: murmur never echoes a
     transmission to the session that sent it, but LSN ALL's listener is a
     second session in the same channel and hears me like anyone else — the
     "echo when I'm LSN ALL and transmit on a net" report. Wire names are
     CALLSIGN|freq; the stack strips the freq before it reaches here. */
  if (callsign && String(r.name || "").split("|")[0].trim().toUpperCase() === callsign.toUpperCase()) return;
  /* A ship group carries several subnets down one connection. The AUDIO stays on
     the group's own chain — LSN ALL is one ship, one volume — but the display
     follows the net the speaker is actually standing in, so the log and the
     lit-up row name the subnet rather than the ship.
     If that subnet is separately tuned and monitored, its own connection is
     already delivering this audio; drop the group's copy instead of doubling it. */
  let i = conn;
  if (nets[conn].group && r.chan) {
    const sub = nets.findIndex(x => x.cfg.name === r.chan);
    if (sub >= 0) {
      if (nets[sub].tuned && nets[sub].mon) return;
      i = sub;
    }
  }
  if (!nets[conn].mon) return;
  const n = nets[i];
  playFrame(nets[conn], r.session, r.opus);   /* always a net with a live chain */
  const first = (n.speaking.get(r.session) || 0) <= Date.now();
  n.speaking.set(r.session, Date.now() + 350);
  if (first) {
    if (!n.roster.has(r.session)) n.roster.set(r.session, r.name);
    if (fx && !n.tx) chirpDown();
    addLog("sys", n.cfg.name, "RX — " + r.name);
    netDyn(i); sendOv();
    setTimeout(() => { if ((n.speaking.get(r.session) || 0) <= Date.now()) { n.speaking.delete(r.session); squelchTail(n); netDyn(i); sendOv(); } }, 420);
  }
}
ipcRenderer.on("rx", (ev, r) => onRx(r));
setInterval(() => { /* decay sweep for stuck speakers */
  const now = Date.now();
  nets.forEach((n, i) => {
    let changed = false;
    for (const [s, until] of n.speaking) if (until <= now) { n.speaking.delete(s); changed = true; }
    if (changed) { netDyn(i); sendOv(); }
  });
}, 500);
ipcRenderer.on("roster", (ev, r) => {
  const i = nets.findIndex(x => x.idx === r.idx); if (i < 0) return;
  const n = nets[i];
  n.roster = new Map(r.users.map(u => [u.session, u.name]));
  netDyn(i);
});
ipcRenderer.on("chat", (ev, m) => {
  const i = nets.findIndex(x => x.idx === m.idx); if (i < 0) return;
  const n = nets[i];
  n.chat.push({ t: utc(), from: m.from, msg: m.message, mine: false });
  if (n.chat.length > 300) n.chat.shift();
  addLog("chatline", n.cfg.name, m.from + ": " + m.message);
  if (i === selectedI) { renderChat(); renderChat2(); }
});
/* one send path, two inputs: the CHAT page's and the board's mini-panel */
function sendChatFrom(inputEl) {
  const n = sel(), v = inputEl.value.trim();
  if (!n || !n.tuned || !n.mon || !v) return;
  ipcRenderer.send("send-text", { idx: n.idx, message: v });
  n.chat.push({ t: utc(), from: callsign, msg: v, mine: true });
  addLog("chatline", n.cfg.name, callsign + ": " + v);
  inputEl.value = ""; renderChat(); renderChat2();
}
function sendChat() { sendChatFrom($("chatIn")); }
$("chatSend").addEventListener("click", sendChat);
$("chatTabs").addEventListener("click", (e) => {
  const b = e.target.closest("[data-ci]"); if (!b) return;
  selectedI = +b.dataset.ci; renderNets(); renderChatTabs(); renderChat();
});
$("chatIn").addEventListener("keydown", (e) => { if (e.key === "Enter") sendChat(); e.stopPropagation(); });
$("chatSend2").addEventListener("click", () => sendChatFrom($("chatIn2")));
$("chatIn2").addEventListener("keydown", (e) => { if (e.key === "Enter") sendChatFrom($("chatIn2")); e.stopPropagation(); });
/* ── board chat height ──
   The divider under the chat panel is the operator's call: drag down for more
   chat, up for more COMM LOG. Persisted like the rail width. */
(function () {
  const feed = $("chatFeed2"), sp = $("vsplit");
  feed.style.height = Math.max(56, Math.min(600, Number(store.get("commsChatH", 140)) || 140)) + "px";
  let dragging = false, startY = 0, startH = 0;
  sp.addEventListener("pointerdown", (e) => {
    dragging = true; startY = e.clientY; startH = feed.getBoundingClientRect().height;
    sp.classList.add("drag"); sp.setPointerCapture(e.pointerId); e.preventDefault();
  });
  sp.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const h = Math.max(56, Math.min(window.innerHeight * 0.6, startH + (e.clientY - startY)));
    feed.style.height = h + "px";
  });
  const stop = () => { if (!dragging) return; dragging = false; sp.classList.remove("drag");
    store.set("commsChatH", parseInt(feed.style.height, 10) || 140); };
  sp.addEventListener("pointerup", stop);
  sp.addEventListener("pointercancel", stop);
})();
/* ── automatic reconnect ──
   Operations run for hours. A net that drops — a router blip, a Wi-Fi roam, a
   missed keepalive under game load — should heal itself rather than leaving an
   operator silently off comms until they happen to look at the board.
   Attempts back off (4s, 8s, 16s, 30s, then every 60s) and are staggered per
   net, because one connection per net means a network blip drops several at
   once and reconnecting them all at the same instant is exactly what trips
   murmur's per-IP rate guard. It gives up only when you disconnect or detune. */
const relinking = new Map();
function stopRelink(name) {
  const t = relinking.get(name);
  if (t) { clearTimeout(t.timer); relinking.delete(name); }
}
function scheduleRelink(i) {
  const n = nets[i];
  if (!n || !connected) return;
  const prev = relinking.get(n.cfg.name) || { tries: 0 };
  const tries = prev.tries + 1;
  /* 4s, 8s, 16s, 32s, then capped at 60s (exponent must reach past the cap or
     the 60s tier is dead code — it was, for a while) */
  const wait = Math.min(60000, 4000 * Math.pow(2, Math.min(4, tries - 1))) + Math.random() * 1500 + i * 250;
  n.relinking = true;
  const timer = setTimeout(async () => {
    if (!connected || !n.relinking) { stopRelink(n.cfg.name); renderNets(); return; }
    const ok = await tuneNet(i, true);
    if (ok) {
      stopRelink(n.cfg.name); n.relinking = false;
      addLog("sys", n.cfg.name, "link restored after " + tries + (tries === 1 ? " try" : " tries"));
      toast(n.cfg.name + " reconnected.");
      if (n.lsnAll) ipcRenderer.invoke("listen-all", { idx: n.idx, on: true, names: subnetNamesOf(n) });
      if (n.txAll || n.bcast) ipcRenderer.invoke("arm-broadcast", n.idx);
    } else if (n.denied) {          /* refused on purpose — stop trying */
      stopRelink(n.cfg.name); n.relinking = false;
      addLog("sys", n.cfg.name, "reconnect abandoned — access denied");
    } else scheduleRelink(i);
    renderNets();
  }, wait);
  relinking.set(n.cfg.name, { tries, timer });
  renderNets();
}
ipcRenderer.on("net-down", (ev, r) => {
  const i = nets.findIndex(x => x.idx === r.idx); if (i < 0) return;
  const n = nets[i];
  txSet.delete(n.idx); txEndPending.delete(n.idx); bcastIdx.delete(n.idx); txReasons(n).clear();
  n.tuned = false; n.idx = null; n.tx = false;
  if (connected) {
    addLog("sys", n.cfg.name, "LINK LOST — reconnecting");
    scheduleRelink(i);
  } else renderNets();
});
ipcRenderer.on("net-error", (ev, r) => toast("Net error: " + r.error));
/* the governor opened its circuit: every reconnect is now held locally so the
   relay's ban can lift. Tell the operator once, in their terms. */
ipcRenderer.on("dial-hold", (ev, h) => {
  const s = Math.ceil(((h && h.heldForMs) || 0) / 1000);
  addLog("sys", "", "the relay is rate-limiting this network — holding ALL reconnects for " +
    fmtHold(s) + " so the ban can lift. Nets relink on their own afterwards.");
  if (!$("connectOv").classList.contains("hidden")) holdConnect(s);
});

/* ══ PTT button + rail buttons ══ */
$("ptt").addEventListener("pointerdown", (e) => { e.preventDefault(); pttAll(true);
  const end = () => { pttAll(false); window.removeEventListener("pointerup", end); };
  window.addEventListener("pointerup", end); });
$("pttKeyChange").addEventListener("click", () => { capturing = { kind: "master", which: "active" }; $("pttKeyLbl").textContent = "PRESS…"; });
$("micBtn").addEventListener("click", () => ensureMic());
$("openMicBtn").addEventListener("click", () => setOpenMic(!openMic));
$("overrideBtn").addEventListener("click", () => setOverride(!override));

/* ══ CONNECT / SIGN-IN ══ */
let acct = null; // public account state only; relay credentials stay in Electron main
const discordMode = !!(pkg.accounts && pkg.accounts.url && pkg.accounts.discordClientId) && !bridge.autotestHost;
if (discordMode && cmdToken) { cmdToken = ""; store.set("cmdToken", ""); }
/* HEAL: a 2026-08-30 autotest run against a REAL profile persisted its
   loopback host into hostOverride, leaving that app dialing the operator's
   own machine forever after — surfaced as "rate-limiting" (v0.12.13) and
   "relay isn't answering" (v0.12.14) with the relay perfectly healthy.
   Outside the rig, a loopback override can only be that pollution: drop it.
   (Deliberate local-relay testing re-enters it per session.) */
if (!bridge.autotestHost && /^(127\.|localhost$|::1$|\[::1\]$)/i.test(store.get("hostOverride", "")))
  store.set("hostOverride", "");
function currentHost() { return store.get("hostOverride", "") || pkg.server.host; }
$("relayname").textContent = pkg.org.toUpperCase();
$("relayedit").addEventListener("click", () => { $("hostrow").style.display = "flex"; $("hostIn").value = currentHost(); $("hostIn").focus(); });
function renderCsList() { $("csList").innerHTML = myCallsigns.map(c => '<option value="' + escAttr(c) + '">').join(""); }
$("csIn").value = callsign;
async function doConnect(cs, btn) {
  const host = ($("hostrow").style.display !== "none" ? $("hostIn").value.trim() : currentHost());
  if (!cs) { $("connErr").textContent = "Enter a callsign."; return; }
  callsign = cs;
  if (myCallsigns.indexOf(cs) < 0) myCallsigns.unshift(cs);
  store.set("callsign", cs); store.set("callsigns", myCallsigns.slice(0, 12));
  /* An override equal to the shipped host is CLEARED, not merely left unset —
     a stale override used to be immortal (typing the correct host dialed
     right once, then next launch went back to the stale value). Never persist
     the autotest rig's host into any profile. */
  if (!bridge.autotestHost) store.set("hostOverride", host !== pkg.server.host ? host : "");
  renderCsList();
  /* disabled while the invoke is in flight — mashing CONNECT used to launch
     one full control dial per click, each superseding the last mid-handshake */
  $("connErr").textContent = ""; btn.textContent = "CONNECTING…";
  connBtns().forEach(b => { b.disabled = true; });
  /* Arrive tuned to NOTHING. FleetComm used to auto-tune whatever the package
     flagged, so operators were dropped onto live nets they never chose — and it
     opened a relay connection for each one. You now pick your own nets; the
     relay link itself is a single silent control connection. */
  const wanted = [];
  let res;
  try {
    res = await ipcRenderer.invoke("connect", {
      host, port: pkg.server.port, callsign: cs,
      nets: wanted.map(i => ({ name: nets[i].cfg.name, freq: nets[i].cfg.freq, channel: nets[i].cfg.name })),
      token: !discordMode && cmdToken ? cmdToken : null
    });
  } catch (error) {
    $("connErr").textContent = "Connection failed: " + (error.message || "unknown error");
    return;
  } finally {
    btn.textContent = "CONNECT ▸";
    /* a hold countdown owns the buttons; otherwise hand them back */
    if (Date.now() >= holdUntilTs) connBtns().forEach(b => { b.disabled = false; });
  }
  if (!Array.isArray(res)) {
    $("connErr").textContent = "Connection failed: FleetComm received an invalid relay response.";
    return;
  }
  const okCount = res.filter(r => r.ok).length;
  /* an empty result set is success now: connected, tuned to nothing */
  if (!res.length) {
    connectFails = 0;
    await afterConnect(cs);
    addLog("sys", "", "relay online — tuned to nothing. Pick the nets you want.");
    toast("Connected. You're not on any net yet — tune the ones you need.");
    return;
  }
  if (!okCount) {
    const raw = (res[0] && res[0].error) || "unknown";
    /* Retrying immediately is what keeps the guard tripped, so count the
       attempt down out loud and hold the button rather than letting an anxious
       operator hammer it. The dial governor in main already knows how long the
       hold must be — when it speaks, use ITS number (a ban outlasts any
       guesswork ladder); otherwise fall back to the short escalating hold. */
    const holdSaid = /^relay hold\b[^]*?(\d+)s/i.exec(raw);
    if (holdSaid) {
      holdConnect(Math.min(900, Number(holdSaid[1])));
    } else if (/ECONNRESET|EPIPE|socket hang up|reset by peer|closed during handshake|disconnected before secure/i.test(raw)) {
      /* accepted-then-dropped: the rate-limit signature — keep this family in
         step with banScented in src/radio-stack.js */
      connectFails++;
      holdConnect(Math.min(45, 8 * connectFails));
    } else if (/ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ENETDOWN|handshake timed out/i.test(raw)) {
      /* nothing answered: the relay is down or restarting — a different
         problem, and calling it rate-limiting sent people down the wrong road */
      connectFails++;
      holdConnect(Math.min(30, 5 * connectFails),
        "The relay isn't answering — it may be down or restarting;");
    } else $("connErr").textContent = "Could not tune any nets: " + raw;
    return;
  }
  connectFails = 0;
  res.forEach((r, k) => {
    if (!r.ok) { addLog("sys", nets[wanted[k]].cfg.name, "tune failed: " + r.error); return; }
    const n = nets[wanted[k]];
    n.tuned = true; n.idx = r.idx; makeChain(n);
    if (!n.mon) ipcRenderer.send("net-mute", { idx: n.idx, muted: true });
    /* Keys are the operator's to choose. FleetComm used to stamp the package's
       defaultKey onto any unbound net, so people found F1 on COMMAND NET and F3
       on ALPHA SQDN without ever setting them — keys that collide with the game.
       defaultKey now only decides which nets auto-tune, never what they bind. */
  });
  await afterConnect(cs);
}
/* Everything that follows a successful relay link, whether or not any net was
   tuned. Arriving tuned to nothing is a normal, successful connection. */
async function afterConnect(cs) {
  connected = true;
  /* the callsign is THIS session's (a tactical name — TIBER DOC 1 — not the
     operator's identity): the service files it on the session, never on the
     account, so the site's callsign is left alone. Older services returned
     no sessionCallsign and stored it on the account; comparing against the
     account field there keeps the old behaviour until the droplet is updated. */
  if (acct && cs !== (acct.account.sessionCallsign !== undefined ? acct.account.sessionCallsign : acct.account.callsign)) ipcRenderer.invoke("acct", { method: "POST", path: "/api/callsign", body: { callsign: cs } });
  await syncTreeFromRelay();
  const firstTuned = nets.findIndex(n => n.tuned);
  selectedI = firstTuned >= 0 ? firstTuned : 0;
  $("connectOv").classList.add("hidden");
  $("relayLbl").className = "v ok"; $("relayLbl").textContent = "LIVE · " + pkg.shortname;
  const roleTxt = acct ? acct.account.role.toUpperCase() : (cmdToken ? "COMMAND" : "OPERATOR");
  $("opchip").style.display = ""; $("opname").textContent = callsign;
  $("oprole").textContent = roleTxt === "OPERATOR" ? "" : roleTxt;
  $("authName").textContent = callsign; $("authRole").textContent = roleTxt;
  $("acctKey").style.display = (acct && acct.account.role === "command") ? "" : "none";
  addLog("sys", "", "operator " + callsign + " authenticated (" + roleTxt + ")");
  /* the walkthrough's hand-off: it stopped at "sign in", we are now signed in */
  if (!bridge.autotestHost && !store.get("tutDone", false) && (store.get("tutPending", false) || (tut.on && tut.phase === "quarterdeck")))
    setTimeout(() => tutOpen("board"), 1200);
  renderNets(); chirpDown(); pollOps();
  /* first ship's-state paint without waiting out the 12s poll */
  try { renderShipState(await ipcRenderer.invoke("atc-view")); } catch (e) {}
}
$("connectBtn").addEventListener("click", function () { doConnect($("csIn").value.trim().toUpperCase(), this); });
$("connectLegacyBtn").addEventListener("click", function () { doConnect($("csInLegacy").value.trim().toUpperCase(), this); });

/* Discord sign-in flow */
function applyLogin(r) {
  acct = { account: r.account, authorized: !!r.authorized };
  cmdToken = r.account.role === "command" ? "account-command" : "";
  refreshSounds();   /* COMMAND gates the 1MC; the fleet library loads at sign-in */
  if (connected) {
    $("oprole").textContent = r.account.role === "member" ? "" : r.account.role.toUpperCase();
    $("authRole").textContent = r.account.role.toUpperCase();
    $("acctKey").style.display = r.account.role === "command" ? "" : "none";
    renderTxTargets();
  }
  if (r.account.role === "pending" || !r.authorized) {
    $("pendingBox").style.display = "block";
    $("csRow2").style.display = "none"; $("connectBtn").style.display = "none";
    return;
  }
  $("pendingBox").style.display = "none";
  $("csRow2").style.display = "flex"; $("connectBtn").style.display = "block";
  /* last one used first — the site's name is the fallback for a first
     session, not the default for every op */
  $("csIn").value = callsign || r.account.callsign || "";
  loadIdentity();
  applyAlliedMode(r.account);
  $("discordBtn").textContent = "✓ " + r.account.discordName.toUpperCase() + " — " + r.account.role.toUpperCase();
  $("discordBtn").disabled = true;
}
if ($("discordBtn")) $("discordBtn").addEventListener("click", async function () {
  this.textContent = "WAITING FOR DISCORD… (check your browser)";
  let r;
  try {
    r = await ipcRenderer.invoke("discord-login", { bootstrapToken: $("bootstrapIn").value.trim() });
  } catch (error) {
    this.textContent = "SIGN IN WITH DISCORD ▸";
    $("connErr").textContent = "Sign-in failed: " + (error.message || "unknown error");
    return;
  }
  if (!r.ok) {
    this.textContent = "SIGN IN WITH DISCORD ▸";
    if (r.bootstrapRequired) { $("bootstrapRow").style.display = "flex"; $("bootstrapIn").focus(); }
    $("connErr").textContent = r.unconfigured ? "Discord sign-in isn't configured yet." : ("Sign-in failed: " + (r.error || "unknown"));
    return;
  }
  $("connErr").textContent = "";
  applyLogin(r);
});
if ($("recheckBtn")) $("recheckBtn").addEventListener("click", async () => {
  const r = await ipcRenderer.invoke("acct", { method: "GET", path: "/api/me" });
  if (r.ok) applyLogin(r); else toast(r.error || "still pending");
});
$("disconnBtn").addEventListener("click", () => {
  camTeardownAll();      /* cams and their peer links die with the session */
  clearTxState(); ipcRenderer.send("disconnect"); connected = false;
  if (discordMode) {
    acct = null; cmdToken = ""; refreshSounds(); showSignedAs(null); applyAlliedMode(null);
    $("discordBtn").disabled = false; $("discordBtn").textContent = "SIGN IN WITH DISCORD ▸";
    $("pendingBox").style.display = "none"; $("bootstrapRow").style.display = "none";
    $("csRow2").style.display = "none"; $("connectBtn").style.display = "none";
    $("bootstrapIn").value = "";
  }
  buildNets(); renderNets(); showPage("pgComms");
  $("connectOv").classList.remove("hidden");
  $("relayLbl").className = "v dim"; $("relayLbl").textContent = "OFFLINE";
  $("opchip").style.display = "none";
  /* the ops count and ship rows used to freeze at their last live values */
  $("opsCount").textContent = "0";
  renderShipState([]);
});

/* ══ ATC + operators count + ship's state ══ */
/* people, not sessions: every operator also holds a silent "NAME|ctl"
   connection, so counting raw usernames ran double — filter the ghosts */
function opNames(view) {
  const s = new Set();
  view.forEach(c => c.users.forEach(u => { if (!/\|ctl$/.test(u)) s.add(u); }));
  return s;
}
/* ── Ship's State: which ships of the line are actually crewed ──
   Command asked what this block was for. As of 1.0.1 it answers the question
   a glance should answer: one row per ship group, with the live operator
   headcount across the ship and every net aboard her — fed by the same
   atc-view poll as the ops count, so it works untuned and updates every 12s. */
function renderShipState(view) {
  const box = $("shipStateRows");
  if (!box) return;
  if (!Array.isArray(view)) view = [];
  /* a transient empty view mid-session is "no information", not "all hands
     abandoned ship" — keep the last readout until disconnect clears it */
  if (!view.length && connected) return;
  const kids = new Map();
  view.forEach(c => { const k = kids.get(c.parent); if (k) k.push(c); else kids.set(c.parent, [c]); });
  const crewOf = (row) => {
    const names = new Set();
    const walk = (r) => {
      r.users.forEach(u => { if (!/\|ctl$/.test(u)) names.add(u); });
      (kids.get(r.id) || []).forEach(walk);
    };
    walk(row);
    return names.size;
  };
  let ships = view.filter(c => c.ship === true);
  /* channels made before net-meta carried the ship flag decode to null —
     fall back to the ships the package config knows about */
  if (!ships.length) {
    const shipNames = new Set(nets.filter(n => n.cfg.ship).map(n => n.cfg.name));
    ships = view.filter(c => shipNames.has(c.name));
  }
  box.innerHTML = ships.map(s => {
    const n = crewOf(s);
    return '<div class="rd"><label title="' + escAttr(s.name) + '">' + esc(s.name) + '</label>' +
      '<span class="v num ' + (n ? "ok" : "dim") + '">' + n + (n === 1 ? " OP" : " OPS") + '</span></div>';
  }).join("");
}
async function refreshAtc() {
  const view = await ipcRenderer.invoke("atc-view");
  const boxes = view.filter(c => c.id !== 0);
  $("atcCount").textContent = opNames(view).size;
  $("atcGrid").innerHTML = boxes.map(c => {
    /* same verb as the channel column — one action, one word. A net you are
       already tuned to says so instead of offering a redundant dial. */
    const mine = nets.some(n => n.tuned && n.cfg.name === c.name);
    return '<div class="atcbox"><h4>' + esc(c.name) + '<span class="c">' + c.users.length + '</span></h4>' +
    '<div class="who">' + (c.users.length
      ? c.users.map(u => "<i>" + esc(u.replace(/\|/g, " · ")) + "</i>").join("")
      : '<span class="empty">NO OPERATORS</span>') + '</div>' +
    (mine ? '<button class="tunelink here" disabled>ON THIS NET</button>'
          : '<button class="tunelink" data-name="' + escAttr(c.name) + '" data-freq="' + escAttr(c.freq || "") + '" data-ship="' + (c.ship ? "1" : "") + '">TUNE ▸</button>') + '</div>';
  }).join("");
}
$("atcGrid").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-name]"); if (!b) return;
  const nm = b.dataset.name;
  let i = nets.findIndex(n => n.cfg.name === nm);
  if (i < 0) {
    /* Carry the REAL freq from the ATC view onto the card. The em-dash
       placeholder is display-only: radio-stack refuses to put a non-frequency
       in the wire username, but sending the real one keeps every other client
       naming this session "CALLSIGN|NNN.NNN" like any hand-tuned net. */
    const freq = /^\d{1,3}\.\d{3}$/.test(b.dataset.freq || "") ? b.dataset.freq : "———.———";
    const ship = b.dataset.ship === "1";
    nets.push({ cfg: { name: nm, freq, enc: false, ship, subnets: [] }, depth: 0, parent: null, tuned: false, idx: null, mon: true, txOn: false, vol: 75, pan: 0, bind: null, bcast: false, group: ship, lsnAll: false, txAll: false, roster: new Map(), speaking: new Map(), chat: [], tx: false });
    i = nets.length - 1;
  }
  showPage("pgComms");
  await tuneNet(i);
  selectedI = i; renderNets();
});
function showPage(id) {
  if ((id === "pgAtc" || id === "pgCam") && !connected) { toast("Connect first."); return; }
  const leavingSys = document.getElementById("settings").classList.contains("on") && id !== "settings";
  if (leavingSys && !discordMode) { cmdToken = $("tokenIn").value.trim(); store.set("cmdToken", cmdToken); renderTxTargets(); refreshSounds(); }
  document.querySelectorAll(".page").forEach(p => p.classList.toggle("on", p.id === id));
  document.querySelectorAll(".pkey").forEach(k => k.classList.toggle("on", k.dataset.page === id));
  if (id === "pgAtc") refreshAtc();
  if (id === "pgCam") camScan();
  if (id === "pgAcct") refreshAccts();
  if (id === "pgChat") { renderChatTabs(); renderChat(); }
  if (id === "settings" && !discordMode) $("tokenIn").value = cmdToken;
  /* opening SYS re-pulls the fleet library, so clips another COMMAND account
     just added appear without a re-sign-in */
  if (id === "settings") refreshSounds();
}
document.querySelectorAll(".pkey").forEach(k => k.addEventListener("click", () => {
  showPage(k.dataset.page);
  document.body.classList.remove("rail-open");
}));
let opsTimer = null;
function pollOps() {
  clearInterval(opsTimer);
  /* The account heartbeat used to eject on ANY failed poll — one ECONNRESET out
     of ~300 requests an hour tore down every tuned net and the Discord session,
     while the voice connections rode the same blip out on TCP retransmit.
     src/acct-heartbeat.js now separates a server VERDICT (expired, revoked —
     sign out) from a transport blip (hold: stay on comms, keep polling). */
  let acctFails = 0, polling = false;
  opsTimer = setInterval(async () => {
    if (!connected) return;
    /* a hung poll can take the full request timeout — as long as the interval
       itself — so ticks would overlap and double-count the failure streak */
    if (polling) return;
    polling = true;
    try {
    const view = await ipcRenderer.invoke("atc-view");
    $("opsCount").textContent = opNames(view).size;
    renderShipState(view);
    /* A net created mid-session by another COMMAND account used to exist only
       on the relay: the COMMS board was merged with the tree exclusively after
       our OWN connects and edits, so everyone else stared at a board that
       didn't have it (and the ATC page, which DID show it, then tuned it with
       a placeholder freq — the InvalidUsername reject). Ride the poll we are
       already paying for. Skip while ANY gesture holds live board state — a
       row drag mid-flight, a key capture armed, or the net-properties dialog
       open (dlgIdx is a raw index; a re-sync reindexing nets[] under it would
       aim APPLY at the wrong net, relay-wide). */
    if (!rowDragging && !capturing && !document.getElementById("dlg").classList.contains("on")) {
      const treeChanged = await syncTreeFromRelay();
      if (treeChanged && document.getElementById("pgAtc").classList.contains("on")) refreshAtc();
    }
    if (discordMode) {
      const current = await ipcRenderer.invoke("acct", { method: "GET", path: "/api/me" });
      if (current && current.ok && current.account) applyAlliedMode(current.account);
      const verdict = bridge.acctHeartbeat.assess(current, acctFails);
      acctFails = verdict.fails;
      if (verdict.warn) addLog("sys", "", "accounts service unreachable — staying on comms, still checking");
      if (verdict.action === "eject") {
        $("disconnBtn").click();
        toast(verdict.reason);
      } else if (verdict.action === "ok" && (!acct || current.account.role !== acct.account.role)) {
        applyLogin(current);
        toast("Your FleetComm role is now " + current.account.role.toUpperCase() + ".");
      }
    }
    } finally { polling = false; }
  }, 12000);
}

/* ══ header / settings / theme wiring ══ */
/* Accounts endpoint — editable so a build that points somewhere dead can be
   recovered by the operator instead of waiting for a new release. */
async function refreshAcctEp() {
  const r = await bridge.ipc.invoke("accounts-endpoint", { get: true });
  if (!r) return;
  $("acctEp").value = r.override || "";
  $("acctEp").placeholder = r.shipped || "http://host:port";
  /* the guidance always shows; warnings are added to it, not swapped for it */
  const parts = ["Leave this alone unless sign-in is broken and you have been told to change it. " +
                 "It is where FleetComm checks who you are — not the voice relay."];
  if (r.override) parts.push("Overridden — this build shipped with " + r.shipped);
  if (r.note) parts.push(r.note);
  $("acctEpNote").textContent = parts.join("  ·  ");
  $("acctEpNote").classList.toggle("bad", !!(r.override || r.insecure));
}
$("acctEpSave").addEventListener("click", async function () {
  const r = await bridge.ipc.invoke("accounts-endpoint", { url: $("acctEp").value.trim() });
  if (r && r.ok === false) { toast("Not saved — " + r.error); return; }
  await refreshAcctEp();
  toast("Accounts service set to " + (r.active || "the shipped default") + ". Sign in again.");
});
$("acctEpReset").addEventListener("click", async function () {
  await bridge.ipc.invoke("accounts-endpoint", { url: "" });
  await refreshAcctEp();
  toast("Back to the address this build shipped with.");
});
$("sfontsel").addEventListener("change", function () { uiFont = this.value; applyFont(); });
$("snametrunc").addEventListener("click", () => { nameTrunc = !nameTrunc; applyNameTrunc(); });
$("sscanfx").addEventListener("click", () => { camScanFx = !camScanFx; applyCamScanFx(); });
$("scaleup").addEventListener("click", () => bumpScale(0.1));
$("scaledn").addEventListener("click", () => bumpScale(-0.1));
$("scalereset").addEventListener("click", () => { uiScale = 1; applyScale(); });
window.addEventListener("keydown", (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  if (e.key === "=" || e.key === "+") { bumpScale(0.1); e.preventDefault(); }
  else if (e.key === "-" || e.key === "_") { bumpScale(-0.1); e.preventDefault(); }
  else if (e.key === "0") { uiScale = 1; applyScale(); e.preventDefault(); }
});
$("themebtn").addEventListener("click", () => { themeMode = dark ? "light" : "dark"; applyTheme(); });
/* narrow windows: the command rail slides off-canvas; the burger brings it back */
$("railBurger").addEventListener("click", (e) => { e.stopPropagation(); document.body.classList.toggle("rail-open"); });
$("railScrim").addEventListener("click", () => document.body.classList.remove("rail-open"));
$("sthemesel").addEventListener("change", function () { themeMode = this.value; applyTheme(); });
Object.keys(THEME_DEFAULTS).forEach(k => {
  const el = $("c_" + k); if (!el) return;
  el.addEventListener("input", function () { customTheme[k] = this.value; themeMode = "custom"; applyTheme(); });
});
$("themeReset").addEventListener("click", () => { customTheme = Object.assign({}, THEME_DEFAULTS); applyTheme(); toast("Palette reset to dark defaults."); });
$("closeSet").addEventListener("click", () => showPage("pgComms"));
$("sfx").addEventListener("click", function () { fx = !fx; this.classList.toggle("on", fx); store.set("fx", fx); if (fx) chirpDown(); });
/* rebuild every tuned chain at the current dial and audition the result */
function applyFxDial() {
  nets.forEach(n => { if (n.tuned) wireChain(n); });
  const t = nets.find(n => n.tuned); if (t) squelchTail(t); else chirpDown();
}
/* keep the select and the slider telling the same story: on an anchor the
   select names it, between anchors it reads Custom (a hidden option that only
   exists while the dial is off-preset) */
function renderFxDial() {
  $("fxSl").value = fxIntensity;
  $("fxVal").textContent = fxIntensity;
  const preset = bridge.fxCurve.presetAt(fxIntensity);
  $("fxCustomOpt").hidden = !!preset;
  $("fxsel").value = preset || "custom";
  if (preset) { fxPreset = preset; store.set("fxPreset", fxPreset); }
}
$("fxsel").addEventListener("change", function () {
  if (this.value === "custom") return;               /* placeholder, not a choice */
  fxPreset = this.value; store.set("fxPreset", fxPreset);
  fxIntensity = Math.round(bridge.fxCurve.anchorValue(fxPreset));
  store.set("fxIntensity", fxIntensity);
  renderFxDial(); applyFxDial();
});
/* live readout while dragging; the chain rebuild waits for release so RX audio
   doesn't click through a rebuild per pixel of travel */
$("fxSl").addEventListener("input", function () { $("fxVal").textContent = this.value; });
$("fxSl").addEventListener("change", function () {
  fxIntensity = Math.max(0, Math.min(100, Math.round(Number(this.value) || 0)));
  store.set("fxIntensity", fxIntensity);
  renderFxDial(); applyFxDial();
});
$("ovbtn").addEventListener("click", () => ipcRenderer.send("ov-toggle"));
ipcRenderer.on("ov-shown", (ev, shown) => { $("ovbtn").classList.toggle("onov", shown); if (!shown) $("sovedit").classList.remove("on"); });
$("sovedit").addEventListener("click", function () {
  const on = !this.classList.contains("on");
  this.classList.toggle("on", on); ipcRenderer.send("ov-edit", on);
});
ipcRenderer.on("ov-edit-state", (ev, on) => $("sovedit").classList.toggle("on", on));

/* ── overlay controls beside AUTHENTICATED ──
   Moving the overlay means watching it move, which you can't do from inside the
   SYS page. These mirror the SYS switches so both stay in step. */
let ovShown = false, ovEditing = false;
function renderOverlayBox() {
  $("ovShowBtn").classList.toggle("on", ovShown);
  $("ovShowBtn").textContent = ovShown ? "HIDE" : "SHOW";
  $("ovEditBtn").disabled = !ovShown;
  $("ovEditBtn").classList.toggle("editing", ovEditing);
  $("ovEditBtn").textContent = ovEditing ? "LOCK IT ▸" : "UNLOCK · MOVE";
  $("ovHint").textContent = !ovShown ? "off"
    : ovEditing ? "drag it where you want it, then LOCK IT"
    : "on — click through it while you play";
}
$("ovShowBtn").addEventListener("click", () => ipcRenderer.send("ov-toggle"));
$("ovEditBtn").addEventListener("click", function () {
  if (!ovShown) return;
  ovEditing = !ovEditing;
  $("sovedit").classList.toggle("on", ovEditing);
  ipcRenderer.send("ov-edit", ovEditing);
  renderOverlayBox();
});
ipcRenderer.on("ov-shown", (ev, shown) => { ovShown = !!shown; if (!shown) ovEditing = false; renderOverlayBox(); });
ipcRenderer.on("ov-edit-state", (ev, on) => { ovEditing = !!on; renderOverlayBox(); });
renderOverlayBox();
[["bindActive", "active"], ["bindCycUp", "cycUp"], ["bindCycDn", "cycDn"]].forEach(([id, which]) => {
  $(id).addEventListener("click", function () { capturing = { kind: "master", which }; this.classList.add("listen"); this.textContent = "press…"; });
});
/* updates */
function showUpdate(r) {
  $("updbar").style.display = "flex";
  $("updtext").textContent = "FleetComm v" + r.version + " is available";
  $("updbar").dataset.url = r.url; $("updbar").dataset.version = r.version;
}
ipcRenderer.on("update-available", (ev, r) => showUpdate(r));
/* ── update visibility ──
   An update used to run inside a one-line banner, and success was announced by
   a 4.6-second toast at the next launch — so a finished update and one that
   silently died looked identical, and operators couldn't say what version they
   were actually on. Two rules now:
     1. While an update runs, a full-screen state that cannot be missed.
     2. After ANY version change — auto, manual, or hand-installed exe — the
        next launch says what happened and waits for the operator to confirm
        they saw it. The last acknowledged version is the operator's own
        record; update-state.json only knows about swaps the app itself ran. */
function showUpdBusy(version, line) {
  $("updOv").dataset.version = version;
  $("updOvTitle").textContent = "UPDATING FLEETCOMM";
  $("updOvState").textContent = line;
  $("updOvNote").textContent = "FleetComm will close and reopen itself when the install finishes. " +
    "Leave it alone — don't launch it manually. If nothing happens within a minute, start it yourself; " +
    "it will tell you whether the update took.";
  $("updOvOk").style.display = "none";
  $("updOv").classList.remove("hidden");
}
function hideUpdOv() { $("updOv").classList.add("hidden"); }
/* true while the acknowledgement screen is up and unconfirmed — nothing may
   draw over it (the auto-update offer arrives seconds after launch, which is
   exactly when this screen is showing) */
let ackPending = false, deferredAutoOffer = null;
function ackVersionCheck() {
  const note = bridge.updateGuard.versionNote(store.get("ackVersion", null), bridge.version);
  if (note.store) { store.set("ackVersion", bridge.version); return; }
  if (!note.show) return;
  $("updOvTitle").textContent = note.upgraded ? "FLEETCOMM UPDATED" : "FLEETCOMM VERSION CHANGED";
  $("updOvState").textContent = "v" + note.from + "  →  v" + note.to;
  $("updOvNote").textContent = note.upgraded
    ? "The update finished. You are now running v" + note.to + "."
    : "You were last on v" + note.from + " and are now on v" + note.to +
      ". If you didn't install this yourself, a failed update may have restored an older build.";
  $("updOvOk").style.display = "";
  $("updOv").classList.remove("hidden");
  ackPending = true;
}
$("updOvOk").addEventListener("click", () => {
  store.set("ackVersion", bridge.version); hideUpdOv(); ackPending = false;
  const offer = deferredAutoOffer; deferredAutoOffer = null;
  if (offer) startAutoUpdate(offer);
});
ackVersionCheck();
/* one choreography for both the manual button and the automatic path — the
   banner and the full-screen state must never be sequenced by hand twice */
async function runUpdate(version, auto) {
  showUpdBusy(version, "Downloading FleetComm v" + version + "…");
  const res = await ipcRenderer.invoke("do-update", { version, auto: !!auto });
  if (res && res.ok) {
    $("updtext").textContent = "Update installed — restarting…";
    $("updOvState").textContent = "Installing — FleetComm is closing and will reopen itself.";
    return res;
  }
  hideUpdOv();
  /* the reason lives in the banner, which stays — a 4.6s toast is not enough
     room for "your exe is in a write-protected folder, move it" */
  $("updtext").textContent = res && res.error
    ? "Update failed: " + res.error
    : "FleetComm v" + version + " is available";
  return res || { ok: false };
}
/* what happened to the last automatic attempt, reported on the way back up */
ipcRenderer.on("update-note", (ev, note) => {
  if (!note) return;
  if (note.home) {
    if (note.first) toast("FleetComm is in your Start menu now — pin it to the taskbar from there.");
    addLog("sys", "", "persistent copy " + (note.first ? "installed" : "refreshed") + " at " + note.home +
      " — Start \u25b8 FleetComm is the one to pin; updates keep it current");
    return;
  }
  if (note.installed) { toast("Updated to FleetComm v" + note.installed + "."); addLog("sys", "", "auto-update installed v" + note.installed); return; }
  if (note.failed) {
    showUpdate({ version: note.target || "", url: (pkg.updates && pkg.updates.releases) || "" });
    $("updtext").textContent = "Automatic update didn't take — " + note.reason + ". Install it manually?";
    addLog("sys", "", "auto-update failed: " + note.reason + " — falling back to the banner");
  }
});
async function startAutoUpdate(r) {
  if (!autoUpdate || connected) return;   /* never yank the app out from under a live op */
  $("updtext").textContent = "Installing FleetComm v" + r.version + " automatically…";
  $("updgo").style.display = "none";
  const res = await runUpdate(r.version, true);
  if (res.ok) return;
  $("updgo").style.display = "";
  if (res.error) toast("Automatic update failed: " + res.error);
}
ipcRenderer.on("update-auto-offer", (ev, r) => {
  /* the acknowledgement of the LAST update outranks starting the next one —
     drawing over that screen erased the one confirmation it exists to give */
  if (ackPending) { deferredAutoOffer = r; return; }
  startAutoUpdate(r);
});
$("sautoupd").addEventListener("click", function () {
  autoUpdate = !autoUpdate; this.classList.toggle("on", autoUpdate); store.set("autoUpdate", autoUpdate);
  toast(autoUpdate ? "Updates will install automatically at launch." : "Automatic updates off — you'll get a banner instead.");
});
$("updgo").addEventListener("click", async function () {
  this.disabled = true; this.textContent = "Updating…";
  const r = await runUpdate($("updbar").dataset.version, false);
  if (r.ok) return;
  this.disabled = false; this.textContent = "Install & restart";
  if (r.error) toast("Auto-update failed (" + r.error + ") — opening the releases page instead.");
  ipcRenderer.send("open-external", $("updbar").dataset.url);
});
ipcRenderer.on("update-progress", (ev, pct) => {
  $("updtext").textContent = "Downloading update… " + pct + "%";
  if (!$("updOv").classList.contains("hidden"))
    $("updOvState").textContent = "Downloading FleetComm v" + ($("updOv").dataset.version || "") + " — " + pct + "%";
});
$("upddismiss").addEventListener("click", () => $("updbar").style.display = "none");
$("updcheck").addEventListener("click", async function () {
  this.textContent = "Checking…";
  const r = await ipcRenderer.invoke("check-updates");
  this.textContent = "Check for updates";
  if (r.status === "update") { showUpdate(r); toast("Update v" + r.version + " available — see the banner."); }
  else if (r.status === "current") toast("You're on the latest version (v" + r.version + ").");
  else if (r.status === "unconfigured") toast("Update channel not configured yet.");
  else toast("Couldn't reach the update channel: " + r.error);
});
let toastTimer = null;
function toast(msg) {
  const t = $("toast"); t.textContent = msg; t.style.display = "block";
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.style.display = "none", 4600);
}
/* channel-rail splitter */
(function () {
  const col = $("chanCol"), sp = $("split");
  const saved = store.get("railWidth", 300);
  col.style.width = saved + "px";
  let dragging = false;
  sp.addEventListener("pointerdown", (e) => { dragging = true; sp.classList.add("drag"); sp.setPointerCapture(e.pointerId); e.preventDefault(); });
  sp.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const w = Math.max(200, Math.min(560, e.clientX - col.getBoundingClientRect().left));
    col.style.width = w + "px";
  });
  const stop = () => { if (!dragging) return; dragging = false; sp.classList.remove("drag"); store.set("railWidth", parseInt(col.style.width, 10) || 300); };
  sp.addEventListener("pointerup", stop);
  sp.addEventListener("pointercancel", stop);
})();

/* clock */
/* the fleet clock: lore year (real + 930), day-of-year, UTC, "SET" suffix —
   the same ambient ritual as the org site. Still UTC underneath, so it stays
   a real ops clock; the log keeps plain utc() timestamps. */
function fleetTime() {
  /* floor, not ceil: Date.UTC(y,0,0) is Dec 31, so elapsed time on day N is
     N-point-something days — ceil() called every day N+1 all day long */
  const n = new Date();
  const doy = String(Math.floor((Date.now() - Date.UTC(n.getUTCFullYear(), 0, 0)) / 864e5)).padStart(3, "0");
  return (n.getUTCFullYear() + 930) + "." + doy + " // " + utc() + " SET";
}
const clockTick = () => { $("clock").textContent = fleetTime(); };
clockTick();
setInterval(clockTick, 1000);

/* init */
try {
  const _v = "v" + bridge.version;
  $("verlbl").textContent = "FLEETCOMM " + _v + ' — native unit: in-game PTT + overlay · developed by Rook "Doc" Sabbah, UEE 22nd Expeditionary Fleet';
  $("verlbl2").textContent = _v;
} catch (e) {}
$("sfx").classList.toggle("on", fx);
$("sautoupd").classList.toggle("on", autoUpdate);
renderFxDial();
applyFont(); applyScale(); applyNameTrunc(); applyCamScanFx(); applyTheme(); refreshAcctEp(); listAudioDevices(); renderGate(); renderCsList(); renderMasterBinds(); renderMic(); renderNets(); refreshSounds();
$("startupFail").style.display = "none";
$("signDiscord").style.display = discordMode ? "block" : "none";
$("signLegacy").style.display = discordMode ? "none" : "block";
$("legacyCommandAuth").style.display = discordMode ? "none" : "block";
if (discordMode) $("signFoot").textContent = "Access is gated: Discord confirms who you are, COMMAND decides who gets in, and the relay itself refuses anyone unapproved.";
addLog("sys", "", "FleetComm console initialized — awaiting sign-in");

/* ══ ACCOUNTS page (command) ══ */
/* ── search across ACCOUNTS & ACCESS ──
   One box, both lists. Every whitespace-separated term must match somewhere
   in the row (case-insensitive): callsign, discord name, standing, discord
   id for operators; name, frequency, access level for nets. The data is
   fetched once per refresh and filtered on every keystroke — the lists are
   small, the relay round-trip is not. Matches are marked in gold. */
let acctData = null;                              /* { accounts, access } from the last refresh */
const acctTerms = () => String($("acctSearch").value || "").toLowerCase().split(/\s+/).filter(Boolean);
const acctHits = (terms, hay) => terms.every(t => hay.includes(t));
function markHits(text, terms) {
  let s = esc(text);
  for (const t of terms) {
    if (!t) continue;
    const re = new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig");
    s = s.replace(re, (m) => "<mark class=\"hit\">" + m + "</mark>");
  }
  return s;
}
async function refreshAccts() {
  const [ra, rn] = await Promise.all([
    ipcRenderer.invoke("acct", { method: "GET", path: "/api/accounts" }),
    ipcRenderer.invoke("acct", { method: "GET", path: "/api/nets/access" }),
    loadRoster()
  ]);
  if (!ra.ok) { $("acctList").innerHTML = '<span class="hint">' + esc(ra.error || "unavailable") + "</span>"; $("acctCount").textContent = ""; return; }
  acctData = { accounts: ra.accounts, access: (rn.ok && rn.access) || {} };
  renderAccts();
  refreshAllied();
}
function renderAccts(data) {
  const d = data || acctData; if (!d) return;
  const terms = acctTerms();
  const pend = d.accounts.filter(x => x.role === "pending").length;
  $("acctPending").textContent = pend ? pend + " AWAITING APPROVAL" : "";
  const order = { pending: 0, command: 1, element: 2, member: 3, allied: 4, revoked: 5 };
  const shownAccts = d.accounts.filter(x => acctHits(terms, [fleetName(x), x.callsign, x.discordName, x.role, x.org, x.discordId, x.onAir].map(v => String(v || "")).join(" ").toLowerCase()));
  const html = shownAccts.sort((x, y) => ((order[x.role] ?? 9) - (order[y.role] ?? 9)) || String(x.discordName).localeCompare(String(y.discordName))).map(x => {
    const btns =
      (x.role === "pending" ? '<button class="ann lit-g" data-role="member">APPROVE</button>' : "") +
      (x.role === "member" ? '<button class="ann lit-g" data-role="element" title="May watch helmet cams; no COMMAND powers">ELEMENT LEAD</button>' : "") +
      /* an ally who sits in the fleet's Discord arrives as pending/member: file them under their org */
      (["pending", "member", "element"].includes(x.role) && alliedOrgs.length
        ? '<select class="orgsel" data-toallied title="File this account as ALLIED under an organization"><option value="">TO ALLIED\u2026</option>' +
          alliedOrgs.map(g => '<option value="' + escAttr(g.guildId) + '">' + esc(g.name) + '</option>').join("") + '</select>' : "") +
      (x.role === "allied" && alliedOrgs.length > 1
        ? '<select class="orgsel" data-toallied title="Move this operator to another organization">' +
          alliedOrgs.map(g => '<option value="' + escAttr(g.guildId) + '"' + (x.orgGuild === g.guildId ? " selected" : "") + '>' + esc(g.name) + '</option>').join("") + '</select>' : "") +
      (x.role === "allied" ? '<button class="ann' + (x.orgLead ? " lit-a" : "") + '" data-orglead="' + (x.orgLead ? "0" : "1") + '" title="An organization lead may create, rename and delete nets inside their own organization\u2019s nets">' + (x.orgLead ? "ORG LEAD ✓" : "MAKE ORG LEAD") + '</button>' : "") +
      (x.role === "element" || x.role === "allied" ? '<button class="ann" data-role="member">TO MEMBER</button>' : "") +
      (x.role === "member" || x.role === "element" ? '<button class="ann lit-c" data-role="command">PROMOTE</button>' : "") +
      (x.role === "command" ? '<button class="ann" data-role="member">DEMOTE</button>' : "") +
      (x.role !== "revoked" ? '<button class="ann" style="border-color:var(--red);color:var(--red)" data-role="revoked">REVOKE</button>'
                            : '<button class="ann lit-g" data-role="' + (x.org ? "allied" : "member") + '">REINSTATE</button>');
    return '<div class="acctrow" data-id="' + escAttr(x.discordId) + '"><div class="nm"><b>' + markHits(fleetName(x), terms) + '</b>' +
      '<span>discord: ' + markHits(x.discordName, terms) + " · " + (x.lastSeen ? "seen " + new Date(x.lastSeen).toLocaleString() : "never seen") +
      (x.onAir ? ' · <span class="onair">on air as ' + markHits(x.onAir, terms) + "</span>" : "") + "</span></div>" +
      '<span class="ann rolelbl ' + (x.role === "command" ? "lit-a" : x.role === "member" || x.role === "element" ? "lit-g" : "") + '">' + (x.role === "element" ? "ELEMENT LEADER" : x.role === "allied" ? (x.orgLead ? "ALLIED LEAD" : "ALLIED") + (x.org ? " · " + esc(x.org) : "") : esc(String(x.role).toUpperCase())) + "</span>" + btns + "</div>";
  }).join("");
  $("acctList").innerHTML = html || '<span class="hint">No operator matches “' + esc($("acctSearch").value) + '”.</span>';
  /* one option per allied organisation as well: that org's operators + the fleet's COMMAND */
  const levels = ["open", "joint", "member", "command"].concat(alliedOrgs.map(g => "org:" + g.guildId));
  const levelLabel = (l) => l === "open" ? "OPEN — anyone approved" : l === "joint" ? "JOINT — allied task force too" : l === "member" ? "MEMBERS+" : l === "command" ? "COMMAND ONLY"
    : ((alliedOrgs.find(g => "org:" + g.guildId === l) || {}).name || "ALLIED ORG").toUpperCase() + " ONLY (+ COMMAND)";
  const rows = nets.map(n => ({ name: n.cfg.name, freq: n.cfg.freq, level: d.access[n.cfg.name] || "open" }));
  for (const r of rows) if (!levels.includes(r.level)) levels.push(r.level);
  const shownNets = rows.filter(r => acctHits(terms, (r.name + " " + r.freq + " " + r.level + " " + levelLabel(r.level)).toLowerCase()));
  $("netAccess").innerHTML = shownNets.map(r =>
    '<div class="narow" data-net="' + escAttr(r.name) + '"><b>' + markHits(r.name, terms) + '</b><span class="fq2 num">' + markHits(r.freq, terms) + "</span>" +
    '<select class="orgsel" data-lvl>' + levels.map(l =>
      '<option value="' + l + '"' + (r.level === l ? " selected" : "") + ">" + levelLabel(l) + "</option>").join("") + "</select></div>"
  ).join("") || '<span class="hint">No net matches.</span>';
  $("acctCount").textContent = terms.length
    ? shownAccts.length + " OF " + d.accounts.length + " OPERATORS · " + shownNets.length + " OF " + rows.length + " NETS"
    : d.accounts.length + " OPERATORS · " + rows.length + " NETS";
}
/* ── ALLIED ORGANIZATIONS ──
   A joint op puts other organisations on the relay. COMMAND lists their
   Discord servers here; anyone in one of them (and not in the fleet's) signs
   in as ALLIED — no queue, org attached — and the relay lets them into nets
   marked JOINT and nothing else. Removing an org stops new sign-ins; people
   already in keep ALLIED standing until revoked on the roster above. */
let alliedOrgs = [];                              /* the allied list, for the per-org net levels */
function renderAllied(list) {
  alliedOrgs = (list || []).map(g => ({ guildId: String(g.guildId), name: String(g.name || "") }));
  if (acctData) renderAccts();                    /* the level dropdowns grow an option per org */
  const rows = (list || []).map(g => '<div class="narow" data-gid="' + escAttr(g.guildId) + '"><b>' + esc(g.name) + '</b>' +
    '<span class="fq2 num">' + esc(g.guildId) + '</span><span class="ann">' + (g.accounts || 0) + ' ON THE ROLLS</span>' +
    '<button class="ann" style="border-color:var(--red);color:var(--red)" data-gremove>REMOVE</button></div>').join("");
  $("alliedList").innerHTML = rows || '<span class="hint">No allied organizations — the fleet Discord is the only door.</span>';
}
async function refreshAllied() {
  const r = await ipcRenderer.invoke("acct", { method: "GET", path: "/api/allied" });
  if (r && r.ok) renderAllied(r.allied);
  else $("alliedList").innerHTML = '<span class="hint">' + esc((r && r.error) || "allied list unavailable — the service needs 1.4.5") + "</span>";
}
$("alliedAddBtn").addEventListener("click", async () => {
  const guildId = $("alliedId").value.trim(), name = $("alliedName").value.trim();
  if (!/^\d{5,25}$/.test(guildId)) { toast("The Discord server id is a number — Server Settings ▸ Widget, or Developer Mode ▸ Copy Server ID."); return; }
  if (!name) { toast("Give the organization a name."); return; }
  const r = await ipcRenderer.invoke("acct", { method: "POST", path: "/api/allied", body: { guildId, name } });
  if (!r.ok) { toast(r.error || "couldn't add the organization"); return; }
  $("alliedId").value = ""; $("alliedName").value = ""; toast("Allied organization added: " + name); refreshAllied();
});
$("alliedList").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-gremove]"); if (!b) return;
  const gid = b.closest("[data-gid]").dataset.gid;
  const r = await ipcRenderer.invoke("acct", { method: "POST", path: "/api/allied/" + gid + "/remove" });
  if (!r.ok) toast(r.error || "couldn't remove"); else { toast("Removed — its operators keep ALLIED standing until you revoke them."); refreshAllied(); }
});
["alliedId", "alliedName"].forEach(id => $(id).addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") $("alliedAddBtn").click(); }));

/* ── the allied operator's view ──
   An ALLIED account can enter only JOINT nets; the board shows only those
   (plus the nests they sit in) instead of 44 restricted rows, with a banner
   naming the org. Refreshed from every /api/me so a net COMMAND marks JOINT
   mid-op appears without a relaunch. */
function applyAlliedMode(account) {
  const next = account && account.role === "allied"
    ? { org: account.org || "allied", joint: new Set(account.jointNets || []), lead: account.orgLead === true } : null;
  const key = (x) => x && JSON.stringify({ o: x.org, j: [...x.joint].sort(), l: x.lead });
  const changed = key(next) !== key(alliedMode);
  alliedMode = next;
  $("alliedBanner").style.display = alliedMode ? "" : "none";
  $("alliedBannerV").textContent = alliedMode ? alliedMode.org.toUpperCase() + (alliedMode.lead ? " · ORG LEAD" : " · JOINT NETS ONLY") : "";
  /* an ORG LEAD may create, rename and delete nets inside their org's nets —
     the UI keys edit controls on cmdToken; the relay decides what is theirs */
  if (alliedMode && alliedMode.lead) cmdToken = "org-lead";
  else if (cmdToken === "org-lead") cmdToken = "";
  if (changed && nets.length) renderNets();
  return changed;
}
function alliedVisibleNames() {
  const vis = new Set();
  const named = (n) => alliedMode.joint.has(n.cfg.name);
  /* a net is visible if it is named, or sits under a named net (a subnet an
     org lead created inherits its parent's access on the relay), and every
     ancestor of a visible net is shown for structure */
  const under = (n) => { let cur = n; while (cur) { if (named(cur)) return true; cur = cur.parent ? nets.find(x => x.cfg.name === cur.parent) : null; } return false; };
  for (const n of nets) {
    if (!under(n)) continue;
    let cur = n;
    while (cur) { vis.add(cur.cfg.name); cur = cur.parent ? nets.find(x => x.cfg.name === cur.parent) : null; }
  }
  return vis;
}

/* ── the system log ──
   Technical lines (audio engine, microphone, updater, hooks, cam links) used
   to land in the COMM LOG between radio traffic. They live under SETTINGS ▸
   SYSTEM LOG now, with COPY for bug reports; the COMM LOG keeps everything
   about nets and the relay. The rule: a "sys" line with no net name is
   technical; one addressed to a net is operational. */
function addSysLog(msg) {
  const line = utc() + "  " + msg;
  sysLines.push(line); if (sysLines.length > 400) sysLines.shift();
  const feed = document.getElementById("sysFeed"); if (!feed) return;
  const d = document.createElement("div"); d.className = "le sys"; d.textContent = line;
  feed.appendChild(d); while (feed.children.length > 400) feed.removeChild(feed.firstChild);
  feed.scrollTop = feed.scrollHeight;
}
$("sysLogCopy").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(sysLines.join("\n")); toast("System log copied — " + sysLines.length + " lines."); }
  catch (e) { toast("Couldn't copy: " + e.message); }
});
$("acctSearch").addEventListener("input", () => renderAccts());
$("acctSearch").addEventListener("keydown", (e) => {
  if (e.key === "Escape") { e.preventDefault(); $("acctSearch").value = ""; renderAccts(); }
  e.stopPropagation();                            /* typing here must never reach the bind engine */
});
/* ── fleet identity ──
   Three different things wear the word "callsign": the NAME (Jack Sheridan —
   the site's, never written from here), the RANK or rated form (GM1 — the
   site's), and the OP CALLSIGN (TIBER ACTUAL — this session's, typed at
   sign-in, gone with it). FleetComm shows the first two the way the fleet
   says them and only ever writes the third. The roster comes from the site's
   personnel API; without it (older service) the rows fall back to the name. */
let acctRoster = new Map();                       /* discordId → { rank:{abbr}, rating, callsign } */
function fleetName(x) {
  const p = acctRoster.get(String(x.discordId)) || {};
  const rank = p.rating || (p.rank && p.rank.abbr) || "";
  const name = x.callsign || p.callsign || x.discordName || "(no name yet)";
  return ((rank && rank !== "—" ? rank + " " : "") + name).toUpperCase();
}
async function loadRoster() {
  try {
    const r = await ipcRenderer.invoke("acct", { method: "GET", path: "/api/personnel" });
    if (r && r.ok && Array.isArray(r.roster)) acctRoster = new Map(r.roster.map(p => [String(p.discordId), p]));
  } catch (e) { /* an older service has no roster — names alone */ }
}
/* the sign-in card's answer to "who does the fleet think I am": the site's
   rank + name, beside the box where the op callsign goes */
function showSignedAs(profile) {
  const rank = profile && (profile.rating || (profile.rank && profile.rank.abbr)) || "";
  const name = profile && (profile.callsign || profile.discordName) || "";
  const txt = ((rank && rank !== "—" ? rank + " " : "") + name).trim().toUpperCase();
  $("signedAsV").textContent = txt;
  $("signedAs").style.display = txt ? "" : "none";
  return txt;
}
async function loadIdentity() {
  try {
    const r = await ipcRenderer.invoke("acct", { method: "GET", path: "/api/personnel/me" });
    if (r && r.ok && r.profile) { acct.identity = r.profile; showSignedAs(r.profile); return; }
  } catch (e) { /* no personnel API on an older service */ }
  showSignedAs(null);
}
$("acctList").addEventListener("click", async (e) => {
  const lb = e.target.closest("[data-orglead]");
  if (lb) {
    const id = lb.closest(".acctrow").dataset.id;
    const r = await ipcRenderer.invoke("acct", { method: "POST", path: "/api/accounts/" + id + "/orglead", body: { lead: lb.dataset.orglead === "1" } });
    if (!r.ok) toast(r.error); else { toast(lb.dataset.orglead === "1" ? "Organization lead granted." : "Organization lead removed."); refreshAccts(); }
    return;
  }
  const b = e.target.closest("[data-role]"); if (!b) return;
  const id = b.closest(".acctrow").dataset.id;
  const r = await ipcRenderer.invoke("acct", { method: "POST", path: "/api/accounts/" + id + "/role", body: { role: b.dataset.role } });
  if (!r.ok) toast(r.error); else { toast("Role updated."); refreshAccts(); }
});
$("acctList").addEventListener("change", async (e) => {
  const sel = e.target.closest("[data-toallied]"); if (!sel || !sel.value) return;
  const id = sel.closest(".acctrow").dataset.id;
  const r = await ipcRenderer.invoke("acct", { method: "POST", path: "/api/accounts/" + id + "/role", body: { role: "allied", orgGuild: sel.value } });
  if (!r.ok) { toast(r.error); sel.value = ""; } else { toast("Filed as ALLIED · " + sel.options[sel.selectedIndex].textContent + "."); refreshAccts(); }
});
$("netAccess").addEventListener("change", async (e) => {
  const s2 = e.target.closest("[data-lvl]"); if (!s2) return;
  const net = s2.closest(".narow").dataset.net;
  const r = await ipcRenderer.invoke("acct", { method: "POST", path: "/api/nets/access", body: { net, level: s2.value } });
  toast(r.ok ? net + " → " + s2.value.toUpperCase() + " (relay-enforced)" : "Failed: " + r.error);
});

/* ══ helmet cam ══
   Operators stream their Star Citizen POV to shipmates: screen capture via the
   desktop-capture path, video peer-to-peer over WebRTC, and the handshakes
   riding the relay as session-targeted text on the silent control connection
   (src/cam-signal.js — no new sockets, nothing for the dial governor to see).
   One publisher feeds at most CAM_MAX_VIEWERS peer connections; watchers can
   view one feed solo, several in a grid, or float any tile over the game with
   native picture-in-picture. NAT reality: with STUN only, a small share of
   peer pairs (symmetric NAT both ends) cannot connect — the tile says LINK
   FAILED instead of pretending. */
const CAM_MAX_VIEWERS = 4;
const CAM_ICE = [{ urls: "stun:stun.l.google.com:19302" }];
const CAM_QUAL = {
  "480":  { w: 854,  h: 480,  fps: 15, kbps: 600 },
  "720":  { w: 1280, h: 720,  fps: 30, kbps: 1500 },
  "1080": { w: 1920, h: 1080, fps: 30, kbps: 3000 }
};
const cam = {
  pub: null,                  /* {stream, quality, viewers:Map<actor,pc>} */
  watching: new Map(),        /* actor → {pc, tile, cs, state} */
  live: new Map(),            /* actor → callsign of announced publishers  */
  meta: new Map(),            /* actor → {since, who} from their announce   */
  pops: new Map(),            /* actor → pop-out Window (own OS window)     */
  since: 0,                   /* when MY cam went live (rides the announce) */
  peers: [], limit: 5000, seq: 0,
  reasm: bridge.camSignal.newReassembler({ ttlMs: 30000 }),
  announceTimer: null
};
/* ── cam viewing is GATED: Element Leaders and COMMAND watch; everyone may
   still STREAM (who knows who'll be ordered to share on the fly). Two ends:
   the viewer's own role hides the watch UI, and the STREAMER refuses signal
   traffic from operators the accounts service doesn't clear — identity being
   the relay-verified username, never the payload. The authority list comes
   from /api/cam-viewers; while a droplet predates that endpoint the streamer
   fails OPEN (legacy relays have no roles at all, so open is also correct
   there). Args are injectable so the gate logic is testable in the rig. */
function camMayWatch(dm, a) {
  const mode = dm === undefined ? discordMode : dm;
  const account = a === undefined ? acct : a;
  if (!mode || !account) return true;                    /* legacy = open */
  if (account.account.role === "allied") return account.account.orgLead === true;   /* allied command watches */
  return ["element", "command"].includes(account.account.role);
}
const camCanon = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-+|-+$/g, "");
let camViewersCache = { at: 0, set: null };              /* null = unknown → open */
async function camAuthorizedViewers() {
  if (!discordMode) return null;
  if (Date.now() - camViewersCache.at < 60000) return camViewersCache.set;
  camViewersCache.at = Date.now();
  try {
    const r = await ipcRenderer.invoke("acct", { method: "GET", path: "/api/cam-viewers" });
    camViewersCache.set = (r && r.ok && Array.isArray(r.viewers))
      ? new Set(r.viewers.map(camCanon)) : null;
  } catch (e) { camViewersCache.set = null; }
  return camViewersCache.set;
}
async function camViewerAllowed(fromName) {
  const set = await camAuthorizedViewers();
  return !set || set.has(camCanon(fromName));
}
function camSelf() { return cam.peers.find(p => p.self) || null; }
function camOthers() { return cam.peers.filter(p => !p.self).map(p => p.session); }
function sendSig(sessions, payload) {
  const targets = (Array.isArray(sessions) ? sessions : [sessions]).filter(s => Number.isInteger(s));
  if (!targets.length) return;
  const size = Math.max(400, Math.min(3800, cam.limit - 200));
  let chunks;
  try { chunks = bridge.camSignal.encodeChunks("s" + (++cam.seq) + "x" + Math.floor(Math.random() * 1e6), payload, size); }
  catch (e) { toast("Cam signal too large — " + e.message); return; }
  ipcRenderer.send("cam-signal", { sessions: targets, chunks });
}
async function camRefreshPeers() {
  try {
    const r = await ipcRenderer.invoke("cam-peers");
    cam.peers = r.peers || []; cam.limit = r.limit || 5000;
  } catch (e) { cam.peers = []; }
}
/* ── the shared signal dispatcher ── */
ipcRenderer.on("cam-signal", async (ev, s) => {
  const m = cam.reasm.feed(s.actor, s.message, Date.now());
  if (!m || typeof m.t !== "string") return;
  const from = s.from || "OPERATOR";
  if (m.t === "who") {
    if (cam.pub && await camViewerAllowed(from)) sendSig([s.actor], camOnPayload());
    return;
  }
  if (m.t === "on") {
    /* since/who are cosmetic burn-in for the tile (elapsed timer, name):
       bounded, never identity — identity stays the relay-verified `from` */
    cam.meta.set(s.actor, { since: Math.max(0, +m.since || 0), who: String(m.who || "").slice(0, 40) });
    /* Identity comes from the SERVER's user table (the |ctl username the
       relay verified), never from the payload — any operator can write any
       cs into a signal. A fresh announce from the same callsign under a new
       session id (control relink) retires the stale row and its tile. */
    let rewatch = false;
    for (const [a, cs0] of [...cam.live]) {
      if (cs0 === from && a !== s.actor) {
        cam.live.delete(a);
        /* the streamer's control link relinked (new session id). A viewer used
           to lose the tile and have to click again — "cams auto hide". Follow
           the feed to its new session instead. */
        if (cam.watching.has(a)) { rewatch = true; camUnwatch(a); } else camDropTile(a);
      }
    }
    cam.live.set(s.actor, from);
    if (rewatch) { addLog("sys", "", from + " relinked \u2014 re-watching cam"); camWatch(s.actor); }
    renderCamList(); return;
  }
  if (m.t === "off") { cam.live.delete(s.actor); camDropTile(s.actor, "OFF AIR"); renderCamList(); return; }
  if (m.t === "full") { toast(from + "'s cam is full (" + CAM_MAX_VIEWERS + " watchers)."); camDropTile(s.actor, "FULL"); return; }
  if (m.t === "req") {
    if (await camViewerAllowed(from)) camServeViewer(s.actor, from);
    else sendSig([s.actor], { t: "deny" });
    return;
  }
  if (m.t === "deny") { toast(from + "'s cam is restricted to Element Leaders and COMMAND."); camDropTile(s.actor, "NOT CLEARED"); return; }
  if (m.t === "leave") { camReleaseViewer(s.actor); return; }
  if (m.t === "end") { camDropTile(s.actor, "OFF AIR"); return; }
  if (m.t === "offer" && typeof m.sdp === "string") { camAcceptOffer(s.actor, from, m.sdp); return; }
  if (m.t === "answer" && typeof m.sdp === "string") {
    const pc = cam.pub && cam.pub.viewers.get(s.actor);
    if (pc) { try { await pc.setRemoteDescription({ type: "answer", sdp: m.sdp }); } catch (e) {} }
  }
});
function camGatherDone(pc) {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((res) => {
    /* non-trickle by design: ONE sdp blob per direction keeps the handshake
       inside murmur's per-user text budget. 4s cap — a stuck gatherer still
       produces a usable host+srflx description. */
    const t = setTimeout(res, 4000);
    pc.addEventListener("icegatheringstatechange", () => {
      if (pc.iceGatheringState === "complete") { clearTimeout(t); res(); }
    });
  });
}
/* ── publishing ── */
async function camStart() {
  if (cam.pub) return;
  await camRefreshPeers();
  let sources;
  try { sources = await ipcRenderer.invoke("cam-sources"); }
  catch (e) { toast("Screen capture unavailable: " + e.message); return; }
  const pick = $("camPick");
  pick.hidden = false;
  pick.innerHTML = sources.map((s, i) =>
    '<div class="src" data-si="' + i + '"><img src="' + s.thumb + '" alt=""><span title="' + escAttr(s.name) + '">' + esc(s.name) + "</span></div>").join("") ||
    '<div class="hint">Nothing to capture.</div>';
  pick.onclick = async (e) => {
    const el = e.target.closest("[data-si]"); if (!el) return;
    pick.hidden = true; pick.onclick = null;
    await camGoLive(sources[+el.dataset.si]);
  };
}
async function camGoLive(source) {
  const q = CAM_QUAL[$("camQual").value] || CAM_QUAL["720"];
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: source.id,
        maxWidth: q.w, maxHeight: q.h, maxFrameRate: q.fps } }
    });
  } catch (e) { toast("Couldn't capture " + source.name + ": " + e.message); return; }
  cam.pub = { stream, quality: q, viewers: new Map(), srcName: source.name };
  camShowSource(source);
  stream.getVideoTracks()[0].addEventListener("ended", camStopPub); /* source window closed */
  $("camStart").hidden = true; $("camStop").hidden = false;
  $("camStatus").textContent = "ON AIR · 0 WATCHING"; $("camStatus").classList.add("live");
  addLog("sys", "", "helmet cam live — " + source.name);
  cam.since = Date.now();
  camMountTile("self", callsign + " (YOU)", stream, true, { since: cam.since, who: camMyName(), cs: callsign });
  camAnnounce();
  /* re-announce once a minute: sessions churn on relinks and latecomers ask
     WHO only when they open the page */
  cam.announceTimer = setInterval(camAnnounce, 60000);
}
/* the streamer's own answer to "which window am I sending?" — the source's
   name and its picker thumbnail, pinned under MY CAM for the whole stream */
function camShowSource(source) {
  const box = $("camSrc");
  $("camSrcName").textContent = source.name || "window";
  $("camSrcThumb").src = source.thumb || "";
  $("camSrcThumb").hidden = !source.thumb;
  box.hidden = false;
}
function camHideSource() { $("camSrc").hidden = true; $("camSrcThumb").src = ""; }
async function camAnnounce() {
  if (!cam.pub) return;
  await camRefreshPeers();
  const others = camOthers();
  /* announce only to cleared viewers — a gated member never even learns the
     cam exists (fail-open while the authority list is unknown) */
  const authorized = await camAuthorizedViewers();
  const targets = authorized
    ? others.filter(sess => { const p = cam.peers.find(x => x.session === sess);
        return p && authorized.has(camCanon(p.callsign)); })
    : others;
  if (targets.length) sendSig(targets, camOnPayload());
}
/* what rides every announce besides the callsign: when the feed started (for
   the viewer's elapsed timer) and the operator's name (for the burn-in) */
const camMyName = () => (acct && acct.account.discordName) ? String(acct.account.discordName).slice(0, 40) : "";
const camOnPayload = () => ({ t: "on", cs: callsign, since: cam.since || 0, who: camMyName() });
function camStopPub() {
  if (!cam.pub) return;
  cam.since = 0;
  clearInterval(cam.announceTimer); cam.announceTimer = null;
  const others = camOthers();
  if (others.length) sendSig(others, { t: "off" });
  for (const pc of cam.pub.viewers.values()) { try { pc.close(); } catch (e) {} }
  try { cam.pub.stream.getTracks().forEach(t => t.stop()); } catch (e) {}
  cam.pub = null;
  camHideSource();
  camDropTile("self");
  $("camStart").hidden = false; $("camStop").hidden = true;
  $("camStatus").textContent = "OFF AIR"; $("camStatus").classList.remove("live");
  addLog("sys", "", "helmet cam off");
}
async function camServeViewer(actor, from) {
  if (!cam.pub) { sendSig([actor], { t: "end" }); return; }
  if (cam.pub.viewers.size >= CAM_MAX_VIEWERS && !cam.pub.viewers.has(actor)) {
    sendSig([actor], { t: "full" }); return;
  }
  camReleaseViewer(actor);                       /* replace any stale pc */
  const pc = new RTCPeerConnection({ iceServers: CAM_ICE });
  cam.pub.viewers.set(actor, pc);
  camPubCount();
  /* every continuation below is identity-guarded on THIS pc: a re-request
     replaces the map entry, and without the guards the replaced handshake's
     catch/timeout used to close or out-offer its own replacement */
  const current = () => cam.pub && cam.pub.viewers.get(actor) === pc;
  /* a viewer that never answers must not squat a slot until STOP */
  pc._answerTimer = setTimeout(() => {
    if (current() && pc.connectionState !== "connected") camReleaseViewer(actor, pc);
  }, 45000);
  cam.pub.stream.getTracks().forEach(t => pc.addTrack(t, cam.pub.stream));
  pc.addEventListener("connectionstatechange", async () => {
    if (pc.connectionState === "connected") {
      clearTimeout(pc._answerTimer);
      /* politeness cap: the encoder budget follows the chosen quality */
      for (const sender of pc.getSenders()) {
        try {
          const p = sender.getParameters();
          p.encodings = (p.encodings && p.encodings.length) ? p.encodings : [{}];
          p.encodings[0].maxBitrate = cam.pub.quality.kbps * 1000;
          await sender.setParameters(p);
        } catch (e) {}
      }
      addLog("sys", "", "helmet cam — " + from + " is watching");
    }
    /* "disconnected" is transient and self-healing — the viewer side waits
       it out, so must we; only a truly dead pc frees the slot */
    if (["failed", "closed"].includes(pc.connectionState)) camReleaseViewer(actor, pc);
  });
  try {
    await pc.setLocalDescription(await pc.createOffer());
    await camGatherDone(pc);
    if (!current()) { try { pc.close(); } catch (e) {} return; }
    sendSig([actor], { t: "offer", sdp: pc.localDescription.sdp });
  } catch (e) { camReleaseViewer(actor, pc); }
}
function camReleaseViewer(actor, onlyPc) {
  const pc = cam.pub && cam.pub.viewers.get(actor);
  if (!pc || (onlyPc && pc !== onlyPc)) return;
  cam.pub.viewers.delete(actor);
  clearTimeout(pc._answerTimer);
  try { pc.close(); } catch (e) {}
  camPubCount();
}
function camPubCount() {
  if (cam.pub) $("camStatus").textContent = "ON AIR · " + cam.pub.viewers.size + " WATCHING";
}
/* ── watching ── */
function camWatch(actor) {
  if (cam.watching.has(actor)) return;
  const cs = cam.live.get(actor) || "OPERATOR";
  const entry = { pc: null, cs, tile: camMountTile(actor, cs, null, false, Object.assign({ cs }, cam.meta.get(actor) || {})) };
  cam.watching.set(actor, entry);
  /* a req can go unanswered (stale session id, publisher quit) — say so and
     clean up instead of CALLING… forever */
  entry.callTimer = setTimeout(() => {
    if (cam.watching.get(actor) !== entry || entry.pc) return;
    entry.tile.classList.add("lost");
    entry.tile.querySelector(".st8").textContent = "NO ANSWER";
    setTimeout(() => { if (cam.watching.get(actor) === entry && !entry.pc) camUnwatch(actor); }, 4000);
  }, 12000);
  sendSig([actor], { t: "req" });
  renderCamList();
}
async function camAcceptOffer(actor, from, sdp) {
  const entry = cam.watching.get(actor);
  if (!entry) return;                             /* never asked — ignore */
  clearTimeout(entry.callTimer);
  if (entry.pc) { try { entry.pc.close(); } catch (e) {} }
  const pc = new RTCPeerConnection({ iceServers: CAM_ICE });
  entry.pc = pc;
  /* identity-guard every continuation: a newer offer replaces entry.pc, and
     stale callbacks must neither answer nor mutate the fresh handshake */
  const current = () => cam.watching.get(actor) === entry && entry.pc === pc;
  pc.addEventListener("track", (e) => {
    if (!current()) return;
    const v = entry.tile.querySelector("video");
    if (v && v.srcObject !== e.streams[0]) { v.srcObject = e.streams[0]; v.play().catch(() => {}); }
    if (!entry.tile.dataset.since) entry.tile.dataset.since = String(camSinceFor(cam.meta.get(actor) || {}));
    entry.tile.classList.remove("lost");
    entry.tile.querySelector(".st8").textContent = "";
  });
  pc.addEventListener("connectionstatechange", () => {
    if (!current()) return;
    if (["failed", "disconnected"].includes(pc.connectionState)) {
      entry.tile.classList.add("lost");
      entry.tile.querySelector(".st8").textContent = "LINK " + (pc.connectionState === "failed" ? "FAILED" : "LOST");
      if (pc.connectionState === "failed") {
        setTimeout(() => {
          if (!(current() && pc.connectionState === "failed")) return;
          const tries = entry.retries || 0;
          camUnwatch(actor);
          /* a dead link to a streamer who is still on the air gets two more
             tries before the tile stays gone */
          if (tries < 2 && cam.live.has(actor)) setTimeout(() => {
            if (cam.live.has(actor) && !cam.watching.has(actor)) { camWatch(actor); const e2 = cam.watching.get(actor); if (e2) e2.retries = tries + 1; }
          }, 1500);
        }, 8000);
      }
    }
  });
  try {
    await pc.setRemoteDescription({ type: "offer", sdp });
    await pc.setLocalDescription(await pc.createAnswer());
    await camGatherDone(pc);
    if (!current()) { try { pc.close(); } catch (e) {} return; }
    sendSig([actor], { t: "answer", sdp: pc.localDescription.sdp });
  } catch (e) {
    if (!current()) return;
    entry.tile.classList.add("lost");
    entry.tile.querySelector(".st8").textContent = "HANDSHAKE FAILED";
  }
}
function camUnwatch(actor) {
  const entry = cam.watching.get(actor);
  if (!entry) return;
  cam.watching.delete(actor);
  clearTimeout(entry.callTimer);
  if (entry.pc) { try { entry.pc.close(); } catch (e) {} }
  sendSig([actor], { t: "leave" });
  if (entry.tile) entry.tile.remove();
  camViewState(); renderCamList();
}
function camDropTile(actor, why) {
  if (actor === "self") {
    const t = document.querySelector('.tile[data-actor="self"]');
    if (t) t.remove(); camViewState(); return;
  }
  const entry = cam.watching.get(actor);
  if (!entry) return;
  cam.watching.delete(actor);
  clearTimeout(entry.callTimer);
  if (entry.pc) { try { entry.pc.close(); } catch (e) {} }
  if (entry.tile) entry.tile.remove();
  camPopClose(actor);
  if (why) toast(entry.cs + " — cam " + why.toLowerCase() + ".");
  camViewState(); renderCamList();
}
/* ── tiles ── */
/* the streamer's clock says when the feed started; trust it only when it is
   sane (not in the future, not zero) — else the timer runs from arrival */
function camSinceFor(meta) {
  const s = +(meta && meta.since) || 0, now = Date.now();
  return (s > 0 && s <= now + 5000) ? Math.min(s, now) : now;
}
const camElapsed = (since) => {
  const t = Math.max(0, Math.floor((Date.now() - since) / 1000));
  return String(Math.floor(t / 3600)).padStart(2, "0") + ":" + String(Math.floor(t / 60) % 60).padStart(2, "0") + ":" + String(t % 60).padStart(2, "0");
};
function camMountTile(actor, label, stream, isSelf, metaIn) {
  const grid = $("camGrid");
  const meta = metaIn || {};
  const tile = document.createElement("div");
  tile.className = "tile" + (isSelf ? " self" : "");
  tile.dataset.actor = String(actor);
  tile.dataset.cs = String(meta.cs || label).replace(/\s*\(YOU\)$/, "");
  if (stream) tile.dataset.since = String(camSinceFor(meta));
  tile.innerHTML = '<video autoplay muted playsinline></video>' +
    '<div class="tl"><span class="livebadge">LIVE</span><span class="tmr" data-timer>' + (stream ? camElapsed(+tile.dataset.since) : "--:--:--") + '</span>' +
    '<b>' + esc(label) + '</b>' + (meta.who ? '<span class="who">' + esc(meta.who) + '</span>' : "") +
    '<span class="st8">' + (stream ? "" : "CALLING…") + '</span>' +
    '<button data-pip title="Float this feed over the game in its own window \u2014 burn-in and all; open as many as you like">POP OUT</button>' +
    (isSelf ? "" : '<button data-close title="Stop watching">✕</button>') + "</div>" +
    '<div class="bl"><span data-fclock>' + esc(fleetTime()) + '</span><span class="vox">● VOX</span></div>';
  const v = tile.querySelector("video");
  if (stream) { v.srcObject = stream; v.play().catch(() => {}); }
  v.addEventListener("click", () => {
    const solo = grid.classList.contains("solo") && tile.classList.contains("focus");
    grid.classList.toggle("solo", !solo);
    grid.querySelectorAll(".tile").forEach(t => t.classList.toggle("focus", !solo && t === tile));
  });
  tile.querySelector("[data-pip]").addEventListener("click", (e) => { e.stopPropagation(); camPopOut(actor, tile); });
  const x = tile.querySelector("[data-close]");
  if (x) x.addEventListener("click", (e) => { e.stopPropagation(); camUnwatch(actor); });
  grid.appendChild(tile);
  camViewState();
  return tile;
}
/* columns for n feeds: 1, 2, then the squarest wall that fits (4 across at
   most — beyond that the plates are too small to read a callsign) — and never
   more than the pane can hold at 300px a plate (a narrow window gets a
   single column rather than two unreadable ones) */
const camCols = (n, width) => {
  const byCount = n <= 1 ? 1 : Math.min(4, Math.ceil(Math.sqrt(n)));
  const byWidth = width > 0 ? Math.max(1, Math.floor((width - 24) / 300)) : byCount;
  return Math.max(1, Math.min(byCount, byWidth));
};
/* the operator on a feed is keyed → outline their tile. Speakers are known
   per net by relay session; tiles by callsign — the relay's wire name for a
   session IS the canon callsign (same rule the cam gate uses). Runs from
   sendOv(), i.e. on every speaking/TX change. */
function camTalkSync() {
  const tiles = $("camGrid").querySelectorAll(".tile");
  if (!tiles.length) return;
  const now = Date.now(), talking = new Set();
  for (const n of nets) for (const [sess, until] of n.speaking) if (until > now) talking.add(camCanon(n.roster.get(sess) || ""));
  const meTx = txSet.size > 0;
  tiles.forEach(t => t.classList.toggle("talking", t.classList.contains("self") ? meTx : talking.has(camCanon(t.dataset.cs))));
  for (const actor of [...cam.pops.keys()]) camPopSync(actor);
}
function camTick() {
  const tiles = $("camGrid").querySelectorAll(".tile[data-since]");
  const stamp = fleetTime();
  tiles.forEach(t => {
    const tm = t.querySelector("[data-timer]"); if (tm) tm.textContent = camElapsed(+t.dataset.since);
    const fc = t.querySelector("[data-fclock]"); if (fc) fc.textContent = stamp;
  });
  for (const actor of [...cam.pops.keys()]) camPopSync(actor);
}
/* ── pop-out feeds ──
   Native picture-in-picture shows the bare video (no burn-in, no scanlines)
   and Chromium allows exactly one. A pop-out is our own window: the same
   MediaStream (a same-origin child window plays the opener's stream
   directly), the full tile chrome, always on top of a borderless game, one
   per feed, as many as wanted. main.js allows only fcpop-* frames. */
function camPopOut(actor, tile) {
  const existing = cam.pops.get(actor);
  if (existing && !existing.closed) { try { existing.focus(); } catch (e) {} return; }
  const v = tile.querySelector("video");
  if (!v || !v.srcObject) { toast("No feed yet \u2014 wait for the picture, then pop it out."); return; }
  const w = window.open("cam-pop.html", "fcpop-" + String(actor).replace(/[^A-Za-z0-9_-]/g, "_"), "width=640,height=390");
  if (!w) { toast("Pop-out was blocked."); return; }
  cam.pops.set(actor, w);
  let tries = 0;
  const arm = () => {
    if (w.closed) { cam.pops.delete(actor); return; }
    let pv = null; try { pv = w.document && w.document.getElementById("v"); } catch (e) { pv = null; }
    if (!pv || !w.camPop) { if (tries++ < 60) setTimeout(arm, 100); return; }
    try { pv.srcObject = v.srcObject; pv.play().catch(() => {}); } catch (e) {}
    camPopSync(actor);
  };
  arm();
}
function camPopSync(actor) {
  const w = cam.pops.get(actor); if (!w) return;
  if (w.closed) { cam.pops.delete(actor); return; }
  const tile = $("camGrid").querySelector('.tile[data-actor="' + String(actor).replace(/["\\]/g, "") + '"]');
  if (!tile || !w.camPop) return;
  const q = (sel) => { const el = tile.querySelector(sel); return el ? el.textContent : ""; };
  try {
    w.camPop.set({ cs: tile.dataset.cs, who: q(".who"), timer: q("[data-timer]"), clock: fleetTime(),
      talking: tile.classList.contains("talking"), self: tile.classList.contains("self"),
      scan: document.documentElement.hasAttribute("data-camscan") });
  } catch (e) {}
}
function camPopClose(actor) {
  const w = cam.pops.get(actor); if (!w) return;
  cam.pops.delete(actor);
  try { if (!w.closed) w.close(); } catch (e) {}
}
setInterval(camTick, 1000);
function camViewState() {
  const grid = $("camGrid");
  if (!grid.children.length) grid.classList.remove("solo");
  grid.style.setProperty("--camcols", String(camCols(grid.children.length, grid.clientWidth)));
  $("camEmpty").style.display = grid.children.length ? "none" : "";
}
try { new ResizeObserver(() => camViewState()).observe($("camGrid")); } catch (e) {}
function renderCamList() {
  if (!camMayWatch()) {
    $("camList").innerHTML = '<div class="camgated">ELEMENT LEADERS &amp; COMMAND ONLY</div>' +
      '<div class="hint">Watching the fleet\'s cams needs the Element Leader role — your own cam can still stream to those cleared to see it.</div>';
    return;
  }
  const rows = [];
  for (const [actor, cs] of cam.live) {
    const self = camSelf();
    if (self && actor === self.session) continue;
    const on = cam.watching.has(actor);
    rows.push('<div class="camrow" data-actor="' + actor + '"><b>' + esc(cs) + '</b><span class="lv">● LIVE</span>' +
      '<button data-w class="' + (on ? "watching" : "") + '">' + (on ? "WATCHING" : "WATCH") + "</button></div>");
  }
  $("camList").innerHTML = rows.join("") || '<div class="hint">No cams on the air.</div>';
}
$("camList").addEventListener("click", (e) => {
  const b = e.target.closest("[data-w]"); if (!b) return;
  if (!camMayWatch()) { toast("Watching cams needs the Element Leader role."); return; }
  const actor = +b.closest(".camrow").dataset.actor;
  if (cam.watching.has(actor)) camUnwatch(actor); else camWatch(actor);
});
$("camStart").addEventListener("click", camStart);
$("camStop").addEventListener("click", camStopPub);
$("camRefresh").addEventListener("click", camScan);
async function camScan() {
  await camRefreshPeers();
  /* forget announcers who left the relay entirely — but an EMPTY snapshot is
     "no information" (control relink in progress; a live one always contains
     at least our own |ctl session), not "everyone left": sweeping on it
     closed every healthy P2P tile over a relay blip the video never felt */
  if (cam.peers.length) {
    const alive = new Set(cam.peers.map(p => p.session));
    for (const actor of [...cam.live.keys()]) if (!alive.has(actor)) { cam.live.delete(actor); camDropTile(actor); }
  }
  /* soliciting the fleet's cams is a viewer act — the gated don't knock */
  if (camMayWatch()) {
    const others = camOthers();
    if (others.length) sendSig(others, { t: "who" });
  }
  renderCamList();
}
/* everything down with the session */
function camTeardownAll() {
  camStopPub();
  for (const actor of [...cam.watching.keys()]) {
    const entry = cam.watching.get(actor);
    cam.watching.delete(actor);
    if (entry.pc) { try { entry.pc.close(); } catch (e) {} }
    if (entry.tile) entry.tile.remove();
  }
  cam.live.clear(); cam.peers = [];
  camViewState(); renderCamList();
}

/* headless CI hook */
/* ══ WALKTHROUGH ══
   Coach marks over the REAL controls: a spotlight cut into a dim wash and a
   card beside it. Two phases, because the board does not exist before
   sign-in: the quarterdeck phase (welcome, sign in) hands off by setting
   tutPending, and afterConnect() picks up the board phase. Opens itself once
   for a first-time operator (tutDone unset), never in the rig; SYS ▸ HELP and
   the sign-in link replay it any time. SKIP anywhere ends it for good. */
const TUT_QD = [
  { t: "WELCOME", b: "This is your radio. Two things to do: pick a channel, then hold a key to talk. It takes about a minute.", next: "OK \u25b8" },
  { t: "SIGN IN", el: () => $("discordBtn").offsetParent ? $("discordBtn") : $("connectLegacyBtn"),
    b: "Click <b>SIGN IN WITH DISCORD</b>. If it says <b>pending</b>, an officer has to approve you first \u2014 once they have, press <b>CONNECT</b>.", next: "I'M SIGNING IN \u25b8" }
];
const TUT_BOARD = [
  { t: "PICK A CHANNEL", page: "pgComms", el: () => document.querySelector("#netlist [data-tune]") || $("netlist"), advanceOn: "tuned",
    b: "Press <b>TUNE</b> on the channel your group is using. You can tune more than one.", done: "Tuned. Now your key." },
  { t: "SET YOUR TALK KEY", page: "pgComms", el: () => $("ptt"), advanceOn: "bound", arm: () => { try { $("pttKeyChange").click(); } catch (e) {} },
    b: "Press the key you want to use for talking \u2014 right now. Any keyboard key, mouse button, or flight-stick button works.", done: "Set. That's your talk key." },
  { t: "TALK", page: "pgComms", el: () => $("ptt"),
    b: "Hold your key and speak. Let go when you're done. The channel lights <b>orange</b> while you talk and <b>green</b> when someone else does." },
  { t: "IN THE GAME", page: "pgComms", el: () => $("ovShowBtn").closest(".panel") || $("ovShowBtn").parentElement,
    b: "A small overlay sits on top of your game so you can see who's talking. <kbd>PAGE UP</kbd> and <kbd>PAGE DOWN</kbd> switch which channel you talk on." },
  { t: "YOU'RE SET", page: "pgComms",
    b: "That's everything you need. Anything else \u2014 microphone, keys, look \u2014 is under <b>SETTINGS</b> on the left.", next: "FINISH \u25b8" }
];
const tut = { on: false, phase: "", steps: [], i: 0 };
function tutOpen(phase) {
  tut.phase = phase; tut.steps = phase === "quarterdeck" ? TUT_QD : TUT_BOARD; tut.i = 0; tut.on = true;
  $("tut").hidden = false;
  tutRender();
}
function tutClose(done) {
  tutDisarm();
  tut.on = false; $("tut").hidden = true;
  if (done) { store.set("tutDone", true); store.set("tutPending", false); }
}
function tutRender() {
  const st = tut.steps[tut.i]; if (!st) return;
  if (st.page && connected) showPage(st.page);
  $("tutStep").textContent = "WALKTHROUGH \u00b7 " + String(tut.i + 1).padStart(2, "0") + " / " + String(tut.steps.length).padStart(2, "0");
  $("tutTitle").textContent = st.t;
  $("tutBody").innerHTML = st.b;
  $("tutDots").innerHTML = tut.steps.map((x, k) => "<i" + (k === tut.i ? ' class="on"' : "") + "></i>").join("");
  $("tutBack").style.visibility = tut.i ? "" : "hidden";
  $("tutNext").textContent = st.next || (tut.i === tut.steps.length - 1 ? "FINISH \u25b8" : "NEXT \u25b8");
  requestAnimationFrame(tutPlace);
  if (st.arm) setTimeout(() => { if (tut.on && tut.steps[tut.i] === st) { st.arm(); tut.armed = true; } }, 350);
}
/* a capture the tour armed must not outlive the step: SKIP or NEXT with the
   app still listening would bind the next key the operator happened to press */
function tutDisarm() {
  if (!tut.armed) return;
  tut.armed = false;
  if (capturing && capturing.kind === "master" && capturing.which === "active") { capturing = null; renderNets(); renderMasterBinds(); }
}
/* the app tells the tour what the operator just did; the step that was
   waiting for it confirms and moves on by itself */
function tutEvent(kind) {
  if (!tut.on) return;
  const st = tut.steps[tut.i];
  if (!st || st.advanceOn !== kind || st._done) return;
  st._done = true;
  $("tutBody").innerHTML = "<b>" + esc(st.done || "Done.") + "</b>";
  setTimeout(() => { if (tut.on && tut.steps[tut.i] === st) { delete st._done; tutNext(); } }, 900);
}
function tutPlace() {
  if (!tut.on) return;
  const st = tut.steps[tut.i]; if (!st) return;
  let el = null; try { el = st.el ? st.el() : null; } catch (e) { el = null; }
  const spot = $("tut").querySelector(".tut-spot"), card = $("tut").querySelector(".tut-card");
  const vw = window.innerWidth, vh = window.innerHeight, pad = 6, gap = 14, m = 16;
  const cw = card.offsetWidth, ch = card.offsetHeight;
  let r = el && el.getClientRects().length ? el.getBoundingClientRect() : null;
  if (r && (r.width < 4 || r.height < 4)) r = null;
  if (!r) {
    spot.classList.add("none");
    card.style.left = Math.round((vw - cw) / 2) + "px"; card.style.top = Math.round((vh - ch) / 2) + "px";
    return;
  }
  spot.classList.remove("none");
  spot.style.left = (r.left - pad) + "px"; spot.style.top = (r.top - pad) + "px";
  spot.style.width = (r.width + pad * 2) + "px"; spot.style.height = (r.height + pad * 2) + "px";
  /* card: right of the mark if it fits, else below, else above, else left; then clamp */
  let x, y;
  if (r.right + gap + cw + m <= vw) { x = r.right + gap; y = r.top; }
  else if (r.bottom + gap + ch + m <= vh) { x = r.left; y = r.bottom + gap; }
  else if (r.top - gap - ch >= m) { x = r.left; y = r.top - gap - ch; }
  else if (r.left - gap - cw >= m) { x = r.left - gap - cw; y = r.top; }
  else { x = (vw - cw) / 2; y = Math.max(m, vh - ch - m); }
  card.style.left = Math.round(Math.max(m, Math.min(vw - cw - m, x))) + "px";
  card.style.top = Math.round(Math.max(m, Math.min(vh - ch - m, y))) + "px";
}
function tutNext() {
  tutDisarm();
  if (tut.i < tut.steps.length - 1) { tut.i++; tutRender(); return; }
  if (tut.phase === "quarterdeck") { store.set("tutPending", true); tutClose(false); return; }
  tutClose(true); toast("You're set \u2014 replay this any time from SETTINGS \u25b8 HELP.");
}
$("tutNext").addEventListener("click", tutNext);
$("tutBack").addEventListener("click", () => { tutDisarm(); if (tut.i > 0) { tut.i--; tutRender(); } });
$("tutSkip").addEventListener("click", () => tutClose(true));
$("tutStartBtn").addEventListener("click", () => tutOpen(connected ? "board" : "quarterdeck"));
$("tutLink").addEventListener("click", () => tutOpen(connected ? "board" : "quarterdeck"));
window.addEventListener("resize", () => { if (tut.on) tutPlace(); });
window.addEventListener("keydown", (e) => {
  if (!tut.on || capturing) return;          /* a key being captured for a bind belongs to the bind engine */
  if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); tutClose(true); }
  else if (e.key === "ArrowRight" || e.key === "Enter") { e.preventDefault(); e.stopImmediatePropagation(); tutNext(); }
  else if (e.key === "ArrowLeft") { e.preventDefault(); e.stopImmediatePropagation(); if (tut.i > 0) { tut.i--; tutRender(); } }
}, true);
/* first-time operators get it once, unprompted; the rig never does. "First
   time" = a profile that has never connected (no saved callsign) — a
   returning operator updating into this build is not a first-timer and gets
   the tour only from SYS ▸ HELP or the sign-in link */
function tutMaybeAuto() {
  if (bridge.autotestHost || store.get("tutDone", false) || store.get("callsign", "")) return;
  if (connected) tutOpen("board");
  else if (!$("connectOv").classList.contains("hidden")) tutOpen("quarterdeck");
}
setTimeout(tutMaybeAuto, 2200);

if (bridge.autotestHost) {
  /* FLEETCOMM_DEMO swaps rig-speak for in-character strings in screenshot
     runs; every check reads the same variables, so nothing is exempted */
  const DEMO = !!bridge.demoMode;
  const DEMO_CS = DEMO ? "TIBER DOC 1" : "AUTOTEST-RIG";
  const DEMO_CHECKIN = DEMO ? "radio check, all stations report in" : "autotest checking in";
  const DEMO_BOARD = DEMO ? "TIBER copies — nominal on all nets, over" : "board chat check";
  setTimeout(() => {
    store.set("hostOverride", bridge.autotestHost);
    $("hostrow").style.display = "flex";
    $("hostIn").value = bridge.autotestHost;
    $("csIn").value = DEMO_CS;
    $("connectBtn").click();
    setTimeout(async () => {
      /* nobody is auto-tuned any more, so the rig tunes a few itself before the
         checks that need live nets — and proves a bare connection works first */
      console.log("[AUTOTEST] connected-tuned-to-nothing=" + connected + " nets-tuned=" + nets.filter(n => n.tuned).length);
      const view0 = await ipcRenderer.invoke("atc-view");
      console.log("[AUTOTEST] atc-works-untuned=" + (Array.isArray(view0) && view0.length > 0));
      for (let k = 0; k < nets.length && nets.filter(n => n.tuned).length < 4; k++) {
        if (!nets[k].cfg.ship && !nets[k].parent) await tuneNet(k, true);
      }
      const tuned = nets.filter(n => n.tuned);
      selectedI = nets.findIndex(n => n.tuned);
      console.log("[AUTOTEST] connected=" + connected + " tuned=" + tuned.length + " selected=" + (sel() ? sel().cfg.name : "-"));
      if (tuned.length) { $("chatIn").disabled = false; $("chatIn").value = DEMO_CHECKIN; sendChat(); }
      const view = await ipcRenderer.invoke("atc-view");
      console.log("[AUTOTEST] atc-channels=" + view.length + " chatlen=" + (sel() ? sel().chat.length : 0));
      ipcRenderer.send("ov-toggle");
      $("fxsel").value = "heavy"; $("fxsel").dispatchEvent(new Event("change"));
      setTimeout(() => console.log("[AUTOTEST] fx=" + fxPreset + " chains=" + nets.filter(n => n.tuned).every(n => n.fxNodes && n.fxNodes.length > 0)), 1200);
      /* helmet-cam signaling: a REAL wire round-trip — chunks out through the
         control connection, session-targeted back at ourselves, reassembled.
         Proves the whole path: preload allowlists, main relay, radio-stack
         pacing, fake-murmur's faithful session targeting, the codec. */
      try {
        const cp = await ipcRenderer.invoke("cam-peers");
        const selfPeer = (cp.peers || []).find(p => p.self);
        if (selfPeer) {
          const got = new Promise((res) => {
            const off = ipcRenderer.on("cam-signal", (ev2, sig) => { off(); res(sig); });
            setTimeout(() => res(null), 6000);
          });
          ipcRenderer.send("cam-signal", { sessions: [selfPeer.session],
            chunks: bridge.camSignal.encodeChunks("rt1", { t: "who", mark: "selftrip" }, 3800) });
          const sig = await got;
          const m = sig && bridge.camSignal.newReassembler({}).feed(sig.actor, sig.message, 0);
          console.log("[AUTOTEST] cam-signal-selftrip=" + !!(m && m.t === "who" && m.mark === "selftrip"));
        } else console.log("[AUTOTEST] cam-signal-selftrip=no-self-peer");
      } catch (e) { console.log("[AUTOTEST] cam-signal-selftrip=ERR " + e.message); }
    }, 6000);
  }, 800);
  ipcRenderer.on("ov-shown", (ev, shown) => console.log("[AUTOTEST] overlay=" + shown));

  /* stage the board for the visual smoke (FLEETCOMM_SHOT): a tuned ship,
     selected, LSN ALL on — the state operators actually run ships in */
  setTimeout(async () => {
    const s = nets.findIndex(n => n.cfg.ship);
    if (s < 0) return;
    if (!nets[s].tuned) await tuneNet(s, true);
    const r = await ipcRenderer.invoke("listen-all", { idx: nets[s].idx, on: true, names: subnetNamesOf(nets[s]) });
    nets[s].lsnAll = !!(r && r.ok);
    selectedI = s;
    $("dlg").classList.remove("on");   /* clear any dialog a behavioral check left open */
    renderNets();
    const card = $("netlist").querySelector('.net[data-i="' + s + '"]');
    if (card) card.scrollIntoView({ block: "center" });
    console.log("[AUTOTEST] shot-stage=" + nets[s].cfg.name + " tuned=" + nets[s].tuned + " lsnall=" + nets[s].lsnAll);
    console.log("[AUTOTEST] ship-count-live=" + /ALL \d+ NETS/.test(card ? card.innerHTML : ""));
    console.log("[AUTOTEST] ship-no-stray-cnt=" + !(card && card.querySelector("[data-cnt]")));
    /* light the ON AIR state so the visual smoke captures it strobing */
    nets[s].tx = true; renderNets();
    const txCard = $("netlist").querySelector('.net[data-i="' + s + '"]');
    if (txCard) txCard.scrollIntoView({ block: "center" });
    const badge = txCard && txCard.querySelector(".onair");
    console.log("[AUTOTEST] onair-shown-while-tx=" + !!(badge && getComputedStyle(badge).display !== "none"));
    const quiet = $("netlist").querySelector('.net:not(.tx-live) .onair');
    console.log("[AUTOTEST] onair-hidden-when-quiet=" + !!(quiet && getComputedStyle(quiet).display === "none"));
  }, 24000);

  /* visual smoke SERIES — after main's 28s COMMS capture, walk every station
     and both watches. Each shot lands as <FLEETCOMM_SHOT stem>-<name>.png;
     the invoke no-ops (ok:false) in runs without FLEETCOMM_SHOT. */
  setTimeout(async () => {
    const wait = (ms) => new Promise((res) => setTimeout(res, ms));
    const shot = (name) => ipcRenderer.invoke("autotest-shot", name).catch(() => ({ ok: false }));
    const first = await shot("probe");
    if (first && first.ok) {
      for (const [pg, name] of [["pgChat", "chat"], ["pgAtc", "atc"], ["pgCam", "cam"], ["settings", "sys"]]) {
        showPage(pg); await wait(1000); await shot(name);
      }
      /* the source picker too — it shipped ugly once because nobody ever
         photographed it */
      showPage("pgCam"); $("camStart").click(); await wait(900); await shot("cam-pick");
      $("camPick").hidden = true; $("camPick").innerHTML = "";
      /* a live wall with real pixels: canvas feeds stand in for helmet cams */
      const feeds = [];
      const fakeFeed = (label) => {
        const c = document.createElement("canvas"); c.width = 640; c.height = 360; const x = c.getContext("2d");
        const f = { alive: true, n: 0 };
        const draw = () => {
          if (!f.alive) return;
          x.fillStyle = "#0b1a12"; x.fillRect(0, 0, 640, 360); x.strokeStyle = "#1f3a2a";
          for (let i = 0; i < 640; i += 40) { x.beginPath(); x.moveTo(i, 0); x.lineTo(i, 360); x.stroke(); }
          for (let j = 0; j < 360; j += 40) { x.beginPath(); x.moveTo(0, j); x.lineTo(640, j); x.stroke(); }
          x.fillStyle = "#5CA877"; x.font = "bold 26px monospace"; x.fillText(label, 24, 320);
          x.fillStyle = "#C9A96A"; x.fillRect(300 + Math.sin(f.n / 10) * 120, 150, 40, 40); f.n++;
          requestAnimationFrame(draw);
        };
        draw(); feeds.push(f); return c.captureStream(15);
      };
      /* the streamer's source card rides the live-wall shot */
      { const c = document.createElement("canvas"); c.width = 160; c.height = 90; const x = c.getContext("2d");
        x.fillStyle = "#101820"; x.fillRect(0, 0, 160, 90); x.fillStyle = "#C9A96A"; x.fillRect(60, 30, 40, 30);
        camShowSource({ name: "Star Citizen", thumb: c.toDataURL() }); }
      const tA = camMountTile(9001, "TIBER DOC 2", fakeFeed("HANGAR DECK 2"), false, { cs: "TIBER DOC 2", who: "Test Operator", since: Date.now() - 754000 });
      const tB = camMountTile(9002, "WARRIOR TAC 4", fakeFeed("FLIGHT DECK"), false, { cs: "WARRIOR TAC 4", who: "Second Operator", since: Date.now() - 128000 });
      tA.classList.add("talking"); camTick(); await wait(800); await shot("cam-live");
      feeds.forEach(f => { f.alive = false; }); tA.remove(); tB.remove(); camViewState();
      /* ACCOUNTS & ACCESS with a stand-in roster, search active */
      showPage("pgAcct"); await wait(300);
      acctData = { accounts: [
        { discordId: "1", discordName: "nailo", callsign: "TIBER DOC 2", role: "member", lastSeen: Date.now() - 3600e3 },
        { discordId: "2", discordName: "sven", callsign: "WARRIOR TAC 4", role: "element", lastSeen: Date.now() - 120e3 },
        { discordId: "3", discordName: "abxy", callsign: "TIBER DOC 1", role: "command", lastSeen: Date.now() },
        { discordId: "4", discordName: "newguy", callsign: "", role: "pending", lastSeen: 0 },
        { discordId: "5", discordName: "oak", callsign: "MINERVA ENG 3", role: "member", lastSeen: Date.now() - 86400e3 }
      ], access: { "COMMAND NET": "command", "EMERGENCY NET": "member" } };
      $("acctSearch").value = "tiber"; renderAccts(); await wait(400); await shot("accts");
      $("acctSearch").value = ""; acctData = null; $("acctList").innerHTML = ""; $("netAccess").innerHTML = ""; $("acctCount").textContent = "";
      /* the walkthrough at its PTT mark */
      showPage("pgComms"); const tdWas = store.get("tutDone", false);
      tutOpen("board"); $("tutNext").click(); await wait(500); $("tutNext").click(); await wait(600); await shot("tutorial");
      tutClose(false); store.set("tutDone", tdWas);
      /* the in-game overlay window too — show it if hidden, capture, restore */
      const ovWasHidden = $("ovShowBtn").textContent === "SHOW";
      if (ovWasHidden) $("ovShowBtn").click();
      await wait(900); await shot("overlay");
      if (ovWasHidden) $("ovShowBtn").click();
      themeMode = "light"; applyTheme(); showPage("pgComms"); await wait(1000); await shot("day");
      /* the overlay in DAYLIGHT too — it shipped broken once because the
         series only ever photographed it in the dark */
      const ovWasHidden2 = $("ovShowBtn").textContent === "SHOW";
      if (ovWasHidden2) $("ovShowBtn").click();
      await wait(900); await shot("overlay-day");
      if (ovWasHidden2) $("ovShowBtn").click();
      themeMode = "dark"; applyTheme(); await wait(400);
      /* the quarterdeck: un-hide the sign-in overlay long enough for its
         entrance to settle, capture, put it back */
      $("connectOv").classList.remove("hidden"); await wait(1400); await shot("signin");
      $("connectOv").classList.add("hidden");
      console.log("[AUTOTEST] shot-series-done");
    }
  }, 30000);

  /* ── v0.9 feature checks ── */
  setTimeout(async () => {
    const cs = getComputedStyle(document.documentElement);
    const L = (k, v) => console.log("[AUTOTEST] " + k + "=" + v);

    /* selection arms TX, and arms exactly one */
    const tunedIdx = nets.map((n, i) => i).filter(i => nets[i].tuned);
    if (tunedIdx.length > 1) {
      cycleSel(1);
      L("armed-count", nets.filter(n => n.tuned && n.txOn).length);
      L("armed-is-selected", !!(sel() && sel().txOn));
    } else L("armed-skip", "needs 2+ tuned nets");

    /* theme: custom applies, and leaving custom clears every custom var */
    const before = themeMode;
    customTheme.accent = "#ff00ff"; customTheme.red = "#00ff00";
    themeMode = "custom"; applyTheme();
    L("custom-holo", document.documentElement.style.getPropertyValue("--holo").trim());
    L("custom-red", document.documentElement.style.getPropertyValue("--red").trim());
    themeMode = "dark"; applyTheme();
    const leaked = ["--holo","--red","--bez","--amber","--grn","--tx","--ok"]
      .filter(k => document.documentElement.style.getPropertyValue(k).trim() !== "");
    L("theme-leak", leaked.length ? leaked.join("|") : "none");
    themeMode = before; customTheme = Object.assign({}, THEME_DEFAULTS); applyTheme();

    /* new UI plumbing present */
    L("ctx-menu", !!document.getElementById("ctx"));
    L("splitter", !!document.getElementById("split"));
    L("acct-scroll", !!document.getElementById("acctScroll"));
    L("theme-inputs", Object.keys(THEME_DEFAULTS).filter(k => document.getElementById("c_" + k)).length);

    /* net dialog opens in edit mode without throwing */
    /* the dialog is COMMAND-gated; prove the gate AND the dialog behind it */
    L("edit-gated-without-token", (openNetDialog("edit", tunedIdx[0] != null ? tunedIdx[0] : 0),
        !document.getElementById("dlg").classList.contains("on")));
    cmdToken = "autotest-token";
    /* typography actually applied? */
    document.fonts.ready.then(() => {
      /* Atkinson now serves the instrument values (bold face) — check the
         weight that's actually on duty */
      L("font-loaded", document.fonts.check('700 16px "Atkinson Hyperlegible"'));
      /* the trio IS the brand — a missing woff2 silently falls back to
         Arial/Georgia/Consolas and the whole watch reads wrong */
      L("font-display-loaded", document.fonts.check('600 16px "Barlow Condensed"'));
      L("font-prose-loaded", document.fonts.check('16px "Newsreader"'));
      L("font-mono-loaded", document.fonts.check('16px "IBM Plex Mono"'));
      L("body-font", getComputedStyle(document.body).fontFamily.split(",")[0]);
      L("body-size", getComputedStyle(document.body).fontSize);
      const tiny = [...document.querySelectorAll("*")]
        .map(el => parseFloat(getComputedStyle(el).fontSize))
        .filter(v => v && v < 10);
      L("elements-under-10px", tiny.length);
    });

    /* the net tree: order must follow parentage, not array order */
    const shown = [...document.querySelectorAll("#netlist .net")]
      .map(el => nets[+el.dataset.i].cfg.name + "@" + (el.style.getPropertyValue("--lvl") || "0"));
    L("tree-order", shown.join(" | "));
    L("tree-rows-vs-nets", tree.rows.length + "/" + nets.length);

    /* titlebar colours must equal the live bezel/ink, in every mode */
    const bez = () => getComputedStyle(document.documentElement).getPropertyValue("--bez").trim();
    themeMode = "dark"; applyTheme();
    L("titlebar-dark", cssHex("--bez", "?") + " vs bezel " + bez());
    themeMode = "light"; applyTheme();
    L("titlebar-light", cssHex("--bez", "?") + " vs bezel " + bez());
    customTheme.bez = "#402030"; themeMode = "custom"; applyTheme();
    L("titlebar-custom", cssHex("--bez", "?") + " (set #402030)");
    themeMode = "dark"; customTheme = Object.assign({}, THEME_DEFAULTS); applyTheme();

    /* this round: overlay box, row density, nest indent, clip level, denial */
    L("overlay-box-beside-auth", (function () {
      const b = document.querySelector(".ovbox");
      const a = document.querySelector(".authbox");
      return !!(b && a && a.parentElement === b.parentElement && a.nextElementSibling === b);
    })());
    L("overlay-buttons", !!document.getElementById("ovShowBtn") && !!document.getElementById("ovEditBtn"));
    /* the rig can run with the overlay already up, so assert the invariant
       (edit enabled exactly when shown), not a fixed staging assumption */
    L("overlay-edit-follows-shown", ovShown === !document.getElementById("ovEditBtn").disabled);
    {
      const rows = [...netlist.querySelectorAll(".net")];
      const top = rows.find(r => !r.classList.contains("sub"));
      const sub = rows.find(r => r.classList.contains("sub"));
      if (top) L("row-height-px", Math.round(top.getBoundingClientRect().height));
      if (top && sub) L("nest-indent-px",
        Math.round(sub.getBoundingClientRect().left - top.getBoundingClientRect().left));
    }
    L("clip-target", (function () {
      const m = String(playClipOnNet).match(/CLIP_TARGET\s*=\s*([0-9.]+)/);
      return m ? m[1] : "?";
    })());
    L("soundboard-always-shipwide", /shipwide\s*\|\|/.test(String(playClipOnNet)));
    {
      /* a ship row shows group controls, never the denied banner — stage the
         denial on a plain net (the old channel plan handed us one by luck) */
      const n = nets.find(x => !x.tuned && !x.cfg.ship) || nets[0];
      const was = n.denied;
      n.denied = "you don't have access to " + n.cfg.name; renderNets();
      const card = netlist.querySelector('[data-i="' + nets.indexOf(n) + '"]');
      L("denied-row-shows-restricted", !!(card && card.querySelector(".denied")));
      L("denied-row-hides-tune", !(card && card.querySelector("[data-tune]")));
      n.denied = was; renderNets();
    }

    /* SYS page: it was pinned to 660px and stopped partway across a wide window */
    showPage("settings");
    const sys = document.getElementById("sysScroll");
    const page = document.getElementById("settings");
    for (const w of [1400, 1000, 700]) {
      document.body.style.width = w + "px";
      const sw = Math.round(sys.getBoundingClientRect().width);
      const pw = Math.round(page.getBoundingClientRect().width);
      L("sys-width-at-" + w, sw + "px of " + pw + "px  overflow=" +
        Math.max(0, sys.scrollWidth - sys.clientWidth));
    }
    document.body.style.width = "";
    L("acct-note-text", JSON.stringify((document.getElementById("acctEpNote").textContent || "").slice(0, 70)));
    L("acct-under-advanced", (function () {
      let el = document.getElementById("acctEpNote").closest(".togrow");
      while (el && el.previousElementSibling) {
        el = el.previousElementSibling;
        if (el.classList.contains("miniheading")) return el.textContent.trim();
      }
      return "(no heading found)";
    })());
    showPage("pgComms");

    /* the reported bug: a ship name crushed to "UEE…" by the badges beside it.
       Squeeze the rail to the width in the screenshot and check what survives. */
    const rail = document.getElementById("chanCol");
    const prevW = rail.style.width;
    rail.style.width = "300px";
    /* tune the ship so its sliders exist to measure */
    const shipIdx0 = nets.findIndex(n => n.cfg.ship);
    if (shipIdx0 >= 0 && !nets[shipIdx0].tuned) await tuneNet(shipIdx0, true);
    renderNets();
    const shipCard = netlist.querySelector(".net.shipgroup");
    if (shipCard) {
      const nm = shipCard.querySelector("b.nm");
      const full = nm.textContent;
      /* scrollWidth > clientWidth means it is being ellipsised */
      L("ship-name-at-300px", JSON.stringify(full) +
        " clipped=" + (nm.scrollWidth > nm.clientWidth + 1) +
        " shown≈" + Math.round(nm.clientWidth) + "px need=" + Math.round(nm.scrollWidth) + "px");
      L("ship-row-wraps", getComputedStyle(shipCard.querySelector(".nt")).flexWrap);
      /* the reported bug: the L·R (pan) slider pushed off the right edge */
      const srow = shipCard.querySelector(".srow");
      if (srow) {
        const pan = srow.querySelector("input.pan");
        const rowR = srow.getBoundingClientRect(), panR = pan.getBoundingClientRect();
        L("pan-slider-visible", panR.width > 8 && panR.right <= rowR.right + 1);
        L("pan-overflow-px", Math.round(Math.max(0, panR.right - rowR.right)));
        L("srow-overflow-px", Math.max(0, srow.scrollWidth - srow.clientWidth));
      } else L("srow", "ship not tuned in rig");
    }
    rail.style.width = prevW; renderNets();

    /* ship groups, name-first rows, ordering */
    const shipI = nets.findIndex(n => n.cfg.ship);
    if (shipI >= 0) {
      const card = netlist.querySelector('[data-i="' + shipI + '"]');
      L("ship-is-group", !!(card && card.classList.contains("shipgroup")));
      L("ship-has-lsnall", !!(card && card.querySelector("[data-lsnall]")));
      L("ship-has-txall", !!(card && card.querySelector("[data-txall]")));
      L("ship-has-no-tune", !(card && card.querySelector("[data-tune]")));
      const nm = card && card.querySelector("b.nm");
      const fq = card && card.querySelector(".fq");
      L("name-bigger-than-freq", nm && fq
        ? parseFloat(getComputedStyle(nm).fontSize) > parseFloat(getComputedStyle(fq).fontSize) : "?");
      /* 1.0.1: rows are NOT draggable at rest — the ⠿ grip arms the drag on
         pointerdown and release disarms it, so the VOL/L·R sliders slide
         instead of grabbing the whole card */
      L("rows-not-draggable-at-rest", !!(card && !card.draggable));
      const grip = card && card.querySelector("[data-grip]");
      if (grip) {
        grip.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
        L("grip-arms-drag", card.draggable === true);
        window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
        L("release-disarms-drag", card.draggable === false);
      } else L("grip-arms-drag", "no grip in rig");
    }
    const shapes = netShapes();
    const sub = nets.find(n => n.parent);
    const top = nets.find(n => !n.parent && !n.cfg.ship);
    if (sub && top) {
      L("nest-escape-refused", !canReorder(shapes, sub.cfg.name, top.cfg.name));
      const sib = nets.find(n => n.parent === sub.parent && n.cfg.name !== sub.cfg.name);
      if (sib) L("sibling-reorder-allowed", canReorder(shapes, sub.cfg.name, sib.cfg.name));
    }

    /* PTT prompt, settings cog, device pickers, header scaling */
    const savedActive = masterBinds.active;
    masterBinds.active = null; renderMasterBinds();
    L("ptt-unbound-flagged", document.getElementById("pttRow").classList.contains("unbound"));
    L("ptt-btn-flagged", document.getElementById("ptt").classList.contains("needsbind"));
    masterBinds.active = { src: "label", label: "F14" }; renderMasterBinds();
    L("ptt-bound-clears", !document.getElementById("pttRow").classList.contains("unbound"));
    masterBinds.active = savedActive; renderMasterBinds();
    L("sys-key-label", (document.getElementById("sysKey").textContent || "").indexOf("SETTINGS") >= 0);
    L("device-pickers", !!document.getElementById("micSel") && !!document.getElementById("outSel"));

    /* keybind unbind (1.0.1): BACKSPACE while listening writes null through
       the real storage path; ESC walks away keeping the old key */
    const savedCycUp = masterBinds.cycUp;
    capturing = { kind: "master", which: "cycUp" };
    onKeyDown("dom", "Backspace", "Backspace", []);
    L("bind-clears-to-unbound", masterBinds.cycUp === null && capturing === null);
    L("bind-clear-persisted", store.get("masterBinds6", {}).cycUp === null);
    L("bind-badge-reads-set-key", $("bindCycUp").textContent === "set key");
    masterBinds.cycUp = { src: "label", label: "PageUp", mods: [] };
    capturing = { kind: "master", which: "cycUp" };
    onKeyDown("dom", "Escape", "Escape", []);
    L("bind-esc-keeps-old-key", !!(masterBinds.cycUp && masterBinds.cycUp.label === "PageUp") && capturing === null);
    masterBinds.cycUp = savedCycUp; store.set("masterBinds6", masterBinds); renderMasterBinds();
    L("bind-listen-chrome-cleared", !$("bindCycUp").classList.contains("listen"));

    /* fx intensity dial (1.0.1): presets are anchors, off-anchor reads CUSTOM */
    const savedFxI = fxIntensity;
    $("fxSl").value = 75; $("fxSl").dispatchEvent(new Event("change"));
    L("fx-dial-custom", $("fxsel").value === "custom" && fxIntensity === 75);
    L("fx-dial-between-anchors", (function () {
      const p = bridge.fxCurve.paramsAt(0.75);
      return p.hp > 300 && p.hp < 400 && p.drive > 0.35 && p.drive < 0.8;
    })());
    $("fxsel").value = "standard"; $("fxsel").dispatchEvent(new Event("change"));
    L("fx-preset-snaps-dial", fxIntensity === 50 && $("fxVal").textContent === "50" && $("fxCustomOpt").hidden);
    fxIntensity = savedFxI; store.set("fxIntensity", savedFxI); renderFxDial();

    /* helmet cam (1.0.1): station present, codec sane; the wire round-trip
       runs in the behavioral block above (cam-signal-selftrip) */
    L("cam-page-present", !!document.getElementById("pgCam") && !!document.getElementById("camStart") && !!document.getElementById("camGrid"));
    L("cam-codec-roundtrip", (function () {
      try {
        const chunks = bridge.camSignal.encodeChunks("t1", { t: "offer", sdp: "x".repeat(6000) }, 3800);
        const r = bridge.camSignal.newReassembler({});
        let out = null;
        for (const c of chunks) out = r.feed("me", c, 0) || out;
        return chunks.length >= 2 && !!out && out.sdp.length === 6000;
      } catch (e) { return "ERR " + e.message; }
    })());

    /* ship's state (1.0.1): the rail lists the ships of the line */
    L("ship-state-rows", document.querySelectorAll("#shipStateRows .rd").length > 0);

    /* 1MC (1.0.1): the local monitor is gone — clips reach the sender only
       through the net like everyone else */
    L("sb-no-local-monitor", !/ctx\.destination/.test(String(playClipOnNet)));

    /* update visibility: busy overlay shows and clears; a version change
       demands acknowledgement and OK records it */
    showUpdBusy("9.9.9", "Downloading FleetComm v9.9.9\u2026");
    L("upd-busy-shown", !$("updOv").classList.contains("hidden") && /9\.9\.9/.test($("updOvState").textContent));
    hideUpdOv();
    L("upd-busy-cleared", $("updOv").classList.contains("hidden"));
    const savedAck = store.get("ackVersion", null);
    store.set("ackVersion", "0.0.1"); ackVersionCheck();
    L("upd-ack-shown", !$("updOv").classList.contains("hidden") && $("updOvOk").style.display !== "none");
    L("upd-ack-text", $("updOvState").textContent);
    $("updOvOk").click();
    L("upd-ack-cleared", $("updOv").classList.contains("hidden") && store.get("ackVersion", null) === bridge.version);
    store.set("ackVersion", savedAck === null ? bridge.version : savedAck);

    /* v0.12.8: ship rows say 1MC, board chat above the log, fleet clip library */
    L("ship-row-says-1mc", /data-txall[^>]*>1MC</.test($("netlist").innerHTML));
    L("comms-chat-present", !!$("commsChat") && !!$("vsplit") && !!$("chatIn2"));
    $("chatFeed2").style.height = "200px"; store.set("commsChatH", 200);
    L("comms-chat-resizable", getComputedStyle($("chatFeed2")).height === "200px");
    if (sel() && sel().tuned && sel().mon) {
      $("chatIn2").disabled = false; $("chatIn2").value = DEMO_BOARD; sendChatFrom($("chatIn2"));
      L("comms-chat-mirrors", $("chatFeed2").textContent.indexOf(DEMO_BOARD) >= 0 &&
        $("chatFeed").textContent.indexOf(DEMO_BOARD) >= 0);
    } else L("comms-chat-mirrors", "skip — no tuned net");
    const sbCmdWas = cmdToken;
    cmdToken = "autotest-token"; renderSoundLib();
    L("sndlib-shown-for-command", $("sndLib").style.display !== "none");
    cmdToken = ""; renderSoundLib();
    L("sndlib-hidden-without-command", $("sndLib").style.display === "none");
    cmdToken = sbCmdWas; renderSoundLib();

    /* flight stick end-to-end with a synthetic pad: capture binds it,
       pressing keys the net (ON AIR lights), releasing un-keys it */
    {
      /* buttons shaped like Chromium's GamepadButton — pressed/value as
         PROTOTYPE getters, no own properties — so the fake crosses the
         contextBridge exactly the way a real stick does (a plain-object fake
         passed for months while every real stick read as all-false) */
      class HostBtn { constructor(p) { Object.defineProperty(this, "_p", { value: p, enumerable: false }); } get pressed() { return this._p; } get value() { return this._p ? 1 : 0; } }
      const fakePad = (pressed) => [{ id: "T.16000M (Vendor: 044f Product: b10a)", index: 0,
        buttons: [new HostBtn(false), new HostBtn(false), new HostBtn(pressed)] }];
      const savedBind = masterBinds.active;
      /* arm exactly one tuned net so pttAll has a deterministic target,
         independent of what earlier checks left selected */
      const armI = nets.findIndex(n => n.tuned);
      const armWas = armI >= 0 ? nets[armI].txOn : null;
      if (armI >= 0) nets[armI].txOn = true;
      pollPads(fakePad(false));                 /* seed the state, no events */
      capturing = { kind: "master", which: "active" };
      pollPads(fakePad(true));                  /* press while capturing -> binds */
      L("pad-captures-bind", !!(masterBinds.active && masterBinds.active.src === "pad" &&
        masterBinds.active.label === "T.16000M B2"));
      pollPads(fakePad(false));                 /* release: engine sees the up */
      const txBefore = nets.filter(n => n.tx).length;
      pollPads(fakePad(true));                  /* press -> PTT down */
      /* the rig has no microphone, so actual keying stops at the ensureMic
         gate — by design. What the pad path owns ends at PTT intent: held
         state plus a transmit reason on every armed net. */
      const heldOk = pttHeld === true;
      const reasonsOn = nets.filter(n => n._txReasons && n._txReasons.has("ptt")).length;
      pollPads(fakePad(false));                 /* release -> PTT up */
      const reasonsOff = nets.filter(n => n._txReasons && n._txReasons.has("ptt")).length;
      L("pad-drives-ptt", txBefore === 0 && heldOk && reasonsOn > 0 && pttHeld === false && reasonsOff === 0);
      if (armI >= 0) nets[armI].txOn = armWas;
      masterBinds.active = savedBind; store.set("masterBinds6", masterBinds); renderMasterBinds();
    }

    /* mic lifecycle: concurrent opens share one attempt, and a re-open after a
       device switch must succeed (the worklet module can only register once —
       a second addModule used to throw and fail every microphone switch) */
    {
      const [a, b] = await Promise.all([ensureMic(), ensureMic()]);
      if (!a) { L("mic-reopen", "skipped(no-mic-here)"); }
      else {
        L("mic-concurrent-open", a === true && b === true && !!capNode);
        try { capNode.disconnect(); } catch (e) {}
        capNode = null;                       /* what the device-switch path does */
        L("mic-reopen", (await ensureMic()) === true && !!capNode);
      }
    }

    /* master volume sliders: voice drives the master bus, 1MC is independent */
    const volWas = masterVol, sbWas = sbVol;
    $("masterVolSl").value = 60; $("masterVolSl").dispatchEvent(new Event("input"));
    L("mastervol-drives-bus", Math.abs(masterGain.gain.value - 0.6) < 0.001 && store.get("masterVol") === 60);
    $("sbVolSl").value = 130; $("sbVolSl").dispatchEvent(new Event("input"));
    L("sbvol-independent", Math.abs(masterGain.gain.value - 0.6) < 0.001 && sbVol === 130 && store.get("sbVol2") === 130);
    masterVol = volWas; sbVol = sbWas; applyMasterVols();

    /* ── stress-test findings, 2026-09-01 ── */
    /* a key bound to an untuned net keys nothing, and says so */
    {
      const ui = nets.findIndex(n => !n.tuned && !n.group);
      if (ui < 0) L("untuned-bind-idle", "skipped(all-tuned)");
      else {
        const u = nets[ui], bindWas = u.bind;
        u.bind = { src: "label", label: "F23" };
        const reasonsBefore = nets.filter(n => n._txReasons && n._txReasons.has("bind")).length;
        onKeyDown("dom", "F23", "F23", []);
        await new Promise(r => setTimeout(r, 60));
        const reasonsAfter = nets.filter(n => n._txReasons && n._txReasons.has("bind")).length;
        L("untuned-bind-idle", !u.tx && !u.tuned && reasonsAfter === reasonsBefore &&
          $("toast").style.display === "block" && /not tuned/.test($("toast").textContent));
        onKeyUp("dom", "F23", "F23");
        u.bind = bindWas; $("toast").style.display = "none";
      }
    }
    /* a per-net key must chirp like the master PTT: the chirps belong to the
       carrier transitions, not to the button (Sven, IF-55 bind, 2026-09-02) */
    {
      const bi = nets.findIndex(n => n.tuned && n.idx != null);
      if (bi < 0 || !connected) L("bind-chirps", "skipped(no-tuned)");
      else {
        const d0 = chirpCount.down, u0 = chirpCount.up;
        await requestTX(bi, "bind");
        if (!nets[bi].tx) L("bind-chirps", "skipped(no-mic)");
        else {
          const keyed = chirpCount.down === d0 + 1 && chirpCount.up === u0;
          releaseTX(bi, "bind");
          L("bind-chirps", keyed && !nets[bi].tx && chirpCount.up === u0 + 1 && chirpCount.down === d0 + 1);
        }
      }
    }
    /* the global hook relays OS key auto-repeat: a held cycle key must step once */
    {
      const tunedCount = nets.filter(n => n.tuned).length;
      if (tunedCount < 2) L("gkey-repeat-filtered", "skipped(<2 tuned)");
      else {
        const selWas = selectedI, gWas = gActive, txOnWas = nets.map(n => n.txOn);
        const before = selectedI;
        onGKey({ type: "key", code: 3657, label: "PageDown", down: true });
        onGKey({ type: "key", code: 3657, label: "PageDown", down: true });   /* auto-repeat */
        onGKey({ type: "key", code: 3657, label: "PageDown", down: true });
        const once = selectedI;
        onGKey({ type: "key", code: 3657, label: "PageDown", down: false });
        onGKey({ type: "key", code: 3657, label: "PageDown", down: true });
        const twice = selectedI;
        onGKey({ type: "key", code: 3657, label: "PageDown", down: false });
        const tunedOrder = tree.rows.map(r => r.i).filter(i => nets[i].tuned);
        const expectOnce = tunedOrder[(tunedOrder.indexOf(before) + 1) % tunedOrder.length];
        L("gkey-repeat-filtered", once === expectOnce && twice !== once);
        selectedI = selWas; gActive = gWas; nets.forEach((n, i) => { n.txOn = txOnWas[i]; }); renderNets();
      }
    }
    /* the cam wall: 1, 2, 2x2, 3x2, 3x3, then four across */
    L("cam-wall-columns", [1, 2, 3, 4, 5, 6, 9, 10, 16].map(n => camCols(n)).join(",") === "1,2,2,2,3,3,3,4,4");
    {
      const g = $("camGrid"), stub = document.createElement("div"); stub.className = "tile";
      g.append(stub, stub.cloneNode(), stub.cloneNode(), stub.cloneNode()); camViewState();
      const cs = getComputedStyle(stub), tracks = getComputedStyle(g).gridTemplateColumns;
      /* the CAM page is not on screen here, so the computed value is the
         unresolved repeat(); on screen it resolves to two pixel tracks */
      L("cam-wall-2x2", g.style.getPropertyValue("--camcols") === "2" &&
        (/^repeat\(2,/.test(tracks) || tracks.split(" ").length === 2));
      L("cam-tile-clips-scanband", cs.overflow === "hidden");
      g.innerHTML = ""; camViewState();
    }
    /* walkthrough: opens on demand, marks the real controls, skip persists */
    {
      const doneWas = store.get("tutDone", false), pendWas = store.get("tutPending", false);
      store.set("tutDone", false);
      tutOpen("board");
      L("tut-opens", !$("tut").hidden && tut.steps.length === 5 && $("tutTitle").textContent === "PICK A CHANNEL");
      await new Promise(r => setTimeout(r, 350));
      L("tut-spotlights-board", $("tut").querySelector(".tut-spot").getBoundingClientRect().width > 50);
      /* step 1 advances by itself when a net is tuned — fake the event */
      tutEvent("tuned"); await new Promise(r => setTimeout(r, 1300));
      const onKeyStep = $("tutTitle").textContent === "SET YOUR TALK KEY";
      /* entering the key step arms capture for the operator */
      const armed = !!(capturing && capturing.kind === "master" && capturing.which === "active");
      $("tutNext").click();                          /* NEXT disarms the capture the tour armed */
      const disarmed = !capturing;
      await new Promise(r => setTimeout(r, 350));
      const spotR = $("tut").querySelector(".tut-spot").getBoundingClientRect(), pttR = $("ptt").getBoundingClientRect();
      L("tut-ptt-step", onKeyStep && armed && disarmed && $("tutTitle").textContent === "TALK" && Math.abs(spotR.left + 6 - pttR.left) < 2 && Math.abs(spotR.top + 6 - pttR.top) < 2);
      $("tutSkip").click();
      L("tut-skip-persists", $("tut").hidden && store.get("tutDone") === true);
      store.set("tutDone", doneWas); store.set("tutPending", pendWas);
    }
    /* cam: the keyed operator's tile outlines; the burn-in timer and name show */
    {
      const k = nets.findIndex(n => n.tuned);
      const stub = camMountTile(4242, "TIBER DOC 2", null, false, { cs: "TIBER DOC 2", who: "Test Operator", since: Date.now() - 65000 });
      stub.dataset.since = String(Date.now() - 65000); camTick();
      L("cam-timer-burnin", /^00:01:0[5-7]$/.test(stub.querySelector("[data-timer]").textContent) && stub.querySelector(".who").textContent === "Test Operator");
      if (k >= 0) {
        nets[k].roster.set(4242, "TIBER-DOC-2"); nets[k].speaking.set(4242, Date.now() + 3000); camTalkSync();
        const on = stub.classList.contains("talking");
        nets[k].speaking.delete(4242); nets[k].roster.delete(4242); camTalkSync();
        L("cam-talking-outline", on && !stub.classList.contains("talking"));
      } else L("cam-talking-outline", "skipped(no-tuned)");
      stub.remove(); camViewState();
    }
    /* ACCOUNTS & ACCESS search: one box filters operators and nets, counts, marks hits */
    {
      const fake = { accounts: [
        { discordId: "1", discordName: "nailo", callsign: "TIBER DOC 2", role: "member", lastSeen: 0 },
        { discordId: "2", discordName: "sven", callsign: "WARRIOR TAC 4", role: "element", lastSeen: 0 },
        { discordId: "3", discordName: "abxy", callsign: "TIBER DOC 1", role: "command", lastSeen: 0 },
        { discordId: "4", discordName: "newguy", callsign: "", role: "pending", lastSeen: 0 }
      ], access: { "COMMAND NET": "command" } };
      const dataWas = acctData; acctData = fake;
      $("acctSearch").value = ""; renderAccts();
      const all = $("acctList").querySelectorAll(".acctrow").length;
      $("acctSearch").value = "tiber"; renderAccts();
      const tiber = $("acctList").querySelectorAll(".acctrow").length;
      const tiberNets = $("netAccess").querySelectorAll(".narow").length;
      const marked = $("acctList").querySelectorAll("mark.hit").length > 0;
      $("acctSearch").value = "tiber doc 2"; renderAccts();
      const multi = $("acctList").querySelectorAll(".acctrow").length;
      $("acctSearch").value = "pending"; renderAccts();
      const byRole = $("acctList").querySelectorAll(".acctrow").length;
      $("acctSearch").value = "zzznope"; renderAccts();
      const none = $("acctList").querySelectorAll(".acctrow").length, noneHint = /No operator matches/.test($("acctList").textContent);
      $("acctSearch").value = "121.850"; renderAccts();
      const byFreq = $("netAccess").querySelectorAll(".narow").length;
      L("acct-search", all === 4 && tiber === 2 && tiberNets > 0 && marked && multi === 1 && byRole === 1 && none === 0 && noneHint && byFreq === 1 &&
        /^0 OF 4 OPERATORS · 1 OF \d+ NETS$/.test($("acctCount").textContent));   /* the last render was the frequency search */
      $("acctSearch").value = ""; acctData = dataWas; if (dataWas) renderAccts(); else { $("acctList").innerHTML = ""; $("netAccess").innerHTML = ""; $("acctCount").textContent = ""; }
    }
    const silentOpus = () => { const e = new OpusScript(48000, 1, OpusScript.Application.VOIP); const f = e.encode(new ArrayBuffer(FRAME * 2), FRAME); try { e.delete(); } catch (x) {} return f; };
    /* cam pop-out: a real window of ours plays the same stream with the burn-in; closes with the tile */
    {
      const c = document.createElement("canvas"); c.width = 320; c.height = 180; c.getContext("2d").fillRect(0, 0, 320, 180);
      const t = camMountTile(7777, "WARRIOR TAC 4", c.captureStream(5), false, { cs: "WARRIOR TAC 4", who: "Pop Test", since: Date.now() });
      cam.watching.set(7777, { pc: null, cs: "WARRIOR TAC 4", tile: t });   /* a real tile always has its watch entry */
      t.querySelector("[data-pip]").click();
      await new Promise(r => setTimeout(r, 2000));
      const w = cam.pops.get(7777);
      let fed = false, chrome = false, err = "";
      try { fed = !!(w && !w.closed && w.document.getElementById("v").srcObject); chrome = !!(w && w.document.getElementById("cs").textContent === "WARRIOR TAC 4"); } catch (e) { err = e.message; }
      camDropTile(7777);
      await new Promise(r => setTimeout(r, 600));
      L("cam-popout", fed && chrome && !cam.pops.has(7777) && (!w || w.closed));
      if (!(fed && chrome)) L("cam-popout-detail", "opened=" + !!w + " fed=" + fed + " chrome=" + chrome + " err=" + err);
      camViewState();
    }
    /* audio backlog policy: a frame past the 750 ms backlog is DROPPED, the cursor never moves backwards */
    {
      const k = nets.findIndex(n => n.tuned && n.gainNode);
      if (k < 0) L("audio-drop-not-reset", "skipped(no-chain)");
      else {
        const key = nets[k].cfg.freq + ":424242";
        const silent = silentOpus();
        const d0 = audioDrops;
        decoders.set(key, { dec: new OpusScript(48000, 1), cursor: ctx.currentTime + 5, lastUsed: Date.now() });
        playFrame(nets[k], 424242, silent);
        const d = decoders.get(key);
        L("audio-drop-not-reset", audioDrops === d0 + 1 && d.cursor >= ctx.currentTime + 4.5);
        try { d.dec.delete(); } catch (e) {} decoders.delete(key);
      }
    }
    /* audio-clock watchdog: three flat seconds trigger a heal that re-opens
       the output and keeps the graph playable; a hiccup does not */
    {
      const h0 = audioHeals, logs0 = sysLines.length;
      audioClockSample(650, 1000); audioClockSample(1000, 1000);
      L("audio-clock-hiccup-ignored", audioHeals === h0 && !clockWatch.ailing);
      const micWasOpen = !!capNode;
      audioClockSample(650, 1000); audioClockSample(640, 1000); const p = audioClockSample(661, 1000);
      L("audio-clock-heal-fires", audioHeals === h0 + 1 && clockWatch.ailing && p instanceof Promise);
      await p; await new Promise(r => setTimeout(r, 1200));
      const drift = Math.abs((ctx.currentTime - clockWatch.c) * 1000 / (performance.now() - clockWatch.t) - 1);
      L("audio-clock-heal-playable", ctx.state === "running" && drift < 0.15 && (!micWasOpen || !!capNode));
      L("audio-clock-heal-logged", sysLines.length >= logs0 + 2 && /re-opened/.test(sysLines.join("\n")));
      audioClockSample(1000, 1000); audioClockSample(1000, 1000); audioClockSample(1000, 1000);
      L("audio-clock-recovers", !clockWatch.ailing && /back on rate/.test(sysLines.join("\n")));
      /* the second heal is a full engine rebuild: new context, every chain and the mic on it, frames still play */
      {
        const pauseWas = REBUILD_PAUSE_MS; REBUILD_PAUSE_MS = 300;
        const oldCtx = ctx, micOpen = !!capNode, r0 = audioRebuilds;
        await rebuildAudioEngine("rig");
        const k = nets.findIndex(n => n.tuned && n.gainNode);
        const chainsFresh = nets.filter(n => n.gainNode).every(n => n.gainNode.context === ctx && n.panNode.context === ctx);
        let played = false;
        if (k >= 0) { try { playFrame(nets[k], 434343, silentOpus()); played = true; } catch (e) { played = "threw:" + e.message; } }
        await new Promise(r => setTimeout(r, 1200));
        const ratio = (ctx.currentTime - clockWatch.c) * 1000 / (performance.now() - clockWatch.t);
        L("audio-rebuild-playable", audioRebuilds === r0 + 1 && ctx !== oldCtx && oldCtx.state === "closed" && ctx.state === "running" && chainsFresh && played === true && Math.abs(ratio - 1) < 0.15 && (!micOpen || !!capNode) && masterGain.context === ctx);
        if (!(audioRebuilds === r0 + 1 && ctx !== oldCtx && oldCtx.state === "closed" && ctx.state === "running" && chainsFresh && played === true && Math.abs(ratio - 1) < 0.15 && (!micOpen || !!capNode) && masterGain.context === ctx))
          L("audio-rebuild-detail", JSON.stringify({ closed: oldCtx.state, state: ctx.state, chainsFresh, played, ratio, mic: !!capNode, micOpen }));
        REBUILD_PAUSE_MS = pauseWas;
        /* a stale cursor from the OLD clock would sit far in the new clock's future; played frames may be in the past */
        const decodersOk = [...decoders.values()].every(d => d.cursor < ctx.currentTime + 2);
        L("audio-rebuild-cursors", decodersOk);
        L("cam-lead-may-watch", camMayWatch(true, { account: { role: "allied", orgLead: true } }) === true && camMayWatch(true, { account: { role: "allied", orgLead: false } }) === false);
      }
    }
    /* fleet identity: ACCOUNTS rows read rank + name from the roster, the sign-in
       card says who the fleet thinks you are, and nothing on this page can edit a name */
    {
      $("acctSearch").value = "";
      acctRoster = new Map([["424242", { discordId: "424242", rank: { abbr: "PO1" }, rating: "GM1", callsign: "Jack Sheridan" }]]);
      const fixture = { accounts: [{ discordId: "424242", discordName: "GM1 Jack Sheridan", callsign: "Jack Sheridan", role: "member", onAir: "TIBER TAC 2" },
        { discordId: "424243", discordName: "nailo", callsign: "Nailo", role: "member" }], access: {} };
      renderAccts(fixture);
      const rows = [...$("acctList").querySelectorAll(".acctrow .nm b")].map(b => b.textContent);
      const onAir = /on air as TIBER TAC 2/.test($("acctList").textContent);
      $("acctSearch").value = "gm1"; renderAccts(fixture);        /* the rig never fetched acctData — hand it the fixture */
      const bySearch = $("acctList").querySelectorAll(".acctrow").length;
      $("acctSearch").value = ""; acctRoster = new Map();
      const identityOk = rows[0] === "GM1 JACK SHERIDAN" && rows[1] === "NAILO" && bySearch === 1 && !$("acctList").querySelector("[data-setcs]") && onAir;
      L("acct-fleet-identity", identityOk);
      if (!identityOk) L("acct-fleet-identity-detail", JSON.stringify({ rows, bySearch, onAir }));
      const line = showSignedAs({ rating: "CDRE", rank: { abbr: "CDRE" }, callsign: "Travis Barnes" });
      L("signed-as-line", line === "CDRE TRAVIS BARNES" && $("signedAs").style.display === "" && $("signedAsV").textContent === "CDRE TRAVIS BARNES");
      showSignedAs(null);
    }
    /* the system log takes technical lines; the COMM LOG keeps net traffic */
    {
      const c0 = logFeed.children.length, s0 = sysLines.length;
      addLog("sys", "", "audio engine test line");
      addLog("sys", "COMMAND NET", "ACCESS DENIED — restricted net");
      L("syslog-split", sysLines.length === s0 + 1 && logFeed.children.length === c0 + 1 && /audio engine test line/.test($("sysFeed").textContent) && !/audio engine test line/.test(logFeed.textContent));
    }
    /* joint task force: the JOINT level exists, ALLIED rows render with their org, the allied list renders */
    {
      $("acctSearch").value = "";
      renderAccts({ accounts: [{ discordId: "424250", discordName: "Blue One", callsign: "Blue One", role: "allied", org: "Blue Fleet" }], access: { "COMMAND NET": "joint" } });
      const row = $("acctList").querySelector(".acctrow");
      const label = row && row.querySelector(".rolelbl").textContent;
      const sel = $("netAccess").querySelector('.narow[data-net="COMMAND NET"] select');
      L("acct-joint-level", !!sel && sel.value === "joint" && [...sel.options].some(o => o.value === "joint"));
      L("acct-allied-row", label === "ALLIED · Blue Fleet" && !!row.querySelector('[data-role="member"]') && !!row.querySelector('[data-role="revoked"]') && !!row.querySelector('[data-orglead="1"]'));
      renderAccts({ accounts: [{ discordId: "424251", discordName: "Blue Lead", callsign: "Blue Lead", role: "allied", org: "Blue Fleet", orgLead: true }], access: {} });
      const leadRow = $("acctList").querySelector(".acctrow");
      L("acct-org-lead-row", !!leadRow && leadRow.querySelector(".rolelbl").textContent === "ALLIED LEAD · Blue Fleet" && !!leadRow.querySelector('[data-orglead="0"]'));
      renderAllied([{ guildId: "90000000000000002", name: "Blue Fleet", accounts: 3 }]);
      renderAccts({ accounts: [{ discordId: "424260", discordName: "guest", callsign: "Guest", role: "member" }], access: {} });
      const toSel = $("acctList").querySelector("[data-toallied]");
      L("acct-to-allied-picker", !!toSel && [...toSel.options].some(o => o.value === "90000000000000002" && /Blue Fleet/.test(o.textContent)) && toSel.value === "");
      L("allied-org-row", /Blue Fleet/.test($("alliedList").textContent) && /3 ON THE ROLLS/.test($("alliedList").textContent) && !!$("alliedList").querySelector("[data-gremove]"));
      renderAccts({ accounts: [], access: { "COMMAND NET": "org:90000000000000002" } });
      const orgSel = $("netAccess").querySelector('.narow[data-net="COMMAND NET"] select');
      const orgOpt = orgSel && [...orgSel.options].find(o => o.value === "org:90000000000000002");
      L("acct-org-level", !!orgOpt && orgSel.value === "org:90000000000000002" && /BLUE FLEET ONLY/.test(orgOpt.textContent));
      renderAllied([]);
    }
    /* the allied view: only JOINT nets (and their nests) on the board, banner up */
    {
      const total = nets.length;
      /* a nest: naming the parent must show its children too (an org lead's new subnets) */
      const nest = nets.find(n => nets.some(k => k.parent === n.cfg.name));
      if (nest) {
        const cmdWas = cmdToken;
        applyAlliedMode({ role: "allied", org: "Blue Fleet", jointNets: [nest.cfg.name], orgLead: true });
        const shownNest = [...netlist.querySelectorAll(".net")].map(el => nets[+el.dataset.i].cfg.name);
        const kids = nets.filter(k => k.parent === nest.cfg.name).map(k => k.cfg.name);
        L("allied-view-descendants", shownNest.includes(nest.cfg.name) && kids.every(k => shownNest.includes(k)) && cmdToken === "org-lead" && /ORG LEAD/.test($("alliedBannerV").textContent));
        applyAlliedMode(null);
        L("allied-lead-token-cleared", cmdToken === "" ); cmdToken = cmdWas;
      } else L("allied-view-descendants", "skipped(no-nest)");
      const target = nets.find(n => n.parent) || nets[0];
      const changed = applyAlliedMode({ role: "allied", org: "Blue Fleet", jointNets: [target.cfg.name] });
      const shown = [...netlist.querySelectorAll(".net")].map(el => nets[+el.dataset.i].cfg.name);
      const expect = new Set([target.cfg.name]); let cur = target; while (cur && cur.parent) { expect.add(cur.parent); cur = nets.find(x => x.cfg.name === cur.parent); }
      const banner = $("alliedBanner").style.display === "" && /BLUE FLEET/.test($("alliedBannerV").textContent);
      applyAlliedMode(null);
      const restored = netlist.querySelectorAll(".net").length === total && $("alliedBanner").style.display === "none";
      L("allied-view-filter", changed && shown.length === expect.size && shown.every(nm => expect.has(nm)) && banner && restored);
      if (!(changed && shown.length === expect.size && shown.every(nm => expect.has(nm)) && banner && restored)) L("allied-view-filter-detail", JSON.stringify({ changed, shown, expect: [...expect], banner, restored, total }));
    }
    /* the streamer's source card */
    {
      camShowSource({ name: "Star Citizen", thumb: "" });
      const shown = !$("camSrc").hidden && /Star Citizen/.test($("camSrcName").textContent) && $("camSrcThumb").hidden;
      camHideSource();
      L("cam-src-indicator", shown && $("camSrc").hidden);
    }
    /* my own voice on another of my connections is dropped, not played */
    {
      const k = nets.findIndex(n => n.tuned && n.idx != null);
      if (k < 0) L("self-echo-dropped", "skipped(no-tuned)");
      else {
        const before = nets[k].speaking.size;
        onRx({ idx: nets[k].idx, session: 31337, name: callsign, opus: silentOpus() });
        await new Promise(r => setTimeout(r, 50));
        const mine = nets[k].speaking.size === before;
        onRx({ idx: nets[k].idx, session: 31338, name: "SOMEONE-ELSE", opus: silentOpus() });
        await new Promise(r => setTimeout(r, 50));
        const other = nets[k].speaking.has(31338);
        nets[k].speaking.delete(31338); nets[k].roster.delete(31338);
        L("self-echo-dropped", mine && other);
      }
    }
    /* the command rail replaced the bezel: it must never overflow sideways,
       and the docstrip must truncate rather than push the clock off-window */
    const railEl = document.getElementById("rail");
    L("rail-overflow-x", Math.max(0, railEl.scrollWidth - railEl.clientWidth));
    L("rail-nav-keys", document.querySelectorAll("#rail .pkey").length);
    document.body.style.width = "720px";
    const ds = document.getElementById("docstrip");
    L("docstrip-overflow-at-720", Math.max(0, ds.scrollWidth - ds.clientWidth));
    document.body.style.width = "";

    /* the channel plan's tag badges, and the truncate option they enable */
    L("tag-badges-rendered", document.querySelectorAll("#netlist .tagbadge").length >= 8);
    const taggedCard = netlist.querySelector(".net.hastag");
    const taggedNet = taggedCard && nets[+taggedCard.dataset.i];
    L("tag-display-name", taggedCard &&
      taggedCard.querySelector("b.nm").textContent === (taggedNet.cfg.display || taggedNet.cfg.name) &&
      taggedCard.querySelector(".nmwrap").title === taggedNet.cfg.name);
    if (taggedCard) {
      const nmOf = () => getComputedStyle(netlist.querySelector(".net.hastag b.nm")).display;
      $("snametrunc").click();
      L("trunc-hides-tagged-names", nameTrunc === true && nmOf() === "none" && store.get("nameTrunc") === true);
      L("trunc-spares-untagged", (function () {
        const plain = netlist.querySelector(".net:not(.hastag) b.nm");
        return !plain || getComputedStyle(plain).display !== "none";
      })());
      $("snametrunc").click();
      L("trunc-off-restores", nameTrunc === false && nmOf() !== "none");
    }

    /* helmet-cam gating: the injectable gate proves every role's verdict,
       and the rig itself (legacy mode, no account) stays ungated */
    L("cam-gate-legacy-open", camMayWatch() === true);
    L("cam-gate-member-blocked", camMayWatch(true, { account: { role: "member" } }) === false);
    L("cam-gate-element-allowed", camMayWatch(true, { account: { role: "element" } }) === true);
    L("cam-gate-command-allowed", camMayWatch(true, { account: { role: "command" } }) === true);
    L("cam-canon-wire-match", camCanon("TIBER DOC 1") === "TIBER-DOC-1" &&
      camCanon("tiber-doc-1") === "TIBER-DOC-1");
    /* scanline toggle: on by default, off kills the root attribute, back on */
    const scanAttr = () => document.documentElement.hasAttribute("data-camscan");
    L("camscan-default-on", scanAttr() === true);
    $("sscanfx").click();
    L("camscan-toggles-off", scanAttr() === false && store.get("camScanFx") === false);
    $("sscanfx").click();
    L("camscan-back-on", scanAttr() === true);

    /* soundboard: COMMAND-gated, and visible on a ship net */
    const shipIdx = nets.findIndex(n => n.cfg.ship);
    if (shipIdx >= 0) {
      selectedI = shipIdx;
      cmdToken = ""; renderSoundboard();
      L("sb-hidden-without-command", document.getElementById("sbPanel").style.display === "none");
      cmdToken = "autotest-token"; renderSoundboard();
      L("sb-shown-for-command", document.getElementById("sbPanel").style.display !== "none");
      L("sb-net-label", document.getElementById("sbNet").textContent || "(none)");
      const nonShip = nets.findIndex(n => !n.cfg.ship);
      selectedI = nonShip; renderSoundboard();
      L("sb-hidden-on-nonship", document.getElementById("sbPanel").style.display === "none");
      selectedI = shipIdx; cmdToken = ""; renderSoundboard();
    } else L("sb-skip", "no ship net");

    L("normfreq", ["250","290.5","118.25","290,500","junk",""]
        .map(v => v + "->" + (normFreq(v) || "-")).join(" "));

    const target = tunedIdx[0] != null ? tunedIdx[0] : 0;
    cmdToken = "autotest-token";        /* the soundboard block above cleared it; editing is COMMAND-gated */
    try { openNetDialog("edit", target);
          L("edit-dialog-open", document.getElementById("dlg").classList.contains("on"));
          L("edit-dialog-prefilled", document.getElementById("dlgName").value || "(empty)");

          /* actually submit — a dialog that opens but whose APPLY throws is
             exactly the bug this check exists to catch */
          const was = nets[target].cfg.name;
          document.getElementById("dlgName").value = was + " X";
          document.getElementById("dlgFreq").value = "291.7";
          document.getElementById("dlgOk").click();
          setTimeout(() => {
            L("apply-renamed", nets[target].cfg.name);
            L("apply-freq", nets[target].cfg.freq);
            L("apply-err", document.getElementById("dlgErr").textContent || "(none)");
            L("apply-dialog-closed", !document.getElementById("dlg").classList.contains("on"));
            /* put it back so the relay is left as we found it */
            ipcRenderer.invoke("net-rename", { net: nets[target].cfg.name, name: was })
              .then(r => { L("apply-restored", r.ok); nets[target].cfg.name = was;
                           cmdToken = null; console.log("[AUTOTEST] v09-checks-done"); });
          }, 2500);
        }
    catch (e) { L("edit-dialog-ERR", e.message); console.log("[AUTOTEST] v09-checks-done"); }
  }, 9000);
}

/* ══ drag to reorder ══
   Purely local: it changes the order this operator sees and nothing else. A net
   may be moved among its siblings, never in or out of a nest — src/net-tree.js
   enforces that and refuses the drop rather than silently re-parenting.
   The drag ARMS only from the ⠿ grip: cards ship draggable=false and a
   pointerdown on the grip flips the card on just long enough for the browser
   to start the drag. Anywhere else — the sliders above all — presses behave
   like ordinary controls again. (rowDragging itself is declared with the
   board state near the top of the file: renderNets writes it.) */
(function () {
  let dragName = null;
  const nameAt = (el) => {
    const card = el && el.closest ? el.closest(".net") : null;
    const i = card ? +card.dataset.i : -1;
    return nets[i] ? nets[i].cfg.name : null;
  };
  netlist.addEventListener("pointerdown", (e) => {
    const card = e.target.closest(".net");
    if (card && e.target.closest("[data-grip]")) card.draggable = true;
  });
  /* disarm on release wherever it lands — a drag that never started must not
     leave the card grabbable from anywhere */
  addEventListener("pointerup", () => {
    netlist.querySelectorAll('.net[draggable="true"]').forEach(c => { c.draggable = false; });
  });
  netlist.addEventListener("dragstart", (e) => {
    const card = e.target.closest(".net");
    if (!card || !card.draggable) { dragName = null; return; }   /* text drags etc. */
    dragName = nameAt(e.target);
    if (!dragName) return;
    rowDragging = true;
    try { e.dataTransfer.setData("text/plain", dragName); e.dataTransfer.effectAllowed = "move"; } catch (err) {}
    card.classList.add("dragging");
  });
  netlist.addEventListener("dragend", () => {
    dragName = null;
    rowDragging = false;
    netlist.querySelectorAll(".net").forEach(c => { c.classList.remove("dragging", "dropok", "dropno"); c.draggable = false; });
  });
  netlist.addEventListener("dragover", (e) => {
    const over = nameAt(e.target); if (!dragName || !over) return;
    const card = e.target.closest(".net");
    netlist.querySelectorAll(".net").forEach(c => c.classList.remove("dropok", "dropno"));
    if (canReorder(netShapes(), dragName, over)) {
      e.preventDefault();                       /* only a legal drop is allowed */
      try { e.dataTransfer.dropEffect = "move"; } catch (err) {}
      card.classList.add("dropok");
    } else if (over !== dragName) card.classList.add("dropno");
  });
  netlist.addEventListener("drop", (e) => {
    const over = nameAt(e.target); if (!dragName || !over) return;
    e.preventDefault();
    const sibs = reorder(netShapes(), netOrder, dragName, over);
    if (!sibs) {
      toast(nets.some(n => n.cfg.name === dragName && n.parent)
        ? "Nets stay in their nest — you can reorder within it, not out of it."
        : "That net can't go there.");
      return;
    }
    netOrder = mergeOrder(netOrder, sibs);
    store.set("netOrder", netOrder);
    dragName = null;
    renderNets();
  });
})();
