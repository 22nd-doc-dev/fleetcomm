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

  /* Slots are REUSED once dead. Every reconnect attempt comes back through
     tune(), and pushing a fresh entry per attempt grew this.nets without bound
     during a long relay outage — past the 0-255 idx clamp in main's IPC
     handlers, at which point healed nets keyed up and transmitted nothing.
     Same failure the control slot already guards against; this is the
     regular-net half. The control slot itself is never handed out. */
  _allocSlot(net) {
    const deadSlot = this.nets.findIndex(n => n && n.dead && !n.control);
    if (deadSlot >= 0) { net.idx = deadSlot; this.nets[deadSlot] = net; }
    else { net.idx = this.nets.length; this.nets.push(net); }
    return net.idx;
  }

  /* ── dial governor ──
     Every connection to the relay asks permission first. Sign-in, per-net
     relinks and the control relink are independent loops; without a shared
     budget their combined cadence can trip (and then permanently re-arm)
     murmur's per-IP autoban. A refused acquire throws BEFORE any socket
     exists, so held-back retries cost the relay nothing. */
  async _gate() {
    const gov = this.opts.governor;
    if (!gov) return;
    const gate = gov.acquire();
    if (!gate.ok) {
      const s = Math.ceil(gate.retryInMs / 1000);
      throw new Error(gate.reason === "ban-hold"
        ? "relay hold — the relay was rate-limiting this network; dialing is paused " + s + "s so the ban can lift"
        : "relay hold — connection budget spent; next dial in " + s + "s");
    }
    if (gate.waitMs > 0) await new Promise(r => setTimeout(r, gate.waitMs));
  }
  /* murmur's autoban drops at accept, BEFORE auth — no Reject is ever sent, so
     the ban signature is a pre-auth reset and nothing else distinguishes it */
  _dialOutcome(error) {
    const gov = this.opts.governor;
    if (!gov) return;
    if (!error) { gov.outcome("ok"); return; }
    const banScented = /ECONNRESET|EPIPE|socket hang up|disconnected before secure|closed during handshake/i
      .test(String(error.message || error));
    const trip = gov.outcome(banScented ? "reset" : "other");
    if (trip) this.emit("dial-hold", { heldForMs: trip.heldForMs });
  }

  async tune(netCfg) {
    await this._gate();
    /* the paced wait in _gate can outlive this stack: a DISCONNECT (or a
       superseding sign-in) mid-wait used to let the dial go through anyway,
       leaving a ghost connection kept alive by the 5s pinger with no UI
       able to reach it */
    if (this.destroyed) throw new Error("stack destroyed — dial abandoned");
    const username = sanitizeUser(this.opts.callsign) + "|" + netCfg.freq;
    const client = new MumbleClient({
      host: this.opts.host, port: this.opts.port,
      username, tokens: this.opts.tokens || [], password: this.opts.password || "",
      cert: this.opts.cert, key: this.opts.key, release: "FleetComm",
      /* every net shares one pinned relay certificate */
      pin: this.opts.pin || "", onPin: this.opts.onPin
    });
    const net = { cfg: netCfg, client, channelId: null, idx: -1 };
    const idx = this._allocSlot(net);

    let accepted = false;
    try {
      await client.connect();
      accepted = true; this._dialOutcome(null);   /* the relay accepted this address */
      if (this.destroyed || net.dead) throw new Error("stack destroyed — dial abandoned");

      /* Handlers attach only AFTER a successful dial — a refused dial reports
         through the rejection below and nowhere else. Attached earlier, one
         refusal surfaced three ways (net-error, net-down, AND the throw),
         because the socket's close lands before the catch can mark the slot.
         connectControl has always done it this way; tune now matches.
         Every handler still checks net.dead — once a slot is reusable, a late
         event from its previous occupant must not speak with the new idx. */
      client.on("voice", (v) => {
        if (net.muted || net.dead) return;
        /* A ship group listens to several channels on one connection, so "which
           net was that?" can't come from the connection — it comes from where the
           speaker is standing. Resolve it per packet and pass it up. */
        this.emit("rx", { idx, session: v.session, name: this._shortName(client, v.session),
                          chan: this._channelOf(client, v.session), opus: v.opus, last: v.last });
      });
      client.on("TextMessage", (m) => {
        if (net.dead) return;
        const from = this._shortName(client, m.actor);
        this.emit("chat", { idx, from, message: String(m.message || "").slice(0, 2000) });
      });
      const rosterEv = () => { if (!net.dead) this.emit("roster", { idx, users: this.roster(idx) }); };
      client.on("UserState", rosterEv);
      client.on("UserRemove", rosterEv);
      client.on("close", () => {
        if (net.dead) return;
        /* the connection is gone, so the slot is too — marking it dead here is
           what frees it for reuse and stops _anyClient() from routing relay
           questions through a destroyed socket (the control link learned this
           the hard way; regular nets had the same hole) */
        net.dead = true;
        this.emit("net-down", { idx });
      });
      client.on("error", (e) => { if (!net.dead) this.emit("net-error", { idx, error: e.message }); });
      await new Promise(r => setTimeout(r, 250)); // channel states settle
      const relayName = channelName(netCfg.channel || netCfg.name);
      const chan = client.channelByName(relayName);
      if (chan == null) throw new Error("net channel not found on server: " + relayName);
      net.channelId = chan;
      /* confirm we really landed, so a net an operator may not enter reports as
         refused instead of pretending to be tuned */
      try {
        await client.joinChannelAcked(chan);
      } catch (denied) {
        /* Only a genuine refusal may be worded as one — the renderer abandons
           a net's relink permanently on "don't have access". A socket that
           died mid-join or a lost/late ack is a link problem: rethrow it
           unwrapped so the relink loop keeps working. */
        if (!/PermissionDenied/i.test(denied.message)) throw denied;
        throw new Error("you don't have access to " + (netCfg.name || relayName) + " — " + denied.message);
      }
      /* the link can drop in the window between the join ack and the renderer
         learning idx — returning success here would paint a dead net tuned */
      if (this.destroyed || net.dead) throw new Error("link dropped while tuning " + (netCfg.name || relayName));
      this.emit("tuned", { idx, net: netCfg });
      return idx;
    } catch (error) {
      /* only DIAL failures feed the governor — and never a teardown this app
         inflicted on itself (destroy/detune mid-dial), which rejects with the
         same handshake-close signature a real ban has */
      if (!accepted && !net.dead && !this.destroyed) this._dialOutcome(error);
      net.dead = true;
      try { client.disconnect(); } catch (ignore) {}
      throw error;
    }
  }

  /* ── ship groups ──
     A ship is a group of nets, not a place you sit. LSN ALL hears every net
     under it and TX ALL reaches every net under it, WITHOUT tuning any of them:
     receive uses Mumble channel listeners, transmit uses a voice target with
     children. Both ride the single connection this group already holds, which
     is also why a ship costs one connection instead of one per subnet. */
  _channelOf(client, session) {
    const u = client.users.get(session);
    if (!u || u.channelId == null) return null;
    const ch = client.channels.get(u.channelId);
    return ch && ch.name ? ch.name : null;
  }
  /* Listen to every named channel (subnets of a ship). Returns how many resolved. */
  listenAll(idx, names) {
    const net = this.nets[idx];
    if (!net || net.dead) return 0;
    const ids = [];
    for (const n of names || []) {
      const id = net.client.channelByName(channelName(n));
      if (id != null && id !== net.channelId) ids.push(id);
    }
    if (!ids.length) return 0;
    net.client.listen(ids);
    net.listening = ids.slice();
    return ids.length;
  }
  unlistenAll(idx) {
    const net = this.nets[idx];
    if (!net || net.dead || !net.listening || !net.listening.length) return false;
    net.client.unlisten(net.listening);
    net.listening = [];
    return true;
  }

  /* ── control connection ──
     Operators now arrive tuned to NOTHING, which is the right default — you
     should not be dropped onto live nets you didn't choose. But every relay
     feature that isn't voice (the ATC board, creating and editing nets,
     resolving a ship's subnets for LSN ALL) needs *a* connection to ask
     questions through. So one silent connection sits in the org root: it is
     muted and deafened, carries no audio either way, and is never exposed as a
     net. It replaces the several auto-tuned connections that used to open on
     sign-in, so this is fewer connections than before, not more. */
  async connectControl(rootChannelName) {
    await this._gate();
    if (this.destroyed) throw new Error("stack destroyed — dial abandoned");
    const client = new MumbleClient({
      host: this.opts.host, port: this.opts.port,
      username: sanitizeUser(this.opts.callsign) + "|ctl",
      tokens: this.opts.tokens || [], password: this.opts.password || "",
      cert: this.opts.cert, key: this.opts.key, release: "FleetComm",
      pin: this.opts.pin || "", onPin: this.opts.onPin
    });
    /* Reconnects REUSE the control slot. Pushing a fresh entry per attempt let
       a long relay outage grow this.nets without bound (~112 dead entries an
       hour at the relink cadence); once nets.length passed the 0-255 idx clamp
       in main's IPC handlers, newly tuned nets keyed up and transmitted
       nothing. One control connection, one slot, forever. */
    const existing = this.nets.find(n => n && n.control);
    const idx = existing ? existing.idx : this.nets.length;
    const net = existing || { cfg: { name: "\u0000control", freq: "" }, client: null, channelId: null, idx,
                              control: true, muted: true };
    net.client = client; net.dead = false; net.channelId = null;
    if (!existing) this.nets.push(net);
    let accepted = false;
    try {
      await client.connect();
      accepted = true; this._dialOutcome(null);
      if (this.destroyed || net.dead) throw new Error("stack destroyed — dial abandoned");
      await new Promise(r => setTimeout(r, 250));
      client.setSelfMuteDeaf(true, true);       /* carries nothing, hears nothing */
      if (rootChannelName) {
        const id = client.channelByName(channelName(rootChannelName));
        if (id != null) { net.channelId = id; client.joinChannel(id); }
      }
      /* The control link must be watched like any net. Unmonitored, a dropped
         control socket stayed marked live, so _anyClient() kept routing every
         relay question (ATC board, net editing, subnet resolution) through a
         destroyed socket — forever, silently. Attached only after a successful
         connect so a failed dial reports through the throw below, not twice. */
      client.on("close", () => {
        /* ignore teardown, and ignore a stale close from a client this slot
           has already been relinked past */
        if (net.dead || net.client !== client) return;
        net.dead = true;
        this.emit("control-down", { idx });
      });
      client.on("error", () => {});             /* surfaced via close */
      return idx;
    } catch (error) {
      if (!accepted && !net.dead && !this.destroyed) this._dialOutcome(error);
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

  /* nets an operator actually tuned — the control connection is not one */
  tunedCount() { return this.nets.filter(n => n && !n.dead && !n.control).length; }

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

  /* dead is set BEFORE the sockets close, so teardown never masquerades as a
     link drop and triggers a reconnect of a stack the operator just left.
     `destroyed` also stops any dial still waiting in _gate's pacing — without
     it, that dial completed into the abandoned stack and lived on as a ghost
     connection no UI control could reach. */
  destroy() {
    this.destroyed = true;
    this.nets.forEach(n => { n.dead = true; try { n.client.disconnect(); } catch (e) {} });
  }
}
module.exports = { RadioStack, sanitizeUser };
