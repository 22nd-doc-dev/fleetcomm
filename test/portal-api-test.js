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
      BOT_API_TOKEN: "bot-secret-test", PORTAL_ORIGIN: "https://22d.space", SSO_CODE_TTL_MS: "150",
      RSI_PROFILE_BASE: "http://127.0.0.1:" + rsiPort + "/citizens/", RSI_CHECK_COOLDOWN_MS: "0" }),
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
  try { rsiServer.close(); } catch (e) {}
  if (!service) return Promise.resolve();
  return new Promise(resolve => { service.once("exit", resolve); service.kill(); setTimeout(resolve, 1000); });
}
const pause = ms => new Promise(r => setTimeout(r, ms));
function rawGet(pathname, token) {
  return new Promise((resolve, reject) => {
    http.get(base + pathname, { headers: token ? { Authorization: "Bearer " + token } : {} }, res => {
      let text = ""; res.on("data", c => text += c);
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text }));
    }).on("error", reject);
  });
}
/* a stand-in for RSI's public citizen pages: one citizen, a bio the test edits */
let rsiPort = 0;
const rsiStub = { bio: "" };
const rsiServer = http.createServer((req, res) => {
  if (req.url === "/citizens/Oak-Tree") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<html><body><p class='entry'><span class='label'>UEE Citizen Record</span><strong class='value'>#424242</strong></p>" +
      "<p class='entry'><span class='label'>Handle name</span><strong class='value'>Oak-Tree</strong></p>" +
      "<div class='entry bio'><span class='label'>Bio</span><div class='value'>" + rsiStub.bio + "</div></div></body></html>");
  } else { res.writeHead(404, { "Content-Type": "text/html" }); res.end("<html><body>404</body></html>"); }
});

