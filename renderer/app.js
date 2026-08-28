"use strict";
/* FleetComm renderer v0.2: compact rack, modifier keybinds, active-net system. */
const { ipcRenderer } = require("electron");
const OpusScript = require("opusscript");
const pkg = require("../config/22nd-package.json");

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
};
let fx = store.get("fx", true), fxPreset = store.get("fxPreset", "standard"), dark = store.get("dark", true);
const FXP = {
  clean:    { hp: 250, lp: 3400, stages: 1, drive: 0,    comp: null, noise: 0,     tail: 0 },
  standard: { hp: 300, lp: 3000, stages: 2, drive: 0.35, comp: { th: -28, ratio: 8,  atk: 0.003, rel: 0.12 }, noise: 0.006, tail: 0.05 },
  heavy:    { hp: 400, lp: 2700, stages: 2, drive: 0.8,  comp: { th: -32, ratio: 12, atk: 0.002, rel: 0.10 }, noise: 0.015, tail: 0.09 }
};
let myCallsigns = store.get("callsigns", []);           // v0.2: no invented presets
let callsign = store.get("callsign", "");
let keyBinds = store.get("keybinds2", {});              // freq -> bind
let masterBinds = store.get("masterBinds", {
  active: null,
  cycUp: { src: "label", label: "PageUp" },
  cycDn: { src: "label", label: "PageDown" }
});
let cmdToken = store.get("cmdToken", "");

let nets = [], connected = false, activeIdx = 0;
const $ = (id) => document.getElementById(id);

/* ══ keybind model ══
   bind = { src:'g'|'dom'|'label', code?, label, mods:[...] }
   'g'   = captured from global uiohook stream (works while game focused)
   'dom' = captured in-window fallback
   'label' = match by key label on either stream (used for defaults) */
const MODS = ["ALT", "CTRL", "SHIFT", "META"];
function normMod(label) {
  const l = String(label).toUpperCase();
  if (l.startsWith("ALT")) return "ALT";
  if (l.startsWith("CTRL") || l.startsWith("CONTROL")) return "CTRL";
  if (l.startsWith("SHIFT")) return "SHIFT";
  if (l.startsWith("META") || l.startsWith("CMD") || l.startsWith("OS")) return "META";
  return null;
}
const heldMods = new Set(); // maintained from the global stream
let gActive = false; // becomes true once the global hook delivers its first event —
                     // from then on the DOM handlers stand down so keys never double-fire
function modsEqual(a, b) { return a.length === b.length && a.every(m => b.includes(m)); }
function bindLabel(mods, label) { return (mods.length ? mods.join("+") + "+" : "") + label; }
function matchDown(bind, src, code, label, mods) {
  if (!bind) return false;
  if (bind.src === "label") return bind.label === label && mods.length === 0;
  return bind.src === src && bind.code === code && modsEqual(bind.mods || [], mods);
}
function matchUp(bind, src, code, label) {
  if (!bind) return false;
  if (bind.src === "label") return bind.label === label;
  return bind.src === src && bind.code === code;
}

/* capture state: {kind:'net', idx} | {kind:'master', which} */
let capturing = null;
function finishCapture(src, code, label, mods) {
  const bind = { src, code, label: bindLabel(mods, label), mods };
  if (capturing.kind === "net") {
    nets[capturing.idx].bind = bind;
    keyBinds[nets[capturing.idx].cfg.freq] = bind;
    store.set("keybinds2", keyBinds);
  } else {
    masterBinds[capturing.which] = bind;
    store.set("masterBinds", masterBinds);
    renderMasterBinds();
  }
  capturing = null; render();
}

/* ══ AUDIO (unchanged core from v0.1) ══ */
const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
const FRAME = 960;
let capNode = null, txSet = new Set(), txEndPending = new Set();
const encoder = new OpusScript(48000, 1, OpusScript.Application.VOIP);
try { encoder.encoderCTL(4002, 40000); } catch (e) {}

