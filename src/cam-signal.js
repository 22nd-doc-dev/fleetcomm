"use strict";
/* Helmet-cam signaling codec.
   WebRTC handshakes (SDP blobs, a few KB) ride the relay as session-targeted
   Mumble text messages on the silent control connection — zero new sockets,
   zero droplet cost, and the dial governor never hears about it. murmur caps
   text messages (stock textmessagelength=5000) and rate-limits senders
   (murmur 1.4+ defaults ≈1 msg/s, burst 5), so a payload is split into few,
   small, base64 chunks and the sender paces them.

   Wire form of one chunk:
     ~FCAM1|<id>|<seq>/<total>|<base64>
   The ~FCAM1 prefix keeps a stray board-chat line from ever parsing as a
   handshake, and vice versa: the control connection drops non-prefixed text.
   Pure module — no timers, no sockets — so the chunk/reassembly contract is
   unit-testable. Callers supply ids and timestamps. */

const MAGIC = "~FCAM1|";
/* chunk budget: 5000-byte stock murmur limit, minus header room, with slack
   for servers configured tighter. Two chunks carry a typical H.264 offer. */
const CHUNK = 3800;
const MAX_TOTAL = 12;            /* nothing legitimate needs more (~45KB) */

function isSignal(message) {
  return typeof message === "string" && message.startsWith(MAGIC);
}

/* payload (JSON-able) → array of wire chunks */
function encodeChunks(id, payload, maxLen) {
  const size = Math.max(200, (maxLen || CHUNK));
  const b64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  const total = Math.ceil(b64.length / size) || 1;
  if (total > MAX_TOTAL) throw new Error("signal payload too large (" + b64.length + "b64)");
  const out = [];
  for (let seq = 0; seq < total; seq++) {
    out.push(MAGIC + id + "|" + (seq + 1) + "/" + total + "|" + b64.slice(seq * size, (seq + 1) * size));
  }
  return out;
}

/* Reassembles interleaved chunk streams from many peers. Keyed by
   sender+id so two peers reusing an id can never splice into each other. */
class Reassembler {
  constructor(opts) {
    this.ttlMs = (opts && opts.ttlMs) || 30000;
    this.pending = new Map();
  }
  /* feed(fromKey, message, nowMs) → decoded payload object when a set
     completes, else null. Malformed input is dropped, never thrown. */
  feed(fromKey, message, nowMs) {
    const now = nowMs || 0;
    this.sweep(now);
    if (!isSignal(message)) return null;
    const body = message.slice(MAGIC.length);
    const m = /^([\w-]{1,32})\|(\d{1,2})\/(\d{1,2})\|([A-Za-z0-9+/=]*)$/.exec(body);
    if (!m) return null;
    const id = m[1], seq = +m[2], total = +m[3], data = m[4];
    if (!seq || !total || seq > total || total > MAX_TOTAL) return null;
    const key = String(fromKey) + "#" + id;
    let entry = this.pending.get(key);
    if (!entry || entry.total !== total) {
      entry = { total, parts: new Array(total).fill(null), got: 0, at: now };
      this.pending.set(key, entry);
    }
    if (entry.parts[seq - 1] === null) entry.got++;
    entry.parts[seq - 1] = data;
    entry.at = now;
    if (entry.got < total) return null;
    this.pending.delete(key);
    try {
      return JSON.parse(Buffer.from(entry.parts.join(""), "base64").toString("utf8"));
    } catch (e) { return null; }
  }
  sweep(now) {
    for (const [key, entry] of this.pending) {
      if (now - entry.at > this.ttlMs) this.pending.delete(key);
    }
  }
}

module.exports = { isSignal, encodeChunks, Reassembler, MAGIC, CHUNK, MAX_TOTAL };
