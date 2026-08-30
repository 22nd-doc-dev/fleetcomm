#!/usr/bin/env bash
# Turn on the fleet Discord gate — nothing else.
#
#   bash server/set-guild.sh <discord-guild-id> [host]
#
# This is DELIBERATELY not deploy.sh. deploy.sh generates a new relay password,
# rewrites the accounts service configuration, reconfigures nginx and restarts
# Mumble — none of which you want when the only change is one setting and one
# file. This ships the updated service, records the guild id, and restarts the
# accounts service. Your relay password, tokens and account database are left
# exactly as they are.
#
# To find the guild id: Discord → Settings → Advanced → Developer Mode on, then
# right-click the 22nd's server icon → Copy Server ID.
# To turn the gate back OFF, run with the word: off

set -u
GUILD="${1:?usage: bash server/set-guild.sh <discord-guild-id|off> [host]}"
SSH_HOST="${2:-68.183.103.215}"
ENVFILE=/etc/fleetcomm-accounts.env
REMOTE=/opt/fleetcomm-accounts

if [ "$GUILD" = "off" ]; then
  GUILD=""
  echo "── turning the Discord gate OFF (any signed-in account may connect)"
elif ! printf '%s' "$GUILD" | grep -qE '^[0-9]{5,25}$'; then
  echo "That doesn't look like a Discord guild id (expected 5-25 digits)." >&2
  echo "Enable Developer Mode in Discord, right-click the server icon, Copy Server ID." >&2
  exit 1
else
  echo "── enabling the Discord gate for guild $GUILD"
fi

echo "── you will be asked for the droplet root password once."
tar czf - server/accounts-service.js | ssh -o StrictHostKeyChecking=accept-new "root@${SSH_HOST}" "
  set -e
  cd '$REMOTE'
  cp server/accounts-service.js server/accounts-service.js.bak 2>/dev/null || true
  tar xzf -
  mv -f server/accounts-service.js accounts-service.js 2>/dev/null || true
  # record the guild id without disturbing any other setting
  touch '$ENVFILE'
  sed -i '/^DISCORD_GUILD_ID=/d' '$ENVFILE'
  if [ -n '$GUILD' ]; then echo 'DISCORD_GUILD_ID=$GUILD' >> '$ENVFILE'; fi
  systemctl restart fleetcomm-accounts
  sleep 2
  systemctl is-active --quiet fleetcomm-accounts && echo '   service is running' || {
    echo '   SERVICE FAILED TO START — rolling back' >&2
    cp accounts-service.js.bak accounts-service.js 2>/dev/null || true
    systemctl restart fleetcomm-accounts
    exit 1
  }
"
rc=$?
if [ $rc -ne 0 ]; then
  echo "FAILED (exit $rc). Nothing was rotated; the service was rolled back if it failed to start." >&2
  exit $rc
fi

echo "── checking health"
curl -fsS --max-time 10 "http://${SSH_HOST}:8722/api/health" && echo || echo "   health check did not answer — check: systemctl status fleetcomm-accounts"
echo
echo "Done. Sign out and back in to test."
echo "If members get locked out unexpectedly: bash server/set-guild.sh off"
