"use strict";
/* FleetComm v0.5 renderer — command console. */
const { ipcRenderer } = require("electron");
const OpusScript = require("opusscript");
const pkg = require("../config/22nd-package.json");

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
let myCallsigns = store.get("callsigns", []);
let callsign = store.get("callsign", "");
let cmdToken = store.get("cmdToken", "");
let netPrefs = store.get("netPrefs", {}); // freq -> {txOn, vol, pan, mon, bind, bcast}
let collapsed = store.get("collapsed", {}); // parent net name -> true
let masterBinds = store.get("masterBinds5", {
  active: { src: "label", label: "Space" },
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
    nets.push({
      cfg, depth, parent, tuned: false, idx: null,
      mon: p.mon !== undefined ? p.mon : true,
      txOn: p.txOn || false, vol: p.vol !== undefined ? p.vol : 75, pan: p.pan || 0,
      bind: p.bind || null, bcast: p.bcast || false,
      roster: new Map(), speaking: new Map(), chat: [], tx: false
    });
  };
  for (const n of pkg.nets) { add(n, 0, null); for (const s of n.subnets || []) add(s, 1, n.name); }
}
buildNets();
function savePrefs() {
  nets.forEach(n => { netPrefs[n.cfg.freq] = { txOn: n.txOn, vol: n.vol, pan: n.pan, mon: n.mon, bind: n.bind, bcast: n.bcast }; });
  store.set("netPrefs", netPrefs);
  store.set("collapsed", collapsed);
}
const sel = () => nets[selectedI];
const kidsOf = (name) => nets.filter(x => x.parent === name);
const isParent = (n) => n.depth === 0 && (kidsOf(n.cfg.name).length > 0 || (n.cfg.subnets || []).length > 0);
const isShip = (n) => !!n.cfg.ship;

