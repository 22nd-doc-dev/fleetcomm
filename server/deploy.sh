#!/usr/bin/env bash
# Secure one-shot deployment from a maintainer workstation.
# Usage: bash server/deploy.sh [ssh-host] [public-address] <letsencrypt-email>
set -euo pipefail
umask 077

SSH_HOST="${1:-68.183.103.215}"
PUBLIC_ADDRESS="${2:-$SSH_HOST}"
LE_EMAIL="${3:-}"
test -n "$LE_EMAIL" || { echo "usage: bash server/deploy.sh [ssh-host] [public-address] <letsencrypt-email>" >&2; exit 1; }
[[ "$SSH_HOST" =~ ^[A-Za-z0-9._:-]+$ ]] || { echo "invalid SSH host" >&2; exit 1; }
[[ "$PUBLIC_ADDRESS" =~ ^[A-Za-z0-9.-]+$ ]] || { echo "invalid public address" >&2; exit 1; }
[[ "$LE_EMAIL" =~ ^[^[:space:]@]+@[^[:space:]@]+$ ]] || { echo "invalid email" >&2; exit 1; }

read -r -s -p "Current Mumble SuperUser password: " SUPW
echo
test -n "$SUPW" || { echo "password is required" >&2; exit 1; }
RELAYPW="$(openssl rand -hex 24)"
BOOTTOK="boot-$(openssl rand -hex 24)"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE"/{server,src,proto,config,deploy-secrets}
for file in server/accounts-service.js server/setup-accounts.sh src/channel-name.js src/mumble-client.js src/varint.js proto/Mumble.proto config/22nd-package.json; do
  cp "$file" "$STAGE/$(dirname "$file")/"
done
printf '%s' "$SUPW" > "$STAGE/deploy-secrets/superuser-password"
printf '%s' "$RELAYPW" > "$STAGE/deploy-secrets/relay-password"
printf '%s' "$BOOTTOK" > "$STAGE/deploy-secrets/bootstrap-token"

echo "Deploying FleetComm securely to ${SSH_HOST} at ${PUBLIC_ADDRESS}…"
printf -v REMOTE_PUBLIC '%q' "${PUBLIC_ADDRESS}"
printf -v REMOTE_EMAIL '%q' "${LE_EMAIL}"
tar -C "$STAGE" -czf - . | ssh -o StrictHostKeyChecking=accept-new "root@${SSH_HOST}" \
  "set -e; rm -rf /tmp/fcdeploy; mkdir -m 700 /tmp/fcdeploy; cd /tmp/fcdeploy; tar xzf -; bash server/setup-accounts.sh ${REMOTE_PUBLIC} ${REMOTE_EMAIL}"
unset SUPW

cat > .fleetcomm-secrets.txt << SECRETS
FleetComm relay secrets — generated $(date)
KEEP THIS FILE PRIVATE. It is gitignored.

Relay password:
  ${RELAYPW}

Initial COMMAND setup code (usable only while no COMMAND account exists):
  ${BOOTTOK}

COMMAND relay tokens are unique per account and are never written to this file.

Droplet: ${SSH_HOST}
Accounts service: https://${PUBLIC_ADDRESS}
Mumble relay: ${PUBLIC_ADDRESS}:64738
SECRETS
chmod 0600 .fleetcomm-secrets.txt
echo "Deployment complete. Secrets saved to .fleetcomm-secrets.txt (mode 600)."
