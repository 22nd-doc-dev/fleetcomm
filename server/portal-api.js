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
    roster: record(load("roster.json", {}), "roster.json")               // {ships:[{id,name,hull,departments:[{name,stations:[{id,title,assignee}]}]}]}
  };
  const persist = (name) => save(name + ".json", pdb[name]);

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
      { id: "tiber", name: "UEES Tiber", hull: "FF-217", departments: [
        dept("Bridge", "Commanding Officer", "Executive Officer", "Helmsman", "Operations Officer"),
        dept("Flight Deck", "Air Boss", "Deck Chief", "Pilot 1", "Pilot 2"),
        dept("Engineering", "Chief Engineer", "Engineer 1", "Engineer 2"),
        dept("Gunnery", "Gunnery Chief", "Gunner 1", "Gunner 2")
      ] },
      { id: "beowulf", name: "UEES Beowulf", hull: "PCG-685", departments: [
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
      role: acc.role, lastSeen: acc.lastSeen || null, joinedAt: acc.createdAt || null,
      rank: rankByAbbr(rec.rank) || { grade: "?", name: rec.rank, abbr: rec.rank },
      awards: rec.awards, certs: rec.certs, record: rec.record
    };
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
      member: ["member", "command"].includes(a.acc.role) };
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
      const q = querystring.stringify({ client_id: OAUTH.id, redirect_uri: OAUTH.redirect,
        response_type: "code", scope: "identify guilds", state, prompt: "none" });
      res.writeHead(302, { Location: "https://discord.com/oauth2/authorize?" + q, "Cache-Control": "no-store" });
      res.end();
      return true;
    }
    if (p === "/api/oauth/callback" && req.method === "GET") {
      try {
        const state = String(url.searchParams.get("state") || "");
        if (!oauthStates.has(state) || oauthStates.get(state) <= Date.now())
          throw new Error("sign-in expired — try again");
        oauthStates.delete(state);
        const discordToken = await discordTokenExchange(String(url.searchParams.get("code") || ""));
        /* reuse the host service's login by calling it in-process would tangle
           the routes; mint the session the same way it does instead */
        const who = await deps.verifyDiscord({ discordToken });
        await deps.requireGuildMember(discordToken);
        let acc = db.accounts[who.id];
        if (!acc) acc = db.accounts[who.id] = { discordName: who.username, role: "pending", createdAt: Date.now() };
        if (acc.role === "revoked") throw new Error("access revoked by COMMAND");
        acc.discordName = who.username; acc.lastSeen = Date.now();
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

    /* everything below needs an operator session or the bot secret */
    const actor = actorOf(req);
    const need = (ok, code, msg) => { if (!ok) { send(res, code, { ok: false, error: msg }); return true; } return false; };
    if (!/^\/api\/(catalog|personnel|coc|availability|events|sso|activity|loa|roster)/.test(p)) return false;
    if (need(actor, 401, "unauthorized")) return true;
    /* pending accounts can see nothing but their own approval state */
    if (need(actor.bot || actor.member, 403, "awaiting COMMAND approval")) return true;

    let m;
    if (p === "/api/catalog" && req.method === "GET") { send(res, 200, { ok: true, catalog: pdb.catalog }); return true; }
    if (p === "/api/catalog" && req.method === "POST") {
      if (need(actor.command, 403, "COMMAND role required")) return true;
      const b = await body(req);
      await serializeMutation(async () => {
        for (const key of ["ranks", "awards", "certs", "apps"]) {
          if (!Array.isArray(b[key])) continue;
          const list = b[key].slice(0, 200).map(x => x && typeof x === "object" ? x : null).filter(Boolean);
          if (key === "ranks" && list.some(r => !r.grade || !r.name || !r.abbr)) throw new Error("every rank needs grade+name+abbr");
          if (key !== "ranks" && list.some(r => !r.id || !r.name)) throw new Error("every entry needs id+name");
          pdb.catalog[key] = list;
        }
        persist("catalog");
      });
      send(res, 200, { ok: true, catalog: pdb.catalog });
      return true;
    }

    if (p === "/api/personnel" && req.method === "GET") {
      const roster = Object.keys(db.accounts).map(profile).filter(Boolean)
        .sort((a, b2) => rankIdx(b2.rank.abbr) - rankIdx(a.rank.abbr));
      send(res, 200, { ok: true, roster });
      return true;
    }
    if (p === "/api/personnel/me" && req.method === "GET" && !actor.bot) {
      send(res, 200, { ok: true, profile: profile(actor.id) });
      return true;
    }
    if ((m = /^\/api\/personnel\/(\d+)$/.exec(p)) && req.method === "GET") {
      const pr = profile(m[1]);
      if (need(pr, 404, "no such member")) return true;
      send(res, 200, { ok: true, profile: pr });
      return true;
    }

    /* ── the one-click, many-people door: awards, certs, rank moves, notes ── */
    if (p === "/api/personnel/bulk" && req.method === "POST") {
      if (need(actor.command, 403, "COMMAND role required")) return true;
      const b = await body(req);
      const ids = Array.isArray(b.ids) ? b.ids.map(String).slice(0, 200) : [];
      const act = b.action && typeof b.action === "object" ? b.action : {};
      if (need(ids.length, 400, "ids[] is empty")) return true;
      const by = actor.name + (actor.bot && b.onBehalf ? " (for " + String(b.onBehalf).slice(0, 60) + ")" : "");
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
            } else if (act.type === "cert") {
              const cert = pdb.catalog.certs.find(x => x.id === act.certId);
              if (!cert) throw new Error("unknown certification");
              if (!rec.certs.some(c => c.certId === cert.id)) {
                rec.certs.push({ certId: cert.id, at: Date.now(), by });
                logEntry(rec, by, "cert", "Certified: " + cert.name);
              }
            } else if (act.type === "rank") {
              const from = rec.rank;
              let idx = act.rank != null ? rankIdx(String(act.rank)) : rankIdx(rec.rank) + Number(act.step || 0);
              if (idx < 0 || idx >= pdb.catalog.ranks.length) throw new Error("no such rank");
              rec.rank = pdb.catalog.ranks[idx].abbr;
              if (rec.rank !== from) logEntry(rec, by, "rank",
                (rankIdx(rec.rank) > rankIdx(from) ? "Promoted " : "Reduced ") + from + " → " + rec.rank);
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
      send(res, 200, { ok: true, results });
      return true;
    }

    /* ── chain of command: a flat billet list the portal renders as a tree ── */
    if (p === "/api/coc" && req.method === "GET") {
      send(res, 200, { ok: true, nodes: Array.isArray(pdb.coc.nodes) ? pdb.coc.nodes : [] });
      return true;
    }
    if (p === "/api/coc" && req.method === "POST") {
      if (need(actor.command, 403, "COMMAND role required")) return true;
      const b = await body(req);
      const nodes = Array.isArray(b.nodes) ? b.nodes.slice(0, 200) : null;
      if (need(nodes, 400, "nodes[] required")) return true;
      const clean = nodes.map(n => ({
        id: String(n.id || "").slice(0, 40),
        title: String(n.title || "").slice(0, 80),
        assignee: n.assignee ? String(n.assignee) : null,
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
      if (need(actor.command, 403, "COMMAND role required")) return true;
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
      if (need(actor.command, 403, "COMMAND role required")) return true;
      const b = await body(req);
      const at = Number(b.at);
      if (need(String(b.title || "").trim() && Number.isFinite(at), 400, "title + at (ms) required")) return true;
      const id = crypto.randomBytes(8).toString("hex");
      pdb.events[id] = { title: String(b.title).slice(0, 120), at,
        tier: String(b.tier || "OPERATION").slice(0, 40), brief: String(b.brief || "").slice(0, 2000),
        by: actor.name, rsvp: {} };
      persist("events");
      send(res, 200, { ok: true, id });
      return true;
    }
    if ((m = /^\/api\/events\/([a-f0-9]{16})\/delete$/.exec(p)) && req.method === "POST") {
      if (need(actor.command, 403, "COMMAND role required")) return true;
      if (need(pdb.events[m[1]], 404, "no such event")) return true;
      delete pdb.events[m[1]];
      persist("events");
      send(res, 200, { ok: true });
      return true;
    }
    if ((m = /^\/api\/events\/([a-f0-9]{16})\/rsvp$/.exec(p)) && req.method === "POST" && !actor.bot) {
      const b = await body(req);
      if (need(pdb.events[m[1]], 404, "no such event")) return true;
      if (need(["going", "maybe", "no"].includes(b.answer), 400, "answer must be going|maybe|no")) return true;
      pdb.events[m[1]].rsvp[actor.id] = b.answer;
      persist("events");
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
      if (need(actor.command, 403, "COMMAND role required")) return true;
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

    /* ── crew roster: ships' stations, claimable. One station per member per
       ship — you can serve on two ships, not stand two watches on one. ── */
    if (p === "/api/roster" && req.method === "GET") {
      send(res, 200, { ok: true, ships: pdb.roster.ships });
      return true;
    }
    if (p === "/api/roster/claim" && req.method === "POST" && !actor.bot) {
      const b = await body(req);
      const hit = stationOf(String(b.stationId || ""));
      if (need(hit, 404, "no such station")) return true;
      if (need(!hit.st.assignee, 400, "station is already crewed")) return true;
      const already = hit.ship.departments.some(d => d.stations.some(s => s.assignee === actor.id));
      if (need(!already, 400, "you already hold a station aboard " + hit.ship.name + " — release it first")) return true;
      await serializeMutation(async () => {
        if (hit.st.assignee) throw Object.assign(new Error("station is already crewed"), { statusCode: 400 });
        hit.st.assignee = actor.id;
        logEntry(recFor(actor.id), actor.name, "station", "Took station: " + hit.st.title + ", " + hit.ship.name);
        persist("roster"); persist("personnel");
      });
      send(res, 200, { ok: true });
      return true;
    }
    if (p === "/api/roster/release" && req.method === "POST") {
      const b = await body(req);
      const hit = stationOf(String(b.stationId || ""));
      if (need(hit, 404, "no such station")) return true;
      if (need(hit.st.assignee, 400, "station is already vacant")) return true;
      if (need(actor.command || hit.st.assignee === actor.id, 403, "not your station")) return true;
      const holder = hit.st.assignee;
      hit.st.assignee = null;
      logEntry(recFor(holder), actor.name, "station", "Stood down from station: " + hit.st.title + ", " + hit.ship.name);
      persist("roster"); persist("personnel");
      send(res, 200, { ok: true });
      return true;
    }
    if (p === "/api/roster/assign" && req.method === "POST") {
      if (need(actor.command, 403, "COMMAND role required")) return true;
      const b = await body(req);
      const hit = stationOf(String(b.stationId || ""));
      if (need(hit, 404, "no such station")) return true;
      const member = b.memberId ? String(b.memberId) : null;
      if (need(!member || db.accounts[member], 404, "no such member")) return true;
      hit.st.assignee = member;
      if (member) logEntry(recFor(member), actor.name, "station",
        "Assigned to station: " + hit.st.title + ", " + hit.ship.name);
      persist("roster"); persist("personnel");
      send(res, 200, { ok: true });
      return true;
    }
    if (p === "/api/roster/plan" && req.method === "POST") {
      if (need(actor.command, 403, "COMMAND role required")) return true;
      const b = await body(req);
      const ships = Array.isArray(b.ships) ? b.ships.slice(0, 12) : null;
      if (need(ships, 400, "ships[] required")) return true;
      const seen = new Set();
      let stations = 0;
      const clean = ships.map(ship => ({
        id: String(ship.id || "").slice(0, 40),
        name: String(ship.name || "").slice(0, 80),
        hull: String(ship.hull || "").slice(0, 20),
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
      send(res, 200, { ok: true, ships: clean });
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
      if (need(actor.command, 403, "COMMAND role required")) return true;
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

    return false;
  }

  return { handle, cors };
};
