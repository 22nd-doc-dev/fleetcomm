"use strict";
/*
 * Gamepad / flight-stick buttons as bindable inputs.
 *
 * The global input hook (uiohook) sees keyboards and mice — a HOTAS button is
 * a different device class it never reports, which is why a stick PTT that
 * worked in QLink did nothing here. Chromium's Gamepad API sees those devices,
 * so the renderer polls it and turns button transitions into the same
 * (src, code, label) events the keybind engine already speaks. No new
 * dependencies, no native code.
 *
 * This module is the pure part: state diffing and naming. The 16ms poll loop
 * lives in the renderer; the decisions live here where they can be tested.
 */

/* Stable identity: gamepads re-enumerate across sessions and USB ports, so a
   bind keyed on the array INDEX would silently detach on replug. Key on the id
   string (device name + vendor/product) instead. Two identical sticks will
   share bindings — which is what an operator with a spare expects. */
function padKey(id) {
  return String(id || "pad").replace(/\s+/g, " ").trim().slice(0, 60);
}

/* Short operator-facing label: "T.16000M B5", not the 70-char Chromium id
   with vendor/product hex in it. */
function padLabel(id, button) {
  const name = String(id || "STICK")
    .replace(/\s*\((Vendor|STANDARD GAMEPAD).*$/i, "")
    .replace(/\s+/g, " ").trim().slice(0, 18) || "STICK";
  return (name + " B" + button).toUpperCase();
}

/* A HOTAS trigger is often analog — count it as pressed past 60% so a
   half-pulled trigger keys the net the way the stick's own software would. */
function pressedStates(gamepadButtons) {
  return (gamepadButtons || []).map(b => !!(b && (b.pressed || b.value > 0.6)));
}

/* Transitions between two polls → down/up events, one per changed button. */
function diffButtons(prev, curr) {
  const events = [];
  const n = Math.max(prev ? prev.length : 0, curr ? curr.length : 0);
  for (let b = 0; b < n; b++) {
    const was = !!(prev && prev[b]), is = !!(curr && curr[b]);
    if (was !== is) events.push({ button: b, down: is });
  }
  return events;
}

module.exports = { padKey, padLabel, pressedStates, diffButtons };
