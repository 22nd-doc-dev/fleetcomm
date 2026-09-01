"use strict";
/* Helmet-cam signaling codec: WebRTC handshakes chunked over Mumble text.
   The contract that matters in the field: chunks stay under the relay's
   message ceiling, interleaved senders can never splice into each other,
   and hostile/garbled input is dropped, never thrown. */
const assert = require("assert");
const { isSignal, encodeChunks, Reassembler, MAGIC, MAX_TOTAL } = require("../src/cam-signal");

const t = (name, fn) => { fn(); console.log("  ✓ " + name); };

t("a small payload rides one chunk and round-trips", () => {
  const chunks = encodeChunks("id1", { t: "who" });
  assert.strictEqual(chunks.length, 1);
  assert.ok(isSignal(chunks[0]));
  const r = new Reassembler();
  assert.deepStrictEqual(r.feed("peerA", chunks[0], 0), { t: "who" });
});

t("an SDP-sized payload splits, every chunk under the ceiling, and reassembles", () => {
  const sdp = "v=0\r\n" + "a=candidate:".padEnd(120, "x").repeat(60);   /* ~7KB, realistic offer */
  const payload = { t: "offer", sdp };
  const chunks = encodeChunks("hs42", payload, 3800);
  assert.ok(chunks.length >= 2 && chunks.length <= 4, "got " + chunks.length + " chunks");
  for (const c of chunks) assert.ok(c.length < 4200, "chunk fits murmur's stock 5000 limit with headroom");
  const r = new Reassembler();
  let out = null;
  for (const c of chunks) out = r.feed("peerB", c, 0) || out;
  assert.deepStrictEqual(out, payload);
});

t("out-of-order and duplicated chunks still assemble exactly once", () => {
  const payload = { t: "answer", sdp: "y".repeat(9000) };
  const chunks = encodeChunks("dup", payload, 3800);
  assert.ok(chunks.length >= 3, "test payload spans several chunks (got " + chunks.length + ")");
  const r = new Reassembler();
  /* reversed order, with the first two chunks fed twice */
  const fed = [...chunks].reverse().concat(chunks[0], chunks[1]);
  const results = fed.map(c => r.feed("peerC", c, 0)).filter(Boolean);
  assert.strictEqual(results.length, 1, "completes exactly once");
  assert.deepStrictEqual(results[0], payload);
});

t("two senders using the SAME handshake id can never splice together", () => {
  const a = encodeChunks("clash", { t: "offer", sdp: "A".repeat(5000) }, 3800);
  const b = encodeChunks("clash", { t: "offer", sdp: "B".repeat(5000) }, 3800);
  const r = new Reassembler();
  assert.strictEqual(r.feed("peerA", a[0], 0), null);
  assert.strictEqual(r.feed("peerB", b[0], 0), null);
  const doneA = r.feed("peerA", a[1], 0);
  const doneB = r.feed("peerB", b[1], 0);
  assert.ok(/^A+$/.test(doneA.sdp) && /^B+$/.test(doneB.sdp), "streams stayed separate");
});

t("a half-received handshake evaporates after the TTL", () => {
  const chunks = encodeChunks("slow", { t: "offer", sdp: "z".repeat(6000) }, 3800);
  const r = new Reassembler({ ttlMs: 1000 });
  r.feed("peerD", chunks[0], 0);
  assert.strictEqual(r.feed("peerD", chunks[1], 5000), null, "stale first half was swept; second half alone can't complete");
});

t("garbage, chat lines, and hostile shapes are dropped without throwing", () => {
  const r = new Reassembler();
  const junk = [
    "1MC — DOC piped General Quarters",          /* real board chat */
    MAGIC,                                        /* bare prefix */
    MAGIC + "id|0/0|",                            /* zero counts */
    MAGIC + "id|3/2|AAAA",                        /* seq past total */
    MAGIC + "id|1/99|AAAA",                       /* total past MAX_TOTAL */
    MAGIC + "../../evil|1/1|!!!!not-base64!!!",   /* id charset + body charset */
    MAGIC + "ok|1/1|" + Buffer.from("not json").toString("base64"),
    null, undefined, 42, {},                      /* not even strings */
  ];
  for (const j of junk) assert.strictEqual(r.feed("peerX", j, 0), null);
});

t("oversized payloads are refused at the door", () => {
  assert.throws(() => encodeChunks("big", { t: "offer", sdp: "x".repeat(3800 * (MAX_TOTAL + 2)) }, 3800),
    /too large/);
});

console.log("✔ CAM SIGNAL PASS — handshakes chunk under the relay ceiling and reassemble only from their own sender");
