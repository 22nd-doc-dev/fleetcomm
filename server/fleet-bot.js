#!/usr/bin/env node
/* ── 22EF FLEET BOT — the portal's voice on Discord ─────────────────────────
   LT Crunch's relief. Zero dependencies: Node 22+'s native WebSocket for the
   gateway, global fetch for REST. The portal stays the single source of
   truth; this process mirrors it outward and relays clicks back:

     · drains the portal's outbox (events, announcements, role syncs)
     · posts LT Crunch-style event cards with RSVP buttons; button clicks
       land on the portal's RSVP ledger, and website RSVPs update the card
     · reminds the tagged squadrons ahead of start (config: remindHours)
     · pulls the guild muster (nicknames, roles) into the portal
     · reflects rank + squadron membership as guild roles — touching ONLY
       roles whose names the fleet manages, never anything else

   Env: DISCORD_BOT_TOKEN, DISCORD_GUILD_ID, BOT_API_TOKEN,
        PORTAL_API (default http://127.0.0.1:8722)
   ──────────────────────────────────────────────────────────────────────── */
"use strict";

const TOKEN = String(process.env.DISCORD_BOT_TOKEN || "").trim();
const GUILD = String(process.env.DISCORD_GUILD_ID || "").trim();
const DOOR = String(process.env.BOT_API_TOKEN || "").trim();
const PORTAL = String(process.env.PORTAL_API || "http://127.0.0.1:8722").replace(/\/$/, "");
if (!TOKEN || !GUILD || !DOOR) {
  console.error("[bot] DISCORD_BOT_TOKEN, DISCORD_GUILD_ID and BOT_API_TOKEN are required");
  process.exit(1);
}

const log = (...a) => console.log("[bot]", new Date().toISOString().slice(11, 19), ...a);
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");

/* ── portal client (the bot door) ── */
async function papi(method, path, body) {
  const res = await fetch(PORTAL + path, {
    method,
    headers: { Authorization: "Bot " + DOOR, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    const err = new Error(data.error || ("portal " + res.status));
    err.status = res.status;
    throw err;
  }
  return data;
}

/* ── Discord REST (v10) with rate-limit patience ── */
async function dapi(method, path, body, extraHeaders) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch("https://discord.com/api/v10" + path, {
      method,
      headers: Object.assign({
        Authorization: "Bot " + TOKEN,
        "User-Agent": "DiscordBot (https://22d.space, 1.0) 22EF-FleetBot",
      }, body === undefined ? {} : { "Content-Type": "application/json" }, extraHeaders || {}),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 429) {
      const j = await res.json().catch(() => ({}));
      const wait = Math.min(30000, Math.ceil((j.retry_after || 1) * 1000));
      log("rate limited on", path, "— waiting", wait + "ms");
      await new Promise(r => setTimeout(r, wait));
      continue;
    }
    if (res.status === 204) return null;
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const err = new Error("discord " + res.status + " on " + method + " " + path +
        (data && data.message ? " — " + data.message : ""));
      err.status = res.status;
      throw err;
    }
    return data;
  }
  throw new Error("discord kept rate-limiting " + path);
}

/* ── guild state (from gateway + REST) ── */
const state = {
  ready: false,          /* gateway up and guild seen */
  botId: null,
  channels: new Map(),   /* normName -> id (text channels) */
  roles: new Map(),      /* normName -> {id, name} */
  cfg: null,             /* portal /api/bot/config payload */
};

function channelFor(kind) {
  const want = state.cfg && state.cfg.config.channels[kind];
  return want ? state.channels.get(norm(want)) || null : null;
}

function captureGuild(g) {
  state.channels.clear();
  for (const c of g.channels || []) if (c.type === 0) state.channels.set(norm(c.name), c.id);
  state.roles.clear();
  for (const r of g.roles || []) state.roles.set(norm(r.name), { id: r.id, name: r.name });
  log("guild mapped:", state.channels.size, "text channels,", state.roles.size, "roles");
}

