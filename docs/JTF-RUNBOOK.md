# Joint Task Force on FleetComm — COMMAND runbook

For the COMMAND operator running the net on the day. Everything here is done inside FleetComm
(ACCOUNTS & ACCESS) or is a message to send. Nothing needs Andy or the droplet.

## How it works, in four lines

- Allied operators sign in with **their own Discord**. If their Discord server is on the ALLIED
  ORGANIZATIONS list, they arrive with standing **ALLIED**: no approval queue, their org shown
  on the roster, and they can enter **only nets marked JOINT**. Fleet nets stay ours.
- Fleet members are unchanged. A fleet member who is also in an allied Discord is still a member.
- The relay enforces all of it (channel ACLs), not the app. An allied operator who tries a fleet
  net sees RESTRICTED.
- Removing an org stops new sign-ins from it. Revoking a person (roster ▸ REVOKE) throws them off
  the relay immediately.

## Before the op (30 minutes, once)

1. **Add each allied organization** — ACCOUNTS & ACCESS ▸ ALLIED ORGANIZATIONS ▸ Discord server
   id + name ▸ ADD ORG. The server id is a number: in Discord, Server Settings ▸ Widget shows it,
   or turn on Developer Mode (User Settings ▸ Advanced) and right-click the server ▸ Copy Server ID.
2. **Create the joint nets** on the COMMS board (COMMAND: right-click ▸ new net / nest). Suggested
   shape — one nest per organisation plus the coordination nets:
   - `JTF COMMAND` — task-force command net (COs and the coordinator)
   - `JTF COORD` — the all-hands coordination net (everyone tunes this)
   - `<ORG> TAC 1`, `<ORG> TAC 2` … — each organisation's own tactical nets
   - `JTF EMERGENCY` — guard, if the op wants one
3. **Mark them JOINT** — ACCOUNTS & ACCESS ▸ NET ACCESS ▸ the net's dropdown ▸ *JOINT — allied task
   force too*. Do this for every net allied operators must reach, including the NEST they sit
   in (the relay needs the parent open to reach the child). Leave fleet nets as they are.
4. **Send the allied orgs the briefing below.** Test with one volunteer from each org the day
   before: sign in, tune JTF COORD, talk.

## Briefing to send each allied organisation

> **FleetComm for Saturday's joint op**
> 1. Download FleetComm: https://github.com/22nd-doc-dev/fleetcomm/releases/latest
>    (Windows: `FleetComm-<version>-windows.exe`, run it — no install. Mac: the `-macos.zip`.
>    Linux: the AppImage or Flatpak.)
> 2. Open it, press **SIGN IN WITH DISCORD**, sign in with the Discord account that is in **your
>    organisation's** server. You will land straight on the board — no approval wait.
> 3. Type the **callsign you will use for this op** (e.g. `BLUE ACTUAL`) and press CONNECT.
> 4. On the COMMS board you will see only the joint task-force nets. Press **TUNE** on
>    `JTF COORD` and on your organisation's tactical net. **TX** arms the net you talk on; set your
>    talk key under the big PTT button (any key, mouse button, or flight-stick button).
> 5. Say "radio check" on JTF COORD.
> Problems: "not a member of the fleet Discord or of an allied task-force Discord" = you signed in
> with a Discord account that is not in your org's server, or your org is not on the list yet —
> tell your CO. "RESTRICTED" on a net = that net is fleet-only, by design.

## On the day

- **Someone can't sign in** ("not a member…"): they used the wrong Discord account, or their org
  is not on the ALLIED ORGANIZATIONS list, or they are not actually in that server. Add the org /
  have them join their org's Discord / sign in with the right account. Nothing to approve.
- **Someone is on the board but a joint net says RESTRICTED**: the net is not marked JOINT, or its
  nest is not. Fix the dropdown; they re-TUNE — no relaunch needed.
- **Someone must go**: roster ▸ REVOKE. Off the relay at once; REINSTATE brings them back as ALLIED.
- **Voice sounds stretched or doubled for one person**: that is their headset changing format
  (Bluetooth is the classic). The app re-opens its own audio within a few seconds and says so under
  SETTINGS ▸ SYSTEM LOG; if it keeps happening, restart the app.
- **"The relay is rate-limiting connections"**: several people behind one router or VPN signed in
  at once. It clears in five minutes on its own; the relay is configured to tolerate this for the
  op (see the droplet checklist), so it should not happen — if it does, wait, don't mash CONNECT.
- **Nobody can connect at all**: the relay cap. Each tuned net is one connection per operator;
  the droplet checklist raises the cap before the op. If it was missed, fewer nets per person.

## After the op

- Remove the allied organisations (ADD/REMOVE on the same block) and revoke or leave the ALLIED
  accounts — they cost nothing and can be reused for the next joint op.
- Set the joint nets back to OPEN or delete them.

## Droplet checklist (Andy, before leaving — the only part that is not in the app)

In `/etc/mumble-server.ini`, then `systemctl restart mumble-server` when no one is on the relay:

```
users=600                            # every tuned net is a connection; 60 operators x 4 nets = 240
autobanSuccessfulConnections=false   # a house or VPN sharing one address must not ban itself
autobanAttempts=30
```

And the accounts service at v1.4.5 (the ALLIED standing lives there), pulled from the tag the
same way as before. Allied orgs can then be added from the app by COMMAND at any time.
