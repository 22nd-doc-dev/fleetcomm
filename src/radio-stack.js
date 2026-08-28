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
      username, tokens: this.opts.tokens || [],
      cert: this.opts.cert, key: this.opts.key, release: "FleetComm 0.2"
    });
    const net = { cfg: netCfg, client, channelId: null, idx };
    this.nets.push(net);

    client.on("voice", (v) => {
      if (net.muted) return;
      this.emit("rx", { idx, session: v.session, name: this._shortName(client, v.session), opus: v.opus, last: v.last });
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

  txFrame(idx, opusFrame, last) {
    const net = this.nets[idx];
    if (net && !net.dead) net.client.sendVoice(opusFrame, 0, last);
  }

  setMuted(idx, muted) { if (this.nets[idx]) this.nets[idx].muted = muted; }

  roster(idx) {
    const net = this.nets[idx];
    if (!net || net.channelId == null) return [];
    const out = [];
    for (const [, u] of net.client.users) {
      if (u.channelId === net.channelId || (u.channelId == null && net.channelId === 0)) {
        out.push(this._stripFreq(u.name));
      }
    }
    return out;
  }
  _shortName(client, session) { return this._stripFreq(client.userName(session)); }
  _stripFreq(name) { return String(name).replace(/\|\d{3}\.\d{3}$/, ""); }

  /* any live connection can answer channel questions / create channels */
  _anyClient() { const n = this.nets.find(x => !x.dead); return n ? n.client : null; }
  channelNames() {
    const c = this._anyClient(); if (!c) return [];
    return [...c.channels.values()].map(ch => ch.name).filter(Boolean);
  }
  async createNet(name, rootChannelName) {
    const c = this._anyClient(); if (!c) throw new Error("not connected");
    const rootId = c.channelByName(rootChannelName);
    if (rootId == null) throw new Error("org root channel not found");
    return c.createChannel(name, rootId);
  }

  destroy() { this.nets.forEach(n => { try { n.client.disconnect(); } catch (e) {} }); }
}
module.exports = { RadioStack, sanitizeUser };
