"use strict";
/*
 * RadioStack — the FleetComm radio rack model.
 * One lightweight Mumble connection per tuned net ("one receiver per net",
 * like a physical multi-band rack). Gives perfect per-net RX attribution,
 * per-net TX with target 0, and a clean path to per-net channel passwords.
 */
const EventEmitter = require("events");
const { MumbleClient } = require("./mumble-client");

function sanitizeUser(name) { return name.replace(/[^\-=\w\[\]{}()@|.]+/g, "-").slice(0, 40) || "OPERATOR"; }

class RadioStack extends EventEmitter {
  /* opts: {host, port, callsign} */
  constructor(opts) {
    super();
    this.opts = opts;
    this.nets = []; // {cfg, client, channelId, users:Map, rxUntil}
  }

  get callsign() { return this.opts.callsign; }

  async tune(netCfg) {
    const idx = this.nets.length;
    const username = sanitizeUser(this.opts.callsign) + "|" + netCfg.freq;
    const client = new MumbleClient({
      host: this.opts.host, port: this.opts.port,
      username, tokens: this.opts.tokens || [], password: this.opts.password || "",
      cert: this.opts.cert, key: this.opts.key, release: "FleetComm"
    });
    const net = { cfg: netCfg, client, channelId: null, idx };
    this.nets.push(net);

    client.on("voice", (v) => {
      if (net.muted) return;
      this.emit("rx", { idx, session: v.session, name: this._shortName(client, v.session), opus: v.opus, last: v.last });
    });
    client.on("TextMessage", (m) => {
      const from = this._shortName(client, m.actor);
      this.emit("chat", { idx, from, message: String(m.message || "").slice(0, 2000) });
    });
    const rosterEv = () => this.emit("roster", { idx, users: this.roster(idx) });
    client.on("UserState", rosterEv);
    client.on("UserRemove", rosterEv);
    client.on("close", () => this.emit("net-down", { idx }));
    client.on("error", (e) => this.emit("net-error", { idx, error: e.message }));

    await client.connect();
    await new Promise(r => setTimeout(r, 250)); // channel states settle
    const chan = client.channelByName(netCfg.channel || netCfg.name);
    if (chan == null) throw new Error("net channel not found on server: " + (netCfg.channel || netCfg.name));
    net.channelId = chan;
    client.joinChannel(chan);
    this.emit("tuned", { idx, net: netCfg });
    return idx;
  }

  detune(idx) {
    const net = this.nets[idx];
    if (!net) return;
    net.client.disconnect();
    net.dead = true;
  }

  /* Register a voice target that fans out to this net AND every subnet under it.
     Mumble does the fan-out server-side: one transmission, whole nest hears it. */
  armBroadcast(idx) {
    const net = this.nets[idx];
    if (!net || net.dead || net.channelId == null) return false;
    net.client.send("VoiceTarget", { id: 1, targets: [{ channelId: net.channelId, children: true }] });
    net.broadcastArmed = true;
    return true;
  }
  txFrame(idx, opusFrame, last, broadcast) {
    const net = this.nets[idx];
    if (!net || net.dead) return;
    net.client.sendVoice(opusFrame, broadcast && net.broadcastArmed ? 1 : 0, last);
  }

  setMuted(idx, muted) { if (this.nets[idx]) this.nets[idx].muted = muted; }

  roster(idx) {
    const net = this.nets[idx];
    if (!net || net.channelId == null) return [];
    const out = [];
    for (const [sess, u] of net.client.users) {
      if (u.channelId === net.channelId || (u.channelId == null && net.channelId === 0)) {
        out.push({ session: sess, name: this._stripFreq(u.name) });
      }
    }
    return out;
  }

  sendText(idx, message) {
    const net = this.nets[idx];
    if (!net || net.dead || net.channelId == null) return false;
    net.client.text(String(message).slice(0, 2000), [net.channelId]);
    return true;
  }

  /* org-wide view for the ATC board: every channel with its occupants */
  atcView() {
    const c = this._anyClient(); if (!c) return [];
    const chans = [];
    for (const [id, ch] of c.channels) {
      const users = [];
      for (const [, u] of c.users) if (u.channelId === id || (u.channelId == null && id === 0)) users.push(this._stripFreq(u.name));
      chans.push({ id, name: ch.name || "?", parent: ch.parent, users });
    }
    return chans;
  }
  _shortName(client, session) { return this._stripFreq(client.userName(session)); }
  _stripFreq(name) { return String(name).replace(/\|\d{3}\.\d{3}$/, ""); }

  /* any live connection can answer channel questions / create channels */
  _anyClient() { const n = this.nets.find(x => !x.dead); return n ? n.client : null; }
  channelNames() {
    const c = this._anyClient(); if (!c) return [];
    return [...c.channels.values()].map(ch => ch.name).filter(Boolean);
  }
  renameNet(idx, newName) {
    const net = this.nets[idx];
    if (!net || net.dead || net.channelId == null) return false;
    net.client.send("ChannelState", { channelId: net.channelId, name: newName });
    return true;
  }
  moveNet(idx, newParentName) {
    const net = this.nets[idx];
    const c = this._anyClient();
    if (!net || net.dead || !c) return false;
    const parentId = newParentName ? c.channelByName(newParentName) : 0;
    if (parentId == null) return false;
    net.client.send("ChannelState", { channelId: net.channelId, parent: parentId });
    return true;
  }
  removeNet(idx) {
    const net = this.nets[idx];
    if (!net || net.dead || net.channelId == null) return false;
    net.client.send("ChannelRemove", { channelId: net.channelId });
    return true;
  }

  async createNet(name, parentChannelName) {
    const c = this._anyClient(); if (!c) throw new Error("not connected");
    const parentId = c.channelByName(parentChannelName);
    if (parentId == null) throw new Error("parent channel not found: " + parentChannelName);
    return c.createChannel(name, parentId);
  }

  destroy() { this.nets.forEach(n => { try { n.client.disconnect(); } catch (e) {} }); }
}
module.exports = { RadioStack, sanitizeUser };
