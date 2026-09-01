"use strict";
/* The radio-effect dial's contract: the three shipped presets are EXACT
   anchors — a profile that never touches the slider must sound identical to
   pre-1.0.1 — and everything between them moves smoothly and monotonically. */
const assert = require("assert");
const { paramsAt, anchorValue, presetAt, clamp01 } = require("../src/fx-curve");

const t = (name, fn) => { fn(); console.log("  ✓ " + name); };

/* the legacy FXP table, verbatim, from renderer/app.js as shipped in 1.0.0 */
const LEGACY = {
  clean:    { hp: 250, lp: 3400, stages: 1, drive: 0,    comp: null, noise: 0,     tail: 0 },
  standard: { hp: 300, lp: 3000, stages: 2, drive: 0.35, comp: { th: -28, ratio: 8,  atk: 0.003, rel: 0.12 }, noise: 0.006, tail: 0.05 },
  heavy:    { hp: 400, lp: 2700, stages: 2, drive: 0.8,  comp: { th: -32, ratio: 12, atk: 0.002, rel: 0.10 }, noise: 0.015, tail: 0.09 }
};

t("anchors reproduce the legacy presets exactly", () => {
  assert.deepStrictEqual(paramsAt(0), LEGACY.clean);
  assert.deepStrictEqual(paramsAt(0.5), LEGACY.standard);
  assert.deepStrictEqual(paramsAt(1), LEGACY.heavy);
});

t("anchorValue and presetAt agree with the anchors", () => {
  assert.strictEqual(anchorValue("clean"), 0);
  assert.strictEqual(anchorValue("standard"), 50);
  assert.strictEqual(anchorValue("heavy"), 100);
  assert.strictEqual(anchorValue("nonsense"), 50, "unknown preset lands on standard");
  assert.strictEqual(presetAt(0), "clean");
  assert.strictEqual(presetAt(50), "standard");
  assert.strictEqual(presetAt(100), "heavy");
  assert.strictEqual(presetAt(73), null);
});

t("the band narrows and the drive rises monotonically across the dial", () => {
  let prev = paramsAt(0);
  for (let i = 1; i <= 100; i++) {
    const p = paramsAt(i / 100);
    assert.ok(p.hp >= prev.hp, "hp climbs at " + i);
    assert.ok(p.lp <= prev.lp, "lp falls at " + i);
    assert.ok(p.drive >= prev.drive, "drive climbs at " + i);
    assert.ok(p.tail >= prev.tail, "tail climbs at " + i);
    prev = p;
  }
});

t("the compressor exists everywhere above zero and fades in by ratio", () => {
  assert.strictEqual(paramsAt(0).comp, null, "clean has no compressor");
  const gentle = paramsAt(0.05);
  assert.ok(gentle.comp && gentle.comp.ratio > 1 && gentle.comp.ratio < 3,
    "just off clean the ratio is near-transparent, got " + (gentle.comp && gentle.comp.ratio));
  assert.ok(paramsAt(0.75).comp.ratio > 8 && paramsAt(0.75).comp.ratio < 12);
});

t("stage count is always an integer and matches the anchors", () => {
  for (let i = 0; i <= 100; i++) {
    const s = paramsAt(i / 100).stages;
    assert.ok(s === 1 || s === 2, "stages 1 or 2 at " + i);
  }
  assert.strictEqual(paramsAt(0).stages, 1);
  assert.strictEqual(paramsAt(0.5).stages, 2);
});

t("corrupted storage cannot poison an AudioParam", () => {
  assert.strictEqual(clamp01(NaN), 0.5);
  assert.strictEqual(clamp01("bogus"), 0.5);
  assert.strictEqual(clamp01(-3), 0);
  assert.strictEqual(clamp01(7), 1);
  const p = paramsAt(Infinity);
  assert.ok(isFinite(p.hp) && isFinite(p.drive), "params stay finite");
});

console.log("✔ FX CURVE PASS — presets are exact anchors on one continuous, finite dial");