async function ensureMic() {
  if (capNode) return;
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
    for (let i = 0; i < FRAME; i++) {
      const s = Math.max(-1, Math.min(1, f32[i]));
      i16.writeInt16LE((s * 32767) | 0, i * 2);
    }
    let opus;
    try { opus = Buffer.from(encoder.encode(i16, FRAME)); } catch (e) { return; }
    for (const idx of txSet) ipcRenderer.send("tx-frame", { idx, frame: opus, last: false });
    for (const idx of txEndPending) { ipcRenderer.send("tx-frame", { idx, frame: opus, last: true }); txEndPending.delete(idx); }
  };
}
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
function makeChain(net) {
  net.gainNode = ctx.createGain(); net.gainNode.gain.value = net.vol / 100;
  net.panNode = ctx.createStereoPanner(); net.panNode.pan.value = net.pan / 100;
  wireChain(net);
}
function wireChain(net) {
  /* teardown previous */
  (net.fxNodes || []).forEach(n => { try { n.disconnect(); } catch (e) {} });
  [net.gainNode, net.panNode].forEach(n => { try { n.disconnect(); } catch (e) {} });
  if (net.noiseSrc) { try { net.noiseSrc.stop(); } catch (e) {} net.noiseSrc = null; }
  const p = FXP[fxPreset] || FXP.standard;
  const nodes = [];
  let head = net.gainNode;
  for (let i = 0; i < p.stages; i++) {
    const hp = ctx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = p.hp; hp.Q.value = 0.7;
    head.connect(hp); nodes.push(hp); head = hp;
  }
  for (let i = 0; i < p.stages; i++) {
    const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = p.lp; lp.Q.value = 0.7;
    head.connect(lp); nodes.push(lp); head = lp;
  }
  if (p.drive > 0) {
    const ws = ctx.createWaveShaper(); ws.curve = shaperCurve(p.drive); ws.oversample = "2x";
    head.connect(ws); nodes.push(ws); head = ws;
  }
  if (p.comp) {
    const cp = ctx.createDynamicsCompressor();
    cp.threshold.value = p.comp.th; cp.ratio.value = p.comp.ratio;
    cp.attack.value = p.comp.atk; cp.release.value = p.comp.rel; cp.knee.value = 4;
    head.connect(cp); nodes.push(cp); head = cp;
  }
  head.connect(net.panNode);
  net.panNode.connect(ctx.destination);
  /* speech-gated noise floor */
  net.noiseGain = ctx.createGain(); net.noiseGain.gain.value = 0;
  if (p.noise > 0) {
    const src = ctx.createBufferSource(); src.buffer = getNoiseBuf(); src.loop = true;
    src.connect(net.noiseGain); net.noiseGain.connect(net.panNode);
    src.start(); net.noiseSrc = src; nodes.push(net.noiseGain);
  }
  net.fxNodes = nodes;
}
function squelchTail(net) {
  const p = FXP[fxPreset] || FXP.standard;
  if (!p.tail || !fx) return;
  try {
    const src = ctx.createBufferSource(); src.buffer = getNoiseBuf();
    const g = ctx.createGain(); const t = ctx.currentTime;
    g.gain.setValueAtTime(p.tail, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    src.connect(g); g.connect(net.panNode);
    src.start(t, Math.random(), 0.1);
  } catch (e) {}
}
const decoders = new Map();
function playFrame(net, session, opusBuf) {
  const key = net.uiIdx + ":" + session;
  let d = decoders.get(key);
  if (!d) { d = { dec: new OpusScript(48000, 1), cursor: 0 }; decoders.set(key, d); }
  let pcm;
  try { pcm = d.dec.decode(Buffer.from(opusBuf)); } catch (e) { return; }
  const n = pcm.length / 2, ab = ctx.createBuffer(1, n, 48000), chan = ab.getChannelData(0);
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  for (let i = 0; i < n; i++) chan[i] = view.getInt16(i * 2, true) / 32768;
  const src = ctx.createBufferSource(); src.buffer = ab; src.connect(net.gainNode);
  d.cursor = Math.max(ctx.currentTime + 0.06, d.cursor);
  src.start(d.cursor); d.cursor += n / 48000;
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

/* ══ RACK ══ */
const rack = $("rack");
function sendOv() {
  ipcRenderer.send("ov-state", nets.map(n => ({
    name: n.cfg.name, freq: n.cfg.freq, who: n.rxName, tx: n.tx,
    active: n.uiIdx === activeIdx, mon: n.mon, me: callsign
  })));
}
function render() {
  if (activeIdx >= nets.length) activeIdx = Math.max(0, nets.length - 1);
  rack.innerHTML = "";
  nets.forEach((n, i) => {
    n.uiIdx = i;
    const row = document.createElement("div");
    row.className = "rrow" + (n.tx ? " tx" : (n.rxName ? " rx" : "")) + (i === activeIdx ? " active" : "");
    row.dataset.i = i;
    row.innerHTML =
      '<span class="lamp"></span>' +
      '<button class="rmain" data-sel title="Set active net">' +
        '<b>' + n.cfg.name + (n.cfg.enc ? ' <span class="enc-dot">🔒</span>' : '') + ' <span class="activetag">ACTIVE</span></b>' +
        '<span class="rfreq mono">' + n.cfg.freq + '</span></button>' +
      '<span class="who mono" data-who>' + whoText(n) + '</span>' +
      '<span class="rcount" data-roster title="On this net">' + (n.roster ? n.roster.length : 1) + '</span>' +
      '<input type="range" class="rvol" min="0" max="100" value="' + n.vol + '" data-vol title="Volume">' +
      '<input type="range" class="rpan" min="-100" max="100" value="' + n.pan + '" data-pan title="Pan L/R">' +
      '<button class="keybadge" data-key title="Click, then press a key or combo (ALT+D works)">' + (n.bind ? n.bind.label : "key") + '</button>' +
      '<button class="pttbtn" data-ptt>TX</button>' +
      '<button class="monbtn' + (n.mon ? " on" : "") + '" data-mon>' + (n.mon ? "RX" : "off") + '</button>' +
      '<button class="close" title="Detune">✕</button>';
    rack.appendChild(row);
  });
  sendOv();
}
function whoText(n) {
  return n.tx ? "TX · " + callsign : (n.rxName ? "RX · " + n.rxName : (n.mon ? "—" : "muted"));
}
function updateWho(n) {
  const row = rack.querySelector('[data-i="' + n.uiIdx + '"]');
  if (!row) return;
  row.classList.toggle("tx", !!n.tx);
  row.classList.toggle("rx", !n.tx && !!n.rxName);
  row.querySelector("[data-who]").textContent = whoText(n);
}
function setActive(i) {
  if (i < 0 || i >= nets.length) return;
  activeIdx = i;
  rack.querySelectorAll(".rrow").forEach((r, j) => r.classList.toggle("active", j === i));
  sendOv();
}
function cycleActive(dir) {
  if (!nets.length) return;
  setActive((activeIdx + dir + nets.length) % nets.length);
  chirpUp();
}

rack.addEventListener("input", (e) => {
  const n = nets[+e.target.closest(".rrow").dataset.i];
  if (e.target.hasAttribute("data-vol")) { n.vol = +e.target.value; if (n.gainNode) n.gainNode.gain.value = n.vol / 100; }
  if (e.target.hasAttribute("data-pan")) { n.pan = +e.target.value; if (n.panNode) n.panNode.pan.value = n.pan / 100; }
});
rack.addEventListener("click", (e) => {
  const row = e.target.closest(".rrow"); if (!row) return;
  const i = +row.dataset.i, n = nets[i];
  if (e.target.closest("[data-sel]")) { setActive(i); return; }
  if (e.target.closest(".close")) { ipcRenderer.send("detune", n.idx); nets.splice(i, 1); render(); return; }
  if (e.target.closest("[data-mon]")) { n.mon = !n.mon; ipcRenderer.send("net-mute", { idx: n.idx, muted: !n.mon }); render(); return; }
  if (e.target.closest("[data-key]")) {
    capturing = { kind: "net", idx: i };
    const b = row.querySelector("[data-key]");
    b.classList.add("listen"); b.textContent = "press…";
  }
});
rack.addEventListener("pointerdown", (e) => {
  const b = e.target.closest("[data-ptt]"); if (!b) return;
  e.preventDefault();
  startTX(+b.closest(".rrow").dataset.i);
  const end = () => { nets.forEach((n, i) => n.tx && endTX(i)); window.removeEventListener("pointerup", end); };
  window.addEventListener("pointerup", end);
});

async function startTX(i) {
  const n = nets[i]; if (!n || n.tx || !connected) return;
  try { await ensureMic(); } catch (e) { toast("Microphone unavailable: " + e.message); return; }
  n.tx = true; txSet.add(n.idx); chirpDown(); updateWho(n); sendOv();
}
function endTX(i) {
  const n = nets[i]; if (!n || !n.tx) return;
  n.tx = false; txSet.delete(n.idx); txEndPending.add(n.idx); chirpUp(); updateWho(n); sendOv();
}

/* ── key streams ── */
function onKeyDown(src, code, label, mods) {
  if (capturing) { finishCapture(src, code, label, mods); return; }
  if (document.activeElement && /INPUT|TEXTAREA/.test(document.activeElement.tagName)) return;
  if (matchDown(masterBinds.cycUp, src, code, label, mods)) { cycleActive(-1); return; }
  if (matchDown(masterBinds.cycDn, src, code, label, mods)) { cycleActive(1); return; }
  if (matchDown(masterBinds.active, src, code, label, mods)) { startTX(activeIdx); return; }
  nets.forEach((n, i) => { if (matchDown(n.bind, src, code, label, mods)) startTX(i); });
}
function onKeyUp(src, code, label) {
  if (matchUp(masterBinds.active, src, code, label) && nets[activeIdx]) endTX(activeIdx);
  nets.forEach((n, i) => { if (n.tx && matchUp(n.bind, src, code, label)) endTX(i); });
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
  if (gActive) { // global hook owns all binds; just stop the page reacting to bound keys
    if (e.key === "PageUp" || e.key === "PageDown") e.preventDefault();
    return;
  }
  const mods = MODS.filter(m => ({ ALT: e.altKey, CTRL: e.ctrlKey, SHIFT: e.shiftKey, META: e.metaKey })[m]);
  if (normMod(e.key)) return; // bare modifier press
  if (capturing) e.preventDefault();
  onKeyDown("dom", e.code, e.code.replace(/^Key|^Digit/, ""), mods);
});
window.addEventListener("keyup", (e) => { if (!gActive) onKeyUp("dom", e.code, e.code.replace(/^Key|^Digit/, "")); });

/* ── RX / roster from main ── */
ipcRenderer.on("rx", (ev, r) => {
  const n = nets.find(x => x.idx === r.idx); if (!n || !n.mon) return;
  playFrame(n, r.session, r.opus);
  if (!n.tx) {
    if (!n.rxName) { chirpDown(); if (n.noiseGain) n.noiseGain.gain.value = (FXP[fxPreset] || FXP.standard).noise; }
    n.rxName = r.name; updateWho(n); sendOv();
    clearTimeout(n.rxTimer);
    n.rxTimer = setTimeout(() => {
      n.rxName = null;
      if (n.noiseGain) n.noiseGain.gain.value = 0;
      squelchTail(n);
      updateWho(n); sendOv();
    }, 350);
  }
});
ipcRenderer.on("roster", (ev, r) => {
  const n = nets.find(x => x.idx === r.idx); if (!n) return;
  n.roster = r.users;
  const el = rack.querySelector('[data-i="' + n.uiIdx + '"] [data-roster]');
  if (el) { el.textContent = r.users.length; el.title = "On this net:\n" + r.users.join("\n"); }
});
ipcRenderer.on("net-down", (ev, r) => {
  const n = nets.find(x => x.idx === r.idx);
  if (n && connected) toast(n.cfg.name + " link lost — retune to reconnect");
});
ipcRenderer.on("net-error", (ev, r) => toast("Net error: " + r.error));

/* ══ CONNECT ══ */
function currentHost() { return store.get("hostOverride", "") || pkg.server.host; }
function initConnect() {
  $("relayname").textContent = pkg.org.toUpperCase();
  $("hostIn").value = currentHost();
  $("csIn").value = callsign;
  $("relayedit").addEventListener("click", () => { $("hostrow").style.display = "flex"; $("hostIn").focus(); });
}
$("connectBtn").addEventListener("click", async () => {
  const host = ($("hostrow").style.display !== "none" ? $("hostIn").value.trim() : currentHost());
  const cs = $("csIn").value.trim().toUpperCase();
  if (!cs) { $("connErr").textContent = "Enter a callsign."; return; }
  callsign = cs;
  if (myCallsigns.indexOf(cs) < 0) myCallsigns.unshift(cs);
  store.set("callsign", cs); store.set("callsigns", myCallsigns.slice(0, 12));
  if (host !== pkg.server.host) store.set("hostOverride", host);
  renderCallsigns();
  $("connErr").textContent = ""; $("connectBtn").textContent = "Connecting…";
  const wanted = pkg.nets.filter(n => n.monitor || n.defaultKey);
  const res = await ipcRenderer.invoke("connect", { host, port: pkg.server.port, callsign: cs, nets: wanted, token: cmdToken || null });
  $("connectBtn").textContent = "Connect ▸";
  const okCount = res.filter(r => r.ok).length;
  if (!okCount) { $("connErr").textContent = "Could not tune any nets: " + (res[0] && res[0].error || "unknown"); return; }
  nets = [];
  res.forEach((r, i) => {
    if (!r.ok) { toast("Couldn't tune " + wanted[i].name + ": " + r.error); return; }
    const cfg = wanted[i];
    const n = { cfg, idx: r.idx, vol: 75, pan: 0, mon: cfg.monitor !== false, bind: keyBinds[cfg.freq] || null, tx: false, rxName: null };
    makeChain(n); nets.push(n);
    if (!n.mon) ipcRenderer.send("net-mute", { idx: n.idx, muted: true });
  });
  connected = true; activeIdx = 0;
  $("connectOv").classList.add("hidden");
  $("conndot").className = "dot"; $("connlbl").textContent = "LINKED · " + pkg.shortname;
  render(); chirpDown();
});

/* ── tune / create ── */
function normFreq(v) {
  v = String(v).replace(/[^\d.]/g, "");
  if (!/\d/.test(v)) return null;
  const p = v.split(".");
  let a = p[0].slice(0, 3) || "0", b = ((p[1] || "") + "000").slice(0, 3);
  while (a.length < 3) a = "0" + a;
  return a + "." + b;
}
async function doTune() {
  if (!connected) { toast("Connect first."); return; }
  const f = normFreq($("freqIn").value), nm = $("nameIn").value.trim().toUpperCase();
  const cfg = pkg.nets.find(n => n.freq === f) || (nm ? { name: nm, freq: f || "000.000", channel: nm } : null);
  if (!cfg) { toast("No net at that frequency — add a label to tune or create by name."); return; }
  if (nets.some(n => n.cfg.name === cfg.name)) { toast("Already tuned."); return; }
  let r = await ipcRenderer.invoke("tune", cfg);
  if (!r.ok && /not found/.test(r.error) && nm) {
    if (!cmdToken) { toast("Net doesn't exist. Creating nets requires a command token (⚙ Settings)."); return; }
    const made = await ipcRenderer.invoke("create-net", { name: nm, rootChannel: pkg.rootChannel });
    if (!made.ok) {
      toast(/PermissionDenied/.test(made.error) ? "The relay refused: your command token doesn't grant net creation." : "Create failed: " + made.error);
      return;
    }
    r = await ipcRenderer.invoke("tune", cfg);
  }
  if (!r.ok) { toast("Tune failed: " + r.error); return; }
  const n = { cfg, idx: r.idx, vol: 75, pan: 0, mon: true, bind: keyBinds[cfg.freq] || null, tx: false, rxName: null };
  makeChain(n); nets.push(n);
  $("freqIn").value = ""; $("nameIn").value = "";
  render(); chirpDown();
}
$("tuneBtn").addEventListener("click", doTune);
["freqIn", "nameIn"].forEach(id => $(id).addEventListener("keydown", (e) => { if (e.key === "Enter") doTune(); e.stopPropagation(); }));

/* ══ header / settings ══ */
function renderCallsigns() {
  const sel = $("cssel"); sel.innerHTML = "";
  if (!myCallsigns.length) {
    const o = document.createElement("option"); o.value = ""; o.textContent = "🎙 (set at connect)";
    sel.appendChild(o);
  }
  myCallsigns.forEach(c => {
    const o = document.createElement("option"); o.value = c; o.textContent = "🎙 " + c;
    if (c === callsign) o.selected = true; sel.appendChild(o);
  });
  const add = document.createElement("option"); add.value = "__new"; add.textContent = "＋ New callsign…";
  sel.appendChild(add);
}
$("cssel").addEventListener("change", function () {
  if (this.value === "__new") {
    const c = prompt("New callsign (used on next connect):");
    if (c && c.trim()) { callsign = c.trim().toUpperCase(); if (myCallsigns.indexOf(callsign) < 0) myCallsigns.unshift(callsign); }
    renderCallsigns();
  } else if (this.value) { callsign = this.value; }
  store.set("callsign", callsign); store.set("callsigns", myCallsigns.slice(0, 12));
  if (connected) toast("Callsign applies on next connect.");
});
function renderMasterBinds() {
  $("bindActive").textContent = masterBinds.active ? masterBinds.active.label : "set key";
  $("bindCycUp").textContent = masterBinds.cycUp ? masterBinds.cycUp.label : "set key";
  $("bindCycDn").textContent = masterBinds.cycDn ? masterBinds.cycDn.label : "set key";
}
[["bindActive", "active"], ["bindCycUp", "cycUp"], ["bindCycDn", "cycDn"]].forEach(([id, which]) => {
  $(id).addEventListener("click", function () {
    capturing = { kind: "master", which };
    this.classList.add("listen"); this.textContent = "press…";
  });
});
function setTheme(d) {
  dark = d; store.set("dark", d);
  document.documentElement.setAttribute("data-theme", d ? "dark" : "light");
  $("sdark").classList.toggle("on", d);
}
$("themebtn").addEventListener("click", () => setTheme(!dark));
$("setbtn").addEventListener("click", () => { $("tokenIn").value = cmdToken; $("settings").classList.remove("hidden"); });
$("closeSet").addEventListener("click", () => {
  cmdToken = $("tokenIn").value.trim(); store.set("cmdToken", cmdToken);
  $("settings").classList.add("hidden");
});
$("sdark").addEventListener("click", () => setTheme(!dark));
$("sfx").addEventListener("click", function () { fx = !fx; this.classList.toggle("on", fx); store.set("fx", fx); if (fx) chirpDown(); });
$("fxsel").addEventListener("change", function () {
  fxPreset = this.value; store.set("fxPreset", fxPreset);
  nets.forEach(wireChain);
  if (nets.length) squelchTail(nets[0]); else chirpDown();
});
/* overlay */
$("ovbtn").addEventListener("click", () => ipcRenderer.send("ov-toggle"));
ipcRenderer.on("ov-shown", (ev, shown) => {
  $("ovbtn").classList.toggle("onov", shown);
  if (!shown) $("sovedit").classList.remove("on");
});
$("sovedit").addEventListener("click", function () {
  const on = !this.classList.contains("on");
  this.classList.toggle("on", on);
  ipcRenderer.send("ov-edit", on);
});
ipcRenderer.on("ov-edit-state", (ev, on) => $("sovedit").classList.toggle("on", on));
/* updates */
function showUpdate(r) {
  $("updbar").style.display = "flex";
  $("updtext").textContent = "FleetComm v" + r.version + " is available";
  $("updbar").dataset.url = r.url;
}
ipcRenderer.on("update-available", (ev, r) => showUpdate(r));
$("updgo").addEventListener("click", () => ipcRenderer.send("open-external", $("updbar").dataset.url));
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
$("disconnBtn").addEventListener("click", () => {
  ipcRenderer.send("disconnect"); connected = false; nets = []; render();
  $("settings").classList.add("hidden"); $("connectOv").classList.remove("hidden");
  $("conndot").className = "dot off"; $("connlbl").textContent = "OFFLINE";
});
let toastTimer = null;
function toast(msg) {
  const t = $("toast"); t.textContent = msg; t.style.display = "block";
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.style.display = "none", 4600);
}