/* ══ color helpers + theme engine ══ */
function hexRgb(h) { h = h.replace("#", ""); return [parseInt(h.slice(0,2),16), parseInt(h.slice(2,4),16), parseInt(h.slice(4,6),16)]; }
function mixHex(h1, h2, t) { const a = hexRgb(h1), b = hexRgb(h2); return "rgb(" + a.map((v,i) => Math.round(v + (b[i]-v)*t)).join(",") + ")"; }
function rgbaHex(h, al) { return "rgba(" + hexRgb(h).join(",") + "," + al + ")"; }
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
    msg = { dark, bg: t.bez, ink: t.ink,
      palette: { panelRGB: hexRgb(t.panel).join(","), ink: t.ink, muted: t.muted, accent: t.grn, accentRGB: hexRgb(t.grn).join(",") } };
  } else {
    dark = themeMode === "dark";
    r.setAttribute("data-theme", dark ? "dark" : "light");
    msg = { dark, bg: dark ? "#0c1b23" : "#e9eff4", ink: dark ? "#d9edf4" : "#12242e", palette: null };
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
  else { masterBinds[capturing.which] = bind; store.set("masterBinds5", masterBinds); }
  capturing = null; renderNets(); renderMasterBinds();
}
function onKeyDown(src, code, label, mods) {
  if (capturing) { finishCapture(src, code, label, mods); return; }
  if (document.activeElement && /INPUT|TEXTAREA/.test(document.activeElement.tagName)) return;
  if (matchDown(masterBinds.cycUp, src, code, label, mods)) { cycleSel(-1); return; }
  if (matchDown(masterBinds.cycDn, src, code, label, mods)) { cycleSel(1); return; }
  if (matchDown(masterBinds.active, src, code, label, mods)) { pttAll(true); return; }
  nets.forEach((n, i) => { if (n.tuned && matchDown(n.bind, src, code, label, mods)) startTX(i); });
}
function onKeyUp(src, code, label) {
  if (matchUp(masterBinds.active, src, code, label)) pttAll(false);
  nets.forEach((n, i) => { if (n.tx && matchUp(n.bind, src, code, label) && !n._latched) endTX(i); });
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
async function ensureMic() {
  if (capNode) return true;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
    const src = ctx.createMediaStreamSource(stream);
    const workletCode = `class Cap extends AudioWorkletProcessor{
      constructor(){super();this.buf=new Float32Array(${FRAME});this.n=0;}
      process(inputs){const ch=inputs[0][0];if(!ch)return true;let i=0;
        while(i<ch.length){const t=Math.min(${FRAME}-this.n,ch.length-i);
          this.buf.set(ch.subarray(i,i+t),this.n);this.n+=t;i+=t;
          if(this.n===${FRAME}){this.port.postMessage(this.buf.slice(0));this.n=0;}}
        return true;}}
      registerProcessor("cap",Cap);`;
    await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([workletCode], { type: "application/javascript" })));
    capNode = new AudioWorkletNode(ctx, "cap");
    src.connect(capNode);
    capNode.port.onmessage = (ev) => {
      if (txSet.size === 0 && txEndPending.size === 0) return;
      const f32 = ev.data, i16 = Buffer.alloc(FRAME * 2);
      for (let i = 0; i < FRAME; i++) { const s = Math.max(-1, Math.min(1, f32[i])); i16.writeInt16LE((s * 32767) | 0, i * 2); }
      let opus; try { opus = Buffer.from(encoder.encode(i16, FRAME)); } catch (e) { return; }
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
  if (!d) { d = { dec: new OpusScript(48000, 1), cursor: 0 }; decoders.set(key, d); }
  let pcm; try { pcm = d.dec.decode(Buffer.from(opusBuf)); } catch (e) { return; }
  const cnt = pcm.length / 2, ab = ctx.createBuffer(1, cnt, 48000), chd = ab.getChannelData(0);
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  for (let i = 0; i < cnt; i++) chd[i] = view.getInt16(i * 2, true) / 32768;
  const src = ctx.createBufferSource(); src.buffer = ab; src.connect(n.gainNode);
  d.cursor = Math.max(ctx.currentTime + 0.06, d.cursor);
  src.start(d.cursor); d.cursor += cnt / 48000;
}
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
async function startTX(i, latched) {
  const n = nets[i];
  if (!n || !n.tuned || n.tx || !connected) return;
  if (!(await ensureMic())) return;
  n.tx = true; n._latched = !!latched; txSet.add(n.idx);
  if (n.bcast) { bcastIdx.add(n.idx); await ipcRenderer.invoke("arm-broadcast", n.idx); } else bcastIdx.delete(n.idx);
  netDyn(i); sendOv(); renderTxTargets();
}
function endTX(i) {
  const n = nets[i];
  if (!n || !n.tx) return;
  n.tx = false; n._latched = false; txSet.delete(n.idx); txEndPending.add(n.idx);
  netDyn(i); sendOv(); renderTxTargets();
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
    for (const i of t) await startTX(i);
  } else if (!openMic) {
    chirpUp();
    nets.forEach((n, i) => { if (n.tx && !n._latched) endTX(i); });
    addLog("tx", "", "TX END");
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
    for (const i of t) await startTX(i, true);
  } else {
    chirpUp(); nets.forEach((n, i) => { if (n.tx) endTX(i); });
    addLog("tx", "", "OPEN MIC ENDED");
  }
}
function setOverride(on) {
  if (!cmdToken) { toast("COMMAND OVERRIDE requires a command token (⚙ Settings)."); return; }
  override = on;
  $("overrideBtn").classList.toggle("latched", on);
  $("overrideBtn").textContent = on ? "OVERRIDE ENGAGED — click to end" : "CMD OVERRIDE — all tuned";
  addLog("sys", "", on ? "COMMAND OVERRIDE ENGAGED — PTT now keys every tuned net" : "Command override disengaged");
  if (!on && (openMic || pttHeld)) { nets.forEach((n, i) => { if (n.tx && !n.txOn) endTX(i); }); }
  renderTxTargets();
}

