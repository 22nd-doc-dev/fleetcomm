"use strict";
/* The radio-voice character as a CONTINUOUS dial.
   The three shipped presets are anchors on one intensity axis:
     0   = clean    (1-stage 250–3400 band-pass, no drive, no comp, no tail)
     50  = standard
     100 = heavy
   paramsAt(t) reproduces the legacy FXP table EXACTLY at the anchors — an
   operator who never touches the slider hears the same radio they always have —
   and interpolates smoothly between them. Kept pure so the anchor contract is
   unit-testable without an AudioContext.

   Between clean and standard the compressor fades in by RATIO (1:1 is
   transparent) rather than popping into existence at the midpoint; the stage
   count steps 1→2 early (t≥12.5) where the band is still wide enough that the
   steeper slope reads as "slightly tighter", not a jump. The noise field is
   carried for chain-shape compatibility (wireChain wires it at gain 0 — the
   audible hiss is the squelch tail, not the bed). */

const ANCHORS = [
  { t: 0,   hp: 250, lp: 3400, stages: 1, drive: 0,    comp: null,                                            noise: 0,     tail: 0 },
  { t: 0.5, hp: 300, lp: 3000, stages: 2, drive: 0.35, comp: { th: -28, ratio: 8,  atk: 0.003, rel: 0.12 },  noise: 0.006, tail: 0.05 },
  { t: 1,   hp: 400, lp: 2700, stages: 2, drive: 0.8,  comp: { th: -32, ratio: 12, atk: 0.002, rel: 0.10 },  noise: 0.015, tail: 0.09 }
];

const PRESET_T = { clean: 0, standard: 0.5, heavy: 1 };

function clamp01(t) {
  t = Number(t);
  if (!isFinite(t)) return 0.5;          /* corrupted storage lands on standard */
  return Math.max(0, Math.min(1, t));
}

function lerp(a, b, u) { return a + (b - a) * u; }

function paramsAt(t) {
  t = clamp01(t);
  const lo = t <= 0.5 ? ANCHORS[0] : ANCHORS[1];
  const hi = t <= 0.5 ? ANCHORS[1] : ANCHORS[2];
  const u = (t - lo.t) / (hi.t - lo.t || 1);
  const p = {
    hp: lerp(lo.hp, hi.hp, u),
    lp: lerp(lo.lp, hi.lp, u),
    /* integer stage count: clean's single stage holds only near zero */
    stages: t < 0.125 ? 1 : 2,
    drive: lerp(lo.drive, hi.drive, u),
    noise: lerp(lo.noise, hi.noise, u),
    tail: lerp(lo.tail, hi.tail, u),
    comp: null
  };
  if (t > 0) {
    if (t <= 0.5) {
      /* fade the compressor in by ratio — 1:1 at the clean end is transparent */
      const s = ANCHORS[1].comp;
      p.comp = { th: s.th, ratio: lerp(1, s.ratio, u), atk: s.atk, rel: s.rel };
    } else {
      const s = ANCHORS[1].comp, h = ANCHORS[2].comp;
      p.comp = { th: lerp(s.th, h.th, u), ratio: lerp(s.ratio, h.ratio, u),
        atk: lerp(s.atk, h.atk, u), rel: lerp(s.rel, h.rel, u) };
    }
  }
  return p;
}

/* preset name → slider value (0–100); unknown names land on standard */
function anchorValue(preset) {
  const t = PRESET_T[preset];
  return (t == null ? 0.5 : t) * 100;
}

/* slider value (0–100) → preset name when it sits exactly on an anchor */
function presetAt(value) {
  const v = Number(value);
  if (v === 0) return "clean";
  if (v === 50) return "standard";
  if (v === 100) return "heavy";
  return null;
}

module.exports = { paramsAt, anchorValue, presetAt, clamp01, ANCHORS };
