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
let themeMode = store.get("themeMode", "dark");
const THEME_DEFAULTS = { bg: "#0b0f13", panel: "#11161b", bez: "#1c2126", ink: "#e8edf1",
  muted: "#8b979f", line: "#242b32", accent: "#4fd4e8", grn: "#49d17c", amber: "#ffb648", red: "#ff5a5a" };
let customTheme = Object.assign({}, THEME_DEFAULTS, store.get("customTheme", {}));
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
let myCallsigns = store.get("callsigns", []);
let callsign = store.get("callsign", "");
let cmdToken = store.get("cmdToken", "");
/* Relay back-off. One tuned net is one connection, so a sign-in is several
   connections at once; murmur's per-IP rate guard answers a burst by dropping
   it, which surfaces as ECONNRESET. Backing off is the cure — hammering is what
   keeps it angry. */
let connectFails = 0, holdTimer = null;
function holdConnect(seconds) {
  const btn = $("connectBtn");
  clearInterval(holdTimer);
  let left = seconds;
  btn.disabled = true;
  const tick = () => {
    $("connErr").textContent = "The relay is rate-limiting connections from your network. " +
      "Retrying is what keeps it tripped — holding for " + left + "s.";
    if (left-- <= 0) {
      clearInterval(holdTimer);
      btn.disabled = false;
      btn.textContent = "CONNECT ▸";
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
   "--tx","--tx-tint","--ok","--ok-tint","--red","--red-tint","--grid","--lamp-off"]
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
    msg = { dark, bg: cssHex("--bez", t.bez), ink: cssHex("--ink", t.ink),
      palette: { panelRGB: hexRgb(t.panel).join(","), ink: t.ink, muted: t.muted, accent: t.grn, accentRGB: hexRgb(t.grn).join(",") } };
  } else {
    dark = themeMode === "dark";
    r.setAttribute("data-theme", dark ? "dark" : "light");
    /* take the bezel and text colours from the stylesheet that just applied, so
       the window controls always match the header they sit in */
    msg = { dark, bg: cssHex("--bez", dark ? "#1c2126" : "#c8cdd2"),
            ink: cssHex("--ink", dark ? "#e8edf1" : "#12242e"), palette: null };
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
function finishCapture(src, code, label, mods) {
  const bind = { src, code, label: bindLabel(mods, label), mods };
  if (capturing.kind === "net") { nets[capturing.i].bind = bind; savePrefs(); }
  else { masterBinds[capturing.which] = bind; store.set("masterBinds6", masterBinds); }
  capturing = null; renderNets(); renderMasterBinds();
}
function onKeyDown(src, code, label, mods) {
  if (capturing) { finishCapture(src, code, label, mods); return; }
  if (document.activeElement && /INPUT|TEXTAREA/.test(document.activeElement.tagName)) return;
  if (matchDown(masterBinds.cycUp, src, code, label, mods)) { cycleSel(-1); return; }
  if (matchDown(masterBinds.cycDn, src, code, label, mods)) { cycleSel(1); return; }
  if (matchDown(masterBinds.active, src, code, label, mods)) { pttAll(true); return; }
  nets.forEach((n, i) => { if (n.tuned && matchDown(n.bind, src, code, label, mods)) requestTX(i, "bind"); });
}
function onKeyUp(src, code, label) {
  if (matchUp(masterBinds.active, src, code, label)) pttAll(false);
  nets.forEach((n, i) => { if (matchUp(n.bind, src, code, label)) releaseTX(i, "bind"); });
}
ipcRenderer.on("gkey", (ev, k) => {
  gActive = true;
  const mod = normMod(k.label);
  if (mod) { k.down ? heldMods.add(mod) : heldMods.delete(mod); if (capturing) return; }
  if (k.down && !mod) onKeyDown("g", k.type + ":" + k.code, k.label, [...heldMods]);
  if (!k.down && !mod) onKeyUp("g", k.type + ":" + k.code, k.label);
});
window.addEventListener("keydown", (e) => {
  if (e.repeat) return;
  if (gActive) { if (e.key === "PageUp" || e.key === "PageDown" || (e.code === "Space" && !/INPUT|TEXTAREA/.test(document.activeElement.tagName))) e.preventDefault(); return; }
  const mods = MODS.filter(m => ({ ALT: e.altKey, CTRL: e.ctrlKey, SHIFT: e.shiftKey, META: e.metaKey })[m]);
  if (normMod(e.key)) return;
  if (capturing) e.preventDefault();
  onKeyDown("dom", e.code, e.code.replace(/^Key|^Digit/, ""), mods);
});
window.addEventListener("keyup", (e) => { if (!gActive) onKeyUp("dom", e.code, e.code.replace(/^Key|^Digit/, "")); });

/* ══ AUDIO ══ */
const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
const FRAME = 960;
let capNode = null, txSet = new Set(), txEndPending = new Set(), bcastIdx = new Set();
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
    const workletUrl = URL.createObjectURL(new Blob([workletCode], { type: "application/javascript" }));
    try { await ctx.audioWorklet.addModule(workletUrl); } finally { URL.revokeObjectURL(workletUrl); }
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
const FXP = {
  clean:    { hp: 250, lp: 3400, stages: 1, drive: 0,    comp: null, noise: 0,     tail: 0 },
  standard: { hp: 300, lp: 3000, stages: 2, drive: 0.35, comp: { th: -28, ratio: 8,  atk: 0.003, rel: 0.12 }, noise: 0.006, tail: 0.05 },
  heavy:    { hp: 400, lp: 2700, stages: 2, drive: 0.8,  comp: { th: -32, ratio: 12, atk: 0.002, rel: 0.10 }, noise: 0.015, tail: 0.09 }
};
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
  const p = FXP[fxPreset] || FXP.standard, nodes = [];
  let head = n.gainNode;
  for (let i = 0; i < p.stages; i++) { const hp = ctx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = p.hp; hp.Q.value = 0.7; head.connect(hp); nodes.push(hp); head = hp; }
  for (let i = 0; i < p.stages; i++) { const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = p.lp; lp.Q.value = 0.7; head.connect(lp); nodes.push(lp); head = lp; }
  if (p.drive > 0) { const ws = ctx.createWaveShaper(); ws.curve = shaperCurve(p.drive); ws.oversample = "2x"; head.connect(ws); nodes.push(ws); head = ws; }
  if (p.comp) { const cp = ctx.createDynamicsCompressor(); cp.threshold.value = p.comp.th; cp.ratio.value = p.comp.ratio; cp.attack.value = p.comp.atk; cp.release.value = p.comp.rel; cp.knee.value = 4; head.connect(cp); nodes.push(cp); head = cp; }
  head.connect(n.panNode); n.panNode.connect(ctx.destination);
  n.noiseGain = ctx.createGain(); n.noiseGain.gain.value = 0;
  if (p.noise > 0) { const src = ctx.createBufferSource(); src.buffer = getNoiseBuf(); src.loop = true; src.connect(n.noiseGain); n.noiseGain.connect(n.panNode); src.start(); n.noiseSrc = src; nodes.push(n.noiseGain); }
  n.fxNodes = nodes;
}
function squelchTail(n) {
  const p = FXP[fxPreset] || FXP.standard;
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
  d.cursor = Math.max(ctx.currentTime + 0.06, d.cursor);
  if (d.cursor > ctx.currentTime + 0.75) d.cursor = ctx.currentTime + 0.06;
  src.start(d.cursor); d.cursor += cnt / 48000;
}
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
    o.connect(g); g.connect(ctx.destination); o.start(t); o.stop(t + dur + 0.02);
  } catch (e) {}
}
const chirpDown = () => beep(1650, 1250, 0.07, 0.06);
const chirpUp = () => beep(1150, 1500, 0.05, 0.045);

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
  if (n.bcast) { bcastIdx.add(n.idx); await ipcRenderer.invoke("arm-broadcast", n.idx); } else bcastIdx.delete(n.idx);
  netDyn(i); sendOv(); renderTxTargets();
}
function finishTX(i) {
  const n = nets[i];
  if (!n || !n.tx) return;
  n.tx = false; txSet.delete(n.idx); txEndPending.add(n.idx);
  netDyn(i); sendOv(); renderTxTargets();
}
function releaseTX(i, reason) {
  const n = nets[i]; if (!n) return;
  txReasons(n).delete(reason);
  if (txReasons(n).size === 0) finishTX(i);
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
    chirpDown(); addLog("tx", txNames(t), "TX START — " + callsign);
    syncReasonTargets("ptt", true);
  } else if (!openMic) {
    chirpUp();
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
    chirpDown(); addLog("tx", txNames(t), "OPEN MIC ENGAGED — " + callsign);
    syncReasonTargets("open", true);
  } else {
    chirpUp(); syncReasonTargets("open", false);
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
  netlist.innerHTML = "";
  rebuildTree();
  tree.rows.forEach((row) => {
    const i = row.i, n = nets[i];
    const kids = row.kids.map(k => nets[k]);
    const par = kids.length > 0 || (n.cfg.subnets || []).length > 0;
    const anyKidTuned = kids.some(k => k.tuned);
    const d = document.createElement("div");
    d.style.setProperty("--lvl", row.depth);
    d.className = "net" + (row.depth ? " sub" : "") + (par ? " parent" : "") +
      (par && anyKidTuned ? " hasnest" : "") + (par && n.bcast ? " bcast" : "") +
      (i === selectedI ? " sel" : "") + (n.tuned ? "" : " untuned") +
      (n.tx ? " tx-live" : (n.speaking.size ? " rx-live" : ""));
    d.dataset.i = i;
    d.draggable = true;                    /* client-side ordering — see dragging below */
    const ship = isShip(n);
    if (ship) d.classList.add("shipgroup");
    /* Name first. The callsign of the net is what an operator scans for mid-op;
       the frequency is reference detail, so it drops to a small line underneath
       instead of leading the row. */
    let h = '<div class="nt" data-sel>' +
      (par ? '<button class="chev" data-chev title="collapse / expand nest">' + (collapsed[n.cfg.name] ? "▸" : "▾") + '</button>' : "") +
      '<span class="grip" data-grip title="Drag to reorder">⠿</span>' +
      '<span class="nmwrap" title="' + escAttr(n.cfg.name) + '"><b class="nm">' + esc(n.cfg.name) +
      (n.cfg.enc ? ' <span class="enc">⚿</span>' : "") + '</b>' +
      '<span class="fq num">' + esc(n.cfg.freq) + '</span></span>' +
      (ship ? '<span class="shipbadge">SHIP</span>' : "") +
      (par ? '<span class="nestcount">' + kids.filter(k => k.tuned).length + "/" + kids.length + (ship ? " NETS" : " NEST") + '</span>' : "") +
      '<span class="cnt num" data-cnt>' + (n.tuned ? n.roster.size : "·") + '</span></div>';

    if (ship) {
      /* A ship is a GROUP, not a channel you sit in. Two controls, and neither
         needs its subnets tuned: LSN ALL hears the whole ship, the 1MC reaches
         the whole ship (the general announcing circuit — voice and clips). */
      h += '<div class="nrow">' +
        '<button class="ann wide' + (n.lsnAll ? " lit-g" : "") + '" data-lsnall' +
          ' title="Hear every net aboard this ship — no need to tune them">LSN ALL</button>' +
        '<button class="ann wide' + (n.txAll ? " lit-a" : "") + '" data-txall' +
          ' title="1MC — transmit to every net aboard this ship, no need to tune them">1MC</button>' +
        '<button class="keyb mono" data-key title="Talk key for the 1MC">' + esc(n.bind ? n.bind.label : "KEY") + '</button>' +
        (n.tuned ? '<button class="x" data-x title="Leave the ship group">✕</button>' : "") +
        '</div>';
      if (n.tuned) h += '<div class="srow"><label>VOL</label><input type="range" min="0" max="100" value="' + n.vol + '" data-vol>' +
        '<label>L\u00b7R</label><input type="range" class="pan" min="-100" max="100" value="' + n.pan + '" data-pan></div>';
    } else if (n.tuned) {
      h += '<div class="nrow">' +
        '<button class="ann' + (n.mon ? " lit-g" : "") + '" data-mon>LSN</button>' +
        '<button class="ann' + (n.txOn ? " lit-a" : "") + '" data-txon>TX</button>' +
        '<button class="keyb mono" data-key title="Per-net talk key — click, press a key or combo">' + esc(n.bind ? n.bind.label : "KEY") + '</button>' +
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
    ? "No talk key set — you cannot transmit until you choose one."
    : "Transmits on every net with TX armed";
  $("ptt").classList.toggle("needsbind", unbound);
  $("bindActive").textContent = masterBinds.active ? masterBinds.active.label : "set key";
  $("bindCycUp").textContent = masterBinds.cycUp ? masterBinds.cycUp.label : "set key";
  $("bindCycDn").textContent = masterBinds.cycDn ? masterBinds.cycDn.label : "set key";
  $("pttKeyLbl").textContent = (masterBinds.active ? masterBinds.active.label : "—").toUpperCase();
}
/* transmission log */
const logFeed = $("logFeed");
let logN = 0;
function addLog(kind, netName, msg) {
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
  ipcRenderer.send("ov-state", nets.filter(n => n.tuned).map(n => {
    const now = Date.now();
    let who = null;
    for (const [sess, until] of n.speaking) if (until > now) { who = n.roster.get(sess) || "?"; break; }
    return { name: n.cfg.name, freq: n.cfg.freq, who, tx: n.tx, active: nets[selectedI] === n, mon: n.mon, me: callsign };
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
    capturing = { kind: "net", i };
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
    if (!made.ok) { if (!silent) toast(/PermissionDenied/.test(made.error) ? "The relay refused: your command token doesn't grant net creation." : "Create failed: " + made.error); return false; }
    if (made.name && made.name !== n.cfg.name) {
      renameLocal(n.cfg.name, made.name); n.cfg.name = made.name; cfg.name = made.name; cfg.channel = made.name;
    }
    addLog("sys", n.cfg.name, "net created on relay by " + callsign);
    r = await ipcRenderer.invoke("tune", cfg);
  }
  if (!r.ok) {
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
  n.tuned = true; n.idx = r.idx;
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
    : '<span class="hint">no clips in the library — add them under SYS ▸ 1MC SOUND LIBRARY</span>';
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
  const norm = peak > 0.0001 ? Math.min(4, CLIP_TARGET / peak) : 1;

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

  /* local monitor so the sender hears what went out, at the same relative level */
  const src = ctx.createBufferSource(); src.buffer = audio;
  const g = ctx.createGain(); g.gain.value = 0.5 * norm;
  src.connect(g); g.connect(ctx.destination); src.start();

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
ipcRenderer.on("rx", (ev, r) => {
  const conn = nets.findIndex(x => x.idx === r.idx); if (conn < 0) return;
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
});
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
  if (host !== pkg.server.host) store.set("hostOverride", host);
  renderCsList();
  $("connErr").textContent = ""; btn.textContent = "CONNECTING…";
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
       operator hammer it. Each failure waits a little longer than the last. */
    if (/ECONNRESET|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|reset by peer/i.test(raw)) {
      connectFails++;
      holdConnect(Math.min(45, 8 * connectFails));
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
  if (acct && cs !== acct.account.callsign) ipcRenderer.invoke("acct", { method: "POST", path: "/api/callsign", body: { callsign: cs } });
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
  renderNets(); chirpDown(); pollOps();
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
  $("csIn").value = r.account.callsign || callsign || "";
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
  clearTxState(); ipcRenderer.send("disconnect"); connected = false;
  if (discordMode) {
    acct = null; cmdToken = ""; refreshSounds();
    $("discordBtn").disabled = false; $("discordBtn").textContent = "SIGN IN WITH DISCORD ▸";
    $("pendingBox").style.display = "none"; $("bootstrapRow").style.display = "none";
    $("csRow2").style.display = "none"; $("connectBtn").style.display = "none";
    $("bootstrapIn").value = "";
  }
  buildNets(); renderNets(); showPage("pgComms");
  $("connectOv").classList.remove("hidden");
  $("relayLbl").className = "v dim"; $("relayLbl").textContent = "OFFLINE";
  $("opchip").style.display = "none";
});

/* ══ ATC + operators count ══ */
async function refreshAtc() {
  const view = await ipcRenderer.invoke("atc-view");
  const boxes = view.filter(c => c.id !== 0);
  const names = new Set(); view.forEach(c => c.users.forEach(u => names.add(u)));
  $("atcCount").textContent = names.size;
  $("atcGrid").innerHTML = boxes.map(c =>
    '<div class="atcbox"><h4>' + esc(c.name) + '<span class="c">' + c.users.length + '</span></h4>' +
    '<div class="who">' + (c.users.length ? c.users.map(u => "<i>" + esc(u) + "</i>").join("") : '<span class="empty">empty</span>') + '</div>' +
    '<button class="tunelink" data-name="' + escAttr(c.name) + '">TUNE ME HERE ▸</button></div>'
  ).join("");
}
$("atcGrid").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-name]"); if (!b) return;
  const nm = b.dataset.name;
  let i = nets.findIndex(n => n.cfg.name === nm);
  if (i < 0) {
    nets.push({ cfg: { name: nm, freq: "———.———", enc: false }, depth: 0, parent: null, tuned: false, idx: null, mon: true, txOn: false, vol: 75, pan: 0, bind: null, roster: new Map(), speaking: new Map(), chat: [], tx: false });
    i = nets.length - 1;
  }
  showPage("pgComms");
  await tuneNet(i);
  selectedI = i; renderNets();
});
function showPage(id) {
  if (id === "pgAtc" && !connected) { toast("Connect first."); return; }
  const leavingSys = document.getElementById("settings").classList.contains("on") && id !== "settings";
  if (leavingSys && !discordMode) { cmdToken = $("tokenIn").value.trim(); store.set("cmdToken", cmdToken); renderTxTargets(); refreshSounds(); }
  document.querySelectorAll(".page").forEach(p => p.classList.toggle("on", p.id === id));
  document.querySelectorAll(".pkey").forEach(k => k.classList.toggle("on", k.dataset.page === id));
  if (id === "pgAtc") refreshAtc();
  if (id === "pgAcct") refreshAccts();
  if (id === "pgChat") { renderChatTabs(); renderChat(); }
  if (id === "settings" && !discordMode) $("tokenIn").value = cmdToken;
  /* opening SYS re-pulls the fleet library, so clips another COMMAND account
     just added appear without a re-sign-in */
  if (id === "settings") refreshSounds();
}
document.querySelectorAll(".pkey").forEach(k => k.addEventListener("click", () => showPage(k.dataset.page)));
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
    const names = new Set(); view.forEach(c => c.users.forEach(u => names.add(u)));
    $("opsCount").textContent = names.size;
    if (discordMode) {
      const current = await ipcRenderer.invoke("acct", { method: "GET", path: "/api/me" });
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
$("sthemesel").addEventListener("change", function () { themeMode = this.value; applyTheme(); });
Object.keys(THEME_DEFAULTS).forEach(k => {
  const el = $("c_" + k); if (!el) return;
  el.addEventListener("input", function () { customTheme[k] = this.value; themeMode = "custom"; applyTheme(); });
});
$("themeReset").addEventListener("click", () => { customTheme = Object.assign({}, THEME_DEFAULTS); applyTheme(); toast("Palette reset to night defaults."); });
$("closeSet").addEventListener("click", () => showPage("pgComms"));
$("sfx").addEventListener("click", function () { fx = !fx; this.classList.toggle("on", fx); store.set("fx", fx); if (fx) chirpDown(); });
$("fxsel").addEventListener("change", function () {
  fxPreset = this.value; store.set("fxPreset", fxPreset);
  nets.forEach(n => { if (n.tuned) wireChain(n); });
  const t = nets.find(n => n.tuned); if (t) squelchTail(t); else chirpDown();
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
setInterval(() => { $("clock").textContent = utc(); }, 1000);

/* init */
try {
  const _v = "v" + bridge.version;
  $("verlbl").textContent = "FLEETCOMM " + _v + ' — native unit: in-game PTT + overlay · developed by Rook "Doc" Sabbah, UEE 22nd Expeditionary Fleet';
  $("verlbl2").textContent = _v;
} catch (e) {}
$("sfx").classList.toggle("on", fx);
$("sautoupd").classList.toggle("on", autoUpdate);
$("fxsel").value = fxPreset;
applyFont(); applyScale(); applyTheme(); refreshAcctEp(); listAudioDevices(); renderGate(); renderCsList(); renderMasterBinds(); renderMic(); renderNets(); refreshSounds();
$("startupFail").style.display = "none";
$("signDiscord").style.display = discordMode ? "block" : "none";
$("signLegacy").style.display = discordMode ? "none" : "block";
$("legacyCommandAuth").style.display = discordMode ? "none" : "block";
if (discordMode) $("signFoot").textContent = "Access is gated: Discord confirms who you are, COMMAND decides who gets in, and the relay itself refuses anyone unapproved.";
addLog("sys", "", "FleetComm console initialized — awaiting sign-in");

/* ══ ACCOUNTS page (command) ══ */
async function refreshAccts() {
  const [ra, rn] = await Promise.all([
    ipcRenderer.invoke("acct", { method: "GET", path: "/api/accounts" }),
    ipcRenderer.invoke("acct", { method: "GET", path: "/api/nets/access" })
  ]);
  if (!ra.ok) { $("acctList").innerHTML = '<span class="hint">' + esc(ra.error || "unavailable") + "</span>"; return; }
  const pend = ra.accounts.filter(x => x.role === "pending").length;
  $("acctPending").textContent = pend ? pend + " AWAITING APPROVAL" : "";
  const order = { pending: 0, command: 1, member: 2, revoked: 3 };
  $("acctList").innerHTML = ra.accounts.sort((x, y) => (order[x.role] - order[y.role]) || x.discordName.localeCompare(y.discordName)).map(x => {
    const btns =
      (x.role === "pending" ? '<button class="ann lit-g" data-role="member">APPROVE</button>' : "") +
      (x.role === "member" ? '<button class="ann lit-c" data-role="command">PROMOTE</button>' : "") +
      (x.role === "command" ? '<button class="ann" data-role="member">DEMOTE</button>' : "") +
      (x.role !== "revoked" ? '<button class="ann" style="border-color:var(--red);color:var(--red)" data-role="revoked">REVOKE</button>'
                            : '<button class="ann lit-g" data-role="member">REINSTATE</button>');
    return '<div class="acctrow" data-id="' + escAttr(x.discordId) + '"><div class="nm"><b>' + esc(x.callsign || "(no callsign yet)") + '</b>' +
      '<span>discord: ' + esc(x.discordName) + " · " + (x.lastSeen ? "seen " + new Date(x.lastSeen).toLocaleString() : "never seen") + "</span></div>" +
      '<span class="ann rolelbl ' + (x.role === "command" ? "lit-a" : x.role === "member" ? "lit-g" : "") + '">' + x.role.toUpperCase() + "</span>" + btns + "</div>";
  }).join("");
  const levels = ["open", "member", "command"];
  const rows = [];
  nets.forEach(n => rows.push({ name: n.cfg.name, freq: n.cfg.freq }));
  $("netAccess").innerHTML = rows.map(r =>
    '<div class="narow" data-net="' + escAttr(r.name) + '"><b>' + esc(r.name) + '</b><span class="fq2 num">' + esc(r.freq) + "</span>" +
    '<select class="orgsel" data-lvl>' + levels.map(l =>
      '<option value="' + l + '"' + (((rn.ok && rn.access[r.name]) || "open") === l ? " selected" : "") + ">" +
      (l === "open" ? "OPEN — anyone approved" : l === "member" ? "MEMBERS+" : "COMMAND ONLY") + "</option>").join("") + "</select></div>"
  ).join("");
}
$("acctList").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-role]"); if (!b) return;
  const id = b.closest(".acctrow").dataset.id;
  const r = await ipcRenderer.invoke("acct", { method: "POST", path: "/api/accounts/" + id + "/role", body: { role: b.dataset.role } });
  if (!r.ok) toast(r.error); else { toast("Role updated."); refreshAccts(); }
});
$("netAccess").addEventListener("change", async (e) => {
  const s2 = e.target.closest("[data-lvl]"); if (!s2) return;
  const net = s2.closest(".narow").dataset.net;
  const r = await ipcRenderer.invoke("acct", { method: "POST", path: "/api/nets/access", body: { net, level: s2.value } });
  toast(r.ok ? net + " → " + s2.value.toUpperCase() + " (relay-enforced)" : "Failed: " + r.error);
});

/* headless CI hook */
if (bridge.autotestHost) {
  setTimeout(() => {
    store.set("hostOverride", bridge.autotestHost);
    $("hostrow").style.display = "flex";
    $("hostIn").value = bridge.autotestHost;
    $("csIn").value = "AUTOTEST-RIG";
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
      if (tuned.length) { $("chatIn").disabled = false; $("chatIn").value = "autotest checking in"; sendChat(); }
      const view = await ipcRenderer.invoke("atc-view");
      console.log("[AUTOTEST] atc-channels=" + view.length + " chatlen=" + (sel() ? sel().chat.length : 0));
      ipcRenderer.send("ov-toggle");
      $("fxsel").value = "heavy"; $("fxsel").dispatchEvent(new Event("change"));
      setTimeout(() => console.log("[AUTOTEST] fx=" + fxPreset + " chains=" + nets.filter(n => n.tuned).every(n => n.fxNodes && n.fxNodes.length > 0)), 1200);
    }, 6000);
  }, 800);
  ipcRenderer.on("ov-shown", (ev, shown) => console.log("[AUTOTEST] overlay=" + shown));

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
      L("font-loaded", document.fonts.check('16px "Atkinson Hyperlegible"'));
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
    L("overlay-edit-disabled-until-shown", document.getElementById("ovEditBtn").disabled);
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
      const n = nets.find(x => !x.tuned) || nets[0];
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
      L("rows-draggable", !!(card && card.draggable));
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
    L("sys-key-cog", (document.getElementById("sysKey").textContent || "").indexOf("\u2699") >= 0);
    L("device-pickers", !!document.getElementById("micSel") && !!document.getElementById("outSel"));

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
      $("chatIn2").disabled = false; $("chatIn2").value = "board chat check"; sendChatFrom($("chatIn2"));
      L("comms-chat-mirrors", $("chatFeed2").textContent.indexOf("board chat check") >= 0 &&
        $("chatFeed").textContent.indexOf("board chat check") >= 0);
    } else L("comms-chat-mirrors", "skip — no tuned net");
    const sbCmdWas = cmdToken;
    cmdToken = "autotest-token"; renderSoundLib();
    L("sndlib-shown-for-command", $("sndLib").style.display !== "none");
    cmdToken = ""; renderSoundLib();
    L("sndlib-hidden-without-command", $("sndLib").style.display === "none");
    cmdToken = sbCmdWas; renderSoundLib();
    L("bezel-wraps", getComputedStyle(document.getElementById("bezel")).flexWrap);
    /* narrow the window and confirm nothing overflows the bezel horizontally */
    document.body.style.width = "720px";
    const bz = document.getElementById("bezel");
    L("bezel-overflow-at-720", Math.max(0, bz.scrollWidth - bz.clientWidth));
    document.body.style.width = "";

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
   enforces that and refuses the drop rather than silently re-parenting. */
(function () {
  let dragName = null;
  const nameAt = (el) => {
    const card = el && el.closest ? el.closest(".net") : null;
    const i = card ? +card.dataset.i : -1;
    return nets[i] ? nets[i].cfg.name : null;
  };
  netlist.addEventListener("dragstart", (e) => {
    dragName = nameAt(e.target);
    if (!dragName) return;
    try { e.dataTransfer.setData("text/plain", dragName); e.dataTransfer.effectAllowed = "move"; } catch (err) {}
    const card = e.target.closest(".net"); if (card) card.classList.add("dragging");
  });
  netlist.addEventListener("dragend", () => {
    dragName = null;
    netlist.querySelectorAll(".net").forEach(c => c.classList.remove("dragging", "dropok", "dropno"));
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