/* ══ RENDER ══ */
const netlist = $("netlist");
function renderNets() {
  netlist.innerHTML = "";
  nets.forEach((n, i) => {
    if (n.depth && collapsed[n.parent]) return; /* hidden by collapsed parent */
    const par = isParent(n), kids = par ? kidsOf(n.cfg.name) : [];
    const anyKidTuned = kids.some(k => k.tuned);
    const d = document.createElement("div");
    d.className = "net" + (n.depth ? " sub" : "") + (par ? " parent" : "") +
      (par && anyKidTuned ? " hasnest" : "") + (par && n.bcast ? " bcast" : "") +
      (i === selectedI ? " sel" : "") + (n.tuned ? "" : " untuned") +
      (n.tx ? " tx-live" : (n.speaking.size ? " rx-live" : ""));
    d.dataset.i = i;
    let h = '<div class="nt" data-sel>' +
      (par ? '<button class="chev" data-chev title="collapse / expand nest">' + (collapsed[n.cfg.name] ? "▸" : "▾") + '</button>' : "") +
      '<span class="fq num">' + n.cfg.freq + '</span><b>' + n.cfg.name +
      (n.cfg.enc ? ' <span class="enc">⚿</span>' : "") + '</b>' +
      (isShip(n) ? '<span class="shipbadge">SHIP</span>' : "") +
      (par ? '<span class="nestcount">' + kids.filter(k => k.tuned).length + "/" + kids.length + " NEST</span>" : "") +
      '<span class="cnt num" data-cnt>' + (n.tuned ? n.roster.size : "·") + '</span></div>';
    if (n.tuned) {
      h += '<div class="nrow">' +
        '<button class="ann' + (n.mon ? " lit-g" : "") + '" data-mon>LSN</button>' +
        '<button class="ann' + (n.txOn ? " lit-a" : "") + '" data-txon>TX</button>' +
        (par ? '<button class="ann' + (n.bcast ? " lit-a" : "") + '" data-bcast title="Transmit to this net AND every subnet under it">NEST</button>' : "") +
        '<button class="keyb mono" data-key title="Per-net talk key — click, press a key or combo">' + (n.bind ? n.bind.label : "KEY") + '</button>' +
        '<button class="x" data-x title="Detune">✕</button></div>' +
        '<div class="srow"><label>VOL</label><input type="range" min="0" max="100" value="' + n.vol + '" data-vol>' +
        '<label style="width:20px">L·R</label><input type="range" class="pan" min="-100" max="100" value="' + n.pan + '" data-pan></div>';
    } else {
      h += '<button class="tunebtn" data-tune>TUNE ▸</button>';
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
  renderRoster(); renderChat(); renderSoundboard();
  const can = n && n.tuned && n.mon;
  $("chatIn").disabled = !can;
  $("chatIn").placeholder = can ? "message " + n.cfg.name + "…" : (n && n.tuned ? "enable LISTEN on this net to chat" : "tune this net to chat");
}
function renderRoster() {
  const n = sel(), box = $("rosterChips");
  if (!n || !n.tuned) { box.innerHTML = '<span class="hint">' + (n ? "net not tuned — TUNE it to see who's aboard" : "") + '</span>'; $("rosterCount").textContent = ""; return; }
  const now = Date.now(); let h = "";
  const meSpeaking = n.tx;
  h += '<div class="rchip me' + (meSpeaking ? " speaking" : "") + '"><b>' + callsign + '</b><span>YOU' + (meSpeaking ? " · TX" : "") + '</span></div>';
  for (const [sess, name] of n.roster) {
    if (name === callsign) continue;
    const sp = (n.speaking.get(sess) || 0) > now;
    h += '<div class="rchip' + (sp ? " speaking" : "") + '"><b>' + name + '</b><span>' + (sp ? "SPEAKING" : "ON NET") + '</span></div>';
  }
  box.innerHTML = h;
  $("rosterCount").textContent = n.roster.size + " KNOWN";
}
function renderChat() {
  const n = sel(), feed = $("chatFeed");
  feed.innerHTML = !n ? "" : n.chat.map(m =>
    '<div class="cm' + (m.mine ? " mine" : "") + '"><span class="t">' + m.t + '</span><b>' + m.from + '</b>' + esc(m.msg) + '</div>'
  ).join("");
  feed.scrollTop = feed.scrollHeight;
}
function esc(s) { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }
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
    if (!x.txOn && x.tx && !override) endTX(j);
  });
  if (keyed && !override && !n.tx) startTX(i, openMic);
  savePrefs();
  renderTxTargets();
}
function cycleSel(dir) {
  const tuned = nets.map((n, i) => i).filter(i => nets[i].tuned);
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
  if (e.target.closest("[data-bcast]")) {
    n.bcast = !n.bcast;
    if (n.bcast && n.tuned) ipcRenderer.invoke("arm-broadcast", n.idx).then(ok => {
      if (!ok) { n.bcast = false; toast("Couldn't arm nest broadcast."); renderNets(); }
      else addLog("sys", n.cfg.name, "NEST BROADCAST armed — TX reaches all subnets");
    });
    savePrefs(); renderNets(); return;
  }
  if (e.target.closest("[data-sel]")) {
    selectedI = i;
    if (n.tuned) armTxExclusive(i);
    renderNets(); return;
  }
  if (e.target.closest("[data-tune]")) { await tuneNet(i); return; }
  if (e.target.closest("[data-mon]")) { n.mon = !n.mon; ipcRenderer.send("net-mute", { idx: n.idx, muted: !n.mon }); savePrefs(); renderNets(); return; }
  if (e.target.closest("[data-txon]")) { n.txOn = !n.txOn; savePrefs(); renderNets(); return; }
  if (e.target.closest("[data-x]")) {
    ipcRenderer.send("detune", n.idx);
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
    const made = await ipcRenderer.invoke("create-net", { name: n.cfg.name, rootChannel: parent });
    if (!made.ok) { if (!silent) toast(/PermissionDenied/.test(made.error) ? "The relay refused: your command token doesn't grant net creation." : "Create failed: " + made.error); return false; }
    addLog("sys", n.cfg.name, "net created on relay by " + callsign);
    r = await ipcRenderer.invoke("tune", cfg);
  }
  if (!r.ok) { if (!silent) toast("Tune failed: " + r.error); return false; }
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
  const opts = ['<option value="">— top level —</option>'].concat(
    nets.filter(n => n.depth === 0 && (mode !== "edit" || n !== nets[i]))
        .map(n => '<option value="' + esc(n.cfg.name) + '">under ' + esc(n.cfg.name) + "</option>"));
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
      if (r.ok) { addLog("sys", n.cfg.name, "renamed to " + newName + " by " + callsign);
                  renameLocal(n.cfg.name, newName); n.cfg.name = newName; }
    }
    if (r.ok && (newParent || "") !== (n.parent || "")) {
      r = await ipcRenderer.invoke("net-move", { net: n.cfg.name, parent: newParent });
      if (r.ok) { n.parent = newParent || null; n.depth = newParent ? 1 : 0;
                  addLog("sys", n.cfg.name, newParent ? "nested under " + newParent : "moved to top level"); }
    }
    n.cfg.freq = newFreq; n.cfg.ship = $("dlgShip").checked;
    this.disabled = false; this.textContent = "CREATE ▸";
    if (!r.ok) { $("dlgErr").textContent = r.error || "The relay refused that change."; return; }
    savePrefs(); $("dlg").classList.remove("on"); renderNets(); renderSoundboard();
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
  const p = parent ? nets.find(n => n.cfg.name === parent && n.depth === 0) : null;
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
async function refreshSounds() {
  sbSounds = await ipcRenderer.invoke("sounds-list");
  renderSoundboard();
}
function renderSoundboard() {
  const n = sel();
  const show = n && isShip(n) && n.tuned;
  $("sbPanel").style.display = show ? "block" : "none";
  if (!show) return;
  $("sbNet").textContent = n.cfg.name + (n.bcast ? " (NEST)" : "");
  $("sbList").innerHTML = sbSounds.length
    ? sbSounds.map(s => '<button class="sbBtn' + (sbPlaying === s.name ? " playing" : "") + '" data-snd="' + esc(s.name) + '">' +
        esc(s.name.replace(/\.[^.]+$/, "")) + '<span class="del" data-del="' + esc(s.name) + '">✕</span></button>').join("")
    : '<span class="hint">no clips yet — ADD CLIPS to build the ship\'s soundboard</span>';
}
$("sbAdd").addEventListener("click", async () => {
  const r = await ipcRenderer.invoke("sounds-add");
  if (r.ok && r.added.length) { toast("Added " + r.added.length + " clip(s)."); refreshSounds(); }
});
$("sbList").addEventListener("click", async (e) => {
  const del = e.target.closest("[data-del]");
  if (del) {
    e.stopPropagation();
    await ipcRenderer.invoke("sounds-delete", del.dataset.del);
    refreshSounds(); return;
  }
  const b = e.target.closest("[data-snd]"); if (!b) return;
  playClipOnNet(b.dataset.snd, sel());
});
async function playClipOnNet(name, net) {
  if (!net || !net.tuned) { toast("Tune the net first."); return; }
  if (sbPlaying) { toast("A clip is already playing."); return; }
  const r = await ipcRenderer.invoke("sounds-read", name);
  if (!r.ok) { toast("Couldn't read clip: " + r.error); return; }
  let audio;
  try { audio = await ctx.decodeAudioData(r.data); }
  catch (e) { toast("Unsupported audio format: " + name); return; }
  /* mix to mono at the context's 48k rate */
  const len = audio.length, chans = audio.numberOfChannels;
  const mono = new Float32Array(len);
  for (let c = 0; c < chans; c++) {
    const d = audio.getChannelData(c);
    for (let i = 0; i < len; i++) mono[i] += d[i] / chans;
  }
  sbPlaying = name; renderSoundboard();
  addLog("tx", net.cfg.name, "SHIPWIDE CLIP — " + name + (net.bcast ? " (nest)" : ""));
  if (net.bcast) await ipcRenderer.invoke("arm-broadcast", net.idx);
  /* local monitor so the sender hears it too */
  const src = ctx.createBufferSource(); src.buffer = audio;
  const g = ctx.createGain(); g.gain.value = 0.5;
  src.connect(g); g.connect(ctx.destination); src.start();

  const enc = new OpusScript(48000, 1, OpusScript.Application.AUDIO);
  const i16 = Buffer.alloc(FRAME * 2);
  let pos = 0;
  const pump = setInterval(() => {
    if (pos >= len) {
      clearInterval(pump);
      try { ipcRenderer.send("tx-frame", { idx: net.idx, frame: Buffer.from(enc.encode(Buffer.alloc(FRAME * 2), FRAME)), last: true, broadcast: !!net.bcast }); } catch (e) {}
      sbPlaying = null; renderSoundboard();
      return;
    }
    for (let i = 0; i < FRAME; i++) {
      const s = pos + i < len ? Math.max(-1, Math.min(1, mono[pos + i])) : 0;
      i16.writeInt16LE((s * 32767) | 0, i * 2);
    }
    pos += FRAME;
    try { ipcRenderer.send("tx-frame", { idx: net.idx, frame: Buffer.from(enc.encode(i16, FRAME)), last: false, broadcast: !!net.bcast }); } catch (e) {}
  }, 20);
}

