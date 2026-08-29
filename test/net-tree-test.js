"use strict";
/* The invariants that keep the net list honest. Each of these corresponds to a
   bug seen in the field on v0.9.x: a net re-homed to a ship appearing at the
   bottom of the list, a net disappearing outright, and a collapsed nest folding
   away something that wasn't in it. */
const assert = require("assert");
const { buildTree, descendants, validParents } = require("../src/net-tree");

let n = 0; const ok = (m) => console.log("  ✓ " + m, ++n);
const N = (name, parent) => ({ name, parent: parent || null });
const order = (nets, collapsed) => buildTree(nets, collapsed).rows.map(r => nets[r.i].name);
const depths = (nets, collapsed) => buildTree(nets, collapsed).rows.map(r => r.depth);

/* ── a child renders under its parent no matter where it sits in the array ── */
{
  /* exactly the reported bug: TIBER first, the re-homed net last */
  const nets = [N("UEES TIBER"), N("MEDICAL"), N("LOGISTICS"), N("STRIKE TWO", "UEES TIBER")];
  assert.deepStrictEqual(order(nets), ["UEES TIBER", "STRIKE TWO", "MEDICAL", "LOGISTICS"],
    "the re-homed net must sit under TIBER, not at the bottom");
  assert.deepStrictEqual(depths(nets), [0, 1, 0, 0]);
  ok("a re-homed net renders under its new parent, not at the end of the array");
}

/* ── nothing ever vanishes ── */
{
  const nets = [N("ALPHA"), N("GHOST CHILD", "A SHIP THAT WAS DELETED"), N("BRAVO")];
  const rows = buildTree(nets, {}).rows;
  assert.strictEqual(rows.length, 3, "orphan must still render");
  assert.strictEqual(rows.find(r => nets[r.i].name === "GHOST CHILD").depth, 0,
    "an orphan comes back to the top level");
  ok("a net whose parent no longer exists surfaces at top level instead of disappearing");
}
{
  /* the nastier version: a stale collapse key for the vanished parent */
  const nets = [N("ALPHA"), N("GHOST CHILD", "DELETED SHIP")];
  assert.deepStrictEqual(order(nets, { "DELETED SHIP": true }), ["ALPHA", "GHOST CHILD"],
    "a leftover collapse flag for a dead parent must not hide anything");
  ok("a stale collapse flag can't swallow a net");
}

/* ── collapse folds its own subtree and nothing else ── */
{
  const nets = [N("UEES TIBER"), N("BRIDGE", "UEES TIBER"), N("DECK", "UEES TIBER"),
                N("UEENS MINERVA"), N("M BRIDGE", "UEENS MINERVA")];
  assert.deepStrictEqual(order(nets, { "UEENS MINERVA": true }),
    ["UEES TIBER", "BRIDGE", "DECK", "UEENS MINERVA"],
    "folding MINERVA must not touch TIBER's children");
  assert.deepStrictEqual(order(nets, { "UEES TIBER": true }),
    ["UEES TIBER", "UEENS MINERVA", "M BRIDGE"]);
  ok("collapsing one nest folds only that nest");
}
{
  /* folding a parent hides grandchildren too */
  const nets = [N("SHIP"), N("DECK", "SHIP"), N("BAY", "DECK")];
  assert.deepStrictEqual(order(nets, { SHIP: true }), ["SHIP"]);
  assert.deepStrictEqual(order(nets, { DECK: true }), ["SHIP", "DECK"]);
  ok("folding hides the whole subtree, at any depth");
}

/* ── nesting deeper than one level ── */
{
  const nets = [N("SHIP"), N("DECK", "SHIP"), N("BAY", "DECK"), N("CREW", "BAY")];
  assert.deepStrictEqual(order(nets), ["SHIP", "DECK", "BAY", "CREW"]);
  assert.deepStrictEqual(depths(nets), [0, 1, 2, 3], "depth is derived, not capped at 1");
  ok("nests can go deeper than one level");
}

/* ── cycles are broken, not fatal ── */
{
  const nets = [N("A", "B"), N("B", "A")];
  const rows = buildTree(nets, {}).rows;          /* must not hang */
  assert.strictEqual(rows.length, 2, "both nets still render");
  ok("a two-net parent cycle is broken instead of hanging the render");
}
{
  const nets = [N("A", "C"), N("B", "A"), N("C", "B")];
  assert.strictEqual(buildTree(nets, {}).rows.length, 3, "three-net cycle survives");
  const nets2 = [N("SELF", "SELF")];
  assert.strictEqual(buildTree(nets2, {}).rows[0].depth, 0, "a net can't parent itself");
  ok("longer cycles and self-parenting are handled");
}

/* ── every net appears exactly once, whatever the input ── */
{
  const nets = [N("A"), N("B", "A"), N("C", "B"), N("D", "ZZZ"), N("E", "E"), N("F", "C")];
  for (const fold of [{}, { A: true }, { B: true }, { C: true }, { A: true, C: true }]) {
    const rows = buildTree(nets, fold).rows;
    const seen = rows.map(r => r.i);
    assert.strictEqual(new Set(seen).size, seen.length, "no net rendered twice");
  }
  assert.strictEqual(buildTree(nets, {}).rows.length, nets.length, "unfolded, everything shows");
  ok("no duplicates, and unfolded every net is present");
}

/* ── you cannot re-home a net under its own descendant ── */
{
  const nets = [N("SHIP"), N("DECK", "SHIP"), N("BAY", "DECK"), N("OTHER")];
  const { kids } = buildTree(nets, {});
  assert.deepStrictEqual(descendants(kids, 0).sort(), [1, 2], "SHIP's subtree is DECK and BAY");
  const legal = validParents(nets, 0).map(j => nets[j].name);
  assert.deepStrictEqual(legal, ["OTHER"], "SHIP may only move under OTHER");
  assert(validParents(nets, 3).map(j => nets[j].name).includes("BAY"), "OTHER may move anywhere");
  ok("a net can't be nested under its own descendant");
}

/* ── duplicate names resolve deterministically rather than forking ── */
{
  const nets = [N("DUP"), N("DUP"), N("KID", "DUP")];
  const t = buildTree(nets, {});
  assert.strictEqual(t.parentIdx[2], 0, "the first net with the name owns the child");
  assert.strictEqual(t.rows.length, 3);
  ok("duplicate net names resolve to one parent instead of forking the tree");
}

console.log("\n✔ NET TREE PASS — order follows parentage, nothing vanishes, nothing loops");
process.exit(0);
