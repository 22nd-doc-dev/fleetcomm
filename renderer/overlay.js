"use strict";
const ipcRenderer = window.fleetcommOverlay;
const $ = (id) => document.getElementById(id);
let cfg = { opacity: 72, scale: 100 };

function applyCfg() {
  document.documentElement.style.setProperty("--bgA", cfg.opacity / 100);
  $("box").style.transform = "scale(" + cfg.scale / 100 + ")";
  $("op").value = cfg.opacity; $("sc").value = cfg.scale;
}
function row(net) {
  const el = document.createElement("div");
  el.className = "row" + (net.tx ? " tx" : (net.who ? " rx" : "")) +
    (net.active ? " active" : "") + (net.mon ? "" : " inactive-muted");
  const lamp = document.createElement("span"); lamp.className = "lamp";
  const name = document.createElement("span"); name.className = "nm"; name.textContent = net.name;
  const freq = document.createElement("small"); freq.textContent = net.freq; name.appendChild(freq);
  const active = document.createElement("span"); active.className = "act"; active.textContent = "◈"; name.appendChild(active);
  const who = document.createElement("span"); who.className = "who";
  who.textContent = net.tx ? "TX·" + net.me : (net.who || "");
  el.append(lamp, name, who);
  return el;
}

ipcRenderer.on("ov-config", (ev, next) => { cfg = Object.assign(cfg, next); applyCfg(); });
ipcRenderer.on("ov-theme", (ev, theme) => {
  const r = document.documentElement;
  ["--panelRGB","--holoRGB","--ink","--muted","--holo"].forEach(key => r.style.removeProperty(key));
  if (theme.palette) {
    document.body.classList.remove("light");
    r.style.setProperty("--panelRGB", theme.palette.panelRGB);
    r.style.setProperty("--holoRGB", theme.palette.accentRGB);
    r.style.setProperty("--ink", theme.palette.ink);
    r.style.setProperty("--muted", theme.palette.muted);
    r.style.setProperty("--holo", theme.palette.accent);
  } else document.body.classList.toggle("light", !theme.dark);
});
ipcRenderer.on("ov-edit", (ev, on) => document.body.classList.toggle("editing", !!on));
ipcRenderer.on("ov-state", (ev, nets) => {
  $("empty").style.display = nets.length ? "none" : "block";
  $("rows").replaceChildren(...nets.map(row));
});
/* fleet ops are briefed in UTC — a compact readout so nobody alt-tabs to do
   timezone math mid-op. Drift-proof: re-aligns to the wall clock each tick. */
function tickClock() {
  const n = new Date();
  const p = (x) => String(x).padStart(2, "0");
  $("clockT").textContent = p(n.getUTCHours()) + ":" + p(n.getUTCMinutes()) + ":" + p(n.getUTCSeconds());
  setTimeout(tickClock, 1000 - n.getMilliseconds() + 20);
}
tickClock();
$("op").addEventListener("input", function () { cfg.opacity = +this.value; applyCfg(); ipcRenderer.send("ov-set", cfg); });
$("sc").addEventListener("input", function () { cfg.scale = +this.value; applyCfg(); ipcRenderer.send("ov-set", cfg); });
$("lock").addEventListener("click", () => ipcRenderer.send("ov-lock"));
