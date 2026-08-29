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
function buildTree(nets, collapsed) {
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

module.exports = { buildTree, descendants, validParents };
