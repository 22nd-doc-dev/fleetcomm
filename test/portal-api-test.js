"use strict";
/* Portal personnel API — profiles, bulk actions, CoC, availability, events,
 * SSO launch codes, the Discord-bot door, and CORS. Runs the real service
 * (MOCK_DISCORD) exactly like accounts-security-test. */
const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const port = 9500 + Math.floor(Math.random() * 300);
const base = "http://127.0.0.1:" + port;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleetcomm-portal-api-"));
let service;
let passed = 0;
const ok = (cond, name) => { assert(cond, name); console.log("  ✓ " + name + " " + ++passed); };

function api(method, pathname, body, token, headers) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(base + pathname, { method, headers: Object.assign(
      { "Content-Type": "application/json" },
      token ? { Authorization: token.startsWith("Bot ") ? token : "Bearer " + token } : {},
      headers || {}) }, res => {
      let text = ""; res.on("data", chunk => text += chunk);
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers,
        body: (() => { try { return JSON.parse(text); } catch (e) { return {}; } })() }));
    });
    req.on("error", reject); if (data) req.write(data); req.end();
  });
}
function start() {
  service = spawn(process.execPath, [path.join(__dirname, "..", "server", "accounts-service.js")], {
    env: Object.assign({}, process.env, { MOCK_DISCORD: "1", HOST: "127.0.0.1", PORT: String(port),
      DATA_DIR: dataDir, RELAY_PASSWORD: "relay-test", BOOTSTRAP_TOKEN: "boot-test", ACL_SYNC_DISABLED: "1",
      BOT_API_TOKEN: "bot-secret-test", PORTAL_ORIGIN: "https://22d.space", SSO_CODE_TTL_MS: "150" }),
    stdio: "ignore"
  });
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const poll = () => api("GET", "/api/health").then(resolve, error => {
      if (Date.now() >= deadline) reject(error); else setTimeout(poll, 50);
    });
    poll();
  });
}
function stop() {
  if (!service) return Promise.resolve();
  return new Promise(resolve => { service.once("exit", resolve); service.kill(); setTimeout(resolve, 1000); });
}
const pause = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  await start();

  /* identities: doc claims COMMAND, oak arrives pending */
  let r = await api("POST", "/api/login", { mockId: "1001", mockName: "Doc", bootstrapToken: "boot-test" });
  const doc = r.body.token;
  ok(r.status === 200 && r.body.account.role === "command", "bootstrap claims COMMAND");
  r = await api("POST", "/api/login", { mockId: "2002", mockName: "Oak" });
  const oak = r.body.token;
  ok(r.status === 200 && r.body.account.role === "pending", "second sign-in lands pending");

  /* a pending account sees no personnel data at all */
  r = await api("GET", "/api/personnel", null, oak);
  ok(r.status === 403, "pending accounts are locked out of the portal");
  r = await api("POST", "/api/accounts/2002/role", { role: "member" }, doc);
  ok(r.status === 200 && r.body.account.role === "member", "COMMAND approves oak to member");

  /* catalog seeded from the fleet's real ladder and decorations */
  r = await api("GET", "/api/catalog", null, oak);
  ok(r.body.catalog.ranks.length === 26 && r.body.catalog.ranks[0].abbr === "SR" &&
     r.body.catalog.ranks[25].abbr === "GADM", "rank ladder seeds junior-to-senior, 26 deep");
  ok(r.body.catalog.awards.length === 8 && r.body.catalog.certs.length === 12 &&
     r.body.catalog.apps.length === 3, "awards, certifications and apps seed");

  /* profiles */
  r = await api("GET", "/api/personnel/me", null, oak);
  ok(r.body.profile.rank.abbr === "SR" && r.body.profile.callsign === null, "a fresh member starts as Starman Recruit");
  r = await api("GET", "/api/personnel/1001", null, oak);
  ok(r.status === 200 && r.body.profile.role === "command", "any member can read any profile");

  /* ── the bulk door: one action, many people ── */
  r = await api("POST", "/api/personnel/bulk",
    { ids: ["1001", "2002"], action: { type: "award", awardId: "navigators-star", citation: "Charting the long dark" } }, doc);
  ok(r.body.results["1001"].ok && r.body.results["2002"].ok, "bulk award lands on several members at once");
  r = await api("POST", "/api/personnel/bulk",
    { ids: ["2002", "9999"], action: { type: "cert", certId: "hospital-corpsman" } }, doc);
  ok(r.body.results["2002"].ok && r.body.results["9999"].ok === false, "bulk reports per-member results");
  r = await api("POST", "/api/personnel/bulk",
    { ids: ["2002"], action: { type: "cert", certId: "hospital-corpsman" } }, doc);
  r = await api("GET", "/api/personnel/2002", null, doc);
  ok(r.body.profile.certs.length === 1, "re-certifying is idempotent");
  ok(r.body.profile.awards.length === 1 && r.body.profile.awards[0].citation === "Charting the long dark",
     "award carries its citation");

  /* rank moves: relative steps and absolute sets, junior-to-senior math */
  await api("POST", "/api/personnel/bulk", { ids: ["2002"], action: { type: "rank", step: 1 } }, doc);
  r = await api("GET", "/api/personnel/2002", null, doc);
  ok(r.body.profile.rank.abbr === "SM", "step +1 promotes SR to SM");
  await api("POST", "/api/personnel/bulk", { ids: ["2002"], action: { type: "rank", rank: "LT" } }, doc);
  await api("POST", "/api/personnel/bulk", { ids: ["2002"], action: { type: "rank", step: -1 } }, doc);
  r = await api("GET", "/api/personnel/2002", null, doc);
  ok(r.body.profile.rank.abbr === "LTJG", "absolute set then step -1 reduces LT to LTJG");
  ok(r.body.profile.record.some(e => e.kind === "rank" && /Promoted SR/.test(e.text)) &&
     r.body.profile.record.some(e => e.kind === "rank" && /Reduced LT/.test(e.text)),
     "every rank move writes the service record");
  r = await api("POST", "/api/personnel/bulk", { ids: ["2002"], action: { type: "rank", rank: "NOPE" } }, doc);
  ok(r.body.results["2002"].ok === false, "an unknown rank is refused per-member");
  r = await api("POST", "/api/personnel/bulk", { ids: ["2002"], action: { type: "note", text: "x" } }, oak);
  ok(r.status === 403, "members cannot reach the bulk door");

  /* ── chain of command ── */
  const nodes = [
    { id: "co", title: "Commanding Officer", assignee: "1001", parent: null },
    { id: "xo", title: "Executive Officer", assignee: "2002", parent: "co" },
    { id: "medical", title: "Medical Officer", assignee: null, parent: "xo" }
  ];
  r = await api("POST", "/api/coc", { nodes }, doc);
  ok(r.status === 200, "COMMAND publishes the chain of command");
  r = await api("GET", "/api/coc", null, oak);
  ok(r.body.nodes.length === 3 && r.body.nodes[1].assignee === "2002", "members read the published chain");
  r = await api("POST", "/api/coc", { nodes: [{ id: "a", title: "A", parent: "b" }, { id: "b", title: "B", parent: "a" }] }, doc);
  ok(r.status === 400, "a cyclic chain is refused");
  r = await api("POST", "/api/coc", { nodes: [{ id: "a", title: "A", parent: "ghost" }] }, doc);
  ok(r.status === 400, "a billet under a missing parent is refused");
  r = await api("POST", "/api/coc", { nodes }, oak);
  ok(r.status === 403, "members cannot edit the chain");
  /* title cards: a unit or office holds a spot in the chain with no person */
  r = await api("POST", "/api/coc", { nodes: [
    { id: "cascom", title: "CASCOM", card: true, assignee: "1001", parent: null },
    { id: "co", title: "Fleet CO", assignee: "1001", parent: "cascom", note: "Reports to CASCOM" },
    { id: "if55", title: "IF-55", card: true, parent: "co" },
    { id: "if55-act", title: "Acting CO", assignee: "2002", parent: "if55", note: "CO on LOA" }
  ] }, doc);
  ok(r.status === 200 && r.body.nodes[0].card === true && r.body.nodes[0].assignee === null,
     "a title card publishes as a unit — any stray assignee is struck");
  ok(r.body.nodes[3].note === "CO on LOA", "notes ride the chain (Acting CO, LOA)");
  r = await api("POST", "/api/coc", { nodes }, doc);   /* restore the plain chain */
  ok(r.status === 200, "the plain chain is restored");

  /* ── availability: painted days, own only; COMMAND sees the fleet ── */
  r = await api("POST", "/api/availability", { days: { "2026-09-05": "y", "2026-09-06": "loa", "2026-09-07": "zz", "bad-key": "y" } }, oak);
  ok(r.body.days["2026-09-05"] === "y" && r.body.days["2026-09-06"] === "loa" &&
     !r.body.days["2026-09-07"] && !r.body.days["bad-key"], "day paint saves; junk codes and keys are dropped");
  r = await api("POST", "/api/availability", { days: { "2026-09-05": null } }, oak);
  ok(!r.body.days["2026-09-05"], "painting a day empty clears it");
  r = await api("GET", "/api/availability/all", null, oak);
  ok(r.status === 403, "the fleet-wide view is COMMAND only");
  r = await api("GET", "/api/availability/all", null, doc);
  ok(r.body.availability["2002"].days["2026-09-06"] === "loa", "COMMAND sees every member's paint");

  /* ── events ── */
  r = await api("POST", "/api/events", { title: "OPERATION LONG WATCH", at: Date.now() + 86400000, tier: "FLEET OP", brief: "All hands." }, doc);
  const eventId = r.body.id;
  ok(r.status === 200 && /^[a-f0-9]{16}$/.test(eventId), "COMMAND schedules an event");
  r = await api("POST", "/api/events/" + eventId + "/rsvp", { answer: "going" }, oak);
  ok(r.body.rsvp["2002"] === "going", "members RSVP");
  r = await api("POST", "/api/events", { title: "x", at: Date.now() }, oak);
  ok(r.status === 403, "members cannot schedule events");

  /* ── leave of absence ── */
  r = await api("POST", "/api/loa/start", { reason: "Fleet week at grandma's" }, oak);
  ok(r.status === 200 && r.body.active.reason === "Fleet week at grandma's", "a member starts leave");
  r = await api("POST", "/api/loa/start", {}, oak);
  ok(r.status === 400, "a second leave is refused while one is active");
  r = await api("GET", "/api/loa", null, doc);
  ok(r.body.active.length === 1 && r.body.active[0].callsign, "COMMAND sees the all-hands leave board");
  r = await api("GET", "/api/loa", null, oak);
  ok(r.status === 403, "the all-hands board is COMMAND only");
  r = await api("POST", "/api/loa/end", {}, oak);
  r = await api("GET", "/api/loa/me", null, oak);
  ok(r.body.active === null && r.body.history.length === 1 && r.body.history[0].end > r.body.history[0].start,
    "ending leave moves it to history");
  r = await api("GET", "/api/personnel/2002", null, doc);
  ok(r.body.profile.record.filter(e => e.kind === "loa").length === 2,
    "both leave transitions land on the service record");

  /* ── crew roster v2: assignment-only, multi-billet, richer ships ── */
  r = await api("GET", "/api/roster", null, oak);
  const ships = r.body.ships;
  ok(ships.length === 2 && ships[0].hullId === "FF-217" && ships[0].status === "active" &&
     ships[0].classification === "Frigate" &&
     ships.flatMap(s => s.departments).flatMap(d => d.stations).length >= 15,
     "the ships of the line seed with stations, hull ids, class and status");
  const helm = ships[0].departments[0].stations.find(s => s.title === "Helmsman");
  const ops = ships[0].departments[0].stations.find(s => s.title === "Operations Officer");
  r = await api("POST", "/api/roster/claim", { stationId: helm.id }, oak);
  ok(r.status === 404, "the claim door is gone — billets are assigned, not taken");
  r = await api("POST", "/api/roster/assign", { stationId: helm.id, memberId: "2002" }, doc);
  r = await api("POST", "/api/roster/assign", { stationId: ops.id, memberId: "2002" }, doc);
  ok(r.status === 200, "one member may hold several stations on one ship");
  r = await api("POST", "/api/roster/assign", { stationId: helm.id, memberId: "1001" }, doc);
  r = await api("GET", "/api/personnel/2002", null, doc);
  ok(r.body.profile.record.some(e => /Relieved of station: Helmsman/.test(e.text)) &&
     r.body.profile.record.some(e => /Assigned to station: Helmsman/.test(e.text)),
    "assignment and relief both land on the service record");
  r = await api("POST", "/api/roster/assign", { stationId: helm.id, memberId: "9999" }, doc);
  ok(r.status === 404, "assigning an unknown member is refused");
  r = await api("POST", "/api/roster/assign", { stationId: helm.id, memberId: null }, doc);
  ok(r.status === 200, "a station can be cleared to vacant");
  r = await api("POST", "/api/roster/ship", { id: "beowulf", status: "refit", notes: "Yard period, three weeks" }, doc);
  ok(r.status === 200 && r.body.ship.status === "refit", "ship properties are individually editable");
  r = await api("POST", "/api/roster/ship", { id: "beowulf", status: "sunk" }, doc);
  ok(r.status === 400, "an unknown ship status is refused");
  r = await api("POST", "/api/roster/ship", { id: "beowulf", status: "active" }, oak);
  ok(r.status === 403, "ship edits need roster authority");
  r = await api("POST", "/api/roster/plan", { ships: [{ id: "x", name: "X", departments: [
    { name: "A", stations: [{ id: "dup", title: "T1" }, { id: "dup", title: "T2" }] }] }] }, doc);
  ok(r.status === 400 && /duplicate station/.test(r.body.error), "a plan with duplicate station ids is refused");

  /* ── squadrons ── */
  r = await api("GET", "/api/squadrons", null, oak);
  ok(r.body.squadrons.length === 6 && r.body.squadrons.some(s => s.id === "logron-88"),
    "the six squadrons seed");
  r = await api("POST", "/api/squadrons/logron-88/assign", { memberId: "2002", billet: "Quartermaster" }, doc);
  ok(r.status === 200 && r.body.squadron.members.length === 1, "an admin assigns a squadron billet");
  r = await api("GET", "/api/personnel/2002", null, doc);
  ok(r.body.profile.record.some(e => /Assigned to LOGRON-88 — Quartermaster/.test(e.text)),
    "squadron assignment lands on the service record");
  r = await api("POST", "/api/squadrons/logron-88/assign", { memberId: "1001", billet: "CO" }, oak);
  ok(r.status === 403, "members without scope cannot assign squadron billets");
  r = await api("POST", "/api/squadrons/plan", { squadrons: [{ id: "a", name: "A" }, { id: "a", name: "B" }] }, doc);
  ok(r.status === 400 && /duplicate squadron/.test(r.body.error), "duplicate squadron ids are refused");

  /* ── scoped authority ── */
  r = await api("POST", "/api/personnel/2002/scopes",
    { scopes: ["ship:beowulf", "squadron:logron-88", "rate:hospital-corpsman"] }, doc);
  ok(r.status === 200 && r.body.profile.scopes.length === 3, "an admin grants scoped authority");
  r = await api("POST", "/api/personnel/2002/scopes", { scopes: ["ship:titanic"] }, doc);
  ok(r.status === 400, "a scope naming nothing that exists is refused");
  r = await api("GET", "/api/me/permissions", null, oak);
  ok(r.body.admin === false && r.body.manage.ships.join() === "beowulf" &&
     r.body.manage.squadrons.join() === "logron-88" && r.body.canApprove === true,
    "the permissions blob mirrors the scopes");
  const bHelm = ships[1].departments[0].stations.find(s => s.title === "Helmsman");
  r = await api("POST", "/api/roster/assign", { stationId: bHelm.id, memberId: "2002" }, oak);
  ok(r.status === 200, "a ship scope grants assignment on that ship");
  r = await api("POST", "/api/roster/assign", { stationId: ops.id, memberId: "2002" }, oak);
  ok(r.status === 403, "…and nothing on other ships");
  r = await api("POST", "/api/squadrons/logron-88", { role: "Tonnage talks" }, oak);
  ok(r.status === 200, "a squadron scope edits that squadron's properties");
  r = await api("POST", "/api/personnel/bulk", { ids: ["1001"], action: { type: "cert", certId: "hospital-corpsman" } }, oak);
  ok(r.status === 200 && r.body.results["1001"].ok, "a rate scope grants certifying exactly that rating");
  r = await api("POST", "/api/personnel/bulk", { ids: ["1001"], action: { type: "award", awardId: "lifesaver-cross" } }, oak);
  ok(r.status === 403, "…and no other bulk power");

  /* ── self-submitted record entries + approval ── */
  let mal = await api("POST", "/api/login", { mockId: "3003", mockName: "Mallory" });
  await api("POST", "/api/accounts/3003/role", { role: "member" }, doc);
  mal = (await api("POST", "/api/login", { mockId: "3003", mockName: "Mallory" })).body.token;
  r = await api("POST", "/api/personnel/me/record", { kind: "ops", text: "Flew lead on the Nyx convoy escort" }, mal);
  const entryId = r.body.entry.id;
  ok(r.status === 200 && r.body.entry.state === "pending", "a member submits their own record entry");
  r = await api("GET", "/api/personnel/me", null, mal);
  ok(r.body.profile.record.some(e => e.id === entryId && e.state === "pending"), "the owner sees their pending entry");
  r = await api("GET", "/api/personnel/3003", null, oak);
  ok(!r.body.profile.record.some(e => e.id === entryId),
    "a bystander does not see pending entries");
  r = await api("POST", "/api/record/" + entryId + "/approve", {}, mal);
  ok(r.status === 403, "nobody approves their own entry");
  r = await api("GET", "/api/record/pending", null, doc);
  ok(r.body.queue.some(q => q.entry.id === entryId), "approvers see the pending queue");
  r = await api("POST", "/api/record/" + entryId + "/approve", {}, doc);
  ok(r.status === 200 && r.body.entry.state === "approved" && r.body.entry.approvedBy,
    "approval publishes the entry with the approver's name");
  r = await api("GET", "/api/personnel/3003", null, oak);
  ok(r.body.profile.record.some(e => e.id === entryId && e.state === "approved"),
    "an approved entry is public");
  r = await api("POST", "/api/personnel/me/record", { text: "I single-handedly won the war" }, mal);
  const rejId = r.body.entry.id;
  await api("POST", "/api/record/" + rejId + "/reject", { note: "See me" }, doc);
  r = await api("GET", "/api/personnel/3003", null, oak);
  ok(!r.body.profile.record.some(e => e.id === rejId), "a rejected entry is owner-only");
  r = await api("GET", "/api/personnel/me", null, mal);
  ok(r.body.profile.record.some(e => e.id === rejId && e.state === "rejected" && e.note === "See me"),
    "the owner sees the rejection and its note");
  /* scoped approval: oak manages beowulf; put mallory aboard, oak approves */
  await api("POST", "/api/roster/assign", { stationId: bHelm.id, memberId: "3003" }, doc);
  r = await api("POST", "/api/personnel/me/record", { kind: "training", text: "Helm quals complete" }, mal);
  const scopedId = r.body.entry.id;
  r = await api("GET", "/api/record/pending", null, oak);
  ok(r.body.queue.some(q => q.entry.id === scopedId), "a ship scope surfaces its crew's pending entries");
  r = await api("POST", "/api/record/" + scopedId + "/approve", {}, oak);
  ok(r.status === 200, "a scoped manager approves their crew");

  /* ── manual members (pre-Discord import) ── */
  r = await api("POST", "/api/personnel/add", { callsign: "OLD SALT", rank: "CPO" }, doc);
  const manualId = r.body.profile.discordId;
  ok(r.status === 200 && /^m-/.test(manualId) && r.body.profile.manual === true &&
     r.body.profile.rank.abbr === "CPO", "a manual member record is created with rank");
  r = await api("GET", "/api/personnel/" + manualId, null, oak);
  ok(r.status === 200 && r.body.profile.callsign === "OLD SALT", "manual records read like any profile");
  r = await api("POST", "/api/personnel/add", { callsign: "X", rank: "NOPE" }, doc);
  ok(r.status === 400, "a manual add with an unknown rank is refused whole");
  r = await api("POST", "/api/personnel/add", { callsign: "Y" }, mal);
  ok(r.status === 403, "manual adds need management access");

  /* ── itAdmin + export ── */
  r = await api("POST", "/api/personnel/2002/scopes", { itAdmin: true }, doc);
  ok(r.status === 200 && r.body.profile.itAdmin === true, "an admin grants the itAdmin flag");
  r = await api("POST", "/api/personnel/add", { callsign: "VIA-IT" }, oak);
  ok(r.status === 200, "itAdmin carries full management access");
  r = await api("POST", "/api/personnel/2002/scopes", { itAdmin: false }, oak);
  ok(r.status === 200, "itAdmin can be revoked while COMMAND remains");
  r = await api("GET", "/api/export", null, doc);
  ok(r.status === 200 && r.body.roster.ships.length === 2 && r.body.squadrons.squadrons.length === 6 &&
     r.body.accounts["1001"] && !JSON.stringify(r.body.accounts).includes("relayToken"),
    "the export carries the whole fleet state and no secrets");
  r = await api("GET", "/api/export", null, mal);
  ok(r.status === 403, "the export is admin-only");

  /* ── catalog apps carry extra fields through untouched ── */
  await api("POST", "/api/catalog", { apps: [{ id: "fleetcomm", name: "FleetComm", url: "", hidden: true, order: 2 }] }, doc);
  r = await api("GET", "/api/catalog", null, oak);
  ok(r.body.catalog.apps[0].hidden === true && r.body.catalog.apps[0].order === 2,
    "unknown app fields survive a catalog write");

  /* ── SSO: one-time launch codes become real sessions for the 22nd's apps ── */
  r = await api("POST", "/api/sso/grant", { app: "corpsman" }, oak);
  const code = r.body.code;
  ok(r.status === 200 && /^sso-/.test(code), "a member mints a launch code");
  r = await api("POST", "/api/sso/redeem", { code });
  const appToken = r.body.token;
  ok(r.status === 200 && r.body.identity.discordId === "2002" && r.body.app === "corpsman",
     "the app redeems the code for the member's identity");
  r = await api("GET", "/api/personnel/me", null, appToken);
  ok(r.status === 200 && r.body.profile.discordId === "2002", "the redeemed session speaks the full API");
  r = await api("POST", "/api/sso/redeem", { code });
  ok(r.status === 403, "a launch code is single-use");
  r = await api("POST", "/api/sso/grant", { app: "corpsman" }, oak);
  await pause(300);   /* SSO_CODE_TTL_MS=150 in this run */
  r = await api("POST", "/api/sso/redeem", { code: r.body.code });
  ok(r.status === 403, "a stale launch code expires");

  /* ── the Discord bot door ── */
  r = await api("POST", "/api/personnel/bulk",
    { ids: ["2002"], action: { type: "note", text: "Checked in via Discord" }, onBehalf: "Oak" }, "Bot bot-secret-test");
  ok(r.body.results["2002"].ok, "the bot writes with its shared secret");
  r = await api("GET", "/api/personnel/2002", null, doc);
  const botEntry = r.body.profile.record.find(e => /Checked in via Discord/.test(e.text));
  ok(botEntry && /FLEET DISCORD BOT \(for Oak\)/.test(botEntry.by), "bot entries are attributed to the bot and who it relayed");
  r = await api("GET", "/api/activity?since=0", null, "Bot bot-secret-test");
  ok(r.status === 200 && r.body.feed.length > 0 && r.body.lastSeen.some(x => x.discordId === "2002"),
     "the bot reads the activity feed and last-seen roster");
  r = await api("POST", "/api/personnel/bulk", { ids: ["2002"], action: { type: "note", text: "x" } }, "Bot wrong-secret");
  ok(r.status === 401, "a wrong bot secret is rejected");

  /* ── CORS: only the configured portal origin is allowed ── */
  r = await api("OPTIONS", "/api/personnel", null, null, { Origin: "https://22d.space" });
  ok(r.status === 204 && r.headers["access-control-allow-origin"] === "https://22d.space",
     "the portal origin passes preflight");
  r = await api("GET", "/api/catalog", null, oak, { Origin: "https://evil.example" });
  ok(!r.headers["access-control-allow-origin"], "other origins get no CORS grant");
  r = await api("GET", "/api/oauth/config");
  ok(r.body.mock === true && r.body.configured === false, "oauth config reports mock mode honestly");

  /* ── the legacy roster import: idempotent, honest about unknowns ── */
  const importBody = { members: [
    { callsign: "Travis Barnes", rank: "CDRE", rsiHandle: "Travis_Barnes",
      timezone: "Eastern Time (US & Canada)", joinedAt: 1753030800000 },
    { callsign: "Deacyn Rodriguez", rank: "MCPO", rating: "BMMC", loa: true, loaSince: 1776013200000 },
    { callsign: "Keleus Harper", loa: true },
    { callsign: "Victor Makya", contractor: true },
  ] };
  r = await api("POST", "/api/personnel/import", importBody, oak);
  ok(r.status === 403, "the import door needs management access");
  /* CDRE isn't in the stock ladder — the import names the gap instead of guessing */
  r = await api("POST", "/api/personnel/import", importBody, doc);
  ok(r.status === 200 && r.body.errors.some(e => /CDRE/.test(e)) && r.body.created === 3,
     "an unknown rank is reported per-member while the rest import");
  r = await api("POST", "/api/catalog", { ranks: (await api("GET", "/api/catalog", null, doc)).body.catalog.ranks
    .concat({ grade: "O-7", name: "Commodore", abbr: "CDRE" }) }, doc);
  ok(r.status === 200, "COMMAND adds Commodore to the ladder in-site");
  r = await api("POST", "/api/personnel/import", importBody, doc);
  ok(r.status === 200 && r.body.created === 1 && r.body.updated === 3 && !r.body.errors.length,
     "re-running the import updates in place — nobody is duplicated");
  r = await api("GET", "/api/personnel", null, doc);
  const trav = r.body.roster.find(x => x.callsign === "TRAVIS BARNES");
  const deac = r.body.roster.find(x => x.callsign === "DEACYN RODRIGUEZ");
  const kel = r.body.roster.find(x => x.callsign === "KELEUS HARPER");
  const vic = r.body.roster.find(x => x.callsign === "VICTOR MAKYA");
  ok(trav && trav.rank.abbr === "CDRE" && trav.rsiHandle === "Travis_Barnes" &&
     trav.joinedAt === 1753030800000 && trav.manual === true,
     "the Commodore lands ranked, dated, and linked to his RSI profile");
  ok(trav === r.body.roster[0], "the senior-most officer tops the roster sort");
  ok(deac && deac.rating === "BMMC" && deac.rank.abbr === "MCPO", "rated prefixes ride alongside the ladder rank");
  ok(kel && kel.rank.abbr === "—" && kel.rank.grade === "?", "an unknown rank stays an honest dash, never a defaulted SR");
  ok(vic && vic.contractor === true, "contractors carry the flag");
  r = await api("GET", "/api/loa", null, doc);
  ok(r.body.active.some(x => x.discordId === deac.discordId && x.start === 1776013200000) &&
     r.body.active.some(x => x.discordId === kel.discordId),
     "on-leave members arrive on leave, with their dates");
  const importNotes = (await api("GET", "/api/personnel/" + trav.discordId, null, doc))
    .body.profile.record.filter(e => /Imported from the legacy/.test(e.text));
  ok(importNotes.length === 1, "re-imports never repeat the import note");

  /* the personnel layer never leaks through the old routes */
  r = await api("GET", "/api/accounts", null, oak);
  ok(r.status === 403, "the existing COMMAND-only account list is still COMMAND-only");

  /* ── the public registry: the front site reads it with no sign-in ── */
  r = await api("GET", "/api/public");
  ok(r.status === 200 && Array.isArray(r.body.ships) && Array.isArray(r.body.squadrons) &&
     Array.isArray(r.body.ranks) && r.body.fleet.souls > 0,
     "the public registry answers without a session");
  ok(r.body.ships.every(s => s.departments === undefined && s.notes === undefined) &&
     r.body.squadrons.every(s => s.members === undefined),
     "the public registry prints structure only — no musters, stations or notes");
  const pubLadder = (await api("GET", "/api/catalog", null, doc)).body.catalog.ranks;
  r = await api("POST", "/api/catalog", { ranks: pubLadder.concat({ grade: "E-0", name: "Hidden Test", abbr: "HIDDEN-TEST", hidden: true }) }, doc);
  ok(r.status === 200, "COMMAND hides a rank for the public-registry test");
  r = await api("GET", "/api/public");
  ok(!r.body.ranks.some(rk => rk.abbr === "HIDDEN-TEST") &&
     pubLadder.every(rk => rk.hidden || r.body.ranks.some(p2 => p2.abbr === rk.abbr)),
     "hidden ranks stay off the public ladder while visible ones all print");
  await api("POST", "/api/catalog", { ranks: pubLadder }, doc);

  /* ── the fleet bot's door: outbox, RSVP relay, muster, role plan ── */
  r = await api("GET", "/api/bot/outbox", null, oak);
  ok(r.status === 403, "member sessions cannot open the bot door");
  for (let guard = 0; guard < 40; guard++) {           /* drain the backlog first */
    r = await api("GET", "/api/bot/outbox", null, "Bot bot-secret-test");
    if (!r.body.jobs.length) break;
    for (const j of r.body.jobs) await api("POST", "/api/bot/outbox/ack", { id: j.id }, "Bot bot-secret-test");
  }
  r = await api("POST", "/api/events", { title: "Bot Door Op", at: Date.now() + 3600e3,
    endAt: Date.now() + 2 * 3600e3, location: "Microtech", uniform: "Standard loadout",
    attention: ["desron-38", "not-a-squadron"] }, doc);
  ok(r.status === 200, "an op posts with end time, location, uniform and attention");
  const botEvId = r.body.id;
  r = await api("GET", "/api/bot/outbox", null, "Bot bot-secret-test");
  const evJob = r.body.jobs.find(j => j.type === "event" && j.eventId === botEvId);
  ok(!!evJob, "posting an op lands an event job in the outbox");
  r = await api("POST", "/api/bot/outbox/ack", { id: evJob.id,
    result: { channelId: "c1", messageId: "m1" } }, "Bot bot-secret-test");
  ok(r.status === 200, "the bot acks the job with its posted message");
  r = await api("POST", "/api/bot/rsvp", { eventId: botEvId, discordId: "424242", answer: "going" }, "Bot bot-secret-test");
  ok(r.status === 403, "a stranger's button click bounces — not on the rolls");
  r = await api("POST", "/api/bot/rsvp", { eventId: botEvId, discordId: "2002", answer: "going" }, "Bot bot-secret-test");
  ok(r.status === 200, "a member's button click lands on the ledger");
  r = await api("GET", "/api/bot/event/" + botEvId, null, "Bot bot-secret-test");
  ok(r.body.event.counts.going === 1 && r.body.event.discordMsg.messageId === "m1" &&
     r.body.event.lists.going.length === 1 && r.body.event.attention.join() === "DESRON-38",
     "the bot reads counts, names, attention and its own message id back");
  r = await api("POST", "/api/events/" + botEvId + "/rsvp", { answer: "maybe" }, oak);
  ok(r.status === 200, "a website RSVP still lands");
  r = await api("GET", "/api/bot/outbox", null, "Bot bot-secret-test");
  ok(r.body.jobs.some(j => j.type === "event-update" && j.eventId === botEvId),
     "a website RSVP queues a Discord card refresh");
  r = await api("POST", "/api/bot/muster", { members: [
    { id: "2002", username: "oak-global", nick: "LSM Oak Morcroft", roles: ["r1", "r2"] },
    { id: "555555", username: "not-aboard", nick: null, roles: [] }] }, "Bot bot-secret-test");
  ok(r.status === 200 && r.body.linked === 1, "the guild muster links Discord members to the rolls");
  r = await api("GET", "/api/personnel/2002", null, doc);
  ok(r.body.profile.discordName === "LSM Oak Morcroft", "muster nicknames land on the account");
  r = await api("GET", "/api/bot/roleplan", null, "Bot bot-secret-test");
  const oakPlan = r.body.plan.find(x => x.discordId === "2002");
  ok(oakPlan && oakPlan.roles.length >= 1 && r.body.managed.includes("DESRON-38"),
     "the role plan names each member's due roles inside a managed namespace");

  /* ── Element Leader: member everywhere, helmet-cam viewer to the app ── */
  r = await api("POST", "/api/callsign", { callsign: "Oak Morcroft" }, oak);
  ok(r.status === 200, "Oak takes a callsign for the cam-viewer test");
  r = await api("POST", "/api/accounts/2002/role", { role: "element" }, doc);
  ok(r.status === 200, "COMMAND grants Element Leader standing");
  r = await api("GET", "/api/personnel", null, oak);
  ok(r.status === 200, "an Element Leader still reads the fleet like any member");
  r = await api("POST", "/api/personnel/bulk", { ids: ["2002"], action: { type: "note", text: "x" } }, oak);
  ok(r.status === 403, "Element Leader carries no COMMAND powers");
  r = await api("GET", "/api/cam-viewers", null, oak);
  ok(r.status === 200 && r.body.viewers.some(v => /OAK/i.test(v)),
     "cam-viewers lists Element Leaders by raw callsign");
  ok(!r.body.viewers.some(v => /TRAVIS/i.test(v)),
     "a callsign-less or member-tier account never reaches the viewer list");
  r = await api("GET", "/api/cam-viewers");
  ok(r.status === 401, "the viewer list is not public");
  r = await api("POST", "/api/accounts/2002/role", { role: "member" }, doc);
  ok(r.status === 200, "the tier steps back down cleanly");

  await stop();
  fs.rmSync(dataDir, { recursive: true, force: true });
  console.log("\n✔ PORTAL API PASS — profiles, bulk actions, CoC, availability, events, SSO and the bot door hold their gates");
})().catch(async e => { console.error("✘ FAIL:", e); await stop(); fs.rmSync(dataDir, { recursive: true, force: true }); process.exit(1); });