/* init */
try { $("verlbl").textContent = "v" + require("../package.json").version; } catch (e) {}
$("sfx").classList.toggle("on", fx);
$("fxsel").value = fxPreset;
setTheme(dark);
renderCallsigns();
renderMasterBinds();
initConnect();
render();

/* headless CI hook */
if (process.env.FLEETCOMM_AUTOTEST) {
  ipcRenderer.on("ov-shown", (ev, shown) => console.log("[AUTOTEST] overlay=" + shown));
  setTimeout(() => {
    store.set("hostOverride", process.env.FLEETCOMM_AUTOTEST);
    $("hostrow").style.display = "flex";
    $("hostIn").value = process.env.FLEETCOMM_AUTOTEST;
    $("csIn").value = "AUTOTEST-RIG";
    $("connectBtn").click();
    setTimeout(() => {
      console.log("[AUTOTEST] connected=" + connected + " nets=" + nets.map(n => n.cfg.freq).join(",") + " active=" + activeIdx);
      ipcRenderer.send("ov-toggle");
      $("fxsel").value = "heavy"; $("fxsel").dispatchEvent(new Event("change"));
      setTimeout(() => console.log("[AUTOTEST] fx=" + fxPreset + " chains=" + nets.every(n => n.fxNodes && n.fxNodes.length > 0)), 1500);
    }, 6000);
  }, 800);
}