let mapTimer = null, mapping = false;
async function refreshGuildMaps() {
  if (mapping) return;
  mapping = true;
  try {
    const [channels, roles] = await Promise.all([
      dapi("GET", "/guilds/" + GUILD + "/channels"),
      dapi("GET", "/guilds/" + GUILD + "/roles"),
    ]);
    captureGuild({ channels, roles });
  } catch (e) { log("guild map refresh failed:", e.message); }
  finally { mapping = false; }
}
/* setup bursts (channel after channel) collapse into one refresh */
function scheduleMapRefresh() { clearTimeout(mapTimer); mapTimer = setTimeout(refreshGuildMaps, 3000); }

/* ── embeds, LT Crunch's uniform ── */
const GOLD = 0xC9A96A, GREEN = 0x5CA877, RED = 0xC0604A;
const FOOTER = { text: "UEES Operations Command" };
const ts = (ms, style) => "<t:" + Math.floor(ms / 1000) + ":" + style + ">";

function eventEmbed(ev) {
  const fields = [
    { name: "🎖️ Event Tier", value: ev.tier || "OPERATION" },
    { name: "🔔 Start Time", value: ts(ev.at, "F") },
  ];
  if (ev.endAt) fields.push({ name: "🔔 End Time", value: ts(ev.endAt, "F") });
  fields.push({ name: "📆 Event Countdown", value: ts(ev.at, "R") });
  if (ev.location) fields.push({ name: "🌐 Location", value: ev.location });
  if (ev.uniform) fields.push({ name: "👕 Uniform of the Day", value: ev.uniform });
  fields.push({ name: "📊 Attendance", value:
    "✅ Attending: **" + ev.counts.going + "**\n" +
    "❌ Not Attending: **" + ev.counts.no + "**\n" +
    "❓ Unsure: **" + ev.counts.maybe + "**" });
  return {
    title: "🪖 EVENT - " + new Date(ev.at).toISOString().slice(0, 10) + " - " + ev.title.toUpperCase(),
    description: ev.brief || "",
    color: GOLD, fields, footer: FOOTER, timestamp: new Date().toISOString(),
  };
}

function eventComponents(eventId) {
  return [
    { type: 1, components: [
      { type: 2, style: 3, label: "Attending", emoji: { name: "✅" }, custom_id: "rsvp:going:" + eventId },
      { type: 2, style: 4, label: "Not Attending", custom_id: "rsvp:no:" + eventId },
      { type: 2, style: 2, label: "Unsure", emoji: { name: "❓" }, custom_id: "rsvp:maybe:" + eventId },
    ] },
    { type: 1, components: [
      { type: 2, style: 1, label: "View Attending", emoji: { name: "👥" }, custom_id: "view:going:" + eventId },
      { type: 2, style: 1, label: "View Not Attending", emoji: { name: "👥" }, custom_id: "view:no:" + eventId },
      { type: 2, style: 1, label: "View Unsure", emoji: { name: "👥" }, custom_id: "view:maybe:" + eventId },
      { type: 2, style: 2, label: "Remind", emoji: { name: "🔔" }, custom_id: "remind:now:" + eventId },
    ] },
  ];
}

function attentionLine(ev) {
  const ids = (ev.attention || [])
    .map(name => state.roles.get(norm(name)))
    .filter(Boolean).map(r => r.id);
  return {
    content: ids.length ? "**Attention To:** " + ids.map(id => "<@&" + id + ">").join(" ") : "",
    allowed: { parse: [], roles: ids },
  };
}

const mentionOf = (item) =>
  item.discordId && !String(item.discordId).startsWith("m-") ? " <@" + item.discordId + ">" : "";

