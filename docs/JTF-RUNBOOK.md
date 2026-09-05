# Operation IMPERIAL HARVEST on FleetComm — COMMAND runbook

For the 22nd COMMAND operator who sets the radio up, and for LT Kyle3089 (SENTINEL ACTUAL,
OIC, 12th Battle Group) who runs the op. Everything here is done inside FleetComm
(ACCOUNTS & ACCESS) or is a message to send. Nothing needs Andy or the droplet on the day.

**Who can do what.** Adding organizations, setting net levels and flagging leads are 22nd
COMMAND actions — a 22nd account with COMMAND standing does the setup (Andy before he leaves,
or Barnes / Keleus). An allied operator signs in as ALLIED and cannot administer — EXCEPT an
**ORG LEAD**: an allied operator COMMAND flags on the roster (MAKE ORG LEAD) may create,
rename and delete nets inside their own organization's nets, and nowhere else; the relay
enforces it. Make LT Kyle3089 the lead of the 12th (and one lead per organization) and they
run their own nets on the day. Keep one 22nd COMMAND operator reachable for the rest.

## The plan (from OPORD 26-09 and fleet command)

Participating organizations and their Discord servers:

| Organization | Discord server id | Standing on FleetComm |
|---|---|---|
| 22nd Expeditionary Fleet | (the fleet's own) | members, as always |
| 12th Battle Group — DESRON-15, 13th Carrier Air Wing, 8th Expeditionary Marines, 55th Logistical Squadron | 832999076894605382 | ALLIED |
| 112th Carrier Strike Group | 717645988088643604 | ALLIED |
| 44th Battle Group | 1403475979074142411 | ALLIED |
| Joint Task Force AEGIS | 1501732069724786850 | ALLIED |
| Wildknights (allied ground, integrated with the 8th Marines) | **not on the list yet** | ALLIED if they have their own Discord; otherwise they sign in through the 12th's |
| GSI (allied fleet, fighters, ground QRF; command call sign UNION ACTUAL) | **not on the list yet** | ALLIED — needs its Discord server id |

Nets and who may enter them (the relay enforces this):

| Net | Level | Who | Suggested freq |
|---|---|---|---|
| `TASK FORCE AEGIS COMMAND` | JOINT | everyone — the fleet-wide net (the OPORD's QLink 8040.540) | 840.540 |
| `TASK FORCE AEGIS GROUND` | JOINT | ground leaders — 8th Marines, Wildknights, GSI QRF, ours (the OPORD's 8675.309) | 867.309 |
| `12TH BATTLE GROUP COMMAND` | 12th Battle Group ONLY (+ COMMAND) | the 12th's command net | 812.000 |
| `112TH CSG COMMAND` | 112th Carrier Strike Group ONLY (+ COMMAND) | | 811.200 |
| `44TH BATTLE GROUP COMMAND` | 44th Battle Group ONLY (+ COMMAND) | | 844.000 |
| `GSI COMMAND` | GSI ONLY (+ COMMAND) | once GSI's Discord id is on the list | 848.000 |
| `COMMAND NET` (ours, exists) | as it is | the 22nd's fleet command — allied operators never see it | 121.850 |

FleetComm frequencies are `NNN.NNN`; the OPORD's four-digit QLink channels are carried in the
name-adjacent form above. Change any of it freely — the names and levels are what matter.
"ORG ONLY (+ COMMAND)" means that organization's operators plus the 22nd's COMMAND, so the
coordinator can reach every command net; 22nd members and other orgs cannot. Expected head
count 30–80.

## Setup (20 minutes, once, a 22nd COMMAND operator, before Saturday)

1. **Add the organizations** — ACCOUNTS & ACCESS ▸ ALLIED ORGANIZATIONS ▸ server id + name ▸
   ADD ORG, one per row of the table above. Server id in Discord: Server Settings ▸ Widget,
   or Developer Mode (User Settings ▸ Advanced) ▸ right-click the server ▸ Copy Server ID.
   Ask GSI (and Wildknights if separate) for theirs and add them the same way — any time,
   even Saturday.
2. **Create the nets** on the COMMS board (COMMAND: right-click ▸ new net; a nest per
   organization if you want their internal nets grouped). Names as in the table.
3. **Set the levels** — ACCOUNTS & ACCESS ▸ NET ACCESS ▸ each net's dropdown: the two
   task-force nets to *JOINT — allied task force too*, each command net to its organization's
   *… ONLY (+ COMMAND)* entry (those entries appear once the org is on the list). A nest that
   holds allied nets needs the same level as its nets.
4. **Allies who sit in the 22nd's own Discord** (liaison officers, guests) arrive in the
   **AWAITING APPROVAL** group, not as ALLIED — the fleet's Discord wins at sign-in. Each row
   says which allied Discords they are in and, when Discord told us when they joined each,
   since when; the button on the row is the recommendation: **FILE AS <ORG>** for the Discord
   they joined first (their home), **APPROVE** for a recruit who joined the fleet's first,
   **PICK THEIR ORG ▸** when they are in several and there are no dates — then use the row's
   **CHANGE STANDING…** dropdown (the orgs they are in are listed first). The same dropdown
   moves an ALLIED operator to another organization or to fleet standing. The roster is
   grouped: the queue, one fold per allied organization, the fleet's rolls, the revoked.
   Above it, the relay line: **RELAY SYNC IN PROGRESS** for the seconds after any change,
   **RELAY IN STEP** once the relay has it — a RESTRICTED report only counts after IN STEP.
5. **Flag the leads** — once each organization's lead has signed in once (they appear in their
   organization's group), press MAKE LEAD on their row. From then on they can add
   nets under their organization's command net themselves (right-click ▸ new net); a new
   subnet inherits its parent's access, so it is theirs automatically.
6. **Send each organization the briefing below** and test with one volunteer from each:
   sign in, tune TASK FORCE AEGIS COMMAND, radio check.

## Briefing to send each organization

> **FleetComm for Operation IMPERIAL HARVEST (Saturday)**
> 1. Download FleetComm: https://github.com/22nd-doc-dev/fleetcomm/releases/latest
>    (Windows: `FleetComm-<version>-windows.exe`, run it — no install. Mac: `-macos.zip`.
>    Linux: the AppImage or Flatpak.)
> 2. Open it, press **SIGN IN WITH DISCORD**, and sign in with the Discord account that is in
>    **your organization's** server. You land straight on the board — no approval wait.
> 3. Type the **callsign you will use for this op** (e.g. `SENTINEL ACTUAL`, `UNION 2`) and
>    press CONNECT.
> 4. The board shows only the task-force nets. Press **TUNE** on `TASK FORCE AEGIS COMMAND`
>    and on your organization's command net. **TX** arms the net you talk on. Set your talk key
>    under the big PTT button — any key, mouse button, or flight-stick button. PageUp / PageDown
>    switch which armed net you talk on.
> 5. Say "radio check" on TASK FORCE AEGIS COMMAND.
> If sign-in says "not a member of the fleet Discord or of an allied task-force Discord": you
> used a Discord account that is not in your organization's server, or your organization is not
> on the list yet — tell your CO. "RESTRICTED" on a net means it is not yours, by design.

## On the day (SENTINEL ACTUAL runs the op; a 22nd COMMAND operator handles the first three)

- **Someone can't sign in** ("not a member…"): wrong Discord account, or their organization is
  not on the ALLIED ORGANIZATIONS list, or they are not in that server. Add the org / have them
  join / use the right account. Nothing to approve.
- **A net says ACCESS PENDING — RELAY SYNCING**: COMMAND just changed something and the relay
  is catching up; the app re-tunes by itself within about half a minute. Nothing to do.
- **A net says RESTRICTED for someone who should have it** (and ACCOUNTS says RELAY IN STEP):
  its level is wrong (or its nest's), or the person's standing is — an org's net admits that
  org's ALLIED operators and 22nd COMMAND, not MEMBERs. Fix the dropdown; they re-TUNE.
- **Someone must go**: roster ▸ REVOKE. Off the relay at once; REINSTATE brings them back.
- **An org lead cannot create a net**: they are creating it outside their organization's nets
  (the relay refuses) — a new net goes under their own command net, or a 22nd COMMAND creates it.
- **Voice stretched or doubled for one person**: on 1.4.11 and older this was Chromium parking
  the app's audio on a timer after 30 s of quiet while the game was in front; 1.4.12 keeps the
  output awake. Make sure they are on 1.4.12+. If it still happens there, SETTINGS ▸ SYSTEM LOG
  ▸ COPY and send it to Andy — the "audio diag" line says why.
- **"The relay is rate-limiting connections"**: several people behind one router or VPN. It
  clears in five minutes; don't mash CONNECT. The relay is configured to tolerate shared
  addresses for the op, so it should not happen.
- **Nobody can connect at all**: the relay's connection cap. Every tuned net is one connection
  per operator; the cap was raised to 600 for the op. If it was missed, fewer nets per person.
- **Reporting a bug**: SETTINGS ▸ SYSTEM LOG ▸ COPY, paste it to Andy.

## After the op

Remove the allied organizations (same block) and revoke or keep the ALLIED accounts; set the
task-force nets back to OPEN or delete them. The 22nd's own nets were never touched.

## Droplet checklist (Andy, before leaving — the only part outside the app)

Relay (`/etc/mumble/mumble-server.ini` — the file the unit actually reads; `/etc/mumble-server.ini` is a dead file — then restart when nobody is on): `users=600`,
`autobanSuccessfulConnections=false`, `autobanAttempts=30`. Accounts service at v1.4.11 or later
(ALLIED standing, JOINT and per-org levels, org leads, the read-back ACL sync that survives
the relay's message limit, join dates), pulled from the tag — accounts-service.js and
portal-api.js, backups kept. The relay's live ini is `/etc/mumble/mumble-server.ini`: users,
messagelimit=10, messageburst=50 and the autoban lines belong THERE (restart needed), and
RELAY_MSG_LIMIT/RELAY_MSG_BURST in the service env must match it.