/* ══ IPC: voice / roster / chat ══ */
ipcRenderer.on("rx", (ev, r) => {
  const i = nets.findIndex(x => x.idx === r.idx); if (i < 0) return;
  const n = nets[i];
  if (!n.mon) return;
  playFrame(n, r.session, r.opus);
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
  if (i === selectedI) renderChat();
});
function sendChat() {
  const n = sel(), v = $("chatIn").value.trim();
  if (!n || !n.tuned || !n.mon || !v) return;
  ipcRenderer.send("send-text", { idx: n.idx, message: v });
  n.chat.push({ t: utc(), from: callsign, msg: v, mine: true });
  addLog("chatline", n.cfg.name, callsign + ": " + v);
  $("chatIn").value = ""; renderChat();
}
$("chatSend").addEventListener("click", sendChat);
$("chatTabs").addEventListener("click", (e) => {
  const b = e.target.closest("[data-ci]"); if (!b) return;
  selectedI = +b.dataset.ci; renderNets(); renderChatTabs(); renderChat();
});
$("chatIn").addEventListener("keydown", (e) => { if (e.key === "Enter") sendChat(); e.stopPropagation(); });
ipcRenderer.on("net-down", (ev, r) => {
  const i = nets.findIndex(x => x.idx === r.idx); if (i < 0) return;
  if (connected) { addLog("sys", nets[i].cfg.name, "LINK LOST — retune to reconnect"); toast(nets[i].cfg.name + " link lost."); }
  nets[i].tuned = false; nets[i].idx = null; renderNets();
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
let acct = null; // {account:{role,callsign,discordName}, relay:{password,tokens,adminToken}}
const discordMode = !!(pkg.accounts && pkg.accounts.url && pkg.accounts.discordClientId) && !process.env.FLEETCOMM_AUTOTEST;
function currentHost() { return store.get("hostOverride", "") || pkg.server.host; }
$("relayname").textContent = pkg.org.toUpperCase();
$("relayedit").addEventListener("click", () => { $("hostrow").style.display = "flex"; $("hostIn").value = currentHost(); $("hostIn").focus(); });
function renderCsList() { $("csList").innerHTML = myCallsigns.map(c => '<option value="' + esc(c) + '">').join(""); }
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
  const wanted = nets.map((n, i) => i).filter(i => nets[i].cfg.monitor || nets[i].cfg.defaultKey);
  const res = await ipcRenderer.invoke("connect", {
    host, port: pkg.server.port, callsign: cs,
    nets: wanted.map(i => ({ name: nets[i].cfg.name, freq: nets[i].cfg.freq, channel: nets[i].cfg.name })),
    token: cmdToken || null,
    relayPassword: acct && acct.relay ? acct.relay.password : "",
    roleTokens: acct && acct.relay ? acct.relay.tokens : []
  });
  btn.textContent = "CONNECT ▸";
  const okCount = res.filter(r => r.ok).length;
  if (!okCount) {
    const raw = (res[0] && res[0].error) || "unknown";
    $("connErr").textContent = /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH/.test(raw)
      ? "The relay dropped the attempt — usually its rapid-reconnect guard. Wait a minute, then try again."
      : "Could not tune any nets: " + raw;
    return;
  }
  res.forEach((r, k) => {
    if (!r.ok) { addLog("sys", nets[wanted[k]].cfg.name, "tune failed: " + r.error); return; }
    const n = nets[wanted[k]];
    n.tuned = true; n.idx = r.idx; makeChain(n);
    if (!n.mon) ipcRenderer.send("net-mute", { idx: n.idx, muted: true });
    if (!n.bind && n.cfg.defaultKey) n.bind = { src: "label", label: n.cfg.defaultKey, mods: [] };
  });
  connected = true;
  if (acct && cs !== acct.account.callsign) ipcRenderer.invoke("acct", { method: "POST", path: "/api/callsign", body: { callsign: cs } });
  selectedI = nets.findIndex(n => n.tuned);
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
  acct = { account: r.account, relay: r.relay };
  if (r.account.role === "pending" || !r.relay) {
    $("pendingBox").style.display = "block";
    $("csRow2").style.display = "none"; $("connectBtn").style.display = "none";
    return;
  }
  $("pendingBox").style.display = "none";
  if (r.relay.adminToken) cmdToken = r.relay.adminToken; /* command role carries authority automatically */
  $("csRow2").style.display = "flex"; $("connectBtn").style.display = "block";
  $("csIn").value = r.account.callsign || callsign || "";
  $("discordBtn").textContent = "✓ " + r.account.discordName.toUpperCase() + " — " + r.account.role.toUpperCase();
  $("discordBtn").disabled = true;
}
if ($("discordBtn")) $("discordBtn").addEventListener("click", async function () {
  this.textContent = "WAITING FOR DISCORD… (check your browser)";
  const r = await ipcRenderer.invoke("discord-login");
  if (!r.ok) {
    this.textContent = "SIGN IN WITH DISCORD ▸";
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
  ipcRenderer.send("disconnect"); connected = false;
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
    '<button class="tunelink" data-name="' + esc(c.name) + '">TUNE ME HERE ▸</button></div>'
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
  if (leavingSys) { cmdToken = $("tokenIn").value.trim(); store.set("cmdToken", cmdToken); renderTxTargets(); }
  document.querySelectorAll(".page").forEach(p => p.classList.toggle("on", p.id === id));
  document.querySelectorAll(".pkey").forEach(k => k.classList.toggle("on", k.dataset.page === id));
  if (id === "pgAtc") refreshAtc();
  if (id === "pgAcct") refreshAccts();
  if (id === "pgChat") { renderChatTabs(); renderChat(); }
  if (id === "settings") $("tokenIn").value = cmdToken;
}
document.querySelectorAll(".pkey").forEach(k => k.addEventListener("click", () => showPage(k.dataset.page)));
let opsTimer = null;
function pollOps() {
  clearInterval(opsTimer);
  opsTimer = setInterval(async () => {
    if (!connected) return;
    const view = await ipcRenderer.invoke("atc-view");
    const names = new Set(); view.forEach(c => c.users.forEach(u => names.add(u)));
    $("opsCount").textContent = names.size;
  }, 12000);
}

/* ══ header / settings / theme wiring ══ */
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
ipcRenderer.on("update-auto-offer", async (ev, r) => {
  if (!autoUpdate || connected) return;   /* never yank the app out from under a live op */
  $("updtext").textContent = "Installing FleetComm v" + r.version + " automatically…";
  $("updgo").style.display = "none";
  const res = await ipcRenderer.invoke("do-update", { version: r.version });
  if (res && res.ok) { $("updtext").textContent = "Update installed — restarting…"; return; }
  $("updgo").style.display = "";
  $("updtext").textContent = "FleetComm v" + r.version + " is available";
});
$("sautoupd").addEventListener("click", function () {
  autoUpdate = !autoUpdate; this.classList.toggle("on", autoUpdate); store.set("autoUpdate", autoUpdate);
  toast(autoUpdate ? "Updates will install automatically at launch." : "Automatic updates off — you'll get a banner instead.");
});
$("updgo").addEventListener("click", async function () {
  this.disabled = true; this.textContent = "Updating…";
  const r = await ipcRenderer.invoke("do-update", { version: $("updbar").dataset.version });
  if (r && r.ok) { $("updtext").textContent = "Restarting…"; return; }
  this.disabled = false; this.textContent = "Install & restart";
  if (r && r.error) toast("Auto-update failed (" + r.error + ") — opening the releases page instead.");
  ipcRenderer.send("open-external", $("updbar").dataset.url);
});
ipcRenderer.on("update-progress", (ev, pct) => { $("updtext").textContent = "Downloading update… " + pct + "%"; });
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
  const _v = "v" + require("../package.json").version;
  $("verlbl").textContent = "FLEETCOMM " + _v + ' — native unit: in-game PTT + overlay · developed by Rook "Doc" Sabbah, UEE 22nd Expeditionary Fleet';
  $("verlbl2").textContent = _v;
} catch (e) {}
$("sfx").classList.toggle("on", fx);
$("sautoupd").classList.toggle("on", autoUpdate);
$("fxsel").value = fxPreset;
applyTheme(); renderCsList(); renderMasterBinds(); renderMic(); renderNets(); refreshSounds();
$("signDiscord").style.display = discordMode ? "block" : "none";
$("signLegacy").style.display = discordMode ? "none" : "block";
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
    return '<div class="acctrow" data-id="' + x.discordId + '"><div class="nm"><b>' + esc(x.callsign || "(no callsign yet)") + '</b>' +
      '<span>discord: ' + esc(x.discordName) + " · " + (x.lastSeen ? "seen " + new Date(x.lastSeen).toLocaleString() : "never seen") + "</span></div>" +
      '<span class="ann rolelbl ' + (x.role === "command" ? "lit-a" : x.role === "member" ? "lit-g" : "") + '">' + x.role.toUpperCase() + "</span>" + btns + "</div>";
  }).join("");
  const levels = ["open", "member", "command"];
  const rows = [];
  nets.forEach(n => rows.push({ name: n.cfg.name, freq: n.cfg.freq }));
  $("netAccess").innerHTML = rows.map(r =>
    '<div class="narow" data-net="' + esc(r.name) + '"><b>' + esc(r.name) + '</b><span class="fq2 num">' + r.freq + "</span>" +
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
if (process.env.FLEETCOMM_AUTOTEST) {
  setTimeout(() => {
    store.set("hostOverride", process.env.FLEETCOMM_AUTOTEST);
    $("hostrow").style.display = "flex";
    $("hostIn").value = process.env.FLEETCOMM_AUTOTEST;
    $("csIn").value = "AUTOTEST-RIG";
    $("connectBtn").click();
    setTimeout(async () => {
      const tuned = nets.filter(n => n.tuned);
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
  setTimeout(() => {
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
