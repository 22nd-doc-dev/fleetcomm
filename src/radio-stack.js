"use strict";
/*
 * RadioStack — the FleetComm radio rack model.
 * One lightweight Mumble connection per tuned net ("one receiver per net",
 * like a physical multi-band rack). Gives perfect per-net RX attribution,
 * per-net TX with target 0, and a clean path to per-net channel passwords.
 */
const EventEmitter = require("events");
const { MumbleClient } = require("./mumble-client");
const { decodeMeta, encodeMeta } = require("./net-meta");
const { channelName } = require("./channel-name");

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

    try {
      await client.connect();
      await new Promise(r => setTimeout(r, 250)); // channel states settle
      const relayName = channelName(netCfg.channel || netCfg.name);
      const chan = client.channelByName(relayName);
      if (chan == null) throw new Error("net channel not found on server: " + relayName);
      net.channelId = chan;
      client.joinChannel(chan);
      this.emit("tuned", { idx, net: netCfg });
      return idx;
    } catch (error) {
      net.dead = true;
      try { client.disconnect(); } catch (ignore) {}
      throw error;
    }
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
    let allowed = null;
    if (this.opts.rootChannel) {
      const root = c.channelByName(channelName(this.opts.rootChannel));
      if (root == null) return [];
      allowed = new Set([root]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const [id, channel] of c.channels) {
          if (!allowed.has(id) && allowed.has(channel.parent)) { allowed.add(id); changed = true; }
        }
      }
    }
    const chans = [];
    for (const [id, ch] of c.channels) {
      if (allowed && !allowed.has(id)) continue;
      const users = [];
      for (const [, u] of c.users) if (u.channelId === id || (u.channelId == null && id === 0)) users.push(this._stripFreq(u.name));
      const meta = decodeMeta(ch.description);
      chans.push({ id, name: ch.name || "?", parent: ch.parent, users, freq: meta.freq, ship: meta.ship });
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
  /* ── editing the net tree ──
     These take a channel NAME, not a tuned-net index, and go out over whichever
     connection is live. COMMAND edits the org's tree; needing to tune a net
     before you could rename or re-home it was an artificial restriction, and it
     left most of the right-click menu greyed out for no good reason.
     Each one waits for the relay's answer and reports what actually happened. */
  _resolve(name) {
    const c = this._anyClient(); if (!c) return null;
    const id = c.channelByName(channelName(name));
    return id == null ? null : { c, id };
  }
  _isOrgRoot(name) {
    return !!this.opts.rootChannel && channelName(name) === channelName(this.opts.rootChannel);
  }
  /* keep our own record in step so a tuned net doesn't keep its old label */
  _relabel(oldName, newName) {
    const net = this.nets.find(n => n && !n.dead && n.cfg && n.cfg.name === oldName);
    if (net) net.cfg = Object.assign({}, net.cfg, { name: newName });
  }
  async renameNet(name, newName) {
    if (this._isOrgRoot(name)) return { ok: false, error: "the org root channel is immutable" };
    const r = this._resolve(name);
    if (!r) return { ok: false, error: "not connected to the relay" };
    const relayNewName = channelName(newName);
    const duplicate = r.c.channelByName(relayNewName);
    if (relayNewName !== channelName(name) && duplicate != null) return { ok: false, error: "a net named " + relayNewName + " already exists" };
    try { await r.c.editChannel(r.id, { name: relayNewName }); this._relabel(name, relayNewName); return { ok: true, name: relayNewName }; }
    catch (e) { return { ok: false, error: e.message }; }
  }
  async moveNet(name, newParentName) {
    if (this._isOrgRoot(name)) return { ok: false, error: "the org root channel is immutable" };
    const r = this._resolve(name);
    if (!r) return { ok: false, error: "not connected to the relay" };
    let parentId = this.opts.rootChannel ? r.c.channelByName(channelName(this.opts.rootChannel)) : 0;
    if (parentId == null) return { ok: false, error: "org root channel is missing" };
    if (newParentName) {
      parentId = r.c.channelByName(channelName(newParentName));
      if (parentId == null) return { ok: false, error: "no net named " + newParentName + " on the relay" };
    }
    let cursor = parentId;
    while (cursor != null) {
      if (cursor === r.id) return { ok: false, error: "a net cannot be nested under itself or its descendants" };
      const channel = r.c.channels.get(cursor);
      cursor = channel && channel.parent;
    }
    try { await r.c.editChannel(r.id, { parent: parentId }); return { ok: true }; }
    catch (e) { return { ok: false, error: e.message }; }
  }
  async removeNet(name) {
    if (this._isOrgRoot(name)) return { ok: false, error: "the org root channel is immutable" };
    const r = this._resolve(name);
    if (!r) return { ok: false, error: "not connected to the relay" };
    try { await r.c.removeChannel(r.id); return { ok: true }; }
    catch (e) { return { ok: false, error: e.message }; }
  }

  async setNetMeta(name, meta) {
    if (this._isOrgRoot(name)) return { ok: false, error: "the org root channel metadata is managed by the relay" };
    const r = this._resolve(name);
    if (!r) return { ok: false, error: "not connected to the relay" };
    try { await r.c.editChannel(r.id, { description: encodeMeta(meta) }); return { ok: true }; }
    catch (e) { return { ok: false, error: e.message }; }
  }

  async createNet(name, parentChannelName, meta) {
    const c = this._anyClient(); if (!c) throw new Error("not connected");
    name = channelName(name);
    if (!name) throw new Error("net name is empty");
    if (c.channelByName(name) != null) throw new Error("a net named " + name + " already exists");
    const parentId = c.channelByName(channelName(parentChannelName));
    if (parentId == null) throw new Error("parent channel not found: " + parentChannelName);
    if (this.opts.rootChannel) {
      const rootId = c.channelByName(channelName(this.opts.rootChannel));
      let cursor = parentId, insideOrg = false;
      while (cursor != null) {
        if (cursor === rootId) { insideOrg = true; break; }
        const channel = c.channels.get(cursor);
        cursor = channel && channel.parent;
      }
      if (!insideOrg) throw new Error("parent must be inside the org channel tree");
    }
    return { id: await c.createChannel(name, parentId, encodeMeta(meta)), name };
  }

  destroy() { this.nets.forEach(n => { try { n.client.disconnect(); } catch (e) {} }); }
}
module.exports = { RadioStack, sanitizeUser };