function announceEmbeds(job) {
  const out = [];
  for (const it of job.items || []) {
    if (job.kind === "rank" && it.promoted) out.push({
      title: "PROMOTION - " + it.name.toUpperCase(),
      description: "To all who see these presents, greetings:\n\n" +
        "Know ye, that reposing special trust and confidence in the fidelity and abilities of **" +
        it.fromRank + "**" + mentionOf(it) + " **" + it.name + "**, hereby, shall be promoted to the rank of **" +
        it.toRank + "** in the UEE Navy. The recipient shall discharge the duties of their previous rank " +
        "and assume the duties and responsibilities commensurate with their new station.",
      color: GOLD, footer: FOOTER,
    });
    else if (job.kind === "rank") out.push({
      title: "REDUCTION IN RANK - " + it.name.toUpperCase(),
      description: "**" + it.name + "**" + mentionOf(it) + " is reduced from **" + it.fromRank +
        "** to **" + it.toRank + "**, by order of " + (job.by || "COMMAND") + ".",
      color: RED, footer: FOOTER,
    });
    else if (job.kind === "award") out.push({
      title: "DECORATION - " + it.name.toUpperCase(),
      description: "**" + it.name + "**" + mentionOf(it) + " is hereby awarded the **" + it.award + "**." +
        (it.citation ? "\n\n*" + it.citation + "*" : ""),
      color: GOLD, footer: FOOTER,
    });
    else if (job.kind === "cert") out.push({
      title: "CERTIFICATION - " + it.name.toUpperCase(),
      description: "**" + it.name + "**" + mentionOf(it) + " is certified: **" + it.cert + "**.",
      color: GREEN, footer: FOOTER,
    });
    else if (job.kind === "assignment") out.push({
      title: "ASSIGNMENT ORDERS",
      description: "**" + it.name + "**" + mentionOf(it) + " — " + it.text + ".",
      color: GOLD, footer: FOOTER,
    });
  }
  return out;
}

/* ── outbox drain ── */
const jobFails = new Map();
let draining = false;
async function drainOutbox() {
  if (draining || !state.ready || !state.cfg) return;
  draining = true;
  try {
    const { jobs } = await papi("GET", "/api/bot/outbox");
    for (const job of jobs) {
      const held = jobFails.get(job.id);
      if (held && Date.now() < held.nextTry) continue;  /* cooling off */
      try {
        const result = await handleJob(job);
        if (result === "wait") continue;               /* channel not there yet — keep queued */
        await papi("POST", "/api/bot/outbox/ack", { id: job.id, result: result || {} });
        jobFails.delete(job.id);
      } catch (e) {
        if (e.status === 403) {
          /* an access wall is Command's to open, not a poison job — hold the
             card until CAPT Glasc is allowed into the channel */
          log("job", job.type, job.id, "blocked: the bot lacks access to the target channel —",
            "grant the FleetComm role View Channel + Send Messages there; the card posts itself once opened");
          jobFails.set(job.id, { n: 0, nextTry: Date.now() + 30000 });
          continue;
        }
        const n = ((held && held.n) || 0) + 1;
        jobFails.set(job.id, { n, nextTry: Date.now() + Math.min(n * 30000, 300000) });
        log("job", job.type, job.id, "failed (" + n + "):", e.message);
        if (n >= 8) {                                   /* poison — drop it, loudly */
          await papi("POST", "/api/bot/outbox/ack", { id: job.id, result: { failed: e.message } })
            .catch(() => {});
          jobFails.delete(job.id);
          log("job", job.id, "dropped after 8 failures");
        }
      }
    }
  } catch (e) { log("outbox drain failed:", e.message); }
  finally { draining = false; }
}

async function handleJob(job) {
  if (job.type === "event") {
    const chan = channelFor("events");
    if (!chan) { log("waiting for an #%s channel", state.cfg.config.channels.events); return "wait"; }
    const { event } = await papi("GET", "/api/bot/event/" + job.eventId);
    const att = attentionLine(event);
    const msg = await dapi("POST", "/channels/" + chan + "/messages", {
      content: att.content, allowed_mentions: att.allowed,
      embeds: [eventEmbed(event)], components: eventComponents(job.eventId),
    });
    log("event posted:", event.title);
    return { channelId: chan, messageId: msg.id };
  }
  if (job.type === "event-update") {
    const { event } = await papi("GET", "/api/bot/event/" + job.eventId).catch(() => ({ event: null }));
    if (!event || !event.discordMsg) return {};        /* deleted or never posted */
    await dapi("PATCH", "/channels/" + event.discordMsg.channelId + "/messages/" + event.discordMsg.messageId,
      { embeds: [eventEmbed(event)], components: eventComponents(job.eventId) });
    return {};
  }
  if (job.type === "announce") {
    const kind = job.kind === "assignment" ? "assignments" : "announce";
    const chan = channelFor(kind);
    if (!chan) { log("waiting for an announce channel (#" + state.cfg.config.channels[kind] + ")"); return "wait"; }
    const embeds = announceEmbeds(job);
    for (let i = 0; i < embeds.length; i += 10)        /* ≤10 embeds per message */
      await dapi("POST", "/channels/" + chan + "/messages", {
        embeds: embeds.slice(i, i + 10),
        allowed_mentions: { parse: [], users: (job.items || []).map(x => x.discordId)
          .filter(id => id && !String(id).startsWith("m-")) },
      });
    return {};
  }
  if (job.type === "remind-now") {
    if (!(await postReminder(job.eventId))) { log("waiting for a reminders channel"); return "wait"; }
    log("manual reminder sounded for event", job.eventId);
    return {};
  }
  if (job.type === "roles") {
    if (!state.cfg.config.syncRoles) return {};
    await syncMemberRoles(job.discordId);
    return {};
  }
  log("unknown job type", job.type, "— acking away");
  return {};
}

