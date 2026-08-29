#!/usr/bin/env bash
# FleetComm Accounts Service deploy — run as root ON the droplet, from a folder
# containing: accounts-service.js, mumble-client.js, varint.js, Mumble.proto
#   bash setup-accounts.sh '<mumble-SuperUser-pw>' '<relay-password-to-set>' '<admin-token>'
set -euo pipefail
SUPW="${1:?usage: setup-accounts.sh <SuperUser-pw> <relay-password> <admin-token>}"
RELAYPW="${2:?missing relay password}"
ADMTOK="${3:?missing admin token}"

export DEBIAN_FRONTEND=noninteractive
command -v node >/dev/null || { apt-get update -qq; apt-get install -y -qq nodejs npm; }

mkdir -p /opt/fleetcomm-accounts/proto /opt/fleetcomm-accounts/data
cp accounts-service.js mumble-client.js varint.js /opt/fleetcomm-accounts/
cp Mumble.proto /opt/fleetcomm-accounts/proto/
cd /opt/fleetcomm-accounts
[ -d node_modules/protobufjs ] || { npm init -y >/dev/null; npm install protobufjs >/dev/null; }

# gate the relay itself: only the accounts service hands this password out
if grep -q "^serverpassword=" /etc/mumble-server.ini; then
  sed -i "s|^serverpassword=.*|serverpassword=${RELAYPW}|" /etc/mumble-server.ini
else
  echo "serverpassword=${RELAYPW}" >> /etc/mumble-server.ini
fi
systemctl restart mumble-server

cat > /etc/fleetcomm-accounts.env << ENV
PORT=8722
DATA_DIR=/opt/fleetcomm-accounts/data
SUPW=${SUPW}
MUMBLE_HOST=127.0.0.1
RELAY_PASSWORD=${RELAYPW}
ADMIN_TOKEN=${ADMTOK}
ENV
chmod 600 /etc/fleetcomm-accounts.env

cat > /etc/systemd/system/fleetcomm-accounts.service << UNIT
[Unit]
Description=FleetComm Accounts Service
After=network.target mumble-server.service
[Service]
EnvironmentFile=/etc/fleetcomm-accounts.env
ExecStart=$(command -v node) /opt/fleetcomm-accounts/accounts-service.js
Restart=always
RestartSec=3
User=root
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now fleetcomm-accounts

command -v ufw >/dev/null && ufw status | grep -q "Status: active" && ufw allow 8722/tcp || true
sleep 1
curl -s http://127.0.0.1:8722/api/health && echo
echo "══════════════════════════════════════════════════════"
echo " Accounts service up on :8722."
echo " RELAY IS NOW PASSWORD-GATED — only approved accounts"
echo " (via the service) can connect. First Discord sign-in"
echo " becomes COMMAND automatically: make sure that's you."
echo "══════════════════════════════════════════════════════"
