"use strict";
/*
 * FleetComm Mumble protocol core.
 * Speaks the Mumble control protocol over TLS (protocol 1.4 = legacy voice
 * framing, channel listeners, voice targets) with voice tunneled over TCP.
 * No Mumble code — just the wire protocol. Works headless (tests, bots,
 * channel seeding) and inside Electron main.
 */
const tls = require("tls");
const fs = require("fs");
const path = require("path");
const EventEmitter = require("events");
const protobuf = require("protobufjs");
const varint = require("./varint");

const MSG = {
  Version: 0, UDPTunnel: 1, Authenticate: 2, Ping: 3, Reject: 4, ServerSync: 5,
  ChannelRemove: 6, ChannelState: 7, UserRemove: 8, UserState: 9, BanList: 10,
  TextMessage: 11, PermissionDenied: 12, ACL: 13, QueryUsers: 14, CryptSetup: 15,
  ContextActionModify: 16, ContextAction: 17, UserList: 18, VoiceTarget: 19,
  PermissionQuery: 20, CodecVersion: 21, UserStats: 22, RequestBlob: 23,
  ServerConfig: 24, SuggestConfig: 25
};
const MSG_NAME = Object.fromEntries(Object.entries(MSG).map(([k, v]) => [v, k]));
const VERSION_1_4_230 = (1 << 16) | (4 << 8) | 230;
const OPUS_TYPE = 4;

class MumbleClient extends EventEmitter {
  constructor(opts) {
    super();
    this.opts = Object.assign({ port: 64738, release: "FleetComm 0.1" }, opts);
    this.channels = new Map();  // id -> ChannelState
    this.users = new Map();     // session -> UserState
    this.session = null;
    this.seq = 0;
    this._buf = Buffer.alloc(0);
    const protoPath = [path.join(__dirname, "proto", "Mumble.proto"), path.join(__dirname, "..", "proto", "Mumble.proto")]
      .find(p => fs.existsSync(p));
    this._root = protobuf.loadSync(protoPath);
    this._types = {};
    for (const name of Object.keys(MSG)) {
      if (name === "UDPTunnel") continue;
      this._types[name] = this._root.lookupType("MumbleProto." + name);
    }
  }

  connect() {
    return new Promise((resolve, reject) => {
      const s = tls.connect(
        { host: this.opts.host, port: this.opts.port, rejectUnauthorized: false,
          cert: this.opts.cert, key: this.opts.key,
          /* murmur requests client certs in a way node's TLS1.3 stack won't answer;
             TLS1.2 exchanges them in-handshake and murmur fully supports it */
          maxVersion: this.opts.cert ? "TLSv1.2" : undefined },
        () => {
          this.send("Version", {
            versionV1: VERSION_1_4_230,
            release: this.opts.release, os: process.platform, osVersion: process.version
          });
          this.send("Authenticate", {
            username: this.opts.username,
            password: this.opts.password || "",
            tokens: this.opts.tokens || [],
            opus: true,
            clientType: 0
          });
        }
      );
      this.sock = s;
      s.on("data", (d) => this._onData(d));
      s.on("error", (e) => { this.emit("error", e); reject(e); });
      s.on("close", () => this.emit("close"));
      this.once("ServerSync", (m) => {
        this.session = m.session;
        this._pinger = setInterval(() => this.send("Ping", { timestamp: Date.now() }), 15000);
        this.emit("ready", m);
        resolve(m);
      });
      this.once("Reject", (m) => reject(new Error("Server rejected: " + (m.reason || m.type))));
    });
  }

  disconnect() {
    clearInterval(this._pinger);
    if (this.sock) this.sock.destroy();
  }