/* ── role reflection: only names the fleet manages, nothing else ── */
let rolePlanCache = { at: 0, data: null };
async function rolePlan() {
  if (Date.now() - rolePlanCache.at > 10000)
    rolePlanCache = { at: Date.now(), data: await papi("GET", "/api/bot/roleplan") };
  return rolePlanCache.data;
}
async function syncMemberRoles(discordId) {
  const { plan, managed } = await rolePlan();
  const mine = plan.find(x => x.discordId === discordId);
  if (!mine) return;                                    /* not on the rolls — leave them be */
  const managedIds = new Map();                         /* roleId -> norm name, guild-existing managed roles */
  for (const name of managed) {
    const r = state.roles.get(norm(name));
    if (r) managedIds.set(r.id, norm(name));
  }
  const desired = new Set(mine.roles.map(n => (state.roles.get(norm(n)) || {}).id).filter(Boolean));
  let member;
  try { member = await dapi("GET", "/guilds/" + GUILD + "/members/" + discordId); }
  catch (e) { if (e.status === 404) return; throw e; }  /* not in the guild */
  const current = new Set(member.roles || []);
  for (const id of desired) if (!current.has(id))
    await dapi("PUT", "/guilds/" + GUILD + "/members/" + discordId + "/roles/" + id, undefined,
      { "X-Audit-Log-Reason": "22EF portal sync" });
  for (const id of current) if (managedIds.has(id) && !desired.has(id))
    await dapi("DELETE", "/guilds/" + GUILD + "/members/" + discordId + "/roles/" + id, undefined,
      { "X-Audit-Log-Reason": "22EF portal sync" });
  log("roles synced for", discordId);
}

/* one reminder, wherever it was asked for */
async function postReminder(eventId) {
  const chan = channelFor("reminders");
  if (!chan) return false;
  const { event } = await papi("GET", "/api/bot/event/" + eventId);
  const att = attentionLine(event);
  await dapi("POST", "/channels/" + chan + "/messages", {
    content: att.content, allowed_mentions: att.allowed,
    embeds: [eventEmbed(event)], components: eventComponents(eventId),
  });
  return true;
}

/* ── reminders: ping the tagged squadrons ahead of start ── */
let reminding = false;
async function remindSweep() {
  if (reminding || !state.ready || !state.cfg) return;
  reminding = true;
  try {
    const chan = channelFor("reminders");
    if (!chan) return;
    const { events } = await papi("GET", "/api/events");
    const now = Date.now();
    for (const ev of events) {
      if (!(ev.at > now)) continue;
      for (const h of state.cfg.config.remindHours || []) {
        const tag = "r" + h;
        if ((ev.reminded || {})[tag] || ev.at - now > h * 3600e3) continue;
        if (!(await postReminder(ev.id))) continue;
        await papi("POST", "/api/bot/reminded", { eventId: ev.id, tag });
        log("reminder posted:", ev.title, "(" + tag + ")");
      }
    }
  } catch (e) { log("reminder sweep failed:", e.message); }
  finally { reminding = false; }
}

