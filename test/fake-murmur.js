"use strict";
/* A disposable fake Mumble relay for the UI smoke test — no mumble-server
 * needed, so the smoke test runs on ANY dev machine.
 *
 *   node test/fake-murmur.js          # listens on 127.0.0.1:64738
 *   FLEETCOMM_AUTOTEST=127.0.0.1 npx electron . --enable-logging
 *
 * Speaks just enough of the control protocol for the autotest rig: answers
 * Authenticate with the shipped org tree + ServerSync, echoes Ping, UserState
 * (joins/listens) and TextMessage. Voice, ACLs and channel edits are ignored —
 * the rig's edit checks report the refusal honestly, which is itself a path
 * worth exercising. Loopback is exempt from certificate pinning, same as the
 * relay suites.
 */
const path = require("path");
const tls = require("tls");
const protobuf = require("protobufjs");
const selfsigned = require("selfsigned");
const config = require(path.join(__dirname, "..", "config", "22nd-package.json"));

const MSG = { Version: 0, Authenticate: 2, Ping: 3, ServerSync: 5, ChannelState: 7, UserState: 9, TextMessage: 11 };
const root = protobuf.loadSync(path.join(__dirname, "..", "proto", "Mumble.proto"));
const T = (n) => root.lookupType("MumbleProto." + n);
function frame(type, name, payload) {
  const body = T(name).encode(T(name).fromObject(payload)).finish();
  const head = Buffer.alloc(6);
  head.writeUInt16BE(type, 0); head.writeUInt32BE(body.length, 2);
  return Buffer.concat([head, body]);
}
/* the real org tree from the shipped package, so the rig finds its nets */
const channels = [{ id: 0, parent: null, name: "Root" }, { id: 1, parent: 0, name: config.rootChannel }];
let nextId = 2;
const add = (net, parent) => {
  const id = nextId++;
  channels.push({ id, parent, name: String(net.name || "").trim().replace(/[^ \-=\w#\[\]{}()@|]/g, "-").slice(0, 120) });
  for (const sub of net.subnets || []) add(sub, id);
};
for (const net of config.nets) add(net, 1);

/* ── optional autoban, mimicking murmur's per-IP guard ──
 *   FAKEMURMUR_AUTOBAN="attempts,timeframeSec,banSec"   e.g. "10,120,300"
 * murmur counts connection ATTEMPTS in a rolling window and, once tripped,
 * drops the TCP connection at accept time — before TLS — which the client
 * sees as ECONNRESET mid-handshake. Reproducing that here lets the client's
 * back-off be TESTED against the guard instead of reasoned about. */
const AB = (process.env.FAKEMURMUR_AUTOBAN || "").split(",").map(Number);
const autoban = AB.length === 3 && AB.every(n => n > 0)
  ? { attempts: AB[0], timeframeMs: AB[1] * 1000, banMs: AB[2] * 1000, log: [], bannedUntil: 0, trips: 0 }
  : null;
function banCheck() {                       /* true = drop this connection */
  if (!autoban) return false;
  const now = Date.now();
  if (now < autoban.bannedUntil) return true;   /* fixed-duration ban, murmur-style */
  autoban.log = autoban.log.filter(t => now - t < autoban.timeframeMs);
  autoban.log.push(now);
  /* strict >, like murmur: autobanAttempts=10 trips on the 11th connection */
  if (autoban.log.length > autoban.attempts) {
    autoban.bannedUntil = now + autoban.banMs;
    autoban.trips++; autoban.log = [];
    console.log("[fake-murmur] AUTOBAN TRIPPED #" + autoban.trips + " (" + autoban.attempts +
      " attempts inside " + (autoban.timeframeMs / 1000) + "s) — banned for " + (autoban.banMs / 1000) + "s");
    return true;
  }
  return false;
}

let session = 0;
const clients = new Set();
(async () => {
  const pems = await selfsigned.generate([{ name: "commonName", value: "fake-murmur" }], { days: 1, keySize: 2048 });
  /* FAKEMURMUR_MUTE_AFTER_MS: after ServerSync, go silent on that connection
     (keep the socket open, answer nothing — a black-holed path, as seen from
     the client). Exercises the client's dead-link detection. */
  const muteAfter = Number(process.env.FAKEMURMUR_MUTE_AFTER_MS || 0);
  const server = tls.createServer({ key: pems.private, cert: pems.cert }, (s) => {
    const me = { s, session: ++session, name: "?" };
    clients.add(me);
    s.on("close", () => clients.delete(me));
    s.on("error", () => {});
    let buf = Buffer.alloc(0);
    s.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 6) {
        const type = buf.readUInt16BE(0), size = buf.readUInt32BE(2);
        if (buf.length < 6 + size) break;
        const body = buf.subarray(6, 6 + size);
        buf = buf.subarray(6 + size);
        try {
          if (me.muted) continue;
          if (type === MSG.Authenticate) {
            me.name = T("Authenticate").toObject(T("Authenticate").decode(body)).username || "?";
            s.write(frame(MSG.Version, "Version", { versionV1: (1 << 16) | (4 << 8) | 230 }));
            for (const c of channels) s.write(frame(MSG.ChannelState, "ChannelState",
              Object.assign({ channelId: c.id, name: c.name }, c.parent == null ? {} : { parent: c.parent })));
            for (const c of clients) s.write(frame(MSG.UserState, "UserState", { session: c.session, name: c.name, channelId: 0 }));
            s.write(frame(MSG.ServerSync, "ServerSync", { session: me.session, welcomeText: "fake" }));
            if (muteAfter > 0) setTimeout(() => { me.muted = true; }, muteAfter);
          } else if (type === MSG.Ping) {
            s.write(frame(MSG.Ping, "Ping", {}));
          } else if (type === MSG.UserState) {
            const m = T("UserState").toObject(T("UserState").decode(body));
            const echo = Object.assign({}, m, { session: me.session, name: me.name });
            for (const c of clients) c.s.write(frame(MSG.UserState, "UserState", echo));
          } else if (type === MSG.TextMessage) {
            const m = T("TextMessage").toObject(T("TextMessage").decode(body));
            for (const c of clients) if (c !== me) c.s.write(frame(MSG.TextMessage, "TextMessage", Object.assign({}, m, { actor: me.session })));
          }
        } catch (e) { /* malformed test traffic — ignore */ }
      }
    });
  });
  /* the ban drops raw TCP before the TLS handshake, exactly like murmur */
  server.on("connection", (raw) => { if (banCheck()) raw.destroy(); });
  /* FAKEMURMUR_PORT=0 asks the OS for a free port — the ready line always
     names the real one, so parallel test runs never fight over a socket */
  const port = Number(process.env.FAKEMURMUR_PORT || 64738);
  server.listen(port, "127.0.0.1", () => console.log("fake murmur ready on 127.0.0.1:" + server.address().port +
    (autoban ? " (autoban " + AB.join("/") + ")" : "") + " — ctrl-c to stop"));
})();
