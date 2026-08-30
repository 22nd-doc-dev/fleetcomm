# FleetComm

FleetComm is the 22nd Expeditionary Fleet's multi-net voice radio for Star Citizen operations. It
speaks the Mumble protocol directly and presents the result as a radio rack: tune several nets,
monitor them simultaneously, key one or many with global push-to-talk, broadcast through a nested
ship net, and keep the active radios visible in an always-on-top overlay.

## Security and reliability model

- A stock self-hosted Mumble server carries voice and enforces channel permissions.
- Discord OAuth uses PKCE and a loopback callback. No Discord client secret ships in the app.
- New accounts remain pending until COMMAND approves them.
- Every approved account receives a unique Mumble token. Promotion, demotion, and revocation rewrite
  the relay ACLs, so an old shared COMMAND token cannot retain authority.
- The public accounts endpoint is HTTPS-only. Its Node service binds to loopback behind nginx, keeps
  bearer sessions in private files, and expires them after 12 hours.
- Electron renderers have no direct Node access. Narrow preload bridges, a content security policy,
  navigation restrictions, input validation, and HTTPS-only external links contain UI compromise.
- The Windows portable updater uses a hidden Node helper—not CMD. It validates the downloaded PE,
  makes one bounded swap attempt, preserves a rollback copy, records the result atomically, and
  relaunches exactly once. A failed version is never retried automatically.

## Install

Windows users download `FleetComm-<version>.exe` from the
[GitHub releases page](https://github.com/22nd-doc-dev/fleetcomm/releases). It is a portable build;
there is no installer.

macOS users download the release zip and open `FleetComm.app`. Unsigned development builds may need
their quarantine attribute removed before the first launch:

```sh
xattr -cr /path/to/FleetComm.app
```

Code signing is still required to remove the operating-system warnings on both platforms.

## Develop

FleetComm requires Node.js 20 or newer.

```sh
npm ci
npm start
```

On macOS, grant Accessibility permission to FleetComm (or the development terminal) for global PTT.
Microphone permission is requested only when audio capture is first needed.

Useful checks:

```sh
npm run verify       # lint plus all headless unit/security regressions
npm run test:relay   # real protocol tests; requires Mumble on 127.0.0.1:64738
npm test             # both groups
```

On Ubuntu, `bash test/run-relay-tests.sh` starts an isolated disposable relay and runs the live
suite. GitHub CI runs both the headless and live-relay gates.

## Secure server deployment

The deployment scripts target Ubuntu 22.04/24.04. Before deploying:

1. Point the public DNS name (for example `comms.22nd.space`) at the server.
2. Bootstrap Mumble once with `sudo bash server/setup.sh`.
3. Seed the org tree from a trusted workstation:

   ```sh
   npm run seed -- <server-address> '<Mumble SuperUser password>'
   ```

4. Deploy the loopback accounts service, nginx, Let's Encrypt TLS, Mumble TLS, and systemd
   hardening:

   ```sh
   bash server/deploy.sh <ssh-address> <public-dns-name> <certificate-email>
   ```

The deploy command prompts privately for the existing Mumble SuperUser password, generates the
relay password and one-time COMMAND bootstrap code, transfers secrets as protected files, and saves
the operator copy in the gitignored `.fleetcomm-secrets.txt` with mode 0600. Port 8722 is never
opened publicly.

Do not merge a configured public hostname until its DNS record points to the relay: strict TLS is
intentional, and the desktop client will not fall back to an IP with certificate verification
disabled.

## Release

Keep `package.json` and `version.json` on the same version. Tag the verified commit with
`v<version>`; the release workflow reruns every test, then builds the Windows portable executable
and macOS zip. The update artifact must remain named `FleetComm-<version>.exe`.

## Repository map

- `main.js` — Electron lifecycle, IPC, updater, OAuth, global PTT, and RadioStack ownership
- `renderer/` — radio UI, isolated preload bridges, audio pipeline, and overlay
- `src/mumble-client.js` — Mumble control and tunneled Opus protocol
- `src/radio-stack.js` — one receiver connection per tuned net
- `src/update-helper.js`, `src/update-guard.js` — bounded updater and anti-loop invariant
- `server/accounts-service.js` — Discord accounts, sessions, per-account tokens, and relay ACLs
- `server/deploy.sh`, `server/setup-accounts.sh` — secure production deployment
- `config/22nd-package.json` — org tree, frequencies, public services, and update feed
- `test/` — pure regressions plus real-relay protocol and permission suites