/* ── muster: the guild's members land on the portal ── */
let mustering = false, musterSoon = null;
async function musterSync() {
  if (mustering || !state.ready) return;
  mustering = true;
  try {
    const members = [];
    let after = "0";
    for (let page = 0; page < 20; page++) {
      const batch = await dapi("GET", "/guilds/" + GUILD + "/members?limit=1000&after=" + after);
      if (!batch.length) break;
      for (const m of batch) {
        if (m.user && m.user.bot) continue;
        members.push({ id: m.user.id, username: m.user.global_name || m.user.username,
          nick: m.nick || null, roles: m.roles || [] });
      }
      after = batch[batch.length - 1].user.id;
      if (batch.length < 1000) break;
    }
    const r = await papi("POST", "/api/bot/muster", { members });
    log("muster synced:", members.length, "souls on Discord,", r.linked, "linked to the rolls");
  } catch (e) { log("muster failed:", e.message); }
  finally { mustering = false; }
}
function scheduleMuster() {
  clearTimeout(musterSoon);
  musterSoon = setTimeout(musterSync, 30000);          /* debounce member churn */
}

/* ── interactions: the buttons ── */
async function onInteraction(d) {
  if (d.type !== 3 || !d.data || !d.data.custom_id) return;
  const [verb, answer, eventId] = d.data.custom_id.split(":");
  const userId = d.member && d.member.user ? d.member.user.id : (d.user && d.user.id);
  const reply = (content) => dapi("POST", "/interactions/" + d.id + "/" + d.token + "/callback",
    { type: 4, data: { content, flags: 64, allowed_mentions: { parse: [] } } });
  const LABEL = { going: "Attending", no: "Not Attending", maybe: "Unsure" };
  const MARK = { going: "✅", no: "❌", maybe: "❓" };
  try {
    if (verb === "rsvp") {
      try {
        await papi("POST", "/api/bot/rsvp", { eventId, discordId: userId, answer });
      } catch (e) {
        await reply(e.status === 403
          ? "🚪 You're not on the fleet rolls yet — sign in at the portal with Discord first, and COMMAND will clear you aboard."
          : "The portal refused that: " + e.message);
        return;
      }
      await reply(MARK[answer] + " You are marked as **" + LABEL[answer] + "**");
      /* the card follows immediately */
      const { event } = await papi("GET", "/api/bot/event/" + eventId);
      if (event.discordMsg) await dapi("PATCH",
        "/channels/" + event.discordMsg.channelId + "/messages/" + event.discordMsg.messageId,
        { embeds: [eventEmbed(event)], components: eventComponents(eventId) }).catch(() => {});
      /* and any copy of the card the click came from */
      if (d.message && d.message.id && (!event.discordMsg || d.message.id !== event.discordMsg.messageId))
        await dapi("PATCH", "/channels/" + d.channel_id + "/messages/" + d.message.id,
          { embeds: [eventEmbed(event)], components: eventComponents(eventId) }).catch(() => {});
    } else if (verb === "remind") {
      let prof = null;
      try { prof = (await papi("GET", "/api/personnel/" + userId)).profile; } catch (e) {}
      if (!prof || prof.role !== "command") {
        await reply("🔔 Sounding the reminder is COMMAND's call.");
        return;
      }
      if (await postReminder(eventId)) await reply("🔔 Reminder sounded — the squadrons are pinged.");
      else await reply("No reminders channel answers — check the channel names.");
    } else if (verb === "view") {
      const { event } = await papi("GET", "/api/bot/event/" + eventId);
      const list = event.lists[answer] || [];
      await dapi("POST", "/interactions/" + d.id + "/" + d.token + "/callback", {
        type: 4, data: { flags: 64, embeds: [{
          title: MARK[answer] + " " + LABEL[answer] + " (" + list.length + ")",
          description: list.length ? list.map((n, i) => (i + 1) + ". " + n).join("\n") : "Nobody yet.",
          color: answer === "going" ? GREEN : answer === "no" ? RED : GOLD,
          footer: FOOTER, timestamp: new Date().toISOString(),
        }] },
      });
    }
  } catch (e) {
    log("interaction failed:", e.message);
    await reply("Something jammed — try again in a moment.").catch(() => {});
  }
}

/* ── the gateway ── */
let ws = null, seq = null, sessionId = null, resumeUrl = null;
let heartbeatTimer = null, awaitedAck = false, backoff = 1000;