  /* ── control channel ── */
  send(name, payload) {
    const T = this._types[name];
    const body = T.encode(T.fromObject(payload || {})).finish();
    this._raw(MSG[name], body);
  }
  _raw(type, body) {
    const head = Buffer.alloc(6);
    head.writeUInt16BE(type, 0);
    head.writeUInt32BE(body.length, 2);
    this.sock.write(Buffer.concat([head, body]));
  }
  _onData(d) {
    this._buf = Buffer.concat([this._buf, d]);
    while (this._buf.length >= 6) {
      const type = this._buf.readUInt16BE(0);
      const size = this._buf.readUInt32BE(2);
      if (this._buf.length < 6 + size) break;
      const body = this._buf.subarray(6, 6 + size);
      this._buf = this._buf.subarray(6 + size);
      this._dispatch(type, body);
    }
  }
  _dispatch(type, body) {
    if (type === MSG.UDPTunnel) return this._onVoice(body);
    const name = MSG_NAME[type];
    if (!name) return;
    let msg;
    try { msg = this._types[name].toObject(this._types[name].decode(body), { defaults: false }); }
    catch (e) { return; }
    /* state tracking */
    if (name === "ChannelState") {
      const prev = this.channels.get(msg.channelId) || {};
      this.channels.set(msg.channelId, Object.assign(prev, msg));
    } else if (name === "ChannelRemove") {
      this.channels.delete(msg.channelId);
    } else if (name === "UserState") {
      const prev = this.users.get(msg.session) || {};
      this.users.set(msg.session, Object.assign(prev, msg));
    } else if (name === "UserRemove") {
      this.users.delete(msg.session);
    } else if (name === "Ping") {
      /* server echo — ignore */
    }
    this.emit(name, msg);
    this.emit("message", name, msg);
  }

  /* ── voice: legacy framing over the TCP tunnel ── */
  sendVoice(opusFrame, target = 0, last = false) {
    const header = Buffer.from([(OPUS_TYPE << 5) | (target & 0x1F)]);
    const seqB = varint.encode(this.seq++);
    const lenB = varint.encode(opusFrame.length | (last ? 0x2000 : 0));
    this._raw(MSG.UDPTunnel, Buffer.concat([header, seqB, lenB, opusFrame]));
  }
  _onVoice(buf) {
    const type = buf[0] >> 5, context = buf[0] & 0x1F;
    if (type !== OPUS_TYPE) return; // ignore CELT/ping
    let off = 1;
    const sess = varint.decode(buf, off); if (!sess) return; off += sess.length;
    const seq = varint.decode(buf, off); if (!seq) return; off += seq.length;
    const len = varint.decode(buf, off); if (!len) return; off += len.length;
    const size = len.value & 0x1FFF, last = !!(len.value & 0x2000);
    const opus = buf.subarray(off, off + size);
    this.emit("voice", { session: sess.value, sequence: seq.value, opus, context, last });
  }

  /* ── conveniences ── */
  joinChannel(channelId) { this.send("UserState", { session: this.session, channelId }); }
  listen(channelIds) { this.send("UserState", { session: this.session, listeningChannelAdd: channelIds }); }
  unlisten(channelIds) { this.send("UserState", { session: this.session, listeningChannelRemove: channelIds }); }
  setVoiceTarget(id, channelId) { this.send("VoiceTarget", { id, targets: [{ channelId }] }); }
  setSelfMuteDeaf(mute, deaf) { this.send("UserState", { session: this.session, selfMute: mute, selfDeaf: deaf }); }
  setComment(comment) { this.send("UserState", { session: this.session, comment }); }
  text(message, channelIds) { this.send("TextMessage", { message, channelId: channelIds }); }

  createChannel(name, parent = 0, description = "") {
    return new Promise((resolve, reject) => {
      const onState = (m) => {
        if (m.name === name && m.parent === parent) { cleanup(); resolve(m.channelId); }
      };
      const onDenied = (m) => { cleanup(); reject(new Error("PermissionDenied type=" + m.type)); };
      const cleanup = () => { this.off("ChannelState", onState); this.off("PermissionDenied", onDenied); };
      this.on("ChannelState", onState);
      this.on("PermissionDenied", onDenied);
      this.send("ChannelState", { parent, name, description });
      setTimeout(() => { cleanup(); reject(new Error("timeout creating " + name)); }, 5000);
    });
  }
  channelByName(name) {
    for (const [id, c] of this.channels) if (c.name === name) return id;
    return null;
  }
  userName(session) {
    const u = this.users.get(session);
    return u ? u.name : "session " + session;
  }
}
module.exports = { MumbleClient, MSG };
