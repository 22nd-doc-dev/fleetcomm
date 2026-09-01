# 22EF Fleet Bot — API contract

The Discord bot that will live in the 22nd's server talks to the accounts
service's personnel layer. Everything it needs is already live; this file is
the contract to build the bot against.

## Authentication

One shared secret, set on the droplet: `BOT_API_TOKEN` in
`/etc/fleetcomm-accounts.env`. The bot sends it on every request:

    Authorization: Bot <BOT_API_TOKEN>

The bot acts with COMMAND-level write access. Every write it makes is
attributed in service records as `FLEET DISCORD BOT`; pass `onBehalf` with a
Discord display name when relaying a human's order and the record shows
`FLEET DISCORD BOT (for <name>)`. An unset `BOT_API_TOKEN` keeps the door
closed entirely. The base URL is `https://<droplet>/api`.

## What the bot can do today

| Purpose | Call |
|---|---|
| Read the roster (rank, awards, certs, standing, last seen) | `GET /api/personnel` |
| Read one member's full service record | `GET /api/personnel/<discordId>` |
| Promote / demote / award / certify / log — one or many members | `POST /api/personnel/bulk` `{ids:[...], action:{...}, onBehalf}` |
| Actions for bulk | `{type:"rank", step:±1}` · `{type:"rank", rank:"LT"}` · `{type:"award", awardId, citation}` · `{type:"cert", certId}` · `{type:"note", text}` |
| Read the catalogs (rank ladder, decorations, certifications) | `GET /api/catalog` |
| Read / publish the chain of command | `GET /api/coc` · `POST /api/coc {nodes}` |
| Read every member's painted availability | `GET /api/availability/all` |
| Create / delete events, read RSVPs | `POST /api/events` · `POST /api/events/<id>/delete` · `GET /api/events` |
| Activity tracker: recent service-record entries + last-seen | `GET /api/activity?since=<ms>` |
| Change fleet standing (pending→member→command, revoke) | `POST /api/accounts/<discordId>/role {role}` — relay ACLs follow |

Member identity is the **Discord user id** everywhere — the same id the bot
already has for every guild member, so no mapping table is ever needed.

## Examples

```bash
# promote two members, attributed to the CO who ran the slash command
curl -s https://<droplet>/api/personnel/bulk \
  -H 'Authorization: Bot <token>' -H 'Content-Type: application/json' \
  -d '{"ids":["1001","2002"],"action":{"type":"rank","step":1},"onBehalf":"Doc"}'

# poll for anything new since the last check (rank changes, awards, notes)
curl -s 'https://<droplet>/api/activity?since=1756700000000' \
  -H 'Authorization: Bot <token>'
```

## Suggested first features

1. `/promote @member` `/award @member <decoration>` — slash commands that call
   the bulk endpoint and announce the result in-channel.
2. A nightly digest posted to the wardroom channel from `/api/activity`.
3. Event mirroring: `POST /api/events` from Discord scheduled events, RSVP
   sync both ways.
4. Rank-role sync: when `/api/personnel` rank changes, update the member's
   Discord role to match the ladder.

Poll `/api/activity` rather than expecting webhooks — the service pushes
nothing (droplet stays simple); a 60s poll is plenty at fleet scale.