(async () => {
  await new Promise(r0 => rsiServer.listen(0, "127.0.0.1", r0));
  rsiPort = rsiServer.address().port;
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
  r = await api("GET", "/api/me", null, oak);
  const oakSiteCallsign = r.body.account.callsign;
  r = await api("POST", "/api/callsign", { callsign: "Tiber Tac 2" }, oak);
  ok(r.status === 200 && r.body.account.sessionCallsign === "TIBER TAC 2", "Oak takes a tactical callsign for this session");
  r = await api("GET", "/api/me", null, oak);
  ok(r.body.account.sessionCallsign === "TIBER TAC 2" && r.body.account.callsign === oakSiteCallsign && r.body.account.onAir === "TIBER TAC 2",
     "the session callsign rides the session; the account's (the site's) callsign is untouched");
  r = await api("POST", "/api/personnel/2002/callsign", { callsign: "Oak Morcroft" }, oak);
  ok(r.status === 403, "a member cannot set a record's site callsign");
  r = await api("POST", "/api/personnel/2002/callsign", { callsign: "Oak Morcroft" }, doc);
  ok(r.status === 200 && r.body.profile.callsign === "OAK MORCROFT", "management sets the site callsign");
  r = await api("GET", "/api/me", null, oak);
  ok(r.body.account.callsign === "OAK MORCROFT" && r.body.account.sessionCallsign === "TIBER TAC 2", "site and session callsigns are separate things");
  r = await api("POST", "/api/accounts/2002/role", { role: "element" }, doc);
  ok(r.status === 200, "COMMAND grants Element Leader standing");
  r = await api("GET", "/api/personnel", null, oak);
  ok(r.status === 200, "an Element Leader still reads the fleet like any member");
  r = await api("POST", "/api/personnel/bulk", { ids: ["2002"], action: { type: "note", text: "x" } }, oak);
  ok(r.status === 403, "Element Leader carries no COMMAND powers");
  r = await api("GET", "/api/cam-viewers", null, oak);
  ok(r.status === 200 && r.body.viewers.some(v => /OAK/i.test(v)) && r.body.viewers.includes("TIBER TAC 2"),
     "cam-viewers lists Element Leaders by site callsign AND the session callsign they are on the air under");
  ok(!r.body.viewers.some(v => /TRAVIS/i.test(v)),
     "a callsign-less or member-tier account never reaches the viewer list");
  r = await api("GET", "/api/cam-viewers");
  ok(r.status === 401, "the viewer list is not public");
  r = await api("POST", "/api/accounts/2002/role", { role: "member" }, doc);
  ok(r.status === 200, "the tier steps back down cleanly");

  /* ── the form-up call: sound the reminder now ── */
  r = await api("POST", "/api/events/" + botEvId + "/remind", {}, oak);
  ok(r.status === 403, "sounding the reminder is COMMAND's call");
  r = await api("POST", "/api/events/" + botEvId + "/remind", {}, doc);
  ok(r.status === 200, "COMMAND sounds the reminder on demand");
  r = await api("GET", "/api/bot/outbox", null, "Bot bot-secret-test");
  ok(r.body.jobs.some(j => j.type === "remind-now" && j.eventId === botEvId),
     "the manual reminder lands in the outbox for the bot");

  /* ── the audit ledger: append-only, admin eyes, no clear anywhere ── */
  r = await api("GET", "/api/audit", null, oak);
  ok(r.status === 403, "the ledger is for management eyes only");
  r = await api("GET", "/api/audit", null, doc);
  const audBefore = r.body.entries.length;
  ok(r.status === 200 && audBefore > 0, "privileged actions have been landing on the ledger");
  ok(r.body.entries.some(e => e.action === "standing") &&
     r.body.entries.some(e => /^bulk /.test(e.action)),
     "standing changes and bulk orders both sit on the ledger");
  await api("POST", "/api/events", { title: "Ledger Op", at: Date.now() + 86400e3 }, doc);
  r = await api("GET", "/api/audit", null, doc);
  ok(r.body.entries.length === audBefore + 1 && r.body.entries[0].action === "event",
     "the ledger only ever grows, newest first");

  /* ── fleet standing orders: the Fleet CO's keys ── */
  await api("POST", "/api/coc", { nodes }, doc);            /* doc holds the top billet again */
  r = await api("POST", "/api/fleet", { aor: "Pyro System" }, oak);
  ok(r.status === 403, "the AOR is the Fleet CO's to set, not a member's");
  r = await api("POST", "/api/fleet", { aor: "Pyro System", dutyStation: "Levski, Delamar, Nyx System" }, doc);
  ok(r.status === 200 && r.body.fleet.aor === "Pyro System", "the Fleet CO sets the AOR and duty station");
  r = await api("GET", "/api/bot/outbox", null, "Bot bot-secret-test");
  ok(r.body.jobs.some(j => j.type === "status" && j.which === "aor" && j.value === "Pyro System"),
     "an AOR change queues the Discord status-channel update");
  r = await api("GET", "/api/fleet", null, oak);
  ok(r.body.fleet.dutyStation === "Levski, Delamar, Nyx System" && /^\d{2}[A-Z]{3}\d{4}$/.test(r.body.fleetDate),
     "everyone reads the standing orders and the fleet date");
  r = await api("GET", "/api/public");
  ok(r.body.fleet.aor === "Pyro System", "the public registry carries the AOR");

  /* ── enlistment and assignment orders ── */
  r = await api("GET", "/api/personnel/" + trav.discordId, null, doc);
  ok(r.body.profile.record.some(e => e.kind === "enlist" && /2955|2956/.test(e.text)),
     "an imported member enlisted on the record with an in-universe date");
  r = await api("POST", "/api/squadrons/desron-38/assign", { memberId: "2002", billet: "Gunnery Officer" }, doc);
  ok(r.status === 200, "Oak is assigned to DESRON-38");
  r = await api("GET", "/api/personnel/2002", null, doc);
  const order = r.body.profile.orders[0];
  ok(order && /ASSIGNMENT ORDER/.test(order.text) && /Reporting Unit \/ Ship: DESRON-38, DESRON-38/.test(order.text) &&
     /Service Number: #\d{5}/.test(order.text) && /Current Duty Station: Levski/.test(order.text),
     "assignment orders are written in the Bureau's format with a service number");
  r = await api("GET", "/api/bot/outbox", null, "Bot bot-secret-test");
  ok(r.body.jobs.some(j => j.type === "orders" && j.discordId === "2002"), "orders go out to the assignment-orders channel");

  /* ── after-action: attendance onto the record ── */
  r = await api("POST", "/api/events/" + botEvId + "/aar", { attendees: ["2002", "1001"], ships: "UEES Tiber", synopsis: "Door kicked." }, oak);
  ok(r.status === 403, "after-action reports are COMMAND's to file");
  r = await api("POST", "/api/events/" + botEvId + "/aar", { attendees: ["2002", "1001"], ships: "UEES Tiber", synopsis: "Door kicked." }, doc);
  ok(r.status === 200 && r.body.aar.attendees.length === 2, "COMMAND files the after-action report");
  r = await api("GET", "/api/personnel/2002", null, doc);
  ok(r.body.profile.record.some(e => e.kind === "event" && /Attended: Bot Door Op/.test(e.text)),
     "official attendance lands on the service record");
  r = await api("GET", "/api/bot/outbox", null, "Bot bot-secret-test");
  ok(r.body.jobs.some(j => j.type === "aar" && j.mission === "Bot Door Op" && j.personnel.length === 2),
     "the activity-tracker report goes out with the muster");

  /* ── Request Mast: up the chain, answered, resolved ── */
  r = await api("POST", "/api/mast", { subject: "Leave extension", body: "Requesting two more weeks." }, oak);
  ok(r.status === 200 && r.body.case.to === "1001", "a request routes to the nearest leader above on the chain");
  const mastId = r.body.case.id;
  r = await api("GET", "/api/mast", null, doc);
  ok(r.body.inbox.some(c => c.id === mastId), "the leader sees it in their inbox");
  r = await api("POST", "/api/mast/" + mastId + "/resolve", { text: "Approved." }, oak);
  ok(r.status === 403, "only the recipient resolves");
  r = await api("POST", "/api/mast/" + mastId + "/reply", { text: "Approved, enjoy." }, doc);
  r = await api("POST", "/api/mast/" + mastId + "/resolve", { text: "Approved." }, doc);
  ok(r.status === 200 && r.body.case.status === "resolved" && r.body.case.log.length === 3, "reply and resolution land on the case log");
  r = await api("GET", "/api/bot/outbox", null, "Bot bot-secret-test");
  ok(r.body.jobs.filter(j => j.type === "dm" && j.discordId === "2002").length >= 2, "the requester is DM'd at each stage");

  /* ── the muster desk: a manual record folds into its Discord arrival ── */
  r = await api("POST", "/api/personnel/add", { callsign: "Oak \"Gully\" Morcroft", rank: "PO2" }, doc);
  const gullyId = r.body.profile.discordId;
  r = await api("GET", "/api/personnel/unmatched", null, doc);
  const arrival = r.body.arrivals.find(a => a.id === "2002");
  ok(arrival && arrival.suggestions.some(s => s.id === gullyId && s.score >= 0.5),
     "the desk suggests the matching manual record for an arrival");
  r = await api("POST", "/api/personnel/merge", { manualId: gullyId, discordId: "2002" }, doc);
  ok(r.status === 200 && r.body.profile.rank.abbr === "PO2", "merging carries the roster rank onto the Discord account");
  r = await api("GET", "/api/personnel/" + gullyId, null, doc);
  ok(r.status === 404, "the manual shell is retired after the merge");

  /* ── logistics: one system — requisitions, stock, contributions, claims ── */
  r = await api("GET", "/api/logistics", null, oak);
  ok(r.status === 200 && r.body.treasury.handle === "Keleus_Harper" && typeof r.body.you.logistics === "boolean",
     "everyone reads the logistics desk and their own standing on it");
  /* Oak is the senior enlisted of LOGRON-88 → logistics approver by standing rule */
  await api("POST", "/api/personnel/bulk", { ids: ["2002"], action: { type: "rank", rank: "PO2" } }, doc);
  r = await api("POST", "/api/squadrons/logron-88/assign", { memberId: "2002", billet: "Quartermaster" }, doc);
  r = await api("GET", "/api/logistics", null, oak);
  ok(r.body.you.logistics === true && r.body.approvers.logistics.length >= 1,
     "LOGRON-88's senior enlisted holds logistics standing automatically");
  r = await api("POST", "/api/logistics/inventory", { name: "MedPen (Hemozal)", qty: 10, owner: "fleet", holder: "tiber", location: "sickbay" }, oak);
  ok(r.status === 200 && r.body.line.qty === 10 && r.body.line.owner === "fleet", "logistics books fleet stock with an owner and a holder");
  r = await api("POST", "/api/logistics/orders", { items: [{ name: "MedPen (Hemozal)", qty: 4 }], justification: "Corpsman kit" }, doc);
  ok(r.status === 200 && r.body.order.status === "submitted", "a member files a requisition");
  const reqId = r.body.order.id;
  r = await api("POST", "/api/logistics/orders/" + reqId + "/approve", {}, doc);
  ok(r.status === 200 && r.body.order.status === "logistics", "first approval is Logistics' (doc is COMMAND, which also carries it)");
  r = await api("POST", "/api/logistics/orders/" + reqId + "/approve", {}, oak);
  ok(r.status === 403, "the second approval is COMMAND's — Logistics cannot self-complete it");
  r = await api("POST", "/api/logistics/orders/" + reqId + "/approve", {}, doc);
  ok(r.status === 200 && r.body.order.status === "approved" && r.body.order.approvals.command, "COMMAND approves");
  r = await api("POST", "/api/logistics/orders/" + reqId + "/fulfil", {}, oak);
  ok(r.status === 200 && r.body.order.status === "fulfilled" && r.body.order.items[0].issued === 4, "fulfilment issues from fleet stock");
  r = await api("GET", "/api/logistics", null, oak);
  ok(r.body.inventory.some(l => l.holder === "1001" && l.qty === 4) && r.body.inventory.some(l => l.holder === "tiber" && l.qty === 6),
     "stock moves: four to the requester, six stay aboard Tiber");
  r = await api("POST", "/api/logistics/contributions", { kind: "auec", amount: 250000, proof: "screenshot-1" }, doc);
  const contribId = r.body.contribution.id;
  r = await api("POST", "/api/logistics/contributions/" + contribId + "/verify", {}, oak);
  ok(r.status === 200 && r.body.contribution.status === "verified", "Logistics verifies a contribution");
  r = await api("POST", "/api/logistics/claims", { amount: 100000, purpose: "Fuel for the Pyro run", proof: "receipt" }, doc);
  const claimId = r.body.claim.id;
  await api("POST", "/api/logistics/claims/" + claimId + "/approve", {}, oak);
  r = await api("POST", "/api/logistics/claims/" + claimId + "/pay", {}, oak);
  ok(r.status === 403, "only COMMAND marks a claim paid");
  r = await api("POST", "/api/logistics/claims/" + claimId + "/pay", {}, doc);
  ok(r.status === 200 && r.body.claim.status === "paid", "COMMAND pays the claim");
  r = await api("GET", "/api/logistics", null, doc);
  ok(r.body.treasury.inflow === 250000 && r.body.treasury.paid === 100000 && r.body.treasury.balance === 150000,
     "the treasury ledger nets contributions against reimbursements");
  ok(r.body.leaderboard[0] && r.body.leaderboard[0].amount === 250000, "verified contributions rank the leaderboard");
  r = await api("POST", "/api/logistics/blueprints", { blueprints: [{ name: "Atlas Quantum Drive", type: "Component S2", materials: "4 materials", sources: "9 drop sources" }] }, oak);
  ok(r.status === 200 && r.body.blueprints.length === 1 && r.body.blueprints[0].id === "atlas-quantum-drive", "logistics keeps the blueprint library");

  /* ── the document library: management uploads anything; a purview holder uploads for their rate ── */
  const pdfB64 = Buffer.from("%PDF-1.4 fleet test document").toString("base64");
  r = await api("POST", "/api/docs", { name: "corpsman-101.pdf", data: pdfB64, tag: "course", ref: "206" }, oak);
  ok(r.status === 403, "a member without a purview cannot upload");
  await api("POST", "/api/personnel/2002/scopes", { scopes: ["rate:hospital-corpsman"] }, doc);
  r = await api("POST", "/api/docs", { name: "corpsman-101.pdf", data: pdfB64, tag: "course", ref: "206", rate: "hospital-corpsman" }, oak);
  ok(r.status === 200 && r.body.file.ref === "206", "a rate purview holder uploads for that rate");
  const docId = r.body.file.id;
  r = await api("POST", "/api/docs", { name: "gunnery.pdf", data: pdfB64, tag: "course", ref: "202", rate: "naval-gunnery" }, oak);
  ok(r.status === 403, "…but not for a rate they don't hold");
  r = await api("POST", "/api/docs", { name: "gq.pdf", data: pdfB64, tag: "sop", ref: "101.1" }, doc);
  ok(r.status === 200, "management uploads without a rate");
  r = await api("GET", "/api/docs", null, oak);
  ok(r.body.files.length === 2 && r.body.canUpload === true && r.body.rates.join() === "hospital-corpsman", "the library lists files and each member's upload rights");
  r = await api("GET", "/api/docs/" + docId + "/file", null, oak);
  ok(r.status === 200 && r.headers["content-type"] === "application/pdf", "members open a document with their session");
  r = await api("POST", "/api/docs", { name: "evil.exe", data: pdfB64, tag: "course" }, doc);
  ok(r.status === 400, "unknown file types are refused");
  r = await api("POST", "/api/docs/" + docId + "/delete", {}, doc);
  ok(r.status === 200, "management removes a document");

  /* ── batch 3: Discord handles, departments, Marine elements, the Inactive
     Reserve, the spreadsheet door, RSI verification, unit art, branch ladders ── */
  r = await api("POST", "/api/bot/muster", { members: [{ id: "2002", username: "Oak", handle: "oak_tree", nick: "Oak", roles: [] }] }, "Bot bot-secret-test");
  ok(r.status === 200, "the muster accepts Discord handles");
  r = await api("GET", "/api/personnel/2002", null, doc);
  ok(r.body.profile.discordUser === "oak_tree", "a member's Discord handle is on the profile for search");
  /* Oak starts this batch holding nothing: every station relieved, every squadron left */
  const ships3 = (await api("GET", "/api/roster", null, doc)).body.ships;
  for (const sh of ships3) for (const d of sh.departments) for (const st of d.stations)
    if (st.assignee === "2002") await api("POST", "/api/roster/assign", { stationId: st.id, memberId: null }, doc);
  for (const sq of (await api("GET", "/api/squadrons", null, doc)).body.squadrons)
    if (sq.members.some(mm => mm.discordId === "2002")) await api("POST", "/api/squadrons/" + sq.id + "/assign", { memberId: "2002", billet: null }, doc);
  const tiber3 = ships3.find(s => s.id === "tiber");
  const dept3 = tiber3.departments.find(d => d.stations.some(st => !st.assignee));
  const engSt = dept3.stations.find(st => !st.assignee);
  r = await api("POST", "/api/roster/assign", { stationId: engSt.id, memberId: "2002" }, doc);
  r = await api("GET", "/api/personnel/2002", null, doc);
  ok(r.body.profile.billet === engSt.title + ", " + tiber3.name && r.body.profile.department === dept3.name + " · " + tiber3.name &&
     r.body.profile.units.ships.includes("tiber"), "a profile names its billet, department and units from the assignment");
  await api("POST", "/api/roster/assign", { stationId: engSt.id, memberId: null }, doc);
  r = await api("POST", "/api/squadrons/mg-212/assign", { memberId: "2002", billet: "Element Leader", element: "Reaper 1-1", tacsign: "Reaper 1-1", lead: true }, doc);
  ok(r.status === 200 && r.body.squadron.members[0].element === "Reaper 1-1" && r.body.squadron.members[0].tacsign === "Reaper 1-1" &&
     r.body.squadron.members[0].lead === true, "a squadron billet carries the element, tactical call sign and lead flag");
  r = await api("GET", "/api/personnel/2002", null, doc);
  ok(r.body.profile.department === "Reaper 1-1 · MG-212", "the department reads squad and squadron for a Marine");
  r = await api("POST", "/api/personnel/bulk", { ids: ["2002"], action: { type: "status", status: "reserve" } }, doc);
  ok(r.body.results["2002"].ok, "COMMAND transfers a member to the Inactive Reserve");
  r = await api("GET", "/api/personnel/2002", null, doc);
  ok(r.body.profile.status === "reserve" && r.body.profile.record.some(e => /Inactive Reserve/.test(e.text)), "…and the record says so");

  /* the spreadsheet door */
  r = await rawGet("/api/personnel/export.csv", doc);
  ok(r.status === 200 && /^\uFEFF?id,callsign,/.test(r.text) && /Reaper 1-1/.test(r.text) && /reserve/.test(r.text), "the roster exports as a CSV with squads, call signs and standing");
  r = await rawGet("/api/personnel/export.csv?template=1", doc);
  ok(r.status === 200 && r.text.split(/\r?\n/).filter(Boolean).length === 2 && /EXAMPLE/.test(r.text), "the blank template is the header plus one example row");
  r = await api("POST", "/api/login", { mockId: "7007", mockName: "Plain" });
  const plain = r.body.token;
  await api("POST", "/api/accounts/7007/role", { role: "member" }, doc);
  r = await rawGet("/api/personnel/export.csv", plain);
  ok(r.status === 403, "a member without keys or a purview cannot export the rolls");
  const csvText = ["id,callsign,rank,status,squadron,element,billet,tac_callsign,element_lead,certs,enlisted",
    "2002,,LT,active,MG-212,Reaper 1-2,Marine,Reaper 1-2 C,no,Hospital Corpsman,08/15/2026",
    ",Newbie Marine,SR,active,mg-212,Reaper 1-2,Marine,,no,,",
    ",EXAMPLE - DELETE THIS ROW,SR,,,,,,,,"].join("\n");
  r = await api("POST", "/api/personnel/import/csv", { csv: csvText, dryRun: true }, doc);
  ok(r.status === 200 && r.body.dryRun === true && r.body.applied === 2 && r.body.created === 1 && r.body.errors.length === 0,
     "a dry run reports two rows changing, one new member, no refusals");
  r = await api("GET", "/api/personnel", null, doc);
  ok(!r.body.roster.some(p => p.callsign === "NEWBIE MARINE"), "…and touches nothing");
  r = await api("POST", "/api/personnel/import/csv", { csv: csvText, quiet: true }, doc);
  ok(r.status === 200 && r.body.applied === 2 && r.body.created === 1, "the CSV applies");
  r = await api("GET", "/api/personnel/2002", null, doc);
  ok(r.body.profile.status === "active" && r.body.profile.rank.abbr === "LT" && r.body.profile.department === "Reaper 1-2 · MG-212" &&
     r.body.profile.certs.some(c => c.certId === "hospital-corpsman") && r.body.profile.joinedAt === Date.UTC(2026, 7, 15, 12),
     "oak is back on active duty, LT, in Reaper 1-2, enlisted 15AUG2956");
  r = await api("GET", "/api/personnel", null, doc);
  const newbie = r.body.roster.find(p => p.callsign === "NEWBIE MARINE");
  ok(newbie && newbie.manual && newbie.department === "Reaper 1-2 · MG-212", "the new Marine is on the rolls in Reaper 1-2");
  await api("POST", "/api/personnel/2002/scopes", { scopes: ["squadron:mg-212"] }, doc);
  r = await api("POST", "/api/personnel/import/csv", { csv: "callsign,rank,element,element_lead\nNewbie Marine,CAPT,Reaper 1-1,yes\n" }, oak);
  ok(r.status === 200 && r.body.applied === 1 && r.body.errors.length === 1 && /rank/.test(r.body.errors[0]),
     "a squadron lead moves their Marine between squads but cannot set ranks");
  r = await api("GET", "/api/personnel/" + newbie.discordId, null, doc);
  ok(r.body.profile.department === "Reaper 1-1 · MG-212" && r.body.profile.rank.abbr === "SR", "the squad moved, the rank did not");
  r = await api("POST", "/api/personnel/import/csv", { csv: "id,status\n1001,reserve\n" }, oak);
  ok(r.body.applied === 0 && r.body.errors.length === 1, "…and nothing changes for people outside their squadron");
  r = await api("POST", "/api/personnel/import/csv", { csv: "callsign,status\nBrand New,reserve\n" }, oak);
  ok(r.body.applied === 0 && /management adds/.test(r.body.errors[0]), "only management adds new names through the spreadsheet");

  /* RSI verification against the stand-in citizen page */
  r = await api("POST", "/api/rsi/start", { handle: "Oak-Tree" }, oak);
  ok(r.status === 200 && /^22EF-[A-Z2-9]{6}$/.test(r.body.code), "a member starts RSI verification and receives a one-time code");
  const rsiCode = r.body.code;
  r = await api("GET", "/api/personnel/me", null, oak);
  ok(r.body.profile.rsiPending && r.body.profile.rsiPending.code === rsiCode, "the pending code shows on their own profile");
  r = await api("GET", "/api/personnel/2002", null, doc);
  ok(!r.body.profile.rsiPending, "…and to nobody else");
  rsiStub.bio = "Fleet pilot. No code here.";
  r = await api("POST", "/api/rsi/check", {}, oak);
  ok(r.status === 200 && r.body.verified === false, "the check fails while the code is not in the bio");
  rsiStub.bio = "22nd EF — " + rsiCode;
  r = await api("POST", "/api/rsi/check", {}, oak);
  ok(r.body.verified === true && r.body.citizen === "#424242", "…and passes once it is, reading the citizen record");
  r = await api("GET", "/api/personnel/2002", null, doc);
  ok(r.body.profile.rsiHandle === "Oak-Tree" && r.body.profile.rsiVerified && r.body.profile.rsiVerified.citizen === "#424242" &&
     r.body.profile.record.some(e => /RSI account verified/.test(e.text)), "the verified handle lands on the profile and the record");
  await api("POST", "/api/rsi/start", { handle: "Nobody-Here" }, oak);
  r = await api("POST", "/api/rsi/check", {}, oak);
  ok(r.body.verified === false && /no citizen/.test(r.body.reason), "an unknown handle is reported, not verified");
  r = await api("POST", "/api/personnel/2002/rsi", { revoke: true }, doc);
  ok(r.status === 200 && r.body.profile.rsiVerified === null, "management can revoke a verification");

  /* unit art in the library */
  const pngB3 = Buffer.from("\x89PNG not really").toString("base64");
  r = await api("POST", "/api/docs", { name: "mg212.png", data: pngB3, tag: "logo", ref: "squadron:mg-212" }, oak);
  ok(r.status === 200 && r.body.file.tag === "logo", "a squadron lead files their unit's logo");
  r = await api("POST", "/api/docs", { name: "tiber.png", data: pngB3, tag: "logo", ref: "ship:tiber" }, oak);
  ok(r.status === 403, "…but not another unit's");
  r = await api("POST", "/api/docs", { name: "mg212-v2.png", data: pngB3, tag: "logo", ref: "squadron:mg-212" }, doc);
  r = await api("GET", "/api/docs?tag=logo", null, oak);
  ok(r.body.files.length === 1 && r.body.files[0].name === "mg212-v2.png", "a new logo replaces the old one for that unit");
  r = await api("GET", "/api/docs", null, oak);
  ok(!r.body.files.some(f => f.tag === "logo"), "logos stay out of the course library");

  /* Marine ranks beside their Navy peers, promotions along their own ladder */
  r = await api("GET", "/api/catalog", null, doc);
  const ladder3 = r.body.catalog.ranks.slice();
  const slotAfter = (abbr, entry) => { const i = ladder3.findIndex(x => x.abbr === abbr); ladder3.splice(i + 1, 0, entry); };
  slotAfter("LSM", { grade: "E-3", name: "Lance Corporal", abbr: "LCPL", branch: "marine" });
  slotAfter("PO2", { grade: "E-5", name: "Sergeant", abbr: "SGT", branch: "marine" });
  slotAfter("CPO", { grade: "E-7", name: "Gunnery Sergeant", abbr: "GYSGT", branch: "marine" });
  r = await api("POST", "/api/catalog", { ranks: ladder3 }, doc);
  ok(r.status === 200, "Marine ranks file beside their Navy pay-grade peers");
  await api("POST", "/api/personnel/bulk", { ids: [newbie.discordId], action: { type: "rank", rank: "LCPL" } }, doc);
  await api("POST", "/api/personnel/bulk", { ids: [newbie.discordId], action: { type: "rank", step: 1 } }, doc);
  r = await api("GET", "/api/personnel/" + newbie.discordId, null, doc);
  ok(r.body.profile.rank.abbr === "SGT", "a Marine promotion steps to the next Marine rank, past the Navy ones between");
  await api("POST", "/api/personnel/bulk", { ids: ["2002"], action: { type: "rank", rank: "PO2" } }, doc);
  await api("POST", "/api/personnel/bulk", { ids: ["2002"], action: { type: "rank", step: 1 } }, doc);
  r = await api("GET", "/api/personnel/2002", null, doc);
  ok(r.body.profile.rank.abbr === "PO1", "a Navy promotion skips the Marine rank filed beside it");

  /* ── batch 4: ribbons, the snapshot importer, the go-live reset, editable copy ── */
  r = await api("POST", "/api/catalog", { ribbons: [{ id: "pyro-campaign", name: "Pyro Campaign Ribbon", img: "", description: "Served in the Pyro system" },
    { id: "good-conduct", name: "Good Conduct Ribbon", img: "good-conduct.png", description: "" }] }, doc);
  ok(r.status === 200 && r.body.catalog.ribbons.length === 2, "the Fleet Office keeps a ribbons catalog");
  r = await api("GET", "/api/public");
  ok(r.body.ribbons && r.body.ribbons.length === 2, "ribbons are on the public registry");
  r = await api("POST", "/api/personnel/bulk", { ids: ["2002"], action: { type: "ribbon", ribbonId: "pyro-campaign", note: "Op Ember" } }, doc);
  ok(r.body.results["2002"].ok, "COMMAND issues a ribbon");
  r = await api("GET", "/api/personnel/2002", null, doc);
  ok(r.body.profile.ribbons.length === 1 && r.body.profile.ribbons[0].note === "Op Ember" && r.body.profile.record.some(e => e.kind === "ribbon"),
     "the ribbon sits on the profile rack and the record");
  r = await api("POST", "/api/personnel/import/csv", { csv: "id,ribbons\n2002,Good Conduct Ribbon; pyro-campaign\n" }, doc);
  r = await api("GET", "/api/personnel/2002", null, doc);
  ok(r.body.profile.ribbons.length === 2, "the spreadsheet pins ribbons by name or id, never twice");

  /* the snapshot importer: rich records, dry run first, idempotent */
  const ships4 = (await api("GET", "/api/roster", null, doc)).body.ships;
  const tiber4 = ships4.find(s => s.id === "tiber");
  let vac4 = null;
  for (const d of tiber4.departments) for (const st of d.stations) if (!vac4 && !st.assignee) vac4 = { d, st };
  const snap = { source: "22nd.space crawl", dryRun: true, members: [
    { discordId: "9009", callsign: "Jack Sheridan", discordUser: "sheridan", rank: "Petty Officer First Class", rating: "GM1", status: "active",
      joinedAt: "2024-03-01", rsiHandle: "Jack_Sheridan", timezone: "Central Time (US & Canada)",
      squadrons: [{ squadron: "Marine Group 212", billet: "Marine", element: "Reaper 1-2", tacsign: "Reaper 1-2 B", lead: false }],
      stations: [{ ship: tiber4.name, station: vac4.st.title }],
      certs: ["Gunner's Mate", { cert: "hospital-corpsman", at: "15AUG2956" }],
      awards: [{ award: "Navigator's Star", at: "2025-11-02", citation: "Charted the Pyro run" }],
      ribbons: [{ ribbon: "Good Conduct Ribbon", at: "01JAN2956" }],
      record: [{ at: "2025-06-10", kind: "deployment", text: "Deployed to Pyro with DESRON-38" }],
      orders: [{ at: "2025-06-01", unit: tiber4.name, title: vac4.st.title, text: "ASSIGNMENT ORDER — verbatim from the old portal" }],
      loa: false },
    { callsign: "Old Hand", rank: null, status: "reserve", loa: { since: "2026-01-05", reason: "Deployed IRL" } },
  ] };
  r = await api("POST", "/api/personnel/import", snap, doc);
  ok(r.status === 200 && r.body.dryRun === true && r.body.created === 2 && r.body.errors.length === 0 && r.body.changes.length === 2,
     "the snapshot dry run reports two new records and no refusals");
  r = await api("GET", "/api/personnel/9009", null, doc);
  ok(r.status === 404, "…and files nothing");
  snap.dryRun = false;
  r = await api("POST", "/api/personnel/import", snap, doc);
  ok(r.status === 200 && r.body.created === 2 && r.body.errors.length === 0, "the snapshot applies");
  r = await api("GET", "/api/personnel/9009", null, doc);
  const jack = r.body.profile;
  ok(jack && jack.callsign === "JACK SHERIDAN" && jack.manual === true && jack.rank.abbr === "PO1" && jack.rating === "GM1" && jack.discordUser === "sheridan" &&
     jack.joinedAt === Date.UTC(2024, 2, 1, 12), "a record filed under the Discord id carries name, rank, rate, handle and enlistment");
  ok(jack.department === vac4.d.name + " · " + tiber4.name && jack.units.squadrons.includes("mg-212") && jack.certs.length === 2 &&
     jack.awards.length === 1 && jack.awards[0].citation === "Charted the Pyro run" && jack.awards[0].at === Date.UTC(2025, 10, 2, 12) &&
     jack.ribbons.length === 1 && jack.record.some(e => e.kind === "deployment" && e.src === "22nd.space crawl") &&
     jack.orders.length === 1 && jack.orders[0].text.startsWith("ASSIGNMENT ORDER"),
     "seats, certs, the cited award, the ribbon, the record and the verbatim orders all land, tagged with their source");
  ok(jack.record.find(e => e.kind === "enlist").at === Date.UTC(2024, 2, 1, 12), "the enlistment entry takes the imported date");
  r = await api("POST", "/api/personnel/import", snap, doc);
  ok(r.body.created === 0 && r.body.updated === 2 && r.body.applied === 0, "re-running the snapshot changes nothing — nothing is doubled");
  r = await api("GET", "/api/personnel", null, doc);
  const oldHand = r.body.roster.find(p => p.callsign === "OLD HAND");
  ok(oldHand && oldHand.rank.abbr === "—" && oldHand.status === "reserve", "an unranked reservist stays honest");
  r = await api("GET", "/api/loa", null, doc);
  ok(r.body.active.some(l => l.discordId === oldHand.discordId && l.reason === "Deployed IRL"), "…and arrives on leave with the reason");
  /* a stand-in record named by matchId is re-filed under the Discord id and renamed */
  r = await api("POST", "/api/personnel/add", { callsign: "[HOA] Wren Kestrel (She/Her)", rank: "SM" }, doc);
  const wrenManual = r.body.profile.discordId;
  r = await api("POST", "/api/personnel/import", { source: "22nd.space crawl", members: [{ discordId: "9010", matchId: wrenManual, callsign: "Wren Kestrel", rank: "LSM" }] }, doc);
  ok(r.status === 200 && r.body.updated === 1 && r.body.created === 0 && /filed under Discord id 9010/.test(r.body.changes[0]), "a matched stand-in is re-filed under its Discord id, not duplicated");
  r = await api("GET", "/api/personnel/9010", null, doc);
  ok(r.status === 200 && r.body.profile.callsign === "WREN KESTREL" && r.body.profile.rank.abbr === "LSM" && r.body.profile.record.some(e => /Discord account linked/.test(e.text)), "…renamed, re-ranked, its record intact");
  r = await api("GET", "/api/personnel/" + wrenManual, null, doc);
  ok(r.status === 404, "…and the stand-in is gone");
  r = await api("POST", "/api/login", { mockId: "9009", mockName: "Sheridan" });
  ok(r.status === 200 && r.body.account.role === "member" && r.body.account.callsign === "JACK SHERIDAN",
     "when that Discord id signs in, the record is already theirs — no queue, no merge");
  await api("POST", "/api/bot/muster", { members: [{ id: "9009", username: "Sheridan", handle: "sheridan", nick: null, roles: [] }] }, "Bot bot-secret-test");
  r = await api("GET", "/api/personnel/9009", null, doc);
  ok(r.body.profile.manual === false, "seen on Discord, the pre-filed record stops being a stand-in");

  /* the go-live reset: a dry run inventories, RESET applies, imports and identities survive */
  r = await api("POST", "/api/admin/reset-baseline", { dryRun: true }, doc);
  ok(r.status === 200 && r.body.dryRun === true && r.body.inventory.records.awards >= 1 && r.body.inventory.logistics.orders >= 1 && r.body.inventory.mast >= 1,
     "the reset dry run inventories what would go");
  r = await api("POST", "/api/admin/reset-baseline", { confirm: "RESET" }, oak);
  ok(r.status === 403, "the reset is management's alone");
  r = await api("POST", "/api/admin/reset-baseline", {}, doc);
  ok(r.status === 200 && r.body.dryRun === true, "without the typed word it stays a dry run");
  r = await api("POST", "/api/admin/reset-baseline", { confirm: "RESET" }, doc);
  ok(r.status === 200 && r.body.dryRun === false, "COMMAND resets to the imported baseline");
  r = await api("GET", "/api/personnel/9009", null, doc);
  ok(r.body.profile.awards.length === 1 && r.body.profile.orders.length === 1 && r.body.profile.record.some(e => e.kind === "enlist") &&
     r.body.profile.rank.abbr === "PO1" && r.body.profile.units.squadrons.includes("mg-212") && r.body.profile.department === vac4.d.name + " · " + tiber4.name,
     "the imported record survives whole — award, orders, enlistment, rank, muster, seat");
  r = await api("GET", "/api/personnel/2002", null, doc);
  ok(r.body.profile.awards.length === 0 && r.body.profile.ribbons.length === 1 && r.body.profile.ribbons[0].ribbonId === "good-conduct" &&
     r.body.profile.scopes.length === 0 && r.body.profile.record.some(e => e.kind === "enlist") && r.body.profile.rank.abbr === "PO1",
     "test-session decorations and purviews are gone; the spreadsheet's ribbon, identity, enlistment and rank stay");
  r = await api("GET", "/api/logistics", null, doc);
  ok(r.body.orders.length === 0 && r.body.inventory.length === 0 && r.body.claims.length === 0, "the logistics desk is clean");
  r = await api("GET", "/api/mast", null, doc);
  ok(r.body.mine.length === 0 && r.body.inbox.length === 0, "no mast cases remain");
  r = await api("GET", "/api/audit?limit=5", null, doc);
  ok(r.body.entries.some(e => e.action === "reset-baseline"), "the reset itself is on the ledger");

  /* editable public copy */
  r = await api("GET", "/api/content?page=join.html");
  ok(r.status === 200 && r.body.ok && Object.keys(r.body.blocks).length === 0, "the public copy store answers without a sign-in");
  const dirtyHtml = "Enlist <b>today</b><script>alert(1)</script><a href=\"javascript:x\" onclick=\"y\">x</a> <img src=\"https://evil.example/x.png\">";
  r = await api("POST", "/api/content", { key: "join.html:abc123", page: "join.html", orig: "Enlist", html: dirtyHtml }, oak);
  ok(r.status === 403, "only management edits the public copy");
  r = await api("POST", "/api/content", { key: "join.html:abc123", page: "join.html", orig: "Enlist", html: dirtyHtml }, doc);
  ok(r.status === 200 && r.body.block.v === 1 && !/script|javascript|onclick|evil/.test(r.body.block.html) && /<b>today<\/b>/.test(r.body.block.html),
     "copy is published sanitized — bold stays; scripts, handlers and foreign images go");
  r = await api("POST", "/api/content", { key: "join.html:abc123", page: "join.html", orig: "Enlist", html: "Enlist <i>now</i>" }, doc);
  r = await api("GET", "/api/content?page=join.html");
  ok(r.body.blocks["join.html:abc123"].v === 2 && /now/.test(r.body.blocks["join.html:abc123"].html), "the newest version is what the page prints");
  r = await api("GET", "/api/content/history?key=join.html:abc123", null, doc);
  ok(r.body.versions.length === 2 && r.body.versions[0].v === 2, "every version is kept");
  r = await api("POST", "/api/content", { key: "join.html:abc123", restore: 1 }, doc);
  r = await api("GET", "/api/content?page=join.html");
  ok(r.body.blocks["join.html:abc123"].v === 3 && /today/.test(r.body.blocks["join.html:abc123"].html), "a restore republishes an old version as a new one");
  r = await api("POST", "/api/content", { key: "join.html:abc123", clear: true }, doc);
  r = await api("GET", "/api/content?page=join.html");
  ok(!r.body.blocks["join.html:abc123"], "clearing a block puts the printed copy back");
  r = await api("POST", "/api/docs", { name: "hero.png", data: pngB3, tag: "public" }, doc);
  ok(r.status === 200 && r.body.file.tag === "public", "management uploads a public image");
  const pubImg = r.body.file.id;
  r = await rawGet("/api/content/img/" + pubImg);
  ok(r.status === 200 && r.headers["content-type"] === "image/png", "…which the site serves to anyone");
  r = await api("POST", "/api/docs", { name: "hero2.png", data: pngB3, tag: "public" }, oak);
  ok(r.status === 403, "…but members cannot");
  r = await api("GET", "/api/docs", null, oak);
  ok(!r.body.files.some(f => f.tag === "public"), "public images stay out of the course library");

  await stop();
  fs.rmSync(dataDir, { recursive: true, force: true });
  console.log("\n✔ PORTAL API PASS — profiles, bulk actions, CoC, availability, events, SSO and the bot door hold their gates");
})().catch(async e => { console.error("✘ FAIL:", e); await stop(); fs.rmSync(dataDir, { recursive: true, force: true }); process.exit(1); });
