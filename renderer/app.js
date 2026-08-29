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
let customTheme = store.get("customTheme", { bg: "#071219", panel: "#0c1b23", ink: "#d9edf4", accent: "#38d1e8" });
let myCallsigns = store.get("callsigns", []);
let callsign = store.get("callsign", "");
let cmdToken = store.get("cmdToken", "");
let netPrefs = store.get("netPrefs", {}); // freq -> {txOn, vol, pan, mon, bind}
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
      bind: p.bind || null, roster: new Map(), speaking: new Map(), chat: [], tx: false
    });
  };
  for (const n of pkg.nets) { add(n, 0, null); for (const s of n.subnets || []) add(s, 1, n.name); }
}
buildNets();
function savePrefs() {
  nets.forEach(n => { netPrefs[n.cfg.freq] = { txOn: n.txOn, vol: n.vol, pan: n.pan, mon: n.mon, bind: n.bind }; });
  store.set("netPrefs", netPrefs);
}
const sel = () => nets[selectedI];

/* ══ color helpers + theme engine ══ */
function hexRgb(h) { h = h.replace("#", ""); return [parseInt(h.slice(0,2),16), parseInt(h.slice(2,4),16), parseInt(h.slice(4,6),16)]; }
function mixHex(h1, h2, t) { const a = hexRgb(h1), b = hexRgb(h2); return "rgb(" + a.map((v,i) => Math.round(v + (b[i]-v)*t)).join(",") + ")"; }
function rgbaHex(h, al) { return "rgba(" + hexRgb(h).join(",") + "," + al + ")"; }
function luminance(h) { const [r,g,b] = hexRgb(h); return (0.299*r + 0.587*g + 0.114*b) / 255; }
let dark = themeMode !== "light";
function applyTheme() {
  const r = document.documentElement;
  ["--bg","--panel","--tint","--line","--line2","--ink","--muted","--holo","--holo-bright","--holo-tint","--grid","--lamp-off"]
    .forEach(k => r.style.removeProperty(k));
  let msg;
  if (themeMode === "custom") {
    const { bg, panel, ink, accent } = customTheme;
    dark = luminance(bg) < 0.5;
    r.setAttribute("data-theme", dark ? "dark" : "light");
    const set = (k, v) => r.style.setProperty(k, v);
    set("--bg", bg); set("--panel", panel);
    set("--tint", mixHex(panel, bg, 0.5));
    set("--line", mixHex(panel, ink, 0.16)); set("--line2", mixHex(panel, ink, 0.28));
    set("--ink", ink); set("--muted", mixHex(ink, bg, 0.42));
    set("--holo", accent); set("--holo-bright", accent);
    set("--holo-tint", rgbaHex(accent, 0.14));
    set("--grid", rgbaHex(accent, 0.045));
    set("--lamp-off", mixHex(panel, ink, 0.2));
    msg = { dark, bg, ink, palette: { panelRGB: hexRgb(panel).join(","), ink, muted: mixHex(ink, bg, 0.42), accent, accentRGB: hexRgb(accent).join(",") } };
  } else {
    dark = themeMode === "dark";
    r.setAttribute("data-theme", dark ? "dark" : "light");
    msg = { dark, bg: dark ? "#0c1b23" : "#e9eff4", ink: dark ? "#d9edf4" : "#12242e", palette: null };
  }
  store.set("themeMode", themeMode); store.set("customTheme", customTheme);
  $("sthemesel").value = themeMode;
  $("customcolors").style.display = themeMode === "custom" ? "flex" : "none";
  ["c_bg","c_panel","c_ink","c_accent"].forEach((id, i) => {
    $(id).value = [customTheme.bg, customTheme.panel, customTheme.ink, customTheme.accent][i];
  });
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
let capNode = null, txSet = new Set(), txEndPending = new Set();
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
      for (const idx of txSet) ipcRenderer.send("tx-frame", { idx, frame: opus, last: false });
      for (const idx of txEndPending) { ipcRenderer.send("tx-frame", { idx, frame: opus, last: true }); txEndPending.delete(idx); }
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
    const d = document.createElement("div");
    d.className = "net" + (n.depth ? " sub" : "") + (i === selectedI ? " sel" : "") + (n.tuned ? "" : " untuned") +
      (n.tx ? " tx-live" : (n.speaking.size ? " rx-live" : ""));
    d.dataset.i = i;
    let h = '<div class="nt" data-sel><span class="fq num">' + n.cfg.freq + '</span><b>' + n.cfg.name +
      (n.cfg.enc ? ' <span class="enc">⚿</span>' : "") + '</b>' +
      '<span class="cnt num" data-cnt>' + (n.tuned ? n.roster.size : "·") + '</span></div>';
    if (n.tuned) {
      h += '<div class="nrow">' +
        '<button class="ann' + (n.mon ? " lit-g" : "") + '" data-mon>LSN</button>' +
        '<button class="ann' + (n.txOn ? " lit-a" : "") + '" data-txon>TX</button>' +
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
  renderRoster(); renderChat();
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
function cycleSel(dir) {
  const tuned = nets.map((n, i) => i).filter(i => nets[i].tuned);
  if (!tuned.length) return;
  const pos = Math.max(0, tuned.indexOf(selectedI));
  selectedI = tuned[(pos + dir + tuned.length) % tuned.length];
  renderNets(); chirpUp();
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
  if (e.target.closest("[data-sel]")) { selectedI = i; renderNets(); return; }
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
  if (!n.mon) ipcRenderer.send("net-mute", { idx: n.idx, muted: true });
  addLog("sys", n.cfg.name, "tuned — " + n.cfg.freq + " MHz");
  renderNets();
  return true;
}
$("addNetBtn").addEventListener("click", async () => {
  const name = (prompt("Net name:") || "").trim().toUpperCase();
  if (!name) return;
  if (nets.some(n => n.cfg.name === name)) { toast("That net is already on your board."); return; }
  const freq = (prompt("Frequency label (e.g. 290.500):") || "").trim() || "———.———";
  const parent = (prompt("Parent net (blank = top level):") || "").trim().toUpperCase();
  const cfg = { name, freq, enc: false, subnets: [] };
  const p = parent ? nets.find(n => n.cfg.name === parent && n.depth === 0) : null;
  nets.push({ cfg, depth: p ? 1 : 0, parent: p ? p.cfg.name : null, tuned: false, idx: null, mon: true, txOn: false, vol: 75, pan: 0, bind: null, roster: new Map(), speaking: new Map(), chat: [], tx: false });
  const i = nets.length - 1;
  renderNets();
  await tuneNet(i);
});

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

/* ══ CONNECT ══ */
function currentHost() { return store.get("hostOverride", "") || pkg.server.host; }
$("relayname").textContent = pkg.org.toUpperCase();
$("relayedit").addEventListener("click", () => { $("hostrow").style.display = "flex"; $("hostIn").value = currentHost(); $("hostIn").focus(); });
function renderCsList() { $("csList").innerHTML = myCallsigns.map(c => '<option value="' + esc(c) + '">').join(""); }
$("csIn").value = callsign;
$("connectBtn").addEventListener("click", async () => {
  const host = ($("hostrow").style.display !== "none" ? $("hostIn").value.trim() : currentHost());
  const cs = $("csIn").value.trim().toUpperCase();
  if (!cs) { $("connErr").textContent = "Enter a callsign."; return; }
  callsign = cs;
  if (myCallsigns.indexOf(cs) < 0) myCallsigns.unshift(cs);
  store.set("callsign", cs); store.set("callsigns", myCallsigns.slice(0, 12));
  if (host !== pkg.server.host) store.set("hostOverride", host);
  renderCsList();
  $("connErr").textContent = ""; $("connectBtn").textContent = "CONNECTING…";
  const wanted = nets.map((n, i) => i).filter(i => nets[i].cfg.monitor || nets[i].cfg.defaultKey);
  const res = await ipcRenderer.invoke("connect", {
    host, port: pkg.server.port, callsign: cs,
    nets: wanted.map(i => ({ name: nets[i].cfg.name, freq: nets[i].cfg.freq, channel: nets[i].cfg.name })),
    token: cmdToken || null
  });
  $("connectBtn").textContent = "CONNECT ▸";
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
  selectedI = nets.findIndex(n => n.tuned);
  $("connectOv").classList.add("hidden");
  $("relayLbl").className = "v ok"; $("relayLbl").textContent = "LIVE · " + pkg.shortname;
  $("opchip").style.display = ""; $("opname").textContent = callsign;
  $("oprole").textContent = cmdToken ? "COMMAND" : "";
  $("authName").textContent = callsign; $("authRole").textContent = cmdToken ? "COMMAND" : "OPERATOR";
  addLog("sys", "", "operator " + callsign + " authenticated" + (cmdToken ? " (COMMAND)" : ""));
  renderNets(); chirpDown(); pollOps();
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
[["c_bg","bg"],["c_panel","panel"],["c_ink","ink"],["c_accent","accent"]].forEach(([id, key]) => {
  $(id).addEventListener("input", function () { customTheme[key] = this.value; themeMode = "custom"; applyTheme(); });
});
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
/* clock */
setInterval(() => { $("clock").textContent = utc(); }, 1000);

/* init */
try {
  const _v = "v" + require("../package.json").version;
  $("verlbl").textContent = "FLEETCOMM " + _v + ' — native unit: in-game PTT + overlay · developed by Rook "Doc" Sabbah, UEE 22nd Expeditionary Fleet';
  $("verlbl2").textContent = _v;
} catch (e) {}
$("sfx").classList.toggle("on", fx);
$("fxsel").value = fxPreset;
applyTheme(); renderCsList(); renderMasterBinds(); renderMic(); renderNets();
addLog("sys", "", "FleetComm console initialized — awaiting sign-in");

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
}
