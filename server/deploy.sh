#!/usr/bin/env bash
# FleetComm — one-shot accounts-service deploy.
# Run from the fleetcomm-app folder on your Mac:
#     bash server/deploy.sh '<current-mumble-SuperUser-password>'
# Generates the relay password + command token for you, ships everything over a
# single SSH connection (one password prompt), and prints the result.
set -uo pipefail   # NOTE: deliberately not -e; we report failures ourselves

if [ $# -lt 1 ]; then
  echo "usage: bash server/deploy.sh '<mumble-SuperUser-password>' [host]" >&2
  exit 1
fi
SUPW="$1"
HOST="${2:-68.183.103.215}"

# openssl ships on macOS and Linux; avoids the tr|head SIGPIPE trap
RELAYPW="$(openssl rand -hex 16)"
ADMTOK="cmd-$(openssl rand -hex 10)"
if [ -z "$RELAYPW" ] || [ -z "$ADMTOK" ]; then
  echo "FAILED: could not generate secrets (openssl missing?)" >&2; exit 1
fi

echo "── FleetComm accounts deploy → $HOST"
echo "   generated relay password + command token (saved locally when done)"
echo "   you will be asked for the DROPLET ROOT PASSWORD once."
echo

for f in server/accounts-service.js server/setup-accounts.sh src/mumble-client.js src/varint.js proto/Mumble.proto; do
  [ -f "$f" ] || { echo "FAILED: missing $f — run this from the fleetcomm-app folder" >&2; exit 1; }
done
echo "── uploading and installing (this is the password prompt)…"

tar czf - server/accounts-service.js server/setup-accounts.sh src/mumble-client.js src/varint.js proto/Mumble.proto |
ssh -o StrictHostKeyChecking=accept-new "root@$HOST" \
  "set -e
   rm -rf /tmp/fcdeploy && mkdir -p /tmp/fcdeploy && cd /tmp/fcdeploy
   tar xzf -
   mv server/accounts-service.js server/setup-accounts.sh src/mumble-client.js src/varint.js proto/Mumble.proto . 2>/dev/null || true
   bash setup-accounts.sh '$SUPW' '$RELAYPW' '$ADMTOK'"
RC=$?
if [ $RC -ne 0 ]; then
  echo
  echo "══ DEPLOY FAILED (exit $RC) — nothing was saved. Common causes:" >&2
  echo "   · wrong droplet root password" >&2
  echo "   · wrong mumble SuperUser password (arg 1)" >&2
  echo "   · droplet unreachable" >&2
  exit $RC
fi

cat > .fleetcomm-secrets.txt << SEC
FleetComm relay secrets — generated $(date)
KEEP THIS FILE PRIVATE. It is gitignored.

Relay password (handed out only by the accounts service, never typed by humans):
  $RELAYPW

Command token (COMMAND accounts receive this automatically on sign-in):
  $ADMTOK

Droplet: $HOST   ·   accounts service: http://$HOST:8722
SEC
grep -q fleetcomm-secrets .gitignore 2>/dev/null || echo ".fleetcomm-secrets.txt" >> .gitignore

echo
echo "══════════════════════════════════════════════════════════════"
echo " DONE. Secrets saved to .fleetcomm-secrets.txt (gitignored)."
echo
echo " NEXT: launch FleetComm and SIGN IN WITH DISCORD *first*."
echo " The first account registered becomes COMMAND — that must be you."
echo "══════════════════════════════════════════════════════════════"
