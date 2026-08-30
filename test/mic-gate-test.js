"use strict";
/* The transmit gate — what stops your speakers riding out over the net.
 *
 * Echo cancellation only gets you most of the way. What leaks through is quiet
 * speaker bleed, transmitted under everyone else's voice, and on a multi-net
 * radio that is what turns a conversation into an echo chamber. The gate sends
 * silence below a threshold, opens instantly on speech so word onsets survive,
 * and holds open briefly so word endings do too.
 *
 * This is the exact arithmetic from the capture path in renderer/app.js.
 */
const assert = require("assert");
let k = 0; const ok = (m) => console.log("  ✓ " + m, ++k);

const FRAME = 960;
function tone(amp) {
  const f = new Float32Array(FRAME);
  for (let i = 0; i < FRAME; i++) f[i] = Math.sin(i / 48000 * 2 * Math.PI * 300) * amp;
  return f;
}
/* mirrors the renderer: rms → hold → gate */
function makeGate(threshold) {
  let hold = 0;
  return function frame(f32) {
    let sum = 0;
    for (let i = 0; i < f32.length; i++) sum += f32[i] * f32[i];
    const rms = Math.sqrt(sum / f32.length);
    if (rms >= threshold) hold = 12; else if (hold > 0) hold--;
    const open = threshold <= 0 || hold > 0;
    return { open, rms };
  };
}
const G = 0.012;                                  /* the shipped default */

/* ── speech passes, quiet bleed does not ── */
{
  const g = makeGate(G);
  assert(g(tone(0.25)).open, "normal speech opens the gate");
  assert(g(tone(0.05)).open, "quiet speech still passes once open");
  const g2 = makeGate(G);
  assert(!g2(tone(0.004)).open, "speaker bleed at -48dBFS is held back");
  assert(!g2(new Float32Array(FRAME)).open, "silence is held back");
  ok("speech transmits; room and speaker bleed do not");
}

/* ── opens on the FIRST frame of speech: no clipped word onsets ── */
{
  const g = makeGate(G);
  assert.strictEqual(g(tone(0.3)).open, true, "must open on the very first loud frame");
  ok("opens on the first frame — word onsets are not chopped");
}

/* ── holds through the natural dips inside a word ── */
{
  const g = makeGate(G);
  g(tone(0.3));
  let heldThrough = true;
  for (let i = 0; i < 10; i++) if (!g(tone(0.001)).open) heldThrough = false;
  assert(heldThrough, "a short dip mid-word must not close the gate");
  ok("holds through dips inside a word");
}

/* ── but closes after a real pause ── */
{
  const g = makeGate(G);
  g(tone(0.3));
  let closedAt = -1;
  for (let i = 0; i < 30; i++) if (!g(tone(0.0005)).open) { closedAt = i; break; }
  assert(closedAt > 0, "the gate must close once speech stops");
  const ms = (closedAt + 1) * 20;
  assert(ms >= 120 && ms <= 400, "closes after " + ms + "ms — long enough for word endings, short enough to matter");
  ok("closes ~" + ms + "ms after speech stops");
}

/* ── zero disables it entirely, for anyone who wants that ── */
{
  const g = makeGate(0);
  assert(g(new Float32Array(FRAME)).open, "threshold 0 means the gate never closes");
  ok("a threshold of zero disables the gate");
}

/* ── the shipped default sits between bleed and speech ── */
{
  const bleed = makeGate(G)(tone(0.004)).rms;
  const speech = makeGate(G)(tone(0.2)).rms;
  assert(bleed < G && speech > G,
    "default " + G + " must sit between bleed (" + bleed.toFixed(4) + ") and speech (" + speech.toFixed(3) + ")");
  ok("the default threshold separates bleed from speech");
}

console.log("\n✔ MIC GATE PASS — the room stays off the net, speech gets through intact");
process.exit(0);
