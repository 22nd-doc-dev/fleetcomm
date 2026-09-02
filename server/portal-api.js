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
    logistics: record(load("logistics.json", {}), "logistics.json")      // {catalog[], inventory[], orders[], contributions[], claims[], blueprints[]}
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
      "c. Report to the Commanding Officer, " + sq.name + ".", "",
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
    enqueue("orders", { discordId: id, name: displayName(id), text });
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
  if (!LG.blueprints.length) LG.blueprints = [
    { id: "10-series-greatsword", name: "10-Series Greatsword Cannon", type: "Vehicle Weapon", materials: "3 materials", sources: "12 drop sources" },
    { id: "11-series-broadsword", name: "11-Series Broadsword Cannon", type: "Vehicle Weapon", materials: "3 materials", sources: "12 drop sources" },
    { id: "7ma-lorica", name: "7MA 'Lorica' Shield Generator", type: "Shield", materials: "3 materials", sources: "6 drop sources" },
    { id: "fr-86", name: "FR-86 Shield Generator", type: "Shield", materials: "3 materials", sources: "8 drop sources" },
    { id: "atlas-qd", name: "Atlas Quantum Drive", type: "Component S2", materials: "4 materials", sources: "9 drop sources" },
  ];
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
  function recFor(id) {
    if (!pdb.personnel[id]) pdb.personnel[id] = { rank: pdb.catalog.ranks[0].abbr, awards: [], certs: [], record: [] };
    return pdb.personnel[id];
  }
  function logEntry(rec, by, kind, text) {
    rec.record.push({ at: Date.now(), by, kind, text: String(text).slice(0, 400) });
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
      rank: rankByAbbr(rec.rank) || { grade: "?", name: rec.rank, abbr: rec.rank },
      /* the rated form of the rank (BMMC, GM1, QMSC…) — display trumps ladder */
      rating: rec.rating || null, serviceNo: rec.serviceNo || null, orders: rec.orders || [],
      awards: rec.awards, certs: rec.certs, record: rec.record
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
    return Object.assign({}, pr, { record: pr.record.filter(e =>
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
        acc.discordName = (member && member.nick) || who.username;
        if (member && Array.isArray(member.roles)) acc.guildRoles = member.roles;
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
          aor: pdb.fleet.aor, dutyStation: pdb.fleet.dutyStation, battlegroup: pdb.fleet.battlegroup },
        ships: pdb.roster.ships.map(s => ({
          id: s.id, name: s.name, classification: s.classification || "",
          hullId: s.hullId || "", status: s.status || "active",
        })),
        squadrons: pdb.squadrons.squadrons.map(s => ({
          id: s.id, name: s.name, designation: s.designation || "", role: s.role || "",
        })),
        ranks: (pdb.catalog.ranks || []).filter(r => !r.hidden)
          .map(r => ({ grade: r.grade, name: r.name, abbr: r.abbr })),
        certs: (pdb.catalog.certs || []).filter(c => !c.hidden).map(c => ({ id: c.id, name: c.name })),
        awards: (pdb.catalog.awards || []).filter(a => !a.hidden)
          .map(a => ({ id: a.id, name: a.name, img: a.img || "" })),
      });
      return true;
    }

    /* everything below needs an operator session or the bot secret */
    const actor = actorOf(req);
    const need = (ok, code, msg) => { if (!ok) { send(res, code, { ok: false, error: msg }); return true; } return false; };
    if (!/^\/api\/(catalog|personnel|coc|availability|events|sso|activity|loa|roster|squadrons|record|export|bot|cam-viewers|audit|fleet|mast|logistics|uex|me\/permissions)/.test(p)) return false;
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
      const viewers = Object.values(db.accounts)
        .filter(a2 => ["element", "command"].includes(a2.role) && a2.callsign)
        .map(a2 => a2.callsign);
      send(res, 200, { ok: true, viewers });
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

    if (p === "/api/catalog" && req.method === "GET") { send(res, 200, { ok: true, catalog: pdb.catalog }); return true; }
    if (p === "/api/catalog" && req.method === "POST") {
      if (need(isAdmin(actor), 403, "management access required")) return true;
      const b = await body(req);
      await serializeMutation(async () => {
        for (const key of ["ranks", "awards", "certs", "apps", "aotq", "issue"]) {
          if (!Array.isArray(b[key])) continue;
          const list = b[key].slice(0, 200).map(x => x && typeof x === "object" ? x : null).filter(Boolean);
          if (key === "ranks" && list.some(r => !r.grade || !r.name || !r.abbr)) throw new Error("every rank needs grade+name+abbr");
          if (key !== "ranks" && list.some(r => !r.id || !r.name)) throw new Error("every entry needs id+name");
          pdb.catalog[key] = list;
        }
        persist("catalog");
      });
      audit("catalog", "edited: " + ["ranks", "awards", "certs", "apps"].filter(k => Array.isArray(b[k])).join(", "));
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
      if (need(isAdmin(actor) || scopedCert, 403, "management access required")) return true;
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
              let idx = act.rank != null ? rankIdx(String(act.rank)) : rankIdx(rec.rank) + Number(act.step || 0);
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
      const previous = hit.st.assignee;
      const wasAt = member ? currentBillet(member) : null;
      hit.st.assignee = member;
      if (previous && previous !== member) logEntry(recFor(previous), actor.name, "station",
        "Relieved of station: " + hit.st.title + ", " + hit.ship.name);
      if (member && previous !== member) {
        logEntry(recFor(member), actor.name, "station",
          "Assigned to station: " + hit.st.title + ", " + hit.ship.name);
        issueOrders(member, actor, { unit: hit.ship.name, hull: hit.ship.hullId || "",
          title: hit.st.title, department: hit.dept ? hit.dept.name : "", previous: wasAt });
        enqueueRoles(member);
      }
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
          .map(mm => ({ discordId: String(mm.discordId || ""), billet: String(mm.billet || "").slice(0, 60) }))
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
        if (existing) existing.billet = billet;
        else sq.members.push({ discordId: member, billet });
        logEntry(recFor(member), actor.name, "squadron",
          "Assigned to " + sq.name + " — " + billet);
        issueOrders(member, actor, { unit: sq.name, hull: "", title: billet, department: sq.designation || "",
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
      const b = await body(req);
      if (need(Array.isArray(b.members) && b.members.length && b.members.length <= 400,
        400, "members: an array of 1-400 entries")) return true;
      const byCallsign = new Map();
      for (const [aid, acc] of Object.entries(db.accounts))
        if (acc.callsign) byCallsign.set(String(acc.callsign).toUpperCase(), aid);
      const out = { created: 0, updated: 0, errors: [] };
      await serializeMutation(async () => {
        for (const mm of b.members.map(x => x && typeof x === "object" ? x : {})) {
          const callsign = String(mm.callsign || "").trim().toUpperCase()
            .replace(/[^ A-Z0-9_.\-'"()[\]]+/g, "").slice(0, 40);
          if (!callsign) { out.errors.push("entry without a callsign"); continue; }
          const rank = mm.rank == null ? null : String(mm.rank);
          if (rank && rankIdx(rank) < 0) { out.errors.push(callsign + ": no such rank " + rank); continue; }
          let id = byCallsign.get(callsign), created = false;
          if (!id) {
            id = "m-" + crypto.randomBytes(5).toString("hex");
            db.accounts[id] = { discordName: String(mm.discordName || callsign).slice(0, 80),
              callsign, role: "member", manual: true, createdAt: Date.now() };
            byCallsign.set(callsign, id); created = true;
          }
          const acc = db.accounts[id];
          if (mm.joinedAt != null && Number.isFinite(Number(mm.joinedAt))) acc.createdAt = Number(mm.joinedAt);
          if (mm.rsiHandle != null) acc.rsiHandle = String(mm.rsiHandle).slice(0, 60);
          if (mm.timezone != null) acc.timezone = String(mm.timezone).slice(0, 60);
          acc.contractor = mm.contractor === true;
          const rec = recFor(id);
          if (rank) rec.rank = rank;
          else if (created) rec.rank = "—";
          if (mm.rating != null) rec.rating = String(mm.rating).slice(0, 12);
          if (created) logEntry(rec, actor.name, "note", "Imported from the legacy fleet roster");
          ensureEnlisted(id, acc.createdAt || Date.now());
          const l = pdb.loa[id] || (pdb.loa[id] = { active: null, history: [] });
          if (mm.loa === true && !l.active)
            l.active = { start: Number(mm.loaSince) || Date.now(), reason: "Carried over from the legacy roster" };
          if (mm.loa !== true && l.active && String(l.active.reason || "").startsWith("Carried over")) {
            l.history.unshift({ start: l.active.start, end: Date.now(), reason: l.active.reason });
            l.active = null;
          }
          out[created ? "created" : "updated"]++;
        }
        deps.persist(); persist("personnel"); persist("loa");
      });
      send(res, 200, Object.assign({ ok: true }, out));
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
        rsiHandle: acc.rsiHandle || null, timezone: acc.timezone || null,
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
