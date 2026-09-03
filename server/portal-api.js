"use strict";
/*
 * 22EF Portal API — the personnel layer of the accounts service.
 * The accounts service owns WHO you are (Discord identity, role, relay access);
 * this module owns WHAT you are in the fleet: rank, awards, certifications,
 * service record, chain of command, availability, events — and the two doors
 * other software comes through: SSO grants for the 22nd's apps, and a bot
 * token for the fleet Discord bot. Same storage discipline as the host
 * service: JSON files in DATA_DIR, atomic writes, no framework.
 *
 * Extra env: BOT_API_TOKEN        shared secret for the Discord bot (unset = bot door closed)
 *            PORTAL_ORIGIN        comma-list of origins allowed CORS (unset = same-origin only)
 *            PORTAL_URL           where the web login flow returns to (e.g. https://22d.space/portal/)
 *            DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET / DISCORD_REDIRECT_URI
 *                                 web OAuth (FleetComm's PKCE flow is separate and untouched)
 *            SSO_CODE_TTL_MS      one-time app-launch code lifetime (default 60s; tests shorten it)
 */
const https = require("https");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const querystring = require("querystring");

module.exports = function createPortalApi(deps) {
  const { load, save, record, send, body, auth, serializeMutation, db, MOCK, SESSION_TTL_MS } = deps;

  const BOT_TOKEN = process.env.BOT_API_TOKEN || "";
  const ORIGINS = String(process.env.PORTAL_ORIGIN || "").split(",").map(s => s.trim()).filter(Boolean);
  const PORTAL_URL = process.env.PORTAL_URL || "";
  const OAUTH = {
    id: process.env.DISCORD_CLIENT_ID || "",
    secret: process.env.DISCORD_CLIENT_SECRET || "",
    redirect: process.env.DISCORD_REDIRECT_URI || ""
  };
  const SSO_TTL = Number(process.env.SSO_CODE_TTL_MS || 60000);

  /* ── stores ── */
  const pdb = {
    personnel: record(load("personnel.json", {}), "personnel.json"),     // id -> {rank, awards[], certs[], record[]}
    catalog: record(load("catalog.json", {}), "catalog.json"),           // {ranks[], awards[], certs[], apps[]}
    coc: record(load("coc.json", {}), "coc.json"),                       // {nodes[]}
    availability: record(load("availability.json", {}), "availability.json"), // id -> {days:{date:code}}
    events: record(load("events.json", {}), "events.json"),              // id -> {title, at, tier, brief, by, rsvp{}}
    loa: record(load("loa.json", {}), "loa.json"),                       // id -> {active:{start,reason}|null, history[]}
    roster: record(load("roster.json", {}), "roster.json"),              // {ships:[{id,name,classification,hullId,status,notes,departments:[...]}]}
    squadrons: record(load("squadrons.json", {}), "squadrons.json"),     // {squadrons:[{id,name,designation,role,members:[{discordId,billet}]}]}
    discord: record(load("discord.json", {}), "discord.json"),           // {config{}, outbox[], muster{}}
    fleet: record(load("fleet.json", {}), "fleet.json"),                 // standing orders: aor, dutyStation, order constants
    mast: record(load("mast.json", {}), "mast.json"),                    // {cases[]} — Request Mast
    logistics: record(load("logistics.json", {}), "logistics.json"),     // {catalog[], inventory[], orders[], contributions[], claims[], blueprints[]}
    docs: record(load("docs.json", {}), "docs.json"),                    // {files:[{id,name,ext,size,tag,ref,rate,by,at}]} — bytes under DATA/docs
    content: record(load("content.json", {}), "content.json")            // the public site's editable copy: {blocks{key:{html,page,orig,at,by,v}}, history[]}
  };
  const persist = (name) => save(name + ".json", pdb[name]);
  const SHIP_STATUS = ["active", "reserve", "refit", "lost", "decommissioned"];
  /* awards of the quarter and the standard-issue kit: Command's lists,
     seeded with placeholders the Fleet Office edits like everything else */
  if (!Array.isArray(pdb.catalog.aotq)) pdb.catalog.aotq = [
    { id: "starman", name: "Starman of the Quarter", holder: "" },
    { id: "officer", name: "Officer of the Quarter", holder: "" },
    { id: "unit", name: "Unit of the Quarter", holder: "" },
  ];
  if (!Array.isArray(pdb.catalog.issue)) pdb.catalog.issue = [
    { id: "p4-ar", name: "P4-AR Rifle", category: "Primary", notes: "Standard-issue service rifle" },
    { id: "s-38", name: "S-38 Pistol", category: "Sidearm", notes: "Sidearm, all rates" },
    { id: "medpen", name: "MedPen (Hemozal)", category: "Medical", notes: "Two per person, minimum" },
    { id: "multitool", name: "Pyro RYT Multi-Tool", category: "Utility", notes: "Tractor + cutter attachments" },
    { id: "armor", name: "ORC-mkX / Fleet Standard Armor", category: "Armor", notes: "Per department colour standard" },
  ];

  /* ribbons: the decoration-lite category — a catalog list and a rack on every profile */
  if (!Array.isArray(pdb.catalog.ribbons)) pdb.catalog.ribbons = [];
  for (const rec of Object.values(pdb.personnel)) if (rec && typeof rec === "object" && !Array.isArray(rec.ribbons)) rec.ribbons = [];
  if (!pdb.content.blocks || typeof pdb.content.blocks !== "object") pdb.content.blocks = {};
  if (!Array.isArray(pdb.content.history)) pdb.content.history = [];

  /* ── the Discord mirror: config Command edits in-site, and an outbox of
     jobs the fleet bot drains through the bot door. Jobs survive restarts. ── */
  if (!pdb.discord.config || typeof pdb.discord.config !== "object") pdb.discord.config = {
    channels: { events: "events", reminders: "event-reminders",
      announce: "advancements", assignments: "assignment-orders" },
    remindHours: [24, 1], syncRoles: true, createRoles: false };
  pdb.discord.config.channels = Object.assign({ events: "events", reminders: "event-reminders",
    announce: "advancements", assignments: "assignment-orders", activity: "activity-tracker" },
    pdb.discord.config.channels || {});
  if (!pdb.discord.config.status) pdb.discord.config.status = { aor: "AOR:", duty: "Duty Station:" };
  if (!Array.isArray(pdb.discord.outbox)) pdb.discord.outbox = [];
  function enqueue(type, data) {
    pdb.discord.outbox.push(Object.assign(
      { id: crypto.randomBytes(6).toString("hex"), type, at: Date.now() }, data));
    if (pdb.discord.outbox.length > 500) pdb.discord.outbox.splice(0, pdb.discord.outbox.length - 500);
    persist("discord");
  }
  /* schedule a role re-sync for one member, at most once per queue */
  function enqueueRoles(discordId) {
    if (String(discordId).startsWith("m-")) return;   /* manual members have no Discord side */
    if (!pdb.discord.outbox.some(j => j.type === "roles" && j.discordId === discordId))
      enqueue("roles", { discordId });
  }
  /* how the fleet says a name: rated prefix or rank abbr, then callsign */
  function displayName(id) {
    const acc = db.accounts[id]; const rec = pdb.personnel[id] || {};
    const rk = rec.rating || (rec.rank && rec.rank !== "—" ? rec.rank : "");
    return ((rk ? rk + " " : "") + ((acc && (acc.callsign || acc.discordName)) || id)).trim();
  }

  /* ── fleet standing orders: AOR, duty station, and the constants the
     Bureau of Naval Personnel prints on every assignment order ── */
  const FLEET_DEFAULTS = {
    aor: "Nyx System", dutyStation: "PSS Theta", battlegroup: "Battlegroup 66",
    via: "Destroyer Squadron 38 (DESRON-38)",
    bupers: "Stanton Central Command / Bureau of Naval Personnel",
    director: "Reginald MacTavish, Captain (O-6)", directorTitle: "Director, Bureau of Naval Personnel",
    commsFreq: "1489.6611",
  };
  pdb.fleet = Object.assign({}, FLEET_DEFAULTS, pdb.fleet);
  if (!Array.isArray(pdb.mast.cases)) pdb.mast.cases = [];
  const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  /* the fleet's calendar: the real day, the in-universe year (+930), DDMONYYYY */
  function fleetDate(ms) {
    const d = new Date(Number(ms) || Date.now());
    return String(d.getUTCDate()).padStart(2, "0") + MONTHS[d.getUTCMonth()] + (d.getUTCFullYear() + 930);
  }
  /* the top of the published chain — the Fleet CO — holds the fleet's
     standing-order keys, with IT Admins as the backstop */
  function leaderId() {
    const nodes = Array.isArray(pdb.coc.nodes) ? pdb.coc.nodes : [];
    const roots = nodes.filter(n => !n.parent);
    for (const r of roots) if (r.assignee) return r.assignee;
    for (const r of roots) { const kid = nodes.find(n => n.parent === r.id && n.assignee); if (kid) return kid.assignee; }
    return null;
  }
  const isLeader = (actor) => !!actor && !actor.bot &&
    ((leaderId() && actor.id === leaderId()) || !!(actor.acc && actor.acc.itAdmin));
  /* the nearest leader above a member on the chain; the Fleet CO for
     anyone not on it; null when there is nobody above */
  function nextUp(id) {
    const nodes = Array.isArray(pdb.coc.nodes) ? pdb.coc.nodes : [];
    const mine = nodes.find(n => n.assignee === id);
    if (!mine) { const top = leaderId(); return top && top !== id ? top : null; }
    let cur = mine, guard = 0;
    while (cur && cur.parent && guard++ < 50) {
      cur = nodes.find(n => n.id === cur.parent);
      if (cur && cur.assignee && cur.assignee !== id) return cur.assignee;
    }
    return null;
  }
  function chainAssignees() {
    const seen = new Set(), out = [];
    for (const n of (Array.isArray(pdb.coc.nodes) ? pdb.coc.nodes : []))
      if (n.assignee && !seen.has(n.assignee) && db.accounts[n.assignee]) {
        seen.add(n.assignee); out.push({ id: n.assignee, name: displayName(n.assignee), title: n.title });
      }
    return out;
  }
  /* every soul enlists exactly once on the record */
  function ensureEnlisted(id, at) {
    const rec = recFor(id);
    if (rec.record.some(e => e.kind === "enlist")) return;
    const when = Number(at) || Date.now();
    rec.record.push({ at: when, by: "BUREAU OF NAVAL PERSONNEL", kind: "enlist",
      text: "Enlisted in the 22nd Expeditionary Fleet — " + fleetDate(when) });
    rec.record.sort((a, b2) => a.at - b2.at);
  }
  /* service numbers: five digits, stable per member, unique fleet-wide */
  function serviceNo(id) {
    const rec = recFor(id);
    if (rec.serviceNo) return rec.serviceNo;
    const used = new Set(Object.values(pdb.personnel).map(r => r.serviceNo).filter(Boolean));
    let n = 10000 + (parseInt(crypto.createHash("sha1").update(String(id)).digest("hex").slice(0, 8), 16) % 90000);
    while (used.has(String(n))) n = 10000 + ((n - 10000 + 7919) % 90000);
    rec.serviceNo = String(n);
    return rec.serviceNo;
  }
  /* ROOK "DOC" SABBAH → { full: "Rook Sabbah", short: "R. Sabbah" } */
  function nameForms(id) {
    const acc = db.accounts[id] || {};
    const raw = String(acc.callsign || acc.discordName || id)
      .replace(/["'“”‘’][^"'“”‘’]*["'“”‘’]/g, " ").replace(/\s+/g, " ").trim();
    const words = raw.split(" ").filter(Boolean).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
    const full = words.join(" ") || String(id);
    const short = words.length > 1 ? words[0].charAt(0) + ". " + words[words.length - 1] : full;
    return { full, short };
  }
  function rankInfo(id) {
    const rec = pdb.personnel[id] || {};
    const r = pdb.catalog.ranks.find(x => x.abbr === rec.rank);
    return r ? { name: r.name, grade: r.grade, abbr: r.abbr } : { name: "Unrated", grade: "—", abbr: rec.rank || "—" };
  }
  /* where a member stands today: first ship station, else squadron billet */
  function currentBillet(id) {
    for (const ship of pdb.roster.ships) for (const d of ship.departments || []) for (const st of d.stations || [])
      if (st.assignee === id) return st.title + ", " + ship.name;
    for (const sq of pdb.squadrons.squadrons) {
      const mm = sq.members.find(x => x.discordId === id);
      if (mm) return mm.billet + ", " + sq.name;
    }
    return "Unassigned";
  }
  /* the department (ship) or element (squadron) a member serves in today,
     per their assignment — "Bridge · UEES Tiber", "Reaper 1-1 · MG-212" */
  function currentDepartment(id) {
    for (const ship of pdb.roster.ships) for (const d of ship.departments || []) for (const st of d.stations || [])
      if (st.assignee === id) return d.name + " · " + ship.name;
    for (const sq of pdb.squadrons.squadrons) {
      const mm = sq.members.find(x => x.discordId === id);
      if (mm) return (mm.element ? mm.element + " · " : "") + sq.name;
    }
    return "";
  }
  /* seat a member at a station: record entries both ways, orders issued */
  function assignStation(hit, member, actor, quiet, src) {
    const previous = hit.st.assignee;
    const wasAt = member ? currentBillet(member) : null;
    hit.st.assignee = member;
    if (src) hit.st.src = src; else delete hit.st.src;
    if (previous && previous !== member) logEntry(recFor(previous), actor.name, "station",
      "Relieved of station: " + hit.st.title + ", " + hit.ship.name);
    if (member && previous !== member) {
      logEntry(recFor(member), actor.name, "station",
        "Assigned to station: " + hit.st.title + ", " + hit.ship.name);
      issueOrders(member, actor, { unit: hit.ship.name, hull: hit.ship.hullId || "",
        title: hit.st.title, department: hit.dept ? hit.dept.name : "", previous: wasAt, reportTo: hit.ship.name, quiet: !!quiet });
      enqueueRoles(member);
    }
  }
  function squadronLine(id) {
    const sq = pdb.squadrons.squadrons.find(s => s.members.some(x => x.discordId === id));
    if (!sq) return { line: pdb.fleet.via, name: (/\(([^)]+)\)\s*$/.exec(pdb.fleet.via) || [, pdb.fleet.via])[1] };
    return { line: sq.designation ? sq.designation + " (" + sq.name + ")" : sq.name, name: sq.name };
  }
  /* the Bureau's assignment order, written the way the Fleet CO writes them */
  function issueOrders(id, actor, a) {
    const f = pdb.fleet, when = Date.now(), n = nameForms(id), rk = rankInfo(id);
    const sq = a.squadronName ? { line: a.squadronLine || a.squadronName, name: a.squadronName } : squadronLine(id);
    const text = [
      "UNITED EMPIRE OF EARTH NAVY", "", "ASSIGNMENT ORDER", "",
      "From: " + f.bupers,
      "To: " + n.short + ", " + rk.name + " (" + rk.grade + ")",
      "Via: 22nd Expeditionary Fleet, " + f.battlegroup + ", " + sq.line,
      "Date: " + fleetDate(when),
      "Subject: Assignment Orders", "",
      "1. References", "",
      "a. UEE Navy Personnel Assignment Manual (UEENPERSMAN)",
      "b. UEE Navy Regulations, Section 3, Chapter 12", "",
      "2. Orders", "",
      "Effective immediately, you are hereby directed to report for duty under the following assignment:", "",
      "Name / Rank: " + n.full + ", " + rk.name,
      "Service Number: #" + serviceNo(id),
      "Current Duty Station: " + f.dutyStation,
      "Current Billet: " + (a.previous || "Unassigned"),
      "Reporting Unit / Ship: " + a.unit + ", " + sq.name,
      "Hull Number / Designator: " + (a.hull || "—"),
      "Reporting Date-Time Group (DTG): " + fleetDate(when + 864e5) + " / 0600",
      "Duty Title / Billet: " + a.title + (a.department ? ", " + a.department : ""), "",
      "You will assume all duties, responsibilities, and privileges of the assigned billet in accordance with UEE Navy regulations and standing orders of the command.", "",
      "3. Additional Instructions", "",
      "a. Ensure personal records and transfer documentation are updated prior to departure.",
      "b. All issued equipment, uniforms, and identification shall be accounted for and transferred in accordance with UEE Navy supply regulations.",
      "c. Report to the Commanding Officer, " + (a.reportTo || sq.name) + ".", "",
      "4. Point of Contact", "",
      "For administrative questions concerning these orders, contact Stanton Central Command, Bureau of Naval Personnel, at comms frequency " + f.commsFreq + ".", "",
      "By Order of Stanton Central Command", "",
      f.director, f.directorTitle, "UEE Navy",
    ].join("\n");
    const rec = recFor(id);
    if (!Array.isArray(rec.orders)) rec.orders = [];
    const order = { id: crypto.randomBytes(6).toString("hex"), at: when, by: actor.name, unit: a.unit, title: a.title, text };
    rec.orders.unshift(order);
    if (rec.orders.length > 50) rec.orders.length = 50;
    logEntry(rec, actor.name, "orders", "Assignment orders issued: " + a.title + ", " + a.unit + " (" + fleetDate(when) + ")");
    if (!a.quiet) enqueue("orders", { discordId: id, name: displayName(id), text });
    return order;
  }
  /* how alike a Discord arrival and a manual roster record look: shared
     name tokens over the roster name's tokens, rank words and initials
     ignored ("LT R. \"Doc\" Sabbah" vs ROOK "DOC" SABBAH → 2/3) */
  function matchScore(arrival, manual) {
    const rankWords = new Set(pdb.catalog.ranks.map(r => r.abbr.toLowerCase()));
    const toks = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/)
      .filter(t => t.length > 1 && !rankWords.has(t));
    const target = toks(manual.callsign);
    if (!target.length) return 0;
    let best = 0;
    for (const cand of [arrival.discordName, arrival.callsign]) {
      const set = new Set(toks(cand));
      const hit = target.filter(t => set.has(t)).length;
      const lastMatch = set.has(target[target.length - 1]) ? 0.1 : 0;
      best = Math.max(best, hit / target.length + lastMatch);
    }
    return Math.min(1, best);
  }
  /* fold a manual roster record into a Discord-linked account: standing,
     record, billets and musters all move; the manual shell is retired */
  function mergeAccounts(from, to, byName) {
    const src = db.accounts[from], dst = db.accounts[to];
    const srcRec = recFor(from), dstRec = recFor(to);
    if (srcRec.rank && srcRec.rank !== "—") dstRec.rank = srcRec.rank;
    if (srcRec.rating) dstRec.rating = srcRec.rating;
    if (srcRec.serviceNo && !dstRec.serviceNo) dstRec.serviceNo = srcRec.serviceNo;
    dstRec.awards = (dstRec.awards || []).concat(srcRec.awards || []);
    dstRec.ribbons = (dstRec.ribbons || []).concat(srcRec.ribbons || []);
    for (const c of srcRec.certs || []) if (!(dstRec.certs || []).some(x => x.certId === c.certId)) dstRec.certs.push(c);
    dstRec.record = (dstRec.record || []).concat(srcRec.record || []).sort((a, b2) => a.at - b2.at);
    dstRec.orders = (srcRec.orders || []).concat(dstRec.orders || []);
    if (!dst.callsign && src.callsign) dst.callsign = src.callsign;
    for (const k of ["rsiHandle", "timezone"]) if (src[k] && !dst[k]) dst[k] = src[k];
    if (src.contractor) dst.contractor = true;
    if (src.createdAt && (!dst.createdAt || src.createdAt < dst.createdAt)) dst.createdAt = src.createdAt;
    if (Array.isArray(src.scopes) && src.scopes.length) dst.scopes = Array.from(new Set((dst.scopes || []).concat(src.scopes)));
    for (const sq of pdb.squadrons.squadrons) {
      const mine = sq.members.find(x => x.discordId === from);
      if (mine) { if (!sq.members.some(x => x.discordId === to)) mine.discordId = to; else sq.members = sq.members.filter(x => x.discordId !== from); }
    }
    for (const ship of pdb.roster.ships) for (const d of ship.departments || []) for (const st of d.stations || [])
      if (st.assignee === from) st.assignee = to;
    for (const n of (pdb.coc.nodes || [])) if (n.assignee === from) n.assignee = to;
    if (pdb.loa[from] && !(pdb.loa[to] && pdb.loa[to].active)) pdb.loa[to] = pdb.loa[from];
    delete pdb.loa[from]; delete pdb.personnel[from]; delete db.accounts[from];
    logEntry(dstRec, byName, "note", "Discord account linked to the fleet record (" + (src.callsign || from) + ")");
    for (const s of ["personnel", "squadrons", "roster", "coc", "loa"]) persist(s);
    deps.persist();
    enqueueRoles(to);
  }
  /* ── LOGISTICS: one system — requisitions, inventory, contributions,
     reimbursements — funded by a treasury the fleet can see ── */
  const LG = pdb.logistics;
  for (const k of ["catalog", "inventory", "orders", "contributions", "claims", "blueprints"])
    if (!Array.isArray(LG[k])) LG[k] = [];
  /* no public crafting-blueprint dataset exists for the current patch —
     the library starts empty and says so; Logistics fills it by hand */
  if (!pdb.fleet.treasury) pdb.fleet.treasury = "Keleus_Harper";
  const lgId = () => crypto.randomBytes(6).toString("hex");
  const ORDER_STATES = ["submitted", "logistics", "command", "approved", "fulfilled", "rejected"];
  /* Logistics approvers: anyone holding the LOGRON-88 purview, plus — by
     standing rule — the senior officer and senior enlisted of LOGRON-88 */
  function logronSeniors() {
    const sq = pdb.squadrons.squadrons.find(s => /logron/i.test(s.name) || /logron/i.test(s.id));
    if (!sq) return [];
    const grade = (id) => { const r = rankInfo(id); const m = /^([OWE])-(\d+)/.exec(r.grade || ""); return m ? { branch: m[1], n: +m[2] } : null; };
    const best = { O: [], E: [] };
    for (const mm of sq.members) {
      const g = grade(mm.discordId); if (!g) continue;
      const key = g.branch === "O" ? "O" : g.branch === "E" ? "E" : null; if (!key) continue;
      if (!best[key].length || g.n > best[key][0].n) best[key] = [{ id: mm.discordId, n: g.n }];
      else if (g.n === best[key][0].n) best[key].push({ id: mm.discordId, n: g.n });
    }
    return best.O.concat(best.E).map(x => x.id);
  }
  const isLogistics = (actor) => isAdmin(actor) || hasScope(actor, "squadron:logron-88") ||
    (!actor.bot && logronSeniors().includes(actor.id));
  function treasuryLedger() {
    const inflow = LG.contributions.filter(c => c.status === "verified" && c.kind === "auec").reduce((s, c) => s + (Number(c.amount) || 0), 0);
    const paid = LG.claims.filter(c => c.status === "paid").reduce((s, c) => s + (Number(c.amount) || 0), 0);
    const owed = LG.claims.filter(c => c.status === "approved").reduce((s, c) => s + (Number(c.amount) || 0), 0);
    return { inflow, paid, owed, balance: inflow - paid };
  }
  function orderView(o) {
    return Object.assign({}, o, { byName: displayName(o.by), fleetDate: fleetDate(o.at) });
  }
  /* the UEX Corp item registry (open API, no key): categories, then items
     per category, cached for a day on disk so a restart never refetches */
  const UEX = { cats: null, items: null, at: 0 };
  async function uexJson(path) {
    const res = await fetch("https://api.uexcorp.space/2.0" + path, { headers: { "User-Agent": "22EF-Portal" } });
    const j = await res.json();
    return Array.isArray(j.data) ? j.data : [];
  }
  async function uexAll() {
    if (UEX.items && Date.now() - UEX.at < 864e5) return UEX.items;
    try {
      const cached = deps.load("uex-items.json", null);
      if (cached && cached.at && Date.now() - cached.at < 864e5 && Array.isArray(cached.items)) {
        UEX.items = cached.items; UEX.at = cached.at; return UEX.items;
      }
    } catch (e) {}
    const cats = (await uexJson("/categories")).filter(c => c.type === "item");
    const out = [];
    for (let i = 0; i < cats.length; i += 8) {
      const batch = cats.slice(i, i + 8);
      const lists = await Promise.all(batch.map(c => uexJson("/items?id_category=" + c.id).catch(() => [])));
      lists.forEach((list, k) => { for (const it of list) out.push({
        uexId: it.id, name: it.name, category: batch[k].name, section: batch[k].section || "", company: it.company_name || "" }); });
    }
    UEX.items = out; UEX.at = Date.now();
    try { deps.save("uex-items.json", { at: UEX.at, items: out }); } catch (e) {}
    return out;
  }
  let uexWarm = null;
  /* warm the registry in the background at boot, and again daily, so the
     requisition finder answers instantly instead of on the first keystroke */
  const warmUex = () => { if (!uexWarm) uexWarm = uexAll().catch(() => null).finally(() => { uexWarm = null; }); };
  if (!process.env.UEX_DISABLED) { setTimeout(warmUex, 3000); setInterval(warmUex, 6 * 3600e3); }

  /* ── the document library: course decks, SOPs, regulations. Bytes live
     under DATA/docs; the index is docs.json. Management uploads anything;
     a purview holder uploads for the rate they hold. ── */
  if (!Array.isArray(pdb.docs.files)) pdb.docs.files = [];
  const DOC_DIR = path.join(deps.dataDir || process.env.DATA_DIR || ".", "docs");
  const DOC_MAX = 25 * 1024 * 1024;
  const DOC_TYPES = { pdf: "application/pdf", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ppt: "application/vnd.ms-powerpoint", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    doc: "application/msword", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", txt: "text/plain", md: "text/markdown" };
  const canUploadDoc = (actor, rate) => isAdmin(actor) || (!!rate && hasScope(actor, "rate:" + rate));

  /* ── CSV: the Bureau's spreadsheet door. One row per member, the header
     names the columns in any order, unknown columns are ignored, a blank
     cell leaves that field alone. ── */
  const CSV_COLS = ["id", "callsign", "discord_name", "discord_user", "rank", "rating", "status", "squadron", "element",
    "billet", "tac_callsign", "element_lead", "ship", "station", "certs", "ribbons", "rsi_handle", "timezone", "enlisted", "last_seen", "note"];
  const csvCell = (v) => { const s = String(v == null ? "" : v); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  function parseCsv(text) {
    const rows = []; let row = [], cell = "", q = false;
    const s = String(text).replace(/^\uFEFF/, "");
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (q) { if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; continue; }
      if (c === '"') q = true;
      else if (c === ",") { row.push(cell); cell = ""; }
      else if (c === "\n" || c === "\r") { if (c === "\r" && s[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
      else cell += c;
    }
    if (cell.length || row.length) { row.push(cell); rows.push(row); }
    return rows.filter(r => r.some(x => String(x).trim() !== ""));
  }
  const yes = (v) => /^(y|yes|true|1|lead)$/i.test(String(v || "").trim());
  const no = (v) => /^(n|no|false|0)$/i.test(String(v || "").trim());
  /* dates as people type them: 15AUG2956 (fleet), 2026-08-15, 08/15/2026 */
  function parseWhen(v) {
    if (typeof v === "number" && Number.isFinite(v)) return v > 1e11 ? v : v * 1000;
    const s = String(v || "").trim(); if (!s) return null;
    let m;
    const real = (y) => (y >= 2900 ? y - 930 : y);          /* a fleet year (2956) is a real one (2026) */
    if ((m = /^(\d{2})([A-Z]{3})(\d{4})$/i.exec(s))) { const mo = MONTHS.indexOf(m[2].toUpperCase()); if (mo >= 0) return Date.UTC(real(+m[3]), mo, +m[1], 12); }
    if ((m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(s))) return Date.UTC(real(+m[1]), +m[2] - 1, +m[3], m[4] != null ? +m[4] : 12, m[5] != null ? +m[5] : 0);
    if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s))) return Date.UTC(real(+m[3]), +m[1] - 1, +m[2], 12);
    if (/^\d{10,13}$/.test(s)) { const n = Number(s); return n > 1e11 ? n : n * 1000; }
    const t = Date.parse(s); return Number.isFinite(t) ? t : null;
  }
  function memberRow(id) {
    const acc = db.accounts[id], rec = recFor(id);
    let sqm = null, sq = null;
    for (const s of pdb.squadrons.squadrons) { const mm = s.members.find(x => x.discordId === id); if (mm) { sq = s; sqm = mm; break; } }
    let shipName = "", station = "";
    for (const ship of pdb.roster.ships) for (const d of ship.departments || []) for (const st of d.stations || [])
      if (st.assignee === id && !station) { shipName = ship.name; station = st.title; }
    return [id, acc.callsign || "", acc.discordName || "", acc.discordUser || "", rec.rank || "", rec.rating || "",
      rec.status === "reserve" ? "reserve" : "active", sq ? sq.name : "", sqm ? sqm.element || "" : "", sqm ? sqm.billet || "" : "",
      sqm ? sqm.tacsign || "" : "", sqm ? (sqm.lead ? "yes" : "no") : "", shipName, station,
      (rec.certs || []).map(c => (pdb.catalog.certs.find(x => x.id === c.certId) || { name: c.certId }).name).join("; "),
      (rec.ribbons || []).map(c => ((pdb.catalog.ribbons || []).find(x => x.id === c.ribbonId) || { name: c.ribbonId }).name).join("; "),
      acc.rsiHandle || "", acc.timezone || "", acc.createdAt ? fleetDate(acc.createdAt) : "", acc.lastSeen ? fleetDate(acc.lastSeen) : "", ""];
  }

  /* ── RSI account verification: a one-time code the member pastes into
     their RSI bio; the fleet reads the PUBLIC citizen page and matches.
     No RSI credential is ever asked for. ── */
  const RSI_BASE = process.env.RSI_PROFILE_BASE || "https://robertsspaceindustries.com/citizens/";
  const RSI_COOLDOWN = Number(process.env.RSI_CHECK_COOLDOWN_MS || 20000);
  const RSI_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const rsiLast = new Map();
  async function rsiPage(handle) {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 12000);
    try {
      const res = await fetch(RSI_BASE + encodeURIComponent(handle), { redirect: "follow", signal: ctl.signal,
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36 22EF-Portal",
          "Accept": "text/html" } });
      if (res.status === 404) return { status: 404, html: "" };
      const html = await res.text();
      return { status: res.status, html: html.slice(0, 400000) };
    } finally { clearTimeout(t); }
  }
  /* the public copy editor may keep a little markup and nothing that runs:
     inline emphasis, lists, links to real places, images from the site's own
     store. Everything else is stripped, attributes included. */
  function cleanHtml(html) {
    const ALLOW = new Set(["p", "br", "b", "strong", "i", "em", "u", "s", "a", "ul", "ol", "li", "span", "img", "h2", "h3", "h4", "blockquote"]);
    return String(html || "").replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<\/?([a-zA-Z0-9]+)\b([^>]*)>/g, (m, tag, attrs) => {
        const t = tag.toLowerCase();
        if (!ALLOW.has(t)) return "";
        if (m.startsWith("</")) return t === "br" || t === "img" ? "" : "</" + t + ">";
        let keep = "";
        if (t === "a") {
          const h = /href\s*=\s*"([^"]*)"/i.exec(attrs) || /href\s*=\s*'([^']*)'/i.exec(attrs);
          const href = h ? h[1].trim() : "";
          if (href && !/^\s*javascript:/i.test(href) && /^(https?:\/\/|mailto:|#|\/|[a-z0-9._-]+\.html)/i.test(href))
            keep = ' href="' + href.replace(/"/g, "&quot;") + '"' + (/^https?:/i.test(href) ? ' target="_blank" rel="noopener"' : "");
        }
        if (t === "img") {
          const sm = /src\s*=\s*"([^"]*)"/i.exec(attrs) || /src\s*=\s*'([^']*)'/i.exec(attrs);
          let src = sm ? sm[1].trim() : "";
          const own = /^(?:https?:\/\/[^/]+)?(\/api\/content\/img\/[a-f0-9]{16})$/i.exec(src);
          if (own) src = own[1];
          if (!(own || /^assets\/[\w./-]+$/i.test(src))) return "";
          const alt = /alt\s*=\s*"([^"]*)"/i.exec(attrs);
          keep = ' src="' + src + '" alt="' + (alt ? alt[1].replace(/"/g, "&quot;") : "") + '" loading="lazy"';
        }
        return "<" + t + keep + ">";
      }).slice(0, 20000);
  }
  const htmlText = (html) => String(html).replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#0?39;/g, "'").replace(/\s+/g, " ");

  /* standing changes from the accounts registry: a cleared arrival enlists */
  function onStanding(id, prev, next) {
    const aboard = ["member", "element", "command"];
    if (aboard.includes(next) && !aboard.includes(prev)) { ensureEnlisted(id, Date.now()); persist("personnel"); }
  }

  /* the fleet's ladder, junior to senior, so a promotion is always index+1 */
  if (!Array.isArray(pdb.catalog.ranks) || !pdb.catalog.ranks.length) {
    pdb.catalog.ranks = [
      ["E-1", "Starman Recruit", "SR"], ["E-2", "Starman", "SM"], ["E-3", "Leading Starman", "LSM"],
      ["E-4", "Petty Officer Third Class", "PO3"], ["E-5", "Petty Officer Second Class", "PO2"],
      ["E-6", "Petty Officer First Class", "PO1"], ["E-7", "Chief Petty Officer", "CPO"],
      ["E-8", "Staff Chief Petty Officer", "SCPO"], ["E-9", "Master Chief Petty Officer", "MCPO"],
      ["E-10", "Command Master Chief Petty Officer", "CMDCM"],
      ["W-1", "Warrant Officer 1", "WO1"], ["W-2", "Chief Warrant Officer 2", "CWO2"],
      ["W-3", "Chief Warrant Officer 3", "CWO3"], ["W-4", "Chief Warrant Officer 4", "CWO4"],
      ["W-5", "Chief Warrant Officer 5", "CWO5"],
      ["O-1", "Ensign", "ENS"], ["O-2", "Lieutenant Junior Grade", "LTJG"], ["O-3", "Lieutenant", "LT"],
      ["O-4", "Lieutenant Commander", "LCDR"], ["O-5", "Commander", "CDR"], ["O-6", "Captain", "CAPT"],
      ["O-7", "Commodore", "CMD"], ["O-8", "Rear Admiral", "RADM"], ["O-9", "Vice Admiral", "VADM"],
      ["O-10", "Admiral", "ADM"], ["O-11", "Grand Admiral", "GADM"]
    ].map(([grade, name, abbr]) => ({ grade, name, abbr }));
    pdb.catalog.awards = [
      { id: "heart-eternal-watch", name: "Heart of the Eternal Watch", img: "Heart_of_the_Eternal_Watch_Medal_22nd_EF.png" },
      { id: "lifesaver-cross", name: "Lifesaver Cross", img: "Lifesaver_Cross_22nd_EF.png" },
      { id: "navigators-star", name: "Navigator's Star", img: "Navigators_Star_Medal_22nd_EF.png" },
      { id: "expeditionary-service", name: "Expeditionary Service Medal", img: "Expeditionary_Service_Medal_22nd_EF.png" },
      { id: "logistics-excellence", name: "Logistics Excellence", img: "plate-03-logistics-excellence.png" },
      { id: "united-we-carry", name: "United We Carry", img: "plate-05-united-we-carry.png" },
      { id: "adapt-sustain-deliver", name: "Adapt · Sustain · Deliver", img: "plate-07-adapt-sustain-deliver.png" },
      { id: "honor-through-sacrifice", name: "Honor Through Sacrifice", img: "plate-10-honor-through-sacrifice.png" }
    ];
    pdb.catalog.certs = ["Quartermaster", "Gunner's Mate", "Machinist Mate", "Master-at-Arms",
      "Logistics Specialist", "Hospital Corpsman", "Boatswain's Mate", "Aerospace Crewman",
      "Operations Specialist", "Intelligence Specialist", "Naval Aviator", "Gunship Pilot"]
      .map(name => ({ id: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), name }));
    pdb.catalog.apps = [
      { id: "fleetcomm", name: "FleetComm", url: "" },
      { id: "corpsman", name: "Corpsman", url: "" },
      { id: "gunners-map", name: "Gunner's Map", url: "" }
    ];
    persist("catalog");
  }

  /* the ships of the line, seeded once with their crewable stations — COMMAND
     reshapes the plan wholesale from the portal afterwards */
  if (!Array.isArray(pdb.roster.ships) || !pdb.roster.ships.length) {
    const dept = (name, ...titles) => ({ name, stations: titles.map(t => ({
      id: (name + "-" + t).toLowerCase().replace(/[^a-z0-9]+/g, "-"), title: t, assignee: null })) });
    pdb.roster.ships = [
      { id: "tiber", name: "UEES Tiber", hullId: "FF-217", classification: "Frigate",
        status: "active", notes: "", departments: [
        dept("Bridge", "Commanding Officer", "Executive Officer", "Helmsman", "Operations Officer"),
        dept("Flight Deck", "Air Boss", "Deck Chief", "Pilot 1", "Pilot 2"),
        dept("Engineering", "Chief Engineer", "Engineer 1", "Engineer 2"),
        dept("Gunnery", "Gunnery Chief", "Gunner 1", "Gunner 2")
      ] },
      { id: "beowulf", name: "UEES Beowulf", hullId: "PCG-685", classification: "Corvette Gunship",
        status: "active", notes: "", departments: [
        dept("Bridge", "Commanding Officer", "Helmsman"),
        dept("Gunnery", "Gunner 1", "Gunner 2"),
        dept("Engineering", "Engineer")
      ] }
    ];
    /* seeded station ids must be unique across ships */
    for (const ship of pdb.roster.ships) for (const d of ship.departments)
      for (const st of d.stations) st.id = ship.id + "-" + st.id;
    persist("roster");
  }
  /* v1 rosters carried `hull` and no status — carry them forward, once */
  {
    let migrated = false;
    for (const ship of pdb.roster.ships) {
      if (ship.hull && !ship.hullId) { ship.hullId = ship.hull; delete ship.hull; migrated = true; }
      if (!SHIP_STATUS.includes(ship.status)) { ship.status = "active"; migrated = true; }
      if (typeof ship.classification !== "string") { ship.classification = ""; migrated = true; }
      if (typeof ship.notes !== "string") { ship.notes = ""; migrated = true; }
    }
    if (migrated) persist("roster");
  }
  /* the fleet's squadrons, parallel to the ships of the line */
  if (!Array.isArray(pdb.squadrons.squadrons) || !pdb.squadrons.squadrons.length) {
    pdb.squadrons.squadrons = [
      { id: "desron-38", name: "DESRON-38", designation: "Destroyer Squadron 38", role: "Capital ships and heavies — the weight behind the fleet's word", members: [] },
      { id: "if-55", name: "IF-55", designation: "Interceptor Flight 55", role: "The screen — intercepting threats before they reach the line", members: [] },
      { id: "logron-88", name: "LOGRON-88", designation: "Logistics Squadron 88", role: "Keeps the train running behind the line", members: [] },
      { id: "mg-212", name: "MG-212", designation: "Marine Group 212", role: "Puts boots exactly where the plan needs them", members: [] },
      { id: "51sr", name: "51SR", designation: "51st Shock Regiment", role: "Clears the complex and exploits it", members: [] },
      { id: "paladins", name: "Paladins", designation: "Fighter Wing", role: "Air superiority over the objective", members: [] }
    ];
    persist("squadrons");
  }
  function squadronOf(id) { return pdb.squadrons.squadrons.find(s => s.id === id) || null; }
  function stationOf(stationId) {
    for (const ship of pdb.roster.ships) for (const d of ship.departments)
      for (const st of d.stations) if (st.id === stationId) return { ship, dept: d, st };
    return null;
  }

  const rankIdx = (abbr) => pdb.catalog.ranks.findIndex(r => r.abbr === abbr);
  const rankByAbbr = (abbr) => pdb.catalog.ranks[rankIdx(abbr)] || null;
  /* a promotion steps along the member's OWN ladder: a Marine rank (branch
     "marine") moves to the next Marine rank even though the Fleet Office
     files it beside its Navy pay-grade peer, and Navy ranks step past the
     Marine ones filed between them */
  function rankStep(abbr, step) {
    let i = rankIdx(abbr);
    if (i < 0 || !step) return i;
    const ranks = pdb.catalog.ranks;
    const branchOf = (r) => String((r && r.branch) || "").toLowerCase();
    const branch = branchOf(ranks[i]);
    const dir = step > 0 ? 1 : -1;
    for (let left = Math.abs(step); left > 0; left--) {
      do { i += dir; } while (i >= 0 && i < ranks.length && branchOf(ranks[i]) !== branch);
      if (i < 0 || i >= ranks.length) return -1;
    }
    return i;
  }
  function recFor(id) {
    if (!pdb.personnel[id]) pdb.personnel[id] = { rank: pdb.catalog.ranks[0].abbr, awards: [], certs: [], ribbons: [], record: [] };
    if (!Array.isArray(pdb.personnel[id].ribbons)) pdb.personnel[id].ribbons = [];
    return pdb.personnel[id];
  }
  /* extra rides along on the entry — the importers stamp their source there */
  function logEntry(rec, by, kind, text, extra) {
    rec.record.push(Object.assign({ at: Date.now(), by, kind, text: String(text).slice(0, 400) }, extra || {}));
    if (rec.record.length > 500) rec.record.splice(0, rec.record.length - 500);
  }
  /* one profile shape everywhere: identity from the accounts registry,
     standing from the personnel file */
  function profile(id) {
    const acc = db.accounts[id];
    if (!acc) return null;
    const rec = recFor(id);
    return {
      discordId: id, discordName: acc.discordName, callsign: acc.callsign || null,
      role: acc.role, manual: acc.manual === true, itAdmin: acc.itAdmin === true,
      contractor: acc.contractor === true,
      scopes: Array.isArray(acc.scopes) ? acc.scopes : [],
      rsiHandle: acc.rsiHandle || null, timezone: acc.timezone || null,
      lastSeen: acc.lastSeen || null, joinedAt: acc.createdAt || null,
      /* the @handle Discord knows them by (searchable), the RSI verification
         state, and where they stand today per their assignment orders */
      discordUser: acc.discordUser || null,
      rsiVerified: acc.rsiVerified || null,
      rsiPending: acc.rsiVerify ? { handle: acc.rsiVerify.handle, code: acc.rsiVerify.code, at: acc.rsiVerify.at } : null,
      status: rec.status === "reserve" ? "reserve" : "active",
      billet: currentBillet(id), department: currentDepartment(id),
      units: (() => { const u = memberUnits(id); return { ships: u.ships, squadrons: u.squadrons }; })(),
      rank: rankByAbbr(rec.rank) || { grade: "?", name: rec.rank, abbr: rec.rank },
      /* the rated form of the rank (BMMC, GM1, QMSC…) — display trumps ladder */
      rating: rec.rating || null, serviceNo: rec.serviceNo || null, orders: rec.orders || [],
      duties: rec.duties || [], designators: rec.designators || [],
      awards: rec.awards, certs: rec.certs, ribbons: rec.ribbons || [], record: rec.record
    };
  }

  /* ── permissions ──
     Three tiers, server-enforced: ADMIN (COMMAND role, the itAdmin flag, or
     the bot) manages everything; SCOPED managers hold entries like
     "ship:tiber" / "squadron:logron-88" / "rate:hospital-corpsman" granting
     assignment in that unit and record-approval for its members (a rate scope
     also grants bulk-certifying that rating); EVERYONE submits their own
     record entries and reads the fleet. The itAdmin flag exists precisely so
     no single account is a point of failure. */
  const isAdmin = (actor) => actor.bot || actor.command || !!(actor.acc && actor.acc.itAdmin);
  const actorScopes = (actor) => (actor.acc && Array.isArray(actor.acc.scopes)) ? actor.acc.scopes : [];
  const hasScope = (actor, s) => actorScopes(actor).includes(s);
  const canManageShip = (actor, shipId) => isAdmin(actor) || hasScope(actor, "ship:" + shipId);
  const canManageSquadron = (actor, id) => isAdmin(actor) || hasScope(actor, "squadron:" + id);
  const rateScopeCerts = (actor) => actorScopes(actor).filter(s => s.startsWith("rate:")).map(s => s.slice(5));
  function memberUnits(id) {
    const ships = pdb.roster.ships.filter(sh =>
      sh.departments.some(d => d.stations.some(st => st.assignee === id))).map(sh => sh.id);
    const squadrons = pdb.squadrons.squadrons.filter(sq =>
      sq.members.some(mm => mm.discordId === id)).map(sq => sq.id);
    const certs = recFor(id).certs.map(c => c.certId);
    return { ships, squadrons, certs };
  }
  function canApproveFor(actor, memberId) {
    if (isAdmin(actor)) return true;
    const u = memberUnits(memberId);
    return u.ships.some(s => hasScope(actor, "ship:" + s)) ||
      u.squadrons.some(s => hasScope(actor, "squadron:" + s)) ||
      u.certs.some(c => hasScope(actor, "rate:" + c));
  }
  /* record visibility: pending entries exist only for their owner and their
     approvers; rejected entries only for their owner. System entries carry no
     state and are public. Always returns a copy — never the stored arrays. */
  function redactProfile(pr, actor) {
    const owner = !actor.bot && actor.id === pr.discordId;
    const approver = owner || canApproveFor(actor, pr.discordId);
    return Object.assign({}, pr, { rsiPending: owner ? pr.rsiPending : null, record: pr.record.filter(e =>
      !e.state || e.state === "approved" ||
      (e.state === "pending" && approver) ||
      (e.state === "rejected" && owner)) });
  }

  /* ── who is asking: an operator's session, or the fleet's Discord bot ──
     The bot authenticates with a shared secret and acts with COMMAND writes;
     every entry it makes is attributed to it (plus the Discord user it is
     relaying for, when it says so). */
  function actorOf(req) {
    const bot = /^Bot (.+)$/.exec(req.headers.authorization || "");
    if (bot && BOT_TOKEN && (() => {
      const a = Buffer.from(bot[1]), b = Buffer.from(BOT_TOKEN);
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    })()) return { bot: true, id: "discord-bot", name: "FLEET DISCORD BOT", command: true };
    const a = auth(req);
    if (!a) return null;
    return { bot: false, id: a.id, acc: a.acc, name: a.acc.callsign || a.acc.discordName,
      command: a.acc.role === "command",
      member: ["member", "element", "command"].includes(a.acc.role) };
  }

  /* ── CORS: the portal may be served from a different origin than the API ── */
  function cors(req, res) {
    const origin = req.headers.origin;
    if (!origin || !ORIGINS.includes(origin)) return false;
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Max-Age", "600");
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return true; }
    return false;
  }

  /* ── SSO one-time launch codes (in-memory: 60s lifetime survives no restart) ── */
  const ssoCodes = new Map();
  function mintSso(id, app) {
    for (const [c, g] of ssoCodes) if (g.expiresAt <= Date.now()) ssoCodes.delete(c);
    const code = "sso-" + crypto.randomBytes(18).toString("hex");
    ssoCodes.set(code, { discordId: id, app: String(app || "").slice(0, 40), expiresAt: Date.now() + SSO_TTL });
    return code;
  }

  /* ── web OAuth (server-side confidential flow; FleetComm's PKCE is separate) ── */
  const oauthStates = new Map();
  function discordTokenExchange(code) {
    return new Promise((resolve, reject) => {
      const form = querystring.stringify({ client_id: OAUTH.id, client_secret: OAUTH.secret,
        grant_type: "authorization_code", code, redirect_uri: OAUTH.redirect });
      const req = https.request("https://discord.com/api/oauth2/token",
        { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, timeout: 10000 },
        (res) => {
          let d = ""; res.on("data", c => { d += c; if (d.length > 65536) req.destroy(new Error("oauth response too large")); });
          res.on("end", () => {
            try {
              const t = JSON.parse(d);
              if (res.statusCode !== 200 || !t.access_token) return reject(new Error("discord code exchange failed"));
              resolve(String(t.access_token));
            } catch (e) { reject(new Error("discord returned malformed oauth data")); }
          });
        });
      req.on("error", reject);
      req.on("timeout", () => { req.destroy(); reject(new Error("discord oauth timed out")); });
      req.end(form);
    });
  }

  /* the guild's member object for the signing-in user (guilds.members.read):
     {nick, roles[]} — resolves null rather than failing the sign-in when the
     guild isn't configured or Discord declines */
  const OAUTH_GUILD = String(process.env.DISCORD_GUILD_ID || "").trim();
  function discordGuildMember(token) {
    if (!OAUTH_GUILD) return Promise.resolve(null);
    return new Promise((resolve) => {
      const req = https.get("https://discord.com/api/users/@me/guilds/" + OAUTH_GUILD + "/member",
        { headers: { Authorization: "Bearer " + token, "User-Agent": "22EF-Portal" }, timeout: 10000 },
        (res) => {
          let d = ""; res.on("data", c => { d += c; if (d.length > 65536) req.destroy(new Error("member response too large")); });
          res.on("end", () => {
            if (res.statusCode !== 200) return resolve(null);
            try {
              const m = JSON.parse(d);
              resolve({ nick: m.nick ? String(m.nick).slice(0, 80) : null,
                user: m.user && m.user.username ? String(m.user.username).slice(0, 40) : null,
                roles: Array.isArray(m.roles) ? m.roles.map(String).slice(0, 100) : [] });
            } catch (e) { resolve(null); }
          });
        });
      req.on("error", () => resolve(null));
      req.on("timeout", () => { req.destroy(); resolve(null); });
    });
  }

  const CODES = new Set(["y", "m", "n", "loa"]);
  const DAY = /^\d{4}-\d{2}-\d{2}$/;

  /* returns true when the request was handled here */
  async function handle(req, res, url) {
    const p = url.pathname;
    if (cors(req, res)) return true;
    if (!p.startsWith("/api/")) return false;

    /* ── login plumbing (no auth) ── */
    if (p === "/api/oauth/config" && req.method === "GET") {
      send(res, 200, { ok: true, mock: MOCK, configured: !!(OAUTH.id && OAUTH.secret && OAUTH.redirect) });
      return true;
    }
    if (p === "/api/oauth/start" && req.method === "GET") {
      if (!OAUTH.id || !OAUTH.redirect) { send(res, 503, { ok: false, error: "web sign-in is not configured" }); return true; }
      const state = crypto.randomBytes(16).toString("hex");
      oauthStates.set(state, Date.now() + 600000);
      for (const [s, exp] of oauthStates) if (exp <= Date.now()) oauthStates.delete(s);
      /* prompt=none sails returning members through; a scope change makes
         Discord bounce consent_required, and the callback retries with ?force=1 */
      const q = querystring.stringify({ client_id: OAUTH.id, redirect_uri: OAUTH.redirect,
        response_type: "code", scope: "identify guilds guilds.members.read", state,
        prompt: url.searchParams.get("force") ? "consent" : "none" });
      res.writeHead(302, { Location: "https://discord.com/oauth2/authorize?" + q, "Cache-Control": "no-store" });
      res.end();
      return true;
    }
    if (p === "/api/oauth/callback" && req.method === "GET") {
      try {
        /* a consent bounce (new scopes since last authorize) retries visibly */
        if (url.searchParams.get("error") === "consent_required") {
          res.writeHead(302, { Location: "/api/oauth/start?force=1", "Cache-Control": "no-store" });
          res.end();
          return true;
        }
        const state = String(url.searchParams.get("state") || "");
        if (!oauthStates.has(state) || oauthStates.get(state) <= Date.now())
          throw new Error("sign-in expired — try again");
        oauthStates.delete(state);
        const discordToken = await discordTokenExchange(String(url.searchParams.get("code") || ""));
        /* reuse the host service's login by calling it in-process would tangle
           the routes; mint the session the same way it does instead */
        const who = await deps.verifyDiscord({ discordToken });
        await deps.requireGuildMember(discordToken);
        /* the fleet guild's own view of this member — nickname and roles —
           arrives with sign-in, so accounts wear their server name */
        const member = await discordGuildMember(discordToken);
        let acc = db.accounts[who.id];
        let fresh = false;
        if (!acc) {
          acc = db.accounts[who.id] = { discordName: who.username, role: "pending", createdAt: Date.now() };
          fresh = true;
          try { deps.audit(who.username, who.id, "sign-in", "new account via Discord OAuth - pending clearance"); } catch (e) {}
        }
        if (acc.role === "revoked") throw new Error("access revoked by COMMAND");
        if (acc.manual) { acc.manual = false; try { deps.audit(who.username, who.id, "arrived", "pre-filed record is now Discord-linked"); } catch (e) {} }
        acc.discordName = (member && member.nick) || who.username;
        if (member && Array.isArray(member.roles)) acc.guildRoles = member.roles;
        if (member && member.user) acc.discordUser = member.user;
        acc.lastSeen = Date.now();
        /* a first arrival whose server name unmistakably matches one manual
           roster record walks straight into it: rank, record, billets and all */
        if (fresh) {
          const manual = Object.entries(db.accounts).filter(([, a]) => a.manual)
            .map(([id2, a]) => ({ id: id2, score: matchScore(acc, a), callsign: a.callsign }))
            .filter(x => x.score >= 0.67).sort((x, y) => y.score - x.score);
          if (manual.length === 1 || (manual.length > 1 && manual[0].score - manual[1].score >= 0.3)) {
            const rec = pdb.personnel[manual[0].id] || {};
            mergeAccounts(manual[0].id, who.id, "BUREAU OF NAVAL PERSONNEL");
            acc.role = "member";                       /* on the roster already — cleared aboard */
            try { deps.audit(who.username, who.id, "merge", "arrival auto-linked to " + manual[0].callsign + " (" + (rec.rank || "—") + ")"); } catch (e) {}
          }
        }
        const token = crypto.randomBytes(24).toString("hex");
        db.sessions[token] = { discordId: who.id, createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL_MS };
        deps.persist();
        const back = (PORTAL_URL || "/portal/") + "login.html#token=" + token;
        res.writeHead(302, { Location: back, "Cache-Control": "no-store" });
        res.end();
      } catch (e) {
        const back = (PORTAL_URL || "/portal/") + "login.html#error=" + encodeURIComponent(e.message);
        res.writeHead(302, { Location: back, "Cache-Control": "no-store" });
        res.end();
      }
      return true;
    }
    /* an app hands back its one-time launch code and receives a real session:
       from then on it speaks to this API as that operator */
    if (p === "/api/sso/redeem" && req.method === "POST") {
      const b = await body(req);
      const grant = ssoCodes.get(String(b.code || ""));
      ssoCodes.delete(String(b.code || ""));      /* single use, success or not */
      if (!grant || grant.expiresAt <= Date.now()) { send(res, 403, { ok: false, error: "launch code expired or already used" }); return true; }
      const token = crypto.randomBytes(24).toString("hex");
      db.sessions[token] = { discordId: grant.discordId, createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL_MS };
      deps.persist();
      send(res, 200, { ok: true, token, app: grant.app, identity: profile(grant.discordId) });
      return true;
    }

    /* ── the public registry: what the front-facing site may print without a
       sign-in. Names and structure only — no members, no musters, no notes.
       The static pages hydrate from this so a rename in the Fleet Office is
       live on the public site on the next load. ── */
    if (p === "/api/public" && req.method === "GET") {
      const aboard = Object.values(db.accounts).filter(a => a.role !== "revoked");
      send(res, 200, {
        ok: true,
        fleet: { souls: aboard.length, contractors: aboard.filter(a => a.contractor).length,
          reserve: Object.entries(db.accounts).filter(([id2, a]) => a.role !== "revoked" && (pdb.personnel[id2] || {}).status === "reserve").length,
          aor: pdb.fleet.aor, dutyStation: pdb.fleet.dutyStation, battlegroup: pdb.fleet.battlegroup },
        ships: pdb.roster.ships.map(s => ({
          id: s.id, name: s.name, classification: s.classification || "",
          hullId: s.hullId || "", status: s.status || "active",
        })),
        squadrons: pdb.squadrons.squadrons.map(s => ({
          id: s.id, name: s.name, designation: s.designation || "", role: s.role || "",
        })),
        ranks: (pdb.catalog.ranks || []).filter(r => !r.hidden)
          .map(r => ({ grade: r.grade, name: r.name, abbr: r.abbr, branch: r.branch || "" })),
        certs: (pdb.catalog.certs || []).filter(c => !c.hidden).map(c => ({ id: c.id, name: c.name })),
        awards: (pdb.catalog.awards || []).filter(a => !a.hidden)
          .map(a => ({ id: a.id, name: a.name, img: a.img || "" })),
        ribbons: (pdb.catalog.ribbons || []).filter(a => !a.hidden)
          .map(a => ({ id: a.id, name: a.name, img: a.img || "", description: a.description || "" })),
      });
      return true;
    }

    /* ── the public site's editable copy: overrides by block key, readable by
       anyone (the site prints them at load); management writes further down ── */
    if (p === "/api/content" && req.method === "GET") {
      const page = String(url.searchParams.get("page") || "");
      const blocks = {};
      for (const [k, v] of Object.entries(pdb.content.blocks)) if (!page || v.page === page) blocks[k] = { html: v.html, v: v.v };
      res.setHeader("Cache-Control", "no-store");
      send(res, 200, { ok: true, blocks });
      return true;
    }
    const imgMatch = req.method === "GET" ? /^\/api\/content\/img\/([a-f0-9]{16})$/.exec(p) : null;
    if (imgMatch) {
      const f = pdb.docs.files.find(x => x.id === imgMatch[1] && x.tag === "public");
      const fp = f ? path.join(DOC_DIR, f.id + "." + f.ext) : "";
      if (!f || !fs.existsSync(fp)) { send(res, 404, { ok: false, error: "no such image" }); return true; }
      res.writeHead(200, { "Content-Type": DOC_TYPES[f.ext] || "application/octet-stream",
        "Content-Length": fs.statSync(fp).size, "Cache-Control": "public, max-age=86400" });
      fs.createReadStream(fp).pipe(res);
      return true;
    }

    /* everything below needs an operator session or the bot secret */
    const actor = actorOf(req);
    const need = (ok, code, msg) => { if (!ok) { send(res, code, { ok: false, error: msg }); return true; } return false; };
    if (!/^\/api\/(catalog|personnel|coc|availability|events|sso|activity|loa|roster|squadrons|record|export|bot|cam-viewers|audit|fleet|mast|logistics|uex|docs|rsi|backups|content|admin|me\/permissions)/.test(p)) return false;
    if (need(actor, 401, "unauthorized")) return true;
    /* pending accounts can see nothing but their own approval state */
    if (need(actor.bot || actor.member, 403, "awaiting COMMAND approval")) return true;
    const audit = (action, detail) => { try { deps.audit(actor.name, actor.id, action, detail); } catch (e) {} };

    let m;

    /* ── the fleet bot's door: outbox drain, RSVP relay, muster, role plan.
       Shared-secret auth only (actor.bot) — a member session never opens it. ── */
    if (p.startsWith("/api/bot/")) {
      if (need(actor.bot, 403, "fleet-bot credentials required")) return true;
      if (p === "/api/bot/config" && req.method === "GET") {
        send(res, 200, { ok: true, config: pdb.discord.config,
          squadrons: pdb.squadrons.squadrons.map(s => ({ id: s.id, name: s.name })),
          ranks: pdb.catalog.ranks.map(r => ({ abbr: r.abbr, name: r.name, grade: r.grade })) });
        return true;
      }
      if (p === "/api/bot/outbox" && req.method === "GET") {
        send(res, 200, { ok: true, jobs: pdb.discord.outbox.slice(0, 20) });
        return true;
      }
      if (p === "/api/bot/outbox/ack" && req.method === "POST") {
        const b = await body(req);
        const job = pdb.discord.outbox.find(j => j.id === String(b.id || ""));
        if (need(job, 404, "no such job")) return true;
        pdb.discord.outbox = pdb.discord.outbox.filter(j => j !== job);
        if (job.type === "event" && b.result && b.result.messageId && pdb.events[job.eventId]) {
          pdb.events[job.eventId].discordMsg = {
            channelId: String(b.result.channelId), messageId: String(b.result.messageId) };
          persist("events");
        }
        persist("discord");
        send(res, 200, { ok: true });
        return true;
      }
      if ((m = /^\/api\/bot\/event\/([a-f0-9]{16})$/.exec(p)) && req.method === "GET") {
        const ev = pdb.events[m[1]];
        if (need(ev, 404, "no such event")) return true;
        const lists = { going: [], maybe: [], no: [] };
        for (const [id2, ans] of Object.entries(ev.rsvp || {}))
          if (lists[ans]) lists[ans].push(displayName(id2));
        send(res, 200, { ok: true, event: {
          id: m[1], title: ev.title, at: ev.at, endAt: ev.endAt || null, tier: ev.tier,
          brief: ev.brief, location: ev.location || "", uniform: ev.uniform || "",
          attention: (ev.attention || []).map(sid => (squadronOf(sid) || {}).name).filter(Boolean),
          discordMsg: ev.discordMsg || null, reminded: ev.reminded || {},
          counts: { going: lists.going.length, maybe: lists.maybe.length, no: lists.no.length },
          lists } });
        return true;
      }
      if (p === "/api/bot/rsvp" && req.method === "POST") {
        const b = await body(req);
        const ev = pdb.events[String(b.eventId || "")];
        if (need(ev, 404, "no such event")) return true;
        const who = String(b.discordId || "");
        const acc = db.accounts[who];
        if (need(acc && ["member", "element", "command"].includes(acc.role), 403,
          "not on the fleet rolls — sign in at the portal first")) return true;
        if (need(["going", "maybe", "no"].includes(b.answer), 400, "answer must be going|maybe|no")) return true;
        ev.rsvp[who] = b.answer;
        persist("events");
        send(res, 200, { ok: true });
        return true;
      }
      if (p === "/api/bot/reminded" && req.method === "POST") {
        const b = await body(req);
        const ev = pdb.events[String(b.eventId || "")];
        if (need(ev, 404, "no such event")) return true;
        (ev.reminded = ev.reminded || {})[String(b.tag || "").slice(0, 20)] = true;
        persist("events");
        send(res, 200, { ok: true });
        return true;
      }
      if (p === "/api/bot/muster" && req.method === "POST") {
        const b = await body(req);
        const members = Array.isArray(b.members) ? b.members.slice(0, 2000) : null;
        if (need(members, 400, "members[] required")) return true;
        let linked = 0;
        for (const mm of members) {
          const acc = db.accounts[String(mm.id || "")];
          if (!acc) continue;
          acc.discordName = String(mm.nick || mm.username || acc.discordName).slice(0, 80);
          acc.guildRoles = Array.isArray(mm.roles) ? mm.roles.map(String).slice(0, 100) : [];
          if (mm.handle) acc.discordUser = String(mm.handle).slice(0, 40);
          if (acc.manual) acc.manual = false;            /* on Discord = not a stand-in record any more */
          linked++;
        }
        pdb.discord.muster = { at: Date.now(), count: members.length, linked };
        persist("discord");
        deps.persist();
        send(res, 200, { ok: true, linked });
        return true;
      }
      if (p === "/api/bot/roleplan" && req.method === "GET") {
        const plan = [];
        for (const [id2, acc] of Object.entries(db.accounts)) {
          if (acc.manual || !["member", "element", "command"].includes(acc.role)) continue;
          const rec = pdb.personnel[id2] || {};
          const roles = [];
          if (rec.rank && rec.rank !== "—") roles.push(rec.rank);
          for (const sq of pdb.squadrons.squadrons)
            if (sq.members.some(x => x.discordId === id2)) roles.push(sq.name);
          plan.push({ discordId: id2, roles });
        }
        send(res, 200, { ok: true, plan,
          managed: pdb.catalog.ranks.map(r => r.abbr)
            .concat(pdb.squadrons.squadrons.map(s => s.name)) });
        return true;
      }
      send(res, 404, { ok: false, error: "unknown bot route" });
      return true;
    }

    /* ── who may WATCH helmet cams in FleetComm: Element Leaders + COMMAND.
       Everyone keeps the right to stream; this gates viewing only, enforced
       app-side. Callsigns only — an account that never signed into the app
       has no wire identity to match (and a discordName fallback could
       collide with someone else's callsign). ── */
    if (p === "/api/cam-viewers" && req.method === "GET") {
      /* the wire name a cleared operator is using RIGHT NOW is their session
         callsign (the app files it per session); the account's own callsign
         stays in the list for anyone on the air under it */
      const now = Date.now(), viewers = new Set();
      const cleared = (id2) => { const a2 = db.accounts[id2]; return !!a2 && ["element", "command"].includes(a2.role); };
      for (const [id2, a2] of Object.entries(db.accounts)) if (cleared(id2) && a2.callsign) viewers.add(a2.callsign);
      for (const sess of Object.values(db.sessions || {})) {
        if (sess && sess.callsign && sess.expiresAt > now && cleared(sess.discordId)) viewers.add(sess.callsign);
      }
      send(res, 200, { ok: true, viewers: [...viewers] });
      return true;
    }

    /* ── the weekly backup's status for IT: the droplet's timer writes it
       beside the data; the archive itself stays in root's directory ── */
    if (p === "/api/backups/status" && req.method === "GET") {
      if (need(isAdmin(actor), 403, "management access required")) return true;
      let st = null;
      try { st = deps.load("backup-status.json", null); } catch (e) { st = null; }
      send(res, 200, { ok: true, status: st && typeof st === "object" ? st : null, fleetDate: st && st.at ? fleetDate(st.at) : null });
      return true;
    }

    /* -- the audit ledger: admin eyes only, read-only - no clear exists -- */
    if (p === "/api/audit" && req.method === "GET") {
      if (need(isAdmin(actor), 403, "management access required")) return true;
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 200));
      send(res, 200, { ok: true, entries: deps.auditTail(limit) });
      return true;
    }

    /* ── fleet standing orders: the Fleet CO (or IT) sets AOR + duty
       station; management edits the order constants ── */
    if (p === "/api/fleet" && req.method === "GET") {
      send(res, 200, { ok: true, fleet: pdb.fleet, leader: leaderId(), youLead: isLeader(actor), fleetDate: fleetDate() });
      return true;
    }
    if (p === "/api/fleet" && req.method === "POST") {
      const b = await body(req);
      const standing = ["aor", "dutyStation"];
      const constants = ["battlegroup", "via", "bupers", "director", "directorTitle", "commsFreq", "treasury"];
      if (standing.some(k => b[k] !== undefined) &&
          need(isLeader(actor), 403, "only the Fleet CO (top of the published chain) or an IT Admin sets the AOR and duty station")) return true;
      if (constants.some(k => b[k] !== undefined) && need(isAdmin(actor), 403, "management access required")) return true;
      const changed = [];
      for (const k of standing.concat(constants)) if (b[k] !== undefined) {
        const v = String(b[k]).trim().slice(0, 120);
        if (v !== pdb.fleet[k]) { pdb.fleet[k] = v; changed.push(k + " = " + v); }
      }
      persist("fleet");
      if (changed.length) audit("fleet", changed.join("; "));
      if (b.aor !== undefined) enqueue("status", { which: "aor", value: pdb.fleet.aor });
      if (b.dutyStation !== undefined) enqueue("status", { which: "duty", value: pdb.fleet.dutyStation });
      send(res, 200, { ok: true, fleet: pdb.fleet });
      return true;
    }

    /* ── after-action: who officially attended — onto every record, and
       out to the activity tracker in the fleet's own report format ── */
    if ((m = /^\/api\/events\/([a-f0-9]{16})\/aar$/.exec(p)) && req.method === "POST") {
      if (need(isAdmin(actor), 403, "management access required")) return true;
      const ev = pdb.events[m[1]];
      if (need(ev, 404, "no such event")) return true;
      const b = await body(req);
      const attendees = (Array.isArray(b.attendees) ? b.attendees.map(String) : []).filter(x => db.accounts[x]).slice(0, 200);
      if (need(attendees.length, 400, "no attendees marked")) return true;
      const when = fleetDate(ev.at);
      for (const id2 of attendees) {
        const rec = recFor(id2);
        if (!rec.record.some(e => e.kind === "event" && e.eventId === m[1]))
          rec.record.push({ at: ev.at, by: actor.name, kind: "event", eventId: m[1],
            text: "Attended: " + ev.title + " (" + when + ")" });
      }
      ev.aar = { at: Date.now(), by: actor.name, attendees, ships: String(b.ships || "").slice(0, 200),
        synopsis: String(b.synopsis || "").slice(0, 1500) };
      persist("events"); persist("personnel");
      audit("aar", ev.title + " — " + attendees.length + " attended");
      enqueue("aar", { eventId: m[1], date: when, mission: ev.title, personnel: attendees.map(displayName),
        ships: ev.aar.ships || "N/A", synopsis: ev.aar.synopsis, reportedBy: actor.bot ? actor.name : displayName(actor.id) });
      send(res, 200, { ok: true, aar: ev.aar });
      return true;
    }

    /* ── Request Mast: formal requests and grievances, routed up the chain,
       answered on the record, a Discord DM at every stage ── */
    const mastView = (c) => Object.assign({}, c, { byName: displayName(c.by), toName: displayName(c.to),
      log: c.log.map(l => Object.assign({}, l, { byName: displayName(l.by) })) });
    if (p === "/api/mast" && req.method === "POST" && !actor.bot) {
      const b = await body(req);
      const subject = String(b.subject || "").trim().slice(0, 120), text = String(b.body || "").trim().slice(0, 2000);
      if (need(subject && text, 400, "subject and body required")) return true;
      const to = b.recipient ? String(b.recipient) : nextUp(actor.id);
      if (need(to && db.accounts[to] && to !== actor.id, 400, "nobody stands above you on the published chain — pick a recipient")) return true;
      const c = { id: crypto.randomBytes(6).toString("hex"), at: Date.now(), by: actor.id, to, subject,
        status: "open", log: [{ at: Date.now(), by: actor.id, text }] };
      pdb.mast.cases.push(c);
      if (pdb.mast.cases.length > 2000) pdb.mast.cases.splice(0, pdb.mast.cases.length - 2000);
      persist("mast");
      audit("mast", "case filed: " + subject + " → " + displayName(to));
      enqueue("dm", { discordId: to, text: "📨 **Request Mast** — " + displayName(actor.id) + " has filed: **" + subject +
        "**\nAnswer it on the portal: " + (PORTAL_URL || "") + "command.html" });
      send(res, 200, { ok: true, case: mastView(c) });
      return true;
    }
    if (p === "/api/mast" && req.method === "GET" && !actor.bot) {
      const mine = pdb.mast.cases.filter(c => c.by === actor.id).map(mastView).reverse();
      const inbox = pdb.mast.cases.filter(c => c.to === actor.id || (isAdmin(actor) && c.status !== "resolved" && false)).map(mastView).reverse();
      send(res, 200, { ok: true, mine, inbox, chain: chainAssignees(), nextUp: nextUp(actor.id) });
      return true;
    }
    if ((m = /^\/api\/mast\/([a-f0-9]{12})\/(reply|escalate|resolve)$/.exec(p)) && req.method === "POST" && !actor.bot) {
      const c = pdb.mast.cases.find(x => x.id === m[1]);
      if (need(c, 404, "no such case")) return true;
      if (need(c.by === actor.id || c.to === actor.id || isAdmin(actor), 403, "not your case")) return true;
      const b = await body(req);
      const text = String(b.text || "").trim().slice(0, 2000);
      if (m[2] === "reply") {
        if (need(text, 400, "empty reply")) return true;
        c.log.push({ at: Date.now(), by: actor.id, text });
        const other = c.by === actor.id ? c.to : c.by;
        enqueue("dm", { discordId: other, text: "📨 **Request Mast** — reply on **" + c.subject + "** from " +
          displayName(actor.id) + ":\n" + text.slice(0, 900) });
      } else if (m[2] === "escalate") {
        if (need(c.to === actor.id || isAdmin(actor), 403, "only the current recipient escalates")) return true;
        const up = nextUp(c.to);
        if (need(up && up !== c.to, 400, "nobody stands above on the chain")) return true;
        c.log.push({ at: Date.now(), by: actor.id, text: "Escalated to " + displayName(up) + (text ? " — " + text : "") });
        c.to = up; c.status = "escalated";
        enqueue("dm", { discordId: up, text: "📨 **Request Mast** — escalated to you: **" + c.subject + "** (filed by " +
          displayName(c.by) + ")\nAnswer it on the portal: " + (PORTAL_URL || "") + "command.html" });
      } else {
        if (need(c.to === actor.id || isAdmin(actor), 403, "only the recipient resolves")) return true;
        c.status = "resolved";
        c.log.push({ at: Date.now(), by: actor.id, text: "Resolved" + (text ? " — " + text : "") });
        enqueue("dm", { discordId: c.by, text: "📨 **Request Mast** — **" + c.subject + "** resolved by " +
          displayName(actor.id) + (text ? ":\n" + text.slice(0, 900) : "") });
      }
      persist("mast");
      audit("mast", m[2] + ": " + c.subject);
      send(res, 200, { ok: true, case: mastView(c) });
      return true;
    }

    /* ── the Discord muster desk: arrivals beside their likely roster
       record, one click to merge ── */
    if (p === "/api/personnel/unmatched" && req.method === "GET") {
      if (need(isAdmin(actor), 403, "management access required")) return true;
      const manual = Object.entries(db.accounts).filter(([, a]) => a.manual)
        .map(([id2, a]) => ({ id: id2, callsign: a.callsign, rank: (pdb.personnel[id2] || {}).rank || "—" }));
      const arrivals = Object.entries(db.accounts).filter(([, a]) => !a.manual).map(([id2, a]) => ({
        id: id2, callsign: a.callsign || null, discordName: a.discordName, role: a.role,
        rank: (pdb.personnel[id2] || {}).rank || "—",
        suggestions: manual.map(mm => ({ id: mm.id, callsign: mm.callsign, rank: mm.rank, score: matchScore(a, mm) }))
          .filter(s => s.score >= 0.5).sort((x, y) => y.score - x.score).slice(0, 3) }));
      send(res, 200, { ok: true, arrivals, manual });
      return true;
    }
    if (p === "/api/personnel/merge" && req.method === "POST") {
      if (need(isAdmin(actor), 403, "management access required")) return true;
      const b = await body(req);
      const from = String(b.manualId || ""), to = String(b.discordId || "");
      if (need(db.accounts[from] && db.accounts[from].manual, 404, "manual record not found")) return true;
      if (need(db.accounts[to] && !db.accounts[to].manual, 404, "discord account not found")) return true;
      const label = db.accounts[from].callsign;
      await serializeMutation(async () => { mergeAccounts(from, to, actor.name); });
      audit("merge", label + " → " + displayName(to));
      send(res, 200, { ok: true, profile: profile(to) });
      return true;
    }

    /* ── UEX registry search (server-side cache; the client never calls UEX) ── */
    if (p === "/api/uex/search" && req.method === "GET") {
      const q = String(url.searchParams.get("q") || "").trim().toLowerCase();
      if (need(q.length >= 2, 400, "type at least two characters")) return true;
      let items;
      try { items = await (uexWarm || (uexWarm = uexAll().finally(() => { uexWarm = null; }))); }
      catch (e) { send(res, 502, { ok: false, error: "UEX is not answering right now — add the item by hand" }); return true; }
      const hits = items.filter(it => it.name.toLowerCase().includes(q)).slice(0, 30);
      send(res, 200, { ok: true, hits, total: items.length });
      return true;
    }

    /* ── logistics: the whole desk in one read ── */
    if (p === "/api/logistics" && req.method === "GET") {
      const mine = actor.bot ? null : actor.id;
      const lgc = isLogistics(actor), adm = isAdmin(actor);
      send(res, 200, { ok: true,
        you: { logistics: lgc, command: adm },
        treasury: Object.assign({ handle: pdb.fleet.treasury }, treasuryLedger()),
        catalog: LG.catalog,
        inventory: LG.inventory.map(i => Object.assign({}, i, {
          ownerName: i.owner === "fleet" ? "Fleet" : displayName(i.owner),
          holderName: !i.holder ? "" : db.accounts[i.holder] ? displayName(i.holder) :
            ((pdb.roster.ships.find(s => s.id === i.holder) || {}).name || i.holder) })),
        orders: LG.orders.filter(o => adm || lgc || o.by === mine).map(orderView).reverse(),
        contributions: LG.contributions.map(c => Object.assign({}, c, { byName: displayName(c.by), fleetDate: fleetDate(c.at) })).reverse(),
        claims: LG.claims.filter(c => adm || lgc || c.by === mine).map(c => Object.assign({}, c, { byName: displayName(c.by), fleetDate: fleetDate(c.at) })).reverse(),
        leaderboard: Object.entries(LG.contributions.filter(c => c.status === "verified").reduce((m, c) => {
          m[c.by] = (m[c.by] || 0) + (c.kind === "auec" ? Number(c.amount) || 0 : 0); return m; }, {}))
          .map(([id2, amt]) => ({ id: id2, name: displayName(id2), amount: amt })).sort((a, b2) => b2.amount - a.amount).slice(0, 10),
        blueprints: LG.blueprints,
        approvers: { logistics: logronSeniors().map(displayName) } });
      return true;
    }
    /* catalog: fleet-defined items, or a UEX pick pinned into the fleet's list */
    if (p === "/api/logistics/catalog" && req.method === "POST") {
      if (need(isLogistics(actor), 403, "logistics standing required")) return true;
      const b = await body(req);
      const name = String(b.name || "").trim().slice(0, 100);
      if (need(name, 400, "item name required")) return true;
      const existing = LG.catalog.find(x => (b.uexId && x.uexId === Number(b.uexId)) || x.name.toLowerCase() === name.toLowerCase());
      const item = existing || { id: lgId(), name, category: String(b.category || "").slice(0, 60),
        source: b.uexId ? "uex" : "fleet", uexId: b.uexId ? Number(b.uexId) : null, unit: String(b.unit || "ea").slice(0, 16),
        notes: String(b.notes || "").slice(0, 300), at: Date.now(), by: actor.name };
      if (!existing) LG.catalog.push(item);
      persist("logistics");
      send(res, 200, { ok: true, item });
      return true;
    }
    /* inventory: stock lines with an owner and a holder */
    if (p === "/api/logistics/inventory" && req.method === "POST") {
      if (need(isLogistics(actor), 403, "logistics standing required")) return true;
      const b = await body(req);
      const qty = Number(b.qty);
      if (b.id) {
        const line = LG.inventory.find(x => x.id === String(b.id));
        if (need(line, 404, "no such stock line")) return true;
        if (b.remove === true) { LG.inventory = LG.inventory.filter(x => x !== line); persist("logistics"); audit("stock", "struck: " + line.name); send(res, 200, { ok: true }); return true; }
        if (Number.isFinite(qty)) line.qty = Math.max(0, qty);
        for (const k of ["owner", "holder", "location", "notes"]) if (b[k] !== undefined) line[k] = String(b[k]).slice(0, 120);
        line.updatedAt = Date.now(); line.by = actor.name;
        persist("logistics"); audit("stock", line.name + " × " + line.qty + (line.holder ? " @ " + line.holder : ""));
        send(res, 200, { ok: true, line }); return true;
      }
      const name = String(b.name || "").trim().slice(0, 100);
      if (need(name && Number.isFinite(qty) && qty >= 0, 400, "name and quantity required")) return true;
      const line = { id: lgId(), itemId: b.itemId ? String(b.itemId) : null, name, qty,
        owner: b.owner && db.accounts[String(b.owner)] ? String(b.owner) : "fleet",
        holder: String(b.holder || "").slice(0, 60), location: String(b.location || "").slice(0, 120),
        notes: String(b.notes || "").slice(0, 300), updatedAt: Date.now(), by: actor.name };
      LG.inventory.push(line); persist("logistics");
      audit("stock", "added: " + name + " × " + qty);
      send(res, 200, { ok: true, line }); return true;
    }
    /* requisitions: anyone aboard asks; Logistics then Command approve;
       fulfilment issues stock or opens a reimbursement claim */
    if (p === "/api/logistics/orders" && req.method === "POST" && !actor.bot) {
      const b = await body(req);
      const items = (Array.isArray(b.items) ? b.items : []).map(x => ({ itemId: x.itemId ? String(x.itemId) : null,
        name: String(x.name || "").trim().slice(0, 100), qty: Math.max(1, Math.floor(Number(x.qty) || 1)) })).filter(x => x.name).slice(0, 30);
      if (need(items.length, 400, "list at least one item")) return true;
      const o = { id: lgId(), at: Date.now(), by: actor.id, items, justification: String(b.justification || "").trim().slice(0, 1000),
        status: "submitted", approvals: {}, log: [{ at: Date.now(), by: actor.id, text: "Submitted" }] };
      LG.orders.push(o); persist("logistics");
      audit("requisition", "filed: " + items.map(x => x.qty + "× " + x.name).join(", "));
      for (const id2 of logronSeniors()) enqueue("dm", { discordId: id2, text: "📦 **Requisition** filed by " + displayName(actor.id) + ": " +
        items.map(x => x.qty + "× " + x.name).join(", ") + "\nReview it on the portal: " + (PORTAL_URL || "") + "logistics.html" });
      send(res, 200, { ok: true, order: orderView(o) }); return true;
    }
    if ((m = /^\/api\/logistics\/orders\/([a-f0-9]{12})\/(approve|reject|fulfil|claim)$/.exec(p)) && req.method === "POST") {
      const o = LG.orders.find(x => x.id === m[1]);
      if (need(o, 404, "no such requisition")) return true;
      const b = await body(req);
      const note = String(b.note || "").trim().slice(0, 500);
      const stamp = (text) => o.log.push({ at: Date.now(), by: actor.bot ? "bot" : actor.id, text });
      if (m[2] === "approve") {
        if (need(o.status === "submitted" || o.status === "logistics", 400, "nothing to approve at this stage")) return true;
        if (o.status === "submitted") {
          if (need(isLogistics(actor), 403, "logistics standing required")) return true;
          o.approvals.logistics = { by: actor.id, at: Date.now() }; o.status = "logistics"; stamp("Approved by Logistics" + (note ? " — " + note : ""));
        } else {
          if (need(isAdmin(actor), 403, "COMMAND approval required")) return true;
          o.approvals.command = { by: actor.id, at: Date.now() }; o.status = "approved"; stamp("Approved by Command" + (note ? " — " + note : ""));
          enqueue("dm", { discordId: o.by, text: "📦 Your requisition is **approved** — Logistics will fulfil it." });
        }
      } else if (m[2] === "reject") {
        if (need(isLogistics(actor) || isAdmin(actor), 403, "logistics standing required")) return true;
        o.status = "rejected"; stamp("Rejected" + (note ? " — " + note : ""));
        enqueue("dm", { discordId: o.by, text: "📦 Your requisition was **not approved**" + (note ? ": " + note : ".") });
      } else if (m[2] === "fulfil") {
        if (need(isLogistics(actor), 403, "logistics standing required")) return true;
        if (need(o.status === "approved", 400, "approve it first")) return true;
        /* issue from fleet stock where it exists; the holder becomes the requester */
        for (const it of o.items) {
          let left = it.qty;
          for (const line of LG.inventory) {
            if (left <= 0) break;
            if (line.owner !== "fleet" || line.name.toLowerCase() !== it.name.toLowerCase() || line.qty <= 0) continue;
            const take = Math.min(left, line.qty); line.qty -= take; left -= take;
            LG.inventory.push({ id: lgId(), itemId: line.itemId, name: line.name, qty: take, owner: "fleet", holder: o.by,
              location: "issued", notes: "Requisition " + o.id, updatedAt: Date.now(), by: actor.name });
          }
          it.issued = it.qty - left;
        }
        LG.inventory = LG.inventory.filter(l => l.qty > 0);
        o.status = "fulfilled"; stamp("Fulfilled" + (note ? " — " + note : ""));
        enqueue("dm", { discordId: o.by, text: "📦 Your requisition is **fulfilled** — draw it from Logistics." });
      } else {
        /* the requester bought it themselves: a reimbursement claim, linked */
        if (need(o.by === actor.id, 403, "only the requester claims")) return true;
        if (need(["approved", "fulfilled"].includes(o.status), 400, "the requisition must be approved first")) return true;
        const amount = Math.max(0, Math.floor(Number(b.amount) || 0));
        if (need(amount > 0, 400, "amount (aUEC) required")) return true;
        const c = { id: lgId(), at: Date.now(), by: actor.id, amount, orderId: o.id, purpose: "Requisition " + o.id + ": " +
          o.items.map(x => x.qty + "× " + x.name).join(", "), proof: String(b.proof || "").slice(0, 300), status: "pending", log: [] };
        LG.claims.push(c); stamp("Reimbursement claim filed: " + amount.toLocaleString() + " aUEC");
        o.status = "fulfilled";
      }
      persist("logistics");
      audit("requisition", m[2] + ": " + o.items.map(x => x.qty + "× " + x.name).join(", "));
      send(res, 200, { ok: true, order: orderView(o) }); return true;
    }
    /* contributions: aUEC or items into the fleet; Logistics verifies against proof */
    if (p === "/api/logistics/contributions" && req.method === "POST" && !actor.bot) {
      const b = await body(req);
      const kind = b.kind === "items" ? "items" : "auec";
      const amount = Math.max(0, Math.floor(Number(b.amount) || 0));
      const items = (Array.isArray(b.items) ? b.items : []).map(x => ({ name: String(x.name || "").trim().slice(0, 100), qty: Math.max(1, Math.floor(Number(x.qty) || 1)) })).filter(x => x.name).slice(0, 30);
      if (need(kind === "auec" ? amount > 0 : items.length > 0, 400, kind === "auec" ? "amount (aUEC) required" : "list the items")) return true;
      const c = { id: lgId(), at: Date.now(), by: actor.id, kind, amount: kind === "auec" ? amount : 0, items,
        proof: String(b.proof || "").slice(0, 300), status: "pending" };
      LG.contributions.push(c); persist("logistics");
      audit("contribution", displayName(actor.id) + ": " + (kind === "auec" ? amount.toLocaleString() + " aUEC" : items.map(x => x.qty + "× " + x.name).join(", ")));
      send(res, 200, { ok: true, contribution: c }); return true;
    }
    if ((m = /^\/api\/logistics\/contributions\/([a-f0-9]{12})\/(verify|reject)$/.exec(p)) && req.method === "POST") {
      if (need(isLogistics(actor), 403, "logistics standing required")) return true;
      const c = LG.contributions.find(x => x.id === m[1]);
      if (need(c && c.status === "pending", 404, "no pending contribution by that id")) return true;
      c.status = m[2] === "verify" ? "verified" : "rejected"; c.verifiedBy = actor.name; c.verifiedAt = Date.now();
      if (c.status === "verified" && c.kind === "items") for (const it of c.items)
        LG.inventory.push({ id: lgId(), itemId: null, name: it.name, qty: it.qty, owner: "fleet", holder: "", location: "contributed",
          notes: "Contributed by " + displayName(c.by), updatedAt: Date.now(), by: actor.name });
      persist("logistics");
      audit("contribution", m[2] + ": " + displayName(c.by));
      enqueue("dm", { discordId: c.by, text: c.status === "verified" ? "🎖️ Your contribution to the fleet is **verified** — thank you." : "Your contribution could not be verified — see Logistics." });
      send(res, 200, { ok: true, contribution: c }); return true;
    }
    /* reimbursements: claims against the treasury — Logistics approves, Command marks paid */
    if (p === "/api/logistics/claims" && req.method === "POST" && !actor.bot) {
      const b = await body(req);
      const amount = Math.max(0, Math.floor(Number(b.amount) || 0));
      if (need(amount > 0 && String(b.purpose || "").trim(), 400, "amount (aUEC) and purpose required")) return true;
      const c = { id: lgId(), at: Date.now(), by: actor.id, amount, orderId: null, purpose: String(b.purpose).trim().slice(0, 300),
        proof: String(b.proof || "").slice(0, 300), status: "pending", log: [] };
      LG.claims.push(c); persist("logistics");
      audit("reimbursement", displayName(actor.id) + " claims " + amount.toLocaleString() + " aUEC");
      send(res, 200, { ok: true, claim: c }); return true;
    }
    if ((m = /^\/api\/logistics\/claims\/([a-f0-9]{12})\/(approve|reject|pay)$/.exec(p)) && req.method === "POST") {
      const c = LG.claims.find(x => x.id === m[1]);
      if (need(c, 404, "no such claim")) return true;
      if (m[2] === "pay") { if (need(isAdmin(actor), 403, "COMMAND marks claims paid")) return true; if (need(c.status === "approved", 400, "approve it first")) return true; c.status = "paid"; }
      else { if (need(isLogistics(actor), 403, "logistics standing required")) return true; if (need(c.status === "pending", 400, "already decided")) return true; c.status = m[2] === "approve" ? "approved" : "rejected"; }
      c.log.push({ at: Date.now(), by: actor.bot ? "bot" : actor.id, text: c.status });
      persist("logistics");
      audit("reimbursement", c.status + ": " + displayName(c.by) + " " + c.amount.toLocaleString() + " aUEC");
      enqueue("dm", { discordId: c.by, text: "💳 Reimbursement of **" + c.amount.toLocaleString() + " aUEC** is now **" + c.status + "**." });
      send(res, 200, { ok: true, claim: c }); return true;
    }
    /* blueprints: the fleet's own library, in the shape the crew already reads */
    if (p === "/api/logistics/blueprints" && req.method === "POST") {
      if (need(isLogistics(actor), 403, "logistics standing required")) return true;
      const b = await body(req);
      const list = Array.isArray(b.blueprints) ? b.blueprints.slice(0, 2000) : null;
      if (need(list, 400, "blueprints[] required")) return true;
      LG.blueprints = list.map(x => ({ id: String(x.id || String(x.name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-")).slice(0, 60),
        name: String(x.name || "").slice(0, 120), type: String(x.type || "").slice(0, 60),
        materials: String(x.materials || "").slice(0, 200), sources: String(x.sources || "").slice(0, 200) })).filter(x => x.id && x.name);
      persist("logistics"); audit("blueprints", LG.blueprints.length + " on file");
      send(res, 200, { ok: true, blueprints: LG.blueprints }); return true;
    }

    /* ── documents ── */
    if (p === "/api/docs" && req.method === "GET") {
      /* ?tag=logo lists unit art; the library proper never shows logos */
      const wantTag = String(url.searchParams.get("tag") || "");
      send(res, 200, { ok: true, files: pdb.docs.files.filter(f => wantTag ? f.tag === wantTag : f.tag !== "logo" && f.tag !== "public").map(f => Object.assign({}, f, { byName: f.by })),
        canUpload: isAdmin(actor) || actorScopes(actor).some(s => s.startsWith("rate:")),
        rates: isAdmin(actor) ? pdb.catalog.certs.map(c => c.id) : rateScopeCerts(actor) });
      return true;
    }
    if (p === "/api/docs" && req.method === "POST") {
      const b = await body(req);
      const rate = b.rate ? String(b.rate).slice(0, 40) : "";
      const tag = ["course", "sop", "reg", "logo", "public"].includes(b.tag) ? b.tag : "course";
      const ref = String(b.ref || "").trim().slice(0, 40);
      const name = String(b.name || "").trim().slice(0, 120);
      const ext = (name.split(".").pop() || "").toLowerCase();
      if (tag === "logo") {
        /* unit art: a ship's backdrop or a squadron's logo, filed by whoever
           runs that unit; one per unit, the newest replaces the old */
        const um = /^(ship|squadron):([a-z0-9-]{1,40})$/.exec(ref);
        if (need(um, 400, "unit art needs ref ship:<id> or squadron:<id>")) return true;
        if (need(um[1] === "ship" ? canManageShip(actor, um[2]) : canManageSquadron(actor, um[2]), 403, "no authority over that unit")) return true;
        if (need(/^(png|jpg|jpeg|webp)$/.test(ext), 400, "unit art must be png, jpg or webp")) return true;
      } else if (tag === "public") {
        /* images the public site prints inside edited copy — management only */
        if (need(isAdmin(actor), 403, "management access required")) return true;
        if (need(/^(png|jpg|jpeg|webp)$/.test(ext), 400, "public images must be png, jpg or webp")) return true;
      } else if (need(canUploadDoc(actor, rate), 403, "management access or a purview for that rate required")) return true;
      if (need(name && DOC_TYPES[ext], 400, "file type not accepted (pdf, pptx, docx, xlsx, png, jpg, webp, txt, md)")) return true;
      let bytes;
      try { bytes = Buffer.from(String(b.data || "").replace(/^data:[^,]*,/, ""), "base64"); } catch (e) { bytes = null; }
      if (need(bytes && bytes.length > 0 && bytes.length <= DOC_MAX, 400, "file missing or over 25 MB")) return true;
      const id = crypto.randomBytes(8).toString("hex");
      fs.mkdirSync(DOC_DIR, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(DOC_DIR, id + "." + ext), bytes, { mode: 0o600 });
      const f = { id, name, ext, size: bytes.length, tag, ref, title: String(b.title || "").trim().slice(0, 120),
        rate, by: actor.name, at: Date.now() };
      if (tag === "logo") {
        for (const old of pdb.docs.files.filter(x => x.tag === "logo" && x.ref === ref))
          try { fs.unlinkSync(path.join(DOC_DIR, old.id + "." + old.ext)); } catch (e) {}
        pdb.docs.files = pdb.docs.files.filter(x => !(x.tag === "logo" && x.ref === ref));
      }
      pdb.docs.files.push(f); persist("docs");
      audit("docs", "uploaded " + name + (f.ref ? " (" + f.ref + ")" : ""));
      send(res, 200, { ok: true, file: f });
      return true;
    }
    if ((m = /^\/api\/docs\/([a-f0-9]{16})\/file$/.exec(p)) && req.method === "GET") {
      const f = pdb.docs.files.find(x => x.id === m[1]);
      if (need(f, 404, "no such document")) return true;
      const fp = path.join(DOC_DIR, f.id + "." + f.ext);
      if (need(fs.existsSync(fp), 410, "file is missing from the store")) return true;
      res.writeHead(200, { "Content-Type": DOC_TYPES[f.ext] || "application/octet-stream",
        "Content-Length": fs.statSync(fp).size, "Cache-Control": "private, max-age=3600",
        "Content-Disposition": "inline; filename=\"" + f.name.replace(/[^\w. -]+/g, "_") + "\"" });
      fs.createReadStream(fp).pipe(res);
      return true;
    }
    if ((m = /^\/api\/docs\/([a-f0-9]{16})\/delete$/.exec(p)) && req.method === "POST") {
      const f = pdb.docs.files.find(x => x.id === m[1]);
      if (need(f, 404, "no such document")) return true;
      if (need(isAdmin(actor) || f.by === actor.name, 403, "management access required")) return true;
      try { fs.unlinkSync(path.join(DOC_DIR, f.id + "." + f.ext)); } catch (e) {}
      pdb.docs.files = pdb.docs.files.filter(x => x !== f); persist("docs");
      audit("docs", "removed " + f.name);
      send(res, 200, { ok: true });
      return true;
    }

    /* ── the roster as a spreadsheet, and back ── */
    if (p === "/api/personnel/export.csv" && req.method === "GET" && !actor.bot) {
      if (need(isAdmin(actor) || actorScopes(actor).length, 403, "management access or a purview required")) return true;
      const template = url.searchParams.get("template") === "1";
      const lines = [CSV_COLS.join(",")];
      if (template) lines.push(["", "EXAMPLE - DELETE THIS ROW", "", "", "SR", "", "active", "MG-212", "Reaper 1-1", "Marine",
        "Reaper 1-1 C", "no", "", "", "Hospital Corpsman", "", "", "", "15AUG2956", "", "Phase 1 complete"].map(csvCell).join(","));
      else {
        const ids = Object.keys(db.accounts).filter(id2 => db.accounts[id2].role !== "revoked")
          .sort((a, b2) => rankIdx((pdb.personnel[b2] || {}).rank) - rankIdx((pdb.personnel[a] || {}).rank));
        for (const id2 of ids) lines.push(memberRow(id2).map(csvCell).join(","));
      }
      const text = "\uFEFF" + lines.join("\r\n") + "\r\n";
      res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8", "Cache-Control": "no-store",
        "Content-Disposition": "attachment; filename=\"22ef-" + (template ? "roster-template" : "roster-" + fleetDate()) + ".csv\"" });
      res.end(text);
      return true;
    }
    if (p === "/api/personnel/import/csv" && req.method === "POST" && !actor.bot) {
      const adm = isAdmin(actor);
      if (need(adm || actorScopes(actor).length, 403, "management access or a purview required")) return true;
      const b = await body(req, 1048576);
      const rows = parseCsv(String(b.csv || ""));
      if (need(rows.length >= 2, 400, "the CSV needs a header row and at least one member")) return true;
      if (need(rows.length <= 401, 400, "at most 400 members per file")) return true;
      const header = rows[0].map(h => String(h).trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, ""));
      const col = (r, name) => { const i = header.indexOf(name); return i < 0 ? undefined : String(r[i] == null ? "" : r[i]).trim(); };
      if (need(header.includes("id") || header.includes("callsign"), 400, "the header needs an id or callsign column (download the template)")) return true;
      const dryRun = b.dryRun === true, quiet = b.quiet === true;
      const out = { ok: true, dryRun, rows: rows.length - 1, applied: 0, created: 0, errors: [], changes: [] };
      const byCallsign = new Map();
      for (const [aid, acc] of Object.entries(db.accounts)) if (acc.callsign) byCallsign.set(String(acc.callsign).toUpperCase(), aid);
      const scopes = actorScopes(actor);
      const sqScopes = scopes.filter(s => s.startsWith("squadron:")).map(s => s.slice(9));
      const shipScopes = scopes.filter(s => s.startsWith("ship:")).map(s => s.slice(5));
      const rateScopes = rateScopeCerts(actor);
      const lc = (v) => String(v || "").toLowerCase();
      const findSquadron = (v) => pdb.squadrons.squadrons.find(s => s.id === lc(v) || lc(s.name) === lc(v) || lc(s.designation) === lc(v));
      const findRank = (v) => pdb.catalog.ranks.find(r => lc(r.abbr) === lc(v) || lc(r.name) === lc(v));
      const findCert = (v) => pdb.catalog.certs.find(c => c.id === lc(v) || lc(c.name) === lc(v));
      const findShip = (v) => pdb.roster.ships.find(s => s.id === lc(v) || lc(s.name) === lc(v));
      const work = async () => {
        for (let i = 1; i < rows.length; i++) {
          const r = rows[i];
          const v = {}; for (const k of CSV_COLS) v[k] = col(r, k);
          const idCell = v.id || "";
          const csCell = (v.callsign || "").toUpperCase().replace(/[^ A-Z0-9_.\-'"()[\]]+/g, "").slice(0, 40);
          if (/example/i.test(csCell) || /example/i.test(idCell)) continue;
          const label = csCell || idCell || ("row " + (i + 1));
          const rowErr = [], rowChg = [];
          let id = idCell && db.accounts[idCell] ? idCell : (csCell ? byCallsign.get(csCell) : null);
          let created = false;
          if (!id) {
            if (!adm) { out.errors.push(label + ": not on the rolls (management adds new members)"); continue; }
            if (!csCell) { out.errors.push("row " + (i + 1) + ": no callsign, no id"); continue; }
            id = "m-" + crypto.randomBytes(5).toString("hex");
            created = true;
            if (!dryRun) {
              db.accounts[id] = { discordName: String(v.discord_name || csCell).slice(0, 80), callsign: csCell, role: "member", manual: true, createdAt: Date.now() };
              byCallsign.set(csCell, id);
              logEntry(recFor(id), actor.name, "note", "Record created from a roster spreadsheet");
              ensureEnlisted(id, Date.now());
            }
            rowChg.push("added to the rolls");
          }
          const acc = created && dryRun ? { callsign: csCell } : db.accounts[id];
          const rec = created && dryRun ? { rank: pdb.catalog.ranks[0].abbr, certs: [], record: [] } : recFor(id);
          const inMySquadron = sqScopes.some(sid => (squadronOf(sid) || { members: [] }).members.some(x => x.discordId === id));
          const mayPerson = adm || inMySquadron || (!created && canApproveFor(actor, id));
          if (csCell && !created && csCell !== String(acc.callsign || "").toUpperCase()) {
            if (adm) { rowChg.push("callsign → " + csCell); if (!dryRun) { acc.callsign = csCell; byCallsign.set(csCell, id); } }
            else rowErr.push("callsign is management's to set");
          }
          if (v.rank) {
            const rk = findRank(v.rank);
            if (!rk) rowErr.push("no such rank: " + v.rank);
            else if (!adm) rowErr.push("rank is management's to set");
            else if (rk.abbr !== rec.rank) {
              rowChg.push("rank → " + rk.abbr);
              if (!dryRun) { const from = rec.rank; rec.rank = rk.abbr;
                logEntry(rec, actor.name, "rank", (rankIdx(rk.abbr) > rankIdx(from) ? "Promoted " : "Rank set ") + from + " → " + rk.abbr + " (roster spreadsheet)"); }
            }
          }
          if (v.rating && v.rating !== (rec.rating || "")) {
            if (!adm) rowErr.push("rating is management's to set");
            else { rowChg.push("rating → " + v.rating); if (!dryRun) rec.rating = v.rating.slice(0, 12); }
          }
          if (v.status) {
            const to = /reserve|^ir$|inactive/i.test(v.status) ? "reserve" : /active/i.test(v.status) ? "active" : null;
            if (!to) rowErr.push("status must be active or reserve");
            else if (!mayPerson) rowErr.push("status: no authority over this member");
            else if (to !== (rec.status === "reserve" ? "reserve" : "active")) {
              rowChg.push("status → " + to);
              if (!dryRun) { rec.status = to; logEntry(rec, actor.name, "status", to === "reserve" ? "Transferred to the Inactive Reserve" : "Returned to active duty from the Inactive Reserve"); }
            }
          }
          /* the squadron block: muster, squad, billet, tactical call sign, lead */
          if (["squadron", "element", "billet", "tac_callsign", "element_lead"].some(k => v[k])) {
            const sq = v.squadron ? findSquadron(v.squadron) : pdb.squadrons.squadrons.find(s => s.members.some(x => x.discordId === id));
            if (v.squadron && !sq) rowErr.push("no such squadron: " + v.squadron);
            else if (!sq) rowErr.push("squad/billet given but the member is in no squadron — add a squadron column");
            else if (!(adm || sqScopes.includes(sq.id))) rowErr.push("no authority over " + sq.name);
            else {
              const mm = sq.members.find(x => x.discordId === id);
              const next = Object.assign({}, mm || { discordId: id, billet: v.billet || "Member" });
              if (v.billet) next.billet = v.billet.slice(0, 60);
              if (v.element) next.element = v.element.slice(0, 40);
              if (v.tac_callsign) next.tacsign = v.tac_callsign.slice(0, 30);
              if (v.element_lead) { if (yes(v.element_lead)) next.lead = true; else if (no(v.element_lead)) delete next.lead; }
              const where = next.element ? " (" + next.element + ")" : "";
              if (!mm) {
                rowChg.push("mustered into " + sq.name + " — " + next.billet + where);
                if (!dryRun) {
                  const wasAt = currentBillet(id);
                  next.src = "csv";
                  sq.members.push(next);
                  logEntry(rec, actor.name, "squadron", "Assigned to " + sq.name + " — " + next.billet + where + " (roster spreadsheet)");
                  issueOrders(id, actor, { unit: sq.name, hull: "", title: next.billet, department: next.element || sq.designation || "",
                    previous: wasAt, squadronName: sq.name, squadronLine: sq.designation ? sq.designation + " (" + sq.name + ")" : sq.name, quiet });
                  enqueueRoles(id);
                }
              } else if (JSON.stringify(next) !== JSON.stringify(mm)) {
                rowChg.push(sq.name + ": " + next.billet + (next.element ? " · " + next.element : "") + (next.tacsign ? " · " + next.tacsign : "") + (next.lead ? " · lead" : ""));
                if (!dryRun) {
                  for (const k of ["element", "tacsign", "lead"]) if (!(k in next)) delete mm[k];
                  Object.assign(mm, next);
                  logEntry(rec, actor.name, "squadron", sq.name + " billet updated: " + next.billet + where + " (roster spreadsheet)");
                }
              }
            }
          }
          /* a ship's station, by title, aboard the named hull */
          if (v.ship || v.station) {
            const ship = v.ship ? findShip(v.ship) : null;
            if (!ship) rowErr.push(v.ship ? "no such ship: " + v.ship : "a station needs its ship column");
            else if (!(adm || shipScopes.includes(ship.id))) rowErr.push("no authority over " + ship.name);
            else if (!v.station) rowErr.push("which station aboard " + ship.name + "?");
            else {
              let hit = null;
              for (const d of ship.departments) for (const st of d.stations)
                if (!hit && lc(st.title) === lc(v.station) && (st.assignee === id || !st.assignee)) hit = { ship, dept: d, st };
              if (!hit) rowErr.push("no vacant station titled " + v.station + " aboard " + ship.name);
              else if (hit.st.assignee !== id) { rowChg.push("station → " + hit.st.title + ", " + ship.name); if (!dryRun) assignStation(hit, id, actor, quiet, "csv"); }
            }
          }
          if (v.certs) {
            for (const name of v.certs.split(/[;|]/).map(s => s.trim()).filter(Boolean)) {
              const cert = findCert(name);
              if (!cert) { rowErr.push("no such certification: " + name); continue; }
              if (!(adm || rateScopes.includes(cert.id))) { rowErr.push("no authority to certify " + cert.name); continue; }
              if ((rec.certs || []).some(c => c.certId === cert.id)) continue;
              rowChg.push("certified: " + cert.name);
              if (!dryRun) { rec.certs.push({ certId: cert.id, at: Date.now(), by: actor.name, src: "csv" }); logEntry(rec, actor.name, "cert", "Certified: " + cert.name + " (roster spreadsheet)", { src: "csv" }); }
            }
          }
          if (v.ribbons) {
            if (!adm) rowErr.push("ribbons are management's to pin");
            else for (const name of v.ribbons.split(/[;|]/).map(s => s.trim()).filter(Boolean)) {
              const ribbon = (pdb.catalog.ribbons || []).find(x => x.id === lc(name) || lc(x.name) === lc(name));
              if (!ribbon) { rowErr.push("no such ribbon: " + name); continue; }
              if ((rec.ribbons || []).some(x => x.ribbonId === ribbon.id)) continue;
              rowChg.push("ribbon: " + ribbon.name);
              if (!dryRun) { rec.ribbons.push({ ribbonId: ribbon.id, at: Date.now(), by: actor.name, src: "csv" }); logEntry(rec, actor.name, "ribbon", "Ribbon: " + ribbon.name + " (roster spreadsheet)", { src: "csv" }); }
            }
          }
          if (v.rsi_handle && v.rsi_handle !== (acc.rsiHandle || "")) {
            if (!mayPerson) rowErr.push("rsi_handle: no authority over this member");
            else if (acc.rsiVerified) rowErr.push("rsi_handle is verified — it changes only by re-verification");
            else { rowChg.push("RSI handle → " + v.rsi_handle); if (!dryRun) acc.rsiHandle = v.rsi_handle.slice(0, 60); }
          }
          if (v.timezone && v.timezone !== (acc.timezone || "")) {
            if (!mayPerson) rowErr.push("timezone: no authority over this member");
            else { rowChg.push("timezone → " + v.timezone); if (!dryRun) acc.timezone = v.timezone.slice(0, 60); }
          }
          if (v.enlisted) {
            const when = parseWhen(v.enlisted);
            if (!when) rowErr.push("enlisted date unreadable: " + v.enlisted + " (DDMONYYYY, YYYY-MM-DD or MM/DD/YYYY)");
            else if (!adm) rowErr.push("enlisted date is management's to set");
            else if (Math.abs((acc.createdAt || 0) - when) > 864e5) {
              rowChg.push("enlisted → " + fleetDate(when));
              if (!dryRun) {
                acc.createdAt = when;
                const en = rec.record.find(e => e.kind === "enlist");
                if (en) { en.at = when; en.text = "Enlisted in the 22nd Expeditionary Fleet — " + fleetDate(when); rec.record.sort((x, y) => x.at - y.at); }
                else ensureEnlisted(id, when);
              }
            }
          }
          if (v.note) {
            if (!mayPerson) rowErr.push("note: no authority over this member");
            else { rowChg.push("note logged"); if (!dryRun) logEntry(rec, actor.name, "note", v.note.slice(0, 400)); }
          }
          if (rowChg.length) { out.applied++; if (created) out.created++; out.changes.push(label + ": " + rowChg.join("; ")); }
          for (const e of rowErr) out.errors.push(label + ": " + e);
        }
        if (!dryRun) { deps.persist(); persist("personnel"); persist("squadrons"); persist("roster"); }
      };
      if (dryRun) await work(); else await serializeMutation(work);
      if (!dryRun && out.applied) audit("import", "roster spreadsheet: " + out.applied + " updated, " + out.created + " added" +
        (out.errors.length ? ", " + out.errors.length + " refused" : ""));
      send(res, 200, out);
      return true;
    }

    /* ── RSI verification ── */
    if (p === "/api/rsi/start" && req.method === "POST" && !actor.bot) {
      const b = await body(req);
      const handle = String(b.handle || "").trim();
      if (need(/^[A-Za-z0-9_-]{3,30}$/.test(handle), 400, "an RSI handle is 3-30 letters, digits, - or _")) return true;
      const code = "22EF-" + Array.from(crypto.randomBytes(6)).map(x => RSI_ALPHABET[x % RSI_ALPHABET.length]).join("");
      actor.acc.rsiVerify = { handle, code, at: Date.now() };
      deps.persist();
      send(res, 200, { ok: true, handle, code, profileUrl: "https://robertsspaceindustries.com/citizens/" + handle,
        editUrl: "https://robertsspaceindustries.com/account/profile" });
      return true;
    }
    if (p === "/api/rsi/cancel" && req.method === "POST" && !actor.bot) {
      delete actor.acc.rsiVerify; deps.persist();
      send(res, 200, { ok: true });
      return true;
    }
    if (p === "/api/rsi/check" && req.method === "POST" && !actor.bot) {
      const pend = actor.acc.rsiVerify;
      if (need(pend && pend.code, 400, "start verification first")) return true;
      const wait = RSI_COOLDOWN - (Date.now() - (rsiLast.get(actor.id) || 0));
      if (need(wait <= 0, 429, "give RSI a moment — try again in " + Math.ceil(wait / 1000) + "s")) return true;
      rsiLast.set(actor.id, Date.now());
      let page;
      try { page = await rsiPage(pend.handle); }
      catch (e) { send(res, 502, { ok: false, error: "RSI is not answering right now — try again shortly" }); return true; }
      if (page.status === 404) { send(res, 200, { ok: true, verified: false, reason: "no citizen answers to " + pend.handle + " — check the handle" }); return true; }
      if (need(page.status === 200, 502, "RSI answered " + page.status + " — try again shortly")) return true;
      const text = htmlText(page.html);
      if (!text.includes(pend.code)) {
        send(res, 200, { ok: true, verified: false, reason: "the code is not on that profile yet — save the bio, give RSI a minute, try again" });
        return true;
      }
      const citizen = (/UEE Citizen Record\s+(#\d+)/i.exec(text) || [])[1] || null;
      const shown = (/Handle name\s+([A-Za-z0-9_-]+)/i.exec(text) || [])[1] || pend.handle;
      actor.acc.rsiHandle = shown; actor.acc.rsiVerified = { at: Date.now(), citizen };
      delete actor.acc.rsiVerify;
      logEntry(recFor(actor.id), "BUREAU OF NAVAL PERSONNEL", "note", "RSI account verified — " + shown + (citizen ? " (Citizen Record " + citizen + ")" : ""));
      audit("rsi", "verified " + shown + (citizen ? " " + citizen : ""));
      deps.persist(); persist("personnel");
      send(res, 200, { ok: true, verified: true, handle: shown, citizen });
      return true;
    }
    if ((m = /^\/api\/personnel\/([A-Za-z0-9-]{1,40})\/rsi$/.exec(p)) && req.method === "POST") {
      if (need(isAdmin(actor), 403, "management access required")) return true;
      const target = db.accounts[m[1]];
      if (need(target, 404, "no such member")) return true;
      const b = await body(req);
      if (b.revoke === true) { delete target.rsiVerified; audit("rsi", "verification revoked: " + (target.callsign || target.discordName)); }
      if (b.handle !== undefined) {
        const h = String(b.handle || "").trim().slice(0, 60);
        if (h !== (target.rsiHandle || "")) { target.rsiHandle = h || null; delete target.rsiVerified; audit("rsi", "handle set by management: " + (h || "—")); }
      }
      deps.persist();
      send(res, 200, { ok: true, profile: profile(m[1]) });
      return true;
    }

    if (p === "/api/catalog" && req.method === "GET") { send(res, 200, { ok: true, catalog: pdb.catalog }); return true; }
    if (p === "/api/catalog" && req.method === "POST") {
      if (need(isAdmin(actor), 403, "management access required")) return true;
      const b = await body(req);
      await serializeMutation(async () => {
        for (const key of ["ranks", "awards", "certs", "apps", "aotq", "issue", "ribbons"]) {
          if (!Array.isArray(b[key])) continue;
          const list = b[key].slice(0, 200).map(x => x && typeof x === "object" ? x : null).filter(Boolean);
          if (key === "ranks" && list.some(r => !r.grade || !r.name || !r.abbr)) throw new Error("every rank needs grade+name+abbr");
          if (key !== "ranks" && list.some(r => !r.id || !r.name)) throw new Error("every entry needs id+name");
          pdb.catalog[key] = list;
        }
        persist("catalog");
      });
      audit("catalog", "edited: " + ["ranks", "awards", "certs", "apps", "aotq", "issue", "ribbons"].filter(k => Array.isArray(b[k])).join(", "));
      send(res, 200, { ok: true, catalog: pdb.catalog });
      return true;
    }

    if (p === "/api/personnel" && req.method === "GET") {
      const roster = Object.keys(db.accounts).map(profile).filter(Boolean)
        .map(pr => redactProfile(pr, actor))
        .sort((a, b2) => rankIdx(b2.rank.abbr) - rankIdx(a.rank.abbr));
      send(res, 200, { ok: true, roster });
      return true;
    }
    if (p === "/api/personnel/me" && req.method === "GET" && !actor.bot) {
      send(res, 200, { ok: true, profile: profile(actor.id) });
      return true;
    }
    if ((m = /^\/api\/personnel\/([A-Za-z0-9-]{1,40})$/.exec(p)) && req.method === "GET") {
      const pr = profile(m[1]);
      if (need(pr, 404, "no such member")) return true;
      send(res, 200, { ok: true, profile: redactProfile(pr, actor) });
      return true;
    }

    /* ── the one-click, many-people door: awards, certs, rank moves, notes.
       Admins do anything; a rate:<certId> scope grants certifying exactly
       that rating and nothing else. ── */
    if (p === "/api/personnel/bulk" && req.method === "POST") {
      const b = await body(req);
      const scopedCert = b.action && b.action.type === "cert" &&
        rateScopeCerts(actor).includes(String(b.action.certId || ""));
      /* a head of department moves their own people to and from the
         Inactive Reserve; the per-member check below keeps it to their people */
      const scopedStatus = b.action && b.action.type === "status" && actorScopes(actor).length > 0;
      if (need(isAdmin(actor) || scopedCert || scopedStatus, 403, "management access required")) return true;
      const ids = Array.isArray(b.ids) ? b.ids.map(String).slice(0, 200) : [];
      const act = b.action && typeof b.action === "object" ? b.action : {};
      if (need(ids.length, 400, "ids[] is empty")) return true;
      const by = actor.name + (actor.bot && b.onBehalf ? " (for " + String(b.onBehalf).slice(0, 60) + ")" : "");
      const shout = [];   /* what the fleet bot announces on Discord */
      const results = await serializeMutation(async () => {
        const out = {};
        for (const id of ids) {
          if (!db.accounts[id]) { out[id] = { ok: false, error: "no such member" }; continue; }
          const rec = recFor(id);
          try {
            if (act.type === "award") {
              const award = pdb.catalog.awards.find(x => x.id === act.awardId);
              if (!award) throw new Error("unknown award");
              rec.awards.push({ awardId: award.id, at: Date.now(), by, citation: String(act.citation || "").slice(0, 400) });
              logEntry(rec, by, "award", "Awarded " + award.name + (act.citation ? " — " + act.citation : ""));
              shout.push({ discordId: id, name: displayName(id), award: award.name,
                citation: String(act.citation || "").slice(0, 400) });
            } else if (act.type === "cert") {
              const cert = pdb.catalog.certs.find(x => x.id === act.certId);
              if (!cert) throw new Error("unknown certification");
              if (!rec.certs.some(c => c.certId === cert.id)) {
                rec.certs.push({ certId: cert.id, at: Date.now(), by });
                logEntry(rec, by, "cert", "Certified: " + cert.name);
                shout.push({ discordId: id, name: displayName(id), cert: cert.name });
              }
            } else if (act.type === "rank") {
              const from = rec.rank;
              let idx = act.rank != null ? rankIdx(String(act.rank)) : rankStep(rec.rank, Number(act.step || 0));
              if (idx < 0 || idx >= pdb.catalog.ranks.length) throw new Error("no such rank");
              rec.rank = pdb.catalog.ranks[idx].abbr;
              if (rec.rank !== from) {
                logEntry(rec, by, "rank",
                  (rankIdx(rec.rank) > rankIdx(from) ? "Promoted " : "Reduced ") + from + " → " + rec.rank);
                const fromRank = pdb.catalog.ranks.find(r => r.abbr === from);
                shout.push({ discordId: id, name: displayName(id),
                  nick: (db.accounts[id] && db.accounts[id].discordName) || displayName(id),
                  fromRank: fromRank ? fromRank.name : from, toRank: pdb.catalog.ranks[idx].name,
                  toAbbr: pdb.catalog.ranks[idx].abbr,
                  promoted: rankIdx(rec.rank) > rankIdx(from) });
              }
            } else if (act.type === "note") {
              if (!String(act.text || "").trim()) throw new Error("empty note");
              logEntry(rec, by, "note", act.text);
            } else if (act.type === "ribbon") {
              const ribbon = (pdb.catalog.ribbons || []).find(x => x.id === act.ribbonId);
              if (!ribbon) throw new Error("unknown ribbon");
              if (!rec.ribbons.some(x => x.ribbonId === ribbon.id)) {
                rec.ribbons.push({ ribbonId: ribbon.id, at: Date.now(), by, note: String(act.note || "").slice(0, 200) });
                logEntry(rec, by, "ribbon", "Ribbon: " + ribbon.name + (act.note ? " — " + act.note : ""));
              }
            } else if (act.type === "status") {
              const to = act.status === "reserve" ? "reserve" : "active";
              if (!isAdmin(actor) && !canApproveFor(actor, id)) throw new Error("no authority over this member");
              const from = rec.status === "reserve" ? "reserve" : "active";
              if (to !== from) {
                rec.status = to;
                logEntry(rec, by, "status", to === "reserve" ? "Transferred to the Inactive Reserve"
                  : "Returned to active duty from the Inactive Reserve");
              }
            } else throw new Error("unknown action type");
            out[id] = { ok: true };
          } catch (e) { out[id] = { ok: false, error: e.message }; }
        }
        persist("personnel");
        return out;
      });
      if (shout.length && ["rank", "award", "cert"].includes(act.type)) {
        enqueue("announce", { kind: act.type, by, items: shout.slice(0, 50) });
        if (act.type === "rank") for (const s of shout) enqueueRoles(s.discordId);
      }
      audit("bulk " + act.type, ids.length + " selected, " +
        Object.values(results).filter(x => x.ok).length + " applied");
      send(res, 200, { ok: true, results });
      return true;
    }

    /* ── chain of command: a flat billet list the portal renders as a tree ── */
    if (p === "/api/coc" && req.method === "GET") {
      send(res, 200, { ok: true, nodes: Array.isArray(pdb.coc.nodes) ? pdb.coc.nodes : [] });
      return true;
    }
    if (p === "/api/coc" && req.method === "POST") {
      if (need(isAdmin(actor), 403, "management access required")) return true;
      const b = await body(req);
      const nodes = Array.isArray(b.nodes) ? b.nodes.slice(0, 200) : null;
      if (need(nodes, 400, "nodes[] required")) return true;
      const clean = nodes.map(n => ({
        id: String(n.id || "").slice(0, 40),
        title: String(n.title || "").slice(0, 80),
        /* a title card is a unit or office (CASCOM, IF-55) — it holds a spot
           in the chain but no person; a note rides on any node (Acting CO, LOA) */
        card: n.card === true,
        note: String(n.note || "").slice(0, 80),
        assignee: n.card === true ? null : (n.assignee ? String(n.assignee) : null),
        parent: n.parent ? String(n.parent) : null
      }));
      const ids = new Set(clean.map(n => n.id));
      if (need(clean.every(n => n.id && n.title), 400, "every billet needs id + title")) return true;
      if (need(ids.size === clean.length, 400, "duplicate billet ids")) return true;
      if (need(clean.every(n => !n.parent || ids.has(n.parent)), 400, "billet parent does not exist")) return true;
      for (const n of clean) {       /* a billet cannot descend from itself */
        const seen = new Set();
        for (let cur = n; cur && cur.parent; cur = clean.find(x => x.id === cur.parent)) {
          if (seen.has(cur.id)) { send(res, 400, { ok: false, error: "chain of command contains a cycle" }); return true; }
          seen.add(cur.id);
        }
      }
      await serializeMutation(async () => { pdb.coc.nodes = clean; persist("coc"); });
      audit("chain", "published " + clean.length + " billets");
      send(res, 200, { ok: true, nodes: clean });
      return true;
    }

    /* ── availability: painted per-day, a year at a time ── */
    if (p === "/api/availability/me" && req.method === "GET" && !actor.bot) {
      send(res, 200, { ok: true, days: (pdb.availability[actor.id] || {}).days || {} });
      return true;
    }
    if (p === "/api/availability" && req.method === "POST" && !actor.bot) {
      const b = await body(req);
      const patch = b.days && typeof b.days === "object" ? b.days : {};
      const mine = pdb.availability[actor.id] || (pdb.availability[actor.id] = { days: {} });
      let touched = 0;
      for (const [day, code] of Object.entries(patch)) {
        if (!DAY.test(day) || ++touched > 400) continue;
        if (code === null || code === "") delete mine.days[day];
        else if (CODES.has(code)) mine.days[day] = code;
      }
      persist("availability");
      send(res, 200, { ok: true, days: mine.days });
      return true;
    }
    if (p === "/api/availability/all" && req.method === "GET") {
      if (need(isAdmin(actor), 403, "management access required")) return true;
      const all = {};
      for (const [id, a2] of Object.entries(pdb.availability)) {
        const acc = db.accounts[id];
        if (acc) all[id] = { callsign: acc.callsign || acc.discordName, days: a2.days || {} };
      }
      send(res, 200, { ok: true, availability: all });
      return true;
    }

    /* ── events (the bot will mirror these into Discord) ── */
    if (p === "/api/events" && req.method === "GET") {
      const events = Object.entries(pdb.events).map(([id, e]) => Object.assign({ id }, e))
        .sort((a, b2) => a.at - b2.at);
      send(res, 200, { ok: true, events });
      return true;
    }
    if (p === "/api/events" && req.method === "POST") {
      if (need(isAdmin(actor), 403, "management access required")) return true;
      const b = await body(req);
      const at = Number(b.at);
      if (need(String(b.title || "").trim() && Number.isFinite(at), 400, "title + at (ms) required")) return true;
      const id = crypto.randomBytes(8).toString("hex");
      const endAt = Number(b.endAt);
      pdb.events[id] = { title: String(b.title).slice(0, 120), at,
        endAt: Number.isFinite(endAt) && endAt > at ? endAt : null,
        tier: String(b.tier || "OPERATION").slice(0, 40), brief: String(b.brief || "").slice(0, 2000),
        location: String(b.location || "").slice(0, 120),
        uniform: String(b.uniform || "").slice(0, 120),
        attention: (Array.isArray(b.attention) ? b.attention.map(String).slice(0, 12) : [])
          .filter(sid => squadronOf(sid)),
        by: actor.name, rsvp: {} };
      persist("events");
      audit("event", "posted: " + pdb.events[id].title);
      enqueue("event", { eventId: id });
      send(res, 200, { ok: true, id });
      return true;
    }
    if ((m = /^\/api\/events\/([a-f0-9]{16})\/delete$/.exec(p)) && req.method === "POST") {
      if (need(isAdmin(actor), 403, "management access required")) return true;
      if (need(pdb.events[m[1]], 404, "no such event")) return true;
      audit("event", "struck: " + pdb.events[m[1]].title);
      delete pdb.events[m[1]];
      persist("events");
      send(res, 200, { ok: true });
      return true;
    }
    /* send the Discord card again — a dropped job, a deleted message */
    if ((m = /^\/api\/events\/([a-f0-9]{16})\/repost$/.exec(p)) && req.method === "POST") {
      if (need(isAdmin(actor), 403, "management access required")) return true;
      if (need(pdb.events[m[1]], 404, "no such event")) return true;
      if (!pdb.discord.outbox.some(j => j.type === "event" && j.eventId === m[1]))
        enqueue("event", { eventId: m[1] });
      send(res, 200, { ok: true });
      return true;
    }
    /* sound the reminder NOW — the form-up call, on top of the scheduled sweep */
    if ((m = /^\/api\/events\/([a-f0-9]{16})\/remind$/.exec(p)) && req.method === "POST") {
      if (need(isAdmin(actor), 403, "management access required")) return true;
      if (need(pdb.events[m[1]], 404, "no such event")) return true;
      enqueue("remind-now", { eventId: m[1] });
      audit("event", "reminder sounded: " + pdb.events[m[1]].title);
      send(res, 200, { ok: true });
      return true;
    }
    if ((m = /^\/api\/events\/([a-f0-9]{16})\/rsvp$/.exec(p)) && req.method === "POST" && !actor.bot) {
      const b = await body(req);
      if (need(pdb.events[m[1]], 404, "no such event")) return true;
      if (need(["going", "maybe", "no"].includes(b.answer), 400, "answer must be going|maybe|no")) return true;
      pdb.events[m[1]].rsvp[actor.id] = b.answer;
      persist("events");
      /* the Discord card follows website RSVPs too — one refresh per drain */
      if (pdb.events[m[1]].discordMsg &&
          !pdb.discord.outbox.some(j => j.type === "event-update" && j.eventId === m[1]))
        enqueue("event-update", { eventId: m[1] });
      send(res, 200, { ok: true, rsvp: pdb.events[m[1]].rsvp });
      return true;
    }

    /* ── leave of absence: one active leave per member, history on the record ── */
    if (p === "/api/loa/me" && req.method === "GET" && !actor.bot) {
      const mine = pdb.loa[actor.id] || {};
      send(res, 200, { ok: true, active: mine.active || null, history: (mine.history || []).slice(0, 24) });
      return true;
    }
    if (p === "/api/loa/start" && req.method === "POST" && !actor.bot) {
      const b = await body(req);
      const mine = pdb.loa[actor.id] || (pdb.loa[actor.id] = { active: null, history: [] });
      if (need(!mine.active, 400, "already on leave — end the current LOA first")) return true;
      mine.active = { start: Date.now(), reason: String(b.reason || "").slice(0, 200) };
      logEntry(recFor(actor.id), actor.name, "loa",
        "Began leave of absence" + (mine.active.reason ? " — " + mine.active.reason : ""));
      persist("loa"); persist("personnel");
      send(res, 200, { ok: true, active: mine.active });
      return true;
    }
    if (p === "/api/loa/end" && req.method === "POST" && !actor.bot) {
      const mine = pdb.loa[actor.id];
      if (need(mine && mine.active, 400, "not on leave")) return true;
      mine.history.unshift({ start: mine.active.start, end: Date.now(), reason: mine.active.reason });
      mine.history = mine.history.slice(0, 24);
      mine.active = null;
      logEntry(recFor(actor.id), actor.name, "loa", "Returned from leave of absence");
      persist("loa"); persist("personnel");
      send(res, 200, { ok: true });
      return true;
    }
    if (p === "/api/loa" && req.method === "GET") {
      if (need(isAdmin(actor), 403, "management access required")) return true;
      const active = [];
      for (const [id, l] of Object.entries(pdb.loa)) {
        const acc = db.accounts[id];
        if (l.active && acc) active.push({ discordId: id, callsign: acc.callsign || acc.discordName,
          start: l.active.start, reason: l.active.reason });
      }
      active.sort((a, b2) => a.start - b2.start);
      send(res, 200, { ok: true, active });
      return true;
    }

    /* ── crew roster v2: ASSIGNMENT-ONLY (no self-claims — billets are given,
       not taken), any number of stations per member, per-ship editing rights
       via ship:<id> scopes. ── */
    if (p === "/api/roster" && req.method === "GET") {
      send(res, 200, { ok: true, ships: pdb.roster.ships });
      return true;
    }
    if (p === "/api/roster/assign" && req.method === "POST") {
      const b = await body(req);
      const hit = stationOf(String(b.stationId || ""));
      if (need(hit, 404, "no such station")) return true;
      if (need(canManageShip(actor, hit.ship.id), 403, "no roster authority for " + hit.ship.name)) return true;
      const member = b.memberId ? String(b.memberId) : null;
      if (need(!member || db.accounts[member], 404, "no such member")) return true;
      assignStation(hit, member, actor);
      audit("billet", (member ? displayName(member) + " → " : "vacated: ") + hit.st.title + ", " + hit.ship.name);
      persist("roster"); persist("personnel");
      send(res, 200, { ok: true });
      return true;
    }
    /* per-ship properties — individually editable so two editors don't
       clobber each other through wholesale /plan */
    if (p === "/api/roster/ship" && req.method === "POST") {
      const b = await body(req);
      const ship = pdb.roster.ships.find(s => s.id === String(b.id || ""));
      if (need(ship, 404, "no such ship")) return true;
      if (need(canManageShip(actor, ship.id), 403, "no roster authority for " + ship.name)) return true;
      if (b.status !== undefined && need(SHIP_STATUS.includes(b.status),
        400, "status must be one of: " + SHIP_STATUS.join(", "))) return true;
      if (b.name !== undefined) ship.name = String(b.name).slice(0, 80);
      if (b.classification !== undefined) ship.classification = String(b.classification).slice(0, 60);
      if (b.hullId !== undefined) ship.hullId = String(b.hullId).slice(0, 20);
      if (b.status !== undefined) ship.status = b.status;
      if (b.notes !== undefined) ship.notes = String(b.notes).slice(0, 1000);
      audit("ship", ship.name + " - particulars updated");
      persist("roster");
      send(res, 200, { ok: true, ship });
      return true;
    }
    if (p === "/api/roster/plan" && req.method === "POST") {
      if (need(isAdmin(actor), 403, "management access required")) return true;
      const b = await body(req);
      const ships = Array.isArray(b.ships) ? b.ships.slice(0, 12) : null;
      if (need(ships, 400, "ships[] required")) return true;
      const seen = new Set();
      let stations = 0;
      const clean = ships.map(ship => ({
        id: String(ship.id || "").slice(0, 40),
        name: String(ship.name || "").slice(0, 80),
        hullId: String(ship.hullId || ship.hull || "").slice(0, 20),
        classification: String(ship.classification || "").slice(0, 60),
        status: SHIP_STATUS.includes(ship.status) ? ship.status : "active",
        notes: String(ship.notes || "").slice(0, 1000),
        departments: (Array.isArray(ship.departments) ? ship.departments.slice(0, 20) : []).map(d => ({
          name: String(d.name || "").slice(0, 60),
          stations: (Array.isArray(d.stations) ? d.stations.slice(0, 40) : []).map(st => {
            stations++;
            return { id: String(st.id || "").slice(0, 80), title: String(st.title || "").slice(0, 80),
              /* unknown assignees are cleared, not trusted */
              assignee: st.assignee && db.accounts[String(st.assignee)] ? String(st.assignee) : null };
          })
        }))
      }));
      for (const ship of clean) {
        if (need(ship.id && ship.name, 400, "every ship needs id + name")) return true;
        for (const d of ship.departments) for (const st of d.stations) {
          if (need(st.id && st.title, 400, "every station needs id + title")) return true;
          if (need(!seen.has(st.id), 400, "duplicate station id: " + st.id)) return true;
          seen.add(st.id);
        }
      }
      if (need(stations <= 400, 400, "over 400 stations — trim the plan")) return true;
      await serializeMutation(async () => { pdb.roster.ships = clean; persist("roster"); });
      audit("structure", clean.length + " ships saved");
      send(res, 200, { ok: true, ships: clean });
      return true;
    }

    /* ── squadrons: first-class units parallel to the ships ── */
    if (p === "/api/squadrons" && req.method === "GET") {
      send(res, 200, { ok: true, squadrons: pdb.squadrons.squadrons });
      return true;
    }
    if (p === "/api/squadrons/plan" && req.method === "POST") {
      if (need(isAdmin(actor), 403, "management access required")) return true;
      const b = await body(req);
      const list = Array.isArray(b.squadrons) ? b.squadrons.slice(0, 24) : null;
      if (need(list, 400, "squadrons[] required")) return true;
      const seen = new Set();
      const clean = list.map(sq => ({
        id: String(sq.id || "").slice(0, 40),
        name: String(sq.name || "").slice(0, 60),
        designation: String(sq.designation || "").slice(0, 100),
        role: String(sq.role || "").slice(0, 200),
        members: (Array.isArray(sq.members) ? sq.members.slice(0, 200) : [])
          .map(mm => Object.assign({ discordId: String(mm.discordId || ""), billet: String(mm.billet || "").slice(0, 60) },
            mm.element ? { element: String(mm.element).slice(0, 40) } : {},
            mm.tacsign ? { tacsign: String(mm.tacsign).slice(0, 30) } : {},
            mm.lead === true ? { lead: true } : {}))
          .filter(mm => db.accounts[mm.discordId])
      }));
      for (const sq of clean) {
        if (need(sq.id && sq.name, 400, "every squadron needs id + name")) return true;
        if (need(!seen.has(sq.id), 400, "duplicate squadron id: " + sq.id)) return true;
        seen.add(sq.id);
      }
      await serializeMutation(async () => { pdb.squadrons.squadrons = clean; persist("squadrons"); });
      audit("structure", clean.length + " squadrons saved");
      send(res, 200, { ok: true, squadrons: clean });
      return true;
    }
    if ((m = /^\/api\/squadrons\/([a-z0-9-]{1,40})\/assign$/.exec(p)) && req.method === "POST") {
      const sq = squadronOf(m[1]);
      if (need(sq, 404, "no such squadron")) return true;
      if (need(canManageSquadron(actor, sq.id), 403, "no authority over " + sq.name)) return true;
      const b = await body(req);
      const member = String(b.memberId || "");
      if (need(db.accounts[member], 404, "no such member")) return true;
      const existing = sq.members.find(mm => mm.discordId === member);
      if (b.billet === null || b.billet === undefined || b.billet === "") {
        if (need(existing, 400, "not a member of " + sq.name)) return true;
        sq.members = sq.members.filter(mm => mm.discordId !== member);
        logEntry(recFor(member), actor.name, "squadron", "Detached from " + sq.name);
        enqueue("announce", { kind: "assignment", by: actor.name,
          items: [{ discordId: member, name: displayName(member), text: "Detached from " + sq.name }] });
        audit("assignment", displayName(member) + " detached from " + sq.name);
      } else {
        const billet = String(b.billet).slice(0, 60);
        const wasAt = currentBillet(member);
        const mm = existing || { discordId: member, billet };
        mm.billet = billet;
        /* Marine-style detail: the element (squad) they stand in, their
           tactical call sign, and whether they lead that element */
        if (b.element !== undefined) { const el = String(b.element || "").trim().slice(0, 40); if (el) mm.element = el; else delete mm.element; }
        if (b.tacsign !== undefined) { const ts = String(b.tacsign || "").trim().slice(0, 30); if (ts) mm.tacsign = ts; else delete mm.tacsign; }
        if (b.lead !== undefined) { if (b.lead === true || b.lead === "true") mm.lead = true; else delete mm.lead; }
        if (!existing) sq.members.push(mm);
        const where = mm.element ? " (" + mm.element + ")" : "";
        logEntry(recFor(member), actor.name, "squadron",
          (existing ? sq.name + " billet updated: " : "Assigned to " + sq.name + " — ") + billet + where);
        if (!existing || existing.billet !== billet) issueOrders(member, actor, { unit: sq.name, hull: "", title: billet,
          department: mm.element || sq.designation || "",
          previous: wasAt, squadronName: sq.name,
          squadronLine: sq.designation ? sq.designation + " (" + sq.name + ")" : sq.name });
        audit("assignment", displayName(member) + " -> " + sq.name + " (" + billet + ")");
      }
      enqueueRoles(member);
      persist("squadrons"); persist("personnel");
      send(res, 200, { ok: true, squadron: sq });
      return true;
    }
    if ((m = /^\/api\/squadrons\/([a-z0-9-]{1,40})$/.exec(p)) && req.method === "POST") {
      const sq = squadronOf(m[1]);
      if (need(sq, 404, "no such squadron")) return true;
      if (need(canManageSquadron(actor, sq.id), 403, "no authority over " + sq.name)) return true;
      const b = await body(req);
      if (b.name !== undefined) sq.name = String(b.name).slice(0, 60);
      if (b.designation !== undefined) sq.designation = String(b.designation).slice(0, 100);
      if (b.role !== undefined) sq.role = String(b.role).slice(0, 200);
      audit("squadron", sq.name + " - properties updated");
      persist("squadrons");
      send(res, 200, { ok: true, squadron: sq });
      return true;
    }

    /* ── self-submitted record entries: pending until someone with authority
       over that member approves — visible meanwhile only to owner and
       approvers ── */
    if (p === "/api/personnel/me/record" && req.method === "POST" && !actor.bot) {
      const b = await body(req);
      const text = String(b.text || "").trim().slice(0, 400);
      if (need(text, 400, "empty entry")) return true;
      const at = Number.isFinite(Number(b.at)) ? Number(b.at) : Date.now();
      const entry = { id: crypto.randomBytes(6).toString("hex"), at,
        by: actor.name, kind: String(b.kind || "note").toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 24) || "note",
        text, state: "pending" };
      recFor(actor.id).record.push(entry);
      persist("personnel");
      send(res, 200, { ok: true, entry });
      return true;
    }
    if ((m = /^\/api\/record\/([a-f0-9]{12})\/(approve|reject)$/.exec(p)) && req.method === "POST" && !actor.bot) {
      const b = await body(req);
      let owner = null, entry = null;
      for (const [id, rec] of Object.entries(pdb.personnel)) {
        const e = rec.record.find(x => x.id === m[1] && x.state === "pending");
        if (e) { owner = id; entry = e; break; }
      }
      if (need(entry, 404, "no such pending entry")) return true;
      if (need(canApproveFor(actor, owner), 403, "no approval authority for this member")) return true;
      /* nobody clears their own paperwork — unless they hold admin anyway */
      if (need(owner !== actor.id || isAdmin(actor), 403, "cannot approve your own entry")) return true;
      entry.state = m[2] === "approve" ? "approved" : "rejected";
      entry[m[2] === "approve" ? "approvedBy" : "rejectedBy"] = actor.name;
      if (b.note) entry.note = String(b.note).slice(0, 200);
      audit("record", (m[2] === "approve" ? "approved " : "rejected ") +
        ((db.accounts[owner] && (db.accounts[owner].callsign || db.accounts[owner].discordName)) || owner) + " entry");
      persist("personnel");
      send(res, 200, { ok: true, entry });
      return true;
    }
    if (p === "/api/record/pending" && req.method === "GET" && !actor.bot) {
      const queue = [];
      for (const [id, rec] of Object.entries(pdb.personnel)) {
        if (id === actor.id && !isAdmin(actor)) continue;
        if (!canApproveFor(actor, id)) continue;
        const acc = db.accounts[id];
        if (!acc) continue;
        for (const e of rec.record) if (e.state === "pending")
          queue.push({ discordId: id, callsign: acc.callsign || acc.discordName, entry: e });
      }
      queue.sort((a, b2) => a.entry.at - b2.entry.at);
      send(res, 200, { ok: true, queue });
      return true;
    }

    /* ── scoped authority + the itAdmin flag (no single point of failure) ── */
    if ((m = /^\/api\/personnel\/([A-Za-z0-9-]{1,40})\/scopes$/.exec(p)) && req.method === "POST") {
      if (need(isAdmin(actor), 403, "management access required")) return true;
      const target = db.accounts[m[1]];
      if (need(target, 404, "no such member")) return true;
      const b = await body(req);
      if (Array.isArray(b.scopes)) {
        const clean = b.scopes.slice(0, 40).map(String);
        for (const s of clean) {
          const mm = /^(ship|squadron|rate):([a-z0-9-]{1,40})$/.exec(s);
          if (need(mm, 400, "bad scope: " + s.slice(0, 60))) return true;
          const exists = mm[1] === "ship" ? pdb.roster.ships.some(x => x.id === mm[2])
            : mm[1] === "squadron" ? !!squadronOf(mm[2])
            : pdb.catalog.certs.some(x => x.id === mm[2]);
          if (need(exists, 400, "scope names nothing that exists: " + s)) return true;
        }
        target.scopes = clean;
      }
      if (typeof b.itAdmin === "boolean") {
        if (b.itAdmin === false && target.itAdmin === true) {
          const admins = Object.entries(db.accounts).filter(([id, acc]) =>
            acc.role === "command" || (acc.itAdmin === true && id !== m[1])).length;
          if (need(admins, 400, "cannot remove the fleet's last administrator")) return true;
        }
        target.itAdmin = b.itAdmin;
      }
      audit("keys", (target.callsign || target.discordName) + ": itAdmin=" + !!target.itAdmin +
        ", " + (target.scopes || []).length + " purview(s)");
      deps.persist();
      send(res, 200, { ok: true, profile: profile(m[1]) });
      return true;
    }
    if (p === "/api/me/permissions" && req.method === "GET" && !actor.bot) {
      const admin = isAdmin(actor);
      const scopes = actorScopes(actor);
      send(res, 200, { ok: true, admin, itAdmin: !!(actor.acc && actor.acc.itAdmin),
        command: !!actor.command, scopes, logistics: isLogistics(actor),
        canApprove: admin || scopes.length > 0,
        manage: {
          ships: admin ? "*" : scopes.filter(s => s.startsWith("ship:")).map(s => s.slice(5)),
          squadrons: admin ? "*" : scopes.filter(s => s.startsWith("squadron:")).map(s => s.slice(9)),
          certs: admin ? "*" : rateScopeCerts(actor)
        } });
      return true;
    }

    /* ── manual members: record shells for the crew that predates the Discord
       tie-in. They can never sign in (no session, no relay token, so the ACL
       sync never grants them the relay) — pure personnel records, flagged for
       a future Discord merge. ── */
    /* ── the site's callsign for a record: management sets it here; the app
       never touches it (its callsigns are per session). Also the repair path
       for accounts the app renamed before 2026-09-03. ── */
    let mcs;
    if ((mcs = /^\/api\/personnel\/([^/]+)\/callsign$/.exec(p)) && req.method === "POST") {
      if (need(isAdmin(actor), 403, "management access required")) return true;
      const acc = db.accounts[mcs[1]];
      if (need(acc, 404, "no such record")) return true;
      const b = await body(req);
      const callsign = String(b.callsign || "").trim().toUpperCase()
        .replace(/[^ A-Z0-9_.\-'"()[\]]+/g, "").slice(0, 40);
      if (need(callsign, 400, "callsign required")) return true;
      const was = acc.callsign || null;
      acc.callsign = callsign;
      logEntry(recFor(mcs[1]), actor.name, "note", "Callsign set to " + callsign + (was ? " (was " + was + ")" : ""));
      audit("muster", "callsign: " + (was || "\u2014") + " -> " + callsign);
      deps.persist(); persist("personnel");
      send(res, 200, { ok: true, profile: profile(mcs[1]) });
      return true;
    }
    if (p === "/api/personnel/add" && req.method === "POST") {
      if (need(isAdmin(actor), 403, "management access required")) return true;
      const b = await body(req);
      const callsign = String(b.callsign || "").trim().toUpperCase()
        .replace(/[^ A-Z0-9_.\-'"()[\]]+/g, "").slice(0, 40);
      if (need(callsign, 400, "callsign required")) return true;
      const id = "m-" + crypto.randomBytes(5).toString("hex");
      db.accounts[id] = { discordName: String(b.discordName || callsign).slice(0, 80),
        callsign, role: "member", manual: true, createdAt: Date.now() };
      const rec = recFor(id);
      if (b.rank !== undefined) {
        if (need(rankIdx(String(b.rank)) >= 0, 400, "no such rank")) { delete db.accounts[id]; return true; }
        rec.rank = String(b.rank);
      }
      logEntry(rec, actor.name, "note", "Record created manually (pre-Discord import)");
      audit("muster", "manual add: " + callsign);
      deps.persist(); persist("personnel");
      send(res, 200, { ok: true, profile: profile(id) });
      return true;
    }

    /* ── legacy roster import: the whole fleet in one order. Idempotent —
       members match by callsign (case-insensitive), existing records are
       UPDATED, never duplicated, and the import note is written once. Rank
       null means genuinely unknown and stays an honest "—" rather than a
       defaulted Starman Recruit; on-leave members arrive on leave. ── */
    /* the legacy roster bundle: on a live server it lives in the data dir,
       OUTSIDE the web root — 143 names, handles and timezones are not for
       anonymous download. Admins fetch it here; the dev rig falls back to
       the bundled static file. */
    if (p === "/api/personnel/import/bundle" && req.method === "GET") {
      if (need(isAdmin(actor), 403, "management access required")) return true;
      let bundle = null;
      try { bundle = deps.load("legacy-roster.json", null); } catch (e) { bundle = null; }
      if (need(bundle && Array.isArray(bundle.members), 404, "no legacy roster bundle in this server's data dir")) return true;
      send(res, 200, { ok: true, bundle });
      return true;
    }
    if (p === "/api/personnel/import" && req.method === "POST") {
      if (need(isAdmin(actor), 403, "management access required")) return true;
      const b = await body(req, 8 * 1048576);
      if (need(Array.isArray(b.members) && b.members.length && b.members.length <= 400,
        400, "members: an array of 1-400 entries")) return true;
      const dryRun = b.dryRun === true;
      const source = String(b.source || "the legacy fleet roster").slice(0, 80);
      const byDefault = String(b.by || source).slice(0, 80);
      const lc = (v) => String(v || "").toLowerCase();
      const findNamed = (list, v) => { const s = lc(v); return s ? (list || []).find(x => lc(x.id) === s || lc(x.name) === s) || null : null; };
      const findRank = (v) => pdb.catalog.ranks.find(r => lc(r.abbr) === lc(v) || lc(r.name) === lc(v));
      const findSquadron = (v) => pdb.squadrons.squadrons.find(s => s.id === lc(v) || lc(s.name) === lc(v) || lc(s.designation) === lc(v));
      const findShip = (v) => pdb.roster.ships.find(s => s.id === lc(v) || lc(s.name) === lc(v));
      const when = (v) => { const t = v == null || v === "" ? null : parseWhen(v); return t == null ? Date.now() : t; };
      const day = (t) => Math.floor(Number(t) / 864e5);
      const byCallsign = new Map();
      for (const [aid, acc] of Object.entries(db.accounts)) if (acc.callsign) byCallsign.set(String(acc.callsign).toUpperCase(), aid);
      const out = { ok: true, dryRun, source, created: 0, updated: 0, applied: 0, errors: [], changes: [] };
      const work = async () => {
        for (const raw of b.members) {
          const mm = raw && typeof raw === "object" ? raw : {};
          const callsign = String(mm.callsign || "").trim().toUpperCase().replace(/[^ A-Z0-9_.\-'"()[\]]+/g, "").slice(0, 40);
          const did = mm.discordId != null ? String(mm.discordId).trim() : "";
          if (!callsign && !did) { out.errors.push("entry without a callsign or discordId"); continue; }
          const label = callsign || did;
          /* the rank gate stays as the legacy import had it: an unknown rank
             names the gap and that member waits for the ladder */
          const rankGiven = mm.rank !== undefined && mm.rank !== null && String(mm.rank).trim() !== "";
          const rk = rankGiven ? findRank(mm.rank) : null;
          if (rankGiven && !rk) { out.errors.push(label + ": no such rank " + mm.rank); continue; }
          const chg = [], err = [];
          /* the loader may name the exact record to update (a stand-in matched by
             hand or by fuzzy name); otherwise the Discord id, then the name */
          const matchId = mm.matchId != null && db.accounts[String(mm.matchId)] ? String(mm.matchId) : null;
          let id = did && db.accounts[did] ? did : (matchId || (callsign ? byCallsign.get(callsign) : null));
          let created = false;
          if (!id) {
            if (!callsign) { out.errors.push(did + ": no account by that Discord id and no callsign to file a record"); continue; }
            /* a known Discord id files the record under it: when they sign in
               they walk straight into their own record — no queue, no merge */
            id = did && /^\d{15,22}$/.test(did) ? did : (did && /^\d{4,14}$/.test(did) ? did : "m-" + crypto.randomBytes(5).toString("hex"));
            created = true;
            if (!dryRun) {
              db.accounts[id] = { discordName: String(mm.discordName || callsign).slice(0, 80), callsign,
                role: "member", manual: true, createdAt: Date.now() };
              byCallsign.set(callsign, id);
            }
            chg.push("added to the rolls");
          }
          /* a name-matched stand-in record with a Discord id in hand is re-filed
             under that id, so the arrival walks straight into it */
          if (!created && did && /^\d{4,22}$/.test(did) && id !== did && !db.accounts[did] && String(id).startsWith("m-")) {
            chg.push("filed under Discord id " + did);
            if (!dryRun) {
              const old = db.accounts[id];
              db.accounts[did] = { discordName: String(mm.discordName || old.discordName || callsign).slice(0, 80), callsign: old.callsign || callsign,
                role: old.role || "member", manual: true, createdAt: old.createdAt || Date.now() };
              mergeAccounts(id, did, byDefault);
              byCallsign.set(String(db.accounts[did].callsign || callsign).toUpperCase(), did);
              id = did;
            }
          }
          const acc = created && dryRun ? { callsign } : db.accounts[id];
          const rec = created && dryRun ? { rank: "—", awards: [], certs: [], ribbons: [], record: [], orders: [] } : recFor(id);
          if (!Array.isArray(rec.orders)) rec.orders = [];
          const pushRec = (at, who, kind, text) => rec.record.push({ at, by: String(who || byDefault).slice(0, 80), kind, text: String(text).slice(0, 400), src: source });
          const setField = (obj, k, v, what) => { if (obj[k] !== v) { chg.push(what + " → " + (v === true ? "yes" : v === false ? "no" : v)); if (!dryRun) obj[k] = v; } };
          if (callsign && !created && callsign !== String(acc.callsign || "").toUpperCase()) {
            chg.push("name → " + callsign); if (!dryRun) { acc.callsign = callsign; byCallsign.set(callsign, id); }
          }
          if (mm.discordName != null && !created) setField(acc, "discordName", String(mm.discordName).slice(0, 80), "discord name");
          if (mm.discordUser != null) setField(acc, "discordUser", String(mm.discordUser).slice(0, 40), "@handle");
          if (mm.rsiHandle != null) setField(acc, "rsiHandle", String(mm.rsiHandle).slice(0, 60), "RSI handle");
          if (mm.timezone != null) setField(acc, "timezone", String(mm.timezone).slice(0, 60), "timezone");
          if (mm.contractor !== undefined) setField(acc, "contractor", mm.contractor === true, "contractor");
          if (mm.joinedAt != null && mm.joinedAt !== "") {
            const t = parseWhen(mm.joinedAt);
            if (t == null) err.push("joinedAt unreadable: " + mm.joinedAt);
            else if (Math.abs((acc.createdAt || 0) - t) > 864e5) {
              chg.push("enlisted → " + fleetDate(t));
              if (!dryRun) {
                acc.createdAt = t;
                const en = rec.record.find(e => e.kind === "enlist");
                if (en) { en.at = t; en.text = "Enlisted in the 22nd Expeditionary Fleet — " + fleetDate(t); }
              }
            }
          }
          if (!dryRun) { if (created) rec.rank = "—"; ensureEnlisted(id, acc.createdAt || Date.now()); }
          if (rk && rk.abbr !== rec.rank) { chg.push("rank → " + rk.abbr); if (!dryRun) rec.rank = rk.abbr; }
          if (mm.rating != null) setField(rec, "rating", String(mm.rating).slice(0, 12), "rating");
          if (mm.status != null) {
            const to = /reserve|inactive/i.test(String(mm.status)) ? "reserve" : "active";
            if (to !== (rec.status === "reserve" ? "reserve" : "active")) { chg.push("status → " + to); if (!dryRun) rec.status = to; }
          }
          /* collateral duties and officer designators: plain lists on the record */
          for (const [k, what] of [["duties", "duties"], ["designators", "designators"]]) {
            if (!Array.isArray(mm[k])) continue;
            const list = mm[k].map(x => String(x || "").trim().slice(0, 60)).filter(Boolean).slice(0, 20);
            if (JSON.stringify(list) !== JSON.stringify(rec[k] || [])) { chg.push(what + " → " + (list.join(", ") || "none")); if (!dryRun) rec[k] = list; }
          }
          /* the old site's own RSI verification carries over as verified-by-source */
          if (mm.rsiVerified === true && !acc.rsiVerified && (mm.rsiHandle || acc.rsiHandle)) {
            chg.push("RSI verified (by " + source + ")");
            if (!dryRun) acc.rsiVerified = { at: Date.now(), citizen: null, via: source };
          }
          /* leave: true, {since, reason}, or absent = not on leave (a carried-over leave ends) */
          {
            const l = pdb.loa[id] || { active: null, history: [] };
            const want = mm.loa === true || (mm.loa && typeof mm.loa === "object");
            if (want && !l.active) {
              chg.push("on leave");
              if (!dryRun) { pdb.loa[id] = l; l.active = { start: when((mm.loa && mm.loa.since) || mm.loaSince),
                reason: String((mm.loa && mm.loa.reason) || "Carried over from " + source).slice(0, 200) }; }
            } else if (!want && l.active && /^Carried over/.test(String(l.active.reason || ""))) {
              chg.push("leave ended");
              if (!dryRun) { pdb.loa[id] = l; l.history.unshift({ start: l.active.start, end: Date.now(), reason: l.active.reason }); l.active = null; }
            }
          }
          for (const s of Array.isArray(mm.squadrons) ? mm.squadrons.slice(0, 12) : []) {
            const sqName = s && (s.squadron || s.name || s.id);
            const sq = findSquadron(sqName);
            if (!sq) { err.push("no such squadron: " + sqName); continue; }
            const cur = sq.members.find(x => x.discordId === id);
            const next = Object.assign({}, cur || { discordId: id, billet: "Member" });
            if (s.billet) next.billet = String(s.billet).slice(0, 60);
            if (s.element) next.element = String(s.element).slice(0, 40);
            if (s.tacsign) next.tacsign = String(s.tacsign).slice(0, 30);
            if (s.lead !== undefined) { if (s.lead === true) next.lead = true; else delete next.lead; }
            const where = next.element ? " (" + next.element + ")" : "";
            if (!cur) {
              chg.push("mustered into " + sq.name + " — " + next.billet + where);
              if (!dryRun) { next.src = source; sq.members.push(next); pushRec(when(s.at), s.by, "squadron", "Assigned to " + sq.name + " — " + next.billet + where); }
            } else if (JSON.stringify(next) !== JSON.stringify(cur)) {
              chg.push(sq.name + ": " + next.billet + where);
              if (!dryRun) { for (const k of ["element", "tacsign", "lead"]) if (!(k in next)) delete cur[k]; Object.assign(cur, next); cur.src = cur.src || source; }
            }
          }
          for (const s of Array.isArray(mm.stations) ? mm.stations.slice(0, 6) : []) {
            const ship = findShip(s && s.ship);
            if (!ship) { err.push("no such ship: " + (s && s.ship)); continue; }
            let hit = null;
            for (const d of ship.departments) for (const st of d.stations)
              if (!hit && lc(st.title) === lc(s.station) && (st.assignee === id || !st.assignee)) hit = { ship, dept: d, st };
            if (!hit) { err.push("no vacant station titled " + (s && s.station) + " aboard " + ship.name); continue; }
            if (hit.st.assignee !== id) {
              chg.push("station → " + hit.st.title + ", " + ship.name);
              if (!dryRun) { hit.st.assignee = id; hit.st.src = source; pushRec(when(s.at), s.by, "station", "Assigned to station: " + hit.st.title + ", " + ship.name); }
            }
          }
          for (const c of Array.isArray(mm.certs) ? mm.certs.slice(0, 40) : []) {
            const co = typeof c === "string" ? { cert: c } : (c || {});
            const cert = findNamed(pdb.catalog.certs, co.cert || co.name || co.id);
            if (!cert) { err.push("no such certification: " + (co.cert || co.name || co.id)); continue; }
            if (rec.certs.some(x => x.certId === cert.id)) continue;
            chg.push("certified: " + cert.name);
            if (!dryRun) { const t = when(co.at); rec.certs.push({ certId: cert.id, at: t, by: String(co.by || byDefault).slice(0, 80), src: source }); pushRec(t, co.by, "cert", "Certified: " + cert.name); }
          }
          for (const a of Array.isArray(mm.awards) ? mm.awards.slice(0, 60) : []) {
            const ao = typeof a === "string" ? { award: a } : (a || {});
            const award = findNamed(pdb.catalog.awards, ao.award || ao.name || ao.id);
            if (!award) { err.push("no such award: " + (ao.award || ao.name || ao.id)); continue; }
            const t = when(ao.at);
            if (rec.awards.some(x => x.awardId === award.id && day(x.at) === day(t))) continue;
            chg.push("awarded: " + award.name);
            if (!dryRun) {
              rec.awards.push({ awardId: award.id, at: t, by: String(ao.by || byDefault).slice(0, 80), citation: String(ao.citation || "").slice(0, 400), src: source });
              pushRec(t, ao.by, "award", "Awarded " + award.name + (ao.citation ? " — " + ao.citation : ""));
            }
          }
          for (const rb of Array.isArray(mm.ribbons) ? mm.ribbons.slice(0, 60) : []) {
            const ro = typeof rb === "string" ? { ribbon: rb } : (rb || {});
            const ribbon = findNamed(pdb.catalog.ribbons, ro.ribbon || ro.name || ro.id);
            if (!ribbon) { err.push("no such ribbon: " + (ro.ribbon || ro.name || ro.id)); continue; }
            const t = when(ro.at);
            if (rec.ribbons.some(x => x.ribbonId === ribbon.id && day(x.at) === day(t))) continue;
            chg.push("ribbon: " + ribbon.name);
            if (!dryRun) {
              rec.ribbons.push({ ribbonId: ribbon.id, at: t, by: String(ro.by || byDefault).slice(0, 80), note: String(ro.note || "").slice(0, 200), src: source });
              pushRec(t, ro.by, "ribbon", "Ribbon: " + ribbon.name + (ro.note ? " — " + ro.note : ""));
            }
          }
          for (const e of Array.isArray(mm.record) ? mm.record.slice(0, 200) : []) {
            const text = String((e && e.text) || "").trim().slice(0, 400); if (!text) continue;
            const t = when(e.at);
            const kind = String((e && e.kind) || "note").toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 24) || "note";
            if (rec.record.some(x => x.kind === kind && day(x.at) === day(t) && x.text === text)) continue;
            chg.push("record: " + kind);
            if (!dryRun) pushRec(t, e.by, kind, text);
          }
          for (const o of Array.isArray(mm.orders) ? mm.orders.slice(0, 50) : []) {
            const text = String((o && o.text) || "").trim().slice(0, 6000), title = String((o && o.title) || "").trim().slice(0, 80);
            if (!text || !title) continue;
            const t = when(o.at);
            if (rec.orders.some(x => day(x.at) === day(t) && x.title === title)) continue;
            chg.push("orders: " + title);
            if (!dryRun) rec.orders.push({ id: crypto.randomBytes(6).toString("hex"), at: t, by: String((o && o.by) || byDefault).slice(0, 80),
              unit: String((o && o.unit) || "").slice(0, 80), title, text, src: source });
          }
          if (created && !dryRun) rec.record.push({ at: Date.now(), by: byDefault, kind: "note", text: "Imported from " + source, src: source });
          if (!dryRun) {
            rec.record.sort((x, y) => x.at - y.at);
            if (rec.record.length > 500) rec.record.splice(0, rec.record.length - 500);
            rec.orders.sort((x, y) => y.at - x.at);
            if (rec.orders.length > 50) rec.orders.length = 50;
          }
          if (chg.length) { out.applied++; out.changes.push(label + ": " + chg.join("; ")); }
          for (const e of err) out.errors.push(label + ": " + e);
          out[created ? "created" : "updated"]++;
        }
        if (!dryRun) { deps.persist(); persist("personnel"); persist("loa"); persist("squadrons"); persist("roster"); }
      };
      if (dryRun) await work(); else await serializeMutation(work);
      if (!dryRun) audit("import", source + ": " + out.created + " added, " + out.updated + " updated" + (out.errors.length ? ", " + out.errors.length + " noted" : ""));
      send(res, 200, out);
      return true;
    }

    /* ── editable public copy: publish a block, restore a version, clear it ── */
    if (p === "/api/content" && req.method === "POST" && !actor.bot) {
      if (need(isAdmin(actor), 403, "management access required")) return true;
      const b = await body(req, 262144);
      const key = String(b.key || "").trim().slice(0, 120);
      if (need(/^[A-Za-z0-9._:#-]{3,120}$/.test(key), 400, "bad block key")) return true;
      const cur = pdb.content.blocks[key];
      if (b.clear === true) {
        if (cur) {
          pdb.content.history.push({ key, page: cur.page, html: "", at: Date.now(), by: actor.name, v: (cur.v || 0) + 1, cleared: true });
          delete pdb.content.blocks[key];
        }
        persist("content"); audit("copy", "printed copy restored: " + key);
        send(res, 200, { ok: true, cleared: true });
        return true;
      }
      const page = String(b.page || (cur && cur.page) || "").slice(0, 40);
      const orig = String(b.orig || (cur && cur.orig) || "").slice(0, 200);
      let html;
      if (b.restore !== undefined) {
        const ver = pdb.content.history.find(h => h.key === key && h.v === Number(b.restore) && !h.cleared);
        if (need(ver, 404, "no such version")) return true;
        html = ver.html;
      } else html = cleanHtml(b.html);
      if (need(typeof html === "string" && html.trim(), 400, "empty copy — use clear to go back to the printed text")) return true;
      const v = (cur ? cur.v : 0) + 1;
      pdb.content.blocks[key] = { html, page, orig, at: Date.now(), by: actor.name, v };
      pdb.content.history.push({ key, page, html, at: Date.now(), by: actor.name, v });
      if (pdb.content.history.length > 3000) pdb.content.history.splice(0, pdb.content.history.length - 3000);
      persist("content");
      audit("copy", (page || "site") + " · " + (orig.slice(0, 60) || key) + " · v" + v);
      send(res, 200, { ok: true, block: pdb.content.blocks[key] });
      return true;
    }
    if (p === "/api/content/history" && req.method === "GET" && !actor.bot) {
      if (need(isAdmin(actor), 403, "management access required")) return true;
      const key = String(url.searchParams.get("key") || "");
      const versions = pdb.content.history.filter(h => h.key === key).slice(-30).reverse()
        .map(h => ({ v: h.v, at: h.at, by: h.by, cleared: !!h.cleared, text: htmlText(h.html).slice(0, 200), html: h.html }));
      send(res, 200, { ok: true, key, current: pdb.content.blocks[key] || null, versions });
      return true;
    }

    /* ── go-live reset: back to the imported baseline. What a test session
       left behind goes; what the fleet imported, every account, every
       session and the whole ledger stays. A dry run unless confirm=RESET. ── */
    if (p === "/api/admin/reset-baseline" && req.method === "POST" && !actor.bot) {
      if (need(isAdmin(actor), 403, "management access required")) return true;
      const b = await body(req);
      const apply = b.confirm === "RESET" && b.dryRun !== true;
      const withEvents = b.events === true, withChain = b.chain === true;
      const kept = (x) => !!(x && x.src);
      const inv = {
        logistics: { orders: LG.orders.length, contributions: LG.contributions.length, claims: LG.claims.length,
          inventory: LG.inventory.length, catalog: LG.catalog.length, blueprints: LG.blueprints.length },
        mast: pdb.mast.cases.length,
        outbox: pdb.discord.outbox.length,
        scopes: Object.entries(db.accounts).filter(([, a]) => Array.isArray(a.scopes) && a.scopes.length)
          .map(([id2, a]) => (a.callsign || a.discordName || id2) + " (" + a.scopes.length + ")"),
        itAdmins: Object.values(db.accounts).filter(a => a.itAdmin === true).length,
        records: { entries: 0, awards: 0, certs: 0, ribbons: 0, orders: 0, members: 0 },
        seats: { stations: [], musters: [] },
        availability: Object.keys(pdb.availability).length,
        events: withEvents ? Object.keys(pdb.events).length : null,
        chain: withChain ? (pdb.coc.nodes || []).filter(n => n.assignee).length : null,
      };
      for (const rec of Object.values(pdb.personnel)) {
        const e = (rec.record || []).filter(x => x.kind !== "enlist" && !kept(x)).length;
        const a = (rec.awards || []).filter(x => !kept(x)).length, c = (rec.certs || []).filter(x => !kept(x)).length;
        const rb = (rec.ribbons || []).filter(x => !kept(x)).length, o = (rec.orders || []).filter(x => !kept(x)).length;
        if (e + a + c + rb + o) inv.records.members++;
        inv.records.entries += e; inv.records.awards += a; inv.records.certs += c; inv.records.ribbons += rb; inv.records.orders += o;
      }
      for (const ship of pdb.roster.ships) for (const d of ship.departments || []) for (const st of d.stations || [])
        if (st.assignee && !st.src) inv.seats.stations.push(st.title + ", " + ship.name + " — " + displayName(st.assignee));
      for (const sq of pdb.squadrons.squadrons) for (const mm of sq.members) if (!mm.src) inv.seats.musters.push(sq.name + " — " + displayName(mm.discordId));
      if (apply) {
        await serializeMutation(async () => {
          for (const k of ["orders", "contributions", "claims", "inventory", "catalog", "blueprints"]) LG[k] = [];
          pdb.mast.cases = []; pdb.discord.outbox = [];
          for (const a of Object.values(db.accounts)) if (Array.isArray(a.scopes) && a.scopes.length) a.scopes = [];
          for (const rec of Object.values(pdb.personnel)) {
            rec.record = (rec.record || []).filter(x => x.kind === "enlist" || kept(x));
            rec.awards = (rec.awards || []).filter(kept); rec.certs = (rec.certs || []).filter(kept);
            rec.ribbons = (rec.ribbons || []).filter(kept); rec.orders = (rec.orders || []).filter(kept);
          }
          for (const ship of pdb.roster.ships) for (const d of ship.departments || []) for (const st of d.stations || [])
            if (st.assignee && !st.src) st.assignee = null;
          for (const sq of pdb.squadrons.squadrons) sq.members = sq.members.filter(mm => !!mm.src);
          for (const k of Object.keys(pdb.availability)) delete pdb.availability[k];
          if (withEvents) for (const k of Object.keys(pdb.events)) delete pdb.events[k];
          if (withChain) for (const n of (pdb.coc.nodes || [])) n.assignee = null;
          for (const s of ["logistics", "mast", "discord", "personnel", "roster", "squadrons", "availability", "events", "coc"]) persist(s);
          deps.persist();
        });
        audit("reset-baseline", "logistics " + Object.values(inv.logistics).reduce((s, n) => s + n, 0) + ", mast " + inv.mast +
          ", outbox " + inv.outbox + ", purviews " + inv.scopes.length + ", record items " +
          (inv.records.entries + inv.records.awards + inv.records.certs + inv.records.ribbons + inv.records.orders) +
          ", seats " + (inv.seats.stations.length + inv.seats.musters.length) +
          (withEvents ? ", events " + inv.events : "") + (withChain ? ", chain " + inv.chain : ""));
      }
      send(res, 200, { ok: true, dryRun: !apply, inventory: inv });
      return true;
    }

    /* ── one-file fleet backup (humans with admin only — no secrets inside) ── */
    if (p === "/api/export" && req.method === "GET" && !actor.bot) {
      if (need(isAdmin(actor), 403, "management access required")) return true;
      const accounts = {};
      for (const [id, acc] of Object.entries(db.accounts)) accounts[id] = {
        discordName: acc.discordName, callsign: acc.callsign || null, role: acc.role,
        manual: acc.manual === true, itAdmin: acc.itAdmin === true,
        contractor: acc.contractor === true,
        rsiHandle: acc.rsiHandle || null, rsiVerified: acc.rsiVerified || null, timezone: acc.timezone || null,
        discordUser: acc.discordUser || null,
        scopes: Array.isArray(acc.scopes) ? acc.scopes : [],
        createdAt: acc.createdAt || null, lastSeen: acc.lastSeen || null };
      send(res, 200, { ok: true, exportedAt: Date.now(), accounts,
        personnel: pdb.personnel, catalog: pdb.catalog, coc: pdb.coc,
        availability: pdb.availability, events: pdb.events, loa: pdb.loa,
        roster: pdb.roster, squadrons: pdb.squadrons });
      return true;
    }

    /* ── SSO grant: the portal asks for a launch code, hands it to the app ── */
    if (p === "/api/sso/grant" && req.method === "POST" && !actor.bot) {
      const b = await body(req);
      send(res, 200, { ok: true, code: mintSso(actor.id, b.app), expiresInMs: SSO_TTL });
      return true;
    }

    /* ── activity feed: the bot's window into the service record ── */
    if (p === "/api/activity" && req.method === "GET") {
      if (need(isAdmin(actor), 403, "management access required")) return true;
      const since = Number(url.searchParams.get("since") || 0);
      const feed = [];
      for (const [id, rec] of Object.entries(pdb.personnel)) {
        const acc = db.accounts[id];
        if (!acc) continue;
        for (const entry of rec.record) if (entry.at > since)
          feed.push(Object.assign({ discordId: id, callsign: acc.callsign || acc.discordName }, entry));
      }
      feed.sort((a, b2) => b2.at - a.at);
      send(res, 200, { ok: true, feed: feed.slice(0, 200),
        lastSeen: Object.entries(db.accounts).map(([id, a2]) => ({ discordId: id,
          callsign: a2.callsign || a2.discordName, lastSeen: a2.lastSeen || null })) });
      return true;
    }

    /* the portal namespace is OURS: an unmatched path here is a 404, never a
       fall-through into the host's legacy routing (whose COMMAND gate would
       turn a removed portal route into a misleading 403) */
    send(res, 404, { ok: false, error: "no such route" });
    return true;
  }

  return { handle, cors, onStanding };
};