function connectGateway(resume) {
  const base = resume && resumeUrl ? resumeUrl : "wss://gateway.discord.gg";
  ws = new WebSocket(base + "/?v=10&encoding=json");
  ws.addEventListener("open", () => { backoff = 1000; });
  ws.addEventListener("message", (ev) => {
    let p;
    try { p = JSON.parse(ev.data); } catch (e) { return; }
    if (p.s) seq = p.s;
    if (p.op === 10) {                                  /* HELLO */
      clearInterval(heartbeatTimer);
      awaitedAck = false;
      heartbeatTimer = setInterval(() => {
        if (awaitedAck) { log("heartbeat lost — reconnecting"); try { ws.close(4009); } catch (e) {} return; }
        awaitedAck = true;
        ws.send(JSON.stringify({ op: 1, d: seq }));
      }, p.d.heartbeat_interval);
      if (resume && sessionId) {
        ws.send(JSON.stringify({ op: 6, d: { token: TOKEN, session_id: sessionId, seq } }));
      } else {
        ws.send(JSON.stringify({ op: 2, d: { token: TOKEN, intents: 3,
          properties: { os: process.platform, browser: "22ef-fleet-bot", device: "22ef-fleet-bot" } } }));
      }
    } else if (p.op === 11) awaitedAck = false;         /* HEARTBEAT ACK */
    else if (p.op === 1) ws.send(JSON.stringify({ op: 1, d: seq }));
    else if (p.op === 7) { try { ws.close(4000); } catch (e) {} }
    else if (p.op === 9) {                              /* INVALID SESSION */
      sessionId = p.d === true ? sessionId : null;
      setTimeout(() => { try { ws.close(4008); } catch (e) {} }, 1500);
    } else if (p.op === 0) onDispatch(p.t, p.d);
  });
  ws.addEventListener("close", (ev) => {
    clearInterval(heartbeatTimer);
    state.ready = false;
    const canResume = sessionId && ev.code !== 4004 && ev.code < 4010;
    log("gateway closed (" + ev.code + ") —", canResume ? "resuming" : "re-identifying", "in", backoff + "ms");
    if (ev.code === 4004) { console.error("[bot] the Discord token was refused — check DISCORD_BOT_TOKEN"); process.exit(1); }
    setTimeout(() => connectGateway(canResume), backoff);
    backoff = Math.min(backoff * 2, 60000);
  });
  ws.addEventListener("error", () => { /* close follows */ });
}

function onDispatch(t, d) {
  if (t === "READY") {
    sessionId = d.session_id;
    resumeUrl = d.resume_gateway_url;
    state.botId = d.user.id;
    log("gateway ready as", d.user.username, "(" + state.botId + ")");
  } else if (t === "RESUMED") {
    state.ready = true;
    log("gateway resumed");
  } else if (t === "GUILD_CREATE" && String(d.id) === GUILD) {
    captureGuild(d);
    state.ready = true;
    musterSync();
  } else if (t === "INTERACTION_CREATE") {
    onInteraction(d);
  } else if (["GUILD_MEMBER_ADD", "GUILD_MEMBER_UPDATE", "GUILD_MEMBER_REMOVE"].includes(t)) {
    scheduleMuster();
  } else if (["GUILD_ROLE_CREATE", "GUILD_ROLE_UPDATE", "GUILD_ROLE_DELETE",
              "CHANNEL_CREATE", "CHANNEL_UPDATE", "CHANNEL_DELETE"].includes(t)) {
    scheduleMapRefresh();
  }
}

/* ── boot: wait for the portal, then raise Discord ── */
(async () => {
  for (;;) {
    try { state.cfg = await papi("GET", "/api/bot/config"); break; }
    catch (e) { log("portal not answering (" + e.message + ") — retrying in 5s"); }
    await new Promise(r => setTimeout(r, 5000));
  }
  log("portal door open —", state.cfg.squadrons.length, "squadrons,", state.cfg.ranks.length, "ranks on file");
  connectGateway(false);
  setInterval(async () => {
    try { state.cfg = await papi("GET", "/api/bot/config"); } catch (e) {}
  }, 60000);
  setInterval(drainOutbox, 4000);
  setInterval(remindSweep, 60000);
  setInterval(musterSync, 600000);
})();
