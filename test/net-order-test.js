"use strict";
/* Client-side ordering: operators arrange their own board without touching the
   relay, and a net can never be dragged out of its nest. */
const assert = require("assert");
const { buildTree, applyOrder, canReorder, reorder, mergeOrder } = require("../src/net-tree");

let k = 0; const ok = (m) => console.log("  ✓ " + m, ++k);
const N = (name, parent) => ({ name, parent: parent || null });
const order = (nets, ord) => buildTree(nets, {}, ord).rows.map(r => nets[r.i].name);

const FLEET = [N("COMMAND NET"), N("MEDICAL"), N("UEES TIBER"), N("BRIDGE", "UEES TIBER"),
               N("DECK", "UEES TIBER"), N("UEENS MINERVA"), N("M BRIDGE", "UEENS MINERVA")];

/* ── the case Andy described: push the ship you never fly to the bottom ── */
{
  const ord = mergeOrder([], reorder(FLEET, [], "UEES TIBER", "UEENS MINERVA") || []);
  const shown = order(FLEET, ord);
  assert(shown.indexOf("UEENS MINERVA") < shown.indexOf("UEES TIBER"),
    "MINERVA now sits above TIBER: " + shown.join(" | "));
  assert.strictEqual(shown.indexOf("BRIDGE"), shown.indexOf("UEES TIBER") + 1,
    "TIBER's subnets travel with it");
  assert.strictEqual(shown.indexOf("M BRIDGE"), shown.indexOf("UEENS MINERVA") + 1,
    "MINERVA's subnet travels with it");
  ok("re-ordering a ship moves its whole nest with it");
}

/* ── subnets reorder inside their nest ── */
{
  const ord = mergeOrder([], reorder(FLEET, [], "DECK", "BRIDGE") || []);
  const shown = order(FLEET, ord);
  assert(shown.indexOf("DECK") < shown.indexOf("BRIDGE"), "DECK moved above BRIDGE");
  assert.strictEqual(shown.indexOf("DECK"), shown.indexOf("UEES TIBER") + 1,
    "and stayed directly under TIBER");
  ok("a subnet reorders within its nest");
}

/* ── but can never leave it ── */
{
  assert(!canReorder(FLEET, "BRIDGE", "COMMAND NET"), "subnet onto a top-level net is refused");
  assert(!canReorder(FLEET, "BRIDGE", "M BRIDGE"), "subnet onto another ship's subnet is refused");
  assert(!canReorder(FLEET, "COMMAND NET", "BRIDGE"), "top-level net into a nest is refused");
  assert.strictEqual(reorder(FLEET, [], "BRIDGE", "COMMAND NET"), null, "and the move returns nothing");
  assert(canReorder(FLEET, "BRIDGE", "DECK"), "siblings may swap");
  assert(canReorder(FLEET, "UEES TIBER", "MEDICAL"), "top-level nets may swap");
  assert(!canReorder(FLEET, "BRIDGE", "BRIDGE"), "a net can't be dropped on itself");
  ok("a net can never be dragged out of, or into, a nest");
}

/* ── unknown and stale names don't corrupt the board ── */
{
  const shown = order(FLEET, ["GHOST", "MEDICAL", "ALSO GONE"]);
  assert.strictEqual(shown.length, FLEET.length, "every net still renders");
  assert.strictEqual(shown[0], "MEDICAL", "a listed net leads");
  assert.deepStrictEqual(applyOrder(["a", "b", "c"], ["c"]), ["c", "a", "b"],
    "unlisted names keep their natural order behind listed ones");
  assert.deepStrictEqual(applyOrder(["a", "b"], []), ["a", "b"], "an empty order changes nothing");
  ok("stale or unknown names in a saved order are ignored, not fatal");
}

/* ── order survives merging repeatedly ── */
{
  let ord = [];
  ord = mergeOrder(ord, reorder(FLEET, ord, "MEDICAL", "COMMAND NET"));
  ord = mergeOrder(ord, reorder(FLEET, ord, "DECK", "BRIDGE"));
  const shown = order(FLEET, ord);
  assert(shown.indexOf("MEDICAL") < shown.indexOf("COMMAND NET"), "first move held");
  assert(shown.indexOf("DECK") < shown.indexOf("BRIDGE"), "second move held");
  assert.strictEqual(new Set(shown).size, FLEET.length, "no duplicates after repeated moves");
  ok("successive re-orders accumulate without corrupting the board");
}

console.log("\n✔ NET ORDER PASS — operators arrange their own board, nests stay intact");
process.exit(0);
