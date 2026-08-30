"use strict";
/* Where the net list gets its shape.
 *
 * Parentage lives in each net's `parent` field — NOT in the order of the array.
 * Rendering the array in order and using the parent only as an indent is what
 * made a re-homed net appear at the bottom of the list instead of under the
 * ship it had just been moved to, and what let a net vanish entirely when its
 * parent no longer existed.
 *
 * So the display order is derived from parentage on every render, with three
 * properties this code guarantees and net-tree-test.js checks:
 *
 *   - every net appears exactly once, always (an orphan whose parent is gone
 *     comes back to the top level rather than disappearing);
 *   - a child is always rendered directly beneath its parent;
 *   - a parent cycle is broken instead of hanging the renderer.
 *
 * Pure functions over plain objects: no DOM, no Electron.
 */

/* nets: [{ name, parent }]  ·  collapsed: { [name]: true }
   → { rows, kids, parentIdx, depth } where rows is display order. */
function buildTree(nets, collapsed, order) {
  const fold = collapsed || {};
  const n = nets.length;

  /* first net wins a duplicated name, so a name always resolves to one parent */
  const byName = new Map();
  nets.forEach((x, i) => { if (!byName.has(x.name)) byName.set(x.name, i); });

  const parentIdx = nets.map((x, i) => {
    if (!x.parent) return -1;
    const p = byName.get(x.parent);
    if (p == null || p === i) return -1;      /* orphan, or claims itself */
    return p;
  });

  /* break any cycle by detaching the node that closes it */
  for (let i = 0; i < n; i++) {
    let cur = parentIdx[i], hops = 0;
    while (cur !== -1) {
      if (cur === i) { parentIdx[i] = -1; break; }
      if (++hops > n) { parentIdx[i] = -1; break; }
      cur = parentIdx[cur];
    }
  }

  const kids = nets.map(() => []);
  const roots = [];
  parentIdx.forEach((p, i) => { if (p === -1) roots.push(i); else kids[p].push(i); });

  /* apply the operator's saved order to each sibling group */
  if (order && order.length) {
    const rank = new Map(order.map((n, i) => [n, i]));
    const sortSibs = (list) => list.sort((a, b) => {
      const ra = rank.has(nets[a].name) ? rank.get(nets[a].name) : Infinity;
      const rb = rank.has(nets[b].name) ? rank.get(nets[b].name) : Infinity;
      return (ra - rb) || (a - b);
    });
    sortSibs(roots);
    kids.forEach(sortSibs);
  }

  const depth = nets.map(() => 0);
  const rows = [];
  const walk = (i, d) => {
    depth[i] = d;
    rows.push({ i, depth: d, kids: kids[i].slice() });
    if (fold[nets[i].name]) return;           /* folded: skip the whole subtree */
    kids[i].forEach(k => walk(k, d + 1));
  };
  roots.forEach(r => walk(r, 0));

  return { rows, kids, parentIdx, depth, roots };
}

/* Every net at or beneath `i` — used to stop a net being re-homed under one of
   its own descendants, which would silently orphan the branch. */
function descendants(kids, i) {
  const out = [];
  const walk = (j) => kids[j].forEach(k => { out.push(k); walk(k); });
  walk(i);
  return out;
}

/* Legal parents for the net at `i`: anything but itself and its own subtree. */
function validParents(nets, i) {
  const { kids } = buildTree(nets, {});
  const banned = new Set([i].concat(descendants(kids, i)));
  return nets.map((x, j) => j).filter(j => !banned.has(j));
}

/* ── client-side ordering ──
 * Operators arrange their own board: someone who only ever flies the Minerva
 * wants the Tiber pushed to the bottom. That is a local preference, never a
 * change to the relay, so it lives as a per-install list of net names.
 *
 * The one structural rule: a net can be reordered WITHIN its nest but never
 * dragged out of one. Parentage is the relay's business — the sort only decides
 * the order of siblings, so a subnet can never be lifted to top level by a
 * mis-drag, and dropping a net onto a different nest is simply refused.
 */

/* Order siblings by a saved list of names; anything unlisted keeps its natural
   position after those that are listed. Stable and total. */
function applyOrder(names, order) {
  const rank = new Map((order || []).map((n, i) => [n, i]));
  return names
    .map((name, i) => ({ name, i, r: rank.has(name) ? rank.get(name) : Infinity }))
    .sort((a, b) => (a.r - b.r) || (a.i - b.i))
    .map(x => x.name);
}

/* Can `dragName` be dropped onto `dropName`? Only when they share a parent. */
function canReorder(nets, dragName, dropName) {
  if (!dragName || !dropName || dragName === dropName) return false;
  const a = nets.find(n => n.name === dragName);
  const b = nets.find(n => n.name === dropName);
  if (!a || !b) return false;
  return (a.parent || null) === (b.parent || null);
}

/* Move dragName to dropName's position among their shared siblings.
   Returns the new order for that sibling group, or null if the move is illegal. */
function reorder(nets, order, dragName, dropName) {
  if (!canReorder(nets, dragName, dropName)) return null;
  const parent = (nets.find(n => n.name === dragName).parent) || null;
  const siblings = applyOrder(
    nets.filter(n => (n.parent || null) === parent).map(n => n.name), order);
  const from = siblings.indexOf(dragName);
  const to = siblings.indexOf(dropName);
  if (from < 0 || to < 0) return null;
  siblings.splice(to, 0, siblings.splice(from, 1)[0]);
  return siblings;
}

/* Fold a reordered sibling group back into the full saved order. */
function mergeOrder(order, siblings) {
  const set = new Set(siblings);
  const kept = (order || []).filter(n => !set.has(n));
  return kept.concat(siblings);
}

module.exports = { buildTree, descendants, validParents, applyOrder, canReorder, reorder, mergeOrder };
