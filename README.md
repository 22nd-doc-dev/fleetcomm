# FleetComm — 22nd Expeditionary Fleet voice comms (QLink successor)

Multi-net radio for Star Citizen ops: unlimited radio slots, per-net push-to-talk /
volume / pan, frequency tuning, callsigns, radio chirp — on a self-hosted backbone
the fleet owns. No single point of failure: the transport is the battle-tested
Mumble protocol (this repo contains **no Mumble code**, it speaks the wire protocol
directly); the server is a stock `mumble-server` package any fleet member can restand
in 10 minutes from `server/setup.sh`.

## Architecture (30 seconds)

- **Server**: stock `mumble-server` on any $5 VPS. Each net = one channel. `server/setup.sh` bootstraps it; `npm run seed` builds the 22nd channel tree from `config/22nd-package.json`.
- **Client** (this app): Electron. For every net you tune, the app opens one lightweight connection ("one receiver per net", like a real rack) — that gives perfect per-net attribution, volume, pan, and later per-net access control. Voice is Opus over the TCP tunnel (v0.2 moves to UDP with OCB2 crypto for lower latency).
- **Global PTT**: `uiohook-napi` keyboard/mouse hooks — works while Star Citizen is focused. In-window keys work even without it.

## Installing (fleet members)

**Windows** — download `FleetComm-<version>.exe` from the
[releases page](https://github.com/22nd-doc-dev/fleetcomm/releases), run it.
SmartScreen will say "Windows protected your PC" because the exe is unsigned:
click **More info → Run anyway**. That's expected until the project buys a
code-signing certificate.

**Mac** — download the zip, unzip it, then run this one command in Terminal
before the first open (macOS quarantines unsigned downloads and misleadingly
calls them "damaged"):

    xattr -cr ~/Downloads/FleetComm.app

Adjust the path if you unzipped elsewhere, then open the app normally.
(A $99/yr Apple Developer signature makes this step disappear — planned once
the fleet's Mac population justifies it.)

## Run it (dev)

1. Install Node 20+ (`brew install node` / nodejs.org).
2. `npm install`
3. `npm start`
4. Enter the fleet server address + your callsign → Connect.

macOS: grant Accessibility permission (System Settings → Privacy & Security →
Accessibility) so global PTT works while the game has focus. First TALK press asks
for microphone permission.

## Stand up the fleet server (once)

1. Rent a small Ubuntu VPS (Hetzner CX22-class, ~$5/mo). Point a DNS name at it if you like (e.g. `comms.22nd.space`).
2. `scp server/setup.sh root@<box>:` then `ssh root@<box> "bash setup.sh '<pick-a-SuperUser-password>'"`
3. From your machine: `npm run seed -- <box-address> '<SuperUser-password>'`
4. Put the address in `config/22nd-package.json` → `server.host`. Done — fleet members just `npm start` and connect.

Fallback for anyone without the app: the official Mumble client connects to the same
server and sits in single channels — instant insurance if QLink dies mid-op.

## Tests

`npm test` runs against a local server (`apt install mumble-server`, see
`test/integration.js`): proves auth, channel seeding, multi-net listen, voice
targets, per-net attribution, and Opus round-trip.

## Releasing a new version (maintainers)

1. Bump the version in `package.json` AND `version.json` (keep them equal).
2. Commit, then tag and push:  `git tag v0.4.0 && git push && git push --tags`
3. GitHub Actions builds the Windows installer + portable exe and the Mac zip,
   and attaches them to the release automatically (~10 min).
4. Every running FleetComm shows the update banner at next launch (it reads
   `version.json` from the repo's main branch).

## Roadmap

- **v0.2**: UDP voice (lower latency), Discord OAuth + org-package auto-load,
  Discord double-speak auto-config, fast callsign switch without reconnect,
  packaged installers via GitHub Actions (no Node needed).
- **v0.3**: per-net access (channel passwords/tokens = "encryption keys"),
  ATC board (right-click reassign), in-game overlay, Tauri port (10MB installer).

## Repo map

    main.js                  Electron main — window, global PTT, radio stack owner
    renderer/                UI (rack, connect, settings) + audio pipeline
    src/mumble-client.js     Mumble wire protocol (control + tunneled voice)
    src/radio-stack.js       one-receiver-per-net rack model
    scripts/seed-channels.js builds the org channel tree (idempotent)
    server/setup.sh          VPS bootstrap
    config/22nd-package.json org comms package: nets, freqs, keys, server
